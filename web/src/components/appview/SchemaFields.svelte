<script>
  // 表单积木的字段区（form.fields 的子集）：string / number / integer / boolean，enum，widget textarea / password / segmented，
  // placeholder、min、max、required。长相照插件设置表单（components/ext/PluginForm.svelte）：一行一项、项间细线、
  // 开关项标签在左开关在右、分段选择器是一条灰底里浮起一块。
  //
  // 只管画和收输入：值由 FormBlock 保管（草稿要跨树刷新留住），这里改一下就回调 onset(key, 值)，不直接改父级的对象
  //（Svelte 5 跨组件改 props 代理会报 ownership 警告，回调也让「哪个字段被人动过」好记）。
  // 数字框里存的是原样字符串（「-」「1.」这种打到一半的样子要留得住），提交时 FormBlock 再转成数、校验。
  // 插件给的文字（标签、说明、占位、选项）原样显示，不过 tr()——那是插件自己的语言。
  //
  // 两种形态（AppView 的 .av-touch / .av-desk，令牌见 appview.css）：开关直接用现成套件——手机是设置页的 iOS 27 开关，
  // 桌面是桌面设置页的 DSwitch；输入框、下拉、分段按 --av-* 令牌自己画（套件的分段控件总有一段选中，表单的选填项要能空着）。
  import { t } from '../../lib/i18n.js';
  import Toggle from '../ios27/Toggle.svelte';
  import DSwitch from '../../desktop/kit/DSwitch.svelte';

  let { fields = {}, values = {}, errors = {}, disabled = false, idBase = 'fb', variant = 'touch', dark = false, onset = () => {} } = $props();

  const entries = $derived(Object.entries(fields || {}));
  const isNum = (f) => f.type === 'number' || f.type === 'integer';
  // 选项都是标量（服务端已规整）；值与显示都按它本身
  const opts = (f) => (Array.isArray(f.enum) ? f.enum : []);
  const optIndex = (f, v) => opts(f).findIndex((o) => o === v);
  const fid = (k) => idBase + '-' + k;

  function pickSelect(k, f, e) {
    const i = Number(e.currentTarget.value);
    onset(k, Number.isInteger(i) && i >= 0 && i < opts(f).length ? opts(f)[i] : '');
  }
  // 分段选择器：再点一下已选的那段 = 取消（非必填时），必填的不让点空
  function pickSeg(k, f, o) {
    if (values[k] === o) { if (!f.required) onset(k, ''); return; }
    onset(k, o);
  }
  // 分段选择器的方向键：左右挪选中项（radiogroup 的习惯）
  function segKey(k, f, e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    const list = opts(f);
    if (!list.length) return;
    e.preventDefault();
    const i = optIndex(f, values[k]);
    const n = e.key === 'ArrowRight' ? (i < 0 ? 0 : (i + 1) % list.length) : (i <= 0 ? list.length - 1 : i - 1);
    onset(k, list[n]);
    const btn = e.currentTarget.querySelectorAll('button')[n];
    btn?.focus();
  }
  // DSwitch 的 <button> 没写 type，放在 <form> 里默认是提交钮：点开关会顺带提交表单，在它后面的输入框里按回车，
  // 浏览器的隐式提交还会先「点」它——开关被悄悄翻转再提交。挂上之后补成普通按钮，两样都不会发生
  function plainButtons(node) {
    for (const b of node.querySelectorAll('button:not([type])')) b.type = 'button';
  }
  function numHint(f) {
    const lo = typeof f.min === 'number', hi = typeof f.max === 'number';
    if (lo && hi) return f.min + ' ~ ' + f.max;
    if (lo) return '≥ ' + f.min;
    if (hi) return '≤ ' + f.max;
    return '';
  }
</script>

<div class="sf">
  {#each entries as [k, f] (k)}
    {@const err = errors[k] || ''}
    {#if f.type === 'boolean'}
      <div class="sf-field row" class:bad={!!err}>
        <div class="sf-lab">
          <span>{f.label}{#if f.required}<em class="sf-req" aria-hidden="true">*</em>{/if}</span>
          {#if f.desc}<small>{f.desc}</small>{/if}
        </div>
        <span class="sf-swbox" id={fid(k)}>
          {#if variant === 'desktop'}
            <span class="sf-dsw" {@attach plainButtons}><DSwitch checked={values[k] === true} {disabled} onchange={(v) => onset(k, v === true)} /></span>
          {:else}
            <Toggle checked={values[k] === true} {disabled} ink {dark} label={f.label} onchange={() => onset(k, values[k] !== true)} />
          {/if}
        </span>
      </div>
    {:else}
      <div class="sf-field" class:bad={!!err}>
        {#if f.enum && f.widget === 'segmented'}
          <div class="sf-lab" id={fid(k) + '-l'}>
            <span>{f.label}{#if f.required}<em class="sf-req" aria-hidden="true">*</em>{/if}</span>
            {#if f.desc}<small>{f.desc}</small>{/if}
          </div>
          <!-- svelte-ignore a11y_interactive_supports_focus -->
          <div class="sf-seg" role="radiogroup" aria-labelledby={fid(k) + '-l'} aria-required={f.required || undefined} onkeydown={(e) => segKey(k, f, e)}>
            {#each opts(f) as o, i (i)}
              {@const on = values[k] === o}
              <button type="button" role="radio" aria-checked={on} class:on {disabled}
                tabindex={on || (optIndex(f, values[k]) < 0 && i === 0) ? 0 : -1}
                onclick={() => pickSeg(k, f, o)}>{String(o)}</button>
            {/each}
          </div>
        {:else}
          <label class="sf-lab" for={fid(k)}>
            <span>{f.label}{#if f.required}<em class="sf-req" aria-hidden="true">*</em>{/if}</span>
            {#if f.desc}<small>{f.desc}</small>{/if}
          </label>
          {#if f.enum}
            <select id={fid(k)} class="sf-in" {disabled} aria-invalid={!!err || undefined} aria-required={f.required || undefined}
              value={String(optIndex(f, values[k]))} onchange={(e) => pickSelect(k, f, e)}>
              <option value="-1" disabled={f.required && optIndex(f, values[k]) >= 0}>{f.placeholder || t('请选择')}</option>
              {#each opts(f) as o, i (i)}<option value={String(i)}>{String(o)}</option>{/each}
            </select>
          {:else if f.widget === 'textarea' && !isNum(f)}
            <textarea id={fid(k)} class="sf-in ta" rows="4" {disabled} placeholder={f.placeholder || ''} aria-invalid={!!err || undefined}
              aria-required={f.required || undefined} value={values[k] ?? ''} oninput={(e) => onset(k, e.currentTarget.value)}></textarea>
          {:else if isNum(f)}
            <input id={fid(k)} class="sf-in num" type="text" inputmode={f.type === 'integer' ? 'numeric' : 'decimal'} autocomplete="off" {disabled}
              placeholder={f.placeholder || numHint(f)} aria-invalid={!!err || undefined} aria-required={f.required || undefined}
              value={values[k] ?? ''} oninput={(e) => onset(k, e.currentTarget.value)} />
          {:else}
            <input id={fid(k)} class="sf-in" type={f.widget === 'password' ? 'password' : 'text'} {disabled}
              autocomplete={f.widget === 'password' ? 'new-password' : 'off'} placeholder={f.placeholder || ''}
              aria-invalid={!!err || undefined} aria-required={f.required || undefined}
              value={values[k] ?? ''} oninput={(e) => onset(k, e.currentTarget.value)} />
          {/if}
        {/if}
        {#if err}<div class="sf-err" role="alert">{err}</div>{/if}
      </div>
    {/if}
  {/each}
</div>

<style>
  /* 一行一项（同插件设置表单 .pp-field），尺寸与颜色全用 AppView 的 --av-* 令牌：手机贴设置页、桌面贴桌面设置页 */
  .sf { display: flex; flex-direction: column; }
  .sf-field { position: relative; display: flex; flex-direction: column; gap: 8px; padding: calc(var(--av-py) + 1px) var(--av-px); }
  .sf-field + .sf-field::before { content: ''; position: absolute; top: 0; left: var(--av-px); right: 0; height: 1px; background: var(--av-sep); }
  .sf-field.row { flex-direction: row; align-items: center; gap: 16px; min-height: var(--av-row); padding-top: 6px; padding-bottom: 6px; }
  .sf-lab { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: var(--av-fs); line-height: var(--av-lh); color: var(--av-ink); overflow-wrap: anywhere; }
  .sf-lab small { font-size: var(--av-fs-sub); line-height: var(--av-lh-sub); color: var(--av-ink2); }
  .sf-req { margin-left: 3px; font-style: normal; color: var(--av-err); }
  .sf-swbox { flex: none; display: inline-flex; }
  .sf-dsw { display: contents; }

  .sf-in { width: 100%; height: max(28px, calc(var(--av-row) - 12px)); padding: 0 12px; border: 0; outline: 0; border-radius: var(--av-r-sm);
    background: var(--av-field); color: var(--av-ink); font: inherit; font-size: var(--av-fs); transition: box-shadow var(--av-t) ease; }
  .sf-in:focus { box-shadow: var(--av-focus); }
  .sf-in::placeholder { color: var(--av-ink3); }
  .sf-in.ta { height: auto; min-height: 88px; padding: 9px 12px; resize: vertical; line-height: var(--av-lh); }
  .sf-in.num { font-variant-numeric: tabular-nums; }
  select.sf-in { appearance: auto; }
  .sf-in:disabled { opacity: .5; }
  .bad .sf-in { box-shadow: inset 0 0 0 1px var(--av-err); }
  .bad .sf-in:focus { box-shadow: inset 0 0 0 1px var(--av-err), var(--av-focus); }
  .sf-err { font-size: var(--av-fs-sub); line-height: var(--av-lh-sub); color: var(--av-err); }

  /* 分段选择器：一条底色里浮起选中的那段（同 .pf-chips.seg）；段多了折行，不横向溢出 */
  .sf-seg { display: inline-flex; flex-wrap: wrap; gap: 2px; padding: 2px; border-radius: var(--av-r-sm); background: var(--av-fill2); align-self: flex-start; max-width: 100%; }
  .sf-seg button { appearance: none; border: 0; font: inherit; font-size: var(--av-fs-sm); line-height: var(--av-lh-sm); padding: 5px 12px;
    border-radius: calc(var(--av-r-sm) - 2px); cursor: pointer; white-space: nowrap; background: transparent; color: var(--av-ink2);
    transition: background var(--av-t) ease, color var(--av-t) ease; }
  .sf-seg button:hover:not(:disabled):not(.on) { color: var(--av-ink); }
  .sf-seg button.on { background: var(--av-card); color: var(--av-ink); font-weight: 600; box-shadow: 0 1px 3px rgba(0, 0, 0, .14), 0 0 0 .5px var(--av-sep); }
  :global(.av-dark) .sf-seg button.on { background: var(--av-fill2); box-shadow: 0 1px 3px rgba(0, 0, 0, .4), inset 0 0 0 .5px var(--av-sep); }
  .sf-seg button:focus-visible { outline: none; box-shadow: var(--av-focus); }
  .sf-seg button:disabled { opacity: .5; cursor: default; }
  .bad .sf-seg { box-shadow: inset 0 0 0 1px var(--av-err); }
</style>
