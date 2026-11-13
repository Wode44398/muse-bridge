// 工具结果里的图片（Read 一张 jpg、截图、浏览器截屏、computer use 每步截屏）→ 状态行缩略图条。
//
// 官方 4.4212 的 TurnStatus 把本段工具结果里的图片收集起来挂在状态行右侧（最多 3 张 +N，点开灯箱）。
// bridge 的工具事件不带结果正文，所以由这里把图片落到身份自己的 media 目录下的 tool-images/：
//   · 直播：agents/claude.mjs 在 tool_result 回来时 saveToolImages()，tool_done 帧只带张数（images: n）；
//   · 历史：sessions.mjs 解析时只数张数（countToolImages），不落盘、不留 base64；
//   · 取图：GET /api/tool-image?sid&t&n —— 先查缓存文件，没有就回到 transcript 找那条 tool_result 现取现存。
// 文件名 = <tool_use_id>-<序号>.<ext>；tool_use_id 只含 [A-Za-z0-9_]，按白名单校验后才拼路径。

import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import readline from 'node:readline';

export const TOOL_ID_RE = /^[A-Za-z0-9_]{6,80}$/;
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const MAX_BYTES = 20 * 1024 * 1024;   // 单张上限（base64 解码后）；再大的不进缩略图条
const MAX_PER_TOOL = 24;

export const toolImageDir = (mediaDir) => path.join(mediaDir, 'tool-images');

// tool_result 块里的图片：SDK 形态 {type:'image', source:{type:'base64', media_type, data}}，
// MCP 直出形态 {type:'image', data, mimeType}。只认 base64，url 形态的图不存。
export function imageParts(blk) {
  const c = blk && Array.isArray(blk.content) ? blk.content : [];
  const out = [];
  for (const x of c) {
    if (!x || x.type !== 'image') continue;
    const src = x.source && typeof x.source === 'object' ? x.source : null;
    const mime = String((src && src.media_type) || x.mimeType || x.media_type || '').toLowerCase();
    const data = src ? (src.type === 'base64' ? src.data : '') : x.data;
    if (!EXT[mime] || typeof data !== 'string' || !data) continue;
    out.push({ mime, data });
    if (out.length >= MAX_PER_TOOL) break;
  }
  return out;
}
export const countToolImages = (blk) => imageParts(blk).length;

function fileOf(dir, toolUseId, n) {
  for (const ext of ['png', 'jpg', 'webp', 'gif']) {
    const f = path.join(dir, `${toolUseId}-${n}.${ext}`);
    if (fs.existsSync(f)) return f;
  }
  return null;
}

function writeParts(dir, toolUseId, parts) {
  fs.mkdirSync(dir, { recursive: true });
  let n = 0;
  for (const p of parts) {
    const buf = Buffer.from(p.data, 'base64');
    if (buf.length > MAX_BYTES) { n++; continue; }
    const f = path.join(dir, `${toolUseId}-${n}.${EXT[p.mime]}`);
    if (!fs.existsSync(f)) { fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f); }
    n++;
  }
  return n;
}

// 直播：落盘并返回张数（0 = 没有图）。失败不抛——缩略图是锦上添花，别拖垮工具收尾。
export function saveToolImages(mediaDir, toolUseId, blk) {
  if (!mediaDir || !TOOL_ID_RE.test(String(toolUseId || ''))) return 0;
  const parts = imageParts(blk);
  if (!parts.length) return 0;
  try { return writeParts(toolImageDir(mediaDir), toolUseId, parts); } catch { return 0; }
}

// transcript 里找这条工具结果的图片（历史会话第一次看缩略图时）：逐行扫，只解析含该 id 的行。
async function extractFromTranscript(file, toolUseId) {
  const needle = `"tool_use_id":"${toolUseId}"`;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      if (!line.includes(needle) || !line.includes('"tool_result"')) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const blocks = o && o.message && Array.isArray(o.message.content) ? o.message.content : [];
      for (const b of blocks) if (b && b.type === 'tool_result' && b.tool_use_id === toolUseId) return imageParts(b);
    }
  } finally { rl.close(); }
  return [];
}

// 取第 n 张（缓存优先，缺了按 transcript 现取）。返回文件路径或 null。
export async function toolImageFile(mediaDir, toolUseId, n, transcriptFile) {
  if (!mediaDir || !TOOL_ID_RE.test(String(toolUseId || '')) || !(n >= 0 && n < MAX_PER_TOOL)) return null;
  const dir = toolImageDir(mediaDir);
  const hit = fileOf(dir, toolUseId, n);
  if (hit || !transcriptFile) return hit;
  try {
    const parts = await extractFromTranscript(transcriptFile, toolUseId);
    if (!parts.length) return null;
    writeParts(dir, toolUseId, parts);
  } catch { return null; }
  return fileOf(dir, toolUseId, n);
}

// 缩略图（状态行 24px 高、悬停预览 320px）：sharp 懒生成 webp 并落盘；sharp 不在 / 失败回 null，调用方回原图。
const _deriving = new Map();
export async function toolImageThumb(file) {
  if (/\.gif$/i.test(file)) return null;
  const out = file.replace(/\.[a-z]+$/i, '.thumb.webp');
  if (fs.existsSync(out)) return out;
  if (_deriving.has(out)) return _deriving.get(out);
  const job = (async () => {
    try {
      const sharp = (await import('sharp')).default;
      await sharp(file).rotate().resize(480, 480, { fit: 'inside', withoutEnlargement: true }).webp({ quality: 72 }).toFile(out + '.tmp');
      await fsp.rename(out + '.tmp', out);
      return out;
    } catch { return null; }
    finally { _deriving.delete(out); }
  })();
  _deriving.set(out, job);
  return job;
}
