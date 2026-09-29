<script lang="ts">
  // 记忆总览（K11，设置 → 记忆）：模型在所有地方记住的东西，一屏看全。
  //   四个数：全部记忆按「待确认 · 被隔离 · 生效 · 已退场」计数，同时是图例；点一个，下面的点阵只亮这一类。
  //   等你处理：待确认与被隔离的条目（跨项目），点一条直接进去、就地展开它。
  //   各处的记忆：全局层、每个有记忆的项目、旧快照桶各一行——一粒字形就是一条记忆（点阵即数量、即状态），
  //   悬停 / 聚焦看标题，点一粒直接打开那一条；点行头进这一处。
  import { haptic } from "../../lib/touch.ts";
  import { rise } from "../../lib/motion.ts";
  import { t } from "../../lib/i18n.ts";
  import type { MemoryBucket, MemoryOverview, MemoryOverviewItem } from "../../lib/api.ts";
  import Group from "../ui/Group.svelte";
  import Icon from "../ui/Icon.svelte";
  import MemoryGlyph from "./MemoryGlyph.svelte";
  import MemoryStats from "./MemoryStats.svelte";
  import { byLane, countLanes, fmtCount, glyphOf, laneOf, latestOf, type Lane } from "./memory-viz.ts";
  import { agoOf, fmtShortDate, GLYPH_TEXT, issuesOf, originText } from "./memory-text.ts";

  let {
    overview,
    onopen,
  }: {
    overview: MemoryOverview;
    onopen: (bucket: MemoryBucket, id?: string) => void;
  } = $props();

  let lane = $state<Lane | null>(null);
  let showAllTodo = $state(false);

  const all = $derived(overview.buckets.flatMap((b) => b.items));
  const counts = $derived(countLanes(all));
  const TODO_CAP = 4;
  const todo = $derived(
    overview.buckets
      .flatMap((b) => b.items.filter((m) => laneOf(m) === "held" || laneOf(m) === "proposed").map((m) => ({ b, m })))
      .sort((x, y) => {
        const hx = laneOf(x.m) === "held" ? 0 : 1;
        const hy = laneOf(y.m) === "held" ? 0 : 1;
        return hx - hy || (y.m.updated ?? "").localeCompare(x.m.updated ?? "");
      }),
  );
  const todoShown = $derived(showAllTodo ? todo : todo.slice(0, TODO_CAP));

  // 全局层、快照桶的名字是服务端给的中文（「全局」「快照对话」），按类别取本地文案；项目名是文件夹名，原样
  const nameOf = (b: MemoryBucket) =>
    b.kind === "global"
      ? t("全局")
      : b.kind === "quick"
        ? b.createdAt
          ? t("快照对话 · {date}", { date: fmtShortDate(new Date(b.createdAt).toISOString()) })
          : t("快照对话")
        : b.name;
  // 「最近 …」：英文里「多久以前」嵌在句中（Updated today），按档位各取一整句
  function lastText(iso: string): string {
    const a = agoOf(iso);
    if (!a) return "";
    if (a.k === "today") return t("最近 今天");
    if (a.k === "yesterday") return t("最近 昨天");
    if (a.k === "days") return t("最近 {n} 天前", { n: a.n });
    if (a.k === "weeks") return t("最近 {n} 周前", { n: a.n });
    if (a.k === "months") return t("最近 {n} 个月前", { n: a.n });
    return t("最近 {date}", { date: a.date });
  }
  function metaOf(b: MemoryBucket): string {
    const parts = [t("{n} 条", { n: b.items.length })];
    if (b.kind === "global") parts.push(t("进提示 {used} / {budget} 字", { used: fmtCount(b.promptChars), budget: fmtCount(overview.budget) }));
    else if (b.promptChars) parts.push(t("进提示 {n} 字", { n: fmtCount(b.promptChars) }));
    const uses = b.items.reduce((n, m) => n + (m.uses ?? 0), 0);
    if (uses) parts.push(t("召回 {n} 次", { n: uses }));
    const last = latestOf(b.items, b.history);
    if (last) parts.push(lastText(last));
    return parts.filter(Boolean).join(" · ");
  }

  // 待处理一行的出处：哪一处 · 为什么在这（被隔离说清楚、待确认说谁写的）· 日期
  function todoSub(b: MemoryBucket, m: MemoryOverviewItem): string {
    const why = laneOf(m) === "held" ? issuesOf(m)[0] || t("写着生效却没进提示") : originText(m);
    return [nameOf(b), why, m.updated ? fmtShortDate(m.updated) : ""].filter(Boolean).join(" · ");
  }

  // ── 点阵的悬停提示：一个共用的浮签，定位在面板里（不挂 body，面板滚它跟着滚）──────────────
  let root: HTMLDivElement | undefined = $state();
  let tip = $state<null | { title: string; sub: string; x: number; y: number }>(null);
  function showTip(e: Event, b: MemoryBucket, m: MemoryOverviewItem) {
    const el = e.currentTarget as HTMLElement;
    if (!root) return;
    const r = el.getBoundingClientRect();
    const o = root.getBoundingClientRect();
    const sub = [GLYPH_TEXT[glyphOf(m)], nameOf(b), m.updated ? fmtShortDate(m.updated) : "", m.uses ? t("召回 {n} 次", { n: m.uses }) : ""].filter(Boolean).join(" · ");
    tip = { title: m.title, sub, x: r.left + r.width / 2 - o.left, y: r.top - o.top };
  }
  const hideTip = () => (tip = null);

  function pickDot(b: MemoryBucket, m: MemoryOverviewItem) {
    haptic("light");
    tip = null;
    onopen(b, m.id);
  }
</script>

<div class="ov" bind:this={root}>
  <MemoryStats {counts} picked={lane} onpick={(l) => (lane = l)} />

  {#if todo.length}
    <Group title={t("等你处理")}>
      {#snippet aside()}<span class="count">{todo.length}</span>{/snippet}
      {#each todoShown as row, i (row.b.ws + row.m.id)}
        <button class="todo" in:rise|global={{ y: 6, delay: Math.min(i, 8) * 25 }} onclick={() => onopen(row.b, row.m.id)}>
          <span class="tg"><MemoryGlyph kind={glyphOf(row.m)} size={12} /></span>
          <span class="tx">
            <span class="tt">{row.m.title}</span>
            <span class="ts">{todoSub(row.b, row.m)}</span>
          </span>
          <span class="chev" aria-hidden="true"><Icon name="chevronR" size={16} /></span>
        </button>
      {/each}
      {#if todo.length > TODO_CAP}
        <button class="more" onclick={() => (showAllTodo = !showAllTodo)}>
          {showAllTodo ? t("收起") : t("再看 {n} 条", { n: todo.length - TODO_CAP })}
        </button>
      {/if}
    </Group>
  {/if}

  <Group title={t("各处的记忆")}>
    {#each overview.buckets as b, i (b.ws)}
      <div class="bk" in:rise|global={{ y: 6, delay: Math.min(i, 10) * 30 }}>
        <button class="bh" onclick={() => onopen(b)}>
          <span class="bn">
            <span class="nm">{nameOf(b)}</span>
            {#if b.current}<span class="tag">{t("当前")}</span>{/if}
            {#if b.hidden}<span class="tag">{t("已隐藏")}</span>{/if}
          </span>
          <span class="bm">{#if b.kind === "global" && !b.items.length}{t("还没有：模型记下的关于你的事会先放在这里")}{:else}{metaOf(b)}{/if}</span>
          <span class="chev" aria-hidden="true"><Icon name="chevronR" size={16} /></span>
        </button>
        {#if b.items.length}
          <div class="dots" role="group" aria-label={t("{name}的记忆", { name: nameOf(b) })}>
            {#each byLane(b.items) as m (m.id)}
              <button
                class="dot"
                class:dim={lane !== null && laneOf(m) !== lane}
                aria-label={t("{title}（{status}）", { title: m.title, status: GLYPH_TEXT[glyphOf(m)] })}
                onpointerenter={(e) => showTip(e, b, m)}
                onpointerleave={hideTip}
                onfocus={(e) => showTip(e, b, m)}
                onblur={hideTip}
                onclick={() => pickDot(b, m)}
              >
                <MemoryGlyph kind={glyphOf(m)} size={12} />
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
  </Group>

  <p class="foot">
    {#if overview.emptyProjects}
      {t("另有 {n} 个项目还没有记忆。每个项目的记忆各自隔离、只进自己的对话；全局层每个项目都用。一粒就是一条记忆：点它直接打开，点行头看这一处的全部。", { n: overview.emptyProjects })}
    {:else}
      {t("每个项目的记忆各自隔离、只进自己的对话；全局层每个项目都用。一粒就是一条记忆：点它直接打开，点行头看这一处的全部。")}
    {/if}
  </p>

  {#if tip}
    <div class="tip" style="left:{tip.x}px;top:{tip.y}px" role="tooltip">
      <span class="tip-t">{tip.title}</span>
      <span class="tip-s">{tip.sub}</span>
    </div>
  {/if}
</div>

<style>
  .ov {
    position: relative;
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
    color: var(--warn);
    background: color-mix(in srgb, var(--warn) 13%, transparent);
    font-variant-numeric: tabular-nums;
  }

  /* 等你处理：字形 | 标题 + 出处 | › */
  .todo {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    min-height: 48px;
    padding: 11px 12px 11px 14px;
    text-align: left;
    color: var(--text);
    transition: background-color var(--t-fast) var(--ease);
  }
  .tg {
    display: inline-flex;
    padding-top: 4px;
  }
  .tx {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .tt {
    font-size: var(--fs-base);
    font-weight: 500;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ts {
    font-size: var(--fs-sm);
    color: var(--text3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chev {
    display: inline-flex;
    flex: none;
    margin-top: 2px;
    color: var(--text3);
  }
  .more {
    width: 100%;
    min-height: 40px;
    padding: 0 14px;
    font-size: var(--fs-md);
    color: var(--text2);
    text-align: left;
    transition: background-color var(--t-fast) var(--ease);
  }

  /* 各处：行头（名字 · 说明 · ›）+ 一条点阵 */
  .bh {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) 16px;
    align-items: baseline;
    column-gap: 12px;
    width: 100%;
    padding: 12px 12px 6px 14px;
    text-align: left;
    color: var(--text);
    transition: background-color var(--t-fast) var(--ease);
  }
  .bk:not(:has(.dots)) .bh {
    padding-bottom: 12px;
  }
  .bn {
    display: inline-flex;
    align-items: baseline;
    gap: 6px;
    min-width: 0;
  }
  .nm {
    font-size: var(--fs-base);
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 260px;
  }
  .tag {
    flex: none;
    padding: 0 6px;
    border-radius: var(--r-pill);
    font-size: var(--fs-xs);
    line-height: 18px;
    color: var(--text2);
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .bm {
    min-width: 0;
    font-size: var(--fs-sm);
    color: var(--text3);
    text-align: right;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .bh .chev {
    align-self: center;
    margin-top: 0;
  }
  @media (hover: hover) {
    .todo:hover,
    .more:hover,
    .bh:hover {
      background: color-mix(in srgb, var(--text) 4%, transparent);
    }
    .dot:hover {
      background: color-mix(in srgb, var(--text) 8%, transparent);
    }
  }
  .todo:active,
  .more:active,
  .bh:active {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }

  /* 点阵：每粒 12px 字形，点按范围 22px（手机 26px），不留缝——粒与粒的间隔就是点按范围的留白 */
  .dots {
    display: flex;
    flex-wrap: wrap;
    padding: 0 9px 9px;
  }
  .dot {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 22px;
    height: 22px;
    border-radius: var(--r-xs);
    transition:
      opacity var(--t-med) var(--ease),
      background-color var(--t-fast) var(--ease);
  }
  .dot.dim {
    opacity: 0.18;
  }
  .dot:focus-visible {
    outline: 2px solid var(--live);
    outline-offset: -2px;
  }

  .foot {
    margin: 4px 4px 0;
    font-size: var(--fs-sm);
    line-height: 1.6;
    color: var(--text3);
  }

  .tip {
    position: absolute;
    z-index: 5;
    display: flex;
    flex-direction: column;
    gap: 1px;
    max-width: 280px;
    padding: 6px 9px 7px;
    border-radius: var(--r-sm);
    color: var(--bg);
    background: var(--text);
    box-shadow: var(--shadow-2);
    transform: translate(-50%, calc(-100% - 6px));
    pointer-events: none;
  }
  .tip-t {
    font-size: var(--fs-md);
    font-weight: 500;
    line-height: 1.4;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tip-s {
    font-size: var(--fs-xs);
    line-height: 1.4;
    opacity: 0.72;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  @media (max-width: 699px) {
    .bh {
      grid-template-columns: minmax(0, 1fr) 16px;
      row-gap: 2px;
    }
    .bh .chev {
      grid-row: 1;
      grid-column: 2;
    }
    .bm {
      grid-row: 2;
      grid-column: 1;
      text-align: left;
    }
    .nm {
      max-width: none;
    }
    .dot {
      width: 26px;
      height: 26px;
    }
    .dots {
      padding: 0 7px 8px;
    }
  }
</style>
