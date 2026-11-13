// 作品（方案 §3.4）：就是核心媒体库（src/vertex-media.mjs，<媒体目录>/<id>.<ext> + <id>.json 侧车）的一个视图。
// 侧车在旧字段之外新增 provider / providerName / dialect / model / params / parents / jobId / wsPath；
// 旧侧车没有这些：服务按模型 id 推断方言（gpt-image → openrouter、本机 Qwen → local、Omni / lyria-3 → gemini、其余 vertex），
// 参数从旧的散字段里捡——旧历史在 Studio 里照常可见。URL 一律是规范地址 /api/vertex/media?id=（聊天内嵌、?token= 白名单、旧 apk 都认它）。
//
// 自动存进工作空间：设置 autoSave（默认开）+ saveDir（默认「Media Studio」，相对这个人自己的工作空间根）。
// 落点 <saveDir>/<图像|视频|配音|音乐>/<YYYYMMDD-HHmmss>-<提示词摘要>.<ext>，写盘后把相对路径记进侧车的 wsPath。

import path from 'node:path';
import { existsSync, mkdirSync, copyFileSync, rmSync, statSync } from 'node:fs';
import * as media from '@bridge/core/vertex-media.mjs';
import { ID_RE } from '@bridge/core/jsonfile.mjs';
import { safeJoin, mimeType } from '@bridge/core/runtime/http-file.mjs';
import { protectedTarget, uniquePath } from '@bridge/core/routes/file-core.mjs';
import { IMG_OPENROUTER } from '@bridge/core/config/capabilities.mjs';
import { googleDialectOf } from './cards/google.mjs';

export const ASSET_KINDS = ['image', 'video', 'audio', 'music'];
export const KIND_DIR = { image: '图像', video: '视频', audio: '配音', music: '音乐' };
// 生成任务的种类 → 作品的种类（配音在媒体库里一直叫 audio）
export const assetKindOf = (jobKind) => (jobKind === 'speech' ? 'audio' : jobKind);

const LEGACY_PARAM_KEYS = ['aspectRatio', 'imageSize', 'personGeneration', 'quality', 'thinkingLevel', 'useSearch', 'useImageSearch', 'resolution', 'durationSeconds',
  'generateAudio', 'task', 'voice', 'style', 'compressionQuality', 'steps', 'seed', 'cfg', 'count', 'width', 'height', 'transparent'];

export function inferDialect(model) {
  const m = String(model || '');
  if (Object.prototype.hasOwnProperty.call(IMG_OPENROUTER, m) || m.startsWith('openai/')) return 'openrouter';
  if (m === 'qwen-image-2.1-local') return 'local';
  return googleDialectOf(m);
}

/** 侧车记录 → Asset（§3.4 契约）。 */
export function publicAsset(rec) {
  const id = rec.id;
  const url = '/api/vertex/media?id=' + id;
  const kind = rec.kind || 'video';
  const params = rec.params && typeof rec.params === 'object'
    ? rec.params
    : Object.fromEntries(LEGACY_PARAM_KEYS.filter((k) => rec[k] !== undefined && rec[k] !== '').map((k) => [k, rec[k]]));
  const dialect = rec.dialect || inferDialect(rec.model);
  return {
    id, kind, mime: mimeType('x.' + (rec.ext || 'mp4')), url,
    ...(kind === 'image' || kind === 'video' ? { thumb: url + '&v=thumb' } : {}),
    prompt: rec.prompt || '', provider: rec.provider || dialect, ...(rec.providerName ? { providerName: rec.providerName } : {}), dialect,
    model: rec.model || '', params, parents: Array.isArray(rec.parents) ? rec.parents : [],
    ...(rec.width || rec.w ? { w: rec.width || rec.w } : {}), ...(rec.height || rec.h ? { h: rec.height || rec.h } : {}),
    ...(rec.duration ? { duration: rec.duration } : {}),
    createdAt: rec.created || 0,
    ...(rec.wsPath ? { wsPath: rec.wsPath } : {}),
    ...(rec.sessionId ? { thread: rec.sessionId } : {}),
    ...(rec.jobId ? { jobId: rec.jobId } : {}),
    ...(rec.negativePrompt ? { negative: rec.negativePrompt } : {}),
    ...(rec.source ? { source: rec.source } : {}),
  };
}

const PAGE = 60;
/** 作品列表：kind 筛选、q 搜提示词 / 模型、thread 只看一条续改链；cursor = 上一页最后一项的 '<时间>_<id>'。 */
export function listAssets(dir, { kind, cursor, q, thread, limit } = {}) {
  const k = kind === 'speech' ? 'audio' : kind;
  let recs = media.listRecords(dir, k && ASSET_KINDS.includes(k) ? [k] : ASSET_KINDS);
  if (thread) recs = recs.filter((r) => (r.sessionId || r.id) === thread);
  if (q) {
    const s = String(q).toLowerCase().slice(0, 200);
    recs = recs.filter((r) => String(r.prompt || '').toLowerCase().includes(s) || String(r.model || '').toLowerCase().includes(s));
  }
  if (cursor) {
    const m = /^(\d+(?:\.\d+)?)_(.+)$/.exec(String(cursor));
    if (m) {
      const at = Number(m[1]), cid = m[2];
      const i = recs.findIndex((r) => r.created < at || (r.created === at && r.id < cid));
      recs = i < 0 ? [] : recs.slice(i);
    }
  }
  const n = Math.min(200, Math.max(1, Number(limit) || PAGE));
  const page = recs.slice(0, n);
  const last = page[page.length - 1];
  return { items: page.map(publicAsset), cursor: recs.length > n && last ? `${last.created}_${last.id}` : null };
}

// —— 存进工作空间 ——
const pad = (n) => String(n).padStart(2, '0');
function stamp(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
// 提示词摘要：去掉文件名非法字符与换行，最多 24 个字
export function promptSlug(prompt) {
  const s = String(prompt || '').replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, 24).join('').trim().replace(/[. ]+$/, '') || '未命名';
}

/** 工作空间里的目标目录（相对路径 → 绝对路径）；越界、指向 .bridge 等受保护位置回 null。 */
function wsDir(ctx, rel) {
  const dest = safeJoin(ctx.cwd, String(rel || '').replace(/\\/g, '/'));
  if (!dest || protectedTarget(ctx.cwd, path.join(dest, 'x'), ctx)) return null;
  return dest;
}
const relOf = (ctx, abs) => path.relative(path.resolve(ctx.cwd), abs).split(path.sep).join('/');

/** 把作品复制进工作空间：dir = 相对工作空间根的目录（不给 = <saveDir>/<种类>），name 不给按规则起。回相对路径。 */
export function copyToWorkspace(ctx, rec, { dir, name, saveDir = 'Media Studio' } = {}) {
  const src = media.fileFor(rec.id, ctx.media);
  if (!src) throw Object.assign(new Error('作品文件不见了'), { status: 404 });
  const rel = dir != null ? String(dir) : [saveDir, KIND_DIR[rec.kind] || '其他'].filter(Boolean).join('/');
  const target = wsDir(ctx, rel);
  if (!target) throw Object.assign(new Error('保存位置越界或是受保护目录'), { status: 400 });
  mkdirSync(target, { recursive: true });
  const ext = rec.ext || path.extname(src).slice(1);
  let base = name ? String(name).replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 120) : `${stamp(rec.created)}-${promptSlug(rec.prompt)}`;
  if (!base) base = stamp(rec.created);
  if (!base.toLowerCase().endsWith('.' + ext)) base += '.' + ext;
  const dest = uniquePath(path.join(target, base));
  copyFileSync(src, dest);
  return relOf(ctx, dest);
}

/** 生成完自动存：失败不影响任务（记日志）。回 wsPath 或 ''。 */
export function autoSave(ctx, rec, settings) {
  if (!settings || !settings.autoSave || !ctx || !ctx.cwd) return '';
  try {
    const wsPath = copyToWorkspace(ctx, rec, { saveDir: settings.saveDir ?? 'Media Studio' });
    media.updateMeta(rec.id, { wsPath }, ctx.media);
    return wsPath;
  } catch (e) {
    console.error('[studio] 自动存进工作空间失败：', rec.id, (e && e.message) || e);
    return '';
  }
}

/** 手动另存：POST /api/studio/assets/<id>/save { dir?, name? }。 */
export function saveAsset(ctx, id, { dir, name } = {}, settings = {}) {
  const rec = ID_RE.test(String(id)) ? media.get(id, ctx.media) : null;
  if (!rec) throw Object.assign(new Error('没有这个作品'), { status: 404 });
  const wsPath = copyToWorkspace(ctx, rec, { dir: dir || undefined, name, saveDir: settings.saveDir ?? 'Media Studio' });
  const next = media.updateMeta(id, { wsPath }, ctx.media);
  return { wsPath, asset: publicAsset(next) };
}

/** 删作品：媒体库里的文件与侧车（含缩略图）；withFile 时连工作空间里那份自动存的副本一起删（只删 wsPath 指的那一个文件）。 */
export function deleteAsset(ctx, id, { withFile = false } = {}) {
  const rec = ID_RE.test(String(id)) ? media.get(id, ctx.media) : null;
  if (!rec) return false;
  if (withFile && rec.wsPath) {
    const abs = safeJoin(ctx.cwd, rec.wsPath);
    try { if (abs && !protectedTarget(ctx.cwd, abs, ctx) && existsSync(abs) && statSync(abs).isFile()) rmSync(abs); } catch {}
  }
  // 记录在但删不掉（文件被占用等）不能回 false——路由会把它说成「没有这个作品」，前端又会当已删
  if (!media.remove(id, ctx.media)) throw Object.assign(new Error('作品文件删不掉（可能被占用），请稍后重试'), { status: 500 });
  return true;
}

export function assetExists(ctx, id) { return ID_RE.test(String(id)) && !!media.get(id, ctx.media); }

export function getAsset(ctx, id) {
  const rec = ID_RE.test(String(id)) ? media.get(id, ctx.media) : null;
  return rec && ASSET_KINDS.includes(rec.kind || 'video') ? publicAsset(rec) : null;
}
