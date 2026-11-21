// 工具中枢 · 远程连接器：扩展中心里勾了 Antigravity 的 http / sse 连接器，由 bridge 服务端用 MCP 客户端代连。
//
// agy 的 ACP 只收 stdio 的 mcpServers，所以远程服务的工具并进 bridge 自己那个工具服务：对外名 ext_<连接器>_<工具>
// （小写字母、数字、下划线），调用时现连现调。这类工具一律照常走审批（approval.mjs 不放行 ext_*）。
//
// 鉴权：
//   · 连接器里配的静态请求头（含自己写的 Authorization）原样带上；免鉴权的直接连；
//   · 靠 OAuth 的：令牌是 Claude CLI 授权时存在它配置目录 .credentials.json 里的（mcpOAuth[服务名|配置哈希]），
//     这里只读不续（续期是 CLI 的事，两边一起续会抢同一个刷新令牌）。没过期就带上；过期了明确报「去扩展中心重新授权」。
//
// 清单：列工具要连网，每个连接器限时 6 秒、并行取，成功的缓存 5 分钟；连不上的这次就不列（agy 只在启动时取一次清单）。
// 指纹（sig）= 连接器 id + 改动时间 + 有没有令牌：改了配置或刚授权完，agy 常驻进程空闲时重启、重新取清单。

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { agyRemoteConnectors } from '@bridge/core/extensions.mjs';
import { readMcpToken } from '@bridge/core/runtime/mcp-probe.mjs';

const PREFIX = 'ext_';
const LIST_TIMEOUT_MS = 6_000;
const LIST_TTL_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 140_000;
const REAUTH = '去 设置 › 扩展中心 › 连接器 里给它重新授权（或在 Claude 分页里用一次它，CLI 会自己续期），然后再调';

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
const exposed = (conn, tool) => (PREFIX + slug(conn.server || conn.name) + '_' + slug(tool)).slice(0, 60).replace(/_+$/, '');

let tokenReader = readMcpToken;
export function _setTokenReaderForTest(fn) { tokenReader = fn || readMcpToken; }

const hasAuthHeader = (h) => Object.keys(h || {}).some((k) => k.toLowerCase() === 'authorization');

/** 连这个连接器要带的请求头；令牌过期返回 { error }。 */
export function authHeaders(ctx, conn, now = Date.now()) {
  const headers = { ...(conn.config.headers || {}) };
  if (hasAuthHeader(headers)) return { headers };
  const tok = tokenReader(ctx, conn.server, conn.config);
  if (!tok) return { headers, oauth: false };
  if (tok.expiresAt && tok.expiresAt <= now + 30_000) return { error: `连接器「${conn.name}」的登录已过期：${REAUTH}。` };
  return { headers: { ...headers, Authorization: `Bearer ${tok.accessToken}` }, oauth: true };
}

async function withRemote(ctx, conn, fn, { timeoutMs, signal } = {}) {
  const auth = authHeaders(ctx, conn);
  if (auth.error) throw new Error(auth.error);
  const url = new URL(conn.config.url);
  const opts = { requestInit: { headers: auth.headers } };
  const transport = conn.config.type === 'sse' ? new SSEClientTransport(url, opts) : new StreamableHTTPClientTransport(url, opts);
  const client = new Client({ name: 'bridge-agy', version: '1.0.0' });
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  signal?.addEventListener?.('abort', onAbort, { once: true });
  let timer = null;
  try {
    const job = (async () => { await client.connect(transport); return fn(client, ac.signal); })();
    const limit = new Promise((_, rej) => { timer = setTimeout(() => { ac.abort(); rej(new Error(`连接器「${conn.name}」${Math.round(timeoutMs / 1000)} 秒没有回应`)); }, timeoutMs); timer.unref?.(); });
    return await Promise.race([job, limit]);
  } catch (e) {
    const m = String(e?.message || e);
    if (/\b401\b|unauthori[sz]ed|invalid_token/i.test(m)) throw new Error(`连接器「${conn.name}」要求登录${auth.oauth ? '（带着的令牌被拒了）' : ''}：${REAUTH}。`);
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
    try { await client.close(); } catch {}
  }
}

const listCache = new Map();   // 连接器 id → { at, sig, tools }
const connSig = (ctx, c) => `${c.id}@${c.updated}:${tokenReader(ctx, c.server, c.config) ? 1 : 0}`;

async function connectorTools(ctx, conn) {
  const sig = connSig(ctx, conn);
  const hit = listCache.get(conn.id);
  if (hit && hit.sig === sig && Date.now() - hit.at < LIST_TTL_MS) return hit.tools;
  try {
    const tools = await withRemote(ctx, conn, async (c) => (await c.listTools()).tools || [], { timeoutMs: LIST_TIMEOUT_MS });
    listCache.set(conn.id, { at: Date.now(), sig, tools });
    return tools;
  } catch (e) {
    console.error(`[agy-hub] 远程连接器「${conn.name}」取工具失败：`, e?.message || e);
    return hit && hit.sig === sig ? hit.tools : [];
  }
}

/** 全部远程连接器的工具（MCP tools/list 形状，名字已换成对外名），附带反查表。 */
export async function listRemoteTools(ctx) {
  const conns = agyRemoteConnectors();
  const per = await Promise.all(conns.map(async (conn) => ({ conn, tools: await connectorTools(ctx, conn) })));
  const out = [];
  const seen = new Set();
  for (const { conn, tools } of per) {
    for (const t of tools) {
      if (!t || !t.name) continue;
      const name = exposed(conn, t.name);
      if (seen.has(name)) continue;
      seen.add(name);
      out.push({
        name,
        description: `[连接器 ${conn.name}] ${String(t.description || t.name)}`,
        inputSchema: t.inputSchema || { type: 'object', properties: {} },
        _remote: { id: conn.id, tool: t.name },
      });
    }
  }
  return out;
}

export async function callRemoteTool(ctx, exposedName, args, { signal } = {}) {
  const tools = await listRemoteTools(ctx);
  const hit = tools.find((t) => t.name === exposedName);
  if (!hit) return { isError: true, content: [{ type: 'text', text: `没有叫 ${exposedName} 的远程连接器工具（连接器可能停用了、没勾 Antigravity，或这次没连上）。` }] };
  const conn = agyRemoteConnectors().find((c) => c.id === hit._remote.id);
  if (!conn) return { isError: true, content: [{ type: 'text', text: '这个连接器已经不在了。' }] };
  try {
    return await withRemote(ctx, conn, (c, sig) => c.callTool({ name: hit._remote.tool, arguments: args || {} }, undefined, { signal: sig, timeout: CALL_TIMEOUT_MS }), { timeoutMs: CALL_TIMEOUT_MS, signal });
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: String(e?.message || e).slice(0, 800) }] };
  }
}

export const REMOTE_GROUP = Object.freeze({
  key: 'remote',
  setting: 'remoteConnectors',
  bare: true,
  available: (ctx) => ctx?.kind === 'admin' && !ctx?.sandbox && agyRemoteConnectors().length > 0,
  sig: (ctx) => agyRemoteConnectors().map((c) => connSig(ctx, c)).sort().join(','),
  owns: (name) => name.startsWith(PREFIX),
  list: (ctx) => listRemoteTools(ctx),
  call: (ctx, gen, name, args, { signal } = {}) => callRemoteTool(ctx, name, args, { signal }),
});

export function _resetRemoteCacheForTest() { listCache.clear(); }
