// 智能分派（号池路由的第三种策略，见 account-router.mjs 文件头）：每个任务各绑一个号，模型请求经本机上游代理时按任务现选号。
//
// 什么时候选号：
//   · 任务第一次发请求：按 placement.rankAccounts 挑；
//   · 一段结束后又开新的一段（空闲超过 tasks.IDLE_GAP）：重新打分，留在原号有缓存加分——原号装不下这一段、或别处明显更合适时才换；
//   · 段中间：不动。只有当前号对这个模型真被挡住了（快满 / 用满 / 撞墙冷却），且开着「会话中无缝换号」，才在两次请求之间换走；
//     没开就让它在原号上撞墙，这一轮停下，重发 / 续跑那条再重新选号（老的轮级重试照常接得上）。
// 账号额度、冷却、Pro 没有 Fable 这些判断全用 account-router 的 accountBlock，跟老策略同一套口径。

import { familyOf } from './buckets.mjs';
import { rankAccounts, reasonFor } from './placement.mjs';
import { createMeter, usageWeight, contextTokens } from './meter.mjs';
import { createTasks } from './tasks.mjs';

const LOG_MAX = 30;

/**
 * deps:
 *   listAccounts()                      [{ id, label }]（列表顺序 = 同分时的先后）
 *   accountLimits(id)                   status.accountLimits
 *   planOf(id)                          套餐代号
 *   blocked(id, model, { soft })        account-router.accountBlock（null = 能用）
 *   midSwitch()                         「会话中无缝换号」开着没
 *   onChange()                          状态变了（落盘用）
 */
export function createDispatch(deps) {
  const meter = createMeter({ planOf: deps.planOf, limitsOf: deps.accountLimits });
  const tasks = createTasks();
  const log = [];
  const labelOf = (id) => { const a = deps.listAccounts().find((x) => x.id === id); return a ? a.label : id; };
  const exists = (id) => !!id && deps.listAccounts().some((a) => a.id === id);
  const changed = () => { try { deps.onChange && deps.onChange(); } catch {} };

  function snapshot(fam) {
    const model = fam;   // relevantBucket / accountBlock 都认家族名
    return deps.listAccounts().map((a, idx) => {
      const blocked = {};
      for (const f of ['fable', 'opus', 'sonnet', 'haiku']) blocked[f] = !!deps.blocked(a.id, f, { soft: false });
      return { id: a.id, idx, plan: deps.planOf(a.id), limits: deps.accountLimits(a.id) || {}, blocked, soft: !!deps.blocked(a.id, model, { soft: true }) };
    });
  }

  function rank(t, { exclude = '' } = {}) {
    const now = Date.now();
    const accounts = snapshot(t.family).filter((a) => a.id !== exclude);
    const current = exists(t.acct) && t.acct !== exclude ? t.acct : '';
    const task = { family: t.family, est: tasks.estimate(t), rebuild: tasks.rebuildCost(t, now), warm: tasks.warm(t, now), current, parent: tasks.parentAcct(t) };
    const rows = rankAccounts({ accounts, task, others: tasks.others(t, now), rate: meter.rate, demanded: (f) => tasks.demanded(f, now), now });
    return { rows, task };
  }

  function note(kind, t, from, to, reason, est) {
    // 子 agent 与后台小请求太多，只记分到跟主线程不同号的那些；主线程的每次落位 / 换号都记。
    const entry = {
      at: Date.now(), kind, sid: t.sid, agent: t.agent || '', label: tasks.labelOf(t.sid), family: t.family,
      from: from || '', to, fromLabel: from ? labelOf(from) : '', toLabel: labelOf(to), reason, est: +est.toFixed(3),
    };
    log.unshift(entry);
    if (log.length > LOG_MAX) log.length = LOG_MAX;
    console.log(`[account-router] ${kind} ${t.sid.slice(0, 8)}${t.agent ? '/' + t.agent.slice(0, 6) : ''} ${t.family} ${from ? entry.fromLabel + ' → ' : '→ '}${entry.toLabel} (${reason})`);
    return entry;
  }

  /**
   * 一个模型请求该用哪个号。sid = X-Claude-Code-Session-Id，agent = x-claude-code-agent-id；
   * hint = 'wf' | 'hi' | 'lo'（这一轮开了工作流 / 思考档位高 / 其余），新任务没历史时按它估大小。
   * 返回 { acct, task, entry }：entry 非空 = 这次换了号（kind 'move' 原号被挡住换走、'rebalance' 原号还能用但新一段开跑前挑了更合适的号、
   * 'place' 新任务落位、'sub' 子 agent 落到跟主线程不同的号）。
   * 返回 null = 不归智能分派管（不认识的模型），调用方按老办法用激活号。
   */
  function pick({ sid, agent = '', model, hint = '' }) {
    const fam = familyOf(model);
    if (!sid || fam === 'other') return null;
    const now = Date.now();
    const t = tasks.get(sid, agent, fam, now);
    if (hint && !agent) t.hint = hint;
    const cur = exists(t.acct) ? t.acct : '';
    const running = tasks.active(t, now);
    if (cur && running) {
      const hard = deps.blocked(cur, model, { soft: false });
      const soft = !hard && deps.midSwitch() && deps.blocked(cur, model, { soft: true });
      if (!hard && !soft) return { acct: cur, task: t, entry: null };
      if (!deps.midSwitch()) return { acct: cur, task: t, entry: null };   // 不在段中换号：让它撞墙停下，轮级重试再选
      const { rows, task } = rank(t, { exclude: cur });
      if (!rows.length) return { acct: cur, task: t, entry: null };
      tasks.bind(t, rows[0].id);
      changed();
      const why = hard ? hard.type || 'limit' : 'near:' + (soft.type || 'limit');
      return { acct: rows[0].id, task: t, entry: note('move', t, cur, rows[0].id, why, task.est) };
    }
    const { rows, task } = rank(t);
    if (!rows.length) return cur ? { acct: cur, task: t, entry: null } : null;
    const best = rows[0].id;
    if (best === cur) return { acct: cur, task: t, entry: null };
    tasks.bind(t, best);
    changed();
    // 换走的原因：原号被挡住了就报挡住它的那个桶（快满 = near:<桶>），否则跟原号比哪一项差得最多
    const cb = cur ? deps.blocked(cur, model, { soft: true }) : null;
    const hb = cb ? deps.blocked(cur, model, { soft: false }) : null;
    // move = 原号被挡住才换走；rebalance = 原号还能用、新一段开跑前挑了更合适的号
    const kind = !cur ? 'place' : cb ? 'move' : 'rebalance';
    const worth = kind !== 'place' || (!t.agent && fam !== 'haiku') || (task.parent && best !== task.parent && fam !== 'haiku');
    const reason = cb ? (hb ? hb.type || 'limit' : 'near:' + (cb.type || 'limit')) : reasonFor(rows, task, cur);
    return { acct: best, task: t, entry: worth ? note(t.agent && kind === 'place' ? 'sub' : kind, t, cur, best, reason, task.est) : null };
  }

  /** 不发模型请求的旁路（count_tokens 等）：这个会话主线程现在绑在哪个号。 */
  function boundAccount(sid) {
    const t = sid && tasks.find(sid);
    return t && exists(t.acct) ? t.acct : '';
  }

  const begin = (t) => tasks.begin(t);
  const end = (t) => tasks.end(t);

  /** 一次响应结束：记用量（任务的这一段 + 计量）。 */
  function usage(t, acct, model, u) {
    const w = usageWeight(u);
    if (t) tasks.addUsage(t, w, contextTokens(u));
    meter.addUsage(acct, familyOf(model), w);
    if (w > 0) changed();
  }

  /** 响应头读数（各桶整数百分点 + 重置时刻），记到实际服务的号名下。 */
  function readings(acct, buckets) {
    let learned = false;
    for (const [k, b] of Object.entries(buckets || {})) if (b && meter.observe(acct, k, b.pct, b.resetsAt)) learned = true;
    if (learned) changed();
  }

  /** 撞墙（这个号对这个任务的模型被拒）：这一段结束，下一条请求按新的一段重新选号。 */
  function limitHit(t) { if (t) tasks.stopBurst(t); }

  /** 轮级撞墙（claude.mjs / headless-turn 那条路）：这个会话的主线程任务都按新段重选；给出它大概会被换到哪。 */
  function sessionLimitHit(sid, acct, model) {
    const fam = familyOf(model);
    for (const t of tasks.forSession(sid)) if (!t.agent) tasks.stopBurst(t);
    if (fam === 'other') return null;
    const t = tasks.get(sid, '', fam);
    const { rows, task } = rank(t, { exclude: acct });
    if (!rows.length) return null;
    const to = rows[0].id;
    tasks.bind(t, to);
    changed();
    return note('move', t, acct, to, '', task.est);
  }

  function setLabel(sid, label) { tasks.setLabel(sid, label); }

  /** 控制台 / 设置页：每个号上正在跑的任务、预计用量与学到的速率，最近的分派。 */
  function status() {
    const now = Date.now();
    const per = {};
    for (const a of deps.listAccounts()) per[a.id] = { tasks: 0, subs: 0, learned: meter.learned(a.id) };
    const running = [];
    for (const t of tasks.all()) {
      if (!t.acct || !tasks.active(t, now) || !per[t.acct]) continue;
      if (t.agent) per[t.acct].subs++; else if (t.family !== 'haiku') per[t.acct].tasks++;
      if (!t.agent && t.family !== 'haiku') {
        running.push({ sid: t.sid, label: tasks.labelOf(t.sid), family: t.family, acct: t.acct, used: +t.burstW.toFixed(3), est: +tasks.estimate(t).toFixed(3) });
      }
    }
    return { accounts: per, running, log: log.slice(0, 15) };
  }

  function dump() { return { v: 1, meter: meter.dump(), tasks: tasks.dump() }; }
  function load(obj) {
    if (!obj || obj.v !== 1) return;
    meter.load(obj.meter);
    tasks.load(obj.tasks);
  }
  const gc = () => tasks.gc();

  return { pick, boundAccount, begin, end, usage, readings, limitHit, sessionLimitHit, setLabel, status, dump, load, gc, _meter: meter, _tasks: tasks };
}
