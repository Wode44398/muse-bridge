<script>
  // 扩展（设置里的一个分区）—— 官方 Claude 桌面 App「自定义」页同款：
  //   顶部 = 类型标签（技能 / 连接器 / 插件 / 功能扩展）+「我的 / 发现」分段 + 搜索 / 筛选 / 排序 /「添加」菜单；
  //   发现 = 头图（From Anthropic）+「推荐给您」+ 全部，卡片两栏网格，右上「+」一键添加；
  //   我的 = 已装的同款卡片（右上是开关），点卡片在本页推入详情（生效 Agent / 文件 / 替换 / 下载 / 卸载）。
  // 2026-10-20 取代原 ExtensionsPage（盖在设置上的深色玻璃全屏层）：直接长在设置页里——
  //   桌面设置 = 「扩展」分区内容；手机设置 = 推入的子页；单 agent 设置 = 「自定义」分区。
  // 市场数据 = /api/extensions/market（服务端 ext-market.mjs：三个 Anthropic 官方公开市场 + 自加的 GitHub 市场）；
  // 已装数据 = /api/extensions*（admin 门，与以前同一套接口）。样式全在 ./cz.css（.cz 前缀），令牌按明暗就地定义。
  // 两个范围（标题旁的分段）：「我自用」= 只进管理员自己的会话；「全服统一」= 给服务器上所有成员加装（成员的 Claude
  // 会话与定时任务都加载，管理员自己也用得上）。列表、上传、市场「已添加」、包级批量都按当前范围走（?scope= / body.scope）。
  import './cz.css';
  import { ui, agentOn } from '../../lib/state.svelte.js';
  import { extensionsNav } from '../../lib/extensionsNav.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { api, authHeaders } from '../../lib/api.js';
  import { apiUrl } from '../../lib/server.js';
  import { renderMarkdown } from '../../lib/md.js';
  import { fileDrop } from '../../lib/dropPaste.js';
  import { t, tc, tr, locale, isEn } from '../../lib/i18n.js';
  import { ic, HERO_ART } from './icons.js';
  import PluginsPanel from './PluginsPanel.svelte';   // 功能扩展 = bridge 的插件（内含 Agent 区的 ModulesPanel）

  // title：自己画大标题（桌面 / 单 agent 设置）；手机设置页自带 iOS 大标题，传 false
  let { title = true } = $props();
  const dark = $derived(ui.theme !== 'light');
  let rootEl = $state();

  const errMsg = (e) => tr((e?.body && typeof e.body === 'object' ? e.body.error : typeof e?.body === 'string' ? e.body : '') || e?.message || String(e));

  // ═══ 范围 ═══
  const SCOPE_KEY = 'bridge-ext-scope';
  let scope = $state((typeof localStorage !== 'undefined' && localStorage.getItem(SCOPE_KEY)) === 'shared' ? 'shared' : 'admin');
  let counts = $state({ admin: 0, shared: 0 });
  let multiUser = $state(false);
  const shared = $derived(scope === 'shared');
  // 没开多用户时「全服」只有管理员自己用得上，不摆这个切换（已经装过全服扩展的照样摆，免得找不着）
  const showScope = $derived(multiUser || counts.shared > 0 || shared);
  function setScope(v) {
    if (v === scope) return;
    scope = v; stack = []; items = []; loaded = false;
    try { localStorage.setItem(SCOPE_KEY, v); } catch {}
    load();
    if (mk) loadMarket();
  }

  // ═══ 已装 ═══
  let items = $state([]);
  let support = $state({});
  let diagnostics = $state([]);
  let loaded = $state(false);
  let loadErr = $state('');
  async function load() {
    const want = scope;
    try {
      const r = await api.get('/api/extensions?scope=' + want);
      if (want !== scope) return;   // 加载途中切了范围：丢掉旧范围的结果
      items = r.items || [];
      support = r.support || {};
      diagnostics = Array.isArray(r.diagnostics) ? r.diagnostics : [];
      if (r.counts) counts = r.counts;
      multiUser = !!r.multiUser;
      loaded = true; loadErr = '';
    } catch (e) { loadErr = errMsg(e); loaded = true; }
  }
  load();

  // ═══ 市场 ═══
  let mk = $state(null);
  let mkErr = $state('');
  let mkTimer;
  async function loadMarket(refresh = false) {
    clearTimeout(mkTimer);
    try {
      const r = await api.get('/api/extensions/market?scope=' + scope + (refresh ? '&refresh=1' : ''));
      mk = r; mkErr = '';
      if (r.building) mkTimer = setTimeout(() => loadMarket(), 2500);
    } catch (e) { mkErr = errMsg(e); }
  }
  $effect(() => () => clearTimeout(mkTimer));

  // ═══ 类型 / 视图 ═══
  const TYPES = [
    { key: 'skill', label: t('技能'), glyph: 'skill' },
    { key: 'connector', label: t('连接器'), glyph: 'connector' },
    { key: 'plugin', label: t('插件'), glyph: 'plugin' },
    { key: 'module', label: t('功能扩展'), glyph: 'box' },
  ];
  const glyphOf = (type) => TYPES.find((x) => x.key === type)?.glyph || 'box';
  let curType = $state(extensionsNav.type || 'skill');
  extensionsNav.type = null;
  const VIEW_KEY = 'bridge-ext-view';
  let view = $state((typeof localStorage !== 'undefined' && localStorage.getItem(VIEW_KEY)) || 'discover');
  $effect(() => { try { localStorage.setItem(VIEW_KEY, view); } catch {} });
  const isDiscover = $derived(view === 'discover' && curType !== 'module');
  $effect(() => { if (isDiscover && !mk) loadMarket(); });

  let query = $state('');
  let fMarket = $state('');      // 发现：来源市场
  let fCat = $state('');         // 发现：分类
  let fState = $state('');       // 我的：'' | on | off
  let sortBy = $state('rec');    // 发现：rec | name；我的：rec(=名称) | updated
  function setType(k) { curType = k; stack = []; fCat = ''; shown = PAGE; }

  // ═══ 文案 ═══
  const MARKET_LABEL = {
    'anthropics/claude-plugins-official': t('Anthropic 官方目录'),
    'anthropics/knowledge-work-plugins': t('Anthropic 知识工作'),
    'anthropics/skills': t('Anthropic Agent Skills'),
  };
  const mLabel = (repo) => MARKET_LABEL[repo] || repo;
  const CAT = {
    development: t('开发'), productivity: t('效率'), database: t('数据库'), monitoring: t('监控'), security: t('安全'),
    deployment: t('部署'), design: t('设计'), automation: t('自动化'), learning: t('学习'), testing: t('测试'),
    finance: t('金融'), location: t('位置'),
  };
  const catLabel = (c) => CAT[c] || c;
  const count = (type, n) => type === 'skill' ? t('{n} 个技能', { n }) : type === 'connector' ? t('{n} 个连接器', { n }) : t('{n} 个插件', { n });

  // ═══ 头图 / 推荐 ═══
  const HERO = {
    skill: { kind: 'skillpack', key: 'anthropics/knowledge-work-plugins::productivity', eyebrow: 'From Anthropic', title: 'Productivity',
      desc: t('任务、计划与跟进——每天都用得上的一套工具。'), art: 'checklist', tone: 'green' },
    connector: { kind: 'connector', key: 'anthropics/claude-plugins-official::context7::context7', eyebrow: 'Upstash', title: 'Context7',
      desc: t('把各类库最新版本的文档和代码示例实时拉进对话，开箱即用、不用密钥。'), art: 'book', tone: 'blue' },
    plugin: { kind: 'plugin', key: 'anthropics/skills::document-skills', eyebrow: 'From Anthropic', title: 'Document Skills',
      desc: t('Word、Excel、PowerPoint、PDF 的读写与排版，一次装齐。'), art: 'docs', tone: 'clay' },
  };
  const REC = {
    connector: ['context7', 'github', 'linear', 'notion', 'sentry', 'stripe', 'supabase', 'figma', 'atlassian', 'asana'],
    plugin: ['superpowers', 'frontend-design', 'code-review', 'feature-dev', 'pr-review-toolkit', 'commit-commands', 'security-guidance', 'skill-creator', 'claude-md-management', 'plugin-dev'],
  };
  const heroEntry = $derived.by(() => {
    const h = HERO[curType];
    if (!h || !mk) return null;
    const list = h.kind === 'connector' ? mk.connectors : mk.plugins;
    return list?.find((x) => x.key === h.key) || null;
  });

  // ═══ 发现：数据整形 ═══
  const marketList = $derived.by(() => {
    if (!mk) return [];
    if (curType === 'skill') return mk.skills || [];
    if (curType === 'connector') return mk.connectors || [];
    if (curType === 'plugin') {
      const seen = new Set();
      return (mk.plugins || []).filter((p) => (seen.has(p.name) ? false : (seen.add(p.name), true)));
    }
    return [];
  });
  const cats = $derived([...new Set(marketList.map((x) => x.category).filter(Boolean))].sort((a, b) => catLabel(a).localeCompare(catLabel(b))));
  const qlc = $derived(query.trim().toLowerCase());
  const hit = (s) => !qlc || s.toLowerCase().includes(qlc);
  const discFiltered = $derived(marketList.filter((x) => (!fMarket || x.market === fMarket) && (!fCat || x.category === fCat)
    && hit(`${x.name} ${x.title || ''} ${x.description || ''} ${x.pluginTitle || ''} ${x.host || ''}`)));
  const plainDiscover = $derived(!qlc && !fMarket && !fCat && sortBy === 'rec');
  const recList = $derived.by(() => {
    if (!plainDiscover) return [];
    if (curType === 'skill') return discFiltered.filter((x) => x.market === 'anthropics/skills');
    const names = REC[curType] || [];
    return names.map((n) => discFiltered.find((x) => x.name === n)).filter(Boolean);
  });
  const restList = $derived.by(() => {
    const rec = new Set(recList.map((x) => x.key));
    const arr = discFiltered.filter((x) => !rec.has(x.key));
    if (sortBy === 'name') return [...arr].sort((a, b) => (a.title || a.name).localeCompare(b.title || b.name));
    return arr;
  });
  const PAGE = 40;
  let shown = $state(PAGE);
  $effect(() => { qlc; fMarket; fCat; sortBy; curType; view; shown = PAGE; });
  function more(node) {
    const io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) shown += PAGE; }, { rootMargin: '600px' });
    io.observe(node);
    return { destroy() { io.disconnect(); } };
  }

  // 已添加判定：服务端按来源给的 key + 同类型同名兜底
  const instSet = $derived(new Set(mk?.installed || []));
  function isInstalled(kind, e) {
    if (!e) return false;
    if (kind === 'skillpack') {
      const m = (mk?.skills || []).filter((s) => s.market === e.market && s.plugin === e.name);
      return m.length > 0 && m.every((s) => isInstalled('skill', s));
    }
    return instSet.has(`${kind}:${e.key}`) || items.some((x) => x.type === kind && x.name === e.name);
  }
  const srcKey = (it) => {
    const s = it?.source;
    if (!s?.market) return '';
    if (it.type === 'skill' && s.path) return `skill:${s.market}::${s.path}`;
    if (it.type === 'plugin' && s.plugin) return `plugin:${s.market}::${s.plugin}`;
    if (it.type === 'connector' && s.server) return `connector:${s.market}::${s.plugin}::${s.server}`;
    return '';
  };

  let busy = $state({});   // key → true
  async function install(kind, e) {
    if (!e || busy[e.key] || isInstalled(kind, e)) return;
    busy = { ...busy, [e.key]: true };
    try {
      const r = await api.post('/api/extensions/market/install', { kind, key: e.key, scope });
      const got = r.items || [];
      if (mk) mk = { ...mk, installed: [...(mk.installed || []), ...got.map(srcKey).filter(Boolean)] };
      await load();
      if (r.skipped?.length) showToast(t('已添加 {n} 项，{m} 项跳过', { n: got.length, m: r.skipped.length }));
      else showToast(got.length > 1 ? t('已添加 {n} 项', { n: got.length }) : t('已添加「{name}」', { name: got[0]?.name || e.name }));
      // 连接器带 ${占位} 的凭据：直接打开编辑表单让人填
      const c = got.find((x) => x.type === 'connector');
      if (c && kind === 'connector' && needsCreds(e)) { const cur = items.find((x) => x.id === c.id); if (cur) openConnForm(cur); }
    } catch (err) { showToast(errMsg(err), true); }
    finally { const b = { ...busy }; delete b[e.key]; busy = b; }
  }
  const needsCreds = (e) => Object.values({ ...(e.spec?.env || {}), ...(e.spec?.headers || {}) }).some((v) => /\$\{/.test(String(v)));

  // ═══ 我的：数据整形 ═══
  const mineAll = $derived(items.filter((x) => x.type === curType));
  const mineCards = $derived.by(() => {
    const groups = new Map();
    const loose = [];
    for (const x of mineAll) {
      if (fState === 'on' && !x.enabled) continue;
      if (fState === 'off' && x.enabled) continue;
      if (x.pkg) {
        if (!groups.has(x.pkg)) groups.set(x.pkg, []);
        groups.get(x.pkg).push(x);
      } else if (hit(`${x.name} ${x.description || ''}`)) loose.push({ k: 'item', id: x.id, name: x.name, updated: x.updated || 0, item: x });
    }
    const pk = [];
    for (const [pkg, members] of groups) {
      if (!hit(`${pkg} ${members.map((m) => m.name + ' ' + (m.description || '')).join(' ')}`)) continue;
      pk.push({ k: 'pkg', id: 'pkg:' + pkg, name: pkg, members, allOn: members.every((m) => m.enabled), updated: Math.max(0, ...members.map((m) => m.updated || 0)) });
    }
    const cmp = sortBy === 'updated' ? (a, b) => b.updated - a.updated : (a, b) => a.name.localeCompare(b.name);
    return [...pk.sort(cmp), ...loose.sort(cmp)];
  });
  const countOf = (k) => items.filter((x) => x.type === k).length;

  async function toggleEnabled(item) {
    const v = !item.enabled;
    items = items.map((x) => (x.id === item.id ? { ...x, enabled: v } : x));
    try { const r = await api.post('/api/extensions/update', { id: item.id, enabled: v }); patchItem(r.item); }
    catch (e) { patchItem({ ...item, enabled: !v }); showToast(errMsg(e), true); }
  }
  function patchItem(item) { items = items.map((x) => (x.id === item.id ? item : x)); }
  const pkgMembers = (pkg) => items.filter((x) => x.pkg === pkg);
  async function togglePkg(pkg) {
    const ms = pkgMembers(pkg);
    const v = !ms.every((x) => x.enabled);
    items = items.map((x) => (x.pkg === pkg ? { ...x, enabled: v } : x));
    try { await api.post('/api/extensions/bulk', { pkg, scope, action: v ? 'enable' : 'disable' }); }
    catch (e) { showToast(errMsg(e), true); }
    finally { await load(); }
  }

  // ═══ 生效 Agent ═══
  // 全服范围：成员只有 Claude；dimensio / Codex 的勾选只影响管理员自己
  const AGENTS = $derived([
    { key: 'claude', label: 'Claude Code', hint: shared ? t('所有成员下一条消息生效') : t('下一条消息生效') },
    { key: 'dimensio', label: 'dimensio', hint: shared ? t('只对管理员生效 · 新会话') : t('新会话生效') },
    { key: 'codex', label: 'Codex', hint: shared ? t('只对管理员生效 · 新会话') : t('新会话生效') },
  ].filter((a) => a.key === 'claude' || agentOn(a.key)));
  function agentAllowed(item, key) {
    const s = support[item.type]?.[key];
    if (!s) return false;
    if (s === 'stdio' && item.type === 'connector' && item.connector?.transport !== 'stdio') return false;
    return true;
  }
  function agentDeniedWhy(item, key) {
    if (item.type === 'plugin') return t('仅 Claude Code 支持插件');
    if (item.type === 'connector' && key === 'codex') return t('Codex 仅支持 stdio 连接器');
    return t('该类型不支持');
  }
  async function toggleAgent(item, key) {
    if (!agentAllowed(item, key)) { showToast(agentDeniedWhy(item, key), true); return; }
    const v = !item.agents?.[key];
    try { const r = await api.post('/api/extensions/update', { id: item.id, agents: { [key]: v } }); patchItem(r.item); }
    catch (e) { showToast(errMsg(e), true); }
  }
  function pkgAgentState(members, key) {
    const allowed = members.filter((x) => agentAllowed(x, key));
    if (!allowed.length) return 'na';
    const on = allowed.filter((x) => x.agents?.[key]).length;
    return on === 0 ? 'off' : on === allowed.length ? 'on' : 'mixed';
  }
  async function togglePkgAgent(pkg, key) {
    const st = pkgAgentState(pkgMembers(pkg), key);
    if (st === 'na') { showToast(t('包内没有支持 {agent} 的扩展', { agent: key }), true); return; }
    try { await api.post('/api/extensions/bulk', { pkg, scope, action: 'agents', agents: { [key]: st === 'off' } }); await load(); }
    catch (e) { showToast(errMsg(e), true); }
  }
  const agentTags = (it) => AGENTS.filter((a) => it.agents?.[a.key] && agentAllowed(it, a.key)).map((a) => a.label);

  // ═══ 详情栈（本页内推入）═══
  let stack = $state([]);   // { k: 'item', id } | { k: 'pkg', pkg } | { k: 'mk', kind, key }
  const top = $derived(stack[stack.length - 1] || null);
  const selItem = $derived(top?.k === 'item' ? items.find((x) => x.id === top.id) || null : null);
  const selPkg = $derived(top?.k === 'pkg' ? top.pkg : null);
  const selPkgMembers = $derived(selPkg ? pkgMembers(selPkg) : []);
  const selMk = $derived.by(() => {
    if (top?.k !== 'mk' || !mk) return null;
    const list = top.kind === 'skill' ? mk.skills : top.kind === 'connector' ? mk.connectors : mk.plugins;
    return list?.find((x) => x.key === top.key) || null;
  });
  function toTop() {
    const sc = rootEl?.closest('.scroll, .pg-scroll, .main-scroll, .pg-body');
    if (sc) sc.scrollTop = 0;
  }
  function push(v) { stack = [...stack, v]; queueMicrotask(toTop); }
  function pop() { stack = stack.slice(0, -1); }
  function openItem(it) { push({ k: 'item', id: it.id }); loadFiles(it); }
  function openCard(c) { if (c.k === 'pkg') push({ k: 'pkg', pkg: c.name }); else openItem(c.item); }
  function openMk(kind, e) { push({ k: 'mk', kind, key: e.key }); }
  // 包被整包卸载 / 单项被卸载：栈里指向它的层自动退掉
  $effect(() => {
    if (!loaded) return;
    const ok = (v) => v.k === 'item' ? items.some((x) => x.id === v.id) : v.k === 'pkg' ? items.some((x) => x.pkg === v.pkg) : true;
    if (stack.some((v) => !ok(v))) stack = stack.filter(ok);
  });

  // 文件预览
  let files = $state([]);
  let fileSel = $state('');
  let fileText = $state('');
  let fileBusy = $state(false);
  const TEXT_RE = /\.(md|markdown|txt|json|jsonc|yaml|yml|toml|xml|csv|py|js|mjs|cjs|ts|tsx|jsx|sh|bash|ps1|bat|cmd|css|html|svelte|vue|sql|ini|cfg|conf|example)$/i;
  const isMd = (p) => /\.(md|markdown)$/i.test(p);
  // SKILL.md 开头的 YAML frontmatter 按 markdown 渲染会变成「横线 + 粗体大标题」，改成 yaml 代码块
  const fmBlock = (md) => String(md || '').replace(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/, (_, y) => '```yaml\n' + y + '\n```\n\n');
  async function loadFiles(item) {
    files = []; fileSel = ''; fileText = '';
    if (item.type === 'connector') return;
    try {
      const r = await api.get('/api/extensions/files?id=' + encodeURIComponent(item.id));
      files = r.files || [];
      const first = files.find((f) => /(^|\/)SKILL\.md$/i.test(f.path)) || files.find((f) => /plugin\.json$/.test(f.path)) || files.find((f) => TEXT_RE.test(f.path));
      if (first) pickFile(item.id, first.path);
    } catch (e) { showToast(errMsg(e), true); }
  }
  async function pickFile(id, p) {
    fileSel = p; fileText = '';
    if (!TEXT_RE.test(p)) return;
    fileBusy = true;
    try { fileText = (await api.get('/api/extensions/file?id=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(p))).text || ''; }
    catch (e) { fileText = t('（无法预览：{reason}）', { reason: errMsg(e) }); }
    finally { fileBusy = false; }
  }

  // ═══ 上传 ═══
  let upOpen = $state(false), upBusy = $state(false), upErr = $state(''), upDrag = $state(false);
  let upType = $state('skill');
  let upReplace = $state(null);
  let upPkg = $state('');
  let upInput = $state();
  function openUpload(type, replaceItem = null) { upType = replaceItem ? replaceItem.type : type; upReplace = replaceItem; upPkg = ''; upErr = ''; upOpen = true; }
  async function doUpload(fs) {
    const f = fs && fs[0];
    if (!f || upBusy) return;
    const ok = upType === 'plugin' ? /\.zip$/i.test(f.name) : /\.(md|zip|skill)$/i.test(f.name);
    if (!ok) { upErr = upType === 'plugin' ? t('插件请上传 .zip 包') : t('技能支持 .md / .zip / .skill 文件'); return; }
    upBusy = true; upErr = '';
    try {
      const q = `/api/extensions/upload?type=${upType}&name=${encodeURIComponent(f.name)}` + (upReplace ? `&replace=${encodeURIComponent(upReplace.id)}` : '') + (!upReplace && upPkg.trim() ? `&pkg=${encodeURIComponent(upPkg.trim())}` : '') + (!upReplace ? `&scope=${scope}` : '');
      const r = await api.post(q, f);
      upOpen = false;
      showToast(upReplace ? t('已替换「{name}」', { name: r.item.name }) : t('已添加「{name}」', { name: r.item.name }));
      await load();
      if (selItem && selItem.id === r.item.id) loadFiles(r.item);
      if (!upReplace) { curType = upType; view = 'mine'; }
    } catch (e) { upErr = errMsg(e); }
    finally { upBusy = false; if (!upOpen) upReplace = null; }
  }

  // ═══ 连接器表单 ═══
  const emptyConn = () => ({ id: '', name: '', description: '', transport: 'stdio', command: '', argsText: '', envText: '', url: '', headersText: '' });
  let connOpen = $state(false), connBusy = $state(false), connErr = $state('');
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
      transport: item.connector?.transport || 'stdio', command: item.connector?.command || '',
      argsText: (item.connector?.args || []).join('\n'), envText: kvText(item.connector?.env),
      url: item.connector?.url || '', headersText: kvText(item.connector?.headers),
    } : emptyConn();
    connOpen = true;
  }
  async function saveConn() {
    if (connBusy) return;
    connBusy = true; connErr = '';
    try {
      const body = {
        ...(conn.id ? { id: conn.id } : { scope }),
        name: conn.name, description: conn.description, transport: conn.transport, command: conn.command,
        args: conn.argsText.split('\n').map((s) => s.trim()).filter(Boolean),
        env: kvParse(conn.envText), url: conn.url, headers: kvParse(conn.headersText),
      };
      const r = await api.post('/api/extensions/connector', body);
      connOpen = false;
      showToast(conn.id ? t('已保存') : t('已添加「{name}」', { name: r.item.name }));
      await load();
      if (!conn.id) { curType = 'connector'; view = 'mine'; }
    } catch (e) { connErr = errMsg(e); }
    finally { connBusy = false; }
  }
  const transLabel = { stdio: t('本地命令 (stdio)'), http: t('远程 HTTP'), sse: t('远程 SSE') };

  // ═══ 市场源 ═══
  let srcOpen = $state(false), srcBusy = $state(false), srcErr = $state(''), srcRepo = $state('');
  async function addSource() {
    if (srcBusy || !srcRepo.trim()) return;
    srcBusy = true; srcErr = '';
    try {
      await api.post('/api/extensions/market/sources', { action: 'add', repo: srcRepo.trim() });
      srcRepo = ''; showToast(t('已添加市场，正在拉取'));
      await loadMarket(true);
    } catch (e) { srcErr = errMsg(e); }
    finally { srcBusy = false; }
  }
  async function removeSource(repo) {
    try { await api.post('/api/extensions/market/sources', { action: 'remove', repo }); if (fMarket === repo) fMarket = ''; await loadMarket(true); }
    catch (e) { srcErr = errMsg(e); }
  }

  // ═══ 下载 / 卸载 ═══
  async function download(item) {
    try {
      const res = await fetch(apiUrl('/api/extensions/download?id=' + encodeURIComponent(item.id)), { headers: authHeaders(), credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await res.blob());
      a.download = item.name + '.zip';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) { showToast(t('下载失败：{reason}', { reason: errMsg(e) }), true); }
  }
  async function uninstall(item) {
    if (!(await askConfirm({ title: t('卸载「{name}」？', { name: item.name }), desc: shared ? t('将删除它的全部文件，所有成员的会话都不再加载它。此操作不可撤销。') : t('将删除它的全部文件，并从所有 agent 移除。此操作不可撤销。'), yes: t('卸载'), danger: true }))) return;
    try { await api.post('/api/extensions/delete', { id: item.id }); showToast(t('已卸载')); await load(); if (mk) loadMarket(); }
    catch (e) { showToast(errMsg(e), true); }
  }
  async function pkgUninstall(pkg) {
    const n = pkgMembers(pkg).length;
    if (!(await askConfirm({ title: t('整包卸载「{name}」？', { name: pkg }), desc: shared ? t('将删除包内 {n} 个扩展的全部文件，所有成员的会话都不再加载它们。此操作不可撤销。', { n }) : t('将删除包内 {n} 个扩展的全部文件，并从所有 agent 移除。此操作不可撤销。', { n }), yes: t('整包卸载'), danger: true }))) return;
    try { await api.post('/api/extensions/bulk', { pkg, scope, action: 'delete' }); showToast(t('已整包卸载')); await load(); if (mk) loadMarket(); }
    catch (e) { showToast(errMsg(e), true); }
  }

  // ═══ toast / 确认 ═══
  let toast = $state({ on: false, msg: '', err: false });
  let toastTimer;
  function showToast(msg, err = false) {
    toast = { on: true, msg, err };
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast = { ...toast, on: false }; }, 2800);
  }
  let confirmState = $state(null);
  const askConfirm = (opts) => new Promise((resolve) => { confirmState = { ...opts, resolve }; });
  function settleConfirm(v) { const r = confirmState?.resolve; confirmState = null; r && r(v); }

  // ═══ 弹出菜单（添加 / 筛选 / 排序）═══
  let pop_ = $state('');   // '' | add | filter | sort
  function togglePop(k) { pop_ = pop_ === k ? '' : k; }
  function onWinDown(e) { if (pop_ && !e.target.closest?.('.cz-pop, .cz-popbtn')) pop_ = ''; }

  // ═══ 返回：确认 → 弹窗 → 菜单 → 详情栈（设置页自己的返回在最后）═══
  const layerOpen = $derived(!!confirmState || upOpen || connOpen || srcOpen || !!pop_ || stack.length > 0);
  function backOne() {
    if (confirmState) { settleConfirm(false); return; }
    if (upOpen) { if (!upBusy) { upOpen = false; upReplace = null; } return; }
    if (connOpen) { if (!connBusy) connOpen = false; return; }
    if (srcOpen) { srcOpen = false; return; }
    if (pop_) { pop_ = ''; return; }
    if (stack.length) pop();
  }
  $effect(() => { if (layerOpen) return pushBackLayer(backOne); });
  function onKey(e) {
    if (e.key !== 'Escape' || !layerOpen) return;
    e.preventDefault(); e.stopPropagation();
    backOne();
  }

  const fmtSize = (n) => !n ? '' : n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';
  const fmtTime = (ts) => {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d)) return '';
    if (!isEn()) return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
    return new Intl.DateTimeFormat(locale(), { year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric', month: 'short', day: 'numeric' }).format(d);
  };
  const typeLabel = (k) => TYPES.find((x) => x.key === k)?.label || '';
  const addLabel = $derived(curType === 'connector' ? t('添加连接器') : curType === 'plugin' ? t('上传插件') : t('上传技能'));
  function quickAdd() { if (curType === 'connector') openConnForm(); else openUpload(curType === 'plugin' ? 'plugin' : 'skill'); }
  const mkFoot = (kind, e) => kind === 'connector' ? (e.host || mLabel(e.market)) : kind === 'skill' ? `${e.pluginTitle} · ${mLabel(e.market)}` : (e.author || mLabel(e.market));
</script>

<!-- 捕获阶段先接 Esc：设置外壳在冒泡阶段听 Esc 关整页，面板里有层开着时先关面板自己的层 -->
<svelte:window onkeydowncapture={onKey} onpointerdown={onWinDown} />

<!-- ─────────── 片段 ─────────── -->
{#snippet sw(on, onclick, label)}
  <button class="cz-sw" class:on role="switch" aria-checked={on} aria-label={label} onclick={(e) => { e.stopPropagation(); onclick(); }}><span></span></button>
{/snippet}

{#snippet mkCard(kind, e)}
  {@const inst = isInstalled(kind, e)}
  <div class="cz-card" role="button" tabindex="0" onclick={() => openMk(kind, e)} onkeydown={(ev) => { if (ev.key === 'Enter') openMk(kind, e); }}>
    <span class="cz-tile">{@html ic(glyphOf(kind))}</span>
    <div class="cz-body">
      <b class="cz-name">{e.title || e.name}</b>
      <p class="cz-desc">{e.description || (kind === 'connector' ? t('{plugin} 附带的 MCP 服务', { plugin: e.pluginTitle }) : '')}</p>
      <span class="cz-foot">{mkFoot(kind, e)}</span>
    </div>
    <button class="cz-add" class:done={inst} class:busy={busy[e.key]} disabled={inst || busy[e.key]}
      title={inst ? t('已添加') : t('添加')} aria-label={inst ? t('已添加') : t('添加 {name}', { name: e.title || e.name })}
      onclick={(ev) => { ev.stopPropagation(); install(kind, e); }}>
      {#if busy[e.key]}<span class="cz-spin"></span>{:else}{@html ic(inst ? 'check' : 'plus', 1.8)}{/if}
    </button>
  </div>
{/snippet}

{#snippet mineCard(c)}
  {@const on = c.k === 'pkg' ? c.allOn : c.item.enabled}
  {@const tags = c.k === 'pkg' ? AGENTS.filter((a) => ['on', 'mixed'].includes(pkgAgentState(c.members, a.key))).map((a) => a.label) : agentTags(c.item)}
  <div class="cz-card" class:off={!on} role="button" tabindex="0" onclick={() => openCard(c)} onkeydown={(ev) => { if (ev.key === 'Enter') openCard(c); }}>
    <span class="cz-tile">{@html ic(c.k === 'pkg' ? 'box' : glyphOf(curType))}</span>
    <div class="cz-body">
      <b class="cz-name">{c.name}</b>
      <p class="cz-desc">{c.k === 'pkg' ? count(curType, c.members.length) + (c.members.length ? ' · ' + c.members.slice(0, 4).map((m) => m.name).join(t('、')) + (c.members.length > 4 ? ' …' : '') : '') : (c.item.description || t('（无描述）'))}</p>
      <span class="cz-foot">{on ? (tags.length ? tags.join(' · ') : t('未对任何 agent 生效')) : t('已停用')}</span>
    </div>
    {@render sw(on, () => (c.k === 'pkg' ? togglePkg(c.name) : toggleEnabled(c.item)), c.k === 'pkg' ? t('启用整包 {name}', { name: c.name }) : t('启用 {name}', { name: c.name }))}
  </div>
{/snippet}

{#snippet agentRows(rows)}
  <div class="cz-list">
    {#each rows as r (r.key)}
      <button class="cz-li" class:dis={r.na} onclick={r.onclick}>
        <span class="cz-ck" class:on={r.state === 'on'} class:mixed={r.state === 'mixed'}>{#if r.state === 'on'}{@html ic('check', 2.4)}{:else if r.state === 'mixed'}<i></i>{/if}</span>
        <span class="cz-li-tx"><span>{r.label}</span><small>{r.sub}</small></span>
      </button>
    {/each}
  </div>
{/snippet}

<!-- ─────────── 主体 ─────────── -->
<div class="cz" class:light={!dark} bind:this={rootEl}>
  {#if top}
    <!-- ═══ 详情 ═══ -->
    <div class="cz-crumb">
      <button class="cz-back" onclick={pop}>{@html ic('back', 2)}<span>{stack.length > 1 ? t('返回') : typeLabel(curType)}</span></button>
    </div>

    {#if selMk}
      {@const kind = top.kind}
      {@const inst = isInstalled(kind, selMk)}
      <div class="cz-dh">
        <span class="cz-tile lg">{@html ic(glyphOf(kind))}</span>
        <div class="cz-dh-tx">
          <h2>{selMk.title || selMk.name}</h2>
          <p>{mLabel(selMk.market)}{selMk.pluginTitle && kind !== 'plugin' ? ' · ' + selMk.pluginTitle : ''}</p>
        </div>
        <button class="cz-btn pri" disabled={inst || busy[selMk.key]} onclick={() => install(kind, selMk)}>
          {#if busy[selMk.key]}<span class="cz-spin"></span>{t('添加中…')}{:else if inst}{@html ic('check', 2)}{t('已添加')}{:else}{t('添加')}{/if}
        </button>
      </div>
      {#if selMk.description}<p class="cz-lead sel-text">{selMk.description}</p>{/if}
      <div class="cz-sec">{t('详情')}</div>
      <div class="cz-list">
        <div class="cz-kv"><span>{t('类型')}</span><b>{typeLabel(kind)}</b></div>
        <div class="cz-kv"><span>{t('来源')}</span><b>{mLabel(selMk.market)}</b></div>
        {#if kind !== 'plugin' && selMk.pluginTitle}<div class="cz-kv"><span>{t('所属插件')}</span><b>{selMk.pluginTitle}</b></div>{/if}
        {#if selMk.category}<div class="cz-kv"><span>{t('分类')}</span><b>{catLabel(selMk.category)}</b></div>{/if}
        {#if selMk.author}<div class="cz-kv"><span>{t('作者')}</span><b>{selMk.author}</b></div>{/if}
        {#if kind === 'connector'}
          <div class="cz-kv"><span>{tc('admin', '传输')}</span><b>{transLabel[selMk.transport] || selMk.transport}</b></div>
          <div class="cz-kv"><span>{selMk.transport === 'stdio' ? t('命令') : t('地址')}</span><b class="mono">{selMk.transport === 'stdio' ? `${selMk.spec?.command || ''} ${(selMk.spec?.args || []).join(' ')}` : selMk.spec?.url}</b></div>
        {/if}
        {#if kind === 'plugin'}
          {#if selMk.nSkills}<div class="cz-kv"><span>{t('包含技能')}</span><b>{selMk.nSkills}</b></div>{/if}
          {#if selMk.nConns}<div class="cz-kv"><span>{t('包含连接器')}</span><b>{selMk.nConns}</b></div>{/if}
          {#if selMk.srcKind === 'git'}<div class="cz-kv"><span>{t('代码位置')}</span><b>{t('外部仓库，添加时下载')}</b></div>{/if}
        {/if}
        {#if selMk.homepage}<a class="cz-kv link" href={selMk.homepage} target="_blank" rel="noopener noreferrer"><span>{t('主页')}</span><b>{selMk.homepage.replace(/^https?:\/\//, '')}</b>{@html ic('link')}</a>{/if}
      </div>
      {#if kind === 'plugin' && mk}
        {@const inner = (mk.skills || []).filter((s) => s.market === selMk.market && s.plugin === selMk.name)}
        {#if inner.length}
          <div class="cz-sec">{t('插件里的技能')}<span class="cz-n">{inner.length}</span></div>
          <div class="cz-chips">{#each inner as s (s.key)}<button class="cz-chip" onclick={() => openMk('skill', s)}>{s.name}</button>{/each}</div>
        {/if}
      {/if}
      <p class="cz-note">{kind === 'plugin' ? t('插件是 Claude Code 专属格式，只对 Claude Code 生效；里面的技能想给 dimensio、Codex 用，可以在「技能」里单独添加。') : kind === 'connector' ? (needsCreds(selMk) ? t('这个连接器要填凭据（${…} 占位），添加后会打开编辑表单。') : t('远程连接器若要求 OAuth 登录，需要服务支持令牌请求头，否则添加后连不上。')) : t('技能对 Claude Code 下一条消息生效，对 dimensio 与 Codex 在新会话生效。')}</p>

    {:else if selPkg}
      {@const ms = selPkgMembers}
      {@const allOn = ms.every((x) => x.enabled)}
      <div class="cz-dh">
        <span class="cz-tile lg">{@html ic('box')}</span>
        <div class="cz-dh-tx">
          <h2>{selPkg}</h2>
          <p>{count(curType, ms.length)}{ms.reduce((s, x) => s + (x.size || 0), 0) ? ' · ' + fmtSize(ms.reduce((s, x) => s + (x.size || 0), 0)) : ''}</p>
        </div>
        {@render sw(allOn, () => togglePkg(selPkg), t('启用整包'))}
      </div>
      <div class="cz-sec">{t('生效 Agent')}</div>
      {@render agentRows(AGENTS.map((a) => { const st = pkgAgentState(ms, a.key); return { key: a.key, label: a.label, state: st, na: st === 'na',
        sub: st === 'na' ? t('包内没有支持它的扩展') : st === 'mixed' ? t('部分成员已勾') : a.hint, onclick: () => togglePkgAgent(selPkg, a.key) }; }))}
      <div class="cz-sec">{t('包内扩展')}<span class="cz-n">{ms.length}</span></div>
      <div class="cz-list">
        {#each ms as it (it.id)}
          <div class="cz-li row" role="button" tabindex="0" onclick={() => openItem(it)} onkeydown={(ev) => { if (ev.key === 'Enter') openItem(it); }}>
            <span class="cz-tile sm">{@html ic(glyphOf(it.type))}</span>
            <span class="cz-li-tx" class:dim={!it.enabled}><span>{it.name}</span><small>{it.description || t('（无描述）')}</small></span>
            {@render sw(it.enabled, () => toggleEnabled(it), t('启用 {name}', { name: it.name }))}
            <span class="cz-chev">{@html ic('chevRight')}</span>
          </div>
        {/each}
      </div>
      <div class="cz-sec">{t('管理')}</div>
      <div class="cz-list"><button class="cz-li act danger" onclick={() => pkgUninstall(selPkg)}><span class="cz-li-tx"><span>{t('整包卸载')}</span></span></button></div>

    {:else if selItem}
      {@const it = selItem}
      <div class="cz-dh">
        <span class="cz-tile lg">{@html ic(glyphOf(it.type))}</span>
        <div class="cz-dh-tx">
          <h2>{it.name}</h2>
          <p>
            {typeLabel(it.type)}{#if it.scope === 'shared'} · {t('全服统一')}{/if}{#if it.version} · v{it.version}{/if}{#if it.files} · {t('{n} 个文件', { n: it.files })}{/if}{#if it.size} · {fmtSize(it.size)}{/if}{#if it.updated} · {fmtTime(it.updated)}{/if}
            {#if it.pkg} · <button class="cz-inl" onclick={() => push({ k: 'pkg', pkg: it.pkg })}>{it.pkg}</button>{/if}
          </p>
        </div>
        {@render sw(it.enabled, () => toggleEnabled(it), t('启用'))}
      </div>
      {#if it.description}<p class="cz-lead sel-text">{it.description}</p>{/if}
      <div class="cz-sec">{t('生效 Agent')}</div>
      {@render agentRows(AGENTS.map((a) => { const ok = agentAllowed(it, a.key); return { key: a.key, label: a.label, state: ok && it.agents?.[a.key] ? 'on' : 'off', na: !ok,
        sub: ok ? a.hint : agentDeniedWhy(it, a.key), onclick: () => toggleAgent(it, a.key) }; }))}
      {#if !it.enabled}<p class="cz-note">{t('此扩展当前已停用，对所有 agent 均不生效。')}</p>{/if}

      {#if it.type === 'connector'}
        <div class="cz-sec">{t('连接配置')}<span class="cz-sp"></span><button class="cz-btn sm" onclick={() => openConnForm(it)}>{t('编辑')}</button></div>
        <div class="cz-list">
          <div class="cz-kv"><span>{tc('admin', '传输')}</span><b>{transLabel[it.connector?.transport] || it.connector?.transport}</b></div>
          {#if it.connector?.transport === 'stdio'}
            <div class="cz-kv"><span>{t('命令')}</span><b class="mono">{it.connector?.command} {(it.connector?.args || []).join(' ')}</b></div>
            {#if Object.keys(it.connector?.env || {}).length}<div class="cz-kv"><span>{t('环境变量')}</span><b class="mono">{Object.keys(it.connector.env).join(t('、'))}</b></div>{/if}
          {:else}
            <div class="cz-kv"><span>{t('地址')}</span><b class="mono">{it.connector?.url}</b></div>
            {#if Object.keys(it.connector?.headers || {}).length}<div class="cz-kv"><span>{t('请求头')}</span><b class="mono">{Object.keys(it.connector.headers).join(t('、'))}</b></div>{/if}
          {/if}
        </div>
      {:else if files.length}
        <div class="cz-sec">{tc('admin', '文件')}<span class="cz-n">{files.length}</span></div>
        <div class="cz-fchips">
          {#each files.slice(0, 60) as f (f.path)}<button class="cz-chip mono" class:on={fileSel === f.path} onclick={() => pickFile(it.id, f.path)}>{f.path}</button>{/each}
          {#if files.length > 60}<span class="cz-more">{t('… 共 {n} 个', { n: files.length })}</span>{/if}
        </div>
        <div class="cz-prev">
          {#if fileBusy}<div class="cz-empty">{t('读取中…')}</div>
          {:else if !fileSel}<div class="cz-empty">{t('选择一个文件预览')}</div>
          {:else if !TEXT_RE.test(fileSel)}<div class="cz-empty">{t('二进制文件 · {size}', { size: fmtSize(files.find((f) => f.path === fileSel)?.size || 0) })}</div>
          {:else if isMd(fileSel)}<div class="cz-md sel-text">{@html renderMarkdown(fmBlock(fileText))}</div>
          {:else}<pre class="cz-pre sel-text">{fileText}</pre>{/if}
        </div>
      {/if}

      <div class="cz-sec">{t('管理')}</div>
      <div class="cz-list">
        {#if it.type !== 'connector'}
          <button class="cz-li act" onclick={() => openUpload(it.type, it)}><span class="cz-li-tx"><span>{t('替换')}</span><small>{t('上传新版本覆盖，保留开关与 agent 勾选')}</small></span></button>
          <button class="cz-li act" onclick={() => download(it)}><span class="cz-li-tx"><span>{t('下载')}</span><small>{t('打包为 zip 存到本地')}</small></span></button>
        {/if}
        <button class="cz-li act danger" onclick={() => uninstall(it)}><span class="cz-li-tx"><span>{t('卸载')}</span></span></button>
      </div>
    {:else}
      <div class="cz-empty">{t('载入中…')}</div>
    {/if}

  {:else}
    <!-- ═══ 列表页 ═══ -->
    {#if title || showScope}
      <div class="cz-head" class:notitle={!title}>
        {#if title}<h1 class="cz-title">{t('扩展')}</h1>{/if}
        {#if showScope}
          <div class="cz-seg cz-scope" role="tablist" aria-label={t('生效范围')}>
            <button role="tab" class:on={!shared} aria-selected={!shared} onclick={() => setScope('admin')}>{t('我自用')}{#if counts.admin}<i>{counts.admin}</i>{/if}</button>
            <button role="tab" class:on={shared} aria-selected={shared} onclick={() => setScope('shared')}>{t('全服统一')}{#if counts.shared}<i>{counts.shared}</i>{/if}</button>
          </div>
        {/if}
      </div>
    {/if}
    {#if shared && curType !== 'module'}
      <p class="cz-scope-note">{@html ic('users', 1.6)}<span>{multiUser ? t('这里加装的扩展给服务器上所有成员用：成员的 Claude 会话和定时任务都会加载，你自己的会话也会。和你自用的那一套互不影响。') : t('这台服务器没开多用户，全服扩展眼下只有你自己用得上；开了多用户后所有成员的 Claude 会话都会加载。')}</span></p>
    {/if}

    <div class="cz-bar">
      <div class="cz-tabs" role="tablist">
        {#each TYPES as ty (ty.key)}
          <button role="tab" class="cz-tab" class:on={curType === ty.key} aria-selected={curType === ty.key} onclick={() => setType(ty.key)}>
            {ty.label}{#if ty.key !== 'module' && countOf(ty.key) && view === 'mine'}<i>{countOf(ty.key)}</i>{/if}
          </button>
        {/each}
      </div>
      {#if curType !== 'module'}
        <span class="cz-vsep" aria-hidden="true"></span>
        <div class="cz-seg" role="tablist">
          <button role="tab" class:on={view === 'mine'} aria-selected={view === 'mine'} onclick={() => { view = 'mine'; sortBy = 'rec'; }}>{t('我的')}</button>
          <button role="tab" class:on={view === 'discover'} aria-selected={view === 'discover'} onclick={() => { view = 'discover'; sortBy = 'rec'; }}>{t('发现')}</button>
        </div>
        <span class="cz-grow"></span>
        <div class="cz-tools">
          <label class="cz-search">
            {@html ic('search')}
            <input placeholder={t('搜索')} bind:value={query} spellcheck="false" autocomplete="off" />
            {#if query}<button class="cz-clr" aria-label={t('清除')} onclick={() => { query = ''; }}>{@html ic('x', 2)}</button>{/if}
          </label>
          <button class="cz-ibtn cz-popbtn" class:on={pop_ === 'filter' || (isDiscover ? fMarket || fCat : fState)} title={t('筛选')} aria-label={t('筛选')} onclick={() => togglePop('filter')}>{@html ic('filter')}</button>
          <button class="cz-ibtn cz-popbtn" class:on={pop_ === 'sort' || sortBy !== 'rec'} title={t('排序')} aria-label={t('排序')} onclick={() => togglePop('sort')}>{@html ic('sort')}</button>
          <button class="cz-btn pri cz-popbtn" onclick={() => togglePop('add')}>{@html ic('plus', 2)}<span>{t('添加')}</span>{@html ic('chevDown', 2)}</button>

          {#if pop_ === 'filter'}
            <div class="cz-pop">
              {#if isDiscover}
                <div class="cz-pop-h">{t('来源')}</div>
                <button class="cz-mi" class:on={!fMarket} onclick={() => { fMarket = ''; }}>{t('全部市场')}{#if !fMarket}<span class="ck">{@html ic('check', 2)}</span>{/if}</button>
                {#each (mk?.markets || []).filter((m) => m.ok) as m (m.repo)}
                  <button class="cz-mi" class:on={fMarket === m.repo} onclick={() => { fMarket = m.repo; }}>{mLabel(m.repo)}{#if fMarket === m.repo}<span class="ck">{@html ic('check', 2)}</span>{/if}</button>
                {/each}
                {#if cats.length}
                  <div class="cz-pop-h">{t('分类')}</div>
                  <div class="cz-pop-chips">
                    <button class="cz-chip" class:on={!fCat} onclick={() => { fCat = ''; }}>{t('全部')}</button>
                    {#each cats as c (c)}<button class="cz-chip" class:on={fCat === c} onclick={() => { fCat = c; }}>{catLabel(c)}</button>{/each}
                  </div>
                {/if}
              {:else}
                <div class="cz-pop-h">{t('状态')}</div>
                {#each [['', t('全部')], ['on', t('已启用')], ['off', t('已停用')]] as [v, l] (v)}
                  <button class="cz-mi" class:on={fState === v} onclick={() => { fState = v; pop_ = ''; }}>{l}{#if fState === v}<span class="ck">{@html ic('check', 2)}</span>{/if}</button>
                {/each}
              {/if}
            </div>
          {:else if pop_ === 'sort'}
            <div class="cz-pop narrow">
              {#each (isDiscover ? [['rec', t('推荐')], ['name', t('名称')]] : [['rec', t('名称')], ['updated', t('最近更新')]]) as [v, l] (v)}
                <button class="cz-mi" class:on={sortBy === v} onclick={() => { sortBy = v; pop_ = ''; }}>{l}{#if sortBy === v}<span class="ck">{@html ic('check', 2)}</span>{/if}</button>
              {/each}
            </div>
          {:else if pop_ === 'add'}
            <div class="cz-pop">
              <button class="cz-mi" onclick={() => { pop_ = ''; openUpload('skill'); }}>{@html ic('skill')}{t('上传技能')}</button>
              <button class="cz-mi" onclick={() => { pop_ = ''; openConnForm(); }}>{@html ic('connector')}{t('添加连接器')}</button>
              <button class="cz-mi" onclick={() => { pop_ = ''; openUpload('plugin'); }}>{@html ic('plugin')}{t('上传插件')}</button>
              <div class="cz-pop-sep"></div>
              <button class="cz-mi" onclick={() => { pop_ = ''; srcErr = ''; srcOpen = true; if (!mk) loadMarket(); }}>{@html ic('store')}{t('管理市场…')}</button>
              <button class="cz-mi" onclick={() => { pop_ = ''; view = 'discover'; loadMarket(true); }}>{@html ic('refresh')}{t('刷新市场')}</button>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    {#if curType === 'module'}
      <PluginsPanel toast={showToast} confirm={askConfirm} />

    {:else if isDiscover}
      <!-- ═══ 发现 ═══ -->
      {#if !mk && mkErr}
        <div class="cz-empty">{mkErr}<br /><button class="cz-btn sm" onclick={() => loadMarket()}>{t('重试')}</button></div>
      {:else if !mk || (mk.building && !marketList.length)}
        <div class="cz-loading"><span class="cz-spin"></span>{t('正在从 GitHub 拉取官方市场…')}</div>
        <div class="cz-grid">{#each Array(6) as _, i (i)}<div class="cz-card skel"><span class="cz-tile"></span><div class="cz-body"><i></i><i></i><i></i></div></div>{/each}</div>
      {:else}
        {#if mk.error && !marketList.length}<div class="cz-diag">{tr(mk.error)}</div>{/if}
        {#each (mk.markets || []).filter((m) => !m.ok) as m (m.repo)}<div class="cz-diag">{t('「{name}」没拉下来：{reason}', { name: mLabel(m.repo), reason: tr(m.error || '') })}</div>{/each}

        {#if plainDiscover && heroEntry}
          {@const h = HERO[curType]}
          {@const inst = isInstalled(h.kind, heroEntry)}
          <div class="cz-hero tone-{h.tone}">
            <div class="cz-hero-tx">
              <span class="cz-eyebrow">{h.eyebrow}</span>
              <h2>{h.title}</h2>
              <p>{h.desc}</p>
              <button class="cz-hero-btn" disabled={inst || busy[heroEntry.key]} onclick={() => install(h.kind, heroEntry)}>
                {#if busy[heroEntry.key]}<span class="cz-spin"></span>{t('添加中…')}{:else if inst}{t('已添加')}{:else}{t('添加')}{/if}
              </button>
            </div>
            <div class="cz-hero-art">{@html HERO_ART[h.art]}</div>
          </div>
        {/if}

        {#if recList.length}
          <h3 class="cz-h">{t('推荐给您')}</h3>
          <div class="cz-grid">{#each recList as e (e.key)}{@render mkCard(curType, e)}{/each}</div>
        {/if}
        <h3 class="cz-h">{plainDiscover ? (curType === 'skill' ? t('全部技能') : curType === 'connector' ? t('全部连接器') : t('全部插件')) : t('{n} 个结果', { n: restList.length })}{#if plainDiscover}<span class="cz-n">{restList.length}</span>{/if}</h3>
        {#if restList.length}
          <div class="cz-grid">{#each restList.slice(0, shown) as e (e.key)}{@render mkCard(curType, e)}{/each}</div>
          {#if shown < restList.length}<div class="cz-sentinel" use:more></div>{/if}
        {:else}
          <div class="cz-empty">{t('没有匹配的结果')}</div>
        {/if}
        <p class="cz-note">{t('来自 {list}。', { list: (mk.markets || []).filter((m) => m.ok).map((m) => mLabel(m.repo)).join(t('、')) })}{#if mk.building} {t('正在更新…')}{/if}</p>
      {/if}

    {:else}
      <!-- ═══ 我的 ═══ -->
      {#each diagnostics.filter((d) => !d.id || items.find((x) => x.id === d.id)?.type === curType) as d, i (i)}
        <div class="cz-diag" class:err={d.level === 'error'}>{tr(d.msg)}</div>
      {/each}
      {#if !loaded}
        <div class="cz-empty">{t('载入中…')}</div>
      {:else if loadErr}
        <div class="cz-empty">{loadErr}</div>
      {:else if !mineAll.length}
        <div class="cz-blank">
          <span class="cz-tile lg">{@html ic(glyphOf(curType))}</span>
          <b>{curType === 'skill' ? t('还没有技能') : curType === 'connector' ? t('还没有连接器') : t('还没有插件')}</b>
          <p>{shared ? t('给所有成员统一加装：去「发现」里挑现成的，或者自己上传。') : t('去「发现」里挑现成的，或者自己上传。')}</p>
          <div class="cz-blank-acts">
            <button class="cz-btn pri" onclick={() => { view = 'discover'; }}>{t('浏览发现')}</button>
            <button class="cz-btn" onclick={quickAdd}>{addLabel}</button>
          </div>
        </div>
      {:else if !mineCards.length}
        <div class="cz-empty">{t('没有匹配的结果')}</div>
      {:else}
        <div class="cz-grid">{#each mineCards as c (c.id)}{@render mineCard(c)}{/each}</div>
      {/if}
    {/if}
  {/if}

  <!-- ═══ 弹窗 ═══ -->
  {#if upOpen}
    <div class="cz-modal-wrap">
      <button class="cz-mask" aria-label={t('取消')} onclick={() => { if (!upBusy) { upOpen = false; upReplace = null; } }}></button>
      <div class="cz-modal" role="dialog" aria-modal="true">
        <h3>{upReplace ? t('替换「{name}」', { name: upReplace.name }) : upType === 'plugin' ? t('上传插件') : t('上传技能')}{#if shared && !upReplace}<span class="cz-h3tag">{t('全服统一')}</span>{/if}</h3>
        <button class="cz-drop" class:drag={upDrag} class:busy={upBusy}
          use:fileDrop={{ onEnter: () => { upDrag = true; }, onLeave: () => { upDrag = false; }, onDrop: doUpload }}
          onclick={() => upInput && upInput.click()}>
          {#if upBusy}<span class="cz-spin lg"></span><span>{t('正在上传解析…')}</span>
          {:else}{@html ic('upload', 1.5)}<span>{t('拖拽到这里，或点击选择文件')}</span>{/if}
        </button>
        <input bind:this={upInput} type="file" accept={upType === 'plugin' ? '.zip' : '.md,.zip,.skill'} hidden onchange={(e) => { const fs = [...(e.target.files || [])]; e.target.value = ''; doUpload(fs); }} />
        {#if !upReplace}
          <label class="cz-lab" for="cz-uppkg">{t('所属包（可选）')}</label>
          <input id="cz-uppkg" class="cz-in" placeholder={t('同包名的扩展归为一组统一管理；留空为散装')} bind:value={upPkg} />
        {/if}
        <p class="cz-req">{upType === 'plugin' ? t('文件要求：.zip 包内需含 .claude-plugin/plugin.json') : t('文件要求：.md 文件需含 YAML frontmatter 的 name 与 description；.zip / .skill 包内需含 SKILL.md')}</p>
        {#if upErr}<div class="cz-err">{upErr}</div>{/if}
        <div class="cz-acts"><button class="cz-btn" disabled={upBusy} onclick={() => { upOpen = false; upReplace = null; }}>{t('取消')}</button></div>
      </div>
    </div>
  {/if}

  {#if connOpen}
    <div class="cz-modal-wrap">
      <button class="cz-mask" aria-label={t('取消')} onclick={() => { if (!connBusy) connOpen = false; }}></button>
      <div class="cz-modal tall" role="dialog" aria-modal="true">
        <h3>{conn.id ? t('编辑连接器') : t('添加连接器')}{#if shared && !conn.id}<span class="cz-h3tag">{t('全服统一')}</span>{/if}</h3>
        <label class="cz-lab" for="cz-cn">{t('名称')}</label>
        <input id="cz-cn" class="cz-in" placeholder={t('如 github-mcp')} bind:value={conn.name} />
        <label class="cz-lab" for="cz-cd">{t('描述（可选）')}</label>
        <input id="cz-cd" class="cz-in" placeholder={t('一句话说明它提供什么工具')} bind:value={conn.description} />
        <span class="cz-lab">{tc('admin', '传输')}</span>
        <div class="cz-chips">
          {#each ['stdio', 'http', 'sse'] as tp (tp)}<button class="cz-chip" class:on={conn.transport === tp} onclick={() => { conn.transport = tp; }}>{transLabel[tp]}</button>{/each}
        </div>
        {#if conn.transport === 'stdio'}
          <label class="cz-lab" for="cz-cc">{t('启动命令')}</label>
          <input id="cz-cc" class="cz-in mono" placeholder={t('如 npx 或 node 或绝对路径')} bind:value={conn.command} />
          <label class="cz-lab" for="cz-ca">{t('参数（每行一个，可选）')}</label>
          <textarea id="cz-ca" class="cz-in ta mono" rows="3" placeholder={'-y\n@modelcontextprotocol/server-github'} bind:value={conn.argsText}></textarea>
          <label class="cz-lab" for="cz-ce">{t('环境变量（每行 KEY=VALUE，可选）')}</label>
          <textarea id="cz-ce" class="cz-in ta mono" rows="2" placeholder="GITHUB_TOKEN=ghp_xxx" bind:value={conn.envText}></textarea>
          {#if conn.id && conn.envText}<p class="cz-req">{t('值加密存在服务端，这里只显示 ••••••••：不改就原样保留，要换就把那一行改成新值，删掉那一行就是删掉它。')}</p>{/if}
        {:else}
          <label class="cz-lab" for="cz-cu">{t('服务地址')}</label>
          <input id="cz-cu" class="cz-in mono" placeholder="https://mcp.example.com/v1" bind:value={conn.url} />
          <label class="cz-lab" for="cz-ch">{t('请求头（每行 KEY=VALUE，可选）')}</label>
          <textarea id="cz-ch" class="cz-in ta mono" rows="2" placeholder="Authorization=Bearer xxx" bind:value={conn.headersText}></textarea>
          {#if conn.id && conn.headersText}<p class="cz-req">{t('值加密存在服务端，这里只显示 ••••••••：不改就原样保留，要换就把那一行改成新值，删掉那一行就是删掉它。')}</p>{/if}
        {/if}
        {#if shared}<p class="cz-req">{t('全服连接器：所有成员调用它时用的都是这里填的凭据；凭据加密存在服务端，成员看不到。')}</p>{/if}
        {#if connErr}<div class="cz-err">{connErr}</div>{/if}
        <div class="cz-acts">
          <button class="cz-btn" disabled={connBusy} onclick={() => { connOpen = false; }}>{t('取消')}</button>
          <button class="cz-btn pri" disabled={connBusy} onclick={saveConn}>{connBusy ? t('保存中…') : t('保存')}</button>
        </div>
      </div>
    </div>
  {/if}

  {#if srcOpen}
    <div class="cz-modal-wrap">
      <button class="cz-mask" aria-label={t('关闭')} onclick={() => { srcOpen = false; }}></button>
      <div class="cz-modal" role="dialog" aria-modal="true">
        <h3>{t('市场')}</h3>
        <div class="cz-list">
          {#each mk?.sources || [] as s (s.repo)}
            {@const st = (mk?.markets || []).find((m) => m.repo === s.repo)}
            <div class="cz-li row">
              <span class="cz-tile sm">{@html ic('store')}</span>
              <span class="cz-li-tx"><span>{mLabel(s.repo)}</span><small class="mono">{s.repo}{st?.ok ? ' · ' + t('{a} 插件 · {b} 技能 · {c} 连接器', { a: st.counts?.plugins || 0, b: st.counts?.skills || 0, c: st.counts?.connectors || 0 }) : st && !st.ok ? ' · ' + t('拉取失败') : ''}</small></span>
              {#if s.builtin}<span class="cz-badge">{t('默认')}</span>{:else}<button class="cz-btn sm" onclick={() => removeSource(s.repo)}>{t('移除')}</button>{/if}
            </div>
          {/each}
        </div>
        <label class="cz-lab" for="cz-src">{t('添加 GitHub 市场')}</label>
        <div class="cz-inrow">
          <input id="cz-src" class="cz-in mono" placeholder="owner/repo" bind:value={srcRepo} onkeydown={(e) => { if (e.key === 'Enter') addSource(); }} />
          <button class="cz-btn pri" disabled={srcBusy || !srcRepo.trim()} onclick={addSource}>{srcBusy ? t('添加中…') : t('添加')}</button>
        </div>
        <p class="cz-req">{t('仓库根目录要有 .claude-plugin/marketplace.json（Claude Code 插件市场格式）。')}</p>
        {#if srcErr}<div class="cz-err">{srcErr}</div>{/if}
        <div class="cz-acts"><button class="cz-btn" onclick={() => { srcOpen = false; }}>{t('完成')}</button></div>
      </div>
    </div>
  {/if}

  {#if confirmState}
    <div class="cz-modal-wrap">
      <button class="cz-mask" aria-label={t('取消')} onclick={() => settleConfirm(false)}></button>
      <div class="cz-modal" role="alertdialog" aria-modal="true">
        <h3>{confirmState.title}</h3>
        {#if confirmState.desc}<p class="cz-mdesc">{confirmState.desc}</p>{/if}
        <div class="cz-acts">
          <button class="cz-btn" onclick={() => settleConfirm(false)}>{t('取消')}</button>
          <button class="cz-btn {confirmState.danger ? 'danger' : 'pri'}" onclick={() => settleConfirm(true)}>{confirmState.yes}</button>
        </div>
      </div>
    </div>
  {/if}

  <div class="cz-toast" class:on={toast.on} class:err={toast.err} role="status">{toast.msg}</div>
</div>
