// bridge 自己挂在每一轮上的观察钩子（PostToolUse）。

import path from 'node:path';
import { notePush } from '../../runtime/push-notices.mjs';
import { emitBridgeEvent, ownerOf as eventOwner, clip as eventClip } from '../../plugins/events.mjs';

// 文件面板自动刷新：agent 的写类工具落盘后把变更广播进本轮 SSE（{type:'wsx',op:'fs'}），
// 前端文件面板收到即静默 reload——用户看着 agent 改文件、列表实时跟上，不用手动刷新。
// 桌面壳原生层自己有 fs.watch，这条主要服务云端/手机路径；PostToolUse 只观察不拦截。
const FS_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

export function makeFsEchoHook(run) {
  const { ctx } = run.plan;
  return async (input) => {
    try {
      emitBridgeEvent('tool.end', {
        agent: 'claude', owner: eventOwner(ctx), sessionId: input?.session_id || run.gen.sessionId || null,
        tool: String(input?.tool_name || ''), input: eventClip(JSON.stringify(input?.tool_input ?? {}), 2000),
        isError: !!(input?.tool_response && typeof input.tool_response === 'object' && input.tool_response.is_error),
        agentId: input?.agent_id || '',
      });
    } catch {}
    try {
      const name = String(input?.tool_name || '');
      const ti = input?.tool_input || {};
      if (FS_WRITE_TOOLS.has(name)) {
        const p = String(ti.file_path || ti.notebook_path || '');
        if (!p) return {};
        const abs = path.resolve(p);
        const root = path.resolve(ctx.cwd);
        if (abs !== root && !abs.startsWith(root + path.sep)) return {};   // 工作空间外的写不广播
        run.send({ type: 'wsx', op: 'fs', rel: path.relative(root, abs).split(path.sep).join('/'), at: Date.now() });
      } else if (name === 'Bash' || name === 'PowerShell') {
        // shell 什么都可能改——广播一次无定向刷新（前端有防抖，代价=一次列目录）。
        run.send({ type: 'wsx', op: 'fs', at: Date.now() });
      }
    } catch { /* 观察钩子绝不拖垮轮次 */ }
    return {};
  };
}

// 模型主动推送（PushNotification 工具）：CLI 在 SDK 宿主下没有投递通道（只回「Mobile push not sent」），
// 这里接住 message 交给手机 App 的后台服务（/api/active 带 pushes，见 push-notices.mjs），并告诉模型
// 实情——别让它以为没送到、又在正文里重复一遍。快照访客不挂。
export function makePushHook(run) {
  const { ctx } = run.plan;
  return async (input) => {
    try {
      const msgText = String(input?.tool_input?.message || '');
      const item = notePush(ctx.key, { sessionId: run.gen.sessionId, message: msgText });
      if (!item) return {};
      run.send({ type: 'push', message: item.message, at: item.at });
      return {
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: '[bridge] 这条通知已经由 bridge 转给用户的手机 App：手机 App 正在后台跟踪这一轮时，它会出现在手机通知栏（上面那句「Mobile push not sent」说的是 Claude 官方通道，不影响这条）。不必在回答里重复通知内容。',
        },
      };
    } catch { return {}; }
  };
}
