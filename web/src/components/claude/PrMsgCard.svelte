<script>
  // 转录里拉取请求相关的「用户消息」：
  //   · 「创建拉取请求」那段 <create-pr-command> 长提示词 → 显示成一颗 /create-pr（官方 c06cf64bb Yo 同款），可展开看原文；
  //   · 自动修复发来的 <ci-monitor-event> → 折叠成一行「收到 1 个 CI 事件」（官方 wk.ci），可展开看事件原文；
  //     用户刚打开自动修复时插进来的那句说明 → 「已开启自动修复」；
  //   · PR 卡「同步基线」冲突交给 Claude 的那段 <sync-conflict> → 一行「同步基线 · N 个文件冲突」，可展开看原文。
  // 信封后面跟着的部分（真人轮会把攒着的会话间消息附在后面）照常画：会话消息卡或普通气泡。
  // 识别在 lib/pr.svelte.js 的 prEnvelope。
  import { prEnvelope } from '../../lib/pr.svelte.js';
  import SessionMsgCard from './SessionMsgCard.svelte';
  import { hasSessionEnvelope, parseSessionText } from '../../lib/sessionFamily.svelte.js';
  import { t } from '../../lib/i18n.js';

  let { text = '' } = $props();
  const env = $derived(prEnvelope(text));
  let open = $state(false);
</script>

{#snippet prIcon()}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="18" r="2"/><path d="M6 8v8M18 16V9a3 3 0 0 0-3-3h-4"/><path d="M13 4l-2 2 2 2"/></svg>{/snippet}
{#snippet chev()}<svg class="chev" class:open viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>{/snippet}
{#snippet rest(r)}
  {#if r}
    {#if hasSessionEnvelope(r)}
      {@const sp = parseSessionText(r)}
      {#each sp.parts as part, pi (pi)}<SessionMsgCard {part} />{/each}
      {#if sp.rest}<div class="bubble sel-text">{sp.rest}</div>{/if}
    {:else}<div class="bubble sel-text">{r}</div>{/if}
  {/if}
{/snippet}

{#if env && env.kind === 'create'}
  <div class="cmd-wrap">
    <button class="bubble cmd" aria-expanded={open} title={t('展开提示词')} onclick={() => (open = !open)}>/create-pr{env.draft ? ' --draft' : ''}</button>
    {#if open}<div class="raw sel-text">{env.raw}</div>{/if}
    {@render rest(env.rest)}
  </div>
{:else if env && env.kind === 'sync'}
  <div class="ci-wrap">
    <button class="ci" aria-expanded={open} onclick={() => (open = !open)}>
      {@render prIcon()}
      <span>{t('同步基线')}</span>
      <span class="ref">· {t('{n} 个文件冲突', { n: env.files })}{env.base ? ` · ${env.base}` : ''}</span>
      {@render chev()}
    </button>
    {#if open}<div class="raw sel-text">{env.raw}</div>{/if}
    {@render rest(env.rest)}
  </div>
{:else if env && env.kind === 'ci'}
  <div class="ci-wrap">
    <button class="ci" aria-expanded={open} onclick={() => (open = !open)}>
      {@render prIcon()}
      <span>{env.enabled ? t('已开启自动修复') : t('收到 {n} 个 CI 事件', { n: env.count })}</span>
      {#if env.ref}<span class="ref">· {env.ref}</span>{/if}
      {@render chev()}
    </button>
    {#if open}{#each env.events as ev, i (i)}<div class="raw sel-text">{ev}</div>{/each}{/if}
    {@render rest(env.rest)}
  </div>
{/if}

<style>
  .cmd-wrap, .ci-wrap { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; max-width: 100%; }
  /* 用户气泡同款（Thread.svelte 的 .bubble 是它的作用域样式，这里照抄一份） */
  .bubble { background: var(--userbubble); color: var(--text); border-radius: 14px; padding: 10px 15px; font-size: 15px; line-height: 1.5; max-width: 100%; word-break: break-word; white-space: pre-wrap; }
  .cmd { font-family: var(--mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace); font-size: 13px; cursor: pointer; }
  .ci { display: inline-flex; align-items: center; gap: 6px; max-width: 100%; padding: 2px 4px; font-size: 13px; color: var(--muted); border-radius: 6px; }
  .ci:hover { color: var(--text); }
  .ci svg { width: 14px; height: 14px; flex: none; }
  .ci .ref { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .chev { transition: transform .15s ease; }
  .chev.open { transform: rotate(90deg); }
  .raw { align-self: stretch; max-height: 320px; overflow: auto; padding: 8px 10px; border-radius: 10px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; color: var(--muted); background: color-mix(in srgb, var(--text) 5%, transparent); }
</style>
