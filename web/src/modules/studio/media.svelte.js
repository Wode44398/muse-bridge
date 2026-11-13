// Media Studio 的状态与控制器（原 Vertex 媒体控制器 vertexMedia 改写：四套各自的同步 POST / SSE 流
// 换成统一的生成任务 /api/studio/jobs + 总线 studio.job）。
//
// 任务跑在服务端、跟页面无关（§3.3）：这里只是镜像。进 Studio、回到前台、总线重连时 GET /jobs 对账；
// 总线事件只做增量。四个创作页的草稿（模型、参数、素材、parent、thread）各存一份，切页、切模型都不丢。
import { busOn } from '../../lib/bus.js';
import { vertexMediaUrl } from '../../lib/preview.svelte.js';
import { mediaUrl } from '../../lib/server.js';
import { getToken } from '../../lib/api.js';
import { t, tc, tr } from '../../lib/i18n.js';
import { studioApi, onFixtureEvent } from './api.js';
import { PAGES, catKind, pageOf, splitKey, uploadRel } from './kinds.js';
import { resolveValues, payloadParams, roleState } from './params.js';

const newDraft = () => ({ model: '', params: {}, inputs: [], parent: null, negative: '' });
const LS_SIDE = 'studio-side';

// 作品栏宽：dimensio 侧栏 272，可拖 240–400；dock＝参数坞（宽屏才有）开没开
function readSide() {
  try { const o = JSON.parse(localStorage.getItem(LS_SIDE) || '{}'); return { width: Math.min(400, Math.max(240, Number(o.width) || 272)), pinned: o.pinned !== false, tab: o.tab === 'files' ? 'files' : 'works', dock: o.dock !== false }; }
  catch { return { width: 272, pinned: true, tab: 'works', dock: true }; }
}
// 新发现的模型（isNew）本机选过一次就不再冒朱点（后端要等这个人真用它跑过任务才知道）
const LS_SEEN = 'studio-seen-models';
function readSeen() { try { return new Set(JSON.parse(localStorage.getItem(LS_SEEN) || '[]')); } catch { return new Set(); } }

export const studio = $state({
  page: 'image',
  catalog: null, catalogErr: '', catalogLoading: false,
  saveDir: 'Media Studio',
  drafts: { image: newDraft(), video: newDraft(), voice: newDraft(), music: newDraft() },
  // 画布：图像是当前续改链（turns），其余三页是「正在看的那一件」（任务或作品）
  views: { image: { thread: null, turns: [] }, video: { focus: null }, voice: { focus: null }, music: { focus: null } },
  jobs: [],
  assets: [], cursor: null, assetsLoading: false, assetsErr: '', assetsDone: false,
  filter: 'all', q: '',
  side: readSide(),          // 侧栏：width / pinned（桌面常驻、平板推入）/ tab
  drawer: false,             // 手机抽屉、平板推入的开合
  unseen: 0,                 // 完成了还没看的任务数（任务胶囊上的小点）
  flash: '',                 // 侧栏里要闪一下的作品 id
  clock: Date.now(),         // 进行中任务的计时（1s 一跳，只在有进行中任务时跑）
  notice: '',                // 输入岛下方的一次性提示（「已换到 X：它支持首帧」）
  filesTarget: null,         // { dir, open, seq }：侧栏「文件」要定位到的目录（作品菜单「在文件中显示」）
  pendingText: null,         // { page, text }：要填进某页输入岛的正文（文本文件拖入 / 发到 Studio），页面消费后清空
  resolved: {},              // 备选（shelf）模型按需取回的完整 ResolvedModel：{ [key]: model }（§9.3 /models/resolve）
  resolving: '',             // 正在取的 shelf 模型 key
  seen: readSeen(),          // 本机选过的新模型 key（不再冒朱点）
});

export function saveSide() {
  try { localStorage.setItem(LS_SIDE, JSON.stringify({ width: studio.side.width, pinned: studio.side.pinned, tab: studio.side.tab, dock: studio.side.dock })); } catch {}
}

// —— 媒体地址 ——
// 作品的 url 是规范地址 /api/vertex/media?id=…（§3.4），<img>/<video> 跨源带不了头，按 id 拼带 token 的完整地址；
// v='thumb'（320px）/'preview'（1280px）是服务端衍生图，手机性能纪律：内联展示一律走衍生档。
export function mediaSrc(a, v) {
  if (!a) return '';
  const u = String((v === 'thumb' && a.thumb) || a.url || '');
  if (/^(data|blob):/.test(u)) return u;
  if (a.id && (!u || u.startsWith('/api/vertex/media'))) return vertexMediaUrl(a.id, v);
  if (!u) return '';
  const tok = getToken();
  return /^https?:/.test(u) ? u : mediaUrl(u) + (tok && u.startsWith('/api/') ? (u.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(tok) : '');
}
/** 桌面壳拖出成文件（dragOut 来源对象） */
export function assetDragSrc(a) {
  if (!a?.id) return null;
  const base = String(a.prompt || '').replace(/[\\/:*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return { url: mediaSrc(a), name: base || 'studio-' + a.id };
}

const ts = (x) => (typeof x === 'number' ? x : Date.parse(x) || 0);
export const isActive = (j) => j && (j.state === 'queued' || j.state === 'running');

// —— 目录 ——
export async function loadCatalog() {
  studio.catalogLoading = true;
  try { const c = await studioApi.catalog(); studio.catalog = c; studio.catalogErr = ''; }
  catch (e) { studio.catalogErr = e.status === 401 ? t('需要登录') : tr(e.message || '') || t('模型目录加载失败'); }
  finally { studio.catalogLoading = false; }
}
export const kindBlock = (page) => studio.catalog?.kinds?.[catKind(page)] || null;
export function groupsOf(page) { return kindBlock(page)?.groups || []; }
/** 这一页可用的模型：各服务的主列表 + 已经按需取回的备选（shelf）模型；gone（上游不再列出）的不算 */
export function modelsOf(page) {
  const out = [];
  for (const g of groupsOf(page)) {
    for (const m of [...(g.models || []), ...(g.shelf || [])]) {
      if (m.gone) continue;
      if (m.shelf) { const full = studio.resolved[m.key]; if (full) out.push({ ...full, shelf: true, provider: g.provider }); continue; }
      out.push({ ...m, provider: g.provider });
    }
  }
  return out;
}
/** 选模型：备选模型先按需取回完整卡（参数、inputs）再选；新模型选过就不再冒朱点 */
export async function pickModel(page, m) {
  if (!m?.key) return false;
  if (m.isNew && !studio.seen.has(m.key)) {
    studio.seen = new Set([...studio.seen, m.key]);
    try { localStorage.setItem(LS_SEEN, JSON.stringify([...studio.seen].slice(-300))); } catch {}
  }
  if (m.shelf && !studio.resolved[m.key]) {
    studio.resolving = m.key;
    try {
      const r = await studioApi.resolve(m.key);
      const full = r?.model || r;
      if (!full?.key) throw new Error('');
      studio.resolved = { ...studio.resolved, [m.key]: full };
    } catch {
      if (studio.resolving === m.key) studio.resolving = '';
      studio.notice = t('{model} 暂时取不到参数', { model: tr(m.label || m.id) });
      return false;
    }
    if (studio.resolving !== m.key) return false;   // 期间又选了别的
    studio.resolving = '';
  }
  setModel(page, m.key);
  return true;
}
export function findModel(key) {
  for (const page of PAGES) { const m = modelsOf(page).find((x) => x.key === key); if (m) return m; }
  return null;
}
/** 作品 / 任务的模型显示名：先按「服务/模型」找；旧作品的 provider 是方言名（vertex）对不上，再按裸模型 id 在目录里找；
 *  都找不到就用裸 id（去掉 openai/ 这类服务前缀）。界面上一律显示名，id 只在右栏模型行里出现。 */
export function modelLabelOf(a) {
  const id = String(a?.model || '');
  // 两边都去掉厂商前缀再比：作品里记的常是「gpt-image-2.6-sunburst」，目录里是「openai/gpt-image-2.6-sunburst」
  const bare = (s) => String(s || '').replace(/^[\w.-]+\//, '');
  const all = PAGES.flatMap((p) => modelsOf(p));
  const m = findModel((a?.provider ? a.provider + '/' : '') + id)
    || all.find((x) => x.id === id) || all.find((x) => bare(x.id) === bare(id));
  return tr(m?.label || '') || bare(id);
}
/** 目录里某个模型 id 的显示名（参数来源行「沿用 X」用；认不出就回 id） */
export function labelForId(id) {
  for (const blk of Object.values(studio.catalog?.kinds || {})) for (const g of blk.groups || []) for (const m of g.models || []) if (m.id === id) return tr(m.label || m.id);
  return id;
}
/** 这一页当前用的模型：草稿里选过且还在目录里 → 它；否则目录默认；再否则第一个 */
export function currentModel(page) {
  const list = modelsOf(page);
  if (!list.length) return null;
  const d = studio.drafts[page];
  const pick = d.model && list.find((m) => m.key === d.model);
  if (pick) return pick;
  const def = kindBlock(page)?.defaults;
  return (def && list.find((m) => m.key === def.provider + '/' + def.model)) || list[0];
}
export function setModel(page, key) {
  studio.drafts[page].model = key;
}
/** 这一页参数的有效取值（ParamSpec 结算后） */
export function valuesOf(page, model = currentModel(page)) {
  return resolveValues(model?.params || [], studio.drafts[page].params, model?.id || '');
}
export function setParam(page, key, value) { studio.drafts[page].params[key] = value; }

// —— 素材（输入岛里挂着的）——
let seq = 0;
/** input: { role, asset?, path?, upload?, url, name, kind, pending?, fromAsset? } */
export function addInput(page, input) {
  const d = studio.drafts[page];
  const single = input.role === 'first' || input.role === 'last' || input.role === 'edit';
  if (single) d.inputs = d.inputs.filter((x) => x.role !== input.role);
  d.inputs.push({ id: 'in' + ++seq, pending: false, ...input });
  return d.inputs[d.inputs.length - 1];   // 返回代理过的那一份（Svelte5：别改原字面量）
}
export function removeInput(page, id) {
  const d = studio.drafts[page];
  const it = d.inputs.find((x) => x.id === id);
  d.inputs = d.inputs.filter((x) => x.id !== id);
  if (it?.url?.startsWith('blob:')) URL.revokeObjectURL(it.url);
  // 血缘是跟着这份素材来的：素材拿掉了、也没有别的素材来自同一件作品，就不再记 parent
  if (it?.fromAsset && d.parent?.id === it.fromAsset && !d.inputs.some((x) => x.fromAsset === it.fromAsset)) d.parent = null;
}
export function swapFrames(page) {
  for (const x of studio.drafts[page].inputs) {
    if (x.role === 'first') x.role = 'last';
    else if (x.role === 'last') x.role = 'first';
  }
}
export const clearParent = (page) => { studio.drafts[page].parent = null; };

/** 角色在当前模型下能不能放（落点托盘、＋菜单、接着做共用） */
export function roleOk(page, role, model = currentModel(page)) {
  return roleState(model, role, studio.drafts[page].inputs);
}
/** 当前模型接不了这个角色时，在目录里找第一个接得了的（接着做 / 发到 Studio 用） */
export function modelForRole(page, role) {
  const cur = currentModel(page);
  if (!role || roleState(cur, role, studio.drafts[page].inputs).ok) return cur;
  return modelsOf(page).find((m) => roleState(m, role, studio.drafts[page].inputs).ok) || null;
}
function ensureRole(page, role) {
  const cur = currentModel(page);
  const m = modelForRole(page, role);
  if (m && cur && m.key !== cur.key) {
    setModel(page, m.key);
    studio.notice = t('已换到 {model}：它支持{role}', { model: tr(m.label), role: roleName(role) });
  }
  return m;
}
export function roleName(role) {
  return { edit: t('改这张图'), ref: t('参考图'), first: t('首帧'), last: t('尾帧'), audio: t('参考音频'), video: t('参考视频') }[role] || role;
}
/** 素材块下方的角色小字：中文就是角色名，英文换成短词（「edit this image」放不进素材块宽度） */
export function roleTag(role) {
  return { edit: tc('角标', '改这张图'), ref: tc('角标', '参考图'), first: tc('角标', '首帧'), last: tc('角标', '尾帧'), audio: tc('角标', '参考音频'), video: tc('角标', '参考视频') }[role] || roleName(role);
}

// —— 任务 ——
let tickTimer = null;
function syncTicker() {
  const any = studio.jobs.some(isActive);
  if (any && !tickTimer) tickTimer = setInterval(() => { studio.clock = Date.now(); }, 1000);
  else if (!any && tickTimer) { clearInterval(tickTimer); tickTimer = null; }
}
const doneHooks = new Set();
/** 任务完成回调（外壳用它做「作品飞进侧栏」）：fn(job) */
export function onJobDone(fn) { doneHooks.add(fn); return () => doneHooks.delete(fn); }

export function upsertJob(raw) {
  if (!raw?.id) return null;
  const i = studio.jobs.findIndex((x) => x.id === raw.id);
  const prev = i >= 0 ? studio.jobs[i] : null;
  // 第一次见到就已经结束的（进页对账拉回来的历史任务）不算「刚完成」：不冒点、不飞进侧栏
  const wasActive = prev ? isActive(prev) : isActive(raw) || !!raw.__mine;
  let job;
  if (prev) {
    // 状态只往前走：总线的「完成」可能比创建接口的回包先到，回包里的 queued 不许把它拉回去
    if (!isActive(prev) && isActive(raw)) { const { state, progress, ...rest } = raw; Object.assign(prev, rest); }
    else Object.assign(prev, raw);
    job = prev;
  }
  else { studio.jobs.unshift(raw); job = studio.jobs[0]; }
  studio.jobs.sort((a, b) => ts(b.createdAt) - ts(a.createdAt));
  if (job.state === 'done') {
    // 结果并进作品流（按 id 去重，重复到达无害）；只有亲眼看着它跑完的才冒点、飞进侧栏
    prependAssets(job.result || []);
    attachToView(job);
    if (wasActive) {
      studio.unseen++;
      for (const fn of doneHooks) try { fn(job); } catch {}
    }
  } else if (job.state === 'error' || job.state === 'canceled') {
    attachToView(job);
  }
  syncTicker();
  return job;
}

// 任务的结果接回它所在的画布：图像页的续改链里找那一轮；其余页如果正盯着这个任务就换成结果
function attachToView(job) {
  const page = pageOf(job.kind);
  if (page === 'image') {
    const v = studio.views.image;
    const turn = v.turns.find((x) => x.jobId === job.id);
    if (turn) {
      turn.state = job.state; turn.error = job.error || '';
      turn.assets = (job.result || []).filter((a) => !goneAssets.has(a?.id));
      // 续改链的 id ＝ 链上第一张作品的 id（后端 listAssets / loadThread 按 sessionId||id 分组）：
      // 第一轮出图时服务端还没有 thread 可回报，这里就拿第一张的 id 当链 id，下一轮带上它才接得上上下文
      const th = job.thread || job.result?.[0]?.thread || (job.state === 'done' && !v.thread && v.turns[0] === turn ? job.result?.[0]?.id : null);
      if (th && (!v.thread || v.thread === job.thread)) v.thread = th;
    }
    return;
  }
  const v = studio.views[page];
  if (v && v.focus?.jobId === job.id && job.state === 'done' && job.result?.[0] && !goneAssets.has(job.result[0].id)) v.focus = { asset: job.result[0], jobId: job.id };
}

export async function reconcile() {
  try {
    const r = await studioApi.jobs();
    // 后端回 { active: 进行中, jobs: 最近 50 条 }（两组可能重叠，按 id 合并）
    for (const j of [...(r?.jobs || []), ...(r?.active || [])]) upsertJob(j);
    adoptActive();
  } catch {}
}

// 刷新 / 换设备回来时画布是空的，但服务端还有这一类的任务在跑：把画布接回最新那条，免得「明明在生成却看不到」
function adoptActive() {
  for (const page of PAGES) {
    const j = studio.jobs.find((x) => isActive(x) && pageOf(x.kind) === page && x.source !== 'claude' && x.source !== 'legacy');
    if (!j) continue;
    if (page === 'image') {
      const v = studio.views.image;
      if (v.turns.length) continue;
      v.thread = j.thread || null;
      v.turns.push({ jobId: j.id, prompt: j.prompt || '', state: j.state, assets: [], error: '', srcUrl: '' });
    } else if (!studio.views[page].focus) {
      studio.views[page].focus = { jobId: j.id };
    }
  }
}

/** 生成：组请求体（§3.3）→ POST → 镜像任务；返回 { ok, error } */
export async function submit(page, text) {
  const model = currentModel(page);
  if (!model) return { ok: false, error: t('没有可用的模型，先到设置里接一个服务') };
  const d = studio.drafts[page];
  if (d.inputs.some((x) => x.pending)) return { ok: false, error: t('素材还在上传') };
  const values = valuesOf(page, model);
  const params = payloadParams(model.params || [], values);
  const body = {
    kind: catKind(page), key: model.key, prompt: (text || '').trim(), params,
    inputs: d.inputs.map((x) => {
      const o = { role: x.role };
      if (x.asset) o.asset = x.asset; else if (x.path) o.path = x.path; else if (x.upload) o.upload = uploadRel(x.upload);
      return o;
    }),
  };
  // 负面提示词按契约是顶层字段：模型 inputs.negative 为真时输入岛下的参数里有这一栏（草稿 negative）；
  // 万一某张卡把它写成 ParamSpec（negative / negativePrompt），也挪成顶层
  for (const k of ['negative', 'negativePrompt']) if (k in body.params) { body.negative = body.params[k]; delete body.params[k]; }
  if (model.inputs?.negative && d.negative?.trim()) body.negative = d.negative.trim();
  let parent = d.parent?.id || d.inputs.find((x) => x.fromAsset)?.fromAsset || null;
  if (page === 'image') {
    const v = studio.views.image;
    const prev = [...v.turns].reverse().find((x) => x.assets?.length)?.assets.at(-1) || null;
    // 链 id 兜底：画布上已经有图（从作品流打开的单张、旧作品）却还没有链 id 时，用第一张的 id（同后端的分组规则）
    if (!v.thread && prev) v.thread = prev.thread || v.turns.find((x) => x.assets?.length)?.assets[0]?.id || null;
    if (v.thread) body.thread = v.thread;
    // 续改链里接着说「改成…」：新图就是从上一张改出来的，血缘自动接到链上最后一张
    if (!parent && prev) parent = prev.id;
  }
  if (parent) body.parent = parent;
  let turn = null;
  if (page === 'image') {
    const src = d.inputs.find((x) => x.role === 'edit' || x.role === 'ref');
    studio.views.image.turns.push({ jobId: null, prompt: body.prompt, state: 'queued', assets: [], error: '', srcUrl: src?.url || '' });
    turn = studio.views.image.turns[studio.views.image.turns.length - 1];
  }
  try {
    const r = await studioApi.createJob(body);
    const job = upsertJob({ ...r.job, __mine: true, kind: r.job?.kind || body.kind, prompt: r.job?.prompt ?? body.prompt, key: r.job?.key || body.key, createdAt: r.job?.createdAt || Date.now() });
    if (turn) { turn.jobId = job.id; attachToView(job); }
    else studio.views[page].focus = { jobId: job.id };
    // 发出去之后：素材与 parent 清掉（图像续改链靠 thread 接着走），正文由调用方清
    d.inputs = []; d.parent = null;
    return { ok: true, job };
  } catch (e) {
    if (turn) studio.views.image.turns.splice(studio.views.image.turns.indexOf(turn), 1);
    return { ok: false, error: e.status === 401 ? t('需要登录') : tr(e.message || '') || t('生成失败') };
  }
}

export async function cancelJob(id) {
  try { await studioApi.cancelJob(id); } catch {}
  reconcile();
}
/** 失败的任务按原样再发一次 */
export async function retryJob(job) {
  try {
    const body = { kind: job.kind, key: job.key, prompt: job.prompt, params: job.params || {}, inputs: job.inputs || [] };
    for (const k of ['negative', 'thread', 'parent']) if (job[k]) body[k] = job[k];
    const r = await studioApi.createJob(body);
    const nj = upsertJob({ ...r.job, __mine: true, kind: r.job?.kind || job.kind, prompt: r.job?.prompt ?? job.prompt, key: r.job?.key || job.key, createdAt: r.job?.createdAt || Date.now() });
    // 画布上正显示着这条失败任务的（画布上的「重试」、任务托盘的「重试」都一样）：换成新任务接着看
    const page = pageOf(job.kind);
    if (nj && page === 'image') {
      const turn = studio.views.image.turns.find((x) => x.jobId === job.id);
      if (turn) { turn.jobId = nj.id; turn.state = nj.state; turn.error = ''; }
    } else if (nj && page && studio.views[page]?.focus?.jobId === job.id) studio.views[page].focus = { jobId: nj.id };
    return true;
  }
  catch { return false; }
}

// —— 作品 ——
// 本页面里删掉过的作品：旧任务记录（对账、晚到的总线事件、没升级的后端）的 result 里还带着它，别再并回来
const goneAssets = new Set();
function prependAssets(list) {
  for (const a of [...(list || [])].reverse()) {
    if (!a?.id || goneAssets.has(a.id) || studio.assets.some((x) => x.id === a.id)) continue;
    if (studio.filter !== 'all' && a.kind !== studio.filter) continue;
    studio.assets.unshift(a);
  }
}
let assetsSeq = 0;
export async function loadAssets(reset = true) {
  const my = ++assetsSeq;
  if (!reset && (studio.assetsDone || studio.assetsLoading)) return;
  studio.assetsLoading = true;
  try {
    const r = await studioApi.assets({ kind: studio.filter === 'all' ? '' : studio.filter, q: studio.q.trim(), cursor: reset ? '' : studio.cursor });
    if (my !== assetsSeq) return;
    const items = r?.items || [];
    if (reset) studio.assets = items;
    else for (const a of items) if (!studio.assets.some((x) => x.id === a.id)) studio.assets.push(a);
    studio.cursor = r?.cursor || null;
    studio.assetsDone = !r?.cursor;
    studio.assetsErr = '';
  } catch (e) { if (my === assetsSeq) studio.assetsErr = e.status === 401 ? t('需要登录') : t('作品加载失败'); }
  finally { if (my === assetsSeq) studio.assetsLoading = false; }
}
// 从本地各处拿掉一件作品（自己删的、别的设备删了经总线推来的，都走它）
function dropAsset(id) {
  goneAssets.add(id);
  studio.assets = studio.assets.filter((a) => a.id !== id);
  for (const page of ['video', 'voice', 'music']) if (studio.views[page].focus?.asset?.id === id) studio.views[page].focus = null;
  for (const turn of studio.views.image.turns) turn.assets = (turn.assets || []).filter((a) => a.id !== id);
}
/** 删作品：回 { ok, error? }。404 = 已经被别的设备 / 页面删掉了，按删成处理（别把幽灵作品放回列表）。 */
export async function deleteAsset(id) {
  const prev = studio.assets;
  dropAsset(id);
  try { await studioApi.deleteAsset(id); return { ok: true }; }
  catch (e) {
    if (e?.status === 404) return { ok: true };
    goneAssets.delete(id);
    studio.assets = prev;
    return { ok: false, error: e?.status ? tr(e.message || '') : t('连不上服务器，请重试') };
  }
}
export async function saveAsset(id, dir) {
  try { const r = await studioApi.saveAsset(id, dir); const a = studio.assets.find((x) => x.id === id); if (a && r?.wsPath) a.wsPath = r.wsPath; return r; }
  catch (e) { return { ok: false, error: tr(e.message || '') }; }
}

/** 在它的创作页画布里打开一件作品（图像：接回它的续改链） */
export async function openAsset(a) {
  const page = pageOf(a?.kind);
  if (!page) return;
  studio.page = page;
  if (page !== 'image') { studio.views[page].focus = { asset: a }; return; }
  const v = studio.views.image;
  v.turns = [{ jobId: null, prompt: a.prompt || '', state: 'done', assets: [a], error: '', srcUrl: '' }];
  v.thread = a.thread || a.id;
  if (!a.thread) return;
  try {
    const r = await studioApi.assets({ kind: 'image', thread: a.thread });
    const items = (r?.items || []).slice().sort((x, y) => ts(x.createdAt) - ts(y.createdAt));
    if (items.length && v.thread === a.thread) v.turns = items.map((x) => ({ jobId: x.jobId || null, prompt: x.prompt || '', state: 'done', assets: [x], error: '', srcUrl: '' }));
  } catch {}
}
export function newImageThread() { studio.views.image = { thread: null, turns: [] }; }

/** 复用参数：把一件作品的模型和参数放回它那一页的输入框（正文也放回去）。模型不在目录里了就只放参数和正文 */
export function reuseParams(a) {
  const page = pageOf(a?.kind);
  if (!page) return false;
  studio.page = page;
  const d = studio.drafts[page];
  const all = modelsOf(page);
  const bare = (s) => String(s || '').replace(/^[\w.-]+\//, '');
  const m = all.find((x) => x.key === (a.provider ? a.provider + '/' + a.model : '')) || all.find((x) => x.id === a.model) || all.find((x) => bare(x.id) === bare(a.model));
  if (m) d.model = m.key;
  d.params = { ...(a.params || {}) };
  if (typeof a.negative === 'string' && a.negative) d.negative = a.negative;
  if (a.prompt) studio.pendingText = { page, text: a.prompt };
  return true;
}

// —— 接着做（§5.1 表）——
// action: edit | ref | first | last | music | voice | audio
export function continueWith(a, action) {
  const kind = a?.kind;
  const thumb = mediaSrc(a, kind === 'image' || kind === 'video' ? 'thumb' : undefined);
  const parent = { id: a.id, kind, thumb, prompt: a.prompt || '' };
  if (action === 'edit' || action === 'ref') {
    studio.page = 'image';
    if (action === 'edit') {
      // 继续改这张图：接回它的续改链（画布上就是这条链，上下文由后端按 thread 重建）；
      // 不再把同一张图另挂成素材——链里已经有它，挂了等于发两遍。血缘记到用户点的这一张（可能在链中间）。
      openAsset(a);
      studio.drafts.image.inputs = studio.drafts.image.inputs.filter((x) => x.role !== 'edit');
      studio.drafts.image.parent = parent;
      return 'image';
    }
    newImageThread();
    ensureRole('image', action);
    addInput('image', { role: action, asset: a.id, url: thumb, name: a.prompt || '', kind: 'image', fromAsset: a.id });
    studio.drafts.image.parent = parent;
    return 'image';
  }
  if (action === 'first' || action === 'last' || (action === 'vref')) {
    const role = action === 'vref' ? 'ref' : action;
    studio.page = 'video';
    ensureRole('video', role);
    addInput('video', { role, asset: a.id, url: thumb, name: a.prompt || '', kind: 'image', fromAsset: a.id });
    studio.drafts.video.parent = parent;
    return 'video';
  }
  if (action === 'music' || action === 'voice') {
    studio.page = action;
    studio.drafts[action].parent = parent;
    return action;
  }
  if (action === 'vvideo' || action === 'vaudio') {
    const role = action === 'vvideo' ? 'video' : 'audio';
    studio.page = 'video';
    ensureRole('video', role);
    addInput('video', { role, asset: a.id, url: role === 'video' ? thumb : '', name: a.prompt || '', kind: role, fromAsset: a.id });
    studio.drafts.video.parent = parent;
    return 'video';
  }
  if (action === 'audio') {
    const page = studio.page === 'music' || studio.page === 'voice' ? studio.page : 'voice';
    studio.page = page;
    ensureRole(page, 'audio');
    addInput(page, { role: 'audio', asset: a.id, url: '', name: a.prompt || '', kind: 'audio', fromAsset: a.id });
    studio.drafts[page].parent = parent;
    return page;
  }
  return null;
}
/** 某件作品的「接着做」菜单项（按目录里有没有模型接得了来显隐） */
export function continueActions(a) {
  const out = [];
  const any = (page, role) => modelsOf(page).some((m) => roleState(m, role, []).ok);
  if (a?.kind === 'image') {
    if (any('image', 'edit')) out.push({ id: 'edit', label: t('继续改这张图'), page: 'image' });
    if (any('image', 'ref')) out.push({ id: 'ref', label: t('用作参考图'), page: 'image' });
    if (any('video', 'first')) out.push({ id: 'first', label: t('用作视频首帧'), page: 'video' });
    if (any('video', 'last')) out.push({ id: 'last', label: t('用作视频尾帧'), page: 'video' });
    if (any('video', 'ref')) out.push({ id: 'vref', label: t('用作视频参考图'), page: 'video' });
  } else if (a?.kind === 'video') {
    if (any('video', 'video')) out.push({ id: 'vvideo', label: t('用作视频参考'), page: 'video' });
    if (modelsOf('music').length) out.push({ id: 'music', label: t('给它配乐'), page: 'music' });
    if (modelsOf('voice').length) out.push({ id: 'voice', label: t('给它配音'), page: 'voice' });
  } else if (a?.kind === 'audio' || a?.kind === 'music') {
    if (any('voice', 'audio') || any('music', 'audio')) out.push({ id: 'audio', label: t('用作参考音频'), page: 'voice' });
    if (any('video', 'audio')) out.push({ id: 'vaudio', label: t('用作视频的参考音频'), page: 'video' });
  }
  return out;
}

// —— 核心入口发来的素材（lib/state.svelte.js 的 studioInbox：工作空间「发到 Media Studio」、agent 的 ui.cmd）——
// item: { page, text?, input?: { role?, path?, upload?, url?, name, kind } }
export function takeInbox(inbox) {
  const items = inbox.items.splice(0);
  for (const it of items) {
    const page = pageOf(it.page) || 'image';
    studio.page = page;
    if (it.text) studio.pendingText = { page, text: it.text };
    if (it.input) {
      const role = it.input.role || (page === 'video' ? 'first' : page === 'image' ? 'edit' : 'audio');
      ensureRole(page, role);
      addInput(page, { ...it.input, role });
    }
  }
}

// 个人设置压过主机设置（§3.5）：后端算好的 effective
function loadSettings() {
  studioApi.settings().then((s) => { const v = s?.effective || s || {}; if (typeof v.saveDir === 'string') studio.saveDir = v.saveDir; }).catch(() => {});
}

// —— 事件 ——
let started = false;
export function startStudio() {
  if (started) return;
  started = true;
  loadCatalog();
  reconcile();
  loadAssets(true);
  loadSettings();
  const onEv = (ev) => {
    if (!ev) return;
    if (ev.type === 'studio.job') upsertJob(ev.job || ev);
    else if (ev.type === 'studio.providers' || ev.type === 'studio.catalog') loadCatalog();
    else if (ev.type === 'studio.settings') { loadSettings(); loadCatalog(); }
    else if (ev.type === 'studio.asset.deleted' && ev.id) dropAsset(ev.id);
    else if (ev.type === 'hello') reconcile();   // 总线重连
  };
  busOn(onEv);
  studioApi.ready().then(() => onFixtureEvent(onEv));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reconcile(); });
}

const mmss = (s) => Math.floor(s / 60) + ':' + String(Math.floor(s % 60)).padStart(2, '0');
/** 进行中任务已经跑了多久（本地 1s 一跳，服务端 elapsed 更大时以它为准） */
export function jobElapsed(j, now = studio.clock) {
  const local = Math.max(0, (now - ts(j.createdAt)) / 1000);
  return mmss(Math.max(local, Number(j.elapsed) || 0));
}
/** 预计总时长「约 1:10」（服务端给了 eta 才有） */
export function jobEta(j, now = studio.clock) {
  if (j.eta == null || !(j.eta > 0)) return '';
  const local = Math.max(0, (now - ts(j.createdAt)) / 1000);
  return t('约 {eta}', { eta: mmss(Math.max(local, Number(j.elapsed) || 0) + Number(j.eta)) });
}
/** 进行中任务的计时文字：「0:42 · 约 1:10」（行内用） */
export function jobTiming(j, now = studio.clock) {
  const eta = jobEta(j, now);
  return eta ? jobElapsed(j, now) + ' · ' + eta : jobElapsed(j, now);
}
export function jobStateText(j) {
  if (j.state === 'queued') return t('排队中');
  if (j.state === 'running') return t('生成中');
  if (j.state === 'done') return t('已完成');
  if (j.state === 'canceled') return j.note ? tr(j.note) : j.abandoned ? t('已放弃') : t('已取消');
  return t('失败');
}
export { splitKey };
