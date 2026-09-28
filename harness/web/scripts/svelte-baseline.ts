// Q14 / F7：前端 svelte-check 的基线检查——按文件数错误，只拦新增（某个文件错误变多、或新文件带错误）；错误变少了提示收紧。
// 警告只报个数、不拦（多是 a11y 提示）。npm test 里跑，几秒钟。
//
//   node web/scripts/svelte-baseline.ts                       检查
//   node web/scripts/svelte-baseline.ts --update              把基线收紧到当前（只许变少）
//   node web/scripts/svelte-baseline.ts --update --accept "<理由>"   确实要放宽时用：变多的文件连同理由记进基线
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WEB = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BIN = path.join(WEB, "node_modules", "svelte-check", "bin", "svelte-check");
const BASELINE = path.join(WEB, "svelte-check-baseline.json");

export interface Problem {
  type: "ERROR" | "WARNING";
  file: string;
  line: number;
  message: string;
}
export type Counts = Record<string, number>;

// svelte-check --output machine-verbose 的每一行：「<时间戳> {json}」，末行「<时间戳> COMPLETED …」
export function parseMachineVerbose(out: string): Problem[] {
  const problems: Problem[] = [];
  for (const line of out.split(/\r?\n/)) {
    const i = line.indexOf(" {");
    if (i < 0) continue;
    let j: { type?: string; filename?: string; start?: { line?: number }; message?: string };
    try {
      j = JSON.parse(line.slice(i + 1));
    } catch {
      continue;
    }
    if (j.type !== "ERROR" && j.type !== "WARNING") continue;
    problems.push({
      type: j.type,
      file: String(j.filename).replace(/\\/g, "/"),
      line: (j.start?.line ?? 0) + 1,
      message: String(j.message).replace(/\s+/g, " ").trim(),
    });
  }
  return problems;
}

export function errorsByFile(problems: Problem[]): Counts {
  const out: Counts = {};
  for (const p of problems) if (p.type === "ERROR") out[p.file] = (out[p.file] ?? 0) + 1;
  return out;
}

// 与基线比：worse = 这次比基线多（新文件带错也算），better = 比基线少
export function compareBaseline(baseline: Counts, current: Counts): { worse: { file: string; was: number; now: number }[]; better: { file: string; was: number; now: number }[] } {
  const worse = Object.entries(current)
    .filter(([file, n]) => n > (baseline[file] ?? 0))
    .map(([file, n]) => ({ file, was: baseline[file] ?? 0, now: n }));
  const better = Object.entries(baseline)
    .filter(([file, n]) => (current[file] ?? 0) < n)
    .map(([file, n]) => ({ file, was: n, now: current[file] ?? 0 }));
  return { worse, better };
}

const sorted = <T>(obj: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

function main() {
  const args = process.argv.slice(2);
  const update = args.includes("--update");
  const acceptAt = args.indexOf("--accept");
  const accept = acceptAt >= 0 ? String(args[acceptAt + 1] ?? "").trim() : "";
  if (acceptAt >= 0 && !accept) {
    console.error("[svelte-check] --accept 要带理由");
    process.exit(2);
  }
  if (!fs.existsSync(BIN)) {
    console.error("[svelte-check] 没装：先在 harness/web 里 npm install");
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [BIN, "--tsconfig", "./tsconfig.check.json", "--output", "machine-verbose", "--threshold", "warning"], {
    cwd: WEB,
    encoding: "utf8",
    maxBuffer: 64 << 20,
  });
  const out = `${r.stdout ?? ""}`;
  const done = /COMPLETED (\d+) FILES (\d+) ERRORS (\d+) WARNINGS/.exec(out);
  if (!done) {
    console.error(`[svelte-check] 没跑完（退出码 ${r.status}）：\n${(out + (r.stderr ?? "")).slice(-2000)}`);
    process.exit(1);
  }
  const problems = parseMachineVerbose(out);
  const current = errorsByFile(problems);
  const initial = !fs.existsSync(BASELINE); // 第一次建基线：现状整个记下（F7 起步时 11 个错误，都是类型建模层面的）
  const saved = initial ? { errors: {}, reasons: {} } : JSON.parse(fs.readFileSync(BASELINE, "utf8"));
  const { worse, better } = compareBaseline(saved.errors ?? {}, current);
  const summary = `${done[1]} 个文件，${done[2]} 个错误、${done[3]} 个警告`;

  if (update) {
    if (worse.length && !accept && !initial) {
      console.error(`[svelte-check] 不收紧反而变多了，拒绝更新基线（确实要放宽就加 --accept "<理由>"）：`);
      for (const w of worse) console.error(`  ${w.file}：${w.was} → ${w.now}`);
      process.exit(1);
    }
    const reasons = { ...(saved.reasons ?? {}) };
    for (const w of worse) reasons[w.file] = initial && !accept ? "F7 起步基线（第一次跑 svelte-check 时已有）" : accept;
    for (const file of Object.keys(reasons)) if (!current[file]) delete reasons[file];
    fs.writeFileSync(BASELINE, JSON.stringify({ errors: sorted(current), reasons: sorted(reasons) }, null, 2) + "\n");
    console.log(`[svelte-check] 基线已更新：${summary}`);
    return;
  }
  if (worse.length) {
    console.error(`[svelte-check] 前端类型检查有新增错误（${summary}）：`);
    for (const w of worse) {
      console.error(`  ${w.file}：基线 ${w.was} 个，现在 ${w.now} 个`);
      for (const p of problems.filter((x) => x.type === "ERROR" && x.file === w.file)) console.error(`    ${p.file}:${p.line}  ${p.message.slice(0, 200)}`);
    }
    console.error("修掉它们；确实要放宽，用 --update --accept \"<理由>\" 记进基线。");
    process.exit(1);
  }
  const hint = better.length ? `；${better.length} 个文件的错误比基线少，跑 --update 收紧` : "";
  console.log(`[svelte-check] 没有新增错误（${summary}${hint}）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
