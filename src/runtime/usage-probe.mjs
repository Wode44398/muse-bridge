// 手机额度环的「顺手刷新」（GET /api/status 调，见 routes/overview.mjs）。
//
// 公开版不另外向 Anthropic 发请求：额度环显示的是 Claude Code 自己带回来的数据——SDK 的 rate_limit_event /
// usage 接口、无缝换号上游代理逐请求记下的响应头（都按号记在 status.mjs）。所以这里在公开版里什么都不做、回 false。
// 配了可选的 overlay 钩子 claudeUsageProbe（runtime/overlay-hooks.mjs）时交给它，与号池逐号用量 account-usage.mjs
// 共用同一个实例。

import { overlayUsageProbe } from './account-usage.mjs';

export function maybeRefreshLimits() {
  const p = overlayUsageProbe();
  return p && typeof p.maybeRefreshLimits === 'function' ? Promise.resolve(p.maybeRefreshLimits()) : Promise.resolve(false);
}
