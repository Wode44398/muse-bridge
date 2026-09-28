<script lang="ts">
  // P10（Codex X39、hermes）：卡片刚停进来 DOCK_ARM_MS 内的点击不算——停在输入框上方的卡离发送键只有一指之距，
  // 正要点发送、点键盘的那一下不能落成「允许」。只吞点击（含回车 / 空格合成的 click），不挡滚动与选字。
  //
  // 必须在【捕获阶段】拦：Svelte 5 的 onclick 是委托的——监听挂在挂载根上、冒泡阶段才分发，
  // 按钮自己身上没有监听。捕获阶段在包裹层上 stopPropagation，事件到不了目标，也冒不回根上的委托。
  // 每张卡重新挂载一次（CardDock 按卡片 id 分项），计时随之重来。
  import { onMount, type Snippet } from "svelte";
  import { DOCK_ARM_MS } from "../../lib/card-dock.ts";

  let { children }: { children: Snippet } = $props();

  // 不需要响应：只在事件回调里读
  let armed = false;
  onMount(() => {
    const t = setTimeout(() => (armed = true), DOCK_ARM_MS);
    return () => clearTimeout(t);
  });

  function swallow(e: MouseEvent) {
    if (armed) return;
    e.stopPropagation();
    e.preventDefault();
  }
</script>

<div class="cardguard" onclickcapture={swallow}>{@render children()}</div>

<style>
  .cardguard {
    display: contents;
  }
</style>
