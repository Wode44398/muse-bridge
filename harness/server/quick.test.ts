import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  QUICK_LINGER_MS,
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

test("别处换了快照桶：在跑的、刚动过的、最新的那条旧快照照样列出（2026-10-13 截图里那条消失的快照）", () => {
  isolate();
  const old = quickProject()!;
  const older = newQuickProject();
  newQuickProject(); // 当前桶，里面还没有会话
  const now = 10_000_000;
  const m = (id: string, workspace: string, updatedAt: number) => ({ id, workspace, updatedAt }) as any;
  // 已按 updatedAt 倒序
  const rows = [
    m("latest-quick", old.path, now - 60 * 60_000), // 所有快照里最新的一条（新桶还空着）
    m("running", older.path, now - 50 * 60 * 60_000), // 很久没动，但还在跑
    m("stale", older.path, now - 51 * 60 * 60_000),
  ];
  const f = quickSessionFilter({ busy: (id) => id === "running", now });
  assert.deepEqual(rows.filter(f).map((r) => r.id), ["latest-quick", "running"]);

  // 刚动过的（宽限内）也留着，即使不是最新那条
  const f2 = quickSessionFilter({ now });
  const recent = [m("a", old.path, now - 1000), m("b", older.path, now - 2000), m("c", older.path, now - QUICK_LINGER_MS - 1)];
  assert.deepEqual(recent.filter(f2).map((r) => r.id), ["a", "b"]);
});

test("指针文件读不了（被占用）不当成没有：不换桶、不冲掉 adopted 名单", () => {
  const root = isolate();
  const a = quickProject()!;
  const file = path.join(root, "quick.json");
  const before = fs.readFileSync(file, "utf8");
  // 把指针换成一个目录 → readFileSync 报 EISDIR（≠ ENOENT），模拟 Windows 上的 EBUSY / EPERM
  fs.rmSync(file);
  fs.mkdirSync(file);
  try {
    assert.equal(quickProject()!.path, a.path, "沿用上一次读到的桶");
    assert.equal(isCurrentQuickPath(a.path), true);
  } finally {
    fs.rmdirSync(file);
    fs.writeFileSync(file, before, "utf8");
  }
  assert.equal(quickProject()!.path, a.path);
});

test("存为工作空间：桶原地登记成项目、不再算快照，快照位换新桶，编号只增", async () => {
  const root = isolate();
  process.env.PROJECTS_FILE = path.join(root, "projects.json");
  process.env.PROJECTS_ROOT = path.join(root, "projects");
  const { registerSavedQuick, listProjects, renameProject } = await import("./projects.ts");
  const { currentQuickForSave, adoptCurrentQuick, isAdoptedQuickPath } = await import("./quick.ts");

  const a = quickProject()!;
  // 前端手里的快照已经过期（别的设备换过）→ 拒绝，不把另一只桶存走
  assert.throws(() => currentQuickForSave(path.join(root, "buckets", "stale")), /换过/);

  const cur = currentQuickForSave(a.path);
  assert.equal(cur.seq, 1);
  const saved = await registerSavedQuick(cur.path, `快照会话 ${cur.seq}`);
  const next = adoptCurrentQuick(cur);
  assert.equal(saved.path, a.path);
  assert.equal(saved.name, "快照会话 1");
  assert.notEqual(next.path, a.path);
  assert.equal(quickProject()!.path, next.path);
  // 存走的桶：不再是快照（会话列表 / 项目发现照普通工作空间处理），也不会被当成当前快照重新铸回去
  assert.equal(isQuickPath(a.path), false);
  assert.equal(isAdoptedQuickPath(a.path), true);
  assert.equal(isQuickPath(next.path), true);
  assert.ok((await listProjects()).some((p) => p.path === a.path && p.name === "快照会话 1"));

  // 它的会话照常列出（以前旧桶的会话一律隐藏）
  const keep = quickSessionFilter();
  assert.equal(keep({ workspace: a.path } as any), true);

  // 第二次：编号接着往上走
  const cur2 = currentQuickForSave();
  assert.equal(cur2.seq, 2);
  await registerSavedQuick(cur2.path, `快照会话 ${cur2.seq}`);
  adoptCurrentQuick(cur2);
  assert.equal(isQuickPath(next.path), false);
  assert.equal(currentQuickForSave().seq, 3);

  // 改名只改显示名；留空恢复文件夹名
  const renamed = await renameProject(a.path, "  研报草稿  ");
  assert.equal(renamed.name, "研报草稿");
  assert.equal((await renameProject(a.path, "")).name, path.basename(a.path));
});
