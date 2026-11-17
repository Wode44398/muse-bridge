<script lang="ts">
  // 宽屏工作区顶带的工具开关组：每颗是一张卡的开关，开着的那颗呈按下态（可以同时按下好几颗）。
  // 不做滑动选中块——这里不是「多选一」，是一排各管各的开关。
  // 放不下图标 + 文字（工作区拖得很窄）就只留图标；在跑的小点只在那张卡没摆出来时挂。
  import type { IconName } from "../../lib/icons.ts";
  import type { DockTool } from "../../lib/state.svelte.ts";
  import { press } from "../../lib/motion.ts";
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
    on,
    live,
    ontoggle,
  }: {
    tools: readonly Tool[];
    on: readonly DockTool[];
    live: Partial<Record<DockTool, boolean>>;
    ontoggle: (k: DockTool) => void;
  } = $props();
</script>

<div class="tg" role="toolbar" aria-label={t("工作区工具")}>
  {#each tools as tool (tool.key)}
    {@const pressed = on.includes(tool.key)}
    <button
      class="tb"
      class:on={pressed}
      aria-pressed={pressed}
      aria-label={tool.label}
      title={tool.kbd ? t("{label}（{kbd}）", { label: tool.label, kbd: tool.kbd }) : tool.label}
      use:press={{ scale: 0.94 }}
      onclick={() => ontoggle(tool.key)}
    >
      <span class="ic"><Icon name={tool.icon} size={15} stroke={1.7} /></span>
      <span class="lbl">{tool.label}</span>
      {#if live[tool.key]}<span class="dot" aria-hidden="true"></span>{/if}
    </button>
  {/each}
</div>

<style>
  .tg {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 2px;
    overflow-x: auto;
    scrollbar-width: none;
    container-type: inline-size;
  }
  .tg::-webkit-scrollbar {
    display: none;
  }
  .tb {
    position: relative;
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 12px 0 10px;
    border-radius: var(--r-pill);
    color: var(--text3);
    font-size: var(--fs-md);
    font-weight: 500;
    white-space: nowrap;
    -webkit-app-region: no-drag;
    transition:
      color var(--t-fast) var(--ease),
      background-color var(--t-fast) var(--ease),
      box-shadow var(--t-fast) var(--ease);
  }
  .tb.on {
    color: var(--text);
    background: var(--surface2);
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
    box-shadow: 0 0 0 2px var(--bg);
    animation: hx-breathe 2s var(--ease-in-out) infinite;
  }
  @media (hover: hover) {
    .tb:not(.on):hover {
      color: var(--text);
      background: color-mix(in srgb, var(--text) 4%, transparent);
    }
    .tb.on:hover {
      background: var(--surface3);
    }
  }
  .tb:active {
    background: var(--surface3);
  }
  .tb:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--live);
  }
  /* 六颗图标 + 文字约 500px：放不下就只留图标（圆角方，同 IconButton） */
  @container (max-width: 520px) {
    .lbl {
      display: none;
    }
    .tb {
      width: 32px;
      padding: 0;
      justify-content: center;
      border-radius: 10px;
    }
    .dot {
      top: 4px;
      right: 4px;
    }
  }
  @container (max-width: 640px) {
    .lbl:lang(en) {
      display: none;
    }
    .tb:lang(en) {
      width: 32px;
      padding: 0;
      justify-content: center;
      border-radius: 10px;
    }
  }
  @media (pointer: coarse) {
    .tb {
      height: 40px;
      min-width: 40px;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dot {
      animation: none;
    }
  }
</style>
