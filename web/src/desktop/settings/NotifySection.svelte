<script>
  // 设置 › 通用 › 通知（桌面外壳）：会话消息通知——每个会话单独一条、横幅、声音与提示音、详情预览。
  // 数据面 lib/notices.svelte.js，与手机设置页同一份；四类开关与 设置 › Claude › 通知 同一份（cs.device）。
  // 桌面壳的系统通知由主进程弹（Windows 的通知声音由系统决定），这里的声音管的是窗口在前台时的横幅提醒。
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DSwitch from '../kit/DSwitch.svelte';
  import DSelect from '../kit/DSelect.svelte';
  import DButton from '../kit/DButton.svelte';
  import { np, setNoticePref, kindValue, setKind, TONES, VIBES, pickTone, previewTone, previewVibe, canVibrate, testNotice, browserPerm, requestBrowserPerm } from '../../lib/notices.svelte.js';
  import { isNativeDesktop } from '../../lib/nativeDesktop.js';
  import { t } from '../../lib/i18n.js';

  let { highlight = () => false, onMaster = null } = $props();

  const shell = isNativeDesktop();
  const VIBE_HAS = canVibrate();
  const KINDS = [
    { k: 'question', label: () => t('在等你回答') },
    { k: 'permission', label: () => t('需要你批准') },
    { k: 'done', label: () => t('完成') },
    { k: 'error', label: () => t('出错') },
  ];
  const toneOpts = $derived([{ value: 'system', label: t('系统通知声音') }, ...TONES.map((x) => ({ value: x.id, label: x.label() }))]);
  const vibeOpts = $derived(VIBES.map((x) => ({ value: x.id, label: x.label() })));
  const toneValue = $derived(TONES.some((x) => x.id === np.tone) ? np.tone : 'system');

  function master(v) {
    setNoticePref('on', v);
    try { onMaster?.(v); } catch {}
  }
</script>

<DGroup label={t('通知')} foot={np.on ? t('每个会话单独一条通知，标题就是会话名。正看着的那个会话不会提醒。') : ''}>
  <DRow title={t('接收通知')} highlight={highlight('notify')}>
    {#snippet trailing()}<DSwitch checked={np.on} onchange={master} />{/snippet}
  </DRow>
  {#if np.on}
    {#each KINDS as k (k.k)}
      <DRow title={k.label()} highlight={highlight('notify-' + k.k)}>
        {#snippet trailing()}<DSwitch checked={kindValue(k.k)} onchange={(v) => setKind(k.k, v)} />{/snippet}
      </DRow>
    {/each}
  {/if}
</DGroup>

{#if np.on}
  <DGroup label={t('提醒方式')} foot={shell ? t('窗口在前台、看着别的会话时从右上角滑出横幅；窗口不在前台时由 Windows 系统通知提醒。') : t('页面开着、看着别的会话时从右上角滑出横幅；标签页在后台时用浏览器的系统通知。')}>
    <DRow title={t('横幅')} highlight={highlight('notify-banner')}>
      {#snippet trailing()}<DSwitch checked={np.inApp} onchange={(v) => setNoticePref('inApp', v)} />{/snippet}
    </DRow>
    <DRow title={t('显示内容详情')} sub={np.preview ? '' : t('通知只写「你有一条新消息」')} highlight={highlight('notify-preview')}>
      {#snippet trailing()}<DSwitch checked={np.preview} onchange={(v) => setNoticePref('preview', v)} />{/snippet}
    </DRow>
    <DRow title={t('声音')} highlight={highlight('notify-sound')}>
      {#snippet trailing()}<DSwitch checked={np.sound} onchange={(v) => setNoticePref('sound', v)} />{/snippet}
    </DRow>
    {#if np.sound}
      <DRow title={t('提示音')} sub={toneValue === 'system' ? t('窗口在前台时网页放不了 Windows 的提示音，用「清脆」代替') : ''}>
        {#snippet trailing()}
          <span class="pair">
            <DButton size="sm" variant="ghost" onclick={() => previewTone(toneValue)} title={t('试听')}>{t('试听')}</DButton>
            <DSelect options={toneOpts} value={toneValue} onchange={(v) => pickTone(v)} width="120px" />
          </span>
        {/snippet}
      </DRow>
    {/if}
    {#if VIBE_HAS}
      <DRow title={t('振动')}>
        {#snippet trailing()}<DSwitch checked={np.vibrate} onchange={(v) => setNoticePref('vibrate', v)} />{/snippet}
      </DRow>
      {#if np.vibrate}
        <DRow title={t('振动方式')}>
          {#snippet trailing()}<DSelect options={vibeOpts} value={np.vibe} onchange={(v) => { setNoticePref('vibe', v); previewVibe(v); }} width="120px" />{/snippet}
        </DRow>
      {/if}
    {/if}
    {#if !shell && browserPerm.v !== 'unsupported' && browserPerm.v !== 'granted'}
      <DRow title={t('允许浏览器通知')} sub={browserPerm.v === 'denied' ? t('浏览器拒绝了通知：在地址栏左边的网站设置里改回「允许」。') : t('标签页在后台时靠浏览器的系统通知提醒你。')}>
        {#snippet trailing()}<DButton size="sm" disabled={browserPerm.v === 'denied'} onclick={requestBrowserPerm}>{t('允许')}</DButton>{/snippet}
      </DRow>
    {/if}
    <DRow title={t('测试通知')} sub={t('按当前设置发一条，看看横幅和声音')}>
      {#snippet trailing()}<DButton size="sm" onclick={testNotice}>{t('发一条')}</DButton>{/snippet}
    </DRow>
  </DGroup>
{/if}

<style>
  .pair { display: inline-flex; align-items: center; gap: 6px; }
</style>
