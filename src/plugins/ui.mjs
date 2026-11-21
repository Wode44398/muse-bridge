// 界面扩展（插件接口四期，第三批）：ctx.ui.*——插件往 bridge 自己的界面里加东西。
//
// 原则：手机 App 不跑第三方代码。所以这里登记的大多是【声明】（标题、图标、文字、按钮），由 bridge 自己画；
// 按下去执行的是插件服务端的 handler（POST /api/plugins/ui/run）。只有 workbench 是插件页面（不透明源 iframe，同插件面板，
// App 里点开独立干净页面）。
//
//   ctx.ui.homeCard({ id, title, icon?, order?, who?, data?(who) → { text?, tone?, items?: [{ label, value }], badge? }, open?: 'panel' | { action } | { url } })
//   ctx.ui.workbench({ id, title, icon?, page, who? })                    Claude 工作台一个标签（插件页面；SDK 的 bridge.context() 拿当前会话）
//   ctx.ui.command({ name, description, who?, template? | handler?(who, { args, sessionId, agent }) })   输入框「/」菜单
//   ctx.ui.composerAction({ id, label, icon?, who?, handler(who, { sessionId, text, agent }) })            输入框「＋」菜单
//   ctx.ui.messageAction({ id, label, icon?, who?, roles?, handler(who, { sessionId, text, role, agent }) }) 消息的操作菜单
//   ctx.ui.sessionAction({ id, label, icon?, who?, handler(who, { sessionId, title, agent }) })            会话列表的菜单
//   ctx.ui.theme({ vars: { '--名字': 值 }, who? })                         主题变量（只收 -- 开头的名字，值过滤 url( / expression( / ; { }）
//   ctx.ui.app({ id, title, page, icon?, who?, order?, badge?: string | (who) => string | number })   插件应用：主页图标 + 全屏分页
//                                                                         （同清单 ui.apps，校验见 app-spec.mjs；同 id 的盖住清单里的）
//   ctx.ui.app({ id, title, view(who, { state }), actions?: { 名字: (who, { args, state }) }, state?, … })   声明式应用：
//                                                                         bridge 按积木画（ui-blocks.mjs），POST /api/plugins/ui/view 取树，
//                                                                         POST /api/plugins/ui/run { kind: 'app' } 按动作；pin: 'sidebar' 固定到 Claude 侧栏
//   ctx.ui.refresh(appId, { who }?)                                       让开着这个声明式应用的页面重拉（不给 who 推给所有人）
//   ctx.ui.fileHandler({ id, title, exts | match: { ext }, app, who? })   文件「用 X 打开」→ 本插件的页面型应用（要声明 page.files）
//   ctx.ui.command 另认 palette: true（同时收进命令面板）
// handler 回：字符串（当 toast）或 { toast?, insert?（插进输入框）, send?: true（插进去顺手发出）, open?: 'panel' | 网址 }。
// who：'host'（缺省，只给服务器主机）| 'members'（成员也给）。英文界面：插件 locales/en.json 的 ui.<种类>.<id>.<字段> 覆盖人话。
import { kernel } from './state.mjs';
import { busPublish, busPublishAll } from '../runtime/bus.mjs';
import { normApp, APP_ID_RE, MAX_APPS, isReservedTitle, ACTION_NAME_RE, STATE_MAX, jsonBytes } from './app-spec.mjs';
import { normalizeBlocks } from './ui-blocks.mjs';

export const UI_SLOT = 'ui';
export const UI_KINDS = Object.freeze(['homeCard', 'workbench', 'command', 'composerAction', 'messageAction', 'sessionAction', 'theme']);
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const CMD_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ICON_RE = /^[a-z][a-z0-9-]{0,23}$/;
const str = (v, n) => (v == null ? '' : String(v).replace(/[\r\n]+/g, ' ').trim().slice(0, n));

function check(kind, spec) {
  if (!spec || typeof spec !== 'object') throw new Error(`ctx.ui.${kind} 要一个对象`);
  if (spec.who && !['host', 'members'].includes(spec.who)) throw new Error("who 只能是 'host' / 'members'");
  if (kind === 'theme') {
    if (!spec.vars || typeof spec.vars !== 'object') throw new Error('ctx.ui.theme 要 { vars }');
    return;
  }
  if (kind === 'command') {
    if (!CMD_RE.test(String(spec.name || ''))) throw new Error(`命令名「${spec.name}」不对（小写字母开头，只用小写字母、数字、连字符）`);
    if (typeof spec.template !== 'string' && typeof spec.handler !== 'function') throw new Error(`命令 /${spec.name} 要有 template 或 handler`);
    return;
  }
  if (!ID_RE.test(String(spec.id || ''))) throw new Error(`ctx.ui.${kind} 要有 id（小写字母开头，只用小写字母、数字、连字符）`);
  if (kind === 'workbench' && (typeof spec.page !== 'string' || !spec.page || spec.page.includes('..'))) throw new Error('ctx.ui.workbench 要 page（插件目录里的页面，如 web/bench.html）');
  if (['composerAction', 'messageAction', 'sessionAction'].includes(kind) && typeof spec.handler !== 'function') throw new Error(`ctx.ui.${kind} 要 handler`);
}

export function makeUi(ctx) {
  const add = (kind) => (spec) => { check(kind, spec); return ctx.contribute(UI_SLOT, { kind, spec }); };
  return {
    ...Object.fromEntries(UI_KINDS.map((k) => [k, add(k)])),
    app: (spec) => addApp(ctx, spec),
    refresh: (appId, opts) => refreshApp(ctx, appId, opts),
    fileHandler: (spec) => addFileHandler(ctx, spec),
  };
}

// 声明式应用的时限（测试里改小；别的模块别动它）
export const APP_LIMITS = { viewMs: 5000, actionMs: 60_000 };
const ARGS_MAX = 256 * 1024;

const httpError = (msg, status) => Object.assign(new Error(msg), { status });
const planOf = (owner) => kernel.rawRecord(owner)?.extra?.permissions;
// 插件清单 permissions 里声明的页面能力名（page.chat / page.files 子集）
const pagePerms = (owner) => {
  const list = planOf(owner);
  return Array.isArray(list) ? list.map((p) => (typeof p === 'string' ? p : p?.id)).filter((p) => p === 'page.chat' || p === 'page.files') : [];
};

// 这个插件清单里声明的应用（discover.mjs 的 normUi 规范化过，跟着插件开关走，不经插槽）
const staticApps = (owner) => {
  const list = kernel.rawRecord(owner)?.extra?.ui?.apps;
  return Array.isArray(list) ? list : [];
};

// ctx.ui.app：校验与清单 ui.apps 同一套（app-spec.mjs）。id / 标题 / page 不合格直接抛（插件作者当场看到）；
// 图标文件缺失或超限只 warn 并退回内置图标——图标画坏了不该让整个插件启用失败。
function addApp(ctx, spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('ctx.ui.app 要一个对象');
  if (spec.who != null && !['host', 'members'].includes(spec.who)) throw new Error("who 只能是 'host' / 'members'");
  if (spec.badge != null && !['string', 'number', 'function'].includes(typeof spec.badge)) throw new Error('ctx.ui.app 的 badge 要是字符串、数字或函数');
  const { app, fatal, warn } = normApp(spec, { dir: ctx.meta?.dir || null, allowView: true });
  if (!app) throw new Error('ctx.ui.app：' + fatal);
  // 声明式：函数与初始 state 挂回登记项（normApp 的结果是纯数据）。初始 state 登记时就拷一份——
  // 插件之后改自己那个对象不该改掉「新打开的应用」看到的初始值。
  // 拷贝走 JSON 来回而不是 structuredClone：校验用的就是 JSON 规则（函数被静默丢掉），structuredClone 遇到函数会抛英文错；
  // Date 之类也得在登记时就变成字符串，否则第一次 view 拿到对象、之后随请求回来的是字符串。
  const live = app.kind === 'view'
    ? { view: spec.view, actions: { ...(spec.actions || {}) }, state: spec.state === undefined ? {} : JSON.parse(JSON.stringify(spec.state)) }
    : {};
  // 上限按「清单 + 动态」合起来的不同 id 算：动态登记绕不过清单的 8 个
  const ids = new Set(staticApps(ctx.id).map((a) => a.id));
  for (const { item, owner } of kernel.slot(UI_SLOT).entries()) if (owner === ctx.id && item.kind === 'app') ids.add(item.spec.id);
  if (!ids.has(app.id) && ids.size >= MAX_APPS) throw new Error(`一个插件最多 ${MAX_APPS} 个应用，「${app.id}」登记不了`);
  for (const w of warn) ctx.warn(w);
  return ctx.contribute(UI_SLOT, { kind: 'app', spec: { ...app, ...(spec.badge != null ? { badge: spec.badge } : {}), ...live } });
}

// ctx.ui.refresh：数据在插件那头变了（定时任务、外部回调），让正开着这个应用的页面重拉 view。
// 只是个通知，不带数据——state 在前端，重拉时随请求带上来。
function refreshApp(ctx, appId, { who } = {}) {
  const id = String(appId || '');
  if (!APP_ID_RE.test(id)) throw new Error(`ctx.ui.refresh 的应用 id「${appId ?? ''}」不对`);
  const msg = { type: 'plugins.app.refresh', plugin: ctx.id, id };
  try {
    if (who && typeof who === 'object' && typeof who.key === 'string' && who.key) busPublish(who.key, msg);
    else busPublishAll(msg);
  } catch {}
}

// ctx.ui.fileHandler：文件「用 X 打开」。只能指向本插件的页面型应用——声明式应用拿不到文件句柄（页面 SDK 才有 files）。
// 应用要先登记（清单里的或先调过 ctx.ui.app），免得登记一个点了打不开的入口。
const EXT_RE = /^[a-z0-9][a-z0-9+_-]{0,15}$/;
function addFileHandler(ctx, spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new Error('ctx.ui.fileHandler 要一个对象');
  if (spec.who != null && !['host', 'members'].includes(spec.who)) throw new Error("who 只能是 'host' / 'members'");
  if (!ID_RE.test(String(spec.id || ''))) throw new Error('ctx.ui.fileHandler 要有 id（小写字母开头，只用小写字母、数字、连字符）');
  const title = str(spec.title, 200);
  if (!title || [...title].length > 20) throw new Error(`文件处理器「${spec.id}」的 title 要 1～20 字（菜单里显示「用「标题」打开」）`);
  const rawExts = spec.exts != null ? spec.exts : spec.match?.ext;
  const list = (Array.isArray(rawExts) ? rawExts : rawExts != null ? [rawExts] : []).map((x) => String(x ?? '').trim().toLowerCase().replace(/^\.+/, ''));
  const exts = [...new Set(list)];
  if (!exts.length) throw new Error(`文件处理器「${spec.id}」要给 exts（扩展名列表，如 ['csv', 'tsv']）`);
  const badExt = exts.find((x) => !EXT_RE.test(x));
  if (badExt != null) throw new Error(`文件处理器「${spec.id}」的扩展名「${badExt}」不对（小写字母、数字，不带点）`);
  if (exts.length > 20) throw new Error(`文件处理器「${spec.id}」最多 20 个扩展名`);
  const ref = String(spec.app || '');
  const [p, a] = ref.includes(':') ? ref.split(':', 2) : [ctx.id, ref];
  if (p !== ctx.id) throw new Error(`文件处理器「${spec.id}」只能指向本插件的应用（app 给「${ref}」不行）`);
  if (!APP_ID_RE.test(a)) throw new Error(`文件处理器「${spec.id}」要 app（本插件页面型应用的 id）`);
  let target = staticApps(ctx.id).find((x) => x.id === a) || null;
  for (const { item, owner } of kernel.slot(UI_SLOT).entries()) if (owner === ctx.id && item.kind === 'app' && item.spec.id === a) target = item.spec;
  if (!target) throw new Error(`文件处理器「${spec.id}」指向的应用「${a}」没登记（清单 ui.apps 里写，或先调 ctx.ui.app）`);
  if (target.kind === 'view') throw new Error(`文件处理器「${spec.id}」要指向页面型应用，「${a}」是声明式应用（拿不到文件）`);
  if (!pagePerms(ctx.id).includes('page.files')) throw new Error('ctx.ui.fileHandler 要插件在清单 permissions 里声明 page.files');
  return ctx.contribute(UI_SLOT, { kind: 'fileHandler', spec: { id: spec.id, title, exts, app: a, who: spec.who === 'members' ? 'members' : 'host' } });
}

// 登记变了就推给在线页面（各插槽据此重拉 /api/plugins/ui）。
// 清单里的 apps 不经插槽：插件开关、出错、市场回退时插槽不一定动，所以内核 'change' 也要看——去抖 300ms，
// 且只在「开着的插件的清单应用」真变了才推（改个配置也会 change，不该让每个在线页面都重拉一遍、重算主页卡片数据）。
let pub = null;
export function watchUi() {
  if (pub || !kernel.started) return;
  const push = () => { try { busPublishAll({ type: 'plugins.ui', at: Date.now() }); } catch {} };
  const offSlot = kernel.slot(UI_SLOT).onChange(push);
  const sig = () => JSON.stringify(kernel.list().filter((p) => p.active && p.extra?.ui?.apps?.length).map((p) => [p.id, p.name, p.extra.ui.apps]));
  let last = sig();
  let timer = null;
  const offChange = kernel.on('change', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      let now;
      try { now = sig(); } catch { return; }
      if (now !== last) { last = now; push(); }
    }, 300);
    timer.unref?.();
  });
  pub = () => { offSlot(); offChange(); clearTimeout(timer); };
}

const audience = (who, c) => (who === 'members' ? c.kind === 'admin' || c.kind === 'user' : c.kind === 'admin');

// 英文词条：locales/en.json → ui.<种类>.<id>.<字段>
function tr(owner, kind, id, field, zh, lang) {
  if (!/^en/i.test(lang || '')) return zh;
  const v = kernel.rawRecord(owner)?.extra?.i18n?.en?.ui?.[kind]?.[id]?.[field];
  return typeof v === 'string' && v.trim() ? v.trim() : zh;
}

const SAFE_CSS = /^[^;{}<>]{0,120}$/;
const BAD_CSS = /(url\s*\(|expression\s*\(|@import|javascript:)/i;

async function within(ms, fn) {
  let t;
  try { return await Promise.race([Promise.resolve().then(fn), new Promise((r) => { t = setTimeout(() => r(undefined), ms); t.unref?.(); })]); }
  finally { clearTimeout(t); }
}

// ── 插件应用 ─────────────────────────────────────────────────────────────
// 清单（静态）+ ctx.ui.app（动态）合并，同插件同 id 动态盖静态（同 id 动态登记多次，后登记的赢）。
// 清单应用只算开着的插件；动态的随插件停用自动撤掉，不另查开关（插件 apply 还没跑完时它已经登记、该看得见）。
function appSpecs() {
  const map = new Map();
  for (const p of kernel.list()) {
    if (!p.active) continue;
    for (const a of staticApps(p.id)) map.set(p.id + ':' + a.id, { owner: p.id, spec: a });
  }
  for (const { item, owner } of kernel.slot(UI_SLOT).entries()) {
    if (item.kind === 'app') map.set(owner + ':' + item.spec.id, { owner, spec: item.spec });
  }
  return [...map.values()];
}

/** 同步查一个应用的登记（不算角标）：签票、agent 操作用它，别用会等 3 秒的 uiView。看不到 / 没有 → null。 */
export function findApp(c, plugin, id) {
  const spec = appSpecOf(c, plugin, id);
  if (!spec) return null;
  const who = spec.who || 'host';
  return spec.kind === 'view'
    ? { plugin: String(plugin), id: spec.id, kind: 'view', title: spec.title, who }
    : { plugin: String(plugin), id: spec.id, kind: 'page', page: spec.page, title: spec.title, who };
}

// findApp 的内部版：回登记项本身（声明式应用的 view / actions / state 在上面）
function appSpecOf(c, plugin, id) {
  if (!kernel.started || !c) return null;
  const p = String(plugin || '');
  const a = String(id || '');
  if (!APP_ID_RE.test(a) || !kernel.has(p)) return null;
  let spec = null;
  for (const { item, owner } of kernel.slot(UI_SLOT).entries()) if (owner === p && item.kind === 'app' && item.spec.id === a) spec = item.spec;
  if (!spec && kernel.isActive(p)) spec = staticApps(p).find((x) => x.id === a) || null;
  if (!spec || !audience(spec.who || 'host', c)) return null;
  return spec;
}

/** 同步查一个文件处理器（给 handles 的 via 用）：插件开着、身份看得到它、它指向的页面型应用也看得到。没有 → null。 */
export function findFileHandler(c, plugin, id) {
  if (!kernel.started || !c) return null;
  const p = String(plugin || '');
  const h = String(id || '');
  if (!ID_RE.test(h) || !kernel.isActive(p)) return null;
  let spec = null;
  for (const { item, owner } of kernel.slot(UI_SLOT).entries()) if (owner === p && item.kind === 'fileHandler' && item.spec.id === h) spec = item.spec;
  if (!spec || !audience(spec.who || 'host', c)) return null;
  const app = findApp(c, p, spec.app);
  if (!app || app.kind !== 'page') return null;
  return { plugin: p, id: h, title: spec.title, exts: [...spec.exts], app: 'app:' + p + ':' + spec.app };
}

/**
 * 这个身份能不能用某插件的页面能力（_bridge 的 kv / grants / chat / files / host）。
 * 插件开着；主机放行；成员要这个插件有【对成员开放的页面】——ui.who=members 的面板，或 who=members 的应用 / 工作台标签
 * （清单与 ctx.ui.* 动态登记都算）。只开给主机的插件，成员就算拿到页面地址、自己拼请求也用不了。
 */
export function canUsePluginPages(c, pluginId) {
  const id = String(pluginId || '');
  if (!c || !kernel.started || !kernel.isActive(id)) return false;
  if (c.kind === 'admin') return true;
  if (c.kind !== 'user') return false;
  const ui = kernel.get(id)?.extra?.ui;
  if (ui && ui.panel && ui.who === 'members') return true;
  if (staticApps(id).some((a) => a && a.who === 'members')) return true;
  for (const { item, owner } of kernel.slot(UI_SLOT).entries()) {
    if (owner === id && (item.kind === 'app' || item.kind === 'workbench') && item.spec?.who === 'members') return true;
  }
  return false;
}

// 图标地址：web/… 相对路径 → /plugins/<插件>/web/…（逐段编码，路由那头整体解码）
const assetUrl = (owner, rel) => '/plugins/' + owner + '/' + String(rel).split('/').map(encodeURIComponent).join('/');
const appIcon = (owner, icon) => (icon && typeof icon.light === 'string'
  ? { light: assetUrl(owner, icon.light), dark: assetUrl(owner, icon.dark || icon.light) }
  : { name: icon && typeof icon.name === 'string' ? icon.name : 'plugin' });

// 角标：插件给的字符串 / 数字 / 函数（与主页卡片 data 同一套：3 秒封顶，出错只写插件日志）。0、空、null 不显示，截 4 字。
// 数字超过三位写成 999+：截成前 4 位会把 12345 显示成 1234，看着像个真数。
async function appBadge(owner, s, c) {
  let v = s.badge;
  if (typeof v === 'function') {
    try { v = await within(3000, () => s.badge(c)); } catch (e) { v = null; kernel.contextOf(owner)?.warn('应用角标出错：' + String(e?.message || e).slice(0, 200)); }
  }
  if (v == null || v === false || v === 0) return '';
  const text = String(v).replace(/[\r\n]+/g, ' ').trim();
  if (/^\d+$/.test(text)) { const n = Number(text); return n === 0 ? '' : n > 999 ? '999+' : String(n); }
  return [...text].slice(0, 4).join('');
}

async function appsView(c, lang) {
  const en = /^en/i.test(lang || '');
  const list = appSpecs().filter(({ spec }) => audience(spec.who || 'host', c));
  const items = await Promise.all(list.map(async ({ owner, spec: s }) => {
    const rec = kernel.rawRecord(owner);
    const enName = en ? rec?.extra?.i18n?.en?.name : null;
    let title = s.title;
    if (en) {
      // 英文标题：locales/en.json 的 ui.app.<id>.title 优先，其次清单 titleEn；撞保留名的不用
      const t = [...str(tr(owner, 'app', s.id, 'title', '', lang), 200)].slice(0, 30).join('');
      title = (t && !isReservedTitle(t) ? t : '') || s.titleEn || s.title;
    }
    // pin 只在有值时出现；perms 一律给数组（没声明页面权限就是 []），调用方不用分「缺字段」和「空」两种情况
    return {
      key: 'app:' + owner + ':' + s.id, plugin: owner,
      pluginName: (typeof enName === 'string' && enName.trim()) || rec?.name || owner,
      id: s.id, title, ...(s.kind === 'view' ? { kind: 'view' } : { kind: 'page', page: s.page }), icon: appIcon(owner, s.icon),
      order: Number(s.order) || 0, badge: await appBadge(owner, s, c), who: s.who || 'host',
      ...(s.pin === 'sidebar' ? { pin: 'sidebar' } : {}),
      perms: pagePerms(owner),
    };
  }));
  return items.sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title));
}

/** 这个身份能看到的全部界面扩展（主页卡片的数据、应用角标现算，每个 3 秒封顶）。c = 身份上下文；lang = 界面语言。 */
export async function uiView(c, lang = 'zh') {
  const out = { homeCards: [], workbench: [], commands: [], composerActions: [], messageActions: [], sessionActions: [], theme: {}, apps: [], fileHandlers: [] };
  if (!kernel.started) return out;
  const cards = [];
  for (const { item, owner } of kernel.slot(UI_SLOT).entries()) {
    const s = item.spec;
    if (item.kind === 'app') continue;   // 应用单独合并（appsView），要和清单里的一起算
    if (!audience(s.who || 'host', c)) continue;
    const pname = kernel.rawRecord(owner)?.name || owner;
    const id = s.id || s.name;
    const T = (field, zh) => tr(owner, item.kind, id, field, zh, lang);
    switch (item.kind) {
      case 'homeCard':
        cards.push((async () => {
          let data = null;
          if (typeof s.data === 'function') {
            try { data = await within(3000, () => s.data(c)); } catch (e) { kernel.contextOf(owner)?.warn('主页卡片数据出错：' + String(e?.message || e).slice(0, 200)); }
          }
          const open = s.open === 'panel' ? { panel: true } : s.open?.action ? { action: str(s.open.action, 40) } : typeof s.open?.url === 'string' && /^(https?:\/\/|\/)/.test(s.open.url) ? { url: s.open.url.slice(0, 2000) } : null;
          return {
            plugin: owner, pluginName: pname, id, title: T('title', str(s.title, 40) || pname), icon: ICON_RE.test(s.icon || '') ? s.icon : 'plugin', order: Number(s.order) || 0, open,
            data: data && typeof data === 'object' ? {
              text: str(data.text, 200), tone: ['ok', 'warn', 'error', 'idle'].includes(data.tone) ? data.tone : '', badge: str(data.badge, 12),
              items: (Array.isArray(data.items) ? data.items : []).slice(0, 6).map((x) => ({ label: str(x?.label, 30), value: str(x?.value, 80) })),
            } : null,
          };
        })());
        break;
      case 'workbench':
        out.workbench.push({ plugin: owner, pluginName: pname, id, title: T('title', str(s.title, 20) || pname), icon: ICON_RE.test(s.icon || '') ? s.icon : 'plugin', page: String(s.page).replace(/^\/+/, '') });
        break;
      case 'command':
        out.commands.push({
          plugin: owner, pluginName: pname, name: s.name, description: T('description', str(s.description, 120)), mode: typeof s.handler === 'function' ? 'action' : 'template',
          ...(typeof s.template === 'string' ? { template: s.template.slice(0, 4000) } : {}),
          ...(s.palette === true ? { palette: true } : {}),
        });
        break;
      case 'composerAction':
      case 'sessionAction':
        out[item.kind + 's'].push({ plugin: owner, pluginName: pname, id, label: T('label', str(s.label, 30) || id), icon: ICON_RE.test(s.icon || '') ? s.icon : '' });
        break;
      case 'messageAction':
        out.messageActions.push({ plugin: owner, pluginName: pname, id, label: T('label', str(s.label, 30) || id), icon: ICON_RE.test(s.icon || '') ? s.icon : '', roles: Array.isArray(s.roles) ? s.roles.filter((r) => r === 'user' || r === 'assistant') : ['assistant'] });
        break;
      case 'fileHandler': {
        // 指向的应用这个身份看不到（应用只开给主机、或被撤了），处理器也不给
        const app = findApp(c, owner, s.app);
        if (!app || app.kind !== 'page') break;
        const title = [...str(T('title', s.title), 200)].slice(0, 20).join('') || s.title;
        out.fileHandlers.push({ plugin: owner, pluginName: pname, id, title, exts: [...s.exts], app: 'app:' + owner + ':' + s.app });
        break;
      }
      case 'theme':
        for (const [k, v] of Object.entries(s.vars || {})) {
          if (!/^--[a-zA-Z0-9-]{1,40}$/.test(k)) continue;
          const val = String(v ?? '');
          if (!SAFE_CSS.test(val) || BAD_CSS.test(val)) continue;
          out.theme[k] = val;
        }
        break;
      default:
    }
  }
  // 卡片数据与应用角标一起等（各自 3 秒封顶），不排队
  const [cardList, appList] = await Promise.all([Promise.all(cards), appsView(c, lang)]);
  out.homeCards = cardList.sort((a, b) => a.order - b.order);
  out.apps = appList;
  return out;
}

function findHandler(owner, kind, id) {
  const hit = kernel.slot(UI_SLOT).entries().find(({ item, owner: o }) => o === owner && item.kind === kind && (item.spec.id || item.spec.name) === id);
  return hit ? hit.item.spec : null;
}

// ── 声明式应用 ───────────────────────────────────────────────────────────
// state 由前端按应用键保管、每次随请求带上来（服务端不存）：所以进出都查能不能 JSON 化、有没有超 256 KB。
// 插件不能拿 state 做权限判断——那是前端给的；要长期保存的数据存 ctx.store 或插件数据目录。

// 与 within 不同：超时要能分辨出来（view 超时要画错误树、动作超时回 504）
async function deadline(ms, fn) {
  let t;
  try {
    return await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_, rej) => { t = setTimeout(() => rej(Object.assign(new Error('timeout'), { timeout: true })), ms); t.unref?.(); }),
    ]);
  } finally { clearTimeout(t); }
}

// 时限的人话（测试里会改成几十毫秒，别显示成「0 秒」）
const secs = (ms) => (ms >= 1000 ? Math.round(ms / 1000) + ' 秒' : ms + ' 毫秒');

function inState(spec, state) {
  if (state == null) return structuredClone(spec.state ?? {});
  const n = jsonBytes(state);
  if (n < 0) throw httpError('state 要能 JSON 化', 400);
  if (n > STATE_MAX) throw httpError('应用 state 超过 256 KB（大数据存 ctx.store 或插件数据目录）', 413);
  return JSON.parse(JSON.stringify(state));
}

function viewSpec(c, plugin, id) {
  const p = String(plugin || '');
  if (!kernel.started || !kernel.isActive(p)) throw httpError('插件没开', 404);
  const spec = appSpecOf(c, p, id);
  if (!spec) throw httpError('没有这个应用', 404);
  if (spec.kind !== 'view' || typeof spec.view !== 'function') throw httpError('这个应用是插件页面，不是声明式应用', 400);
  return spec;
}

// 算一棵树：view 5 秒封顶；出错 / 超时 → 只有一块 empty 的树（「应用出错了」+ 原因），写插件日志，不抛给前端
async function renderView(owner, spec, c, state) {
  const opts = { plugin: owner, actions: Object.keys(spec.actions || {}), perms: (planOf(owner) || []).map((p) => (typeof p === 'string' ? p : p?.id)) };
  try {
    const raw = await deadline(APP_LIMITS.viewMs, () => spec.view(c, { state }));
    return normalizeBlocks(raw, opts);
  } catch (e) {
    const why = e?.timeout ? `界面计算超过 ${secs(APP_LIMITS.viewMs)}没回` : String(e?.message || e).slice(0, 200);
    kernel.contextOf(owner)?.warn(`应用「${spec.id}」的 view 出错：${why}`);
    return [{ type: 'empty', title: '应用出错了', desc: why }];
  }
}

/** 声明式应用取界面（POST /api/plugins/ui/view）：state 为空用初始 state。→ { tree, state } */
export async function viewApp(c, { plugin, id, state } = {}) {
  const spec = viewSpec(c, plugin, id);
  const st = inState(spec, state);
  return { tree: await renderView(String(plugin), spec, c, st), state: st };
}

// 动作回的 nav → 前端认的几种跳转；不认识的丢掉（不报错：跳转是锦上添花，动作本身已经做完了）
const PLUGIN_ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
function normNav(nav, owner) {
  if (nav === 'back' || nav === 'home') return nav;
  if (!nav || typeof nav !== 'object' || Array.isArray(nav)) return undefined;
  if (typeof nav.session === 'string' && nav.session.trim()) return { session: nav.session.trim().slice(0, 120) };
  if (nav.file && typeof nav.file === 'object' && typeof nav.file.rel === 'string' && nav.file.rel.trim() && !nav.file.rel.includes(String.fromCharCode(0))) {
    return { file: { rel: nav.file.rel.trim().slice(0, 1000), ...(typeof nav.file.ws === 'string' && nav.file.ws ? { ws: nav.file.ws.slice(0, 80) } : {}) } };
  }
  if (typeof nav.app === 'string' && nav.app) {
    const [p, a] = nav.app.includes(':') ? nav.app.split(':', 2) : [owner, nav.app];
    return PLUGIN_ID_RE.test(p) && APP_ID_RE.test(a) ? { app: p + ':' + a } : undefined;
  }
  if (typeof nav.url === 'string' && (/^https?:\/\//i.test(nav.url) || (nav.url.startsWith('/') && !nav.url.startsWith('//')))) return { url: nav.url.slice(0, 2000) };
  return undefined;
}

// runUi 的 kind: 'app'：args = { action, args, state } → 调动作（60 秒封顶）→ 用新 state 重算 view → { state, tree, toast?, nav? }
async function runApp(c, plugin, id, a) {
  const spec = viewSpec(c, plugin, id);
  const name = typeof a.action === 'string' ? a.action : '';
  const fn = ACTION_NAME_RE.test(name) && Object.hasOwn(spec.actions || {}, name) ? spec.actions[name] : null;
  if (typeof fn !== 'function') throw httpError(`应用没有「${name}」这个动作`, 404);
  const st = inState(spec, a.state);
  const args = a.args && typeof a.args === 'object' && !Array.isArray(a.args) ? a.args : {};
  if (jsonBytes(args) > ARGS_MAX) throw httpError('动作参数超过 256 KB', 413);
  const owner = String(plugin);
  let r;
  try { r = await deadline(APP_LIMITS.actionMs, () => fn(c, { args, state: st })); }
  catch (e) {
    const why = e?.timeout ? `动作「${name}」超过 ${secs(APP_LIMITS.actionMs)}没回` : String(e?.message || e).slice(0, 500);
    kernel.contextOf(owner)?.warn(`应用「${spec.id}」的动作出错：${why}`);
    throw httpError(why, e?.timeout ? 504 : 500);
  }
  let next = st;
  const out = {};
  if (typeof r === 'string') out.toast = r.slice(0, 300);
  else if (r && typeof r === 'object') {
    if (r.state !== undefined) {
      const n = jsonBytes(r.state);
      if (n < 0) throw httpError(`动作「${name}」回的 state 不能 JSON 化`, 500);
      if (n > STATE_MAX) throw httpError(`动作「${name}」回的 state 超过 256 KB（大数据存 ctx.store 或插件数据目录）`, 413);
      next = JSON.parse(JSON.stringify(r.state));
    }
    if (typeof r.toast === 'string' && r.toast) out.toast = r.toast.slice(0, 300);
    const nav = normNav(r.nav, owner);
    if (nav !== undefined) out.nav = nav;
  }
  return { state: next, tree: await renderView(owner, spec, c, next), ...out };
}

/** 按下一个界面动作：kind = command / composerAction / messageAction / sessionAction / homeCard（open.action 指的那个 ctx.action）/ app（声明式应用的动作）。 */
export async function runUi(c, { plugin, kind, id, args }) {
  if (!kernel.started || !kernel.isActive(String(plugin || ''))) throw Object.assign(new Error('插件没开'), { status: 404 });
  if (kind === 'app') return runApp(c, plugin, id, args && typeof args === 'object' ? args : {});
  const spec = findHandler(plugin, kind, id);
  if (!spec || !audience(spec.who || 'host', c)) throw Object.assign(new Error('没有这个界面动作'), { status: 404 });
  if (typeof spec.handler !== 'function') throw Object.assign(new Error('这个动作没有 handler'), { status: 400 });
  const a = args && typeof args === 'object' ? args : {};
  const view = {
    sessionId: typeof a.sessionId === 'string' ? a.sessionId.slice(0, 80) : null,
    agent: a.agent === 'dimensio' ? 'dimensio' : 'claude',
    ...(kind === 'command' ? { args: str(a.args, 4000) } : {}),
    ...(kind === 'composerAction' ? { text: String(a.text ?? '').slice(0, 20_000) } : {}),
    ...(kind === 'messageAction' ? { text: String(a.text ?? '').slice(0, 100_000), role: a.role === 'user' ? 'user' : 'assistant' } : {}),
    ...(kind === 'sessionAction' ? { title: str(a.title, 200) } : {}),
  };
  let r;
  try { r = await within(60_000, () => spec.handler(c, view)); }
  catch (e) { throw Object.assign(new Error(String(e?.message || e).slice(0, 500)), { status: 500 }); }
  if (typeof r === 'string') return { toast: r.slice(0, 300) };
  if (!r || typeof r !== 'object') return {};
  return {
    ...(typeof r.toast === 'string' ? { toast: r.toast.slice(0, 300) } : {}),
    ...(typeof r.insert === 'string' ? { insert: r.insert.slice(0, 20_000) } : {}),
    ...(r.send === true ? { send: true } : {}),
    ...(r.open === 'panel' ? { open: 'panel' } : typeof r.open === 'string' && /^(https?:\/\/|\/)/.test(r.open) ? { open: r.open.slice(0, 2000) } : {}),
  };
}
