// 侧边工作区的状态工厂：每个 agent 分页（Claude / Codex / Antigravity / dimensio）各建一个实例，
// 外壳（components/dock/Workbench.svelte）与共用面板只认这一个形状，不认是哪一家。
//
// state 的字段：
//   open / views / view / last / multi / max —— 开着哪几张卡（语义见 ./views.js）
//   ws        = 面板的作用域（当前会话的工作空间绝对路径）；变了面板经 {#key} 整体重建
//   sessionId = 浏览器按会话各开一份时用的会话 id（'' = 整个工作空间共用那份）
//   meta      = /api/claude/dock/meta 的结果（rel / git / branch / shell / gone），换 ws 清空
//   browserLive / termLive = agent 动了浏览器 / 终端而卡片没开时的提示
//   filesTarget = 文件卡的定位目标 { seq, rel, ws, open }（seq 递增让文件页每次都重挂）
//   focus     = 被点名的卡 { view, seq }（已经开着时外壳描一圈提示）
//   noAuto    = agent 动了浏览器 / 终端时不自动拉开工作区，只亮提示点
import { api } from '../api.js';
import { recall, remember } from '../lastKnown.js';
import { normCols, normWeights } from './cards.js';
import { openPatch, closeAllPatch, closeViewPatch, multiPatch, prunePatch } from './views.js';
import { isPluginView, workbenchByKey, openWorkbenchStandalone } from '../pluginUi.svelte.js';
import { inAndroidApp } from '../pluginPanels.svelte.js';

const hosts = new WeakMap();   // state 代理 → host（面板只拿到 state，要回头找自己的宿主）
export const hostOf = (state) => hosts.get(state) || null;
// 状态不由 createDockHost 管的宿主（dimensio：状态在它自己那边）把适配出来的 host 登记进来
export const registerDockHost = (state, host) => { hosts.set(state, host); return host; };

let seq = 0;

// 各工作空间上次拿到的 meta（分支 / 是否 worktree / 能不能开 worktree 会话），按 ws 记最近的一批（lib/lastKnown）。
// 新对话的归属芯片行要它：没有就先只画「电脑 · 文件夹」，一秒后分支胶囊补进来、芯片换行，整个输入区被顶高一截
const META_MAX = 24;
const metaMemo = (() => { const m = recall('dock.meta'); return m && typeof m === 'object' ? m : {}; })();
function keepMeta(ws, m) {
  if (!ws || !m || m.gone) return;
  delete metaMemo[ws];
  metaMemo[ws] = { rel: m.rel ?? null, git: !!m.git, branch: m.branch || null, worktree: !!m.worktree, shell: m.shell, wtNew: !!m.wtNew, ...(m.snap ? { snap: true } : {}) };
  const keys = Object.keys(metaMemo);
  for (const k of keys.slice(0, Math.max(0, keys.length - META_MAX))) delete metaMemo[k];
  remember('dock.meta', metaMemo);
}

// id：宿主名（也是本机偏好的键前缀 bridge-<id>-dock-*）
// keys()：这个宿主此刻认识的全部卡（含门禁藏掉的）；sortable：进拖动排序的那几张（缺省 = 构造时的 keys()）
// colOf(key)：新卡默认落哪一列；intercept(view)：打开前的钩子，回 true = 已另行处理
// session()：浏览器按会话隔离用的会话 id；缺省读 state.sessionId
// caps：这个宿主的固定属性，原样挂到 host 上——
//   filesRoot   'ws' = 文件卡以会话工作空间为根；'identity' = 以这个身份的文件根为根、定位到工作空间目录
//               （没有命令行的身份拿不到按工作空间的文件作用域，只能走这条）
//   previewHost 文件卡里开预览时用的查看器实例名（每个宿主一份，互不抢）
//   memoryAgent 记忆卡读哪家的记忆库；'' = 这个宿主没有记忆卡
export function createDockHost({ id, initialView = 'review', keys, sortable = null, colOf = () => 'b', intercept = null, session = null, extra = {}, caps = {} }) {
  const state = $state({
    open: false, view: initialView, views: [], last: [], multi: false, max: '',
    ws: '', sessionId: '', meta: null, browserLive: '', termLive: false,
    filesTarget: null, focus: null, noAuto: false,
    ...extra,
  });
  const known = (v) => typeof v === 'string' && keys().includes(v);

  function commit(patch) {
    if (!patch) return;
    if (patch.views) state.views = patch.views;
    if (patch.view != null) state.view = patch.view;
    if (patch.last) state.last = patch.last;
    if (patch.multi != null) state.multi = patch.multi;
    if (patch.max != null) state.max = patch.max;
    state.open = state.views.length > 0;
    // 整个收起就清掉文件定位：下次打开是干净的工作空间视图，不会莫名跳回上次那个产物文件夹
    if (!state.open) { state.max = ''; state.filesTarget = null; }
  }

  // 插件卡片（ctx.ui.workbench）拿到的当前上下文：SDK 的 bridge.context()
  const context = () => ({ sessionId: (session ? session() : state.sessionId) || null, cwd: state.ws || null, agent: id === 'agy' ? 'antigravity' : id });
  function open(view) {
    // 插件卡片：插件没了就不开；手机 App 里不内嵌第三方页面，改成原生干净页面打开（各分页同一条路）
    if (isPluginView(view)) {
      const w = workbenchByKey(view);
      if (!w) return;
      if (inAndroidApp()) { openWorkbenchStandalone(w, context()); return; }
    }
    if (intercept && intercept(view)) return;
    const patch = openPatch(state, view, { known, fallback: initialView });
    commit(patch);
    if (patch.view === 'browser') state.browserLive = '';
    if (patch.view === 'term') state.termLive = false;
    if (patch.again) state.focus = { view: patch.view, seq: ++seq };
  }
  const close = () => commit(closeAllPatch(state));
  function closeView(view) {
    const patch = closeViewPatch(state, view);
    if (!patch) return;
    if (view === 'files') state.filesTarget = null;
    commit(patch);
  }
  function toggleView(view) {
    if (state.open && state.views.includes(view)) closeView(view);
    else open(view);
  }
  const toggleMax = (view) => { state.max = state.max === view ? '' : view; };
  // 在某张卡里点了一下：它就是「最近那张」（不许多卡时留下的是它）
  const noteFocus = (view) => { if (state.views.includes(view) && state.view !== view) state.view = view; };
  const setMulti = (on) => commit(multiPatch(state, on));
  const prune = (ok) => commit(prunePatch(state, ok));

  function setWs(ws) {
    const next = ws || '';
    if (state.ws === next) return;
    state.ws = next;
    // 上次见过这个工作空间就先用上次的 meta 画，同时立刻复核一次（用的人只在 meta 为空时才自己去拉）
    const last = next ? metaMemo[next] : null;
    state.meta = last ? { ...last } : null;
    state.filesTarget = null;
    if (last) ensureMeta();
  }
  // 文件卡定位到某个目录 / 文件：产物卡点开、agent 让界面跳过去都走这里
  function openFiles(target = {}) {
    state.filesTarget = { seq: ++seq, rel: target.rel || '', ws: target.ws || '', open: target.open || '' };
    open('files');
  }

  // agent 动了浏览器 / 终端：宽屏自动拉开那张卡同屏看；窄屏（或宿主说别自动开）只亮提示点
  const autoOpen = (view) => {
    try { if (window.innerWidth >= 1024 && !state.open && !state.noAuto) open(view); } catch {}
  };
  function noteBrowser(url) {
    state.browserLive = url || state.browserLive || 'about:blank';
    autoOpen('browser');
  }
  function noteTerm() {
    if (state.open && state.views.includes('term')) return;
    state.termLive = true;
    autoOpen('term');
  }

  // meta 每个 ws 只拉一次、并发去重：工作区展开要它，没展开时的工具开关 / 状态栏芯片也要它
  let metaWs = '';
  let metaInflight = null;
  function ensureMeta() {
    const ws = state.ws;
    if (!ws) return Promise.resolve(null);
    if (state.meta && metaWs === ws && !metaInflight) return Promise.resolve(state.meta);
    if (metaInflight && metaWs === ws) return metaInflight;
    metaWs = ws;
    metaInflight = (async () => {
      let m;
      // 走 api.get 而不是裸 fetch：网络层失败要把直连切回隧道并亮离线态
      // gone = 服务端 404（工作空间目录已不在盘上）：如实说「文件夹不存在」
      let gone = false;
      try { m = await api.get(`/api/claude/dock/meta?ws=${encodeURIComponent(ws)}`); } catch (e) { m = null; gone = e?.status === 404; }
      if (!m) m = { rel: null, git: false, branch: null, worktree: false, shell: false, gone };
      // 拉取期间可能已切走工作空间——晚到的结果不许盖到新 ws 头上
      if (state.ws === ws) state.meta = m;
      keepMeta(ws, m);
      metaInflight = null;
      return m;
    })();
    return metaInflight;
  }

  // —— 卡片排布（拖出来的两列顺序、卡间高度比）：本机偏好，同源各窗口之间跟着走 ——
  const COLS_LS = `bridge-${id}-dock-cols`;
  const WEIGHTS_LS = `bridge-${id}-dock-weights`;
  const sortKeys = () => (sortable ? sortable() : keys());
  const read = (k) => { try { const s = localStorage.getItem(k); return s ? JSON.parse(s) : null; } catch { return null; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const cols = $state(normCols(read(COLS_LS), sortKeys(), colOf));
  const weights = $state({ w: normWeights(read(WEIGHTS_LS), sortKeys()) });
  function applyCols(c) { const n = normCols(c, sortKeys(), colOf); cols.a = n.a; cols.b = n.b; return n; }
  const setCols = (c) => write(COLS_LS, applyCols(c));
  // live = 拖动中途：只改内存里的，松手才落盘
  function setWeights(w, { live = false } = {}) {
    weights.w = normWeights(w, sortKeys());
    if (!live) write(WEIGHTS_LS, weights.w);
  }
  try {
    window.addEventListener('storage', (e) => {
      if (!e.newValue) return;
      try {
        if (e.key === COLS_LS) applyCols(JSON.parse(e.newValue));
        else if (e.key === WEIGHTS_LS) weights.w = normWeights(JSON.parse(e.newValue), sortKeys());
      } catch {}
    });
  } catch {}

  const host = {
    filesRoot: 'ws', previewHost: 'dock', memoryAgent: '', ...caps,
    id, initialView, state, cols, weights,
    known, open, close, closeView, toggleView, toggleMax, noteFocus, setMulti, prune,
    setWs, openFiles, noteBrowser, noteTerm, ensureMeta, setCols, setWeights, context,
    browserSession: () => (session ? session() : state.sessionId) || '',
  };
  hosts.set(state, host);
  return host;
}
