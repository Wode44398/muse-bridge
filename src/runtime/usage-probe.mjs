// 额度环的「顺手刷新」（GET /api/status 调，见 routes/overview.mjs）。
//
// 不另外向 Anthropic 发请求：额度环显示的是 Claude Code 自己带回来的数据——SDK 的 rate_limit_event 与
// usage 控制接口（agents/claude.mjs 每轮 / 每 10 分钟记一次，按号记在 status.mjs）。所以这里什么都不做、回 false；
// 调用方的接口形状保留，免得 overview 那边跟着改。

export function maybeRefreshLimits() {
  return Promise.resolve(false);
}
