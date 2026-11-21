// dimensio 的 Browser / ReadPage / Eval / Network → bridge 的浏览器实例池（与 Claude 的 browser 工具、工作台浏览器面板同一套）。
//
//   POST /api/internal/agent-browser { ws, session, op, args?, on?, forget?, denyPorts? }
//     op = act（缺省）：执行一次浏览器动作 args（runBrowserAction 的参数）→ { ok, content, isError, url, tabs, activity, data }
//          close{forget?}：关掉这个会话的浏览器；forget = 连隔离存储开关一起忘掉（会话删了）→ { ok }
//          isolate{on}：隔离存储开关（同面板的 /api/claude/browser/isolate）→ { ok, isolated, restarted }
//          state：{ ok, alive, url?, tabs?, isolated }
//   session = dimensio 的会话 id（空 = 还不属于任何会话的那份）；池键里的会话段是 'd_' + 它——前端开面板时按同样的拼法传
//   /api/claude/browser/*?ws=&session=d_<会话 id>，两边落在同一把键上。属主取凭据认出的身份（管理员 / 成员本人）。
//   activity = 这次动作让页面动了（前端据此记地址、拉起浏览器卡）；data = 结构化结果（runBrowserAction 的 opts.structured），
//   实例那边按它出完成证据（Eval verify、Network verify、dprprobe）。denyPorts = 实例自己的控制面端口，只会多拦。
import { runBrowserAction } from '../../runtime/browser-actions.mjs';
import { poolRef, cleanSessionId, allowedRoots } from '../../runtime/principal.mjs';
import { json, runtimeCaller } from './caller.mjs';
import { agentUrlGuard } from './url-guard.mjs';

export const SESSION_PREFIX = 'd_';
const RAW_SID = /^[A-Za-z0-9_-]{0,78}$/;
const OPS = new Set(['act', 'close', 'isolate', 'state']);

/** dimensio 会话 id → 池键里的会话段；不合法返回 null。 */
export function agentBrowserSession(raw) {
  const s = String(raw ?? '');
  if (!RAW_SID.test(s)) return null;
  const sid = SESSION_PREFIX + s;
  return cleanSessionId(sid) === sid ? sid : null;
}

export async function handleAgentBrowser(req, res) {
  const g = await runtimeCaller(req, res, { plugin: 'browser' });
  if (!g) return;
  const { ctx, ws, body } = g;
  const op = body.op == null ? 'act' : String(body.op);
  if (!OPS.has(op)) return json(res, 400, { error: 'unknown op', code: 'op' });
  const sid = agentBrowserSession(body.session);
  if (!sid) return json(res, 400, { error: 'bad session', code: 'session' });
  const ref = poolRef(ctx, ws, sid);
  const svc = await import('../../runtime/claude-browser.mjs');
  try {
    if (op === 'state') {
      const b = svc.existingBrowser(ref);
      const isolated = svc.browserIsolated(ref);
      return json(res, 200, b ? { ok: true, alive: true, url: b.url, tabs: b.tabs, isolated } : { ok: true, alive: false, isolated });
    }
    if (op === 'close') {
      svc.closeBrowser(ref);
      if (body.forget === true && svc.browserIsolated(ref)) svc.setBrowserIsolated(ref, false);
      return json(res, 200, { ok: true });
    }
    if (op === 'isolate') return json(res, 200, { ok: true, ...svc.setBrowserIsolated(ref, body.on === true) });

    const args = body.args && typeof body.args === 'object' && !Array.isArray(body.args) ? body.args : null;
    if (!args || typeof args.action !== 'string') return json(res, 400, { error: '需要 args.action', code: 'args' });
    // batch 由实例那边逐步转过来（每步的截图、证据各自装回），这里不收整批
    if (args.action === 'batch') return json(res, 400, { error: 'batch 请逐步调用', code: 'args' });
    let activity = false;
    const onActivity = () => { activity = true; };
    const roots = allowedRoots(ctx) === null ? null : [ws, ...allowedRoots(ctx)];
    const urlDenied = agentUrlGuard(ctx, ws, { extraPorts: body.denyPorts });
    const r = await runBrowserAction(ref, args, onActivity, { roots, caller: sid, urlDenied, structured: true, tabCloseCurrent: true });
    const b = svc.existingBrowser(ref);
    json(res, 200, {
      ok: true, content: r?.content || [], isError: !!r?.isError,
      url: b?.url || '', tabs: b?.tabs || [], activity, data: r?.data ?? null,
    });
  } catch (e) {
    json(res, e?.status || 500, { error: e?.message || String(e) });
  }
}
