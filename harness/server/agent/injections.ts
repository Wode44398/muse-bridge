// Q4（K46 的注入物清单）：loop 与会话往模型可见转录里塞的已知片段，按开头认类别。
// C3（#41）：判定一律认结构化来源（Msg.origin / kind，见 messageKind）。这张按开头认的表只剩两个用处：给 harness 自己
// 注入时没写 kind 的补个名字，和给 C3 之前的旧记录一次性补标来源（store.ts 读入时）——用户本人的消息永远不按文本当注入。
import type { Msg } from "./turn.ts";

const KINDS: readonly [RegExp, string][] = [
  [/^\[Automatically recalled/, "recall"],
  [/^\[Memory audit required\]/, "audit-nudge"],
  [/^\[Pre-compaction memory audit\]/, "precompact-audit-nudge"],
  [/^\[Automated check\] Your previous reply was cut off/, "length-continue"],
  [/^\[Automated check\] You have not delivered your result/, "submit-nudge"],
  [/^\[Automated check\]/, "verify-nudge"],
  [/^\[Plan mode\]/, "plan-nudge"],
  [/^\[Budget exhausted\]/, "budget-exhausted"],
  [/^\[Budget\]/, "budget-nudge"],
  [/^\[Loop guard\]/, "loop-guard"],
  [/^\[Permissions\]/, "permission-stop"],
  [/^\[Reminder — your current todo list\]/, "todo"],
  [/^\[Earlier context summary\]/, "compaction-summary"],
  [/^\[用户在运行中插话\]/, "steer"],
  [/^Attachment\(s\) from the previous tool call:/, "tool-attachments"],
  [/^\[Skill: /, "skill"], // C5：Skill 工具加载的技能正文（E3 用户 /技能名 点的也是这个开头，但落盘时带着 kind slash-skill）
  [/^\[Skill package: /, "slash-skill"], // E3：用户 /包名 点了一个技能包——列出成员让模型挑
  [/^\[Skill again: /, "slash-skill"], // E3：用户又点了一次已经载入过的技能——只提醒，不再整段注入
  [/^\[Rewound by the user\]/, "rewind"], // U9：从这里改写之后的说明（文件没有回退、改过哪些）
  [/^\[Files restored by the user\]/, "restore"], // U10：审阅面板里撤销了这个对话对哪些文件的改动
  [/^\[Goal\] The user's message above is a goal/, "goal-start"], // O7：目标续跑的第一轮说明
  [/^\[Goal\] Round /, "goal-continue"], // O7：目标续跑的下一轮
  [/^\[Handoff\]/, "handoff-summary"], // C8：带摘要开新会话——新会话开头那条接续摘要
  [/^\[Resumed\]/, "resume"], // M13：服务重启 / 进程死掉之后自动续跑那一轮的首条
  [/^\[Auto-resume stopped\]/, "resume-stopped"], // M13：连着被切断，不再自动续跑
];

export function injectionKind(text: string): string | null {
  for (const [re, kind] of KINDS) if (re.test(text)) return kind;
  return null;
}

const firstText = (m: Msg): string => {
  const b = m.content.find((x) => x.t === "text");
  return b && b.t === "text" ? b.text : "";
};

// C3：这条消息是哪一类注入；用户本人的消息（没有 origin）一律 null——无论它写的是什么。
export function messageKind(m: Msg): string | null {
  if (m.role !== "user") return null;
  if (m.origin === "steer") return "steer";
  if (m.origin !== "harness") return null;
  return m.kind ?? injectionKind(firstText(m)) ?? "harness";
}

// C3：C3 之前写的旧记录没有 origin——读入时按开头一次性补标（与当年的判定一致；那时就分不清的，现在也只能这样）。
// 只动还没有 origin 的用户侧文本消息；工具结果不动。
export function tagLegacyOrigins(messages: Msg[]): void {
  for (const m of messages) {
    if (m.role !== "user" || m.origin || m.content.some((b) => b.t === "tool_result")) continue;
    const kind = injectionKind(firstText(m));
    if (!kind) continue;
    if (kind === "steer") m.origin = "steer";
    else {
      m.origin = "harness";
      m.kind = kind;
    }
  }
}

// 这些消息里各类注入片段各出现几次（按结构化来源；用户本人的消息不算）。
export function injectionsIn(messages: readonly Msg[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of messages) {
    const kind = messageKind(m);
    if (kind) out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

// C5：Skill 工具注入的技能正文以这一行开头（KINDS 按它认旧记录；Skill 判「已加载」也认它）
export const skillHeader = (name: string) => `[Skill: ${name}]`;

// C5：这个技能的正文此刻还在转录里（加载过、没被整段压缩掉）。E3：用户 /技能名 点进来的（kind slash-skill）也算
export function skillLoadedIn(messages: readonly Msg[], name: string): boolean {
  const header = skillHeader(name);
  return messages.some((m) => {
    const kind = messageKind(m);
    return (kind === "skill" || kind === "slash-skill") && m.content.some((b) => b.t === "text" && b.text.startsWith(header));
  });
}

// 自动召回片段里带的文档 id（每行 `- [id] 标题…`）。
export function recallIds(messages: readonly Msg[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (messageKind(m) !== "recall") continue;
    for (const b of m.content) {
      if (b.t !== "text") continue;
      for (const hit of b.text.matchAll(/^- \[([^\]\n]+)\]/gm)) ids.push(hit[1]);
    }
  }
  return ids;
}
