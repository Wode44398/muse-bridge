// 会话协作的卡片与跨会话消息接口（2026-10-20，对齐官方 Claude Desktop 3.1623）：
//   GET  /api/claude/proposals?session=<父会话>      → { items:[卡片] }（offer 卡 / 提议卡 / 直接开始档的「已开始」卡，含已结束的）
//   POST /api/claude/proposal/start   { taskId | ids:[…], useWorktree?, client? } → { ok, results:[{ id, ok, child?, error? }] }
//   POST /api/claude/proposal/dismiss { taskId }      → { ok, proposal }
//   GET  /api/claude/peer-hold?session=<会话>        → { items:[扣着等确认的跨会话消息] }（只有管理员）
//   POST /api/claude/peer-hold        { session, action:'accept'|'refuse' } → { ok }
// offer 卡的「新会话 / 在这里做」走现成的 POST /api/answer（qid + choice），不在这里。
// 变化一律经总线推：{type:'proposal'}（session-proposals.mjs）、{type:'peer_hold'}（session-peers.mjs）。
// 身份门与 sessions MCP 一致：管理员与有 shell 的身份；快照访客 / 公开分享一律不给。
import { readBody } from '../runtime/body.mjs';
import { contextFor, replayHeadersOf } from '../runtime/identity.mjs';
import { ID_RE } from '../jsonfile.mjs';
import { spawnChild, parentCtxFor, rememberReplay, resolveProject } from '../runtime/session-family.mjs';
import { TASK_ID_RE, OPEN_STATUSES, getProposal, proposalsOf, updateProposal, publicView } from '../runtime/session-proposals.mjs';
import { peerHoldsOf, resolvePeerHold, peerInbound, peersOn } from '../runtime/session-peers.mjs';
import { CLAUDE_MODELS } from '../config/capabilities.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

// 卡片上点「开始」：用这条请求自己的身份头做重放身份（服务刚重启、还没人发过消息也开得起来），
// 按父会话的 transcript 找回它的工作目录，照提议原样派生。
export async function startFromCard(ctx, req, id, { useWorktree, client } = {}) {
  const p = getProposal(ctx, id);
  if (!p) return { ok: false, status: 404, error: '这张卡不在了' };
  if (p.kind === 'offer') return { ok: false, status: 409, error: '这张卡还没有任务说明：在对话里跟 Claude 说一声「开吧」，它会写好说明再开' };
  if (!OPEN_STATUSES.has(p.status)) return { ok: false, status: 409, error: '这张卡已经不在等待中了', proposal: publicView(p) };
  const q = String(req.url || '').indexOf('?');
  rememberReplay(ctx, {
    headers: replayHeadersOf(req),
    url: '/api/chat' + (q >= 0 ? String(req.url).slice(q) : ''),
    body: { client: client === 'apk' ? 'apk' : 'web' },
  });
  const pctx = parentCtxFor(ctx, p.parent);
  if (!pctx) return { ok: false, status: 409, error: '找不到发起这张卡的会话' };
  // 提议开到别的项目：落卡后项目可能被删了 / 改了权限，开之前再认一遍
  let project;
  if (p.project) {
    const rp = resolveProject(ctx, p.project);
    if (!rp.ok) { const n = updateProposal(ctx, p.id, { status: 'start_failed', reason: '要开到的项目不在了' }); return { ok: false, status: 200, error: '要开到的项目不在了', proposal: publicView(n) }; }
    project = rp.project;
  }
  updateProposal(ctx, p.id, { status: 'starting', ...(typeof useWorktree === 'boolean' ? { useWorktree } : {}) });
  const wt = typeof useWorktree === 'boolean' ? useWorktree : (typeof p.useWorktree === 'boolean' ? p.useWorktree : undefined);
  const r = await spawnChild(pctx, p.parent, {
    title: p.title, prompt: p.prompt, background: p.background, context: p.context,
    model: p.model && CLAUDE_MODELS.has(p.model) ? p.model : undefined, name: p.name || undefined,
    worktree: pctx.worktree || null, useWorktree: p.context === 'fork' ? undefined : wt, branchName: p.branchName || undefined,
    task: p.id, toolUseId: p.toolUseId, project,
  });
  if (!r.ok) {
    const why = r.userReason || r.reason;   // 卡片上给用户看的（session-family.mjs spawnChild）
    const n = updateProposal(ctx, p.id, { status: 'start_failed', reason: why });
    return { ok: false, status: 200, error: why, proposal: publicView(n) };
  }
  const n = updateProposal(ctx, p.id, { status: 'started', child: r.id, reason: '' });
  return { ok: true, child: r.id, proposal: publicView(n) };
}

export function registerSessionCollabRoutes(router, { identify }) {
  // 身份门：sessions MCP 同款（管理员 / 有 shell 的身份）
  const collabCtx = (req, res) => {
    const who = identify(req);
    if (!who || who.kind === 'none' || who.kind === 'share') { json(res, 401, { error: 'unauthorized' }); return null; }
    const ctx = contextFor(who);
    if (ctx.snap || !(ctx.kind === 'admin' || ctx.shell)) { json(res, 403, { error: 'forbidden' }); return null; }
    return ctx;
  };
  const readJsonBody = async (req, res) => {
    try { return JSON.parse(await readBody(req, 64 * 1024)); } catch { json(res, 400, { error: 'bad json' }); return null; }
  };

  router.on('GET', '/api/claude/proposals', (req, res, url) => {
    const ctx = collabCtx(req, res); if (!ctx) return;
    const sid = String(url.searchParams.get('session') || '');
    if (!ID_RE.test(sid)) return json(res, 400, { error: 'bad session' });
    json(res, 200, { items: proposalsOf(ctx, sid).map(publicView) });
  });

  router.on('POST', '/api/claude/proposal/start', async (req, res) => {
    const ctx = collabCtx(req, res); if (!ctx) return;
    const b = await readJsonBody(req, res); if (!b) return;
    const ids = (Array.isArray(b.ids) ? b.ids : [b.taskId]).map(String).filter((x) => TASK_ID_RE.test(x)).slice(0, 20);
    if (!ids.length) return json(res, 400, { error: 'bad taskId' });
    const results = [];
    // 「全部开始」逐个开：同时在跑 / 子会话数的上限照样卡着，开不了的那张显示原因
    for (const id of ids) {
      const r = await startFromCard(ctx, req, id, { useWorktree: ids.length === 1 && typeof b.useWorktree === 'boolean' ? b.useWorktree : undefined, client: b.client });
      results.push({ id, ok: r.ok, ...(r.child ? { child: r.child } : {}), ...(r.error ? { error: r.error } : {}), ...(r.proposal ? { proposal: r.proposal } : {}) });
      if (ids.length === 1 && r.status && r.status !== 200) return json(res, r.status, { ok: false, error: r.error, results });
    }
    json(res, 200, { ok: results.every((x) => x.ok), results });
  });

  router.on('POST', '/api/claude/proposal/dismiss', async (req, res) => {
    const ctx = collabCtx(req, res); if (!ctx) return;
    const b = await readJsonBody(req, res); if (!b) return;
    const p = getProposal(ctx, String(b.taskId || ''));
    if (!p) return json(res, 404, { error: '这张卡不在了' });
    if (!OPEN_STATUSES.has(p.status)) return json(res, 409, { error: '这张卡已经不在等待中了', proposal: publicView(p) });
    const n = updateProposal(ctx, p.id, { status: 'dismissed', reason: 'user' });
    json(res, 200, { ok: true, proposal: publicView(n) });
  });

  // —— 跨会话消息「待你确认」（设置 crossSessionInbound = hold）——只有主机管理员有这条通道
  router.on('GET', '/api/claude/peer-hold', (req, res, url) => {
    const ctx = collabCtx(req, res); if (!ctx) return;
    const sid = String(url.searchParams.get('session') || '');
    if (!ID_RE.test(sid)) return json(res, 400, { error: 'bad session' });
    json(res, 200, { items: peersOn(ctx, null) ? peerHoldsOf(ctx.key, sid) : [] });
  });
  router.on('POST', '/api/claude/peer-hold', async (req, res) => {
    const ctx = collabCtx(req, res); if (!ctx) return;
    if (!peersOn(ctx, null)) return json(res, 403, { error: 'forbidden' });
    const b = await readJsonBody(req, res); if (!b) return;
    const sid = String(b.session || '');
    if (!ID_RE.test(sid)) return json(res, 400, { error: 'bad session' });
    const action = b.action === 'accept' ? 'accept' : 'refuse';
    const r = await resolvePeerHold(ctx.key, sid, action, peerInbound(ctx, null));
    json(res, r.ok ? 200 : 409, r.ok ? { ok: true } : { ok: false, error: r.reason });
  });
}
