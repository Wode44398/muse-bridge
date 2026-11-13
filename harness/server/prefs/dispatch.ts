// 子 agent 按难度选型与内嵌图表的偏好项（登记格式见 ../prefs.ts）。
// 三项都只在建会话时读（写进系统提示 / 工具清单），改了对之后新建或重新打开的对话生效，进行中的对话不变（前缀缓存）。
import type { PrefSpec } from "../prefs.ts";

export const DISPATCH_PREFS: PrefSpec[] = [
  {
    key: "subagentLadder",
    type: "bool",
    default: true,
    group: "dispatch",
    label: "按难度选型阶梯",
    desc:
      "派子 agent 时，按模型性价比数据把这台 dimensio 此刻能用的模型排成「最难 / 难 / 常规 / 机械」四档首选与备选，写进系统提示；" +
      "Agent 工具与工作流脚本可以直接写 auto:top / auto:hard / auto:normal / auto:light。关掉后只保留下面的调度偏好。",
  },
  {
    key: "subagentDispatch",
    type: "text",
    default: "",
    group: "dispatch",
    label: "子 agent 调度偏好",
    desc: "写给 agent 的话，例如「简单检索用 MiMo V2.6 Flash，审查一律用 Opus」。拼进系统提示，与默认分档冲突时以这里为准。",
    maxLen: 2000,
  },
  {
    key: "inlineVisualizations",
    type: "bool",
    default: true,
    group: "chat",
    label: "对话内交互图表",
    desc: "允许 agent 在对话里直接画 SVG 图表、流程图和可交互的小部件。关掉后新对话不再提供这个工具。",
  },
];
