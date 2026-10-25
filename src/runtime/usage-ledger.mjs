// 按人记账：每一轮到底花了多少（开源路线 S2-6「记账不重复累计」）。
//
// Claude Code 每个 result 帧带的 total_cost_usd 不是「这一轮」，而是 CLI 进程里的累计值：
//   · 同一个 CLI 连跑几轮（bridge 停放复用、挂起接力），每轮报的是从进程起到现在的总和；
//   · 冷起续聊（resume）时，CLI 先从 transcript 里该会话最后一条 cost-state 恢复整段会话的历史总花费
//     （2.1.252 起；按会话 id、后写的算数），再往上加。
// 以前 bridge 每轮把它整个加进账本：一段聊了 $15 的老会话，再问一句就记 $18——额度提前打满、控制台账单虚高
//（实测 howansiong 10-21 一轮记了 $18.99，transcript 里该会话的 cost-state 从 $15.84 涨到 $19.07）。
//
// 现在按「同一个 CLI 进程上一次报的值」取差：
//   · 开跑前读出该会话 transcript 里最后一条 cost-state（= CLI 将要恢复的起点）作为基线；新会话基线 0；
//   · 每个 result：本轮 = 累计 − 上次；累计比上次还小（换了会话、CLI 没恢复）就当从零算起，整段都是新花的。
// tokens 不受影响：result.usage 本来就是这一轮的（每轮一个新的 QueryEngine）。

import { open } from 'node:fs/promises';

const NEEDLE = Buffer.from('"cost-state"');
const SCAN_MAX = 32 * 1024 * 1024;   // 最多往回读这么多：cost-state 每次 CLI 退出都写，通常就在文件末尾
const CHUNK = 256 * 1024;

// 只认 CLI 自己也会认的那种（2.1.299 costStateSchema：必须带 sessionId，几项累计数都是非负有限数，modelUsage 是对象）——
// CLI 不认、只有我们认的行（缺字段、没有会话 id）拿来当起点，就能把这一轮记少。会话 id 给了就必须一致。
const num = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function costOf(line, sessionId) {
  try {
    const o = JSON.parse(line);
    if (!o || o.type !== 'cost-state') return null;
    if (typeof o.sessionId !== 'string' || !o.sessionId) return null;
    if (sessionId && o.sessionId !== sessionId) return null;
    if (!['totalAPIDuration', 'totalDuration', 'startTime'].every((k) => num(o[k]))) return null;
    if (!o.modelUsage || typeof o.modelUsage !== 'object' || Array.isArray(o.modelUsage)) return null;
    const v = o.totalCostUSD;
    return num(v) && v <= 1e9 ? v : null;
  } catch { return null; }
}

/**
 * 这个会话 transcript 里最后一条 cost-state 的累计花费（CLI 续聊时从它恢复）；没有 / 读不了 → 0。
 * 从文件尾往前按块读，碰到第一条匹配的就停。
 */
export async function sessionCostBaseline(file, sessionId = '') {
  if (!file) return 0;
  let fh;
  try { fh = await open(file, 'r'); } catch { return 0; }
  try {
    const { size } = await fh.stat();
    let pos = size, scanned = 0;
    let carry = Buffer.alloc(0);   // 上一块（文件里更靠后的那块）开头那半行
    while (pos > 0 && scanned < SCAN_MAX) {
      const n = Math.min(CHUNK, pos);
      pos -= n; scanned += n;
      const buf = Buffer.alloc(n);
      await fh.read(buf, 0, n, pos);
      const all = carry.length ? Buffer.concat([buf, carry]) : buf;
      const first = pos > 0 ? all.indexOf(0x0a) : -1;
      // 还没碰到换行：整块都是某一行的后半截，接着往前读
      if (pos > 0 && first < 0) { carry = all; continue; }
      carry = first >= 0 ? all.subarray(0, first) : Buffer.alloc(0);
      const body = first >= 0 ? all.subarray(first + 1) : all;
      if (body.indexOf(NEEDLE) < 0) continue;
      const lines = body.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        if (!lines[i].includes('"cost-state"')) continue;
        const v = costOf(lines[i], sessionId);
        if (v != null) return v;
      }
    }
    if (pos === 0 && carry.length && carry.indexOf(NEEDLE) >= 0) {
      const v = costOf(carry.toString('utf8'), sessionId);
      if (v != null) return v;
    }
    return 0;
  } catch { return 0; } finally { try { await fh.close(); } catch {} }
}

/**
 * 一个 CLI 进程的计价表：turnCost(result.total_cost_usd) → 这一轮新花的美元数。
 * @param {number} baseline 进程起点的累计值（续聊 = sessionCostBaseline，新会话 = 0）
 */
export function makeCostMeter(baseline = 0) {
  let last = Number(baseline);
  if (!Number.isFinite(last) || last < 0) last = 0;
  return {
    turnCost(cumulative) {
      const c = Number(cumulative);
      if (!Number.isFinite(c) || c <= 0) return 0;
      const d = c + 1e-9 < last ? c : c - last;
      last = c;
      return Math.round(Math.max(0, d) * 1e6) / 1e6;
    },
    get last() { return last; },
  };
}
