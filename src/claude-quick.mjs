// 「快照对话」——不进任何目录时的默认工作空间：一次性的空桶 + 一条对话。
//
// 为什么另起一个模块而不是复用 claude-projects 的普通项目：普通项目 = 用户自己选的
// 本地目录（有 CLAUDE.md、有历史、有自动记忆），快照要的正好相反——
//   1. 不属于任何已有工作空间：桶是现铸的空目录，与 vault / 用户目录无关；
//   2. 不共用任何记忆：见下面「桶必须落在 git 仓库之外」与 autoMemoryEnabled:false；
//   3. 只同时存在一个对话记录：store 只记当前这只桶，/api/sessions 对该桶只列最新一条；
//   4. 服务端状态：桶与 transcript 都在盘上，前端清缓存 / 杀后台 / 换设备都不会让它消失。
//
// 换新快照 = 换一只桶（新 id），旧桶先留在盘上、只是不再被列出——万一上一单快照真产出了
// 东西（比如一份研报），不至于一键蒸发。但快照是一次性的，不能无限攒：pruneQuick 只保留
// 最近 QUICK_KEEP 条快照对话记录（跨所有桶按 transcript 修改时间排），更老的连同它的桶
//（桶里 Claude 写的产物）一起删掉。
//
// ⚠ 桶必须落在【任何 git 仓库之外】（实测踩过）：Claude Code 的自动记忆按【git 根】
// 推导目录，不是按 cwd。桶原先放在 <dataDir>/quickchat/ 下，而 admin 的 dataDir 就是
// claude-bridge 仓库本身 → 桶的 git 根 = 该仓库 → 快照对话开局就吃到了 bridge 项目的
// MEMORY.md（问它"上下文里有哪些记忆文件"当场自陈）。所以 admin 的桶改落用户主目录
// 下的 .bridge-quickchat/（非仓库），沙箱用户仍落自己空间内（那两层也都不是仓库，且
// authorizeProjectPath 要求项目路径必须在其 cwd 内）。另在桶里写一份
// .claude/settings.local.json { autoMemoryEnabled: false } 作第二道闸——万一将来数据根
// 又落进某个仓库里，自动记忆也读不进来、写不出去。
//
// 命名注意：本项目里 `snap` 已经是【公开聊天快照链接】（chat-snapshot.mjs 的 /c/<token>
// 桶身份），与本模块无关。这里内部一律叫 quick / quickchat，别混。

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readdir, stat, rm } from 'node:fs/promises';
import { readJson, writeJson } from './jsonfile.mjs';
import { sessionsDir } from './runtime/paths.mjs';

export const QUICK_NAME = '快照对话';

// 公开只读分享桶 / 公开聊天快照桶本身就是一次性隔离桶，不给它们再套一层快照。
const quickAllowed = (ctx) => !!ctx && (ctx.kind === 'admin' || ctx.kind === 'user');

// admin = 主机本人，桶放主目录（不在任何仓库里）；沙箱用户必须留在自己的空间内
//（authorizeProjectPath 对非 admin 强制 cwd 围栏），其根目录同样不是仓库。
const bucketRoot = (ctx) => ctx.kind === 'admin'
  ? path.join(os.homedir(), '.bridge-quickchat')
  : path.join(ctx.dataDir, 'quickchat');

const storeFile = (ctx) => path.join(ctx.dataDir, 'claude-quick.json');

const fold = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
const inRoot = (ctx, p) => {
  const rel = path.relative(fold(bucketRoot(ctx)), fold(path.resolve(p)));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};

function mint(ctx) {
  const id = crypto.randomUUID();
  const dir = path.join(bucketRoot(ctx), id);
  mkdirSync(path.join(dir, '.claude'), { recursive: true });
  // 第二道闸：这只桶不读也不写自动记忆（键见 SDK settings schema）。写失败不致命——
  // 桶已在仓库外，第一道闸就够；这里只是纵深防御，所以吞掉异常。
  try { writeFileSync(path.join(dir, '.claude', 'settings.local.json'), JSON.stringify({ autoMemoryEnabled: false }, null, 2)); } catch {}
  const rec = { id, path: dir, created: Date.now() };
  writeJson(storeFile(ctx), rec, 2);
  return rec;
}

// 当前快照桶（幂等）：有就返回，没有/记录坏了/桶落在旧位置就现铸一只。
function currentBucket(ctx) {
  const rec = readJson(storeFile(ctx), null);
  if (!rec || typeof rec.id !== 'string' || typeof rec.path !== 'string' || !inRoot(ctx, rec.path)) return mint(ctx);
  try { mkdirSync(rec.path, { recursive: true }); } catch { return mint(ctx); }
  return rec;
}

// 快照桶伪装成一枚项目（project.quick = true）——这样 cwd 解析、会话归属推导、
// /api/sessions 目录聚合、右侧工作台作用域全部沿用项目那套管线，一处不用改。
// 前端据 quick 标记把它从「项目」区摘出去，单独置顶成一行。
const asProject = (rec) => ({ id: rec.id, name: QUICK_NAME, path: rec.path, created: rec.created, updated: rec.created, quick: true });

export function quickProject(ctx) {
  if (!quickAllowed(ctx)) return null;
  try { return asProject(currentBucket(ctx)); } catch { return null; }
}

// 换一只新桶 = 开一条全新快照对话（旧桶留盘、不再列出）。
export function newQuickProject(ctx) {
  if (!quickAllowed(ctx)) throw Object.assign(new Error('该身份不支持快照对话'), { status: 403 });
  return asProject(mint(ctx));
}

export const isQuickProject = (p) => !!p && p.quick === true;

// ---- 旧快照回收：只留最近 QUICK_KEEP 条 ----
//
// 一条「快照对话记录」= 快照桶 transcript 目录里的一个 .jsonl（换新快照＝新桶；快照里点
// 「新对话」＝同桶再多一条）。全部桶的记录按修改时间排，最新 QUICK_KEEP 条留下，其余删掉
// transcript（连子 agent 子目录）；删完不剩记录的旧桶整只删（含 Claude 在里面写的产物）。
// 永不删的：当前桶本身与它最新那条（侧栏常驻置顶的就是它）、正在跑的会话、GRACE 窗口内
// 刚动过的记录或桶（刚铸还没落 transcript 的桶、别的设备上正开着的旧快照都靠它兜住）。
// Windows 文件锁删不动就吞掉，下轮再试。
export const QUICK_KEEP = 10;
const QUICK_GRACE_MS = 10 * 60 * 1000;
const BUCKET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function pruneQuick(ctx, { keep = QUICK_KEEP, busy = new Set(), onDrop, now = Date.now() } = {}) {
  const out = { records: 0, buckets: 0 };
  if (!quickAllowed(ctx)) return out;
  const root = bucketRoot(ctx);
  const rec = readJson(storeFile(ctx), null);
  const curDir = rec && typeof rec.path === 'string' ? fold(path.resolve(rec.path)) : null;
  let names = [];
  try { names = await readdir(root, { withFileTypes: true }); } catch { return out; }
  const buckets = [];
  const records = [];
  for (const d of names) {
    if (!d.isDirectory() || !BUCKET_ID.test(d.name)) continue;
    const dir = path.join(root, d.name);
    const b = { dir, tdir: sessionsDir(dir, ctx.configDir), current: fold(dir) === curDir, mtime: 0, left: 0 };
    try { b.mtime = (await stat(dir)).mtimeMs; } catch { continue; }
    buckets.push(b);
    let ents = [];
    try { ents = await readdir(b.tdir, { withFileTypes: true }); } catch {}
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const file = path.join(b.tdir, e.name);
      let mtime = 0;
      try { mtime = (await stat(file)).mtimeMs; } catch { continue; }
      records.push({ b, id: e.name.slice(0, -6), file, mtime });
      b.mtime = Math.max(b.mtime, mtime);
    }
  }
  records.sort((x, y) => y.mtime - x.mtime);
  let curNewest = true;
  records.forEach((r, i) => {
    const pinned = r.b.current && curNewest;
    if (r.b.current) curNewest = false;
    r.keep = i < keep || pinned || busy.has(r.id) || now - r.mtime < QUICK_GRACE_MS;
    if (r.keep) r.b.left++;
  });
  for (const r of records) {
    if (r.keep) continue;
    try {
      await rm(r.file, { force: true });
      await rm(path.join(r.b.tdir, r.id), { recursive: true, force: true });
      out.records++;
      try { onDrop?.(r.id); } catch {}
    } catch { r.b.left++; }
  }
  for (const b of buckets) {
    if (b.current || b.left > 0 || now - b.mtime < QUICK_GRACE_MS) continue;
    try {
      await rm(b.dir, { recursive: true, force: true });
      await rm(b.tdir, { recursive: true, force: true });
      out.buckets++;
    } catch {}
  }
  return out;
}

// 节流版：/api/sessions 每次列表都会叫，按身份 5 分钟最多扫一遍；换新快照时 force。
// 不 await——回收在后台跑，不拖慢列表。
const pruneState = new Map();   // ctx.key -> { at, running }
export function schedulePruneQuick(ctx, opts = {}, { force = false } = {}) {
  if (!quickAllowed(ctx)) return;
  const key = ctx.key || ctx.kind;
  const st = pruneState.get(key) || { at: 0, running: false };
  if (st.running || (!force && Date.now() - st.at < 5 * 60 * 1000)) return;
  st.running = true; st.at = Date.now(); pruneState.set(key, st);
  pruneQuick(ctx, opts)
    .then((r) => { if (r.records || r.buckets) console.log(`[quick] 回收旧快照：${r.records} 条记录、${r.buckets} 只桶`); })
    .catch((e) => console.warn('[quick] prune failed:', e?.message || e))
    .finally(() => { st.running = false; });
}
