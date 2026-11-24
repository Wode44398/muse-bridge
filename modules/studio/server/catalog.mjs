// 模型目录（方案 §3.2）：这个人能用的服务 × 启用的模型 × 模型卡 → 给创作页的 ResolvedModel；以及按键 / 裸 id 找模型。
//
//   GET /api/studio/catalog → { kinds: { image|video|speech|music: { defaults: { provider, model } | null, groups: [{ provider, models }] } }, rev }
//   模型键 key = '<服务 id>/<模型 id>'；Claude 工具 / 旧接口传的裸 id（gemini-3-pro-image、veo-3.1-fast-generate-001、
//   gpt-image-2.5-sunburst…）按「内置 Google 模型 id → 方言」找这个人能用的服务（resolveBare）。

import { createHash } from 'node:crypto';
import { IMG_OPENROUTER, IMAGE_MODEL_DEFAULT, VEO_MODEL_DEFAULT, TTS_MODEL_DEFAULT, MUSIC_MODEL_DEFAULT } from '@bridge/core/config/capabilities.mjs';
import { effectiveStudioSettings } from '@bridge/core/runtime/studio-settings.mjs';
import { usableProviders, findProvider, parseModelKey, modelKey, providersRev, isMemberOwner } from './providers.mjs';
import { KINDS, DIALECT_KINDS } from './presets.mjs';
import { cardFor, paramSourceOf } from './cards/index.mjs';
import { decorateSpec } from './discovery/labels.mjs';
import { vendorOf } from './discovery/sources.mjs';
import { usedModel, discoveryRev, rejectedFor } from './discovery/store.mjs';
import { modelConfigRev } from './model-config/store.mjs';
import { markRejected } from './cards/rejected.mjs';
import { googleDialectOf } from './cards/google.mjs';
import { LOCAL_IMAGE_MODEL } from './adapters/local-image.mjs';

const ETA = { image: 20, video: 100, speech: 10, music: 70 };   // 没有真进度时估进度条用（秒）
const AGGREGATORS = new Set(['openrouter', 'replicate', 'fal']);
export const NEW_DAYS = 7;

const labelOf = (entry, card) => (entry.label && entry.label !== entry.id ? entry.label : (card?.label || entry.id));
const vendorFor = (provider, entry) => entry.vendor || (AGGREGATORS.has(provider.dialect) ? vendorOf(provider.dialect, entry.id) : undefined);
/** 新发现的（7 天内）且这个人没用过；备选不算新。 */
export function isNewModel(provider, entry, owner, now = Date.now()) {
  if (!entry.discoveredAt || entry.shelf || entry.source !== 'remote') return false;
  if (now - entry.discoveredAt > NEW_DAYS * 86400_000) return false;
  return !usedModel(owner || provider.owner, modelKey(provider.id, entry.id));
}

/**
 * 服务里的模型条目 → ResolvedModel（给前端）。模型条目的 defaults 覆盖卡上参数的默认值。
 * §9.3 增量：paramSource（card | schema | family | generic）、inheritsFrom、refinedBy、vendor、isNew、shelf、etaSec；
 * ParamSpec 补 format / unit 渲染提示（取值与默认值不动）。
 */
export function resolvedModel(provider, entry, owner) {
  const card = cardFor(provider, entry);
  const d = entry.defaults || {};
  // 上游拒收过的取值标上 rejected（方案 §11.4：中转站认不认 svg / gif 没有接口能问，被拒一次就记住）
  const params = markRejected(card.params.map((s) => decorateSpec(s.key in d ? { ...s, default: d[s.key] } : s)), rejectedFor(provider.owner, provider.id, entry.id));
  const vendor = vendorFor(provider, entry);
  return {
    key: modelKey(provider.id, entry.id), id: entry.id,
    label: labelOf(entry, card),
    ...(card.desc ? { desc: card.desc } : {}),
    kind: entry.kind, async: !!card.async, inputs: card.inputs, params,
    paramSource: paramSourceOf(card),
    ...(card.inheritsFrom ? { inheritsFrom: card.inheritsFrom } : {}),
    ...(card.refinedBy ? { refinedBy: card.refinedBy } : {}),
    ...(vendor ? { vendor } : {}),
    ...(isNewModel(provider, entry, owner) ? { isNew: true } : {}),
    ...(entry.shelf ? { shelf: true } : {}),
    ...(card.etaSec ? { etaSec: card.etaSec } : {}),
    ...(card.priceHint ? { priceHint: card.priceHint } : {}),
    ...(card.generic ? { generic: true } : {}),
    // 模型配置层：配方 / 参数覆盖（界面标「已自定义」，list_media_models 标出来）
    ...(card.recipe || card.overlay ? { custom: { ...(card.recipe ? { recipe: true } : {}), ...(card.overlay ? { over: true } : {}) } } : {}),
  };
}
/** 备选模型在目录里的轻条目（完整的按需 GET /api/studio/models/resolve?key=）。 */
export function shelfEntry(provider, entry) {
  const vendor = vendorFor(provider, entry);
  return { key: modelKey(provider.id, entry.id), id: entry.id, label: entry.label || entry.id, ...(vendor ? { vendor } : {}), kind: entry.kind, shelf: true };
}

const providerView = (p, owner) => ({
  id: p.id, name: p.name, dialect: p.dialect, preset: p.preset, mine: p.owner === (owner || 'admin'),
  ...(p.owner !== (owner || 'admin') ? { shared: true } : {}),
});

/** 按模型键找：服务停用 / 被删、模型关掉或种类不对都回 null。 */
export function resolveKey(key, owner, kind) {
  const k = parseModelKey(key);
  if (!k) return null;
  const provider = findProvider(k.pid, owner);
  if (!provider || !provider.enabled) return null;
  const entry = provider.models.find((m) => m.id === k.mid && m.enabled);
  if (!entry || (kind && entry.kind !== kind)) return null;
  return { provider, entry, card: cardFor(provider, entry) };
}

// 裸 id 归哪个方言、对应服务里的模型 id 是什么（GPT Image 在 OpenRouter 服务里叫 openai/…）
function bareTarget(id) {
  if (Object.prototype.hasOwnProperty.call(IMG_OPENROUTER, id)) return { dialect: 'openrouter', mid: IMG_OPENROUTER[id] };
  if (id === LOCAL_IMAGE_MODEL) return { dialect: 'local', mid: id };
  return { dialect: googleDialectOf(id), mid: id };
}

/**
 * 裸模型 id（Claude 工具 / 旧接口）→ 这个人能用的服务里对应的模型（自己的服务在前、共享的其次）：
 * ① 所有启用服务（不限方言）里列了同名模型的：内置 id 在它本来的方言里有内置卡的，照旧用那个服务（Vertex 与 Gemini API
 *    都列了 Nano Banana 时不算歧义）；否则唯一命中就用，多个命中抛 400 并列出「服务 id/模型 id」候选；
 * ② 都没列：同方言第一个启用的服务凭空造条目——只认真正的内置卡（同族继承、通用卡不算：那是猜的，服务里未必有这个模型，发过去多半 404）。
 * 找不到回 null。
 */
export function resolveBare(id, kind, owner) {
  if (!id || typeof id !== 'string') return null;
  const { dialect, mid } = bareTarget(id);
  const usable = usableProviders(owner).filter((p) => p.enabled && DIALECT_KINDS[p.dialect]?.includes(kind));
  const hits = [];
  for (const p of usable) {
    const want = p.dialect === dialect ? [id, mid] : [id];
    const entry = p.models.find((m) => want.includes(m.id) && m.enabled && m.kind === kind);
    if (entry) hits.push({ provider: p, entry, card: cardFor(p, entry) });
  }
  const home = hits.find((h) => h.provider.dialect === dialect && paramSourceOf(h.card) === 'card');
  if (home) return home;
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw ambiguousBare(id, hits);
  // 服务里没列这个模型（比如导入后手动删了某个）
  for (const p of usable) {
    if (p.dialect !== dialect) continue;
    if (p.models.some((m) => m.id === mid)) continue;   // 列了但关着 = 管理员不想用
    const entry = { id: mid, label: mid, kind, enabled: true, source: 'builtin', defaults: {} };
    const card = cardFor(p, entry);
    if (paramSourceOf(card) === 'card') return { provider: p, entry, card };
  }
  return null;
}
function ambiguousBare(id, hits) {
  const list = hits.map((h) => `${modelKey(h.provider.id, h.entry.id)}（${h.provider.name || h.provider.dialect}）`).join('、');
  const e = new Error(`模型「${id}」在 ${hits.length} 个服务里都有：${list}。model 写完整的「服务 id/模型 id」指定用哪个，例如 "${modelKey(hits[0].provider.id, hits[0].entry.id)}"`);
  e.status = 400;
  e.candidates = hits.map((h) => modelKey(h.provider.id, h.entry.id));
  return e;
}
/** 裸 id 没找到时报错用的提示：怎么写完整键。 */
export const BARE_HINT = 'model 可以写完整的「服务 id/模型 id」（list_media_models 或 设置 › Media Studio 里查）';

/** 键或裸 id 都收。 */
export function resolveAny(keyOrId, kind, owner) {
  if (parseModelKey(keyOrId)) return resolveKey(keyOrId, owner, kind);
  return resolveBare(keyOrId, kind, owner);
}

const BUILTIN_DEFAULT = { image: IMAGE_MODEL_DEFAULT, video: VEO_MODEL_DEFAULT, speech: TTS_MODEL_DEFAULT, music: MUSIC_MODEL_DEFAULT };

/** 这个人这种媒体的默认模型：设置里选的（个人压过主机）→ 内置默认（裸 id 解析）→ 目录里第一个能用的。 */
export function defaultFor(kind, owner, { fallbackBare } = {}) {
  const pick = effectiveStudioSettings(owner).defaults?.[kind];
  if (pick && pick.provider && pick.model) {
    const r = resolveKey(modelKey(pick.provider, pick.model), owner, kind);
    if (r) return r;
  }
  // 内置默认被多个服务同名列着（歧义）：这里不报错，往下按目录顺序取
  let bare = null;
  try { bare = resolveBare(fallbackBare || BUILTIN_DEFAULT[kind], kind, owner); } catch {}
  if (bare) return bare;
  for (const p of usableProviders(owner)) {
    if (!p.enabled || !DIALECT_KINDS[p.dialect].includes(kind)) continue;
    const entry = p.models.find((m) => m.enabled && m.kind === kind && !m.shelf && !m.gone);
    if (entry) return { provider: p, entry, card: cardFor(p, entry) };
  }
  return null;
}
/** 设置里显式选了这种的默认模型（Claude 工具据此决定要不要换掉自己的内置默认）。 */
export function explicitDefault(kind, owner) {
  const pick = effectiveStudioSettings(owner).defaults?.[kind];
  if (!pick || !pick.provider || !pick.model) return null;
  return resolveKey(modelKey(pick.provider, pick.model), owner, kind);
}

export function catalog(owner) {
  const kinds = {};
  const providers = usableProviders(owner).filter((p) => p.enabled);
  for (const kind of KINDS) {
    const groups = [];
    for (const p of providers) {
      if (!DIALECT_KINDS[p.dialect].includes(kind)) continue;
      const live = p.models.filter((m) => m.enabled && m.kind === kind && !m.gone);
      const models = live.filter((m) => !m.shelf).map((m) => resolvedModel(p, m, owner));
      // 备选（聚合服务建底时的存量）只给轻条目，放在 shelf 里（老前端只认 models，不受影响）
      const shelf = live.filter((m) => m.shelf).map((m) => shelfEntry(p, m));
      if (models.length || shelf.length) groups.push({ provider: providerView(p, owner), models, ...(shelf.length ? { shelf } : {}) });
    }
    const d = defaultFor(kind, owner);
    kinds[kind] = { defaults: d ? { provider: d.provider.id, model: d.entry.id } : null, groups };
  }
  return { kinds, rev: catalogRev(owner) };
}

/** 目录版本号：服务注册表 + 生效设置 + 发现状态（schema / 参照库）的指纹（前端据此判断要不要重拉）。 */
export function catalogRev(owner) {
  const s = effectiveStudioSettings(owner);
  return String(providersRev(owner)) + '.' + createHash('sha1').update(JSON.stringify([s.defaults, isMemberOwner(owner), discoveryRev(), modelConfigRev()])).digest('hex').slice(0, 8);
}

export const etaFor = (kind, card) => card?.etaSec || ETA[kind] || 30;
