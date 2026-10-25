// 一条消息从进服务端到交给 Claude CLI 的分段计时（排查「发了半天没反应」：模型还没开口时，
// 时间到底花在服务端哪一段）。每轮一行日志，超过 SLOW_MS 带 SLOW 前缀方便 grep。
//
//   [claude] timing a0f44122 handed to CLI in 312ms via warm (body 2 · route 11 · env 1 · last 3)
// 段名：body 读请求体 · pre 鉴权与会话检查 · route 号池选号 · env 取 token / 代理 · prep 收尾前准备 ·
// fin-wait 等上一轮定局收尾 · prev-stop 等上一轮停干净 · last 到交出为止的其余部分；为 0 的段不打。
// via：spare 预热进程 / warm 停放进程 / handoff 挂起接力 / steer 插话 / cold 新起 CLI。
//
// 计时起点挂在 req 上（chat 路由一进门就打）：排队重放的假请求起点是入队时刻，等待时长也算进去。

const SLOW_MS = 5000;
const T0 = Symbol('turnTimingT0');
const MARKS = Symbol('turnTimingMarks');

/** 路由一进门调：记起点（已有就不覆盖——排队重放预先写入了入队时刻）。 */
export function startTurnTiming(req, at = Date.now()) {
  if (!req || req[T0]) return;
  req[T0] = at;
  req[MARKS] = [];
}

/** 打一个分段点：记的是「距上一个点」的耗时。 */
export function markTurn(req, name) {
  if (!req || !req[T0]) return;
  req[MARKS].push([name, Date.now()]);
}

/** 交给 CLI 那一刻调：打一行日志并清掉，同一个 req 只打一次。 */
export function handedTurn(req, sessionId, via) {
  if (!req || !req[T0]) return;
  const t0 = req[T0];
  const marks = req[MARKS] || [];
  req[T0] = 0;
  const now = Date.now();
  let prev = t0;
  const parts = [];
  for (const [name, at] of [...marks, ['last', now]]) {
    const d = at - prev;
    prev = at;
    if (d > 0 || name === 'last') parts.push(`${name} ${d}`);
  }
  const total = now - t0;
  const sid = sessionId ? String(sessionId).slice(0, 8) : 'new';
  console.log(`[claude] ${total >= SLOW_MS ? 'SLOW ' : ''}timing ${sid} handed to CLI in ${total}ms via ${via} (${parts.join(' · ')})`);
}
