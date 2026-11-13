// 调试模式（改进 harness 用；登记格式见 ../prefs.ts）。开着时系统提示要求 agent 批判性使用 harness，
// 把工具的锅、冗余设计、缺的功能、不得不绕的路记成反馈（bridge 的 feedback.harness → 服务端根目录 harness-feedback/dimensio/）。
// 每轮都看（World State 的 debug 节），会话中途开关下一轮就生效。
import type { PrefSpec } from "../prefs.ts";

export const DEBUG_PREFS: PrefSpec[] = [
  {
    key: "debugMode",
    type: "bool",
    default: false,
    group: "debug",
    adminOnly: true,
    label: "调试模式",
    desc:
      "让 agent 批判性地使用 harness：工具报错先查是不是工具的锅，遇到冗余设计、缺的功能、不得不绕的路都记成反馈，" +
      "存进服务端根目录的 harness-feedback 文件夹。用来改进 harness，开着时任务本身排第二；会话中途开关，下一轮生效。",
    en: {
      label: "Debug mode",
      desc:
        "Make the agent use the harness critically: when a tool errors it first checks whether the tool is at fault, and it files redundant design, missing features and forced workarounds as feedback " +
        "in the harness-feedback folder at the server root. Meant for improving the harness — the task itself comes second while it is on; toggling it mid-session takes effect on the next turn.",
    },
  },
];
