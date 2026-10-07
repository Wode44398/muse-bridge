import path from 'node:path';
import {
  createWriteStream, statSync, readdirSync, existsSync, renameSync, rmSync,
  mkdirSync, cpSync, readFileSync, writeFileSync, openSync, closeSync,
} from 'node:fs';
import { pipeline } from 'node:stream';
import { readdir as readdirAsync, stat as statAsync, cp as cpAsync, rm as rmAsync } from 'node:fs/promises';
import { requireCtx, requireReadCtx } from '../runtime/identity.mjs';
import { readBody } from '../runtime/body.mjs';
import { sanitizeName, sweepStaleParts } from '../runtime/paths.mjs';
import { safeJoin, isPathInside, withinRoot } from '../runtime/http-file.mjs';
import { authorizeProjectPath } from '../project-paths.mjs';

export const bad = (res, code, msg) => {
  res.writeHead(code, { 'Content-Type': 'text/plain' });
  res.end(msg);
};
export const okJson = (res, obj, code = 200) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const MAX_ENTRIES = 1500;
const MAX_UPLOAD = 2_000_000_000;

export function scopeCtx(ctx, rawWs, res) {
  if (!rawWs) return ctx;
  if (!ctx.shell) { bad(res, 403, 'workspace tools require Pro'); return null; }
  try { return { ...ctx, cwd: authorizeProjectPath(ctx, rawWs) }; }
  catch (error) {
    bad(res, error?.status || 403, error?.message || 'forbidden');
    return null;
  }
}

// target 相对 fromDir 的位置：'same' | 'inside' | 'outside'。
//
// 「拷/移进自身」的判定【必须】走 path.relative，不能用 `startsWith(src + sep)`：
// win32 的 path.relative 大小写不敏感，startsWith 不是。于是 src='Foo'、dst='foo/x'
// 在 Windows 上明明是同一棵树，startsWith 却判成两处、把守卫整个放行——cpSync 会把
// 目录往自己里面无限递归拷（实测 1 个文件 3 分钟长到 3049 个），而且 cpSync 是同步的，
// 整台单线程服务在它跑完之前完全停止响应。文件路由对 user / 快照访客都开放，
// 所以这是一条任何持链接的人都能打出来的「冻服务 + 撑爆磁盘」。
export function relPosition(fromDir, target) {
  const rel = path.relative(path.resolve(fromDir), path.resolve(target));
  if (rel === '') return 'same';
  if (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) return 'inside';
  return 'outside';
}

// —— 隐藏项策略 ——
//
// 从前这里是「凡是点开头的一律看不见、也不许动」（underDotSeg）。代价是 D:\.Root\.gam
// 这种完全正常的目录在工作空间里根本不存在——而 Windows 资源管理器本来就照常显示它们
// （Windows 的「隐藏」是文件属性，不是名字里的点）。所以改成只挡两样【不属于用户的东西】：
//   · 分块上传的临时片 `.part-<id>`：传完即改名，露出来只会让人误删一条正在传的文件；
//   · 沙箱身份自己那份 `.bridge` 系统目录：会话/配置/上传/历史都在里头，不是他的内容。
// 另外公开分享身份（/s/、/w/ 链接，任何拿到链接的人）仍一律不给点开头的项：那是只读桶，
// 隐藏文件里可能有 .env 之类，宁可少给。
const PART_RE = /^\.part-[a-zA-Z0-9]{6,40}$/;
const SYS_DIR = '.bridge';

// 列表里要不要藏这一项。rel = 当前目录相对 cwd 的路径（''＝根）。
export function hiddenInList(ctx, name, rel) {
  if (PART_RE.test(name)) return true;
  if (ctx?.kind === 'share') return name.startsWith('.');
  if (ctx?.sandbox && !rel && name === SYS_DIR) return true;
  return false;
}

// 写操作要不要拒绝这个目标。没有 ctx 的调用方（agent 侧的 workspace 工具）走保守默认：
// 一律护住根下的 .bridge。
export function protectedTarget(root, target, ctx = null) {
  const segs = path.relative(path.resolve(root), path.resolve(target)).split(/[\\/]+/).filter(Boolean);
  if (segs.some((seg) => PART_RE.test(seg))) return true;
  const sandbox = ctx ? Boolean(ctx.sandbox) : true;
  return sandbox && segs[0] === SYS_DIR;
}

export function uniquePath(file) {
  if (!existsSync(file)) return file;
  const dir = path.dirname(file);
  const ext = path.extname(file);
  const base = path.basename(file, ext);
  for (let index = 1; index < 1000; index += 1) {
    const candidate = path.join(dir, `${base} (${index})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
  return path.join(dir, `${base} (dup)${ext}`);
}

// 递归遍历（搜索/索引）跳过的重目录——这是【性能】取舍不是可见性取舍：.git 里动辄上万个
// 小文件，会把访问预算一口吃光。直接列目录时它照常显示、照常进得去。
export const SEARCH_SKIP = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information']);
export async function searchWorkspace(root, query, { maxResults = 50, maxVisited = 6000, maxDepth = 8 } = {}) {
  const normalized = String(query || '').trim().toLowerCase();
  if (!normalized) return { matches: [], visited: 0, truncated: false };
  const base = path.resolve(root);
  const matches = [];
  let visited = 0;
  let truncated = false;
  const walk = async (dir, depth) => {
    if (truncated || matches.length >= maxResults || depth > maxDepth) return;
    let entries;
    try { entries = await readdirAsync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (visited >= maxVisited) { truncated = true; return; }
      visited += 1;
      if (SEARCH_SKIP.has(entry.name) || PART_RE.test(entry.name)) continue;
      let isDir = false;
      try { isDir = entry.isDirectory(); } catch { continue; }
      if (entry.name.toLowerCase().includes(normalized)) {
        matches.push({
          name: entry.name,
          path: path.relative(base, path.join(dir, entry.name)).split(path.sep).join('/'),
          isDir,
        });
        if (matches.length >= maxResults) { truncated = true; return; }
      }
      if (isDir) await walk(path.join(dir, entry.name), depth + 1);
    }
  };
  await walk(base, 0);
  return { matches, visited, truncated };
}

const TEXT_EXT = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'log', 'js', 'mjs', 'cjs',
  'ts', 'jsx', 'tsx', 'css', 'scss', 'html', 'htm', 'xml', 'svg', 'yml',
  'yaml', 'py', 'rb', 'go', 'rs', 'sh', 'bat', 'ps1', 'ini', 'toml', 'conf',
  'env', 'sql', 'vue', 'c', 'h', 'cpp', 'cc', 'hpp', 'java', 'kt', 'swift',
  'php', 'lua', 'r', 'tex', 'rst', 'gitignore', '',
]);

export function readWorkspaceFile(root, rel, { maxBytes = 64 * 1024 } = {}) {
  const file = safeJoin(root, rel);
  if (!file) return { error: '路径越界,拒绝' };
  let stat;
  try { stat = statSync(file); } catch { return { error: '文件不存在' }; }
  if (stat.isDirectory()) return { error: '这是一个文件夹,不是文件' };
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!TEXT_EXT.has(ext)) return { error: '不是文本/代码文件,读不了(图片、视频、压缩包等请在工作空间里打开)' };
  if (stat.size > maxBytes) return { error: `文件太大(${Math.round(stat.size / 1024)}KB,上限 ${Math.round(maxBytes / 1024)}KB),请在工作空间里打开` };
  try {
    return {
      content: readFileSync(file, 'utf8'),
      size: stat.size,
      path: path.relative(path.resolve(root), file).split(path.sep).join('/'),
    };
  } catch {
    return { error: '读取失败' };
  }
}

export function writeWorkspaceFile(root, rel, content, { maxBytes = 1_000_000 } = {}) {
  const raw = String(rel || '').replace(/[\\/]+/g, '/').replace(/^\/+|\/+$/g, '');
  if (!raw) return { error: '缺少文件名' };
  const segments = raw.split('/').filter((segment) => segment && segment !== '.' && segment !== '..');
  let name = sanitizeName(segments.pop() || '');
  if (!name) return { error: '文件名无效' };
  if (!/\.[a-z0-9]{1,8}$/i.test(name)) name += '.md';
  const dir = safeJoin(root, segments.join('/'));
  if (!dir) return { error: '路径越界，拒绝' };
  let target = path.join(dir, name);
  if (!safeJoin(root, path.relative(path.resolve(root), target))) return { error: '路径越界，拒绝' };
  if (protectedTarget(root, target)) return { error: '不能写进 bridge 的系统目录' };
  const text = String(content ?? '');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) return { error: `内容太大（上限 ${Math.round(maxBytes / 1024)}KB）` };
  try {
    mkdirSync(dir, { recursive: true });
    target = uniquePath(target);
    writeFileSync(target, text, 'utf8');
    return {
      ok: true,
      path: path.relative(path.resolve(root), target).split(path.sep).join('/'),
      name: path.basename(target),
    };
  } catch (error) {
    return { error: '写入失败：' + (error?.message ?? error) };
  }
}

export function moveWorkspaceFile(root, srcRel, destRel) {
  const hasDotDot = (value) => String(value || '').split(/[\\/]+/).some((segment) => segment === '..');
  if (hasDotDot(srcRel) || hasDotDot(destRel)) return { error: '路径不能含 ..（只能在工作空间内移动）' };
  const src = safeJoin(root, srcRel);
  const dst = safeJoin(root, destRel);
  if (!src || !dst || src === path.resolve(root) || dst === path.resolve(root)
    || protectedTarget(root, src) || protectedTarget(root, dst)) return { error: '路径越界或涉及 bridge 系统目录，拒绝' };
  if (!existsSync(src)) return { error: '源路径不存在' };
  const srcResolved = path.resolve(src);
  const dstResolved = path.resolve(dst);
  const where = relPosition(srcResolved, dstResolved);
  if (where === 'same') return { error: '目标与源相同' };
  if (where === 'inside') return { error: '不能移动到自身内部' };
  if (existsSync(dst)) return { error: '目标已存在（换个名字或先删掉它）' };
  try { mkdirSync(path.dirname(dst), { recursive: true }); } catch {}
  try {
    renameSync(src, dst);
  } catch (error) {
    if (error?.code !== 'EXDEV') return { error: '移动失败：' + (error?.message ?? error) };
    try {
      cpSync(src, dst, { recursive: true });
      rmSync(src, { recursive: true, force: true });
    } catch (fallbackError) {
      return { error: '移动失败：' + (fallbackError?.message ?? fallbackError) };
    }
  }
  return {
    ok: true,
    from: path.relative(path.resolve(root), srcResolved).split(path.sep).join('/'),
    to: path.relative(path.resolve(root), dstResolved).split(path.sep).join('/'),
  };
}

// 列目录全程异步：admin 的手机工作空间能进整机任意目录（System32 几千项、Google Drive 这类
// 虚拟盘第一次列目录要现拉元数据），同步 readdir/stat 会把单线程的服务整个钉住——所有对话的
// SSE 一起停摆。stat 走 libuv 线程池并行；stat 不动的项（pagefile.sys 之类被系统锁着的）照旧略过。
const DENIED = new Set(['EPERM', 'EACCES']);
export async function handleList(req, res, url, identify) {
  let ctx = requireReadCtx(identify, req, res);
  if (!ctx) return;
  ctx = scopeCtx(ctx, url.searchParams.get('ws'), res);
  if (!ctx) return;
  const rel = url.searchParams.get('path') || '';
  const dir = safeJoin(ctx.cwd, rel);
  if (!dir) return bad(res, 403, 'forbidden');
  try {
    let stat;
    try { stat = await statAsync(dir); } catch (error) {
      if (!rel) return okJson(res, { path: '', items: [], truncated: false });
      if (DENIED.has(error?.code)) return okJson(res, { error: '没有权限打开这个文件夹' }, 403);
      return bad(res, 404, 'not found');
    }
    if (!stat.isDirectory()) return bad(res, 400, 'not a directory');
    let entries;
    try { entries = await readdirAsync(dir, { withFileTypes: true }); } catch (error) {
      // 整机浏览时这很常见（系统保护目录、别的账户的主目录）：给一句人话，前端空态直接显示它
      if (DENIED.has(error?.code)) return okJson(res, { error: '没有权限打开这个文件夹' }, 403);
      return bad(res, 500, 'read error');
    }
    const here = path.relative(path.resolve(ctx.cwd), dir).split(path.sep).join('/');
    // q＝按名字筛（不分大小写的子串，与前端搜索同一规则），先筛后截：上千项的目录（Temp、
    // System32、下载）只回前 1500 项，排在后面的只能靠这条找到。total＝截之前一共多少项。
    const needle = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const visible = entries.filter((entry) => !hiddenInList(ctx, entry.name, here)
      && (!needle || entry.name.toLowerCase().includes(needle)));
    const truncated = visible.length > MAX_ENTRIES;
    // 要截断时先保文件夹（稳定排序，组内仍是磁盘顺序）：一万个文件里夹着的几十个子文件夹不能被截掉，那样连往下走的路都没了
    if (truncated) visible.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()));
    const picked = truncated ? visible.slice(0, MAX_ENTRIES) : visible;
    const stats = await Promise.all(picked.map((entry) => statAsync(path.join(dir, entry.name)).catch(() => null)));
    const items = [];
    picked.forEach((entry, index) => {
      const child = stats[index];
      if (child) items.push({ name: entry.name, isDir: child.isDirectory(), size: child.size, mtime: child.mtimeMs });
    });
    items.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name, 'zh'));
    okJson(res, { path: here, items, truncated, total: visible.length });
  } catch {
    if (!res.headersSent) bad(res, 500, 'read error');
  }
}

const validUploadId = (value) => /^[a-zA-Z0-9]{6,40}$/.test(value);

export function handleUpload(req, res, url, identify) {
  // 提前回绝（401/403/404/400…）时把没读的请求体排掉：否则连接被重置，客户端只看到「网络错误」
  // 而拿不到状态码——上传引擎会把一个注定失败的请求当断网反复重试。
  res.once('finish', () => { if (!req.complete && !req.destroyed) req.resume(); });
  let ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  ctx = scopeCtx(ctx, url.searchParams.get('ws'), res);
  if (!ctx) return;
  const dir = safeJoin(ctx.cwd, url.searchParams.get('path') || '');
  if (!dir || protectedTarget(ctx.cwd, dir, ctx)) return bad(res, 403, 'forbidden');
  if (url.searchParams.get('mk') === '1') { try { mkdirSync(dir, { recursive: true }); } catch {} }
  try { if (!statSync(dir).isDirectory()) return bad(res, 404, 'no such folder'); } catch { return bad(res, 404, 'no such folder'); }
  const id = url.searchParams.get('id') || '';
  const last = url.searchParams.get('last') === '1';
  if (!validUploadId(id)) return bad(res, 400, 'bad id');
  const part = path.join(dir, '.part-' + id);
  // 探针：只过一遍鉴权/目录/参数校验、不碰文件。客户端在「连接被重置」后用它分辨是真断网，
  // 还是服务端早就回了 4xx（大请求体没发完连接就被中间层掐了，状态码没送到）。
  if (url.searchParams.get('probe') === '1') { req.resume(); return okJson(res, { ok: true }); }
  if (url.searchParams.get('abort') === '1') {   // 用户取消：顺手删掉半截文件（不等 6 小时后的清扫）
    req.resume();
    try { rmSync(part, { force: true }); } catch {}
    return okJson(res, { ok: true });
  }
  if (url.searchParams.get('commit') === '1') { req.resume(); return commitPart(res, url, dir, part); }
  if (url.searchParams.has('off')) return writePartAt(req, res, url, dir, part);
  // 旧协议（按到达顺序追加、last=1 收尾）：老版本客户端与笔记插图还在用，原样保留。
  let existing = 0;
  try { existing = statSync(part).size; } catch {}
  if (!existing) sweepStaleParts(dir);
  if (existing > MAX_UPLOAD) {
    try { rmSync(part, { force: true }); } catch {}
    return bad(res, 413, 'too large');
  }
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared >= 0 && existing + declared > MAX_UPLOAD) {
    try { rmSync(part, { force: true }); } catch {}
    bad(res, 413, 'too large');
    req.resume();
    return;
  }
  const writer = createWriteStream(part, { flags: 'a' });
  let received = 0;
  let overflow = false;
  const cleanupPart = () => { try { rmSync(part, { force: true }); } catch {} };
  const rejectTooLarge = () => {
    if (overflow) return;
    overflow = true;
    req.unpipe(writer);
    writer.once('close', cleanupPart);
    try { writer.destroy(); } catch {}
    cleanupPart();
    if (!res.writableEnded) bad(res, 413, 'too large');
    req.resume();
  };
  req.on('data', (chunk) => {
    received += chunk.length;
    if (existing + received > MAX_UPLOAD) rejectTooLarge();
  });
  req.on('error', () => { try { writer.destroy(); } catch {} });
  writer.on('error', () => {
    if (overflow) cleanupPart();
    else if (!res.writableEnded) bad(res, 500, 'write error');
  });
  writer.on('finish', () => {
    if (overflow) { cleanupPart(); return; }
    if (!last) return okJson(res, { ok: true });
    const name = sanitizeName(decodeURIComponent(url.searchParams.get('name') || 'file'));
    let dest;
    try {
      dest = uniquePath(path.join(dir, name));
      renameSync(part, dest);
    } catch {
      cleanupPart();
      return bad(res, 500, 'finalize error');
    }
    okJson(res, { ok: true, name: path.basename(dest) });
  });
  req.pipe(writer);
}

// —— 按偏移写的分块上传（工作空间上传引擎：网页 lib/uploads.svelte.js、手机 App UploadService）——
//   POST ?id&off=<字节偏移>&len=<本块字节数>     把本块写到 .part-<id> 的 off 处；
//   POST ?id&commit=1&size=<总字节>&name=<文件名>  长度对得上才转正成正式文件；
//   块请求再带 fin=1&size&name：单块文件写完当场转正，省一次往返。
// 与旧协议的区别：块与块互不依赖到达顺序 → 可以几块并行发（隧道上单连接吞吐有限，并行明显更快）；
// 同一块重发只是把同样的字节写回同一位置 → 超时/断线后整块重试是幂等的，不会像追加那样写重。
// 客户端只在所有块都拿到 200 之后才 commit，所以 commit 时长度对上即内容完整。
const committedParts = new Map();   // part 绝对路径 → { name, at }：commit 的回执丢了、客户端重发时拿回同一个结果

function rememberCommit(part, name) {
  const now = Date.now();
  committedParts.set(part, { name, at: now });
  if (committedParts.size > 200) {
    for (const [k, v] of committedParts) if (now - v.at > 3600_000 || committedParts.size > 200) committedParts.delete(k);
  }
}

function commitPart(res, url, dir, part) {
  const done = committedParts.get(part);
  if (done) return okJson(res, { ok: true, name: done.name });
  let size;
  try { size = statSync(part).size; } catch { return okJson(res, { error: 'upload expired', have: 0 }, 409); }
  const want = Number(url.searchParams.get('size'));
  if (url.searchParams.has('size') && Number.isSafeInteger(want) && size !== want) return okJson(res, { error: 'incomplete', have: size }, 409);
  const name = sanitizeName(decodeURIComponent(url.searchParams.get('name') || 'file'));
  let dest;
  try {
    dest = uniquePath(path.join(dir, name));
    renameSync(part, dest);
  } catch {
    // 半截文件不删：多半是还有在途的旧块请求占着句柄，客户端稍后重发 commit 即可
    return bad(res, 503, 'finalize busy');
  }
  rememberCommit(part, path.basename(dest));
  okJson(res, { ok: true, name: path.basename(dest) });
}

function writePartAt(req, res, url, dir, part) {
  const off = Number(url.searchParams.get('off'));
  const len = Number(url.searchParams.get('len'));
  if (!Number.isSafeInteger(off) || off < 0 || !Number.isSafeInteger(len) || len < 0) { req.resume(); return bad(res, 400, 'bad range'); }
  if (off + len > MAX_UPLOAD) { req.resume(); return bad(res, 413, 'too large'); }
  const done = committedParts.get(part);
  if (done) { req.resume(); return okJson(res, { ok: true, name: done.name }); }   // 已转正（单块 fin 的回执丢了又重发）
  let existed = true;
  try { statSync(part); } catch { existed = false; }
  if (!existed) sweepStaleParts(dir);
  // 'a' 打开＝不存在就建、存在不截断（几块并行到达时谁先建都不会抹掉别人写的）；随后按位置写。
  try { closeSync(openSync(part, 'a')); } catch { req.resume(); return bad(res, 500, 'write error'); }
  const writer = createWriteStream(part, { flags: 'r+', start: off });
  let received = 0;
  req.on('data', (chunk) => {
    received += chunk.length;
    if (received > len) req.destroy();   // 多于声明的长度：不收（pipeline 收尾时回 400）
  });
  // pipeline：请求中途断开时两端都会被销毁、句柄不泄漏（裸 pipe 遇到 aborted 不会结束写流）
  pipeline(req, writer, (err) => {
    if (res.writableEnded || res.destroyed) return;
    if (err || received !== len) return bad(res, 400, 'short body');
    if (url.searchParams.get('fin') === '1') return commitPart(res, url, dir, part);
    okJson(res, { ok: true });
  });
}

export async function handleMkdir(req, res, identify) {
  let ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return bad(res, 400, 'bad json'); }
  ctx = scopeCtx(ctx, body.ws, res);
  if (!ctx) return;
  const parent = safeJoin(ctx.cwd, String(body.path || ''));
  const name = sanitizeName(body.name);
  if (!parent || !name || name === 'file') return bad(res, 400, 'bad name');
  const dir = path.join(parent, name);
  if (!withinRoot(ctx.cwd, dir) || dir === path.resolve(ctx.cwd) || protectedTarget(ctx.cwd, dir, ctx)) return bad(res, 403, 'forbidden');
  if (existsSync(dir)) return bad(res, 409, 'exists');
  try { mkdirSync(dir, { recursive: true }); } catch { return bad(res, 500, 'mkdir error'); }
  okJson(res, { ok: true, name });
}

export async function handleDelete(req, res, identify) {
  let ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return bad(res, 400, 'bad json'); }
  ctx = scopeCtx(ctx, body.ws, res);
  if (!ctx) return;
  const target = safeJoin(ctx.cwd, String(body.path || ''));
  if (!target || target === path.resolve(ctx.cwd) || protectedTarget(ctx.cwd, target, ctx)) return bad(res, 403, 'forbidden');
  if (!existsSync(target)) return bad(res, 404, 'not found');
  try { rmSync(target, { recursive: true, force: true }); } catch { return bad(res, 500, 'delete error'); }
  okJson(res, { ok: true });
}

export async function handleRename(req, res, identify) {
  let ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return bad(res, 400, 'bad json'); }
  ctx = scopeCtx(ctx, body.ws, res);
  if (!ctx) return;
  const src = safeJoin(ctx.cwd, String(body.path || ''));
  const name = sanitizeName(body.name);
  if (!src || src === path.resolve(ctx.cwd) || protectedTarget(ctx.cwd, src, ctx) || !name || name === 'file') return bad(res, 403, 'forbidden');
  if (!existsSync(src)) return bad(res, 404, 'not found');
  const dst = path.join(path.dirname(src), name);
  if (!withinRoot(ctx.cwd, dst) || dst === path.resolve(ctx.cwd) || protectedTarget(ctx.cwd, dst, ctx)) return bad(res, 403, 'forbidden');
  if (existsSync(dst)) return bad(res, 409, 'exists');
  try { renameSync(src, dst); } catch { return bad(res, 500, 'rename error'); }
  okJson(res, { ok: true, name });
}

// srcCtx：源所在的作用域（缺省＝与目标同一个）。跨作用域搬运（工作台里某个项目目录 → vault 根页，
// 或反过来）时两边各自是经 scopeCtx 授权过的根，源按 srcCtx 解析、目标按 ctx 解析。
export function resolveTransfer(ctx, srcRel, destRel, srcCtx = ctx) {
  const src = safeJoin(srcCtx.cwd, srcRel);
  const destDir = safeJoin(ctx.cwd, destRel);
  if (!src || !destDir || src === path.resolve(srcCtx.cwd)
    || protectedTarget(srcCtx.cwd, src, srcCtx) || protectedTarget(ctx.cwd, destDir, ctx)) return { err: 'forbidden', code: 403 };
  if (!existsSync(src)) return { err: 'not found', code: 404 };
  try { if (!statSync(destDir).isDirectory()) return { err: 'dest not a folder', code: 400 }; }
  catch { return { err: 'dest not found', code: 404 }; }
  const srcResolved = path.resolve(src);
  const destResolved = path.resolve(destDir);
  // 两道：① 字面路径（大小写不敏感，见 relPosition）；② 真实路径——目标目录若是
  // 指回 src 内部的 junction/符号链接，字面判定看不出来，同样会拷进自身。此处
  // src 与 destDir 都已确认存在，realpath 一定解得开。
  if (relPosition(srcResolved, destResolved) !== 'outside'
    || isPathInside(destResolved, srcResolved)) {
    return { err: '不能移动/复制到自身或其子目录', code: 400 };
  }
  if (path.dirname(srcResolved) === destResolved) return { err: '已在该目录', code: 400 };
  return { src, dst: uniquePath(path.join(destDir, path.basename(src))) };
}

// body.fromWs（可选）＝源作用域：给了就按它解析 path（跨作用域拖放），没给＝与 ws 同根。
// 两个根各自过 scopeCtx（无 shell 身份一律 403、非 admin 必须在自己空间内），跨根不放宽任何一边。
function scopePair(base, body, res) {
  const dst = scopeCtx(base, body.ws, res);
  if (!dst) return null;
  const src = body.fromWs != null && String(body.fromWs) !== String(body.ws || '') ? scopeCtx(base, String(body.fromWs), res) : dst;
  if (!src) return null;
  return { dst, src };
}

export async function handleMove(req, res, identify) {
  const base = requireCtx(identify, req, res);
  if (!base) return;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return bad(res, 400, 'bad json'); }
  const pair = scopePair(base, body, res);
  if (!pair) return;
  const transfer = resolveTransfer(pair.dst, String(body.path || ''), String(body.dest || ''), pair.src);
  if (transfer.err) return bad(res, transfer.code, transfer.err);
  try {
    renameSync(transfer.src, transfer.dst);
  } catch (error) {
    if (error?.code !== 'EXDEV') return bad(res, 500, 'move error');
    // 跨卷回落成拷贝+删除。整目录搬运必须走异步 fs/promises：cpSync 会把单线程的
    // 服务钉死到拷完为止（所有 SSE / 其他用户一起停摆）。
    try {
      await cpAsync(transfer.src, transfer.dst, { recursive: true });
      await rmAsync(transfer.src, { recursive: true, force: true });
    } catch {
      return bad(res, 500, 'move error');
    }
  }
  okJson(res, { ok: true, name: path.basename(transfer.dst) });
}

export async function handleCopy(req, res, identify) {
  const base = requireCtx(identify, req, res);
  if (!base) return;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return bad(res, 400, 'bad json'); }
  const pair = scopePair(base, body, res);
  if (!pair) return;
  const transfer = resolveTransfer(pair.dst, String(body.path || ''), String(body.dest || ''), pair.src);
  if (transfer.err) return bad(res, transfer.code, transfer.err);
  // 异步拷贝：整目录可能很大，cpSync 会阻塞整个事件循环（见 relPosition 注释）。
  try { await cpAsync(transfer.src, transfer.dst, { recursive: true }); } catch { return bad(res, 500, 'copy error'); }
  okJson(res, { ok: true, name: path.basename(transfer.dst) });
}

export async function handleSaveFile(req, res, identify) {
  let ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return bad(res, 400, 'bad json'); }
  ctx = scopeCtx(ctx, body.ws, res);
  if (!ctx) return;
  const target = safeJoin(ctx.cwd, String(body.path || ''));
  if (!target || target === path.resolve(ctx.cwd) || protectedTarget(ctx.cwd, target, ctx)) return bad(res, 403, 'forbidden');
  const ext = path.extname(target).slice(1).toLowerCase();
  if (!ext || !TEXT_EXT.has(ext)) return bad(res, 415, 'not an editable text file');
  const content = String(body.content ?? '');
  if (Buffer.byteLength(content, 'utf8') > 5_000_000) return bad(res, 413, 'too large');
  try { if (!statSync(target).isFile()) return bad(res, 400, 'not a file'); }
  catch { return bad(res, 404, 'not found'); }
  // 写前校验（防覆盖别处的修改）：客户端带上这次保存基于的那份磁盘原文的指纹 baseHash。编辑器里有没存的
  // 字时，Claude 的 Edit / 其他端可能已经改过盘，不校验的话下一次自动保存会把那些修改整篇盖掉。
  // 对不上 → 409 附上当前内容，由客户端三方合并；没带 baseHash 的老客户端照旧直接写。
  if (typeof body.baseHash === 'string' && body.baseHash) {
    let cur;
    try { cur = readFileSync(target, 'utf8').replace(/^﻿/, ''); } catch { return bad(res, 500, 'read error'); }
    if (textHash(cur) !== body.baseHash) {
      res.writeHead(409, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'conflict', current: cur }));
    }
  }
  try { writeFileSync(target, content, 'utf8'); } catch { return bad(res, 500, 'write error'); }
  okJson(res, { ok: true });
}

// 文本指纹（cyrb53 + 长度），与前端 web/src/lib/textmerge.js 的 textHash 同一算法、同一输入口径
// （JS 字符串按 UTF-16 码元，已去掉 BOM）——只用来判断「磁盘是不是还是那份」，不做安全用途。
export function textHash(s) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36) + ':' + s.length;
}

export async function handleToUpload(req, res, identify) {
  let ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return bad(res, 400, 'bad json'); }
  ctx = scopeCtx(ctx, body.ws, res);
  if (!ctx) return;
  const src = safeJoin(ctx.cwd, String(body.path || ''));
  if (!src) return bad(res, 403, 'forbidden');
  let stat;
  try { stat = statSync(src); } catch { return bad(res, 404, 'not found'); }
  const name = sanitizeName(path.basename(src));
  if (stat.isDirectory()) return okJson(res, { path: src, name, isDir: true });
  if (body.copy === false) return okJson(res, { path: src, name });
  if (stat.size > 60_000_000) return bad(res, 413, '文件太大（附件上限 60MB）');
  try { mkdirSync(ctx.uploads, { recursive: true }); } catch {}
  const dest = path.join(ctx.uploads, `${Date.now()}-${name}`);
  try { await cpAsync(src, dest); } catch { return bad(res, 500, 'copy error'); }
  okJson(res, { path: dest, name });
}
