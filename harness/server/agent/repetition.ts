// R16（N14，hermes repetition_guard）：文本退化重复检测。本机 Qwen3.8-27B 和便宜模型更容易在长回复里陷进循环；以前被输出上限
// 截断就续写，最多 3 次、不看内容——最坏几十万字的循环经隧道流到手机、落盘，下一轮还被重放，把模型重新带回循环。
//   · 宽松档（截断续写之前用）：≥400 字的正文里，重复出现过的 60 字逐字窗口覆盖一半以上。命中就不再续写（误判的代价只是少续写一次）。
//   · 严格档（被打断时留下的半截用）：另要求不同的行不超过一半——不误伤每行都不一样的批量输出（SQL INSERT、表格）；只有一两行的
//     长文本改为覆盖 ≥80%。命中就把循环的部分换成一句标记，不让循环字节被重放。
const MIN_CHARS = 400;
const WINDOW = 60;
const SCAN_TAIL = 200_000; // 超长的只看最后这么多字（循环都在尾巴上）
const LOOSE_COVERAGE = 0.5; // 两档共用：覆盖不到这么多不算
const STRICT_DISTINCT_LINES = 0.5; // 严格档：不同的行不超过这个比例
const STRICT_SHORT_COVERAGE = 0.8; // 严格档：只有一两行的长文本要覆盖到这么多

// 模型档案（agent/profile.ts）的 loop.repetition 按家族调这几项；默认值就是上面的常量
export interface RepetitionLimits {
  minChars: number;
  window: number;
  scanTail: number;
  looseCoverage: number;
  strictDistinctLines: number;
  strictShortCoverage: number;
}
export const REPETITION_DEFAULTS: Readonly<RepetitionLimits> = Object.freeze({
  minChars: MIN_CHARS,
  window: WINDOW,
  scanTail: SCAN_TAIL,
  looseCoverage: LOOSE_COVERAGE,
  strictDistinctLines: STRICT_DISTINCT_LINES,
  strictShortCoverage: STRICT_SHORT_COVERAGE,
});

export interface RepetitionScan {
  coverage: number; // 被重复窗口覆盖的比例
  distinctLines: number; // 不同的非空行 / 非空行（行数不到 4 时记 1）
  loopStart: number; // 最长那段被覆盖区间的起点（截断处）；没有重复为 -1
}

export function scanRepetition(full: string, lim: RepetitionLimits = REPETITION_DEFAULTS): RepetitionScan {
  const WINDOW = lim.window;
  const offset = Math.max(0, full.length - lim.scanTail);
  const text = full.slice(offset);
  const none = { coverage: 0, distinctLines: 1, loopStart: -1 };
  if (text.length < lim.minChars) return none;
  const first = new Map<string, number>();
  const covered = new Uint8Array(text.length);
  for (let i = 0; i + WINDOW <= text.length; i++) {
    const w = text.slice(i, i + WINDOW);
    const prev = first.get(w);
    if (prev === undefined) first.set(w, i);
    else if (i - prev >= WINDOW) covered.fill(1, i, i + WINDOW); // 存的是第一次出现：周期很短的循环也照样算
  }
  let sum = 0;
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < covered.length; ) {
    if (!covered[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j < covered.length && covered[j]) j++;
    sum += j - i;
    if (j - i > bestLen) {
      bestLen = j - i;
      bestStart = i;
    }
    i = j;
  }
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const distinctLines = lines.length >= 4 ? new Set(lines).size / lines.length : 1;
  return { coverage: sum / text.length, distinctLines, loopStart: bestStart < 0 ? -1 : offset + bestStart };
}

export function isRunawayRepetition(text: string, strict = false, lim: RepetitionLimits = REPETITION_DEFAULTS): boolean {
  const s = scanRepetition(text, lim);
  if (s.coverage < lim.looseCoverage) return false;
  if (!strict) return true;
  const lineCount = text.split("\n").filter((l) => l.trim()).length;
  return lineCount >= 4 ? s.distinctLines <= lim.strictDistinctLines : s.coverage >= lim.strictShortCoverage;
}

// 截到循环开始的地方（循环前的正常内容留着）
export function cutAtLoop(text: string, lim: RepetitionLimits = REPETITION_DEFAULTS): string {
  const { loopStart } = scanRepetition(text, lim);
  return loopStart > 0 ? text.slice(0, loopStart).trimEnd() : "";
}

export const LOOP_CUT_NOTICE = "[The reply degenerated into a repetition loop, so it was cut off here.]";
