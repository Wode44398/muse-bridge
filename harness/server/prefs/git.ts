// 拉取请求绑定与自动修复的偏好项（登记格式见 ../prefs.ts）。
// 对齐 bridge 里 Claude 的 设置 › Git 与拉取请求（src/config/claude-settings.mjs 的 autoFixPullRequests / attribution / branchPrefix），
// 只留对 dimensio 有意义的：dimensio 没有自己建的 worktree（不要「工作树起点」），会话也不在 bridge 那边归档（不要「合并后自动归档」）。
// PR 功能只给主机本人（gh 令牌是这台电脑主人的 GitHub 账号），成员实例不出这几项。读的地方：pr-bridge.ts（每次调 bridge 时带过去）。
import type { PrefSpec } from "../prefs.ts";

export const GIT_PREFS: PrefSpec[] = [
  {
    key: "autoFixPullRequests",
    type: "bool",
    default: false,
    group: "git",
    label: "自动修复拉取请求",
    desc: "会话建的拉取请求 CI 失败、出现冲突或有评审意见时，自动叫醒那个会话去处理（单个会话可在 PR 卡上另开关）",
    adminOnly: true,
  },
  {
    key: "attribution",
    type: "enum",
    default: "default",
    group: "git",
    label: "评审回复署名",
    desc: "自动修复回复评审意见时，末尾带一行 dimensio 署名",
    options: [
      { value: "default", label: "带 dimensio 署名" },
      { value: "none", label: "不署名" },
    ],
    adminOnly: true,
  },
  {
    key: "branchPrefix",
    type: "text",
    default: "dimensio",
    group: "git",
    label: "分支前缀",
    desc: "为拉取请求新开分支时的前缀，如 dimensio/<名字>（1–40 个字母、数字或 . _ -）",
    maxLen: 40,
    adminOnly: true,
  },
];
