// 模型档案 P0：矩阵模式的决策收据。臂 = 型号 ×（可选）档案配置；表一是跨臂汇总（通过率 + Wilson 95% 区间、pass^k、
// 中位 token / 步数 / 耗时、工具失败率、编辑失败率、自称完成但没过），表二是题 × 臂的通过矩阵，表三是分维度得分，
// 之后是错误类别与过程信号，最后逐条列没通过的 run（n 小，必须逐 run 审）。老账本没有细项指标的行照样计通过率。
import { ERROR_CATEGORIES, type ErrorCategory } from "./metrics.ts";
import type { RunRow } from "./lib.ts";
import { median, passHatK, pct, ratio, wilson } from "./stats.ts";
import { DIMENSIONS, taskById } from "./tasks.ts";

const k = (n: number) => `${Math.round(n / 1000)}k`;
const sec = (ms: number) => `${Math.round(ms / 1000)}s`;

interface ArmSummary {
  arm: string;
  runs: number;
  passed: number;
  ci: [number, number];
  passK: number | null;
  medTokens: number;
  medSteps: number;
  medWall: number;
  toolFailRate: number | null;
  editFailRate: number | null;
  falseDone: number;
  budgetHit: number;
}

function summarize(arm: string, rows: RunRow[], kRep: number): ArmSummary {
  const passed = rows.filter((r) => r.pass).length;
  const perTask = [...new Set(rows.map((r) => r.task))].map((t) => {
    const rs = rows.filter((r) => r.task === t);
    return [rs.filter((r) => r.pass).length, rs.length] as [number, number];
  });
  const withM = rows.filter((r) => r.m);
  const calls = withM.reduce((n, r) => n + r.m!.toolCalls, 0);
  const fails = withM.reduce((n, r) => n + r.m!.toolFailed, 0);
  const eCalls = withM.reduce((n, r) => n + r.m!.editCalls, 0);
  const eFails = withM.reduce((n, r) => n + r.m!.editFailed, 0);
  return {
    arm,
    runs: rows.length,
    passed,
    ci: wilson(passed, rows.length),
    passK: passHatK(perTask, kRep),
    medTokens: median(rows.map((r) => r.tokens)),
    medSteps: median(rows.map((r) => r.turns)),
    medWall: median(rows.map(activeOf)),
    toolFailRate: ratio(fails, calls),
    editFailRate: ratio(eFails, eCalls),
    falseDone: rows.filter((r) => r.claimedDone && !r.pass).length,
    budgetHit: withM.filter((r) => r.m!.budgetExhausted).length,
  };
}

// 耗时只算模型在跑的时间（各条消息的流）：wallMs 还含每条之后等记录落定、等记忆沉淀，多轮题会偏大。老账本没有 activeMs 用 wallMs。
const activeOf = (r: RunRow): number => r.activeMs ?? r.wallMs;

export function matrixReport(rows: RunRow[], { title, arms, note = "" }: { title: string; arms: string[]; note?: string }): string {
  const tasks = [...new Set(rows.map((r) => r.task))];
  // pass^k 的 k = 每格的最多次数（计划的重复数）；还没跑满 k 次的格子不计入（passHatK 里跳过）
  const kRep = Math.max(1, ...tasks.flatMap((t) => arms.map((a) => rows.filter((r) => r.task === t && r.arm === a).length)));
  const dimOf = (task: string) => rows.find((r) => r.task === task && r.dimension)?.dimension ?? taskById(task)?.dimension ?? "日常";
  const lines = [`# ${title}`, "", note, ""];

  // 表一：跨臂汇总
  lines.push(
    "## 汇总",
    "",
    `| 臂 | 通过 | 通过率（95% 区间） | pass^${kRep} | 中位 token | 中位步数 | 中位耗时 | 工具失败率 | 编辑失败率 | 自称完成但没过 | 撞预算 |`,
    "|---|---|---|---|---|---|---|---|---|---|---|",
  );
  for (const arm of arms) {
    const s = summarize(arm, rows.filter((r) => r.arm === arm), kRep);
    lines.push(
      `| ${arm} | ${s.passed}/${s.runs} | ${pct(ratio(s.passed, s.runs))}（${pct(s.ci[0])}–${pct(s.ci[1])}） | ${pct(s.passK)} | ${k(s.medTokens)} | ${s.medSteps} | ${sec(s.medWall)} | ${pct(s.toolFailRate, 1)} | ${pct(s.editFailRate, 1)} | ${s.falseDone} | ${s.budgetHit} |`,
    );
  }

  // 表二：题 × 臂的通过矩阵
  lines.push("", "## 逐题通过（通过次数/总次数）", "", `| 题 | 维度 | 难度 | ${arms.join(" | ")} |`, `|---|---|---|${arms.map(() => "---").join("|")}|`);
  for (const task of tasks) {
    const cells = arms.map((arm) => {
      const rs = rows.filter((r) => r.task === task && r.arm === arm);
      return rs.length ? `${rs.filter((r) => r.pass).length}/${rs.length}` : "—";
    });
    lines.push(`| ${task} | ${dimOf(task)} | ${taskById(task)?.difficulty ?? "—"} | ${cells.join(" | ")} |`);
  }

  // 表三：分维度得分（该维度下全部 run 的通过率；括号里是 run 数）
  lines.push("", "## 分维度", "", `| 维度 | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---").join("|")}|`);
  for (const dim of DIMENSIONS) {
    const inDim = rows.filter((r) => dimOf(r.task) === dim);
    if (!inDim.length) continue;
    const cells = arms.map((arm) => {
      const rs = inDim.filter((r) => r.arm === arm);
      const p = rs.filter((r) => r.pass).length;
      return rs.length ? `${pct(ratio(p, rs.length))}（${p}/${rs.length}）` : "—";
    });
    lines.push(`| ${dim} | ${cells.join(" | ")} |`);
  }

  // 错误类别（全部失败的工具调用按类别计数）与过程信号
  const withM = rows.filter((r) => r.m);
  if (withM.length) {
    const cats = Object.keys(ERROR_CATEGORIES) as ErrorCategory[];
    lines.push("", "## 工具失败按类别（次数）", "", `| 类别 | ${arms.join(" | ")} |`, `|---|${arms.map(() => "---").join("|")}|`);
    for (const c of cats) {
      const cells = arms.map((arm) => withM.filter((r) => r.arm === arm).reduce((n, r) => n + (r.m!.errors[c] ?? 0), 0));
      if (cells.some((n) => n > 0)) lines.push(`| ${ERROR_CATEGORIES[c]} | ${cells.join(" | ")} |`);
    }
    lines.push(
      "",
      "## 过程信号（全部 run 合计）",
      "",
      `| 信号 | ${arms.join(" | ")} |`,
      `|---|${arms.map(() => "---").join("|")}|`,
    );
    const total = (arm: string, f: (r: RunRow) => number) => withM.filter((r) => r.arm === arm).reduce((n, r) => n + f(r), 0);
    const signal = (label: string, f: (r: RunRow) => number, fmt: (n: number) => string = String) =>
      lines.push(`| ${label} | ${arms.map((arm) => fmt(total(arm, f))).join(" | ")} |`);
    lines.push(`| 工具调用 / 失败 | ${arms.map((arm) => `${total(arm, (r) => r.m!.toolCalls)} / ${total(arm, (r) => r.m!.toolFailed)}`).join(" | ")} |`);
    lines.push(`| Edit+Write 调用 / 失败 | ${arms.map((arm) => `${total(arm, (r) => r.m!.editCalls)} / ${total(arm, (r) => r.m!.editFailed)}`).join(" | ")} |`);
    signal("输入 token", (r) => r.m!.tokens.input, k);
    signal("其中缓存读", (r) => r.m!.tokens.cacheRead, k);
    signal("输出 token", (r) => r.m!.tokens.output, k);
    signal("思考（估，字符/4）", (r) => r.m!.tokens.thinkingEst, k);
    signal("仅思考回合", (r) => r.m!.thinkingOnlyTurns);
    signal("截断续写", (r) => r.m!.lengthContinues);
    signal("门禁追问", (r) => Object.values(r.m!.nudges).reduce((a, b) => a + b, 0));
    signal("loop-guard", (r) => r.m!.loopGuard);
    signal("被权限规则 / 同意拒绝（不含工作区围栏）", (r) => r.m!.denied);
    lines.push(`| 最长连续相同调用（各 run 最大值） | ${arms.map((arm) => Math.max(0, ...withM.filter((r) => r.arm === arm).map((r) => r.m!.maxIdenticalStreak))).join(" | ")} |`);
    // 适配信号（signals.ts，与转录回放同一口径）：老账本没有 sig 的 run 不计
    const sg = (label: string, f: (r: RunRow) => number) => {
      if (rows.some((r) => r.sig)) lines.push(`| ${label} | ${arms.map((arm) => rows.filter((r) => r.arm === arm && r.sig).reduce((n, r) => n + f(r), 0)).join(" | ")} |`);
    };
    sg("先读后改拦截", (r) => r.sig!.errors["read-gate"] ?? 0);
    sg("verify:true 吞退出码被打回", (r) => r.sig!.contract["verify-status"] ?? 0);
    sg("参数类失败（JSON / 缺参 / 别名 / 类型）", (r) => Object.values(r.sig!.badArgs).reduce((a, b) => a + (b ?? 0), 0));
    sg("正文里写工具调用", (r) => r.sig!.textToolCalls);
    sg("空回合", (r) => r.sig!.emptyTurns);
    sg("纯等待（sleep 类）", (r) => r.sig!.waitPolls);
    sg("失败后原样重发", (r) => r.sig!.failThenSame);
    sg("换行 / BOM 被改的文件数", (r) => r.eolFlips?.length ?? 0);
  }

  // 成本：每臂合计
  lines.push("", "## 成本（合计）", "", "| 臂 | token（全部任务，含旁路） | 耗时 |", "|---|---|---|");
  for (const arm of arms) {
    const rs = rows.filter((r) => r.arm === arm);
    lines.push(`| ${arm} | ${k(rs.reduce((n, r) => n + r.tokens, 0))} | ${sec(rs.reduce((n, r) => n + activeOf(r), 0))} |`);
  }

  const misses = rows.filter((r) => !r.pass);
  if (misses.length) {
    lines.push("", "## 没通过的 run（逐条审）", "");
    for (const r of misses) {
      const errs = r.m ? Object.entries(r.m.errors).map(([c, n]) => `${ERROR_CATEGORIES[c as ErrorCategory]}×${n}`).join("、") : "";
      lines.push(
        `- **${r.task} · ${r.arm} · 第 ${r.rep} 次**：${r.detail}；收场 ${r.outcome}${r.m ? `（${r.m.stopReason}${r.m.budgetExhausted ? "，撞预算" : ""}）` : ""}${r.claimedDone ? "，模型自称完成" : ""}；` +
          `步数 ${r.turns}，工具 ${r.toolCalls}（失败 ${r.failedCalls}${errs ? `：${errs}` : ""}），${k(r.tokens)}，${sec(activeOf(r))}`,
      );
      if (r.tail) lines.push(`  > ${r.tail.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }
  return lines.join("\n") + "\n";
}
