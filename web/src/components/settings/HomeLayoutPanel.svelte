<script module>
  // 「主页」分区的图标：一座小房子。不用四宫格——「扩展」那枚就是方块拼的，侧栏里两行挨着分不清。
  // lib/settingsIcons 的 SI 里没有这一枚，两套设置外壳的侧栏 / 根页行都从这里取，同 SI 的画法（24 格、描边、由外壳的 svgOf 包 <svg>）。
  export const HOME_GLYPH = '<path d="M4.5 10.4 12 4.5l7.5 5.9v8.1a1.5 1.5 0 0 1-1.5 1.5h-3.6v-5.4H9.6V20H6a1.5 1.5 0 0 1-1.5-1.5z"/>';
</script>

<script>
  // 设置 ›「主页」：主页（手机的方块网格、桌面的 Dock）上摆哪些入口、按什么顺序。
  // 数据与写入全在 lib/homeLayout（prefs.homeLayout，只存这台设备）；这里只画列表：
  //   每个入口一行：图标、名字（插件应用另起一行灰字写插件名；排在第 8 格之后的注明收在「更多」里）、上移 / 下移、「在主页显示」开关。
  //   底部「恢复默认」= 清掉自己排的顺序和藏掉的项。
  //   主机多一行「新建应用」：开一个新的 Claude 对话、输入框里填好开头（不替人发），由 Claude 照「做 bridge 应用」的路子帮着做。
  //   只给主机：做应用 = 装插件，成员装不了。
  // 两种样子：
  //   touch   手机设置 ios27 v5「墨与象牙」分组卡 + 液态开关（Toggle 从外壳的 ios27 上下文取 ink / dark）。
  //           外壳的 .ig / .r / .steps 是 Settings.svelte 的 scoped 样式进不了子组件，这里照抄同样的尺寸，颜色用外壳 .ios 继承下来的 --i-* 令牌
  //           （同 ClaudeResets 的做法），不另起一套样子。
  //   desktop 桌面设置套件 DGroup / DRow / DSwitch / DButton。
  import { flip } from 'svelte/animate';
  import { ui, me } from '../../lib/state.svelte.js';
  import { handoffToClaude } from '../../lib/claudeHandoff.js';
  import { t } from '../../lib/i18n.js';
  import { homeView, moveHomeEntry, setHomeHidden, resetHomeLayout, builtinHomeIcon } from '../../lib/homeLayout.svelte.js';
  import { appIconUrl } from '../../lib/pluginApps.svelte.js';
  import { uiIcon } from '../../lib/pluginUi.svelte.js';
  import { SI } from '../../lib/settingsIcons.js';
  import { DUR, bezier, reduced } from '../../lib/motion.js';
  import Toggle from '../ios27/Toggle.svelte';
  import DGroup from '../../desktop/kit/DGroup.svelte';
  import DRow from '../../desktop/kit/DRow.svelte';
  import DSwitch from '../../desktop/kit/DSwitch.svelte';
  import DButton from '../../desktop/kit/DButton.svelte';

  let { variant = 'touch' } = $props();

  const light = $derived(ui.theme === 'light');
  const view = $derived(homeView());
  const list = $derived(view.ordered.filter(Boolean));
  const inMore = $derived(new Set(view.overflow.map((e) => e?.key)));
  const FOOT = t('主页最多摆 8 个，多出来的收进『更多』。只影响这台设备。');
  // 上移 / 下移换位时让行滑过去（看得出是哪一行挪了）；系统要求少动画时直接到位
  const easeStd = bezier(0.2, 0, 0, 1);
  const FLIP = { duration: reduced() ? 0 : DUR.quick, easing: easeStd };
  const arrow = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SI[name] || ''}</svg>`;

  // 图标：内置四个走主页同一套素材（浅色界面用深色那枚）；应用有图片用图片，只给了内置图标名的画 pluginIcon
  function iconOf(e) {
    if (e.kind === 'builtin') return { src: builtinHomeIcon(e.key, { light }) };
    const src = appIconUrl(e.app, light);
    return src ? { src } : { svg: uiIcon(e.app?.icon?.name) };
  }
  // 第二行灰字：应用写它属于哪个插件；排在「更多」里的注明一句（藏掉的不注，开关已经说明了）。
  // 「更多」这句放前面：手机一行窄，插件名长了会把它挤成省略号，而它才是这一行此刻的状态
  function subOf(e) {
    const bits = [];
    if (inMore.has(e.key)) bits.push(t('在「更多」里'));
    if (e.kind === 'app' && e.app?.pluginName) bits.push(e.app.pluginName);
    return bits.join(' · ');
  }
  const shownOn = (e) => !view.hidden.has(e.key);
  const canCreate = $derived(me.kind === 'admin');
  const newApp = () => handoffToClaude(t('帮我做一个 bridge 应用：'));
</script>

{#snippet glyph(e)}
  {@const ic = iconOf(e)}
  {#if ic.src}<img src={ic.src} alt="" draggable="false" />{:else}{@html ic.svg}{/if}
{/snippet}

{#if variant === 'desktop'}
  <DGroup label={t('主页上的入口')} foot={FOOT}>
    {#each list as e, i (e.key)}
      <DRow title={e.label} sub={subOf(e)} chip="var(--dsk-panel-strong)">
        {#snippet icon()}<span class="hl-dico" class:dim={!shownOn(e)}>{@render glyph(e)}</span>{/snippet}
        {#snippet trailing()}
          <span class="hl-dsteps">
            <DButton size="sm" variant="ghost" title={t('上移')} disabled={i <= 0} onclick={() => moveHomeEntry(e.key, -1)}>{@html arrow('up')}</DButton>
            <DButton size="sm" variant="ghost" title={t('下移')} disabled={i >= list.length - 1} onclick={() => moveHomeEntry(e.key, 1)}>{@html arrow('down')}</DButton>
          </span>
          <DSwitch checked={shownOn(e)} onchange={(v) => setHomeHidden(e.key, !v)} />
        {/snippet}
      </DRow>
    {:else}
      <DRow title={t('现在没有能摆上主页的入口')} />
    {/each}
  </DGroup>
  <DGroup>
    <DRow title={t('恢复默认')} sub={t('按默认顺序摆，全部显示')} chevron={false} onclick={resetHomeLayout} />
  </DGroup>
  {#if canCreate}
    <DGroup>
      <DRow title={t('新建应用')} sub={t('交给 Claude：说说想要什么，它帮你做成主页上的一个应用')} onclick={newApp} />
    </DGroup>
  {/if}
{:else}
  <div class="hl">
    <p class="ghead">{t('主页上的入口')}</p>
    <div class="ig">
      {#each list as e, i (e.key)}
        {@const sub = subOf(e)}
        <div class="r" animate:flip={FLIP}>
          <span class="ri" class:dim={!shownOn(e)} aria-hidden="true">{@render glyph(e)}</span>
          <span class="r-main">
            <span class="r-tx" class:dim={!shownOn(e)}><span class="r-nm">{e.label}</span>{#if sub}<span class="r-sub">{sub}</span>{/if}</span>
            <span class="steps">
              <button type="button" disabled={i <= 0} onclick={() => moveHomeEntry(e.key, -1)} aria-label={t('上移')}>{@html arrow('up')}</button>
              <button type="button" disabled={i >= list.length - 1} onclick={() => moveHomeEntry(e.key, 1)} aria-label={t('下移')}>{@html arrow('down')}</button>
            </span>
            <Toggle checked={shownOn(e)} onchange={() => setHomeHidden(e.key, shownOn(e))} label={t('在主页显示「{name}」', { name: e.label })} />
          </span>
        </div>
      {:else}
        <div class="r"><span class="r-main"><span class="r-tx r-sub">{t('现在没有能摆上主页的入口')}</span></span></div>
      {/each}
    </div>
    <p class="gfoot">{FOOT}</p>
    <div class="ig">
      <button class="r" type="button" onclick={resetHomeLayout}>
        <span class="r-main center"><span class="r-tx accent">{t('恢复默认')}</span></span>
      </button>
    </div>
    {#if canCreate}
      <div class="ig">
        <button class="r" type="button" onclick={newApp}>
          <span class="r-main center"><span class="r-tx accent">{t('新建应用')}</span></span>
        </button>
      </div>
      <p class="gfoot">{t('交给 Claude：说说想要什么，它帮你做成主页上的一个应用')}</p>
    {/if}
  </div>
{/if}

<style>
  /* —— desktop：只补套件没有的两处——图标方块里的图片 / 线稿尺寸、两枚小钮的间距 —— */
  .hl-dico { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; color: var(--dsk-ink); }
  .hl-dico img { width: 16px; height: 16px; object-fit: contain; display: block; }
  .hl-dico :global(svg) { width: 15px; height: 15px; display: block; }
  .hl-dico.dim { opacity: .45; }
  .hl-dsteps { display: inline-flex; gap: 2px; }
  .hl-dsteps :global(svg) { width: 14px; height: 14px; display: block; }

  /* —— touch：照抄 Settings.svelte 的 .ig / .r / .ri / .steps / .ghead / .gfoot（同尺寸、同令牌） —— */
  .ghead { margin: 0; padding: 0 16px 8px; font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: .2px; color: var(--i-label2); }
  .ig { position: relative; background: var(--i-card); border-radius: 18px; overflow: hidden; margin-bottom: 26px;
    box-shadow: inset 0 0 0 .5px var(--i-label4); transition: background-color 240ms var(--ea-fade); }
  .ig:has(+ .gfoot) { margin-bottom: 0; }
  .gfoot { margin: 0; padding: 8px 16px 24px; font-size: 12.5px; line-height: 18px; color: var(--i-label2); }
  .r {
    position: relative; display: flex; align-items: center; gap: 14px; width: 100%; min-height: 50px; padding: 0 16px;
    border: 0; background: none; font: inherit; color: inherit; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent;
    transition: background-color 260ms var(--ea-fade), opacity 200ms var(--ea-fade);
  }
  div.r { cursor: default; }
  button.r:active:not(:disabled) { background: var(--i-press); transition-duration: 60ms; }
  .r-main { position: relative; flex: 1; min-width: 0; align-self: stretch; display: flex; align-items: center; gap: 10px; min-height: 50px; padding: 12px 0; }
  .r + .r .r-main::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 1px; background: var(--i-sep); }
  .r-main.center { justify-content: center; text-align: center; }
  .r-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 16px; line-height: 22px; letter-spacing: -.1px; }
  .r-main.center .r-tx { flex: none; align-items: center; }
  .r-tx.accent { color: var(--i-accent); font-weight: 600; }
  .r-nm, .r-sub { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .r-sub { font-size: 13px; line-height: 18px; letter-spacing: 0; color: var(--i-label2); }
  .ri { flex: none; width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center;
    background: var(--i-tile); color: var(--i-tile-ink); }
  .ri :global(svg) { width: 18px; height: 18px; display: block; }
  .ri img { width: 20px; height: 20px; display: block; object-fit: contain; }
  /* 不在主页上的：图标与名字压淡（开关本身已经说明了状态，这里只是一眼扫过去分得清） */
  .ri.dim, .r-tx.dim { opacity: .5; }
  .steps { flex: none; display: flex; gap: 6px; }
  .steps button { width: 32px; height: 32px; padding: 7px; border: 0; border-radius: 50%; background: var(--i-fill4); color: var(--i-label); cursor: pointer;
    -webkit-tap-highlight-color: transparent; transition: background-color 200ms var(--ea-fade), opacity 200ms; }
  .steps button :global(svg) { width: 18px; height: 18px; display: block; }
  .steps button:active:not(:disabled) { background: var(--i-fill2); }
  .steps button:disabled { opacity: .3; cursor: default; }
</style>
