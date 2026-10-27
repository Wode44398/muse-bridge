// Claude 分页右侧工作台（dock）的后端四组接口：
//   审阅  GET  /api/claude/review, /api/claude/review/diff   — worktree 概览（git 变更清单 + 单文件 diff）
//   终端  GET  /api/claude/term/stream + POST input/resize/kill — 工作空间 PTY（ctx.shell 门禁）
//   浏览器 GET /api/claude/browser/{state,stream} + POST navigate/input/resize/close — CDP screencast（ctx.shell 门禁）
//   元信息 GET /api/claude/dock/meta — 工作空间相对路径（文件页跳转）+ git 归属（分支 / 是否
//          linked worktree，供输入框上方的归属状态栏芯片）+ 能力位
//
// 工作空间路径一律经 authorizeProjectPath 圈定（admin 任意本地目录、Pro 限自己空间、
// share 走 requireCtx 直接 401），全局 Origin CSRF 闸已覆盖所有 POST。
//
// 聊天快照（kind:'snap'，公开 /c/ 链接的匿名访客）拿到的是【阉割版工作台】：
//   审阅 ✓ / 文件 ✓ / 浏览器【只读直播】✓ / 终端 ✗
// ws 参数对 snap 一律忽略、强制取 ctx.cwd（快照桶），前端传什么都改不了作用域。

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import { readBody } from '../runtime/body.mjs';
import { requireCtx } from '../runtime/identity.mjs';
import { withinRoot } from '../runtime/http-file.mjs';
import { authorizeProjectPath } from '../claude-projects.mjs';
import { writeSseHeaders, sseWrite, startHeartbeat } from '../runtime/sse.mjs';
import { poolRef } from '../runtime/principal.mjs';
import { gitInvocation } from '../runtime/member-boundary.mjs';

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'; // git 恒定空树 hash
// 浏览器直播帧流控：每个观众最多这么多帧在路上没回 ack（见 stream 路由）。
const FRAME_WINDOW = 2;
const castFlows = new Map();   // sid → flow（stream 连接期间有效；sid 是不可猜的随机串）
const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: '0' };

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const fail = (res, e) => json(res, e?.status || 500, { error: e?.message || String(e) });

// 成员目录里的仓库配置是成员自己能写的：经 gitInvocation 加覆盖（钩子、fsmonitor、签名程序、外部 diff）并剔凭据环境
function git(ws, args, { maxBuffer = 16 * 1024 * 1024 } = {}) {
  const inv = gitInvocation(ws, ['-c', 'core.quotepath=false', ...args], GIT_ENV);
  return new Promise((resolve) => {
    execFile('git', inv.args, { cwd: ws, env: inv.env, timeout: 15_000, maxBuffer, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout ?? ''));
    });
  });
}

// 工作空间在仓库里的相对前缀（仓库根 → ''，子目录 → 'a/b/'）。
// 工作空间是某个仓库的【子目录】时（快照桶就落在 claude-bridge 仓里！），不加限定的
// git diff/status 会把【整个仓库】的变更端上来——对公开快照访客等于泄露整份源码工作树。
// 所以下面所有 git 调用一律 `-- .` 限定到本目录子树，并把输出路径拉回工作空间相对：
// diff 用 --relative（git 自己按 cwd 剥前缀），status 只认仓库相对路径、手工剥 prefix。
// 「是不是仓库」与前缀并成一次 rev-parse（Windows 上每起一个 git 约 100ms，以前审阅一次串行起 8 个）。
// → null（不是 git 仓库）| { prefix }
async function repoInfo(ws) {
  const out = await git(ws, ['rev-parse', '--is-inside-work-tree', '--show-prefix']);
  if (out == null) return null;
  return { prefix: (out.split('\n')[1] || '').trim() };
}

// 基线选择：在分支上且存在 main/master → merge-base（分支全部工作+未提交都算变更）；
// 否则 HEAD（只看未提交）；无任何提交的新仓库 → 空树。label 是「X → working tree」里的 X。
// 分支名、有没有 HEAD、main/master 在不在三问并成一轮并行（以前串行 4–5 次 spawn）。
async function reviewBase(ws) {
  const [abbrev, head, heads] = await Promise.all([
    git(ws, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(ws, ['rev-parse', '--verify', '-q', 'HEAD']),
    git(ws, ['for-each-ref', '--format=%(refname)', 'refs/heads/main', 'refs/heads/master']),
  ]);
  const branch = (abbrev || '').trim() || 'HEAD';
  if (head == null) return { base: EMPTY_TREE, label: branch, branch };
  const have = new Set(String(heads || '').split('\n').map((s) => s.trim()).filter(Boolean));
  for (const main of ['main', 'master']) {
    if (branch === main) break;
    if (!have.has('refs/heads/' + main)) continue;
    const mb = await git(ws, ['merge-base', 'HEAD', main]);
    if (mb) return { base: mb.trim(), label: main, branch };
    break;
  }
  return { base: 'HEAD', label: branch, branch };
}

// 解析 `git diff --numstat -z -M` ：常规记录 "add\tdel\tpath\0"，改名记录 "add\tdel\t\0old\0new\0"。
function parseNumstatZ(out) {
  const files = [];
  const tok = String(out || '').split('\0');
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (!t) continue;
    const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(t);
    if (!m) continue;
    const bin = m[1] === '-';
    const add = bin ? 0 : +m[1];
    const del = bin ? 0 : +m[2];
    if (m[3] === '') {
      const from = tok[++i] ?? '';
      const to = tok[++i] ?? '';
      files.push({ path: to, from, add, del, bin });
    } else {
      files.push({ path: m[3], add, del, bin });
    }
  }
  return files;
}

// 解析 `git diff --name-status -z -M`：R/C 后跟两个路径，其余一个。
function parseNameStatusZ(out) {
  const map = new Map();
  const tok = String(out || '').split('\0');
  for (let i = 0; i < tok.length; i++) {
    const st = tok[i];
    if (!st) continue;
    const letter = st[0];
    if (letter === 'R' || letter === 'C') {
      i += 2;
      map.set(tok[i] ?? '', letter);
    } else {
      i += 1;
      map.set(tok[i] ?? '', letter);
    }
  }
  return map;
}

const looksBinary = (buf) => buf.subarray(0, 8000).includes(0);

// 读文件开头至多 max 字节（异步）。→ { buf, size }；不是普通文件 / 读不了就抛。
async function readHead(abs, max) {
  const fh = await fsp.open(abs, 'r');
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error('not a file');
    const len = Math.min(st.size, max);
    const buf = Buffer.allocUnsafe(len);
    const { bytesRead } = len ? await fh.read(buf, 0, len, 0) : { bytesRead: 0 };
    return { buf: buf.subarray(0, bytesRead), size: st.size };
  } finally { await fh.close().catch(() => {}); }
}

// 未跟踪文件行数（读上限 1MB 内数 \n；二进制不数）。
// 10-21：以前 statSync + readFileSync 整读（只为数前 1MB 的行），工作区里堆着 Chrome 配置、构建产物时一次几十 MB 同步 IO，
// 卡住整个事件循环 0.6–1.4s。现在只异步读前 1MB；调用方限并发、另有总字节预算（超了的只报文件、行数记 0）。
const UNTRACKED_HEAD = 1024 * 1024;
async function untrackedStat(abs, { count = true } = {}) {
  let r;
  try { r = await readHead(abs, count ? UNTRACKED_HEAD : 8000); } catch { return null; }
  const { buf, size } = r;
  if (size === 0) return { add: 0, bin: false, bytes: 0 };
  if (looksBinary(buf)) return { add: 0, bin: true, bytes: buf.length };
  if (!count) return { add: 0, bin: false, bytes: buf.length };
  let lines = 0;
  for (let i = buf.indexOf(10); i >= 0; i = buf.indexOf(10, i + 1)) lines++;
  if (buf.length && buf[buf.length - 1] !== 10) lines++;
  return { add: lines, bin: false, bytes: buf.length };
}

// 一组异步任务限并发跑，结果按原顺序
async function mapLimit(list, n, fn) {
  const out = new Array(list.length);
  let next = 0;
  const worker = async () => { while (next < list.length) { const i = next++; out[i] = await fn(list[i], i); } };
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, worker));
  return out;
}

// 未跟踪清单：status -z --untracked-files=all 里的 "?? path" 记录。
// `-- .` 只看本工作空间子树；status 输出恒为仓库相对路径，按 prefix 剥回本地相对。
async function untrackedFiles(ws, prefix) {
  const out = await git(ws, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']);
  if (out == null) return [];
  const files = [];
  const tok = out.split('\0');
  for (let i = 0; i < tok.length; i++) {
    const t = tok[i];
    if (!t || t.length < 4) continue;
    const st = t.slice(0, 2);
    if (st[0] === 'R' || st[0] === 'C') i += 1; // rename 的第二段路径跳过
    if (st !== '??') continue;
    const p = t.slice(3);
    if (prefix && !p.startsWith(prefix)) continue;   // 子树外的一律丢掉（`-- .` 之外的兜底）
    files.push(prefix ? p.slice(prefix.length) : p);
    if (files.length >= 500) break;
  }
  return files;
}

// 相对路径护栏：rel 必须落在 ws 内（拒绝绝对路径与 .. 穿越）。
function insideWs(ws, rel) {
  const raw = String(rel || '');
  if (!raw || path.isAbsolute(raw)) return null;
  const abs = path.resolve(ws, raw);
  const root = path.resolve(ws);
  if (!withinRoot(root, abs)) return null;
  return abs;
}

// 同一个工作空间【同时】到的请求共用一次计算（会话信息面板 + 审阅面板在一轮收尾时一起拉）。
// 只让「还没开始读 git 状态」的在途计算搭车：compute(ws, seal) 在开读工作区 / 引用之前调 seal()，之后到的请求另起一次——
// 更早开读的那次可能在本请求的起因（这一轮最后一次写文件、刚改完点刷新）之前就读过状态，搭上去会拿到改动前的快照
// （10-21 审查实测：合并到在途那次 + 算完 2 秒内复用，新建的文件要等下一轮收尾才出现）。所以算完也不留结果。
// 不调 seal 的计算（dock/meta）在途期间都可搭车。键按路径折叠大小写（Windows）；表里只放在途的。
export function _coalesceByWs() {
  const inflight = new Map();   // ws → { open, p }
  return (ws, compute) => {
    const k = process.platform === 'win32' ? ws.toLowerCase() : ws;
    const m = inflight.get(k);
    if (m && m.open) return m.p;
    const entry = { open: true, p: null };
    entry.p = compute(ws, () => { entry.open = false; });
    inflight.set(k, entry);
    const done = () => { if (inflight.get(k) === entry) inflight.delete(k); };
    entry.p.then(done, done);
    return entry.p;
  };
}

// 审阅概览（GET /api/claude/review）。10-21 实测大仓库上要 3–7 秒、末尾还同步整读未跟踪文件卡事件循环 ~1s：
//   · git 调用并轮：是不是仓库+前缀一次 → 基线三问并行 + 未跟踪清单同时起 → 两份 diff 并行；
//   · 未跟踪文件数行改异步、8 并发、每个只读前 1MB，总共最多读 UNTRACKED_BUDGET（超了的只报文件，行数记 0）；
//   · 同时到的请求合并（只在头一次 rev-parse 期间，见 _coalesceByWs）；不做结果缓存：一轮收尾那次必须看到最新改动。
//     晚到的自己另算：读文件已全异步，几份并行只多占 git 子进程，不再卡事件循环。
const UNTRACKED_BUDGET = 64 * 1024 * 1024;
const reviewMemo = _coalesceByWs();
const reviewOf = (ws) => reviewMemo(ws, computeReview);
async function computeReview(ws, seal = () => {}) {
  const repo = await repoInfo(ws);
  if (!repo) return { git: false };
  seal();   // 从这里起读工作区与引用：之后到的请求不再搭这一次
  const untrackedP = untrackedFiles(ws, repo.prefix);
  const { base, label, branch } = await reviewBase(ws);
  const [numstat, nameStatus, untracked] = await Promise.all([
    git(ws, ['diff', '--numstat', '-z', '-M', '--relative', base, '--', '.']),
    git(ws, ['diff', '--name-status', '-z', '-M', '--relative', base, '--', '.']),
    untrackedP,
  ]);
  const stMap = parseNameStatusZ(nameStatus);
  const files = parseNumstatZ(numstat).map((f) => ({ ...f, st: stMap.get(f.path) || 'M' }));
  const seen = new Set(files.map((f) => f.path));
  const cand = [];
  for (const rel of untracked) {
    if (seen.has(rel)) continue;
    const abs = insideWs(ws, rel);
    if (abs) cand.push({ rel, abs });
  }
  let budget = UNTRACKED_BUDGET;
  const stats = await mapLimit(cand, 8, async (c) => {
    const s = await untrackedStat(c.abs, { count: budget > 0 });
    if (s) budget -= s.bytes;
    return s;
  });
  let truncated = false;
  for (let i = 0; i < cand.length; i++) {
    const stat = stats[i];
    if (!stat) continue;
    files.push({ path: cand[i].rel, add: stat.add, del: 0, bin: stat.bin, st: 'U' });
    if (files.length >= 800) { truncated = true; break; }
  }
  const total = files.reduce((a, f) => ({ add: a.add + (f.add || 0), del: a.del + (f.del || 0) }), { add: 0, del: 0 });
  return { git: true, branch, base: label, files, total, truncated };
}

// 输入框上方「归属状态栏」芯片要的 git 信息（GET /api/claude/dock/meta）：
//   branch   分支名；detached HEAD 回落短 sha（芯片总得有字可显）
//   worktree 本目录是不是 linked worktree（--git-dir 落在主仓 .git/worktrees/<名>，
//            与 --git-common-dir 不同即是）。--git-common-dir 在主检出里返回相对路径、
//            在 worktree 里返回绝对路径，故一律 resolve(ws, …) 后再比。
// 以前串行起 4–5 个 git（切会话时 ~500ms）；现在「是不是仓库 + git-dir + common-dir」并成一次，与分支名并行。
// 并发请求合并、在途期间都可搭车（分支名之类，晚几百毫秒无妨；前端自己按 ws 缓存，这里不留结果）。
const metaMemo = _coalesceByWs();
const gitMetaOf = (ws) => metaMemo(ws, computeGitMeta);
async function computeGitMeta(ws) {
  let [info, abbrev] = await Promise.all([
    git(ws, ['rev-parse', '--is-inside-work-tree', '--absolute-git-dir', '--git-common-dir']),
    git(ws, ['rev-parse', '--abbrev-ref', 'HEAD']),
  ]);
  // 合并那条失败（极老的 git 不认 --absolute-git-dir 之类）：退回只判是不是仓库
  if (info == null && (await git(ws, ['rev-parse', '--is-inside-work-tree'])) == null) return { isGit: false, branch: null, worktree: false };
  const [, gitDir = '', commonRaw = ''] = String(info || '').split('\n').map((s) => s.trim());
  let branch = (abbrev || '').trim() || null;
  if (branch === 'HEAD') branch = ((await git(ws, ['rev-parse', '--short', 'HEAD'])) || '').trim() || null;
  const worktree = !!gitDir && !!commonRaw && path.resolve(gitDir) !== path.resolve(ws, commonRaw);
  return { isGit: true, branch, worktree };
}

export function registerClaudeDockRoutes(router, { identify }) {
  // 统一守卫：登录 → ctx；ws 参数 → 授权后的绝对路径。失败已回响应，返回 null。
  //   shell:true = 需要完整权限（终端、浏览器的一切【操作】）——snap/普通 user 403。
  //   watch:true = 只读旁观也放行（浏览器 state/stream）：snap 访客看得见直播、动不了。
  const dockCtx = (req, res, wsRaw, { shell = false, watch = false } = {}) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return null;
    const isSnap = ctx.kind === 'snap';
    if (shell && !ctx.shell && !(watch && isSnap)) { json(res, 403, { error: '该功能仅对完整权限用户开放' }); return null; }
    let ws;
    // 快照身份忽略客户端传来的 ws，一律锁死在自己的桶：作用域不由前端说了算。
    try { ws = authorizeProjectPath(ctx, isSnap ? ctx.cwd : wsRaw); } catch (e) { fail(res, e); return null; }
    // ref = 终端 / 浏览器池的引用（属主, 工作空间）：与 agent 侧同一把键（claude.mjs 按 poolRef(ctx, cwd) 取），
    // 面板与 agent 继续共用同一个 shell / 浏览器；别人进了同一个目录拿到的是另一份（开源路线 C6）。
    return { ctx, ws, ref: poolRef(ctx, ws) };
  };

  // ── 元信息：文件页跳转用的相对路径 + git 仓库判定 + 能力位 ──────────────────
  router.on('GET', '/api/claude/dock/meta', async (req, res, url) => {
    const g = dockCtx(req, res, url.searchParams.get('ws'));
    if (!g) return;
    const { ctx, ws } = g;
    const root = path.resolve(ctx.cwd || '');
    const relRaw = path.relative(root, ws);
    const rel = relRaw === '' ? '' : (!relRaw.startsWith('..') && !path.isAbsolute(relRaw) ? relRaw.split(path.sep).join('/') : null);
    const { isGit, branch, worktree } = await gitMetaOf(ws);
    // snap = 快照访客：前端据此只摆 审阅/文件/浏览器（只读）三件，并藏掉工作空间路径。
    // wtNew = 本服务端能在这里开 worktree 会话（git 主检出、非快照）——输入栏 worktree 勾选框只认它：
    // 前端先于服务端上线（apk 连着没重启的老服务端）时勾选框不出现，不会勾了却悄悄跑在主检出里。
    json(res, 200, { rel, git: isGit, branch, worktree, wtNew: isGit && !worktree && ctx.kind !== 'snap', shell: !!ctx.shell, snap: ctx.kind === 'snap' });
  });

  // ── 审阅：变更概览 ──────────────────────────────────────────────────────────
  router.on('GET', '/api/claude/review', async (req, res, url) => {
    const g = dockCtx(req, res, url.searchParams.get('ws'));
    if (!g) return;
    try { json(res, 200, await reviewOf(g.ws)); } catch (e) { fail(res, e); }
  });

  // ── 审阅：单文件 diff（懒加载展开）──────────────────────────────────────────
  router.on('GET', '/api/claude/review/diff', async (req, res, url) => {
    const g = dockCtx(req, res, url.searchParams.get('ws'));
    if (!g) return;
    const { ws } = g;
    const rel = String(url.searchParams.get('file') || '');
    const from = String(url.searchParams.get('from') || '');
    const abs = insideWs(ws, rel);
    if (!abs) return json(res, 400, { error: 'bad file path' });
    // S4：from=重命名旧路径（组 diff 用），与 file 同规矩过 insideWs——否则公开 /c/ 快照
    // 访客可用 ../../ 把 git pathspec 指到工作空间子树之外，读整个仓库任意文件的 diff。
    if (from && from !== rel && !insideWs(ws, from)) return json(res, 400, { error: 'bad from path' });
    // 未跟踪标记用 u=1——st/ct 是身份系统的保留查询参数（share/snap 能力 token），
    // 带 st=U 会被 identify 当成过期分享 token 解析成 none → 401。
    const untracked = String(url.searchParams.get('u') || '') === '1';
    if (untracked) {
      // 未跟踪：合成整篇新增的伪 diff（git diff 不含未跟踪文件）。
      // 只异步读开头 2MB：下面最多留 40 万字符（UTF-8 一个字符至多 4 字节，2MB 够切），不再同步整读大文件。
      let buf;
      try { ({ buf } = await readHead(abs, 2 * 1024 * 1024)); } catch { return json(res, 404, { error: '文件不存在' }); }
      if (looksBinary(buf)) return json(res, 200, { bin: true, text: '' });
      let text = buf.toString('utf8');
      let truncated = false;
      if (text.length > 400 * 1024) { text = text.slice(0, 400 * 1024); truncated = true; }
      let lines = text.split('\n');
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      if (lines.length > 4000) { lines = lines.slice(0, 4000); truncated = true; }
      const body = `@@ -0,0 +1,${lines.length} @@\n` + lines.map((l) => '+' + l).join('\n');
      return json(res, 200, { text: body, truncated });
    }
    const { base } = await reviewBase(ws);
    // pathspec 本就以 cwd 为基准，--relative 让输出头部路径也回到工作空间相对——
    // 与上面清单里的路径同一套坐标系（工作空间=仓库子目录时尤其关键）。
    const spec = from && from !== rel ? [from, rel] : [rel];
    let out = await git(ws, ['diff', '--no-ext-diff', '--unified=3', '-M', '--relative', base, '--', ...spec]);
    if (out == null) return json(res, 500, { error: 'git diff 失败' });
    let truncated = false;
    if (out.length > 1024 * 1024) {
      out = out.slice(0, 1024 * 1024);
      const cut = out.lastIndexOf('\n');
      if (cut > 0) out = out.slice(0, cut);
      truncated = true;
    }
    json(res, 200, { text: out, truncated, bin: /^Binary files /m.test(out) });
  });

  // ── 终端：SSE 流（自动开壳 + 快照重放 + 实时增量）───────────────────────────
  router.on('GET', '/api/claude/term/stream', async (req, res, url) => {
    const g = dockCtx(req, res, url.searchParams.get('ws'), { shell: true });
    if (!g) return;
    let term;
    try {
      const svc = await import('../runtime/claude-term.mjs');
      const t = svc.ensureTerm(g.ref, url.searchParams.get('cols'), url.searchParams.get('rows'));
      term = { svc, t };
    } catch (e) { return fail(res, e); }
    writeSseHeaders(res);
    sseWrite(res, { type: 'hello', cols: term.t.cols, rows: term.t.rows, exited: term.t.exited });
    const snap = term.svc.snapshotTerm(term.t);
    if (snap) sseWrite(res, { type: 'snapshot', d: snap });
    term.svc.subscribeTerm(term.t, res);
    const hb = startHeartbeat(res);
    req.on('close', () => clearInterval(hb));
  });

  router.on('POST', '/api/claude/term/input', async (req, res) => {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const g = dockCtx(req, res, body.ws, { shell: true });
    if (!g) return;
    const svc = await import('../runtime/claude-term.mjs');
    json(res, 200, { ok: svc.writeTerm(g.ref, String(body.d ?? '')) });
  });

  router.on('POST', '/api/claude/term/resize', async (req, res) => {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const g = dockCtx(req, res, body.ws, { shell: true });
    if (!g) return;
    const svc = await import('../runtime/claude-term.mjs');
    json(res, 200, { ok: svc.resizeTerm(g.ref, body.cols, body.rows) });
  });

  router.on('POST', '/api/claude/term/kill', async (req, res) => {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const g = dockCtx(req, res, body.ws, { shell: true });
    if (!g) return;
    const svc = await import('../runtime/claude-term.mjs');
    json(res, 200, { ok: svc.killTerm(g.ref) });
  });

  // ── 浏览器：状态 / 直播流 / 导航 / 输入 / 视口 / 关闭 ───────────────────────
  router.on('GET', '/api/claude/browser/state', async (req, res, url) => {
    const g = dockCtx(req, res, url.searchParams.get('ws'), { shell: true, watch: true });
    if (!g) return;
    const { existingBrowser } = await import('../runtime/claude-browser.mjs');
    const b = existingBrowser(g.ref);
    if (!b) return json(res, 200, { alive: false });
    // desktop = 这份浏览器开在桌面壳里（只有主机身份会）。成员 / 快照访客的是无头浏览器：本机桌面客户端挂不上原生视图，面板要走帧流。
    json(res, 200, { alive: true, url: b.url, tabs: b.tabs, desktop: !!b.external, ...b.viewportReport() });
  });

  router.on('GET', '/api/claude/browser/stream', async (req, res, url) => {
    const g = dockCtx(req, res, url.searchParams.get('ws'), { shell: true, watch: true });
    if (!g) return;
    const { existingBrowser, touchBrowser } = await import('../runtime/claude-browser.mjs');
    const b = existingBrowser(g.ref);
    if (!b) return json(res, 409, { alive: false });
    writeSseHeaders(res);
    const nativeView = url.searchParams.get('native') === '1';
    if (nativeView) touchBrowser(g.ref);
    // desktop:false 时 native=1 的面板收不到帧、原生视图也挂不上：新面板据此换 ack=1 帧流重连（老面板不认这个字段，照旧）
    sseWrite(res, { type: 'state', url: b.url, desktop: !!b.external, ...b.viewportReport() });
    const offPtr = b.subscribePointer((p) => sseWrite(res, { type: 'pointer', ...p }));
    const offTabs = b.subscribeTabs((tabs) => sseWrite(res, { type: 'tabs', tabs }));
    // 视口变化（面板设备钮 或 agent 的 browser(resize)）：所有观众同步点亮档位与实测角标；
    // 桌面壳观众还要靠它按新视口重新缩放摆放原生视图。事件 = viewportReport() 全量。
    const offVp = b.subscribeViewport((report) => sseWrite(res, { type: 'viewport', ...report }));
    // 登记观众：agent 的 navigate / tabs 据此告诉它用户此刻看不看得到页面（runtime/claude-browser.mjs viewerReport）
    const ua = String(req.headers['user-agent'] || '');
    const offViewer = b.addViewer({
      kind: g.ctx.kind === 'snap' ? 'guest' : nativeView ? 'native' : 'stream',
      where: /bridge-client/i.test(ua) ? '桌面客户端' : /Android|iPhone|iPad|Mobile/i.test(ua) ? '手机' : '网页端',
    });
    let offCast = null;
    // 帧流控（ack=1 的新面板）：以前收到一帧推一帧，经 Cloudflare 隧道到手机时 node 这边
    // 永远看不到背压（cloudflared 在本机把帧全吞进去再慢慢发），画面排队落后好几秒，用户点了
    // 看不到结果就以为没点上。现在每个观众最多 2 帧在路上，客户端画完回 ack 才发下一帧，中间
    // 来的只留最新一帧——带宽 / 延迟自适应，画面永远是「最近的」。旧面板不带 ack=1 照旧全推。
    const ackMode = url.searchParams.get('ack') === '1';
    const sid = ackMode ? randomBytes(12).toString('hex') : '';
    const flow = { inflight: 0, pending: null, lastSent: 0 };
    const pushFrame = (f) => {
      flow.inflight++; flow.lastSent = Date.now();
      sseWrite(res, { type: 'frame', data: f.data, w: f.deviceWidth, h: f.deviceHeight, url: b.url });
    };
    flow.ack = () => {
      flow.inflight = Math.max(0, flow.inflight - 1);
      if (flow.pending && flow.inflight < FRAME_WINDOW) { const f = flow.pending; flow.pending = null; pushFrame(f); }
    };
    if (ackMode) { castFlows.set(sid, flow); sseWrite(res, { type: 'hello', sid }); }
    // 桌面原生壳直接把同一 CDP target 收进 WebContentsView，不需要每秒反复
    // JPEG 编码→base64→SSE→canvas 解码。native=1 仍保留状态/标签事件给工具条。
    if (!nativeView) {
      try {
        offCast = await b.subscribeCast((f) => {
          if (!ackMode) { sseWrite(res, { type: 'frame', data: f.data, w: f.deviceWidth, h: f.deviceHeight, url: b.url }); return; }
          // ack 丢了（切后台、网络抖）别把画面冻住：3 秒没回音就当窗口已空
          if (flow.inflight >= FRAME_WINDOW && Date.now() - flow.lastSent > 3000) flow.inflight = 0;
          if (flow.inflight >= FRAME_WINDOW || res.writableNeedDrain) { flow.pending = f; return; }
          pushFrame(f);
        });
      } catch (e) {
        sseWrite(res, { type: 'error', message: e?.message || String(e) });
      }
    }
    // 本机直连时 node 能看到背压：缓冲排空后补发攒着的最新帧
    res.on('drain', () => { if (flow.pending && flow.inflight < FRAME_WINDOW) { const f = flow.pending; flow.pending = null; pushFrame(f); } });
    const hb = startHeartbeat(res);
    // 原截图路径靠 castSubs.size 阻止 15 分钟闲置回收；原生路径没有 screencast，
    // 以轻量心跳证明面板仍在看，避免用户直接在 WebContentsView 浏览时被误回收。
    const nativeKeepalive = nativeView ? setInterval(() => touchBrowser(g.ref), 30_000) : null;
    nativeKeepalive?.unref?.();
    req.on('close', () => {
      clearInterval(hb);
      if (sid) castFlows.delete(sid);
      if (nativeKeepalive) clearInterval(nativeKeepalive);
      offPtr();
      offTabs();
      offVp();
      offViewer();
      offCast?.();
      touchBrowser(g.ref);
    });
  });

  // 当前画面的一张静态图（JPEG）。桌面壳原生模式下面板弹菜单时用：原生视图恒在 DOM 之上会盖住
  // 菜单，得先让位，让位期间拿这张图「定格」在原处。
  router.on('GET', '/api/claude/browser/snapshot', async (req, res, url) => {
    const g = dockCtx(req, res, url.searchParams.get('ws'), { shell: true });
    if (!g) return;
    const { existingBrowser } = await import('../runtime/claude-browser.mjs');
    const b = existingBrowser(g.ref);
    if (!b) return json(res, 409, { alive: false });
    try {
      const r = await b.send('Page.captureScreenshot', { format: 'jpeg', quality: 72, captureBeyondViewport: false }, 4000);
      const buf = Buffer.from(String(r?.data || ''), 'base64');
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store', 'Content-Length': buf.length });
      res.end(buf);
    } catch (e) { fail(res, e); }
  });

  // 直播帧回执：面板画完一帧回一次（只有 ack=1 的新面板会发），见 stream 路由的帧流控。
  router.on('POST', '/api/claude/browser/ack', async (req, res) => {
    if (!requireCtx(identify, req, res)) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const flow = castFlows.get(String(body.sid || ''));
    if (!flow) return json(res, 410, { error: 'stream gone' });
    flow.ack();
    json(res, 200, { ok: true });
  });

  // 标签操作：new（可带 url，缺省空白页）/ select / close。面板与 agent 共用。
  router.on('POST', '/api/claude/browser/tab', async (req, res) => {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const g = dockCtx(req, res, body.ws, { shell: true });
    if (!g) return;
    const svc = await import('../runtime/claude-browser.mjs');
    const b = svc.existingBrowser(g.ref);
    if (!b) return json(res, 409, { error: '浏览器未启动' });
    svc.touchBrowser(g.ref);
    try {
      const op = String(body.op || '');
      if (op === 'new') await b.newTab(body.url ? svc.normalizeUrl(body.url) : 'about:blank');
      else if (op === 'select') await b.activateTab(String(body.id || ''));
      else if (op === 'close') await b.closeTab(String(body.id || ''));
      else return json(res, 400, { error: 'bad op' });
      json(res, 200, { ok: true, tabs: b.tabs, url: b.url });
    } catch (e) { fail(res, e); }
  });

  router.on('POST', '/api/claude/browser/navigate', async (req, res) => {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const g = dockCtx(req, res, body.ws, { shell: true });
    if (!g) return;
    const svc = await import('../runtime/claude-browser.mjs');
    try {
      if (body.dir === 'back' || body.dir === 'forward') {
        const b = svc.existingBrowser(g.ref);
        if (!b) return json(res, 409, { error: '浏览器未启动' });
        const to = await b.history(body.dir === 'back' ? -1 : 1);
        return json(res, 200, { ok: true, url: to || b.url });
      }
      if (body.dir === 'reload') {
        const b = svc.existingBrowser(g.ref);
        if (!b) return json(res, 409, { error: '浏览器未启动' });
        await b.reload();
        return json(res, 200, { ok: true, url: b.url });
      }
      const target = svc.normalizeUrl(body.url);
      if (!target) return json(res, 400, { error: '请输入网址' });
      const fresh = !svc.existingBrowser(g.ref);
      const b = await svc.getBrowser(g.ref);   // 地址栏导航自动拉起浏览器
      // 手机面板拉起时带 preset:'mobile'：先换好视口（含移动端 UA）再开页，免得先按桌面版加载一遍
      if (fresh && body.preset) {
        try { const spec = svc.resolveViewportSpec({ preset: body.preset }, b); if (spec) await b.setViewport(spec.width, spec.height, spec); } catch { /* 档位不认识就照默认 */ }
      }
      await b.navigate(target);
      json(res, 200, { ok: true, url: b.url });
    } catch (e) { fail(res, e); }
  });

  router.on('POST', '/api/claude/browser/input', async (req, res) => {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const g = dockCtx(req, res, body.ws, { shell: true });
    if (!g) return;
    const svc = await import('../runtime/claude-browser.mjs');
    const b = svc.existingBrowser(g.ref);
    if (!b) return json(res, 409, { error: '浏览器未启动' });
    svc.touchBrowser(g.ref);
    const x = Number(body.x) || 0, y = Number(body.y) || 0;
    try {
      switch (body.type) {
        case 'click': {
          await b.clickCoord(x, y, { button: body.button === 'right' ? 'right' : 'left', clickCount: body.double ? 2 : 1, source: 'user' });
          // 手机上的面板要知道这一下有没有点进输入框：点进了就拉起它的软键盘（画布本身唤不出键盘）
          if (body.wantFocus) {
            await new Promise((r) => setTimeout(r, 60));
            const { focusInfo } = await import('../runtime/browser-verify.mjs');
            const f = await focusInfo(b).catch(() => null);
            return json(res, 200, { ok: true, url: b.url, editable: Boolean(f?.editable), field: f?.editable ? f.desc : '' });
          }
          break;
        }
        case 'move':
          await b.hoverCoord(x, y, 'user');
          break;
        case 'wheel':
          await b.wheel(x, y, Number(body.deltaY) || 0, Number(body.deltaX) || 0);
          break;
        case 'key':
          await b.pressKey(String(body.key || ''));
          break;
        case 'text':
          await b.typeText(String(body.text ?? ''));
          break;
        default:
          return json(res, 400, { error: 'bad input type' });
      }
      json(res, 200, { ok: true, url: b.url });
    } catch (e) { fail(res, e); }
  });

  router.on('POST', '/api/claude/browser/resize', async (req, res) => {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const g = dockCtx(req, res, body.ws, { shell: true });
    if (!g) return;
    const svc = await import('../runtime/claude-browser.mjs');
    const b = svc.existingBrowser(g.ref);
    if (!b) return json(res, 409, { error: '浏览器未启动' });
    // 参数与 agent 的 resize 完全同一套（preset / width+height / landscape / mobile / scheme / dpr），
    // 什么都不给 = 查询当前视口（现测）。返回 viewportReport()：期望 + 仿真旗标 + 页面实测。
    try {
      let spec;
      try { spec = svc.resolveViewportSpec(body, b); } catch (e) { return json(res, 400, { error: String(e?.message || e) }); }
      if (!spec) { b.measured = await b.measure(); return json(res, 200, { ok: true, ...b.viewportReport() }); }
      const r = await b.setViewport(spec.width, spec.height, spec);
      json(res, 200, { ok: true, ...r });
    } catch (e) { fail(res, e); }
  });

  router.on('POST', '/api/claude/browser/close', async (req, res) => {
    let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'bad json' }); }
    const g = dockCtx(req, res, body.ws, { shell: true });
    if (!g) return;
    const svc = await import('../runtime/claude-browser.mjs');
    svc.closeBrowser(g.ref);
    json(res, 200, { ok: true });
  });
}
