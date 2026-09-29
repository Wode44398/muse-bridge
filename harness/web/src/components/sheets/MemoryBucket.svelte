<script lang="ts">
  // 一处记忆（K11；前身是 K4 的项目记忆列表）：一个项目 / 全局层 / 一只旧快照桶里的全部记忆。
  // 从上往下：四个数（点一个只看这一类）→ 它们占了多少提示 → 共用一把时间尺的列表（每行右边是这条记忆的一生）
  // → 点一行就地展开全文与动作（确认 / 编辑 / 驳回 / 撤销驳回 / 删除，见 MemoryDetail）。
  // 数据由外面给（总览里的这一处，或旧服务端上 listMemory 的结果）；动作做完调 onchanged 让外面重拉。
  import { onMount, untrack } from "svelte";
  import { toast } from "../../lib/state.svelte.ts";
  import { readMemoryNote, type MemoryBucket, type MemoryNote, type MemoryOverviewItem } from "../../lib/api.ts";
  import { haptic } from "../../lib/touch.ts";
  import { collapse, rise, smoothHeight } from "../../lib/motion.ts";
  import { t, tr } from "../../lib/i18n.ts";
  import Group from "../ui/Group.svelte";
  import Icon from "../ui/Icon.svelte";
  import Measure from "../ui/Measure.svelte";
  import Empty from "../ui/Empty.svelte";
  import Mark from "../brand/Mark.svelte";
  import MemoryDetail from "./MemoryDetail.svelte";
  import MemoryStats from "./MemoryStats.svelte";
  import MemoryAxis from "./MemoryAxis.svelte";
  import MemoryLifeline from "./MemoryLifeline.svelte";
  import { CONF_LABEL, fmtDate, issuesOf, LANE_TEXT, originText, STATUS_LABEL, TYPE_LABEL } from "./memory-text.ts";
  import { byLane, countLanes, fmtCount, glyphOf, laneOf, LANES, lifeOf, spanOf, type Lane } from "./memory-viz.ts";

  let {
    bucket,
    budget = 0,
    openFirst = null,
    onchanged,
  }: {
    bucket: MemoryBucket;
    budget?: number;
    openFirst?: string | null; // 进来就展开这一条（从总览的点阵 / 待处理里点进来）
    onchanged: () => void | Promise<void>;
  } = $props();

  let lane = $state<Lane | null>(null); // 统计卡上点了哪一类：列表只留这一组
  let reading = $state<string | null>(null);
  let openId = $state<string | null>(null);
  let picked = $state<MemoryNote | null>(null);
  let readSeq = 0;

  const items = $derived(byLane(bucket.items));
  const counts = $derived(countLanes(bucket.items));
  const lives = $derived(new Map(items.map((m) => [m.id, lifeOf(m, bucket.history)])));
  // 尺子按「打开这一刻」定：开着的时候不跟着时钟走（否则每次重拉整排刻痕微移）
  const now = Date.now();
  const span = $derived(spanOf([...lives.values()], now));
  const sections = $derived(
    LANES.filter((l) => (lane ? l === lane : counts[l] > 0)).map((l) => ({ lane: l, items: items.filter((m) => laneOf(m) === l) })),
  );
  const eventsOf = (id: string) => bucket.history.filter((e) => e.id === id);

  const isGlobal = $derived(bucket.kind === "global");
  const used = $derived(isGlobal ? bucket.promptChars : 0);
  const fill = $derived(budget > 0 ? used / budget : 0);

  function closeRow() {
    openId = null;
    picked = null;
    reading = null;
    readSeq++;
  }

  async function toggle(m: MemoryOverviewItem, quiet = false) {
    if (openId === m.id) {
      closeRow();
      return;
    }
    if (!quiet) haptic("light");
    const my = ++readSeq;
    reading = m.id;
    try {
      const note = await readMemoryNote(bucket.ws, m.id);
      if (my !== readSeq) return;
      picked = note;
      openId = m.id;
    } catch (e: any) {
      if (my === readSeq) toast(t("读取失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
    } finally {
      if (my === readSeq) reading = null;
    }
  }

  // 动作做完：收起这一条、让外面重拉（条目可能换了组）
  async function changed() {
    closeRow();
    await onchanged();
  }

  let root: HTMLElement | undefined = $state();
  onMount(() => {
    const first = untrack(() => openFirst && bucket.items.find((m) => m.id === openFirst));
    if (!first) return;
    void toggle(first, true).then(() => {
      // 展开之后把它滚进视野（它可能在长列表的下半截）
      requestAnimationFrame(() => root?.querySelector(`[data-mem="${CSS.escape(first.id)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    });
  });
</script>

<div class="bucket" bind:this={root}>
  {#if !bucket.items.length}
    <Empty
      title={isGlobal ? t("还没有全局记忆") : t("还没有记忆")}
      text={isGlobal
        ? t("模型在任何项目里记下的「你是谁、这台机器怎么用」会先放在这里等你确认，确认了才进每个项目的对话。")
        : t("对话里模型觉得以后用得上、又没法从代码里看出来的事（决定、原因、偏好、踩过的坑），会记在这里。")}
    />
  {:else}
    <MemoryStats {counts} picked={lane} onpick={(l) => { lane = l; closeRow(); }} />

    <!-- 进提示的字数只有总览数据里有（budget > 0 即是）；旧服务端上不写这一段，免得报个假的 0 -->
    {#if budget > 0}
    <div class="print">
      {#if isGlobal}
        <div class="meter">
          <span class="lbl">{t("生效的全局记忆进每个对话的提示")}</span>
          <span class="val"><b>{fmtCount(used)}</b> / {t("{n} 字", { n: fmtCount(budget) })}</span>
        </div>
        <Measure value={fill} tone={fill >= 0.85 ? "warn" : "accent"} label={t("全局记忆占用的提示字数")} />
      {:else if counts.active}
        <!-- 两个数加粗：整句一键（英文语序不同），{@html} 插进去的只有数字 -->
        <p>
          {@html bucket.kind === "quick"
            ? t("生效的 <b>{n}</b> 条以索引行进这只快照桶每个新对话的提示，共 <b>{chars}</b> 字；全文要用时再召回。", { n: counts.active, chars: fmtCount(bucket.promptChars) })
            : t("生效的 <b>{n}</b> 条以索引行进这个项目每个新对话的提示，共 <b>{chars}</b> 字；全文要用时再召回。", { n: counts.active, chars: fmtCount(bucket.promptChars) })}
        </p>
      {:else}
        <p>{bucket.kind === "quick" ? t("还没有生效的记忆：这只快照桶的新对话提示里没有它们。") : t("还没有生效的记忆：这个项目的新对话提示里没有它们。")}</p>
      {/if}
    </div>
    {/if}

    <div class="axisrow"><span class="axis"><MemoryAxis {span} /></span></div>

    {#each sections as s (s.lane)}
      <Group title={LANE_TEXT[s.lane].label}>
        {#snippet aside()}
          <span class="count" class:warn={s.lane === "proposed"} class:err={s.lane === "held"}>{s.items.length}</span>
        {/snippet}
        {#each s.items as m, i (m.id)}
          {@const open = openId === m.id}
          {@const warns = issuesOf(m).length}
          {@const life = lives.get(m.id)!}
          <div class="mem" class:open data-mem={m.id} in:rise|global={{ y: 6, delay: Math.min(i, 10) * 25 }} out:collapse>
            <button class="head" aria-expanded={open} onclick={() => toggle(m)}>
              <span class="main">
                <span class="title">{m.title}</span>
                {#if m.description}<span class="desc" class:clamp={!open}>{m.description}</span>{/if}
                <span class="meta">
                  {#if s.lane === "retired"}
                    <span class="st" class:rej={m.status === "rejected"}>{STATUS_LABEL[m.status] ?? m.status}</span>
                  {/if}
                  <span>{TYPE_LABEL[m.type] ?? m.type}</span>
                  <span class="sep" aria-hidden="true">·</span>
                  <span>{CONF_LABEL[m.confidence] ?? m.confidence}</span>
                  {#if originText(m)}
                    <span class="sep" aria-hidden="true">·</span>
                    <span>{originText(m)}</span>
                  {/if}
                  {#if m.uses}
                    <span class="sep" aria-hidden="true">·</span>
                    <span title={t("最近一次 {date}", { date: fmtDate(m.lastUsed) })}>{t("召回 {n} 次", { n: m.uses })}</span>
                  {/if}
                  {#if warns}<span class="warns">⚠ {warns}</span>{/if}
                  {#if m.updated}<span class="date">{fmtDate(m.updated)}</span>{/if}
                </span>
              </span>
              <span class="lane"><MemoryLifeline {life} {span} glyph={glyphOf(m)} lane={laneOf(m)} /></span>
              <span class="chev" aria-hidden="true">
                {#if reading === m.id}<Mark size={16} live />{:else}<Icon name="chevronD" size={16} />{/if}
              </span>
            </button>
            {#if open && picked && picked.id === m.id}
              <div transition:collapse>
                <div use:smoothHeight>
                  <div>
                    <MemoryDetail
                      note={picked}
                      ws={bucket.ws}
                      events={eventsOf(m.id)}
                      usage={m.uses ? { uses: m.uses, first: m.firstUsed, last: m.lastUsed } : undefined}
                      onchanged={changed}
                    />
                  </div>
                </div>
              </div>
            {/if}
          </div>
        {:else}
          <p class="none">{LANE_TEXT[s.lane].empty}</p>
        {/each}
      </Group>
    {/each}
  {/if}

  <p class="foot">
    {#if isGlobal}
      {t("全局记忆只收「你是谁、这台机器怎么用」这类每个项目都适用的事实，生效的进所有项目的对话提示，所以合计有长度上限。模型存的一律先放在「待确认」，你确认了才生效。")}
    {:else}
      {t("只有「生效」的记忆会进新对话的提示；模型自己存的先放在「待确认」，你确认了才生效。「被隔离」的写着生效，但过期了、挂靠的文件不在了或和同主题的冲突，修好或重新确认才回来。驳回的条目模型不会再用，也存不回来；删除和改写前的旧版留在记忆目录的 .history 里。")}
    {/if}
    {#if bucket.items.some((m) => m.uses)}
      {t("「召回」是这条记忆的全文被拉进对话的次数（开跑时自动找来的，或模型点名读的）。")}
    {/if}
  </p>
</div>

<style>
  .bucket {
    /* 时间线那一列的宽：桌面在行的右侧，手机上挪到说明下面、与正文同宽 */
    --lane-w: 168px;
  }

  .print {
    margin: -6px 4px 22px;
    font-size: var(--fs-md);
    line-height: 1.6;
    color: var(--text2);
  }
  .print p {
    margin: 0;
  }
  /* 生效条数那一句是 {@html} 进来的：里面的 <b> 要写 :global */
  .print :global(b) {
    font-weight: 600;
    color: var(--text);
  }
  .meter {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 6px;
  }
  .meter .lbl {
    min-width: 0;
  }
  .meter .val {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text3);
    font-variant-numeric: tabular-nums;
  }
  .meter .val b {
    font-size: var(--fs-md);
  }

  /* 尺与每一行用同一套列：说明 | 时间线 | 箭头 */
  .axisrow,
  .head {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--lane-w) 16px;
    column-gap: 14px;
  }
  .axisrow {
    padding: 0 12px 6px 14px;
  }
  .axisrow .axis {
    grid-column: 2;
  }

  .count {
    min-width: 20px;
    height: 20px;
    padding: 0 7px;
    border-radius: var(--r-pill);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-weight: 500;
    line-height: 20px;
    text-align: center;
    color: var(--text3);
    background: color-mix(in srgb, var(--text) 6%, transparent);
    font-variant-numeric: tabular-nums;
  }
  .count.warn {
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 13%, transparent);
  }
  .count.err {
    color: var(--err);
    background: color-mix(in srgb, var(--err) 11%, transparent);
  }

  .mem {
    --c-paper: var(--surface2);
    transition: background-color var(--t-med) var(--ease);
  }
  /* 展开的那一条从分组面上「抬起来」一阶：详情里的输入框、正文在它上面才看得清 */
  .mem.open {
    --c-paper: var(--surface);
    background: var(--surface);
  }
  .head {
    align-items: start;
    width: 100%;
    padding: 12px 12px 12px 14px;
    text-align: left;
    color: var(--text);
    transition: background-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) {
    .mem:not(.open) .head:hover {
      background: color-mix(in srgb, var(--text) 4%, transparent);
    }
  }
  .mem:not(.open) .head:active {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .main {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .title {
    font-size: var(--fs-base);
    font-weight: 500;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .open .title {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .desc {
    font-size: var(--fs-md);
    line-height: 1.5;
    color: var(--text2);
    overflow-wrap: anywhere;
  }
  .desc.clamp {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 6px;
    margin-top: 3px;
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .sep {
    opacity: 0.6;
  }
  .st {
    display: inline-flex;
    align-items: center;
    height: 18px;
    padding: 0 7px;
    border-radius: var(--r-pill);
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--text2);
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .st.rej {
    color: var(--err);
    background: color-mix(in srgb, var(--err) 11%, transparent);
  }
  .warns {
    color: var(--err);
    font-variant-numeric: tabular-nums;
  }
  .date {
    margin-left: auto;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
  }
  /* 时间线与标题同一条中线（标题行高 14×1.4） */
  .lane {
    padding-top: 2px;
  }
  .chev {
    display: inline-flex;
    margin-top: 2px;
    color: var(--text3);
    transition: transform var(--t-med) var(--ease-out);
  }
  .open .chev {
    transform: rotate(180deg);
  }

  .none {
    margin: 0;
    padding: 14px;
    font-size: var(--fs-md);
    color: var(--text3);
  }
  .foot {
    margin: 4px 4px 0;
    font-size: var(--fs-sm);
    line-height: 1.6;
    color: var(--text3);
  }

  /* 手机：时间线挪到说明下面，与正文同宽；尺也只占正文那一列 */
  @media (max-width: 699px) {
    .axisrow,
    .head {
      grid-template-columns: minmax(0, 1fr) 16px;
    }
    .axisrow .axis {
      grid-column: 1;
    }
    .lane {
      grid-row: 2;
      grid-column: 1;
      padding-top: 8px;
    }
    .chev {
      grid-row: 1;
      grid-column: 2;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .chev {
      transition: none;
    }
  }
</style>
