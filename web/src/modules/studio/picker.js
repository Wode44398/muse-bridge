// 模型选择器的纯逻辑（方案 §9.2「模型选择器」+ §9.3 目录增量）：分组、聚合服务按厂商分小组、搜索（含备选 shelf）、
// 新模型朱点、参数来源行。纯函数，有单测（studio.test.js）。
//
//   目录增量（§9.3）：ResolvedModel 加 paramSource:'card'|'schema'|'family'|'generic'、inheritsFrom?、refinedBy?、vendor?、
//   isNew?、shelf?、etaSec?、priceHint?；shelf 模型只给轻条目 { key, id, label, vendor, kind, shelf:true }，完整的按需
//   GET /api/studio/models/resolve?key= 取。shelf 条目放在组的 models 里（带 shelf:true），也认组上单独的 shelf 数组。

/** 聚合服务（组内再按厂商分小组） */
export const AGGREGATORS = new Set(['openrouter', 'fal', 'replicate']);

const VENDOR_NAME = {
  openai: 'OpenAI', google: 'Google', 'black-forest-labs': 'Black Forest Labs', bfl: 'Black Forest Labs', bytedance: 'ByteDance', 'bytedance-seed': 'ByteDance',
  stability: 'Stability AI', 'stability-ai': 'Stability AI', stabilityai: 'Stability AI', ideogram: 'Ideogram', 'ideogram-ai': 'Ideogram', recraft: 'Recraft', 'recraft-ai': 'Recraft',
  minimax: 'MiniMax', kling: 'Kling', klingai: 'Kling', 'kwaivgi': 'Kling', luma: 'Luma', lumalabs: 'Luma', runway: 'Runway', runwayml: 'Runway', pika: 'Pika',
  alibaba: 'Alibaba', qwen: 'Qwen', 'wan-video': 'Wan', wan: 'Wan', tencent: 'Tencent', hunyuan: 'Hunyuan', elevenlabs: 'ElevenLabs', 'x-ai': 'xAI', xai: 'xAI',
  meta: 'Meta', 'meta-llama': 'Meta', mistralai: 'Mistral', nvidia: 'NVIDIA', 'fal-ai': 'fal', fal: 'fal', 'lightricks': 'Lightricks', 'prunaai': 'Pruna AI',
  'leonardoai': 'Leonardo', 'playgroundai': 'Playground', 'sourceful': 'Sourceful', 'riverflow': 'Riverflow',
};
/** 厂商前缀 → 显示名（认不出的把连字符换空格、首字母大写） */
export function vendorName(v) {
  const k = String(v || '').toLowerCase();
  if (!k) return '';
  if (VENDOR_NAME[k]) return VENDOR_NAME[k];
  return k.split(/[-_]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}
/** 模型的厂商前缀：目录给的 vendor 优先，否则取 id 第一个斜杠前那段 */
export function vendorOf(m) {
  if (m?.vendor) return String(m.vendor);
  const id = String(m?.id || '');
  const i = id.indexOf('/');
  return i > 0 ? id.slice(0, i) : '';
}

/** 组里的主列表（不含 shelf、不含 gone）与备选 */
export function splitGroup(g) {
  const all = [...(g?.models || []), ...(g?.shelf || []).map((m) => ({ ...m, shelf: true }))].filter((m) => !m.gone);
  return { main: all.filter((m) => !m.shelf), shelf: all.filter((m) => m.shelf) };
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_\-./:]+/g, '');
/** 一个模型配不配搜索词（名字、id、厂商、服务名都算；连字符 / 空格 / 点不计较） */
export function matches(m, q, providerName = '') {
  const s = norm(q);
  if (!s) return true;
  return [m.label, m.id, vendorOf(m), vendorName(vendorOf(m)), providerName].some((x) => norm(x).includes(s));
}

/**
 * 选择器要画的结构：[{ provider, sections: [{ vendor, label, models }] }]
 *   主列表（q 非空时只留配得上的）；当前选中的 shelf 模型也放进它的服务里（免得选了以后在列表里找不到）。
 *   聚合服务按厂商分小组（只有一个厂商时不出小组头）；直连服务一个无名小组。
 *   搜到的备选不混进这里，单独一组（shelfHits），组名说一次，行里不逐个打标（复核 11-06）。
 */
export function pickerGroups(groups, { q = '', current = '' } = {}) {
  const out = [];
  for (const g of groups || []) {
    const { main, shelf } = splitGroup(g);
    const pname = g.provider?.name || '';
    let list = [...(q ? main.filter((m) => matches(m, q, pname)) : main), ...shelf.filter((m) => m.key === current)];
    if (!list.length) continue;
    const agg = AGGREGATORS.has(g.provider?.dialect) || AGGREGATORS.has(g.provider?.preset);
    let sections;
    if (agg) {
      const by = new Map();
      for (const m of list) { const v = vendorOf(m); if (!by.has(v)) by.set(v, []); by.get(v).push(m); }
      sections = [...by.entries()].map(([v, models]) => ({ vendor: v, label: vendorName(v), models }));
      if (sections.length === 1) sections[0].label = '';
    } else sections = [{ vendor: '', label: '', models: list }];
    out.push({ provider: g.provider, sections, count: list.length });
  }
  return out;
}

/** 搜索命中的备选（shelf）：[{ provider, model }]，按服务原顺序；当前选中的那个已经在主列表里了，不重复 */
export function shelfHits(groups, q, current = '') {
  if (!String(q || '').trim()) return [];
  const out = [];
  for (const g of groups || []) {
    const { shelf } = splitGroup(g);
    for (const m of shelf) if (m.key !== current && matches(m, q, g.provider?.name || '')) out.push({ provider: g.provider, model: m });
  }
  return out;
}

/** 目录里这一类一共多少个可选模型（主列表 + 备选）：> 8 才出搜索框 */
export function modelCount(groups) {
  let n = 0;
  for (const g of groups || []) { const { main, shelf } = splitGroup(g); n += main.length + shelf.length; }
  return n;
}

/** 参数来源（不是内置卡时才有一行 mono 小字；这是状态不是解释）：返回 { kind, from? } 或 null */
export function paramSource(m) {
  const s = m?.paramSource || (m?.generic ? 'generic' : '');
  if (!s || s === 'card') return null;
  if (s === 'family') return { kind: 'family', from: m.inheritsFrom || '' };
  if (s === 'schema') return { kind: 'schema' };
  if (s === 'generic') return { kind: 'generic' };
  return null;
}

/** 新发现的模型（7 天内且本人没用过；后端算 isNew，前端再扣掉本机刚选过的） */
export const isFresh = (m, seen) => !!m?.isNew && !(seen && seen.has(m.key));

// —— v4 选择器：按厂商分组，两家服务都有的同名模型合成一行（方案 §12.4）——
// 直连服务的模型 id 不带厂商前缀（Vertex 的 gemini-3-pro-image），厂商按服务的方言推；聚合服务取 id 前缀 / 目录 vendor
const DIALECT_VENDOR = { vertex: 'google', gemini: 'google', openai: 'openai', elevenlabs: 'elevenlabs', minimax: 'minimax', ark: 'bytedance' };
/** 模型的厂商键（小写）：目录 vendor → id 前缀 → 服务方言 → 服务本身 */
export function modelVendor(m, provider) {
  const v = vendorOf(m) || DIALECT_VENDOR[provider?.dialect] || DIALECT_VENDOR[provider?.preset] || provider?.preset || provider?.dialect || provider?.id || '';
  return String(v).toLowerCase();
}
// 行尾小分段里的服务短名：同一行里撞名了（两个 OpenRouter 账号）就退回服务全名
const SERVICE_SHORT = { vertex: 'Vertex', gemini: 'Gemini', openrouter: 'OpenRouter', fal: 'fal', replicate: 'Replicate', openai: 'OpenAI', elevenlabs: 'ElevenLabs', minimax: 'MiniMax' };
export const serviceShort = (p) => SERVICE_SHORT[p?.preset] || SERVICE_SHORT[p?.dialect] || String(p?.name || p?.id || '');

/**
 * 同名判定用的名字：去掉服务前缀后的 label（小写、空白归一）。
 *   OpenRouter 的「Google: Nano Banana 2.1」、手填的「Vertex · Nano Banana 2.1」「Nano Banana 2.1 (Gemini API)」都归到「nano banana 2.1」；
 *   「(free)」这类后缀是另一个模型，不去。
 */
const SERVICE_WORD = /(?:google\s+)?vertex(?:\s+ai)?|gemini\s+api|openrouter|fal(?:\.ai)?|replicate/.source;
const PREFIX_RE = new RegExp('^(?:' + SERVICE_WORD + ')' + /\s*[·:：/|\-–—]\s*/.source, 'i');
const SUFFIX_RE = new RegExp(/\s*/.source + '(?:[（(](?:' + SERVICE_WORD + ')[)）]|' + /[·|\-–—]\s*/.source + '(?:' + SERVICE_WORD + '))$', 'i');
/** 显示名：去掉服务前缀 / 后缀和聚合服务的「厂商: 」，保留原大小写（合并行只写一个名字） */
export function bareLabel(label) {
  let s = String(label ?? '').trim();
  s = s.replace(PREFIX_RE, '').replace(SUFFIX_RE, '');
  // 「厂商: 名字」：冒号前不超过 3 个词才算前缀，免得把名字里本来的冒号当前缀
  s = s.replace(/^[^:：]{1,32}[:：]\s+/, (m) => (m.trim().split(/\s+/).length <= 3 ? '' : m));
  return s.trim() || String(label ?? '');
}
export const sameNameKey = (label) => bareLabel(label).toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * v4 选择器的结构：[{ vendor, label, rows: [{ id, label, variants: [{ model, provider, short }], pick, on }] }]
 *   主列表（q 非空时只留配得上的）+ 当前选中的 shelf 模型；按厂商分组（组序 = 目录里第一次出现的顺序）；
 *   组内同名（sameNameKey 相同）且来自不同服务的合成一行，variants 按目录顺序；同一服务里重名的不合（那是两个模型）。
 *   pick = 这一行现在指向哪家：当前选中的那家，否则 prefer[行 id] 记住的那家，否则第一家。
 */
export function modelRows(groups, { q = '', current = '', prefer = {} } = {}) {
  const vendors = [];
  const byVendor = new Map();
  for (const g of groups || []) {
    const { main, shelf } = splitGroup(g);
    const pname = g.provider?.name || '';
    const list = [...(q ? main.filter((m) => matches(m, q, pname)) : main), ...shelf.filter((m) => m.key === current)];
    for (const m of list) {
      const v = modelVendor(m, g.provider);
      const vl = vendorName(v) || pname;
      const vk = vl.toLowerCase();
      let grp = byVendor.get(vk);
      if (!grp) { grp = { vendor: v, label: vl, rows: [], names: new Map() }; byVendor.set(vk, grp); vendors.push(grp); }
      const nk = sameNameKey(m.label || m.id);
      const row = grp.names.get(nk);
      const variant = { model: m, provider: g.provider };
      if (row && !row.variants.some((x) => x.provider?.id === g.provider?.id)) row.variants.push(variant);
      else {
        const r = { id: nk + '|' + (row ? m.key : ''), label: bareLabel(m.label || m.id), variants: [variant] };
        if (!row) grp.names.set(nk, r);
        grp.rows.push(r);
      }
    }
  }
  for (const grp of vendors) {
    delete grp.names;
    for (const r of grp.rows) {
      const shorts = r.variants.map((x) => serviceShort(x.provider));
      r.variants.forEach((x, i) => { x.short = shorts.indexOf(shorts[i]) !== shorts.lastIndexOf(shorts[i]) ? String(x.provider?.name || shorts[i]) : shorts[i]; });
      const cur = r.variants.findIndex((x) => x.model.key === current);
      const pref = r.variants.findIndex((x) => x.provider?.id === prefer[r.id]);
      r.pick = cur >= 0 ? cur : pref >= 0 ? pref : 0;
      r.on = cur >= 0;
    }
  }
  return vendors;
}
