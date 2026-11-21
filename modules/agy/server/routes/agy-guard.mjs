// 工具调用守卫的判定接口：注册用户的 agy 进程里，钩子脚本（guard/guard-hook.cjs）每次工具调用前来问一句。
// 只认本机直连 + 这个用户自己的按人令牌（令牌绑死账号，认的时候现查账号库：停用 / 收回授权当场失效）。
// 主机密钥不认：管理员的进程不装守卫，拿主机密钥来问的不是守卫。

import { instanceCaller } from '@bridge/core/agent-api/instance-auth.mjs';
import { guardDecision } from '../guard/policy.mjs';
import { tenantArtifactDirs } from '../tenants.mjs';
import { noteGuardHit } from '../guard/liveness.mjs';

export function registerAgyGuardRoutes(router, { parseJsonBody, sendJson }) {
  router.on('POST', '/api/agy/internal/guard', async (req, res) => {
    const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || ''));
    const caller = instanceCaller(req, m ? m[1].trim() : '');
    if (!caller) { sendJson(res, caller === null ? 403 : 401, { ok: false, error: '凭据无效' }); return; }
    const ctx = caller.ctx;
    if (caller.instance !== 'agy' || ctx?.kind !== 'user' || !ctx.allowAgy) {
      sendJson(res, 403, { ok: false, error: '只接受注册用户的 Antigravity 进程' });
      return;
    }
    const body = await parseJsonBody(req, res); if (!body) return;
    // 记一笔「守卫来问过」：对话主流程拿它核对守卫还活着（guard/liveness.mjs）
    noteGuardHit(ctx.key);
    let out;
    try {
      out = guardDecision(ctx, body.payload && typeof body.payload === 'object' ? body.payload : {}, { artifactDirs: tenantArtifactDirs(ctx) });
    } catch (err) {
      // 判定本身出错：按拒绝回，别让一次异常变成放行
      out = { decision: 'deny', reason: '守卫判定出错，已拒绝：' + String(err?.message || err).slice(0, 200) };
    }
    // 排查守卫为什么拦 / 没拦时用：设了这个环境变量才打
    if (process.env.BRIDGE_AGY_GUARD_TRACE) {
      console.log('[agy-guard]', ctx.user, body.payload?.toolCall?.name, JSON.stringify(body.payload?.toolCall?.args || {}).slice(0, 200), '=>', out ? `${out.decision} ${out.reason}` : 'pass');
    }
    sendJson(res, 200, { ok: true, out: out || null });
  });
}
