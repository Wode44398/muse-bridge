// 模型档案阶段 1：转录回放。把落盘的会话记录（正式服的 sessions/、评测账本各臂的 sessions/）按型号家族汇总成
// 「适配信号」频次表，给拆解报告里的建议按实测排优先级。只读，不发任何请求，不输出正文。
//
//   node evals/ab/transcripts.ts --dir 正式服=C:/…/harness/sessions --dir 基线=%TEMP%/dimensio-matrix-baseline-1107-cloud/arms/*/sessions \
//        --out report.md --json report.json [--min-turns 2]
//
// --dir 可以给多次；路径里的 * 只支持「某一级目录全部」这一种（arms/*/sessions）。会话中途换过型号的按记录里最后的配置算。
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { resolveFamily } from "../../server/agent/profile.ts";
import { ERROR_CATEGORIES } from "./metrics.ts";
import { addSignals, BAD_ARG_KINDS, CONTRACT_KINDS, recordSignals, type RecordSignals } from "./signals.ts";

export interface Group {
  source: string;
  family: string;
  model: string;
  sessions: number;
  // cacheBase：记了缓存读数的那些会话的输入合计（老记录没有这一项，算命中率时不能把它们的输入算进分母）
  tokens: { input: number; output: number; cacheRead: number; cacheBase: number };
  s: RecordSignals;
}

function expand(spec: string): string[] {
  const parts = spec.replace(/\\/g, "/").split("/");
  let roots = [parts[0].endsWith(":") ? parts[0] + "/" : parts[0] || "/"];
  for (const p of parts.slice(1)) {
    roots = roots.flatMap((r) => {
      if (p !== "*") return [path.join(r, p)];
      try {
        return fs.readdirSync(r, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(r, d.name));
      } catch {
        return [];
      }
    });
  }
  return roots.filter((r) => fs.existsSync(r));
}

export function collect(dirs: { label: string; dir: string }[], minTurns = 1): { groups: Group[]; skipped: number } {
  const groups = new Map<string, Group>();
  let skipped = 0;
  for (const { label, dir } of dirs) {
    for (const d of expand(dir)) {
      for (const f of fs.readdirSync(d)) {
        if (!f.endsWith(".json")) continue;
        let rec: { config?: { provider?: string; model?: string }; messages?: unknown[]; totals?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number } };
        try {
          rec = JSON.parse(fs.readFileSync(path.join(d, f), "utf8"));
        } catch {
          skipped++;
          continue;
        }
        if (!Array.isArray(rec.messages) || !rec.config?.model) {
          skipped++;
          continue;
        }
        const s = recordSignals(rec as never);
        if (s.assistantTurns < minTurns) {
          skipped++;
          continue;
        }
        const provider = String(rec.config.provider ?? "");
        const model = String(rec.config.model);
        const family = resolveFamily(provider, model).family;
        const key = `${label}\u0000${family}\u0000${model}`;
        const g = groups.get(key) ?? { source: label, family, model, sessions: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheBase: 0 }, s: null as never };
        g.sessions++;
        g.tokens.input += rec.totals?.inputTokens ?? 0;
        g.tokens.output += rec.totals?.outputTokens ?? 0;
        if (typeof rec.totals?.cacheReadTokens === "number") {
          g.tokens.cacheRead += rec.totals.cacheReadTokens;
          g.tokens.cacheBase += rec.totals.inputTokens ?? 0;
        }
        g.s = addSignals(g.s, s);
        groups.set(key, g);
      }
    }
  }
  return { groups: [...groups.values()].sort((a, b) => a.family.localeCompare(b.family) || a.model.localeCompare(b.model) || a.source.localeCompare(b.source)), skipped };
}

// 同一家族（跨来源、跨型号）合并
export function byFamily(groups: Group[]): Group[] {
  const out = new Map<string, Group>();
  for (const g of groups) {
    const cur = out.get(g.family);
    if (!cur) out.set(g.family, { source: "全部", family: g.family, model: "（全部型号）", sessions: g.sessions, tokens: { ...g.tokens }, s: addSignals(null, g.s) });
    else {
      cur.sessions += g.sessions;
      cur.tokens.input += g.tokens.input;
      cur.tokens.output += g.tokens.output;
      cur.tokens.cacheRead += g.tokens.cacheRead;
      cur.tokens.cacheBase += g.tokens.cacheBase;
      addSignals(cur.s, g.s);
    }
  }
  return [...out.values()].sort((a, b) => b.s.toolCalls - a.s.toolCalls);
}

const pct = (n: number, d: number, digits = 1): string => (d > 0 ? `${((100 * n) / d).toFixed(digits)}%` : "—");
const per100 = (n: number, d: number): string => (d > 0 ? ((100 * n) / d).toFixed(n && (100 * n) / d < 1 ? 2 : 1) : "—");
const inj = (g: Group, ...keys: string[]): number => keys.reduce((n, k) => n + (g.s.injections[k] ?? 0), 0);

function table(title: string, groups: Group[], label: (g: Group) => string): string[] {
  const L: string[] = [`### ${title}`, ""];
  L.push("| 分组 | 会话 | 回合 | 工具调用 | 工具失败率 | 编辑失败率 | 仅思考回合 | 空回合 | 正文里写工具调用 | 纯等待 | 原样重复调用 | 失败后原样重发 | 截断续写 | 验证追问 | loop-guard | 报错收场回合 | 缓存命中 |");
  L.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const g of groups) {
    const s = g.s;
    L.push(
      `| ${label(g)} | ${g.sessions} | ${s.assistantTurns} | ${s.toolCalls} | ${pct(s.toolFailed, s.toolCalls)} | ${pct(s.editFailed, s.editCalls)}（${s.editFailed}/${s.editCalls}） | ${per100(s.thinkingOnlyTurns, s.assistantTurns)} | ${per100(s.emptyTurns, s.assistantTurns)} | ${s.textToolCalls} | ${s.waitPolls}（${Math.round(s.waitSeconds)} 秒） | ${per100(s.identicalRepeats, s.toolCalls)} | ${s.failThenSame} | ${per100(inj(g, "length-continue", "cutoff-continue"), s.assistantTurns)} | ${per100(inj(g, "verify-nudge", "submit-nudge"), s.assistantTurns)} | ${inj(g, "loop-guard")} | ${per100(s.errorEndedTurns, s.assistantTurns)} | ${pct(g.tokens.cacheRead, g.tokens.cacheBase, 0)} |`,
    );
  }
  L.push("", "口径：「仅思考回合 / 空回合 / 截断续写 / 验证追问 / 报错收场回合」是每 100 个 assistant 回合的次数；「原样重复调用」是每 100 次工具调用的次数；其余是绝对数。「缓存命中」只算记了缓存读数的会话（09 月下旬之前的老记录没有；自建 vLLM 不报，恒为 0）。", "");
  return L;
}

function errorTable(title: string, groups: Group[], label: (g: Group) => string): string[] {
  const cats = [...Object.keys(ERROR_CATEGORIES), "elided"] as string[];
  const names: Record<string, string> = { ...ERROR_CATEGORIES, elided: "正文已压缩（分不了类）" };
  const L: string[] = [`### ${title}`, "", `| 分组 | 失败合计 | ${cats.map((c) => names[c]).join(" | ")} |`, `|---|---|${cats.map(() => "---").join("|")}|`];
  for (const g of groups) L.push(`| ${label(g)} | ${g.s.toolFailed} | ${cats.map((c) => per100((g.s.errors as Record<string, number>)[c] ?? 0, g.s.toolCalls)).join(" | ")} |`);
  L.push("", "口径：每 100 次工具调用的失败次数。", "");
  const kinds = Object.keys(BAD_ARG_KINDS) as (keyof typeof BAD_ARG_KINDS)[];
  L.push(`| 分组 | ${kinds.map((k) => BAD_ARG_KINDS[k]).join(" | ")} | 调用里出现的别名参数 | 叫了不存在的工具 |`, `|---|${kinds.map(() => "---").join("|")}|---|---|`);
  for (const g of groups) {
    const top = (o: Record<string, number>) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k}×${v}`).join("、") || "—";
    L.push(`| ${label(g)} | ${kinds.map((k) => g.s.badArgs[k] ?? 0).join(" | ")} | ${top(g.s.aliasParams)} | ${top(g.s.unknownTools)} |`);
  }
  L.push("", "口径：参数 / JSON 类失败的细分（不含下表的契约类），绝对数。", "");
  const ck = Object.keys(CONTRACT_KINDS) as (keyof typeof CONTRACT_KINDS)[];
  L.push(`| 分组 | ${ck.map((k) => CONTRACT_KINDS[k]).join(" | ")} | 先读后改拦截 / 编辑调用 | 编辑未命中+不唯一 / 编辑调用 |`, `|---|${ck.map(() => "---").join("|")}|---|---|`);
  for (const g of groups) {
    const e = g.s.errors as Record<string, number>;
    L.push(`| ${label(g)} | ${ck.map((k) => per100(g.s.contract[k] ?? 0, g.s.toolCalls)).join(" | ")} | ${pct(e["read-gate"] ?? 0, g.s.editCalls)} | ${pct((e["edit-nomatch"] ?? 0) + (e["edit-ambiguous"] ?? 0), g.s.editCalls)} |`);
  }
  L.push("", "口径：dimensio 自家契约打回的调用，每 100 次工具调用的次数；最后两列是占编辑类调用（Edit / MultiEdit / Write）的比例。", "");
  return L;
}

export function report(groups: Group[], skipped: number): string {
  const fam = byFamily(groups);
  const L: string[] = ["# 转录回放：模型适配信号", "", `共 ${groups.reduce((n, g) => n + g.sessions, 0)} 个会话，跳过 ${skipped} 个（读不了、没有消息或回合数不够）。`, ""];
  L.push("## 按家族", "", ...table("行为信号", fam, (g) => g.family), ...errorTable("失败分类", fam, (g) => g.family));
  L.push("## 按型号与来源", "", ...table("行为信号", groups, (g) => `${g.family} / ${g.model} / ${g.source}`), ...errorTable("失败分类", groups, (g) => `${g.family} / ${g.model} / ${g.source}`));
  L.push("## 失败样例（每个家族每类最多 4 条，只留报错开头）", "");
  for (const g of fam) {
    if (!g.s.samples.length) continue;
    L.push(`### ${g.family}`, "");
    for (const smp of g.s.samples) L.push(`- ${smp.cat} · ${smp.tool}：${smp.head.replace(/\|/g, "\\|")}`);
    L.push("");
  }
  return L.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const dirs: { label: string; dir: string }[] = [];
  let out = "";
  let json = "";
  let minTurns = 1;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--dir" && v) {
      const eq = v.indexOf("=");
      dirs.push(eq > 0 ? { label: v.slice(0, eq), dir: v.slice(eq + 1) } : { label: path.basename(v), dir: v });
      i++;
    } else if (a === "--out" && v) (out = v), i++;
    else if (a === "--json" && v) (json = v), i++;
    else if (a === "--min-turns" && v) (minTurns = Number(v)), i++;
    else throw new Error(`不认识的参数：${a}`);
  }
  if (!dirs.length) throw new Error("至少给一个 --dir 标签=会话目录");
  const { groups, skipped } = collect(dirs, minTurns);
  const md = report(groups, skipped);
  if (out) fs.writeFileSync(out, md);
  else process.stdout.write(md + "\n");
  if (json) fs.writeFileSync(json, JSON.stringify({ groups, families: byFamily(groups), skipped }, null, 1));
}
