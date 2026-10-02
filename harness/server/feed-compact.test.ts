// 精简模式（默认）的工作过程：对齐 bridge Claude 分页的工具分组。
//
// 修前：dimensio 的时间线只把只读探索收进组，改文件、跑命令一条条平铺，每条还带第二行结果、运行中的实时尾行——
// 一轮做十几步时整屏都是过程。
// 修后：默认连续 ≥2 次工具（不分读写，Workflow 除外）收成一行，跑着说此刻在做什么，做完说「读取了 3 个文件，执行了 2 条命令」，
// 点开再看每一步；设置里打开「显示全部工作过程」= 原来的样子（feedUnits 第 4 个参数不传即原行为，旧测试不动）。
import assert from "node:assert/strict";
import test from "node:test";
import { feedUnits, type FeedUnit } from "../web/src/lib/feed-units.ts";
import { argPreview, groupSummary } from "../web/src/lib/tool-summary.ts";
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
