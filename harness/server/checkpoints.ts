import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseSessionRecord, sessionsDir, saveSession, unsupportedVersionMessage, type PersistedSession } from "./store.ts";
import { IGNORE_DIRS } from "./tools/walk.ts";
import { isSecretPath } from "./sandbox.ts";
import { GIT_DIFF_NO_EXTERNAL, helperEnv, helperGitArgs } from "./helper-proc.ts";
import { atomicWriteFile } from "./atomic-write.ts";
import type { Msg } from "./agent/turn.ts";

// Checkpoint/rollback: a SHADOW git repo (git-dir under SESSIONS_DIR, work-tree
// = the workspace) snapshots the files, and a copy of the session record (the L
// batch's persistence format) snapshots the conversation — one checkpoint binds
// both. The project's own .git is never touched (and excluded from snapshots:
// rollback restores working files, it does not time-travel the user's repo
// internals). Restore uses plumbing — read-tree + checkout-index + clean —
// instead of `checkout <ref> -- .`, because the latter leaves files created
// AFTER the checkpoint behind (they stay tracked in the index, so clean skips
// them); after read-tree they become untracked and clean removes them.
// gitignored paths (node_modules, build output) are neither snapshotted nor
// deleted on rollback — regenerable by design.

export interface CheckpointMeta {
  n: number;
  hash: string;
  tree: string;
  at: number;
  // The user message this checkpoint precedes ("roll back to before this").
  label: string;
  // P9（K22）：这一轮跑完时的文件快照树。agent 在这一轮里的改动 = diff(tree, endTree)；两轮之间别人（手改、别的对话）
  // 的改动不在任何一轮的差集里——回滚前据此把「外部改动」单列出来。旧记录没有这个字段。
  endTree?: string;
  // N26（HT3）：轮内快照（破坏性命令前拍的）：只有文件、没有会话记录副本，回滚到它只还原文件、对话不动。
  // run = 它所在那一轮开跑时的检查点号。
  kind?: "files";
  run?: number;
  // U9：拍的时候记录里有几条消息——「从这里改写」找「这条消息之前」那张检查点时先按它筛，不用把每份记录副本都读一遍。
  // 旧记录没有这个字段。
  msgs?: number;
}

interface CheckpointIndex {
  v: 1;
  entries: CheckpointMeta[];
}

const DIFF_CAP = 60_000;

// 影子仓库【按会话数】保留：只留最近 N 个有检查点的会话，更早的连 ref、记录副本和
// 索引一起删，然后 gc 把变成垃圾的对象收走。
//
// 为什么非做不可：这个仓库是所有会话共用的，而且全程只用 plumbing（commit-tree /
// update-ref / read-tree）操作——git 的 auto-gc 只在 commit/merge 这类瓷器命令之后
// 触发，所以它【永远不会自己跑一次 gc】。体检时实测：74 个检查点撑着 16051 个松散
// 对象共 1.23GiB，加上 1.66GiB 的 pack，整个目录 2.9GB，而且只涨不落；松散对象越多，
// 每一次 `git add -A` 也越慢。
//
// 上限每次调用现读环境变量，而不是模块加载时定死一个常量——运维想临时收紧不必重启，
// 测试也才拿得到一个能改的旋钮。
function maxCheckpointSessions(): number {
  const n = Number(process.env.CHECKPOINT_MAX_SESSIONS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 30;
}
// 保留是个慢变量，不必每轮都查。两次自动 sweep 之间至少隔这么久——每条消息都去扫一遍
// 目录、再 spawn 一次 git 查孤儿 ref，纯属白烧。显式调用 sweepCheckpoints() 不受此限。
const SWEEP_MIN_INTERVAL_MS = 10 * 60 * 1000;
// gc 至少间隔这么久跑一次，别让连续几轮删除各触发一次全量打包。
const GC_MIN_INTERVAL_MS = 60 * 60 * 1000;
// prune 留一小时宽限：gc 刻意【不】进 enqueue 串行链（否则一次全量打包会把用户这一轮
// 卡住），宽限期保证同时在写的快照对象绝不会被当成垃圾收走。
const GC_PRUNE_GRACE = "1.hour.ago";

function shadowDir(): string {
  return path.join(sessionsDir(), "shadow.git");
}
function cpDir(): string {
  return path.join(sessionsDir(), "checkpoints");
}
function indexFile(sessionId: string): string {
  return path.join(cpDir(), `${sessionId}.index.json`);
}
function recordFile(sessionId: string, n: number): string {
  return path.join(cpDir(), `${sessionId}.${n}.json`);
}

// ── git plumbing ──────────────────────────────────────────────────────────────

// S7（#55）：影子仓库的 git 以前拿完整 process.env（全部 provider key），而且会照跑
// shadow.git/hooks 与 config 里的 fsmonitor。现在 env 去敏、hooks/fsmonitor 关掉（helper-proc.ts）；
// 身份靠影子仓库自己 config 里的 user.name，所以保留真实 HOME，不换成 childEnv。

// One promise chain serializes every shadow-git operation: they share a single
// index file, and concurrent runs would trip over index.lock.
let chain: Promise<unknown> = Promise.resolve();
function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn, fn);
  chain = p.then(
    () => undefined,
    () => undefined,
  );
  return p;
}

function git(args: string[], work: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...helperGitArgs(), `--git-dir=${shadowDir()}`, `--work-tree=${work}`, ...args], {
      cwd: work, // pathspec semantics: always run from inside the work tree
      windowsHide: true,
      env: helperEnv(),
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (err += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

// 仓库级维护命令（for-each-ref / update-ref -d / gc / config）——它们【不碰工作树】，
// 但仍然必须显式给一个 --work-tree，而且【不设 cwd】：
//   · 不设 cwd：--git-dir 是绝对路径，cwd 对这些命令毫无意义，而随手指一个目录当 cwd
//     就等于让子进程在整个执行期间攥住它——Windows 下那个目录删不动也移不走。
//   · 仍传 --work-tree：非裸仓库若 config 里烙着一个【已经不存在】的 core.worktree，
//     git 会在解析仓库时就 `fatal: Invalid path …` 直接退出，命令根本轮不到执行。生产
//     上真出现过（config 里写着一个早已被搬走的 <旧目录>/workspace），
//     实测连用来修它的 `config --unset core.worktree` 自己都起不来。命令行上的
//     --work-tree 覆盖 config，鸡生蛋的死结就此解开；指向 sessions 目录即可，反正不碰。
function gitRepo(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", [...helperGitArgs(), `--git-dir=${shadowDir()}`, `--work-tree=${sessionsDir()}`, ...args], {
      windowsHide: true,
      env: helperEnv(),
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (b: Buffer) => (out += b.toString()));
    child.stderr.on("data", (b: Buffer) => (err += b.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out: out.trim(), err: err.trim() }));
  });
}

async function gitOrThrow(args: string[], work: string): Promise<string> {
  const r = await git(args, work);
  if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${r.err || r.out}`);
  return r.out;
}

// 已经初始化好的影子仓库路径。存路径而不是一个全局布尔：SESSIONS_DIR 一变（测试会变，
// 运维搬数据目录也会变），旧的「就绪」结论就不作数了——原来那个布尔会让后续所有命令
// 打在一个根本没建起来的仓库上，而且悄无声息。
let readyFor: string | null = null;
// 探测失败（没装 git、init 失败）→ 本进程不再重试，跑动的轮绝不能卡在这上面。
let gitBroken = false;

function enabled(): boolean {
  return process.env.CHECKPOINTS !== "off" && !gitBroken;
}

// info/exclude 的唯一写入口：固定部分（安全 + 可再生目录）+ 动态部分（体积超限的
// 单个文件，见 excludeOversized）。每次都整份重写，所以两边任何一边变了都能生效。
async function writeExcludes(): Promise<void> {
  const lines = [
    ".git/",
    ...[...IGNORE_DIRS].map((n) => `${n}/`),
    "*.egg-info/",
    // 下载来的 SDK / 模拟器镜像：动辄几个 G 且完全可再生。生产上正是
    // .sdk/system-images/.../system.img（1.78GB）把影子仓库撑坏的。
    ".sdk/",
    // U4（K08）：会话附件归会话管（随会话删除回收），不进工作区的检查点——回滚也不该动它们
    ".dimensio/uploads/",
    // Q13：诊断包同理（随会话删除回收）
    ".dimensio/diagnostics/",
    // O5：Workflow 脚本草稿（模型改了重交用的草稿，不是项目内容）
    ".dimensio/workflows/",
    "*.img",
    "*.iso",
    "*.vmdk",
    "*.qcow2",
    ".env",
    ".env.*",
    ".ssh/",
    ".aws/",
    ".gnupg/",
    ".git-credentials",
    ".netrc",
    ".npmrc",
    "credentials.json",
    "id_rsa",
    "id_ed25519",
    "*.pem",
    "*.key",
    ...(await readOversized()).map((rel) => "/" + rel),
  ];
  await fs.mkdir(path.join(shadowDir(), "info"), { recursive: true });
  await fs.writeFile(path.join(shadowDir(), "info", "exclude"), lines.join("\n") + "\n", "utf8");
}

async function ensureRepo(work: string): Promise<boolean> {
  if (!enabled()) return false;
  if (readyFor === shadowDir()) return true;
  try {
    await fs.mkdir(cpDir(), { recursive: true });
    const d = shadowDir();
    const initialized = await fs.access(path.join(d, "HEAD")).then(
      () => true,
      () => false,
    );
    if (!initialized) {
      await fs.mkdir(work, { recursive: true });
      await fs.mkdir(d, { recursive: true });
      await gitOrThrow(["init", "-q"], work);
      await gitOrThrow(["config", "core.bare", "false"], work);
      // Byte-exact restores: never rewrite line endings.
      await gitOrThrow(["config", "core.autocrlf", "false"], work);
      await gitOrThrow(["config", "core.longpaths", "true"], work);
      // commit-tree needs an identity; don't depend on the machine's git config.
      await gitOrThrow(["config", "user.name", "harness-checkpoints"], work);
      await gitOrThrow(["config", "user.email", "checkpoints@harness.local"], work);
    }
    // Apply on every startup, not only initial creation: security exclusions
    // must reach shadow repos created by older versions too. Project .gitignore
    // rules apply on top, but credentials never depend on a project's hygiene.
    await writeExcludes();
    // 旧仓库的 config 里烙着建库那天的 core.worktree 绝对路径（体检时见过写着一个
    // 早已不存在的 `<旧目录>/workspace`）。本模块每条命令都显式
    // 传 --work-tree，所以运行时不受影响；但任何不带 --work-tree 的命令——包括我们自己
    // 要跑的 `git gc`——会直接 fatal 在那个死路径上。清掉它。
    await gitRepo(["config", "--unset", "core.worktree"]);
    readyFor = shadowDir();
    return true;
  } catch (e) {
    gitBroken = true;
    console.error(`[checkpoints] disabled: ${(e as Error).message}`);
    return false;
  }
}

async function removeSecretsFromIndex(work: string): Promise<void> {
  const staged = (await gitOrThrow(["ls-files", "-z"], work)).split("\0").filter(Boolean);
  for (const secret of staged.filter(isSecretPath)) {
    await gitOrThrow(["rm", "--cached", "--ignore-unmatch", "--", secret], work);
  }
}

// 超大文件既不该进快照，也【绝不能】只从索引里摘掉了事：rollback 的最后一步是
// `git clean -fdq`，未跟踪文件会被删——那等于回滚一次就把用户几个 G 的 SDK 镜像
// 干掉了。正确做法是把它们写进 info/exclude 变成「被忽略」：既不快照也不删除，
// 与 node_modules / 构建产物同一套「可再生」语义。
//
// 这条守卫是有来历的：生产影子仓库体检时是 2.9GB，其中 1.78GB 是一整个
// `.sdk/system-images/android-36/google_apis/x86_64/system.img`（某次做安卓 app 时
// 下到工作空间里的模拟器镜像）被 `git add -A` 整个吞了进去，而且那个 pack 已经
// 从第 12 字节起就损坏、连 `git gc` 都跑不动。按会话数保留只能限制【条数】，
// 限不住【单个文件多大】——两道一起上才真的封得住磁盘。
function maxBlobBytes(): number {
  const mb = Number(process.env.CHECKPOINT_MAX_FILE_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : 50) * 1024 * 1024;
}

const oversizedFile = () => path.join(cpDir(), "oversized.json");

async function readOversized(): Promise<string[]> {
  try {
    const raw = JSON.parse(await fs.readFile(oversizedFile(), "utf8")) as unknown;
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// 已入索引的条目里挑出超限的：踢出索引 + 记进忽略名单 + 立刻写进 info/exclude，
// 下一次 `git add -A` 就根本不会再碰它。
async function excludeOversized(work: string): Promise<void> {
  const cap = maxBlobBytes();
  const staged = (await gitOrThrow(["ls-files", "-z"], work)).split("\0").filter(Boolean);
  const found: string[] = [];
  await Promise.all(
    staged.map(async (rel) => {
      try {
        const st = await fs.stat(path.join(work, rel));
        if (st.isFile() && st.size > cap) found.push(rel);
      } catch {
        /* 刚被删掉之类，交给 git 自己处理 */
      }
    }),
  );
  if (!found.length) return;
  for (const rel of found) {
    await gitOrThrow(["rm", "--cached", "--ignore-unmatch", "--", rel], work);
  }
  const known = new Set(await readOversized());
  const before = known.size;
  for (const rel of found) known.add(rel);
  if (known.size !== before) {
    await atomicWriteFile(oversizedFile(), JSON.stringify([...known], null, 2));
    await writeExcludes();
    console.log(
      `[checkpoints] 超过 ${Math.round(cap / 1024 / 1024)}MB，不再纳入快照（也不会被回滚删除）：${found.join(", ")}`,
    );
  }
}

async function stageSafeWorkspace(work: string): Promise<void> {
  await gitOrThrow(["read-tree", "--empty"], work);
  await gitOrThrow(["add", "-A"], work);
  await removeSecretsFromIndex(work);
  await excludeOversized(work);
}

// ── index bookkeeping ─────────────────────────────────────────────────────────

async function readIndex(sessionId: string): Promise<CheckpointIndex> {
  const file = indexFile(sessionId);
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") console.error(`[checkpoints] ${sessionId}: index cannot be read (${code ?? "?"}): ${(e as Error).message}`);
    return { v: 1, entries: [] };
  }
  try {
    const idx = JSON.parse(raw) as CheckpointIndex;
    if (idx?.v === 1 && Array.isArray(idx.entries)) return idx;
  } catch {
    /* 坏了：下面隔离 */
  }
  // Q14（F6）：索引坏了（或是认不得的形状）。以前悄悄当成空的——下一次拍检查点就把它整个覆盖，这个会话的回滚历史从此
  // 没了、连证据都不剩。现在先把原文件原样挪成 .corrupt-<时间>（留证、可以手工救；更新版本写的索引降级时也不会丢），
  // 记一条日志，再从空索引起步。
  const quarantined = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    await fs.rename(file, quarantined);
    console.error(`[checkpoints] ${sessionId}: index is corrupt or unrecognized; kept as ${path.basename(quarantined)}, starting a fresh index`);
  } catch (e) {
    console.error(`[checkpoints] ${sessionId}: index is corrupt and could not be set aside: ${(e as Error).message}`);
  }
  return { v: 1, entries: [] };
}

async function writeIndex(sessionId: string, idx: CheckpointIndex): Promise<void> {
  await atomicWriteFile(indexFile(sessionId), JSON.stringify(idx)); // M6：唯一临时名 + 串行 + fsync
}

// ── public API ────────────────────────────────────────────────────────────────

// Snapshot files + conversation. `rec` must be the session record BEFORE the
// new user message is appended ("roll back to before this message"). Never
// throws — a checkpoint failure must not block the run.
export async function takeCheckpoint(
  rec: PersistedSession,
  work: string,
  label: string,
): Promise<CheckpointMeta | null> {
  if (!(await ensureRepo(work))) return null;
  try {
    return await enqueue(async () => {
      // The shadow repo is shared by sessions/workspaces. Build each snapshot
      // from an empty index so a credential tracked by an older snapshot cannot
      // survive merely because it is ignored now (and so workspace A never
      // leaks index entries into workspace B).
      await stageSafeWorkspace(work);
      const tree = await gitOrThrow(["write-tree"], work);

      const idx = await readIndex(rec.id);
      const last = idx.entries[idx.entries.length - 1];
      let hash: string;
      if (last && last.tree === tree) {
        // Files unchanged since the last checkpoint (chat-only run): reuse the
        // commit, still record a new entry — the conversation state differs.
        hash = last.hash;
      } else {
        const args = ["commit-tree", tree, "-m", label || "checkpoint"];
        if (last) args.push("-p", last.hash);
        hash = await gitOrThrow(args, work);
      }

      const n = (last?.n ?? 0) + 1;
      // A ref per checkpoint keeps every snapshot reachable regardless of
      // rollback order (this is what makes redo work), until deleted.
      await gitOrThrow(["update-ref", `refs/cp/${rec.id}/${n}`, hash], work);
      await atomicWriteFile(recordFile(rec.id, n), JSON.stringify(rec)); // M6：会话损坏时靠它恢复，写一半不行

      const meta: CheckpointMeta = { n, hash, tree, at: Date.now(), label: label.slice(0, 60), msgs: rec.messages.length };
      idx.entries.push(meta);
      await writeIndex(rec.id, idx);
      // 保留策略【游离】跑：不 await——一次全量 gc 可能要几十秒，绝不能让用户
      // 这一轮在这儿等。失败了也只是这次没清成，下一轮再来。
      void autoSweep(work);
      return meta;
    });
  } catch (e) {
    console.error(`[checkpoints] snapshot failed: ${(e as Error).message}`);
    return null;
  }
}

// N26（HT3）：轮内快照——破坏性命令（删文件、git reset --hard / checkout -- / clean -f / restore / stash）执行前，
// 给工作区拍一张只有文件的快照，这一轮前面的改动不会因为一条命令就再也找不回来。没有会话记录副本：回滚到它只还原
// 文件、对话不动。和上一张（开跑时的检查点、或上一张轮内快照）比没有新内容要护——只删了东西、或什么都没变——就不记。
// 永不抛：拍不成不拦命令。
export async function takeFilesSnapshot(
  sessionId: string,
  work: string,
  label: string,
  run: number,
): Promise<CheckpointMeta | null> {
  if (!(await ensureRepo(work))) return null;
  try {
    return await enqueue(async () => {
      await stageSafeWorkspace(work);
      const tree = await gitOrThrow(["write-tree"], work);
      const idx = await readIndex(sessionId);
      const last = idx.entries[idx.entries.length - 1];
      if (last) {
        const fresh = await gitOrThrow(["diff-tree", "-r", "--name-only", "--no-renames", "--diff-filter=AMT", last.tree, tree], work);
        if (!fresh) return null;
      }
      const args = ["commit-tree", tree, "-m", label || "files snapshot"];
      if (last) args.push("-p", last.hash);
      const hash = await gitOrThrow(args, work);
      const n = (last?.n ?? 0) + 1;
      await gitOrThrow(["update-ref", `refs/cp/${sessionId}/${n}`, hash], work);
      const meta: CheckpointMeta = { n, hash, tree, at: Date.now(), label: label.slice(0, 60), kind: "files", run };
      idx.entries.push(meta);
      await writeIndex(sessionId, idx);
      return meta;
    });
  } catch (e) {
    console.error(`[checkpoints] files snapshot failed: ${(e as Error).message}`);
    return null;
  }
}

export async function listCheckpoints(sessionId: string): Promise<CheckpointMeta[]> {
  return (await readIndex(sessionId)).entries;
}

// Restore files + overwrite the session file on disk with the checkpoint's
// record copy. The caller drops the in-memory session; the next access resumes
// from the restored file (the L-batch path does all hydration/healing).
export async function rollbackTo(
  sessionId: string,
  n: number,
  work: string,
): Promise<PersistedSession | null> {
  if (!(await ensureRepo(work))) throw new Error("checkpoints are disabled");
  const idx = await readIndex(sessionId);
  const entry = idx.entries.find((e) => e.n === n);
  if (!entry) throw new Error(`unknown checkpoint ${n} for session ${sessionId}`);

  // N26：轮内快照只有文件——只还原文件，对话不动
  let rec: PersistedSession | null = null;
  if (entry.kind !== "files") {
    // M7：副本同样按版本读（旧版本逐级迁移）；更新版本写的副本不能回滚到——本版本写回会抹掉它的字段。
    const parsed = parseSessionRecord(await fs.readFile(recordFile(sessionId, n), "utf8"), sessionId);
    if (parsed.kind === "unsupported-version") throw new Error(`checkpoint ${n}: ${unsupportedVersionMessage(parsed.version)}`);
    if (parsed.kind !== "ok") throw new Error(`checkpoint ${n} record is corrupt`);
    rec = parsed.rec;
  }

  await enqueue(async () => {
    // index := target tree; materialize it; then everything on disk that the
    // target doesn't know is untracked → clean removes it (gitignored survives).
    await gitOrThrow(["read-tree", entry.hash], work);
    // Old harness versions may have captured credentials. Never materialize
    // those entries during rollback; an existing ignored credential file is
    // intentionally left untouched by checkout-index/git clean.
    await removeSecretsFromIndex(work);
    await gitOrThrow(["checkout-index", "-f", "-a", "-u"], work);
    await gitOrThrow(["clean", "-fdq"], work);
  });

  if (rec) {
    rec.updatedAt = Date.now();
    await saveSession(rec);
  }
  return rec;
}

// U9：检查点 n 的会话记录副本（只读，不碰文件）。「撤销改写」拿它把对话原样换回去。
export async function checkpointRecord(sessionId: string, n: number): Promise<{ meta: CheckpointMeta; rec: PersistedSession }> {
  const idx = await readIndex(sessionId);
  const meta = idx.entries.find((e) => e.n === n);
  if (!meta || meta.kind === "files") throw new Error(`unknown checkpoint ${n} for session ${sessionId}`);
  const parsed = parseSessionRecord(await fs.readFile(recordFile(sessionId, n), "utf8"), sessionId);
  if (parsed.kind === "unsupported-version") throw new Error(`checkpoint ${n}: ${unsupportedVersionMessage(parsed.version)}`);
  if (parsed.kind !== "ok") throw new Error(`checkpoint ${n} record is corrupt`);
  return { meta, rec: parsed.rec };
}

// U9：对话退回到「保留下来的这一截」时，那一刻的检查点——记录副本里的转录正好就是这一截（开跑前拍的那张；回滚 / 改写前
// 现场那几张不算）。从新往旧找：先按消息条数筛（旧检查点没记条数的读副本核对，至多读 30 份），再核对最后一条一字不差。
// 找不到（没开检查点、那一截早被压缩过、旧副本读不了）返回 null。
export async function turnCheckpointFor(sessionId: string, kept: readonly Msg[], skipLabels: readonly string[]): Promise<CheckpointMeta | null> {
  let idx: CheckpointIndex;
  try {
    idx = await readIndex(sessionId);
  } catch {
    return null;
  }
  const lastJson = kept.length ? JSON.stringify(kept[kept.length - 1]) : "";
  let loads = 0;
  for (let i = idx.entries.length - 1; i >= 0; i--) {
    const e = idx.entries[i];
    if (e.kind === "files" || skipLabels.includes(e.label)) continue;
    if (e.msgs !== undefined && e.msgs !== kept.length) continue;
    if (e.msgs === undefined && ++loads > 30) break;
    try {
      const { rec } = await checkpointRecord(sessionId, e.n);
      if (rec.messages.length !== kept.length) continue;
      if (kept.length && JSON.stringify(rec.messages[kept.length - 1]) !== lastJson) continue;
      return e;
    } catch {
      /* 副本坏了 / 读不了：看下一张 */
    }
  }
  return null;
}

// What a rollback to checkpoint n would undo: diff from the snapshot to the
// current work tree (stat summary + capped patch).
export async function checkpointDiff(sessionId: string, n: number, work: string): Promise<string> {
  if (!(await ensureRepo(work))) throw new Error("checkpoints are disabled");
  const idx = await readIndex(sessionId);
  const entry = idx.entries.find((e) => e.n === n);
  if (!entry) throw new Error(`unknown checkpoint ${n} for session ${sessionId}`);
  return enqueue(async () => {
    // Sanitize both sides. In particular, do not reveal contents from a legacy
    // checkpoint that predates the secret exclusion policy.
    await gitOrThrow(["read-tree", entry.hash], work);
    await removeSecretsFromIndex(work);
    const safeBaseTree = await gitOrThrow(["write-tree"], work);
    await stageSafeWorkspace(work);
    const stat = await gitOrThrow(["diff", ...GIT_DIFF_NO_EXTERNAL, "--stat", safeBaseTree], work);
    const patch = await gitOrThrow(["diff", ...GIT_DIFF_NO_EXTERNAL, safeBaseTree], work);
    const body = `${stat}\n\n${patch}`;
    return body.length > DIFF_CAP ? body.slice(0, DIFF_CAP) + "\n…[diff truncated]" : body;
  });
}

// ── P9（C3、K22）：回滚前的归属校验 ─────────────────────────────────────────────
// 以前回滚无条件 checkout-index -f + clean -fdq：人在电脑前手改的文件、手建的文件、别的对话的改动会被静默覆盖或删掉。
// 现在每一轮跑完补一张文件快照（recordRunEnd），「这个对话留下的样子」就有据可查：一个要被回滚改动的文件，只有当它
// 现在的内容正是这个对话最后一次改它时留下的内容，才算这个对话的；从没被哪一轮改过、或者被改过之后又被别人动过
// （手改 agent 刚写的文件——最常见的那种），都是外部改动，单列出来、要人确认（force）才回滚。回滚前的现场照拍
// （阶段 0 的回滚可撤销），确认了也撤得回来。
// 已知边界：一轮跑着的时候别人同时改的文件，会算在那一轮头上（看不出来是谁改的）。

const nulNames = (out: string) => out.split("\0").map((p) => p.trim()).filter(Boolean);

// U10：两棵树之间差哪些文件永远不变（树是内容哈希）——记下来。审阅面板每次刷新都要对这个会话的每一段算一遍，
// 不记的话一个改过几十轮文件的会话每刷一次就是几十次 git。
const treeDiffCache = new Map<string, string[]>();
const TREE_DIFF_CACHE_MAX = 2000;

async function treeDiff(a: string, b: string, work: string): Promise<string[]> {
  if (a === b) return [];
  const key = `${a}:${b}`;
  const hit = treeDiffCache.get(key);
  if (hit) return [...hit];
  const out = nulNames(await gitOrThrow(["diff-tree", "-r", "--name-only", "-z", "--no-renames", a, b], work));
  if (treeDiffCache.size >= TREE_DIFF_CACHE_MAX) treeDiffCache.delete(treeDiffCache.keys().next().value!);
  treeDiffCache.set(key, out);
  return [...out];
}

// 每个文件最后一次被这个对话改动之后应有的样子（那一段结束时的快照）：从第 from 张检查点数起。
// 调用方要在检查点串行队列里调（排在收尾补的结束快照后面）。
async function lastEndsFrom(idx: CheckpointIndex, from: number, now: string, work: string): Promise<Map<string, string>> {
  const nextRunTree = (k: number) => idx.entries.slice(k + 1).find((e) => e.kind !== "files")?.tree;
  const lastEnd = new Map<string, string>();
  for (let k = from; k < idx.entries.length; k++) {
    const entry = idx.entries[k];
    // N26：轮内快照这一段算到它所在那一轮收尾为止
    const owner = entry.kind === "files" ? idx.entries.find((e) => e.n === entry.run) : entry;
    // 没有结束快照的（这个版本之前的记录、中途崩掉的一轮）：退回用下一轮的检查点、最后一个就用现在——那段时间的
    // 改动都算这个对话的，与以前不做校验一样宽，不凭空冒出一堆假的「外部改动」
    const end = owner?.endTree ?? nextRunTree(k) ?? now;
    for (const p of await treeDiff(entry.tree, end, work)) lastEnd.set(p, end);
  }
  return lastEnd;
}

// 这些文件里，现在的内容不是这个对话留下的：从没被它改过，或者它改完之后又被别人动过
async function externalAmong(paths: readonly string[], lastEnd: Map<string, string>, now: string, work: string): Promise<Set<string>> {
  const external = new Set<string>();
  const byEnd = new Map<string, string[]>();
  for (const p of paths) {
    const end = lastEnd.get(p);
    if (!end) external.add(p); // 这个对话从没改过它
    else if (end !== now) byEnd.set(end, [...(byEnd.get(end) ?? []), p]);
  }
  for (const [end, ps] of byEnd) {
    const since = new Set(await treeDiff(end, now, work));
    for (const p of ps) if (since.has(p)) external.add(p); // 这个对话改完之后又被别人动过
  }
  return external;
}

// 给检查点 n 补上「这一段操作结束时」的文件快照：一轮跑完（收尾时）、一次回滚做完（给「回滚前现场」补——回滚自己的
// 改动也记在这个对话名下，撤销回滚才不会被当成外部改动拦下）。同步排进检查点的串行队列（排在之后任何回滚 / 预览前面，
// 它们拿到的一定是补过的记录）。永不抛——拍不成只是那一段的改动归属退回旧做法（不校验）。
export function recordRunEnd(sessionId: string, work: string, n: number): Promise<void> {
  if (!enabled()) return Promise.resolve();
  return enqueue(async () => {
    if (!(await ensureRepo(work))) return;
    await stageSafeWorkspace(work);
    const tree = await gitOrThrow(["write-tree"], work);
    const idx = await readIndex(sessionId);
    const entry = idx.entries.find((e) => e.n === n);
    if (!entry) return;
    entry.endTree = tree;
    await writeIndex(sessionId, idx);
  }).catch((e) => {
    console.error(`[checkpoints] run-end snapshot failed: ${(e as Error).message}`);
  });
}

export interface RollbackPlan {
  // 回滚会改动的文件（工作区相对路径，正斜杠）
  changes: string[];
  // 其中现在的内容不是这个对话留下的：回滚会覆盖 / 删掉别人的改动
  external: string[];
}

export async function rollbackPlan(sessionId: string, n: number, work: string): Promise<RollbackPlan> {
  if (!(await ensureRepo(work))) throw new Error("checkpoints are disabled");
  return enqueue(async () => {
    const idx = await readIndex(sessionId);
    const pos = idx.entries.findIndex((e) => e.n === n);
    if (pos < 0) throw new Error(`unknown checkpoint ${n} for session ${sessionId}`);
    // 目标一侧照回滚的做法消毒：旧快照里的凭据回滚不会写回，也就不算它要动的文件
    await gitOrThrow(["read-tree", idx.entries[pos].hash], work);
    await removeSecretsFromIndex(work);
    const target = await gitOrThrow(["write-tree"], work);
    await stageSafeWorkspace(work);
    const now = await gitOrThrow(["write-tree"], work);
    const changes = await treeDiff(target, now, work);
    if (!changes.length) return { changes, external: [] };
    const external = await externalAmong(changes, await lastEndsFrom(idx, pos, now, work), now, work);
    return { changes, external: changes.filter((p) => external.has(p)) };
  });
}

// ── U10（K38）：审阅面板的「本会话」基线 + 逐文件撤销 ─────────────────────────────────────────
// 以前审阅面板只有「项目 git 基线」：人手改的和 agent 改的混在一起，非 git 的工作区（快照对话桶、临时目录）什么都看不到；
// 要退回只能整树回滚。影子仓库里本来就有「这个会话第一条消息之前」的完整快照——拿它当基线：
//   · 列表 = 从基线到现在有差异、又是这个对话某一段改过的文件（人手改的、别的对话改的不列，只报个数）；
//   · 每个文件带归属：现在的内容正是这个对话最后一次改它时留下的才算它的，改完之后又被别人动过的标 external（P9 同一套判法）；
//   · 逐文件撤销 = 退回基线：基线里有的写回原内容，没有的（这个对话新建的）删掉。调用方（session.ts）负责不在跑、归属确认、
//     先拍现场。
// 基线是会话的第一张检查点：没开检查点的、检查点被保留策略清掉的老会话（只留最近 30 个会话的）没有这个视图。

export interface SessionChange {
  path: string;
  st: "A" | "M" | "D"; // 相对基线：这个对话新建的 / 改的 / 删的
  add: number;
  del: number;
  bin: boolean;
  external: boolean; // 现在的内容不是这个对话留下的（它改完之后又被别人动过）
}
export interface SessionChangeList {
  since: number; // 基线拍下的时刻
  files: SessionChange[];
  others: number; // 这段时间里对话之外改过、这个对话没碰过的文件数（不列）
}

// 检查点的文件树，按回滚的规矩消毒：旧快照里若有凭据，不算、不显示、不写回
async function safeTreeOf(hash: string, work: string): Promise<string> {
  await gitOrThrow(["read-tree", hash], work);
  await removeSecretsFromIndex(work);
  return gitOrThrow(["write-tree"], work);
}

type Stat = { st: SessionChange["st"]; add: number; del: number; bin: boolean };
async function treeStats(a: string, b: string, work: string): Promise<Map<string, Stat>> {
  const out = new Map<string, Stat>();
  const status = (await gitOrThrow(["diff-tree", "-r", "--name-status", "-z", "--no-renames", a, b], work)).split("\0");
  for (let i = 0; i + 1 < status.length; i += 2) {
    const letter = status[i].trim();
    const rel = status[i + 1];
    if (rel) out.set(rel, { st: letter === "A" ? "A" : letter === "D" ? "D" : "M", add: 0, del: 0, bin: false });
  }
  for (const row of (await gitOrThrow(["diff-tree", "-r", "--numstat", "-z", "--no-renames", a, b], work)).split("\0")) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(row.trim());
    const e = m ? out.get(m[3]) : undefined;
    if (!m || !e) continue;
    e.bin = m[1] === "-";
    e.add = e.bin ? 0 : Number(m[1]);
    e.del = e.bin ? 0 : Number(m[2]);
  }
  return out;
}

export async function sessionChangeList(sessionId: string, work: string): Promise<SessionChangeList | null> {
  if (!(await ensureRepo(work))) return null;
  return enqueue(async () => {
    // 索引在队列里读：排在收尾补的结束快照后面
    const idx = await readIndex(sessionId);
    const base = idx.entries[0];
    if (!base) return null;
    const baseTree = await safeTreeOf(base.hash, work);
    await stageSafeWorkspace(work);
    const now = await gitOrThrow(["write-tree"], work);
    const changed = await treeDiff(baseTree, now, work);
    const lastEnd = await lastEndsFrom(idx, 0, now, work);
    const mine = changed.filter((p) => lastEnd.has(p));
    const external = await externalAmong(mine, lastEnd, now, work);
    const stats = await treeStats(baseTree, now, work);
    const files = mine.map((p): SessionChange => ({ path: p, ...(stats.get(p) ?? { st: "M", add: 0, del: 0, bin: false }), external: external.has(p) }));
    return { since: base.at, files, others: changed.length - mine.length };
  });
}

// 工作区相对路径（正斜杠）：不许绝对路径、不许 .. 越界、不碰凭据文件
export function reviewablePath(rel: string): boolean {
  if (!rel || rel.includes("\0") || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return false;
  if (rel.split(/[\\/]/).some((seg) => seg === "..")) return false;
  return !isSecretPath(rel);
}

const FILE_DIFF_CAP = 1024 * 1024;

// 单个文件从基线到现在的 unified diff（审阅面板点开时懒加载）
export async function sessionFileDiff(sessionId: string, work: string, rel: string): Promise<{ diff: string; truncated: boolean; bin: boolean } | null> {
  if (!reviewablePath(rel)) throw new Error(`not a reviewable path: ${rel}`);
  if (!(await ensureRepo(work))) return null;
  return enqueue(async () => {
    const base = (await readIndex(sessionId)).entries[0];
    if (!base) return null;
    const baseTree = await safeTreeOf(base.hash, work);
    await stageSafeWorkspace(work);
    let diff = await gitOrThrow(["diff", ...GIT_DIFF_NO_EXTERNAL, "--cached", "--unified=3", "--no-renames", baseTree, "--", `:(literal)${rel}`], work);
    let truncated = false;
    if (diff.length > FILE_DIFF_CAP) {
      diff = diff.slice(0, FILE_DIFF_CAP);
      const cut = diff.lastIndexOf("\n");
      if (cut > 0) diff = diff.slice(0, cut);
      truncated = true;
    }
    return { diff, truncated, bin: /^Binary files /m.test(diff) };
  });
}

// 把这些文件退回基线：基线里有的写回原内容，没有的（这个对话新建的）删掉，并收掉因此空了、基线里本来也没有的上级目录。
// 凭据文件永远不写回（旧快照里若有，读出来就摘掉）。
export async function restoreFromBaseline(sessionId: string, work: string, paths: readonly string[]): Promise<{ restored: string[]; removed: string[] }> {
  const bad = paths.filter((p) => !reviewablePath(p));
  if (bad.length) throw new Error(`not reviewable paths: ${bad.join(", ")}`);
  if (!(await ensureRepo(work))) throw new Error("checkpoints are disabled");
  return enqueue(async () => {
    const base = (await readIndex(sessionId)).entries[0];
    if (!base) throw new Error(`no checkpoints for session ${sessionId}`);
    await gitOrThrow(["read-tree", base.hash], work);
    await removeSecretsFromIndex(work);
    const inBase = new Set(nulNames(await gitOrThrow(["ls-files", "-z"], work)));
    const restored = paths.filter((p) => inBase.has(p));
    const removed = paths.filter((p) => !inBase.has(p));
    // checkout-index 收的是字面路径（不是 pathspec）；分批，免得 Windows 命令行超长
    for (let i = 0; i < restored.length; i += 100) {
      await gitOrThrow(["checkout-index", "-f", "-u", "--", ...restored.slice(i, i + 100)], work);
    }
    const baseDirs = new Set<string>();
    for (const p of inBase) for (let d = path.posix.dirname(p); d && d !== "."; d = path.posix.dirname(d)) baseDirs.add(d);
    for (const rel of removed) {
      await fs.rm(path.join(work, rel), { force: true });
      for (let d = path.posix.dirname(rel); d && d !== "." && !baseDirs.has(d); d = path.posix.dirname(d)) {
        try {
          await fs.rmdir(path.join(work, d)); // 只收空目录：不空、不存在就到此为止
        } catch {
          break;
        }
      }
    }
    return { restored, removed };
  });
}

// V5（#20）：从某个快照树到现在的工作区，改了哪些文件（工作区相对路径，正斜杠）。验证门禁用它认出 Bash、coder 子 agent、
// Workflow、脚本生成的改动；两边都按同一套规矩消毒（凭据、超大文件不进索引），比得上。拿不到返回空数组。
//
// skipNestedRepos：工作区里 git clone 下来的仓库，`add -A` 只记成一个 gitlink 条目（模式 160000，路径就是那个目录名、
// 没有后缀），门禁会把它当成「改了代码」，把只读分析的答复撤回去逼它验证（实例：分析一个刚 clone 下来的仓库，
// 六千字分析被撤回、用户什么都没看到）。gitlink 只记嵌套仓库的 HEAD，里面的文件改没改它看不见，对门禁没有信息量——
// 门禁跳过它；回退提示照旧列出（「这个目录是这一轮新出现的」对用户有用）。
export async function changedPathsSince(tree: string, work: string, opts: { skipNestedRepos?: boolean } = {}): Promise<string[]> {
  try {
    if (!(await ensureRepo(work))) return [];
    return await enqueue(async () => {
      await stageSafeWorkspace(work);
      if (!opts.skipNestedRepos) {
        const out = await gitOrThrow(["diff-index", "--cached", "--name-only", "-z", "--no-renames", tree], work);
        return out.split("\0").map((p) => p.trim()).filter(Boolean);
      }
      // --raw -z：每条是 ":旧模式 新模式 旧sha 新sha 状态\0路径\0"
      const parts = (await gitOrThrow(["diff-index", "--cached", "--raw", "-z", "--no-renames", tree], work)).split("\0");
      const out: string[] = [];
      for (let k = 0; k + 1 < parts.length; k += 2) {
        const [oldMode, newMode] = parts[k].replace(/^:/, "").split(" ");
        const p = parts[k + 1].trim();
        if (p && oldMode !== "160000" && newMode !== "160000") out.push(p);
      }
      return out;
    });
  } catch (e) {
    // Q14：验证门禁据此判「改过没有」——git 出错时照旧当没看到改动，但必须留一句（否则门禁悄悄变弱没人知道）
    console.error(`[checkpoints] changed-paths check failed in ${work}: ${(e as Error).message}`);
    return [];
  }
}

// R6（#32）：进程在工具执行中途死掉后恢复时，告诉模型「这一轮开始以来工作区改了什么」——这个会话
// 最新检查点（每轮开跑前拍的）到现在的 diff --stat。拿不到（没开检查点、没有记录、git 出错）返回空串。
const DIFFSTAT_CAP = 4_000;
export async function latestCheckpointDiffStat(sessionId: string, work: string): Promise<string> {
  try {
    if (!(await ensureRepo(work))) return "";
    // 从这一轮开跑时的检查点量（N26 的轮内快照不算「这一轮开始」）
    const last = (await readIndex(sessionId)).entries.filter((e) => e.kind !== "files").at(-1);
    if (!last) return "";
    return await enqueue(async () => {
      await gitOrThrow(["read-tree", last.hash], work);
      await removeSecretsFromIndex(work);
      const base = await gitOrThrow(["write-tree"], work);
      await stageSafeWorkspace(work);
      const stat = await gitOrThrow(["diff", ...GIT_DIFF_NO_EXTERNAL, "--stat", base], work);
      return stat.length > DIFFSTAT_CAP ? stat.slice(0, DIFFSTAT_CAP) + "\n…[diffstat truncated]" : stat;
    });
  } catch (e) {
    console.error(`[checkpoints] ${sessionId}: diffstat since the run start failed: ${(e as Error).message}`); // Q14
    return "";
  }
}

// ── 保留策略（按会话数）+ gc ───────────────────────────────────────────────────

let sweeping = false;
let lastGcAt = 0;
let lastSweepAt = 0;

// takeCheckpoint 之后的自动清理：带节流，且永不抛。显式的 sweepCheckpoints() 不走这条。
async function autoSweep(work: string): Promise<void> {
  if (Date.now() - lastSweepAt < SWEEP_MIN_INTERVAL_MS) return;
  lastSweepAt = Date.now();
  try {
    await sweepCheckpoints(work);
  } catch (e) {
    // 清理失败不影响任何一轮对话，下次再来——但留一句（Q14：诊断包里看得到）
    console.warn(`[checkpoints] auto sweep failed: ${(e as Error).message}`);
  }
}

// refs/cp/<sessionId>/<n> → 当前仓库里有检查点 ref 的会话 id 集合。
async function sessionsWithRefs(): Promise<Set<string>> {
  const out = await gitRepo(["for-each-ref", "--format=%(refname)", "refs/cp/"]);
  const ids = new Set<string>();
  if (out.code !== 0) return ids;
  for (const line of out.out.split("\n")) {
    const m = /^refs\/cp\/([^/]+)\//.exec(line.trim());
    if (m) ids.add(m[1]!);
  }
  return ids;
}

// 一个会话的全部 ref 直接按前缀删——不依赖索引文件还在不在，这样索引已经丢了的
// 孤儿 ref（会话删除时没清干净的残留）也收得掉。
async function dropRefsFor(sessionId: string): Promise<void> {
  const out = await gitRepo(["for-each-ref", "--format=%(refname)", `refs/cp/${sessionId}/`]);
  if (out.code !== 0 || !out.out) return;
  for (const ref of out.out.split("\n").map((l) => l.trim()).filter(Boolean)) {
    await gitRepo(["update-ref", "-d", ref]);
  }
}

async function gcShadow(): Promise<void> {
  if (Date.now() - lastGcAt < GC_MIN_INTERVAL_MS) return;
  lastGcAt = Date.now();
  const r = await gitRepo(["gc", "--quiet", `--prune=${GC_PRUNE_GRACE}`]);
  if (r.code !== 0) console.error(`[checkpoints] gc failed (${r.code}): ${r.err || r.out}`);
}

// 只留最近 MAX_CHECKPOINT_SESSIONS 个会话的检查点（按索引文件 mtime 排序），其余
// 连同孤儿 ref 一起清掉再 gc。刻意做成【游离】调用：绝不能让一次全量打包把用户
// 正在跑的那一轮卡在这里等。
// 返回值给调用方（和测试）一个确定的答复：swept=false 表示这次没跑（已有一轮在飞或
// 仓库不可用），不是「跑了但没删」。
export async function sweepCheckpoints(work: string): Promise<{ swept: boolean; dropped: string[] }> {
  const skipped = { swept: false, dropped: [] as string[] };
  if (sweeping || !(await ensureRepo(work))) return skipped;
  sweeping = true;
  try {
    let names: string[] = [];
    try {
      names = await fs.readdir(cpDir());
    } catch {
      return { swept: true, dropped: [] };
    }
    const SUFFIX = ".index.json";
    const stamped = await Promise.all(
      names
        .filter((n) => n.endsWith(SUFFIX))
        .map(async (n) => {
          let at = 0;
          try {
            at = (await fs.stat(path.join(cpDir(), n))).mtimeMs;
          } catch {
            /* 读不到就当最老 */
          }
          return { id: n.slice(0, -SUFFIX.length), at };
        }),
    );
    const limit = maxCheckpointSessions();
    stamped.sort((a, b) => b.at - a.at);
    const keep = new Set(stamped.slice(0, limit).map((s) => s.id));
    const drop = stamped.slice(limit).map((s) => s.id);

    // 索引已经没了、ref 还留着的孤儿也一并收（会话删除半途失败的残留）。
    for (const id of await sessionsWithRefs()) {
      if (!keep.has(id) && !drop.includes(id)) drop.push(id);
    }
    if (!drop.length) return { swept: true, dropped: [] };

    for (const id of drop) await deleteCheckpoints(id);
    console.log(`[checkpoints] 保留最近 ${keep.size} 个会话，清掉 ${drop.length} 个的检查点`);
    await gcShadow();
    return { swept: true, dropped: drop };
  } catch (e) {
    console.error(`[checkpoints] sweep failed: ${(e as Error).message}`);
    return skipped;
  } finally {
    sweeping = false;
  }
}

// Drop a session's checkpoints: refs (loose files under refs/cp/<id>/), the
// record copies, and the index. Snapshot objects become garbage for git gc.
export async function deleteCheckpoints(sessionId: string): Promise<void> {
  const idx = await readIndex(sessionId);
  try {
    for (const e of idx.entries) {
      await fs.unlink(recordFile(sessionId, e.n)).catch(() => {});
    }
    // ref 按前缀整批删，而不是照着索引一条条点名——索引丢了的孤儿 ref 才有人收。
    await dropRefsFor(sessionId);
    await fs.unlink(indexFile(sessionId)).catch(() => {});
  } catch (e) {
    // best-effort cleanup（Q14：失败留一句）
    console.warn(`[checkpoints] ${sessionId}: cleanup after delete failed: ${(e as Error).message}`);
  }
}
