// M7（D1）：落盘记录的版本迁移框架 + 读会话的判别联合（ok / not-found / corrupt / unsupported-version）。
//
// 修前：会话记录 `v !== 1` 一律当读不出来——换一次格式，旧会话全部从列表里消失；M6 之后更糟：更新版本写的
// 记录会被当成坏文件隔离（改名 .corrupt-*），再从检查点副本「恢复」成旧格式写回去，新版本的字段全丢。
// 部署回滚（test 分支提了版本、又切回旧版本）就会撞上。
//
// 提记录版本时：store.ts 的 SESSION_RECORD_VERSION +1、迁移链末尾追加一步，并在下面 FIXTURES 里补一份
// 旧版本的真实样子——「每个历史版本都有夹具」那条会逼着你补。

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { afterEach } from "node:test";
import { fileURLToPath } from "node:url";
import { INTERNAL_TOKEN_HEADER } from "./api-auth.ts";
import { readVersioned, type RawRecord } from "./record-version.ts";
import { getOrLoadSession, rollbackSession } from "./session.ts";
import {
  listSessions,
  loadSession,
  loadSessionResult,
  parseSessionRecord,
  saveSession,
  SESSION_RECORD_VERSION,
  type PersistedSession,
} from "./store.ts";
import { killTree } from "./tools/bash.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(dir);
  return dir;
}
const tag = () => randomBytes(4).toString("hex");

// v1 记录的真实样子（sessionRecord() 今天写出的字段）。
const V1_FIXTURE = {
  v: 1,
  id: "m7-fixture-v1",
  createdAt: 1_700_000_000_000,
  updatedAt: 1_700_000_100_000,
  title: "v1 夹具",
  config: { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace: "C:/ws", access: "workspace" },
  system: "sys",
  messages: [
    { role: "user", content: [{ t: "text", text: "hi" }] },
    { role: "assistant", content: [{ t: "text", text: "yo" }] },
  ],
  todos: [],
  totals: { inputTokens: 1, outputTokens: 2, lastContextTokens: 3 },
  gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] },
  counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
};
const FIXTURES: Record<number, Record<string, unknown>> = { 1: V1_FIXTURE };

test("M7 迁移链：逐级升到当前版本；缺步骤 / 步骤出错 / 版本号不对都算坏；更新的版本单列", () => {
  const chain = {
    1: (r: RawRecord): RawRecord => ({ ...r, v: 2, a: "added-in-2" }),
    2: (r: RawRecord): RawRecord => ({ ...r, v: 3, b: (r.a as string) + "+3" }),
  };
  const up = readVersioned({ v: 1, keep: true }, 3, chain);
  assert.deepEqual(up, { kind: "ok", rec: { v: 3, keep: true, a: "added-in-2", b: "added-in-2+3" }, migratedFrom: 1 });
  const same = { v: 3, x: 1 };
  assert.deepEqual(readVersioned(same, 3, chain), { kind: "ok", rec: same });
  assert.deepEqual(readVersioned({ v: 4, y: 1 }, 3, chain), { kind: "unsupported-version", version: 4, raw: { v: 4, y: 1 } });
  for (const bad of [null, [], "x", {}, { v: 0 }, { v: "1" }, { v: 1.5 }]) {
    assert.equal(readVersioned(bad, 3, chain).kind, "corrupt", JSON.stringify(bad));
  }
  assert.match((readVersioned({ v: 1 }, 3, { 2: chain[2] }) as { reason: string }).reason, /no migration from version 1/);
  assert.match((readVersioned({ v: 1 }, 2, { 1: (r: RawRecord) => ({ ...r, v: 5 }) }) as { reason: string }).reason, /did not produce version 2/);
  assert.match(
    (readVersioned({ v: 1 }, 2, { 1: () => { throw new Error("boom"); } }) as { reason: string }).reason,
    /migration from version 1 failed: boom/,
  );
});

test("M7 每个历史版本都有夹具，并且都读成当前形状（当前版本原样读回）", () => {
  for (let v = 1; v <= SESSION_RECORD_VERSION; v++) {
    const fx = FIXTURES[v];
    assert.ok(fx, `记录版本 v${v} 缺夹具：提版本时在 FIXTURES 里补一份旧版本的真实样子`);
    const r = parseSessionRecord(JSON.stringify(fx), fx.id as string);
    assert.equal(r.kind, "ok", `v${v} 夹具读不出来`);
    if (r.kind !== "ok") continue;
    assert.equal(r.rec.v, SESSION_RECORD_VERSION);
    assert.equal(r.migratedFrom, v < SESSION_RECORD_VERSION ? v : undefined);
    // C3：C3 之前写的记录读入时补上 origins 标记（消息来源按旧规则补标，这份夹具里没有注入，消息原样）；已带标记的原样读回
    if (v === SESSION_RECORD_VERSION) {
      assert.deepEqual(r.rec, { ...fx, origins: 1 });
      const tagged = parseSessionRecord(JSON.stringify({ ...fx, origins: 1 }), fx.id as string);
      assert.deepEqual(tagged.kind === "ok" ? tagged.rec : null, { ...fx, origins: 1 });
    }
  }
});

test("M7 更新版本写的会话：不隔离、不写回；列表里只读；恢复运行、覆盖写、回滚一律拒绝", async () => {
  const dir = process.env.SESSIONS_DIR!;
  fs.mkdirSync(dir, { recursive: true });
  const id = `m7-newer-${tag()}`;
  const file = path.join(dir, `${id}.json`);
  const text = JSON.stringify({ ...V1_FIXTURE, id, v: 99, title: "新版本写的", futureField: { x: 1 } });
  fs.writeFileSync(file, text);

  const r = await loadSessionResult(id);
  assert.equal(r.kind, "unsupported-version");
  if (r.kind !== "unsupported-version") return;
  assert.equal(r.version, 99);
  assert.equal(r.view.title, "新版本写的");
  assert.equal(r.view.messages.length, 2);
  assert.equal(fs.readFileSync(file, "utf8"), text, "原样留在盘上");
  assert.deepEqual(fs.readdirSync(dir).filter((n) => n.startsWith(`${id}.json.corrupt-`)), [], "不当坏文件隔离");
  assert.equal(await loadSession(id), null, "要可用记录的调用方拿到 null");

  const meta = (await listSessions()).find((m) => m.id === id);
  assert.ok(meta, "列表里照样有它");
  assert.deepEqual(meta!.readOnly, { version: 99 });
  assert.match(meta!.title, /只读/);

  await assert.rejects(getOrLoadSession(id), /更新版本的 dimensio/);
  await assert.rejects(saveSession({ ...V1_FIXTURE, id } as unknown as PersistedSession), /refusing to overwrite/);
  const rb = await rollbackSession(id, 1);
  assert.equal(rb.ok, false);
  assert.match(rb.error ?? "", /更新版本的 dimensio/);
  assert.equal(fs.readFileSync(file, "utf8"), text, "从头到尾一个字节没动");
  fs.rmSync(file);
});

test("M7 损坏与不存在分得清；损坏恢复时跳过更新版本写的检查点副本", async () => {
  const dir = process.env.SESSIONS_DIR!;
  fs.mkdirSync(path.join(dir, "checkpoints"), { recursive: true });
  assert.deepEqual(await loadSessionResult(`m7-missing-${tag()}`), { kind: "not-found" });

  const bad = `m7-corrupt-${tag()}`;
  fs.writeFileSync(path.join(dir, `${bad}.json`), "{ not json");
  const r = await loadSessionResult(bad);
  assert.equal(r.kind, "corrupt");
  if (r.kind === "corrupt") assert.ok(r.quarantined.startsWith(`${bad}.json.corrupt-`), r.quarantined);

  const id = `m7-recover-${tag()}`;
  fs.writeFileSync(path.join(dir, "checkpoints", `${id}.1.json`), JSON.stringify({ ...V1_FIXTURE, id, title: "旧副本" }));
  fs.writeFileSync(path.join(dir, "checkpoints", `${id}.2.json`), JSON.stringify({ ...V1_FIXTURE, id, v: 99, title: "新版本副本" }));
  fs.writeFileSync(path.join(dir, `${id}.json`), "\0\0\0\0");
  const rec = await loadSessionResult(id);
  assert.equal(rec.kind, "ok");
  if (rec.kind !== "ok") return;
  assert.equal(rec.restoredFrom, 1, "新版本写的副本不拿来恢复");
  assert.match(rec.rec.title, /旧副本/);
});

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("M7 真 harness：更新版本写的会话列表里只读、详情只读展示；切档 / 发消息回 400 说明原因（不挂住）", { timeout: 90_000 }, async () => {
  const ws = temp("dimensio-m7-live-");
  const sessions = path.join(ws, "sessions");
  fs.mkdirSync(sessions);
  const newerText = JSON.stringify({ ...V1_FIXTURE, id: "m7-live-newer", v: 99, title: "新版本写的" });
  fs.writeFileSync(path.join(sessions, "m7-live-newer.json"), newerText);
  fs.writeFileSync(path.join(sessions, "m7-live-ok.json"), JSON.stringify({ ...V1_FIXTURE, id: "m7-live-ok" }));
  const port = await freePort();
  const TOKEN = "m7-DUMMY-process-token";
  const child = spawn(process.execPath, ["server/index.ts"], {
    cwd: path.join(here, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DIMENSIO_HOST: "127.0.0.1",
      DIMENSIO_INTERNAL_TOKEN: "",
      DIMENSIO_DEV_TOKEN: TOKEN,
      HARNESS_ENV_FILE: path.join(ws, "no-such.env"),
      DIMENSIO_OUTBOUND_PROXY: "off",
      WORKSPACE_DIR: ws,
      SESSIONS_DIR: sessions,
      BRIDGE_PORT: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout!.on("data", (d) => { out += d; });
  child.stderr!.on("data", (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  const headers = { [INTERNAL_TOKEN_HEADER]: TOKEN, "content-type": "application/json" };
  const call = (p: string, body?: unknown) =>
    fetch(base + p, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000), // 挂住就超时失败
    });
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
    const list = (await (await call("/api/sessions")).json()) as any[];
    const newer = list.find((m) => m.id === "m7-live-newer");
    assert.deepEqual(newer?.readOnly, { version: 99 }, JSON.stringify(list));
    assert.ok(list.some((m) => m.id === "m7-live-ok" && !m.readOnly));

    const detail = await call("/api/sessions/m7-live-newer");
    assert.equal(detail.status, 200);
    const body = (await detail.json()) as any;
    assert.equal(body.readOnly?.version, 99);
    assert.equal(body.messages.length, 2);
    assert.equal(((await (await call("/api/sessions/m7-live-newer/status")).json()) as any).exists, true);

    const mode = await call("/api/sessions/m7-live-newer/mode", { mode: "plan" });
    assert.equal(mode.status, 400);
    assert.match(((await mode.json()) as any).error, /更新版本的 dimensio/);
    const run = await call("/api/run", { sessionId: "m7-live-newer", message: "继续" });
    assert.equal(run.status, 400);
    assert.match(((await run.json()) as any).error, /更新版本的 dimensio/);

    assert.equal(fs.readFileSync(path.join(sessions, "m7-live-newer.json"), "utf8"), newerText, "盘上的新版本记录一个字节没动");
  } finally {
    if (child.exitCode === null) {
      const gone = new Promise((r) => child.once("exit", r));
      killTree(child);
      await gone;
    }
  }
});
