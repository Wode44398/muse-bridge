// 模型卡总表：服务 + 模型条目 → 模型卡（§3.2）。
// 找卡的顺序（方案 §9.3 参数解析链）：模型条目显式指定的 card → 该方言的内置卡（按模型 id；已知模型的参数与规范化一字不变）
// → 上游 schema 卡（巡检缓存，discovery/schema.mjs）→ 同族继承卡（discovery/family.mjs，Google 系再拿参照库精修）
// → 该方言该种类的通用卡（带 extra 透传）。

import { googleCard, googleBuild, googleCandidates } from './google.mjs';
import { genericCard, P, opts } from './spec.mjs';
import { CAPABILITIES, IMG_QUALITIES } from '@bridge/core/config/capabilities.mjs';
import { dialectCards, dialectCardList } from './dialects.mjs';
import { getSchema, discoveryRev, referenceModel } from '../discovery/store.mjs';
import { fromJsonSchema, fromOpenRouterImage, fromOpenRouterVideo } from '../discovery/schema.mjs';
import { pickParent, inheritCard, refineGoogleCard } from '../discovery/family.mjs';
// 各方言适配器导入时登记自己的常见模型卡（registerDialectCards）：先确保它们都导进来了
import '../adapters/index.mjs';

const C = CAPABILITIES;

// —— OpenRouter：GPT Image 2.6 / 2.5 Sunburst（/api/v1/images；像素只认 size:'WxH'，见 adapters/openrouter-image.mjs）——
const GPT_IMAGE = {
  'openai/gpt-image-2.6-sunburst': { label: 'GPT Image 2.6 Sunburst', priceHint: '1.5K medium ≈ $0.034，4K 16:9 low ≈ $0.047' },
  'openai/gpt-image-2.5-sunburst': { label: 'GPT Image 2.5 Sunburst', priceHint: 'low 2K ≈ $0.005，4K 16:9 low ≈ $0.011' },
};
function gptImageCard(id) {
  const aspects = C.image.aspects.filter((a) => !a.only);
  return {
    id: `openrouter:${id}`, kind: 'image', async: false, label: GPT_IMAGE[id].label,
    desc: '构图、文字与指令遵循精细；没有多轮上下文，续改拿上一张当参考',
    inputs: { text: true, images: { max: 16, roles: ['edit', 'ref'] }, multiTurn: false },
    params: [
      P.enum('aspectRatio', '比例', aspects.map((a) => ({ value: a.id, label: a.name })), { default: 'auto' }),
      P.enum('imageSize', '尺寸', opts(['1K', '2K', '4K']), { default: '2K' }),
      P.enum('quality', '画质', C.image.qualities.map((q) => ({ value: q.id, label: q.name })), { default: 'high' }),
    ],
    priceHint: GPT_IMAGE[id].priceHint,
    normalize(raw = {}) {
      const asp = aspects.some((a) => a.id === raw.aspectRatio) ? raw.aspectRatio : 'auto';
      return { aspectRatio: asp, imageSize: ['1K', '2K', '4K'].includes(raw.imageSize) ? raw.imageSize : undefined, quality: IMG_QUALITIES.has(raw.quality) ? raw.quality : undefined };
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
    if (s.src === 'openrouter-image') body = fromOpenRouterImage(s.data);
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

// ③④⑤ 跟服务有关（schema 按服务缓存），按 服务 + 模型 + 发现状态版本 缓存
const dyn = new Map();
let dynRev = -1;
/** 这个服务里这个模型用哪张卡：① 显式 card → ② 内置卡 → ③ 上游 schema 卡 → ④ 同族继承卡 → ⑤ 通用卡 + extra。 */
export function cardFor(provider, entry) {
  const b = builtinCard(provider.dialect, entry);
  if (b) return b;
  if (dynRev !== discoveryRev()) { dyn.clear(); dynRev = discoveryRev(); }
  const k = (provider.owner || '') + '|' + provider.id + '|' + provider.dialect + '|' + entry.id + '|' + entry.kind + '|' + (entry.label || '');
  if (dyn.has(k)) return dyn.get(k);
  const card = schemaCard(provider, entry) || familyCard(provider, entry) || genericCard(provider.dialect, entry.kind);
  dyn.set(k, card);
  return card;
}

/** 参数来源（目录的 paramSource）。 */
export const paramSourceOf = (card) => card?.paramSource || (card?.generic ? 'generic' : 'card');
