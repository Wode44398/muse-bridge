// 租户模式（bridge 三端拆分 P2，2026-09-28）：多用户服务端上每个注册用户一个 harness 进程，以 DIMENSIO_TENANT=1 启动。
// 这里钉住租户实例的锁——访问范围锁死、工作区限在他自己的文件夹、禁区、关掉的工具与 provider、不认 bridge 集成件、
// 共享 key 不能经 baseUrl 被带到租户指定的地址。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { accessLock, assertInTenant, deniedRootLiteral, disabledProviders, disabledTools, insideDeniedRoot, tenantRoot } from "./tenant.ts";
import { defaultBaseUrl, effectiveBaseUrl, getConfig, resolveConfig, setConfig } from "./config.ts";
import { Sandbox, outsideReadOf } from "./sandbox.ts";
import { commandPolicyViolation, outsideReadDirs } from "./tools/bash.ts";
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

const KEYS = ["DIMENSIO_TENANT", "DIMENSIO_TENANT_SHELL", "DIMENSIO_ACCESS_LOCK", "DIMENSIO_DENY_PATHS", "WORKSPACE_DIR"] as const;
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

test("租户：设备工具不进禁用名单（bridge 给的是按人令牌，见 device-tools.test）；没有命令行的再关 Bash / Preview；本机模型 provider 关掉", () => {
  tenantEnv(true);
  try {
    assert.ok(!disabledTools().has("DeviceInspect") && !disabledTools().has("DeviceAct"));
    assert.ok(!disabledTools().has("Bash"));
    assert.ok(disabledProviders().has("local"));
    const names = toolDefs().map((t) => t.name);
    assert.ok(!names.includes("DeviceAct"), "没接上设备通道就不出现");
    assert.ok(names.includes("Bash"));
  } finally { restore(); }
  tenantEnv(false);
  try {
    assert.ok(disabledTools().has("Bash") && disabledTools().has("Preview"));
    const names = toolDefs().map((t) => t.name);
    assert.ok(!names.includes("Bash") && !names.includes("Preview"));
    assert.throws(() => resolveConfig(getConfig(), { provider: "local" as any }), /not available/);
  } finally { restore(); }
});

test("租户：不认 bridge 的集成件（扩展注册表的位置）", () => {
  tenantEnv();
  try {
    assert.deepEqual(bridgeRootCandidates(), []);
  } finally { restore(); }
});

// 安全：租户实例共用管理员的厂商 key。以前 POST /api/config {provider, baseUrl} 就能让 adapter 把共享 key 发到任意地址。
// 现在：没填自己的 key，baseUrl 当场拒（400）；已经在配置里的地址，建 adapter 时也改回服务端的默认地址。
test("租户：没填自己的 key 就改不了 baseUrl，共享 key 只发往服务端配置的地址", () => {
  const evil = "https://collector.invalid/v1";
  const before = getConfig();
  tenantEnv();
  try {
    assert.throws(() => resolveConfig(getConfig(), { provider: "openai", baseUrl: evil }), /own API key/);
    assert.throws(() => resolveConfig(getConfig(), { provider: "anthropic", baseUrl: evil }), /own API key/);
    assert.throws(() => resolveConfig(getConfig(), { baseUrl: evil }), /own API key/, "不换厂商、只改地址也拒");
    assert.throws(() => setConfig({ provider: "kimi", baseUrl: evil }), /own API key/, "设置接口同样拒（抛在落盘之前）");
    assert.deepEqual(getConfig(), before, "拒掉的补丁一点都没落进全局配置");
    // 给的就是默认地址（或空串）：不算改，照默认地址
    assert.equal(resolveConfig(getConfig(), { provider: "openai", baseUrl: `${defaultBaseUrl("openai")}/` }).baseUrl, defaultBaseUrl("openai"));
    assert.equal(resolveConfig(getConfig(), { provider: "openai", baseUrl: "" }).baseUrl, defaultBaseUrl("openai"));
    // 已经写进配置的地址（落盘的会话配置等）：建 adapter 时一律改回默认地址
    assert.equal(effectiveBaseUrl("openai", evil), defaultBaseUrl("openai"));
    assert.equal(effectiveBaseUrl("anthropic", evil), undefined, "anthropic 回到 SDK 默认地址");
    // 同一个补丁里带了自己的 key：认他给的地址（发出去的是他自己的 key）
    assert.equal(resolveConfig(getConfig(), { provider: "openai", baseUrl: evil }, { ownKey: true }).baseUrl, evil);
  } finally { restore(); }
  // 非租户（单人本机）：照旧可以指向自建 / 兼容端点
  assert.equal(effectiveBaseUrl("openai", evil), evil);
  assert.equal(resolveConfig(getConfig(), { provider: "openai", baseUrl: evil }).baseUrl, evil);
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
