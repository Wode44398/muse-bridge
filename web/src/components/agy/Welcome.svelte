<script>
  // 欢迎空态：中央仅保留纯净的 Antigravity 徽标；仅在离线、未登录或守护进程异常时在下方浮现诊断横幅。
  // 徽标由液态引擎直接提供同源哑光桌面漫反射（glow="hero"）与悬停/按压微交互；点击即可丝滑切换明暗主题，
  // 发出第一条消息时整颗经 hero.js 接力飞入底部状态栏。
  import { t } from '../../lib/i18n.js';
  import { toggleAgyTheme, agyIsDark } from '../../lib/agy/theme-toggle.js';
  import AgyStateBanner from './AgyStateBanner.svelte';
  import AgyWorkingMark from './AgyWorkingMark.svelte';
  import { haptic } from '../../lib/dragdrop.svelte.js';
  import { ditherTile } from '../../lib/agy/dither.js';

  // compact：手机档——图标独占上方空白，放大一档
  const { compact = false } = $props();

  const BASE = import.meta.env.BASE_URL;
  // 光晕去色带：很淡的大模糊在 8 位色深下量化成一圈圈同心台阶（高分屏尤其明显）→ 盖一层逐设备像素的
  // 抖动噪点（lib/agy/dither.js）。瓦片按设备像素 1:1 铺（背景尺寸 = 瓦片 / dpr），放大了就成颗粒了。
  const TILE = 96;
  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  // 幅度：色带的台阶就是 1 级。浅色底压到 3/255 也看不出颗粒；深色底只给 2/255，再大会看出一片发灰
  const ditherK = typeof document !== 'undefined' ? ditherTile('k', TILE, 3) : '';
  const ditherW = typeof document !== 'undefined' ? ditherTile('w', TILE, 2) : '';
  const themeLabel = $derived(agyIsDark() ? t('切换浅色主题') : t('切换深色主题'));
</script>

<div class="agy-welcome">
  <div
    class="agy-mark-wrap"
    class:big={compact}
    style:--agy-dither-k={ditherK ? `url(${ditherK})` : null}
    style:--agy-dither-w={ditherW ? `url(${ditherW})` : null}
    style:--agy-dither-size="{TILE / dpr}px"
    style:--agy-mark-size="{compact ? 64 : 52}px"
  >
    <AgyWorkingMark
      mark="ambient"
      size={compact ? 64 : 52}
      hero="welcome"
      intro="entrance"
      glow="hero"
      interactive
      onpress={(el) => { haptic('tick'); toggleAgyTheme(el); }}
      label={themeLabel}
      fallback="{BASE}assets/icons/antigravity.svg"
    />
  </div>
  <div class="agy-welcome-banner">
    <AgyStateBanner />
  </div>
</div>

<style>
  .agy-welcome {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
    padding: 0 16px 26px;
  }
  .agy-mark-wrap {
    width: 68px;
    height: 68px;
    display: flex;
    align-items: center;
    justify-content: center;
    user-select: none;
    position: relative;
  }
  .agy-mark-wrap.big {
    width: 84px;
    height: 84px;
  }
  /* 抖动噪点：盖到光晕最外一圈为止（实测光晕半径约 1.5 个图标、中心略偏下——最外那道台阶最显眼，必须盖住），
     再往外很快径向淡出；不挡点击。别盖太大：噪点只能单向抬 / 压亮度，铺到纯底色上就成了一圈看得出的灰盘 */
  .agy-mark-wrap::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 58%;
    width: calc(var(--agy-mark-size, 52px) * 3.8);
    height: calc(var(--agy-mark-size, 52px) * 3.8);
    transform: translate(-50%, -50%);
    background-image: var(--agy-dither-w, none);
    background-size: var(--agy-dither-size, 32px) var(--agy-dither-size, 32px);
    image-rendering: pixelated;
    -webkit-mask-image: radial-gradient(closest-side, #000 80%, transparent 100%);
    mask-image: radial-gradient(closest-side, #000 80%, transparent 100%);
    pointer-events: none;
    z-index: 1;
  }
  :global(.agy-root.light) .agy-mark-wrap::after { background-image: var(--agy-dither-k, none); }
  /* 静态图兜底时的淡入（引擎就绪时由引擎自己的入场动画接管） */
  .agy-mark-wrap :global(.agy-mark-fb) {
    animation: agy-mark-in var(--ag-dur-base) var(--ag-ease-decel) both;
  }
  @keyframes agy-mark-in {
    from { opacity: 0; transform: translateY(5px) scale(0.96); }
  }
  .agy-welcome-banner {
    width: min(var(--ag-col), 100%);
  }
  .agy-welcome-banner:empty {
    display: none;
  }
</style>
