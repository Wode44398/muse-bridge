<script>
  // 官方 /code 页 Agent 工具卡（c360a9e1c OF 的 Agent/Task 分支，规格 agent-tool-card.md
  // §2.1–§2.4）：两个形态。
  //   A「任务卡」：Agent 刚起步——还没有任何子 agent 活动（task.entries / toolCount 都空）、且
  //     不在分组内 → 318px 圆角卡：AgentsSimple 图标 + description（流光）+ CaretRight；hover 底
  //     --hover、按下底面 scale(.99) 弹簧回弹（只有底面缩，文字不动，官方同款）。
  //   B「文本行」：其余全部——"Running agent · Opus 4.6 · Read · 12"（模型短名 / 最近工具 /
  //     工具计数）；完成后 "Ran agent {desc}" 或 description 的变位句 "Explored codebase"；失败
  //     "Failed to explore codebase"（红）；任务 stopped → 尾巴 Stopped；后台 agent 在任务确认
  //     completed 前不用过去式变位（官方 doneLabelNeedsBackgroundConfirmation）。
  //   两个形态点击都 onOpen(tool)（缺省 openTaskDetail：在右侧工作台的「任务」视图里压上子转录面板）；
  //   Agent 行没有行内展开体（官方同款，参数在面板里看）。
  // 官方 pending 在 SDK 语义上不存在（tool_use 一出现就 running）——卡 = running 且无子活动。
  import { untrack } from 'svelte';
  import { openTaskDetail } from '../../lib/dock.svelte.js';
  import { toolVerb, mcpDisplayName, parseModel, morphText } from '../../lib/toolVerbs.js';
  import { taskRunning } from '../../lib/taskModel.js';
  import { glyph, iconSvg } from '../../lib/claudeIcons.js';

  let { tool, inGroup = false, live = false, onOpen = undefined } = $props();
  function open() { if (onOpen) onOpen(tool); else openTaskDetail(tool); }
  function onKey(e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } }

  const d = $derived(toolVerb(tool));
  const task = $derived(tool.task || null);
  const F = $derived(tool.status);                                  // running | done | error
  const U = $derived(F !== 'running' && task ? task.status : undefined);   // 结果已回 → 看任务态
  const H = $derived(!!live && (F === 'running' || taskRunning(U)));       // 逻辑上在跑
  // 官方 Wh(…, 650)：运行态切换稳定 650ms 后才落到显示；首帧取当前值
  let V = $state(untrack(() => H));
  $effect(() => {
    const v = H;
    if (v === V) return;
    const timer = setTimeout(() => { V = v; }, 650);
    return () => clearTimeout(timer);
  });

  const interrupted = $derived(!!tool.interrupted);
  const rejected = $derived(!!(tool.rejected || tool.denied));
  const stopped = $derived(U === 'stopped');
  const B = $derived(F === 'error' || U === 'failed' || stopped);
  const le = $derived((F === 'error' || U === 'failed') && !interrupted && !rejected);
  const de = $derived(!d.doneLabelNeedsBackgroundConfirmation || U === 'completed');
  // 整句标签优先（官方 ce）：running → "Exploring codebase"；失败 → "Failed to explore codebase"；
  // 完成 → "Explored codebase"；description 不是动词开头 → 退回 "Running agent"/"Ran agent" + meta
  const ce = $derived(stopped ? undefined : V ? d.runningLabel : B ? (le ? d.failedLabel : undefined) : de ? d.doneLabel : undefined);
  const ue = $derived(B && !stopped && le ? d.failedVerb : undefined);
  const verbText = $derived(ce ?? (V ? d.runningVerb : (ue ?? d.verb)));
  const showMeta = $derived(!!d.meta && !ce);
  const danger = $derived(!V && B && !stopped && !interrupted && !rejected);
  const tail = $derived(V || (!stopped && !interrupted)
    ? (!V && rejected ? 'Denied' : (!V && B && !ce && !ue ? 'Failed' : ''))
    : 'Stopped');

  // 子 agent 活动（官方 subagentActivity，只在逻辑运行中显示）：最近工具名 + 工具计数
  const activity = $derived(H && task && task.toolCount > 0 ? { latestToolName: task.latestToolName || '', toolCount: task.toolCount } : null);
  const started = $derived(!!task && (task.toolCount > 0 || (Array.isArray(task.entries) && task.entries.length > 0)));
  // 模型短名（官方 te：子 agent 帧的 message.model / 历史 resolvedModel），有就一直显示
  const modelName = $derived.by(() => { const p = task && task.model ? parseModel(task.model) : null; return p ? p.base : ''; });
  const metaIsLink = $derived(/^https?:\/\//i.test(String(d.meta || '')));
  // 形态 A 判定（官方 pe）：非分组、显示为运行中、无子活动、有 description 且不是链接/代码
  const card = $derived(!inGroup && V && !started && !!d.meta && !metaIsLink && !d.metaIsCode && !d.metaIsPath);
</script>

{#if card}
  <div class="wrap cardwrap">
    <div class="card" role="button" tabindex="0" onclick={open} onkeydown={onKey}>
      <span class="surface" aria-hidden="true"></span>
      <!-- AgentsSimple 用 SVG 后备：bridge 那份 Anthropicons 字体没有 U+E11C（canvas 墨水探针=0，
           caret/Check/Warning 等码位都有），字体字形会渲染成一片空白 -->
      <span class="ico" aria-hidden="true">{@html iconSvg('AgentsSimple', 16)}</span>
      <span class="ttl trunc" class:cl-shine={H} class:t7={!H}>{d.meta}</span>
      <span class="ic caret" aria-hidden="true">{glyph('CaretRight')}</span>
    </div>
  </div>
{:else}
  <div class="wrap" class:ingroup={inGroup}>
    <div class="row" role="button" tabindex="0" onclick={open} onkeydown={onKey}>
      <span class="verb" class:cl-shine={V} class:danger={danger} class:trunc={!!ce} class:nowrap={!ce} use:morphText={verbText}>{verbText}</span>
      {#if modelName}<span class="model nowrap">{modelName}</span>{/if}
      {#if activity}
        <span class="act trunc">{modelName ? '· ' : ''}{mcpDisplayName(activity.latestToolName)} · {activity.toolCount}</span>
      {:else if showMeta}
        <span class="meta trunc">{d.meta}</span>
      {/if}
      {#if tail}<span class="tail" class:danger={tail === 'Failed'}>{tail}</span>{/if}
      {#if H}<span class="sr-only">running</span>{/if}
      {#if !V}<span class="ic caret" aria-hidden="true">{glyph('CaretRight')}</span>{/if}
    </div>
  </div>
{/if}

<style>
  /* 令牌只挂在组件根上（嵌入宿主 bundle 的子应用 CSS 禁裸 :root）：--t7 = 墨色 70/80% */
  .wrap { --cl-t7: rgba(255, 255, 255, .7); display: flex; flex-direction: column; width: 100%; min-width: 0; margin: 4px 0; }
  :global(html[data-theme="light"]) .wrap { --cl-t7: rgba(0, 0, 0, .8); }
  .wrap.ingroup { margin: 0; }
  .wrap.cardwrap { margin: 6px 0; }

  /* —— 形态 A：任务卡（官方 Iy + Cy + ky）：318px、r8、padding 6/4/6/10、gap 6 —— */
  .card {
    position: relative; isolation: isolate; display: flex; align-self: flex-start; align-items: center; gap: 6px;
    width: 318px; max-width: 100%; box-sizing: border-box; padding: 6px 4px 6px 10px; border-radius: 8px;
    text-align: left; cursor: pointer; outline: none; font-size: 14px; line-height: 20px; -webkit-tap-highlight-color: transparent;
  }
  .card:focus-visible { box-shadow: 0 0 0 1px var(--serif); }
  /* 底面层：1px 描边 + hover 底色 + 按下 scale(.99)、松手 .45s 弹簧（官方 --btn-spring 原曲线，
     不支持 linear() 的内核退到 settle 曲线）；只有底面缩，文字不动 */
  .surface {
    position: absolute; inset: 0; z-index: -1; border-radius: inherit; box-shadow: 0 0 0 1px var(--divider);
    transform-origin: 50% 50%;
    transition: transform .45s cubic-bezier(.34, 1.26, .5, 1);
    transition: transform .45s linear(0, .2459, .6526, .9468, 1.0764, 1.0915, 1.0585, 1.0219, .9993, .9914, .9921, .9957, .9988, 1.0004, 1);
  }
  @media (hover: hover) { .card:hover .surface { background: var(--hover); } }
  .card:active .surface { transform: scale(.99); transition: transform 60ms ease-out; }
  .ico { flex: none; width: 16px; height: 16px; color: var(--muted); display: flex; align-items: center; justify-content: center; }
  .ico :global(svg) { display: block; width: 16px; height: 16px; }
  .ttl { min-width: 0; flex: 1; }
  .t7 { color: var(--cl-t7); }

  /* —— 形态 B：文本行（官方 OF）：gap 3px、r4、secondary 字色，hover 整体转 primary —— */
  .row {
    position: relative; display: flex; align-self: flex-start; max-width: 100%; min-width: 0; align-items: center; gap: 3px;
    padding: 0; text-align: left; border-radius: 4px; outline: none; cursor: pointer; color: var(--serif); font-size: 14px; line-height: 20px;
    -webkit-tap-highlight-color: transparent; transition: color var(--mo-micro, 140ms);
  }
  .row:focus-visible { box-shadow: 0 0 0 1px var(--serif); }
  @media (hover: hover) { .row:hover { color: var(--text); } }
  .trunc { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .nowrap { flex: none; white-space: nowrap; }
  .danger { color: var(--crit); }
  .model, .act, .meta { color: inherit; }
  .tail { flex: none; }
  /* 右侧 CaretRight（官方 Sy center，muted）：可点开子转录；运行中不画 */
  .caret { flex: none; width: 1em; height: 1em; font-size: 16px; font-weight: 533; color: var(--muted); display: flex; align-items: center; justify-content: center; font-feature-settings: "liga" 0; }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
</style>
