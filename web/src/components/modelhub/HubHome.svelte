<script>
  // 模型中心首页 = 设置里「模型中心」分区的正文（分区标题 / 头图归外壳，这里不画）。
  //   shell='desk'：桌面壳右侧内容区（约 720 宽），读 --dsk-* 令牌；shell='ios'：手机 / 网页壳的子页（窄），读 --i-* 令牌。
  //   两边要像各自外壳里别的分区，所以分组卡圆角、行高、分隔线起点、字号都照外壳现有的行（见 <style> 的 .desk / .ios 两块）；
  //   类名一律 hh- 开头：两套外壳都有带 :global 的 .grp / .gcard / .drow / .r 规则，撞名会把外壳样式串进来。
  // 管理员（hub.ok）：一张服务卡（模型中心服务 → Vertex → Claude 专用 → dimensio 自建 → Studio 非托管 → 插件），
  //   顶上按种类筛选 + 添加服务；下面「Claude 订阅账号」「dimensio 内置厂商」两组。
  //   连着老服务端（hubLegacy()：有总览、没有 v2 的接口）时只读 + 启停：顶上一行状态，添加服务与点开模型中心服务改成弹同一句。
  // 成员（hub.ok 为假、cp.ok）：他自己的 Claude 服务 + 管理员共享的只读行 + 跳 dimensio 的一行。
  // 点行不在这里展开：都经 openHubSheet 交给挂在 App 根上的 HubOverlays（dimensio 自建服务例外：直接跳 dimensio 自己的编辑器）。
  import { onMount, tick, untrack } from 'svelte';
  import BrandLogo from './BrandLogo.svelte';
  import AgentStack from './AgentStack.svelte';
  import { KIND_ICON } from './kindIcons.js';
  import DSwitch from '../../desktop/kit/DSwitch.svelte';
  import Toggle from '../ios27/Toggle.svelte';
  import Sym from '../ios27/Sym.svelte';
  import { hub, loadHub, hubPost, openHubSheet, hubLegacy, kindTally, adoptReach, KINDS, coolingCount } from '../../lib/modelHub.svelte.js';
  import { cp, loadProviders, updateProvider, canUseCustomApi } from '../../lib/claudeProviders.svelte.js';
  import { ds, loadDimensio, dimReady, keyVendors, canSetKey, openInDimensio, customSummary } from '../../lib/dimensioSettings.svelte.js';
  import { adoptDimensioService } from '../../lib/modelHubAdopt.js';
  import { ags, loadPool, loadUsage } from '../../lib/agentSettings.svelte.js';
  import { openSettings } from '../../lib/settingsNav.svelte.js';
  import { me } from '../../lib/state.svelte.js';
  import { api } from '../../lib/api.js';
  import { uiConfirm, uiAlert } from '../../lib/dialogs.js';
  import { DUR, EASE, reduced, stagger, animate, bezier } from '../../lib/motion.js';
  import { providerOf, providerInfo, vendorInfo } from '../../../../src/model-knowledge/brands.mjs';
  import { t, tr } from '../../lib/i18n.js';

  let { shell = 'desk' } = $props();
  const desk = $derived(shell !== 'ios');

  let settled = $state(false);      // 进来时那一轮拉取（总览 + Claude 服务）都有了结果，不论成败
  let retrying = $state(false);
  let now = $state(Date.now());     // 冷却是按时间过去的：每 30 秒重算一次「N 条线路冷却中」
  let kind = $state('all');
  let pend = $state({});            // 行 key → 开关的目标值：提交中先按目标值显示，失败删掉即回到真实值
  let busy = $state({});            // 行 key → true：「改为共用」进行中
  // 首屏的行用 stagger 错峰进场；之后单行的增删换成高度收放。不是响应式：只是给动效函数看的闸门
  let armed = false;
  // 切种类筛选的那一下：行与分组直接换（不收放高度——十来个元素同时动 layout 在手机上掉帧），只让服务卡的内容淡入。同样只是闸门
  let muteFx = false;
  let rowsEl = $state(null);        // 服务卡里装行的那一层：筛选换了内容时淡入的就是它

  onMount(() => {
    Promise.allSettled([loadHub(), canUseCustomApi() ? loadProviders(true) : null]).then(() => { settled = true; });
    if (me.kind === 'admin') loadPool().then(() => { if (ags.poolOk) loadUsage(); });
    loadDimensio({ quiet: true });
    const iv = setInterval(() => { now = Date.now(); }, 30000);
    return () => clearInterval(iv);
  });

  // 身份与数据状态：
  //   admin  有总览；member 没有总览但能用自定义 API（含老服务端上的管理员）；
  //   wait   管理员的总览还没回来 / 出错（cp 可能早被 Claude 设置页拉过——别先闪一下成员视图）；none 两边都拿不到
  const mode = $derived(
    hub.ok ? 'admin'
    : me.kind === 'admin' && (!settled || hub.err) ? 'wait'
    : cp.ok ? 'member'
    : settled ? 'none' : 'wait');
  const loadErr = $derived(hub.err || cp.err);

  $effect(() => {
    if (mode !== 'admin' && mode !== 'member') return;
    untrack(() => { if (!armed) requestAnimationFrame(() => requestAnimationFrame(() => { armed = true; })); });
  });

  async function retry() {
    if (retrying) return;
    retrying = true;
    await Promise.allSettled([loadHub(true), canUseCustomApi() ? loadProviders(true) : null]);
    retrying = false;
  }

  // —— 显示用的小工具 ——
  // 种类名必须是字面量 t('…')：i18n 检查按字面量收词
  const kindLabel = (k) => ({ text: t('文本'), image: t('图像'), video: t('视频'), voice: t('配音'), music: t('音乐') })[k] || k;
  function hostOf(u) {
    const s = String(u || '').trim();
    if (!s) return '';
    try { return new URL(s).host; } catch { return (s.match(/^(?:[a-z][\w+.-]*:\/\/)?([^/?#\s]+)/i) || [])[1] || s; }
  }
  // 品牌标：先按地址认（中转站 / 厂商域名），认不出再按预设 / 方言的 id 认；brands 表是共享模块，出错不该拖垮整页
  function logoByUrl(u) { if (!u) return ''; try { return providerOf(u)?.logo || ''; } catch { return ''; } }
  function logoByKey(k) { if (!k) return ''; try { return providerInfo(k)?.logo || vendorInfo(k)?.logo || ''; } catch { return ''; } }
  // dimensio 内置厂商的 id 是适配器 id，不是品牌名（openai 那一家其实是 DeepSeek）：按它实际接的厂取标
  const DIM_VENDOR = { anthropic: 'anthropic', openai: 'deepseek', gemini: 'google', qwen: 'qwen', zhipu: 'zhipu', kimi: 'moonshot', mimo: 'xiaomi' };
  function logoOfDimVendor(id) { try { return vendorInfo(DIM_VENDOR[id] || id)?.logo || ''; } catch { return ''; } }
  const ts = (v) => { const n = typeof v === 'number' ? v : Date.parse(v || ''); return Number.isFinite(n) ? n : Infinity; };
  function countsText(c, k) {
    if (!c) return '';
    return (k === 'all' ? KINDS : [k]).filter((x) => (c[x] || 0) > 0).map((x) => `${kindLabel(x)} ${c[x]}`).join(' · ');
  }
  // 副行的三段：域名（host，窄处让位给数量）· 别的说明（meta）· 各种类的数量。r.sub 给了就只显示它
  const metaText = (r) => (r.meta || []).filter(Boolean).join(' · ');
  const tag = (text, tone = 'mute') => ({ text, tone });
  const chatCount = (p) => (p.models || []).filter((m) => m.enabled && m.kind !== 'other').length;
  const fullClaude = (id) => cp.providers.find((x) => x.id === id) || null;

  const pct = (b) => (b && typeof b.pct === 'number' ? Math.round(b.pct) + '%' : '—');
  const PLAN = { pro: 'Pro', max5x: 'Max 5x', max20x: 'Max 20x', ultra: 'Ultra', max: 'Max' };
  function acctSub(a) {
    const u = ags.usage[a.id];
    if (!u) return a.hasToken ? '…' + (a.tokenTail || '') : t('用本机登录态');
    if (u.error && !u.five_hour && !u.seven_day) return t('读不到用量');
    return [u.no_five_hour ? '' : `${t('5 小时')} ${pct(u.five_hour)}`, `${t('每周')} ${pct(u.seven_day)}`, u.fable ? `Fable ${pct(u.fable)}` : ''].filter(Boolean).join(' · ');
  }

  // —— 行 ——
  // 统一的行描述：{ key, from, id, name, logo, host?, meta[], counts, sub?, agents[], tags[{text,tone}], toggle?{on,label,fn}, open?, aria, adopt?, off,
  //                  go?{label,fn}（行尾的文字钮）, match?(k)（筛选时算不算这一类；缺省按 counts） }
  // ① 模型中心服务：按创建时间排（老数据没有 createdAt 的按服务端给的顺序垫后）
  const svcRows = $derived(hub.services.map((s, i) => ({ s, i }))
    .sort((a, b) => (ts(a.s.createdAt) - ts(b.s.createdAt)) || (a.i - b.i))
    .map(({ s }) => {
      const lines = s.lines || [];
      const models = s.models || [];
      const name = s.name || t('未命名服务');
      const tags = [];
      if (!s.enabled) tags.push(tag(t('已停用')));
      else {
        if (lines.length && !lines.some((l) => l.enabled)) tags.push(tag(t('线路已全部停用'), 'warn'));
        else if (s.authStyle !== 'none' && !lines.some((l) => l.enabled && l.hasKey)) tags.push(tag(t('缺 Key'), 'warn'));
        const cool = coolingCount(s, now);
        if (cool) tags.push(tag(t('{n} 条线路冷却中', { n: cool }), 'warn'));
        if (!models.length) tags.push(tag(t('未添加模型')));
        else if (!(s.agents || []).length) tags.push(tag(t('没给任何 agent')));
      }
      return {
        key: 'svc:' + s.id, from: 'service', id: s.id, name,
        logo: s.brand?.logo || logoByUrl(s.baseUrl), host: s.host || hostOf(s.baseUrl),
        // 老服务端的服务不带 counts，模型也不带 kind：kindTally 把它们按文本数
        counts: s.counts || kindTally(models), agents: s.agents || [], tags,
        toggle: { on: !!s.enabled, label: t('启用 {name}', { name }), fn: (v) => hubPost('update', { id: s.id, patch: { enabled: v } }) },
        open: () => openService({ id: s.id }), aria: t('编辑 {name}', { name }), adopt: null, off: !s.enabled,
      };
    }));

  // ② Vertex：凭据在 Media Studio 配；没配好时也列着（点进去是「去 Media Studio 设置」），但不给开关
  const vxRow = $derived.by(() => {
    const v = hub.vertex;
    if (!v) return null;
    const models = v.models || [];
    const tags = !v.configured ? [tag(t('未配置'))] : !v.enabled ? [tag(t('已停用'))] : !models.length ? [tag(t('未添加模型'))] : [];
    // Vertex 的媒体模型（Media Studio 的 vertex 服务，同一份凭据）也记在这一行：点进去在 Vertex 面板里开关
    const counts = { text: models.length };
    const media = (hub.builtins || []).filter((b) => b.dialect === 'vertex');
    for (const b of media) for (const m of b.models || []) if (m.enabled !== false && m.kind) counts[m.kind] = (counts[m.kind] || 0) + 1;
    const agents = [...(v.configured ? v.agents || [] : []), ...(media.some((b) => b.enabled && (b.models || []).some((m) => m.enabled !== false)) ? ['studio'] : [])];
    return {
      key: 'vertex', from: 'vertex', id: 'vertex', name: 'Vertex AI', logo: logoByKey('vertex') || 'vertexai-color',
      meta: ['Google Cloud'], counts, agents, tags,
      toggle: v.configured ? { on: !!v.enabled, label: t('启用 Vertex'), fn: (x) => hubPost('vertex', { enabled: x }) } : null,
      open: () => openHubSheet({ type: 'vertex' }), aria: t('编辑 {name}', { name: 'Vertex AI' }), adopt: null, off: !v.configured || !v.enabled,
    };
  });

  // ③ Claude 专用服务：总览里是摘要，开关走 claudeProviders（它改完会重拉 cp），再重拉总览让这一行跟上
  const claudeRows = $derived(hub.claude.map((p) => {
    const full = fullClaude(p.id);
    const tags = [];
    if (!p.enabled) tags.push(tag(t('已停用')));
    else if (!p.hasKey && full?.authStyle !== 'none') tags.push(tag(t('缺 Key'), 'warn'));
    if (!p.shown) tags.push(tag(t('已隐藏')));
    if (p.shared && cp.canShare) tags.push(tag(t('已共享给成员'), 'on'));
    // 服务端启动时会把它们自动并进模型中心；还列在这里的是那次没并成的：点它就交给模型中心（不再有 Claude 自己的编辑器）
    tags.push(tag(t('待交给模型中心'), 'warn'));
    const r = {
      key: 'claude:' + p.id, from: 'claude', id: p.id, name: p.name,
      logo: logoByUrl(p.host) || logoByKey(p.preset), host: p.host, counts: p.kinds || { text: p.models || 0 }, agents: ['claude'], tags,
      toggle: null, aria: t('把 {name} 交给模型中心', { name: p.name }), adopt: 'claude', off: !p.enabled,
    };
    r.open = () => adopt(r);
    return r;
  }));

  // ④ dimensio 自建的老服务：模型中心是唯一的配置入口，dimensio 里不再有编辑器——点这一行就是交给模型中心
  //   （确认后照抄成模型中心服务、删掉 dimensio 里那份，然后打开新服务）
  const dimRows = $derived((hub.dimensio || []).map((p) => {
    const r = {
      key: 'dim:' + p.id, from: 'dimensio', id: p.id, name: p.name, proto: p.protocol || '',
      logo: logoByUrl(p.host), host: p.host, counts: p.kinds || { text: p.models || 0 }, agents: ['dimensio'],
      tags: p.shared ? [tag(t('已共享给成员'), 'on')] : [], toggle: null,
      aria: t('把 {name} 交给模型中心', { name: p.name }),
      adopt: 'dimensio', off: false,
    };
    r.open = () => adopt(r);
    return r;
  }));

  // ⑤ Media Studio 自己的服务（托管的属于某个模型中心服务，不单列）；老字段 speech = 配音
  //   内置的（Vertex / 本机，s.builtin）不在这里：Vertex 的并进上面 Vertex 那一行，本机的是下面单独一行（HubBuiltin）。
  //   「地址 + Key」的服务启动时会自动收编；还列着的是没收编成的，点它就收编（不再有 Studio 自己的服务管理器）
  //   老服务端的总览没有 builtins：Vertex / 本机照旧一行、点开 Studio 自己的面板（新服务端才有模型中心里的那两张卡）
  const isBuiltin = (s) => !!s.builtin || s.dialect === 'vertex' || s.dialect === 'local';
  const studioRows = $derived((hub.studio || []).filter((s) => !s.managed && !(hub.builtins && isBuiltin(s))).map((s) => {
    const k = s.kinds || {};
    const counts = { image: k.image || 0, video: k.video || 0, voice: k.voice ?? k.speech ?? 0, music: k.music || 0 };
    const tags = [];
    if (!s.enabled) tags.push(tag(t('已停用')));
    else if (!s.hasKey && s.dialect !== 'vertex' && s.dialect !== 'local') tags.push(tag(t('缺 Key'), 'warn'));
    if (s.enabled && !s.models) tags.push(tag(t('未添加模型')));
    if (s.shared) tags.push(tag(t('已共享给成员'), 'on'));
    if (isBuiltin(s)) {
      return {
        key: 'studio:' + s.id, from: 'studio', id: s.id, name: s.name,
        logo: logoByUrl(s.host) || logoByKey(s.preset) || logoByKey(s.dialect), host: s.host, counts, agents: ['studio'], tags, toggle: null,
        open: () => openHubSheet({ type: 'studio', initial: { view: 'edit', id: s.id } }), aria: t('编辑 {name}', { name: s.name }), adopt: null, off: !s.enabled,
      };
    }
    tags.push(tag(t('待交给模型中心'), 'warn'));
    const r = {
      key: 'studio:' + s.id, from: 'studio', id: s.id, name: s.name,
      logo: logoByUrl(s.host) || logoByKey(s.preset) || logoByKey(s.dialect), host: s.host, counts, agents: ['studio'], tags, toggle: null,
      aria: t('把 {name} 交给模型中心', { name: s.name }), adopt: 'studio', off: !s.enabled,
    };
    r.open = () => adopt(r);
    return r;
  }));
  // Studio 的本机图像模型：不用地址和 Key，单独一行，点开是模型中心同款的面板
  const localRows = $derived((hub.builtins || []).filter((b) => b.dialect === 'local').map((b) => {
    const counts = {};
    for (const m of b.models || []) if (m.enabled !== false && m.kind) counts[m.kind] = (counts[m.kind] || 0) + 1;
    const tags = [];
    if (!b.enabled) tags.push(tag(t('已停用')));
    if (b.shared && cp.canShare) tags.push(tag(t('已共享给成员'), 'on'));
    return {
      key: 'builtin:' + b.id, from: 'builtin', id: b.id, name: b.name, logo: '', meta: [t('本机')], counts,
      agents: b.enabled && Object.keys(counts).length ? ['studio'] : [], tags, toggle: null,
      open: () => openHubSheet({ type: 'builtin', id: b.id }), aria: t('编辑 {name}', { name: b.name }), adopt: null, off: !b.enabled,
    };
  }));
  // Studio 的服务列表读不出（服务端给 studio: [] + studioErr）：在那几行的位置如实说一句，别让人以为一个都没有。
  // 这句是服务端写的运行时文案，走 tr()；它管的是媒体服务，所以筛「文本」时不出
  const studioErrRow = $derived(hub.studioErr ? {
    key: 'studio-err', from: 'studio', id: '', name: 'Media Studio', logo: '', sub: tr(hub.studioErr), subWarn: true, agents: [], tags: [],
    toggle: null, open: null, aria: '', adopt: null, off: false, go: { label: t('重试'), fn: retry }, match: (k) => k !== 'text',
  } : null);

  // ⑥ 插件提供的：地址和账号在插件自己的面板里管，这里只读
  const pluginRows = $derived(hub.plugins.map((p) => ({
    key: 'plugin:' + p.id, from: 'plugin', id: p.id, name: p.name, logo: '',
    meta: [t('插件'), p.plugin], counts: p.kinds || { text: p.models || 0 }, agents: p.agents || [], tags: [],
    toggle: null, open: null, aria: '', adopt: null, off: false,
  })));

  const adminRows = $derived([...svcRows, vxRow, ...localRows, ...claudeRows, ...dimRows, ...studioRows, studioErrRow, ...pluginRows].filter(Boolean));
  // 只剩一行「未配置」的 Vertex 也算空：那一行不是用户接的服务
  const adminEmpty = $derived(!adminRows.some((r) => r.from !== 'vertex' || hub.vertex?.configured));
  // 筛选只在有服务卡时生效（全删光后筛选条收起，别让下面两组被一个看不见的筛选藏掉）
  const fk = $derived(mode === 'admin' && !adminEmpty ? kind : 'all');
  const shown = $derived(fk === 'all' ? adminRows : adminRows.filter((r) => (r.match ? r.match(fk) : (r.counts?.[fk] || 0) > 0)));
  // 订阅号与内置厂商都是文本模型：筛别的种类时这两组一并收起
  const textish = $derived(fk === 'all' || fk === 'text');

  const acctRows = $derived(mode === 'admin' && ags.poolOk ? ags.accounts.map((a) => {
    const name = a.label || t('默认账号');
    const plan = PLAN[ags.usage[a.id]?.plan];
    return {
      key: 'acct:' + a.id, id: a.id, name, logo: vendorInfo('anthropic')?.logo || 'claude-color', sub: acctSub(a), num: true, agents: [],
      tags: [plan && tag(plan), a.active && tag(t('使用中'), 'on')].filter(Boolean), toggle: null,
      // 加号、排序、自动换号都在 设置 › Claude 的账号一栏：点行直达那一页
      open: () => openSettings('claude'), aria: t('管理 {name}', { name }), adopt: null, off: false,
    };
  }) : []);

  const vendorRows = $derived(mode === 'admin' && dimReady() ? keyVendors().map((v) => ({
    key: 'vendor:' + v.id, id: v.id, name: v.name, logo: logoOfDimVendor(v.id),
    // 没填 Key 的厂商是常态（只用其中一两家），只有当前默认那家缺 Key 才标成警示色
    sub: v.hasKey ? t('已配 Key') : t('未填 Key'), subWarn: !v.hasKey && v.current, agents: [],
    tags: v.current ? [tag(t('默认'), 'on')] : [], toggle: null,
    open: canSetKey(v.id) ? () => openHubSheet({ type: 'dkey', vendor: { id: v.id, name: v.name, hasKey: v.hasKey } }) : null,
    aria: t('{name} 的 API Key', { name: v.name }), adopt: null, off: false,
  })) : []);

  // —— 成员 ——
  const ownRows = $derived(mode === 'member' ? cp.providers.map((p) => {
    const tags = [];
    if (!p.enabled) tags.push(tag(t('已停用')));
    else if (!p.hasKey && p.authStyle !== 'none') tags.push(tag(t('缺 Key'), 'warn'));
    if (p.showInPicker === false) tags.push(tag(t('已隐藏')));
    return {
      key: 'own:' + p.id, from: 'claude', id: p.id, name: p.name,
      logo: logoByUrl(p.baseUrl) || logoByKey(p.preset), host: hostOf(p.baseUrl), counts: { text: chatCount(p) }, agents: ['claude'], tags,
      toggle: { on: !!p.enabled, label: t('启用 {name}', { name: p.name }), fn: (v) => updateProvider(p.id, { enabled: v }) },
      open: () => openHubSheet({ type: 'claude', id: p.id }), aria: t('编辑 {name}', { name: p.name }), adopt: null, off: !p.enabled,
    };
  }) : []);
  const sharedRows = $derived(mode === 'member' ? cp.shared.map((p) => ({
    key: 'shared:' + p.id, id: p.id, name: p.name, logo: logoByKey(p.preset), meta: [p.note], counts: { text: (p.models || []).length },
    agents: ['claude'], tags: [tag(t('管理员共享'))], toggle: null, open: null, aria: '', adopt: null, off: !p.enabled,
  })) : []);
  const dimLink = $derived(mode === 'member' && dimReady() ? {
    key: 'dimlink', name: t('dimensio 的模型服务'), logo: '', sub: customSummary(), agents: ['dimensio'], tags: [], toggle: null,
    open: () => openInDimensio('vendors'), aria: t('打开 dimensio 的模型服务'), adopt: null, off: false,
  } : null);
  const atMax = $derived(mode === 'member' && cp.member && cp.maxProviders > 0 && cp.providers.length >= cp.maxProviders);

  // 错峰的总数（总时长封顶，行再多也不拖）
  const totalN = $derived(mode === 'admin' ? shown.length + acctRows.length + vendorRows.length : ownRows.length + sharedRows.length + (dimLink ? 1 : 0));

  // —— 操作 ——
  // 连着老服务端：它没有识别、目录、按模型分去向这些接口，服务浮层开了也是一屏报错——顶上常驻这一句，点到要进浮层的地方也弹这一句
  const legacy = $derived(mode === 'admin' && hubLegacy());
  const oldServerText = () => t('服务器版本较旧，添加服务与改模型要先更新服务器');
  // 模型中心服务的浮层（添加 / 详情）：sheet 是 { add: true } 或 { id }
  function openService(sheet) {
    if (hubLegacy()) { uiAlert(oldServerText()); return; }
    openHubSheet({ type: 'service', ...sheet });
  }
  function add() {
    if (atMax) return;
    if (mode === 'admin') openService({ add: true });
    else openHubSheet({ type: 'claude', presets: true });
  }

  async function flip(r, v) {
    if (!r.toggle || r.key in pend) return;
    pend[r.key] = v;
    try { await r.toggle.fn(v); }
    catch (e) { uiAlert(e?.message || t('没改成'), { type: 'error' }); }
    finally { delete pend[r.key]; }
  }
  // 桌面开关是自己翻面的（DSwitch 点了先改自己再回调）：提交中在捕获阶段截住点击，免得它翻过去又被弹回
  const guardSw = (r) => (e) => { if (r.key in pend) { e.stopPropagation(); e.preventDefault(); } };
  // DSwitch 没有 aria-label 参数：给里面那颗 role=switch 补上，读屏才知道是哪一行的开关
  function swLabel(node, label) {
    const set = (l) => node.querySelector('[role="switch"]')?.setAttribute('aria-label', l || '');
    set(label);
    return { update: set };
  }

  // 「改为共用」的确认框：问句（message）+ 后果（detail）两级，别把整段都塞进粗体的问句里。
  // 文案按 adoptReach() 给的结果措辞，它和后端 adopt 实际做的一致（src/routes/model-hub.mjs）：
  //   both   → 照抄成模型中心服务，Claude 和 dimensio 两边都能选；
  //   origin → 照抄过去仍只有原来那一边能选（Gemini 接口给不了 Claude、这台服务器没开 dimensio）：问句与确认钮换成「交给模型中心」，不许诺另一边；
  //   studio → 原地托管（服务 id、地址、Key、媒体模型都不动）。
  function adoptAsk(r) {
    const name = r.name;
    const reach = adoptReach(r.adopt, r.proto);
    const head = reach === 'both'
      ? { message: t('把「{name}」改为两边共用？', { name }), okLabel: t('改为共用') }
      : { message: t('把「{name}」交给模型中心管理？', { name }), okLabel: t('交给模型中心') };
    const detail = reach === 'studio'
      ? t('地址、Key 和现有的媒体模型不变，之后还能把它的文本模型加到 Claude 和 dimensio。')
      : r.adopt === 'claude'
        ? (reach === 'both'
          ? t('地址、型号和 Key 会照抄成一个共用服务，dimensio 里也能选；原来那份从 Claude 的模型菜单里隐藏（用着它的老会话照常能跑）。')
          : t('地址、型号和 Key 会照抄成一个模型中心服务；原来那份从 Claude 的模型菜单里隐藏（用着它的老会话照常能跑）。'))
        : (reach === 'both'
          ? t('地址、型号和 Key 会照抄成一个共用服务，Claude 里也能选；原来那份会从 dimensio 里删掉，正用着它的对话要重新选一次模型。')
          : t('地址、型号和 Key 会照抄成一个模型中心服务，模型照旧只给 dimensio（Gemini 接口给不了 Claude）；原来那份会从 dimensio 里删掉，正用着它的对话要重新选一次模型。'));
    return { ...head, detail };
  }

  async function adopt(r) {
    if (!r.adopt || busy[r.key]) return;
    busy[r.key] = true;
    try {
      if (r.adopt === 'dimensio') {
        // dimensio 的老服务：和 dimensio「模型服务」面板卡片上的铅笔同一条路（lib/modelHubAdopt.js，自带确认与报错）
        const moved = await adoptDimensioService({ id: r.id, name: r.name, proto: r.proto });
        if (moved?.service?.id) openHubSheet({ type: 'service', id: moved.service.id });
        return;
      }
      const { message, detail, okLabel } = adoptAsk(r);
      if (!(await uiConfirm(message, { detail, okLabel }))) return;
      const res = await hubPost('adopt', { from: r.adopt, id: r.id });
      if (r.adopt === 'claude') loadProviders(true);
      if (r.adopt === 'dimensio') {
        // 原来那份经 dimensio 自己的接口删（它的注册表在 harness 进程里）；删不掉不算失败，模型中心的那份已经建好
        try { await api.post('/api/harness/api/custom-providers/' + encodeURIComponent(r.id) + '/delete', {}); }
        catch {
          await uiAlert(t('模型中心服务已经建好，但 dimensio 里原来那份没删掉'),
            { type: 'warning', detail: t('请到 dimensio 的「模型服务」里手动删一下，免得出现两张一样的卡。') });
        }
        ds.rev++;
        loadDimensio({ quiet: true });
        await loadHub(true);
      }
      // 搬好了直接打开它的详情（每个模型给了谁当场看得见）；连着老服务端时 openHubSheet 不开服务浮层，留在首页
      if (res?.service?.id) openHubSheet({ type: 'service', id: res.service.id });
    } catch (e) {
      uiAlert(e?.message || t('没改成'), { type: 'error' });
    } finally {
      delete busy[r.key];
    }
  }

  // —— 种类筛选条：一块浅底滑块在选项间滑动（墨色实心只留给「添加服务」） ——
  const FILTERS = ['all', ...KINDS];
  const shownSig = () => shown.map((r) => r.key).join('|');
  let rowsAnim = null;
  // 点击与方向键都走这里。切筛选那一下行与分组直接换（muteFx 让收放高度的过渡让路，见 fx），只有服务卡的内容淡入——只动 opacity
  function setKind(k) {
    if (k === kind) return;
    const before = shownSig();
    muteFx = true;
    kind = k;
    tick().then(() => {
      // 行真的换了才淡入：从「全部」切到「文本」而每个服务都有文本模型时，卡里还是那几行，不闪这一下
      if (armed && !reduced() && rowsEl && shownSig() !== before) {
        rowsAnim?.cancel();
        rowsAnim = animate(rowsEl, [{ opacity: 0 }, { opacity: 1 }], { d: DUR.quick, e: EASE.decel, fill: 'none' });
      }
      // 这一轮的进出场都已经按「静音」取过参数了；下一帧放开，之后单行的增删照旧收放
      requestAnimationFrame(() => { muteFx = false; });
    });
  }
  const ALL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/></svg>';
  const fname = (k) => (k === 'all' ? t('全部') : kindLabel(k));
  let strip = $state(null);
  let tx = $state(0);
  let tw = $state(0);
  let tOn = $state(false);          // 首次量好位置之后才开过渡：不然滑块会从最左边滑进来
  let fl = $state(0);
  let fr = $state(0);
  const chipOf = (k) => strip?.querySelector(`[data-k="${k}"]`) || null;
  function measure() {
    const el = chipOf(kind);
    if (!el) return;
    tx = el.offsetLeft;
    tw = el.offsetWidth;
    if (!tOn) requestAnimationFrame(() => requestAnimationFrame(() => { tOn = true; }));
  }
  // 两端渐隐随滚动位置连续变化（离边越近遮得越少），不用开关式的跳变
  function edges() {
    if (!strip) return;
    const max = strip.scrollWidth - strip.clientWidth;
    fl = Math.max(0, Math.min(20, strip.scrollLeft));
    fr = Math.max(0, Math.min(20, max - strip.scrollLeft));
  }
  // 窄屏一行放不下时，选中的那个滚进可见区（两边留出渐隐的宽度）
  function reveal(smooth) {
    const el = chipOf(kind);
    if (!el || !strip || strip.scrollWidth <= strip.clientWidth) return;
    const pad = 28;
    const a = el.offsetLeft - pad, b = el.offsetLeft + el.offsetWidth + pad - strip.clientWidth;
    const x = strip.scrollLeft > a ? a : strip.scrollLeft < b ? b : null;
    if (x == null) return;
    strip.scrollTo({ left: Math.max(0, x), behavior: smooth && !reduced() ? 'smooth' : 'auto' });
  }
  $effect(() => {
    kind;
    if (!strip) return;
    untrack(() => { measure(); reveal(tOn); edges(); });
  });
  // 字体晚到、窗口改宽、语言切换都会改选项宽度：量一次不够
  $effect(() => {
    const el = strip;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => { measure(); edges(); });
    ro.observe(el);
    for (const c of el.children) ro.observe(c);
    return () => ro.disconnect();
  });
  function onKey(e) {
    const i = FILTERS.indexOf(kind);
    let j = -1;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') j = (i + 1) % FILTERS.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') j = (i - 1 + FILTERS.length) % FILTERS.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = FILTERS.length - 1;
    if (j < 0) return;
    e.preventDefault();
    setKind(FILTERS[j]);
    tick().then(() => chipOf(kind)?.focus({ preventScroll: true }));
  }

  // —— 动效 ——
  const STD = bezier(0.2, 0, 0, 1);
  const DECEL = bezier(0.05, 0.7, 0.1, 1);
  // 首屏：自下而上 6px 淡入，按行错峰（stagger 把总时长封在 220ms 内）
  function enter(node, i) {
    if (armed || reduced()) return;
    animate(node, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
      { d: DUR.base, e: EASE.decel, delay: stagger(i, untrack(() => totalN), 220, 30), fill: 'backwards' });
  }
  // 之后单行的增删（加了 / 删了一个服务、整组因为数据晚到而出现）：高度与内边距一起收放 + 淡入淡出。
  // 切筛选不走它（muteFx）：那是一次换一屏，十来个元素同时收放高度会掉帧，改成直接换 + 内容淡入（setKind）。
  // 本地过渡：外壳切走分区时整页卸载，不会被它拖住
  function fx(node) {
    if (!armed || muteFx || reduced()) return { duration: 0 };
    const cs = getComputedStyle(node);
    const h = node.offsetHeight;
    const pt = parseFloat(cs.paddingTop) || 0, pb = parseFloat(cs.paddingBottom) || 0, mb = parseFloat(cs.marginBottom) || 0;
    return {
      duration: DUR.base, easing: STD,
      css: (k) => `height:${k * h}px;min-height:0;padding-top:${k * pt}px;padding-bottom:${k * pb}px;margin-bottom:${k * mb}px;opacity:${k * k};overflow:hidden`,
    };
  }
  // 只动 opacity 的淡入
  function fade(node) {
    if (!armed || reduced()) return { duration: 0 };
    return { duration: DUR.quick, easing: DECEL, css: (k) => `opacity:${k}` };
  }
  // 「没有这一类的服务」这一行：切筛选时跟着整卡内容一起淡入（不叠第二层）；别的时候（删到一行不剩）自己淡入
  const noneIn = (node) => (muteFx ? { duration: 0 } : fade(node));
  // 下面两组（订阅账号、内置厂商）的出现：切筛选切回来时只淡入；数据晚到时照旧展开
  const grpIn = (node) => (muteFx ? fade(node) : fx(node));
</script>

{#snippet chev()}
  {#if desk}
    <svg class="hh-chev" viewBox="0 0 6 10" width="6" height="10" aria-hidden="true"><path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>
  {:else}
    <span class="hh-chev" aria-hidden="true"><Sym name="chevron.right" weight={600} size={13} /></span>
  {/if}
{/snippet}

{#snippet addBtn()}
  <button type="button" class="hh-add" disabled={atMax} aria-label={t('添加服务')}
    title={atMax ? t('最多 {n} 个服务', { n: cp.maxProviders }) : undefined} onclick={add}>
    <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M10 4.5v11M4.5 10h11" /></svg>
    <span class="hh-addt">{t('添加服务')}</span>
  </button>
{/snippet}

<!-- 空态：一张接好的服务卡 + 一张虚线的「待添加」卡，线稿；不配解释句 -->
{#snippet empty()}
  <div class="hh-grp">
    <div class="hh-card hh-empty" use:enter={0}>
      <svg class="hh-art" viewBox="0 0 120 84" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="6" y="8" width="74" height="30" rx="8" />
        <circle cx="21" cy="23" r="6.5" />
        <path d="M34 19h30M34 27.5h19" />
        <rect x="40" y="46" width="74" height="30" rx="8" stroke-dasharray="3 3.5" />
        <path d="M77 54.5v13M70.5 61h13" />
      </svg>
      {@render addBtn()}
    </div>
  </div>
{/snippet}

{#snippet inner(r)}
  <!-- 副行：r.sub 给了就只显示它；否则「域名 · 说明 · 数量」。域名单独包一层：窄处行尾的图标、开关、箭头占掉一大半，
       这时只留数量（数量才是这一行要说的），域名让位；没有数量可说时域名留着，免得副行空掉 -->
  {@const rest = r.sub != null ? r.sub : [metaText(r), countsText(r.counts, fk)].filter(Boolean).join(' · ')}
  {@const host = r.sub == null ? r.host || '' : ''}
  {#if r.open}<button type="button" class="hh-hit" aria-label={r.aria} onclick={r.open}></button>{/if}
  <span class="hh-lead" class:off={r.off}><BrandLogo logo={r.logo || ''} name={r.name} size={36} /></span>
  <span class="hh-main">
    <span class="hh-name">{r.name}</span>
    {#if host || rest || r.tags.length}
      <span class="hh-sub">
        {#each r.tags as g (g.text)}<span class="hh-tag hh-tin {g.tone}">{g.text}</span>{/each}
        {#if host || rest}
          <span class="hh-subt" class:warn={r.subWarn} class:num={r.num}>{#if host}<span class="hh-host" class:solo={!rest}>{host}{rest ? ' · ' : ''}</span>{/if}{rest}</span>
        {/if}
      </span>
    {/if}
  </span>
  <span class="hh-end">
    {#if r.agents?.length}<span class="hh-ag" class:off={r.off}><AgentStack agents={r.agents} size={18} /></span>{/if}
    {#each r.tags as g (g.text)}<span class="hh-tag hh-tout {g.tone}">{g.text}</span>{/each}
    {#if r.go}
      <button type="button" class="hh-go" disabled={retrying} onclick={r.go.fn}>{r.go.label}</button>
    {/if}
    {#if r.adopt}
      <button type="button" class="hh-adopt" disabled={!!busy[r.key]} onclick={() => adopt(r)}>{t('改为共用')}</button>
    {/if}
    {#if r.toggle}
      {@const on = pend[r.key] ?? r.toggle.on}
      {#if desk}
        <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
        <span class="hh-sw" onclickcapture={guardSw(r)} use:swLabel={r.toggle.label}><DSwitch checked={on} onchange={(v) => flip(r, v)} /></span>
      {:else}
        <span class="hh-sw"><Toggle checked={on} label={r.toggle.label} onchange={() => flip(r, !on)} /></span>
      {/if}
    {/if}
    {#if r.open}{@render chev()}{/if}
  </span>
{/snippet}

<div class="hh" class:desk class:ios={!desk}>
  {#if mode === 'admin' || mode === 'member'}
    {#if loadErr}
      <div class="hh-note" role="status">
        <span class="hh-note-tx">{loadErr}</span>
        <button type="button" class="hh-go" disabled={retrying} onclick={retry}>{t('重试')}</button>
      </div>
    {/if}

    {#if mode === 'admin'}
      {#if legacy}
        <div class="hh-note hh-note-plain" role="status"><span class="hh-note-tx">{oldServerText()}</span></div>
      {/if}
      {#if adminEmpty}
        {@render empty()}
      {:else}
        <div class="hh-top">
          <div class="hh-strip" bind:this={strip} role="radiogroup" aria-label={t('按种类筛选')} tabindex="-1"
            style:--fl={fl + 'px'} style:--fr={fr + 'px'} onscroll={edges} onkeydown={onKey}>
            <span class="hh-thumb" class:ready={tw > 0} class:anim={tOn} style:transform={`translateX(${tx}px)`} style:width={tw + 'px'} aria-hidden="true"></span>
            {#each FILTERS as k (k)}
              <button type="button" role="radio" class="hh-chip" class:sel={kind === k} aria-checked={kind === k} tabindex={kind === k ? 0 : -1}
                data-k={k} onclick={() => setKind(k)}>
                <span class="hh-ci" aria-hidden="true">{@html k === 'all' ? ALL_ICON : KIND_ICON?.[k] || ''}</span>{fname(k)}
              </button>
            {/each}
          </div>
          {@render addBtn()}
        </div>
        <div class="hh-grp">
          <div class="hh-card">
            <div class="hh-rows" bind:this={rowsEl}>
              {#each shown as r, i (r.key)}
                <div class="hh-row" class:ro={!r.open} class:off={r.off} use:enter={i} transition:fx>{@render inner(r)}</div>
              {/each}
              {#if !shown.length}
                <div class="hh-none" in:noneIn>{t('没有这一类的服务')}</div>
              {/if}
            </div>
          </div>
        </div>
      {/if}

      {#if textish && acctRows.length}
        <section class="hh-grp" in:grpIn out:fx>
          <h3 class="hh-glabel">{t('Claude 订阅账号')}</h3>
          <div class="hh-card">
            {#each acctRows as r, i (r.key)}
              <div class="hh-row" class:ro={!r.open} use:enter={shown.length + i} transition:fx>{@render inner(r)}</div>
            {/each}
          </div>
        </section>
      {/if}

      {#if textish && vendorRows.length}
        <section class="hh-grp" in:grpIn out:fx>
          <h3 class="hh-glabel">{t('dimensio 内置厂商')}</h3>
          <div class="hh-card">
            {#each vendorRows as r, i (r.key)}
              <div class="hh-row" class:ro={!r.open} use:enter={shown.length + acctRows.length + i} transition:fx>{@render inner(r)}</div>
            {/each}
          </div>
        </section>
      {/if}

    {:else}
      {#if !ownRows.length}
        {@render empty()}
      {:else}
        <div class="hh-top">
          <h3 class="hh-glabel hh-tl">{t('我的服务')}</h3>
          {@render addBtn()}
        </div>
        <div class="hh-grp">
          <div class="hh-card">
            {#each ownRows as r, i (r.key)}
              <div class="hh-row" class:off={r.off} use:enter={i} transition:fx>{@render inner(r)}</div>
            {/each}
          </div>
        </div>
      {/if}

      {#if sharedRows.length}
        <section class="hh-grp" transition:fx>
          <h3 class="hh-glabel">{t('管理员共享给你的服务')}</h3>
          <div class="hh-card">
            {#each sharedRows as r, i (r.key)}
              <div class="hh-row ro" class:off={r.off} use:enter={ownRows.length + i} transition:fx>{@render inner(r)}</div>
            {/each}
          </div>
        </section>
      {/if}

      {#if dimLink}
        <section class="hh-grp" transition:fx>
          <h3 class="hh-glabel">dimensio</h3>
          <div class="hh-card">
            <div class="hh-row" use:enter={ownRows.length + sharedRows.length}>{@render inner(dimLink)}</div>
          </div>
        </section>
      {/if}
    {/if}

  {:else if mode === 'wait' && (!settled || retrying)}
    <div class="hh-grp"><div class="hh-card"><div class="hh-msg" role="status">{t('正在读取…')}</div></div></div>
  {:else}
    <div class="hh-grp">
      <div class="hh-card">
        <div class="hh-msg" role="alert">
          <span class="hh-note-tx">{loadErr || t('读不到模型服务')}</span>
          <button type="button" class="hh-go" disabled={retrying} onclick={retry}>{t('重试')}</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  /* 墨与象牙（契约 §8）：BrandLogo / AgentStack 等子组件读这组；外壳令牌缺席时 --hh-* 也拿它兜底。
     这里刻意不定义 --i-*：iOS 壳的 Toggle 读外壳那份（含 ink 墨色开关的轨道与钮），在这里重定义会把它盖掉 */
  .hh {
    --pm-bg: #100f0d; --st-surface: #1a1917; --text: #f1ece2;
    --st-text2: rgba(241, 236, 226, .74); --st-muted: rgba(241, 236, 226, .5);
    --st-line: rgba(241, 236, 226, .1); --st-hair: rgba(241, 236, 226, .065);
    --st-sel: rgba(241, 236, 226, .1); --st-hover: rgba(241, 236, 226, .05); --pm-press: rgba(241, 236, 226, .06);
    --st-field: rgba(241, 236, 226, .06); --st-seg: rgba(241, 236, 226, .07); --st-thumb: rgba(241, 236, 226, .2);
    --st-accent: #ebe5d8; --st-primary: #ebe5d8; --st-primary-ink: #151412; --pm-knob-on: #151412;
    --pm-warn: #d9a441; --pm-red: #e2725f;
    container: hh / inline-size;
    color: var(--hh-ink);
    font-family: var(--hh-font);
    -webkit-font-smoothing: antialiased;
  }
  :global(html[data-theme="light"]) .hh {
    --pm-bg: #f2f0eb; --st-surface: #fcfbf8; --text: #1d1b18;
    --st-text2: rgba(29, 27, 24, .72); --st-muted: rgba(29, 27, 24, .5);
    --st-line: rgba(29, 27, 24, .1); --st-hair: rgba(29, 27, 24, .075);
    --st-sel: rgba(29, 27, 24, .08); --st-hover: rgba(29, 27, 24, .04); --pm-press: rgba(29, 27, 24, .055);
    --st-field: rgba(29, 27, 24, .045); --st-seg: rgba(29, 27, 24, .06); --st-thumb: #fff;
    --st-accent: #1d1b18; --st-primary: #1d1b18; --st-primary-ink: #f6f3ec; --pm-knob-on: #fff;
    --pm-warn: #b0741c; --pm-red: #c4473b;
  }

  /* —— 外壳映射：桌面壳（SettingsDesktop 的 .sd 令牌；分组卡 12 圆角 + 1px 内描边，行 8/14 内边距，分隔线左右各缩 14） —— */
  .hh.desk {
    --hh-font: var(--dsk-font, var(--font-brand-sans), -apple-system, BlinkMacSystemFont, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif);
    --hh-card: var(--dsk-panel, var(--st-surface));
    --hh-ink: var(--dsk-ink, var(--text));
    --hh-ink2: var(--dsk-ink-2, var(--st-text2));
    --hh-ink3: var(--dsk-ink-3, var(--st-muted));
    --hh-edge: inset 0 0 0 1px var(--dsk-line, var(--st-line));
    --hh-sep: var(--dsk-line, var(--st-line));
    --hh-hover: var(--dsk-hover, var(--st-hover));
    --hh-press: var(--dsk-active, var(--pm-press));
    --hh-accent: var(--dsk-accent, var(--st-accent));
    --hh-on-accent: var(--dsk-accent-ink, var(--st-primary-ink));
    --hh-warn: var(--dsk-warn, var(--pm-warn));
  }
  /* —— 外壳映射：手机 / 网页壳（Settings.svelte 的 .ios 令牌；分组卡 18 圆角 + .5px 描边，行 16 内边距，分隔线从文字列起） —— */
  .hh.ios {
    --hh-font: var(--font-brand-sans), -apple-system, BlinkMacSystemFont, system-ui, "PingFang SC", "Microsoft YaHei", sans-serif;
    --hh-card: var(--i-card, var(--st-surface));
    --hh-ink: var(--i-label, var(--text));
    --hh-ink2: var(--i-label2, var(--st-text2));
    --hh-ink3: var(--i-label3, var(--st-muted));
    --hh-edge: inset 0 0 0 .5px var(--i-label4, var(--st-line));
    --hh-sep: var(--i-sep, var(--st-hair));
    --hh-hover: transparent;
    --hh-press: var(--i-press, var(--pm-press));
    --hh-accent: var(--i-accent, var(--st-accent));
    --hh-on-accent: var(--i-on-accent, var(--st-primary-ink));
    --hh-warn: var(--i-warn, var(--pm-warn));
  }

  /* —— 分组 —— */
  .hh-grp { margin-bottom: 26px; }
  .hh-glabel { margin: 0; font: inherit; }
  .desk .hh-glabel { margin: 0 12px 8px; font-size: var(--dsk-fs-sm, 12px); line-height: 1.4; font-weight: 500; color: var(--hh-ink3); }
  .ios .hh-glabel { padding: 0 16px 8px; font-size: 13px; line-height: 18px; font-weight: 500; letter-spacing: .2px; color: var(--hh-ink2); }
  .hh-card { position: relative; overflow: hidden; isolation: isolate; background: var(--hh-card); }
  /* 描边画在最上层的伪元素上：行的按下底色铺满整卡时不会盖住边 */
  .hh-card::after { content: ''; position: absolute; inset: 0; border-radius: inherit; box-shadow: var(--hh-edge); pointer-events: none; z-index: 2; }
  .desk .hh-card { border-radius: 12px; }
  .ios .hh-card { border-radius: 18px; }

  /* —— 行 —— */
  .hh-row { position: relative; display: flex; align-items: center; }
  .desk .hh-row { min-height: 52px; padding: 8px 14px; gap: 12px; }
  .ios .hh-row { min-height: 50px; padding: 0 16px; gap: 14px; }
  .hh-row + .hh-row::before { content: ''; position: absolute; top: 0; height: 1px; background: var(--hh-sep); pointer-events: none; z-index: 1; }
  .desk .hh-row + .hh-row::before { left: 14px; right: 14px; }
  .ios .hh-row + .hh-row::before { left: 66px; right: 16px; }   /* 16 内边距 + 36 品牌标 + 14 间距 = 文字列起点 */
  /* 整行可点：一颗铺满的透明按钮垫在最下层，内容不吃指针，只有开关与文字按钮浮在它上面 */
  .hh-hit { position: absolute; inset: 0; z-index: 0; width: 100%; padding: 0; border: 0; border-radius: 0; background: transparent; cursor: pointer;
    transition: background-color 260ms var(--ea-fade, ease); }
  .hh-hit:active { background: var(--hh-press); transition-duration: 60ms; }
  .hh-hit:focus-visible { outline: none; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--hh-ink) 35%, transparent); }
  @media (hover: hover) { .desk .hh-hit:hover { background: var(--hh-hover); } }
  .hh-lead, .hh-main, .hh-end { position: relative; z-index: 1; pointer-events: none; }
  .hh-lead { flex: none; display: flex; transition: opacity 200ms var(--ea-fade, ease); }
  .hh-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .ios .hh-main { padding: 12px 0; }
  .hh-name { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: var(--hh-ink); transition: color 200ms var(--ea-fade, ease); }
  .desk .hh-name { font-size: var(--dsk-fs-body, 14px); line-height: 1.35; font-weight: 500; }
  .ios .hh-name { font-size: 16px; line-height: 22px; letter-spacing: -.1px; }
  .hh-row.off .hh-name { color: var(--hh-ink2); }
  .hh-sub { display: flex; align-items: center; gap: 6px; min-width: 0; }
  .desk .hh-sub { font-size: var(--dsk-fs-sm, 12px); line-height: 1.4; color: var(--hh-ink3); }
  .ios .hh-sub { font-size: 13px; line-height: 18px; color: var(--hh-ink2); }
  .hh-subt { min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .hh-subt.warn { color: var(--hh-warn); }
  .hh-end { flex: none; display: flex; align-items: center; gap: 10px; }
  .hh-end > button, .hh-sw { pointer-events: auto; }
  .hh-sw { flex: none; display: flex; align-items: center; }
  .hh-ag { flex: none; display: flex; transition: opacity 200ms var(--ea-fade, ease); }
  .hh-lead.off, .hh-ag.off { opacity: .45; }
  .hh-chev { flex: none; display: flex; color: var(--hh-ink3); }
  .ios .hh-chev { margin-left: 2px; }

  /* 状态标签：底色层次 + 文字，不用彩点 / 彩条 */
  .hh-tag { flex: none; display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px; font-size: 11.5px; font-weight: 500; line-height: 1;
    white-space: nowrap; background: color-mix(in srgb, var(--hh-ink) 6%, transparent); color: var(--hh-ink2); }
  .hh-tag.warn { background: color-mix(in srgb, var(--hh-warn) 15%, transparent); color: var(--hh-warn); }
  .hh-tag.on { background: color-mix(in srgb, var(--hh-ink) 11%, transparent); color: var(--hh-ink); }
  .hh-tin { display: none; }
  /* 窄（手机、窄窗口）：标签挪进副行行首，行尾只留给谁用、开关与箭头；副行里的域名让位给数量（没有数量可说的 .solo 留着） */
  @container hh (max-width: 519px) {
    .hh-tout { display: none; }
    .hh-tin { display: inline-flex; }
    .hh-host:not(.solo) { display: none; }
    .hh-end { gap: 8px; }   /* 行尾收紧一点，把宽度还给名字和数量 */
  }
  @container hh (max-width: 339px) { .hh-ag { display: none; } }

  /* 「改为共用」：行尾的文字按钮，只在宽处出（窄屏一行放不下，也不该在手机上做这种整理动作） */
  .hh-adopt { flex: none; height: 28px; padding: 0 10px; border-radius: 8px; font-size: 13px; color: var(--hh-ink2); white-space: nowrap;
    transition: background-color 140ms var(--ea-fade, ease), color 140ms var(--ea-fade, ease); }
  .hh-adopt:hover:not(:disabled) { background: color-mix(in srgb, var(--hh-ink) 7%, transparent); color: var(--hh-ink); }
  .hh-adopt:disabled { opacity: .45; cursor: default; }
  .hh-adopt:focus-visible { outline: none; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--hh-ink) 35%, transparent); }
  @container hh (max-width: 559px) { .hh-adopt { display: none; } }
  @media (max-width: 699px) { .hh-adopt { display: none; } }

  /* —— 顶行：种类筛选 + 添加服务 —— */
  .hh-top { display: flex; align-items: center; gap: 12px; min-width: 0; margin-bottom: 12px; }
  .hh-tl { flex: 1; min-width: 0; }
  .desk .hh-top .hh-tl { margin: 0 12px; }
  .ios .hh-top .hh-tl { padding: 0 16px; }
  .hh-strip { position: relative; flex: 1; min-width: 0; display: flex; gap: 2px; overflow-x: auto; overflow-y: hidden; outline: none;
    scrollbar-width: none; overscroll-behavior-x: contain; -webkit-overflow-scrolling: touch;
    -webkit-mask-image: linear-gradient(to right, transparent 0, #000 var(--fl, 0px), #000 calc(100% - var(--fr, 0px)), transparent 100%);
    mask-image: linear-gradient(to right, transparent 0, #000 var(--fl, 0px), #000 calc(100% - var(--fr, 0px)), transparent 100%); }
  .hh-strip::-webkit-scrollbar { display: none; }
  .hh-chip { position: relative; z-index: 1; flex: none; display: inline-flex; align-items: center; gap: 6px; height: 34px; padding: 0 13px 0 11px;
    border-radius: 999px; color: var(--hh-ink2); font-size: 13px; font-weight: 500; white-space: nowrap;
    transition: color var(--mo-base, 280ms) var(--ea-std, ease); }
  .hh-chip.sel { color: var(--hh-ink); }
  .hh-chip:focus-visible { outline: none; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--hh-ink) 35%, transparent); }
  @media (hover: hover) { .hh-chip:not(.sel):hover { color: var(--hh-ink); } }
  .hh-ci { flex: none; display: flex; width: 16px; height: 16px; }
  .hh-ci :global(svg) { width: 16px; height: 16px; display: block; }
  /* 滑块：一块浅底（10% 墨），选中的字回到正文墨色——这一行的墨色实心只留给右边的「添加服务」，视线先落在主操作上。
     和选项同在滚动容器里（跟着横滑走），位移 + 宽度一起过渡 */
  .hh-thumb { position: absolute; left: 0; top: 0; z-index: 0; height: 34px; border-radius: 999px; background: color-mix(in srgb, var(--hh-ink) 10%, transparent); opacity: 0; pointer-events: none; }
  .hh-thumb.ready { opacity: 1; }
  .hh-thumb.anim { transition: transform var(--mo-base, 280ms) var(--ea-std, ease), width var(--mo-base, 280ms) var(--ea-std, ease); }
  .ios .hh-chip { height: 44px; padding: 0 14px 0 12px; font-size: 15px; }
  .ios .hh-thumb { top: 5px; height: 34px; }

  .hh-add { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 34px; padding: 0 14px 0 11px;
    border-radius: 999px; background: var(--hh-accent); color: var(--hh-on-accent); font-size: 13px; font-weight: 500; white-space: nowrap;
    transition: transform var(--mo-tap, 90ms) var(--ea-std, ease), opacity var(--mo-micro, 140ms) var(--ea-fade, ease),
      background-color var(--mo-micro, 140ms) var(--ea-fade, ease), color var(--mo-micro, 140ms) var(--ea-fade, ease); }
  .hh-add svg { width: 16px; height: 16px; flex: none; }
  .hh-add:active:not(:disabled) { transform: scale(.96); }
  /* 禁用（成员的服务数到上限）：中性底 + 次要字。墨色实心打透明度会发浑，暗色下还是全屏最重的一块 */
  .hh-add:disabled { background: color-mix(in srgb, var(--hh-ink) 7%, transparent); color: var(--hh-ink3); cursor: default; }
  .hh-add:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--hh-card), 0 0 0 4px color-mix(in srgb, var(--hh-ink) 40%, transparent); }
  @media (hover: hover) { .hh-add:hover:not(:disabled) { opacity: .88; } }
  .ios .hh-add { height: 44px; padding: 0 18px 0 14px; font-size: 15px; }
  .ios .hh-add svg { width: 18px; height: 18px; }
  /* 很窄时顶行只留加号：筛选条要的是宽度 */
  @container hh (max-width: 399px) {
    .hh-top .hh-add { aspect-ratio: 1; padding: 0; }
    .hh-top .hh-addt { display: none; }
  }

  /* —— 空态、加载、出错 —— */
  .hh-empty { display: flex; flex-direction: column; align-items: center; gap: 20px; padding: 40px 16px 36px; }
  .hh-art { width: 120px; height: 84px; color: var(--hh-ink3); }
  .hh-none { display: flex; align-items: center; justify-content: center; min-height: 64px; padding: 12px 16px; font-size: 13px; color: var(--hh-ink3); }
  .ios .hh-none { font-size: 15px; }
  .hh-msg { display: flex; align-items: center; gap: 12px; min-height: 52px; padding: 8px 8px 8px 14px; font-size: 13px; color: var(--hh-ink2); }
  .ios .hh-msg { min-height: 50px; padding: 6px 8px 6px 16px; font-size: 15px; }
  .hh-note { display: flex; align-items: center; gap: 12px; min-height: 44px; margin-bottom: 14px; padding: 6px 6px 6px 14px; border-radius: 12px;
    background: color-mix(in srgb, var(--hh-warn) 14%, transparent); color: var(--hh-ink); font-size: 13px; line-height: 1.45; }
  .ios .hh-note { padding-left: 16px; border-radius: 14px; font-size: 15px; }
  /* 只有一句状态、右边没有按钮的（服务器版本较旧）：两侧留白对称，折行时上下也留出来 */
  .hh-note-plain { padding: 10px 14px; }
  .ios .hh-note-plain { padding: 11px 16px; }
  .hh-note-tx { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .hh-go { flex: none; height: 32px; padding: 0 12px; border-radius: 9px; font-size: 13px; font-weight: 500; color: var(--hh-ink);
    text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--hh-ink) 30%, transparent); text-underline-offset: 3px; }
  .hh-go:disabled { opacity: .45; cursor: default; }
  .hh-go:focus-visible { outline: none; box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--hh-ink) 35%, transparent); }
  @media (hover: hover) { .hh-go:hover:not(:disabled) { background: color-mix(in srgb, var(--hh-ink) 7%, transparent); } }
  .ios .hh-go { height: 44px; font-size: 15px; }

  @media (prefers-reduced-motion: reduce) {
    .hh-thumb.anim, .hh-chip, .hh-hit, .hh-add, .hh-lead, .hh-ag, .hh-name { transition: none; }
  }
</style>
