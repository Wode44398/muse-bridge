import path from 'node:path';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import {
  readFile as readFileAsync,
  readdir as readdirAsync,
  stat as statAsync,
} from 'node:fs/promises';
import { requireCtx, requireReadCtx } from '../runtime/identity.mjs';
import { readBody } from '../runtime/body.mjs';
import { stripLinks } from '../runtime/paths.mjs';
import { safeJoin, withinRoot } from '../runtime/http-file.mjs';
import {
  SEARCH_SKIP, bad, hiddenInList, okJson, protectedTarget, scopeCtx, uniquePath,
} from './file-core.mjs';

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

function runTool(executable, args, timeoutMs = 600_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let errorOutput = '';
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error('解压超时'));
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

export async function extractArchive(root, rel) {
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
  const result = await extractArchive(ctx.cwd, String(body.path || ''));
  if (result.error) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: result.error }));
    return;
  }
  okJson(res, result);
}

const MD_EXT = new Set(['md', 'markdown', 'mdown', 'mkd']);
const mdBase = (name) => name.replace(/\.[^.]+$/, '');
const extOf = (name) => path.extname(name).slice(1).toLowerCase();

// —— 笔记树遍历（mdlinks 的反链/出链解析 与 mdnames 的 [[ 补全名单共用）——
// 从笔记所在目录往下有界递归：深度 ≤4、访问 ≤2500 项（跳过的重目录也计数），超出即 truncated。
// 两个接口看到的必须是同一棵树——补全里列出来的名字，mdlinks 一定解析得到，反之亦然。
// 可见性跟文件列表同一套 hiddenInList：公开分享身份不给点开头的项（.env 之类），沙箱根下的
// .bridge 系统目录不进（那是会话/配置，不是用户的笔记，也白吃访问预算）。
const NOTE_WALK_DEPTH = 4;
const NOTE_WALK_VISITS = 2500;
export async function walkNoteTree(ctx, startDir) {
  const root = path.resolve(ctx.cwd);
  const toRel = (absolute) => path.relative(root, absolute).split(path.sep).join('/');
  const files = [];   // { abs, rel, name, md, depth }，DFS 顺序（nameIndex 的「同名取最浅」依赖它）
  let visited = 0;
  let truncated = false;
  const walk = async (currentDir, depth) => {
    if (truncated || depth > NOTE_WALK_DEPTH) return;
    let entries;
    try { entries = await readdirAsync(currentDir, { withFileTypes: true }); } catch { return; }
    const here = toRel(currentDir);
    for (const entry of entries) {
      visited += 1;
      if (visited > NOTE_WALK_VISITS) { truncated = true; return; }
      if (SEARCH_SKIP.has(entry.name)) continue;   // 只跳重目录，点开头的照常收（见 file-core 的隐藏项策略）
      if (hiddenInList(ctx, entry.name, here)) continue;   // 例外同文件列表：分享身份的点开头项、沙箱根的 .bridge
      const absolute = path.join(currentDir, entry.name);
      let isDir = false;
      try { isDir = entry.isDirectory(); } catch { continue; }
      if (isDir) {
        await walk(absolute, depth + 1);
        continue;
      }
      files.push({ abs: absolute, rel: toRel(absolute), name: entry.name, md: MD_EXT.has(extOf(entry.name)), depth });
    }
  };
  await walk(startDir, 0);
  return { files, truncated };
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
  const { files, truncated } = await walkNoteTree(ctx, dir);
  const names = [];
  for (const file of files) {
    if (file.md) names.push({ name: mdBase(file.name), path: file.rel, md: true, depth: file.depth });
    else if (ATTACH_EXT.has(extOf(file.name))) names.push({ name: file.name, path: file.rel, md: false, depth: file.depth });
  }
  names.sort((a, b) => a.depth - b.depth);   // Array#sort 稳定：同深度保持遍历顺序
  okJson(res, { ok: true, names: names.map(({ depth, ...rest }) => rest), truncated });
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

  for (const outgoingItem of outgoing) {
    if (outgoingItem.path) continue;
    const key = outgoingItem.name.toLowerCase();
    const indexed = nameIndex.get(key) || (key.includes('/') && byPathSuffix(key)) || nameIndex.get(key.split('/').pop());
    if (indexed) {
      outgoingItem.path = indexed.rel;
      continue;
    }
    outer: for (const base of [root, dir]) {
      for (const candidate of outgoingItem.embed
        ? [outgoingItem.name]
        : [outgoingItem.name + '.md', outgoingItem.name]) {
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
  }

  const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wikilinkPattern = new RegExp(
    '\\[\\[\\s*(?:[^\\[\\]\\n]*/)?' + escapeRegExp(currentBase)
    + '\\s*(?:#[^\\[\\]\\n]*)?(?:\\|[^\\[\\]\\n]*)?\\]\\]',
    'gi',
  );
  const filename = path.basename(file);
  const markdownPatterns = [
    new RegExp('\\]\\((?:[^()\\s]*/)?' + escapeRegExp(filename) + '\\)', 'gi'),
  ];
  const encoded = encodeURIComponent(filename);
  if (encoded !== filename) {
    markdownPatterns.push(new RegExp(
      '\\]\\((?:[^()\\s]*/)?' + escapeRegExp(encoded) + '\\)',
      'gi',
    ));
  }
  const backlinks = [];
  for (const markdownFile of markdownFiles) {
    if (backlinks.length >= 100) break;
    let text;
    try {
      if ((await statAsync(markdownFile)).size > 600_000) continue;
      text = await readFileAsync(markdownFile, 'utf8');
    } catch {
      continue;
    }
    let count = 0;
    const excerpts = [];
    for (const line of text.split('\n')) {
      let hits = (line.match(wikilinkPattern) || []).length;
      for (const pattern of markdownPatterns) hits += (line.match(pattern) || []).length;
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
  okJson(res, { ok: true, outgoing, backlinks, truncated });
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
