// 改动与验证证据的记账、验证回执脚注、请求不变量抽样、操作手册注入、答复下附的脚注。
import type { Msg, Turn } from "../turn.ts";
import type { AgentState } from "../state.ts";
import { RunInvariants } from "../turn-invariants.ts";
import { messageKind } from "../injections.ts";
import { type Playbook, PLAYBOOK_KIND, playbookLoadedIn, playbookMessage } from "../playbooks.ts";
import type { ToolRunResult } from "../../tools/types.ts";
import { noteKnowledgeEdit } from "../../knowledge-service.ts";
import { MAX_MEMORY_AUDIT_NUDGES, MAX_VERIFICATION_AUDIT_NUDGES } from "./limits.ts";
import { clipDetail } from "./outcomes.ts";

// V2（#21）：只改了文档类文件（.md、.txt、图片…）不进验证门禁——没有可执行的东西可验。
const DOC_EXT_RE = /\.(?:md|markdown|mdx|txt|rst|adoc|asciidoc|org|csv|tsv|log|png|jpe?g|gif|webp|ico|bmp)$/i;
export const touchesCode = (files: Iterable<string>): boolean => [...files].some((f) => !DOC_EXT_RE.test(f));

// ── V5（#20）：门禁的「改过没有」不只认 Edit/Write ───────────────────────────────
// 以前派 coder 子 agent 改完、或者用 Bash 写了文件就收尾，门禁一次都不问（probe delegated-edit-gate、bash-write-gate）。
// 两路信号：① 调用自己报的——coder / Workflow 的 editedFiles、Bash 命令里明确写的路径（按调用的时刻记，与验证的
// 先后关系是准的）；② 影子 git：这一轮开跑时的快照到现在，工作区改了哪些文件（有会话、开着检查点时才有；
// 兜住 npm run format、脚本生成这类看不出写了什么的）。
export function noteToolEdits(state: AgentState, call: { name: string; args: Record<string, unknown> }, res: ToolRunResult): void {
  const paths = [...(res.editedFiles ?? []), ...(state.toolMap.get(call.name)?.permissionView?.(call.args)?.edits ?? [])];
  if (!paths.length) return;
  const fresh: string[] = [];
  for (const raw of paths) {
    try {
      const abs = state.ctx.sandbox.resolve(raw);
      state.editedFiles.add(abs);
      fresh.push(abs);
    } catch {
      /* 工作区外 / 解析不了的路径：门禁管不到它 */
    }
  }
  // 只有改到代码才把「验过了」作废——写个日志、改个 README 不该让门禁重新追问
  if (touchesCode(fresh)) {
    state.recordMutation();
    noteKnowledgeEdit(state.ctx.sandbox.root);
  }
}

// 影子 git 看到的改动：这些改动发生在这一轮的某个时刻，和验证谁先谁后说不清——这一轮有过通过的验证，就当它
// 覆盖到了；一次都没有，才算「改了还没验」。
export async function noteUnseenChanges(state: AgentState): Promise<void> {
  if (!state.changedSinceRunStart) return;
  let changed: string[] = [];
  try {
    changed = await state.changedSinceRunStart();
  } catch {
    return;
  }
  const fresh: string[] = [];
  for (const rel of changed) {
    try {
      const abs = state.ctx.sandbox.resolve(rel);
      if (!state.editedFiles.has(abs)) {
        state.editedFiles.add(abs);
        fresh.push(abs);
      }
    } catch {
      /* 凭据路径等解析会拒的：不进账 */
    }
  }
  if (touchesCode(fresh) && !state.runEvidence.some((e) => e.passed)) state.recordMutation();
}

// N26（HT3）：这次调用可能写过工作区——不是只读的；只删不写的破坏性命令不算（它毁掉的内容在它之前那张快照里）。
export function mayHaveWritten(state: AgentState, call: { name: string; args: Record<string, unknown> }): boolean {
  const tool = state.toolMap.get(call.name);
  if (!tool || tool.effect === "read") return false;
  const view = tool.permissionView?.(call.args);
  return view?.effect !== "read" && !view?.onlyDestroys;
}

// 轮内快照在回滚面板上的名字：「执行 rm -rf src 之前」（命令只取第一行、截短）
export function destructiveLabel(args: Record<string, unknown>): string {
  const line = String(args.command ?? "").trim().split(/\r?\n/)[0];
  return `执行 ${line.length > 40 ? line.slice(0, 40) + "…" : line} 之前`;
}

export const RETRACT_REASON = "答复先撤回：改了代码，但还没有通过的验证，正在让它补跑检查";
// 撤回的那版答复模型自己的上下文里还在，它会以为用户看过了，收尾只写一句「验证通过」——用户那边正文就没了
// （2026-10-05 本机 Qwen 分析 Strata：六千字分析被撤回，最后只剩「分析已完成。补充验证结果：……」）。追问里明说。
export const RETRACTED_NOTICE =
  " Note: the reply you just wrote has been withdrawn from the user's view — they will NOT see it. When you finish, " +
  "your final reply must be complete and self-contained: restate the full answer, then add the verification results.";

export function verificationFootnote(state: AgentState): string | null {
  if (!state.finalFootnotes) return null;
  const lines: string[] = [];
  // V3（#33）：本轮到最后也没落地的编辑，服务端点名列出。
  if (state.failedEdits.size) {
    const items = [...state.failedEdits.values()].slice(0, 5).map((f) => `\`${clipDetail(f.display)}\`（${clipDetail(f.reason)}）`);
    const more = state.failedEdits.size > 5 ? ` 等 ${state.failedEdits.size} 处` : "";
    lines.push(`⚠️ 这些编辑没有落地：${items.join("、")}${more}`);
  }
  // V2：追问用尽放行、或预算用完收场时，代码改动仍没有通过的验证——服务端写明，模型去不掉。
  if (touchesCode(state.editedFiles) && state.dirtySinceVerify && !state.verificationAuditCompleted) {
    lines.push(
      `⚠️ 未验证：这一轮改了 ${state.editedFiles.size} 个文件，但没有通过的验证证据` +
        (state.verificationGateGaveUp ? `（门禁追问 ${MAX_VERIFICATION_AUDIT_NUDGES} 次后放行）` : "") +
        "，以上结论请自行核对。",
    );
  }
  const last = state.runEvidence.at(-1);
  if (last && !last.passed) lines.push(`最后一次检查没通过：❌ \`${clipDetail(last.detail)}\``);
  if (state.runAudit) lines.push(`没有可跑的验证（${state.runAudit.decision}）：${state.runAudit.reason}`);
  // K6（G4）：记忆审计门禁追问用尽放行——服务端写明，模型去不掉
  if (state.memoryAuditGaveUp) lines.push(`⚠️ 记忆审计：追问 ${MAX_MEMORY_AUDIT_NUDGES} 次仍没交，已放行——这一轮值得记住的事可能没记下来`);
  // 10-07（维护者）：验收顺利就不打扰——通过的回执只在上面有问题时作为对照一起给，全绿不附尾注
  if (!lines.length) return null;
  const passed = [...new Set(state.runEvidence.filter((e) => e.passed).map((e) => clipDetail(e.detail)))].slice(-3);
  if (passed.length) lines.push(`通过的检查：${passed.map((d) => `✅ \`${d}\``).join(" · ")}`);
  return `\n\n> ${lines.join("\n>\n> ")}`;
}

// Q3：请求不变量在生产上只计数、首次告警一次，绝不抛（检查本身出错也只记一笔）。测试里违反即失败：
// 脚本化 provider 验每次输入，loopState 收尾核对这里的计数。
const INVARIANT_SAMPLES = 5;
export function noteInvariants(state: AgentState, invariants: RunInvariants, turn: Turn): void {
  let problems: string[];
  try {
    problems = invariants.check(turn, state.systemRewrites);
  } catch (err) {
    problems = [`request invariant check crashed: ${(err as Error).message}`];
  }
  if (!problems.length) return;
  if (!state.invariantViolations) {
    const more = problems.length > 1 ? ` (+${problems.length - 1} more)` : "";
    console.warn(`[agent] request invariant violated before sending: ${problems[0]}${more}`);
  }
  state.invariantViolations += problems.length;
  for (const p of problems) {
    if (state.invariantSamples.length >= INVARIANT_SAMPLES) break;
    if (!state.invariantSamples.includes(p)) state.invariantSamples.push(p);
  }
}

// 瘦身 P0-3：专章（playbook）按需注入——用户点名或工作碰到那块时追加一条 harness 消息，同一章在转录里还在就不重复。
// D5：这台机器没有浏览器（state.browser = false，见 headless.ts browserAvailable）时，网页章给 curl 版、桌面 / 安卓两章不给
// （与 prompt.ts 的 browser 开关一致）。
export function attachPlaybooks(state: AgentState, picks: Playbook[], why: "request" | "work"): void {
  for (const p of picks) {
    if (p.needsBrowser && !state.browser) continue;
    if (playbookLoadedIn(state.messages, p)) continue;
    state.appendUserBlocks([{ t: "text", text: playbookMessage(p, why, state.browser) }], false, { origin: "harness", kind: PLAYBOOK_KIND });
  }
}

// 这一轮用户本人说的话（最后一条不带来源的用户文本消息；续跑 / 目标续跑的轮里是更早那条，重复注入由去重挡住）
export function ownRequestText(messages: readonly Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || messageKind(m) !== null || m.content.some((b) => b.t === "tool_result")) continue;
    return m.content.flatMap((b) => (b.t === "text" ? [b.text] : [])).join("\n");
  }
  return "";
}

// 尾注接在最终答复最后一段正文后面；这一轮没有正文时单独成一条 assistant 消息。
export function attachFootnote(state: AgentState, target: Msg | null, note: string): void {
  if (target?.role === "assistant") {
    for (let i = target.content.length - 1; i >= 0; i--) {
      const block = target.content[i];
      if (block.t === "text") {
        target.content[i] = { t: "text", text: block.text + note };
        return;
      }
    }
  }
  state.appendAssistant({ text: note.trimStart(), thinkingText: "", calls: [] });
}
