// R15（K13 / K6，hermes N22 修订，B9）：分级重复熔断。人不在场时，模型换着花样重复同一个失败的调用，是最常见的无声烧钱；
// 硬预算会误杀正常的长任务，重复熔断只在真卡住时出手。三个维度，每次执行完一批工具按调用顺序喂进来：
//   · 同一个调用（工具名 + 规范化参数）连着重复：第 3、5、8 次提醒，第 12 次熔断；
//   · 失败：同一个调用（同参）失败第 2 次提醒、第 5 次熔断；同一个工具连着失败第 3 次提醒、第 8 次熔断；
//   · 周期：最近的调用是同一段 2–4 个调用连着重复 3 遍（A,B,A,B,A,B），提醒；第 3 次发现熔断。
// 提醒追加在这次调用的结果末尾（只追加，不改写已有前缀）。熔断只在无人值守（离开模式）时真停——有人在场只警告（#71：
// 照常默认有人在）。轮询（Bash poll）本来就要重复，不计。
export interface GuardVerdict {
  note?: string; // 追加到这次调用结果末尾的提醒
  stop?: string; // 该熔断了（理由）；有人在场时调用方只把它当提醒
}

const REPEAT_NOTES: Record<number, (name: string) => string> = {
  3: (name) =>
    `[Loop guard] This is the 3rd ${name} call in a row with exactly the same arguments. If the result is not changing, ` +
    "change your approach instead of repeating it.",
  5: () =>
    "[Loop guard] 5 identical calls in a row. Repeating it will not produce a different result — step back, re-read the " +
    "output or error, and try something different.",
  8: () =>
    "[Loop guard] 8 identical calls in a row. Stop repeating this call. If you are blocked, say what is blocking you.",
};
const REPEAT_STOP = 12;
const SAME_ARGS_FAIL = { note: 2, stop: 5 };
const SAME_TOOL_FAIL = { note: 3, stop: 8 };
const CYCLE_STOP = 3; // 第几次发现周期时熔断

function normalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(normalize);
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, normalize((v as Record<string, unknown>)[k])]));
  }
  return v;
}
export const callKey = (name: string, args: Record<string, unknown>): string => `${name} ${JSON.stringify(normalize(args ?? {}))}`;

// 本来就要重复的调用：轮询后台 job
const exempt = (name: string, args: Record<string, unknown>) => name === "Bash" && Boolean(args?.poll || args?.wait); // O6：wait 同理

export class LoopGuard {
  private history: string[] = [];
  private names: string[] = [];
  private streak = { key: "", count: 0 };
  private failByKey = new Map<string, number>();
  private failStreak = { name: "", count: 0 };
  private cycleSeen = 0;
  private inCycle = false;

  observe(name: string, args: Record<string, unknown>, ok: boolean): GuardVerdict {
    if (exempt(name, args)) return {};
    const key = callKey(name, args);
    const notes: string[] = [];
    let stop: string | undefined;

    // 同一个调用连着重复
    this.streak = this.streak.key === key ? { key, count: this.streak.count + 1 } : { key, count: 1 };
    const n = this.streak.count;
    if (REPEAT_NOTES[n]) notes.push(REPEAT_NOTES[n](name));
    if (n >= REPEAT_STOP && (n - REPEAT_STOP) % 4 === 0) {
      stop = `the same ${name} call was repeated ${n} times in a row`;
      notes.push(`[Loop guard] ${n} identical calls in a row — this is a loop. Stop and report what is blocking you.`);
    }

    // 失败维度
    if (ok) {
      this.failByKey.delete(key);
      if (this.failStreak.name === name) this.failStreak = { name: "", count: 0 };
    } else {
      const same = (this.failByKey.get(key) ?? 0) + 1;
      this.failByKey.set(key, same);
      if (same === SAME_ARGS_FAIL.note) notes.push(`[Loop guard] This exact call has now failed ${same} times. Do not retry it unchanged — fix the cause first.`);
      if (same >= SAME_ARGS_FAIL.stop) stop ??= `the same failing ${name} call was retried ${same} times`;
      this.failStreak = this.failStreak.name === name ? { name, count: this.failStreak.count + 1 } : { name, count: 1 };
      const streak = this.failStreak.count;
      if (streak === SAME_TOOL_FAIL.note) notes.push(`[Loop guard] ${name} has failed ${streak} times in a row. Reconsider the approach before calling it again.`);
      if (streak >= SAME_TOOL_FAIL.stop) stop ??= `${name} failed ${streak} times in a row`;
    }

    // 周期：最近 3p 个调用是同一段 p 个调用（至少两种）连着重复 3 遍
    this.history.push(key);
    this.names.push(name);
    if (this.history.length > 24) {
      this.history.shift();
      this.names.shift();
    }
    const period = [2, 3, 4].find((p) => this.repeats(p));
    if (period && !this.inCycle) {
      this.inCycle = true;
      this.cycleSeen++;
      const seq = this.names.slice(-period).join(" → ");
      notes.push(`[Loop guard] You are repeating the same sequence of ${period} calls (${seq}) without progress. Break the cycle.`);
      if (this.cycleSeen >= CYCLE_STOP) stop ??= `the same sequence of ${period} calls was repeated again and again`;
    } else if (!period) {
      this.inCycle = false;
    }

    return { ...(notes.length ? { note: notes.join("\n") } : {}), ...(stop ? { stop } : {}) };
  }

  private repeats(p: number): boolean {
    const h = this.history;
    if (h.length < 3 * p) return false;
    const block = h.slice(-p);
    if (new Set(block).size < 2) return false; // 同一个调用重复归「连着重复」管
    for (let r = 2; r <= 3; r++) {
      const earlier = h.slice(-r * p, -(r - 1) * p);
      if (earlier.some((k, i) => k !== block[i])) return false;
    }
    return true;
  }
}

export function loopStopText(reason: string): string {
  return (
    `[Loop guard] Stopping this run: ${reason}. Nobody is attending this run, so it will not keep repeating. Reply with a ` +
    "concise summary of what you tried, what failed, and what you need from the user. Further tool calls will NOT be executed."
  );
}
