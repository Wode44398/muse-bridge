// 项目对话的协调者（project-mode.ts）的只读命令白名单——判法移植自 bridge 的 src/runtime/readonly-shell.mjs（2026-11-04）。
// 协调者不改文件、不跑命令，但得能核对讨论串的成果：看分支改动、提交记录、PR 与 CI。这里只放行 git / gh 的只读子命令，
// 别的一律拦下。由 coordinatorBashTool 在执行前判定（工具层拦，权限档、allow 规则都放不开它）。
//
// 规则（宁可误拦，不可误放）：
//   ① 只能是一条简单命令：引号外不许 ; & | < > ` $ ( ) { } # * ? [ ] 和反斜杠（不能串联、管道、重定向、命令替换、
//      变量展开、通配——通配会把文件名展开成参数，比如一个叫 --output=x 的文件）；双引号里不许 $ ` \；任何地方不许换行。
//      Windows 路径写正斜杠，或放进单引号。
//   ② 第一个词必须是 git 或 gh（前缀环境变量、别的程序都不行）。
//   ③ git：全局选项只认 -C <目录> / --no-pager / -P / --no-optional-locks / --git-dir= / --work-tree=；子命令按白名单，
//      branch / tag / stash / worktree / remote / reflog 只认列出与查看；--output（写文件）、-O（开编辑器）这类参数拦下。
//      放行时补 --no-optional-locks：git status 不去抢讨论串正在用的 index 锁。
//   ④ gh：只认 pr view/list/checks/diff/status、run list/view、issue view/list、repo view、release list/view、
//      workflow list/view；--web（开浏览器）、--watch（一直挂着）拦下；gh api 不给（能发写请求）。

const UNQUOTED_BAD = new Set([";", "&", "|", "<", ">", "`", "$", "(", ")", "{", "}", "#", "*", "?", "[", "]", "\\"]);

/** 按 shell 规则拆词（只认成对的单 / 双引号）。不合规则返回 { error }。 */
export function shellWords(cmd: unknown): { words: string[]; error?: undefined } | { words?: undefined; error: string } {
  const s = String(cmd ?? "");
  if (/[\r\n\0]/.test(s)) return { error: "不能有换行" };
  const words: string[] = [];
  let cur: string | null = null;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") {
      if (cur !== null) {
        words.push(cur);
        cur = null;
      }
      i++;
      continue;
    }
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return { error: "单引号没有配对" };
      cur = (cur ?? "") + s.slice(i + 1, j);
      i = j + 1;
      continue;
    }
    if (c === '"') {
      const j = s.indexOf('"', i + 1);
      if (j < 0) return { error: "双引号没有配对" };
      const q = s.slice(i + 1, j);
      if (/[$`\\]/.test(q)) return { error: "双引号里不能有 $ ` \\（要原样的字符就用单引号）" };
      cur = (cur ?? "") + q;
      i = j + 1;
      continue;
    }
    if (UNQUOTED_BAD.has(c)) return { error: `引号外不能有「${c}」——只能是一条简单命令，不能串联、管道、重定向、展开或通配` };
    cur = (cur ?? "") + c;
    i++;
  }
  if (cur !== null) words.push(cur);
  return { words };
}

const GIT_READ = new Set([
  "status", "log", "show", "diff", "blame", "shortlog", "ls-files", "ls-tree", "rev-parse", "rev-list", "merge-base",
  "describe", "grep", "cat-file", "range-diff", "cherry", "show-ref", "for-each-ref", "diff-tree", "diff-files", "diff-index",
  "name-rev", "whatchanged", "branch", "tag", "stash", "worktree", "remote", "reflog",
]);
// 带写副作用 / 会拉起别的程序的参数（任何 git 子命令里都拦）
const gitBadOpt = (w: string): boolean =>
  w === "--output" || w.startsWith("--output=") || w === "-O" || (w.startsWith("-O") && w.length > 2 && !w.startsWith("--"))
  || w === "--open-files-in-pager" || w.startsWith("--open-files-in-pager=") || w === "--ext-diff" || w === "--exec" || w.startsWith("--exec=");
// branch / tag 的列出模式：只认这些参数；有位置参数时必须带一个列出类参数（否则 git branch foo = 新建分支）
const BRANCH_OPTS = /^(-a|--all|-r|--remotes|-v|-vv|--verbose|-l|--list|--show-current|--merged|--no-merged|--contains|--no-contains|--points-at|--sort=.+|--format=.+|--column|--no-column|--color|--no-color|--abbrev=\d+|--omit-empty|-i|--ignore-case|-n\d*)$/;
const LIST_MODE = new Set(["-l", "--list", "--merged", "--no-merged", "--contains", "--no-contains", "--points-at"]);

function gitVerdict(w: string[]): string {
  let i = 1;
  // 全局选项
  while (i < w.length && w[i].startsWith("-")) {
    const o = w[i];
    if (o === "-C") {
      if (i + 1 >= w.length) return "-C 后面要跟目录";
      i += 2;
      continue;
    }
    if (o === "--no-pager" || o === "-P" || o === "--no-optional-locks" || o.startsWith("--git-dir=") || o.startsWith("--work-tree=")) {
      i++;
      continue;
    }
    return `git 的全局选项 ${o} 不放行（-c、--exec-path、--paginate 这类能改配置或拉起别的程序）`;
  }
  const sub = w[i];
  if (!sub) return "缺子命令";
  if (!GIT_READ.has(sub)) return `git ${sub} 不是只读子命令`;
  const args = w.slice(i + 1);
  const bad = args.find(gitBadOpt);
  if (bad) return `参数 ${bad} 会写文件或拉起别的程序`;
  const pos = args.filter((a) => !a.startsWith("-"));
  if (sub === "branch" || sub === "tag") {
    const off = args.find((a) => a.startsWith("-") && !BRANCH_OPTS.test(a));
    if (off) return `git ${sub} ${off} 会改动分支 / 标签，只放行列出`;
    if (pos.length && !args.some((a) => LIST_MODE.has(a))) return `git ${sub} 带名字是新建，只放行列出（要按名字筛就加 --list）`;
    return "";
  }
  if (sub === "stash") return ["list", "show"].includes(args[0]) ? "" : "git stash 只放行 list / show";
  if (sub === "worktree") return args[0] === "list" ? "" : "git worktree 只放行 list";
  if (sub === "remote") return !args.length || args.every((a) => a === "-v" || a === "--verbose") || ["show", "get-url"].includes(args[0]) ? "" : "git remote 只放行列出 / show / get-url";
  if (sub === "reflog") return !pos.length || pos[0] === "show" || pos[0] === "exists" ? "" : "git reflog 只放行查看";
  return "";
}

const GH_READ: Record<string, string[]> = { pr: ["view", "list", "checks", "diff", "status"], run: ["list", "view"], issue: ["view", "list"], repo: ["view"], release: ["list", "view"], workflow: ["list", "view"] };
function ghVerdict(w: string[]): string {
  const grp = w[1];
  const sub = w[2];
  if (!grp || !Object.hasOwn(GH_READ, grp)) return `gh${grp ? " " + grp : ""} 不放行（只认 pr / run / issue / repo / release / workflow 的查看类命令）`;
  if (!GH_READ[grp].includes(sub)) return `gh ${grp} ${sub || ""} 不是查看类命令（gh ${grp} 只放行 ${GH_READ[grp].join(" / ")}）`;
  const bad = w.slice(3).find((a) => a === "--web" || a === "-w" || a === "--watch" || a.startsWith("--web=") || a.startsWith("--watch="));
  if (bad) return `参数 ${bad} 会开浏览器或一直挂着`;
  return "";
}

export type ReadonlyVerdict = { ok: true; command: string } | { ok: false; reason: string };

/** 这条命令能不能给协调者跑。放行时 git 补上 --no-optional-locks。 */
export function readonlyCommandVerdict(command: unknown): ReadonlyVerdict {
  const cmd = String(command ?? "").trim();
  if (!cmd) return { ok: false, reason: "命令是空的" };
  const parsed = shellWords(cmd);
  if (parsed.error !== undefined) return { ok: false, reason: parsed.error };
  const words = parsed.words;
  const prog = words[0];
  if (prog === "git") {
    const why = gitVerdict(words);
    if (why) return { ok: false, reason: why };
    return { ok: true, command: words.includes("--no-optional-locks") ? cmd : cmd.replace(/^git(?=\s|$)/, "git --no-optional-locks") };
  }
  if (prog === "gh") {
    const why = ghVerdict(words);
    return why ? { ok: false, reason: why } : { ok: true, command: cmd };
  }
  return { ok: false, reason: `只放行 git / gh 的只读查询，${prog} 不行` };
}

export const READONLY_DENY_HINT =
  "The coordinator's Bash only runs read-only git / gh queries (git status / log / diff / show / branch / blame …, gh pr view / checks / diff, gh run view …), one simple command at a time — no pipes, redirects, globs or chaining. To change files, run tests or builds, commit or push, start a thread to do it.";
