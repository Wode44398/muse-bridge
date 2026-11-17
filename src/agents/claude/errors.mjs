import { sessionPaths } from '../../runtime/paths.mjs';
import { sanitizeSessionThinking } from '../../runtime/session-sanitize.mjs';
import { classifyError } from '../../runtime/status.mjs';

// 一轮出错时怎么认、怎么说。

// 自定义 API 这一轮出错 → 错误卡文案。CLI 的 result 形如「API Error: 400 {"type":"error","error":{"message":"…"}}」：
// 抠出 error.message（代理改写过的人话），抠不出就用原文。
export function customErrorCard({ provider, lent }, result, apiStatus) {
  const raw = String(result || '').trim();
  let msg = '';
  const i = raw.indexOf('{');
  if (i >= 0) {
    try { const j = JSON.parse(raw.slice(i)); msg = (j.error && (j.error.message || (typeof j.error === 'string' ? j.error : ''))) || j.message || ''; } catch {}
  }
  msg = String(msg || raw.replace(/^API Error:\s*/i, '') || (apiStatus ? 'HTTP ' + apiStatus : '没有返回内容')).slice(0, 600);
  const title = apiStatus === 429 ? `模型服务「${provider.name}」限流了` : `模型服务「${provider.name}」出错了`;
  // 管理员共享的服务：成员改不了，代理已经给了「请联系管理员」，不再指他去设置里测试
  if (lent) return { title, hint: msg + (/联系管理员/.test(msg) ? '' : '（这是管理员共享的服务，请联系管理员）') };
  return { title, hint: msg + (/设置 › Claude/.test(msg) ? '' : '（设置 › Claude › 模型服务里可以测试连接）') };
}

// True if an error message is the SDK/API "thinking blocks cannot be modified" 400
// (the known SDK bug where thinking blocks get persisted with emptied text).
export function isThinkingBlockError(s) {
  const t = String(s || '');
  return /thinking|redacted_thinking/.test(t) && /(cannot be modified|must remain|must start with)/.test(t);
}

// Both error paths (query throw → catch, and a result message carrying api_error_status)
// funnel a thinking-block 400 here: strip the dead blocks from this session (in-place,
// so it lands even while the SDK holds the file open) and surface an actionable hint
// instead of dumping the raw API error.
export function emitThinkingError(run) {
  const { sessionId, ctx } = run.plan;
  const sid = sessionId || run.gen.sessionId;   // 停放后接着用的新会话：开跑时还没有 sessionId
  if (sid) { const sp = sessionPaths(sid, ctx.cwd, ctx.configDir); if (sp) { try { sanitizeSessionThinking(sp.file); } catch {} } }
  run.send({ type: 'error', kind: 'thinking', title: '思考块遇到 SDK 已知问题，已自动清理', hint: '再发一次；若仍旧，调低思考强度或换 4.7/Sonnet', resetsAt: 0, message: '这一轮的思考块遇到 SDK 已知问题（高思考强度 + 多工具并行时偶发，思考块被写坏）——已自动清理本会话。请再发一次刚才的消息；若仍报错，把思考强度调低一档（如 Max→High）或换 Opus 4.7 / Sonnet。' });
}

// 主循环抛出来的异常怎么报：自己制造的收尾不报，被 abort 的报「已中断」，其余按错误分类出卡。
export function reportRunError(run, err) {
  if (run.bgFinalized || run.userStopped) {
    // 静默看门狗已主动定局并 abort / 用户硬停已收尾——这个异常是我们自己制造的收尾，不再当错误上报。
  } else if (run.abort.signal.aborted) {
    // 别的路径的 abort（同会话重发顶掉、控制口还没挂上时的停止）：是「停下」，不是故障——
    // 不发「出错了 — Operation aborted」。
    run.send({ type: 'interrupted', sessionId: run.gen.sessionId || null });
  } else {
    const em = String((err && err.message) || err || '');
    if (isThinkingBlockError(em)) emitThinkingError(run);
    else {
      const c = classifyError(err);
      run.send({ type: 'error', kind: c.kind, title: c.title, hint: c.hint, resetsAt: c.resetsAt || 0, message: c.hint ? (c.title + ' — ' + c.hint) : c.title });
    }
  }
}
