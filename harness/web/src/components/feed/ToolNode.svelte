<script module lang="ts">
  export type NodeTone = "running" | "ok" | "fail" | "denied" | "stopped";
</script>

<script lang="ts">
  // 量线上的节点（工具行 / 工具组头 / 任务卡）：7px 小圆点。
  //   完成 = 强细线色实心（成功是默认，不上色）· 在跑 = 青、轻轻呼吸 · 失败 = err · 被拒 = warn
  //   · 已停止 / 被打断 = 灰色小叉（任务停了、这一轮停了但这一步没等到结果）
  // 名字刻意不叫 state（Svelte 5 的坑：组件里有叫 state 的变量，$state 会被当成 store 订阅）。
  import Icon from "../ui/Icon.svelte";

  let { tone }: { tone: NodeTone } = $props();
</script>

{#if tone === "stopped"}
  <span class="x"><Icon name="close" size={9} stroke={2.4} /></span>
{:else}
  <span class="dot" class:run={tone === "running"} class:fail={tone === "fail"} class:denied={tone === "denied"}></span>
{/if}

<style>
  .dot {
    display: block;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--border2);
    transition:
      background-color var(--t-med) var(--ease),
      box-shadow var(--t-med) var(--ease);
  }
  .run {
    background: var(--live);
    box-shadow: 0 0 0 3px var(--live-soft);
    animation: tn-breathe 1.8s var(--ease-in-out) infinite;
  }
  .fail {
    background: var(--err);
  }
  .denied {
    background: var(--warn);
  }
  .x {
    display: grid;
    place-items: center;
    width: 9px;
    height: 9px;
    color: var(--text3);
  }
  @keyframes tn-breathe {
    50% {
      opacity: 0.45;
      box-shadow: 0 0 0 1px var(--live-soft);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .run {
      animation: none;
    }
  }
</style>
