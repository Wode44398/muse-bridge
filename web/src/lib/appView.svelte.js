// 声明式应用的数据层：插件只回一棵积木 JSON，bridge 用自己的组件画（components/appview）。
//
//   POST /api/plugins/ui/view { plugin, id, state }                         → { tree, state }
//   POST /api/plugins/ui/run  { plugin, kind:'app', id, args:{ action, args, state } } → { state, tree, toast?, nav? }
//
// 每个应用键一份 { state, tree, loading, error, busy }（appViews[appKey]）：
//   state 由前端按应用键保管、每次随请求带上去（插件不能拿它做权限判断，服务端每次都重新校验身份）；
//   离开分页（App 的保活 LRU 把它卸了）也不丢，下次挂载带着它重拉一次 view，回来还是原样。
//   换了登录身份就整份作废——同一台设备换人，别把上一个人的应用状态带给下一个人。
//
// 一个应用同一时刻只跑一个动作（防连点，也防两个动作各自带着旧 state 上去、后回来的那个把先回来的盖掉）；
// 动作跑着的时候收到 plugins.app.refresh 就记一笔，动作回来之后再重拉。
//
// 积木组件拿到的 ctx：{ app, appKey, plugin, run(act, extra) → Promise<boolean>, busy(act, extra?) → boolean }
//   另多给两个只读字段 variant（'touch' | 'desktop'）与 dark，给要分两套样子的积木用（不用也行）。
//   act = 积木里的 Act：动作名字符串，或 { name, args?, confirm? }；extra 并进 args（list 行 { id }、table 行 { row }、
//   开关 { value }、tabs { tab }、表单 { values }）。busy() 不给参数 = 这个应用有没有动作在跑。
import { me, ui } from './state.svelte.js';
import { api } from './api.js';
import { busOn } from './bus.js';
import { showToast } from './toast.svelte.js';
import { t, tr } from './i18n.js';
import { uiConfirm } from './dialogs.js';
import { closePage } from './pageMorph.js';
import { pageNav } from './pageNav.js';
import { openExternalUrl } from './pluginUi.svelte.js';
import { isNativeDesktop } from './nativeDesktop.js';
import { bidiIsolate } from './selfMount.js';

const ACT_RE = /^[a-zA-Z][\w-]{0,40}$/;

/** appKey → { state, tree, loading, error, busy, seq, again, owner }（$state 深代理，积木组件直接读）。 */
export const appViews = $state({});

const ownerNow = () => (me.kind && me.kind !== 'none' ? me.kind + ':' + (me.user || '') : '');
const keyOf = (app) => (app ? app.key || 'app:' + app.plugin + ':' + app.id : '');
const errText = (e) => tr((e?.body && typeof e.body === 'object' ? e.body.error : e?.body) || '') || '';

/** 取这个应用键的那一份；没有就建（只在事件 / 挂载里调，别在 $derived 里调——会写 state）。 */
function entry(key) {
  const owner = ownerNow();
  let e = appViews[key];
  if (!e || e.owner !== owner) {
    appViews[key] = { state: null, tree: null, loading: false, error: '', busy: null, seq: 0, again: false, owner };
    e = appViews[key];
  }
  return e;
}

/** 规整 Act：→ { name, args, confirm, danger } | null（名字不合法的按没有动作处理，服务端也会再校验一遍）。 */
export function normAct(act) {
  if (typeof act === 'string') return ACT_RE.test(act) ? { name: act, args: {}, confirm: '', danger: false } : null;
  if (!act || typeof act !== 'object' || typeof act.name !== 'string' || !ACT_RE.test(act.name)) return null;
  const args = act.args && typeof act.args === 'object' && !Array.isArray(act.args) ? act.args : {};
  // danger：ActButton 给危险按钮加的，只决定确认框「确定」画不画红，不进请求
  return { name: act.name, args, confirm: typeof act.confirm === 'string' ? act.confirm : '', danger: act.danger === true };
}

// 动作的身份：名字 + 动作自带参数 + 并进去的参数。busy(act, extra) 按它认「是不是这一个在转圈」
const sigOf = (a, extra) => a.name + '\u0000' + safeJson(a.args) + '\u0000' + (extra === undefined ? '' : safeJson(extra));
function safeJson(v) { try { return JSON.stringify(v ?? null); } catch { return ''; } }

/** 树：服务端回 Block[] 或 { blocks }，都收成数组；别的形状当空树。 */
const asTree = (tr0) => (Array.isArray(tr0) ? tr0 : tr0 && Array.isArray(tr0.blocks) ? tr0.blocks : []);

/** 拉（或重拉）一次 view。挂载时、收到 plugins.app.refresh、点「刷新」、出错后「重试」都走这里。 */
export async function loadView(app) {
  const key = keyOf(app);
  if (!key || !app?.plugin || !app?.id) return;
  const e = entry(key);
  if (e.busy) { e.again = true; return; }   // 动作回来会带新树，回来之后再拉
  const seq = ++e.seq;
  e.loading = true;
  try {
    const r = await api.post('/api/plugins/ui/view', { plugin: app.plugin, id: app.id, state: e.state ?? null });
    if (appViews[key] !== e || e.seq !== seq) return;   // 拉的途中换了人 / 又发了更新的请求：这份作废
    if (r && 'state' in r) e.state = r.state ?? null;
    e.tree = asTree(r?.tree);
    e.error = '';
  } catch (err) {
    if (appViews[key] !== e || e.seq !== seq) return;
    // 还有上一份树就留着（断网时照样能看），只在完全没东西可画时进出错页
    e.error = errText(err) || (err?.status ? t('服务器返回 {code}', { code: err.status }) : t('网络连接失败'));
    if (e.tree) showToast(t('没能刷新这个应用：{msg}', { msg: e.error }), 'err');
  } finally {
    if (appViews[key] === e && e.seq === seq) e.loading = false;
  }
}

/** 应用页 ⋯ 菜单的「刷新」：带着现有 state 重拉一次（state 不清——清了等于重开，插件要「重置」自己出一个动作）。 */
export function reloadView(app) { if (app) loadView(app); }

/** 按下一个动作。回 true = 插件的动作执行成功（取消确认、被防连点挡掉、出错都回 false）。 */
export async function runAction(app, act, extra, { onBack = null, isFront = null } = {}) {
  const key = keyOf(app);
  const a = normAct(act);
  if (!key || !a) return false;
  const e = entry(key);
  if (e.busy) {
    // 动作串行是有意的，但被挡下的那一下要有个交代，不然看着像没点上。连点同一个（它在转圈）、确认框挂着时不提示
    if (!e.busy.asking && e.busy.sig !== sigOf(a, extra)) showToast(t('上一个操作还没做完，等它做完再点'));
    return false;
  }
  // 先占住再问：确认框挂着的时候再点一次，不会叠出第二个框
  const sig = sigOf(a, extra);
  e.busy = { sig, name: a.name, asking: !!a.confirm };
  try {
    if (a.confirm) {
      const ok = await uiConfirm(a.confirm.slice(0, 200), {
        title: t('来自插件「{plugin}」', { plugin: bidiIsolate(app.pluginName || app.plugin) }), type: 'question', danger: a.danger,
      });
      if (!ok || appViews[key] !== e) return false;
      e.busy = { sig, name: a.name, asking: false };
    }
    const args = extra && typeof extra === 'object' ? { ...a.args, ...extra } : { ...a.args };
    const r = await api.post('/api/plugins/ui/run', { plugin: app.plugin, kind: 'app', id: app.id, args: { action: a.name, args, state: e.state ?? null } });
    if (appViews[key] !== e) return false;
    e.seq++;   // 动作回来的树最新：还在路上的 view 回来就作废
    if (r && 'state' in r) e.state = r.state ?? null;
    if (r && r.tree !== undefined) { e.tree = asTree(r.tree); e.error = ''; }
    if (typeof r?.toast === 'string' && r.toast) showToast(r.toast.slice(0, 300));
    // 动作最长跑 60 秒，回来时人可能早去了别处：不在前台就只更新树、弹 toast，不替他跳走（同 PluginFrame 的前台关）
    if (r?.nav && (!isFront || isFront())) navTo(app, r.nav, onBack);
    return true;
  } catch (err) {
    showToast(errText(err) || (err?.status === 413 ? t('应用的状态太大了') : t('插件动作没有执行成功')), 'err');
    return false;
  } finally {
    if (appViews[key] === e) {
      e.busy = null;
      if (e.again) { e.again = false; loadView(app); }
    }
  }
}

/** 这个动作是不是正在跑（按钮转圈用）。不给 act = 这个应用有没有动作在跑；不给 extra = 不管并进去的参数（同名同参的都算）。 */
export function actionBusy(app, act, extra) {
  const b = appViews[keyOf(app)]?.busy;
  if (!b || b.asking) return false;
  if (act === undefined) return true;
  const a = normAct(act);
  if (!a || a.name !== b.name) return false;
  if (extra === undefined) return b.sig.startsWith(a.name + '\u0000' + safeJson(a.args) + '\u0000');
  return b.sig === sigOf(a, extra);
}

// 动作回来的 nav（服务端已规范成下面几种，这里仍当不可信输入：形状不对就不跳）：
//   { session } → Claude 页打开这个会话；{ file: { rel, ws? } } → 预览；{ app } → 打开应用（'<id>' 本插件 / '<插件>:<id>'）；
//   { url } → 外部打开（http(s) 或站内 /）；'back' → 退出这个应用页；'home' → 回根页。
// 跳会话 / 跳应用带 comeBack（同 PluginFrame）：应用就画在这个界面里，系统返回回到这一页
function navTo(app, nav, onBack) {
  const pid = app.plugin;
  if (nav === 'back') { if (onBack) onBack(); else if (ui.screen === keyOf(app)) closePage(keyOf(app)); return; }
  if (nav === 'home') { pageNav(pid, { to: 'home' }); return; }
  if (!nav || typeof nav !== 'object') return;
  if (typeof nav.session === 'string') { pageNav(pid, { to: 'session', session: nav.session }, { comeBack: true }); return; }
  if (nav.file && typeof nav.file === 'object') { pageNav(pid, { to: 'file', rel: nav.file.rel, ws: nav.file.ws || '' }); return; }
  if (typeof nav.app === 'string') { pageNav(pid, { to: 'app', app: nav.app }, { comeBack: true }); return; }
  if (typeof nav.url === 'string') openExternalUrl(nav.url);
}

// 画布在不在使用者眼前。保活在后台的应用分页（inert / visibility 藏起来）、休眠的 Claude 页、切走的浏览器标签、
// 设置这类全屏浮层盖着时都算不在。不学 PluginFrame 取点判遮挡：动作刚从确认框回来时框还在播退场动画，取点会把它当成遮挡
export function viewOnScreen(el) {
  if (!el || !el.isConnected || document.visibilityState !== 'visible' || el.closest('[inert]')) return false;
  if (ui.settingsOpen || ui.routinesOpen || ui.loginOpen || ui.serverSwitcherOpen) return false;
  // 两套选项名都给：老一点的 Chromium 只认 checkVisibilityCSS
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true });
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility === 'visible';
}

// ── 挂载与推送 ──────────────────────────────────────────────────────────
// 正挂着的应用（同一个应用可能同时挂在应用页和 Claude 侧栏里，按次数记）；ctx.ui.refresh 推过来时只重拉挂着的，
// 没挂着的下次挂载本来就会重拉
const mounted = new Map();   // appKey → { n, app }
let listening = false;
function listen() {
  if (listening) return;
  listening = true;
  busOn((ev) => {
    if (ev?.type !== 'plugins.app.refresh') return;
    for (const [key, m] of mounted) {
      if (m.app.plugin === ev.plugin && (!ev.id || m.app.id === ev.id)) loadView(m.app);
      else if (key === 'app:' + ev.plugin + ':' + ev.id) loadView(m.app);
    }
  });
}

/** AppView 挂载时调：登记、拉一次 view；回注销函数。 */
export function mountAppView(app) {
  const key = keyOf(app);
  if (!key) return () => {};
  listen();
  const m = mounted.get(key);
  if (m) { m.n++; m.app = app; } else mounted.set(key, { n: 1, app });
  loadView(app);
  return () => {
    const x = mounted.get(key);
    if (!x) return;
    if (--x.n <= 0) mounted.delete(key);
  };
}

/** 应用项换了新的一份：推送重拉时用新的那份，并带着现有 state 重拉一次。 */
export function touchAppView(app) {
  const m = mounted.get(keyOf(app));
  if (!m || m.app === app) return;
  m.app = app;
  // 新对象 = pluginUi 重拉过（插件 reload / 开关 / 改了登记）。插件代码可能已经变了，可保活在后台的那页不会重新挂载，
  // 不在这里重拉的话，用户切回来看到的还是旧代码算出来的树
  loadView(app);
}

/** 给积木组件的 ctx。getApp / getOnBack 是取值函数：应用项与返回动作换了，ctx 不用重建；isFront 判画布在不在前台。 */
export function makeCtx(getApp, { getOnBack = () => null, isFront = null } = {}) {
  return {
    get app() { return getApp(); },
    get appKey() { return keyOf(getApp()); },
    get plugin() { return getApp()?.plugin || ''; },
    get variant() { return isNativeDesktop() ? 'desktop' : 'touch'; },
    get dark() { return ui.theme !== 'light'; },
    run: (act, extra) => runAction(getApp(), act, extra, { onBack: getOnBack(), isFront }),
    busy: (act, extra) => actionBusy(getApp(), act, extra),
  };
}
