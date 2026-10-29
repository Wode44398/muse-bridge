<script>
  // 输入框上方的「连接器需要授权」提示条：这一轮的 init 帧报了 needs-auth 的远程连接器（mcpState，chat.svelte.js）
  // 就提示一句，点「授权」直接开流程（与会话信息面板「连接器」卡同一份状态，lib/mcpAuth.svelte.js）。
  // 「忽略」只在本页记住，换会话 / 刷新后连接器仍需授权会再提示。
  import { mcpState } from '../../lib/chat.svelte.js';
  import { authFlow, startAuth } from '../../lib/mcpAuth.svelte.js';
  import McpAuthFlow from './McpAuthFlow.svelte';
  import { t } from '../../lib/i18n.js';

  let { sessionId = null } = $props();
  let dismissed = $state({});
  const pending = $derived((mcpState.bySession[sessionId || '']?.servers || []).filter((s) => s.status === 'needs-auth' && !dismissed[sessionId + '|' + s.name]));
  const shown = $derived(pending.slice(0, 2));
  const dismiss = (name) => { dismissed = { ...dismissed, [sessionId + '|' + name]: true }; };
</script>

{#each shown as s (s.name)}
  <div class="band" role="status">
    <div class="band-top">
      <span class="band-msg">{t('连接器「{name}」需要授权才能使用。', { name: s.name })}</span>
      {#if !authFlow(sessionId, s.name)}
        <button class="lnk" onclick={() => startAuth(sessionId, s.name)}>{t('授权')}</button>
        <button class="lnk" onclick={() => dismiss(s.name)}>{t('忽略')}</button>
      {/if}
    </div>
    <McpAuthFlow sid={sessionId} server={s.name} />
  </div>
{/each}

<style>
  /* 与 ArchivedBand / RefusalBand 同一套 aux band 外形：min-h 40 / p8 / r10 / 底 --hover */
  .band { display: flex; flex-direction: column; width: 100%; box-sizing: border-box; min-height: 40px; padding: 8px 8px 8px 12px;
    border-radius: 10px; background: var(--hover); font-size: 14px; line-height: 20px; color: var(--text); }
  .band + .band { margin-top: 6px; }
  .band-top { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; }
  .band-msg { flex: 1; min-width: 12em; }
  .band :global(.af) { padding-left: 0; padding-top: 4px; }
  .lnk { flex: none; padding: 0 4px; color: var(--serif); text-decoration: underline; text-underline-offset: 3px;
    text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); font-size: 14px; line-height: 20px; border-radius: 4px; }
  @media (hover: hover) { .lnk:hover { color: var(--text); } }
</style>
