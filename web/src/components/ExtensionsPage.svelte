<script>
  // 扩展中心 — Claude Desktop「Customize」同款：技能 / 连接器 / 插件三类，每个扩展
  // 按 agent（Claude Code / dimensio）勾选生效。入口在设置 →「自定义」（admin 探针通过才显示）；
  // 数据面 = /api/extensions*（admin 门，可远程）。盖在设置对话框之上，自带磨砂罩 + .sa-* 玻璃控件。
  import './admin/admin.css';
  import { ui } from '../lib/state.svelte.js';
  import { extensionsNav } from '../lib/extensionsNav.svelte.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { api, authHeaders } from '../lib/api.js';
  import { apiUrl } from '../lib/server.js';
  import { renderMarkdown } from '../lib/md.js';
  import { fileDrop } from '../lib/dropPaste.js';
  import { t, tc, tr, locale, isEn } from '../lib/i18n.js';

  let closing = $state(false);
  function close() {
    if (closing) return;
    closing = true;
    setTimeout(() => { ui.extensionsOpen = false; closing = false; }, 260);
  }

  // —— 数据 ——
  let items = $state([]);
  let support = $state({});
  // G10：服务端诊断（注册表坏了、连接器凭据解不开、技能目录没了）——以前这些全是静默的
  let diagnostics = $state([]);
  let loaded = $state(false);
  let loadErr = $state('');
  async function load() {
    try {
      const r = await api.get('/api/extensions');
      items = r.items || [];
      support = r.support || {};
      diagnostics = Array.isArray(r.diagnostics) ? r.diagnostics : [];
      loaded = true; loadErr = '';
    } catch (e) { loadErr = errMsg(e); loaded = true; }
  }
  // 首载完成后消费一次直达句柄（「自定义」页点「管理文件」→ 详情；「添加 → 连接器」→ 表单）
  $effect(() => {
    load().then(() => {
      const hit = navId && items.find((x) => x.id === navId);
      if (hit) openDetail(hit);
      else if (navAction === 'connector') openConnForm();
    });
  });

  // 服务端报错原文 → 显示用（英文界面经 tr() 翻译；本页所有 errMsg 结果都只用于显示）
  const errMsg = (e) => tr((e?.body && typeof e.body === 'object' ? e.body.error : typeof e?.body === 'string' ? e.body : '') || e?.message || String(e));

  // —— toast / confirm（页内自足，样式走 .sa-toast / .sa-modal）——
  let toast = $state({ on: false, msg: '', err: false });
  let toastTimer;
  function showToast(msg, err = false) {
    toast = { on: true, msg, err };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = { ...toast, on: false }; }, 2600);
  }
  let confirmState = $state(null);   // { title, desc, yes, danger, resolve }
  const askConfirm = (opts) => new Promise((resolve) => { confirmState = { ...opts, resolve }; });
  function settleConfirm(v) { const r = confirmState?.resolve; confirmState = null; r && r(v); }

  // —— 类型导航 ——
  const G = {
    sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18.2l-1.8-5.6L4.7 10.8 10.2 9z"/><path d="M19 3v3.4M20.7 4.7h-3.4M5.2 17.6v2.8M6.6 19H3.8"/></svg>',
    plug: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3.5V8M15 3.5V8"/><path d="M7 8h10v3.5a5 5 0 0 1-5 5 5 5 0 0 1-5-5z"/><path d="M12 16.5v4"/></svg>',
    puzzle: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linejoin="round"><path d="M10 4.5a1.8 1.8 0 1 1 3.6 0H17a1.4 1.4 0 0 1 1.4 1.4v3.3a1.8 1.8 0 1 0 0 3.6v3.3A1.4 1.4 0 0 1 17 17.5h-3.3a1.8 1.8 0 1 0-3.6 0H7a1.4 1.4 0 0 1-1.4-1.4v-3.4a1.8 1.8 0 1 1 0-3.6V5.9A1.4 1.4 0 0 1 7 4.5z"/></svg>',
    box: '<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 4 7v10l8 4 8-4V7z"/><path d="m4 7 8 4 8-4M12 11v10"/></svg>',
  };
  const TYPES = [
    // count / pkgCount / empty：「{n} 个{类型}」「还没有{类型}」按类型整句翻（英文要单复数、语序不同）
    { key: 'skill', label: t('技能'), c: '#bf5af2', g: G.sparkles,
      count: (n) => t('{n} 个技能', { n }), pkgCount: (n) => t('包 · {n} 个技能', { n }), empty: t('还没有技能') },
    { key: 'connector', label: t('连接器'), c: '#0a84ff', g: G.plug,
      count: (n) => t('{n} 个连接器', { n }), pkgCount: (n) => t('包 · {n} 个连接器', { n }), empty: t('还没有连接器') },
    { key: 'plugin', label: t('插件'), c: '#ff9500', g: G.puzzle,
      count: (n) => t('{n} 个插件', { n }), pkgCount: (n) => t('包 · {n} 个插件', { n }), empty: t('还没有插件') },
  ];
  // 当前类型分页（叫 curType 不叫 type：模板表达式以 type 开头会被 Svelte 当 TS 声明标签）。
  // 初值可被外部直达句柄预置（设置→扩展分区点「连接器/插件」行直落对应类目），消费一次即清。
  let curType = $state(extensionsNav.type || 'skill');
  const navId = extensionsNav.id;
  const navAction = extensionsNav.action;
  extensionsNav.type = null; extensionsNav.id = null; extensionsNav.action = null;
  const list = $derived(items.filter((x) => x.type === curType));
  const countOf = (k) => items.filter((x) => x.type === k).length;
  const typeDef = $derived(TYPES.find((ty) => ty.key === curType));

  // —— 包分组：有 pkg 的归包管理（卡片+整包操作），无 pkg 的散装项维持单行列表 ——
  const groups = $derived.by(() => {
    const m = new Map();
    for (const x of list) {
      if (!x.pkg) continue;
      if (!m.has(x.pkg)) m.set(x.pkg, []);
      m.get(x.pkg).push(x);
    }
    return [...m.entries()].map(([pkg, members]) => ({
      pkg, members,
      allOn: members.every((x) => x.enabled),
      size: members.reduce((s, x) => s + (x.size || 0), 0),
      updated: Math.max(0, ...members.map((x) => x.updated || 0)),
    })).sort((a, b) => a.pkg.localeCompare(b.pkg));
  });
  const loose = $derived(list.filter((x) => !x.pkg));
  let selPkg = $state(null);              // 当前打开的包（详情层，与 sel 互斥：成员点开走 sel）
  const pkgGroup = $derived(groups.find((g) => g.pkg === selPkg) || null);

  async function togglePkg(g) {
    const v = !g.allOn;
    items = items.map((x) => (x.pkg === g.pkg ? { ...x, enabled: v } : x));   // 乐观
    try { await api.post('/api/extensions/bulk', { pkg: g.pkg, action: v ? 'enable' : 'disable' }); }
    catch (e) { showToast(errMsg(e), true); }
    finally { await load(); }
  }
  // 包级 agent 三态：on=全部支持成员都勾；off=都没勾；mixed=部分；na=包内无此类型支持
  function pkgAgentState(g, key) {
    const allowed = g.members.filter((x) => agentAllowed(x, key));
    if (!allowed.length) return 'na';
    const on = allowed.filter((x) => x.agents?.[key]).length;
    return on === 0 ? 'off' : on === allowed.length ? 'on' : 'mixed';
  }
  async function togglePkgAgent(g, key) {
    const st = pkgAgentState(g, key);
    if (st === 'na') { showToast(t('包内没有支持 {agent} 的扩展', { agent: key }), true); return; }
    const v = st === 'off';   // off/mixed → 全勾；on → 全摘
    try { await api.post('/api/extensions/bulk', { pkg: g.pkg, action: 'agents', agents: { [key]: v } }); await load(); }
    catch (e) { showToast(errMsg(e), true); }
  }
  async function pkgUninstall(g) {
    const ok = await askConfirm({ title: t('整包卸载「{name}」？', { name: g.pkg }), desc: t('将删除包内 {n} 个扩展的全部文件，并从所有 agent 移除。此操作不可撤销。', { n: g.members.length }), yes: t('整包卸载'), danger: true });
    if (!ok) return;
    try {
      await api.post('/api/extensions/bulk', { pkg: g.pkg, action: 'delete' });
      if (selPkg === g.pkg) selPkg = null;
      showToast(t('已整包卸载'));
      load();
    } catch (e) { showToast(errMsg(e), true); }
  }

  const FOOT = {
    skill: t('技能是带 YAML frontmatter 的 SKILL.md 指引包（可含脚本等附属文件）。对 Claude Code 下一条消息即生效；对 dimensio 在新会话生效。'),
    connector: t('连接器是外部 MCP 服务，支持 stdio / http / sse 全部传输。对 Claude Code 下一条消息生效，对 dimensio 在新会话生效。'),
    plugin: t('插件是 Claude Code 专属格式（.claude-plugin/plugin.json，含命令 / 子代理 / 技能 / 钩子），仅对 Claude Code 生效，下一条消息即生效。'),
  };

  // —— 详情 ——
  let selId = $state(null);
  const sel = $derived(items.find((x) => x.id === selId) || null);
  let files = $state([]);
  let fileSel = $state('');
  let fileText = $state('');
  let fileBusy = $state(false);
  const TEXT_RE = /\.(md|markdown|txt|json|jsonc|yaml|yml|toml|xml|csv|py|js|mjs|cjs|ts|tsx|jsx|sh|bash|ps1|bat|cmd|css|html|svelte|vue|sql|ini|cfg|conf|env\.example|example)$/i;
  const isMd = (p) => /\.(md|markdown)$/i.test(p);

  async function openDetail(item) {
    selId = item.id;
    files = []; fileSel = ''; fileText = '';
    if (item.type === 'connector') return;
    try {
      const r = await api.get('/api/extensions/files?id=' + encodeURIComponent(item.id));
      files = r.files || [];
      const first = files.find((f) => TEXT_RE.test(f.path));
      if (first) pickFile(first.path);
    } catch (e) { showToast(errMsg(e), true); }
  }
  async function pickFile(p) {
    fileSel = p; fileText = '';
    if (!TEXT_RE.test(p)) return;   // 二进制不拉正文，卡片显示占位
    fileBusy = true;
    try {
      const r = await api.get('/api/extensions/file?id=' + encodeURIComponent(selId) + '&path=' + encodeURIComponent(p));
      fileText = r.text || '';
    } catch (e) { fileText = t('（无法预览：{reason}）', { reason: errMsg(e) }); }
    finally { fileBusy = false; }
  }

  function patchItem(item) { items = items.map((x) => (x.id === item.id ? item : x)); }

  async function toggleEnabled(item) {
    const v = !item.enabled;
    item.enabled = v;   // 乐观翻转，失败回滚
    try { const r = await api.post('/api/extensions/update', { id: item.id, enabled: v }); patchItem(r.item); }
    catch (e) { item.enabled = !v; showToast(errMsg(e), true); }
  }

  // —— 生效 Agent 矩阵 ——
  const AGENTS = [
    { key: 'claude', label: 'Claude Code', hint: t('下一条消息生效') },
    { key: 'dimensio', label: 'dimensio', hint: t('新会话生效') },
  ];
  function agentAllowed(item, key) {
    const s = support[item.type]?.[key];
    if (!s) return false;
    if (s === 'stdio' && item.type === 'connector' && item.connector?.transport !== 'stdio') return false;
    return true;
  }
  function agentDeniedWhy(item, key) {
    if (item.type === 'plugin') return t('仅 Claude Code 支持插件');
    return t('该类型不支持');
  }
  async function toggleAgent(item, key) {
    if (!agentAllowed(item, key)) { showToast(agentDeniedWhy(item, key), true); return; }
    const v = !item.agents?.[key];
    try { const r = await api.post('/api/extensions/update', { id: item.id, agents: { [key]: v } }); patchItem(r.item); }
    catch (e) { showToast(errMsg(e), true); }
  }

  // —— 上传（技能 .md/.zip/.skill；插件 .zip）——
  let upOpen = $state(false);
  let upBusy = $state(false);
  let upErr = $state('');
  let upDrag = $state(false);
  let upReplace = $state(null);   // 替换目标 item（详情页「替换」入口）
  let upPkg = $state('');         // 新上传可指定所属包（散装留空；替换时继承原包）
  let upInput;   // 隐藏 input
  function openUpload(replaceItem = null) { upReplace = replaceItem; upPkg = ''; upErr = ''; upOpen = true; }
  async function doUpload(fs) {
    const f = fs && fs[0];
    if (!f || upBusy) return;
    const ty = upReplace ? upReplace.type : curType;
    const ok = ty === 'plugin' ? /\.zip$/i.test(f.name) : /\.(md|zip|skill)$/i.test(f.name);
    if (!ok) { upErr = ty === 'plugin' ? t('插件请上传 .zip 包') : t('技能支持 .md / .zip / .skill 文件'); return; }
    upBusy = true; upErr = '';
    try {
      const q = `/api/extensions/upload?type=${ty}&name=${encodeURIComponent(f.name)}` + (upReplace ? `&replace=${encodeURIComponent(upReplace.id)}` : '') + (!upReplace && upPkg.trim() ? `&pkg=${encodeURIComponent(upPkg.trim())}` : '');
      const r = await api.post(q, f);
      upOpen = false;
      showToast(upReplace ? t('已替换「{name}」', { name: r.item.name }) : t('已添加「{name}」', { name: r.item.name }));
      await load();
      if (upReplace || selId) { const cur = items.find((x) => x.id === r.item.id); if (cur && selId) openDetail(cur); }
    } catch (e) { upErr = errMsg(e); }
    finally { upBusy = false; upReplace = upOpen ? upReplace : null; }
  }

  // —— 连接器表单 ——
  const emptyConn = () => ({ id: '', name: '', description: '', transport: 'stdio', command: '', argsText: '', envText: '', url: '', headersText: '' });
  let connOpen = $state(false);
  let connBusy = $state(false);
  let connErr = $state('');
  let conn = $state(emptyConn());
  const kvText = (o) => Object.entries(o || {}).map(([k, v]) => `${k}=${v}`).join('\n');
  const kvParse = (s) => {
    const o = {};
    for (const line of String(s || '').split('\n')) {
      const i = line.indexOf('=');
      if (i > 0) { const k = line.slice(0, i).trim(); if (k) o[k] = line.slice(i + 1).trim(); }
    }
    return o;
  };
  function openConnForm(item = null) {
    connErr = '';
    conn = item ? {
      id: item.id, name: item.name, description: item.description || '',
      transport: item.connector?.transport || 'stdio',
      command: item.connector?.command || '',
      argsText: (item.connector?.args || []).join('\n'),
      envText: kvText(item.connector?.env),
      url: item.connector?.url || '',
      headersText: kvText(item.connector?.headers),
    } : emptyConn();
    connOpen = true;
  }
  async function saveConn() {
    if (connBusy) return;
    connBusy = true; connErr = '';
    try {
      const body = {
        ...(conn.id ? { id: conn.id } : {}),
        name: conn.name, description: conn.description, transport: conn.transport,
        command: conn.command,
        args: conn.argsText.split('\n').map((s) => s.trim()).filter(Boolean),
        env: kvParse(conn.envText),
        url: conn.url,
        headers: kvParse(conn.headersText),
      };
      const r = await api.post('/api/extensions/connector', body);
      connOpen = false;
      showToast(conn.id ? t('已保存') : t('已添加「{name}」', { name: r.item.name }));
      await load();
    } catch (e) { connErr = errMsg(e); }
    finally { connBusy = false; }
  }

  // —— 下载 / 卸载 ——
  async function download(item) {
    try {
      const res = await fetch(apiUrl('/api/extensions/download?id=' + encodeURIComponent(item.id)), { headers: authHeaders(), credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = item.name + '.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { showToast(t('下载失败：{reason}', { reason: errMsg(e) }), true); }
  }
  async function uninstall(item) {
    const ok = await askConfirm({ title: t('卸载「{name}」？', { name: item.name }), desc: t('将删除它的全部文件，并从所有 agent 移除。此操作不可撤销。'), yes: t('卸载'), danger: true });
    if (!ok) return;
    try {
      await api.post('/api/extensions/delete', { id: item.id });
      if (selId === item.id) selId = null;
      showToast(t('已卸载'));
      load();
    } catch (e) { showToast(errMsg(e), true); }
  }

  // —— 返回逐级关：确认 → 弹窗 → 详情 → 包 → 整页（安卓返回 / Esc 同一栈）——
  $effect(() => pushBackLayer(() => {
    if (confirmState) { settleConfirm(false); return; }
    if (upOpen) { upOpen = false; upReplace = null; return; }
    if (connOpen) { connOpen = false; return; }
    if (selId) { selId = null; return; }
    if (selPkg) { selPkg = null; return; }
    close();
  }));
  function onKey(e) {
    if (e.key !== 'Escape') return;
    if (confirmState) { settleConfirm(false); return; }
    if (upOpen) { upOpen = false; upReplace = null; return; }
    if (connOpen) { connOpen = false; return; }
    if (selId) { selId = null; return; }
    if (selPkg) { selPkg = null; return; }
    close();
  }

  const fmtSize = (n) => !n ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  // 中文照旧手拼 2026/9/28；英文走 Intl：Sep 28（今年）/ Sep 28, 2025（往年）。无效日期 Intl 会抛错，先挡掉
  const fmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    if (!isEn()) return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    if (isNaN(d)) return '';
    return new Intl.DateTimeFormat(locale(), { year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' }).format(d);
  };
  const transLabel = { stdio: t('本地命令 (stdio)'), http: t('远程 HTTP'), sse: t('远程 SSE') };
</script>

<svelte:window onkeydown={onKey} />

<div class="sa-root extp" class:closing>
  <div class="frame">
    <!-- 左侧类型导航（宽屏 rail / 窄屏顶部横滑条，与服务端控制台同骨架） -->
    <aside class="rail">
      <div class="brand"><span class="brand-tx">{t('扩展')}</span></div>
      <div class="brand-sub">{t('技能 · 连接器 · 插件')}</div>
      <nav class="nav">
        {#each TYPES as ty (ty.key)}
          <button class="nitem" class:on={curType === ty.key} onclick={() => { curType = ty.key; selId = null; selPkg = null; }}>
            <span class="sa-chip" style="--c:{ty.c}">{@html ty.g}</span>
            <span class="nlab">{ty.label}</span>
            {#if countOf(ty.key)}<span class="npill">{countOf(ty.key)}</span>{/if}
          </button>
        {/each}
      </nav>
      <div class="rail-foot">{t('对 Claude Code · dimensio 按扩展勾选生效')}</div>
    </aside>

    <main class="main">
      <header class="top">
        {#if sel}
          <button class="sa-cbtn" onclick={() => { selId = null; }} aria-label={t('返回列表')} title={t('返回')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>
          </button>
          <h1 class="big sa-trunc">{sel.name}</h1>
        {:else if pkgGroup}
          <button class="sa-cbtn" onclick={() => { selPkg = null; }} aria-label={t('返回列表')} title={t('返回')}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5.5 8.5 12l6.5 6.5"/></svg>
          </button>
          <h1 class="big sa-trunc">{pkgGroup.pkg}</h1>
          <span class="sub">{typeDef.pkgCount(pkgGroup.members.length)}</span>
        {:else}
          <h1 class="big">{typeDef.label}</h1>
          <span class="sub">{list.length ? t('{n} 个已安装', { n: list.length }) : ''}</span>
        {/if}
        <div class="sa-sp"></div>
        {#if !sel && !pkgGroup}
          <button class="sa-btn pri" onclick={() => (curType === 'connector' ? openConnForm() : openUpload())}>
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
            {curType === 'connector' ? t('添加连接器') : curType === 'plugin' ? t('上传插件') : t('上传技能')}
          </button>
        {/if}
        <button class="sa-cbtn" onclick={close} aria-label={t('关闭')} title={t('关闭')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
        </button>
      </header>

      <div class="body">
        {#if !sel}
          {#if pkgGroup}
            <!-- ═══ 包详情：整包开关 + 批量 Agent + 成员 + 整包卸载 ═══ -->
            <div class="det">
              <div class="sa-card det-head">
                <span class="sa-chip det-chip" style="--c:{typeDef.c}">{@html G.box}</span>
                <div class="det-head-tx">
                  <div class="det-name">{pkgGroup.pkg}</div>
                  <div class="det-meta">
                    {typeDef.pkgCount(pkgGroup.members.length)}
                    {#if pkgGroup.size}· {fmtSize(pkgGroup.size)}{/if}
                    {#if pkgGroup.updated}· {fmtTime(pkgGroup.updated)}{/if}
                  </div>
                </div>
                <button class="sa-sw" class:on={pkgGroup.allOn} onclick={() => togglePkg(pkgGroup)} aria-label={t('启用整包')}><span class="sa-sw-knob"></span></button>
              </div>

              <div class="sa-card-h det-sec">{t('生效 Agent（整包批量勾选）')}</div>
              <div class="sa-card">
                <div class="sa-rows">
                  {#each AGENTS as a (a.key)}
                    {@const pst = pkgAgentState(pkgGroup, a.key)}
                    <button class="sa-row ag-row" class:dis={pst === 'na'} onclick={() => togglePkgAgent(pkgGroup, a.key)}>
                      <span class="ack" class:on={pst === 'on'} class:mixed={pst === 'mixed'} aria-hidden="true">
                        {#if pst === 'on'}<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>{/if}
                        {#if pst === 'mixed'}<span class="ack-dash"></span>{/if}
                      </span>
                      <span class="sa-row-tx">
                        <span>{a.label}</span>
                        <small>{pst === 'na' ? t('包内没有支持它的扩展') : pst === 'mixed' ? t('部分成员已勾') : a.hint}</small>
                      </span>
                    </button>
                  {/each}
                </div>
              </div>
              <div class="sa-foot">{t('批量勾选会跳过包内不支持该 agent 的扩展。')}</div>

              <div class="sa-card-h det-sec">{t('包内扩展')}<span class="det-fcount">{pkgGroup.members.length}</span></div>
              <div class="sa-card">
                <div class="sa-rows">
                  {#each pkgGroup.members as item (item.id)}
                    <div class="sa-row">
                      <span class="sa-chip" style="--c:{typeDef.c}; opacity:{item.enabled ? 1 : .45}">{@html typeDef.g}</span>
                      <button class="sa-row-tx rowbtn" onclick={() => openDetail(item)}>
                        <span class="rowname sa-trunc" style:opacity={item.enabled ? 1 : 0.55}>{item.name}</span>
                        <small class="sa-trunc">{item.description || t('（无描述）')}</small>
                      </button>
                      <button class="sa-sw" class:on={item.enabled} onclick={() => toggleEnabled(item)} aria-label={t('启用 {name}', { name: item.name })}><span class="sa-sw-knob"></span></button>
                      <button class="rowchev" onclick={() => openDetail(item)} aria-label={t('查看详情')}>
                        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
                      </button>
                    </div>
                  {/each}
                </div>
              </div>

              <div class="sa-card-h det-sec">{t('管理')}</div>
              <div class="sa-card">
                <div class="sa-rows">
                  <button class="sa-row actrow dgr" onclick={() => pkgUninstall(pkgGroup)}>
                    <span class="sa-row-tx"><span>{t('整包卸载')}</span><small>{t('删除包内 {n} 个扩展并从所有 agent 移除', { n: pkgGroup.members.length })}</small></span>
                  </button>
                </div>
              </div>
            </div>
          {:else}
          <!-- ═══ 列表 ═══ -->
          {#each diagnostics.filter((d) => !d.id || items.find((x) => x.id === d.id)?.type === curType) as d, i (i)}
            <div class="diag" class:err={d.level === 'error'}>{tr(d.msg)}</div>
          {/each}
          {#if !loaded}
            <div class="sa-empty">{t('载入中…')}</div>
          {:else if loadErr}
            <div class="sa-empty">{loadErr}</div>
          {:else if !list.length}
            <div class="sa-card empty-card">
              <div class="empty-ico" style="--c:{typeDef.c}">{@html typeDef.g}</div>
              <div class="empty-t">{typeDef.empty}</div>
              <div class="empty-d">{curType === 'skill' ? t('上传 SKILL.md 或技能包，让 agent 学会新本事') : curType === 'connector' ? t('接入外部 MCP 服务，扩展 agent 的工具面') : t('上传 Claude Code 插件包（命令 / 子代理 / 技能 / 钩子）')}</div>
              <button class="sa-btn pri" onclick={() => (curType === 'connector' ? openConnForm() : openUpload())}>{curType === 'connector' ? t('添加连接器') : curType === 'plugin' ? t('上传插件') : t('上传技能')}</button>
            </div>
          {:else}
            {#if groups.length}
              <div class="pkggrid">
                {#each groups as g (g.pkg)}
                  <div class="sa-card pkgcard">
                    <span class="sa-chip pkg-chip" style="--c:{typeDef.c}; opacity:{g.allOn ? 1 : .45}">{@html G.box}</span>
                    <button class="sa-row-tx rowbtn" onclick={() => { selPkg = g.pkg; }}>
                      <span class="rowname sa-trunc" style:opacity={g.allOn ? 1 : 0.55}>{g.pkg}</span>
                      <small class="sa-trunc">{typeDef.count(g.members.length)}{g.size ? ' · ' + fmtSize(g.size) : ''}</small>
                      <span class="agrow">
                        {#each AGENTS as a (a.key)}
                          {@const gst = pkgAgentState(g, a.key)}
                          {#if gst === 'on'}<span class="agtag">{a.label}</span>
                          {:else if gst === 'mixed'}<span class="agtag mixed">{a.label}</span>{/if}
                        {/each}
                      </span>
                    </button>
                    <button class="sa-sw" class:on={g.allOn} onclick={() => togglePkg(g)} aria-label={t('启用整包 {name}', { name: g.pkg })}><span class="sa-sw-knob"></span></button>
                    <button class="rowchev" onclick={() => { selPkg = g.pkg; }} aria-label={t('管理包 {name}', { name: g.pkg })}>
                      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
                    </button>
                  </div>
                {/each}
              </div>
            {/if}
            {#if groups.length && loose.length}<div class="sa-card-h">{t('未分组')}</div>{/if}
            {#if loose.length}
            <div class="sa-card">
              <div class="sa-rows">
                {#each loose as item (item.id)}
                  <div class="sa-row">
                    <span class="sa-chip" style="--c:{typeDef.c}; opacity:{item.enabled ? 1 : .45}">{@html typeDef.g}</span>
                    <button class="sa-row-tx rowbtn" onclick={() => openDetail(item)}>
                      <span class="rowname sa-trunc" style:opacity={item.enabled ? 1 : 0.55}>{item.name}</span>
                      <small class="sa-trunc">{item.description || t('（无描述）')}</small>
                      <span class="agrow">
                        {#each AGENTS as a (a.key)}
                          {#if item.agents?.[a.key] && agentAllowed(item, a.key)}<span class="agtag">{a.label}</span>{/if}
                        {/each}
                      </span>
                    </button>
                    <button class="sa-sw" class:on={item.enabled} onclick={() => toggleEnabled(item)} aria-label={t('启用 {name}', { name: item.name })}><span class="sa-sw-knob"></span></button>
                    <button class="rowchev" onclick={() => openDetail(item)} aria-label={t('查看详情')}>
                      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
                    </button>
                  </div>
                {/each}
              </div>
            </div>
            {/if}
          {/if}
          <div class="sa-foot">{FOOT[curType]}</div>
          {/if}
        {:else}
          <!-- ═══ 详情 ═══ -->
          <div class="det">
            <!-- 头卡：图标 + 名称 + 元信息 + 总开关 -->
            <div class="sa-card det-head">
              <span class="sa-chip det-chip" style="--c:{TYPES.find((ty) => ty.key === sel.type)?.c}">{@html TYPES.find((ty) => ty.key === sel.type)?.g}</span>
              <div class="det-head-tx">
                <div class="det-name">{sel.name}</div>
                <div class="det-meta">
                  {TYPES.find((ty) => ty.key === sel.type)?.label}
                  {#if sel.version}· v{sel.version}{/if}
                  {#if sel.files}· {t('{n} 个文件', { n: sel.files })}{/if}
                  {#if sel.size}· {fmtSize(sel.size)}{/if}
                  {#if sel.updated}· {fmtTime(sel.updated)}{/if}
                  {#if sel.pkg}· {t('包')} <button class="pkglink" onclick={() => { const p = sel.pkg; selId = null; selPkg = p; }}>{sel.pkg}</button>{/if}
                </div>
              </div>
              <button class="sa-sw" class:on={sel.enabled} onclick={() => toggleEnabled(sel)} aria-label={t('启用')}><span class="sa-sw-knob"></span></button>
            </div>
            {#if sel.description}<div class="det-desc">{sel.description}</div>{/if}

            <!-- 生效 Agent 矩阵 -->
            <div class="sa-card-h det-sec">{t('生效 Agent')}</div>
            <div class="sa-card">
              <div class="sa-rows">
                {#each AGENTS as a (a.key)}
                  {@const allowed = agentAllowed(sel, a.key)}
                  {@const on = allowed && !!sel.agents?.[a.key]}
                  <button class="sa-row ag-row" class:dis={!allowed} onclick={() => toggleAgent(sel, a.key)}>
                    <span class="ack" class:on aria-hidden="true">
                      {#if on}<svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>{/if}
                    </span>
                    <span class="sa-row-tx">
                      <span>{a.label}</span>
                      <small>{allowed ? a.hint : agentDeniedWhy(sel, a.key)}</small>
                    </span>
                  </button>
                {/each}
              </div>
            </div>
            <div class="sa-foot">{sel.enabled ? t('勾选的 agent 会在其会话里获得此扩展。') : t('此扩展当前已停用，对所有 agent 均不生效。')}</div>

            {#if sel.type === 'connector'}
              <!-- 连接详情 -->
              <div class="sa-card-h det-sec">{t('连接配置')}<span class="sa-sp"></span><button class="sa-btn sm" onclick={() => openConnForm(sel)}>{t('编辑')}</button></div>
              <div class="sa-card">
                <div class="sa-rows">
                  <div class="sa-row"><span class="sa-row-tx"><small>{tc('admin', '传输')}</small><span>{transLabel[sel.connector?.transport] || sel.connector?.transport}</span></span></div>
                  {#if sel.connector?.transport === 'stdio'}
                    <div class="sa-row"><span class="sa-row-tx"><small>{t('命令')}</small><span class="sa-mono det-cmd">{sel.connector?.command} {(sel.connector?.args || []).join(' ')}</span></span></div>
                    {#if Object.keys(sel.connector?.env || {}).length}
                      <div class="sa-row"><span class="sa-row-tx"><small>{t('环境变量')}</small><span class="sa-mono">{Object.keys(sel.connector.env).join(t('、'))}</span></span></div>
                    {/if}
                  {:else}
                    <div class="sa-row"><span class="sa-row-tx"><small>{t('地址')}</small><span class="sa-mono det-cmd">{sel.connector?.url}</span></span></div>
                    {#if Object.keys(sel.connector?.headers || {}).length}
                      <div class="sa-row"><span class="sa-row-tx"><small>{t('请求头')}</small><span class="sa-mono">{Object.keys(sel.connector.headers).join(t('、'))}</span></span></div>
                    {/if}
                  {/if}
                </div>
              </div>
            {:else}
              <!-- 文件预览（SKILL.md 优先，chips 切换） -->
              {#if files.length}
                <div class="sa-card-h det-sec">{tc('admin', '文件')}<span class="det-fcount">{files.length}</span></div>
                <div class="fchips">
                  {#each files.slice(0, 40) as f (f.path)}
                    <button class="sa-chip-btn" class:on={fileSel === f.path} onclick={() => pickFile(f.path)}>{f.path}</button>
                  {/each}
                  {#if files.length > 40}<span class="fmore">{t('… 共 {n} 个', { n: files.length })}</span>{/if}
                </div>
                <div class="sa-card fprev">
                  {#if fileBusy}
                    <div class="sa-empty">{t('读取中…')}</div>
                  {:else if !fileSel}
                    <div class="sa-empty">{t('选择一个文件预览')}</div>
                  {:else if !TEXT_RE.test(fileSel)}
                    <div class="sa-empty">{t('二进制文件 · {size}', { size: fmtSize(files.find((f) => f.path === fileSel)?.size || 0) })}</div>
                  {:else if isMd(fileSel)}
                    <div class="extp-md">{@html renderMarkdown(fileText)}</div>
                  {:else}
                    <pre class="fpre">{fileText}</pre>
                  {/if}
                </div>
              {/if}
            {/if}

            <!-- 操作 -->
            <div class="sa-card-h det-sec">{t('管理')}</div>
            <div class="sa-card">
              <div class="sa-rows">
                {#if sel.type !== 'connector'}
                  <button class="sa-row actrow" onclick={() => openUpload(sel)}>
                    <span class="sa-row-tx"><span>{t('替换')}</span><small>{t('上传新版本覆盖，保留开关与 agent 勾选')}</small></span>
                  </button>
                  <button class="sa-row actrow" onclick={() => download(sel)}>
                    <span class="sa-row-tx"><span>{t('下载')}</span><small>{t('打包为 zip 存到本地')}</small></span>
                  </button>
                {/if}
                <button class="sa-row actrow dgr" onclick={() => uninstall(sel)}>
                  <span class="sa-row-tx"><span>{t('卸载')}</span><small>{t('删除文件并从所有 agent 移除')}</small></span>
                </button>
              </div>
            </div>
          </div>
        {/if}
      </div>
    </main>
  </div>

  <!-- 上传弹窗 -->
  {#if upOpen}
    <button class="sa-mask" aria-label={t('取消')} onclick={() => { if (!upBusy) { upOpen = false; upReplace = null; } }}></button>
    <div class="sa-modal">
      <h3>{upReplace ? t('替换「{name}」', { name: upReplace.name }) : curType === 'plugin' ? t('上传插件') : t('上传技能')}</h3>
      <button class="drop" class:drag={upDrag} class:busy={upBusy}
        use:fileDrop={{ onEnter: () => { upDrag = true; }, onLeave: () => { upDrag = false; }, onDrop: doUpload }}
        onclick={() => upInput && upInput.click()}>
        {#if upBusy}
          <span class="drop-busy"></span>
          <span class="drop-t">{t('正在上传解析…')}</span>
        {:else}
          <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4 16.5V18a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 18v-1.5"/><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5"/></svg>
          <span class="drop-t">{t('拖拽到这里，或点击选择文件')}</span>
        {/if}
      </button>
      <input bind:this={upInput} type="file" accept={(upReplace ? upReplace.type : curType) === 'plugin' ? '.zip' : '.md,.zip,.skill'} style="display:none" onchange={(e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; doUpload(fs); }} />
      {#if !upReplace}
        <div class="sa-lab">{t('所属包（可选）')}</div>
        <input class="sa-in" placeholder={t('同包名的扩展归为一组统一管理；留空为散装')} bind:value={upPkg} />
      {/if}
      <p class="req">
        {(upReplace ? upReplace.type : curType) === 'plugin'
          ? t('文件要求：.zip 包内需含 .claude-plugin/plugin.json')
          : t('文件要求：.md 文件需含 YAML frontmatter 的 name 与 description；.zip / .skill 包内需含 SKILL.md')}
      </p>
      {#if upErr}<div class="sa-err">{upErr}</div>{/if}
      <div class="acts"><button class="sa-btn" disabled={upBusy} onclick={() => { upOpen = false; upReplace = null; }}>{t('取消')}</button></div>
    </div>
  {/if}

  <!-- 连接器表单弹窗 -->
  {#if connOpen}
    <button class="sa-mask" aria-label={t('取消')} onclick={() => { if (!connBusy) connOpen = false; }}></button>
    <div class="sa-modal conn-modal">
      <h3>{conn.id ? t('编辑连接器') : t('添加连接器')}</h3>
      <div class="sa-lab">{t('名称')}</div>
      <input class="sa-in" placeholder={t('如 github-mcp')} bind:value={conn.name} />
      <div class="sa-lab">{t('描述（可选）')}</div>
      <input class="sa-in" placeholder={t('一句话说明它提供什么工具')} bind:value={conn.description} />
      <div class="sa-lab">{tc('admin', '传输')}</div>
      <div class="sa-chips">
        {#each ['stdio', 'http', 'sse'] as tp (tp)}
          <button class="sa-chip-btn" class:on={conn.transport === tp} onclick={() => { conn.transport = tp; }}>{transLabel[tp]}</button>
        {/each}
      </div>
      {#if conn.transport === 'stdio'}
        <div class="sa-lab">{t('启动命令')}</div>
        <input class="sa-in sa-mono" placeholder={t('如 npx 或 node 或绝对路径')} bind:value={conn.command} />
        <div class="sa-lab">{t('参数（每行一个，可选）')}</div>
        <textarea class="sa-in ta sa-mono" rows="3" placeholder={'-y\n@modelcontextprotocol/server-github'} bind:value={conn.argsText}></textarea>
        <div class="sa-lab">{t('环境变量（每行 KEY=VALUE，可选）')}</div>
        <textarea class="sa-in ta sa-mono" rows="2" placeholder="GITHUB_TOKEN=ghp_xxx" bind:value={conn.envText}></textarea>
        {#if conn.id && conn.envText}<div class="conn-hint">{t('值加密存在服务端，这里只显示 ••••••••：不改就原样保留，要换就把那一行改成新值，删掉那一行就是删掉它。')}</div>{/if}
      {:else}
        <div class="sa-lab">{t('服务地址')}</div>
        <input class="sa-in sa-mono" placeholder="https://mcp.example.com/v1" bind:value={conn.url} />
        <div class="sa-lab">{t('请求头（每行 KEY=VALUE，可选）')}</div>
        <textarea class="sa-in ta sa-mono" rows="2" placeholder="Authorization=Bearer xxx" bind:value={conn.headersText}></textarea>
        {#if conn.id && conn.headersText}<div class="conn-hint">{t('值加密存在服务端，这里只显示 ••••••••：不改就原样保留，要换就把那一行改成新值，删掉那一行就是删掉它。')}</div>{/if}
      {/if}
      {#if connErr}<div class="sa-err">{connErr}</div>{/if}
      <div class="acts">
        <button class="sa-btn" disabled={connBusy} onclick={() => { connOpen = false; }}>{t('取消')}</button>
        <button class="sa-btn pri" disabled={connBusy} onclick={saveConn}>{connBusy ? t('保存中…') : t('保存')}</button>
      </div>
    </div>
  {/if}

  <!-- 确认弹窗 -->
  {#if confirmState}
    <button class="sa-mask" aria-label={t('取消')} onclick={() => settleConfirm(false)}></button>
    <div class="sa-modal">
      <h3>{confirmState.title}</h3>
      {#if confirmState.desc}<p>{confirmState.desc}</p>{/if}
      <div class="acts">
        <button class="sa-btn" onclick={() => settleConfirm(false)}>{t('取消')}</button>
        <button class="sa-btn {confirmState.danger ? 'dgr' : 'pri'}" onclick={() => settleConfirm(true)}>{confirmState.yes}</button>
      </div>
    </div>
  {/if}

  <div class="sa-toast" class:on={toast.on} class:err={toast.err}>{toast.msg}</div>
</div>

<style>
  /* 全屏深色 tint：磨砂来自下层设置页的罩（同屏单层 backdrop 铁律） */
  .extp {
    position: fixed; inset: 0; z-index: 62; display: flex;
    background: rgba(9, 11, 16, .74);
    -webkit-backdrop-filter: blur(26px) saturate(1.12);
    backdrop-filter: blur(26px) saturate(1.12);
    animation: extp-in var(--mo-base) var(--ea-fade);
    transition: opacity var(--mo-quick) var(--ea-fade);
  }
  @keyframes extp-in { from { opacity: 0; } }
  .extp.closing { opacity: 0; pointer-events: none; }

  .frame { flex: 1; display: flex; min-width: 0; padding: max(14px, var(--sat)) 16px max(14px, var(--sab)); gap: 14px; }

  /* —— 左侧玻璃导航（ServerAdmin 同款）—— */
  .rail {
    width: 212px; flex: none; display: flex; flex-direction: column; border-radius: 26px; padding: 16px 10px 12px;
    background: var(--sa-chrome); box-shadow: var(--sa-chrome-hair);
    animation: extp-rail var(--mo-base) var(--ea-decel) backwards;
  }
  @keyframes extp-rail { from { opacity: 0; transform: translateX(-14px); } }
  .brand { display: flex; align-items: center; gap: 9px; padding: 2px 10px 1px; }
  .brand-tx { font-size: 15.5px; font-weight: 700; letter-spacing: .2px; }
  .brand-sub { font-size: 10.5px; color: var(--sa-tx3); padding: 3px 10px 12px; }
  .nav { display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
  .nitem { display: flex; align-items: center; gap: 10px; padding: 7px 9px; border-radius: 13px; border: 0; background: none;
    color: rgba(255,255,255,.88); font: inherit; font-size: 13.5px; cursor: pointer; text-align: left;
    transition: background var(--mo-micro) var(--ea-fade); min-height: 43px; }
  .nitem:hover { background: rgba(255,255,255,.09); }
  .nitem.on { background: var(--sa-blue); color: #fff; font-weight: 600; box-shadow: inset 0 .5px .5px rgba(255,255,255,.3), 0 4px 14px rgba(10,132,255,.28); }
  .nlab { flex: 1; min-width: 0; }
  .npill { min-width: 19px; height: 19px; padding: 0 5px; border-radius: 10px; background: rgba(255,255,255,.2); color: #fff;
    font-size: 11px; font-weight: 700; font-family: var(--sa-mono); display: flex; align-items: center; justify-content: center; flex: none; }
  .nitem.on .npill { background: rgba(255,255,255,.28); }
  .rail-foot { margin-top: auto; padding: 10px 10px 2px; font-size: 10.5px; line-height: 1.5; color: var(--sa-tx3); border-top: .5px solid rgba(255,255,255,.1); }

  /* —— 主区 —— */
  /* min-height:0 必须有：窄屏 .frame 转纵向后 .main 是纵向 flex 子项，min-height 默认 auto
     会被列表内容撑破视口，.body 的 overflow-y 永远不触发（手机端扩展页滚不动的元凶）。 */
  .main { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
  .top { flex: none; display: flex; align-items: center; gap: 12px; padding: 4px 4px 12px; }
  .big { font-size: 28px; font-weight: 700; letter-spacing: .2px; color: #fff; min-width: 0; }
  .sub { font-size: 12.5px; color: var(--sa-tx3); padding-top: 8px; white-space: nowrap; }
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 4px 10px; overscroll-behavior: contain; }

  /* —— 列表行 —— */
  .rowbtn { border: 0; background: none; cursor: pointer; padding: 0; font: inherit; }
  .rowname { font-size: 14.5px; font-weight: 600; }
  .agrow { display: flex; gap: 5px; margin-top: 1px; flex-wrap: wrap; }
  .agtag { font-size: 10px; font-weight: 650; padding: 1.5px 7px; border-radius: 20px; background: rgba(10,132,255,.16); color: #79b8ff; }
  .agtag.mixed { background: rgba(255,214,10,.16); color: #ffd60a; }
  .rowchev { border: 0; background: none; color: var(--sa-tx3); cursor: pointer; padding: 4px; flex: none; display: flex; }

  /* —— 包卡片网格（参考 kimi 插件页：包为管理单位）—— */
  .pkggrid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 10px; margin-bottom: 4px; }
  .pkgcard { display: flex; align-items: center; gap: 12px; padding: 14px 15px; }
  .pkgcard .sa-row-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; text-align: left; }
  .pkg-chip { width: 40px; height: 40px; border-radius: 11px; flex: none; }
  .pkg-chip :global(svg) { width: 22px; height: 22px; }
  .pkglink { border: 0; background: none; color: #79b8ff; cursor: pointer; font: inherit; padding: 0; }
  .pkglink:hover { text-decoration: underline; }
  .ack.mixed { background: rgba(10,132,255,.45); box-shadow: inset 0 .5px .5px rgba(255,255,255,.4); }
  .ack-dash { width: 10px; height: 2.4px; border-radius: 2px; background: #fff; }

  /* —— 空态 —— */
  .empty-card { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 44px 24px; text-align: center; }
  /* G10：诊断（error 同 .sa-err 的红；warn 用琥珀） */
  .diag { background: rgba(255,159,10,.14); color: #ffb340; font-size: 12.5px; line-height: 1.55; padding: 9px 12px; border-radius: 10px; margin-bottom: 10px; overflow-wrap: anywhere; }
  .diag.err { background: rgba(255,69,58,.16); color: #ff8078; }
  .conn-hint { font-size: 11.5px; line-height: 1.5; color: var(--sa-tx3); margin: 5px 2px 0; }
  .empty-ico { width: 54px; height: 54px; border-radius: 14px; background: var(--c); display: flex; align-items: center; justify-content: center;
    box-shadow: inset 0 .5px .5px rgba(255,255,255,.28), 0 8px 24px rgba(0,0,0,.3); margin-bottom: 2px; }
  .empty-ico :global(svg) { width: 30px; height: 30px; }
  .empty-t { font-size: 16.5px; font-weight: 700; }
  .empty-d { font-size: 12.5px; line-height: 1.6; color: var(--sa-tx2); max-width: 320px; margin-bottom: 8px; }

  /* —— 详情 —— */
  .det { max-width: 760px; }
  .det-head { display: flex; align-items: center; gap: 13px; padding: 16px 18px; }
  .det-chip { width: 44px; height: 44px; border-radius: 11px; }
  .det-chip :global(svg) { width: 25px; height: 25px; }
  .det-head-tx { flex: 1; min-width: 0; }
  .det-name { font-size: 17px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .det-meta { font-size: 11.5px; color: var(--sa-tx3); margin-top: 3px; }
  .det-desc { font-size: 13px; line-height: 1.65; color: var(--sa-tx2); padding: 12px 6px 0; }
  .det-sec { padding: 20px 6px 8px; }
  .det-fcount { font-size: 11px; font-weight: 700; font-family: var(--sa-mono); color: var(--sa-tx3); padding-left: 7px; }
  .det-cmd { word-break: break-all; font-size: 12.5px; }

  /* agent 勾选行 */
  .ag-row { cursor: pointer; }
  .ag-row.dis { cursor: default; }
  .ag-row.dis .sa-row-tx { opacity: .38; }
  .ack { width: 24px; height: 24px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
    box-shadow: inset 0 0 0 1.6px rgba(255,255,255,.28); transition: background var(--mo-micro) var(--ea-fade), box-shadow var(--mo-micro) var(--ea-fade); }
  .ack.on { background: var(--sa-blue); box-shadow: inset 0 .5px .5px rgba(255,255,255,.4), 0 2px 8px rgba(10,132,255,.4); }
  .ack :global(svg) { width: 13px; height: 13px; }
  .ag-row.dis .ack { box-shadow: inset 0 0 0 1.6px rgba(255,255,255,.12); }

  /* 文件预览 */
  .fchips { display: flex; gap: 6px; overflow-x: auto; padding: 0 2px 8px; scrollbar-width: none; }
  .fchips::-webkit-scrollbar { display: none; }
  .fchips :global(.sa-chip-btn) { font-family: var(--sa-mono); font-size: 11.5px; font-weight: 500; flex: none; }
  .fmore { font-size: 11px; color: var(--sa-tx3); align-self: center; flex: none; padding: 0 4px; }
  .fprev { padding: 4px 18px; max-height: 46vh; overflow-y: auto; overscroll-behavior: contain; }
  .fpre { font-family: var(--sa-mono); font-size: 12px; line-height: 1.6; color: rgba(255,255,255,.82); white-space: pre-wrap; word-break: break-word; padding: 12px 0; }

  /* md 渲染（自带小型排版，不依赖聊天气泡样式） */
  .extp-md { padding: 14px 0 16px; font-size: 13.5px; line-height: 1.7; color: rgba(255,255,255,.88); }
  .extp-md :global(h1) { font-size: 19px; font-weight: 700; margin: 14px 0 8px; }
  .extp-md :global(h2) { font-size: 16px; font-weight: 700; margin: 14px 0 7px; }
  .extp-md :global(h3), .extp-md :global(h4) { font-size: 14px; font-weight: 650; margin: 12px 0 6px; }
  .extp-md :global(p) { margin: 7px 0; }
  .extp-md :global(ul), .extp-md :global(ol) { margin: 7px 0; padding-left: 22px; }
  .extp-md :global(li) { margin: 3px 0; }
  .extp-md :global(code) { font-family: var(--sa-mono); font-size: 12px; background: rgba(255,255,255,.1); border-radius: 5px; padding: 1.5px 5px; }
  .extp-md :global(pre) { background: rgba(0,0,0,.35); border-radius: 12px; padding: 12px 14px; overflow-x: auto; margin: 9px 0; box-shadow: inset 0 0 0 .5px rgba(255,255,255,.08); }
  .extp-md :global(pre code) { background: none; padding: 0; }
  .extp-md :global(blockquote) { border-left: 3px solid rgba(255,255,255,.22); margin: 8px 0; padding: 2px 0 2px 12px; color: var(--sa-tx2); }
  .extp-md :global(table) { border-collapse: collapse; margin: 9px 0; font-size: 12.5px; }
  .extp-md :global(th), .extp-md :global(td) { border: .5px solid rgba(255,255,255,.16); padding: 5px 10px; }
  .extp-md :global(a) { color: #79b8ff; }
  .extp-md :global(hr) { border: 0; border-top: .5px solid rgba(255,255,255,.14); margin: 12px 0; }

  /* 操作行 */
  .actrow { cursor: pointer; }
  .actrow:hover { background: rgba(255,255,255,.04); }
  .actrow.dgr .sa-row-tx > span { color: #ff8078; }

  /* —— 上传弹窗 —— */
  .drop { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; min-height: 148px;
    border-radius: 16px; border: 1.6px dashed rgba(255,255,255,.28); background: rgba(255,255,255,.05);
    color: var(--sa-tx2); font: inherit; cursor: pointer; transition: all var(--mo-micro) var(--ea-fade); }
  .drop:hover, .drop.drag { border-color: var(--sa-blue); background: rgba(10,132,255,.1); color: #fff; }
  .drop.busy { pointer-events: none; opacity: .8; }
  .drop-t { font-size: 13px; font-weight: 600; }
  .drop-busy { width: 26px; height: 26px; border-radius: 50%; border: 2.5px solid rgba(255,255,255,.2); border-top-color: #fff;
    animation: extp-spin .8s linear infinite; }
  @keyframes extp-spin { to { transform: rotate(360deg); } }
  .req { font-size: 11.5px !important; line-height: 1.6 !important; }

  /* 连接器表单 */
  .conn-modal { max-height: calc(100dvh - 90px); overflow-y: auto; }
  .ta { height: auto; padding: 10px 14px; resize: vertical; line-height: 1.5; font-size: 13px; }

  /* —— 窄屏（手机 / 竖窗）：侧栏变顶部横滑条 —— */
  @media (max-width: 880px) {
    .frame { flex-direction: column; gap: 10px; padding: max(12px, var(--sat)) 12px max(12px, var(--sab)); }
    .rail { width: 100%; flex-direction: row; align-items: center; border-radius: 20px; padding: 8px 10px; gap: 4px; }
    .brand, .brand-sub, .rail-foot { display: none; }
    .nav { flex-direction: row; overflow-x: auto; overflow-y: hidden; scrollbar-width: none; flex: 1; }
    .nav::-webkit-scrollbar { display: none; }
    .nitem { flex: none; min-height: 38px; padding: 5px 10px; }
    .big { font-size: 22px; }
    .top { flex-wrap: wrap; row-gap: 8px; }
    .det { max-width: none; }
    .fprev { max-height: 54vh; }
    .pkggrid { grid-template-columns: 1fr; }
  }
</style>
