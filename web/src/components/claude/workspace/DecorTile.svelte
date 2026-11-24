<script>
  // 项目行右端的连接器方块 + 悬停说明（Claude 风格的深色小卡：插件给的 card 压成几行字）。
  // 鼠标：停 150ms 出、离开就收；触屏：点一下出 / 再点或点别处收（触屏没有悬停）。
  // 说明挂到 body 上：手机抽屉带 transform，fixed 定位在它里面会以抽屉为参照。
  import AgentTile from './AgentTile.svelte';
  import { tipOf, peerOf, tileMark, clock } from './decor.js';
  import { useNowTick, sinceSeconds, openTarget } from '../../../lib/pluginUi.svelte.js';
  import { t } from '../../../lib/i18n.js';

  let { item, size = 20 } = $props();

  const peer = $derived(peerOf(item));
  const mark = $derived(tileMark(item));
  const tip = $derived(tipOf(item));
  let open = $state(false);
  let pos = $state({ left: 0, top: 0, up: false });
  let btn = $state(null);
  let timer = 0;

  function place() {
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const w = Math.min(260, innerWidth - 16);
    const up = innerHeight - r.bottom < 140;
    pos = { left: Math.max(8, Math.min(r.left - 8, innerWidth - w - 8)), top: up ? r.top - 6 : r.bottom + 6, up };
  }
  function show() { place(); open = true; }
  function hide() { clearTimeout(timer); open = false; }
  function enter(e) { if (e.pointerType !== 'mouse') return; clearTimeout(timer); timer = setTimeout(show, 150); }
  function leave(e) { if (e.pointerType === 'mouse') hide(); }
  let lastType = '';
  // 点一下去哪由插件定（条目的 open，如 { folder: { agent, path } } = 跳到对方分页的这个文件夹）；没给 open 就不跳，
  // 触屏点一下照旧开关说明。说明：鼠标靠悬停；有 open 时触屏靠长按（长按后的那次点击不算跳转）
  const jumps = $derived(!!item?.open);
  let holdT = 0;
  let held = false;
  function down(e) {
    lastType = e.pointerType;
    held = false;
    clearTimeout(holdT);
    if (e.pointerType !== 'mouse' && jumps) holdT = setTimeout(() => { held = true; show(); }, 450);
  }
  function up() { clearTimeout(holdT); }
  function tap(e) {
    e.stopPropagation();
    if (held) { held = false; return; }
    if (!jumps) { if (lastType === 'mouse') return; if (open) hide(); else show(); return; }
    hide();
    openTarget(item.open, { plugin: item.plugin, path: item.path, agent: 'claude' });
  }

  // 有要走秒的行才挂时钟；说明收起就撤
  const ticking = $derived(open && tip.lines.some((l) => l.since));
  $effect(() => { if (ticking) return useNowTick(); });
  // 触屏点开后，点别处 / 滚动就收
  $effect(() => {
    if (!open) return;
    const off = (e) => { if (!btn?.contains(e.target)) hide(); };
    addEventListener('pointerdown', off, true);
    addEventListener('scroll', hide, true);
    return () => { removeEventListener('pointerdown', off, true); removeEventListener('scroll', hide, true); };
  });
  $effect(() => () => { clearTimeout(timer); clearTimeout(holdT); });

  function portal(node) {
    document.body.appendChild(node);
    return { destroy() { node.remove(); } };
  }
</script>

{#if peer}
  <button class="dtile" class:jumps bind:this={btn} type="button" aria-label={jumps ? t('到 {name} 的这个文件夹', { name: peer === 'agy' ? 'Antigravity' : 'Claude' }) : (tip.title || t('共用的文件夹'))}
    onpointerdown={down} onpointerup={up} onpointercancel={up} oncontextmenu={(e) => { if (lastType !== 'mouse') e.preventDefault(); }}
    onpointerenter={enter} onpointerleave={leave} onclick={tap}
    onfocus={(e) => { if (e.currentTarget.matches(':focus-visible')) show(); }} onblur={hide}>
    <AgentTile agent={peer} {size} {mark} />
  </button>
{/if}

{#if open && (tip.title || tip.lines.length)}
  <!-- 同一个 .cc-tone：挂到 body 上之后取不到 Claude 页的令牌，在这里补上 -->
  <div class="cc-tone dtip" class:up={pos.up} style="left:{pos.left}px;top:{pos.top}px" role="tooltip" use:portal>
    {#if tip.title}<b>{tip.title}</b>{/if}
    {#each tip.lines as l, i (i)}
      <span class="ln" class:mono={l.mono}>{l.text}{#if l.since}<span class="num">{' · '}{clock(sinceSeconds(l.since))}</span>{/if}</span>
    {/each}
  </div>
{/if}

<style>
  .dtile { flex: none; display: inline-grid; place-items: center; width: 28px; height: 28px; margin: 0 2px 0 0; padding: 0; border: 0; background: none; border-radius: 6px; cursor: default; transition: background 60ms cubic-bezier(.165, .84, .44, 1); }
  @media (pointer: coarse) { .dtile { cursor: pointer; } }
  .dtile.jumps { cursor: pointer; }
  .dtile.jumps:hover { background: var(--hover); }
  .dtile.jumps:active { background: var(--hover-strong, var(--hover)); }
  /* 说明：深底浅字，两套主题都是深底（官方 Tooltip 的写法），120ms 淡入并上浮 2px，不发光 */
  .dtip { position: fixed; z-index: 360; max-width: min(260px, calc(100vw - 16px)); padding: 8px 10px; border-radius: 8px;
    background: var(--cc-tip); color: #f2f2f2; font-size: 12px; line-height: 1.55; pointer-events: none;
    display: flex; flex-direction: column; gap: 0; box-shadow: 0 4px 14px rgba(0, 0, 0, .18);
    animation: dtipIn 120ms cubic-bezier(.165, .84, .44, 1) both; }
  .dtip.up { transform: translateY(-100%); animation-name: dtipUp; }
  .dtip b { font-weight: 500; }
  .dtip .ln { color: #b5b5b5; overflow-wrap: anywhere; }
  .dtip .num { font-variant-numeric: tabular-nums; }
  .dtip .mono { font-family: "Anthropic Mono", ui-monospace, Consolas, monospace; font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  @keyframes dtipIn { from { opacity: 0; translate: 0 2px; } }
  @keyframes dtipUp { from { opacity: 0; translate: 0 -2px; } }
  @media (prefers-reduced-motion: reduce) { .dtip { animation: none; } }
</style>
