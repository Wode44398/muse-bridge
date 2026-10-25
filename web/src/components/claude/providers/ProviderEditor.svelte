<script>
  // 单个模型服务的编辑器（ProviderManager 里打开）。左侧分区导航（窄屏变顶部标签），底部常驻保存栏。
  //   连接：名称 / 协议 / 地址（实时显示最终请求地址；地址与协议对不上时提示，说得准或检测实测 404 才给一键改）/ 检测连接（一键识别协议）/
  //         API Key（保留·更换·清除）/ 鉴权方式 / 显示在模型列表 / 自定义请求头 / 超时 / 重试 / 出站代理
  //   模型：从端点拉取后勾选添加（每项附能力猜测，非对话模型默认不勾）、手动添加（同样先猜）；每个模型可展开改窗口、
  //         输出上限、视觉、对话 / 非对话、思考方式与档位（ThinkingTiers）、探测能力、参数覆盖；★ 默认、⚡ 小任务
  //   调用参数：服务级默认（ParamsEditor）
  //   兼容：提示缓存 / beta 头 / 精简请求 / 历史思考 / 回传思考 / 输出上限字段名
  //   测试：真打一次（没保存的草稿也能测）+ 最近请求日志；保存后自动测一次默认模型
  import { untrack } from 'svelte';
  import SToggle from '../../settings/SToggle.svelte';
  import SSegmented from '../../settings/SSegmented.svelte';
  import ParamsEditor from './ParamsEditor.svelte';
  import ThinkingTiers, { tierProblem } from './ThinkingTiers.svelte';
  import { createProvider, updateProvider, deleteProvider, fetchRemoteModels, guessModels, testProvider, detectProvider, probeModel, providerLog } from '../../../lib/claudeProviders.svelte.js';
  import { t, tr } from '../../../lib/i18n.js';   // tr：服务端下发的人话（报错、探测结论）按整句模式翻译
  import { protocolMismatch } from '../../../../../src/model-knowledge/knowledge.mjs';   // 与 dimensio 编辑器同一份规则

  let { source, onClose, onSaved, onDeleted, dirtyOut = $bindable(false) } = $props();

  const EMPTY_PARAMS = () => ({ maxTokens: null, temperature: null, topP: null, topK: null, thinking: null, thinkingBudget: null, stop: [], extraBody: '' });
  // 模型的完整形状（老服务端回来的缺字段也补齐：没有档位表的按「不思考」显示，保存时服务端照老规则换算）
  const fullModel = (m) => ({
    kind: 'chat', thinking: 'none', efforts: [], effortDefault: '', effortField: '', alwaysThinks: false, source: {},
    ...m,
    efforts: Array.isArray(m.efforts) ? m.efforts : [],
    params: { ...EMPTY_PARAMS(), ...(m.params || {}) },
  });
  const fromSource = (s) => {
    const p = JSON.parse(JSON.stringify(s || {}));
    return {
      id: p.id || '', name: p.name || '', note: p.note || '', preset: p.preset || '', enabled: p.enabled !== false, showInPicker: p.showInPicker !== false,
      protocol: p.protocol || 'anthropic', baseUrl: p.baseUrl || '', authStyle: p.authStyle || (p.protocol === 'openai' ? 'bearer' : 'x-api-key'),
      headers: Array.isArray(p.headers) ? p.headers : [], timeoutSec: p.timeoutSec ?? 600, retries: p.retries ?? 2,
      models: (p.models || []).map(fullModel),
      defaultModel: p.defaultModel || '', fastModel: p.fastModel || '',
      params: { ...EMPTY_PARAMS(), ...(p.params || {}), thinking: (p.params && p.params.thinking) || 'auto' },   // 服务级 null = 跟随会话
      compat: { promptCaching: false, stripBetas: true, slimBody: true, stripThinkingHistory: false, replayReasoning: false, maxTokensField: 'max_tokens', useProxy: true, ...(p.compat || {}) },
      hasKey: !!p.hasKey, keyTail: p.keyTail || '',
    };
  };
  let draft = $state(fromSource(untrack(() => source)));
  // 官方 api.anthropic.com：beta 头服务端一律照转（同 transform 的 keepsBetas），开关置灰
  const officialApi = $derived(draft.preset === 'anthropic' || (() => { try { return new URL(draft.baseUrl).hostname === 'api.anthropic.com'; } catch { return false; } })());
  let baseline = $state(JSON.stringify(untrack(() => draft)));
  let keyMode = $state('keep');      // keep | set | clear
  let keyInput = $state('');
  let showKey = $state(false);
  const isNew = $derived(!draft.id);
  // 草稿序列化一次，dirty 与外层的 dirtyOut 共用（300 个模型时别每次改动算两遍）
  const changed = $derived(JSON.stringify(draft) !== baseline || keyMode !== 'keep');
  const dirty = $derived(changed || isNew);
  // 给外层面板：返回键 / Esc 后退时要不要先问（新建的草稿没动过就不问）
  $effect(() => { dirtyOut = changed; });

  const SECTIONS = [
    { k: 'conn', label: () => t('连接'), icon: '<path d="M7 10a3 3 0 0 0 4.2.3l2.5-2.5a3 3 0 0 0-4.2-4.2l-1 1"/><path d="M11 8a3 3 0 0 0-4.2-.3L4.3 10.2a3 3 0 0 0 4.2 4.2l1-1"/>' },
    { k: 'models', label: () => t('模型'), icon: '<rect x="3.5" y="3.5" width="5" height="5" rx="1.2"/><rect x="11.5" y="3.5" width="5" height="5" rx="1.2"/><rect x="3.5" y="11.5" width="5" height="5" rx="1.2"/><rect x="11.5" y="11.5" width="5" height="5" rx="1.2"/>' },
    { k: 'params', label: () => t('调用参数'), icon: '<path d="M4 6h8M15 6h1M4 14h2M9 14h7"/><circle cx="13.5" cy="6" r="1.8"/><circle cx="7.5" cy="14" r="1.8"/>' },
    { k: 'compat', label: () => t('兼容'), icon: '<path d="M10 3.5 4 6v4.2c0 3.2 2.5 5.6 6 6.3 3.5-.7 6-3.1 6-6.3V6z"/><path d="m7.5 10 1.8 1.8 3.4-3.6"/>' },
    { k: 'test', label: () => t('测试与日志'), icon: '<path d="M4 10.5 8 14l8-8.5"/>' },
  ];
  let section = $state('conn');
  let scroller = $state();
  function go(k) { section = k; scroller?.scrollTo({ top: 0 }); }

  // —— 连接 ——
  const cleanBase = $derived(String(draft.baseUrl || '').trim().replace(/\/+$/, ''));
  const endpoint = $derived.by(() => {
    const b = cleanBase;
    if (!b) return '';
    return draft.protocol === 'openai' ? b + '/chat/completions' : (/\/v1$/.test(b) ? b + '/messages' : b + '/v1/messages');
  });
  // 地址和协议可能对不上的情形，规则同 dimensio 编辑器（共享模块 protocolMismatch）。sure = 说得准：实测过的站
  // （小米：…/v1 只有 OpenAI 兼容接口，按 Anthropic 协议必 404）或路径本身说明了协议（…/anthropic 配 OpenAI 协议）。
  // Anthropic 协议 + 别的站的 …/v1 不断言：new-api / one-api 一类中转的 …/v1/messages 本来就是 Anthropic 接口（Claude Code
  // 经中转最常见的配法），只给「可能」的温和提示、建议点「检测连接」；检测实测当前这组 404 了，才给一键改。
  // bridge 只有 Anthropic / OpenAI 两种协议：共享规则里指向 Gemini 的那两条不适用。
  const mismatch = $derived.by(() => {
    const m = protocolMismatch(draft.protocol, cleanBase);
    return m && (m.to === 'openai' || m.to === 'anthropic') ? m : null;
  });
  function setProtocol(v) {
    const changedProto = v !== draft.protocol;
    draft.protocol = v;
    if (v === 'openai' && draft.authStyle === 'x-api-key') draft.authStyle = 'bearer';
    if (v === 'anthropic' && draft.authStyle === 'bearer' && !draft.id) draft.authStyle = 'x-api-key';
    if (changedProto) retier(v);
  }
  // 档位的写法按协议不同（小米：Anthropic 端点 thinking.type disabled / enabled，OpenAI 端点 reasoning_effort none / high）：
  // 换协议后，档位是自动识别出来的（型号表 / 按名字猜）就按新协议重算；手动设的、探测或端点元数据给的没法凭名字重算，
  // 列出来提示去「探测能力」或「一键填入」。
  const AUTO_THINK = ['table', 'guess', 'default'];
  let retierNote = $state('');
  async function retier(protocol) {
    const auto = draft.models.filter((m) => AUTO_THINK.includes(m.source?.thinking));
    // 切回存着的那个协议 = 手动档位又对上了，不用再提示
    const back = protocol === JSON.parse(baseline).protocol;
    const manual = back ? [] : draft.models.filter((m) => m.kind !== 'other' && m.thinking !== 'none' && m.efforts.length && !AUTO_THINK.includes(m.source?.thinking));
    retierNote = manual.length ?manual.slice(0, 6).map((m) => m.label || m.id).join('、') + (manual.length > 6 ? ' …' : '') : '';
    const guesses = [];
    try { for (let i = 0; i < auto.length; i += 50) guesses.push(...await guessModels(auto.slice(i, i + 50).map((m) => m.id), protocol)); } catch { return; }
    if (draft.protocol !== protocol) return;   // 等结果的工夫又切回去了：以后来的那次为准
    for (const g of guesses) {
      const m = draft.models.find((x) => x.id === g.id);
      if (!m || !AUTO_THINK.includes(m.source?.thinking)) continue;   // 等结果期间手动改过的不动
      m.thinking = g.thinking || 'none';
      m.efforts = g.efforts || [];
      m.effortField = g.effortField || '';
      m.effortDefault = g.effortDefault || '';
      m.alwaysThinks = !!(m.alwaysThinks || g.alwaysThinks);
      m.source = { ...(m.source || {}), thinking: g.source?.thinking || 'guess' };
    }
  }
  const PROTO_OPTS = [{ value: 'anthropic', label: 'Anthropic Messages' }, { value: 'openai', label: 'OpenAI Chat' }];
  const AUTH_OPTS = [{ value: 'x-api-key', label: 'x-api-key' }, { value: 'bearer', label: 'Bearer' }, { value: 'none', label: () => t('不需要') }];
  // 只关心连接的草稿（拉模型 / 检测连接 / 探测用）：带上编辑中的 Key
  const connDraft = (withModels = false) => ({
    protocol: draft.protocol, baseUrl: draft.baseUrl, authStyle: draft.authStyle, headers: $state.snapshot(draft.headers), compat: $state.snapshot(draft.compat), name: draft.name,
    ...(withModels ? { models: $state.snapshot(draft.models) } : {}),
    ...(keyMode === 'set' ? { apiKey: keyInput } : {}),
  });
  let detecting = $state(false);
  let detect = $state(null);    // { ok, current, results, suggest } | { error }
  // 检测连接实测：当前这组（同协议、同地址；改了地址或协议就作废）返回 404 = 这里没有该协议的接口
  const detected404 = $derived(!!mismatch && detect?.current?.result === 'missing' && detect.current.protocol === draft.protocol
    && String(detect.current.baseUrl || '').replace(/\/+$/, '') === cleanBase);
  const mismatchFix = $derived(!!mismatch && (mismatch.sure || detected404));   // 说得准，或实测 404：给一键改
  async function runDetect() {
    if (detecting || !cleanBase) return;
    detecting = true; detect = null;
    try { detect = await detectProvider({ id: draft.id || undefined, draft: connDraft(true) }); }
    catch (e) { detect = { error: e.message || String(e) }; }
    detecting = false;
  }
  function applySuggest(s) {
    if (!s) return;
    setProtocol(s.protocol);
    draft.baseUrl = s.baseUrl;
    if (s.authStyle) draft.authStyle = s.authStyle;
    detect = null;
  }
  const RESULT_TEXT = { ok: () => t('通了'), model: () => t('接口在，模型名不对'), auth: () => t('接口在，Key 被拒'), missing: () => t('这里没有接口'), error: () => t('报错'), network: () => t('连不上') };

  // —— 模型 ——
  let expanded = $state({});
  let addId = $state('');
  let adding = $state(false);
  let fetching = $state(false);
  let fetchErr = $state('');
  let candidates = $state(null);     // 拉回来的列表（勾选添加）
  let picked = $state({});
  let candQ = $state('');
  const kfmt = (n) => (!n ? '—' : n >= 1_000_000 ? (n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'K' : String(n));
  // 值的来源：api / probe / user 是实打实的；table（内置型号表）/ guess（按名字猜）/ default（兜底）前面加「≈」
  const SRC_TEXT = { api: () => t('端点返回的'), probe: () => t('探测出来的'), user: () => t('手动填的'), table: () => t('内置型号表里的（未经这个端点证实）'), guess: () => t('按型号名猜的'), default: () => t('不知道，用的默认值') };
  const approx = (m, k) => ['table', 'guess', 'default'].includes(m.source?.[k]);
  const srcTitle = (m, k) => (m.source?.[k] ? SRC_TEXT[m.source[k]]?.() || '' : '');
  const markUser = (m, k) => { m.source = { ...(m.source || {}), [k]: 'user' }; };
  // 服务端的猜测 → 草稿里的模型（非对话模型默认不启用）
  const fromGuess = (g) => fullModel({
    id: g.id, label: g.label || g.id, enabled: g.kind !== 'other', kind: g.kind || 'chat',
    contextWindow: g.contextWindow || 200000, maxOutput: g.maxOutput || 32000, vision: !!g.vision,
    thinking: g.thinking || 'none', efforts: g.efforts || [], effortDefault: g.effortDefault || '', effortField: g.effortField || '', alwaysThinks: !!g.alwaysThinks, source: g.source || {},
    params: EMPTY_PARAMS(),
  });
  const firstChat = () => (draft.models.find((m) => m.enabled && m.kind !== 'other') || {}).id || '';
  async function addManual() {
    const id = addId.trim();
    if (!id || adding || draft.models.some((m) => m.id === id)) { addId = ''; return; }
    adding = true;
    let g = { id, label: id };
    try { g = (await guessModels([id], draft.protocol))[0] || g; } catch {}
    adding = false;
    if (draft.models.some((m) => m.id === id)) return;
    draft.models = [...draft.models, fromGuess(g)];
    if (!draft.defaultModel) draft.defaultModel = firstChat();
    expanded = { ...expanded, [id]: true };
    addId = '';
  }
  async function pull() {
    fetching = true; fetchErr = '';
    try {
      const list = await fetchRemoteModels({ id: draft.id || undefined, draft: connDraft() });
      const have = new Set(draft.models.map((m) => m.id));
      candidates = list.filter((m) => !have.has(m.id));
      // 对话模型默认勾上；语音识别 / 合成、向量这类不勾
      picked = Object.fromEntries(candidates.filter((m) => m.kind !== 'other').map((m) => [m.id, true]));
      candQ = '';
      if (!list.length) fetchErr = t('这个端点没有返回任何模型，手动添加吧');
      else if (!candidates.length) { fetchErr = t('端点上的模型都已经添加过了'); candidates = null; }
    } catch (e) { fetchErr = e.message || String(e); }
    fetching = false;
  }
  const candShown = $derived((candidates || []).filter((m) => !candQ || (m.id + ' ' + m.label).toLowerCase().includes(candQ.toLowerCase())));
  const pickedN = $derived(Object.values(picked).filter(Boolean).length);
  function toggleAll() {
    const chat = candShown.filter((m) => m.kind !== 'other');   // 「全选」跳过非对话模型
    const all = chat.every((m) => picked[m.id]);
    for (const m of chat) picked[m.id] = !all;
  }
  function addPicked() {
    // 启用与否照 fromGuess：勾上的语音识别 / 合成、向量模型也是加进来但不启用（同手动添加、同老配置迁移的口径）
    const add = (candidates || []).filter((m) => picked[m.id]).map((m) => fromGuess(m));
    draft.models = [...draft.models, ...add];
    if (!draft.defaultModel || !draft.models.some((m) => m.id === draft.defaultModel && m.kind !== 'other')) draft.defaultModel = firstChat();
    candidates = null;
  }
  function removeModel(id) {
    draft.models = draft.models.filter((m) => m.id !== id);
    if (draft.defaultModel === id) draft.defaultModel = firstChat();
    if (draft.fastModel === id) draft.fastModel = '';
  }
  // 默认模型、小任务模型都只认启用的对话模型（服务端同口径）：模型被关掉或改成非对话时一起让位
  function demote(m) {
    if (draft.defaultModel === m.id) draft.defaultModel = firstChat();
    if (draft.fastModel === m.id) draft.fastModel = '';
  }
  function setKind(m, chat) {
    m.kind = chat ? 'chat' : 'other';
    if (!chat) demote(m);
  }

  // —— 探测能力（真打几次：输出上限 / 视觉 / 默认会不会想 / 每一档端点认不认）——
  let probing = $state({});   // 模型 id → true
  let probes = $state({});    // 模型 id → 结果
  async function runProbe(m) {
    if (probing[m.id]) return;
    probing = { ...probing, [m.id]: true };
    let r;
    try { r = await probeModel({ id: draft.id || undefined, draft: connDraft(), model: wireModel($state.snapshot(m)) }); }
    catch (e) { r = { error: e.message || String(e) }; }
    probes = { ...probes, [m.id]: r };
    probing = { ...probing, [m.id]: false };
  }
  function applyProbe(m) {
    const r = probes[m.id];
    if (!r || r.error) return;
    const src = { ...(m.source || {}) };
    if (r.kind) m.kind = r.kind;
    if (r.maxOutput) { m.maxOutput = r.maxOutput; src.maxOutput = 'probe'; }
    if (typeof r.vision === 'boolean') { m.vision = r.vision; src.vision = 'probe'; }
    if (r.thinksByDefault) m.alwaysThinks = true;
    // OpenAI 端点报出了它认的 reasoning_effort 档位：没配档位、或档位就是写 reasoning_effort 的，按它重排
    if (r.effortIds && r.effortIds.length && (m.thinking === 'none' || (m.thinking === 'effort' && (!m.effortField || m.effortField === 'reasoning_effort') && m.efforts.every((x) => typeof x.value === 'string' || x.value === null)))) {
      const NAME = { none: t('关闭'), off: t('关闭'), minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra', max: 'Max' };
      m.thinking = 'effort'; m.effortField = 'reasoning_effort';
      m.efforts = r.effortIds.slice(0, 8).map((id) => ({ id, name: NAME[id] || id, value: id }));
      if (!m.efforts.some((x) => x.id === m.effortDefault)) m.effortDefault = '';
      src.thinking = 'probe';
    } else if (Array.isArray(r.tiers) && r.tiers.some((x) => !x.ok)) {
      // 端点不认的档拿掉
      const badIds = new Set(r.tiers.filter((x) => !x.ok).map((x) => x.id));
      m.efforts = m.efforts.filter((x) => !badIds.has(x.id));
      if (badIds.has(m.effortDefault)) m.effortDefault = '';
      src.thinking = 'probe';
    }
    m.source = src;
    if (m.kind === 'other') demote(m);
    probes = { ...probes, [m.id]: { ...r, applied: true } };
  }

  // —— 保存 / 删除 ——
  let saving = $state(false);
  let err = $state('');
  let savedFlash = $state(false);
  let confirmDel = $state(false);
  const extraBad = (s) => { const x = String(s || '').trim(); if (!x) return false; try { const o = JSON.parse(x); return !o || typeof o !== 'object' || Array.isArray(o); } catch { return true; } };
  const invalid = $derived(!draft.baseUrl.trim() ? t('先填接口地址')
    : extraBad(draft.params.extraBody) || draft.models.some((m) => extraBad(m.params.extraBody)) ? t('额外请求体不是合法 JSON 对象')
      : draft.models.map((m) => tierProblem(m)).find(Boolean) || '');
  // 发给服务端的模型：有思考方式却一档都没有（删光了、探测把档全拿掉了）= 什么都不发，按「不思考」存——
  // 服务端把「有方式没档位」当老版 apk 的编辑器，会按老规则补档位
  const wireModel = (m) => (m.thinking !== 'none' && !(m.efforts || []).length ? { ...m, thinking: 'none', effortDefault: '' } : m);
  function payload() {
    const { hasKey, keyTail, ...rest } = $state.snapshot(draft);
    rest.models = rest.models.map(wireModel);
    if (keyMode === 'set') rest.apiKey = keyInput.trim();
    else if (keyMode === 'clear') rest.apiKey = '';
    return rest;
  }
  let autoTest = $state(null);   // 保存后自动测一次默认模型的结果（失败在页脚标红）
  async function save() {
    if (saving || invalid) return;
    saving = true; err = ''; autoTest = null;
    try {
      const body = payload();
      const p = isNew ? await createProvider(body) : await updateProvider(draft.id, body);
      draft = fromSource(p);
      baseline = JSON.stringify(draft);
      keyMode = 'keep'; keyInput = ''; showKey = false;
      savedFlash = true; setTimeout(() => (savedFlash = false), 1600);
      onSaved?.(p);
      // 保存后顺手测一次默认模型：配错了当场就知道，不用等到发消息才看见报错
      if (p.enabled !== false && p.defaultModel) testProvider({ id: p.id }).then((r) => { autoTest = r; loadLog(); }).catch(() => {});
    } catch (e) { err = e.message || String(e); }
    saving = false;
  }
  async function remove() {
    if (!confirmDel) { confirmDel = true; return; }
    try { await deleteProvider(draft.id); onDeleted?.(); }
    catch (e) { err = e.message || String(e); confirmDel = false; }
  }

  // —— 测试与日志 ——
  let testModel = $state(untrack(() => draft.defaultModel));
  // 能拿来测的：启用了的对话模型。新建服务时一开始还没有模型（testModel 是 ''），拉取 / 添加后自动设好了 ★ 默认，
  // 下拉框却还是空白（selectedIndex -1）；选中的模型被停用 / 删掉 / 改成非对话也一样——都跟到默认模型（没有就第一个）
  const testable = $derived(draft.models.filter((x) => x.enabled && x.kind !== 'other'));
  $effect(() => {
    const ok = testable.some((m) => m.id === testModel);
    if (!ok) { const d = draft.defaultModel; testModel = testable.some((m) => m.id === d) ? d : (testable[0]?.id || ''); }
  });
  let testing = $state(false);
  let result = $state(null);
  let log = $state([]);
  async function loadLog() { if (draft.id) { try { log = await providerLog(draft.id); } catch {} } }
  $effect(() => { if (section === 'test') untrack(loadLog); });
  async function runTest() {
    if (testing || !draft.models.length || invalid) return;
    testing = true; result = null;
    try {
      const model = testModel || draft.defaultModel;
      // 有改动（含新建没保存的）就拿编辑中的配置测；没改动测已存的（记进「最近请求」）
      result = changed || isNew ? await testProvider({ id: draft.id || undefined, draft: payload(), model }) : await testProvider({ id: draft.id, model });
    } catch (e) { result = { ok: false, error: e.message || String(e) }; }
    testing = false;
    loadLog();
  }
  const hhmmss = (ms) => { const d = new Date(ms); return [d.getHours(), d.getMinutes(), d.getSeconds()].map((x) => String(x).padStart(2, '0')).join(':'); };
  const secs = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms');
  const footMsg = $derived(tr(err) || invalid || (savedFlash ? t('已保存') : autoTest && !autoTest.ok ? t('已保存，但测试默认模型失败：{e}', { e: tr(String(autoTest.error || '')).slice(0, 120) }) : dirty && !isNew ? t('有改动没保存') : ''));
  const footErr = $derived(!!(err || invalid) || !!(autoTest && !autoTest.ok && !savedFlash));
</script>

<div class="ed">
  <nav class="side" aria-label={t('分区')}>
    {#each SECTIONS as s (s.k)}
      <button type="button" class="nav" class:on={section === s.k} onclick={() => go(s.k)}>
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">{@html s.icon}</svg>
        <span>{s.label()}</span>
        {#if s.k === 'models' && draft.models.length}<span class="cnt">{draft.models.length}</span>{/if}
        {#if s.k === 'conn' && mismatchFix}<span class="warn-dot" title={t('地址和协议可能对不上')}></span>{/if}
      </button>
    {/each}
  </nav>

  <div class="body" bind:this={scroller}>
    {#if section === 'conn'}
      <section>
        <h3>{t('连接')}</h3>
        <div class="f2">
          <label class="fld"><span class="fl">{t('名称')}</span><input class="in" maxlength="40" placeholder={t('比如 DeepSeek')} bind:value={draft.name} /></label>
          <label class="fld"><span class="fl">{t('备注')}</span><input class="in" maxlength="80" placeholder={t('可不填')} bind:value={draft.note} /></label>
        </div>
        <div class="fld"><span class="fl">{t('接口协议')}</span>
          <SSegmented options={PROTO_OPTS} value={draft.protocol} onchange={setProtocol} label={t('接口协议')} />
          <span class="fh">{draft.protocol === 'openai' ? t('OpenAI 兼容端点：bridge 把 Claude Code 的请求整体翻译过去（含工具调用与流式）') : t('兼容 Anthropic Messages 的端点：请求原样转发，只改写参数')}</span>
        </div>
        {#if retierNote}
          <div class="note warn">{t('换了协议：{names} 的推理强度档位是按原协议写的（手动设的或探测出来的），不会自动换。建议展开这些模型点「探测能力」，或在档位里用「一键填入」重设。', { names: retierNote })}
            <div class="nbtns"><button type="button" class="btn sm ghost" onclick={() => (retierNote = '')}>{t('知道了')}</button></div></div>
        {/if}
        <label class="fld"><span class="fl">{t('接口地址')}</span>
          <input class="in mono" spellcheck="false" placeholder={draft.protocol === 'openai' ? 'https://api.example.com/v1' : 'https://api.example.com/anthropic'} bind:value={draft.baseUrl} />
          {#if endpoint}<span class="fh">{t('实际请求')} <code>{endpoint}</code></span>{/if}
        </label>
        {#if mismatch && !mismatchFix}
          <!-- 中转的 …/v1 + Anthropic：new-api / one-api 一类在 …/v1/messages 上本来就有 Anthropic 接口——只提示，不断言、不给一键改 -->
          <div class="note">{t('有的服务 …/v1 下只有 OpenAI 兼容接口（按 Anthropic 协议请求会 404）；中转站的 …/v1 多半两种都有。不确定就点「检测连接」。')}</div>
        {:else if mismatch}
          <div class="note warn">
            <div>{mismatch.to === 'anthropic' ? t('以 /anthropic 结尾的多半是 Anthropic 兼容地址，按 OpenAI 协议请求会 404。')
              : mismatch.sure ? t('这个站的 …/v1 只有 OpenAI 兼容接口，按 Anthropic 协议请求会 404（发消息时报「模型有问题」）。')
              : t('检测连接实测这个地址按 Anthropic 协议请求返回 404：改用 OpenAI 协议，或改用同站的 …/anthropic 地址。')}</div>
            <div class="nbtns">
              <button type="button" class="btn sm" onclick={() => setProtocol(mismatch.to)}>{mismatch.to === 'openai' ? t('改用 OpenAI 协议') : t('改用 Anthropic 协议')}</button>
              {#if mismatch.alt !== cleanBase}<button type="button" class="btn sm" onclick={() => (draft.baseUrl = mismatch.alt)}>{t('改成 {url}', { url: mismatch.alt.replace(/^https?:\/\//, '') })}</button>{/if}
            </div>
          </div>
        {/if}
        <div class="detect">
          <button type="button" class="btn sm" disabled={detecting || !cleanBase} onclick={runDetect}>{#if detecting}<span class="spin"></span>{/if}{t('检测连接')}</button>
          <span class="fh">{t('用这把 Key 在这个地址和同站的兄弟地址上，两种协议各真打一次，看哪个组合能通')}</span>
        </div>
        {#if detect}
          {#if detect.error}<div class="note warn">{tr(detect.error)}</div>
          {:else}
            <div class="dres">
              {#if detect.ok}<div class="dline ok">{t('当前配置能通')}{#if detect.model}<span class="muted"> · {detect.model}</span>{/if}</div>
              {:else if detect.suggest}
                <div class="dline">{t('当前配置不通；建议改成')} <b>{detect.suggest.protocol === 'openai' ? 'OpenAI' : 'Anthropic'}</b> · <code>{detect.suggest.baseUrl}</code>
                  <button type="button" class="btn sm primary" onclick={() => applySuggest(detect.suggest)}>{t('一键应用')}</button></div>
              {:else}<div class="dline bad">{t('没有找到能通的组合：检查地址、Key 和网络')}</div>{/if}
              <details><summary>{t('每个组合的结果')}</summary>
                {#each detect.results as r, i (i)}
                  <div class="drow"><span class="st" class:ok={r.result === 'ok'} class:bad={r.result === 'missing' || r.result === 'network'}>{RESULT_TEXT[r.result]?.() || r.result}</span>
                    <span class="mono">{r.protocol === 'openai' ? 'OpenAI' : 'Anthropic'} · {r.url}</span>
                    <!-- 只给能用的组合（同服务端 usable 口径：通了 / 接口在只是模型名或 Key 的问题），当前这组不用给 -->
                    {#if (r.result === 'ok' || r.result === 'model' || r.result === 'auth') && !(r.protocol === draft.protocol && r.baseUrl === cleanBase)}<button type="button" class="btn sm ghost" onclick={() => applySuggest(r)}>{t('用这个')}</button>{/if}
                    {#if r.message && r.result !== 'ok'}<span class="lerr" title={r.message}>{r.message}</span>{/if}</div>
                {/each}
              </details>
            </div>
          {/if}
        {/if}
        <div class="fld"><span class="fl">API Key</span>
          {#if keyMode !== 'set' && draft.hasKey && keyMode !== 'clear'}
            <div class="keyrow"><span class="keybox mono">••••••••{draft.keyTail}</span>
              <button type="button" class="btn sm" onclick={() => { keyMode = 'set'; keyInput = ''; }}>{t('更换')}</button>
              <button type="button" class="btn sm ghost" onclick={() => (keyMode = 'clear')}>{t('清除')}</button></div>
          {:else if keyMode === 'clear'}
            <div class="keyrow"><span class="keybox muted">{t('保存后清除 Key')}</span><button type="button" class="btn sm ghost" onclick={() => (keyMode = 'keep')}>{t('撤销')}</button></div>
          {:else}
            <div class="keyrow"><div class="in pw"><input class="mono" type={showKey ? 'text' : 'password'} autocomplete="off" spellcheck="false" placeholder={draft.authStyle === 'none' ? t('这个服务不需要 Key') : 'sk-…'}
              value={keyInput} oninput={(e) => { keyInput = e.currentTarget.value; keyMode = 'set'; }} />
              <button type="button" class="eye" aria-label={showKey ? t('隐藏') : t('显示')} onclick={() => (showKey = !showKey)}>
                <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">{#if showKey}<path d="M3 3l14 14M8.5 8.6a2 2 0 0 0 2.9 2.8M6.2 6.3C4.6 7.3 3.4 8.6 2.8 10c1.3 3 4 5 7.2 5 1.4 0 2.7-.4 3.8-1.1M9 5.1c.3 0 .7-.1 1-.1 3.2 0 5.9 2 7.2 5-.4.9-.9 1.7-1.6 2.4"/>{:else}<path d="M2.8 10C4.1 7 6.8 5 10 5s5.9 2 7.2 5c-1.3 3-4 5-7.2 5s-5.9-2-7.2-5z"/><circle cx="10" cy="10" r="2.2"/>{/if}</svg>
              </button></div>
              {#if draft.hasKey}<button type="button" class="btn sm ghost" onclick={() => { keyMode = 'keep'; keyInput = ''; }}>{t('撤销')}</button>{/if}
            </div>
            <span class="fh">{t('加密存在这台电脑上（DPAPI），只在转发请求时使用，不会发给手机或网页')}</span>
          {/if}
        </div>
        <div class="fld"><span class="fl">{t('鉴权方式')}</span><SSegmented options={AUTH_OPTS.map((o) => ({ ...o, label: typeof o.label === 'function' ? o.label() : o.label }))} value={draft.authStyle} onchange={(v) => (draft.authStyle = v)} label={t('鉴权方式')} /></div>
        <div class="list">
          <div class="li"><div><div class="lt">{t('显示在模型列表')}</div><div class="ls">{t('关掉后这个服务的模型不出现在输入框的模型菜单里；正在用它的会话照常能跑（要硬停用请关「启用」）')}</div></div>
            <SToggle checked={draft.showInPicker} onchange={(v) => (draft.showInPicker = v)} label={t('显示在模型列表')} /></div>
        </div>

        <h4>{t('请求头')}</h4>
        <div class="hdrs">
          {#each draft.headers as h, i (i)}
            <div class="hdr"><input class="in mono" placeholder="X-Custom-Header" bind:value={h.name} /><input class="in mono" placeholder={t('值')} bind:value={h.value} />
              <button type="button" class="iconbtn" aria-label={t('删除')} onclick={() => (draft.headers = draft.headers.filter((_, j) => j !== i))}><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>
          {/each}
          {#if draft.headers.length < 16}<button type="button" class="btn sm ghost add" onclick={() => (draft.headers = [...draft.headers, { name: '', value: '' }])}>＋ {t('添加请求头')}</button>{/if}
        </div>

        <h4>{t('网络')}</h4>
        <div class="list">
          <div class="li"><div><div class="lt">{t('超时')}</div><div class="ls">{t('等响应头的最长时间；流式回答开始后不再计时')}</div></div>
            <div class="numf"><input type="number" min="10" max="1800" bind:value={draft.timeoutSec} /><span class="unit">{t('秒')}</span></div></div>
          <div class="li"><div><div class="lt">{t('失败重试')}</div><div class="ls">{t('429 / 5xx / 网络错时重试，开始输出后不再重试')}</div></div>
            <div class="stepper"><button type="button" disabled={draft.retries <= 0} onclick={() => (draft.retries = Math.max(0, draft.retries - 1))}>−</button><span>{draft.retries}</span><button type="button" disabled={draft.retries >= 5} onclick={() => (draft.retries = Math.min(5, draft.retries + 1))}>＋</button></div></div>
        </div>
      </section>

    {:else if section === 'models'}
      <section>
        <div class="h3row"><h3>{t('模型')}</h3>
          <button type="button" class="btn sm" disabled={fetching || !draft.baseUrl.trim()} onclick={pull}>
            {#if fetching}<span class="spin"></span>{/if}{t('从服务拉取')}</button></div>
        <p class="lead">{t('★ 测试连接默认用它，也排在本服务分组的第一位；⚡ 是标题生成、摘要这类后台小任务用的（没设就用会话模型）。能力前面带「≈」的是猜的，展开模型可以「探测能力」真打一次核实。')}</p>
        {#if fetchErr}<div class="note warn">{tr(fetchErr)}</div>{/if}

        {#if candidates}
          <div class="cands">
            <div class="cands-top"><input class="in" placeholder={t('搜索模型')} bind:value={candQ} />
              <button type="button" class="btn sm ghost" onclick={toggleAll}>{t('全选')}</button></div>
            <div class="cands-list">
              {#each candShown as m (m.id)}
                <label class="cand" class:other={m.kind === 'other'}><input type="checkbox" bind:checked={picked[m.id]} /><span class="mono">{m.id}</span>{#if m.label && m.label !== m.id}<span class="muted">{m.label}</span>{/if}
                  <span class="cb">
                    {#if m.kind === 'other'}<span class="badge warn" title={t('语音识别 / 合成、向量这类不能对话的模型：默认不勾，加进来也不进模型菜单')}>{t('非对话')}</span>{/if}
                    {#if m.contextWindow}<span class="badge" title={srcTitle(m, 'contextWindow')}>{approx(m, 'contextWindow') ? '≈' : ''}{kfmt(m.contextWindow)}</span>{/if}
                    {#if m.kind !== 'other' && m.efforts && m.efforts.length}<span class="badge acc">{t('思考')}</span>{/if}
                    {#if m.vision}<span class="badge">{t('视觉')}</span>{/if}
                  </span></label>
              {/each}
            </div>
            <div class="cands-foot"><button type="button" class="btn sm ghost" onclick={() => (candidates = null)}>{t('取消')}</button>
              <button type="button" class="btn sm primary" disabled={!pickedN} onclick={addPicked}>{t('添加 {n} 个', { n: pickedN })}</button></div>
          </div>
        {/if}

        <div class="models">
          {#each draft.models as m, mi (m.id)}
            {@const pr = probes[m.id]}
            <div class="mrow" class:off={!m.enabled} class:open={expanded[m.id]}>
              <div class="mhead">
                <SToggle checked={m.enabled} onchange={(v) => { m.enabled = v; if (!v) demote(m); }} label={t('启用')} />
                <button type="button" class="mname" onclick={() => (expanded = { ...expanded, [m.id]: !expanded[m.id] })}>
                  <span class="ml">{m.label || m.id}</span>{#if m.label && m.label !== m.id}<span class="mid mono">{m.id}</span>{/if}
                </button>
                <span class="badges">
                  {#if m.kind === 'other'}<span class="badge warn" title={t('不进模型菜单')}>{t('非对话')}</span>{/if}
                  <span class="badge" title={t('上下文窗口') + (srcTitle(m, 'contextWindow') ? ' · ' + srcTitle(m, 'contextWindow') : '')}>{approx(m, 'contextWindow') ? '≈' : ''}{kfmt(m.contextWindow)}</span>
                  {#if m.kind === 'other'}{:else if m.efforts.length}<span class="badge acc" title={m.efforts.map((x) => x.name).join(' / ')}>{t('思考')}</span>{:else if m.alwaysThinks}<span class="badge acc" title={t('不发参数也会思考')}>{t('自带思考')}</span>{/if}
                  {#if m.vision}<span class="badge" title={srcTitle(m, 'vision')}>{approx(m, 'vision') ? '≈' : ''}{t('视觉')}</span>{/if}
                </span>
                <button type="button" class="pin" class:on={draft.defaultModel === m.id} disabled={m.kind === 'other' || !m.enabled} title={t('设为默认模型')} aria-label={t('设为默认模型')} onclick={() => (draft.defaultModel = m.id)}>
                  <svg viewBox="0 0 20 20" fill={draft.defaultModel === m.id ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="m10 2.8 2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z"/></svg></button>
                <button type="button" class="pin" class:on={draft.fastModel === m.id} disabled={m.kind === 'other' || !m.enabled} title={t('设为小任务模型')} aria-label={t('设为小任务模型')} onclick={() => (draft.fastModel = draft.fastModel === m.id ? '' : m.id)}>
                  <svg viewBox="0 0 20 20" fill={draft.fastModel === m.id ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="M11 2.5 4.5 11h5l-1 6.5L15.5 9h-5z"/></svg></button>
                <button type="button" class="chev" aria-label={t('展开')} onclick={() => (expanded = { ...expanded, [m.id]: !expanded[m.id] })}><svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m7 8 3 3 3-3"/></svg></button>
              </div>
              {#if expanded[m.id]}
                <div class="mbody">
                  <div class="f3">
                    <label class="fld"><span class="fl">{t('显示名')}</span><input class="in" maxlength="80" bind:value={m.label} /></label>
                    <label class="fld"><span class="fl">{t('上下文窗口')}{#if approx(m, 'contextWindow')}<span class="src" title={srcTitle(m, 'contextWindow')}>≈</span>{/if}</span><div class="numf"><input type="number" min="4096" step="1024" bind:value={m.contextWindow} oninput={() => markUser(m, 'contextWindow')} /><span class="unit">tokens</span></div></label>
                    <label class="fld"><span class="fl">{t('输出上限')}{#if approx(m, 'maxOutput')}<span class="src" title={srcTitle(m, 'maxOutput')}>≈</span>{/if}</span><div class="numf"><input type="number" min="256" step="256" bind:value={m.maxOutput} oninput={() => markUser(m, 'maxOutput')} /><span class="unit">tokens</span></div></label>
                  </div>
                  <div class="f2 mid2">
                    <div class="fld"><span class="fl">{t('支持图片')}{#if approx(m, 'vision')}<span class="src" title={srcTitle(m, 'vision')}>≈</span>{/if}</span><div class="inl"><SToggle checked={m.vision} onchange={(v) => { m.vision = v; markUser(m, 'vision'); }} label={t('支持图片')} /><span class="fh">{m.vision ? t('图片原样发送') : t('图片换成一句说明再发')}</span></div></div>
                    <div class="fld"><span class="fl">{t('对话模型')}</span><div class="inl"><SToggle checked={m.kind !== 'other'} onchange={(v) => setKind(m, v)} label={t('对话模型')} /><span class="fh">{m.kind === 'other' ? t('语音识别 / 合成、向量这类：不进模型菜单') : t('出现在模型菜单里')}</span></div></div>
                  </div>
                  <ThinkingTiers bind:model={draft.models[mi]} protocol={draft.protocol} />
                  <div class="probe">
                    <button type="button" class="btn sm" disabled={!!probing[m.id] || !cleanBase} onclick={() => runProbe(m)}>{#if probing[m.id]}<span class="spin"></span>{/if}{t('探测能力')}</button>
                    <span class="fh">{t('真打几次（各一两句话）：读输出上限、看图、默认会不会思考、每一档端点认不认')}</span>
                  </div>
                  {#if pr}
                    <div class="pres" class:bad={!!pr.error}>
                      {#if pr.error}<div class="lerr2">{tr(pr.error)}</div>
                      {:else}
                        <ul>
                          {#each pr.notes || [] as n, i (i)}<li>{tr(n)}</li>{/each}
                          {#each pr.tiers || [] as x (x.id)}<li class:no={!x.ok}>{t('档位')} {x.id}：{x.ok ? (x.thinking === true ? t('认，思考了') : x.thinking === false ? t('认，没思考') : t('认')) : t('不认（{e}）', { e: x.error || x.status })}</li>{/each}
                        </ul>
                        <button type="button" class="btn sm primary" disabled={pr.applied} onclick={() => applyProbe(m)}>{pr.applied ? t('已应用') : t('应用到这个模型')}</button>
                      {/if}
                    </div>
                  {/if}
                  <details class="over">
                    <summary>{t('这个模型的参数覆盖')}</summary>
                    <ParamsEditor bind:params={m.params} inherit protocol={draft.protocol} thinkingKind={m.thinking} />
                  </details>
                  <div class="mfoot"><button type="button" class="btn sm danger ghost" onclick={() => removeModel(m.id)}>{t('移除这个模型')}</button></div>
                </div>
              {/if}
            </div>
          {:else}
            <div class="empty-m">{t('还没有模型。先填好连接再「从服务拉取」，或在下面手动添加模型 ID。')}</div>
          {/each}
        </div>
        <div class="addrow"><input class="in mono" placeholder={t('模型 ID，比如 deepseek-chat')} bind:value={addId} onkeydown={(e) => e.key === 'Enter' && addManual()} />
          <button type="button" class="btn sm" disabled={!addId.trim() || adding} onclick={addManual}>{#if adding}<span class="spin"></span>{/if}{t('手动添加')}</button></div>
      </section>

    {:else if section === 'params'}
      <section>
        <h3>{t('调用参数')}</h3>
        <p class="lead">{t('这个服务所有模型的默认值；单个模型可以在「模型」里覆盖。留空的不改写，用 Claude Code 自己的请求。')}</p>
        <ParamsEditor bind:params={draft.params} protocol={draft.protocol} thinkingKind={draft.models.some((m) => m.thinking === 'budget') ? 'budget' : draft.models.some((m) => m.thinking !== 'none') ? 'other' : 'budget'} />
      </section>

    {:else if section === 'compat'}
      <section>
        <h3>{t('兼容')}</h3>
        <p class="lead">{t('第三方端点常常不认 Claude Code 的一些官方专属字段，出错时先调这里。')}</p>
        <div class="list">
          <div class="li"><div><div class="lt">{t('提示缓存')}<code>cache_control</code></div><div class="ls">{t('服务支持 Anthropic 式提示缓存才开；不支持的会报错或忽略')}</div></div><SToggle checked={draft.compat.promptCaching} onchange={(v) => (draft.compat.promptCaching = v)} label={t('提示缓存')} /></div>
          <div class="li"><div><div class="lt">{t('去掉 beta 请求头')}<code>anthropic-beta</code></div><div class="ls">{officialApi ? t('官方 API 不去掉：Claude Code 依赖这些特性，去掉会报 400') : t('多数第三方不认这些实验特性')}</div></div><SToggle checked={draft.compat.stripBetas && !officialApi} disabled={officialApi} onchange={(v) => (draft.compat.stripBetas = v)} label={t('去掉 beta 请求头')} /></div>
          <div class="li"><div><div class="lt">{t('精简请求')}</div><div class="ls">{t('去掉 context_management、output_config 等官方专属字段和服务端工具')}</div></div><SToggle checked={draft.compat.slimBody} onchange={(v) => (draft.compat.slimBody = v)} label={t('精简请求')} /></div>
          <div class="li"><div><div class="lt">{t('去掉历史思考块')}</div><div class="ls">{t('别家模型的思考内容或签名对不上时打开')}</div></div><SToggle checked={draft.compat.stripThinkingHistory} onchange={(v) => (draft.compat.stripThinkingHistory = v)} label={t('去掉历史思考块')} /></div>
          {#if draft.protocol === 'openai'}
            <div class="li"><div><div class="lt">{t('回传思考内容')}<code>reasoning_content</code></div><div class="ls">{t('Kimi、DeepSeek 一类要求把上一轮思考带回去的打开（标了「不发参数也会思考」的模型自动回传）')}</div></div><SToggle checked={draft.compat.replayReasoning} onchange={(v) => (draft.compat.replayReasoning = v)} label={t('回传思考内容')} /></div>
            <div class="li"><div><div class="lt">{t('输出上限字段')}</div><div class="ls">{t('OpenAI 的推理模型要用 max_completion_tokens')}</div></div>
              <SSegmented options={[{ value: 'max_tokens', label: 'max_tokens' }, { value: 'max_completion_tokens', label: 'max_completion_tokens' }]} value={draft.compat.maxTokensField} onchange={(v) => (draft.compat.maxTokensField = v)} label={t('输出上限字段')} /></div>
          {/if}
        </div>
      </section>

    {:else}
      <section>
        <h3>{t('测试与日志')}</h3>
        <div class="testbar">
          <select class="in sel" bind:value={testModel}>
            {#each testable as m (m.id)}<option value={m.id}>{m.label || m.id}</option>{/each}
          </select>
          <button type="button" class="btn primary" disabled={testing || !draft.models.length || !!invalid} onclick={runTest}>{#if testing}<span class="spin light"></span>{/if}{t('发送测试')}</button>
        </div>
        {#if dirty}<div class="fh">{t('用编辑中的配置测试（还没保存）。')}</div>{/if}
        {#if result}
          <div class="result" class:ok={result.ok} class:bad={!result.ok}>
            <div class="rhead"><span class="dot"></span><b>{result.ok ? t('连通') : t('失败')}</b>
              {#if result.ms}<span class="muted">{secs(result.ms)}</span>{/if}
              {#if result.status}<span class="badge">HTTP {result.status}</span>{/if}
              {#if result.thinking}<span class="badge acc">{t('含思考')}</span>{/if}
              {#if result.usage}<span class="muted">{t('输入 {i} · 输出 {o}', { i: result.usage.input_tokens ?? 0, o: result.usage.output_tokens ?? 0 })}</span>{/if}</div>
            {#if result.ok}<div class="reply">{result.reply || t('（回复为空）')}</div>{:else}<pre class="errbody">{tr(result.error)}</pre>{/if}
          </div>
        {/if}
        {#if draft.id}
          <div class="h3row logh"><h4>{t('最近请求')}</h4><button type="button" class="btn sm ghost" onclick={loadLog}>{t('刷新')}</button></div>
          {#if log.length}
            <div class="log">
              {#each log as l, i (i)}
                <div class="lrow" title={l.error || ''}>
                  <span class="lt2 mono">{hhmmss(l.at)}</span>
                  <span class="st" class:ok={l.status >= 200 && l.status < 300} class:bad={l.status >= 400}>{l.status}</span>
                  <span class="lm mono">{l.model}{#if l.effort}<span class="muted"> · {l.effort}</span>{/if}{#if l.test}<span class="muted"> · {t('测试')}</span>{/if}</span>
                  <span class="lnum">{secs(l.ms)}{#if l.firstMs}<span class="muted"> / {secs(l.firstMs)}</span>{/if}</span>
                  <span class="lnum">{#if l.inTok || l.outTok}{l.inTok || 0} → {l.outTok || 0}{/if}</span>
                  {#if l.error}<span class="lerr">{l.error}</span>{/if}
                </div>
              {/each}
            </div>
          {:else}<div class="fh">{t('还没有请求记录（服务重启后清空）。')}</div>{/if}
        {/if}
      </section>
    {/if}
  </div>

  <footer class="foot">
    {#if !isNew}
      <button type="button" class="btn danger ghost" onclick={remove} onblur={() => (confirmDel = false)}>{confirmDel ? t('再点一次删除') : t('删除服务')}</button>
    {/if}
    <span class="msg" class:err={footErr} title={footMsg}>{footMsg}</span>
    <button type="button" class="btn ghost" onclick={() => onClose?.()}>{dirty && !isNew ? t('放弃') : t('关闭')}</button>
    <button type="button" class="btn primary" disabled={!dirty || saving || !!invalid} onclick={save}>{#if saving}<span class="spin light"></span>{/if}{isNew ? t('添加') : t('保存')}</button>
  </footer>
</div>

<style>
  .ed { display: grid; grid-template-columns: 188px minmax(0, 1fr); grid-template-rows: minmax(0, 1fr) auto; height: 100%; min-height: 0; }
  .side { grid-row: 1; padding: 14px 10px; border-right: 1px solid var(--st-hair); display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
  .nav { display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent; color: var(--st-text2); font: inherit; font-size: 13.5px; text-align: left; cursor: pointer; }
  .nav svg { width: 17px; height: 17px; flex: none; opacity: .85; }
  .nav:hover { background: var(--st-hover); color: var(--text); }
  .nav.on { background: var(--st-sel); color: var(--text); font-weight: 500; }
  .nav .cnt { margin-left: auto; font-size: 11.5px; color: var(--st-muted); font-variant-numeric: tabular-nums; }
  .warn-dot { margin-left: auto; width: 7px; height: 7px; border-radius: 50%; background: #e0a43b; flex: none; }
  .body { grid-row: 1; overflow-y: auto; padding: 22px 28px 28px; min-width: 0; }
  section { max-width: 680px; }
  h3 { margin: 0 0 14px; font-family: var(--font-brand-serif), Georgia, serif; font-weight: 500; font-size: 21px; letter-spacing: -.01em; color: var(--text); }
  h4 { margin: 22px 0 8px; font-size: 12.5px; font-weight: 600; letter-spacing: .02em; color: var(--st-muted); text-transform: none; }
  .h3row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .h3row h3, .h3row h4 { margin-bottom: 8px; }
  .h3row.logh { margin-top: 18px; }
  .h3row.logh h4 { margin: 0; }
  .lead { margin: -4px 0 14px; font-size: 13px; line-height: 1.55; color: var(--st-muted); }
  .f2 { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
  .f3 { display: grid; grid-template-columns: 1.4fr 1fr 1fr; gap: 12px; }
  .fld { display: flex; flex-direction: column; gap: 6px; margin-bottom: 14px; min-width: 0; }
  .fl { font-size: 12.5px; font-weight: 500; color: var(--st-text2); }
  .src { margin-left: 5px; color: #b7791f; font-weight: 600; cursor: help; }
  .fld > :global(.seg) { align-self: flex-start; max-width: 100%; }   /* 分段控件按内容宽，别被 flex 列拉满 */
  .fh { font-size: 12px; line-height: 1.5; color: var(--st-muted); }
  .fh code, .lt code, .dline code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 11.5px; background: var(--st-seg); padding: 1px 6px; border-radius: 5px; color: var(--st-text2); word-break: break-all; }
  .lt code { margin-left: 8px; color: var(--st-muted); }
  .in { height: 34px; box-sizing: border-box; width: 100%; padding: 0 10px; border: 1px solid var(--st-line); border-radius: 9px; background: var(--st-field); color: var(--text); font: inherit; font-size: 13.5px; outline: 0; transition: border-color .15s, box-shadow .15s; }
  .in:focus, .in:focus-within { border-color: color-mix(in srgb, var(--st-accent) 70%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--st-accent) 18%, transparent); }
  .in::placeholder, .in input::placeholder { color: var(--st-muted); }
  .mono { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12.5px; }
  .muted { color: var(--st-muted); }
  .keyrow { display: flex; align-items: center; gap: 8px; }
  .keybox { flex: 1; height: 34px; display: flex; align-items: center; padding: 0 12px; border-radius: 9px; background: var(--st-seg); color: var(--st-text2); letter-spacing: .04em; }
  .pw { display: flex; align-items: center; padding: 0 0 0 10px; }
  .pw input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: var(--text); }
  .eye { width: 32px; height: 32px; display: grid; place-items: center; border: 0; background: transparent; color: var(--st-muted); cursor: pointer; }
  .eye svg { width: 17px; height: 17px; }
  .hdrs { display: flex; flex-direction: column; gap: 8px; }
  .hdr { display: grid; grid-template-columns: 1fr 1.4fr 30px; gap: 8px; align-items: center; }
  .iconbtn { width: 30px; height: 30px; display: grid; place-items: center; border: 0; border-radius: 8px; background: transparent; color: var(--st-muted); cursor: pointer; }
  .iconbtn:hover { background: var(--st-hover); color: var(--text); }
  .iconbtn svg { width: 13px; height: 13px; }
  .add { align-self: flex-start; }
  .list { border: 1px solid var(--st-line); border-radius: 12px; overflow: hidden; }
  .li { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 12px 14px; border-top: 1px solid var(--st-hair); }
  .li:first-child { border-top: 0; }
  .lt { font-size: 13.5px; color: var(--text); display: flex; align-items: center; }
  .ls { margin-top: 2px; font-size: 12px; line-height: 1.45; color: var(--st-muted); }
  .numf { display: flex; align-items: center; height: 34px; width: 150px; flex: none; border: 1px solid var(--st-line); border-radius: 9px; background: var(--st-field); overflow: hidden; }
  .fld .numf { width: 100%; }
  .numf:focus-within { border-color: color-mix(in srgb, var(--st-accent) 70%, transparent); box-shadow: 0 0 0 3px color-mix(in srgb, var(--st-accent) 18%, transparent); }
  .numf input { flex: 1; min-width: 0; height: 100%; border: 0; outline: 0; background: transparent; color: var(--text); font: inherit; font-size: 13.5px; padding: 0 10px; font-variant-numeric: tabular-nums; }
  .unit { padding: 0 10px 0 4px; font-size: 12px; color: var(--st-muted); }
  .stepper { display: flex; align-items: center; height: 32px; border: 1px solid var(--st-line); border-radius: 9px; overflow: hidden; flex: none; }
  .stepper button { width: 32px; height: 100%; border: 0; background: transparent; color: var(--text); font-size: 15px; cursor: pointer; }
  .stepper button:hover:not(:disabled) { background: var(--st-hover); }
  .stepper button:disabled { color: var(--st-muted); cursor: default; }
  .stepper span { min-width: 26px; text-align: center; font-variant-numeric: tabular-nums; font-size: 13.5px; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 34px; padding: 0 14px; border: 1px solid var(--st-line); border-radius: 9px; background: var(--st-surface); color: var(--text); font: inherit; font-size: 13.5px; cursor: pointer; white-space: nowrap; transition: background-color .12s, opacity .12s; }
  .btn:hover:not(:disabled) { background: var(--st-hover); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn.sm { height: 30px; padding: 0 11px; font-size: 13px; }
  .btn.ghost { border-color: transparent; background: transparent; }
  .btn.primary { background: var(--st-primary); color: var(--st-primary-ink); border-color: transparent; }
  .btn.primary:hover:not(:disabled) { background: var(--st-primary); opacity: .88; }
  .btn.danger { color: #d9534f; }
  .spin { width: 13px; height: 13px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent; animation: spin .7s linear infinite; opacity: .7; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .note { padding: 10px 12px; border-radius: 10px; background: var(--st-seg); font-size: 13px; color: var(--st-text2); margin-bottom: 12px; line-height: 1.5; }
  .note.warn { background: color-mix(in srgb, #e0a43b 14%, transparent); color: var(--text); }
  .nbtns { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .detect { display: flex; align-items: center; gap: 10px; margin: -2px 0 12px; }
  .dres { border: 1px solid var(--st-line); border-radius: 10px; padding: 10px 12px; margin-bottom: 14px; font-size: 13px; }
  .dline { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
  .dline.ok { color: #3fa46a; }
  .dline.bad { color: #d9534f; }
  .dres details { margin-top: 8px; }
  .dres summary { cursor: pointer; font-size: 12.5px; color: var(--st-text2); }
  .drow { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 5px 0; border-top: 1px solid var(--st-hair); font-size: 12px; }
  .drow:first-of-type { border-top: 0; }
  .drow .mono { font-size: 11.5px; word-break: break-all; }
  .drow .lerr { flex-basis: 100%; }
  .cands { border: 1px solid var(--st-line); border-radius: 12px; margin-bottom: 14px; overflow: hidden; background: var(--st-surface); box-shadow: var(--st-menu-shadow); }
  .cands-top { display: flex; gap: 8px; padding: 10px; border-bottom: 1px solid var(--st-hair); }
  .cands-list { max-height: 280px; overflow-y: auto; padding: 4px 0; }
  .cand { display: flex; align-items: center; gap: 10px; padding: 7px 14px; cursor: pointer; font-size: 13px; }
  .cand:hover { background: var(--st-hover); }
  .cand.other .mono { color: var(--st-muted); }
  .cand input { accent-color: var(--st-accent); }
  .cand .muted { font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cb { margin-left: auto; display: flex; gap: 4px; flex: none; }
  .cands-foot { display: flex; justify-content: flex-end; gap: 8px; padding: 10px; border-top: 1px solid var(--st-hair); }
  .models { display: flex; flex-direction: column; border: 1px solid var(--st-line); border-radius: 12px; overflow: hidden; }
  .mrow { border-top: 1px solid var(--st-hair); }
  .mrow:first-child { border-top: 0; }
  .mrow.open { background: color-mix(in srgb, var(--st-seg) 45%, transparent); }
  .mhead { display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 14px; min-height: 44px; }
  .mrow.off .mname, .mrow.off .badges { opacity: .45; }
  .mname { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; border: 0; background: transparent; color: var(--text); font: inherit; text-align: left; cursor: pointer; padding: 0; }
  .ml { font-size: 13.5px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .mid { color: var(--st-muted); font-size: 11.5px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .badges { display: flex; gap: 4px; flex: none; }
  .badge { display: inline-flex; align-items: center; height: 20px; padding: 0 7px; border-radius: 6px; background: var(--st-seg); color: var(--st-text2); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .badge.acc { background: color-mix(in srgb, var(--st-accent) 16%, transparent); color: var(--st-accent); }
  .badge.warn { background: color-mix(in srgb, #e0a43b 18%, transparent); color: #b7791f; }
  .pin, .chev { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border: 0; border-radius: 7px; background: transparent; color: var(--st-muted); cursor: pointer; }
  .pin:disabled { opacity: .3; cursor: default; }
  .pin svg, .chev svg { width: 16px; height: 16px; }
  .pin:hover:not(:disabled), .chev:hover { background: var(--st-hover); color: var(--text); }
  .pin.on { color: #d9a23a; }
  .mrow.open .chev svg { transform: rotate(180deg); }
  .mbody { padding: 4px 14px 14px; }
  .mid2 { align-items: start; }
  .inl { display: flex; align-items: center; gap: 10px; height: 32px; }
  .probe { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
  .pres { margin-top: 8px; padding: 8px 12px; border: 1px solid var(--st-line); border-radius: 10px; font-size: 12.5px; }
  .pres.bad { border-color: color-mix(in srgb, #d9534f 45%, transparent); }
  .pres ul { margin: 0 0 8px; padding-left: 18px; line-height: 1.6; color: var(--st-text2); }
  .pres li.no { color: #d9534f; }
  .lerr2 { color: #d9534f; white-space: pre-wrap; word-break: break-word; }
  .over { margin-top: 10px; border-top: 1px solid var(--st-hair); padding-top: 10px; }
  .over summary { cursor: pointer; font-size: 13px; color: var(--st-text2); padding: 4px 0 8px; }
  .mfoot { display: flex; justify-content: flex-end; margin-top: 6px; }
  .empty-m { padding: 26px 18px; text-align: center; font-size: 13px; color: var(--st-muted); line-height: 1.6; }
  .addrow { display: flex; gap: 8px; margin-top: 12px; }
  .testbar { display: flex; gap: 8px; align-items: center; margin-bottom: 6px; }
  .sel { width: auto; min-width: 220px; appearance: auto; }
  .result { margin: 14px 0 6px; border: 1px solid var(--st-line); border-radius: 12px; padding: 12px 14px; }
  .result.ok { border-color: color-mix(in srgb, #3fa46a 45%, transparent); background: color-mix(in srgb, #3fa46a 7%, transparent); }
  .result.bad { border-color: color-mix(in srgb, #d9534f 45%, transparent); background: color-mix(in srgb, #d9534f 7%, transparent); }
  .rhead { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 13px; }
  .rhead .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fa46a; }
  .result.bad .dot { background: #d9534f; }
  .reply { margin-top: 8px; font-size: 14px; color: var(--text); }
  .errbody { margin: 8px 0 0; white-space: pre-wrap; word-break: break-word; font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size: 12px; color: var(--st-text2); max-height: 180px; overflow: auto; }
  .log { border: 1px solid var(--st-line); border-radius: 12px; overflow: hidden; font-size: 12.5px; }
  .lrow { display: grid; grid-template-columns: 64px 44px minmax(0, 1fr) 96px 92px; gap: 8px; align-items: center; padding: 7px 12px; border-top: 1px solid var(--st-hair); }
  .lrow:first-child { border-top: 0; }
  .lt2 { color: var(--st-muted); font-size: 11.5px; }
  .st { justify-self: start; padding: 1px 7px; border-radius: 6px; font-size: 11px; font-variant-numeric: tabular-nums; background: var(--st-seg); white-space: nowrap; }
  .st.ok { color: #3fa46a; background: color-mix(in srgb, #3fa46a 12%, transparent); }
  .st.bad { color: #d9534f; background: color-mix(in srgb, #d9534f 12%, transparent); }
  .lm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
  .lnum { text-align: right; font-variant-numeric: tabular-nums; color: var(--st-text2); white-space: nowrap; }
  .lerr { grid-column: 3 / -1; color: #d9534f; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .foot { grid-column: 1 / -1; grid-row: 2; display: flex; align-items: center; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--st-line); background: var(--st-surface); }
  .foot .msg { flex: 1; text-align: right; font-size: 12.5px; color: var(--st-muted); min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .foot .msg.err { color: #d9534f; }
  .spin.light { border-color: currentColor; border-right-color: transparent; }

  @media (max-width: 699px) {
    .ed { grid-template-columns: 1fr; grid-template-rows: auto minmax(0, 1fr) auto; }
    .side { grid-row: 1; flex-direction: row; overflow-x: auto; overflow-y: hidden; padding: 6px 12px; border-right: 0; border-bottom: 1px solid var(--st-hair); scrollbar-width: none; }
    .side::-webkit-scrollbar { display: none; }
    .nav { flex: none; height: 32px; padding: 0 12px; }
    .nav svg { display: none; }
    .body { grid-row: 2; padding: 16px 16px 24px; }
    .foot { grid-row: 3; padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); flex-wrap: wrap; }
    .foot .msg { order: -1; flex-basis: 100%; text-align: left; }
    .foot .msg:empty { display: none; }
    .foot > .btn.danger { margin-right: auto; }   /* 删除靠左，关闭 / 保存靠右（拇指够得着） */
    .foot > .btn.ghost:not(.danger):first-child { margin-left: auto; }
    .f2, .f3 { grid-template-columns: 1fr; gap: 0; }
    .hdr { grid-template-columns: 1fr 30px; }
    .hdr input:nth-child(2) { grid-column: 1; }
    .hdr .iconbtn { grid-row: 1 / span 2; grid-column: 2; }
    .badges { display: none; }
    .cb .badge:not(.warn) { display: none; }
    .lrow { grid-template-columns: 58px 40px minmax(0, 1fr) 70px; }
    .lrow .lnum:last-of-type { display: none; }
    .li { align-items: flex-start; }
    .sel { min-width: 0; flex: 1; }
    .detect { flex-wrap: wrap; }
  }
</style>
