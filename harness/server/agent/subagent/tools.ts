// 子 agent 的工具集：内置两档（research = 读 / 搜 / 取网页 + 只读 Bash；coder = 再加 Write / Edit / Bash），自定义类型按定义里的
// 工具名单从同一批里挑，fork 沿用父会话的整张工具表（定义原样、顺序不变，吃得到提示缓存），只是派子 agent、问人、写记忆这些
// 在子 agent 里没有意义的工具换成一句「这里不能用」。research 的 Bash 只读由权限档（read-only）保证，不靠提示词。
import type { JsonObjectSchema } from "../turn.ts";
import type { SubAgentTier } from "../events.ts";
import type { Tool } from "../../tools/types.ts";
import { fail, ok } from "../../tools/types.ts";
import { readTool } from "../../tools/read.ts";
import { grepTool } from "../../tools/grep.ts";
import { globTool } from "../../tools/glob.ts";
import { webfetchTool } from "../../tools/webfetch.ts";
import { webSearchTool, webSearchAvailable } from "../../tools/websearch.ts";
import { writeTool } from "../../tools/write.ts";
import { editTool } from "../../tools/edit.ts";
import { bashTool } from "../../tools/bash.ts";
import { disabledTools } from "../../tenant.ts";
import { verificationAuditTool } from "../../tools/verificationaudit.ts";
import { coerceToSchema, formatSchemaErrors, validateSchema } from "../schema.ts";
import { shapeVerifyTools } from "../verify-tools.ts";

const WRITE_TOOLS = new Set(["Write", "Edit"]);
// 名单里有这些就是「会动手」的类型（会话在 auto 时按 coder 档的权限跑）：Bash 也算——Claude Code 里 `tools: Read, Bash` 的
// test-runner / reviewer 就是要跑 npm test 这类命令的，按只读档跑等于没给它 Bash
const ACTING_TOOLS = new Set([...WRITE_TOOLS, "Bash"]);

function available(): Map<string, Tool> {
  const all: Tool[] = [readTool, grepTool, globTool, webfetchTool];
  if (webSearchAvailable()) all.push(webSearchTool);
  all.push(writeTool, editTool, bashTool);
  // 关掉的工具子 agent 也不许有（没有命令行的租户，子 agent 同样没有 Bash），见 tenant.ts。
  const off = disabledTools();
  return new Map(all.filter((t) => !off.has(t.def.name)).map((t) => [t.def.name, t]));
}

export function tierTools(tier: SubAgentTier, verifyTools: "on" | "off"): Tool[] {
  const pool = available();
  const names = tier === "coder"
    ? ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Write", "Edit", "Bash"]
    : ["Read", "Grep", "Glob", "WebFetch", "WebSearch", "Bash"];
  const tools = names.flatMap((n) => (pool.has(n) ? [pool.get(n)!] : []));
  if (tier === "coder") tools.push(verificationAuditTool);
  // 档案的验证工具形状：lean 不带 verify 参数、不给 VerificationAudit（agent/verify-tools.ts）
  return shapeVerifyTools(tools, verifyTools);
}

/** 自定义类型的工具：名单（大小写不敏感）里认得的；没写名单 = 按 coder / research 档继承。认不出的名字报回去。 */
export function customTools(
  names: string[] | undefined,
  inherit: SubAgentTier,
  verifyTools: "on" | "off",
): { tools: Tool[]; unknown: string[]; writes: boolean } {
  if (!names) {
    const tools = tierTools(inherit, verifyTools);
    return { tools, unknown: [], writes: inherit === "coder" };
  }
  const pool = available();
  const byLower = new Map([...pool.keys()].map((n) => [n.toLowerCase(), n]));
  const picked: Tool[] = [];
  const unknown: string[] = [];
  for (const raw of names) {
    const want = raw.trim();
    const hit = byLower.get(want.toLowerCase()) ?? (want.toLowerCase() === "multiedit" ? "Edit" : undefined);
    if (!hit) {
      unknown.push(want);
      continue;
    }
    const tool = pool.get(hit)!;
    if (!picked.includes(tool)) picked.push(tool);
  }
  const writes = picked.some((t) => ACTING_TOOLS.has(t.def.name));
  // 验证审计只跟改文件的工具走（hardened 下 coder 档的 VerificationAudit）
  if (picked.some((t) => WRITE_TOOLS.has(t.def.name))) picked.push(verificationAuditTool);
  return { tools: shapeVerifyTools(picked, verifyTools), unknown, writes };
}

// fork 里不能用的工具：派子 agent / 工作流、问人、交计划、写记忆、开 / 停 / 发会话、改目标、标记讨论串、操作 PR、约定时唤醒（唤醒记在
// 父会话名下，到点给父会话开一轮——fork 只交回报告）——换成同名的拒绝，说明照旧（工具表不变）
const FORK_BLOCKED = /^(Agent|Workflow|AskUserQuestion|ExitPlanMode|Remember|MemoryAudit|UpdateGoal|StartSession|StopSession|SendMessage|MarkResolved|PullRequest|ProjectMemoryWrite|ProjectMemoryDelete|ScheduleWakeup)$/;

export function forkToolMap(parent: Map<string, Tool>): Map<string, Tool> {
  const out = new Map<string, Tool>();
  for (const [name, tool] of parent) {
    if (!FORK_BLOCKED.test(name)) {
      out.set(name, tool);
      continue;
    }
    out.set(name, {
      def: tool.def,
      effect: "read",
      concurrencySafe: true,
      looseRequired: true,
      async run() {
        return fail("not available", `${name} is not available inside a forked sub-agent. Do the work yourself and put the result in your final report.`);
      },
    });
  }
  return out;
}

export interface SubmitHolder {
  value: unknown;
  attempts: number;
  maxAttempts: number; // 校验失败的总机会数（档案 loop.submitAttempts）
  exhausted: boolean;
  lastErrors: string;
}

export function makeSubmitTool(schema: JsonObjectSchema, holder: SubmitHolder): Tool {
  return {
    effect: "read",
    concurrencySafe: false,
    // 自己按整份 schema 校验并记次数（缺必填也算一次没交对）：loop 的通用缺参拦截不替它拦
    looseRequired: true,
    def: {
      name: "SubmitResult",
      description:
        "Deliver your final result. The arguments MUST match this schema exactly — it is what the caller " +
        "consumes programmatically. Call it once, when you have the data; text outside this call is discarded. " +
        "If the call is rejected, fix the listed problems and call it again.",
      parameters: schema,
    },
    async run(rawArgs) {
      // O5（H4）：先按 schema 宽容修正（JSON 字符串包着的对象 / 数组 parse 一次，数字 / 布尔字符串转回来）——修正本身不算
      // 一次修复机会；修正后还不对，报的是修正后对象上的问题
      const args = coerceToSchema(schema, rawArgs).value as Record<string, unknown>;
      const errors = validateSchema(schema, args);
      if (errors.length) {
        holder.attempts++;
        holder.lastErrors = formatSchemaErrors(errors);
        const left = holder.maxAttempts - holder.attempts;
        if (left <= 0) {
          holder.exhausted = true;
          return fail("result rejected", `Result rejected (no attempts left):\n${holder.lastErrors}`);
        }
        return fail(
          "result rejected",
          `Result rejected (${left} attempt${left === 1 ? "" : "s"} left). Fix these and call SubmitResult again:\n${holder.lastErrors}`,
        );
      }
      holder.value = args;
      return ok("result accepted", "Result accepted. You are done — stop now.");
    },
  };
}
