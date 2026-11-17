<script>
  // 一个已添加文本模型的「高级调用配置」（2026-11-15）：能力（上下文窗口 / 输出上限 / 识图 / 提示缓存）、思考写法、调用参数。
  // 全是「覆盖」：不填 = 自动（自动值写在占位里，来自识别结果与型号知识层）。保存 = POST /model/advanced（over / params 整块替换，null = 恢复自动）。
  // 思考写法与调用参数复用 Claude 外接编辑器的 ThinkingTiers / ParamsEditor（同一套规则、同一套措辞）。
  // 这段脚本的纯逻辑（草稿 ↔ 提交体）在 HsKit.js 的 advDraft / advPayload，有单测。
  import HsSheet from './HsSheet.svelte';
  import HsSeg from './HsSeg.svelte';
  import ThinkingTiers, { tierProblem } from '../claude/providers/ThinkingTiers.svelte';
  import ParamsEditor from '../claude/providers/ParamsEditor.svelte';
  import { fmtCtx, fmtCacheMin, advDraft, advPayload, advProblem, CACHE_STEPS } from './HsKit.js';
  import { hubPost, AGENT_NAME } from '../../lib/modelHub.svelte.js';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  // svc：服务视图；model：服务视图里的这一条（带 auto / eff / over / params / cacheTtl / cacheAuto）
  let { svc, model, narrow = false, onclosed, onsaved } = $props();

  const protocol = $derived(svc?.kind || 'openai');
  const auto = $derived(model?.auto || {});
  const agents = $derived(model?.agents || []);
  const toClaude = $derived(agents.includes('claude'));
  const toDim = $derived(agents.includes('dimensio'));
  const dimNative = $derived(!!svc?.dimNative && toDim);

  // svelte-ignore state_referenced_locally
  let draft = $state(advDraft(model));
  // svelte-ignore state_referenced_locally
  const base = JSON.stringify(advPayload(advDraft(model)));
  const payload = $derived(advPayload(draft));
  const dirty = $derived(JSON.stringify(payload) !== base);
  const problem = $derived(advProblem(draft, { toClaude, tierProblem }));
  let saving = $state(false);
  let err = $state('');
  let sheet = $state();

  const visionOpts = $derived([
    { value: 'auto', label: t('自动') + ' · ' + (auto.vision ? t('支持') : t('不支持')) },
    { value: 'yes', label: t('支持') },
    { value: 'no', label: t('不支持') },
  ]);
  const thinkOpts = $derived([{ value: 'auto', label: t('自动') }, { value: 'custom', label: t('自定义') }]);
  const MODE_NAME = $derived({ none: t('不思考'), budget: t('预算'), adaptive: t('自适应'), effort: t('档位') });
  // 自动的思考写法：一行摘要（方式 · 档位 · 没选时 · 写入字段）
  const autoThink = $derived.by(() => {
    if (!auto.thinking || auto.thinking === 'none') return t('不发思考参数（型号表里没有它的思考写法）');
    const tiers = (auto.efforts || []).map((x) => x.name || x.id).join(' / ');
    const parts = [MODE_NAME[auto.thinking] || auto.thinking, tiers];
    if (auto.effortDefault) parts.push(t('没选时 {v}', { v: auto.effortDefault }));
    if (auto.effortField) parts.push(auto.effortField);
    if (auto.alwaysThinks) parts.push(t('不发参数也会思考'));
    return parts.filter(Boolean).join(' · ');
  });
  const cacheAuto = $derived(model?.cacheAuto?.minutes ?? null);
  const cacheOpts = $derived([
    { v: 'auto', label: t('自动') + (cacheAuto ? ' · ' + fmtCacheMin(cacheAuto) : ' · ' + t('不知道')) },
    ...CACHE_STEPS.map((m) => ({ v: String(m), label: fmtCacheMin(m) })),
    { v: '0', label: t('不缓存（不提示）') },
  ]);
  const thinkKind = $derived(draft.thinkMode === 'custom' ? draft.think.thinking : auto.thinking || 'none');

  // 这一节对哪边生效（行内小标签）
  const both = $derived([toClaude && 'claude', toDim && 'dimensio'].filter(Boolean));
  const claudeOnly = $derived(toClaude ? ['claude'] : []);
  // dimensio 走自带适配直连这家时：思考写法按它自己的适配（托管在这家服务里的别家型号除外，那些照这里的档位表发）
  const thinkWho = $derived(dimNative && !model?.hostedForeign ? claudeOnly : both);

  const num = (s) => { const x = String(s ?? '').trim(); if (!x) return ''; const n = Number(x); return Number.isFinite(n) ? Math.round(n) : x; };

  function resetAll() {
    draft = advDraft({ ...model, over: undefined, params: undefined, cacheTtl: undefined });
  }
  async function save() {
    if (saving || !dirty || problem) return;
    saving = true; err = '';
    try {
      const r = await hubPost('model/advanced', { id: svc.id, model: model.id, ...payload });
      onsaved?.(r.service || null);
      showToast(t('已保存'), 'ok');
      sheet?.dismiss();
    } catch (e) {
      err = tr(e.message);
    } finally { saving = false; }
  }
  // 探测能力（POST /model/probe）：真打几次一两句话的请求，输出上限 / 识图 / 思考档位写进自动值（覆盖照旧压在上面）
  let probing = $state(false);
  let probeNotes = $state(/** @type {string[]} */ ([]));
  const probedAt = $derived(model?.probe?.at || 0);
  async function probe() {
    if (probing) return;
    probing = true; err = '';
    try {
      const r = await hubPost('model/probe', { id: svc.id, model: model.id });
      onsaved?.(r.service || null);
      probeNotes = (r.probe?.notes || []).map((n) => tr(n));
      showToast(t('探测完成'), 'ok');
    } catch (e) {
      err = tr(e.message);
    } finally { probing = false; }
  }
  async function onclose() {
    if (!dirty || saving) return !saving;
    return uiConfirm(t('有改动没保存，确定放弃？'), { danger: true, okLabel: t('放弃') });
  }
</script>

{#snippet who(list)}
  <span class="who">{#each list as a (a)}<span class="wt">{AGENT_NAME[a] || a}</span>{/each}</span>
{/snippet}

{#snippet foot()}
  <button type="button" class="lnk" onclick={resetAll} disabled={saving}>{t('全部恢复自动')}</button>
  <span class="spx"></span>
  {#if err || problem}<span class="ferr" role="alert" title={err || problem}>{err || problem}</span>{/if}
  <button type="button" class="btn" onclick={() => sheet?.dismiss()} disabled={saving}>{t('取消')}</button>
  <button type="button" class="btn primary" class:busy={saving} disabled={!dirty || !!problem || saving} onclick={save}>{t('保存')}</button>
{/snippet}

<HsSheet bind:this={sheet} title={t('{model} 的调用配置', { model: model.label || model.id })} sub={model.label && model.label !== model.id ? model.id : ''}
  {narrow} {onclose} {onclosed} {foot} width={680}>
  {#if !agents.length}
    <p class="note">{t('这个模型还没添加给任何 agent，改了也要添加之后才生效。')}</p>
  {:else if dimNative}
    <p class="note">{model?.hostedForeign
      ? t('dimensio 直连这家，这个别家型号的思考写法也按这里的发。')
      : t('dimensio 用自带适配直连这家：思考写法按它自己的适配，只对 Claude 生效；其余两边都生效。')}</p>
  {/if}

  <section class="sec">
    <div class="sh"><h4>{t('能力')}</h4>{@render who(both)}<span class="spx"></span>
      <button type="button" class="lnk sm" class:busy={probing} disabled={probing || saving} onclick={probe}
        title={t('真打几次一两句话的请求，读出输出上限、能否看图和思考档位（上下文窗口探不出）')}>{probing ? t('探测中…') : t('探测能力')}</button></div>
    {#if probeNotes.length}
      <p class="pnote">{probeNotes.join(' · ')}</p>
    {:else if probedAt}
      <p class="pnote">{t('自动值里含探测结果（{d}）', { d: new Date(probedAt).toLocaleDateString() })}</p>
    {/if}
    <div class="row">
      <div class="lab"><div class="nm">{t('上下文窗口')}</div><div class="hint">{t('输入加输出最多多少 token；超过了 agent 会先压缩上下文')}{#if toClaude}{' ' + t('（给 Claude 的至少 4096）')}{/if}</div></div>
      <div class="ctl"><div class="numf"><input type="number" min="1024" step="1024" placeholder={t('自动 · {v}', { v: fmtCtx(auto.contextWindow) || '?' })}
        value={draft.ctx} oninput={(e) => (draft.ctx = num(e.currentTarget.value))} aria-label={t('上下文窗口')} /><span class="unit">tokens</span></div></div>
    </div>
    <div class="row">
      <div class="lab"><div class="nm">{t('输出上限')}</div><div class="hint">{t('型号单次回复最多能生成多少 token；请求要的更多也会夹到这里')}</div></div>
      <div class="ctl"><div class="numf"><input type="number" min="256" step="1024" placeholder={t('自动 · {v}', { v: fmtCtx(auto.maxOutput) || '?' })}
        value={draft.out} oninput={(e) => (draft.out = num(e.currentTarget.value))} aria-label={t('输出上限')} /><span class="unit">tokens</span></div></div>
    </div>
    <div class="row">
      <div class="lab"><div class="nm">{t('识图')}</div><div class="hint">{t('不支持时，发给它的图片换成一句文字说明')}</div></div>
      <div class="ctl"><HsSeg label={t('识图')} options={visionOpts} value={draft.vision} onchange={(v) => (draft.vision = v)} /></div>
    </div>
    <div class="row">
      <div class="lab"><div class="nm">{t('提示缓存')}</div><div class="hint">{model.cacheAuto?.note ? tr(model.cacheAuto.note) : t('缓存多久变冷：缓存过期提示、过期前自动压缩都按它')}</div></div>
      <div class="ctl"><select class="sel" value={draft.cache} onchange={(e) => (draft.cache = e.currentTarget.value)} aria-label={t('提示缓存')}>
        {#each cacheOpts as o (o.v)}<option value={o.v}>{o.label}</option>{/each}
      </select></div>
    </div>
  </section>

  <section class="sec">
    <div class="sh"><h4>{t('思考写法')}</h4>{@render who(thinkWho)}</div>
    <div class="row">
      <div class="lab"><div class="nm">{t('思考方式与档位')}</div>
        <div class="hint">{draft.thinkMode === 'auto' ? autoThink : t('输入框里的推理强度就列这些档位；每档发什么由你定')}</div></div>
      <div class="ctl"><HsSeg label={t('思考写法')} options={thinkOpts} value={draft.thinkMode} onchange={(v) => (draft.thinkMode = v)} /></div>
    </div>
    {#if draft.thinkMode === 'custom'}
      <div class="tiers"><ThinkingTiers bind:model={draft.think} {protocol} /></div>
    {/if}
  </section>

  <section class="sec">
    <div class="sh"><h4>{t('调用参数')}</h4>{@render who(both)}</div>
    <p class="hint top">{t('留空 = 跟随默认（agent 自己的请求怎么发就怎么发）。思考策略与思考预算只对 Claude 生效。')}</p>
    <ParamsEditor bind:params={draft.params} {protocol} thinkingKind={thinkKind} />
  </section>
  {#if narrow && (err || problem)}<p class="berr" role="alert">{err || problem}</p>{/if}
</HsSheet>

<style>
  .note { margin: 12px 0 0; padding: 10px 12px; border-radius: 10px; background: var(--st-seg); font-size: 12.5px; line-height: 1.55; color: var(--st-text2); }
  .sec { padding-top: 18px; }
  .sec + .sec { margin-top: 10px; border-top: 1px solid var(--st-hair); }
  .sh { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .sh h4 { margin: 0; font-size: 12.5px; font-weight: 600; letter-spacing: .02em; color: var(--st-text2); }
  .who { display: inline-flex; gap: 4px; }
  .wt { height: 18px; padding: 0 6px; border-radius: 5px; background: var(--st-seg); color: var(--st-muted); font-size: 11px; line-height: 18px; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 300px); gap: 8px 24px; align-items: center; padding: 12px 0; }
  .row + .row { border-top: 1px solid var(--st-hair); }
  .nm { font-size: 14px; color: var(--text); }
  .hint { margin-top: 3px; font-size: 12.5px; line-height: 1.45; color: var(--st-muted); }
  .hint.top { margin: 2px 0 2px; }
  .ctl { display: flex; align-items: center; justify-content: flex-end; min-width: 0; }
  .numf { display: flex; align-items: center; height: 34px; width: 200px; border-radius: 9px; background: var(--st-field); box-shadow: inset 0 0 0 1px var(--st-line); overflow: hidden; }
  .numf:focus-within { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 55%, transparent); }
  .numf input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 13.5px; padding: 0 10px; font-variant-numeric: tabular-nums; }
  .numf input::placeholder { color: var(--st-muted); }
  .unit { padding: 0 10px 0 4px; font-size: 12px; color: var(--st-muted); }
  .sel { height: 34px; min-width: 200px; padding: 0 10px; border: 0; border-radius: 9px; background: var(--st-field); color: var(--text); box-shadow: inset 0 0 0 1px var(--st-line);
    font: inherit; font-size: 13.5px; outline: none; }
  .sel:focus { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 55%, transparent); }
  .tiers { padding: 4px 0 6px; }
  .berr { margin: 12px 0 0; font-size: 13px; color: var(--pm-red); }
  /* 复用的 ParamsEditor 第一行没有上边线：这里接在说明下面，补一道 */
  .sec :global(.pe .row:first-child) { border-top: 1px solid var(--st-hair); padding-top: 14px; }

  .spx { flex: 1; }
  .lnk.sm { height: 26px; margin: 0 -8px 0 0; font-size: 12.5px; }
  .lnk.busy { opacity: .7; }
  .pnote { margin: 2px 0 4px; font-size: 12.5px; line-height: 1.5; color: var(--st-muted); }
  .ferr { min-width: 0; max-width: 46%; font-size: 12.5px; color: var(--pm-red); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .lnk { height: 32px; padding: 0 8px; margin-left: -8px; border: 0; border-radius: 8px; background: transparent; color: var(--st-muted); font: inherit; font-size: 13px; cursor: pointer; }
  @media (hover: hover) { .lnk:hover:not(:disabled) { background: var(--st-hover); color: var(--text); } }
  .btn { height: 34px; padding: 0 14px; border: 0; border-radius: 9px; background: var(--st-seg); color: var(--text); font: inherit; font-size: 13.5px; font-weight: 500; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  @media (hover: hover) { .btn:hover:not(:disabled) { background: var(--st-sel); } }
  .btn:active:not(:disabled) { transform: scale(.96); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn.primary { background: var(--st-primary); color: var(--st-primary-ink); }
  .btn.busy { opacity: .7; }
  .btn:focus-visible, .lnk:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  @media (max-width: 699px) {
    .row { grid-template-columns: 1fr; gap: 10px; }
    .ctl { justify-content: flex-start; }
    .numf, .sel { width: 100%; }
    .btn { height: 44px; padding: 0 18px; font-size: 15px; border-radius: 12px; }
    .ferr { display: none; }
  }
</style>
