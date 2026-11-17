<script lang="ts">
  // 活动行：在跑时常驻在时间线末尾——在跑的标志 + 本轮用时 + 此刻在做什么 + 停止。对齐 bridge Claude 分页（= 官方 /code 页）
  // 的状态行：只说「大类」，具体是哪一步由工具组头 / 工具行自己说（同屏同一件事只说一次）——
  //   思考 = 按已想时长分档（思考中… / 仍在思考… / 深入思考中… …）；有工具在跑 =「运行工具中…」（后面跟在跑的子 agent 数）；
  //   在等人点卡片 =「需要你的输入」（标志停下，计时停在那一刻，停止键照样在）；在写正文 = 不说话（字就在上面长）；
  //   其余（等模型回复、写工具参数、整理上下文、限流重试、等网络……）照服务端 / 归约器给的说。
  //   思考行正露在屏上、自己在说「思考中…」时，这里不再重复。
  //
  // U3（X38）：运行计时从本轮开跑算起，卡片等人期间暂停（服务端记账，这里只按秒重绘；老服务端没有 run_clock 就不显示）。
  // U1（#53）：停止从输入框挪到这里。以前发送键和停止键是同一个按钮——插话发出、输入框一空，它原位变成停止键，
  // 手机上多点一下整轮（连同 60 分钟的工作流）就没了。有工作流或子 agent 在跑时要 3 秒内点两次。
  //
  // compact = 精简模式（默认）：不上量线，标志排在行首；「显示全部工作过程」打开时标志是量线的最后一个节点。
  import { stop, type Item } from "../../lib/state.svelte.ts";
  import { elapsedLabel, runElapsedMs } from "../../lib/timeline-reducer.ts";
  import { thinkingLabel } from "../../lib/tool-summary.ts";
  import { liveClock } from "../../lib/live-clock.ts";
  import { morphText } from "../../lib/morph-text.ts";
  import { haptic } from "../../lib/touch.ts";
  import { press } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import Mark from "../brand/Mark.svelte";
  import RailRow from "./RailRow.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t, tr } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let { up = false, compact = false, thinkShown = false }: { up?: boolean; compact?: boolean; thinkShown?: boolean } = $props();

  let nowTick = $state(Date.now());
  $effect(() => {
    if (!pane.chat.running) return;
    nowTick = Date.now();
    const timer = setInterval(() => (nowTick = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const elapsed = $derived(pane.chat.running && pane.chat.clock ? elapsedLabel(runElapsedMs(pane.chat.clock, nowTick)) : "");

  // 这一轮里的条目（从最后一条用户自己发的消息往后）：有没有工具在跑、几个子 agent 在跑、在不在流思考
  const turn = $derived.by(() => {
    const tl = pane.chat.timeline;
    let tools = 0;
    let agents = 0;
    let think: Extract<Item, { kind: "thinking" }> | null = null;
    for (let i = tl.length - 1; i >= 0; i--) {
      const it = tl[i];
      if (it.kind === "user" && !it.steer) break;
      if (it.kind === "tool" && it.status === "running") {
        tools++;
        if (it.name === "Agent" && it.agent?.status !== "ok" && it.agent?.status !== "fail") agents++;
      } else if (it.kind === "thinking" && it.live && !think) think = it;
    }
    return { tools, agents, think };
  });
  type Phase = "wait" | "tools" | "think" | "write" | "other";
  const phase = $derived.by((): Phase => {
    const a = pane.chat.activity;
    if (!a) return "wait";
    if (turn.tools > 0) return "tools";
    if (turn.think || a === t("思考中")) return "think";
    if (a === t("回复中")) return "write";
    return "other";
  });
  // 分档的起点：流着的思考块从它开始算，没有块（模型闷头想下一步）从进入这一态算
  let thinkSince = $state(Date.now());
  $effect(() => {
    if (phase === "think") thinkSince = Date.now();
  });
  const hint = $derived.by(() => {
    switch (phase) {
      case "wait":
        return t("需要你的输入");
      case "tools":
        return t("运行工具中…");
      case "think":
        return thinkShown ? "" : thinkingLabel(nowTick - ((turn.think && liveClock(turn.think)?.t0) || thinkSince));
      case "write":
        return "";
      default:
        return tr(pane.chat.activity);
    }
  });
  const agentNote = $derived(phase === "tools" && turn.agents > 0 ? t("{n} 个子 agent", { n: turn.agents }) : "");

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

{#snippet line()}
  {#if elapsed}<span class="time" title={t("本轮已运行（等你处理卡片的时间不算）")}>{elapsed}</span>{/if}
  {#if hint}
    {#if elapsed}<span class="dot" aria-hidden="true">·</span>{/if}
    <span class="what" class:hx-shimmer={phase !== "wait"} class:wait={phase === "wait"} use:morphText={phase === "think" ? hint : phase}>{hint}</span>
  {/if}
  {#if agentNote}<span class="dot" aria-hidden="true">·</span><span class="agents">{agentNote}</span>{/if}
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

{#if compact}
  <RailRow bare>
    {#snippet head()}
      <span class="mk lead"><Mark size={16} live={phase !== "wait"} /></span>
      {@render line()}
    {/snippet}
  </RailRow>
{:else}
  <RailRow {up} clear={10}>
    {#snippet node()}
      <span class="mk"><Mark size={16} live={phase !== "wait"} /></span>
    {/snippet}
    {#snippet head()}{@render line()}{/snippet}
  </RailRow>
{/if}

<style>
  .mk {
    display: grid;
    color: var(--text2);
  }
  .mk.lead {
    flex: none;
    margin-right: 2px;
  }
  .what {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-base);
  }
  .what.wait {
    color: var(--text2);
  }
  .time {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
    color: var(--text3);
  }
  .dot {
    flex: none;
    margin: 0 -2px;
    color: var(--text3);
  }
  .agents {
    flex: none;
    font-size: var(--fs-md);
    color: var(--text3);
    white-space: nowrap;
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
