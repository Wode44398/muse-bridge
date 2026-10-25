// 5 小时限额「重置后自动继续」（官方 Claude Code Desktop 2.42304 同款，2026-10-20 对齐）。
//
// 官方：撞 5 小时限额的错误卡上有勾选框「Auto-continue when limits reset」，默认勾上、按账号记住；
// 勾着时卡片提示改成「Auto-resuming at {time}」。到重置时刻 + 90s（再加 2–8s 抖动）由宿主自己往这个
// 会话发一句 "I hit my usage limit while you were working, but it has reset now. Please continue from
// where you left off."；同一个限额窗口最多续 3 次，过了重置时刻 6 小时就放弃；人自己先接手了（又发了
// 别的）就作废。只认 five_hour——每周 / 按模型的限额要等好几天，官方也不给这个勾选框。
//
// 官方的这套逻辑在渲染进程里，只对「开着的会话」有效。bridge 放到服务端：手机切后台、网页关掉也照样续。
// 发出方式与 claude-queue 的排队消息相同——在服务端把撞墙那一轮的 /api/chat 请求原样重放一次（身份、
// 项目、模型、effort 全走现成路由），正文换成上面那句；新一轮照常在总线上广播 run.start，正看这个会话的
// 设备自动挂上直播。
//
// 状态落盘（DATA_ROOT/claude-limit-resume.json，已 gitignore）：等几个小时的事，中途重启服务不能丢。
// 重放要用的身份头一并存——和 config.json 同一台机器、同一级别的秘密，不出本机。
import path from 'node:path';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { DATA_ROOT } from './paths.mjs';
import { busPublish } from './bus.mjs';
import { findGenBySession } from './gen.mjs';
import { replayChat } from './claude-queue.mjs';

const FIRST_FIRE_FLOOR_MS = 90_000;      // 官方 lU：首次续跑在重置时刻之后再等 90s
const RETRY_FLOOR_MS = 45_000;           // 官方 uU：重置时刻已过的再次尝试至少隔 45s
const GIVE_UP_MS = 6 * 3600_000;         // 官方 FU=21600s：过了重置时刻 6 小时就不再续
const MAX_ATTEMPTS = 3;                  // 官方：attempt<3
const SAME_WINDOW_MS = 3600_000;         // 官方 nW：重置时刻相差 1 小时以内算同一个限额窗口
const jitter = () => 2000 + Math.floor(Math.random() * 6000);   // 官方 xU：2–8s

// 续跑时发给模型的那句话（官方 afterUsageLimit 原文的中文版）。
export const RESUME_TEXT = '刚才工作时撞到了用量限额，现在已经重置。请从中断的地方继续。';

let file = '';
// entries: `${key}|${sid}` → { key, sid, type, resetsAt, optedIn, armed, attempt, fireAt, firing, replay }
// prefs:   key → 旧版「勾选框记成默认」的选择（2026-10-20 起默认值改由设置 autoContinueOnLimit 给，
//          调用方带 defaultOn；这份只在调用方没带时兜底，不再写入）
let state = { entries: {}, prefs: {} };
const timers = new Map();
const K = (key, sid) => key + '|' + sid;

function load() {
  if (file) return;
  file = path.join(DATA_ROOT, 'claude-limit-resume.json');
  try {
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      state = { entries: j.entries || {}, prefs: j.prefs || {} };
    }
  } catch { state = { entries: {}, prefs: {} }; }
}
function save() {
  try {
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
  } catch (e) { console.log('[limit-resume] save failed:', e && e.message); }
}

// 前端看的一份（不含身份头）
function view(e) {
  if (!e) return null;
  return { type: e.type, resetsAt: e.resetsAt, optedIn: !!e.optedIn, armed: !!e.armed, attempt: e.attempt || 0, fireAt: e.armed ? e.fireAt || 0 : 0, firing: !!e.firing };
}
function publish(e, extra = {}) {
  busPublish(e.key, { type: 'limit_resume', sessionId: e.sid, state: view(e), ...extra });
}
function drop(k, why) {
  const e = state.entries[k];
  if (!e) return;
  clearTimeout(timers.get(k)); timers.delete(k);
  delete state.entries[k];
  save();
  busPublish(e.key, { type: 'limit_resume', sessionId: e.sid, state: null });
  if (why) console.log(`[limit-resume] ${e.sid.slice(0, 8)} dropped (${why})`);
}
const prefOf = (key) => state.prefs[key] !== false;
// 新撞墙的默认勾选：设置里的「限额重置后自动继续」（claude.mjs 按身份读好传进来）；没传 = 旧版按 key 记的选择
const defaultOptIn = (key, defaultOn) => (typeof defaultOn === 'boolean' ? defaultOn : prefOf(key));
const liveTurn = (key, sid) => { const g = findGenBySession(key, sid); return !!(g && !g.done); };

// 什么时候续（官方 S 里的 u/d 算法）：首次 = 重置时刻 + 90s + 抖动；再次尝试且重置时刻已过 = 至少 45s 后。
function computeFireAt(e) {
  const now = Date.now();
  const base = e.resetsAt + (e.attempt === 0 ? FIRST_FIRE_FLOOR_MS : 0);
  const d = Math.max(0, base - now) + jitter();
  return now + (e.attempt > 0 && e.resetsAt <= now ? Math.max(d, RETRY_FLOOR_MS) : d);
}
function schedule(k) {
  clearTimeout(timers.get(k)); timers.delete(k);
  const e = state.entries[k];
  if (!e || !e.armed) return;
  if (!e.fireAt) e.fireAt = computeFireAt(e);
  // setTimeout 上限 ~24.8 天；5 小时窗口远够不着，保险起见分段睡
  const wait = Math.min(Math.max(0, e.fireAt - Date.now()), 2 ** 31 - 1);
  const t = setTimeout(() => { timers.delete(k); fire(k).catch((err) => console.log('[limit-resume] fire failed:', err && err.message)); }, wait);
  if (t.unref) t.unref();
  timers.set(k, t);
}

async function fire(k) {
  const e = state.entries[k];
  if (!e || !e.armed) return;
  if (Date.now() < e.fireAt - 1000) { schedule(k); return; }
  if (Date.now() - e.resetsAt >= GIVE_UP_MS) return drop(k, 'past the 6h window');
  if (!e.optedIn) { e.armed = false; save(); publish(e); return; }
  // 有一轮正在跑（人自己先接着做了 / 别的设备发了消息）——那一轮开跑时本该把这条作废，这里兜底
  if (liveTurn(e.key, e.sid)) return drop(k, 'session already running');
  e.attempt += 1;
  e.armed = false;
  e.firing = true;
  e.fireAt = 0;
  save();
  publish(e, { fired: true });
  const { headers, url, body } = e.replay || {};
  console.log(`[limit-resume] ${e.sid.slice(0, 8)} limit reset — resuming session (attempt ${e.attempt})`);
  let status = 0, detail = '';
  try {
    ({ status, detail = '' } = await replayChat({
      headers: headers || {},
      url: url || '/api/chat',
      body: { ...(body || {}), sessionId: e.sid, message: RESUME_TEXT, attachments: [], priority: undefined, worktree: undefined, outputStyle: undefined, limitResume: true },
    }));
  } catch { status = 500; }
  if (status >= 400 || status === 0) {
    // 没发出去（会话被 Desktop 占着 / 鉴权变了 / 并发满了）：不再自动重试，卡片回到可手动重试的状态
    const cur = state.entries[k];
    console.log(`[limit-resume] ${e.sid.slice(0, 8)} replay failed (status ${status}) ${String(detail).slice(0, 300)}`);
    if (cur) { cur.firing = false; save(); publish(cur, { error: '自动继续没能发出（状态 ' + (status || '未知') + '）' }); }
  }
}

// —— 对外接口（claude.mjs / 路由调用）——

// 一轮以「撞限额」收尾。type = rate_limit_info.rateLimitType；resetsAt 毫秒；replay = 撞墙那轮的 /api/chat 请求
//（headers/url/body）；defaultOn = 设置「限额重置后自动继续」（新撞的墙默认勾不勾）。
// 返回给前端的状态；不适用（不是 5 小时 / 没有重置时刻 / 没有重放身份）返回 null。
export function noteLimitTurn(key, sid, { type, resetsAt, replay, defaultOn }) {
  load();
  const k = K(key, sid);
  const prev = state.entries[k];
  if (type !== 'five_hour' || !resetsAt || !replay) { if (prev) drop(k, 'not a 5-hour limit'); return null; }
  // 同一个限额窗口里续跑后又撞墙：沿用尝试次数（官方 nW + max(attempt)）
  const same = prev && Math.abs(prev.resetsAt - resetsAt) < SAME_WINDOW_MS;
  const attempt = same ? prev.attempt || 0 : 0;
  const optedIn = same ? prev.optedIn !== false : defaultOptIn(key, defaultOn);
  const e = {
    key, sid, type, resetsAt, optedIn, attempt,
    armed: optedIn && attempt < MAX_ATTEMPTS && Date.now() - resetsAt < GIVE_UP_MS,
    fireAt: 0, firing: false, replay, at: Date.now(),
  };
  state.entries[k] = e;
  if (e.armed) e.fireAt = computeFireAt(e);
  save();
  schedule(k);
  if (attempt >= MAX_ATTEMPTS) console.log(`[limit-resume] ${sid.slice(0, 8)} gave up after ${attempt} attempts`);
  publish(e);
  return view(e);
}

// 这个会话开跑了新一轮。auto = 本模块自己发的续跑轮（保留记录，等它的结局）；否则是人接手了 → 作废。
export function noteTurnStart(key, sid, { auto = false } = {}) {
  load();
  const k = K(key, sid);
  if (!state.entries[k]) return;
  if (auto) return;
  drop(k, 'user took over');
}

// 这一轮正常收尾 / 以别的错误收尾：限额那件事翻篇了。
export function noteTurnSettled(key, sid) {
  load();
  if (state.entries[K(key, sid)]) drop(K(key, sid), 'turn settled');
}

export function getLimitResume(key, sid) {
  load();
  return view(state.entries[K(key, sid)]);
}

// 卡片上的勾选框（官方 rW）：只管这一次——这个会话这回撞的墙续不续。以后新撞的墙默认勾不勾由设置
//「限额重置后自动继续」决定（2026-10-20 起；原先勾选框会顺手记成这个身份的默认并连带其它在等的会话）。
export function setLimitAutoContinue(key, sid, on) {
  load();
  on = !!on;
  const k = K(key, sid);
  const e = state.entries[k];
  if (!e) return { optedIn: on, armed: false };
  e.optedIn = on;
  const wantArmed = on && !e.firing && e.attempt < MAX_ATTEMPTS && Date.now() - e.resetsAt < GIVE_UP_MS;
  if (wantArmed !== e.armed) {
    e.armed = wantArmed;
    e.fireAt = wantArmed ? computeFireAt(e) : 0;
    schedule(k);
  }
  publish(e);
  save();
  return view(e);
}

// 单测用：不等计时器，立刻走一遍到点逻辑
export function _fireForTest(key, sid) { load(); const e = state.entries[K(key, sid)]; if (e) e.fireAt = Date.now(); return fire(K(key, sid)); }

// 服务启动：把落盘的待续会话重新排上计时器；过期的清掉。
export function initLimitResume() {
  load();
  let n = 0;
  for (const [k, e] of Object.entries(state.entries)) {
    if (Date.now() - e.resetsAt >= GIVE_UP_MS) { delete state.entries[k]; continue; }
    // 重启前正在发的续跑轮已经随进程没了：作废那次尝试，按可手动重试处理
    if (e.firing) e.firing = false;
    if (e.armed) { if (!e.fireAt || e.fireAt < Date.now()) e.fireAt = computeFireAt(e); schedule(k); n++; }
  }
  save();
  if (n) console.log(`[limit-resume] ${n} session(s) waiting to auto-continue`);
}
