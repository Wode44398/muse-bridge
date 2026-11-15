// Claude 分页的提示缓存寿命与空闲压缩（2026-11-14）。
//
// 设置 › Claude › 对话 › 「提示缓存快过期时」（claude-settings 的 cacheExpiry）：
//   off     不提示
//   hint    只提示：对话空闲过了缓存寿命，用量环右上角亮一颗反色小点（前端 QuotaRing 按 usage.cacheTtlMin + usage.at 算）
//   compact 自动压缩：长对话在缓存过期前，由服务端替用户发一次 /compact（同时照样提示）
//
// 缓存寿命（claudeCacheTtl）：订阅号 CLI 默认 1 小时；官方 Anthropic 端点我们注了 CLAUDE_CODE_PROMPT_CACHE_TTL=1h
//（claude-providers-proxy.mjs）；其余自定义服务按上游主机 / 型号认厂商，模型中心里用户填的优先（model-knowledge/cache-ttl.mjs）。
// 结果随 ctx_usage 落进用量记录（usage.cacheTtlMin），前端与这里都读它。
//
// 空闲压缩：一轮收尾时排定时器（1 小时缓存提前 6 分钟、短缓存在四分之三处），这个会话再开一轮就撤掉；到点时会话还空闲、
// 对话部分（Messages 类别）够大，就重放一条 /api/chat 发 /compact（family origin 'idle-compact'：不发完成通知、不顶掉正在跑的轮）。
// 只在内存里：服务重启后这一轮的定时器就没了，等下一轮收尾再排。
import { cacheTtl, vendorOf } from '../model-knowledge/index.mjs';
import { isCustomModelId, resolveCustomModel, upstreamHost } from './claude-providers.mjs';
import { isOfficial } from './claude-providers-transform.mjs';
import { replayChat } from './claude-queue.mjs';
import { findGenBySession } from './gen.mjs';
import { getContextUsage } from './ctx-usage.mjs';
import { chatPrefsFor } from './chat-prefs.mjs';

/**
 * Claude 分页里这个模型的提示缓存多久变冷 → { minutes: number|null, source }。
 * model：会话用的模型（内置别名 / claude-* / custom:<服务>:<型号>；空 = 默认模型，走订阅号）；owner：自定义服务注册表的属主。
 */
export function claudeCacheTtl(model, owner) {
  if (!isCustomModelId(model)) return { minutes: 60, source: 'request' };   // 订阅号：CLI 默认 1 小时
  let r = null;
  try { r = owner ? resolveCustomModel(model, owner) : null; } catch { r = null; }
  if (!r) return { minutes: null, source: 'default' };
  const { provider, model: m } = r;
  const anthropicWire = provider.protocol === 'anthropic';
  const caching = !!(provider.compat && provider.compat.promptCaching);
  // Claude 型号只在请求带 cache_control 时才缓存：Anthropic 协议的服务关着「提示缓存」（CLI 收到 DISABLE_PROMPT_CACHING）就没有缓存。
  // 别家的 Anthropic 兼容端点（DeepSeek、Kimi、小米……）自己自动缓存，照厂商算
  if (m.cacheTtl === undefined && anthropicWire && !caching && vendorOf(m.id) === 'anthropic') return { minutes: null, source: 'request' };
  const official = anthropicWire && caching && isOfficial(provider);
  const out = cacheTtl(m.id, { host: upstreamHost(provider), user: m.cacheTtl, requestMinutes: official ? 60 : undefined });
  return { minutes: out.minutes, source: out.source };
}

// —— 空闲压缩 ——
const LEAD_MS = 6 * 60_000;          // 长缓存：比过期早这么久动手（压缩本身要一两分钟）
const MIN_TTL_MS = 3 * 60_000;       // 缓存短于这个的不做（来不及）
const MIN_MESSAGES = 80_000;         // 对话部分（Messages 类别）至少这么大才压：系统提示 + 工具定义压不掉
const timers = new Map();            // key|sid -> timeout
const K = (key, sid) => key + '|' + sid;

/** 什么时候动手（与 dimensio 的 idle-compact.ts 同一条公式）。 */
export const idleDelay = (ttlMs) => Math.max(60_000, Math.max(ttlMs - LEAD_MS, Math.round(ttlMs * 0.75)));

/** 用量记录里对话部分（Messages 类别）有多少 token；没有分布时退到总量减掉系统那几块的估计 0。 */
export function messageTokens(usage) {
  if (!usage || !Array.isArray(usage.categories)) return 0;
  const c = usage.categories.find((x) => /^messages$/i.test(String(x.name || '')));
  return c ? Number(c.tokens) || 0 : 0;
}

/** 这个会话要开一轮了（任何来源）：撤掉它的空闲压缩定时器。 */
export function cancelClaudeIdleCompact(key, sid) {
  if (!sid) return;
  const k = K(key, sid);
  const t = timers.get(k);
  if (t) { clearTimeout(t); timers.delete(k); }
}

/**
 * 一轮收尾：按设置与缓存寿命排一次空闲压缩。
 * mode：设置 cacheExpiry 的值；replay：这一轮的请求身份（limitReplay，{ headers, url, body }）；ttlMin：claudeCacheTtl 的分钟数。
 */
export function scheduleClaudeIdleCompact({ key, sid, mode, replay, ttlMin, ctx }) {
  cancelClaudeIdleCompact(key, sid);
  if (mode !== 'compact' || !sid || !replay || !replay.headers || !ttlMin) return false;
  const ttl = ttlMin * 60_000;
  if (ttl < MIN_TTL_MS) return false;
  const k = K(key, sid);
  const endedAt = Date.now();
  const t = setTimeout(() => { timers.delete(k); void fire({ key, sid, replay, ctx, endedAt }); }, idleDelay(ttl));
  t.unref?.();
  timers.set(k, t);
  return true;
}

async function fire({ key, sid, replay, ctx, endedAt }) {
  const g = findGenBySession(key, sid);
  if (g && !g.done) return;                                   // 在跑（别的入口开了一轮但没撤到定时器）
  const usage = getContextUsage(key, sid);
  if (!usage || (usage.at && usage.at > endedAt + 1000)) return;   // 收尾之后又有过一轮：那一轮会自己排
  if (messageTokens(usage) < MIN_MESSAGES) return;
  const p = (ctx && chatPrefsFor(ctx, sid)) || {};
  const b = (replay && replay.body) || {};
  const body = {
    agent: 'claude', client: b.client === 'apk' ? 'apk' : 'web',
    ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}), ...(p.fast ? { fast: true } : {}),
    sessionId: sid, message: '/compact', attachments: [], autoRetry: true,
  };
  try {
    const r = await replayChat({ headers: replay.headers, url: replay.url || '/api/chat', body, family: { origin: { kind: 'idle-compact', from: [] }, noPreempt: true } });
    const idleMin = Math.round((Date.now() - endedAt) / 60_000);
    if (!r || !r.status || r.status >= 400) console.log(`[idle-compact] claude ${sid.slice(0, 8)} not started: status ${r && r.status}`);
    else console.log(`[idle-compact] claude ${sid.slice(0, 8)} idle ${idleMin} min: /compact (messages ${messageTokens(usage)} tokens)`);
  } catch (e) {
    console.log(`[idle-compact] claude ${sid.slice(0, 8)}: ${(e && e.message) || e}`);
  }
}

export const _claudeIdleTimers = timers;
export function _fireClaudeIdleCompact(o) { return fire(o); }
