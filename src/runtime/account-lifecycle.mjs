// 账号生命周期（开源路线 S2-4）：删号 / 停用 / 降档 / 退出登录时，把这个账号在服务器上「还活着的东西」一并收掉。
//
// 以前删号只删 users.json 里的一行：目录、定时任务、用量原样留着，owner 键又是 'u:<名字>'，
// 同名的人重新注册就整个接手——文件、对话、定时任务。现在：
//   · 账号有不可变 id（users.mjs「账号 id」），同名重新注册拿到全新的 id 和目录，什么都继承不到；
//   · 删号（deleteAccount）：先让它登不上（账号行与全部登录会话），再停掉在跑的轮与停放着的 CLI、
//     关它铸的聊天快照、清掉它用过的邀请记录、用量账本与管理员可见性记录，
//     等他在线的页面断开总线（waitBusDrained，见那里的说明），最后按选择处理数据：
//       purge   连目录一起删（默认，控制台删除对话框默认勾选；异步删，不卡事件循环）；
//       archive 整个目录挪进 <usersRoot>/_archive/<id>-<时间>/（附 account.json：名字、删除时间、用量），管理员能找回；
//     还有页面没断开（半死的连接）就先不动目录，记成 'pending'，后台等断开再处理（finishPendingData）；
//     id 记进 _system/retired-accounts.json，永不复用；
//   · 停用（setAccountDisabled）：登录立即失效（getSession 本就不认停用账号）、
//     在跑的轮与停放的 CLI 中止、他铸的聊天快照关停（快照是一次性的，不随启用恢复）；启用即恢复登录；
//   · 降为普通（setAccountTier）：收回命令行当场生效——在跑的轮、侧栏终端、停放的 CLI 一并收掉。
//
// 别的模块要在账号结束时收自己的东西（dimensio 租户进程、终端池、分享链接……）：订阅
// accountEvents 的 'ended'（{ id, key, name, reason: 'deleted' | 'disabled' }）；降为普通另发 'downgraded'（{ id, key, name }）。
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, renameSync, writeFileSync, readFileSync } from 'node:fs';
import { readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import * as users from '../users.mjs';
import { NATIVE_ROOT, ROOT, userRoot } from '../config/index.mjs';
import { ownerKey } from './principal.mjs';
import { getLiveGens } from './gen.mjs';
import { busPublish, busSubscribers, busDropKey } from './bus.mjs';
import { dropAccessOf } from './admin-access.mjs';

export const accountEvents = new EventEmitter();
accountEvents.setMaxListeners(50);
const emitEnded = (payload) => { try { accountEvents.emit('ended', payload); } catch (e) { console.error('[account] ended 监听出错：', e?.message || e); } };

export const ARCHIVE_DIR = path.join(NATIVE_ROOT, '_archive');
const userKeyOf = (id) => ownerKey('user', id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 只当「最多等这么久」用的计时：unref，不拖住进程退出
const cap = (ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); });

// 中止这个身份在跑的轮（Claude / 定时任务都挂在 gen 注册表上）。
function stopRuns(key) {
  let n = 0;
  for (const g of getLiveGens(key)) { try { g.abort?.abort(); n++; } catch {} }
  return n;
}

// 这个账号的目录：必须正好是 <usersRoot>/<id> 这一层，id 不能空、不能以 _ 开头（系统目录）。
function accountDir(id) {
  if (!id || id.startsWith('_') || /[\\/]/.test(id) || id === '.' || id === '..') return null;
  const dir = path.resolve(userRoot(id));
  const rel = path.relative(path.resolve(NATIVE_ROOT), dir);
  return rel && rel === id && !path.isAbsolute(rel) ? dir : null;
}

// ── 停放着的 Claude CLI ─────────────────────────────────────────────────────
// agents/claude.mjs 一轮定局后 CLI 不退、停放最多 BRIDGE_CLAUDE_WARM_MS（默认 15 分钟）等同会话下一条，普通成员也有。
// 停放期间这一轮已结清，stopRuns 关不到它；可它的工作目录就在成员目录里（Windows 上目录删不掉、改不了名，Node 实测 EPERM），
// 手里握着号池凭据，停放期间还可能替跨会话消息开一轮（用的是开跑时的权限）。按他最近写过的会话逐个关掉并等退干净。
// 成员的会话都在 <他的目录>/.bridge/claude/projects/<cwd>/<sid>.jsonl（CLAUDE_CONFIG_DIR，见 identity.mjs），
// 停放的那个会话刚写过 transcript：只看窗口期内改过的，没有就不用加载 Claude 模块。
const WARM_WINDOW_MS = Math.max(0, Number(process.env.BRIDGE_CLAUDE_WARM_MS ?? 15 * 60_000) || 0) + 5 * 60_000;
async function recentSessionIds(id) {
  const dir = accountDir(id);
  if (!dir) return [];
  const projects = path.join(dir, '.bridge', 'claude', 'projects');
  const since = Date.now() - WARM_WINDOW_MS;
  const out = new Set();
  let groups; try { groups = await readdir(projects, { withFileTypes: true }); } catch { return []; }
  for (const g of groups) {
    if (!g.isDirectory()) continue;
    let files; try { files = await readdir(path.join(projects, g.name), { withFileTypes: true }); } catch { continue; }
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith('.jsonl')) continue;
      try { if ((await stat(path.join(projects, g.name, f.name))).mtimeMs >= since) out.add(f.name.slice(0, -6)); } catch {}
    }
  }
  return [...out];
}
// 返回关了几个会话的停放进程（没有停放的也算在内——releaseWarmClaude 对它们是空操作）。
// agents/claude.mjs 若导出了按属主关停的 releaseWarmOf(key) 就用它（一次关干净），否则按会话逐个 releaseWarmClaude。
export async function releaseParkedClis(key, id) {
  const sids = await recentSessionIds(id);
  if (!sids.length) return 0;
  let m; try { m = await import('../agents/claude.mjs'); } catch { return 0; }
  const work = typeof m.releaseWarmOf === 'function' ? m.releaseWarmOf(key)
    : typeof m.releaseWarmClaude === 'function' ? Promise.allSettled(sids.map((sid) => m.releaseWarmClaude(key, sid)))
      : null;
  if (!work) return 0;
  await Promise.race([Promise.resolve(work).catch(() => {}), cap(20_000)]);
  return sids.length;
}

// 侧栏终端池（按属主收）。模块按需加载：没加载过说明他没开过。
const POOLS = [['./claude-term.mjs', 'killTermsOf']];
// 公开分享（/w/ 分享空间的桶是拷贝，删号后照样能看；/s/ 单文件）：按属主作废的入口由它们自己的模块提供，还没有时跳过。
const SHARES = [['../routes/share-space.mjs', 'revokeShareSpacesOf'], ['../routes/share.mjs', 'revokeSharesOf']];
async function callEach(list, key) {
  for (const [mod, fn] of list) {
    try { const m = await import(mod); if (typeof m[fn] === 'function') await m[fn](key); } catch {}
  }
}

// ── 停用 / 启用 ─────────────────────────────────────────────────────────────
export function setAccountDisabled(ref, disabled) {
  const rec = users.getUser(ref);
  if (!rec) return { error: '用户不存在' };
  const r = users.setDisabled(ref, !!disabled);
  if (r.error) return r;
  const id = users.accountId(rec);
  const key = userKeyOf(id);
  let runs = 0;
  if (disabled) {
    runs = stopRuns(key);
    releaseParkedClis(key, id).catch(() => {});
    // 他铸的聊天快照是还在跑的对话（访客用的是号池、记他的账）：一并关掉；文件分享是静态拷贝，停用时留着，删号才收
    closeSnapshotsOf(key, '铸它的账号已停用').catch(() => {});
    emitEnded({ id, key, name: rec.name, reason: 'disabled' });
  }
  busPublish(key, { type: 'me.changed' });   // 他在线的页面重新问一次 /api/auth：停用了就退回登录页
  return { ok: true, id, runs };
}

// ── 改档位 ─────────────────────────────────────────────────────────────────
// 降为普通 = 收回命令行，要当场生效：在跑的轮用的是开跑时捕获的身份（canUseTool 看的 ctx.shell 还是 true），
// 侧栏终端里已经起来的进程也不会自己消失，停放的 CLI 还可能替跨会话消息开一轮——一并收掉。
// 升档、档位没变都不用收什么（下一轮自然按新档位开）。opts.ack 同 users.setTier（升为完全信任要确认）。
export async function setAccountTier(ref, tier, opts = {}) {
  const rec = users.getUser(ref);
  if (!rec) return { error: '用户不存在' };
  const was = users.normTier(rec.tier);
  const r = users.setTier(ref, tier, opts);
  if (r.error || was !== users.TIER_FULL || r.tier === users.TIER_FULL) return r;
  const id = users.accountId(rec);
  const key = userKeyOf(id);
  const runs = stopRuns(key);
  await callEach(POOLS, key);
  releaseParkedClis(key, id).catch(() => {});
  try { accountEvents.emit('downgraded', { id, key, name: rec.name }); } catch (e) { console.error('[account] downgraded 监听出错：', e?.message || e); }
  console.log(`[account] ${rec.name}（${id}）降为普通：中止 ${runs} 轮，收掉终端`);
  return { ...r, runs };
}

// ── 删号 ───────────────────────────────────────────────────────────────────

// 等这个身份的总线订阅（/api/stream）全断开，最多 ms 毫秒；返回是否断干净。
// 为什么要等：订阅在的时候，session-watch 正用 fs.watch 盯着他目录里的会话文件夹（订阅一断就关）。
//   · Windows 上被盯着的目录一删，那个 FSWatcher 不报错、开始空转，吃满一个 CPU 核，直到被关掉（Node 24 实测：
//     删前 close 则 0 CPU，不 close 则 3 秒里约 3 秒 CPU）；
//   · 子目录被盯着时整个目录改名（归档）直接 EPERM。
// 步骤 ① 已推 me.changed：在线的页面重新问 /api/auth → 未登录 → 自己断开总线，通常一两百毫秒。
// 半死的连接（手机切后台）等不到：不当场动目录，记成 pending 交给 finishPendingData。
async function waitBusDrained(key, ms = 5000) {
  const until = Date.now() + ms;
  while (busSubscribers(key) > 0 && Date.now() < until) await sleep(100);
  return busSubscribers(key) === 0;
}

// 文件可能还被刚中止的轮占着（Windows 上改名 / 删除会 EBUSY / EPERM）：退避重试几次。fn 可以是 async。
async function retry(fn, tries = 6) {
  let err = null;
  for (let i = 0; i < tries; i++) {
    try { return { ok: true, value: await fn() }; } catch (e) { err = e; await sleep(300 * (i + 1)); }
  }
  return { ok: false, error: String(err?.message || err) };
}

async function handleData(id, mode, meta) {
  const dir = accountDir(id);
  if (!dir) return { mode: 'kept', error: '账号目录不在用户根下，没有动它' };
  if (!existsSync(dir)) return { mode: mode === 'archive' ? 'archived' : 'purged', empty: true };
  if (mode === 'archive') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dest = path.join(ARCHIVE_DIR, `${id}-${stamp}`);
    try { mkdirSync(ARCHIVE_DIR, { recursive: true }); } catch {}
    // 同一个盘上改名是一次元数据操作，很快，留着同步版
    const r = await retry(() => renameSync(dir, dest));
    if (!r.ok) return { mode: 'kept', error: '归档失败（目录被占用？）：' + r.error };
    try { writeFileSync(path.join(dest, 'account.json'), JSON.stringify(meta, null, 2)); } catch {}
    return { mode: 'archived', archive: dest };
  }
  // 异步删：一个成员目录几万个文件，同步 rmSync 会把事件循环卡上好几秒（实测 3.3 万个小文件 8.3 秒），所有人的对话一起停住
  const r = await retry(() => rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }), 3);
  if (!r.ok || existsSync(dir)) return { mode: 'partial', error: '没删干净（文件被占用？），剩下的在 ' + dir + (r.ok ? '' : '：' + r.error) };
  return { mode: 'purged' };
}

// ── 等页面断开后再处理的数据（pending）─────────────────────────────────────
// 删号时他还有页面连着总线（手机切后台、隧道那头的连接半死）：目录先不动，退役记录里写 data:'pending'、want、meta，
// 每 30 秒看一次，连接断干净了再删 / 归档。账号已经删了，他不可能再连上来，连接只会减少；最多等 6 小时，之后照常处理。
// 服务端重启后没有任何旧连接：启动 15 秒后把上次没处理完的一并处理掉。
const PENDING_POLL_MS = 30_000;
const PENDING_MAX_MS = 6 * 60 * 60 * 1000;
let pendingTimer = null;
function schedulePending() {
  if (pendingTimer) return;
  pendingTimer = setInterval(() => { finishPendingData().catch(() => {}); }, PENDING_POLL_MS);
  pendingTimer.unref?.();
}
let finishing = null;
// 处理退役记录里 data:'pending' 的账号目录；force = 不等连接断开（测试 / 手动收尾用）。返回处理了几个。
export function finishPendingData({ force = false } = {}) {
  if (finishing) return finishing;
  finishing = (async () => {
    const list = users.listRetired().filter((r) => r && r.data === 'pending');
    if (!list.length) { if (pendingTimer) { clearInterval(pendingTimer); pendingTimer = null; } return 0; }
    let n = 0;
    for (const r of list) {
      const key = userKeyOf(r.id);
      const left = busSubscribers(key);
      const overdue = Date.now() - (Number(r.pendingSince) || 0) > PENDING_MAX_MS;
      if (left > 0 && !overdue && !force) continue;
      if (left > 0) console.warn(`[account] ${r.name}（${r.id}）还有 ${left} 条总线连接没断开，${force ? '按要求' : '已等满 6 小时，'}照常处理数据`);
      const full = users.retiredRecord(r.id) || {};
      const data = await handleData(r.id, r.want === 'archive' ? 'archive' : 'purge', full.meta || { id: r.id, name: r.name });
      users.updateRetired(r.id, {
        data: data.mode, want: undefined, pendingSince: undefined, meta: undefined,
        ...(data.archive ? { archive: data.archive } : {}), ...(data.error ? { error: data.error } : {}),
      });
      console.log(`[account] ${r.name}（${r.id}）的页面已断开，数据 ${data.mode}${data.error ? '（' + data.error + '）' : ''}`);
      n++;
    }
    return n;
  })().finally(() => { finishing = null; });
  return finishing;
}
const bootPending = setTimeout(() => { finishPendingData().then((n) => { if (n === 0 && users.listRetired().some((r) => r.data === 'pending')) schedulePending(); }).catch(() => {}); }, 15_000);
bootPending.unref?.();

// 它铸的聊天快照（公开 /c/ 链接）立即关停、访客那边在跑的轮一并中止（快照轮挂在 'c:<令牌>' 上，
// 与 routes/chat-snapshot.mjs 的 snapKey 同一口径），桶随后由快照扫描器删除。
async function closeSnapshotsOf(key, why = '铸它的账号已删除') {
  let tokens = [];
  try {
    const store = JSON.parse(readFileSync(path.join(ROOT, 'chat-snapshots.json'), 'utf8') || '{}');
    tokens = Object.entries(store || {}).filter(([, r]) => r && r.owner === key && !r.closed).map(([t]) => t);
  } catch { return 0; }
  if (!tokens.length) return 0;
  let n = 0;
  try {
    const { closeSnapshot } = await import('../routes/chat-snapshot.mjs');
    for (const t of tokens) if (closeSnapshot(t, why)) n++;
  } catch {}
  for (const t of tokens) stopRuns(ownerKey('snap', t));
  return n;
}

// 成员侧的「管理员可见性」记录（_system/admin-access.json：consents / log 都按账号 id 分键）：
// id 永不复用，留着无害，只是残留——删号时一并摘掉，经 runtime/admin-access.mjs 的 dropAccessOf，不在这里碰文件格式。
function dropAdminAccess(id) {
  if (!id) return false;
  return dropAccessOf(id);
}

/**
 * 删号。ref = 登录名或 id；mode = 'purge'（默认）| 'archive'；drainMs = 等他的页面断开总线最多多久（默认 5 秒）。
 * 返回 { ok, id, name, data, archive, dataError, runs, parked, snapshots, invites }；data 是数据的实际去向
 * （'purged' / 'archived' / 'partial' 没删干净 / 'kept' 没动 / 'pending' 还有页面连着、断开后自动处理），
 * dataError 说明为什么没按要求处理。
 */
export async function deleteAccount(ref, { mode = 'purge', drainMs = 5000 } = {}) {
  const want = mode === 'archive' ? 'archive' : 'purge';
  const rec = users.getUser(ref);
  if (!rec) return { error: '用户不存在' };
  const id = users.accountId(rec);
  const key = userKeyOf(id);
  const name = rec.name;
  const meta = { id, name, created: rec.created || null, tier: users.normTier(rec.tier), deletedAt: new Date().toISOString() };
  // ① 先让它登不上：账号行与全部登录会话（之后任何请求都是未登录）；id 记进退役名单
  const del = users.deleteUser(id);
  if (del.error) return del;
  // 他在线的页面马上重新问一次 /api/auth：未登录 → 自己断开总线（下面 ④ 等它断干净再动目录）
  busPublish(key, { type: 'me.changed' });
  // ② 停掉它在跑的东西：在跑的轮、停放的 CLI（与下面的清理并行，④ 之前等它退干净）、快照、终端池
  const runs = stopRuns(key);
  const parkedP = releaseParkedClis(key, id).catch(() => 0);
  const snapshots = await closeSnapshotsOf(key);
  await callEach(POOLS, key);
  await callEach(SHARES, key);
  emitEnded({ id, key, name, reason: 'deleted' });
  // ③ 账本：用过的邀请记录、用量（归档时随数据留底）、成员侧的管理员可见性与访问记录
  const invites = users.dropInvitesOf(id);
  const usage = users.dropUsage(id);
  try { dropAdminAccess(id); } catch {}
  // ④ 数据：等停放的 CLI 退干净、刚中止的轮收尾、他的总线订阅断干净，再删 / 归档
  const parked = await parkedP;
  if (runs) await sleep(800);
  let drained = await waitBusDrained(key, drainMs);
  if (!drained) {
    // 等不到它自己断开（半死的连接）：经路由登记过收尾的订阅直接掐掉（bus.busDropKey 顺带关掉 session-watch），再看一次
    const cut = busDropKey(key);
    if (cut) console.log(`[account] 删除 ${name}（${id}）：强制断开 ${cut} 条没自己断开的总线连接`);
    drained = busSubscribers(key) === 0;
  }
  let data;
  if (drained) {
    data = await handleData(id, want, { ...meta, usage: usage || null });
    users.updateRetired(id, { data: data.mode, ...(data.archive ? { archive: data.archive } : {}), ...(data.error ? { error: data.error } : {}) });
  } else {
    // 半死的连接：这时删目录，session-watch 的 watcher 会在已删的目录上空转吃满一个核（归档则 EPERM）——等它断开再处理
    data = { mode: 'pending' };
    users.updateRetired(id, { data: 'pending', want, pendingSince: Date.now(), meta: { ...meta, usage: usage || null } });
    schedulePending();
    console.warn(`[account] 删除 ${name}（${id}）：还有 ${busSubscribers(key)} 条总线连接没断开（半死的连接？），数据等断开后再${want === 'archive' ? '归档' : '删除'}`);
  }
  console.log(`[account] 删除 ${name}（${id}）：数据 ${data.mode}${data.error ? '（' + data.error + '）' : ''}，中止 ${runs} 轮，停放会话 ${parked}`);
  // 账号已经删了，数据没处理完不算失败（不放进 error，免得接口回 400、审计漏记）：dataError 交给控制台提示
  return { ok: true, id, name, data: data.mode, want, archive: data.archive || null, dataError: data.error || null, runs, parked, snapshots, invites };
}
