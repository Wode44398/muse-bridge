// S3（#36）回归：扩展目录豁免只到「勾给 dimensio 的技能目录」，注册表（连接器明文令牌）
// 任何访问模式都进密钥守卫。
// 探针原型：竞品拆解/04-codex/笔记/probe-extension-root-secret.ts（修前 6/6 复现：
// Read(registry.json) 原样返回 Bearer、未授权技能可读、`cat registry.json` 过路径守卫）。
// 全部是假注册表 + 假令牌 + 临时目录，不读真实扩展中心。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { grantedSkillDirs, isExtensionRegistryPath, managedSkillsSection } from "./extensions.ts";
import { Sandbox } from "./sandbox.ts";
import { commandScopeViolation } from "./tools/bash.ts";
import { readTool } from "./tools/read.ts";
import type { ToolContext } from "./tools/types.ts";

const FAKE = "Bearer github_pat_FAKE0000000000000000000000000000000000000000";
let tmp = "";
let extRoot = "";
let registry = "";
let ws = "";
const savedFile = process.env.BRIDGE_EXTENSIONS_FILE;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-s3-"));
  extRoot = path.join(tmp, "extensions");
  for (const name of ["dim-skill", "claude-only"]) {
    fs.mkdirSync(path.join(extRoot, "skills", name, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(extRoot, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: x\n---\nBODY-${name}\n`);
    fs.writeFileSync(path.join(extRoot, "skills", name, "scripts", "run.py"), "print(1)\n");
  }
  registry = path.join(extRoot, "registry.json");
  fs.writeFileSync(registry, JSON.stringify({
    items: [
      { id: "a", type: "skill", name: "dim-skill", description: "d", enabled: true, agents: { claude: true, dimensio: true }, dir: "skills/dim-skill" },
      { id: "b", type: "skill", name: "claude-only", description: "d", enabled: true, agents: { claude: true, dimensio: false }, dir: "skills/claude-only" },
      { id: "c", type: "connector", name: "github", enabled: true, agents: { claude: true, dimensio: false },
        connector: { transport: "http", url: "https://example.invalid/mcp", headers: { Authorization: FAKE }, key: "github" } },
    ],
  }));
  fs.writeFileSync(registry + ".tmp", "{}");
  process.env.BRIDGE_EXTENSIONS_FILE = registry;
  ws = path.join(tmp, "ws");
  fs.mkdirSync(ws, { recursive: true });
});

afterEach(() => {
  if (savedFile === undefined) delete process.env.BRIDGE_EXTENSIONS_FILE;
  else process.env.BRIDGE_EXTENSIONS_FILE = savedFile;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
});

function ctx(access: "workspace" | "full"): ToolContext {
  return {
    sandbox: new Sandbox(ws, access),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
  };
}
const body = (r: { content: unknown }) => JSON.stringify(r.content);
// 沙箱拒绝以异常抛出（loop 统一转成工具错误），这里把「抛出」也折成 ok:false。
async function read(target: string, access: "workspace" | "full"): Promise<{ ok: boolean; content: unknown }> {
  try {
    return await readTool.run({ path: target }, ctx(access));
  } catch (e) {
    return { ok: false, content: String((e as Error).message) };
  }
}

test("S3: only skills granted to dimensio are exempt, and only their own directories", () => {
  assert.deepEqual(grantedSkillDirs(), [path.join(extRoot, "skills", "dim-skill")]);
  const section = managedSkillsSection() ?? "";
  assert.ok(section.includes("dim-skill") && !section.includes("claude-only"));
});

test("S3: Read cannot reach the registry in either access mode, nor a skill not granted to dimensio", async () => {
  for (const access of ["workspace", "full"] as const) {
    for (const target of [registry, registry + ".tmp"]) {
      const r = await read(target, access);
      assert.equal(r.ok, false, `${access}: ${path.basename(target)} must be refused`);
      assert.ok(!body(r).includes("github_pat_FAKE"), "the bearer token never reaches the model");
    }
  }
  const granted = await read(path.join(extRoot, "skills", "dim-skill", "SKILL.md"), "workspace");
  assert.equal(granted.ok, true, "a granted skill's SKILL.md stays readable");
  const other = await read(path.join(extRoot, "skills", "claude-only", "SKILL.md"), "workspace");
  assert.equal(other.ok, false, "a skill not granted to dimensio is outside the exemption");
  assert.ok(!body(other).includes("BODY-claude-only"));
  assert.equal(isExtensionRegistryPath(path.join(ws, "registry.json")), false, "a workspace file of the same name is untouched");
});

test("S3: Bash cannot name the registry (both modes); granted skill scripts still run", () => {
  for (const access of ["workspace", "full"] as const) {
    assert.match(commandScopeViolation(`cat "${registry}"`, ws, access) ?? "", /extension registry/, access);
    assert.match(commandScopeViolation(`type ${registry.replace(/\//g, "\\")}`, ws, access) ?? "", /extension registry/, access);
  }
  assert.equal(commandScopeViolation(`python "${path.join(extRoot, "skills", "dim-skill", "scripts", "run.py")}"`, ws, "workspace"), null);
  assert.match(
    commandScopeViolation(`cat "${path.join(extRoot, "skills", "claude-only", "SKILL.md")}"`, ws, "workspace") ?? "",
    /escapes the workspace/,
  );
  assert.equal(commandScopeViolation("cat registry.json", ws, "workspace"), null, "a workspace file of the same name is fine");
});

test("S3（阶段 2）: the connector secret store next to the registry is a credential file too", async () => {
  const secrets = path.join(extRoot, "connector-secrets.json");
  const key = path.join(extRoot, "connector-secrets.key");
  fs.writeFileSync(secrets, JSON.stringify({ v: 1, alg: "aes-256-gcm", iv: "DUMMY", tag: "DUMMY", data: "DUMMY-FAKE-CIPHERTEXT" }));
  fs.writeFileSync(key, JSON.stringify({ v: 1, scheme: "dpapi", blob: "DUMMY-FAKE-KEY-BLOB" }));
  for (const target of [secrets, key]) {
    assert.equal(isExtensionRegistryPath(target), true, path.basename(target));
    for (const access of ["workspace", "full"] as const) {
      const r = await read(target, access);
      assert.equal(r.ok, false, `${access}: ${path.basename(target)} must be refused`);
      assert.ok(!body(r).includes("DUMMY-FAKE"), "its content never reaches the model");
      assert.match(commandScopeViolation(`cat "${target}"`, ws, access) ?? "", /extension registry/, access);
    }
  }
  assert.equal(isExtensionRegistryPath(path.join(ws, "connector-secrets.json")), false, "a workspace file of the same name is untouched");
});
