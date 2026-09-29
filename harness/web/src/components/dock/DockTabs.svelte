<script lang="ts">
  // 工作区的工具标签带：图标 + 文字，选中底块跟着滑（快弹簧）；容器窄到放不下（< 352px，手机 / 最窄的分栏）只留文字。
  // 跟手（09-26 的问题：功能选中聚焦移动有点慢，不太跟手）：按下就先滑向按着的那一项；松手后块先动，面板等块动起来
  // 之后再换——换面板要整块重挂（终端重连、浏览器重新订阅），跟块挤在同一帧里，块的头几帧就被吃掉了。落位规则在 lib/slide.ts。
  // 键盘：左右键 / Home / End 只在标签间移动焦点，回车 / 空格才切换——切工具会整块重挂面板
  // （终端重连、浏览器重新订阅），不能方向键一按就切。
  // 在跑的小点：任务（子 agent / 工作流 / 后台命令在跑）、浏览器（agent 浏览器活着）——只在没看着它时挂。
  import { untrack } from "svelte";
  import type { IconName } from "../../lib/icons.ts";
  import type { DockTool } from "../../lib/state.svelte.ts";
  import { press } from "../../lib/motion.ts";
  import { IND_HIDDEN, slideTarget, slideTo, type Ind } from "../../lib/slide.ts";
  import { pressHold } from "../../lib/press-hold.ts";
  import { t } from "../../lib/i18n.ts";
  import Icon from "../ui/Icon.svelte";

  interface Tool {
    key: DockTool;
    label: string;
    icon: IconName;
    kbd: string;
  }

  let {
    tools,
    value,
    live,
    idBase,
    onpick,
  }: {
    tools: readonly Tool[];
    value: DockTool;
    live: Partial<Record<DockTool, boolean>>;
    idBase: string;
    onpick: (k: DockTool) => void;
  } = $props();

  let list: HTMLDivElement | undefined = $state();
  let ind = $state<Ind>(IND_HIDDEN);
  let pressed = $state<DockTool | null>(null);
  let picked = $state<DockTool | null>(null);
  const target = $derived(slideTarget(pressed, picked, value));

  function measure() {
    const key = target;
    const btn = list?.querySelector<HTMLElement>(`[data-k="${key}"]`);
    const prev = untrack(() => ind);
    const next = slideTo(prev, btn ? { x: btn.offsetLeft, w: btn.offsetWidth } : null, key);
    if (next !== prev) ind = next;
  }

  $effect(() => {
    void target;
    void tools.length;
    measure();
  });
  // 值变了（面板换好了，或者快捷键从别处切的）：「刚点的」使命结束
  $effect(() => {
    void value;
    untrack(() => (picked = null));
  });

  // 按下就先滑过去（lib/press-hold.ts：松在哪都算——手机上标签带往下拖可关，拖走的那一下按钮自己收不到 pointerup；
  // 滚动取消立刻清；触屏不拿 pointerleave 清）
  const hold = pressHold<DockTool>(
    (k) => (pressed = k),
    () => pressed,
  );
  // 块这一帧先画出去，隔一帧再换面板；中途又点了别的，以最后一次为准
  function pick(k: DockTool) {
    hold.settle();
    if (k === value) return;
    picked = k;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (picked === k) onpick(k);
      }),
    );
  }
  // 容器变宽窄（分栏拖动、图标收起）、字体晚到撑宽按钮，都要重量一次
  $effect(() => {
    if (!list) return;
    const ro = new ResizeObserver(() => measure());
    ro.observe(list);
    for (const b of list.querySelectorAll<HTMLElement>("[data-k]")) ro.observe(b);
    return () => ro.disconnect();
  });

  function onKey(e: KeyboardEvent) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight" && e.key !== "Home" && e.key !== "End") return;
    const btns = [...(list?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])];
    const i = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (i < 0) return;
    e.preventDefault();
    const n =
      e.key === "Home" ? 0 : e.key === "End" ? btns.length - 1 : e.key === "ArrowRight" ? (i + 1) % btns.length : (i - 1 + btns.length) % btns.length;
    btns[n]?.focus();
  }
</script>

<div class="tabs" bind:this={list} role="tablist" aria-label={t("工作区工具")} tabindex="-1" onkeydown={onKey}>
  <span class="ind" class:shown={ind.shown} class:animate={ind.animate} style="transform:translateX({ind.x}px);width:{ind.w}px" aria-hidden="true"></span>
  {#each tools as tool (tool.key)}
    <button
      class="tab"
      class:on={tool.key === target}
      role="tab"
      id="{idBase}-tab-{tool.key}"
      aria-selected={tool.key === value}
      aria-controls="{idBase}-panel"
      tabindex={tool.key === value ? 0 : -1}
      data-k={tool.key}
      title={tool.kbd ? t("{label}（{kbd}）", { label: tool.label, kbd: tool.kbd }) : tool.label}
      use:press={{ scale: 0.95 }}
      onpointerdown={() => hold.down(tool.key)}
      onpointerleave={hold.leave}
      onclick={() => pick(tool.key)}
    >
      <span class="ic"><Icon name={tool.icon} size={15} stroke={1.7} /></span>
      <span class="lbl">{tool.label}</span>
      {#if live[tool.key]}<span class="dot" aria-hidden="true"></span>{/if}
    </button>
  {/each}
</div>

<style>
  .tabs {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
    isolation: isolate;
    container-type: inline-size;
  }
  .tabs::-webkit-scrollbar {
    display: none;
  }
  .tabs:focus-visible {
    outline: none;
  }
  /* 选中底块：跟着当前工具滑（transform + 宽度，同 Segmented 的做法） */
  .ind {
    position: absolute;
    top: 50%;
    left: 0;
    height: 32px;
    margin-top: -16px;
    border-radius: var(--r-pill);
    background: var(--surface2);
    z-index: -1;
    opacity: 0;
    pointer-events: none;
    will-change: transform;
  }
  .ind.shown {
    opacity: 1;
  }
  /* 快弹簧：260ms 就停、几乎不过冲；第一次落位不带过渡（不然从最左边滑进来） */
  .ind.animate {
    transition:
      transform var(--t-spring-snap, 260ms) var(--spring-snap, var(--ease-out)),
      width var(--t-spring-snap, 260ms) var(--spring-snap, var(--ease-out));
  }
  .tab {
    position: relative;
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 12px 0 10px;
    border-radius: var(--r-pill);
    color: var(--text2);
    font-size: var(--fs-md);
    font-weight: 500;
    white-space: nowrap;
    transition:
      color var(--t-fast) var(--ease),
      background-color var(--t-fast) var(--ease);
  }
  .tab.on {
    color: var(--text);
  }
  .ic {
    display: inline-flex;
  }
  .dot {
    position: absolute;
    top: 5px;
    right: 5px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--live);
    box-shadow: 0 0 0 2px var(--dk-bg, var(--bg));
    animation: hx-breathe 2s var(--ease-in-out) infinite;
  }
  @media (hover: hover) {
    .tab:not(.on):hover {
      color: var(--text);
      background: color-mix(in srgb, var(--text) 4%, transparent);
    }
  }
  .tab:not(.on):active {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  /* 放不下图标 + 文字：只留文字（中文两三个字比图标更好认） */
  @container (max-width: 352px) {
    .ic {
      display: none;
    }
    .tab {
      padding: 0 11px;
    }
    .dot {
      top: 4px;
      right: 3px;
    }
  }
  /* 英文标签（Terminal / Browser…）长一截：放不下图标的门槛相应抬高 */
  @container (max-width: 470px) {
    .ic:lang(en) {
      display: none;
    }
    .tab:lang(en) {
      padding: 0 11px;
    }
    .dot:lang(en) {
      top: 4px;
      right: 3px;
    }
  }
  @media (pointer: coarse) {
    .tab {
      height: 40px;
    }
    .ind {
      height: 40px;
      margin-top: -20px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }
</style>
