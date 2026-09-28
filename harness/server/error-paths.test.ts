// Q14（F6）：稳定错误码 + 关键路径不吞错。
//
// 修前：会话文件在却读不了（被占用、权限、是个目录……）一律当「没有这个会话」——接口回 404，侧栏里悄悄消失；检查点
// 索引坏了悄悄当成空的，下一次拍检查点就把它整个覆盖，这个会话的回滚历史连证据都不剩；恢复会话失败一律 400 带原文，
// 客户端分不清「该重试」「只读」还是「缺 key」。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { INTERNAL_TOKEN_HEADER } from "./api-auth.ts";
import { listCheckpoints, takeCheckpoint } from "./checkpoints.ts";
import { CodedError } from "./errors.ts";
import { getOrLoadSession } from "./session.ts";
import { listSessions, loadSessionResult, saveSession, sessionsDir, type PersistedSession } from "./store.ts";
import { killTree } from "./tools/bash.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const TOKEN = "q14-DUMMY-token";
const cleanups: string[] = [];
// 这个文件往会话目录里放「读不了的会话」——用自己的会话目录，别让并发跑的其他测试文件在列表里看到它。
// 收尾还原成进入时的值（不要 delete：delete 之后一解析就抛错，见 test-setup.ts）。
const BASE_SESSIONS_DIR = process.env.SESSIONS_DIR;
process.env.SESSIONS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-q14-sessions-"));
cleanups.push(process.env.SESSIONS_DIR);
after(() => {
  process.env.SESSIONS_DIR = BASE_SESSIONS_DIR;
  for (const p of cleanups) {
    try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
function record(id: string, workspace: string, provider = "openai"): PersistedSession {
  return {
    v: 1, id, createdAt: 1, updatedAt: Date.now(), title: "t",
    config: { provider, model: "m", thinking: "off", permissionMode: "auto", workspace, access: "workspace" },
    system: "s", messages: [], todos: [], totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] }, counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
  } as PersistedSession;
}
// 会话文件的位置上放一个目录：读它会报 EISDIR——「文件在，但读不了」最稳定的造法
function unreadableSession(id: string): void {
  const p = path.join(sessionsDir(), `${id}.json`);
  fs.mkdirSync(p, { recursive: true });
  cleanups.push(p);
}

test("Q14 读不了的会话如实报：不再冒充「没有」——store 回 unreadable、恢复抛带码的 503、侧栏留一条", async () => {
  const id = "q14-unreadable-session";
  unreadableSession(id);
  const r = await loadSessionResult(id);
  assert.equal(r.kind, "unreadable", "修前是 not-found");
  assert.equal(r.kind === "unreadable" && r.code, "EISDIR");
  await assert.rejects(getOrLoadSession(id), (e: unknown) => e instanceof CodedError && e.code === "session_unreadable" && e.status === 503);
  const listed = (await listSessions()).find((m) => m.id === id);
  assert.ok(listed, "侧栏里留一条，不悄悄消失");
  assert.match(listed!.title, /读不了/);
});

test("Q14 检查点索引坏了：先原样挪开留证，再从空索引起步——不再被下一次拍摄悄悄覆盖", async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-q14-cp-"));
  cleanups.push(ws);
  fs.writeFileSync(path.join(ws, "a.ts"), "export const a = 1;\n");
  const id = "q14-corrupt-index";
  const dir = path.join(sessionsDir(), "checkpoints");
  fs.mkdirSync(dir, { recursive: true });
  const index = path.join(dir, `${id}.index.json`);
  const garbage = '{"v":1,"entries":[{"n":1,"hash":"abc"'; // 写到一半的索引
  fs.writeFileSync(index, garbage);

  assert.deepEqual(await listCheckpoints(id), []);
  const kept = fs.readdirSync(dir).filter((f) => f.startsWith(`${id}.index.json.corrupt-`));
  assert.equal(kept.length, 1, "坏索引被原样挪开（修前原地留着，下一次拍摄就把它覆盖掉）");
  assert.equal(fs.readFileSync(path.join(dir, kept[0]), "utf8"), garbage, "留的是原字节");
  const cp = await takeCheckpoint(record(id, ws), ws, "after the corrupt index");
  assert.ok(cp, "照常拍新的检查点");
  assert.equal((await listCheckpoints(id)).length, 1);
  cleanups.push(...fs.readdirSync(dir).filter((f) => f.startsWith(id)).map((f) => path.join(dir, f)));
});

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("Q14 接口错误带稳定码：没有这个会话 404 session_not_found、读不了 503 session_unreadable、缺 key 400 provider_key_missing", { timeout: 90_000 }, async () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-q14-api-"));
  cleanups.push(ws);
  unreadableSession("q14-api-unreadable");
  await saveSession(record("q14-api-nokey", ws, "anthropic")); // 测试环境没有 Anthropic 的 key
  cleanups.push(path.join(sessionsDir(), "q14-api-nokey.json"));

  const port = await freePort();
  const child = spawn(process.execPath, ["server/index.ts"], {
    cwd: path.join(here, ".."),
    env: { ...process.env, PORT: String(port), DIMENSIO_HOST: "127.0.0.1", DIMENSIO_INTERNAL_TOKEN: "", DIMENSIO_DEV_TOKEN: TOKEN, DIMENSIO_OUTBOUND_PROXY: "off", WORKSPACE_DIR: ws, BRIDGE_PORT: "" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const headers = { [INTERNAL_TOKEN_HEADER]: TOKEN, "content-type": "application/json" };
  const call = async (method: string, p: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, body: (await r.json()) as { error?: string; code?: string } };
  };
  try {
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const r = await fetch(`${base}/api/info`, { headers });
        await r.arrayBuffer();
        if (r.status === 200) break;
      } catch { /* 还没起来 */ }
      if (Date.now() > deadline || child.exitCode !== null) assert.fail(`harness did not come up:\n${out}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    const missing = await call("POST", "/api/run", { sessionId: "q14-no-such-session", message: "hi" });
    assert.deepEqual([missing.status, missing.body.code], [404, "session_not_found"]);
    const get = await call("GET", "/api/sessions/q14-api-unreadable");
    assert.deepEqual([get.status, get.body.code], [503, "session_unreadable"], "修前 404：读不了被当成没有");
    const status = await call("GET", "/api/sessions/q14-api-unreadable/status");
    assert.deepEqual([status.status, status.body.code], [503, "session_unreadable"], "修前 exists:false");
    const mode = await call("POST", "/api/sessions/q14-api-unreadable/mode", { mode: "auto" });
    assert.deepEqual([mode.status, mode.body.code], [503, "session_unreadable"]);
    const nokey = await call("POST", "/api/sessions/q14-api-nokey/mode", { mode: "auto" });
    assert.deepEqual([nokey.status, nokey.body.code], [400, "provider_key_missing"]);
    assert.match(nokey.body.error ?? "", /No API key/);
  } finally {
    killTree(child);
    await new Promise((r) => (child.exitCode !== null ? r(null) : child.once("exit", r)));
  }
});
