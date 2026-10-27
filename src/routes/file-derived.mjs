import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import {
  readFile as readFileAsync,
  readdir as readdirAsync,
  stat as statAsync,
} from 'node:fs/promises';
import { requireCtx, requireReadCtx } from '../runtime/identity.mjs';
import { readBody } from '../runtime/body.mjs';
import { sanitizeName, stripLinks } from '../runtime/paths.mjs';
import { safeJoin, withinRoot } from '../runtime/http-file.mjs';
import {
  SEARCH_SKIP, bad, gitGuarded, hiddenInList, okJson, protectedTarget, scopeCtx, uniquePath,
} from './file-core.mjs';

// 解出来的树里所有叫 .git 的项（目录或 worktree 指针文件）整个删掉：没有命令行的身份不许有 git 仓库内部文件
// （见 file-core.mjs gitGuarded 的说明）。链接已先被 stripLinks 剔掉，这里只看普通目录项。返回删了几项。
function stripGitDirs(dir) {
  let removed = 0;
  let names;
  try { names = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
  for (const d of names) {
    const p = path.join(dir, d.name);
    if ((process.platform === 'win32' ? d.name.toLowerCase() : d.name) === '.git') {
      try { rmSync(p, { recursive: true, force: true }); removed++; } catch {}
      continue;
    }
    if (d.isDirectory()) removed += stripGitDirs(p);
  }
  return removed;
}

const ARCHIVE_EXT = new Set(['rar', 'zip', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'txz', 'tbz2']);
export const isArchiveName = (name) => ARCHIVE_EXT.has(path.extname(name).slice(1).toLowerCase());

const firstExisting = (candidates) => candidates.find((candidate) => existsSync(candidate)) || null;
const UNRAR = () => firstExisting([
  'C:\\Program Files\\WinRAR\\UnRAR.exe',
  'C:\\Program Files (x86)\\WinRAR\\UnRAR.exe',
  '/usr/bin/unrar',
]);
const SEVENZ = () => firstExisting([
  'C:\\Program Files\\7-Zip\\7z.exe',
  'C:\\Program Files (x86)\\7-Zip\\7z.exe',
  '/usr/bin/7z',
]);
const BSDTAR = () => firstExisting([
  'C:\\Windows\\System32\\tar.exe',
  '/usr/bin/bsdtar',
  '/usr/bin/tar',
]);

function runTool(executable, args, timeoutMs = 600_000, { cwd, label = '解压超时' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, cwd });
    let errorOutput = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error(label));
    }, timeoutMs);
    child.stderr.on('data', (data) => { if (errorOutput.length < 4000) errorOutput += data; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(
        path.basename(executable) + ' exit ' + code
        + (errorOutput ? '：' + errorOutput.trim().slice(0, 200) : ''),
      ));
    });
  });
}

function archiveBaseName(name) {
  let base = path.basename(name, path.extname(name));
  if (/\.tar$/i.test(base)) base = base.slice(0, -4);
  return base || name;
}

// dropGit：解完把树里的 .git 全删掉（没有命令行的身份；不传按保守默认删）。
export async function extractArchive(root, rel, { dropGit = true } = {}) {
  const file = safeJoin(root, rel);
  if (!file) return { error: '路径越界，拒绝' };
  if (protectedTarget(root, file)) return { error: '不能操作 bridge 的系统目录' };
  let stat;
  try { stat = statSync(file); } catch { return { error: '文件不存在' }; }
  if (stat.isDirectory()) return { error: '这是文件夹，不是压缩包' };
  const ext = path.extname(file).slice(1).toLowerCase();
  if (!ARCHIVE_EXT.has(ext)) return { error: '不是支持的压缩包格式（支持 rar/zip/7z/tar/gz 等）' };
  const dest = uniquePath(path.join(path.dirname(file), archiveBaseName(path.basename(file))));

  const unrar = UNRAR();
  const sevenz = SEVENZ();
  const tar = BSDTAR();
  const tarCandidate = tar ? [tar, ['-xf', file, '-C', dest]] : null;
  const tarUtf8Candidate = tar
    ? [tar, ['--options', 'hdrcharset=UTF-8', '-xf', file, '-C', dest]]
    : null;
  const unrarCandidate = unrar
    ? [unrar, ['x', '-o+', '-y', '-p-', file, dest + path.sep]]
    : null;
  const sevenzCandidate = sevenz
    ? [sevenz, ['x', '-y', '-p-', '-o' + dest, file]]
    : null;
  const chain = (
    ext === 'rar'
      ? [unrarCandidate, sevenzCandidate, tarCandidate, tarUtf8Candidate]
      : ext === '7z'
        ? [sevenzCandidate, tarCandidate, tarUtf8Candidate]
        : [tarCandidate, tarUtf8Candidate, sevenzCandidate]
  ).filter(Boolean);
  if (!chain.length) return { error: '电脑上没有可用的解压工具（装 WinRAR 或 7-Zip）' };

  let lastError = '';
  for (const [executable, args] of chain) {
    try { mkdirSync(dest, { recursive: true }); } catch {}
    try {
      await runTool(executable, args);
      if (!readdirSync(dest).length) throw new Error('解出的目录是空的');
      stripLinks(dest);
      if (dropGit) stripGitDirs(dest);
      return {
        ok: true,
        name: path.basename(dest),
        path: path.relative(path.resolve(root), dest).split(path.sep).join('/'),
      };
    } catch (error) {
      lastError = String(error?.message ?? error);
      try { rmSync(dest, { recursive: true, force: true }); } catch {}
    }
  }
  return { error: `解压失败（${lastError.slice(0, 200)}）——若压缩包有密码暂不支持` };
}

export async function handleExtract(req, res, identify) {
  let ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return bad(res, 400, 'bad json'); }
  ctx = scopeCtx(ctx, body.ws, res);
  if (!ctx) return;
  const result = await extractArchive(ctx.cwd, String(body.path || ''), { dropGit: gitGuarded(ctx) });
  if (result.error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: result.error }));
    return;
  }
  okJson(res, result);
}

// —— 压缩（工作空间长按/右键「压缩…」，手机与网页端的内置选项；桌面壳走 Windows 自带的「创建存档」向导）——
//
// 工具：zip / 7z / tar.gz 全用系统自带的 bsdtar（libarchive 3.8 带 liblzma，能写 7zip）；rar 要装了 WinRAR 的
// Rar.exe 才出。zip 一律写 UTF-8 文件名并置位通用标志 bit 11（hdrcharset=UTF-8）——不加的话 bsdtar 按 ANSI
// 码页写（中文 Windows＝GBK），在 Mac / 手机上解开就是乱码。
//
// 大文件夹压缩要几分钟，而隧道会掐掉 100 秒没回的请求：POST 只登记任务立即回 { job }，前端拿 job 轮询 GET。
// 先写同目录下的隐藏临时文件，成功后改名到 uniquePath 定下的最终名（失败/中途出错都不留半截存档）。
const RAR = () => firstExisting([
  'C:\\Program Files\\WinRAR\\Rar.exe',
  'C:\\Program Files (x86)\\WinRAR\\Rar.exe',
  '/usr/bin/rar',
]);
const COMPRESS_LEVELS = ['store', 'fast', 'normal', 'max'];
const COMPRESS_FORMATS = {
  zip: {
    ext: '.zip',
    tool: BSDTAR,
    args: (level) => ['--format', 'zip', '--options', 'zip:hdrcharset=UTF-8,'
      + (level === 'store' ? 'zip:compression=store' : `zip:compression-level=${{ fast: 1, normal: 6, max: 9 }[level]}`)],
  },
  '7z': {
    ext: '.7z',
    tool: BSDTAR,
    args: (level) => ['--format', '7zip', '--options',
      level === 'store' ? '7zip:compression=store' : `7zip:compression=lzma2,7zip:compression-level=${{ fast: 1, normal: 5, max: 9 }[level]}`],
  },
  'tar.gz': {
    ext: '.tar.gz',
    tool: BSDTAR,
    // gzip 没有「仅存储」：存储档按最快算
    args: (level) => ['--format', 'pax', '-z', '--options', `gzip:compression-level=${{ store: 1, fast: 1, normal: 6, max: 9 }[level]}`],
  },
  rar: {
    ext: '.rar',
    tool: RAR,
    rar: true,
    args: (level) => [`-m${{ store: 0, fast: 1, normal: 3, max: 5 }[level]}`],
  },
};
// uniquePath 按 extname 切后缀，「x.tar.gz」会变成「x.tar (1).gz」——存档名按整段扩展名编号
function uniqueArchive(dir, base, ext) {
  let candidate = path.join(dir, base + ext);
  for (let index = 1; existsSync(candidate) && index < 1000; index += 1) candidate = path.join(dir, `${base} (${index})${ext}`);
  return candidate;
}
export const compressFormats = () => Object.keys(COMPRESS_FORMATS).filter((key) => COMPRESS_FORMATS[key].tool());

const compressJobs = new Map();   // id → { owner, state:'running'|'done'|'error', name, path, error, tmp, started, finished }
const COMPRESS_JOB_TTL = 30 * 60_000;
function sweepCompressJobs() {
  const now = Date.now();
  for (const [id, job] of compressJobs) if (job.finished && now - job.finished > COMPRESS_JOB_TTL) compressJobs.delete(id);
}

// rels：同一目录下的若干项（相对 root）。返回 { job } 或 { error, code }。
export function startCompress(root, rels, { format = 'zip', level = 'normal', name = '', owner = '', ctx = null } = {}) {
  const spec = COMPRESS_FORMATS[format];
  if (!spec) return { error: '不支持的压缩格式', code: 400 };
  const executable = spec.tool();
  if (!executable) return { error: format === 'rar' ? '电脑上没有装 WinRAR，不能压成 rar' : '电脑上没有可用的压缩工具', code: 500 };
  if (!COMPRESS_LEVELS.includes(level)) level = 'normal';
  const list = [...new Set((Array.isArray(rels) ? rels : [rels]).map((rel) => String(rel || '')))];
  if (!list.length || list.length > 500) return { error: '要压缩的项数不对', code: 400 };
  const targets = [];
  for (const rel of list) {
    const target = rel ? safeJoin(root, rel) : null;
    if (!target || target === path.resolve(root) || protectedTarget(root, target, ctx)) return { error: '不能压缩这一项', code: 403 };
    if (!existsSync(target)) return { error: '文件不存在', code: 404 };
    targets.push(target);
  }
  const dir = path.dirname(targets[0]);
  if (targets.some((target) => path.dirname(target) !== dir)) return { error: '只能压缩同一个文件夹里的项', code: 400 };
  let base = String(name || '').trim();
  if (base.toLowerCase().endsWith(spec.ext)) base = base.slice(0, -spec.ext.length);
  // 缺省名：单个文件去扩展名、单个文件夹用原名（「v1.2」别被当成扩展名切掉）、多项用所在文件夹名
  if (!base) {
    const one = targets.length === 1 ? targets[0] : '';
    base = one ? (statSync(one).isDirectory() ? path.basename(one) : archiveBaseName(path.basename(one))) : path.basename(dir) || 'archive';
  }
  base = sanitizeName(base);
  const dest = uniqueArchive(dir, base, spec.ext);
  if (!withinRoot(root, dest) || protectedTarget(root, dest, ctx)) return { error: '不能写到这里', code: 403 };
  const id = randomBytes(9).toString('base64url');
  // 临时名带上真扩展名：bsdtar 按 --format 写、不看后缀，Rar.exe 则会给没有 .rar 的名字自己补一个
  const tmp = path.join(dir, `.bridge-zip-${id}${spec.ext}`);
  const names = targets.map((target) => path.basename(target));
  // 以 - 开头的名字会被当成开关：bsdtar 前缀 ./，Rar.exe 有 -- 收尾
  const args = spec.rar
    ? ['a', '-r', '-idq', '-y', ...spec.args(level), '--', tmp, ...names]
    : ['-c', '-f', tmp, ...spec.args(level), ...names.map((n) => (n.startsWith('-') ? './' + n : n))];
  const job = { owner, state: 'running', name: path.basename(dest), path: '', error: '', tmp, started: Date.now(), finished: 0 };
  sweepCompressJobs();
  compressJobs.set(id, job);
  runTool(executable, args, 4 * 3600_000, { cwd: dir, label: '压缩超时' })
    .then(() => {
      // 跑的这几分钟里同名文件可能被别处占了：落地前再按最终名查一次
      const final = uniqueArchive(dir, base, spec.ext);
      renameSync(tmp, final);
      job.name = path.basename(final);
      job.path = path.relative(path.resolve(root), final).split(path.sep).join('/');
      job.state = 'done';
    })
    .catch((error) => {
      try { rmSync(tmp, { force: true }); } catch {}
      job.state = 'error';
      job.error = String(error?.message ?? error).slice(0, 300);
    })
    .finally(() => { job.finished = Date.now(); });
  return { job: id, name: job.name };
}

export function compressStatus(id, owner) {
  const job = compressJobs.get(String(id || ''));
  if (!job || job.owner !== owner) return null;
  let bytes = 0;
  if (job.state === 'running') { try { bytes = statSync(job.tmp).size; } catch {} }
  return { state: job.state, name: job.name, path: job.path, error: job.error, bytes, elapsed: (job.finished || Date.now()) - job.started };
}

export async function handleCompress(req, res, identify) {
  let ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return bad(res, 400, 'bad json'); }
  ctx = scopeCtx(ctx, body.ws, res);
  if (!ctx) return;
  const result = startCompress(ctx.cwd, Array.isArray(body.paths) ? body.paths : [body.path], {
    format: String(body.format || 'zip'), level: String(body.level || 'normal'), name: String(body.name || ''), owner: ctx.key || ctx.kind, ctx,
  });
  if (result.error) return okJson(res, { error: result.error }, result.code || 500);
  okJson(res, { ok: true, ...result });
}

export async function handleCompressStatus(req, res, url, identify) {
  const ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  if (url.searchParams.get('formats') === '1') return okJson(res, { formats: compressFormats() });
  const status = compressStatus(url.searchParams.get('job'), ctx.key || ctx.kind);
  if (!status) return okJson(res, { error: '任务不存在' }, 404);
  okJson(res, status);
}

const MD_EXT = new Set(['md', 'markdown', 'mdown', 'mkd']);
const mdBase = (name) => name.replace(/\.[^.]+$/, '');
const extOf = (name) => path.extname(name).slice(1).toLowerCase();

// —— 笔记树遍历（mdlinks 的反链/出链解析 与 mdnames 的 [[ 补全名单共用）——
// 从笔记所在目录往下【按层】走（BFS）：深度 ≤4、访问 ≤2500 项（跳过的也计数），超出即 truncated。
// 必须按层：以前是深度优先，readdir 顺序里排在前面的点开头大目录（.claude / .codex-work / .scratch，
// 合计两千多项）先把预算吃光，同目录的 attachments/ 和旁边的笔记根本走不到——![[图]] 全部解析失败
// （2026-10-21 反馈「插图失败」）。按层走，浅处的文件永远先进名单，nameIndex 的「同名取最浅」也天然成立。
// 点开头的项一律不进（Obsidian 也不索引隐藏文件夹；.git / .obsidian / .trash 都不是笔记）——和文件列表
// 「点开头照常显示」的策略不同，是有意的：这里是笔记索引，不是目录浏览。起点本身在点目录里（打开的就是
// .claude/memory 下的笔记）不受影响：只过滤遍历途中遇到的子项。
// 两个接口看到的必须是同一棵树——补全里列出来的名字，mdlinks 一定解析得到，反之亦然。
// 其余可见性跟文件列表同一套 hiddenInList（沙箱根下的 .bridge 系统目录等）。
const NOTE_WALK_DEPTH = 4;
const NOTE_WALK_VISITS = 2500;
const skipNoteEntry = (name) => name.startsWith('.') || SEARCH_SKIP.has(name);
// onFile(file) 返回 false 即停（按名查找找齐了）；file = { abs, rel, name, md, depth }
async function bfsNotes(ctx, startDir, { maxDepth, maxVisits, onFile }) {
  const root = path.resolve(ctx.cwd);
  const toRel = (absolute) => path.relative(root, absolute).split(path.sep).join('/');
  let visited = 0;
  let level = [startDir];
  for (let depth = 0; level.length && depth <= maxDepth; depth += 1) {
    const next = [];
    for (const currentDir of level) {
      let entries;
      try { entries = await readdirAsync(currentDir, { withFileTypes: true }); } catch { continue; }
      const here = toRel(currentDir);
      for (const entry of entries) {
        visited += 1;
        if (visited > maxVisits) return { truncated: true };
        if (skipNoteEntry(entry.name) || hiddenInList(ctx, entry.name, here)) continue;
        const absolute = path.join(currentDir, entry.name);
        let isDir = false;
        try { isDir = entry.isDirectory(); } catch { continue; }
        if (isDir) { next.push(absolute); continue; }
        const file = { abs: absolute, rel: toRel(absolute), name: entry.name, md: MD_EXT.has(extOf(entry.name)), depth };
        if (onFile(file) === false) return { truncated: false };
      }
    }
    level = next;
  }
  return { truncated: false };
}
export async function walkNoteTree(ctx, startDir) {
  const files = [];   // 按层的顺序（浅的在前，同层保持目录顺序）
  const { truncated } = await bfsNotes(ctx, startDir, {
    maxDepth: NOTE_WALK_DEPTH, maxVisits: NOTE_WALK_VISITS, onFile: (file) => { files.push(file); },
  });
  return { files, truncated };
}

// —— ![[附件]] 的定点探测（不靠遍历预算）——
// Obsidian 按全库文件名解析嵌入；附件几乎总在这几处之一：笔记同目录、<笔记目录>/attachments/（bridge 插图的
// 落盘处，见 DocViewer saveAttachment）、Obsidian 设置的附件目录（<库根>/.obsidian/app.json 的
// attachmentFolderPath：「./x」相对笔记目录，「/」或缺省＝库根，其余相对库根）、库根。只 stat，不读内容。
// 库根＝从笔记目录往上第一个带 .obsidian 的目录（不出作用域根）；没有就当作用域根。
const VAULT_TTL = 60_000;
const vaultConf = new Map();   // 库根 → { at, folder }
async function vaultRootOf(root, dir) {
  for (let current = dir; ; current = path.dirname(current)) {
    try { if ((await statAsync(path.join(current, '.obsidian'))).isDirectory()) return current; } catch {}
    const up = path.dirname(current);
    if (current === root || up === current || !withinRoot(root, up)) return root;
  }
}
async function attachFolderOf(vault, dir) {
  let hit = vaultConf.get(vault);
  if (!hit || Date.now() - hit.at > VAULT_TTL) {
    let folder = '';
    try { folder = String(JSON.parse(await readFileAsync(path.join(vault, '.obsidian', 'app.json'), 'utf8'))?.attachmentFolderPath ?? ''); } catch {}
    hit = { at: Date.now(), folder: folder.trim() };
    vaultConf.set(vault, hit);
  }
  const folder = hit.folder;
  if (!folder || folder === '/') return vault;
  if (folder === '.' || folder.startsWith('./')) return path.resolve(dir, folder);
  return path.resolve(vault, folder.replace(/^[\\/]+/, ''));
}

// 定点探测也没有的附件嵌入（附件被挪到别处了）：全库按文件名找一遍——只找这几个名字、找齐就停，
// 预算 1 万项、≤1.5s（实测维护者的库走满 2 万项要 3s，不能再大）。结果（含「没找到」）按 作用域根+库根+名字
// 缓存 5 分钟：每次自动保存都会重算出链，不能每次都扫全库。作用域根必须进键：rel 是相对作用域根算的，同一个库
// 经 primary 根和 ?ws= 项目根两条路访问时，拿对方的 rel 去取图就是 404。
// 只给附件嵌入（ATTACH_EXT）用：普通 [[未写的笔记]]、![[笔记]] 找不到是常态，不值得扫。
const FIND_VISITS = 10_000;
const FIND_DEPTH = 10;
const FIND_MS = 1500;
const FIND_TTL = 5 * 60_000;
const findCache = new Map();   // 作用域根 \0 库根 \0 名字（小写，可带路径）→ { at, rel }
async function findInVault(ctx, vault, names) {
  const out = new Map();       // 名字（小写）→ rel
  const missing = new Map();   // 末段文件名（小写）→ [名字…]
  const now = Date.now();
  const scope = path.resolve(ctx.cwd) + '\0' + vault + '\0';
  for (const name of names) {
    const key = name.toLowerCase();
    const hit = findCache.get(scope + key);
    if (hit && now - hit.at < FIND_TTL) { if (hit.rel) out.set(key, hit.rel); continue; }
    const base = key.split('/').pop();
    missing.set(base, [...(missing.get(base) || []), key]);
  }
  if (!missing.size) return out;
  const found = new Map();
  const wanted = [...missing.values()].flat().length;
  await bfsNotes(ctx, vault, {
    maxDepth: FIND_DEPTH, maxVisits: FIND_VISITS,
    onFile: (file) => {
      const keys = missing.get(file.name.toLowerCase());
      if (keys) {
        const rel = file.rel.toLowerCase();
        for (const key of keys) {
          if (!found.has(key) && (!key.includes('/') || rel === key || rel.endsWith('/' + key))) found.set(key, file.rel);
        }
      }
      if (found.size >= wanted || Date.now() - now > FIND_MS) return false;
    },
  });
  if (findCache.size > 4000) findCache.clear();
  for (const key of [...missing.values()].flat()) {
    findCache.set(scope + key, { at: now, rel: found.get(key) || null });
    if (found.has(key)) out.set(key, found.get(key));
  }
  return out;
}

// —— 反链：每篇 md 链向哪些名字，按 (mtime, size) 缓存 ——
// 以前每次打开笔记、每次自动保存（≥10s 一次）都把整棵树里的 md 全文读一遍跑正则（实测 876 篇约 0.9s）。
// 现在每篇只在改过之后读一次，记下它链向的名字（[[x]] 的末段名、](…/x.md) 的文件名，都转小写）；
// 一次请求只读真正命中的那几篇（要出摘录），其余只 stat。
const TARGET_CACHE_MAX = 20_000;
const targetCache = new Map();   // abs → { mtimeMs, size, targets: Set('w:名字' | 'm:文件名') }
// 一行里的出链目标。反链的预筛（linkTargetsOf）与计数（mdLinksFor）共用这一个函数，口径天然一致——
// 预筛漏掉的就是丢掉的反链（上一版两边各写一套正则，预筛比计数严，「报告 (1).md」「my note.md」的 md 反链全丢）。
//   [[路径/名字#标题|别名]] → onWiki(末段名，小写)
//   ](…/文件名.md)          → onHref(Set(末段文件名，小写；带 %xx 的另给一份解码后的))
// md 链接的文件名可以带括号和空格（Obsidian 生成的 md 链接只把空格编成 %20、括号原样；手写的常直接带空格），
// 不能用 [^()\s]+ 一把抓：从每个「](」起，到同一行里每个以 md 扩展名收尾的「)」都试一次；目录部分沿用
// 老口径（不含括号与空白）。
const MD_HREF_END = /\.(?:md|markdown|mdown|mkd)\)/gi;
function scanLinkTargets(line, onWiki, onHref) {
  for (const match of line.matchAll(/\[\[([^[\]\n]+?)\]\]/g)) {
    const cut = match[1].search(/[#|]/);
    const name = (cut >= 0 ? match[1].slice(0, cut) : match[1]).split('/').pop().trim().toLowerCase();
    if (name) onWiki(name);
  }
  for (let from = line.indexOf(']('); from >= 0; from = line.indexOf('](', from + 2)) {
    const names = new Set();
    MD_HREF_END.lastIndex = from + 2;
    for (let end; (end = MD_HREF_END.exec(line));) {
      const inner = line.slice(from + 2, end.index + end[0].length - 1);
      const slash = inner.lastIndexOf('/');
      if (slash >= 0 && /[()\s]/.test(inner.slice(0, slash))) continue;
      const raw = inner.slice(slash + 1);
      names.add(raw.toLowerCase());
      try { names.add(decodeURIComponent(raw).toLowerCase()); } catch {}
    }
    if (names.size) onHref(names);
  }
}
function linkTargetsOf(text) {
  const targets = new Set();
  for (const line of text.split('\n')) {
    scanLinkTargets(line, (name) => targets.add('w:' + name), (names) => { for (const name of names) targets.add('m:' + name); });
  }
  return targets;
}

// ![[嵌入]] 能用的附件（对齐 Obsidian「支持的文件类型」：图片 / 音视频 / PDF / 画布）。
// 名单只收这些 + md：代码仓库里成百上千的 .js/.json 进了补全只会把笔记淹掉。
const ATTACH_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'heic', 'ico',
  'pdf',
  'mp3', 'wav', 'm4a', 'ogg', 'flac', 'aac', 'opus',
  'mp4', 'webm', 'mov', 'mkv', 'ogv', 'm4v',
  'canvas', 'base',
]);

// GET /api/file/mdnames?path=<笔记或目录>&ws= —— 编辑器 [[ / ![[ 补全的候选名单。
// 权限、作用域、遍历范围与上限跟 mdlinks 完全一致（requireReadCtx：分享桶里也能用，同 mdlinks）。
// 返回 { names: [{ name, path, md }], truncated }：md 的 name 去扩展名（[[笔记]] 的写法），
// 附件保留扩展名（![[图.png]] 必须带，mdlinks 的名字索引也是按全名建的）；path 相对作用域根。
// 按深度排（离当前笔记近的在前），同深度保持目录遍历顺序。
export async function handleMdNames(req, res, url, identify) {
  let ctx = requireReadCtx(identify, req, res);
  if (!ctx) return;
  ctx = scopeCtx(ctx, url.searchParams.get('ws'), res);
  if (!ctx) return;
  const target = safeJoin(ctx.cwd, url.searchParams.get('path') || '');
  if (!target) return bad(res, 403, 'forbidden');
  // 传笔记 → 取它所在目录；传目录 → 就是它。笔记刚被改名/删掉时退回父目录，名单照样能给
  let dir = null;
  for (const candidate of [target, path.dirname(target)]) {
    if (!withinRoot(ctx.cwd, candidate)) break;
    try {
      const stat = await statAsync(candidate);
      dir = stat.isDirectory() ? candidate : path.dirname(candidate);
      break;
    } catch {}
  }
  if (!dir) return bad(res, 404, 'not found');
  okJson(res, { ok: true, ...(await mdNamesFor(ctx, dir)) });
}
export async function mdNamesFor(ctx, dir) {
  const { files, truncated } = await walkNoteTree(ctx, dir);
  const names = [];
  for (const file of files) {
    if (file.md) names.push({ name: mdBase(file.name), path: file.rel, md: true, depth: file.depth });
    else if (ATTACH_EXT.has(extOf(file.name))) names.push({ name: file.name, path: file.rel, md: false, depth: file.depth });
  }
  names.sort((a, b) => a.depth - b.depth);   // 遍历本来就按层；Array#sort 稳定，同深度保持遍历顺序
  return { names: names.map(({ depth, ...rest }) => rest), truncated };
}

export async function handleMdLinks(req, res, url, identify) {
  let ctx = requireReadCtx(identify, req, res);
  if (!ctx) return;
  ctx = scopeCtx(ctx, url.searchParams.get('ws'), res);
  if (!ctx) return;
  const file = safeJoin(ctx.cwd, url.searchParams.get('path') || '');
  if (!file) return bad(res, 403, 'forbidden');
  if (!MD_EXT.has(path.extname(file).slice(1).toLowerCase())) return bad(res, 415, 'not markdown');
  let stat;
  try { stat = await statAsync(file); } catch { return bad(res, 404, 'not found'); }
  if (!stat.isFile() || stat.size > 1_500_000) return bad(res, 413, 'not a readable note');
  let content;
  try { content = await readFileAsync(file, 'utf8'); } catch { return bad(res, 500, 'read error'); }
  okJson(res, { ok: true, ...(await mdLinksFor(ctx, file, content)) });
}

// 一篇笔记的出链（每个 [[ ]] / ![[ ]] / 相对 md 链接解析到的路径，解析不到 path=null）与反链。
// file：笔记绝对路径（已在 ctx.cwd 内）；content：它的正文。
export async function mdLinksFor(ctx, file, content) {
  const root = path.resolve(ctx.cwd);
  const dir = path.dirname(file);
  const toRel = (absolute) => path.relative(root, absolute).split(path.sep).join('/');
  const inRoot = (absolute) => withinRoot(root, absolute);

  const outgoing = [];
  const seenOutgoing = new Set();
  for (const match of content.matchAll(/(!?)\[\[([^[\]\n]+?)\]\]/g)) {
    let target = match[2];
    const pipe = target.indexOf('|');
    if (pipe >= 0) target = target.slice(0, pipe);
    const heading = target.indexOf('#');
    if (heading >= 0) target = target.slice(0, heading);
    target = target.trim();
    if (!target || seenOutgoing.has(target.toLowerCase())) continue;
    seenOutgoing.add(target.toLowerCase());
    outgoing.push({ name: target, embed: !!match[1], path: null });
  }
  for (const match of content.matchAll(/\]\(([^()\s]+?\.md)\)/gi)) {
    let target = match[1];
    try { target = decodeURIComponent(target); } catch {}
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const absolute = path.resolve(dir, target);
    if (!inRoot(absolute)) continue;
    try { if (!(await statAsync(absolute)).isFile()) continue; } catch { continue; }
    const base = mdBase(path.basename(absolute));
    if (seenOutgoing.has(base.toLowerCase())) continue;
    seenOutgoing.add(base.toLowerCase());
    outgoing.push({ name: base, embed: false, path: toRel(absolute) });
  }

  const currentBase = mdBase(path.basename(file));
  const nameIndex = new Map();
  const markdownFiles = [];
  const { files: treeFiles, truncated } = await walkNoteTree(ctx, dir);
  for (const treeFile of treeFiles) {
    const key = (treeFile.md ? mdBase(treeFile.name) : treeFile.name).toLowerCase();
    const previous = nameIndex.get(key);
    if (!previous || treeFile.depth < previous.depth) nameIndex.set(key, { rel: treeFile.rel, depth: treeFile.depth });
    if (treeFile.md && treeFile.abs !== file) markdownFiles.push(treeFile.abs);
  }
  // 带路径的 [[子目录/笔记]]（补全在重名时插的就是这种）：按相对路径后缀认准那一个，
  // 不能直接退到文件名索引——那只认最浅的同名笔记，会跳错文件。
  const byPathSuffix = (key) => {
    let best = null;
    for (const treeFile of treeFiles) {
      const rel = (treeFile.md ? treeFile.rel.replace(/\.[^./]+$/, '') : treeFile.rel).toLowerCase();
      if ((rel === key || rel.endsWith('/' + key)) && (!best || treeFile.depth < best.depth)) best = treeFile;
    }
    return best;
  };

  // 名单里没有的（遍历截断 / 在笔记子树之外）：定点探测几个常见落点，附件嵌入再退到全库按名查找。
  // 笔记嵌入 ![[笔记]]（名字不带附件扩展名）与 [[笔记]] 同口径：先试「名字.md」、不扫全库——只试裸名的话
  // 必然探测不到，还每 5 分钟白扫一遍库（最多 1.5s），这期间整篇的 ![[图]] 都停在占位上
  let vault = null, attachDir = null;
  const lost = [];
  for (const outgoingItem of outgoing) {
    if (outgoingItem.path) continue;
    const key = outgoingItem.name.toLowerCase();
    const indexed = nameIndex.get(key) || (key.includes('/') && byPathSuffix(key)) || nameIndex.get(key.split('/').pop());
    if (indexed) {
      outgoingItem.path = indexed.rel;
      continue;
    }
    vault ??= await vaultRootOf(root, dir);
    attachDir ??= await attachFolderOf(vault, dir);
    const attach = outgoingItem.embed && ATTACH_EXT.has(extOf(outgoingItem.name));
    const bases = outgoingItem.embed
      ? [dir, path.join(dir, 'attachments'), attachDir, vault, root]
      : [dir, vault, root];
    const names = attach ? [outgoingItem.name] : [outgoingItem.name + '.md', outgoingItem.name];
    outer: for (const base of [...new Set(bases)]) {
      for (const candidate of names) {
        const absolute = path.resolve(base, candidate);
        if (!inRoot(absolute)) continue;
        try {
          if ((await statAsync(absolute)).isFile()) {
            outgoingItem.path = toRel(absolute);
            break outer;
          }
        } catch {}
      }
    }
    if (!outgoingItem.path && attach) lost.push(outgoingItem);
  }
  if (lost.length) {
    const found = await findInVault(ctx, vault, lost.map((item) => item.name));
    for (const item of lost) item.path = found.get(item.name.toLowerCase()) || null;
  }

  // 计数与预筛同一个 scanLinkTargets：[[…/本篇#…|…]] 与 ](…/本篇.md)（原样、%xx 编码都认）
  const wantBase = currentBase.toLowerCase();
  const wantFile = path.basename(file).toLowerCase();
  const backlinks = [];
  for (const markdownFile of markdownFiles) {
    if (backlinks.length >= 100) break;
    let stat;
    try { stat = await statAsync(markdownFile); } catch { continue; }
    if (stat.size > 600_000) continue;
    let text = null;
    let cached = targetCache.get(markdownFile);
    if (!cached || cached.mtimeMs !== stat.mtimeMs || cached.size !== stat.size) {
      try { text = await readFileAsync(markdownFile, 'utf8'); } catch { continue; }
      cached = { mtimeMs: stat.mtimeMs, size: stat.size, targets: linkTargetsOf(text) };
      targetCache.delete(markdownFile);   // 重新插入＝挪到最新，超量时从最老的删
      targetCache.set(markdownFile, cached);
      if (targetCache.size > TARGET_CACHE_MAX) targetCache.delete(targetCache.keys().next().value);
    }
    if (!cached.targets.has('w:' + wantBase) && !cached.targets.has('m:' + wantFile)) continue;
    if (text == null) {
      try { text = await readFileAsync(markdownFile, 'utf8'); } catch { continue; }
    }
    let count = 0;
    const excerpts = [];
    for (const line of text.split('\n')) {
      let hits = 0;
      scanLinkTargets(line, (name) => { if (name === wantBase) hits += 1; }, (names) => { if (names.has(wantFile)) hits += 1; });
      if (!hits) continue;
      count += hits;
      if (excerpts.length < 3) {
        const trimmed = line.trim();
        excerpts.push(trimmed.length > 240 ? trimmed.slice(0, 240) + '…' : trimmed);
      }
    }
    if (count) {
      backlinks.push({
        path: toRel(markdownFile),
        name: mdBase(path.basename(markdownFile)),
        count,
        excerpts,
      });
    }
  }
  backlinks.sort((a, b) => b.count - a.count);
  return { outgoing, backlinks, truncated };
}

// 桌面壳拖进 md 编辑器的文件（webUtils.getPathForFile 给的绝对路径）→ 当前工作空间里的相对路径，
// 不在里面（或是受保护项）给 null：编辑器据此「本来就在库里的文件直接写链接、不再复制一份」。
// 桌面壳刻意不把位置根的绝对路径交给页面，所以换算放在服务端；只回答在不在、在哪，不读内容。
// 用 path.relative 判定（win32 下大小写不敏感，盘符/目录大小写不一致也认）。
export async function handleRelPaths(req, res, identify) {
  let ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  let body;
  try { body = JSON.parse(await readBody(req)); } catch { return bad(res, 400, 'bad json'); }
  ctx = scopeCtx(ctx, body.ws, res);
  if (!ctx) return;
  const root = path.resolve(ctx.cwd);
  const paths = Array.isArray(body.paths) ? body.paths.slice(0, 50) : [];
  const rels = paths.map((raw) => {
    if (typeof raw !== 'string' || !path.isAbsolute(raw)) return null;
    const abs = path.resolve(raw);
    const rel = path.relative(root, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (protectedTarget(root, abs, ctx) || !existsSync(abs)) return null;
    return rel.split(path.sep).join('/');
  });
  okJson(res, { ok: true, rels });
}
