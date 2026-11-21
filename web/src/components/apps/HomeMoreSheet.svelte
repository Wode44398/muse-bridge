<script>
  // 主页「更多」：主页最多摆 8 格，放不下的入口收在这里，点一个就打开它。
  // 三种出场，内容是同一张图标网格：
  //   sheet：触屏 / 窄屏 → ios27 表单页（Sheet）；
  //   panel：宽屏鼠标（电脑浏览器里的手机版主页）→ 屏幕正中一块毛玻璃面板；
  //   dock ：桌面主页 → 从 Dock 上「更多」那格的正上方弹出（传 anchor）。
  // 配色是主页登录卡 / 插件卡片同一套「墨与象牙」令牌（ios27/ink.css），明暗跟 ui.theme。接系统返回（pushBackLayer）与 Esc。
  // onpick(item, rect, radius)：rect 是被点那枚图标的视口矩形，调用方拿它当转场起点（入口长成分页）。
  import { setContext, onMount } from 'svelte';
  import Sheet from '../ios27/Sheet.svelte';
  import { ui } from '../../lib/state.svelte.js';
  import { builtinHomeIcon } from '../../lib/homeLayout.svelte.js';
  import { appIconUrl } from '../../lib/pluginApps.svelte.js';
  import { uiIcon } from '../../lib/pluginUi.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { t } from '../../lib/i18n.js';
  import '../ios27/ink.css';

  let { items = [], onpick, onclose, anchor = null } = $props();

  const dark = $derived(ui.theme !== 'light');
  setContext('ios27', { get dark() { return dark; }, ink: true });

  let vw = $state(typeof innerWidth === 'number' ? innerWidth : 390);
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const mode = $derived(anchor ? 'dock' : coarse || vw < 700 ? 'sheet' : 'panel');

  $effect(() => pushBackLayer(() => onclose?.()));

  function iconOf(it) {
    if (it.kind === 'app') {
      const url = appIconUrl(it.app, !dark);
      return url ? { img: url } : { svg: uiIcon(it.app?.icon?.name) };
    }
    return { img: builtinHomeIcon(it.key, { light: !dark, taskDone: ui.taskDone }) };
  }
  function pick(it, e) {
    const ic = e.currentTarget.querySelector('.hm-ic');
    const r = ic?.getBoundingClientRect();
    onpick?.(it, r ? { x: r.left, y: r.top, w: r.width, h: r.height } : null, 14);
  }

  // 面板 / Dock 弹层：开出来焦点落到第一项，Esc 关掉、焦点还给「更多」按钮
  let boxEl = $state();
  $effect(() => { if (boxEl && mode !== 'sheet') boxEl.querySelector('.hm-it')?.focus({ preventScroll: true }); });
  function onKey(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault(); e.stopPropagation();
    onclose?.();
    anchor?.focus?.({ preventScroll: true });
  }

  // Dock 弹层的位置：水平对着锚点居中（夹在屏幕内），底边在锚点上方 14px
  let pos = $state(null);
  const PANEL_W = 360;
  function place() {
    if (!anchor?.getBoundingClientRect) { pos = null; return; }
    const r = anchor.getBoundingClientRect();
    const w = Math.min(PANEL_W, innerWidth - 24);
    const left = Math.max(12, Math.min(innerWidth - w - 12, r.left + r.width / 2 - w / 2));
    pos = { left, bottom: Math.max(12, innerHeight - r.top + 14), w, ox: r.left + r.width / 2 - left };
  }
  onMount(() => {
    place();
    const onR = () => { vw = innerWidth; place(); };
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  });
</script>

{#snippet grid()}
  <div class="hm-grid">
    {#each items as it (it.key)}
      {@const ic = iconOf(it)}
      {@const badge = it.kind === 'app' ? String(it.app?.badge || '') : ''}
      <button class="hm-it" type="button" onclick={(e) => pick(it, e)}
        aria-label={badge ? t('{name}（{badge}）', { name: it.label, badge }) : it.label}>
        <span class="hm-ic" aria-hidden="true">
          {#if ic.img}<img src={ic.img} alt="" draggable="false" />{:else}{@html ic.svg}{/if}
          {#if badge}<span class="hm-badge">{badge}</span>{/if}
        </span>
        <span class="hm-l" aria-hidden="true">{it.label}</span>
      </button>
    {/each}
  </div>
{/snippet}

{#if mode === 'sheet'}
  <div class="i27ink hm-sheet" class:dark>
    <Sheet title={t('更多')} closeLabel={t('关闭')} {onclose}>
      {@render grid()}
    </Sheet>
  </div>
{:else}
  <div class="i27ink hm-root" class:dark class:dock={mode === 'dock'} role="presentation" onkeydown={onKey}>
    <button class="hm-dim" type="button" tabindex="-1" aria-label={t('关闭')} onclick={() => onclose?.()}></button>
    <div class="hm-box" role="dialog" aria-modal="true" aria-label={t('更多')} tabindex="-1" bind:this={boxEl}
      style:left={mode === 'dock' && pos ? pos.left + 'px' : null}
      style:bottom={mode === 'dock' && pos ? pos.bottom + 'px' : null}
      style:width={mode === 'dock' && pos ? pos.w + 'px' : null}
      style:transform-origin={mode === 'dock' && pos ? `${pos.ox}px 100%` : null}>
      <div class="hm-title">{t('更多')}</div>
      {@render grid()}
    </div>
  </div>
{/if}

<style>
  /* 图标网格：4 列，图标 = 圆角小方块里一枚 logo（同 iOS 资源库文件夹），名字一行省略 */
  .hm-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px 8px; padding: 6px 2px 4px; }
  .hm-it {
    display: flex; flex-direction: column; align-items: center; gap: 7px; min-width: 0; padding: 4px 0; border: 0; border-radius: 14px;
    background: none; color: var(--i-label); font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent;
    -webkit-touch-callout: none; user-select: none; -webkit-user-select: none;
  }
  .hm-it:focus-visible { outline: 2px solid var(--i-label3); outline-offset: 2px; }
  .hm-ic {
    position: relative; width: 56px; height: 56px; border-radius: 14px; display: grid; place-items: center;
    background: var(--i-tile); color: var(--i-tile-ink);
    transition: transform var(--mo-tap, .09s) var(--ea-out, ease-out);
  }
  .hm-it:active .hm-ic { transform: scale(.93); }
  .hm-ic img { width: 34px; height: 34px; object-fit: contain; }
  .hm-ic :global(svg) { width: 26px; height: 26px; }
  .hm-badge {
    position: absolute; top: -5px; right: -5px; min-width: 18px; height: 18px; padding: 0 5px; box-sizing: border-box; border-radius: 9px;
    background: #ff3b30; color: #fff; font-size: 11px; line-height: 18px; font-weight: 600; text-align: center; font-variant-numeric: tabular-nums;
  }
  .hm-l { max-width: 100%; font-size: 12px; line-height: 15px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

  /* 面板 / Dock 弹层：主页卡片同款毛玻璃 */
  .hm-root { position: fixed; inset: 0; z-index: 90; font-family: var(--sans); }
  .hm-dim { position: absolute; inset: 0; border: 0; padding: 0; cursor: default; background: var(--i-dim); animation: hm-fade var(--mo-quick, .2s) var(--ea-fade, ease) both; }
  .hm-root.dock .hm-dim { background: transparent; }
  .hm-box {
    position: absolute; left: 50%; top: 50%; width: min(420px, calc(100vw - 48px)); box-sizing: border-box;
    transform: translate(-50%, -50%); padding: 14px 16px 16px; border-radius: 26px; color: var(--i-label); outline: none;
    background: rgba(246, 246, 246, .72);
    -webkit-backdrop-filter: blur(22px) saturate(1.5); backdrop-filter: blur(22px) saturate(1.5);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .55), 0 0 0 .5px rgba(0, 0, 0, .06), 0 18px 48px rgba(0, 0, 0, .22);
    animation: hm-pop var(--mo-base, .28s) var(--ea-decel, cubic-bezier(.2, .8, .2, 1)) both;
  }
  .dark .hm-box {
    background: rgba(27, 27, 29, .7);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .1), 0 0 0 .5px rgba(255, 255, 255, .08), 0 18px 48px rgba(0, 0, 0, .42);
  }
  .hm-root.dock .hm-box { top: auto; transform: none; animation-name: hm-rise; }
  .hm-title { padding: 2px 4px 10px; font-size: 13px; line-height: 16px; font-weight: 600; color: var(--i-label2); }
  @keyframes hm-fade { from { opacity: 0; } }
  @keyframes hm-pop { from { opacity: 0; transform: translate(-50%, -50%) scale(.96); } }
  @keyframes hm-rise { from { opacity: 0; transform: translateY(8px) scale(.97); } }
  @media (hover: hover) {
    .hm-it:hover .hm-ic { background: var(--i-fill2); }
  }
</style>
