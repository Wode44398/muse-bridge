<script>
  // 官方 /code 页「工具调用分组」（Claude 桌面端 ion bundle c360a9e1c 的 lj / UD / ij / hF，
  // 规格 scratchpad/specs/agent-tool-card.md §5）的 Svelte 移植。
  //
  // 一段 tools（同一 assistant 轮里连续的 tool_use）进来：
  //   · 先按官方 hF 把「同一文件的连续 Read/Write/Edit」并成一个 run；
  //   · 只有 1 个 run → 不套分组头，直接渲染那一行 / 专用卡（Agent 行、Workflow 卡、普通工具行）；
  //   · 多个 run → 折叠头 + 展开卡。折叠头在【运行中】显示当前正在跑的那个工具的 running
  //     文案（流光），650ms 防抖免得连珠炮工具让头部抖动；settled 后换成汇总句
  //     「Read 3 files, edited a file, ran 2 commands, ran an agent」（有错的片段红）。
  //   · 展开态记在 seg.open 上（切会话/重开仍记得）；首次展开后内容保持挂载只切 hidden，
  //     行内展开体（参数表）的状态不会因收起而丢。
  //
  // 官方的 taskEvents（「Background agent started」芯片）在 bridge 里已折进工具行的 task
  // 字段，没有单独的芯片行。配色铁律「彩色只留星芒」：官方 accent 一律改 var(--text)。
  import { untrack } from 'svelte';
  import { openTaskDetail } from '../../lib/dock.svelte.js';
  import { toolVerb, groupSummary, morphText, isCompactTool } from '../../lib/toolVerbs.js';
  import { taskRunning } from '../../lib/taskModel.js';
  import { glyph } from '../../lib/claudeIcons.js';
  import ToolRow from './ToolRow.svelte';
  import AgentRow from './AgentRow.svelte';
  import WorkflowCard from './WorkflowCard.svelte';
  import CompactRow from './CompactRow.svelte';

  // seg：tools 段；m：所属消息（契约保留，判活以 live 为准）；live：本轮仍在流式；
  // onOpen：点开 Agent / Workflow 的回调（缺省=打开 TaskSheet；TaskSheet 内嵌只读用时可传空函数）；
  // onToggle：折叠头点击回调——展开态记在 seg.open 上，但 seg 是 Thread 传下来的【未绑定 prop】，
  // 在这里直接改会触发 Svelte 5 dev 的 ownership_invalid_mutation 警告（单写者规矩：谁持有段谁改），
  // 故由 Thread 传 onToggle 自己翻 seg.open；没传时才就地改（独立 harness 用）。
  let { seg, m = null, live = false, onOpen = undefined, onToggle = undefined } = $props();

  const tools = $derived(Array.isArray(seg.tools) ? seg.tools : []);
  function openTask(tool) { if (onOpen) onOpen(tool); else openTaskDetail(tool); }

  // —— 官方 hF：同一文件的连续读写并成一个 run（MultiEdit 与 Edit 同键）——
  const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
  function runKey(t) {
    if (!FILE_TOOLS.has(t.name)) return null;
    const p = t.input && (t.input.file_path || t.input.notebook_path);
    return p ? `${t.name === 'MultiEdit' ? 'Edit' : t.name} ${p}` : null;
  }
  const runs = $derived.by(() => {
    const out = [];
    let prev = null;
    for (let i = 0; i < tools.length; i++) {
      const t = tools[i];
      const k = runKey(t);
      if (k && k === prev) out[out.length - 1].tools.push(t);
      else out.push({ start: i, tools: [t] });
      prev = k;
    }
    return out;
  });
  const runId = (run) => run.tools[0].id || `i${run.start}`;

  // —— 组状态（官方 uF/fF）：任务启动型工具用任务状态覆盖（running→running、failed→error）——
  function eff(t) {
    const k = t.task;
    if (k && taskRunning(k.status)) return 'running';
    if (k && k.status === 'failed') return 'error';
    // 合成行（没有 tool_done 可等）：任务落定即行落定，别让它把分组头钉在 running 上
    if (t.synthetic && k && k.status !== 'unknown') return 'done';
    return t.status;
  }
  const running = $derived(!!live && tools.some((t) => eff(t) === 'running'));
  // 当前正在跑的工具取最后一个：主线程串行，最新那个最贴切；后台 agent 还在跑时也是它
  const current = $derived.by(() => {
    if (!running) return null;
    for (let i = tools.length - 1; i >= 0; i--) if (eff(tools[i]) === 'running') return tools[i];
    return null;
  });
  const keyOf = (t) => t.id || `i${tools.indexOf(t)}`;
  const key = $derived(current ? keyOf(current) : 'settled');
  // 官方 Wh(key, 650)：值稳定 650ms 后才反映到头部；首帧取当前值不等
  let shownKey = $state(untrack(() => key));
  $effect(() => {
    const k = key;
    if (k === shownKey) return;
    const timer = setTimeout(() => { shownKey = k; }, 650);
    return () => clearTimeout(timer);
  });
  const shownTool = $derived(shownKey === 'settled' ? null : (tools.find((t) => keyOf(t) === shownKey) || null));
  const head = $derived(shownTool ? toolVerb(shownTool) : null);
  const summary = $derived(head ? [] : groupSummary(tools));
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

  // —— 展开态：seg.open 记忆；首次展开后保持挂载只切 hidden（官方 Ny）——
  const isOpen = $derived(!!seg.open);
  let mounted = $state(untrack(() => !!seg.open));
  $effect(() => { if (isOpen) mounted = true; });
  function toggle() { if (onToggle) onToggle(); else seg.open = !seg.open; }
</script>

{#snippet runView(run, inGroup)}
  {@const t = run.tools[0]}
  {#if isCompactTool(t)}
    <!-- 上下文压缩（官方 compacted 条目）：干活途中压缩就在组里，否则单独一行；点开看压缩摘要 -->
    <CompactRow tool={t} {inGroup} {live} />
  {:else if t.name === 'Agent' || t.name === 'Task'}
    <AgentRow tool={t} {inGroup} {live} onOpen={openTask} />
  {:else if t.name === 'Workflow'}
    <WorkflowCard tool={t} {inGroup} {live} onOpen={openTask} />
  {:else}
    <ToolRow tool={t} run={run.tools} {inGroup} {live} />
  {/if}
{/snippet}

{#if runs.length === 1}
  {@render runView(runs[0], false)}
{:else if runs.length > 1}
  <div class="grp">
    <button type="button" class="head" aria-expanded={isOpen} onclick={toggle}>
      {#if running}<span class="sr-only">running</span>{/if}
      <span class="lbl" use:morphText={shownKey}>
        {#if head}
          {#if head.runningLabel}
            <span class="t trunc cl-shine">{head.runningLabel}</span>
          {:else}
            <span class="t nowrap cl-shine">{head.runningVerb}</span>
            {#if head.meta}<span class="t trunc">{head.meta}</span>{/if}
          {/if}
        {:else}
          <span class="t trunc">{#each summary as s, i}{#if i > 0}{', '}{/if}<span class:danger={s.isError}>{i === 0 ? cap(s.verb) : s.verb}</span>{#if s.meta}{' ' + s.meta}{/if}{/each}</span>
        {/if}
      </span>
      <span class="ic caret" aria-hidden="true">{glyph(isOpen ? 'CaretDown' : 'CaretRight')}</span>
    </button>
    {#if mounted}
      <div class="body" hidden={!isOpen}>
        <div class="card">
          {#each runs as run (runId(run))}
            <div class="item">{@render runView(run, true)}</div>
          {/each}
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  /* ============ 全局注入（ToolRow / AgentRow / WorkflowCard 共用，只在这里写一次）============
     文字流光 = 官方 epitaxy-text-shine 原文（workflow-panel.md §6）：文字本色打底、一道白色
     高光从右往左扫过、3s 一循环。bridge 暗色是默认（html 无 data-theme=light）：底 白 70% /
     高光 白；亮色：底 currentColor / 高光 currentColor 混 70% 白（color-mix 不支持的老内核退到
     近似灰）。reduced-motion：停在 50% 位置不动。 */
  @keyframes -global-cl-text-shine {
    0%, 22% { background-position: 150% 0; animation-timing-function: cubic-bezier(.5, .05, .45, .95); }
    76%, 100% { background-position: -50% 0; }
  }
  :global(.cl-shine) {
    color: var(--text);
    background-image: linear-gradient(120deg, rgba(255, 255, 255, .7) 25%, #fff 50%, rgba(255, 255, 255, .7) 75%);
    background-position: 150% 0; background-size: 200% 100%;
    -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent;
    animation: cl-text-shine 3s infinite;
  }
  :global(html[data-theme="light"] .cl-shine) {
    background-image: linear-gradient(120deg, currentColor 25%, #b5b5b3 50%, currentColor 75%);
    background-image: linear-gradient(120deg, currentColor 25%, color-mix(in srgb, currentColor 30%, white) 50%, currentColor 75%);
  }
  @media (prefers-reduced-motion: reduce) {
    :global(.cl-shine) { background-position: 50% 0; animation: none; }
  }

  /* ============ 分组本体 ============ */
  .grp { display: flex; flex-direction: column; width: 100%; min-width: 0; margin: 6px 0; }
  /* 折叠头（官方 lj button）：gap 2px、圆角 4px、secondary 字色，hover 整体转 primary */
  .head {
    appearance: none; background: none; border: 0; margin: 0; padding: 0; font: inherit; color: var(--serif);
    position: relative; display: flex; align-self: flex-start; max-width: 100%; min-width: 0; align-items: center; gap: 2px;
    text-align: left; cursor: pointer; border-radius: 4px; outline: none; -webkit-tap-highlight-color: transparent;
    transition: color var(--mo-micro, 140ms);
  }
  .head:focus-visible { box-shadow: 0 0 0 1px var(--serif); }
  @media (hover: hover) { .head:hover { color: var(--text); } }
  .lbl { display: inline-flex; align-items: center; gap: 4px; min-width: 0; }
  .t { font-size: 14px; line-height: 20px; }
  .trunc { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .nowrap { flex: none; white-space: nowrap; }
  .danger { color: var(--crit); }
  /* 展开箭头（官方 My customSize 14）：字体图标，可变字重 570 ≈ 14px 下的描边粗细 */
  .caret {
    flex: none; width: 1em; height: 1em; font-size: 14px; font-weight: 570;
    display: flex; align-items: center; justify-content: center; font-feature-settings: "liga" 0;
  }
  .body[hidden] { display: none; }
  /* 展开卡：描边 1px、r8、overflow clip、上边距 8px；子项 padding 8px 10px、之间 1px 分隔 */
  .card { display: flex; flex-direction: column; margin-top: 8px; border-radius: 8px; box-shadow: 0 0 0 1px var(--divider); overflow: hidden; overflow: clip; }
  .item { padding: 8px 10px; min-width: 0; }
  .item + .item { border-top: 1px solid var(--divider); }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
