<script>
  // 共用卡（M3 弹层）：悬停文件夹标题右端的头像组（触屏长按）弹出，内容全是插件的 card 声明——
  // 头部头像组 + 标题 / 路径，若干分节（标签 + 链接 + 行），底部一行说明 + 链接。鼠标能从头像组移进卡里点。
  // 进场：淡入 130ms + 从 0.97 / 上移 4px 落位（减速曲线，原点对着头像组）；退场更短、用加速曲线。
  import { decorFor, openTarget, useNowTick, sinceSeconds } from '../../lib/pluginUi.svelte.js';
  import { pluginIcon } from '../../lib/pluginIcons.js';
  import { tr, t } from '../../lib/i18n.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { decorCard, cardKeep, cardHoverOut, closeCard } from '../../lib/agy/decor-card.svelte.js';
  import { duoPeers, fmtElapsed } from '../../lib/agy/decor-view.js';
  import { agyLogoSvg } from '../../lib/agy/peer-marks.js';
  import AgyPeerDuo from './AgyPeerDuo.svelte';
  import AgyClaudeThink from './AgyClaudeThink.svelte';
  import AgyWorkingMark from './AgyWorkingMark.svelte';

  const { projectIdOf = () => null } = $props();

  const decor = $derived(decorCard.open ? decorFor('agy', decorCard.path) : null);
  // 关的时候留着最后那份画退场
  let shown = $state(null);
  let on = $state(false);
  let cardEl = $state(null);
  let place = $state({ left: 8, top: 8, ox: 0, oy: 0, up: false });
  let hideTimer = 0;

  $effect(() => {
    const d = decor;
    if (d && d.card) {
      clearTimeout(hideTimer);
      shown = d;
      requestAnimationFrame(() => { measure(); on = true; });
    } else if (shown) {
      on = false;
      hideTimer = setTimeout(() => { shown = null; }, 130);
    }
  });
  $effect(() => {
    if (!shown || !decorCard.pinned) return;
    return pushBackLayer(() => closeCard());
  });
  $effect(() => {
    if (!shown) return;
    return useNowTick();
  });

  function portal(node) {
    const host = document.querySelector('.agy-root') || document.body;
    host.appendChild(node);
    return { destroy() { node.remove(); } };
  }

  function measure() {
    const a = decorCard.anchor;
    if (!a?.isConnected || !cardEl) return;
    const r = a.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = cardEl.offsetWidth || 296, h = cardEl.offsetHeight || 200;
    const left = Math.max(8, Math.min(r.left - 22, vw - w - 8));
    const up = r.bottom + 8 + h > vh - 8 && r.top - 8 - h > 8;
    const top = up ? r.top - 8 - h : r.bottom + 8;
    place = { left: Math.round(left), top: Math.round(top), ox: Math.round(r.left + r.width / 2 - left), oy: up ? h : 0, up };
  }

  // 触屏钉住时点卡外面就关（点头像组本身由外层处理）
  $effect(() => {
    if (!shown || !decorCard.pinned) return;
    const down = (e) => {
      if (cardEl?.contains(e.target) || decorCard.anchor?.contains?.(e.target)) return;
      closeCard();
    };
    window.addEventListener('pointerdown', down, true);
    return () => window.removeEventListener('pointerdown', down, true);
  });

  function go(target) {
    if (!target || !shown) return;
    const ctx = { plugin: shown.plugin, path: shown.path, agent: 'agy', projectId: projectIdOf(shown.path) };
    closeCard();
    openTarget(target, ctx);
  }

  const rowMeta = (r) => (r.live && r.since ? fmtElapsed(sinceSeconds(r.since)) : tr(r.meta || ''));
</script>

{#if shown?.card}
  {@const c = shown.card}
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    use:portal
    bind:this={cardEl}
    class="agy-dc"
    class:on
    class:up={place.up}
    role="dialog"
    tabindex="-1"
    aria-label={tr(c.title || '') || t('共用文件夹')}
    style:left="{place.left}px"
    style:top="{place.top}px"
    style:transform-origin="{place.ox}px {place.oy}px"
    onpointerenter={cardKeep}
    onpointerleave={(e) => { if (e.pointerType === 'mouse') cardHoverOut(); }}
  >
    <div class="dc-h">
      <AgyPeerDuo peers={duoPeers(shown)} busy={shown.busy} size={30} cut="var(--ag-pop-bg)" />
      <span class="tx">
        {#if c.title}<b>{tr(c.title)}</b>{/if}
        {#if c.subtitle}<span title={c.subtitle}>{tr(c.subtitle)}</span>{/if}
        {#if shown.note}<span class="note">{tr(shown.note)}</span>{/if}
      </span>
    </div>
    {#each c.sections as sec, si (si)}
      <div class="dc-sec">
        {#if sec.label || sec.link}
          <div class="dc-l">
            <span>{tr(sec.label || '')}</span>
            {#if sec.link}<button type="button" onclick={() => go(sec.link.open)}>{tr(sec.link.label)}</button>{/if}
          </div>
        {/if}
        {#each sec.rows as r, ri (ri)}
          <button type="button" class="dc-r" class:link={!!r.open} disabled={!r.open} onclick={() => go(r.open)}>
            <span class="gi" class:clay={r.agent === 'claude' && (r.live || !r.icon)}>
              <!-- 在干活的 agent 画它自己的动态标志；否则插件给了图标就画图标，没给才画 agent 的静态标志 -->
              {#if r.live && r.agent === 'claude'}
                <AgyClaudeThink live size={15} />
              {:else if r.live && r.agent === 'agy'}
                <AgyWorkingMark mark="writing" size={15} />
              {:else if !r.icon && r.agent === 'claude'}
                <AgyClaudeThink live={false} size={13} />
              {:else if !r.icon && r.agent === 'agy'}
                <span class="agl">{@html agyLogoSvg(14)}</span>
              {:else}
                <span class="pi">{@html pluginIcon(r.icon || 'plugin')}</span>
              {/if}
            </span>
            <span class="t" class:mono={r.mono} title={r.text}>{tr(r.text)}</span>
            {#if r.meta || (r.live && r.since)}<span class="m" class:num={r.live && r.since}>{rowMeta(r)}</span>{/if}
          </button>
        {/each}
      </div>
    {/each}
    {#if c.foot}
      <div class="dc-f">
        <span class="ft">{tr(c.foot.text || '')}</span>
        {#if c.foot.link}<button type="button" onclick={() => go(c.foot.link.open)}>{tr(c.foot.link.label)}</button>{/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .agy-dc {
    position: fixed;
    z-index: 95;
    width: 296px;
    max-width: calc(100vw - 16px);
    border-radius: 18px;
    background: var(--ag-pop-bg);
    box-shadow: var(--ag-elev-shadow);
    padding: 6px 6px 4px;
    color: var(--ag-on);
    font-size: 12.5px;
    opacity: 0;
    transform: translateY(-4px) scale(0.97);
    pointer-events: none;
    transition: opacity 100ms var(--ag-ease-std), transform 120ms cubic-bezier(0.3, 0, 0.8, 0.15);
  }
  .agy-dc.up { transform: translateY(4px) scale(0.97); }
  .agy-dc.on {
    opacity: 1;
    transform: none;
    pointer-events: auto;
    transition: opacity 130ms var(--ag-ease-std), transform 220ms var(--ag-ease-decel);
  }
  .dc-h { display: flex; gap: 12px; align-items: center; padding: 10px 10px 12px; }
  .dc-h .tx { min-width: 0; display: flex; flex-direction: column; }
  .dc-h .tx > b { font-size: 14px; font-weight: 500; }
  .dc-h .tx > span { font-size: 11.5px; color: var(--ag-on-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dc-h .tx > .note { color: var(--ag-on-dim); }
  .dc-sec { border-radius: 12px; background: var(--ag-pop-sec); padding: 2px 4px 4px; margin-bottom: 4px; }
  .dc-l {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    font-size: 11.5px;
    color: var(--ag-on-faint);
    padding: 8px 8px 4px;
    font-weight: 500;
  }
  .dc-l button { color: var(--ag-accent); font-weight: 500; font-size: 11.5px; }
  .dc-r {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    min-height: 32px;
    padding: 0 8px;
    border-radius: 9px;
    color: var(--ag-on-sub);
    text-align: left;
    cursor: default;
  }
  .dc-r:disabled { opacity: 1; }
  .dc-r.link { cursor: pointer; }
  .dc-r.link:hover { background: var(--ag-hover); }
  .gi { width: 16px; flex: none; display: grid; place-items: center; color: var(--ag-on-faint); }
  .gi.clay { color: var(--ag-clay); }
  .gi .pi, .gi .agl { display: grid; place-items: center; width: 15px; height: 15px; }
  .gi .pi :global(svg) { width: 15px; height: 15px; }
  .gi .agl :global(svg) { width: 14px; height: 14px; }
  .dc-r .t { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dc-r .t.mono { font-family: var(--ag-mono); font-size: 11.5px; }
  .dc-r .m { font-size: 11.5px; color: var(--ag-on-faint); flex: none; }
  .dc-r .m.num { font-variant-numeric: tabular-nums; }
  .dc-f { display: flex; align-items: center; gap: 6px; padding: 6px 6px 4px 10px; font-size: 12px; color: var(--ag-on-dim); }
  .dc-f .ft { flex: 1; min-width: 0; }
  .dc-f button { color: var(--ag-accent); font-weight: 500; padding: 6px 10px; border-radius: 16px; flex: none; }
  .dc-f button:hover, .dc-l button:hover { background: var(--ag-accent-soft); }
  .dc-l button { padding: 2px 6px; margin: -2px -6px; border-radius: 8px; }

  :global(.agy-root.ag-compact) .agy-dc { font-size: 13.5px; }
  :global(.agy-root.ag-compact) .dc-r { min-height: 40px; }

  @media (prefers-reduced-motion: reduce) {
    .agy-dc, .agy-dc.on { transition: opacity 1ms; transform: none; }
  }
</style>
