<script lang="ts">
  // 计划卡（plan 档）：agent 只读研究完，把计划提上来等你审。
  //  · 批准并执行 → 本会话切「自主执行」，同一轮里立刻开干（不用再问一遍）
  //  · 退回修改 → 两步：第一下只摊开意见框（先给一次写意见的机会），再点「确认退回」或回车才退回；意见可留空
  //  · C8：在新会话中实施 → 调研占掉的上下文不带过去：新会话自主档起跑、首条消息就是计划，这边一句话收尾，
  //    人跟着跳到新会话（有 hygiene 能力位才有这个钮）
  //  · 回执：结论 + 在哪台设备上定的 + 退回时的修改意见；计划正文照常可读
  // 计划正文走共用的 markdown 渲染；代码块的「复制」由 CardShell 在卡片根上委托（停靠区不在 Feed 里）。
  // 乐观落定 / 失效回滚在 state.svelte.ts 的 decidePlan / handoffPlan 里。
  import { decidePlan, handoffPlan, hygieneAvailable, type PlanItem } from "../../lib/state.svelte.ts";
  import { decidedElsewhere } from "../../lib/client-id.ts";
  import { clockOf } from "../../lib/deadline.ts";
  import { renderMarkdown } from "../../lib/markdown.ts";
  import { fade } from "../../lib/motion.ts";
  import Button from "../ui/Button.svelte";
  import TextField from "../ui/TextField.svelte";
  import CardShell from "./CardShell.svelte";
  import { cardWindowMs } from "./card-kit.ts";
  import { usePane } from "../../lib/pane.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let { item }: { item: PlanItem } = $props();

  const interactive = $derived(!item.decided && !item.cancelled && pane.chat.running);
  const where = $derived(item.decided ? decidedElsewhere(item.by) : "");
  const title = $derived(
    item.decided === "handoff"
      ? "计划已转到新会话实施"
      : item.decided === "approved"
        ? "计划已批准"
        : item.decided === "returned"
          ? "计划已退回"
          : item.cancelled
            ? item.cancelReason === "timeout"
              ? "超时没人审，计划保持未批准"
              : "没等到决定，这一轮已结束"
            : interactive
              ? "计划待批准"
              : "计划未批准",
  );
  const html = $derived(renderMarkdown(item.plan));

  // 当前上下文用量——调研占得越多，越值得换个干净的会话去实施
  const ctxPct = $derived(pane.chat.ctx.limit ? Math.round((pane.chat.ctx.used / pane.chat.ctx.limit) * 100) : 0);

  let noteOpen = $state(false);
  let note = $state("");
  let handing = $state(false);

  function approve() {
    if (!interactive || handing) return;
    void decidePlan(item.id, true);
  }
  function returnBack() {
    if (!interactive || handing) return;
    if (!noteOpen) {
      noteOpen = true; // 先给一次写意见的机会（不自动聚焦：手机上不弹键盘，想写再点进去）
      return;
    }
    void decidePlan(item.id, false, note.trim() || undefined);
  }
  // Q2：输入法组字中的回车不算
  function onNoteKey(e: KeyboardEvent) {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    returnBack();
  }
  async function toNewSession() {
    if (!interactive || handing) return;
    handing = true;
    try {
      await handoffPlan(item);
    } finally {
      handing = false;
    }
  }

  const coarse = matchMedia("(pointer: coarse)").matches;
  const big: "md" | "lg" = coarse ? "lg" : "md";
</script>

{#snippet actions()}
  <div class="acts">
    <!-- 意见框就摊在「确认退回」前面、同一行里（卡片不变高：停靠区贴底往上长，卡片一变高顶上会被裁一下） -->
    <span class="back" class:open={noteOpen}>
      {#if noteOpen}
        <span class="note" in:fade={{ duration: 140 }}>
          <TextField
            size={coarse ? "md" : "sm"}
            bind:value={note}
            placeholder="要改什么？（可留空直接退回）"
            enterkeyhint="send"
            onkeydown={onNoteKey}
          />
        </span>
      {/if}
      <Button variant={noteOpen ? "secondary" : "ghost"} size={big} disabled={handing} onclick={returnBack}>
        {noteOpen ? "确认退回" : "退回修改"}
      </Button>
    </span>
    <span class="grp">
      {#if hygieneAvailable()}
        <Button
          variant="secondary"
          size={big}
          loading={handing}
          title="在一个干净上下文的新会话里实施这份计划（自主档）；这边就此收尾"
          onclick={toNewSession}
        >
          {handing ? "正在转…" : `在新会话中实施${ctxPct ? `（上下文 ${ctxPct}%）` : ""}`}
        </Button>
      {/if}
      <Button variant="accent" size={big} disabled={handing} onclick={approve}>批准并执行</Button>
    </span>
  </div>
{/snippet}

<CardShell
  id={item.id}
  icon="todo"
  {title}
  {where}
  sub={interactive && item.deadlineAt ? `${clockOf(item.deadlineAt)} 前没人审，就保持计划模式、以这份计划收尾` : ""}
  live={interactive}
  deadlineAt={interactive ? item.deadlineAt : undefined}
  windowMs={cardWindowMs("plan", true)}
  footer={interactive ? actions : undefined}
>
  <div class="md plan" class:quiet={!interactive}>{@html html}</div>
  {#if !interactive && item.decided === "returned" && item.note}
    <p class="retnote">修改意见：{item.note}</p>
  {/if}
</CardShell>

<style>
  .plan {
    min-width: 0;
    font-size: var(--fs-base);
    line-height: 1.68;
    color: var(--text);
  }
  .plan.quiet {
    color: var(--text2);
  }
  .retnote {
    margin: 0;
    color: var(--text2);
    line-height: var(--lh-ui);
    overflow-wrap: anywhere;
  }
  .acts {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .back {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .back.open {
    flex: 1 1 300px;
  }
  .note {
    flex: 1;
    min-width: 140px;
  }
  /* 窄屏放不下一行：右边这组整组折下去、靠右 */
  .grp {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin-inline-start: auto;
  }
</style>
