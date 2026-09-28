// M15（Codex X35）：headless 客户端——走 /api/run，读 SSE 到收场，卡片按无人值守落定。
//
// 修前：只有评测台自己写了一份 SSE 解析；别的没人盯着的调用方（Routines、QQ bot）要用 dimensio 就得各抄一份，卡片来了
// 没人管，一轮挂到卡片超时（权限 10 分钟、计划 60 分钟）。
// 修后：server/headless-client.ts 一份（评测台、命令行客户端都用它的 sseEvents）。
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { HEADLESS_ANSWER, HEADLESS_BY, HEADLESS_NOTE, HEADLESS_PLAN_NOTE, runHeadless, sseEvents } from "./headless-client.ts";

async function* chunks(parts: string[]): AsyncGenerator<Uint8Array> {
  for (const p of parts) yield new TextEncoder().encode(p);
}

test("M15 SSE 解析：跨块拼帧、多行 data、非 JSON 跳过、结尾没空行的最后一帧也冲出来", async () => {
  const got: unknown[] = [];
  for await (const ev of sseEvents(chunks(['data: {"e":"a",', '"n":1}\n\n: ping\n\ndata: not json\n\n', 'data: {"e":"b"}\r\n\r\ndata: {"e":"c"}']))) got.push(ev);
  assert.deepEqual(got, [{ e: "a", n: 1 }, { e: "b" }, { e: "c" }]);
});

// 假的 /api/run：先报 session，吐一段字，然后依次抛权限卡、提问卡、计划卡——每张都等客户端落定了才往下走
function fakeHarness() {
  const posts: Array<{ path: string; body: any; auth: string | undefined }> = [];
  const waiters = new Map<string, () => void>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      const parsed = body ? JSON.parse(body) : {};
      posts.push({ path: req.url ?? "", body: parsed, auth: req.headers["x-dimensio-internal-token"] as string | undefined });
      if (req.url === "/api/run") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const send = (ev: object) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
        const settled = (id: string) => new Promise<void>((r) => waiters.set(id, r));
        send({ e: "session", sessionId: "s-1", runId: "r-1" });
        send({ e: "turn_start", index: 0 });
        send({ e: "text_delta", text: "先查一下" });
        send({ e: "permission_ask", id: "perm-1", tool: "Bash", subject: "rm -rf build", sessionRules: [] });
        await settled("perm-1");
        send({ e: "ask", id: "ask-1", questions: [{ header: "目标", question: "要哪个？", options: [] }, { header: "b", question: "?", options: [] }] });
        await settled("ask-1");
        send({ e: "plan_ask", id: "plan-1", plan: "# 计划" });
        await settled("plan-1");
        send({ e: "turn_start", index: 1 });
        send({ e: "text_delta", text: "做完了：" });
        send({ e: "text_delta", text: "结果在 out.md" });
        send({ e: "done", stopReason: "end" });
        res.end();
        return;
      }
      const id = String(parsed.id ?? parsed.askId ?? "");
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      waiters.get(id)?.();
    });
  });
  return { server, posts };
}

test("M15 runHeadless：卡片按无人值守当场落定（权限拒 + 说明、提问回「没人在场」、计划不批请它交回计划），拿到最后一轮正文", async (t) => {
  const { server, posts } = fakeHarness();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const events: string[] = [];
  const r = await runHeadless({
    baseUrl,
    headers: { "x-dimensio-internal-token": "FAKE-token" },
    message: "整理一下报告",
    config: { workspace: "D:/proj" },
    onEvent: (ev) => events.push(String(ev.e)),
  });
  assert.equal(r.outcome, "done");
  assert.equal(r.sessionId, "s-1");
  assert.equal(r.runId, "r-1");
  assert.equal(r.text, "做完了：结果在 out.md", "只要最后一轮的正文");
  assert.equal(r.counts.permission_ask, 1);
  assert.ok(events.includes("done"));

  const run = posts.find((p) => p.path === "/api/run")!;
  assert.deepEqual(run.body, { message: "整理一下报告", config: { workspace: "D:/proj" } });
  assert.equal(run.auth, "FAKE-token");
  // P10（D9）：落定时自报「设备」，别的设备上看到的是「在无头调用上拒绝了」
  const perm = posts.find((p) => p.path === "/api/sessions/s-1/permission")!;
  assert.deepEqual(perm.body, { id: "perm-1", decision: "deny", note: HEADLESS_NOTE, by: HEADLESS_BY });
  const ans = posts.find((p) => p.path === "/api/sessions/s-1/answer")!;
  assert.deepEqual(ans.body, {
    askId: "ask-1",
    answers: [{ selected: [HEADLESS_ANSWER], custom: true }, { selected: [HEADLESS_ANSWER], custom: true }],
    by: HEADLESS_BY,
  });
  const plan = posts.find((p) => p.path === "/api/sessions/s-1/plan")!;
  assert.deepEqual(plan.body, { id: "plan-1", approved: false, note: HEADLESS_PLAN_NOTE, by: HEADLESS_BY });
});

test("M15 runHeadless：--allow-once 逐次放行；/api/run 本身被拒时如实报错", async (t) => {
  const { server, posts } = fakeHarness();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const r = await runHeadless({ baseUrl, message: "x", permissions: "once" });
  assert.equal(r.outcome, "done");
  assert.deepEqual(posts.find((p) => p.path === "/api/sessions/s-1/permission")!.body, { id: "perm-1", decision: "once", by: HEADLESS_BY });

  const refusing = http.createServer((_req, res) => {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "retiring" }));
  });
  await new Promise<void>((r) => refusing.listen(0, "127.0.0.1", () => r()));
  t.after(() => refusing.close());
  const bad = await runHeadless({ baseUrl: `http://127.0.0.1:${(refusing.address() as AddressInfo).port}`, message: "x" });
  assert.match(bad.outcome, /^error: HTTP 503/);
});
