<script module lang="ts">
  import * as api from "../../lib/api.ts";
  import { reloadChat, toast } from "../../lib/state.svelte.ts";
  import { t, tc, tr, isEn, locale } from "../../lib/i18n.ts";

  // 找回 = 回滚到「撤销前现场」检查点（文件与对话一起回到撤销前那一刻）。挂在 8 秒的提示上，面板卸了也要能用，
  // 所以放在模块层；面板还开着、看的还是这个会话，才顺手刷新列表（§17-16）。
  async function recoverUndo(sid: string, n: number, refreshIfShowing: () => void): Promise<void> {
    try {
      const r = await api.rollback(sid, n);
      if (!r.ok) {
        toast(
          r.code === "running"
            ? t("有对话正在跑，停下后再找回")
            : r.code === "external"
              ? t("撤销之后这些文件又被改过，没有找回——要覆盖就到「回滚到检查点」里确认")
              : t("找回失败：{error}", { error: tr(String(r.error)) }),
        );
        return;
      }
      await reloadChat(sid);
      toast(t("已找回"));
      refreshIfShowing();
    } catch (e: any) {
      toast(t("找回失败：{error}", { error: tr(String(e?.message ?? e)) }));
    }
  }
</script>

<script lang="ts">
  // 工作区「审阅」：基线 → 工作区的变更清单，点文件就地展开 diff（懒加载）。
  // U10（K38）两个基线：「本会话」= 这个会话第一条消息之前（只列这个对话改过的文件，可逐个撤销；非 git 的工作区也看得到）
  // 与「项目 git」。有会话、服务端支持时默认看本会话；切换只记在面板里。
  // 撤销两步确认：退回会话开始之前（新建的删掉）；撤销前的现场服务端先存成检查点，提示上能「找回」。
  // 加载态只在手里什么都没有时显示；有旧的就先显示旧的、静默刷新（顶栏里一枚在权衡的标志）。
  import { onDestroy, untrack } from "svelte";
  import { app, sessionReviewAvailable } from "../../lib/state.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import { collapse } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Button from "../ui/Button.svelte";
  import Segmented from "../ui/Segmented.svelte";
  import Empty from "../ui/Empty.svelte";
  import Mark from "../brand/Mark.svelte";
  import DiffView from "./DiffView.svelte";

  let { ws = "", chatId = "" }: { ws?: string; chatId?: string } = $props();
  const coarse = matchMedia("(pointer: coarse)").matches; // 触屏：顶条按钮放大到 40

  interface OpenState {
    loading: boolean;
    text?: string;
    bin?: boolean;
    truncated?: boolean;
    err?: string;
  }
  interface RowFile {
    path: string;
    from?: string;
    st: string;
    add: number;
    del: number;
    bin: boolean;
    external?: boolean;
  }
  type Scope = "session" | "git";

  let loading = $state(true);
  let err = $state("");
  let data = $state<api.DockReview | null>(null);
  let sdata = $state<api.SessionReview | null>(null);
  let sdataChat = $state(""); // sdata 是哪个会话的：换了会话，旧会话的清单不能拿来先顶着（上面的撤销会打到新会话头上）
  let open = $state<Record<string, OpenState>>({});
  let picked = $state<Scope | null>(null);
  const sessionOk = $derived(Boolean(chatId) && sessionReviewAvailable());
  const scope = $derived<Scope>(sessionOk ? (picked ?? "session") : "git");
  const have = $derived(scope === "session" ? sdata !== null && sdataChat === chatId : data !== null);
  const busy = $derived(sdata?.available ? sdata.busy : false);
  // 撤销：等确认的文件 / 正在撤的文件
  let confirming = $state<string | null>(null);
  let undoing = $state<string | null>(null);

  let alive = true;
  onDestroy(() => (alive = false));

  const dockScope = () => ({ ws, chatId });
  let seq = 0; // 连着切范围时，只认最后一次的结果
  let openTok = 0; // 列表换过一版之后，还在路上的 diff 作废

  async function refresh(s: Scope = scope) {
    const my = ++seq;
    loading = true;
    err = "";
    try {
      if (s === "session") {
        const sid = chatId;
        const r = await api.sessionReview(sid);
        if (my !== seq) return;
        sdata = r;
        sdataChat = sid;
      } else {
        const r = await api.dockReview(dockScope());
        if (my !== seq) return;
        data = r;
      }
      // 刷新成功：展开的 diff 可能已经过时，一律收起
      open = {};
      confirming = null;
      openTok++;
    } catch (e: any) {
      if (my !== seq) return;
      err = e?.message || t("加载失败");
      if (s === "session") sdata = null;
      else data = null;
    }
    loading = false;
  }
  // {#key ws} 保证面板按工作空间重建；挂载即拉取，换会话 / 换范围重拉
  $effect(() => {
    const s = scope;
    if (!ws && !chatId) return;
    void chatId;
    untrack(() => void refresh(s));
  });
  // 有一轮跑完（在跑的对话数变少，前台后台都算）自动刷新一次：刚改的文件马上看得到；
  // 「有对话在跑」是服务端按整个工作区算的，后台那轮停了、撤销也要随之可点
  let lastRunning = 0;
  $effect(() => {
    const n = app.chats.reduce((k, c) => k + (c.running ? 1 : 0), 0);
    if (n < lastRunning) untrack(() => void refresh());
    lastRunning = n;
  });

  function pick(s: Scope) {
    if (s === scope) return;
    haptic("light");
    picked = s;
    // 另一个基线的展开态不能沿用（同一路径两边的 diff 不同）
    open = {};
    confirming = null;
    openTok++;
  }

  async function toggle(f: RowFile) {
    if (open[f.path]) {
      const { [f.path]: _, ...rest } = open;
      open = rest;
      if (confirming === f.path) confirming = null;
      return;
    }
    const tok = openTok;
    const sc = scope;
    open = { ...open, [f.path]: { loading: true } };
    try {
      const d =
        sc === "session"
          ? await api.sessionReviewDiff(chatId, f.path)
          : await api.dockReviewDiff(dockScope(), f.path, { from: f.from, untracked: f.st === "U" });
      if (tok !== openTok || !open[f.path]?.loading) return;
      open = { ...open, [f.path]: { loading: false, text: d.diff || "", bin: !!d.bin, truncated: !!d.truncated } };
    } catch (e: any) {
      if (tok !== openTok || !open[f.path]?.loading) return;
      open = { ...open, [f.path]: { loading: false, err: e?.message || t("加载失败") } };
    }
  }

  const baseName = (p: string) => p.split("/").pop() || p;

  async function undo(f: RowFile) {
    const sid = chatId;
    if (!sid || undoing) return;
    undoing = f.path;
    haptic("medium");
    try {
      const r = await api.restoreFiles(sid, [f.path], Boolean(f.external));
      if (!r.ok) {
        if (r.code === "external") toast(t("这个文件刚在对话之外被改过——列表已刷新，看过再决定"));
        else if (r.code === "stale") toast(t("列表过期了，已刷新"));
        else toast(r.code === "running" ? t("有对话正在跑，停下后才能撤销") : t("撤销失败：{error}", { error: tr(String(r.error)) }));
        if (r.code === "external" || r.code === "stale") await refresh();
        return;
      }
      const n = r.undo?.n;
      toast(
        f.st === "A"
          ? t("已删掉这个对话新建的 {name}", { name: baseName(f.path) })
          : t("已把 {name} 退回会话开始之前", { name: baseName(f.path) }),
        n
          ? {
              label: t("找回"),
              run: () =>
                void recoverUndo(sid, n, () => {
                  if (alive && chatId === sid) void refresh();
                }),
            }
          : undefined,
      );
      await reloadChat(sid);
      if (alive) await refresh();
    } catch (e: any) {
      toast(t("撤销失败：{error}", { error: tr(String(e?.message ?? e)) }));
    } finally {
      undoing = null;
      confirming = null;
    }
  }

  function ask(path: string) {
    haptic("light");
    confirming = path;
  }

  const fmtSince = (ts: number) => {
    const d = new Date(ts);
    // 英文界面按本地化格式（Sep 28, 3:04 PM）；中文照旧手拼 9/28 15:04
    if (isEn()) return new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
    return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };

  const ST_LABEL: Record<string, string> = {
    A: tc("diff", "新增"),
    D: tc("diff", "删除"),
    M: tc("diff", "修改"),
    R: tc("diff", "改名"),
    C: tc("diff", "复制"),
    U: tc("diff", "未跟踪"),
  };
</script>

{#snippet diffBody(o: OpenState)}
  {#if o.loading}
    <div class="dstate"><Mark size={16} live /></div>
  {:else if o.err}
    <div class="dstate">{tr(o.err)}</div>
  {:else if o.bin}
    <div class="dstate">{t("二进制文件，略")}</div>
  {:else if !o.text}
    <div class="dstate">{t("（无差异内容）")}</div>
  {:else}
    <DiffView text={o.text} truncated={!!o.truncated} />
  {/if}
{/snippet}

{#snippet fileRow(f: RowFile, session: boolean)}
  {@const o = open[f.path]}
  <div class="file">
    <button class="frow" class:open={!!o} aria-expanded={!!o} onclick={() => toggle(f)}>
      <span class="chev" class:down={!!o}><Icon name="chevronR" size={13} stroke={1.9} /></span>
      <span
        class="stb"
        class:ok={f.st === "A" || f.st === "U"}
        class:acc={f.st === "M" || f.st === "R" || f.st === "C"}
        class:bad={f.st === "D"}
        title={ST_LABEL[f.st] ?? f.st}
      >
        <span aria-hidden="true">{f.st}</span><span class="hx-sr">{ST_LABEL[f.st] ?? f.st}</span>
      </span>
      <span class="path" title={f.from ? `${f.from} → ${f.path}` : f.path}
        >{#if f.from}<span class="from">{f.from}{" → "}</span>{/if}{f.path}</span
      >
      {#if f.external}<span class="ext" title={t("这个对话改完之后，又在对话之外被改过")}>{t("外部也改过")}</span>{/if}
      {#if f.bin}
        <span class="bin">{t("二进制")}</span>
      {:else}
        <span class="cnt add">+{f.add}</span>
        <span class="cnt del">−{f.del}</span>
      {/if}
    </button>
    {#if o}
      <div class="fx" in:collapse out:collapse>
        <div class="fx-in">
          {#if session}
            <div class="acts">
              {#if confirming === f.path}
                <span class="ask">
                  <!-- 中文 =「外部改过的提醒」+「问句」连写；英文语序不同（问句在前），所以四种组合各是一整句 -->
                  {f.st === "A"
                    ? f.external
                      ? t("它在对话之外也被改过，那些改动会一起丢掉。删掉这个对话新建的文件？")
                      : t("删掉这个对话新建的文件？")
                    : f.external
                      ? t("它在对话之外也被改过，那些改动会一起丢掉。退回这个会话开始之前的样子？")
                      : t("退回这个会话开始之前的样子？")}
                </span>
                <Button size="sm" variant="ghost" disabled={undoing !== null} onclick={() => (confirming = null)}>{t("取消")}</Button>
                <Button size="sm" variant="danger" loading={undoing === f.path} disabled={undoing !== null} onclick={() => undo(f)}>
                  {undoing === f.path ? tc("diff", "撤销中…") : tc("diff", "确认撤销")}
                </Button>
              {:else}
                <Button size="sm" variant="secondary" icon="undo" disabled={busy || undoing !== null} onclick={() => ask(f.path)}>
                  {f.st === "A" ? t("撤销（删掉新建的）") : t("撤销这个文件的改动")}
                </Button>
                {#if busy}<span class="hint">{t("有对话在跑，停下后才能撤销")}</span>{/if}
              {/if}
            </div>
          {/if}
          {@render diffBody(o)}
        </div>
      </div>
    {/if}
  </div>
{/snippet}

<div class="rv">
  <!-- 顶条常驻（§17-14：以前 git 范围加载中 / 出错 / 不是仓库时整条不见，连刷新都没有） -->
  <div class="bar">
    {#if sessionOk}
      <Segmented
        size="sm"
        label={t("对比基线")}
        value={scope}
        options={[
          { value: "session", label: t("本会话") },
          { value: "git", label: t("项目 git") },
        ]}
        onchange={pick}
      />
    {/if}
    <div class="sum">
      {#if scope === "session"}
        {#if have && sdata?.available}
          <span class="base" title={t("这个会话第一条消息之前（{time}）", { time: fmtSince(sdata.since) })}>{t("会话开始前")}</span>
          <span class="to">→</span>
          <span class="to">{tc("diff", "工作区")}</span>
          <span class="tot"><em class="add">+{sdata.total.add}</em><em class="del">−{sdata.total.del}</em></span>
        {/if}
      {:else if data?.git}
        <span class="bic"><Icon name="branch" size={14} /></span>
        <span class="base" title={data.branch ?? ""}>{data.base}</span>
        <span class="to">→</span>
        <span class="to">{tc("diff", "工作区")}</span>
        <span class="tot"><em class="add">+{data.total?.add ?? 0}</em><em class="del">−{data.total?.del ?? 0}</em></span>
      {/if}
    </div>
    {#if loading && have}<span class="busy" title={t("正在读取变更…")}><Mark size={14} live /></span>{/if}
    <IconButton icon="reload" label={t("刷新")} size={coarse ? 40 : 30} iconSize={16} onclick={() => refresh()} />
  </div>

  <div class="scroll">
    {#if loading && !have}
      <div class="state">
        <Mark size={20} live />
        <p>{t("正在读取变更…")}</p>
      </div>
    {:else if err}
      <div class="state">
        <p>{tr(err)}</p>
        <Button size="sm" variant="secondary" icon="reload" onclick={() => refresh()}>{t("重试")}</Button>
      </div>
    {:else if scope === "session"}
      {#if !sdata?.available}
        <div class="empty">
          <Empty icon="undo" title={t("这个对话没有检查点（没开，或已被清理——只保留最近 30 个对话的），看不了它改了什么")}>
            <Button size="sm" variant="secondary" onclick={() => pick("git")}>{t("看项目 git")}</Button>
          </Empty>
        </div>
      {:else if !sdata.files.length}
        <div class="empty">
          <Empty
            title={t("这个对话没有留下改动")}
            text={sdata.others ? t("另有 {n} 个文件是对话之外改的，切到「项目 git」看", { n: sdata.others }) : undefined}
          />
        </div>
      {:else}
        {#if sdata.truncated}<p class="note warn">{t("变更过多，列表已截断")}</p>{/if}
        {#if sdata.others}<p class="note">{t("另有 {n} 个文件是对话之外改的，不在这里列", { n: sdata.others })}</p>{/if}
        <div class="list">
          {#each sdata.files as f (f.path)}{@render fileRow(f, true)}{/each}
        </div>
      {/if}
    {:else if !data || !data.git}
      <div class="empty">
        {#if sessionOk}
          <Empty icon="branch" title={t("当前工作空间不是 Git 仓库")}>
            <Button size="sm" variant="secondary" onclick={() => pick("session")}>{t("看这个对话改了什么")}</Button>
          </Empty>
        {:else}
          <Empty icon="branch" title={t("当前工作空间不是 Git 仓库")} />
        {/if}
      </div>
    {:else if !data.files?.length}
      <div class="empty"><Empty title={t("工作树很干净，没有改动")} /></div>
    {:else}
      {#if data.truncated}<p class="note warn">{t("变更过多，列表已截断")}</p>{/if}
      <div class="list">
        {#each data.files as f (f.path)}{@render fileRow(f, false)}{/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .rv {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  /* 顶条：基线切换 · 摘要（基线 → 工作区  +增 −删）· 刷新 */
  .bar {
    flex: none;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 40px;
    padding: 0 calc(6px + var(--hx-pane-r, 0px)) 0 10px;
    container-type: inline-size;
  }
  .sum {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text2);
  }
  .bic {
    display: inline-flex;
    flex: none;
    color: var(--text3);
  }
  .base {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-family: var(--font-ui);
  }
  .bic + .base {
    font-family: var(--font-mono);
  }
  .to {
    flex: none;
    color: var(--text3);
    font-family: var(--font-ui);
  }
  .tot {
    flex: none;
    display: inline-flex;
    gap: 7px;
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }
  .tot em {
    font-style: normal;
  }
  .add {
    color: var(--ok);
  }
  .del {
    color: var(--err);
  }
  .busy {
    display: inline-flex;
    flex: none;
    color: var(--text3);
  }
  @container (max-width: 400px) {
    .to {
      display: none;
    }
  }
  /* 英文的基线切换（This session / Project Git）与「→ Working tree」都长一截：门槛相应抬高，免得把基线名挤没 */
  @container (max-width: 480px) {
    .to:lang(en) {
      display: none;
    }
  }

  .scroll {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 2px 8px 24px;
  }
  .state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding: 32px 20px;
    color: var(--text3);
    text-align: center;
  }
  .state p {
    margin: 0;
    max-width: 320px;
    font-size: var(--fs-md);
    line-height: 1.6;
    color: var(--text2);
  }
  .empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .empty > :global(*) {
    max-width: 340px;
  }
  .note {
    margin: 2px 8px 8px;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text3);
  }
  .note.warn {
    color: var(--warn);
  }

  .list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .frow {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 36px;
    padding: 6px 8px 6px 6px;
    border-radius: var(--r-sm);
    font-size: var(--fs-md);
    color: var(--text2);
    text-align: left;
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .frow.open {
    color: var(--text);
  }
  @media (hover: hover) {
    .frow:hover {
      background: color-mix(in srgb, var(--text) 4%, transparent);
      color: var(--text);
    }
  }
  .frow:active {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  @media (pointer: coarse) {
    .frow {
      min-height: 44px;
    }
  }
  .chev {
    flex: none;
    display: inline-flex;
    color: var(--text3);
    transition: transform var(--t-med) var(--ease-out);
  }
  .chev.down {
    transform: rotate(90deg);
  }
  /* 状态字母：小色块。新增 ok、修改 / 改名 / 复制 青、删除 err（文字说明给读屏与悬停） */
  .stb {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 5px;
    background: var(--surface2);
    color: var(--text3);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-weight: 600;
  }
  .stb.ok {
    background: color-mix(in srgb, var(--ok) 13%, transparent);
    color: var(--ok);
  }
  .stb.acc {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .stb.bad {
    background: color-mix(in srgb, var(--err) 12%, transparent);
    color: var(--err);
  }
  /* 路径从左边省略，文件名始终看得见 */
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    direction: rtl;
    text-align: left;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
  }
  .path::after {
    content: "\200e";
  }
  .from {
    color: var(--text3);
  }
  .ext {
    flex: none;
    padding: 1px 7px;
    border-radius: var(--r-pill);
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    color: var(--warn);
    font-size: var(--fs-xs);
  }
  .bin {
    flex: none;
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .cnt {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
  }

  .fx {
    padding: 2px 0 8px 22px;
  }
  .fx-in {
    border-radius: var(--r-md);
    background: var(--code-bg);
    overflow: hidden;
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
    padding: 8px 10px;
    background: color-mix(in srgb, var(--text) 3%, transparent);
  }
  .ask {
    flex: 1 1 180px;
    font-size: var(--fs-md);
    line-height: 1.5;
    color: var(--text);
  }
  .hint {
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .dstate {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 16px;
    font-size: var(--fs-sm);
    color: var(--text3);
  }
</style>
