// 从助手回复的 Markdown 链接中提取落盘产物并校验目录边界（仅限当前工作目录、已授权附加目录、上传目录，
// 以及会话自己的产物目录——agy 自带的生图把成品存在那里）。

import { realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileExtension, isPathInside, mimeType } from '@bridge/core/runtime/http-file.mjs';
import { normalizeAgyPath } from './paths.mjs';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus']);
const ARTIFACT_EXT = 'png|jpe?g|gif|webp|bmp|heic|heif|avif|svg|pdf|md|txt|json|csv|tsv|html?|mp4|webm|mov|m4v|avi|mkv|mp3|wav|m4a|aac|ogg|flac|opus|docx?|xlsx?|pptx?|zip|tar|gz';

export function deliverableKindOf(name = '') {
  const ext = fileExtension(name);
  if (IMAGE_EXT.has(ext) || ext === 'svg') return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['md', 'txt', 'json', 'csv', 'tsv', 'html', 'htm', 'js', 'mjs', 'ts', 'tsx', 'jsx', 'css', 'py', 'ps1', 'sh', 'yaml', 'yml', 'xml', 'log'].includes(ext)) return 'text';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'office';
  return 'file';
}

export function artifactFor(file, source = 'assistant_link') {
  try {
    const real = realpathSync(file);
    const st = statSync(real);
    if (!st.isFile()) return null;
    return {
      name: path.basename(real),
      path: real,
      kind: deliverableKindOf(real),
      size: st.size,
      mime: mimeType(real, { fallback: '' }),
      source,
    };
  } catch {
    return null;
  }
}

export function extractDeliverablePaths(text, cwd) {
  const s = String(text || '');
  const out = [];
  // 同时兼容标准百分号编码（%28/%29）与模型手写的一层平衡括号文件名（如 x (1).png）
  const linked = new RegExp('\\]\\(((?:[^()\\r\\n]|\\([^()\\r\\n]*\\))+?\\.(?:' + ARTIFACT_EXT + '))\\)', 'gi');
  let match;
  while ((match = linked.exec(s)) !== null) {
    const raw = match[1].trim().replace(/^<|>$/g, '');
    if (!raw || /^(?:https?|data|mailto):/i.test(raw)) continue;
    const norm = normalizeAgyPath(raw);
    if (!norm) continue;
    out.push(path.isAbsolute(norm) ? norm : (cwd ? path.resolve(cwd, norm) : norm));
  }
  return out;
}

// 会话产物目录里能当成品交付的文件：目录本身之下、且不在 agy 的内部记录（.system_generated）里
export function isSessionArtifact(file, artifactDir) {
  if (!artifactDir || !isPathInside(file, artifactDir)) return false;
  const rel = path.relative(artifactDir, file);
  return !!rel && rel.split(path.sep)[0] !== '.system_generated';
}

export function collectDeliverableAttachments(text, { workDir = '', additionalDirectories = [], uploads = '', artifactDir = '' } = {}) {
  const attachments = [];
  const allowedRoots = [workDir, ...(Array.isArray(additionalDirectories) ? additionalDirectories : []), uploads].filter(Boolean);
  let realArtifactDir = '';
  if (artifactDir) { try { realArtifactDir = realpathSync(artifactDir); } catch {} }
  if (!text || (!allowedRoots.length && !realArtifactDir)) return attachments;
  const seenPaths = new Set();
  for (const candidate of extractDeliverablePaths(text, workDir)) {
    const resolved = path.resolve(candidate);
    if (seenPaths.has(resolved)) continue;
    seenPaths.add(resolved);
    const art = artifactFor(resolved);
    if (!art) continue;
    if (!allowedRoots.some((root) => isPathInside(art.path, root)) && !isSessionArtifact(art.path, realArtifactDir)) continue;
    attachments.push(art);
    if (attachments.length >= 12) break;
  }
  return attachments;
}
