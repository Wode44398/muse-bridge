// 问题反馈（网页里的「报告问题」）：
//   GET  /api/feedback               自动上报开没开、发过的报告（管理员看全部，普通账号只看自己的）
//   POST /api/feedback/auto          { on }：开 / 关自动上报（管理员）
//   POST /api/feedback/draft         { kind, description, trail, errorFps, page, browser, lang }：出草稿，回预览
//   POST /api/feedback/send          { id }：用户点了「发送」才发；回 Issue 地址 / 已 +1 / 已存进待发
//   POST /api/feedback/client-error  { name, message, stack, page }：页面上没接住的报错，记下来（不发）
// 草稿里有什么、怎么脱敏，见 src/feedback/。
import { readBody } from '../runtime/body.mjs';
import { FEATURES } from '../config/index.mjs';
import { enabledAgents } from '../runtime/agent-status.mjs';
import { makeDraft, sendDraft, feedbackHost } from '../feedback/report.mjs';
import { recordError, recentErrors } from '../feedback/errors.mjs';
import { loadDraft, getSettings, setAuto, listSent, listOutbox } from '../feedback/store.mjs';
import { KINDS } from '../feedback/schema.mjs';

export function envInfo() {
  return { agents: enabledAgents(), users: FEATURES.multiUser ? 'multi' : 'solo' };
}

function clientErrors(fps) {
  if (!Array.isArray(fps) || !fps.length) return [];
  const want = new Set(fps.slice(0, 8).map(String));
  return recentErrors({ limit: 60, where: 'client' }).filter((e) => want.has(e.fp));
}

// 页面报错别刷爆磁盘：整个进程每分钟最多记 30 条
let clientBudget = { t: 0, n: 0 };

export function registerFeedbackRoutes(router, { identify }) {
  const J = (res, code, o) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(o)); };
  const who = (req) => {
    const id = identify(req);
    if (id.kind === 'admin') return { admin: true, owner: 'admin' };
    if (id.kind === 'user') return { admin: false, owner: 'user:' + id.user };
    return null;
  };
  const body = async (req, max = 64_000) => { try { return JSON.parse(await readBody(req, max)) || {}; } catch { return null; } };

  router.on('GET', '/api/feedback', (req, res) => {
    const w = who(req);
    if (!w) return J(res, 401, { error: 'unauthorized' });
    const sent = listSent().filter((s) => w.admin || s.owner === w.owner).slice(-30).reverse()
      .map(({ id, at, kind, source, title, issue, duplicate, private: priv }) => ({ id, at, kind, source, title, issue, duplicate, private: priv }));
    J(res, 200, { auto: getSettings().auto, canToggle: w.admin, sent, pending: w.admin ? listOutbox().length : 0, host: feedbackHost() });
  });

  router.on('POST', '/api/feedback/auto', async (req, res) => {
    const w = who(req);
    if (!w?.admin) return J(res, 403, { error: '只有管理员能改' });
    const b = await body(req, 1000);
    if (!b || typeof b.on !== 'boolean') return J(res, 400, { error: 'on 要是 true / false' });
    J(res, 200, setAuto(b.on));
  });

  router.on('POST', '/api/feedback/draft', async (req, res) => {
    const w = who(req);
    if (!w) return J(res, 401, { error: 'unauthorized' });
    const b = await body(req);
    if (!b) return J(res, 400, { error: 'bad json' });
    const kind = KINDS.includes(b.kind) && b.kind !== 'update_failed' ? b.kind : 'bug';
    try {
      const d = makeDraft({
        kind, source: 'web', owner: w.owner,
        description: b.description, lang: b.lang === 'en' ? 'en' : 'zh',
        env: { ...envInfo(), browser: b.browser, page: b.page, uiLang: b.lang === 'en' ? 'en' : 'zh' },
        trail: Array.isArray(b.trail) ? b.trail : [],
        // 页面报错已经经 client-error 记在服务端（归一、脱敏过），这里只认指纹
        errors: clientErrors(b.errorFps),
        // 普通账号：服务端的报错里可能有别人操作留下的痕迹（虽然脱敏过），只给管理员附
        withServerErrors: w.admin,
      });
      J(res, 200, { id: d.id, title: d.preview.title, body: d.preview.body, kind });
    } catch (e) {
      J(res, 400, { error: e?.message === 'empty report' ? '写一句发生了什么吧（这次没有自动收集到报错）' : String(e?.message || e) });
    }
  });

  router.on('POST', '/api/feedback/send', async (req, res) => {
    const w = who(req);
    if (!w) return J(res, 401, { error: 'unauthorized' });
    const b = await body(req, 1000);
    const d = loadDraft(b?.id);
    if (!d || d.owner !== w.owner) return J(res, 404, { error: '草稿过期了，重新写一份吧' });
    J(res, 200, await sendDraft(d.id));
  });

  router.on('POST', '/api/feedback/client-error', async (req, res) => {
    const w = who(req);
    if (!w) return J(res, 401, { error: 'unauthorized' });
    const now = Date.now();
    if (now - clientBudget.t > 60_000) clientBudget = { t: now, n: 0 };
    if (++clientBudget.n > 30) return J(res, 429, { error: 'too many' });
    const b = await body(req, 16_000);
    if (!b) return J(res, 400, { error: 'bad json' });
    const e = await recordError('client', { name: String(b.name || 'Error'), message: String(b.message || ''), stack: String(b.stack || '') });
    J(res, 200, { fp: e?.fp || null });
  });
}
