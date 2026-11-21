// dimensio 的 Terminal 工具 → bridge 的共享终端（与 Claude 的 terminal 工具、工作台终端面板同一个 PTY）。
//
//   POST /api/internal/agent-term { ws, args } → { ok:true, content, isError } | { error, code? }
//   args = 终端工具的参数原样（action: status / read / run / write / keys / wait / resize / restart，见 mcp/terminal-tools.mjs）。
//
// 池键 = poolRef(ctx, ws)：属主取凭据认出的身份（管理员 'admin' / 成员 'u:<id>'），与面板 /api/claude/term/*?ws= 同一把键，
// 面板开着时用户看得到 dimensio 敲的每个字。动作事件不发进任何 Claude 对话（emit:null）——实例那边自己给前端发 terminal 事件。
import { runTerminalAction } from '../../mcp/terminal/actions.mjs';
import { poolRef } from '../../runtime/principal.mjs';
import { json, runtimeCaller, abortOnClose } from './caller.mjs';

export async function handleAgentTerm(req, res) {
  const g = await runtimeCaller(req, res, { plugin: 'terminal' });
  if (!g) return;
  const args = g.body.args && typeof g.body.args === 'object' && !Array.isArray(g.body.args) ? g.body.args : null;
  if (!args || typeof args.action !== 'string') return json(res, 400, { error: '需要 args.action', code: 'args' });
  const signal = abortOnClose(res);
  try {
    const r = await runTerminalAction({ ws: poolRef(g.ctx, g.ws), emit: null }, args, { signal });
    json(res, 200, { ok: true, content: r?.content || [], isError: !!r?.isError });
  } catch (e) {
    json(res, 500, { error: e?.message || String(e) });
  }
}
