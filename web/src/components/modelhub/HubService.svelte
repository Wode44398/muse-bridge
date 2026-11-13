<script>
  // 模型中心 · 服务浮层（v2 门面）：添加新服务、打开已有服务都在这里。
  // 流程：第一步填地址 + Key →「识别模型」→ 按种类分栏列出 → 勾选 → 底部操作条勾去向 → 保存；
  // 草稿第一次保存就地建成服务（hubPost('create')），界面不关、不闪，之后按「已有服务」走。
  // 外框：宽屏居中浮层（全局 .ov-scrim / .ov-panel 的进退场），窄屏整页从右推入。
  // Esc / 系统返回逐层后退：连接面板 → 勾选 → 关闭（新建了没保存、连接改了没存时先问一句）。
  // 几条纪律：识别与保存互斥（目录前后端要一致）；已有服务的「重新识别」一律先存连接改动（HsConn.redetect）；
  // 保存连接动了地址就自动重新识别、只换 Key 则提示；点亮的去向里加不进去的行保存时跳过、操作条写明。
  // 这段脚本有单测：HubService.logic.test.js（把 <script> 抠出来跑），改 import / $props 的写法时同步那边。
  import { untrack, tick } from 'svelte';
  import { fly, fade } from 'svelte/transition';
  import { SvelteSet, MediaQuery } from 'svelte/reactivity';
  import BrandLogo from './BrandLogo.svelte';
  import HsConn from './HsConn.svelte';
  import HsKinds from './HsKinds.svelte';
  import HsTools from './HsTools.svelte';
  import HsList from './HsList.svelte';
  import HsBar from './HsBar.svelte';
  import { G, svg, AGENT_ORDER, ordAgents, claudeBlock, planAssign, pinFirst, normUrl, urlOk, hostOf, isLocal, keyTail, tailText, fmtCtx } from './HsKit.js';
  import { hub, hubPost, hubAsk, hubGet, loadHub, KINDS, KIND_NAME, AGENT_NAME, PROTO_NAME } from '../../lib/modelHub.svelte.js';
  import { providerOf, vendorOf, vendorInfo } from '../../../../src/model-knowledge/brands.mjs';
  import { pushBackLayer } from '../../lib/nav.js';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { activeRequest } from '../../lib/dialogState.svelte.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { DUR, bezier, reduced } from '../../lib/motion.js';
  import { t, tr } from '../../lib/i18n.js';

  // sheet: { type:'service', add:true } | { type:'service', id }
  let { sheet, onClose } = $props();

  const mq = new MediaQuery('(max-width: 699px)', false);   // 断点与 HubOverlays 一致
  const narrow = $derived(mq.current);
  // 与 --ea-decel / --ea-std 同值：JS 过渡（fly、收起）要函数形式
  const decel = bezier(0.05, 0.7, 0.1, 1), std = bezier(0.2, 0, 0, 1);
  const TEXTY = /^(text|search|url|email|password|number|tel)$/i;
  const PROTOS = ['openai', 'anthropic', 'gemini'];
  // 草稿字段（HsConn bind 进去改）：*Touched = 用户亲手改过，之后不再跟着品牌 / 地址自动变
  const blank = () => ({ url: '', key: '', name: '', nameTouched: false, proto: 'openai', protoTouched: false, useProxy: true, proxyTouched: false, hint: '' });

  // gen：换了 sheet / 关掉时 +1，在途请求回来一看对不上就作废；detSeq：同一会话里后发的识别作废先发的
  let gen = 0, detSeq = 0;
  let sid = $state(null);          // 服务 id；null = 新建草稿
  let fresh = $state.raw(null);    // { svc, base }：刚保存拿到的服务视图 + 当时的 hub.services（总览没换新之前先用它）
  let checked = $state(false);     // 已有服务：确认过一次总览（之后还找不到才算「没有这个服务」）
  let phase = $state('first');     // 'first' 第一步（只有新建）| 'models' 模型列表
  let d = $state(blank());
  let det = $state.raw(null);      // 草稿最近一次识别成功：{ conn, media, url, key, proto }
  let cat = $state.raw([]);        // 模型目录（识别结果 / 服务端存的目录 + 手动加的）
  let catAt = $state(0);           // 这次打开以来识别成功的时刻（「上次识别」取它与 detectedAt 的较新者）
  let catReady = $state(false);
  let catLoading = $state(false);
  let detecting = $state(false);
  let detErr = $state('');
  let listErr = $state('');
  let listRetry = $state.raw(null);
  let notes = $state.raw([]);      // 识别 / 保存的提醒（不是错误）：模型区顶上一行一条
  let kind = $state('text');
  let kindSet = $state(false);     // 种类分栏已定（默认挑过或用户点过），之后不再自动跳
  let qIn = $state('');            // 搜索框里的字（立即）
  let q = $state('');              // 参与过滤的字（80ms 防抖）
  let vf = $state('');             // 模型厂筛选
  let onlyAdded = $state(false);
  const picked = new SvelteSet();
  let saving = $state(false);
  let saveErr = $state('');
  let connOpen = $state(false);
  let connDirty = $state(false);
  let connErr = $state('');
  let connRef = $state();          // 连接面板（HsConn）：列表头 / 错误条的「重新识别」经它先存连接改动
  let connMoved = $state(false);   // 已有服务换了 Key 还没重新识别：目录可能是旧 Key 的，提示一下（地址变了的直接自动识别）
  // 置顶快照：打开 / 换栏 / 重新识别那一刻已添加的模型 id，排在各栏最前。保存后不重拍快照——刚添加的行留在原地，不会跳
  let pinIds = $state.raw(new Set());
  let now = $state(Date.now());
  let barH = $state(0);
  let stickH = $state(0);
  let closing = $state(false);
  let panel = $state();
  let bodyEl = $state();
  let searchEl = $state(null);
  let anchorEl = $state();
  let connBtn = $state();
  // 关掉后把焦点还给打开它的那个按钮（设置里的服务卡片 / 添加按钮）
  const returnTo = typeof document !== 'undefined' ? document.activeElement : null;
  let asking = false, deleting = false, exitTimer = 0, downOnScrim = false;

  // —— 服务与连接 ——
  const svc = $derived.by(() => {
    if (!sid) return null;
    // 刚保存：hubPost 已等总览重拉完，但重拉可能失败（总览还是旧的、没有新建的这个）——总览换新之前先信接口返回的
    if (fresh && fresh.base === hub.services) return fresh.svc;
    return hub.services.find((s) => s.id === sid) || (hub.ok ? null : fresh?.svc || null);
  });
  const prov = $derived(d.url.trim() ? providerOf(normUrl(d.url)) : null);
  const pk = $derived(prov?.key || '');
  const proto = $derived(svc ? svc.kind : d.proto);
  const media = $derived(svc ? svc.media || null : det?.media || null);
  // dimensio 自带适配的哪一家（服务端按地址认；'' = 不是）
  const native = $derived(svc ? svc.native || '' : det?.native || '');
  const studioOn = $derived(hub.studio !== null);
  const dimOn = $derived(hub.dimensio !== null);
  const lastAt = $derived(Math.max(sid ? svc?.detectedAt || 0 : 0, catAt));
  // 401 / 403 时总览拿不到（hub.ok 假、hub.err 空）也落到这里，不会一直「正在读取…」
  const missing = $derived(!!sid && checked && !svc && !hub.loading && !hub.err && !closing);
  // 本机 / 局域网的服务（ollama、LM Studio…）不要 Key
  const canDetectDraft = $derived(urlOk(d.url) && (!!d.key.trim() || isLocal(d.url)));
  const canRedetect = $derived(sid ? !!svc : canDetectDraft);
  // 草稿的地址 / Key / 协议和上次识别成功时不一样了：列表是旧连接的，先重新识别才能保存
  const stale = $derived(!sid && !!det && (normUrl(d.url) !== det.url || d.key.trim() !== det.key || d.proto !== det.proto));
  const sigNow = () => normUrl(d.url) + '\n' + d.key.trim() + '\n' + (d.protoTouched ? d.proto : '');

  // —— 模型行 ——
  // m：目录里的一条；a：已添加的那条（服务视图 models[]，带 agents）。两者任一可缺。
  function row(m, a) {
    const id = m.id;
    const k = a?.kind || m.kind || 'text';
    const tab = KINDS.includes(k) ? k : 'text';
    const vendor = m.vendor || a?.vendor || vendorOf(id) || '';
    const vi = vendor ? vendorInfo(vendor) : null;
    const vKey = vi?.key || vendor;
    const vName = vi?.name || '';
    const vLogo = vi?.logo || '';
    const agents = ordAgents(a?.agents || []);
    const label = m.label || a?.label || '';
    const ctxN = tab === 'text' ? Number(m.contextWindow || a?.contextWindow) || 0 : 0;
    const ctx = ctxN ? fmtCtx(ctxN) : '';
    // Claude 收不收这一行（'' 收 | 'id' 模型 ID 不合 | 'ctx' 上下文窗口不到 4096）：与服务端同一组规则，去向片和保存都看它
    const block = k === 'text' ? claudeBlock(id, ctxN) : '';
    // 加不进任何去向的行：没有勾选框、调淡、行尾「暂不支持」（悬停看原因）；已添加的总能勾（好取消）
    let why = '';
    if (!agents.length) {
      if (!KINDS.includes(k)) why = t('向量 / 识别一类的模型不能添加');
      else if (k !== 'text') {
        if (!studioOn) why = t('这台服务器没装 Media Studio');
        else if (!media || !(media.kinds || []).includes(k)) why = t('Media Studio 接不了这个服务的{kind}模型', { kind: tr(KIND_NAME[k]) });
      } else if (!dimOn && (proto === 'gemini' || block)) {
        why = [proto === 'gemini' ? t('Gemini 接口不支持') : blockText(block), t('dimensio 未开启')].join(t('、'));
      }
    }
    // 搜索按关键字包含：id、显示名、模型厂（原名 + 当前语言的名字 + 键）
    const hay = [id, label, vName, vName ? tr(vName) : '', vKey].join(' ').toLowerCase();
    return { id, label, kind: k, tab, vKey, vName, vLogo, agents, ctx, block, can: !why, why, hay };
  }
  const blockText = (b) => (b === 'ctx' ? t('上下文窗口不到 4096，Claude 用不了') : t('模型 ID 不合 Claude 格式'));

  const added = $derived.by(() => {
    const m = new Map();
    for (const x of (sid ? svc?.models : null) || []) if (x && x.id) m.set(x.id, x);
    return m;
  });
  const rowsAll = $derived.by(() => {
    const out = [], seen = new Set();
    for (const m of cat) {
      if (!m || !m.id || seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(row(m, added.get(m.id)));
    }
    // 已添加、目录里却没有的（目录还没拉到、或上游下架了）：照样列出来，能看见、能取消
    for (const [id, a] of added) if (!seen.has(id)) { seen.add(id); out.push(row(a, a)); }
    return out;
  });
  const counts = $derived.by(() => {
    const c = Object.fromEntries(KINDS.map((k) => [k, { all: 0, added: 0 }]));
    for (const r of rowsAll) { c[r.tab].all++; if (r.agents.length) c[r.tab].added++; }
    return c;
  });
  // 这一栏的行：快照里已添加的置顶（几百行里不用翻着找）；向量 / 识别一类（种类不在五类里）挂在文本栏末尾：看得见、勾不了
  const rowsKind = $derived(pinFirst(rowsAll.filter((r) => r.tab === kind), pinIds, kind === 'text' ? (r) => !KINDS.includes(r.kind) : null));
  const snapPins = () => { pinIds = new Set(added.keys()); };
  // 厂商胶囊：只列认得出的，按数量排
  const vendors = $derived.by(() => {
    const m = new Map();
    for (const r of rowsKind) {
      if (!r.vName) continue;
      const v = m.get(r.vKey);
      if (v) v.n++;
      else m.set(r.vKey, { key: r.vKey, name: r.vName, logo: r.vLogo, n: 1 });
    }
    return [...m.values()].sort((a, b) => b.n - a.n || tr(a.name).localeCompare(tr(b.name)));
  });
  // 空白分开的每个词都要包含（顺序不限）
  const words = $derived(q.trim().toLowerCase().split(/\s+/).filter(Boolean));
  const rows = $derived(rowsKind.filter((r) => (!vf || r.vKey === vf) && (!onlyAdded || r.agents.length > 0) && words.every((w) => r.hay.includes(w))));
  const filtered = $derived(!!(q.trim() || vf || onlyAdded));
  // 眼前这份列表里置顶段有几行（筛选不改顺序，置顶的还在最前）；整份都是置顶的就不用分隔
  const pinN = $derived.by(() => {
    if (!pinIds.size) return 0;
    const i = rows.findIndex((r) => !pinIds.has(r.id));
    return i < 0 ? 0 : i;
  });
  const selectable = $derived(rows.filter((r) => r.can));
  const pickedN = $derived(selectable.reduce((n, r) => n + (picked.has(r.id) ? 1 : 0), 0));
  const allState = $derived(!pickedN ? 'none' : pickedN === selectable.length ? 'all' : 'some');

  // —— 勾选 → 去向 ——
  // 勾选跨搜索保留（搜一下、勾几个、再搜别的接着勾），所以按整栏算，不只算眼前筛出来的
  const selRows = $derived(rowsKind.filter((r) => r.can && picked.has(r.id)));
  const destIds = $derived(kind === 'text' ? ['claude', 'dimensio'] : ['studio']);
  // 勾中的模型去向是否一致：'' 没勾；'c:<去向>' 一致；'*' 不一致
  const initSig = $derived.by(() => {
    if (!selRows.length) return '';
    const sigs = new Set(selRows.map((r) => r.agents.filter((a) => destIds.includes(a)).join(',')));
    return sigs.size === 1 ? 'c:' + [...sigs][0] : '*';
  });
  const consistent = $derived(initSig.startsWith('c:'));
  // 去向片：一致 → 预填成它们现在的去向；不一致 → 全空。可写的 $derived：用户点片改它，
  // 勾选变了但「一致的去向」没变（比如又勾了一个同样没添加的）时保留用户已点的片
  let chosen = $derived.by(() => (initSig.startsWith('c:') ? initSig.slice(2).split(',').filter(Boolean) : []));
  function toggleDest(id) {
    saveErr = '';
    const s = new Set(chosen);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    chosen = AGENT_ORDER.filter((x) => s.has(x));
  }
  // 去向整体用不了的原因（与勾了哪些行无关）
  const destOff = $derived({
    claude: proto === 'gemini' ? t('Gemini 协议的服务不能给 Claude') : '',
    dimensio: dimOn ? '' : t('dimensio 未开启'),
    studio: !studioOn ? t('这台服务器没装 Media Studio')
      : !media || !(media.kinds || []).includes(kind) ? t('Media Studio 接不了这个服务的{kind}模型', { kind: tr(KIND_NAME[kind]) }) : '',
  });
  // 这一行加不进这个去向的原因（'' = 能加）：去向整体用不了，或 Claude 不收这个模型（ID 不合 / 上下文窗口太小）
  const blockOf = (a, r) => destOff[a] || (a === 'claude' && r.block ? blockText(r.block) : '');
  // 去向片：勾中的行里没有一行加得进去（也没有一行已经在里面）才禁用——只有一部分加不进去的照样能点亮，
  // 保存时跳过那几行（见下面的 plan）。这样先勾模型再点去向、先点去向再勾模型，结果是一样的。开着的片总能点掉。
  const dests = $derived(destIds.map((id) => {
    const on = chosen.includes(id);
    let why = '';
    for (const r of selRows) {
      const w = r.agents.includes(id) ? '' : blockOf(id, r);
      if (!w) { why = ''; break; }
      why ||= w;
    }
    return { id, name: AGENT_NAME[id], on, disabled: !!why && !on, title: why };
  }));
  // 保存语义：一致 → 这一栏的去向改成眼前勾的（取消勾 = 批量取消添加）；不一致 → 只把勾上的加上去，不动别的。
  // 某一行加不进某个点亮的去向：那一行跳过它（skipped 里记着几行、为什么），整批不会被服务端因为一行拒掉
  const plan = $derived(planAssign(selRows, destIds, chosen, consistent, blockOf));
  const changes = $derived(plan.changes);
  // 识别进行中不许保存：保存带的是眼前的目录，识别回来又会换一份，前后端的目录就对不上了
  const canSave = $derived(!stale && !saving && !detecting && changes.length > 0);
  const barUp = $derived(selRows.length > 0);
  // 操作条上的一行状态（去向片的 title 触屏上看不到，原因得写出来）：连接改了 → 哪个去向会跳过几行 → 哪个片点不亮
  const barNote = $derived.by(() => {
    if (stale) return t('连接改了，先重新识别');
    for (const id of destIds) {
      const s = plan.skipped[id];
      if (s) return t('其中 {n} 个不添加到 {name}：{why}', { n: s.n, name: AGENT_NAME[id], why: s.why });
    }
    const why = dests.find((x) => x.disabled)?.title;
    if (why) return why;
    // 这家是 dimensio 自带专门适配的厂商：勾给 dimensio 时说一句它走的是哪条路（和别的服务不一样：不经线路池）
    if (native && kind === 'text' && dests.some((x) => x.id === 'dimensio' && x.on)) return t('dimensio 对这家厂商有专门适配：添加给它的模型直连官方接口，用第一条可用的 Key');
    return '';
  });

  // —— 其余派生 ——
  const listBusy = $derived((detecting || (catLoading && !catReady)) && !rowsKind.length);
  // 换栏、换厂商筛选 / 只看已添加、进入模型列表、列表从空到有：前几行错峰进场（几百行瞬间换成几十行太硬）；
  // 搜索打字不算（每敲一个字闪一次），目录并进已有行时也不重播（免得一屏闪一下）
  const revealKey = $derived(kind + '|' + vf + '|' + (onlyAdded ? 'a' : '') + '|' + phase + '|' + (rows.length ? 'y' : 'n'));
  // 测线路用的型号：已添加的文本模型优先，其次目录里第一个文本模型
  const testModel = $derived.by(() => {
    const isText = (x) => x && (x.kind || 'text') === 'text';
    return ((svc?.models || []).find(isText) || cat.find(isText))?.id || '';
  });
  const manualOk = $derived(kind === 'text' || (!!media && studioOn && (media.kinds || []).includes(kind)));
  const canConn = $derived(phase === 'models' && !(sid && !svc));
  const logo = $derived(svc?.brand?.logo || (!sid ? prov?.logo || '' : ''));
  const logoName = $derived(svc?.brand?.name || prov?.name || '');
  const markKey = $derived(logo || (d.url.trim() || sid ? 'globe' : 'link'));
  const title = $derived(svc ? svc.name || t('未命名服务')
    : sid ? ''
    : d.name.trim() || (prov ? tr(prov.name) : '') || (phase === 'models' ? hostOf(d.url) : '') || t('添加模型服务'));
  // 顶栏名字下面那行：「host · 接口类型 · Key 尾号」
  const summary = $derived.by(() => {
    if (svc) {
      const ls = svc.lines || [];
      const one = ls.find((l) => l.enabled && l.hasKey) || ls[0];
      const tail = ls.length > 1 ? t('{n} 把 Key', { n: ls.length }) : one?.hasKey ? tailText(one.keyTail) : '';
      return [svc.host || hostOf(svc.baseUrl), t('{p} 接口', { p: PROTO_NAME[svc.kind] || svc.kind }), tail].filter(Boolean).join(' · ');
    }
    if (!sid && phase === 'models') {
      return [hostOf(d.url), t('{p} 接口', { p: PROTO_NAME[d.proto] || d.proto }), keyTail(d.key)].filter(Boolean).join(' · ');
    }
    return '';
  });

  // —— 打开 / 读取 ——
  const keyOfSheet = (s) => (s?.add ? 'add' : s?.id || '');

  function begin(s) {
    gen++; detSeq++;
    clearTimeout(exitTimer);
    closing = false;
    sid = s?.add ? null : s?.id || null;
    phase = sid ? 'models' : 'first';
    fresh = null; checked = false;
    d = blank(); det = null;
    cat = []; catAt = 0; catReady = false; catLoading = false;
    detecting = false; detErr = ''; listErr = ''; listRetry = null; notes = [];
    kind = 'text'; kindSet = false; qIn = ''; q = ''; vf = ''; onlyAdded = false;
    picked.clear();
    saving = false; saveErr = '';
    connOpen = false; connDirty = false; connErr = ''; connMoved = false;
    pinIds = new Set();
    asking = false; deleting = false;
    if (sid) openExisting(sid);
    // 新建要知道 dimensio / Media Studio 装没装（决定哪些模型能勾）：总览还没拉过就补拉
    else if (!hub.ok && !hub.loading) loadHub();
  }

  async function openExisting(id) {
    const g = gen;
    if (!hub.ok || !hub.services.some((s) => s.id === id)) {
      await loadHub(true);
      if (g !== gen) return;
    }
    checked = true;
    if (svc) { snapPins(); loadCatalog(); }
  }

  async function loadCatalog() {
    if (!sid || catLoading) return;
    const g = gen, id = sid;
    catLoading = true; listErr = ''; listRetry = null;
    try {
      const r = await hubGet('catalog?id=' + encodeURIComponent(id));
      if (g !== gen) return;
      cat = Array.isArray(r.models) ? r.models : [];
      catReady = true;
      snapPins();
      prune();
      // 从没识别过、目录里也只有手动加的（比如从老服务收编来的）：自动识别一次
      if (svc && !svc.detectedAt && !cat.some((m) => m && m.source !== 'manual')) detectSaved();
    } catch (e) {
      if (g !== gen) return;
      listErr = tr(e.message);
      listRetry = loadCatalog;
    } finally {
      if (g === gen) catLoading = false;
    }
  }

  // —— 识别 ——
  // 识别与保存互斥：识别进行中不能保存（canSave），保存进行中不能识别（这里和各个按钮的 disabled）——
  // 不然 create / assign 带的目录和识别回来的那份对不上，之后勾新目录里的模型会被服务端按旧目录拒掉
  const detect = () => (sid ? detectSaved() : detectDraft());
  // 列表头、错误条的「重新识别」：已有服务先把连接面板里没存的改动存上（识别读的是存着的地址与 Key），再识别。
  // 连接面板自己的按钮直接调 HsConn.redetect，它的 ondetect 仍是 detect——别改成这个，会绕回来
  async function redetectAny() {
    if (!sid || !connRef) return detect();
    const ok = await connRef.redetect();
    // 改动没存上：原因显示在连接面板里，展开让人看见
    if (ok === false && !connOpen && !closing) toggleConn();
  }

  async function detectDraft() {
    if (detecting || saving) return;
    if (!canDetectDraft) {
      detErr = !urlOk(d.url) ? t('接口地址不合法') : t('要填 API Key');
      return;
    }
    const g = gen, seq = ++detSeq, s0 = sigNow();
    // 协议：用户在面板里亲手选过的为准，否则按地址认出来的提供商猜，都没有让服务端自己探
    const kindHint = d.protoTouched ? d.proto : prov?.protocol || '';
    detecting = true; detErr = ''; listErr = ''; listRetry = null;
    try {
      const r = await hubAsk('detect', {
        draft: { baseUrl: normUrl(d.url), key: d.key.trim(), ...(kindHint ? { kind: kindHint } : {}), useProxy: d.useProxy },
      });
      // 识别期间改了地址 / Key：这份结果是旧连接的，丢掉。草稿已经就地建成服务（sid 有了）的也丢掉——
      // 服务端的目录是建服务时那一份，再用这份草稿结果覆盖眼前的列表，两边就不一致了
      if (g !== gen || seq !== detSeq || sid || sigNow() !== s0) return;
      const c = r.conn || {};
      const got = Array.isArray(r.models) ? r.models : [];
      const ids = new Set(got.map((m) => m && m.id));
      // 重新识别：本地手动加的、新结果里没有的留着
      cat = [...got, ...cat.filter((m) => m && m.source === 'manual' && !ids.has(m.id))];
      if (PROTOS.includes(c.kind)) d.proto = c.kind;
      d.protoTouched = false;
      if (!d.nameTouched) d.name = c.brand?.name ? tr(c.brand.name) : prov ? tr(prov.name) : '';
      det = { conn: c, media: r.media || null, native: typeof r.native === 'string' ? r.native : '', url: normUrl(d.url), key: d.key.trim(), proto: d.proto };
      catAt = Date.now(); catReady = true;
      notes = (Array.isArray(r.warnings) ? r.warnings : []).map((w) => tr(String(w)));
      prune();
      if (!counts[kind]?.all) kindSet = false;
      if (phase === 'first') {
        // 第一步收起、模型区上移：从顶上开始看
        if (bodyEl) bodyEl.scrollTop = 0;
        phase = 'models';
        keepFocus();
      }
    } catch (e) {
      if (g !== gen || seq !== detSeq) return;
      detErr = tr(e.message);
      if (phase === 'models') { listErr = detErr; listRetry = redetectAny; }
    } finally {
      if (g === gen && seq === detSeq) detecting = false;
    }
  }

  async function detectSaved() {
    if (detecting || saving || !sid || !svc) return;
    const g = gen, seq = ++detSeq, id = sid;
    detecting = true; detErr = ''; listErr = ''; listRetry = null;
    try {
      const r = await hubAsk('detect', { id });
      if (g !== gen || seq !== detSeq) return;
      cat = Array.isArray(r.models) ? r.models : [];
      catAt = Date.now(); catReady = true;
      connMoved = false;
      notes = (Array.isArray(r.warnings) ? r.warnings : []).map((w) => tr(String(w)));
      snapPins();
      prune();
      if (!counts[kind]?.all) kindSet = false;
      detecting = false;
      // 识别会锁定协议、记下识别时间、可能补上媒体接口：刷新总览，不等它
      loadHub(true);
    } catch (e) {
      if (g !== gen || seq !== detSeq) return;
      detErr = listErr = tr(e.message);
      listRetry = redetectAny;
    } finally {
      if (g === gen && seq === detSeq) detecting = false;
    }
  }

  // 目录 / 去向变了：勾着的、现在已经勾不了（或不在了）的拿掉
  function prune() {
    const ok = new Set(rowsAll.filter((r) => r.can).map((r) => r.id));
    for (const id of [...picked]) if (!ok.has(id)) picked.delete(id);
  }

  // —— 分栏 / 勾选 / 筛选 ——
  function pickKind(k) {
    if (k === kind) return;
    kind = k; kindSet = true;
    // 保存只作用于当前栏：换栏清掉勾选，免得别栏勾着的被一起改
    picked.clear(); saveErr = '';
    // 换栏是重排的时机：这期间新添加的，回来时也排到前面
    snapPins();
    // 新栏里没有这个厂 / 没有已添加的：筛选当场清掉，不然切过去先闪一下空列表
    if (vf && !rowsAll.some((r) => r.tab === k && r.vKey === vf)) vf = '';
    if (onlyAdded && !(counts[k]?.added > 0)) onlyAdded = false;
    // 分栏已经吸顶时换栏：滚回到分栏刚好吸顶的位置，别停在新列表的半中间
    if (bodyEl && anchorEl) {
      const top = anchorEl.getBoundingClientRect().top - bodyEl.getBoundingClientRect().top + bodyEl.scrollTop;
      if (bodyEl.scrollTop > top) bodyEl.scrollTop = top;
    }
  }
  function pick(ids, on) {
    saveErr = '';
    for (const id of ids) {
      if (on) picked.add(id);
      else picked.delete(id);
    }
  }
  function onAll() {
    saveErr = '';
    if (allState === 'all') for (const r of selectable) picked.delete(r.id);
    else for (const r of selectable) picked.add(r.id);
  }
  function clearFilters() { qIn = ''; q = ''; vf = ''; onlyAdded = false; }

  // 手动添加模型 ID：已有服务写进服务端目录（catalog/add）；草稿只加在本地，保存时随目录一起建
  async function addManual(raw) {
    const id = String(raw || '').trim();
    if (!id) return t('要填模型 ID');
    if (/\s/.test(id)) return t('模型 ID 不能有空白');
    const hit = rowsAll.find((r) => r.id === id);
    if (hit) return hit.tab === kind ? t('已在列表里') : t('已在「{kind}」里', { kind: tr(KIND_NAME[hit.tab]) });
    const g = gen, k = kind;
    let m;
    if (sid) {
      try {
        const r = await hubAsk('catalog/add', { id: sid, model: { id, kind: k } });
        m = r.model;
      } catch (e) {
        return g === gen ? tr(e.message) : '';
      }
      if (g !== gen) return '';
      loadHub(true);
    } else {
      m = { id, kind: k, vendor: vendorOf(id) || '', source: 'manual' };
    }
    if (!m || !m.id) return t('没有结果');
    cat = [...cat.filter((x) => x && x.id !== m.id), m];
    // 加进来的顺手勾上：多半就是马上要添加它
    const r = rowsAll.find((x) => x.id === m.id);
    if (r && r.can && r.tab === kind) { picked.add(r.id); saveErr = ''; }
    return '';
  }

  // —— 保存 ——
  async function save() {
    if (!canSave) return;
    const g = gen, list = changes;
    saving = true; saveErr = '';
    try {
      let r;
      if (sid) {
        r = await hubPost('assign', { id: sid, changes: list });
      } else {
        // 草稿第一次保存：按识别时的连接建服务，目录与这次的去向一起带上（服务端一次落库）
        const c = det?.conn || {};
        r = await hubPost('create', {
          ...(d.name.trim() ? { name: d.name.trim() } : {}),
          baseUrl: c.baseUrl || normUrl(d.url),
          kind: PROTOS.includes(c.kind) ? c.kind : d.proto,
          ...(c.authStyle ? { authStyle: c.authStyle } : {}),
          ...(Array.isArray(c.headers) && c.headers.length ? { headers: c.headers } : {}),
          useProxy: d.useProxy,
          key: d.key.trim(),
          catalog: cat,
          assign: list,
          ...(det?.media ? { media: det.media } : {}),
        });
      }
      if (g !== gen) return;
      if (r.service) {
        fresh = { svc: r.service, base: hub.services };
        // 就地变成已有服务：sid 一设，连接面板换成服务版、顶栏换成服务名，列表不动
        if (!sid) { sid = r.service.id; checked = true; }
      }
      // 清掉勾选：操作条收下，行尾的 agent 图标落位（AgentStack 的弹簧）
      picked.clear();
      const w = (Array.isArray(r.warnings) ? r.warnings : []).map((x) => tr(String(x)));
      if (w.length) { notes = w; showToast(w[0], 'err'); }
      else showToast(t('已保存'));
    } catch (e) {
      // 失败：勾选与去向都留着，改一下就能再存
      if (g === gen) saveErr = tr(e.message);
    } finally {
      if (g === gen) saving = false;
    }
  }

  // moved：这次保存动了识别要用的那一段——'url' 地址变了 | 'key' 换了 Key | '' 没动（HsKit.connMoved）
  function onConnSaved(service, warnings, { quiet = false, moved = '' } = {}) {
    connErr = '';
    if (service) fresh = { svc: service, base: hub.services };
    const w = (warnings || []).map((x) => tr(String(x)));
    if (w.length) { notes = w; showToast(w[0], 'err'); }
    else if (!quiet) showToast(t('已保存'));
    // 眼前的目录是旧连接的。地址变了：多半换了一家，直接重新识别（服务端会去掉新上游没有的条目，手动加的和已添加的留着）；
    // 只换了 Key：同一家的目录通常不变，不打断，提示一句、把「重新识别」垫亮，识别成功后消掉
    if (moved === 'url' || (moved && detecting)) {
      // 正在途中的那次识别用的是旧连接：作废它（detSeq 一变它回来就不作数），按新连接重来
      if (detecting) { detSeq++; detecting = false; }
      detectSaved();
      // 没能开始（正在保存模型去向）：留着提示
      connMoved = !detecting;
    } else if (moved === 'key') connMoved = true;
  }

  async function del() {
    if (asking || deleting || !svc) return;
    const g = gen, id = sid, name = svc.name || t('未命名服务');
    asking = true;
    let ok = false;
    try {
      // 问句是标题、后果是下面的小字（对话框的两级）
      ok = await uiConfirm(t('删除「{name}」？', { name }), { detail: t('已经添加到各处的模型会一并移除。'), danger: true, okLabel: t('删除') });
    } finally {
      if (g === gen) asking = false;
    }
    if (!ok || g !== gen || closing) return;
    deleting = true; connErr = '';
    try {
      // hubAsk 而不是 hubPost：先关浮层再刷总览，不然刷完那一下会闪「没有这个模型服务」
      const r = await hubAsk('delete', { id });
      if (g !== gen) return;
      const w = Array.isArray(r.warnings) ? r.warnings : [];
      showToast(w.length ? tr(String(w[0])) : t('已删除'), w.length ? 'err' : 'ok');
      leave();
      loadHub(true);
    } catch (e) {
      if (g === gen) connErr = tr(e.message);
    } finally {
      if (g === gen) deleting = false;
    }
  }

  // —— 关闭 / 后退 ——
  async function guardedClose() {
    if (closing || asking) return;
    let ask = '';
    if (!sid && det && !saving) ask = t('还没有添加任何模型，放弃这个服务？');
    else if (sid && connDirty) ask = t('有改动没保存，确定放弃？');
    if (ask) {
      const g = gen;
      asking = true;
      let ok = false;
      try {
        ok = await uiConfirm(ask, { danger: true, okLabel: t('放弃') });
      } finally {
        if (g === gen) asking = false;
      }
      if (!ok || g !== gen || closing) return;
    }
    leave();
  }
  function closeConn() {
    const inside = !!panel?.querySelector('#hs-conn')?.contains(document.activeElement);
    connOpen = false;
    // 焦点在面板里：收起后它会落进 inert 区，交还给齿轮
    if (inside) {
      if (connBtn) connBtn.focus({ preventScroll: true });
      else keepFocus();
    }
  }
  function toggleConn() {
    if (!canConn) return;
    if (connOpen) { closeConn(); return; }
    connOpen = true;
    connErr = '';
    // 面板在列表上方展开：滚回顶上让它露出来。滚得很深（超过一屏）时直接到位——长距离平滑滚动和面板展开同时进行会打架
    if (bodyEl) bodyEl.scrollTo({ top: 0, behavior: reduced() || bodyEl.scrollTop > bodyEl.clientHeight ? 'auto' : 'smooth' });
  }
  // Esc / 系统返回：一次退一层
  function back() {
    if (closing || asking) return;
    if (connOpen && canConn) { closeConn(); return; }
    if (picked.size) { picked.clear(); saveErr = ''; return; }
    guardedClose();
  }
  function leave() {
    if (closing) return;
    closing = true; gen++; detSeq++;
    clearTimeout(exitTimer);
    // 出场（.closing 的过渡）播完再卸载；减弱动效时没有出场，立刻关
    exitTimer = setTimeout(() => {
      onClose?.();
      if (returnTo && returnTo.isConnected) { try { returnTo.focus({ preventScroll: true }); } catch {} }
    }, reduced() ? 0 : DUR.quick + 40);
  }
  // 焦点别掉到 body 上：拿着焦点的元素被拿掉 / 变 inert 了（第一步收起），落回面板本身
  function keepFocus() {
    tick().then(() => {
      if (!panel || closing) return;
      const a = document.activeElement;
      if (!a || a === document.body || !panel.contains(a) || a.closest('[inert]')) panel.focus({ preventScroll: true });
    });
  }
  // 宽屏点罩层关闭：按下和抬起都在罩层上才算（从面板里拖选文字拖出去不算）
  function scrimDown(e) { downOnScrim = !narrow && e.target === e.currentTarget; }
  function scrimClick(e) {
    const hit = downOnScrim && !narrow && e.target === e.currentTarget;
    downOnScrim = false;
    if (hit) guardedClose();
  }
  function typingIn(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === 'TEXTAREA' || tag === 'SELECT' || (tag === 'INPUT' && TEXTY.test(el.type || 'text'));
  }
  // 第一步识别成功后收起：高度收到 0 同时淡出，下面的模型区跟着上移（减弱动效时直接拿掉）
  function collapse(node) {
    if (reduced()) return { duration: 0 };
    const h = node.offsetHeight;
    return { duration: DUR.base, easing: std, css: (k) => `height:${k * h}px;opacity:${Math.max(0, (k - 0.4) / 0.6)};overflow:hidden` };
  }

  // —— 副作用 ——
  // 搜索防抖 80ms；清空立即生效
  $effect(() => {
    const v = qIn;
    if (!v.trim()) { q = ''; return; }
    const h = setTimeout(() => { q = v; }, 80);
    return () => clearTimeout(h);
  });
  // 筛选条件在当前栏里已经不存在（目录变了、取消了全部添加）：自动松开
  $effect(() => { if (vf && !vendors.some((v) => v.key === vf)) vf = ''; });
  $effect(() => { if (onlyAdded && !(counts[kind]?.added > 0)) onlyAdded = false; });
  // 默认分栏：已有服务停在第一个有已添加模型的栏，否则第一个有模型的栏
  $effect(() => {
    if (kindSet) return;
    const ready = sid ? !!svc && (svc.models.length > 0 || catReady) : phase === 'models';
    if (!ready) return;
    untrack(() => {
      const c = counts;
      kind = (sid && KINDS.find((x) => c[x]?.added > 0)) || KINDS.find((x) => c[x]?.all > 0) || 'text';
      kindSet = true;
    });
  });
  // 草稿改了地址 / Key / 协议：上一次的识别错误不再适用
  $effect(() => {
    if (sid) return;
    sigNow();
    untrack(() => { detErr = ''; });
  });
  // 名字跟着认出来的品牌走（用户亲手改过就不动）
  $effect(() => {
    const k = pk;
    untrack(() => { if (!sid && !d.nameTouched) d.name = k && prov ? tr(prov.name) : ''; });
  });
  // 本机 / 局域网默认不走出站代理（用户亲手拨过就不动）
  $effect(() => {
    const loc = isLocal(d.url);
    untrack(() => { if (!sid && !d.proxyTouched) d.useProxy = !loc; });
  });
  // 系统返回（apk 返回键、浏览器后退）：同 Esc 逐层后退；出场中不再接
  $effect(() => {
    if (closing) return;
    return pushBackLayer(() => back());
  });
  $effect(() => {
    if (closing) return;
    const onKey = (e) => {
      if (e.defaultPrevented || e.isComposing || activeRequest()) return;
      if (e.key === 'Escape') { e.preventDefault(); back(); return; }
      if (!canConn) return;
      const typing = typingIn(e.target);
      if (e.key === '/' && !narrow && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // 宽屏「/」跳到搜索框（同多数列表类应用）
        if (!searchEl) return;
        e.preventDefault();
        searchEl.focus();
        searchEl.select();
      } else if ((e.key === 'a' || e.key === 'A') && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && !typing) {
        // Ctrl / ⌘ + A：勾上眼前所有能勾的（不是全选网页文字）
        if (!selectable.length) return;
        e.preventDefault();
        for (const r of selectable) picked.add(r.id);
        saveErr = '';
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  // 「n 分钟前」每 30 秒走一次
  $effect(() => {
    const h = setInterval(() => { now = Date.now(); }, 30000);
    return () => clearInterval(h);
  });
  // 打开时焦点进面板（宽屏地址框自己 autofocus；窄屏不弹键盘，落在面板上）
  $effect(() => {
    if (!panel) return;
    tick().then(() => { if (panel && !closing && !panel.contains(document.activeElement)) panel.focus({ preventScroll: true }); });
  });
  $effect(() => () => clearTimeout(exitTimer));

  // 放在最后：begin 要读上面的派生（const 有暂时性死区）
  let sheetKey = keyOfSheet(untrack(() => sheet));
  begin(untrack(() => sheet));
  // 开着的时候换了 sheet（从别处点了另一个服务）：就地重来，不用外面套 {#key}
  $effect(() => {
    const k = keyOfSheet(sheet);
    if (!k || k === sheetKey) return;
    sheetKey = k;
    untrack(() => { begin(sheet); keepFocus(); });
  });
</script>

{#snippet tools()}
  <HsTools bind:qIn bind:searchEl {vendors} {vf} onvendor={(k) => { vf = k; }} {onlyAdded} addedN={counts[kind]?.added || 0}
    onadded={(v) => { onlyAdded = v; }} total={rows.length} {allState} selectableN={selectable.length} onall={onAll}
    catAt={lastAt} {now} {detecting} canDetect={canRedetect && !saving} ondetect={redetectAny} nudge={connMoved} {narrow} />
{/snippet}

<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="hs" class:narrow class:ov-scrim={!narrow} class:closing role="presentation" onpointerdown={scrimDown} onclick={scrimClick}>
  <div class="panel" class:ov-panel={!narrow} class:push={narrow} class:closing bind:this={panel}
    role="dialog" aria-modal="true" aria-label={title || t('模型中心')} tabindex="-1">
    {#if narrow}
      <header class="top">
        <button type="button" class="hbtn" aria-label={t('返回')} title={t('返回')} onclick={() => guardedClose()}>{@html svg(G.back, 1.8)}</button>
        <button type="button" class="mid" disabled={!canConn} aria-expanded={canConn ? connOpen : undefined}
          aria-controls={canConn ? 'hs-conn' : undefined} onclick={toggleConn}>
          <span class="r1">
            {#if logo}<BrandLogo size={22} {logo} name={logoName || title} />{/if}
            <span class="t1">{title}</span>
          </span>
          {#if summary}<span class="t2">{summary}</span>{/if}
        </button>
        {#if canConn}
          <button type="button" class="hbtn" class:on={connOpen} bind:this={connBtn} aria-label={t('连接设置')} title={t('连接设置')}
            aria-expanded={connOpen} aria-controls="hs-conn" onclick={toggleConn}>{@html svg(G.gear)}</button>
        {:else}
          <span class="hbtn ghost" aria-hidden="true"></span>
        {/if}
      </header>
    {:else}
      <header class="top">
        <span class="mark" aria-hidden="true">
          {#key markKey}
            <span class="mk" in:fade={{ duration: DUR.quick }} out:fade={{ duration: DUR.quick }}>
              {#if logo}<BrandLogo size={30} {logo} name={logoName || title} />{:else}<span class="nomark">{@html svg(markKey === 'globe' ? G.globe : G.link)}</span>{/if}
            </span>
          {/key}
        </span>
        <div class="tcol">
          <h2 class="t1" title={title}>{title}</h2>
          {#if canConn && summary}
            <button type="button" class="sum" title={summary} aria-expanded={connOpen} aria-controls="hs-conn" onclick={toggleConn}>
              <span class="st">{summary}</span>
              <span class="chev" class:up={connOpen} aria-hidden="true">{@html svg(G.chev)}</span>
            </button>
          {/if}
        </div>
        {#if canConn}
          <button type="button" class="hbtn" class:on={connOpen} bind:this={connBtn} aria-label={t('连接设置')} title={t('连接设置')}
            aria-expanded={connOpen} aria-controls="hs-conn" onclick={toggleConn}>{@html svg(G.gear)}</button>
        {/if}
        <button type="button" class="hbtn" aria-label={t('关闭')} title={t('关闭')} onclick={() => guardedClose()}>{@html svg(G.close)}</button>
      </header>
    {/if}

    <div class="body" bind:this={bodyEl} style:--stickh="{stickH}px" style:--barh="{barUp ? barH : 0}px">
      {#if sid && !svc}
        <div class="msg" role={missing || hub.err ? 'alert' : 'status'}>
          {#if missing}
            <span>{t('没有这个模型服务')}</span>
            <button type="button" class="btn" onclick={leave}>{t('关闭')}</button>
          {:else if checked && !hub.loading && hub.err}
            <span class="bad">{tr(hub.err)}</span>
            <button type="button" class="btn" onclick={() => openExisting(sid)}>{t('重试')}</button>
          {:else}
            <span>{t('正在读取…')}</span>
          {/if}
        </div>
      {:else if phase === 'first'}
        <div class="firstwrap" out:collapse>
          <div class="firstin">
            <HsConn mode="first" bind:d {narrow} {detecting} {detErr} ondetect={detect} />
          </div>
        </div>
      {:else}
        <div class="connwrap" id="hs-conn" class:open={connOpen} inert={!connOpen}>
          <div class="connin">
            <div class="connpad">
              <HsConn bind:this={connRef} mode={sid ? 'service' : 'draft'} bind:d {svc} {narrow} {detecting} {detErr} {stale} catAt={lastAt} {now}
                ondetect={detect} onsaved={onConnSaved} ondelete={del} {testModel} bind:dirty={connDirty} {connErr} locked={saving} />
            </div>
          </div>
        </div>
        <div class="models" in:fly={{ y: reduced() ? 0 : 12, duration: reduced() ? DUR.micro : DUR.base, delay: reduced() ? 0 : 40, easing: decel }}>
          {#if notes.length || connMoved}
            <div class="notes" role="status">
              {#if connMoved}<p>{t('连接改了，建议重新识别')}</p>{/if}
              {#each notes as n, i (i)}<p>{n}</p>{/each}
            </div>
          {/if}
          <div class="anchor" bind:this={anchorEl}></div>
          <div class="stick" bind:offsetHeight={stickH}>
            <HsKinds {kind} {counts} onpick={pickKind} {narrow} controls="hs-list" />
            {#if !narrow}{@render tools()}{/if}
          </div>
          {#if narrow}{@render tools()}{/if}
          <!-- 连接面板开着且显示着同一条识别错误时，列表上方不再重复 -->
          {#if listErr && !(connOpen && detErr)}
            <div class="lerr" role="alert">
              <span>{listErr}</span>
              {#if listRetry}
                <button type="button" class="tbtn" disabled={detecting || catLoading || saving} onclick={() => listRetry?.()}>{t('重试')}</button>
              {/if}
            </div>
          {/if}
          <HsList {rows} {picked} onpick={pick} busy={listBusy} {filtered} onclearfilters={clearFilters} {revealKey} {narrow}
            listId="hs-list" label={tr(KIND_NAME[kind])} onmanual={addManual} {manualOk} {pinN} />
          <!-- 操作条升起时给列表底部让出同样高的空间：最后几行能滚到操作条上面 -->
          <div class="barpad" style:height="{barUp ? barH : 0}px"></div>
        </div>
      {/if}
    </div>

    {#if canConn}
      <HsBar up={barUp} n={selRows.length} {dests} {canSave} {saving} err={saveErr} note={barNote}
        ontoggle={toggleDest} onclear={() => { picked.clear(); saveErr = ''; }} onsave={save} {narrow} bind:barh={barH} />
    {/if}
  </div>
</div>

<style>
  /* 墨与象牙（契约 §8）：子组件（Hs*、SToggle、BrandLogo、AgentStack）都读这组；--i-* 给窄屏 SToggle 的墨色开关。
     这一层挂在 App 根上（HubOverlays），不在设置的 .ios 里，得自己补全 */
  .hs {
    --pm-bg: #100f0d; --st-surface: #1a1917; --text: #f1ece2;
    --st-text2: rgba(241, 236, 226, .74); --st-muted: rgba(241, 236, 226, .5);
    --st-line: rgba(241, 236, 226, .1); --st-hair: rgba(241, 236, 226, .065);
    --st-sel: rgba(241, 236, 226, .1); --st-hover: rgba(241, 236, 226, .05); --pm-press: rgba(241, 236, 226, .06);
    --st-field: rgba(241, 236, 226, .06); --st-seg: rgba(241, 236, 226, .07); --st-thumb: rgba(241, 236, 226, .2);
    --st-accent: #ebe5d8; --st-primary: #ebe5d8; --st-primary-ink: #151412; --pm-knob-on: #151412;
    --pm-warn: #d9a441; --pm-red: #e2725f; --st-backdrop: rgba(0, 0, 0, .45);
    --st-menu-shadow: 0 24px 70px rgba(0, 0, 0, .45), 0 0 0 1px rgba(241, 236, 226, .08);
    --i-fill1: rgba(241, 236, 226, .19); --i-accent: #ebe5d8; --i-knob: #f1ece2; --i-knob-on: #151412;
    position: fixed; inset: 0; z-index: 200; display: flex; align-items: center; justify-content: center; padding: 24px; box-sizing: border-box;
    background: var(--st-backdrop); color: var(--text);
    font-family: var(--font-brand-sans), -apple-system, BlinkMacSystemFont, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  :global(html[data-theme="light"]) .hs {
    --pm-bg: #f2f0eb; --st-surface: #fcfbf8; --text: #1d1b18;
    --st-text2: rgba(29, 27, 24, .72); --st-muted: rgba(29, 27, 24, .5);
    --st-line: rgba(29, 27, 24, .1); --st-hair: rgba(29, 27, 24, .075);
    --st-sel: rgba(29, 27, 24, .08); --st-hover: rgba(29, 27, 24, .04); --pm-press: rgba(29, 27, 24, .055);
    --st-field: rgba(29, 27, 24, .045); --st-seg: rgba(29, 27, 24, .06); --st-thumb: #fff;
    --st-accent: #1d1b18; --st-primary: #1d1b18; --st-primary-ink: #f6f3ec; --pm-knob-on: #fff;
    --pm-warn: #b0741c; --pm-red: #c4473b; --st-backdrop: rgba(24, 21, 17, .3);
    --st-menu-shadow: 0 24px 70px rgba(24, 21, 17, .2), 0 0 0 1px rgba(29, 27, 24, .07);
    --i-fill1: rgba(29, 27, 24, .15); --i-accent: #1d1b18; --i-knob: #fff; --i-knob-on: #fff;
  }
  .hs.closing { pointer-events: none; }

  /* —— 宽屏：居中浮层。进退场全靠全局 .ov-scrim / .ov-panel（挂 .closing 即出场），这里不能再写 transition 盖掉它 —— */
  .panel { position: relative; display: flex; flex-direction: column; overflow: hidden; overflow: clip; width: min(1040px, 100%); height: min(800px, 100%);
    background: var(--st-surface); color: var(--text); border-radius: 22px; box-shadow: var(--st-menu-shadow); outline: none; }

  .top { flex: none; display: flex; align-items: center; gap: 12px; height: 60px; padding: 0 12px 0 18px; box-sizing: border-box; border-bottom: 1px solid var(--st-hair); }
  .mark { position: relative; flex: none; width: 30px; height: 30px; }
  .mk { position: absolute; inset: 0; display: grid; place-items: center; }
  .nomark { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 9px; background: var(--st-seg); color: var(--st-muted); }
  .nomark :global(svg) { width: 17px; height: 17px; }
  .tcol { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; gap: 1px; }
  .t1 { min-width: 0; margin: 0; font-family: var(--font-brand-serif), Georgia, serif; font-size: 19px; font-weight: 500; line-height: 1.25; letter-spacing: -.01em;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .sum { align-self: flex-start; max-width: 100%; display: inline-flex; align-items: center; gap: 4px; height: 20px; padding: 0 4px; margin-left: -4px; border: 0; border-radius: 6px;
    background: transparent; color: var(--st-muted); font: inherit; font-size: 12.5px; font-variant-numeric: tabular-nums; cursor: pointer;
    transition: color var(--mo-micro) var(--ea-fade); }
  @media (hover: hover) { .sum:hover { color: var(--text); } }
  .sum:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .st { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .chev { flex: none; display: grid; place-items: center; width: 14px; height: 14px; transition: transform var(--mo-quick) var(--ea-std); }
  .chev :global(svg) { width: 14px; height: 14px; }
  .chev.up { transform: rotate(180deg); }
  .hbtn { position: relative; flex: none; display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border: 0; border-radius: 9px;
    background: transparent; color: var(--st-text2); cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  .hbtn :global(svg) { width: 18px; height: 18px; }
  @media (hover: hover) { .hbtn:hover { background: var(--st-hover); color: var(--text); } }
  .hbtn:active { transform: scale(.96); }
  .hbtn.on { background: var(--st-sel); color: var(--text); }
  .hbtn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  /* 宽屏但是触屏（横放的平板）：34 的按钮命中区四周各扩 5px 到 44 */
  @media (pointer: coarse) { .hbtn::after { content: ''; position: absolute; inset: -5px; } }

  /* —— 窄屏：整页，从右推入（--mo-page decel，与 HubOverlays、设置子页同一个节拍），后退时反向滑出；顶部让出状态栏 —— */
  .hs.narrow { padding: 0; align-items: stretch; background: transparent; }
  .narrow .panel { width: 100%; height: 100%; border-radius: 0; box-shadow: none; background: var(--pm-bg); padding-top: var(--sat, 0px); box-sizing: border-box; }
  .panel.push { animation: hs-push var(--mo-page) var(--ea-decel) both;
    transition: transform var(--mo-quick) var(--ea-accel), opacity var(--mo-quick) var(--ea-fade); }
  .panel.push.closing { transform: translateX(28%); opacity: 0; }
  @keyframes hs-push { from { transform: translateX(28%); opacity: 0; } }
  .narrow .top { display: grid; grid-template-columns: 44px minmax(0, 1fr) 44px; gap: 4px; height: 56px; padding: 0 6px; border-bottom: 0; }
  .narrow .hbtn { width: 44px; height: 44px; border-radius: 50%; color: var(--text); }
  .narrow .hbtn :global(svg) { width: 22px; height: 22px; }
  .narrow .hbtn:active { background: var(--pm-press); transform: none; }
  .narrow .hbtn.on { background: var(--st-sel); }
  .narrow .hbtn::after { content: none; }
  .hbtn.ghost { pointer-events: none; }
  .mid { min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; height: 48px; padding: 0 8px; border: 0; border-radius: 12px;
    background: transparent; color: var(--text); font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent;
    transition: background-color var(--mo-micro) var(--ea-fade); }
  .mid:active:not(:disabled) { background: var(--pm-press); }
  .mid:disabled { cursor: default; color: var(--text); }
  .mid:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .r1 { max-width: 100%; min-width: 0; display: flex; align-items: center; justify-content: center; gap: 7px; }
  .narrow .t1 { font-family: inherit; font-size: 17px; font-weight: 600; letter-spacing: -.2px; }
  .t2 { max-width: 100%; font-size: 12px; line-height: 1.3; color: var(--st-muted); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* —— 滚动区 —— */
  .body { position: relative; flex: 1; min-height: 0; overflow-x: hidden; overflow-y: auto; overscroll-behavior: contain; padding: 0 24px 24px; }
  .narrow .body { padding: 0 16px calc(var(--sab, 0px) + 24px); }
  /* 第一步的表单落在面板的视觉中心偏上（上下留白约 1 : 2），不贴着顶栏、留下半张空面板；仍是顶对齐——
     识别中的骨架从下方出现时表单不会被顶动 */
  .firstin { padding-top: clamp(28px, 11vh, 104px); }
  .narrow .firstin { padding-top: 12px; }

  /* 连接面板：grid 0fr ↔ 1fr 做高度展开（内容高度不定，transition 不了 height:auto）；收着时 visibility:hidden + inert，不进 Tab 序列 */
  .connwrap { display: grid; grid-template-rows: 0fr; opacity: 0; visibility: hidden;
    transition: grid-template-rows var(--mo-base) var(--ea-std), opacity var(--mo-quick) var(--ea-fade), visibility 0s linear var(--mo-base); }
  .connwrap.open { grid-template-rows: 1fr; opacity: 1; visibility: visible;
    transition: grid-template-rows var(--mo-base) var(--ea-std), opacity var(--mo-quick) var(--ea-fade), visibility 0s; }
  .connin { min-height: 0; overflow: hidden; }
  .connpad { padding: 16px 0 4px; }

  /* 分栏（宽屏连同搜索 / 列表头）吸顶：左右用负外边距铺满滚动区，底色盖住滚上去的行 */
  .stick { position: sticky; top: 0; z-index: 2; margin: 0 -24px; padding: 14px 24px 0; background: var(--st-surface); box-shadow: 0 1px 0 var(--st-hair); }
  .narrow .stick { margin: 0 -16px; padding: 10px 16px 6px; background: var(--pm-bg); box-shadow: none; }

  .notes { padding-top: 4px; }
  .notes p { margin: 12px 2px 0; font-size: 12.5px; line-height: 1.5; color: var(--st-muted); overflow-wrap: anywhere; }
  .narrow .notes p { margin: 12px 4px 0; font-size: 13px; }
  .lerr { display: flex; align-items: center; gap: 8px; margin: 10px 2px 0; font-size: 13px; line-height: 1.5; color: var(--pm-red); }
  .lerr span { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .msg { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 72px 16px; font-size: 14px; color: var(--st-muted); text-align: center; }
  .msg .bad { color: var(--pm-red); overflow-wrap: anywhere; }

  .btn { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 34px; padding: 0 16px; border: 0; border-radius: 10px;
    background: transparent; color: var(--text); box-shadow: inset 0 0 0 1px var(--st-line); font: inherit; font-size: 13px; font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: transform var(--mo-tap) var(--ea-std), background-color var(--mo-micro) var(--ea-fade); }
  @media (hover: hover) { .btn:hover { background: var(--st-hover); } }
  .btn:active { transform: scale(.96); }
  .btn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .narrow .btn { height: 44px; padding: 0 18px; border-radius: 13px; font-size: 15px; }
  .tbtn { flex: none; display: inline-flex; align-items: center; height: 30px; padding: 0 8px; border: 0; border-radius: 8px; background: transparent; color: var(--text);
    font: inherit; font-size: 12.5px; font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  @media (hover: hover) { .tbtn:hover:not(:disabled) { background: var(--st-hover); } }
  .tbtn:active:not(:disabled) { transform: scale(.96); }
  .tbtn:disabled { opacity: .4; cursor: default; }
  .tbtn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .narrow .tbtn { height: 44px; padding: 0 12px; font-size: 14px; }

  /* —— 子组件共用：勾选框（列表行、全选、去向片）与转圈 —— */
  .hs :global(.hs-cb) { flex: none; display: grid; place-items: center; width: 18px; height: 18px; box-sizing: border-box; border-radius: 5px;
    box-shadow: inset 0 0 0 1.5px var(--st-muted); transition: background-color var(--mo-micro) var(--ea-fade), box-shadow var(--mo-micro) var(--ea-fade); }
  .hs :global(.hs-cb svg) { width: 14px; height: 14px; stroke: var(--st-primary-ink); }
  /* 对勾是描出来的：勾上时 dashoffset 12 → 0 */
  .hs :global(.hs-cb .ck) { stroke-dasharray: 12; stroke-dashoffset: 12; transition: stroke-dashoffset var(--mo-quick) var(--ea-decel); }
  .hs :global(.hs-cb .dash) { opacity: 0; }
  .hs :global(.hs-cb.on), .hs :global(.hs-cb.mixed) { background: var(--st-primary); box-shadow: none; }
  .hs :global(.hs-cb.on .ck) { stroke-dashoffset: 0; }
  .hs :global(.hs-cb.mixed .ck) { opacity: 0; }
  .hs :global(.hs-cb.mixed .dash) { opacity: 1; }
  .hs :global(.spin) { flex: none; width: 14px; height: 14px; box-sizing: border-box; border-radius: 50%; border: 2px solid currentColor; border-top-color: transparent;
    animation: hs-spin .8s linear infinite; }
  @keyframes hs-spin { to { transform: rotate(360deg); } }

  /* 减弱动效：推入改成纯淡入，按下不缩放，箭头、面板展开不做位移 */
  @media (prefers-reduced-motion: reduce) {
    .panel.push { animation-name: hs-fade; }
    .panel.push.closing { transform: none; }
    .hbtn:active, .btn:active, .tbtn:active:not(:disabled) { transform: none; }
    .chev { transition: none; }
    .connwrap, .connwrap.open { transition: opacity var(--mo-micro) var(--ea-fade), visibility 0s; }
    .hs :global(.hs-cb .ck) { transition: none; }
  }
  @keyframes hs-fade { from { opacity: 0; } }
</style>
