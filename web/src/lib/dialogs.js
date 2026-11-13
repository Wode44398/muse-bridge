// 统一提示 / 确认对话框：bridge 内的弹窗（components/DialogHost.svelte），不再用系统弹窗。
//
// 为什么换：桌面壳的 dialog.showMessageBox 是 Windows 原生框、Android / 网页的 window.alert/confirm
// 是 WebView / 浏览器的框（标题还带「127.0.0.1:8787 显示」）——三端三种样子，和界面完全不搭，
// 维护者验收第一条就是「不要系统级弹窗」。现在三端都画同一个应用内弹窗：
//   宽屏 / 鼠标 → 墨与象牙的扁平卡片；触屏（pointer: coarse）→ iOS 27 玻璃警告框（ios27/Alert）。
//
// 签名与返回值保持不变（全站十几处在用）：
//   uiAlert(message, { type, detail, title, danger, okLabel })                       → Promise<void>
//   uiConfirm(message, { detail, okLabel, cancelLabel, type, danger, title })        → Promise<boolean>
// 新增的可选参数：danger（缺省 = type==='warning'，确认钮变红、默认焦点落到「取消」）、title（小标题）。
//
// 挂载：第一次调用时动态 import DialogHost 并 mount 到 document.body（SoloPage / SharePage / QuickAsk
// 这些不经过 App 的入口也能用）；App 若自己挂了一份，DialogHost 内部认领机制保证只画一层。
// 兜底：组件加载或挂载失败（离线 apk 缺 chunk、服务端刚升级旧 chunk 404……）时退回旧路径——
// 桌面壳 messageBox，再不行 window.alert/confirm，保证调用方的 Promise 一定会结算。
import { mount } from 'svelte';
import { desktopApp } from './nativeDesktop.js';
import { t } from './i18n.js';
import { dlg, host, hooks, request, settle, activeRequest } from './dialogState.svelte.js';
import { quietPreload, reloadPending } from './staleGuard.js';

const hasDom = () => typeof window !== 'undefined' && typeof document !== 'undefined';
// 组件 chunk 加载的最长等待：超过就先用系统弹窗把这批问完（用户不能对着空白干等），下次调用再试。
const LOAD_TIMEOUT = 6000;
// 加载失败、staleGuard 已经判成构建漂移并整页刷新时，先等这么久让刷新把这批请求带走，再考虑系统框兜底。
const STALE_WAIT = 5000;

const defaults = () => ({ ok: t('确定'), cancel: t('取消') });
const loadHost = () => import('../components/DialogHost.svelte');

export function uiAlert(message, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (!hasDom()) return Promise.resolve();
  const p = request('alert', message, {
    type: o.type ?? 'info', detail: o.detail, title: o.title, danger: o.danger, okLabel: o.okLabel,
  }, defaults());
  kick();
  return p;
}

export function uiConfirm(message, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  // 没有 DOM（不该发生，留着防 SSR / 测试环境误调）：按取消处理，绝不默认放行危险操作
  if (!hasDom()) return Promise.resolve(false);
  const p = request('confirm', message, {
    type: o.type ?? 'question', detail: o.detail, title: o.title, danger: o.danger,
    okLabel: o.okLabel, cancelLabel: o.cancelLabel,
  }, defaults());
  kick();
  return p;
}

// —— 宿主挂载 ——
let loading = null;
function kick() {
  if (host.ready || loading) return;   // 已有宿主：它订阅着队列，自己会画出来
  loading = (async () => {
    let timer = 0;
    try {
      const mod = await Promise.race([
        loadHost(),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), LOAD_TIMEOUT); }),
      ]);
      clearTimeout(timer);
      // 拿到的不是模块：Vite 的预加载报了错，staleGuard 判成构建漂移、吞掉错误并整页刷新了。
      // 这时别马上弹系统框——刷新会把它连同用户的回答一起带走（桌面壳的 messageBox 甚至会留在刷新后的页面上，
      // 回答送回已经销毁的页面）。先等刷新把这批请求带走；过了这么久页面还在，再照常走兜底，Promise 一定会结算。
      if (!mod?.default) {
        if (reloadPending()) await new Promise((r) => setTimeout(r, STALE_WAIT));
        throw new Error('stale reload');
      }
      if (!host.ready) mount(mod.default, { target: document.body });
      // mount 不抛错但没认领（理论上不会）也按失败处理，免得 Promise 永远挂着
      if (!host.ready) throw new Error('DialogHost 未认领');   // i18n-ignore 只进控制台
    } catch (e) {
      clearTimeout(timer);
      try { console.warn('[dialogs] 应用内弹窗没能加载，这一批改用系统弹窗：', e?.message || e); } catch {}
      await drainLegacy();
    } finally {
      loading = null;
      // 兜底循环刚问完最后一条、还没走到这里时进来的新请求：kick 当时看到 loading 还在就直接返回了，
      // 没人接手会永远挂着——这里补一次（每轮都会把排着的问完，不会空转）
      if (!host.ready && activeRequest(dlg.queue)) kick();
    }
  })();
}

// 兜底：把队列里还没答的逐个交给旧路径（一次一个，和应用内弹窗同样的先后顺序）。
// 中途宿主就位了就停下，剩下的交给它画。
let draining = false;
async function drainLegacy() {
  if (draining) return;
  draining = true;
  try {
    for (;;) {
      if (host.ready) break;
      const req = activeRequest(dlg.queue);
      if (!req) break;
      let role = req.kind === 'confirm' ? 'cancel' : 'ok';
      try { role = await legacyShow(req); } catch {}
      settle(req.id, role, { instant: true });
    }
  } finally {
    draining = false;
  }
}

async function legacyShow(req) {
  // 系统框没有小标题和「×n」的位置，并进正文里
  const msg = (req.title ? req.title + '\n' : '') + req.message + (req.count > 1 ? ` ×${req.count}` : '');
  if (desktopApp?.messageBox) {
    if (req.kind === 'alert') {
      await desktopApp.messageBox({ type: req.type, message: msg, detail: req.detail || undefined, buttons: [req.okLabel] });
      return 'ok';
    }
    const r = await desktopApp.messageBox({
      type: req.type, message: msg, detail: req.detail || undefined,
      buttons: [req.okLabel, req.cancelLabel], defaultId: req.danger ? 1 : 0, cancelId: 1,
    });
    return r?.response === 0 ? 'ok' : 'cancel';
  }
  const text = req.detail ? msg + '\n' + req.detail : msg;
  if (req.kind === 'alert') { window.alert(text); return 'ok'; }
  return window.confirm(text) ? 'ok' : 'cancel';
}

// —— 键盘：模块求值时就在 window 捕获阶段注册 ——
// 为什么不等组件 onMount：Customize、PermissionModePicker 也在 window 捕获阶段听 Esc，且前者不看
// defaultPrevented；同一目标同一阶段按注册先后触发，只有最先注册才能用 stopImmediatePropagation
// 把它们挡住（否则按 Esc 关弹窗会连底下的面板一起关）。dialogs.js 被十几个组件静态 import，
// 求值远早于任何组件的 $effect。队列为空时这两个监听什么都不做。
let held = null;   // 关掉弹窗的那一下 Enter / Esc：按住不放的自动重复不许漏到底下的界面
function onKeyDown(e) {
  if (held) {
    if (e.key === held && e.repeat) { e.preventDefault(); e.stopImmediatePropagation(); return; }
    held = null;
  }
  const before = host.ready ? activeRequest(dlg.queue) : null;
  if (!before) return;
  // 弹窗是模态的：所有按键都不给底下的快捷键（不 preventDefault，复制 detail 文字之类的默认行为照常）
  e.stopImmediatePropagation();
  try { hooks.key?.(e); } catch (err) { try { console.warn('[dialogs] 按键处理出错', err); } catch {} }
  if ((e.key === 'Enter' || e.key === 'Escape') && activeRequest(dlg.queue) !== before) held = e.key;
}
function onKeyUp(e) {
  if (held && e.key === held) { held = null; e.stopImmediatePropagation(); return; }
  if (host.ready && activeRequest(dlg.queue)) e.stopImmediatePropagation();
}

if (hasDom()) {
  // 开发热更新会重新求值本模块：先摘掉上一份监听，免得一次按键处理两遍
  const prev = window.__bridgeDialogKeys;
  if (prev) {
    window.removeEventListener('keydown', prev.down, true);
    window.removeEventListener('keyup', prev.up, true);
  }
  window.__bridgeDialogKeys = { down: onKeyDown, up: onKeyUp };
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);

  // 空闲时预取组件 chunk：第一次弹窗不用等网络；也避免服务端升级后旧页面再去拉已删掉的旧 chunk。
  // 只加载不挂载——没有弹窗时不占任何 DOM。
  // 走 staleGuard 的静默模式：这是推测加载，失败（网络抖动 / 服务端正在重启）只该静默，不该触发无操作的整页刷新；
  // 真要弹窗时 kick() 会再加载一次，那一次失败才交给 staleGuard 判漂移。
  const idle = window.requestIdleCallback || ((f) => setTimeout(f, 1500));
  try { idle(() => { quietPreload(loadHost).catch(() => {}); }, { timeout: 5000 }); } catch {}
}
