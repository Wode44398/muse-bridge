<script>
  // 「自定义」页 —— claude.ai /code 侧栏 Customize 同款：
  // 衬线大标题 → 类目页签（技能 / 连接器 / 插件）｜「你的 / 发现」分段 → 右侧搜索、筛选、排序、「添加」
  // → 精选横幅 →「为你推荐」两列卡片。占住 Claude 分页的正文列（侧栏照常在），开会话 / 新对话即收起（chat.svelte.js）。
  //
  // 数据面全是真的，不摆样板卡片：
  //   你的 = 扩展中心注册表 /api/extensions（开关直接改；点卡片出详情：包含什么、配置、生效 agent、卸载）
  //   发现 = Anthropic 官方插件目录 /api/extensions/catalog（src/extensions-catalog.mjs）：本地源直接装，
  //          远程源在「添加」时从 GitHub 拉；服务器上还没有目录副本时页面里一键下载。
  // 配置照官方 Desktop：插件装好后有必填项（userConfig / MCP 里的令牌）就弹「配置」；要令牌的连接器添加前先填。
  import { onMount } from 'svelte';
  import { ui } from '../lib/state.svelte.js';
  import { api } from '../lib/api.js';
  import { showToast } from '../lib/toast.svelte.js';
  import { uiConfirm } from '../lib/dialogs.js';
  import { extensionsNav, customizeNav } from '../lib/extensionsNav.svelte.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { t, tr } from '../lib/i18n.js';

  const MASK = '••••••••';   // 服务端 SECRET_MASK：敏感值已保存
  const TABS = [
    { key: 'skill', label: t('技能'), ph: t('搜索技能'), none: t('还没有技能'), noneHere: t('官方目录里没有可单独添加的技能') },
    { key: 'connector', label: t('连接器'), ph: t('搜索连接器'), none: t('还没有连接器'), noneHere: t('官方目录里没有可单独添加的连接器') },
    { key: 'plugin', label: t('插件'), ph: t('搜索插件'), none: t('还没有插件'), noneHere: t('官方目录里没有插件') },
  ];
  // Anthropicons 字形：类型兜底 + 目录类别（发现页卡片按类别换图标，和官方卡片「一类一枚」的观感一致）
  const TYPE_GLYPH = { skill: '', connector: '', plugin: '' };
  const CAT = {
    productivity: [t('效率'), ''], development: [t('开发'), ''], database: [t('数据库'), ''],
    monitoring: [t('监控'), ''], security: [t('安全'), ''], deployment: [t('部署'), ''],
    design: [t('设计'), ''], automation: [t('自动化'), ''], learning: [t('学习'), ''],
    testing: [t('测试'), ''], location: [t('位置'), ''], math: [t('数学'), ''], migration: [t('迁移'), ''],
  };
  const catLabel = (c) => (CAT[c] ? CAT[c][0] : t('其他'));
  const glyphOf = (x) => (x.category && CAT[x.category] ? CAT[x.category][1] : TYPE_GLYPH[x.type] || TYPE_GLYPH.skill);
  const typeLabel = (k) => TABS.find((x) => x.key === k)?.label || '';
  // 横幅插画：效率类清单、开发类代码窗、安全类盾牌，其余走清单
  const artOf = (c) => (c === 'security' ? 'shield' : ['development', 'testing', 'database', 'deployment', 'monitoring', 'migration'].includes(c) ? 'code' : 'list');
  // 横幅标题：目录名是 kebab-case 标识，展示时拆词首字母大写（卡片上保留原名，与官方一致）
  const pretty = (s) => String(s || '').split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  const AGENTS = [
    { key: 'claude', label: 'Claude Code', hint: t('下一条消息生效') },
    { key: 'dimensio', label: 'dimensio', hint: t('新会话生效') },
  ];

  const LS = 'bridge-customize';
  const saved = (() => { try { return JSON.parse(localStorage.getItem(LS)) || {}; } catch { return {}; } })();
  const navTab = customizeNav.tab;
  customizeNav.tab = null;
  let tab = $state(TABS.some((x) => x.key === (navTab || saved.tab)) ? (navTab || saved.tab) : 'skill');
  let scope = $state(navTab ? 'yours' : saved.scope === 'yours' ? 'yours' : 'discover');
  $effect(() => { const v = JSON.stringify({ tab, scope }); try { localStorage.setItem(LS, v); } catch {} });
  // 已开着时设置里又点了某个类目：切过去
  $effect(() => { const k = customizeNav.tab; if (k) { customizeNav.tab = null; tab = k; scope = 'yours'; } });
  const tabDef = $derived(TABS.find((x) => x.key === tab));

  let query = $state('');
  let cat = $state('');        // 发现：类别筛选（'' = 全部）
  let status = $state('');     // 你的：'' | 'on' | 'off' | 'cfg'（待配置）
  let sort = $state('rec');    // 'rec' 推荐 | 'name' 名称 | 'recent' 最近更新（仅你的）
  function pickTab(k) { tab = k; cat = ''; status = ''; }
  function pickScope(s) { scope = s; cat = ''; status = ''; if (s === 'discover' && sort === 'recent') sort = 'rec'; }

  // —— 数据 ——
  let mine = $state([]);
  let support = $state({});
  let catalog = $state([]);
  let markets = $state([]);
  let loaded = $state(false);
  let mineErr = $state('');
  let catErr = $state('');
  const errMsg = (e) => tr((e?.body && typeof e.body === 'object' ? e.body.error : typeof e?.body === 'string' ? e.body : '') || e?.message || String(e));
  async function loadMine() {
    const r = await api.get('/api/extensions');
    mine = r.items || []; support = r.support || {}; mineErr = '';
  }
  async function refresh() {
    const [a, b] = await Promise.allSettled([loadMine(), api.get('/api/extensions/catalog')]);
    if (a.status === 'rejected') mineErr = errMsg(a.reason);
    if (b.status === 'fulfilled') { catalog = b.value.items || []; markets = b.value.markets || []; catErr = ''; }
    else catErr = errMsg(b.reason);
    loaded = true;
  }
  const loadErr = $derived(scope === 'discover' ? catErr : mineErr);
  onMount(refresh);
  // 扩展中心（管理文件 / 连接器表单）关回来时重拉：那边可能刚卸载、改了开关或新加了连接器
  let extWasOpen = false;
  $effect(() => {
    const open = ui.extensionsOpen;
    if (extWasOpen && !open) refresh();
    extWasOpen = open;
  });

  // —— 派生列表 ——
  const q = $derived(query.trim().toLowerCase());
  const hit = (x) => !q || [x.title, x.name, x.description, x.plugin, x.author].some((s) => String(s || '').toLowerCase().includes(q));
  const CAT_RANK = { productivity: 0, development: 1, learning: 2, design: 3, security: 4 };
  // 推荐序：Anthropic 自家的在前 → 本地副本（即装即用）在前 → 类别。不看「已添加」：刚点完 ＋ 的卡片原地变 ✓，不在手底下跳走
  const rank = (x) => (x.author === 'Anthropic' ? 0 : 20) + (x.remote ? 10 : 0) + (CAT_RANK[x.category] ?? 5);
  const byName = (a, b) => String(a.title || a.name).localeCompare(String(b.title || b.name));

  const noCatalog = $derived(loaded && !catErr && !markets.length);
  const discoverAll = $derived(catalog.filter((x) => x.type === tab));
  const cats = $derived.by(() => {
    const m = new Map();
    for (const x of discoverAll) m.set(x.category || '', (m.get(x.category || '') || 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  });
  const discoverList = $derived(discoverAll
    .filter((x) => (!cat || (x.category || '') === cat) && hit(x))
    .sort((a, b) => (sort === 'name' ? byName(a, b) : rank(a) - rank(b) || byName(a, b))));
  const browsing = $derived(!q && !cat && sort === 'rec');   // 没搜没筛：出横幅与「为你推荐」
  // 横幅优先挑通用的官方件（目录里没有或已装就顺延），都不在再按推荐序取第一个没装的
  const FEATURED = ['skill-creator', 'frontend-design', 'code-review', 'feature-dev', 'playwright', 'context7'];
  const hero = $derived(browsing
    ? (FEATURED.map((n) => discoverList.find((x) => x.name === n && !x.installed)).find(Boolean)
      || discoverList.find((x) => !x.installed && x.author === 'Anthropic') || discoverList.find((x) => !x.installed) || null)
    : null);
  const rest = $derived(discoverList.filter((x) => x !== hero));
  const forYou = $derived(browsing ? rest.slice(0, 6) : []);
  const more = $derived(browsing ? rest.slice(6) : rest);

  const needsCfg = (x) => !!x.config?.missing?.length;
  const mineAll = $derived(mine.filter((x) => x.type === tab));
  const mineList = $derived(mineAll
    .filter((x) => (!status || (status === 'cfg' ? needsCfg(x) : (status === 'on') === !!x.enabled)) && hit(x))
    .sort((a, b) => (sort === 'name' ? byName(a, b)
      : sort === 'recent' ? (b.updated || 0) - (a.updated || 0)
      : (a.enabled === b.enabled ? byName(a, b) : a.enabled ? -1 : 1))));

  // —— 动作 ——
  let busy = $state({});        // catalog id → 安装中
  async function install(x, values) {
    if (!x || x.installed || busy[x.id]) return;
    // 要令牌的连接器：先填（同官方「Connect」先问凭据）
    if (x.type === 'connector' && !values && x.fields?.some((f) => f.required)) { openCfg({ mode: 'install', item: x, fields: x.fields }); return; }
    busy[x.id] = true;
    try {
      const r = await api.post('/api/extensions/catalog/install', { id: x.id, ...(values ? { values } : {}) });
      x.installed = true;
      cfg = null;
      await loadMine().catch(() => {});
      const got = mine.find((m) => m.id === r.item?.id) || r.item;
      if (got && needsCfg(got)) {
        showToast(t('已添加「{name}」，填好配置后生效', { name: got.name }));
        openCfg({ mode: 'configure', item: got, fields: got.config.fields, values: got.config.values });
      } else showToast(t('已添加「{name}」', { name: r.item?.name || x.name }));
    } catch (e) { showToast(errMsg(e), 'err'); }
    finally { delete busy[x.id]; }
  }
  async function toggle(x, e) {
    e?.stopPropagation();
    const v = !x.enabled;
    x.enabled = v;   // 乐观翻转，失败回滚
    try { await api.post('/api/extensions/update', { id: x.id, enabled: v }); }
    catch (err) { x.enabled = !v; showToast(errMsg(err), 'err'); }
  }
  async function toggleAgent(x, a) {
    if (!support[x.type]?.[a]) return;
    const v = !x.agents?.[a];
    x.agents = { ...(x.agents || {}), [a]: v };
    try { await api.post('/api/extensions/update', { id: x.id, agents: { [a]: v } }); }
    catch (err) { x.agents = { ...x.agents, [a]: !v }; showToast(errMsg(err), 'err'); }
  }
  async function remove(x) {
    if (!(await uiConfirm(t('卸载「{name}」？', { name: x.name }), { detail: t('文件与保存的配置会一并删除。') }))) return;
    try {
      await api.post('/api/extensions/delete', { id: x.id });
      detId = null;
      showToast(t('已卸载「{name}」', { name: x.name }));
      await refresh();
    } catch (e) { showToast(errMsg(e), 'err'); }
  }
  // 文件浏览、替换版本、连接器编辑、包管理留在扩展中心（直落该项详情）
  function manage(x) { extensionsNav.type = x.type; extensionsNav.id = x.id; ui.extensionsOpen = true; }

  // 「添加」菜单：上传技能 / 插件（同扩展中心的上传接口），连接器交给扩展中心的表单
  let upInput;
  let upType = 'skill';
  function pickUpload(k) { menu = null; upType = k; upInput.accept = k === 'plugin' ? '.zip' : '.md,.zip,.skill'; upInput.click(); }
  async function doUpload(e) {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    try {
      const r = await api.post(`/api/extensions/upload?type=${upType}&name=${encodeURIComponent(f.name)}`, f);
      tab = upType; scope = 'yours';
      await refresh();
      const got = mine.find((m) => m.id === r.item?.id);
      if (got && needsCfg(got)) openCfg({ mode: 'configure', item: got, fields: got.config.fields, values: got.config.values });
      showToast(t('已添加「{name}」', { name: r.item?.name || f.name }));
    } catch (err) { showToast(errMsg(err), 'err'); }
  }
  function addConnector() { menu = null; extensionsNav.type = 'connector'; extensionsNav.action = 'connector'; ui.extensionsOpen = true; }

  // 下载 / 更新官方目录（新装的服务器上还没有这份副本）
  let fetching = $state(false);
  async function fetchCatalog() {
    menu = null;
    if (fetching) return;
    fetching = true;
    try {
      const r = await api.post('/api/extensions/catalog/fetch', {});
      catalog = r.items || []; markets = r.markets || []; catErr = '';
      showToast(t('官方目录已更新'));
    } catch (e) { showToast(errMsg(e), 'err'); }
    finally { fetching = false; }
  }

  // —— 配置表单（插件配置 / 连接器添加前填令牌）——
  // { mode: 'install' | 'configure', item, fields, values? }；form 是输入框里的值，敏感项已保存时留空 = 不变
  let cfg = $state(null);
  let form = $state({});
  let cfgBusy = $state(false);
  function openCfg(c) {
    const f = {};
    for (const x of c.fields) {
      const v = c.values?.[x.key];
      f[x.key] = x.type === 'boolean' ? (v ?? x.default ?? false) === true || v === 'true' : v === MASK || v == null ? '' : String(v);
    }
    form = f;
    cfg = c;
  }
  const isSaved = (x) => cfg?.values?.[x.key] === MASK;
  const cfgReady = $derived(!cfg || cfg.fields.every((x) => !x.required || x.default !== undefined || isSaved(x) || x.type === 'boolean' || String(form[x.key] ?? '').trim()));
  async function submitCfg() {
    if (!cfg || cfgBusy || !cfgReady) return;
    const values = {};
    for (const x of cfg.fields) {
      const v = form[x.key];
      if (x.sensitive && v === '') continue;   // 敏感项留空 = 沿用已保存的值
      values[x.key] = v;
    }
    if (cfg.mode === 'install') { await install(cfg.item, values); return; }
    cfgBusy = true;
    try {
      const r = await api.post('/api/extensions/configure', { id: cfg.item.id, values });
      const i = mine.findIndex((m) => m.id === r.item.id);
      if (i >= 0) mine[i] = r.item;
      cfg = null;
      showToast(needsCfg(r.item) ? t('已保存，还有必填项没填') : t('配置已保存，下一条消息生效'));
    } catch (e) { showToast(errMsg(e), 'err'); }
    finally { cfgBusy = false; }
  }

  // —— 弹出层：筛选 / 排序 / 添加菜单 + 发现项详情 + 已装项详情 + 配置（系统返回 / Esc 后开先关）——
  let menu = $state(null);      // 'filter' | 'sort' | 'add' | null
  let sel = $state(null);       // 发现项详情
  let detId = $state(null);     // 已装项详情（存 id：列表重拉后仍指向新对象）
  const det = $derived(detId ? mine.find((m) => m.id === detId) || null : null);
  $effect(() => { if (menu) return pushBackLayer(() => { menu = null; }); });
  $effect(() => { if (sel) return pushBackLayer(() => { sel = null; }); });
  $effect(() => { if (detId) return pushBackLayer(() => { detId = null; }); });
  $effect(() => { if (cfg) return pushBackLayer(() => { cfg = null; }); });
  function onKey(e) {
    if (e.key !== 'Escape' || ui.extensionsOpen) return;
    if (menu) menu = null;
    else if (cfg) cfg = null;
    else if (sel) sel = null;
    else if (detId) detId = null;
    else return;
    e.preventDefault();
  }
  const toggleMenu = (m) => { menu = menu === m ? null : m; };
  // 点菜单外任何地方收起。不用全屏透明罩：.cz 是尺寸容器（container-type 带布局约束），里面的 fixed 罩
  // 会被它圈住、盖不到侧栏；挂到外面又会因层叠上下文压住菜单本身。
  function onOutside(e) { if (menu && !e.target.closest?.('.pop-wrap')) menu = null; }
  const filterOn = $derived(scope === 'discover' ? !!cat : !!status);
  const SORTS = $derived(scope === 'discover'
    ? [['rec', t('推荐')], ['name', t('名称')]]
    : [['rec', t('已启用优先')], ['name', t('名称')], ['recent', t('最近更新')]]);
  const STATUS = $derived([['', t('全部')], ['on', t('已启用')], ['off', t('已停用')], ...(tab === 'plugin' ? [['cfg', t('待配置')]] : [])]);
  // 来源行：作者优先（目录名「Anthropic」只说明它收录在官方目录里，不等于 Anthropic 出品）；远程源再带仓库地址
  const srcLine = (x) => [x.author || (x.remote ? '' : x.source), x.remote ? x.repo : ''].filter(Boolean).join(' · ');
  const mineLine = (x) => [needsCfg(x) ? t('需要配置') : x.enabled ? t('已启用') : t('已停用'), x.version ? `v${x.version}` : '', x.source || x.pkg || ''].filter(Boolean).join(' · ');
  const CONTENTS = [['skills', t('技能')], ['commands', t('命令')], ['agents', t('子 agent')], ['mcp', 'MCP']];
</script>

<svelte:window onkeydown={onKey} onpointerdown={onOutside} />

{#snippet art(kind)}
  <svg class="hero-art" viewBox="0 0 160 160" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    {#if kind === 'code'}
      <path class="fill" d="M22 38c0-5 3-8 8-8h100c5 0 8 3 8 8v78c0 5-3 8-8 8H30c-5 0-8-3-8-8z"/>
      <path d="M23 52h114M34 41h.5M44 41h.5M54 41h.5"/>
      <path d="M62 74 48 88l14 14M98 74l14 14-14 14M86 70l-12 36"/>
    {:else if kind === 'shield'}
      <path class="fill" d="M80 22c16 10 30 14 46 14 0 44-12 74-46 96-34-22-46-52-46-96 16 0 30-4 46-14z"/>
      <path d="m60 80 14 14 28-30"/>
    {:else}
      <path class="fill" d="M24 30.5c0-2.5 1.6-4 4.2-4.1l24.6-.3c2.6 0 4 1.5 4 4l.2 24.7c0 2.5-1.5 4.1-4.1 4.1l-24.8.2c-2.5 0-4-1.5-4-4.1z"/>
      <path d="m31 42 9 9 21-24"/>
      <path class="fill" d="M24 72.3c0-2.5 1.5-4.1 4.1-4.1l24.7.1c2.6 0 4.1 1.6 4.1 4.2l-.1 24.4c0 2.6-1.6 4.2-4.2 4.2H28.2c-2.6 0-4.1-1.6-4.1-4.2z"/>
      <path d="m31 84 9 9 21-24"/>
      <path d="M24.3 114.2c0-2.6 1.5-4.1 4-4.1l24.6.2c2.6 0 4.1 1.5 4.1 4.1l-.2 24.5c0 2.6-1.5 4.1-4.1 4.1l-24.4-.1c-2.6 0-4.1-1.6-4.1-4.2z"/>
      <path d="M72 42.5c14-.6 28-.4 42 .2M72 85c14-.5 29-.3 43 .3M72 127.5c14-.4 28-.2 42 .3"/>
    {/if}
  </svg>
{/snippet}

{#snippet discoverCard(x)}
  <div class="card" role="button" tabindex="0" onclick={() => (sel = x)} onkeydown={(e) => { if (e.key === 'Enter') sel = x; }}>
    <span class="ico ic" aria-hidden="true">{glyphOf(x)}</span>
    <div class="tx">
      <div class="nm">{x.title}</div>
      <div class="ds">{x.description || t('（无描述）')}</div>
      <div class="src">{srcLine(x)}</div>
    </div>
    <button class="plus" class:done={x.installed} disabled={x.installed || !!busy[x.id]}
      aria-label={x.installed ? t('已添加 {name}', { name: x.name }) : t('添加 {name}', { name: x.name })} title={x.installed ? t('已添加') : t('添加')}
      onclick={(e) => { e.stopPropagation(); install(x); }}>
      {#if busy[x.id]}<span class="spin"></span>{:else}<span class="ic">{x.installed ? '' : ''}</span>{/if}
    </button>
  </div>
{/snippet}

{#snippet mineCard(x)}
  <div class="card" class:off={!x.enabled} role="button" tabindex="0" onclick={() => (detId = x.id)} onkeydown={(e) => { if (e.key === 'Enter') detId = x.id; }}>
    <span class="ico ic" aria-hidden="true">{TYPE_GLYPH[x.type]}</span>
    <div class="tx">
      <div class="nm">{x.name}</div>
      <div class="ds">{x.description || t('（无描述）')}</div>
      <div class="src" class:warn={needsCfg(x)}>{mineLine(x)}</div>
    </div>
    <button class="sw" class:on={x.enabled} role="switch" aria-checked={!!x.enabled} aria-label={t('启用 {name}', { name: x.name })}
      onclick={(e) => toggle(x, e)}><span class="knob"></span></button>
  </div>
{/snippet}

<section class="cz">
  <div class="in">
    <h1 class="h">{t('自定义')}</h1>

    <div class="bar">
      <div class="left">
        <div class="tabs" role="tablist">
          {#each TABS as x (x.key)}
            <button class="tab" class:on={tab === x.key} role="tab" aria-selected={tab === x.key} onclick={() => pickTab(x.key)}>{x.label}</button>
          {/each}
        </div>
        <span class="vr" aria-hidden="true"></span>
        <div class="seg" role="tablist">
          <button class:on={scope === 'yours'} role="tab" aria-selected={scope === 'yours'} onclick={() => pickScope('yours')}>{t('你的')}</button>
          <button class:on={scope === 'discover'} role="tab" aria-selected={scope === 'discover'} onclick={() => pickScope('discover')}>{t('发现')}</button>
        </div>
      </div>
      <div class="right">
        <label class="search">
          <span class="ic" aria-hidden="true">&#xe0d3;</span>
          <input type="text" bind:value={query} placeholder={tabDef.ph} spellcheck="false" />
        </label>
        <div class="pop-wrap">
          <button class="ib" class:lit={filterOn} aria-label={t('筛选')} title={t('筛选')} onclick={() => toggleMenu('filter')}><span class="ic">&#xe070;</span></button>
          {#if menu === 'filter'}
            <div class="menu">
              {#if scope === 'discover'}
                <button class:on={!cat} onclick={() => { cat = ''; menu = null; }}>{t('全部类别')}<span class="n">{discoverAll.length}</span></button>
                {#each cats as [c, n] (c)}
                  <button class:on={cat === c} onclick={() => { cat = c; menu = null; }}>{catLabel(c)}<span class="n">{n}</span></button>
                {/each}
              {:else}
                {#each STATUS as [k, l] (k)}
                  <button class:on={status === k} onclick={() => { status = k; menu = null; }}>{l}</button>
                {/each}
              {/if}
            </div>
          {/if}
        </div>
        <div class="pop-wrap">
          <button class="ib" class:lit={sort !== 'rec'} aria-label={t('排序')} title={t('排序')} onclick={() => toggleMenu('sort')}><span class="ic">&#xe0e3;</span></button>
          {#if menu === 'sort'}
            <div class="menu">
              {#each SORTS as [k, l] (k)}
                <button class:on={sort === k} onclick={() => { sort = k; menu = null; }}>{l}</button>
              {/each}
            </div>
          {/if}
        </div>
        <div class="pop-wrap">
          <button class="add" aria-haspopup="menu" aria-expanded={menu === 'add'} onclick={() => toggleMenu('add')}>
            <span class="ic plus-g" aria-hidden="true">&#xe001;</span>{t('添加')}<span class="ic chev" aria-hidden="true">&#xe027;</span>
          </button>
          {#if menu === 'add'}
            <div class="menu">
              <button onclick={() => pickUpload('skill')}><span class="ic mi">{TYPE_GLYPH.skill}</span>{t('上传技能…')}</button>
              <button onclick={() => pickUpload('plugin')}><span class="ic mi">{TYPE_GLYPH.plugin}</span>{t('上传插件…')}</button>
              <button onclick={addConnector}><span class="ic mi">{TYPE_GLYPH.connector}</span>{t('添加自定义连接器…')}</button>
              <div class="sep"></div>
              <button disabled={fetching} onclick={fetchCatalog}><span class="ic mi">&#xe063;</span>{fetching ? t('正在更新官方目录…') : t('更新官方目录')}</button>
            </div>
          {/if}
        </div>
        <input bind:this={upInput} type="file" hidden onchange={doUpload} />
      </div>
    </div>

    {#if !loaded}
      <div class="empty">{t('载入中…')}</div>
    {:else if loadErr}
      <div class="empty">{loadErr}</div>
    {:else if scope === 'discover'}
      {#if noCatalog}
        <div class="getdir">
          <span class="ico ic" aria-hidden="true">{TYPE_GLYPH.plugin}</span>
          <div class="hero-t sm">{t('Anthropic 官方插件目录')}</div>
          <p>{t('这台服务器上还没有官方目录。下载后就能在这里浏览、添加技能、连接器和插件（约 15 MB，从 GitHub 下载）。')}</p>
          <button class="hero-add" disabled={fetching} onclick={fetchCatalog}>{fetching ? t('下载中…') : t('下载官方目录')}</button>
        </div>
      {:else}
        {#if hero}
          <div class="hero">
            <div class="hero-tx">
              <div class="from">{t('来自 {who}', { who: hero.author || hero.source })}</div>
              <div class="hero-t">{pretty(hero.title)}</div>
              <div class="hero-d">{hero.description}</div>
              <button class="hero-add" disabled={!!busy[hero.id]} onclick={() => install(hero)}>{busy[hero.id] ? t('添加中…') : t('添加')}</button>
            </div>
            {@render art(artOf(hero.category))}
          </div>
        {/if}
        {#if !discoverList.length}
          <div class="empty">{discoverAll.length ? t('没有匹配的结果') : tabDef.noneHere}</div>
        {:else}
          {#if forYou.length}
            <h2 class="sec">{t('为你推荐')}</h2>
            <div class="grid">{#each forYou as x (x.id)}{@render discoverCard(x)}{/each}</div>
          {/if}
          {#if more.length}
            <h2 class="sec">{browsing ? t('全部') : t('{n} 个结果', { n: more.length })}</h2>
            <div class="grid">{#each more as x (x.id)}{@render discoverCard(x)}{/each}</div>
          {/if}
        {/if}
        <p class="foot">{t('「发现」列的是 Anthropic 官方插件目录。标着仓库地址的插件在添加时从 GitHub 下载，第三方插件请先看过主页再添加。')}</p>
      {/if}
    {:else}
      {#if !mineList.length}
        <div class="empty">
          {#if mineAll.length}{t('没有匹配的结果')}{:else}
            {tabDef.none}
            <button class="link" onclick={() => pickScope('discover')}>{t('去「发现」看看')}</button>
          {/if}
        </div>
      {:else}
        <div class="grid mine">{#each mineList as x (x.id)}{@render mineCard(x)}{/each}</div>
      {/if}
    {/if}
    <p class="foot">{t('装好、启用的扩展对 Claude Code 从下一条消息起生效，对 dimensio 在新会话生效。')}</p>
  </div>
</section>

{#if sel}
  <button class="dlg-bd" aria-label={t('关闭')} onclick={() => (sel = null)}></button>
  <div class="dlg" role="dialog" aria-modal="true" aria-label={sel.title}>
    <div class="dlg-head">
      <span class="ico ic" aria-hidden="true">{glyphOf(sel)}</span>
      <div class="dlg-ht">
        <div class="dlg-t">{sel.title}</div>
        <div class="src">{srcLine(sel)}</div>
      </div>
      <button class="dlg-x" aria-label={t('关闭')} onclick={() => (sel = null)}><span class="ic">&#xe10f;</span></button>
    </div>
    <div class="chips">
      <span class="chip">{typeLabel(sel.type)}</span>
      {#if sel.category}<span class="chip">{catLabel(sel.category)}</span>{/if}
      {#if sel.type !== 'plugin'}<span class="chip">{t('来自插件 {name}', { name: sel.plugin })}</span>{/if}
      {#if sel.transport}<span class="chip">{sel.transport === 'stdio' ? t('本地命令') : t('远程 {kind}', { kind: sel.transport.toUpperCase() })}</span>{/if}
      {#if sel.remote}<span class="chip">{t('添加时从 GitHub 下载')}</span>{/if}
      {#if sel.configurable || sel.fields?.some((f) => f.required)}<span class="chip">{t('需要配置')}</span>{/if}
    </div>
    <p class="dlg-d">{sel.description || t('（无描述）')}</p>
    <div class="dlg-act">
      {#if sel.homepage}<a class="dlg-home" href={sel.homepage} target="_blank" rel="noopener noreferrer">{t('主页')}</a>{/if}
      <span class="sp"></span>
      <button class="hero-add" disabled={sel.installed || !!busy[sel.id]} onclick={() => install(sel)}>
        {sel.installed ? t('已添加') : busy[sel.id] ? t('添加中…') : t('添加')}
      </button>
    </div>
  </div>
{/if}

{#if det}
  <button class="dlg-bd" aria-label={t('关闭')} onclick={() => (detId = null)}></button>
  <div class="dlg" role="dialog" aria-modal="true" aria-label={det.name}>
    <div class="dlg-head">
      <span class="ico ic" aria-hidden="true">{TYPE_GLYPH[det.type]}</span>
      <div class="dlg-ht">
        <div class="dlg-t">{det.name}</div>
        <div class="src">{[typeLabel(det.type), det.version ? `v${det.version}` : '', det.source || det.pkg || ''].filter(Boolean).join(' · ')}</div>
      </div>
      <button class="sw inline" class:on={det.enabled} role="switch" aria-checked={!!det.enabled} aria-label={t('启用 {name}', { name: det.name })}
        onclick={() => toggle(det)}><span class="knob"></span></button>
      <button class="dlg-x" aria-label={t('关闭')} onclick={() => (detId = null)}><span class="ic">&#xe10f;</span></button>
    </div>
    <p class="dlg-d">{det.description || t('（无描述）')}</p>

    {#if det.type === 'plugin' && det.contents}
      {@const c = det.contents}
      {#if CONTENTS.some(([k]) => c[k]?.length) || c.hooks}
        <div class="blk-h">{t('包含')}</div>
        <div class="blk">
          {#each CONTENTS as [k, l] (k)}
            {#if c[k]?.length}
              <div class="kv"><span class="k">{l}<i>{c[k].length}</i></span>
                <span class="v">{#each c[k].slice(0, 12) as n (n)}<span class="chip">{n}</span>{/each}{#if c[k].length > 12}<span class="chip">+{c[k].length - 12}</span>{/if}</span></div>
            {/if}
          {/each}
          {#if c.hooks}<div class="kv"><span class="k">{t('钩子')}</span><span class="v"><span class="chip">hooks.json</span></span></div>{/if}
        </div>
      {/if}
    {/if}

    {#if det.type === 'connector' && det.connector}
      <div class="blk-h">{t('连接')}</div>
      <div class="blk">
        <div class="kv"><span class="k">{t('方式')}</span><span class="v">{det.connector.transport === 'stdio' ? t('本地命令') : t('远程 {kind}', { kind: det.connector.transport.toUpperCase() })}</span></div>
        <div class="kv"><span class="k">{det.connector.transport === 'stdio' ? t('命令') : t('地址')}</span>
          <span class="v mono">{det.connector.transport === 'stdio' ? [det.connector.command, ...(det.connector.args || [])].join(' ') : det.connector.url}</span></div>
      </div>
    {/if}

    {#if det.config?.fields?.length}
      <div class="blk-h">{t('配置')}</div>
      <div class="blk row">
        <span class="cfg-st" class:warn={needsCfg(det)}>
          {needsCfg(det) ? t('还有 {n} 项必填没填，用到它们的 MCP 暂不加载', { n: det.config.missing.length }) : t('{n} 项配置', { n: det.config.fields.length })}
        </span>
        <button class="btn" onclick={() => openCfg({ mode: 'configure', item: det, fields: det.config.fields, values: det.config.values })}>{t('配置')}</button>
      </div>
    {/if}

    <div class="blk-h">{t('生效 Agent')}</div>
    <div class="blk">
      {#each AGENTS as a (a.key)}
        {@const ok = !!support[det.type]?.[a.key]}
        <div class="kv ag" class:dis={!ok}>
          <span class="k">{a.label}</span>
          <span class="v dim">{ok ? a.hint : t('不支持这类扩展')}</span>
          <button class="sw inline sm" class:on={ok && !!det.agents?.[a.key]} disabled={!ok} role="switch" aria-checked={ok && !!det.agents?.[a.key]}
            aria-label={a.label} onclick={() => toggleAgent(det, a.key)}><span class="knob"></span></button>
        </div>
      {/each}
    </div>

    <div class="dlg-act">
      <button class="btn danger" onclick={() => remove(det)}>{t('卸载')}</button>
      <span class="sp"></span>
      <button class="btn" onclick={() => manage(det)}>{det.type === 'connector' ? t('编辑连接') : t('查看文件')}</button>
    </div>
  </div>
{/if}

{#if cfg}
  <button class="dlg-bd top" aria-label={t('关闭')} onclick={() => (cfg = null)}></button>
  <form class="dlg top" role="dialog" aria-modal="true" aria-label={t('配置')} onsubmit={(e) => { e.preventDefault(); submitCfg(); }}>
    <div class="dlg-head">
      <div class="dlg-ht">
        <div class="dlg-t">{cfg.mode === 'install' ? t('添加 {name}', { name: cfg.item.title || cfg.item.name }) : t('配置 {name}', { name: cfg.item.name })}</div>
        <div class="src">{cfg.mode === 'install' ? t('这个连接器需要以下信息才能连上') : t('敏感值加密保存在服务器上，不会再显示出来')}</div>
      </div>
      <button type="button" class="dlg-x" aria-label={t('关闭')} onclick={() => (cfg = null)}><span class="ic">&#xe10f;</span></button>
    </div>
    <div class="fields">
      {#each cfg.fields as x (x.key)}
        <label class="fld" class:chk={x.type === 'boolean'}>
          <span class="fl">{x.title}{#if x.required && x.default === undefined}<b class="req">*</b>{/if}{#if x.title !== x.key}<code>{x.key}</code>{/if}</span>
          {#if x.type === 'boolean'}
            <input type="checkbox" bind:checked={form[x.key]} />
          {:else if x.options?.length}
            <select bind:value={form[x.key]}>
              <option value="">{x.default !== undefined ? t('默认（{v}）', { v: String(x.default) }) : t('（未选）')}</option>
              {#each x.options as o (o)}<option value={o}>{o}</option>{/each}
            </select>
          {:else}
            <input type={x.sensitive ? 'password' : x.type === 'number' ? 'number' : 'text'} bind:value={form[x.key]} autocomplete="off" spellcheck="false"
              placeholder={isSaved(x) ? t('已保存 · 留空不变') : x.default !== undefined && x.default !== '' ? t('默认：{v}', { v: String(x.default) }) : ''} />
          {/if}
          {#if x.description}<span class="fd">{x.description}</span>{/if}
        </label>
      {/each}
    </div>
    <div class="dlg-act">
      <span class="sp"></span>
      <button type="button" class="btn" onclick={() => (cfg = null)}>{t('取消')}</button>
      <button type="submit" class="hero-add" disabled={!cfgReady || cfgBusy || !!busy[cfg.item.id]}>
        {cfg.mode === 'install' ? (busy[cfg.item.id] ? t('添加中…') : t('添加')) : cfgBusy ? t('保存中…') : t('保存')}
      </button>
    </div>
  </form>
{/if}

<style>
  /* 令牌：页面底 / 主文字 / 次级字沿用聊天页（--bg / --text / --serif）；控件描边、分段、主按钮取设置对话框那套
     官方实测值（--st-*，app.css）。横幅是官方 Productivity 横幅的鼠尾草绿，深色按同色相压暗。 */
  .cz { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; container-type: inline-size;
    --cz-hero: #cfd7c5; --cz-hero-ink: #141413; --cz-hero-fill: #c3dbe2; --cz-line-hi: rgba(11, 11, 11, .2); --cz-warn: #b05a1e;
    animation: czIn var(--mo-base, .28s) var(--ea-decel, ease-out); }
  :global(html:not([data-theme="light"])) .cz, :global(html:not([data-theme="light"])) .dlg { --cz-hero: #363d31; --cz-hero-ink: #ecefe6; --cz-hero-fill: #4a5f66; --cz-line-hi: rgba(255, 255, 255, .22); --cz-warn: #e0965a; }
  .dlg { --cz-warn: #b05a1e; --cz-line-hi: rgba(11, 11, 11, .2); }
  @keyframes czIn { from { opacity: 0; transform: translateY(6px); } }
  .cz::-webkit-scrollbar { width: 6px; }
  .cz::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--muted) 38%, transparent); border-radius: 999px; }
  /* 顶部让出浮在正文上的顶栏（44px 圆钮）：中屏侧栏收起时汉堡钮在左上，不让位就压标题 */
  .in { max-width: 1104px; margin: 0 auto; padding: calc(var(--sat, 0px) + 56px) 40px 48px; }
  .h { font-family: var(--serif-stack); font-weight: 400; font-size: 32px; line-height: 1.2; letter-spacing: -.2px; color: var(--text); margin: 4px 0 28px; }

  /* —— 工具条 —— */
  .bar { display: flex; align-items: center; gap: 8px 12px; flex-wrap: wrap; margin-bottom: 28px; }
  .left, .right { display: flex; align-items: center; gap: 8px; }
  .right { margin-left: auto; }
  .tabs { display: flex; gap: 2px; }
  .tab { height: 34px; padding: 0 12px; border-radius: 8px; font-size: 15px; color: var(--st-muted); transition: background-color .12s ease, color .12s ease; }
  .tab.on { background: var(--st-sel); color: var(--text); font-weight: 500; }
  .vr { width: 1px; height: 22px; background: var(--st-line); margin: 0 8px; }
  .seg { display: flex; padding: 3px; border-radius: 10px; background: var(--st-seg); }
  .seg button { height: 30px; padding: 0 12px; border-radius: 7px; font-size: 15px; color: var(--st-muted); transition: background-color .12s ease, color .12s ease, box-shadow .12s ease; }
  .seg button.on { background: var(--st-thumb); color: var(--text); box-shadow: 0 1px 2px rgba(0, 0, 0, .06), 0 0 0 .5px var(--st-line); }
  .search { width: 290px; height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 12px; border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-field); color: var(--st-muted); cursor: text; transition: border-color .12s ease; }
  .search:focus-within { border-color: var(--cz-line-hi); }
  .search .ic { font-size: 18px; font-weight: 430; }
  .search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; color: var(--text); font: inherit; font-size: 15px; }
  .search input::placeholder { color: var(--st-muted); }
  .ib { width: 36px; height: 36px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--serif); font-size: 20px; transition: background-color .12s ease; }
  .ib .ic { font-weight: 430; }
  .ib.lit { background: var(--st-sel); color: var(--text); }
  .add { height: 36px; display: flex; align-items: center; gap: 6px; padding: 0 10px 0 12px; border-radius: 10px; background: var(--st-primary); color: var(--st-primary-ink); font-size: 15px; font-weight: 500; transition: opacity .12s ease; }
  .add .plus-g { font-size: 16px; font-weight: 700; }
  .add .chev { font-size: 14px; font-weight: 530; margin-left: 2px; }

  .pop-wrap { position: relative; }
  .menu { position: absolute; top: calc(100% + 6px); right: 0; z-index: 21; min-width: 200px; max-height: 340px; overflow-y: auto; padding: 5px;
    background: var(--st-menu); border-radius: 12px; box-shadow: var(--st-menu-shadow); animation: czPop .16s ease-out; }
  @keyframes czPop { from { opacity: 0; transform: translateY(-4px) scale(.98); } }
  .menu button { width: 100%; display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; font-size: 14px; color: var(--text); text-align: left; white-space: nowrap; }
  .menu button:disabled { color: var(--st-muted); }
  .menu button.on { background: var(--st-sel); }
  .menu .n { margin-left: auto; color: var(--st-muted); font-size: 12.5px; font-variant-numeric: tabular-nums; }
  .menu .mi { width: 20px; text-align: center; font-size: 18px; font-weight: 430; color: var(--serif); }
  .menu .sep { height: 1px; margin: 4px 6px; background: var(--st-line); }

  /* —— 精选横幅 —— */
  .hero { display: flex; align-items: center; gap: 24px; min-height: 200px; padding: 32px 40px; border-radius: 16px; background: var(--cz-hero); color: var(--cz-hero-ink); margin-bottom: 8px; }
  .hero-tx { flex: 1; min-width: 0; }
  .from { font-size: 14px; opacity: .72; }
  .hero-t { font-family: var(--serif-stack); font-size: 32px; font-weight: 400; line-height: 1.2; margin: 6px 0 10px; }
  .hero-t.sm { font-size: 24px; margin: 14px 0 6px; color: var(--text); }
  .hero-d { font-size: 16px; line-height: 1.5; opacity: .85; max-width: 640px; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .hero-add { margin-top: 20px; height: 36px; padding: 0 16px; border-radius: 10px; background: var(--st-primary); color: var(--st-primary-ink); font-size: 15px; font-weight: 500; transition: opacity .12s ease; }
  .hero-add:disabled { opacity: .55; cursor: default; }
  .hero-art { width: 150px; height: 150px; flex: none; margin-right: 56px; }
  .hero-art .fill { fill: var(--cz-hero-fill); }
  .getdir { display: flex; flex-direction: column; align-items: center; text-align: center; padding: 48px 24px; border: 1px dashed var(--st-line); border-radius: 16px; }
  .getdir p { max-width: 460px; margin: 0; font-size: 14.5px; line-height: 1.6; color: var(--serif); }

  /* —— 卡片网格（官方 For you：两列、1px 描边、12 圆角、56 图标盒、右上角 ＋）—— */
  .sec { font-size: 17px; font-weight: 500; color: var(--text); margin: 32px 0 14px; }
  .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; }
  .grid.mine { margin-top: 4px; }
  .card { position: relative; display: flex; gap: 16px; min-height: 124px; padding: 16px; border: 1px solid var(--st-line); border-radius: 12px; cursor: pointer; text-align: left;
    transition: border-color .12s ease, background-color .12s ease; }
  .card:focus-visible { outline: 2px solid var(--st-accent); outline-offset: 2px; }
  .card.off .ico, .card.off .nm { opacity: .55; }
  .ico { width: 56px; height: 56px; flex: none; display: flex; align-items: center; justify-content: center; border: 1px solid var(--st-line); border-radius: 12px; font-size: 26px; font-weight: 430; color: var(--serif); background: var(--st-field); }
  .tx { flex: 1; min-width: 0; padding-right: 44px; }
  .nm { font-size: 16px; font-weight: 500; color: var(--text); line-height: 1.35; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .ds { margin-top: 4px; font-size: 14.5px; line-height: 1.45; color: var(--serif); display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .src { margin-top: 6px; font-size: 14px; color: var(--st-muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .src.warn, .cfg-st.warn { color: var(--cz-warn); }
  .plus { position: absolute; top: 16px; right: 16px; width: 32px; height: 32px; border: 1px solid var(--st-line); border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--text); font-size: 16px; font-weight: 600; background: var(--bg);
    transition: background-color .12s ease, border-color .12s ease; }
  .plus .ic { font-weight: 600; }
  .plus.done { color: var(--st-muted); cursor: default; }
  .spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--st-line); border-top-color: var(--text); animation: czSpin .8s linear infinite; }
  @keyframes czSpin { to { transform: rotate(360deg); } }
  /* 开关（设置页 SToggle 同色：开 = --st-accent） */
  .sw { position: absolute; top: 20px; right: 16px; width: 36px; height: 20px; flex: none; border-radius: 999px; background: var(--st-line); transition: background-color .12s ease; }
  .sw.inline { position: relative; top: auto; right: auto; }
  .sw.on { background: var(--st-accent); }
  .sw:disabled { opacity: .4; cursor: default; }
  .knob { position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .25); transition: transform .16s ease; }
  .sw.on .knob { transform: translateX(16px); }

  .empty { padding: 56px 0; text-align: center; color: var(--st-muted); font-size: 15px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
  .link { color: var(--st-accent); font-size: 14px; }
  .foot { margin-top: 28px; font-size: 12.5px; line-height: 1.6; color: var(--st-muted); }
  .foot + .foot { margin-top: 4px; }

  /* —— 对话框（设置对话框同款材质）：发现项详情 / 已装项详情 / 配置表单 —— */
  .dlg-bd { position: fixed; inset: 0; z-index: 70; background: var(--st-backdrop); cursor: default; animation: czFade .16s ease; }
  .dlg-bd.top { z-index: 72; }
  @keyframes czFade { from { opacity: 0; } }
  .dlg { position: fixed; z-index: 71; left: 50%; top: 50%; transform: translate(-50%, -50%); width: min(540px, calc(100vw - 32px)); max-height: calc(100dvh - 64px); overflow-y: auto;
    padding: 20px; border-radius: 16px; background: var(--st-surface); box-shadow: var(--st-menu-shadow); animation: czDlg .24s ease-out; }
  .dlg.top { z-index: 73; }
  @keyframes czDlg { from { opacity: 0; transform: translate(-50%, -48%) scale(.98); } }
  .dlg-head { display: flex; align-items: center; gap: 14px; }
  .dlg-ht { flex: 1; min-width: 0; }
  .dlg-t { font-size: 18px; font-weight: 500; color: var(--text); overflow-wrap: anywhere; }
  .dlg-x { width: 32px; height: 32px; flex: none; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--st-muted); font-size: 18px; align-self: flex-start; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 16px; }
  .chip { font-size: 12.5px; padding: 3px 9px; border-radius: 999px; background: var(--st-seg); color: var(--serif); white-space: nowrap; }
  .mono { font-family: var(--mono, ui-monospace, monospace); font-size: 12px; }
  .dlg-d { margin-top: 14px; font-size: 14.5px; line-height: 1.6; color: var(--serif); white-space: pre-wrap; overflow-wrap: anywhere; }
  .dlg-act { display: flex; align-items: center; gap: 10px; margin-top: 20px; }
  .dlg-act .hero-add { margin-top: 0; }
  .dlg-home { font-size: 14px; color: var(--st-accent); text-decoration: none; }
  .sp { flex: 1; }
  .btn { height: 34px; padding: 0 14px; border-radius: 10px; border: 1px solid var(--st-line); font-size: 14px; color: var(--text); flex: none; transition: background-color .12s ease; }
  .btn.danger { color: #c0392b; }
  .blk-h { margin: 20px 0 8px; font-size: 13px; font-weight: 500; color: var(--st-muted); }
  .blk { border: 1px solid var(--st-line); border-radius: 12px; padding: 4px 14px; }
  .blk.row { display: flex; align-items: center; gap: 12px; padding: 10px 14px; }
  .cfg-st { flex: 1; font-size: 14px; color: var(--serif); }
  .kv { display: flex; align-items: flex-start; gap: 12px; padding: 9px 0; font-size: 14px; }
  .kv + .kv { border-top: 1px solid var(--st-hair, var(--st-line)); }
  .kv .k { width: 88px; flex: none; color: var(--text); }
  .kv .k i { font-style: normal; margin-left: 6px; color: var(--st-muted); font-size: 12.5px; }
  .kv .v { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; gap: 5px; color: var(--serif); overflow-wrap: anywhere; }
  .kv.ag { align-items: center; }
  .kv.ag .k { width: 110px; }
  .kv .v.dim { color: var(--st-muted); font-size: 13px; }
  .kv.dis .k { color: var(--st-muted); }

  .fields { display: flex; flex-direction: column; gap: 14px; margin-top: 18px; }
  .fld { display: flex; flex-direction: column; gap: 6px; }
  .fld.chk { flex-direction: row; flex-wrap: wrap; align-items: center; }
  .fld.chk .fd { flex-basis: 100%; }
  .fl { font-size: 14px; color: var(--text); display: flex; align-items: center; gap: 6px; flex: 1; }
  .fl code { font-size: 12px; color: var(--st-muted); }
  .req { color: var(--cz-warn); font-weight: 500; }
  .fld input:not([type="checkbox"]), .fld select { height: 36px; padding: 0 12px; border: 1px solid var(--st-line); border-radius: 10px; background: var(--st-field); color: var(--text); font: inherit; font-size: 14.5px; outline: 0; }
  .fld input:focus, .fld select:focus { border-color: var(--cz-line-hi); }
  .fld input[type="checkbox"] { width: 18px; height: 18px; accent-color: var(--st-accent); }
  .fd { font-size: 12.5px; line-height: 1.5; color: var(--st-muted); }

  /* 指针环境才有悬停（触屏无 hover，:active 给按下反馈） */
  @media (hover: hover) {
    .tab:not(.on):hover { background: var(--st-hover); color: var(--text); }
    .seg button:not(.on):hover { color: var(--text); }
    .ib:hover { background: var(--st-hover); color: var(--text); }
    .add:hover, .hero-add:not(:disabled):hover { opacity: .86; }
    .menu button:not(:disabled):hover { background: var(--st-hover); }
    .menu button.on:hover { background: var(--st-sel); }
    .card:hover { border-color: var(--cz-line-hi); background: var(--st-hover); }
    .plus:not(:disabled):hover { background: var(--st-sel); border-color: var(--cz-line-hi); }
    .dlg-x:hover, .btn:hover { background: var(--st-hover); color: var(--text); }
    .btn.danger:hover { color: #c0392b; }
    .link:hover, .dlg-home:hover { text-decoration: underline; }
  }
  .tab:active, .ib:active { background: var(--st-sel); }
  .card:active { background: var(--st-hover); }

  /* 正文列窄了（侧栏 + 工作台同开、平板竖屏、手机）：工具条折行、单列卡片、横幅收插画 */
  /* min-width:0 必须写：flex:1 的搜索框里 input 有固有最小宽（约 150px），不写就把排序 / 添加挤出屏外 */
  @container (max-width: 900px) {
    .right { margin-left: 0; width: 100%; }
    .search { flex: 1; width: auto; min-width: 0; }
  }
  @container (max-width: 720px) {
    .in { padding: calc(var(--sat, 0px) + 56px) 16px 40px; }
    .h { font-size: 26px; margin-bottom: 18px; }
    .grid { grid-template-columns: minmax(0, 1fr); }
    .hero { padding: 24px; min-height: 0; }
    .hero-t { font-size: 26px; }
    .hero-art { display: none; }
    .vr { display: none; }
    .left { width: 100%; justify-content: space-between; }
  }
</style>
