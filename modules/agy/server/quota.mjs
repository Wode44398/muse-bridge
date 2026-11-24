// agy 账号模型额度：常驻 `agy acp` 内嵌的 language server 在本机开着一个 HTTP 口（随机端口、不校验 CSRF），
// POST Connect JSON 到 RetrieveUserQuotaSummary 即得分组额度（2026-11-19 实测）：
//   { response: { groups: [{ displayName, description, buckets: [{ bucketId, displayName, window:'weekly'|'5h',
//     remainingFraction, resetTime }] }] } }
// - 端口只写在 `agy acp --log-file` 日志里：「Language server listening on random port at N for HTTP」，取最后一次；
//   内嵌服务懒启动，第一个 session/* 请求之后才出现。按 agy 进程 pid 缓存端口，换进程或请求失败再重读日志。
// - 请求体 {} 读 language server 自己的缓存（1–2ms、不联网）；{ forceRefresh:true } 向上游重拉（0.5–1.6s）。
//   不消耗模型额度。强刷之间至少隔 FORCE_GAP_MS。
// - remainingFraction 满额时可能缺省（proto 默认值不序列化）→ 当 1；已用 = 1 − 剩余。
// - 另一个接口 GetUserStatus 的 per-model quotaInfo 只反映 5 小时桶，判不了最吃紧，别用。

import { readFileSync, statSync } from 'node:fs';
import { listWorkerLogFiles } from './acp/binary.mjs';

const PORT_RE = /Language server listening on random port at (\d+) for HTTP\b(?! *S)/g;
const RPC = 'exa.language_server_pb.LanguageServerService/RetrieveUserQuotaSummary';
const FORCE_GAP_MS = 30_000;

let portCaches = new WeakMap();
let last = null;          // 最近一次规整后的结果
let lastForceAt = 0;
let inflight = null;

function extractLastHttpPort(file) {
  let port = null;
  try {
    const txt = readFileSync(file, 'utf8');
    for (const m of txt.matchAll(PORT_RE)) port = Number(m[1]);
  } catch {}
  return port;
}

export function clearLanguageServerPortCache(client) {
  if (client && typeof client === 'object') portCaches.delete(client);
}

export function findLanguageServerPort(client) {
  if (!client || typeof client.status !== 'function') return null;
  const st = client.status();
  const file = st?.logFile;
  if (!st?.running || !st?.pid || !file) return null;

  const cached = portCaches.get(client);
  if (cached && cached.pid === st.pid && cached.port && cached.sourceFile) {
    let curSize = -1;
    try { curSize = statSync(cached.sourceFile).size; } catch {}
    if (curSize >= 0 && cached.logSize <= curSize) return cached.port;
  }

  // 先查主日志（兼容单进程模式），未命中时顺着 front 日志查派生 worker 日志（--process-per-session 下
  // language server 跑在 worker 进程里，worker 1 负责 session/list 且随 front 常驻）。
  const candidates = [file, ...listWorkerLogFiles(file)];
  for (const src of candidates) {
    let size = -1;
    try { size = statSync(src).size; } catch { continue; }
    const port = extractLastHttpPort(src);
    if (port) {
      portCaches.set(client, { pid: st.pid, port, sourceFile: src, logSize: size });
      return port;
    }
  }
  return null;
}

function groupShort(name = '') {
  const s = String(name).trim();
  if (/^gemini/i.test(s)) return 'Gemini';
  if (/claude/i.test(s) && /gpt/i.test(s)) return 'Claude / GPT';
  return s.replace(/\s+models?$/i, '') || s;
}

export function normalizeQuota(resp) {
  const buckets = [];
  for (const g of resp?.response?.groups || []) {
    const group = groupShort(g.displayName);
    for (const b of g.buckets || []) {
      const rf = b.remainingFraction == null ? 1 : Number(b.remainingFraction);
      if (!Number.isFinite(rf)) continue;
      const resetAt = b.resetTime ? Date.parse(b.resetTime) : NaN;
      buckets.push({
        id: String(b.bucketId || `${group}-${b.window}`),
        group,
        window: String(b.window || ''),
        usedPct: Math.round(Math.max(0, Math.min(1, 1 - rf)) * 1000) / 10,
        resetAt: Number.isFinite(resetAt) ? resetAt : null,
      });
    }
  }
  return buckets;
}

async function fetchOnce(client, force) {
  const port = findLanguageServerPort(client);
  if (!port) return { buckets: [], at: Date.now(), error: 'unavailable' };
  try {
    const r = await fetch(`http://127.0.0.1:${port}/${RPC}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Connect-Protocol-Version': '1' },
      body: JSON.stringify(force ? { forceRefresh: true } : {}),
      signal: AbortSignal.timeout(force ? 8000 : 4000),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return { buckets: normalizeQuota(await r.json()), at: Date.now(), error: null };
  } catch (err) {
    clearLanguageServerPortCache(client);   // 端口可能换了，下次重读日志
    return { buckets: last?.buckets || [], at: last?.at || Date.now(), error: err?.message || String(err), stale: !!last };
  }
}

export async function getAgyQuota(client, { force = false } = {}) {
  const wantForce = force && Date.now() - lastForceAt >= FORCE_GAP_MS;
  if (inflight) return inflight;
  inflight = (async () => {
    if (wantForce) lastForceAt = Date.now();
    const res = await fetchOnce(client, wantForce);
    if (!res.error) last = res;
    return res;
  })().finally(() => { inflight = null; });
  return inflight;
}

export function _resetAgyQuotaForTest() {
  portCaches = new WeakMap();
  last = null; lastForceAt = 0; inflight = null;
}
