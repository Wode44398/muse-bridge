// Q5（F3 / N50）：会话体检 + 复盘统计，只读。
//
//   node scripts/session-health.mjs [--dir <会话目录>] [--stats] [--json]
//
// 不给 --dir 就用服务同一套解析出来的会话目录。逐个会话体检（配对、可见性、媒体引用、续写链……，检查逻辑就是
// server/session-health.ts 那一份）；任何守恒问题（error）都进退出码——不像以前的回放脚本只打印不失败。
// --stats 按 provider / model 汇总复盘统计：OBSERVED（记录里数得出来的）与 MODELED（估出来的）分两栏，只有聚合数字，
// 不含正文。只读文件，不改、不隔离任何东西。
import fs from "node:fs";
import path from "node:path";
import { errorCount, inspectSessionFile } from "../server/session-health.ts";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

let dir = option("--dir");
if (!dir) dir = (await import("../server/paths.ts")).sessionsDir();
dir = path.resolve(dir);

const ids = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter((f) => /^[a-zA-Z0-9-]{1,64}\.json$/.test(f)).map((f) => f.slice(0, -5)).sort()
  : [];
const reports = ids.map((id) =>
  inspectSessionFile(path.join(dir, `${id}.json`), id, {
    assetExists: (asset) => fs.existsSync(path.join(dir, "assets", id, asset)),
  }),
);

if (flag("--json")) {
  console.log(JSON.stringify(reports, null, 2));
} else {
  console.log(`会话体检：${dir}（${reports.length} 个会话）`);
  for (const r of reports) {
    const counts = new Map();
    for (const i of r.issues) {
      if (i.severity === "info") continue;
      const key = `${i.severity}:${i.code}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    if (!counts.size) continue;
    const mark = errorCount(r) ? "✖" : "⚠";
    const who = r.meta ? `${r.meta.provider}/${r.meta.model}` : r.load;
    console.log(`  ${mark} ${r.id}  ${who}  ${[...counts].map(([k, n]) => `${k}${n > 1 ? ` ×${n}` : ""}`).join(", ")}`);
  }
  const broken = reports.filter((r) => errorCount(r) > 0).length;
  const warned = reports.filter((r) => !errorCount(r) && r.issues.some((i) => i.severity === "warn")).length;
  console.log(`合计：${broken} 个会话有守恒问题（error），${warned} 个只有警告，${reports.filter((r) => r.load !== "ok").length} 个读不出或只读。`);
}

if (flag("--stats")) {
  const groups = new Map();
  for (const r of reports) {
    if (!r.stats || !r.meta) continue;
    const key = `${r.meta.provider}/${r.meta.model}`;
    const g = groups.get(key) ?? {
      sessions: 0, runs: 0, turns: 0, calls: 0, failed: 0, denied: 0, notExecuted: 0, maxStreak: 0, streaks: {},
      injections: {}, verifyExhausted: 0, auditExhausted: 0, errorEnded: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, prefixRequests: 0, prefixBreaks: {}, resentChars: 0,
      estTokens: 0, writesToKnownPaths: 0,
    };
    const o = r.stats.observed, m = r.stats.modeled;
    g.sessions++;
    g.runs += o.runs;
    g.turns += o.assistantTurns;
    for (const t of Object.values(o.toolCalls)) { g.calls += t.calls; g.failed += t.failed; }
    g.denied += o.denied;
    g.notExecuted += o.notExecuted;
    g.maxStreak = Math.max(g.maxStreak, o.maxIdenticalStreak);
    for (const [len, n] of Object.entries(o.identicalStreaks)) g.streaks[len] = (g.streaks[len] ?? 0) + n;
    for (const [kind, n] of Object.entries(o.injections)) g.injections[kind] = (g.injections[kind] ?? 0) + n;
    g.verifyExhausted += o.verifyGateExhaustedRuns;
    g.auditExhausted += o.auditGateExhaustedRuns;
    g.errorEnded += o.errorEndedTurns;
    for (const k of Object.keys(g.tokens)) g.tokens[k] += o.tokens[k];
    if (o.prefix) {
      g.prefixRequests += o.prefix.requests;
      g.resentChars += o.prefix.resentChars;
      for (const [cause, n] of Object.entries(o.prefix.breaks)) g.prefixBreaks[cause] = (g.prefixBreaks[cause] ?? 0) + n;
    }
    g.estTokens += m.estimatedTokens;
    g.writesToKnownPaths += m.writesToKnownPaths;
    groups.set(key, g);
  }
  const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : "—");
  console.log("\n复盘统计（按 provider/model；OBSERVED = 记录里数出来的，MODELED = 估的）");
  for (const [key, g] of [...groups].sort((a, b) => b[1].sessions - a[1].sessions)) {
    console.log(`\n■ ${key}：${g.sessions} 个会话，${g.runs} 条用户消息，${g.turns} 次 assistant 回合`);
    console.log(`  OBSERVED  工具调用 ${g.calls}，失败 ${g.failed}（${pct(g.failed, g.calls)}），被权限拒 ${g.denied}，没轮到执行 ${g.notExecuted}`);
    console.log(`            完全相同的连续调用：最长 ${g.maxStreak}；分布 ${JSON.stringify(g.streaks)}`);
    console.log(`            注入片段 ${JSON.stringify(g.injections)}；验证追问 ≥3 的轮 ${g.verifyExhausted}，审计追问 ≥3 的轮 ${g.auditExhausted}，出错收场 ${g.errorEnded}`);
    console.log(`            token：输入 ${g.tokens.input}（缓存读 ${g.tokens.cacheRead}，${pct(g.tokens.cacheRead, g.tokens.input)}；缓存写 ${g.tokens.cacheWrite}），输出 ${g.tokens.output}`);
    if (g.prefixRequests) console.log(`            前缀判定：${g.prefixRequests} 次请求，断点 ${JSON.stringify(g.prefixBreaks)}，重发约 ${g.resentChars} 字符`);
    console.log(`  MODELED   转录约 ${g.estTokens} token（字符 / 4）；Write 写到本会话先前出现过的路径 ${g.writesToKnownPaths} 次`);
  }
}

process.exitCode = reports.some((r) => errorCount(r) > 0) ? 1 : 0;
