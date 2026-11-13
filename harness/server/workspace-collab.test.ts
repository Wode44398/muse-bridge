// 工作区协同：视图上报与请求-应答（ui-state.ts）、Workspace 工具的 view / draft / preview、Terminal 工具的闸门与读屏、
// 偏好项生效、system 里的那一小节。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext } from "./tools/types.ts";
import { answerUiRequest, getUiState, makeUiRequest, noteUiState, resetUiState } from "./ui-state.ts";
import { workspaceTool } from "./tools/workspace.ts";
import { keySeq, terminalTool } from "./tools/terminal.ts";
import { renderScreen } from "./term-screen.ts";
import { setPrefs } from "./prefs.ts";
import { screenSection, systemPrompt } from "./agent/prompt.ts";
import { toolDefs } from "./tools/registry.ts";
import { getTermIfAny, killTerm } from "./terminal.ts";

const text = (r: { content: Array<{ t: string; text?: string }> }) => r.content.map((b) => b.text ?? "").join("");

function makeCtx(root: string, extra: Partial<ToolContext> = {}): ToolContext {
  return {
    sandbox: new Sandbox(root),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1_000, bashMaxTimeoutMs: 1_000 },
    agentSeesImages: false,
    ownerId: "chat-1",
    ...extra,
  };
}

test("视图快照：按 clientId 存、最新的在前；超大的状态不收", () => {
  resetUiState();
  noteUiState("a", "web", { chatId: "x" });
  noteUiState("b", "desktop", { chatId: "y" });
  noteUiState("c", "web", { junk: "z".repeat(20_000) });
  const all = getUiState();
  assert.deepEqual(all.map((r) => r.clientId).sort(), ["a", "b", "c"]);
  assert.deepEqual(all.find((r) => r.clientId === "c")!.state, {});
  assert.ok(all.every((r) => r.fresh));
  resetUiState();
});

test("请求-应答：成功的应答当场返回；失败的应答等一小会儿，期间有成功的就用成功的；未知 id 不认", async () => {
  resetUiState();
  const sent: Record<string, unknown>[] = [];
  const p = makeUiRequest((ev) => sent.push(ev), "draft", { client: "me", timeoutMs: 5000 });
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.e, "workspace");
  assert.equal(sent[0]!.op, "draft");
  assert.equal(sent[0]!.client, "me");
  const id = String(sent[0]!.id);
  assert.equal(answerUiRequest(id, { error: "no editor" }), true, "先到的失败应答被收下，但不立刻定");
  assert.equal(answerUiRequest(id, { text: "hello", dirty: true }), true);
  assert.deepEqual(await p, { text: "hello", dirty: true });
  assert.equal(answerUiRequest(id, { text: "late" }), false, "定了之后的应答不认");
  assert.equal(answerUiRequest("nope", {}), false);

  const sent2: Record<string, unknown>[] = [];
  const p2 = makeUiRequest((ev) => sent2.push(ev), "draft", { timeoutMs: 5000 });
  answerUiRequest(String(sent2[0]!.id), { error: "no editor" });
  assert.deepEqual(await p2, { error: "no editor" }, "只有失败的应答：宽限期过后照它定");

  await assert.rejects(makeUiRequest(() => {}, "draft", { timeoutMs: 30 }), /no answer/);
  resetUiState();
});

test("Workspace(view)：拼出前台会话、工作区工具、宿主预览的绝对路径与未保存标记；偏好关掉就不说", async () => {
  resetUiState();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-wscollab-"));
  try {
    const ctx = makeCtx(root);
    assert.match(text(await workspaceTool.run({ action: "view" }, ctx)), /No view report/);
    noteUiState("dev-1", "desktop", {
      chatId: "chat-1",
      ws: root,
      dock: { open: true, tool: "files" },
      host: {
        page: "harness",
        files: { path: "docs", ws: root },
        preview: { open: true, name: "a.md", kind: "md", rel: "docs/a.md", ws: root, detail: { mode: "live", dirty: true } },
      },
    });
    const r = await workspaceTool.run({ action: "view" }, ctx);
    const out = text(r);
    assert.match(out, /Viewing: this conversation/);
    assert.match(out, /tool = files/);
    assert.ok(out.includes(path.join(root, "docs", "a.md")), out);
    assert.match(out, /UNSAVED/);
    assert.equal(r.outcome, "用户正看着 a.md");

    await setPrefs({ "workspace.view": false });
    assert.match(text(await workspaceTool.run({ action: "view" }, ctx)), /turned off/);
  } finally {
    await setPrefs({ "workspace.view": null });
    resetUiState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Workspace(draft)：点名开着编辑器的那一端、拿回全文；没有会话通道或偏好关掉时不取", async () => {
  resetUiState();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-wscollab-"));
  try {
    noteUiState("phone", "apk", { chatId: "chat-1", host: { preview: { open: false } } });
    noteUiState("pc", "desktop", { chatId: "chat-1", host: { preview: { open: true, name: "a.md", rel: "a.md", ws: root, detail: { mode: "source", dirty: true } } } });
    const emitted: Record<string, unknown>[] = [];
    const ctx = makeCtx(root, {
      emit: (ev) => {
        emitted.push(ev as unknown as Record<string, unknown>);
        queueMicrotask(() => answerUiRequest(String((ev as { id?: string }).id), { text: "draft body", rel: "a.md", ws: root, dirty: true, mode: "source" }));
      },
    });
    const r = await workspaceTool.run({ action: "draft" }, ctx);
    assert.equal(r.ok, true);
    assert.equal(emitted[0]!.client, "pc", "点名开着编辑器的那台");
    assert.match(text(r), /UNSAVED/);
    assert.match(text(r), /draft body/);

    assert.equal((await workspaceTool.run({ action: "draft" }, makeCtx(root))).ok, false, "没有会话通道");
    await setPrefs({ "workspace.draft": false });
    const off = await workspaceTool.run({ action: "draft" }, ctx);
    assert.equal(off.ok, false);
    assert.match(text(off), /does not allow/);
  } finally {
    await setPrefs({ "workspace.draft": null });
    resetUiState();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Workspace(preview)：工作空间里的文件发一条 workspace 事件；不存在、越界的不发", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-wscollab-"));
  try {
    fs.mkdirSync(path.join(root, "out"));
    fs.writeFileSync(path.join(root, "out", "report.md"), "# hi\n");
    const ctx = makeCtx(root);
    const r = await workspaceTool.run({ action: "preview", path: "out/report.md" }, ctx);
    assert.equal(r.ok, true);
    const ev = r.events?.[0] as Record<string, unknown>;
    assert.equal(ev.e, "workspace");
    assert.equal(ev.op, "preview");
    assert.equal(ev.path, "out/report.md");
    assert.equal(ev.ws, path.resolve(root));
    assert.equal((await workspaceTool.run({ action: "preview", path: "missing.md" }, ctx)).ok, false);
    assert.equal((await workspaceTool.run({ action: "preview", path: "../x.md" }, ctx)).ok, false);
    assert.equal((await workspaceTool.run({ action: "preview" }, ctx)).ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Terminal：键名翻成控制序列；读屏动作算只读，打字按 Bash 的规则判（共享终端里不降成只读）", () => {
  assert.equal(keySeq("ctrl+c"), "\x03");
  assert.equal(keySeq("enter"), "\r");
  assert.equal(keySeq("up"), "\x1b[A");
  assert.equal(keySeq("alt+x"), "\x1bx");
  assert.equal(keySeq("bogus-key"), null);
  assert.deepEqual(terminalTool.permissionView!({ action: "read" }), { effect: "read" });
  assert.deepEqual(terminalTool.permissionView!({ action: "status" }), { effect: "read" });
  const run = terminalTool.permissionView!({ action: "run", command: "git status" });
  assert.ok(run && run.effect === undefined && Array.isArray(run.subjects), "按 Bash 拆子命令，但不降成只读");
  assert.equal(terminalTool.permissionView!({ action: "keys", keys: "ctrl+c" }), null);
});

test("Terminal：偏好可降到只读 / 关掉；没有命令行的租户没有这个工具", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-wscollab-"));
  try {
    const ctx = makeCtx(root);
    assert.match(text(await terminalTool.run({ action: "read" }, ctx)), /not running/, "用户没开过终端：只说没有，不凭空起壳");
    assert.equal(getTermIfAny(root), null);
    await setPrefs({ "workspace.terminal": "read" });
    const typed = await terminalTool.run({ action: "run", command: "echo hi" }, ctx);
    assert.equal(typed.ok, false);
    assert.match(text(typed), /not type/);
    await setPrefs({ "workspace.terminal": "off" });
    assert.equal((await terminalTool.run({ action: "read" }, ctx)).ok, false);
  } finally {
    await setPrefs({ "workspace.terminal": null });
    fs.rmSync(root, { recursive: true, force: true });
  }
  const saved = { t: process.env.DIMENSIO_TENANT, s: process.env.DIMENSIO_TENANT_SHELL };
  try {
    process.env.DIMENSIO_TENANT = "1";
    process.env.DIMENSIO_TENANT_SHELL = "0";
    assert.equal(terminalTool.enabled!(), false);
    assert.ok(!toolDefs().some((d) => d.name === "Terminal"));
    assert.ok(toolDefs().some((d) => d.name === "Workspace"));
  } finally {
    if (saved.t === undefined) delete process.env.DIMENSIO_TENANT;
    else process.env.DIMENSIO_TENANT = saved.t;
    if (saved.s === undefined) delete process.env.DIMENSIO_TENANT_SHELL;
    else process.env.DIMENSIO_TENANT_SHELL = saved.s;
  }
});

test("读屏：光标改写过的行、清行、备用屏按终端语义结算（内置的最小解释器与 xterm 一致）", async () => {
  const raw = "PS> npm test\r\nloading...\r\x1b[Kdone 3/3\r\n\x1b[?1049hTUI SCREEN\x1b[?1049lPS> ";
  for (const fallbackOnly of [true, false]) {
    const lines = await renderScreen(raw, 80, 10, { fallbackOnly });
    assert.deepEqual(lines, ["PS> npm test", "done 3/3", "PS>"], `fallbackOnly=${fallbackOnly}`);
  }
  const moved = await renderScreen("abc\x1b[2Dz", 40, 5, { fallbackOnly: true });
  assert.deepEqual(moved, ["azc"]);
});

test("Terminal(run)：与面板同一个 PTY，命令输出读得回来", { skip: process.platform !== "win32" && "PowerShell 专用" }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-wscollab-"));
  try {
    const events: Record<string, unknown>[] = [];
    const ctx = makeCtx(root, { emit: (ev) => events.push(ev as unknown as Record<string, unknown>) });
    let r;
    try {
      r = await terminalTool.run({ action: "run", command: "Write-Output wscollab-$((6*7))", waitSec: 20 }, ctx);
    } catch (e) {
      t.skip(`node-pty 不可用：${(e as Error).message}`);
      return;
    }
    if (!r.ok && /Terminal failed/.test(text(r))) {
      t.skip(text(r));
      return;
    }
    assert.match(text(r), /wscollab-42/);
    assert.equal(events[0]?.e, "terminal");
    assert.ok(getTermIfAny(root), "面板接上的是同一个壳");
    const read = await terminalTool.run({ action: "read" }, ctx);
    assert.match(text(read), /wscollab-42/);
  } finally {
    killTerm(root);
    // 壳退出要一小会儿，期间它还占着这个目录（cwd）
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  }
});

test("system 里的工作区一小节：新会话都带；没有命令行的租户不提 Terminal", () => {
  assert.match(screenSection(true), /Workspace\(view\)/);
  assert.match(screenSection(true), /Terminal/);
  assert.doesNotMatch(screenSection(false), /Terminal/);
  const prompt = systemPrompt({ root: "C:/ws", shell: "bash", platform: "win32", provider: "kimi", model: "k3" });
  assert.ok(prompt.includes("## The user's screen"));
  assert.ok(screenSection(true).length < 700, "前缀预算：这一节要短");
});
