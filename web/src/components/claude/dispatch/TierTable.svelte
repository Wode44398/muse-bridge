<script>
  // 四档落点：当前查看的这一套实际会怎么派。四行，每行 = 档色小方块 + 档名 + 用途 + 模型片 + 推理强度片 + 智力分 / 每任务成本 + 来源。
  //   · 模型片 / 推理强度片点开就是输入栏那两个浮层（ModelPicker / EffortPanel 的受控模式），选了 = 这一档改成「自定义」；
  //     模型菜单只列候选里有的模型（关了「调用非 Claude 模型」第三方自然不在候选里），存的是规范写法（opus / custom:…）。
  //   · 来源：「图谱」或「自定义」；自定义的后面跟着「回到图谱」。指定的模型现在用不了（被过滤 / 已删除）→「自定义」划掉并在行下说明，落点先按图谱。
  //   · 宽处是一张对齐的表（带表头）；窄处（手机、窄窗口）每档叠成两三行：档名 + 数字 / 两枚片 + 来源 / 说明。
  // 浮层挪到 body 上、按片的位置 fixed 展开；开着时经 onModal 告诉外壳，Esc 只关浮层。
  //   键盘：打开时焦点进浮层、Tab 圈在里面、菜单里方向键走行（dpDom.layerFocus），关掉后焦点回到那枚片上。
  //   窗口尺寸变了（手机上点菜单里的搜索框、软键盘弹出也算一次）不收起，按片现在的位置重新贴。
  import { tick } from 'svelte';
  import ModelPicker from '../../ModelPicker.svelte';
  import EffortPanel from '../../EffortPanel.svelte';
  import { caps } from '../../../lib/state.svelte.js';
  import { effortsFor } from '../../../lib/claudeProviders.svelte.js';
  import { tierMeta, modelName } from '../../../lib/dispatchPolicy.svelte.js';
  import { fmtCost, fmtScore } from '../../../lib/dispatchChartMath.js';
  import { t, tc } from '../../../lib/i18n.js';
  import { portal, escLayer, layerFocus } from './dpDom.js';
  import { isCustom, toCanonical, toPickerId, keepEffort, anchorRect } from './dpUtil.js';
  import { effortTable, effortLabel } from './dpLabels.js';

  let {
    shell = 'desk', tiers = [], candidates = [], unrated = [], primary = [], canEdit = false, allowTP = true, pending = false,
    onoverride, onModal = () => {},
  } = $props();

  // 模型菜单里能选的：候选里有的（按规范写法对）
  const candModels = $derived(new Set(candidates.map((c) => c.model)));
  const modelFilter = (m) => candModels.has(toCanonical(m.id, primary));
  // 点开拉条面板能选的档：面板按模型菜单里的 id 取档位表，认不出 id（别名对不上现在的主列表）就没得选
  const effortList = (pid) => (pid ? effortTable(pid) : []);
  const BASIS = { sub: t('订阅均值'), plan: t('plan 均值'), api: t('API 价') };

  const rows = $derived(tiers.map((x) => {
    const meta = tierMeta(x.key) || { title: x.key, use: '', color: 'currentColor' };
    const pid = toPickerId(x.pick.model, primary);
    const model = x.pick.label || modelName(x.pick.model);
    // 推理强度的叫法：片上、行下「普通子 agent」那一句都走 dpLabels.effortLabel（和拉条面板同一张档位表）
    const effort = effortLabel(x.pick.model, x.pick.effort);
    const notes = [];
    if (x.overrideSkipped && x.override) {
      const name = modelName(x.override.model);
      notes.push(isCustom(x.override.model) && !allowTP
        ? t('已关闭「调用非 Claude 模型」，指定的 {model} 暂不生效，先按图谱走', { model: name })
        : t('指定的 {model} 现在不在可选的模型里，先按图谱走', { model: name }));
    }
    if (x.short && x.source !== 'override') notes.push(t('没有模型够得着这条线，取了智力分最高的'));
    if (x.pick.est) notes.push(t('这个推理强度没有评分，智力分和成本按相近的档估'));
    if (x.agentTool && !pending) {
      notes.push(t('普通子 agent：{model} · {effort}', {
        model: x.agentTool.label || modelName(x.agentTool.model), effort: effortLabel(x.agentTool.model, x.agentTool.effort),
      }));
    }
    const basis = BASIS[x.pick.basis] || '';
    const ii = fmtScore(x.pick.ii), cost = fmtCost(x.pick.cost);
    return {
      ...x, meta, pid, model, effort, notes, ii, cost,
      tip: basis ? t('智力分 {ii}，每任务 {cost}（{basis}）', { ii, cost, basis }) : t('智力分 {ii}，每任务 {cost}', { ii, cost }),
      canModel: canEdit && candModels.size > 0,
      canEffort: canEdit && effortList(pid).length > 1,
    };
  }));

  // —— 浮层 ——
  let pop = $state.raw(null);   // { key, kind: 'model' | 'effort', rect, el }
  const popRow = $derived(pop ? rows.find((r) => r.key === pop.key) || null : null);
  const popOpen = $derived(!!pop);
  $effect(() => { onModal(popOpen); });
  $effect(() => (popOpen ? escLayer(closePop) : undefined));
  // 锚点 = 片的视口矩形，收进视口里（片落到软键盘底下时，浮层贴着视口底边朝上开，不跟着摆到看不见的地方）
  const anchorOf = (el) => anchorRect(el.getBoundingClientRect(), window.innerWidth, window.innerHeight);
  $effect(() => {
    if (!popOpen) return;
    // 窗口尺寸变了：浮层留着，按片现在的位置重新贴一次（每次给一个新的锚点对象，弹层据此重算朝向与高度）。
    // 以前是直接收起——手机上点模型菜单的搜索框，软键盘一弹就是一次 resize，菜单当场没了，搜索用不了。
    // 片已经不在页面上了才收起。
    const h = () => {
      const cur = pop;
      if (!cur) return;
      if (!cur.el || !cur.el.isConnected) { pop = null; return; }
      pop = { ...cur, rect: anchorOf(cur.el) };
    };
    window.addEventListener('resize', h);
    return () => window.removeEventListener('resize', h);
  });
  $effect(() => { if (pop && !popRow) pop = null; });
  function openPop(e, key, kind) {
    const el = e.currentTarget;
    pop = { key, kind, rect: anchorOf(el), el };
  }
  function closePop() {
    const el = pop?.el;
    pop = null;
    tick().then(() => { try { el?.focus({ preventScroll: true }); } catch {} });
  }
  function pickModel(key, id) {
    const row = rows.find((r) => r.key === key);
    const model = toCanonical(id, primary);
    if (!row || !model) return;
    // 换了模型：原来那档推理强度不在新模型的档位表里就清空（= 用它的默认）
    onoverride?.(key, { model, effort: keepEffort(row.pick.effort || '', effortsFor(id, caps.data)) });
  }
  function pickEffort(key, effort) {
    const row = rows.find((r) => r.key === key);
    if (!row) return;
    onoverride?.(key, { model: row.pick.model, effort: effort || '' });
  }
</script>

{#snippet caret()}<svg class="tt-caret" viewBox="0 0 10 6" aria-hidden="true"><path d="M1 1l4 4 4-4" /></svg>{/snippet}

<div class="dp-card tt" class:desk={shell !== 'ios'} class:ios={shell === 'ios'}>
  {#if !rows.length}
    <p class="tt-empty">{t('还没有性价比数据，四档暂时排不出落点')}</p>
  {:else}
    <div class="tt-head" aria-hidden="true">
      <span>{t('档位')}</span>
      <span class="tt-chips"><span class="tt-hm">{t('模型')}</span><span class="tt-he">{t('推理强度')}</span></span>
      <span class="tt-nums"><span class="tt-ii">{t('智力分')}</span><span class="tt-cost">{t('每任务成本')}</span></span>
      <span class="tt-src">{t('来源')}</span>
    </div>
    {#each rows as r (r.key)}
      <div class="tt-row" role="group" aria-label={r.meta.title}>
        <span class="tt-tier">
          <span class="tt-sw" style:background={r.meta.color} aria-hidden="true"></span>
          <span class="tt-tx">
            <span class="tt-name">{r.meta.title}</span>
            <span class="tt-use">{r.meta.use}</span>
          </span>
        </span>

        <span class="tt-chips">
          {#if r.canModel}
            <button type="button" class="tt-chip model" aria-haspopup="menu" aria-expanded={pop?.key === r.key && pop.kind === 'model'}
              aria-label={t('{tier}档的模型：{model}', { tier: r.meta.title, model: r.model })} onclick={(e) => openPop(e, r.key, 'model')}>
              <span class="tt-ct">{r.model}</span>{@render caret()}
            </button>
          {:else}
            <span class="tt-chip model ro"><span class="tt-ct">{r.model}</span></span>
          {/if}
          {#if r.canEffort}
            <button type="button" class="tt-chip effort" aria-haspopup="dialog" aria-expanded={pop?.key === r.key && pop.kind === 'effort'}
              aria-label={t('{tier}档的推理强度：{effort}', { tier: r.meta.title, effort: r.effort })} onclick={(e) => openPop(e, r.key, 'effort')}>
              <span class="tt-ct">{r.effort}</span>{@render caret()}
            </button>
          {:else}
            <span class="tt-chip effort ro"><span class="tt-ct">{r.effort}</span></span>
          {/if}
        </span>

        <span class="tt-nums" title={r.tip}>
          <span class="tt-ii">{r.ii}<span class="tt-unit">{tc('智力分单位', '分')}</span></span>
          <span class="tt-cost">{r.cost}</span>
        </span>

        <span class="tt-src">
          {#if r.hasOverride}
            <span class="tt-from on" class:skip={r.overrideSkipped} title={r.overrideSkipped ? t('自定义（未生效）') : undefined}>{t('自定义')}</span>
            {#if canEdit}
              <button type="button" class="tt-back" aria-label={t('{tier}档回到图谱', { tier: r.meta.title })} title={t('回到图谱')} onclick={() => onoverride?.(r.key, null)}>
                <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 6.4h6.1a3.2 3.2 0 0 1 0 6.4H6.6M3.2 6.4l2.7-2.7M3.2 6.4l2.7 2.7" /></svg>
                <span class="tt-back-t">{t('回到图谱')}</span>
              </button>
            {/if}
          {:else}
            <span class="tt-from">{t('图谱')}</span>
          {/if}
        </span>

        {#if r.notes.length}
          <span class="tt-notes">{#each r.notes as n, i (i)}<span>{n}</span>{/each}</span>
        {/if}
      </div>
    {/each}
  {/if}
</div>
{#if unrated.length}
  <p class="tt-foot" title={unrated.map((u) => u.label || modelName(u.model)).join(' · ')}>{t('{n} 个已配置的模型没有评分，不参与选型', { n: unrated.length })}</p>
{/if}

{#if pop && popRow}
  <div class="tt-layer" use:portal use:layerFocus>
    {#if pop.kind === 'model'}
      <ModelPicker anchor={pop.rect} value={popRow.pid} onpick={(id) => pickModel(pop.key, id)} onClose={closePop}
        showFast={false} includeHidden filter={modelFilter} />
    {:else}
      <EffortPanel anchor={pop.rect} model={popRow.pid} value={popRow.pick.effort || ''} onpick={(id) => pickEffort(pop.key, id)} onClose={closePop}
        showUltracode={false} />
    {/if}
  </div>
{/if}

<style>
  .tt-empty { margin: 0; padding: 22px var(--dp-px); text-align: center; font-size: var(--dp-fs-c); color: var(--dp-sub); }

  /* —— 宽：一张对齐的表。列 = 档位（吃掉余下的宽）| 模型 + 推理强度 | 智力分 + 每任务 | 来源 —— */
  .tt-head, .tt-row { display: grid; grid-template-columns: minmax(0, 1fr) 296px 132px 132px; column-gap: 12px; align-items: center; padding: 0 var(--dp-px); }
  .tt-head { height: 32px; font-size: var(--dp-fs-s); color: var(--dp-ink3); }
  .tt-row { position: relative; min-height: 54px; padding-top: 8px; padding-bottom: 8px; row-gap: 6px; }
  .tt-row::before { content: ''; position: absolute; left: var(--dp-px); right: var(--dp-px); top: 0; height: 1px; background: var(--dp-line); }

  .tt-tier { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
  .tt-sw { flex: none; width: 10px; height: 10px; margin-top: 5px; border-radius: 3px; }
  .ios .tt-sw { margin-top: 6px; }
  .tt-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .tt-name { font-size: var(--dp-fs); line-height: 1.35; font-weight: 500; }
  .tt-use { font-size: var(--dp-fs-s); line-height: 1.4; color: var(--dp-sub); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .tt-chips { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .tt-hm { flex: 0 0 176px; padding-left: 10px; box-sizing: border-box; }
  .tt-he { flex: 0 0 112px; padding-left: 10px; box-sizing: border-box; }
  .tt-chip {
    display: inline-flex; align-items: center; gap: 6px; min-width: 0; box-sizing: border-box; height: var(--dp-h); padding: 0 8px 0 10px;
    border: 0; border-radius: var(--dp-r-c); background: transparent; box-shadow: inset 0 0 0 1px var(--dp-line2);
    color: var(--dp-ink); font: inherit; font-size: var(--dp-fs-c); text-align: left; cursor: pointer;
    transition: background-color var(--mo-micro, 140ms) var(--ea-fade, ease), box-shadow var(--mo-micro, 140ms) var(--ea-fade, ease);
  }
  .tt-chip.model { flex: 0 0 176px; }
  .tt-chip.effort { flex: 0 0 112px; }
  .tt-chip.ro { box-shadow: none; cursor: default; color: var(--dp-ink2); }
  .tt-chip[aria-expanded="true"] { background: var(--dp-sunk); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--dp-ink) 34%, transparent); }
  .tt-chip:focus-visible { outline: none; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--dp-ink) 45%, transparent); }
  @media (hover: hover) { button.tt-chip:hover { background: var(--dp-sunk); } }
  .tt-ct { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .tt-caret { flex: none; width: 9px; height: 6px; fill: none; stroke: var(--dp-ink3); stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }

  .tt-nums { display: flex; align-items: baseline; justify-content: flex-end; min-width: 0; font-size: var(--dp-fs-c); font-variant-numeric: tabular-nums; color: var(--dp-ink2); }
  .tt-ii { flex: 0 0 52px; text-align: right; white-space: nowrap; }
  .tt-cost { flex: 0 0 80px; text-align: right; white-space: nowrap; }
  .tt-head .tt-nums { font-size: inherit; color: inherit; }
  .tt-unit { display: none; margin-left: 2px; font-size: var(--dp-fs-s); color: var(--dp-sub); }

  /* 来源列左对齐：「图谱」「自定义」上下对齐，「回到图谱」跟在后面 */
  .tt-src { display: flex; align-items: center; justify-content: flex-start; gap: 4px; min-width: 0; font-size: var(--dp-fs-c); }
  .tt-head .tt-src { font-size: inherit; }
  .tt-from { color: var(--dp-ink3); white-space: nowrap; }
  .ios .tt-from { color: var(--dp-ink2); }
  .tt-from.on { color: var(--dp-ink); font-weight: 500; }
  /* 指定了但眼下不生效：划掉（原因写在行下那一句里） */
  .tt-from.skip { color: var(--dp-ink3); font-weight: 400; text-decoration: line-through; }
  .ios .tt-from.skip { color: var(--dp-ink2); }
  .tt-back { flex: none; display: inline-flex; align-items: center; gap: 4px; height: var(--dp-h); padding: 0 7px; border: 0; border-radius: var(--dp-r-c); background: transparent;
    color: var(--dp-ink2); font: inherit; font-size: var(--dp-fs-s); white-space: nowrap; cursor: pointer;
    transition: background-color var(--mo-micro, 140ms) var(--ea-fade, ease), color var(--mo-micro, 140ms) var(--ea-fade, ease); }
  .tt-back svg { flex: none; width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; }
  .tt-back:focus-visible { outline: none; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--dp-ink) 45%, transparent); }
  @media (hover: hover) { .tt-back:hover { background: var(--dp-sunk); color: var(--dp-ink); } }

  .tt-notes { grid-column: 1 / -1; display: flex; flex-direction: column; gap: 2px; padding-left: 20px; font-size: var(--dp-fs-s); line-height: 1.45; color: var(--dp-sub); }
  .tt-foot { margin: 0; padding: 8px 12px 0; font-size: var(--dp-fs-s); line-height: 1.5; color: var(--dp-ink3); }
  .ios + .tt-foot { padding: 8px 16px 0; color: var(--dp-ink2); }

  /* —— 窄（手机、窄窗口）：每档叠成「档名 + 数字 / 两枚片 + 来源 / 说明」，表头收起，数字自己带单位 ——
        三列：第一行「档名 | 数字（跨后两列）」，第二行「两枚片（跨前两列）| 来源」。上下两行的右半边不能共用一列——
        共用的话那一列按第一行的数字（「57.0分 ¥1.20」）定宽，第二行的「图谱」只占它一小半，两枚片却被挤在左边那一列里：
        375 宽时模型片只剩五十来像素写字，「Opus 5.5」被截成「Opu…」，而同一行右边明明空着。
        现在最后一列只按「来源」自己的宽，数字多出来的宽度落在中间那一列上，两枚片一直能用到「来源」跟前。
        还放不下（长名字的第三方模型、带「自定义 + 回到图谱」的行）：推理强度片先换到下一行，模型名一行都放不下才省略。 */
  @container dp (max-width: 759px) {
    .tt-head { display: none; }
    .tt-row { grid-template-columns: minmax(0, 1fr) auto auto; grid-template-areas: "tier nums nums" "chips chips src" "notes notes notes"; row-gap: 9px; padding-top: 12px; padding-bottom: 12px; }
    .tt-head + .tt-row::before { display: none; }
    .tt-tier { grid-area: tier; }
    .tt-nums { grid-area: nums; align-self: start; gap: 10px; padding-top: 1px; }
    .tt-chips { grid-area: chips; padding-left: 20px; flex-wrap: wrap; }
    .tt-src { grid-area: src; justify-content: flex-end; align-self: start; min-height: var(--dp-h); }
    .tt-notes { grid-area: notes; }
    .tt-use { white-space: normal; }
    .tt-chip.model { flex: 0 0 auto; max-width: 100%; }
    .tt-chip.effort { flex: none; max-width: 100%; }
    .tt-chip.ro { padding-left: 0; }
    .tt-ii, .tt-cost { flex: none; }
    .tt-unit { display: inline; }
    .tt-back-t { display: none; }
    .tt-back { width: var(--dp-h); padding: 0; justify-content: center; }
    .tt-back svg { width: 16px; height: 16px; }
  }

  /* 挪到 body 上的那一层：整屏、压在设置页（60）之上，模型菜单 / 推理强度面板和它们的透明遮罩都在这一层里 */
  .tt-layer { position: fixed; inset: 0; z-index: 1000; }

  @media (prefers-reduced-motion: reduce) { .tt-chip, .tt-back { transition: none; } }
</style>
