<script lang="ts">
  // 活动行：在跑时常驻在时间线末尾（量线的最后一个节点 = 权衡中的标志）——此刻在做什么 + 本轮用时 + 停止。
  //   activity 为空 = 在等人点卡片：标志不动、不写字，但计时停在那一刻、停止键照样在。
  //
  // U3（X38）：运行计时从本轮开跑算起，卡片等人期间暂停（服务端记账，这里只按秒重绘；老服务端没有 run_clock 就不显示）。
  // U1（#53）：停止从输入框挪到这里。以前发送键和停止键是同一个按钮——插话发出、输入框一空，它原位变成停止键，
  // 手机上多点一下整轮（连同 60 分钟的工作流）就没了。有工作流或子 agent 在跑时要 3 秒内点两次。
  import { stop } from "../../lib/state.svelte.ts";
  import { elapsedLabel, runElapsedMs } from "../../lib/timeline-reducer.ts";
  import { haptic } from "../../lib/touch.ts";
  import { press } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import Mark from "../brand/Mark.svelte";
  import RailRow from "./RailRow.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t, tr } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let { up = false }: { up?: boolean } = $props();

  let nowTick = $state(Date.now());
  $effect(() => {
    if (!pane.chat.running || !pane.chat.clock) return;
    nowTick = Date.now();
    const timer = setInterval(() => (nowTick = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const elapsed = $derived(pane.chat.running && pane.chat.clock ? elapsedLabel(runElapsedMs(pane.chat.clock, nowTick)) : "");

  let armed = $state(false);
  let armTimer = 0;
  $effect(() => () => clearTimeout(armTimer));

  // workflowRefs / agentRefs 是普通 Map（不响应），只在点的那一刻读
  function delegationRunning(): boolean {
    for (const w of pane.chat.workflowRefs.values()) if (w.status === "running") return true;
    for (const a of pane.chat.agentRefs.values()) if (a.status === "running") return true;
    return false;
  }
  function onStop() {
    if (delegationRunning() && !armed) {
      armed = true;
      haptic("light");
      clearTimeout(armTimer);
      armTimer = window.setTimeout(() => (armed = false), 3000);
      return;
    }
    clearTimeout(armTimer);
    armed = false;
    haptic("medium");
    void stop();
  }
</script>

<RailRow {up} clear={10}>
  {#snippet node()}
    <span class="mk"><Mark size={16} live={Boolean(pane.chat.activity)} /></span>
  {/snippet}
  {#snippet head()}
    {#if pane.chat.activity}<span class="what hx-shimmer">{tr(pane.chat.activity)}</span>{/if}
    {#if elapsed}<span class="time" title={t("本轮已运行（等你处理卡片的时间不算）")}>{elapsed}</span>{/if}
    <button
      class="stop"
      class:armed
      onclick={onStop}
      aria-label={t("停止这一轮")}
      title={armed ? t("有工作流或子 agent 在跑，再点一次才停") : t("停止这一轮")}
      use:press={{ scale: 0.95 }}
    >
      <Icon name="stop" size={14} fill />
      <span>{armed ? t("再点一次停止") : t("停止")}</span>
    </button>
  {/snippet}
</RailRow>

<style>
  .mk {
    display: grid;
    color: var(--text2);
  }
  .what {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-base);
  }
  .time {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
    color: var(--text3);
  }
  .stop {
    display: inline-flex;
    flex: none;
    align-items: center;
    gap: 5px;
    height: 28px;
    margin-left: auto;
    padding: 0 11px 0 8px;
    border-radius: var(--r-pill);
    font-size: var(--fs-md);
    font-weight: 500;
    color: var(--text2);
    white-space: nowrap;
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .stop:active {
    background: var(--surface3);
  }
  .stop.armed {
    background: color-mix(in srgb, var(--err) 11%, transparent);
    color: var(--err);
  }
  @media (hover: hover) {
    .stop:hover {
      background: var(--surface2);
      color: var(--text);
    }
    .stop.armed:hover {
      background: color-mix(in srgb, var(--err) 17%, transparent);
      color: var(--err);
    }
  }
  @media (pointer: coarse) {
    .stop {
      height: 34px;
      padding: 0 13px 0 10px;
    }
  }
</style>
