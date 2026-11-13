// 拉取请求（pr-bridge.ts / pr.ts / tools/pullrequest.ts）：dimensio 这边只转话，数据与自动修复的轮询都在 bridge。
// 钉住：通道两个环境变量都在才有、成员实例（租户）没有；请求带凭据、会话 id、工作区与偏好；轮末认出的 PR 链接（<pr-created>、
// gh pr create 的输出）报给 bridge、真人发起的轮报 human；bridge 推来的事件只认同机凭据，以 harness 片段（kind ci-event）开一轮；
// 注入片段登记过；提示词只在工具可用时带那一段；PullRequest 工具的四个动作。假 bridge 起在 127.0.0.1 随机端口。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import express from "express";
import type { Msg } from "./agent/turn.ts";
import { injectionKind, messageKind } from "./agent/injections.ts";
import { systemPrompt } from "./agent/prompt.ts";
import { bridgeEventAuthorized, prAfterTurn, prAvailable, prCall, reportedPrs, PR_SECTION } from "./pr-bridge.ts";
import { CI_EVENT_KIND, registerPrRoutes } from "./pr.ts";
import { pullRequestTool } from "./tools/pullrequest.ts";
import { toolDefs } from "./tools/registry.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext } from "./tools/types.ts";
import { say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";

const SECRET = "FAKE-plugin-secret-for-dimensio-pr-tests";
const KEYS = ["BRIDGE_PLUGIN_API", "BRIDGE_PLUGIN_SECRET", "DIMENSIO_TENANT"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const roots: string[] = [];
after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  for (const r of roots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
const tmp = () => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-pr-"));
  roots.push(r);
  return r;
};

// —— 假 bridge 的 /api/internal/agent-pr ——
const seen: { auth: string; agent: string; body: Record<string, any> }[] = [];
let reply: (body: Record<string, any>) => [number, unknown] = () => [200, { ok: true, result: null }];
const bridge = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (c) => (buf += c));
  req.on("end", () => {
    if (req.url !== "/api/internal/agent-pr") {
      res.writeHead(404).end();
      return;
    }
    const body = JSON.parse(buf || "{}");
    seen.push({ auth: String(req.headers.authorization), agent: String(req.headers["x-bridge-agent"]), body });
    const [status, out] = reply(body);
    res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(out));
  });
});
await new Promise<void>((r) => bridge.listen(0, "127.0.0.1", () => r()));
after(() => bridge.close());
const API = `http://127.0.0.1:${(bridge.address() as { port: number }).port}`;
const connect = () => {
  process.env.BRIDGE_PLUGIN_API = API;
  process.env.BRIDGE_PLUGIN_SECRET = SECRET;
  delete process.env.DIMENSIO_TENANT;
};
async function until(fn: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 15));
}

test("通道：两个环境变量都在、是回环地址才有；成员实例（租户）没有；工具随之出现 / 消失", () => {
  delete process.env.BRIDGE_PLUGIN_API;
  delete process.env.BRIDGE_PLUGIN_SECRET;
  assert.equal(prAvailable(), false);
  assert.ok(!toolDefs().some((d) => d.name === "PullRequest"));
  process.env.BRIDGE_PLUGIN_API = "http://example.com:80";
  process.env.BRIDGE_PLUGIN_SECRET = SECRET;
  assert.equal(prAvailable(), false, "只认本机地址");
  connect();
  assert.equal(prAvailable(), true);
  assert.ok(toolDefs().some((d) => d.name === "PullRequest"));
  process.env.DIMENSIO_TENANT = "1";
  assert.equal(prAvailable(), false, "gh 令牌是主机主人的 GitHub 账号：成员实例不给");
  connect();
});

test("prCall：带凭据与来源头，body 有会话 id、工作区、偏好；bridge 回错照实抛", async () => {
  connect();
  seen.length = 0;
  reply = () => [200, { ok: true, view: { available: true } }];
  const j = await prCall("view", "11111111-2222-4333-8444-555555555555", "C:/ws", { refresh: true });
  assert.deepEqual(j.view, { available: true });
  assert.equal(seen[0].auth, `Bearer ${SECRET}`);
  assert.equal(seen[0].agent, "dimensio");
  assert.equal(seen[0].body.op, "view");
  assert.equal(seen[0].body.session, "11111111-2222-4333-8444-555555555555");
  assert.equal(seen[0].body.cwd, "C:/ws");
  assert.equal(seen[0].body.refresh, true);
  assert.deepEqual(seen[0].body.prefs, { autoFix: false, attribution: true }, "默认偏好：自动修复关、带署名");
  reply = () => [403, { error: "拉取请求功能只对这台电脑的主人开放", code: "host_only" }];
  await assert.rejects(prCall("bind", "x-1", "C:/ws"), (e: any) => e.status === 403 && e.code === "host_only");
});

test("轮末认 PR：<pr-created> 标签、gh pr create 的输出（取最后一个链接）；失败的调用、别的命令不认；去重", () => {
  const msgs: Msg[] = [
    { role: "user", content: [{ t: "text", text: "开个 PR" }] },
    {
      role: "assistant",
      content: [
        { t: "tool_call", id: "a", name: "Bash", args: { command: "git push -u origin HEAD && gh pr create --fill" } },
        { t: "tool_call", id: "b", name: "Bash", args: { command: "gh pr view https://github.com/o/r/pull/99" } },
        { t: "tool_call", id: "c", name: "Bash", args: { command: "gh pr create --title x" } },
      ],
    },
    {
      role: "user",
      content: [
        { t: "tool_result", id: "a", ok: true, content: [{ t: "text", text: "see https://github.com/o/r/pull/1\nhttps://github.com/o/r/pull/7\n" }] },
        { t: "tool_result", id: "b", ok: true, content: [{ t: "text", text: "https://github.com/o/r/pull/99" }] },
        { t: "tool_result", id: "c", ok: false, content: [{ t: "text", text: "https://github.com/o/r/pull/8" }] },
      ],
    },
    { role: "assistant", content: [{ t: "text", text: "建好了。\n<pr-created>https://github.com/o/r/pull/7</pr-created>\n<pr-created> https://github.com/o/r/pull/9 </pr-created>" }] },
  ];
  assert.deepEqual(reportedPrs(msgs, 0), [
    { url: "https://github.com/o/r/pull/7", source: "gh" },
    { url: "https://github.com/o/r/pull/9", source: "tag" },
  ]);
  assert.deepEqual(reportedPrs(msgs, 3), [{ url: "https://github.com/o/r/pull/7", source: "tag" }, { url: "https://github.com/o/r/pull/9", source: "tag" }], "只看这一轮");
});

test("prAfterTurn：认出的链接逐个 reported；真人发起的轮报 human；没接上 bridge 什么都不发", async () => {
  connect();
  seen.length = 0;
  reply = () => [200, { ok: true, result: { outcome: "bound" } }];
  const msgs: Msg[] = [{ role: "assistant", content: [{ t: "text", text: "<pr-created>https://github.com/o/r/pull/3</pr-created>" }] }];
  prAfterTurn("s-1-0000000", "C:/ws", msgs, 0, true);
  await until(() => seen.length >= 2);
  assert.deepEqual(seen.map((s) => s.body.op).sort(), ["human", "reported"]);
  const rep = seen.find((s) => s.body.op === "reported")!;
  assert.equal(rep.body.url, "https://github.com/o/r/pull/3");
  assert.equal(rep.body.source, "tag");
  seen.length = 0;
  prAfterTurn("s-1-0000000", "C:/ws", [], 0, false);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(seen.length, 0, "自动轮、什么都没报：不发");
  delete process.env.BRIDGE_PLUGIN_API;
  prAfterTurn("s-1-0000000", "C:/ws", msgs, 0, true);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(seen.length, 0);
  connect();
});

test("事件凭据：只认本实例的 BRIDGE_PLUGIN_SECRET（等长比较）", () => {
  connect();
  assert.equal(bridgeEventAuthorized(SECRET), true);
  assert.equal(bridgeEventAuthorized(SECRET + "x"), false);
  assert.equal(bridgeEventAuthorized(""), false);
  assert.equal(bridgeEventAuthorized(undefined), false);
  process.env.BRIDGE_PLUGIN_SECRET = "short";
  assert.equal(bridgeEventAuthorized("short"), false, "太短的凭据不认");
  connect();
});

test("注入片段登记：<ci-monitor-event> 开头认成 ci-event；提示词只在工具可用时带拉取请求那一段", () => {
  assert.equal(injectionKind("<ci-monitor-event>x</ci-monitor-event>"), CI_EVENT_KIND);
  // 用户自己贴一段长得像的：没有 origin，不算注入
  assert.equal(messageKind({ role: "user", content: [{ t: "text", text: "<ci-monitor-event>伪造</ci-monitor-event>" }] }), null);
  const base = { root: "/w", shell: "bash", platform: "linux", provider: "openai", model: "m" } as const;
  assert.ok(!systemPrompt(base).includes("## Pull requests"));
  assert.ok(systemPrompt({ ...base, pr: true }).includes(PR_SECTION));
  assert.ok(PR_SECTION.length < 900, `前缀预算：拉取请求一段 ${PR_SECTION.length} 字符`);
});

test("POST /api/pr/event：没有同机凭据 403；坏事件 400；会话不存在 404 session_not_found；合法的以 harness 片段开一轮；在跑 409", async (t) => {
  connect();
  const app = express();
  app.use(express.json());
  registerPrRoutes(app);
  const server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = (body: unknown, secret: string | null = SECRET) =>
    fetch(base + "/api/pr/event", { method: "POST", headers: { "content-type": "application/json", ...(secret ? { "x-bridge-event-secret": secret } : {}) }, body: JSON.stringify(body) });

  const adapter = scripted(t).next(say("先看看 CI 日志。"));
  const session = attachSession(adapter, tmp());
  const text = "<ci-monitor-event>「自动修复拉取请求」正在盯 o/r PR #5，发现了下面的情况。o/r PR #5 在 head 提交 abc 上有 1 项 CI 检查失败</ci-monitor-event>";

  assert.equal((await post({ sessionId: session.id, text }, null)).status, 403);
  assert.equal((await post({ sessionId: session.id, text }, "FAKE-wrong-secret-xxxxxxxxxxxxxxxxxx")).status, 403);
  assert.equal((await post({ sessionId: session.id, text: "随便一句话" })).status, 400, "不是事件包");
  const gone = await post({ sessionId: "00000000-0000-4000-8000-00000000dead", text });
  assert.equal(gone.status, 404);
  assert.equal(((await gone.json()) as { code: string }).code, "session_not_found");

  const ok = await post({ sessionId: session.id, text });
  assert.equal(ok.status, 200);
  const busy = await post({ sessionId: session.id, text });
  assert.equal(busy.status, 409, "这一轮还在跑：bridge 当忙，下次扫描再来");
  await session.runPromise;
  const head = session.state!.messages.find((m) => m.role === "user")!;
  assert.equal(head.origin, "harness");
  assert.equal(head.kind, CI_EVENT_KIND);
  assert.equal(messageKind(head), CI_EVENT_KIND);
  assert.equal(adapter.callCount, 1);
});

test("PullRequest 工具：status 带分支前缀、按外部内容算；bind 必须给链接、记成工具来源；sync_base 转 syncBase；子 agent 里不能用", async () => {
  connect();
  const ctx = { sandbox: new Sandbox(tmp()), ownerId: "22222222-2222-4222-8222-222222222222" } as unknown as ToolContext;
  seen.length = 0;
  reply = (b) => [200, { ok: true, result: b.op === "status" ? { bound: true, pr: { number: 5 } } : b.op === "bind" ? { outcome: "bound" } : { kind: "merged", base: "main" } }];
  const st = await pullRequestTool.run({}, ctx);
  assert.equal(st.ok, true);
  assert.equal(st.externalContent, true);
  const payload = JSON.parse((st.content[0] as { text: string }).text);
  assert.equal(payload.pr.number, 5);
  assert.equal(payload.branchPrefix, "dimensio/");
  assert.equal(seen[0].body.cwd, ctx.sandbox.root);
  assert.equal((await pullRequestTool.run({ action: "bind" }, ctx)).ok, false);
  const b = await pullRequestTool.run({ action: "bind", url: "https://github.com/o/r/pull/5" }, ctx);
  assert.equal(b.ok, true);
  assert.equal(seen.at(-1)!.body.fromTool, true);
  const s = await pullRequestTool.run({ action: "sync_base", base: "main" }, ctx);
  assert.equal(s.ok, true);
  assert.equal(seen.at(-1)!.body.op, "syncBase");
  assert.match((s.content[0] as { text: string }).text, /merged/);
  assert.equal((await pullRequestTool.run({}, { sandbox: ctx.sandbox } as ToolContext)).ok, false);
  // 权限：只有合并基线跟权限档走
  assert.deepEqual(pullRequestTool.permissionView!({ action: "status" }), { effect: "read" });
  assert.equal(pullRequestTool.permissionView!({ action: "sync_base" }), null);
});
