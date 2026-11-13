// 对话内嵌交互图表：ShowWidget（画）+ WidgetGuide（画法指南）。对齐 bridge 里 Claude 的 visualize（show_widget + read_me）。
//
//   WidgetGuide → 返回画图指南（按 modules + platform 拼段）。正文与 bridge 给 Claude 的是同一份（src/mcp/visualize-guide.mjs，
//                 经 core-link 取），只把里面的工具名换成这里的名字。对话流里不显示这一行（官方 hidden_in_chat）。
//   ShowWidget  → 入参 loading_messages / title / widget_code，结果是固定一句话；真正的渲染在前端（工具行的参数里就有整份代码，
//                 直播与历史重放走同一份数据）：沙箱 iframe（只给 allow-scripts）、手机壳里剥脚本静态渲染。
//
// 服务端不执行、不读写任何东西，所以只读档 / 计划档也能用；偏好「对话内交互图表」关掉、或核心里没有指南（老 bridge 程序）时两件都不出现。
import { coreModule } from "../core-link.ts";
import { prefValue } from "../prefs.ts";
import { fail, ok, type Tool } from "./types.ts";

export const SHOW_WIDGET = "ShowWidget";
export const WIDGET_GUIDE = "WidgetGuide";
// widget_code 上限：模型偶尔会把整份数据集内联进来；再大前端也画不动、转录也背不起
export const MAX_WIDGET_CODE = 512 * 1024;

type GuideMod = { guideFor(modules: unknown, platform: string): string; MODULES: string[]; PLATFORMS: string[] };
let guideMod: GuideMod | null | undefined;
function guide(): GuideMod | null {
  if (guideMod === undefined) {
    try {
      guideMod = coreModule<GuideMod>("mcp/visualize-guide.mjs");
    } catch {
      guideMod = null;
    }
  }
  return guideMod;
}
const MODULES = ["diagram", "mockup", "interactive", "data_viz", "art", "chart", "elicitation"];

export const vizEnabled = (): boolean => prefValue<boolean>("inlineVisualizations") && guide() !== null;

// 指南正文写的是 Claude 那边的工具名
export function guideText(modules: unknown, platform: unknown): string {
  const g = guide();
  if (!g) return "";
  const p = platform === "mobile" || platform === "desktop" ? platform : "desktop";
  return g.guideFor(modules, p).replace(/\bread_me\b/g, WIDGET_GUIDE).replace(/\bshow_widget\b/g, SHOW_WIDGET);
}

const RENDERED = "Rendered and shown to the user inline. Do not repeat its content in text — it is already visible; refer to it instead.";

export const widgetGuideTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  enabled: vizEnabled,
  def: {
    name: WIDGET_GUIDE,
    description:
      `Returns the drawing guide for ${SHOW_WIDGET}: the host's CSS variables, color palette, typography, layout rules and patterns per module. ` +
      `Call it before your first ${SHOW_WIDGET} in a conversation, and again when you need a different module. It is an internal setup step: never mention it to the user.`,
    parameters: {
      type: "object",
      properties: {
        modules: {
          type: "array",
          items: { type: "string", enum: MODULES },
          description: "Which guide modules to load. Pick every one that fits.",
        },
        platform: {
          type: "string",
          enum: ["desktop", "mobile"],
          description: 'Where the visual will be shown. Default desktop (≈680px wide); "mobile" = phone, ≈380px wide.',
        },
      },
    },
  },
  async run(args) {
    const text = guideText(args.modules, args.platform);
    if (!text) return fail("guide unavailable", `The drawing guide is not available on this host; do not call ${SHOW_WIDGET}.`);
    return ok("drawing guide", text);
  },
};

export const showWidgetTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  enabled: vizEnabled,
  def: {
    name: SHOW_WIDGET,
    description:
      "Show a visual — an SVG diagram or illustration, a chart, or a small interactive HTML widget — inline in the conversation, right where you call it. " +
      "Good for flowcharts, architecture diagrams, charts, dashboards, comparison cards, calculators and forms. " +
      "widget_code that starts with <svg is rendered as SVG; anything else as an HTML fragment. Inside HTML a global sendPrompt(text) sends a message to the chat as if the user typed it (only from a user click). " +
      `IMPORTANT: call ${WIDGET_GUIDE} before your first ${SHOW_WIDGET} in a conversation — silently, never mention it to the user.`,
    parameters: {
      type: "object",
      properties: {
        loading_messages: {
          type: "array",
          items: { type: "string" },
          description: "1–4 short status lines (about 5 words each) in the user's language, shown while the visual is being drawn. Plain and literal for serious or sensitive subjects.",
        },
        title: {
          type: "string",
          description: 'Short snake_case name that tells this visual apart, e.g. "q3_revenue_by_region". Also the download file name: letters, digits and underscores only.',
        },
        widget_code: {
          type: "string",
          description:
            "The SVG or HTML to render. SVG: one <svg> root with a viewBox, colors from the host's CSS variables and c-* classes. HTML: a fragment (no DOCTYPE/<html>/<head>/<body>), transparent outer background, no top-level padding. " +
            "Scripts run only after the code is complete, and never in the phone app — the markup must make sense on its own.",
        },
      },
      required: ["title", "widget_code"],
    },
  },
  async run(args) {
    const code = typeof args.widget_code === "string" ? args.widget_code : "";
    if (!code.trim()) return fail("empty widget", `widget_code is empty — nothing was shown. Call ${SHOW_WIDGET} again with the SVG or HTML.`);
    if (code.length > MAX_WIDGET_CODE) {
      return fail("widget too large", `widget_code is too large (${code.length} characters, limit ${MAX_WIDGET_CODE}) — nothing was shown. Draw a smaller visual and keep bulk data out of the code.`);
    }
    const title = typeof args.title === "string" && args.title.trim() ? args.title.trim().slice(0, 80) : "visual";
    return ok(`widget ${title}`, RENDERED);
  },
};
