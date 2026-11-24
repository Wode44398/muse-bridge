// 子 agent 的系统提示词：精简版（lean，默认）与加固版（hardened，姿态改造前的原文），外加自定义类型的正文、worktree 隔离
// 这两样事实。fork 出来的子 agent 不用这里：它沿用父会话的 system（吃提示缓存）。
import type { SubAgentTier } from "../events.ts";
import type { ModelProfile } from "../profile.ts";
import { shell } from "../../tools/bash.ts";

export interface SubPromptEnv {
  root: string;
  platform: string;
  tier: SubAgentTier;
  toolNames: string[];
  fullAccess: boolean;
  schema: boolean;
  extra?: string;
  // C6（G3）：从父会话继承的项目指令（AGENTS.md、GUIDE.md），框定与主会话一致
  inherited?: string;
  // 模型档案（按路由后的目标型号解析）：姿态决定用 lean 还是 hardened 那版正文；不给 = lean
  profile?: ModelProfile;
  // 自定义类型（.claude/agents 等处的定义）：名字与正文
  custom?: { name: string; prompt: string };
  // 跑在自己的 worktree 里
  isolation?: { path: string; branch: string; base: string };
}

export function subSystemPrompt(env: SubPromptEnv): string {
  return env.profile?.posture === "hardened" ? hardenedSubPrompt(env) : leanSubPrompt(env);
}

const hasBash = (env: SubPromptEnv) => env.toolNames.includes("Bash");

function isolationLine(env: SubPromptEnv): string {
  const w = env.isolation;
  return w
    ? `\n- This is your own git worktree (branch ${w.branch}, started from commit ${w.base.slice(0, 12)}); the main agent's uncommitted changes are not in it. Leave your changes here (committing on this branch is fine); the main agent reviews and merges them.`
    : "";
}

function customHead(env: SubPromptEnv, fallback: string): string {
  if (!env.custom) return fallback;
  const body = env.custom.prompt.trim();
  const head = `You are the "${env.custom.name}" sub-agent inside a coding-agent harness. A main agent delegated a task to you; it sees nothing of your work except your final deliverable.`;
  return body ? `${head}\n\n${body}` : head;
}

// 默认的精简版：交代角色、环境、工具与交付方式，验证只说一句能验就验、如实报告
function leanSubPrompt(env: SubPromptEnv): string {
  const reach = env.fullAccess
    ? " — you may also work on other paths on this machine (absolute paths) when the task points there."
    : " — stay inside it.";
  const role = customHead(
    env,
    env.tier === "coder"
      ? "You are a coding sub-agent inside a coding-agent harness. A main agent delegated one self-contained implementation task to you; it sees nothing of your work except your final deliverable."
      : "You are a read-only research sub-agent inside a coding-agent harness. A main agent delegated one focused task to you; it sees nothing of your work except your final deliverable.",
  );
  const toolsLine = env.tier === "coder"
    ? `${env.toolNames.join(", ")}. You can edit files and run commands. Do not start web servers or other long-lived processes; Bash(background:true) is only for finite long commands. Shell: ${shell.kind}.`
    : hasBash(env)
      ? `${env.toolNames.join(", ")}. Bash runs read-only commands only (git log/diff/show, ls, grep and the like; shell: ${shell.kind}); edits and commands that change anything are blocked — if the task needs one, report precisely what the caller should do.`
      : `${env.toolNames.join(", ")}. You cannot edit files or run commands; if the task seems to need an action, report precisely what the caller should do.`;
  const work = env.tier === "coder"
    ? `You cannot ask questions, so make reasonable assumptions and state them in your deliverable. Find and read what matters, make focused changes, and check them where you can (the relevant tests, build or program). Stay on the task.`
    : `You cannot ask questions, so make reasonable assumptions and state them in your deliverable. Independent lookups in one turn run in parallel. Stay on the task and stop as soon as you can answer it.`;
  const deliverable = env.schema
    ? `## Deliverable
Deliver by calling SubmitResult: its parameters are the exact schema the caller consumes, and text outside that call is discarded. If it is rejected, fix the listed problems and call it again.`
    : `## Deliverable
Your final message is returned verbatim to the caller and is all it gets: include concrete file paths with line numbers, exact names and short snippets where they matter, ${env.tier === "coder" ? "which files you changed and what you checked (command and outcome), " : ""}and a direct answer to what was asked.`;
  const extra = env.extra?.trim() ? `\n\n## Additional instructions from the caller\n${env.extra.trim()}` : "";
  const inherited = env.inherited?.trim() ? `\n\n${env.inherited.trim()}` : "";
  return `${role}

## Environment
- Working directory (sandbox root): ${env.root}${reach}${isolationLine(env)}
- Platform: ${env.platform}

## Tools
${toolsLine}

## How to work
${work}

${deliverable}${inherited}${extra}`;
}

// 加固版 = 姿态改造前的原文（新能力的事实另起一句补在相应位置）
function hardenedSubPrompt(env: SubPromptEnv): string {
  const reach = env.fullAccess
    ? " — you may also work on other paths on this machine (absolute paths) when the task points there."
    : " — stay inside it.";
  const role = customHead(
    env,
    env.tier === "coder"
      ? "You are a coding sub-agent inside a coding-agent harness. A main agent delegated ONE self-contained implementation task to you; it sees nothing of your work except your final deliverable."
      : "You are a read-only research sub-agent inside a coding-agent harness. A main agent delegated ONE focused task to you; it sees nothing of your work except your final deliverable.",
  );
  const toolsLine = env.tier === "coder"
    ? `${env.toolNames.join(", ")}. You can edit files and run commands. Read a file before you Edit it. Never start a web server or any long-lived process; Bash(background:true) is only for finite long commands. Shell: ${shell.kind}.`
    : hasBash(env)
      ? `${env.toolNames.join(", ")}. You canNOT edit files. Bash runs read-only commands only (git log/diff/show, ls, grep …; shell: ${shell.kind}) — anything that changes files or state is blocked. If the task seems to require an action, report precisely what the caller should do instead.`
      : `${env.toolNames.join(", ")}. You canNOT edit files or run commands. If the task seems to require an action, report precisely what the caller should do instead.`;
  const work = env.tier === "coder"
    ? `1. Work autonomously. Never ask questions — make reasonable assumptions and state them in your deliverable.
2. Scope first: Grep with mode:"files" or Glob to locate what matters, Read it, then make focused changes (prefer Edit over rewriting files).
3. VERIFY before you finish: run the relevant test/build/program with Bash(verify:true) and read the output. If no executable check exists or the environment blocks it, call VerificationAudit with a concrete reason.
4. Stay on the task. No gold-plating, no unrelated cleanups.`
    : `1. Work autonomously. Never ask questions — make reasonable assumptions and state them in your deliverable.
2. Scope first, then read: Grep with mode:"files" or Glob to locate candidates, then Read what matters. Batch independent lookups into ONE turn — they execute in parallel.
3. Be thorough on the task, and only the task. Stop as soon as you can answer it.`;
  const deliverable = env.schema
    ? `## Deliverable (IMPORTANT)
You MUST deliver by calling the SubmitResult tool — its parameters are the exact schema the caller consumes. Anything you write outside that call is discarded. Gather the data first, then call it once with complete, valid arguments; if it is rejected, fix the listed problems and call it again.`
    : `## Deliverable (IMPORTANT)
Your FINAL message is the entire deliverable, returned verbatim to the caller. Pack it with everything needed to act: concrete file paths with line numbers, exact names/signatures, short verbatim snippets where they matter, ${env.tier === "coder" ? "exactly which files you changed and what you verified (command + outcome), " : ""}and a direct answer to what was asked. No preamble, no questions, no offers of further help.`;
  const extra = env.extra?.trim() ? `\n\n## Additional instructions from the caller\n${env.extra.trim()}` : "";
  const inherited = env.inherited?.trim() ? `\n\n${env.inherited.trim()}` : "";
  return `${role}

## Environment
- Working directory (sandbox root): ${env.root}${reach}${isolationLine(env)}
- Platform: ${env.platform}

## Tools
${toolsLine}

## How to work
${work}

${deliverable}${inherited}${extra}`;
}
