import path from 'node:path';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { pipeline } from 'node:stream';

export const MIME_TYPES = Object.freeze({
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  heic: 'image/heic',
  heif: 'image/heif',
  svg: 'image/svg+xml',
  pdf: 'application/pdf',
  md: 'text/markdown; charset=utf-8',
  markdown: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  tsv: 'text/tab-separated-values; charset=utf-8',
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  yaml: 'application/yaml; charset=utf-8',
  yml: 'application/yaml; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  cjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4v: 'video/x-m4v',
  mkv: 'video/x-matroska',
  avi: 'video/x-msvideo',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  opus: 'audio/opus',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  tar: 'application/x-tar',
  gz: 'application/gzip',
  tgz: 'application/gzip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  apk: 'application/vnd.android.package-archive',
});

// These types can execute script, style, or active markup when served from the
// bridge origin. File-preview/download endpoints use safe=true and expose source
// text instead; metadata sent to an agent can still request the real MIME.
const ACTIVE_TEXT_EXTENSIONS = new Set([
  'html', 'htm', 'svg', 'xml', 'js', 'mjs', 'cjs', 'ts', 'jsx', 'tsx', 'css',
  'vue', 'py', 'rb', 'go', 'rs', 'sh', 'bat', 'ps1', 'ini', 'toml', 'conf',
  'env', 'sql', 'yaml', 'yml',
]);

export function fileExtension(name = '') {
  return path.extname(String(name)).slice(1).toLowerCase();
}

export function mimeType(name, { safe = false, fallback = 'application/octet-stream' } = {}) {
  const ext = fileExtension(name);
  if (safe && ACTIVE_TEXT_EXTENSIONS.has(ext)) return 'text/plain; charset=utf-8';
  return MIME_TYPES[ext] || fallback;
}

// Preserve the established workspace semantics: client traversal and drive
// segments are discarded, then the rebuilt path is checked under the root.
// 「target 是不是落在 root 之内」的字面前缀判定。
//
// 必须走这个函数、别再手写 `startsWith(root + path.sep)`：**盘根**（'D:\'）经 path.resolve
// 出来【自带】尾分隔符，再拼一个就成了 'D:\\'，于是它的任何子路径都过不了前缀判定。
// 症状：「新建项目」位置栏点进 C:/D: 下的【任何】文件夹都 HTTP 403（不分名字，
// 'Program Files' 与 '.Root' 一样中招），而盘根自己因为 target===base 反而列得出来，
// 看起来就像「只有这个文件夹坏了」。
export function withinRoot(root, target) {
  const base = path.resolve(root);
  const abs = path.resolve(target);
  if (abs === base) return true;
  return abs.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}

export function safeJoin(root, rel) {
  const base = path.resolve(root);
  const parts = String(rel || '')
    .split(/[\\/]+/)
    .filter((part) => part && part !== '.' && part !== '..' && !/^[a-zA-Z]:$/.test(part));
  const target = path.resolve(base, ...parts);
  return withinRoot(base, target) ? target : null;
}

export function isPathInside(file, root, { resolveLinks = true } = {}) {
  if (!root) return false;
  try {
    const base = resolveLinks ? realpathSync(root) : path.resolve(root);
    const target = resolveLinks ? realpathSync(file) : path.resolve(file);
    const rel = path.relative(base, target);
    return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

// One RFC 7233 byte range only. Multi-range requests are rejected instead of
// being partially/misleadingly honored. Returns null when there is no Range.
export function parseByteRange(value, total) {
  if (value === undefined || value === null || value === '') return null;
  if (!Number.isSafeInteger(total) || total <= 0) return { unsatisfiable: true };
  const match = /^bytes=(\d*)-(\d*)$/i.exec(String(value).trim());
  if (!match || (!match[1] && !match[2])) return { unsatisfiable: true };

  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { unsatisfiable: true };
    return { start: Math.max(0, total - suffix), end: total - 1 };
  }

  const start = Number(match[1]);
  let end = match[2] ? Number(match[2]) : total - 1;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || start >= total || end < start) return { unsatisfiable: true };
  end = Math.min(end, total - 1);
  return { start, end };
}

export function streamFile(req, res, file, options = {}) {
  const st = options.stat || statSync(file);
  if (!st.isFile()) throw Object.assign(new Error('not found'), { status: 404 });
  if (options.cleanup) res.once('close', () => { try { options.cleanup(); } catch {} });

  const rangeEnabled = options.range !== false;
  const headers = {
    'Content-Type': options.contentType || mimeType(options.name || file, { safe: options.safeMime !== false }),
    ...(rangeEnabled ? { 'Accept-Ranges': 'bytes' } : {}),
    ...(options.cacheControl ? { 'Cache-Control': options.cacheControl } : {}),
    ...(options.headers || {}),
  };
  if (options.disposition) headers['Content-Disposition'] = options.disposition;
  else if (options.downloadName) {
    headers['Content-Disposition'] = `${options.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(options.downloadName)}`;
  }

  const range = rangeEnabled ? parseByteRange(req.headers.range, st.size) : null;
  if (range?.unsatisfiable) {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${st.size}`, 'Content-Length': 0 });
    res.end();
    return { status: 416 };
  }

  const readOptions = options.highWaterMark ? { highWaterMark: options.highWaterMark } : {};
  if (range) {
    const { start, end } = range;
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${start}-${end}/${st.size}`,
      'Content-Length': end - start + 1,
    });
    pipeline(createReadStream(file, { ...readOptions, start, end }), res, () => {});
    return { status: 206, start, end };
  }

  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  pipeline(createReadStream(file, readOptions), res, () => {});
  return { status: 200 };
}
