// 会话 ↔ 拉取请求（PR）闭环（2026-10-20，对齐官方 Claude Desktop 3.1623：GitHubPrManager + AutoFixEngine + ccd_pr）。
//
// 官方分工（调研报告 桌面端对齐-1020/A2 §1）：
//   · Commit / Create PR 交给 Claude 去做（app 只发提示词）；Merge / Ready / Draft / Auto-merge / Re-run 由 app 直调 GitHub；
//   · 会话 ↔ PR 绑定：Claude 跑了 gh pr create、在回复里用 <pr-created> 报了链接、推送了已有 PR 的分支、手动 / 工具绑定；
//   · PR 状态缓存：open 15 秒、已合并 / 已关闭 5 分钟；界面上可见的 PR 行定时刷新；
//   · Auto-fix：每 60 秒（没人看时 5 分钟）查一遍开着 Auto-fix 的 PR——CI 失败、合并冲突、新评审意见——
//     有事就以 <ci-monitor-event> 用户消息叫醒那个会话；按 headSha:检查名 / 评论 id 去重；冲突时先在主机侧合并基线。
//
// bridge 版：
//   · 绑定台账按身份落 <dataDir>/claude-session-prs.json（含 Auto-fix 去重记账与重放身份，见 .gitignore）；
//   · 叫醒 = 服务端重放一条 /api/chat（claude-queue.replayChat，与限额续跑同一个口），身份头随绑定落盘，重启不丢；
//     重放请求挂 family origin {kind:'ci'}（对象属性，客户端伪造不了）：不算「人接手」，不作废等着的限额续跑、
//     不清零会话间连续自动续计数；真人发话时（notePrTurnStart）才清零本模块的连续唤醒计数。
//   · 防无限互唤：连续 5 次自动修复唤醒中间没有用户发话 → 暂停；同一 head 提交最多叫醒 3 次；每天每会话最多 10 次；
//     两次唤醒至少隔 60 秒；会话在跑 / 在等回答 / 有排队消息 / 等着限额续跑时不叫醒（下一轮扫描再看）。
//   · 自动合并：仓库开了 GitHub 原生 auto-merge 就走 GitHub；没开（本机三个仓库都没开）就由 bridge 在检查通过后代为合并
//     （新 head 上一个检查都还没登记时不算「全过」：同一 head 隔 3 分钟两次都是 0 个检查才合）。
//   · PR 合并或关闭后自动归档：调 session-archive.setArchived(reason:'pr_closed') 并推 {type:'archive'}；
//     收藏的、在跑 / 等回答 / 有排队 / 等限额续跑的、有设备正看着的会话不归档（官方 pinned / held_input / on_screen）；
//     只看本会话自己的 PR（官方：非 inherited）——继承来的、只从转录 pr-link 认出来的不算（CLI 对 gh pr checkout /
//     merge / close / comment 也写 pr-link，不记动作，认不出是不是本会话的 PR）。
//   · 自动来源（流里的 <pr-created>、gh pr create 输出、code_change_published、转录 pr-link）只绑本检出远程里的仓库
//     （或这个身份已经在跟踪的仓库）；转录 pr-link 还要 PR 的 head 分支是本会话待过的分支。
//   · 同一个 PR 绑在几个会话上时 Auto-fix 只有一个主人（官方 revokeAutoFixFromPeers）；派生 / 分叉会话继承来的 PR
//    （source 'inherited'）不能开 Auto-fix 与自动合并。
//   · 后台扫描只在正式实例跑（server.mjs 调 initPrMonitor 才开计时器）：调试台、桌面壳内嵌实例与正式服共用数据根，
//     两边都扫会对同一个会话各叫醒一次。台账写前对一下磁盘，别的进程写过就以磁盘为准、只盖这次改的会话。
//
// 只给主机本人（prCapable：admin、非沙箱、有 shell、非快照）——gh 令牌是这台电脑登录的 GitHub 账号。
import path from 'node:path';
import { promises as fsp, statSync } from 'node:fs';
import { readJson, writeJson, ID_RE } from '../jsonfile.mjs';
import { busPublish, busSubscribers } from './bus.mjs';
import { findGenBySession, getLiveGens } from './gen.mjs';
import { sessionQuestions } from './questions.mjs';
import { findExternalHolder } from './external-holder.mjs';
import { replayChat, listQueue } from './claude-queue.mjs';
import { REPLAY_HEADERS, REPLAY_AS_HEADER, replayHeadersOf } from './identity.mjs';
import { getLimitResume } from './limit-resume.mjs';
import { chatPrefsFor } from './chat-prefs.mjs';
import { claudeSetting } from './claude-settings.mjs';
import { setArchived, localArchiveFlag } from './session-archive.mjs';
import { getLibrary } from './session-library.mjs';
import { familyLink } from './session-family.mjs';
import { lineageFor } from './desktop-lineage.mjs';
import * as claudeProjects from '../claude-projects.mjs';
import { listWorktrees } from '../claude-worktrees.mjs';
import * as gh from './github.mjs';
import { gitInfo, forgetGitInfo, remoteRepos, syncBaseBranch as gitSyncBase } from './pr-git.mjs';
import { composeCiEvent, AUTOFIX_ON_TEXT, MAX_COMMENTS } from './pr-messages.mjs';

const TTL_OPEN_MS = 15_000;            // 官方 h_
const TTL_DONE_MS = 300_000;           // 官方 S_
const TICK_MS = 15_000;
const SWEEP_ACTIVE_MS = 60_000;        // 官方 c：有设备在线
const SWEEP_IDLE_MS = 300_000;         // 官方 l：没有设备在线（对应官方「窗口失焦 / 系统空闲」）
const CLOSED_RECHECK_MS = 30 * 60_000; // 官方 d=30 个 sweep
const CI_HOLD_MS = 5 * 60_000;         // 官方 ee：同一 workflow 还有 pending 的兄弟检查时最多压 5 分钟
const CONFLICT_REMIND_MS = 30 * 60_000;// 官方 p：30 分钟 × 2^n 提醒
const CONFLICT_REMINDERS = 3;          // 官方 m
const MIN_WAKE_GAP_MS = 60_000;
const MAX_STREAK = 5;
const MAX_WAKES_PER_HEAD = 3;
const MAX_WAKES_PER_DAY = 10;
const BRANCH_LOOKUP_MS = 10 * 60_000;
const NO_CHECKS_CONFIRM_MS = 3 * 60_000;   // 代合并：同一 head 上 0 个检查要隔这么久再看一次还是 0 才当「没有 CI」
const VIEW_HOLD_MS = 150_000;              // 有设备在这么久之内拉过这个会话的 PR 状态 = 有人正看着（不自动归档）
const WAKE_RETRY_MAX = 32;                 // 唤醒失败退避：2^n 分钟，封顶 32 分钟（官方 sendFailureCounts）
const RELOAD_CHECK_MS = 2_000;             // 台账：隔这么久看一眼磁盘有没有被别的进程改过
const MAX_SESSIONS = 500;
const MAX_PRS = 10;
const MAX_SEEN = 500;
const TERMINAL = new Set(['merged', 'closed']);

/** 能不能用 PR 功能：主机本人（gh 令牌是这台电脑的 GitHub 账号，沙箱用户 / 快照访客一律不给）。 */
export const prCapable = (ctx) => !!ctx && !ctx.snap && ctx.kind === 'admin' && !ctx.sandbox && !!ctx.shell;

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
// chat 路由会把 ctx.cwd 覆写成项目目录（homeRoot 留着身份原本的根）；台账与项目定位要的是身份本身
export const identityCtx = (ctx) => (ctx && ctx.homeRoot ? { ...ctx, cwd: ctx.homeRoot, homeRoot: undefined, worktree: undefined } : ctx);
const K = (key, sid) => key + '|' + sid;
export const prKeyOf = (r) => `${r.host}/${r.repo}#${r.number}`.toLowerCase();
const today = () => new Date().toISOString().slice(0, 10);

// —— 台账 ——
const fileFor = (ctx) => path.join(ctx.dataDir, 'claude-session-prs.json');
const stores = new Map();   // file → { rev, sessions, mtime（上次读 / 写时磁盘文件的 mtime）, checkedAt }

function normBinding(b) {
  if (!b || typeof b !== 'object') return null;
  const ref = gh.parsePrUrl(b.url);
  if (!ref) return null;
  return {
    ...ref, title: String(b.title || ''), state: String(b.state || 'open'), head: String(b.head || ''), base: String(b.base || ''),
    headSha: String(b.headSha || ''), source: String(b.source || 'manual'), own: !!b.own, dismissed: !!b.dismissed,
    // 谁移出的：'tool'（Claude 用 unbind_pr）可以由 Claude 用 bind_pr 恢复；'user'（PR 卡上点的）只能由用户恢复
    dismissedBy: b.dismissed ? (b.dismissedBy === 'tool' ? 'tool' : 'user') : '',
    boundAt: Number(b.boundAt) || Date.now(), checkedAt: Number(b.checkedAt) || 0,
  };
}
function normSlot(s) {
  const tri = (v) => (v === true || v === false ? v : null);
  const fix = s.fix && typeof s.fix === 'object' ? s.fix : {};
  return {
    prs: (Array.isArray(s.prs) ? s.prs : []).map(normBinding).filter(Boolean).slice(-MAX_PRS),
    autoFix: tri(s.autoFix), autoArchive: tri(s.autoArchive),
    merge: s.merge && typeof s.merge === 'object' ? s.merge : {},
    fix: {
      delivered: fix.delivered && typeof fix.delivered === 'object' ? fix.delivered : {},
      streak: Number(fix.streak) || 0, paused: String(fix.paused || ''), lastWakeAt: Number(fix.lastWakeAt) || 0,
      day: String(fix.day || ''), dayCount: Number(fix.dayCount) || 0, wakes: Number(fix.wakes) || 0, lastError: String(fix.lastError || ''),
      failN: Number(fix.failN) || 0, retryAt: Number(fix.retryAt) || 0,   // 唤醒没送出去的退避
    },
    replay: s.replay && typeof s.replay === 'object' ? s.replay : null,
    fixAt: Number(s.fixAt) || 0,   // 最近一次明确打开 Auto-fix 的时刻（几个会话抢同一个 PR 时谁是主人）
    archivedFor: String(s.archivedFor || ''),
    at: Number(s.at) || Date.now(),
  };
}
function readDisk(file) {
  const raw = readJson(file, {});
  const sessions = {};
  if (raw.sessions && typeof raw.sessions === 'object') {
    for (const [sid, s] of Object.entries(raw.sessions)) if (ID_RE.test(sid) && s && typeof s === 'object') sessions[sid] = normSlot(s);
  }
  return { rev: Number(raw.rev) || 0, sessions };
}
const mtimeOf = (file) => { try { return statSync(file).mtimeMs; } catch { return 0; } };
// 同一个数据根上可能还有别的 bridge 进程（调试台、桌面壳内嵌实例）在写这份台账：隔一会儿看一眼磁盘，
// 不是自己写的改动就整份重读——否则拿着几小时前的内存副本一写，就把用户在正式服里关掉的开关又写回去。
function load(ctx) {
  const file = fileFor(ctx);
  let d = stores.get(file);
  if (!d) {
    d = { ...readDisk(file), mtime: mtimeOf(file), checkedAt: Date.now() };
    stores.set(file, d);
  } else if (Date.now() - d.checkedAt >= RELOAD_CHECK_MS) {
    d.checkedAt = Date.now();
    const m = mtimeOf(file);
    if (m && m !== d.mtime) { const x = readDisk(file); d.sessions = x.sessions; d.rev = Math.max(d.rev, x.rev); d.mtime = m; }
  }
  return d;
}
// 落盘。sid + s = 这次改的是哪个会话（异步流程手里那份可能已经因为重读而脱离了台账：写回时重新挂上）；s 为 null = 删掉它。
// 写之前再对一次磁盘：被别的进程改过就以磁盘为准，只把这次改的这个会话盖上去。
function save(ctx, sid, s) {
  const file = fileFor(ctx);
  const d = load(ctx);
  const m = mtimeOf(file);
  if (m && m !== d.mtime) { const x = readDisk(file); d.sessions = x.sessions; d.rev = Math.max(d.rev, x.rev); }
  if (sid && s === null) delete d.sessions[sid];
  else if (sid && s && !s.gone) d.sessions[sid] = s;
  const ids = Object.keys(d.sessions);
  if (ids.length > MAX_SESSIONS) {
    ids.sort((a, b) => d.sessions[a].at - d.sessions[b].at);
    for (const id of ids.slice(0, ids.length - MAX_SESSIONS)) delete d.sessions[id];
  }
  d.rev += 1;
  writeJson(file, { rev: d.rev, sessions: d.sessions }, 0);
  d.mtime = mtimeOf(file);
  d.checkedAt = Date.now();
}
function slot(ctx, sid, create) {
  const d = load(ctx);
  if (!d.sessions[sid] && create) d.sessions[sid] = normSlot({});
  return d.sessions[sid] || null;
}
const liveBindings = (s) => (s ? s.prs.filter((b) => !b.dismissed) : []);
// 自动归档只看本会话自己的 PR（官方：非 inherited）。只从转录 pr-link 认出来的也不算：CLI 对 gh pr checkout / merge /
// close / comment 也写 pr-link（不记动作），认不出这个 PR 是不是本会话做的。
const archiveRelevant = (b) => b.source !== 'inherited' && b.source !== 'transcript';

// 重放身份：只留身份头 + 重放时还要用的几个参数（不存消息正文）。这是凭据副本（台账已 gitignore、只有主机本人会写）：
// cookie 只留认身份要的那两个（bridge_auth / bridge_user），浏览器顺带的其它 cookie 不落盘。
const AUTH_COOKIES = new Set(['bridge_auth', 'bridge_user']);
const authCookieOnly = (v) => String(v || '').split(';').map((x) => x.trim()).filter((x) => AUTH_COOKIES.has(x.split('=')[0].trim())).join('; ');
// rp 一律是服务端拼好的重放（runtime/identity.mjs replayHeadersOf 出来的）：进程内身份标记原样留着；
// 原始网络请求头先经 replayHeadersOf 再进来（replayFromReq），客户端伪造的同名头到不了这里。
function cleanReplay(rp) {
  if (!rp || !rp.headers) return null;
  const headers = Object.fromEntries(REPLAY_HEADERS.filter((h) => rp.headers[h]).map((h) => [h, h === 'cookie' ? authCookieOnly(rp.headers[h]) : String(rp.headers[h])]).filter(([, v]) => v));
  if (rp.headers[REPLAY_AS_HEADER]) headers[REPLAY_AS_HEADER] = String(rp.headers[REPLAY_AS_HEADER]);
  const b = rp.body || {};
  return {
    headers, url: typeof rp.url === 'string' && rp.url.startsWith('/api/chat') ? rp.url : '/api/chat',
    body: { client: b.client === 'apk' ? 'apk' : 'web', ...(b.suggest === true ? { suggest: true } : {}), ...(typeof b.compactFrac === 'number' ? { compactFrac: b.compactFrac } : {}) },
  };
}
export const replayFromReq = (req) => (req && req.headers ? cleanReplay({ headers: replayHeadersOf(req), url: '/api/chat', body: {} }) : null);
// 这个身份最近一次真人发话的身份头（官方没有这层；bridge 的新会话可能接管预热好的 CLI，那一轮流里绑上的 PR
// 手里没有重放身份——绑定时拿它兜底，免得自动修复一直卡在 no_identity）。只在内存里，重启后由下一句话补上。
const lastReplay = new Map();   // key → cleanReplay

// —— 设置 ——
// 这个会话想不想盯这个 PR（不管别的会话）。继承来的 PR 不能开（官方：只对这个会话做过的 PR 开放）。
function autoFixWanted(ctx, s, b) {
  if (!s || !b || b.dismissed || TERMINAL.has(b.state) || b.source === 'inherited') return false;
  if (s.autoFix === true) return true;
  if (s.autoFix === false) return false;
  return !!b.own && !!claudeSetting(ctx, 'autoFixPullRequests');   // 默认只管本会话自己建的 PR（官方 armOwnCreate）
}
// 同一个 PR 绑在几个会话上、都想盯时只认一个主人（官方 revokeAutoFixFromPeers：同一次 CI 失败别把两个会话都叫醒、
// 两边并发改同一个分支）：明确打开过的优先（最近打开的那个），其次本会话建的，再其次最早绑上的。
const ahead = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] > b[i]; return false; };
function fixOwner(ctx, k) {
  let best = '', rank = null;
  for (const [sid, s] of Object.entries(load(ctx).sessions)) {
    const b = liveBindings(s).find((x) => prKeyOf(x) === k);
    if (!b || !autoFixWanted(ctx, s, b)) continue;
    const r = [s.autoFix === true ? 1 : 0, s.autoFix === true ? s.fixAt : 0, b.own ? 1 : 0, -b.boundAt];
    if (!rank || ahead(r, rank)) { best = sid; rank = r; }
  }
  return best;
}
const autoFixFor = (ctx, sid, s, b) => autoFixWanted(ctx, s, b) && fixOwner(ctx, prKeyOf(b)) === sid;
// 在这个会话明确打开 Auto-fix：别的会话里同一个（还开着的）PR 的 Auto-fix 关掉（官方 revokeAutoFixFromPeers），界面上也只剩一处开着
function revokeAutoFixFromPeers(ctx, sid, s) {
  const mine = new Set(liveBindings(s).filter((b) => !TERMINAL.has(b.state)).map(prKeyOf));
  if (!mine.size) return;
  for (const [osid, os] of Object.entries(load(ctx).sessions)) {
    if (osid === sid || !liveBindings(os).some((b) => mine.has(prKeyOf(b)) && autoFixWanted(ctx, os, b))) continue;
    os.autoFix = false;
    os.at = Date.now();
    save(ctx, osid, os);
    console.log(`[pr] ${osid.slice(0, 8)} auto-fix handed over to ${sid.slice(0, 8)}`);
    publishSoon(ctx, osid);
  }
}
const autoArchiveFor = (ctx, s) => (s && (s.autoArchive === true || s.autoArchive === false) ? s.autoArchive : !!claudeSetting(ctx, 'autoArchiveOnPrClose'));

// —— PR 状态缓存 ——
const prCache = new Map();   // key → { view, at }
const prInflight = new Map();
export async function readPr(ref, { fresh = false } = {}) {
  const k = prKeyOf(ref);
  const c = prCache.get(k);
  if (!fresh && c && Date.now() - c.at < (TERMINAL.has(c.view.state) ? TTL_DONE_MS : TTL_OPEN_MS)) return c.view;
  if (prInflight.has(k)) return prInflight.get(k);
  const p = gh.fetchPr(ref)
    .then((view) => { prCache.set(k, { view, at: Date.now() }); if (prCache.size > 300) prCache.delete(prCache.keys().next().value); return view; })
    .finally(() => prInflight.delete(k));
  prInflight.set(k, p);
  return p;
}
const invalidate = (ref) => prCache.delete(prKeyOf(ref));

// 读到的状态写回绑定（标题 / 分支 / 状态），返回状态是否变了
function syncBinding(b, v) {
  b.checkedAt = Date.now();
  const before = b.state;
  b.state = v.state; b.title = v.title; b.head = v.head; b.base = v.base; b.headSha = v.headSha;
  return before !== v.state;
}

// —— 会话工作目录 ——
function sessionWhere(ctx, sid) {
  const p = claudeProjects.locateSessionProject(ctx.claudeProjects, ctx, sid);
  return p && p.path ? p : null;
}
const liveTurn = (ctx, sid) => { const g = findGenBySession(ctx.key, sid); return !!(g && !g.done); };

// 分支反查：会话工作目录在 GitHub 仓库的功能分支上、还没绑定 PR → 查这个分支有没有开着的 PR（官方 bindStartingChange）。
// 只对「本会话在这个分支上干过活」的会话做（官方只认 session.writtenBranches）：worktree 会话（目录是它专属的），
// 或转录里记着本会话就在这个分支上（CLI 每条消息带 gitBranch）——否则主检出目录里的老会话一打开就会被绑到当前分支的 PR 上。
const branchLookups = new Map();   // cwd|branch → at
async function lookupBranch(ctx, sid, gi) {
  const k = gi.remote.host + '|' + gi.remote.repo + '|' + gi.branch + '|' + sid;
  if (Date.now() - (branchLookups.get(k) || 0) < BRANCH_LOOKUP_MS) return;
  branchLookups.set(k, Date.now());
  if (branchLookups.size > 500) branchLookups.delete(branchLookups.keys().next().value);
  try {
    const ref = await gh.findOpenPrForBranch(gi.remote, gi.branch);
    // 派生的子会话和父会话同一个工作目录（同一个 worktree）：这样反查到的是父会话的 PR，记成继承来的
    if (ref) bindPr(ctx, sid, ref, { source: inheritedFrom(ctx, sid, prKeyOf(ref)) ? 'inherited' : 'branch', quiet: true });
  } catch {}
}

// 转录里的 pr-link：CLI 建 PR、推送到有 PR 的分支时往 transcript 追加 {"type":"pr-link", prUrl, …}
//（官方桌面端、命令行里跑过、再到 bridge 打开的会话靠它认；bridge 自己跑的会话流里已经绑上了，这里只是 'exists'）。
// 增量读：记住扫到哪个字节，下次只读新增的部分；第一次最多从尾部往前读 16MB（CLI 收尾时会把它重新追加到末尾）。
// 顺手收集本会话待过的分支（消息上的 gitBranch），分支反查据此判断「是不是本会话的分支」。
const LINK_SCAN_MAX = 16 * 1024 * 1024;
const MAX_BRANCHES = 50;
const GIT_BRANCH_RE = /"gitBranch":"([^"\\]{1,200})"/g;
const linkScans = new Map();   // transcript 文件 → { size, urls:Set, foreign:Set, branches:Set }
const linkScanning = new Map();   // transcript 文件 → 进行中的那次扫描（同一份文件串行：并发的两次会从同一个偏移各读一遍、偏移加两次）
const scanOut = (c) => ({ urls: [...c.urls], foreign: [...c.foreign], branches: [...c.branches] });
const EMPTY_SCAN = () => ({ urls: [], foreign: [], branches: [] });
export function scanTranscript(file) {
  const prev = linkScanning.get(file);
  const p = (prev ? prev.then(() => scanOnce(file), () => scanOnce(file)) : scanOnce(file)).catch(() => EMPTY_SCAN());
  linkScanning.set(file, p);
  p.then(() => { if (linkScanning.get(file) === p) linkScanning.delete(file); });
  return p;
}
async function scanOnce(file) {
  let size;
  try { size = (await fsp.stat(file)).size; } catch { return EMPTY_SCAN(); }
  let c = linkScans.get(file);
  if (c && c.size === size) return scanOut(c);
  if (!c || size < c.size) c = { size: Math.max(0, size - LINK_SCAN_MAX), urls: new Set(), foreign: new Set(), branches: new Set() };   // 新文件 / 被改写过：重扫
  const own = path.basename(file, '.jsonl');
  const start = c.size;
  const len = size - start;
  if (len > 0) {
    const buf = Buffer.alloc(len);
    const fh = await fsp.open(file, 'r');
    try { await fh.read(buf, 0, len, start); } finally { await fh.close(); }
    // 只认完整的行（文件可能正被追加到一半）；起点落在行中间时第一段 JSON.parse 失败，自然跳过
    const end = buf.lastIndexOf(10);
    if (end >= 0) {
      const text = buf.subarray(0, end).toString('utf8');
      if (text.includes('"pr-link"')) {
        for (const l of text.split('\n')) {
          if (!l.includes('"pr-link"')) continue;
          try {
            const o = JSON.parse(l);
            if (!o || o.type !== 'pr-link' || typeof o.prUrl !== 'string') continue;
            c.urls.add(o.prUrl);
            // 条目上记的会话不是这一份：分叉时从父会话的转录里抄过来的（继承来的 PR）
            if (o.sessionId && String(o.sessionId).toLowerCase() !== own.toLowerCase()) c.foreign.add(o.prUrl);
          } catch {}
        }
      }
      for (const m of text.matchAll(GIT_BRANCH_RE)) {
        if (c.branches.has(m[1])) continue;
        c.branches.add(m[1]);
        if (c.branches.size > MAX_BRANCHES) c.branches.delete(c.branches.values().next().value);
      }
      c.size = start + end + 1;
    }
  }
  linkScans.set(file, c);
  if (linkScans.size > 300) linkScans.delete(linkScans.keys().next().value);
  return scanOut(c);
}
export const transcriptPrLinks = async (file) => (await scanTranscript(file)).urls;

// 继承来的 PR：这个会话是派生 / 分叉出来的（bridge 会话家族的父会话、Desktop 血缘的根会话），祖先绑着同一个 PR。
// 官方 inherited：不能对它开 Auto-fix 或自动合并。
function inheritedFrom(ctx, sid, k) {
  const seen = new Set([sid]);
  const ups = [];
  let cur = sid;
  for (let i = 0; i < 16; i++) {
    const l = familyLink(ctx, cur);
    const p = l && l.parent;
    if (!p || seen.has(p)) break;
    seen.add(p); ups.push(p); cur = p;
  }
  try { const r = lineageFor(ctx).rootOf.get(sid); if (r && !seen.has(r)) ups.push(r); } catch {}
  return ups.some((a) => liveBindings(slot(ctx, a, false)).some((b) => prKeyOf(b) === k));
}
// 没绑过的 PR 才判一次来源（判过的绑定原样留着）
function boundKeys(ctx, sid) { return new Set((slot(ctx, sid, false) || { prs: [] }).prs.map(prKeyOf)); }

// 这个 PR 能不能「自动」绑到会话上：仓库是本检出的某个 GitHub 远程（origin，fork 工作流里的 upstream），
// 或这个身份已经有会话在跟踪这个仓库。<pr-created> 标签、gh 输出、CLI 报的链接都没经过核实——提示注入让 Claude
// 吐一个别人仓库的链接，不能就这样绑上、让 Auto-fix 去盯攻击者的仓库（他的评论会以 <ci-monitor-event> 叫醒会话）。
async function repoTrusted(ctx, cwd, ref) {
  const same = (r) => !!r && r.host === ref.host && String(r.repo).toLowerCase() === ref.repo.toLowerCase();
  if (cwd) { try { if ((await remoteRepos(cwd)).some(same)) return true; } catch {} }
  return Object.values(load(ctx).sessions).some((x) => liveBindings(x).some((b) => b.source !== 'inherited' && same(b)));
}

// 绑上转录里的 pr-link；返回本会话待过的分支（没有转录 → []）。
// CLI 对 gh pr checkout / merge / close / comment / review 也写 pr-link（不记是哪种动作），所以要核对：PR 的 head 分支
// 是本会话待过的分支（消息上的 gitBranch——建 PR、推送、checkout 之后都会在那个分支上），仓库是本检出的远程。
// 核对要读一次 GitHub：gh 不可用时先不绑；不符的按「分支集合」记一笔，会话换到新分支前不再读。
const transcriptSkip = new Map();   // key|sid|prKey → 当时的分支签名
async function bindFromTranscript(ctx, sid, { ghOk = false, cwd = '' } = {}) {
  const sp = claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, sid);
  if (!sp) return [];
  const { urls, foreign, branches } = await scanTranscript(sp.file);
  const known = boundKeys(ctx, sid);
  const sig = branches.length + ':' + (branches[branches.length - 1] || '');
  for (const u of urls) {
    const ref = gh.parsePrUrl(u);
    if (!ref || known.has(prKeyOf(ref))) continue;   // 已绑（含用户移出过的：bindPr 不带 restore 也绑不回来）
    if (!ghOk) continue;
    const sk = K(ctx.key, sid) + '|' + prKeyOf(ref);
    if (transcriptSkip.get(sk) === sig) continue;
    const skip = () => { transcriptSkip.set(sk, sig); if (transcriptSkip.size > 1000) transcriptSkip.delete(transcriptSkip.keys().next().value); };
    // 先在本地核对仓库（不是本检出的远程就不必去读 GitHub），再读 PR 看 head 分支
    if (!(await repoTrusted(ctx, cwd, ref))) { skip(); continue; }
    let v;
    try { v = await readPr(ref); } catch { continue; }
    if (!v.head || !branches.includes(v.head)) { skip(); continue; }
    const inherited = foreign.includes(u) || inheritedFrom(ctx, sid, prKeyOf(ref));
    bindPr(ctx, sid, ref, { source: inherited ? 'inherited' : 'transcript' });
  }
  return branches;
}

// —— 绑定 ——
/**
 * 把一个 PR 绑到会话。opts：source（announce|tag|gh|branch|manual|tool）、own（本会话建的）、replay（重放身份）、
 * restore（恢复移出过的：true = 用户自己的操作，什么都能恢复；'tool' = Claude 的 bind_pr，只能恢复它自己用 unbind_pr 移出的）。
 * 返回 { outcome:'bound'|'exists'|'restored'|'dismissed', binding }。
 */
export function bindPr(ctx, sid, ref, { source = 'manual', own = false, replay = null, restore = false, quiet = false } = {}) {
  if (!prCapable(ctx) || !ID_RE.test(String(sid || '')) || !ref) return { outcome: 'failed' };
  const s = slot(ctx, sid, true);
  const k = prKeyOf(ref);
  let b = s.prs.find((x) => prKeyOf(x) === k);
  let outcome, ownUp = false;
  if (b) {
    if (b.dismissed && !(restore === true || (restore === 'tool' && b.dismissedBy === 'tool'))) return { outcome: 'dismissed', binding: b };
    outcome = b.dismissed ? 'restored' : 'exists';
    b.dismissed = false; b.dismissedBy = '';
    if (own && !b.own) { b.own = true; ownUp = true; }   // 先由转录 / 分支反查绑上，后来才知道是本会话建的
    // 只从转录认出来的，后来流里 / 手动又确认了一次（推送、<pr-created>……）：升格成那个来源，参与自动归档
    if (b.source === 'transcript' && source !== 'transcript' && source !== 'inherited') { b.source = source; ownUp = true; }
  } else {
    b = normBinding({ ...ref, url: ref.url, source, own, boundAt: Date.now() });
    if (!b) return { outcome: 'failed' };
    s.prs.push(b);
    if (s.prs.length > MAX_PRS) s.prs.splice(0, s.prs.length - MAX_PRS);
    outcome = 'bound';
  }
  // 重放身份：这次带来的优先；没有（新会话接管了预热的 CLI）就用这个身份最近一次真人发话的
  const r = cleanReplay(replay) || (!s.replay ? lastReplay.get(ctx.key) || null : null);
  if (r) s.replay = r;
  s.at = Date.now();
  const changed = outcome !== 'exists' || ownUp;
  if (changed || r) save(ctx, sid, s);
  rememberCtx(ctx);
  if (changed) {
    kick(ctx, sid);   // 原样绑着的不 kick：PR 卡每次拉状态都会过一遍转录，kick 会把后台扫描频率拉高
    if (!quiet && outcome !== 'exists') console.log(`[pr] ${sid.slice(0, 8)} ${outcome} ${b.repo}#${b.number} (${source}${b.own ? ', own' : ''})`);
    publishSoon(ctx, sid);
  }
  return { outcome, binding: b };
}

/**
 * 移出（官方 dismiss）：这个 PR 的检查和评审不再出现在会话里，自动修复 / 自动归档也不再管它；bind 可以恢复。
 * by：'user'（PR 卡）/ 'tool'（Claude 的 unbind_pr）——Claude 自己移出的它可以用 bind_pr 恢复，用户移出的只能用户恢复。
 */
export function unbindPr(ctx, sid, ref, { by = 'user' } = {}) {
  const s = slot(ctx, sid, false);
  const b = s && s.prs.find((x) => prKeyOf(x) === prKeyOf(ref));
  if (!b || b.dismissed) return false;
  b.dismissed = true;
  b.dismissedBy = by === 'tool' ? 'tool' : 'user';
  delete s.merge[prKeyOf(b)];
  save(ctx, sid, s);
  publishSoon(ctx, sid);
  return true;
}

export function boundPrs(ctx, sid) { return liveBindings(slot(ctx, sid, false)).map((b) => ({ ...b })); }

/** 会话被删掉了（sessions.mjs /api/session/delete）：它的 PR 台账一并清掉，后台别再为它读 GitHub、唤醒注定失败的 CLI。 */
export function forgetPrSession(ctx, sid) {
  if (!prCapable(ctx) || !ID_RE.test(String(sid || ''))) return false;
  ctx = identityCtx(ctx);
  const d = load(ctx);
  const s = d.sessions[sid];
  if (!s) return false;
  s.gone = true;   // 手里还拿着它的异步流程（扫描到一半）写回时别把它挂回去
  nextAt.delete(K(ctx.key, sid)); viewedAt.delete(K(ctx.key, sid)); heldLogged.delete(K(ctx.key, sid));
  save(ctx, sid, null);
  return true;
}

// —— 给前端 / 工具看的一份 ——
function composePr(ctx, sid, s, b, v, error) {
  const k = prKeyOf(b);
  const m = s.merge[k];
  const base = { url: b.url, host: b.host, repo: b.repo, number: b.number, source: b.source, own: b.own, inherited: b.source === 'inherited', autoFix: autoFixFor(ctx, sid, s, b), error: error || '' };
  if (!v) return { ...base, title: b.title, state: b.state, isDraft: b.state === 'draft', head: b.head, base: b.base, headSha: b.headSha, checks: null, checkList: [] };
  return {
    ...base,
    title: v.title, state: v.state, isDraft: v.isDraft, head: v.head, base: v.base, headSha: v.headSha,
    additions: v.additions, deletions: v.deletions, checks: v.checks,
    checkList: v.checkList.slice(0, 40).map((c) => ({ name: c.name, bucket: c.bucket, url: c.url, workflow: c.workflow })),
    reviewDecision: v.reviewDecision, mergeable: v.mergeable, mergeStateStatus: v.mergeStateStatus,
    autoMerge: v.autoMerge || (m ? { enabled: true, method: m.method, by: 'bridge', error: m.error || '' } : null),
    autoMergeAllowed: v.repoInfo.autoMergeAllowed,
    methods: ['squash', 'merge', 'rebase'].filter((x) => v.repoInfo[x]),
    mergeQueue: v.mergeQueue, updatedAt: v.updatedAt, readAt: v.readAt,
  };
}

function pollHint() {
  const b = gh.ghBudget();
  if (b.blockedUntil > Date.now()) return Math.max(30_000, b.blockedUntil - Date.now());
  const low = ['graphql', 'core'].some((r) => b[r] && b[r].remaining < 500);
  return low ? 120_000 : 30_000;
}

// worktree 会话：切出时的分支（不是提交号、不是 HEAD）当基线候选——「创建拉取请求」开到它上面，而不是一律开到默认分支
function worktreeBase(ctx, cwd) {
  try {
    const wt = listWorktrees(ctx.claudeProjects).find((w) => path.resolve(w.cwd).toLowerCase() === path.resolve(cwd).toLowerCase());
    return wt && wt.base && wt.base !== 'HEAD' && !/^[0-9a-f]{7,40}$/.test(wt.base) ? wt.base : '';
  } catch { return ''; }
}

const viewedAt = new Map();   // key|sid → 最近一次有设备拉这个会话的 PR 状态（PR 卡 / 芯片看得见时 30 秒一次）

/**
 * 会话 PR 状态全量（GET /api/claude/pr、总线 {type:'pr'}、工具 get_status 共用）。
 * viewer = 这次是界面上看得见的卡 / 芯片拉的（记下「有人正看着」，合并后先不自动归档）。
 */
export async function prView(ctx, sid, { refresh = false, viewer = false } = {}) {
  if (!prCapable(ctx)) return { available: false, reason: 'host_only' };
  rememberCtx(ctx);
  if (viewer) viewedAt.set(K(ctx.key, sid), Date.now());
  const where = sessionWhere(ctx, sid);
  const cwd = where && where.path;
  const wtBase = cwd && where.worktree ? worktreeBase(ctx, cwd) : '';
  const [ghs, gi] = await Promise.all([gh.ghStatus(), cwd ? gitInfo(cwd, { fresh: refresh, base: wtBase }) : Promise.resolve({ git: false })]);
  let worked = [];
  try { worked = await bindFromTranscript(ctx, sid, { ghOk: ghs.ok && !ghs.limited, cwd }); } catch {}
  const ownBranch = !!where && (!!where.worktree || worked.includes(gi.branch));
  if (ghs.ok && !ghs.limited && gi.git && gi.remote && gi.branch && !gi.onBase && ownBranch && !liveBindings(slot(ctx, sid, false)).length) await lookupBranch(ctx, sid, gi);
  const s = slot(ctx, sid, false);
  const prs = [];
  let dirty = false;
  for (const b of liveBindings(s)) {
    let v = null, error = '';
    if (ghs.ok) {
      try { v = await readPr(b, { fresh: refresh }); if (syncBinding(b, v)) dirty = true; }
      catch (e) { error = e.code || 'unknown'; }
    } else error = ghs.reason;
    prs.push(composePr(ctx, sid, s, b, v, error));
  }
  if (dirty) save(ctx, sid, s);
  const set = s || {};
  return {
    available: true, sessionId: sid,
    gh: ghs,
    git: gi.git ? {
      git: true, branch: gi.branch, detached: gi.detached, dirty: gi.dirty, unpushed: gi.unpushed, pushed: gi.pushed, onBase: gi.onBase,
      defaultBranch: gi.defaultBranch, base: gi.base || gi.defaultBranch, baseAhead: gi.baseAhead ?? -1,
      github: !!gi.remote, repo: gi.remote ? gi.remote.repo : '', host: gi.remote ? gi.remote.host : '',
      upstream: gi.upstream, ahead: gi.ahead, behind: gi.behind, worktree: !!(where && where.worktree), cwd,
    } : { git: false },
    prs,
    monitor: {
      autoFix: prs.some((p) => p.autoFix), autoFixSet: set.autoFix ?? null, autoFixDefault: !!claudeSetting(ctx, 'autoFixPullRequests'),
      autoArchive: autoArchiveFor(ctx, s), autoArchiveSet: set.autoArchive ?? null, autoArchiveDefault: !!claudeSetting(ctx, 'autoArchiveOnPrClose'),
    },
    fix: s ? { paused: s.fix.paused, lastWakeAt: s.fix.lastWakeAt, streak: s.fix.streak, wakes: s.fix.wakes, lastError: s.fix.lastError } : null,
    pollMs: pollHint(),
  };
}

// 总线推送（同一会话 300ms 内合并成一次）
const pubTimers = new Map();
function publishSoon(ctx, sid, extra = {}) {
  const k = K(ctx.key, sid);
  const prev = pubTimers.get(k);
  if (prev) { clearTimeout(prev.t); Object.assign(extra, prev.extra, extra); }
  const t = setTimeout(() => {
    pubTimers.delete(k);
    prView(ctx, sid).then((view) => busPublish(ctx.key, { type: 'pr', sessionId: sid, view, ...extra })).catch(() => {});
  }, 300);
  if (t.unref) t.unref();
  pubTimers.set(k, { t, extra });
}

// —— 合并前的二次确认（官方 rail Merge 的 checking 阶段 + 陈旧原因表）——
export function staleReason(v, expectHead) {
  if (v.state === 'merged') return { stale: 'merged', error: '这个拉取请求已经合并了。' };
  if (v.state === 'closed') return { stale: 'closed', error: '这个拉取请求已关闭。' };
  if (v.state === 'queued') return { stale: 'queued', error: '这个拉取请求已在合并队列里。' };
  if (v.isDraft) return { stale: 'draft', error: '草稿拉取请求要先标为可审查才能合并。' };
  if (v.autoMerge) return { stale: 'armed', error: '已设置为就绪后自动合并。' };
  if (expectHead && v.headSha !== expectHead) return { stale: 'changed', error: '拉取请求有变动，请先看看改了什么再合并。' };
  if (v.mergeable === 'CONFLICTING' || v.mergeStateStatus === 'DIRTY') return { stale: 'conflict', error: '有合并冲突，先解决再合并。' };
  if (v.mergeStateStatus === 'BEHIND') return { stale: 'behind', error: v.base ? `此分支落后于 ${v.base}，请先更新再合并。` : '此分支落后于基线分支，请先更新再合并。' };
  if (v.mergeStateStatus === 'BLOCKED') return { stale: 'blocked', error: 'GitHub 阻止了这次合并，请查看拉取请求还缺什么。' };
  return null;
}

// GitHub 原生 auto-merge 拒绝开启时，哪些原因可以改由 bridge 代合并：PR 眼下就能合（clean / has_hooks / unstable 状态，
// GitHub 只对「还在等条件」的 PR 开 auto-merge）、基线分支没有保护规则、仓库其实没开 auto-merge。其余（没权限、不允许这种
// 合并方式、PR 状态不对……）是真失败。
export const nativeFallbackOk = (e) => /\b(clean|unstable|has_hooks) status\b|protected branch rules not configured|auto[- ]?merge is not (allowed|enabled)/i.test(String(e && e.message || ''));

// 操作对象：url 指定；不指定就取唯一一个没合并 / 没关闭的绑定
function pickBinding(ctx, sid, url) {
  const live = liveBindings(slot(ctx, sid, false));
  if (url) {
    const ref = gh.parsePrUrl(url);
    const b = ref && live.find((x) => prKeyOf(x) === prKeyOf(ref));
    if (!b) throw err(404, '这个会话没有绑定这个拉取请求');
    return b;
  }
  const open = live.filter((b) => !TERMINAL.has(b.state));
  if (open.length === 1) return open[0];
  if (!live.length) throw err(404, '这个会话还没有绑定拉取请求');
  if (live.length === 1) return live[0];
  throw err(400, '这个会话绑定了多个拉取请求，请指定 url');
}

// 同步基线分支：base 只能是 PR 的 base、worktree 切出时的分支或仓库默认分支
async function syncBase(ctx, sid, { base, abort = false, fromTool = false } = {}) {
  const where = sessionWhere(ctx, sid);
  if (!where) throw err(404, '找不到会话的工作目录');
  if (!fromTool && liveTurn(ctx, sid)) throw err(409, 'Claude 正在工作，请等本轮结束', { code: 'session_running' });
  const cwd = where.path;
  if (abort) { const r = await gitSyncBase(cwd, { abort: true }); forgetGitInfo(cwd); return r; }
  const gi = await gitInfo(cwd, { fresh: true });
  const allowed = new Set();
  const pr = liveBindings(slot(ctx, sid, false)).find((b) => !TERMINAL.has(b.state) && b.base && (!b.head || b.head === gi.branch));
  if (pr) allowed.add(pr.base);
  const wtBase = worktreeBase(ctx, cwd);
  if (wtBase && wtBase !== gi.branch) allowed.add(wtBase);
  if (gi.defaultBranch) allowed.add(gi.defaultBranch);
  const want = base ? String(base) : (pr ? pr.base : [...allowed][0]);
  if (!want) return { kind: 'refused', reason: 'no_base' };
  if (!allowed.has(want)) return { kind: 'refused', reason: 'base_not_allowed', allowedBases: [...allowed] };
  const r = await gitSyncBase(cwd, { base: want });
  forgetGitInfo(cwd);
  if (r.kind === 'merged' || r.kind === 'conflicts') publishSoon(ctx, sid);
  console.log(`[pr] ${sid.slice(0, 8)} sync base ${want}: ${r.kind}${r.reason ? ' (' + r.reason + ')' : ''}`);
  return r;
}

/**
 * 写操作（路由 POST /api/claude/pr 与 MCP 工具共用）。op 见下方 switch。
 * opts.replay：这次请求的身份（存下来给 Auto-fix 唤醒用）；opts.fromTool：Claude 自己在会话里调的；
 * opts.fromCiTurn：调用发生在 Auto-fix 叫醒的那一轮里（这一轮不许 Claude 自己开自动合并）。
 * 返回结果对象；失败抛带 status 的 Error（stale 原因在 e.stale）。
 */
export async function prOp(ctx, sid, op, args = {}, { replay = null, fromTool = false, fromCiTurn = false } = {}) {
  if (!prCapable(ctx)) throw err(403, '拉取请求功能只对这台电脑的主人开放');
  if (!ID_RE.test(String(sid || ''))) throw err(400, 'bad session');
  rememberCtx(ctx);
  const s0 = slot(ctx, sid, false);
  const r0 = cleanReplay(replay);
  if (s0 && r0 && JSON.stringify(r0) !== JSON.stringify(s0.replay)) { s0.replay = r0; save(ctx, sid, s0); }
  switch (op) {
    case 'bind': {
      const ref = gh.parsePrUrl(args.url);
      if (!ref) throw err(400, '不是有效的拉取请求链接（形如 https://github.com/owner/repo/pull/123）');
      const where = sessionWhere(ctx, sid);
      const gi = where ? await gitInfo(where.path) : { git: false };
      // 本检出的远程（origin / upstream……）或这个身份已经在跟踪的仓库；两种拒绝各一句固定文案（前端 tr 按模式翻译，别往占位符里塞中文）
      if (!(await repoTrusted(ctx, where && where.path, ref))) throw err(400, gi.remote ? `这个拉取请求不在本会话仓库（${gi.remote.repo}）里` : '这个会话的仓库没有 GitHub 远程，跟踪不了拉取请求');
      // GitHub 给的规范链接（仓库改名 / 转移后会变）：只认同一台主机上的 PR 链接，其余照用户给的
      try { const v = await readPr(ref, { fresh: true }); const p = gh.parsePrUrl(v && v.url); if (p && p.host === ref.host) Object.assign(ref, p); } catch (e) { throw err(e.code === 'not_found' ? 404 : 502, e.message, { code: e.code }); }
      const r = bindPr(ctx, sid, ref, { source: fromTool ? 'tool' : 'manual', replay, restore: fromTool ? 'tool' : true });
      if (r.outcome === 'dismissed') throw err(409, '用户把这个拉取请求从会话里移出过，要由用户在 PR 卡里重新跟踪');
      return { outcome: r.outcome };
    }
    case 'unbind': {
      const ref = gh.parsePrUrl(args.url) || pickBinding(ctx, sid, '');
      return { ok: unbindPr(ctx, sid, ref, { by: fromTool ? 'tool' : 'user' }) };
    }
    case 'refresh': {
      for (const b of liveBindings(slot(ctx, sid, false))) invalidate(b);
      const where = sessionWhere(ctx, sid);
      if (where) forgetGitInfo(where.path);
      return { ok: true };
    }
    case 'monitor': {
      const s = slot(ctx, sid, true);
      const tri = (v) => (v === true || v === false ? v : null);
      const wasOn = liveBindings(s).some((b) => autoFixFor(ctx, sid, s, b));
      if ('autoFix' in args) {
        s.autoFix = tri(args.autoFix);
        // 明确打开（含 PR 卡上「继续」暂停了的自动修复）：清掉暂停、连续计数与失败退避；成为这些 PR 的唯一主人。
        // 因「今天次数到上限」暂停的，用户点恢复 = 今天再给一轮额度（不清 dayCount 的话下一个事件又立刻停回 daily）
        if (args.autoFix === true) {
          if (s.fix.paused === 'daily') s.fix.dayCount = 0;
          Object.assign(s.fix, { paused: '', streak: 0, failN: 0, retryAt: 0 });
          s.fixAt = Date.now();
          revokeAutoFixFromPeers(ctx, sid, s);
        }
      }
      if ('autoArchive' in args) { s.autoArchive = tri(args.autoArchive); s.archivedFor = ''; }
      if (r0) s.replay = r0;
      s.at = Date.now();
      save(ctx, sid, s);
      kick(ctx, sid);
      publishSoon(ctx, sid);
      // 用户在 PR 卡上刚打开、会话正跑着：插一句说明（官方首次开启通知），免得它这一轮还自己去轮询 CI。
      // 没在跑的会话不用插——下一轮的系统提示里带着「自动修复已开」那段（autoFixNudge）。
      if (args.autoFix === true && !wasOn && !fromTool && liveBindings(s).some((b) => autoFixFor(ctx, sid, s, b))) {
        const g = findGenBySession(ctx.key, sid);
        if (g && !g.done && typeof g.steer === 'function') { try { g.steer({ message: AUTOFIX_ON_TEXT, attachments: [] }); } catch {} }
      }
      return { ok: true, autoFix: s.autoFix, autoArchive: s.autoArchive };
    }
    case 'mergeCheck':
    case 'merge': {
      const b = pickBinding(ctx, sid, args.url);
      const v = await readPr(b, { fresh: true });
      syncBinding(b, v);
      const st = staleReason(v, op === 'merge' ? args.expectHead : '');
      if (st) throw err(409, st.error, st);
      if (op === 'mergeCheck') return { ok: true, number: v.number, headSha: v.headSha, methods: ['squash', 'merge', 'rebase'].filter((x) => v.repoInfo[x]) };
      const r = await gh.mergePr(v, { method: args.method, sha: v.headSha });
      invalidate(b);
      console.log(`[pr] ${sid.slice(0, 8)} ${r.queued ? 'queued' : 'merged'} ${b.repo}#${b.number} (${gh.normMethod(args.method)})`);
      publishSoon(ctx, sid);
      return r;
    }
    case 'ready':
    case 'draft': {
      const b = pickBinding(ctx, sid, args.url);
      const v = await readPr(b, { fresh: true });
      if (op === 'ready' ? !v.isDraft : v.isDraft) return { ok: true, unchanged: true };
      if (TERMINAL.has(v.state)) throw err(409, '拉取请求已经合并或关闭');
      if (op === 'ready') await gh.markReady(v); else await gh.convertToDraft(v);
      invalidate(b);
      publishSoon(ctx, sid);
      return { ok: true };
    }
    case 'autoMerge': {
      const b = pickBinding(ctx, sid, args.url);
      const s = slot(ctx, sid, true);
      const k = prKeyOf(b);
      const v = await readPr(b, { fresh: true });
      // 合并方式：没指定就取仓库允许的第一种（仓库禁了 squash 时别硬用 squash，代合并会一直被 GitHub 拒）
      const methods = ['squash', 'merge', 'rebase'].filter((x) => v.repoInfo[x]);
      const method = args.method ? gh.normMethod(args.method) : (methods[0] || 'squash');
      if (!args.enabled) {
        if (v.autoMerge && v.autoMerge.by === 'github') await gh.disableAutoMerge(v);
        delete s.merge[k];
      } else {
        if (TERMINAL.has(v.state)) throw err(409, '拉取请求已经合并或关闭');
        if (v.isDraft) throw err(409, '草稿拉取请求不能自动合并。');
        if (b.source === 'inherited') throw err(409, '自动合并只能用在这个会话做过的拉取请求上。');
        // Auto-fix 叫醒的那一轮里不许 Claude 自己开：那一轮的输入里有第三方写的 GitHub 评论，开了就可能在没人确认的情况下合进基线
        if (fromTool && fromCiTurn) throw err(403, '自动修复发起的这一轮里不能开启自动合并；需要的话请用户在拉取请求卡上开。');
        if (methods.length && !methods.includes(method)) throw err(409, '这个仓库不允许这种合并方式');
        if (v.repoInfo.autoMergeAllowed) {
          try { await gh.enableAutoMerge(v, method); delete s.merge[k]; }
          catch (e) {
            // GitHub 原生 auto-merge 不收，分原因：PR 已经可以直接合并（clean）/ 基线分支没有保护规则 / 仓库没开……
            // → 改由 bridge 代合并；权限不够、不允许这种方式之类是真失败，照实报，不静默回落（回落了也合不进去）
            if (!nativeFallbackOk(e)) throw err(502, e.message || '无法开启自动合并', { code: typeof e.code === 'string' ? e.code : 'graphql' });
            console.log(`[pr] native auto-merge refused for ${b.repo}#${b.number}: ${e.message} — bridge will merge when ready`);
            s.merge[k] = { method, by: 'bridge', at: Date.now() };
          }
        } else s.merge[k] = { method, by: 'bridge', at: Date.now() };
      }
      save(ctx, sid, s);
      invalidate(b);
      kick(ctx, sid);
      publishSoon(ctx, sid);
      return { ok: true, by: args.enabled ? (s.merge[k] ? 'bridge' : 'github') : null };
    }
    case 'rerun': {
      const b = pickBinding(ctx, sid, args.url);
      const v = await readPr(b, { fresh: true });
      const r = await gh.rerunFailedChecks(v);
      invalidate(b);
      publishSoon(ctx, sid);
      return r;
    }
    case 'syncBase':
      return syncBase(ctx, sid, { base: args.base, abort: !!args.abort, fromTool });
    default:
      throw err(400, 'unknown op');
  }
}

// —— 一轮的开始（claude.mjs 调）：真人发话 → 清零连续唤醒计数、刷新重放身份 ——
// sid 为空 = 新会话（可能接管预热好的 CLI）：只记下这个身份最近的重放身份，首轮流里绑上 PR 时兜底用。
export function notePrTurnStart(ctx, sid, { auto = false, replay = null } = {}) {
  if (!prCapable(ctx) || auto) return;
  ctx = identityCtx(ctx);
  const r = cleanReplay(replay);
  if (r) lastReplay.set(ctx.key, r);
  if (!sid) return;
  const s = slot(ctx, sid, false);
  if (!s) return;
  let ch = false;
  if (s.fix.streak) { s.fix.streak = 0; ch = true; }
  if (s.fix.paused === 'streak') { s.fix.paused = ''; ch = true; }
  if (r && JSON.stringify(r) !== JSON.stringify(s.replay)) { s.replay = r; ch = true; }
  if (ch) save(ctx, sid, s);
}

/** 系统提示里「自动修复已开」那一段（官方 jv）：这个会话有 PR 开着 Auto-fix 才给。claude.mjs 拼 appendText 时调。 */
export function autoFixActive(ctx, sid) {
  if (!prCapable(ctx) || !sid) return [];
  ctx = identityCtx(ctx);
  const s = slot(ctx, sid, false);
  return liveBindings(s).filter((b) => autoFixFor(ctx, sid, s, b)).map((b) => `${b.repo}#${b.number}`);
}

// —— 流里认 PR（claude.mjs 每条 SDK 消息过一遍）——
// ① CLI 2.1.299 的 system/code_change_published（gh pr create、推送到有 PR 的分支、gh pr merge/close… 都会发）；
// ② 助手正文里的 <pr-created>URL</pr-created>（Create PR 提示词约定的回报方式）；
// ③ Bash / PowerShell 跑了 gh pr create → 从它的输出里取最后一个 PR 链接。
const PR_CREATED_RE = /<pr-created>\s*(https?:\/\/\S+?)\s*<\/pr-created>/gi;
const GH_CREATE_RE = /\bgh\s+pr\s+create\b/;
const flat = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && typeof x.text === 'string' ? x.text : '')).join('\n') : '');

export function makePrSniffer(ctx, getSid, replay) {
  if (!prCapable(ctx)) return null;
  const cwd = ctx.cwd;   // chat 路由覆写过的项目 / worktree 目录（identityCtx 之后就是身份根了）
  ctx = identityCtx(ctx);
  const creating = new Set();   // 跑 gh pr create 的 tool_use id
  // 这些链接都没经过核实（CLI 的 schema 里也写着 Unverified）：仓库不是本检出的远程、这个身份也没在跟踪 → 不绑
  const bind = (ref, source, own) => {
    const sid = getSid();
    if (!sid || !ref) return;
    repoTrusted(ctx, cwd, ref).then((ok) => {
      if (ok) bindPr(ctx, sid, ref, { source, own, replay });
      else console.log(`[pr] ${sid.slice(0, 8)} not binding ${ref.repo}#${ref.number} (${source}): not a remote of this checkout`);
    }).catch(() => {});
  };
  return (msg) => {
    try {
      if (!msg || msg.parent_tool_use_id) return;
      if (msg.type === 'system' && msg.subtype === 'code_change_published') {
        if (!/^github/.test(String(msg.provider || ''))) return;
        const ref = gh.parsePrUrl(msg.url);
        if (!ref) return;
        const action = String(msg.action || '');
        if (['merged', 'closed', 'reopened', 'ready', 'draft', 'pushed', 'edited', 'auto-merge-enabled', 'auto-merge-disabled'].includes(action)) invalidate(ref);
        // 已经合并 / 关闭的 PR 不新绑（checkout 别人的 PR、gh pr view 这类也会报，只认会改动它的动作）
        if (['created', 'pushed', 'ready', 'draft', 'edited', 'auto-merge-enabled'].includes(action)) bind(ref, 'announce', action === 'created');
        else if (getSid()) publishSoon(ctx, getSid());
      } else if (msg.type === 'assistant') {
        const parts = (msg.message && Array.isArray(msg.message.content)) ? msg.message.content : [];
        for (const b of parts) {
          if (!b) continue;
          if (b.type === 'tool_use' && (b.name === 'Bash' || b.name === 'PowerShell') && GH_CREATE_RE.test(String(b.input && b.input.command || ''))) creating.add(b.id);
          if (b.type === 'text' && typeof b.text === 'string' && b.text.includes('<pr-created>')) {
            for (const m of b.text.matchAll(PR_CREATED_RE)) bind(gh.parsePrUrl(m[1]), 'tag', true);
          }
        }
      } else if (msg.type === 'user') {
        const parts = (msg.message && Array.isArray(msg.message.content)) ? msg.message.content : [];
        for (const b of parts) {
          if (!b || b.type !== 'tool_result' || !creating.has(b.tool_use_id)) continue;
          creating.delete(b.tool_use_id);
          if (b.is_error) continue;
          const urls = gh.findPrUrls(flat(b.content));
          if (urls.length) bind(urls[urls.length - 1], 'gh', true);
        }
      }
    } catch (e) { console.log('[pr] sniff failed:', e && e.message); }
  };
}

// —— 后台扫描：Auto-fix / bridge 代合并 / 合并或关闭后自动归档 ——
const ctxs = new Map();       // key → ctx（扫描要用的身份）
const nextAt = new Map();     // key|sid → 下次检查时刻
const heldLogged = new Map(); // key|sid → 上次打日志的「没叫醒」原因（同一个原因只打一次）
let timer = null;
let sweeping = false;
// 后台扫描只在正式实例开（server.mjs 在 PRODUCTION / BRIDGE_PR_MONITOR=1 时调 initPrMonitor）。调试台、桌面壳内嵌实例
// 和正式服共用同一个数据根：两边都扫，同一个 CI 失败会在两个进程里各 resume 一次同一个会话（转录两个写入者），
// 代合并也会被打两次。非正式实例里 PR 卡照样能看、能手动操作，只是不在后台盯。
let background = false;

function rememberCtx(ctx) {
  if (!prCapable(ctx) || ctxs.has(ctx.key)) return;
  // 存一份不带项目覆写的身份（chat 路由会把 cwd 覆写成项目目录，这里只要身份本身）
  ctxs.set(ctx.key, identityCtx(ctx));
  ensureTimer();
}
function ensureTimer() {
  if (timer || !background) return;
  timer = setInterval(() => { sweep().catch((e) => console.log('[pr] sweep failed:', e && e.message)); }, TICK_MS);
  if (timer.unref) timer.unref();
}
function kick(ctx, sid) { nextAt.set(K(ctx.key, sid), 0); }

// 已归档的会话（bridge 记的：手动 / 不活跃 / PR 关闭后）：官方归档即停掉会话、不再盯它的 PR——不叫醒（Auto-fix）、
// 不再做关闭后自动归档的检查。用户批准过的 bridge 代合并照做（那是对 GitHub 的授权，不叫醒会话）。取消归档后照常恢复。
const archivedNow = (ctx, sid) => { try { return localArchiveFlag(ctx, sid) === true; } catch { return false; } };

function watched(ctx, sid, s) {
  const live = liveBindings(s);
  if (!live.length) return false;
  if (archivedNow(ctx, sid)) return live.some((b) => !TERMINAL.has(b.state) && !!s.merge[prKeyOf(b)]);
  const archive = autoArchiveFor(ctx, s);
  return live.some((b) => {
    if (b.state === 'merged') return archive && archiveRelevant(b) && s.archivedFor !== archiveKey(s);
    if (b.state === 'closed') return archive && archiveRelevant(b) && (s.archivedFor !== archiveKey(s) || Date.now() - b.checkedAt > CLOSED_RECHECK_MS);
    return autoFixFor(ctx, sid, s, b) || !!s.merge[prKeyOf(b)] || (archive && archiveRelevant(b));
  });
}
const archiveKey = (s) => liveBindings(s).filter(archiveRelevant).map(prKeyOf).sort().join(',');

async function sweep() {
  if (sweeping) return;
  sweeping = true;
  try {
    for (const ctx of ctxs.values()) {
      const d = load(ctx);
      const interval = busSubscribers(ctx.key) > 0 ? SWEEP_ACTIVE_MS : SWEEP_IDLE_MS;
      for (const [sid, s] of Object.entries(d.sessions)) {
        if (!watched(ctx, sid, s)) continue;
        const k = K(ctx.key, sid);
        if ((nextAt.get(k) || 0) > Date.now()) continue;
        nextAt.set(k, Date.now() + interval);
        try { await checkSession(ctx, sid, s); } catch (e) { console.log(`[pr] ${sid.slice(0, 8)} check failed:`, e && e.message); }
      }
    }
  } finally { sweeping = false; }
}

// 会话的转录还在不在（被删掉 / 找不到了就不再为它读 GitHub、更不叫醒——resume 一个不存在的会话只会白起一个 CLI）
const transcriptGone = (ctx, sid) => !claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, sid);

async function checkSession(ctx, sid, s) {
  if (transcriptGone(ctx, sid)) { logHeld(ctx, sid, 'gone'); return; }
  const st = await gh.ghStatus();
  if (!st.ok || st.limited) return;
  let changed = false, dirty = false;
  const views = [];
  for (const b of liveBindings(s)) {
    if (b.state === 'merged') continue;
    if (b.retryAt && Date.now() < b.retryAt) continue;
    let v;
    try { v = await readPr(b); b.failN = 0; b.retryAt = 0; }
    catch (e) {
      // 失败退避（官方 min(2^n,16) 个 sweep）
      b.failN = (b.failN || 0) + 1;
      b.retryAt = Date.now() + Math.min(2 ** b.failN, 16) * SWEEP_ACTIVE_MS;
      continue;
    }
    if (syncBinding(b, v)) changed = true;
    views.push([b, v]);
  }
  for (const [b, v] of views) if (await maybeBridgeMerge(ctx, sid, s, b, v)) dirty = true;
  const archived = archivedNow(ctx, sid);   // 已归档：只做代合并，不归档、不叫醒（见 watched 头注）
  if (!archived && await maybeAutoArchive(ctx, sid, s)) dirty = true;
  for (const [b, v] of views) {
    if (archived) break;
    if (!autoFixFor(ctx, sid, s, b)) continue;
    const r = await maybeAutoFix(ctx, sid, s, b, v);
    if (r.dirty) dirty = true;
    if (r.woke) break;   // 一次扫描一个会话最多叫醒一次
  }
  if (changed || dirty) save(ctx, sid, s);
  if (changed) publishSoon(ctx, sid);
}

// 仓库没开 GitHub 原生 auto-merge：检查全过、可合并、没被要求修改 → bridge 代为合并（带 sha，只合见过的提交）。
// 「全过」要真有检查：新 head 刚推上去时 GitHub 还没给它挂检查（statusCheckRollup 为空，0 个），这时合就把没跑过 CI 的
// 提交合进了基线。仓库确实没有 CI 的，要同一个 head 隔 3 分钟两次扫描都还是 0 个检查才合。
async function maybeBridgeMerge(ctx, sid, s, b, v) {
  const k = prKeyOf(b);
  const m = s.merge[k];
  if (!m) return false;
  if (TERMINAL.has(v.state)) { delete s.merge[k]; return true; }
  if (v.state !== 'open' || v.isDraft) return false;
  if (!v.checks || v.checks.failing || v.checks.pending) { if (m.noChecks) { delete m.noChecks; return true; } return false; }
  if (v.mergeable !== 'MERGEABLE' || !['CLEAN', 'HAS_HOOKS'].includes(v.mergeStateStatus)) return false;
  if (v.reviewDecision === 'CHANGES_REQUESTED' || v.reviewDecision === 'REVIEW_REQUIRED') return false;
  if (m.failedHead && m.failedHead === v.headSha) return false;
  if (!v.checks.total) {
    if (!m.noChecks || m.noChecks.head !== v.headSha) { m.noChecks = { head: v.headSha, at: Date.now() }; return true; }
    if (Date.now() - m.noChecks.at < NO_CHECKS_CONFIRM_MS) return false;
  }
  try {
    const r = await gh.mergePr(v, { method: m.method, sha: v.headSha });
    delete s.merge[k];
    invalidate(b);
    console.log(`[pr] ${sid.slice(0, 8)} auto-merged ${b.repo}#${b.number} by bridge (${m.method})`);
    publishSoon(ctx, sid, { note: r.queued ? 'queued' : 'merged', number: b.number });
  } catch (e) {
    m.error = e.message; m.failedHead = v.headSha;
    console.log(`[pr] ${sid.slice(0, 8)} bridge auto-merge failed for ${b.repo}#${b.number}: ${e.message}`);
    publishSoon(ctx, sid);
  }
  return true;
}

// 会话眼下「有人在用」：在跑 / 在等回答 / 有排队消息 / 等着限额续跑（自动唤醒与自动归档都要躲开）
function sessionBusy(ctx, sid) {
  if (liveTurn(ctx, sid)) return 'busy';
  if (sessionQuestions.has(sid)) return 'question';
  if (listQueue(ctx.key, sid).length) return 'queued';
  const lr = getLimitResume(ctx.key, sid);
  if (lr && (lr.armed || lr.firing)) return 'limit';
  return '';
}

// 同一个工作目录里别的会话有活轮（派生的子会话与父会话共用一个 worktree）：主机侧合并基线前要躲开
function cwdBusyOther(ctx, sid, cwd) {
  const want = path.resolve(cwd).toLowerCase();
  for (const g of getLiveGens(ctx.key)) {
    if (!g || !g.sessionId || g.sessionId === sid) continue;
    const w = sessionWhere(ctx, g.sessionId);
    if (w && path.resolve(w.path).toLowerCase() === want) return true;
  }
  return false;
}

// 自动归档的豁免（与「归档不活跃的会话」同一口径，再加官方 on_screen）：返回原因或 ''。
// pinned 是定局（这一组 PR 不再归档）；其余等下一次扫描再看。
function archiveHold(ctx, sid) {
  try { if ((getLibrary(ctx).stars || []).includes(sid)) return 'pinned'; } catch {}
  const busy = sessionBusy(ctx, sid);
  if (busy) return busy;
  if (Date.now() - (viewedAt.get(K(ctx.key, sid)) || 0) < VIEW_HOLD_MS) return 'on_screen';
  return '';
}

// 本会话自己的 PR（archiveRelevant）全部合并或关闭 → 自动归档（只做一次；在用的会话等下一次扫描，收藏的不归档）
async function maybeAutoArchive(ctx, sid, s) {
  if (!autoArchiveFor(ctx, s)) return false;
  const live = liveBindings(s).filter(archiveRelevant);
  if (!live.length || !live.every((b) => TERMINAL.has(b.state))) return false;
  const key = archiveKey(s);
  if (s.archivedFor === key) return false;
  const hold = archiveHold(ctx, sid);
  if (hold === 'pinned') { s.archivedFor = key; return true; }
  if (hold) return false;
  s.archivedFor = key;
  try {
    const { changed, archive } = setArchived(ctx, [sid], true, { reason: 'pr_closed' });
    if (changed) {
      console.log(`[pr] ${sid.slice(0, 8)} archived (pull request ${live.every((b) => b.state === 'merged') ? 'merged' : 'closed'})`);
      busPublish(ctx.key, { type: 'archive', archive });
    }
  } catch (e) { console.log('[pr] auto-archive failed:', e && e.message); }
  return true;
}

// 叫醒前的闸门：返回原因（不叫醒）或 ''
function wakeGate(ctx, sid, s, v, del) {
  const f = s.fix;
  if (f.day !== today()) { f.day = today(); f.dayCount = 0; if (f.paused === 'daily') f.paused = ''; }
  if (f.paused) return 'paused';
  if (f.streak >= MAX_STREAK) { f.paused = 'streak'; return 'paused'; }
  if (f.dayCount >= MAX_WAKES_PER_DAY) { f.paused = 'daily'; return 'paused'; }
  if (!s.replay) return 'no_identity';
  if (transcriptGone(ctx, sid)) return 'gone';
  // 会话正开在官方 Desktop / 终端的 CLI 里：chat 路由会以 held_elsewhere 拒绝 resume（两边同写一份转录会分叉），先别去敲
  if (findExternalHolder(sid)) return 'held_elsewhere';
  const busy = sessionBusy(ctx, sid);
  if (busy) return busy;
  if (f.retryAt && Date.now() < f.retryAt) return 'backoff';
  if (Date.now() - f.lastWakeAt < MIN_WAKE_GAP_MS) return 'gap';
  if (del.heads && del.heads.head === v.headSha && del.heads.n >= MAX_WAKES_PER_HEAD) return 'head_cap';
  return '';
}
// 「没叫醒」的原因打日志：同一个会话同一个原因只打一次（no_identity / gone 之类每分钟一行没有意义）；叫醒成功后清掉
const QUIET_GATES = new Set(['busy', 'gap', 'paused', 'backoff']);
function logHeld(ctx, sid, gate, b) {
  const k = K(ctx.key, sid);
  if (heldLogged.get(k) === gate) return;
  heldLogged.set(k, gate);
  if (heldLogged.size > 1000) heldLogged.delete(heldLogged.keys().next().value);
  if (!QUIET_GATES.has(gate)) console.log(`[pr] ${sid.slice(0, 8)} auto-fix held (${gate})${b ? ` for ${b.repo}#${b.number}` : ''}`);
}

function wakeBody(ctx, sid, replay) {
  const p = chatPrefsFor(ctx, sid) || {};
  const b = (replay && replay.body) || {};
  return {
    agent: 'claude', client: b.client === 'apk' ? 'apk' : 'web',
    ...(p.model ? { model: p.model } : {}), ...(p.effort ? { effort: p.effort } : {}), ...(p.fast ? { fast: true } : {}),
    ...(b.suggest === true ? { suggest: true } : {}), ...(typeof b.compactFrac === 'number' ? { compactFrac: b.compactFrac } : {}),
    autoRetry: true,
  };
}

// 发出去：重放一条 /api/chat（身份 = 绑定时落盘的那份；family origin 'ci' 标记这是自动修复轮）。
// noPreempt：会话这时已经有一轮在跑（闸门放行之后用户又发了话）就回 busy、不顶掉它（claude.mjs runClaudeChat），下次扫描再来。
async function deliver(ctx, sid, s, text) {
  let r;
  try {
    r = await replayChat({
      headers: s.replay.headers || {}, url: s.replay.url || '/api/chat',
      body: { ...wakeBody(ctx, sid, s.replay), sessionId: sid, message: text, attachments: [] },
      family: { origin: { kind: 'ci', from: [] }, noPreempt: true },
    });
  } catch (e) { return { ok: false, reason: String(e && e.message || e) }; }
  if (!r || !r.status || r.status >= 400) {
    let reason = `状态 ${r && r.status || '未知'}`;
    try { const j = JSON.parse((r && r.detail) || '{}'); if (j.error) reason = j.error; } catch {}
    return { ok: false, reason };
  }
  // SSE 头 200 之后也可能紧跟一个错误帧就收了（并发满、会话被占……）：等它真的开跑（最多 8 秒）
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (liveTurn(ctx, sid)) return { ok: true };
    if (r.res && r.res.writableEnded) {
      const txt = (r.res.chunks || []).join('');
      if (/"type":"error"/.test(txt)) {
        const m = txt.match(/"message":"([^"]{1,300})"/);
        return { ok: false, busy: /"kind":"busy"/.test(txt), reason: m ? m[1] : '没能开跑' };
      }
      return { ok: true };   // 秒完（极短的一轮）
    }
    await new Promise((res) => setTimeout(res, 120));
  }
  return { ok: true };
}

const eligibleAuthor = (c, viewer) => c.author && c.author.login !== viewer && (c.author.bot || /^(OWNER|MEMBER|COLLABORATOR)$/.test(c.assoc));

async function maybeAutoFix(ctx, sid, s, b, v) {
  if (v.state !== 'open' && v.state !== 'draft') return { woke: false };
  const k = prKeyOf(b);
  const del = s.fix.delivered[k] || (s.fix.delivered[k] = { failures: [], conflict: null, seen: [], baseline: false, heads: null, held: null });
  let dirty = false;
  let pack = null;
  try { pack = await gh.fetchPrComments(b); } catch {}
  // 第一次看这个 PR：已有评论算看过（开 Auto-fix 之前的讨论不倒灌进会话）；CI 失败与冲突是当前状态，照报
  if (pack && !del.baseline) { del.seen = pack.comments.map((c) => c.dedup).slice(-MAX_SEEN); del.baseline = true; dirty = true; }

  const failing = v.checkList.filter((c) => c.bucket === 'fail');
  let failures = failing.filter((c) => !del.failures.includes(`${v.headSha}:${c.name}`));
  if (failures.length) {
    const sibling = v.checkList.some((c) => c.bucket === 'pending' && failures.some((f) => (f.workflow && f.workflow === c.workflow) || (f.app && f.app === c.app)));
    if (sibling) {
      if (!del.held || del.held.head !== v.headSha) { del.held = { head: v.headSha, at: Date.now() }; dirty = true; }
      if (Date.now() - del.held.at < CI_HOLD_MS) failures = [];
    }
  }

  let conflict = null;
  const conflicting = v.mergeable === 'CONFLICTING' || v.mergeStateStatus === 'DIRTY';
  if (!conflicting) { if (del.conflict && v.mergeable === 'MERGEABLE') { del.conflict = null; dirty = true; } }
  else if (!del.conflict) conflict = { kind: 'new' };
  else if (del.conflict.head !== v.headSha) conflict = { kind: 'persisted' };
  else if ((del.conflict.reminders || 0) < CONFLICT_REMINDERS && Date.now() - del.conflict.at >= CONFLICT_REMIND_MS * 2 ** (del.conflict.reminders || 0)) {
    conflict = { kind: 'reminder', sinceMs: Date.now() - del.conflict.firstAt };
  }

  let comments = [], overflow = 0;
  if (pack) {
    const fresh = pack.comments.filter((c) => !del.seen.includes(c.dedup) && eligibleAuthor(c, pack.viewer));
    comments = fresh.slice(0, MAX_COMMENTS);
    overflow = fresh.length - comments.length;
  }
  if (!failures.length && !conflict && !comments.length) return { woke: false, dirty };

  const pausedBefore = s.fix.paused;
  const gate = wakeGate(ctx, sid, s, v, del);
  if (gate) {
    logHeld(ctx, sid, gate, b);
    if (s.fix.paused !== pausedBefore) { console.log(`[pr] ${sid.slice(0, 8)} auto-fix paused (${s.fix.paused})`); publishSoon(ctx, sid); return { woke: false, dirty: true }; }
    return { woke: false, dirty };
  }

  // 冲突：先在主机侧把基线合进会话的工作区——只对 bridge 自己建的 worktree 会话、且它就在 PR 的 head 分支上时做
  //（官方 sync 也只碰 app 建的 worktree）。主检出目录是用户自己的工作区（可能正开着编辑器），留给 Claude 自己 fetch + merge。
  // fetch 可能要几十秒：真要 merge 前再看一眼会话有没有被人接着用了，用了就收手、等下次扫描。
  // 同一个 worktree 里别的会话（派生的子会话和父会话共用一个检出）正在跑也一样收手——别往它脚下塞一个进行中的合并。
  let host = null, cwd = '';
  if (conflict && v.base) {
    const where = sessionWhere(ctx, sid);
    cwd = where && where.worktree ? where.path : '';
    if (cwd) {
      const gi = await gitInfo(cwd, { fresh: true });
      const inUse = () => (sessionBusy(ctx, sid) || cwdBusyOther(ctx, sid, cwd) ? 'session_running' : '');
      if (gi.branch && gi.branch === v.head) host = inUse() ? { kind: 'refused', reason: 'session_running' } : await gitSyncBase(cwd, { base: v.base, beforeMerge: inUse });
      forgetGitInfo(cwd);
      if (host && host.kind === 'refused' && host.reason === 'session_running') { logHeld(ctx, sid, 'busy', b); return { woke: false, dirty }; }
    }
  }
  const undoHost = async () => { if (host && host.kind === 'conflicts' && cwd) { await gitSyncBase(cwd, { abort: true }); forgetGitInfo(cwd); } };
  // 发之前再过一遍「有人在用」：闸门之后到这里可能隔了一次 fetch，用户这期间开了新一轮就别插进去
  const late = sessionBusy(ctx, sid);
  if (late) { await undoHost(); logHeld(ctx, sid, late, b); return { woke: false, dirty }; }
  const text = composeCiEvent({ pr: v, failures, conflict, host, comments, overflow, attribution: claudeSetting(ctx, 'attribution') !== 'none' });
  const r = await deliver(ctx, sid, s, text);
  if (!r.ok) {
    await undoHost();
    if (r.busy) { logHeld(ctx, sid, 'busy', b); return { woke: false, dirty }; }   // 刚好撞上用户开的新一轮：下次扫描再来，不算失败
    // 没送出去（身份失效 401、会话被 Desktop 占着 409……）：指数退避，别每分钟起一个注定失败的 CLI；
    // 也计入每天的上限（冲突路径每试一次都要在 worktree 里 fetch + merge + abort 一遍，不能一天试几十次）
    s.fix.failN = (s.fix.failN || 0) + 1;
    s.fix.retryAt = Date.now() + Math.min(2 ** s.fix.failN, WAKE_RETRY_MAX) * 60_000;
    s.fix.dayCount += 1;
    s.fix.lastError = r.reason;
    console.log(`[pr] ${sid.slice(0, 8)} auto-fix wake failed (${s.fix.failN}): ${r.reason}`);
    return { woke: false, dirty: true };
  }
  heldLogged.delete(K(ctx.key, sid));
  s.fix.failN = 0; s.fix.retryAt = 0;
  const now = Date.now();
  del.failures = [...new Set([...del.failures, ...failures.map((f) => `${v.headSha}:${f.name}`)])].slice(-200);
  if (conflict) {
    if (conflict.kind === 'new' || !del.conflict) del.conflict = { head: v.headSha, firstAt: now, at: now, reminders: 0 };
    else if (conflict.kind === 'persisted') del.conflict = { ...del.conflict, head: v.headSha, at: now, reminders: 0 };
    else del.conflict = { ...del.conflict, at: now, reminders: (del.conflict.reminders || 0) + 1 };
  }
  if (comments.length) del.seen = [...del.seen, ...comments.map((c) => c.dedup)].slice(-MAX_SEEN);
  del.heads = del.heads && del.heads.head === v.headSha ? { head: v.headSha, n: del.heads.n + 1 } : { head: v.headSha, n: 1 };
  Object.assign(s.fix, { streak: s.fix.streak + 1, lastWakeAt: now, dayCount: s.fix.dayCount + 1, wakes: s.fix.wakes + 1, lastError: '' });
  const kinds = [failures.length && 'ci', conflict && 'conflict', comments.length && 'comments'].filter(Boolean);
  console.log(`[pr] ${sid.slice(0, 8)} auto-fix woke the session for ${b.repo}#${b.number} (${kinds.join('+')})`);
  publishSoon(ctx, sid, { wake: { at: now, kinds } });
  return { woke: true, dirty: true };
}

/**
 * 服务启动（只在正式实例调，server.mjs）：打开后台扫描，主机身份的台账载入，有要盯的会话就排上（首次扫描在 15 秒后）。
 * 别的身份在第一次用到 PR 功能时（rememberCtx）加入扫描。
 */
export async function initPrMonitor(ctx) {
  background = true;
  try {
    if (!ctx) { const { contextFor } = await import('./identity.mjs'); ctx = contextFor({ kind: 'admin' }); }
    if (!prCapable(ctx)) { ensureTimer(); return; }
    const d = load(ctx);
    const n = Object.entries(d.sessions).filter(([sid, s]) => watched(ctx, sid, s)).length;
    rememberCtx(ctx);
    ensureTimer();
    if (n) console.log(`[pr] watching ${n} session(s) with pull requests`);
  } catch (e) { console.log('[pr] init failed:', e && e.message); }
}

// 插件停用（设置 › 功能扩展 关掉「拉取请求」）：停掉后台扫描。台账不动，再打开照常接着盯。
export function stopPrMonitor() {
  if (timer) { clearInterval(timer); timer = null; }
  background = false;
}

// —— 单测用 ——
export async function _sweepForTest(ctx, sid) { rememberCtx(ctx); const s = slot(ctx, sid, false); if (s) await checkSession(ctx, sid, s); return slot(ctx, sid, false); }
export function _resetPrMonitor() {
  stores.clear(); prCache.clear(); prInflight.clear(); nextAt.clear(); ctxs.clear(); branchLookups.clear(); linkScans.clear(); linkScanning.clear();
  viewedAt.clear(); heldLogged.clear(); lastReplay.clear(); transcriptSkip.clear();
  for (const p of pubTimers.values()) clearTimeout(p.t);
  pubTimers.clear();
  if (timer) { clearInterval(timer); timer = null; }
  background = false;
}
export const _backgroundOn = () => background && !!timer;
export const _forgetViews = () => viewedAt.clear();
export const _slot = (ctx, sid) => slot(ctx, sid, false);
export const _limits = { MAX_STREAK, MAX_WAKES_PER_HEAD, MAX_WAKES_PER_DAY, MIN_WAKE_GAP_MS, CI_HOLD_MS, NO_CHECKS_CONFIRM_MS, VIEW_HOLD_MS };
