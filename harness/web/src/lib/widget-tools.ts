// 对话内嵌交互图表在时间线里的身份（纯函数，不碰 DOM：feed-units.ts 会被服务端测试直接导入）。
//   ShowWidget  —— 画出来的图就是回答的一部分：不进工具组、做完的轮折叠时也不收起，单独成一张图表卡（WidgetCard.svelte）。
//   WidgetGuide —— 画图前读指南，对用户是内部步骤：对话流里不显示（官方 hidden_in_chat）。
import type { Item, ToolItem } from "./timeline-types.ts";

export const SHOW_WIDGET = "ShowWidget";
export const WIDGET_GUIDE = "WidgetGuide";
// 与服务端 tools/visualize.ts 的 MAX_WIDGET_CODE 一致：超了服务端就拒画
export const MAX_WIDGET_CODE = 512 * 1024;

export const isWidgetItem = (it: Item | undefined): boolean => it?.kind === "tool" && (it as ToolItem).name === SHOW_WIDGET;
// 同样对用户是内部步骤的：ToolSearch（取推迟工具的说明，server/agent/deferred-tools.ts），和没取说明就调了推迟工具、被拦下回说明的那一次
export const TOOL_SEARCH = "ToolSearch";
const NOT_LOADED = "tool instructions not loaded";
export const isHiddenToolItem = (it: Item | undefined): boolean => {
  if (it?.kind !== "tool") return false;
  const t = it as ToolItem;
  if (t.name === WIDGET_GUIDE || t.name === TOOL_SEARCH) return true;
  return t.status === "fail" && (t.summary === NOT_LOADED || (t.output ?? "").startsWith(`${t.name} is a deferred tool`));
};

export interface WidgetView {
  id: string;
  title: string;
  loading: string[];
  code: string;
}

// 工具行的参数 → 图表卡要的几样（直播的 tool_start 与历史重建的 tool_call 参数同形）
export function widgetOf(it: ToolItem): WidgetView {
  const a = it.args && typeof it.args === "object" ? it.args : {};
  return {
    id: it.id,
    title: typeof a.title === "string" ? a.title : "",
    loading: Array.isArray(a.loading_messages) ? a.loading_messages.map(String).filter(Boolean).slice(0, 4) : [],
    code: typeof a.widget_code === "string" ? a.widget_code : "",
  };
}

// 这张图算不算没画出来：只看代码本身（空 / 超限）。工具行因为这一轮被掐断而记成「已中断」的，代码是完整的，照画。
export const widgetBroken = (w: WidgetView): boolean => !w.code.trim() || w.code.length > MAX_WIDGET_CODE;

// 标题给人看：snake_case 换空格
export const widgetTitle = (w: WidgetView): string => w.title.replace(/_/g, " ").trim();
