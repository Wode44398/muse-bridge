<script lang="ts">
  // 上下文面板（顶栏右上角那颗按钮点开；C8 / X42 / K43 / A3）。最上面是这个对话的运行设置（RunSettings：工作档位、
  // 工作权限、运行环境——维护者 11-07 让它们全部离开输入框、聚到这里）；对话开始之后下面才有上下文这一段：
  // 这段对话吃了多少上下文、前缀缓存冷没冷，和两个动作——
  // 立即压缩（较早的对话换成摘要，接着在这里聊）、带摘要开新会话（整段写成摘要带过去，原会话留着）。
  // O8（N39）：下面是这个对话的用量明细——主对话之外，子 agent、工作流里的 agent、压缩各花了多少（打开时现取一次）。
  // 两个动作单飞、运行中不可点；只有做成了才收起面板（没做成由 state 给提示、面板留着）。
  import { cacheColdMinutes, compactNow, handoffWithSummary, hygieneAvailable, usageLedgerAvailable } from "../../lib/state.svelte.ts";
  import { sessionUsage, type UsageRow } from "../../lib/api.ts";
  import { haptic } from "../../lib/touch.ts";
  import { t, tc } from "../../lib/i18n.ts";
  import Popover from "../ui/Popover.svelte";
  import Measure from "../ui/Measure.svelte";
  import Button from "../ui/Button.svelte";
  import RunSettings from "./RunSettings.svelte";
  import { usePane } from "../../lib/pane.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  // onlocal：「本机模型」那一行——面板收起、顶栏按钮接着打开本机控制面板（弹层里不叠弹层：点在里层会被外层当成点在外面）
  let { anchor, onclose, onlocal }: { anchor: HTMLElement; onclose: () => void; onlocal: () => void } = $props();

  // 窄屏（375 的手机）上别宽过视口：弹层只会把左边钳进来，右边会被顶出去
  const maxW = Math.max(260, Math.min(380, window.innerWidth - 20));
  const minW = Math.min(320, maxW);

  const used = $derived(pane.chat.ctx.used);
  const limit = $derived(pane.chat.ctx.limit);
  const pct = $derived(limit ? Math.min(100, Math.round((used / limit) * 100)) : 0);
  // 新对话（还没吃进任何上下文）只有运行设置
  const hasCtx = $derived(used > 0 && limit > 0);
  const k = (n: number) => `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;

  // 缓存冷没冷：30 秒对一次钟
  let now = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (now = Date.now()), 30_000);
    return () => clearInterval(timer);
  });
  const cold = $derived(cacheColdMinutes(now, pane.chat));

  // O8：用量明细（打开时取一次；换了会话再取）
  let rows = $state<UsageRow[] | null>(null);
  $effect(() => {
    const id = pane.chat.id;
    if (!id || !usageLedgerAvailable()) return;
    let live = true;
    sessionUsage(id).then(
      (r) => {
        if (live) rows = Array.isArray(r?.rows) ? r.rows : null;
      },
      () => {
        if (live) rows = null;
      },
    );
    return () => {
      live = false;
    };
  });
  // 用量表「任务」列：压缩在这里是名词（一次压缩花的量），英文走名词语境（Compaction），别和按钮上的动词 Compact 撞
  const TASK: Record<UsageRow["task"], string> = { main: t("主对话"), subagent: t("子 agent"), workflow: t("工作流"), compaction: tc("名词", "压缩"), memory: t("记忆沉淀") };
  const total = $derived((rows ?? []).reduce((a, r) => ({ input: a.input + r.input, output: a.output + r.output }), { input: 0, output: 0 }));

  let busy = $state<"" | "compact" | "handoff">("");
  async function act(kind: "compact" | "handoff") {
    if (busy) return;
    busy = kind;
    haptic("light");
    try {
      const done = kind === "compact" ? await compactNow() : await handoffWithSummary();
      if (done) onclose();
    } finally {
      busy = "";
    }
  }
</script>

<Popover {anchor} {onclose} prefer="down" align="end" minWidth={minW} maxWidth={maxW} tall role="dialog" label={t("上下文与运行设置")}>
  <div class="cx">
    <RunSettings {onclose} {onlocal} />

    {#if hasCtx}
    <section class="ctx">
      <h4>{t("上下文")}</h4>
      <p class="used">
        <span class="k">{t("已用")}</span>
        <span class="v">{t("{used} / {limit}（{pct}%）", { used: k(used), limit: k(limit), pct })}</span>
      </p>
      <Measure value={pct / 100} tone={pct > 82 ? "warn" : cold !== null ? "ink" : "accent"} label={t("上下文用量")} thick />
      {#if cold !== null}
        <p class="cold">{t("距上次请求 {n} 分钟，前缀缓存大概已经冷了：下一条会按全价重读这 {tokens} token。", { n: cold, tokens: k(used) })}</p>
      {/if}
      {#if hygieneAvailable()}
        <div class="acts">
          <Button size="sm" variant="secondary" full loading={busy === "compact"} disabled={!!busy || pane.chat.running} onclick={() => act("compact")}>
            {#if busy === "compact"}<span class="hx-shimmer">{t("正在压缩…")}</span>{:else}{t("立即压缩")}{/if}
          </Button>
          <Button size="sm" variant="ghost" full loading={busy === "handoff"} disabled={!!busy || pane.chat.running} onclick={() => act("handoff")}>
            {#if busy === "handoff"}<span class="hx-shimmer">{t("正在写摘要…")}</span>{:else}{t("带摘要开新会话")}{/if}
          </Button>
        </div>
        <p class="hint">
          {pane.chat.running
            ? t("这一轮跑完再操作。")
            : t("压缩：较早的对话换成摘要，接着在这里聊。新会话：整段对话写成摘要带过去，原会话留着。都要调一次模型，本机模型可能要一两分钟。")}
        </p>
      {/if}
    </section>
    {/if}

    {#if hasCtx && rows && rows.length}
      <section class="usage">
        <h4>{t("用量（这个对话）")}</h4>
        <div class="tbl" role="table" aria-label={t("用量（这个对话）")}>
          <div class="tr th" role="row">
            <span role="columnheader">{t("任务")}</span>
            <span role="columnheader">{t("型号")}</span>
            <span class="n" role="columnheader">{t("入")}</span>
            <span class="n" role="columnheader">{t("出")}</span>
            <span class="n" role="columnheader">{tc("dimensio", "缓存")}</span>
            <span class="n" role="columnheader">{t("次数")}</span>
          </div>
          {#each rows as r (`${r.provider}|${r.model}|${r.task}`)}
            <div class="tr" role="row">
              <span class="task" role="cell">{TASK[r.task] ?? r.task}</span>
              <span class="model" role="cell" title="{r.provider} · {r.model}">{r.model}</span>
              <span class="n" role="cell">{k(r.input)}</span>
              <span class="n" role="cell">{k(r.output)}</span>
              <span class="n dim" role="cell">{r.cacheRead ? k(r.cacheRead) : "—"}</span>
              <span class="n" role="cell">{r.calls}</span>
            </div>
          {/each}
          {#if rows.length > 1}
            <div class="tr total" role="row">
              <span class="task" role="cell">{t("合计")}</span>
              <span role="cell"></span>
              <span class="n" role="cell">{k(total.input)}</span>
              <span class="n" role="cell">{k(total.output)}</span>
              <span role="cell"></span>
              <span role="cell"></span>
            </div>
          {/if}
        </div>
      </section>
    {/if}
  </div>
</Popover>

<style>
  .cx {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 8px 8px 6px;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .ctx,
  .usage {
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  h4 {
    margin: 0;
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text3);
  }
  .used {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 14px;
    margin: 0;
  }
  .k {
    font-size: var(--fs-md);
    color: var(--text2);
  }
  .v {
    font-family: var(--font-mono);
    font-size: var(--fs-md);
    font-weight: 500;
    color: var(--text);
    font-variant-numeric: tabular-nums;
  }
  .cold {
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 1.55;
    color: var(--warn);
  }
  .acts {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-top: 4px;
  }
  /* 英文「New session with summary」在半宽的按钮里放不下：英文时两个动作上下排（中文照旧左右两格） */
  :global(html:lang(en)) .acts {
    grid-template-columns: 1fr;
  }
  .hint {
    margin: 0;
    font-size: var(--fs-xs);
    line-height: 1.6;
    color: var(--text3);
  }

  /* 用量表：数字等宽右对齐；行就是一排格子（display: contents），合计行上面一根细线 */
  .tbl {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto auto auto auto;
    row-gap: 5px;
    font-size: var(--fs-sm);
    line-height: 1.45;
  }
  .tr {
    display: contents;
  }
  .tr > * + * {
    padding-left: 10px;
  }
  .th > * {
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .task {
    color: var(--text);
    white-space: nowrap;
  }
  .model {
    min-width: 0;
    color: var(--text3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .n {
    text-align: right;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
    color: var(--text2);
  }
  .th .n {
    font-family: var(--font-ui);
  }
  .dim {
    color: var(--text3);
  }
  .total > * {
    padding-top: 6px;
    border-top: 1px solid var(--border);
    font-weight: 500;
  }
</style>
