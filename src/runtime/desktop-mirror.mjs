// 把 bridge 发起的 Claude 会话登记进官方 Claude Desktop 的侧栏（2026-11-06，Desktop 4.x）。
//
// 为什么要做：Desktop 侧栏不扫 ~/.claude/projects，只列它自己的元数据
//   <Desktop 数据目录>/claude-code-sessions/<账号>/<org>/local_<uuid>.json
// 里登记过的会话（cliSessionId 指向 transcript 文件名）。它另有一路「发现 CLI 会话」，但按 transcript 的
// entrypoint 把 sdk-cli / sdk-ts / sdk-py 全滤了——bridge 走 SDK，transcript 恒是 sdk-ts，所以 Desktop 永远看不见。
// 这里替 bridge 会话补写一份最小元数据（字段取 Desktop 自己写出的全量记录里 100% 都有的那几样 + 标题），
// Desktop 下次启动（或切换账号）加载时就会出现在侧栏，点开按 cliSessionId 续聊同一份 transcript。
//
// 规矩：
//   · 只登记 bridge 自己开的会话：transcript 开头的 entrypoint 是 sdk-*。Desktop / 终端开的本来就在 Desktop 那边。
//   · 只写当前登录账号（config.json 的 lastKnownAccountUuid）的 org 目录；切号后新账号目录下次再补。
//   · 那个目录里已有记录认得这个 cli id（Desktop 自己的，含 priorCliSessionIds 等旧 id）→ 不写。
//   · 只改自己写的文件，且文件 mtime 还是自己写时那个值：Desktop 加载过、动过它（改名、续聊、归档）就归 Desktop，
//     bridge 不再碰。文件不见了（在 Desktop 里删了，留 deleted_<uuid> 墓碑）→ 记成 gone，永不重建。
//   · Desktop 只在启动时读这个目录，运行中写进去的要下次启动才显示；它不会删不认识的 local_ 文件。
//   · 归档态跟 bridge 的列表口径一致（archiveView）。
//   · 临时对话不登记（2026-11-10）：cwd 还在临时对话桶地盘里的（excludeCwd）一律不写、也不记 skip；以前单条登记
//     那一路写进去过的，只要还是自己写的那一版就撤回（删文件、清状态）。「存为工作空间」并挪出桶地盘之后，
//     它就是普通项目里的会话，全量那路照常登记（存的当下 force 跑一遍）。
//   · 关掉：环境变量 BRIDGE_DESKTOP_MIRROR=0。
//
// 状态落 <dataDir>/desktop-mirror.json：{ v, items: { "<orgDir>|<cli>": { local, fm, tm, ts, gone?, owned? } } }
//   fm = 写完后文件的 mtimeMs；tm / ts = 写的时候 transcript 的 mtime / size（没变就不重写）。

import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promises as fsp, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { desktopSessionsDirs, desktopLineageScanned, desktopCliIdsUnder } from './desktop-lineage.mjs';
import { inQuickRoots } from '../claude-quick.mjs';

const MIN_GAP_MS = 60_000;
const HEAD_BYTES = 96 * 1024;
const MTIME_SLACK = 2;
const STALE_MS = 14 * 86400_000;   // 补登记时这么久没动过的老会话直接进 Desktop 的「已归档」，别把侧栏淹了   // utimes / 文件系统精度，比 mtime 留 2ms
const PERMISSION_MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions', 'auto', 'dontAsk']);

// —— 找当前账号的 org 目录 ——

// sessionsRoot：…/claude-code-sessions；config.json 在它的上一级
export function currentAccountUuid(sessionsRoot, { read = (p) => readFileSync(p, 'utf8') } = {}) {
  try {
    const j = JSON.parse(read(path.join(path.dirname(sessionsRoot), 'config.json')));
    const id = j && j.lastKnownAccountUuid;
    return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id : null;
  } catch { return null; }
}

// 账号目录下可能有多个 org：取最近有 Desktop 写过 local_ 文件的那个
async function pickOrgDir(accountDir) {
  let best = null, bestAt = -1;
  let orgs = [];
  try { orgs = await fsp.readdir(accountDir, { withFileTypes: true }); } catch { return null; }
  for (const o of orgs) {
    if (!o.isDirectory() || !/^[0-9a-f-]{36}$/i.test(o.name)) continue;
    const od = path.join(accountDir, o.name);
    let at = 0;
    try {
      for (const f of await fsp.readdir(od)) {
        if (!/^local_.*\.json$/.test(f)) continue;
        try { const st = await fsp.stat(path.join(od, f)); if (st.mtimeMs > at) at = st.mtimeMs; } catch {}
      }
    } catch {}
    if (at > bestAt) { best = od; bestAt = at; }
  }
  return best;
}

export async function targetOrgDir(env = process.env) {
  for (const root of desktopSessionsDirs(env)) {
    const acct = currentAccountUuid(root);
    if (!acct) continue;
    const od = await pickOrgDir(path.join(root, acct));
    if (od) return od;
  }
  return null;
}

// —— transcript 开头 ——

// → { entrypoint, cwd, permissionMode, model, createdAt }（读不到的字段 undefined）
export function parseHead(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (!out.createdAt && o.timestamp) { const t = Date.parse(o.timestamp); if (t) out.createdAt = t; }
    if (!out.entrypoint && typeof o.entrypoint === 'string') out.entrypoint = o.entrypoint;
    if (!out.cwd && typeof o.cwd === 'string' && o.cwd) out.cwd = o.cwd;
    if (!out.permissionMode && o.type === 'user' && PERMISSION_MODES.has(o.permissionMode)) out.permissionMode = o.permissionMode;
    if (!out.model && o.type === 'assistant' && o.message && typeof o.message.model === 'string' && /^claude-/.test(o.message.model)) out.model = o.message.model;
    if (out.entrypoint && out.cwd && out.permissionMode && out.model) break;
  }
  return out;
}

async function readHead(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await fh.read(buf, 0, HEAD_BYTES, 0);
    let s = buf.subarray(0, bytesRead).toString('utf8');
    if (bytesRead === HEAD_BYTES) s = s.slice(0, s.lastIndexOf('\n') + 1);   // 截断的最后一行不要
    return parseHead(s);
  } catch { return {}; } finally { try { await fh?.close(); } catch {} }
}

export const isBridgeEntrypoint = (e) => typeof e === 'string' && /^sdk-/.test(e);

// Desktop 记录的最小形状（Desktop 自己写的 538 份里这些字段 100% 都有；其余它加载时自己补默认）
export function buildRecord({ local, cli, cwd, title, model, permissionMode, createdAt, lastActivityAt, archived }) {
  return {
    sessionId: local,
    cliSessionId: cli,
    cwd,
    originCwd: cwd,
    createdAt,
    lastActivityAt,
    model: model || 'claude-opus-5-5',
    isArchived: !!archived,
    title,
    titleSource: 'auto',
    permissionMode: permissionMode || 'default',
    enabledMcpTools: {},
    remoteMcpServersConfig: [],
    interruptedAwaitingPerson: null,
    steeredByRemoteClient: null,
    alwaysAllowedReasons: [],
    sessionPermissionUpdates: [],
  };
}

const dropEmpty = (o) => Object.fromEntries(Object.entries(o || {}).filter(([k, v]) => v !== undefined && v !== null && v !== '' && k !== 'fresh' && k !== 'title'));

// —— 状态 ——

function loadState(file) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8'));
    if (j && j.v === 1 && j.items && typeof j.items === 'object') return j;
  } catch {}
  return { v: 1, items: {} };
}
function saveState(file, st) {
  try { const tmp = file + '.tmp'; writeFileSync(tmp, JSON.stringify(st)); renameSync(tmp, file); } catch {}
}

async function writeAtomic(file, obj) {
  const tmp = file + '.' + process.pid + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2));
  await fsp.rename(tmp, file);
  return (await fsp.stat(file)).mtimeMs;
}

/**
 * 一轮同步。files：bridge 会话列表（非临时对话）{ id, file, mtime, size }；
 * titleOf(f) → 标题；archivedOf(f) → bool。orgDir 不给就按当前账号探测。
 * excludeCwd(cwd) → true 的不登记（临时对话桶）；retract：临时对话的会话行，以前登记过的撤回。
 * → { wrote, updated, skipped, retracted }
 */
export async function mirrorOnce({ files, titleOf, archivedOf, stateFile, orgDir, knownIds, excludeCwd, retract = [], now = Date.now() }) {
  const od = orgDir || await targetOrgDir();
  const res = { wrote: 0, updated: 0, skipped: 0, retracted: 0, dir: od };
  if (!od) return res;
  const st = loadState(stateFile);
  const known = knownIds || desktopCliIdsUnder(od);
  let dirty = false;
  // 撤回自己写的那份：文件还是自己写时的样子才删；Desktop 动过的归 Desktop，已经不在的记 gone
  const retractItem = async (key) => {
    const it = st.items[key];
    if (!it || !it.local || it.gone || it.owned) return;
    const target = path.join(od, it.local + '.json');
    let fst = null;
    try { fst = await fsp.stat(target); } catch {}
    if (!fst) { st.items[key] = { ...it, gone: true }; dirty = true; return; }
    if (Math.abs(fst.mtimeMs - it.fm) > MTIME_SLACK) { st.items[key] = { ...it, owned: true }; dirty = true; return; }
    try { await fsp.unlink(target); delete st.items[key]; dirty = true; res.retracted++; } catch {}
  };
  for (const f of retract || []) if (f && f.id) await retractItem(od + '|' + f.id);
  for (const f of files) {
    if (!f || !f.id || (!f.file && !f.hint)) continue;
    const key = od + '|' + f.id;
    const it = st.items[key];
    if (it && (it.gone || it.owned || it.skip)) continue;   // skip：不是 bridge 开的，entrypoint 不会变
    if (it && !f.hint && it.tm === f.mtime && it.ts === f.size) continue;   // transcript 没变
    const target = it ? path.join(od, it.local + '.json') : null;
    if (it) {
      // 自己写过：文件还在、而且还是自己写的那一版才更新
      let fst = null;
      try { fst = await fsp.stat(target); } catch {}
      if (!fst) { st.items[key] = { ...it, gone: true }; dirty = true; continue; }
      if (Math.abs(fst.mtimeMs - it.fm) > MTIME_SLACK) { st.items[key] = { ...it, owned: true }; dirty = true; continue; }
    } else if (!(f.hint && f.hint.fresh) && known.has(f.id)) { res.skipped++; continue; }   // Desktop 自己有这条
    // 会话刚建（f.hint 来自 SDK 的 init）：transcript 可能还没落盘，用 init 报的 cwd / 模型 / 权限
    const fromFile = f.file ? await readHead(f.file) : {};
    const head = f.hint ? { entrypoint: 'sdk-ts', createdAt: now, ...dropEmpty(f.hint), ...dropEmpty(fromFile) } : fromFile;
    const tmpRoot = path.resolve(os.tmpdir()).toLowerCase() + path.sep;
    if (head.cwd && path.resolve(head.cwd).toLowerCase().startsWith(tmpRoot)) head.entrypoint = 'tmp';   // 临时目录里的（测试 / 一次性）不登记
    if (head.cwd && excludeCwd && excludeCwd(head.cwd)) {
      // 临时对话：不登记，也不记 skip（存为工作空间后还要登记）；以前登记过的撤回
      if (it) await retractItem(key);
      res.skipped++;
      continue;
    }
    if (!isBridgeEntrypoint(head.entrypoint) || !head.cwd) {
      // 确定不是 bridge 开的：记下，之后不再读（读不出 entrypoint 的——还没写完——不记，下一轮再看）
      if (!it && head.entrypoint) { st.items[key] = { skip: true, tm: f.mtime, ts: f.size }; dirty = true; }
      res.skipped++;
      continue;
    }
    const title = String((await titleOf(f)) || (f.hint && f.hint.title) || '').trim();   // transcript 还没落盘时用 init 那条提示词
    if (!title) { res.skipped++; continue; }   // bridge 列表也不列没标题的
    const local = it ? it.local : 'local_' + randomUUID();
    const rec = buildRecord({
      local, cli: f.id, cwd: head.cwd, title, model: head.model, permissionMode: head.permissionMode,
      createdAt: (it && it.ca) || head.createdAt || Math.round(f.mtime) || now,
      lastActivityAt: Math.max(Math.round(f.mtime) || 0, f.hint ? now : 0) || now,
      archived: !!archivedOf(f) || (!it && !f.hint && now - (Number(f.mtime) || 0) > STALE_MS),
    });
    try {
      const fm = await writeAtomic(path.join(od, local + '.json'), rec);
      st.items[key] = { local, fm, tm: f.mtime, ts: f.size, ca: rec.createdAt };
      dirty = true;
      if (it) res.updated++; else res.wrote++;
    } catch { res.skipped++; }
  }
  // 以前记成 skip 的、transcript 已经不在列表里的：清掉，状态文件别越攒越大（单条登记不做这步）
  if (files.length === 1 && files[0].hint) { if (dirty) saveState(stateFile, st); return res; }
  const live = new Set(files.map((f) => od + '|' + f.id));
  for (const k of Object.keys(st.items)) if (st.items[k].skip && k.startsWith(od + '|') && !live.has(k)) { delete st.items[k]; dirty = true; }
  if (dirty) saveState(stateFile, st);
  return res;
}

// —— 调度 ——
// 两个入口：① 会话刚建 / 每轮结束（agents/claude.mjs）当场登记这一条——bridge 会话「天生」就有 Desktop 索引；
// ② 会话列表接口顺手全量补一遍（旧会话、漏掉的），节流 60s。两者串行（共用一份状态文件）。

let chain = Promise.resolve();
const serial = (fn) => (chain = chain.then(fn, fn));
let sweeping = false;
let lastAt = 0;
let titleResolver = null;   // routes/sessions.mjs 注册：f → 标题（与 bridge 列表同一口径）
let archivedResolver = null;
export function setMirrorResolvers({ titleOf, archivedOf } = {}) { if (titleOf) titleResolver = titleOf; if (archivedOf) archivedResolver = archivedOf; }

export function mirrorEnabled(ctx, env = process.env) {
  if (String(env.BRIDGE_DESKTOP_MIRROR || '') === '0') return false;
  if (env === process.env && env.NODE_TEST_CONTEXT) return false;   // node --test 里跑的路由测试不许写真 Desktop 目录
  if (!ctx || ctx.kind !== 'admin' || ctx.snap || !ctx.dataDir || ctx.configDir) return false;
  if (String(env.CLAUDE_CONFIG_DIR || '').trim()) return false;
  return true;
}
const stateFileOf = (ctx) => path.join(ctx.dataDir, 'desktop-mirror.json');
const logRes = (r) => { if (r && (r.wrote || r.updated || r.retracted)) console.log(`[desktop-mirror] ${r.dir}: 新登记 ${r.wrote}、更新 ${r.updated}、撤回 ${r.retracted || 0}`); };
const quickCwd = (ctx) => (cwd) => inQuickRoots(ctx, cwd);

/**
 * 单条当场登记。hint：{ fresh, cwd, model, permissionMode, title }（init 时给；fresh = 这一轮新开的 id，
 * Desktop 不可能已有）。file：transcript 路径（有就以文件为准）。
 */
export function mirrorSessionNow(ctx, id, { file, hint } = {}) {
  if (!mirrorEnabled(ctx) || !id) return Promise.resolve(null);
  if (!(hint && hint.fresh) && !desktopLineageScanned()) return Promise.resolve(null);   // 续聊的老会话：Desktop 那边没扫完，留给全量那路
  return serial(async () => {
    let mtime = 0, size = 0;
    if (file) { try { const st = await fsp.stat(file); mtime = st.mtimeMs; size = st.size; } catch {} }
    const f = { id, file: mtime ? file : undefined, mtime, size, hint: hint || {}, ctx };
    return mirrorOnce({ files: [f], titleOf: titleResolver || (async () => ''), archivedOf: (x) => (archivedResolver ? archivedResolver(ctx, x) : false), stateFile: stateFileOf(ctx), excludeCwd: quickCwd(ctx) });
  }).then((r) => { logRes(r); return r; }).catch((e) => { console.warn('[desktop-mirror]', e && e.message); return null; });
}

/**
 * 全量补登记。opts: { filesFn: async () => files | { files, retract }, titleOf, archivedOf, force }
 *   retract = 临时对话的会话行（以前登记过的撤回）；force = 不等 60s 节流（刚「存为工作空间」）。
 */
export function scheduleDesktopMirror(ctx, opts, now = Date.now()) {
  if (!mirrorEnabled(ctx) || sweeping || (!opts.force && now - lastAt < MIN_GAP_MS)) return;
  if (!desktopLineageScanned()) return;   // Desktop 那边还没扫完一轮，判断不了「Desktop 有没有这条」
  lastAt = now; sweeping = true;
  serial(async () => {
    const got = await opts.filesFn();
    const files = Array.isArray(got) ? got : (got && got.files) || [];
    const retract = Array.isArray(got) ? [] : (got && got.retract) || [];
    return mirrorOnce({ files, retract, titleOf: opts.titleOf, archivedOf: opts.archivedOf, stateFile: stateFileOf(ctx), excludeCwd: quickCwd(ctx) });
  }).then(logRes).catch((e) => console.warn('[desktop-mirror]', e && e.message)).finally(() => { sweeping = false; });
}

export function _resetMirror() { sweeping = false; lastAt = 0; chain = Promise.resolve(); }
