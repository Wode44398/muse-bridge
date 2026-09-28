import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  QUICK_NAME,
  isCurrentQuickPath,
  isQuickPath,
  newQuickProject,
  quickProject,
  quickSessionFilter,
} from "./quick.ts";
import { listSessionsPage, saveSession, type PersistedSession } from "./store.ts";

function temp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// 每条用例独立的桶根 + 指针文件（与 projects.test.ts 同款环境改道）。
function isolate(): string {
  const root = temp("dimensio-quick-");
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

test("quickProject 幂等铸桶，newQuickProject 换桶且旧桶留盘", () => {
  isolate();
  const a = quickProject();
  assert.ok(a);
  assert.equal(a!.name, QUICK_NAME);
  assert.equal(a!.quick, true);
  assert.equal(fs.statSync(a!.path).isDirectory(), true);
  // 幂等：再问一次还是同一只桶
  assert.equal(quickProject()!.path, a!.path);
  assert.equal(isCurrentQuickPath(a!.path), true);

  const b = newQuickProject();
  assert.notEqual(b.path, a!.path);
  assert.equal(quickProject()!.path, b.path);
  // 旧桶不删（快照产物不至于一键蒸发），但不再是「当前」
  assert.equal(fs.existsSync(a!.path), true);
  assert.equal(isCurrentQuickPath(a!.path), false);
  assert.equal(isCurrentQuickPath(b.path), true);
});

test("指针文件损坏/缺失/指到根外都会现铸新桶", () => {
  const root = isolate();
  const a = quickProject()!;
  fs.writeFileSync(path.join(root, "quick.json"), "{broken", "utf8");
  const b = quickProject()!;
  assert.notEqual(b.path, a.path);
  // 指到桶根之外 = 不认（防指针被改去别的目录）
  fs.writeFileSync(
    path.join(root, "quick.json"),
    JSON.stringify({ v: 1, id: "x", path: os.homedir(), createdAt: 1 }),
    "utf8",
  );
  assert.equal(isQuickPath(quickProject()!.path), true);
});

test("isQuickPath 只认桶根之内", () => {
  isolate();
  const p = quickProject()!;
  assert.equal(isQuickPath(p.path), true);
  assert.equal(isQuickPath(path.join(p.path, "sub")), true);
  assert.equal(isQuickPath(process.env.DIMENSIO_QUICK_ROOT), false); // 根本身不算桶
  assert.equal(isQuickPath(os.homedir()), false);
  assert.equal(isQuickPath(undefined), false);
  assert.equal(isQuickPath(""), false);
});

test("会话列表：旧桶全隐藏、当前桶只露最新一条、且置顶保住第一页", async () => {
  isolate();
  const sessionsDir = temp("dimensio-quick-sessions-");
  const prevSessions = process.env.SESSIONS_DIR;
  process.env.SESSIONS_DIR = sessionsDir;
  try {
    const old = quickProject()!;
    const cur = newQuickProject();
    const project = temp("dimensio-quick-proj-");
    // 时间线（新→旧）：普通新会话 > 当前桶新 > 当前桶旧 > 旧桶 > 一批更早的普通会话
    await saveSession(fakeSession("proj-new", project, 9_000));
    await saveSession(fakeSession("quick-new", cur.path, 8_000));
    await saveSession(fakeSession("quick-old", cur.path, 7_000));
    await saveSession(fakeSession("quick-stale-bucket", old.path, 6_500));
    for (let i = 0; i < 6; i++) await saveSession(fakeSession(`proj-${i}`, project, 6_000 - i));

    const page = await listSessionsPage({
      filter: quickSessionFilter(),
      pin: (m) => isCurrentQuickPath(m.workspace),
    });
    const ids = page.items.map((m) => m.id);
    // 当前桶只剩最新一条，且被顶到最前；旧桶与当前桶更旧的一条都不见了
    assert.equal(ids[0], "quick-new");
    assert.equal(ids.includes("quick-old"), false);
    assert.equal(ids.includes("quick-stale-bucket"), false);
    assert.equal(ids.includes("proj-new"), true);
    assert.equal(page.total, 8); // 10 条落盘，2 条被过滤

    // 分页不重不漏：limit=3 逐页扫完 = 全量
    const walked: string[] = [];
    for (let offset = 0; offset < page.total; offset += 3) {
      const p = await listSessionsPage({
        offset,
        limit: 3,
        filter: quickSessionFilter(),
        pin: (m) => isCurrentQuickPath(m.workspace),
      });
      walked.push(...p.items.map((m) => m.id));
    }
    assert.deepEqual(walked, ids);
  } finally {
    process.env.SESSIONS_DIR = prevSessions;
  }
});
