<script>
  // 调用参数编辑器（模型服务的服务级默认 / 单个模型的覆盖共用）。
  // params 形状同服务端 normalizeParams：{ maxTokens, temperature, topP, topK, thinking, thinkingBudget, stop[], extraBody }。
  // 数值为 null = 不设置：服务级 = 跟随 Claude Code 的请求；模型级（inherit）= 沿用服务设置。
  import SSegmented from '../../settings/SSegmented.svelte';
  import { t } from '../../../lib/i18n.js';
  let { params = $bindable(), inherit = false, protocol = 'anthropic', thinkingKind = 'budget' } = $props();

  const unsetText = $derived(inherit ? t('沿用服务设置') : t('跟随默认'));
  const SLIDERS = [
    { k: 'temperature', name: 'temperature', min: 0, max: 2, step: 0.05, hint: () => t('越高越发散；0 最稳定') },
    { k: 'topP', name: 'top_p', min: 0, max: 1, step: 0.01, hint: () => t('只在累计概率前这部分里采样') },
  ];
  const fmt = (v) => (v === null || v === undefined ? '' : String(v));
  const toNum = (s, int) => { const x = String(s).trim(); if (!x) return null; const n = Number(x); return Number.isFinite(n) ? (int ? Math.round(n) : n) : null; };

  // 停止序列：回车 / 逗号加一个标签
  let stopDraft = $state('');
  function addStop() {
    const v = stopDraft.trim();
    if (v && !params.stop.includes(v) && params.stop.length < 8) params.stop = [...params.stop, v];
    stopDraft = '';
  }
  function stopKey(e) {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); addStop(); }
    else if (e.key === 'Backspace' && !stopDraft && params.stop.length) params.stop = params.stop.slice(0, -1);
  }

  // 额外请求体：实时校验 JSON 对象
  const extraErr = $derived.by(() => {
    const s = String(params.extraBody || '').trim();
    if (!s) return '';
    try { const o = JSON.parse(s); return o && typeof o === 'object' && !Array.isArray(o) ? '' : t('要是 JSON 对象（{…}）'); }
    catch (e) { return t('不是合法 JSON'); }
  });

  const THINK_OPTS = $derived([
    ...(inherit ? [{ value: null, label: t('沿用') }] : []),
    { value: 'auto', label: t('跟随输入框') },
    { value: 'on', label: t('始终开') },
    { value: 'off', label: t('始终关') },
  ]);
</script>

<div class="pe">
  <!-- 输出 -->
  <div class="row">
    <div class="lab"><div class="nm">{t('最大输出')}<code>max_tokens</code></div><div class="hint">{t('单次回复最多生成的 token；不超过模型的输出上限')}</div></div>
    <div class="ctl">
      <div class="numf"><input type="number" min="1" step="256" placeholder={unsetText} value={fmt(params.maxTokens)} oninput={(e) => (params.maxTokens = toNum(e.currentTarget.value, true))} /><span class="unit">tokens</span></div>
    </div>
  </div>

  <!-- 采样 -->
  {#each SLIDERS as s (s.k)}
    {@const on = params[s.k] !== null && params[s.k] !== undefined}
    <div class="row">
      <div class="lab"><div class="nm">{s.name}</div><div class="hint">{s.hint()}</div></div>
      <div class="ctl slide" class:off={!on}>
        <input type="range" min={s.min} max={s.max} step={s.step} value={on ? params[s.k] : (s.k === 'temperature' ? 1 : 1)}
          style:--p="{((on ? params[s.k] : s.max / 2) - s.min) / (s.max - s.min) * 100}%"
          oninput={(e) => (params[s.k] = Number(e.currentTarget.value))} aria-label={s.name} />
        {#if on}
          <span class="val">{Number(params[s.k]).toFixed(2)}</span>
          <button type="button" class="clr" title={unsetText} aria-label={unsetText} onclick={() => (params[s.k] = null)}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg>
          </button>
        {:else}<span class="val dim">{unsetText}</span>{/if}
      </div>
    </div>
  {/each}

  <div class="row">
    <div class="lab"><div class="nm">top_k</div><div class="hint">{protocol === 'openai' ? t('OpenAI 协议多数不认，按服务商说明填') : t('只从概率最高的前 K 个里采样')}</div></div>
    <div class="ctl"><div class="numf sm"><input type="number" min="1" max="1000" placeholder={unsetText} value={fmt(params.topK)} oninput={(e) => (params.topK = toNum(e.currentTarget.value, true))} /></div></div>
  </div>

  <!-- 思考 -->
  {#if thinkingKind !== 'none'}
    <div class="row">
      <div class="lab"><div class="nm">{t('思考')}</div><div class="hint">{t('跟随输入框 = 按输入框里选的档位，没选用模型的默认档；始终开 = 没选也用最高档；始终关 = 用「关闭」档，没有就不发思考参数')}</div></div>
      <div class="ctl"><SSegmented options={THINK_OPTS} value={params.thinking ?? null} onchange={(v) => (params.thinking = v)} label={t('思考')} /></div>
    </div>
    {#if thinkingKind === 'budget'}
      <div class="row">
        <div class="lab"><div class="nm">{t('思考预算基准')}<code>budget_tokens</code></div><div class="hint">{t('只对发送值留空的档位生效：「高」档用这个值；低 ⅛、中 ½、超高 2 倍、最高 4 倍')}</div></div>
        <div class="ctl"><div class="numf"><input type="number" min="1024" step="1024" placeholder={inherit ? unsetText : '16000'} value={fmt(params.thinkingBudget)} oninput={(e) => (params.thinkingBudget = toNum(e.currentTarget.value, true))} /><span class="unit">tokens</span></div></div>
      </div>
    {/if}
  {/if}

  <!-- 停止序列 -->
  <div class="row">
    <div class="lab"><div class="nm">{t('停止序列')}<code>stop</code></div><div class="hint">{t('生成到这些文字就停；回车添加，最多 8 个')}</div></div>
    <div class="ctl">
      <div class="chips">
        {#each params.stop as s, i (s)}
          <span class="chip"><code>{s}</code><button type="button" aria-label={t('删除')} onclick={() => (params.stop = params.stop.filter((_, j) => j !== i))}>×</button></span>
        {/each}
        {#if params.stop.length < 8}<input class="chip-in" placeholder={params.stop.length ? '' : t('输入后回车')} bind:value={stopDraft} onkeydown={stopKey} onblur={addStop} />{/if}
      </div>
    </div>
  </div>

  <!-- 额外请求体 -->
  <div class="row col">
    <div class="lab"><div class="nm">{t('额外请求体')}<code>JSON</code></div>
      <div class="hint">{protocol === 'openai' ? t('深合并进每个请求；OpenAI 专属字段写在 "openai": {…} 里会原样并进翻译后的请求') : t('深合并进每个请求，最后生效，可覆盖上面任何一项')}</div></div>
    <textarea class="json" class:err={!!extraErr} rows="4" spellcheck="false" placeholder={'{ "metadata": { "user_id": "bridge" } }'}
      value={params.extraBody || ''} oninput={(e) => (params.extraBody = e.currentTarget.value)}></textarea>
    {#if extraErr}<div class="err-t">{extraErr}</div>{/if}
  </div>
</div>

<style>
  .pe { display: flex; flex-direction: column; }
  .row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 300px); gap: 8px 24px; align-items: center; padding: 14px 0; border-top: 1px solid var(--st-hair); }
  .row:first-child { border-top: 0; padding-top: 4px; }
  .row.col { grid-template-columns: 1fr; }
  .nm { font-size: 14px; color: var(--text); display: flex; align-items: center; gap: 8px; }
  .nm code, .chip code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11.5px; color: var(--st-muted); background: var(--st-seg); padding: 1px 6px; border-radius: 5px; }
  .hint { margin-top: 3px; font-size: 12.5px; line-height: 1.45; color: var(--st-muted); }
  .ctl { display: flex; align-items: center; justify-content: flex-end; gap: 8px; min-width: 0; }
  .numf { display: flex; align-items: center; height: 34px; width: 200px; border: 1px solid var(--st-line); border-radius: 9px; background: var(--st-field); overflow: hidden; transition: border-color .15s, box-shadow .15s; }
  .numf.sm { width: 120px; }
  .numf:focus-within { border-color: color-mix(in srgb, var(--st-accent) 70%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--st-accent) 18%, transparent); }
  .numf input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 13.5px; padding: 0 10px; font-variant-numeric: tabular-nums; }
  .numf input::placeholder { color: var(--st-muted); }
  .unit { padding: 0 10px 0 4px; font-size: 12px; color: var(--st-muted); }
  .slide { gap: 10px; }
  .slide input[type=range] { flex: 1; min-width: 120px; max-width: 200px; height: 20px; appearance: none; background: transparent; cursor: pointer; }
  .slide input[type=range]::-webkit-slider-runnable-track { height: 4px; border-radius: 4px; background: linear-gradient(to right, var(--st-accent) var(--p), var(--st-line) var(--p)); }
  .slide input[type=range]::-webkit-slider-thumb { appearance: none; width: 16px; height: 16px; margin-top: -6px; border-radius: 50%; background: #fff; box-shadow: 0 0 0 1px rgba(11,11,11,.12), 0 2px 6px rgba(11,11,11,.18); }
  .slide input[type=range]::-moz-range-track { height: 4px; border-radius: 4px; background: var(--st-line); }
  .slide input[type=range]::-moz-range-progress { height: 4px; border-radius: 4px; background: var(--st-accent); }
  .slide input[type=range]::-moz-range-thumb { width: 16px; height: 16px; border: 0; border-radius: 50%; background: #fff; box-shadow: 0 0 0 1px rgba(11,11,11,.12), 0 2px 6px rgba(11,11,11,.18); }
  /* 未设置：轨道照常可见、整体压暗，点一下就从这里开始取值 */
  .slide.off input[type=range] { opacity: .5; }
  .slide.off input[type=range]::-webkit-slider-runnable-track { background: var(--st-line); }
  .slide.off input[type=range]::-moz-range-progress { background: transparent; }
  .val { min-width: 40px; text-align: right; font-size: 13px; font-variant-numeric: tabular-nums; color: var(--text); }
  .val.dim { min-width: 72px; color: var(--st-muted); font-size: 12.5px; }
  .clr { width: 22px; height: 22px; display: grid; place-items: center; border: 0; border-radius: 6px; background: transparent; color: var(--st-muted); cursor: pointer; }
  .clr:hover { background: var(--st-hover); color: var(--text); }
  .clr svg { width: 12px; height: 12px; }
  .chips { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; min-height: 34px; width: 100%; max-width: 300px; padding: 4px 6px; border: 1px solid var(--st-line); border-radius: 9px; background: var(--st-field); }
  .chips:focus-within { border-color: color-mix(in srgb, var(--st-accent) 70%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--st-accent) 18%, transparent); }
  .chip { display: inline-flex; align-items: center; gap: 2px; padding: 0 2px 0 0; border-radius: 6px; background: var(--st-seg); }
  .chip button { width: 18px; height: 18px; border: 0; background: transparent; color: var(--st-muted); cursor: pointer; border-radius: 4px; font-size: 14px; line-height: 1; }
  .chip button:hover { color: var(--text); background: var(--st-hover); }
  .chip-in { flex: 1; min-width: 80px; height: 24px; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 13px; }
  .json { width: 100%; box-sizing: border-box; min-height: 92px; resize: vertical; padding: 10px 12px; border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-field); color: var(--text);
    font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12.5px; line-height: 1.55; outline: 0; }
  .json:focus { border-color: color-mix(in srgb, var(--st-accent) 70%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--st-accent) 18%, transparent); }
  .json.err { border-color: #d9534f; }
  .err-t { font-size: 12px; color: #d9534f; }
  @media (max-width: 699px) {
    .row { grid-template-columns: 1fr; gap: 10px; }
    .ctl { justify-content: flex-start; }
    .numf, .chips { width: 100%; max-width: none; }
    .slide input[type=range] { max-width: none; }
  }
</style>
