// Q14 / F7：体积报表——harness 各源文件的行数，只出报表、不设门禁（ZCode 的「400 行文化」只借看板，不抄硬门禁）。
// 拆分值不值、哪个文件在膨胀，看这张表。
//
//   node scripts/size-report.ts [--top 15] [--over 400]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HARNESS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AREAS = [
  { name: "server", dir: "server", exts: [".ts"] },
  { name: "web/src", dir: path.join("web", "src"), exts: [".ts", ".svelte", ".css"] },
];

export interface SizeEntry {
  area: string;
  file: string;
  lines: number;
  test: boolean;
}

function walk(dir: string, exts: string[], out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name.startsWith(".")) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, exts, out);
    else if (ent.isFile() && exts.includes(path.extname(ent.name))) out.push(abs);
  }
  return out;
}

export const countLines = (text: string): number => (text.length ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0);

// 各区合计（测试单列）+ 超过 over 行的非测试文件个数 + 最大的 top 个非测试文件
export function summarize(entries: SizeEntry[], { top = 15, over = 400 }: { top?: number; over?: number } = {}): string {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const lines = ["harness 体积报表（行数；只出报表，不设门禁）", ""];
  for (const area of [...new Set(entries.map((e) => e.area))]) {
    const rows = entries.filter((e) => e.area === area);
    const tests = rows.filter((e) => e.test);
    const total = rows.reduce((n, e) => n + e.lines, 0);
    const testLines = tests.reduce((n, e) => n + e.lines, 0);
    lines.push(`${area}：${rows.length} 个文件、${fmt(total)} 行${tests.length ? `（其中测试 ${tests.length} 个、${fmt(testLines)} 行）` : ""}`);
  }
  const code = entries.filter((e) => !e.test);
  const big = code.filter((e) => e.lines > over);
  lines.push("", `非测试文件里超过 ${over} 行的：${big.length} 个`, "", `最大的 ${Math.min(top, code.length)} 个（非测试）：`);
  for (const e of [...code].sort((a, b) => b.lines - a.lines).slice(0, top)) lines.push(`  ${fmt(e.lines).padStart(7)}  ${e.file}`);
  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const num = (name: string, fallback: number) => {
    const i = args.indexOf(`--${name}`);
    const v = i >= 0 ? Number(args[i + 1]) : NaN;
    return Number.isFinite(v) && v > 0 ? v : fallback;
  };
  const entries: SizeEntry[] = [];
  for (const area of AREAS) {
    const root = path.join(HARNESS, area.dir);
    if (!fs.existsSync(root)) continue;
    for (const abs of walk(root, area.exts)) {
      const file = path.relative(HARNESS, abs).replace(/\\/g, "/");
      entries.push({ area: area.name, file, lines: countLines(fs.readFileSync(abs, "utf8")), test: /\.test\.ts$|[\\/]test-harness[\\/]/.test(abs) });
    }
  }
  console.log(summarize(entries, { top: num("top", 15), over: num("over", 400) }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
