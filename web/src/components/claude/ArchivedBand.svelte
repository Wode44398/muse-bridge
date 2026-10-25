<script>
  // 输入框上方的「此会话已归档」横条（官方 Desktop：This session is archived. Unarchive it to keep working
  // in this session.）。bridge 不扣消息：真人接着发一条，服务端就顺手取消归档（runtime/session-archive-auto.mjs
  // 的 unarchiveOnTurn），横条随总线的 archive 事件消失；这里只给一个显式的「取消归档」。
  import { isArchivedId, setArchivedIds } from '../../lib/sessionArchive.svelte.js';
  import { uiAlert } from '../../lib/dialogs.js';
  import { t } from '../../lib/i18n.js';

  let { sessionId = null } = $props();
  let busy = $state(false);
  const on = $derived(!!sessionId && isArchivedId(sessionId));

  async function unarchive() {
    if (busy || !sessionId) return;
    busy = true;
    try { await setArchivedIds([sessionId], false); }
    catch { uiAlert(t('无法取消归档，请重试'), { type: 'error' }); }
    finally { busy = false; }
  }
</script>

{#if on}
  <div class="band" role="status">
    <span class="band-msg">{t('此会话已归档。')}</span>
    <button class="lnk" disabled={busy} onclick={unarchive}>{t('取消归档')}</button>
  </div>
{/if}

<style>
  /* 与 RefusalBand 同一套 aux band 外形：min-h 40 / p8 / r10 / 底 --hover */
  .band { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; min-height: 40px; padding: 8px 8px 8px 12px;
    border-radius: 10px; background: var(--hover); font-size: 14px; line-height: 20px; color: var(--text); }
  .band-msg { flex: 1; min-width: 0; }
  .lnk { flex: none; padding: 0 4px; color: var(--serif); text-decoration: underline; text-underline-offset: 3px;
    text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); font-size: 14px; line-height: 20px; border-radius: 4px; }
  @media (hover: hover) { .lnk:hover { color: var(--text); } }
  .lnk:disabled { opacity: .5; cursor: default; }
</style>
