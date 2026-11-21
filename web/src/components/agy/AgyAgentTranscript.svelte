<script>
  // Antigravity 子代理完整对话与执行转录面板（对标 Claude AgentTranscript，原生适配 --ag-* 令牌）：
  // 顶部直出运行状态、模型名称、思考强度（effort）、token 明细、工具调用数与耗时；
  // 下方完整展示任务提示词（折叠+复制）、派出的下级代理表（可继续下钻）与按时间线排列的对话记录
  // （收到消息、思考、可展开参数/输出/报错的工具调用、正文回复与错误框），活跃态按字节 offset 增量轮询。
  import { untrack, tick } from 'svelte';
  import { pushAgyAgentTranscript } from '../../lib/dock.svelte.js';
  import { agy } from '../../lib/agy/store.svelte.js';
  import { agyApi } from '../../lib/agy/api.js';
  import { classifyToolKind } from '../../lib/agy/logic.js';
  import { renderMarkdown } from '../../lib/md.js';
  import { onMdClick } from '../../lib/linkNav.js';
  import { fmtElapsed } from '../../lib/format.js';
  import {
    agySubagents,
    findSubagentInStore,
    agentModelInfo,
    fmtCompactTokens as fmtTokens,
    subagentStatusLabel,
    mergeSubagentEntries,
  } from '../../lib/agy/subagents.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  const { agentId = '' } = $props();

  const POLL_MS = 2000;
  const INITIAL_VISIBLE = 60;
  const EMPTY = { key: '', state: 'idle', entries: [], prompt: '', model: '', modelBase: '', effort: '', offset: 0, agent: null };

  let fetched = $state(EMPTY);
  let reqSeq = 0;
  let inflight = false;
  let entryLimit = $state(INITIAL_VISIBLE);

  const storeNode = $derived(findSubagentInStore(agentId));
  const agent = $derived(fetched.agent || storeNode);
  const status = $derived(storeNode?.status || agent?.status || 'done');
  const active = $derived(status === 'running' || status === 'waiting');
  const fkey = $derived(agentId && agy.sessionId ? `${agy.sessionId}:${agentId}` : '');

  async function load(key, sid, aid) {
    if (inflight) return;
    const cur = untrack(() => fetched);
    const inc = cur.key === key && cur.state === 'ok' && cur.offset > 0;
    const seq = ++reqSeq;
    inflight = true;
    try {
      const r = await agyApi.subagentTranscript(sid, aid, inc ? cur.offset : 0);
      if (seq !== reqSeq) return;
      const offset = Number(r?.offset) || 0;
      if (inc && r?.delta) {
        const more = Array.isArray(r.entries) ? r.entries : [];
        fetched = {
          ...cur,
          entries: more.length ? mergeSubagentEntries(cur.entries, more) : cur.entries,
          model: cur.model || r.model || '',
          modelBase: cur.modelBase || r.modelBase || '',
          effort: cur.effort || r.effort || '',
          agent: r.agent || cur.agent,
          offset,
        };
        return;
      }
      fetched = {
        key,
        state: 'ok',
        entries: Array.isArray(r?.entries) ? r.entries : [],
        prompt: String(r?.prompt || ''),
        model: String(r?.model || ''),
        modelBase: String(r?.modelBase || ''),
        effort: String(r?.effort || ''),
        agent: r?.agent || null,
        offset,
      };
    } catch (err) {
      if (seq !== reqSeq) return;
      if (cur.key === key && cur.state === 'ok') return;
      fetched = { ...EMPTY, key, state: err?.status === 404 ? 'none' : 'error' };
    } finally {
      if (seq === reqSeq) inflight = false;
    }
  }

  $effect(() => {
    const key = fkey;
    const sid = agy.sessionId;
    const aid = agentId;
    const shouldPoll = active;
    if (!key || !sid || !aid) return;
    if (untrack(() => fetched.key) !== key) {
      reqSeq++;
      inflight = false;
      entryLimit = INITIAL_VISIBLE;
      fetched = { ...EMPTY, key, state: 'loading' };
    }
    untrack(() => load(key, sid, aid));
    if (!shouldPoll) return;
    const isVisible = () => typeof document === 'undefined' || !document.hidden;
    const tid = setInterval(() => { if (isVisible()) untrack(() => load(key, sid, aid)); }, POLL_MS);
    const onVis = () => { if (isVisible()) untrack(() => load(key, sid, aid)); };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(tid);
      document.removeEventListener('visibilitychange', onVis);
    };
  });

  const fx = $derived(fkey && fetched.key === fkey ? fetched : null);
  const allEntries = $derived(fx?.state === 'ok' ? fx.entries : []);
  const hiddenCount = $derived(Math.max(0, allEntries.length - entryLimit));
  const entries = $derived(hiddenCount > 0 ? allEntries.slice(hiddenCount) : allEntries);
  const prompt = $derived(fx?.prompt || storeNode?.promptPreview || '');
  const modelInfo = $derived(agentModelInfo({
    model: agent?.model || fx?.model || '',
    modelBase: agent?.modelBase || fx?.modelBase || '',
    effort: agent?.effort || fx?.effort || '',
  }));
  const children = $derived(Array.isArray(agent?.children) && agent.children.length ? agent.children : (storeNode?.children || []));

  // 提示词折叠与复制
  let promptOpen = $state(false);
  let promptEl = $state(null);
  let promptOverflow = $state(false);
  let copied = $state(false);

  $effect(() => {
    void prompt;
    const el = promptEl;
    const isOpen = promptOpen;
    if (!el) return;
    const measure = () => { promptOverflow = isOpen || el.scrollHeight > el.clientHeight + 2; };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });

  async function copyPrompt() {
    if (!prompt) return;
    try { await navigator.clipboard.writeText(prompt); } catch {
      const ta = document.createElement('textarea');
      ta.value = prompt;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }
    copied = true;
    setTimeout(() => { copied = false; }, 1400);
  }

  let openTools = $state({});
  let openThinks = $state({});
  let openMsgs = $state({});
  $effect(() => { void agentId; openTools = {}; openThinks = {}; openMsgs = {}; promptOpen = false; });

  function toggleTool(key) { openTools[key] = !openTools[key]; }
  function toggleThink(idx) { openThinks[idx] = !openThinks[idx]; }
  function toggleMsg(idx) { openMsgs[idx] = !openMsgs[idx]; }

  function argsPreview(args) {
    if (!args || typeof args !== 'object') return '';
    const clean = { ...args };
    delete clean.toolSummary;
    if (!Object.keys(clean).length) return '';
    try { return JSON.stringify(clean, null, 2); } catch { return ''; }
  }

  function thinkPeek(txt = '') {
    const clean = String(txt || '').replace(/[#*_`>]+/g, ' ').replace(/\s+/g, ' ').trim();
    return clean.length > 100 ? clean.slice(0, 100) + '…' : clean;
  }

  // 运行中贴底跟随
  let rootEl = $state(null);
  let stick = false;
  const scroller = () => (rootEl ? rootEl.closest('.ag-ap-scroll') : null);
  $effect.pre(() => {
    void allEntries.length;
    const sc = untrack(scroller);
    stick = !!sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 48;
  });
  $effect(() => {
    void allEntries.length;
    if (!untrack(() => active) || !stick) return;
    tick().then(() => { const sc = scroller(); if (sc) sc.scrollTop = sc.scrollHeight; });
  });

  // 实时计时
  let now = $state(Date.now());
  $effect(() => {
    if (!active) return;
    now = Date.now();
    const timer = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) now = Date.now();
    }, 1000);
    return () => clearInterval(timer);
  });

  const timeText = $derived.by(() => {
    if (!agent) return '';
    if (active && agent.spawnedAt > 0) return fmtElapsed(Math.max(0, now - agent.spawnedAt));
    if (agent.durationMs > 0) return fmtElapsed(agent.durationMs);
    return '';
  });

  const tokenTip = $derived(
    agent?.tokens?.total > 0
      ? t('输入 {input} · 缓存 {cache} · 输出 {output}', {
        input: fmtTokens(agent.tokens.input || 0),
        cache: fmtTokens(agent.tokens.cacheRead || 0),
        output: fmtTokens(agent.tokens.output || 0),
      })
      : ''
  );

  const footerMeta = $derived.by(() => {
    const parts = [subagentStatusLabel(status)];
    const totalTok = agent?.tokens?.total || 0;
    if (totalTok > 0) parts.push(`${fmtTokens(totalTok)} tokens`);
    const calls = agent?.toolCallsCount || 0;
    if (calls > 0) parts.push(t('{n} 次工具调用', { n: calls }));
    if (timeText) parts.push(timeText);
    return parts.join(' · ');
  });

  const liveLine = $derived.by(() => {
    if (status === 'waiting') return t('等待下级子代理回报…');
    if (agent?.lastTool?.name) {
      const meta = classifyToolKind({ name: agent.lastTool.name }, { sessionCwd: agy.cwd });
      return [meta.verb, agent.lastTool.summary].filter(Boolean).join(' · ');
    }
    return t('正在执行…');
  });
</script>

<div class="ag-tr" bind:this={rootEl}>
  <!-- 顶部状态与模型 / Effort 概览条 -->
  <section class="tr-meta-bar">
    <div class="tr-meta-top">
      <span class="tr-status-pill {status}">
        {#if status === 'running'}
          <span class="tr-pill-spin" aria-hidden="true"></span>
        {:else if status === 'waiting'}
          <span class="msr4" aria-hidden="true">schedule</span>
        {:else if status === 'error'}
          <span class="msr4" aria-hidden="true">error</span>
        {:else if status === 'killed'}
          <span class="msr4" aria-hidden="true">stop_circle</span>
        {:else}
          <span class="msr4" aria-hidden="true">check</span>
        {/if}
        <span>{subagentStatusLabel(status)}</span>
      </span>

      {#if modelInfo.modelName}
        <span class="tr-model-chip" title={modelInfo.raw}>
          <span class="tm-name">{modelInfo.modelName}</span>
          {#if modelInfo.effort}
            <span class="tm-eff" title={t('思考强度')}>{modelInfo.effort}</span>
          {/if}
        </span>
      {/if}
    </div>

    <div class="tr-meta-nums num">
      {#if agent?.tokens?.total > 0}
        <span title={tokenTip}>{fmtTokens(agent.tokens.total)} tokens</span>
      {/if}
      {#if agent?.toolCallsCount > 0}
        <span>{t('{n} 次工具调用', { n: agent.toolCallsCount })}</span>
      {/if}
      {#if timeText}
        <span>{timeText}</span>
      {/if}
    </div>
  </section>

  {#if prompt}
    <section class="pv" aria-label={t('任务提示词')}>
      <div class="pv-head">
        <span class="pv-lbl">{t('任务提示词')}</span>
        <span class="pv-len num">{t('{n} 字', { n: prompt.length })}</span>
        <button
          type="button"
          class="pv-btn"
          onclick={copyPrompt}
          aria-label={copied ? t('已复制') : t('复制提示词')}
          title={copied ? t('已复制') : t('复制提示词')}
        >
          <span class="msr">{copied ? 'check' : 'content_copy'}</span>
        </button>
      </div>
      <div class="pv-body sel-text" class:clamped={!promptOpen} class:fade={!promptOpen && promptOverflow} bind:this={promptEl}>{prompt}</div>
      {#if promptOverflow}
        <button type="button" class="pv-more" aria-expanded={promptOpen} onclick={() => { promptOpen = !promptOpen; }}>
          <span class="msr">{promptOpen ? 'expand_less' : 'expand_more'}</span>
          <span>{promptOpen ? t('收起') : t('展开完整提示词')}</span>
        </button>
      {/if}
    </section>
  {/if}

  {#if children.length > 0}
    <section class="tr-children">
      <div class="tr-sec-h">{t('派出的下级代理（{n}）', { n: children.length })}</div>
      <div class="tr-child-list">
        {#each children as ch (ch.id)}
          {@const chModel = agentModelInfo(ch)}
          <button type="button" class="tr-child-chip" onclick={() => pushAgyAgentTranscript(ch.id)}>
            <span class="ch-dot {ch.status}" aria-hidden="true"></span>
            <span class="ch-main">
              <span class="ch-name trunc">{ch.role}</span>
              {#if chModel.modelName || ch.tokens?.total > 0}
                <span class="ch-sub num trunc">
                  {#if chModel.modelName}{chModel.modelName}{#if chModel.effort} · {chModel.effort}{/if}{/if}
                  {#if ch.tokens?.total > 0} · {fmtTokens(ch.tokens.total)}{/if}
                  {#if ch.durationMs > 0} · {fmtElapsed(ch.durationMs)}{/if}
                </span>
              {/if}
            </span>
            <span class="ch-st {ch.status}">{subagentStatusLabel(ch.status)}</span>
            <span class="msr ch-arr" aria-hidden="true">expand_more</span>
          </button>
        {/each}
      </div>
    </section>
  {/if}

  {#if hiddenCount > 0}
    <button type="button" class="tr-more-entries" onclick={() => { entryLimit += 80; }}>
      <span class="msr">expand_less</span>
      <span>{t('显示更早的 {n} 条记录', { n: hiddenCount })}</span>
    </button>
  {/if}

  {#each entries as en, idx (hiddenCount + idx)}
    {@const ei = hiddenCount + idx}
    {#if en.kind === 'thinking'}
      {@const isOpen = Boolean(openThinks[ei])}
      <div class="tr-think" class:open={isOpen}>
        <button type="button" class="tr-think-head" aria-expanded={isOpen} onclick={() => toggleThink(ei)}>
          <span class="msr">lightbulb</span>
          <span class="tk-lbl">{t('思考')}</span>
          {#if !isOpen}<span class="tk-peek trunc">{thinkPeek(en.text)}</span>{/if}
          <span class="msr tk-chev">{isOpen ? 'expand_less' : 'expand_more'}</span>
        </button>
        {#if isOpen}
          <div class="tr-think-body sel-text">{en.text}</div>
        {/if}
      </div>
    {:else if en.kind === 'tools'}
      <div class="tr-tools">
        {#each en.tools as tl, ti (tl.id || `${ei}-${ti}`)}
          {@const tkey = `${ei}:${ti}`}
          {@const meta = classifyToolKind({ name: tl.name, kind: tl.kind, args: tl.args }, { sessionCwd: agy.cwd })}
          {@const isOpen = Boolean(openTools[tkey])}
          {@const argsStr = argsPreview(tl.args)}
          {@const hasDetail = Boolean(argsStr || tl.output || tl.error)}
          {@const isRun = tl.status === 'in_progress'}
          {@const isErr = tl.status === 'failed' || tl.status === 'error'}
          <div class="tr-tool" class:open={isOpen} class:err={isErr}>
            <div class="tr-tool-row">
              <button
                type="button"
                class="tr-tool-head"
                disabled={!hasDetail}
                aria-expanded={hasDetail ? isOpen : undefined}
                onclick={() => hasDetail && toggleTool(tkey)}
              >
                <span class="tr-tool-ic" aria-hidden="true">
                  {#if isRun}
                    <span class="tr-mini-spin"></span>
                  {:else if isErr}
                    <span class="msr4 err">error</span>
                  {:else}
                    <span class="msr4">{meta.icon || 'build'}</span>
                  {/if}
                </span>
                <span class="tr-tool-verb">{meta.verb || tl.name}</span>
                {#if tl.summary || meta.summary}
                  <span class="tr-tool-sum trunc">{tl.summary || meta.summary}</span>
                {/if}
                {#if hasDetail}
                  <span class="msr tr-tool-chev" class:up={isOpen}>expand_more</span>
                {/if}
              </button>
              {#if tl.childAgentId}
                <button
                  type="button"
                  class="tr-jump-child"
                  onclick={() => pushAgyAgentTranscript(tl.childAgentId)}
                  title={t('查看该子代理的执行记录')}
                >
                  <span>{t('查看代理')}</span>
                  <span class="msr" aria-hidden="true">north_east</span>
                </button>
              {/if}
            </div>
            {#if isOpen && hasDetail}
              <div class="tr-tool-body sel-text">
                {#if argsStr}
                  <div class="tr-kv">
                    <span class="tr-kv-lbl">{t('参数')}</span>
                    <pre class="tr-pre">{argsStr}</pre>
                  </div>
                {/if}
                {#if tl.error}
                  <div class="tr-kv err">
                    <span class="tr-kv-lbl">{t('错误')}</span>
                    <pre class="tr-pre err">{tl.error}</pre>
                  </div>
                {/if}
                {#if tl.output}
                  <div class="tr-kv">
                    <span class="tr-kv-lbl">{t('输出')}</span>
                    <pre class="tr-pre">{tl.output}</pre>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {:else if en.kind === 'message'}
      {@const longMsg = (en.text || '').length > 260}
      {@const isOpen = !longMsg || Boolean(openMsgs[ei])}
      <div class="tr-msg">
        <div class="tr-msg-head">
          <span class="msr4" aria-hidden="true">north_east</span>
          <span class="tr-msg-from trunc">{t('收到来自 {sender} 的消息', { sender: en.senderRole || en.sender || t('系统') })}</span>
          {#if longMsg}
            <button type="button" class="tr-msg-toggle" onclick={() => toggleMsg(ei)}>
              {isOpen ? t('收起') : t('展开')}
            </button>
          {/if}
        </div>
        {#if isOpen}
          <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
          <div class="tr-msg-body tr-md sel-text" onclick={onMdClick}>{@html renderMarkdown(en.text)}</div>
        {:else}
          <div class="tr-msg-peek">{en.text.slice(0, 220)}…</div>
        {/if}
      </div>
    {:else if en.kind === 'error'}
      <div class="tr-err-box sel-text">
        <span class="msr4" aria-hidden="true">error</span>
        <span>{en.text}</span>
      </div>
    {:else if en.kind === 'text'}
      <!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
      <div class="tr-md sel-text" onclick={onMdClick}>{@html renderMarkdown(en.text)}</div>
    {/if}
  {/each}

  {#if active}
    <div class="tr-live" role="status">
      <span class="tr-live-spin" aria-hidden="true"></span>
      <span class="trunc">{liveLine}</span>
    </div>
  {:else if fx && fx.state === 'loading'}
    <div class="tr-note">{t('正在加载执行记录…')}</div>
  {:else if fx && fx.state === 'error'}
    <div class="tr-note err">{tr(t('读取执行记录失败'))}</div>
  {:else if !allEntries.length && !prompt}
    <div class="tr-note">{t('暂无执行记录')}</div>
  {/if}

  <p class="tr-foot num">
    {#if active}<span class="tr-sync-dot" title={t('实时同步中')}></span>{/if}
    <span>{footerMeta}</span>
  </p>
</div>

<style>
  .ag-tr {
    display: flex;
    flex-direction: column;
    gap: 10px;
    overflow-wrap: anywhere;
  }

  /* 顶部状态 + 模型 + Effort 概览卡片 */
  .tr-meta-bar {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 9px 11px;
    border-radius: 10px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
  }
  .tr-meta-top {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;
  }
  .tr-status-pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 8px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 500;
    background: var(--ag-surface-2);
    color: var(--ag-on-sub);
  }
  .tr-status-pill .msr4 { font-size: 14px; }
  .tr-status-pill.running {
    background: color-mix(in srgb, var(--ag-accent) 14%, transparent);
    color: var(--ag-accent);
  }
  .tr-status-pill.waiting {
    background: var(--ag-warn-bg);
    color: var(--ag-warn);
  }
  .tr-status-pill.done {
    background: color-mix(in srgb, var(--ag-ok) 13%, transparent);
    color: var(--ag-ok);
  }
  .tr-status-pill.error {
    background: var(--ag-err-bg);
    color: var(--ag-err);
  }
  .tr-pill-spin {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    border: 1.6px solid color-mix(in srgb, var(--ag-accent) 30%, transparent);
    border-top-color: var(--ag-accent);
    animation: agy-tr-spin 0.8s linear infinite;
  }

  .tr-model-chip {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 12px;
    color: var(--ag-on);
  }
  .tm-name { font-weight: 500; }
  .tm-eff {
    font-size: 11px;
    line-height: 16px;
    padding: 0 6px;
    border-radius: 999px;
    border: 1px solid var(--ag-border-strong);
    background: var(--ag-surface-2);
    color: var(--ag-on-sub);
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
  }
  .tr-meta-nums {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 12px;
    font-size: 11.5px;
    color: var(--ag-on-dim);
  }

  /* 提示词块 */
  .pv {
    display: flex;
    flex-direction: column;
    gap: 6px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
    border-radius: 11px;
    padding: 8px 11px 10px;
  }
  .pv-head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 22px;
    font-size: 12px;
    color: var(--ag-on-dim);
  }
  .pv-lbl { color: var(--ag-on-sub); font-weight: 500; }
  .pv-len { margin-left: auto; }
  .pv-btn {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-dim);
    flex: none;
  }
  .pv-btn:hover { background: var(--ag-hover); color: var(--ag-on); }
  .pv-btn .msr { font-size: 16px; }
  .pv-body {
    font-size: 13px;
    line-height: 1.55;
    color: var(--ag-on);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .pv-body.clamped {
    max-height: calc(1.55em * 8);
    overflow: hidden;
  }
  .pv-body.fade {
    -webkit-mask-image: linear-gradient(to bottom, #000 62%, transparent);
    mask-image: linear-gradient(to bottom, #000 62%, transparent);
  }
  .pv-more {
    align-self: flex-start;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 6px 2px 2px;
    border-radius: 6px;
    font-size: 12px;
    color: var(--ag-on-dim);
  }
  .pv-more:hover { background: var(--ag-hover); color: var(--ag-on); }
  .pv-more .msr { font-size: 16px; }

  /* 下级代理快捷钻取 */
  .tr-children { display: flex; flex-direction: column; gap: 6px; }
  .tr-sec-h { font-size: 12px; font-weight: 500; color: var(--ag-on-dim); }
  .tr-child-list { display: flex; flex-direction: column; gap: 5px; }
  .tr-child-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    border-radius: 9px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
    text-align: left;
    transition: background 0.14s ease, border-color 0.14s ease;
  }
  .tr-child-chip:hover {
    background: var(--ag-surface-2);
    border-color: var(--ag-border-strong);
  }
  .ch-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    flex: none;
    background: var(--ag-on-dim);
  }
  .ch-dot.running { background: var(--ag-accent); animation: agy-tr-pulse 1.4s ease-in-out infinite; }
  .ch-dot.waiting { background: var(--ag-warn); }
  .ch-dot.done { background: var(--ag-ok); }
  .ch-dot.error { background: var(--ag-err); }
  .ch-dot.killed { background: var(--ag-on-faint); }
  @keyframes agy-tr-pulse { 50% { opacity: 0.35; } }
  .ch-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .ch-name { font-size: 12.5px; color: var(--ag-on); font-weight: 500; }
  .ch-sub { font-size: 11px; color: var(--ag-on-dim); }
  .ch-st { flex: none; font-size: 11.5px; color: var(--ag-on-dim); }
  .ch-st.running { color: var(--ag-accent); }
  .ch-st.waiting { color: var(--ag-warn); }
  .ch-st.error { color: var(--ag-err); }
  .ch-arr { flex: none; font-size: 16px; color: var(--ag-on-faint); transform: rotate(-90deg); }

  /* 更早记录折叠按钮 */
  .tr-more-entries {
    align-self: center;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 12px;
    border-radius: 999px;
    border: 1px solid var(--ag-border-strong);
    background: var(--ag-surface-1);
    color: var(--ag-on-sub);
    font-size: 12px;
  }
  .tr-more-entries:hover { background: var(--ag-hover); color: var(--ag-on); }
  .tr-more-entries .msr { font-size: 16px; }

  /* 思考块 */
  .tr-think {
    border-radius: 9px;
    border: 1px solid var(--ag-border);
    background: var(--ag-surface-1);
    overflow: hidden;
  }
  .tr-think-head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 9px;
    font-size: 12px;
    color: var(--ag-on-dim);
    text-align: left;
  }
  .tr-think-head:hover { background: var(--ag-hover); color: var(--ag-on-sub); }
  .tr-think-head .msr { font-size: 16px; flex: none; }
  .tk-lbl { flex: none; font-weight: 500; }
  .tk-peek { flex: 1; min-width: 0; color: var(--ag-on-faint); }
  .tk-chev { margin-left: auto; }
  .tr-think-body {
    padding: 6px 10px 9px;
    border-top: 1px solid var(--ag-border);
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--ag-on-sub);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* 工具调用组 */
  .tr-tools {
    display: flex;
    flex-direction: column;
    border-radius: 9px;
    border: 1px solid var(--ag-border);
    background: var(--ag-surface-1);
    overflow: hidden;
  }
  .tr-tool + .tr-tool { border-top: 1px solid var(--ag-border); }
  .tr-tool-row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .tr-tool-head {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 9px;
    font-size: 12.5px;
    line-height: 18px;
    text-align: left;
    color: var(--ag-on);
  }
  .tr-tool-head:not(:disabled):hover { background: var(--ag-hover); }
  .tr-tool-head:disabled { cursor: default; }
  .tr-tool-ic {
    flex: none;
    width: 16px;
    height: 16px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-dim);
  }
  .tr-tool-ic .msr4 { font-size: 16px; }
  .tr-tool-ic .msr4.err { color: var(--ag-err); }
  .tr-tool-verb { flex: none; font-weight: 500; color: var(--ag-on-sub); }
  .tr-tool-sum {
    flex: 1;
    min-width: 0;
    color: var(--ag-on-dim);
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
    font-size: 11.5px;
  }
  .tr-tool-chev {
    flex: none;
    font-size: 16px;
    color: var(--ag-on-faint);
    transition: transform 0.16s ease;
  }
  .tr-tool-chev.up { transform: rotate(180deg); }
  .tr-jump-child {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    margin-right: 7px;
    padding: 2px 7px;
    border-radius: 6px;
    font-size: 11px;
    color: var(--ag-accent);
    background: color-mix(in srgb, var(--ag-accent) 12%, transparent);
  }
  .tr-jump-child:hover { background: color-mix(in srgb, var(--ag-accent) 20%, transparent); }
  .tr-jump-child .msr { font-size: 14px; }
  .tr-tool-body {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 10px 10px;
    border-top: 1px solid var(--ag-border);
    background: var(--ag-bg);
  }
  .tr-kv { display: flex; flex-direction: column; gap: 3px; }
  .tr-kv-lbl { font-size: 11px; color: var(--ag-on-faint); }
  .tr-kv.err .tr-kv-lbl { color: var(--ag-err); }
  .tr-pre {
    margin: 0;
    padding: 7px 9px;
    border-radius: 7px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
    font-family: ui-monospace, 'SF Mono', Consolas, monospace;
    font-size: 11.5px;
    line-height: 1.5;
    color: var(--ag-on-sub);
    white-space: pre-wrap;
    word-break: break-word;
    max-height: 220px;
    overflow: auto;
  }
  .tr-pre.err {
    color: var(--ag-err);
    border-color: color-mix(in srgb, var(--ag-err) 30%, var(--ag-border));
    background: var(--ag-err-bg);
  }

  /* 代理间收到消息 */
  .tr-msg {
    display: flex;
    flex-direction: column;
    gap: 5px;
    padding: 8px 10px;
    border-radius: 10px;
    background: var(--ag-surface-2);
    border: 1px solid var(--ag-border);
  }
  .tr-msg-head {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11.5px;
    color: var(--ag-on-dim);
  }
  .tr-msg-head .msr4 { font-size: 14px; flex: none; color: var(--ag-accent); }
  .tr-msg-from { flex: 1; min-width: 0; font-weight: 500; color: var(--ag-on-sub); }
  .tr-msg-toggle {
    flex: none;
    font-size: 11.5px;
    color: var(--ag-accent);
    padding: 1px 6px;
    border-radius: 5px;
  }
  .tr-msg-toggle:hover { background: var(--ag-hover); }
  .tr-msg-body { font-size: 13px; }
  .tr-msg-peek {
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--ag-on-dim);
    white-space: pre-wrap;
    word-break: break-word;
  }

  /* 正文 Markdown */
  .tr-md {
    font-size: 13.5px;
    line-height: 1.58;
    color: var(--ag-on);
    min-width: 0;
    overflow-wrap: break-word;
  }
  .tr-md :global(p) { margin: 0 0 8px; }
  .tr-md :global(p:last-child) { margin-bottom: 0; }
  .tr-md :global(h1), .tr-md :global(h2), .tr-md :global(h3) { font-size: 14.5px; margin: 10px 0 6px; line-height: 1.35; }
  .tr-md :global(ul), .tr-md :global(ol) { margin: 0 0 8px; padding-left: 20px; }
  .tr-md :global(pre) {
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
    border-radius: 8px;
    padding: 9px 11px;
    overflow-x: auto;
    margin: 0 0 8px;
    font-size: 12px;
  }
  .tr-md :global(code) { font-family: ui-monospace, 'SF Mono', Consolas, monospace; font-size: 0.9em; }
  .tr-md :global(:not(pre) > code) { background: var(--ag-surface-2); padding: 1px 5px; border-radius: 5px; }
  .tr-md :global(a) { color: var(--ag-accent); }

  .tr-err-box {
    display: flex;
    align-items: flex-start;
    gap: 7px;
    padding: 8px 10px;
    border-radius: 9px;
    background: var(--ag-err-bg);
    color: var(--ag-err);
    font-size: 12.5px;
    line-height: 1.5;
  }
  .tr-err-box .msr4 { font-size: 16px; flex: none; margin-top: 1px; }

  .tr-live {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12.5px;
    color: var(--ag-on-dim);
    min-width: 0;
  }
  .tr-live-spin, .tr-mini-spin {
    width: 13px;
    height: 13px;
    border-radius: 50%;
    border: 1.8px solid var(--ag-border-strong);
    border-top-color: var(--ag-accent);
    animation: agy-tr-spin 0.8s linear infinite;
    flex: none;
  }
  .tr-mini-spin { width: 12px; height: 12px; }
  @keyframes agy-tr-spin { to { transform: rotate(360deg); } }

  .tr-note { font-size: 12.5px; color: var(--ag-on-dim); }
  .tr-note.err { color: var(--ag-err); }

  .tr-foot {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 4px 0 0;
    padding-top: 8px;
    border-top: 1px solid var(--ag-border);
    font-size: 12px;
    color: var(--ag-on-dim);
  }
  .tr-sync-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ag-accent);
    flex: none;
    animation: agy-tr-pulse 1.5s ease-in-out infinite;
  }
  .trunc {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .num { font-variant-numeric: tabular-nums; }
</style>
