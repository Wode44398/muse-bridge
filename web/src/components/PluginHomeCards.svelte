<script>
  // 主页的插件卡片区（ctx.ui.homeCard，插件接口四期；数据见 lib/pluginUi）：贴在主页底部的一排玻璃卡，
  // 放不下就横向滑（吸附到卡），一张也没有时整块不出现。卡 = 图标 + 标题 + tone 色点 + 角标，下面一行文字、最多 6 个数据项。
  // 点卡按 open 处理：{ panel } 打开插件的控制面板，{ action } 按插件的按钮（只有主机能按），{ url } 外部打开，没有 open 就只是看。
  // 材质：主页登录卡同一套「墨与象牙」令牌（ios27/ink.css）+ 毛玻璃，明暗跟 ui.theme；设置页盖住主页时 Home 会统一撤掉 .card 的 backdrop-filter。
  import { pluginUi, openHomeCard, uiIcon } from '../lib/pluginUi.svelte.js';
  import { ui, me } from '../lib/state.svelte.js';
  import { t } from '../lib/i18n.js';
  import './ios27/ink.css';

  const cards = $derived(me.kind === 'none' ? [] : pluginUi.homeCards);
  const dark = $derived(ui.theme !== 'light');
  const TONE = { ok: t('正常'), warn: t('注意'), error: t('出错'), idle: t('空闲') };
</script>

{#if cards.length}
  <section class="phc i27ink" class:dark aria-label={t('插件卡片')}>
    <div class="phc-row">
      {#each cards as c (c.plugin + '/' + c.id)}
        <svelte:element this={c.open ? 'button' : 'div'} class="card phc-card" class:tap={!!c.open} role={c.open ? undefined : 'group'}
          type={c.open ? 'button' : undefined} aria-label={c.title} onclick={c.open ? () => openHomeCard(c) : undefined}>
          <div class="phc-head">
            <span class="phc-ic" aria-hidden="true">{@html uiIcon(c.icon)}</span>
            <span class="phc-title">{c.title}</span>
            {#if c.data?.tone}<span class="phc-dot" data-tone={c.data.tone} title={TONE[c.data.tone]} aria-label={TONE[c.data.tone]}></span>{/if}
            {#if c.data?.badge}<span class="phc-badge">{c.data.badge}</span>{/if}
          </div>
          {#if c.data?.text}<p class="phc-text">{c.data.text}</p>{/if}
          {#if c.data?.items?.length}
            <dl class="phc-items">
              {#each c.data.items.slice(0, 6) as it, i (i)}
                <div class="phc-it"><dt>{it.label}</dt><dd>{it.value}</dd></div>
              {/each}
            </dl>
          {/if}
          {#if !c.data}<p class="phc-text dim">{c.pluginName}</p>{/if}
        </svelte:element>
      {/each}
    </div>
  </section>
{/if}

<style>
  /* 底部一条：左右贴边可横滑，两侧留白；auto 外边距让卡少时居中、多时从左起滑 */
  .phc {
    position: fixed; left: 0; right: 0; bottom: max(14px, var(--sab, 0px)); z-index: 6; pointer-events: none;
    font-family: var(--sans);
  }
  .phc-row {
    display: flex; gap: 12px; padding: 6px 18px 10px; overflow-x: auto; overscroll-behavior-x: contain;
    scroll-snap-type: x mandatory; scroll-padding: 0 18px; scrollbar-width: none; pointer-events: auto;
  }
  .phc-row::-webkit-scrollbar { display: none; }
  .phc-row > :global(:first-child) { margin-left: auto; }
  .phc-row > :global(:last-child) { margin-right: auto; }

  .phc-card {
    flex: 0 0 min(292px, calc(100vw - 48px)); min-width: 0; scroll-snap-align: center;
    display: flex; flex-direction: column; gap: 6px; padding: 13px 14px 12px; border-radius: 22px; text-align: left;
    color: var(--i-label); font: inherit;
    background: rgba(246, 246, 246, .62);
    -webkit-backdrop-filter: blur(14px) saturate(1.4); backdrop-filter: blur(14px) saturate(1.4);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .55), 0 0 0 .5px rgba(0, 0, 0, .06), 0 8px 28px rgba(0, 0, 0, .16);
    transition: transform var(--mo-tap, .12s) var(--ea-out, ease-out);
  }
  .dark .phc-card {
    background: rgba(27, 27, 29, .58);
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, .1), 0 0 0 .5px rgba(255, 255, 255, .08), 0 8px 28px rgba(0, 0, 0, .34);
  }
  .phc-card.tap { cursor: pointer; }
  .phc-card.tap:active { transform: scale(.97); }

  .phc-head { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .phc-ic { width: 20px; height: 20px; flex: none; display: flex; color: var(--i-label2); }
  .phc-ic :global(svg) { width: 100%; height: 100%; }
  .phc-title { flex: 1; min-width: 0; font-size: 15px; line-height: 20px; font-weight: 600; letter-spacing: -.2px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .phc-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--i-label3); }
  .phc-dot[data-tone="ok"] { background: var(--i-ok); }
  .phc-dot[data-tone="warn"] { background: var(--i-warn); }
  .phc-dot[data-tone="error"] { background: var(--i-red); }
  .phc-badge {
    flex: none; max-width: 40%; padding: 1px 7px; border-radius: 9px; font-size: 11.5px; line-height: 17px; font-weight: 600;
    color: var(--i-label); background: var(--i-fill2); overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  }
  .phc-text {
    margin: 0; font-size: 13px; line-height: 18px; color: var(--i-label2); overflow-wrap: anywhere;
    display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  }
  .phc-text.dim { color: var(--i-label3); }
  /* 数据项：两列，标签小字在上、值在下；窄卡也不撑破 */
  .phc-items { margin: 2px 0 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 12px; }
  .phc-it { min-width: 0; }
  .phc-it dt { font-size: 11px; line-height: 14px; color: var(--i-label2); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .phc-it dd { margin: 1px 0 0; font-size: 14px; line-height: 19px; font-weight: 500; font-variant-numeric: tabular-nums; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

  /* 矮屏（手机横屏 / 小窗）：只留标题行与一行文字，别压到中间的入口 */
  @media (max-height: 640px) {
    .phc-items { display: none; }
    .phc-text { -webkit-line-clamp: 1; line-clamp: 1; }
  }
  @media (max-height: 460px) { .phc { display: none; } }
</style>
