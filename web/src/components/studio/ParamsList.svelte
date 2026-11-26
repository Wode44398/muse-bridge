<script>
  // 参数渲染器（方案 §11「参数一步到位」+ §12.4「一种选中样子」；骨架沿用 §9.2 的 dimensio 属性行）：只按 ParamSpec 渲染，任意来源、任意多个参数都排得下。
  //
  // §11 改的是「怎么改一个值」：以前多数枚举是「选择钮 → 再弹一层菜单」，尺寸要在菜单里的 8 个像素串里挑、或自己算 16 的倍数。
  // 现在选项尽量直接摆在面板上，点一下就是它；只有项很多 / 很长的才进菜单。控件怎么挑见 modules/studio/render.js 的 controlOf：
  //   短枚举 ≤4 → 分段（标签右边）· ≤10 项 → 小块排（标签在上、选项在下）· 比例 → 小形状格 · 再多 → 选择钮 + 菜单（>12 带搜索）
  //   数值 → 细滑条 + 可直接改的数字框 + 单位（小范围整数 → 分段；张数 → − 3 +）· bool → 开关 · 种子 → mono 输入 + 骰子
  //   文本 → 单行 / 多行（卡上给了候选词就在下面摆成小块，点了填进去）· json → 最末「原始参数」
  //   尺寸 → 顶上一个按真实比例画的取景框（四角 + 发丝框，mono「宽 × 高」）+ 比例格 + 1K / 2K / 4K 一排 + 一直在的 宽 × 高
  // 所有「几选一」（分段、小块、比例格、档位、张数）都是 ui/Segmented：浅墨底上一块墨，换选项时墨块沿弹簧滑过去；
  // 以前的比例格黑粗框、白胶囊这几种样子都去掉了。
  // 改过的行标签后面有一枚「恢复默认」，面板末尾一枚恢复全部。「更多」只在这一组超过 6 项时收起，展开过本机记住。
  // 参数说明 desc 不上正文（维护者：不写解释句），桌面悬停标签出 title、触屏长按标签出一个小气泡。
  // 同一个组件放参数坞（dock：上面多一张模型卡）、参数浮层 / Sheet（flat），以及值芯片点开的单项浮层（only）。
  import { tick } from 'svelte';
  import { t, tc, tr } from '../../lib/i18n.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { studio, setParam, resetParam, resetParams, setAdvOpen, saveDrafts, valuesOf, labelForId, originalDims } from '../../modules/studio/media.svelte.js';
  import { optionsOf, jsonError, resolveValues } from '../../modules/studio/params.js';
  import { controlOf, paramGroups, isRatio, formatOf, needsSearch, isChanged, PILLS_MAX } from '../../modules/studio/render.js';
  import { paramLabel, optText, sourceText, sizeIssueText } from '../../modules/studio/words.js';
  import { isCustomSize, parseSize, sizeIssues, fitSize, badSides, sizeText, sizeGrid, gridMatch, pickRatio, pickTier } from '../../modules/studio/size.js';
  import { paramSource } from '../../modules/studio/picker.js';
  import { providerLogo } from '../../lib/providerLogos.js';
  import { icon, aspectBox } from '../../modules/studio/icons.js';
  import { rise } from '../../modules/studio/motion.js';
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
  let menu = $state(null);       // { spec, anchor }：选择钮点开的选项菜单（只剩项多 / 项长的参数用）
  let tip = $state(null);        // { anchor, text }：触屏长按标签出的说明
  let tight = $state({});        // 分段放不下（实测字被切）的参数：换成小块排（按「模型 | 参数」记，换了模型重新量）
  let jsonOpen = $state({});     // 原始 JSON 参数：空着时收成一行「填写」，点了才出文本框（面板上不常驻一个 { } 框）

  const hasBasic = $derived(groups.some((g) => g.id === 'basic'));
  const hasAdv = $derived(groups.some((g) => g.id === 'advanced'));
  const advSpecs = $derived(groups.find((g) => g.id === 'advanced')?.specs || []);
  // 「更多」只在这一组真的多（> 6 项）时收起；展开过就一直展开（本机记住）
  const foldable = $derived(!only && hasBasic && advSpecs.length + (negative ? 1 : 0) > 6);
  const advShown = $derived(!foldable || studio.advOpen || (!!focusKey && (focusKey === 'negative' || advSpecs.some((x) => x.key === focusKey))));
  const defaults = $derived(resolveValues(model?.params || [], {}, model?.id || '', { edit: values.$edit, first: values.$first, last: values.$last, ref: values.$ref }));
  const changed = (spec) => isChanged(values[spec.key], defaults[spec.key]);
  const negChanged = $derived(negative && !!studio.drafts[page].negative);
  const advChangedN = $derived(advSpecs.filter(changed).length + (negChanged ? 1 : 0));
  const changedN = $derived(groups.reduce((n, g) => n + g.specs.filter(changed).length, 0) + (negChanged ? 1 : 0));
  // 标签 / 选项文字过一层翻译（words.js）：括号里的说明进悬停 / 长按；上游英文名按常见键名换成界面名；接口原值整理成人话
  const labelOf = (spec) => paramLabel(spec);
  const fullLabel = (spec) => (spec.label ? tr(spec.label) : labelOf(spec));
  const optLabel = optText;
  const optsOf = (spec) => optionsOf(spec, model?.id, values);
  const tk = (spec) => (model?.key || '') + '|' + spec.key;
  function ctl(spec) {
    const k = controlOf(spec, spec.type === 'enum' ? optsOf(spec) : [], { labelOf: optLabel });
    if (tight[tk(spec)] && k === 'seg') return 'pills';
    if (tight[tk(spec)] && k === 'steps') return 'slider';
    return k;
  }
  const squeeze = (spec) => () => { if (!tight[tk(spec)]) tight[tk(spec)] = true; };
  const num = (v) => (v === '' || v == null ? undefined : Number(v));
  const unset = (v) => v === undefined || v === null;
  const pct = (spec, v) => (unset(v) ? 0 : ((Number(v) - spec.min) / Math.max(1e-9, spec.max - spec.min)) * 100);
  const dp = (spec) => (spec?.step && spec.step < 1 ? (String(spec.step).split('.')[1]?.length || 2) : 0);
  const numText = (spec, v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? '' : dp(spec) ? Number(v).toFixed(dp(spec)) : String(Math.round(Number(v) * 1000) / 1000));
  const unitOf = (spec) => spec?.unit || (formatOf(spec) === 'duration' ? 's' : '');
  function steps(spec) {
    const out = [];
    for (let x = spec.min; x <= spec.max + 1e-9; x += spec.step || 1) out.push({ value: Math.round(x * 1000) / 1000, label: numText(spec, x) });
    return out;
  }
  // 数字框：回车 / 失焦才落值——夹进上下限、落到步长上；打的不是数就回显原值
  function commitNum(spec, el) {
    const n = Number(String(el.value).trim());
    // 清空 = 回到默认 / 未设置
    if (el.value.trim() === '') resetParam(page, spec.key);
    else if (Number.isFinite(n)) {
      const step = spec.step || (spec.integer ? 1 : 0);
      let x = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, n));
      if (step) x = Math.round((x - (spec.min ?? 0)) / step) * step + (spec.min ?? 0);
      if (spec.integer) x = Math.round(x);
      setParam(page, spec.key, Math.round(x * 1e6) / 1e6);
    }
    el.value = numText(spec, values[spec.key]);
  }
  const numKey = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } };
  function bump(spec, d) {
    const v = values[spec.key];
    const next = unset(v) ? spec.min : Number(v) + d * (spec.step || 1);
    setParam(page, spec.key, Math.min(spec.max, Math.max(spec.min, next)));
  }
  function jsonBlur(spec, text) {
    const e = jsonError(text, !!spec.array);
    jsonErr[spec.key] = e === 'syntax' ? t('不是合法的 JSON') : e === 'object' ? t('要写成一个对象：{ "键": 值 }') : e === 'array' ? t('要写成一个列表：[ … ]') : '';
  }
  function dice(spec) { setParam(page, spec.key, Math.floor(Math.random() * 2147483647)); }
  const set = (spec) => (v) => setParam(page, spec.key, v);

  // —— 尺寸 ——
  // 「原图」实际会按多大出：原图像素按规则挪进约束之后的宽高（不知道原图多大就不写）
  const orig = $derived(originalDims(page));
  const origOut = (spec) => (orig ? fitSize(spec.custom, orig) : null);
  // 直接摆出来的档：有「比例 × 档位」格的模型只摆 自动 / 原图 / 默认（像素预设由格子顶替）；没有格子的摆全部档位
  const sizeQuick = (spec, grid) => optsOf(spec).filter((o) => !grid || !parseSize(o.value)).map((o) => (o.value === 'original' && origOut(spec) ? { ...o, hint: sizeText(origOut(spec)) } : o));
  const menuOpts = (spec) => (spec.type === 'size' ? sizeQuick(spec, sizeGrid(spec)) : optsOf(spec));
  function pick(spec, x) { setParam(page, spec.key, x); menu = null; }
  // 宽 / 高输入：只在是正整数时写进草稿（打到一半清空也不回落默认）；失焦时回显草稿里的值
  function setSide(spec, side, raw) {
    const n = Number(String(raw).trim());
    if (!Number.isInteger(n) || n <= 0) return;
    const cur = parseSize(values[spec.key]);
    setParam(page, spec.key, { width: cur?.width ?? n, height: cur?.height ?? n, [side]: n });
  }
  const sideText = (spec, side) => String(parseSize(values[spec.key])?.[side] ?? '');
  const sizeSelLabel = (spec, v) => {
    if (isCustomSize(v)) return sizeText(parseSize(v));
    const o = optsOf(spec).find((x) => x.value === v);
    return o ? optLabel(o) : String(v ?? '');
  };

  // —— 几选一的选项（给 Segmented）——
  const segOpts = (opts) => opts.map((o) => ({ value: o.value, label: optLabel(o), hint: o.hint ? tr(String(o.hint)) : '', rejected: !!o.rejected, title: o.rejected ? t('这个服务上次拒收了它') : null }));
  // 比例格：每格上面一个按比例缩放的小框；「自动 / 默认 / 原图」是虚线方框（原图知道多大就画它的形状）
  const AUTO_GLYPH = '<span class="pl-auto"></span>';
  const cellOf = (o, glyphRatio) => ({ value: o.value, label: isRatio(o.value) ? String(o.value) : optLabel(o), glyph: (glyphRatio && aspectBox(glyphRatio, 16)) || AUTO_GLYPH, rejected: !!o.rejected, title: o.hint ? optLabel(o) + ' ' + tr(String(o.hint)) : null });
  const gridCols = (n) => (n <= 6 ? n : n <= 10 ? 5 : 6);

  // —— 取景框：按真实比例画（四角同生成中的取景框），里面 mono 写尺寸；比例 / 尺寸一变，框沿弹簧变形过去 ——
  const CORNER = '<svg viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M1 9V3.2A2.2 2.2 0 0 1 3.2 1H9"/></svg>';
  const VF_W = 132, VF_H = 70;
  function vfBox(ratio) {
    if (!(ratio > 0)) return { w: 58, h: 58, auto: true };
    const k = Math.min(VF_W / ratio, VF_H);
    return { w: Math.max(14, Math.round(k * ratio)), h: Math.max(14, Math.round(k)), auto: false };
  }
  const ratioOf = (s) => (s && s.width > 0 && s.height > 0 ? s.width / s.height : 0);
  const ratioNum = (r) => { const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(r || '')); return m ? Number(m[1]) / Number(m[2]) : 0; };
  // 尺寸参数现在画成什么：{ ratio, text }（自动写「自动」；原图知道多大就写实际会发出的像素）
  function sizeView(spec, v) {
    const s = parseSize(v);
    if (s) return { ratio: ratioOf(s), text: `${s.width} × ${s.height}` };
    if (v === 'original') { const o = origOut(spec); return o ? { ratio: ratioOf(o), text: `${t('原图')} ${o.width} × ${o.height}` } : { ratio: 0, text: t('原图') }; }
    const o = optsOf(spec).find((x) => x.value === v);
    return { ratio: 0, text: o ? optLabel(o) : t('自动') };
  }
  function aspectView(spec, v) {
    if (isRatio(v)) return { ratio: ratioNum(v), text: String(v) };
    const o = optsOf(spec).find((x) => x.value === v);
    return { ratio: 0, text: o ? optLabel(o) : t('自动') };
  }

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
  <span class="pl-lw">
    <span class="pl-l" title={tipText || labelOf(spec)} use:hold={tipText}>{labelOf(spec)}</span>
    {#if !only && changed(spec)}
      <button class="pl-rst" aria-label={t('{name}恢复默认', { name: labelOf(spec) })} title={t('恢复默认')} onclick={() => resetParam(page, spec.key)}>{@html icon('reset')}</button>
    {/if}
  </span>
{/snippet}

{#snippet pills(spec, opts, v, onpick, clearable = false)}
  <!-- rejected：这个服务上次明确拒收过这个取值（方案 §11.4）——照样能点（服务可能升级了），只是删除线标出来 -->
  <Segmented layout="wrap" size="sm" label={labelOf(spec)} options={segOpts(opts)} value={v} onchange={onpick} {clearable} />
{/snippet}

{#snippet viewfinder(view)}
  {@const b = vfBox(view.ratio)}
  <div class="pl-vf" aria-hidden="true">
    <div class="pl-vfb" class:auto={b.auto} style="width:{b.w}px;height:{b.h}px">
      <span class="pl-vfe"></span>
      {#each ['tl', 'tr', 'bl', 'br'] as c (c)}<span class="pl-vfc {c}">{@html CORNER}</span>{/each}
      {#key view.text}<b class="mono" in:rise={{ y: 4 }}>{view.text}</b>{/key}
    </div>
  </div>
{/snippet}

{#snippet selbtn(spec, text, mono)}
  <button class="pl-sel" class:open={menu?.spec?.key === spec.key} aria-haspopup="listbox" aria-expanded={menu?.spec?.key === spec.key}
    onclick={(e) => (menu = menu?.spec?.key === spec.key ? null : { spec, anchor: e.currentTarget })}>
    <span class="pl-sel-tx" class:mono>{text}</span>{@html icon('down')}
  </button>
{/snippet}

{#snippet row(spec)}
  {@const v = values[spec.key]}
  {@const kind = ctl(spec)}
  {@const grid = kind === 'size' ? sizeGrid(spec) : null}
  {@const quick = kind === 'size' ? sizeQuick(spec, grid) : []}
  {@const sizeSel = kind === 'size' && quick.length > PILLS_MAX}
  {@const hintList = kind === 'text' && Array.isArray(spec.options) ? spec.options.filter((o) => o.value !== '' && o.value != null) : []}
  {@const hints = hintList.length ? hintList : null}
  {@const jsonShut = kind === 'json' && !String(v || '').trim() && !jsonOpen[tk(spec)]}
  {@const block = kind === 'aspect' || kind === 'slider' || kind === 'textarea' || (kind === 'json' && !jsonShut) || kind === 'pills' || !!hints || (kind === 'size' && !sizeSel) }
  <div class="pl-r" class:blk={block} class:focus={focusKey === spec.key} data-param={spec.key} data-ctl={kind}>
    {#if block}
      <div class="pl-lh">
        {@render lab(spec)}
        {#if kind === 'slider'}
          <span class="pl-nv">
            <input class="pl-in mono" inputmode="decimal" value={numText(spec, v)} placeholder={t('默认')} aria-label={labelOf(spec)} onchange={(e) => commitNum(spec, e.currentTarget)} onkeydown={numKey} />
            {#if unitOf(spec)}<span class="pl-unit mono">{unitOf(spec)}</span>{/if}
          </span>
        {/if}
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
    {:else if kind === 'pills'}
      {@render pills(spec, optsOf(spec), v, set(spec))}
    {:else if kind === 'stepper'}
      <span class="pl-c pl-step">
        <button class="sd-ib" aria-label={t('减一')} disabled={unset(v) || Number(v) <= spec.min} onclick={() => bump(spec, -1)}>{@html icon('minus')}</button>
        <input class="pl-in mono" inputmode="numeric" value={numText(spec, v)} placeholder={t('默认')} aria-label={labelOf(spec)} onchange={(e) => commitNum(spec, e.currentTarget)} onkeydown={numKey} />
        <button class="sd-ib" aria-label={t('加一')} disabled={Number(v) >= spec.max} onclick={() => bump(spec, 1)}>{@html icon('plus')}</button>
      </span>
    {:else if kind === 'size'}
      {@const custom = isCustomSize(v)}
      {@const issues = custom ? sizeIssues(spec, v) : []}
      {@const bad = badSides(issues)}
      {#if spec.custom}{@render viewfinder(sizeView(spec, v))}{/if}
      {#if sizeSel}
        <span class="pl-c">{@render selbtn(spec, sizeSelLabel(spec, v), /\d/.test(sizeSelLabel(spec, v)))}</span>
      {:else if quick.length && !grid}
        {@render pills(spec, quick, v, set(spec))}
      {/if}
      {#if grid}
        {@const m = gridMatch(spec, v, grid)}
        {@const cells = [...quick.map((o) => cellOf(o, o.value === 'original' && orig ? orig.width + ':' + orig.height : '')), ...grid.ratios.map((r) => cellOf({ value: r }, r))]}
        <!-- 自动 / 原图 / 默认是格子里的头几格（不单独占一行）；自动时档位一排淡下去，点了就按方图换算 -->
        <Segmented layout="grid" cols={gridCols(cells.length)} mono label={labelOf(spec)} options={cells}
          value={quick.some((o) => o.value === v) ? v : m.ratio} onchange={(x) => setParam(page, spec.key, isRatio(x) ? pickRatio(spec, v, x, grid) : x)} />
        {#if grid.tiers.length > 1}
          <Segmented size="sm" full mono dim={!m.tier} label={t('清晰度')} options={grid.tiers.map((x) => ({ value: x.id, label: x.id }))} value={m.tier} onchange={(id) => setParam(page, spec.key, pickTier(spec, v, id, grid))} />
        {/if}
      {/if}
      {#if spec.custom}
        {@const ph = v === 'original' ? origOut(spec) : null}
        <div class="pl-wh">
          <input class="pl-in mono" class:bad={bad.has('width')} inputmode="numeric" value={sideText(spec, 'width')} placeholder={ph ? String(ph.width) : tc('尺寸', '宽')} aria-label={tc('尺寸', '宽')} aria-invalid={bad.has('width')}
            oninput={(e) => setSide(spec, 'width', e.currentTarget.value)} onblur={(e) => (e.currentTarget.value = sideText(spec, 'width'))} />
          <span class="pl-x" aria-hidden="true">×</span>
          <input class="pl-in mono" class:bad={bad.has('height')} inputmode="numeric" value={sideText(spec, 'height')} placeholder={ph ? String(ph.height) : tc('尺寸', '高')} aria-label={tc('尺寸', '高')} aria-invalid={bad.has('height')}
            oninput={(e) => setSide(spec, 'height', e.currentTarget.value)} onblur={(e) => (e.currentTarget.value = sideText(spec, 'height'))} />
        </div>
        {#if issues.length}<p class="pl-err pl-wh-err">{[...new Set(issues.slice(0, 3).map(sizeIssueText))].join(t('；'))}</p>{/if}
      {/if}
    {:else if kind === 'select'}
      {@const o = optsOf(spec).find((x) => x.value === v)}
      {@const vt = o ? optLabel(o) : String(v ?? '')}
      <span class="pl-c">{@render selbtn(spec, vt, (formatOf(spec) === 'size' || formatOf(spec) === 'resolution') && /\d/.test(vt))}</span>
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
        <input class="pl-in mono" type="number" step={spec.step || 'any'} value={v ?? ''} placeholder={t('默认')} aria-label={labelOf(spec)}
          oninput={(e) => { const n = num(e.currentTarget.value); if (n == null) resetParam(page, spec.key); else if (Number.isFinite(n)) setParam(page, spec.key, n); }} />
        {#if spec.unit}<span class="pl-unit mono">{spec.unit}</span>{/if}
      </span>
    {:else if kind === 'text' && hints}
      <input class="pl-in" type="text" value={v || ''} placeholder={t('未设置')} aria-label={labelOf(spec)} oninput={(e) => setParam(page, spec.key, e.currentTarget.value)} />
      <!-- 候选词（配音风格这类）：点了填进去，再点一下清掉；自己打别的也行 -->
      {@render pills(spec, hints, v, (x) => setParam(page, spec.key, x ?? ''), true)}
    {:else if kind === 'text'}
      <span class="pl-c"><input class="pl-in" type="text" value={v || ''} placeholder={t('未设置')} aria-label={labelOf(spec)} oninput={(e) => setParam(page, spec.key, e.currentTarget.value)} /></span>
    {:else if kind === 'slider'}
      <input class="pl-range" class:unset={unset(v)} type="range" min={spec.min} max={spec.max} step={spec.step || 1} value={unset(v) ? spec.min : v} style="--pct:{pct(spec, v)}%"
        aria-label={labelOf(spec)} aria-valuetext={numText(spec, v) + (unitOf(spec) ? ' ' + unitOf(spec) : '')} oninput={(e) => setParam(page, spec.key, Number(e.currentTarget.value))} />
    {:else if kind === 'aspect'}
      {@const cells = optsOf(spec).map((o) => cellOf(o, isRatio(o.value) ? o.value : ''))}
      {@render viewfinder(aspectView(spec, v))}
      <Segmented layout="grid" cols={gridCols(cells.length)} mono label={labelOf(spec)} options={cells} value={v} onchange={set(spec)} />
    {:else if kind === 'textarea'}
      <textarea class="pl-in pl-ta" rows="2" value={v || ''} placeholder={t('未设置')} aria-label={labelOf(spec)} oninput={(e) => setParam(page, spec.key, e.currentTarget.value)}></textarea>
    {:else if kind === 'json' && jsonShut}
      <span class="pl-c"><button class="pl-sel" onclick={() => (jsonOpen[tk(spec)] = true)}><span class="pl-sel-tx">{t('填写')}</span>{@html icon('chevR')}</button></span>
    {:else if kind === 'json'}
      <textarea class="pl-in pl-ta mono" rows="3" spellcheck="false" placeholder={spec.array ? '[ ]' : '{ }'} value={v || ''} aria-label={labelOf(spec)}
        oninput={(e) => setParam(page, spec.key, e.currentTarget.value)} onblur={(e) => jsonBlur(spec, e.currentTarget.value)}></textarea>
      {#if jsonErr[spec.key]}<p class="pl-err">{jsonErr[spec.key]}</p>{/if}
    {/if}
  </div>
{/snippet}

{#snippet neg()}
  <!-- 负面提示词是任务的顶层字段（§3.3 negative），不是 ParamSpec；模型 inputs.negative 为真才有 -->
  <div class="pl-r blk" class:focus={focusKey === 'negative'} data-param="negative">
    <div class="pl-lh">
      <span class="pl-lw">
        <span class="pl-l">{t('负面提示词')}</span>
        {#if negChanged}<button class="pl-rst" aria-label={t('{name}恢复默认', { name: t('负面提示词') })} title={t('恢复默认')} onclick={() => { studio.drafts[page].negative = ''; saveDrafts(); }}>{@html icon('reset')}</button>{/if}
      </span>
    </div>
    <textarea class="pl-in pl-ta" rows="2" placeholder={model?.inputs?.negativeDefault ? String(model.inputs.negativeDefault) : t('未设置')} aria-label={t('负面提示词')} bind:value={studio.drafts[page].negative} oninput={saveDrafts}></textarea>
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
        {#if g.id === 'advanced' && foldable}
          <button class="pl-gh fold" aria-expanded={advShown} onclick={() => setAdvOpen(!advShown)}>
            <span>{t('更多')}</span><span class="mono pl-gn">{advSpecs.length + (negative ? 1 : 0)}</span>
            {#if !advShown && advChangedN}<span class="pl-gch">{t('已改 {n}', { n: advChangedN })}</span>{/if}
            <span class="pl-gchev" class:open={advShown}>{@html icon('down')}</span>
          </button>
        {/if}
        {#if g.id !== 'advanced' || advShown}
          {#each g.specs as spec (spec.key)}{@render row(spec)}{/each}
          <!-- 负面提示词归「更多」：有更多组就排在它的选项后面 -->
          {#if negative && g.id === 'advanced'}{@render neg()}{/if}
        {/if}
        {#if negative && g.id === 'basic' && !hasAdv}{@render neg()}{/if}
      {/each}
      {#if negative && !hasBasic && !hasAdv}{@render neg()}{/if}
      {#if !only && changedN}
        <div class="pl-foot"><button class="pl-rall" onclick={() => resetParams(page, model)}>{@html icon('reset')}<span>{t('全部恢复默认')}</span></button></div>
      {/if}
    </div>
  {/if}
</div>

{#if menu && layout.compact}
  <Layer title={labelOf(menu.spec)} sheet tall={needsSearch(menuOpts(menu.spec))} role="listbox" onclose={() => (menu = null)}>
    <OptionList options={menuOpts(menu.spec)} value={values[menu.spec.key]} labelOf={optLabel}
      onpick={(x) => pick(menu.spec, x)} />
  </Layer>
{:else if menu}
  <Popover anchor={menu.anchor} align="end" role="listbox" label={labelOf(menu.spec)} minWidth={220} maxWidth={320} maxHeight={Math.min(520, Math.round(innerHeight * 0.7))} onclose={() => (menu = null)}>
    <OptionList inListbox options={menuOpts(menu.spec)} value={values[menu.spec.key]} labelOf={optLabel}
      onpick={(x) => pick(menu.spec, x)} />
  </Popover>
{/if}
{#if tip}
  <Layer anchor={tip.anchor} sheet={false} width={260} align="start" onclose={() => (tip = null)}>
    <p class="pl-tip">{tip.text}</p>
  </Layer>
{/if}
