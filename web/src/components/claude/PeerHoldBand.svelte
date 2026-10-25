<script>
  // 跨会话消息「待你确认」横条（设置 crossSessionInbound = 暂存等我确认；服务端 session-peers.mjs）：
  // 官方 Claude Desktop / 终端里的 Claude 会话给这个会话发了消息，CLI 先扣着（流里只有发送方、没有正文），
  // 这里列出是谁发的，「接收」= 投递进这个会话（它会开一轮处理），「拒收」= 整批丢弃（对方收到拒收回执）。
  // 与 RefusalBand 同槽同形（输入框上方 aux band）；没有扣着的消息就什么都不渲染。只有主机管理员有这条通道。
  import { session } from '../../lib/state.svelte.js';
  import { collab, loadPeerHolds, resolvePeerHolds } from '../../lib/sessionFamily.svelte.js';
  import { IS_CSNAP } from '../../lib/csnap.js';
  import { t, tr } from '../../lib/i18n.js';

  $effect(() => { if (session.id && !IS_CSNAP) loadPeerHolds(session.id); });
  const items = $derived(session.id ? collab.holds[session.id] || [] : []);
  const srcOf = (x) => (x.source === 'desktop' ? t('Claude Desktop 会话') : x.source === 'terminal' ? t('终端会话') : t('另一个 Claude 会话'));
  // 不是设置「暂存等我确认」扣下的、而是 CLI 按权限模式自己扣的（设置「跟随 Claude 默认」）：说一句为什么
  const CAUSE = {
    'bypass-default': t('这个会话正在绕过权限，其它会话发来的消息先暂存'),
    'mode-mismatch': t('对方的权限模式和这个会话不一致，先暂存'),
    'no-mode-asserted': t('对方没说明自己的权限模式，这个会话正在绕过权限，先暂存'),
  };
  const why = $derived([...new Set(items.map((x) => CAUSE[x.cause]).filter(Boolean))].join(' '));
  const msg = $derived(items.length === 1
    ? t('{name}（{src}）发来一条消息，等你确认', { name: items[0].name || t('未命名会话'), src: srcOf(items[0]) })
    : t('{n} 条其它 Claude 会话的消息等你确认', { n: items.length }));
  let busy = $state(false);
  let err = $state('');
  async function act(action) {
    if (busy) return;
    busy = true; err = '';
    const r = await resolvePeerHolds(session.id, action);
    if (!r.ok) err = tr(r.error || '') || t('操作失败，请重试');
    busy = false;
  }
</script>

{#if items.length && !IS_CSNAP}
  <div class="band" role="status" aria-live="polite">
    <div class="band-main">
      <span class="band-msg">{msg}</span>
      {#if items.length > 1}<span class="band-who">{items.map((x) => x.name || srcOf(x)).join('、')}</span>{/if}
      {#if why}<span class="band-who">{why}</span>{/if}
      {#if err}<span class="band-err">{err}</span>{/if}
    </div>
    <div class="band-cta">
      <button type="button" class="btn" disabled={busy} onclick={() => act('refuse')}>{t('拒收')}</button>
      <button type="button" class="btn pri" disabled={busy} onclick={() => act('accept')}>{t('接收')}</button>
    </div>
  </div>
{/if}

<style>
  /* 同 RefusalBand 的 epitaxy-composer-aux-view：min-h 40 / p8 / r10 / 底 --hover */
  .band { display: flex; align-items: center; gap: 8px; width: 100%; box-sizing: border-box; min-height: 40px; padding: 6px 6px 6px 12px;
    border-radius: 10px; background: var(--hover); font-size: 14px; line-height: 20px; color: var(--text); }
  .band-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .band-msg { min-width: 0; overflow-wrap: anywhere; }
  .band-who { min-width: 0; font-size: 13px; color: var(--muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .band-err { font-size: 13px; color: var(--crit); overflow-wrap: anywhere; }
  .band-cta { flex: none; display: flex; gap: 6px; }
  .btn { min-height: 28px; padding: 4px 12px; border-radius: 8px; font-size: 14px; line-height: 20px; color: var(--text); white-space: nowrap;
    transition: background-color 60ms ease-out; }
  @media (hover: hover) { .btn:hover:not(:disabled) { background: var(--hover-strong); } }
  .btn.pri { color: var(--bg); background: var(--text); font-weight: 500; }
  @media (hover: hover) { .btn.pri:hover:not(:disabled) { background: var(--text); opacity: .9; } }
  .btn:disabled { opacity: .5; cursor: default; }
</style>
