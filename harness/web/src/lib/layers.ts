// 浮层栈：弹层、菜单、sheet、灯箱、抽屉……凡是「盖在上面、可以关掉」的东西，挂载时登记、卸载时注销。
// 它统一三件事：
//   1. 返回键：App 的 window.__harnessBack 先问 closeTopLayer()——关掉最上面那层就算消费了这次返回
//      （以前打开的菜单不在返回链里，按返回先关的是底下的 sheet）；
//   2. Esc：只关最上面那层（以前每个弹层各自听 window 的 Esc，叠在一起时一次全关）；
//   3. 桌面壳原生浏览器让位：WebContentsView 恒在 DOM 之上，登记时可一并 pushNativeOverlay。
// Esc 监听在第一次登记时才挂上（本模块随 @hx 进 bridge 的全局包，别在 bridge 其它分页上抢键）。
import { pushNativeOverlay } from "./nativeShell.ts";

interface Layer {
  id: number;
  close: () => void;
  escape: boolean;
}

const stack: Layer[] = [];
let seq = 0;
let listening = false;

function onKey(e: KeyboardEvent) {
  if (e.key !== "Escape" || e.defaultPrevented || !stack.length) return;
  const top = stack[stack.length - 1];
  if (!top.escape) return;
  e.preventDefault();
  e.stopPropagation();
  top.close();
}

// 登记一层。返回注销函数（幂等）。native = 挂载期间让桌面壳的原生浏览器视图退下。
export function pushLayer(close: () => void, { escape = true, native = true }: { escape?: boolean; native?: boolean } = {}): () => void {
  if (!listening && typeof window !== "undefined") {
    window.addEventListener("keydown", onKey, true);
    listening = true;
  }
  const layer: Layer = { id: ++seq, close, escape };
  stack.push(layer);
  const releaseNative = native ? pushNativeOverlay() : () => {};
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const i = stack.indexOf(layer);
    if (i >= 0) stack.splice(i, 1);
    releaseNative();
  };
}

// 关最上面一层；没有可关的返回 false（返回键链接着往下走）
export function closeTopLayer(): boolean {
  const top = stack[stack.length - 1];
  if (!top) return false;
  top.close();
  return true;
}

export function layerCount(): number {
  return stack.length;
}

// Svelte action 版：<div use:layer={onclose}> 或 <div use:layer={{ close, native: false }}>——元素在，层就在
type LayerArg = (() => void) | { close: () => void; escape?: boolean; native?: boolean };
export function layer(_node: HTMLElement, arg: LayerArg) {
  const pick = (a: LayerArg) => (typeof a === "function" ? a : a.close);
  let current = pick(arg);
  const opts = typeof arg === "function" ? {} : { escape: arg.escape, native: arg.native };
  const release = pushLayer(() => current(), opts);
  return {
    update(next: LayerArg) {
      current = pick(next);
    },
    destroy() {
      release();
    },
  };
}
