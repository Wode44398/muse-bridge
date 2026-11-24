// 插件工作区插槽的数据层（服务端 src/plugins/workspace.mjs）：插件给「文件夹」（Antigravity 的工作空间 / Claude 的项目）的外观声明与菜单项。
// 这里只管数据与动作的落地，怎么画由各分页自己定（Antigravity 用 M3 语言，Claude 用 Anthropic 语言）。
//
//   GET  /api/plugins/ui/decor?agent=agy|claude → { decor: [{ plugin, pluginName, id, items }] }
//   GET  /api/plugins/ui 的 workspaceActions（由 pluginUi.svelte.js 拉，经 setWorkspaceActions 交到这里）
//   POST /api/plugins/ui/run kind: 'workspaceDialog' | 'workspaceAction'
//   总线 plugins.ui.decor / plugins.ui / plugins.changed → 重拉外观（去抖 200ms）
//
// 依赖纪律：本模块由 pluginUi.svelte.js 静态引入，这里绝不静态引回 pluginUi.svelte.js（成环）；
// 换页、聊天内核、agy 仓库、预览一律动态 import（同 pageNav.js / claudeHandoff.js：可能出现在 solo 入口里）。
import { api } from '../api.js';
import { busOn } from '../bus.js';
import { t, tr } from '../i18n.js';
import { showToast } from '../toast.svelte.js';
import { uiConfirm } from '../dialogs.js';
import { screenOn } from '../state.svelte.js';

export const WORKSPACE_AGENTS = Object.freeze(['agy', 'claude']);
const isAgent = (a) => WORKSPACE_AGENTS.includes(a);
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * decor[agent]：该分页的外观（服务端已按插件 id 排好）；loaded[agent]：拉到过一次。
 * actions：文件夹菜单项（uiView 的 workspaceActions）。snack：带撤销按钮的提示条（见 registerWorkspaceSnackHost）。
 */
export const workspaceUi = $state({
  decor: { agy: [], claude: [] },
  loaded: { agy: false, claude: false },
  actions: [],
  snack: null,
});

/** 走秒用的共享时钟（1 秒一跳）：组件里 $effect(() => useNowTick()) 挂上，读 nowTick.now 就会每秒重算。 */
export const nowTick = $state({ now: Date.now() });

// ── 路径比较（同 lib/agy/workspace-actions.js 的 sameDirPath；服务端 workspace.mjs samePath 同一套）──────────
export function normDirKey(p) {
  const s = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  return /^[A-Za-z]:/.test(s) ? s.toLowerCase() : s;
}
export const sameDir = (a, b) => { const na = normDirKey(a); return !!na && na === normDirKey(b); };

// ── 拉取 ──────────────────────────────────────────────────────────────────
let who = '';                         // 当前身份；pluginUi.svelte.js 的 syncPluginUi 经 workspaceIdentity 告诉这里
const wanted = new Set();             // 有分页要过外观的 agent：重拉只拉这些
const inflight = { agy: null, claude: null };
const again = { agy: false, claude: false };
let reloadTimer = null;
let watching = false;

function watch() {
  if (watching) return;
  watching = true;
  busOn((ev) => {
    const ty = ev?.type;
    if (ty === 'plugins.ui.decor' || ty === 'plugins.ui' || ty === 'plugins.changed') scheduleReload();
  });
}

function scheduleReload(ms = 200) {
  if (reloadTimer) clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => { reloadTimer = null; for (const a of wanted) loadDecor(a); }, ms);
}

/** 立刻拉一次某个分页的外观（一般不用直接调：decorOf 第一次被读时会自己拉，之后跟着总线重拉）。 */
export async function loadDecor(agent) {
  if (!isAgent(agent) || !who) return;
  wanted.add(agent);
  watch();
  if (inflight[agent]) { again[agent] = true; return inflight[agent]; }
  inflight[agent] = (async () => {
    do {
      again[agent] = false;
      const forWho = who;
      try {
        const r = await api.get('/api/plugins/ui/decor?agent=' + agent);
        if (forWho !== who) continue;
        workspaceUi.decor[agent] = arr(r?.decor).filter((d) => d && d.plugin && d.id).map((d) => ({ ...d, items: arr(d.items).filter((x) => x && x.path) }));
        workspaceUi.loaded[agent] = true;
      } catch (e) {
        // 旧服务端（没有这条接口）/ 没登录：当作没有外观；断网：留着上一份
        if (e?.status === 401 || e?.status === 403 || e?.status === 404 || e?.status === 501) { workspaceUi.decor[agent] = []; workspaceUi.loaded[agent] = true; }
      }
    } while (again[agent]);
  })().finally(() => { inflight[agent] = null; });
  return inflight[agent];
}

/** pluginUi.svelte.js 调：身份变了（'' = 退出登录）。清掉旧身份的外观，再按需重拉。 */
export function workspaceIdentity(key) {
  const k = String(key || '');
  if (k === who) return;
  who = k;
  for (const a of WORKSPACE_AGENTS) { workspaceUi.decor[a] = []; workspaceUi.loaded[a] = false; }
  workspaceUi.snack = null;
  if (k) for (const a of wanted) loadDecor(a);
}

/** pluginUi.svelte.js 调：uiView 拉到的 workspaceActions。 */
export function setWorkspaceActions(list) {
  workspaceUi.actions = arr(list).filter((a) => a && a.plugin && a.id).map((a) => ({
    ...a, agents: arr(a.agents).filter(isAgent), when: ['always', 'decorated', 'plain'].includes(a.when) ? a.when : 'always',
  }));
}

/** 菜单项全表（uiView 原样，含 agents / when / decor / hasDialog）。分页里用 workspaceMenuItems 拿过滤好的。 */
export const workspaceActions = () => workspaceUi.actions;

const firstLoad = new Set();
/** 某个分页的全部外观 [{ plugin, pluginName, id, items }]。第一次读时顺手拉一次（异步，不在读的当下写状态）。 */
export function decorOf(agent) {
  if (!isAgent(agent)) return [];
  // 身份还没就绪时先记下这个分页要过外观：workspaceIdentity 就绪时按 wanted 补拉（不记的话就绪后没人再读，就一直是空的）
  if (!who) wanted.add(agent);
  else if (!wanted.has(agent) && !firstLoad.has(agent)) {
    firstLoad.add(agent);
    queueMicrotask(() => { firstLoad.delete(agent); loadDecor(agent); });
  }
  return workspaceUi.decor[agent];
}

// 路径 → [条目（带 plugin / pluginName / id）]，按插件 id 排（服务端已排）。按外观数组本身缓存：重拉换了数组就重建。
const indexCache = new WeakMap();
function indexOf(agent) {
  const list = decorOf(agent);
  let idx = indexCache.get(list);
  if (idx) return idx;
  const byPath = new Map();
  const bySession = new Map();
  for (const d of list) {
    for (const it of d.items) {
      const k = normDirKey(it.path);
      const entry = { ...it, plugin: d.plugin, pluginName: d.pluginName, id: d.id };
      if (!byPath.has(k)) byPath.set(k, []);
      byPath.get(k).push(entry);
      for (const s of arr(it.sessions)) {
        if (s.agent !== agent || bySession.has(s.id)) continue;
        bySession.set(s.id, { by: s.by, plugin: d.plugin, id: d.id, path: it.path });
      }
    }
  }
  idx = { byPath, bySession };
  indexCache.set(list, idx);
  return idx;
}

/** 这个文件夹在这个分页要画的外观条目（同一路径多个插件都给时取插件 id 排第一的）；没有 → null。 */
export function decorFor(agent, path) {
  if (!path) return null;
  return indexOf(agent).byPath.get(normDirKey(path))?.[0] || null;
}

/** 本页一个会话的「谁开的」标记 → { by: 'agy' | 'claude', plugin, id, path } | null。 */
export function sessionMark(agent, sessionId) {
  if (!sessionId) return null;
  return indexOf(agent).bySession.get(String(sessionId)) || null;
}

/** 在本页这个文件夹下要列出的别的 agent 的会话：[{ agent, items: [{ id, title, meta, live }] }]。 */
export function peerSessionsFor(agent, path) {
  return arr(decorFor(agent, path)?.peerSessions);
}

// 这个插件的某个外观有没有给这个路径（when 判定用；不是「排第一的那个」）
function hasDecor(agent, path, plugin, decorId) {
  if (!decorId) return false;
  return arr(indexOf(agent).byPath.get(normDirKey(path))).some((e) => e.plugin === plugin && e.id === decorId);
}

/**
 * 文件夹菜单里该出现的插件项（同步、不发请求）：按 agents、when 过滤好。
 * → [{ plugin, pluginName, id, label, icon, danger, hasDialog }]；icon 可能是 'claude' / 'agy'（画该 agent 的单色标志），其余走 pluginIcon()。
 */
export function workspaceMenuItems(agent, { path } = {}) {
  if (!isAgent(agent) || !path) return [];
  return workspaceUi.actions.filter((a) => {
    if (!a.agents.includes(agent)) return false;
    if (a.when === 'always') return true;
    const has = hasDecor(agent, path, a.plugin, a.decor);
    return a.when === 'decorated' ? has : !has;
  }).map(({ plugin, pluginName, id, label, icon, danger, hasDialog }) => ({ plugin, pluginName, id, label, icon, danger: !!danger, hasDialog: !!hasDialog }));
}

// ── 对话框：各分页注册自己的组件 ─────────────────────────────────────────
const dialogHosts = { agy: [], claude: [] };
/**
 * 分页注册自己的对话框（组件挂载时调，返回反注册）。fn(dialog, meta) → Promise<结果>：
 *   dialog = 服务端规范化后的 Dialog（title / subtitle / hero / sections / fields / ok / cancel / danger / extra）；
 *   meta = { agent, plugin, pluginName, id, path, projectId }；
 *   结果：{ values: { 开关 id: 布尔 } }（按了确定）| { extra: true }（按了左下的次要按钮）| null（取消 / 关掉）。
 * 同一分页注册了多个时用最后注册的那个。
 */
export function registerWorkspaceDialog(agent, fn) {
  if (!isAgent(agent) || typeof fn !== 'function') return () => {};
  dialogHosts[agent].push(fn);
  return () => { const i = dialogHosts[agent].indexOf(fn); if (i >= 0) dialogHosts[agent].splice(i, 1); };
}

/** 弹一个工作区对话框：分页注册过就交给它；没注册就退回通用确认框（开关取缺省值、没有次要按钮）。 */
export async function openWorkspaceDialog(agent, dialog, meta = {}) {
  const host = dialogHosts[agent]?.at(-1);
  if (host) {
    try {
      const r = await host(dialog, { agent, ...meta });
      if (r && r.extra === true) return { extra: true };
      if (r && typeof r === 'object' && r.values !== undefined) return { values: cleanValues(dialog, r.values) };
      return null;
    } catch { return null; }
  }
  const ok = await uiConfirm(tr(dialog.title || '') || t('确定要执行吗？'), {
    detail: String(dialog.subtitle || ''), okLabel: tr(dialog.ok || '') || t('确定'), type: dialog.danger ? 'warning' : 'question',
  });
  return ok ? { values: cleanValues(dialog, {}) } : null;
}

// 只交声明过的开关，缺的用缺省值（服务端也会再滤一遍）
function cleanValues(dialog, values) {
  const out = {};
  const v = values && typeof values === 'object' ? values : {};
  for (const f of arr(dialog?.fields)) out[f.id] = typeof v[f.id] === 'boolean' ? v[f.id] : !!f.value;
  return out;
}

// ── 带撤销的提示条 ─────────────────────────────────────────────────────────
const snackHosts = { agy: 0, claude: 0 };
let snackTimer = null;
let snackSeq = 0;
/** 分页挂上自己的提示条组件时调（返回反注册）：workspaceUi.snack.agent 是这个分页时由它画。没有分页挂着时撤销退回普通提示（没有按钮）。 */
export function registerWorkspaceSnackHost(agent) {
  if (!isAgent(agent)) return () => {};
  snackHosts[agent]++;
  let done = false;
  return () => { if (!done) { done = true; snackHosts[agent]--; } };
}
/** 关掉提示条。 */
export function dismissWorkspaceSnack() {
  if (snackTimer) { clearTimeout(snackTimer); snackTimer = null; }
  workspaceUi.snack = null;
}
let pendingUndo = null;
function showSnack(agent, text, undo, meta) {
  if (!snackHosts[agent]) { if (text) showToast(text); return; }
  dismissWorkspaceSnack();
  workspaceUi.snack = { seq: ++snackSeq, agent, text: text || t('已完成'), undo: undo ? { label: tr(undo.label || '') || t('撤销') } : null };
  pendingUndo = undo ? { agent, action: undo.action, ...meta } : null;
  snackTimer = setTimeout(dismissWorkspaceSnack, undo ? 6000 : 3000);
}
/** 按了提示条上的撤销：直接跑那个动作（不弹它的确认框，开关取缺省值）。 */
export async function runWorkspaceSnackUndo() {
  const u = pendingUndo;
  pendingUndo = null;
  dismissWorkspaceSnack();
  if (!u) return null;
  return runWorkspaceAction(u.agent, { plugin: u.plugin, id: u.action, path: u.path, projectId: u.projectId }, { skipDialog: true });
}

// ── 执行 ─────────────────────────────────────────────────────────────────
const errText = (e) => tr((e?.body && typeof e.body === 'object' ? e.body.error : typeof e?.body === 'string' ? e.body : '') || '');
const runApi = (body) => api.post('/api/plugins/ui/run', body);

/**
 * 跑一个文件夹菜单项：有 dialog → 先取对话框、交给本分页注册的对话框组件 → 确定后带开关值执行；按了次要按钮就改跑 extra 指的那个动作。
 * 结果落地：toast / undo（提示条）/ open（'panel' | 网址 | Target）；之后总会重拉一次外观。
 * opts.skipDialog：不弹确认框直接跑（撤销用）。→ 服务端的 Result，取消或失败 → null。
 */
export async function runWorkspaceAction(agent, { plugin, id, path, projectId = null } = {}, { skipDialog = false } = {}) {
  if (!isAgent(agent) || !plugin || !id || !path) return null;
  const item = workspaceUi.actions.find((a) => a.plugin === plugin && a.id === id);
  const meta = { plugin, pluginName: item?.pluginName || plugin, id, path, projectId };
  let values = {};
  // 不在菜单表里的（Target / undo / extra 指向的、when 不让出现的）也照样问一次服务端有没有对话框
  if (!skipDialog && (item ? item.hasDialog : true)) {
    let dialog = null;
    try { dialog = (await runApi({ plugin, kind: 'workspaceDialog', id, args: { path, agent } }))?.dialog || null; }
    catch (e) { showToast(errText(e) || t('插件动作没有执行成功'), 'err'); return null; }
    if (dialog) {
      const r = await openWorkspaceDialog(agent, dialog, meta);
      if (!r) return null;
      if (r.extra) return dialog.extra?.action ? runWorkspaceAction(agent, { plugin, id: dialog.extra.action, path, projectId }) : null;
      values = r.values;
    }
  }
  let r;
  try { r = (await runApi({ plugin, kind: 'workspaceAction', id, args: { path, projectId, agent, values } })) || {}; }
  catch (e) { showToast(errText(e) || t('插件动作没有执行成功'), 'err'); return null; }
  const toast = typeof r.toast === 'string' ? r.toast : '';
  if (r.undo && r.undo.action) showSnack(agent, toast, r.undo, { plugin, path, projectId });
  else if (toast) showToast(toast);
  if (r.open === 'panel') {
    const { openPluginPanel } = await import('../pluginUi.svelte.js');
    await openPluginPanel(plugin, meta.pluginName);
  } else if (typeof r.open === 'string' && r.open) await openTarget({ url: r.open }, { plugin, path, agent, projectId });
  else if (r.open && typeof r.open === 'object') await openTarget(r.open, { plugin, path, agent, projectId });
  // decorChanged 立刻拉；没给也拉一次（外观多半跟着变了）
  if (r.decorChanged) for (const a of wanted) loadDecor(a);
  else scheduleReload(0);
  return r;
}

/**
 * 点了外观上的某处（Target）：
 *   { action }               → runWorkspaceAction（带上这个文件夹）
 *   { session: { agent, id }}→ 跨分页打开那个会话（Claude 走 pageNav 的 to:'session'；Antigravity 照 agentUi 的 openAgySessionTarget）
 *   { file: { rel, ws? } }   → pageNav 的 to:'file'（推进预览）
 *   { url }                  → 插件网址（pluginUi 的 openExternalUrl）
 * ctx = { plugin, path, agent, projectId }。→ 跳了 / 跑了回 true。
 */
export async function openTarget(target, { plugin = '', path = '', agent = 'claude', projectId = null } = {}) {
  if (!target || typeof target !== 'object') return false;
  try {
    if (target.action) return !!(await runWorkspaceAction(agent, { plugin, id: target.action, path, projectId }));
    if (target.session && typeof target.session === 'object') return await openSessionOf(plugin, target.session);
    if (target.folder && typeof target.folder === 'object') {
      const { agent: to, path: dir } = target.folder;
      // 这个文件夹在当前分页的外观条目（带 status：对方在这里跑着的会话优先打开）
      return await gotoPeerFolder(to, dir, decorFor(agent, dir) || decorFor(to, dir));
    }
    if (target.file && typeof target.file === 'object') {
      const { pageNav } = await import('../pageNav.js');
      return await pageNav(plugin, { to: 'file', rel: target.file.rel, ws: target.file.ws || '' });
    }
    if (typeof target.url === 'string') {
      const { openExternalUrl } = await import('../pluginUi.svelte.js');
      openExternalUrl(target.url);
      return true;
    }
  } catch (e) {
    try { console.warn('[workspace] openTarget', e?.message || e); } catch {}   // i18n-ignore 只进控制台
  }
  return false;
}

async function openSessionOf(plugin, { agent, id }) {
  const sid = String(id || '');
  if (!sid) return false;
  if (agent === 'claude') {
    const { pageNav } = await import('../pageNav.js');
    return pageNav(plugin, { to: 'session', session: sid });
  }
  if (agent !== 'agy') return false;
  if (!screenOn('agy')) { showToast(t('这个分页没有对你开放'), 'err'); return false; }
  const { gotoScreen } = await import('../claudeHandoff.js');
  await gotoScreen('agy');
  const { openAgySession, agy } = await import('../agy/store.svelte.js');
  if (agy.sessionId !== sid) await openAgySession(sid);
  return true;
}

/**
 * 点共用文件夹上对方的标识（Claude 侧的连接器方块 / Antigravity 侧的头像组）→ 跳到对方分页的这个文件夹。
 * target = 要去的分页（'agy' | 'claude'）；item = 这个文件夹的外观条目（带 plugin / status，可缺）。
 * 落点：对方正看着这个文件夹就不动；否则对方在这里正在跑的会话；否则这里最近的会话；都没有就在这里开新对话。
 */
export async function gotoPeerFolder(target, path, item = null) {
  const dir = String(path || '');
  if (!dir || !WORKSPACE_AGENTS.includes(target)) return false;
  if (!screenOn(target)) { showToast(t('这个分页没有对你开放'), 'err'); return false; }
  const st = item?.status;
  const running = st && st.agent === target && st.open?.session?.agent === target ? String(st.open.session.id || '') : '';
  if (target === 'agy') {
    const { gotoScreen } = await import('../claudeHandoff.js');
    await gotoScreen('agy');
    const { agy, openAgySession, newAgyChat } = await import('../agy/store.svelte.js');
    if (agy.sessionId && sameDir(agy.cwd, dir)) return true;
    const recent = running || agy.sessions.find((s) => sameDir(s.cwd, dir))?.sessionId || '';
    if (recent) { if (agy.sessionId !== recent) await openAgySession(recent); return true; }
    const proj = agy.projects.find((p) => sameDir(p.path, dir));
    newAgyChat(proj ? { projectId: proj.id } : { cwd: dir });
    return true;
  }
  // Claude 页：项目列表与会话在页面里（pc），由页面接 bridge:openproject 落地；页面刚换过来可能还没挂好，短暂重试
  const { gotoScreen } = await import('../claudeHandoff.js');
  await gotoScreen('claude');
  for (let i = 0; i < 20; i++) {
    const ev = new CustomEvent('bridge:openproject', { cancelable: true, detail: { path: dir, session: running } });
    if (!window.dispatchEvent(ev)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

// ── 走秒 ─────────────────────────────────────────────────────────────────
let tickUsers = 0;
let tickTimer = null;
/** 要走秒的组件在 $effect 里调：$effect(() => useNowTick())。有人用时 1 秒一跳，都撤了就停。 */
export function useNowTick() {
  tickUsers++;
  if (!tickTimer) { nowTick.now = Date.now(); tickTimer = setInterval(() => { nowTick.now = Date.now(); }, 1000); }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--tickUsers <= 0) { tickUsers = 0; clearInterval(tickTimer); tickTimer = null; }
  };
}
/** since（毫秒时间戳）到现在过了几秒（读 nowTick，所以在模板里会跟着走）；since 为 0 → 0。 */
export function sinceSeconds(since) {
  const s = Number(since) || 0;
  return s > 0 ? Math.max(0, Math.floor((nowTick.now - s) / 1000)) : 0;
}
