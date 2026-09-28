// K11：记忆总览 + 用量。
//
// 修前：记忆只能一个项目一个项目地看（侧栏项目菜单 → 项目记忆），全局层、别的项目、旧快照桶里散落的记忆没有一处能总览；
// 也看不出哪条记忆真被用上过——生效了几个月、从没被召回的条目占着每一轮的提示却无从发现。
// 修后：GET /api/memory/overview 一次给齐全局层 + 各项目 + 旧快照桶（只读，不为查看建目录）；开跑时的自动召回与
// Recall 按 id 读全文会记进该层记忆目录的 usage.json（只记 id 与时间）；.history 的文件名还原成事件。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, beforeEach } from "node:test";
import { GLOBAL_MEMORY, memoryDir, rejectMemory, saveMemory } from "./memory.ts";
import { buildMemoryOverview, GLOBAL_WS, parseHistoryName } from "./memory-overview.ts";
import { memoryUsage, noteMemoryUse, noteRecalledDocs } from "./memory-usage.ts";
import { Sandbox } from "./sandbox.ts";
import { recallTool } from "./tools/recall.ts";
import type { ToolContext } from "./tools/types.ts";
import { countLanes, glyphOf, laneOf, lifeOf, spanOf, ticksOf, xOf } from "../web/src/components/sheets/memory-viz.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
beforeEach(() => fs.rmSync(memoryDir(GLOBAL_MEMORY), { recursive: true, force: true }));
const tmp = (prefix: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};
const note = (title: string, extra: Record<string, unknown> = {}) => ({
  title,
  description: `${title} in one sentence.`,
  type: "user" as const,
  topic: `user.${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
  status: "active" as const,
  confidence: "user_confirmed" as const,
  content: `${title}. The user said so.`,
  evidence: ["the user said so"],
  ...extra,
});

test("K11 总览：全局层 + 有记忆的项目 + 旧快照桶，没有记忆的项目只计数、不为查看建目录", () => {
  const withNotes = tmp("dimensio-k11-a-");
  const empty = tmp("dimensio-k11-b-");
  const quickRoot = tmp("dimensio-k11-quick-");
  const oldQuick = path.join(quickRoot, "11111111-aaaa");
  const curQuick = path.join(quickRoot, "22222222-bbbb");
  fs.mkdirSync(oldQuick);
  fs.mkdirSync(curQuick);

  saveMemory(withNotes, note("Prefers tabs"));
  saveMemory(withNotes, note("Guess about the build", { status: "proposed", confidence: "inferred", topic: "user.build-guess" }));
  saveMemory(oldQuick, note("Quick fact"));
  saveMemory(GLOBAL_MEMORY, note("Replies in Chinese", { status: "proposed" }));

  const ov = buildMemoryOverview({
    projects: [
      { path: withNotes, name: "带记忆的项目" },
      { path: empty, name: "空项目" },
      { path: withNotes, name: "重复出现的同一个项目" },
    ],
    currentWs: withNotes,
    quickRoot,
    currentQuick: curQuick,
  });

  assert.deepEqual(ov.buckets.map((b) => [b.kind, b.name]), [["global", "全局"], ["project", "带记忆的项目"], ["quick", "快照对话"]]);
  assert.equal(ov.emptyProjects, 1, "没有记忆的项目只计个数");
  assert.equal(fs.existsSync(memoryDir(empty)), false, "查看不建目录");
  assert.equal(fs.existsSync(memoryDir(curQuick)), false, "当前快照桶没有记忆：不列、也不建目录");
  assert.equal(ov.budget > 0, true);

  const global = ov.buckets[0]!;
  assert.equal(global.ws, GLOBAL_WS);
  assert.equal(global.promptChars, 0, "全局层只有待确认的：不进提示");

  const project = ov.buckets[1]!;
  assert.equal(project.current, true);
  assert.equal(project.ws, path.resolve(withNotes));
  assert.deepEqual(project.items.map((m) => m.status).sort(), ["active", "proposed"]);
  assert.ok(project.promptChars > 0, "生效的那条以索引行进提示");

  const quick = ov.buckets[2]!;
  assert.equal(quick.ws, path.resolve(oldQuick));
  assert.equal(quick.current, undefined);
  assert.ok((quick.createdAt ?? 0) > 0);
});

test("K11 用量：召回的文档 id 按层记（memory:<id> / memory:global:<id>），项目知识不算；没有记忆目录就不记", () => {
  const ws = tmp("dimensio-k11-use-");
  const bare = tmp("dimensio-k11-bare-");
  saveMemory(ws, note("Prefers tabs"));
  saveMemory(GLOBAL_MEMORY, note("Replies in Chinese"));

  const t0 = new Date("2026-09-20T08:00:00.000Z");
  const t1 = new Date("2026-09-27T08:00:00.000Z");
  noteRecalledDocs(ws, ["memory:prefers-tabs", "memory:global:replies-in-chinese", "module:src/app.ts", "profile"], t0);
  noteRecalledDocs(ws, ["memory:prefers-tabs"], t1);
  noteRecalledDocs(bare, ["memory:whatever"], t1);

  assert.deepEqual(memoryUsage(ws)["prefers-tabs"], { n: 2, first: t0.toISOString(), last: t1.toISOString() });
  assert.deepEqual(memoryUsage(GLOBAL_MEMORY)["replies-in-chinese"], { n: 1, first: t0.toISOString(), last: t0.toISOString() });
  assert.equal(Object.keys(memoryUsage(ws)).length, 1, "项目知识的文档不记");
  assert.equal(fs.existsSync(memoryDir(bare)), false, "没有记忆的工作区不为用量建目录");

  noteMemoryUse(ws, ["../escape", ""], t1);
  assert.equal(Object.keys(memoryUsage(ws)).length, 1, "不像 id 的一律不记");

  // 总览把用量挂到条目上
  const ov = buildMemoryOverview({ projects: [{ path: ws, name: "p" }] });
  const item = ov.buckets.find((b) => b.kind === "project")!.items[0]!;
  assert.equal(item.uses, 2);
  assert.equal(item.lastUsed, t1.toISOString());
});

test("K11 用量：Recall 按 id 读全文算一次（全局层的记在全局层）", async () => {
  const ws = tmp("dimensio-k11-recall-");
  saveMemory(ws, note("Prefers tabs"));
  saveMemory(GLOBAL_MEMORY, note("Replies in Chinese"));
  const ctx: ToolContext = {
    sandbox: new Sandbox(ws),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    humanAttended: () => true,
  };
  await recallTool.run({ id: "prefers-tabs" }, ctx);
  await recallTool.run({ id: "global:replies-in-chinese" }, ctx);
  await recallTool.run({ id: "no-such-note" }, ctx);
  await recallTool.run({}, ctx); // 只列目录不算
  assert.equal(memoryUsage(ws)["prefers-tabs"]?.n, 1);
  assert.equal(memoryUsage(GLOBAL_MEMORY)["replies-in-chinese"]?.n, 1);
  assert.equal(memoryUsage(ws)["no-such-note"], undefined);
});

test("K11 历史事件：.history 的文件名还原成 {id, at, why}，按时间排；认不出的文件名跳过", () => {
  assert.deepEqual(parseHistoryName("prefers-tabs.2026-09-21T10-22-33-123Z.reject.md"), {
    id: "prefers-tabs",
    at: "2026-09-21T10:22:33.123Z",
    why: "reject",
  });
  assert.equal(parseHistoryName("prefers-tabs.2026-09-21T10-22-33-123Z.unknown.md"), null);
  assert.equal(parseHistoryName("MEMORY.md"), null);
  assert.equal(parseHistoryName("x.not-a-date.overwrite.md"), null);

  const ws = tmp("dimensio-k11-hist-");
  saveMemory(ws, note("Prefers tabs"));
  saveMemory(ws, note("Prefers tabs", { content: "Prefers tabs, width 4. The user said so." })); // 覆盖 → overwrite
  rejectMemory(ws, "prefers-tabs", "no longer true"); // → reject
  fs.writeFileSync(path.join(memoryDir(ws), ".history", "junk.txt"), "x");
  const bucket = buildMemoryOverview({ projects: [{ path: ws, name: "p" }] }).buckets.find((b) => b.kind === "project")!;
  assert.deepEqual(bucket.history.map((e) => [e.id, e.why]), [["prefers-tabs", "overwrite"], ["prefers-tabs", "reject"]]);
  assert.ok(bucket.history[0]!.at <= bucket.history[1]!.at);
  assert.equal(bucket.items[0]!.status, "rejected");
  assert.equal(bucket.promptChars > 0, true, "驳回的条目只以一句「有 N 条被驳回」进提示");
});

test("K11 面板四类：待确认（含被扣下的）· 被隔离（写着生效却没进提示）· 生效 · 已退场（失效 / 被替代 / 驳回各有字形）", () => {
  const m = (status: string, declaredStatus: string) => ({ status, declaredStatus }) as Parameters<typeof laneOf>[0];
  assert.equal(laneOf(m("proposed", "proposed")), "proposed");
  assert.equal(laneOf(m("proposed", "active")), "proposed", "注入特征 / 外部内容被扣成待确认的，是在等人拍板");
  assert.equal(laneOf(m("active", "active")), "active");
  assert.equal(laneOf(m("stale", "active")), "held", "过期、锚点不在、同主题冲突：被隔离");
  assert.equal(laneOf(m("stale", "stale")), "retired");
  assert.equal(laneOf(m("superseded", "superseded")), "retired");
  assert.equal(laneOf(m("rejected", "rejected")), "retired");
  assert.deepEqual(
    [m("stale", "stale"), m("superseded", "superseded"), m("rejected", "rejected"), m("stale", "active")].map(glyphOf),
    ["stale", "superseded", "rejected", "held"],
  );
  assert.deepEqual(countLanes([m("active", "active"), m("stale", "active"), m("rejected", "rejected")]), { proposed: 0, held: 1, active: 1, retired: 1 });
});

test("K11 时间线：一生 = 最早一份旧版 → 当前版本；尺子至少两周、右端是现在；刻度按跨度挑日 / 月且落在尺内", () => {
  const now = Date.parse("2026-09-28T12:00:00.000Z");
  const history = [
    { id: "a", at: "2026-08-01T00:00:00.000Z", why: "overwrite" as const },
    { id: "a", at: "2026-09-01T00:00:00.000Z", why: "reject" as const },
    { id: "b", at: "2026-09-20T00:00:00.000Z", why: "overwrite" as const },
  ];
  const life = lifeOf({ id: "a", updated: "2026-09-10T00:00:00.000Z" }, history);
  assert.equal(life.start, Date.parse("2026-08-01T00:00:00.000Z"));
  assert.equal(life.end, Date.parse("2026-09-10T00:00:00.000Z"));
  assert.deepEqual(life.events.map((e) => e.why), ["overwrite", "reject"]);

  const span = spanOf([life], now);
  assert.equal(span.t1, now);
  assert.ok(span.t0 < life.start, "左边留一点呼吸");
  assert.equal(xOf(now, span), 1);
  const ticks = ticksOf(span, 4);
  assert.ok(ticks.length >= 1 && ticks.length <= 4);
  assert.ok(ticks.every((t) => t.t >= span.t0 && t.t <= span.t1));
  assert.ok(ticks.every((t) => /月$/.test(t.label)), "两个月的跨度按月标");

  const short = spanOf([lifeOf({ id: "c", updated: "2026-09-27T00:00:00.000Z" }, [])], now);
  assert.ok(short.t1 - short.t0 >= 14 * 86_400_000, "只有一天的数据也撑到两周");
  assert.ok(ticksOf(short, 5).every((t) => /^\d+\/\d+$/.test(t.label)), "短跨度按日标");
});
