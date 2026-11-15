<script lang="ts">
  // 项目概览（上下文面板里，项目对话才有；服务端 server/project-routes.ts）。三段：
  //  · 讨论串：按状态分组——等你（挂着要你点的卡）/ 进行中 / 空闲 / 已解决；点标题打开那条讨论串，右边的勾标为已解决或重新打开。
  //    在不在跑、有没有等你按侧栏那份实时状态（app.sessions 的 running / waiting）覆盖拉回来的值，跑起来停下当场就变。
  //  · 项目说明：协调者和每条讨论串都要遵守（≤16000 字）；改了下一轮开跑时送到（不打断正在跑的这一轮）。
  //  · 项目记忆：协调者和讨论串共用的一份（MEMORY.md 是索引），列出篇名，点开看正文。
  // 什么时候重拉：打开时、会话列表每次重拉时（服务端在派生 / 汇报 / 标已解决 / 改说明 / 写记忆时都发 list_changed）。
  import { untrack } from "svelte";
  import { app } from "../../lib/state.svelte.ts";
  import { family, openFamilySession } from "../../lib/session-family.svelte.ts";
  import { getProject, readProjectMemory, resolveProjectThread, saveProjectInstructions, type ProjectThread, type ProjectView } from "../../lib/api.ts";
  import { haptic } from "../../lib/touch.ts";
  import { collapse } from "../../lib/motion.ts";
  import { t } from "../../lib/i18n.ts";
  import Button from "../ui/Button.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import TextArea from "../ui/TextArea.svelte";

  let { sid, onclose }: { sid: string; onclose: () => void } = $props();
  const coarse = matchMedia("(pointer: coarse)").matches; // 触屏：「标为已解决」放大到 40（DESIGN.md §6 触控目标）

  let view = $state<ProjectView | null>(null);
  let err = $state("");
  let seq = 0;
  async function load() {
    const mine = ++seq;
    try {
      const v = await getProject(sid);
      if (mine === seq) {
        view = v;
        err = "";
      }
    } catch (e) {
      if (mine === seq && !view) err = (e as Error).message || String(e);
    }
  }
  // 会话列表每次重拉都换一份台账对象：跟着它重拉概览（有旧数据先显示旧的，静默刷新）
  $effect(() => {
    void family.links;
    void sid;
    untrack(() => void load());
  });

  // ── 讨论串 ──────────────────────────────────────────────────────────────────────────────
  type Group = "waiting" | "working" | "resolved" | "idle";
  const GROUPS: { key: Group; label: string }[] = [
    { key: "waiting", label: t("等你") },
    { key: "working", label: t("进行中") },
    { key: "idle", label: t("空闲") },
    { key: "resolved", label: t("已解决") },
  ];
  function liveOf(th: ProjectThread): { running: boolean; waiting: boolean } {
    const row = app.sessions.find((s) => s.id === th.id);
    return row ? { running: Boolean(row.running), waiting: Boolean(row.waiting) } : { running: th.state === "working", waiting: th.waiting };
  }
  // 在跑、等你的排在已解决前面：用户在已解决的讨论串里接着聊，它就回到进行中
  function groupOf(th: ProjectThread): Group {
    const l = liveOf(th);
    if (l.waiting) return "waiting";
    if (l.running) return "working";
    return th.resolved ? "resolved" : "idle";
  }
  const grouped = $derived(
    GROUPS.map((g) => ({ ...g, rows: (view?.threads ?? []).filter((th) => groupOf(th) === g.key).sort((a, b) => b.at - a.at) })).filter((g) => g.rows.length),
  );
  const total = $derived(view?.threads.length ?? 0);

  let busyThread = $state("");
  async function toggleResolved(th: ProjectThread) {
    if (busyThread) return;
    busyThread = th.id;
    haptic("light");
    try {
      const r = await resolveProjectThread(sid, th.id, !th.resolved);
      th.resolved = r.resolved;
    } catch (e) {
      err = (e as Error).message || String(e);
    } finally {
      busyThread = "";
    }
  }
  function open(th: ProjectThread) {
    haptic("light");
    onclose();
    void openFamilySession(th.id, th.agent === "claude" ? "claude" : "dimensio");
  }

  // ── 项目说明 ────────────────────────────────────────────────────────────────────────────
  let editing = $state(false);
  let draft = $state("");
  let saving = $state(false);
  const max = $derived(view?.instructionsMax ?? 16000);
  function edit() {
    draft = view?.instructions ?? "";
    editing = true;
  }
  async function save() {
    if (saving || draft.length > max) return;
    saving = true;
    haptic("light");
    try {
      view = await saveProjectInstructions(sid, draft);
      editing = false;
      err = "";
    } catch (e) {
      err = (e as Error).message || String(e);
    } finally {
      saving = false;
    }
  }

  // ── 项目记忆 ────────────────────────────────────────────────────────────────────────────
  let memOpen = $state("");
  let memText = $state("");
  async function toggleMemory(name: string) {
    haptic("light");
    if (memOpen === name) {
      memOpen = "";
      return;
    }
    memOpen = name;
    memText = "";
    try {
      const r = await readProjectMemory(sid, name);
      if (memOpen === name) memText = r.content;
    } catch (e) {
      if (memOpen === name) memText = (e as Error).message || String(e);
    }
  }
</script>

<section class="po" aria-label={t("项目概览")}>
  <h4>{t("讨论串")}{#if total}<span class="n">{total}</span>{/if}</h4>
  {#if !view}
    {#if err}<p class="err">{err}</p>{:else}<p class="note hx-shimmer">{t("正在读项目概览…")}</p>{/if}
  {:else if !total}
    <p class="note">{t("还没有讨论串：在这里说要做什么，协调者会把要动手的活开成讨论串，它们出现在这里和侧栏里。")}</p>
  {:else}
    {#each grouped as g (g.key)}
      <div class="grp">
        <p class="gl">{g.label}</p>
        {#each g.rows as th (th.id)}
          <div class="th" transition:collapse>
            <span class="dot" class:live={g.key === "working"} class:wait={g.key === "waiting"} aria-hidden="true"></span>
            <button class="tt" title={t("打开这条讨论串")} onclick={() => open(th)}>
              <span class="name">{th.title || th.name}</span>
              {#if th.report}<span class="rep">{th.report}</span>{/if}
            </button>
            <IconButton
              icon={th.resolved ? "checkCircle" : "circle"}
              size={coarse ? 40 : 30}
              iconSize={15}
              active={th.resolved}
              loading={busyThread === th.id}
              label={th.resolved ? t("重新打开") : t("标为已解决")}
              title={th.resolved ? t("重新打开") : t("标为已解决")}
              onclick={() => toggleResolved(th)}
            />
          </div>
        {/each}
      </div>
    {/each}
    <p class="note">{t("同时最多 {live} 条在跑，一个项目最多 {all} 条。", { live: view.limits.maxLive, all: view.limits.maxThreads })}</p>
  {/if}
  {#if view && err}<p class="err">{err}</p>{/if}
</section>

{#if view}
  <section class="po">
    <h4>{t("项目说明")}</h4>
    {#if editing}
      <TextArea bind:value={draft} rows={4} maxRows={12} autofocus label={t("项目说明")} placeholder={t("协调者和每条讨论串都要遵守的：目标、约定、哪些不许碰……")} />
      <div class="ed">
        <span class="cnt" class:over={draft.length > max}>{draft.length} / {max}</span>
        <Button size="sm" variant="ghost" disabled={saving} onclick={() => (editing = false)}>{t("取消")}</Button>
        <Button size="sm" variant="secondary" loading={saving} disabled={saving || draft.length > max} onclick={save}>{t("保存")}</Button>
      </div>
      <p class="note">{t("改了从下一轮开始生效，正在跑的这一轮不受影响。")}</p>
    {:else}
      <button class="instr" class:empty={!view.instructions} title={t("编辑项目说明")} onclick={edit}>
        {view.instructions || t("还没有项目说明。点这里写下协调者和讨论串都要遵守的约定。")}
      </button>
    {/if}
  </section>

  <section class="po">
    <h4>{t("项目记忆")}{#if view.memory.length}<span class="n">{view.memory.length}</span>{/if}</h4>
    {#if !view.memory.length}
      <p class="note">{t("还是空的。你说「记住…」或定下长期有效的决定时，协调者和讨论串会记进来。")}</p>
    {:else}
      {#each view.memory as f (f.name)}
        <button class="mem" aria-expanded={memOpen === f.name} onclick={() => toggleMemory(f.name)}>{f.name}</button>
        {#if memOpen === f.name}
          <pre class="memtx" transition:collapse>{memText || "…"}</pre>
        {/if}
      {/each}
    {/if}
  </section>
{/if}

<style>
  .po {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  h4 {
    display: flex;
    align-items: baseline;
    gap: 6px;
    margin: 0;
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text3);
  }
  .n {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
  }
  .note {
    margin: 0;
    font-size: var(--fs-xs);
    line-height: 1.6;
    color: var(--text3);
  }
  .err {
    margin: 0;
    font-size: var(--fs-xs);
    line-height: var(--lh-ui);
    color: var(--err);
  }
  .grp {
    display: flex;
    flex-direction: column;
  }
  .gl {
    margin: 2px 0 2px;
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .th {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
  }
  /* 状态点：在跑 = 朱（正在发生）、等你 = 墨实心、其余 = 空心圈 */
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--text3);
  }
  .dot.live {
    background: var(--live);
    box-shadow: none;
  }
  .dot.wait {
    background: var(--accent);
    box-shadow: none;
  }
  .tt {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
    padding: 4px 6px;
    margin: 0 -6px;
    border-radius: 8px;
    text-align: left;
    color: var(--text);
    transition: background-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) {
    .tt:hover,
    .mem:hover,
    .instr:hover {
      background: var(--surface2);
    }
  }
  .tt:active,
  .mem:active,
  .instr:active {
    background: var(--surface3);
  }
  .name {
    font-size: var(--fs-base);
    line-height: 1.35;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .rep {
    font-size: var(--fs-xs);
    line-height: 1.45;
    color: var(--text3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .instr {
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
    padding: 6px;
    margin: 0 -6px;
    border-radius: 8px;
    text-align: left;
    white-space: pre-wrap;
    font-size: var(--fs-sm);
    line-height: 1.55;
    color: var(--text2);
    transition: background-color var(--t-fast) var(--ease);
  }
  .instr.empty {
    color: var(--text3);
  }
  .ed {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
  }
  .cnt {
    flex: 1;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    color: var(--text3);
  }
  .cnt.over {
    color: var(--err);
  }
  .mem {
    padding: 8px 6px;
    margin: 0 -6px;
    border-radius: 8px;
    text-align: left;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text2);
    transition: background-color var(--t-fast) var(--ease);
  }
  /* 触屏：篇名行至少 40 高（DESIGN.md §6 触控目标） */
  @media (pointer: coarse) {
    .mem {
      min-height: 40px;
    }
  }
  .memtx {
    margin: 0 0 4px;
    padding: 8px 10px;
    max-height: 220px;
    overflow: auto;
    border-radius: 8px;
    background: var(--surface2);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.55;
    color: var(--text2);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
