// 自定义 agent 定义（Claude Code 的格式）：工作区的 .claude/agents/*.md 与 .dimensio/agents/*.md，主机管理员实例另读用户级的同名目录。
// frontmatter 的 name、description、tools（工具名列表，缺省 = 继承）、model（缺省或 inherit = 继承）；正文是它的系统提示词。
// 每次现读（文件少、很小）：Agent 工具按名字查时拿到的是磁盘上此刻的版本，system 里的清单只在会话建立时写、之后走 World State。
// 同名的：工作区的压过用户级的，同一级里 .dimensio 压过 .claude。与内置档同名（research / coder）的不认——那两个名字固定指内置档。
import fs from "node:fs";
import path from "node:path";
import { textTokens } from "../context.ts";
import { firstSentence } from "../../extensions.ts";
import { confinedConfigFile } from "../../extensions/confine.ts";
import { userAgentDirs } from "../../paths.ts";
import { tenantMode } from "../../tenant.ts";

export interface AgentDefinition {
  name: string;
  description: string;
  tools?: string[]; // 没写 = 继承
  model?: string; // 没写或 inherit = 继承
  prompt: string;
  source: string; // 定义文件的绝对路径
  scope: "project" | "user";
}

const NAME_RE = /^[A-Za-z0-9][\w.-]{0,63}$/;
const RESERVED = new Set(["research", "coder"]);
const MAX_FILES_PER_DIR = 60;
const MAX_FILE_BYTES = 64_000;
const MAX_PROMPT_CHARS = 20_000;
const DESC_MAX = 160;
const SECTION_SHARE = 0.01; // 清单预算：窗口的 1%，封顶下面这个数
const SECTION_CAP_TOKENS = 1_500;
const SECTION_FALLBACK_TOKENS = 1_000;

/** 读哪些目录（先低后高：后读的同名定义压过先读的）。成员实例只读自己工作区里的。 */
export function agentDefinitionDirs(root: string): { dir: string; scope: "project" | "user" }[] {
  const out: { dir: string; scope: "project" | "user" }[] = [];
  if (!tenantMode()) {
    const user = userAgentDirs();
    // .claude 在前、.dimensio 在后
    for (const dir of user) out.push({ dir, scope: "user" });
  }
  out.push({ dir: path.join(root, ".claude", "agents"), scope: "project" });
  out.push({ dir: path.join(root, ".dimensio", "agents"), scope: "project" });
  return out;
}

function unquote(v: string): string {
  const s = v.trim();
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\") : inner.replace(/''/g, "'");
  }
  return s;
}

// 够用的 frontmatter 解析：key: value、引号、| 与 > 块、[a, b] 与 - a 两种列表
export function parseFrontmatter(text: string): { fields: Record<string, string | string[]>; body: string } | null {
  const src = text.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  if (!src.startsWith("---\n")) return null;
  const end = src.indexOf("\n---", 4);
  if (end < 0) return null;
  const head = src.slice(4, end).split("\n");
  const after = src.slice(end + 4);
  const body = after.replace(/^[^\n]*\n?/, ""); // 结束行余下的部分
  const fields: Record<string, string | string[]> = {};
  for (let i = 0; i < head.length; i++) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(head[i]);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const raw = m[2].trim();
    const indented = (): string[] => {
      const lines: string[] = [];
      while (i + 1 < head.length && (/^\s+\S/.test(head[i + 1]) || head[i + 1].trim() === "")) lines.push(head[++i]);
      return lines;
    };
    if (raw === "|" || raw === ">" || raw === "|-" || raw === ">-") {
      const lines = indented().map((l) => l.trim());
      fields[key] = raw.startsWith("|") ? lines.join("\n").trim() : lines.join(" ").replace(/\s+/g, " ").trim();
    } else if (raw === "") {
      const items = indented()
        .map((l) => /^\s*-\s*(.+)$/.exec(l)?.[1])
        .filter((x): x is string => Boolean(x))
        .map(unquote);
      fields[key] = items;
    } else if (raw.startsWith("[") && raw.endsWith("]")) {
      fields[key] = raw.slice(1, -1).split(",").map(unquote).filter(Boolean);
    } else {
      fields[key] = unquote(raw);
    }
  }
  return { fields, body };
}

const asText = (v: string | string[] | undefined): string => (Array.isArray(v) ? v.join(" ") : (v ?? "")).trim();

function parseDefinition(file: string, scope: "project" | "user"): AgentDefinition | null {
  let text: string;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const parsed = parseFrontmatter(text);
  if (!parsed) return null;
  const name = asText(parsed.fields.name) || path.basename(file, path.extname(file));
  if (!NAME_RE.test(name) || RESERVED.has(name.toLowerCase())) return null;
  const description = asText(parsed.fields.description);
  const toolsRaw = parsed.fields.tools;
  const tools = toolsRaw === undefined
    ? undefined
    : (Array.isArray(toolsRaw) ? toolsRaw : toolsRaw.split(/[,\s]+/)).map((t) => t.trim()).filter(Boolean);
  const model = asText(parsed.fields.model);
  return {
    name,
    description,
    ...(tools && tools.length ? { tools } : {}),
    ...(model && model.toLowerCase() !== "inherit" ? { model } : {}),
    prompt: parsed.body.trim().slice(0, MAX_PROMPT_CHARS),
    source: file,
    scope,
  };
}

function listDir(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => e.name)
      .sort()
      .slice(0, MAX_FILES_PER_DIR)
      .map((n) => path.join(dir, n));
  } catch {
    return [];
  }
}

/** 此刻能用的自定义定义（按名字排序；同名按优先级只留一份）。 */
export function loadAgentDefinitions(root: string): AgentDefinition[] {
  const byName = new Map<string, AgentDefinition>();
  for (const { dir, scope } of agentDefinitionDirs(root)) {
    // 读之前按真实落点判（与技能、命令目录同一道闸）：项目级的不许经链接 / junction 读到工作区外或凭据，用户级的（~/.claude）
    // 链到别处时照样过凭据判定。agents 目录本身是链接时，里面每个文件的真实落点也在外面，同样被拦
    const base = scope === "project" ? root : path.dirname(dir);
    for (const file of listDir(dir)) {
      if (!confinedConfigFile(file, scope, base)) continue;
      const def = parseDefinition(file, scope);
      if (def) byName.set(def.name.toLowerCase(), def);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function findAgentDefinition(root: string, name: string): AgentDefinition | undefined {
  const want = name.trim().toLowerCase();
  return loadAgentDefinitions(root).find((d) => d.name.toLowerCase() === want);
}

/** system 里那一段的正文（没有自定义类型 = ""）。预算按窗口算，放不下的省略并注明。 */
export function agentTypesSection(root: string, contextWindow?: number): string {
  const defs = loadAgentDefinitions(root);
  if (!defs.length) return "";
  const limit = contextWindow && contextWindow > 0 ? Math.min(Math.floor(contextWindow * SECTION_SHARE), SECTION_CAP_TOKENS) : SECTION_FALLBACK_TOKENS;
  const head = "Besides research and coder, these custom types (defined in .claude/agents or .dimensio/agents) work as the Agent tool's subagent_type:";
  const lines: string[] = [];
  let used = textTokens(head);
  for (const d of defs) {
    const line = `- ${d.name}${d.description ? `: ${firstSentence(d.description, DESC_MAX)}` : ""}`;
    const cost = textTokens(line) + 1;
    if (used + cost > limit) break;
    lines.push(line);
    used += cost;
  }
  const omitted = defs.length - lines.length;
  if (omitted) lines.push(`- …and ${omitted} more; an unknown subagent_type lists every name`);
  return `${head}\n${lines.join("\n")}`;
}
