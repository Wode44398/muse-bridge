<script module>
  import { t } from '../../../lib/i18n.js';   // 模块级导入，下面实例脚本里也用它
  export const TIER_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
  /** 档位表的毛病（编辑器据此拦保存；服务端 normalizeTiers 同规则）：回人话，没毛病回 ''。 */
  export function tierProblem(m) {
    if (!m || m.thinking === 'none') return '';
    const seen = new Set();
    for (const x of m.efforts || []) {
      if (!TIER_RE.test(x.id || '')) return t('档位 ID「{id}」不合法（小写字母数字与 _ -，最长 24）', { id: x.id || '' });
      if (seen.has(x.id)) return t('档位「{id}」重复了', { id: x.id });
      seen.add(x.id);
    }
    if (m.thinking === 'effort' && m.effortField && !/^[A-Za-z_][\w-]{0,40}(\.[A-Za-z_][\w-]{0,40}){0,4}$/.test(m.effortField)) return t('写入字段「{f}」不合法（点分路径，如 reasoning_effort）', { f: m.effortField });
    return '';
  }
</script>

<script>
  // 单个模型的「思考方式 + 推理强度档位」编辑器（ProviderEditor 的模型展开区里用；2026-10-21）。
  // 输入框里的推理强度就列这里的档位——没有固定 low / medium / high 的模型也能用，档位可以「不发」。
  // 数据形状同服务端（src/runtime/claude-providers.mjs 文件头）：
  //   thinking      none 不发思考参数 / budget 思考预算 / adaptive 自适应 / effort 档位
  //   efforts       [{ id, name, value }]：value 为空 = 这一档什么都不发；文字 / 数字 / true·false = 写进 effortField；
  //                 JSON 对象 = 字段留空时整个并进请求体（如 {"thinking":{"type":"disabled"}}）
  //   effortDefault 没选档位时用哪档（'' = 不发，厂商默认）
  //   effortField   写进哪个字段（点分路径；空 = OpenAI 协议 reasoning_effort、Anthropic 协议 output_config.effort）
  //   alwaysThinks  不发参数也会思考：不剥历史思考块，OpenAI 协议回传 reasoning_content
  import SSegmented from '../../settings/SSegmented.svelte';
  import SToggle from '../../settings/SToggle.svelte';

  let { model = $bindable(), protocol = 'anthropic' } = $props();

  const MODES = $derived([
    { value: 'none', label: t('不思考') },
    { value: 'budget', label: t('预算') },
    { value: 'adaptive', label: t('自适应') },
    { value: 'effort', label: t('档位') },
  ]);
  const defaultField = $derived(protocol === 'openai' ? 'reasoning_effort' : 'output_config.effort');
  const modeHint = $derived(
    model.thinking === 'budget' ? t('Anthropic 式 thinking.budget_tokens：发送值写预算 token 数，留空按「调用参数」里的思考预算基准换算')
      : model.thinking === 'adaptive' ? t('thinking.type = adaptive：发送值写 output_config.effort（如 high），留空只开自适应')
        : model.thinking === 'effort' ? t('每档的发送值写进下面的字段（默认 {field}）；值是 JSON 对象且字段留空时，整个并进请求体', { field: defaultField })
          : t('不发思考参数；自带思考的模型照样会想。输入框里不显示推理强度。'));

  // 一键填入的常见写法（服务端识别不出来、或想换一种写法时用）
  const tier = (id, name, value = null) => ({ id, name, value });
  const PRESETS = [
    { k: 'oai3', label: () => t('OpenAI 三档'), set: { thinking: 'effort', effortField: 'reasoning_effort', efforts: [tier('low', 'Low', 'low'), tier('medium', 'Medium', 'medium'), tier('high', 'High', 'high')] } },
    { k: 'anth5', label: () => t('Anthropic 五档'), set: { thinking: 'adaptive', effortField: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((x) => tier(x, x === 'xhigh' ? 'Extra' : x[0].toUpperCase() + x.slice(1), x)) } },
    { k: 'toggle', label: () => t('开 / 关'), set: { thinking: 'effort', effortField: '', efforts: [tier('off', t('关闭'), { thinking: { type: 'disabled' } }), tier('on', t('开启'), { thinking: { type: 'enabled' } })] } },
    { k: 'enable', label: () => 'enable_thinking', set: { thinking: 'effort', effortField: 'enable_thinking', efforts: [tier('off', t('关闭'), false), tier('on', t('开启'), true)] } },
    { k: 'or', label: () => 'OpenRouter reasoning', set: { thinking: 'effort', effortField: 'reasoning.effort', efforts: [tier('low', 'Low', 'low'), tier('medium', 'Medium', 'medium'), tier('high', 'High', 'high')] } },
  ];
  const clone = (list) => JSON.parse(JSON.stringify(list));
  function applyPreset(p) {
    model.thinking = p.set.thinking;
    model.effortField = p.set.effortField;
    model.efforts = clone(p.set.efforts);
    if (!model.efforts.some((x) => x.id === model.effortDefault)) model.effortDefault = '';
    model.source = { ...(model.source || {}), thinking: 'user' };
  }
  // 换思考方式时，原档位的发送值对不上新方式（预算要数字、自适应要 effort 文字）就重起一张表
  const fits = (val, mode) => val === null || val === undefined || (mode === 'budget' ? typeof val === 'number' : mode === 'adaptive' ? typeof val === 'string' : true);
  function setMode(v) {
    model.thinking = v;
    model.source = { ...(model.source || {}), thinking: 'user' };
    if (model.efforts.length && !model.efforts.every((x) => fits(x.value, v))) model.efforts = [];
    // 切到一种方式但还没有档位：给个起步的表
    if (v === 'budget' && !model.efforts.length) model.efforts = ['low', 'medium', 'high'].map((x) => tier(x, x[0].toUpperCase() + x.slice(1)));
    if (v === 'adaptive' && !model.efforts.length) model.efforts = [tier('adaptive', t('自适应'))];
    if (v === 'effort' && !model.efforts.length) model.efforts = clone(PRESETS[protocol === 'openai' ? 0 : 2].set.efforts);
    if (!model.efforts.some((x) => x.id === model.effortDefault)) model.effortDefault = '';
  }

  // 手动改过档位（加删、ID、发送值、写入字段）= 来源变成「手动」：编辑器换协议时只重算自动识别出来的档位，不覆盖人改过的
  const touch = () => { if (model.source?.thinking !== 'user') model.source = { ...(model.source || {}), thinking: 'user' }; };
  // 发送值：显示成文字；文字能当 JSON 解析（对象 / 数字 / true·false）就按 JSON 存，否则存原文；空 = 不发
  const fmt = (v) => (v === null || v === undefined ? '' : typeof v === 'string' ? v : JSON.stringify(v));
  function parseVal(s) {
    const x = String(s ?? '').trim();
    if (!x) return null;
    if (/^[{\[]|^(true|false)$|^-?\d+(\.\d+)?$/.test(x)) { try { const v = JSON.parse(x); if (!Array.isArray(v)) return v; } catch {} }
    return x;
  }
  function addTier() {
    if (model.efforts.length >= 8) return;
    let n = model.efforts.length + 1;
    while (model.efforts.some((x) => x.id === 't' + n)) n++;
    model.efforts = [...model.efforts, tier('t' + n, t('第 {n} 档', { n }))];
    touch();
  }
  function removeTier(i) {
    const id = model.efforts[i].id;
    model.efforts = model.efforts.filter((_, j) => j !== i);
    if (model.effortDefault === id) model.effortDefault = '';
    touch();
  }
  function move(i, d) {
    const j = i + d;
    if (j < 0 || j >= model.efforts.length) return;
    const a = [...model.efforts];
    [a[i], a[j]] = [a[j], a[i]];
    model.efforts = a;
  }
  const problem = $derived(tierProblem(model));
</script>

<div class="tt">
  <div class="fld"><span class="fl">{t('思考方式')}</span>
    <SSegmented options={MODES} value={model.thinking} onchange={setMode} label={t('思考方式')} />
    <span class="fh">{modeHint}</span>
  </div>

  {#if model.thinking !== 'none'}
    <div class="tiers">
      <div class="thead"><span>{t('档名')}</span><span>ID</span><span>{t('发送值')}</span><span></span></div>
      {#each model.efforts as row, i (i)}
        <div class="trow" class:bad={!TIER_RE.test(row.id || '')}>
          <input class="in" maxlength="24" placeholder={t('档名')} bind:value={row.name} aria-label={t('档名')} />
          <input class="in mono" maxlength="24" spellcheck="false" placeholder="high" value={row.id}
            onchange={(e) => { const old = row.id; row.id = e.currentTarget.value.trim().toLowerCase(); if (model.effortDefault === old) model.effortDefault = row.id; touch(); }} aria-label="ID" />
          <input class="in mono" spellcheck="false" placeholder={model.thinking === 'budget' ? t('留空 = 按基准换算') : model.thinking === 'adaptive' ? t('留空 = 只开自适应') : t('留空 = 不发')}
            value={fmt(row.value)} onchange={(e) => { row.value = parseVal(e.currentTarget.value); touch(); }} aria-label={t('发送值')} />
          <span class="ops">
            <button type="button" class="ib" disabled={i === 0} aria-label={t('上移')} onclick={() => move(i, -1)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4.5 9.5 3.5-3.5 3.5 3.5"/></svg></button>
            <button type="button" class="ib" aria-label={t('删除')} onclick={() => removeTier(i)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg></button>
          </span>
        </div>
      {:else}
        <div class="empty">{t('还没有档位：输入框里不会显示推理强度。用下面的写法一键填入，或手动添加。')}</div>
      {/each}
      <div class="tfoot">
        {#if model.efforts.length < 8}<button type="button" class="btn sm ghost" onclick={addTier}>＋ {t('添加档位')}</button>{/if}
        <label class="dflt"><span>{t('没选时')}</span>
          <select class="in sel" bind:value={model.effortDefault}>
            <option value="">{t('不发（厂商默认）')}</option>
            {#each model.efforts as row, i (i)}{#if row.id}<option value={row.id}>{row.name || row.id}</option>{/if}{/each}
          </select>
        </label>
      </div>
      {#if problem}<div class="err">{problem}</div>{/if}
    </div>

    <div class="presets"><span class="pl">{t('一键填入')}</span>
      {#each PRESETS as p (p.k)}<button type="button" class="chip" onclick={() => applyPreset(p)}>{p.label()}</button>{/each}
    </div>

    {#if model.thinking === 'effort'}
      <details class="adv" open={!!model.effortField}>
        <summary>{t('高级：写进字段')}</summary>
        <label class="fld"><span class="fh">{t('点分路径，如 reasoning_effort、reasoning.effort、output_config.effort；留空按协议默认（{field}）', { field: defaultField })}</span>
          <input class="in mono" spellcheck="false" placeholder={defaultField} bind:value={model.effortField} oninput={touch} /></label>
      </details>
    {/if}
  {/if}

  <div class="li"><div><div class="lt">{t('不发参数也会思考')}</div><div class="ls">{t('小米、Kimi、GLM-5.3 一类：不剥掉历史里的思考内容，OpenAI 协议会把上一轮思考回传（reasoning_content）')}</div></div>
    <SToggle checked={!!model.alwaysThinks} onchange={(v) => (model.alwaysThinks = v)} label={t('不发参数也会思考')} /></div>
</div>

<style>
  .tt { display: flex; flex-direction: column; gap: 4px; }
  .fld { display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px; min-width: 0; }
  .fld > :global(.seg) { align-self: flex-start; max-width: 100%; }
  .fl { font-size: 12.5px; font-weight: 500; color: var(--st-text2); }
  .fh { font-size: 12px; line-height: 1.5; color: var(--st-muted); }
  .in { height: 32px; box-sizing: border-box; width: 100%; padding: 0 9px; border: 1px solid var(--st-line); border-radius: 8px; background: var(--st-field); color: var(--text); font: inherit; font-size: 13px; outline: 0; min-width: 0; }
  .in:focus { border-color: color-mix(in srgb, var(--st-accent) 70%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--st-accent) 18%, transparent); }
  .mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; }
  .tiers { border: 1px solid var(--st-line); border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 6px; }
  .thead, .trow { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, .8fr) minmax(0, 1.6fr) 60px; gap: 6px; align-items: center; }
  .thead { font-size: 11.5px; color: var(--st-muted); padding: 0 2px; }
  .trow.bad input:nth-child(2) { border-color: #d9534f; }
  .ops { display: flex; gap: 2px; justify-content: flex-end; }
  .ib { width: 28px; height: 28px; display: grid; place-items: center; border: 0; border-radius: 7px; background: transparent; color: var(--st-muted); cursor: pointer; }
  .ib:hover:not(:disabled) { background: var(--st-hover); color: var(--text); }
  .ib:disabled { opacity: .35; cursor: default; }
  .ib svg { width: 13px; height: 13px; }
  .empty { padding: 10px 4px; font-size: 12.5px; color: var(--st-muted); }
  .tfoot { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 2px; }
  .dflt { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--st-text2); margin-left: auto; }
  .sel { width: auto; min-width: 150px; appearance: auto; }
  .err { font-size: 12px; color: #d9534f; }
  .btn { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 11px; border: 1px solid transparent; border-radius: 9px; background: transparent; color: var(--text); font: inherit; font-size: 13px; cursor: pointer; }
  .btn:hover { background: var(--st-hover); }
  .presets { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; margin: 8px 0 2px; }
  .pl { font-size: 12px; color: var(--st-muted); margin-right: 2px; }
  .chip { height: 26px; padding: 0 10px; border: 1px solid var(--st-line); border-radius: 999px; background: var(--st-surface); color: var(--st-text2); font: inherit; font-size: 12px; cursor: pointer; }
  .chip:hover { background: var(--st-hover); color: var(--text); }
  .adv { margin-top: 6px; }
  .adv summary { cursor: pointer; font-size: 12.5px; color: var(--st-text2); padding: 4px 0 6px; }
  .li { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 10px 0 2px; border-top: 1px solid var(--st-hair); margin-top: 8px; }
  .lt { font-size: 13px; color: var(--text); }
  .ls { margin-top: 2px; font-size: 12px; line-height: 1.45; color: var(--st-muted); }
  @media (max-width: 699px) {
    .thead { display: none; }
    .trow { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 60px; }
    .trow input:nth-child(3) { grid-column: 1 / 3; grid-row: 2; }
    .trow .ops { grid-row: 1 / span 2; grid-column: 3; }
    .trow { padding-bottom: 6px; border-bottom: 1px solid var(--st-hair); }
  }
</style>
