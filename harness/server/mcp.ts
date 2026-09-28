// E1（G6、K58、X57）：MCP 客户端 MVP——扩展中心勾给 dimensio 的连接器（stdio / http / sse）。
//
// 修前：dimensio 是三个 agent 里唯一没有 MCP 的——扩展中心里连接器那一格对它是灰的。
// 做法（kimi 修订版 G6）：
//   · 进程级共享池：一个连接器一条连接（按扩展 id），配置或凭据变了就换新连接；建连有时限，一个连不上只跳过它，
//     不拖别的、不拖会话创建。凭据（env / 请求头的值）在 bridge 的加密存储里，这里按需解开、只在内存里用、从不打印。
//   · 会话基线：建会话时拍下「此刻连上的连接器 + 各自的工具定义」随会话落盘（见 tools/mcp.ts）；会话里的工具清单从此
//     不变（前缀缓存不断），重启读回也照旧。之后装的连接器、服务端新出的工具，下一个新会话才有。
//   · 墓碑：会话建好之后连接器被删了、停了、对 dimensio 取消勾选——工具定义照旧留着，调用时回「已移除，新会话生效」。
//   · 不做：OAuth（扩展中心本身只有静态请求头 / 环境变量，#107 待定）、resources / prompts、sampling、elicitation。
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { textTokens } from "./agent/context.ts";
import { managedConnectors, managedExtensionRoots, type ManagedConnector } from "./extensions.ts";
import { killOwnChildTree } from "./proc-tree.ts";

export const CONNECT_TIMEOUT_MS = 20_000;
export const CALL_TIMEOUT_MS = 120_000; // 两次进度之间最多等这么久（有进度就续）
export const CALL_MAX_TOTAL_MS = 15 * 60_000;
const RETRY_FAILED_AFTER_MS = 60_000; // 连不上的，建新会话时隔一分钟才再试（别每建一个会话就打一遍挂了的服务）
const RECONNECT_ON_CALL_AFTER_MS = 5_000; // 调用时发现断了：上次失败超过 5 秒就当场重连一次
const MAX_TOOLS = 500;

export interface McpToolInfo {
  name: string; // 服务端的工具名（原样）
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean; // annotations.readOnlyHint === true
  title?: string;
}

interface Creds {
  env: Record<string, string>;
  headers: Record<string, string>;
}

interface Entry {
  cfg: ManagedConnector;
  creds: Creds;
  hash: string;
  status: "connecting" | "ready" | "failed";
  client: Client | null;
  pid: number | null; // stdio 子进程
  tools: McpToolInfo[];
  instructions?: string;
  error?: string;
  at: number;
  ready: Promise<void>;
}

const pool = new Map<string, Entry>(); // 扩展 id → 连接

// ── 凭据（bridge 的加密存储：AES-256-GCM 密文 + DPAPI 包住的数据密钥，见 src/extension-secrets.mjs）────────────
type SecretsReader = (extRoot: string) => Record<string, { env?: Record<string, string>; headers?: Record<string, string> }>;
let secretsReader: SecretsReader | null = null;
async function readSecretsFn(): Promise<SecretsReader> {
  if (secretsReader) return secretsReader;
  const mod = (await import(new URL("../../src/extension-secrets.mjs", import.meta.url).href)) as { readSecrets: SecretsReader };
  secretsReader = mod.readSecrets;
  return secretsReader;
}
// 测试用：换掉凭据来源（假令牌），不碰真实的加密存储
export function setMcpSecretsReaderForTests(fn: SecretsReader | null): void {
  secretsReader = fn;
}

const pick = (from: Record<string, string> | undefined, keys: string[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of keys) if (typeof from?.[k] === "string") out[k] = from[k];
  return out;
};

async function credsFor(cfgs: ManagedConnector[]): Promise<Map<string, Creds | { error: string }>> {
  const out = new Map<string, Creds | { error: string }>();
  const needs = cfgs.filter((c) => c.envKeys.length || c.headerKeys.length);
  let all: ReturnType<SecretsReader> = {};
  let failed = "";
  if (needs.length) {
    try {
      const root = managedExtensionRoots()[0];
      if (!root) throw new Error("找不到扩展目录");
      all = (await readSecretsFn())(root);
    } catch (e) {
      failed = `凭据解不开（${String((e as Error).message).slice(0, 120)}）`;
    }
  }
  for (const c of cfgs) {
    const needsCreds = c.envKeys.length || c.headerKeys.length;
    if (needsCreds && failed) out.set(c.id, { error: failed });
    else out.set(c.id, { env: pick(all[c.id]?.env, c.envKeys), headers: pick(all[c.id]?.headers, c.headerKeys) });
  }
  return out;
}

// 配置指纹（含凭据——只取哈希，不落盘、不打印）
function fingerprint(cfg: ManagedConnector, creds: Creds): string {
  const h = createHash("sha256");
  h.update(JSON.stringify([cfg.transport, cfg.command ?? "", cfg.args ?? [], cfg.url ?? "", creds.env, creds.headers]));
  return h.digest("hex").slice(0, 16);
}

// 报错里别带出地址里的查询串（有的服务把令牌放在 URL 上）
export function redact(msg: string): string {
  return String(msg ?? "")
    .replace(/(https?:\/\/[^\s?#"']+)\?[^\s"']*/gi, "$1?…")
    .replace(/(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1…")
    .slice(0, 300);
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what}: no answer within ${Math.round(ms / 1000)}s`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function makeTransport(cfg: ManagedConnector, creds: Creds): Transport {
  if (cfg.transport === "stdio") {
    return new StdioClientTransport({
      command: cfg.command!,
      args: cfg.args ?? [],
      // SDK 在这上面叠一层安全的默认变量（PATH、SystemRoot……）；harness 自己的密钥变量不传下去
      env: creds.env,
      stderr: "ignore",
    });
  }
  const requestInit: RequestInit = Object.keys(creds.headers).length ? { headers: creds.headers } : {};
  const url = new URL(cfg.url!);
  // 请求头（凭据）两种 HTTP 传输都从 requestInit 带上（SSE 的事件流与 POST 都用它）
  return cfg.transport === "sse" ? new SSEClientTransport(url, { requestInit }) : new StreamableHTTPClientTransport(url, { requestInit });
}

function toolInfo(t: { name: string; title?: string; description?: string; inputSchema?: unknown; annotations?: { readOnlyHint?: boolean; title?: string } }): McpToolInfo {
  const title = t.title ?? t.annotations?.title;
  return {
    name: String(t.name),
    description: String(t.description ?? title ?? "").slice(0, 2_000),
    inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? (t.inputSchema as Record<string, unknown>) : { type: "object" },
    readOnly: t.annotations?.readOnlyHint === true,
    ...(title && title !== t.name ? { title: String(title).slice(0, 120) } : {}),
  };
}

async function listAllTools(client: Client): Promise<McpToolInfo[]> {
  const out: McpToolInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20 && out.length < MAX_TOOLS; page++) {
    const r = await withTimeout(client.listTools(cursor ? { cursor } : undefined), CONNECT_TIMEOUT_MS, "tools/list");
    for (const t of r.tools ?? []) if (out.length < MAX_TOOLS) out.push(toolInfo(t));
    cursor = r.nextCursor;
    if (!cursor) break;
  }
  return out;
}

function connect(cfg: ManagedConnector, creds: Creds, hash: string): Entry {
  const entry: Entry = { cfg, creds, hash, status: "connecting", client: null, pid: null, tools: [], at: Date.now(), ready: Promise.resolve() };
  entry.ready = (async () => {
    let client: Client | null = null;
    try {
      const transport = makeTransport(cfg, creds);
      client = new Client({ name: "dimensio", version: "1.0.0" }, { capabilities: {} });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "connect");
      entry.pid = transport instanceof StdioClientTransport ? transport.pid : null;
      entry.client = client;
      entry.instructions = client.getInstructions()?.slice(0, 1_000) || undefined;
      entry.tools = await listAllTools(client);
      entry.status = "ready";
      entry.error = undefined;
      client.onclose = () => {
        entry.pid = null; // S11：子进程已经没了——之后别再按这个 PID 动手（可能已被别的进程复用）
        if (entry.status !== "ready") return;
        entry.status = "failed";
        entry.error = "connection closed";
        entry.client = null;
        entry.at = Date.now();
      };
    } catch (e) {
      entry.status = "failed";
      entry.error = redact((e as Error).message);
      const stale = client;
      entry.client = null;
      void stale?.close().catch(() => {});
      console.warn(`[mcp] ${cfg.name}: ${entry.error}`);
    }
    entry.at = Date.now();
  })();
  return entry;
}

async function closeEntry(e: Entry): Promise<void> {
  const { client, pid } = e;
  e.status = "failed";
  e.error = "closed";
  e.client = null;
  e.pid = null;
  // stdio：趁根进程还在先按树收（npx → cmd → node 这种套娃，只结束根会留下孙子进程）。S11：先核对那个 PID 还是
  // 本进程的子进程（它可能早退出了、PID 被复用），不是就不动
  if (pid) await killOwnChildTree(pid).catch(() => []);
  await client?.close().catch(() => {});
}

// 注册表 → 池：新连接器开始连、配置或凭据变了的换新连接、删掉 / 取消勾选的关掉。建连不等（mcpReady 另等）。
let syncing: Promise<void> | null = null;
export function syncConnectors(): Promise<void> {
  syncing ??= (async () => {
    try {
      const cfgs = managedConnectors();
      const keep = new Set(cfgs.map((c) => c.id));
      for (const [id, e] of pool) {
        if (keep.has(id)) continue;
        pool.delete(id);
        void closeEntry(e);
      }
      if (!cfgs.length) return;
      const creds = await credsFor(cfgs);
      for (const cfg of cfgs) {
        const c = creds.get(cfg.id)!;
        const cur = pool.get(cfg.id);
        if ("error" in c) {
          if (cur) void closeEntry(cur);
          pool.set(cfg.id, { cfg, creds: { env: {}, headers: {} }, hash: "", status: "failed", client: null, pid: null, tools: [], error: c.error, at: Date.now(), ready: Promise.resolve() });
          continue;
        }
        const hash = fingerprint(cfg, c);
        if (cur && cur.hash === hash && (cur.status !== "failed" || Date.now() - cur.at < RETRY_FAILED_AFTER_MS)) {
          cur.cfg = cfg; // 名字、说明、key 这类不影响连接的字段跟着改
          continue;
        }
        if (cur) void closeEntry(cur);
        pool.set(cfg.id, connect(cfg, c, hash));
      }
    } catch (e) {
      console.warn(`[mcp] sync: ${redact((e as Error).message)}`);
    }
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

// 还在连的最多再等 ms（新会话建基线前用；都连好了立刻返回）
export async function mcpReady(ms: number): Promise<void> {
  const pending = [...pool.values()].filter((e) => e.status === "connecting").map((e) => e.ready);
  if (!pending.length) return;
  await Promise.race([Promise.all(pending), new Promise((r) => setTimeout(r, ms).unref?.())]);
}

// 新会话用：此刻连上、有工具的连接器（按名字排，基线规划见 tools/mcp.ts）
export interface ReadyConnector {
  cfg: ManagedConnector;
  tools: McpToolInfo[];
  instructions?: string;
}
export function readyConnectors(): ReadyConnector[] {
  return [...pool.values()]
    .filter((e) => e.status === "ready" && e.tools.length)
    .sort((a, b) => a.cfg.name.localeCompare(b.cfg.name))
    .map((e) => ({ cfg: e.cfg, tools: e.tools, ...(e.instructions ? { instructions: e.instructions } : {}) }));
}

// 网关用：连接器此刻的工具（按扩展 id；没连上 / 不在了返回 null）
export function liveTools(id: string): McpToolInfo[] | null {
  const e = pool.get(id);
  return e?.status === "ready" ? e.tools : null;
}

export function toolCost(tools: McpToolInfo[]): number {
  return textTokens(JSON.stringify(tools.map((t) => [t.name, t.description, t.inputSchema])));
}

export type McpCallOutcome =
  | { kind: "removed" }
  | { kind: "unavailable"; error: string }
  | { kind: "result"; result: CallToolResult };

// 调一次工具。连接器不在池里（删了 / 停了 / 取消勾选）= 墓碑；断了且上次失败超过 5 秒，当场重连一次。
export async function callMcpTool(
  id: string,
  tool: string,
  args: Record<string, unknown>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<McpCallOutcome> {
  let e = pool.get(id);
  if (!e) {
    await syncConnectors();
    e = pool.get(id);
    if (!e) return { kind: "removed" };
  }
  if (e.status === "failed" && e.hash && Date.now() - e.at > RECONNECT_ON_CALL_AFTER_MS) {
    void closeEntry(e);
    e = connect(e.cfg, e.creds, e.hash);
    pool.set(id, e);
  }
  if (e.status === "connecting") await withTimeout(e.ready, CONNECT_TIMEOUT_MS + 1_000, "connect").catch(() => {});
  if (e.status !== "ready" || !e.client) return { kind: "unavailable", error: e.error ?? "not connected" };
  const result = (await e.client.callTool({ name: tool, arguments: args }, undefined, {
    ...(opts.signal ? { signal: opts.signal } : {}),
    timeout: opts.timeoutMs ?? CALL_TIMEOUT_MS,
    resetTimeoutOnProgress: true,
    maxTotalTimeout: CALL_MAX_TOTAL_MS,
  })) as CallToolResult;
  return { kind: "result", result };
}

// 诊断 / 状态（GET /api/mcp）：不含凭据、不含命令行与地址
export function mcpStatus(): Array<{ id: string; key: string; name: string; transport: string; status: string; tools: number; error?: string }> {
  return [...pool.values()].map((e) => ({
    id: e.cfg.id,
    key: e.cfg.key,
    name: e.cfg.name,
    transport: e.cfg.transport,
    status: e.status,
    tools: e.tools.length,
    ...(e.error ? { error: e.error } : {}),
  }));
}

// 进程退出时（同步）：stdio 子进程直接结束根（管道一断，守规矩的服务自己也会退）。只动还连着的（子进程退出时 onclose
// 已把 PID 清掉；退出路径同步、查不了进程表，这是能做的复核）
export function killAllMcpSync(): void {
  for (const e of pool.values()) {
    if (!e.pid || e.status !== "ready") continue;
    try {
      process.kill(e.pid);
    } catch {
      /* 已经没了 */
    }
  }
}

// 测试用：stdio 连接器子进程的 PID（核对「删掉连接器就收掉子进程」）
export function mcpPidForTests(id: string): number | null {
  return pool.get(id)?.pid ?? null;
}

// 测试用：清池（关掉全部连接）
export async function resetMcpPoolForTests(): Promise<void> {
  const all = [...pool.values()];
  pool.clear();
  await Promise.all(all.map((e) => closeEntry(e)));
}
