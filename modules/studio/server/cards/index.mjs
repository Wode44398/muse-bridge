// 模型卡总表：服务 + 模型条目 → 模型卡（§3.2）。
// 找卡的顺序（方案 §9.3 参数解析链）：模型条目显式指定的 card → 该方言的内置卡（按模型 id；已知模型的参数与规范化一字不变）
// → 上游 schema 卡（巡检缓存，discovery/schema.mjs）→ 同族继承卡（discovery/family.mjs，Google 系再拿参照库精修）
// → 该方言该种类的通用卡（带 extra 透传）。

import { googleCard, googleBuild, googleCandidates } from './google.mjs';
import { genericCard, P, opts, applySpecs } from './spec.mjs';
import { CAPABILITIES } from '@bridge/core/config/capabilities.mjs';
import { dialectCards, dialectCardList } from './dialects.mjs';
import { getSchema, discoveryRev, referenceModel } from '../discovery/store.mjs';
import { fromJsonSchema, fromOpenRouterImage, fromOpenRouterVideo } from '../discovery/schema.mjs';
import { pickParent, inheritCard, refineGoogleCard } from '../discovery/family.mjs';
import { mergeBuiltinWithSchema } from './merge.mjs';
import { getModelConfig, modelConfigRev } from '../model-config/store.mjs';
import { applyOver } from '../model-config/overlay.mjs';
import { recipeCard } from '../recipe/card.mjs';
// 各方言适配器导入时登记自己的常见模型卡（registerDialectCards）：先确保它们都导进来了
import '../adapters/index.mjs';
import { flexSizeSpec, gptFormatSpecs, roundFrameMs, BG_TRANSPARENT, MODERATION_OPTS, COMPLEXITY_OPTS } from '../adapters/openai.mjs';

const C = CAPABILITIES;

// —— OpenRouter：GPT Image（/api/v1/images；像素只认 size:'WxH'，见 adapters/openrouter-image.mjs）——
// ver 决定写死的能力表（2026-11-15 目录）：2.6 有 gif 与 complexity 透传；2.5 / 2.6 画质到 xhigh / max；gpt-image-2 画质到 high、没有透明背景。
// 有巡检缓存的目录 schema 时，cardFor 再按它收窄 / 放宽（gptImageCard 的 sp / ep 参数）。
const GPT_IMAGE = {
  'openai/gpt-image-2.6-sunburst': { label: 'GPT Image 2.6 Sunburst', ver: '2.6', priceHint: '1.5K medium ≈ $0.034，4K 16:9 low ≈ $0.047' },
  'openai/gpt-image-2.6-flare': { label: 'GPT Image 2.6 Flare', ver: '2.6' },
  'openai/gpt-image-2.5-sunburst': { label: 'GPT Image 2.5 Sunburst', ver: '2.5', priceHint: 'low 2K ≈ $0.005，4K 16:9 low ≈ $0.011' },
  'openai/gpt-image-2.5-flare': { label: 'GPT Image 2.5 Flare', ver: '2.5' },
  'openai/gpt-image-2': { label: 'GPT Image 2', ver: '2', desc: '官方标为弃用，2027-02-10 下线；没有多轮上下文，续改拿上一张当参考' },
};
const GPT_STATIC = {
  '2.6': { quality: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], formats: ['png', 'jpeg', 'webp', 'gif'], background: ['auto', 'opaque', 'transparent'], n: 10, pass: ['moderation', 'complexity'] },
  '2.5': { quality: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'], formats: ['png', 'jpeg', 'webp'], background: ['auto', 'opaque', 'transparent'], n: 10, pass: ['moderation'] },
  '2': { quality: ['auto', 'low', 'medium', 'high'], formats: ['png', 'jpeg', 'webp'], background: ['auto', 'opaque'], n: 10, pass: ['moderation'] },
};
const Q_LABEL = { auto: '自动', ...Object.fromEntries(C.image.qualities.map((q) => [q.id, q.name])) };
const BG_LABEL = { auto: '自动', opaque: '不透明' };
const enumVals = (d) => (d?.type === 'enum' && Array.isArray(d.values) && d.values.length ? d.values.filter((v) => typeof v === 'string' && v) : null);

/**
 * GPT Image 内置卡。sp = 巡检缓存的目录 supported_parameters（有就用它的枚举收窄 / 放宽：上游新开的格式、画质档界面自动出现）；
 * ep = 缓存的端点信息 { slug, passthrough }（只有一个服务商端点时才有 slug），有它就按透传键决定给不给审核 / 构图规划。
 * 键名与 OpenAI 兼容方言的卡一致（size / quality / count / outputFormat / …），跨服务「复用参数」直接对得上。
 * 2026-11-15（方案 §10）：界面上是自由尺寸——一个 size 参数（自动 / 原图 / 预设 / 自定义宽高），不再有比例；
 * 旧写法 aspectRatio + imageSize（Claude 媒体工具、旧接口）照收、行为不变（按比例 + 档位算，媒体工具据 imageSize 查降档）。
 */
export function gptImageCard(id, sp = null, ep = null) {
  const meta = GPT_IMAGE[id];
  const st = GPT_STATIC[meta.ver];
  const aspects = C.image.aspects.filter((a) => !a.only);
  const qualities = enumVals(sp?.quality) || st.quality;
  let formats = enumVals(sp?.output_format) || st.formats;
  if (!formats.length) formats = ['png'];
  const bgs = enumVals(sp?.background) || st.background;
  const nMax = sp?.n?.type === 'range' && Number(sp.n.max) >= 1 ? Math.min(10, Math.floor(Number(sp.n.max))) : st.n;
  // 驱动把审核 / 构图规划写进 provider.options.openai：只有确定是 openai 这一个端点时才信缓存的透传表，否则用写死的
  const pass = ep?.slug === 'openai' && Array.isArray(ep.passthrough) ? ep.passthrough : st.pass;
  const size = flexSizeSpec();
  const qDefault = qualities.includes('high') ? 'high' : qualities[qualities.length - 1];
  const quality = P.enum('quality', '画质', qualities.map((v) => ({ value: v, label: Q_LABEL[v] || v })), { default: qDefault });
  const f = gptFormatSpecs(formats);
  const svg = formats.includes('svg');
  const params = [
    size, quality,
    ...(nMax > 1 ? [P.num('count', '张数', 1, nMax, { step: 1, integer: true, default: 1, group: 'basic', format: 'count', ...(svg ? { when: { outputFormat: formats.filter((v) => v !== 'svg') } } : {}) })] : []),
    f.format,
    ...[f.compression, f.frameCount, f.frameDurationMs].filter(Boolean),
    ...(bgs.length > 1 ? [P.enum('background', '背景', bgs.map((v) => (v === 'transparent' ? BG_TRANSPARENT : { value: v, label: BG_LABEL[v] || v })), { group: 'advanced', default: bgs.includes('auto') ? 'auto' : bgs[0] })] : []),
    ...(pass.includes('moderation') ? [P.enum('moderation', '审核', MODERATION_OPTS, { group: 'advanced', default: 'auto', desc: '宽松 = 放宽内容过滤' })] : []),
    ...(pass.includes('complexity') ? [P.enum('complexity', '规划强度', COMPLEXITY_OPTS, { group: 'advanced', default: '', desc: '复杂画面先规划构图；不选按高' })] : []),
    P.json(),
  ];
  const rest = params.filter((s) => s.key !== 'size' && s.key !== 'quality');
  const has = (raw, k) => raw[k] !== undefined && raw[k] !== null && raw[k] !== '';
  return {
    id: `openrouter:${id}`, kind: 'image', async: false, label: meta.label,
    desc: meta.desc || '构图、文字与指令遵循精细；没有多轮上下文，续改拿上一张当参考',
    inputs: { text: true, images: { max: 16, roles: ['edit', 'ref'] }, multiTurn: false },
    params,
    legacyKeys: ['aspectRatio', 'imageSize'],   // 旧写法照收（见 normalize），生成工具报「未生效参数」时别算它们
    ...(meta.priceHint ? { priceHint: meta.priceHint } : {}),
    normalize(raw = {}, ctx = {}) {
      // 新写法（给了 size）：全部参数按 ParamSpec 规范化（不认的键丢、默认值补上、when 不满足的丢）
      if (has(raw, 'size')) return roundFrameMs(applySpecs(params, raw, ctx));
      // 旧写法：比例 + 档位照旧（imageSize 留着给媒体工具查降档）；新参数只收本次显式给了的（不补默认值，旧调用的参数表一字不变）
      const q = qualities.includes(raw.quality) ? raw.quality : undefined;
      const asp = aspects.some((a) => a.id === raw.aspectRatio) ? raw.aspectRatio : 'auto';
      const more = roundFrameMs(applySpecs(rest, raw, ctx));
      for (const k of Object.keys(more)) if (!has(raw, k)) delete more[k];
      return { aspectRatio: asp, imageSize: ['1K', '2K', '4K'].includes(raw.imageSize) ? raw.imageSize : undefined, quality: q, ...more };
    },
  };
}

// —— 本机 Qwen Image 2.1（参数校验在 adapters/local-image.mjs generationSettings，坏值整单 400）——
const LOCAL_ASPECTS = ['auto', '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'];
function localCard(id) {
  return {
    id: `local:${id}`, kind: 'image', async: true, label: 'Qwen Image 2.1 · 本机',
    desc: '本机 GPU 推理，不花钱；要先在「本机部署」里启动',
    inputs: { text: true, images: { max: 10, roles: ['edit', 'ref'] }, multiTurn: false },
    params: [
      P.enum('aspectRatio', '比例', LOCAL_ASPECTS.map((v) => ({ value: v, label: v === 'auto' ? '自动' : v })), { default: 'auto' }),
      P.enum('imageSize', '尺寸', opts(['1K', '2K', '4K', { value: 'custom', label: '自定义' }]), { default: '2K' }),
      P.num('width', '宽', 256, 6144, { step: 32, integer: true, when: { imageSize: 'custom' } }),
      P.num('height', '高', 256, 6144, { step: 32, integer: true, when: { imageSize: 'custom' } }),
      P.num('steps', '采样步数', 1, 100, { step: 1, integer: true, default: 40 }),
      P.num('cfg', 'CFG', 1, 10, { step: 0.1, default: 1 }),
      P.num('count', '张数', 1, 4, { step: 1, integer: true, default: 1, group: 'basic' }),
      P.seed({ min: -1, default: -1, desc: '-1 = 随机' }),
      P.enum('referenceResolution', '参考图分辨率', opts([512, 1024, 2048]), { group: 'advanced', default: 1024 }),
      P.bool('useKvCache', 'KV 缓存', { default: true }),
      P.bool('transparent', '透明背景', { default: false }),
    ],
    // 原样交给 generationSettings 校验（它对坏值抛错，信息直接回给用户）
    normalize(raw = {}) {
      const out = {};
      for (const k of ['aspectRatio', 'imageSize', 'width', 'height', 'steps', 'cfg', 'count', 'seed', 'referenceResolution', 'useKvCache', 'transparent', 'sigmas']) {
        if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') out[k] = raw[k];
      }
      for (const k of ['width', 'height', 'steps', 'count', 'seed', 'referenceResolution']) if (k in out) out[k] = Number(out[k]);
      if ('cfg' in out) out.cfg = Number(out.cfg);
      return out;
    },
  };
}

// ①② 显式指定的卡 / 内置卡（Google 系、GPT Image、本机、各方言常见模型）：与服务无关，按 方言 + 模型 缓存。
const memo = new Map();
function builtinCard(dialect, entry) {
  const k = dialect + '|' + entry.id + '|' + (entry.card || '') + '|' + entry.kind;
  if (memo.has(k)) return memo.get(k);
  let card = null;
  if (dialect === 'vertex' || dialect === 'gemini') card = googleCard(dialect, entry.id);
  if (!card && dialect === 'openrouter' && GPT_IMAGE[entry.id]) card = gptImageCard(entry.id);
  if (!card && dialect === 'local' && entry.id === 'qwen-image-2.1-local') card = localCard(entry.id);
  if (!card) card = dialectCards(dialect, entry.id, entry.card);
  if (card && card.kind !== entry.kind) card = null;   // 卡的种类对不上（手填时选错种类）：往下走
  memo.set(k, card);
  return card;
}

// ③ 上游 schema 卡（巡检缓存的 OpenRouter 目录描述 / Replicate、fal 的 JSON Schema）
function schemaCard(provider, entry) {
  const s = getSchema(provider.owner, provider.id, entry.id);
  if (!s || s.kind !== entry.kind) return null;
  let body = null;
  try {
    if (s.src === 'openrouter-image') body = fromOpenRouterImage(s.data, { endpoints: s.endpoints });
    else if (s.src === 'openrouter-video') body = fromOpenRouterVideo(s.data);
    else if (s.src === 'jsonschema') body = fromJsonSchema(entry.kind, s.data.input, s.data.defs || {});
  } catch (e) { console.error('[studio] schema 转不成参数：', entry.id, (e && e.message) || e); }
  if (!body) return null;
  return {
    id: `schema:${provider.dialect}:${entry.id}`, kind: entry.kind, async: entry.kind === 'video' || entry.kind === 'music',
    inputs: body.inputs, params: body.params, wire: body.wire, paramSource: 'schema', schemaSrc: s.src,
    ...(body.audioFixed ? { audioFixed: true } : {}), ...(s.priceHint ? { priceHint: s.priceHint } : {}),
  };
}

// ④ 同族继承（+ Google 系用参照库精修）
function familyCard(provider, entry) {
  const dialect = provider.dialect;
  const label = entry.label && entry.label !== entry.id ? entry.label : undefined;
  const cardId = `family:${dialect}:${entry.id}`;
  if (dialect === 'vertex' || dialect === 'gemini') {
    const parent = pickParent(entry.id, googleCandidates(entry.kind), { dialect });
    if (!parent) return null;
    const base = googleBuild(dialect, entry.kind, parent.id);
    if (!base) return null;
    const card = inheritCard(base, { cardId, label, parentId: parent.id });
    const ref = referenceModel('google/' + entry.id);
    return ref ? refineGoogleCard(card, ref).card : card;
  }
  const cands = dialectCardList(dialect).filter((x) => x.card.kind === entry.kind).map((x) => ({ id: x.id, card: x.card }));
  if (dialect === 'openrouter' && entry.kind === 'image') for (const id of Object.keys(GPT_IMAGE)) cands.push({ id, card: gptImageCard(id) });
  const parent = pickParent(entry.id, cands, { dialect });
  return parent ? inheritCard(parent.card, { cardId, label, parentId: parent.id }) : null;
}

function refinedGptCard(provider, entry) {
  let s = null;
  try { s = getSchema(provider.owner, provider.id, entry.id); } catch { s = null; }
  if (!s || s.src !== 'openrouter-image' || !s.data?.supported_parameters) return null;
  try {
    const card = gptImageCard(entry.id, s.data.supported_parameters, s.endpoints || null);
    if (!card.priceHint && s.priceHint) card.priceHint = s.priceHint;
    return card;
  } catch (e) { console.error('[studio] GPT Image 卡精修失败：', entry.id, (e && e.message) || e); return null; }
}

// ③④⑤ 跟服务有关（schema 按服务缓存），按 服务 + 模型 + 发现状态版本 缓存
const dyn = new Map();
let dynRev = -1;
/** 这个服务里这个模型用哪张卡：① 显式 card → ② 内置卡 → ③ 上游 schema 卡 → ④ 同族继承卡 → ⑤ 通用卡 + extra。 */
export function baseCardFor(provider, entry) {
  const b = builtinCard(provider.dialect, entry);
  if (dynRev !== discoveryRev()) { dyn.clear(); dynRev = discoveryRev(); }
  const k = (provider.owner || '') + '|' + provider.id + '|' + provider.dialect + '|' + entry.id + '|' + entry.kind + '|' + (entry.label || '');
  // OpenRouter 的 GPT Image 内置卡：这个服务巡检缓存了目录 schema 就按它精修（跟服务有关，所以放这里按 服务 + 模型 + 发现状态版本 缓存）
  if (b && provider.dialect === 'openrouter' && GPT_IMAGE[entry.id] && !entry.card) {
    if (dyn.has(k)) return dyn.get(k);
    const card = refinedGptCard(provider, entry) || b;
    dyn.set(k, card);
    return card;
  }
  // fal / Replicate 的内置卡（方案 §11）：不再挡住更全的上游 schema——内置卡为主（参数、默认值、wire、normalize 都留着），
  // schema 里有而内置卡没发过的字段追加到「更多」末尾。没有 schema 缓存（没巡检过 / 离线）就是内置卡本身。
  if (b && (provider.dialect === 'fal' || provider.dialect === 'replicate') && !entry.card) {
    if (dyn.has(k)) return dyn.get(k);
    let card = b;
    const s = getSchema(provider.owner, provider.id, entry.id);
    if (s && s.src === 'jsonschema' && s.kind === entry.kind) {
      try { card = mergeBuiltinWithSchema(b, fromJsonSchema(entry.kind, s.data.input, s.data.defs || {})); }
      catch (e) { console.error('[studio] 内置卡合并 schema 失败：', entry.id, (e && e.message) || e); }
    }
    dyn.set(k, card);
    return card;
  }
  if (b) return b;
  if (dyn.has(k)) return dyn.get(k);
  const card = schemaCard(provider, entry) || familyCard(provider, entry) || genericCard(provider.dialect, entry.kind);
  dyn.set(k, card);
  return card;
}

// 模型配置层（model-config/）：配方整张换掉卡（配方自己声明参数），覆盖叠在卡上。按 服务 + 模型 + 配置版本 缓存
const cfgCache = new Map();
let cfgRev = -1;
/** 最终用的卡：上面那条解析链出来的卡，再叠这个模型的配置（配方 / 参数覆盖）。没配置的模型原样返回。 */
export function cardFor(provider, entry) {
  const cfg = provider?.id && entry?.id ? getModelConfig(provider.owner, provider.id, entry.id) : null;
  if (!cfg) return baseCardFor(provider, entry);
  if (cfgRev !== modelConfigRev() + ':' + discoveryRev()) { cfgCache.clear(); cfgRev = modelConfigRev() + ':' + discoveryRev(); }
  const k = (provider.owner || '') + '|' + provider.id + '|' + entry.id + '|' + entry.kind + '|' + (entry.label || '');
  if (cfgCache.has(k)) return cfgCache.get(k);
  let card = cfg.recipe ? recipeCard(cfg.recipe, entry) : baseCardFor(provider, entry);
  if (cfg.over) card = applyOver(card, cfg.over);
  cfgCache.set(k, card);
  return card;
}

/** 参数来源（目录的 paramSource）。 */
export const paramSourceOf = (card) => card?.paramSource || (card?.generic ? 'generic' : 'card');
