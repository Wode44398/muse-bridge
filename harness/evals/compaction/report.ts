// Q6（N47）：压缩召回 eval 的收据。只存数字与会话 id 前 8 位——锚点（路径、哈希、用户原话）是会话内容，不进仓库。
import { ANCHOR_KINDS, type AnchorKind } from "./anchors.ts";
import { AGE_BUCKETS, type ReplayResult, type Tally } from "./replay.ts";

export interface SessionRow {
  session: string; // 会话 id 前 8 位
  arm: string;
  messages: number;
  tokens: number; // 原转录的估算 token
  compactions: number;
  microOnly: number;
  failures: number;
  freed: number[]; // 每次整段压缩腾出的比例
  floor: number[]; // 每次压完剩下的 / 触发线
  byAge: Tally[]; // 各次压缩后的在场召回，按锚点被压过几轮分桶
  present: Record<AnchorKind, Tally>; // 回放结束时的在场召回
  answered?: Record<AnchorKind, Tally>; // 回放结束时的答题召回
  lookups?: number; // R10（二）回查臂：答题时调了几次 Grep / Read
  closed?: Record<AnchorKind, Tally>; // R10（二）回查臂：补查之前那次闭卷答案的召回
}

export function rowOf(
  session: string,
  arm: string,
  tokens: number,
  r: ReplayResult,
  answered?: Record<AnchorKind, Tally>,
  lookups?: number,
  closed?: Record<AnchorKind, Tally>,
): SessionRow {
  const byAge = Array.from({ length: AGE_BUCKETS }, (_, i) => ({
    asked: r.events.reduce((n, e) => n + e.byAge[i].asked, 0),
    recalled: r.events.reduce((n, e) => n + e.byAge[i].recalled, 0),
  }));
  return {
    session: session.slice(0, 8),
    arm,
    messages: r.messages,
    tokens,
    compactions: r.events.length,
    microOnly: r.microOnly,
    failures: r.failures,
    freed: r.events.map((e) => e.freed),
    floor: r.events.map((e) => e.floor),
    byAge,
    present: r.final.byKind,
    answered,
    lookups,
    closed,
  };
}

const sum = (ts: Tally[]): Tally => ({ asked: ts.reduce((n, t) => n + t.asked, 0), recalled: ts.reduce((n, t) => n + t.recalled, 0) });
const cell = (t: Tally): string => (t.asked ? `${t.recalled}/${t.asked}（${Math.round((t.recalled / t.asked) * 100)}%）` : "—");
const pct = (x: number): string => `${Math.round(x * 100)}%`;
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

// 棘轮嫌疑：腾出比例连着 3 次以上单调下降，且最后一次不到 20%（hermes 的 Jev：89%→55%、76%→20%，终于卡死）
export function ratchets(freed: readonly number[]): boolean {
  let run = 1;
  for (let i = 1; i < freed.length; i++) {
    run = freed[i] < freed[i - 1] ? run + 1 : 1;
    if (run >= 3 && freed[i] < 0.2) return true;
  }
  return false;
}

export function report(rows: SessionRow[], { title, note }: { title: string; note: string }): string {
  const arms = [...new Set(rows.map((r) => r.arm))];
  const lines = [`# ${title}`, "", note, ""];

  lines.push("## 召回（回放结束时）", "", "在场 = 锚点还能在上下文里按字符串找到；答题 = 模型只看上下文答题、答案里找得到。只数「来源已不在上下文里原样出现」的锚点。", "");
  lines.push(`| 臂 | 会话 | 整段压缩 | ${ANCHOR_KINDS.map((k) => `在场·${k}`).join(" | ")} | 在场合计 | 答题合计 |`);
  lines.push(`|---|---|---|${ANCHOR_KINDS.map(() => "---").join("|")}|---|---|`);
  for (const arm of arms) {
    const rs = rows.filter((r) => r.arm === arm);
    const kinds = ANCHOR_KINDS.map((k) => sum(rs.map((r) => r.present[k])));
    const answered = rs.filter((r) => r.answered).flatMap((r) => ANCHOR_KINDS.map((k) => r.answered![k]));
    lines.push(`| ${arm} | ${rs.length} | ${rs.reduce((n, r) => n + r.compactions, 0)} | ${kinds.map(cell).join(" | ")} | ${cell(sum(kinds))} | ${answered.length ? cell(sum(answered)) : "（没跑）"} |`);
  }
  // R10（二）回查臂：答题时模型可以 Grep / Read 压缩归档
  for (const arm of arms) {
    const rs = rows.filter((r) => r.arm === arm && r.lookups !== undefined);
    if (!rs.length) continue;
    const asked = rs.reduce((n, r) => n + ANCHOR_KINDS.filter((k) => r.answered?.[k].asked).length, 0);
    const total = rs.reduce((n, r) => n + (r.lookups ?? 0), 0);
    const closed = sum(rs.flatMap((r) => (r.closed ? ANCHOR_KINDS.map((k) => r.closed![k]) : [])));
    const both = sum(rs.flatMap((r) => (r.answered ? ANCHOR_KINDS.map((k) => r.answered![k]) : [])));
    lines.push(
      "",
      `**${arm}** 臂先闭卷答一次、再用 Grep / Read 翻压缩归档补缺（计分取并集）：闭卷 ${cell(closed)} → 加回查 ${cell(both)}；` +
        `共调 ${total} 次（${asked} 问，平均每问 ${asked ? (total / asked).toFixed(1) : "0"} 次）。`,
    );
  }

  lines.push("", "## 反复压缩：在场召回按「被压过几轮」", "", "0 轮 = 这一次刚被压进摘要；1 轮 = 它所在的摘要又被压了一次；以此类推。单调掉到底 = 老信息在反复压缩里蒸发。", "");
  lines.push(`| 臂 | ${Array.from({ length: AGE_BUCKETS }, (_, i) => (i === AGE_BUCKETS - 1 ? `${i}+ 轮` : `${i} 轮`)).join(" | ")} |`);
  lines.push(`|---|${Array.from({ length: AGE_BUCKETS }, () => "---").join("|")}|`);
  for (const arm of arms) {
    const rs = rows.filter((r) => r.arm === arm);
    lines.push(`| ${arm} | ${Array.from({ length: AGE_BUCKETS }, (_, i) => cell(sum(rs.map((r) => r.byAge[i])))).join(" | ")} |`);
  }

  const maxCycles = Math.min(6, Math.max(0, ...rows.map((r) => r.freed.length)));
  if (maxCycles) {
    lines.push("", "## 反复压缩：第 N 次腾出多少 / 压完剩多少（相对触发线）", "");
    lines.push(`| 臂 | ${Array.from({ length: maxCycles }, (_, i) => `第 ${i + 1} 次`).join(" | ")} |`);
    lines.push(`|---|${Array.from({ length: maxCycles }, () => "---").join("|")}|`);
    for (const arm of arms) {
      const rs = rows.filter((r) => r.arm === arm);
      const cols = Array.from({ length: maxCycles }, (_, i) => {
        const at = rs.filter((r) => r.freed.length > i);
        return at.length ? `${pct(mean(at.map((r) => r.freed[i])))} / ${pct(mean(at.map((r) => r.floor[i])))}（n=${at.length}）` : "—";
      });
      lines.push(`| ${arm} | ${cols.join(" | ")} |`);
    }
  }

  lines.push("", "## 棘轮与失败", "");
  for (const arm of arms) {
    const rs = rows.filter((r) => r.arm === arm);
    const suspects = rs.filter((r) => ratchets(r.freed));
    const high = rs.reduce((n, r) => n + r.floor.filter((f) => f >= 0.9).length, 0);
    const failures = rs.reduce((n, r) => n + r.failures, 0);
    lines.push(
      `- **${arm}**：棘轮嫌疑 ${suspects.length} 个会话${suspects.length ? `（${suspects.map((r) => r.session).join("、")}）` : ""}；` +
        `压完仍 ≥ 90% 触发线 ${high} 次；压缩失败 ${failures} 次；只靠微压缩就够了 ${rs.reduce((n, r) => n + r.microOnly, 0)} 次`,
    );
  }

  lines.push("", "## 逐会话", "", "| 会话 | 臂 | 消息 | token | 压缩 | 腾出（逐次） | 在场 | 答题 |", "|---|---|---|---|---|---|---|---|");
  for (const r of rows) {
    const present = sum(ANCHOR_KINDS.map((k) => r.present[k]));
    const answered = r.answered ? cell(sum(ANCHOR_KINDS.map((k) => r.answered![k]))) : "—";
    lines.push(`| ${r.session} | ${r.arm} | ${r.messages} | ${r.tokens} | ${r.compactions} | ${r.freed.map(pct).join(" → ") || "—"} | ${cell(present)} | ${answered} |`);
  }
  return lines.join("\n") + "\n";
}
