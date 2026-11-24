// agy 各模型真实有效上下文上限：
// agy acp 的 usage_update.size 报的是模型原生窗口（如 Gemini 4 报 1,048,576），但内嵌 language server
// 实际按各模型的 CASCADE_USE_EXPERIMENT_CHECKPOINTER.max_token_limit 触发自动压缩（与会话轨迹里
// contextWindowMetadata.maxContextTokens 一致，如 Gemini 4 = 512k、3.8 Flash = 256k、Claude 4.6 = 160k、GPT-OSS = 80k）。
// 优先从内嵌 language server 的 GetAvailableModels 实时读取（本机缓存 1–2ms、不联网、不耗额度），
// 端口未就绪或不可达时回退到静态兜底表，保证界面占比与上限数字对得上真实压缩线。

import { findLanguageServerPort, clearLanguageServerPortCache } from './quota.mjs';

const RPC = 'exa.language_server_pb.LanguageServerService/GetAvailableModels';
const CACHE_TTL_MS = 5 * 60_000;
const ERROR_RETRY_MS = 10_000;

const EFFORT_SUFFIX_RE = /^(.*?)(?:-(?:tiered|thinking))?-(xhigh|high|medium|low|max|minimal)$/i;

// language server 端口尚未就绪时的兜底映射（与 GetAvailableModels 实测一致）；
// 只要在线读到了实时表，一律以实时表为准，避免上游提额后被旧兜底表锁死。
export const FALLBACK_MODEL_CONTEXT_LIMITS = Object.freeze({
  'gemini-4-neon': 512_000,
  'gemini-4-carbon': 512_000,
  'gemini-4-argon': 512_000,
  'gemini-4-hydrogen': 512_000,
  'gemini-pro-orchestrator': 512_000,
  'gemini-pro-orchestrator-neon': 512_000,
  'gemini-pro-orchestrator-argon': 512_000,
  'gemini-flash-worker-agy': 512_000,
  'gemini-3.8-flash': 256_000,
  'gemini-3-8-flash': 256_000,
  'gemini-3-flash': 128_000,
  'gemini-3.1-flash-lite': 128_000,
  'gemini-3.5-flash-lite': 128_000,
  'gemini-2.5-pro': 128_000,
  'gemini-2.5-flash': 128_000,
  'gemini-2.5-flash-lite': 128_000,
  'gemini-2.5-flash-thinking': 128_000,
  'claude-opus-4-6-thinking': 160_000,
  'claude-opus-4-6': 160_000,
  'claude-sonnet-4-6': 160_000,
  'claude-sonnet-4-6-thinking': 160_000,
  'gpt-oss-120b-medium': 80_000,
  'gpt-oss-120b': 80_000,
});

// client -> { pid, limits, at, errorAt, inflight }
let clientCaches = new WeakMap();

export function normalizeModelKey(raw = '') {
  return String(raw || '').trim().toLowerCase();
}

export function baseModelKey(raw = '') {
  const norm = normalizeModelKey(raw);
  if (!norm) return '';
  const m = EFFORT_SUFFIX_RE.exec(norm);
  const stripped = (m && m[1] ? m[1] : norm).replace(/-tiered$/i, '');
  return stripped;
}

function modelAliases(raw = '') {
  const keys = [];
  const add = (k) => { if (k && !keys.includes(k)) keys.push(k); };
  const exact = normalizeModelKey(raw);
  const base = baseModelKey(exact);
  add(exact);
  add(base);
  // 兼容连字符与小数点写法（gemini-3-8-flash <-> gemini-3.8-flash）
  for (const k of [...keys]) {
    const dotted = k.replace(/^(gemini-\d+)-(\d+)(-|$)/, '$1.$2$3');
    const dashed = k.replace(/^(gemini-\d+)\.(\d+)(-|$)/, '$1-$2$3');
    add(dotted);
    add(dashed);
  }
  return keys;
}

function parsePositiveInt(val) {
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// 从 GetAvailableModels 响应提取每个模型的真实有效上限（优先 checkpointer.max_token_limit，未启用时退回 maxTokens）
export function parseAvailableModelLimits(resp) {
  const models = resp?.response?.models || resp?.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return {};
  const exactMap = {};
  const baseMap = {};

  for (const [rawId, info] of Object.entries(models)) {
    if (!info || typeof info !== 'object') continue;
    const maxTokens = parsePositiveInt(info.maxTokens ?? info.max_tokens);
    let cpLimit = 0;
    const cpRaw = info?.modelExperiments?.experiments?.CASCADE_USE_EXPERIMENT_CHECKPOINTER?.stringValue;
    if (typeof cpRaw === 'string' && cpRaw.trim()) {
      try {
        const cp = JSON.parse(cpRaw);
        if (cp && cp.enabled !== false) {
          cpLimit = parsePositiveInt(cp.max_token_limit ?? cp.maxTokenLimit);
        }
      } catch {}
    }

    const effective = cpLimit > 0
      ? (maxTokens > 0 ? Math.min(maxTokens, cpLimit) : cpLimit)
      : maxTokens;
    if (!effective) continue;

    const exact = normalizeModelKey(rawId);
    if (exact) exactMap[exact] = effective;

    const base = baseModelKey(exact);
    if (base && base !== exact) {
      baseMap[base] = baseMap[base] ? Math.max(baseMap[base], effective) : effective;
    }
  }

  return { ...baseMap, ...exactMap };
}

export function lookupModelContextLimit(model, { thoughtLevel = '', liveLimits = null, useFallback = true } = {}) {
  const id = normalizeModelKey(model);
  if (!id) return null;
  const tl = normalizeModelKey(thoughtLevel);
  const candidates = [];
  if (tl) {
    for (const k of modelAliases(`${id}-${tl}`)) {
      if (!candidates.includes(k)) candidates.push(k);
    }
  }
  for (const k of modelAliases(id)) {
    if (!candidates.includes(k)) candidates.push(k);
  }

  if (liveLimits && typeof liveLimits === 'object') {
    for (const k of candidates) {
      const v = parsePositiveInt(liveLimits[k]);
      if (v > 0) return v;
    }
  }
  if (useFallback) {
    for (const k of candidates) {
      const v = parsePositiveInt(FALLBACK_MODEL_CONTEXT_LIMITS[k]);
      if (v > 0) return v;
    }
  }
  return null;
}

export function resolveEffectiveContextUsage(rawUsage, { model = '', thoughtLevel = '', liveLimits = null } = {}) {
  if (!rawUsage || typeof rawUsage !== 'object') return null;
  const rawSize = parsePositiveInt(rawUsage.rawSize ?? rawUsage.size);
  const used = Math.max(0, Number(rawUsage.used) || 0);
  if (!rawSize && !used) return null;

  const limit = lookupModelContextLimit(model, { thoughtLevel, liveLimits });
  const size = limit || rawSize;
  if (!size) return null;

  return {
    used,
    size,
    ...(rawSize && rawSize !== size ? { rawSize } : {}),
  };
}

function cacheOf(client) {
  let c = clientCaches.get(client);
  if (!c) {
    c = { pid: null, limits: null, at: 0, errorAt: 0, inflight: null };
    clientCaches.set(client, c);
  }
  const pid = client?.status?.()?.pid || null;
  if (pid && c.pid && c.pid !== pid) {
    c.pid = pid;
    c.limits = null;
    c.at = 0;
    c.errorAt = 0;
    c.inflight = null;
  }
  return c;
}

export function peekAgyContextLimits(client) {
  if (!client || typeof client !== 'object') return null;
  const c = cacheOf(client);
  return c.limits;
}

async function fetchOnce(client, timeoutMs = 3000) {
  const port = findLanguageServerPort(client);
  if (!port) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/${RPC}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const parsed = parseAvailableModelLimits(await r.json());
    return Object.keys(parsed).length ? parsed : null;
  } catch {
    clearLanguageServerPortCache(client);
    return null;
  }
}

export async function getAgyContextLimits(client, { force = false, timeoutMs = 3000 } = {}) {
  if (!client || typeof client !== 'object') return null;
  const c = cacheOf(client);
  const now = Date.now();
  if (!force && c.limits && now - c.at < CACHE_TTL_MS) return c.limits;
  if (!force && !c.limits && c.errorAt && now - c.errorAt < ERROR_RETRY_MS) return null;
  if (c.inflight) return c.inflight;

  const pid = client?.status?.()?.pid || null;
  const task = fetchOnce(client, timeoutMs)
    .then((limits) => {
      if (limits) {
        c.pid = pid;
        c.limits = limits;
        c.at = Date.now();
        c.errorAt = 0;
        return limits;
      }
      // 端口还没出现（内嵌 language server 尚未懒启动）不计错误冷却，下次立刻再试
      if (findLanguageServerPort(client)) c.errorAt = Date.now();
      return c.limits;
    })
    .finally(() => {
      if (c.inflight === task) c.inflight = null;
    });

  c.inflight = task;
  return task;
}

export function warmAgyContextLimits(client) {
  if (!client || typeof client !== 'object') return;
  const c = cacheOf(client);
  const now = Date.now();
  if (c.inflight) return;
  if (c.limits && now - c.at < CACHE_TTL_MS) return;
  if (!c.limits && c.errorAt && now - c.errorAt < ERROR_RETRY_MS) return;
  getAgyContextLimits(client).catch(() => {});
}

export function _resetAgyContextLimitsForTest() {
  clientCaches = new WeakMap();
}
