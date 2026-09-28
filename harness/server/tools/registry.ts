import type { ToolDef } from "../agent/turn.ts";
import type { Tool } from "./types.ts";
import { readTool } from "./read.ts";
import { writeTool } from "./write.ts";
import { editTool } from "./edit.ts";
import { bashTool } from "./bash.ts";
import { grepTool } from "./grep.ts";
import { globTool } from "./glob.ts";
import { todoTool } from "./todo.ts";
import { previewTool } from "./preview.ts";
import { browserTool } from "./browser.ts";
import { readPageTool } from "./readpage.ts";
import { evalTool } from "./evaljs.ts";
import { networkTool } from "./network.ts";
import { rememberTool } from "./remember.ts";
import { recallTool } from "./recall.ts";
import { memoryAuditTool } from "./memoryaudit.ts";
import { verificationAuditTool } from "./verificationaudit.ts";
import { webfetchTool } from "./webfetch.ts";
import { webSearchTool } from "./websearch.ts";
import { agentTool } from "./agent.ts";
import { workflowTool } from "./workflow.ts";
import { askUserQuestionTool } from "./ask.ts";
import { exitPlanModeTool } from "./exitplanmode.ts";
import { projectKnowledgeTool } from "./projectknowledge.ts";
import { skillTool } from "./skill.ts";
import { localPcInspectTool, localPcActTool } from "./localpc.ts";
import { disabledTools } from "../tenant.ts";

export const ALL_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  bashTool,
  grepTool,
  globTool,
  agentTool,
  workflowTool,
  askUserQuestionTool,
  exitPlanModeTool,
  todoTool,
  previewTool,
  browserTool,
  readPageTool,
  evalTool,
  networkTool,
  webfetchTool,
  webSearchTool,
  rememberTool,
  recallTool,
  projectKnowledgeTool,
  skillTool,
  memoryAuditTool,
  verificationAuditTool,
  localPcInspectTool,
  localPcActTool,
];

function enabledTools(): Tool[] {
  // DIMENSIO_DISABLED_TOOLS / 租户模式的默认禁用（见 tenant.ts）：一处拿掉，主会话与子 agent 都看不到。
  const off = disabledTools();
  return ALL_TOOLS.filter((tool) => {
    if (off.has(tool.def.name)) return false;
    try { return tool.enabled ? tool.enabled() : true; } catch { return false; }
  });
}

export function toolMap(): Map<string, Tool> {
  const m = new Map<string, Tool>();
  for (const t of enabledTools()) m.set(t.def.name, t);
  return m;
}

export function toolDefs(): ToolDef[] {
  return enabledTools().map((t) => t.def);
}
