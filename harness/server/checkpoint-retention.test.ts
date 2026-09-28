// 影子仓库的保留策略（按会话数）。
//
// 这个仓库被所有会话共用，而且全程只走 plumbing（commit-tree / update-ref / read-tree），
// 所以 git 的 auto-gc 永远不会自己触发一次。体检时那台生产机上实测：74 个检查点
// 撑着 16051 个松散对象共 1.23GiB，加 1.66GiB 的 pack，整个目录 2.9GB，只涨不落。
// 这里验证「只留最近 N 个会话 + 收孤儿 ref + 真的 gc 过」这条链。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test, { afterEach } from "node:test";
import { listCheckpoints, rollbackTo, sweepCheckpoints, takeCheckpoint } from "./checkpoints.ts";
import type { PersistedSession } from "./store.ts";

const roots: string[] = [];
function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

const BASE_SESSIONS_DIR = process.env.SESSIONS_DIR;
const BASE_MAX = process.env.CHECKPOINT_MAX_SESSIONS;
const BASE_MAX_MB = process.env.CHECKPOINT_MAX_FILE_MB;
afterEach(() => {
  if (BASE_SESSIONS_DIR === undefined) delete process.env.SESSIONS_DIR;
  else process.env.SESSIONS_DIR = BASE_SESSIONS_DIR;
  if (BASE_MAX === undefined) delete process.env.CHECKPOINT_MAX_SESSIONS;
  else process.env.CHECKPOINT_MAX_SESSIONS = BASE_MAX;
  if (BASE_MAX_MB === undefined) delete process.env.CHECKPOINT_MAX_FILE_MB;
  else process.env.CHECKPOINT_MAX_FILE_MB = BASE_MAX_MB;
  while (roots.length) fs.rmSync(roots.pop()!, { recursive: true, force: true });
});

function record(id: string, workspace: string): PersistedSession {
  return {
    v: 1,
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    title: id,
    config: {
      provider: "openai",
      model: "fake",
      thinking: "off",
      permissionMode: "auto",
      workspace,
      access: "workspace",
    },
    system: "test",
    messages: [],
    todos: [],
    totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] },
    counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
  };
}

const shadow = (sessions: string) => path.join(sessions, "shadow.git");
// 显式带 --work-tree：非裸仓库的 config 若烙着一个不存在的 core.worktree，不带它的
// 命令会在解析仓库阶段就 fatal（见下面那个用例）。
function refsIn(sessions: string): string[] {
  const r = spawnSync(
    "git",
    [`--git-dir=${shadow(sessions)}`, `--work-tree=${sessions}`, "for-each-ref", "--format=%(refname)", "refs/cp/"],
    { encoding: "utf8" },
  );
  return r.stdout.split("\n").map((l) => l.trim()).filter(Boolean);
}

// 后台可能正好有一轮 sweep 在飞（takeCheckpoint 会游离触发），重试到真的跑了一次。
async function sweepUntilRun(work: string): Promise<string[]> {
  for (let i = 0; i < 50; i++) {
    const r = await sweepCheckpoints(work);
    if (r.swept) return r.dropped;
    await new Promise((res) => setTimeout(res, 20));
  }
  throw new Error("sweep 一直没轮到");
}

test("只保留最近 N 个会话的检查点，更早的连 ref / 记录 / 索引一起清掉", async () => {
  const work = temp("dimensio-cpret-work-");
  const sessions = temp("dimensio-cpret-state-");
  process.env.SESSIONS_DIR = sessions;
  // 建的时候先把上限放宽，免得 takeCheckpoint 游离触发的 sweep 提前把人删了。
  process.env.CHECKPOINT_MAX_SESSIONS = "999";
  fs.writeFileSync(path.join(work, "a.txt"), "v0", "utf8");

  const ids = ["s1", "s2", "s3", "s4", "s5"];
  for (const [i, id] of ids.entries()) {
    fs.writeFileSync(path.join(work, "a.txt"), `v${i}`, "utf8");
    const cp = await takeCheckpoint(record(id, work), work, `turn ${id}`);
    assert.ok(cp, `${id} 应当有检查点`);
    // 索引 mtime 决定新旧，拉开间隔保证排序稳定。
    const idx = path.join(sessions, "checkpoints", `${id}.index.json`);
    fs.utimesSync(idx, new Date(), new Date(Date.now() - (ids.length - i) * 60_000));
  }
  assert.equal(refsIn(sessions).length, 5);

  process.env.CHECKPOINT_MAX_SESSIONS = "3";
  // 断言【终态】而不是某一次调用的返回值：takeCheckpoint 会游离触发 sweep，那一轮
  // 可能刚好先把活干完。sweepUntilRun 拿到 swept=true 就说明没有 sweep 在飞了，
  // 此刻的磁盘状态就是最终状态。
  await sweepUntilRun(work);

  for (const id of ["s1", "s2"]) {
    assert.equal(fs.existsSync(path.join(sessions, "checkpoints", `${id}.index.json`)), false);
    assert.equal(fs.existsSync(path.join(sessions, "checkpoints", `${id}.1.json`)), false);
    assert.ok(!refsIn(sessions).some((r) => r.startsWith(`refs/cp/${id}/`)), `${id} 的 ref 应当没了`);
  }
  for (const id of ["s3", "s4", "s5"]) {
    assert.equal(fs.existsSync(path.join(sessions, "checkpoints", `${id}.index.json`)), true);
    assert.ok(refsIn(sessions).some((r) => r.startsWith(`refs/cp/${id}/`)), `${id} 的 ref 应当还在`);
  }
});

test("保留下来的会话仍然能真的回滚（gc 没把还有人用的对象收走）", async () => {
  const work = temp("dimensio-cpkeep-work-");
  const sessions = temp("dimensio-cpkeep-state-");
  process.env.SESSIONS_DIR = sessions;
  process.env.CHECKPOINT_MAX_SESSIONS = "999";
  fs.writeFileSync(path.join(work, "a.txt"), "original", "utf8");

  const keep = record("keeper", work);
  const cp = await takeCheckpoint(keep, work, "before edit");
  assert.ok(cp);
  for (const id of ["old1", "old2", "old3"]) {
    await takeCheckpoint(record(id, work), work, "noise");
    const idx = path.join(sessions, "checkpoints", `${id}.index.json`);
    fs.utimesSync(idx, new Date(), new Date(Date.now() - 600_000));
  }

  process.env.CHECKPOINT_MAX_SESSIONS = "1";
  await sweepUntilRun(work);

  fs.writeFileSync(path.join(work, "a.txt"), "broken", "utf8");
  await rollbackTo("keeper", cp!.n, work);
  assert.equal(fs.readFileSync(path.join(work, "a.txt"), "utf8"), "original");
  assert.equal((await listCheckpoints("keeper")).length, 1);
});

test("索引没了、ref 还留着的孤儿也收得掉", async () => {
  const work = temp("dimensio-cporph-work-");
  const sessions = temp("dimensio-cporph-state-");
  process.env.SESSIONS_DIR = sessions;
  process.env.CHECKPOINT_MAX_SESSIONS = "999";
  fs.writeFileSync(path.join(work, "a.txt"), "x", "utf8");

  await takeCheckpoint(record("orphan", work), work, "will lose its index");
  await takeCheckpoint(record("alive", work), work, "stays");
  // 模拟「会话删除删了一半」：索引没了，ref 还挂着。
  fs.unlinkSync(path.join(sessions, "checkpoints", "orphan.index.json"));

  await sweepUntilRun(work);

  assert.ok(!refsIn(sessions).some((r) => r.startsWith("refs/cp/orphan/")), "孤儿 ref 应当被收掉");
  assert.ok(refsIn(sessions).some((r) => r.startsWith("refs/cp/alive/")), "正常会话不受影响");
});

test("超大文件不进快照，而且回滚不会把它删掉", async () => {
  const work = temp("dimensio-cpbig-work-");
  const sessions = temp("dimensio-cpbig-state-");
  process.env.SESSIONS_DIR = sessions;
  process.env.CHECKPOINT_MAX_SESSIONS = "999";
  process.env.CHECKPOINT_MAX_FILE_MB = "1";

  fs.writeFileSync(path.join(work, "src.txt"), "keep me", "utf8");
  fs.mkdirSync(path.join(work, "sdk"), { recursive: true });
  const huge = path.join(work, "sdk", "system.bin");
  fs.writeFileSync(huge, Buffer.alloc(2 * 1024 * 1024, 7)); // 2MB > 1MB 上限

  const cp = await takeCheckpoint(record("big", work), work, "with a huge file");
  assert.ok(cp);

  // 快照树里只有小文件，没有那个大家伙。
  const listed = spawnSync(
    "git",
    [`--git-dir=${shadow(sessions)}`, `--work-tree=${sessions}`, "ls-tree", "-r", "--name-only", cp!.hash],
    { encoding: "utf8" },
  );
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /src\.txt/);
  assert.doesNotMatch(listed.stdout, /system\.bin/);

  // 关键：回滚会跑 `git clean -fdq`。大文件必须是【被忽略】而不是【未跟踪】，
  // 否则一次回滚就把用户几个 G 的 SDK 镜像删了。
  fs.writeFileSync(path.join(work, "src.txt"), "broken", "utf8");
  await rollbackTo("big", cp!.n, work);
  assert.equal(fs.readFileSync(path.join(work, "src.txt"), "utf8"), "keep me");
  assert.equal(fs.existsSync(huge), true, "回滚绝不能删掉超限文件");
  assert.equal(fs.statSync(huge).size, 2 * 1024 * 1024);
});

test("config 里烙着一个已消失的 core.worktree 时，维护命令依然跑得动", async () => {
  const work = temp("dimensio-cpcfg-work-");
  const sessions = temp("dimensio-cpcfg-state-");
  process.env.SESSIONS_DIR = sessions;
  process.env.CHECKPOINT_MAX_SESSIONS = "999";
  fs.writeFileSync(path.join(work, "a.txt"), "x", "utf8");
  await takeCheckpoint(record("orphan", work), work, "will lose its index");
  await takeCheckpoint(record("alive", work), work, "stays");

  // 复刻生产那台机器的状态：建库那天的绝对路径还写在 config 里，而那个目录早没了。
  // 此时任何【不带 --work-tree】的 git 命令会在解析仓库阶段就 fatal——连用来修它的
  // `config --unset core.worktree` 自己都起不来，是个鸡生蛋的死结。
  // 关键要和生产同形：【中间一级】目录不存在（形如 /tmp/dimensio-gone-parent/workspace，
  // 其中 "dimensio-gone-parent" 早被搬走了）。只有叶子缺失时
  // git 不一定报错，缺中间目录才会在解析仓库阶段就 fatal。
  const dead = path.join(os.tmpdir(), "dimensio-gone-parent", "workspace").split(path.sep).join("/");
  const wrote = spawnSync(
    "git",
    [`--git-dir=${shadow(sessions)}`, `--work-tree=${sessions}`, "config", "core.worktree", dead],
    { encoding: "utf8" },
  );
  assert.equal(wrote.status, 0, wrote.stderr);
  const naive = spawnSync("git", [`--git-dir=${shadow(sessions)}`, "count-objects", "-v"], { encoding: "utf8" });
  assert.notEqual(naive.status, 0, "前提校验：不带 --work-tree 时确实起不来");
  assert.match(naive.stderr, /Invalid path/);

  // sweep 走的是显式带 --work-tree 的通道，必须照常工作——孤儿 ref 该收还得收。
  fs.unlinkSync(path.join(sessions, "checkpoints", "orphan.index.json"));
  const r = await sweepUntilRun(work);
  assert.deepEqual(r, ["orphan"]);
  assert.ok(!refsIn(sessions).some((x) => x.startsWith("refs/cp/orphan/")));
  assert.ok(refsIn(sessions).some((x) => x.startsWith("refs/cp/alive/")));
});
