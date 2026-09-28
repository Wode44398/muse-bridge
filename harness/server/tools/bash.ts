import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { consoleDecoder } from "./console-decode.ts";
import { fail, ok } from "./types.ts";
import { insideReadOnlyRoot, pathAliasViolation, protectedStateViolation, readRootFor, readVerdict, realOrNearest } from "../sandbox.ts";
import { grantedSkillDirs, managedExtensionRoots } from "../extensions.ts";
import { redactOutput } from "../redact.ts";
import { desktopHostPorts } from "../desktop-host.ts";
import { isSensitiveEnvName } from "../helper-proc.ts";
import { killChildTree } from "../proc-tree.ts";
import { disposeAll, disposeOwner, registerResource } from "../resources.ts";
import { OutputSpill, savedHint } from "./result-store.ts";
import { parseShell, type ShellDialect } from "./shell-words.ts";
import { accessLock, deniedRootLiteral, tenantMode } from "../tenant.ts";
import {
  READ_ONLY_VERBS,
  assessCommand,
  assessParsed,
  destructiveView,
  readOnlyCommand,
  ruleSubjects,
  shellTouches,
  stablePrefixes,
} from "./shell-policy.ts";

// Failure summaries (test runners, builds, tracebacks) land at the END of the
// output, so on overflow keep a small head for context and favor the tail.
const HEAD_MAX = 5_000;
const TAIL_MAX = 25_000;

// Rolling head+tail capture shared by the sync path and background jobs.
// R13：spillTo 给了（有会话）就在第一次溢出时开一个落盘文件——那一刻头尾还是完整的，先整段写进去，之后每一段都追加；
// 被截掉的中段不再永久丢失，截断提示里写明全文在哪（savedAt）。
interface OutBuf {
  head: string;
  tail: string;
  omitted: number;
  total?: number;
  spillTo?: () => OutputSpill | null;
  spill?: OutputSpill | null;
  savedAt?: string | null;
}

// 有会话才落盘；落盘前按块过 Bash 的脱敏（与交给模型的同一层）
function spillFor(sessionId: string | undefined): (() => OutputSpill | null) | undefined {
  if (!sessionId) return undefined;
  return () => {
    try {
      return new OutputSpill(sessionId, "bash", (text) => redactSecrets(dropJavaPickup(text)));
    } catch {
      return null;
    }
  };
}

// 进程结束时收尾：把落盘文件写完关上（写失败就不再在提示里给路径）
async function closeSpill(b: OutBuf): Promise<void> {
  const spill = b.spill;
  if (!spill) return;
  b.spill = null;
  b.savedAt = await spill.end();
}

function pushOut(b: OutBuf, s: string): void {
  b.total = (b.total ?? 0) + s.length;
  if (b.spill) b.spill.write(s);
  if (b.head.length < HEAD_MAX) {
    const need = HEAD_MAX - b.head.length;
    b.head += s.slice(0, need);
    s = s.slice(need);
  }
  b.tail += s;
  if (b.tail.length > TAIL_MAX) {
    if (b.spill === undefined) {
      b.spill = b.spillTo?.() ?? null;
      if (b.spill) {
        b.spill.write(b.head + b.tail);
        b.savedAt = b.spill.file;
      }
    }
    b.omitted += b.tail.length - TAIL_MAX;
    b.tail = b.tail.slice(-TAIL_MAX);
  }
}

function renderOut(b: OutBuf): string {
  const note = b.savedAt ? ` — ${savedHint(b.savedAt, b.total ?? 0)}` : "";
  const rendered = b.omitted > 0 ? `${b.head}\n…[${b.omitted} chars omitted${note}]…\n${b.tail}` : b.head + b.tail;
  return redactSecrets(dropJavaPickup(rendered));
}

// Every JVM announces an inherited JAVA_TOOL_OPTIONS on stderr. We set that var
// (see childEnv) purely to fix encoding, so the announcement is pure noise on
// every java/javac/gradle call — drop exactly our own line, nothing else.
function dropJavaPickup(text: string): string {
  if (!text.includes(JAVA_PICKUP_LINE)) return text;
  return text
    .split("\n")
    .filter((line) => line.trimEnd() !== JAVA_PICKUP_LINE)
    .join("\n");
}

// stdout/stderr arrive as byte chunks split at arbitrary offsets, so decoding
// each chunk on its own shreds any multi-byte character that straddles a
// boundary — one `�` per ~64KB of Chinese output, reported as "编码问题".
// A decoder per stream holds the incomplete tail until its rest arrives;
// finish() flushes whatever the process left dangling at exit.
// #97：Windows 上按行认 UTF-8 / GBK（原生控制台程序写的是系统代码页），见 console-decode.ts。
function streamPump(b: OutBuf): { write: (buf: Buffer) => void; finish: () => void } {
  const decoder = consoleDecoder();
  return {
    write: (buf: Buffer) => pushOut(b, decoder.write(buf)),
    finish: () => {
      const rest = decoder.end();
      if (rest) pushOut(b, rest);
    },
  };
}

// Kill a process tree. On Windows the child is the shell running the command;
// its node grandchild survives a plain kill(), so the whole tree has to go. (Shared
// with services.ts — lives here because services already imports from this module.)
// #77：以前是 taskkill /T——它只按 ParentProcessId 找子进程，会顺着「悬空的父 PID」把不相干的进程链整条带走
// （2026-09-24 生产上的 bridge 就这样没的）。现在由 proc-tree.ts 按创建时间核对子孙后逐个结束；Node 已经收到
// 退出的子进程不再按 PID 去杀（PID 可能已被复用）。
export function killTree(child: ChildProcess): void {
  killChildTree(child);
}

// ── 「命令结束了」到底怎么判 ─────────────────────────────────────────────────
// 曾经两条路径都只听 'close'，那是个陷阱：'close' 要等 stdio 管道全部 EOF，而管道
// 的写端会被【孙进程】继承。命令里写个 `&` 起一个长命进程（`cmd & sleep 90`、
// `./game.exe & …`），shell 自己 echo 完就正常退出了，孙进程却攥着那对管道不放 ——
// 管道不 EOF，'close' 永远不来，同步路径那个 Promise 于是永不 resolve。
// 2026-09-10 实测：一次 `./SUMMER.exe >/dev/null 2>&1 & sleep 90` 把整个会话冻死
// 3 小时 15 分（shell 16:11 就退干净了，UI 一直显示「运行中」）。超时兜底也救不了 ——
// 定时器烧到时 killTree 打的是那个早已自己退出的 shell pid，孤儿子树根本不在射程内，
// 打完还是接着等 'close'。
//
// 'exit' 只跟进程本身的死活绑定，管道被谁攥着都一定会来，所以定局改挂 'exit'：
// exit 之后再给一小段安静窗口把管道里剩下的字读干净（还有数据就续窗口，但总时长封顶,
// 免得被一个话痨孤儿续到天荒地老），到点就收工。
const POST_EXIT_QUIET_MS = 300; // exit 后多久没新输出就算读干净了
const POST_EXIT_MAX_MS = 3_000; // drain 总时长上限（孤儿可能一直往管道里写）
const KILL_BACKSTOP_MS = 5_000; // killTree 之后进程仍没死透的最后兜底

function whenFinished(
  child: ChildProcess,
  pumps: { finish: () => void }[],
  onFinish: (code: number | null) => void,
): { markKilled: () => void } {
  let settled = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  const later = (ms: number, fn: () => void) => {
    const t = setTimeout(fn, ms);
    timers.push(t);
    return t;
  };

  const settle = (code: number | null) => {
    if (settled) return;
    settled = true;
    for (const t of timers) clearTimeout(t);
    for (const p of pumps) p.finish();
    // 松开读端。孤儿还攥着写端，但 harness 这边没必要再为它留着 fd 和 buffer。
    child.stdout?.destroy();
    child.stderr?.destroy();
    onFinish(code);
  };

  // 正常命令仍然走这条：'close' 紧跟在 'exit' 后面，等不到安静窗口就收工了。
  child.on("close", (code) => settle(code));

  child.on("exit", (code) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const bump = () => {
      if (quiet) clearTimeout(quiet);
      quiet = later(POST_EXIT_QUIET_MS, () => settle(code));
    };
    child.stdout?.on("data", bump);
    child.stderr?.on("data", bump);
    later(POST_EXIT_MAX_MS, () => settle(code));
    bump();
  });

  // 超时/中止路径调这个：killTree 之后万一进程还是没死（taskkill 失败、句柄被占），
  // 'exit' 也不会来，靠这个保证调用方一定拿得到结局，而不是无限等待。
  return { markKilled: () => later(KILL_BACKSTOP_MS, () => settle(null)) };
}

// Catastrophic, out-of-sandbox commands are refused regardless of permission
// mode. The sandbox contains file writes to the workspace, but these can reach
// past it, so they are hard-denied.
// P4（K5，#15）：以前是一张正则表扫整串——`grep -rn reboot src`、`git log --grep=shutdown` 被硬拒（用户批准也没用），
// `rm -fr /`、`rm -r -f ~`、`rm --recursive --force /` 却放行。现在按命令位判：先用 shell-words 切出每条真正在跑的命令
// （剥掉 sudo/env/bash -c/cmd /c/powershell -Command 等包装器，$(…) 里的也算），再看程序名与参数。
// `adb shell …` 跑在手机上、不是宿主，分词器不展开它（设备上的清理是权限问题，不是宿主硬拒）。
export function shellDialect(kind: ShellInfo["kind"] = shell.kind): ShellDialect {
  return kind === "powershell" ? "powershell" : "bash";
}

export function deniedCommand(command: string): string | null {
  return assessCommand(command, shellDialect()).deny ?? null;
}

// Everything after "adb shell" executes on the phone, not on this machine: the
// host self-protection below skips those segments.
const ADB_SHELL_RE = /^\S*\badb(?:\.exe)?\b[^\n]*?\bshell\b/i;

// ── 宿主自保（S5，#22）──────────────────────────────────────────────────────
// 「端口被占就杀所有 node」是 Node 项目里的高频动作，一条命令就让 bridge 和 harness 一起死：
// 手机当场断连，所有会话的在跑轮被腰斩。这类命令在任何模式、任何规则下都硬拒，并给出正路。
// 三类：按映像名杀 node / cloudflared（隧道）；杀宿主自己的 PID（含 bash 里的 $PPID = harness）；
// 按 harness / bridge / 桌面壳端口杀。`adb shell …` 在手机上执行，不算。
const KILL_VERB_RE =
  /\b(?:taskkill|tskill|kill|pkill|killall|kill-port|fkill|fuser|Stop-Process|spps|Invoke-CimMethod|Remove-CimInstance|Remove-WmiObject)\b|\.Terminate\(\)|\bcall\s+terminate\b|\bwhere\b[^|]*\bdelete\b/i;
const HOST_IMAGE_KILL_RES: RegExp[] = [
  /\btaskkill\b[^|;&\n]*[/-]im\s+["']?(?:node|cloudflared|\*)(?:\.exe|\*)?["']?(?=\s|$)/i,
  /\btskill\s+(?:node|cloudflared)\b/i,
  /\b(?:Stop-Process|spps|kill)\b[^|;&\n]*-Name\s+["']?(?:node|cloudflared|\*)\b/i,
  /\b(?:Get-Process|gps|ps)\b[^|;&\n]*\b(?:node|cloudflared)\b[^|;&\n]*\|\s*(?:Stop-Process|spps|kill)\b/i,
  /\b(?:pkill|killall)\b[^|;&\n]*\b(?:node|cloudflared)(?:\.exe)?\b/i,
  /\bwmic\b[^|;&\n]*\b(?:node|cloudflared)\.exe\b[^|;&\n]*\b(?:delete|terminate)\b/i,
  /\b(?:node|cloudflared)\.exe\b[^\n]*\|\s*(?:Invoke-CimMethod|Remove-CimInstance|Remove-WmiObject|%\s*\{[^}]*Terminate)/i,
];
const HOST_PPID_RE = /\bkill\b[^|;&\n]*\$\{?PPID\b/i;

function hostPids(): Set<number> {
  return new Set([process.pid, process.ppid].filter((pid) => Number.isInteger(pid) && pid > 0));
}

function hostPorts(): number[] {
  const ports = [Number(process.env.PORT || 8799), Number(process.env.BRIDGE_PORT || 0), ...desktopHostPorts()];
  return ports.filter((p) => Number.isInteger(p) && p > 0);
}

export function hostKillViolation(command: string): string | null {
  // 手机上的 `adb shell pkill node` 不是杀宿主；多段命令按段剔掉它，再用 `|` 拼回去做整句匹配。
  const host = splitSegments(command.replace(/\/\//g, "/"))
    .filter((segment) => !ADB_SHELL_RE.test(segment))
    .join(" | ");
  if (!host || !KILL_VERB_RE.test(host)) return null;
  const way =
    " To stop something YOU started, use Preview(action:\"stop\") for a Preview server, stop your own background " +
    "Bash job, or kill that one process by its own PID (find it with `netstat -ano | findstr :<its port>`). " +
    "Never kill node / cloudflared wholesale, and never touch the bridge or dimensio ports or processes.";
  if (HOST_IMAGE_KILL_RES.some((re) => re.test(host))) {
    return "this would kill every node process — including the bridge server and dimensio itself, which run you." + way;
  }
  if (HOST_PPID_RE.test(host)) return "$PPID of this shell is dimensio itself." + way;
  const pids = hostPids();
  for (const m of host.matchAll(/(?<![\w.:-])(\d{2,7})(?![\w.:])/g)) {
    if (pids.has(Number(m[1]))) return `PID ${m[1]} is the bridge server or dimensio itself.` + way;
  }
  for (const port of hostPorts()) {
    if (new RegExp(`(?<![\\w.])${port}(?![\\w.])`).test(host)) {
      return `port ${port} belongs to the bridge server / dimensio / the desktop shell.` + way;
    }
  }
  return null;
}

// Bash 与 Preview(start) 共用的命令闸（S5、#67）：危险命令名单 → 宿主自保 → 工作区围栏与凭据判定。
// 以前 Preview 的 start 命令一道都不过，是绕开全部 Bash 策略的旁路。
export function commandPolicyViolation(command: string, root: string, access: "workspace" | "full", readRoots: string[] = []): string | null {
  const denied = deniedCommand(command);
  if (denied) return `Command blocked by safety deny-list: ${denied}.`;
  const hostKill = hostKillViolation(command);
  if (hostKill) return `Command blocked to protect the host: ${hostKill}`;
  // 租户模式的禁区字面兜底（引号拼接等抽不出候选路径的写法），见 tenant.ts。
  const deniedRoot = deniedRootLiteral(command);
  if (deniedRoot) return `Command blocked by workspace policy: it references ${deniedRoot}, which belongs to the host or to another user.`;
  // 访问范围锁（租户恒 workspace）：调用方传进来的 access 被谁改成 full 都不算数。
  const scope = commandScopeViolation(command, root, accessLock() ?? access, readRoots);
  if (scope) return `Command blocked by workspace policy: ${scope}.`;
  return null;
}

// P13（X18）：被拒只是因为纯读命令读了工作区外——返回放行哪几个目录（只读）这条命令就能过；不是这种情况（别的拒绝理由、
// 写、非纯读命令、整机模式）返回 null。放行后要真能过才算：逐个补上越界落点所在的目录再判一遍整套命令闸，最多 5 个。
export function outsideReadDirs(command: string, root: string, access: "workspace" | "full", readRoots: string[] = []): string[] | null {
  // 租户模式不问（批准的人就是用户自己），越界直接拒。
  if (access !== "workspace" || tenantMode()) return null;
  const dirs: string[] = [];
  let roots = [...readRoots];
  for (let i = 0; i < 5; i++) {
    const target = outsideReadCandidate(command, root, roots);
    if (!target) return null;
    const dir = readRootFor(target);
    dirs.push(dir);
    roots = [...roots, dir];
    if (!commandPolicyViolation(command, root, access, roots)) return dirs;
  }
  return null;
}

interface ShellInfo {
  kind: "bash" | "powershell" | "sh";
  path: string;
  argsFor(cmd: string): string[];
}

export const shell: ShellInfo = detectShell();

// Child env for spawned commands/servers: make sure localhost bypasses any
// system proxy — `curl http://localhost:<port>` routed through a
// proxy returns 000/502 and reads as "my server is broken" when it's fine.
// HTTP(S)_PROXY pass through so pip/curl/git in the sandbox can reach abroad;
// they track net-proxy.ts's adaptive state because childEnv reads process.env
// at call time, and NO_PROXY below keeps localhost direct.
const CHILD_ENV_BASE = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "TMPDIR", "USER", "USERNAME", "PROGRAMDATA", "PROGRAMFILES",
  "PROGRAMFILES(X86)", "PROGRAMW6432", "LANG", "LC_ALL", "TERM", "SHELL",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "CI",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
]);
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
const VERIFY_ERREXIT = "set -eo pipefail; ";

// Top-level control operators outside quotes: "||", "&&", "|", "&", ";", "\n".
function controlOperators(command: string): string[] {
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

function verifyOutcome(command: string, status: string, exitOk: boolean, output: string): { passed: boolean; detail: string } {
  const zero = exitOk ? zeroTestSignature(output) : null;
  return { passed: exitOk && !zero, detail: `${command} (${zero ? zero : status})` };
}

function unattributableFail(command: string, why: string): ToolRunResult {
  const how = shell.kind === "bash"
    ? "Run the check itself — pipes like `| tail -40` are fine, pipefail is on in verify mode."
    : "Run the check as a single command.";
  return fail(
    "verification not attributable",
    `verify:true needs an exit status that belongs to the check, but ${why}. ${how} ` +
      `This call was NOT run and is NOT recorded as evidence: ${command}`,
  );
}

function explicitChildEnvNames(): Set<string> {
  return new Set(
    (process.env.DIMENSIO_CHILD_ENV_ALLOW ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

// Sanctioned tool dirs: the Bridge extension skill directories granted to dimensio
// (managed skill scripts). They are exempt from the workspace containment guard
// below in BOTH sandbox access modes. Computed lazily: the registry may appear
// after harness started and takes effect immediately. Only each granted skill's
// own directory is listed — skills not granted to dimensio and the registry
// itself (connector tokens) are not.
const sanctionedToolDirs = (): string[] => grantedSkillDirs();

// Windows JVMs write GBK bytes to a pipe, so any Chinese from a java/javac/
// gradle run comes back as mojibake (verified 2026-08-17: `java Hi.java | od -c`
// emits D6D0 CEC4 for 中文). Python is already forced to UTF-8 below; this is the
// same treatment for the JVM.
const JAVA_UTF8_OPTS = "-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8";
const JAVA_PICKUP_LINE = `Picked up JAVA_TOOL_OPTIONS: ${JAVA_UTF8_OPTS}`;

// git-bash's /tmp is an MSYS mount that native Windows programs do not share:
// python and java resolve "/tmp/x" against the current drive instead.
// $WORKSPACE_TMP is one scratch path every program on this machine resolves the
// same way — a k3 run on 2026-08-16 lost two attempts to exactly that mismatch.
function scratchDir(): string {
  // DIMENSIO_SCRATCH_DIR：租户实例各用各的（bridge 指到用户自己的目录里），别人看不到彼此的草稿。
  const dir = path.resolve(process.env.DIMENSIO_SCRATCH_DIR?.trim() || path.join(os.tmpdir(), "dimensio-scratch"));
  mkdirSync(dir, { recursive: true });
  return dir.split(path.sep).join("/");
}

export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const grow = (v?: string) => {
    const set = new Set((v ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    set.add("localhost");
    set.add("127.0.0.1");
    set.add("::1");
    return [...set].join(",");
  };
  const allowed = explicitChildEnvNames();
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || isSensitiveEnvName(name)) continue;
    if (CHILD_ENV_BASE.has(name.toUpperCase()) || allowed.has(name)) env[name] = value;
  }
  const noProxy = grow(process.env.NO_PROXY ?? process.env.no_proxy);
  const isolatedHome = path.resolve(process.env.DIMENSIO_CHILD_HOME?.trim() || path.join(os.tmpdir(), "dimensio-child-home"));
  const appData = path.join(isolatedHome, "AppData", "Roaming");
  const localAppData = path.join(isolatedHome, "AppData", "Local");
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  return {
    ...env,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
    GNUPGHOME: path.join(isolatedHome, ".gnupg"),
    NPM_CONFIG_USERCONFIG: path.join(isolatedHome, ".npmrc"),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    // R14（X15）：交互式工具驯服——分页器不开（git log / gh / man 不会停在 less 里等按键）、不输出颜色转义
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    MANPAGER: "cat",
    TERM: "dumb",
    NO_COLOR: "1",
    // Windows consoles default python stdio to GBK — print("¥") then dies with
    // UnicodeEncodeError (2026-08-09: one such crash cost three failed calls).
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    JAVA_TOOL_OPTIONS: JAVA_UTF8_OPTS,
    WORKSPACE_TMP: scratchDir(),
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    ...extra,
  };
}

function redactSecrets(text: string): string {
  let out = text;
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8 || !isSensitiveEnvName(name)) continue;
    out = out.split(value).join(`[REDACTED:${name}]`);
  }
  out = out.replace(
    /(^|\n)([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Z0-9_]*)\s*=\s*[^\r\n]*/gi,
    (_m, lead: string, name: string) => `${lead}${name}=[REDACTED]`,
  );
  out = out.replace(/-----BEGIN [^-\r\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]+ PRIVATE KEY-----/g, "[REDACTED:PRIVATE_KEY]");
  // S4：再过一遍与 Read/Grep/WebFetch 共用的高置信规则（JSON 里的 Bearer、知名前缀令牌）——
  // 以前 `cat registry.json` 这类 JSON 形态的令牌两条规则都匹配不到。
  return redactOutput(out);
}

function inside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

function gitBashWindowsPath(token: string): string | null {
  const m = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(token);
  if (!m) return null;
  return path.win32.resolve(`${m[1]}:\\${(m[2] ?? "").replace(/\//g, "\\")}`);
}

interface PathCandidate {
  path: string;
  // The token is the target of > or >>, so this command WRITES there. A
  // read-only directory must refuse that even when the read rules would pass.
  write: boolean;
}

// `~/x` is a literal path we can resolve ourselves, unlike $HOME/%USERPROFILE%
// (expanded later by the shell). Resolving it lets an explicitly opened home
// subdirectory be read instead of dying to a blanket rule — the k3 run lost a
// whole SDK probe because one `ls ~/.gradle` sat in an otherwise fine command.
function homePathCandidate(token: string): string | null {
  const norm = token.replace(/\\/g, "/");
  if (!/^~(?:\/|$)/.test(norm)) return null;
  return path.resolve(os.homedir(), norm.slice(1).replace(/^\//, ""));
}

// Every whitespace/quote-delimited token, stripped of redirect prefixes and trailing
// separators (the same cleanup filesystemPathCandidates applies).
function commandTokens(command: string): string[] {
  const out: string[] = [];
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)) {
    const token = (match[1] ?? match[2] ?? match[3] ?? "").replace(/^\d*>>?/, "").replace(/^[<>=(),]+|[;,|&]+$/g, "");
    if (token) out.push(token);
  }
  return out;
}

function filesystemPathCandidates(command: string): PathCandidate[] {
  const candidates: PathCandidate[] = [];
  let pendingWrite = false;
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)) {
    const rawToken = match[1] ?? match[2] ?? match[3] ?? "";
    const redirect = /^\d*>>?/.test(rawToken);
    const token = rawToken.replace(/^\d*>>?/, "").replace(/^[<>=(),]+|[;,|&]+$/g, "");
    const write = redirect || pendingWrite;
    pendingWrite = redirect && token === "";
    if (!token) continue;
    if (/^[A-Za-z]:[\\/]/.test(token) || /^\/[A-Za-z](?:\/|$)/.test(token)) {
      candidates.push({ path: token, write });
      continue;
    }
    const home = homePathCandidate(token);
    if (home) candidates.push({ path: home, write });
  }
  return candidates;
}

// Windows drive form, git-bash /c/... form, or a native POSIX path.
function resolveCandidate(raw: string): string | null {
  if (/^[A-Za-z]:[\\/]/.test(raw)) return path.win32.resolve(raw);
  if (process.platform === "win32") return gitBashWindowsPath(raw);
  return path.resolve(raw);
}

// READ_ONLY_VERBS（shell-policy.ts）是只读动词的单一来源：这里的路径闸与 C9 的只读降级共用。
const WRITE_FLAG_RE = /(^|\s)-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/;

function isReadOnlyCommand(command: string): boolean {
  const segments = splitSegments(command);
  if (!segments.length) return false;
  return segments.every((segment) => {
    const verb = /^([A-Za-z0-9_./-]+)/.exec(segment)?.[1] ?? "";
    const name = (verb.split("/").pop() ?? "").toLowerCase();
    return READ_ONLY_VERBS.has(name) && !WRITE_FLAG_RE.test(segment);
  });
}

// S7（#55）：harness 自己的状态（会话目录、检查点影子仓库、桌面宿主描述）经 Bash 也不许改。
// 纯读命令照常放行，但它的重定向目标仍算写；`--git-dir=<路径>`、`VAR=<路径>` 只看等号右边；
// 相对路径按工作区根解析（工作区就是 harness 目录时，`rm -rf sessions` 也得拦下）。
function protectedStateCommandViolation(command: string, root: string): string | null {
  const pureRead = isReadOnlyCommand(command);
  let pendingWrite = false;
  for (const match of command.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)) {
    const rawToken = match[1] ?? match[2] ?? match[3] ?? "";
    const redirect = /^\d*>>?/.test(rawToken);
    const token = rawToken.replace(/^\d*>>?/, "").replace(/^[<>=(),]+|[;,|&]+$/g, "").replace(/^["']|["']$/g, "");
    const write = redirect || pendingWrite;
    pendingWrite = redirect && token === "";
    if (!token || (pureRead && !write)) continue;
    let value = token;
    if (token.startsWith("-") || /^[A-Za-z_]\w*=/.test(token)) {
      const eq = token.indexOf("=");
      if (eq < 0) continue; // 纯开关（-rf、--force）
      value = token.slice(eq + 1);
    }
    if (!value || /^[a-z][a-z0-9+.-]*:\/\//i.test(value) || /[*?$`]/.test(value)) continue;
    const abs = /^[A-Za-z]:[\\/]/.test(value) || /^\/[A-Za-z](?:\/|$)/.test(value)
      ? resolveCandidate(value)
      : homePathCandidate(value) ?? path.resolve(root, value);
    const hit = abs ? protectedStateViolation(abs) : null;
    if (hit) return `${hit}: ${token}`;
  }
  return null;
}

// A refusal that names no way forward just makes the model invent detours (the
// k3 run inferred its JDK version from `gradlew --version` after two blocks).
const ACCESS_HINT =
  " — this project runs in workspace access mode. If the task genuinely needs that path, ask the user to " +
  "switch the project to full access, or to add the directory to DIMENSIO_READONLY_PATHS for read-only " +
  "probing; do not go looking for a way around the guard.";

function outsideHint(candidate: string, write: boolean): string {
  if (!insideReadOnlyRoot(candidate)) return ACCESS_HINT;
  return write
    ? " — that directory is open for reading only, so redirecting output into it is refused"
    : " — that directory is open for reading, but only to a plain read-only command (ls/cat/grep/find/…), " +
      "and this command is not one";
}

// `..` as a whole path component (`../x`, `a/../b`, bare `..`) — not `HEAD..main`.
const DOTDOT_COMPONENT = /(^|\/)\.\.(\/|$)/;

// Split a command line into sequentially-executed segments (&&, ||, ;, |, &,
// newline), keeping quoted spans intact. Heredoc bodies are split too — their
// lines rarely look like paths, and the only consequence is the same
// conservative rejection this guard always had.
function splitSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
    } else if (ch === "\n" || ch === ";" || ch === "|" || ch === "&") {
      segments.push(current);
      current = "";
      while (command[i + 1] === ch) i++;
    } else {
      current += ch;
    }
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter(Boolean);
}

function resolveAgainst(base: string, token: string): string | null {
  const norm = token.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(norm)) return path.win32.resolve(token);
  if (/^\/[A-Za-z](?:\/|$)/.test(norm) && process.platform === "win32") {
    return gitBashWindowsPath(norm);
  }
  return path.resolve(base, norm);
}

// Workspace mode used to reject any `..` outright, which also killed legitimate
// chains like `cd sub/dir && cat ../file` that never leave the workspace — one
// GBK crash on 2026-08-09 turned into three failed calls because both retries
// used `..`. Instead, walk the segments in execution order tracking the cwd
// through literal `cd` targets, and reject a `..` only when it actually
// resolves outside the workspace (or when the cwd is no longer trackable —
// `cd "$DIR"` and friends stay conservatively blocked).
function dotdotEscapeViolation(command: string, root: string): string | null {
  const rootAbs = path.resolve(root);
  let cwd: string | null = rootAbs; // null = untrackable
  const blocked = (token: string) =>
    `parent-directory traversal escapes the workspace (${token}); use workspace-relative paths instead`;
  const sanctioned = (p: string) => sanctionedToolDirs().some((dir) => inside(dir, p));
  for (const segment of splitSegments(command)) {
    const cd = /^cd\s+(?:"([^"]*)"|'([^']*)'|([^\s]+))\s*$/.exec(segment);
    if (cd) {
      const target = cd[1] ?? cd[2] ?? cd[3] ?? "";
      if (/[$`~]/.test(target)) {
        cwd = null; // dynamic target — later `..` can't be verified
        continue;
      }
      const resolved = cwd === null ? resolveAbsoluteOnly(target) : resolveAgainst(cwd, target);
      if (resolved === null) {
        if (DOTDOT_COMPONENT.test(target.replace(/\\/g, "/"))) return blocked(`cd ${target}`);
        continue;
      }
      if (!inside(rootAbs, resolved) && !sanctioned(resolved)) {
        if (DOTDOT_COMPONENT.test(target.replace(/\\/g, "/"))) return blocked(`cd ${target}`);
        continue; // absolute escape — the absolute-path guard reports it
      }
      cwd = resolved;
      continue;
    }
    for (const match of segment.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/g)) {
      const token = (match[1] ?? match[2] ?? match[3] ?? "").replace(/^[<>=(),]+|[;,|&]+$/g, "");
      const norm = token.replace(/\\/g, "/");
      if (!DOTDOT_COMPONENT.test(norm) || /^https?:\/\//i.test(norm)) continue;
      if (staysInside(token, cwd, rootAbs, sanctioned)) continue;
      // A quoted span is not always one path: `cmd //c "..\.sdk\x\aapt.exe dump
      // badging $APK"` is a whole command line, where the `..` path and the
      // unexpandable `$APK` are different WORDS. Judging the span as a unit
      // condemned the path for a `$` that had nothing to do with it (2026-08-16,
      // a k3 run). Re-judge word by word — but only after the whole-token test,
      // so a legitimately quoted path WITH spaces is still judged as one path.
      const words = token.split(/\s+/).filter(Boolean);
      const everyWordContained = words.every((word) =>
        !DOTDOT_COMPONENT.test(word.replace(/\\/g, "/")) || staysInside(word, cwd, rootAbs, sanctioned),
      );
      if (words.length > 1 && everyWordContained) continue;
      return blocked(token);
    }
  }
  return null;
}

// Does this one token resolve to a path the workspace still contains? `$`/
// backtick make the real path unknowable, and so does an untracked cwd — both
// stay conservatively "no".
function staysInside(
  token: string,
  cwd: string | null,
  rootAbs: string,
  sanctioned: (p: string) => boolean,
): boolean {
  if (/[$`]/.test(token) || cwd === null) return false;
  const resolved = resolveAgainst(cwd, token);
  if (resolved === null) return false;
  return inside(rootAbs, resolved) || sanctioned(resolved);
}

// Resolve a cd target while the tracked cwd is unknown: only an absolute path
// can re-anchor tracking; anything relative stays unknown.
function resolveAbsoluteOnly(token: string): string | null {
  const norm = token.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(norm)) return path.win32.resolve(token);
  if (/^\/[A-Za-z](?:\/|$)/.test(norm) && process.platform === "win32") {
    return gitBashWindowsPath(norm);
  }
  return null;
}

// This guard is an enforceable boundary for direct model-supplied paths and the
// common accidental escapes (`cd ..`, absolute host paths, credential files).
// It is paired with a credential-free child environment. It deliberately does
// not pretend that arbitrary third-party build scripts are a hostile-code VM;
// deployments that execute untrusted repositories must still put the whole
// harness inside a container/VM.
export function commandScopeViolation(
  command: string,
  root: string,
  access: "workspace" | "full",
  // P13（X18）：用户在卡片上放行的工作区外只读目录（与 DIMENSIO_READONLY_PATHS 同样只放行纯读命令）
  readRoots: string[] = [],
): string | null {
  const normalized = command.replace(/\\/g, "/");
  // 凭据库的名字出现在命令行任何一个路径段上都拒。S4（#37③）：以前前导字符不含 `/`，
  // 只认词首——`cat ./.env`、`cat config/.env`、`cat ~/.ssh/id_rsa`、绝对路径全漏。
  if (/(^|[\s'"=;|&(/])(?:\.env(?:\.[^\s'";|&)/]+)?|\.ssh|\.aws|\.gnupg|\.azure|\.cloudflared|\.git-credentials|\.netrc|_netrc|\.npmrc|\.pypirc|\.?credentials\.json|id_rsa|id_ed25519|id_ecdsa|id_dsa)(?=$|[\s/'";|&)])/i.test(normalized)) {
    return "command references a credential store blocked by the secret guard";
  }
  // Every resolvable path (absolute, git-bash /c/…, ~/…) goes through the SAME
  // verdict as Read/Grep/Browser (S4): credential names, the extension registry,
  // the bridge config, and — outside the workspace — key material (.pem/.key,
  // judged by LOCATION: inside the workspace those are the agent's own fixtures)
  // and per-user dot directories under the home folder. Both access modes.
  for (const candidate of filesystemPathCandidates(command)) {
    if (/^https?:\/\//i.test(candidate.path)) continue;
    const abs = resolveCandidate(candidate.path);
    const verdict = abs ? readVerdict(abs, root) : null;
    if (verdict) return `${verdict}: ${candidate.path}`;
  }
  // 候选路径没抽出来的写法（引号拼接、变量里的前缀…）再按真实扩展根做一次字面兜底。
  const lower = normalized.toLowerCase();
  if (managedExtensionRoots().some((root) => lower.includes(root.replace(/\\/g, "/").toLowerCase() + "/registry.json"))) {
    return "the extension registry (connector credentials) is blocked by the secret guard";
  }
  // S6（#23）：UNC（\\host\share、git-bash 的 //host/share）与 NT/设备命名空间写法，两种模式都拒。
  for (const token of commandTokens(command)) {
    const alias = pathAliasViolation(token);
    if (alias) return `${alias}: ${token}`;
  }
  const state = protectedStateCommandViolation(command, root);
  if (state) return state;
  if (access === "full") return null;
  const dotdot = dotdotEscapeViolation(command, root);
  if (dotdot) return dotdot;
  // S6（#17）：字面在工作区里、真实落点在外面——工作区里一个指出去的 junction / 符号链接
  // （mklink /J 不要管理员）。命令里凡是存在于工作区内的路径，都按 realpath 再判一次边界。
  const realRoot = realOrNearest(root) ?? path.resolve(root);
  for (const token of commandTokens(command)) {
    if (token.startsWith("-") || /^[a-z][a-z0-9+.-]*:\/\//i.test(token) || /[*?$`]/.test(token)) continue;
    const abs = resolveCandidate(token) ?? path.resolve(root, token);
    if (!inside(path.resolve(root), abs) || !existsSync(abs)) continue;
    const real = realOrNearest(abs);
    if (real && !inside(realRoot, real) && !sanctionedToolDirs().some((dir) => inside(dir, real))) {
      return `path escapes the workspace through a link or junction: ${token} → ${real}` + ACCESS_HINT;
    }
  }
  // $HOME/%USERPROFILE% expand later in the shell, so they can point anywhere and
  // stay refused outright. A literal `~/x` is resolvable, so it goes through the
  // candidate check below like any other path and can be read-allowlisted.
  if (/(^|[\s'"=;|&(])(?:\$HOME\b|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE\b)/i.test(normalized)) {
    return "home-directory variables are blocked in workspace mode" + ACCESS_HINT;
  }

  // Reads have no side effects, so a directory the user explicitly opened for
  // reading is reachable — but only by a command that is a plain read all the way
  // through, and never as a redirect target.
  const pureRead = isReadOnlyCommand(command);
  for (const { path: raw, write } of filesystemPathCandidates(command)) {
    // URLs are not filesystem paths. Git-Bash /c/... paths are converted back
    // to Windows before the containment comparison.
    if (/^https?:\/\//i.test(raw)) continue;
    const candidate = resolveCandidate(raw);
    // Granted Bridge extension skills are sanctioned in every access mode;
    // everything else outside the workspace is blocked.
    if (candidate && sanctionedToolDirs().some((dir) => inside(dir, candidate))) continue;
    if (candidate && !inside(path.resolve(root), path.resolve(candidate))) {
      if (!write && pureRead && (insideReadOnlyRoot(candidate) || readRoots.some((dir) => inside(path.resolve(dir), path.resolve(candidate))))) continue;
      return `absolute path escapes the workspace: ${raw}${outsideHint(candidate, write)}`;
    }
  }
  return null;
}

// P13（X18）：这条命令被拒，是不是「纯读命令读了工作区外」——是的话给出第一个越界的落点（loop 问人要不要放行这次读）。
// 只认纯读命令（ls / cat / grep / find / head …）：别的命令读外面的东西，放行了也照样被上面拒，不弹卡。写、凭据、
// 别名 / 链接、`..` 这些别的拒绝理由都不给放行（commandScopeViolation 先过它们，这里只在它报「绝对路径越界」时才问）。
export function outsideReadCandidate(command: string, root: string, readRoots: string[] = []): string | null {
  if (!isReadOnlyCommand(command)) return null;
  for (const { path: raw, write } of filesystemPathCandidates(command)) {
    if (/^https?:\/\//i.test(raw)) continue;
    const candidate = resolveCandidate(raw);
    if (!candidate || sanctionedToolDirs().some((dir) => inside(dir, candidate))) continue;
    if (inside(path.resolve(root), path.resolve(candidate))) continue;
    if (write) return null;
    if (insideReadOnlyRoot(candidate) || readRoots.some((dir) => inside(path.resolve(dir), path.resolve(candidate)))) continue;
    return path.resolve(candidate);
  }
  return null;
}

function detectShell(): ShellInfo {
  if (process.platform === "win32") {
    const gitBash = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ].find((p) => existsSync(p));
    if (gitBash) {
      return { kind: "bash", path: gitBash, argsFor: (c) => ["-c", c] };
    }
    return {
      kind: "powershell",
      path: "powershell.exe",
      argsFor: (c) => ["-NoProfile", "-NonInteractive", "-Command", c],
    };
  }
  return { kind: "sh", path: "/bin/sh", argsFor: (c) => ["-c", c] };
}

// ── Background jobs ───────────────────────────────────────────────────────────
// The sync path blocks until close and is capped at bashMaxTimeoutMs (10 min) —
// too short for full test suites of big repos. A background job returns a job id
// immediately, keeps running across turns, and is read back via poll. Servers
// still belong to the Preview tool (port-aware, live pane); this is for finite
// long commands. Jobs intentionally ignore the per-run abort signal — they are
// meant to outlive the turn — and die on poll/kill, hard timeout, or shutdown.

interface BashJob {
  id: string;
  command: string;
  child: ChildProcess;
  out: OutBuf;
  done: boolean;
  exitCode: number | null;
  timedOut: boolean;
  startedAt: number;
  // Session that started it ("" = unowned: sub-agents, tests, headless). poll and
  // kill only ever see jobs with the SAME owner, so a second concurrent session
  // cannot read another's output or kill its test run.
  owner: string;
  // 兜底收线：kill 之后进程没死透时，还是把 job 标成 done（见 whenFinished）。
  markKilled: () => void;
  // V1：以 verify:true 启动（bash 下带着 set -eo pipefail 跑）——之后 poll 时才能拿它当证据。
  verifyMode: boolean;
  // U11：结束的时刻（列表里算跑了多久）；killed = 被 Bash(kill) 或界面「停止」收掉的（不是自己退的）
  endedAt?: number;
  killed?: boolean;
  // O6（K63）：Bash(wait) 在等它的（结束时逐个唤醒）
  waiters: Set<() => void>;
}

function wakeWaiters(job: BashJob): void {
  for (const wake of [...job.waiters]) wake();
}

const jobs = new Map<string, BashJob>();
let jobSeq = 0;
// O6（K63）：job id 带这个进程的启动标记（job3-k2x9）。以前是进程内计数 job3——harness 一重启又从 job1 编起，模型拿重启前的
// job3 去 poll，读到的是重启后另一个 job 的输出（同一会话），或者只得到一句「没有这个 job」、不知道为什么。
const BOOT_AT = Date.now();
const BOOT_TAG = BOOT_AT.toString(36).slice(-4);

// 按 id 找这个会话的 job：完整 id 精确匹配；不带标记的 job3 按本进程的第 3 个（兼容旧写法）
function findJob(id: string, owner: string): BashJob | undefined {
  const exact = jobs.get(id);
  if (exact) return exact.owner === owner ? exact : undefined;
  const bare = /^job(\d+)$/.exec(id);
  const j = bare ? jobs.get(`job${bare[1]}-${BOOT_TAG}`) : undefined;
  return j?.owner === owner ? j : undefined;
}

// 找不到的 job：带着别的启动标记（或者是重启前的旧写法）→ 明说是重启丢的，别让模型对着「不存在」发愣
function unknownJob(id: string, owner: string): ToolRunResult {
  const known = ownedJobs(owner).map((x) => x.id).join(", ") || "(none)";
  const tag = /^job\d+-([a-z0-9]+)$/.exec(id)?.[1];
  const fromBefore = (tag !== undefined && tag !== BOOT_TAG) || /^job\d+$/.test(id);
  const since = new Date(BOOT_AT).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return fail(
    "unknown job",
    fromBefore
      ? `No background job "${id}" in this harness process. Background jobs do not survive a harness restart, and this process ` +
          `started at ${since} — a job started before that was stopped with it. Known jobs now: ${known}. Re-run the command if you still need it.`
      : `No background job "${id}". Known jobs: ${known}.`,
  );
}

// R14（K37）：正在前台跑的 Bash 调用（会话 + 调用 id → 转后台的开关）。界面上的「转后台」经 API 按到这里；只认同一个会话的。
const foreground = new Map<string, () => boolean>();
const foregroundKey = (owner: string, callId: string) => `${owner}\u0000${callId}`;
export function moveForegroundToBackground(owner: string, callId: string): boolean {
  return foreground.get(foregroundKey(owner, callId))?.() ?? false;
}

// R14（K37）：界面上的实时尾行——最后 12 行、至多 2000 字，先脱敏；跑满这么久才给「转后台」按钮
const LONG_RUN_MS = 10_000;
function liveTail(b: OutBuf): string {
  const text = redactSecrets(dropJavaPickup(b.tail || b.head));
  return text.split("\n").slice(-12).join("\n").slice(-2_000);
}

function prependNote(r: ToolRunResult, note: string): ToolRunResult {
  const [first, ...rest] = r.content ?? [];
  if (first?.t !== "text") return { ...r, content: [{ t: "text", text: note }, ...(r.content ?? [])] };
  return { ...r, content: [{ t: "text", text: `${note}\n${first.text}` }, ...rest] };
}
const MAX_ACTIVE_JOBS = 8;
const BG_DEFAULT_TIMEOUT_MS = 1_800_000; // 30 min hard kill unless overridden
const BG_MAX_TIMEOUT_MS = 7_200_000; // 2 h ceiling
const BG_EARLY_WINDOW_MS = 1_200; // catch instant failures before returning

// Jobs visible to one owner. Scoping is per session, so the 8-job budget is
// per session too (a busy session can't starve another out of background slots).
const ownedJobs = (owner: string) => [...jobs.values()].filter((j) => j.owner === owner);

async function startJob(
  command: string,
  timeoutMs: number,
  cwd: string,
  verify: boolean,
  owner: string,
): Promise<ToolRunResult> {
  const active = ownedJobs(owner).filter((j) => !j.done).length;
  if (active >= MAX_ACTIVE_JOBS) {
    return fail(
      "too many jobs",
      `${MAX_ACTIVE_JOBS} background jobs are already running. Poll them (Bash(poll:"<id>")) or kill one (Bash(kill:"<id>")) first.`,
    );
  }
  const id = `job${++jobSeq}-${BOOT_TAG}`;
  const verifyMode = verify && shell.kind === "bash";
  const child = spawn(shell.path, shell.argsFor(verifyMode ? VERIFY_ERREXIT + command : command), {
    cwd,
    windowsHide: true,
    env: childEnv(),
  });
  const job: BashJob = {
    id,
    command,
    child,
    out: { head: "", tail: "", omitted: 0, spillTo: spillFor(owner || undefined) },
    done: false,
    exitCode: null,
    timedOut: false,
    startedAt: Date.now(),
    owner,
    markKilled: () => {},
    verifyMode,
    waiters: new Set(),
  };
  jobs.set(id, job);
  trackJob(job);

  const stdoutPump = streamPump(job.out);
  const stderrPump = streamPump(job.out);
  child.stdout?.on("data", stdoutPump.write);
  child.stderr?.on("data", stderrPump.write);

  let timer: ReturnType<typeof setTimeout> | undefined;
  // 早退窗口的收线；命令结束得比窗口还快就当场松开。
  let onFinished: () => void = () => {};

  // 同步路径那个死锁在这儿是另一副面孔：job 永远不 done，poll 永远回「running for
  // Ns」，kill 打的又是早就退了的 shell —— 一个已经结束的 job 在会话里永远交代不掉。
  const finished = whenFinished(child, [stdoutPump, stderrPump], (code) => {
    if (timer) clearTimeout(timer);
    // R13：落盘文件写完关上再报完成（poll 到「完成」时文件已经齐了）
    void closeSpill(job.out).finally(() => {
      job.done = true;
      job.exitCode = code;
      job.endedAt ??= Date.now();
      onFinished();
      wakeWaiters(job);
    });
  });
  job.markKilled = finished.markKilled;

  timer = setTimeout(() => {
    job.timedOut = true;
    killTree(child);
    finished.markKilled();
  }, timeoutMs);

  child.on("error", (e) => {
    pushOut(job.out, `\n[spawn error: ${e.message}]`);
    job.done = true;
    job.endedAt ??= Date.now();
    if (timer) clearTimeout(timer);
    onFinished();
    wakeWaiters(job);
  });

  // Brief grace window so a typo'd command reports its failure right away
  // instead of costing the model a poll turn to discover it.
  await new Promise<void>((resolve) => {
    if (job.done) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, BG_EARLY_WINDOW_MS);
    onFinished = () => {
      clearTimeout(t);
      resolve();
    };
  });

  if (job.done) {
    const status = job.timedOut ? "timeout" : `exit ${job.exitCode}`;
    const output = renderOut(job.out);
    return {
      ok: !job.timedOut && job.exitCode === 0,
      summary: `bash job ${id} exited immediately (${status})`,
      content: [
        {
          t: "text",
          text: `$ ${command}\n[background job ${id} exited immediately: ${status}]\n${output || "(no output)"}`,
        },
      ],
      ...(verify ? { verification: verifyOutcome(command, status, !job.timedOut && job.exitCode === 0, output) } : {}),
    };
  }
  const early = renderOut(job.out);
  return {
    ok: true,
    summary: `bash job ${id} started: ${command.slice(0, 50)}${command.length > 50 ? "…" : ""}`,
    content: [
      {
        t: "text",
        text:
          `Started background job ${id}: $ ${command}\n` +
          `It keeps running across turns (hard kill after ${Math.round(timeoutMs / 60_000)} min). ` +
          `Read its output with Bash(poll:"${id}"); stop it with Bash(kill:"${id}").` +
          (early ? `\nEarly output:\n${early}` : ""),
      },
    ],
  };
}

function pollJob(id: string, verify: boolean, owner: string, waited?: { ms: number; stillRunning: boolean }): ToolRunResult {
  const j = findJob(id, owner);
  // Another session's job reads as "unknown" — never confirm it exists, and never
  // hand back its output.
  if (!j) return unknownJob(id, owner);
  const elapsed = Math.round((Date.now() - j.startedAt) / 1000);
  const status = j.done
    ? j.timedOut
      ? "killed by timeout"
      : `exit ${j.exitCode}`
    : `running for ${elapsed}s`;
  const output = renderOut(j.out);
  const body = output || "(no output yet)";
  // V1：poll 时拿 job 当证据，它得是以 verify:true 启动的（pipefail 已开），或本来就是一条单独的命令。
  const why = verify
    ? unattributableVerify(j.command) ??
      (!j.verifyMode && controlOperators(j.command.trim()).length
        ? "the job was started without verify:true, so its pipes/statements ran without pipefail"
        : null)
    : null;
  return {
    ok: j.done ? !j.timedOut && j.exitCode === 0 : true,
    summary: `bash job ${j.id}: ${status}`,
    content: [
      {
        t: "text",
        text:
          `$ ${j.command}\n[${status}]\n${body}` +
          (j.done
            ? ""
            : waited?.stillRunning
              ? `\n[still running after waiting ${Math.round(waited.ms / 1000)}s — wait again, poll later, or kill it]`
              : "\n[still running — wait for it, poll again later, or kill it]") +
          (why ? `\n[not recorded as verification evidence: ${why}]` : ""),
      },
    ],
    ...(verify && j.done && !why
      ? { verification: verifyOutcome(j.command, status, !j.timedOut && j.exitCode === 0, output) }
      : {}),
  };
}

function killJob(id: string, owner: string): ToolRunResult {
  const j = findJob(id, owner);
  if (!j) return unknownJob(id, owner);
  if (!j.done) {
    j.killed = true;
    killTree(j.child);
    j.markKilled();
  }
  return {
    ok: true,
    summary: `bash job ${j.id} killed`,
    content: [
      { t: "text", text: `Killed job ${j.id}.\nOutput so far:\n${renderOut(j.out) || "(no output)"}` },
    ],
  };
}

// O6（K63）：等一个后台 job 跑完（或等到时限）再交回，和 poll 同样的输出——以前模型只能一遍遍 poll，或者自己 sleep 再 poll。
// 这一轮被停止时不等了、照当下的样子交回；等的时候照前台命令的样子推实时尾行。
const WAIT_DEFAULT_MS = 120_000;
async function waitJob(id: string, verify: boolean, owner: string, timeoutMs: number, ctx: ToolContext): Promise<ToolRunResult> {
  const j = findJob(id, owner);
  if (!j) return unknownJob(id, owner);
  const started = Date.now();
  if (!j.done) {
    await new Promise<void>((resolve) => {
      const done = () => {
        clearInterval(tick);
        clearTimeout(limit);
        j.waiters.delete(done);
        ctx.signal?.removeEventListener("abort", done);
        resolve();
      };
      j.waiters.add(done);
      const limit = setTimeout(done, timeoutMs);
      const tick = setInterval(() => {
        if (ctx.emit && ctx.callId) ctx.emit({ e: "tool_progress", id: ctx.callId, tail: liveTail(j.out), elapsedMs: Date.now() - j.startedAt, canBackground: false });
      }, 1_000);
      if (ctx.signal?.aborted) done();
      else ctx.signal?.addEventListener("abort", done, { once: true });
    });
  }
  return pollJob(j.id, verify, owner, { ms: Date.now() - started, stillRunning: !j.done });
}

// O6（K63）：压缩之后提醒还在跑的 job——摘要的锚点索引收不到 job id，模型压完就不知道自己有什么在跑
export function runningJobsSummary(owner: string): string {
  return ownedJobs(owner)
    .filter((j) => !j.done)
    .map((j) => `${j.id} ($ ${j.command.length > 60 ? j.command.slice(0, 60) + "…" : j.command}; running ${Math.max(1, Math.round((Date.now() - j.startedAt) / 60_000))} min)`)
    .join(", ");
}

// U11：一个会话的后台 job 一览——Bash(jobs:true) 给模型（压缩之后 job id 丢了也找得回来），/api/sessions/:id/jobs 给
// 任务面板。只认这个会话自己的；输出只给实时尾行那一截（最后 12 行、至多 2000 字、先脱敏），命令本身也先脱敏。
export interface JobInfo {
  id: string;
  command: string;
  state: "running" | "exited" | "timeout" | "killed";
  exitCode: number | null;
  startedAt: number;
  endedAt?: number;
  // 按服务端时钟算好的已跑时长——手机与电脑的时钟对不齐，界面拿它加上本机流逝的时间，不自己拿 startedAt 减
  elapsedMs: number;
  tail: string;
}

function jobInfo(j: BashJob): JobInfo {
  const state = !j.done ? "running" : j.timedOut ? "timeout" : j.killed ? "killed" : "exited";
  const endedAt = j.done ? j.endedAt : undefined;
  return {
    id: j.id,
    command: redactSecrets(j.command).slice(0, 2_000),
    state,
    exitCode: j.exitCode,
    startedAt: j.startedAt,
    ...(endedAt ? { endedAt } : {}),
    elapsedMs: Math.max(0, (endedAt ?? Date.now()) - j.startedAt),
    tail: liveTail(j.out),
  };
}

// 新的在前
export function listJobs(owner: string): JobInfo[] {
  return ownedJobs(owner)
    .map(jobInfo)
    .sort((a, b) => b.startedAt - a.startedAt || Number(b.id.slice(3)) - Number(a.id.slice(3)));
}

// 界面「停止」：只认这个会话自己的、还在跑的 job。false = 没有这个 job / 已经结束了。
export function stopJob(owner: string, id: string): boolean {
  const j = findJob(id, owner);
  if (!j || j.done) return false;
  killJob(j.id, owner);
  return true;
}

function jobsResult(owner: string): ToolRunResult {
  const list = listJobs(owner);
  if (!list.length) return ok("bash jobs: none", "No background jobs in this session.");
  const line = (j: JobInfo) => {
    const secs = Math.round(j.elapsedMs / 1000);
    const status =
      j.state === "running"
        ? `running for ${secs}s`
        : j.state === "timeout"
          ? `killed by timeout after ${secs}s`
          : j.state === "killed"
            ? `killed after ${secs}s`
            : `exit ${j.exitCode} after ${secs}s`;
    return `- ${j.id} · ${status} · $ ${j.command.length > 200 ? `${j.command.slice(0, 200)}…` : j.command}`;
  };
  const running = list.filter((j) => j.state === "running").length;
  return ok(
    `bash jobs: ${running} running, ${list.length - running} finished`,
    `Background jobs of this session (${list.length}, newest first):\n${list.map(line).join("\n")}\n` +
      'Read one\'s output with Bash(poll:"<id>"); stop a running one with Bash(kill:"<id>").',
  );
}

// M5（K03）：后台 job 一起来就进会话资源账本（resources.ts）——停止 / 删除会话由账本逆序收掉：活着的杀进程树，
// 记录一并删。两条起 job 的路（startJob、前台转后台）都登记。
function trackJob(job: BashJob): void {
  registerResource(job.owner, "job", job.id, () => {
    const live = !job.done;
    if (live) killTree(job.child);
    jobs.delete(job.id);
    return live;
  });
}

// Shutdown cleanup (wired into the server's exit handlers).
export function killAllJobs(): void {
  disposeAll("shutdown", ["job"]);
  for (const j of jobs.values()) {
    if (!j.done) killTree(j.child);
  }
  jobs.clear();
}

// Stop one session's background jobs — what "stop this session" has to mean, and
// what session deletion needs so a deleted conversation's test run doesn't keep
// burning CPU. Returns how many live jobs were actually killed.
export function killJobsFor(owner: string): number {
  return disposeOwner(owner, "stop", ["job"]).job;
}

// Live job count for one owner (stopSession reports honestly with this).
export function liveJobCount(owner: string): number {
  return ownedJobs(owner).filter((j) => !j.done).length;
}

// C4：这个会话已经结束的后台 job（World State 的 jobs 节）。只列结束了的——开跑是模型自己做的，结束它才不知道；
// 不带耗时之类每轮都变的东西，只在又有 job 结束时才变。
export function finishedJobsSummary(owner: string): string {
  return ownedJobs(owner)
    .filter((j) => j.done)
    .map((j) => `${j.id} (${j.timedOut ? "timed out" : j.exitCode === null ? "killed" : `exit ${j.exitCode}`})`)
    .join(", ");
}

export const bashTool: Tool = {
  effect: "exec",
  concurrencySafe: false,
  // P4：按子命令给规则判定（A5）、纯读命令降为 read（C9）、分析不了的高危命令转问（K5）。硬拒仍在 run() 里。
  // P5：顺带给「本会话按前缀允许」的候选前缀。P12：检查点兜不住的操作也转问——这两类都只给字面规则、不给前缀。
  permissionView(args) {
    const command = typeof args.command === "string" ? args.command : "";
    // U11：列 job、看 job 的输出都不跑命令——只读档 / 计划档也能用（kill 不算，那是动作）
    if (!command.trim() && (args.jobs === true || [args.poll, args.wait].some((v) => typeof v === "string" && v.trim()))) return { effect: "read" };
    if (!command.trim()) return null;
    const parsed = parseShell(command, shellDialect());
    const risk = assessParsed(parsed, command);
    const prefixes = stablePrefixes(parsed);
    const touches = shellTouches(parsed);
    const destructive = destructiveView(parsed, command);
    return {
      ...(readOnlyCommand(parsed) && args.background !== true ? { effect: "read" as const } : {}),
      subjects: ruleSubjects(parsed),
      ...(parsed.unanalyzable ? { partial: true } : {}),
      ...(!risk.deny && risk.ask ? { ask: risk.ask } : {}),
      ...(!risk.deny && risk.irreversible ? { irreversible: risk.irreversible } : {}),
      ...(!risk.deny && risk.why ? { why: risk.why } : {}), // P11：给人看的那句
      ...(prefixes && !risk.ask && !risk.irreversible ? { prefixes } : {}),
      ...(touches.writes.length ? { writes: touches.writes } : {}),
      ...(touches.edits.length ? { edits: touches.edits } : {}),
      ...(touches.mentions.length ? { mentions: touches.mentions } : {}),
      // N26：poll / kill 不跑命令，不算
      ...(destructive.destroys && !args.poll && !args.wait && !args.kill ? { destroys: true } : {}),
      ...(destructive.onlyDestroys ? { onlyDestroys: true } : {}),
    };
  },
  // P11（kimi K20）：注定会被 run() 拦下的命令（危险命令名单、宿主自保、工作区围栏）在弹卡之前就回给模型——以前有 ask 规则
  // 或转问时先弹一张卡，批了才被拦，卡片白问。说法与 run() 里一字不差（run() 仍照拦，直接调 run 的不受影响）。
  prepare(args, ctx) {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) return null;
    const readRoots = ctx.sandbox.grantedReadRoots();
    const policy = commandPolicyViolation(command, ctx.sandbox.root, ctx.sandbox.access, readRoots);
    if (!policy) return null;
    // P13：只差「读工作区外」的不在这里否决——run() 报出结构化的越界，loop 问人要不要放行这次读
    if (outsideReadDirs(command, ctx.sandbox.root, ctx.sandbox.access, readRoots)) return null;
    return { veto: { summary: "blocked", content: policy } };
  },
  def: {
    name: "Bash",
    description:
      `Run a shell command in the sandbox working directory using ${shell.kind}. ` +
      (shell.kind === "powershell"
        ? "Use PowerShell syntax. "
        : "Use POSIX sh syntax — this is NOT PowerShell (no `&` call operator, no `@'...'@` here-strings), even on Windows. ") +
      "State (env, cwd changes) does NOT persist between calls. Quote paths with spaces. " +
      (shell.kind === "bash" && process.platform === "win32"
        ? "Scratch files: this bash resolves /tmp through its own MSYS mount, which native Windows " +
          "programs do NOT share — python/java read \"/tmp/x\" against the current drive instead. " + // guard: tmp-literal ok — 给模型的说明文字，正是在提醒别这么写
          "Put anything both sides must see under $WORKSPACE_TMP (already set, already created) " +
          "or inside the workspace. "
        : "") +
      "Use for builds, tests, git, package managers. Prefer Read/Edit/Grep/Glob over cat/sed/grep/find. " +
      "For commands longer than ~2 minutes (full test suites, long builds) pass background:true — " +
      "you get a job id immediately and can keep working; read output with poll, wait for it to finish with wait, stop with kill. " +
      "Never run a SERVER this way — use the Preview tool for servers.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command line to execute (omit when using poll/kill)." },
        timeout: {
          type: "integer",
          description:
            "Timeout in ms. Sync: default 120000, max 600000 — asking for more runs the command in the background; a sync command " +
            "that reaches its timeout is moved to the background (not killed) and you get a job id to poll. " +
            "Background: hard-kill limit, default 1800000 (30 min), max 7200000.",
        },
        background: {
          type: "boolean",
          description:
            "Run as a background job: returns a job id immediately instead of blocking. For long finite commands, not servers.",
        },
        poll: { type: "string", description: "Job id to check: returns its accumulated output and status." },
        wait: {
          type: "string",
          description:
            "Job id to wait for: blocks until the job finishes (or until timeout ms, default 120000, max 600000) and returns what poll " +
            "would. Use this instead of polling in a loop or sleeping.",
        },
        kill: { type: "string", description: "Job id to terminate." },
        jobs: {
          type: "boolean",
          description: "List this session's background jobs (id, status, runtime, command) — e.g. to find a job id you no longer have.",
        },
        verify: {
          type: "boolean",
          description:
            "Mark this as completion evidence. Counts only when the command (or polled job) has finished with exit 0 " +
            "and actually ran tests; failed/running commands never clear the post-edit verification gate. The exit " +
            "status must belong to the check: `||` fallbacks, `&` backgrounding and a leading `!` are refused" +
            (shell.kind === "bash"
              ? "; pipes and multiple statements are fine (verify mode runs with set -eo pipefail)."
              : "; only a single plain command counts."),
        },
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const owner = ctx.ownerId ?? "";
    if (args.jobs === true && !String(args.command ?? "").trim()) return jobsResult(owner);
    const pollId = args.poll ? String(args.poll) : "";
    if (pollId) return pollJob(pollId, args.verify === true, owner);
    const waitId = args.wait ? String(args.wait) : "";
    if (waitId) {
      const asked = typeof args.timeout === "number" && args.timeout > 0 ? args.timeout : WAIT_DEFAULT_MS;
      return waitJob(waitId, args.verify === true, owner, Math.min(asked, ctx.limits.bashMaxTimeoutMs), ctx);
    }
    const killId = args.kill ? String(args.kill) : "";
    if (killId) return killJob(killId, owner);

    const command = String(args.command ?? "").trim();
    if (!command) {
      return fail("empty command", "No command provided (pass command, poll/kill with a job id, or jobs:true to list the jobs).");
    }
    if (args.verify === true && !commandCanVerify(command)) {
      return {
        ...fail(
          "not a verification command",
          "This read-only/trivial command cannot be used as completion evidence. Run a relevant test, build, assertion, or program check instead.",
        ),
        verification: { passed: false, detail: `${command} is not meaningful completion evidence` },
      };
    }

    const readRoots = ctx.sandbox.grantedReadRoots();
    const policy = commandPolicyViolation(command, ctx.sandbox.root, ctx.sandbox.access, readRoots);
    if (policy) {
      // P13（X18）：只差「读工作区外」——带上要放行的目录，有人在场时 loop 会问一句、批了就重跑
      const dirs = outsideReadDirs(command, ctx.sandbox.root, ctx.sandbox.access, readRoots);
      return { ...fail("blocked", policy), ...(dirs ? { outsideRead: { dirs } } : {}) };
    }

    if (args.verify === true) {
      const why = unattributableVerify(command);
      if (why) return unattributableFail(command, why);
    }

    if (args.background) {
      const bgTimeout = Math.min(
        BG_MAX_TIMEOUT_MS,
        Math.max(1000, Number(args.timeout ?? BG_DEFAULT_TIMEOUT_MS)),
      );
      return startJob(command, bgTimeout, ctx.sandbox.root, args.verify === true, owner);
    }

    const asked = Number(args.timeout ?? ctx.limits.bashTimeoutMs);
    const requested = Number.isFinite(asked) ? asked : ctx.limits.bashTimeoutMs;
    // R14（N32）：要的时限超过前台上限，就直接交给后台 job——以前先在前台跑满上限再杀，白等 10 分钟还丢了结果。
    if (requested > ctx.limits.bashMaxTimeoutMs) {
      const started = await startJob(command, Math.min(BG_MAX_TIMEOUT_MS, requested), ctx.sandbox.root, args.verify === true, owner);
      return prependNote(
        started,
        `(The requested timeout of ${requested} ms is above the ${ctx.limits.bashMaxTimeoutMs} ms foreground limit, so this runs as a background job.)`,
      );
    }
    const timeout = Math.min(ctx.limits.bashMaxTimeoutMs, Math.max(1000, requested));

    const runCmd = args.verify === true && shell.kind === "bash" ? VERIFY_ERREXIT + command : command;
    return await new Promise<ToolRunResult>((resolve) => {
      const startedAt = Date.now();
      const child = spawn(shell.path, shell.argsFor(runCmd), {
        cwd: ctx.sandbox.root,
        windowsHide: true,
        env: childEnv(),
      });

      const out: OutBuf = { head: "", tail: "", omitted: 0, spillTo: spillFor(ctx.ownerId) };
      const stdoutPump = streamPump(out);
      const stderrPump = streamPump(out);
      child.stdout.on("data", stdoutPump.write);
      child.stderr.on("data", stderrPump.write);

      // 这两条路径必须走 killTree，不能走 child.kill()。child 是 shell（Windows 上
      // 是 git-bash.exe），真正干活的命令是它的孙进程；TerminateProcess 只打 shell，
      // 孙进程当场变孤儿继续跑。实测（2026-09-10，bash -c 起一个每 300ms 写文件的
      // node）：plain kill 之后 4 秒内文件从 10 行涨到 23 行，taskkill /T /F 之后
      // 只多 1 行。后台 job 那条路一直是对的（startJob/killJob 都用 killTree），
      // 就这条同步路径漏了——表现就是「点了停止、按钮灰了，进程还在跑」。
      // 杀完还要 markKilled：进程万一没死透，'exit' 不会来，靠它保证有结局。
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let moved: BashJob | null = null;
      let bgTimer: ReturnType<typeof setTimeout> | undefined;
      const fgKey = ctx.callId ? foregroundKey(owner, ctx.callId) : null;

      const abort = () => {
        aborted = true;
        killTree(child);
        finished.markKilled();
      };

      // R14（B4 / K37）：到点（或用户点了「转后台」）不杀——把还活着的进程连同输出缓冲移交给后台 job 表，这一次调用先交回已有的
      // 输出和 job id，之后照常 poll / kill。后台的硬上限从开跑算 30 分钟。后台 job 已满时返回 false，调用方退回老办法（杀掉）。
      const moveToBackground = (why: "timeout" | "user"): boolean => {
        if (moved || settled) return false;
        if (ownedJobs(owner).filter((j) => !j.done).length >= MAX_ACTIVE_JOBS) return false;
        if (timer) clearTimeout(timer);
        stopTicker();
        ctx.signal?.removeEventListener("abort", abort);
        if (fgKey) foreground.delete(fgKey);
        const id = `job${++jobSeq}-${BOOT_TAG}`;
        const job: BashJob = {
          id, command, child, out, done: false, exitCode: null, timedOut: false, startedAt, owner,
          markKilled: finished.markKilled, verifyMode: runCmd !== command, waiters: new Set(),
        };
        jobs.set(id, job);
        trackJob(job);
        moved = job;
        bgTimer = setTimeout(() => {
          job.timedOut = true;
          killTree(child);
          finished.markKilled();
        }, Math.max(60_000, BG_DEFAULT_TIMEOUT_MS - (Date.now() - startedAt)));
        const secs = Math.round((Date.now() - startedAt) / 1000);
        const who = why === "user" ? "the user moved it" : "it hit the timeout and was moved";
        resolve({
          ok: true,
          summary: `bash: ${command.slice(0, 60)}${command.length > 60 ? "…" : ""} (moved to background as ${id})`,
          outcome: `跑了 ${secs} 秒还没完，转到后台继续（${id}）`,
          content: [{
            t: "text",
            text: `$ ${command}\n${renderOut(out) || "(no output yet)"}\n[still running after ${secs}s — ${who} to the background as ${id} ` +
              `instead of being killed. Poll it with Bash(poll:"${id}"), stop it with Bash(kill:"${id}").]`,
          }],
        });
        return true;
      };
      if (fgKey) foreground.set(fgKey, () => moveToBackground("user"));

      // R14（K37）：运行中的实时尾行——每秒看一次，输出有变化才推（跑满 10 秒时也推一次，界面据此亮「转后台」）；先脱敏。
      let lastTail: string | null = null;
      let longRun = false;
      const ticker =
        ctx.emit && ctx.callId
          ? setInterval(() => {
              const tail = liveTail(out);
              const elapsedMs = Date.now() - startedAt;
              const crossed = !longRun && elapsedMs >= LONG_RUN_MS;
              if (tail === lastTail && !crossed) return;
              lastTail = tail;
              if (crossed) longRun = true;
              ctx.emit!({ e: "tool_progress", id: ctx.callId!, tail, elapsedMs, canBackground: Boolean(fgKey) });
            }, 1_000)
          : undefined;
      const stopTicker = () => {
        if (ticker) clearInterval(ticker);
      };

      // R13：落盘文件写完关上之后再出结果（模型下一步就可能去 Read 它）
      const settleRun = async (code: number | null) => {
        settled = true;
        if (fgKey) foreground.delete(fgKey);
        if (timer) clearTimeout(timer);
        stopTicker();
        ctx.signal?.removeEventListener("abort", abort);
        if (moved) {
          // 已经转了后台：这次调用早就交回了，这里只给 job 收尾
          if (bgTimer) clearTimeout(bgTimer);
          await closeSpill(out);
          moved.done = true;
          moved.exitCode = code;
          moved.endedAt ??= Date.now();
          wakeWaiters(moved);
          return;
        }
        await closeSpill(out);
        let body = renderOut(out);
        if (timedOut) {
          body +=
            `\n…[killed after ${timeout}ms timeout]` +
            (timeout >= ctx.limits.bashMaxTimeoutMs
              ? " — for longer commands, re-run with background:true and poll for output"
              : "");
        }
        if (aborted) body += "\n…[已中止 — 进程树已 kill]";
        const status = timedOut ? "timeout" : aborted ? "aborted" : `exit ${code}`;
        const header = `$ ${command}\n`;
        // U8（K36）：工具行第二行只说结果
        const outLines = body.split("\n").filter((l) => l.trim()).length;
        const outcome = timedOut
          ? `超时（${Math.round(timeout / 1000)} 秒）被停下`
          : aborted
            ? "被中止"
            : `退出码 ${code}${outLines ? ` · ${outLines} 行输出` : " · 没有输出"}`;
        resolve({
          ok: !timedOut && !aborted && code === 0,
          summary: `bash: ${command.slice(0, 60)}${command.length > 60 ? "…" : ""} (${status})`,
          outcome,
          content: [{ t: "text", text: header + (body || "(no output)") + `\n[${status}]` }],
          ...(args.verify === true
            ? { verification: verifyOutcome(command, status, !timedOut && !aborted && code === 0, body) }
            : {}),
        });
      };
      const finished = whenFinished(child, [stdoutPump, stderrPump], (code) => void settleRun(code));

      timer = setTimeout(() => {
        if (moveToBackground("timeout")) return;
        timedOut = true;
        killTree(child);
        finished.markKilled();
      }, timeout);

      ctx.signal?.addEventListener("abort", abort, { once: true });

      child.on("error", (e) => {
        settled = true;
        if (fgKey) foreground.delete(fgKey);
        if (timer) clearTimeout(timer);
        stopTicker();
        ctx.signal?.removeEventListener("abort", abort);
        resolve(fail("spawn failed", `Failed to run command: ${e.message}`));
      });
    });
  },
};
