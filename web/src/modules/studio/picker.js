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
