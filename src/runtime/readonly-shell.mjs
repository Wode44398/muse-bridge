// 协调者（项目对话，runtime/project-mode.mjs）的只读命令白名单（2026-11-04）。
// 协调者不改文件、不跑命令，但得能核对讨论串的成果：看分支改动、提交记录、PR 与 CI。这里只放行 git / gh 的只读子命令，
// 别的一律拦下。挂在 claude.mjs 的 PreToolUse（Bash）上：钩子在权限模式之前生效，「绕过权限」档也拦得住；
// 协调者派出去的 worker（钩子输入带 agent_id）不经这里。
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

const UNQUOTED_BAD = new Set([';', '&', '|', '<', '>', '`', '$', '(', ')', '{', '}', '#', '*', '?', '[', ']', '\\']);

/** 按 shell 规则拆词（只认成对的单 / 双引号）。不合规则返回 { error }。 */
export function shellWords(cmd) {
  const s = String(cmd ?? '');
  if (/[\r\n\0]/.test(s)) return { error: '不能有换行' };
  const words = [];
  let cur = null, i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === ' ' || c === '\t') { if (cur !== null) { words.push(cur); cur = null; } i++; continue; }
    if (c === "'") {
      const j = s.indexOf("'", i + 1);
      if (j < 0) return { error: '单引号没有配对' };
      cur = (cur ?? '') + s.slice(i + 1, j); i = j + 1; continue;
    }
    if (c === '"') {
      const j = s.indexOf('"', i + 1);
      if (j < 0) return { error: '双引号没有配对' };
      const q = s.slice(i + 1, j);
      if (/[$`\\]/.test(q)) return { error: '双引号里不能有 $ ` \\（要原样的字符就用单引号）' };
      cur = (cur ?? '') + q; i = j + 1; continue;
    }
    if (UNQUOTED_BAD.has(c)) return { error: `引号外不能有「${c}」——只能是一条简单命令，不能串联、管道、重定向、展开或通配` };
    cur = (cur ?? '') + c; i++;
  }
  if (cur !== null) words.push(cur);
  return { words };
}

const GIT_READ = new Set([
  'status', 'log', 'show', 'diff', 'blame', 'shortlog', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'merge-base',
  'describe', 'grep', 'cat-file', 'range-diff', 'cherry', 'show-ref', 'for-each-ref', 'diff-tree', 'diff-files', 'diff-index',
  'name-rev', 'whatchanged', 'branch', 'tag', 'stash', 'worktree', 'remote', 'reflog',
]);
// 带写副作用 / 会拉起别的程序的参数（任何 git 子命令里都拦）
const GIT_BAD_OPT = (w) => w === '--output' || w.startsWith('--output=') || w === '-O' || w.startsWith('-O') && w.length > 2 && !w.startsWith('--')
  || w === '--open-files-in-pager' || w.startsWith('--open-files-in-pager=') || w === '--ext-diff' || w === '--exec' || w.startsWith('--exec=');
// branch / tag 的列出模式：只认这些参数；有位置参数时必须带一个列出类参数（否则 git branch foo = 新建分支）
const BRANCH_OPTS = /^(-a|--all|-r|--remotes|-v|-vv|--verbose|-l|--list|--show-current|--merged|--no-merged|--contains|--no-contains|--points-at|--sort=.+|--format=.+|--column|--no-column|--color|--no-color|--abbrev=\d+|--omit-empty|-i|--ignore-case|-n\d*)$/;
const LIST_MODE = new Set(['-l', '--list', '--merged', '--no-merged', '--contains', '--no-contains', '--points-at']);

function gitVerdict(w) {
  let i = 1;
  // 全局选项
  while (i < w.length && w[i].startsWith('-')) {
    const o = w[i];
    if (o === '-C') { if (i + 1 >= w.length) return '-C 后面要跟目录'; i += 2; continue; }
    if (o === '--no-pager' || o === '-P' || o === '--no-optional-locks' || o.startsWith('--git-dir=') || o.startsWith('--work-tree=')) { i++; continue; }
    return `git 的全局选项 ${o} 不放行（-c、--exec-path、--paginate 这类能改配置或拉起别的程序）`;
  }
  const sub = w[i];
  if (!sub) return '缺子命令';
  if (!GIT_READ.has(sub)) return `git ${sub} 不是只读子命令`;
  const args = w.slice(i + 1);
  const bad = args.find(GIT_BAD_OPT);
  if (bad) return `参数 ${bad} 会写文件或拉起别的程序`;
  const pos = args.filter((a) => !a.startsWith('-'));
  if (sub === 'branch' || sub === 'tag') {
    const off = args.find((a) => a.startsWith('-') && !BRANCH_OPTS.test(a));
    if (off) return `git ${sub} ${off} 会改动分支 / 标签，只放行列出`;
    if (pos.length && !args.some((a) => LIST_MODE.has(a))) return `git ${sub} 带名字是新建，只放行列出（要按名字筛就加 --list）`;
    return '';
  }
  if (sub === 'stash') return ['list', 'show'].includes(args[0]) ? '' : 'git stash 只放行 list / show';
  if (sub === 'worktree') return args[0] === 'list' ? '' : 'git worktree 只放行 list';
  if (sub === 'remote') return !args.length || args.every((a) => a === '-v' || a === '--verbose') || ['show', 'get-url'].includes(args[0]) ? '' : 'git remote 只放行列出 / show / get-url';
  if (sub === 'reflog') return !pos.length || pos[0] === 'show' || pos[0] === 'exists' ? '' : 'git reflog 只放行查看';
  return '';
}

const GH_READ = { pr: ['view', 'list', 'checks', 'diff', 'status'], run: ['list', 'view'], issue: ['view', 'list'], repo: ['view'], release: ['list', 'view'], workflow: ['list', 'view'] };
function ghVerdict(w) {
  const grp = w[1], sub = w[2];
  if (!grp || !GH_READ[grp]) return `gh${grp ? ' ' + grp : ''} 不放行（只认 pr / run / issue / repo / release / workflow 的查看类命令）`;
  if (!GH_READ[grp].includes(sub)) return `gh ${grp} ${sub || ''} 不是查看类命令（gh ${grp} 只放行 ${GH_READ[grp].join(' / ')}）`;
  const bad = w.slice(3).find((a) => a === '--web' || a === '-w' || a === '--watch' || a.startsWith('--web=') || a.startsWith('--watch='));
  if (bad) return `参数 ${bad} 会开浏览器或一直挂着`;
  return '';
}

/**
 * 这条命令能不能给协调者跑。返回 { ok:true, command }（git 补上 --no-optional-locks）或 { ok:false, reason }。
 */
export function readonlyCommandVerdict(command) {
  const cmd = String(command ?? '').trim();
  if (!cmd) return { ok: false, reason: '命令是空的' };
  const { words, error } = shellWords(cmd);
  if (error) return { ok: false, reason: error };
  const prog = words[0];
  if (prog === 'git') {
    const why = gitVerdict(words);
    if (why) return { ok: false, reason: why };
    return { ok: true, command: words.includes('--no-optional-locks') ? cmd : cmd.replace(/^git(?=\s|$)/, 'git --no-optional-locks') };
  }
  if (prog === 'gh') {
    const why = ghVerdict(words);
    return why ? { ok: false, reason: why } : { ok: true, command: cmd };
  }
  return { ok: false, reason: `只放行 git / gh 的只读查询，${prog} 不行` };
}

/**
 * PreToolUse（matcher Bash）钩子：协调者自己的 Bash 只放行只读查询；它派出去的 worker（agent_id 有值）照常。
 * 放行的直接 allow（只读查询不弹审批卡），git 补成 --no-optional-locks，不许挂后台。
 */
export function makeCoordinatorShellHook() {
  return async (input) => {
    if (!input || input.agent_id || input.tool_name !== 'Bash') return { continue: true };
    const ti = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
    const v = readonlyCommandVerdict(ti.command);
    if (!v.ok) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `这条命令没跑：${v.reason}。${READONLY_DENY_HINT}` } };
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', permissionDecisionReason: '协调者的只读查询', updatedInput: { ...ti, command: v.command, run_in_background: false } } };
  };
}

export const READONLY_DENY_HINT = '协调者的 Bash 只能跑只读的 git / gh 查询（git status / log / diff / show / branch / blame…，gh pr view / checks / diff、gh run view…），一次一条简单命令，不带管道、重定向和通配。要改文件、跑测试、提交推送，开讨论串去做。';
