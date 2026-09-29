<script lang="ts">
  // 拖拽时跟手的那张卡（全 app 唯一一层，lib/dnd.svelte.ts 驱动）：从原位抬起来、跟着手指走，底下一行写松手会发生什么；
  // 落进落点就在原地缩掉，取消就飞回原位。自己 pointer-events:none，命中判定穿过它。
  import { dnd } from "../../lib/dnd.svelte.ts";
  import Icon from "../ui/Icon.svelte";
  import VendorLogo from "../brand/VendorLogo.svelte";
  import { t } from "../../lib/i18n.ts";
</script>

{#if dnd.on}
  <div
    class="ghost {dnd.phase}"
    class:moved={dnd.moved}
    style="transform: translate({dnd.x + dnd.ox}px, {dnd.y + dnd.oy}px) translate(-50%, -50%)"
    aria-hidden="true"
  >
    <div class="card">
      {#if dnd.kind === "session"}
        <span class="ic"><VendorLogo skin={dnd.provider} size={13} mono /></span>
      {:else}
        <span class="ic"><Icon name="folder" size={15} /></span>
      {/if}
      <span class="t">{dnd.title || t("（空会话）")}</span>
    </div>
    {#if dnd.overLabel}
      <div class="hint">{dnd.overLabel}</div>
    {/if}
  </div>
{/if}

<style>
  .ghost {
    position: fixed;
    left: 0;
    top: 0;
    z-index: 200;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    pointer-events: none;
    will-change: transform;
  }
  .card {
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: 260px;
    height: 38px;
    padding: 0 14px 0 12px;
    border-radius: 12px;
    background: var(--surface);
    color: var(--text);
    font-size: var(--fs-md);
    box-shadow:
      0 0 0 1px var(--border),
      inset 0 1px 0 var(--sheen),
      var(--shadow-2);
    animation: lift var(--t-spring) var(--spring) both;
    transition:
      transform var(--t-fast) var(--ease-out),
      opacity var(--t-fast) var(--ease);
  }
  .moved .card {
    transform: scale(1.02) rotate(-1.2deg);
  }
  .ic {
    display: inline-flex;
    flex: none;
    color: var(--text2);
  }
  .t {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint {
    padding: 3px 10px;
    border-radius: var(--r-pill);
    background: var(--primary);
    color: var(--on-primary);
    font-size: var(--fs-xs);
    font-weight: 500;
    line-height: 1.5;
    white-space: nowrap;
    box-shadow: var(--shadow-1);
  }
  /* 落进落点：在原地缩掉；取消：飞回原位再淡出（位置由 dnd.x / y 改到原位，这里只管过渡） */
  .ghost.drop .card {
    transform: scale(0.86);
    opacity: 0;
    transition:
      transform 200ms var(--ease-in),
      opacity 200ms var(--ease-in);
  }
  .ghost.drop .hint {
    opacity: 0;
    transition: opacity 120ms var(--ease-in);
  }
  .ghost.cancel {
    transition: transform 200ms var(--ease-out);
  }
  .ghost.cancel .card {
    opacity: 0;
    transition: opacity 200ms var(--ease-in) 60ms;
  }
  .ghost.cancel .hint {
    display: none;
  }
  @keyframes lift {
    from {
      transform: scale(0.96);
      opacity: 0.6;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .card,
    .ghost.cancel,
    .ghost.drop .card {
      animation: none;
      transition: opacity 80ms linear;
    }
  }
</style>
