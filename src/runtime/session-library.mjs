// Claude 分页会话「收藏 + 自定义标题」（sidecar，2026-10-11 维护者要求跨设备同步）。
//
// 以前两样都只存在前端 localStorage（bridge-stars / bridge-titles）——换台设备收藏夹就空了。
// 现在按身份数据目录（ctx.dataDir）落 claude-session-library.json，多用户互不可见：
//   /api/sessions 与总线 hello 顺带下发整份 → 任何设备打开即同步；
//   POST /api/claude/library 写入后 busPublish {type:'library'} → 已在线的设备即刻跟上。
// rev 单调递增：前端据此丢弃「乐观更新之后才到的旧快照」，避免收藏闪回。
import path from 'node:path';
import { readJson, writeJson, ID_RE } from '../jsonfile.mjs';

const MAX_STARS = 500;
const MAX_TITLES = 2000;
const MAX_TITLE_LEN = 200;

const cache = new Map();   // file -> data（单进程，内存为准，磁盘只是持久化）
const fileFor = (ctx) => path.join(ctx.dataDir, 'claude-session-library.json');

function load(file) {
  if (cache.has(file)) return cache.get(file);
  const raw = readJson(file, {});
  const data = {
    rev: Number.isFinite(raw.rev) ? raw.rev : 0,
    stars: Array.isArray(raw.stars) ? raw.stars.filter((x) => typeof x === 'string' && ID_RE.test(x)) : [],
    titles: raw.titles && typeof raw.titles === 'object' ? raw.titles : {},
  };
  cache.set(file, data);
  return data;
}

const snapshot = (d) => ({ rev: d.rev, stars: [...d.stars], titles: { ...d.titles } });

export function getLibrary(ctx) {
  if (!ctx?.dataDir) return { rev: 0, stars: [], titles: {} };
  return snapshot(load(fileFor(ctx)));
}

function cleanTitle(t) {
  return String(t ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_TITLE_LEN);
}

function setStar(d, id, on) {
  const has = d.stars.includes(id);
  if (on && !has) { d.stars.unshift(id); if (d.stars.length > MAX_STARS) d.stars.length = MAX_STARS; return true; }
  if (!on && has) { d.stars = d.stars.filter((x) => x !== id); return true; }
  return false;
}

function setTitle(d, id, title) {
  const t = cleanTitle(title);
  if (!t) { if (!(id in d.titles)) return false; delete d.titles[id]; return true; }
  if (d.titles[id] === t) return false;
  if (!(id in d.titles) && Object.keys(d.titles).length >= MAX_TITLES) return false;
  d.titles[id] = t;
  return true;
}

// op:
//   { op:'star',  id, on:boolean }
//   { op:'title', id, title }            ← 空标题 = 恢复成自动标题
//   { op:'merge', stars:[], titles:{} }  ← 旧 localStorage 一次性上云：并集，服务端已有的标题优先
// 返回 { library, changed }。非法 op / id 抛 status=400。
export function applyLibraryOp(ctx, body) {
  if (!ctx?.dataDir) throw Object.assign(new Error('no data dir'), { status: 400 });
  const file = fileFor(ctx);
  const d = load(file);
  const op = body && body.op;
  let changed = false;
  const badId = () => Object.assign(new Error('bad id'), { status: 400 });
  if (op === 'star') {
    const id = String(body.id || '');
    if (!ID_RE.test(id)) throw badId();
    changed = setStar(d, id, !!body.on);
  } else if (op === 'title') {
    const id = String(body.id || '');
    if (!ID_RE.test(id)) throw badId();
    changed = setTitle(d, id, body.title);
  } else if (op === 'merge') {
    const stars = Array.isArray(body.stars) ? body.stars.filter((x) => typeof x === 'string' && ID_RE.test(x)) : [];
    // 追加在服务端已有收藏之后，保持本地原有的相对顺序
    const add = stars.filter((x) => !d.stars.includes(x));
    if (add.length) { d.stars = [...d.stars, ...add].slice(0, MAX_STARS); changed = true; }
    const titles = body.titles && typeof body.titles === 'object' ? body.titles : {};
    for (const [id, t] of Object.entries(titles)) {
      if (!ID_RE.test(id) || id in d.titles) continue;
      if (setTitle(d, id, t)) changed = true;
    }
  } else {
    throw Object.assign(new Error('bad op'), { status: 400 });
  }
  if (changed) { d.rev += 1; writeJson(file, d); }
  return { library: snapshot(d), changed };
}

// 会话被删：收藏与自定义标题一并清掉（不留指向不存在会话的条目）。
export function dropFromLibrary(ctx, id) {
  if (!ctx?.dataDir || !id) return null;
  const file = fileFor(ctx);
  const d = load(file);
  const had = d.stars.includes(id) || id in d.titles;
  if (!had) return null;
  d.stars = d.stars.filter((x) => x !== id);
  delete d.titles[id];
  d.rev += 1;
  writeJson(file, d);
  return snapshot(d);
}

export function _resetLibraryCache() { cache.clear(); }
