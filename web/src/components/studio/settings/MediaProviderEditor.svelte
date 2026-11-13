<script>
  // 单个媒体服务的编辑器（MediaProviderManager 里打开；蓝本是 claude/providers/ProviderEditor，那一份不动）。
  // 左侧分区导航（窄屏变顶部标签），底部常驻保存栏。四个分区：
  //   连接：名称 / 方言（决定用哪个适配器）/ 方言相关的连接字段——
  //         vertex：凭据二选一「沿用主机凭据」（google.credMode='adc'，就地嵌主机的 Google 云凭据卡；成员没有这一项）
  //                 或「服务账号 JSON」（上传 / 拖入 / 粘贴，带出项目），外加项目、区域；
  //         其余：接口地址、API Key（保留·更换·清除）、鉴权方式；都有请求头、超时、重试；管理员多一个「共享给成员」
  //   模型：顶部一组只有一个取模型的按钮——已保存、能自动发现的方言（sp.discoverable）是「上次检查 · 立即检查」
  //         （POST /api/studio/providers/sync，巡检把新模型直接收进来），其余（不能发现的方言、还没保存的草稿）是
  //         「模型列表 · 从服务拉取」（POST /api/studio/providers/models，拉回来勾选添加，拉不出种类的要自己挑）；能发现的另有「自动发现」开关（autoSync）。
  //         列表头写模型数 / 新发现数 / 备选数（备选 shelf 不逐个列）；「全部」里按种类分组（组头代替逐行的种类标签）；
  //         每行显示名做主行（自己起的名 > 目录里 Studio 的显示名 > id）、id 做次行，启用开关在行尾（小号）；
  //         7 天内新发现的名后一个墨色小字「新」（朱色只留给「正在发生」）、已下线的变淡标「已下线」；手动添加；展开改显示名 / 种类 / 默认参数（JSON）
  //   参数：服务级的额外请求体（JSON，合并进每次调用）
  //   测试：测试连接（只调列模型这类接口，不生成、不计费；没保存的草稿也能测）+ 最近 50 条调用日志
  import { untrack } from 'svelte';
  import SToggle from '../../settings/SToggle.svelte';
  import SSegmented from '../../settings/SSegmented.svelte';
  import VertexCredentials from '../../modelhub/VertexCredentials.svelte';
  import { sp, createProvider, updateProvider, deleteProvider, fetchModels, testProvider, providerLog, KINDS, kindName, kindSvg, loadProviders, logOk, logBad, logStatusText, trErr, canDiscover, syncProvider, isNewModel, modelTitle, cat, loadCatalog } from '../../../modules/studio/settings.svelte.js';
  import { t, tc, tr } from '../../../lib/i18n.js';
  import { relTime } from '../../../lib/format.js';

  let { source, onClose, onSaved, onDeleted, dirtyOut = $bindable(false) } = $props();

  // —— 方言：决定连接区长什么样、能出哪些种类 ——
  const DIALECTS = [
    { value: 'vertex', label: 'Vertex AI', kinds: ['image', 'video', 'speech', 'music'] },
    { value: 'gemini', label: 'Gemini API', kinds: ['image', 'video', 'speech', 'music'] },
    { value: 'openai', label: () => t('OpenAI 兼容'), kinds: ['image', 'video', 'speech'] },
    { value: 'openrouter', label: 'OpenRouter', kinds: ['image'] },
    { value: 'fal', label: 'fal', kinds: ['image', 'video', 'speech', 'music'] },
    { value: 'replicate', label: 'Replicate', kinds: ['image', 'video', 'speech', 'music'] },
    { value: 'elevenlabs', label: 'ElevenLabs', kinds: ['speech', 'music'] },
    { value: 'minimax', label: 'MiniMax', kinds: ['video', 'speech', 'music'] },
    { value: 'ark', label: () => t('火山方舟'), kinds: ['image', 'video'] },
    { value: 'local', label: () => t('本机图像模型'), kinds: ['image'] },
  ];
  const lbl = (o) => (typeof o.label === 'function' ? o.label() : o.label);
  // 能出的种类以服务端的方言表为准（GET /api/studio/providers 的 dialects），老服务端没下发就用上面这份
  const dialectOf = (d) => { const o = DIALECTS.find((x) => x.value === d) || DIALECTS[2]; return sp.dialects?.[o.value] ? { ...o, kinds: sp.dialects[o.value] } : o; };
  // 鉴权方式：请求里 Key 放哪（各家写法不同；预设已经替你选好）
  const AUTH_LABEL = { bearer: 'Authorization: Bearer', 'fal-key': 'Authorization: Key', 'x-api-key': 'x-api-key', 'xi-api-key': 'xi-api-key', 'x-goog-api-key': 'x-goog-api-key', none: () => t('不需要') };
  const AUTHS = $derived((sp.authStyles || ['bearer', 'x-goog-api-key', 'fal-key', 'xi-api-key', 'x-api-key', 'none']).map((v) => ({ value: v, label: AUTH_LABEL[v] || v })));

  const objText = (o) => (o && typeof o === 'object' && Object.keys(o).length ? JSON.stringify(o, null, 2) : '');
  const fullModel = (m) => ({
    id: m.id, label: m.label || m.id, kind: KINDS.includes(m.kind) ? m.kind : null, enabled: m.enabled !== false,
    source: m.source || 'manual', card: m.card || '', defaultsText: objText(m.defaults),
    // 自动识别的元数据（只读：保存时不回传，服务端按 id 从旧条目补回）
    discoveredAt: Number(m.discoveredAt) || 0, shelf: m.shelf === true, gone: m.gone === true,
  });
  const META = ['discoveredAt', 'shelf', 'gone'];
  const fromSource = (s) => {
    const p = JSON.parse(JSON.stringify(s || {}));
    const member = untrack(() => sp.member);
    return {
      id: p.id || '', name: p.name || '', preset: p.preset || 'custom', dialect: p.dialect || 'openai',
      enabled: p.enabled !== false, shared: p.shared === true, autoSync: p.autoSync !== false,
      baseUrl: p.baseUrl || '', authStyle: p.authStyle || 'bearer',
      headers: Object.entries(p.headers && typeof p.headers === 'object' && !Array.isArray(p.headers) ? p.headers : {}).map(([name, value]) => ({ name, value: String(value) })),
      timeoutSec: p.timeoutSec ?? 600, retries: p.retries ?? 2,
      google: { project: '', location: '', mediaLocation: '', credMode: member ? 'json' : 'adc', ...(p.google || {}) },
      models: (p.models || []).map(fullModel),
      paramsText: objText(p.params),
      hasKey: !!p.hasKey, keyTail: p.keyTail || '',
      hasServiceAccount: !!p.hasServiceAccount, saEmail: p.saEmail || '', saProject: p.saProject || '',
      importedFrom: p.importedFrom || '', importedAt: p.importedAt || 0,
    };
  };
  let draft = $state(fromSource(untrack(() => source)));
  let baseline = $state(JSON.stringify(untrack(() => draft)));
  let keyMode = $state('keep');      // keep | set | clear
  let keyInput = $state('');
  let showKey = $state(false);
  let saPending = $state(null);      // 待上传的服务账号 JSON { text, account, project, kind, name } | { clear:true }
  const isNew = $derived(!draft.id);
  const changed = $derived(JSON.stringify(draft) !== baseline || keyMode !== 'keep' || !!saPending);
  const dirty = $derived(changed || isNew);
  $effect(() => { dirtyOut = changed; });

  const isVertex = $derived(draft.dialect === 'vertex');
  const isLocal = $derived(draft.dialect === 'local');
  // 预设给的「去哪儿拿 Key」（服务端 presets[].keyUrl）
  const keyUrl = $derived(sp.presets.find((x) => x.id === draft.preset)?.keyUrl || '');
  const dialectKinds = $derived(dialectOf(draft.dialect).kinds);
  const dialectOpts = $derived(DIALECTS.filter((d) => !(sp.member && d.value === 'local')));

  // 分区名桌面侧栏与手机胶囊同一套（短名：手机一行放得下）；测试用中性的烧瓶，不用对勾（对勾像「已通过」）
  const SECTIONS = [
    { k: 'conn', label: () => tc('分区', '连接'), icon: '<path d="M7 10a3 3 0 0 0 4.2.3l2.5-2.5a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M11 8a3 3 0 0 0-4.2-.3L4.3 10.2a3 3 0 0 0 4.2 4.2l1-1"/>' },
    { k: 'models', label: () => tc('分区', '模型'), icon: '<rect x="3.5" y="3.5" width="5" height="5" rx="1.2"/><rect x="11.5" y="3.5" width="5" height="5" rx="1.2"/><rect x="3.5" y="11.5" width="5" height="5" rx="1.2"/><rect x="11.5" y="11.5" width="5" height="5" rx="1.2"/>' },
    { k: 'params', label: () => tc('分区', '参数'), icon: '<path d="M4 6h8M15 6h1M4 14h2M9 14h7"/><circle cx="13.5" cy="6" r="1.8"/><circle cx="7.5" cy="14" r="1.8"/>' },
    { k: 'test', label: () => tc('分区', '测试'), icon: '<path d="M8 3.5h4M8.7 3.5v4.6l-4.3 7a1.3 1.3 0 0 0 1.1 2h9a1.3 1.3 0 0 0 1.1-2l-4.3-7V3.5"/><path d="M6.2 13h7.6"/>' },
  ];
  let section = $state('conn');
  let scroller = $state();
  function go(k) { section = k; scroller?.scrollTo({ top: 0 }); }

  // —— 连接 ——
  function setDialect(v) {
    draft.dialect = v;
    const def = sp.dialectAuth?.[v] || (v === 'local' || v === 'vertex' ? 'none' : v === 'gemini' ? 'x-goog-api-key' : v === 'elevenlabs' ? 'xi-api-key' : v === 'fal' ? 'fal-key' : 'bearer');
    if (v === 'local' || v === 'vertex' || draft.authStyle === 'none' || !draft.id) draft.authStyle = def;
    if (v === 'vertex' && sp.member) draft.google.credMode = 'json';
  }
  const CRED_OPTS = $derived([
    ...(sp.member ? [] : [{ value: 'adc', label: t('沿用主机凭据') }]),
    { value: 'json', label: t('服务账号 JSON') },
  ]);
  // 服务账号 JSON：本地先看一眼结构（同主机凭据卡的规矩），真校验在服务端
  let saErr = $state('');
  let saPaste = $state(false);
  let saPasteText = $state('');
  let saDrag = $state(false);
  let saFile = $state(null);
  function saInspect(text, name = '') {
    saErr = '';
    let j;
    try { j = JSON.parse(String(text || '').replace(/^﻿/, '').trim()); } catch { saErr = t('不是有效的 JSON'); return; }
    if (j && (j.installed || j.web)) { saErr = t('这是 OAuth 客户端 ID 文件，不是凭据：请下载服务账号密钥，或上传 gcloud 生成的 application_default_credentials.json'); return; }
    if (!j || !j.type) { saErr = t('认不出的凭据类型'); return; }
    saPending = { text, name, kind: j.type, account: j.client_email || '', project: j.project_id || j.quota_project_id || '' };
    if (saPending.project && !draft.google.project.trim()) draft.google.project = saPending.project;
    saPaste = false; saPasteText = '';
  }
  async function saRead(f) {
    if (!f) return;
    if (f.size > 200_000) { saErr = t('文件太大，不像凭据 JSON'); return; }
    saInspect(await f.text(), f.name);
  }

  // —— 模型 ——
  let expanded = $state({});
  let kindFilter = $state('all');
  let addId = $state('');
  let addKind = $state('');
  let fetching = $state(false);
  let fetchErr = $state('');
  let candidates = $state(null);
  let picked = $state({});
  let candKind = $state({});         // 拉回来没认出种类的，自己挑
  let candQ = $state('');
  // 备选（聚合服务巡检建底收下的，可能上百个）不逐个列，列表头只写个数；计数也只算主列表
  const mainModels = $derived(draft.models.filter((m) => !m.shelf));
  const kindCount = (k) => mainModels.filter((m) => m.kind === k).length;
  const shownModels = $derived(draft.models.map((m, i) => ({ m, i })).filter(({ m }) => !m.shelf && (kindFilter === 'all' || m.kind === kindFilter)));
  const shelfN = $derived(draft.models.filter((m) => m.shelf).length);
  const newN = $derived(mainModels.filter((m) => isNewModel(m)).length);
  // 「全部」里按种类分组（组头代替逐行的种类标签；没选种类的排最后一组）；筛了种类就只有一组、不出组头
  const groups = $derived.by(() => {
    const by = new Map();
    for (const x of shownModels) { const k = KINDS.includes(x.m.kind) ? x.m.kind : ''; if (!by.has(k)) by.set(k, []); by.get(k).push(x); }
    return [...KINDS, ''].filter((k) => by.has(k)).map((k) => ({ k, rows: by.get(k) }));
  });
  const heads = $derived(kindFilter === 'all' && groups.length > 1);
  // 行的主名：显示名 > 目录（Studio）里的显示名 > id；目录没拉过就拉一次
  const titleOf = (m) => modelTitle(m, draft.id);
  $effect(() => { if (!untrack(() => cat.loaded)) untrack(() => loadCatalog()); });
  // 种类筛选条放不下时右缘（滚过后左缘）渐隐，别把最后一个胶囊切成半个字
  function hfade(node) {
    const upd = () => {
      node.classList.toggle('fade-r', node.scrollLeft + node.clientWidth < node.scrollWidth - 2);
      node.classList.toggle('fade-l', node.scrollLeft > 2);
    };
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(upd) : null;
    ro?.observe(node);
    const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(upd) : null;   // 种类胶囊增减
    mo?.observe(node, { childList: true, subtree: true, characterData: true });
    node.addEventListener('scroll', upd, { passive: true });
    upd();
    return { destroy() { ro?.disconnect(); mo?.disconnect(); node.removeEventListener('scroll', upd); } };
  }
  const connDraft = () => ({
    dialect: draft.dialect, baseUrl: draft.baseUrl, authStyle: draft.authStyle, headers: headersObj(), name: draft.name,
    google: $state.snapshot(draft.google),
    ...(keyMode === 'set' ? { apiKey: keyInput.trim() } : {}),
    ...(saPending && !saPending.clear ? { serviceAccount: saPending.text } : {}),
  });
  async function pull() {
    fetching = true; fetchErr = '';
    try {
      const list = await fetchModels({ id: draft.id || undefined, draft: connDraft() });
      const have = new Set(draft.models.map((m) => m.id));
      candidates = list.filter((m) => !have.has(m.id));
      // 认出种类、且这个方言能出这种的默认勾上；认不出的不勾，等你挑了种类再勾
      picked = Object.fromEntries(candidates.filter((m) => m.kind && dialectKinds.includes(m.kind)).map((m) => [m.id, true]));
      candKind = Object.fromEntries(candidates.map((m) => [m.id, KINDS.includes(m.kind) ? m.kind : '']));
      candQ = '';
      if (!list.length) fetchErr = t('这个服务没有返回任何模型，手动添加吧');
      else if (!candidates.length) { fetchErr = t('服务上的模型都已经添加过了'); candidates = null; }
    } catch (e) { fetchErr = e.message || String(e); }
    fetching = false;
  }
  const candShown = $derived((candidates || []).filter((m) => !candQ || (m.id + ' ' + (m.label || '')).toLowerCase().includes(candQ.toLowerCase())));
  const pickedN = $derived(Object.entries(picked).filter(([id, v]) => v && candKind[id]).length);
  function toggleAll() {
    const ok = candShown.filter((m) => candKind[m.id]);
    const all = ok.every((m) => picked[m.id]);
    for (const m of ok) picked[m.id] = !all;
  }
  function addPicked() {
    const add = (candidates || []).filter((m) => picked[m.id] && candKind[m.id]).map((m) => fullModel({ id: m.id, label: m.label || m.id, kind: candKind[m.id], source: 'remote', card: m.card || '' }));
    draft.models = [...draft.models, ...add];
    candidates = null;
  }
  function addManual() {
    const id = addId.trim();
    if (!id || !addKind || draft.models.some((m) => m.id === id)) return;
    draft.models = [...draft.models, fullModel({ id, label: id, kind: addKind, source: 'manual' })];
    expanded = { ...expanded, [id]: true };
    addId = '';
  }
  function removeModel(id) { draft.models = draft.models.filter((m) => m.id !== id); }

  // —— 自动发现（方案 §9.3）：开关写 autoSync；状态与「立即检查」看已保存的那份（sp.providers 里的同 id 服务）——
  const live = $derived(draft.id ? sp.providers.find((p) => p.id === draft.id) || null : null);
  const syncable = $derived(!!live && canDiscover(live.dialect));
  const sync = $derived(live?.sync || null);
  const syncing = $derived(!!(draft.id && sp.syncing[draft.id]));
  let syncErr = $state('');
  async function checkNow() {
    syncErr = '';
    try { await syncProvider(draft.id); } catch (e) { syncErr = e.message || String(e); }
  }
  const syncBad = $derived(!!syncErr || (!!sync && !sync.ok));
  const syncText = $derived(syncErr ? syncErr
    : !sync ? t('从未检查')
      : !sync.ok ? (trErr(sync.error) || tc('巡检', '检查失败'))
        : [relTime(sync.at), sync.added?.length ? t('新增 {n}', { n: sync.added.length }) : '', sync.gone?.length ? t('下线 {n}', { n: sync.gone.length }) : ''].filter(Boolean).join(' · '));
  // 巡检（立即检查 / 后台）给这个服务加了模型、改了发现元数据：并进草稿与基线（不算你的改动，保存时也不会把新模型当成删掉）；
  // 你在草稿里删掉、还没保存的不加回
  $effect(() => {
    const models = live?.models;
    if (models) untrack(() => adoptDiscovered(models));
  });
  function adoptDiscovered(models) {
    const base = JSON.parse(baseline);
    const inBase = new Map(base.models.map((m) => [m.id, m]));
    const inDraft = new Map(draft.models.map((m) => [m.id, m]));
    const add = [];
    let touched = false;
    for (const src of models) {
      const fm = fullModel(src);
      const b = inBase.get(fm.id);
      if (!b) { base.models.push(fm); touched = true; if (!inDraft.has(fm.id)) add.push(fullModel(src)); continue; }
      const d = inDraft.get(fm.id);
      for (const k of META) {
        if (b[k] !== fm[k]) { b[k] = fm[k]; touched = true; }
        if (d && d[k] !== fm[k]) d[k] = fm[k];
      }
    }
    if (add.length) draft.models = [...draft.models, ...add];
    if (touched) baseline = JSON.stringify(base);
  }

  // —— 保存 / 删除 ——
  let saving = $state(false);
  let err = $state('');
  let savedFlash = $state(false);
  let confirmDel = $state(false);
  const jsonErr = (s) => { const x = String(s || '').trim(); if (!x) return ''; try { const o = JSON.parse(x); return o && typeof o === 'object' && !Array.isArray(o) ? '' : t('要是 JSON 对象（{…}）'); } catch { return t('不是合法 JSON'); } };
  const paramsErr = $derived(jsonErr(draft.paramsText));
  const invalid = $derived(!draft.name.trim() ? t('先填名称')
    : !isVertex && !isLocal && !draft.baseUrl.trim() ? t('先填接口地址')
      : paramsErr ? t('额外请求体不是合法 JSON 对象')
        : draft.models.some((m) => jsonErr(m.defaultsText)) ? t('有模型的默认参数不是合法 JSON 对象')
          : draft.models.some((m) => !m.kind) ? t('有模型没选种类')
            : '');
  function headersObj() {
    const o = {};
    for (const h of draft.headers) if (h.name.trim()) o[h.name.trim()] = h.value;
    return o;
  }
  const parseObj = (s) => { const x = String(s || '').trim(); return x ? JSON.parse(x) : {}; };
  function payload() {
    const d = $state.snapshot(draft);
    const out = {
      name: d.name.trim(), preset: d.preset, dialect: d.dialect, enabled: d.enabled, autoSync: d.autoSync,
      baseUrl: d.baseUrl.trim(), authStyle: d.authStyle, headers: headersObj(), timeoutSec: Number(d.timeoutSec) || 600, retries: Number(d.retries) || 0,
      params: parseObj(d.paramsText),
      models: d.models.map((m) => ({ id: m.id, label: m.label || m.id, kind: m.kind, enabled: m.enabled, source: m.source, ...(m.card ? { card: m.card } : {}), defaults: parseObj(m.defaultsText) })),
    };
    if (sp.canShare) out.shared = d.shared;
    if (d.dialect === 'vertex') out.google = { project: d.google.project.trim(), location: d.google.location.trim(), mediaLocation: d.google.mediaLocation.trim(), credMode: d.google.credMode };
    if (keyMode === 'set') out.apiKey = keyInput.trim();
    else if (keyMode === 'clear') out.apiKey = '';
    if (saPending) out.serviceAccount = saPending.clear ? '' : saPending.text;
    return out;
  }
  let autoTest = $state(null);   // 保存后自动测一次的结果（失败在页脚标红）
  async function save() {
    if (saving || invalid) return;
    saving = true; err = ''; autoTest = null;
    try {
      const body = payload();
      const p = isNew ? await createProvider(body) : await updateProvider(draft.id, body);
      draft = fromSource(p);
      baseline = JSON.stringify(draft);
      keyMode = 'keep'; keyInput = ''; showKey = false; saPending = null;
      savedFlash = true; setTimeout(() => (savedFlash = false), 1600);
      onSaved?.(p);
      if (p.enabled !== false) testProvider({ id: p.id }).then((r) => { autoTest = r; result = r; loadLog(); }).catch(() => {});
    } catch (e) { err = e.message || String(e); }
    saving = false;
  }
  async function remove() {
    if (!confirmDel) { confirmDel = true; return; }
    try { await deleteProvider(draft.id); onDeleted?.(); }
    catch (e) { err = e.message || String(e); confirmDel = false; }
  }

  // —— 测试与日志 ——
  let testModel = $state('');
  const testable = $derived(draft.models.filter((m) => m.enabled && m.kind && !m.shelf));
  let testing = $state(false);
  let result = $state(null);
  let log = $state([]);
  async function loadLog() { if (draft.id) { try { log = await providerLog(draft.id); } catch {} } }
  $effect(() => { if (section === 'test') untrack(loadLog); });
  async function runTest() {
    if (testing || invalid) return;
    testing = true; result = null;
    try {
      result = changed || isNew
        ? await testProvider({ id: draft.id || undefined, draft: payload(), model: testModel || undefined })
        : await testProvider({ id: draft.id, model: testModel || undefined });
    } catch (e) { result = { ok: false, error: e.message || String(e) }; }
    testing = false;
    loadLog();
  }
  const hhmmss = (ms) => { const d = new Date(ms); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':'); };
  const secs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');
  const footMsg = $derived(trErr(err) || invalid || (savedFlash ? t('已保存') : autoTest && !autoTest.ok ? t('已保存，但测试连接失败：{e}', { e: trErr(autoTest.error).slice(0, 120) }) : dirty && !isNew ? t('有改动没保存') : ''));
  const footErr = $derived(!!(err || invalid) || !!(autoTest && !autoTest.ok && !savedFlash));
</script>

{#snippet kindDot(k)}<span class="kd" data-k={k}>{@html kindSvg(k)}{kindName(k)}</span>{/snippet}

<div class="ed">
  <nav class="side" aria-label={t('分区')}>
    {#each SECTIONS as s (s.k)}
      <button type="button" class="nav" class:on={section === s.k} onclick={() => go(s.k)}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">{@html s.icon}</svg>
        <span class="lb">{s.label()}</span>
        {#if s.k === 'models' && mainModels.length}<span class="cnt">{mainModels.length}</span>{/if}
      </button>
    {/each}
  </nav>

  <div class="body" bind:this={scroller}>
    {#if section === 'conn'}
      <section>
        <h3>{tc('分区', '连接')}</h3>
        <label class="fld"><span class="fl">{t('名称')}</span><input class="in" maxlength="40" placeholder={t('比如 fal')} bind:value={draft.name} /></label>
        <div class="fld"><span class="fl">{t('接口类型')}</span>
          <select class="in sel" value={draft.dialect} onchange={(e) => setDialect(e.currentTarget.value)}>
            {#each dialectOpts as d (d.value)}<option value={d.value}>{lbl(d)}</option>{/each}
          </select>
        </div>

        {#if isVertex}
          <div class="fld"><span class="fl">{t('Google 凭据')}</span>
            {#if CRED_OPTS.length > 1}<SSegmented options={CRED_OPTS} value={draft.google.credMode} onchange={(v) => (draft.google.credMode = v)} label={t('Google 凭据')} />{/if}
          </div>
          {#if draft.google.credMode === 'adc' && !sp.member}
            <div class="vxwrap"><VertexCredentials onchange={() => loadProviders(true)} /></div>
          {:else}
            <div class="fld"><span class="fl">{t('服务账号 JSON')}</span>
              <div class="drop" class:drag={saDrag} role="region" aria-label={t('服务账号 JSON')}
                ondragover={(e) => { e.preventDefault(); saDrag = true; }} ondragleave={() => (saDrag = false)} ondrop={(e) => { e.preventDefault(); saDrag = false; saRead(e.dataTransfer?.files?.[0]); }}>
                {#if saPending && !saPending.clear}
                  <div class="pend"><span class="pk">{saPending.kind === 'service_account' ? t('服务账号') : saPending.kind}</span><span class="pa">{saPending.account || saPending.name || t('粘贴的凭据')}</span>
                    <button type="button" class="iconbtn" aria-label={t('取消')} onclick={() => (saPending = null)}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>
                {:else if saPending?.clear}
                  <div class="pend"><span class="pa muted">{t('保存后清除这个服务的服务账号')}</span><button type="button" class="btn sm ghost" onclick={() => (saPending = null)}>{t('撤销')}</button></div>
                {:else if saPaste}
                  <textarea class="json" rows="5" spellcheck="false" bind:value={saPasteText} placeholder={t('把凭据 JSON 的全部内容粘贴到这里')}></textarea>
                  <div class="brow"><button type="button" class="btn sm" disabled={!saPasteText.trim()} onclick={() => saInspect(saPasteText)}>{t('使用')}</button><button type="button" class="btn sm ghost" onclick={() => { saPaste = false; saPasteText = ''; saErr = ''; }}>{t('取消')}</button></div>
                {:else}
                  {#if draft.hasServiceAccount}<div class="cur"><span class="pk">{t('服务账号')}</span><span class="pa mono">{draft.saEmail || '—'}</span></div>{/if}
                  <div class="brow">
                    <button type="button" class="btn sm" onclick={() => saFile?.click()}>{t('选择文件')}</button>
                    <button type="button" class="btn sm ghost" onclick={() => { saPaste = true; saErr = ''; }}>{t('粘贴内容')}</button>
                    {#if draft.hasServiceAccount}<button type="button" class="btn sm ghost danger" onclick={() => (saPending = { clear: true })}>{t('清除')}</button>{/if}
                  </div>
                {/if}
                <input bind:this={saFile} type="file" accept=".json,application/json" hidden onchange={(e) => { saRead(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />
              </div>
              {#if saErr}<span class="fh err">{saErr}</span>{/if}
            </div>
            <label class="fld"><span class="fl">{t('项目 ID')}</span><input class="in mono" spellcheck="false" placeholder={draft.saProject || 'my-project-123'} bind:value={draft.google.project} /></label>
            <div class="f2">
              <label class="fld"><span class="fl">{t('图像区域')}</span><input class="in mono" spellcheck="false" placeholder="global" bind:value={draft.google.location} /></label>
              <label class="fld"><span class="fl">{t('视频 / 配音 / 音乐区域')}</span><input class="in mono" spellcheck="false" placeholder="us-central1" bind:value={draft.google.mediaLocation} /></label>
            </div>
          {/if}
        {:else}
          {#if !isLocal}
            <label class="fld"><span class="fl">{t('接口地址')}</span>
              <input class="in mono" spellcheck="false" placeholder="https://api.example.com/v1" bind:value={draft.baseUrl} />
            </label>
          {/if}
          {#if draft.authStyle !== 'none' && !isLocal}
            <div class="fld"><span class="fl">API Key{#if keyUrl}<a class="klink" href={keyUrl} target="_blank" rel="noopener">{t('去拿 Key')} ↗</a>{/if}</span>
              {#if keyMode !== 'set' && draft.hasKey && keyMode !== 'clear'}
                <div class="keyrow"><span class="keybox mono">••••••••{draft.keyTail}</span>
                  <button type="button" class="btn sm" onclick={() => { keyMode = 'set'; keyInput = ''; }}>{t('更换')}</button>
                  <button type="button" class="btn sm ghost" onclick={() => (keyMode = 'clear')}>{t('清除')}</button></div>
              {:else if keyMode === 'clear'}
                <div class="keyrow"><span class="keybox muted">{t('保存后清除 Key')}</span><button type="button" class="btn sm ghost" onclick={() => (keyMode = 'keep')}>{t('撤销')}</button></div>
              {:else}
                <div class="keyrow"><div class="in pw"><input class="mono" type={showKey ? 'text' : 'password'} autocomplete="off" spellcheck="false" placeholder="sk-…"
                  value={keyInput} oninput={(e) => { keyInput = e.currentTarget.value; keyMode = 'set'; }} />
                  <button type="button" class="eye" aria-label={showKey ? t('隐藏') : t('显示')} onclick={() => (showKey = !showKey)}>
                    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">{#if showKey}<path d="M3 3l14 14M8.5 8.6a2 2 0 0 0 2.9 2.8M6.2 6.3C4.6 7.3 3.4 8.6 2.8 10c1.3 3 4 5 7.2 5 1.4 0 2.7-.4 3.8-1.1M9 5.1c.3 0 .7-.1 1-.1 3.2 0 5.9 2 7.2 5-.4.9-.9 1.7-1.6 2.4"/>{:else}<path d="M2.8 10C4.1 7 6.8 5 10 5s5.9 2 7.2 5c-1.3 3-4 5-7.2 5s-5.9-2-7.2-5z"/><circle cx="10" cy="10" r="2.2"/>{/if}</svg>
                  </button></div>
                  {#if draft.hasKey}<button type="button" class="btn sm ghost" onclick={() => { keyMode = 'keep'; keyInput = ''; }}>{t('撤销')}</button>{/if}
                </div>
              {/if}
            </div>
          {/if}
          {#if !isLocal}<div class="fld"><span class="fl">{t('鉴权方式')}</span>
            <select class="in sel" bind:value={draft.authStyle}>
              {#each AUTHS as a (a.value)}<option value={a.value}>{lbl(a)}</option>{/each}
            </select>
          </div>{/if}
        {/if}

        {#if sp.canShare}
          <div class="list">
            <div class="li"><div><div class="lt">{t('共享给成员')}</div></div>
              <SToggle checked={draft.shared} onchange={(v) => (draft.shared = v)} label={t('共享给成员')} /></div>
          </div>
        {/if}

        {#if !isVertex}
          <h4>{t('请求头')}</h4>
          <div class="hdrs">
            {#each draft.headers as h, i (i)}
              <div class="hdr"><input class="in mono" placeholder="X-Custom-Header" bind:value={h.name} /><input class="in mono" placeholder={t('值')} bind:value={h.value} />
                <button type="button" class="iconbtn" aria-label={t('删除')} onclick={() => (draft.headers = draft.headers.filter((_, j) => j !== i))}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>
            {/each}
            {#if draft.headers.length < 16}<button type="button" class="btn sm ghost add" onclick={() => (draft.headers = [...draft.headers, { name: '', value: '' }])}>＋ {t('添加请求头')}</button>{/if}
          </div>
        {/if}

        <h4>{t('网络')}</h4>
        <div class="list">
          <div class="li"><div><div class="lt">{t('超时')}</div></div>
            <div class="numf"><input type="number" min="10" max="1800" bind:value={draft.timeoutSec} /><span class="unit">{t('秒')}</span></div></div>
          <div class="li"><div><div class="lt">{t('失败重试')}</div></div>
            <div class="stepper"><button type="button" disabled={draft.retries <= 0} onclick={() => (draft.retries = Math.max(0, draft.retries - 1))}>−</button><span>{draft.retries}</span><button type="button" disabled={draft.retries >= 5} onclick={() => (draft.retries = Math.min(5, draft.retries + 1))}>＋</button></div></div>
        </div>
      </section>

    {:else if section === 'models'}
      <section>
        <h3>{tc('分区', '模型')}</h3>

        <!-- 取模型只有一个按钮，在这一行：已保存、能自动发现的 = 立即检查（巡检）；其余 = 从服务拉取（拉回来勾选） -->
        <div class="list sync">
          {#if canDiscover(draft.dialect)}
            <div class="li"><div><div class="lt">{t('自动发现')}</div></div>
              <SToggle checked={draft.autoSync} onchange={(v) => (draft.autoSync = v)} label={t('自动发现')} /></div>
          {/if}
          <div class="li sy">
            {#if syncable}
              <div class="lt">{t('上次检查')}</div>
              <span class="sv" class:bad={syncBad} title={syncText}>{syncText}</span>
              <button type="button" class="btn sm" disabled={syncing} onclick={checkNow}>{#if syncing}<span class="spin"></span>{t('检查中…')}{:else}{t('立即检查')}{/if}</button>
            {:else}
              <div class="lt">{t('模型列表')}</div>
              <span class="sv"></span>
              <button type="button" class="btn sm" disabled={fetching || (!isVertex && !isLocal && !draft.baseUrl.trim())} onclick={pull}>{#if fetching}<span class="spin"></span>{/if}{t('从服务拉取')}</button>
            {/if}
          </div>
        </div>

        {#if fetchErr}<div class="note warn">{trErr(fetchErr)}</div>{/if}

        {#if candidates}
          <div class="cands">
            <div class="cands-top"><input class="in" placeholder={t('搜索模型')} bind:value={candQ} /><button type="button" class="btn sm ghost" onclick={toggleAll}>{t('全选')}</button></div>
            <div class="cands-list">
              {#each candShown as m (m.id)}
                <div class="cand" class:nokind={!candKind[m.id]}>
                  <input type="checkbox" bind:checked={picked[m.id]} disabled={!candKind[m.id]} aria-label={m.id} />
                  <span class="cid"><span class="mono">{m.id}</span>{#if m.label && m.label !== m.id}<span class="muted">{m.label}</span>{/if}{#if m.card}<span class="badge acc" title={t('有现成的模型卡：参数表齐全')}>{t('有模型卡')}</span>{/if}</span>
                  <select class="ksel" class:need={!candKind[m.id]} value={candKind[m.id]} onchange={(e) => { candKind[m.id] = e.currentTarget.value; if (e.currentTarget.value) picked[m.id] = true; }} aria-label={t('种类')}>
                    <option value="">{t('选种类…')}</option>
                    {#each KINDS as k (k)}<option value={k}>{kindName(k)}</option>{/each}
                  </select>
                </div>
              {/each}
            </div>
            <div class="cands-foot">
              <button type="button" class="btn sm ghost" onclick={() => (candidates = null)}>{t('取消')}</button>
              <button type="button" class="btn sm primary" disabled={!pickedN} onclick={addPicked}>{t('添加 {n} 个', { n: pickedN })}</button></div>
          </div>
        {/if}

        {#if mainModels.length || shelfN}
          <!-- 列表头：只写数 -->
          <div class="mhd">
            <span>{t('{n} 个模型', { n: mainModels.length })}</span>
            {#if newN}<span>{t('新 {n}', { n: newN })}</span>{/if}
            {#if shelfN}<span>{t('备选 {n} 个', { n: shelfN })}</span>{/if}
          </div>
        {/if}
        {#if mainModels.length}
          <div class="kfilter" role="tablist" data-hscroll use:hfade>
            <button type="button" role="tab" class="kf" class:on={kindFilter === 'all'} aria-selected={kindFilter === 'all'} onclick={() => (kindFilter = 'all')}>{t('全部')}</button>
            {#each KINDS as k (k)}
              {#if kindCount(k)}<button type="button" role="tab" class="kf" class:on={kindFilter === k} aria-selected={kindFilter === k} onclick={() => (kindFilter = k)}>{@render kindDot(k)}<span class="kn">{kindCount(k)}</span></button>{/if}
            {/each}
          </div>
        {/if}
        <div class="models">
          {#each groups as g (g.k)}
            {#if heads}<div class="mgrp" class:warn={!g.k}>{#if g.k}{@render kindDot(g.k)}{:else}{t('没选种类')}{/if}</div>{/if}
            {#each g.rows as { m, i } (m.id)}
              {@const title = titleOf(m)}
              <div class="mrow" class:off={!m.enabled} class:open={expanded[m.id]} class:gone={m.gone}>
                <div class="mhead">
                  <button type="button" class="mname" aria-expanded={!!expanded[m.id]} onclick={() => (expanded = { ...expanded, [m.id]: !expanded[m.id] })}>
                    <span class="mlw"><span class="ml">{title}</span>{#if isNewModel(m)}<span class="nw">{t('新')}</span>{/if}</span>
                    {#if title !== m.id}<span class="mid mono">{m.id}</span>{/if}
                  </button>
                  <span class="badges">
                    <!-- 种类不逐行标（「全部」里有组头，筛了种类就不必重复）；来源（内置 / 拉取 / 手填）不标 -->
                    {#if !m.kind && !heads}<span class="badge warn">{t('没选种类')}</span>{/if}
                    {#if m.defaultsText.trim()}<span class="badge acc" title={m.defaultsText}>{t('有默认参数')}</span>{/if}
                    {#if m.gone}<span class="gn">{t('已下线')}</span>{/if}
                  </span>
                  <span class="msw"><SToggle compact checked={m.enabled} onchange={(v) => (draft.models[i].enabled = v)} label={t('启用 {name}', { name: title })} /></span>
                  <button type="button" class="chev" aria-label={t('展开')} onclick={() => (expanded = { ...expanded, [m.id]: !expanded[m.id] })}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m7 8 3 3 3-3"/></svg></button>
                </div>
                {#if expanded[m.id]}
                  <div class="mbody">
                    <label class="fld"><span class="fl">{t('显示名')}</span><input class="in" maxlength="80" placeholder={title} bind:value={draft.models[i].label} /></label>
                    <div class="fld"><span class="fl">{t('种类')}</span>
                      <SSegmented options={KINDS.map((k) => ({ value: k, label: kindName(k) }))} value={m.kind} onchange={(v) => (draft.models[i].kind = v)} label={t('种类')} />
                      {#if m.kind && !dialectKinds.includes(m.kind)}<span class="fh warn">{t('这个接口类型一般出不了{kind}', { kind: kindName(m.kind) })}</span>{/if}
                    </div>
                    <div class="fld"><span class="fl">{t('默认参数')}<code>JSON</code></span>
                      <textarea class="json" class:err={!!jsonErr(m.defaultsText)} rows="3" spellcheck="false" placeholder={m.kind === 'video' ? '{ "duration": 4, "resolution": "720p" }' : m.kind === 'speech' ? '{ "voice": "Kore" }' : '{ "size": "1024x1024" }'}
                        value={m.defaultsText} oninput={(e) => (draft.models[i].defaultsText = e.currentTarget.value)}></textarea>
                      {#if jsonErr(m.defaultsText)}<span class="fh err">{jsonErr(m.defaultsText)}</span>{/if}
                    </div>
                    {#if m.source !== 'builtin'}
                      <div class="mfoot"><button type="button" class="btn sm danger ghost" onclick={() => removeModel(m.id)}>{t('移除这个模型')}</button></div>
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          {:else}
            <div class="empty-m">{mainModels.length || shelfN ? t('没有模型') : t('还没有模型')}</div>
          {/each}
        </div>
        <div class="addrow">
          <input class="in mono" placeholder={t('模型 ID，比如 fal-ai/flux-pro')} bind:value={addId} onkeydown={(e) => e.key === 'Enter' && addManual()} />
          <select class="in sel ksel2" bind:value={addKind} aria-label={t('种类')}>
            <option value="">{t('种类…')}</option>
            {#each KINDS as k (k)}<option value={k}>{kindName(k)}</option>{/each}
          </select>
          <button type="button" class="btn sm" disabled={!addId.trim() || !addKind} onclick={addManual}>{t('手动添加')}</button>
        </div>
      </section>

    {:else if section === 'params'}
      <section>
        <h3>{tc('分区', '参数')}</h3>
        <div class="fld"><span class="fl">{t('额外请求体')}<code>JSON</code></span>
          <textarea class="json big" class:err={!!paramsErr} rows="8" spellcheck="false"
            placeholder={'{ }'}
            bind:value={draft.paramsText}></textarea>
          {#if paramsErr}<span class="fh err">{paramsErr}</span>{/if}
        </div>
      </section>

    {:else}
      <section>
        <h3>{tc('分区', '测试')}</h3>
        <div class="testbar">
          <select class="in sel" bind:value={testModel} aria-label={t('测试哪个模型')}>
            <option value="">{t('只测连接')}</option>
            {#each testable as m (m.id)}<option value={m.id}>{titleOf(m)} · {kindName(m.kind)}</option>{/each}
          </select>
          <button type="button" class="btn primary" disabled={testing || !!invalid} onclick={runTest}>{#if testing}<span class="spin light"></span>{/if}{t('测试连接')}</button>
        </div>
        {#if result}
          <div class="result" class:ok={result.ok} class:bad={!result.ok}>
            <div class="rhead"><span class="dot"></span><b>{result.ok ? t('连通') : t('失败')}</b>
              {#if result.ms}<span class="muted">{secs(result.ms)}</span>{/if}
              {#if result.status}<span class="badge">HTTP {result.status}</span>{/if}</div>
            {#if result.ok}{#if result.detail}<div class="reply">{tr(result.detail)}</div>{/if}{:else}<pre class="errbody">{trErr(result.error)}</pre>{/if}
          </div>
        {/if}
        {#if draft.id}
          <div class="h3row logh"><h4>{t('最近调用')}</h4><button type="button" class="btn sm ghost" onclick={loadLog}>{t('刷新')}</button></div>
          {#if log.length}
            <div class="log">
              {#each log as l, i (i)}
                <div class="lrow" title={l.error || ''}>
                  <span class="lt2 mono">{hhmmss(l.at)}</span>
                  <span class="st" class:ok={logOk(l)} class:bad={logBad(l)}>{logStatusText(l)}</span>
                  <span class="lm">{#if KINDS.includes(l.kind)}{@render kindDot(l.kind)}{/if}<span class="mono">{l.model || (l.test ? t('测试') : '')}</span>{#if l.test && l.model}<span class="muted"> · {t('测试')}</span>{/if}</span>
                  <span class="lnum">{l.ms ? secs(l.ms) : ''}</span>
                  {#if l.error}<span class="lerr">{trErr(l.error)}</span>{/if}
                </div>
              {/each}
            </div>
          {:else}<div class="fh">{t('还没有调用记录')}</div>{/if}
        {/if}
      </section>
    {/if}
  </div>

  <footer class="foot">
    {#if !isNew}
      <button type="button" class="btn danger ghost" onclick={remove} onblur={() => (confirmDel = false)}>{confirmDel ? t('再点一次删除') : t('删除服务')}</button>
    {/if}
    <span class="msg" class:err={footErr} title={footMsg}>{footMsg}</span>
    <button type="button" class="btn primary" disabled={!dirty || saving || !!invalid} onclick={save}>{#if saving}<span class="spin light"></span>{/if}{isNew ? t('添加') : t('保存')}</button>
  </footer>
</div>

<style>
  .ed { display: grid; grid-template-columns: 188px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; height: 100%; min-height: 0; }
  .side { grid-row: 1; padding: 14px 10px; border-right: 1px solid var(--st-hair); display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
  .nav { display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 10px; border: 0; border-radius: 10px; background: transparent; color: var(--st-text2); font: inherit; font-size: 13.5px; text-align: left; cursor: pointer; }
  .nav svg { width: 17px; height: 17px; flex: none; opacity: .85; }
  .nav:hover { background: var(--st-hover); color: var(--text); }
  .nav.on { background: var(--st-sel); color: var(--text); font-weight: 500; }
  .nav .cnt { margin-left: auto; font-size: 11.5px; color: var(--st-muted); font-variant-numeric: tabular-nums; }
  .body { grid-row: 1; overflow-y: auto; padding: 22px 28px 28px; min-width: 0; }
  section { max-width: 700px; }
  h3 { margin: 0 0 14px; font-family: var(--font-brand-serif), Georgia, serif; font-weight: 500; font-size: 21px; letter-spacing: -.01em; color: var(--text); }
  h4 { margin: 22px 0 8px; font-size: 12.5px; font-weight: 600; letter-spacing: .02em; color: var(--st-muted); }
  .h3row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .h3row.logh { margin-top: 18px; }
  .h3row.logh h4 { margin: 0; }
  .f2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .fld { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; min-width: 0; }
  .fl { font-size: 12.5px; font-weight: 500; color: var(--st-text2); display: flex; align-items: center; gap: 8px; }
  .klink { margin-left: auto; font-weight: 500; color: var(--st-text2); text-decoration: none; font-size: 12px; }
  .klink:hover { color: var(--text); text-decoration: underline; }
  .fl code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11px; color: var(--st-muted); background: var(--st-seg); padding: 1px 6px; border-radius: 5px; font-weight: 400; }
  .fld > :global(.seg) { align-self: flex-start; max-width: 100%; }
  .fh { font-size: 12px; line-height: 1.55; color: var(--st-muted); display: inline-flex; align-items: center; flex-wrap: wrap; gap: 0 6px; }
  .fh.err { color: #d9534f; }
  .fh.warn { color: var(--pm-warn); }
  .in { height: 36px; box-sizing: border-box; width: 100%; padding: 0 11px; border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-field); color: var(--text); font: inherit; font-size: 13.5px; outline: 0; transition: border-color .15s, box-shadow .15s; }
  .in:focus, .in:focus-within { border-color: color-mix(in srgb, var(--st-accent) 60%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--st-accent) 14%, transparent); }
  .in::placeholder, .in input::placeholder { color: var(--st-muted); }
  .sel { appearance: auto; cursor: pointer; }
  .sel option { background: var(--st-surface); color: var(--text); }
  .mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12.5px; }
  .muted { color: var(--st-muted); }
  .keyrow { display: flex; align-items: center; gap: 8px; }
  .keybox { flex: 1; height: 36px; display: flex; align-items: center; padding: 0 12px; border-radius: 10px; background: var(--st-seg); color: var(--st-text2); letter-spacing: .04em; }
  .pw { display: flex; align-items: center; padding: 0 0 0 11px; }
  .pw input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: var(--text); }
  .eye { width: 32px; height: 32px; display: grid; place-items: center; border: 0; background: transparent; color: var(--st-muted); cursor: pointer; }
  .eye svg { width: 17px; height: 17px; }
  .drop { padding: 12px; border-radius: 12px; border: 1.5px dashed var(--st-line); display: flex; flex-direction: column; gap: 8px; transition: border-color .15s, background-color .15s; }
  .drop.drag { border-color: var(--st-accent); background: var(--st-seg); }
  .pend, .cur { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .pk { flex: none; font-size: 11px; padding: 1px 7px; border-radius: 6px; background: var(--st-seg); color: var(--st-text2); }
  .pa { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .brow { display: flex; flex-wrap: wrap; gap: 8px; }
  /* 主机凭据卡读 --i-*：映射到面板的墨与象牙 */
  .vxwrap { --i-card: var(--st-seg); --i-label: var(--text); --i-label2: var(--st-muted); --i-label3: var(--st-muted);
    --i-sep: var(--st-line); --i-accent: var(--st-accent); --i-on-accent: var(--st-primary-ink); --i-fill3: var(--st-seg); --i-bg: var(--st-field);
    --i-ok: #3fa46a; --i-red: #d9534f; margin-bottom: 8px; }
  .hdrs { display: flex; flex-direction: column; gap: 8px; }
  .hdr { display: grid; grid-template-columns: 1fr 1.4fr 30px; gap: 8px; align-items: center; }
  .iconbtn { width: 30px; height: 30px; flex: none; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--st-muted); cursor: pointer; }
  .iconbtn:hover { background: var(--st-hover); color: var(--text); }
  .iconbtn svg { width: 13px; height: 13px; }
  .add { align-self: flex-start; }
  .list { border: 1px solid var(--st-line); border-radius: 14px; overflow: hidden; margin-top: 4px; }
  .li { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; border-top: 1px solid var(--st-hair); }
  .li:first-child { border-top: 0; }
  .li > div:first-child { flex: 1; min-width: 0; }
  .lt { font-size: 13.5px; color: var(--text); }
  .numf { display: flex; align-items: center; height: 34px; width: 150px; flex: none; border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-field); overflow: hidden; }
  .numf input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 13.5px; padding: 0 10px; font-variant-numeric: tabular-nums; }
  .unit { padding: 0 10px 0 4px; font-size: 12px; color: var(--st-muted); }
  .stepper { display: flex; align-items: center; height: 32px; border: 1px solid var(--st-line); border-radius: 999px; overflow: hidden; flex: none; }
  .stepper button { width: 32px; height: 100%; border: 0; background: transparent; color: var(--text); font-size: 15px; cursor: pointer; }
  .stepper button:hover:not(:disabled) { background: var(--st-hover); }
  .stepper button:disabled { color: var(--st-muted); cursor: default; }
  .stepper span { min-width: 26px; text-align: center; font-variant-numeric: tabular-nums; font-size: 13.5px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 34px; padding: 0 15px; border: 1px solid var(--st-line); border-radius: 999px; background: var(--st-surface); color: var(--text); font: inherit; font-size: 13.5px; cursor: pointer; white-space: nowrap; transition: background-color .12s, opacity .12s; }
  .btn:hover:not(:disabled) { background: var(--st-hover); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn.sm { height: 30px; padding: 0 12px; font-size: 13px; }
  .btn.ghost { border-color: transparent; background: transparent; }
  .btn.primary { background: var(--st-primary); color: var(--st-primary-ink); border-color: transparent; }
  .btn.primary:hover:not(:disabled) { background: var(--st-primary); opacity: .88; }
  .btn.danger { color: #d9534f; }
  .spin { width: 13px; height: 13px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .7s linear infinite; opacity: .7; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .note { padding: 10px 12px; border-radius: 10px; background: var(--st-seg); font-size: 13px; color: var(--st-text2); margin-bottom: 14px; line-height: 1.55; }
  .note.warn { background: color-mix(in srgb, var(--pm-warn) 16%, transparent); color: var(--text); }
  /* 种类字形：12px 线稿，颜色跟文字（方案 §5.2：种类不着色） */
  .kd { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--st-text2); white-space: nowrap; }
  .kd :global(svg) { width: 12px; height: 12px; flex: none; }
  .cands { border: 1px solid var(--st-line); border-radius: 14px; margin-bottom: 14px; overflow: hidden; background: var(--st-surface); box-shadow: var(--st-menu-shadow); }
  .cands-top { display: flex; gap: 8px; padding: 10px; border-bottom: 1px solid var(--st-hair); }
  .cands-list { max-height: 300px; overflow-y: auto; padding: 4px 0; }
  .cand { display: flex; align-items: center; gap: 10px; padding: 6px 14px; font-size: 13px; }
  .cand:hover { background: var(--st-hover); }
  .cand input { accent-color: var(--st-accent); flex: none; }
  .cid { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; overflow: hidden; }
  .cid .mono { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cid .muted { font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cid .badge { flex: none; height: 18px; font-size: 10.5px; }
  .cand.nokind .cid .mono { color: var(--st-muted); }
  .ksel { flex: none; height: 28px; padding: 0 6px; border: 1px solid var(--st-line); border-radius: 8px; background: var(--st-field); color: var(--text); font: inherit; font-size: 12.5px; cursor: pointer; }
  .ksel.need { border-color: color-mix(in srgb, var(--pm-warn) 60%, transparent); color: var(--pm-warn); }
  .ksel option { background: var(--st-surface); color: var(--text); }
  .cands-foot { display: flex; align-items: center; justify-content: flex-end; gap: 8px; padding: 10px; border-top: 1px solid var(--st-hair); }
  /* 列表头：模型数 · 新 · 备选（只写数） */
  .mhd { display: flex; flex-wrap: wrap; gap: 2px 14px; margin: 2px 2px 8px; font-size: 12.5px; color: var(--st-muted); font-variant-numeric: tabular-nums; }
  .kfilter { display: flex; gap: 6px; margin: 0 0 10px; overflow-x: auto; scrollbar-width: none; }   /* 一行横滑，别让「音乐 1」单独掉到第二行 */
  /* 放不下时右缘（滚过后左缘）渐隐：最后一个胶囊不再被硬切成半个字 */
  .kfilter:global(.fade-r) { -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 36px), transparent); mask-image: linear-gradient(90deg, #000 calc(100% - 36px), transparent); }
  .kfilter:global(.fade-l) { -webkit-mask-image: linear-gradient(90deg, transparent, #000 36px); mask-image: linear-gradient(90deg, transparent, #000 36px); }
  .kfilter:global(.fade-l.fade-r) { -webkit-mask-image: linear-gradient(90deg, transparent, #000 36px, #000 calc(100% - 36px), transparent); mask-image: linear-gradient(90deg, transparent, #000 36px, #000 calc(100% - 36px), transparent); }
  .kfilter::-webkit-scrollbar { display: none; }
  .kfilter > .kf { flex: none; }
  .kf { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border: 1px solid var(--st-line); border-radius: 999px; background: transparent; color: var(--st-text2); font: inherit; font-size: 12.5px; cursor: pointer; }
  .kf:hover { background: var(--st-hover); }
  .kf.on { background: var(--st-primary); color: var(--st-primary-ink); border-color: transparent; }
  .kf.on .kd { color: var(--st-primary-ink); }
  .kn { font-variant-numeric: tabular-nums; opacity: .7; font-size: 11.5px; }
  .models { display: flex; flex-direction: column; border: 1px solid var(--st-line); border-radius: 14px; overflow: hidden; }
  .mrow { border-top: 1px solid var(--st-hair); }
  .mrow:first-child { border-top: 0; }
  .mrow.open { background: color-mix(in srgb, var(--st-seg) 45%, transparent); }
  /* 种类组头（「全部」里代替逐行的种类标签） */
  .mgrp { padding: 9px 14px 7px; border-top: 1px solid var(--st-hair); background: color-mix(in srgb, var(--st-seg) 55%, transparent); }
  .mgrp:first-child { border-top: 0; }
  .mgrp .kd { color: var(--st-muted); font-size: 12px; font-weight: 500; }
  .mgrp.warn { font-size: 12px; font-weight: 500; color: var(--pm-warn); }
  .mgrp + .mrow { border-top: 0; }
  .mhead { display: flex; align-items: center; gap: 10px; padding: 8px 8px 8px 14px; min-height: 48px; }
  .mrow.off .mname, .mrow.off .badges { opacity: .45; }
  /* 主行显示名、次行 id */
  .mname { flex: 1; min-width: 0; display: flex; flex-direction: column; align-items: flex-start; gap: 1px; border: 0; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; padding: 0; }
  /* 启用开关在行尾、小号、墨色不压过名字（十几行连成一面黑墙的就是它） */
  .msw { flex: none; display: flex; }
  .models .mrow .mhead :global(.tg) { width: 28px; height: 16px; padding: 2px; }
  .models .mrow .mhead :global(.tg .knob) { width: 12px; height: 12px; }
  /* 开着就是墨色（半透明墨读起来像禁用 / 被锁，复核 11-06 第三轮）；颜色交给 ios27 开关自己，这里只改尺寸 */
  .models .mrow .mhead :global(.tg.on .knob) { transform: translateX(12px); }
  .ml { font-size: 13.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mid { color: var(--st-muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* 自动发现：新模型名后一个墨色小字「新」（朱色只留给「正在发生」）；已下线的名字变淡、行尾标一句；备选只在列表头写个数 */
  .mlw { display: inline-flex; align-items: baseline; gap: 6px; min-width: 0; max-width: 100%; }
  .nw { flex: none; display: inline-flex; align-items: center; height: 15px; padding: 0 4px; border-radius: 4px; font-size: 10.5px; font-weight: 500; line-height: 1; letter-spacing: .02em; color: var(--text); box-shadow: inset 0 0 0 1px var(--st-line); }   /* 新发现的模型：墨色细线框小标签（同 Studio 选择器） */
  .mrow.gone .ml { color: var(--st-muted); }
  .gn { font-size: 12px; color: var(--st-muted); white-space: nowrap; }
  .list.sync { margin: 0 0 14px; }
  .li.sy > .lt { flex: none; }
  .sv { flex: 1; min-width: 0; text-align: right; font-size: 13px; color: var(--st-text2); overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; }
  .sv.bad { color: #d9534f; }
  .badges { display: flex; align-items: center; gap: 8px; flex: none; }
  .badge { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px; background: var(--st-seg); color: var(--st-text2); font-size: 11px; white-space: nowrap; }
  .badge.acc { background: color-mix(in srgb, var(--st-accent) 14%, transparent); color: var(--text); }
  .badge.warn { background: color-mix(in srgb, var(--pm-warn) 18%, transparent); color: var(--pm-warn); }
  .chev { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border: 0; border-radius: 7px; background: transparent; color: var(--st-muted); cursor: pointer; }
  .chev svg { width: 16px; height: 16px; transition: transform .18s; }
  .chev:hover { background: var(--st-hover); color: var(--text); }
  .mrow.open .chev svg { transform: rotate(180deg); }
  /* 触屏点按区扩到 32 以上（视觉不变）：种类筛选胶囊、展开钮、图标钮；模型名的命中区上下铺满整行 */
  @media (pointer: coarse) {
    .stepper { height: 36px; }
    .stepper button { width: 36px; }
    .kf, .chev, .iconbtn, .mname, .btn.sm { position: relative; }
    .btn.sm::after { content: ''; position: absolute; inset: -3px 0; }
    .kf::after { content: ''; position: absolute; inset: -3px -2px; }
    .chev::after, .iconbtn::after { content: ''; position: absolute; inset: -4px; }
    .mname::after { content: ''; position: absolute; inset: -10px 0; }
  }
  .mbody { padding: 4px 14px 14px; }
  .json { width: 100%; box-sizing: border-box; min-height: 72px; resize: vertical; padding: 10px 12px; border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-field); color: var(--text);
    font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12.5px; line-height: 1.55; outline: 0; }
  .json.big { min-height: 160px; }
  .json:focus { border-color: color-mix(in srgb, var(--st-accent) 60%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--st-accent) 14%, transparent); }
  .json.err { border-color: #d9534f; }
  .mfoot { display: flex; justify-content: flex-end; margin-top: 4px; }
  .empty-m { padding: 26px 18px; text-align: center; font-size: 13px; color: var(--st-muted); line-height: 1.6; }
  .addrow { display: flex; gap: 8px; margin-top: 12px; }
  .ksel2 { width: 120px; flex: none; }
  .testbar { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  .testbar .sel { width: auto; min-width: 240px; }
  .result { margin: 14px 0 6px; border: 1px solid var(--st-line); border-radius: 12px; padding: 12px 14px; }
  .result.ok { border-color: color-mix(in srgb, #3fa46a 45%, transparent); background: color-mix(in srgb, #3fa46a 7%, transparent); }
  .result.bad { border-color: color-mix(in srgb, #d9534f 45%, transparent); background: color-mix(in srgb, #d9534f 7%, transparent); }
  .rhead { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; }
  .rhead .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fa46a; }
  .result.bad .dot { background: #d9534f; }
  .reply { margin-top: 8px; font-size: 13.5px; color: var(--text); }
  .errbody { margin: 8px 0 0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; color: var(--st-text2); max-height: 180px; overflow: auto; }
  .log { border: 1px solid var(--st-line); border-radius: 14px; overflow: hidden; font-size: 12.5px; }
  .lrow { display: grid; grid-template-columns: 64px 52px minmax(0, 1fr) 70px; gap: 8px; align-items: center; padding: 7px 12px; border-top: 1px solid var(--st-hair); }
  .lrow:first-child { border-top: 0; }
  .lt2 { color: var(--st-muted); font-size: 11.5px; }
  .st { justify-self: start; padding: 1px 7px; border-radius: 6px; font-size: 11px; font-variant-numeric: tabular-nums; background: var(--st-seg); white-space: nowrap; }
  .st.ok { color: #3fa46a; background: color-mix(in srgb, #3fa46a 12%, transparent); }
  .st.bad { color: #d9534f; background: color-mix(in srgb, #d9534f 12%, transparent); }
  .lm { display: flex; align-items: center; gap: 8px; min-width: 0; overflow: hidden; white-space: nowrap; font-size: 12px; }
  .lm .mono { overflow: hidden; text-overflow: ellipsis; font-size: 12px; }
  .lnum { text-align: right; font-variant-numeric: tabular-nums; color: var(--st-text2); white-space: nowrap; }
  .lerr { grid-column: 3 / -1; color: #d9534f; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .foot { grid-column: 1 / -1; grid-row: 2; display: flex; align-items: center; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--st-line); background: var(--st-surface); }
  .foot .msg { flex: 1; text-align: right; font-size: 12.5px; color: var(--st-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .foot .msg.err { color: #d9534f; }
  .spin.light { border-color: currentColor; border-right-color: transparent; }

  @media (max-width: 699px) {
    .ed { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr) auto; }
    /* 手机：分区是一排胶囊；放不下（窄屏 / 字号放大）就折到第二行，不横滑、不被屏幕右缘截掉（选中的那个也永远看得见） */
    .side { grid-row: 1; flex-direction: row; flex-wrap: wrap; gap: 6px 4px; overflow: visible; padding: 4px 16px 10px; border-right: 0; }
    .side::-webkit-scrollbar { display: none; }
    .nav { flex: none; height: 34px; padding: 0 12px; border-radius: 999px; font-size: 14px; }
    .nav.on { background: var(--st-surface); box-shadow: 0 0 0 1px var(--st-hair), 0 1px 3px rgba(0, 0, 0, .06); }
    .nav svg { display: none; }
    /* 分区名和桌面侧栏同一套短名（连接 · 模型 · 参数 · 测试），四个在一行放得下 */
    .nav .cnt { margin-left: 2px; }
    .body { grid-row: 2; padding: 6px 16px 24px; overflow-x: hidden; overscroll-behavior: contain; }
    section > h3 { display: none; }
    /* 手机：行尾开关比桌面大一号，仍比分组列表的开关小（命中区靠 SToggle 自己的 ::after 扩） */
    .models .mrow .mhead :global(.tg) { width: 34px; height: 20px; }
    .models .mrow .mhead :global(.tg .knob) { width: 16px; height: 16px; }
    .models .mrow .mhead :global(.tg.on .knob) { transform: translateX(14px); }
    .kf :global(svg) { display: none; }   /* 手机：种类胶囊只留字和数，一行放得下 */
    /* 窄屏：模型名 / id 折行显示全，不截（gemini-3.1-flash-im… 截掉的正是区分它们的那段） */
    .ml, .mid { max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
    .in, .numf { height: 44px; border-radius: 12px; background: var(--st-surface); font-size: 15px; }
    .in.mono, .in .mono { font-size: 13.5px; }
    .keybox { height: 44px; border-radius: 12px; }
    .btn { height: 40px; font-size: 14px; }
    .btn.sm { height: 34px; }
    .list, .models, .log { border: 0; border-radius: 18px; background: var(--st-surface); }
    .drop { background: var(--st-surface); }
    .json { background: var(--st-surface); font-size: 13px; }
    .vxwrap { --i-card: var(--st-surface); }
    .li { padding: 13px 16px; }
    .mhd { margin: 2px 16px 8px; font-size: 13px; }
    .mgrp { padding: 10px 16px 7px; }
    .foot { grid-row: 3; padding: 10px 16px calc(10px + var(--sab, 0px)); flex-wrap: wrap; background: var(--pm-bg, var(--st-surface)); border-top-color: var(--st-hair); }
    .foot .msg { order: -1; flex-basis: 100%; text-align: left; }
    .foot .msg:empty { display: none; }
    .foot > .btn:not(.danger) { flex: 1 1 0; min-width: 0; }
    .foot > .btn.ghost:not(.danger) { background: var(--st-surface); }
    .f2 { grid-template-columns: 1fr; gap: 0; }
    .hdr { grid-template-columns: 1fr 30px; }
    .hdr input:nth-child(2) { grid-column: 1; }
    .hdr .iconbtn { grid-row: 1 / span 2; grid-column: 2; }
    .badges .badge:not(.warn) { display: none; }
    .lrow { grid-template-columns: 58px 40px minmax(0, 1fr) 56px; }
    .testbar { flex-wrap: wrap; }
    .testbar .sel { min-width: 0; flex: 1 1 100%; }
    .testbar .btn { flex: 1; }
    .addrow { flex-wrap: wrap; }
    .addrow .in.mono { flex: 1 1 100%; }
    .ksel2 { flex: 1; width: auto; }
    .cand { flex-wrap: wrap; }
    .cid { flex-basis: calc(100% - 40px); }
    .ksel { margin-left: 26px; }
  }
</style>
