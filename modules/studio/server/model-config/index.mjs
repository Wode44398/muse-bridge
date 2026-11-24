// 模型配置层的业务：读一个模型的配置视图、写配置（含给非托管服务新建模型条目）、预演与试跑。
// 路由（routes/model-config.mjs）与 agent 操作（核心 src/agent-api/ops/studio.mjs 经进程内请求）都走这里。
//
// 权限：只改自己的服务（管理员 = 主机的服务，含模型中心托管的；成员 = 自己的服务）。托管服务的服务记录归模型中心，
// 但配置层是另存的，所以托管服务也能写覆盖与配方——这正是给中转站补参数、接不标准视频接口的地方。

import { getProvider, findProvider, patchModels, isManaged, providerSecret, parseModelKey, modelKey, MODEL_ID_RE } from '../providers.mjs';
import { DIALECT_KINDS } from '../presets.mjs';
import { baseCardFor, cardFor, paramSourceOf } from '../cards/index.mjs';
import { recipeCard } from '../recipe/card.mjs';
import { normalizeRecipe } from '../recipe/normalize.mjs';
import { previewRecipe } from '../recipe/run.mjs';
import { RECIPE_EXAMPLES } from '../recipe/examples.mjs';
import { getModelConfig, setModelConfig, listModelConfigs } from './store.mjs';
import { cleanOver, applyOver, normalizeWithOver } from './overlay.mjs';
import { inputFlagsOf, startJob, getJob } from '../jobs.mjs';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const KINDS = ['image', 'video', 'speech', 'music'];

function locate(owner, key) {
  const k = parseModelKey(String(key || ''));
  if (!k) throw bad('模型键要写成「服务 id/模型 id」（list_media_models 或 studio.models 里查）');
  const provider = getProvider(k.pid, owner);
  if (!provider) {
    if (findProvider(k.pid, owner)) throw bad('这是管理员共享给你的服务，它的模型配置只有管理员能改', 403);
    throw bad('没有这个媒体服务', 404);
  }
  const entry = provider.models.find((m) => m.id === k.mid) || null;
  return { provider, entry, pid: k.pid, mid: k.mid };
}

// 卡 → 给人 / AI 看的紧凑形状（不带 normalize / wire 这些函数）
function compact(card) {
  if (!card) return null;
  return {
    paramSource: paramSourceOf(card), async: !!card.async, inputs: card.inputs || { text: true },
    params: (card.params || []).map((s) => ({
      key: s.key, label: s.label, type: s.type, ...(s.group ? { group: s.group } : {}),
      ...(Array.isArray(s.options) ? { options: s.options.map((o) => ({ value: o.value, label: o.label, ...(o.custom ? { custom: true } : {}) })) } : {}),
      ...(s.min !== undefined ? { min: s.min } : {}), ...(s.max !== undefined ? { max: s.max } : {}),
      ...(s.default !== undefined ? { default: s.default } : {}), ...(s.desc ? { desc: s.desc } : {}),
    })),
    hasExtra: (card.params || []).some((s) => s.key === 'extra'),
  };
}

const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

/** 一个模型的配置视图。模型还没加进服务时 exists:false（配方可以先试跑，存的时候带 create 加进去）。 */
export function configView(owner, key) {
  const { provider, entry, pid, mid } = locate(owner, key);
  const cfg = getModelConfig(provider.owner, pid, mid);
  return {
    key: modelKey(pid, mid), id: mid, exists: !!entry,
    ...(entry ? { kind: entry.kind, label: entry.label || mid, enabled: entry.enabled !== false } : {}),
    provider: { id: provider.id, name: provider.name, dialect: provider.dialect, host: hostOf(provider.baseUrl), managed: isManaged(provider), ...(isManaged(provider) ? { hubRef: provider.hubRef } : {}), kinds: DIALECT_KINDS[provider.dialect] || [] },
    base: entry ? compact(baseCardFor(provider, entry)) : null,
    effective: entry ? compact(cardFor(provider, entry)) : null,
    over: cfg?.over || null, recipe: cfg?.recipe || null, ...(cfg?.at ? { at: cfg.at } : {}),
    examples: RECIPE_EXAMPLES,
  };
}

/** 一个服务里哪些模型配过（列表上标「已自定义」用）：{ <模型 id>: { over?, recipe?, at } }。共享来的服务给空表。 */
export function providerConfigs(owner, pid) {
  const provider = getProvider(String(pid || ''), owner);
  if (!provider) return {};
  const out = {};
  for (const [k, v] of Object.entries(listModelConfigs(provider.owner))) {
    if (!k.startsWith(provider.id + '/')) continue;
    out[k.slice(provider.id.length + 1)] = { ...(v.over ? { over: true } : {}), ...(v.recipe ? { recipe: true } : {}), ...(v.at ? { at: v.at } : {}) };
  }
  return out;
}

/**
 * 写一个模型的配置 → { view, warnings }。
 * b = { key, over?: 对象 | null, recipe?: 对象 | null, create?: { kind, label? } }：over / recipe 不给 = 不动，给 null = 删掉。
 * create：模型还不在服务里时先加进去（只限非托管服务；托管服务的模型在模型中心加，agent 操作会替它先加好）。
 */
export function writeConfig(owner, b, { by = '' } = {}) {
  let { provider, entry, pid, mid } = locate(owner, b.key);
  const warnings = [];
  if (!entry) {
    if (!b.create) throw bad('这个服务里还没有这个模型：带上 create: { kind } 一起加进去', 404);
    if (isManaged(provider)) throw bad('这个服务由模型中心管理：先在 设置 › 模型中心 里把这个模型添加给 Media Studio，再来配', 409);
    const kind = String(b.create.kind || '');
    if (!KINDS.includes(kind)) throw bad('create.kind 只能是 ' + KINDS.join(' / '));
    if (!(DIALECT_KINDS[provider.dialect] || []).includes(kind)) throw bad(`这个服务的方言（${provider.dialect}）不能做这一类模型`);
    if (!MODEL_ID_RE.test(mid)) throw bad('模型 id 不合法');
    patchModels(pid, owner, (list) => [...list, { id: mid, kind, label: String(b.create.label || '').slice(0, 80) || mid, enabled: true, source: 'manual' }]);
    ({ provider, entry } = locate(owner, b.key));
    if (!entry) throw bad('模型没加进去', 500);
  }
  const cur = getModelConfig(provider.owner, pid, mid) || {};
  const patch = {};
  let recipe = cur.recipe || null;
  if ('recipe' in b) { recipe = normalizeRecipe(b.recipe); patch.recipe = recipe; }
  const target = recipe ? recipeCard(recipe, entry) : baseCardFor(provider, entry);
  if ('over' in b) patch.over = cleanOver(b.over, target);
  else if (cur.over && 'recipe' in b) {
    // 换了配方：原来的覆盖对着新卡还成立就留着，不成立就清掉（参数表变了）
    try { patch.over = cleanOver(cur.over, target); }
    catch (e) { patch.over = null; warnings.push('原来的参数覆盖跟新配方的参数对不上，已经清掉：' + e.message.replace(/^参数覆盖：/, '')); }
  }
  if (Object.keys(patch).length) setModelConfig(provider.owner, pid, mid, patch, { by });
  return { view: configView(owner, b.key), warnings };
}

// —— 预演 / 试跑 ——
const traces = new Map();   // 任务 id → { owner, sink }：真跑的记录，跑完还能取（只留最近 40 个）
function keepTrace(owner, id, sink) {
  traces.set(id, { owner, sink });
  if (traces.size > 40) traces.delete(traces.keys().next().value);
}
/** 真跑的记录 { job, trace, done }；不是自己的任务回 null。 */
export function trialResult(owner, jobId) {
  const t = traces.get(String(jobId || ''));
  if (!t || t.owner !== owner) return null;
  const job = getJob(owner, jobId);
  if (!job) return null;
  return { job, trace: t.sink.entries, done: ['done', 'error', 'canceled'].includes(job.state) };
}

// 预演里的素材只是占位：要看的是请求长什么样，不读真文件
const fakeInputs = (list) => (Array.isArray(list) ? list : []).slice(0, 8).filter((x) => x && typeof x.role === 'string')
  .map((x, i) => ({ role: x.role, data: Buffer.alloc(2048, i), mime: /^(audio|video)$/.test(x.role) ? (x.role === 'audio' ? 'audio/mpeg' : 'video/mp4') : 'image/png', name: `input-${i + 1}` }));

/**
 * 预演（dry:true，不发请求）或试跑（真发一次，花钱）。b = { key, dry, prompt?, negative?, params?, inputs?, recipe?（草稿；null = 不用配方）, over?（草稿；null = 不叠覆盖）, kind?（模型还没加时） }。
 * 预演回 { dry: true, params, warnings, request }；试跑回 { job }（记录用 trialResult 取）。
 */
export function trial(ctx, owner, b) {
  let { provider, entry, mid } = locate(owner, b.key);
  // recipe：不给 = 用已存的；null = 这次不用配方（界面里关掉了还没存）；对象 = 草稿
  const hasDraft = b.recipe !== undefined;
  const draftRecipe = b.recipe ? normalizeRecipe(b.recipe) : null;
  if (!entry) {
    if (!draftRecipe) throw bad('这个服务里还没有这个模型：试跑要带上草稿配方 recipe 和 kind', 404);
    const kind = String(b.kind || '');
    if (!KINDS.includes(kind)) throw bad('模型还没加进服务时要给 kind（' + KINDS.join(' / ') + '）');
    entry = { id: mid, label: mid, kind, enabled: true, source: 'manual', defaults: {} };
  }
  let card;
  if (hasDraft || b.over !== undefined) {
    const saved = getModelConfig(provider.owner, provider.id, entry.id) || {};
    const recipe = hasDraft ? draftRecipe : saved.recipe || null;
    card = recipe ? recipeCard(recipe, entry) : baseCardFor(provider, entry);
    const over = b.over !== undefined ? cleanOver(b.over, card) : saved.over;
    if (over) card = applyOver(card, over);
  } else card = cardFor(provider, entry);
  const given = b.params && typeof b.params === 'object' && !Array.isArray(b.params) ? b.params : {};

  if (b.dry) {
    const ins = fakeInputs(b.inputs);
    const { params, warnings } = normalizeWithOver(card, { ...(entry.defaults || {}), ...given }, inputFlagsOf(ins), { only: Object.keys(given) });
    const req = { kind: entry.kind, model: entry.id, card, prompt: String(b.prompt ?? '').slice(0, 12000), negative: String(b.negative ?? '').slice(0, 2000), params, inputs: ins };
    return {
      dry: true, params, warnings,
      request: card.recipe ? previewRecipe(card.recipe, req, provider, providerSecret(provider).key) : null,
      ...(card.recipe ? {} : { note: `这个模型走「${provider.dialect}」方言的内置适配器，请求在适配器里拼：预演只能看参数怎么规范化，原始请求要真跑才看得到` }),
    };
  }
  const sink = { entries: [], secrets: [providerSecret(provider).key].filter(Boolean) };
  const draft = hasDraft || b.over !== undefined || !provider.models.some((m) => m.id === entry.id);
  const { job } = startJob(ctx, { kind: entry.kind, key: modelKey(provider.id, entry.id), prompt: b.prompt, negative: b.negative, params: given, inputs: b.inputs },
    { source: 'trial', autoSave: false, trace: sink, ...(draft ? { resolved: { provider, entry, card } } : {}) });
  keepTrace(owner, job.id, sink);
  return { job };
}

