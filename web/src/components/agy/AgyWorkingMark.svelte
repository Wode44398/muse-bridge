<script>
  // Antigravity 反重力液态极光动效标记（引擎见 lib/agy/antigravity-logo.js）。
  // hero：参与页面级 logo 接力（lib/agy/hero.js）——'welcome' = 欢迎页中央那颗，'foot' = 这一轮
  //   底部状态栏那颗。切换时同一个引擎实例从一处飞到另一处，不重建、不闪。
  // intro：引擎已就绪时挂载先播一次性入场，经原生 then 无缝落回目标 mark；fallback：引擎加载前的静态图兜底。
  // glow：'hero'（欢迎页桌面漫反射）| 'subtle'（运行态微反光）| '' / 'none'（关闭）。
  // interactive + onpress：悬停微交互与按压软弹由引擎驱动，点击由外层按钮触发 onpress(outer)（如切换明暗主题）。
  import { onMount } from 'svelte';
  import { registerHeroMark, takeHero } from '../../lib/agy/hero.js';
  import { reducedMotion } from '../../lib/agy/motion.js';

  // prop 不能叫 state：会和 $state 符文撞名（Svelte 把 $state 当成 store 订阅）
  const {
    mark = 'static',
    size = 22,
    effort = 'medium',
    hero = '',
    intro = '',
    fallback = '',
    glow = '',
    interactive = false,
    onpress = null,
    onstate = null,
    label = '',
  } = $props();

  let outer = $state(null);
  let ctl = $state(null);
  let box = null;           // 引擎的盒子（接力时整颗搬走 / 搬来）
  let handed = false;       // 实例已交给别处：不再驱动、卸载时不销毁
  let landing = false;      // 正在飞来：落地前占位保持空
  let showFallback = $state(false);
  let appliedMark = '';     // 记下已同步给引擎的目标态，避免挂载首帧打断 intro → then

  function handleEngineState(name, phase) {
    if (handed) return;
    if (name === 'static' && phase === 'loop') appliedMark = 'static';
    onstate?.(name, phase);
  }

  function mountEngine(api, first) {
    box = document.createElement('span');
    box.className = 'agy-mark-box';
    outer.appendChild(box);
    const useIntro = Boolean(first && intro && !reducedMotion() && intro !== mark);
    const start = useIntro ? intro : mark;
    appliedMark = mark;
    ctl = api.mount(box, {
      state: start,
      then: useIntro ? mark : null,
      size: '100%',
      effort,
      palette: 'spectral',
      glow,
      interactive,
      onStateChange: handleEngineState,
    });
    showFallback = false;
  }

  function handlePress() {
    if (onpress && outer) onpress(outer);
  }

  onMount(() => {
    let dead = false;
    let cancelFlight = null;
    const unreg = hero ? registerHeroMark({
      role: hero,
      outer: () => outer,
      box: () => box,
      ctl: () => (handed ? null : ctl),
      release: () => {
        handed = true;
        // 交出飞行前清空悬停/按压态与旧状态回调，避免跨区接力后悬停卡死或回调打到已卸载组件
        try { if (ctl) ctl.onStateChange = null; } catch {}
        try { ctl?.setInteractive?.(false); } catch {}
        ctl = null;
      },
    }) : null;

    if (hero) {
      cancelFlight = takeHero(hero, {
        target: () => (outer?.isConnected ? outer.getBoundingClientRect() : null),
        onFlight: (c) => {
          landing = true;
          try {
            c.setState(mark);
            c.setEffort(effort);
            c.setGlow?.(glow);
          } catch {}
        },
        onLand: (b, c) => {
          landing = false;
          if (dead) { try { c.destroy(); } catch {} return; }
          box = b;
          outer.appendChild(b);
          appliedMark = mark;
          ctl = c;
          c.onStateChange = handleEngineState;
          try {
            c.setState(mark);
            c.setEffort(effort);
            c.setGlow?.(glow);
            c.setInteractive?.(interactive);
          } catch {}
        },
      });
    }

    if (!cancelFlight) {
      const api = globalThis.AntigravityLogo;
      if (api) mountEngine(api, true);
      else {
        if (fallback) showFallback = true;
        import('../../lib/agy/antigravity-logo.js').then(() => {
          const a = globalThis.AntigravityLogo;
          if (dead || !outer || !a || ctl || handed || landing) return;
          // 引擎后到且静态图已就位时静默接管，不再补播入场
          mountEngine(a, !showFallback);
        }).catch(() => {});
      }
    }

    return () => {
      dead = true;
      unreg?.();
      if (landing && cancelFlight) cancelFlight();
      if (!handed) { try { ctl?.destroy(); } catch {} }
      ctl = null;
    };
  });

  $effect(() => {
    const s = mark;
    if (ctl && !handed && s !== appliedMark) {
      appliedMark = s;
      ctl.setState(s);
    }
  });

  $effect(() => {
    const e = effort;
    if (ctl && !handed) ctl.setEffort(e);
  });

  $effect(() => {
    const g = glow;
    if (ctl && !handed) ctl.setGlow?.(g);
  });

  $effect(() => {
    const on = interactive;
    if (ctl && !handed) ctl.setInteractive?.(on);
  });
</script>

{#if onpress}
  <button
    type="button"
    class="agy-mark interactive"
    bind:this={outer}
    style:width="{size}px"
    style:height="{size}px"
    onclick={handlePress}
    title={label || undefined}
    aria-label={label || 'Antigravity'}
  >
    {#if showFallback}<img class="agy-mark-fb" src={fallback} alt="" draggable="false" />{/if}
  </button>
{:else}
  <span class="agy-mark" bind:this={outer} style:width="{size}px" style:height="{size}px" aria-hidden="true">
    {#if showFallback}<img class="agy-mark-fb" src={fallback} alt="" draggable="false" />{/if}
  </span>
{/if}

<style>
  .agy-mark {
    position: relative;
    display: inline-block;
    flex: none;
    line-height: 0;
    padding: 0;
    border: 0;
    background: none;
    color: var(--ag-accent, #6ea8ff);
    --ag-hole: var(--ag-bg, #131313);
  }
  .agy-mark.interactive {
    cursor: pointer;
    border-radius: 50%;
    touch-action: manipulation;
  }
  /* 小尺寸状态栏图标（22px）扩出无形触控热区，放在 .agy-mark-box 下层避免拦住悬停与按压事件 */
  .agy-mark.interactive::before {
    content: '';
    position: absolute;
    inset: -8px;
    z-index: 0;
  }
  .agy-mark :global(.agy-mark-box) {
    position: relative;
    z-index: 1;
    display: block;
    width: 100%;
    height: 100%;
  }
  .agy-mark :global(svg),
  :global(.agy-hero-fly svg) {
    display: block;
    width: 100%;
    height: 100%;
    overflow: visible;
  }
  :global(.agy-hero-fly .agy-mark-box) {
    display: block;
  }
  .agy-mark-fb {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
</style>
