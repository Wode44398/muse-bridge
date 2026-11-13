// dimensio 偏好设置注册表：bridge 设置页「dimensio」分区与 harness 自己读同一份。
// 每个功能在 prefs/<功能>.ts 里登记自己的项（键名全局唯一、带默认值与界面文案），这里汇总、校验、落盘。
// 值存在运行配置同目录的 prefs.json（与 runtime-config.json 分开：那份是厂商 / 型号 / 权限的选择）。
// 读：prefValue(key)（没存过 = 默认值）；写：setPrefs(patch)（逐项按类型校验，不认识的键拒绝）。
// 文案：label / desc / 选项名写中文原文，同时在 en 里给英文（bridge 设置页切到 English 时显示；漏了 prefs.test.ts 判红）。
import { readFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "./atomic-write.ts";
import { configFile } from "./paths.ts";
import { COLLAB_PREFS } from "./prefs/collab.ts";
import { DISPATCH_PREFS } from "./prefs/dispatch.ts";
import { WORKSPACE_PREFS } from "./prefs/workspace.ts";
import { CHAT_PREFS } from "./prefs/chat.ts";
import { GIT_PREFS } from "./prefs/git.ts";
import { CONTEXT_PREFS } from "./prefs/context.ts";
import { DEBUG_PREFS } from "./prefs/debug.ts";
import { PREFS_EN } from "./prefs/en.ts";

export type PrefType = "bool" | "enum" | "number" | "text";

export interface PrefSpec {
  key: string;
  type: PrefType;
  default: boolean | string | number;
  // 设置页分组（同组的项排在一起，组按 PREF_GROUPS 的顺序出）
  group: PrefGroup;
  label: string;
  desc?: string;
  options?: { value: string; label: string }[]; // enum
  min?: number; // number
  max?: number;
  maxLen?: number; // text
  // 成员实例（租户）不出这一项（例如只对主机有意义的）
  adminOnly?: boolean;
  // 英文文案：label 必给；有 desc 就给 desc；enum 的每个选项按 value 给一条
  en?: { label: string; desc?: string; options?: Record<string, string> };
}

export type PrefGroup = "chat" | "collab" | "dispatch" | "workspace" | "git" | "sessions" | "notify" | "debug";
export const PREF_GROUPS: { id: PrefGroup; label: string; en: string }[] = [
  { id: "chat", label: "对话", en: "Chat" },
  { id: "dispatch", label: "子 agent 调度", en: "Subagent dispatch" },
  { id: "collab", label: "会话协作", en: "Session collaboration" },
  { id: "workspace", label: "工作区协同", en: "Workspace awareness" },
  { id: "git", label: "Git 与拉取请求", en: "Git and pull requests" },
  { id: "sessions", label: "会话管理", en: "Session management" },
  { id: "notify", label: "通知", en: "Notifications" },
  { id: "debug", label: "调试", en: "Debug" },
];

export const PREFS: PrefSpec[] = [...CHAT_PREFS, ...CONTEXT_PREFS, ...DISPATCH_PREFS, ...COLLAB_PREFS, ...WORKSPACE_PREFS, ...GIT_PREFS, ...DEBUG_PREFS].map((p) =>
  p.en || !PREFS_EN[p.key] ? p : { ...p, en: PREFS_EN[p.key] },
);
const BY_KEY = new Map(PREFS.map((p) => [p.key, p]));
if (BY_KEY.size !== PREFS.length) throw new Error("prefs: 键名重复");

const prefsFile = (): string => path.join(path.dirname(configFile()), "prefs.json");

let values: Record<string, unknown> = load();
function load(): Record<string, unknown> {
  try {
    const raw = JSON.parse(readFileSync(prefsFile(), "utf8"));
    return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

function valid(spec: PrefSpec, v: unknown): boolean {
  switch (spec.type) {
    case "bool":
      return typeof v === "boolean";
    case "enum":
      return typeof v === "string" && (spec.options ?? []).some((o) => o.value === v);
    case "number":
      return typeof v === "number" && Number.isFinite(v) && (spec.min === undefined || v >= spec.min) && (spec.max === undefined || v <= spec.max);
    case "text":
      return typeof v === "string" && v.length <= (spec.maxLen ?? 4000);
  }
}

export function prefValue<T extends boolean | string | number>(key: string): T {
  const spec = BY_KEY.get(key);
  if (!spec) throw new Error(`prefs: 未登记的键 ${key}`);
  const v = values[key];
  return (valid(spec, v) ? v : spec.default) as T;
}

export function allPrefs(opts: { tenant?: boolean } = {}): { groups: typeof PREF_GROUPS; items: (PrefSpec & { value: unknown })[] } {
  const items = PREFS.filter((p) => !(opts.tenant && p.adminOnly)).map((p) => ({ ...p, value: prefValue(p.key) }));
  return { groups: PREF_GROUPS.filter((g) => items.some((i) => i.group === g.id)), items };
}

let queue: Promise<void> = Promise.resolve();
// patch 里值为 null = 恢复默认。整批校验通过才写（一项错全批拒）。
export function setPrefs(patch: unknown, opts: { tenant?: boolean } = {}): Promise<void> {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("prefs: 要一个对象");
  const next = { ...values };
  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    const spec = BY_KEY.get(k);
    if (!spec || (opts.tenant && spec.adminOnly)) throw new Error(`prefs: 不认识的设置项 ${k}`);
    if (v === null) delete next[k];
    else if (!valid(spec, v)) throw new Error(`prefs: ${k} 的值不合法`);
    else next[k] = v;
  }
  values = next;
  const data = JSON.stringify(values, null, 2) + "\n";
  queue = queue.then(() => atomicWriteFile(prefsFile(), data)).catch((e) => console.warn(`[prefs] 写盘失败：${(e as Error).message}`));
  return queue;
}

// 测试用：丢掉内存里的值、重读盘
export function reloadPrefs(): void {
  values = load();
}
