<script>
  // 会话间消息卡（session-family）：用户气泡位置上的信封换成卡片——
  //  · message：另一个会话发来的话（父 / 子 / 兄弟）；brief = 父会话派来的任务说明（背景 + 任务两段）
  //  · event：子会话汇报（<side-sessions-event>），每个子会话一行：状态 + 标题（点开那个会话）+ 汇报开头
  //  · peer：官方 Claude Desktop / 终端里的 Claude 会话经 CLI 跨会话通道发来的（<cross-session-message>，session-peers.mjs）——
  //    那个会话不在 bridge 里，名字只显示不跳；原文信封不进插话气泡
  // 头部的会话名可点：跳到那个会话。快照访客只看不跳。
  import { openSession } from '../../lib/chat.svelte.js';
  import { sessionTitle, briefSections, REL_LABEL } from '../../lib/sessionFamily.svelte.js';
  import { IS_CSNAP } from '../../lib/csnap.js';
  import { renderMarkdown } from '../../lib/md.js';   // 会话间的话基本是 Claude 写的，常带 markdown；md.js 内部 DOMPurify 清洗
  import { t } from '../../lib/i18n.js';

  let { part } = $props();

  const LONG = 600;
  let open = $state(false);
  const fromTitle = $derived(part.kind === 'message' ? (sessionTitle(part.from, part.title) || part.name || t('另一个会话')) : '');
  const head = $derived(part.kind !== 'message' ? '' : part.brief
    ? t('{rel}派来的任务', { rel: t(REL_LABEL[part.relation] || REL_LABEL.linked) })
    : t('来自{rel}', { rel: t(REL_LABEL[part.relation] || REL_LABEL.linked) }));
  const sections = $derived(part.kind === 'message' && part.brief ? briefSections(part.body) : null);
  const long = $derived((part.kind === 'message' || part.kind === 'peer') && part.body.length > LONG);
  const peerHead = $derived(part.kind !== 'peer' ? ''
    : part.source === 'desktop' ? t('来自 Claude Desktop 会话')
    : part.source === 'terminal' ? t('来自终端会话')
    : t('来自另一个 Claude 会话'));
  const STATUS = { done: '这一轮已结束', failed: '这一轮出错了', stopped: '被停下' };
  let openNotes = $state({});
  function go(id) { if (id && !IS_CSNAP) openSession(id); }
</script>

{#snippet linkIc()}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.4"/><circle cx="18" cy="18" r="2.4"/><path d="M6 8.4v3.1a3 3 0 0 0 3 3h6.6"/><path d="M13.6 12l2.4 2.5-2.4 2.5"/></svg>{/snippet}

{#if part.kind === 'message'}
  <div class="smc">
    <div class="smc-head">
      <span class="smc-ic">{@render linkIc()}</span>
      <span class="smc-kind">{head}</span>
      <button class="smc-from" disabled={IS_CSNAP || !part.from} title={t('打开这个会话')} onclick={() => go(part.from)}>{fromTitle}</button>
    </div>
    <div class="smc-body sel-text" class:clamp={long && !open}>
      {#if sections}
        {#each sections as s}
          {#if s.label}<div class="smc-label">{t(s.label)}</div>{/if}
          <div class="smc-md">{@html renderMarkdown(s.text)}</div>
        {/each}
      {:else}
        <div class="smc-md">{@html renderMarkdown(part.body)}</div>
      {/if}
    </div>
    {#if long}<button class="smc-more" onclick={() => (open = !open)}>{open ? t('收起') : t('展开全部')}</button>{/if}
  </div>
{:else if part.kind === 'event'}
  <div class="smc">
    <div class="smc-head">
      <span class="smc-ic">{@render linkIc()}</span>
      <span class="smc-kind">{part.notes.length > 1 ? t('{n} 个子会话的汇报', { n: part.notes.length }) : t('子会话的汇报')}</span>
    </div>
    <div class="smc-notes">
      {#each part.notes as n, i (n.from + i)}
        <div class="note">
          <div class="note-head">
            <span class="dot {n.status}" aria-hidden="true"></span>
            <button class="note-title" disabled={IS_CSNAP || !n.from} title={t('打开这个会话')} onclick={() => go(n.from)}>{sessionTitle(n.from, n.title) || n.name || t('子会话')}</button>
            <span class="note-st">{t(STATUS[n.status] || STATUS.done)}</span>
          </div>
          {#if n.text}
            <div class="note-text smc-md sel-text" class:clamp={!openNotes[i] && n.text.length > 160}>{@html renderMarkdown(n.text)}</div>
            {#if n.text.length > 160}<button class="smc-more" onclick={() => (openNotes[i] = !openNotes[i])}>{openNotes[i] ? t('收起') : t('展开全部')}</button>{/if}
          {/if}
        </div>
      {/each}
    </div>
  </div>
{:else if part.kind === 'peer'}
  <div class="smc">
    <div class="smc-head">
      <span class="smc-ic">{@render peerIc()}</span>
      <span class="smc-kind">{peerHead}</span>
      {#if part.name}<span class="smc-peer" title={part.name}>{part.name}</span>{/if}
    </div>
    <div class="smc-body sel-text" class:clamp={long && !open}>
      <div class="smc-md">{@html renderMarkdown(part.body)}</div>
    </div>
    {#if long}<button class="smc-more" onclick={() => (open = !open)}>{open ? t('收起') : t('展开全部')}</button>{/if}
  </div>
{/if}

<!-- 另一个程序里的会话：两个叠着的窗口（与会话树的「链」图标区分开） -->
{#snippet peerIc()}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="7.5" width="12" height="11" rx="2.2"/><path d="M8.5 7.5V6.2a2.2 2.2 0 0 1 2.2-2.2h7.6a2.2 2.2 0 0 1 2.2 2.2v7.1a2.2 2.2 0 0 1-2.2 2.2h-2.8"/></svg>{/snippet}

<style>
  .smc-peer { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text); font-weight: 500; }
  .smc { width: min(560px, 100%); box-sizing: border-box; background: var(--card); border: 1px solid var(--divider); border-radius: 14px; padding: 10px 13px 11px; text-align: left; animation: smcIn .28s cubic-bezier(.22,1,.36,1); }
  @keyframes smcIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .smc { animation: none; } }
  .smc-head { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 12.5px; color: var(--muted); }
  .smc-ic { width: 16px; height: 16px; flex: none; color: var(--serif); }
  .smc-ic svg { width: 100%; height: 100%; display: block; }
  .smc-kind { flex: none; }
  .smc-from, .note-title { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font: inherit; color: var(--text); background: none; border: 0; padding: 0; cursor: pointer; text-align: left; }
  .smc-from { font-weight: 500; }
  .smc-from:disabled, .note-title:disabled { cursor: default; }
  @media (hover: hover) { .smc-from:not(:disabled):hover, .note-title:not(:disabled):hover { text-decoration: underline; text-underline-offset: 3px; } }
  .smc-body { margin-top: 7px; font-size: 14.5px; line-height: 1.55; color: var(--text); word-break: break-word; }
  .smc-body.clamp { max-height: 9.3em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 70%, transparent); mask-image: linear-gradient(#000 70%, transparent); }
  .smc-label { font-size: 11.5px; color: var(--muted); margin: 6px 0 2px; letter-spacing: .02em; }
  .smc-label:first-child { margin-top: 0; }
  /* markdown 正文：卡片里收紧段距、标题降一级字号，别把一张小卡撑成一篇文章 */
  .smc-md { word-break: break-word; }
  .smc-md :global(p), .smc-md :global(ul), .smc-md :global(ol), .smc-md :global(pre), .smc-md :global(blockquote) { margin: 0 0 6px; }
  .smc-md :global(:last-child) { margin-bottom: 0; }
  .smc-md :global(h1), .smc-md :global(h2), .smc-md :global(h3), .smc-md :global(h4) { font-size: 1em; font-weight: 600; margin: 0 0 4px; }
  .smc-md :global(ul), .smc-md :global(ol) { padding-left: 1.3em; }
  .smc-md :global(pre) { background: var(--userbubble); border-radius: 8px; padding: 8px 10px; overflow-x: auto; font-size: 12.5px; }
  .smc-md :global(code) { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: .92em; }
  .smc-md :global(a) { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
  .smc-more { margin-top: 4px; font: inherit; font-size: 12.5px; color: var(--muted); background: none; border: 0; padding: 0; cursor: pointer; }
  .smc-notes { display: flex; flex-direction: column; gap: 9px; margin-top: 8px; }
  .note { min-width: 0; }
  .note + .note { border-top: 1px solid var(--divider); padding-top: 9px; }
  .note-head { display: flex; align-items: center; gap: 7px; min-width: 0; font-size: 13.5px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--muted); }
  .dot.done { background: #3a9f6b; }
  .dot.failed { background: #d0533f; }
  .note-title { flex: 0 1 auto; font-weight: 500; }
  .note-st { flex: none; font-size: 12px; color: var(--muted); }
  .note-text { margin-top: 4px; font-size: 13.5px; line-height: 1.5; color: var(--text); }
  .note-text.clamp { max-height: 4.6em; overflow: hidden; -webkit-mask-image: linear-gradient(#000 60%, transparent); mask-image: linear-gradient(#000 60%, transparent); }
</style>
