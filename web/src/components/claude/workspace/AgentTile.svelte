<script module>
  // 引擎 116KB、归 agy 扩展（web/scripts/module-chunks.mjs 把它登记成 agy 的懒加载入口）：只在 agy 开着、
  // 第一次真要画标志时取——没装 agy 的基础版里没有这个 chunk，去取会触发 vite:preloadError 整页刷新。
  // 取到之后新挂的方块同步就能用。
  import { agentOn } from '../../../lib/state.svelte.js';
  let engine = globalThis.AntigravityLogo || null;
  let loading = null;
  function loadEngine() {
    if (engine) return Promise.resolve(engine);
    if (!agentOn('agy')) return Promise.resolve(null);
    if (!loading) loading = import('../../../lib/agy/antigravity-logo.js').then(() => (engine = globalThis.AntigravityLogo || null)).catch(() => null);
    return loading;
  }
  const STATIC_LOGO = import.meta.env.BASE_URL + 'assets/icons/antigravity.svg';
</script>

<script>
  // 连接器方块：Claude 里第三方应用（连接器）图标的写法——圆角方块 + 1px 描边，里面是对方的官方标志。
  // agent = 'agy'：Antigravity 标志走它自己的引擎（lib/agy/antigravity-logo.js），mark 是引擎状态；
  //   在跑用 'writing'——'thinking' 在 20px 以下只剩一个蓝点，读不出是谁。
  // agent = 'claude'：官方星芒（lib/claudeSpark.js，陶土色）。
  // bare：只画标志、不要方块（行尾「在跑」旁边那枚）；mono：单色（跟 currentColor，菜单图标用）。
  // 引擎取不到（agy 没开 / 没装）时画静态标志（核心自带的 assets/icons/antigravity.svg），不动。
  import { untrack } from 'svelte';
  import ClaudeSpark from './ClaudeSpark.svelte';

  let { agent = 'agy', size = 20, mark = 'static', bare = false, mono = false } = $props();

  const inner = $derived(Math.round(size * (bare ? 1 : 0.72)));
  let host = $state(null);
  let ctl = null;
  let applied = '';
  let fallback = $state(false);

  $effect(() => {
    if (agent !== 'agy' || !host) return;
    const el = host;
    let dead = false;
    const mount = (api) => {
      if (dead) return;
      if (!api) { fallback = true; return; }
      fallback = false;
      // 挂载只认当时的状态：之后换状态走下面的 setState（引擎自己过渡），不重建
      const [m, mo] = untrack(() => [mark, mono]);
      applied = m;
      // 引擎会把挂载点的宽高改成 size（100%），所以挂在里面另建的一层上，外层尺寸归我们管
      const box = document.createElement('span');
      box.className = 'at-box';
      el.appendChild(box);
      try { ctl = api.mount(box, { state: m, size: '100%', glow: '', skipEnter: true, palette: mo ? 'currentColor' : 'spectral' }); }
      catch (e) { console.warn('[AgentTile]', e?.message || e); }   // i18n-ignore 只进控制台
    };
    if (engine) mount(engine); else loadEngine().then(mount);
    return () => { dead = true; try { ctl?.destroy(); } catch {} ctl = null; applied = ''; el.replaceChildren(); };
  });
  $effect(() => {
    const m = mark;
    if (ctl && m !== applied) { applied = m; try { ctl.setState(m); } catch {} }
  });
</script>

<span class="atile" class:bare style="--t:{size}px;--l:{inner}px" aria-hidden="true">
  {#if agent === 'agy'}
    <span class="at-lg" bind:this={host}></span>
    {#if fallback}<span class="at-fb" class:mono style="--src:url('{STATIC_LOGO}')"></span>{/if}
  {:else}
    <span class="at-cl" class:mono><ClaudeSpark size={inner} /></span>
  {/if}
</span>

<style>
  .atile { width: var(--t); height: var(--t); flex: none; display: inline-grid; place-items: center; position: relative;
    border-radius: calc(var(--t) * .28); background: var(--cc-tile); box-shadow: inset 0 0 0 1px var(--cc-ring);
    /* 引擎里挖空的部分取 --ag-hole：方块底色，不然暗色会露出 agy 页的底 */
    --ag-hole: var(--cc-tile); line-height: 0; }
  .atile.bare { background: none; box-shadow: none; border-radius: 0; --ag-hole: var(--bg); }
  /* 类名别用 .lg：全局有一套同名的液态玻璃样式 */
  .at-lg { width: var(--l); height: var(--l); display: block; position: relative; }
  .at-lg :global(.at-box) { position: absolute; inset: 0; display: block; }
  .at-lg :global(svg) { display: block; width: 100%; height: 100%; overflow: visible; }
  .at-cl { display: inline-flex; color: var(--coral); }
  .at-cl.mono { color: inherit; }
  .at-fb { position: absolute; inset: 0; margin: auto; width: var(--l); height: var(--l); background: var(--src) center / contain no-repeat; }
  .at-fb.mono { background: currentColor; -webkit-mask: var(--src) center / contain no-repeat; mask: var(--src) center / contain no-repeat; }
</style>
