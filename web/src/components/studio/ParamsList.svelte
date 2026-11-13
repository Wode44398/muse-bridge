<script>
  // 参数渲染器（v3，方案 §9.2「参数坞 / 参数浮层」+ §9.3）：只按 ParamSpec 渲染，任意来源、任意多个参数都排得下。
  // 版式是 dimensio 的属性行：左标签（13 text2，长英文标签折两行）、右控件，行高 36–40；组之间一根细线 + 12px text3 组名
  // （基本 → 更多 → 原始参数）。控件怎么挑见 modules/studio/render.js 的 controlOf：
  //   短枚举 ≤4 → 分段 · 比例 → 小形状格（前 8 个常用，其余收进「更多比例」）· 长枚举 / 选项多 → 选择钮 + 菜单（>12 带搜索）
  //   数值 → 细滑条 + mono 数值 + 单位（小范围整数 → 分段）· bool → 开关 · 种子 → mono 输入 + 骰子 · 文本 → 单行 / 多行 · json → 最末「原始参数」
  // 参数说明 desc 不上正文（维护者：不写解释句），桌面悬停标签出 title、触屏长按标签出一个小气泡。
  // 同一个组件放参数坞（dock：上面多一张模型卡）、参数浮层 / Sheet（flat），以及值芯片点开的单项浮层（only）。
  import { tick } from 'svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { studio, setParam, valuesOf, labelForId } from '../../modules/studio/media.svelte.js';
  import { optionsOf, jsonError, resolveValues } from '../../modules/studio/params.js';
  import { controlOf, paramGroups, aspectSplit, fmtNumber, isRatio, formatOf, needsSearch } from '../../modules/studio/render.js';
  import { paramLabel, optText, sourceText } from '../../modules/studio/words.js';
  import { paramSource } from '../../modules/studio/picker.js';
  import { providerLogo } from '../../lib/providerLogos.js';
  import { icon, aspectBox } from '../../modules/studio/icons.js';
  import Segmented from './ui/Segmented.svelte';
  import Switch from './ui/Switch.svelte';
  import Popover from './ui/Popover.svelte';
  import Layer from './ui/Layer.svelte';
  import OptionList from './OptionList.svelte';

  // head：坞里顶上那条模型头（只是标题——换模型只在输入框的模型芯片上，复核 11-06：两处都能换是重复）
  let { page, model, onvoice = null, head = false, focusKey = '', only = null, flat = false } = $props();

  const values = $derived(valuesOf(page, model));
  const specs = $derived((model?.params || []).filter((s) => !only || only.includes(s.key)));
  const groups = $derived(paramGroups(specs, values));
  const negative = $derived(!only && !!model?.inputs?.negative);
  const logo = $derived(model?.provider ? providerLogo(model.provider) : '');
  const src = $derived(paramSource(model));
  const srcText = $derived(sourceText(src, labelForId, true));
  let jsonErr = $state({});
  let root = $state();
  let menu = $state(null);       // { spec, anchor }：选择钮点开的选项菜单
  let tip = $state(null);        // { anchor, text }：触屏长按标签出的说明
  let moreAsp = $state({});      // 比例格「更多比例」展开了的参数
  let tight = $state({});        // 分段放不下（实测字被切）的参数：换成选择钮 + 菜单（按「模型 | 参数」记，换了模型重新量）

  // 组：上面一组（基本）不写组名；有第二组（更多）时组前一根细线 + 「更多」。只有一组就什么组名都不写
  const hasBasic = $derived(groups.some((g) => g.id === 'basic'));
  const hasAdv = $derived(groups.some((g) => g.id === 'advanced'));
  // 「更多」默认收起（各模型一致，项少也收），组头写个数和改过几项；只有这一组时不收
  const advSpecs = $derived(groups.find((g) => g.id === 'advanced')?.specs || []);
  const foldable = $derived(!only && hasBasic && advSpecs.length > 0);
  let advOpen = $state({});      // { [模型 key]: true }
  const advShown = $derived(!foldable || !!advOpen[model?.key] || (!!focusKey && advSpecs.some((x) => x.key === focusKey)));
  const defaults = $derived(resolveValues(model?.params || [], {}, model?.id || ''));
  const changedN = $derived(advSpecs.filter((x) => JSON.stringify(values[x.key]) !== JSON.stringify(defaults[x.key])).length);
  // 标签 / 选项文字过一层翻译（words.js）：括号里的说明进悬停 / 长按；上游英文名按常见键名换成界面名；接口原值整理成人话
  const labelOf = (spec) => paramLabel(spec);
  const fullLabel = (spec) => (spec.label ? tr(spec.label) : labelOf(spec));
  const optLabel = optText;
  const optsOf = (spec) => optionsOf(spec, model?.id, values);
  function ctl(spec) {
    const k = controlOf(spec, spec.type === 'enum' ? optsOf(spec) : [], { labelOf: optLabel });
    const tk = (model?.key || '') + '|' + spec.key;
    if (tight[tk] && k === 'seg') return 'select';
    if (tight[tk] && k === 'steps') return 'slider';
    return k;
  }
  const squeeze = (spec) => () => { const tk = (model?.key || '') + '|' + spec.key; if (!tight[tk]) tight[tk] = true; };
  const num = (v) => (v === '' || v == null ? undefined : Number(v));
  const pct = (spec, v) => ((Number(v) - spec.min) / Math.max(1e-9, spec.max - spec.min)) * 100;
  function steps(spec) {
    const out = [];
    for (let x = spec.min; x <= spec.max + 1e-9; x += spec.step || 1) out.push({ value: Math.round(x * 1000) / 1000, label: fmtNumber({ ...spec, unit: '' }, x) });
    return out;
  }
  function jsonBlur(spec, text) {
    const e = jsonError(text);
    jsonErr[spec.key] = e === 'syntax' ? t('不是合法的 JSON') : e === 'object' ? t('要写成一个对象：{ "键": 值 }') : '';
  }
  function dice(spec) { setParam(page, spec.key, Math.floor(Math.random() * 2147483647)); }
  const set = (spec) => (v) => setParam(page, spec.key, v);

  // 触屏长按标签 450ms 出说明（桌面走 title 悬停）
  function hold(node, text) {
    let tm = 0, x0 = 0, y0 = 0;
    const down = (e) => { if (e.pointerType === 'mouse' || !text) return; x0 = e.clientX; y0 = e.clientY; tm = setTimeout(() => { tip = { anchor: node, text }; }, 450); };
    const move = (e) => { if (tm && Math.hypot(e.clientX - x0, e.clientY - y0) > 8) { clearTimeout(tm); tm = 0; } };
    const up = () => { clearTimeout(tm); tm = 0; };
    node.addEventListener('pointerdown', down); node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up); node.addEventListener('pointercancel', up);
    return {
      update(t2) { text = t2; },
      destroy() { clearTimeout(tm); node.removeEventListener('pointerdown', down); node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up); node.removeEventListener('pointercancel', up); },
    };
  }

  // 打开参数层时定位到点的那一项
  $effect(() => {
    const k = focusKey;
    if (!k) return;
    tick().then(() => {
      const el = root?.querySelector(`[data-param="${CSS.escape(k)}"]`);
      const sc = el?.closest('.pv-scroll, .sh-body, .sd-dock-pane');
      if (el && sc) sc.scrollTop += el.getBoundingClientRect().top - sc.getBoundingClientRect().top - sc.clientHeight / 3;
    });
  });
</script>

{#snippet lab(spec)}
  {@const d = spec.desc ? tr(spec.desc) : ''}
  {@const full = fullLabel(spec)}
  {@const tipText = [full !== labelOf(spec) ? full : '', d].filter(Boolean).join('\n')}
  <span class="pl-l" title={tipText || labelOf(spec)} use:hold={tipText}>{labelOf(spec)}</span>
{/snippet}

{#snippet row(spec)}
  {@const v = values[spec.key]}
  {@const kind = ctl(spec)}
  {@const block = kind === 'aspect' || kind === 'slider' || kind === 'textarea' || kind === 'json'}
  <div class="pl-r" class:blk={block} class:focus={focusKey === spec.key} data-param={spec.key} data-ctl={kind}>
    {#if block}
      <div class="pl-lh">
        {@render lab(spec)}
        {#if kind === 'slider'}<span class="pl-num mono">{fmtNumber(spec, v)}</span>{/if}
      </div>
    {:else}
      {@render lab(spec)}
    {/if}

    {#if kind === 'switch'}
      <span class="pl-c"><Switch checked={!!v} label={labelOf(spec)} onchange={set(spec)} /></span>
    {:else if kind === 'seg'}
      <span class="pl-c"><Segmented size="sm" full label={labelOf(spec)} options={optsOf(spec).map((o) => ({ value: o.value, label: optLabel(o) }))} value={v} onchange={set(spec)} onoverflow={squeeze(spec)} /></span>
    {:else if kind === 'steps'}
      <span class="pl-c"><Segmented size="sm" full mono label={labelOf(spec)} options={steps(spec)} value={v} onchange={set(spec)} onoverflow={squeeze(spec)} /></span>
    {:else if kind === 'select'}
      {@const o = optsOf(spec).find((x) => x.value === v)}
      {@const vt = o ? optLabel(o) : String(v ?? '')}
      <span class="pl-c">
        <button class="pl-sel" class:open={menu?.spec?.key === spec.key} aria-haspopup="listbox" aria-expanded={menu?.spec?.key === spec.key}
          onclick={(e) => (menu = menu?.spec?.key === spec.key ? null : { spec, anchor: e.currentTarget })}>
          <span class="pl-sel-tx" class:mono={(formatOf(spec) === 'size' || formatOf(spec) === 'resolution') && /\d/.test(vt)}>{vt}</span>{@html icon('down')}
        </button>
      </span>
    {:else if kind === 'voice'}
      <span class="pl-c"><button class="pl-sel" onclick={() => onvoice?.(spec)}><span class="pl-sel-tx">{v || t('选音色')}</span>{@html icon('chevR')}</button></span>
    {:else if kind === 'seed'}
      <span class="pl-c pl-seed">
        <input class="pl-in mono" type="number" step="1" placeholder={t('随机')} value={v === -1 ? '' : v} aria-label={labelOf(spec)}
          oninput={(e) => { const n = num(e.currentTarget.value); setParam(page, spec.key, n == null ? -1 : Math.trunc(n)); }} />
        <button class="sd-ib pl-dice" aria-label={t('换一个种子')} title={t('换一个种子')} onclick={() => dice(spec)}>{@html icon('dice')}</button>
      </span>
    {:else if kind === 'number'}
      <span class="pl-c pl-numin">
        <input class="pl-in mono" type="number" step={spec.step || 'any'} value={v} aria-label={labelOf(spec)}
          oninput={(e) => { const n = num(e.currentTarget.value); if (n != null && Number.isFinite(n)) setParam(page, spec.key, n); }} />
        {#if spec.unit}<span class="pl-unit mono">{spec.unit}</span>{/if}
      </span>
    {:else if kind === 'text'}
      <span class="pl-c"><input class="pl-in" type="text" value={v || ''} placeholder={t('未设置')} aria-label={labelOf(spec)} oninput={(e) => setParam(page, spec.key, e.currentTarget.value)} /></span>
    {:else if kind === 'slider'}
      <input class="pl-range" type="range" min={spec.min} max={spec.max} step={spec.step || 1} value={v} style="--pct:{pct(spec, v)}%"
        aria-label={labelOf(spec)} aria-valuetext={fmtNumber(spec, v)} oninput={(e) => setParam(page, spec.key, Number(e.currentTarget.value))} />
    {:else if kind === 'aspect'}
      {@const sp = aspectSplit(optsOf(spec), v)}
      {@const open = sp.open || moreAsp[spec.key]}
      <div class="pl-asp" role="radiogroup" aria-label={labelOf(spec)}>
        {#each [...sp.head, ...(open ? sp.more : [])] as o (String(o.value))}
          <button class="pl-ac" class:on={v === o.value} role="radio" aria-checked={v === o.value} title={optLabel(o)} onclick={() => setParam(page, spec.key, o.value)}>
            {#if isRatio(o.value)}<span class="pl-shape">{@html aspectBox(o.value, 16)}</span><span class="mono">{o.value}</span>
            {:else}<span class="pl-shape auto" aria-hidden="true"></span><span>{optLabel(o)}</span>{/if}
          </button>
        {/each}
        {#if sp.more.length && !sp.open}
          <button class="pl-ac more" aria-expanded={!!moreAsp[spec.key]} onclick={() => (moreAsp[spec.key] = !moreAsp[spec.key])}>
            <span class="pl-shape">{@html icon(moreAsp[spec.key] ? 'up' : 'more')}</span><span>{moreAsp[spec.key] ? t('收起') : t('更多比例')}</span>
          </button>
        {/if}
      </div>
    {:else if kind === 'textarea'}
      <textarea class="pl-in pl-ta" rows="2" value={v || ''} placeholder={t('未设置')} aria-label={labelOf(spec)} oninput={(e) => setParam(page, spec.key, e.currentTarget.value)}></textarea>
    {:else if kind === 'json'}
      <textarea class="pl-in pl-ta mono" rows="3" spellcheck="false" placeholder={'{ }'} value={v || ''} aria-label={labelOf(spec)}
        oninput={(e) => setParam(page, spec.key, e.currentTarget.value)} onblur={(e) => jsonBlur(spec, e.currentTarget.value)}></textarea>
      {#if jsonErr[spec.key]}<p class="pl-err">{jsonErr[spec.key]}</p>{/if}
    {/if}
  </div>
{/snippet}

{#snippet neg()}
  <!-- 负面提示词是任务的顶层字段（§3.3 negative），不是 ParamSpec；模型 inputs.negative 为真才有 -->
  <div class="pl-r blk" class:focus={focusKey === 'negative'} data-param="negative">
    <div class="pl-lh"><span class="pl-l">{t('负面提示词')}</span></div>
    <textarea class="pl-in pl-ta" rows="2" placeholder={t('未设置')} aria-label={t('负面提示词')} bind:value={studio.drafts[page].negative}></textarea>
  </div>
{/snippet}

<div class="pl" class:flat class:only={!!only} bind:this={root}>
  {#if head}
    <div class="pl-model" title={model?.id || ''}>
      {#if logo}<span class="pl-logo">{@html logo}</span>{/if}
      <span class="pl-mtx">
        <b><span>{model ? tr(model.label || model.id) : t('没有模型')}</span></b>
        {#if model?.provider?.name}<small>{tr(model.provider.name)}{#if srcText}<i aria-hidden="true">·</i>{srcText}{/if}</small>{/if}
      </span>
    </div>
  {/if}

  {#if !groups.length && !negative && !only}
    <p class="pl-none">{t('没有可调参数')}</p>
  {:else if groups.length || negative}
    <div class="pl-panel">
      {#each groups as g (g.id)}
        {#if g.id === 'advanced' && hasBasic && !only}
          {#if foldable}
            <button class="pl-gh fold" aria-expanded={advShown} onclick={() => (advOpen = { ...advOpen, [model?.key]: !advShown })}>
              <span>{t('更多')}</span><span class="mono pl-gn">{advSpecs.length}</span>
              {#if !advShown && changedN}<span class="pl-gch">{t('已改 {n}', { n: changedN })}</span>{/if}
              <span class="pl-gchev" class:open={advShown}>{@html icon('down')}</span>
            </button>
          {:else}<div class="pl-gh">{t('更多')}</div>{/if}
        {/if}
        {#if g.id !== 'advanced' || advShown}
          {#each g.specs as spec (spec.key)}{@render row(spec)}{/each}
          <!-- 负面提示词归「更多」：有更多组就排在它的选项后面；只有基本组时另起一个「更多」 -->
          {#if negative && g.id === 'advanced'}{@render neg()}{/if}
        {/if}
        {#if negative && g.id === 'basic' && !hasAdv}<div class="pl-gh">{t('更多')}</div>{@render neg()}{/if}
      {/each}
      {#if negative && !hasBasic && !hasAdv}{@render neg()}{/if}
    </div>
  {/if}
</div>

{#if menu && layout.compact}
  <Layer title={labelOf(menu.spec)} sheet tall={needsSearch(optsOf(menu.spec))} role="listbox" onclose={() => (menu = null)}>
    <OptionList options={optsOf(menu.spec)} value={values[menu.spec.key]} labelOf={optLabel}
      onpick={(x) => { setParam(page, menu.spec.key, x); menu = null; }} />
  </Layer>
{:else if menu}
  <Popover anchor={menu.anchor} align="end" role="listbox" label={labelOf(menu.spec)} minWidth={220} maxWidth={320} maxHeight={Math.min(520, Math.round(innerHeight * 0.7))} onclose={() => (menu = null)}>
    <OptionList inListbox options={optsOf(menu.spec)} value={values[menu.spec.key]} labelOf={optLabel}
      onpick={(x) => { setParam(page, menu.spec.key, x); menu = null; }} />
  </Popover>
{/if}
{#if tip}
  <Layer anchor={tip.anchor} sheet={false} width={260} align="start" onclose={() => (tip = null)}>
    <p class="pl-tip">{tip.text}</p>
  </Layer>
{/if}
