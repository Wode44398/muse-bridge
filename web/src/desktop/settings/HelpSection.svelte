<script>
  // 桌面设置 › 反馈：一张信纸 + 附件，去向的勾选与管理员开关。状态在外壳创建的控制器里（./ctx.js 的 useDesk），这里只画。
  import { useDesk } from './ctx.js';
  import DButton from '../kit/DButton.svelte';
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DSwitch from '../kit/DSwitch.svelte';
  import { t } from '../../lib/i18n.js';
  import { SI } from '../../lib/settingsIcons.js';

  const D = useDesk();
  const { fb } = D;
  const svgOf = (name, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;
</script>
<div class="fb card" class:hl-line={D.fl('feedback')}>
  <textarea rows="6" placeholder={t('遇到什么问题、想要什么功能…')} bind:value={fb.fbText}></textarea>
  {#if fb.fbAtts.length}
    <div class="fb-atts">
      {#each fb.fbAtts as a (a.name)}
        <span class="fba" class:pending={a.pending}>{a.name}<button onclick={() => { fb.fbAtts = fb.fbAtts.filter((x) => x !== a); }} aria-label={t('移除')}>{@html svgOf('plus', 2)}</button></span>
      {/each}
    </div>
  {/if}
  {#if fb.fbUp?.mode === 'push'}
    <div class="fb-consent">
      <span class="fb-consent-tx"><b>{t('这条也发给 {to}', { to: fb.fbDest.to })}</b>{fb.fbDest.public ? t('勾选后会同时发给 {to}：带文字、所在界面、版本和系统，不带账号名和服务器地址。这是公开发布：内容任何人都能看到，请别写隐私、账号、密钥；图片不会公开发布（只记张数），视频不发。', { to: fb.fbDest.to }) : t('勾选后会同时发给 {to}：带文字、所在界面、版本和系统，不带账号名和服务器地址；图片最多 3 张，原样发出，截图里能看到的开发者也能看到；视频不发。', { to: fb.fbDest.to })}</span>
      <DSwitch bind:checked={fb.fbConsent} />
    </div>
  {/if}
  <div class="fb-acts">
    <DButton variant="ghost" onclick={() => fb.fbFileInput.click()}>{t('添加图片 / 视频')}</DButton>
    <input type="file" accept="image/*,video/*" multiple hidden bind:this={fb.fbFileInput} onchange={fb.onFbFiles} />
    <span class="sp"></span>
    {#if fb.fbDone}<span class="ok">{t('已提交，谢谢！')}</span>{/if}
    {#if fb.fbErr}<span class="err sel-text">{fb.fbErr}</span>{/if}
    <DButton variant="primary" disabled={fb.fbBusy} onclick={fb.submitFeedback}>{fb.fbBusy ? t('提交中…') : t('提交反馈')}</DButton>
  </div>
</div>
{#if fb.fbUpNote}<p class="fb-note sel-text">{fb.fbUpNote}</p>{/if}
{#if fb.fbInboxLine}<p class="fb-note sel-text" class:bad={!!fb.fbUp.lastPullError || fb.fbUp.reason === 'no-relay'}>{fb.fbInboxLine}</p>{/if}
{#if fb.fbUp?.admin && fb.fbUp.mode !== 'inbox' && !fb.fbUp.reason}
  <DGroup foot={fb.fbUp.pending ? t('还有 {n} 条没发出去，连上后自动补发。', { n: fb.fbUp.pending }) : ''}>
    <DRow title={t('把用户反馈同时发给 {to}', { to: fb.fbDest.to })} sub={fb.fbUpAdminSub + ' ' + t('关掉后，这台服务器上的反馈只留在本机，还没发出去的也一并取消。')} highlight={D.fl('fbup')}>
      {#snippet trailing()}<DSwitch checked={fb.fbUp.mode === 'push'} disabled={fb.fbUpBusy} onchange={fb.onFbUp} />{/snippet}
    </DRow>
  </DGroup>
{/if}

<style>
  @import './kit.css';
</style>
