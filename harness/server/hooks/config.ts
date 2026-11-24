// 用户 hooks 的配置：读 Claude Code 同格式的 settings.json 里的 hooks 字段，按事件合并成一张表。
//
// 格式：{ "hooks": { "<事件>": [ { "matcher": "Edit|Write", "hooks": [ { "type": "command", "command": "...", "timeout": 30 } ] } ] } }
// 读取位置（agent-dirs.ts）：用户级 ~/.dimensio、~/.claude，项目级 <工作区>/.dimensio、<工作区>/.claude，各自的
// settings.json 与 settings.local.json。成员实例一律不读。
//
// 只认 type "command"；Claude Code 的 prompt / agent 型 hook 跳过并在日志里说一声。任何一份写了 disableAllHooks: true
// 就整张表作废（与 Claude Code 一致）。文件坏了不许拖垮会话，跳过并记一行。
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { configDirs, type ConfigScope } from "../agent-dirs.ts";
import { tenantMode } from "../tenant.ts";
import { commandRefs, refsDigest } from "./script-refs.ts";

export const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SubagentStop", "SessionStart", "PreCompact"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export const DEFAULT_TIMEOUT_S = 60;
export const MAX_TIMEOUT_S = 600;

export interface HookCommand {
  event: HookEvent;
  matcher: string; // "" = 全部
  command: string;
  timeoutS: number;
  scope: ConfigScope;
  file: string; // 来自哪一份 settings（日志与确认卡上写）
  // 项目级的：命令里点名的工作区内文件（脚本）与读配置时它们内容的摘要（script-refs.ts）。进信任指纹，执行前再对一遍
  refs?: string[];
  refsDigest?: string;
}

export interface HookConfig {
  hooks: HookCommand[];
  // 项目级那部分的指纹（工作区 + 命令内容）：信任记录按它比，配置变了要重新确认
  projectHash: string | null;
}

const SETTINGS_FILES = ["settings.json", "settings.local.json"];

const warned = new Set<string>();
function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(`[hooks] ${msg}`);
}

function readSettings(file: string): Record<string, unknown> | null {
  try {
    if (!statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  try {
    let text = readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const raw = JSON.parse(text) as unknown;
    return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  } catch (e) {
    warnOnce(`${file} 解析失败（${(e as Error).message.slice(0, 120)}），这份里的 hooks 不生效`);
    return null;
  }
}

function parseHooks(raw: unknown, scope: ConfigScope, file: string): HookCommand[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const out: HookCommand[] = [];
  for (const [event, groups] of Object.entries(raw as Record<string, unknown>)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      warnOnce(`${file}：不支持的事件 ${event.slice(0, 40)}，跳过`);
      continue;
    }
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      if (!group || typeof group !== "object") continue;
      const g = group as { matcher?: unknown; hooks?: unknown };
      const matcher = typeof g.matcher === "string" ? g.matcher.trim() : "";
      for (const h of Array.isArray(g.hooks) ? g.hooks : []) {
        if (!h || typeof h !== "object") continue;
        const hook = h as { type?: unknown; command?: unknown; timeout?: unknown };
        if (hook.type !== "command") {
          warnOnce(`${file}：${event} 里有 type 为 ${String(hook.type).slice(0, 20)} 的 hook，dimensio 只执行 command 型，跳过`);
          continue;
        }
        if (typeof hook.command !== "string" || !hook.command.trim()) continue;
        const t = Number(hook.timeout);
        const timeoutS = Number.isFinite(t) && t > 0 ? Math.min(t, MAX_TIMEOUT_S) : DEFAULT_TIMEOUT_S;
        out.push({ event: event as HookEvent, matcher, command: hook.command, timeoutS, scope, file });
      }
    }
  }
  return out;
}

// 这个工作区此刻生效的 hooks（成员实例恒空）。没有任何 hook 返回 null——调用方据此什么都不挂。
export function loadHookConfig(workspace: string): HookConfig | null {
  if (tenantMode()) return null;
  const hooks: HookCommand[] = [];
  let disabled = false;
  for (const { scope, dir } of configDirs(workspace)) {
    for (const name of SETTINGS_FILES) {
      const file = path.join(dir, name);
      const settings = readSettings(file);
      if (!settings) continue;
      if (settings.disableAllHooks === true) disabled = true;
      hooks.push(...parseHooks(settings.hooks, scope, file));
    }
  }
  if (disabled || !hooks.length) return null;
  const project = hooks.filter((h) => h.scope === "project");
  for (const h of project) {
    const refs = commandRefs(h.command, workspace);
    if (refs.length) Object.assign(h, { refs, refsDigest: refsDigest(refs) });
  }
  return {
    hooks,
    projectHash: project.length ? fingerprint(workspace, project) : null,
  };
}

function fingerprint(workspace: string, hooks: HookCommand[]): string {
  const body = JSON.stringify({
    ws: path.resolve(workspace),
    hooks: hooks.map((h) => [h.event, h.matcher, h.command, h.timeoutS, path.basename(path.dirname(h.file)), path.basename(h.file), h.refsDigest ?? null]),
  });
  return createHash("sha256").update(body).digest("hex");
}

// Claude Code 的工具名对得上 dimensio 的同名工具；改过名的在这里补（matcher 写旧名也能命中）
const CLAUDE_CODE_NAMES: Record<string, string[]> = { Agent: ["Task"] };

// matcher：空或 "*" = 全部；否则当整段匹配的正则（"Edit|Write"、"mcp__.*"），写得不是合法正则就按字面比
export function matcherHits(matcher: string, subject: string): boolean {
  if (!matcher || matcher === "*") return true;
  const names = [subject, ...(CLAUDE_CODE_NAMES[subject] ?? [])];
  let re: RegExp | null = null;
  try {
    re = new RegExp(`^(?:${matcher})$`);
  } catch {
    re = null;
  }
  return names.some((n) => (re ? re.test(n) : n === matcher));
}
