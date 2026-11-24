<script>
  // 扩展中心 ·「功能扩展」：bridge 的插件（服务端 src/plugins/，接口 /api/plugins*）。四个区：
  //   插件市场    官方市场（/api/plugins/market，签过名的索引）里还没装的插件，置顶；有更新时页顶列出来——只提示，点了才装。
  //              内置功能也可以换上市场版（盖住内置实现，详情里「恢复内置版」换回）；装的插件可以「回退」到回收区里的上一版。
  //              「社区」切换看社区市场（任何人投稿、只有自动检查）：卡片、详情、风险确认、发布面板在 ext/market/，这里只接线。
  //   Agent      （原来这一页就是它）Media Studio / ChatGPT · Codex / dimensio 三个 agent 扩展（原 ModulesPanel：装卸、更新、agent 总开关）；
  //   功能       随 bridge 发布、默认开着的内置功能（定时任务、分享链接、设备、手机操控、内置浏览器……）按分类排，逐项开关；
  //   第三方插件  装的 zip / 登记的本机目录：开关、重新加载、卸载，「添加」上传 zip 或填本机目录。
  // 点卡片推入详情：状态、按插件 schema 自动生成的配置表单、来源信息与操作。热插件开关 / 改配置当场生效；
  // restart 插件只落盘，顶部出现「有改动等重启生效」。改动经总线 plugins.changed 推给所有在线页面（App 据此重拉 /api/auth，
  // 入口按开关显隐）——这里也听它，别的设备改了就重拉。
  // 插件的显示位：状态块、动作按钮、托管子进程（看日志）、入站回调地址；配置表单在 PluginForm（按 schema 自动生成）。
  // 插件页面：ui.settings 嵌在详情里（PluginFrame，不透明源 iframe），ui.panel 是设置里单独一页（lib/pluginPanels）；
  // 手机 App 一律交给原生另起的干净 WebView（App 的原生桥会注入所有帧，不能嵌在主页面里）。
  import { untrack } from 'svelte';
  import { api, authHeaders } from '../../lib/api.js';
  import { apiUrl } from '../../lib/server.js';
  import { busOn } from '../../lib/bus.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { t, tc, tr, isEn, locale } from '../../lib/i18n.js';
  import { ui } from '../../lib/state.svelte.js';
  import { extensionsNav } from '../../lib/extensionsNav.svelte.js';
  import { openApp, appByKey, appIconUrl } from '../../lib/pluginApps.svelte.js';
  import { pluginUi } from '../../lib/pluginUi.svelte.js';
  import { pluginIcon } from '../../lib/pluginIcons.js';
  import { ic } from './icons.js';
  import ModulesPanel from '../ModulesPanel.svelte';
  import PluginForm from './PluginForm.svelte';
  import PluginFrame from './PluginFrame.svelte';
  import { openPluginStandalone, inAndroidApp, plText } from '../../lib/pluginPanels.svelte.js';
  import { openSettings } from '../../lib/settingsNav.svelte.js';
  import { relTime } from '../../lib/format.js';
  import CommunityDetail from './market/CommunityDetail.svelte';
  import PublishEntry from './market/PublishEntry.svelte';
  import PublishSheet from './market/PublishSheet.svelte';
  import { communityConfirm, ackConfirm, isCommunity, kindText, marketSource, revokedOf, canPublish } from './market/community.js';

  let { toast = () => {}, confirm = async () => true } = $props();

  const errMsg = (e) => tr((e?.body && typeof e.body === 'object' ? e.body.error : typeof e?.body === 'string' ? e.body : '') || e?.message || String(e));

  // 分类：顺序即展示顺序
  const CATS = [
    { key: 'agent-tools', label: t('Claude 的工具'), g: '<path d="M14.6 5.4a3.6 3.6 0 0 0-4.7 4.7l-5.4 5.4a1.6 1.6 0 0 0 2.3 2.3l5.4-5.4a3.6 3.6 0 0 0 4.7-4.7l-2.2 2.2-2.3-.3-.3-2.3z"/>' },
    { key: 'automation', label: t('自动化'), g: '<circle cx="12" cy="12" r="7.5"/><path d="M12 8v4.2l2.8 1.6"/>' },
    { key: 'devices', label: t('设备与手机'), g: '<rect x="3.5" y="5" width="12" height="9" rx="1.5"/><path d="M7 18.5h5M9.5 14v4.5"/><rect x="16.5" y="9" width="4.5" height="9.5" rx="1.2"/>' },
    { key: 'sharing', label: t('分享'), g: '<path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-.8.8"/><path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l.8-.8"/>' },
    { key: 'integration', label: t('对接'), g: '<path d="M9 3.5V8M15 3.5V8"/><path d="M7 8h10v3.2a5 5 0 0 1-10 0z"/><path d="M12 16.2v4.3"/>' },
    { key: 'network', label: t('网络与访问'), g: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16M12 4c2.3 2.3 3.4 5 3.4 8s-1.1 5.7-3.4 8c-2.3-2.3-3.4-5-3.4-8S9.7 6.3 12 4z"/>' },
    { key: 'appearance', label: t('外观'), g: '<path d="M12 4a8 8 0 1 0 0 16c1.2 0 1.8-.8 1.5-1.8-.4-1.1.3-2.2 1.5-2.2H17a3 3 0 0 0 3-3A8 8 0 0 0 12 4z"/><circle cx="8" cy="11" r="1"/><circle cx="11" cy="7.8" r="1"/><circle cx="15" cy="8.6" r="1"/>' },
    // 应用：插件市场 / 已装列表里 category: 'app' 的一类，字形是四格应用图标
    { key: 'app', label: tc('插件', '应用'), g: '<rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/>' },
    { key: 'system', label: t('系统'), g: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/>' },
  ];
  const PLUGIN_G = '<path d="M10 4.5a1.8 1.8 0 1 1 3.6 0H17a1.4 1.4 0 0 1 1.4 1.4v3.3a1.8 1.8 0 1 0 0 3.6v3.3A1.4 1.4 0 0 1 17 17.5h-3.3a1.8 1.8 0 1 0-3.6 0H7a1.4 1.4 0 0 1-1.4-1.4v-3.4a1.8 1.8 0 1 1 0-3.6V5.9A1.4 1.4 0 0 1 7 4.5z"/>';
  const glyph = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CATS.find((c) => c.key === p.category)?.g || PLUGIN_G}</svg>`;
  const SOURCE = { builtin: t('内置'), module: t('agent 扩展'), installed: t('已安装'), local: t('本机目录') };
  // 插件的名称 / 说明 / 面板标题：英文界面优先用插件自带的英文词条（locales/en.json，lib/pluginPanels 的 plText），没有再 tr(中文)
  const pName = (p) => (p ? plText(p, 'name', p.name || p.id) : '');
  const pDesc = (p) => (p ? plText(p, 'description', p.description || '') : '');
  const pPanelTitle = (p) => plText(p, 'ui.panel.title', isEn() && p?.ui?.panel?.titleEn ? p.ui.panel.titleEn : p?.ui?.panel?.title || p?.name || '');

  // ═══ 数据 ═══
  let data = $state(null);
  let loadErr = $state('');
  async function load() {
    try { data = await api.get('/api/plugins'); loadErr = ''; }
    catch (e) { loadErr = errMsg(e); }
  }
  load();
  $effect(() => busOn((ev) => {
    if (ev?.type === 'plugins.changed') untrack(() => { load(); loadMarket(); });
    else if (ev?.type === 'plugins.market') untrack(() => loadMarket());
    // 插件状态块 / 子进程状态实时更新（ctx.status.refresh、子进程起停）
    else if (ev?.type === 'plugins.status' && data) untrack(() => {
      const i = data.plugins.findIndex((p) => p.id === ev.id);
      if (i >= 0) data.plugins[i] = { ...data.plugins[i], panelStatus: ev.panelStatus || null, processes: ev.processes || [], hooks: ev.hooks || [], actions: ev.actions || [],
        schedules: ev.schedules || [], usage: ev.usage || undefined };
    });
    // 页面权限授予 / 撤销（授权框、别的设备、这里的「撤销」）：正看着这个插件的详情就重拉
    else if (ev?.type === 'plugins.grants') untrack(() => { if (selId && ev.plugin === selId && pagePerms) loadGrants(selId); });
  }));
  const apply = (r) => { if (r && Array.isArray(r.plugins)) data = { plugins: r.plugins, restartPending: !!r.restartPending }; };

  const builtins = $derived((data?.plugins || []).filter((p) => p.source === 'builtin'));
  const thirdParty = $derived((data?.plugins || []).filter((p) => p.source === 'installed' || p.source === 'local'));
  // 已装的第三方插件里 category: 'app' 的单独归进「应用」一组，其余照旧一格格排
  const thirdApps = $derived(thirdParty.filter((p) => p.category === 'app'));
  const thirdRest = $derived(thirdParty.filter((p) => p.category !== 'app'));
  const groups = $derived(CATS.map((c) => ({ ...c, items: builtins.filter((p) => p.category === c.key) }))
    .concat([{ key: '_other', label: t('其他'), items: builtins.filter((p) => !CATS.some((c) => c.key === p.category)) }])
    .filter((g) => g.items.length));
  const nameOf = (id) => { const p = (data?.plugins || []).find((x) => x.id === id); return p ? pName(p) : id; };

  function footOf(p) {
    if (revokedOf(p)) return { text: t('已被社区市场下架'), err: true };
    if (p.status === 'error') return { text: t('出错：{reason}', { reason: tr(p.error || '') }), err: true };
    if (p.pendingRestart) return { text: p.enabled ? (p.active ? t('重启后生效') : t('重启后开启')) : t('重启后关闭'), warn: true };
    if (p.status === 'blocked') return { text: t('缺依赖：{names}', { names: p.blockedBy.map(nameOf).join('、') }), warn: true };
    if (p.problems?.length) return { text: t('配置有 {n} 项无效，已用默认值', { n: p.problems.length }), warn: true };
    if (p.override?.pending) return { text: p.override.pending.restore ? t('重启后恢复内置版') : t('重启后换上市场版 v{v}', { v: p.override.pending.install }), warn: true };
    const bits = [];
    if (p.source === 'installed' || p.source === 'local') { if (p.version) bits.push('v' + p.version); bits.push(p.market ? marketSource(p) : SOURCE[p.source]); }
    else bits.push(p.active ? t('已开启') : t('已关闭'));
    if (p.override?.active) bits.push(t('市场版 v{v}', { v: p.override.version }));
    const mx = mktOf(p.id);
    if (mx?.update) return { text: bits.concat(t('有更新 v{v}', { v: mx.latest.version })).join(' · '), upd: true };
    if (p.restart) bits.push(t('改动重启生效'));
    return { text: bits.join(' · ') };
  }

  let busy = $state({});
  async function toggle(p) {
    if (p.locked || busy[p.id] || (revokedOf(p) && !p.enabled)) return;
    busy[p.id] = true;
    try {
      const r = await api.post('/api/plugins/toggle', { id: p.id, enabled: !p.enabled });
      apply(r);
      const np = r.plugin;
      if (np?.status === 'error') toast(t('「{name}」启用失败：{reason}', { name: pName(np), reason: tr(np.error || '') }), true);
      else if (np?.pendingRestart) toast(t('已保存，重启 bridge 后生效'));
    } catch (e) { toast(errMsg(e), true); }
    finally { busy[p.id] = false; }
  }

  // ═══ 详情 ═══
  let selId = $state(null);
  const sel = $derived(selId ? (data?.plugins || []).find((p) => p.id === selId) || null : null);
  $effect(() => { if (selId && data && !sel) selId = null; });   // 卸载了：退回列表
  // 连设置一起直达进来的那个详情（extensionsNav.landing）：系统返回一步收起设置，回到发起的应用页 / 主页。
  // 直接置 false、不走设置外壳的逐级后退（同 nav.js 原生返回收设置层的做法）；人在详情里换了插件或退回过列表就不再算
  let landedId = null;
  $effect(() => {
    if (!selId) return;
    return pushBackLayer(() => {
      if (landedId && landedId === selId) { landedId = null; ui.settingsOpen = false; return; }
      back();
    });
  });

  // ═══ 已授予的页面权限（插件应用页面的 page.chat / page.files）═══
  // 清单声明了页面权限才出这一块；GET /api/plugins/grants 回的是当前使用者自己的授权（{ declared, granted: { 权限: iso } }）。
  // 「撤销」= POST { plugin, perm, allow: false }；授予 / 撤销都会推 plugins.grants，上面的总线分支跟着重拉。
  const pagePerms = $derived(!!sel?.permissions?.some((pm) => typeof pm?.id === 'string' && pm.id.startsWith('page.')));
  let grants = $state(null);   // { plugin, declared, granted, failed? } | null（拉取中）
  let grantsSeq = 0;
  async function loadGrants(id) {
    const my = ++grantsSeq;
    try {
      const g = await api.get('/api/plugins/grants?plugin=' + encodeURIComponent(id));
      if (my !== grantsSeq) return;
      grants = { plugin: id, declared: Array.isArray(g?.declared) ? g.declared : [], granted: g?.granted && typeof g.granted === 'object' ? g.granted : {} };
    } catch { if (my === grantsSeq) grants = { plugin: id, declared: [], granted: {}, failed: true }; }
  }
  // 只跟选中的插件与「声明了页面权限」走；清空、重拉都在 untrack 里（不读写同一个 state）
  $effect(() => {
    const id = selId, want = pagePerms;
    untrack(() => { grantsSeq++; grants = null; if (id && want) loadGrants(id); });
  });
  const grantRows = $derived(grants && grants.plugin === selId
    ? grants.declared.filter((d) => d && grants.granted[d.id]).map((d) => ({ id: d.id, label: d.label, at: Date.parse(grants.granted[d.id]) || 0 }))
    : []);
  async function revokeGrant(p, row) {
    const key = p.id + ':grant:' + row.id;
    if (busy[key]) return;
    // 与设置「页面权限」同一套确认（同样的串）：只有撤销文件权限有连带后果（交出去的文件随之失效）要确认；别的撤了只是下次再问
    if (row.id === 'page.files') {
      const ok = await confirm({
        title: t('撤销「{name}」的文件权限？', { name: pName(p) }),
        desc: t('已经交给页面的文件随之失效：页面里开着的文件读写不了，要再用得重新经你同意。'),
        yes: tc('权限', '撤销'), danger: true,
      });
      if (!ok) return;
    }
    busy[key] = true;
    try {
      await api.post('/api/plugins/grants', { plugin: p.id, perm: row.id, allow: false });
      toast(t('已撤销'));
      loadGrants(p.id);
    } catch (e) { toast(errMsg(e), true); }
    finally { busy[key] = false; }
  }
  let anchor = $state();
  // 进详情回到滚动区顶上（同扩展中心别的详情页的 toTop；scrollIntoView 会把返回按钮藏到吸顶的标题栏底下），
  // 返回列表时回到点进去之前的位置。
  // 滚动容器按「真能滚的那一层」找：手机设置页里离得最近的 .pg-body 本身不滚，按类名找会落空。
  function scroller() {
    for (let el = anchor?.parentElement; el && el !== document.body; el = el.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(el).overflowY)) return el;
    }
    return document.scrollingElement;
  }
  let listScroll = 0;
  function open(p) {
    listScroll = scroller()?.scrollTop || 0;
    selId = p.id;
    queueMicrotask(() => { const sc = scroller(); if (sc) sc.scrollTop = 0; });
  }
  function back() {
    landedId = null;
    selId = null;
    requestAnimationFrame(() => { const sc = scroller(); if (sc) sc.scrollTop = listScroll; });
  }

  // 直达某个插件的详情（lib/extensionsNav 的 openPluginDetail：应用页「⋯ › 插件详情」等）：挂载时和 id / seq 变化时消费。
  // 列表还没拉到先不动（拉到了 data 一变再跑）；拉到了找得到就选中、找不到也清掉，免得之后误选。
  // 只跟 id / seq / data 走，选中与清 id 都在 untrack 里（读写同一 state 的 effect 会自激）。
  // 消费推迟到这一轮更新跑完：人已经在「功能扩展」上时，两套设置外壳会跟着同一个 seq 换 key 重挂 Customize，
  // 这一份在同一轮里就被拆掉——要是它当场把 id 清了，新挂上的那份拿不到，人落在列表上。被拆掉（或 id / data 又变了）时 cleanup 把这次作废
  $effect(() => {
    const id = extensionsNav.id;
    extensionsNav.seq;   // 同一个 id 连点两次也要再跳一次（期间人可能已经退回列表）
    if (!id || !data?.plugins) return;
    let live = true;
    queueMicrotask(() => {
      if (!live) return;
      untrack(() => {
        const list = data?.plugins;
        if (extensionsNav.id !== id || !list) return;
        extensionsNav.id = null;
        const landing = extensionsNav.landing;
        extensionsNav.landing = false;
        const p = list.find((x) => x.id === id);
        if (!p) return;
        landedId = landing ? p.id : null;
        mkId = null; mkFrom = null;   // 正开着市场条目详情：直接换成插件详情
        if (!selId) open(p);
        else if (selId !== p.id) { selId = p.id; queueMicrotask(() => { const sc = scroller(); if (sc) sc.scrollTop = 0; }); }
      });
    });
    return () => { live = false; };
  });

  // ═══ 插件应用（主页图标 + 自己的全屏分页）═══
  // 两个来源：清单 ui.apps 随 /api/plugins 下发（插件关着也有；图标是插件目录里的相对路径 web/…，由 /plugins/<id>/ 提供）；
  // /api/plugins/ui 的 apps（pluginUi.apps）是服务端合并好的现行登记——只有开着的插件、同 id 的 ctx.ui.app 动态登记已盖住清单、
  // 标题按界面语言取好、图标已是 /plugins/<id>/… 的地址，主页图标也读它。所以清单里的每一项先找现行登记、有就用它的标题与图标
  // （插件运行时改了标题 / 图标，这里跟主页一致），找不到（插件关着、或登记还没拉到）才退回清单的静态值；只有动态登记的接在后面。
  const light = $derived(ui.theme === 'light');
  function appsOf(p) {
    if (!p) return [];
    const out = [];
    const seen = new Set();
    const live = new Map(pluginUi.apps.filter((a) => a.plugin === p.id).map((a) => [a.id, a]));
    const fromLive = (key, a) => ({ key, title: a.title || a.id, icon: a.icon || { name: 'plugin' } });
    // 已经是完整地址（/plugins/… 或 http）的原样用，免得拼成两层；相对路径逐段编码（同服务端 assetUrl）
    const abs = (v) => (typeof v !== 'string' || !v ? '' : /^(\/|https?:\/\/)/i.test(v) ? v : '/plugins/' + encodeURIComponent(p.id) + '/' + v.split('/').map(encodeURIComponent).join('/'));
    for (const a of Array.isArray(p.ui?.apps) ? p.ui.apps : []) {
      if (!a?.id || seen.has(a.id)) continue;
      seen.add(a.id);
      const key = 'app:' + p.id + ':' + a.id;
      const cur = live.get(a.id);
      if (cur) { out.push(fromLive(key, cur)); continue; }
      const icon = a.icon && typeof a.icon === 'object' && !a.icon.name ? { light: abs(a.icon.light), dark: abs(a.icon.dark) } : a.icon || { name: 'plugin' };
      // 英文界面：插件自带词条 locales/en.json 的 ui.app.<id>.title 优先，其次清单里的 titleEn
      out.push({ key, title: plText(p, ['ui', 'app', a.id, 'title'], isEn() && a.titleEn ? a.titleEn : a.title || a.id), icon });
    }
    for (const a of live.values()) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      out.push(fromLive(a.key || 'app:' + a.plugin + ':' + a.id, a));
    }
    return out;
  }
  const appIcon = (a) => {
    const src = appIconUrl(a, light);
    return src ? { src } : { svg: pluginIcon(a.icon?.name || 'plugin') };
  };
  // 打开：手机 App 里交给原生干净页（设置留在底下）；其余关掉设置、在主界面里开全屏分页。
  // 刚开插件时应用登记要等总线推 plugins.ui 重拉才到：还没到就留在设置里提示一句，别先把设置关了
  function launchApp(a) {
    if (!appByKey(a.key)) { toast(pluginUi.loaded ? t('应用还没准备好，稍等一下再试') : t('应用列表还在加载，稍等一下再试'), true); return; }
    if (!inAndroidApp()) ui.settingsOpen = false;
    openApp(a.key);
  }
  async function reload(p) {
    busy[p.id] = true;
    try {
      const r = await api.post('/api/plugins/reload', { id: p.id });
      apply(r);
      if (r.plugin?.status === 'error') toast(t('重新加载失败：{reason}', { reason: tr(r.plugin.error || '') }), true);
      else toast(t('已重新加载「{name}」', { name: pName(p) }));
    } catch (e) { toast(errMsg(e), true); }
    finally { busy[p.id] = false; }
  }
  async function uninstall(p) {
    const local = p.source === 'local';
    const ok = await confirm(local
      ? { title: t('取消登记「{name}」？', { name: pName(p) }), desc: t('停用并从列表里移除；目录里的文件不动，随时可以重新登记。'), yes: t('取消登记'), danger: true }
      : { title: t('卸载「{name}」？', { name: pName(p) }), desc: t('停用并移走它的程序文件（留在回收区，可找回）；它存的数据（plugin-data）不删。'), yes: t('卸载'), danger: true });
    if (!ok) return;
    try { apply(await api.post('/api/plugins/uninstall', { id: p.id })); selId = null; toast(local ? t('已取消登记') : t('已卸载')); }
    catch (e) { toast(errMsg(e), true); }
  }
  // 面板：网页 / 桌面在设置里单独一页（侧栏「插件」组）；手机 App 交给原生的干净页面。
  function openPanel(p) {
    if (inAndroidApp()) { standalone(p, 'panel'); return; }
    openSettings('plg-' + p.id);
  }
  async function standalone(p, which) {
    try { await openPluginStandalone(p.id, { which, title: pPanelTitle(p) }); }
    catch (e) { toast(errMsg(e), true); }
  }

  // 动作按钮（ctx.action）
  async function runAct(p, a) {
    if (busy[p.id + ':' + a.id]) return;
    if (a.confirm || a.danger) {
      const ok = await confirm({ title: tr(a.label) + '？', desc: tr(a.confirm || a.desc || ''), yes: tr(a.label), danger: !!a.danger });
      if (!ok) return;
    }
    busy[p.id + ':' + a.id] = true;
    try {
      const r = await api.post('/api/plugins/action', { id: p.id, action: a.id });
      if (r.plugin && data) { const i = data.plugins.findIndex((x) => x.id === p.id); if (i >= 0) data.plugins[i] = r.plugin; }
      toast(r.message ? tr(r.message) : t('已执行「{name}」', { name: tr(a.label) }));
    } catch (e) { toast(errMsg(e), true); }
    finally { busy[p.id + ':' + a.id] = false; }
  }

  // 日志查看层：子进程日志（name=子进程名）与插件自己的日志（name=plugin，ctx.log / warn / error）共用
  let logOf = $state(null);   // { name, lines, state, plugin?, level? }——plugin 有值 = 插件自己的日志
  let logBusy = $state(false);
  $effect(() => { if (!logOf) return; return pushBackLayer(() => { logOf = null; }); });
  async function showLog(p, proc) {
    try { const r = await api.get('/api/plugins/log?id=' + encodeURIComponent(p.id) + '&name=' + encodeURIComponent(proc.name) + '&lines=300'); logOf = { name: proc.name, lines: r.lines || [], state: r.state }; }
    catch (e) { toast(errMsg(e), true); }
  }
  // 插件日志：服务端给的 lines 是中文区域格式，这里按界面语言从 entries 重排一遍；level='warn' 只看警告和错误
  const logLine = (e) => {
    let at = '';
    try { at = new Date(e.t).toLocaleString(locale(), { hour12: false }); } catch {}
    return `${at} ${e.level && e.level !== 'info' ? String(e.level).toUpperCase() + ' ' : ''}${e.text}`;
  };
  async function showPluginLog(p, level = '') {
    if (logBusy) return;
    logBusy = true;
    try {
      const r = await api.get('/api/plugins/log?id=' + encodeURIComponent(p.id) + '&name=plugin&lines=300' + (level ? '&level=' + level : ''));
      const lines = Array.isArray(r.entries) ? r.entries.map(logLine) : r.lines || [];
      logOf = { name: 'plugin', plugin: p, level, lines };
    } catch (e) { toast(errMsg(e), true); }
    finally { logBusy = false; }
  }
  const PROC_STATE = { starting: t('启动中'), running: t('运行中'), backoff: t('等待重启'), stopped: t('已停止'), failed: t('失败'), unhealthy: t('健康检查不过，已不再自动重启') };
  const procTone = (st) => (st === 'running' ? 'ok' : st === 'failed' || st === 'unhealthy' ? 'crit' : st === 'stopped' ? '' : 'warn');
  // 子进程健康检查（process 的 health 选项）：ok null = 还没查过（启动后宽限期内）
  const healthTag = (h) => (h.ok === true ? t('健康') : h.ok === false ? t('不健康') : t('待检查'));
  // 定时任务：下次运行（一小时内说「N 分钟后」，再远写本地时间）、上次结果
  const soon = (ms) => { const d = ms - Date.now(); return d < 60000 ? t('马上') : d < 3600000 ? t('{n} 分钟后', { n: Math.round(d / 60000) }) : when(ms); };
  const schTone = (s) => (!s.enabled ? '' : s.running ? 'warn' : s.lastOk === false ? 'crit' : s.lastOk ? 'ok' : '');
  const usd = (n) => '$' + (Number(n) || 0).toFixed(2);
  async function copyText(s) { try { await navigator.clipboard.writeText(s); toast(t('已复制')); } catch { toast(s); } }

  // ═══ 添加 ═══
  let fileInput;
  let uploading = $state(false);
  async function upload(file) {
    if (!file) return;
    if (!/\.zip$/i.test(file.name)) { toast(t('插件包是 .zip 文件'), true); return; }
    uploading = true;
    try {
      const res = await fetch(apiUrl('/api/plugins/install'), { method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/zip' }, body: file });
      let r = null; try { r = await res.json(); } catch {}
      if (!res.ok) throw new Error(r?.error || 'HTTP ' + res.status);
      apply(r);
      const p = r.plugin;
      if (p?.status === 'error') toast(t('已安装「{name}」，但启用失败：{reason}', { name: pName(p), reason: tr(p.error || '') }), true);
      else toast(p?.pendingRestart ? t('已更新「{name}」，重启 bridge 后生效', { name: pName(p) }) : t('已安装「{name}」', { name: pName(p) }));
    } catch (e) { toast(tr(e?.message || String(e)), true); }
    finally { uploading = false; }
  }
  let linkOpen = $state(false);
  let linkPath = $state('');
  let linkErr = $state('');
  let linking = $state(false);
  $effect(() => { if (!linkOpen) return; return pushBackLayer(() => { linkOpen = false; }); });
  async function link() {
    if (!linkPath.trim() || linking) return;
    linking = true; linkErr = '';
    try {
      const r = await api.post('/api/plugins/install', { path: linkPath.trim() });
      apply(r);
      linkOpen = false; linkPath = '';
      if (r.plugin?.status === 'error') toast(t('已登记「{name}」，但启用失败：{reason}', { name: pName(r.plugin), reason: tr(r.plugin.error || '') }), true);
      else toast(t('已登记「{name}」', { name: pName(r.plugin) }));
    } catch (e) { linkErr = errMsg(e); }
    finally { linking = false; }
  }

  // ═══ 从 GitHub 装 / 检查更新 ═══
  let ghOpen = $state(false);
  let ghRepo = $state('');
  let ghErr = $state('');
  let ghBusy = $state(false);
  $effect(() => { if (!ghOpen) return; return pushBackLayer(() => { ghOpen = false; }); });
  async function installGh(repo, { quiet = false } = {}) {
    if (!String(repo || '').trim() || ghBusy) return;
    ghBusy = true; ghErr = '';
    try {
      const r = await api.post('/api/plugins/install', { github: String(repo).trim() });
      apply(r);
      ghOpen = false; ghRepo = '';
      const p = r.plugin;
      if (p?.status === 'error') toast(t('已安装「{name}」，但启用失败：{reason}', { name: pName(p), reason: tr(p.error || '') }), true);
      else toast(p?.pendingRestart ? t('已更新「{name}」，重启 bridge 后生效', { name: pName(p) }) : t('已安装「{name}」', { name: pName(p) }));
    } catch (e) { if (quiet) toast(errMsg(e), true); else ghErr = errMsg(e); }
    finally { ghBusy = false; }
  }
  async function checkUpd(p) {
    busy[p.id + ':upd'] = true;
    try {
      const r = await api.get('/api/plugins/update?id=' + encodeURIComponent(p.id));
      if (r.pinned) { toast(t('钉在 {ref}，不跟新版', { ref: r.pinned })); return; }
      if (!r.newer) { toast(t('已经是最新版（v{v}）', { v: r.current || '?' })); return; }
      const ok = await confirm({ title: t('更新「{name}」到 v{v}？', { name: pName(p), v: r.latest || r.tag }), desc: t('从 {repo} 下载最新 Release 覆盖安装，旧版留在回收区。', { repo: p.github.github }), yes: t('更新') });
      if (ok) await installGh(p.github.github, { quiet: true });
    } catch (e) { toast(errMsg(e), true); }
    finally { busy[p.id + ':upd'] = false; }
  }

  // ═══ 插件市场 ═══（plugins/market.mjs：官方签名索引；更新只提示，用户点了才装）
  let mkt = $state(null);
  let mktErr = $state('');
  let mktBusy = $state(false);
  async function loadMarket(refresh = false) {
    if (refresh) mktBusy = true;
    try { mkt = await api.get('/api/plugins/market' + (refresh ? '?refresh=1' : '')); mktErr = ''; }
    catch (e) { mktErr = errMsg(e); }
    finally { mktBusy = false; }
  }
  loadMarket();
  // 社区一块：老服务端没有 community 字段，那就不出「官方 / 社区」切换
  const cmkt = $derived(mkt?.community || null);
  const mktAll = $derived([...(mkt?.plugins || []), ...(cmkt?.plugins || [])]);
  // 同 id 两边都有时（社区装的，官方后来也上了）取不是 taken 的那条——它才是这个已装插件所属的通道
  const mktOf = (id, ch = '') => {
    const xs = mktAll.filter((x) => x.id === id && (!ch || x.channel === ch));
    return xs.find((x) => x.state !== 'taken') || xs[0] || null;
  };
  const mktUpdates = $derived(mktAll.filter((x) => x.update));
  let mktTab = $state('official');
  const mktNew = $derived((mktTab === 'community' ? cmkt?.plugins || [] : mkt?.plugins || []).filter((x) => !x.builtin && x.state === 'none'));
  // 市场分类筛选：全部 / 应用 / 其它；索引里 category: 'app' 的算应用（服务端 normalizeIndex 保留 category）；官方、社区共用
  let mktCat = $state('all');
  const mktShown = $derived(mktCat === 'all' ? mktNew : mktNew.filter((x) => (x.category === 'app') === (mktCat === 'app')));
  // 应用类卡片的图标：索引只认 https 地址（服务端已滤，这里再挡一道）；加载失败的记下来退回分类字形
  let mkIconBad = $state({});
  // 社区条目不加载作者给的远程图标：没人审过，一张图就能拿到每个打开这页的人的 IP
  const mkIcon = (x) => (x && !isCommunity(x) && x.category === 'app' && typeof x.icon === 'string' && /^https:\/\//i.test(x.icon) && !mkIconBad[x.id] ? x.icon : '');
  const mkIconFail = (x) => { mkIconBad = { ...mkIconBad, [x.id]: true }; };
  const mName = (x) => (isEn() && x.nameEn ? x.nameEn : tr(x.name));
  const mDesc = (x) => (isEn() && x.descriptionEn ? x.descriptionEn : tr(x.description || ''));
  const kb = (n) => (n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
  const when = (ms) => { try { return new Date(ms).toLocaleString(locale(), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };
  // 更新说明当一句话用：没收尾标点就补一个，后面还要接别的句子
  const sentence = (s) => { const x = String(s || '').trim(); return /[。.!！?？]$/.test(x) ? x : x + (isEn() ? '.' : '。'); };
  const cmpVer = (a, b) => {
    const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) < (y[i] || 0) ? -1 : 1;
    return 0;
  };

  // 装 / 更新 / 装指定版本：先确认（标题写清版本，说明里带更新内容）
  async function mktInstall(x, version = '') {
    const v = version || x.latest?.version;
    if (!v) return;
    const ve = x.versions.find((y) => y.version === v) || x.latest;
    const has = x.state === 'installed' || (x.builtin && !!x.current);
    const down = has && x.current && cmpVer(v, x.current) < 0;
    if (isCommunity(x)) {
      const ask = communityConfirm({ name: mName(x), v, publisher: x.publisher, kind: ve?.kind, caps: ve?.caps, notes: ve?.notes, restart: ve?.restart, has, down });
      if (await confirm(ask)) await mktPost(x, v, { has });
      return;
    }
    const title = x.builtin
      ? (has ? t('把「{name}」换成市场版 v{v}？', { name: mName(x), v }) : t('给「{name}」换上市场版 v{v}？', { name: mName(x), v }))
      : !has ? t('安装「{name}」v{v}？', { name: mName(x), v })
      : down ? t('把「{name}」降到 v{v}？', { name: mName(x), v }) : t('把「{name}」更新到 v{v}？', { name: mName(x), v });
    const desc = [ve?.notes ? t('这一版：{notes}', { notes: sentence(tr(ve.notes)) }) : '',
      x.builtin ? t('市场版会盖住随 bridge 发布的内置实现；它起不来会自动退回内置版，也可以随时「恢复内置版」。') : has ? t('旧版留在回收区，可以随时回退。') : t('插件和 bridge 同进程运行，这是 bridge 官方发布、验过签名的插件。'),
      ve?.restart ? t('要重启 bridge 才生效。') : ''].filter(Boolean).join(' ');
    if (!(await confirm({ title, desc, yes: x.builtin || has ? (down ? t('降级') : t('更新')) : t('安装') }))) return;
    await mktPost(x, v, { has });
  }
  // 社区的在确认框里点过同意才走到这里，所以总带 ack；服务端仍回 428（索引中途换了）就照它给的风险信息再问一次
  async function mktPost(x, v, { has }) {
    busy['mk:' + x.id] = true;
    try {
      const body = isCommunity(x) ? { id: x.id, version: v, channel: 'community', ack: true } : { id: x.id, version: v };
      let r;
      try { r = await api.post('/api/plugins/market/install', body); }
      catch (e) {
        const need = e?.status === 428 && e.body && typeof e.body === 'object' ? e.body.needAck : null;
        if (!need) throw e;
        if (!(await confirm(ackConfirm(need, { has, down: has && x.current && cmpVer(need.version || v, x.current) < 0 })))) return;
        r = await api.post('/api/plugins/market/install', { ...body, version: need.version || v });
      }
      apply(r);
      await loadMarket();
      const p = r.plugin;
      if (p?.override?.error) toast(tr(p.override.error), true);
      else if (p?.status === 'error') toast(t('已安装「{name}」，但启用失败：{reason}', { name: mName(x), reason: tr(p.error || '') }), true);
      else if (p?.pendingRestart || p?.override?.pending) toast(t('已下载 v{v}，重启 bridge 后生效', { v }));
      else if (x.builtin) toast(t('「{name}」已换上市场版 v{v}', { name: mName(x), v }));
      else if (has) toast(t('「{name}」已换成 v{v}', { name: mName(x), v }));
      else toast(t('已安装「{name}」v{v}', { name: mName(x), v }));
    } catch (e) { toast(errMsg(e), true); }
    finally { busy['mk:' + x.id] = false; }
  }
  // 回收区里那一份可能比现在的新（回退过一次又想换回来）：那就叫「换回」
  const rbNewer = (p) => cmpVer(p.rollbackTo, p.override?.version || p.version || '0') > 0;
  const rbLabel = (p) => (rbNewer(p) ? t('换回 v{v}', { v: p.rollbackTo }) : t('回退到 v{v}', { v: p.rollbackTo }));
  async function rollback(p) {
    if (!(await confirm({ title: rbNewer(p) ? t('「{name}」换回 v{v}？', { name: pName(p), v: p.rollbackTo }) : t('「{name}」回退到 v{v}？', { name: pName(p), v: p.rollbackTo }), desc: t('换回回收区里的上一版；现在这一版也留在回收区，可以再换回来。'), yes: t('回退') }))) return;
    busy[p.id + ':rb'] = true;
    try {
      const r = await api.post('/api/plugins/rollback', { id: p.id });
      apply(r);
      await loadMarket();
      toast(r.plugin?.pendingRestart || r.plugin?.override?.pending ? t('已换好，重启 bridge 后生效') : t('已换成 v{v}', { v: p.rollbackTo }));
    } catch (e) { toast(errMsg(e), true); }
    finally { busy[p.id + ':rb'] = false; }
  }
  async function restoreBuiltin(p) {
    if (!(await confirm({ title: t('「{name}」恢复内置版？', { name: pName(p) }), desc: t('市场版移进回收区，换回随 bridge 发布的内置实现；这一版市场版之后不再提示更新。'), yes: t('恢复内置版') }))) return;
    busy[p.id + ':rb'] = true;
    try {
      const r = await api.post('/api/plugins/restore-builtin', { id: p.id });
      apply(r);
      await loadMarket();
      toast(r.plugin?.pendingRestart || r.plugin?.override?.pending ? t('重启 bridge 后恢复内置版') : t('已恢复内置版'));
    } catch (e) { toast(errMsg(e), true); }
    finally { busy[p.id + ':rb'] = false; }
  }

  // 市场条目详情（和插件详情同一套推入 / 返回）
  let mkId = $state(null);
  let mkCh = $state('');
  const mkSel = $derived(mkId ? mktOf(mkId, mkCh) : null);
  $effect(() => { if (!mkId) return; return pushBackLayer(() => mkBack()); });
  let mkFrom = $state(null);   // 从插件详情点进来的：返回时回到那个详情
  function openMk(x) {
    if (selId) { mkFrom = selId; selId = null; } else { mkFrom = null; listScroll = scroller()?.scrollTop || 0; }
    mkId = x.id; mkCh = x.channel || '';
    queueMicrotask(() => { const sc = scroller(); if (sc) sc.scrollTop = 0; });
  }
  function mkBack() {
    mkId = null;
    if (mkFrom) { selId = mkFrom; mkFrom = null; return; }
    requestAnimationFrame(() => { const sc = scroller(); if (sc) sc.scrollTop = listScroll; });
  }
  // 发布到社区（插件详情推入的一层；面板自己挂返回层，关掉后 pubSeq 变一下让详情里的投稿状态重查）
  let pubOpen = $state(false);
  let pubSeq = $state(0);
  let detailScroll = 0;
  // 换了插件（直达别的详情、退回列表、卸载）就收起，免得面板挂在别的插件上
  $effect(() => { selId; untrack(() => { pubOpen = false; }); });
  function openPublish() {
    detailScroll = scroller()?.scrollTop || 0;
    pubOpen = true;
    queueMicrotask(() => { const sc = scroller(); if (sc) sc.scrollTop = 0; });
  }
  function closePublish() {
    pubOpen = false; pubSeq++;
    requestAnimationFrame(() => { const sc = scroller(); if (sc) sc.scrollTop = detailScroll; });
  }
  // 市场条目对应的已装插件 / 内置功能：进它的详情
  function openInstalled(x) {
    const p = (data?.plugins || []).find((y) => y.id === x.id);
    mkId = null; mkFrom = null;
    if (p) open(p);
  }

  // ═══ 重启 ═══（同 ModulesPanel：先交给守护进程空闲重启；没有守护进程时桌面壳退回重拉本地运行时）
  let restarting = $state(false);
  async function restart() {
    restarting = true;
    const rt = typeof window !== 'undefined' ? window.BridgeDesktop?.runtime : null;
    try {
      try { await api.post('/api/admin/service/restart', { mode: 'idle' }); toast(t('将在空闲时重启（没有在跑的对话时）')); return; }
      catch (e) { if (!rt?.restart) throw e; }
      await rt.restart();
    } catch (e) { toast(errMsg(e), true); }
    finally { restarting = false; }
  }
</script>

<span class="pp-anchor" bind:this={anchor} aria-hidden="true"></span>
<input bind:this={fileInput} type="file" accept=".zip" hidden onchange={(e) => { upload(e.currentTarget.files?.[0]); e.currentTarget.value = ''; }} />

{#snippet card(p)}
  {@const f = footOf(p)}
  <div class="cz-card" class:off={!p.active} role="button" tabindex="0" onclick={() => open(p)} onkeydown={(ev) => { if (ev.key === 'Enter') open(p); }}>
    <span class="cz-tile">{@html glyph(p)}</span>
    <div class="cz-body">
      <b class="cz-name">{pName(p)}</b>
      <p class="cz-desc">{pDesc(p)}</p>
      <span class="cz-foot" class:err={f.err} class:pp-warn={f.warn} class:pp-upd-foot={f.upd}>{f.text}</span>
    </div>
    {#if !p.locked}
      <button class="cz-sw" class:on={p.enabled} role="switch" aria-checked={p.enabled} disabled={busy[p.id] || (!!revokedOf(p) && !p.enabled)}
        onclick={(ev) => { ev.stopPropagation(); toggle(p); }} aria-label={t('启用 {name}', { name: pName(p) })}><span></span></button>
    {/if}
  </div>
{/snippet}

{#if sel}
  {@const f = footOf(sel)}
  {@const mx = mktOf(sel.id)}
  {@const runOn = sel.active && !!(sel.panelStatus || sel.processes?.length || sel.actions?.length || sel.hooks?.length)}
  <!-- 日志行：有记录就给；第三方插件开着时也给（hasLogs 是拉列表那一刻的，之后才记的看不到）。内置功能没记录就不占地方 -->
  {@const logOn = !!(sel.hasLogs || (sel.active && (sel.source === 'installed' || sel.source === 'local')))}
  {@const apps = appsOf(sel)}
  {@const rv = revokedOf(sel)}
  <div class="pp-detail" class:pp-hide={pubOpen}>
    <div class="cz-crumb"><button class="cz-back" onclick={back}>{@html ic('back', 2)}<span>{t('功能扩展')}</span></button></div>
    <div class="cz-dh">
      <span class="cz-tile lg">{@html glyph(sel)}</span>
      <div class="cz-dh-tx">
        <h2>{pName(sel)}</h2>
        <p>{sel.market ? marketSource(sel) : SOURCE[sel.source] || sel.source}{sel.override?.active ? ' · ' + t('市场版 v{v}', { v: sel.override.version }) : sel.version ? ' · v' + sel.version : ''}{sel.author ? ' · ' + sel.author : ''}</p>
      </div>
      {#if !sel.locked}
        <button class="cz-sw" class:on={sel.enabled} role="switch" aria-checked={sel.enabled} disabled={busy[sel.id] || (!!rv && !sel.enabled)} onclick={() => toggle(sel)} aria-label={t('启用 {name}', { name: pName(sel) })}><span></span></button>
      {/if}
    </div>
    {#if rv}<div class="cz-diag err">{t('已被社区市场下架：{reason}。已自动停用，不能再启用；可以卸载，或在社区市场里装没被下架的版本。', { reason: tr(rv.reason || t('没写原因')).replace(/[。.]$/, '') })}</div>{/if}
    {#if sel.description}<p class="cz-lead">{pDesc(sel)}</p>{/if}
    {#if (f.err || f.warn) && !rv}<div class="pp-state" class:err={f.err}>{f.text}</div>{/if}
    {#if sel.problems?.length}<div class="pp-state">{#each sel.problems as pr}<div>{tr(pr)}</div>{/each}</div>{/if}
    {#if sel.override?.error}<div class="pp-state">{tr(sel.override.error)}</div>{/if}
    <!-- 清单体检：不拒装，只提示（插件作者看的，低调些） -->
    {#if sel.lint?.length}
      <div class="pp-state pp-hint">
        <div class="pp-hint-h">{t('清单体检：{n} 条提示', { n: sel.lint.length })}</div>
        <ul>{#each sel.lint as l}<li>{tr(l)}</li>{/each}</ul>
      </div>
    {/if}

    {#if mx || sel.rollbackTo || sel.override}
      <div class="cz-sec">{t('版本')}</div>
      <div class="cz-list">
        {#if mx?.update}
          <button class="cz-li act" disabled={busy['mk:' + mx.id]} onclick={() => mktInstall(mx)}><span class="cz-li-tx"><span class="pp-updtx">{busy['mk:' + mx.id] ? t('正在更新…') : mx.builtin && !mx.current ? t('换上市场版 v{v}', { v: mx.latest.version }) : t('更新到 v{v}', { v: mx.latest.version })}</span><small>{mx.latest.notes ? tr(mx.latest.notes) : isCommunity(mx) ? t('社区市场有新版本') : t('插件市场有新版本')}</small></span></button>
        {/if}
        {#if mx}<button class="cz-li act" onclick={() => openMk(mx)}><span class="cz-li-tx"><span>{isCommunity(mx) ? t('社区市场里的版本') : t('插件市场里的版本')}</span><small>{t('{n} 个版本 · 可以装指定版本', { n: mx.versions.length })}</small></span></button>{/if}
        {#if sel.rollbackTo}<button class="cz-li act" disabled={busy[sel.id + ':rb']} onclick={() => rollback(sel)}><span class="cz-li-tx"><span>{rbLabel(sel)}</span><small>{t('换回回收区里的上一版')}</small></span></button>{/if}
        {#if sel.override && !sel.override.pending?.restore}<button class="cz-li act danger" disabled={busy[sel.id + ':rb']} onclick={() => restoreBuiltin(sel)}><span class="cz-li-tx"><span>{t('恢复内置版')}</span><small>{t('不用市场版，换回随 bridge 发布的内置实现')}</small></span></button>{/if}
      </div>
    {/if}
    {#if sel.locked && sel.source === 'module'}<p class="cz-note">{t('agent 扩展的开关在上面的「Agent」区（或设置里的 Agent 页）。')}</p>{/if}

    <!-- 能力声明（清单 permissions）：展示用，不强制 -->
    {#if sel.permissions?.length}
      <div class="cz-sec">{t('这个插件会')}</div>
      <div class="cz-list">
        {#each sel.permissions as pm (pm.id)}
          <div class="cz-kv pp-perm"><b>{tr(pm.label)}</b></div>
        {/each}
      </div>
    {/if}

    <!-- 已授予的页面权限：你在应用页面的授权框里点过「允许」的，随时可以撤销（授权按使用者各算各的） -->
    {#if pagePerms}
      <div class="cz-sec">{t('已授予的页面权限')}</div>
      <div class="cz-list">
        {#if !grants}
          <div class="cz-li"><span class="cz-li-tx"><small>{t('载入中…')}</small></span></div>
        {:else if grants.failed}
          <div class="cz-li"><span class="cz-li-tx"><small>{t('授权记录没读出来')}</small></span><button class="cz-btn sm" onclick={() => loadGrants(sel.id)}>{t('重试')}</button></div>
        {:else if !grantRows.length}
          <div class="cz-li"><span class="cz-li-tx"><small>{t('还没有授予过。应用页面要用到时会先问你。')}</small></span></div>
        {:else}
          {#each grantRows as g (g.id)}
            <div class="cz-li">
              <span class="cz-li-tx"><span>{tr(g.label)}</span><small>{g.at ? t('{at}授予', { at: relTime(g.at) }) : t('已授予')}</small></span>
              <button class="cz-btn sm" disabled={busy[sel.id + ':grant:' + g.id]} onclick={() => revokeGrant(sel, g)}>{tc('权限', '撤销')}</button>
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    {#if runOn || logOn}
      <div class="cz-sec">{t('运行状态')}</div>
      <div class="cz-list">
        {#if runOn && sel.panelStatus}
          <div class="pp-st">
            <span class="pp-dot {sel.panelStatus.tone}"></span>
            <span class="pp-st-tx">{tr(sel.panelStatus.text || '')}</span>
          </div>
          {#each sel.panelStatus.items || [] as it}
            <div class="cz-kv"><span>{tr(it.label)}</span><b class:pp-tone-warn={it.tone === 'warn'} class:pp-tone-crit={it.tone === 'error'}>{tr(it.value)}</b></div>
          {/each}
        {/if}
        {#each runOn ? sel.processes || [] : [] as proc (proc.name)}
          <button class="cz-li act" onclick={() => showLog(sel, proc)}>
            <span class="cz-li-tx"><span><span class="pp-dot {procTone(proc.state)}"></span>{t('子进程')} {proc.name}{#if proc.health}<span class="pp-tag" class:pp-tag-ok={proc.health.ok === true} class:pp-tag-bad={proc.health.ok === false}>{healthTag(proc.health)}</span>{/if}</span>
              <small>{PROC_STATE[proc.state] || proc.state}{proc.pid ? ' · pid ' + proc.pid : ''}{proc.restarts ? ' · ' + t('重启 {n} 次', { n: proc.restarts }) : ''}{proc.health?.restarts ? ' · ' + t('健康检查不过已重启 {n} 次', { n: proc.health.restarts }) : ''}{proc.lastExit != null && proc.state !== 'running' && proc.state !== 'unhealthy' ? ' · ' + t('上次退出 {code}', { code: proc.lastExit }) : ''} · {t('点开看日志')}</small>
              {#if proc.health && proc.health.ok === false && proc.health.lastError}<small class="pp-wrap pp-tone-crit">{t('健康检查：{reason}', { reason: tr(proc.health.lastError) })}{proc.health.fails ? ' · ' + t('连续 {n} 次不过', { n: proc.health.fails }) : ''}</small>{/if}</span>
          </button>
        {/each}
        {#if logOn}
          <button class="cz-li act" disabled={logBusy} onclick={() => showPluginLog(sel)}>
            <span class="cz-li-tx"><span>{t('插件日志')}</span>
              <small>{sel.hasLogs ? t('插件自己记的日志（ctx.log / warn / error）') : t('还没有记录')} · {t('点开看日志')}</small></span>
          </button>
        {/if}
        {#each runOn ? sel.hooks || [] : [] as h (h.path)}
          <button class="cz-li act" onclick={() => copyText(h.path)}>
            <span class="cz-li-tx"><span>{t('回调地址')} <span class="pp-mono">{h.methods.join('/')} {h.path}</span></span>
              <small>{h.verify.map((v) => ({ loopback: t('只收本机直连'), secret: t('共享密钥'), hmac: t('HMAC 签名') }[v] || v)).join(' · ')} · {t('点一下复制')}</small></span>
          </button>
        {/each}
      </div>
      {#if runOn && sel.actions?.length}
        <div class="pp-actbar">
          {#each sel.actions as a (a.id)}
            <button class="cz-btn" class:pp-danger={a.danger} disabled={busy[sel.id + ':' + a.id]} title={tr(a.desc || '')} onclick={() => runAct(sel, a)}>{tr(a.label)}</button>
          {/each}
        </div>
      {/if}
    {/if}

    <!-- 定时任务（ctx.schedule）：开发实例上默认不跑（enabled=false） -->
    {#if sel.active && sel.schedules?.length}
      <div class="cz-sec">{t('定时任务')}</div>
      <div class="cz-list">
        {#each sel.schedules as s (s.name)}
          <div class="cz-li">
            <span class="cz-li-tx"><span><span class="pp-dot {schTone(s)}"></span>{tr(s.label || s.name)}</span>
              <small>{tr(s.when || '')}{s.running ? ' · ' + t('正在运行') : !s.enabled ? ' · ' + t('开发实例不跑') : s.next ? ' · ' + t('下次 {at}', { at: soon(s.next) }) : ''}</small>
              {#if s.lastRun}
                <small class="pp-wrap" class:pp-tone-crit={s.lastOk === false}>{t('上次 {at}', { at: relTime(s.lastRun) })}{s.lastOk === true ? ' · ' + t('成功') : s.lastOk === false ? ' · ' + (s.lastError ? t('失败：{reason}', { reason: tr(s.lastError) }) : t('失败')) : ''}</small>
              {/if}
            </span>
          </div>
        {/each}
      </div>
    {/if}

    <!-- 用量：用过 ctx.chat 的插件才有（核心记账） -->
    {#if sel.usage}
      <div class="cz-sec">{t('用量')}</div>
      <div class="cz-list">
        <div class="cz-kv"><span>{t('今天')}</span><b>{t('{n} 轮', { n: sel.usage.today?.turns || 0 })} · {usd(sel.usage.today?.costUsd)}</b></div>
        <div class="cz-kv"><span>{t('累计')}</span><b>{t('{n} 轮', { n: sel.usage.total?.turns || 0 })} · {usd(sel.usage.total?.costUsd)}</b></div>
      </div>
    {/if}

    <!-- 插件应用：主页上那枚图标的同一个应用，这里也能直接打开（插件关着时打不开：应用只在插件开着时登记） -->
    {#if apps.length}
      <div class="cz-sec">{tc('插件', '应用')}</div>
      <div class="cz-list">
        {#each apps as a (a.key)}
          {@const aic = appIcon(a)}
          <div class="cz-li">
            <span class="cz-tile sm pp-app-ic" aria-hidden="true">{#if aic.src}<img src={aic.src} alt="" draggable="false" />{:else}{@html aic.svg}{/if}</span>
            <span class="cz-li-tx"><span>{a.title}</span>{#if !sel.active}<small>{t('插件开着才能打开')}</small>{/if}</span>
            <button class="cz-btn sm" disabled={!sel.active} onclick={() => launchApp(a)}>{t('打开')}</button>
          </div>
        {/each}
      </div>
    {/if}

    {#if sel.ui?.panel && sel.active}
      <div class="cz-list pp-gap">
        <button class="cz-li act" onclick={() => openPanel(sel)}><span class="cz-li-tx"><span>{t('打开「{name}」', { name: pPanelTitle(sel) })}</span><small>{t('插件自己的控制面板')}</small></span></button>
        {#if !inAndroidApp()}<button class="cz-li act" onclick={() => standalone(sel, 'panel')}><span class="cz-li-tx"><span>{t('在新窗口打开')}</span></span></button>{/if}
      </div>
    {/if}

    <PluginForm plugin={sel} {toast} {confirm} onSaved={(r) => apply(r)} />

    {#if sel.ui?.settings && sel.active}
      <div class="cz-sec">{t('更多设置')}</div>
      {#if inAndroidApp()}
        <div class="cz-list"><button class="cz-li act" onclick={() => standalone(sel, 'settings')}><span class="cz-li-tx"><span>{t('打开设置页')}</span><small>{t('插件自带的设置页面')}</small></span></button></div>
      {:else}
        {#key sel.id}<div class="pp-embed"><PluginFrame id={sel.id} page={sel.ui.settings} mode="embed" /></div>{/key}
      {/if}
    {/if}

    <div class="cz-sec">{t('信息')}</div>
    <div class="cz-list">
      <div class="cz-kv"><span>ID</span><b>{sel.id}</b></div>
      <div class="cz-kv"><span>{t('来源')}</span><b>{sel.market ? marketSource(sel) + ' · v' + sel.market.version : sel.override?.active ? t('内置 · 市场版 v{v}', { v: sel.override.version }) : SOURCE[sel.source] || sel.source}</b></div>
      {#if sel.dir}<div class="cz-kv"><span>{t('目录')}</span><b class="pp-mono">{sel.dir}</b></div>{/if}
      {#if sel.requires?.length}<div class="cz-kv"><span>{t('依赖')}</span><b>{sel.requires.map(nameOf).join('、')}</b></div>{/if}
      <div class="cz-kv"><span>{t('生效方式')}</span><b>{sel.restart ? t('改开关 / 配置后重启 bridge 生效') : t('改了当场生效')}</b></div>
      {#if sel.homepage}<a class="cz-kv link" href={sel.homepage} target="_blank" rel="noopener"><span>{t('主页')}</span><b>{sel.homepage}</b>{@html ic('link')}</a>{/if}
    </div>

    {#if sel.source === 'installed' || sel.source === 'local'}
      <div class="cz-list pp-gap">
        {#if sel.github}<button class="cz-li act" disabled={busy[sel.id + ':upd']} onclick={() => checkUpd(sel)}><span class="cz-li-tx"><span>{t('检查更新')}</span><small>github.com/{sel.github.github}{sel.github.ref ? '@' + sel.github.ref : ''}</small></span></button>{/if}
        {#if !sel.restart}<button class="cz-li act" disabled={busy[sel.id]} onclick={() => reload(sel)}><span class="cz-li-tx"><span>{t('重新加载')}</span><small>{t('重读清单与代码，改完插件文件后点一下即生效')}</small></span></button>{/if}
        <button class="cz-li act danger" onclick={() => uninstall(sel)}><span class="cz-li-tx"><span>{sel.source === 'local' ? t('取消登记') : t('卸载')}</span></span></button>
      </div>
    {/if}
    {#if canPublish(sel)}<PublishEntry id={sel.id} seq={pubSeq} onOpen={openPublish} />{/if}
  </div>
  {#if pubOpen}<PublishSheet plugin={sel} name={pName(sel)} {toast} {confirm} onBack={closePublish} />{/if}
{/if}

{#snippet mkTile(x, lg = false)}
  <span class="cz-tile" class:lg class:pp-icon={!!mkIcon(x)}>{#if mkIcon(x)}<img src={mkIcon(x)} alt="" draggable="false" referrerpolicy="no-referrer" onerror={() => mkIconFail(x)} />{:else}{@html glyph(x)}{/if}</span>
{/snippet}

{#snippet mkCard(x)}
  {@const cm = isCommunity(x)}
  <div class="cz-card" class:pp-cmcard={cm} role="button" tabindex="0" onclick={() => openMk(x)} onkeydown={(ev) => { if (ev.key === 'Enter') openMk(x); }}>
    {@render mkTile(x)}
    <div class="cz-body">
      <b class="cz-name">{mName(x)}</b>
      <p class="cz-desc">{mDesc(x)}</p>
      <span class="cz-foot" class:pp-warn={!x.latest}>{!x.latest ? tr(x.blocked || t('这台 bridge 装不了'))
        : cm ? '@' + (x.publisher || '?') + ' · ' + kindText(x.latest.kind)
        : 'v' + x.latest.version + (x.author ? ' · ' + x.author : '') + (x.latest.restart ? ' · ' + t('装完重启生效') : '')}</span>
    </div>
    {#if cm}<span class="pp-unrev">{t('未经人工审核')}</span>{/if}
    {#if x.latest}
      <button class="cz-add" disabled={busy['mk:' + x.id]} title={t('安装')} aria-label={t('安装 {name}', { name: mName(x) })}
        onclick={(ev) => { ev.stopPropagation(); mktInstall(x); }}>{@html ic('plus', 2)}</button>
    {/if}
  </div>
{/snippet}

{#if mkSel && isCommunity(mkSel)}
  <CommunityDetail x={mkSel} backLabel={mkFrom ? nameOf(mkFrom) : ''} busy={!!busy['mk:' + mkSel.id]} tile={mkTile}
    onBack={mkBack} onInstall={(x, v) => mktInstall(x, v)} onOpenInstalled={openInstalled} />
{:else if mkSel}
  <div class="pp-detail">
    <div class="cz-crumb"><button class="cz-back" onclick={mkBack}>{@html ic('back', 2)}<span>{mkFrom ? nameOf(mkFrom) : t('功能扩展')}</span></button></div>
    <div class="cz-dh">
      {@render mkTile(mkSel, true)}
      <div class="cz-dh-tx">
        <h2>{mName(mkSel)}</h2>
        <p>{t('插件市场')}{mkSel.latest ? ' · v' + mkSel.latest.version : ''}{mkSel.author ? ' · ' + mkSel.author : ''}</p>
      </div>
    </div>
    {#if mkSel.description}<p class="cz-lead">{mDesc(mkSel)}</p>{/if}
    {#if mkSel.blocked}<div class="pp-state">{tr(mkSel.blocked)}</div>{/if}
    {#if mkSel.builtin}<p class="cz-note">{t('这是内置功能的市场版：装上后盖住随 bridge 发布的内置实现，开关和配置不变；它起不来会自动退回内置版。bridge 升级后内置实现自带修复，这一版会自动失效。')}</p>{/if}
    {#if mkSel.state === 'taken'}<div class="pp-state">{t('这台服务器上有个同 id 的本机开发目录插件，先取消登记它才能从市场装。')}</div>{/if}

    <div class="pp-actbar">
      {#if mkSel.latest && (mkSel.update || mkSel.state === 'none')}
        <button class="cz-btn pri" disabled={busy['mk:' + mkSel.id]} onclick={() => mktInstall(mkSel)}>{busy['mk:' + mkSel.id] ? t('正在安装…') : mkSel.state === 'none' ? t('安装 v{v}', { v: mkSel.latest.version }) : mkSel.builtin && !mkSel.current ? t('换上市场版 v{v}', { v: mkSel.latest.version }) : t('更新到 v{v}', { v: mkSel.latest.version })}</button>
      {/if}
      {#if mkSel.state !== 'none' && mkSel.state !== 'taken'}
        <button class="cz-btn" onclick={() => openInstalled(mkSel)}>{mkSel.builtin ? t('打开这项功能') : t('打开已装的插件')}</button>
      {/if}
    </div>
    {#if mkSel.current}<p class="cz-note">{mkSel.builtin ? (mkSel.state === 'override' ? t('现在用的是市场版 v{v}。', { v: mkSel.current }) : t('装过市场版 v{v}，现在用的是内置版。', { v: mkSel.current })) : t('已装 v{v}。', { v: mkSel.current })}</p>{/if}

    <div class="cz-sec">{t('版本历史')}</div>
    <div class="cz-list">
      {#each mkSel.versions as v (v.version)}
        <div class="cz-li pp-ver">
          <span class="cz-li-tx"><span>v{v.version}{#if v.version === mkSel.current}<span class="pp-tag">{t('当前')}</span>{/if}{#if v.date}<small class="pp-date">{v.date}</small>{/if}</span>
            <small>{v.notes ? tr(v.notes) : t('（没写更新说明）')}{v.restart ? ' · ' + t('装完重启生效') : ''} · {kb(v.size)}</small>
            {#if v.problem}<small class="pp-warn">{tr(v.problem)}</small>{/if}</span>
          {#if !v.problem && v.version !== mkSel.current && mkSel.state !== 'taken'}
            <button class="cz-btn sm" disabled={busy['mk:' + mkSel.id]} onclick={() => mktInstall(mkSel, v.version)}>{t('装这一版')}</button>
          {/if}
        </div>
      {/each}
    </div>

    <div class="cz-sec">{t('信息')}</div>
    <div class="cz-list">
      <div class="cz-kv"><span>ID</span><b>{mkSel.id}</b></div>
      {#if mkSel.author}<div class="cz-kv"><span>{t('作者')}</span><b>{mkSel.author}</b></div>{/if}
      {#if mkSel.homepage}<a class="cz-kv link" href={mkSel.homepage} target="_blank" rel="noopener"><span>{t('主页')}</span><b>{mkSel.homepage}</b>{@html ic('link')}</a>{/if}
    </div>
  </div>
{/if}

<!-- 列表在看详情时只藏不卸：Agent 区（ModulesPanel）不用重拉数据，返回时滚动位置也还原得回去 -->
<div class:pp-hide={!!sel || !!mkSel}>
  {#if loadErr}
    <div class="cz-empty">{loadErr}</div>
  {:else if !data}
    <div class="cz-empty">{t('载入中…')}</div>
  {:else}
    {#if data.restartPending}
      <div class="cz-mp-banner">
        <span>{t('有改动等重启生效')}</span>
        <button class="cz-btn sm pri" disabled={restarting} onclick={restart}>{restarting ? t('正在重启…') : t('立即重启')}</button>
      </div>
    {/if}

    {#if mktUpdates.length}
      <div class="pp-upd" role="status">
        <div class="pp-upd-h"><b>{t('{n} 个插件有更新', { n: mktUpdates.length })}</b><span>{t('只提示，不会自动装')}</span></div>
        {#each mktUpdates as x (x.id)}
          <div class="pp-upd-row">
            <button class="pp-upd-tx" onclick={() => openMk(x)}>
              <span>{mName(x)}</span>
              <small>{isCommunity(x) ? t('社区') + ' · ' : ''}{x.current ? 'v' + x.current : x.builtin ? t('内置版') : ''} → v{x.latest.version}{x.latest.notes ? ' · ' + tr(x.latest.notes) : ''}</small>
            </button>
            <button class="cz-btn sm pri" disabled={busy['mk:' + x.id]} onclick={() => mktInstall(x)}>{busy['mk:' + x.id] ? t('正在更新…') : t('更新')}</button>
          </div>
        {/each}
      </div>
    {/if}

    <h3 class="cz-h pp-mkh">{t('插件市场')} {#if mktNew.length}<span class="cz-n">{mktNew.length}</span>{/if}
      <button class="cz-btn sm" disabled={mktBusy} onclick={() => loadMarket(true)}>{mktBusy ? t('正在检查…') : t('检查更新')}</button></h3>
    {#if cmkt}
      <div class="cz-chips pp-mktab" role="tablist" aria-label={t('插件市场')}>
        {#each [['official', t('官方')], ['community', t('社区')]] as [k, label] (k)}
          <button class="cz-chip" class:on={mktTab === k} role="tab" aria-selected={mktTab === k} onclick={() => (mktTab = k)}>{label}</button>
        {/each}
      </div>
    {/if}
    {#snippet mkCats(emptyApp, emptyOther)}
      <div class="cz-chips pp-mkcats" role="tablist" aria-label={t('分类')}>
        {#each [['all', t('全部')], ['app', tc('插件', '应用')], ['other', t('其它')]] as [k, label] (k)}
          <button class="cz-chip" class:on={mktCat === k} role="tab" aria-selected={mktCat === k} onclick={() => (mktCat = k)}>{label}</button>
        {/each}
      </div>
      {#if mktShown.length}
        <div class="cz-grid">{#each mktShown as x (x.channel + ':' + x.id)}{@render mkCard(x)}{/each}</div>
      {:else}
        <p class="cz-note pp-intro">{mktCat === 'app' ? emptyApp : emptyOther}</p>
      {/if}
    {/snippet}
    {#if mktTab === 'community' && cmkt}
      {@const cm = cmkt.market || {}}
      <p class="cz-note pp-mknote">{t('任何 bridge 用户都能投稿的插件，只经过自动检查，没有人工审核。只装你信得过的作者的。')}</p>
      {#if cm.off}
        <p class="cz-note pp-intro">{t('社区插件市场在这台服务器上关着（config.json 的 pluginMarket.community）。')}</p>
      {:else if mktErr || cm.error}
        <div class="cz-diag">{t('社区插件市场没拉下来：{reason}', { reason: tr(mktErr || cm.error) })}</div>
      {:else if cm.empty}
        <p class="cz-note pp-intro">{t('社区插件市场还没开张，还没有人投稿。自己写的插件可以在它的详情里「发布到社区」。')}</p>
      {:else if mktNew.length}
        {@render mkCats(t('社区里暂时没有可装的应用。'), t('这一类里暂时没有可装的插件。'))}
      {:else if cm.ok}
        <p class="cz-note pp-intro">{(cmkt.plugins || []).length ? t('社区里的插件都装上了。') : t('社区里暂时还没有插件。')}</p>
      {/if}
      {#if cm.ok && !cm.empty}<p class="pp-mkfoot">{t('索引第 {n} 版', { n: cm.seq })}{cm.checkedAt ? ' · ' + t('上次检查 {at}', { at: when(cm.checkedAt) }) : ''}</p>{/if}
    {:else}
      <p class="cz-note" class:pp-intro={!cmkt} class:pp-mknote={!!cmkt}>{t('bridge 官方发布的插件：不用升级 bridge 就能装新功能、更新插件，内置功能的修复也从这里来。有更新只提示，点了才装。')}</p>
      {#if mkt?.market?.off}
        <p class="cz-note">{t('插件市场在这台服务器上关着（config.json 的 pluginMarket）。')}</p>
      {:else}
        {#if mktErr || mkt?.market?.error}<div class="cz-diag">{t('插件市场没拉下来：{reason}', { reason: tr(mktErr || mkt.market.error) })}</div>{/if}
        {#if mktNew.length}
          {@render mkCats(t('市场里暂时没有可装的应用。'), t('这一类里暂时没有可装的插件。'))}
        {:else if mkt?.market?.ok}
          <p class="cz-note pp-intro">{(mkt.plugins || []).length ? t('市场里的插件都装上了。') : t('市场里暂时还没有插件。')}</p>
        {:else if !mkt && !mktErr}
          <p class="cz-note pp-intro">{t('载入中…')}</p>
        {/if}
        {#if mkt?.market?.ok}<p class="pp-mkfoot">{t('索引第 {n} 版', { n: mkt.market.seq })}{mkt.market.checkedAt ? ' · ' + t('上次检查 {at}', { at: when(mkt.market.checkedAt) }) : ''}</p>{/if}
      {/if}
    {/if}

    <h3 class="cz-h pp-top">{t('Agent')}</h3>
    <ModulesPanel {toast} {confirm} />

    <h3 class="cz-h pp-top">{t('功能')} <span class="cz-n">{builtins.filter((p) => p.active).length} / {builtins.length}</span></h3>
    <p class="cz-note pp-intro">{t('随 bridge 一起装好、默认开着的功能。关掉用不上的：它的界面入口、接口和 Claude 的对应工具会一起消失，再打开就回来。')}</p>
    {#each groups as g (g.key)}
      <div class="cz-sec">{g.label}</div>
      <div class="cz-grid">{#each g.items as p (p.id)}{@render card(p)}{/each}</div>
    {/each}

    <h3 class="cz-h pp-top">{t('已安装的插件')} {#if thirdParty.length}<span class="cz-n">{thirdParty.length}</span>{/if}</h3>
    {#if thirdParty.length}
      {#if thirdApps.length}
        <div class="cz-sec">{tc('插件', '应用')}</div>
        <div class="cz-grid">{#each thirdApps as p (p.id)}{@render card(p)}{/each}</div>
        {#if thirdRest.length}<div class="cz-sec">{t('其他')}</div>{/if}
      {/if}
      {#if thirdRest.length}<div class="cz-grid">{#each thirdRest as p (p.id)}{@render card(p)}{/each}</div>{/if}
    {:else}
      <p class="cz-note pp-intro">{t('还没有装第三方插件。插件就是一个带 bridge-plugin.json 的目录：可以给 Claude 加工具、加接口、加 agent 操作、加定时的后台任务。直接跟 Claude 说想要什么，它可以帮你写好并登记上。')}</p>
    {/if}
    <div class="pp-add">
      <button class="cz-btn" disabled={uploading} onclick={() => fileInput?.click()}>{@html ic('upload')}<span>{uploading ? t('正在安装…') : t('上传 zip')}</span></button>
      <button class="cz-btn" onclick={() => { linkOpen = true; linkErr = ''; }}>{@html ic('plus')}<span>{t('登记本机目录')}</span></button>
      <button class="cz-btn" onclick={() => { ghOpen = true; ghErr = ''; }}>{@html ic('link')}<span>{t('GitHub 地址')}</span></button>
    </div>

  {/if}
</div>

{#if logOf}
  <div class="cz-modal-wrap">
    <button class="cz-mask" aria-label={t('关闭')} onclick={() => (logOf = null)}></button>
    <div class="cz-modal pp-logm" role="dialog" aria-modal="true">
      {#if logOf.plugin}
        <h3>{t('「{name}」的日志', { name: pName(logOf.plugin) })}</h3>
        <div class="pp-logbar">
          <span>{t('只看警告和错误')}</span>
          <button class="cz-sw" class:on={logOf.level === 'warn'} role="switch" aria-checked={logOf.level === 'warn'} aria-label={t('只看警告和错误')} disabled={logBusy}
            onclick={() => showPluginLog(logOf.plugin, logOf.level === 'warn' ? '' : 'warn')}><span></span></button>
        </div>
        <pre class="pp-log">{logOf.lines.length ? logOf.lines.join('\n') : logOf.level ? t('（没有警告或错误）') : t('（还没有记录）')}</pre>
        <div class="cz-acts">
          <button class="cz-btn" disabled={logBusy} onclick={() => showPluginLog(logOf.plugin, logOf.level)}>{t('刷新')}</button>
          <button class="cz-btn" onclick={() => (logOf = null)}>{t('关闭')}</button>
        </div>
      {:else}
        <h3>{t('子进程 {name} 的日志', { name: logOf.name })}</h3>
        <pre class="pp-log">{logOf.lines.length ? logOf.lines.join('\n') : t('（还没有输出）')}</pre>
        <div class="cz-acts"><button class="cz-btn" onclick={() => (logOf = null)}>{t('关闭')}</button></div>
      {/if}
    </div>
  </div>
{/if}

{#if ghOpen}
  <div class="cz-modal-wrap">
    <button class="cz-mask" aria-label={t('关闭')} onclick={() => (ghOpen = false)}></button>
    <div class="cz-modal" role="dialog" aria-modal="true">
      <h3>{t('从 GitHub 安装插件')}</h3>
      <p class="cz-mdesc">{t('填仓库地址：owner/repo、owner/repo@版本，或仓库网址。没写版本就装最新 Release（没有 Release 就用默认分支）。插件和 bridge 同进程、权限相同，只装你信得过的。')}</p>
      <label class="cz-lab" for="pp-gh">{t('仓库')}</label>
      <input id="pp-gh" class="cz-in" bind:value={ghRepo} placeholder="someone/bridge-weather" onkeydown={(e) => { if (e.key === 'Enter') installGh(ghRepo); }} />
      {#if ghErr}<div class="cz-err">{ghErr}</div>{/if}
      <div class="cz-acts">
        <button class="cz-btn" onclick={() => (ghOpen = false)}>{t('取消')}</button>
        <button class="cz-btn pri" disabled={!ghRepo.trim() || ghBusy} onclick={() => installGh(ghRepo)}>{ghBusy ? t('正在安装…') : t('安装')}</button>
      </div>
    </div>
  </div>
{/if}

{#if linkOpen}
  <div class="cz-modal-wrap">
    <button class="cz-mask" aria-label={t('关闭')} onclick={() => (linkOpen = false)}></button>
    <div class="cz-modal" role="dialog" aria-modal="true">
      <h3>{t('登记本机插件目录')}</h3>
      <p class="cz-mdesc">{t('填服务器上插件目录的绝对路径（目录里要有 bridge-plugin.json）。代码直接从那里加载，改完点「重新加载」即生效，适合开发自己的插件。')}</p>
      <label class="cz-lab" for="pp-path">{t('目录')}</label>
      <input id="pp-path" class="cz-in" bind:value={linkPath} placeholder={t('例如 D:\\dev\\my-plugin')} onkeydown={(e) => { if (e.key === 'Enter') link(); }} />
      {#if linkErr}<div class="cz-err">{linkErr}</div>{/if}
      <div class="cz-acts">
        <button class="cz-btn" onclick={() => (linkOpen = false)}>{t('取消')}</button>
        <button class="cz-btn pri" disabled={!linkPath.trim() || linking} onclick={link}>{linking ? t('正在登记…') : t('登记')}</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .pp-anchor { display: block; height: 0; }
  /* 应用类市场卡片的图片图标：铺满方块、圆角跟方块走；底色留着，透明图标不至于飘在卡片上 */
  .cz-tile.pp-icon { overflow: hidden; }
  .cz-tile.pp-icon img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .pp-mkcats { margin: 2px 0 12px; }
  .pp-mktab { margin: -4px 0 0; }
  .pp-mknote { margin: 12px 2px 12px; }
  /* 社区卡片角落那行「未经人工审核」：只是提醒，压到最淡，不用彩色 */
  .pp-cmcard { padding-bottom: 30px; }
  .pp-unrev { position: absolute; right: 18px; bottom: 12px; font-size: 11.5px; color: var(--cz-ink3); opacity: .75; pointer-events: none; }
  .pp-upd { margin: 0 0 26px; padding: 14px 16px 6px; border-radius: 14px; background: color-mix(in srgb, var(--cz-crit) 7%, transparent);
    border: 1px solid color-mix(in srgb, var(--cz-crit) 22%, transparent); }
  .pp-upd-h { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; margin-bottom: 6px; }
  .pp-upd-h b { font-size: 15px; }
  .pp-upd-h span { font-size: 12.5px; color: var(--cz-ink3); }
  .pp-upd-row { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-top: 1px solid var(--cz-line); }
  .pp-upd-h + .pp-upd-row { border-top: 0; }
  .pp-upd-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; text-align: left; color: var(--cz-ink); font-size: 14.5px; }
  .pp-upd-tx small { color: var(--cz-ink2); font-size: 12.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pp-updtx { color: var(--cz-crit); font-weight: 600; }
  .pp-mkh { display: flex; align-items: center; gap: 10px; }
  .pp-mkh .cz-btn { margin-left: auto; }
  .pp-mkfoot { margin: 10px 0 0; font-size: 12px; color: var(--cz-ink3); }
  .pp-ver { display: flex; align-items: center; gap: 12px; }
  .pp-ver .cz-li-tx { flex: 1; min-width: 0; }
  .pp-tag { margin-left: 8px; padding: 1px 7px; border-radius: 6px; background: var(--cz-sel); color: var(--cz-ink2); font-size: 11.5px; font-weight: 500; vertical-align: 1px; }
  .pp-date { margin-left: 8px; color: var(--cz-ink3); font-size: 12px; }
  .pp-upd-foot { color: var(--cz-crit); }
  .pp-hide { display: none; }
  .pp-intro { margin: -6px 0 6px; }
  .pp-top { margin-top: 38px; }
  .pp-warn { color: var(--cz-warn); }
  .pp-state { margin: 4px 0 6px; padding: 10px 14px; border-radius: 10px; font-size: 13.5px; line-height: 1.55; color: var(--cz-warn);
    background: color-mix(in srgb, var(--cz-warn) 11%, transparent); overflow-wrap: anywhere; }
  .pp-state.err { color: var(--cz-crit); background: color-mix(in srgb, var(--cz-crit) 11%, transparent); }
  /* 清单体检：提示色（主题强调色淡底），比警告块低调 */
  .pp-state.pp-hint { color: var(--cz-ink2); background: color-mix(in srgb, var(--cz-accent) 8%, transparent); font-size: 13px; }
  .pp-hint-h { font-weight: 600; color: var(--cz-ink); margin-bottom: 2px; }
  .pp-hint ul { margin: 0; padding-left: 1.2em; }
  .pp-hint li { margin: 2px 0; }
  .pp-perm b { font-weight: 400; }
  /* .cz-li-tx small 默认单行截断；报错原因要能折行看全 */
  .cz-li-tx small.pp-wrap { white-space: normal; overflow-wrap: anywhere; line-height: 1.45; }
  .pp-tag.pp-tag-ok { color: var(--cz-ok, #5aa468); background: color-mix(in srgb, var(--cz-ok, #5aa468) 14%, transparent); }
  .pp-tag.pp-tag-bad { color: var(--cz-crit); background: color-mix(in srgb, var(--cz-crit) 12%, transparent); }
  .pp-logbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 6px; font-size: 13.5px; color: var(--cz-ink2); }
  .pp-gap { margin-top: 16px; }
  .pp-app-ic img { width: 22px; height: 22px; object-fit: contain; display: block; }
  .pp-mono { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 13px; }
  .pp-add { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
  .pp-add :global(svg) { width: 16px; height: 16px; margin-right: 6px; vertical-align: -3px; }
  .pp-st { display: flex; align-items: center; gap: 10px; padding: 12px 16px; font-size: 15px; }
  .pp-st-tx { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .pp-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--cz-ink3); margin-right: 6px; flex: none; }
  .pp-st .pp-dot { margin-right: 0; }
  .pp-dot.ok { background: var(--cz-ok, #5aa468); } .pp-dot.warn { background: var(--cz-warn); } .pp-dot.crit, .pp-dot.error { background: var(--cz-crit); }
  .pp-tone-warn { color: var(--cz-warn); } .pp-tone-crit { color: var(--cz-crit); }
  .pp-actbar { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
  .pp-danger { color: var(--cz-crit); }
  .pp-embed { margin-top: 2px; }
  .pp-logm { width: min(760px, 94vw); }
  .pp-log { max-height: 60vh; overflow: auto; margin: 8px 0 0; padding: 10px 12px; border-radius: 8px; background: var(--cz-line);
    font: 12px/1.5 ui-monospace, "SF Mono", Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
</style>
