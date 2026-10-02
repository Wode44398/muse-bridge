// P4：建在 shell-words 分词结果上的三条判定。
//   · 危险命令（K5，#15）：按命令位 + 剥包装器判，不再拿正则扫整串——参数里出现 reboot 不算，
//     `rm -fr /`、`rm -r -f ~`、`rm --recursive --force /` 不再漏；分析不了又带高危程序名的转问，不放行。
//   · 规则子命令（A5，#4）：给权限判定逐条子命令的原文——deny/ask 任一命中即生效，allow 须全部覆盖。
//   · 只读降级（C9）：纯读命令（git status、ls、grep …）在 plan / read-only 档也能跑。
//   · 不可恢复的操作（P12）：检查点兜不住的——auto 下也转问（见文件末尾）。
import {
  parseShell,
  SPLICED_AT_RUN_TIME,
  type ShellCommand,
  type ShellDialect,
  type ShellParse,
  type ShellRedirect,
  type ShellWord,
} from "./shell-words.ts";

// Verbs that only LOOK at the filesystem. The path guard cannot tell a read from
// a write inside a shell command, so a directory the user opened for READING is
// reachable only by a command whose every segment is one of these — the verb is
// the proof. sed/awk/python are deliberately absent: they write.
export const READ_ONLY_VERBS = new Set([
  "ls", "dir", "cat", "head", "tail", "wc", "stat", "file", "du", "df", "tree",
  "find", "grep", "egrep", "fgrep", "rg", "sort", "uniq", "cut", "diff", "cmp",
  "which", "whereis", "basename", "dirname", "realpath", "readlink",
  "echo", "printf", "pwd", "date", "test", "true", "false",
  "md5sum", "sha1sum", "sha256sum",
]);

// ── K5：危险命令 ─────────────────────────────────────────────────────────────

export interface CommandRisk {
  // 硬拒（任何模式、任何规则下都不跑）
  deny?: string;
  // 要人过目：分析不了又含高危程序名、递归删除的目标运行时才知道且可能落到根上
  ask?: string;
  // P12：检查点兜不住的操作（远端、全局环境、执行刚下载的内容……）——auto 下也要人过目，用户写的 allow 规则优先
  irreversible?: string;
  // P11（ZCode C1）：上面两种转问给人看的中文说明（英文那句是给模型的）
  why?: string;
}

// P11：一条转问原因的两种说法——en 回给模型（拒绝 / 没人批时它读到的），zh 写在权限卡上给人看
export interface Reason {
  en: string;
  zh: string;
}

const POWER = new Set(["shutdown", "reboot", "poweroff", "halt", "stop-computer", "restart-computer", "reset-computer"]);
const DISK = new Set(["diskpart", "mke2fs", "format-volume", "clear-disk", "initialize-disk", "remove-partition"]);
const PS_REMOVE_ALIASES = new Set(["rm", "rmdir", "rd", "del", "erase", "ri"]);
const FORK_BOMB = /:\(\)\s*\{\s*:\|:&\s*\}/;
// 分析不了的命令里出现这些程序名就转问（命令位判不了，只能退回到字面）
const DANGER_WORD =
  /(?:^|[\s;&|(){}`'"\\/])(rm|shutdown|reboot|poweroff|halt|mkfs(?:\.\w+)?|mke2fs|diskpart|format|reg|remove-item|rd|rmdir|del|erase|stop-computer|restart-computer|reset-computer|format-volume|clear-disk|initialize-disk|remove-partition)(?:\.exe)?(?=$|[\s;&|(){}`'"])/i;

export function assessCommand(command: string, dialect: ShellDialect = "bash"): CommandRisk {
  return assessParsed(parseShell(command, dialect), command);
}

export function assessParsed(parsed: ShellParse, command: string): CommandRisk {
  if (FORK_BOMB.test(command)) return { deny: "a fork bomb" };
  for (const c of parsed.commands) {
    const why = hostDanger(c);
    if (why) return { deny: why };
  }
  for (const c of parsed.commands) {
    const why = runtimeDanger(c);
    if (why) return { ask: why.en, why: why.zh };
  }
  if (parsed.unanalyzable) {
    const m = DANGER_WORD.exec(command);
    if (m) {
      return {
        ask: `the command could not be fully analyzed (${parsed.reason}) and it mentions \`${m[1]}\``,
        why: `这条命令没法完全解析，里面又出现了 ${m[1]} 这类高危程序`,
      };
    }
  }
  const irreversible = irreversibleReason(parsed, command);
  return irreversible ? { irreversible: irreversible.en, why: irreversible.zh } : {};
}

function hostDanger(c: ShellCommand): string | null {
  const n = c.name;
  const args = c.words.slice(1);
  if (POWER.has(n)) return `\`${n}\` shuts down or restarts this machine`;
  if (DISK.has(n) || /^mkfs(?:\.|$)/.test(n)) return `\`${n}\` formats or repartitions disks`;
  if (n === "format" && args.some((w) => /^[A-Za-z]:\\?$/.test(w.text))) return "`format` wipes a drive";
  if (n === "reg" && args[0]?.text.toLowerCase() === "delete") return "`reg delete` deletes Windows registry keys";
  const del = recursiveDelete(c);
  const hit = del?.targets.find(protectedTarget);
  if (del && hit) {
    return `\`${del.verb}\` on ${hit.text} — recursive deletes of an absolute path, a drive, the home directory or the registry are never run`;
  }
  return null;
}

function runtimeDanger(c: ShellCommand): Reason | null {
  const del = recursiveDelete(c);
  const hit = del?.targets.find((w) => w.dynamic && protectedPath(skeleton(w.text)));
  if (del && hit) {
    return {
      en: `\`${del.verb}\` on ${hit.text}, whose value is only known at run time — if it is empty, this deletes from the root`,
      zh: `递归删除的目标（${hit.text}）要到运行时才知道——它要是空的，就会从根目录删起`,
    };
  }
  return null;
}

// 递归删除：rm -r（任何写法）、rd/rmdir/del/erase /s、Remove-Item -Recurse（含 PowerShell 里的 rm/del/rd 别名）
function recursiveDelete(c: ShellCommand): { verb: string; targets: ShellWord[] } | null {
  const n = c.name;
  const args = c.words.slice(1);
  if (n === "remove-item" || (c.dialect === "powershell" && PS_REMOVE_ALIASES.has(n))) return psRemoveItem(args);
  if (n === "rm") {
    let recursive = false;
    let options = true;
    const targets: ShellWord[] = [];
    for (const w of args) {
      const t = w.text;
      if (options && !w.leadQuoted) {
        if (t === "--") {
          options = false;
          continue;
        }
        if (t.startsWith("--")) {
          if (t === "--recursive") recursive = true;
          continue;
        }
        if (/^-[A-Za-z]+$/.test(t)) {
          if (/[rR]/.test(t)) recursive = true;
          continue;
        }
      }
      targets.push(w);
    }
    return recursive ? { verb: "rm -r", targets } : null;
  }
  if (n === "rd" || n === "rmdir" || n === "del" || n === "erase") {
    const isSwitch = (w: ShellWord) => /^\/[A-Za-z](?::\S*)?$/.test(w.text);
    if (!args.some((w) => /^\/s$/i.test(w.text))) return null;
    return { verb: `${n} /s`, targets: args.filter((w) => !isSwitch(w)) };
  }
  return null;
}

const PS_PATH_PARAMS = ["path", "literalpath", "pspath", "lp"];
const PS_VALUE_PARAMS = [
  "filter", "include", "exclude", "credential", "stream", "erroraction", "warningaction", "informationaction",
  "errorvariable", "warningvariable", "informationvariable", "outvariable", "outbuffer", "pipelinevariable",
];
const PS_VALUE_ALIASES = new Set(["ea", "wa", "infa", "ev", "wv", "iv", "ov", "ob", "pv"]);

function psRemoveItem(args: ShellWord[]): { verb: string; targets: ShellWord[] } | null {
  let recursive = false;
  const targets: ShellWord[] = [];
  const addTargets = (w: ShellWord) => targets.push(...w.text.split(",").filter(Boolean).map((text) => ({ ...w, text })));
  for (let k = 0; k < args.length; k++) {
    const w = args[k];
    const m = w.leadQuoted ? null : /^-([A-Za-z]+)(?::(.*))?$/.exec(w.text);
    if (!m) {
      addTargets(w);
      continue;
    }
    const p = m[1].toLowerCase();
    const attached = m[2];
    if ("recurse".startsWith(p)) {
      recursive = !/^\$?false$/i.test(attached ?? "");
    } else if (PS_PATH_PARAMS.some((o) => o === p || (p.length >= 2 && o.startsWith(p)))) {
      if (attached !== undefined) addTargets({ ...w, text: attached });
      else if (args[k + 1]) addTargets(args[++k]);
    } else if (PS_VALUE_ALIASES.has(p) || (p.length >= 2 && PS_VALUE_PARAMS.some((o) => o.startsWith(p)))) {
      if (attached === undefined) k++;
    }
  }
  return recursive ? { verb: "Remove-Item -Recurse", targets } : null;
}

// 家目录与系统目录变量（只在它们真的是展开时才算：'$HOME' 单引号里是字面值）
const HOME_VARS =
  /^(?:\$\{?HOME\}?|\$env:(?:USERPROFILE|HOMEPATH|HOMEDRIVE|SystemRoot|windir|SystemDrive|ProgramFiles|ProgramData|APPDATA|LOCALAPPDATA)|%(?:USERPROFILE|HOMEPATH|HOMEDRIVE|SystemRoot|windir|SystemDrive|ProgramFiles|ProgramData|APPDATA|LOCALAPPDATA)%)(?![\w])/i;

// 递归删除绝不落在这些目标上：绝对路径（POSIX、git-bash 的 /c/…、盘符）、家目录、注册表。
// 与旧正则同一条线（旧的 `rm -rf? (~|/|$HOME)` 也拒所有绝对路径），只是不再挑旗标写法、引号与参数顺序。
function protectedTarget(w: ShellWord): boolean {
  if (w.text.startsWith("~") && !w.leadQuoted) return true;
  if (w.dynamic && HOME_VARS.test(w.text)) return true;
  return protectedPath(w.text);
}

function protectedPath(t: string): boolean {
  return (
    /^\/(?!\/)/.test(t) ||
    /^[A-Za-z]:(?:[\\/]|$)/.test(t) ||
    /^(?:HKLM|HKCU|HKCR|HKU|HKCC|HKEY_\w+)(?::|\\|$)|^Registry::/i.test(t)
  );
}

// 抹掉运行时才知道的部分：`$DIR/*` → `/*`（变量为空时真正删的东西）
function skeleton(t: string): string {
  return t.replace(/\$\{[^}]*\}|\$\(\(…\)\)|\$\(…\)|\$[A-Za-z_]\w*(?::[A-Za-z_]\w*)?|\$[0-9@*#?$!-]|%[^%\s]+%/g, "");
}

// ── 重定向 ──────────────────────────────────────────────────────────────────

// 真把输出写进文件的重定向（2>&1、>/dev/null、2>nul 不算）
export function writesFile(r: ShellRedirect): boolean {
  if (!r.op.includes(">")) return false;
  if (r.op.endsWith("&") && /^(?:\d+|-)$/.test(r.target)) return false;
  return !/^(?:\/dev\/null|nul|\$null)$/i.test(r.target);
}

// ── A5：规则子命令 ──────────────────────────────────────────────────────────

export interface RuleSubject {
  // 子命令所在段的原文：allow 规则只按它匹配（`sudo git push` 不被 `git push:*` 覆盖）
  text: string;
  // 剥掉包装器后的 argv：deny/ask 规则也按它匹配（`sudo git push` 照样撞上 deny `git push:*`）
  alt: string;
  // 带运行时的值、写文件的重定向或提权包装器：allow 只认与原文一字不差的规则
  exactOnly: boolean;
}

const PRIVILEGED = new Set(["sudo", "doas", "su"]);
const privileged = (c: ShellCommand) => c.wrappers.some((w) => PRIVILEGED.has(w.split(" ")[0]));

export function ruleSubjects(parsed: ShellParse): RuleSubject[] {
  return parsed.commands.map((c) => ({
    text: c.raw,
    alt: c.argv.join(" "),
    exactOnly: c.dynamic || c.redirects.some(writesFile) || privileged(c),
  }));
}

// ── P5：「按前缀记住」的候选（A6、X25）────────────────────────────────────────

// 永远只给字面规则的根命令：删改权限与磁盘、提权、包装器与 shell 入口、杀进程、改注册表
const HIGH_RISK_ROOTS = new Set([
  "rm", "rmdir", "rd", "del", "erase", "remove-item", "ri", "chmod", "chown", "chgrp", "icacls", "takeown",
  "dd", "mkfs", "mke2fs", "mount", "umount", "diskpart", "format", "reg", "setx",
  "sudo", "doas", "su", "runas", "env", "eval", "exec", "xargs", "nohup", "timeout", "watch", "command", "builtin", "busybox",
  "bash", "sh", "zsh", "dash", "ksh", "ash", "mksh", "fish", "cmd", "powershell", "pwsh", "wsl",
  "kill", "taskkill", "tskill", "pkill", "killall", "stop-process", "shutdown", "reboot", "poweroff", "halt",
]);
// Codex 的禁用前缀表（解释器入口 + 过宽前缀），按「程序名 + 参数」比对；上面的根命令已经整个挡掉的不再重复
const BANNED_PREFIXES = new Set([
  "git", "npm run", "pnpm run", "yarn run", "bun", "bun run", "bun -e", "deno", "deno eval", "deno run",
  "node", "node -e", "nodejs", "python", "python -c", "python -", "python3", "python3 -c", "python3 -", "py", "py -3",
  "pythonw", "pyw", "pypy", "pypy3", "perl", "perl -e", "ruby", "ruby -e", "php", "php -r", "lua", "lua -e",
  "julia", "julia -e", "rscript", "osascript", "npx", "pnpm dlx", "yarn dlx", "uvx",
]);
// 取几段才算「稳定」：跑脚本要带上脚本名，多层 CLI 要带上动作
const PREFIX_DEPTH: Record<string, Record<string, number>> = {
  npm: { run: 2, "run-script": 2, exec: 2 },
  pnpm: { run: 2, exec: 2 },
  yarn: { run: 2 },
  bun: { run: 2 },
  deno: { task: 2 },
  docker: { compose: 2 },
  kubectl: { config: 2 },
  adb: { shell: 2 },
  gh: { "*": 2 },
  aws: { "*": 2 },
  az: { "*": 2 },
  gcloud: { "*": 3 },
};
const PYTHONS = new Set(["python", "python3", "py", "pypy", "pypy3"]);
const SUBCOMMAND = /^[A-Za-z0-9][\w.:@+-]*$/;
export const MAX_PREFIX_RULES = 5;

// 每条子命令一个「程序名 + 子命令」前缀（`npm run lint:*`、`git commit:*`；纯读动词单独一个 `ls:*`）。
// 任一条给不出稳定前缀（高危根命令、带包装器或赋值、动态值、写文件的重定向、选项在子命令前面……）就整组不给，
// 只剩字面规则可选。
export function stablePrefixes(parsed: ShellParse): string[] | null {
  if (parsed.unanalyzable || !parsed.commands.length) return null;
  const out: string[] = [];
  for (const c of parsed.commands) {
    const p = stablePrefix(c);
    if (!p) return null;
    if (!out.includes(p)) out.push(p);
  }
  return out.length <= MAX_PREFIX_RULES ? out : null;
}

function stablePrefix(c: ShellCommand): string | null {
  const n = c.name;
  const argv = c.argv;
  if (!n || c.dynamic || c.wrappers.length || c.redirects.some(writesFile)) return null;
  if (HIGH_RISK_ROOTS.has(n) || /^mkfs(?:\.|$)/.test(n) || /[*?\s]/.test(argv[0])) return null;
  if (!c.raw.startsWith(argv[0])) return null; // 前面有赋值等——规则按子命令原文匹配，前缀对不上
  const rest = argv.slice(1);
  let words: string[];
  if ((READ_ONLY_VERBS.has(n) && !UNSAFE_ARGS[n]) || NAVIGATION.has(n)) {
    words = []; // 纯读动词：`ls:*`
  } else if (PYTHONS.has(n) && rest[0] === "-m" && rest[1] && SUBCOMMAND.test(rest[1])) {
    words = ["-m", rest[1]]; // python -m pytest
  } else {
    if (!rest[0] || !SUBCOMMAND.test(rest[0])) return null; // 没有子命令，或选项在子命令前面
    const depth = PREFIX_DEPTH[n]?.[rest[0]] ?? PREFIX_DEPTH[n]?.["*"] ?? 1;
    words = rest.slice(0, depth);
    if (words.length < depth || !words.every((w) => SUBCOMMAND.test(w))) return null;
  }
  const key = [n, ...words].join(" ").toLowerCase();
  if (BANNED_PREFIXES.has(key)) return null;
  return `${[argv[0], ...words].join(" ")}:*`;
}

// ── P6：Bash 的写目标（X17：拒绝与路径规则按资源绑定）──────────────────────────
// Edit(src/**) 这类路径规则、以及本 run 里被拒绝过的路径，同样要管住 Bash 往那里写：重定向目标，和常见写动词的
// 目标参数。解释器与构建工具（python、npm、make……）写了什么看不出来，不算——它们由「本 run 拒绝台账」按命令里
// 提到的路径兜底（见 permissions.ts）。

// 每个位置参数都是写目标
const WRITE_ALL = new Set([
  "rm", "rmdir", "unlink", "shred", "touch", "mkdir", "tee", "truncate", "mv",
  "del", "erase", "rd", "move", "ren", "rename",
  "remove-item", "ri", "new-item", "ni", "set-content", "sc", "add-content", "ac", "out-file", "clear-content", "clc",
  "move-item", "mi", "rename-item", "rni",
]);
// 最后一个位置参数是写目标（cp a b dir/）
const WRITE_LAST = new Set(["cp", "install", "ln", "copy", "xcopy", "robocopy", "copy-item", "cpi"]);
// 第一个位置参数是模式 / 属主，其余是写目标
const WRITE_AFTER_FIRST = new Set(["chmod", "chown", "chgrp"]);
const CMD_STYLE = new Set(["del", "erase", "rd", "rmdir", "move", "ren", "rename", "copy", "xcopy", "robocopy"]);
const PS_STYLE = new Set([
  "remove-item", "ri", "new-item", "ni", "set-content", "sc", "add-content", "ac", "out-file", "clear-content", "clc",
  "move-item", "mi", "rename-item", "rni", "copy-item", "cpi",
]);
const PS_PATH_OPT = /^-(?:path|literalpath|lp|pspath|filepath|destination|newname)$/i;
const PS_SWITCH = /^-(?:force|recurse|whatif|confirm|append|nonewline|passthru|noclobber|verbose|debug|asbytestream|container)$/i;

function positionals(args: ShellWord[], name: string): string[] {
  const out: string[] = [];
  let options = true;
  for (let k = 0; k < args.length; k++) {
    const t = args[k].text;
    if (options && t === "--") {
      options = false;
      continue;
    }
    if (options && PS_STYLE.has(name) && /^-[A-Za-z]+$/.test(t)) {
      if (PS_PATH_OPT.test(t) && args[k + 1]) out.push(...args[++k].text.split(",").filter(Boolean));
      else if (!PS_SWITCH.test(t) && args[k + 1] && !args[k + 1].text.startsWith("-")) k++; // -Value x 之类：跳过值
      continue;
    }
    if (options && t.startsWith("-") && t !== "-") continue;
    if (CMD_STYLE.has(name) && /^\/[A-Za-z?](?::\S*)?$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

function writeTargetsOf(c: ShellCommand): string[] {
  const out = c.redirects.filter(writesFile).map((r) => r.target);
  const n = c.name;
  const args = c.words.slice(1);
  if (WRITE_ALL.has(n)) {
    out.push(...positionals(args, n));
  } else if (WRITE_LAST.has(n)) {
    const dir = args.findIndex((w) => w.text === "-t" || w.text === "--target-directory");
    const eq = args.find((w) => w.text.startsWith("--target-directory="));
    const pos = positionals(args, n);
    const target = dir >= 0 ? args[dir + 1]?.text : eq ? eq.text.slice("--target-directory=".length) : pos[pos.length - 1];
    if (target && (pos.length > 1 || dir >= 0 || eq)) out.push(target);
  } else if (WRITE_AFTER_FIRST.has(n)) {
    out.push(...positionals(args, n).slice(1));
  } else if ((n === "sed" || n === "perl") && args.some((w) => /^-[A-Za-z]*i/.test(w.text) || w.text.startsWith("--in-place"))) {
    // sed -i 's/a/b/' 文件…、perl -pi -e '…' 文件…：去掉脚本本身（-e 后面那个词；sed 没有 -e/-f 时是第一个位置参数）
    const scripts = new Set<number>();
    args.forEach((w, k) => {
      if (/^-[A-Za-z]*[ef]$/.test(w.text) || w.text === "--expression" || w.text === "--file") scripts.add(k + 1);
    });
    const files: string[] = [];
    let first = n === "sed" && scripts.size === 0;
    args.forEach((w, k) => {
      if (scripts.has(k) || w.text.startsWith("-")) return;
      if (first) {
        first = false;
        return;
      }
      files.push(w.text);
    });
    out.push(...files);
  } else if (n === "dd") {
    for (const w of args) {
      const m = /^of=(.+)$/.exec(w.text);
      if (m) out.push(m[1]);
    }
  } else if (n === "git") {
    const pos = positionals(args, n);
    if (pos[0] === "rm" || pos[0] === "mv" || pos[0] === "restore") out.push(...pos.slice(1));
    if (pos[0] === "checkout") {
      const dd = args.findIndex((w) => w.text === "--");
      if (dd >= 0) out.push(...args.slice(dd + 1).map((w) => w.text));
    }
  }
  return out.filter((t) => t && !/^(?:\/dev\/null|nul|\$null)$/i.test(t));
}

export interface ShellTouches {
  // 明确的写目标（原文）：路径规则与拒绝台账都按它判
  writes: string[];
  // V5：其中内容被改写 / 新建的（删除、git rm 不算）——验证门禁把它们记成「改过的文件」
  edits: string[];
  // 非只读子命令提到的所有词：拒绝台账兜底用（python -c "open('src/a.ts','w')" 这种看不出写不写的）
  mentions: string[];
}

// 只删不写的动词：它们的目标不算「改过的文件」（mv 的源头也不算，只算落点）
const DELETE_ONLY = new Set(["rm", "rmdir", "unlink", "shred", "del", "erase", "rd", "remove-item", "ri", "clear-content", "clc"]);

function editTargetsOf(c: ShellCommand, writes: string[]): string[] {
  const n = c.name;
  if (DELETE_ONLY.has(n)) return c.redirects.filter(writesFile).map((r) => r.target);
  if (n === "git") {
    const pos = positionals(c.words.slice(1), n);
    if (pos[0] === "rm") return c.redirects.filter(writesFile).map((r) => r.target);
    if (pos[0] === "mv") return [...c.redirects.filter(writesFile).map((r) => r.target), ...pos.slice(-1)];
  }
  if (n === "mv" || n === "move" || n === "move-item" || n === "mi" || n === "ren" || n === "rename" || n === "rename-item" || n === "rni") {
    const pos = positionals(c.words.slice(1), n);
    return [...c.redirects.filter(writesFile).map((r) => r.target), ...pos.slice(-1)];
  }
  return writes;
}

export function shellTouches(parsed: ShellParse): ShellTouches {
  const writes: string[] = [];
  const edits: string[] = [];
  const mentions: string[] = [];
  const moves = parsed.commands.some((c) => c.name === "cd" || c.name === "pushd");
  for (const c of parsed.commands) {
    const w = writeTargetsOf(c);
    writes.push(...w);
    // 门禁只记落点确定的：`cp a "$OUT/x.html"` 这类要到运行时才知道写去哪，按字面解析会记成工作区里的
    // `$OUT/x.html`，让已经验过的一轮被判成「验证后又改了」（2026-09-30 MiMo 会话）。真写进工作区的由影子 git 兜住。
    const unknown = new Set([
      ...c.words.filter((x) => x.dynamic).map((x) => x.text),
      ...c.redirects.filter((r) => r.dynamic).map((r) => r.target),
    ]);
    edits.push(...editTargetsOf(c, w).filter((t) => !unknown.has(t)));
    if (!readOnlyOne(c, moves)) mentions.push(...c.argv.slice(1), ...c.redirects.map((r) => r.target));
  }
  return { writes: [...new Set(writes)], edits: [...new Set(edits)], mentions: [...new Set(mentions)] };
}

// ── C9：只读降级 ────────────────────────────────────────────────────────────

// 这些动词带了下列参数就会写文件或执行别的程序；参数里有运行时才知道的值（可能注入这些旗标）也不算只读
const UNSAFE_ARGS: Record<string, (args: string[]) => boolean> = {
  find: (a) => a.some((x) => /^-(?:delete|exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/.test(x)),
  sort: (a) => a.some((x) => /^-[A-Za-z]*o|^--output\b|^--compress-program\b/.test(x)),
  uniq: (a) => a.filter((x) => !x.startsWith("-")).length > 1, // uniq in out：第二个位置参数是输出文件
  tree: (a) => a.some((x) => /^-o/.test(x)),
  date: (a) => a.some((x) => /^-[A-Za-z]*s|^--set\b/.test(x)),
  rg: (a) => a.some((x) => /^--pre(?:=|$)/.test(x)),
  file: (a) => a.some((x) => /^-[A-Za-z]*C|^--compile\b/.test(x)),
};
// 只改 shell 自己的状态（每次调用都是新 shell）
const NAVIGATION = new Set(["cd", "pushd", "popd", "[", "[["]);

const GIT_READ = new Set([
  "status", "log", "show", "diff", "rev-parse", "ls-files", "ls-tree", "ls-remote", "blame", "annotate",
  "describe", "shortlog", "grep", "cat-file", "merge-base", "name-rev", "count-objects", "for-each-ref",
  "show-ref", "check-ignore", "check-attr", "check-ref-format", "whatchanged", "rev-list", "diff-tree",
  "diff-files", "diff-index", "var", "version", "cherry", "range-diff", "show-branch", "verify-commit", "verify-tag",
]);
// 会写文件或拉起别的程序的 git 参数：--output、grep -O（用分页器打开）、外部 diff、--upload-pack/--exec
const GIT_UNSAFE_ARG = /^(?:--output(?:=|$)|--open-files-in-pager|-O|--ext-diff$|--upload-pack|--receive-pack|--exec(?:=|$))/;
// 只改输出、不换仓库的全局选项；-C / --git-dir / -c / --exec-path 一律不算只读
const GIT_SAFE_GLOBAL =
  /^(?:--no-pager|-P|--no-optional-locks|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-replace-objects)$/;

export function readOnlyCommand(parsed: ShellParse): boolean {
  if (parsed.unanalyzable || !parsed.commands.length) return false;
  // ZCode 的安全阀：cd 进别的仓库再跑 git，会读那个仓库的配置（fsmonitor、textconv、外部 diff 都能执行程序）
  const moves = parsed.commands.some((c) => c.name === "cd" || c.name === "pushd");
  return parsed.commands.every((c) => readOnlyOne(c, moves));
}

function readOnlyOne(c: ShellCommand, moves: boolean): boolean {
  if (!c.name || c.redirects.some(writesFile) || privileged(c)) return false;
  if (c.name === "git") return gitReadOnly(c, moves);
  if (NAVIGATION.has(c.name)) return true;
  if (!READ_ONLY_VERBS.has(c.name)) return false;
  const unsafe = UNSAFE_ARGS[c.name];
  return !unsafe || (!c.dynamic && !unsafe(c.argv.slice(1)));
}

function gitReadOnly(c: ShellCommand, moves: boolean): boolean {
  if (moves || c.dynamic) return false;
  const a = c.argv.slice(1);
  let k = 0;
  while (k < a.length && a[k].startsWith("-")) {
    if (a[k] === "--version") return true;
    if (!GIT_SAFE_GLOBAL.test(a[k])) return false;
    k++;
  }
  const sub = a[k];
  const rest = a.slice(k + 1);
  if (!sub || rest.some((x) => GIT_UNSAFE_ARG.test(x))) return false;
  if (GIT_READ.has(sub)) return true;
  const flagsOnly = rest.every((x) => x.startsWith("-"));
  const listing = rest.includes("-l") || rest.includes("--list");
  // 短选项可以捆在一起（-vD = -v -D），逐个字母看
  const short = (x: string, letters: string) => /^-[A-Za-z]+$/.test(x) && [...x.slice(1)].some((ch) => letters.includes(ch));
  switch (sub) {
    case "branch":
      return (flagsOnly || listing) &&
        !rest.some((x) => short(x, "dDmMcCfut") || /^--(?:delete|move|copy|force|track|no-track|set-upstream|unset-upstream|edit-description|create-reflog)/.test(x));
    case "tag":
      return (flagsOnly || listing) &&
        !rest.some((x) => short(x, "dasufmFe") || /^--(?:delete|annotate|sign|local-user|force|message|file|edit|create-reflog)/.test(x));
    case "remote":
      return rest.length === 0 || (rest.length === 1 && /^(?:-v|--verbose)$/.test(rest[0])) || rest[0] === "show" || rest[0] === "get-url";
    case "stash":
    case "notes":
      return rest[0] === "list" || rest[0] === "show";
    case "config":
      return rest.some((x) => /^(?:--get|--get-all|--get-regexp|--get-urlmatch|--list|-l)$/.test(x)) &&
        !rest.some((x) => /^(?:--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|--edit|-e)$/.test(x));
    case "worktree":
      return rest[0] === "list";
    case "submodule":
      return rest.length === 0 || rest[0] === "status";
    case "reflog":
      return rest.length === 0 || rest[0] === "show" || rest[0].startsWith("-");
    default:
      return false;
  }
}

// ── N26（HT3）：删文件、丢弃 git 工作区改动的命令 ─────────────────────────────────
// 执行前值得给工作区拍一张快照：这一轮前面几十次编辑，一条 `git checkout -- .`、`git reset --hard`、`rm -rf src`
// 就再也找不回来（唯一能退的点在这一轮开始之前）。宁多勿漏——多判一次只是多一次暂存，没有新内容就不记快照。

export interface DestructiveView {
  destroys: boolean;
  onlyDestroys: boolean;
}

// 分析不了的命令退回到字面
const DESTROY_WORD =
  /(?:^|[\s;&|(){}`'"\\/])(?:rm|rmdir|unlink|shred|del|erase|rd|remove-item|ri|clear-content|clc)(?:\.exe)?(?=$|[\s;&|(){}`'"])|\bgit\b[^\n;&|]*\s(?:reset\s[^\n;&|]*--hard|checkout|restore|clean|stash|rm)\b|\s-delete\b/i;

export function destructiveView(parsed: ShellParse, command: string): DestructiveView {
  if (parsed.unanalyzable) return { destroys: DESTROY_WORD.test(command), onlyDestroys: false };
  const moves = parsed.commands.some((c) => c.name === "cd" || c.name === "pushd");
  let destroys = false;
  let others = false;
  for (const c of parsed.commands) {
    if (destroysFiles(c)) destroys = true;
    else if (!readOnlyOne(c, moves)) others = true;
  }
  return { destroys, onlyDestroys: destroys && !others };
}

function destroysFiles(c: ShellCommand): boolean {
  const n = c.name;
  if (DELETE_ONLY.has(n)) return true;
  const a = c.argv.slice(1);
  if (n === "find") {
    const k = a.findIndex((x) => /^-(?:exec|execdir|ok|okdir)$/.test(x));
    return a.includes("-delete") || (k >= 0 && DELETE_ONLY.has((a[k + 1] ?? "").toLowerCase()));
  }
  if (n !== "git") return false;
  let k = 0;
  while (k < a.length && a[k].startsWith("-")) k += a[k] === "-C" || a[k] === "-c" ? 2 : 1; // 全局选项（-C 路径、-c 键=值）
  const sub = a[k];
  const rest = a.slice(k + 1);
  const has = (...opts: string[]) => rest.some((x) => opts.includes(x));
  const short = (letters: string) => rest.some((x) => /^-[A-Za-z]+$/.test(x) && [...x.slice(1)].some((ch) => letters.includes(ch)));
  switch (sub) {
    case "reset":
      return has("--hard");
    case "checkout": {
      if (has("--", "-f", "--force", "-p", "--patch")) return true;
      if (short("bB") || has("--orphan")) return false; // 新建分支：改动跟着走
      const pos = rest.filter((x) => !x.startsWith("-"));
      // 只切分支（一个像分支名的参数）不丢改动；带路径的（`.`、目录、多个参数）是在用 HEAD 覆盖工作区
      return pos.length !== 1 || /^\.|[\\/*?]|\.\w+$/.test(pos[0]);
    }
    case "switch":
      return has("-f", "--force", "--discard-changes");
    case "restore":
      return !(has("--staged", "-S") && !has("--worktree", "-W"));
    case "clean":
      return (short("f") || has("--force")) && !(short("n") || has("--dry-run"));
    case "stash":
      return rest[0] === undefined || rest[0].startsWith("-") || rest[0] === "push" || rest[0] === "save";
    case "rm":
      return !has("--cached");
    default:
      return false;
  }
}

// ── P12（N25，hermes HT6）：检查点兜不住的操作 ───────────────────────────────────
// 危险命令分三档：hardline 硬拒（上面的 hostDanger）；可恢复的——工作区里的删改、丢弃 git 改动——auto 下放行，由 N26
// 的执行前快照兜底；不可恢复的——落在远端（强推、发布）、落在工作区外的全局环境（全局装卸包、持久环境变量、注册表、
// 全局 git 配置）、执行刚下载下来的内容、碰云元数据端点、把命令发给远程 Docker——auto 下也要问（用户自己写的 allow
// 规则仍优先；没人在场 / 离开模式按「没被批准」处理）。改 shell 启动文件按路径判，在 permissions.ts。
// 清单宁少勿多：真实使用的 24 个会话 1159 条命令里一条也没出现过，它只是兜底；但不能误伤日常命令——那里面有 17 条
// `curl … | python -c "…"`，是在解析下载下来的数据，不是执行它。

export function irreversibleCommand(parsed: ShellParse, command: string): string | null {
  return irreversibleReason(parsed, command)?.en ?? null;
}

// 云元数据端点的两种说法（Bash 与 WebFetch / Browser 共用）
export const IMDS_REASON: Reason = {
  en: "it reaches the cloud instance metadata endpoint, which hands out this machine's cloud credentials",
  zh: "访问云主机的元数据端点——在云上，它直接发这台机器的云凭证",
};

function irreversibleReason(parsed: ShellParse, command: string): Reason | null {
  if (downloadExec(parsed, command)) {
    return {
      en: "it runs content downloaded from the network directly, without saving it for review first",
      zh: "把刚从网上下载的内容直接交给 shell / 解释器执行，没先存下来给人看一眼",
    };
  }
  for (const c of parsed.commands) {
    const why = forcePush(c) ?? publishes(c) ?? globalPackages(c) ?? persistentConfig(c) ?? remoteDaemon(c);
    if (why) return why;
  }
  if (SET_ENV_PERSISTENT.test(command)) {
    return {
      en: "`SetEnvironmentVariable` with a User / Machine target changes environment variables permanently",
      zh: "永久改用户 / 整机的环境变量（SetEnvironmentVariable）",
    };
  }
  const envHost = ENV_DAEMON.exec(command)?.[1];
  if (envHost && !localDaemon(envHost) && parsed.commands.some((c) => CONTAINER_CLIS.has(c.name))) {
    return { en: `DOCKER_HOST=${envHost} sends the container commands to a remote daemon`, zh: `把容器命令发给远程的 Docker（${envHost}）` };
  }
  if (reachesImds(parsed, command)) return IMDS_REASON;
  return null;
}

// 命令的位置参数（不以 - 开头的词；引号里的 "-x" 也算），小写
const positional = (c: ShellCommand): string[] =>
  c.words
    .slice(1)
    .filter((w) => w.leadQuoted || !w.text.startsWith("-") || w.text === "-")
    .map((w) => w.text.toLowerCase());

// ── 执行刚下载的内容：下载器的输出直接喂给 shell / 解释器 ──────────────────────────
const DOWNLOADERS = new Set(["curl", "wget", "iwr", "irm", "invoke-webrequest", "invoke-restmethod", "start-bitstransfer"]);
// PowerShell 里用 .NET 下载（(New-Object Net.WebClient).DownloadString(…)）——只在喂给 iex 时才算（Encoding.GetString 不是下载）
const DOTNET_DOWNLOAD = /\.Download(?:String|Data)(?:Async)?\s*\(|\.Get(?:String|ByteArray)Async\s*\(/i;
const INPUT_SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "mksh", "fish"]);
const INPUT_INTERPRETERS = new Set(["python", "python3", "py", "pypy", "pypy3", "node", "nodejs", "perl", "ruby", "php"]);
const STDIN_ARGS = new Set(["-", "/dev/stdin"]);
// 只打印信息就退出：`python --version`、`bash --help`
const INFO_FLAG = /^(?:--version|--help|-V+|-v|-h|-\?)$/;

function downloadExec(parsed: ShellParse, command: string): boolean {
  const runners = parsed.commands.filter(runsInput);
  // sh -c "$(curl …)"、eval "$(curl …)"、iex $code：执行的脚本串里拼了运行时的值
  const spliced = parsed.unanalyzable && (parsed.reason ?? "").includes(SPLICED_AT_RUN_TIME);
  if (!runners.length && !spliced) return false;
  if (parsed.commands.some((c) => DOWNLOADERS.has(c.name))) return true;
  return runners.some((c) => c.name === "iex" || c.name === "invoke-expression") && DOTNET_DOWNLOAD.test(command);
}

// 前导选项与之后的操作数（`--` 之后全是操作数；第一个操作数之后的词属于脚本，不再当选项）
function optionsAndOperands(words: ShellWord[]): { options: string[]; operands: ShellWord[] } {
  const options: string[] = [];
  let k = 0;
  for (; k < words.length; k++) {
    const w = words[k];
    if (w.leadQuoted || !w.text.startsWith("-") || STDIN_ARGS.has(w.text)) break;
    if (w.text === "--") {
      k++;
      break;
    }
    options.push(w.text);
  }
  return { options, operands: words.slice(k) };
}

// 从管道、进程替换或命令替换里读程序来跑。here-document 喂的不算：程序就写在命令里（`python - <<'EOF'`）。
function runsInput(c: ShellCommand): boolean {
  const n = c.name;
  // iex / Invoke-Expression 的字面参数分词器已经展开成命令了；分出来的这条没有参数，程序来自管道或 (…)
  if (n === "iex" || n === "invoke-expression") return true;
  const { options, operands } = optionsAndOperands(c.words.slice(1));
  if (options.some((o) => INFO_FLAG.test(o))) return false;
  const first = operands[0];
  const piped = c.pipedIn === true && !c.heredoc;
  // 脚本参数是进程替换 / 命令替换（`bash <(curl …)`），或管道里来的 stdin（`-`、/dev/stdin）
  const fromInput = (w: ShellWord | undefined) => Boolean(w && (w.subst || (piped && STDIN_ARGS.has(w.text))));
  if (n === "source" || n === ".") return fromInput(first);
  if (INPUT_SHELLS.has(n)) return fromInput(first) || (piped && (!first || options.some((o) => /^-[A-Za-z]*s/.test(o)))); // bash -s：从 stdin 读
  if (INPUT_INTERPRETERS.has(n)) {
    if (first) return fromInput(first);
    // 没给脚本文件：带了 -c / -e / -m / -p 之类（程序在参数里）就不是从 stdin 读——`curl … | python -c "…"` 在解析数据
    return piped && !options.some((o) => /^--(?:eval|print|command|module)\b/.test(o) || /^-[A-Za-z]*[cemprfE]/.test(o));
  }
  return false;
}

// ── 远端：强推 / 删远端分支，发布包与镜像 ────────────────────────────────────────
const GIT_VALUE_GLOBALS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--config-env"]);

function gitSub(c: ShellCommand): { sub: string | undefined; rest: string[] } {
  const a = c.argv.slice(1);
  let k = 0;
  while (k < a.length && a[k].startsWith("-")) k += GIT_VALUE_GLOBALS.has(a[k]) ? 2 : 1;
  return { sub: a[k], rest: a.slice(k + 1) };
}

function forcePush(c: ShellCommand): Reason | null {
  if (c.name !== "git") return null;
  const { sub, rest } = gitSub(c);
  if (sub !== "push") return null;
  const short = (x: string, ch: string) => /^-[A-Za-z0-9]+$/.test(x) && x.includes(ch); // -uf = -u -f
  if (rest.some((x) => x === "--dry-run" || short(x, "n"))) return null; // 演练
  const refs = rest.filter((x) => !x.startsWith("-"));
  if (rest.some((x) => x === "--force" || x.startsWith("--force-with-lease") || x === "--mirror" || short(x, "f")) || refs.some((r) => r.startsWith("+"))) {
    return {
      en: "`git push --force` (or a +refspec / --mirror) rewrites history on the remote",
      zh: "强推：改写远端的提交历史，被盖掉的提交本地检查点救不回来",
    };
  }
  if (rest.some((x) => x === "--delete" || x === "--prune" || short(x, "d")) || refs.some((r) => r.startsWith(":"))) {
    return { en: "`git push --delete` (or a :refspec / --prune) deletes branches or tags on the remote", zh: "删掉远端的分支或标签" };
  }
  return null;
}

const REGISTRY_CLIS: Record<string, string[]> = {
  npm: ["publish", "unpublish"],
  pnpm: ["publish"],
  yarn: ["publish"],
  bun: ["publish"],
  cargo: ["publish", "yank"],
  twine: ["upload"],
  gem: ["push", "yank"],
  poetry: ["publish"],
  uv: ["publish"],
  flit: ["publish"],
  hatch: ["publish"],
  pdm: ["publish"],
  nuget: ["push", "delete"],
};
const CONTAINER_CLIS = new Set(["docker", "podman", "nerdctl"]);

function publishes(c: ShellCommand): Reason | null {
  const n = c.name;
  const p = positional(c);
  if (c.argv.includes("--dry-run")) return null; // 演练
  const registry = (cmd: string): Reason => ({
    en: `\`${cmd}\` publishes to (or withdraws from) a package registry`,
    zh: `发布到（或撤出）包仓库（${cmd}）——发出去别人就可能装上了，收不干净`,
  });
  if (REGISTRY_CLIS[n]?.includes(p[0])) return registry(`${n} ${p[0]}`);
  if (n === "yarn" && p[0] === "npm" && p[1] === "publish") return registry("yarn npm publish");
  if (n === "dotnet" && p[0] === "nuget" && (p[1] === "push" || p[1] === "delete")) return registry(`dotnet nuget ${p[1]}`);
  if (CONTAINER_CLIS.has(n)) {
    const build = p[0] === "build" || (p[0] === "buildx" && p[1] === "build");
    if (p[0] === "push" || ((p[0] === "image" || p[0] === "manifest") && p[1] === "push") || (build && c.argv.includes("--push"))) {
      return { en: `\`${n} push\` publishes an image to a registry`, zh: `把镜像推到镜像仓库（${n} push）` };
    }
  }
  if (n === "gh") {
    if (p[0] === "release" && ["create", "delete", "upload", "delete-asset"].includes(p[1])) {
      return { en: `\`gh release ${p[1]}\` changes a release on GitHub`, zh: `改动 GitHub 上的发布（gh release ${p[1]}）` };
    }
    if (p[0] === "repo" && (p[1] === "delete" || p[1] === "archive")) {
      return { en: `\`gh repo ${p[1]}\` acts on the repository on GitHub`, zh: `${p[1] === "delete" ? "删掉" : "归档"} GitHub 上的仓库（gh repo ${p[1]}）` };
    }
  }
  return null;
}

// ── 全局环境：全局装卸包、系统包管理器 ───────────────────────────────────────────
const JS_GLOBAL_MUTATE = new Set([
  "install", "i", "in", "ins", "inst", "insta", "instal", "isnt", "isnta", "isntal", "isntall", "add", "a",
  "uninstall", "un", "unlink", "remove", "rm", "r", "update", "up", "upgrade", "udpate", "link", "ln",
]);
const SYSTEM_PACKAGES: Record<string, string[]> = {
  winget: ["install", "add", "uninstall", "remove", "rm", "upgrade", "update", "import"],
  choco: ["install", "uninstall", "upgrade"],
  scoop: ["install", "uninstall", "reset"],
  apt: ["install", "remove", "purge", "upgrade", "full-upgrade", "dist-upgrade", "autoremove", "reinstall"],
  "apt-get": ["install", "remove", "purge", "upgrade", "dist-upgrade", "autoremove", "reinstall"],
  brew: ["install", "uninstall", "remove", "rm", "upgrade", "reinstall"],
  dnf: ["install", "remove", "erase", "upgrade", "update", "reinstall", "downgrade"],
  yum: ["install", "remove", "erase", "upgrade", "update", "reinstall", "downgrade"],
  snap: ["install", "remove", "refresh"],
};

function globalPackages(c: ShellCommand): Reason | null {
  const n = c.name;
  const p = positional(c);
  const args = c.argv.slice(1);
  if (n === "npm" || n === "pnpm" || n === "bun") {
    const global = args.some((x, k) => x === "-g" || x === "--global" || x === "--location=global" || (x === "--location" && args[k + 1] === "global"));
    if (global && JS_GLOBAL_MUTATE.has(p[0])) {
      return {
        en: `\`${n} ${p[0]} -g\` changes the globally installed packages (and the commands on PATH) of this machine`,
        zh: `改动本机全局装的包和命令（${n} ${p[0]} -g）——在工作区之外，检查点管不到`,
      };
    }
  }
  if (n === "yarn" && p[0] === "global" && ["add", "remove", "upgrade", "upgrade-interactive"].includes(p[1])) {
    return { en: `\`yarn global ${p[1]}\` changes the globally installed packages of this machine`, zh: `改动本机全局装的包（yarn global ${p[1]}）` };
  }
  // 卸载系统 Python 里的包（带路径的 pip 多半是虚拟环境里的，不算）
  const bare = !/[\\/]/.test(c.argv[0] ?? "");
  const pipUninstall =
    (/^pip(?:\d+(?:\.\d+)?)?$/.test(n) && p[0] === "uninstall") ||
    (PYTHONS.has(n) && args.some((x, k) => x === "-m" && /^pip\d*$/.test(args[k + 1] ?? "") && args[k + 2]?.toLowerCase() === "uninstall"));
  if (bare && pipUninstall) {
    return { en: "`pip uninstall` removes packages from the Python installation this machine shares", zh: "从本机共用的 Python 里卸载包（别的程序可能还在用）" };
  }
  if (SYSTEM_PACKAGES[n]?.includes(p[0])) {
    return { en: `\`${n} ${p[0]}\` installs or removes software for this whole machine`, zh: `给整台机器装 / 卸软件（${n} ${p[0]}）` };
  }
  return null;
}

// ── 全局环境：持久环境变量、注册表、全局 git 配置 ────────────────────────────────
const REG_WRITES = new Set(["add", "import", "copy", "restore", "load", "unload"]); // reg delete 已在硬拒里
const PS_ITEM_CMDLETS = new Set([
  "set-itemproperty", "sp", "new-itemproperty", "remove-itemproperty", "rp", "rename-itemproperty", "rnp",
  "clear-itemproperty", "clp", "new-item", "ni", "set-item", "si", "remove-item", "ri", "rename-item", "rni",
  "move-item", "mi", "copy-item", "cpi", "clear-item", "cli",
]);
const REGISTRY_PATH = /^(?:-(?:path|literalpath)[:=])?(?:HK(?:LM|CU|CR|U|CC)|HKEY_[A-Z_]+)(?::|\\|\/|$)|^(?:-(?:path|literalpath)[:=])?Registry::/i;
const GIT_CONFIG_WRITE = /^(?:--unset|--unset-all|--add|--replace-all|--rename-section|--remove-section|--edit|-e)$/;
const SET_ENV_PERSISTENT = /\bSetEnvironmentVariable\s*\([\s\S]{0,400}?\b(?:User|Machine)\b/i;

function persistentConfig(c: ShellCommand): Reason | null {
  const n = c.name;
  if (n === "setx" && !c.argv.includes("/?")) {
    return { en: "`setx` changes environment variables permanently for the user or the whole machine", zh: "永久改用户 / 整机的环境变量（setx）" };
  }
  if (n === "reg" && REG_WRITES.has(positional(c)[0])) {
    return { en: `\`reg ${positional(c)[0]}\` changes the Windows registry`, zh: `改 Windows 注册表（reg ${positional(c)[0]}）` };
  }
  if (PS_ITEM_CMDLETS.has(n) && c.argv.slice(1).some((x) => REGISTRY_PATH.test(x))) {
    return { en: `\`${c.argv[0]}\` on a registry key changes the Windows registry`, zh: `改 Windows 注册表（${c.argv[0]}）` };
  }
  if (n === "git") {
    const { sub, rest } = gitSub(c);
    if (sub !== "config" || !rest.some((x) => x === "--global" || x === "--system")) return null;
    const pos = rest.filter((x) => !x.startsWith("-"));
    // 只给键是读（git config --global user.name）；--get* / --list / get / list 也是读
    const reads = rest.some((x) => /^--get/.test(x) || x === "--list" || x === "-l") || pos[0] === "get" || pos[0] === "list";
    const writes = rest.some((x) => GIT_CONFIG_WRITE.test(x)) || ["set", "unset", "rename-section", "remove-section", "edit"].includes(pos[0] ?? "") || pos.length >= 2;
    const scope = rest.includes("--system") ? "--system" : "--global";
    if (writes && !reads) {
      return { en: `\`git config ${scope}\` changes git settings for every repository on this machine`, zh: `改全局 git 配置（git config ${scope}），本机所有仓库都受影响` };
    }
  }
  return null;
}

// ── 远程 Docker：-H / --host / --context / DOCKER_HOST 指向别的机器 ─────────────────
const DOCKER_VALUE_GLOBALS = new Set(["-H", "--host", "-c", "--context", "--url", "--config", "-l", "--log-level", "--tlscacert", "--tlscert", "--tlskey"]);
const LOCAL_CONTEXTS = new Set(["default", "desktop-linux", "desktop-windows", "rootless", "colima", "orbstack"]);
const ENV_DAEMON = /(?:^|[\s;&|(])(?:export\s+|set\s+|\$env:)(?:DOCKER_HOST|CONTAINER_HOST)\s*=\s*["']?([^\s"';&|)]+)/i;
const localDaemon = (v: string) =>
  /^(?:unix|npipe):/i.test(v) || /^(?:tcp|https?):\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\/?$/i.test(v);

function remoteDaemon(c: ShellCommand): Reason | null {
  if (!CONTAINER_CLIS.has(c.name)) return null;
  // DOCKER_HOST=tcp://… docker ps：赋值前缀在这一段的原文里
  const prefix = /^\s*((?:[A-Za-z_]\w*=\S*\s+)+)/.exec(c.raw)?.[1] ?? "";
  const host = /(?:^|\s)(?:DOCKER_HOST|CONTAINER_HOST)=["']?([^\s"']+)/.exec(prefix)?.[1];
  if (host && !localDaemon(host)) {
    return { en: `\`${c.name}\` with DOCKER_HOST=${host} sends the command to a remote daemon`, zh: `把命令发给远程的 Docker（${host}）` };
  }
  const a = c.argv.slice(1);
  for (let k = 0; k < a.length && a[k].startsWith("-"); k++) {
    const m = /^(--?[A-Za-z][\w-]*)(?:=(.*))?$/.exec(a[k]);
    if (!m) continue;
    const opt = m[1];
    const value = m[2] ?? (DOCKER_VALUE_GLOBALS.has(opt) ? (a[++k] ?? "") : "");
    if ((opt === "-H" || opt === "--host" || opt === "--url") && value && !localDaemon(value)) {
      return { en: `\`${c.name} ${opt} ${value}\` sends the command to a remote daemon`, zh: `把命令发给远程的 Docker（${value}）` };
    }
    if ((opt === "--context" || (opt === "-c" && c.name === "docker")) && value && !LOCAL_CONTEXTS.has(value.toLowerCase())) {
      return { en: `\`${c.name} --context ${value}\` may send the command to a remote daemon`, zh: `命令可能发给远程的 Docker（context ${value}）` };
    }
  }
  return null;
}

// ── 云元数据端点（IMDS）：云主机上它直接发这台机器的云凭证 ─────────────────────────
const IMDS = /169\.254\.169\.254|169\.254\.170\.2(?!\d)|100\.100\.100\.200|metadata\.google\.internal|\bmetadata\.goog\b|fd00:ec2::254/i;
export const mentionsImds = (text: string): boolean => IMDS.test(text);

function reachesImds(parsed: ShellParse, command: string): boolean {
  if (!IMDS.test(command)) return false;
  if (parsed.unanalyzable) return true;
  // echo / grep 之类只是提到它，不算
  return parsed.commands.some((c) => !READ_ONLY_VERBS.has(c.name) && c.argv.slice(1).some((w) => IMDS.test(w)));
}
