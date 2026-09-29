<script lang="ts">
  // 一条记忆展开后的全文与动作（K4）。按它的状态给动作：确认（晋升 = 你为它担保：生效 + 你确认过，下一个对话起用上）·
  // 编辑后确认 · 驳回（可附一句理由，模型以后看得到）· 撤销驳回 · 删除（按钮上两步确认）。
  // 校验不过就说清差在哪、自动进编辑；同一主题已有生效的给「替换它」；全局层满了说清楚。
  // 每打开一条就是一个新实例：动作状态（编辑中、驳回中、待确认删除……）不串到别的条目上。
  // K11：有总览数据时多两样——「经历」（每一份旧版是一次改写 / 驳回……，就是行右边时间线上的刻痕，这里是它的表格版）
  // 与「召回」（全文被拉进对话几次、最近一次）。
  import { toast } from "../../lib/state.svelte.ts";
  import { deleteMemoryNote, promoteMemoryNote, rejectMemoryNote, restoreMemoryNote, type MemoryHistoryWhy, type MemoryNote } from "../../lib/api.ts";
  import { haptic } from "../../lib/touch.ts";
  import { rise } from "../../lib/motion.ts";
  import { t, tc, tr } from "../../lib/i18n.ts";
  import Button from "../ui/Button.svelte";
  import Switch from "../ui/Switch.svelte";
  import { agoOf, explain, fmtDate, HISTORY_TEXT, issuesOf, STATUS_LABEL } from "./memory-text.ts";

  let {
    note,
    ws,
    events = [],
    usage,
    onchanged,
  }: {
    note: MemoryNote;
    ws: string;
    events?: Array<{ at: string; why: MemoryHistoryWhy }>;
    usage?: { uses: number; first?: string; last?: string };
    onchanged: () => void | Promise<void>;
  } = $props();

  // 触屏上行内的小按钮放大一档（点按目标别太小）
  const btn: "sm" | "md" = matchMedia("(pointer: coarse)").matches ? "md" : "sm";

  let busy = $state<"" | "promote" | "reject" | "restore" | "delete">("");
  let problems = $state<string[]>([]);
  let conflicts = $state<Array<{ id: string; title: string }> | null>(null);
  let editing = $state(false);
  let draft = $state({ title: "", description: "", content: "", dropExpiry: false });
  let rejecting = $state(false);
  let reason = $state("");
  let confirmDelete = $state(false);

  const canPromote = $derived(note.declaredStatus !== "rejected" && note.declaredStatus !== "superseded");
  const promoteLabel = $derived(
    note.declaredStatus === "proposed" ? t("确认，让它生效") : note.status === "active" ? t("保存并确认") : t("重新确认，让它生效"),
  );
  // 「召回 n 次，最近 …」：英文里「多久以前」嵌在句中（most recently today），按档位各取一整句；
  // 次数那一截套 .num，所以走 {@html}——插进去的只有数字与本地格式化的日期
  const recallHtml = $derived.by(() => {
    if (!usage?.uses) return "";
    const n = usage.uses;
    const a = usage.last ? agoOf(usage.last) : null;
    if (!a) return t('召回 <span class="num">{n}</span> 次', { n });
    if (a.k === "today") return t('召回 <span class="num">{n}</span> 次，最近 今天', { n });
    if (a.k === "yesterday") return t('召回 <span class="num">{n}</span> 次，最近 昨天', { n });
    if (a.k === "days") return t('召回 <span class="num">{n}</span> 次，最近 {d} 天前', { n, d: a.n });
    if (a.k === "weeks") return t('召回 <span class="num">{n}</span> 次，最近 {d} 周前', { n, d: a.n });
    if (a.k === "months") return t('召回 <span class="num">{n}</span> 次，最近 {d} 个月前', { n, d: a.n });
    return t('召回 <span class="num">{n}</span> 次，最近 {date}', { n, date: a.date });
  });
  const issues = $derived(issuesOf(note));
  const evidence = $derived(note.evidence ?? []);
  const anchors = $derived(note.anchors ?? []);
  const scope = $derived(note.scope ?? []);

  function startEdit() {
    draft = { title: note.title, description: note.description, content: note.content, dropExpiry: false };
    editing = true;
    rejecting = false;
    confirmDelete = false;
  }

  async function promote(supersedes?: string) {
    busy = "promote";
    problems = [];
    haptic("medium");
    const edits = editing
      ? { title: draft.title, description: draft.description, content: draft.content, ...(draft.dropExpiry ? { expiresAt: null } : {}) }
      : undefined;
    try {
      const r = await promoteMemoryNote(ws, note.id, { edits, supersedes });
      if (r.ok) {
        toast(supersedes ? t("已生效，替换了原来那条") : t("已生效，之后的对话会用上它"));
        await onchanged();
      } else if (r.conflicts?.length) {
        conflicts = r.conflicts; // 同一主题已经有生效的
      } else if (r.code === "global_budget") {
        problems = [t("全局记忆满了（生效的条目合计有长度上限，每个对话的提示里都有它们）：先驳回或删掉一条旧的，再确认这一条")];
      } else {
        problems = explain(r.error); // 校验不过：说清差在哪，直接进编辑
        if (!editing) startEdit();
      }
    } catch (e: any) {
      toast(t("操作失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
    }
    busy = "";
  }

  async function reject() {
    busy = "reject";
    haptic("medium");
    try {
      await rejectMemoryNote(ws, note.id, reason.trim() || undefined);
      toast(t("已驳回，模型不会再用它、也不能再存同一条"));
      await onchanged();
    } catch (e: any) {
      toast(t("驳回失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
    }
    busy = "";
  }

  async function restore() {
    busy = "restore";
    try {
      await restoreMemoryNote(ws, note.id);
      toast(t("已撤销驳回，回到待确认"));
      await onchanged();
    } catch (e: any) {
      toast(t("撤销失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
    }
    busy = "";
  }

  // 删除是两步：第一次点只是「上膛」，按钮变成「再点一次删除」
  async function remove() {
    if (!confirmDelete) {
      confirmDelete = true;
      rejecting = false;
      haptic("light");
      return;
    }
    busy = "delete";
    haptic("medium");
    try {
      await deleteMemoryNote(ws, note.id);
      toast(t("已删除（旧版仍留在记忆目录的 .history 里）"));
      await onchanged();
    } catch (e: any) {
      toast(t("删除失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
    }
    busy = "";
  }
</script>

<div class="md">
  <div class="meta">
    <span class="st" class:rej={note.status === "rejected"}>{STATUS_LABEL[note.status] ?? note.status}</span>
    <span class="kv">{tc("dimensio", "主题")} <code>{note.topic}</code></span>
    {#if note.updated}<span class="kv">{tc("名词", "更新")} <span class="num">{fmtDate(note.updated)}</span></span>{/if}
    {#if note.expiresAt}<span class="kv">{t("到期")} <span class="num">{fmtDate(note.expiresAt)}</span></span>{/if}
    {#if usage?.uses}<span class="kv">{@html recallHtml}</span>{/if}
  </div>

  {#if note.declaredStatus === "rejected"}
    <p class="banner err">
      {note.rejectReason
        ? t("你在 {date} 驳回了它：{reason}", { date: fmtDate(note.rejectedAt), reason: note.rejectReason })
        : t("你在 {date} 驳回了它。", { date: fmtDate(note.rejectedAt) })}
    </p>
  {:else if note.supersededBy}
    <p class="banner">{t("已被「{id}」替代。", { id: note.supersededBy })}</p>
  {/if}

  {#if issues.length}
    <ul class="issues">
      {#each issues as it}<li>⚠ {it}</li>{/each}
    </ul>
  {/if}

  {#if editing}
    <div class="form" in:rise={{ y: 4 }}>
      <label class="fld">
        <span>{t("标题")}</span>
        <input class="in" bind:value={draft.title} maxlength="120" autocomplete="off" />
      </label>
      <label class="fld">
        <span>{t("一句话说明")}</span>
        <input class="in" bind:value={draft.description} maxlength="240" autocomplete="off" />
      </label>
      <label class="fld">
        <span>{t("正文")}</span>
        <textarea class="in ta" bind:value={draft.content} rows="10" spellcheck="false"></textarea>
      </label>
      {#if note.expiresAt}
        <div class="swrow">
          <span>{t("去掉到期时间")}</span>
          <Switch checked={draft.dropExpiry} label={t("去掉到期时间")} onchange={(v) => (draft.dropExpiry = v)} />
        </div>
      {/if}
    </div>
  {:else}
    <pre class="content">{note.content}</pre>
    {#if evidence.length || anchors.length || scope.length || events.length}
      <dl class="facts">
        {#if evidence.length}
          <dt>{t("证据")}</dt>
          <dd>{#each evidence as e}<div>{e}</div>{/each}</dd>
        {/if}
        {#if anchors.length}
          <dt>{t("挂靠文件")}</dt>
          <dd>{#each anchors as a}<div><code>{a}</code></div>{/each}</dd>
        {/if}
        {#if scope.length}
          <dt>{t("适用范围")}</dt>
          <dd>{scope.join(t("、"))}</dd>
        {/if}
        {#if events.length}
          <dt>{t("经历")}</dt>
          <dd class="hist">
            {#each events as e, i (i)}<div><span class="num">{fmtDate(e.at)}</span> {HISTORY_TEXT[e.why]}</div>{/each}
            {#if note.updated}<div><span class="num">{fmtDate(note.updated)}</span> {t("当前版本")}</div>{/if}
          </dd>
        {/if}
      </dl>
    {/if}
  {/if}

  {#if problems.length}
    <div class="banner err" role="alert" in:rise={{ y: 4 }}>
      <p>{t("还不能生效，差这些：")}</p>
      <ul>
        {#each problems as p}<li>{p}</li>{/each}
      </ul>
    </div>
  {/if}

  {#if conflicts}
    <div class="banner warn" role="alert" in:rise={{ y: 4 }}>
      <p>{t("同一主题已经有生效的「{titles}」。", { n: conflicts.length, titles: conflicts.map((c) => c.title).join(t("」「")) })}</p>
      {#if conflicts.length === 1}
        <div class="acts end">
          <Button size={btn} variant="ghost" disabled={!!busy} onclick={() => (conflicts = null)}>{t("先不动")}</Button>
          <Button size={btn} variant="accent" loading={busy === "promote"} disabled={!!busy} onclick={() => promote(conflicts?.[0]?.id)}>{t("替换它")}</Button>
        </div>
      {:else}
        <p>{t("先把多余的那几条驳回或删掉，再来确认这一条。")}</p>
      {/if}
    </div>
  {/if}

  {#if rejecting}
    <div class="reject" in:rise={{ y: 4 }}>
      <label class="fld">
        <span>{t("为什么驳回（可选，模型以后会看到这句）")}</span>
        <input class="in" bind:value={reason} maxlength="240" placeholder={t("比如：这是猜的，实际不是这样")} autocomplete="off" />
      </label>
      <div class="acts end">
        <Button size={btn} variant="ghost" disabled={!!busy} onclick={() => (rejecting = false)}>{t("取消")}</Button>
        <Button size={btn} variant="danger" loading={busy === "reject"} disabled={!!busy} onclick={reject}>{t("确认驳回")}</Button>
      </div>
    </div>
  {:else if !conflicts}
    <div class="acts">
      <div class="minor">
        {#if canPromote && !editing}
          <Button size={btn} variant="ghost" icon="edit" disabled={!!busy} onclick={startEdit}>{t("编辑")}</Button>
        {:else if editing}
          <Button
            size={btn}
            variant="ghost"
            disabled={!!busy}
            onclick={() => {
              editing = false;
              problems = [];
            }}>{t("取消编辑")}</Button
          >
        {/if}
        {#if note.declaredStatus !== "rejected"}
          <Button
            size={btn}
            variant="ghost"
            icon="close"
            disabled={!!busy}
            onclick={() => {
              rejecting = true;
              confirmDelete = false;
            }}>{t("驳回")}</Button
          >
        {/if}
        <Button size={btn} variant={confirmDelete ? "danger" : "ghost"} icon="trash" loading={busy === "delete"} disabled={!!busy} onclick={remove}>
          {confirmDelete ? t("再点一次删除") : t("删除")}
        </Button>
      </div>
      <div class="major">
        {#if canPromote}
          <Button variant="accent" icon="check" loading={busy === "promote"} disabled={!!busy} onclick={() => promote()}>
            {busy === "promote" ? t("处理中…") : editing ? t("保存并确认") : promoteLabel}
          </Button>
        {/if}
        {#if note.declaredStatus === "rejected"}
          <Button variant="secondary" icon="undo" loading={busy === "restore"} disabled={!!busy} onclick={restore}>{t("撤销驳回")}</Button>
        {/if}
      </div>
    </div>
  {/if}
</div>

<style>
  .md {
    padding: 2px 14px 14px;
    font-size: var(--fs-md);
    color: var(--text2);
  }
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 12px;
    margin: 2px 0 10px;
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .st {
    display: inline-flex;
    align-items: center;
    height: 20px;
    padding: 0 8px;
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
  /* 「召回 n 次」那一句是 {@html} 进来的（见 recallHtml）：里面的 .num 要写 :global */
  code,
  .num,
  .kv :global(.num) {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
  }
  .num,
  .kv :global(.num) {
    font-variant-numeric: tabular-nums;
  }

  .banner {
    margin: 0 0 10px;
    padding: 10px 12px;
    border-radius: 12px;
    line-height: 1.6;
    color: var(--text);
    background: color-mix(in srgb, var(--text) 5%, transparent);
  }
  .banner.err {
    background: color-mix(in srgb, var(--err) 9%, transparent);
  }
  .banner.warn {
    background: color-mix(in srgb, var(--warn) 11%, transparent);
  }
  .banner p {
    margin: 0;
  }
  .banner p + p {
    margin-top: 4px;
    color: var(--text2);
  }
  .banner ul {
    margin: 6px 0 0;
    padding-left: 18px;
  }
  .issues {
    margin: 0 0 10px;
    padding: 0;
    list-style: none;
    font-size: var(--fs-sm);
    line-height: 1.6;
    color: var(--err);
  }

  .content {
    margin: 0;
    padding: 12px 14px;
    border-radius: 12px;
    background: var(--surface2);
    font-family: var(--font-mono);
    font-size: var(--fs-md);
    line-height: 1.6;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    max-height: 40vh;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .facts {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 5px 14px;
    margin: 12px 2px 0;
    font-size: var(--fs-sm);
    line-height: 1.55;
  }
  .facts dt {
    color: var(--text3);
  }
  .facts dd {
    margin: 0;
    color: var(--text2);
    overflow-wrap: anywhere;
  }

  .form,
  .reject {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .reject {
    margin-top: 4px;
  }
  .fld {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .in {
    width: 100%;
    height: 38px;
    padding: 0 12px;
    border: 0;
    border-radius: 11px;
    outline: 0;
    background: var(--surface2);
    color: var(--text);
    font-size: var(--fs-base);
    box-shadow: inset 0 0 0 1px transparent;
    transition:
      box-shadow var(--t-fast) var(--ease),
      background-color var(--t-fast) var(--ease);
  }
  .in:focus {
    background: var(--surface);
    box-shadow:
      inset 0 0 0 1px var(--accent),
      0 0 0 3px var(--accent-soft);
  }
  .in::placeholder {
    color: var(--text3);
  }
  .ta {
    height: auto;
    min-height: 160px;
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: var(--fs-md);
    line-height: 1.55;
    resize: vertical;
  }
  .swrow {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 40px;
    font-size: var(--fs-md);
    color: var(--text2);
  }

  .acts {
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 14px;
  }
  .acts.end {
    justify-content: flex-end;
    margin-top: 10px;
  }
  .minor {
    display: flex;
    flex-wrap: wrap;
    gap: 2px;
    margin-left: -8px;
  }
  .major {
    display: flex;
    gap: 8px;
    margin-left: auto;
  }
  /* 手机：主动作整行放最上面，次要动作排在它下面 */
  @media (max-width: 699px) {
    .acts:not(.end) {
      flex-direction: column-reverse;
      align-items: stretch;
    }
    .acts:not(.end) .major {
      flex-direction: column;
      margin-left: 0;
    }
    .minor {
      justify-content: center;
      margin-left: 0;
    }
  }
</style>
