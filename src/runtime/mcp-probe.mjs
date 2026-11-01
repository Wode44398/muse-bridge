// 扩展页「连接器」的状态与工具清单（官方 Customize › Connectors 同款控制面板的数据源）。
// 没有会话也要知道「连上没有、有哪些工具」：起一个只挂这些远程连接器的短命 CLI（spawnAuthQuery only 模式，
// 不带插件、不读用户 / 项目 / claude.ai 的 MCP），等它们不再 pending，读一次 mcpServerStatus 就收掉。
// 按身份缓存 1 分钟；授权完成（流程结局里带着最新状态与工具）直接写进缓存，不用再探。
// 断开连接 = 删掉 CLI 存在这个身份 CLAUDE_CONFIG_DIR/.credentials.json 里的 mcpOAuth 令牌（键 `服务名|配置哈希`）。
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnAuthQuery } from './mcp-oauth-query.mjs';
import { claudeEngineEnv } from './claude-account.mjs';

const TTL_MS = 60_000;
const SETTLE_MS = 15_000;    // 远程服务握手 + 拉工具清单，最多等这么久
const cache = new Map();     // 身份 key → { at, map: { [连接器 id]: 状态 } }
const inflight = new Map();  // 身份 key → Promise（同一身份同时只探一次）

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => { const t = setTimeout(() => rej(new Error('timeout')), ms); if (t.unref) t.unref(); })]);

// CLI 的状态帧 → 前端要的样子（工具只留名字、描述、注解；MCP Apps 的 ui 元数据只记有没有）
export function slimStatus(s) {
  if (!s) return { status: 'unknown' };
  return {
    status: s.status,
    ...(s.error ? { error: String(s.error).slice(0, 400) } : {}),
    ...(s.serverInfo ? { serverInfo: { name: String(s.serverInfo.name || ''), version: String(s.serverInfo.version || '') } } : {}),
    tools: (Array.isArray(s.tools) ? s.tools : []).slice(0, 300).map((t) => ({
      name: String(t.name || ''),
      description: String(t.description || '').slice(0, 600),
      readOnly: !!t.annotations?.readOnly,
      destructive: !!t.annotations?.destructive,
      ui: !!(t._meta && (t._meta.ui || t._meta['ui/resourceUri'])),
    })).filter((t) => t.name),
  };
}

// 授权流程收尾时顺手记一份（流程结局里的 servers 就是刚连上那一刻的状态）
export function noteConnectorStatus(key, id, s, extra = {}) {
  const c = cache.get(key) || { at: Date.now(), map: {} };
  c.map[id] = { ...slimStatus(s), ...extra };
  cache.set(key, c);
}
export function forgetConnectorStatus(key, id) {
  const c = cache.get(key);
  if (c) { if (id) delete c.map[id]; else cache.delete(key); }
}

/**
 * @param ctx 身份
 * @param list [{ id, server, config }]（extensions.mjs remoteConnectorsForProbe）
 * @returns { [id]: { status, error?, serverInfo?, tools[] } }
 */
export async function probeConnectors(ctx, list, { force = false } = {}) {
  if (!list.length) return {};
  const key = ctx.key;
  const c = cache.get(key);
  if (!force && c && Date.now() - c.at < TTL_MS && list.every((x) => c.map[x.id])) return pick(c.map, list);
  if (inflight.has(key)) return pick(await inflight.get(key), list);
  const job = (async () => {
    const only = Object.fromEntries(list.map((x) => [x.server, x.config]));
    const { q, release } = await spawnAuthQuery(ctx, { only });
    try {
      if (typeof q.initializationResult === 'function') await withTimeout(q.initializationResult(), 60_000);
      const t0 = Date.now();
      let st = [];
      for (;;) {
        st = await withTimeout(q.mcpServerStatus(), 15_000);
        if (!st.some((s) => s && only[s.name] && s.status === 'pending') || Date.now() - t0 > SETTLE_MS) break;
        await sleep(400);
      }
      const map = { ...(cache.get(key)?.map || {}) };
      for (const x of list) map[x.id] = { ...slimStatus(st.find((s) => s && s.name === x.server)), oauth: hasMcpTokens(ctx, x.server) };
      cache.set(key, { at: Date.now(), map });
      return map;
    } finally { release(); }
  })();
  inflight.set(key, job);
  try { return pick(await job, list); } finally { inflight.delete(key); }
}
const pick = (map, list) => Object.fromEntries(list.map((x) => [x.id, map[x.id] || { status: 'unknown' }]));

// 这个身份的 CLI 配置目录（令牌就存在这里）
export function configDirOf(ctx) {
  const env = claudeEngineEnv(ctx) || process.env;
  return String(env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude');
}

function readCreds(ctx) {
  const f = path.join(configDirOf(ctx), '.credentials.json');
  if (!existsSync(f)) return { f, data: null };
  const raw = readFileSync(f, 'utf8');
  return { f, data: JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) };
}
// 存着令牌的 MCP 服务键（`服务名|配置哈希`）；读不出来就当没有。
// 注意 CLI 发起授权那一刻就会写一条（客户端注册信息 + 空的 accessToken），有真令牌才算「登录过」
function tokenKeys(ctx) {
  try {
    const { data } = readCreds(ctx);
    const all = data && data.mcpOAuth && typeof data.mcpOAuth === 'object' ? data.mcpOAuth : {};
    return Object.keys(all).filter((k) => all[k] && (all[k].accessToken || all[k].refreshToken));
  } catch { return []; }
}

export const hasMcpTokens = (ctx, server) => tokenKeys(ctx).some((k) => k === server || k.startsWith(server + '|'));

// 删掉某个服务名的全部 OAuth 令牌。返回删了几条（0 = 本来就没有，或令牌不在这个文件里——macOS 存钥匙串）。
export function clearMcpTokens(ctx, server) {
  const { f, data } = readCreds(ctx);
  if (!data) return 0;
  const all = data && typeof data.mcpOAuth === 'object' && data.mcpOAuth ? data.mcpOAuth : null;
  if (!all) return 0;
  const gone = Object.keys(all).filter((k) => k === server || k.startsWith(server + '|'));
  if (!gone.length) return 0;
  for (const k of gone) delete all[k];
  const tmp = f + '.' + process.pid + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, f);
  return gone.length;
}

// 测试用
export function _resetMcpProbe() { cache.clear(); inflight.clear(); }
