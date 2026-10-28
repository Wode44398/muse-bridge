// 服务意外重启后自动继续被中断的对话（2026-10-28，设置 › Claude「服务意外重启时 › 自动继续被中断的对话」，默认开）。
//
// inflight.mjs 已经能在启动时认出上一条命没跑完的轮，并在 transcript 末尾留下「被中断」；这里接着做一步：
// 用那一轮开跑时记下的请求（身份头 + 请求体）在服务端替用户发一句「继续」。发法与限额续跑、排队消息相同——
// 经 claude-queue.replayChat 把 /api/chat 原样重放一次（项目归属、单写者判活、并发上限、选择器记忆全走现成路由）；
// 新一轮照常在总线上广播 run.start，正看着这个会话的设备自动挂上直播。手机锁屏、网页关着也照样续。
//
// 护栏：
//   · 设置按身份读（开跑时记下的数据目录），关了就只留「被中断」、不续。发出前再读一次（等的那几秒里可能刚关）。
//   · 连续自动续跑最多 3 次：续跑轮自己又被打断也算一次，人发一条新消息即清零（次数随请求体 restartResume 带进台账）。
//     防的是「这一轮一跑就把服务搞崩」变成重启—续跑—再崩的死循环。
//   · 上一条命最后还活着的时刻（台账心跳）离现在超过 12 小时就不续：机器关了一整天，回来自动开跑多半不是人想要的。
//   · 会话这时已有一轮在跑（人先接手了）就不发；发出的这轮也绝不顶掉同会话正在跑的轮（claude.mjs noPreempt）。
//     被 Desktop / 终端占着、身份失效、transcript 不在了之类发不出去的，记日志、交还给「被中断」提示，不再重试。
//   · 待续清单落盘（DATA_ROOT/claude-restart-resume.json，含身份头，已 gitignore）：还没发出服务又死了，下一条命接着发；
//     连着几条命都没来得及发（启动即崩）就放弃。
import path from 'node:path';
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { DATA_ROOT, sessionPaths } from './paths.mjs';
import { busPublish } from './bus.mjs';
import { findGenBySession } from './gen.mjs';
import { replayChat } from './claude-queue.mjs';
import { setResuming } from './inflight.mjs';
import { getClaudeSettings } from './claude-settings.mjs';

const MAX_ATTEMPTS = 3;               // 连续自动续跑的上限（第 4 次起只留「被中断」）
const GIVE_UP_MS = 12 * 3600_000;     // 上一条命最后的心跳离现在超过这么久就不续
const FIRST_DELAY_MS = 15_000;        // 起来先等一会：号池、出站代理、插件都就绪，各设备也重连上了
const STAGGER_MS = 3_000;             // 多个会话错开发，别同一秒冷起一串 CLI
const RETRY_MS = 10_000;              // 重放口还没好 / 并发满了：隔这么久再试
const MAX_TRIES = 6;                  // 这一条命里最多试几次
const MAX_BOOTS = 3;                  // 连着几条命都没来得及发出去就放弃
const START_WAIT_MS = 8_000;          // SSE 头 200 之后也可能紧跟一个错误帧就收了：最多等这么久看它真的开跑

// 续跑时发给模型的那句话。点明中断前在跑的东西可能没跑完：被腰斩的命令 / 子 agent 结果没落盘，直接往下做会建在空气上。
export const RESTART_TEXT = '刚才 bridge 服务意外重启，上一轮在执行中途被打断了，现在服务已经恢复。'
  + '请从中断的地方继续；中断前正在跑的命令、后台任务或子 agent 可能没跑完、结果也可能没记下来，必要时先核对一下现状再接着做。';

let file = '';
// entries: `${key}|${sid}` → { key, sid, replay, attempt, userText, dataDir, cwd, configDir, boots, at }
let state = { entries: {} };
const timers = new Map();
const tries = new Map();
const K = (key, sid) => key + '|' + sid;

function load() {
  if (file) return;
  file = path.join(DATA_ROOT, 'claude-restart-resume.json');
  try {
    if (existsSync(file)) {
      const j = JSON.parse(readFileSync(file, 'utf8'));
      state = { entries: j && j.entries && typeof j.entries === 'object' ? j.entries : {} };
    }
  } catch { state = { entries: {} }; }
}
function save() {
  try {
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, file);
  } catch (e) { console.log('[restart-resume] 落盘失败:', e && e.message); }
}

const short = (sid) => String(sid || '').slice(0, 8);
const liveTurn = (key, sid) => { const g = findGenBySession(key, sid); return !!(g && !g.done); };
// 设置「自动继续被中断的对话」：按开跑时记下的身份数据目录读（getClaudeSettings 只看 dataDir；主机级值对所有身份生效）
const defaultEnabled = (e) => getClaudeSettings({ dataDir: e.dataDir || '' }).autoResumeOnRestart !== false;
let enabledFor = defaultEnabled;

function drop(k, why, { keepNote = false } = {}) {
  const e = state.entries[k];
  if (!e) return;
  clearTimeout(timers.get(k)); timers.delete(k); tries.delete(k);
  delete state.entries[k];
  save();
  // 没续成：attach 改回「说一句继续」的老说法
  if (!keepNote) setResuming(e.key, e.sid, false);
  if (why) console.log(`[restart-resume] ${short(e.sid)} 不再自动继续（${why}）`);
}

function schedule(k, wait) {
  clearTimeout(timers.get(k));
  const t = setTimeout(() => { timers.delete(k); fire(k).catch((err) => console.log('[restart-resume] 发送出错:', err && err.message)); }, Math.max(0, wait));
  if (t.unref) t.unref();
  timers.set(k, t);
}

// 这一条命里再试一次；试满了就放弃
function retry(k, why) {
  const n = (tries.get(k) || 0) + 1;
  tries.set(k, n);
  if (n >= MAX_TRIES) return drop(k, why + `，已试 ${n} 次`);
  schedule(k, RETRY_MS);
}

async function fire(k) {
  const e = state.entries[k];
  if (!e) return;
  if (!enabledFor(e)) return drop(k, '设置已关');
  // 人先接手了（别的设备发了消息）：这一轮开跑时 inflight 已把中断标记清掉，这里只需作废
  if (liveTurn(e.key, e.sid)) return drop(k, '会话已经在跑', { keepNote: true });
  const { headers, url, body } = e.replay || {};
  let r;
  try {
    r = await replayChat({
      headers: headers || {},
      url: url || '/api/chat',
      // 清掉只属于原请求的东西：插话 / 排队标记、新会话才有的 worktree 勾选与输出风格、限额续跑标记
      body: {
        ...(body || {}), sessionId: e.sid, message: RESTART_TEXT, attachments: [],
        priority: undefined, worktree: undefined, outputStyle: undefined, limitResume: undefined,
        restartResume: e.attempt,
      },
    });
  } catch (err) { r = { status: 500, detail: String(err && err.message || err) }; }
  if (!r || !r.status) return retry(k, '重放口还没就绪');
  if (r.status >= 400) {
    let reason = `状态 ${r.status}`;
    try { const j = JSON.parse(r.detail || '{}'); if (j.error) reason += '：' + j.error; } catch {}
    return drop(k, '没能发出，' + reason);
  }
  const t0 = Date.now();
  while (Date.now() - t0 < START_WAIT_MS) {
    if (liveTurn(e.key, e.sid)) break;
    if (r.res && r.res.writableEnded) {
      const txt = (r.res.chunks || []).join('');
      if (/"type":"error"/.test(txt)) {
        const m = txt.match(/"message":"([^"]{1,300})"/);
        // 并发满了 / 会话正在启动：过一会再试；别的错误（transcript 不在了、鉴权……）交还给人
        if (/"kind":"busy"/.test(txt) && !liveTurn(e.key, e.sid)) return retry(k, '服务器正忙');
        return drop(k, '没能开跑：' + (m ? m[1] : '未知原因'));
      }
      break;   // 秒完（极短的一轮）
    }
    await new Promise((res) => setTimeout(res, 120));
  }
  // 发出去了：新一轮自己进了 inflight 台账（带着 restartResume 次数），这份待续条目功成身退
  clearTimeout(timers.get(k)); timers.delete(k); tries.delete(k);
  delete state.entries[k];
  save();
  console.log(`[restart-resume] ${short(e.sid)} 已自动继续（第 ${e.attempt} 次）:: ${String(e.userText || '').slice(0, 60)}`);
  busPublish(e.key, { type: 'restart_resume', sessionId: e.sid, fired: true, attempt: e.attempt });
}

/**
 * 服务启动时调（server.mjs，重放口挂好之后）。orphans = initInflight 返回的上一条命没跑完的轮。
 * opts.enabledFor / opts.delayMs 给单测用。返回排上续跑的会话数。
 */
export function initRestartResume(orphans = [], opts = {}) {
  load();
  if (typeof opts.enabledFor === 'function') enabledFor = opts.enabledFor;
  const now = Date.now();
  // 上一条命留下的、还没来得及发出的条目：又熬过一条命，次数用尽就算了
  for (const [k, e] of Object.entries(state.entries)) {
    e.boots = (e.boots || 0) + 1;
    if (e.boots >= MAX_BOOTS) { delete state.entries[k]; console.log(`[restart-resume] ${short(e.sid)} 连着 ${e.boots} 次启动都没来得及发出，放弃`); }
  }
  for (const rec of orphans || []) {
    if (!rec || !rec.sessionId || !rec.key || (rec.agent && rec.agent !== 'claude')) continue;
    const sid = String(rec.sessionId);
    const why = skipReason(rec, now);
    if (why) { console.log(`[restart-resume] ${short(sid)} 不自动继续（${why}）`); continue; }
    state.entries[K(rec.key, sid)] = {
      key: String(rec.key), sid, replay: rec.replay,
      attempt: (Number(rec.resume) || 0) + 1,
      userText: String(rec.userText || '').slice(0, 300),
      dataDir: rec.dataDir || '', cwd: rec.cwd || '', configDir: rec.configDir || null,
      boots: 0, at: now,
    };
  }
  save();
  const keys = Object.keys(state.entries);
  const base = typeof opts.delayMs === 'number' ? opts.delayMs : FIRST_DELAY_MS;
  keys.forEach((k, i) => {
    const e = state.entries[k];
    setResuming(e.key, e.sid, true);
    schedule(k, base + i * STAGGER_MS);
  });
  if (keys.length) console.log(`[restart-resume] ${keys.length} 个被中断的会话将在 ${Math.round(base / 1000)} 秒后自动继续`);
  return keys.length;
}

function skipReason(rec, now) {
  if (!rec.replay || !rec.replay.headers) return '没有可重放的请求身份';
  const attempt = (Number(rec.resume) || 0) + 1;
  if (attempt > MAX_ATTEMPTS) return `已连续自动继续 ${MAX_ATTEMPTS} 次`;
  const lastAlive = Number(rec.beat) || Number(rec.startedAt) || 0;
  if (!lastAlive || now - lastAlive > GIVE_UP_MS) return '中断已超过 12 小时';
  // transcript 都不在（预热空壳、被删掉的会话）：续了也是 No conversation found
  const p = sessionPaths(rec.sessionId, rec.cwd, rec.configDir || null);
  if (!p || !existsSync(p.file)) return '找不到会话记录';
  try { if (!enabledFor({ dataDir: rec.dataDir || '' })) return '设置已关'; } catch {}
  return '';
}

// 单测用：不等计时器，立刻发
export function _fireForTest(key, sid) { load(); return fire(K(key, sid)); }
export function _pendingForTest() { load(); return Object.values(state.entries).map((e) => ({ key: e.key, sid: e.sid, attempt: e.attempt, boots: e.boots || 0 })); }
export function _resetForTest() {
  load();
  for (const t of timers.values()) clearTimeout(t);
  timers.clear(); tries.clear();
  state = { entries: {} }; enabledFor = defaultEnabled;
  save();
}
