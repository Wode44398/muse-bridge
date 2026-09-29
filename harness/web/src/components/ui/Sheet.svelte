<script lang="ts">
  // 面板：手机（<700px）= 底部抽屉，把手 / 标题行可以往下拖着关（按位移或甩的速度判定），弹簧滑入；
  //       桌面 = 居中对话框，轻微浮起 + 放大进场。
  // 共同：遮罩点一下关、Esc / 返回键关（浮层栈）、挂载期间让桌面壳原生浏览器视图退下、正文单独滚动、
  //       footer 钉在底部（手机上吃底部安全区）。dismissible=false 的是「门」（连接页），关不掉。
  // onback = 面板里有层级（记忆：总览 → 某个项目；或从设置点进来）：标题左边一枚「‹」，Esc / 返回键先退一级，
  //       遮罩、右上角 ×、下拉照旧整个关掉。
  import type { Snippet } from "svelte";
  import { onMount } from "svelte";
  import { pushLayer } from "../../lib/layers.ts";
  import { fade, reducedMotion, SPRING_SOFT } from "../../lib/motion.ts";
  import { dragClose } from "../../lib/touch.ts";
  import IconButton from "./IconButton.svelte";
  import { t } from "../../lib/i18n.ts";

  let {
    title,
    subtitle,
    onclose = () => {},
    onback,
    backLabel = t("返回"),
    size = "md",
    dismissible = true,
    tall = false,
    children,
    footer,
    actions,
  }: {
    title: string;
    subtitle?: string;
    onclose?: () => void;
    onback?: () => void;
    backLabel?: string;
    size?: "sm" | "md" | "lg" | "xl";
    dismissible?: boolean;
    tall?: boolean;
    children: Snippet;
    footer?: Snippet;
    actions?: Snippet;
  } = $props();

  const mq = matchMedia("(min-width: 700px)");
  let wide = $state(mq.matches);
  let panel: HTMLDivElement | undefined = $state();
  let head: HTMLDivElement | undefined = $state();
  let dragged = false; // 拖着关掉的：退场动画已经由手势做完了，别再跳回来重播一遍

  onMount(() => {
    const onMq = (e: MediaQueryListEvent) => (wide = e.matches);
    mq.addEventListener("change", onMq);
    const release = dismissible ? pushLayer(() => (onback ? onback() : onclose())) : pushLayer(() => {}, { escape: false });
    if (wide) panel?.focus({ preventScroll: true });
    return () => {
      mq.removeEventListener("change", onMq);
      release();
    };
  });

  // 进场 / 退场：手机从底边滑入（柔弹簧），桌面浮起 + 放大；退场一律短促
  function enter(node: Element, _p: unknown, opts: { direction?: string } = {}) {
    const leaving = opts.direction === "out";
    if (reducedMotion()) return { duration: leaving ? 100 : 160, css: (k: number) => `opacity:${k}` };
    if (leaving && dragged) return { duration: 0 };
    if (wide) {
      return {
        duration: leaving ? 150 : SPRING_SOFT.ms,
        easing: leaving ? (k: number) => k * k : SPRING_SOFT.ease,
        css: (k: number, u: number) => `opacity:${Math.min(1, k * 1.6)};transform:translateY(${(u * 10).toFixed(2)}px) scale(${(1 - u * 0.03).toFixed(4)})`,
      };
    }
    const h = (node as HTMLElement).getBoundingClientRect().height + 24;
    return {
      duration: leaving ? 220 : SPRING_SOFT.ms + 80,
      easing: leaving ? (k: number) => k * k : SPRING_SOFT.ease,
      css: (_t: number, u: number) => `transform:translateY(${(u * h).toFixed(1)}px)`,
    };
  }

  function grab(node: HTMLElement) {
    if (!dismissible) return {};
    return dragClose(node, {
      onClose: () => {
        dragged = true;
        onclose();
      },
      handle: () => head ?? null,
    });
  }
</script>

<div class="overlay" class:wide role="presentation">
  <button class="scrim" aria-label={t("关闭")} tabindex="-1" onclick={() => dismissible && onclose()} in:fade|global={{ duration: 220 }} out:fade|global={{ duration: 220 }}></button>
  <!-- in: / out: 分开写：transition: 指令传给过渡函数的 direction 是 "both"，分不出进退场 -->
  <div
    bind:this={panel}
    class="panel {size}"
    class:tall
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    use:grab
    in:enter|global
    out:enter|global
  >
    <div class="head" class:back={Boolean(onback)} bind:this={head}>
      {#if !wide}<div class="grip" aria-hidden="true"></div>{/if}
      {#if onback}<IconButton icon="chevronL" label={backLabel} size={32} onclick={onback} />{/if}
      <div class="titles">
        <h2>{title}</h2>
        {#if subtitle}<p>{subtitle}</p>{/if}
      </div>
      {#if actions}<div class="actions">{@render actions()}</div>{/if}
      {#if dismissible}
        <IconButton icon="close" label={t("关闭")} size={32} onclick={onclose} />
      {/if}
    </div>
    <div class="content">{@render children()}</div>
    {#if footer}<div class="foot">{@render footer()}</div>{/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    align-items: stretch;
  }
  .overlay.wide {
    justify-content: center;
    align-items: center;
    padding: 40px 24px;
  }
  .scrim {
    position: absolute;
    inset: 0;
    background: var(--scrim);
    cursor: default;
  }
  .panel {
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
    max-height: calc(100dvh - 40px - var(--sat, 0px));
    background: var(--surface);
    color: var(--text);
    border-radius: 22px 22px 0 0;
    box-shadow: var(--shadow-3);
    transition: transform 280ms var(--ease-out);
    touch-action: pan-y;
  }
  .panel.tall {
    height: calc(100dvh - 40px - var(--sat, 0px));
  }
  .wide .panel {
    width: min(560px, 100%);
    max-height: min(760px, 100%);
    border-radius: 20px;
    box-shadow:
      0 0 0 1px var(--border),
      var(--shadow-3);
    transition: none;
    touch-action: auto;
  }
  .wide .panel.sm {
    width: min(420px, 100%);
  }
  .wide .panel.lg {
    width: min(720px, 100%);
  }
  .wide .panel.xl {
    width: min(880px, 100%);
  }
  .wide .panel.tall {
    height: min(760px, 100%);
  }
  .panel:focus-visible {
    outline: none;
  }

  .head {
    position: relative;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 18px 12px 10px 22px;
    flex: none;
    touch-action: none;
  }
  .wide .head {
    padding: 16px 12px 8px 24px;
    touch-action: auto;
  }
  /* 左边有「‹」时，它的圆角方光学上对齐正文左缘（图标本身有留白） */
  .head.back {
    padding-left: 12px;
  }
  .wide .head.back {
    padding-left: 14px;
  }
  .grip {
    position: absolute;
    top: 7px;
    left: 50%;
    width: 36px;
    height: 4px;
    margin-left: -18px;
    border-radius: 2px;
    background: var(--border2);
  }
  .titles {
    flex: 1;
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: var(--fs-lg);
    font-weight: 600;
    line-height: 1.3;
    letter-spacing: -0.005em;
  }
  .titles p {
    margin: 3px 0 0;
    font-size: var(--fs-md);
    color: var(--text3);
    line-height: 1.45;
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 6px 22px calc(22px + var(--sab, 0px));
  }
  .wide .content {
    padding: 6px 24px 24px;
  }
  /* 定高的面板内容忽长忽短（筛选、切视图）：滚动条的位置常驻，出现 / 消失时正文不左右跳 */
  .wide .tall .content {
    scrollbar-gutter: stable;
  }
  .foot {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 18px calc(12px + var(--sab, 0px));
    border-top: 1px solid var(--border);
  }
  .panel:has(.foot) .content {
    padding-bottom: 18px;
  }
  .wide .foot {
    padding: 14px 20px;
  }
</style>
