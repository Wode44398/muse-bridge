<script>
  // 共用文件夹的头像组（Google 协作者头像的写法）：Antigravity 圆在下、Claude 圆叠在上，中间留一圈底色的「缝」。
  //   · agy 圆：液态引擎 static 态的官方标志（离线画成 svg，见 lib/agy/peer-marks.js）；
  //   · Claude 圆：陶土色淡底 + 官方单色星芒（lib/claudeSpark.js）；
  //   · busy 里有谁，谁的圆外圈那道缝里就跑一段 M3 不定进度弧（边转边伸缩）；Claude 的是陶土色，agy 的是强调蓝。
  // cut = 缝的颜色（就是头像所在那块底的颜色：侧栏底板 / 弹层 / 顶栏）。注册过的 --agy-cut 能平滑换色（飞行落地时用）。
  // agyState 给了（对话框 hero）就在 agy 圆里起一个真引擎控制器演这个态（如 entrance → then），控制器经 agyCtl 交出去。
  // 这里只画，不管交互；悬停卡、长按由外层接。
  import { agyLogoSvg, agyLogoReady, ensureAgyLogo } from '../../lib/agy/peer-marks.js';
  import AgyClaudeThink from './AgyClaudeThink.svelte';

  let {
    peers = ['agy', 'claude'],
    busy = [],
    size = 20,
    cut = 'var(--ag-box)',
    tether = false,
    el = $bindable(null),
    agyEl = $bindable(null),
    agyState = '',
    agyThen = '',
    agyCtl = $bindable(null),
    title = '',
  } = $props();

  const hasAgy = $derived(peers.includes('agy'));
  const hasClaude = $derived(peers.includes('claude'));
  const agyBusy = $derived(busy.includes('agy'));
  const claudeBusy = $derived(busy.includes('claude'));

  let ready = $state(agyLogoReady());
  $effect(() => {
    if (ready) return;
    let alive = true;
    ensureAgyLogo().then((ok) => { if (alive && ok) ready = true; });
    return () => { alive = false; };
  });
  const logoPx = $derived(Math.round(size * 0.74));
  const agySvg = $derived(ready && hasAgy && !agyState ? agyLogoSvg(logoPx) : '');

  $effect(() => {
    if (!ready || !agyState || !agyEl) return;
    const api = globalThis.AntigravityLogo;
    if (!api) return;
    let c = null;
    try { c = api.mount(agyEl, { state: agyState, then: agyThen || null, size: logoPx, glow: '' }); } catch {}
    agyCtl = c;
    return () => { try { c?.destroy(); } catch {} agyCtl = null; };
  });
</script>

<span
  bind:this={el}
  class="agy-duo"
  class:solo={!(hasAgy && hasClaude)}
  class:live={agyBusy || claudeBusy}
  style:--s="{size}px"
  style:--agy-cut={cut}
  title={title || undefined}
  aria-hidden={title ? undefined : 'true'}
>
  {#if hasAgy}
    <span class="av av-agy">
      <span class="lg" bind:this={agyEl}>{@html agySvg}</span>
      <svg class="pring" class:on={agyBusy && !claudeBusy} viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /></svg>
    </span>
  {/if}
  {#if tether && hasAgy && hasClaude}<span class="teth" aria-hidden="true"></span>{/if}
  {#if hasClaude}
    <span class="av av-cl">
      <span class="spk"><AgyClaudeThink live={false} size={Math.round(size * 0.6)} /></span>
      <svg class="pring cl" class:on={claudeBusy} viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /></svg>
    </span>
  {/if}
</span>

<style>
  .agy-duo {
    --s: 20px;
    position: relative;
    display: inline-flex;
    align-items: center;
    flex: none;
    transition: --agy-cut 420ms linear;
  }
  .av {
    position: relative;
    width: var(--s);
    height: var(--s);
    border-radius: 50%;
    display: grid;
    place-items: center;
    flex: none;
    box-shadow: 0 0 0 calc(var(--s) * 0.085) var(--agy-cut);
  }
  .av-agy {
    background: var(--ag-av-agy);
    z-index: 1;
  }
  .av-agy::after {
    content: '';
    position: absolute;
    inset: 0;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1px var(--ag-av-agy-bd);
    pointer-events: none;
  }
  .av-cl {
    background: color-mix(in srgb, var(--ag-clay) 19%, var(--agy-cut));
    color: var(--ag-clay);
    margin-left: var(--sep, calc(var(--s) * -0.28));
    z-index: 2;
  }
  .agy-duo.solo .av-cl { margin-left: 0; }
  .lg {
    width: calc(var(--s) * 0.74);
    height: calc(var(--s) * 0.74);
    display: block;
    position: relative;
  }
  .lg :global(svg) {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
  }
  .spk { display: grid; place-items: center; }

  /* 进度弧：跑在头像外圈那道缝里（半径比头像大一圈缝的一半），节奏照 M3 不定进度环：整体匀速转，弧长一伸一缩 */
  .pring {
    position: absolute;
    left: calc(var(--s) * -0.1667);
    top: calc(var(--s) * -0.1667);
    width: calc(var(--s) * 1.3333);
    height: calc(var(--s) * 1.3333);
    opacity: 0;
    pointer-events: none;
    transition: opacity 200ms var(--ag-ease-std);
  }
  .pring circle {
    fill: none;
    stroke: var(--ag-accent);
    stroke-width: 1.5;
    stroke-linecap: round;
    stroke-dasharray: 4 62.2;
    transform-origin: 12px 12px;
  }
  .pring.cl circle { stroke: var(--ag-clay); }
  .pring.on {
    opacity: 1;
    animation: agy-duo-rot 1.6s linear infinite;
  }
  .pring.on circle { animation: agy-duo-arc 1.6s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
  @keyframes agy-duo-rot { to { transform: rotate(360deg); } }
  @keyframes agy-duo-arc {
    0% { stroke-dasharray: 3 62.2; stroke-dashoffset: 0; }
    50% { stroke-dasharray: 34 62.2; stroke-dashoffset: -8; }
    100% { stroke-dasharray: 3 62.2; stroke-dashoffset: -62.2; }
  }

  /* 对话框 hero：两圆分开时中间一串流动的虚点（--sep 由对话框驱动） */
  .teth {
    position: absolute;
    left: calc(var(--s) + 10px);
    top: 50%;
    height: 2px;
    margin-top: -1px;
    width: max(0px, calc(var(--sep, 0px) - 20px));
    background: radial-gradient(circle, var(--ag-on-low) 0 1px, transparent 1.4px) 0 0 / 7px 2px repeat-x;
    animation: agy-duo-teth 1.1s linear infinite;
    transition: opacity 120ms var(--ag-ease-std);
  }
  :global(.agy-duo.joined) .teth { opacity: 0; }
  @keyframes agy-duo-teth { to { background-position: 7px 0; } }

  @media (prefers-reduced-motion: reduce) {
    .pring.on { animation: none; }
    .pring.on circle { animation: none; stroke-dasharray: 22 62.2; }
    .teth { animation: none; }
  }
</style>
