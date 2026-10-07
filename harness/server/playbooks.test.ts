// 瘦身 P0-3：专章（playbook）按需注入。以前四章（网页 / 桌面 / 安卓验证、本地服务安全）约 6.6k 字符写死在 system 里，连同
// 与工具说明重复的 ## Tools 段，每次请求都带着；实际使用中 57 个会话里只有 1 个跑过 adb、1 个碰过 Electron。这里钉住：system 里只剩
// 一句指路；触发认得准（问答里提到「接口」「页面」不触发）；动手碰到时紧跟在工具结果后面注入一次、不重复；点名的在第一次请求前就到。
import assert from "node:assert/strict";
import test from "node:test";
import { messageKind } from "./agent/injections.ts";
import { PLAYBOOK_KIND, playbooksForCalls, playbooksForRequest } from "./agent/playbooks.ts";
import { systemPrompt } from "./agent/prompt.ts";
import type { Msg, Turn } from "./agent/turn.ts";
import { say, scripted, useTool } from "./test-harness/scripted-adapter.ts";
import { drive, loopState } from "./test-harness/trajectory.ts";
import { ok, type Tool } from "./tools/types.ts";

const ids = (ps: { id: string }[]) => ps.map((p) => p.id).sort();

test("P0-3 system：不再常驻 ## Tools 与四个专章，只留一句指路", () => {
  const prompt = systemPrompt({ root: "C:/ws", shell: "bash", platform: "win32", provider: "local", model: "q", access: "full", webSearch: true });
  for (const gone of ["## Tools", "## Running and verifying a web app", "## Local servers you write", "## Running and verifying a desktop app", "## Running and verifying an Android app"]) {
    assert.ok(!prompt.includes(gone), `${gone} 不再常驻`);
  }
  assert.match(prompt, /## Playbooks\n.*\[Playbook: …\]/);
  assert.match(prompt, /## Deliverable form/, "形态对齐管开工前的规划，留在 system 里");
  assert.ok(prompt.length < 12_000, `核心提示词 ${prompt.length} 字符（瘦身前约 2.3 万）`);
  // Muse：没有浏览器的机器——指路句不提桌面 / 安卓，第 7 条不提 Browser
  const nob = systemPrompt({ root: "/ws", shell: "bash", platform: "linux", provider: "local", model: "q", access: "full", webSearch: true, browser: false });
  assert.match(nob, /## Playbooks\nStep-by-step playbooks — running and verifying a web app, and the safety rules/);
  assert.doesNotMatch(nob, /Browser\(attach\)|Eval\/Network/);
});

test("P0-3 触发：工具调用认得准", () => {
  const w = (path: string, content = "") => ({ name: "Write", args: { path, content } });
  assert.deepEqual(ids(playbooksForCalls([w("site/index.html")])), ["web"]);
  assert.deepEqual(ids(playbooksForCalls([w("server.js", "app.listen(3000)")])), ["local-server"]);
  assert.deepEqual(ids(playbooksForCalls([{ name: "Edit", args: { path: "api.py", old_string: "x", new_string: "app = FastAPI()" } }])), ["local-server"]);
  assert.deepEqual(ids(playbooksForCalls([{ name: "Preview", args: { action: "start", command: "node s.js", port: 3000 } }])), ["local-server", "web"]);
  assert.deepEqual(ids(playbooksForCalls([{ name: "Bash", args: { command: "npx electron . --remote-debugging-port=9223" } }])), ["desktop"]);
  assert.deepEqual(ids(playbooksForCalls([{ name: "Bash", args: { command: "./gradlew assembleDebug" } }])), ["android"]);
  assert.deepEqual(ids(playbooksForCalls([w("app/src/main/AndroidManifest.xml")])), ["android"]);
  assert.deepEqual(ids(playbooksForCalls([{ name: "Browser", args: { action: "navigate", url: "/" } }])), ["web"]);
  // 不该触发的
  assert.deepEqual(ids(playbooksForCalls([{ name: "Browser", args: { action: "navigate", url: "https://docs.python.org/3/" } }])), [], "读外部文档不算在做网页");
  assert.deepEqual(ids(playbooksForCalls([w("notes/summary.md", "# 总结")])), []);
  assert.deepEqual(ids(playbooksForCalls([{ name: "Read", args: { path: "index.html" } }])), [], "只读不算动手");
  assert.deepEqual(ids(playbooksForCalls([{ name: "Bash", args: { command: "git status && npm test" } }])), []);
});

test("P0-3 触发：用户点名只认安卓与桌面应用，问答里的「接口」「页面」不触发", () => {
  assert.deepEqual(ids(playbooksForRequest("帮我做一个安卓记账 app")), ["android"]);
  assert.deepEqual(ids(playbooksForRequest("把它打包成桌面应用，要能双击打开")), ["desktop"]);
  assert.deepEqual(ids(playbooksForRequest("gpt的中转站是怎么实现反代出来api的")), []);
  assert.deepEqual(ids(playbooksForRequest("帮我做一个登录页面html demo")), [], "网页这章等第一个网页文件写下时再给");
  assert.deepEqual(ids(playbooksForRequest("雅思多少分算母语水平")), []);
});

const write: Tool = {
  effect: "write",
  concurrencySafe: false,
  def: { name: "Write", description: "fake write", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("written", "written");
  },
};

// 写了网页文件，收尾前验证门要证据——给一次通过的验证
const bash: Tool = {
  effect: "exec",
  concurrencySafe: false,
  def: { name: "Bash", description: "fake bash", parameters: { type: "object", properties: {} } },
  async run() {
    return { ...ok("test passed", "exit 0"), verification: { passed: true, detail: "npm test (exit 0)" } };
  },
};

// Muse：有没有浏览器看 Browser 工具注册了没有（没浏览器时桌面 / 安卓章不给、网页章给 curl 版）
const browserTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: { name: "Browser", description: "fake browser", parameters: { type: "object", properties: {} } },
  async run() {
    return ok("ok", "ok");
  },
};

const playbookTexts = (msgs: readonly Msg[]): string[] =>
  msgs.filter((m) => messageKind(m) === PLAYBOOK_KIND).map((m) => (m.content[0].t === "text" ? m.content[0].text : ""));
const inRequest = (turn: Turn, header: string): boolean =>
  turn.messages.some((m) => m.content.some((b) => b.t === "text" && b.text.startsWith(header)));

test("P0-3 注入：写下第一个网页文件后紧跟一条网页专章，同一会话不重复", async (t) => {
  const adapter = scripted(t).next(
    useTool("w1", "Write", { path: "index.html", content: "<h1>hi</h1>" }),
    useTool("w2", "Write", { path: "about.html", content: "<h1>about</h1>" }),
    useTool("v1", "Bash", { command: "npm test", verify: true }),
    say("做好了"),
  );
  const { state } = loopState(t, adapter, { tools: [write, bash], user: "做个两页的小站" });
  await drive(state, adapter);
  const texts = playbookTexts(state.messages);
  assert.equal(texts.length, 1, "只注入一次");
  assert.match(texts[0], /^\[Playbook: Running and verifying a web app\] Attached by the harness because your work just touched this area/);
  assert.ok(!inRequest(adapter.inputs[0], "[Playbook:"), "开工时还没有");
  assert.ok(inRequest(adapter.inputs[1], "[Playbook: Running and verifying a web app]"), "第一个网页文件写下后的那次请求就带着");
  const at = state.messages.findIndex((m) => messageKind(m) === PLAYBOOK_KIND);
  assert.ok(state.messages[at - 1].content.some((b) => b.t === "tool_result"), "紧跟在工具结果后面");
});

test("P0-3 注入：用户点名安卓——第一次请求前就到", async (t) => {
  const adapter = scripted(t).next(say("先说下方案"));
  const { state } = loopState(t, adapter, { tools: [browserTool], user: "帮我做一个安卓记账 app" });
  await drive(state, adapter);
  assert.ok(inRequest(adapter.inputs[0], "[Playbook: Running and verifying an Android app] Attached by the harness because your request names this area"));
  assert.equal(playbookTexts(state.messages).length, 1);
});

test("Muse：这台机器没有浏览器——安卓章不给（它的验证路线靠 Browser），网页章给 curl 版", async (t) => {
  const adapter = scripted(t).next(say("先说下方案"));
  const { state } = loopState(t, adapter, { user: "帮我做一个安卓记账 app" });
  await drive(state, adapter);
  assert.equal(playbookTexts(state.messages).length, 0);
  const { PLAYBOOKS, playbookMessage } = await import("./agent/playbooks.ts");
  const web = PLAYBOOKS.find((p) => p.id === "web")!;
  assert.match(playbookMessage(web, "work", false), /There is no browser on this machine/);
  assert.doesNotMatch(playbookMessage(web, "work", true), /There is no browser/);
});
