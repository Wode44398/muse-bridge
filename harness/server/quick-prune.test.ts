// 快照对话清理（quick-prune.ts）：设置「清理快照对话」的三种方式、回收站到期、列表不再列出回收掉的。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { newQuickProject, quickProject, quickSessionFilter } from "./quick.ts";
import { pruneQuick, quickRetention, recycledQuickCount } from "./quick-prune.ts";
import { listSessionsPage, loadSession, saveSession, type PersistedSession } from "./store.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;

function isolate(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-quick-prune-"));
  process.env.DIMENSIO_QUICK_ROOT = path.join(root, "buckets");
  process.env.DIMENSIO_QUICK_FILE = path.join(root, "quick.json");
  return root;
}

function fakeSession(id: string, workspace: string, updatedAt: number): PersistedSession {
  return {
    v: 1,
    id,
    createdAt: updatedAt,
    updatedAt,
    title: id,
    config: { provider: "anthropic", model: "m", thinking: "off", permissionMode: "auto", workspace },
    system: "",
    messages: [],
    todos: [],
    totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] },
    counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
  };
}

// 铸一只用过的快照桶：里面一个会话、桶目录与会话都停在 ageMs 之前；随后当前快照换成新桶
async function usedBucket(tag: string, ageMs: number, now: number): Promise<{ dir: string; sid: string }> {
  const dir = quickProject()!.path;
  const sid = `qp-${tag}-${Math.random().toString(36).slice(2, 8)}`;
  await saveSession(fakeSession(sid, dir, now - ageMs));
  const t = new Date(now - ageMs);
  fs.utimesSync(dir, t, t);
  newQuickProject();
  return { dir, sid };
}

const never = () => false;

test("quickRetention：设置值 → 清理方式；认不出的一律不清理", () => {
  assert.deepEqual(quickRetention("ttl30"), { mode: "ttl" });
  assert.deepEqual(quickRetention("max20"), { mode: "count", max: 20 });
  assert.deepEqual(quickRetention("max0"), { mode: "never" });
  assert.deepEqual(quickRetention("never"), { mode: "never" });
  assert.deepEqual(quickRetention(undefined), { mode: "never" });
});

test("从不清理（默认）：放了一年的桶也不动", async () => {
  isolate();
  const now = Date.now();
  const a = await usedBucket("old", 365 * DAY, now);
  const r = await pruneQuick({ retention: "never", now, busy: never });
  assert.deepEqual(r, { recycled: 0, purged: 0, empty: 0 });
  assert.ok(fs.existsSync(a.dir));
});

test("按天数：30 天没动的进回收站，列表不再列出；在跑的、当前桶不动", async () => {
  isolate();
  const now = Date.now();
  const old = await usedBucket("ttl-old", 40 * DAY, now);
  const fresh = await usedBucket("ttl-fresh", 2 * DAY, now);
  const running = await usedBucket("ttl-run", 60 * DAY, now);
  const cur = quickProject()!.path;
  const r = await pruneQuick({ retention: "ttl30", now, busy: (id) => id === running.sid });
  assert.equal(r.recycled, 1);
  assert.equal(fs.existsSync(old.dir), false, "老的整只挪走");
  assert.ok(fs.existsSync(fresh.dir) && fs.existsSync(running.dir) && fs.existsSync(cur));
  assert.equal(recycledQuickCount(), 1);
  assert.ok(await loadSession(old.sid), "会话记录先留着（恢复用）");
  const page = await listSessionsPage({ filter: quickSessionFilter({ busy: never, now }) });
  assert.equal(page.items.some((m) => m.id === old.sid), false, "回收掉的桶的会话不再列出");
});

test("只留最近 N 条：超出的按最后活动从旧到新进回收站；在跑的占名额", async () => {
  isolate();
  const now = Date.now();
  const bs: Array<{ dir: string; sid: string }> = [];
  for (let i = 1; i <= 5; i++) bs.push(await usedBucket(`cnt${i}`, i * HOUR, now)); // 1 最新 … 5 最老
  const r = await pruneQuick({ retention: "max2", now, busy: (id) => id === bs[4].sid });
  // 在跑的第 5 只占一个名额 → 其余只留最新 1 只（第 1 只）
  assert.equal(r.recycled, 3);
  assert.ok(fs.existsSync(bs[0].dir) && fs.existsSync(bs[4].dir));
  for (const b of bs.slice(1, 4)) assert.equal(fs.existsSync(b.dir), false);
});

test("空桶过了宽限就删；回收站放满 30 天连会话一起永久删除", async () => {
  isolate();
  const now = Date.now();
  const empty = quickProject()!.path;
  const t = new Date(now - HOUR);
  fs.utimesSync(empty, t, t);
  newQuickProject();
  const old = await usedBucket("purge", 40 * DAY, now);
  const r1 = await pruneQuick({ retention: "ttl30", now, busy: never });
  assert.equal(r1.empty, 1);
  assert.equal(r1.recycled, 1);
  assert.equal(fs.existsSync(empty), false);
  // 回收站照旧到期——哪怕改成了从不清理
  const r2 = await pruneQuick({ retention: "never", now: now + 31 * DAY, busy: never });
  assert.equal(r2.purged, 1);
  assert.equal(recycledQuickCount(), 0);
  assert.equal(await loadSession(old.sid), null, "会话记录一并删掉");
});
