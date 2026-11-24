// Antigravity 的审批先问插件（八期，能力名 claude.permission.agy）：ctx.claude.permission(fn, { agents: ['agy'] }) 登记的策略，
// 在 ACP 审批自动放行（bridge 自家工具免审批、完全放行模式）之前被问到（acp/client.mjs 的 _routePermission）。
//
// fn 收到 { tool: agy 的工具名（如 mcp_bridge_call）, input: 工具参数, title, agent: 'agy', sessionId } 与这一轮 turn（agent:'agy'、cwd = 会话目录）。
// 回值同 Claude：'allow' / 'deny' / 'ask' / 不表态。'ask' = 完全放行也弹卡；后台唤醒这类没人在的轮按拒绝。
// agy 单次工具调用 180 秒硬上限：策略最多等 30 秒，超时当没表态（核心 agyPluginPermission 里夹）。
import { agyPluginPermission } from '@bridge/core/plugins/claude-tools.mjs';

export function makeAgyPermissionPolicy(ctx, gen, { cwd = '', unattended = false } = {}) {
  if (!ctx || ctx.snap) return null;
  return async (payload) => {
    const tc = payload?.toolCall || {};
    const turn = { kind: 'chat', agent: 'agy', ctx, snap: null, sessionId: gen?.sessionId || payload?.sessionId || null, cwd: cwd || gen?.cwd || '', getGen: () => gen || null };
    const r = await agyPluginPermission(turn, {
      tool: String(tc.name || tc.kind || ''),
      input: tc.args && typeof tc.args === 'object' ? tc.args : {},
      title: String(tc.title || ''),
      signal: gen?.abort?.signal,
    });
    if (r && r.behavior === 'ask' && unattended) {
      return { behavior: 'deny', message: r.message || '这次调用要用户本人批准，没人在的这一轮批不了' };
    }
    return r;
  };
}
