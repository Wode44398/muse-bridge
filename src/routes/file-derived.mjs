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
  SEARCH_SKIP, bad, okJson, protectedTarget, scopeCtx, uniquePath,
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
  let visited = 0;
  let truncated = false;
  const walk = async (currentDir, depth) => {
    if (truncated || depth > 4) return;
    let entries;
    try { entries = await readdirAsync(currentDir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      visited += 1;
      if (visited > 2500) { truncated = true; return; }
      if (SEARCH_SKIP.has(entry.name)) continue;   // 只跳重目录，点开头的照常收（见 file-core 的隐藏项策略）
      const absolute = path.join(currentDir, entry.name);
      let isDir = false;
      try { isDir = entry.isDirectory(); } catch { continue; }
      if (isDir) {
        await walk(absolute, depth + 1);
        continue;
      }
      const isMarkdown = MD_EXT.has(path.extname(entry.name).slice(1).toLowerCase());
      const key = (isMarkdown ? mdBase(entry.name) : entry.name).toLowerCase();
      const previous = nameIndex.get(key);
      if (!previous || depth < previous.depth) nameIndex.set(key, { rel: toRel(absolute), depth });
      if (isMarkdown && absolute !== file) markdownFiles.push(absolute);
    }
  };
  await walk(dir, 0);

  for (const outgoingItem of outgoing) {
    if (outgoingItem.path) continue;
    const key = outgoingItem.name.toLowerCase();
    const indexed = nameIndex.get(key) || nameIndex.get(key.split('/').pop());
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
