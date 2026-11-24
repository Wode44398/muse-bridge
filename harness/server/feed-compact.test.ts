// 精简模式（默认）的工作过程：对齐 bridge Claude 分页的工具分组。
//
// 修前：dimensio 的时间线只把只读探索收进组，改文件、跑命令一条条平铺，每条还带第二行结果、运行中的实时尾行——
// 一轮做十几步时整屏都是过程。
// 修后：默认连续 ≥2 次工具（不分读写，Workflow 除外）收成一行，跑着说此刻在做什么，做完说「读取了 3 个文件，执行了 2 条命令」，
// 点开再看每一步；设置里打开「显示全部工作过程」= 原来的样子（feedUnits 第 4 个参数不传即原行为，旧测试不动）。
// 第二步（文件末尾那几条）：同一文件连续读写并成一行、单行文案分进行时 / 完成时 / 失败句、思考按时长分档、想完写用时。
import assert from "node:assert/strict";
import test from "node:test";
import { feedUnits, groupEntries, type FeedUnit } from "../web/src/lib/feed-units.ts";
import { argPreview, groupSummary, readRanges, thinkingLabel, thoughtLabel, toolLine, toolParams } from "../web/src/lib/tool-summary.ts";
import { reduceTimeline, type TimelineEffects, type TimelineModel } from "../web/src/lib/timeline-reducer.ts";
import { liveClock } from "../web/src/lib/live-clock.ts";
import type { Item, ToolItem } from "../web/src/lib/timeline-types.ts";

const user = (text: string): Item => ({ kind: "user", text });
const tool = (id: string, name = "Bash", args: any = {}, status: ToolItem["status"] = "ok"): ToolItem =>
  ({ kind: "tool", id, name, args, status, summary: "", output: "", open: false });
const think = (): Item => ({ kind: "thinking", text: "想", open: false, live: false });
const text = (t: string): Item => ({ kind: "text", text: t, live: false });
const shape = (units: FeedUnit[]) =>
  units.map((u) => (u.f ? `折${u.tools}` : u.g ? `组${u.items.length}${u.live ? "活" : ""}` : u.a ? `卡${u.items.map((x) => x.id).join("+")}` : u.item.kind === "tool" ? `工:${u.item.id}` : u.item.kind === "text" ? `文:${u.item.text}` : u.item.kind));

test("精简模式：读写命令不分，连续 ≥2 次工具（含穿插思考）收成一组；叙述打断分组；只有 1 次工具的段不套组头", () => {
  const tl: Item[] = [
    user("改个 bug"),
    think(), tool("r1", "Read"), tool("e1", "Edit"), think(), tool("b1", "Bash"),
    text("跑一下测试"),
    think(), tool("b2", "Bash"),
    text("好了"),
  ];
  assert.deepEqual(shape(feedUnits(tl, false, {}, true)), ["user", "组5", "文:跑一下测试", "thinking", "工:b2", "文:好了"]);
  // 显示全部工作过程（旧行为）：动作单独成行，只读探索不足 2 次不收
  assert.deepEqual(shape(feedUnits(tl, false)), ["user", "thinking", "工:r1", "工:e1", "thinking", "工:b1", "文:跑一下测试", "thinking", "工:b2", "文:好了"]);
});

test("精简模式：Workflow 永远自成一行（运行中的紧凑卡不被收起）；组在时间线末尾且在跑 = live", () => {
  const tl: Item[] = [user("开工"), tool("a", "Read"), tool("b", "Grep"), tool("w", "Workflow"), tool("c", "Bash"), tool("d", "Edit")];
  assert.deepEqual(shape(feedUnits(tl, true, {}, true)), ["user", "组2", "工:w", "组2活"]);
});

test("精简模式也照样做轮次折叠：做完的轮收成一行，点开后里面的工具按精简分组", () => {
  const tl: Item[] = [user("一"), tool("a1"), tool("a2", "Edit"), text("一完了"), user("二"), text("二")];
  const units = feedUnits(tl, false, {}, true);
  assert.deepEqual(shape(units), ["user", "折2", "文:一完了", "user", "文:二"]);
  const key = units.find((u) => u.f)!.key;
  assert.deepEqual(shape(feedUnits(tl, false, { [key]: true }, true)), ["user", "折2", "组2", "文:一完了", "user", "文:二"]);
});

test("汇总句：按类目首次出现的顺序；文件按路径去重；搜索 / 网页不数次数；有失败的类目标红", () => {
  const s = groupSummary([
    tool("1", "Read", { path: "a.ts" }),
    tool("2", "Read", { path: "a.ts" }),
    tool("3", "Read", { file_path: "b.ts" }),
    tool("4", "Bash", { command: "npm test" }, "fail"),
    tool("5", "Grep", { pattern: "x" }),
    tool("6", "Grep", { pattern: "y" }),
    tool("7", "Edit", { path: "a.ts" }),
    tool("8", "mcp__github__list"),
    tool("9", "Mystery"),
  ]);
  assert.deepEqual(s, [
    { text: "读取了 2 个文件", bad: false },
    { text: "执行了 1 条命令", bad: true },
    { text: "搜索了代码", bad: false },
    { text: "编辑了 1 个文件", bad: false },
    { text: "调用了连接器", bad: false },
    { text: "用了 1 个工具", bad: false },
  ]);
});

test("参数摘要：命令 / 路径 / 查询词依次取", () => {
  assert.equal(argPreview({ command: "ls -la" }), "ls -la");
  assert.equal(argPreview({ path: "src/a.ts" }), "src/a.ts");
  assert.equal(argPreview({ query: "svelte runes" }), "svelte runes");
  assert.equal(argPreview({}), "");
  assert.equal(argPreview(null), "");
});

test("子 agent 不进组：紧挨着的 Agent（并行派出去的一批）合成一张卡，把前后的工具段切开；两种模式都一样", () => {
  const tl: Item[] = [
    user("查一下"),
    tool("r1", "Read"), tool("g1", "Grep"),
    tool("a1", "Agent"), tool("a2", "Agent"), tool("a3", "Agent"),
    tool("b1", "Bash"), tool("e1", "Edit"),
    text("先看结果"),
    tool("a4", "Agent"),
    think(),
    tool("a5", "Agent"),
  ];
  assert.deepEqual(shape(feedUnits(tl, true, {}, true)), ["user", "组2", "卡a1+a2+a3", "组2", "文:先看结果", "卡a4", "thinking", "卡a5"]);
  // 显示全部工作过程：别的照旧平铺，子 agent 仍是卡
  assert.deepEqual(shape(feedUnits(tl, true)), ["user", "工:r1", "工:g1", "卡a1+a2+a3", "工:b1", "工:e1", "文:先看结果", "卡a4", "thinking", "卡a5"]);
  // 卡的 key 跟第一个 Agent 的 id 走：批里后到的 Agent 不换 key（卡片不重挂）
  const key = (units: FeedUnit[]) => units.find((u) => u.a)!.key;
  assert.equal(key(feedUnits(tl.slice(0, 4), true, {}, true)), key(feedUnits(tl, true, {}, true)));
});

// ── 对齐 Claude 分页的第二步：同文件连续读写并成一行、单行文案三态、思考计时 ──

test("组内：同一文件紧挨着的读 / 写 / 改并成一个 run；换文件、换动作、夹一段思考都断开", () => {
  const items: Item[] = [
    tool("r1", "Read", { path: "a.ts", offset: 1, limit: 200 }),
    tool("r2", "Read", { path: "a.ts", offset: 201, limit: 200 }),
    tool("e1", "Edit", { path: "a.ts" }),
    tool("e2", "Edit", { path: "a.ts" }),
    tool("r3", "Read", { path: "b.ts" }),
    think(),
    tool("r4", "Read", { path: "b.ts" }),
    tool("b1", "Bash", { command: "ls" }),
    tool("b2", "Bash", { command: "ls" }),
  ];
  const e = groupEntries(items);
  assert.deepEqual(
    e.map((x) => (x.run ? x.tools.map((t) => t.id).join("+") : "思")),
    ["r1+r2", "e1+e2", "r3", "思", "r4", "b1", "b2"],
    "Bash 不按命令合并（官方也只合并文件读写）",
  );
  // key 跟 run 的第一步走：同一个 run 后到的步不换 key（行不重挂）
  assert.equal(groupEntries(items.slice(0, 1))[0].key, e[0].key);
  // 分段读的行号范围：每次都给了范围才显示；只有一次不显示
  assert.equal(readRanges([items[0], items[1]] as ToolItem[]), "(1–200, 201–400)");
  assert.equal(readRanges([items[0]] as ToolItem[]), "");
  assert.equal(readRanges([items[0] as ToolItem, tool("x", "Read", { path: "a.ts" })]), "");
});

test("单条工具行：进行时 / 完成时 / 失败句三态；文件只露文件名（整条路径给悬停）；命令与搜索式等宽；表外工具退回原动词", () => {
  const r = toolLine("Read", { path: "src/lib/a.ts" }, "读取文件");
  assert.deepEqual(r, { running: "正在读取", done: "读取了", failed: "未能读取", meta: "a.ts", mono: true, full: "src/lib/a.ts" });
  const b = toolLine("Bash", { command: "npm test" }, "执行命令");
  assert.equal(b.meta, "npm test");
  assert.equal(b.mono, true);
  assert.equal(b.full, undefined);
  assert.equal(toolLine("Bash", { poll: "job-3" }, "执行命令").done, "查看了后台命令");
  assert.equal(toolLine("WebSearch", { query: "svelte" }, "联网搜索").mono, false);
  assert.equal(toolLine("Grep", { pattern: "refreshSession", path: "src" }, "搜索内容").meta, "refreshSession", "搜索说搜什么，不说搜哪儿");
  const m = toolLine("mcp__github__list", {}, "github · list");
  assert.deepEqual([m.running, m.done, m.failed], ["github · list", "github · list", "github · list"]);
  // 参数表：路径在前、命令带「$ 」前缀；空值不列
  assert.deepEqual(
    toolParams({ timeout: 5000, command: "ls", path: "a", empty: "" }).map((p) => [p.key, p.chip, p.code, p.prefix]),
    [["path", true, false, ""], ["command", false, true, "$ "], ["timeout", false, false, ""]],
  );
});

test("汇总句：只碰了一个文件、又读又改 → 并成一句「读取并编辑了 a.ts」；碰了两个文件就分开说", () => {
  assert.deepEqual(groupSummary([tool("1", "Read", { path: "src/a.ts" }), tool("2", "Edit", { path: "src/a.ts" }, "fail"), tool("3", "Bash")]), [
    { text: "读取并编辑了 a.ts", bad: true },
    { text: "执行了 1 条命令", bad: false },
  ]);
  assert.deepEqual(groupSummary([tool("1", "Read", { path: "a.ts" }), tool("2", "Edit", { path: "a.ts" }), tool("3", "Write", { path: "a.ts" })]), [
    { text: "读取、编辑并写入了 a.ts", bad: false },
  ]);
  assert.deepEqual(groupSummary([tool("1", "Read", { path: "a.ts" }), tool("2", "Edit", { path: "b.ts" })]), [
    { text: "读取了 1 个文件", bad: false },
    { text: "编辑了 1 个文件", bad: false },
  ]);
});

test("思考的文案：在想时按已想时长分档（15 / 30 / 45 / 60 秒）；想完「已思考 N 秒」，量不到或不足 1 秒只说「思考过程」", () => {
  assert.equal(thinkingLabel(0), "思考中…");
  assert.equal(thinkingLabel(14_999), "思考中…");
  assert.equal(thinkingLabel(15_000), "仍在思考…");
  assert.equal(thinkingLabel(30_000), "深入思考中…");
  assert.equal(thinkingLabel(45_000), "还在深入思考…");
  assert.equal(thinkingLabel(60_000), "快想好了…");
  assert.equal(thoughtLabel(undefined), "思考过程");
  assert.equal(thoughtLabel(400), "思考过程");
  assert.equal(thoughtLabel(7_400), "已思考 7 秒");
  assert.equal(thoughtLabel(125_000), "已思考 2 分 5 秒");
});

test("归约器给直播的条目记本机时刻（旁挂在 live-clock，不进条目）：工具记开跑时刻，思考块记开始与想了多久", () => {
  const m: TimelineModel = {
    id: null, runId: null, title: "", timeline: [], todos: [], running: true, activity: "", usage: { inTok: 0, outTok: 0 },
    ctx: { used: 0, limit: 0 }, preview: null, cfg: null, away: false, curText: null, curThinking: null, pendingText: "",
    pendingThinking: "", toolRefs: new Map(), askRefs: new Map(), permRefs: new Map(), planRefs: new Map(), agentRefs: new Map(),
    workflowRefs: new Map(), streamTurnIndex: null, turnStartTimelineLength: 0, clock: null,
  };
  const fx: TimelineEffects = {
    foreground: true, scheduleFlush: () => {}, cancelFlush: () => {}, toast: () => {}, rememberSession: () => {},
    openBrowserPane: () => {}, setGlobal: () => {}, refill: () => {}, setBrowser: () => {},
  };
  const realNow = Date.now;
  let clock = 1_000_000;
  Date.now = () => clock;
  try {
    reduceTimeline(m, { e: "thinking_delta", text: "想一想" }, fx);
    clock += 4_200;
    reduceTimeline(m, { e: "text_delta", text: "好" }, fx);
    const th = m.timeline[0];
    assert.deepEqual(liveClock(th), { t0: 1_000_000, ms: 4_200 });
    assert.equal((th as { live: boolean }).live, false);
    assert.deepEqual(Object.keys(th).sort(), ["kind", "live", "open", "text"], "条目本身不带墙钟（同一串事件何时重放都归约出相同的时间线）");
    reduceTimeline(m, { e: "thinking_delta", text: "再想" }, fx);
    clock += 900;
    reduceTimeline(m, { e: "tool_start", id: "t1", name: "Read", args: { path: "a.ts" } }, fx);
    const th2 = m.timeline.find((it, i) => i > 0 && it.kind === "thinking")!;
    assert.equal(liveClock(th2)?.ms, 900, "工具开跑 = 这段思考结束");
    assert.equal(liveClock(m.timeline.at(-1)!)?.t0, clock);
  } finally {
    Date.now = realNow;
  }
});

test("工具卡认参数的别家写法（file_path / filePath / absolute_path、Grep 的 output_mode）：路径、合并计数与并行读写的行都照规范名摆；规范名在时不动", () => {
  // 模型按 Claude Code / Gemini CLI 的习惯写参数：服务端执行前归一，转录里留原话——卡片照样认得出路径
  assert.equal(toolLine("Read", { filePath: "src/app/main.ts" }, "读").meta, "main.ts");
  assert.equal(toolLine("Read", { absolute_path: "C:/ws/a.ts" }, "读").full, "C:/ws/a.ts");
  assert.equal(toolLine("Write", { target_file: "notes.md", contents: "x" }, "写").meta, "notes.md");
  assert.equal(argPreview({ filePath: "x/y.ts" }), "x/y.ts");
  assert.equal(argPreview({ path: "p.ts", file_path: "q.ts" }), "p.ts", "规范名优先");
  // 同一个文件用两种写法读又改：仍算一个文件、并成一句
  const pieces = groupSummary([tool("r", "Read", { file_path: "a.ts" }), tool("e", "Edit", { filePath: "a.ts" })]);
  assert.equal(pieces.length, 1);
  assert.match(pieces[0].text, /a\.ts/);
  // 连续读同一个文件（写法不同）并成一个 run
  const runs = groupEntries([tool("r1", "Read", { file_path: "a.ts", offset: 1, limit: 10 }), tool("r2", "Read", { absolutePath: "a.ts", offset: 11, limit: 10 })]);
  assert.equal(runs.length, 1);
  // 参数表里别家的路径键也摆成路径小片
  assert.equal(toolParams({ filePath: "a.ts" })[0].chip, true);
});

test("工具卡的同义名表只补规范名缺的那一项，取值按服务端同一张表换（output_mode files_with_matches → files）", async () => {
  const { canonicalArgs } = await import("../web/src/lib/tool-args.ts");
  assert.deepEqual(canonicalArgs("Grep", { pattern: "x", output_mode: "files_with_matches" }), { pattern: "x", output_mode: "files_with_matches", mode: "files" });
  assert.deepEqual(canonicalArgs("Grep", { pattern: "x", mode: "count", output_mode: "content" }).mode, "count");
  const raw = { path: "a.ts" };
  assert.equal(canonicalArgs("Read", raw), raw, "没有要补的原样返回");
  assert.equal(canonicalArgs("Bash", { cmd: "ls" }).command, "ls");
  assert.equal(canonicalArgs("NotATool", { file_path: "a" }).path, undefined);
});
