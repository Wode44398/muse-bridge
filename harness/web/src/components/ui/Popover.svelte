<script lang="ts">
  // 弹层基建：菜单、上下文面板、选择器都用它。
  //  · position:fixed + 视口钳制：不受任何祖先 overflow / transform 裁剪（以前模型菜单被输入框圆角裁头）
  //  · 挂到 .hxroot（#94）：侧栏是层叠上下文，伸进主区的那截会被主区盖住、点不到；不挂 body——主题变量在
  //    .hxroot 上，委托的点击事件也要从挂载根走
  //  · 内容尺寸变了会重新定位（异步加载的行）；窗口缩放 / 任何滚动也会
  //  · 登记进浮层栈：返回键 / Esc 先关它；桌面壳的原生浏览器视图挂载期间让位
  //  · 从锚点方向弹出（transform-origin 跟着上下翻转与对齐走）
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import { pushLayer } from "../../lib/layers.ts";
  import { pop } from "../../lib/motion.ts";

  let {
    anchor,
    onclose,
    children,
    prefer = "up",
    align = "start",
    minWidth = 200,
    maxWidth = 360,
    offset = 8,
    role = "menu",
    label,
    flush = false,
  }: {
    anchor: HTMLElement | null | undefined;
    onclose: () => void;
    children: Snippet;
    prefer?: "up" | "down";
    align?: "start" | "end" | "center";
    minWidth?: number;
    maxWidth?: number;
    offset?: number;
    role?: "menu" | "dialog" | "listbox";
    label?: string;
    flush?: boolean;
  } = $props();

  let el: HTMLDivElement | undefined = $state();
  let pos = $state({ left: 0, top: 0, origin: "bottom left", placed: false });
  const M = 10; // 视口留白

  function place() {
    if (!el || !anchor) return;
    let a: DOMRect;
    try {
      a = anchor.getBoundingClientRect();
    } catch {
      a = new DOMRect(20, 20, 20, 20);
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = align === "end" ? a.right - w : align === "center" ? a.left + a.width / 2 - w / 2 : a.left;
    left = Math.max(M, Math.min(left, vw - M - w));
    const upTop = a.top - offset - h;
    const downTop = a.bottom + offset;
    let top: number;
    let up: boolean;
    if (prefer === "up") {
      up = upTop >= M;
      top = up ? upTop : Math.min(downTop, vh - M - h);
    } else {
      up = !(downTop + h <= vh - M) && upTop >= M;
      top = up ? upTop : Math.min(downTop, Math.max(M, vh - M - h));
    }
    top = Math.max(M, top);
    const ox = align === "end" ? "right" : align === "center" ? "center" : "left";
    pos = { left: Math.round(left), top: Math.round(top), origin: `${up ? "bottom" : "top"} ${ox}`, placed: true };
  }

  function portal(node: HTMLElement) {
    const root = anchor?.closest(".hxroot") ?? document.querySelector(".hxroot");
    if (root && node.parentElement !== root) root.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  onMount(() => {
    place();
    const release = pushLayer(onclose);
    const ro = new ResizeObserver(() => place());
    if (el) ro.observe(el);
    const onScroll = (e: Event) => {
      // 自己内部滚动不算
      if (el && e.target instanceof Node && el.contains(e.target)) return;
      place();
    };
    // 点在外面就关（按下即关，不等松手）；点在锚点上交给调用方（它自己切开关）
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (!t || el?.contains(t) || anchor?.contains(t)) return;
      onclose();
    };
    window.addEventListener("resize", place);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("pointerdown", onDown, true);
    // 桌面上接管焦点（方向键 / Esc 可用）；触屏不抢——抢了会收起输入框的软键盘
    if (matchMedia("(pointer: fine)").matches) el?.focus({ preventScroll: true });
    return () => {
      release();
      ro.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("pointerdown", onDown, true);
    };
  });

  // 方向键在菜单项之间移动焦点
  function onKey(e: KeyboardEvent) {
    if (role !== "menu" && role !== "listbox") return;
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const items = [
      ...(el?.querySelectorAll<HTMLElement>(
        '[role="menuitem"]:not([disabled]), [role="menuitemradio"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled]), [role="option"]:not([aria-disabled="true"])',
      ) ?? []),
    ];
    if (!items.length) return;
    e.preventDefault();
    const i = items.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  }
</script>

<div
  bind:this={el}
  use:portal
  class="pop"
  class:flush
  class:placed={pos.placed}
  style="left:{pos.left}px;top:{pos.top}px;min-width:min({minWidth}px, calc(100vw - 20px));max-width:min({maxWidth}px, calc(100vw - 20px));transform-origin:{pos.origin}"
  {role}
  aria-label={label}
  tabindex="-1"
  onkeydown={onKey}
  in:pop|global
  out:pop|global
>
  {@render children()}
</div>

<style>
  .pop {
    position: fixed;
    z-index: 70;
    max-height: min(460px, calc(100dvh - 24px));
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px;
    border-radius: 14px;
    background: var(--surface);
    color: var(--text);
    font-size: var(--fs-base);
    line-height: var(--lh-ui);
    box-shadow:
      0 0 0 1px var(--border),
      var(--shadow-2);
    visibility: hidden;
  }
  /* 触屏：菜单行 40px、说明折两行，同一份菜单比桌面高出一截——460 的封顶会把档位菜单拦腰截断（还有大半屏空着）；
     只要视口放得下就给到 640（仍不超出视口） */
  @media (pointer: coarse) {
    .pop {
      max-height: min(640px, calc(100dvh - 24px));
    }
  }

  .pop.placed {
    visibility: visible;
  }
  .flush {
    padding: 0;
  }
  .pop:focus-visible {
    outline: none;
  }
</style>
