// 工具行 / 工具组的文字摘要（纯函数，不依赖 Svelte；server/feed-units.test.ts 直接测）。
//
// argPreview：工具行第一行动词后面那段参数摘要（命令 / 路径 / 查询词……）。
// groupSummary：精简模式（默认）下工具组做完后头行那一句——对齐 bridge Claude 分页（= 官方 /code 页 groupSummary）：
//   按类目首次出现的顺序说「读取了 3 个文件，编辑了 1 个文件，执行了 2 条命令」；文件类按路径去重计数，
//   搜索 / 网页这类不数次数；有失败的片段标红。
import type { ToolItem } from "./timeline-types.ts";
import { isEn, t } from "./i18n.ts";

export function argPreview(a: any): string {
  if (!a || typeof a !== "object") return "";
  if (a.command) return String(a.command);
  if (a.path) return String(a.path);
  if (a.file_path) return String(a.file_path);
  if (a.pattern) return String(a.pattern);
  if (a.url) return String(a.url);
  if (a.query) return String(a.query);
  if (a.prompt) return String(a.prompt);
  if (a.todos) return t("{n} 项", { n: a.todos.length });
  // 计划：摆第一条不是标题的正文（整份计划在卡片里）；提问：摆第一个问题
  if (typeof a.plan === "string") {
    const line = a.plan.split("\n").map((s: string) => s.trim()).find((s: string) => s && !s.startsWith("#")) ?? "";
    return line.replace(/[`*_]/g, "");
  }
  if (Array.isArray(a.questions)) {
    const q = String(a.questions[0]?.question ?? "");
    return a.questions.length > 1 ? t("{q} 等 {n} 个问题", { q, n: a.questions.length }) : q;
  }
  if (a.action) return [a.action, a.serviceId ?? a.name ?? ""].filter(Boolean).join(" ");
  // E2：MCP 网关（McpDescribe / McpCall）——连接器.工具 + 参数
  if (typeof a.server === "string") {
    const args = a.arguments && typeof a.arguments === "object" ? JSON.stringify(a.arguments) : "";
    return `${[a.server, a.tool].filter(Boolean).join(".")}${args && args !== "{}" ? ` ${args.slice(0, 80)}` : ""}`;
  }
  const s = JSON.stringify(a);
  return s === "{}" ? "" : s.slice(0, 100);
}

// ── 工具组汇总句 ──────────────────────────────────────────────────────────────────────
type Cat =
  | "read" | "write" | "edit" | "bash" | "grep" | "glob" | "web" | "browser" | "agent" | "workflow"
  | "todo" | "recall" | "remember" | "skill" | "mcp" | "ask" | "plan" | "goal" | "other";

const CATEGORY: Record<string, Cat> = {
  Read: "read", Write: "write", Edit: "edit", Bash: "bash", Grep: "grep", Glob: "glob",
  WebFetch: "web", WebSearch: "web",
  Browser: "browser", ReadPage: "browser", Eval: "browser", Network: "browser", Preview: "browser",
  Agent: "agent", Workflow: "workflow", TodoWrite: "todo",
  Recall: "recall", ProjectKnowledge: "recall", Remember: "remember", MemoryAudit: "remember",
  Skill: "skill", McpDescribe: "mcp", McpCall: "mcp",
  AskUserQuestion: "ask", ExitPlanMode: "plan", UpdateGoal: "goal",
};
// 按文件路径去重计数的类目（同一个文件读三遍算一个）
const FILE_CATS = new Set<Cat>(["read", "write", "edit"]);

const catOf = (name: string): Cat => CATEGORY[name] ?? (name.startsWith("mcp__") ? "mcp" : "other");

function catText(cat: Cat, n: number): string {
  switch (cat) {
    case "read": return t("读取了 {n} 个文件", { n });
    case "write": return t("写入了 {n} 个文件", { n });
    case "edit": return t("编辑了 {n} 个文件", { n });
    case "bash": return t("执行了 {n} 条命令", { n });
    case "grep": return t("搜索了代码");
    case "glob": return t("查找了文件");
    case "web": return t("查阅了网页");
    case "browser": return t("操作了浏览器");
    case "agent": return t("委托了 {n} 个子任务", { n });
    case "workflow": return t("编排了 {n} 个工作流", { n });
    case "todo": return t("更新了计划");
    case "recall": return t("检索了记忆");
    case "remember": return t("写入了记忆");
    case "skill": return t("载入了技能");
    case "mcp": return t("调用了连接器");
    case "ask": return t("向你确认了问题");
    case "plan": return t("提交了计划");
    case "goal": return t("汇报了目标");
    default: return t("用了 {n} 个工具", { n });
  }
}

export interface SummaryPiece {
  text: string;
  bad: boolean; // 这一类里有失败 / 被拒的调用
}

export function groupSummary(tools: ToolItem[]): SummaryPiece[] {
  const order: Cat[] = [];
  const cats = new Map<Cat, { keys: Set<string>; bad: boolean }>();
  tools.forEach((tool, i) => {
    const cat = catOf(tool.name);
    const path = tool.args && typeof tool.args === "object" ? tool.args.file_path || tool.args.path : "";
    const key = FILE_CATS.has(cat) && path ? String(path) : tool.id || `#${i}`;
    let c = cats.get(cat);
    if (!c) {
      c = { keys: new Set(), bad: false };
      cats.set(cat, c);
      order.push(cat);
    }
    c.keys.add(key);
    if (tool.status === "fail" || tool.status === "denied") c.bad = true;
  });
  const out = order.map((cat) => ({ text: catText(cat, cats.get(cat)!.keys.size), bad: cats.get(cat)!.bad }));
  // 英文句首大写（中文不受影响）
  if (out[0] && isEn()) out[0].text = out[0].text[0].toUpperCase() + out[0].text.slice(1);
  return out;
}

// 汇总句片段之间的分隔：中文逗号 / 英文逗号加空格
export const summarySep = (): string => (isEn() ? ", " : "，");
