// 模型中心 v2 ⇄ Media Studio（契约 §5.2、§6）：媒体模型（图像 / 视频 / 配音 / 音乐）不在模型中心自己发请求，
// 而是同步成 Studio 里的一个「托管服务」（managedBy:'hub'、hubRef = 模型中心服务 id），由 Studio 的驱动去调。
//
// 核心不直接 import 扩展的文件：桥对象经 getModule('studio')?.hub 取（studio 扩展没装 / 没加载 = 没有桥，媒体去向不可用）。
// 桥上种类用 Studio 的叫法（配音 = speech），这里进出时互转：模型中心一侧一律 voice。
// Key：托管服务的 Key 由这里推过去；只在 Key 变了时才推（内存里记一个摘要比对，不落盘）——每次推 Key 都会让 Studio 后台
// 刷一遍参数 schema，改个名字没必要。
import { createHash } from 'node:crypto';
import { getModule } from '../../modules/registry.mjs';
import { scrubKey } from './pool.mjs';

export const MEDIA_KINDS = Object.freeze(['image', 'video', 'voice', 'music']);
export const NO_STUDIO = '这台服务器没有启用 Media Studio';
export const toStudioKind = (k) => (k === 'voice' ? 'speech' : k);
export const fromStudioKind = (k) => (k === 'speech' ? 'voice' : k);

// Studio 各方言能做的种类（modules/studio/server/presets.mjs 的 DIALECT_KINDS 的镜像，模型中心叫法）。
// 只在桥的 dialectFor 认不出这个方言时兜底用（收编来的「自定义地址 + 某方言」服务，按地址认会认成 OpenAI 兼容）。
const DIALECT_KINDS = Object.freeze({
  vertex: ['image', 'video', 'voice', 'music'], gemini: ['image', 'video', 'voice', 'music'],
  fal: ['image', 'video', 'voice', 'music'], replicate: ['image', 'video', 'voice', 'music'],
  openai: ['image', 'video', 'voice'], openrouter: ['image', 'video'], elevenlabs: ['voice', 'music'],
  minimax: ['video', 'voice', 'music'], ark: ['image', 'video'], local: ['image'],
});

let override;   // undefined = 用真的桥；null = 假装没有；对象 = 测试用的假桥
/** 测试换桥：传对象 = 假桥，null = 没有桥，undefined = 恢复真的。顺带清掉 Key 摘要。 */
export function _setStudioBridgeForTests(b) { override = b; keySigs.clear(); }
export function studioBridge() {
  if (override !== undefined) return override;
  try { return getModule('studio')?.hub || null; } catch { return null; }
}

// 上游 / Studio 的报错原文偶尔会回显 Key：拼进给用户看的话之前抹掉（先抹后截；和网关共用 pool.mjs 的那份）
export { scrubKey };

const keySigs = new Map();   // 服务 id → 上次推给 Studio 的 Key 的摘要（只在内存）
const sig = (k) => createHash('sha256').update('hub-studio:' + k).digest('hex').slice(0, 16);
/**
 * 对账时按 Studio 那边记的 Key 尾号认一下「这把 Key 推过没有」→ 对得上回 true（记下摘要，下次同步不重推）；
 * 对不上回 false（清掉摘要，下次同步连 Key 一起推）。只看尾号：不为了这个把 Studio 的明文 Key 取出来。
 */
export function primeStudioKey(sid, key, tail) {
  const same = String(tail || '') === (key ? key.slice(-4) : '');
  if (same) keySigs.set(sid, sig(key)); else keySigs.delete(sid);
  return same;
}

/** 媒体模型走哪条线路的地址与 Key：第一条启用且有 Key 的；都没 Key 就第一条启用的（按 none 鉴权的服务）。 */
export function mediaLine(s, keyOf) {
  const on = (s.lines || []).filter((l) => l.enabled !== false);
  const line = on.find((l) => keyOf(s.id, l.id)) || on[0] || null;
  return { line, key: line ? keyOf(s.id, line.id) : '', baseUrl: (line && line.baseUrl) || s.baseUrl };
}

/**
 * 这个服务的媒体接口：{ dialect, kinds（模型中心叫法）, providerId } | null（没有桥）。
 * 方言：已托管的按托管时 Studio 定下的；没托管的按地址认（桥的 dialectFor，不联网）。
 * 能做的种类：地址认出来的就是这个方言 → 桥给的；否则识别时 Studio 报过的（catMedia）；再不行查上面的镜像表。
 */
export function mediaInfo(s, catMedia, keyOf) {
  const bridge = studioBridge();
  if (!bridge) return null;
  let guess = null;
  try { guess = bridge.dialectFor(keyOf ? mediaLine(s, keyOf).baseUrl : s.baseUrl); } catch {}
  const dialect = s.studio?.dialect || catMedia?.dialect || guess?.dialect || 'openai';
  let kinds;
  if (guess && guess.dialect === dialect) kinds = (guess.kinds || []).map(fromStudioKind);
  else if (catMedia && catMedia.dialect === dialect) kinds = catMedia.kinds;
  else kinds = DIALECT_KINDS[dialect] || [];
  return { dialect, kinds: MEDIA_KINDS.filter((k) => kinds.includes(k)), providerId: s.studio?.id || null };
}

/** 这个服务要同步给 Studio 的媒体模型（去向含 studio 的）。 */
export const studioModels = (s) => (s.models || []).filter((m) => MEDIA_KINDS.includes(m.kind) && m.agents.includes('studio'));

/**
 * 把服务的媒体部分同步到 Studio 的托管服务 → { ok, studio:{ id, dialect } | null, skipped:[模型 id], warnings:[人话] }。
 * 有媒体模型、或者以前托管过（studio 字段在）才同步；以前托管过、现在一个媒体模型都没了，照样推一份空清单
 * （托管服务本身留着：Studio 的任务与作品历史按它的 id 引用，删服务时才删它）。
 * 失败不抛：ok:false + warning，由调用方决定回滚什么。
 */
export function syncStudio(s, keyOf) {
  const media = studioModels(s);
  if (!media.length && !s.studio) return { ok: true, studio: null, skipped: [], warnings: [] };
  const bridge = studioBridge();
  // 没有桥：调用方记 studioDirty，等 Studio 回来（下次带着它启动）时照当时的样子补推
  if (!bridge) return { ok: false, studio: s.studio || null, skipped: [], warnings: [`${NO_STUDIO}，媒体部分的改动等它启用后会自动补上`] };
  const { key, baseUrl } = mediaLine(s, keyOf);
  const input = {
    hubRef: s.id, name: s.name, baseUrl, authStyle: s.authStyle, headers: s.headers || [],
    enabled: s.enabled !== false && (s.lines || []).some((l) => l.enabled !== false),
    shared: s.members === true,   // 共享给成员：两边一个开关
    models: media.map((m) => ({ id: m.id, ...(m.label ? { label: m.label } : {}), kind: toStudioKind(m.kind) })),
  };
  const ks = sig(key);
  if (keySigs.get(s.id) !== ks) input.apiKey = key;   // Key 没变就不传（传了 Studio 会后台重刷 schema）
  let r;
  try { r = bridge.upsert(input); }
  catch (e) {
    return { ok: false, studio: s.studio || null, skipped: [], warnings: [`同步到 Media Studio 失败：${scrubKey(e?.message || e, key).slice(0, 300)}`] };
  }
  if ('apiKey' in input) keySigs.set(s.id, ks);
  const skipped = Array.isArray(r?.skipped) ? r.skipped : [];
  return {
    ok: true,
    studio: r && r.id ? { id: String(r.id), dialect: String(r.dialect || s.studio?.dialect || '') } : s.studio || null,
    skipped: skipped.map((x) => String(x.id)),
    warnings: skipped.map((x) => `「${x.id}」没有添加到 Media Studio：${scrubKey(x.reason || '不支持', key)}`),
  };
}

/**
 * 删服务时删托管服务 → { done, warnings }。done:false = 没删成（调用方记进待删清单，Studio 回来 / 下次改动前补删）。
 * 没有桥：以前没托管过就当删完了；托管过（或可能托管过）的等 Studio 回来再删。key 用来抹报错里的 Key。
 */
export function removeStudio(s, key = '') {
  keySigs.delete(s.id);
  const bridge = studioBridge();
  if (!bridge) return { done: !s.studio, warnings: s.studio ? [`${NO_STUDIO}：它那边托管的媒体服务等它启用后会自动删掉`] : [] };
  try { bridge.remove(s.id); return { done: true, warnings: [] }; }
  catch (e) {
    return { done: false, warnings: [`Media Studio 里托管的媒体服务没删掉：${scrubKey(e?.message || e, key).slice(0, 200)}，下次启动或下次改动时会再试`] };
  }
}

/** 收编 Studio 现有服务：打上托管标（id 不变），回连接信息与 Key（只在服务端内部用）。抛 Error（人话）。 */
export function adoptStudio(studioId, hubRef) {
  const bridge = studioBridge();
  if (!bridge) throw Object.assign(new Error(NO_STUDIO), { status: 400 });
  return bridge.adopt(studioId, hubRef);
}
/** 收编到一半失败时取消托管（服务原样留在 Studio）。 */
export function releaseStudio(hubRef) {
  const bridge = studioBridge();
  try { bridge?.release(hubRef); } catch (e) { console.error('[model-hub] 取消托管失败：', e?.message || e); }
}

/** Studio 的全部服务（总览用）；没有桥 = null。读不出来照抛（总览回 studio:[] + studioErr，不冒充「一个服务都没有」）。 */
export function studioList() {
  const bridge = studioBridge();
  if (!bridge) return null;
  return bridge.list();
}

/** 识别时问 Studio：这个地址能列出哪些媒体模型（超时由调用方的总截止决定）。没有桥回 null。抛 Error（人话，已去 Key）。 */
export async function detectStudio({ baseUrl, apiKey, authStyle, headers, dialect, useProxy }, ms) {
  const bridge = studioBridge();
  if (!bridge) return null;
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('Media Studio 识别超时'), { code: 'timeout' })), Math.max(1, ms)); timer.unref?.(); });
  try {
    // dialect：已托管的服务按托管时定下的方言问（桥的 detect 认这个参数）；没给就不传，让桥按地址认
    // useProxy:false（内网 / Tailscale 端点）：桥那边也直连，别让出站代理把内网地址截走
    const q = { baseUrl, apiKey, authStyle, headers, ...(dialect ? { dialect } : {}), ...(useProxy === false ? { useProxy: false } : {}) };
    const r = await Promise.race([Promise.resolve().then(() => bridge.detect(q)), t]);
    return {
      dialect: String(r?.dialect || 'openai'),
      kinds: MEDIA_KINDS.filter((k) => (r?.kinds || []).map(fromStudioKind).includes(k)),
      models: (Array.isArray(r?.models) ? r.models : []).map((m) => ({ id: String(m?.id || ''), label: m?.label, kind: fromStudioKind(m?.kind) })).filter((m) => m.id && MEDIA_KINDS.includes(m.kind)),
    };
  } catch (e) {
    throw Object.assign(new Error(scrubKey(e?.message || e, apiKey).slice(0, 300)), { status: e?.status, code: e?.code });
  } finally { clearTimeout(timer); }
}

/** Studio 的内置媒体服务（Vertex / 本机，不是「地址 + Key」，不托管）；没有桥或老桥 = null。 */
export function studioBuiltins() {
  const bridge = studioBridge();
  if (!bridge || typeof bridge.builtins !== 'function') return null;
  return bridge.builtins();
}
/** 改一个内置媒体服务（{ enabled?, shared?, models?: { id: bool } }）→ 改后的视图。抛 Error（人话）。 */
export function setStudioBuiltin(id, patch) {
  const bridge = studioBridge();
  if (!bridge) throw Object.assign(new Error(NO_STUDIO), { status: 400 });
  if (typeof bridge.setBuiltin !== 'function') throw Object.assign(new Error('Media Studio 版本太旧，先更新服务器'), { status: 400 });
  return bridge.setBuiltin(id, patch);
}

/** 地址按 Studio 认成哪种方言（不联网）；没有桥 = null。 */
export function studioDialectFor(baseUrl) {
  const bridge = studioBridge();
  if (!bridge) return null;
  try {
    const g = bridge.dialectFor(baseUrl);
    return { dialect: g.dialect, kinds: MEDIA_KINDS.filter((k) => (g.kinds || []).map(fromStudioKind).includes(k)) };
  } catch { return null; }
}

export { DIALECT_KINDS as _DIALECT_KINDS };
