// Bridge 扩展中心的 dimensio 侧适配：bridge 在 DATA_ROOT/extensions/registry.json 维护
// 技能注册表（settings → 个性化 → 扩展），本模块只【读】它——env 传路径、用时现读
// （与 BRIDGE_DESKTOP_HOST_FILE / local-pc descriptor 同一范式），装/删扩展无需重启
// harness。仅新会话生效（与 GUIDE.md 同契约：resume 会话保持原 prompt 不漂移）。
//
// 沙箱语义：技能目录在 workspace 之外，file tools 与 Bash 的 workspace 围栏只对【勾给
// dimensio 的技能目录】有只读豁免（sandbox.ts / bash.ts 引用 grantedSkillDirs()）；写入仍拦。
// 注册表本身是凭据文件（连接器令牌），任何模式都进密钥守卫（isExtensionRegistryPath）。
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { textTokens } from "./agent/context.ts";
import { skillHeader } from "./agent/injections.ts";
import { bridgeRootCandidates } from "./paths.ts";

interface ExtensionItem {
  id: string;
  type: string;
  name: string;
  description?: string;
  enabled?: boolean;
  agents?: { claude?: boolean; dimensio?: boolean; codex?: boolean };
  dir?: string;
  entry?: string;
  pkg?: string; // 扩展中心的「包」（gildata-aifinmarket 45 个、caixin-data-agent 11 个……）
  short?: string; // C5（X51）：可选的短描述（≤80 字），目录里优先用它
  // E1：连接器（MCP 服务）。注册表里只有凭据的键名，值在 connector-secrets.*（见 mcp.ts）
  connector?: {
    key?: string;
    transport?: string;
    command?: string;
    args?: unknown[];
    url?: string;
    envKeys?: unknown[];
    headerKeys?: unknown[];
  };
}

// ── E1（G6）：勾给 dimensio 的连接器（MCP 服务）───────────────────────────────────
export interface ManagedConnector {
  id: string; // 扩展 id（凭据按它存）
  key: string; // 工具名前缀 mcp__<key>__…
  name: string;
  description: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  envKeys: string[];
  headerKeys: string[];
}

const slugKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);

// enabled 且勾给 dimensio 的连接器（现读；形状不对的跳过并在日志里说一声）
export function managedConnectors(): ManagedConnector[] {
  const file = registryFile();
  if (!file) return [];
  const raw = readRegistry(file);
  const items = Array.isArray(raw?.items) ? raw!.items : [];
  const out: ManagedConnector[] = [];
  for (const item of items) {
    if (item?.type !== "connector" || !item.enabled || !item.agents?.dimensio || !item.connector) continue;
    const c = item.connector;
    const transport = c.transport === "stdio" || c.transport === "http" || c.transport === "sse" ? c.transport : null;
    const label = String(item.name || item.id).slice(0, 80);
    if (!transport) {
      warnOnce(`连接器「${label}」的传输方式不认识，跳过`);
      continue;
    }
    if (transport === "stdio" && !(typeof c.command === "string" && c.command.trim())) {
      warnOnce(`连接器「${label}」没有启动命令，跳过`);
      continue;
    }
    if (transport !== "stdio" && !(typeof c.url === "string" && /^https?:\/\//i.test(c.url))) {
      warnOnce(`连接器「${label}」的地址不是 http(s)，跳过`);
      continue;
    }
    const key = slugKey(typeof c.key === "string" && c.key ? c.key : item.name || item.id) || `c${out.length + 1}`;
    const strings = (v: unknown[] | undefined) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    out.push({
      id: String(item.id),
      key,
      name: oneLine(item.name, 80) || key,
      description: oneLine(item.description, 300),
      transport,
      ...(transport === "stdio" ? { command: String(c.command), args: strings(c.args) } : { url: String(c.url) }),
      envKeys: strings(c.envKeys),
      headerKeys: strings(c.headerKeys),
    });
  }
  return out;
}

// C5：注册表顶层可选的包说明（扩展中心以后可以写；现在没有就按成员推一句）
interface RegistryFile {
  items?: ExtensionItem[];
  pkgs?: Record<string, { description?: string }>;
}

function registryFile(): string | null {
  if (process.env.BRIDGE_EXTENSIONS_FILE) return path.resolve(process.env.BRIDGE_EXTENSIONS_FILE);
  // 独立 8799 开发时 cwd=harness/，上级即 bridge 数据根（候选顺序见 paths.ts）。
  for (const root of bridgeRootCandidates()) {
    const file = path.join(root, "extensions", "registry.json");
    if (existsSync(file)) return file;
  }
  return null;
}

// 扩展根目录（skills/plugins 的父级）。注册表还不存在时也返回稳定路径（env 显式给了
// 的话），这样密钥守卫对注册表的判定在首个技能装入前后行为一致。
export function managedExtensionRoots(): string[] {
  if (process.env.BRIDGE_EXTENSIONS_FILE) return [path.dirname(path.resolve(process.env.BRIDGE_EXTENSIONS_FILE))];
  const file = registryFile();
  return file ? [path.dirname(file)] : [];
}

const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);
const samePathOrInside = (p: string, dir: string) => {
  const a = fold(p);
  const b = fold(dir);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};

// S3（#36）：注册表本身（及同目录的 registry.json.* 临时/备份件）是凭据文件——老注册表的连接器 headers/env 里是
// 明文 Bearer 令牌；阶段 2 起凭据挪进同目录的 connector-secrets.*（密文 + DPAPI 包住的数据密钥），同样当凭据文件。
// 任何访问模式下 Read / Bash 都不许碰。
export function isExtensionRegistryPath(abs: string): boolean {
  const p = path.resolve(abs);
  if (!/^(?:registry\.json|connector-secrets)/i.test(path.basename(p))) return false;
  return managedExtensionRoots().some((root) => fold(path.dirname(p)) === fold(root));
}

// S3（#36）：只读豁免只给「启用且勾给 dimensio 的技能」各自的目录。以前豁免整个扩展根，
// 于是没勾给 dimensio 的技能正文和注册表（连接器令牌）都能在 workspace 模式下读到。
export function grantedSkillDirs(): string[] {
  return managedSkills().map((s) => path.dirname(s.skillMd));
}

// 沙箱侧判定：此绝对路径是否落在已授权技能目录内（file tools 的只读豁免 / Bash 白名单共用）。
export function insideGrantedSkillDir(abs: string): boolean {
  const p = path.resolve(abs);
  return grantedSkillDirs().some((dir) => samePathOrInside(p, dir));
}

export interface ManagedSkill {
  name: string;
  description: string;
  skillMd: string;   // SKILL.md 绝对路径
  pkg?: string;
  short?: string;
  // E3（G7）：SKILL.md frontmatter 里的三个 Claude Code 字段——
  //   disable-model-invocation: true → userOnly：只能用户 /名字 点（目录里不给模型看、Skill 工具也载入不了）＝「自定义命令」
  //   user-invocable: false → hidden：不进输入框的 / 面板（模型照常可用）
  //   argument-hint → / 面板上名字后面的参数提示
  userOnly?: boolean;
  hidden?: boolean;
  argumentHint?: string;
}

// E3：frontmatter 里那几个字段，按 SKILL.md 的 mtime + 大小缓存（目录每个新会话读一遍，别每次都重读几十个文件）
interface SkillFlags {
  userOnly: boolean;
  hidden: boolean;
  argumentHint?: string;
}
const flagCache = new Map<string, { key: string; flags: SkillFlags }>();
const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---/;

function frontmatterValue(head: string, key: string): string | undefined {
  const m = new RegExp(`^${key}[ \\t]*:[ \\t]*(.*)$`, "m").exec(head);
  if (!m) return undefined;
  return m[1].trim().replace(/^(['"])(.*)\1$/, "$2");
}

// 读不到（没了、不是文件）返回 null
function skillFlags(skillMd: string): SkillFlags | null {
  let key: string;
  try {
    const st = statSync(skillMd);
    if (!st.isFile()) return null;
    key = `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
  const hit = flagCache.get(skillMd);
  if (hit?.key === key) return hit.flags;
  let head = "";
  try {
    head = FRONTMATTER_RE.exec(readFileSync(skillMd, "utf8"))?.[1] ?? "";
  } catch {
    return null;
  }
  const hint = oneLine(frontmatterValue(head, "argument-hint"), 80);
  const flags: SkillFlags = {
    userOnly: /^(?:true|yes)$/i.test(frontmatterValue(head, "disable-model-invocation") ?? ""),
    hidden: /^(?:false|no)$/i.test(frontmatterValue(head, "user-invocable") ?? ""),
    ...(hint ? { argumentHint: hint } : {}),
  };
  flagCache.set(skillMd, { key, flags });
  return flags;
}

// G10：以前注册表坏了、技能的 SKILL.md 没了都静默当成「没有」。仍然不许拖垮会话创建，但要在日志里说一声
// （同一句只说一次；扩展中心页面上另有 bridge 的诊断）。
const warned = new Set<string>();
function warnOnce(msg: string): void {
  if (warned.has(msg)) return;
  warned.add(msg);
  console.warn(`[extensions] ${msg}`);
}

function readRegistry(file: string): RegistryFile | null {
  try {
    let text = readFileSync(file, "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text) as RegistryFile;
  } catch (e) {
    warnOnce(`registry.json 解析失败（${(e as Error).message.slice(0, 120)}），这次按没有托管技能处理`);
    return null;
  }
}

const oneLine = (s: unknown, max: number) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);

// enabled 且勾选 dimensio 的技能（现读现取；文件损坏/缺失一律视为无扩展，不许拖垮会话创建）。
export function managedSkills(): ManagedSkill[] {
  return readManaged()?.skills ?? [];
}

function readManaged(): { skills: ManagedSkill[]; pkgDescriptions: Map<string, string> } | null {
  const file = registryFile();
  if (!file) return null;
  const raw = readRegistry(file);
  if (!raw) return null;
  const items = Array.isArray(raw.items) ? raw.items : [];
  const root = path.dirname(file);
  const skills: ManagedSkill[] = [];
  for (const item of items) {
    if (item?.type !== "skill" || !item.enabled || !item.agents?.dimensio || !item.dir) continue;
    const dir = path.resolve(root, item.dir);
    if (dir !== root && !dir.startsWith(root + path.sep)) continue;   // 注册表被手改出穿越 → 弃
    const skillMd = path.join(dir, item.entry || "SKILL.md");
    const flags = skillFlags(skillMd);
    if (!flags) {
      warnOnce(`技能「${String(item.name || item.id).slice(0, 80)}」勾给了 dimensio，但 ${skillMd} 不在了，跳过`);
      continue;
    }
    skills.push({
      name: oneLine(item.name, 80),
      description: oneLine(item.description, 600),
      skillMd,
      ...(typeof item.pkg === "string" && item.pkg.trim() ? { pkg: oneLine(item.pkg, 80) } : {}),
      ...(typeof item.short === "string" && item.short.trim() ? { short: oneLine(item.short, 80) } : {}),
      ...(flags.userOnly ? { userOnly: true } : {}),
      ...(flags.hidden ? { hidden: true } : {}),
      ...(flags.argumentHint ? { argumentHint: flags.argumentHint } : {}),
    });
  }
  const pkgDescriptions = new Map<string, string>();
  for (const [name, meta] of Object.entries(raw.pkgs && typeof raw.pkgs === "object" ? raw.pkgs : {})) {
    if (typeof meta?.description === "string" && meta.description.trim()) pkgDescriptions.set(name, oneLine(meta.description, 300));
  }
  return { skills, pkgDescriptions };
}

// ── C5（G1、K57、X51）技能目录经济学 ─────────────────────────────────────────
// 以前目录平铺：73 条、每条完整描述 + SKILL.md 绝对路径，约 2.7 万字符常驻 system，其中 77% 是两个财经包（gildata 45、
// caixin 11）。现在：
//  · 成员 ≥3 的包折成一行（包说明 + 成员名单），按名加载——09-23 定为「折叠」，不做 implicit:false 摘除；
//  · 不再列路径（Skill 工具按名加载并交回目录；比 Codex 的路径别名更省）；
//  · 预算 = 模型窗口 × 2%（封顶 1 万 token），拿不到窗口按 8000 字符；超了按「截描述 → 删描述 → 省略条目」退化，
//    省略的条目仍能按名加载（Skill 报「没有这个名字」时列全部名字）。
export const FOLD_MIN_MEMBERS = 3;
export const CATALOG_BUDGET_SHARE = 0.02;
export const CATALOG_BUDGET_CAP_TOKENS = 10_000;
export const CATALOG_FALLBACK_CHARS = 8_000;

export interface SkillPackage {
  pkg: string;
  description: string;
  members: ManagedSkill[];
}

export type CatalogEntry = { kind: "skill"; skill: ManagedSkill } | { kind: "pkg"; pkg: SkillPackage };

// 包说明：注册表顶层 pkgs 里写了就用；否则找「路由」成员（名字是包名的前一截，gildata ⊂ gildata-aifinmarket）用它的描述；
// 再不然拼各成员描述的开头一截（「财新宏观行业数据 / 财新股票数据 / …」）。
function packageDescription(pkg: string, members: ManagedSkill[], given?: string): string {
  if (given) return given;
  const router = members.find((m) => pkg.toLowerCase() === m.name.toLowerCase() || pkg.toLowerCase().startsWith(`${m.name.toLowerCase()}-`));
  if (router) return router.short || router.description;
  const heads = members.map((m) => (m.short || m.description).split(/[：:。.;；,，(（]/)[0].trim().slice(0, 30)).filter(Boolean);
  return [...new Set(heads)].join(" / ").slice(0, 300);
}

// 目录条目：包按第一个成员的位置出现，成员不足 FOLD_MIN_MEMBERS 的包照单条列。
export function catalogEntries(skills: ManagedSkill[], pkgDescriptions = new Map<string, string>()): CatalogEntry[] {
  const groups = new Map<string, ManagedSkill[]>();
  for (const s of skills) if (s.pkg) groups.set(s.pkg, [...(groups.get(s.pkg) ?? []), s]);
  const out: CatalogEntry[] = [];
  const placed = new Set<string>();
  for (const s of skills) {
    const members = s.pkg ? groups.get(s.pkg)! : [];
    if (s.pkg && members.length >= FOLD_MIN_MEMBERS) {
      if (placed.has(s.pkg)) continue;
      placed.add(s.pkg);
      out.push({ kind: "pkg", pkg: { pkg: s.pkg, description: packageDescription(s.pkg, members, pkgDescriptions.get(s.pkg)), members } });
    } else out.push({ kind: "skill", skill: s });
  }
  return out;
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

// 瘦身 P0-3：目录里的描述只留第一句（到句末标点为止），再封顶——完整说明在 SKILL.md 里，Skill 载入时才要。以前每条截到 250 字，
// 实际使用中 20 条目录约 6.9k 字符常驻，大半是第二句往后的用法细节与触发词清单。
const ONE_LINE_MAX = 120;
export function firstSentence(s: string, max = ONE_LINE_MAX): string {
  const flat = s.replace(/\s+/g, " ").trim();
  const end = flat.search(/[。！？；]|[.!?;](?=\s|#|$)/);
  return clip(end > 0 ? flat.slice(0, end + 1) : flat, max);
}

// 退化档：0 = 描述一句（≤120 字）、包带成员名单；1 = 描述截 60 字、包只报个数；2 = 只剩名字。
function renderEntry(e: CatalogEntry, level: number): string {
  if (e.kind === "skill") {
    const desc = e.skill.short || e.skill.description;
    if (level >= 2 || !desc) return `- ${e.skill.name}`;
    return `- ${e.skill.name} — ${level === 0 ? firstSentence(desc) : clip(desc, 60)}`;
  }
  const { pkg, description, members } = e.pkg;
  if (level >= 2) return `- ${pkg} (package, ${members.length} skills)`;
  const desc = level === 0 ? firstSentence(description) : clip(description, 60);
  if (level === 1) return `- ${pkg} (package, ${members.length} skills) — ${desc}`;
  return `- ${pkg} (package, ${members.length} skills) — ${desc}\n  skills: ${members.map((m) => m.name).join(", ")}`;
}

export function catalogBudget(contextWindow?: number): { tokens?: number; chars?: number } {
  if (contextWindow && Number.isFinite(contextWindow) && contextWindow > 0) {
    return { tokens: Math.min(Math.floor(contextWindow * CATALOG_BUDGET_SHARE), CATALOG_BUDGET_CAP_TOKENS) };
  }
  return { chars: CATALOG_FALLBACK_CHARS };
}

// 按预算渲染条目行：先找放得下全部条目的最高档；三档都放不下，就用只剩名字的一档从前往后放，放不下的省略并注明。
export function renderCatalog(entries: CatalogEntry[], budget: { tokens?: number; chars?: number }): { text: string; level: number; omitted: number } {
  const cost = (s: string) => (budget.tokens !== undefined ? textTokens(s) : s.length);
  const limit = budget.tokens ?? budget.chars ?? Infinity;
  for (let level = 0; level <= 2; level++) {
    const text = entries.map((e) => renderEntry(e, level)).join("\n");
    if (cost(text) <= limit) return { text, level, omitted: 0 };
  }
  const kept: string[] = [];
  let used = 0;
  for (const e of entries) {
    const line = renderEntry(e, 2);
    if (used + cost(line) + 1 > limit) break;
    kept.push(line);
    used += cost(line) + 1;
  }
  const omitted = entries.length - kept.length;
  kept.push(`- …and ${omitted} more not listed to save context — any of them loads by name; Skill with an unknown name lists every name`);
  return { text: kept.join("\n"), level: 3, omitted };
}

// system prompt 的「托管技能」段。contextWindow 用来算预算（见上）。
export function managedSkillsSection(opts: { contextWindow?: number } = {}): string | undefined {
  const managed = readManaged();
  // E3：只能用户点名的技能（disable-model-invocation）不进目录——模型既看不到、也载入不了
  const skills = (managed?.skills ?? []).filter((s) => !s.userOnly);
  if (!managed || !skills.length) return undefined;
  const { text } = renderCatalog(catalogEntries(skills, managed.pkgDescriptions), catalogBudget(opts.contextWindow));
  return `The user installed these skills via the Bridge extension center. When the user names a skill, or a task clearly matches one, load it FIRST with the Skill tool — Skill({name: "<skill>"}) — and follow its instructions before doing the work your own way. A package groups related skills: load a listed member directly by its name, or Skill({name: "<package>"}) to see what each member does. Don't hand a skill to a sub-agent (Agent / Workflow) to read or follow: load it yourself and put the steps that matter into the sub-agent's prompt.

${text}`;
}

// ── C5：Skill 工具按名现读注册表（新装的技能在点名时也能用；清单在会话里是冻结的）──
export type SkillLookup =
  | { kind: "skill"; skill: ManagedSkill }
  | { kind: "pkg"; pkg: SkillPackage }
  | { kind: "missing"; names: string[]; packages: string[] };

export function findSkill(name: string): SkillLookup {
  const managed = readManaged();
  const skills = managed?.skills ?? [];
  const want = name.trim().toLowerCase().replace(/^\//, "");
  const skill = skills.find((s) => s.name.toLowerCase() === want) ?? skills.find((s) => s.pkg && `${s.pkg}/${s.name}`.toLowerCase() === want);
  if (skill) return { kind: "skill", skill };
  const members = skills.filter((s) => s.pkg && s.pkg.toLowerCase() === want);
  if (members.length) {
    const pkg = members[0].pkg!;
    return { kind: "pkg", pkg: { pkg, description: packageDescription(pkg, members, managed?.pkgDescriptions.get(pkg)), members } };
  }
  return {
    kind: "missing",
    names: skills.map((s) => s.name),
    packages: [...new Set(skills.flatMap((s) => (s.pkg ? [s.pkg] : [])))],
  };
}

export const SKILL_BODY_MAX_CHARS = 40_000;
export const SKILL_ARGS_MAX = 4_000;
const escapeXml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// 技能正文作为 harness 消息的全文（Skill 工具载入与 E3 的 /技能名 共用）：头一行 [Skill: 名字] + 可选的一句引导 + 技能目录 +
// 正文。E3：跟 Claude Code 一样认 $ARGUMENTS——正文里写了就换成参数（用户自己的话，原样）；没写而 argsBlock 开着，就另附一段
// （XML 转义）。/技能名 的参数就在上面那条用户消息里，不再另附。只认 $ARGUMENTS：正文里的 $1 多半是 shell 示例，不能替换。
// 读不到 SKILL.md 返回 null。
export function skillMessage(skill: ManagedSkill, opts: { args?: string; lead?: string; argsBlock?: boolean } = {}): string | null {
  const loaded = readSkillBody(skill);
  if (!loaded) return null;
  const args = String(opts.args ?? "").trim().slice(0, SKILL_ARGS_MAX);
  const templated = loaded.body.includes("$ARGUMENTS");
  const body = templated ? loaded.body.replaceAll("$ARGUMENTS", () => args) : loaded.body;
  return (
    `${skillHeader(skill.name)}\n` +
    (opts.lead ? `${opts.lead}\n` : "") +
    `Loaded from the Bridge extension center. Skill directory: ${path.dirname(skill.skillMd)} — its supporting files and scripts live there (read-only; run scripts from that directory with Bash).\n\n` +
    body +
    (loaded.truncated ? `\n\n[SKILL.md is longer than this — the rest is in ${skill.skillMd}; Read it from there if the part you need is missing]` : "") +
    (args && !templated && opts.argsBlock !== false ? `\n\n[Arguments given when loading]\n<skill-args>${escapeXml(args)}</skill-args>` : "")
  );
}

// E3：正文里有没有 $ARGUMENTS（有的话同一个技能换了参数要重新注入，不能只提醒「前面载入过」）
export function skillUsesArguments(skill: ManagedSkill): boolean {
  return readSkillBody(skill)?.body.includes("$ARGUMENTS") ?? false;
}

// SKILL.md 正文（去掉 frontmatter；过长截断并注明全文在哪）。读不了返回 null。
export function readSkillBody(skill: ManagedSkill): { body: string; truncated: boolean } | null {
  let text: string;
  try {
    text = readFileSync(skill.skillMd, "utf8");
  } catch {
    return null;
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const fm = /^---\r?\n[\s\S]*?\r?\n---[^\n]*(?:\r?\n|$)/.exec(text);
  const body = (fm ? text.slice(fm[0].length) : text).trim();
  if (body.length <= SKILL_BODY_MAX_CHARS) return { body, truncated: false };
  return { body: body.slice(0, SKILL_BODY_MAX_CHARS), truncated: true };
}
