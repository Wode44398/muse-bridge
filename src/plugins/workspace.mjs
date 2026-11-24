// 工作区插槽（插件接口七期）：插件给「文件夹」（Antigravity 的工作空间 / Claude 的项目）加外观声明和菜单项。
//
//   ctx.ui.workspaceDecor({ id, who?, agents?, list(who, { agent }) → [条目] })     文件夹的外观（底板、标识、状态行、悬停卡、会话标记……）
//   ctx.ui.workspaceAction({ id, label, icon?, who?, agents?, when?, decor?, danger?, dialog?(who, { path, agent }), handler(who, { path, projectId, agent, values }) })
//   ctx.ui.refreshDecor(id?, { who }?)                                              数据变了：推 { type: 'plugins.ui.decor', plugin, id }
//
// 原则同 ui.mjs：插件只交声明（数据），各分页按自己的设计语言画。插件给的文字一律截断、去换行；路径、id、跳转目标都校验，
// 不认识的丢掉；list / dialog 3 秒封顶，handler 60 秒（同其它界面动作）；出错只写插件日志。
//
//   GET  /api/plugins/ui/decor?agent=agy|claude → { decor: [{ plugin, pluginName, id, items }] }（decorView）
//   POST /api/plugins/ui/run kind: 'workspaceDialog' { path, agent } → { dialog | null }
//                            kind: 'workspaceAction' { path, projectId, agent, values } → { toast?, open?, decorChanged?, undo? }
//   GET  /api/plugins/ui 的 workspaceActions（workspaceActionsView）
import { kernel } from './state.mjs';
import { busPublish, busPublishAll } from '../runtime/bus.mjs';
import { UI_SLOT, ID_RE, ICON_RE, str, audience, tr } from './ui-shared.mjs';

export const WORKSPACE_AGENTS = Object.freeze(['agy', 'claude']);
export const WORKSPACE_KINDS = Object.freeze(['workspaceDialog', 'workspaceAction']);
const WHEN = ['always', 'decorated', 'plain'];

// 时限与限额（测试里改小时限；别的模块别动）
export const WORKSPACE_LIMITS = { listMs: 3000, dialogMs: 3000, actionMs: 60_000 };
const MAX = { paths: 50, sections: 4, rows: 8, sessions: 200, peerItems: 20, dialogSections: 4, dialogItems: 6, fields: 4 };

const SESSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
// 对话框开关的 id：插件多半写驼峰（askFirst），所以比 ID_RE 宽
const FIELD_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const PATH_MAX = 1024;

const httpError = (msg, status) => Object.assign(new Error(msg), { status });
const warnOf = (owner, msg) => { try { kernel.contextOf(owner)?.warn(msg); } catch {} };
const isAgent = (a) => WORKSPACE_AGENTS.includes(a);
const agentList = (v) => [...new Set((Array.isArray(v) ? v : []).filter(isAgent))];
const icon = (v) => (typeof v === 'string' && ICON_RE.test(v) ? v : '');
const stamp = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0; };

/** 绝对路径（Windows 盘符 / UNC，或 / 开头），没有控制字符。不合格 → ''。不碰磁盘：只是给前端拿来比的键。 */
export function cleanAbsPath(p) {
  if (typeof p !== 'string') return '';
  const s = p.trim();
  if (!s || s.length > PATH_MAX || /[\u0000-\u001f\u007f]/.test(s)) return '';
  if (/^[A-Za-z]:[\\/]/.test(s) || /^\\\\[^\\]/.test(s) || s.startsWith('/')) return s;
  return '';
}

// 两种分页都认的路径比较（同前端 sameDirPath：去尾斜杠、反斜杠当正斜杠、带盘符的不分大小写）
export function samePath(a, b) {
  const na = String(a || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const nb = String(b || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (!na || !nb) return false;
  return /^[A-Za-z]:/.test(na) ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

/**
 * 点了去哪（Target）：只认四种，其余 → undefined。
 *   { action: '<本插件 workspaceAction id>' } | { session: { agent, id } } | { folder: { agent, path } } | { file: { rel, ws? } } | { url }
 * folder = 到那个 agent 分页的这个文件夹（落点由宿主定：那边正停在这里就不动 → 在跑的会话 → 最近的会话 → 新对话）。
 */
export function normTarget(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return undefined;
  if (typeof t.action === 'string') return ID_RE.test(t.action) ? { action: t.action } : undefined;
  if (t.folder && typeof t.folder === 'object') {
    const p = cleanAbsPath(t.folder.path);
    return isAgent(t.folder.agent) && p ? { folder: { agent: t.folder.agent, path: p } } : undefined;
  }
  if (t.session && typeof t.session === 'object') {
    const { agent, id } = t.session;
    return isAgent(agent) && typeof id === 'string' && SESSION_RE.test(id) ? { session: { agent, id } } : undefined;
  }
  if (t.file && typeof t.file === 'object') {
    const rel = typeof t.file.rel === 'string' ? t.file.rel.trim() : '';
    if (!rel || rel.length > 1000 || /[\u0000-\u001f\u007f]/.test(rel)) return undefined;
    const ws = typeof t.file.ws === 'string' && t.file.ws && !/[\u0000-\u001f\u007f]/.test(t.file.ws) ? t.file.ws.slice(0, 1024) : '';
    return { file: { rel, ...(ws ? { ws } : {}) } };
  }
  if (typeof t.url === 'string' && (/^https?:\/\//i.test(t.url) || (t.url.startsWith('/') && !t.url.startsWith('//')))) return { url: t.url.slice(0, 2000) };
  return undefined;
}
const withOpen = (obj, open) => { const o = normTarget(open); return o ? { ...obj, open: o } : obj; };
const link = (l) => {
  if (!l || typeof l !== 'object') return undefined;
  const open = normTarget(l.open);
  const label = str(l.label, 30);
  return open && label ? { label, open } : undefined;
};

// ── 外观条目 ─────────────────────────────────────────────────────────────
function normRow(r) {
  if (!r || typeof r !== 'object') return null;
  const text = str(r.text, 80);
  if (!text) return null;
  return withOpen({
    icon: icon(r.icon), agent: isAgent(r.agent) ? r.agent : '', live: r.live === true, text,
    meta: str(r.meta, 30), since: stamp(r.since), mono: r.mono === true,
  }, r.open);
}

function normCard(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return undefined;
  const sections = (Array.isArray(c.sections) ? c.sections : []).map((s) => {
    if (!s || typeof s !== 'object') return null;
    const rows = (Array.isArray(s.rows) ? s.rows : []).map(normRow).filter(Boolean).slice(0, MAX.rows);
    const l = link(s.link);
    const label = str(s.label, 30);
    if (!label && !rows.length) return null;
    return { label, ...(l ? { link: l } : {}), rows };
  }).filter(Boolean).slice(0, MAX.sections);
  let foot;
  if (c.foot && typeof c.foot === 'object') {
    const l = link(c.foot.link);
    const text = str(c.foot.text, 80);
    if (text || l) foot = { text, ...(l ? { link: l } : {}) };
  }
  const title = str(c.title, 40);
  const subtitle = str(c.subtitle, 120);
  if (!title && !subtitle && !sections.length && !foot) return undefined;
  return { title, subtitle, sections, ...(foot ? { foot } : {}) };
}

/** 一个外观条目 → 规范化后的条目；path 不合格 → null（整条丢掉）。 */
export function normDecorItem(x) {
  if (!x || typeof x !== 'object' || Array.isArray(x)) return null;
  const p = cleanAbsPath(x.path);
  if (!p) return null;
  const out = {
    path: p,
    panel: x.panel !== false,
    peers: agentList(x.peers),
    busy: agentList(x.busy),
    note: str(x.note, 60),
  };
  // 点文件夹上的标识（Claude 侧的连接器方块 / Antigravity 侧的头像组）去哪；不给就不跳
  const open = normTarget(x.open);
  if (open) out.open = open;
  if (x.status && typeof x.status === 'object') {
    const text = str(x.status.text, 60);
    if (text) out.status = withOpen({ agent: isAgent(x.status.agent) ? x.status.agent : '', text, since: stamp(x.status.since) }, x.status.open);
  }
  if (x.footer && typeof x.footer === 'object') {
    const text = str(x.footer.text, 80);
    if (text) out.footer = withOpen({ icon: icon(x.footer.icon), text }, x.footer.open);
  }
  const card = normCard(x.card);
  if (card) out.card = card;
  out.sessions = (Array.isArray(x.sessions) ? x.sessions : [])
    .filter((s) => s && isAgent(s.agent) && isAgent(s.by) && typeof s.id === 'string' && SESSION_RE.test(s.id))
    .slice(0, MAX.sessions).map((s) => ({ agent: s.agent, id: s.id, by: s.by }));
  const peers = new Map();   // 每个 agent 一组，重复的后面那组丢掉
  for (const g of Array.isArray(x.peerSessions) ? x.peerSessions : []) {
    if (!g || !isAgent(g.agent) || peers.has(g.agent)) continue;
    const items = (Array.isArray(g.items) ? g.items : [])
      .filter((it) => it && typeof it.id === 'string' && SESSION_RE.test(it.id))
      .slice(0, MAX.peerItems)
      .map((it) => ({ id: it.id, title: str(it.title, 80), meta: str(it.meta, 40), live: it.live === true }));
    peers.set(g.agent, { agent: g.agent, items });
  }
  out.peerSessions = [...peers.values()];
  return out;
}

// ── 登记 ─────────────────────────────────────────────────────────────────
function checkCommon(kind, spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error(`ctx.ui.${kind} 要一个对象`);
  if (spec.who != null && !['host', 'members'].includes(spec.who)) throw new Error("who 只能是 'host' / 'members'");
  if (!ID_RE.test(String(spec.id || ''))) throw new Error(`ctx.ui.${kind} 要有 id（小写字母开头，只用小写字母、数字、连字符）`);
  if (spec.agents != null) {
    const list = Array.isArray(spec.agents) ? spec.agents : [spec.agents];
    const bad = list.filter((a) => !isAgent(a));
    if (bad.length || !list.length) throw new Error(`ctx.ui.${kind} 的 agents 只认 ${WORKSPACE_AGENTS.join(' / ')}（给了「${bad.join('、')}」）`);
  }
}
const agentsOf = (spec) => (spec.agents == null ? [...WORKSPACE_AGENTS] : agentList(Array.isArray(spec.agents) ? spec.agents : [spec.agents]));

export function addWorkspaceDecor(ctx, spec) {
  checkCommon('workspaceDecor', spec);
  if (typeof spec.list !== 'function') throw new Error(`ctx.ui.workspaceDecor「${spec.id}」要 list(who, { agent }) 函数`);
  return ctx.contribute(UI_SLOT, { kind: 'workspaceDecor', spec: { id: spec.id, who: spec.who === 'members' ? 'members' : 'host', agents: agentsOf(spec), list: spec.list } });
}

export function addWorkspaceAction(ctx, spec) {
  checkCommon('workspaceAction', spec);
  if (typeof spec.handler !== 'function') throw new Error(`ctx.ui.workspaceAction「${spec.id}」要 handler`);
  if (spec.dialog != null && typeof spec.dialog !== 'function') throw new Error(`ctx.ui.workspaceAction「${spec.id}」的 dialog 要是函数`);
  if (spec.when != null && !WHEN.includes(spec.when)) throw new Error(`ctx.ui.workspaceAction「${spec.id}」的 when 只能是 ${WHEN.join(' / ')}`);
  if (spec.decor != null && !ID_RE.test(String(spec.decor))) throw new Error(`ctx.ui.workspaceAction「${spec.id}」的 decor 要是外观 id`);
  return ctx.contribute(UI_SLOT, { kind: 'workspaceAction', spec: {
    id: spec.id, label: str(spec.label, 30) || spec.id, icon: icon(spec.icon), who: spec.who === 'members' ? 'members' : 'host',
    agents: agentsOf(spec), when: spec.when || 'always', decor: spec.decor || '', danger: spec.danger === true,
    ...(spec.dialog ? { dialog: spec.dialog } : {}), handler: spec.handler,
  } });
}

// ctx.ui.refreshDecor：只是通知，不带数据——前端收到就重拉 /api/plugins/ui/decor
export function refreshDecor(ctx, id, { who } = {}) {
  if (id != null && id !== '' && !ID_RE.test(String(id))) throw new Error(`ctx.ui.refreshDecor 的外观 id「${id}」不对`);
  const msg = { type: 'plugins.ui.decor', plugin: ctx.id, id: id ? String(id) : '' };
  try {
    if (who && typeof who === 'object' && typeof who.key === 'string' && who.key) busPublish(who.key, msg);
    else busPublishAll(msg);
  } catch {}
}

// ── 视图 ─────────────────────────────────────────────────────────────────
const entriesOf = (kind) => (kernel.started ? kernel.slot(UI_SLOT).entries().filter(({ item }) => item.kind === kind) : []);

// 外观 id 缺省 = 本插件登记的第一个 decor
function decorIdOf(owner, spec) {
  if (spec.decor) return spec.decor;
  return entriesOf('workspaceDecor').find(({ owner: o }) => o === owner)?.item.spec.id || '';
}

/** /api/plugins/ui 的 workspaceActions：这个身份看得到的文件夹菜单项（when / agents 由前端按分页、路径过滤）。 */
export function workspaceActionsView(c, lang = 'zh') {
  return entriesOf('workspaceAction').filter(({ item }) => audience(item.spec.who, c)).map(({ item, owner }) => {
    const s = item.spec;
    return {
      plugin: owner, pluginName: kernel.rawRecord(owner)?.name || owner, id: s.id,
      label: tr(owner, 'workspaceAction', s.id, 'label', s.label, lang), icon: s.icon, agents: [...s.agents],
      when: s.when, decor: decorIdOf(owner, s), danger: s.danger, hasDialog: typeof s.dialog === 'function',
    };
  });
}

// 与 within 不同：要分得出超时（写插件日志）
async function capped(ms, fn) {
  let t;
  const TIMEOUT = Symbol('timeout');
  try {
    const v = await Promise.race([Promise.resolve().then(fn), new Promise((r) => { t = setTimeout(() => r(TIMEOUT), ms); t.unref?.(); })]);
    if (v === TIMEOUT) throw Object.assign(new Error(`超过 ${ms >= 1000 ? Math.round(ms / 1000) + ' 秒' : ms + ' 毫秒'}没回`), { timeout: true });
    return v;
  } finally { clearTimeout(t); }
}

/** 某个分页（agent = 'agy' | 'claude'）眼下要画的外观。各插件的 list 并发算、各自 3 秒封顶；按插件 id、外观 id 排好。 */
export async function decorView(c, agent) {
  if (!isAgent(agent)) throw httpError(`agent 只能是 ${WORKSPACE_AGENTS.join(' / ')}`, 400);
  const list = entriesOf('workspaceDecor').filter(({ item }) => item.spec.agents.includes(agent) && audience(item.spec.who, c));
  const decor = await Promise.all(list.map(async ({ item, owner }) => {
    const s = item.spec;
    let raw = [];
    try { raw = await capped(WORKSPACE_LIMITS.listMs, () => s.list(c, { agent })); }
    catch (e) { warnOf(owner, `工作区外观「${s.id}」的 list 出错：${String(e?.message || e).slice(0, 200)}`); raw = []; }
    const items = [];
    const seen = [];
    for (const x of Array.isArray(raw) ? raw : []) {
      const it = normDecorItem(x);
      if (!it || seen.some((p) => samePath(p, it.path))) continue;   // 同一外观里同一个路径只留第一条
      seen.push(it.path);
      items.push(it);
      if (items.length >= MAX.paths) break;
    }
    return { plugin: owner, pluginName: kernel.rawRecord(owner)?.name || owner, id: s.id, items };
  }));
  decor.sort((a, b) => (a.plugin < b.plugin ? -1 : a.plugin > b.plugin ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { decor };
}

// ── 对话框与执行 ─────────────────────────────────────────────────────────
/** 插件给的对话框 → 规范化（null / 非对象 → null）。 */
export function normDialog(d, fallbackTitle = '') {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  const sections = (Array.isArray(d.sections) ? d.sections : []).map((s) => {
    if (!s || typeof s !== 'object') return null;
    const items = (Array.isArray(s.items) ? s.items : []).map((it) => {
      if (!it || typeof it !== 'object') return null;
      const title = str(it.title, 40);
      if (!title) return null;
      const out = { icon: icon(it.icon), agent: isAgent(it.agent) ? it.agent : '', title, desc: str(it.desc, 120) };
      if (it.chip && typeof it.chip === 'object') {
        const chip = { ok: it.chip.ok === true, code: str(it.chip.code, 120), text: str(it.chip.text, 60) };
        if (chip.code || chip.text) out.chip = chip;
      }
      return out;
    }).filter(Boolean).slice(0, MAX.dialogItems);
    const label = str(s.label, 40);
    return label || items.length ? { label, items } : null;
  }).filter(Boolean).slice(0, MAX.dialogSections);
  const seen = new Set();
  const fields = (Array.isArray(d.fields) ? d.fields : []).filter((f) => {
    if (!f || f.type !== 'switch' || typeof f.id !== 'string' || !FIELD_RE.test(f.id) || seen.has(f.id)) return false;
    seen.add(f.id);
    return true;
  }).slice(0, MAX.fields).map((f) => ({ id: f.id, type: 'switch', label: str(f.label, 40) || f.id, desc: str(f.desc, 120), value: f.value === true }));
  const out = {
    title: str(d.title, 40) || str(fallbackTitle, 40),
    subtitle: str(d.subtitle, 120),
    sections, fields,
    ok: str(d.ok, 20), cancel: str(d.cancel, 20), danger: d.danger === true,
  };
  const heroPeers = d.hero && typeof d.hero === 'object' ? agentList(d.hero.peers) : [];
  if (heroPeers.length) out.hero = { peers: heroPeers };
  if (d.extra && typeof d.extra === 'object' && typeof d.extra.action === 'string' && ID_RE.test(d.extra.action)) {
    const label = str(d.extra.label, 20);
    if (label) out.extra = { label, action: d.extra.action, danger: d.extra.danger === true };
  }
  return out;
}

/** handler 的返回值 → { toast?, open?, decorChanged?, undo? }。open 认 'panel'、网址字符串，或一个 Target。 */
export function normWorkspaceResult(r) {
  if (typeof r === 'string') return r ? { toast: r.slice(0, 300) } : {};
  if (!r || typeof r !== 'object') return {};
  const out = {};
  if (typeof r.toast === 'string' && r.toast) out.toast = r.toast.slice(0, 300);
  if (r.open === 'panel') out.open = 'panel';
  else if (typeof r.open === 'string') { const t = normTarget({ url: r.open }); if (t) out.open = t.url; }
  else { const t = normTarget(r.open); if (t) out.open = t; }
  if (r.decorChanged === true) out.decorChanged = true;
  if (r.undo && typeof r.undo === 'object' && typeof r.undo.action === 'string' && ID_RE.test(r.undo.action)) {
    out.undo = { label: str(r.undo.label, 20) || '撤销', action: r.undo.action };
  }
  return out;
}

function actionSpec(c, plugin, id) {
  const hit = entriesOf('workspaceAction').filter(({ item, owner }) => owner === plugin && item.spec.id === id).at(-1);
  if (!hit || !audience(hit.item.spec.who, c)) throw httpError('没有这个文件夹动作', 404);
  return hit.item.spec;
}

async function computeDialog(c, plugin, spec, view) {
  if (typeof spec.dialog !== 'function') return null;
  try {
    return normDialog(await capped(WORKSPACE_LIMITS.dialogMs, () => spec.dialog(c, view)), spec.label);
  } catch (e) {
    const why = String(e?.message || e).slice(0, 200);
    warnOf(plugin, `文件夹动作「${spec.id}」的 dialog 出错：${why}`);
    // 对话框算不出来就不往下跑：没确认过的危险动作不能因为插件出错直接执行
    throw httpError('确认框没有准备好：' + why, e?.timeout ? 504 : 500);
  }
}

/** runUi 的 workspaceDialog / workspaceAction。 */
export async function runWorkspace(c, { plugin, kind, id, args }) {
  const spec = actionSpec(c, plugin, id);
  const a = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  const p = cleanAbsPath(a.path);
  if (!p) throw httpError('path 要是文件夹的绝对路径', 400);
  const agent = isAgent(a.agent) ? a.agent : 'claude';
  if (kind === 'workspaceDialog') return { dialog: await computeDialog(c, plugin, spec, { path: p, agent }) };
  // values 只收对话框里声明过的开关（布尔）；没给的用对话框里的缺省值。所以有 dialog 的动作这里再算一遍对话框。
  const values = {};
  const dlg = await computeDialog(c, plugin, spec, { path: p, agent });
  const given = a.values && typeof a.values === 'object' && !Array.isArray(a.values) ? a.values : {};
  for (const f of dlg?.fields || []) values[f.id] = typeof given[f.id] === 'boolean' ? given[f.id] : f.value;
  const view = { path: p, projectId: typeof a.projectId === 'string' && a.projectId ? a.projectId.slice(0, 120) : null, agent, values };
  let r;
  try { r = await capped(WORKSPACE_LIMITS.actionMs, () => spec.handler(c, view)); }
  catch (e) {
    const why = String(e?.message || e).slice(0, 500);
    warnOf(plugin, `文件夹动作「${spec.id}」出错：${why}`);
    throw httpError(why, e?.timeout ? 504 : 500);
  }
  const out = normWorkspaceResult(r);
  // 同一个人的别的设备也重拉外观（发起的这一端自己会重拉）
  try { if (c?.key) busPublish(c.key, { type: 'plugins.ui.decor', plugin, id: '' }); } catch {}
  return out;
}

