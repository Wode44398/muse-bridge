<script>
  // list 积木：{ items: [{ id?, title, desc?, badge?, icon?, tone?, action?, trailing? }], empty? }——设置页的分组卡一行一项。
  //   行：图标方块（可选）· 标题 / 说明 · 徽标 · 行尾控件 · 可点的行带箭头。
  //   点整行 → ctx.run(item.action, { id })；行尾按钮 → ctx.run(trailing.action, { id })；行尾开关 → ctx.run(action, { id, value: 新值 })。
  // 行尾控件和「点整行」不能嵌在同一个 <button> 里：整行的点按区是一颗铺满整行的透明按钮（在最底层），文字叠在上面不接指针，
  // 行尾控件单独接指针——行尾按钮按下去不会连带触发整行。
  // 开关先按新值画（乐观），动作回来以插件给的新树为准；动作没成功就弹回原值。
  // tone：有徽标染徽标，没徽标染标题（不加彩点、彩边）。
  import Toggle from '../ios27/Toggle.svelte';
  import DSwitch from '../../desktop/kit/DSwitch.svelte';
  import ActButton from './ActButton.svelte';
  import { uiIcon } from '../../lib/pluginUi.svelte.js';
  import { t } from '../../lib/i18n.js';

  let { block, ctx } = $props();
  const items = $derived(Array.isArray(block.items) ? block.items : []);
  const desk = $derived(ctx.variant === 'desktop');
  const idArg = (it) => (it.id !== undefined && it.id !== null ? { id: it.id } : {});
  const toneCls = (it) => (['muted', 'ok', 'warn', 'error'].includes(it.tone) ? 'av-tone-' + it.tone : '');

  // 开关的乐观值：行号 → 新值（动作回来就清，回来的树里是插件认的值）
  let flip = $state({});
  async function toggle(it, i) {
    const tr = it.trailing;
    const next = !(flip[i] ?? tr.value === true);
    flip[i] = next;
    try { await ctx.run(tr.action, { ...idArg(it), value: next }); } finally { delete flip[i]; }
  }
  function open(it) { if (it.action) ctx.run(it.action, idArg(it)); }
</script>

{#if items.length}
  <div class="ls av-card" role="list">
    {#each items as it, i}
      {@const sw = it.trailing?.type === 'switch' ? it.trailing : null}
      {@const tb = it.trailing?.type === 'button' ? it.trailing : null}
      <div class="row" class:act={!!it.action} class:has-ic={!!it.icon} role="listitem">
        {#if it.action}
          <button type="button" class="hit" aria-label={it.desc ? it.title + '，' + it.desc : it.title}
            aria-busy={ctx.busy(it.action, idArg(it))} onclick={() => open(it)}></button>
        {/if}
        {#if it.icon}<span class="ic" aria-hidden="true">{@html uiIcon(it.icon)}</span>{/if}
        <span class="main">
          <span class="txt">
            <span class="ti {it.badge ? '' : toneCls(it)}">{it.title}</span>
            {#if it.desc}<span class="ds">{it.desc}</span>{/if}
          </span>
          {#if it.badge}<span class="bd {toneCls(it)}">{it.badge}</span>{/if}
          {#if it.action && ctx.busy(it.action, idArg(it))}<span class="av-spin" aria-hidden="true"></span>{/if}
          {#if sw}
            <span class="tr">
              {#if desk}
                <DSwitch checked={flip[i] ?? sw.value === true} onchange={() => toggle(it, i)} />
              {:else}
                <Toggle checked={flip[i] ?? sw.value === true} onchange={() => toggle(it, i)} label={it.title} />
              {/if}
            </span>
          {:else if tb}
            <span class="tr"><ActButton label={tb.label} act={tb.action} style={tb.style} extra={idArg(it)} {ctx} size="sm" /></span>
          {/if}
          {#if it.action}
            <svg class="chev" viewBox="0 0 8 14" width="8" height="14" aria-hidden="true"><path d="m1.5 1.5 5 5.5-5 5.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          {/if}
        </span>
      </div>
    {/each}
  </div>
{:else}
  <div class="ls av-card none">{block.empty || t('还没有内容')}</div>
{/if}

<style>
  .ls { display: flex; flex-direction: column; }
  .row {
    position: relative; display: flex; align-items: center; gap: 14px; min-height: var(--av-row); padding: 0 0 0 var(--av-px);
    color: var(--av-ink);
  }
  :global(.av-desk) .row { gap: var(--av-px); }
  /* 整行点按区：铺满整行、在最底层；按下染色同设置页行（60ms），桌面悬停淡一档 */
  .hit {
    position: absolute; inset: 0; z-index: 0; border: 0; padding: 0; margin: 0; background: transparent; cursor: pointer;
    transition: background var(--av-t) linear;
  }
  .hit:active { background: var(--av-press); }
  .hit:focus-visible { outline: none; box-shadow: inset var(--av-focus); }
  @media (hover: hover) { :global(.av-desk) .hit:hover { background: var(--av-hover); } :global(.av-desk) .hit:active { background: var(--av-press); } }
  /* 叠在点按区上面的内容不接指针（点到字上也算点整行），行尾控件再单独接回来 */
  .ic, .main { position: relative; z-index: 1; pointer-events: none; }
  .tr { pointer-events: auto; }
  .ic {
    flex: none; width: var(--av-icon); height: var(--av-icon); border-radius: var(--av-icon-r); display: grid; place-items: center;
    background: var(--av-tile); color: var(--av-tile-ink);
  }
  .ic :global(svg) { width: 18px; height: 18px; }
  :global(.av-desk) .ic :global(svg) { width: 15px; height: 15px; }
  /* 文字列 + 行尾：行间分隔线画在这一列顶上（从文字起、不贯穿图标列），同设置页 .r-main */
  .main {
    flex: 1; min-width: 0; align-self: stretch; display: flex; align-items: center; gap: 10px;
    padding: var(--av-py) var(--av-px) var(--av-py) 0; min-height: var(--av-row);
  }
  .row + .row .main::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 1px; background: var(--av-sep);
  }
  .txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .ti { font-size: var(--av-fs); line-height: var(--av-lh); overflow-wrap: anywhere; }
  .ds { font-size: var(--av-fs-sub); line-height: var(--av-lh-sub); color: var(--av-ink2); overflow-wrap: anywhere; white-space: pre-wrap; }
  :global(.av-desk) .ds { color: var(--av-ink3); }
  .bd {
    flex: none; max-width: 40%; height: 22px; padding: 0 8px; border-radius: 11px; display: inline-flex; align-items: center;
    font-size: 12px; line-height: 1; font-weight: 600; font-variant-numeric: tabular-nums;
    background: var(--av-fill2); color: var(--av-ink2); overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  }
  :global(.av-desk) .bd { height: 18px; padding: 0 6px; border-radius: 6px; font-size: 11px; }
  .bd.av-tone-ok { color: var(--av-ok); background: color-mix(in srgb, var(--av-ok) 13%, transparent); }
  .bd.av-tone-warn { color: var(--av-warn); background: color-mix(in srgb, var(--av-warn) 14%, transparent); }
  .bd.av-tone-error { color: var(--av-err); background: color-mix(in srgb, var(--av-err) 13%, transparent); }
  .ti.av-tone-muted { color: var(--av-ink2); }
  .ti.av-tone-ok { color: var(--av-ok); }
  .ti.av-tone-warn { color: var(--av-warn); }
  .ti.av-tone-error { color: var(--av-err); }
  .tr { flex: none; display: inline-flex; align-items: center; }
  .chev { flex: none; color: var(--av-ink3); }
  :global(.av-desk) .chev { width: 6px; height: 10px; }
  .main > .av-spin { color: var(--av-ink2); }
  .none {
    padding: 18px var(--av-px); text-align: center; font-size: var(--av-fs-sub); line-height: var(--av-lh-sub); color: var(--av-ink2);
  }
</style>
