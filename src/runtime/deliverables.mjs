// Claude 轮「产物附件」共用助手 —— 与 Codex 分页同一哲学：只有【最终回答里显式写成
// markdown 链接】的文件/文件夹才算交付物（裸路径只是叙述，不进卡片；源码扩展名刻意
// 排除——回答里引用 .js/.py 属于讲解，不是交付）。live 轮（agents/claude.mjs 的 done
// 事件）与重开会话（routes/sessions.mjs 从 transcript 重建）共用同一套提取，天然一致，
// 不需要额外 sidecar。文件夹链接 = 交付整个目录：卡片上显示项数，下载时现打 zip。

import { closeSync, createReadStream, fstatSync, mkdirSync, openSync, readSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import readline from 'node:readline';
import { DATA_ROOT } from './paths.mjs';
import { fileExtension, isPathInside, mimeType, streamFile } from './http-file.mjs';

const ROOT = DATA_ROOT;
const ZIP_CACHE = path.join(ROOT, 'zip-cache');   // 文件夹下载的临时 zip（流完即删）

// 可当交付物的文件扩展（与 codex 分页同表）。
const ARTIFACT_EXT = 'png|jpe?g|gif|webp|bmp|heic|heif|avif|svg|pdf|md|txt|json|csv|tsv|html?|mp4|webm|mov|m4v|avi|mkv|mp3|wav|m4a|aac|ogg|flac|opus|docx?|xlsx?|pptx?|zip|tar|gz';
const FILE_EXT_RE = new RegExp('\\.(?:' + ARTIFACT_EXT + ')$', 'i');

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'avi', 'mkv']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac', 'opus']);
const fold = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));

export function deliverKind(name = '') {
  const ext = fileExtension(name);
  if (IMAGE_EXT.has(ext) || ext === 'svg') return 'image';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (ext === 'pdf') return 'pdf';
  if (['md', 'txt', 'json', 'csv', 'tsv', 'html', 'htm', 'xml', 'log'].includes(ext)) return 'text';
  if (['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx'].includes(ext)) return 'office';
  return 'file';
}

export function isInside(file, root) {
  return isPathInside(file, root);
}

// root 下的 POSIX 相对路径；不在 root 内（或路径读不到）返回 null。root 自身 = ''。
function relUnder(root, target) {
  if (!root) return null;
  try {
    const rel = path.relative(realpathSync(root), realpathSync(target));
    if (rel === '') return '';
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  } catch { return null; }
}

// 文件夹交付物 →「在工作空间里打开」的定位信息：卡片点开＝右侧工作台的工作空间视图
// 导航到这个文件夹（能逐个点开里面的文件读），不再整包 zip 下载。
//   fileRoot = 该身份文件页的根（/api/files 的根：admin=vault / 沙箱用户=自己的文件夹 / 快照=桶）
//   ws       = 本会话的工作空间（项目 cwd）
// ① 落在 fileRoot 内 → { rel }：普通工作空间页就能到（无 shell 的 user、快照访客也能用）。
// ② 根外但在会话工作空间内（需 shell）→ { ws, rel }：文件页以工作空间为根、初始定位到子目录。
// ③ 仍在外（uploads/media 之类，需 shell）→ { ws: 自己, rel: '' }：把这个文件夹本身当根。
// ④ 无 shell 又在根外 → null：前端回落成原来的整包下载。
// ②③ 的 ws 会在 /api/files 侧再过一遍 authorizeProjectPath，这里给的只是候选。
export function deliverNav(target, { fileRoot = '', ws = '', shell = false } = {}) {
  const inRoot = relUnder(fileRoot, target);
  if (inRoot != null) return { rel: inRoot };
  if (!shell) return null;
  const inWs = relUnder(ws, target);
  if (inWs != null) return { ws, rel: inWs };
  return { ws: target, rel: '' };
}

// 身份 → 交付物允许出现的根目录集合。admin 额外放 vault（HOST_TOOLS_NUDGE 让 Claude
// 把产物放进工作空间，会话 cwd 可能是别的项目目录）；沙箱用户严格锁自己的空间。
export function deliverRoots(ctx, cwd, vault) {
  return ctx && ctx.sandbox
    ? [cwd, ctx.uploads, ctx.media]
    : [cwd, vault, ctx && ctx.uploads, ctx && ctx.media];
}

// 链接里的路径 → 盘上真实路径（realpath）。绝对路径原样；相对路径先按 cwd 解析，
// 解析不到再依次按各交付根（vault / 身份文件根 / uploads / media）当基准试一遍。
// 为什么要回退：项目制下会话 cwd 是项目目录（<工作空间>/projects/demo），但 Claude 常把
// 产物放进 vault 里别的文件夹、再按工作空间根写相对链接（notes/research/x.md）——按 cwd 拼
// 出来的路径根本不存在，附件卡不出、点正文链接 404「加载失败」。找不到返回 null。
// 回退只在 roots 之内找，所以不会放宽根守卫（调用方仍要再做一次 isInside 校验）。
// cwd 可以是一组候选基准（按优先级）：模型在这一轮里 `cd` 进过子目录时，Claude Code 会把
// 会话工作目录跟着改掉（transcript 每条记录的 cwd 随之变，SDK 还会告诉模型「工作目录已变」），
// 模型于是按【新目录】写相对链接——调用方把该轮落盘的 cwd 排在项目根前面传进来。
export function resolveDeliverPath(raw, cwd, roots = []) {
  const cwds = (Array.isArray(cwd) ? cwd : [cwd]).filter(Boolean);
  const bases = path.isAbsolute(raw) ? [''] : [...(cwds.length ? cwds : ['.']), ...roots.filter(Boolean)];
  const tried = new Set();
  for (const base of bases) {
    const abs = base ? path.resolve(base, raw) : raw;
    if (tried.has(fold(abs))) continue;
    tried.add(fold(abs));
    try { return realpathSync(abs); } catch {}
  }
  return null;
}

// —— transcript 里记录的工作目录 ——
// 每条记录顶层都带 cwd；消息正文在它【前面】（记录键序 message…cwd），正文里即使出现
// "cwd":" 字样也是转义过的（\"cwd\":\"），匹配不上，所以取每行【最后一处】即顶层值。
const CWD_KEY = '"cwd":"';
function lineCwd(line) {
  const i = line.lastIndexOf(CWD_KEY);
  if (i < 0) return '';
  const s = i + CWD_KEY.length;
  let j = s;
  while (j < line.length && line[j] !== '"') j += line[j] === '\\' ? 2 : 1;
  try { return JSON.parse('"' + line.slice(s, j) + '"'); } catch { return ''; }
}

// 直播轮收尾用：transcript 末尾最近一条记录的 cwd（这一轮最后所处的工作目录）。读不到返回 ''。
export function transcriptTailCwd(file, tailBytes = 256 * 1024) {
  if (!file) return '';
  let fd = null;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, tailBytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    for (let k = lines.length - 1; k >= 0; k--) { const c = lineCwd(lines[k]); if (c) return c; }
  } catch {} finally { if (fd != null) try { closeSync(fd); } catch {} }
  return '';
}

// 正文链接点开兜底用：整个会话出现过的所有 cwd（去重，最近的在前）。
export async function transcriptCwds(file) {
  const seen = [];
  try {
    const rl = readline.createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
      const c = lineCwd(line);
      if (c && seen[seen.length - 1] !== c) { const k = seen.indexOf(c); if (k >= 0) seen.splice(k, 1); seen.push(c); }
    }
  } catch {}
  return seen.reverse();
}

// 最终回答文本 → 交付物清单。只认 markdown 链接 [x](路径)；http/data 等带 scheme 的
// 跳过（单字母盘符 C:\ 不算 scheme）；相对路径按 cwd 解析、解析不到按各交付根回退
// （resolveDeliverPath）；路径必须真实存在且落在 roots 之内。文件须匹配交付扩展表；
// 目录一律可交付（kind:'folder'，count=直接子项数）。
// nav = { fileRoot, ws, shell }：给文件夹交付物附上工作空间定位（见 deliverNav）。不传＝不算。
export function collectDeliverables(text, { cwd, roots = [], limit = 12, nav = null } = {}) {
  const out = [];
  const seen = new Set();
  const src = String(text || '');
  // 目标里允许一层平衡括号：文件名带 (EN) 这类后缀时，agent 常直接写裸路径
  // 而不是 %28 编码——按 CommonMark 这是坏链接，但交付物识别宁可宽容。
  const re = /\]\(((?:[^()\r\n]|\([^()\r\n]*\))+?)\)/g;
  let m;
  while ((m = re.exec(src))) {
    if (out.length >= limit) break;
    let raw = m[1].trim();
    raw = raw.replace(/\s+"[^"]*"$/, '');                     // 链接 title：[x](p "t")
    if (raw.startsWith('<') && raw.endsWith('>')) raw = raw.slice(1, -1).trim();
    if (!raw || /^[a-z][a-z0-9+.-]+:/i.test(raw)) continue;   // http/data/mailto…（≥2 字符才算 scheme，放过 C:\）
    if (raw.includes('%')) { try { raw = decodeURIComponent(raw); } catch {} }
    const real = resolveDeliverPath(raw, cwd, roots);
    if (!real) continue;
    let st;
    try { st = statSync(real); } catch { continue; }
    if (seen.has(fold(real))) continue;
    if (!roots.some((root) => isInside(real, root))) continue;
    if (st.isDirectory()) {
      let count = 0;
      try { count = readdirSync(real).length; } catch {}
      const where = nav ? deliverNav(real, nav) : null;
      out.push({ name: path.basename(real) || real, path: real, kind: 'folder', size: 0, count, source: 'assistant_link', ...(where ? { nav: where } : {}) });
    } else if (st.isFile()) {
      if (!FILE_EXT_RE.test(real)) continue;
      // 文件也附工作台定位：nav=父目录定位 + open=文件名，前端点卡/点链接时在右侧
      // 工作区的文件页里落到该目录并自动打开面板内预览（不再全屏）；算不出定位
      //（无 shell 又在根外）时 nav 缺省，前端回落全屏沉浸查看器。
      const where = nav ? deliverNav(path.dirname(real), nav) : null;
      out.push({ name: path.basename(real), path: real, kind: deliverKind(real), size: st.size, mime: mimeType(real, { fallback: '' }), source: 'assistant_link', ...(where ? { nav: { ...where, open: path.basename(real) } } : {}) });
    } else continue;
    seen.add(fold(real));
  }
  return out;
}

// 文件流式下发（与 routes/codex.mjs 的 streamArtifact 同款：Range/断点、UTF-8 文件名）。
export function streamArtifactFile(req, res, file, downloadName, download, { cleanup } = {}) {
  const st = statSync(file);
  if (!st.isFile()) throw Object.assign(new Error('not found'), { status: 404 });
  streamFile(req, res, file, {
    stat: st,
    name: downloadName || file,
    safeMime: true,
    cacheControl: 'private, max-age=3600',
    downloadName: downloadName || path.basename(file),
    download,
    cleanup,
  });
}

const firstExisting = (list) => list.find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
const BSDTAR = () => firstExisting(['C:\\Windows\\System32\\tar.exe', '/usr/bin/bsdtar', '/usr/bin/tar']);

// 文件夹交付：现打 zip（bsdtar，自动排除 node_modules/.git 这类依赖与版本库噪声），
// 打完流式下发、连接关闭即删临时包。不做缓存——文件夹内容随时在变，宁可每次新鲜。
export async function streamFolderZip(req, res, dir, { name = '' } = {}) {
  const tar = BSDTAR();
  if (!tar) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('打包工具不可用（没找到 tar.exe）');
    return;
  }
  mkdirSync(ZIP_CACHE, { recursive: true });
  const base = String(name || path.basename(dir) || 'folder').replace(/\.zip$/i, '');
  const tmp = path.join(ZIP_CACHE, crypto.randomBytes(8).toString('hex') + '.zip');
  // hdrcharset=UTF-8：bsdtar 造 zip 默认按系统 ANSI 码页（中文 Windows=GBK）写文件名且
  // 不设 UTF-8 标志——手机端解压中文名全乱码（实测）。显式 UTF-8 + EFS 标志根治。
  const args = ['--options', 'hdrcharset=UTF-8', '-a', '-cf', tmp, '--exclude', '*node_modules*', '--exclude', '*/.git/*', '--exclude', '.git', '-C', path.dirname(dir), path.basename(dir)];
  const code = await new Promise((resolve) => {
    const child = spawn(tar, args, { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(-1));
    child.on('exit', (c) => resolve(c ?? -1));
  });
  if (code !== 0) {
    try { rmSync(tmp, { force: true }); } catch {}
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('文件夹打包失败');
    return;
  }
  streamArtifactFile(req, res, tmp, base + '.zip', true, { cleanup: () => rmSync(tmp, { force: true }) });
}
