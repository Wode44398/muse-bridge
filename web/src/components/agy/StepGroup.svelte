<script>
  // 步骤段（11-18 第三轮）：一段连续的思考 / 工具调用。
  //   · 只有 1 步 → 直接渲染那一行；
  //   · 2 步以上 → 折成一行汇总头（照 Claude 分页 ToolGroup）：在跑时显示当前那一步（650ms 防抖免得连珠炮抖动），
  //     跑完换成「执行 5 条命令，修改 4 个文件」汇总句 + ± 角标 + 步数，点开在卡片里看逐行明细。
  //   · 明细首次展开后保持挂载只切 hidden，行内展开态不会因收起丢失；活动面板定位到折叠里的工具时，
  //     scrollToAgyCard 发 agy-group-open 事件把组打开。
  import { untrack } from 'svelte';
  import { classifyToolKind } from '../../lib/agy/logic.js';
  import { agy } from '../../lib/agy/store.svelte.js';
  import { summarizeSteps, toolIsRunning } from '../../lib/agy/step-summary.js';
  import { t, tr } from '../../lib/i18n.js';
  import ToolCard from './ToolCard.svelte';
  import AgyRoll from './AgyRoll.svelte';

  // items: [{ bi, blk }]；msg：所属助手消息（取 toolsById / 流式状态）
  const { items, msg, sessionId = '' } = $props();

  const resolved = $derived(items.map((it) => ({
    ...it,
    tool: it.blk.type === 'tool' ? (msg.toolsById?.[it.blk.toolCallId] || it.blk.tool) : null,
  })));
  const streaming = $derived(msg.status === 'streaming');
  const lastBi = $derived(Array.isArray(msg.blocks) ? msg.blocks.length - 1 : -1);

  let expandedThinks = $state({});
  function thinkPeek(text = '') {
    const line = String(text || '').replace(/[#*_`>]+/g, ' ').replace(/\s+/g, ' ').trim();
    return line.length > 120 ? line.slice(0, 120) + '…' : line;
  }

  // —— 当前在跑的那一步：最后一个运行中的工具；没有就看是否停在一段还在流的思考上 ——
  const current = $derived.by(() => {
    if (!streaming) return null;
    for (let i = resolved.length - 1; i >= 0; i--) {
      const it = resolved[i];
      if (it.tool && toolIsRunning(it.tool)) return it;
    }
    const tail = resolved[resolved.length - 1];
    if (tail && tail.blk.type === 'thinking' && tail.bi === lastBi) return tail;
    return null;
  });
  const running = $derived(Boolean(current));
  const curKey = $derived(current ? String(current.bi) : 'settled');
  // 单步 → 折叠组是同一行换了身份（11-19）：本组件在只有一步时就已挂着、shownKey 一直跟着那一步，
  // 第二步到来时汇总头先接着显示上一行那一步，650ms 后再滚到当前步（AgyRoll），而不是整行一帧换掉。
  let shownKey = $state(untrack(() => curKey));
  $effect(() => {
    const k = curKey;
    if (k === shownKey) return;
    const timer = setTimeout(() => { shownKey = k; }, 650);
    return () => clearTimeout(timer);
  });
  const shown = $derived(shownKey === 'settled' ? null : (resolved.find((it) => String(it.bi) === shownKey) || null));
  const shownHead = $derived.by(() => {
    if (!shown) return null;
    if (shown.blk.type === 'thinking') return { verb: t('思考中'), sum: thinkPeek(shown.blk.text) };
    const meta = classifyToolKind(shown.tool, { sessionCwd: agy.cwd });
    return { verb: meta.verb, sum: tr(meta.summary) };
  });

  const toolIds = $derived(resolved.filter((it) => it.blk.type === 'tool').map((it) => it.blk.toolCallId || it.tool?.toolCallId).filter(Boolean).join(' '));
  const summary = $derived(summarizeSteps(resolved, { sessionCwd: agy.cwd }));
  const anyFailed = $derived(summary.pieces.some((p) => p.isError));

  let open = $state(false);
  let mounted = $state(false);
  // 明细高度展开 / 收起（grid 0fr ⇄ 1fr）：首次展开先按收起态挂上，下一帧再展开，过渡才演得出来
  let expanded = $state(false);
  $effect(() => {
    if (!open) { expanded = false; return; }
    if (!mounted) mounted = true;
    let r2 = 0;
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => { expanded = true; }); });
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2); };
  });
  let groupEl = $state(null);
  $effect(() => {
    const el = groupEl;
    if (!el) return;
    const onOpen = () => { open = true; mounted = true; };
    el.addEventListener('agy-group-open', onOpen);
    return () => el.removeEventListener('agy-group-open', onOpen);
  });
</script>

{#snippet stepRow(it)}
  {#if it.blk.type === 'thinking'}
    {@const liveThink = streaming && it.bi === lastBi}
    {@const isOpen = Boolean(expandedThinks[it.bi])}
    <div class="agy-think" class:agy-grow={streaming} class:live={liveThink} class:open={isOpen}>
      <button
        type="button"
        class="agy-think-head"
        onclick={() => { expandedThinks[it.bi] = !expandedThinks[it.bi]; }}
        aria-expanded={isOpen}
      >
        <span class="msr think-ico">lightbulb</span>
        <span class="think-lbl" class:agy-shine={liveThink}>{liveThink ? t('思考中') : t('思考')}</span>
        {#if !isOpen}
          <span class="think-peek">{thinkPeek(it.blk.text)}</span>
        {/if}
        <span class="msr think-chev">{isOpen ? 'expand_less' : 'expand_more'}</span>
      </button>
      {#if isOpen}
        <div class="agy-think-body sel-text">{it.blk.text}</div>
      {/if}
    </div>
  {:else if it.tool}
    <div class="agy-step-slot" class:agy-grow={streaming}><ToolCard tool={it.tool} {sessionId} /></div>
  {/if}
{/snippet}

{#if resolved.length === 1}
  <div class="agy-steps">{@render stepRow(resolved[0])}</div>
{:else if resolved.length > 1}
  <div
    class="agy-sgroup"
    class:open
    class:running
    bind:this={groupEl}
    data-agy-group
    data-agy-group-tools={toolIds}
    data-open={open ? '1' : '0'}
  >
    <button type="button" class="agy-sg-head" aria-expanded={open} onclick={() => { open = !open; }}>
      <span class="sg-ico" aria-hidden="true">
        {#if running}
          <span class="agy-spin"></span>
        {:else if anyFailed}
          <span class="msr4 err">error</span>
        {:else}
          <span class="msr4">checklist</span>
        {/if}
      </span>
      <!-- 当前步 / 汇总句在同一个滚动位里换场：每换一步向上滚一格，跑完滚成汇总句 -->
      <AgyRoll key={shownHead ? 'c:' + shownKey : 'sum'} class="sg-roll">
        {#if shownHead}
          <span class="sg-verb agy-shine">{shownHead.verb}</span>
          {#if shownHead.sum}<span class="sg-cur">{shownHead.sum}</span>{/if}
        {:else}
          <span class="sg-sum">
            {#each summary.pieces as p, i (i)}{#if i > 0}<span class="sep">{t('，')}</span>{/if}<span class:err={p.isError}>{p.text}</span>{/each}
          </span>
        {/if}
      </AgyRoll>
      <span class="sg-trail">
        {#if !shownHead && (summary.added > 0 || summary.removed > 0)}
          <span class="sg-diff">
            {#if summary.added > 0}<b class="add">+{summary.added}</b>{/if}
            {#if summary.removed > 0}<b class="del">-{summary.removed}</b>{/if}
          </span>
        {/if}
        <span class="sg-count">{t('{n} 步', { n: resolved.length })}</span>
        <span class="msr sg-chev" aria-hidden="true">expand_more</span>
      </span>
    </button>
    {#if mounted}
      <div class="agy-sg-fold" class:expanded inert={!open}>
        <div class="agy-sg-clip">
          <div class="agy-sg-body">
            <div class="agy-steps in-card">
              {#each resolved as it (it.bi)}
                {@render stepRow(it)}
              {/each}
            </div>
          </div>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .agy-steps {
    display: flex;
    flex-direction: column;
    gap: 1px;
    margin: 0 -8px;
  }
  .agy-steps.in-card { margin: 0; padding: 4px; }

  /* —— 折叠汇总头：和单行步骤同高同排版，右侧步数 + 箭头 —— */
  .agy-sgroup { display: flex; flex-direction: column; margin: 0 -8px; min-width: 0; }
  .agy-sg-head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 8px;
    border-radius: 8px;
    text-align: left;
    font-size: 13px;
    color: var(--ag-on-sub);
    min-width: 0;
    transition: background-color var(--ag-dur-quick, 120ms) var(--ag-ease-std, ease);
  }
  .agy-sg-head:hover { background: var(--ag-hover); color: var(--ag-on); }
  .sg-ico {
    width: 18px;
    height: 18px;
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-faint);
  }
  .sg-ico .msr4 { font-size: 16px; }
  .sg-ico .err { color: var(--ag-err); }
  .agy-sg-head :global(.sg-roll) { flex: 1 1 auto; gap: 8px; }
  .agy-sg-head :global(.sg-roll > .agy-roll-item) { align-items: center; gap: 8px; }
  .sg-verb { flex: none; font-weight: 500; }
  .sg-cur {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--ag-mono);
    font-size: 12px;
    color: var(--ag-on-faint);
  }
  .sg-sum {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 500;
  }
  .sg-sum .sep { font-weight: 400; color: var(--ag-on-faint); }
  .sg-sum .err { color: var(--ag-err); }
  .sg-trail {
    margin-left: auto;
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 8px;
  }
  .sg-diff { display: inline-flex; gap: 6px; font-family: var(--ag-mono); font-size: 11.5px; }
  .sg-diff b { font-weight: 500; }
  .sg-diff .add { color: var(--ag-ok); }
  .sg-diff .del { color: var(--ag-err); }
  .sg-count {
    font-size: 11.5px;
    color: var(--ag-on-faint);
    font-variant-numeric: tabular-nums;
  }
  .sg-chev {
    font-size: 16px;
    color: var(--ag-on-faint);
    transform: rotate(-90deg);
    transition: transform var(--ag-dur-quick, 160ms) var(--ag-ease-std, ease);
  }
  .agy-sgroup.open .sg-chev { transform: none; }

  /* 明细展开：grid 行高 0fr ⇄ 1fr（M3 emphasized，0.42s），内容随之淡入；收起后 visibility 关掉，不占焦点 */
  .agy-sg-fold {
    display: grid;
    grid-template-rows: 0fr;
    visibility: hidden;
    transition: grid-template-rows 0.34s cubic-bezier(0.3, 0, 0.8, 0.15), visibility 0s linear 0.34s;
  }
  .agy-sg-fold.expanded {
    grid-template-rows: 1fr;
    visibility: visible;
    transition: grid-template-rows 0.46s cubic-bezier(0.05, 0.7, 0.1, 1), visibility 0s;
  }
  .agy-sg-clip { min-height: 0; overflow: hidden; }
  .agy-sg-body {
    opacity: 0;
    transform: translateY(-4px);
    transition: opacity 0.16s cubic-bezier(0.3, 0, 0.8, 0.15), transform 0.34s cubic-bezier(0.3, 0, 0.8, 0.15);
  }
  .agy-sg-fold.expanded .agy-sg-body {
    opacity: 1;
    transform: none;
    transition: opacity 0.3s cubic-bezier(0.2, 0, 0, 1) 0.06s, transform 0.46s cubic-bezier(0.05, 0.7, 0.1, 1);
  }
  @media (prefers-reduced-motion: reduce) {
    .agy-sg-fold, .agy-sg-fold.expanded, .agy-sg-body, .agy-sg-fold.expanded .agy-sg-body { transition: none; }
  }
  .agy-sg-body {
    margin: 4px 0 6px;
    border-radius: 10px;
    border: 1px solid var(--ag-divider);
    overflow: hidden;
    overflow: clip;
  }

  .agy-spin {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    border: 1.6px solid var(--ag-border-strong);
    border-top-color: var(--ag-accent);
    animation: agy-sg-spin 0.8s linear infinite;
  }
  @keyframes agy-sg-spin { to { transform: rotate(360deg); } }

  /* —— 思考行（原在 Message 里，随步骤段一起搬来） —— */
  .agy-think-head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 8px;
    height: 30px;
    padding: 0 8px;
    border-radius: 8px;
    color: var(--ag-on-dim);
    font-size: 13px;
    text-align: left;
    min-width: 0;
  }
  .agy-think-head:hover { background: var(--ag-hover); color: var(--ag-on-sub); }
  .think-ico { font-size: 16px; width: 18px; color: var(--ag-on-faint); }
  .think-lbl { flex: none; font-weight: 500; }
  .think-peek {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--ag-on-faint);
  }
  .think-chev {
    margin-left: auto;
    font-size: 16px;
    color: var(--ag-on-faint);
    opacity: 0;
  }
  .agy-think-head:hover .think-chev,
  .agy-think.open .think-chev { opacity: 1; }
  .agy-think-body {
    margin: 2px 8px 8px 17px;
    padding: 2px 0 2px 16px;
    border-left: 1px solid var(--ag-divider);
    color: var(--ag-on-dim);
    font-size: 13px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 360px;
    overflow-y: auto;
  }
</style>
