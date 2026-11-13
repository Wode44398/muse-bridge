// 偏好项英文文案的补表：登记处自己没写 en 的项在这里补（prefs.ts 汇总时合并，登记处写了的优先）。
import type { PrefSpec } from "../prefs.ts";

export const PREFS_EN: Record<string, NonNullable<PrefSpec["en"]>> = {
  // 对话 / 会话管理 / 通知（chat.ts）
  promptSuggestions: {
    label: "Prompt suggestions",
    desc: "After each reply, guess what you might say next and show it as grey text in the empty input; press Tab to fill it in. Each suggestion costs one extra request to a cheap model",
  },
  aiTitles: {
    label: "AI titles",
    desc: "After the first reply, a cheap model gives the conversation a short title; titles you renamed yourself are never overwritten",
  },
  awayDecision: {
    label: "Approval requests in away mode",
    desc: "While away mode is on, how calls that need approval and plans waiting for review are settled. Deny by default: calls are refused and plans wait for you to review. Approve by default: calls go ahead and plans are approved and started (“Never allow” rules still block)",
    options: { deny: "Deny by default", approve: "Approve by default" },
  },
  autoArchiveDays: {
    label: "Archive inactive sessions",
    desc: "Sessions that are running, waiting for you, or have queued messages are never archived; a session you unarchived is not archived automatically again",
    options: { "0": "Never", "1": "1 day", "2": "2 days", "7": "7 days", "14": "14 days", "30": "30 days" },
  },
  notifyPermission: { label: "Permission requests", desc: "When dimensio needs you to approve an action or review a plan" },
  notifyQuestion: { label: "Questions", desc: "When dimensio is waiting for your answer" },
  notifyTaskComplete: { label: "Task complete", desc: "When a turn finishes or stops on an error (not when you stopped it yourself)" },
  // Git 与拉取请求（git.ts）
  autoFixPullRequests: {
    label: "Auto-fix pull requests",
    desc: "When a pull request opened by a session fails CI, hits a conflict or gets review comments, wake that session to handle it (each session can override this on its PR card)",
  },
  attribution: {
    label: "Review reply attribution",
    desc: "Add a dimensio signature line at the end of auto-fix replies to review comments",
    options: { default: "Sign as dimensio", none: "No signature" },
  },
  branchPrefix: {
    label: "Branch prefix",
    desc: "Prefix for new pull request branches, e.g. dimensio/<name> (1–40 letters, digits or . _ -)",
  },
  // 子 agent 调度与图表（dispatch.ts）
  subagentLadder: {
    label: "Difficulty-based model ladder",
    desc: "When dispatching sub-agents, rank the models this dimensio can use right now into top / hard / normal / light tiers (first choice and fallback) from the model value data, and put them in the system prompt; the Agent tool and workflow scripts can write auto:top / auto:hard / auto:normal / auto:light. Turn off to keep only the dispatch preferences below.",
  },
  subagentDispatch: {
    label: "Sub-agent dispatch preferences",
    desc: "Notes for the agent, e.g. \"use MiMo V2.6 Flash for simple lookups, always use Opus for reviews\". Added to the system prompt; overrides the default tiers when they conflict.",
  },
  inlineVisualizations: {
    label: "Inline interactive charts",
    desc: "Let the agent draw SVG charts, flowcharts and small interactive widgets right in the conversation. When off, new conversations no longer get this tool.",
  },
  // 工作区协同（workspace.ts）
  "workspace.view": {
    label: "Let the agent see the file I'm viewing",
    desc: "Files open in the workspace and preview, PDF page, and whether there are unsaved changes. When off, the agent can only look up paths you tell it.",
  },
  "workspace.draft": {
    label: "Allow the agent to read unsaved drafts",
    desc: "Content not yet saved in the editor. When off, the agent only sees the version on disk.",
  },
  "workspace.terminal": {
    label: "Agent use of the shared terminal",
    desc: "The shell in the workspace Terminal is shared by you and the agent; you see every keystroke the agent types.",
    options: { type: "Read the screen and type", read: "Read the screen only", off: "Not allowed" },
  },
};
