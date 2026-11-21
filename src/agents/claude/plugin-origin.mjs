// 插件应用页面开的会话（plugins/page-chat.mjs 经内部请求发 /api/chat）的归属打标。
// pluginOrigin 由 routes/chat.mjs 的 pluginOriginFor 只从内部请求取出，经 runClaudeChat 的入参带到本轮状态对象上。

import { markPluginSession } from '../../runtime/gen.mjs';

export function takePluginOrigin(run, input) {
  run.pluginOrigin = input.pluginOrigin;
}

// 会话 id 在 init 帧才定下来；要在推 session 事件之前打标——页面拿到 sessionId 时归属（插件 / 应用 / 使用者）已经可查，chat/send 才认得。
export function markPluginOrigin(run, sessionId) {
  const pluginOrigin = run.pluginOrigin;
  if (pluginOrigin && sessionId) markPluginSession(sessionId, { ...pluginOrigin, owner: run.plan.ctx.key });
}
