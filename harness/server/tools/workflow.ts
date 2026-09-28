import fs from "node:fs";
import path from "node:path";
import type { PreparedCall, Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail } from "./types.ts";
import { compileWorkflowBody, extractWorkflowMeta, type WorkflowMeta } from "../agent/workflow.ts";
import { readVerdict } from "../sandbox.ts";
import { SUBAGENT_REPORT_NOTE } from "./untrusted.ts";

// O5（H3）：脚本草稿落在会话工作区的 .dimensio/workflows/ 下（目录里一个内容为 * 的 .gitignore，git 看不见；也不进检查点）。
// 编不过或要小改时，模型用 Edit 改这个文件、再以 scriptPath 重交，不用把整段脚本再发一遍。
export const WORKFLOW_DRAFT_DIR = path.join(".dimensio", "workflows");

function saveDraft(root: string, name: string, script: string): string | null {
  const slug = name.toLowerCase().replace(/[^a-z0-9一-鿿-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "workflow";
  try {
    const dir = path.join(root, WORKFLOW_DRAFT_DIR);
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, ".gitignore");
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "*\n");
    const file = path.join(dir, `${slug}.js`);
    fs.writeFileSync(file, script);
    return file;
  } catch {
    return null; // 存不成只是少了草稿，不挡这次提交
  }
}

// scriptPath：工作区里的 .js / .mjs 文件，过与 Read 同一道密钥判定（编不过时报错会带出出错那一行，不能把它变成读凭据的口子）
function readScriptPath(ctx: ToolContext, raw: string): { ok: true; script: string } | { ok: false; error: string } {
  let abs: string;
  try {
    abs = ctx.sandbox.resolve(raw);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!/\.(?:m?js)$/i.test(abs)) return { ok: false, error: "scriptPath must point to a .js or .mjs file (the drafts live in .dimensio/workflows/)." };
  const blocked = readVerdict(abs, ctx.sandbox.root);
  if (blocked) return { ok: false, error: blocked };
  try {
    return { ok: true, script: fs.readFileSync(abs, "utf8") };
  } catch (e) {
    return { ok: false, error: `could not read ${raw}: ${(e as Error).message}` };
  }
}

// The Workflow tool: run a script that orchestrates sub-agents deterministically
// (see agent/workflow.ts for the script API). Thin shell — the session wires
// the runner into ToolContext.runWorkflow. Before anything runs, the script's
// meta is extracted statically and put to the user as a permission card (name,
// description, phases) when a human is attached; headless runs proceed.
//
// effect "exec"（S2 止血，#35）：以前标 "read"，理由是只读 / plan 模式下 runner 只派
// research agent。但脚本本身跑在 vm 里，而 vm 不是安全边界（注入的宿主函数能摸回宿主
// realm），标 read 等于让只读 / plan 模式放行一段任意代码。现在按执行类工具算：只读 /
// plan 一律拒绝，auto 下照旧先弹确认卡。根治（脚本挪进 env 清洗、权限受限的子进程，
// agent() 经 IPC 回主进程走权限链）在阶段 2。

const RESULT_TEXT_CAP = 60_000;
// P11：卡片上摆的脚本正文最多这么多字符（再长就截断、标出来）
const SCRIPT_PREVIEW_CAP = 8000;

// 从参数拿到脚本（script，或 scriptPath 指的草稿）、读 meta、落草稿、只编译不执行。prepare() 与 run() 共用——草稿按名字
// 同名覆盖，写两次无妨。O5（H3）：编不过就在弹卡之前退回，报的是用户脚本里的行号与那一行。
type LoadedWorkflow =
  | { ok: true; script: string; meta: WorkflowMeta }
  | { ok: false; summary: string; content: string };

function loadWorkflow(args: Record<string, unknown>, ctx: ToolContext): LoadedWorkflow {
  let script = String(args.script ?? "");
  const scriptPath = typeof args.scriptPath === "string" ? args.scriptPath.trim() : "";
  if (!script.trim() && scriptPath) {
    const read = readScriptPath(ctx, scriptPath);
    if (!read.ok) return { ok: false, summary: "bad scriptPath", content: read.error };
    script = read.script;
  }
  if (!script.trim()) return { ok: false, summary: "empty script", content: "Provide the workflow script (`script`, or `scriptPath` to a draft file)." };
  if (!ctx.runWorkflow) return { ok: false, summary: "unavailable", content: "Workflows are not available in this context." };

  const parsed = extractWorkflowMeta(script);
  if (!parsed.ok) return { ok: false, summary: "bad workflow meta", content: parsed.error };

  // 草稿先落盘（从 scriptPath 读来的就是它自己，不再写一份），然后只编译、不执行
  const draft = scriptPath ? null : saveDraft(ctx.sandbox.root, parsed.meta.name, script);
  const draftNote = draft ? ` The script was saved to ${ctx.sandbox.rel(draft)} — Edit it and resubmit with scriptPath.` : "";
  const compiled = compileWorkflowBody(parsed.body);
  if (!compiled.ok) {
    return {
      ok: false,
      summary: "script does not compile",
      content:
        `The workflow script does not compile${compiled.line ? ` (line ${compiled.line}${compiled.snippet ? `: ${compiled.snippet}` : ""})` : ""}: ${compiled.message}. ` +
        `Nothing was shown to the user and nothing ran.${draftNote}`,
    };
  }
  return { ok: true, script, meta: parsed.meta };
}

export const workflowTool: Tool = {
  effect: "exec",
  concurrencySafe: false,
  def: {
    name: "Workflow",
    description:
      "Run a JavaScript orchestration script that spawns sub-agents deterministically — fan-out, pipelines, " +
      "loops, adversarial verification — instead of driving each step by hand. Use it for work that should " +
      "be decomposed across many independent agents (review a diff across dimensions then verify each " +
      "finding, survey many subsystems in parallel, migrate N call sites). The script MUST begin with " +
      "`export const meta = { name, description, phases?: [{title, detail?}] }` as a pure literal (it is " +
      "read without executing the script and shown to the user for confirmation). Body API: " +
      "`await agent(prompt, {label?, phase?, schema?, tools?:'research'|'coder', model?, effort?, maxTurns?})` " +
      "→ the sub-agent's final text, or with `schema` the validated object (null if it failed); " +
      "`pipeline(items, stage1, stage2, …)` runs each item through all stages independently (no barrier; a " +
      "failing item becomes null); `parallel([() => agent(…), …])` is a barrier that awaits all (failures → " +
      "null); `phase(title)` groups subsequent agents; `log(text)` shows progress to the user; `args` is the " +
      "value you pass in `args`; `budget.remaining()` is the token budget left. Plain JS, top-level await, " +
      "`return` the final value (plain JSON). No filesystem/Node access inside the script — agents do the " +
      "work. Sub-agents see nothing of this conversation: write self-contained prompts. Results are " +
      "journaled per agent call: pass `resumeFromRunId` with an edited script to re-run only the changed calls. " +
      "Write meta.name, meta.description, phase titles and agent labels as short natural phrases in the user's language — " +
      "they are shown to the user on their phone. The script is compiled (not run) before the confirmation card: if it does " +
      "not compile you get the error and line back; every submitted script is saved as a draft under .dimensio/workflows/ — " +
      "for a small fix, Edit that draft and resubmit with `scriptPath` instead of sending the whole script again.",
    parameters: {
      type: "object",
      properties: {
        script: { type: "string", description: "The workflow script (plain JavaScript, starts with `export const meta = {…}`)." },
        scriptPath: { type: "string", description: "Instead of `script`: a workspace .js file holding it (e.g. the draft under .dimensio/workflows/)." },
        args: { type: "object", description: "Value exposed to the script as `args` (any JSON; arrays are fine)." },
        resumeFromRunId: { type: "string", description: "A previous run's id (wf_…) whose journal should answer unchanged agent() calls." },
        maxConcurrency: { type: "integer", minimum: 1, maximum: 8, description: "Concurrent sub-agents (default 3)." },
        tokenBudget: { type: "integer", minimum: 10000, description: "Total token budget across all sub-agents (default 8,000,000)." },
        deadlineMinutes: {
          type: "integer",
          minimum: 5,
          maximum: 360,
          description: "Soft time limit (default 60): after it no new agents start — agent() returns null — and running ones get 10 more minutes to finish.",
        },
      },
    },
  },
  // P11（ZCode C2，kimi K20）：启动前确认挪进统一权限闸。以前在 run() 里另弹一张卡：没有 requestPermission 的上下文
  // （子 agent、无头）直接跳过确认就跑；用户写的 allow 规则放不开它；判定不进权限审计。现在这里只做规划——编不过 /
  // 读不到脚本就否决（不弹卡），否则要求确认并把脚本正文摆上卡片；卡由 loop 按统一规则弹（「本会话都允许」记的是
  // 裸 `Workflow` 规则 = 本会话之后的工作流都不再确认，与 P1 相同）。
  async prepare(args: Record<string, unknown>, ctx: ToolContext): Promise<PreparedCall> {
    const loaded = loadWorkflow(args, ctx);
    if (!loaded.ok) return { veto: { summary: loaded.summary, content: loaded.content } };
    const { meta, script } = loaded;
    const shown = script.length > SCRIPT_PREVIEW_CAP ? script.slice(0, SCRIPT_PREVIEW_CAP) : script;
    return {
      confirm: {
        reason: `starting workflow "${meta.name}" fans out sub-agents, so the user confirms it first`,
        why: `要启动工作流「${meta.name}」：按下面的脚本派出多个子 agent 干活`,
      },
      preview: {
        kind: "script",
        name: meta.name,
        description: meta.description,
        phases: meta.phases.map((p) => p.title),
        script: shown,
        lines: script.split("\n").length,
        ...(shown.length < script.length ? { truncated: true } : {}),
      },
    };
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    // 确认已经在统一权限闸里做过了（prepare 的 confirm → 权限卡）；这里再核一遍脚本（直接调 run 的也不会跑坏脚本）然后跑
    const loaded = loadWorkflow(args, ctx);
    if (!loaded.ok) return fail(loaded.summary, loaded.content);
    const { meta, script } = loaded;
    const runWorkflow = ctx.runWorkflow!; // loadWorkflow 已确认有

    let r;
    try {
      r = await runWorkflow({
        script,
        args: args.args,
        resumeFromRunId: typeof args.resumeFromRunId === "string" ? args.resumeFromRunId.trim() : undefined,
        signal: ctx.signal,
        onEvent: ctx.emit,
        toolId: ctx.callId,
        limits: {
          maxConcurrency: typeof args.maxConcurrency === "number" ? args.maxConcurrency : undefined,
          tokenBudget: typeof args.tokenBudget === "number" ? args.tokenBudget : undefined,
          // R18：模型可以按规模给时限（软停，见 agent/workflow.ts 的 DEADLINE_GRACE_MS）
          deadlineMs: typeof args.deadlineMinutes === "number" ? args.deadlineMinutes * 60_000 : undefined,
        },
      });
    } catch (e) {
      return fail("workflow failed", `Workflow threw: ${(e as Error).message}`);
    }

    const failed = r.agents.filter((a) => !a.ok);
    // V5（#20）：工作流里 coder 改过的文件交给父会话的验证门禁（成没成都算）
    const editedAll = [...new Set(r.agents.flatMap((a) => a.editedFiles ?? []))];
    const edited = {
      ...(editedAll.length ? { editedFiles: editedAll } : {}),
      // K9（X55）：任何一个 agent 读过外部内容，这份报告就带着它（失败的也算——日志、错误里一样会有）
      ...(r.agents.some((a) => a.externalContent) ? { externalContent: true } : {}),
    };
    const statLine =
      `${r.agents.length} agent call${r.agents.length === 1 ? "" : "s"}` +
      (r.cached ? ` (${r.cached} from journal)` : "") +
      (failed.length ? `, ${failed.length} failed` : "") +
      (r.skipped ? `, ${r.skipped} not started (deadline reached)` : "") +
      `, ${r.inputTokens + r.outputTokens} tokens, ${Math.round(r.durationMs / 1000)}s`;
    const meta_ = {
      workflow: {
        id: r.id,
        name: r.name,
        description: r.description,
        phases: r.phases,
        ok: r.ok,
        error: r.error,
        agents: r.agents,
        cached: r.cached,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        durationMs: r.durationMs,
        startedAt: r.startedAt,
        logs: r.logs.slice(-40),
      },
    };

    let resultText = "";
    if (r.result !== undefined) {
      try {
        resultText = typeof r.result === "string" && r.resultTruncated ? r.result : JSON.stringify(r.result, null, 2);
      } catch {
        resultText = String(r.result);
      }
      if (resultText.length > RESULT_TEXT_CAP) resultText = resultText.slice(0, RESULT_TEXT_CAP) + "\n…[truncated]";
      else if (r.resultTruncated) resultText += "\n…[truncated]";
    }
    const failures = failed.length
      ? `\nFailed agents:\n${failed.slice(0, 10).map((a) => `- ${a.label}: ${a.error ?? "unknown error"}`).join("\n")}`
      : "";
    const logTail = r.logs.length ? `\nLog:\n${r.logs.slice(-12).map((l) => `- ${l}`).join("\n")}` : "";

    if (!r.ok) {
      return {
        ok: false,
        summary: `workflow ${r.name}: ${r.error ?? "failed"} (${statLine})`,
        content: [{
          t: "text",
          text: `Workflow "${r.name}" failed: ${r.error}\nrunId: ${r.id} (resumeFromRunId reuses the ${r.agents.filter((a) => a.ok).length} completed agent results)\n${statLine}${failures}${logTail}`,
        }],
        meta: meta_,
        ...edited,
      };
    }
    return {
      ok: true,
      summary: `workflow ${r.name}: ${statLine}`,
      content: [{
        t: "text",
        text:
          `Workflow "${r.name}" finished. runId: ${r.id}\n${statLine}${failures}${logTail}\n\nResult:\n${SUBAGENT_REPORT_NOTE}\n` +
          (resultText || "(the script returned nothing)"),
      }],
      meta: meta_,
      ...edited,
    };
  },
};
