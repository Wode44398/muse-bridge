// 订阅用量探针——让手机的额度环显示【真实】双桶利用率。
//
// 背景：SDK 的 rate_limit_event 现在每轮只带「主导桶」且不再含 utilization 字段，
// 所以 status.mjs 里靠事件累积的 pct 永远是 null（老版本残留的 pct 变成化石，
// 比如那个一直显示 78% 的 seven_day）。而 /v1/messages 的响应头里有完整数据：
//   anthropic-ratelimit-unified-5h-utilization: 0.61
//   anthropic-ratelimit-unified-7d-utilization: 0.21   （+ 各自 status/reset）
// SDK 不透传响应头，故这里用一次最小 haiku 调用（max_tokens:1，约 9 token，
// 对订阅额度是尘埃级）直接读头。
//
// 节流：5 分钟 TTL + 进行中去重，且只由 GET /api/status 触发（QuotaRing 只在
// app 前台时 30s 轮询）→ 实际最多 ~12 次/小时、仅在有人看用量时发生。
// 失败退避 10 分钟，避免探针自身风暴。

import { OAUTH } from '../config/index.mjs';
import { applyProbedLimits } from './status.mjs';

const TTL = 5 * 60_000;
const FAIL_BACKOFF = 10 * 60_000;
let nextAt = 0;        // 下次允许探测的时刻
let inflight = null;

export function maybeRefreshLimits() {
  if (!OAUTH) return Promise.resolve(false);
  if (Date.now() < nextAt) return Promise.resolve(false);
  if (inflight) return inflight;
  inflight = probe().finally(() => { inflight = null; });
  return inflight;
}

async function probe() {
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + OAUTH,
        'anthropic-beta': 'oauth-2025-04-20',
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15_000),
    });
    // 消费掉 body，避免挂起的连接（内容本身不用）。
    res.text().catch(() => {});
    const h = (k) => res.headers.get('anthropic-ratelimit-unified-' + k);
    if (h('5h-utilization') == null && h('7d-utilization') == null) {
      // 头没了（API 改版/请求被拒）——按失败退避，别把现有数据清掉。
      nextAt = Date.now() + FAIL_BACKOFF;
      return false;
    }
    applyProbedLimits({
      five_hour: { status: h('5h-status'), utilization: parseFloat(h('5h-utilization')), resetsAt: parseInt(h('5h-reset'), 10) },
      seven_day: { status: h('7d-status'), utilization: parseFloat(h('7d-utilization')), resetsAt: parseInt(h('7d-reset'), 10) },
    });
    nextAt = Date.now() + TTL;
    return true;
  } catch {
    nextAt = Date.now() + FAIL_BACKOFF;
    return false;
  }
}
