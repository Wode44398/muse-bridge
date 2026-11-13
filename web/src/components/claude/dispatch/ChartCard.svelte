<script>
  // 性价比图卡：图上方一行（调用非 Claude 模型 · 显示全图 · 恢复默认线）+ PlanChart + 图下方的数据来源与导入。
  //   · 「调用非 Claude 模型」是全局的、即点即存；「显示全图」只管这一屏（要导入过图谱才有全图）；
  //     「恢复默认线」在有任意一条线被调过时才亮。
  //   · 点图上一个候选点 → 小菜单「设为 最难 / 难 / 常规 / 机械 的指定模型」，开在那个点旁边（PlanChart 的 onpick 带着点的视口坐标）。
  //   · 整张卡是拖放区：拖 HTML 进来描一圈虚线，松手导入；「导入文件」「获取最新」只有管理员看得到。
  //     导入 / 获取进行中：卡顶一条来回走的细线 + 按钮上的转圈；失败的原因留在图下方那一行，下次操作时清掉。
  import PlanChart from './PlanChart.svelte';
  import DpSwitch from './DpSwitch.svelte';
  import DpMenu from './DpMenu.svelte';
  import { dp, loadAllPoints, importChartFile, fetchChartOnline, clearChart, TIER_META, TIER_COLORS, modelName } from '../../../lib/dispatchPolicy.svelte.js';
  import { ui } from '../../../lib/state.svelte.js';
  import { uiConfirm } from '../../../lib/dialogs.js';
  import { showToast } from '../../../lib/toast.svelte.js';
  import { t, tr } from '../../../lib/i18n.js';
  import { chartFileProblem, fmtWhen } from './dpUtil.js';
  import { effortLabel } from './dpLabels.js';

  let {
    shell = 'desk', candidates = [], tiers = [], canEdit = false, allowTP = true, chart = null, floorsEdited = false,
    onfloor, onreset, onresetall, onassign, ontp, onModal = () => {},
  } = $props();

  const canImport = $derived(!!dp.canImport);
  const busy = $derived(dp.chartBusy);
  const failText = (e, fb) => tr((e && e.message) || '') || fb;

  // —— 显示全图（只管这一屏）——
  let showAll = $state(false);
  async function toggleAll(v) {
    if (!v) { showAll = false; return; }
    showAll = true;
    const pts = dp.points || await loadAllPoints();
    if (!pts) {
      showAll = false;
      showToast(canImport ? t('导入性价比图之后才有全图可看') : t('管理员导入性价比图之后才有全图可看'));
    }
  }
  // 图谱被清掉 / 换了，全图的点没了：开关跟着关
  $effect(() => { if (showAll && !dp.points && !dp.pointsLoading) showAll = false; });

  // —— 数据来源 ——
  const srcText = $derived.by(() => {
    if (!chart) return '';
    const date = String(chart.generated || '').slice(0, 10);
    if (chart.source !== 'imported') return date ? t('数据 {date} · 随版本内置', { date }) : t('随版本内置的数据');
    const when = fmtWhen(chart.at);
    if (!when) return t('数据 {date} · 已导入', { date });
    return chart.from === 'url' ? t('数据 {date} · {when} 在线获取', { date, when }) : t('数据 {date} · {when} 从文件导入', { date, when });
  });

  // —— 导入 / 获取 / 恢复内置 ——
  let err = $state('');
  let fileEl = $state();
  async function doImport(file) {
    err = '';
    const bad = chartFileProblem(file);
    if (bad) {
      err = bad === 'size' ? t('文件超过 12MB，导入不了') : bad === 'empty' ? t('这个文件是空的') : t('要的是「订阅 plan 性价比图」那个 HTML 文件');
      return;
    }
    try {
      const c = await importChartFile(file);
      const date = String(c?.generated || '').slice(0, 10);
      showToast(date ? t('已导入 {date} 的性价比数据', { date }) : t('已导入性价比数据'));
    } catch (e) { err = failText(e, t('没导入成')); }
  }
  function onFile(e) {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';   // 同一个文件再选一次也要触发
    if (f) doImport(f);
  }
  async function doFetch() {
    err = '';
    try {
      const c = await fetchChartOnline();
      const date = String(c?.generated || '').slice(0, 10);
      showToast(date ? t('已更新到 {date} 的性价比数据', { date }) : t('已更新性价比数据'));
    } catch (e) { err = failText(e, t('没获取到')); }
  }
  async function doClear() {
    const ok = await uiConfirm(t('恢复随版本内置的性价比数据？'), { detail: t('导入的那份会被清掉，四档落点按内置的数据重排。'), okLabel: t('恢复内置') });
    if (!ok) return;
    err = '';
    try { await clearChart(); showToast(t('已恢复内置的性价比数据')); }
    catch (e) { err = failText(e, t('没恢复成')); }
  }

  // —— 拖放 ——
  let over = $state(false);
  let depth = 0;
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  function dragEnter(e) { if (!canImport || !hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); depth++; over = true; }
  function dragOver(e) { if (!canImport || !hasFiles(e)) return; e.preventDefault(); e.stopPropagation(); try { e.dataTransfer.dropEffect = busy ? 'none' : 'copy'; } catch {} }
  function dragLeave() { if (!over) return; depth = Math.max(0, depth - 1); if (!depth) over = false; }
  function drop(e) {
    if (!canImport || !hasFiles(e)) return;
    e.preventDefault(); e.stopPropagation();
    depth = 0; over = false;
    if (busy) return;
    const f = e.dataTransfer.files?.[0];
    if (f) doImport(f);
  }

  // —— 点一个候选点 → 设为某档的指定模型 ——
  let chartEl = $state();
  let menu = $state.raw(null);   // { at: { x, y }, cand }
  $effect(() => { onModal(!!menu); });
  function pickPoint(c, pos) {
    if (!canEdit || !c || !c.model) return;
    let at = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) ? { x: pos.x + 8, y: pos.y + 2 } : null;
    if (!at) { const r = chartEl?.getBoundingClientRect(); at = r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : { x: 120, y: 120 }; }
    menu = { at, cand: c };
  }
  // 推理强度的叫法和四档落点的片同一个来源（dpLabels.effortLabel：拉条面板那张档位表）
  const menuTitle = $derived(menu ? `${menu.cand.label || modelName(menu.cand.model)} · ${effortLabel(menu.cand.model, menu.cand.effort)}` : '');
  const menuItems = $derived.by(() => {
    if (!menu) return [];
    const c = menu.cand, colors = TIER_COLORS[ui.theme !== 'light' ? 'dark' : 'light'];
    return TIER_META.map((m) => {
      const cur = tiers.find((x) => x.key === m.key);
      const same = !!cur && cur.source === 'override' && cur.pick.model === c.model && (cur.pick.effort || '') === (c.effort || '');
      return { label: t('设为「{tier}」的指定模型', { tier: m.title }), color: colors[m.key], sub: same ? t('已指定') : '', disabled: same, onclick: () => onassign?.(m.key, c) };
    });
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="dp-card cc" ondragenter={dragEnter} ondragover={dragOver} ondragleave={dragLeave} ondrop={drop}>
  <div class="cc-tools">
    <div class="cc-opt">
      <span class="cc-opt-t">{t('调用非 Claude 模型')}</span>
      <DpSwitch {shell} checked={allowTP} disabled={!canEdit} label={t('调用非 Claude 模型')} onchange={(v) => ontp?.(v)} />
    </div>
    <div class="cc-opt">
      <span class="cc-opt-t">{t('显示全图')}{#if dp.pointsLoading}<span class="dp-spin" aria-hidden="true"></span>{/if}</span>
      <DpSwitch {shell} checked={showAll} label={t('显示全图')} onchange={toggleAll} />
    </div>
    {#if canEdit}
      <div class="cc-reset">
        <button type="button" class="dp-btn ghost" disabled={!floorsEdited} onclick={() => onresetall?.()}>{t('恢复默认线')}</button>
      </div>
    {/if}
  </div>

  <div class="cc-chart" class:busy={!!busy} bind:this={chartEl}>
    {#if busy}<span class="cc-prog" role="progressbar" aria-label={busy === 'fetch' ? t('正在获取…') : busy === 'import' ? t('正在导入…') : t('正在恢复…')}></span>{/if}
    <PlanChart {candidates} {tiers} allPoints={showAll ? dp.points : null} showAll={showAll && !!dp.points} editable={canEdit}
      emptyHint={canImport ? '' : t('管理员导入「订阅 plan 性价比图」之后，这里会画出能派的模型和四条判定线。')}
      {onfloor} {onreset} onpick={canEdit ? pickPoint : null} />
  </div>

  <div class="cc-foot">
    <span class="cc-src">
      {#if err}<span class="cc-err" role="alert">{err}</span>{:else}{srcText}{/if}
    </span>
    {#if canImport}
      <span class="cc-acts">
        {#if chart?.source === 'imported'}
          <button type="button" class="dp-btn ghost" disabled={!!busy} onclick={doClear}>{t('恢复内置')}</button>
        {/if}
        <button type="button" class="dp-btn" class:busy={busy === 'fetch'} disabled={!!busy} onclick={doFetch}>
          {#if busy === 'fetch'}<span class="dp-spin" aria-hidden="true"></span>{t('正在获取…')}{:else}{t('获取最新')}{/if}
        </button>
        <button type="button" class="dp-btn" class:busy={busy === 'import'} disabled={!!busy} onclick={() => fileEl?.click()}>
          {#if busy === 'import'}<span class="dp-spin" aria-hidden="true"></span>{t('正在导入…')}{:else}{t('导入文件')}{/if}
        </button>
        <input class="cc-file" type="file" accept=".html,.htm,text/html" tabindex="-1" aria-hidden="true" bind:this={fileEl} onchange={onFile} />
      </span>
    {/if}
  </div>

  {#if over}
    <div class="cc-drop" aria-hidden="true"><span>{busy ? t('上一个操作还没结束') : t('松手导入性价比图')}</span></div>
  {/if}
</div>

{#if menu}<DpMenu at={menu.at} title={menuTitle} items={menuItems} onClose={() => { menu = null; }} />{/if}

<style>
  /* 卡片不裁切：图的手柄、提示会贴到边上（PlanChart 的 svg 是 overflow: visible） */

  /* —— 图上方：两个开关 + 恢复默认线 —— */
  .cc-tools { position: relative; display: flex; align-items: center; gap: 4px 22px; flex-wrap: wrap; min-height: 46px; padding: 6px 8px 6px var(--dp-px); }
  .cc-tools::after { content: ''; position: absolute; left: var(--dp-px); right: var(--dp-px); bottom: 0; height: 1px; background: var(--dp-line); }
  .cc-opt { display: inline-flex; align-items: center; gap: 9px; min-width: 0; }
  .cc-opt-t { display: inline-flex; align-items: center; gap: 7px; font-size: var(--dp-fs-c); white-space: nowrap; }
  .cc-reset { margin-left: auto; display: flex; }

  /* 窄（手机）：开关各占一行（文字在左、开关在右，行间一条线），恢复默认线单独一行靠右 */
  @container dp (max-width: 559px) {
    .cc-tools { display: block; padding: 0; }
    .cc-tools::after { display: none; }
    .cc-opt { position: relative; display: flex; justify-content: space-between; min-height: 50px; padding: 0 var(--dp-px); }
    .cc-opt::after { content: ''; position: absolute; left: var(--dp-px); right: var(--dp-px); bottom: 0; height: 1px; background: var(--dp-line); }
    .cc-opt-t { font-size: var(--dp-fs); }
    .cc-reset { justify-content: flex-end; padding: 6px 8px 0; }
  }

  .cc-chart { position: relative; padding: 6px 4px 2px; transition: opacity var(--mo-quick, 200ms) var(--ea-fade, ease); }
  .cc-chart.busy { opacity: .6; }
  /* 进行中：卡顶一条来回走的细线 */
  .cc-prog { position: absolute; left: 0; right: 0; top: 0; height: 2px; overflow: hidden; z-index: 1; }
  .cc-prog::before { content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 34%; border-radius: 2px; background: var(--dp-ink2);
    animation: cc-run 1.1s var(--ea-std, ease) infinite alternate; }
  @keyframes cc-run { from { transform: translateX(-20%); } to { transform: translateX(215%); } }

  /* —— 图下方：数据来源 + 导入 —— */
  .cc-foot { position: relative; display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; min-height: 46px; padding: 8px 8px 8px var(--dp-px); }
  .cc-foot::before { content: ''; position: absolute; left: var(--dp-px); right: var(--dp-px); top: 0; height: 1px; background: var(--dp-line); }
  .cc-src { flex: 1 1 200px; min-width: 0; font-size: var(--dp-fs-s); line-height: 1.5; color: var(--dp-sub); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
  .cc-err { color: var(--dp-red); }
  .cc-acts { flex: none; max-width: 100%; display: inline-flex; align-items: center; flex-wrap: wrap; justify-content: flex-end; gap: 6px; margin-left: auto; }
  .cc-acts :global(.dp-btn.busy:disabled) { opacity: .72; }
  .cc-file { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }

  /* —— 拖放：整张卡描一圈虚线，中间一句话 —— */
  .cc-drop { position: absolute; inset: 0; z-index: 3; display: flex; align-items: center; justify-content: center; border-radius: inherit; pointer-events: none;
    background: color-mix(in srgb, var(--dp-bg) 78%, transparent); animation: cc-fade var(--mo-micro, 140ms) var(--ea-fade, ease); }
  .cc-drop::before { content: ''; position: absolute; inset: 7px; border-radius: calc(var(--dp-r) - 5px); border: 1.5px dashed color-mix(in srgb, var(--dp-ink) 50%, transparent); }
  .cc-drop span { position: relative; font-size: var(--dp-fs); font-weight: 500; color: var(--dp-ink); }
  @keyframes cc-fade { from { opacity: 0; } }

  @media (prefers-reduced-motion: reduce) {
    .cc-chart { transition: none; }
    .cc-prog::before { animation: none; width: 100%; opacity: .5; }
    .cc-drop { animation: none; }
  }
</style>
