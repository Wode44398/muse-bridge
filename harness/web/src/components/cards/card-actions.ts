// 交互卡用到的过渡与动作（只给 components/cards/ 用；要碰 DOM，所以不放进 lib 的纯函数模块）。
import { handleCopyClick } from "../../lib/copy-click.ts";
import { reducedMotion, SPRING_SOFT } from "../../lib/motion.ts";

// ── 滚动边缘：内容在卡片里滚动时，被裁掉的那一侧渐隐（告诉人「下面还有」）─────────────────
// 给节点切 fade-top / fade-bottom 两个类（组件里写成 :global(.fade-top)——运行时加的类会被编译器剪掉）。
export function scrollEdges(node: HTMLElement) {
  let raf = 0;
  const check = () => {
    raf = 0;
    const max = node.scrollHeight - node.clientHeight;
    node.classList.toggle("fade-top", max > 2 && node.scrollTop > 2);
    node.classList.toggle("fade-bottom", max > 2 && node.scrollTop < max - 2);
  };
  const soon = () => {
    if (!raf) raf = requestAnimationFrame(check);
  };
  check();
  node.addEventListener("scroll", soon, { passive: true });
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(soon);
  ro?.observe(node);
  if (node.firstElementChild) ro?.observe(node.firstElementChild);
  return {
    destroy() {
      cancelAnimationFrame(raf);
      node.removeEventListener("scroll", soon);
      ro?.disconnect();
    },
  };
}

// ── 代码块「复制」：卡片自己挂一份委托 ────────────────────────────────────────────────
// 时间线的委托只在 Feed 上；停在输入框上方的计划卡不在 Feed 里，以前代码块的复制钮点了没反应（规格 ⚠）。
// 原生监听挂在卡片根上；复制钮的点击处理完就不再往上冒（Feed 那份委托不会再复制一遍）。
export function copyClicks(node: HTMLElement) {
  const on = (e: MouseEvent) => {
    if (handleCopyClick(e)) e.stopPropagation();
  };
  node.addEventListener("click", on);
  return {
    destroy() {
      node.removeEventListener("click", on);
    },
  };
}

// ── 占位行 → 回执：落定时平滑长到回执的高度 ──────────────────────────────────────────
// 卡片在等的时候，时间线里只有一行占位；落定的那一刻占位换成回执。回执挂载时如果这张卡「刚刚还在等」，
// 就从占位行的高度弹簧长到自己的自然高度（内容淡入），而不是一帧之间撑开。历史里直接渲染出来的回执不动。
// 「刚刚还在等」两个来源：
//   · markSettling：CardDock 在渲染阶段（$effect.pre）记下这一刻刚退出等待的卡——比时间线里回执的挂载动作早，
//     不管时间线用的是哪个占位行组件都成立；高度按一行占位估
//   · slotTrack：占位行自己挂上它，就记着自己的真实高度（cards/CardSlot.svelte 挂了）
const slots = new Map<string, { h: number; gone: number }>();
const SLOT_H = 36; // 不知道占位行多高时按一行估

export function markSettling(id: string) {
  const e = slots.get(id);
  if (e) {
    e.gone ||= Date.now();
    return;
  }
  const mark = { h: 0, gone: Date.now() };
  slots.set(id, mark);
  setTimeout(() => {
    if (slots.get(id) === mark) slots.delete(id);
  }, 2000);
}

export function slotTrack(node: HTMLElement, id: string) {
  let key = id;
  const note = () => slots.set(key, { h: node.offsetHeight, gone: 0 });
  note();
  const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(note);
  ro?.observe(node);
  return {
    update(next: string) {
      if (next === key) return;
      slots.delete(key);
      key = next;
      note();
    },
    destroy() {
      ro?.disconnect();
      const e = slots.get(key);
      if (!e) return;
      e.gone = Date.now();
      // 没有回执来接（换了会话、条目被收走）：过一会儿自己清掉
      const k = key;
      setTimeout(() => {
        if (slots.get(k) === e) slots.delete(k);
      }, 2000);
    },
  };
}

export function settleIn(node: HTMLElement, id: string) {
  const e = slots.get(id);
  if (!e) return;
  slots.delete(id);
  if (e.gone && Date.now() - e.gone > 1500) return; // 换会话回来才看到的回执：不演
  if (typeof node.animate !== "function") return;
  if (reducedMotion()) {
    node.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 160 });
    return;
  }
  const to = node.offsetHeight;
  const from = Math.min(e.h || SLOT_H, to);
  const easing = getComputedStyle(node).getPropertyValue("--spring-soft").trim() || "cubic-bezier(.2,.9,.25,1)";
  const prev = node.style.overflow;
  node.style.overflow = "clip";
  const anim = node.animate(
    [
      { height: `${from}px`, opacity: 0.35 },
      { height: `${to}px`, opacity: 1 },
    ],
    { duration: SPRING_SOFT.ms, easing },
  );
  anim.onfinish = anim.oncancel = () => (node.style.overflow = prev);
}
