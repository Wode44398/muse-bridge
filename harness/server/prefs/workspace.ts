// 工作区协同与共享终端的偏好项（登记格式见 ../prefs.ts）。
import type { PrefSpec } from "../prefs.ts";

export const WORKSPACE_PREFS: PrefSpec[] = [
  {
    key: "workspace.view",
    type: "bool",
    default: true,
    group: "workspace",
    label: "让 agent 看到我正在看的文件",
    desc: "工作区与预览里打开的文件、PDF 页码、有没有未保存的修改。关掉后 agent 只能按你说的路径去找。",
  },
  {
    key: "workspace.draft",
    type: "bool",
    default: true,
    group: "workspace",
    label: "允许 agent 读取未保存的草稿",
    desc: "编辑器里还没保存的内容。关掉后 agent 只读得到磁盘上的版本。",
  },
  {
    key: "workspace.terminal",
    type: "enum",
    default: "type",
    group: "workspace",
    label: "agent 使用共享终端",
    desc: "工作区「终端」里的 shell 由你和 agent 共用，agent 敲的每个字你都看得见。",
    options: [
      { value: "type", label: "可以读屏和打字" },
      { value: "read", label: "只能读屏" },
      { value: "off", label: "不允许" },
    ],
  },
];
