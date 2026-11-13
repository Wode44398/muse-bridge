// 会话协作（子会话、会话间消息）的偏好项（登记格式见 ../prefs.ts）。session-family.ts 与 tools/sessions.ts 用 prefValue 现读。
// en = 英文文案（bridge 设置页切到 English 时显示）：label 必给、有 desc 就给 desc、enum 的每个选项按 value 给一条。
import type { PrefSpec } from "../prefs.ts";

type CollabPref = PrefSpec & { en: { label: string; desc?: string; options?: Record<string, string> } };

export const COLLAB_PREFS: CollabPref[] = [
  // 对标 bridge Claude 的 newSessionPolicy（设置 › Claude › 会话协作）。工具说明按建会话那一刻的档位写，改了对新会话生效；
  // 执行时现读（老会话按旧说明调用也照新档位办）。
  {
    key: "collab.newSessionPolicy",
    type: "enum",
    default: "ask",
    group: "collab",
    label: "dimensio 发起新会话",
    desc: "你提了与当前任务无关的事、或 dimensio 发现值得另开一个会话的活时怎么办",
    options: [
      { value: "ask", label: "先问我" },
      { value: "direct", label: "直接开始" },
      { value: "onRequest", label: "只在我要求时" },
    ],
    en: {
      label: "When dimensio starts new sessions",
      desc: "What happens when you bring up something unrelated to the current task, or dimensio spots work worth its own session",
      options: { ask: "Ask me", direct: "Start right away", onRequest: "Only when I ask" },
    },
  },
  // 对标 bridge Claude 的 crossSessionInbound：不在这里长出来的那一方——bridge 里的 Claude 会话——发来的消息与派来的任务。
  // dimensio 自己的父子 / 兄弟会话之间不受它管（那是这里的会话自己开出来的）。
  {
    key: "collab.inbound",
    type: "enum",
    default: "accept",
    group: "collab",
    label: "其它会话发来的消息",
    desc: "bridge 里的 Claude 会话发给 dimensio 会话的消息、派来的任务（dimensio 自己的父子会话之间不受影响）",
    options: [
      { value: "accept", label: "直接接收" },
      { value: "hold", label: "先存着，等我在那个会话里发话时一起带上" },
      { value: "refuse", label: "拒收" },
    ],
    en: {
      label: "Messages from other sessions",
      desc: "Messages and tasks that Claude sessions in bridge send to dimensio sessions (sessions within dimensio aren’t affected)",
      options: { accept: "Accept", hold: "Hold them until I next write in that session", refuse: "Decline" },
    },
  },
  // 防无限互唤（对标 Claude 的 MAX_STREAK=6）：连续这么多轮都是会话间自动续、没有你发话，就不再唤醒，攒着等你下一次发话
  {
    key: "collab.maxAutoTurns",
    type: "number",
    default: 6,
    min: 1,
    max: 20,
    group: "collab",
    label: "会话之间连续自动续的上限",
    desc: "会话之间互相唤醒连着这么多轮没有你发话，就先停下，攒着的消息等你下次在那个会话里发话时一起送到",
    en: {
      label: "Limit on automatic back-and-forth between sessions",
      desc: "After this many automatic turns in a row without you writing, sessions stop waking each other; waiting messages arrive with your next message in that session",
    },
  },
];
