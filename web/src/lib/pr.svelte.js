// 会话的拉取请求（PR）前端一侧：会话面板的 PR 卡、输入框上方的 PR 芯片、转录里的 /create-pr 与 CI 事件。
// 服务端：src/runtime/pr-monitor.mjs（GET/POST /api/claude/pr、总线 {type:'pr', sessionId, view}）。
//
// 数据按会话镜像（prState.bySession[sid] = 服务端 view 原样）。来源三处：打开卡片 / 芯片挂上时拉一次、
// 看得见时定时刷新（间隔用服务端给的 pollMs：平时 30 秒，GitHub 额度紧时放宽到 2 分钟，限流时等到 reset）、
// 总线推送（绑定 / 状态变化 / 自动修复唤醒 / 代合并完成）。
//
// 「创建拉取请求」照官方：以用户身份给 Claude 发一段 <create-pr-command> 提示词（转录里显示成 /create-pr），
// 由 Claude 自己 commit / push / gh pr create，并用 <pr-created> 标签报链接——服务端据此自动绑定。
import { untrack } from 'svelte';
import { api } from './api.js';
import { busOn } from './bus.js';
import { IS_CSNAP } from './csnap.js';
import { isNativeDesktop, desktopOpenExternal } from './nativeDesktop.js';
import { storeGet, storeSet } from './store.js';
import { showToast } from './toast.svelte.js';
import { t, tc } from './i18n.js';

export const prState = $state({ bySession: {} });
// 在途防重入用普通 Set，不进 $state：组件在 $effect 里调 watchPr → loadPr 时，读到响应式的 loading 会让它成为
// effect 的依赖，请求一结束写回 false 就把 effect 重跑一遍——清理删 watcher、重建又立刻 loadPr，死循环（每秒上百次）。
const inflight = new Set();

export const prViewOf = (sid) => (sid && prState.bySession[sid]) || null;

/** 拉一次。refresh = 让服务端跳过缓存（卡片上的刷新键、刚建完 PR）。 */
export async function loadPr(sid, { refresh = false } = {}) {
  if (!sid || IS_CSNAP) return null;
  if (inflight.has(sid) && !refresh) return untrack(() => prViewOf(sid));
  inflight.add(sid);
  try {
    const r = await api.get(`/api/claude/pr?session=${encodeURIComponent(sid)}${refresh ? '&refresh=1' : ''}`);
    if (r && r.view) prState.bySession[sid] = r.view;
  } catch (e) {
    // 会话还没落盘（新会话第一轮之前）/ 鉴权临时失效 / 老服务端没有这个接口：先当不可用，隔一会儿再试（见 schedule）
    if (e && (e.status === 404 || e.status === 401)) prState.bySession[sid] = { available: false, reason: 'not_found' };
  } finally { inflight.delete(sid); }
  return prViewOf(sid);
}

/** 写操作。返回 { ok, result } 或 { ok:false, error, stale?, code? }（error 已是给人看的话，显示时过 tr()）。 */
export async function prAction(sid, op, args = {}) {
  try {
    const r = await api.post('/api/claude/pr', { session: sid, op, ...args });
    if (r && r.view) prState.bySession[sid] = r.view;
    return { ok: true, result: r && r.result };
  } catch (e) {
    const b = e && e.body && typeof e.body === 'object' ? e.body : {};
    return { ok: false, error: b.error || (typeof (e && e.body) === 'string' ? e.body : '') || (e && e.message) || '', stale: b.stale || '', code: b.code || '' };
  }
}

busOn((ev) => {
  if (!ev || ev.type !== 'pr' || !ev.sessionId || !ev.view) return;
  prState.bySession[ev.sessionId] = ev.view;
  // 之前拉成「不可用」停了轮询、现在推来了可用的：把定时刷新重新排上
  const w = watchers.get(ev.sessionId);
  if (w && !w.timer && ev.view.available) schedule(ev.sessionId);
  if (ev.note === 'merged' && ev.number) showToast(t('已自动合并拉取请求 #{n}', { n: ev.number }));
});

// —— 看得见时定时刷新（卡片、芯片各自 watch，同一会话共用一个计时器）——
const watchers = new Map();   // sid → { n, timer（0 = 没排着）}
function schedule(sid) {
  const w = watchers.get(sid);
  if (!w) return;
  clearTimeout(w.timer);
  w.timer = 0;
  const v = prViewOf(sid);
  // 不是主机本人：不再轮询。会话还没落盘（新会话首轮）/ 鉴权临时失效拿到的 not_found：45 秒后再试，别就此停掉。
  // 没有 GitHub 远程也没绑定的会话 5 分钟看一眼
  if (v && v.available === false && v.reason !== 'not_found') return;
  const idle = v && v.available && !(v.prs || []).length && !(v.git && v.git.github);
  const ms = v && v.available === false ? 45_000 : idle ? 300_000 : Math.max(15_000, (v && v.pollMs) || 30_000);
  w.timer = setTimeout(async () => {
    if (!watchers.has(sid)) return;
    if (typeof document === 'undefined' || !document.hidden) await loadPr(sid);
    schedule(sid);
  }, ms);
}
/** 组件里 `$effect(() => watchPr(sid))` 即可：这里整段 untrack，effect 只依赖调用方读的 sid。 */
export function watchPr(sid) {
  if (!sid || IS_CSNAP) return () => {};
  let w = watchers.get(sid);
  if (!w) { w = { n: 0, timer: 0 }; watchers.set(sid, w); untrack(() => loadPr(sid)).then(() => schedule(sid)); }
  w.n += 1;
  return () => {
    const cur = watchers.get(sid);
    if (!cur) return;
    cur.n -= 1;
    if (cur.n <= 0) { clearTimeout(cur.timer); watchers.delete(sid); }
  };
}
if (typeof document !== 'undefined') {
  // 回到前台：过期的立刻补一次（官方 resume / focus 重读）
  document.addEventListener('visibilitychange', () => { if (!document.hidden) for (const sid of watchers.keys()) loadPr(sid).then(() => schedule(sid)); });
}

// —— 展示用的归纳 ——
export { mainPr, ciStatus, conflicting, prTone, createBlocker, baseOf, createPrPrompt, compareUrl, syncConflictPrompt, prEnvelope } from './prText.js';
// 文案表在定义处就过 t()（模块顶层求值时字典已就绪，见 i18n/GUIDE.md），使用处直接取
export const STATE_LABEL = { open: t('打开'), draft: t('草稿'), queued: t('合并队列中'), merged: t('已合并') };
// 「已关闭」的普通键是开关值 Off，PR 状态要走 claude 语境
export const stateLabel = (s) => (s === 'closed' ? tc('claude', '已关闭') : STATE_LABEL[s] || s);
export const REVIEW_LABEL = { APPROVED: t('已批准'), CHANGES_REQUESTED: t('需修改'), REVIEW_REQUIRED: t('待审查') };
// gh 不可用原因（服务端 github.mjs REASONS 同一份中文）
export const GH_REASON = {
  gh_not_installed: t('未安装 GitHub CLI（gh）'),
  gh_not_authenticated: t('请运行 gh auth login 登录'),
  rate_limited: t('触发 GitHub 限流，正在自动重试'),
  network: t('无法连接 GitHub，请检查网络'),
  unknown: t('请确认 gh 已安装并已登录'),
};

/** 外链：桌面壳交系统浏览器，网页 / 手机开新标签。只认 http(s)——检查条目的链接是第三方写的，别把别的协议交给系统去开。 */
export function openGitHub(url) {
  if (!url || !/^https?:\/\//i.test(String(url))) return;
  if (isNativeDesktop()) { desktopOpenExternal(url); return; }
  try { window.open(url, '_blank', 'noopener'); } catch {}
}

// —— 创建拉取请求 ——
const MODE_KEY = 'bridge-pr-create-mode';
export const prCreate = $state({ mode: storeGet(MODE_KEY) === 'draft' ? 'draft' : 'create' });
export function setPrCreateMode(m) { prCreate.mode = m === 'draft' ? 'draft' : 'create'; try { storeSet(MODE_KEY, prCreate.mode); } catch {} }

export const CREATE_BLOCKER = {
  no_remote: t('先添加 GitHub 远程仓库才能创建拉取请求'),
  on_base: t('当前在基线分支上，请先切到功能分支'),
  busy: t('Claude 正在工作，请等本轮结束'),
  no_changes: t('没有可用于创建拉取请求的改动'),
};

