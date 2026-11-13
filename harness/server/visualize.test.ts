// 对话内嵌交互图表：ShowWidget / WidgetGuide 两件工具（tools/visualize.ts）与它们在对话流里的位置（web/src/lib/feed-units.ts）。
import assert from "node:assert/strict";
import test from "node:test";
import { guideText, MAX_WIDGET_CODE, showWidgetTool, widgetGuideTool, SHOW_WIDGET, WIDGET_GUIDE } from "./tools/visualize.ts";
import { toolDefs } from "./tools/registry.ts";
import { setPrefs } from "./prefs.ts";
import { feedUnits, type FeedUnit } from "../web/src/lib/feed-units.ts";
import { widgetBroken, widgetOf } from "../web/src/lib/widget-tools.ts";
import type { Item, ToolItem } from "../web/src/lib/timeline-types.ts";
import type { ToolContext } from "./tools/types.ts";

const ctx = {} as ToolContext;
const text = (r: { content: { t: string; text?: string }[] }) => r.content.map((b) => b.text ?? "").join("");

test("偏好「对话内交互图表」：开着两件工具都在清单里，关掉就都不出现", async () => {
  const names = () => toolDefs().map((d) => d.name);
  assert.ok(names().includes(WIDGET_GUIDE) && names().includes(SHOW_WIDGET));
  await setPrefs({ inlineVisualizations: false });
  try {
    assert.ok(!names().includes(SHOW_WIDGET) && !names().includes(WIDGET_GUIDE));
  } finally {
    await setPrefs({ inlineVisualizations: null });
  }
  assert.ok(names().includes(SHOW_WIDGET));
});

test("WidgetGuide：与 Claude 同一份指南，工具名换成这里的；按 modules 拼段、手机版按 380 宽", async () => {
  const base = guideText([], "desktop");
  assert.match(base, /# Inline visuals/);
  assert.match(base, new RegExp(`with ${SHOW_WIDGET};`));
  assert.ok(!/\bread_me\b|\bshow_widget\b/.test(base), "指南里还留着 Claude 那边的工具名");
  const diagram = text(await widgetGuideTool.run({ modules: ["diagram"] }, ctx));
  assert.ok(diagram.length > base.length);
  assert.match(guideText([], "mobile"), /about 380px/);
  assert.match(guideText([], "nonsense"), /about 680px/);
});

test("ShowWidget：空代码、超限代码报错让模型重画；正常的回固定一句（内容已经给用户看到了）", async () => {
  const empty = await showWidgetTool.run({ title: "x", widget_code: "  " }, ctx);
  assert.equal(empty.ok, false);
  const big = await showWidgetTool.run({ title: "x", widget_code: "<svg>" + "a".repeat(MAX_WIDGET_CODE) }, ctx);
  assert.equal(big.ok, false);
  assert.match(text(big), /too large/);
  const good = await showWidgetTool.run({ title: "flow", loading_messages: ["画流程"], widget_code: '<svg viewBox="0 0 10 10"></svg>' }, ctx);
  assert.equal(good.ok, true);
  assert.match(text(good), /Do not repeat its content/);
});

const user = (t: string): Item => ({ kind: "user", text: t });
const tool = (id: string, name = "Bash", args: Record<string, unknown> = {}, status: ToolItem["status"] = "ok"): ToolItem =>
  ({ kind: "tool", id, name, args, status, summary: "", output: "", open: false });
const say = (t: string): Item => ({ kind: "text", text: t, live: false });
const shape = (units: FeedUnit[]) =>
  units.map((u) => (u.f ? `折${u.tools}` : u.g ? `组${u.items.length}` : u.a ? "卡" : u.item.kind === "tool" ? `工:${u.item.id}` : u.item.kind === "text" ? `文:${u.item.text}` : u.item.kind));

test("对话流：读指南那一步不显示；图表不进工具组、做完的轮折叠时照常露出", () => {
  const code = { title: "t", widget_code: "<svg></svg>" };
  const tl: Item[] = [
    user("画个图"), tool("g", WIDGET_GUIDE), tool("r", "Read"), tool("w", SHOW_WIDGET, code), tool("b", "Bash"), say("见上图"),
    user("好"), say("嗯"),
  ];
  // 精简模式：图表把前后的工具隔开，自己单独成行
  assert.deepEqual(shape(feedUnits(tl, false, {}, true)), ["user", "折2", "工:w", "文:见上图", "user", "文:嗯"]);
  // 最近这一轮（不折）：读指南照样不显示
  assert.deepEqual(shape(feedUnits(tl.slice(0, 6), false, {}, true)), ["user", "工:r", "工:w", "工:b", "文:见上图"]);
});

test("图表卡的数据就是工具参数：直播与历史同形；被掐断的轮代码完整照画，空代码才算没画出来", () => {
  const it = tool("w", SHOW_WIDGET, { title: "q3_revenue", loading_messages: ["一", 2], widget_code: "<svg/>" }, "fail");
  const w = widgetOf(it);
  assert.deepEqual(w, { id: "w", title: "q3_revenue", loading: ["一", "2"], code: "<svg/>" });
  assert.equal(widgetBroken(w), false);
  assert.equal(widgetBroken(widgetOf(tool("x", SHOW_WIDGET, { title: "x" }))), true);
});
