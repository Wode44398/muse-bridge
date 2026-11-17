// 工具行 / 工具组的文字摘要（纯函数，不依赖 Svelte；server/feed-units.test.ts 直接测）。
//
// argPreview：工具行第一行动词后面那段参数摘要（命令 / 路径 / 查询词……）。
// groupSummary：精简模式（默认）下工具组做完后头行那一句——对齐 bridge Claude 分页（= 官方 /code 页 groupSummary）：
//   按类目首次出现的顺序说「读取了 3 个文件，编辑了 1 个文件，执行了 2 条命令」；文件类按路径去重计数，
//   搜索 / 网页这类不数次数；有失败的片段标红。
import type { ToolItem } from "./timeline-types.ts";
import { isEn, t, tc } from "./i18n.ts";

export function argPreview(a: any): string {
  if (!a || typeof a !== "object") return "";
  if (a.command) return String(a.command);
  if (a.path) return String(a.path);
  if (a.file_path) return String(a.file_path);
  if (a.pattern) return String(a.pattern);
  if (a.url) return String(a.url);
  if (a.query) return String(a.query);
  // 会话协作：StartSession 摆任务名；SendMessage / ReadSession 摆对象（与消息开头）
  if ((typeof a.initiation === "string" || typeof a.background === "string") && typeof a.title === "string") return a.title; // 协调者版不带 initiation
  // 项目记忆：摆篇名
  if (typeof a.name === "string" && /\.md$/i.test(a.name)) return a.name;
  if (typeof a.to === "string") return typeof a.message === "string" ? `${a.to} · ${a.message}` : a.to;
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
  ProjectMemoryRead: "recall", ProjectMemoryWrite: "remember", ProjectMemoryDelete: "remember",
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

function fileVerb(cat: Cat): string {
  if (cat === "read") return tc("汇总", "读取");
  if (cat === "write") return tc("汇总", "写入");
  return tc("汇总", "编辑");
}
function fileVerbs(cats: Cat[], name: string): string {
  const v = cats.map(fileVerb);
  if (v.length === 2) return t("{a}并{b}了 {name}", { a: v[0], b: v[1], name });
  return t("{a}、{b}并{c}了 {name}", { a: v[0], b: v[1], c: v[2], name });
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
  // 同一个文件又读又改、组里也只碰了这一个文件：并成一句「读取并编辑了 config.ts」（官方同款），不拆成两句各「1 个文件」
  const fileCats = order.filter((c) => FILE_CATS.has(c));
  const paths = new Set(fileCats.flatMap((c) => [...cats.get(c)!.keys]));
  const merged = fileCats.length > 1 && paths.size === 1 && fileCats.every((c) => cats.get(c)!.keys.size === 1);
  const out: SummaryPiece[] = [];
  for (const cat of order) {
    const c = cats.get(cat)!;
    if (merged && FILE_CATS.has(cat)) {
      if (cat !== fileCats[0]) continue;
      out.push({ text: fileVerbs(fileCats, basename([...paths][0])), bad: fileCats.some((x) => cats.get(x)!.bad) });
      continue;
    }
    out.push({ text: catText(cat, c.keys.size), bad: c.bad });
  }
  // 英文句首大写（中文不受影响）
  if (out[0] && isEn()) out[0].text = out[0].text[0].toUpperCase() + out[0].text.slice(1);
  return out;
}

// 汇总句片段之间的分隔：中文逗号 / 英文逗号加空格
export const summarySep = (): string => (isEn() ? ", " : "，");

// ── 精简模式的单条工具行（对齐 bridge Claude 分页 = 官方 /code 页 toolVerb）──────────────────────────
// 一行 = 动词 + 目标：跑着用进行时（「正在读取」，微光）、做完用完成时（「读取了」）、失败换失败句（「未能读取」，红）；
// 目标是文件名（整条路径放 title 与展开里）、命令、搜索词、网址……命令 / 路径 / 搜索式用等宽。
// 表外的工具（连接器、新加的）退回工具图标表里的动词，三态同一个词。
export interface ToolLine {
  running: string;
  done: string;
  failed: string;
  meta: string;
  // 目标是路径 / 命令 / 搜索式（等宽、墨色）；否则跟随行色
  mono: boolean;
  // meta 被缩成文件名时的整条路径（悬停提示）
  full?: string;
}

type Verbs = () => [string, string, string];
const VERBS: Record<string, Verbs> = {
  Bash: () => [t("正在执行"), t("执行了"), t("未能执行")],
  Read: () => [t("正在读取"), t("读取了"), t("未能读取")],
  Write: () => [t("正在写入"), t("写入了"), t("未能写入")],
  Edit: () => [t("正在编辑"), t("编辑了"), t("未能编辑")],
  Glob: () => [t("正在查找文件"), t("查找了文件"), t("未能查找文件")],
  Grep: () => [t("正在搜索"), t("搜索了"), t("未能搜索")],
  WebFetch: () => [t("正在抓取"), t("抓取了"), t("未能抓取")],
  WebSearch: () => [t("正在搜索网页"), t("搜索了网页"), t("未能搜索网页")],
  TodoWrite: () => [t("正在更新计划"), t("更新了计划"), t("未能更新计划")],
  Preview: () => [t("正在预览"), t("预览了"), t("未能预览")],
  Browser: () => [t("正在操作浏览器"), t("操作了浏览器"), t("未能操作浏览器")],
  ReadPage: () => [t("正在读取页面"), t("读取了页面"), t("未能读取页面")],
  Eval: () => [t("正在页内执行"), t("在页内执行了"), t("未能在页内执行")],
  Network: () => [t("正在审计请求"), t("审计了请求"), t("未能审计请求")],
  Agent: () => [t("正在运行子 agent"), t("运行了子 agent"), t("子 agent 没跑完")],
  Workflow: () => [t("正在运行工作流"), t("运行了工作流"), t("工作流没跑完")],
  AskUserQuestion: () => [t("正在提问"), t("提了问题"), t("未能提问")],
  Remember: () => [t("正在写入记忆"), t("写入了记忆"), t("未能写入记忆")],
  Recall: () => [t("正在检索记忆"), t("检索了记忆"), t("未能检索记忆")],
  ProjectKnowledge: () => [t("正在检索项目知识"), t("检索了项目知识"), t("未能检索项目知识")],
  Skill: () => [t("正在载入技能"), t("载入了技能"), t("未能载入技能")],
  ExitPlanMode: () => [t("正在提交计划"), t("提交了计划"), t("未能提交计划")],
  MemoryAudit: () => [t("正在审计记忆"), t("审计了记忆"), t("未能审计记忆")],
  UpdateGoal: () => [t("正在汇报目标"), t("汇报了目标"), t("未能汇报目标")],
  McpDescribe: () => [t("正在查看连接器"), t("查看了连接器"), t("未能查看连接器")],
  McpCall: () => [t("正在调用连接器"), t("调用了连接器"), t("未能调用连接器")],
  StartSession: () => [t("正在开新会话"), t("开了新会话"), t("未能开新会话")],
  SendMessage: () => [t("正在给会话发消息"), t("给会话发了消息"), t("未能给会话发消息")],
  ListSessions: () => [t("正在查看相关会话"), t("查看了相关会话"), t("未能查看相关会话")],
  ReadSession: () => [t("正在读会话回复"), t("读了会话回复"), t("未能读会话回复")],
  StopSession: () => [t("正在停下讨论串"), t("停下了讨论串"), t("未能停下讨论串")],
  MarkResolved: () => [t("正在标记已解决"), t("标记了已解决"), t("未能标记已解决")],
  ProjectMemoryRead: () => [t("正在读项目记忆"), t("读了项目记忆"), t("未能读项目记忆")],
  ProjectMemoryWrite: () => [t("正在写项目记忆"), t("写了项目记忆"), t("未能写项目记忆")],
  ProjectMemoryDelete: () => [t("正在删项目记忆"), t("删了项目记忆"), t("未能删项目记忆")],
};
// Bash 的另两种用法：查看 / 停掉后台命令
const BASH_POLL: Verbs = () => [t("正在查看后台命令"), t("查看了后台命令"), t("未能查看后台命令")];
const BASH_KILL: Verbs = () => [t("正在停止后台命令"), t("停止了后台命令"), t("未能停止后台命令")];

const FILE_TOOLS = new Set(["Read", "Write", "Edit"]);
const MONO_TOOLS = new Set(["Bash", "Glob", "Grep"]);

export function basename(p: string): string {
  const s = p.trim();
  return s.split(/[\/]/).filter(Boolean).pop() || s;
}
const filePath = (a: any): string => (a && typeof a === "object" ? String(a.file_path || a.path || "") : "");
// 英文句首大写（键与汇总句共用，汇总句里是小写起头）
const cap = (s: string) => (s && isEn() ? s[0].toUpperCase() + s.slice(1) : s);

export function toolLine(name: string, args: any, fallbackVerb: string): ToolLine {
  const a = args && typeof args === "object" ? args : {};
  let verbs = VERBS[name];
  let meta = argPreview(a);
  if (name === "Bash" && !a.command && (a.poll || a.kill)) {
    verbs = a.poll ? BASH_POLL : BASH_KILL;
    meta = String(a.poll || a.kill);
  }
  // 搜索说搜的是什么（argPreview 先取路径，那是搜索范围）
  if ((name === "Grep" || name === "Glob") && a.pattern) meta = String(a.pattern);
  const [running, done, failed] = verbs ? verbs() : [fallbackVerb, fallbackVerb, fallbackVerb];
  const line: ToolLine = { running: cap(running), done: cap(done), failed: cap(failed), meta, mono: MONO_TOOLS.has(name) };
  if (FILE_TOOLS.has(name) && filePath(a)) {
    const full = filePath(a);
    line.meta = basename(full);
    line.mono = true;
    if (line.meta !== full) line.full = full;
  }
  return line;
}

// 同一文件连续几次读（分段读）并成一行时，行尾的行号范围「(1–200, 201–400)」；有一次没给范围就不显示
export function readRanges(tools: { args: any }[]): string {
  const rs = tools.map((x) => {
    const a = x.args && typeof x.args === "object" ? x.args : {};
    if (a.offset === undefined && a.limit === undefined) return null;
    const s = Number(a.offset) || 1;
    const l = Number(a.limit);
    return l > 0 ? `${s}–${s + l - 1}` : `${s}–`;
  });
  return rs.length > 1 && rs.every(Boolean) ? `(${rs.join(", ")})` : "";
}

// 展开后的参数表（对齐官方 /code 页工具行的展开体）：常用键在前；路径摆成小片、命令 / 搜索式摆成等宽块（命令带「$ 」）
const PARAM_ORDER = ["file_path", "path", "command", "pattern", "glob", "url", "query", "description", "prompt", "offset", "limit"];
const PARAM_CHIP = new Set(["file_path", "path"]);
const PARAM_CODE = new Set(["command", "pattern", "regex", "glob", "script", "code", "expression"]);
export interface ToolParam {
  key: string;
  value: string;
  chip: boolean;
  code: boolean;
  prefix: string;
}
export function toolParams(args: any): ToolParam[] {
  if (!args || typeof args !== "object") return [];
  const keys = Object.keys(args).filter((k) => args[k] !== undefined && args[k] !== null && args[k] !== "");
  const rank = (k: string) => {
    const i = PARAM_ORDER.indexOf(k);
    return i < 0 ? 99 : i;
  };
  keys.sort((x, y) => rank(x) - rank(y) || x.localeCompare(y));
  return keys.map((k) => {
    const v = args[k];
    return {
      key: k,
      value: typeof v === "string" ? v : JSON.stringify(v, null, typeof v === "object" ? 2 : undefined),
      chip: PARAM_CHIP.has(k),
      code: PARAM_CODE.has(k),
      prefix: k === "command" ? "$ " : "",
    };
  });
}

// ── 思考的文案（对齐官方 /code 页：想的时候按已想时长分档，15 / 30 / 45 / 60 秒；想完写「已思考 N 秒」）──
export function thinkingLabel(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  if (s >= 60) return t("快想好了…");
  if (s >= 45) return t("还在深入思考…");
  if (s >= 30) return t("深入思考中…");
  if (s >= 15) return t("仍在思考…");
  return t("思考中…");
}
// 没量到时长（历史重建、整轮重放灌进来的）或不足 1 秒：只说「思考过程」
export function thoughtLabel(ms: number | undefined): string {
  if (ms === undefined || ms < 1000) return t("思考过程");
  const s = Math.round(ms / 1000);
  return s < 60 ? t("已思考 {n} 秒", { n: s }) : t("已思考 {m} 分 {s} 秒", { m: Math.floor(s / 60), s: s % 60 });
}

