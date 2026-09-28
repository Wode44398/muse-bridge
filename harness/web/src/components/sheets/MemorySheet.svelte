<script lang="ts">
  // 项目记忆（K4）：看这个项目记住了什么，逐条确认 / 驳回 / 撤销驳回 / 编辑 / 删除。
  // 以前界面完全不调 /api/memory：模型存的「待确认」条目永远进不了提示，错的「生效」条目也没处驳回。
  // 结构：「这个项目 | 全局」（K7，有能力位才有）→ 按状态分三组（待确认 / 生效中 / 其他）→ 点一条就地展开全文和动作。
  // 看哪个项目在打开时就定下（面板开着时侧栏再点别的项目，不影响这一个）。
  import { onMount } from "svelte";
  import { app, globalMemoryAvailable, pathKey, toast } from "../../lib/state.svelte.ts";
  import { GLOBAL_MEMORY_WS, listMemory, readMemoryNote, type MemoryMeta, type MemoryNote } from "../../lib/api.ts";
  import { haptic } from "../../lib/touch.ts";
  import { collapse, rise, smoothHeight } from "../../lib/motion.ts";
  import Sheet from "../ui/Sheet.svelte";
  import Group from "../ui/Group.svelte";
  import Segmented from "../ui/Segmented.svelte";
  import Button from "../ui/Button.svelte";
  import Icon from "../ui/Icon.svelte";
  import Mark from "../brand/Mark.svelte";
  import MemoryDetail from "./MemoryDetail.svelte";
  import { CONF_LABEL, fmtDate, groupOf, issuesOf, originText, STATUS_LABEL, TYPE_LABEL, type MemoryGroup } from "./memory-text.ts";

  let { onclose }: { onclose: () => void } = $props();

  // 不是从项目菜单点进来的（斜杠命令 / 设置里）：看当前工作空间，标题用它在列表里的名字（快照桶的目录名是 UUID）
  const target =
    app.memoryFor ??
    (() => {
      const path = app.config?.workspace ?? "";
      const listed = path ? app.projects.find((p) => pathKey(p.path) === pathKey(path)) : undefined;
      return { path, name: listed?.name || path.split(/[\\/]/).filter(Boolean).pop() || "当前项目" };
    })();
  // K7：全局层是关于你与这台机器、每个项目都适用的记忆
  let layer = $state<"project" | "global">("project");
  const ws = $derived(layer === "global" ? GLOBAL_MEMORY_WS : target.path);

  let items = $state<MemoryMeta[]>([]);
  let loading = $state(true);
  let loadError = $state("");
  // 点一条先读全文（行尾亮一枚在权衡的标志），读到了再展开——展开的高度一次量准，读不到就留在列表上
  let reading = $state<string | null>(null);
  let openId = $state<string | null>(null); // 展开的那一条
  let picked = $state<MemoryNote | null>(null); // 它的全文
  let loadSeq = 0;
  let readSeq = 0;
  const btn: "sm" | "md" = matchMedia("(pointer: coarse)").matches ? "md" : "sm";

  const SECTIONS: { key: MemoryGroup; label: string; empty: string }[] = [
    { key: "proposed", label: "待确认", empty: "没有等你确认的记忆" },
    { key: "active", label: "生效中", empty: "还没有生效的记忆" },
    { key: "other", label: "其他", empty: "没有失效、被替代或驳回的记忆" },
  ];
  const groups = $derived({
    proposed: items.filter((m) => groupOf(m) === "proposed"),
    active: items.filter((m) => groupOf(m) === "active"),
    other: items.filter((m) => groupOf(m) === "other"),
  });

  async function load() {
    const my = ++loadSeq;
    loadError = "";
    try {
      const list = await listMemory(ws);
      if (my !== loadSeq) return;
      items = Array.isArray(list) ? list : [];
    } catch (e: any) {
      if (my === loadSeq) loadError = String(e?.message ?? e);
    } finally {
      if (my === loadSeq) loading = false;
    }
  }
  onMount(() => void load());

  function closeRow() {
    openId = null;
    picked = null;
    reading = null;
    readSeq++;
  }

  function switchLayer(next: "project" | "global") {
    if (next === layer) return;
    haptic("light");
    layer = next;
    closeRow();
    items = [];
    loading = true;
    void load();
  }

  async function toggle(m: MemoryMeta) {
    if (openId === m.id) {
      closeRow();
      return;
    }
    haptic("light");
    const my = ++readSeq;
    reading = m.id;
    try {
      const note = await readMemoryNote(ws, m.id);
      if (my !== readSeq) return;
      picked = note;
      openId = m.id;
    } catch (e: any) {
      if (my === readSeq) toast(`读取失败：${e?.message ?? e}`);
    } finally {
      if (my === readSeq) reading = null;
    }
  }

  // 动作做完（提示已经由详情给了）：收起这一条，重新拉列表（条目可能换了组）
  async function changed() {
    closeRow();
    await load();
  }
</script>

<Sheet title={layer === "global" ? "全局记忆" : `「${target.name}」的记忆`} {onclose} size="lg">
  {#if globalMemoryAvailable()}
    <div class="layer">
      <Segmented
        size="sm"
        label="记忆范围"
        value={layer}
        onchange={switchLayer}
        options={[
          { value: "project", label: "这个项目" },
          { value: "global", label: "全局" },
        ]}
      />
    </div>
  {/if}

  {#if loading && !items.length}
    <p class="state"><Mark size={16} live /><span>加载中…</span></p>
  {:else if loadError && !items.length}
    <div class="state err" role="alert">
      <span>加载失败：{loadError}</span>
      <Button size={btn} variant="ghost" icon="reload" onclick={() => load()}>重试</Button>
    </div>
  {:else}
    {#if loadError}
      <p class="stale" role="alert">加载失败：{loadError}</p>
    {/if}
    {#each SECTIONS as s (s.key)}
      <Group title={s.label}>
        {#snippet aside()}
          {#if groups[s.key].length}
            <span class="count" class:warn={s.key === "proposed"}>{groups[s.key].length}</span>
          {/if}
        {/snippet}
        {#each groups[s.key] as m, i (m.id)}
          {@const open = openId === m.id}
          {@const warns = issuesOf(m).length}
          <div class="mem" class:open in:rise|global={{ y: 6, delay: Math.min(i, 10) * 25 }} out:collapse>
            <button class="head" aria-expanded={open} onclick={() => toggle(m)}>
              <span class="main">
                <span class="title">{m.title}</span>
                {#if m.description}<span class="desc" class:clamp={!open}>{m.description}</span>{/if}
                <span class="meta">
                  {#if s.key === "other"}
                    <span class="st" class:rej={m.status === "rejected"}>{STATUS_LABEL[m.status] ?? m.status}</span>
                  {/if}
                  <span>{TYPE_LABEL[m.type] ?? m.type}</span>
                  <span class="sep" aria-hidden="true">·</span>
                  <span>{CONF_LABEL[m.confidence] ?? m.confidence}</span>
                  {#if originText(m)}
                    <span class="sep" aria-hidden="true">·</span>
                    <span>{originText(m)}</span>
                  {/if}
                  {#if warns}<span class="warns">⚠ {warns}</span>{/if}
                  {#if m.updated}<span class="date">{fmtDate(m.updated)}</span>{/if}
                </span>
              </span>
              <span class="chev" aria-hidden="true">
                {#if reading === m.id}<Mark size={16} live />{:else}<Icon name="chevronD" size={16} />{/if}
              </span>
            </button>
            {#if open && picked && picked.id === m.id}
              <div transition:collapse>
                <!-- 展开之后内容再变（进编辑、出提示）也是平滑生长 -->
                <div use:smoothHeight>
                  <div><MemoryDetail note={picked} {ws} onchanged={changed} /></div>
                </div>
              </div>
            {/if}
          </div>
        {:else}
          <p class="none">{s.empty}</p>
        {/each}
      </Group>
    {/each}
  {/if}

  <p class="foot">
    {#if layer === "global"}
      全局记忆只收「你是谁、这台机器怎么用」这类每个项目都适用的事实，生效的会进所有项目的对话提示，所以合计有长度上限。模型存的一律先放在「待确认」，你确认了才生效。
    {:else}
      只有「生效中」的记忆会进新对话的提示；模型自己存的先放在「待确认」，你确认了才生效。驳回的条目模型不会再用，也存不回来；删除的旧版留在记忆目录的 .history 里。
    {/if}
  </p>
</Sheet>

<style>
  .layer {
    margin: 2px 0 18px;
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

  .mem {
    transition: background-color var(--t-med) var(--ease);
  }
  /* 展开的那一条从分组面上「抬起来」一阶：详情里的输入框、正文在它上面才看得清 */
  .mem.open {
    background: var(--surface);
  }
  .head {
    display: flex;
    align-items: flex-start;
    gap: 10px;
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
    flex: 1;
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
  .chev {
    display: inline-flex;
    flex: none;
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
  .state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin: 0;
    padding: 36px 16px;
    font-size: var(--fs-md);
    color: var(--text3);
    text-align: center;
  }
  .state.err {
    flex-direction: column;
    color: var(--err);
    overflow-wrap: anywhere;
  }
  .stale {
    margin: 0 4px 14px;
    font-size: var(--fs-sm);
    color: var(--err);
  }
  .foot {
    margin: 4px 4px 0;
    font-size: var(--fs-sm);
    line-height: 1.6;
    color: var(--text3);
  }
  @media (prefers-reduced-motion: reduce) {
    .chev {
      transition: none;
    }
  }
</style>
