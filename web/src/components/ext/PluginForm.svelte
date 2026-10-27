<script>
  // 插件配置的自动表单（设置 › 扩展 › 功能扩展 › 插件详情）：按插件清单的 config schema 生成，插件不用写前端。
  // schema 写法见 src/kernel/schema.mjs 顶部；这里认的表单字段：
  //   section 分组标题（同组字段排在一起，按第一次出现的顺序）     when { 字段: 值 | [值…] } 条件显示
  //   widget  textarea / password / slider / chips / segmented        options 动态选项（服务端 /api/plugins/options 现算）
  //   结构化  array + items（逐行增删；items 是带 fields 的 object 时每行一个小表单）、object + fields（固定子表单）、
  //           map（按键编辑的表：键 + 值 / 一组子字段）、user（选账号；grant:'chat' = 授权插件以它跑 Claude）
  // 授权了服务器主机 / Pro 档账号时服务端回 409 needConfirm，这里弹确认后带 confirmGrant 重发。
  import { untrack } from 'svelte';
  import { api } from '../../lib/api.js';
  import { t, tr } from '../../lib/i18n.js';
  import { ic } from './icons.js';

  let { plugin, onSaved = () => {}, toast = () => {}, confirm = async () => true } = $props();

  const MASK = '••••••••';
  const errMsg = (e) => tr((e?.body && typeof e.body === 'object' ? e.body.error : typeof e?.body === 'string' ? e.body : '') || e?.message || String(e));
  const clone = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);

  let draft = $state({});
  let dirty = $state(false);
  let saving = $state(false);
  let formErr = $state('');
  let newKey = $state({});        // map 字段「添加一行」输入框里的键
  let opts = $state({});          // 字段路径 → 选项列表（动态选项缓存）

  // 草稿：结构化值原样（列表 / 表 / 子对象），无结构的 array / object 仍用文本框（老写法）
  function initDraft(p) {
    const d = {};
    for (const [k, s] of Object.entries(p.schema || {})) {
      const v = clone(p.config?.[k]);
      if (s.type === 'array' && !s.items) d[k] = Array.isArray(v) ? v.join('\n') : '';
      else if (s.type === 'object' && !s.fields) d[k] = v ? JSON.stringify(v, null, 2) : '';
      else if (s.type === 'array') d[k] = Array.isArray(v) ? v : [];
      else if (s.type === 'map') d[k] = v && typeof v === 'object' ? v : {};
      else if (s.type === 'object') d[k] = v && typeof v === 'object' ? v : {};
      else d[k] = v ?? (s.type === 'boolean' ? false : '');
    }
    draft = d; dirty = false; formErr = ''; newKey = {};
  }
  let seenId = '';
  let seenCfg = '';
  $effect(() => {
    const sig = JSON.stringify(plugin?.config || {});
    if (plugin && (plugin.id !== seenId || (!dirty && sig !== seenCfg))) { seenId = plugin.id; seenCfg = sig; initDraft(plugin); }
  });

  const fields = $derived(plugin ? Object.entries(plugin.schema || {}) : []);
  // 分组：按 section 第一次出现的顺序；没写 section 的归到最前面的无标题组
  const groups = $derived.by(() => {
    const out = [];
    const at = new Map();
    for (const [k, s] of fields) {
      const sec = s.section ? String(s.section) : '';
      if (!at.has(sec)) { at.set(sec, out.length); out.push({ sec, items: [] }); }
      out[at.get(sec)].items.push([k, s]);
    }
    return out;
  });
  function visible(s) {
    if (!s.when || typeof s.when !== 'object') return true;
    return Object.entries(s.when).every(([f, want]) => (Array.isArray(want) ? want.includes(draft[f]) : draft[f] === want));
  }

  // ── 选项 ──
  const enumOpts = (s) => (s.enum || []).map((e) => (e && typeof e === 'object' ? { value: e.value, label: e.label ?? String(e.value) } : { value: e, label: String(e) }));
  const needsRemote = (s) => !s.enum && (typeof s.options === 'string' || s.type === 'user');
  function loadOpts(path, s) {
    if (opts[path] !== undefined) return;
    opts[path] = null;
    if (s.options === 'plugin' && !plugin.active) { opts[path] = []; return; }
    api.get('/api/plugins/options?id=' + encodeURIComponent(plugin.id) + '&field=' + encodeURIComponent(path))
      .then((r) => { opts[path] = Array.isArray(r?.options) ? r.options : []; })
      .catch(() => { opts[path] = []; });
  }
  // 渲染时只读缓存；要哪些动态选项由下面的 $effect 按 schema 统一预取（渲染中改 $state 会报 state_unsafe_mutation）
  function optionsOf(path, s) {
    if (s.enum) return enumOpts(s);
    if (needsRemote(s)) return opts[path] || [];
    return null;
  }
  function remotePaths(schema) {
    const out = [];
    const leafs = (fields, prefix) => { for (const [fk, fs] of Object.entries(fields || {})) if (needsRemote(fs)) out.push([prefix + '.' + fk, fs]); };
    for (const [k, s] of Object.entries(schema || {})) {
      if (needsRemote(s) && s.type !== 'map' && s.type !== 'array' && s.type !== 'object') out.push([k, s]);
      if (s.type === 'array' && s.items) {
        if (s.items.type === 'object' && s.items.fields) leafs(s.items.fields, k + '[]');
        else if (needsRemote(s.items)) out.push([k + '[]', s.items]);
      }
      if (s.type === 'map') {
        if (s.key && s.key.options) out.push([k + '.$key', s.key]);
        if (s.value?.type === 'object' && s.value.fields) leafs(s.value.fields, k);
        else if (s.value && needsRemote(s.value)) out.push([k + '.$value', s.value]);
      }
      if (s.type === 'object' && s.fields) leafs(s.fields, k);
    }
    return out;
  }
  $effect(() => {
    if (!plugin) return;
    const want = remotePaths(plugin.schema);
    untrack(() => { for (const [p, s] of want) loadOpts(p, s); });
  });
  const labelOf = (list, v) => (list || []).find((o) => o.value === v)?.label;

  // ── 改值 ──
  function set(k, v) { draft[k] = v; dirty = true; formErr = ''; }
  const num = (s, raw) => (raw === '' ? '' : s.type === 'integer' ? Math.round(Number(raw)) : Number(raw));
  function blankOf(s) {
    if (s.default !== undefined) return clone(s.default);
    if (s.type === 'boolean') return false;
    if (s.type === 'object') { const o = {}; for (const [k, f] of Object.entries(s.fields || {})) o[k] = blankOf(f); return o; }
    return '';
  }

  async function save(confirmGrant = false) {
    if (!plugin || saving) return;
    const out = {};
    for (const [k, s] of fields) {
      let v = draft[k];
      if (s.type === 'array' && !s.items) v = String(v || '').split('\n').map((x) => x.trim()).filter(Boolean);
      else if (s.type === 'object' && !s.fields) {
        if (String(v || '').trim()) { try { v = JSON.parse(v); } catch { formErr = t('「{field}」不是合法的 JSON', { field: tr(s.label || k) }); return; } }
        else v = undefined;
      } else if ((s.type === 'integer' || s.type === 'number') && v === '') v = undefined;
      else if (s.type === 'user' && v === '') v = undefined;
      // 打码的密钥点进去又没填：沿用旧值（回传打码串 = 不改）
      if (s.secret && (v === '' || v === MASK) && plugin.config?.[k] === MASK) v = MASK;
      if (v !== undefined) out[k] = v;
    }
    saving = true;
    try {
      const r = await api.post('/api/plugins/config', { id: plugin.id, config: out, ...(confirmGrant ? { confirmGrant: true } : {}) });
      dirty = false;
      onSaved(r);
      toast(r.plugin?.pendingRestart ? t('已保存，重启 bridge 后生效') : r.plugin?.status === 'error' ? t('已保存，但启用失败：{reason}', { reason: tr(r.plugin.error || '') }) : t('已保存'), r.plugin?.status === 'error');
    } catch (e) {
      const need = e?.status === 409 && e.body && e.body.needConfirm;
      if (need) {
        saving = false;
        const names = need.accounts.map((a) => a.host ? t('服务器主机') : a.name).join('、');
        const ok = await confirm({
          title: t('授权「{name}」以「{who}」的身份跑 Claude？', { name: tr(plugin.name), who: names }),
          desc: t('这个账号有命令行、权限大：插件可以替它发起对话，Claude 会在它的工作区里读写文件、执行命令。只授权你信任的插件。'),
          yes: t('授权'), danger: true,
        });
        if (ok) return save(true);
        return;
      }
      formErr = errMsg(e);
    } finally { saving = false; }
  }
</script>

<!-- 叶子控件：string / number / boolean / user / 带选项的 -->
{#snippet leaf(s, v, onset, path)}
  {@const list = optionsOf(path, s)}
  {#if s.type === 'boolean'}
    <button class="cz-sw" class:on={!!v} role="switch" aria-checked={!!v} onclick={() => onset(!v)} aria-label={tr(s.label || path)}><span></span></button>
  {:else if list && (s.widget === 'chips' || s.widget === 'segmented')}
    <div class="pf-chips" class:seg={s.widget === 'segmented'} role="radiogroup">
      {#if !s.required && s.widget === 'chips'}<button class:on={v === '' || v == null} onclick={() => onset('')}>{t('默认')}</button>{/if}
      {#each list as o (o.value)}<button class:on={v === o.value} role="radio" aria-checked={v === o.value} onclick={() => onset(o.value)}>{tr(o.label)}</button>{/each}
    </div>
  {:else if list}
    <select class="cz-in" value={v ?? ''} onchange={(e) => { const x = e.currentTarget.value; onset(s.type === 'integer' || s.type === 'number' ? (x === '' ? '' : Number(x)) : x); }}>
      {#if !s.required || v === '' || v == null}<option value="">{s.type === 'user' ? t('未选') : t('默认')}</option>{/if}
      {#if v !== '' && v != null && !list.some((o) => o.value === v)}<option value={v}>{v}</option>{/if}
      {#each list as o (o.value)}<option value={o.value}>{tr(o.label)}{o.desc ? ' · ' + tr(o.desc) : ''}</option>{/each}
    </select>
  {:else if (s.type === 'integer' || s.type === 'number') && s.widget === 'slider' && s.min != null && s.max != null}
    <div class="pf-slider">
      <input type="range" min={s.min} max={s.max} step={s.step ?? (s.type === 'integer' ? 1 : 'any')} value={v === '' ? (s.default ?? s.min) : v} oninput={(e) => onset(num(s, e.currentTarget.value))} />
      <span>{v === '' ? (s.default ?? s.min) : v}</span>
    </div>
  {:else if s.type === 'integer' || s.type === 'number'}
    <input class="cz-in" type="number" value={v} min={s.min} max={s.max} step={s.type === 'integer' ? 1 : 'any'} oninput={(e) => onset(num(s, e.currentTarget.value))} />
  {:else if s.multiline || s.widget === 'textarea'}
    <textarea class="cz-in ta" rows="3" value={v} maxlength={s.max} oninput={(e) => onset(e.currentTarget.value)}></textarea>
  {:else}
    {@const secretSet = s.secret && v === MASK}
    <input class="cz-in" type={s.secret || s.widget === 'password' ? 'password' : 'text'} value={v} maxlength={s.max} autocomplete="off"
      onfocus={(e) => { if (secretSet) e.currentTarget.value = ''; }}
      oninput={(e) => onset(e.currentTarget.value)} placeholder={secretSet ? t('已设置（不改就留空）') : (s.placeholder ? tr(s.placeholder) : '')} />
  {/if}
{/snippet}

<!-- 一组子字段（object.fields / map 的值 / 列表项） -->
{#snippet sub(fieldsSpec, obj, onset, path)}
  <div class="pf-sub">
    {#each Object.entries(fieldsSpec) as [fk, fs] (fk)}
      <label class="pf-subrow" class:row={fs.type === 'boolean'}>
        <span class="pf-sublab">{tr(fs.label || fk)}</span>
        {@render leaf(fs, obj?.[fk] ?? (fs.type === 'boolean' ? false : ''), (x) => onset({ ...(obj || {}), [fk]: x }), path + '.' + fk)}
      </label>
    {/each}
  </div>
{/snippet}

{#snippet field(k, s)}
  <div class="pp-field" class:row={s.type === 'boolean'}>
    <div class="pp-lab">
      <span>{tr(s.label || k)}{#if s.required}<i class="pp-req">*</i>{/if}</span>
      {#if s.desc}<small>{tr(s.desc)}</small>{/if}
    </div>
    {#if s.type === 'array' && s.items}
      {@const items = Array.isArray(draft[k]) ? draft[k] : []}
      <div class="pf-list">
        {#each items as it, i (i)}
          <div class="pf-item">
            <div class="pf-item-body">
              {#if s.items.type === 'object' && s.items.fields}
                {@render sub(s.items.fields, it, (x) => set(k, items.map((y, j) => (j === i ? x : y))), k + '[]')}
              {:else}
                {@render leaf(s.items, it, (x) => set(k, items.map((y, j) => (j === i ? x : y))), k + '[]')}
              {/if}
            </div>
            <button class="pf-x" aria-label={t('删掉这一项')} onclick={() => set(k, items.filter((_, j) => j !== i))}>{@html ic('x')}</button>
          </div>
        {/each}
        {#if s.max == null || items.length < s.max}
          <button class="cz-btn sm pf-add" onclick={() => set(k, [...items, blankOf(s.items)])}>{@html ic('plus')}<span>{t('添加一项')}</span></button>
        {/if}
      </div>
    {:else if s.type === 'map'}
      {@const m = draft[k] && typeof draft[k] === 'object' ? draft[k] : {}}
      {@const keyOpts = s.key && s.key.options ? optionsOf(k + '.$key', s.key) : null}
      <div class="pf-list">
        {#each Object.keys(m) as key (key)}
          <div class="pf-item">
            <div class="pf-item-body">
              <div class="pf-key">{labelOf(keyOpts, key) ? tr(labelOf(keyOpts, key)) + ' · ' : ''}<b>{key}</b></div>
              {#if s.value.type === 'object' && s.value.fields}
                {@render sub(s.value.fields, m[key], (x) => set(k, { ...m, [key]: x }), k)}
              {:else}
                {@render leaf(s.value, m[key], (x) => set(k, { ...m, [key]: x }), k + '.$value')}
              {/if}
            </div>
            <button class="pf-x" aria-label={t('删掉这一行')} onclick={() => { const n = { ...m }; delete n[key]; set(k, n); }}>{@html ic('x')}</button>
          </div>
        {/each}
        {#if s.max == null || Object.keys(m).length < s.max}
          <div class="pf-newkey">
            {#if keyOpts && keyOpts.length}
              <select class="cz-in" value={newKey[k] || ''} onchange={(e) => (newKey[k] = e.currentTarget.value)}>
                <option value="">{tr(s.key?.label || t('选一个'))}</option>
                {#each keyOpts.filter((o) => !(String(o.value) in m)) as o (o.value)}<option value={o.value}>{tr(o.label)} · {o.value}</option>{/each}
              </select>
            {:else}
              <input class="cz-in" placeholder={tr(s.key?.label || t('键'))} value={newKey[k] || ''} oninput={(e) => (newKey[k] = e.currentTarget.value)} />
            {/if}
            <button class="cz-btn sm" disabled={!String(newKey[k] || '').trim() || String(newKey[k]).trim() in m}
              onclick={() => { const key = String(newKey[k]).trim(); set(k, { ...m, [key]: blankOf(s.value) }); newKey[k] = ''; }}>{@html ic('plus')}<span>{t('添加')}</span></button>
          </div>
        {/if}
      </div>
    {:else if s.type === 'object' && s.fields}
      {@render sub(s.fields, draft[k], (x) => set(k, x), k)}
    {:else if s.type === 'array' || s.type === 'object'}
      <textarea class="cz-in ta" rows={s.type === 'object' ? 5 : 3} value={draft[k]} oninput={(e) => set(k, e.currentTarget.value)}
        placeholder={s.type === 'array' ? t('每行一项') : 'JSON'}></textarea>
    {:else}
      {@render leaf(s, draft[k], (x) => set(k, x), k)}
    {/if}
    {#if s.type === 'user' && s.grant === 'chat' && draft[k]}
      <small class="pf-grant">{t('已授权：插件可以用这个账号的身份发起 Claude 对话（无人值守、在它自己的工作区里）。')}</small>
    {/if}
  </div>
{/snippet}

{#if fields.length}
  {#each groups as g (g.sec)}
    {@const shown = g.items.filter(([, s]) => visible(s))}
    {#if shown.length}
      <div class="cz-sec">{g.sec ? tr(g.sec) : t('设置')}</div>
      <div class="cz-list pp-form">
        {#each shown as [k, s] (k)}{@render field(k, s)}{/each}
      </div>
    {/if}
  {/each}
  {#if formErr}<div class="cz-err">{formErr}</div>{/if}
  <div class="pp-acts">
    {#if dirty}<button class="cz-btn" onclick={() => initDraft(plugin)}>{t('撤销修改')}</button>{/if}
    <button class="cz-btn pri" disabled={!dirty || saving} onclick={() => save()}>{saving ? t('保存中…') : t('保存')}</button>
  </div>
{/if}

<style>
  .pp-form { padding: 4px 0; }
  .pp-field { position: relative; display: flex; flex-direction: column; gap: 8px; padding: 12px 16px; }
  .pp-field + .pp-field::before { content: ''; position: absolute; top: 0; left: 16px; right: 16px; height: 1px; background: var(--cz-line); }
  .pp-field.row { flex-direction: row; align-items: center; gap: 16px; }
  .pp-lab { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; font-size: 15px; }
  .pp-lab small { font-size: 12.5px; line-height: 1.5; color: var(--cz-ink3); }
  .pp-req { margin-left: 3px; font-style: normal; color: var(--cz-crit); }
  .pp-acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  select.cz-in { appearance: auto; }

  .pf-chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .pf-chips button { appearance: none; border: 0; font: inherit; font-size: 13px; padding: 5px 12px; border-radius: 999px; cursor: pointer; white-space: nowrap;
    background: transparent; color: var(--cz-ink2); box-shadow: inset 0 0 0 1px var(--cz-line); }
  .pf-chips button.on { background: var(--cz-accent); color: var(--cz-on-accent); box-shadow: none; }
  .pf-chips.seg { display: inline-flex; gap: 2px; padding: 2px; border-radius: 9px; background: var(--cz-line); align-self: flex-start; }
  .pf-chips.seg button { border-radius: 7px; box-shadow: none; }
  .pf-chips.seg button.on { background: var(--cz-card); color: var(--cz-ink); box-shadow: 0 1px 2px rgba(0,0,0,.15); }
  .pf-slider { display: flex; align-items: center; gap: 12px; }
  .pf-slider input { flex: 1; }
  .pf-slider span { min-width: 3em; text-align: right; font-variant-numeric: tabular-nums; font-size: 13.5px; }

  .pf-list { display: flex; flex-direction: column; gap: 8px; }
  .pf-item { display: flex; align-items: flex-start; gap: 8px; padding: 10px 10px 10px 12px; border-radius: 10px; box-shadow: inset 0 0 0 1px var(--cz-line); }
  .pf-item-body { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 8px; }
  .pf-key { font-size: 13px; color: var(--cz-ink3); }
  .pf-key b { color: var(--cz-ink, inherit); font-weight: 600; }
  .pf-x { appearance: none; border: 0; background: transparent; color: var(--cz-ink3); cursor: pointer; padding: 4px; border-radius: 6px; line-height: 0; }
  .pf-x:hover { background: var(--cz-line); }
  .pf-x :global(svg) { width: 14px; height: 14px; }
  .pf-add, .pf-newkey .cz-btn { align-self: flex-start; }
  .pf-add :global(svg), .pf-newkey :global(svg) { width: 14px; height: 14px; margin-right: 4px; vertical-align: -2px; }
  .pf-newkey { display: flex; gap: 8px; align-items: center; }
  .pf-newkey .cz-in { flex: 1; }
  .pf-sub { display: flex; flex-direction: column; gap: 8px; }
  .pf-subrow { display: flex; flex-direction: column; gap: 4px; }
  .pf-subrow.row { flex-direction: row; align-items: center; justify-content: space-between; }
  .pf-sublab { font-size: 13px; color: var(--cz-ink3); }
  .pf-grant { font-size: 12.5px; color: var(--cz-warn); line-height: 1.5; }
</style>
