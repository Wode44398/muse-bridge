<script>
  // 设置 › 通用、通知（提示音、振动方式）、语言、外观（iOS 外壳）。状态在外壳创建的控制器里（./ctx.js），这里只画页面。
  import { useSettings } from './ctx.js';
  import Sym from '../../ios27/Sym.svelte';
  import Toggle from '../../ios27/Toggle.svelte';
  import { LANGS, lang, setLang, t, tc } from '../../../lib/i18n.js';
  import { TONES, VIBES, browserPerm, canPickPhoneTone, kindValue, nativeNotices, np, pickPhoneTone, pickTone, previewVibe, requestBrowserPerm, setKind, setNoticePref, testNotice, toneLabel } from '../../../lib/notices.svelte.js';
  import { prefs, ui } from '../../../lib/state.svelte.js';

  let { pid } = $props();
  const S = useSettings();
  const { gen, nav, phone } = S;
</script>
{#snippet chev()}<Sym name="chevron.right" weight={600} size={13} class="chev" />{/snippet}
{#snippet check()}<Sym name="checkmark" weight={600} size={15} class="ck" />{/snippet}
{#snippet gfoot(text)}<p class="gfoot">{text}</p>{/snippet}
{#snippet ghead(text)}<h2 class="ghead">{text}</h2>{/snippet}

{#snippet statusTail(ok)}
  {#if ok}<Sym name="checkmark.circle.fill" weight={400} size={20} class="okmark" />{:else}{@render chev()}{/if}
{/snippet}

{#snippet pGeneral()}
  <div class="ig">
    <button class="r" type="button" onclick={() => nav.push('notify')}>
      <span class="r-main"><span class="r-tx">{t('通知')}</span><span class="r-d">{gen.notifyOn ? '' : tc('开关', '关闭')}</span>{@render chev()}</span>
    </button>
    <button class="r" type="button" onclick={() => nav.push('language')}>
      <span class="r-main"><span class="r-tx">{t('语言')}</span><span class="r-d">{gen.langLabel}</span>{@render chev()}</span>
    </button>
  </div>
  <div class="ig">
    <div class="r">
      <span class="r-main"><span class="r-tx">{t('原图加载')}</span><Toggle checked={prefs.fullResMedia} onchange={gen.toggleFullRes} label={t('原图加载')} /></span>
    </div>
  </div>
  <div class="ig">
    <div class="r">
      <span class="r-main"><span class="r-tx">{t('使用系统的文字选择')}</span><Toggle checked={prefs.sysSelect} onchange={gen.toggleSysSelect} label={t('使用系统的文字选择')} /></span>
    </div>
  </div>
  {@render gfoot(t('长按文字时用手机系统自带的选择柄和菜单。用读屏（TalkBack）时会自动改用系统的。'))}
  <!-- 安卓：后台运行不受省电限制（任务通知栏靠它在后台活着；原单页设置「通用」里的那一行） -->
  {#if phone.hasBatteryApi}
    <div class="ig">
      <button class="r" type="button" onclick={() => { if (!phone.batteryOk) phone.grantBattery(); }} aria-label={t('后台运行')}>
        <span class="r-main"><span class="r-tx">{t('后台运行')}</span>{#if !phone.batteryOk}<span class="r-d warn">{t('未开启')}</span>{/if}{@render statusTail(phone.batteryOk)}</span>
      </button>
    </div>
    {@render gfoot(phone.batteryOk ? t('已不受省电限制：切到后台也能收到任务进度与完成通知') : t('系统省电策略可能在后台掐断连接，任务跑完会收不到通知'))}
  {/if}
{/snippet}

<!-- 通用 › 通知：像微信的「新消息通知」——每个会话单独一条，铃声 / 振动 / 横幅 / 详情都在这里 -->
{#snippet pNotify()}
  <div class="ig">
    <div class="r">
      <span class="r-main"><span class="r-tx">{t('接收通知')}</span><Toggle checked={np.on} onchange={gen.toggleNotify} label={t('接收通知')} /></span>
    </div>
  </div>
  {@render gfoot(t('每个会话单独一条通知，标题就是会话名。正看着的那个会话不会提醒。'))}
  {#if np.on}
    {@render ghead(t('提醒哪些事'))}
    <div class="ig">
      {#each gen.NOTICE_KINDS as k (k.k)}
        <div class="r">
          <span class="r-main"><span class="r-tx">{k.label()}</span><Toggle checked={kindValue(k.k)} onchange={() => setKind(k.k, !kindValue(k.k))} label={k.label()} /></span>
        </div>
      {/each}
    </div>
    {@render ghead(t('提醒方式'))}
    <div class="ig">
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('横幅')}</span><Toggle checked={np.inApp} onchange={() => setNoticePref('inApp', !np.inApp)} label={t('横幅')} /></span>
      </div>
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('显示内容详情')}</span><Toggle checked={np.preview} onchange={() => setNoticePref('preview', !np.preview)} label={t('显示内容详情')} /></span>
      </div>
    </div>
    {@render gfoot(np.preview ? t('横幅：App 开着、在看别的页面时从顶部滑下来。关掉内容详情后，通知只写「你有一条新消息」。') : t('通知只写「你有一条新消息」，不露出问题和回复的内容。'))}
    <div class="ig">
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('声音')}</span><Toggle checked={np.sound} onchange={() => setNoticePref('sound', !np.sound)} label={t('声音')} /></span>
      </div>
      {#if np.sound}
        <button class="r" type="button" onclick={() => nav.push('notify-tone')}>
          <span class="r-main"><span class="r-tx">{t('提示音')}</span><span class="r-d">{toneLabel()}</span>{@render chev()}</span>
        </button>
      {/if}
      {#if gen.VIBE_HAS}
        <div class="r">
          <span class="r-main"><span class="r-tx">{t('振动')}</span><Toggle checked={np.vibrate} onchange={() => setNoticePref('vibrate', !np.vibrate)} label={t('振动')} /></span>
        </div>
        {#if np.vibrate}
          <button class="r" type="button" onclick={() => nav.push('notify-vibe')}>
            <span class="r-main"><span class="r-tx">{t('振动方式')}</span><span class="r-d">{gen.vibeLabel()}</span>{@render chev()}</span>
          </button>
        {/if}
      {/if}
    </div>
    {#if nativeNotices()}
      {@render gfoot(t('手机调成静音时不响也不振，振动模式只振不响，开着免打扰时都不提醒。'))}
      <div class="ig">
        <div class="r">
          <span class="r-main"><span class="r-tx">{t('后台保持接收')}</span><Toggle checked={np.keepAlive} onchange={() => setNoticePref('keepAlive', !np.keepAlive)} label={t('后台保持接收')} /></span>
        </div>
        {#if phone.hasBatteryApi}
          <button class="r" type="button" onclick={() => { if (!phone.batteryOk) phone.grantBattery(); }} aria-label={t('后台运行')}>
            <span class="r-main"><span class="r-tx">{t('后台运行')}</span>{#if !phone.batteryOk}<span class="r-d warn">{t('未开启')}</span>{/if}{@render statusTail(phone.batteryOk)}</span>
          </button>
        {/if}
        {#if gen.hasNotifySys}
          <button class="r" type="button" onclick={gen.openNotifySystem}>
            <span class="r-main"><span class="r-tx">{t('系统通知设置')}</span>{@render chev()}</span>
          </button>
        {/if}
      </div>
      {@render gfoot(np.keepAlive ? t('没有会话在跑时也常驻一条不响的通知，电脑上或定时任务发起的会话有动静也能马上告诉你；会多耗一点电。') : t('只在有会话在跑时跟踪；电脑上发起的会话，要等你打开过一次 App 才会被跟上。'))}
    {:else if browserPerm.v !== 'unsupported' && browserPerm.v !== 'granted'}
      <div class="ig">
        <button class="r" type="button" onclick={requestBrowserPerm} disabled={browserPerm.v === 'denied'}>
          <span class="r-main"><span class="r-tx">{t('允许浏览器通知')}</span><span class="r-d warn">{browserPerm.v === 'denied' ? t('已被拒绝') : t('未开启')}</span>{@render chev()}</span>
        </button>
      </div>
      {@render gfoot(browserPerm.v === 'denied' ? t('浏览器拒绝了通知：在地址栏左边的网站设置里改回「允许」。') : t('标签页在后台时靠浏览器的系统通知提醒你。'))}
    {/if}
    <div class="ig">
      <button class="r" type="button" onclick={testNotice}>
        <span class="r-main"><span class="r-tx">{t('发一条测试通知')}</span></span>
      </button>
    </div>
  {/if}
{/snippet}

{#snippet pNotifyTone()}
  {@const builtin = TONES.some((x) => x.id === np.tone)}
  <div class="ig">
    <button class="r" type="button" onclick={() => pickTone('system')}>
      <span class="r-main"><span class="r-tx">{t('系统通知声音')}</span>{#if !builtin && np.tone !== 'custom'}{@render check()}{/if}</span>
    </button>
    {#if canPickPhoneTone()}
      <button class="r" type="button" onclick={pickPhoneTone}>
        <span class="r-main"><span class="r-tx">{t('手机里的提示音')}</span><span class="r-d">{np.tone === 'custom' ? (np.toneName || '') : ''}</span>{#if np.tone === 'custom'}{@render check()}{:else}{@render chev()}{/if}</span>
      </button>
    {/if}
  </div>
  {@render gfoot(canPickPhoneTone() ? t('默认用手机自己的通知提示音，跟着手机的铃声模式和免打扰走。也可以从手机里已有的提示音里挑一个。') : t('电脑上网页放不了系统的提示音：页面在前台时用「清脆」代替，在后台时是系统通知自带的声音。'))}
  {@render ghead(t('内置提示音'))}
  <div class="ig">
    {#each TONES as x (x.id)}
      <button class="r" type="button" onclick={() => pickTone(x.id)}>
        <span class="r-main"><span class="r-tx">{x.label()}</span>{#if np.tone === x.id}{@render check()}{/if}</span>
      </button>
    {/each}
  </div>
  {@render gfoot(t('点一下试听。'))}
{/snippet}

{#snippet pNotifyVibe()}
  <div class="ig">
    {#each VIBES as x (x.id)}
      <button class="r" type="button" onclick={() => { setNoticePref('vibe', x.id); previewVibe(x.id); }}>
        <span class="r-main"><span class="r-tx">{x.label()}</span>{#if np.vibe === x.id}{@render check()}{/if}</span>
      </button>
    {/each}
  </div>
  {@render gfoot(t('点一下试一下。'))}
{/snippet}

{#snippet pLanguage()}
  <div class="ig">
    {#each LANGS as l (l.value)}
      <button class="r" type="button" onclick={() => setLang(l.value)} lang={l.value === 'en' ? 'en' : 'zh-CN'}>
        <span class="r-main"><span class="r-tx">{l.label}</span>{#if lang() === l.value}{@render check()}{/if}</span>
      </button>
    {/each}
  </div>
{/snippet}

{#snippet pAppearance()}
  <div class="ig theme-pick" role="radiogroup" aria-label={t('外观')}>
    {#each ['light', 'dark'] as th (th)}
      {@const on = !prefs.followSys && ui.theme === th}
      <button class="tp" class:on type="button" role="radio" aria-checked={on} onclick={() => gen.pickTheme(th)}>
        <span class="tp-art {th}" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="tp-name">{th === 'light' ? t('明亮') : t('深色')}</span>
        <span class="tp-dot" aria-hidden="true"></span>
      </button>
    {/each}
  </div>
  <div class="ig">
    <div class="r">
      <span class="r-main"><span class="r-tx">{t('跟随系统明暗')}</span><Toggle checked={prefs.followSys} onchange={gen.toggleFollowSys} label={t('跟随系统明暗')} /></span>
    </div>
  </div>
  <div class="ig">
    <div class="r">
      <span class="r-main"><span class="r-tx">{t('禁用系统转场动画')}</span><Toggle checked={prefs.noEnterAnim} onchange={gen.toggleNoAnim} label={t('禁用转场动画')} /></span>
    </div>
  </div>
{/snippet}
{#if pid === 'general'}{@render pGeneral()}
{:else if pid === 'language'}{@render pLanguage()}
{:else if pid === 'notify'}{@render pNotify()}
{:else if pid === 'notify-tone'}{@render pNotifyTone()}
{:else if pid === 'notify-vibe'}{@render pNotifyVibe()}
{:else if pid === 'appearance'}{@render pAppearance()}
{/if}

<style>
  @import './kit.css';
</style>
