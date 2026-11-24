// 子 agent 的 worktree 隔离：在父工作区所在的 git 仓库上新建一个 worktree（数据目录的 worktrees/ 下，分支 dimensio/agent-<短 id>，
// 从父仓库此刻的 HEAD 起），子 agent 的工作区根就是它（父工作区是仓库子目录时，根是 worktree 里同一个子目录；那个子目录不在仓库
// 跟踪范围里——新检出里没有它——就不建，退回普通方式）。
// 结束时：没有任何改动（工作树干净、分支上没有新提交、被忽略的路径里也没写东西、它改过的文件都不在了）就删掉 worktree 和分支；
// 有改动就原样保留，报告里给路径、分支与改动概要。删除只删自己建的那一个，用不带 --force 的 `git worktree remove`——它会拒绝删
// 有未提交改动或未跟踪文件的 worktree，但不把被 .gitignore 忽略的文件当改动（会连同它们一起删），所以被忽略的文件另查。
// 每个在用的 worktree 旁边有一张登记（<id>.json：仓库、路径、分支、起点、属于哪个会话）：结束收尾时撤掉；进程在收尾之前死掉
// 留下的，由启动时的 sweepAgentWorktrees 按同样的规则收尾。
// git 一律无壳调用、关掉 hooks / fsmonitor（helperGitArgs），超时收整棵进程树。
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { helperEnv, helperGitArgs } from "../../helper-proc.ts";
import { worktreesRoot } from "../../paths.ts";
import { killChildTree } from "../../proc-tree.ts";
import { disabledTools, tenantMode } from "../../tenant.ts";

export interface AgentWorktree {
  repo: string; // 父仓库的根
  path: string; // worktree 目录
  root: string; // 子 agent 的工作区根（worktree 里对应父工作区的那个目录）
  branch: string;
  base: string; // 起点提交
}

export interface WorktreeOutcome {
  kept: boolean;
  summary: string; // 给父 agent 看的一段（kept 时是路径、分支、改动概要；删掉了就一句话）
}

const GIT_TIMEOUT_MS = 120_000;
const BRANCH_PREFIX = "dimensio/agent-";

function git(args: string[], cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn("git", [...helperGitArgs(), ...args], { cwd, windowsHide: true, env: helperEnv({ GIT_TERMINAL_PROMPT: "0" }) });
    } catch (e) {
      resolve({ code: null, out: "", err: (e as Error).message });
      return;
    }
    let out = "";
    let err = "";
    let settled = false;
    const done = (r: { code: number | null; out: string; err: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    const timer = setTimeout(() => {
      killChildTree(child);
      done({ code: null, out, err: `${err}\ngit ${args[0]} timed out` });
    }, timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (err += b.toString()));
    child.on("error", (e) => done({ code: null, out, err: e.message }));
    child.on("close", (code) => done({ code, out: out.trim(), err: err.trim() }));
    child.stdin.end();
  });
}

/** 这里能不能用 worktree 隔离；不能就给一句原因（成员实例、没有命令行、不是 git 仓库、仓库还没有提交）。 */
export async function worktreeSupport(parentRoot: string): Promise<{ repo: string; base: string } | { reason: string }> {
  if (tenantMode()) return { reason: "worktree isolation is not available on a member instance" };
  if (disabledTools().has("Bash")) return { reason: "worktree isolation needs a command line, which this instance does not have" };
  const top = await git(["rev-parse", "--show-toplevel"], parentRoot, 20_000);
  if (top.code !== 0 || !top.out) return { reason: "the workspace is not inside a git repository" };
  const head = await git(["rev-parse", "HEAD"], parentRoot, 20_000);
  if (head.code !== 0 || !/^[0-9a-f]{7,64}$/i.test(head.out)) return { reason: "the git repository has no commits yet" };
  return { repo: path.resolve(top.out), base: head.out };
}

// ── 登记（<id>.json，与 worktree 目录并排）────────────────────────────────────
const ID_RE = /^[0-9a-z]{4,32}$/i;
interface Ticket extends AgentWorktree {
  v: 1;
  id: string;
  owner?: string; // 属于哪个会话（启动收尾时把保留下来的告诉它）
  createdAt: number;
}

const ticketFile = (id: string): string => path.join(worktreesRoot(), `${id}.json`);

function writeTicket(wt: AgentWorktree, owner: string | undefined): void {
  const id = path.basename(wt.path);
  const t: Ticket = { v: 1, id, ...wt, ...(owner ? { owner } : {}), createdAt: Date.now() };
  try {
    fs.writeFileSync(ticketFile(id), JSON.stringify(t));
  } catch (e) {
    console.error(`[subagent] worktree ticket ${id}: ${(e as Error).message}`);
  }
}

function dropTicket(wt: AgentWorktree): void {
  try {
    fs.rmSync(ticketFile(path.basename(wt.path)), { force: true });
  } catch {
    /* 留着也只是启动时多看一眼 */
  }
}

/** 新建一个 worktree。失败时不留半截目录。owner = 发起它的会话 id（写进登记）。 */
export async function createWorktree(parentRoot: string, id: string, owner?: string): Promise<AgentWorktree | { error: string }> {
  const support = await worktreeSupport(parentRoot);
  if ("reason" in support) return { error: support.reason };
  const dir = path.join(worktreesRoot(), id);
  if (fs.existsSync(dir)) return { error: `worktree directory already exists: ${dir}` };
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const branch = `${BRANCH_PREFIX}${id}`;
  const add = await git(["worktree", "add", "-b", branch, dir, support.base], support.repo);
  if (add.code !== 0) {
    await git(["worktree", "prune"], support.repo, 20_000);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    await git(["branch", "-D", branch], support.repo, 20_000);
    return { error: `git worktree add failed: ${(add.err || add.out).slice(0, 400)}` };
  }
  const sub = path.relative(support.repo, path.resolve(parentRoot));
  const root = sub && !sub.startsWith("..") && !path.isAbsolute(sub) ? path.join(dir, sub) : dir;
  // 父工作区是仓库里没跟踪 / 被忽略的子目录：新检出里没有它，子 agent 会在一个空目录里干活——不建，刚建的这一个原样撤掉
  //（才建出来、里面只有检出的文件，用 --force 删的也只是它）
  if (!fs.existsSync(root)) {
    await git(["worktree", "remove", "--force", dir], support.repo);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    await git(["worktree", "prune"], support.repo, 20_000);
    await git(["branch", "-D", branch], support.repo, 20_000);
    return { error: "the workspace folder is not tracked in its git repository, so a fresh checkout would not contain it" };
  }
  const wt: AgentWorktree = { repo: support.repo, path: dir, root, branch, base: support.base };
  writeTicket(wt, owner);
  return wt;
}

async function inspect(wt: AgentWorktree): Promise<{ dirty: string; ignored: string; commits: string; diffstat: string } | null> {
  const status = await git(["status", "--porcelain", "--untracked-files=all"], wt.path);
  if (status.code !== 0) return null;
  // 被 .gitignore 忽略的文件 git status 不列、git worktree remove 照删：另查（新检出里本来一个都没有，有就是子 agent 写的）
  const all = await git(["status", "--porcelain", "--ignored", "--untracked-files=all"], wt.path);
  if (all.code !== 0) return null;
  const ignored = all.out.split("\n").filter((l) => l.startsWith("!! ")).map((l) => l.slice(3)).join("\n");
  const commits = await git(["log", "--oneline", `${wt.base}..HEAD`], wt.path);
  const diffstat = await git(["diff", "--stat", wt.base], wt.path);
  return { dirty: status.out, ignored, commits: commits.code === 0 ? commits.out : "", diffstat: diffstat.code === 0 ? diffstat.out : "" };
}

// 子 agent 自己记下的改过 / 新建的文件里，还在这个 worktree 里的（git 看不见的位置也算数）
function touchedInside(wt: AgentWorktree, files: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const f of files ?? []) {
    const rel = path.relative(wt.path, path.resolve(f));
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (fs.existsSync(f)) out.push(rel.split(path.sep).join("/"));
  }
  return out;
}

const clipLines = (s: string, n: number): string => {
  const lines = s.split("\n").filter(Boolean);
  return lines.length > n ? `${lines.slice(0, n).join("\n")}\n… (${lines.length - n} more)` : lines.join("\n");
};

/**
 * 子 agent 结束：没改动就删掉，有改动就保留并说清。查不清楚（git 出错）一律保留。
 * touched = 子 agent 自己记下的改过 / 新建的文件（绝对路径）：还在 worktree 里的一律算改动。结论交出去之后登记撤掉。
 */
export async function finishWorktree(wt: AgentWorktree, opts: { touched?: readonly string[] } = {}): Promise<WorktreeOutcome> {
  const out = await settle(wt, opts.touched);
  dropTicket(wt);
  return out;
}

async function settle(wt: AgentWorktree, touched: readonly string[] | undefined): Promise<WorktreeOutcome> {
  if (!fs.existsSync(wt.path)) return { kept: false, summary: "Its worktree is already gone." };
  const state = await inspect(wt);
  if (!state) return { kept: true, summary: keptText(wt, { dirty: "(could not read its git status)" }) };
  const own = touchedInside(wt, touched);
  if (!state.dirty && !state.commits && !state.ignored && !own.length) {
    const rm = await git(["worktree", "remove", wt.path], wt.repo);
    if (rm.code === 0) {
      const tip = await git(["rev-parse", wt.branch], wt.repo, 20_000);
      if (tip.code === 0 && tip.out === wt.base) await git(["branch", "-D", wt.branch], wt.repo, 20_000);
      return { kept: false, summary: "It made no changes, so its worktree and branch were removed." };
    }
    return { kept: true, summary: keptText(wt, { dirty: `(removing the unchanged worktree failed: ${(rm.err || rm.out).slice(0, 200)})` }) };
  }
  // git 什么都没列、只有它自己记下的文件还在（例如改了又改回原样）：照样保留，把那几个文件列出来
  const reported = !state.dirty && !state.commits && !state.ignored ? own.join("\n") : "";
  return { kept: true, summary: keptText(wt, { ...state, reported }) };
}

function keptText(wt: AgentWorktree, s: { dirty?: string; commits?: string; diffstat?: string; ignored?: string; reported?: string }): string {
  const { dirty = "", commits = "", diffstat = "", ignored = "", reported = "" } = s;
  return [
    `Its changes are kept in a git worktree for you to review and merge: ${wt.path} (branch ${wt.branch}, started from ${wt.base.slice(0, 12)}).`,
    commits ? `Commits on the branch:\n${clipLines(commits, 20)}` : "",
    dirty ? `Uncommitted changes (git status --porcelain):\n${clipLines(dirty, 40)}` : "",
    ignored ? `Files it wrote in git-ignored paths (git status does not show these; copy them over if you need them):\n${clipLines(ignored, 40)}` : "",
    reported ? `Files it changed (git shows no difference from the starting commit):\n${clipLines(reported, 40)}` : "",
    diffstat ? `Diff against the starting commit:\n${clipLines(diffstat, 40)}` : "",
    `To bring them in, for example: git -C "${wt.repo}" merge ${wt.branch} (after committing in the worktree), or copy the files over; remove it afterwards with git worktree remove.`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** 接着用一个子 agent 的 worktree：还在就照用，已删掉就在原路径上重建（分支还在就接着它，没了就从仓库此刻的 HEAD 重新开一个）。 */
export async function reopenWorktree(wt: AgentWorktree, owner?: string): Promise<AgentWorktree | { error: string }> {
  if (fs.existsSync(wt.path)) {
    writeTicket(wt, owner);
    return wt;
  }
  const support = await worktreeSupport(wt.repo);
  if ("reason" in support) return { error: support.reason };
  const has = await git(["rev-parse", "--verify", "--quiet", wt.branch], wt.repo, 20_000);
  const args = has.code === 0 ? ["worktree", "add", wt.path, wt.branch] : ["worktree", "add", "-b", wt.branch, wt.path, support.base];
  const add = await git(args, wt.repo);
  if (add.code !== 0) {
    await git(["worktree", "prune"], wt.repo, 20_000);
    return { error: `git worktree add failed: ${(add.err || add.out).slice(0, 400)}` };
  }
  const next = has.code === 0 ? wt : { ...wt, base: support.base };
  writeTicket(next, owner);
  return next;
}

export interface LeftoverWorktree {
  owner?: string;
  worktree: AgentWorktree;
  outcome: WorktreeOutcome;
}

function readTicket(file: string): Ticket | null {
  try {
    const t = JSON.parse(fs.readFileSync(file, "utf8")) as Ticket;
    if (t?.v !== 1 || typeof t.id !== "string" || !ID_RE.test(t.id)) return null;
    if (typeof t.repo !== "string" || typeof t.branch !== "string" || typeof t.base !== "string" || typeof t.root !== "string") return null;
    if (!t.branch.startsWith(BRANCH_PREFIX) || !/^[0-9a-f]{7,64}$/i.test(t.base)) return null;
    // 只认数据目录里自己那一格（登记被改坏、指到别处的不碰）
    if (path.resolve(t.path) !== path.join(worktreesRoot(), t.id)) return null;
    return t;
  } catch {
    return null;
  }
}

/**
 * 启动时收尾：上一个进程没来得及收尾（服务退出时限到了、进程崩了）的 worktree，按 finishWorktree 同样的规则处理——没改动的删掉，
 * 有改动的保留并返回（会话层把路径与分支告诉它所属的会话）。只在启动时、还没有子 agent 在跑时调。
 */
export async function sweepAgentWorktrees(): Promise<LeftoverWorktree[]> {
  const root = worktreesRoot();
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return [];
  }
  const out: LeftoverWorktree[] = [];
  const repos = new Set<string>();
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(root, name);
    const t = readTicket(file);
    if (!t) {
      console.error(`[subagent] ignoring an unreadable worktree ticket: ${name}`);
      continue;
    }
    const wt: AgentWorktree = { repo: t.repo, path: path.join(root, t.id), root: t.root, branch: t.branch, base: t.base };
    repos.add(wt.repo);
    const outcome = await finishWorktree(wt);
    if (outcome.kept) out.push({ ...(t.owner ? { owner: t.owner } : {}), worktree: wt, outcome });
  }
  for (const repo of repos) if (fs.existsSync(repo)) await git(["worktree", "prune"], repo, 20_000);
  return out;
}
