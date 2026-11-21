// 插件页面宿主文件选择器的纯函数：accept 过滤、扩展名 → MIME、大小显示、面包屑。
// 界面在 components/pickers/FilePickerSheet.svelte，状态在 lib/filePicker.svelte.js；这里不 import 任何东西，
// 好让 node --test 直接跑（pickerCore.test.js）。

// 只为 accept 过滤用的粗粒度表（真正发给页面的 mime 由服务端签句柄时按扩展名给，见 src/plugins/page-files.mjs）。
// 代码 / 配置类纯文本一律算 text/plain：插件写 accept: 'text/*' 时，用户期望能选到 .js / .yml 这类文件。
const MIME = {
  txt: 'text/plain', log: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  html: 'text/html', htm: 'text/html', css: 'text/css', xml: 'text/xml', ics: 'text/calendar', vtt: 'text/vtt',
  js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript',
  json: 'application/json', pdf: 'application/pdf', zip: 'application/zip', gz: 'application/gzip', tar: 'application/x-tar',
  '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar', wasm: 'application/wasm',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp',
  svg: 'image/svg+xml', ico: 'image/x-icon', heic: 'image/heic', heif: 'image/heif', avif: 'image/avif', tif: 'image/tiff', tiff: 'image/tiff',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/opus', amr: 'audio/amr',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/x-msvideo', '3gp': 'video/3gpp',
};
const PLAIN = new Set(['ts', 'tsx', 'jsx', 'vue', 'svelte', 'scss', 'less', 'yml', 'yaml', 'toml', 'ini', 'conf', 'env', 'sh', 'bat', 'ps1',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'php', 'lua', 'c', 'h', 'cpp', 'cc', 'hpp', 'cs', 'sql', 'r', 'tex', 'rst']);

/** 扩展名（小写、不带点）；没有扩展名回 ''（「.gitignore」这种整个名字就是点开头的也算没有）。 */
export function extOfName(name) {
  const s = String(name ?? '');
  const i = s.lastIndexOf('.');
  return i > 0 && i < s.length - 1 ? s.slice(i + 1).toLowerCase() : '';
}

/** 按扩展名猜 MIME；认不出回 application/octet-stream。 */
export function mimeOfName(name) {
  const e = extOfName(name);
  if (MIME[e]) return MIME[e];
  if (PLAIN.has(e)) return 'text/plain';
  return 'application/octet-stream';
}

/**
 * 解析 accept（同 <input type=file accept> 的写法：逗号分隔的 '.ext'、'type/*'、'type/subtype'；也容许不带点的 'md'）。
 * 回 { any, exts:Set, types:Set, prefixes:Set }；空串或含 '*' / '*\/*' 时 any = true（全都能选）。
 * 太长的串（页面传的上限 200 字）只取前 400 字，最多认 64 项。
 */
export function parseAccept(accept) {
  const out = { any: false, exts: new Set(), types: new Set(), prefixes: new Set() };
  const parts = String(accept ?? '').slice(0, 400).split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean).slice(0, 64);
  for (const p of parts) {
    if (p === '*' || p === '*/*') { out.any = true; continue; }
    const m = /^([a-z0-9][a-z0-9.+-]*)\/(\*|[a-z0-9][a-z0-9.+-]*)$/.exec(p);
    if (m) { if (m[2] === '*') out.prefixes.add(m[1] + '/'); else out.types.add(p); continue; }
    const ext = p.replace(/^\*?\./, '');
    if (/^[a-z0-9][a-z0-9_+-]{0,15}$/.test(ext)) out.exts.add(ext);
  }
  if (!out.exts.size && !out.types.size && !out.prefixes.size) out.any = true;
  return out;
}

/** accept → (文件名) => 能不能选。文件夹不经过这里（文件夹一律可进、不可选）。 */
export function acceptMatcher(accept) {
  const a = parseAccept(accept);
  if (a.any) return () => true;
  return (name) => {
    const e = extOfName(name);
    if (e && a.exts.has(e)) return true;
    const mime = mimeOfName(name);
    if (a.types.has(mime)) return true;
    for (const p of a.prefixes) if (mime.startsWith(p)) return true;
    return false;
  };
}

/** 字节数 → 「12 KB」「3.4 MB」；不是数字回 ''。 */
export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '';
  if (v < 1024) return Math.round(v) + ' B';
  if (v < 1048576) return Math.max(1, Math.round(v / 1024)) + ' KB';
  if (v < 1073741824) return (v / 1048576).toFixed(1) + ' MB';
  return (v / 1073741824).toFixed(2) + ' GB';
}

/** 相对路径 'a/b/c' → [{ name:'a', rel:'a' }, { name:'b', rel:'a/b' }, { name:'c', rel:'a/b/c' }]（不含根）。 */
export function crumbsOf(rel) {
  const segs = String(rel ?? '').split(/[\\/]+/).filter((s) => s && s !== '.');
  const out = [];
  for (let i = 0; i < segs.length; i++) out.push({ name: segs[i], rel: segs.slice(0, i + 1).join('/') });
  return out;
}

/** 目录 dir 下名为 name 的项的相对路径（根目录下就是 name 本身）。 */
export const joinRel = (dir, name) => (dir ? dir + '/' + name : String(name ?? ''));

/** 上一级目录的相对路径；已在根回 ''。 */
export function parentRel(rel) {
  const c = crumbsOf(rel);
  return c.length > 1 ? c[c.length - 2].rel : '';
}
