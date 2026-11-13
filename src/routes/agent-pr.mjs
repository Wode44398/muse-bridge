// 别的 agent（dimensio）的会话 ↔ 拉取请求：同机 agent 实例调的内部接口。逻辑全在 src/runtime/pr-monitor.mjs——
// 与 Claude 的 PR 卡同一份台账、同一个后台扫描（自动修复的轮询只有 bridge 这一份）。
//
//   POST /api/internal/agent-pr { session, op, cwd, prefs:{autoFix, attribution}, …参数 } → { ok:true, result?, view? } | { ok:false, error, code? }
//   op：view{refresh?}（PR 卡）/ status（给 agent 工具的精简版，同 Claude 的 mcp__pr__get_status）/ bind{url} / unbind{url} /
//       monitor{autoFix}（PR 卡上的开关）/ refresh / syncBase{base?, abort?}（主机侧 fetch + merge，不推送）/
//       reported{url, source}（实例在一轮里认出的 PR：<pr-created> 标签、gh pr create 的输出）/ human（真人发了一条：清零连续唤醒）/
//       forget（会话删了）
//   session 是实例自己的会话 id；台账里记成 '<agent>:<会话 id>'。cwd = 会话的工作区（git 操作、核对仓库都在这里）。
//
// 凭据：实例拉起时 bridge 给的同机凭据（agent-api/instance-auth.mjs：主机密钥 → 管理员实例；按人令牌 dvt1.… → 那个成员），
// 只认本机直连。台账按凭据认出的身份分开存，成员实例只看得到 / 动得到自己的；PR 功能本身只给主机本人（gh 令牌是这台电脑的
// GitHub 账号，pr-monitor.prCapable），成员实例回 available:false、写操作 403——与 Claude 给注册用户的一样。
//
// 叫醒（自动修复）：这里给 pr-monitor 登记 dimensio 的 deliver = 扩展 modules/dimensio 导出的 deliverPrEvent。
import { readBody } from '../runtime/body.mjs';
import { instanceCaller } from '../agent-api/instance-auth.mjs';
import { getModule } from '../modules/registry.mjs';
import { GhError } from '../runtime/github.mjs';
import { prView, prOp, prCapable, noteAgentSession, bindReported, notePrTurnStart, forgetPrSession, registerPrAgent } from '../runtime/pr-monitor.mjs';
import { statusPayload } from '../mcp/pr-tools.mjs';

const json = (res, code, obj) => { if (!res.headersSent) res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const SID_RE = /^[0-9a-fA-F-]{8,64}$/;
const AGENTS = new Set(['dimensio']);
// 实例能直接调的写操作（合并、自动合并、转草稿这些 dimensio 暂不开放）
const OPS = new Set(['view', 'status', 'bind', 'unbind', 'monitor', 'refresh', 'syncBase', 'reported', 'human', 'forget']);

registerPrAgent('dimensio', {
  deliver: async (ctx, sessionId, text) => {
    const fn = getModule('dimensio')?.deliverPrEvent;
    if (typeof fn !== 'function') return { ok: false, reason: 'dimensio 扩展没有加载' };
    return fn(ctx, sessionId, text);
  },
});

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
  return m ? m[1].trim() : '';
}

export function registerAgentPrRoutes(router) {
  router.on('POST', '/api/internal/agent-pr', async (req, res) => {
    const who = instanceCaller(req, bearer(req));
    // 不是同机实例凭据、或不是本机直连：当作不存在
    if (!who) return json(res, 404, { error: 'not found' });
    const agent = String(who.instance || '');
    if (!AGENTS.has(agent)) return json(res, 403, { error: `${agent || '这个调用方'} 不能用这个接口` });
    let b;
    try { b = JSON.parse(await readBody(req, 64 * 1024)); } catch { return json(res, 400, { error: 'bad json' }); }
    const raw = String(b && b.session || '');
    const op = String(b && b.op || '');
    if (!SID_RE.test(raw)) return json(res, 400, { error: 'bad session' });
    if (!OPS.has(op)) return json(res, 400, { error: 'unknown op' });
    const ctx = who.ctx;
    const sid = `${agent}:${raw}`;
    if (!prCapable(ctx)) {
      // 成员实例：没有 PR 功能（同 Claude）；只读的两样照常回「不可用」，别的拒
      if (op === 'view' || op === 'status') return json(res, 200, { ok: true, result: op === 'status' ? statusPayload({ available: false }) : undefined, view: { available: false, reason: 'host_only' } });
      if (op === 'human' || op === 'forget' || op === 'reported') return json(res, 200, { ok: true, result: null });
      return json(res, 403, { error: '拉取请求功能只对这台电脑的主人开放', code: 'host_only' });
    }
    noteAgentSession(ctx, sid, { cwd: typeof b.cwd === 'string' ? b.cwd : '', prefs: b.prefs });
    try {
      switch (op) {
        case 'view': return json(res, 200, { ok: true, view: await prView(ctx, sid, { refresh: b.refresh === true, viewer: true }) });
        case 'status': return json(res, 200, { ok: true, result: statusPayload(await prView(ctx, sid)) });
        case 'reported': return json(res, 200, { ok: true, result: await bindReported(ctx, sid, String(b.url || ''), { source: String(b.source || 'tag') }) });
        case 'human': notePrTurnStart(ctx, sid); return json(res, 200, { ok: true, result: null });
        case 'forget': return json(res, 200, { ok: true, result: forgetPrSession(ctx, sid) });
        default: {
          const args = {};
          if (typeof b.url === 'string') args.url = b.url;
          if (op === 'monitor' && (b.autoFix === true || b.autoFix === false || b.autoFix === null)) args.autoFix = b.autoFix;
          if (op === 'syncBase') { if (typeof b.base === 'string' && b.base) args.base = b.base; args.abort = b.abort === true; }
          // 实例的 agent 工具调的（bind / unbind / syncBase）记成 fromTool：Claude 的 bind_pr 那套规矩——用户移出的 PR 工具绑不回来
          const result = await prOp(ctx, sid, op, args, { fromTool: b.fromTool === true });
          return json(res, 200, { ok: true, result, ...(op === 'syncBase' ? {} : { view: await prView(ctx, sid) }) });
        }
      }
    } catch (e) {
      const status = e instanceof GhError ? 502 : (e?.status || 500);
      return json(res, status, { ok: false, error: e?.message || String(e), ...(typeof e?.code === 'string' ? { code: e.code } : {}), ...(e?.stale ? { stale: e.stale } : {}) });
    }
  });
}
