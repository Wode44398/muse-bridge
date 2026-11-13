// 稍后发送、AI 标题、归档、输入建议、通知的偏好项（登记格式见 ../prefs.ts）。键名与 bridge 里 Claude 的同名设置一致。
import type { PrefSpec } from "../prefs.ts";

export const CHAT_PREFS: PrefSpec[] = [
  // —— 对话 ——
  {
    key: "promptSuggestions",
    type: "bool",
    default: true,
    group: "chat",
    label: "输入建议",
    desc: "每次回复完猜你接下来想说的话，输入框空着时以灰字显示，按 Tab 填入；每条建议多一次便宜模型的请求",
  },
  {
    key: "aiTitles",
    type: "bool",
    default: true,
    group: "chat",
    label: "AI 起标题",
    desc: "第一轮回复后用便宜模型给对话起个短标题；你手动改过的标题不会被覆盖",
  },
  // 离开模式（会话级开关，在右上角运行设置里开）下，要你点头的卡怎么落定。问答卡不受影响：恒按合理默认继续并写明假设
  {
    key: "awayDecision",
    type: "enum",
    default: "deny",
    group: "chat",
    label: "离开模式下的批准请求",
    desc: "开着离开模式时，要批准的调用和待审的计划怎么处理。默认不同意：调用直接拒、计划留着等你回来审；默认同意：调用直接放行、计划直接批准并开工（「从不允许」的规则照样拦）",
    options: [
      { value: "deny", label: "默认不同意" },
      { value: "approve", label: "默认同意" },
    ],
  },
  // —— 会话管理 ——
  {
    key: "autoArchiveDays",
    type: "enum",
    default: "0",
    group: "sessions",
    label: "归档不活跃的会话",
    desc: "运行中、在等你处理或有排队消息的会话不会被归档；取消过归档的会话以后不再自动归档",
    options: [
      { value: "0", label: "从不" },
      { value: "1", label: "1 天" },
      { value: "2", label: "2 天" },
      { value: "7", label: "7 天" },
      { value: "14", label: "14 天" },
      { value: "30", label: "30 天" },
    ],
  },
  // —— 通知 ——
  { key: "notifyPermission", type: "bool", default: true, group: "notify", label: "权限请求", desc: "dimensio 要你批准一个操作或审一份计划时" },
  { key: "notifyQuestion", type: "bool", default: true, group: "notify", label: "提问", desc: "dimensio 在等你回答问题时" },
  { key: "notifyTaskComplete", type: "bool", default: true, group: "notify", label: "任务完成", desc: "一轮做完或出错停下时（你自己停的不提醒）" },
];
