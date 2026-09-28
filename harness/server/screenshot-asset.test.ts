// R12（二，K31）：截图事件不再带 base64——截图存成会话资产，事件只带资产 id，界面按 URL 取
// （GET /api/sessions/:id/assets/:asset，要令牌、只认这个会话自己的资产）。
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { itemFp } from "../web/src/lib/timeline-merge.ts";
import { INTERNAL_TOKEN_HEADER } from "./api-auth.ts";
import { deleteSessionAssets, screenshotEvent, sessionAssetExists, storeSessionImage } from "./image-assets.ts";
import { sessionsDir } from "./paths.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
// 最小的 1×1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

test("R12（二）截图事件：有会话就存成资产、事件只带 id；没有会话才退回 dataUri", async (t) => {
  const id = "r12b-shot-event";
  t.after(() => deleteSessionAssets(id));
  const ev = screenshotEvent(id, PNG, "image/png", "https://example.com/", "looks fine");
  assert.equal(ev.dataUri, undefined, "事件里没有 base64");
  assert.match(ev.asset ?? "", /^[a-f0-9]{64}\.png$/);
  assert.ok(sessionAssetExists(id, ev.asset!));
  assert.equal(ev.verdict, "looks fine");
  const bare = screenshotEvent(undefined, PNG, "image/png", "https://example.com/");
  assert.match(bare.dataUri ?? "", /^data:image\/png;base64,/);
  assert.equal(bare.asset, undefined);

  // 前端时间线：同一个页面的两张不同截图，合并指纹不同（以前按 dataUri 长度区分，资产化之后改按资产 id）
  const a = itemFp({ kind: "screenshot", dataUri: "", asset: "a".repeat(64) + ".png", url: "u", verdict: "" } as never);
  const b = itemFp({ kind: "screenshot", dataUri: "", asset: "b".repeat(64) + ".png", url: "u", verdict: "" } as never);
  assert.notEqual(a, b);
});

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("R12（二）会话资产路由：要令牌（头或 GET 查询串）、只认这个会话自己的资产、内容哈希可长缓存", { timeout: 90_000 }, async (t) => {
  const id = "r12b-asset-route";
  const other = "r12b-asset-other";
  const rec = {
    v: 1, id, createdAt: 1_700_000_000_000, updatedAt: 1_700_000_100_000, title: "资产路由夹具",
    config: { provider: "openai", model: "fake", thinking: "off", permissionMode: "auto", workspace: os.tmpdir(), access: "workspace" },
    system: "sys", messages: [{ role: "user", content: [{ t: "text", text: "hi" }] }], todos: [],
    totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] }, counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
  };
  fs.mkdirSync(sessionsDir(), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir(), `${id}.json`), JSON.stringify(rec));
  t.after(() => fs.rmSync(path.join(sessionsDir(), `${id}.json`), { force: true }));
  const asset = storeSessionImage(id, PNG, "image/png").asset!;
  const otherAsset = storeSessionImage(other, Buffer.concat([PNG, Buffer.from([0])]), "image/png").asset!;
  t.after(() => deleteSessionAssets(id));
  t.after(() => deleteSessionAssets(other));

  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-r12b-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const port = await freePort();
  const TOKEN = "r12b-DUMMY-dev-token";
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
      BRIDGE_PORT: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let out = "";
  child.stdout!.on("data", (d) => (out += d));
  child.stderr!.on("data", (d) => (out += d));
  t.after(() => {
    child.kill();
  });
  const base = `http://127.0.0.1:${port}`;
  const headers = { [INTERNAL_TOKEN_HEADER]: TOKEN };
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const r = await fetch(`${base}/api/info`, { headers });
      await r.arrayBuffer();
      if (r.status === 200) break;
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline || child.exitCode !== null) assert.fail(`harness did not come up:\n${out}`);
    await new Promise((r) => setTimeout(r, 200));
  }

  const url = `${base}/api/sessions/${id}/assets/${asset}`;
  const ok = await fetch(url, { headers });
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("content-type"), "image/png");
  assert.match(ok.headers.get("cache-control") ?? "", /immutable/);
  assert.equal(ok.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await ok.arrayBuffer()), PNG);

  const byQuery = await fetch(`${url}?dimensio_token=${TOKEN}`);
  assert.equal(byQuery.status, 200, "<img> 带不了头：GET 认查询串里的令牌");
  await byQuery.arrayBuffer();
  const anon = await fetch(url);
  assert.equal(anon.status, 401, "不带令牌不给");
  await anon.arrayBuffer();

  // R14（K37）：「转后台」路由——没有正在前台跑的那次调用就 409 {moved:false}（顺带在这个真起的 harness 上验一下）
  const bg = await fetch(`${base}/api/sessions/${id}/tools/no-such-call/background`, { method: "POST", headers });
  assert.equal(bg.status, 409);
  assert.deepEqual(await bg.json(), { moved: false });

  for (const [p, why] of [
    [`/api/sessions/${id}/assets/${otherAsset}`, "别的会话的资产"],
    [`/api/sessions/${id}/assets/${"c".repeat(64)}.png`, "不存在的资产"],
    [`/api/sessions/${id}/assets/..%2F..%2F${id}.json`, "路径穿越"],
    [`/api/sessions/no-such-session/assets/${asset}`, "不存在的会话"],
  ] as const) {
    const r = await fetch(base + p, { headers });
    assert.equal(r.status, 404, why);
    await r.arrayBuffer();
  }
});
