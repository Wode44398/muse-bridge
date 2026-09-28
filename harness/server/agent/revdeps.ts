import fs from "node:fs/promises";
import path from "node:path";
import { walk } from "../tools/walk.ts";

// Reverse-dependency test discovery for the done-gate: find test files that
// reference a module the agent edited but that no command it ran ever
// exercised. The classic miss this catches: edit concat.py, run test_concat.py,
// never run test_combine.py (which calls concat) — and break it.
// Heuristic and capped; errs toward reporting (a spurious mention costs the
// model one "already ran it" turn, a miss costs a regression).

const TEST_FILE_RE =
  /(^|[/\\])(test_[^/\\]+|[^/\\]+_test|[^/\\]+\.(test|spec))\.(py|js|ts|jsx|tsx|mjs|cjs)$/i;
const CODE_EXTS = new Set([".py", ".js", ".ts", ".jsx", ".tsx", ".mjs", ".cjs", ".mts", ".cts"]);
// Module names too generic to grep for — matches would be mostly noise.
const STOP_TOKENS = new Set([
  "index", "main", "app", "cli", "run", "core", "base", "common", "misc",
  "util", "utils", "helper", "helpers", "types", "config", "setup", "init",
  "test", "tests", "conftest",
]);
const MAX_TEST_FILES = 400; // scan cap
const MAX_FILE_BYTES = 2_000_000;

export async function uncoveredReferencingTests(
  root: string,
  editedAbsFiles: Iterable<string>,
  ranCommands: string[],
): Promise<string[]> {
  const tokens = moduleTokens(editedAbsFiles);
  if (tokens.length === 0) return [];
  // V1（#19）：只有测试运行器的调用才算「跑过」——`grep x foo.test.ts`、`cat foo.test.ts` 碰到文件名
  // 不等于执行了它。
  const runs = ranCommands.filter(isTestRunnerCommand);
  if (runs.some(isFullSuiteRun)) return [];

  const tokenRe = new RegExp(`\\b(?:${tokens.map(escapeRe).join("|")})\\b`);
  const edited = new Set([...editedAbsFiles].map((f) => path.resolve(f)));

  const found: string[] = [];
  let scanned = 0;
  for await (const { abs } of walk(root)) {
    const rel = path.relative(root, abs).split(path.sep).join("/");
    if (!TEST_FILE_RE.test(rel)) continue;
    if (edited.has(path.resolve(abs))) continue; // the agent's own test file
    if (isCovered(rel, runs)) continue;
    if (++scanned > MAX_TEST_FILES) break;
    try {
      const stat = await fs.stat(abs);
      if (stat.size > MAX_FILE_BYTES) continue;
      const text = await fs.readFile(abs, "utf8");
      if (tokenRe.test(text)) found.push(rel);
    } catch {
      // unreadable — skip
    }
  }
  return found.sort();
}

// Derive grep-able module names from the edited files. __init__.py names the
// package (its directory); generic stems are dropped as noise.
function moduleTokens(editedAbsFiles: Iterable<string>): string[] {
  const toks = new Set<string>();
  for (const f of editedAbsFiles) {
    if (TEST_FILE_RE.test(f)) continue;
    const ext = path.extname(f).toLowerCase();
    if (!CODE_EXTS.has(ext)) continue;
    let stem = path.basename(f, path.extname(f));
    if (stem === "__init__") stem = path.basename(path.dirname(f));
    if (stem.length < 3 || STOP_TOKENS.has(stem.toLowerCase())) continue;
    toks.add(stem);
  }
  return [...toks];
}

// Did any command exercise this test file? True when a command names the file,
// or runs its directory (dir mention NOT continuing into a deeper path), or —
// checked separately — ran the whole suite.
function isCovered(rel: string, commands: string[]): boolean {
  const base = path.posix.basename(rel);
  const dirs: string[] = [];
  for (let d = path.posix.dirname(rel); d && d !== "." && d !== "/"; d = path.posix.dirname(d)) {
    dirs.push(d);
  }
  for (const cmd of commands) {
    if (cmd.includes(base)) return true;
    for (const dir of dirs) {
      if (mentionsDirRun(cmd, dir)) return true;
    }
  }
  return false;
}

// "pytest xarray/tests/" or "pytest xarray/tests" = a run of that directory;
// "pytest xarray/tests/test_concat.py" is NOT (the mention continues deeper).
function mentionsDirRun(cmd: string, dir: string): boolean {
  let i = cmd.indexOf(dir);
  while (i !== -1) {
    let j = i + dir.length;
    if (cmd[j] === "/") j++;
    const ch = cmd[j];
    if (ch === undefined || /[\s'";|&<>)]/.test(ch)) return true;
    i = cmd.indexOf(dir, i + dir.length);
  }
  return false;
}

// Test-runner invocations (the only commands whose mention of a test file means it RAN): package-manager
// test scripts, node --test, the common JS/Python/Go/Rust/JVM/.NET runners, or an interpreter pointed at a
// test file directly.
const TEST_RUNNER_RE = new RegExp(
  [
    String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b`,
    String.raw`\bnode\b[^|;&]*\s--test\b`,
    String.raw`\b(?:jest|vitest|mocha|ava|tap|jasmine|karma|cypress\s+run|playwright\s+test)\b`,
    String.raw`\b(?:pytest|py\.test|nosetests|tox|nox)\b`,
    String.raw`\bpython[\d.]*\s+-m\s+(?:pytest|unittest)\b`,
    String.raw`\b(?:go|cargo|deno|bun|dotnet)\s+test\b|\bcargo\s+nextest\b`,
    String.raw`\bmake\s+(?:test|check)\b|\bctest\b|\brspec\b|\bphpunit\b`,
    String.raw`\b(?:gradlew?|mvnw?)\b[^|;&]*\btest\b`,
    String.raw`\b(?:node|tsx|ts-node|python[\d.]*|deno\s+run|bun)\s+[^|;&]*(?:test_[^\s/\\]+|[^\s/\\]+_test|[^\s/\\]+\.(?:test|spec))\.(?:py|js|ts|mjs|cjs|jsx|tsx)\b`,
  ].join("|"),
  "i",
);

export function isTestRunnerCommand(cmd: string): boolean {
  return TEST_RUNNER_RE.test(cmd);
}

// A bare pytest/npm-test/make-test run covers everything. V1（#19）：`npm test -- -t foo`、`yarn test src/x`
// 这类带参数的是定向运行，不算全量（重定向与管道不算参数）。
function isFullSuiteRun(cmd: string): boolean {
  const pm = /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b([^;|&]*)/.exec(cmd);
  if (pm) {
    const extra = pm[1].replace(/\d*>>?\s*&?\s*\S*/g, "").trim();
    if (!extra) return true;
  }
  if (/\bmake\s+test\b/.test(cmd) || /\btox\b/.test(cmd)) return true;
  const m = cmd.match(/\b(?:pytest|py\.test)\b([^;|&]*)/);
  if (m) {
    const args = m[1]
      .trim()
      .split(/\s+/)
      .filter((a) => a && !a.startsWith("-") && !/[<>]/.test(a));
    if (args.length === 0) return true;
  }
  return false;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
