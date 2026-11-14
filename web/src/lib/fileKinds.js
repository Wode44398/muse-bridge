// 文件类型的【单一词表】——「这个文件用哪个查看器打开、显示什么图标、按什么语言高亮」只在这里判。
//
// 起因：preview.svelte.js、FilesPanel、FilesDesktop、SharePage 各有一份扩展名表，互相对不上：
// 同一个 .toml 在聊天产物里能看、在文件管理器里「暂不支持」；csv 在预览表里算 Office、在文件管理器里点不开；
// svg 一边当图、一边当源码；Dockerfile / .gitignore 这类无扩展名文件到处落「无法预览」。
// 现在统一从这里派生：
//   kindOf(name, mime?)   → 预览分类（MediaViewer 路由用）：image | video | audio | pdf | markdown | office | html | text | other
//   iconKindOf(name, opt) → 列表图标分类：dir | image | video | audio | pdf | doc | sheet | slide | md | html | zip | code | text | font | book | design | app | file
//   canPreview(name,mime) → 有没有内嵌查看器（kind !== 'other'）
//   langOf(name)          → 代码高亮语言 id（'' = 纯文本）
//   officeCat(name)       → Office 子类：word | sheet | slides | null
//   SERVER_OFFICE_EXT     → 服务端 LibreOffice 转 PDF 认的扩展名（与 src/routes/file-preview.mjs 的 OFFICE_EXT 同一份，改要两边一起改）
//   sniffText(bytes)      → 无扩展名 / 未知扩展名文件的内容嗅探（前 4KB 无 NUL 且是合法 UTF-8 或像 GBK 即当文本）
//   sniffUrl(url)         → 拉前 4KB 做嗅探（Range 请求；调用方自己决定何时用，列表里别对每个文件都发）
//
// 纪律：本模块零依赖（不 import 任何东西），服务端、测试、任何组件都能直接用。

// —— 扩展名表：ext → [预览分类, 图标分类, 代码语言?] ——
const T = Object.create(null);
function put(exts, kind, icon, lang = '') { for (const e of exts.split(' ')) T[e] = [kind, icon, lang]; }

// 图片：浏览器 <img> 能直接画的；svg 按图片打开（<img> 渲染不执行脚本，安全），查看器里另给「查看源码」
put('png jpg jpeg jpe jfif pjpeg pjp gif webp bmp avif ico apng', 'image', 'image');
put('svg', 'image', 'image', 'xml');
// heic/heif：Chromium/WebView 解不了，但服务端或原生缩略档可能能出，仍按图片路由（失败走查看器的错误态 + 下载）
put('heic heif', 'image', 'image');
// tif/tiff、raw、psd：没有渲染器，只给图标
put('tif tiff', 'other', 'image');
put('cr2 cr3 nef arw dng raf orf rw2 srw pef', 'other', 'image');
put('psd ai sketch fig xd afdesign afphoto kra xcf', 'other', 'design');

put('mp4 m4v mov webm mkv avi 3gp 3g2 ogv', 'video', 'video');
put('ts mts m2ts flv wmv rm rmvb vob', 'other', 'video');   // ts 另见代码表：.ts 是 TypeScript（下面覆盖）
put('mp3 wav m4a aac flac ogg oga opus amr weba', 'audio', 'audio');
put('wma ape aiff aif mid midi', 'other', 'audio');

put('pdf', 'pdf', 'pdf');
put('md markdown mdown mkd mkdn', 'markdown', 'md');

// Office：word / sheet / slides 三个子类。csv/tsv 走 OfficeView 的表格（SheetJS），不送服务端转 PDF。
// docm/xlsm/pptm/ppsx 是同一套 OOXML 压缩包，客户端回落（mammoth / SheetJS / 解包抽文字）也读得了；
// 二进制的 pps / WPS 私有格式（wps/et/dps）客户端读不了、服务端也不收，只给图标。
put('doc docx docm odt rtf', 'office', 'doc');
put('xls xlsx xlsm ods csv tsv', 'office', 'sheet');
put('ppt pptx pptm ppsx odp', 'office', 'slide');
put('pages wps', 'other', 'doc');
put('numbers et', 'other', 'sheet');
put('key pps dps', 'other', 'slide');

put('html htm xhtml', 'html', 'html');

// 文本 / 代码（DocViewer 文本模式；后续 CodeView 按 lang 高亮）
put('txt text log out', 'text', 'text');
put('js mjs cjs jsx', 'text', 'code', 'javascript');
put('ts mts cts tsx', 'text', 'code', 'typescript');
put('json jsonc json5 ndjson jsonl geojson webmanifest har ipynb', 'text', 'code', 'json');
put('css', 'text', 'code', 'css');
put('scss sass', 'text', 'code', 'sass');
put('less', 'text', 'code', 'less');
put('styl stylus', 'text', 'code', 'stylus');
put('xml xsd xsl xslt plist rss atom opml wsdl csproj vcxproj resx xaml', 'text', 'code', 'xml');
put('yml yaml', 'text', 'code', 'yaml');
put('toml', 'text', 'code', 'toml');
put('ini cfg conf cnf properties prefs inf reg', 'text', 'code', 'properties');
put('env', 'text', 'code', 'shell');
put('sh bash zsh fish ksh command', 'text', 'code', 'shell');
put('bat cmd', 'text', 'code', 'batch');
put('ps1 psm1 psd1', 'text', 'code', 'powershell');
put('py pyw pyi', 'text', 'code', 'python');
put('rb gemspec rake', 'text', 'code', 'ruby');
put('go', 'text', 'code', 'go');
put('rs', 'text', 'code', 'rust');
put('java', 'text', 'code', 'java');
put('kt kts', 'text', 'code', 'kotlin');
put('scala sc', 'text', 'code', 'scala');
put('groovy gradle', 'text', 'code', 'groovy');
put('swift', 'text', 'code', 'swift');
put('c h', 'text', 'code', 'c');
put('cpp cc cxx c++ hpp hh hxx h++ ino', 'text', 'code', 'cpp');
put('cs csx', 'text', 'code', 'csharp');
put('m mm', 'text', 'code', 'objectivec');
put('php phtml', 'text', 'code', 'php');
put('lua', 'text', 'code', 'lua');
put('pl pm', 'text', 'code', 'perl');
put('r rmd', 'text', 'code', 'r');
put('dart', 'text', 'code', 'dart');
put('sql psql', 'text', 'code', 'sql');
put('graphql gql', 'text', 'code', 'graphql');
put('proto', 'text', 'code', 'protobuf');
put('vue', 'text', 'code', 'vue');
put('svelte', 'text', 'code', 'svelte');
put('astro', 'text', 'code', 'astro');
put('tex sty cls bib ltx', 'text', 'code', 'latex');
put('rst', 'text', 'text', 'rst');
put('adoc asciidoc org', 'text', 'text');
put('diff patch', 'text', 'code', 'diff');
put('srt vtt ass ssa sub lrc', 'text', 'text');
put('dockerfile containerfile', 'text', 'code', 'dockerfile');
put('mk mak make', 'text', 'code', 'makefile');
put('cmake', 'text', 'code', 'cmake');
put('tf tfvars hcl', 'text', 'code', 'hcl');
put('nix', 'text', 'code', 'nix');
put('zig', 'text', 'code', 'zig');
put('ex exs', 'text', 'code', 'elixir');
put('erl hrl', 'text', 'code', 'erlang');
put('hs lhs', 'text', 'code', 'haskell');
put('clj cljs cljc edn', 'text', 'code', 'clojure');
put('lisp el scm rkt', 'text', 'code', 'scheme');
put('jl', 'text', 'code', 'julia');
put('asm s nasm', 'text', 'code', 'gas');
put('vim', 'text', 'code', 'vim');
put('vb vbs bas', 'text', 'code', 'vb');
put('fs fsx fsi', 'text', 'code', 'fsharp');
put('sol', 'text', 'code', 'solidity');
put('lock', 'text', 'text');
put('gitignore gitattributes gitmodules dockerignore npmignore editorconfig npmrc nvmrc yarnrc browserslistrc', 'text', 'code', 'properties');
put('ics vcf vcard eml', 'text', 'text');

// 其余只给图标的大类
put('zip rar 7z tar gz tgz bz2 tbz2 xz txz zst lz lzma cab iso dmg', 'other', 'zip');
put('ttf otf woff woff2 eot ttc', 'other', 'font');
put('epub mobi azw azw3 fb2 djvu cbz cbr', 'other', 'book');
put('apk aab ipa exe msi msix appx deb rpm appimage', 'other', 'app');
put('db sqlite sqlite3 parquet feather arrow avro', 'other', 'file');

// —— 无扩展名 / 点文件白名单（文件名整名，小写比较）——
const NAMES = Object.create(null);
function names(list, kind, icon, lang = '') { for (const n of list.split(' ')) NAMES[n] = [kind, icon, lang]; }
names('dockerfile containerfile', 'text', 'code', 'dockerfile');
names('makefile gnumakefile bsdmakefile', 'text', 'code', 'makefile');
names('jenkinsfile vagrantfile gemfile rakefile podfile fastfile brewfile guardfile', 'text', 'code', 'ruby');
names('procfile caddyfile justfile', 'text', 'code', 'properties');
names('cmakelists.txt', 'text', 'code', 'cmake');
names('license licence copying notice authors contributors readme changelog changes history todo version codeowners install', 'text', 'text');
names('.gitignore .gitattributes .gitmodules .gitkeep .dockerignore .npmignore .eslintignore .prettierignore .editorconfig .npmrc .nvmrc .yarnrc .browserslistrc .htaccess .mailmap', 'text', 'code', 'properties');
names('.bashrc .bash_profile .bash_logout .zshrc .zprofile .profile .inputrc', 'text', 'code', 'shell');
names('.vimrc .gvimrc', 'text', 'code', 'vim');
names('.prettierrc .eslintrc .babelrc .stylelintrc .swcrc .jshintrc', 'text', 'code', 'json');

const MD_NAMES = /^(readme|changelog|contributing|license|security|code_of_conduct)\.(md|markdown)$/;

// —— 取扩展名 ——
// 只看最后一段路径；点文件（.gitignore）与无点文件名（Makefile）都没有扩展名，交给整名白名单。
export function baseName(name = '') { return String(name).split(/[\\/]/).pop() || ''; }
export function extOf(name = '') {
  const b = baseName(name);
  const i = b.lastIndexOf('.');
  if (i <= 0) return '';
  return b.slice(i + 1).toLowerCase();
}

function lookup(name) {
  const b = baseName(name).toLowerCase();
  if (NAMES[b]) return NAMES[b];
  if (/^\.env(\..+)?$/.test(b)) return ['text', 'code', 'shell'];           // .env / .env.local / .env.production
  if (/^\.(bash|zsh)_[\w.-]+$/.test(b)) return ['text', 'code', 'shell'];
  if (MD_NAMES.test(b)) return T.md;
  const e = extOf(b);
  if (e && T[e]) return T[e];
  return null;
}

// mime 兜底（没扩展名但服务端 / 调用方给了类型）
function byMime(mime = '') {
  const m = String(mime).toLowerCase().split(';')[0].trim();
  if (!m) return null;
  if (m === 'image/tiff') return ['other', 'image', ''];
  if (m === 'image/svg+xml') return T.svg;
  if (m.startsWith('image/')) return ['image', 'image', ''];
  if (m.startsWith('video/')) return ['video', 'video', ''];
  if (m.startsWith('audio/')) return ['audio', 'audio', ''];
  if (m === 'application/pdf') return T.pdf;
  if (m === 'text/markdown') return T.md;
  if (m === 'text/html' || m === 'application/xhtml+xml') return T.html;
  if (m === 'text/csv') return T.csv;
  if (m === 'application/json' || m.endsWith('+json')) return T.json;
  if (m === 'application/xml' || m === 'text/xml' || m.endsWith('+xml')) return T.xml;
  if (m === 'application/javascript' || m === 'text/javascript') return T.js;
  if (m.startsWith('text/')) return T.txt;
  if (m === 'application/zip' || m === 'application/x-7z-compressed' || m === 'application/x-rar-compressed' || m === 'application/gzip') return T.zip;
  return null;
}

/** 预览分类：MediaViewer 据此路由到子查看器。未知一律 'other'（查看器出「不支持」态 + 下载 / 打开方式）。 */
export function kindOf(name = '', mime = '') {
  return (lookup(name) || byMime(mime) || ['other'])[0];
}

/** 列表图标分类（文件管理器、分享页的图标与缩略图判断）。isDir 优先。 */
export function iconKindOf(name = '', { isDir = false, mime = '' } = {}) {
  if (isDir) return 'dir';
  const r = lookup(name) || byMime(mime);
  if (!r) return 'file';
  if (r[0] === 'markdown') return 'md';
  return r[1];
}

/** 有没有内嵌查看器 */
export function canPreview(name = '', mime = '') { return kindOf(name, mime) !== 'other'; }

/** 代码高亮语言 id（'' = 纯文本，不高亮）。id 取 CodeMirror language-data 的常用名（小写）。 */
export function langOf(name = '') {
  const r = lookup(name);
  return (r && r[2]) || '';
}

/** Office 子类：决定 OfficeView 走表格、文档还是演示。 */
export function officeCat(name = '') {
  const r = lookup(name);
  if (!r || r[0] !== 'office') return null;
  return r[1] === 'sheet' ? 'sheet' : r[1] === 'slide' ? 'slides' : 'word';
}

/** 服务端 LibreOffice 转 PDF 认的扩展名（src/routes/file-preview.mjs OFFICE_EXT 的同一份）。 */
export const SERVER_OFFICE_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf']);
export function serverConvertsOffice(name = '') { return SERVER_OFFICE_EXT.has(extOf(name)); }

/** 浏览器原生直接播 / 画不了、需要转码或衍生档的类型（给缩略图与回落策略参考） */
export const NEEDS_TRANSCODE = new Set(['heic', 'heif', 'mkv', 'avi', '3gp', '3g2', 'amr']);

// —— 内容嗅探（无扩展名 / 未知扩展名文件）——
// 规则同 VS Code / file(1) 的粗判：前 4KB 里有 NUL 就是二进制；否则能按 UTF-8 严格解（末尾被截断的半个多字节字符放过）
// 就是 UTF-8 文本；不能的话看高位字节是否成对落在 GBK 区间，像就是 GBK 文本。返回 { text, encoding }。
export function sniffText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const n = Math.min(b.length, 4096);
  if (!n) return { text: true, encoding: 'utf-8' };   // 空文件当文本（能打开、能编辑）
  // UTF-16 BOM：文本
  if (n >= 2 && ((b[0] === 0xff && b[1] === 0xfe) || (b[0] === 0xfe && b[1] === 0xff))) return { text: true, encoding: b[0] === 0xff ? 'utf-16le' : 'utf-16be' };
  let ctrl = 0;
  for (let i = 0; i < n; i++) {
    const c = b[i];
    if (c === 0) return { text: false, encoding: null };
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) ctrl++;
  }
  if (ctrl > n * 0.1) return { text: false, encoding: null };
  if (validUtf8(b, n)) return { text: true, encoding: 'utf-8' };
  if (looksGbk(b, n)) return { text: true, encoding: 'gbk' };
  return { text: false, encoding: null };
}
function validUtf8(b, n) {
  let i = 0;
  while (i < n) {
    const c = b[i];
    if (c < 0x80) { i++; continue; }
    let need = c >= 0xf0 && c <= 0xf4 ? 3 : c >= 0xe0 ? 2 : c >= 0xc2 && c <= 0xdf ? 1 : -1;
    if (need < 0 || c > 0xf4) return false;
    if (i + need >= n) return true;   // 截断在多字节字符中间：放过
    for (let k = 1; k <= need; k++) if ((b[i + k] & 0xc0) !== 0x80) return false;
    i += need + 1;
  }
  return true;
}
function looksGbk(b, n) {
  let i = 0, pairs = 0;
  while (i < n) {
    const c = b[i];
    if (c < 0x80) { i++; continue; }
    if (c >= 0x81 && c <= 0xfe && i + 1 < n) {
      const d = b[i + 1];
      if ((d >= 0x40 && d <= 0x7e) || (d >= 0x80 && d <= 0xfe)) { pairs++; i += 2; continue; }
      return false;
    }
    if (i + 1 >= n) return pairs > 0;
    return false;
  }
  return true;
}

/** 拉前 4KB 嗅探（Range 请求）。失败返回 null（调用方按「不支持」处理）。opts.fetch 可注入（测试 / 原生桥）。 */
export async function sniffUrl(url, { fetch: f = globalThis.fetch, signal } = {}) {
  if (!url || typeof f !== 'function') return null;
  try {
    const r = await f(url, { headers: { Range: 'bytes=0-4095' }, credentials: 'same-origin', signal });
    if (!r.ok && r.status !== 206) return null;
    const buf = new Uint8Array(await r.arrayBuffer());
    return sniffText(buf.subarray(0, 4096));
  } catch { return null; }
}
