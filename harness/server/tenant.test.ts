// 租户模式（bridge 三端拆分 P2，2026-09-28）：多用户服务端上每个注册用户一个 harness 进程，以 DIMENSIO_TENANT=1 启动。
// 这里钉住租户实例的锁——访问范围锁死、工作区限在他自己的文件夹、禁区、关掉的工具与 provider、不认 bridge 集成件、
// 共享 key 不能经 baseUrl 被带到租户指定的地址。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test, { after } from "node:test";
import { accessLock, assertInTenant, deniedRootLiteral, disabledProviders, disabledTools, insideDeniedRoot, tenantRoot } from "./tenant.ts";
import { defaultBaseUrl, effectiveBaseUrl, getConfig, resolveConfig, setConfig } from "./config.ts";
import { INTERNAL_TOKEN_HEADER } from "./api-auth.ts";
import { Sandbox, outsideReadOf } from "./sandbox.ts";
import { commandPolicyViolation, killTree, outsideReadDirs } from "./tools/bash.ts";
import { bridgeRootCandidates } from "./paths.ts";
import { toolDefs } from "./tools/registry.ts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-tenant-"));
const users = path.join(tmp, "users");
const alice = path.join(users, "alice");
const bob = path.join(users, "bob");
const host = path.join(tmp, "bridge-data");
for (const d of [alice, bob, host]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(bob, "secret.txt"), "bob's");
fs.writeFileSync(path.join(host, "config.json"), "{}");
fs.writeFileSync(path.join(alice, "mine.txt"), "alice's");

const KEYS = ["DIMENSIO_TENANT", "DIMENSIO_TENANT_SHELL", "DIMENSIO_ACCESS_LOCK", "DIMENSIO_DENY_PATHS", "DIMENSIO_DISABLE_PROVIDERS", "WORKSPACE_DIR"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
function tenantEnv(shell = true): void {
  process.env.DIMENSIO_TENANT = "1";
  process.env.DIMENSIO_TENANT_SHELL = shell ? "1" : "0";
  delete process.env.DIMENSIO_ACCESS_LOCK;
  process.env.DIMENSIO_DENY_PATHS = [users, host].join(path.delimiter);
  process.env.WORKSPACE_DIR = alice;
}
function restore(): void {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}
after(() => {
  restore();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
});

test("租户：访问范围锁死 workspace，配置接口不许切整机", () => {
  tenantEnv();
  try {
    assert.equal(accessLock(), "workspace");
    assert.throws(() => resolveConfig(getConfig(), { access: "full" }), /locked/);
    assert.equal(resolveConfig(getConfig(), { access: "workspace" }).access, "workspace");
  } finally { restore(); }
});

test("租户：工作区只能落在自己的文件夹里", () => {
  tenantEnv();
  try {
    assert.equal(tenantRoot(), path.resolve(alice));
    assert.throws(() => resolveConfig(getConfig(), { workspace: bob }), /超出/);
    assert.throws(() => assertInTenant(tmp), /超出/);
    assert.doesNotThrow(() => assertInTenant(path.join(alice, "proj")));
    assert.equal(resolveConfig(getConfig(), { workspace: alice }).workspace, path.resolve(alice));
  } finally { restore(); }
});

test("租户：禁区（别人的目录、bridge 数据根）文件工具与命令行都拒；自己的根在禁区里也照常可用", () => {
  tenantEnv();
  try {
    assert.equal(insideDeniedRoot(path.join(bob, "secret.txt")), true);
    assert.equal(insideDeniedRoot(path.join(host, "config.json")), true);
    assert.equal(insideDeniedRoot(path.join(alice, "mine.txt")), false, "自己的根在「用户根」这个禁区里，照常可用");
    // 就算 sandbox 被谁改成整机（full），锁也压着：出不了自己的文件夹，也不弹「允许这一次」
    const sb = new Sandbox(alice, "full");
    assert.throws(() => sb.resolve(path.join(bob, "secret.txt")));
    let err: unknown = null;
    try { sb.resolve(path.join(tmp, "elsewhere.txt")); } catch (e) { err = e; }
    assert.ok(err, "工作区外被拒");
    assert.equal(outsideReadOf(err), undefined, "租户模式不带「越界只读」标记——不问人，直接拒");
    assert.doesNotThrow(() => sb.resolve("mine.txt"));
    // 命令行
    const q = (p: string) => JSON.stringify(p.replace(/\\/g, "/"));
    assert.match(commandPolicyViolation(`cat ${q(path.join(bob, "secret.txt"))}`, alice, "full") ?? "", /blocked/i);
    assert.match(commandPolicyViolation(`cat ${q(path.join(tmp, "x.txt"))}`, alice, "full") ?? "", /escapes the workspace/, "传进来的 full 被锁压成 workspace");
    assert.equal(commandPolicyViolation(`cat ${q(path.join(alice, "mine.txt"))}`, alice, "workspace"), null);
    assert.equal(outsideReadDirs(`cat ${q(path.join(tmp, "x.txt"))}`, alice, "workspace"), null, "租户不问越界读");
    assert.ok(deniedRootLiteral(`python -c "open('${users.replace(/\\/g, "/")}/bob/secret.txt')"`), "引号里的字面也兜得住");
    assert.equal(deniedRootLiteral(`cat "${alice.replace(/\\/g, "/")}/mine.txt"`), null, "指着自己的根不算");
  } finally { restore(); }
});

test("租户：LocalPC 恒关；没有命令行的再关 Bash / Preview；DIMENSIO_DISABLE_PROVIDERS 关掉的 provider 选不了", () => {
  tenantEnv(true);
  try {
    assert.ok(disabledTools().has("LocalPCInspect"));
    assert.ok(!disabledTools().has("Bash"));
    const names = toolDefs().map((t) => t.name);
    assert.ok(!names.includes("LocalPCAct"));
    assert.ok(names.includes("Bash"));
  } finally { restore(); }
  tenantEnv(false);
  try {
    assert.ok(disabledTools().has("Bash") && disabledTools().has("Preview"));
    const names = toolDefs().map((t) => t.name);
    assert.ok(!names.includes("Bash") && !names.includes("Preview"));
    process.env.DIMENSIO_DISABLE_PROVIDERS = "kimi, mimo";
    assert.ok(disabledProviders().has("kimi") && disabledProviders().has("mimo"));
    assert.throws(() => resolveConfig(getConfig(), { provider: "kimi" }), /not available/);
  } finally { restore(); }
});

// 安全：租户实例里的 envKeys 是服务端的共享 key。以前 POST /api/config {provider, baseUrl} 就能让 adapter 把共享 key
// 发到任意地址。现在：没填自己的 key，baseUrl 当场拒（400）；已经在配置里的地址，建 adapter 时也改回服务端的默认地址。
test("租户：没填自己的 key 就改不了 baseUrl，共享 key 只发往服务端配置的地址（配置层）", () => {
  const evil = "https://collector.invalid/v1";
  tenantEnv();
  try {
    assert.throws(() => resolveConfig(getConfig(), { provider: "openai", baseUrl: evil }), /own API key/);
    assert.throws(() => resolveConfig(getConfig(), { provider: "anthropic", baseUrl: evil }), /own API key/);
    assert.throws(() => resolveConfig(getConfig(), { baseUrl: evil }), /own API key/, "不换厂商、只改地址也拒");
    assert.throws(() => setConfig({ provider: "kimi", baseUrl: evil }), /own API key/, "设置接口同样拒（抛在落盘之前）");
    // 给的就是默认地址（或空串）：不算改，照默认地址
    assert.equal(resolveConfig(getConfig(), { provider: "openai", baseUrl: `${defaultBaseUrl("openai")}/` }).baseUrl, defaultBaseUrl("openai"));
    assert.equal(resolveConfig(getConfig(), { provider: "openai", baseUrl: "" }).baseUrl, defaultBaseUrl("openai"));
    // 已经写进配置的地址（落盘的会话配置等）：建 adapter 时一律改回默认地址
    assert.equal(effectiveBaseUrl("openai", evil), defaultBaseUrl("openai"));
    assert.equal(effectiveBaseUrl("anthropic", evil), undefined, "anthropic 回到 SDK 默认地址");
    // 同一个补丁里带了自己的 key：认他给的地址（发出去的是他自己的 key，端到端见下一条）
    assert.equal(resolveConfig(getConfig(), { provider: "openai", baseUrl: evil }, { ownKey: true }).baseUrl, evil);
  } finally { restore(); }
  // 非租户（单人本机）：照旧可以指向自建 / 兼容端点
  assert.equal(effectiveBaseUrl("openai", evil), evil);
  assert.equal(resolveConfig(getConfig(), { provider: "openai", baseUrl: evil }).baseUrl, evil);
});

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

test("租户（真 harness）：POST /api/config 改 baseUrl 带不走服务端的共享 key；填了自己的 key 才认自己的地址", { timeout: 90_000 }, async () => {
  const SHARED = "FAKE-shared-server-openai-key";
  const OWN = "FAKE-tenant-own-openai-key";
  // 两个假的 OpenAI 兼容服务：official = 服务端配置的地址，collector = 租户想把请求改道去的地址。都只回一句话。
  const hits: { who: string; auth: string }[] = [];
  const stub = (who: string) =>
    http.createServer((req, res) => {
      hits.push({ who, auth: String(req.headers.authorization ?? "") });
      req.resume();
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
    });
  const official = stub("official");
  const collector = stub("collector");
  for (const s of [official, collector]) await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const urlOf = (s: http.Server) => `http://127.0.0.1:${(s.address() as net.AddressInfo).port}/v1`;

  const home = path.join(users, "carol");
  const data = path.join(tmp, "carol-data");
  for (const d of [home, data]) fs.mkdirSync(d, { recursive: true });
  const port = await freePort();
  const TOKEN = "tenant-DUMMY-process-token";
  const child = spawn(process.execPath, ["server/index.ts"], {
    cwd: path.join(import.meta.dirname, ".."),
    env: {
      ...process.env,
      PORT: String(port),
      DIMENSIO_HOST: "127.0.0.1",
      DIMENSIO_INTERNAL_TOKEN: "",
      DIMENSIO_DEV_TOKEN: TOKEN,
      DIMENSIO_OUTBOUND_PROXY: "off",
      DIMENSIO_TENANT: "1",
      DIMENSIO_TENANT_SHELL: "0",
      DIMENSIO_DENY_PATHS: [users, host].join(path.delimiter),
      WORKSPACE_DIR: home,
      SESSIONS_DIR: path.join(data, "sessions"),
      DIMENSIO_CONFIG_FILE: path.join(data, "runtime-config.json"),
      // 服务端（bridge）给所有租户共用的 key 与地址
      OPENAI_API_KEY: SHARED,
      OPENAI_BASE_URL: urlOf(official),
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
  const post = (p: string, body: unknown, signal?: AbortSignal) =>
    fetch(base + p, { method: "POST", headers, body: JSON.stringify(body), signal });
  const runs: AbortController[] = [];
  // 发一轮，等到指定的假服务收到模型请求为止（不等整条 SSE 流收尾）
  const runUntilHit = async (message: string, who: string) => {
    const seen = hits.filter((h) => h.who === who).length;
    const ctl = new AbortController();
    runs.push(ctl);
    const res = await post("/api/run", { message }, ctl.signal);
    assert.equal(res.status, 200);
    const deadline = Date.now() + 30_000;
    while (hits.filter((h) => h.who === who).length === seen) {
      if (Date.now() > deadline) assert.fail(`${who} never received the model request:\n${out.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 50));
    }
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

    // 1. 没有自己的 key：改道被拒（400），配置里仍是服务端的地址，这一轮的请求带着共享 key 去的也是它
    const denied = await post("/api/config", { provider: "openai", baseUrl: urlOf(collector) });
    assert.equal(denied.status, 400);
    assert.match(String(((await denied.json()) as { error?: string }).error), /own API key/);
    const cfg = (await (await fetch(`${base}/api/config`, { headers })).json()) as { provider: string; baseUrl?: string };
    assert.deepEqual({ provider: cfg.provider, baseUrl: cfg.baseUrl }, { provider: "openai", baseUrl: urlOf(official) });
    await runUntilHit("hello", "official");
    assert.ok(hits.some((h) => h.who === "official" && h.auth === `Bearer ${SHARED}`));
    assert.equal(hits.filter((h) => h.who === "collector").length, 0, "改道的地址一个请求都没收到");

    // 2. 带上自己的 key：认他的地址，发过去的是他自己的 key
    const own = await post("/api/config", { provider: "openai", baseUrl: urlOf(collector), apiKey: OWN });
    assert.equal(own.status, 200, await own.clone().text());
    await runUntilHit("hello again", "collector");
    const leaked = hits.filter((h) => h.who === "collector" && h.auth !== `Bearer ${OWN}`);
    assert.deepEqual(leaked, [], "租户指定的地址只见过他自己的 key");
  } finally {
    for (const ctl of runs) ctl.abort();
    killTree(child);
    for (const s of [official, collector]) {
      s.closeAllConnections();
      s.close();
    }
  }
});

test("租户：不认 bridge 的集成件（扩展注册表 / 本机 broker 的位置）", () => {
  tenantEnv();
  try {
    assert.deepEqual(bridgeRootCandidates(), []);
    assert.deepEqual(bridgeRootCandidates({ withHarnessDir: true }), []);
  } finally { restore(); }
});

test("非租户：一切照旧（无锁、无禁区、工具齐全）", () => {
  restore();
  delete process.env.DIMENSIO_TENANT;
  delete process.env.DIMENSIO_DENY_PATHS;
  try {
    assert.equal(accessLock(), null);
    assert.equal(tenantRoot(), null);
    assert.equal(insideDeniedRoot(path.join(bob, "secret.txt")), false);
    assert.equal(disabledTools().size, 0);
    assert.equal(disabledProviders().size, 0);
  } finally { restore(); }
});
