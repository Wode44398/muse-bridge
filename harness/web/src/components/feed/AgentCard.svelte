<script lang="ts">
  // 子 agent 卡：对话流里一批并行派出去的子 agent（紧挨着的 Agent 工具行，lib/feed-units.ts 的 a 单元）。
  // 结构照 bridge Claude 分页（= 官方 /code 页）——时间线上一张卡，点开进右侧工作区「任务」里那个子 agent 的面板；
  // 样子是 dimensio 自己的（纸、墨、一抹朱）。
  //
  //   一个 = 单卡：agent 图标 + 标题（在跑 = 微光）/「子 agent · 档位 · 模型 · 用时」/ 此刻一行（第 N 步 · 动词 参数）。
  //   多个 = 叠卡：头行「N 个子 agent · n 个在跑 · 墙钟」，下面一个一行（状态记号 + 标题 + 用时 / 此刻一行），
  //          各行点开各自的面板；头行点开任务列表并定位到这一批。
  //
  // 卡片从派出去起就在、跑完不收（官方跑完收成一行文字，认不出来；工作流卡同样留着）：跑着和跑完一样高（DESIGN §7），
  // 结束时只是微光停下、此刻一行换成「N 次调用 · tok」或失败原因。量线上的节点画在卡片第一行的中线上。
  // 这一轮停了而它还挂着 running = 被打断，按「已停止」画（lib/tasks.ts agentView）。
  import { openTaskDetail, type ToolItem } from "../../lib/state.svelte.ts";
  import { STATUS_LABEL, agentView, batchCounts, batchElapsed, type AgentView } from "../../lib/tasks.ts";
  import { press } from "../../lib/motion.ts";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";
  import Icon from "../ui/Icon.svelte";
  import StatusGlyph, { type Glyph } from "../dock/StatusGlyph.svelte";
  import RailRow from "./RailRow.svelte";
  import ToolNode, { type NodeTone } from "./ToolNode.svelte";
  import AgentAct from "./AgentAct.svelte";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let { items, up = false, down = false }: { items: ToolItem[]; up?: boolean; down?: boolean } = $props();

  // 秒级时钟：只在这一批还有在跑的、页面可见时走
  let now = $state(Date.now());
  const anyRunning = $derived(pane.chat.running && items.some((x) => x.status === "running" || x.agent?.status === "running"));
  $effect(() => {
    if (!anyRunning) return;
    now = Date.now();
    const id = setInterval(() => {
      if (!document.hidden) now = Date.now();
    }, 1000);
    return () => clearInterval(id);
  });

  const views = $derived(items.map((it) => agentView(it, { now, chatRunning: pane.chat.running })));
  const counts = $derived(batchCounts(views));
  const tone = $derived<NodeTone>(counts.running ? "running" : counts.failed ? "fail" : counts.stopped === counts.total ? "stopped" : "ok");
  const SR: Record<NodeTone, string> = { running: t("运行中"), ok: "", fail: t("失败"), denied: "", stopped: t("已停止") };

  const glyphOf = (v: AgentView): Glyph =>
    v.status === "running" ? (v.stalled || v.suspended ? "stalled" : "running") : v.status === "completed" ? "done" : v.status === "failed" ? "failed" : "stopped";
  const glyphLabel = (v: AgentView) => (v.status === "running" && (v.stalled || v.suspended) ? t("久无动静") : STATUS_LABEL[v.status]);

  // 叠卡头行右端：还在跑 = 几个在跑；都停了 = 有失败说失败数，否则不说（成功是默认）
  const batchNote = $derived(
    counts.running
      ? t("{n} 个在跑", { n: counts.running })
      : counts.failed
        ? t("{n} 失败", { n: counts.failed })
        : counts.stopped === counts.total
          ? t("已停止")
          : "",
  );
  const batchTime = $derived(batchElapsed(items, counts.running > 0, now));

  const open = (it: ToolItem) => openTaskDetail(it.id, it.agent?.id);
</script>

<RailRow {up} {down} nodeY="22px">
  {#snippet node()}<ToolNode {tone} />{/snippet}
  <div class="wrap">
    {#if items.length === 1}
      {@const it = items[0]}
      {@const v = views[0]}
      <button class="card one" onclick={() => open(it)} aria-label={t("查看子 agent：{title}", { title: v.title })} use:press={{ scale: 0.985 }}>
        <span class="ic"><Icon name="agent" size={15} /></span>
        <span class="col">
          <span class="title" class:hx-shimmer={v.status === "running"} class:dim={v.status !== "running"}>{v.title}</span>
          <span class="meta">
            <span>{t("子 agent")}</span>
            <span class="tier" class:coder={v.tier === "coder"}>{v.tier}</span>
            {#if v.model}<span class="model">{v.model}</span>{/if}
            {#if v.time}<span class="num">{v.time}</span>{/if}
          </span>
          <AgentAct view={v} />
        </span>
        <span class="go"><Icon name="chevronR" size={14} stroke={1.9} /></span>
        {#if SR[tone]}<span class="hx-sr">{t("（{code}）", { code: SR[tone] })}</span>{/if}
      </button>
    {:else}
      <div class="card stack">
        <button class="head" onclick={() => openTaskDetail(items[0].id)} title={t("在任务面板中查看")}>
          <span class="ic"><Icon name="agent" size={15} /></span>
          <span class="title" class:hx-shimmer={counts.running > 0} class:dim={!counts.running}>{t("{n} 个子 agent", { n: counts.total })}</span>
          {#if batchNote}<span class="note" class:bad={!counts.running && counts.failed > 0}>{batchNote}</span>{/if}
          {#if batchTime}<span class="num">{batchTime}</span>{/if}
        </button>
        <ul class="rows">
          {#each items as it, i (it.id)}
            {@const v = views[i]}
            <li>
              <button class="row" onclick={() => open(it)} aria-label={t("查看子 agent：{title}", { title: v.title })}>
                <span class="l1">
                  <StatusGlyph kind={glyphOf(v)} label={glyphLabel(v)} />
                  <span class="name" class:hx-shimmer={v.status === "running"} class:dim={v.status !== "running"}>{v.title}</span>
                  {#if v.tier === "coder"}<span class="tier coder">coder</span>{/if}
                  {#if v.time}<span class="num">{v.time}</span>{/if}
                  <span class="go"><Icon name="chevronR" size={13} stroke={1.9} /></span>
                </span>
                <span class="l2"><AgentAct view={v} /></span>
              </button>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </div>
</RailRow>

<style>
  /* 卡片和下一行（通常是活动行）之间留口气 */
  .wrap {
    padding: 2px 0 8px;
  }
  .card {
    display: flex;
    width: 320px;
    max-width: 100%;
    border-radius: 14px;
    background: var(--surface);
    box-shadow: 0 0 0 1px var(--border);
    text-align: left;
    color: var(--text);
  }
  .card.one {
    align-items: flex-start;
    gap: 9px;
    padding: 10px 10px 10px 12px;
    transition: background-color var(--t-fast) var(--ease);
  }
  .card.stack {
    flex-direction: column;
    overflow: hidden;
  }
  .ic,
  .go {
    display: inline-flex;
    align-items: center;
    flex: none;
    height: 20px;
    color: var(--text2);
  }
  .go {
    color: var(--text3);
  }
  .col {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  /* 字色继承自卡片（跑着是 --text、微光自带透明字）；跑完退成 --text2——只在不带微光的 .dim 上改色，不和 .hx-shimmer 抢 */
  .title,
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--fs-base);
    font-weight: 500;
    line-height: 20px;
  }
  .name {
    font-size: var(--fs-md);
  }
  .title.dim,
  .name.dim {
    color: var(--text2);
  }
  .meta {
    display: flex;
    align-items: center;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    font-size: var(--fs-sm);
    line-height: 17px;
    color: var(--text3);
  }
  .meta > span {
    flex: none;
  }
  .meta > span + span::before {
    content: "·";
    margin: 0 6px;
  }
  .meta > .model {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text2);
  }
  .tier.coder {
    color: var(--text);
  }
  .num {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    color: var(--text3);
  }

  /* —— 叠卡 —— */
  .head {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 40px;
    padding: 0 12px;
    text-align: left;
    transition: background-color var(--t-fast) var(--ease);
  }
  .note {
    flex: none;
    font-size: var(--fs-sm);
    color: var(--text3);
    white-space: nowrap;
  }
  .note.bad {
    color: var(--err);
  }
  .rows {
    list-style: none;
    margin: 0;
    padding: 2px 0 4px;
    border-top: 1px solid var(--border);
  }
  .row {
    display: flex;
    flex-direction: column;
    gap: 1px;
    width: 100%;
    min-width: 0;
    padding: 6px 10px 6px 12px;
    text-align: left;
    transition: background-color var(--t-fast) var(--ease);
  }
  .l1 {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
  }
  .l1 .tier {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text2);
  }
  .l2 {
    display: block;
    min-width: 0;
    /* 对齐到标题：状态记号 14 + 间距 9 */
    padding-left: 23px;
  }
  .card.one:active,
  .head:active,
  .row:active {
    background: var(--surface2);
  }
  @media (hover: hover) {
    .card.one:hover,
    .head:hover,
    .row:hover {
      background: var(--surface2);
    }
  }
</style>
