// 生成任务执行器（方案 §3.3）：创作页、旧 /api/vertex/* 转接、Claude 的媒体工具、agent 接口都从这里走。
//
// 任务跑在服务端，跟页面无关：切页面、锁屏、断网都不丢，回来按 GET /api/studio/jobs 对账。
// 进度走总线（busPublish(owner)），主题 studio.job，载荷平铺：{ type, id, kind, key, state, progress?, elapsed, eta?, result?, error?, note? }。
// 每个人保留进行中的 + 最近 50 条（<owner 目录>/jobs.json，防抖落盘）；服务重启时没跑完的标成 error「服务重启，任务中断」。
//
// 取消尽力而为：没发出去的直接停；Veo / Omni 这类发出去就收不回的（publisher LRO 没有 cancel）标「已放弃（仍可能计费）」，
// 结果到了也不要。额度：用管理员共享的服务（花的是管理员的钱）计成员的媒体额度，视频单算；自己的 Key 不计。

import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import * as media from '@bridge/core/vertex-media.mjs';
import { ID_RE, readJson, writeJson } from '@bridge/core/jsonfile.mjs';
import { busPublish } from '@bridge/core/runtime/bus.mjs';
import { admitUsage } from '@bridge/core/runtime/quota.mjs';
import { mimeType, safeJoin, withinRoot } from '@bridge/core/runtime/http-file.mjs';
import { protectedTarget } from '@bridge/core/routes/file-core.mjs';
import { studioOwnerDir, effectiveStudioSettings } from '@bridge/core/runtime/studio-settings.mjs';
import { GEMINI_API_KEY } from '@bridge/core/config/index.mjs';
import { assertPublicUrl, publicDispatcher } from '@bridge/core/runtime/public-net.mjs';
import { studioOwner, providerSecret, usableProviders, isMemberOwner, HOST_OWNER, modelKey } from './providers.mjs';
import { resolveAny, defaultFor, etaFor } from './catalog.mjs';
import { applySpecs } from './cards/spec.mjs';
import { adapterFor } from './adapters/index.mjs';
import { NO_BASEURL, KINDS } from './presets.mjs';
import { assetKindOf, autoSave, publicAsset } from './assets.mjs';
import { imageDims } from './adapters/openrouter-image.mjs';
import { logCall } from './log.mjs';
import { markUsed } from './discovery/store.mjs';

const bad = (msg, status = 400) => Object.assign(new Error(msg), { status });
const MAX_RECENT = 50;
const MAX_ACTIVE = 8;
const MAX_INPUTS = 16;
const MAX_INPUT_BYTES = 60_000_000;
const ROLES = ['edit', 'ref', 'first', 'last', 'audio', 'video'];
const FINAL = new Set(['done', 'error', 'canceled']);

// —— 存储（按 owner）——
const jobs = new Map();       // id → 任务（内部对象，带 owner / ac / 回调）
const recent = new Map();     // owner → [id…]（新的在前）
const loaded = new Set();
function loadOwner(owner) {
  if (loaded.has(owner)) return;
  loaded.add(owner);
  const raw = readJson(path.join(studioOwnerDir(owner), 'jobs.json'), {});
  const ids = [];
  for (const j of Array.isArray(raw.jobs) ? raw.jobs : []) {
    if (!j || !ID_RE.test(String(j.id || '')) || jobs.has(j.id)) continue;
    const job = { ...j, owner };
    if (!FINAL.has(job.state)) Object.assign(job, { state: 'error', error: '服务重启，任务中断', finishedAt: job.finishedAt || Date.now() });
    jobs.set(job.id, job); ids.push(job.id);
  }
  recent.set(owner, ids.slice(0, MAX_RECENT));
}
const timers = new Map();
function persist(owner) {
  clearTimeout(timers.get(owner));
  timers.set(owner, setTimeout(() => {
    timers.delete(owner);
    const list = (recent.get(owner) || []).map((id) => jobs.get(id)).filter(Boolean).map(publicJob);
    try { writeJson(path.join(studioOwnerDir(owner), 'jobs.json'), { jobs: list }, 0); } catch (e) { console.error('[studio] 任务记录写不下去：', (e && e.message) || e); }
  }, 500));
  timers.get(owner).unref?.();
}
function remember(job) {
  loadOwner(job.owner);
  const list = recent.get(job.owner) || [];
  list.unshift(job.id);
  // 只裁掉已结束的旧任务（进行中的永远留着）
  while (list.length > MAX_RECENT) {
    const i = list.map((id) => jobs.get(id)).findLastIndex((j) => !j || FINAL.has(j.state));
    if (i < 0) break;
    const [gone] = list.splice(i, 1);
    jobs.delete(gone);
  }
  recent.set(job.owner, list);
}

/** 给前端 / 总线的样子（§3.3 Job）。 */
export function publicJob(j) {
  return {
    id: j.id, kind: j.kind, key: j.key, prompt: j.prompt, ...(j.negative ? { negative: j.negative } : {}),
    params: j.params, inputs: j.inputs, ...(j.thread ? { thread: j.thread } : {}), ...(j.parent ? { parent: j.parent } : {}),
    state: j.state, progress: j.progress || 0, elapsed: j.elapsed || 0, ...(j.eta != null ? { eta: j.eta } : {}),
    createdAt: j.createdAt, ...(j.startedAt ? { startedAt: j.startedAt } : {}), finishedAt: j.finishedAt || null,
    result: j.result || [], error: j.error || null, ...(j.note ? { note: j.note } : {}), source: j.source || 'studio',
    ...(j.providerName ? { providerName: j.providerName } : {}), ...(j.modelLabel ? { modelLabel: j.modelLabel } : {}),
    ...(j.uncancelable ? { uncancelable: true } : {}),
  };
}

function emit(job, extra = {}) {
  const ev = {
    type: 'studio.job', id: job.id, kind: job.kind, key: job.key, state: job.state, progress: job.progress || 0, elapsed: job.elapsed || 0,
    ...(job.eta != null ? { eta: job.eta } : {}), ...(job.state === 'done' ? { result: job.result } : {}), ...(job.error ? { error: job.error } : {}),
    ...(job.note ? { note: job.note } : {}), ...(job.detail && job.state === 'running' ? { detail: job.detail } : {}), ...extra,
  };
  try { busPublish(job.owner, ev); } catch {}
  try { job.onEvent?.(ev); } catch {}
}

const aliveAssets = new Set();   // 核对过还在的作品 id（每件只查一次盘）
// exists(id)：作品还在不在。给了就顺手清掉 result 里已被删的作品（升级前删的、经旧接口删的）
export function listJobs(owner, { active = false, exists = null } = {}) {
  loadOwner(owner);
  const all = (recent.get(owner) || []).map((id) => jobs.get(id)).filter(Boolean);
  if (exists) {
    for (const j of all) for (const a of j.result || []) {
      if (!a?.id || aliveAssets.has(a.id)) continue;
      if (exists(a.id)) aliveAssets.add(a.id); else forgetResult(owner, a.id);
    }
  }
  const live = all.filter((j) => !FINAL.has(j.state)).map(publicJob);
  return active ? { active: live, jobs: all.map(publicJob) } : { jobs: all.map(publicJob) };
}
/** 作品删掉以后从这个人任务记录的 result 里拿掉：否则前端对账（切回前台 / 总线重连）把它当结果又并回作品流，成了「加载失败」的空格。 */
export function forgetResult(owner, assetId) {
  loadOwner(owner);
  aliveAssets.delete(assetId);
  let hit = false;
  for (const id of recent.get(owner) || []) {
    const j = jobs.get(id);
    if (!j?.result?.some((a) => a?.id === assetId)) continue;
    j.result = j.result.filter((a) => a?.id !== assetId);
    hit = true;
  }
  if (hit) persist(owner);
  return hit;
}
export function getJob(owner, id) {
  loadOwner(owner);
  const j = jobs.get(String(id));
  return j && j.owner === owner ? publicJob(j) : null;
}

// upload 素材 → { abs, rel }；越界 = null。收两种写法：uploads 相对路径（前端现在发的），或者落在本人 uploads 里的
// 绝对路径（/api/upload、/api/files/to-upload 回的就是绝对路径，旧前端原样塞了进来）。绝对路径不能交给 safeJoin——
// 它会去掉盘符再拼到 uploads 下面，变成 uploads/Users/…/uploads/x.jpg，于是所有本机上传都报「素材文件不存在」。
export function uploadFile(ctx, upload) {
  const raw = String(upload || '').trim();
  if (!raw || !ctx?.uploads) return null;
  const base = path.resolve(ctx.uploads);
  const abs = path.isAbsolute(raw) || path.win32.isAbsolute(raw)
    ? (withinRoot(base, path.resolve(raw)) ? path.resolve(raw) : null)
    : safeJoin(base, raw.replace(/\\/g, '/'));
  if (!abs || abs === base) return null;
  return { abs, rel: path.relative(base, abs).split(path.sep).join('/') };
}

// —— 素材：asset（媒体库 id）/ path（工作空间相对路径，过路径守卫）/ upload（uploads 相对路径，或本人 uploads 里的绝对路径）——
function resolveInput(ctx, x) {
  if (!x || typeof x !== 'object') throw bad('素材格式不对');
  const role = ROLES.includes(x.role) ? x.role : null;
  if (!role) throw bad('素材的角色只能是 ' + ROLES.join(' / '));
  let file = null, asset = null, upRel = '';
  if (x.asset) {
    if (!ID_RE.test(String(x.asset))) throw bad('素材 id 不对');
    file = media.fileFor(String(x.asset), ctx.media);
    if (!file) throw bad('素材作品不见了');
    asset = String(x.asset);
  } else if (x.path) {
    const abs = safeJoin(ctx.cwd, String(x.path).replace(/\\/g, '/'));
    if (!abs || protectedTarget(ctx.cwd, abs, ctx)) throw bad('素材路径越界或是受保护目录');
    file = abs;
  } else if (x.upload) {
    const up = uploadFile(ctx, x.upload);
    if (!up) throw bad('上传路径越界');
    file = up.abs; upRel = up.rel;
  } else throw bad('素材要给 asset、path 或 upload 之一');
  let st;
  try { st = statSync(file); } catch { throw bad('素材文件不存在'); }
  if (!st.isFile()) throw bad('素材不是文件');
  // 任务记录里只留 uploads 相对路径，不把服务器上的绝对路径回给前端
  const pub = { role, ...(asset ? { asset } : x.path ? { path: String(x.path) } : { upload: upRel }) };
  return { pub, file, size: st.size, role, asset, name: path.basename(file) };
}

// —— 输出 → 扩展名；裸 PCM 包成 WAV ——
function extOf(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  if (m.includes('gif')) return 'gif';
  if (m.includes('mp4') && m.startsWith('video')) return 'mp4';
  if (m.includes('webm')) return 'webm';
  if (m.includes('quicktime')) return 'mov';
  if (m.includes('mpeg') || m.includes('mp3')) return 'mp3';
  if (m.includes('wav') || m.includes('wave')) return 'wav';
  if (m.includes('flac')) return 'flac';
  if (m.includes('ogg') || m.includes('opus')) return 'ogg';
  if (m.includes('aac') || m.includes('mp4')) return 'm4a';
  return '';
}
export function pcmToWav(pcm, sampleRate = 24000, channels = 1, bits = 16) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * channels * bits / 8, 28); h.writeUInt16LE(channels * bits / 8, 32); h.writeUInt16LE(bits, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
function normalizeOutput(o, kind) {
  let { bytes, mime } = o;
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes || []);
  if (!bytes.length) throw bad('服务返回了空文件', 502);
  if (/audio\/(l16|pcm)/i.test(mime || '')) {
    const rate = parseInt((String(mime).match(/rate=(\d+)/) || [])[1], 10) || 24000;
    bytes = pcmToWav(bytes, rate); mime = 'audio/wav';
  }
  let ext = extOf(mime);
  if (!ext) ext = { image: 'png', video: 'mp4', speech: 'mp3', music: 'mp3' }[kind];
  return { bytes, mime, ext };
}
// WAV 时长（秒）：读头里的字节率
function wavSeconds(buf) {
  try { if (buf.toString('ascii', 0, 4) === 'RIFF') { const rate = buf.readUInt32LE(28); return rate ? Math.round(((buf.length - 44) / rate) * 10) / 10 : 0; } } catch {}
  return 0;
}

// 共享服务出错时别把管理员的地址漏给成员（日志里照记原话）
const scrub = (msg) => String(msg || '').replace(/https?:\/\/[^\s'"）)]+/g, '（地址已隐去）').replace(/\b[a-z0-9-]+(\.[a-z0-9-]+)+(:\d+)?\b/gi, (h) => (/\.(com|net|org|io|ai|cn|dev|app|run)\b/i.test(h) ? '（地址已隐去）' : h));
const errText = (e) => String((e && (e.message || e)) || '生成失败').slice(0, 600);

/** vertex 方言借的 Gemini key：同一主人的第一个启用的 Gemini API 服务；主机兜底 config 的 geminiApiKey。 */
function companionGeminiKey(provider) {
  for (const p of usableProviders(provider.owner)) {
    if (p.enabled && p.dialect === 'gemini' && p.owner === provider.owner) { const k = providerSecret(p).key; if (k) return k; }
  }
  return provider.owner === HOST_OWNER ? GEMINI_API_KEY : '';
}

/**
 * 建任务并开跑。body = { kind, key（'<服务>/<模型>' 或裸模型 id；不给用默认）, prompt, negative?, params?, inputs?, thread?, parent? }
 * opts：{ source（studio | legacy | claude | api）, onEvent(ev)（旧接口 SSE / Claude 工具推进度）, autoSave（默认 source==='studio'）,
 *         turns（旧 image-chat 显式带的续改轮次 [{ userText, imageId }]）, quota（默认 true）, extraMeta（并进侧车）}
 * 回 { job: 公开形状, done: Promise<公开形状> }。参数 / 素材 / 额度不过关直接抛（带 status）。
 */
export function startJob(ctx, body, opts = {}) {
  const owner = studioOwner(ctx);
  if (!owner) throw bad('这个身份不能用 Media Studio', 403);
  // 生成（花钱）跟着 studio 这个 agent 的开关走（全局开关 ∩ 按人授权，管理员也一样，同以前的 Gemini 开关）；
  // 服务与设置的管理不受它管（关着时也能先配好再开）
  if (!ctx.allowStudio) throw bad('Media Studio 未启用，或你的账号没有使用权限', 403);
  loadOwner(owner);
  const kind = String(body?.kind || '');
  if (!KINDS.includes(kind)) throw bad('kind 只能是 ' + KINDS.join(' / '));
  const live = (recent.get(owner) || []).map((id) => jobs.get(id)).filter((j) => j && !FINAL.has(j.state));
  if (live.length >= MAX_ACTIVE) throw bad(`同时进行的任务太多（上限 ${MAX_ACTIVE}），等前面的跑完`, 429);

  const keyIn = typeof body.key === 'string' ? body.key.trim() : '';
  const hit = keyIn ? resolveAny(keyIn, kind, owner) : defaultFor(kind, owner);
  if (!hit) throw bad(keyIn ? `找不到可用的模型「${keyIn}」（服务被停用 / 删除，或模型关掉了）` : '还没有能用的' + { image: '图像', video: '视频', speech: '配音', music: '音乐' }[kind] + '服务：先在 设置 › Media Studio 里加一个', keyIn ? 404 : 409);
  const { provider, entry, card } = hit;

  const prompt = String(body.prompt ?? '').trim();
  if (prompt.length > 12000) throw bad('提示词太长（上限 12000 字）');
  const inputs = (Array.isArray(body.inputs) ? body.inputs : []).slice(0, MAX_INPUTS + 1).map((x) => resolveInput(ctx, x));
  if (inputs.length > MAX_INPUTS) throw bad(`素材最多 ${MAX_INPUTS} 个`);
  if (inputs.reduce((n, x) => n + x.size, 0) > MAX_INPUT_BYTES) throw bad('素材加起来太大（上限 60 MB）');
  const allowed = new Set([...(card.inputs?.images?.roles || []), ...(card.inputs?.audio ? ['audio'] : []), ...(card.inputs?.video ? ['video'] : [])]);
  for (const x of inputs) if (!allowed.has(x.role)) throw bad(`这个模型不收「${x.role}」素材`);
  // 参考视频 / 音频（Seedance 这类）：按卡上的 max
  for (const r of ['video', 'audio']) {
    const lim = card.inputs?.[r]?.max;
    if (Number.isFinite(lim) && inputs.filter((x) => x.role === r).length > lim) throw bad(`这个模型最多收 ${lim} 个${r === 'video' ? '参考视频' : '参考音频'}`);
  }
  // 张数：首帧 / 尾帧各一张；改图 / 参考图按卡上的 max（Veo 参考图最多 3、Nano Banana 3、GPT Image 16…）
  const maxImg = card.inputs?.images?.max ?? 0;
  const count = (r) => inputs.filter((x) => x.role === r).length;
  if (count('first') > 1 || count('last') > 1) throw bad('首帧、尾帧各只能给一张');
  if (count('edit') + count('ref') > Math.max(1, maxImg)) throw bad(`这个模型最多收 ${maxImg} 张参考图`);
  if (kind === 'speech' && !prompt) throw bad('要朗读的文字是空的');
  if (kind === 'music' && !prompt) throw bad('描述是空的');
  if (!prompt && !inputs.length) throw bad('描述是空的');

  // 参数：模型条目的默认值垫底 → 按卡规范化（Google 系照抄旧路由的夹紧，其余按 ParamSpec）
  const rawParams = { ...(entry.defaults || {}), ...(body.params && typeof body.params === 'object' ? body.params : {}) };
  const params = card.normalize ? card.normalize(rawParams) : applySpecs(card.params, rawParams);
  const negative = card.negative ? card.negative(body.negative) : (typeof body.negative === 'string' ? body.negative.trim().slice(0, 2000) : '');
  const thread = typeof body.thread === 'string' && ID_RE.test(body.thread) ? body.thread : null;
  const parent = typeof body.parent === 'string' && ID_RE.test(body.parent) ? body.parent : null;

  // 额度：花的是管理员的钱（共享服务 / 主机服务）才计成员额度
  if (opts.quota !== false && ctx.kind === 'user' && provider.owner !== owner) {
    const block = admitUsage(ctx, kind === 'video' ? 'video' : 'media');
    if (block) throw Object.assign(bad(block.message, 429), { title: block.title });
  }

  const job = {
    id: media.newId(), owner, kind, key: modelKey(provider.id, entry.id), prompt, negative, params,
    inputs: inputs.map((x) => x.pub), thread, parent, state: 'queued', progress: 0, elapsed: 0, eta: etaFor(kind, card),
    createdAt: Date.now(), finishedAt: null, result: [], error: null, source: opts.source || 'studio',
    providerName: provider.name, modelLabel: entry.label && entry.label !== entry.id ? entry.label : (card.label || entry.id),
    onEvent: opts.onEvent, ac: new AbortController(),
  };
  jobs.set(job.id, job);
  remember(job);
  try { markUsed(owner, job.key); } catch {}   // 目录的「新」标记：本人用过就不再算新
  persist(owner);
  emit(job);
  const done = new Promise((resolve) => { job._resolve = resolve; });
  setImmediate(() => { execute(job, ctx, { provider, entry, card, inputs, opts }).catch(() => {}); });
  return { job: publicJob(job), done };
}

async function execute(job, ctx, { provider, entry, card, inputs, opts }) {
  const t0 = Date.now();
  job.state = 'running'; job.startedAt = t0;
  emit(job);
  const eta = etaFor(job.kind, card);
  let lastEmit = 0, realProgress = null;
  const tick = (info = {}) => {
    if (FINAL.has(job.state)) return;
    job.elapsed = Math.round((Date.now() - t0) / 1000);
    if (typeof info.progress === 'number') realProgress = Math.max(0, Math.min(0.99, info.progress));
    job.progress = realProgress ?? Math.min(0.95, job.elapsed / eta);
    job.eta = info.eta ?? Math.max(0, eta - job.elapsed);
    if (info.note) job.note = String(info.note).slice(0, 120);
    if (info.detail) job.detail = info.detail;   // 方言自己的细节进度（本机 Qwen 的第几步 / 第几张），只走事件不落盘
    if (Date.now() - lastEmit >= 1000) { lastEmit = Date.now(); emit(job); }
  };
  const ticker = setInterval(() => tick(), 2000);
  ticker.unref?.();
  const settle = () => { clearInterval(ticker); persist(job.owner); job._resolve?.(publicJob(job)); };
  const member = isMemberOwner(provider.owner);
  try {
    // 成员自己的服务：每次发请求前再查一遍是公网（保存时查过，DNS 可能变）；真正连接时 publicDispatcher 还会查
    if (member && !NO_BASEURL.has(provider.dialect) && provider.baseUrl) await assertPublicUrl(provider.baseUrl);
    const req = {
      kind: job.kind, model: entry.id, card, prompt: job.prompt, negative: job.negative, params: job.params,
      inputs: inputs.map((x) => ({ role: x.role, data: readFileSync(x.file), mime: mimeType(x.file, { fallback: 'application/octet-stream' }), name: x.name, asset: x.asset })),
      thread: loadThread(ctx, job.thread, opts.turns),
    };
    const adapter = adapterFor(provider.dialect);
    const actx = {
      secret: providerSecret(provider), signal: job.ac.signal, progress: tick,
      submitted: () => { job.uncancelable = true; emit(job); },
      devKey: provider.dialect === 'vertex' ? companionGeminiKey(provider) : undefined,
      dispatcher: member ? publicDispatcher() : undefined,
    };
    let out, attempt = 0;
    for (;;) {
      try { out = await adapter.run(req, provider, actx); break; }
      catch (e) {
        // 只重试「确定没被受理」的：429 限流（上游拒收、不计费）、连接都没建立（拒连 / DNS 失败）。5xx、超时、连接中途断开
        // 都可能是请求已经发出去、上游已经开跑——再发一次就是重复计费（2026-11-04 契约复核）
        const st = e && e.status;
        const notSent = st === 429 || (e?.code === 'network' && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|EPRIVATEADDR/.test(String(e.detail || e.message || '')));
        const retryable = notSent && !job.uncancelable && !job.ac.signal.aborted;
        if (!retryable || attempt >= (provider.retries ?? 1)) throw e;
        attempt++;
        tick({ note: `重试第 ${attempt} 次` });
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    if (job.state === 'canceled') return;   // 已放弃：结果到了也不要
    const assets = Array.isArray(out?.assets) ? out.assets : [];
    if (!assets.length) throw bad('服务没有返回结果', 502);
    const settings = effectiveStudioSettings(job.owner);
    const wantSave = opts.autoSave ?? job.source === 'studio';
    const saved = [];
    const batchId = assets.length > 1 ? media.newId() : null;
    assets.forEach((a, i) => {
      const o = normalizeOutput(a, job.kind);
      const id = (opts.presetIds && opts.presetIds[i]) || media.newId();   // 旧接口 SSE 的 start 先报了作品 id
      const dims = job.kind === 'image' ? imageDims(o.bytes) : null;
      const parents = [...new Set([job.parent, ...job.inputs.map((x) => x.asset)].filter(Boolean))];
      const meta = {
        kind: assetKindOf(job.kind), prompt: job.prompt, model: entry.id, provider: provider.id, providerName: provider.name, dialect: provider.dialect,
        params: job.params, parents, jobId: job.id, source: job.source,
        ...(job.negative ? { negativePrompt: job.negative } : {}),
        // 续改链：图像都进链（第一张自成一条，后续沿用 thread），旧 image-chat 的会话分组照旧
        ...(job.kind === 'image' && job.thread ? { sessionId: job.thread } : {}),
        ...(batchId ? { batchId, batchIndex: i } : {}),
        ...(dims ? { width: dims[0], height: dims[1] } : {}),
        ...(o.ext === 'wav' ? { duration: wavSeconds(o.bytes) } : {}),
        ...(a.meta || {}), ...(opts.extraMeta || {}),
      };
      let rec = media.save(id, o.bytes, o.ext, meta, ctx.media);
      if (wantSave) { const ws = autoSave(ctx, rec, settings); if (ws) rec = { ...rec, wsPath: ws }; }
      saved.push(publicAsset(rec));
    });
    job.result = saved;
    job.state = 'done'; job.progress = 1; job.finishedAt = Date.now(); job.elapsed = Math.round((job.finishedAt - t0) / 1000); job.eta = 0;
    logCall(provider, { kind: job.kind, model: entry.id, status: 'ok', ms: job.finishedAt - t0 });
    emit(job);
  } catch (e) {
    if (job.state === 'canceled') return;
    const aborted = job.ac.signal.aborted;
    job.state = aborted ? 'canceled' : 'error';
    job.error = aborted ? null : (provider.owner === job.owner ? errText(e) : scrub(errText(e)));
    job.finishedAt = Date.now(); job.elapsed = Math.round((job.finishedAt - t0) / 1000);
    logCall(provider, { kind: job.kind, model: entry.id, status: aborted ? 'canceled' : 'error', ms: job.finishedAt - t0, error: aborted ? undefined : errText(e) });
    emit(job);
  } finally {
    settle();
  }
}

// 续改链：显式 turns（旧 image-chat）或按 thread 从媒体库还原（同 loadImageChat 的分组），每轮带图字节与 thoughtSignature。
function loadThread(ctx, thread, turns) {
  let list = Array.isArray(turns) ? turns : null;
  if (!list && thread) list = media.loadImageChat(thread, ctx.media)?.turns || [];
  if (!list || !list.length) return null;
  const out = [];
  for (const t of list.slice(-6)) {
    const id = String(t.imageId || '');
    const rec = media.get(id, ctx.media);
    const f = media.fileFor(id, ctx.media);
    if (!rec || !f) continue;
    const ex = path.extname(f).slice(1).toLowerCase();
    out.push({ userText: String(t.userText || ''), imageId: id, data: readFileSync(f), mime: ex === 'jpg' ? 'image/jpeg' : (ex === 'webp' ? 'image/webp' : 'image/png'), signature: rec.signature || '' });
  }
  return out.length ? { turns: out } : null;
}

/** 取消：没发出去的直接停；发出去收不回的标「已放弃（仍可能计费）」。 */
export function cancelJob(owner, id) {
  loadOwner(owner);
  const job = jobs.get(String(id));
  if (!job || job.owner !== owner) return null;
  if (FINAL.has(job.state)) return publicJob(job);
  const abandoned = !!job.uncancelable;
  try { job.ac?.abort(); } catch {}
  job.state = 'canceled';
  job.note = abandoned ? '已放弃（仍可能计费）' : '已取消';
  job.finishedAt = Date.now();
  emit(job);
  persist(owner);
  job._resolve?.(publicJob(job));
  return publicJob(job);
}

/**
 * 不进任务表、不落媒体库，直接跑一次（桌面 Claude Code 的 stdio MCP 用：它是独立进程，作品写到它自己指定的路径）。
 * 身份固定是主机管理员（读主机的 Studio 服务与密钥）。回 { outputs: [{ bytes, mime, ext }], provider, entry }。
 */
export async function runDirect({ kind, key, prompt = '', negative = '', params = {}, onProgress } = {}) {
  if (!KINDS.includes(kind)) throw bad('kind 只能是 ' + KINDS.join(' / '));
  const hit = key ? resolveAny(key, kind, HOST_OWNER) : defaultFor(kind, HOST_OWNER);
  if (!hit) throw bad(key ? `找不到可用的模型「${key}」（先在 Media Studio 里加服务，或一键导入 Vertex）` : '还没有能用的媒体服务：先在 设置 › Media Studio 里加一个', 404);
  const { provider, entry, card } = hit;
  const raw = { ...(entry.defaults || {}), ...params };
  const req = {
    kind, model: entry.id, card, prompt: String(prompt || '').trim(),
    negative: card.negative ? card.negative(negative) : String(negative || ''),
    params: card.normalize ? card.normalize(raw) : applySpecs(card.params, raw),
    inputs: [], thread: null,
  };
  const t0 = Date.now();
  const out = await adapterFor(provider.dialect).run(req, provider, {
    secret: providerSecret(provider), signal: AbortSignal.timeout(20 * 60_000),
    progress: () => onProgress?.(Math.round((Date.now() - t0) / 1000)), submitted: () => {},
    devKey: provider.dialect === 'vertex' ? companionGeminiKey(provider) : undefined,
  });
  return { outputs: (out?.assets || []).map((a) => normalizeOutput(a, kind)), provider, entry };
}

export function _resetJobsForTests() { jobs.clear(); recent.clear(); loaded.clear(); aliveAssets.clear(); }
