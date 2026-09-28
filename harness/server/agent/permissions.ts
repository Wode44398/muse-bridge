import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { configFile, globalGuideFile, memoryRoot, sessionsDir } from "../paths.ts";
import { IMDS_REASON, mentionsImds, type Reason } from "../tools/shell-policy.ts";
import type { PermissionView, Tool } from "../tools/types.ts";

// Permission model: a coarse MODE, plus per-call RULES on top of the always-on
// containment inside the tools themselves (workspace-root path checks + secret guard +
// Bash deny-list).
//
//   auto       — effectful tools run; rules may still route a call to "ask"
//   read-only  — only read-effect tools; everything else denied outright
//   plan       — like read-only, but the agent is told to research and then submit
//                a plan (ExitPlanMode) for the user to approve; approving flips the
//                session to auto and the same run continues
//
// Rules are string patterns matched against a tool call's PRIMARY subject (the
// command for Bash, the path for file tools, the url for fetches):
//   "Bash"                 → every Bash call
//   "Bash(git push:*)"     → Bash calls whose command starts with "git push"
//   "Write(*)"             → every Write call (explicit-any form)
//   "Edit(src/**)"         → Edit calls whose path matches the glob
// deny wins over allow, allow wins over ask; an unmatched call falls back to the
// mode's default. Matching is textual and deliberately simple: it is a guard
// against the model doing something careless, NOT a sandbox against an
// adversarial one (that is what access/sandbox + the deny-list are for).
//
// P4（A5，#4）：Bash 按子命令判——`a && b | c`、$(…) 里的、bash -c "…" 里的都各算一条。deny/ask 任一子命令命中
// 即生效（`cd x && rm -rf y` 撞上 deny `rm -rf:*`）；allow 要求每条子命令都被覆盖（`git push:*` 不再连
// `git push && rm -rf ~` 一起放行），带运行时的值、写文件的重定向或 sudo 的子命令只认一字不差的规则；
// 整条命令与规则原文一字不差（「本会话都允许」写的就是这种）照旧放行。
export type PermissionMode = "auto" | "read-only" | "plan";

// 合法档位的单一真相：配置校验与会话内切档端点都从这里取，
// 免得新增一档时漏改其中一处。顺序即 UI 里的排列顺序。
export const PERMISSION_MODES: PermissionMode[] = ["auto", "read-only", "plan"];

export function isPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === "string" && (PERMISSION_MODES as string[]).includes(v);
}

export interface PermissionRules {
  allow: string[];
  deny: string[];
  ask: string[];
}

export const EMPTY_RULES: PermissionRules = { allow: [], deny: [], ask: [] };

// P1（#47）：「本会话都允许」单独成一层，记下它产生时的授权状态——模式、访问范围、全局规则任一变了，
// 这条允许就不再算数（Codex 的「缓存的批准绑定策略 fingerprint」）。以前它混在按会话冻结的规则快照里，
// 只在内存，会话闲置被淘汰就丢；切了模式 / 访问范围照样生效。
export interface SessionAllow {
  rule: string;
  mode: PermissionMode;
  access: string;
  rulesHash: string;
  // P5：2 = 规则按新写法记下（字面规则 Tool(=原文) 或前缀规则）。没有这个字段的是旧记录，
  // 当时一律是 Tool(原文)、原文里的 * ? 会被当通配符——载入时改成字面规则（见 upgradeSessionAllow）。
  v?: 2;
}

export function rulesFingerprint(r: PermissionRules): string {
  const norm = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))].sort();
  return createHash("sha1").update(JSON.stringify([norm(r.allow), norm(r.deny), norm(r.ask)])).digest("hex").slice(0, 12);
}

// P5（A6，#4）：「本会话都允许」默认记一字不差的字面规则 Tool(=原文)。以前记 Tool(原文)，原文里的 * ? 被当成
// 通配符——批准一次 `rm -rf build/*`，之后 `rm -rf build/../../x` 也静默放行，用户以为批的是一条、实际批了一族。
export function sessionAllowRule(toolName: string, subject: string): string {
  return subject ? `${toolName}(=${subject})` : toolName;
}

// 旧记录（没有 v）里的 Tool(原文) 改写成字面规则；新记录原样返回。
export function upgradeSessionAllow(a: SessionAllow): SessionAllow {
  if (a.v === 2) return a;
  const parsed = parseRule(a.rule);
  const rule = parsed?.pattern && !parsed.pattern.startsWith("=") ? `${parsed.tool}(=${parsed.pattern})` : a.rule;
  return { ...a, rule, v: 2 };
}

export interface Decision {
  // "ask" = block and put the decision to the user (the loop turns this into a
  // permission card; if no human is attached it degrades to deny).
  effect: "allow" | "deny" | "ask";
  reason: string;
  // The pattern that matched, for the card and the audit trail.
  rule?: string;
  // S12：只能「允许这一次」——卡片不给「本会话都允许」（控制面文件）
  noSession?: boolean;
  // P14（ZCode C5）：结构化的判定来源——权限审计记录按它归类，不从 reason 的措辞里猜
  source?: DecisionSource;
  // P11（ZCode C1）：转问时写在卡片上给人看的中文原因（reason 是回给模型的英文）
  why?: string;
}

export type DecisionSource =
  | "unknown-tool"
  | "deny-rule"
  | "deny-path"
  | "mode"
  | "control-plane"
  | "repeat-denial"
  | "allow-rule"
  | "risk-review"
  | "irreversible"
  | "tool-confirm"
  | "ask-rule"
  | "ask-path"
  | "partial-path"
  | "outside-read" // P13（X18）：沙箱按「工作区外」拒了一次读，问人要不要放行（loop 在工具跑完之后问，不经 decide）
  | "default";

// The argument a rule pattern is matched against, per tool. Anything without a
// meaningful subject matches only the bare-tool-name form.
export function callSubject(toolName: string, args: Record<string, unknown>): string {
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (toolName) {
    case "Bash":
      // poll/kill act on an existing job, not a new command.
      return s(args.command) || s(args.poll) || s(args.kill);
    case "Read":
    case "Write":
    case "Edit":
    case "Glob":
    case "Grep":
      return s(args.path) || s(args.file) || s(args.pattern);
    case "WebFetch":
      return s(args.url);
    case "Browser":
      return s(args.url) || s(args.action);
    case "Preview":
      return s(args.command) || s(args.action);
    case "Eval":
      return s(args.js);
    // E2：MCP 网关——「本会话都允许」记到「连接器/工具」这一层，不一次放开所有连接器的所有工具
    case "McpCall":
      return `${s(args.server)}/${s(args.tool)}`;
    default:
      return "";
  }
}

// "Tool(arg-pattern)" → parts; "Tool" → no pattern (matches every call).
function parseRule(rule: string): { tool: string; pattern?: string } | null {
  const m = /^\s*([A-Za-z][\w-]*)\s*(?:\(([\s\S]*)\))?\s*$/.exec(rule);
  if (!m) return null;
  return { tool: m[1], pattern: m[2]?.trim() };
}

// 字面比较：只去首尾空白、统一换行、把行内连续空格并成一个。换行不并——它在 shell 里是命令分隔符，
// `echo a rm -rf x` 与 `echo a⏎rm -rf x` 是两回事。
function sameLiteral(a: string, b: string): boolean {
  const norm = (v: string) => v.trim().replace(/\r\n?/g, "\n").replace(/[ \t]+/g, " ");
  return norm(a) === norm(b);
}

// Glob-ish match used for rule patterns: `*` spans anything (including "/" —
// these are command lines as often as paths), `?` one char. A pattern ending in
// ":*" is the common "command prefix" form, e.g. "git push:*". A pattern starting
// with "=" is literal (P5): "=rm -rf build/*" matches exactly that text.
function patternMatches(pattern: string, subject: string): boolean {
  if (pattern.startsWith("=")) return sameLiteral(pattern.slice(1), subject);
  if (!pattern || pattern === "*") return true;
  const prefix = /^(.*):\*$/.exec(pattern);
  if (prefix) {
    const head = prefix[1].trim();
    // Prefix form is whitespace-insensitive at the boundary so "git push" also
    // matches "git  push --force" and "git push".
    const norm = (v: string) => v.trim().replace(/\s+/g, " ");
    const s = norm(subject);
    const h = norm(head);
    return s === h || s.startsWith(h + " ");
  }
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("^" + escaped.replace(/\*/g, "[\\s\\S]*").replace(/\?/g, "[\\s\\S]") + "$", "i");
  return re.test(subject.trim());
}

export function ruleMatches(rule: string, toolName: string, subject: string): boolean {
  const parsed = parseRule(rule);
  if (!parsed) return false;
  if (parsed.tool.toLowerCase() !== toolName.toLowerCase()) return false;
  if (parsed.pattern === undefined) return true;
  return patternMatches(parsed.pattern, subject);
}

const firstMatch = (rules: string[], toolName: string, subject: string): string | undefined =>
  rules.find((rule) => ruleMatches(rule, toolName, subject));

// 规则原文当字面值（去掉 P5 字面规则的 = 前缀）
const literalOf = (pattern: string) => (pattern.startsWith("=") ? pattern.slice(1) : pattern);

// deny / ask：整条命令命中，或任一子命令（原文或剥掉包装器后的 argv）命中
function anyMatch(rules: string[], toolName: string, subject: string, view: PermissionView | null): string | undefined {
  const whole = firstMatch(rules, toolName, subject);
  if (whole || !view?.subjects) return whole;
  for (const s of view.subjects) {
    const hit = firstMatch(rules, toolName, s.text) ?? (s.alt !== s.text ? firstMatch(rules, toolName, s.alt) : undefined);
    if (hit) return hit;
  }
  return undefined;
}

// allow：裸工具名 / Tool(*)、规则原文与整条命令一字不差，或每条子命令都被某条 allow 覆盖
function allowCoverage(rules: string[], toolName: string, subject: string, view: PermissionView | null): string | undefined {
  if (!view?.subjects) return firstMatch(rules, toolName, subject);
  const own = rules
    .map((rule) => ({ rule, parsed: parseRule(rule) }))
    .filter((r) => r.parsed && r.parsed.tool.toLowerCase() === toolName.toLowerCase());
  const whole = own.find(({ parsed }) => {
    const p = parsed!.pattern;
    return p === undefined || p === "*" || sameLiteral(literalOf(p), subject);
  });
  if (whole) return whole.rule;
  if (view.partial || !view.subjects.length) return undefined;
  const used = new Set<string>();
  for (const s of view.subjects) {
    const hit = own.find(({ parsed }) => {
      const p = parsed!.pattern!;
      return s.exactOnly ? sameLiteral(literalOf(p), s.text) : patternMatches(p, s.text);
    });
    if (!hit) return undefined;
    used.add(hit.rule);
  }
  return [...used].join(", ");
}

// K5 转问时卡片上显示的「规则」：不是用户写的规则，是内置的高危命令复核
export const RISK_REVIEW_RULE = "内置·高危命令复核";
// P12：检查点兜不住的操作（远端、全局环境、执行刚下载的内容、云元数据端点……）
export const IRREVERSIBLE_RULE = "内置·不可恢复操作";
// P11（ZCode C2）：工具自己要求启动前确认（Workflow）——以前在工具的 run() 里另弹一张卡，现在进统一权限闸
export const TOOL_CONFIRM_RULE = "内置·启动前确认";
// P6：本 run 里拒绝过同一个目标，换了工具又来——卡片上这样标
export const REPEAT_DENIAL_RULE = "刚拒绝过同一目标";

// ── P6：资源（X17：拒绝与路径规则绑定到资源，不绑定到工具名）─────────────────────
// 同一个文件在不同调用里写法不同：src/a.ts、./src/a.ts、C:\ws\src\a.ts、/c/ws/src/a.ts、~/x。
function absolutePath(raw: string, root?: string): string | null {
  let p = raw.trim();
  if (!p || /^[a-z][a-z0-9+.-]*:\/\//i.test(p) || /[*?$`]/.test(p)) return null; // URL、glob、变量：说不准是哪个文件
  if (p === "~" || /^~[\\/]/.test(p)) p = path.join(os.homedir(), p.slice(1));
  else if (process.platform === "win32" && /^\/[A-Za-z](?:\/|$)/.test(p)) p = `${p[1]}:/${p.slice(3)}`;
  const absolute = path.isAbsolute(p) || /^[A-Za-z]:[\\/]/.test(p);
  if (!absolute && !root) return null;
  return (absolute ? path.resolve(p) : path.resolve(root!, p)).replace(/\\/g, "/");
}

// 判「是不是同一个」的键：绝对路径、正斜杠，Windows 上不分大小写
export function resourceKey(raw: string, root?: string): string | null {
  const abs = absolutePath(raw, root);
  if (!abs) return null;
  return process.platform === "win32" ? abs.toLowerCase() : abs;
}

// 路径规则按这几种写法都比一遍：原文、绝对路径（正反斜杠）、相对工作区
function pathForms(raw: string, root?: string): string[] {
  const forms = new Set([raw]);
  const abs = absolutePath(raw, root);
  if (abs) {
    forms.add(abs);
    forms.add(abs.replace(/\//g, "\\"));
    if (root) {
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) forms.add(rel);
    }
  }
  return [...forms];
}

const PATH_RULE_TOOLS = new Set(["edit", "write"]);

// Edit(src/**)、Write(*.lock) 这类带模式的路径规则，同样作用于 Bash 的写目标
function pathRuleHit(rules: string[], writes: string[], root?: string): { rule: string; target: string } | undefined {
  if (!writes.length) return undefined;
  for (const rule of rules) {
    const parsed = parseRule(rule);
    if (!parsed?.pattern || !PATH_RULE_TOOLS.has(parsed.tool.toLowerCase())) continue;
    for (const target of writes) {
      if (pathForms(target, root).some((form) => patternMatches(parsed.pattern!, form))) return { rule, target };
    }
  }
  return undefined;
}

const firstPathRule = (rules: PermissionRules): string | undefined =>
  [...rules.deny, ...rules.ask].find((rule) => {
    const parsed = parseRule(rule);
    return Boolean(parsed?.pattern && PATH_RULE_TOOLS.has(parsed.tool.toLowerCase()));
  });

const str = (v: unknown) => (typeof v === "string" ? v : "");

function pathArg(toolName: string, args: Record<string, unknown>): { path: string; access: "read" | "write" } | null {
  switch (toolName) {
    case "Edit":
    case "Write":
      return str(args.path) || str(args.file) ? { path: str(args.path) || str(args.file), access: "write" } : null;
    case "Read":
      return str(args.path) || str(args.file) ? { path: str(args.path) || str(args.file), access: "read" } : null;
    case "Grep":
    case "Glob":
      return str(args.path) ? { path: str(args.path), access: "read" } : null;
    default:
      return null;
  }
}

// P6（X17）：本 run 的拒绝台账。用户（或没人在场时的策略）拒绝过的目标记下来：之后换什么工具碰同一个目标，
// 都要再问一次——有人在场出卡、注明刚拒绝过，没人在场直接拒。以前拒了 Edit，下一步 printf > 同一个文件照写，
// 全程只出一张卡（#49）。拒的是读：之后读写都算碰；拒的是写：只有写算。用户后来又点了允许，就把它从台账里放掉。
export class DeniedTargets {
  private readonly paths = new Map<string, { access: "read" | "write"; label: string }>();
  // 不是路径的主体：命令原文、URL
  private readonly others = new Set<string>();

  get size(): number {
    return this.paths.size + this.others.size;
  }

  clear(): void {
    this.paths.clear();
    this.others.clear();
  }

  record(toolName: string, args: Record<string, unknown>, view: PermissionView | null, root?: string): void {
    const add = (raw: string, access: "read" | "write") => {
      const key = resourceKey(raw, root);
      if (!key) return;
      const prev = this.paths.get(key);
      if (!prev || (prev.access === "write" && access === "read")) this.paths.set(key, { access, label: raw });
    };
    const p = pathArg(toolName, args);
    if (p) add(p.path, p.access);
    for (const target of view?.writes ?? []) add(target, "write");
    const subject = callSubject(toolName, args).trim();
    if (!p && subject) this.others.add(subject);
  }

  // 这次调用碰到的被拒目标（给卡片与文案用的原文）；没碰到返回 undefined
  touched(toolName: string, args: Record<string, unknown>, view: PermissionView | null, root?: string): string | undefined {
    if (!this.size) return undefined;
    const hit = (raw: string, access: "read" | "write") => {
      const key = resourceKey(raw, root);
      const denied = key ? this.paths.get(key) : undefined;
      return denied && (access === "write" || denied.access === "read") ? denied.label : undefined;
    };
    const p = pathArg(toolName, args);
    if (p) return hit(p.path, p.access);
    if (toolName !== "Bash") {
      const subject = callSubject(toolName, args).trim();
      return subject && this.others.has(subject) ? subject : undefined;
    }
    for (const target of view?.writes ?? []) {
      const h = hit(target, "write");
      if (h) return h;
    }
    // 写什么看不出来的（解释器、构建工具）：非只读子命令提到了被拒的路径就算碰
    for (const word of view?.mentions ?? []) {
      const h = hit(word, "write");
      if (h) return h;
    }
    const command = str(args.command);
    for (const denied of this.paths.values()) {
      // 藏在代码字符串里的路径：python -c "open('src/a.ts','w')"。被拒的是读时，纯读命令提到也算。
      const pathLike = denied.label.length >= 3 && /[\\/.]/.test(denied.label);
      if (pathLike && command.includes(denied.label) && (denied.access === "read" || view?.effect !== "read")) return denied.label;
    }
    for (const subject of this.others) {
      if (command.trim() === subject || (subject.length >= 8 && /^[a-z][a-z0-9+.-]*:\/\//i.test(subject) && command.includes(subject))) {
        return subject;
      }
    }
    return undefined;
  }

  // 用户对「刚拒绝过同一目标」的卡又点了允许：这次调用碰到的目标不再算被拒
  release(toolName: string, args: Record<string, unknown>, view: PermissionView | null, root?: string): void {
    for (;;) {
      const label = this.touched(toolName, args, view, root);
      if (!label) return;
      const key = resourceKey(label, root);
      if (key && this.paths.delete(key)) continue;
      if (!this.others.delete(label)) return;
    }
  }
}

export interface DecideContext {
  // 工作区根：把各种写法的路径归一
  root?: string;
  // P6：本 run 被拒过的目标
  denied?: DeniedTargets;
  // P11（K20）：工具在规划阶段要求人确认（Workflow 启动）——auto 档也问，用户写的 allow 规则 / 本会话允许可放开
  confirm?: { reason: string; why: string };
}

// ── S12（N28、HT8）：控制面文件写保护 ─────────────────────────────────────────────
// 指令与控制面文件：写进去的东西会进之后每一次（或所有）会话的 system prompt、改掉运行配置与权限规则、改写会话记录。
// agent 要写它们，每次都问、只能「允许这一次」（任何 allow 规则、「本会话都允许」都不算数），没人在场就拒；记忆目录
// 直接拒写——记忆只走 Remember（它有敏感信息拒存和治理字段）。刻意只列这几样，不长成一张越来越长的硬拒名单
// （hermes #45947 的教训）。整个 ~/.dimensio 不算：快照对话的工作区就在 ~/.dimensio/quick 下。
export const CONTROL_PLANE_RULE = "内置·控制面文件";
const INSTRUCTION_FILES = new Set(["guide.md", "agents.md", "claude.md"]);

function controlPlaneHit(raw: string, root?: string): { kind: "memory" | "control"; label: string } | null {
  const key = resourceKey(raw, root);
  if (!key) return null;
  const at = (resolve: () => string) => {
    try {
      return resourceKey(resolve());
    } catch {
      return null; // 测试进程里解析到临时目录之外会抛：这一项就不比
    }
  };
  const inside = (dir: string | null) => Boolean(dir) && (key === dir || key.startsWith(`${dir}/`));
  if (inside(at(memoryRoot))) return { kind: "memory", label: raw };
  if (INSTRUCTION_FILES.has(key.slice(key.lastIndexOf("/") + 1).toLowerCase())) return { kind: "control", label: raw };
  if (key === at(configFile) || key === at(globalGuideFile) || inside(at(sessionsDir))) return { kind: "control", label: raw };
  return null;
}

function controlPlaneDecision(toolName: string, args: Record<string, unknown>, view: PermissionView | null, root?: string): Decision | null {
  const p = pathArg(toolName, args);
  const targets = [...(p?.access === "write" ? [p.path] : []), ...(view?.writes ?? [])];
  const hits = targets.map((t) => controlPlaneHit(t, root)).filter((h): h is NonNullable<typeof h> => h !== null);
  const memory = hits.find((h) => h.kind === "memory");
  if (memory) {
    return {
      effect: "deny",
      reason: `${memory.label} is in the memory directory, which is written only through the Remember tool (it screens sensitive content and records provenance) — use Remember instead of editing files there`,
      rule: CONTROL_PLANE_RULE,
    };
  }
  if (hits.length) {
    return {
      effect: "ask",
      reason: `${hits[0].label} is a control-plane file (instructions that reach future sessions, the runtime config or session records), so every write needs the user's approval`,
      rule: CONTROL_PLANE_RULE,
      noSession: true,
      why: `要改控制面文件（${hits[0].label}）：写进去的指令会带进之后的会话，或改掉运行配置 / 会话记录`,
    };
  }
  return null;
}

// ── P12（N25）：检查点兜不住的写目标与网址 ────────────────────────────────────────
// shell 启动文件：写进去的东西之后本机每开一个 shell 都会跑，又在工作区外、检查点兜不住。只认家目录下的这几个（项目里
// 的 `.profile` 是 Heroku 之类的部署文件，不算）、PowerShell 的 profile 和 /etc 下的全局启动文件。
// Bash 那一半（强推、发布、全局装卸包、下载即执行……）按命令判，在 tools/shell-policy.ts。
const HOME_STARTUP = new Set([".bashrc", ".bash_profile", ".bash_login", ".profile", ".zshrc", ".zprofile", ".zshenv", ".zlogin"]);
const HOME_VAR = /^(?:\$\{?HOME\}?|\$env:(?:USERPROFILE|HOME)|%USERPROFILE%)(?=[\\/]|$)/i;

function startupFile(raw: string, root?: string): string | null {
  const t = raw.trim().replace(HOME_VAR, "~");
  if (/^\$PROFILE(?:\.\w+)?$/i.test(t)) return raw;
  if (/^\/etc\/(?:profile(?:\.d\/.+)?|bash\.bashrc|environment|zsh\/.+)$/.test(t)) return raw;
  const key = resourceKey(t, root);
  if (!key) return null;
  if (/\/(?:windows)?powershell\/[^/]*profile\.ps1$/i.test(key)) return raw;
  const home = resourceKey(os.homedir());
  if (!home) return null;
  const cut = key.lastIndexOf("/");
  if (key.slice(0, cut) === home && HOME_STARTUP.has(key.slice(cut + 1).toLowerCase())) return raw;
  return key.toLowerCase() === `${home}/.config/fish/config.fish`.toLowerCase() ? raw : null;
}

function irreversibleTarget(toolName: string, args: Record<string, unknown>, view: PermissionView | null, root?: string): Reason | undefined {
  const p = pathArg(toolName, args);
  for (const target of [...(p?.access === "write" ? [p.path] : []), ...(view?.writes ?? [])]) {
    const hit = startupFile(target, root);
    if (hit) {
      return {
        en: `${hit} is a shell startup file: what goes in it runs in every new shell on this machine`,
        zh: `改 shell 启动文件（${hit}）：写进去的东西之后每开一个终端都会执行`,
      };
    }
  }
  if ((toolName === "WebFetch" || toolName === "Browser") && mentionsImds(callSubject(toolName, args))) return IMDS_REASON;
  return undefined;
}

export function decide(
  mode: PermissionMode,
  toolName: string,
  tools: Map<string, Tool>,
  args: Record<string, unknown> = {},
  rules: PermissionRules = EMPTY_RULES,
  ctx: DecideContext = {},
): Decision {
  const tool = tools.get(toolName);
  if (!tool) {
    // Unknown tools default to high-risk deny (§6.4), never allow.
    return { effect: "deny", reason: `unknown tool "${toolName}"`, source: "unknown-tool" };
  }
  const subject = callSubject(toolName, args);
  const view = tool.permissionView?.(args) ?? null;
  const writes = view?.writes ?? [];

  // An explicit deny rule outranks everything, including the read-only escape
  // hatch below — the user said "never this", in any mode.
  const denyRule = anyMatch(rules.deny, toolName, subject, view);
  if (denyRule) return { effect: "deny", reason: `blocked by rule ${denyRule}`, rule: denyRule, source: "deny-rule" };
  // P6：Edit/Write 的路径规则同样管 Bash 往那里写
  const denyPath = pathRuleHit(rules.deny, writes, ctx.root);
  if (denyPath) {
    return { effect: "deny", reason: `blocked by rule ${denyPath.rule} (this command writes ${denyPath.target})`, rule: denyPath.rule, source: "deny-path" };
  }

  if (mode !== "auto" && (view?.effect ?? tool.effect) !== "read") {
    // ExitPlanMode is how a plan-mode run ends; it must never be gated by the
    // very mode it exists to leave.
    // C9：会按入参降级的工具（Bash）顺带说明哪些还能跑，免得模型以为什么命令都不行
    const hint = tool.permissionView ? " (plain read-only commands such as git status, ls or grep are fine)" : "";
    return {
      effect: "deny",
      reason:
        mode === "plan"
          ? `plan mode: no writes or commands yet${hint} — finish researching, then call ExitPlanMode with your plan for the user to approve`
          : `read-only mode blocks writes and commands${hint}`,
      source: "mode",
    };
  }

  // S12：控制面文件排在任何 allow 之前（包括「本会话都允许」与拒绝台账的再问——那张卡会给「本会话都允许」）
  const controlPlane = controlPlaneDecision(toolName, args, view, ctx.root);
  if (controlPlane) return { ...controlPlane, source: "control-plane" };

  // P6：本 run 里被拒过的目标，换了工具也要再问（排在 allow 前面：拒绝比先前的授权更新、更具体）
  const repeat = ctx.denied?.touched(toolName, args, view, ctx.root);
  if (repeat) {
    return {
      effect: "ask",
      reason: `the user already declined ${repeat} earlier in this run`,
      rule: REPEAT_DENIAL_RULE,
      source: "repeat-denial",
      why: `这一轮你刚拒绝过「${repeat}」，它换了个办法又要碰它`,
    };
  }

  // allow BEFORE ask: an allow rule is an explicit grant by the user, including
  // the one "本会话都允许" writes — if ask outranked it, answering "allow for this
  // session" would pop the same card again on the very next identical call.
  const allowRule = allowCoverage(rules.allow, toolName, subject, view);
  if (allowRule) return { effect: "allow", reason: "", rule: allowRule, source: "allow-rule" };

  if (view?.ask) {
    return { effect: "ask", reason: `${view.ask}, so it needs the user's approval`, rule: RISK_REVIEW_RULE, source: "risk-review", ...(view.why ? { why: view.why } : {}) };
  }

  // P12（N25）：检查点兜不住的操作——auto 下也转问（排在 allow 之后：用户自己写的 allow 规则可以放开它；没人在场 /
  // 离开模式时由 loop 按「没被批准」处理）
  const target = view?.irreversible ? { en: view.irreversible, zh: view.why ?? "" } : irreversibleTarget(toolName, args, view, ctx.root);
  if (target) {
    return {
      effect: "ask",
      reason: `${target.en} — a checkpoint cannot undo that, so it needs the user's approval`,
      rule: IRREVERSIBLE_RULE,
      source: "irreversible",
      ...(target.zh ? { why: target.zh } : {}),
    };
  }

  // P11（K20）：工具在规划阶段要求人确认（Workflow 启动）
  if (ctx.confirm) {
    return { effect: "ask", reason: ctx.confirm.reason, rule: TOOL_CONFIRM_RULE, source: "tool-confirm", why: ctx.confirm.why };
  }

  const askRule = anyMatch(rules.ask, toolName, subject, view);
  if (askRule) return { effect: "ask", reason: `rule ${askRule} requires approval`, rule: askRule, source: "ask-rule", why: `你设的规则 ${askRule} 要求这类操作先问你` };
  const askPath = pathRuleHit(rules.ask, writes, ctx.root);
  if (askPath) {
    return {
      effect: "ask",
      reason: `rule ${askPath.rule} requires approval (this command writes ${askPath.target})`,
      rule: askPath.rule,
      source: "ask-path",
      why: `这条命令要写 ${askPath.target}，你设的规则 ${askPath.rule} 要求先问你`,
    };
  }
  // 拆不全的命令说不准写了哪里：有路径规则管着的时候，交给人看
  const pathRule = view?.partial ? firstPathRule(rules) : undefined;
  if (pathRule) {
    return {
      effect: "ask",
      reason: `the command could not be fully analyzed, so it may write to paths that rule ${pathRule} covers`,
      rule: pathRule,
      source: "partial-path",
      why: `这条命令没法完全解析，可能会写到规则 ${pathRule} 管着的路径`,
    };
  }

  return { effect: "allow", reason: "", source: "default" };
}

// ── P5：「本会话都允许」的两种记法与自测（A6、X24、X25）──────────────────────────
// 卡片上先给人看「会记下哪条规则」，再由人挑：一字不差的字面规则（永远有），或 Bash 按稳定前缀记
// （`npm run lint:*`；高危根命令、解释器入口、过宽前缀只给字面规则）。两种都先自测再给：必须放行这次批准的调用，
// 必须不放行多串一条命令、加 sudo、换掉 glob 字符、换掉前缀最后一段的变体——自测不过的选项不给。
export interface SessionRuleChoices {
  exact: string[];
  prefix?: string[];
}

export function sessionRuleChoices(toolName: string, args: Record<string, unknown>, tools: Map<string, Tool>): SessionRuleChoices {
  const subject = callSubject(toolName, args);
  const exact = [sessionAllowRule(toolName, subject)];
  const command = toolName === "Bash" && typeof args.command === "string" ? args.command : "";
  const probe = (text: string) => ({ ...args, command: text });
  const chained = command ? [probe(`${command} && rm -rf ./__dimensio_probe__`), probe(`sudo ${command}`)] : [];
  const globs = /[*?]/.test(command) ? [probe(command.replace(/[*?]/g, "__probe__"))] : [];
  if (!selfCheck(exact, toolName, args, tools, [...chained, ...globs])) {
    console.warn(`[permissions] a literal session rule failed its self-check: ${exact[0]}`);
  }
  const prefixes = command ? tools.get(toolName)?.permissionView?.(args)?.prefixes : undefined;
  if (!prefixes?.length) return { exact };
  const prefix = prefixes.map((p) => `${toolName}(${p})`);
  // 前缀最后一段换成别的词，必须不再放行（抓住比预想更宽的前缀）
  const siblings = prefixes.map((p) => probe(p.replace(/:\*$/, "").replace(/\S+$/, "__probe__")));
  return selfCheck(prefix, toolName, args, tools, [...chained, ...siblings]) ? { exact, prefix } : { exact };
}

function selfCheck(
  candidate: string[],
  toolName: string,
  args: Record<string, unknown>,
  tools: Map<string, Tool>,
  negatives: Record<string, unknown>[],
): boolean {
  const rules: PermissionRules = { allow: candidate, deny: [], ask: [toolName] };
  if (decide("auto", toolName, tools, args, rules).effect !== "allow") return false;
  return negatives.every((neg) => decide("auto", toolName, tools, neg, rules).effect !== "allow");
}

// X24：写进全局规则之前自查。写法不对、工具名不存在、模式为空的规则永远不会生效，却让人以为有一道闸。
// 只查这次新加的（keep 里已有的放过）——设置页不编辑 allow，旧规则挡住保存就再也改不动了。
export function ruleProblems(
  rules: Partial<Record<keyof PermissionRules, unknown>> | null | undefined,
  knownTools: ReadonlySet<string>,
  keep: PermissionRules = EMPTY_RULES,
): string[] {
  const out: string[] = [];
  for (const kind of ["allow", "deny", "ask"] as const) {
    const list = rules?.[kind];
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const rule = String(raw).trim();
      if (!rule || keep[kind].includes(rule)) continue;
      const problem = ruleProblem(rule, knownTools);
      if (problem) out.push(problem);
    }
  }
  return out;
}

export function ruleProblem(rule: string, knownTools: ReadonlySet<string>): string | null {
  const parsed = parseRule(rule);
  if (!parsed) return `「${rule}」不是「工具名」或「工具名(模式)」的写法`;
  if (!knownTools.has(parsed.tool.toLowerCase())) return `「${rule}」里的工具 ${parsed.tool} 不存在`;
  const p = parsed.pattern;
  if (p === undefined) return null;
  if (!p || p === "=" || /^\s*:\*$/.test(p)) return `「${rule}」的模式是空的——要管这个工具的每一次调用，直接写 ${parsed.tool}`;
  // 正例自测：规则必须命中它自己描述的最小例子（前缀本身；glob 把 * ? 换成字母）
  const sample = p.startsWith("=") ? p.slice(1) : p.replace(/:\*$/, "").replace(/[*?]/g, "x");
  if (!patternMatches(p, sample)) return `「${rule}」连「${sample}」都匹配不上`;
  return null;
}
