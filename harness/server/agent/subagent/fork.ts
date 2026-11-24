// fork：继承父会话上下文的子 agent。它的请求前缀 = 父会话此刻的 system + 工具表 + 消息历史（同一个型号、同样的缓存时长，
// 吃得到父会话的提示缓存），后面接一条「把这些调用的结果先放一放」的占位（父会话这一步发出的调用还没有结果）和给它的任务。
// 消息是深拷贝：子 agent 的微压缩会就地改写旧工具输出，不能改到父会话的转录。它的输出不回写父会话，只交回最终报告。
// 装不下（父会话已经接近压缩线）就不 fork，由调用方退回普通子 agent 并说明。
import type { AgentState } from "../state.ts";
import type { Block, Msg } from "../turn.ts";
import { compactionWindow, contextTokens } from "../context.ts";

// 父会话的上下文超过压缩窗口的这个比例就不 fork：fork 一开头就得压缩，前缀缓存吃不到，留给它干活的地方也不多
const FORK_HEADROOM = 0.8;

export const FORK_KIND = "fork-directive";
export const FORK_HEAD = "[Fork]";

export function forkBlocker(parent: AgentState): string | null {
  const used = contextTokens(parent);
  const limit = compactionWindow(parent);
  if (used >= limit * FORK_HEADROOM) return `this conversation is close to its compaction point (${used} of ${limit} tokens), so there is no room to fork it`;
  return null;
}

/** 父会话消息的副本，最后一步还没有结果的调用补上占位结果（fork 自己那一次单独说明）。 */
export function forkMessages(parent: AgentState, ownCallId: string | undefined): Msg[] {
  const messages = structuredClone(parent.messages) as Msg[];
  const last = messages.at(-1);
  if (last?.role === "assistant") {
    const pending = last.content.filter((b): b is Extract<Block, { t: "tool_call" }> => b.t === "tool_call");
    if (pending.length) {
      messages.push({
        role: "user",
        origin: "harness",
        kind: FORK_KIND,
        content: pending.map((b): Block => ({
          t: "tool_result",
          id: b.id,
          ok: true,
          content: [{
            t: "text",
            text: b.id === ownCallId
              ? "This call started you, the fork. Your task follows."
              : "Running in the main agent; its result is not available to this fork.",
          }],
        })),
      });
    }
  }
  return messages;
}

export function forkDirective(task: string): string {
  return `${FORK_HEAD} You are a fork of the main agent: everything above is its conversation so far, copied for you. Do the task below yourself, then stop with a final report — that report is all the main agent receives; nothing else you write reaches it. You cannot start sub-agents, run workflows or ask the user.

Task:
${task}`;
}
