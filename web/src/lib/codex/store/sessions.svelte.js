// 线程与项目：列表、打开旧线程（还原工作记录）、新线程、项目、线程操作、‹ › 前后翻。

import { tr, t } from '../../i18n.js';
import { codexApi } from '../api.js';
import { mergeHistory } from '../turns.js';
import { codex, NEW, threadOf, blankThread, sessionMeta } from './state.svelte.js';
import { restoreFromLast, loadUsage } from './catalog.svelte.js';
import { noticeSessionSeen } from '../../notices.svelte.js';

const PROJ_KEY = 'bridge-codex-project';

export const errText = (e, fallback) => tr(e?.body?.error || e?.body?.message || (typeof e?.body === 'string' ? e.body : '') || e?.message) || fallback || t('操作失败');

export async function refreshSessions() {
  try {
    const [s, p] = await Promise.all([codexApi.sessions(), codexApi.projects()]);
    codex.sessions = (s?.sessions || []).filter((x) => !x.archived);
    codex.projects = p?.projects || [];
    codex.host = p?.host || codex.host;
    codex.listError = '';
  } catch (e) {
    codex.listError = errText(e, t('无法读取线程列表'));
  }
  settleProject();
}

/** 新线程的项目：上次明确用过的 → 最近线程的项目 → 只有一个项目时就它。绝不默认取第一个。 */
function settleProject() {
  if (codex.projectId && codex.projects.some((p) => p.id === codex.projectId)) return;
  let saved = '';
  try { saved = localStorage.getItem(PROJ_KEY) || ''; } catch {}
  if (saved && codex.projects.some((p) => p.id === saved)) { codex.projectId = saved; return; }
  const recent = [...codex.sessions].sort((a, b) => (b.mtime || 0) - (a.mtime || 0)).find((s) => s.projectId && codex.projects.some((p) => p.id === s.projectId));
  if (recent) { codex.projectId = recent.projectId; return; }
  if (codex.projects.length === 1) codex.projectId = codex.projects[0].id;
}

export function selectProject(id) {
  codex.projectId = id || '';
  try { localStorage.setItem(PROJ_KEY, codex.projectId); } catch {}
}

export async function createProjectAt(dir) {
  const r = await codexApi.createProject(dir);
  await refreshSessions();
  if (r?.project?.id) selectProject(r.project.id);
  return r?.project || null;
}

/* ---------------- 打开 / 新建 ---------------- */

function pushHistory(id) {
  if (codex.history[codex.histAt] === id) return;
  codex.history = [...codex.history.slice(0, codex.histAt + 1), id].slice(-50);
  codex.histAt = codex.history.length - 1;
}

export function goHistory(step) {
  const at = codex.histAt + step;
  if (at < 0 || at >= codex.history.length) return;
  codex.histAt = at;
  const id = codex.history[at];
  if (id) openThread(id, { fromHistory: true });
  else newThread({ fromHistory: true });
}

export function newThread({ projectId, fromHistory = false } = {}) {
  if (projectId) selectProject(projectId);
  const th = codex.threads[NEW];
  // 新线程那份里如果还挂着一轮没认领到 id 的在跑，别清掉它
  if (!th?.turns?.some((x) => x.live)) codex.threads[NEW] = blankThread('');
  codex.sessionId = '';
  codex.view = 'threads';
  if (!fromHistory) pushHistory('');
  loadUsage();
}

export async function openThread(id, { fromHistory = false } = {}) {
  if (!id) return newThread();
  const th = threadOf(id);
  const meta = sessionMeta(id);
  if (meta) { th.title = meta.title || th.title; th.projectId = meta.projectId || th.projectId; th.accountId = meta.accountId || th.accountId; }
  codex.sessionId = id;
  codex.view = 'threads';
  if (codex.unread[id]) { const u = { ...codex.unread }; delete u[id]; codex.unread = u; }
  noticeSessionSeen(id);
  if (!fromHistory) pushHistory(id);
  // 在跑的轮已经在缓存里一路收着事件：别拿历史盖掉它
  if (th.loaded || th.turns.some((x) => x.live)) { restoreFromLast(th.last); loadUsage(); return; }
  await loadThread(id);
}

export async function loadThread(id) {
  const th = threadOf(id);
  th.loading = true;
  th.error = '';
  try {
    const [s, h] = await Promise.all([
      codexApi.session(id),
      codexApi.turns(id).catch(() => null),
    ]);
    // 等的这一会儿里这条线程自己开跑了（别的设备、续跑）：不拿历史盖
    if (th.turns.some((x) => x.live)) return;
    const raw = Array.isArray(h?.turns) ? [...h.turns].reverse() : [];
    th.turns = mergeHistory(raw, s?.messages || []);
    th.cursor = h?.nextCursor || null;
    th.projectId = s?.projectId || th.projectId;
    th.accountId = s?.accountId || th.accountId;
    th.last = s?.last || null;
    th.ctx = ctxOf(s?.contextUsage);
    th.loaded = true;
    restoreFromLast(th.last);
    loadUsage();
  } catch (e) {
    th.error = errText(e, t('无法打开线程'));
  } finally {
    th.loading = false;
  }
}

/** 往上翻：更早的轮。 */
export async function loadOlder(id) {
  const th = threadOf(id);
  if (!th.cursor || th.loading) return;
  th.loading = true;
  try {
    const h = await codexApi.turns(id, { cursor: th.cursor });
    const older = mergeHistory([...(h?.turns || [])].reverse(), []);
    th.turns = [...older, ...th.turns];
    th.cursor = h?.nextCursor || null;
  } catch {} finally { th.loading = false; }
}

export function ctxOf(u) {
  if (!u) return null;
  const used = Number(u.usedTokens) || 0, total = Number(u.windowTokens) || 0;
  return { used, total, pct: total ? Math.min(100, (used / total) * 100) : Number(u.usedPercent) || 0 };
}

/* ---------------- 线程操作 ---------------- */

export async function renameThread(id, name) {
  const title = String(name || '').trim().slice(0, 200);
  if (!title) return;
  await codexApi.op('rename', id, { name: title });
  const th = threadOf(id);
  th.title = title;
  codex.sessions = codex.sessions.map((s) => (s.id === id ? { ...s, title } : s));
}

export async function archiveThread(id) {
  await codexApi.op('archive', id);
  codex.sessions = codex.sessions.filter((s) => s.id !== id);
  if (codex.sessionId === id) newThread();
}

export async function deleteThread(id) {
  const r = await codexApi.deleteSession(id);
  if (r && r.ok === false) throw Object.assign(new Error(r.error || ''), { body: r });
  codex.sessions = codex.sessions.filter((s) => s.id !== id);
  const next = { ...codex.threads };
  delete next[id];
  codex.threads = next;
  if (codex.sessionId === id) newThread();
}

/** 从某一轮分叉（不给 turnId = 整条）。成功后打开新线程。 */
export async function forkThread(id, turnId) {
  const r = await codexApi.op('fork', id, turnId ? { turnId } : {});
  await refreshSessions();
  if (r?.sessionId) await openThread(r.sessionId);
  return r?.sessionId || '';
}

export async function compactThread(id) {
  return codexApi.op('compact', id);
}
