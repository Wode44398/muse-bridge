// S4（#37）回归：Read、Grep/Glob 遍历、Browser file://、Bash 命令行共用一个凭据判定；名单补齐
// 本机真实存在的凭据库；家目录下的点目录默认拒读；bridge config.json 按位置拒；出口统一脱敏，
// 且 Write/Edit 不许把脱敏标记写回文件。
// 探针原型（竞品拆解/04-codex/笔记/）：
//   probe-secret-guard-bypass.ts —— 修前 full 模式 6 类凭据 Read 与 cat 全放行；Grep 吐出工作区 .env 原文；
//   probe-bash-secret-regex.ts   —— 修前 `cat ./.env`、`cat config/.env`、`cat ~/.ssh/id_rsa` 等放行；
//   probe-browser-file-scheme.ts —— 修前 Navigate(file:///…/.ssh/id_ed25519) 后 ReadPage 读到私钥。
// 全部是临时目录里的假凭据；家目录经 USERPROFILE/HOME 改道到临时目录。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test, { afterEach, beforeEach } from "node:test";
import { fileUrlBlock, isSecretName, readVerdict, Sandbox } from "./sandbox.ts";
import { redactOutput } from "./redact.ts";
import { commandScopeViolation } from "./tools/bash.ts";
import { grepTool } from "./tools/grep.ts";
import { globTool } from "./tools/glob.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import { editTool } from "./tools/edit.ts";
import { browserTool } from "./tools/browser.ts";
import { existingSharedBrowser, releaseBrowser } from "./cdp.ts";
import type { ToolContext } from "./tools/types.ts";

const MARK = "DUMMY-SECRET-7f3a";
const ENV_KEYS = ["USERPROFILE", "HOME", "BRIDGE_DATA_ROOT", "DIMENSIO_READONLY_PATHS", "S4_FAKE_API_KEY", "S4_BASE_URL_TOKEN"] as const;
let saved: Record<string, string | undefined> = {};
let tmp = "";
let home = "";
let ws = "";

function put(root: string, rel: string, body: string): string {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-s4-"));
  home = path.join(tmp, "home");
  ws = path.join(home, "proj");
  fs.mkdirSync(ws, { recursive: true });
  process.env.USERPROFILE = home;
  process.env.HOME = home;
  delete process.env.DIMENSIO_READONLY_PATHS;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
});

function ctx(access: "workspace" | "full", owner = "s4-test"): ToolContext {
  return {
    sandbox: new Sandbox(ws, access),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    ownerId: owner,
  };
}
const text = (r: { content: unknown }) => JSON.stringify(r.content);
async function run(tool: { run: (a: Record<string, unknown>, c: ToolContext) => Promise<any> }, args: Record<string, unknown>, c: ToolContext) {
  try {
    return await tool.run(args, c);
  } catch (e) {
    return { ok: false, summary: "threw", content: [{ t: "text", text: (e as Error).message }] };
  }
}

test("S4: credential names are judged per path segment (the old regex missed ~/.aws/credentials, ~/.ssh/config, ~/.gnupg/*)", () => {
  for (const p of [
    "/h/.aws/credentials", "/h/.ssh/config", "/h/.gnupg/private-keys-v1.d/x.key", "/p/.env", "/p/.env.local",
    "/p/config/.env", "/h/.claude/.credentials.json", "/h/.codex/auth.json", "/h/.cloudflared/abc.json",
    "/h/.kimi/agent-gw.json", "/h/.docker/config.json", "/h/.config/gh/hosts.yml", "/h/.kube/config", "/h/.azure/x.json",
  ]) assert.equal(isSecretName(p), true, p);
  for (const p of ["/p/.envrc", "/p/src/env.ts", "/p/.claude/settings.json", "/h/.ssh.md", "/p/id_rsa.pub", "/p/docker/config.json"]) {
    assert.equal(isSecretName(p), false, p);
  }
});

test("S4: full access still cannot Read the stores that exist on this machine, nor ~/.<dot> areas or the bridge config", async () => {
  const stores = [
    put(home, ".ssh/id_ed25519", `-----BEGIN OPENSSH PRIVATE KEY-----\n${MARK}\n-----END OPENSSH PRIVATE KEY-----\n`),
    put(home, ".claude/.credentials.json", `{"claudeAiOauth":{"accessToken":"${MARK}"}}`),
    put(home, ".codex/auth.json", `{"tokens":{"access_token":"${MARK}"}}`),
    put(home, ".cloudflared/0f1e2d3c-aaaa-bbbb-cccc-ddddeeeeffff.json", `{"TunnelSecret":"${MARK}"}`),
    put(home, ".kimi/agent-gw.json", `{"token":"${MARK}"}`),
    put(home, ".docker/config.json", `{"auths":{"x":{"auth":"${MARK}"}}}`),
    put(home, ".claude/projects/p/session.jsonl", `{"t":"${MARK}"}`), // 家目录点目录规则
    put(home, ".bash_history", `export OPENAI_API_KEY=${MARK}\n`), // 家目录点文件
  ];
  const dataRoot = path.join(tmp, "bridge-data");
  process.env.BRIDGE_DATA_ROOT = dataRoot;
  stores.push(put(dataRoot, "config.json", `{"token":"${MARK}"}`), put(dataRoot, "config.json.bak-20260804", `{"token":"${MARK}"}`));
  for (const f of stores) {
    const r = await run(readTool, { path: f }, ctx("full"));
    assert.equal(r.ok, false, f);
    assert.ok(!text(r).includes(MARK), f);
    assert.ok(readVerdict(f, ws), `readVerdict must refuse ${f}`);
  }
  // 放行：依赖缓存、.gitconfig、家目录里的普通文件、工作区里同名的 config.json 与 .claude 项目配置。
  for (const f of [
    put(home, ".cargo/registry/src/lib.rs", "fn main() {}\n"),
    put(home, ".gitconfig", "[user]\n name = x\n"),
    put(home, "Documents/a.txt", "hello\n"),
    put(ws, "config.json", "{}"),
    put(ws, ".claude/settings.json", "{}"),
  ]) {
    const r = await run(readTool, { path: f }, ctx("full"));
    assert.equal(r.ok, true, `${f}: ${text(r)}`);
  }
  // 用户显式开放读的目录可以覆盖点目录规则（名字判定的凭据文件照旧拒）。
  process.env.DIMENSIO_READONLY_PATHS = path.join(home, ".claude");
  assert.equal(readVerdict(path.join(home, ".claude", "projects", "p", "session.jsonl"), ws), null);
  assert.ok(readVerdict(path.join(home, ".claude", ".credentials.json"), ws));
});

test("S4: Grep and Glob walks skip what Read refuses (probe: Grep used to print the workspace .env verbatim)", async () => {
  put(ws, ".env", `OPENAI_API_KEY=${MARK}\n`);
  put(ws, "deploy/.ssh/id_rsa", `${MARK}\n`);
  put(ws, "notes.txt", `plain ${MARK}\n`);
  for (const access of ["workspace", "full"] as const) {
    const g = await run(grepTool, { pattern: MARK, mode: "files" }, ctx(access));
    assert.equal(g.ok, true);
    assert.match(text(g), /notes\.txt/);
    assert.ok(!/\.env|id_rsa/.test(text(g)), `${access}: ${text(g)}`);
    const l = await run(globTool, { pattern: "**/*" }, ctx(access));
    assert.ok(!/\.env|id_rsa/.test(text(l)), `${access}: ${text(l)}`);
  }
  // full 模式 Grep 家目录：点目录里的凭据一条都不出来。
  put(home, ".codex/auth.json", `{"tokens":{"access_token":"${MARK}"}}`);
  const all = await run(grepTool, { pattern: MARK, path: home, mode: "files" }, ctx("full"));
  assert.ok(!/\.codex|\.env|id_rsa/.test(text(all)), text(all));
});

test("S4: Bash names credential stores anywhere in a path (probe-bash-secret-regex)", () => {
  for (const [cmd, access] of [
    ["cat ./.env", "workspace"],
    ["cat config/.env", "workspace"],
    ["cat ~/.ssh/id_rsa", "full"],
    ["cat /c/Users/x/.ssh/id_ed25519", "full"],
    ["cat C:/Users/x/claude-bridge/harness/.env", "full"],
    ["cat ~/.claude/.credentials.json", "full"],
    ["cat ~/.aws/credentials", "full"],
  ] as const) {
    assert.ok(commandScopeViolation(cmd, ws, access), `${access}: ${cmd}`);
  }
  // 家目录点目录与 bridge 配置经路径候选走同一判定。
  assert.match(commandScopeViolation(`cat "${path.join(home, ".config", "tool", "state.txt")}"`, ws, "full") ?? "", /secret guard/);
  process.env.BRIDGE_DATA_ROOT = path.join(tmp, "bridge-data");
  assert.match(commandScopeViolation(`type "${path.join(tmp, "bridge-data", "config.json")}"`, ws, "full") ?? "", /bridge config/);
  for (const cmd of ["cat .envrc", "node scripts/env.js", "cat src/config.json", `cat "${path.join(home, ".cargo", "config.toml")}"`]) {
    assert.equal(commandScopeViolation(cmd, ws, "full"), null, cmd);
  }
});

test("S4: Browser file:// goes through the same gate as Read (probe-browser-file-scheme), without launching a browser", async () => {
  const key = put(home, ".ssh/id_ed25519", `${MARK}\n`);
  const ok = put(ws, "page.html", "<p>hi</p>");
  const sb = new Sandbox(ws, "full");
  assert.match(fileUrlBlock(pathToFileURL(key).href, sb) ?? "", /secret guard/);
  assert.equal(fileUrlBlock(pathToFileURL(ok).href, sb), null);
  assert.equal(fileUrlBlock("https://example.com/", sb), null);
  assert.match(fileUrlBlock(pathToFileURL(path.join(tmp, "elsewhere.txt")).href, new Sandbox(ws, "workspace")) ?? "", /escapes/);
  try {
    const r = await run(browserTool, { action: "navigate", url: pathToFileURL(key).href }, ctx("full"));
    assert.equal(r.ok, false);
    assert.ok(!existingSharedBrowser(), "a refused file:// navigation must not launch the shared browser");
  } finally {
    releaseBrowser("s4-test");
  }
});

test("S4: tool output is scrubbed with high-confidence rules only", () => {
  process.env.S4_FAKE_API_KEY = "fake-key-value-0123456789";
  process.env.S4_BASE_URL_TOKEN = "https://api.example.com/v1"; // URL 形态不当密钥
  const input = [
    `key=${process.env.S4_FAKE_API_KEY}`,
    `-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----`,
    `"Authorization": "Bearer github_pat_FAKE0000000000000000000000000000000000"`,
    `anthropic sk-ant-oat01-${"a".repeat(40)}`,
    `deepseek sk-${"b".repeat(32)}`,
    `const token = getToken();`,
    `base https://api.example.com/v1`,
  ].join("\n");
  const out = redactOutput(input);
  assert.ok(!out.includes(process.env.S4_FAKE_API_KEY!));
  assert.ok(!out.includes("MIIabc"));
  assert.ok(!out.includes("github_pat_FAKE"));
  assert.ok(!out.includes("a".repeat(40)) && !out.includes("b".repeat(32)));
  assert.ok(out.includes("const token = getToken();"), "ordinary code is untouched");
  assert.ok(out.includes("base https://api.example.com/v1"), "URL-shaped config values are not secrets");
});

test("S4: Read shows the scrubbed text, and Write/Edit refuse to put a [REDACTED…] marker back over the real secret", async () => {
  const bearer = `Bearer ${"t".repeat(40)}`;
  const f = put(ws, "client.ts", `export const auth = "${bearer}";\nexport const x = 1;\n`);
  const c = ctx("workspace");
  const r = await run(readTool, { path: f }, c);
  assert.equal(r.ok, true);
  assert.ok(!text(r).includes("t".repeat(40)) && text(r).includes("[REDACTED]"));
  // 整份写回：模型只见过脱敏文本。
  const back = `export const auth = "Bearer [REDACTED]";\nexport const x = 2;\n`;
  const w = await run(writeTool, { path: f, content: back }, c);
  assert.equal(w.ok, false);
  assert.match(text(w), /REDACTED/);
  // Edit：新内容引入标记被拒；old_string 抄了标记给出明确解释。
  const e1 = await run(editTool, { path: f, old_string: "export const x = 1;", new_string: "export const x = 1; // [REDACTED]" }, c);
  assert.equal(e1.ok, false);
  const e2 = await run(editTool, { path: f, old_string: `"Bearer [REDACTED]"`, new_string: `"Bearer x"` }, c);
  assert.equal(e2.summary, "redacted text");
  // 避开密钥行的正常修改照样能做，磁盘上的真令牌原封不动。
  const e3 = await run(editTool, { path: f, old_string: "export const x = 1;", new_string: "export const x = 2;" }, c);
  assert.equal(e3.ok, true, text(e3));
  assert.ok(fs.readFileSync(f, "utf8").includes("t".repeat(40)));
});
