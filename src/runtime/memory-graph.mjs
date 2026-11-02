// Claude 记忆查看器（工作台「记忆」卡）的服务端核心：找记忆目录 + 把一个目录的 md 记忆读成一张图。
//
// 不认任何一种固定格式——导图按【链接】自己长出来：
//   · 根 = 目录里的 MEMORY.md（没有就是一个虚根，全部文件平铺其下）；
//   · 树边 = 从根出发沿 markdown 链接 [标题](x.md) 广度优先走，每个文件挂在【最先】链到它的那一篇下。
//     Claude Code 默认格式（MEMORY.md 一行一条指针）长成两层；bridge 的三层索引（MEMORY.md → 分区索引
//     MEMORY-<区>.md → 单篇）长成三层；以后谁再改结构也不用动这里。
//   · 一篇索引里的链接分落在 ≥2 个标题（## 小节）下时，小节本身成一层分组节点（分区索引的「框架 / 视觉 …」）。
//   · 链接所在行、链接之后的文字（「— 钩子」）当作这条的副标题。
//   · [[双链]]（按 frontmatter name、文件名解析）与没成为树边的 md 链接 = 跨枝连线；解析不到的 = 死链。
//   · 没被任何链接走到的文件挂在「未索引」节点下。
//
// 记忆目录的找法与 Claude Code 2.1.x 一致（见官方 resolveEntry）：settings 里的 autoMemoryDirectory
// 依次看 本地(.claude/settings.local.json) → 项目(.claude/settings.json) → 用户(<配置目录>/settings.json)；
// 都没有就是 <配置目录>/projects/<规范化后的 git 主仓库根（不是 git 仓库则用工作目录）>/memory。

import path from 'node:path';
import os from 'node:os';
import { promises as fsp, readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { gitInvocation } from './member-boundary.mjs';
import { projectsBase } from './paths.mjs';

const fold = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));
const toPosix = (p) => String(p).split(path.sep).join('/');
// Claude Code 的目录键：非字母数字一律换 '-'（与会话转录目录同一套，见 paths.mjs sessionsDir）
export const projectKey = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-');

const WALK_DEPTH = 3;          // 记忆目录本该是平的；留几层给自己分了子目录的人
const WALK_FILES = 2000;
const READ_CAP = 256 * 1024;   // 单篇只读前 256KB 抽链接（记忆不该这么长，防误指到大目录）

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function expandDir(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  if (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2));
  return path.isAbsolute(s) ? path.resolve(s) : null;   // 相对路径官方也不认
}

function gitOut(cwd, args) {
  const inv = gitInvocation(cwd, args, { ...process.env, GIT_OPTIONAL_LOCKS: '0' });
  return new Promise((resolve) => {
    execFile('git', inv.args, { cwd, env: inv.env, timeout: 8000, windowsHide: true }, (err, out) => resolve(err ? null : String(out || '').trim()));
  });
}

// 官方 findCanonicalGitRoot：worktree 也归到主仓库根（记忆是整个仓库共用的）
export async function canonicalGitRoot(ws) {
  const common = await gitOut(ws, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common) return null;
  const c = path.resolve(common);
  if (path.basename(c).toLowerCase() === '.git') return path.dirname(c);
  const top = await gitOut(ws, ['rev-parse', '--show-toplevel']);
  return top ? path.resolve(top) : null;
}

export function claudeConfigDir(ctx) {
  return ctx?.configDir || String(process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude');
}

// settings 里显式改道的记忆目录 → { dir, source } | null
function settingsOverride(ctx, roots) {
  for (const [file, source] of [
    ...roots.map((r) => [path.join(r, '.claude', 'settings.local.json'), 'local']),
    ...roots.map((r) => [path.join(r, '.claude', 'settings.json'), 'project']),
    [path.join(claudeConfigDir(ctx), 'settings.json'), 'user'],
  ]) {
    const dir = expandDir(readJson(file)?.autoMemoryDirectory);
    if (dir) return { dir, source };
  }
  return null;
}

// 默认目录：<配置目录>/projects/<键>/memory。键超长时官方会截断加哈希——认不出就按前缀在盘上找一个。
async function defaultDir(ctx, base) {
  const projects = projectsBase(ctx?.configDir || null);
  const key = projectKey(base.normalize('NFC'));
  const exact = path.join(projects, key, 'memory');
  if (key.length <= 200) return exact;
  try {
    const hit = (await fsp.readdir(projects)).find((n) => n.startsWith(key.slice(0, 200)));
    if (hit) return path.join(projects, hit, 'memory');
  } catch {}
  return exact;
}

// 某个工作目录的 Claude 记忆目录 → { dir, source:'local'|'project'|'user'|'default', base }
export async function resolveMemoryDir(ctx, ws) {
  const root = await canonicalGitRoot(ws);
  const roots = root && fold(root) !== fold(ws) ? [ws, root] : [ws];
  const o = settingsOverride(ctx, roots);
  if (o) return { ...o, base: root || ws };
  const base = root || ws;
  return { dir: await defaultDir(ctx, base), source: 'default', base };
}

async function walkMd(dir) {
  const out = [];
  let queue = [{ abs: dir, depth: 0 }];
  while (queue.length && out.length < WALK_FILES) {
    const next = [];
    for (const { abs, depth } of queue) {
      let ents;
      try { ents = await fsp.readdir(abs, { withFileTypes: true }); } catch { continue; }
      ents.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of ents) {
        if (e.name.startsWith('.') || e.name === 'node_modules') continue;
        const child = path.join(abs, e.name);
        if (e.isDirectory()) { if (depth + 1 < WALK_DEPTH) next.push({ abs: child, depth: depth + 1 }); }
        else if (e.isFile() && /\.md$/i.test(e.name)) { out.push(child); if (out.length >= WALK_FILES) break; }
      }
    }
    queue = next;
  }
  return out;
}

async function countMd(dir) {
  try {
    const ents = await fsp.readdir(dir, { withFileTypes: true });
    return ents.filter((e) => e.isFile() && /\.md$/i.test(e.name)).length;
  } catch { return -1; }
}

// —— 单篇解析 ——

// 只认最常见的几样：顶层 key: value 与 metadata 下一层缩进的 key: value（type 两处都可能在）
function parseFrontmatter(text) {
  const m = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { fm: {}, body: text };
  const fm = {};
  let block = '';
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\s*)([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const [, ind, k, v0] = kv;
    const v = v0.trim().replace(/^(["'])(.*)\1$/, '$2');
    if (!ind) { block = v ? '' : k; if (v) fm[k] = v; }
    else if (block === 'metadata' && !(k in fm)) fm[k] = v;
  }
  return { fm, body: text.slice(m[0].length) };
}

const MD_LINK = /\[((?:[^\[\]]|\[[^\]]*\])*)\]\(\s*(<[^>]+>|[^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
const WIKI = /(!?)\[\[([^\]|#\n]+)(?:#[^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g;

const plain = (s) => String(s || '')
  .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a, b) => b || a)
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  .replace(/[*_`]+/g, '').replace(/\s+/g, ' ').trim();

function hookAfter(line, end) {
  const s = plain(line.slice(end).replace(/^\s*(?:[—–:：-]+|\|)\s*/, ''));
  if (!/[\p{L}\p{N}]/u.test(s)) return '';   // 只剩标点（「…](x.md)。」）不算钩子
  return s.length > 160 ? s.slice(0, 159) + '…' : s;
}

function parseNote(text) {
  const { fm, body } = parseFrontmatter(text);
  const links = [];    // { target, text, hook, heading, line }
  const wikis = [];    // { target, line }
  let heading = '', h1 = '', fence = false;
  body.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*(```|~~~)/.test(raw)) { fence = !fence; return; }
    if (fence) return;
    const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (h) {
      const t = plain(h[2]);
      if (h[1].length === 1 && !h1) h1 = t;
      else if (h[1].length >= 2) heading = t;
      return;
    }
    const line = raw.replace(/`[^`\n]*`/g, (s) => ' '.repeat(s.length));   // 行内代码里的示例不算链接
    for (const m of line.matchAll(MD_LINK)) {
      let href = m[2].replace(/^<|>$/g, '');
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#')) continue;
      href = href.split('#')[0].split('?')[0];
      try { href = decodeURIComponent(href); } catch {}
      if (!/\.md$/i.test(href)) continue;
      links.push({ target: href, text: plain(m[1]), hook: hookAfter(line, m.index + m[0].length), heading, line: i });
    }
    for (const m of line.matchAll(WIKI)) { const tg = m[2].trim(); if (tg) wikis.push({ target: tg, line: i }); }
  });
  return { fm, h1, links, wikis };
}

// —— 整个目录 → 图 ——
export async function buildMemoryGraph(dir) {
  const root = path.resolve(dir);
  const files = await walkMd(root);
  const notes = new Map();   // rel → note
  await Promise.all(files.map(async (abs) => {
    const rel = toPosix(path.relative(root, abs));
    let st, text = '';
    try { st = await fsp.stat(abs); } catch { return; }
    try {
      const fh = await fsp.open(abs, 'r');
      try {
        const buf = Buffer.alloc(Math.min(st.size, READ_CAP));
        await fh.read(buf, 0, buf.length, 0);
        text = buf.toString('utf8');
      } finally { await fh.close(); }
    } catch {}
    notes.set(rel, { rel, mtime: st.mtimeMs, size: st.size, ...parseNote(text) });
  }));

  // 解析表：rel（小写）/ 去扩展名的 rel / 文件名 / frontmatter name → rel
  const byKey = new Map();
  const put = (k, rel) => { const f = fold(k); if (f && !byKey.has(f)) byKey.set(f, rel); };
  const rels = [...notes.keys()].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  for (const rel of rels) put(rel, rel);
  for (const rel of rels) put(rel.replace(/\.md$/i, ''), rel);
  for (const rel of rels) put(path.posix.basename(rel).replace(/\.md$/i, ''), rel);
  for (const rel of rels) { const n = notes.get(rel).fm.name; if (n) put(n, rel); }

  const resolveMd = (from, href) => {
    const joined = path.posix.normalize(path.posix.join(path.posix.dirname(from), href.replace(/\\/g, '/')));
    if (joined.startsWith('../') || joined === '..') return null;
    return byKey.get(fold(joined)) || null;
  };
  const resolveWiki = (target) => byKey.get(fold(target.replace(/\\/g, '/').replace(/\.md$/i, ''))) || byKey.get(fold(target)) || null;

  // 出链（解析后）与死链
  for (const n of notes.values()) {
    n.out = n.links.map((l) => ({ ...l, to: resolveMd(n.rel, l.target) }));
    n.wout = n.wikis.map((w) => ({ ...w, to: resolveWiki(w.target) }));
    n.dead = [...new Set([...n.out.filter((l) => !l.to).map((l) => l.target), ...n.wout.filter((w) => !w.to).map((w) => `[[${w.target}]]`)])];
  }

  const rootRel = byKey.get('memory.md') && !byKey.get('memory.md').includes('/') ? byKey.get('memory.md') : null;
  const placed = new Set();
  const label = new Map();   // rel → 最先链到它的那条链接文字（索引里的标题最像人话）
  const hook = new Map();

  const fileNode = (rel) => ({ id: 'f:' + rel, kind: 'file', ref: rel, children: [] });
  const tree = rootRel ? fileNode(rootRel) : { id: 'root', kind: 'root', label: path.basename(root), children: [] };
  if (rootRel) placed.add(rootRel);

  // 广度优先：浅的先占位，同一篇被多处链到时挂在离根最近的那一处
  let frontier = rootRel ? [tree] : [];
  while (frontier.length) {
    const next = [];
    for (const node of frontier) {
      const n = notes.get(node.ref);
      const kids = [];
      for (const l of n.out) {
        if (!l.to || placed.has(l.to)) continue;
        placed.add(l.to);
        if (!label.has(l.to) && l.text && fold(l.text) !== fold(l.to)) label.set(l.to, l.text);
        if (l.hook) hook.set(l.to, l.hook);
        kids.push({ heading: l.heading, node: fileNode(l.to) });
      }
      const heads = [...new Set(kids.map((k) => k.heading))];
      if (heads.filter(Boolean).length >= 2) {
        const groups = new Map();
        for (const k of kids) {
          if (!k.heading) { node.children.push(k.node); continue; }
          let g = groups.get(k.heading);
          if (!g) { g = { id: 'g:' + node.ref + '#' + k.heading, kind: 'group', label: k.heading, children: [] }; groups.set(k.heading, g); node.children.push(g); }
          g.children.push(k.node);
        }
      } else node.children.push(...kids.map((k) => k.node));
      next.push(...kids.map((k) => k.node));
    }
    frontier = next;
  }

  const loose = rels.filter((r) => !placed.has(r)).sort((a, b) => notes.get(b).mtime - notes.get(a).mtime);
  if (loose.length) {
    if (rootRel) tree.children.push({ id: 'unindexed', kind: 'unindexed', children: loose.map(fileNode) });
    else tree.children.push(...loose.map(fileNode));
  }

  // 跨枝连线：全部双链 + 没成为树边的 md 链接（指回根的「返回总索引」不算）
  const treeEdge = new Set();
  const walk = (node, parentFile) => {
    if (node.kind === 'file' && parentFile) treeEdge.add(parentFile + '\n' + node.ref);
    const pf = node.kind === 'file' ? node.ref : parentFile;
    for (const c of node.children) walk(c, pf);
  };
  walk(tree, null);
  const links = [];
  const seen = new Set();
  const backs = new Map();
  for (const n of notes.values()) {
    for (const l of [...n.out.map((x) => ({ to: x.to, kind: 'md' })), ...n.wout.map((x) => ({ to: x.to, kind: 'wiki' }))]) {
      if (!l.to || l.to === n.rel) continue;
      backs.set(l.to, (backs.get(l.to) || 0) + 1);
      if (l.to === rootRel || treeEdge.has(n.rel + '\n' + l.to)) continue;
      const k = n.rel + '\n' + l.to;
      if (seen.has(k)) continue;
      seen.add(k);
      links.push({ from: n.rel, to: l.to, kind: l.kind });
    }
  }

  const meta = {};
  let dead = 0;
  for (const n of notes.values()) {
    dead += n.dead.length;
    meta[n.rel] = {
      label: label.get(n.rel) || n.h1 || n.fm.name || path.posix.basename(n.rel).replace(/\.md$/i, ''),
      title: n.h1 || '', name: n.fm.name || '', description: plain(n.fm.description || ''), type: n.fm.type || '',
      hook: hook.get(n.rel) || '', mtime: n.mtime, size: n.size,
      out: n.out.filter((l) => l.to).length + n.wout.filter((w) => w.to).length, in: backs.get(n.rel) || 0,
      dead: n.dead,
    };
  }
  return {
    tree, files: meta, links, rootRel,
    stats: { files: notes.size, indexed: placed.size, unindexed: loose.length, dead, links: links.length },
  };
}

// 目录键 → 真实路径（键是有损的：分隔符、空格、点都成了 '-'）。从盘符起逐层在盘上找：这一层里哪个子目录名
// 编码后正好是剩余键的开头（后面紧跟 '-' 或到头），挑最长的那个往下走；走不通返回 ''。
// 只做 Windows 盘符形式（C--Users-…）与 POSIX 根（-home-…）；结果按键缓存。
const keyPathCache = new Map();
export async function resolveKeyPath(key) {
  if (keyPathCache.has(key)) return keyPathCache.get(key);
  let dir, rest;
  const m = /^([A-Za-z])--(.*)$/.exec(key);
  if (m && process.platform === 'win32') { dir = m[1].toUpperCase() + ':' + path.sep; rest = m[2]; }
  else if (key.startsWith('-') && process.platform !== 'win32') { dir = '/'; rest = key.slice(1); }
  else { keyPathCache.set(key, ''); return ''; }
  for (let guard = 0; rest && guard < 24; guard++) {
    let names;
    try { names = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name); } catch { names = []; }
    let best = '';
    for (const n of names) {
      const k = projectKey(n);
      if ((rest === k || rest.startsWith(k + '-')) && k.length > projectKey(best).length) best = n;
    }
    if (!best) { dir = ''; break; }
    dir = path.join(dir, best);
    rest = rest.slice(projectKey(best).length).replace(/^-/, '');
  }
  const out = dir && !rest ? dir : '';
  keyPathCache.set(key, out);
  return out;
}

// —— 这个身份能看到的全部记忆目录（切换列表）——
// 默认位置下每个有 memory/ 的项目 + 已知项目里 settings 显式改道的目录；label 尽量翻成项目名。
export async function listMemoryRoots(ctx, projects = []) {
  const base = projectsBase(ctx?.configDir || null);
  const known = new Map();   // projectKey → { name, path }
  for (const p of projects) if (p?.path) known.set(projectKey(p.path), { name: p.name || path.basename(p.path), path: p.path });
  const out = new Map();     // fold(dir) → entry
  const add = async (dir, extra) => {
    const k = fold(path.resolve(dir));
    if (out.has(k)) return;
    const count = await countMd(dir);
    if (count <= 0) return;
    let mtime = 0;
    try { mtime = (await fsp.stat(path.join(dir, 'MEMORY.md'))).mtimeMs; } catch { try { mtime = (await fsp.stat(dir)).mtimeMs; } catch {} }
    out.set(k, { dir: path.resolve(dir), count, mtime, ...extra });
  };
  let ents = [];
  try { ents = await fsp.readdir(base, { withFileTypes: true }); } catch {}
  await Promise.all(ents.filter((e) => e.isDirectory()).map(async (e) => {
    const k = known.get(e.name);
    const quick = /-bridge-quickchat-/.test(e.name);
    const dir = path.join(base, e.name, 'memory');
    if ((await countMd(dir)) <= 0) return;
    // 不是已知项目：把键反解回真实路径，名字取最后一段（反解不出就让前端按键猜）
    const real = k?.path || (quick ? '' : await resolveKeyPath(e.name));
    return add(dir, { key: e.name, name: k?.name || (real ? path.basename(real) : ''), project: real, quick });
  }));
  const user = expandDir(readJson(path.join(claudeConfigDir(ctx), 'settings.json'))?.autoMemoryDirectory);
  if (user) await add(user, { key: '', name: '', project: '', quick: false, source: 'user' });
  for (const p of projects) {
    if (!p?.path || p.quick) continue;
    const o = settingsOverride({ configDir: null, ...ctx }, [p.path]);
    if (o && o.source !== 'user') await add(o.dir, { key: '', name: p.name || path.basename(p.path), project: p.path, quick: false, source: o.source });
  }
  return [...out.values()].sort((a, b) => b.mtime - a.mtime);
}
