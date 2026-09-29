<script>
  // 设置 · 连接：这台设备连的是哪台服务器；服务端控制台入口（服务端形态的管理员，探针过了才出）。
  import { ui, me } from '../../lib/state.svelte.js';
  import { saPing } from '../../lib/serverAdmin.svelte.js';
  import SSection from './SSection.svelte';
  import SRow from './SRow.svelte';
  import SButton from './SButton.svelte';
  import { t, tc } from '../../lib/i18n.js';

  const shownBase = location.origin;

  let srvAdminOk = $state(false);
  $effect(() => {
    const want = me.kind === 'admin' && !!me.features?.remoteAdmin;
    if (want && !srvAdminOk) saPing().then(() => { srvAdminOk = true; }).catch(() => {});
  });
</script>

<SSection title={t('这台设备')}>
  <SRow label={t('服务器地址')} desc={t('网页连的就是当前这台服务器')} sid="addr">
    {#snippet trailing()}
      <span class="val mono" title={shownBase}>{shownBase.replace(/^https?:\/\//, '')}</span>
    {/snippet}
  </SRow>
  <SRow label={t('连接状态')} desc={ui.offline ? t('连不上服务器，正在浏览本地缓存；恢复网络后自动重连') : t('与服务器连接正常')} sid="status">
    {#snippet trailing()}<span class="val"><i class="dot" class:ok={!ui.offline} class:bad={ui.offline}></i>{ui.offline ? t('离线') : t('在线')}</span>{/snippet}
  </SRow>
</SSection>

{#if srvAdminOk}
  <SSection title={tc('settings', '管理')}>
    <SRow label={t('服务端控制台')} desc={t('用户、会话、订阅账号与日志')} sid="srvadmin">
      {#snippet trailing()}<SButton onclick={() => { ui.serverAdminOpen = true; }}>{t('打开')}</SButton>{/snippet}
    </SRow>
  </SSection>
{/if}

<style>
  .val { display: inline-flex; align-items: center; gap: 7px; font-size: 14px; color: var(--st-text2); white-space: nowrap;
    max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
  .mono { font-variant-numeric: tabular-nums; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--st-muted); flex: none; }
  .dot.ok { background: var(--ok); }
  .dot.bad { background: var(--crit); }
  :global(.stg.compact) .val { max-width: 170px; }
</style>
