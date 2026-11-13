<script>
  // Media Studio 内置媒体服务（Vertex / 本机图像模型）的模型清单：按种类分组、逐个勾选开关（2026-11-13，统一入口）。
  // HubVertex 的「媒体模型」一节、HubBuiltin（本机卡）共用。on = { 模型 id: 开 / 关 }，由父组件持有、算未保存与提交。
  // 令牌（--st-*）由 HubOverlays 的浮层外框定义；长相照 HubVertex 的型号列表（.mlist / .mrow）。
  import { t } from '../../lib/i18n.js';

  let { models = [], on = $bindable({}), label = '' } = $props();

  const KIND_ORDER = ['image', 'video', 'voice', 'music'];
  // 种类名必须是字面量 t('…')：i18n 检查按字面量收词
  const kindLabel = (k) => ({ image: t('图像'), video: t('视频'), voice: t('配音'), music: t('音乐') })[k] || k;
  const groups = $derived(KIND_ORDER.map((k) => ({ k, list: models.filter((m) => m.kind === k) })).filter((g) => g.list.length));
  const flip = (id) => { on = { ...on, [id]: !on[id] }; };
</script>

{#each groups as g (g.k)}
  <section>
    <div class="fl">{label ? `${label} · ${kindLabel(g.k)}` : kindLabel(g.k)}<span class="n">{g.list.filter((m) => on[m.id]).length}/{g.list.length}</span></div>
    <div class="mlist">
      {#each g.list as m (m.id)}
        <button type="button" class="mrow" class:on={!!on[m.id]} aria-pressed={!!on[m.id]} onclick={() => flip(m.id)}>
          <span class="box"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg></span>
          <span class="m-tx"><span class="m-n">{m.label || m.id}</span>{#if m.label && m.label !== m.id}<span class="m-id">{m.id}</span>{/if}</span>
        </button>
      {/each}
    </div>
  </section>
{:else}
  <p class="none">{t('这个服务里没有模型')}</p>
{/each}

<style>
  .fl { display: flex; align-items: baseline; gap: 8px; margin: 0 0 7px 2px; font-size: 12.5px; font-weight: 600; color: var(--st-text2); }
  .n { font-weight: 500; color: var(--st-muted); font-variant-numeric: tabular-nums; }
  .none { margin: 0 2px; font-size: 13px; color: var(--st-muted); }
  .mlist { border: 1px solid var(--st-line); border-radius: 14px; overflow: hidden; background: var(--st-surface); }
  .mrow { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; padding: 8px 14px; border: 0; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; }
  @media (hover: hover) { .mrow:hover { background: var(--st-hover); } }
  .mrow:focus-visible { outline: none; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--text) 35%, transparent); }
  .mrow + .mrow::before { content: ''; position: absolute; top: 0; left: 44px; right: 0; height: 1px; background: var(--st-hair); }
  .box { width: 18px; height: 18px; flex: none; display: grid; place-items: center; box-sizing: border-box; border-radius: 5px; border: 1.5px solid var(--st-muted); color: transparent;
    transition: background-color var(--mo-micro, 140ms) var(--ea-fade, ease), border-color var(--mo-micro, 140ms) var(--ea-fade, ease); }
  .box svg { width: 12px; height: 12px; }
  .on > .box { background: var(--st-primary); border-color: var(--st-primary); color: var(--st-primary-ink); }
  .m-tx { min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .m-n { font-size: 14px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .m-id { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; color: var(--st-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  @media (max-width: 699px) {
    .fl { margin: 0 4px 8px; font-size: 13px; }
    .mlist { border: 0; border-radius: 18px; }
    .mrow { min-height: 56px; padding: 8px 16px; }
    .mrow:active { background: var(--pm-press); }
    .mrow + .mrow::before { left: 46px; }
  }
  @media (prefers-reduced-motion: reduce) { .box { transition: none; } }
</style>
