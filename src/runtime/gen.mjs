// In-flight Claude chats, BUFFERED so they survive a client disconnect
// (e.g. a page refresh). The phone reattaches via /api/attach and keeps seeing
// the spinner + streamed output + final answer instead of guessing.
// A same-session POST /api/chat (explicit resend) or POST /api/stop aborts a run;
// merely closing the connection does NOT — that is what makes refresh safe and
// also kills the "refresh→resend spawns a second Claude" bug at the source.
//
// This module is the canonical home for that shared mutable state. handlers
// across routes/chat, routes/overview, routes/sessions, the MEDIA_MCP adapter
// and the routines runner all read+mutate gens through these exports.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { sseWrite } from './sse.mjs';

// ---- gens: in-flight generations PER caller (admin or each user) ----
// Keyed so concurrent callers don't supersede each other. Key is 'admin' for the
// token / loopback console, 'u:<name>' for an account user ('codex:<key>' for the
// Codex branch). Each key holds an ARRAY in start order: Claude allows several
// live gens per caller (multi-conversation concurrency, at most one per session);
// codex keeps single-flight semantics on top of the same helpers (its route 409s
// while one is live).
const _gens = new Map(); // key -> gen[]
/* gen = {
     sessionId, userText, events: [<sse objs>], subscribers: Set<res>,
     abort: AbortController, done: bool, settled: Promise, startedAt
   } */

export function getGens(key = 'admin') { return _gens.get(key) || []; }
export function getLiveGens(key = 'admin') { return getGens(key).filter((g) => !g.done); }
// Single-slot view older callers still expect (codex route, admin stop, no-session
// /api/attach): the newest LIVE gen, else the newest retained (finished) one.
export function getCurrentGen(key = 'admin') {
  const a = getGens(key);
  for (let i = a.length - 1; i >= 0; i--) if (!a[i].done) return a[i];
  return a.length ? a[a.length - 1] : null;
}
// The gen driving a given conversation (live preferred; else the newest retained
// one so a just-finished turn can still replay its final result on reattach).
export function findGenBySession(key, sessionId) {
  if (!sessionId) return null;
  const a = getGens(key);
  for (let i = a.length - 1; i >= 0; i--) if (!a[i].done && a[i].sessionId === sessionId) return a[i];
  for (let i = a.length - 1; i >= 0; i--) if (a[i].sessionId === sessionId) return a[i];
  return null;
}
// Legacy names kept: setCurrentGen APPENDS now, clearCurrentGenIfMatches removes.
export function setCurrentGen(key, g) {
  const a = _gens.get(key) || [];
  a.push(g);
  _gens.set(key, a);
}
// Atomically validate and occupy a generation slot. JavaScript runs this whole
// function without an await/interleave, so the limit check and append are one
// critical section. `singleSession` also closes the race where two resend
// requests both finish waiting for the same superseded turn.
export function tryStartGen(key, g, {
  maxPerKey = Infinity,
  singleSession = false,
  globalPrefix = '',
  maxGlobal = Infinity,
} = {}) {
  const local = getGens(key);
  if (singleSession && g.sessionId && local.some((x) => !x.done && x.sessionId === g.sessionId)) {
    return { ok: false, reason: 'session' };
  }
  // 同会话上一轮的已完成缓冲被这一轮取代（retireGen 长保留的配对回收点）：
  // findGenBySession 永远该拿到「这个会话最新的一轮」，旧轮内容已在 transcript。
  if (g.sessionId) {
    for (const x of [...local]) {
      if (x.done && x.sessionId === g.sessionId) {
        const i = local.indexOf(x);
        if (i >= 0) local.splice(i, 1);
      }
    }
  }
  if (local.reduce((n, x) => n + (!x.done ? 1 : 0), 0) >= maxPerKey) {
    return { ok: false, reason: 'per-key' };
  }
  if (globalPrefix && Number.isFinite(maxGlobal)) {
    let live = 0;
    for (const [owner, arr] of _gens) {
      if (!owner.startsWith(globalPrefix)) continue;
      for (const x of arr) if (!x.done && ++live >= maxGlobal) {
        return { ok: false, reason: 'global' };
      }
    }
  }
  local.push(g);
  _gens.set(key, local);
  return { ok: true };
}
export function clearCurrentGenIfMatches(key, g) {
  const a = _gens.get(key);
  if (!a) return;
  const i = a.indexOf(g);
  if (i >= 0) a.splice(i, 1);
  if (!a.length) _gens.delete(key);
}

// ---- 已完成轮的保留（重连的「无悬崖」保证）----
// 以前完成的 gen 只留 60s，手机离开一分多钟回来 /api/attach 必 204，前端只能走
// 「读 transcript 对账」的降级路径（落盘竞态一堆）。现在完成的轮保留到【同会话下一轮
// 开跑】才被替换，另有 per-key 条数上限（LRU）与时效兜底——绝大多数重连都能整轮
// 重放（含最终 done），状态以服务端为准，前端不必再猜。
const DONE_KEEP_PER_KEY = 8;          // 每个 caller 最多留这么多已完成轮
const DONE_KEEP_MS = 6 * 3600_000;    // 时效兜底：超过即清（防常驻内存无限涨）
let _sweepTimer = null;

export function retireGen(key, gen) {
  gen.endedAt = gen.endedAt || Date.now();
  const a = _gens.get(key);
  if (!a) return;
  // 同会话只留最新一份已完成轮（旧轮的内容早在 transcript 里了）。
  for (const g of [...a]) {
    if (g !== gen && g.done && g.sessionId && g.sessionId === gen.sessionId) {
      const i = a.indexOf(g);
      if (i >= 0) a.splice(i, 1);
    }
  }
  // LRU：已完成轮超出上限，淘汰最老的（数组本就按开始顺序）。
  const doneGens = a.filter((g) => g.done);
  for (let n = doneGens.length - DONE_KEEP_PER_KEY; n > 0; n--) {
    const g = doneGens.shift();
    const i = a.indexOf(g);
    if (i >= 0) a.splice(i, 1);
  }
  if (!a.length) _gens.delete(key);
  ensureSweep();
}

// 周期兜底清扫：已完成且超时的轮全库清一遍。进程级单 timer，unref 不拖退出。
function ensureSweep() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    const now = Date.now();
    let any = false;
    for (const [key, a] of _gens) {
      for (const g of [...a]) {
        if (g.done && now - (g.endedAt || g.startedAt || 0) > DONE_KEEP_MS) {
          const i = a.indexOf(g);
          if (i >= 0) a.splice(i, 1);
        }
      }
      if (!a.length) _gens.delete(key); else any = true;
    }
    if (!any && !_gens.size) { clearInterval(_sweepTimer); _sweepTimer = null; }
  }, 10 * 60_000);
  if (_sweepTimer.unref) _sweepTimer.unref();
}

// Enumerate every caller's in-flight generations (admin debug console overview /
// cross-user "active agents" panel). Returns lightweight snapshots, no event bodies.
export function listGens() {
  const out = [];
  for (const [key, arr] of _gens.entries()) {
    for (const g of arr) {
      out.push({
        key,
        sessionId: g.sessionId || null,
        userText: g.userText || '',
        startedAt: g.startedAt || 0,
        elapsedMs: g.startedAt ? (Date.now() - g.startedAt) : 0,
        done: !!g.done,
        subscribers: g.subscribers ? g.subscribers.size : 0,
        events: g.events ? g.events.length : 0,
      });
    }
  }
  return out;
}

// Per-gen helpers — pure functions on the gen object, but kept here so all
// emit/subscribe logic lives in one file.
// One SSE writer for the whole server lives in sse.mjs; genWrite stays as the name
// the gen helpers + the overview route already import.
export const genWrite = sseWrite;
// 缓冲端合并：相邻的 text/thinking 增量在 events 里合成 ≤4KB 块——一轮长回答的缓冲
// 从数万个单 token 事件降到几十个块，/api/attach 重放时手机不再逐帧解析几万条 SSE，
// 内存占用也同步缩小。直播订阅者不受影响（仍实时收到原始增量）。
const MERGEABLE = new Set(['text', 'thinking', 'commentary', 'reasoning']);
export function genEmit(gen, obj) {
  const last = gen.events[gen.events.length - 1];
  if (obj && MERGEABLE.has(obj.type) && last && last.type === obj.type &&
      (last.itemId || null) === (obj.itemId || null) &&
      (last.summaryIndex ?? null) === (obj.summaryIndex ?? null) &&
      typeof last.text === 'string' && last.text.length < 4096) {
    last.text += obj.text || '';
  } else {
    gen.events.push(obj);
  }
  for (const r of gen.subscribers) genWrite(r, obj);
}
export function genSubscribe(gen, res) { gen.subscribers.add(res); res.on('close', () => gen.subscribers.delete(res)); }
export function genFinish(gen) { gen.done = true; for (const r of gen.subscribers) { if (!r.writableEnded) r.end(); } gen.subscribers.clear(); }

// ---- bridge / routine session tagging ----
// Sessions the bridge (phone) started, so the conversation list can mark them
// "phone" vs "desktop" — the desktop Claude Code session writes to the SAME
// projects dir and otherwise looks identical. Tagged going forward only; older
// sessions (and the live desktop one) show as desktop.
// Routine sessions are a subset, tagged "路由" instead of "手机".

let _bridgeSessionsPath = '';
let _routineSessionsPath = '';
let _escalatedSessionsPath = '';
export const bridgeSessions = new Set();
export const routineSessions = new Set();
// Sessions auto-promoted to the 1M-context model variant because their fill neared the
// bare 200k ceiling. Latched one-way per session and persisted so the jump survives a restart.
export const escalatedSessions = new Set();

function loadSet(file) {
  try { const a = JSON.parse(readFileSync(file, 'utf8')); return Array.isArray(a) ? a : []; } catch { return []; }
}

// Call once at startup so the in-memory Sets reflect what's on disk.
export function initSessionStores(root) {
  _bridgeSessionsPath = path.join(root, 'bridge-sessions.json');
  _routineSessionsPath = path.join(root, 'routine-sessions.json');
  _escalatedSessionsPath = path.join(root, 'escalated-sessions.json');
  if (existsSync(_bridgeSessionsPath)) for (const id of loadSet(_bridgeSessionsPath)) bridgeSessions.add(id);
  if (existsSync(_routineSessionsPath)) for (const id of loadSet(_routineSessionsPath)) routineSessions.add(id);
  if (existsSync(_escalatedSessionsPath)) for (const id of loadSet(_escalatedSessionsPath)) escalatedSessions.add(id);
}

// Cap how many ids we retain (and rewrite to disk) so a long-lived install doesn't
// grow these unbounded. Sets keep insertion order, so we drop the oldest; only very
// old sessions lose their phone/routine label — far past the 40 the list ever shows.
const SESSION_CAP = 2000;
function trimSet(set) { while (set.size > SESSION_CAP) set.delete(set.values().next().value); }

export function markBridgeSession(id) {
  if (!id || bridgeSessions.has(id)) return;
  bridgeSessions.add(id);
  trimSet(bridgeSessions);
  try { writeFileSync(_bridgeSessionsPath, JSON.stringify([...bridgeSessions])); } catch {}
}

export function markRoutineSession(id) {
  if (!id || routineSessions.has(id)) return;
  routineSessions.add(id);
  trimSet(routineSessions);
  try { writeFileSync(_routineSessionsPath, JSON.stringify([...routineSessions])); } catch {}
}

export function isEscalatedSession(id) { return !!id && escalatedSessions.has(id); }
// Returns true only on the FIRST mark, so the caller emits the "已升 1M" notice once.
export function markEscalatedSession(id) {
  if (!id || escalatedSessions.has(id)) return false;
  escalatedSessions.add(id);
  trimSet(escalatedSessions);
  try { writeFileSync(_escalatedSessionsPath, JSON.stringify([...escalatedSessions])); } catch {}
  return true;
}
