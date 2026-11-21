// 插件页面宿主的三个浮层（授权框、文件选择器、会话选择器）共用的「第一次用时才挂到 body」。
//
// 为什么不挂进 App.svelte：调用方有 PluginFrame（主界面）也有手机中转（pluginHostRelay.js），
// 还可能是 SoloPage 这类不经过 App 的入口；照 dialogs.js / DialogHost 的做法，第一次调用时动态 import 组件、
// mount 到 document.body，之后组件订阅各自模块里的 $state 队列，自己画、自己收。
//
// 只做两件事：保证同一个组件只 mount 一次；加载超时或失败时让调用方知道（它要把挂着的 Promise 结算掉，
// 绝不能让页面那头一直等）。失败后清掉缓存，下次调用再试一次（离线 apk 缺 chunk、服务端刚升级这类偶发情况）。
import { mount } from 'svelte';

const LOAD_TIMEOUT = 8000;

/** load：() => import('…/X.svelte')。返回 ensure()：挂好了 resolve，失败 reject。 */
export function selfMounter(load) {
  let done = false;
  let pending = null;
  return function ensure() {
    if (done) return Promise.resolve();
    if (pending) return pending;
    pending = (async () => {
      let timer = 0;
      try {
        const mod = await Promise.race([
          load(),
          new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), LOAD_TIMEOUT); }),
        ]);
        // 拿到的不是模块：staleGuard 判成构建漂移、吞掉错误并整页刷新了——按失败处理，调用方会结算掉
        if (!mod?.default) throw new Error('stale chunk');
        if (typeof document === 'undefined' || !document.body) throw new Error('no document');
        mount(mod.default, { target: document.body });
        done = true;
      } finally {
        clearTimeout(timer);
        pending = null;
      }
    })();
    return pending;
  };
}

// 双向文字控制符（LRM / RLM / ALM、LRE…RLO、LRI…PDI）：插件写进应用名 / 插件名的一个 U+202E（RLO）
// 就能把后面 bridge 写的权限说明整段倒过来显示，再配合名字里自编的「解释」骗人点「允许」——授权框由 bridge 画
// 本来就是为了防这个，所以这类字符一律去掉（名字自身的阿拉伯文 / 希伯来文照常显示，显示时再用 bidiIsolate 隔开）
const BIDI_CTRL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
// 换行一类的控制符（C0、DEL、C1、行 / 段分隔符）换成空格：名字只该占一行
const LINE_CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** 统一的截断：转成字符串、去掉控制符、去首尾空白、超过 max 个字截断加省略号（不劈开代理对）。 */
export function clipText(v, max) {
  let s;
  try { s = v == null ? '' : String(v); } catch { s = ''; }
  s = s.replace(BIDI_CTRL, '').replace(LINE_CTRL, ' ').trim();
  if (!(max >= 1) || s.length <= max) return s;
  let cut = max - 1;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut -= 1;
  return s.slice(0, cut) + '…';
}

/**
 * 把插件给的名字拼进 bridge 自己的句子之前先隔开（FSI … PDI，纯文本版的 <bdi>）：名字里的从右往左文字
 * 只在名字内部排，不会把前后 bridge 写的字一起带着重排。玻璃警告框的标题只收字符串，所以用控制符而不是标签。
 */
export function bidiIsolate(s) {
  return '\u2068' + String(s ?? '') + '\u2069';
}

/**
 * 三个入口的可选 { signal } 共用：abort 时调 fn（只一次），回摘除函数；没给可用的 signal 回 null。
 * 调用方（PluginFrame 卸载 / 页面换代）用它把挂着的框按取消收掉，结算时记得调回来的摘除函数，免得长命 signal 攒监听。
 */
export function onAbort(signal, fn) {
  if (!signal || typeof signal.addEventListener !== 'function') return null;
  signal.addEventListener('abort', fn, { once: true });
  return () => { try { signal.removeEventListener('abort', fn); } catch {} };
}

/** 指针防误触用的「事件发生时刻」：同 dialogState.eventTime（老内核的 timeStamp 不是 performance.now 口径时用 now）。 */
export function eventAt(e) {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const ts = e && typeof e.timeStamp === 'number' ? e.timeStamp : NaN;
  return ts > 0 && ts <= now + 1000 ? ts : now;
}
