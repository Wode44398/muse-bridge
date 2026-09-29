<script lang="ts">
  // 实时预览 / Agent 浏览器入口胶囊：和计划条同住输入框上方的那一行（以前是悬浮层，会盖在计划条上）。
  // 有在跑的 dev server = 绿点「实时预览」，点开工作区浏览器并把应用直接拉进共享浏览器；否则 = 「Agent 浏览器」。
  // 工作区开着时不显示（Above 管显隐）。
  import { openDock } from "../../lib/state.svelte.ts";
  import * as api from "../../lib/api.ts";
  import { haptic } from "../../lib/touch.ts";
  import { fade, pop, press } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  function open() {
    haptic("light");
    openDock("browser");
    if (pane.chat.preview) api.browserNavigate({ url: pane.chat.preview.url }).catch(() => {});
  }
</script>

<button
  class="pill"
  title={pane.chat.preview ? t("在工作区浏览器里打开 {url}", { url: pane.chat.preview.url }) : t("打开工作区浏览器")}
  use:press={{ scale: 0.96 }}
  onclick={open}
  in:pop|global={{ from: 0.9 }}
  out:fade|global={{ duration: 140 }}
>
  {#if pane.chat.preview}
    <span class="live" aria-hidden="true"></span>
    <span>{t("实时预览")}</span>
  {:else}
    <span class="ic"><Icon name="globe" size={15} /></span>
    <span>{t("Agent 浏览器")}</span>
  {/if}
  <span class="chev"><Icon name="chevronR" size={14} /></span>
</button>

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    gap: 7px;
    flex: none;
    height: 40px;
    padding: 0 10px 0 14px;
    border-radius: var(--r-pill);
    background: var(--surface);
    color: var(--text);
    font-size: var(--fs-md);
    font-weight: 500;
    white-space: nowrap;
    box-shadow: var(--shadow-1);
    transform-origin: 100% 100%;
    transition: background-color var(--t-fast) var(--ease);
  }
  :global(.hxroot[data-mode="dark"]) .pill {
    box-shadow:
      0 0 0 1px var(--border),
      var(--shadow-1);
  }
  @media (hover: hover) {
    .pill:hover {
      background: var(--surface2);
    }
  }
  .pill:active {
    background: var(--surface2);
  }
  .live {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--ok);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent);
    animation: pv-breathe 2.4s var(--ease-in-out) infinite;
  }
  .ic {
    display: inline-flex;
    color: var(--text2);
  }
  .chev {
    display: inline-flex;
    margin-left: -2px;
    color: var(--text3);
  }
  @keyframes pv-breathe {
    50% {
      opacity: 0.45;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .live {
      animation: none;
    }
  }
</style>
