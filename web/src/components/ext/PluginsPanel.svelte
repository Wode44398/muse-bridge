<script>
  // 扩展中心 ·「功能扩展」：bridge 的插件（服务端 src/plugins/，接口 /api/plugins*）。三个区：
  //   Agent      （排最上，原来这一页就是它）Gemini · Vertex / ChatGPT · Codex / dimensio 三个 agent 扩展（原 ModulesPanel：装卸、更新、agent 总开关）；
  //   功能       随 bridge 发布、默认开着的内置功能（定时任务、分享链接、设备、手机操控、内置浏览器……）按分类排，逐项开关；
  //   第三方插件  装的 zip / 登记的本机目录：开关、重新加载、卸载，「添加」上传 zip 或填本机目录。
  //   插件市场    官方市场（/api/plugins/market，签过名的索引）里还没装的插件；有更新时页顶列出来——只提示，点了才装。
  //              内置功能也可以换上市场版（盖住内置实现，详情里「恢复内置版」换回）；装的插件可以「回退」到回收区里的上一版。
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
  import { t, tr, isEn, locale } from '../../lib/i18n.js';
  import { ic } from './icons.js';
  import ModulesPanel from '../ModulesPanel.svelte';
  import PluginForm from './PluginForm.svelte';
  import PluginFrame from './PluginFrame.svelte';
  import { openPluginStandalone, inAndroidApp } from '../../lib/pluginPanels.svelte.js';
  import { openSettings } from '../../lib/settingsNav.svelte.js';

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
    { key: 'system', label: t('系统'), g: '<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M6 6l1.6 1.6M16.4 16.4 18 18M6 18l1.6-1.6M16.4 7.6 18 6"/>' },
  ];
  const PLUGIN_G = '<path d="M10 4.5a1.8 1.8 0 1 1 3.6 0H17a1.4 1.4 0 0 1 1.4 1.4v3.3a1.8 1.8 0 1 0 0 3.6v3.3A1.4 1.4 0 0 1 17 17.5h-3.3a1.8 1.8 0 1 0-3.6 0H7a1.4 1.4 0 0 1-1.4-1.4v-3.4a1.8 1.8 0 1 1 0-3.6V5.9A1.4 1.4 0 0 1 7 4.5z"/>';
  const glyph = (p) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${CATS.find((c) => c.key === p.category)?.g || PLUGIN_G}</svg>`;
  const SOURCE = { builtin: t('内置'), module: t('agent 扩展'), installed: t('已安装'), local: t('本机目录') };

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
      if (i >= 0) data.plugins[i] = { ...data.plugins[i], panelStatus: ev.panelStatus || null, processes: ev.processes || [], hooks: ev.hooks || [], actions: ev.actions || [] };
    });
  }));
  const apply = (r) => { if (r && Array.isArray(r.plugins)) data = { plugins: r.plugins, restartPending: !!r.restartPending }; };

  const builtins = $derived((data?.plugins || []).filter((p) => p.source === 'builtin'));
  const thirdParty = $derived((data?.plugins || []).filter((p) => p.source === 'installed' || p.source === 'local'));
  const groups = $derived(CATS.map((c) => ({ ...c, items: builtins.filter((p) => p.category === c.key) }))
    .concat([{ key: '_other', label: t('其他'), items: builtins.filter((p) => !CATS.some((c) => c.key === p.category)) }])
    .filter((g) => g.items.length));
  const nameOf = (id) => tr((data?.plugins || []).find((p) => p.id === id)?.name || id);

  function footOf(p) {
    if (p.status === 'error') return { text: t('出错：{reason}', { reason: tr(p.error || '') }), err: true };
    if (p.pendingRestart) return { text: p.enabled ? (p.active ? t('重启后生效') : t('重启后开启')) : t('重启后关闭'), warn: true };
    if (p.status === 'blocked') return { text: t('缺依赖：{names}', { names: p.blockedBy.map(nameOf).join('、') }), warn: true };
    if (p.problems?.length) return { text: t('配置有 {n} 项无效，已用默认值', { n: p.problems.length }), warn: true };
    if (p.override?.pending) return { text: p.override.pending.restore ? t('重启后恢复内置版') : t('重启后换上市场版 v{v}', { v: p.override.pending.install }), warn: true };
    const bits = [];
    if (p.source === 'installed' || p.source === 'local') { if (p.version) bits.push('v' + p.version); bits.push(p.market ? t('插件市场') : SOURCE[p.source]); }
    else bits.push(p.active ? t('已开启') : t('已关闭'));
    if (p.override?.active) bits.push(t('市场版 v{v}', { v: p.override.version }));
    const mx = mktOf(p.id);
    if (mx?.update) return { text: bits.concat(t('有更新 v{v}', { v: mx.latest.version })).join(' · '), upd: true };
    if (p.restart) bits.push(t('改动重启生效'));
    return { text: bits.join(' · ') };
  }

  let busy = $state({});
  async function toggle(p) {
    if (p.locked || busy[p.id]) return;
    busy[p.id] = true;
    try {
      const r = await api.post('/api/plugins/toggle', { id: p.id, enabled: !p.enabled });
      apply(r);
      const np = r.plugin;
      if (np?.status === 'error') toast(t('「{name}」启用失败：{reason}', { name: tr(np.name), reason: tr(np.error || '') }), true);
      else if (np?.pendingRestart) toast(t('已保存，重启 bridge 后生效'));
    } catch (e) { toast(errMsg(e), true); }
    finally { busy[p.id] = false; }
  }

  // ═══ 详情 ═══
  let selId = $state(null);
  const sel = $derived(selId ? (data?.plugins || []).find((p) => p.id === selId) || null : null);
  $effect(() => { if (selId && data && !sel) selId = null; });   // 卸载了：退回列表
  $effect(() => { if (!selId) return; return pushBackLayer(() => back()); });
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
    selId = null;
    requestAnimationFrame(() => { const sc = scroller(); if (sc) sc.scrollTop = listScroll; });
  }
  async function reload(p) {
    busy[p.id] = true;
    try {
      const r = await api.post('/api/plugins/reload', { id: p.id });
      apply(r);
      if (r.plugin?.status === 'error') toast(t('重新加载失败：{reason}', { reason: tr(r.plugin.error || '') }), true);
      else toast(t('已重新加载「{name}」', { name: tr(p.name) }));
    } catch (e) { toast(errMsg(e), true); }
    finally { busy[p.id] = false; }
  }
  async function uninstall(p) {
    const local = p.source === 'local';
    const ok = await confirm(local
      ? { title: t('取消登记「{name}」？', { name: tr(p.name) }), desc: t('停用并从列表里移除；目录里的文件不动，随时可以重新登记。'), yes: t('取消登记'), danger: true }
      : { title: t('卸载「{name}」？', { name: tr(p.name) }), desc: t('停用并移走它的程序文件（留在回收区，可找回）；它存的数据（plugin-data）不删。'), yes: t('卸载'), danger: true });
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
    try { await openPluginStandalone(p.id, { which, title: p.ui?.panel?.title || p.name }); }
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

  // 子进程日志
  let logOf = $state(null);   // { name, lines, state }
  $effect(() => { if (!logOf) return; return pushBackLayer(() => { logOf = null; }); });
  async function showLog(p, proc) {
    try { const r = await api.get('/api/plugins/log?id=' + encodeURIComponent(p.id) + '&name=' + encodeURIComponent(proc.name) + '&lines=300'); logOf = { name: proc.name, lines: r.lines || [], state: r.state }; }
    catch (e) { toast(errMsg(e), true); }
  }
  const PROC_STATE = { starting: t('启动中'), running: t('运行中'), backoff: t('等待重启'), stopped: t('已停止'), failed: t('失败') };
  const procTone = (st) => (st === 'running' ? 'ok' : st === 'failed' ? 'crit' : st === 'stopped' ? '' : 'warn');
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
      if (p?.status === 'error') toast(t('已安装「{name}」，但启用失败：{reason}', { name: tr(p.name), reason: tr(p.error || '') }), true);
      else toast(p?.pendingRestart ? t('已更新「{name}」，重启 bridge 后生效', { name: tr(p.name) }) : t('已安装「{name}」', { name: tr(p?.name || '') }));
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
      if (r.plugin?.status === 'error') toast(t('已登记「{name}」，但启用失败：{reason}', { name: tr(r.plugin.name), reason: tr(r.plugin.error || '') }), true);
      else toast(t('已登记「{name}」', { name: tr(r.plugin?.name || '') }));
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
      if (p?.status === 'error') toast(t('已安装「{name}」，但启用失败：{reason}', { name: tr(p.name), reason: tr(p.error || '') }), true);
      else toast(p?.pendingRestart ? t('已更新「{name}」，重启 bridge 后生效', { name: tr(p.name) }) : t('已安装「{name}」', { name: tr(p?.name || '') }));
    } catch (e) { if (quiet) toast(errMsg(e), true); else ghErr = errMsg(e); }
    finally { ghBusy = false; }
  }
  async function checkUpd(p) {
    busy[p.id + ':upd'] = true;
    try {
      const r = await api.get('/api/plugins/update?id=' + encodeURIComponent(p.id));
      if (r.pinned) { toast(t('钉在 {ref}，不跟新版', { ref: r.pinned })); return; }
      if (!r.newer) { toast(t('已经是最新版（v{v}）', { v: r.current || '?' })); return; }
      const ok = await confirm({ title: t('更新「{name}」到 v{v}？', { name: tr(p.name), v: r.latest || r.tag }), desc: t('从 {repo} 下载最新 Release 覆盖安装，旧版留在回收区。', { repo: p.github.github }), yes: t('更新') });
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
  const mktOf = (id) => (mkt?.plugins || []).find((x) => x.id === id) || null;
  const mktNew = $derived((mkt?.plugins || []).filter((x) => !x.builtin && x.state === 'none'));
  const mktUpdates = $derived((mkt?.plugins || []).filter((x) => x.update));
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
    const title = x.builtin
      ? (has ? t('把「{name}」换成市场版 v{v}？', { name: mName(x), v }) : t('给「{name}」换上市场版 v{v}？', { name: mName(x), v }))
      : !has ? t('安装「{name}」v{v}？', { name: mName(x), v })
      : down ? t('把「{name}」降到 v{v}？', { name: mName(x), v }) : t('把「{name}」更新到 v{v}？', { name: mName(x), v });
    const desc = [ve?.notes ? t('这一版：{notes}', { notes: sentence(tr(ve.notes)) }) : '',
      x.builtin ? t('市场版会盖住随 bridge 发布的内置实现；它起不来会自动退回内置版，也可以随时「恢复内置版」。') : has ? t('旧版留在回收区，可以随时回退。') : t('插件和 bridge 同进程运行，这是 bridge 官方发布、验过签名的插件。'),
      ve?.restart ? t('要重启 bridge 才生效。') : ''].filter(Boolean).join(' ');
    if (!(await confirm({ title, desc, yes: x.builtin || has ? (down ? t('降级') : t('更新')) : t('安装') }))) return;
    busy['mk:' + x.id] = true;
    try {
      const r = await api.post('/api/plugins/market/install', { id: x.id, version: v });
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
    if (!(await confirm({ title: rbNewer(p) ? t('「{name}」换回 v{v}？', { name: tr(p.name), v: p.rollbackTo }) : t('「{name}」回退到 v{v}？', { name: tr(p.name), v: p.rollbackTo }), desc: t('换回回收区里的上一版；现在这一版也留在回收区，可以再换回来。'), yes: t('回退') }))) return;
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
    if (!(await confirm({ title: t('「{name}」恢复内置版？', { name: tr(p.name) }), desc: t('市场版移进回收区，换回随 bridge 发布的内置实现；这一版市场版之后不再提示更新。'), yes: t('恢复内置版') }))) return;
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
  const mkSel = $derived(mkId ? mktOf(mkId) : null);
  $effect(() => { if (!mkId) return; return pushBackLayer(() => mkBack()); });
  let mkFrom = $state(null);   // 从插件详情点进来的：返回时回到那个详情
  function openMk(x) {
    if (selId) { mkFrom = selId; selId = null; } else { mkFrom = null; listScroll = scroller()?.scrollTop || 0; }
    mkId = x.id;
    queueMicrotask(() => { const sc = scroller(); if (sc) sc.scrollTop = 0; });
  }
  function mkBack() {
    mkId = null;
    if (mkFrom) { selId = mkFrom; mkFrom = null; return; }
    requestAnimationFrame(() => { const sc = scroller(); if (sc) sc.scrollTop = listScroll; });
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
      <b class="cz-name">{tr(p.name)}</b>
      <p class="cz-desc">{tr(p.description)}</p>
      <span class="cz-foot" class:err={f.err} class:pp-warn={f.warn} class:pp-upd-foot={f.upd}>{f.text}</span>
    </div>
    {#if !p.locked}
      <button class="cz-sw" class:on={p.enabled} role="switch" aria-checked={p.enabled} disabled={busy[p.id]}
        onclick={(ev) => { ev.stopPropagation(); toggle(p); }} aria-label={t('启用 {name}', { name: tr(p.name) })}><span></span></button>
    {/if}
  </div>
{/snippet}

{#if sel}
  {@const f = footOf(sel)}
  {@const mx = mktOf(sel.id)}
  <div class="pp-detail">
    <div class="cz-crumb"><button class="cz-back" onclick={back}>{@html ic('back', 2)}<span>{t('功能扩展')}</span></button></div>
    <div class="cz-dh">
      <span class="cz-tile lg">{@html glyph(sel)}</span>
      <div class="cz-dh-tx">
        <h2>{tr(sel.name)}</h2>
        <p>{sel.market ? t('插件市场') : SOURCE[sel.source] || sel.source}{sel.override?.active ? ' · ' + t('市场版 v{v}', { v: sel.override.version }) : sel.version ? ' · v' + sel.version : ''}{sel.author ? ' · ' + sel.author : ''}</p>
      </div>
      {#if !sel.locked}
        <button class="cz-sw" class:on={sel.enabled} role="switch" aria-checked={sel.enabled} disabled={busy[sel.id]} onclick={() => toggle(sel)} aria-label={t('启用 {name}', { name: tr(sel.name) })}><span></span></button>
      {/if}
    </div>
    {#if sel.description}<p class="cz-lead">{tr(sel.description)}</p>{/if}
    {#if f.err || f.warn}<div class="pp-state" class:err={f.err}>{f.text}</div>{/if}
    {#if sel.problems?.length}<div class="pp-state">{#each sel.problems as pr}<div>{tr(pr)}</div>{/each}</div>{/if}
    {#if sel.override?.error}<div class="pp-state">{tr(sel.override.error)}</div>{/if}

    {#if mx || sel.rollbackTo || sel.override}
      <div class="cz-sec">{t('版本')}</div>
      <div class="cz-list">
        {#if mx?.update}
          <button class="cz-li act" disabled={busy['mk:' + mx.id]} onclick={() => mktInstall(mx)}><span class="cz-li-tx"><span class="pp-updtx">{busy['mk:' + mx.id] ? t('正在更新…') : mx.builtin && !mx.current ? t('换上市场版 v{v}', { v: mx.latest.version }) : t('更新到 v{v}', { v: mx.latest.version })}</span><small>{mx.latest.notes ? tr(mx.latest.notes) : t('插件市场有新版本')}</small></span></button>
        {/if}
        {#if mx}<button class="cz-li act" onclick={() => openMk(mx)}><span class="cz-li-tx"><span>{t('插件市场里的版本')}</span><small>{t('{n} 个版本 · 可以装指定版本', { n: mx.versions.length })}</small></span></button>{/if}
        {#if sel.rollbackTo}<button class="cz-li act" disabled={busy[sel.id + ':rb']} onclick={() => rollback(sel)}><span class="cz-li-tx"><span>{rbLabel(sel)}</span><small>{t('换回回收区里的上一版')}</small></span></button>{/if}
        {#if sel.override && !sel.override.pending?.restore}<button class="cz-li act danger" disabled={busy[sel.id + ':rb']} onclick={() => restoreBuiltin(sel)}><span class="cz-li-tx"><span>{t('恢复内置版')}</span><small>{t('不用市场版，换回随 bridge 发布的内置实现')}</small></span></button>{/if}
      </div>
    {/if}
    {#if sel.locked && sel.source === 'module'}<p class="cz-note">{t('agent 扩展的开关在上面的「Agent」区（或设置里的 Agent 页）。')}</p>{/if}

    {#if sel.active && (sel.panelStatus || sel.processes?.length || sel.actions?.length || sel.hooks?.length)}
      <div class="cz-sec">{t('运行状态')}</div>
      <div class="cz-list">
        {#if sel.panelStatus}
          <div class="pp-st">
            <span class="pp-dot {sel.panelStatus.tone}"></span>
            <span class="pp-st-tx">{tr(sel.panelStatus.text || '')}</span>
          </div>
          {#each sel.panelStatus.items || [] as it}
            <div class="cz-kv"><span>{tr(it.label)}</span><b class:pp-tone-warn={it.tone === 'warn'} class:pp-tone-crit={it.tone === 'error'}>{tr(it.value)}</b></div>
          {/each}
        {/if}
        {#each sel.processes || [] as proc (proc.name)}
          <button class="cz-li act" onclick={() => showLog(sel, proc)}>
            <span class="cz-li-tx"><span><span class="pp-dot {procTone(proc.state)}"></span>{t('子进程')} {proc.name}</span>
              <small>{PROC_STATE[proc.state] || proc.state}{proc.pid ? ' · pid ' + proc.pid : ''}{proc.restarts ? ' · ' + t('重启 {n} 次', { n: proc.restarts }) : ''}{proc.lastExit != null && proc.state !== 'running' ? ' · ' + t('上次退出 {code}', { code: proc.lastExit }) : ''} · {t('点开看日志')}</small></span>
          </button>
        {/each}
        {#each sel.hooks || [] as h (h.path)}
          <button class="cz-li act" onclick={() => copyText(h.path)}>
            <span class="cz-li-tx"><span>{t('回调地址')} <span class="pp-mono">{h.methods.join('/')} {h.path}</span></span>
              <small>{h.verify.map((v) => ({ loopback: t('只收本机直连'), secret: t('共享密钥'), hmac: t('HMAC 签名') }[v] || v)).join(' · ')} · {t('点一下复制')}</small></span>
          </button>
        {/each}
      </div>
      {#if sel.actions?.length}
        <div class="pp-actbar">
          {#each sel.actions as a (a.id)}
            <button class="cz-btn" class:pp-danger={a.danger} disabled={busy[sel.id + ':' + a.id]} title={tr(a.desc || '')} onclick={() => runAct(sel, a)}>{tr(a.label)}</button>
          {/each}
        </div>
      {/if}
    {/if}

    {#if sel.ui?.panel && sel.active}
      <div class="cz-list pp-gap">
        <button class="cz-li act" onclick={() => openPanel(sel)}><span class="cz-li-tx"><span>{t('打开「{name}」', { name: tr(sel.ui.panel.title) })}</span><small>{t('插件自己的控制面板')}</small></span></button>
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
      <div class="cz-kv"><span>{t('来源')}</span><b>{sel.market ? t('插件市场') + ' · v' + sel.market.version : sel.override?.active ? t('内置 · 市场版 v{v}', { v: sel.override.version }) : SOURCE[sel.source] || sel.source}</b></div>
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
  </div>
{/if}

{#snippet mkCard(x)}
  <div class="cz-card" role="button" tabindex="0" onclick={() => openMk(x)} onkeydown={(ev) => { if (ev.key === 'Enter') openMk(x); }}>
    <span class="cz-tile">{@html glyph(x)}</span>
    <div class="cz-body">
      <b class="cz-name">{mName(x)}</b>
      <p class="cz-desc">{mDesc(x)}</p>
      <span class="cz-foot" class:pp-warn={!x.latest}>{x.latest ? 'v' + x.latest.version + (x.author ? ' · ' + x.author : '') + (x.latest.restart ? ' · ' + t('装完重启生效') : '') : tr(x.blocked || t('这台 bridge 装不了'))}</span>
    </div>
    {#if x.latest}
      <button class="cz-add" disabled={busy['mk:' + x.id]} title={t('安装')} aria-label={t('安装 {name}', { name: mName(x) })}
        onclick={(ev) => { ev.stopPropagation(); mktInstall(x); }}>{@html ic('plus', 2)}</button>
    {/if}
  </div>
{/snippet}

{#if mkSel}
  <div class="pp-detail">
    <div class="cz-crumb"><button class="cz-back" onclick={mkBack}>{@html ic('back', 2)}<span>{mkFrom ? tr((data?.plugins || []).find((p) => p.id === mkFrom)?.name || '') : t('功能扩展')}</span></button></div>
    <div class="cz-dh">
      <span class="cz-tile lg">{@html glyph(mkSel)}</span>
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
              <small>{x.current ? 'v' + x.current : x.builtin ? t('内置版') : ''} → v{x.latest.version}{x.latest.notes ? ' · ' + tr(x.latest.notes) : ''}</small>
            </button>
            <button class="cz-btn sm pri" disabled={busy['mk:' + x.id]} onclick={() => mktInstall(x)}>{busy['mk:' + x.id] ? t('正在更新…') : t('更新')}</button>
          </div>
        {/each}
      </div>
    {/if}

    <h3 class="cz-h">{t('Agent')}</h3>
    <ModulesPanel {toast} {confirm} />

    <h3 class="cz-h pp-top">{t('功能')} <span class="cz-n">{builtins.filter((p) => p.active).length} / {builtins.length}</span></h3>
    <p class="cz-note pp-intro">{t('随 bridge 一起装好、默认开着的功能。关掉用不上的：它的界面入口、接口和 Claude 的对应工具会一起消失，再打开就回来。')}</p>
    {#each groups as g (g.key)}
      <div class="cz-sec">{g.label}</div>
      <div class="cz-grid">{#each g.items as p (p.id)}{@render card(p)}{/each}</div>
    {/each}

    <h3 class="cz-h pp-top pp-mkh">{t('插件市场')} {#if mktNew.length}<span class="cz-n">{mktNew.length}</span>{/if}
      <button class="cz-btn sm" disabled={mktBusy} onclick={() => loadMarket(true)}>{mktBusy ? t('正在检查…') : t('检查更新')}</button></h3>
    <p class="cz-note pp-intro">{t('bridge 官方发布的插件：不用升级 bridge 就能装新功能、更新插件，内置功能的修复也从这里来。有更新只提示，点了才装。')}</p>
    {#if mkt?.market?.off}
      <p class="cz-note">{t('插件市场在这台服务器上关着（config.json 的 pluginMarket）。')}</p>
    {:else}
      {#if mktErr || mkt?.market?.error}<div class="cz-diag">{t('插件市场没拉下来：{reason}', { reason: tr(mktErr || mkt.market.error) })}</div>{/if}
      {#if mktNew.length}
        <div class="cz-grid">{#each mktNew as x (x.id)}{@render mkCard(x)}{/each}</div>
      {:else if mkt?.market?.ok}
        <p class="cz-note pp-intro">{(mkt.plugins || []).length ? t('市场里的插件都装上了。') : t('市场里暂时还没有插件。')}</p>
      {:else if !mkt && !mktErr}
        <p class="cz-note pp-intro">{t('载入中…')}</p>
      {/if}
      {#if mkt?.market?.ok}<p class="pp-mkfoot">{t('索引第 {n} 版', { n: mkt.market.seq })}{mkt.market.checkedAt ? ' · ' + t('上次检查 {at}', { at: when(mkt.market.checkedAt) }) : ''}</p>{/if}
    {/if}

    <h3 class="cz-h pp-top">{t('已安装的插件')} {#if thirdParty.length}<span class="cz-n">{thirdParty.length}</span>{/if}</h3>
    {#if thirdParty.length}
      <div class="cz-grid">{#each thirdParty as p (p.id)}{@render card(p)}{/each}</div>
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
      <h3>{t('子进程 {name} 的日志', { name: logOf.name })}</h3>
      <pre class="pp-log">{logOf.lines.length ? logOf.lines.join('\n') : t('（还没有输出）')}</pre>
      <div class="cz-acts"><button class="cz-btn" onclick={() => (logOf = null)}>{t('关闭')}</button></div>
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
  .pp-gap { margin-top: 16px; }
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
