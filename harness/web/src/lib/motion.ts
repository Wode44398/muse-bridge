// 动效基建：弹簧曲线（CSS linear() + JS 缓动同源）、Svelte 过渡、高度自适应动画。
//
// 原则（DESIGN.md「动效」）：东西不瞬移——出现是浮起、消失是退隐、尺寸变化是生长；
// 进场用弹簧（快起、柔停），退场用短促的 ease-in（让位要干脆）；一切可被打断；
// 用户开了「减少动态效果」就只留透明度。只动 transform / opacity（布局属性不做逐帧动画，
// 宽度动画例外只给侧栏，见 App.svelte）。
//
// 纯 TS：不碰 Svelte 运行时，服务端测试也能 import（虽然目前没人 import）。

// ── 弹簧 ──────────────────────────────────────────────────────────────────────────────
// 阻尼谐振子的阶跃响应（0 → 1），zeta 阻尼比、omega 固有角频率（rad/s）。
function springAt(zeta: number, omega: number, t: number): number {
  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * t) * (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
  }
  return 1 - Math.exp(-omega * t) * (1 + omega * t);
}

export interface Spring {
  ms: number; // 走到「看不出还在动」（2% 带内）的时长
  css: string; // CSS linear() 缓动
  ease: (t: number) => number; // 0..1 → 进度（可 > 1，即回弹）
}

// settle：期望的稳定时长（秒）；按 2% 稳定判据 ts ≈ 4 / (ζω) 反推 ω
function makeSpring(zeta: number, settle: number, samples = 44): Spring {
  const omega = 4 / (zeta * settle);
  const ease = (p: number) => (p >= 1 ? 1 : p <= 0 ? 0 : springAt(zeta, omega, p * settle));
  const pts: string[] = [];
  for (let i = 0; i <= samples; i++) {
    const v = i === samples ? 1 : ease(i / samples);
    pts.push(String(Math.round(v * 10000) / 10000));
  }
  return { ms: Math.round(settle * 1000), css: `linear(${pts.join(", ")})`, ease };
}

// 柔：几乎不过冲（0.15%），面板、sheet、抽屉、列表条目
export const SPRING_SOFT = makeSpring(0.9, 0.42);
// 标准：轻微回弹（≈4%），菜单、卡片、按钮形变
export const SPRING = makeSpring(0.72, 0.5);
// 弹跳：明显回弹（≈9%），只给小东西（徽标、勾、状态点）
export const SPRING_POP = makeSpring(0.6, 0.56);
// 快：同柔一样几乎不过冲，但 260ms 就停——跟手的选中块（分段控件、工作区标签带；420ms 的柔弹簧显得慢、不跟手）
export const SPRING_SNAP = makeSpring(0.9, 0.26);

// 浏览器不认 linear() 时的近似（三次贝塞尔）
const FALLBACK = { soft: "cubic-bezier(.2,.9,.25,1)", std: "cubic-bezier(.3,1.25,.4,1)", pop: "cubic-bezier(.34,1.5,.5,1)" };

let linearOk: boolean | null = null;
function supportsLinear(): boolean {
  if (linearOk === null) {
    try {
      linearOk = typeof CSS !== "undefined" && CSS.supports("transition-timing-function", "linear(0, 1)");
    } catch {
      linearOk = false;
    }
  }
  return linearOk;
}

// 给 WAAPI（element.animate）用的缓动字符串：它不解析 CSS 变量，得传真实曲线
export function springEasing(s: Spring = SPRING_SOFT): string {
  if (supportsLinear()) return s.css;
  return s === SPRING_POP ? FALLBACK.pop : s === SPRING ? FALLBACK.std : FALLBACK.soft;
}

// 写进主题根的动效令牌（theme.ts 的 applyTheme 调用）
export function motionVars(): Record<string, string> {
  const ok = supportsLinear();
  return {
    "--spring": ok ? SPRING.css : FALLBACK.std,
    "--spring-soft": ok ? SPRING_SOFT.css : FALLBACK.soft,
    "--spring-pop": ok ? SPRING_POP.css : FALLBACK.pop,
    "--spring-snap": ok ? SPRING_SNAP.css : FALLBACK.soft,
    "--t-spring": `${SPRING.ms}ms`,
    "--t-spring-soft": `${SPRING_SOFT.ms}ms`,
    "--t-spring-pop": `${SPRING_POP.ms}ms`,
    "--t-spring-snap": `${SPRING_SNAP.ms}ms`,
  };
}

export function reducedMotion(): boolean {
  try {
    return matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

// 退场：短促的 ease-in（二次）
const easeIn = (t: number) => t * t;
const easeOutCubic = (t: number) => 1 - (1 - t) ** 3;

// ── Svelte 过渡（in: / out: / transition: 通用；第三参 { direction }）───────────────────
// 注意：transition: 指令传进来的 direction 是 "both"（不是 in / out），同一条曲线进场正着播、退场倒着播——
// 弹簧会过冲，倒着播时数值会冲出 0..1（高度成负、透明度成负）。所以 "both" 时一律换成不过冲的 easeOutCubic，
// 并把数值钳住。要进退场各用各的曲线，就写 in: / out: 两个指令。
interface TransitionConfig {
  delay?: number;
  duration?: number;
  easing?: (t: number) => number;
  css?: (t: number, u: number) => string;
}
type Dir = { direction?: "in" | "out" | "both" };
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

// 浮起：透明 + 下沉 y px + 轻微缩放 → 原位。进场弹簧，退场 ease-in 且更快。
export function rise(
  _node: Element,
  { y = 8, scale = 1, delay = 0, duration, out = 150 }: { y?: number; scale?: number; delay?: number; duration?: number; out?: number } = {},
  opts: Dir = {},
): TransitionConfig {
  const leaving = opts.direction === "out";
  const both = opts.direction === "both";
  if (reducedMotion()) return { delay, duration: leaving ? 100 : 160, css: (t) => `opacity:${clamp01(t)}` };
  const s = SPRING_SOFT;
  return {
    delay,
    duration: leaving ? out : (duration ?? (both ? 300 : s.ms)),
    easing: leaving ? easeIn : both ? easeOutCubic : s.ease,
    css: (t, u) => {
      const o = leaving || both ? clamp01(t) : Math.min(1, t * 1.6);
      const sc = scale === 1 ? "" : ` scale(${1 - (1 - scale) * u})`;
      return `opacity:${o};transform:translateY(${(u * y).toFixed(2)}px)${sc}`;
    },
  };
}

// 弹出：从 transform-origin 缩放 + 透明（菜单、弹层、提示）。origin 由调用方的 CSS 决定。
export function pop(
  _node: Element,
  { from = 0.94, delay = 0, out = 130 }: { from?: number; delay?: number; out?: number } = {},
  opts: Dir = {},
): TransitionConfig {
  const leaving = opts.direction === "out";
  const both = opts.direction === "both";
  if (reducedMotion()) return { delay, duration: leaving ? 90 : 140, css: (t) => `opacity:${clamp01(t)}` };
  const s = SPRING;
  return {
    delay,
    duration: leaving ? out : both ? 260 : s.ms,
    easing: leaving ? easeIn : both ? easeOutCubic : s.ease,
    css: (t, u) => `opacity:${clamp01(t * 1.8)};transform:scale(${(1 - (1 - from) * u).toFixed(4)})`,
  };
}

// 淡：只动透明度
export function fade(_node: Element, { duration = 180, delay = 0 }: { duration?: number; delay?: number } = {}, opts: Dir = {}): TransitionConfig {
  const leaving = opts.direction === "out";
  return { delay, duration: leaving ? Math.round(duration * 0.7) : duration, easing: leaving ? easeIn : easeOutCubic, css: (t) => `opacity:${t}` };
}

// 滑入：整块从某一边进来（sheet 从下、抽屉从左、侧面板从右）。进场柔弹簧，退场 ease-in。
export function slide(
  node: Element,
  { from = "bottom", out = 200, distance }: { from?: "bottom" | "top" | "left" | "right"; out?: number; distance?: number } = {},
  opts: Dir = {},
): TransitionConfig {
  const leaving = opts.direction === "out";
  const both = opts.direction === "both";
  if (reducedMotion()) return { duration: leaving ? 120 : 160, css: (t) => `opacity:${clamp01(t)}` };
  const rect = (node as HTMLElement).getBoundingClientRect();
  const horizontal = from === "left" || from === "right";
  const d = distance ?? (horizontal ? rect.width : rect.height) + 24;
  const sign = from === "bottom" || from === "right" ? 1 : -1;
  const s = SPRING_SOFT;
  return {
    duration: leaving ? out : both ? 320 : s.ms + 60,
    easing: leaving ? easeIn : both ? easeOutCubic : s.ease,
    css: (t) => `transform:translate${horizontal ? "X" : "Y"}(${(sign * (1 - (both ? clamp01(t) : t)) * d).toFixed(1)}px)`,
  };
}

// 折叠：高度 0 ↔ 自然高度 + 透明（行内展开区、错误详情、列表条目的出现 / 消失）。
// 被过渡的元素本身别有 margin（放进一个 padding 包裹层里），否则收起的最后一帧会跳一下。
export function collapse(node: Element, { duration, delay = 0 }: { duration?: number; delay?: number } = {}, opts: Dir = {}): TransitionConfig {
  const leaving = opts.direction === "out";
  const both = opts.direction === "both";
  const el = node as HTMLElement;
  const h = el.scrollHeight;
  if (reducedMotion()) return { delay, duration: 120, css: (t) => `opacity:${clamp01(t)}` };
  const ms = duration ?? Math.min(420, 200 + h * 0.35);
  return {
    delay,
    duration: leaving ? Math.round(ms * 0.7) : both ? Math.round(ms * 0.85) : ms,
    easing: leaving ? easeIn : both ? easeOutCubic : SPRING_SOFT.ease,
    css: (t) => `overflow:hidden;height:${(clamp01(t) * h).toFixed(1)}px;opacity:${clamp01(t * 1.4)}`,
  };
}

// ── 动作 ──────────────────────────────────────────────────────────────────────────────
// smoothHeight：容器高度随内容变化时平滑生长 / 收缩（输入框长高、停靠区换卡、列表增删）。
// 用法：<div use:smoothHeight><div>…内容…</div></div>——量的是唯一子元素，动的是容器。
//   bottom：内容贴底（输入框上方的状态区：新东西从下往上长，贴着输入框的那一格不动）
//   只在补间期间裁切（平时不裁，子元素的阴影不会被切掉）；从 display:none 恢复显示时直接就位，不从 0 长一遍。
export function smoothHeight(node: HTMLElement, { duration = 320, bottom = false }: { duration?: number; bottom?: boolean } = {}) {
  const inner = node.firstElementChild as HTMLElement | null;
  if (!inner || typeof ResizeObserver === "undefined") return {};
  const shown = () => node.getClientRects().length > 0;
  let last = inner.offsetHeight;
  let wasShown = shown();
  let anim: Animation | null = null;
  if (bottom) {
    node.style.display = "flex";
    node.style.flexDirection = "column";
    node.style.justifyContent = "flex-end";
  }
  const settle = () => {
    anim = null;
    node.style.overflow = "";
  };
  const ro = new ResizeObserver(() => {
    const next = inner.offsetHeight;
    const vis = shown();
    const appeared = vis && !wasShown;
    wasShown = vis;
    if (next === last) return;
    const from = anim ? node.getBoundingClientRect().height : last;
    last = next;
    anim?.cancel();
    if (appeared || !vis || reducedMotion() || !node.isConnected) {
      node.style.overflow = "";
      return;
    }
    node.style.overflow = "clip";
    node.style.setProperty("overflow-clip-margin", "12px");
    const a = node.animate([{ height: `${from}px` }, { height: `${next}px` }], { duration, easing: springEasing(SPRING_SOFT) });
    anim = a;
    a.onfinish = () => anim === a && settle();
    a.oncancel = () => anim === a && settle();
  });
  ro.observe(inner);
  return {
    destroy() {
      ro.disconnect();
      anim?.cancel();
    },
  };
}

// press：按下缩一点、松开弹回（CSS :active 在触屏上有延迟 / 被滚动吞掉，这里用 pointer 事件）。
// 用 WAAPI 做，不碰元素的行内 transition / transform——组件自己在 CSS 里写的底色、颜色过渡照常生效；
// 每一段都从「此刻的缩放」接着走，快速连点不会跳。
export function press(node: HTMLElement, { scale = 0.96 }: { scale?: number } = {}) {
  if (reducedMotion()) return {};
  let anim: Animation | null = null;
  let held = false;
  const now = () => {
    const m = new DOMMatrix(getComputedStyle(node).transform);
    return Number.isFinite(m.a) && m.a > 0 ? m.a : 1;
  };
  const down = (e: PointerEvent) => {
    if (e.button > 0 || (node as HTMLButtonElement).disabled) return;
    held = true;
    const from = now();
    anim?.cancel();
    anim = node.animate([{ transform: `scale(${from})` }, { transform: `scale(${scale})` }], {
      duration: 90,
      easing: "cubic-bezier(.2,.8,.2,1)",
      fill: "forwards",
    });
  };
  const up = () => {
    if (!held) return;
    held = false;
    const from = now();
    anim?.cancel();
    const a = node.animate([{ transform: `scale(${from})` }, { transform: "scale(1)" }], {
      duration: SPRING_POP.ms,
      easing: springEasing(SPRING_POP),
    });
    anim = a;
    a.onfinish = () => {
      if (anim === a) anim = null;
    };
  };
  node.addEventListener("pointerdown", down);
  node.addEventListener("pointerup", up);
  node.addEventListener("pointerleave", up);
  node.addEventListener("pointercancel", up);
  return {
    destroy() {
      anim?.cancel();
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("pointerup", up);
      node.removeEventListener("pointerleave", up);
      node.removeEventListener("pointercancel", up);
    },
  };
}

// 视图过渡：整页交叉淡化（切换深浅主题）。浏览器不支持 / 减少动态效果时直接执行。
export function withViewTransition(fn: () => void) {
  const d = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (!d.startViewTransition || reducedMotion()) {
    fn();
    return;
  }
  try {
    d.startViewTransition(fn);
  } catch {
    fn();
  }
}
