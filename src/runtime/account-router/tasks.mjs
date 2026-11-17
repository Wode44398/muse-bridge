// 号池任务台账（智能分派用）：每个「任务」绑一个号，记它这一段干了多少、平时一段多大、上下文多长。
//
// 任务 = 一个会话的主线程，或其中一个子 agent，再按模型家族分开：key = `${会话}|${agent}|${家族}`。
// 分家族是因为提示缓存按模型分，换模型本来就要重建缓存，正好重新选号；Haiku 的后台小请求也就不会把主线程的号带偏。
// 一「段」= 连续在发请求的一段时间，空闲超过 IDLE_GAP 算结束（工具跑得特别久时一轮会被切成两段，影响只是估计偏小）。
// 换号只在段与段之间做（除非当前号真用满了），这样一段活不会被拆到两个号上跑。
//
// 主线程的绑定、段大小估计按会话落盘：服务重启后续聊照样回到原来的号（缓存还热就不用重建）。

export const IDLE_GAP = 4 * 60_000;
const MAIN_TTL = 55 * 60_000;    // 主线程提示缓存 1 小时（订阅号），留点余量
const SUB_TTL = 4 * 60_000;      // 子 agent 默认 5 分钟
const GC_AFTER = 2 * 3600_000;   // 内存里的任务闲置这么久就丢
const KEEP_SESSIONS = 400;       // 落盘最多留这么多个会话
const KEEP_DAYS = 7;

// 还没历史时，一段大概多大（MW）。主线程按这一轮开没开工作流、思考档位分三类；会被实测的段大小慢慢带过去。
const CLASS_PRIOR = { 'main:wf': 4, 'main:hi': 1.2, 'main:lo': 0.6, sub: 0.4, haiku: 0.03 };

export const taskKey = (sid, agent, fam) => `${sid}|${agent || ''}|${fam}`;
const classOf = (t) => (t.family === 'haiku' ? 'haiku' : t.agent ? 'sub' : 'main:' + (t.hint || 'lo'));

export function createTasks() {
  const tasks = new Map();     // key -> task
  const sessions = new Map();  // sid -> { at, label, fam: { [family]: { acct, ema, n, ctx } } }  主线程，落盘
  const priors = { ...CLASS_PRIOR };
  const seen = {};             // family -> 最近一次见到的时刻（各家族最近有没有需求）

  function get(sid, agent, fam, now = Date.now()) {
    const key = taskKey(sid, agent, fam);
    let t = tasks.get(key);
    if (!t) {
      t = { key, sid, agent: agent || '', family: fam, acct: '', hint: '', lastAt: 0, inflight: 0, burstW: 0, burstAt: 0, ema: 0, n: 0, ctx: 0 };
      const s = !agent && sessions.get(sid);
      const f = s && s.fam[fam];
      if (f) Object.assign(t, { acct: f.acct || '', ema: f.ema || 0, n: f.n || 0, ctx: f.ctx || 0, lastAt: s.at || 0 });
      tasks.set(key, t);
    }
    seen[fam] = now;
    return t;
  }

  const active = (t, now = Date.now()) => t.inflight > 0 || (t.lastAt > 0 && now - t.lastAt < IDLE_GAP);

  // 段结束：把这一段的量并进任务自己的估计和这一类的先验。
  function endBurst(t) {
    if (t.burstW > 0) {
      t.ema = t.n ? 0.6 * t.ema + 0.4 * t.burstW : t.burstW;
      t.n++;
      const c = classOf(t);
      priors[c] = 0.9 * priors[c] + 0.1 * t.burstW;
      remember(t);
    }
    t.burstW = 0; t.burstAt = 0;
  }

  function remember(t) {
    if (t.agent || !t.sid) return;
    let s = sessions.get(t.sid);
    if (!s) sessions.set(t.sid, (s = { at: 0, label: '', fam: {} }));
    s.at = Math.max(s.at, t.lastAt);
    s.fam[t.family] = { acct: t.acct, ema: +t.ema.toFixed(4), n: Math.min(t.n, 50), ctx: t.ctx };
  }

  /** 这一段预计多大（MW）。 */
  function estimate(t) {
    const prior = priors[classOf(t)] || CLASS_PRIOR.sub;
    if (t.n >= 2) return t.ema;
    if (t.n === 1) return (t.ema + prior) / 2;
    return prior;
  }
  /** 正在跑的任务还要用多少：没到估计就按估计减已用；超了说明是个长活，再按已用的一半留。 */
  function remaining(t) {
    const e = estimate(t);
    return Math.max(e - t.burstW, 0.5 * t.burstW, 0.1 * e);
  }
  /** 换到别的号要重建多少缓存（MW）：上下文 ×（写缓存 − 读缓存）；缓存已过期就不算。 */
  function rebuildCost(t, now = Date.now()) {
    const ttl = t.agent ? SUB_TTL : MAIN_TTL;
    if (!t.ctx || !t.lastAt || now - t.lastAt > ttl) return 0;
    return t.ctx * (t.agent ? 1.15 : 1.9) / 1e6;
  }
  const warm = (t, now = Date.now()) => rebuildCost(t, now) > 0;

  function begin(t, now = Date.now()) {
    if (!active(t, now)) { endBurst(t); t.burstAt = now; }
    t.inflight++;
    t.lastAt = now;
  }
  function end(t, now = Date.now()) {
    t.inflight = Math.max(0, t.inflight - 1);
    t.lastAt = now;
  }
  function addUsage(t, w, ctx) {
    if (w > 0) t.burstW += w;
    if (ctx > 0) t.ctx = ctx;
  }
  function bind(t, acct) { t.acct = acct; remember(t); }

  /** 撞墙后这一轮就停了：段算结束，重发 / 续跑那条按新的一段重新选号。 */
  function stopBurst(t) { endBurst(t); t.lastAt = Math.min(t.lastAt, Date.now() - IDLE_GAP); }

  /** 其它正在跑的任务（预留它们还要用的量）。 */
  function others(except, now = Date.now()) {
    const out = [];
    for (const t of tasks.values()) {
      if (t === except || !t.acct || !active(t, now)) continue;
      out.push({ acct: t.acct, family: t.family, rem: remaining(t), sid: t.sid, sub: !!t.agent });
    }
    return out;
  }

  /** 同一个会话主线程现在绑在哪个号（子 agent、后台小请求优先跟它同号）。 */
  function parentAcct(t) {
    if (!t.agent && t.family !== 'haiku') return '';
    let best = null;
    for (const x of tasks.values()) {
      if (x.sid !== t.sid || x.agent || x.family === 'haiku' || !x.acct) continue;
      if (!best || x.lastAt > best.lastAt) best = x;
    }
    if (best) return best.acct;
    const s = sessions.get(t.sid);
    if (!s) return '';
    const f = Object.entries(s.fam).find(([k]) => k !== 'haiku');
    return f ? f[1].acct || '' : '';
  }

  function find(sid, fam) {
    for (const t of tasks.values()) if (t.sid === sid && !t.agent && (!fam || t.family === fam)) return t;
    return null;
  }
  const forSession = (sid) => [...tasks.values()].filter((t) => t.sid === sid);

  function setLabel(sid, label) {
    if (!sid || !label) return;
    let s = sessions.get(sid);
    if (!s) sessions.set(sid, (s = { at: Date.now(), label: '', fam: {} }));
    s.label = String(label).slice(0, 60);
  }
  const labelOf = (sid) => (sessions.get(sid) || {}).label || '';

  /** 某个家族最近 72 小时有没有人用（没人用的就不必替它留额度）。 */
  const demanded = (fam, now = Date.now()) => !!seen[fam] && now - seen[fam] < 72 * 3600_000;

  function gc(now = Date.now()) {
    for (const [k, t] of tasks) if (!t.inflight && now - t.lastAt > GC_AFTER) { endBurst(t); tasks.delete(k); }
    const cutoff = now - KEEP_DAYS * 86400_000;
    for (const [sid, s] of sessions) if (s.at && s.at < cutoff) sessions.delete(sid);
    if (sessions.size > KEEP_SESSIONS) {
      const old = [...sessions.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, sessions.size - KEEP_SESSIONS);
      for (const [sid] of old) sessions.delete(sid);
    }
  }

  function dump() {
    return { priors, seen, sessions: Object.fromEntries(sessions) };
  }
  function load(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj.priors || {})) if (k in priors && v > 0 && isFinite(v)) priors[k] = v;
    for (const [k, v] of Object.entries(obj.seen || {})) if (v > 0) seen[k] = v;
    for (const [sid, s] of Object.entries(obj.sessions || {})) {
      if (!s || typeof s !== 'object' || !s.fam) continue;
      sessions.set(sid, { at: Number(s.at) || 0, label: String(s.label || ''), fam: s.fam });
    }
  }

  return {
    get, active, begin, end, addUsage, bind, stopBurst, estimate, remaining, rebuildCost, warm, others, parentAcct,
    find, forSession, setLabel, labelOf, demanded, gc, dump, load, all: () => [...tasks.values()],
  };
}
