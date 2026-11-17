// 命令闸：危险命令名单、宿主自保、工作区围栏与凭据判定、工作区外只读放行。
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { insideReadOnlyRoot, pathAliasViolation, protectedStateViolation, readRootFor, readVerdict, realOrNearest, type SandboxAccess } from "../../sandbox.ts";
import { grantedSkillDirs, managedExtensionRoots } from "../../extensions.ts";
import { desktopHostPorts } from "../../desktop-host.ts";
import { parseShell, type ShellDialect } from "../shell-words.ts";
import { accessLock, deniedRootLiteral, tenantMode } from "../../tenant.ts";
import { assessCommand, READ_ONLY_VERBS } from "../shell-policy.ts";
import { sanctionedToolDirs, shell, type ShellInfo } from "./env.ts";

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
// 目标全是字面 PID 的一段 kill（`taskkill /PID 123 /T /F`、`kill -9 123 456`、`Stop-Process -Id 123 -Force`）：杀谁一眼可见
const LITERAL_PID_KILL_RE = new RegExp(
  "^(?:" +
    String.raw`taskkill(?:\.exe)?(?=[^|]*[/-]pid\s+\d)(?:\s+[/-](?:pid\s+\d+|t|f))+` + "|" +
    String.raw`kill(?:\s+-(?:\d+|[A-Z]+|s\s+[A-Z]+))?(?:\s+\d+)+` + "|" +
    // 没写 -Id 的 Stop-Process 是从管道接目标的
    String.raw`(?:Stop-Process|spps)(?=[^|]*-Id\s+\d)(?:\s+-(?:Id\s+\d+(?:\s*,\s*\d+)*|Force))+` +
  ")\\s*$",
  "i",
);

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
  // 只看 kill 段本身，还是看整句：kill 段的目标都是写死的 PID 字面量时，别的段里提到宿主端口 / 数字（`curl …:8787` 探活、
  // `sleep 2`）跟杀谁无关——2026-10-09 `taskkill //PID 93052 //T //F; …; curl http://127.0.0.1:8787/` 被整句拒了。
  // 目标是算出来的（$(lsof …)、$P、%a、xargs、管道喂进来的 Stop-Process）就仍按整句判：端口号可能就是在别的段里换成 PID 的。
  const segments = host.split(" | ");
  const killSegments = segments.filter((segment) => KILL_VERB_RE.test(segment));
  const scope = killSegments.every((segment) => LITERAL_PID_KILL_RE.test(segment)) ? killSegments.join(" | ") : host;
  const pids = hostPids();
  for (const m of scope.matchAll(/(?<![\w.:-])(\d{2,7})(?![\w.:])/g)) {
    if (pids.has(Number(m[1]))) return `PID ${m[1]} is the bridge server or dimensio itself.` + way;
  }
  for (const port of hostPorts()) {
    if (new RegExp(`(?<![\\w.])${port}(?![\\w.])`).test(scope)) {
      return `port ${port} belongs to the bridge server / dimensio / the desktop shell.` + way;
    }
  }
  return null;
}

// Bash 与 Preview(start) 共用的命令闸（S5、#67）：危险命令名单 → 宿主自保 → 工作区围栏与凭据判定。
// 以前 Preview 的 start 命令一道都不过，是绕开全部 Bash 策略的旁路。
// 管理员 bypass 档（access="bypass"，非租户）：跳过安全命令黑名单、凭据扫描、工作区围栏；但仍保留
// 两道底线——宿主自保（不许杀在跑的 bridge / dimensio 进程与端口）与 dimensio 自身会话库写保护，
// 以及租户禁区（bypass 是管理员专用档，这里是额外兜底）。
export function commandPolicyViolation(command: string, root: string, access: SandboxAccess, readRoots: string[] = []): string | null {
  const bypass = access === "bypass" && !tenantMode();
  if (!bypass) {
    const denied = deniedCommand(command);
    if (denied) return `Command blocked by safety deny-list: ${denied}.`;
  }
  const hostKill = hostKillViolation(command);
  if (hostKill) return `Command blocked to protect the host: ${hostKill}`;
  // 租户模式的禁区字面兜底（引号拼接等抽不出候选路径的写法），见 tenant.ts。
  const deniedRoot = deniedRootLiteral(command, tenantMode() ? grantedSkillDirs() : []);
  if (deniedRoot) return `Command blocked by workspace policy: it references ${deniedRoot}, which belongs to the host or to another user.`;
  if (bypass) {
    // 完全 bypass：工作区围栏与凭据扫描全跳过，只保留 dimensio 自身状态（会话库 / 影子仓库）的写保护。
    const state = protectedStateCommandViolation(command, root);
    return state ? `Command blocked to protect dimensio's own state: ${state}` : null;
  }
  // 访问范围锁（租户恒 workspace）：调用方传进来的 access 被谁改成 full 都不算数。
  const scope = commandScopeViolation(command, root, accessLock() ?? (access as "workspace" | "full"), readRoots);
  if (scope) return `Command blocked by workspace policy: ${scope}.`;
  return null;
}

// P13（X18）：被拒只是因为纯读命令读了工作区外——返回放行哪几个目录（只读）这条命令就能过；不是这种情况（别的拒绝理由、
// 写、非纯读命令、整机模式）返回 null。放行后要真能过才算：逐个补上越界落点所在的目录再判一遍整套命令闸，最多 5 个。
export function outsideReadDirs(command: string, root: string, access: SandboxAccess, readRoots: string[] = []): string[] | null {
  // 租户模式不问（批准的人就是用户自己），越界直接拒；整机 / bypass 本就不拦越界，没有「放行只读目录」可谈。
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

// 存在性测试：`[ -e x ]` / `[[ -f x ]]` / `test -d x` / `Test-Path x`。命令能完整解析时才认；被认出的那几段从命令文本里
// 换成 `true`，凭据判定只看剩下的部分。`ls`、`stat` 不算（ls 一个凭据目录会列出私钥文件名，stat 的 -c 能拼出别的东西）。
const EXISTENCE_FLAGS = new Set(["-e", "-f", "-d", "-s", "-r", "-w", "-x", "-L", "-h", "-b", "-c", "-p", "-S"]);
function existenceTest(argv: string[]): boolean {
  const name = (argv[0] ?? "").toLowerCase();
  // Test-Path 只认 -Path / -LiteralPath / -PathType <Leaf|Container|Any> 这几个参数
  if (name === "test-path") {
    return argv.length >= 2 && argv.slice(1).every((a, i, rest) => !a.startsWith("-") ? true : /^-(?:Path|LiteralPath|PathType)$/i.test(a) && (!/^-PathType$/i.test(a) || /^(?:Leaf|Container|Any)$/i.test(rest[i + 1] ?? "")));
  }
  let args = argv.slice(1);
  if (name === "[") {
    if (args.at(-1) !== "]") return false;
    args = args.slice(0, -1);
  } else if (name === "[[") {
    if (args.at(-1) !== "]]") return false;
    args = args.slice(0, -1);
  } else if (name !== "test") return false;
  if (args[0] === "!") args = args.slice(1);
  return args.length === 2 && EXISTENCE_FLAGS.has(args[0]);
}

export function withoutExistenceTests(command: string): string {
  const parsed = parseShell(command, shellDialect());
  if (parsed.unanalyzable) return command;
  let out = command;
  for (const c of parsed.commands) {
    if (c.wrappers.length || c.dynamic || c.redirects.length || c.pipedIn || !existenceTest(c.argv)) continue;
    if (c.words.some((w) => w.dynamic && /[`]|\$\(/.test(w.text))) continue;
    const raw = c.raw.trim();
    // 同一段原文在命令里出现不止一次（比如还藏在别的命令的引号参数里）就不摘，免得摘错地方
    if (!raw || out.split(raw).length !== 2) continue;
    out = out.replace(raw, "true");
  }
  return out;
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
  // 只问「在不在」的存在性测试（`[ -e x ]`、`test -f x`、`Test-Path x`）只回一个真假、读不到内容：判凭据时把它们的操作数摘掉
  // （2026-10-09：核对打包目录里**没有** .env / devices.json 的检查被整句拒了）。其余部分照旧全判。
  const guarded = withoutExistenceTests(command);
  const normalized = command.replace(/\\/g, "/");
  // 凭据库的名字出现在命令行任何一个路径段上都拒。S4（#37③）：以前前导字符不含 `/`，
  // 只认词首——`cat ./.env`、`cat config/.env`、`cat ~/.ssh/id_rsa`、绝对路径全漏。
  if (/(^|[\s'"=;|&(/])(?:\.env(?:\.[^\s'";|&)/]+)?|\.ssh|\.aws|\.gnupg|\.azure|\.cloudflared|\.git-credentials|\.netrc|_netrc|\.npmrc|\.pypirc|\.?credentials\.json|id_rsa|id_ed25519|id_ecdsa|id_dsa)(?=$|[\s/'";|&)])/i.test(guarded.replace(/\\/g, "/"))) {
    return "command references a credential store blocked by the secret guard";
  }
  // Every resolvable path (absolute, git-bash /c/…, ~/…) goes through the SAME
  // verdict as Read/Grep/Browser (S4): credential names, the extension registry,
  // the bridge config, and — outside the workspace — key material (.pem/.key,
  // judged by LOCATION: inside the workspace those are the agent's own fixtures)
  // and per-user dot directories under the home folder. Both access modes.
  for (const candidate of filesystemPathCandidates(guarded)) {
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
  if (/(^|[\s'"=;|&(])(?:\$HOME\b|\$\{HOME\}|%USERPROFILE%|\$env:USERPROFILE\b|\$\{?REAL_(?:USERPROFILE|LOCALAPPDATA|APPDATA)\b|%REAL_(?:USERPROFILE|LOCALAPPDATA|APPDATA)%|\$env:REAL_)/i.test(normalized)) {
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
    // Machine-level tools (<harness>/tools, e.g. ifind) and Bridge extension
    // skills are sanctioned in every access mode; everything else outside the
    // workspace is blocked.
    // 成员实例对技能目录只读：全服技能是大家共用的，往里写等于改了所有人的（写落到下面按越界拒）。
    if (candidate && !(write && tenantMode()) && sanctionedToolDirs().some((dir) => inside(dir, candidate))) continue;
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
