// verify:true 的证据能不能归属到这次检查（pipefail、拒收兜底写法、跑了 0 个测试）。
import type { ToolRunResult } from "../types.ts";
import { fail } from "../types.ts";
import { shell, type ShellInfo } from "./env.ts";

const NON_VERIFICATION_COMMAND_RE =
  /^\s*(?:(?:git\s+(?:status|diff|log|show|branch|blame))|(?:ls|dir|pwd|cat|head|tail|wc|which|whereis|stat|du|df|env|printenv|echo|tree|file))\b[^|;&<>`$]*$/i;
const TRIVIAL_SUCCESS_RE = /^\s*(?::|true|exit\s+0)\s*$/i;

export function commandCanVerify(command: string): boolean {
  return command.trim().length > 0 &&
    !NON_VERIFICATION_COMMAND_RE.test(command) &&
    !TRIVIAL_SUCCESS_RE.test(command);
}

// ── V1（#19）：verify 证据可归属 ───────────────────────────────────────────────
// verify:true 只看整条命令行的退出码，而 git-bash 默认不开 pipefail：`npm test 2>&1 | tail -40`、
// `node t.js || true`、`node t.js; exit 0` 在测试失败时统统 exit 0，被记成通过证据，门禁放行，
// 答复里写「测试全绿」。现在：
//   · bash 下 verify 命令自动加 `set -eo pipefail`——管道里、多语句里任何一步失败，整条就失败；
//   · 怎样都盖得住失败的写法直接拒收（不执行、不记证据）：`||` 兜底、`&` 放后台、开头 `!` 取反；
//     PowerShell / sh 没有等价开关，只认一条单独的命令；
//   · 退出码是 0、输出却是「跑了 0 个测试」，不算通过。
export const VERIFY_ERREXIT = "set -eo pipefail; ";

// Top-level control operators outside quotes: "||", "&&", "|", "&", ";", "\n".
export function controlOperators(command: string): string[] {
  const ops: string[] = [];
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === "\\" && quote === '"') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (ch === "\n" || ch === ";") {
      ops.push(ch);
    } else if (ch === "|") {
      if (command[i + 1] === "|") {
        ops.push("||");
        i++;
      } else {
        ops.push("|");
        if (command[i + 1] === "&") i++; // `|&` is a pipe (stderr too)
      }
    } else if (ch === "&") {
      if (command[i + 1] === "&") {
        ops.push("&&");
        i++;
      } else if (command[i - 1] !== ">" && command[i - 1] !== "<" && command[i + 1] !== ">") {
        ops.push("&"); // not a redirection like 2>&1 or &>file
      }
    }
  }
  return ops;
}

export function unattributableVerify(command: string, kind: ShellInfo["kind"] = shell.kind): string | null {
  const trimmed = command.trim();
  const ops = controlOperators(trimmed);
  if (ops.includes("||")) return "`||` turns a failing check into exit 0";
  if (ops.includes("&")) return "`&` runs part of the command in the background, so its exit status is lost";
  if (/^!\s/.test(trimmed)) return "a leading `!` inverts the exit status";
  if (kind !== "bash" && ops.length) {
    return `${kind} has no pipefail/errexit here, so only a single plain command (no pipes, ;, && or newlines) counts`;
  }
  return null;
}

const ZERO_TEST_RES = [
  /\bRan 0 tests\b/,
  /\bcollected 0 items\b/,
  /\bno tests? (?:found|ran|were found|to run|executed)\b/i,
  /\bNo test files found\b/i,
  /^\s*ℹ tests 0\s*$/m,
  /\brunning 0 tests\b/,
  /\[no test files\]/,
  /\bTests?:\s+0 total\b/,
  /^\s*0 passing\b/m,
];
const NONZERO_TEST_RE = /\b[1-9]\d* (?:tests?|passing|passed|specs?)\b|ℹ tests [1-9]|\bRan [1-9]\d* tests?\b|\bcollected [1-9]\d* items?\b/i;

export function zeroTestSignature(output: string): string | null {
  if (!ZERO_TEST_RES.some((re) => re.test(output)) || NONZERO_TEST_RE.test(output)) return null;
  return "exit 0, but it ran zero tests";
}

export function verifyOutcome(command: string, status: string, exitOk: boolean, output: string): { passed: boolean; detail: string } {
  const zero = exitOk ? zeroTestSignature(output) : null;
  return { passed: exitOk && !zero, detail: `${command} (${zero ? zero : status})` };
}

export function unattributableFail(command: string, why: string): ToolRunResult {
  const how = shell.kind === "bash"
    ? "Run the check itself — pipes like `| tail -40` are fine, pipefail is on in verify mode."
    : "Run the check as a single command.";
  return fail(
    "verification not attributable",
    `verify:true needs an exit status that belongs to the check, but ${why}. ${how} ` +
      `This call was NOT run and is NOT recorded as evidence: ${command}`,
  );
}
