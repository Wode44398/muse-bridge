// 会话的拉取请求（PR 卡 / PR 芯片的后端，逻辑全在 src/runtime/pr-monitor.mjs）。
//   GET  /api/claude/pr?session=<id>[&refresh=1]  → { ok, view }      会话所有者可读（不是主机本人 → view.available=false）
//   POST /api/claude/pr { session, op, … }        → { ok, result, view } 写操作只给主机本人（gh 令牌是这台电脑的 GitHub 账号）
//     op：bind{url} / unbind{url} / refresh / monitor{autoFix?,autoArchive?} / mergeCheck{url?} / merge{url?,method,expectHead}
//         ready{url?} / draft{url?} / autoMerge{url?,enabled,method} / rerun{url?} / syncBase{base?,abort?}
// 所有权：locateSessionPaths 按身份的项目目录找得到这个会话 = 是自己的（同 /api/session）。
import { readBody } from '../runtime/body.mjs';
import { contextFor } from '../runtime/identity.mjs';
import * as claudeProjects from '../claude-projects.mjs';
import { prView, prOp, replayFromReq } from '../runtime/pr-monitor.mjs';
import { GhError } from '../runtime/github.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const SID_RE = /^[0-9a-fA-F-]{8,}$/;

export function registerClaudePrRoutes(router, { identify }) {
  const guard = (req, res, sid) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { json(res, 401, { error: 'unauthorized' }); return null; }
    const ctx = contextFor(who);
    if (!SID_RE.test(sid)) { json(res, 400, { error: 'bad session' }); return null; }
    if (!claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, sid)) { json(res, 404, { error: 'not found' }); return null; }
    return ctx;
  };

  router.on('GET', '/api/claude/pr', async (req, res, url) => {
    const sid = String(url.searchParams.get('session') || '');
    const ctx = guard(req, res, sid);
    if (!ctx) return;
    // viewer：界面上看得见的 PR 卡 / 芯片在拉（30 秒一次）——「有人正看着这个会话」，合并后先不自动归档
    try { json(res, 200, { ok: true, view: await prView(ctx, sid, { refresh: url.searchParams.get('refresh') === '1', viewer: true }) }); }
    catch (e) { json(res, e?.status || 500, { error: e?.message || String(e) }); }
  });

  router.on('POST', '/api/claude/pr', async (req, res) => {
    let b; try { b = JSON.parse(await readBody(req, 64 * 1024)); } catch { json(res, 400, { error: 'bad json' }); return; }
    const sid = String(b && b.session || '');
    const ctx = guard(req, res, sid);
    if (!ctx) return;
    const { session, op, ...args } = b;
    try {
      const result = await prOp(ctx, sid, String(op || ''), args, { replay: replayFromReq(req) });
      json(res, 200, { ok: true, result, view: await prView(ctx, sid) });
    } catch (e) {
      // GitHub 那边的失败（没登录 / 限流 / 422 合并被拒……）一律 502 + code，别把 GitHub 的状态码原样当成本接口的
      const status = e instanceof GhError ? 502 : (e?.status || 500);
      json(res, status, { error: e?.message || String(e), ...(e?.stale ? { stale: e.stale } : {}), ...(typeof e?.code === 'string' ? { code: e.code } : {}) });
    }
  });
}
