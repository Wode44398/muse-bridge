<script module>
  // 表单草稿：appKey + 表单 id → { raw: { 字段: 输入原样 }, dirty: Set<字段> }。放在模块里而不是组件里：
  // 插件推一棵新树（plugins.app.refresh / 别的动作回来）时积木组件可能被重建，人正打着的字不能跟着没了；
  // 离开应用页再回来也还在。提交成功才清掉（value 是初始值，刷新不覆盖正在输入的）。
  // 只存在内存里，绝不落盘（密码框的字也在这里）。
  // 退出登录不重载页面（account.js 的 signOut 只清登录态），同一个标签页里换个账号再进同一个应用，
  // 上一个人填了一半的字（含密码）不能回填给下一个人：键带上登录身份，身份一变整张表清空。
  import { me } from '../../lib/state.svelte.js';

  const drafts = new Map();
  const DRAFT_MAX = 50;
  let draftOwner = '';
  const ownerNow = () => (me.kind && me.kind !== 'none' ? me.kind + ':' + (me.user || '') : '');
  function syncOwner() {
    const o = ownerNow();
    if (o !== draftOwner) { drafts.clear(); draftOwner = o; }
  }
  function getDraft(key) {
    syncOwner();
    return drafts.get(key);
  }
  function keepDraft(key, d) {
    syncOwner();
    drafts.delete(key);
    drafts.set(key, d);
    while (drafts.size > DRAFT_MAX) drafts.delete(drafts.keys().next().value);
  }

  // 一个字段的初始输入：value 里给了就用（数字转成字符串放进框里），没给按类型留空
  function initialOf(f, v) {
    if (f.type === 'boolean') return v === true;
    if (Array.isArray(f.enum)) return f.enum.includes(v) ? v : '';
    if (f.type === 'number' || f.type === 'integer') return typeof v === 'number' && Number.isFinite(v) ? String(v) : typeof v === 'string' ? v : '';
    return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
  }
</script>

<script>
  // 声明式应用的 form 积木：字段区交给 SchemaFields，这里管草稿、校验、提交与取消。
  //   提交：先校验（必填、数字格式、整数、min / max、选项在不在列表里），过了按钮转圈、ctx.run(submit.action, { values })；
  //   成功清草稿、回到插件新给的初始值；失败草稿留着（runAction 已经弹过错误 toast）。
  //   取消（可选）：{ label, action? }——有动作就跑动作，没有就把输入清回初始值；label 空用「取消」。
  // values 的形状：string / 密码 / 多行 → 字符串；number / integer → 数（选填没填的不带）；boolean → true / false；
  // 选项 → 选中的那个值（选填没选的不带）。
  import { untrack } from 'svelte';
  import SchemaFields from './SchemaFields.svelte';
  import { t } from '../../lib/i18n.js';

  let { block, ctx } = $props();

  const fields = $derived(block?.fields && typeof block.fields === 'object' ? block.fields : {});
  // 身份进键：换了账号 boundKey 对不上，表单回到插件给的初始值
  const draftKey = $derived(ownerNow() + '\u0001' + (ctx?.appKey || '') + '\u0001' + (block?.id || 'form'));

  let raw = $state({});
  let dirty = new Set();
  let errors = $state({});
  let submitting = $state(false);
  let rootEl;
  let submitEl;

  // 按当前积木把没被人动过的字段对齐到插件给的初始值；被动过的留着输入。表单换了（另一个 id）就整个换成那个表单的草稿
  let boundKey = '';
  $effect(() => {
    const key = draftKey;
    const fs = fields;
    const val = block?.value && typeof block.value === 'object' ? block.value : {};
    untrack(() => {
      if (key !== boundKey) {
        boundKey = key;
        const d = getDraft(key);
        dirty = d ? new Set(d.dirty) : new Set();
        errors = {};
        const next = {};
        for (const [k, f] of Object.entries(fs)) next[k] = d && dirty.has(k) && k in d.raw ? d.raw[k] : initialOf(f, val[k]);
        raw = next;
        return;
      }
      // 同一个表单来了新树：只动没被改过的；字段没了的丢掉
      for (const k of Object.keys(raw)) if (!(k in fs)) { delete raw[k]; dirty.delete(k); }
      for (const [k, f] of Object.entries(fs)) {
        if (dirty.has(k)) continue;
        const v = initialOf(f, val[k]);
        if (raw[k] !== v) raw[k] = v;
      }
    });
  });

  function onset(k, v) {
    raw[k] = v;
    dirty.add(k);
    if (errors[k]) { const e = { ...errors }; delete e[k]; errors = e; }
    keepDraft(draftKey, { raw: { ...raw }, dirty: new Set(dirty) });
  }

  const busy = $derived(submitting || !!ctx?.busy?.(block?.submit?.action));
  const anyBusy = $derived(!!ctx?.busy?.());

  function fmtLimit(n) { return typeof n === 'number' ? String(n) : ''; }

  /** 校验 + 组装：→ { values, errors }。 */
  function collect() {
    const out = {};
    const errs = {};
    for (const [k, f] of Object.entries(fields)) {
      const v = raw[k];
      if (f.type === 'boolean') { out[k] = v === true; continue; }
      if (Array.isArray(f.enum)) {
        if (v === '' || v == null || !f.enum.includes(v)) { if (f.required) errs[k] = t('请选一项'); continue; }
        out[k] = v;
        continue;
      }
      if (f.type === 'number' || f.type === 'integer') {
        const s = String(v ?? '').trim();
        if (!s) { if (f.required) errs[k] = t('这一项必填'); continue; }
        const n = Number(s);
        if (!Number.isFinite(n)) { errs[k] = t('要填一个数'); continue; }
        if (f.type === 'integer' && !Number.isInteger(n)) { errs[k] = t('要填整数'); continue; }
        if (typeof f.min === 'number' && n < f.min) { errs[k] = t('不能小于 {n}', { n: fmtLimit(f.min) }); continue; }
        if (typeof f.max === 'number' && n > f.max) { errs[k] = t('不能大于 {n}', { n: fmtLimit(f.max) }); continue; }
        out[k] = n;
        continue;
      }
      const s = typeof v === 'string' ? v : '';
      if (f.required && !s.trim()) { errs[k] = t('这一项必填'); continue; }
      out[k] = s;
    }
    return { values: out, errors: errs };
  }

  function focusFirstError(errs) {
    const k = Object.keys(fields).find((x) => errs[x]);
    if (!k || !rootEl) return;
    const el = rootEl.querySelector('#' + CSS.escape(idBase + '-' + k)) || rootEl.querySelector('[aria-labelledby="' + idBase + '-' + k + '-l"] button');
    el?.focus?.();
  }

  async function submit(e) {
    e?.preventDefault?.();
    // 只认自己的「提交」钮与回车。表单里别的按钮万一没写 type（默认就是提交钮，比如桌面套件的 DSwitch），
    // 点它只该做它自己的事，不能顺带把表单发给插件
    if (e?.submitter && e.submitter !== submitEl) return;
    if (busy || anyBusy || !block?.submit?.action) return;
    const r = collect();
    errors = r.errors;
    if (Object.keys(r.errors).length) { focusFirstError(r.errors); return; }
    submitting = true;
    const key = draftKey;
    try {
      const ok = await ctx.run(block.submit.action, { values: r.values });
      if (ok && key === draftKey) reset();
    } finally {
      submitting = false;
    }
  }

  // 清回插件给的初始值（取消、提交成功都走这里）
  function reset() {
    drafts.delete(draftKey);
    dirty = new Set();
    errors = {};
    const val = block?.value && typeof block.value === 'object' ? block.value : {};
    const next = {};
    for (const [k, f] of Object.entries(fields)) next[k] = initialOf(f, val[k]);
    raw = next;
  }

  const cancel = $derived(block?.cancel && typeof block.cancel === 'object' ? block.cancel : block?.cancel === true ? { label: '' } : null);
  const cancelBusy = $derived(!!(cancel?.action && ctx?.busy?.(cancel.action)));
  async function onCancel() {
    if (!cancel || anyBusy) return;
    if (cancel.action) {
      const ok = await ctx.run(cancel.action);
      if (ok) reset();
      return;
    }
    reset();
  }

  // 每个表单的元素 id 前缀：同一页可能挂着好几个表单，label for 不能撞
  const uid = Math.random().toString(36).slice(2, 8);
  const idBase = $derived('fb-' + uid + '-' + (block?.id || 'form'));
  const errCount = $derived(Object.keys(errors).length);
</script>

<form class="fb" bind:this={rootEl} onsubmit={submit} novalidate>
  <div class="fb-card av-card">
    <SchemaFields {fields} values={raw} {errors} {idBase} {onset} variant={ctx?.variant || 'touch'} dark={!!ctx?.dark} />
  </div>
  <div class="fb-acts">
    {#if errCount}<span class="fb-note" aria-live="polite">{t('有 {n} 项要改一下', { n: errCount })}</span>{/if}
    {#if cancel}
      <button type="button" class="fb-btn" disabled={anyBusy} onclick={onCancel}>
        {#if cancelBusy}<span class="av-spin" aria-hidden="true"></span>{/if}{cancel.label || t('取消')}
      </button>
    {/if}
    <button type="submit" class="fb-btn pri" bind:this={submitEl} disabled={anyBusy && !busy} aria-busy={busy || undefined}>
      {#if busy}<span class="av-spin" aria-hidden="true"></span>{/if}{block?.submit?.label || t('提交')}
    </button>
  </div>
</form>

<style>
  .fb { display: flex; flex-direction: column; gap: var(--av-gap-in); min-width: 0; margin: 0; }
  /* 字段放在一张分组卡里（.av-card：手机 = 设置页 .ig，桌面 = DGroup），overflow 要放开：聚焦环不能被卡边裁掉 */
  .fb-card { overflow: visible; padding: 2px 0; }
  .fb-acts { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }
  .fb-note { margin-right: auto; font-size: var(--av-fs-sub); line-height: var(--av-lh-sub); color: var(--av-err); }
  .fb-btn { appearance: none; border: 0; font: inherit; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    height: var(--av-btn-h); padding: 0 18px; border-radius: var(--av-btn-r); white-space: nowrap; font-size: var(--av-btn-fs); font-weight: 600;
    color: var(--av-ink); background: var(--av-fill2);
    transition: transform var(--mo-tap, .09s) var(--ea-out, ease-out), opacity var(--av-t), background var(--av-t); }
  .fb-btn:hover:not(:disabled) { background: var(--av-press); }
  .fb-btn:active:not(:disabled) { transform: scale(.97); opacity: .86; }
  .fb-btn:focus-visible { outline: none; box-shadow: var(--av-focus); }
  .fb-btn:disabled { opacity: .45; cursor: default; }
  .fb-btn.pri { background: var(--av-accent); color: var(--av-on-accent); }
  .fb-btn.pri:hover:not(:disabled) { background: var(--av-accent); opacity: .92; }
  .fb-btn[aria-busy] { cursor: progress; }
  :global(.av-desk) .fb-btn { padding: 0 14px; font-weight: 500; }
  /* 手机：按钮铺满一行，好按 */
  :global(.av-touch) .fb-acts .fb-btn { flex: 1; }
  :global(.av-touch) .fb-note { flex-basis: 100%; }
</style>
