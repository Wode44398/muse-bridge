// 由 lucide-paths.json + 自绘件生成 harness/web/src/lib/icons.ts（保留原文件里「品牌 logo path」一节）
//   node harness/web/brand/icons/fetch-icons.mjs   （联网拉 Lucide，写 lucide-paths.json）
//   node harness/web/brand/icons/gen-icons.mjs
import fs from "node:fs";

const HERE = new URL(".", import.meta.url);
const TARGET = new URL("../../src/lib/icons.ts", HERE);
const j = JSON.parse(fs.readFileSync(new URL("lucide-paths.json", HERE), "utf8"));
const old = fs.readFileSync(TARGET, "utf8");
const logos = old.slice(old.indexOf("// ── 品牌 logo path"));

const custom = {
  menu: "M4 8.5h16M4 15.5h16",
  stop: "M8.5 7h7A1.5 1.5 0 0 1 17 8.5v7a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 15.5v-7A1.5 1.5 0 0 1 8.5 7Z",
  dot: "M9.5 12a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0Z",
  // 品牌母题的线稿版：两个点 + 尺寸线 + 两根干
  measure: "M3.4 7.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0ZM17.4 7.5a1.6 1.6 0 1 0 3.2 0a1.6 1.6 0 1 0-3.2 0ZM6.6 7.5h10.8M5 11.5v7M19 11.5v7",
};
const TOOLS = [
  ["Bash", "terminal", "执行命令"],
  ["Read", "fileText", "读取文件"],
  ["Write", "filePlus", "写入文件"],
  ["Edit", "edit", "编辑文件"],
  ["Glob", "folderSearch", "匹配文件"],
  ["Grep", "textSearch", "搜索内容"],
  ["TodoWrite", "todo", "更新计划"],
  ["Preview", "eye", "预览验证"],
  ["Browser", "appWindow", "操作浏览器"],
  ["ReadPage", "read", "读取页面"],
  ["Eval", "flask", "页内执行"],
  ["Network", "network", "审计请求"],
  ["WebFetch", "globe", "抓取网页"],
  ["WebSearch", "search", "联网搜索"],
  ["Agent", "agent", "委托子任务"],
  ["Workflow", "workflow", "编排工作流"],
  ["AskUserQuestion", "question", "询问确认"],
  ["Remember", "memory", "写入记忆"],
  ["Recall", "memory", "检索记忆"],
  ["Skill", "spark", "载入技能"],
  ["ExitPlanMode", "todo", "提交计划"],
  ["MemoryAudit", "checkCircle", "记忆审计"],
  ["UpdateGoal", "goal", "汇报目标"],
  ["McpDescribe", "plug", "查看连接器"],
  ["McpCall", "plug", "调用连接器"],
];

const keys = [...new Set([...Object.keys(custom), ...Object.keys(j)])].sort();
const out = `// 图标：24×24 线稿，currentColor 描边、圆帽圆角（stroke 粗细由 Icon.svelte 给，默认 1.6）。
// 绝大多数取自 Lucide（ISC License, Copyright (c) Lucide Contributors — https://lucide.dev），多元素 SVG 已并成单条 path；
// menu / stop / dot / measure 为本项目自绘。键名是契约（组件、工具映射都按名取），只增不改。

export const I = {
${keys.map((k) => `  ${k}: ${JSON.stringify(custom[k] ?? j[k])},`).join("\n")}
} as const;

export type IconName = keyof typeof I;

// ── 工具名 → 图标 / 中文动词（动词是界面文案，活动行、工具行都用它）────────────────────────
export const TOOL_META: Record<string, { icon: IconName; verb: string }> = {
${TOOLS.map(([n, i, v]) => `  ${n}: { icon: "${i}", verb: "${v}" },`).join("\n")}
};
export const toolMeta = (name: string): { icon: IconName; verb: string } => {
  const hit = TOOL_META[name];
  if (hit) return hit;
  // E1：MCP 连接器的工具 mcp__<连接器>__<工具> →「连接器 · 工具」
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return { icon: "plug", verb: \`\${m[1]} · \${m[2]}\` };
  return { icon: "spark", verb: name };
};

${logos}`;
fs.writeFileSync(TARGET, out);
console.log("icons", keys.length);
