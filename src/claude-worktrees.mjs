// Claude 分页的「worktree 会话」——输入框上方分支胶囊右半那颗勾选框（claude.ai /code 与
// 官方桌面 app 同款）。勾上再开新对话：先从项目当前 HEAD 切一个 git worktree，
// 会话整轮以 worktree 为 cwd 运行，主检出一个字节都不碰。
//
// 形制照官方桌面 app（Claude_2.16120 app.asar 的 gitWorktreeManager）：
//   位置 <主仓库根>/.claude/worktrees/<名>（项目本身是 linked worktree 时也落在主仓库根下）；
//   名字 = 形容词-名词-6 位 hex，分支 claude/<名>；`.claude/worktrees/` 写进
//   <common-dir>/info/exclude（不碰仓库的 .gitignore）；仓库根有 .worktreeinclude 时，
//   把命中它、且被 git 忽略的未跟踪文件（.env 之类）拷进新 worktree（Claude Code CLI 同款约定）。
// 与官方的差别：起点是项目【当前 HEAD】（芯片左半显示的那个分支），不去 fetch origin 默认分支——
// bridge 的项目大多是本地仓库，芯片写着 main 就从 main 切，所见即所得。
//
// 归属：worktree 的 cwd 与项目路径不同，transcript 落在另一个 slug 目录里。这里按身份记一张
// 小表（<claude-projects>-worktrees.json：worktree → 所属项目 id），claude-projects.mjs 的
// sessionScopes 据此把 worktree 目录并进所属项目——会话仍列在原项目下，续聊/回滚/工作台
// 一律以 worktree 为 cwd。worktree 删了、记录还在也无害：历史照读，续聊会报路径不存在。

import crypto from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, appendFileSync, copyFileSync, statSync, realpathSync } from 'node:fs';
import { readJson, writeJson } from './jsonfile.mjs';

const MAX_RECORDS = 500;
const MAX_INCLUDE_FILES = 2000;
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };

const real = (p) => { try { return realpathSync.native ? realpathSync.native(p) : realpathSync(p); } catch { return path.resolve(p); } };
const fold = (p) => process.platform === 'win32' ? p.toLowerCase() : p;
const samePath = (a, b) => fold(path.resolve(a || '')) === fold(path.resolve(b || ''));
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

export function storeFile(projectsFile) {
  return path.join(path.dirname(projectsFile), path.basename(projectsFile, '.json') + '-worktrees.json');
}

function readStore(projectsFile) {
  const data = readJson(storeFile(projectsFile), { worktrees: [] });
  return {
    worktrees: (Array.isArray(data.worktrees) ? data.worktrees : [])
      .filter((w) => w && typeof w.projectId === 'string' && typeof w.cwd === 'string'),
  };
}

// 某身份记着的全部 worktree（{ projectId, name, branch, root, cwd, created }）
export function listWorktrees(projectsFile) {
  return readStore(projectsFile).worktrees;
}

function record(projectsFile, entry) {
  const store = readStore(projectsFile);
  store.worktrees = store.worktrees.filter((w) => !samePath(w.cwd, entry.cwd));
  store.worktrees.push(entry);
  if (store.worktrees.length > MAX_RECORDS) store.worktrees.splice(0, store.worktrees.length - MAX_RECORDS);
  writeJson(storeFile(projectsFile), store, 2);
}

function git(cwd, args, { timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=false', ...args], { cwd, env: GIT_ENV, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      resolve(err ? { ok: false, out: '', err: String(stderr || err.message || err).trim() } : { ok: true, out: String(stdout ?? ''), err: '' });
    });
  });
}

// 官方名字表的同款做法（ai/oi 两张词表 + randomBytes(3)），词表自拟。
const ADJ = ['amber', 'brave', 'calm', 'clever', 'crisp', 'eager', 'fuzzy', 'gentle', 'happy', 'jolly', 'keen', 'lively', 'lucky', 'mellow', 'nimble', 'quiet', 'rapid', 'shiny', 'snowy', 'sunny', 'swift', 'tidy', 'vivid', 'witty'];
const NOUN = ['badger', 'beacon', 'cedar', 'comet', 'falcon', 'fern', 'harbor', 'heron', 'lantern', 'maple', 'meadow', 'otter', 'pebble', 'pine', 'quartz', 'raven', 'river', 'sparrow', 'summit', 'thistle', 'tulip', 'walrus', 'willow', 'zephyr'];
const pick = (arr) => arr[crypto.randomInt(arr.length)];
const genName = () => `${pick(ADJ)}-${pick(NOUN)}-${crypto.randomBytes(3).toString('hex')}`;

// <common-dir>/info/exclude 里补一行 `.claude/worktrees/`——否则主检出的 git status
// 会把整棵 worktree 目录当成未跟踪文件端上来（审阅面板第一眼就是一片噪音）。
function ensureExcluded(commonDir) {
  const file = path.join(commonDir, 'info', 'exclude');
  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch {}
  if (text.split(/\r?\n/).some((l) => l.trim().replace(/\/$/, '') === '.claude/worktrees')) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, (text && !text.endsWith('\n') ? '\n' : '') + '.claude/worktrees/\n');
  } catch {}
}

// .worktreeinclude：列出「被 git 忽略、又命中这份清单」的未跟踪文件，原样拷进新 worktree。
async function copyWorktreeIncludes(srcTop, dstTop) {
  const list = path.join(srcTop, '.worktreeinclude');
  if (!existsSync(list)) return 0;
  const r = await git(srcTop, ['ls-files', '-z', '--others', '--ignored', '--exclude-from=' + list]);
  if (!r.ok) return 0;
  let n = 0;
  for (const rel of r.out.split('\0').filter(Boolean).slice(0, MAX_INCLUDE_FILES)) {
    const from = path.join(srcTop, rel);
    const to = path.join(dstTop, rel);
    if (!path.resolve(to).startsWith(path.resolve(dstTop) + path.sep)) continue;
    try {
      if (!statSync(from).isFile() || existsSync(to)) continue;
      mkdirSync(path.dirname(to), { recursive: true });
      copyFileSync(from, to);
      n++;
    } catch {}
  }
  return n;
}

// 给 project（{ id, path }，path 已过 authorizeProjectPath）切一个会话 worktree。
// 返回 { projectId, name, branch, root, cwd, base, created }；cwd = worktree 里对应项目目录的位置
//（项目是仓库子目录时同样落在子目录）。失败抛带 status 的 Error（消息给用户看）。
export async function createSessionWorktree(projectsFile, project) {
  const dir = project.path;
  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw fail('这个工作空间不是 git 仓库，无法创建 worktree');
  const toplevel = path.resolve(top.out.trim());
  const common = await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!common.ok) throw fail('读取 git 仓库信息失败：' + common.err);
  const commonDir = path.resolve(common.out.trim());
  const head = await git(dir, ['rev-parse', '--verify', '-q', 'HEAD']);
  if (!head.ok || !head.out.trim()) throw fail('仓库还没有任何提交，无法从当前分支创建 worktree');
  const base = ((await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).out.trim()) || head.out.trim().slice(0, 7);

  // 主仓库根：common-dir 是 <根>/.git 时取其父；裸仓库等异形退回当前 toplevel。
  const mainRoot = path.basename(commonDir).toLowerCase() === '.git' ? path.dirname(commonDir) : toplevel;
  const parent = path.join(mainRoot, '.claude', 'worktrees');
  let name = '';
  for (let i = 0; i < 8; i++) {
    const n = genName();
    if (existsSync(path.join(parent, n))) continue;
    if ((await git(dir, ['rev-parse', '--verify', '-q', 'refs/heads/claude/' + n])).ok) continue;
    name = n; break;
  }
  if (!name) throw fail('生成 worktree 名字失败，请重试', 500);
  const root = path.join(parent, name);
  const branch = 'claude/' + name;
  mkdirSync(parent, { recursive: true });
  ensureExcluded(commonDir);
  const add = await git(dir, ['worktree', 'add', '-b', branch, root, 'HEAD'], { timeout: 180_000 });
  if (!add.ok) throw fail('git worktree add 失败：' + (add.err.split(/\r?\n/).filter(Boolean).pop() || '未知错误'), 500);

  await copyWorktreeIncludes(toplevel, root);
  const rel = path.relative(toplevel, path.resolve(dir));
  let cwd = rel && !rel.startsWith('..') ? path.join(root, rel) : root;
  if (!existsSync(cwd)) mkdirSync(cwd, { recursive: true });   // 项目子目录全是被忽略文件时，检出里没有它
  // 与 authorizeProjectPath 同一套 realpath：SDK 的 transcript 目录按 cwd 字面量取 slug，
  // 大小写/分隔符差一点，归属推导就找不到这条会话。
  cwd = real(cwd);
  const entry = { projectId: project.id, name, branch, base, root: real(root), cwd, created: Date.now() };
  record(projectsFile, entry);
  return entry;
}
