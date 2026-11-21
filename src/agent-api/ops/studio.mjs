// Media Studio（扩展）的完整操作面：查模型与参数、通用生成（模型卡上的全部参数与素材）、任务、作品、个人设置、服务管理。
// 全是 /api/studio/* 的薄封装（经进程内请求；权限、按人隔离、额度、参数按卡夹紧、托管服务拒改都在路由与任务执行器里）。
// media.* 是四个常用场景的简化版（旧 /api/vertex/* 转接）；要选别家模型、填卡上的参数、给多张素材、续改时用这一组。
// 没装扩展时 agent:studio 不成立，这组对谁都不可用。用法写在手册 studio 章：这里的说明要压短
// （手册「全部操作」按组切段，一组超过 6000 字会被截断）。

import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { internalRequest, routeError } from '../internal.mjs';
import { deliver } from './media.mjs';
import { fileFor } from '../../vertex-media.mjs';
import { agentMediaDeny, capVideoResolution } from '../../runtime/vertex-settings.mjs';
import { STUDIO_SETTINGS, STUDIO_PERSONAL_KEYS } from '../../config/studio-settings.mjs';

defineGroup('studio', 'Media Studio', '按模型卡生成媒体（全部参数、素材、续改）、任务、作品、个人设置与媒体服务管理。流程见手册 studio 章「agent 怎么操作 Media Studio」。');

const KINDS = ['image', 'video', 'speech', 'music'];
const FINAL = new Set(['done', 'error', 'canceled']);
const UUID = /^[0-9a-f-]{36}$/;
const NEED = ['agent:studio'];
// wait=true 时轮询任务的节奏（测试里改小）
export const studioPoll = { ms: 2000, totalMs: 20 * 60_000 };

const callerOf = (ctx) => (ctx && ctx.agentCaller ? String(ctx.agentCaller) : 'api');
// 生成：调用方层面的放行（设置 › Media Studio「允许的 agent」）；种类在执行时按 kind 再判
const genDeny = (ctx) => agentMediaDeny(callerOf(ctx), '');
// 服务与设置的管理：同机 agent 实例不能改，同 media.settings_set——别让 agent 自己给自己接服务、换默认
const noInstance = (ctx) => (ctx && ctx.agentCaller && ctx.agentCaller !== 'api'
  ? '同机 agent 实例不能管理 Media Studio 的服务与设置（请用户在 设置 › Media Studio 里改）' : null);

function fail(r, what) {
  const code = r.status === 403 ? 'forbidden' : r.status === 404 ? 'not_found' : r.status === 429 ? 'quota' : r.status === 400 ? 'bad_args' : r.status === 409 ? 'conflict' : 'failed';
  throw new OpError(code, what + '：' + routeError(r));
}
async function get(env, url, what) {
  const r = await internalRequest(env.identity, 'GET', url);
  if (r.status !== 200 || !r.json?.ok) fail(r, what);
  return r.json;
}
async function post(env, url, body, what, timeoutMs) {
  const r = await internalRequest(env.identity, 'POST', url, body || {}, timeoutMs ? { timeoutMs } : {});
  if (r.status !== 200 || !r.json?.ok) fail(r, what);
  return r.json;
}
const idArg = (v, what) => {
  const id = String(v || '').trim().toLowerCase();
  if (!UUID.test(id)) throw new OpError('bad_args', what + ' id 不对（36 位的 uuid）');
  return id;
};
const qs = (o) => { const s = new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '').map(([k, v]) => [k, String(v)])).toString(); return s ? '?' + s : ''; };
const clip = (s, n) => { const t = String(s || ''); return t.length > n ? t.slice(0, n) + '…' : t; };
const absUrl = (env, u) => (typeof u === 'string' && u.startsWith('/') ? (env.origin || '') + u : u);

// —— 给 agent 看的形状（去掉前端渲染用的字段）——
export function assetView(env, a, { full = false } = {}) {
  if (!a) return a;
  return {
    id: a.id, kind: a.kind, url: absUrl(env, a.url), prompt: full ? a.prompt : clip(a.prompt, 160),
    ...(a.negative ? { negative: a.negative } : {}),
    model: a.model, ...(a.providerName ? { providerName: a.providerName } : {}),
    ...(full ? { params: a.params } : {}),
    ...(a.parents?.length ? { parents: a.parents } : {}), ...(a.thread ? { thread: a.thread } : {}),
    ...(a.w ? { w: a.w, h: a.h } : {}), ...(a.duration ? { duration: a.duration } : {}),
    createdAt: a.createdAt, ...(a.wsPath ? { wsPath: a.wsPath } : {}), ...(a.source ? { source: a.source } : {}),
    ...(full && a.jobId ? { jobId: a.jobId } : {}),
  };
}
export function jobView(env, j) {
  return {
    id: j.id, kind: j.kind, key: j.key, ...(j.modelLabel ? { model: j.modelLabel } : {}), ...(j.providerName ? { providerName: j.providerName } : {}),
    state: j.state, progress: j.progress, elapsed: j.elapsed, ...(j.eta != null ? { eta: j.eta } : {}),
    prompt: clip(j.prompt, 200), ...(j.negative ? { negative: j.negative } : {}), params: j.params,
    ...(j.inputs?.length ? { inputs: j.inputs } : {}), ...(j.thread ? { thread: j.thread } : {}), ...(j.parent ? { parent: j.parent } : {}),
    createdAt: j.createdAt, finishedAt: j.finishedAt,
    result: (j.result || []).map((a) => ({ id: a.id, kind: a.kind, url: absUrl(env, a.url), ...(a.thread ? { thread: a.thread } : {}), ...(a.wsPath ? { wsPath: a.wsPath } : {}) })),
    ...(j.error ? { error: j.error } : {}), ...(j.note ? { note: j.note } : {}), source: j.source, ...(j.uncancelable ? { uncancelable: true } : {}),
  };
}

// 模型卡参数 → { key, type, label?, options（取值列表，去掉被上游拒收过的）, min, max, default, when, unit, custom }
const MAX_OPTIONS = 60;
export function compactParam(s) {
  const opts = Array.isArray(s.options) ? s.options.filter((o) => o && !o.rejected).map((o) => o.value) : null;
  return {
    key: s.key, type: s.type, ...(s.label && s.label !== s.key ? { label: s.label } : {}),
    ...(opts ? { options: opts.slice(0, MAX_OPTIONS), ...(opts.length > MAX_OPTIONS ? { moreOptions: opts.length - MAX_OPTIONS } : {}) } : {}),
    ...(s.min != null ? { min: s.min } : {}), ...(s.max != null ? { max: s.max } : {}),
    ...(s.default !== undefined ? { default: s.default } : {}), ...(s.when ? { when: s.when } : {}),
    ...(s.unit ? { unit: s.unit } : {}), ...(s.type === 'size' && s.custom ? { custom: true } : {}),
  };
}
// 模型卡的 inputs → 能收的素材角色与张数（images.roles：edit / ref / first / last；audio / video：收不收该类素材）
export function compactInputs(i) {
  if (!i || typeof i !== 'object') return {};
  return {
    ...(i.images && Array.isArray(i.images.roles) && i.images.roles.length ? { images: { roles: i.images.roles, max: i.images.max } } : {}),
    ...(i.audio ? { audio: i.audio } : {}), ...(i.video ? { video: i.video } : {}),
    ...(i.negative ? { negative: true } : {}), ...(i.multiTurn ? { multiTurn: true } : {}),
  };
}
export function compactModel(m, providerName, isDefault) {
  return {
    key: m.key, label: m.label, provider: providerName, ...(isDefault ? { default: true } : {}),
    inputs: compactInputs(m.inputs), params: (m.params || []).map(compactParam),
    ...(m.priceHint ? { priceHint: m.priceHint } : {}), ...(m.generic ? { generic: true } : {}), ...(m.isNew ? { isNew: true } : {}),
  };
}
const MAX_SHELF = 40;
/** GET /api/studio/catalog 的 kinds → 紧凑目录；q 按名字 / id 过滤（不分大小写）。 */
export function compactCatalog(kinds, { kind = '', q = '' } = {}) {
  const needle = String(q || '').trim().toLowerCase();
  const hit = (m) => !needle || [m.key, m.id, m.label].some((s) => String(s || '').toLowerCase().includes(needle));
  const out = {};
  for (const k of kind ? [kind] : KINDS) {
    const c = kinds?.[k];
    if (!c) continue;
    const def = c.defaults ? c.defaults.provider + '/' + c.defaults.model : null;
    const models = [], shelf = [];
    for (const g of c.groups || []) {
      for (const m of g.models || []) if (hit(m)) models.push(compactModel(m, g.provider?.name, m.key === def));
      for (const m of g.shelf || []) if (hit(m)) shelf.push({ key: m.key, label: m.label });
    }
    out[k] = {
      default: def, models,
      ...(shelf.length ? { shelf: shelf.slice(0, MAX_SHELF), ...(shelf.length > MAX_SHELF ? { moreShelf: shelf.length - MAX_SHELF } : {}) } : {}),
    };
  }
  return out;
}

// 服务：请求头与额外请求体只回键名（里面可能放着令牌）；Key 只有 hasKey 与末 4 位（路由本来就只给这两样）
export function providerView(p, { models = false } = {}) {
  const ms = Array.isArray(p.models) ? p.models : [];
  const byKind = {};
  for (const m of ms) if (m.enabled && !m.shelf && !m.gone) byKind[m.kind] = (byKind[m.kind] || 0) + 1;
  return {
    id: p.id, name: p.name, ...(p.note ? { note: p.note } : {}), preset: p.preset, dialect: p.dialect,
    enabled: p.enabled, shared: !!p.shared, autoSync: p.autoSync !== false,
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), ...(p.authStyle ? { authStyle: p.authStyle } : {}),
    hasKey: !!p.hasKey, ...(p.keyTail ? { keyTail: p.keyTail } : {}),
    ...(p.headers && Object.keys(p.headers).length ? { headerNames: Object.keys(p.headers) } : {}),
    ...(p.params && Object.keys(p.params).length ? { extraBodyKeys: Object.keys(p.params) } : {}),
    timeoutSec: p.timeoutSec, retries: p.retries,
    ...(p.google ? { google: p.google } : {}),
    ...(p.dialect === 'vertex' ? { hasServiceAccount: !!p.hasServiceAccount, ...(p.saEmail ? { saEmail: p.saEmail } : {}), ...(p.saProject ? { saProject: p.saProject } : {}) } : {}),
    ...(p.managed ? { managed: true, hubRef: p.hubRef } : {}),
    ...(p.sync ? { sync: p.sync } : {}),
    modelCount: { total: ms.length, enabled: byKind, shelf: ms.filter((m) => m.shelf).length, gone: ms.filter((m) => m.gone).length },
    ...(models ? { models: ms.map((m) => ({ id: m.id, label: m.label, kind: m.kind, enabled: m.enabled, source: m.source, ...(m.shelf ? { shelf: true } : {}), ...(m.gone ? { gone: true } : {}), ...(m.defaults && Object.keys(m.defaults).length ? { defaults: m.defaults } : {}) })) } : {}),
  };
}

// ———————————————— 只读 ————————————————

defineOp({
  name: 'studio.models', title: '查媒体模型与参数',
  desc: '生成前选模型、看参数。不给 key：按种类列能用的模型——key（填 studio.generate 的 model）、provider、default、'
    + 'inputs（images.roles：edit 改图 / ref 参考图 / first 首帧 / last 尾帧，max 张数；audio / video / negative 收不收）、'
    + 'params（key、options、min / max、default；when = 别的参数取某值时才生效，$edit 等指有没有对应素材）、priceHint；'
    + 'shelf 是备选模型（只有 key + label）。给 key（<服务 id>/<模型 id>）：该模型完整条目，配音模型带 voices。',
  need: NEED,
  params: {
    kind: { type: 'string', enum: KINDS },
    key: { type: 'string', max: 300, desc: '只看这一个模型' },
    q: { type: 'string', max: 100, desc: '按名字 / id 过滤' },
  },
  handler: async (ctx, args, env) => {
    if (args.key) {
      const { model } = await get(env, '/api/studio/models/resolve' + qs({ key: args.key }), '查模型');
      if (model.kind !== 'speech') return { model };
      const v = await internalRequest(env.identity, 'GET', '/api/studio/voices' + qs({ key: args.key }));
      return { model, ...(v.status === 200 && v.json?.ok ? { voices: v.json.voices } : { voicesError: routeError(v) }) };
    }
    const cat = await get(env, '/api/studio/catalog', '读模型目录');
    return { kinds: compactCatalog(cat.kinds, { kind: args.kind, q: args.q }) };
  },
});

defineOp({
  name: 'studio.jobs', title: '列生成任务',
  desc: '进行中的 + 最近 50 条，新的在前；state = queued / running / done / error / canceled，done 的 result 是作品。',
  need: NEED,
  params: { active: { type: 'boolean', desc: '只列进行中的' } },
  handler: async (ctx, args, env) => {
    const r = await get(env, '/api/studio/jobs' + (args.active ? '?active=1' : ''), '读任务列表');
    return { jobs: (args.active ? r.active || [] : r.jobs || []).map((j) => jobView(env, j)) };
  },
});

defineOp({
  name: 'studio.job', title: '看一个生成任务',
  desc: '状态、进度（progress 0–1、elapsed / eta 秒）、实际参数与结果。',
  need: NEED,
  params: { id: { type: 'string', required: true } },
  handler: async (ctx, args, env) => ({ job: jobView(env, (await get(env, '/api/studio/jobs/' + idArg(args.id, '任务'), '查任务')).job) }),
});

defineOp({
  name: 'studio.assets', title: '列作品',
  desc: '媒体库里的作品（谁生成的都在），新的在前。返回 items 与 cursor（有下一页时原样传回）。thread = 一条续改链。',
  need: NEED,
  params: {
    kind: { type: 'string', enum: KINDS },
    q: { type: 'string', max: 200, desc: '搜提示词或模型名' },
    thread: { type: 'string', max: 80 },
    cursor: { type: 'string', max: 120 },
    limit: { type: 'integer', min: 1, max: 200, desc: '默认 60' },
  },
  handler: async (ctx, args, env) => {
    const r = await get(env, '/api/studio/assets' + qs(args), '读作品列表');
    return { items: (r.items || []).map((a) => assetView(env, a)), cursor: r.cursor || null };
  },
});

defineOp({
  name: 'studio.asset', title: '看一件作品',
  desc: '完整信息：提示词、模型、实际参数、血缘（parents / thread）、wsPath，与服务器上的文件路径 serverPath。',
  need: NEED,
  params: { id: { type: 'string', required: true } },
  handler: async (ctx, args, env) => {
    const id = idArg(args.id, '作品');
    const { asset } = await get(env, '/api/studio/assets/' + id, '查作品');
    const file = fileFor(id, ctx.media);
    return { asset: { ...assetView(env, asset, { full: true }), ...(file ? { serverPath: file } : {}) } };
  },
});

defineOp({
  name: 'studio.providers', title: '列媒体服务',
  desc: '自己的媒体服务与可用预设，不含密钥（Key 只有末 4 位，请求头与额外请求体只给键名）；成员另有 sharedFromAdmin。给 id 只看这一个、带全部模型条目。',
  need: NEED,
  params: { id: { type: 'string', max: 40 } },
  handler: async (ctx, args, env) => {
    const r = await get(env, '/api/studio/providers', '读媒体服务');
    if (args.id) {
      const p = (r.providers || []).find((x) => x.id === args.id);
      if (!p) throw new OpError('not_found', '没有这个媒体服务：' + args.id);
      return { provider: providerView(p, { models: true }) };
    }
    return {
      providers: (r.providers || []).map((p) => providerView(p)),
      presets: (r.presets || []).map((p) => ({ id: p.id, name: p.name, dialect: p.dialect, ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}), ...(p.note ? { note: p.note } : {}) })),
      ...(r.member ? { member: true, maxProviders: r.maxProviders } : {}),
      ...(Array.isArray(r.shared) && r.shared.length ? { sharedFromAdmin: r.shared.map((s) => ({ id: s.id, name: s.name, dialect: s.dialect, enabled: s.enabled, models: s.models })) } : {}),
      ...(r.vertexImport ? { vertexImport: r.vertexImport } : {}),
    };
  },
});

defineOp({
  name: 'studio.provider_log', title: '看媒体服务的调用日志',
  desc: '最近 50 次调用的时间、模型、状态、耗时、错误原因；排查生成失败用。',
  need: NEED,
  params: { id: { type: 'string', required: true, max: 40 } },
  handler: async (ctx, args, env) => ({ log: (await get(env, '/api/studio/providers/log' + qs({ id: args.id }), '读调用日志')).log }),
});

const sxDesc = (keys) => STUDIO_SETTINGS.filter((d) => keys.includes(d.key)).map((d) => ({ key: d.key, label: d.label, type: d.type, ...(d.desc ? { desc: d.desc } : {}), default: d.default }));

defineOp({
  name: 'studio.my_settings', title: '看我的 Media Studio 设置',
  desc: '个人级：defaults（各种媒体的默认 { provider, model }）、autoSave / saveDir（Studio 页面里生成的自动存到哪）。changed = 自己改过的键，其余跟主机。',
  need: NEED,
  handler: async (ctx, args, env) => {
    const r = await get(env, '/api/studio/settings', '读 Media Studio 设置');
    return { values: r.mine?.values || {}, changed: r.mine?.changed || [], items: sxDesc(STUDIO_PERSONAL_KEYS) };
  },
});

// ———————————————— 生成与任务 ————————————————

defineOp({
  name: 'studio.generate', title: '按模型卡生成媒体',
  desc: '先用 studio.models 选模型、看 params 与 inputs。params 按卡规范化（实际值见 job.params）；inputs 每项 { role, asset（作品 id）| path（工作空间）| upload }。'
    + '续改：thread = 那件作品的 thread（没有用它的 id），parent = 它的 id。wait（默认）等结果，最多 20 分钟，返回 job 与 results（url、serverPath、savedTo）；'
    + '超时回 timedOut，再用 studio.job 查。花钱：视频、音乐或用户没明确要的先征得同意。',
  access: 'write', slow: true, need: NEED, deny: genDeny,
  params: {
    kind: { type: 'string', required: true, enum: KINDS },
    model: { type: 'string', desc: 'studio.models 的 key，或内置模型裸 id；不填用默认' },
    prompt: { type: 'string', max: 12000, desc: '描述 / 要读的文字（只有给了素材的图像、视频可空）' },
    negative: { type: 'string', max: 2000 },
    params: { type: 'object', desc: '{ 参数 key: 值 }' },
    inputs: { type: 'array', desc: '[{ role: edit|ref|first|last|audio|video, asset|path|upload }]' },
    thread: { type: 'string', max: 80 },
    parent: { type: 'string', max: 80 },
    wait: { type: 'boolean', default: true },
    saveTo: { type: 'string', desc: '复制进工作空间的路径（/ 结尾 = 文件夹）；不给就不存' },
  },
  example: { kind: 'image', model: 'p-1a2b3c4d/openai/gpt-image-2.5-sunburst', prompt: '雨夜的外滩', params: { quality: 'high' } },
  handler: async (ctx, args, env) => {
    const why = agentMediaDeny(callerOf(ctx), args.kind);
    if (why) throw new OpError('forbidden', why);
    const params = { ...(args.params || {}) };
    if (args.kind === 'video' && params.resolution) params.resolution = capVideoResolution(params.resolution);   // 管理员的分辨率上限
    const inputs = args.inputs || [];
    for (const [i, x] of inputs.entries()) {
      if (!x || typeof x !== 'object' || Array.isArray(x) || typeof x.role !== 'string') {
        throw new OpError('bad_args', `inputs[${i}] 要是 { role, asset | path | upload }`, { hint: '例：[{ "role": "edit", "asset": "<作品 id>" }]' });
      }
    }
    const body = {
      kind: args.kind, prompt: args.prompt || '', source: 'api',
      ...(args.model ? { key: args.model } : {}), ...(args.negative ? { negative: args.negative } : {}),
      params, inputs, ...(args.thread ? { thread: args.thread } : {}), ...(args.parent ? { parent: args.parent } : {}),
    };
    let { job } = await post(env, '/api/studio/jobs', body, '发起生成');
    if (!args.wait) return { job: jobView(env, job), note: '任务在服务端跑：用 studio.job 查进度，studio.job_cancel 取消' };
    const t0 = Date.now();
    while (!FINAL.has(job.state)) {
      if (Date.now() - t0 > studioPoll.totalMs || env.signal?.aborted) {
        return { job: jobView(env, job), timedOut: true, note: '还没跑完（任务照常在服务端跑）：用 studio.job 接着查' };
      }
      await new Promise((r) => setTimeout(r, studioPoll.ms));
      const r = await internalRequest(env.identity, 'GET', '/api/studio/jobs/' + job.id);
      if (r.status === 200 && r.json?.ok) job = r.json.job;
      else if (r.status === 404) throw new OpError('failed', '任务记录不见了（服务可能重启了）');
    }
    if (job.state !== 'done') {
      throw new OpError('failed', job.state === 'canceled' ? '任务已取消' + (job.note ? '（' + job.note + '）' : '') : '生成失败：' + (job.error || job.note || '没有结果'), { data: { job: jobView(env, job) } });
    }
    return { job: jobView(env, job), results: (job.result || []).map((a) => ({ ...deliver(ctx, env, a.id, a.kind, args.saveTo), ...(a.thread ? { thread: a.thread } : {}) })) };
  },
});

defineOp({
  name: 'studio.job_cancel', title: '取消生成任务',
  desc: '尽力而为：没发出去的直接停；发出去收不回的标「已放弃（仍可能计费）」。',
  access: 'write', need: NEED,
  params: { id: { type: 'string', required: true } },
  handler: async (ctx, args, env) => ({ job: jobView(env, (await post(env, '/api/studio/jobs/' + idArg(args.id, '任务') + '/cancel', {}, '取消任务')).job) }),
});

// ———————————————— 作品 ————————————————

defineOp({
  name: 'studio.asset_save', title: '把作品存进工作空间',
  desc: '复制一份进工作空间，返回 wsPath。dir 不给用个人设置的保存位置；重名自动加序号。',
  access: 'write', need: NEED,
  params: {
    id: { type: 'string', required: true },
    dir: { type: 'string', max: 400 },
    name: { type: 'string', max: 200 },
  },
  handler: async (ctx, args, env) => {
    const r = await post(env, '/api/studio/assets/' + idArg(args.id, '作品') + '/save', { dir: args.dir, name: args.name }, '存进工作空间');
    return { wsPath: r.wsPath, asset: assetView(env, r.asset) };
  },
});

defineOp({
  name: 'studio.asset_delete', title: '删除作品',
  desc: '从媒体库删掉（不可撤回，先征得同意）；withFile 连工作空间里的副本（wsPath）一起删。',
  access: 'danger', need: NEED,
  params: {
    id: { type: 'string', required: true },
    withFile: { type: 'boolean' },
  },
  handler: async (ctx, args, env) => {
    const id = idArg(args.id, '作品');
    await post(env, '/api/studio/assets/' + id + '/delete', { withFile: args.withFile === true }, '删除作品');
    return { deleted: id };
  },
});

// ———————————————— 个人设置 ————————————————

defineOp({
  name: 'studio.my_settings_set', title: '改我的 Media Studio 设置',
  desc: '可改 defaults（{ image: { provider, model }, … }）、autoSave、saveDir；null = 恢复跟主机，任一项不合法整批不改。只在用户要你改时改。',
  access: 'write', need: NEED, deny: noInstance,
  params: { values: { type: 'object', required: true, desc: '{ key: 新值 }' } },
  handler: async (ctx, args, env) => {
    const keys = Object.keys(args.values);
    if (!keys.length) throw new OpError('bad_args', 'values 是空的', { hint: '例：{ "autoSave": false }' });
    const bad = keys.filter((k) => !STUDIO_PERSONAL_KEYS.includes(k));
    if (bad.length) throw new OpError('bad_args', '个人设置里没有：' + bad.join('、'), { hint: '能改的：' + STUDIO_PERSONAL_KEYS.join('、') + '（主机级开关用 media.settings_set）' });
    const before = await get(env, '/api/studio/settings', '读 Media Studio 设置');
    const r = await post(env, '/api/studio/settings', { scope: 'mine', values: args.values }, '修改 Media Studio 设置');
    const was = before.mine?.values || {}, now = r.mine?.values || {};
    const changed = keys.filter((k) => JSON.stringify(was[k]) !== JSON.stringify(now[k])).map((k) => ({ key: k, from: was[k], to: now[k] }));
    return { changed, ...(changed.length ? {} : { note: '值和原来一样，没有改动' }) };
  },
});

// ———————————————— 服务管理 ————————————————

const SECRET_RULE = 'apiKey / serviceAccount 只用用户在对话里明确给的，填前先确认；返回里没有密钥。';
const MANAGED_RULE = '模型中心托管的（managed）改不了，照实转告。';
const DRAFT = { type: 'object', desc: '未保存的草稿（字段同 provider_create）' };

defineOp({
  name: 'studio.provider_create', title: '新建媒体服务',
  desc: 'preset 见 studio.providers 的 presets；官方预设不给 baseUrl / models 时用预设自带的。models = [{ id, kind, label? }]，可先用 provider_models 带 draft 拉。建完用 provider_test 测。'
    + SECRET_RULE,
  access: 'write', need: NEED, deny: noInstance,
  params: {
    preset: { type: 'string', max: 24 },
    dialect: { type: 'string', max: 24 },
    name: { type: 'string', max: 40 },
    note: { type: 'string', max: 80 },
    baseUrl: { type: 'string', max: 500 },
    apiKey: { type: 'string', max: 4000 },
    serviceAccount: { type: 'string', max: 20000, desc: 'Vertex 服务账号 JSON' },
    authStyle: { type: 'string', max: 40 },
    headers: { type: 'object' },
    params: { type: 'object', desc: '额外请求体' },
    google: { type: 'object', desc: '{ project, location, mediaLocation, credMode: adc|json }' },
    models: { type: 'array' },
    enabled: { type: 'boolean', default: true },
    shared: { type: 'boolean' },
    autoSync: { type: 'boolean' },
    timeoutSec: { type: 'integer', min: 10, max: 3600 },
    retries: { type: 'integer', min: 0, max: 5 },
  },
  handler: async (ctx, args, env) => {
    const input = { ...args };
    if (input.preset && (!input.models || !input.baseUrl)) {
      const r = await get(env, '/api/studio/providers', '读预设');
      const pre = (r.presets || []).find((p) => p.id === input.preset);
      if (!pre) throw new OpError('bad_args', '没有这个预设：' + input.preset, { hint: '可用：' + (r.presets || []).map((p) => p.id).join('、') });
      if (!input.models && Array.isArray(pre.models)) input.models = pre.models.map(({ id, kind, label }) => ({ id, kind, label, source: 'builtin' }));
      if (!input.baseUrl && pre.baseUrl) input.baseUrl = pre.baseUrl;
      if (!input.authStyle && pre.authStyle) input.authStyle = pre.authStyle;
      if (!input.dialect) input.dialect = pre.dialect;
      if (!input.name) input.name = pre.name;
    }
    const r = await post(env, '/api/studio/providers/create', input, '新建媒体服务');
    return { provider: providerView(r.provider, { models: true }) };
  },
});

defineOp({
  name: 'studio.provider_update', title: '改媒体服务',
  desc: 'patch 字段同 provider_create；apiKey 空串 = 清掉；patch.models 整表替换（先用 studio.providers 带 id 取现有的）。' + SECRET_RULE + MANAGED_RULE,
  access: 'write', need: NEED, deny: noInstance,
  params: {
    id: { type: 'string', required: true, max: 40 },
    patch: { type: 'object', required: true },
  },
  handler: async (ctx, args, env) => {
    const r = await post(env, '/api/studio/providers/update', { id: args.id, patch: args.patch }, '修改媒体服务');
    return { provider: providerView(r.provider, { models: true }) };
  },
});

defineOp({
  name: 'studio.provider_delete', title: '删除媒体服务',
  desc: '连 Key 与日志一起删（不可撤回，作品不受影响），先征得同意。' + MANAGED_RULE,
  access: 'danger', need: NEED, deny: noInstance,
  params: { id: { type: 'string', required: true, max: 40 } },
  handler: async (ctx, args, env) => {
    await post(env, '/api/studio/providers/delete', { id: args.id }, '删除媒体服务');
    return { deleted: args.id };
  },
});

defineOp({
  name: 'studio.provider_test', title: '测试媒体服务的连接',
  desc: '只调只读接口、不花钱。给 id 或 draft；返回 result: { ok, ms, error? }。',
  access: 'write', slow: true, need: NEED, deny: noInstance,
  params: {
    id: { type: 'string', max: 40 },
    draft: DRAFT,
    model: { type: 'string', max: 200 },
  },
  handler: async (ctx, args, env) => {
    if (!args.id && !args.draft) throw new OpError('bad_args', 'id 与 draft 至少给一个');
    const r = await post(env, '/api/studio/providers/test', { ...(args.id ? { id: args.id } : {}), ...(args.draft ? { draft: args.draft } : {}), ...(args.model ? { model: args.model } : {}) }, '测试连接', 90_000);
    return { result: r.result };
  },
});

const MAX_REMOTE = 200;
defineOp({
  name: 'studio.provider_models', title: '拉媒体服务的模型列表',
  desc: '向服务方要模型清单（不花钱），有模型卡的排前面；给 id 或 draft，最多回 200 条。挑好的用 provider_update 的 patch.models 加进去。',
  access: 'write', slow: true, need: NEED, deny: noInstance,
  params: {
    id: { type: 'string', max: 40 },
    draft: DRAFT,
    kind: { type: 'string', enum: KINDS },
    q: { type: 'string', max: 100 },
  },
  handler: async (ctx, args, env) => {
    if (!args.id && !args.draft) throw new OpError('bad_args', 'id 与 draft 至少给一个');
    const r = await post(env, '/api/studio/providers/models', { ...(args.id ? { id: args.id } : {}), ...(args.draft ? { draft: args.draft } : {}) }, '拉模型列表', 90_000);
    const needle = String(args.q || '').toLowerCase();
    // 服务方没标种类的（kind 为 null）也留着
    const list = (r.models || []).filter((m) => (!args.kind || !m.kind || m.kind === args.kind) && (!needle || String(m.id).toLowerCase().includes(needle) || String(m.label || '').toLowerCase().includes(needle)));
    return { total: list.length, models: list.slice(0, MAX_REMOTE).map((m) => ({ id: m.id, label: m.label, kind: m.kind })) };
  },
});

defineOp({
  name: 'studio.provider_sync', title: '立即检查新模型',
  desc: '按服务方清单发现新模型、标出下架的（不花钱）。不给 id = 自己全部能发现的服务。',
  access: 'write', slow: true, need: NEED, deny: noInstance,
  params: { id: { type: 'string', max: 40 } },
  handler: async (ctx, args, env) => {
    const r = await post(env, '/api/studio/providers/sync', args.id ? { id: args.id } : {}, '检查新模型', 180_000);
    return { results: r.results, providers: (r.providers || []).map((p) => providerView(p)) };
  },
});

defineOp({
  name: 'studio.import_vertex', title: '从主机的 Google 凭据导入媒体服务',
  desc: '把主机的 Google 凭据、Gemini / OpenRouter Key、本机图像模型变成共享服务；可重复执行（就地更新）。',
  access: 'write', need: ['agent:studio', 'server.manage'], deny: noInstance,
  handler: async (ctx, args, env) => {
    const r = await post(env, '/api/studio/providers/import-vertex', {}, '导入 Vertex', 90_000);
    return { items: r.items, importedAt: r.importedAt };
  },
});
