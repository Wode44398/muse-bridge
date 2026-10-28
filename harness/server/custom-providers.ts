// 自定义模型服务：用户在「模型服务」面板里自己加的第三方接口（地址 + 备注 + API key + 型号能力）。
//
//   custom-providers/providers.json            服务与型号（不含 key）
//   custom-providers/connector-secrets.*       API key（自定义服务 + 设置页给内置厂商填的），沿用 bridge 的加密存储（AES-256-GCM + DPAPI 包住的数据密钥，
//                                              src/extension-secrets.mjs，经 core-link 取）；密钥守卫按文件名挡住（sandbox.ts readVerdict）
//
// 2026-10-21 v2（维护者：和 Claude 外接一样「智能识别」）：
//   · 协议：openai（Chat Completions）/ anthropic（Messages）/ gemini（generateContent），按协议分派到现成的三个适配器；
//     鉴权方式 bearer / x-api-key / goog / none，可加自定义请求头。
//   · 型号不再只是名字：每个型号带能力（上下文、输出上限、视觉 / 视频 / 音频、对话 / 非对话、思考方式与档位表、来源），形状和
//     bridge 的 Claude 外接一致（src/runtime/claude-providers.mjs），识别规则共用 src/model-knowledge/（接口元数据 → 内置型号表 → 按名字猜）。
//     档位表到 dimensio 七级思考档的映射见 custom-tiers.ts。
//   · 非对话模型（asr / tts / embedding …）默认不启用、不进模型菜单、不当默认型号。
//   · 识别接口：拉型号（附能力猜测，最多 1000 个候选，不再静默截到 200）、检测连接（同站兄弟地址 × 协议真打一次）、探测能力、测试。
//   · v1 老配置（models 是字符串数组）读进来在内存里按知识层补全、不回写；保存时写成 v2。
//
// 元数据同步读（config.ts 在模块初始化时就要认出上次选的自定义服务），key 在启动时异步解开后常驻内存——DPAPI 要起一次
// PowerShell，不能放在每轮 resolveKey 的同步路径上。
//
// 2026-10-28 多用户（维护者：成员能用管理员公开的服务，也能自己加）：
//   · 管理员在编辑器里把某个服务标「共享给成员」（shared，存在管理员的 providers.json 里）。bridge 拉起成员实例时给
//     DIMENSIO_SHARED_PROVIDERS_DIR = 管理员那份目录：成员实例只读它，只认标了 shared 的，和成员自己的并在一起列出。
//     成员用得上、看不见：目录里不下发地址和请求头，编辑器接口拒，Key 只在服务端现取（只取共享的那几条），地址照管理员的走。
//     管理员取消共享 / 删掉，成员那边下一次读就没了。
//   · 成员自己也能加服务（以前租户一律 403），存在他自己的数据目录里；但只能连公网地址（endpoint-guard.ts）。
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { coreUrl } from "./core-link.ts";
import { assertPublicEndpoint } from "./endpoint-guard.ts";
import { MK, type Source, type Tier, type TierValue } from "./model-knowledge.ts";
import { customProvidersDir, sharedProvidersDir } from "./paths.ts";
import { tenantMode } from "./tenant.ts";
import { slotView, tierForLevel } from "./custom-tiers.ts";
import type { ThinkingLevel } from "./agent/turn.ts";

export type CustomProtocol = "openai" | "anthropic" | "gemini";
export type AuthStyle = "bearer" | "x-api-key" | "goog" | "none";
export type ThinkingKind = "none" | "budget" | "adaptive" | "effort";

export interface CustomModel {
  id: string;
  label: string;
  enabled: boolean; // 关掉 = 不进模型菜单（数据留着）
  kind: "chat" | "other"; // other = 语音识别 / 合成、向量这类：不进菜单、不当默认
  contextWindow: number;
  maxOutput: number;
  vision: boolean;
  video: boolean;
  audio: boolean;
  thinking: ThinkingKind;
  efforts: Tier[];
  effortField: string;
  effortDefault: string;
  alwaysThinks: boolean; // 不发参数也会思考：OpenAI 协议回传 reasoning_content
  source: Partial<Record<"contextWindow" | "maxOutput" | "vision" | "thinking", Source>>;
}

export interface CustomProvider {
  id: `custom-${string}`;
  name: string; // 备注（卡片标题）
  baseUrl: string; // 规范化过：无尾斜杠、不带 /chat/completions、/messages、/models
  protocol: CustomProtocol;
  authStyle: AuthStyle;
  headers: { name: string; value: string }[];
  maxTokensField: "max_tokens" | "max_completion_tokens"; // 只对 OpenAI 协议有意义（OpenAI 自家推理模型要后者）
  promptCaching: boolean; // 只对 Anthropic 协议有意义：发 cache_control（官方端点默认开，第三方默认关）
  replayReasoning: boolean; // 只对 OpenAI 协议有意义：工具续轮把思考原文回传为 reasoning_content（标了「自带思考」的型号总会回传）
  models: CustomModel[];
  defaultModel: string;
  createdAt: number;
  updatedAt?: number;
  shared?: boolean; // 管理员实例：共享给成员（多用户服务端）。成员实例里只有管理员共享过来的那几条带它
}

const ID_RE = /^custom-[a-f0-9]{8}$/;
export const isCustomProviderId = (id: unknown): id is `custom-${string}` => typeof id === "string" && ID_RE.test(id);
// 内置几家（anthropic / openai / kimi …）在设置页填的 key 也存在这份加密存储里，按厂商 id 记
const BUILTIN_ID_RE = /^[a-z]{2,20}$/;

const META_FILE = "providers.json";
const MAX_PROVIDERS = 24;
export const MAX_MODELS = 300; // 一个服务最多存这么多型号（候选列表最多 1000）
const MAX_CANDIDATES = 1000;
export const PROTOCOLS: CustomProtocol[] = ["openai", "anthropic", "gemini"];
export const AUTH_STYLES: AuthStyle[] = ["bearer", "x-api-key", "goog", "none"];
const THINKING_KINDS: ThinkingKind[] = ["none", "budget", "adaptive", "effort"];
const SOURCES = new Set(["api", "table", "probe", "guess", "default", "user"]);
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const FIELD_RE = /^[A-Za-z_][\w-]{0,40}(?:\.[A-Za-z_][\w-]{0,40}){0,4}$/;
// 鉴权与逐跳头由适配器自己管，自定义头不许覆盖它们
const RESERVED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "x-api-key", "authorization", "x-goog-api-key", "anthropic-version", "content-type", "accept-encoding"]);

/** 什么都不知道时的上下文 / 输出兜底：照各协议适配器自己的默认值（openai.ts / anthropic.ts / gemini.ts 的 DEFAULTS）。 */
export function protocolDefaults(protocol: CustomProtocol): { contextWindow: number; maxOutput: number } {
  if (protocol === "anthropic") return { contextWindow: 200_000, maxOutput: 8_192 };
  if (protocol === "gemini") return { contextWindow: 1_000_000, maxOutput: 65_536 };
  return { contextWindow: 128_000, maxOutput: 16_384 };
}
export const defaultAuth = (protocol: CustomProtocol): AuthStyle => (protocol === "anthropic" ? "x-api-key" : protocol === "gemini" ? "goog" : "bearer");

// ── 规范化 ───────────────────────────────────────────────────────────────────
const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });
const str = (v: unknown, max: number) => (typeof v === "string" ? v.replace(/[\r\n\t]+/g, " ").trim().slice(0, max) : "");
const oneOf = <T extends string>(v: unknown, list: readonly T[], dflt: T): T => ((list as readonly unknown[]).includes(v) ? (v as T) : dflt);
const MODEL_ID_RE = /^[^\s\u0000-\u001f]{1,200}$/;

function intIn(v: unknown, lo: number, hi: number, what: string, strict: boolean): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (Number.isInteger(n) && n >= lo && n <= hi) return n;
  if (strict) throw bad(`${what}要是 ${lo}–${hi} 之间的整数`);
  return null;
}

function tierValue(v: unknown, where: string): TierValue {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v === "string") return v.slice(0, 200);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw bad(`${where}的发送值不是有效数字`);
    return v;
  }
  if (typeof v === "boolean") return v;
  if (typeof v === "object" && !Array.isArray(v)) {
    const s = JSON.stringify(v);
    if (s.length > 2000) throw bad(`${where}的发送值太长（上限 2000 字符）`);
    return JSON.parse(s) as Record<string, unknown>;
  }
  throw bad(`${where}的发送值要是文字、数字、true / false 或 JSON 对象`);
}

function normalizeTiers(list: unknown, strict: boolean): Tier[] {
  if (!Array.isArray(list)) return [];
  const out: Tier[] = [];
  const seen = new Set<string>();
  for (const t of list.slice(0, MK.MAX_TIERS)) {
    try {
      const id = String((t as Tier)?.id ?? "").trim().toLowerCase();
      if (!MK.TIER_ID_RE.test(id)) throw bad(`档位 ID「${id.slice(0, 30)}」不合法（小写字母数字与 _ -，最长 24）`);
      if (seen.has(id)) throw bad(`档位「${id}」重复了`);
      seen.add(id);
      out.push({ id, name: str((t as Tier).name, 24) || id, value: tierValue((t as Tier).value, `档位「${id}」`) });
    } catch (e) {
      if (strict) throw e;
    }
  }
  return out;
}

function normalizeField(v: unknown, strict: boolean): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (FIELD_RE.test(s) && !s.split(".").some((k) => k === "__proto__" || k === "constructor" || k === "prototype")) return s;
  if (strict) throw bad(`写入字段「${s.slice(0, 60)}」不合法（点分路径，如 reasoning_effort）`);
  return "";
}

function normalizeSource(s: unknown): CustomModel["source"] {
  const out: CustomModel["source"] = {};
  if (s && typeof s === "object") {
    for (const k of ["contextWindow", "maxOutput", "vision", "thinking"] as const) {
      const v = (s as Record<string, unknown>)[k];
      if (typeof v === "string" && SOURCES.has(v)) out[k] = v as Source;
    }
  }
  return out;
}

/** 按知识层猜一个型号（拉列表、手动添加、读 v1 老配置都用它）。api = 端点 /models 里这一项的原始对象。 */
export function guessCustomModel(id: string, protocol: CustomProtocol, api: unknown = null, label = ""): CustomModel {
  const g = MK.guessModel(id, { protocol, api, defaults: protocolDefaults(protocol) });
  return {
    id,
    label: label || id,
    enabled: g.kind === "chat",
    kind: g.kind,
    contextWindow: g.contextWindow,
    maxOutput: g.maxOutput,
    vision: g.vision,
    video: g.video,
    audio: g.audio,
    thinking: g.thinking,
    efforts: g.efforts,
    effortField: g.effortField,
    effortDefault: g.effortDefault,
    alwaysThinks: g.alwaysThinks,
    source: g.source,
  };
}

// 一个型号：v1 的字符串按知识层补全；v2 的对象逐字段校验（strict = 用户提交的，坏值抛 400；否则是读盘，坏字段丢掉、绝不因此丢服务）
function normalizeModel(raw: unknown, i: number, protocol: CustomProtocol, strict: boolean): CustomModel | null {
  if (typeof raw === "string") {
    const id = raw.trim();
    return MODEL_ID_RE.test(id) ? guessCustomModel(id, protocol) : null;
  }
  const m = raw as Partial<CustomModel> | null;
  const id = typeof m?.id === "string" ? m.id.trim() : "";
  if (!MODEL_ID_RE.test(id)) {
    if (strict) throw bad(`第 ${i + 1} 个模型的 ID 不合法（不能有空白，最长 200）`);
    return null;
  }
  // 没给的字段（只带 id 的、或老版前端少传的）按知识层补，来源跟着补出来的那一层走
  const g = guessCustomModel(id, protocol);
  const given = normalizeSource(m!.source);
  const source: CustomModel["source"] = {};
  const kind = oneOf(m!.kind, ["chat", "other"] as const, g.kind);
  const ctx = intIn(m!.contextWindow, 1024, 4_000_000, "上下文窗口", strict);
  const out = intIn(m!.maxOutput, 256, 1_000_000, "输出上限", strict);
  const vision = typeof m!.vision === "boolean" ? m!.vision : null;
  const from = <T,>(k: keyof CustomModel["source"], v: T | null, dflt: T): T => {
    if (v === null) {
      if (g.source[k]) source[k] = g.source[k];
      return dflt;
    }
    if (given[k]) source[k] = given[k];
    return v;
  };
  let thinking: ThinkingKind;
  let efforts: Tier[];
  let effortField: string;
  let effortDefault: string;
  let alwaysThinks: boolean;
  if (Array.isArray(m!.efforts) || typeof m!.thinking === "string") {
    thinking = oneOf(m!.thinking, THINKING_KINDS, "none");
    efforts = thinking === "none" ? [] : normalizeTiers(m!.efforts, strict);
    effortField = thinking === "effort" ? normalizeField(m!.effortField, strict) : "";
    effortDefault = typeof m!.effortDefault === "string" && efforts.some((t) => t.id === m!.effortDefault) ? m!.effortDefault : "";
    alwaysThinks = m!.alwaysThinks === true;
    if (given.thinking) source.thinking = given.thinking;
  } else {
    ({ thinking, efforts, effortField, effortDefault, alwaysThinks } = g);
    if (g.source.thinking) source.thinking = g.source.thinking;
  }
  // 有思考方式却没有档位（编辑器发来的、或坏档位全被丢掉了）：什么都不发 = 不思考
  if (thinking !== "none" && !efforts.length) {
    thinking = "none";
    effortField = "";
    effortDefault = "";
  }
  // dimensio 只有七级思考档：放不进槽的档位以前静默丢掉（菜单里选不到、也永远发不出去）——用户提交的照实拒
  if (strict && thinking !== "none") {
    const lost = slotView({ thinking, efforts, effortDefault, alwaysThinks }).dropped;
    if (lost.length) throw bad(`「${id}」的思考档位放不下：dimensio 只有 7 级思考档（关闭档以外最多 6 档），${lost.join("、")} 进不去。删掉几档，或把档位 ID 改成 off / minimal / low / medium / high / xhigh / max`);
  }
  return {
    id,
    label: str(m!.label, 80) || id,
    enabled: m!.enabled !== false,
    kind,
    contextWindow: from("contextWindow", ctx, g.contextWindow),
    maxOutput: from("maxOutput", out, g.maxOutput),
    vision: from("vision", vision, g.vision),
    video: typeof m!.video === "boolean" ? m!.video : g.video,
    audio: typeof m!.audio === "boolean" ? m!.audio : g.audio,
    thinking,
    efforts,
    effortField,
    effortDefault,
    alwaysThinks,
    source,
  };
}

function normalizeHeaders(list: unknown, strict: boolean): { name: string; value: string }[] {
  if (!Array.isArray(list)) return [];
  const out: { name: string; value: string }[] = [];
  for (const h of list.slice(0, 16)) {
    const name = String((h as { name?: unknown })?.name ?? "").trim();
    if (!name) continue;
    if (!HEADER_RE.test(name) || RESERVED_HEADERS.has(name.toLowerCase())) {
      if (strict) throw bad(RESERVED_HEADERS.has(name.toLowerCase()) ? `请求头「${name}」由 dimensio 自己管，不能自定义` : `请求头名「${name.slice(0, 40)}」不合法`);
      continue;
    }
    out.push({ name, value: String((h as { value?: unknown })?.value ?? "").replace(/[\r\n]+/g, " ").slice(0, 2000) });
  }
  return out;
}

const chatIds = (models: CustomModel[]) => models.filter((m) => m.enabled && m.kind === "chat").map((m) => m.id);
// 默认型号只认启用的对话模型（老配置里落在 asr 上的就地改正）；一个都没有时留第一个，绝不因此丢掉整个服务
function pickDefault(models: CustomModel[], want: unknown): string {
  const chat = chatIds(models);
  if (typeof want === "string" && chat.includes(want)) return want;
  return chat[0] ?? models[0]?.id ?? "";
}

function connFields(r: Record<string, unknown>, prev: Partial<CustomProvider> | null, strict: boolean, baseUrl = "") {
  const protocol = oneOf(r.protocol ?? prev?.protocol, PROTOCOLS, "openai");
  const caching = r.promptCaching ?? prev?.promptCaching;
  return {
    protocol,
    authStyle: oneOf(r.authStyle ?? prev?.authStyle, AUTH_STYLES, defaultAuth(protocol)),
    headers: normalizeHeaders(r.headers ?? prev?.headers, strict),
    maxTokensField: oneOf(r.maxTokensField ?? prev?.maxTokensField, ["max_tokens", "max_completion_tokens"] as const, "max_tokens"),
    // 提示缓存：没说就只给官方端点开（第三方多半不认 cache_control，有的直接 400）
    promptCaching: typeof caching === "boolean" ? caching : hostOf(baseUrl || String(r.baseUrl ?? prev?.baseUrl ?? "")) === "api.anthropic.com",
    replayReasoning: (r.replayReasoning ?? prev?.replayReasoning) === true,
  };
}

// 读盘：v1 / v2 都认，坏条目跳过，缺字段补默认
function clean(raw: unknown): CustomProvider | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || !isCustomProviderId(r.id) || typeof r.baseUrl !== "string" || !r.baseUrl) return null;
  const conn = connFields(r, null, false);
  const seen = new Set<string>();
  const models: CustomModel[] = [];
  // v2 的完整能力在 modelSpecs（models 只是给老版看的 ID 列表）；没有 modelSpecs = v1，或被老版重写过：按 models 的字符串补全
  const raws = Array.isArray(r.modelSpecs) && r.modelSpecs.length ? r.modelSpecs : Array.isArray(r.models) ? r.models : [];
  for (const [i, m] of raws.entries()) {
    let one: CustomModel | null = null;
    try {
      one = normalizeModel(m, i, conn.protocol, false);
    } catch {
      one = null;
    }
    if (one && !seen.has(one.id)) {
      seen.add(one.id);
      models.push(one);
    }
  }
  if (!models.length) return null;
  return {
    id: r.id,
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 40) : hostOf(r.baseUrl),
    baseUrl: r.baseUrl,
    ...conn,
    models: models.slice(0, MAX_MODELS),
    defaultModel: pickDefault(models, r.defaultModel),
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
    ...(typeof r.updatedAt === "number" ? { updatedAt: r.updatedAt } : {}),
    ...(r.shared === true ? { shared: true } : {}),
  };
}

// ── 元数据 ───────────────────────────────────────────────────────────────────
type MetaCache = { file: string; mtimeMs: number; size: number; list: CustomProvider[] } | null;
let metaCache: MetaCache = null;
let sharedMetaCache: MetaCache = null;

// 读一份 providers.json（按 mtime + 大小缓存）。文件缺失 / 损坏一律当空表——绝不因此起不来。
function readMeta(file: string, cache: MetaCache): { list: CustomProvider[]; cache: MetaCache } {
  let st;
  try {
    st = statSync(file);
  } catch {
    return { list: [], cache: null };
  }
  if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs && cache.size === st.size) return { list: cache.list, cache };
  let list: CustomProvider[] = [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    list = (Array.isArray(raw?.providers) ? raw.providers : []).map(clean).filter(Boolean) as CustomProvider[];
  } catch {
    list = [];
  }
  return { list, cache: { file, mtimeMs: st.mtimeMs, size: st.size, list } };
}

// 这个实例自己的服务（按添加顺序）——增删改、草稿、Key 只碰这一份。成员实例里自己的服务不会带 shared。
function ownProviders(): CustomProvider[] {
  const r = readMeta(path.join(customProvidersDir(), META_FILE), metaCache);
  metaCache = r.cache;
  return tenantMode() ? r.list.map(({ shared: _s, ...p }) => p) : r.list;
}

// 管理员共享给成员的服务（只在成员实例上有）：管理员那份 providers.json 里标了 shared 的。
function sharedProviders(): CustomProvider[] {
  const dir = tenantMode() ? sharedProvidersDir() : null;
  if (!dir) return [];
  const r = readMeta(path.join(dir, META_FILE), sharedMetaCache);
  sharedMetaCache = r.cache;
  return r.list.filter((p) => p.shared);
}

// 全部能用的自定义服务：管理员共享的在前，自己的按添加顺序在后（id 撞了算自己的）。
export function listCustomProviders(): CustomProvider[] {
  const own = ownProviders();
  const shared = sharedProviders();
  if (!shared.length) return own;
  const mine = new Set(own.map((p) => p.id));
  return [...shared.filter((p) => !mine.has(p.id)), ...own];
}

export function getCustomProvider(id: string): CustomProvider | undefined {
  return isCustomProviderId(id) ? listCustomProviders().find((p) => p.id === id) : undefined;
}

/** 成员实例上，这个服务是管理员共享过来的（只能用：不能看地址、改、删、换 Key）。 */
export function isSharedProvider(id: string): boolean {
  if (!isCustomProviderId(id) || ownProviders().some((p) => p.id === id)) return false;
  return sharedProviders().some((p) => p.id === id);
}

const ownProvider = (id: string) => ownProviders().find((p) => p.id === id);
const managedByAdmin = () => Object.assign(new Error("这是管理员共享的服务，只有管理员能修改"), { status: 403 });

/** 一个自定义型号的能力记录（适配器 / 目录用）。 */
export function getCustomModel(id: string, model: string): CustomModel | undefined {
  return getCustomProvider(id)?.models.find((m) => m.id === model);
}

// 写盘格式向前兼容：models 仍是型号 ID 的字符串数组（v1 的形状），完整能力放 modelSpecs（同序）。
// 回滚到老版 harness 时，老版的 clean() 只认字符串型号——要是 models 写成对象数组，整个服务都会被它当成「没有型号」丢掉，
// 老版再写一次文件（增删改任意一个服务）就永久没了。现在老版照样认得出服务和型号（只是没有能力 / 协议这些 v2 字段，
// 老版重写时会丢掉 modelSpecs 等新字段——回滚前先备份 custom-providers/providers.json）；新版优先读 modelSpecs。
function writeMeta(list: CustomProvider[]): void {
  const providers = list.map(({ models, ...p }) => ({ ...p, models: models.map((m) => m.id), modelSpecs: models }));
  atomicWriteFileSync(path.join(customProvidersDir(), META_FILE), JSON.stringify({ v: 2, providers }, null, 2) + "\n");
  metaCache = null;
}

// ── key（加密存储；内存里一份明文，只在服务端） ─────────────────────────────
type SecretsMod = {
  readSecrets: (root: string) => Record<string, { headers?: Record<string, string> }>;
  writeSecrets: (root: string, map: Record<string, { headers?: Record<string, string> }>) => void;
};
let secretsMod: SecretsMod | null = null;
let secretsOverride: SecretsMod | null = null;
const keys = new Map<string, string>();
let keysError = "";

async function loadSecretsMod(): Promise<SecretsMod> {
  if (secretsOverride) return secretsOverride;
  // 经 core-link：dimensio 离线包里没有 ../../src，靠 bridge 拉起时的 @bridge/core 钩子找到程序目录的核心（D2）
  if (!secretsMod) secretsMod = (await import(coreUrl("extension-secrets.mjs"))) as SecretsMod;
  return secretsMod;
}

// 测试用：换成内存里的假存储，不碰 DPAPI
export function setCustomSecretsForTests(mod: SecretsMod | null): void {
  secretsOverride = mod;
  keys.clear();
}

// 启动时解开一次。没加过任何自定义服务就什么都不做（不起 PowerShell）。
export const customKeysReady: Promise<void> = (async () => {
  try {
    const dir = customProvidersDir();
    if (existsSync(path.join(dir, "connector-secrets.json"))) {
      const all = (await loadSecretsMod()).readSecrets(dir);
      for (const [id, rec] of Object.entries(all)) {
        const k = rec?.headers?.apiKey;
        if ((isCustomProviderId(id) || BUILTIN_ID_RE.test(id)) && typeof k === "string" && k) keys.set(id, k);
      }
    }
  } catch (e) {
    keysError = String((e as Error)?.message ?? e).slice(0, 160);
    console.warn(`[custom-providers] API key 解不开：${keysError}`);
  }
  // 成员实例：先把加密模块载好、管理员那份的数据密钥解开一次（DPAPI 起 PowerShell 约半秒），之后 sharedKey 同步现取
  const shared = tenantMode() ? sharedProvidersDir() : null;
  if (shared) {
    try {
      const mod = await loadSecretsMod();
      if (existsSync(path.join(shared, "connector-secrets.json"))) mod.readSecrets(shared);
    } catch (e) {
      console.warn(`[custom-providers] 管理员共享的 API key 解不开：${String((e as Error)?.message ?? e).slice(0, 160)}`);
    }
  }
})();

// 管理员共享的服务的 Key：每次现从管理员那份加密存储里取（按文件 mtime 缓存，管理员换 Key 立刻生效），只取共享的这一条，
// 不在成员实例里另存一份。取不到（还没解开、管理员删了 Key）就当没有 Key。
function sharedKey(p: CustomProvider): string | undefined {
  if (p.authStyle === "none") return NO_AUTH_KEY;
  const dir = sharedProvidersDir();
  const mod = secretsOverride ?? secretsMod;
  if (!dir || !mod) return undefined;
  try {
    const k = mod.readSecrets(dir)[p.id]?.headers?.apiKey;
    return typeof k === "string" && k ? k : undefined;
  } catch (e) {
    console.warn(`[custom-providers] 管理员共享的 API key 解不开：${String((e as Error)?.message ?? e).slice(0, 160)}`);
    return undefined;
  }
}

/**
 * 鉴权方式「不需要」（本机 vLLM / Ollama 一类）的服务没有 key：给会话链路一个非空占位——resolveKey / hasKey / 起会话 /
 * 子 agent / 中途换型号都只认「有没有 key」，没有就拒（以前测试能通、真发消息却报「No API key」）。
 * 占位值不会外发：requestHeaders 在 authStyle=none 时不带任何鉴权头。
 */
export const NO_AUTH_KEY = "none";
export function customProviderKey(id: string): string | undefined {
  const own = ownProvider(id);
  if (!own) {
    const shared = sharedProviders().find((p) => p.id === id);
    return shared ? sharedKey(shared) : undefined;
  }
  const k = keys.get(id);
  if (k) return k;
  return own.authStyle === "none" ? NO_AUTH_KEY : undefined;
}

async function writeKeys(): Promise<void> {
  const mod = await loadSecretsMod();
  const map: Record<string, { headers: Record<string, string> }> = {};
  for (const [id, k] of keys) map[id] = { headers: { apiKey: k } };
  mod.writeSecrets(customProvidersDir(), map); // 失败就抛——绝不退回明文存
}

// ── 地址 ─────────────────────────────────────────────────────────────────────
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// 用户常贴这些形状：…/v1、…/v1/、…/v1/chat/completions、…/v1/messages、…/models——统一收成不带尾斜杠的根。
export function normalizeBaseUrl(raw: unknown): string {
  let s = String(raw ?? "").trim();
  if (!s) throw bad("请填写接口地址");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`; // 没写协议才补 https；写了别的协议下面拒
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw bad("接口地址格式不对");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw bad("接口地址只支持 http / https");
  if (u.username || u.password) throw bad("接口地址里别带账号密码，API key 单独填");
  u.hash = "";
  u.search = "";
  let out = u.toString().replace(/\/+$/, "");
  out = out.replace(/\/chat\/completions$/i, "").replace(/\/messages$/i, "").replace(/\/models$/i, "");
  if (out.length > 300) throw bad("接口地址太长");
  return out;
}

// ── 联网：拉型号 / 检测连接 / 探测 / 测试（成员实例上每个地址先过 endpoint-guard 的公网把关，见 send） ────────────
export interface Conn {
  id?: string;
  name: string;
  baseUrl: string;
  protocol: CustomProtocol;
  authStyle: AuthStyle;
  headers: { name: string; value: string }[];
  maxTokensField: "max_tokens" | "max_completion_tokens";
  promptCaching: boolean;
  replayReasoning: boolean;
}

/** 编辑器发来的草稿（还没保存）→ 连接参数 + key（草稿没带 key 就用已存的）。 */
export function draftConn(input: unknown): { conn: Conn; key: string; models: CustomModel[] } {
  const r = (input ?? {}) as Record<string, unknown>;
  // 只认自己的服务：管理员共享的那几条不许拿来当草稿底子（否则换个地址就能把管理员的 Key 发出去）
  if (typeof r.id === "string" && isSharedProvider(r.id)) throw managedByAdmin();
  const prev = typeof r.id === "string" ? ownProvider(r.id) ?? null : null;
  const baseUrl = normalizeBaseUrl(r.baseUrl ?? prev?.baseUrl);
  const fields = connFields(r, prev, false, baseUrl);
  const conn: Conn = { ...(prev ? { id: prev.id } : {}), name: str(r.name, 40) || prev?.name || hostOf(baseUrl), baseUrl, ...fields };
  const key = (typeof r.apiKey === "string" && r.apiKey.trim()) || (prev ? keys.get(prev.id) ?? "" : "");
  const models: CustomModel[] = [];
  for (const [i, m] of (Array.isArray(r.models) ? r.models : prev?.models ?? []).entries()) {
    const one = normalizeModel(m, i, fields.protocol, false);
    if (one) models.push(one);
  }
  return { conn, key, models };
}

function authHeaders(c: Conn, key: string): Record<string, string> {
  if (!key || c.authStyle === "none") return {};
  if (c.authStyle === "x-api-key") return { "x-api-key": key };
  if (c.authStyle === "goog") return { "x-goog-api-key": key };
  return { authorization: `Bearer ${key}` };
}
/** 一个自定义服务的请求头（自定义头 + 鉴权；不含 content-type）——适配器与这里的识别请求共用。 */
export function requestHeaders(c: Conn, key: string): Record<string, string> {
  const h: Record<string, string> = {};
  for (const x of c.headers) h[x.name.toLowerCase()] = x.value;
  return { ...h, ...authHeaders(c, key), ...(c.protocol === "anthropic" ? { "anthropic-version": "2023-06-01" } : {}) };
}

interface Fetched {
  status: number;
  text: string;
  url: string;
  ms: number;
  error?: string; // 网络层失败（没拿到响应）
}
// 成员实例上，这里发出去的都是成员自己的服务（草稿只认自己的，见 draftConn）：每个地址都先过公网把关
async function send(url: string, init: RequestInit, timeoutMs = 20_000): Promise<Fetched> {
  const t0 = Date.now();
  try {
    await assertPublicEndpoint(url);
  } catch (e) {
    return { status: 0, text: "", url, ms: 0, error: (e as Error).message };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal, redirect: "manual" });
    const text = await res.text().catch(() => "");
    return { status: res.status, text, url, ms: Date.now() - t0 };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    const error = ctl.signal.aborted ? `连接超时（${Math.round(timeoutMs / 1000)} 秒没有响应）` : `连不上：${err.cause?.code ?? err.message}`;
    return { status: 0, text: "", url, ms: Date.now() - t0, error };
  } finally {
    clearTimeout(timer);
  }
}

/** 上游没成功 → 给人看的一句话（带去哪改）。 */
export function humanError(c: Conn, r: Fetched, model = ""): string {
  if (r.error) return r.error;
  const v = MK.vendorText(r.text);
  const fix = `去「模型服务 › ${c.name}」`;
  if ((r.status === 404 && !(v.json && MK.mentionsModel(v.msg, model))) || r.status === 405) {
    const hint = MK.endpointHint(c.protocol, c.baseUrl);
    return `接口地址不对：POST ${r.url} 返回 ${r.status}，这里不是 ${MK.protocolName(c.protocol)} 接口。${hint}${fix}改地址，或点「检测连接」一键识别。`;
  }
  if (r.status === 404) return `找不到这个模型（404）：${v.msg}`;
  if (r.status === 401 || r.status === 403) return `这把 API Key 被拒绝了（${r.status}）${v.msg ? "：" + v.msg : ""}。${fix}检查 Key 和鉴权方式。`;
  if (MK.looksNoAudio(r.status, r.text)) return `「${model}」（或这个服务）不收音频：${v.msg}`;
  if (MK.looksNotChat(r.status, r.text)) return `「${model}」不是对话模型（语音识别 / 合成、向量这类）：${v.msg}`;
  if (!v.json) return `上游返回 ${r.status}（不是 JSON，POST ${r.url}）：${v.msg || "空"}`;
  return `HTTP ${r.status}：${v.msg}`;
}

/**
 * 拉端点的型号列表，每项附能力猜测（接口元数据 → 内置型号表 → 名字）。最多 1000 个候选，按接口给的顺序。
 * Anthropic 协议的端点下常常没有 /models（小米、DeepSeek 的 …/anthropic）：404 后去同站的 OpenAI 兼容地址拉，两种鉴权头都带。
 */
export async function fetchModels(c: Conn, key: string): Promise<{ models: CustomModel[]; total: number; url: string }> {
  const [primary, ...alts] = MK.modelsUrlCandidates(c.protocol, c.baseUrl);
  const tryAt = async (url: string, headers: Record<string, string>) => {
    const r = await send(url, { headers }, 15_000);
    if (r.error || r.status < 200 || r.status >= 300) return { ok: false as const, r };
    let j: unknown;
    try {
      j = JSON.parse(r.text);
    } catch {
      return { ok: false as const, r: { ...r, error: "接口没有返回 JSON——地址是不是少了 /v1？" } };
    }
    const list = MK.parseModelList(j);
    return list ? { ok: true as const, list, url } : { ok: false as const, r: { ...r, error: "模型列表格式认不出" } };
  };
  let got = await tryAt(primary, requestHeaders(c, key));
  // 只有 Anthropic 协议退到备选地址：OpenAI / Gemini 协议的 /models 在别处找到了，聊天照样打到这个地址上 404——不如照实说，让「检测连接」去建议地址
  if (!got.ok && c.protocol === "anthropic" && got.r.status !== 401 && got.r.status !== 403 && alts.length) {
    const both: Record<string, string> = key && c.authStyle !== "none" ? { "x-api-key": key, authorization: `Bearer ${key}` } : {};
    const extra = requestHeaders({ ...c, authStyle: "none" }, "");
    for (const u of alts) {
      const a = await tryAt(u, { ...extra, ...both });
      if (a.ok) {
        got = a;
        break;
      }
    }
  }
  if (!got.ok) {
    const r = got.r;
    if (r.status === 401 || r.status === 403) throw Object.assign(bad(`API key 被拒绝（HTTP ${r.status}）`), { auth: true });
    if (r.error) throw bad(r.error);
    throw bad(`模型列表取不到（HTTP ${r.status}）`);
  }
  const seen = new Set<string>();
  const out: CustomModel[] = [];
  for (const x of got.list) {
    const id = MK.modelIdOf(x);
    if (!id || seen.has(id) || !MODEL_ID_RE.test(id)) continue;
    seen.add(id);
    out.push(guessCustomModel(id, c.protocol, x, MK.labelOf(x, id)));
  }
  if (!out.length) throw bad("接口没列出任何模型");
  return { models: out.slice(0, MAX_CANDIDATES), total: out.length, url: got.url };
}

/** 手动添加的型号（没有接口元数据）：只按内置型号表与名字猜。 */
export function guessModels(ids: unknown, protocol: unknown): CustomModel[] {
  const p = oneOf(protocol, PROTOCOLS, "openai");
  return (Array.isArray(ids) ? ids : [])
    .slice(0, 50)
    .map((id) => String(id ?? "").trim())
    .filter((id) => MODEL_ID_RE.test(id))
    .map((id) => guessCustomModel(id, p));
}

type Part = { text: string } | { image: string };
// 按协议拼一次最小请求（不流式）。tierId：这一档写进请求（'' = 不发思考参数）；patch：并进请求体（探测乱填档位用）。
async function callOnce(
  c: Conn,
  model: Pick<CustomModel, "id" | "thinking" | "efforts" | "effortField" | "maxOutput">,
  key: string,
  { parts, maxTokens, tierId = "", patch, timeoutMs = 30_000 }: { parts: Part[]; maxTokens: number; tierId?: string; patch?: Record<string, unknown>; timeoutMs?: number },
): Promise<Fetched & { ok: boolean; reply: string; thinking: boolean; usage?: { input: number; output: number } }> {
  const headers = { "content-type": "application/json", ...requestHeaders(c, key) };
  let url: string;
  let body: Record<string, unknown>;
  if (c.protocol === "gemini") {
    url = MK.geminiUrl(c.baseUrl, model.id, false);
    body = {
      contents: [{ role: "user", parts: parts.map((p) => ("text" in p ? { text: p.text } : { inlineData: { mimeType: "image/png", data: p.image } })) }],
      generationConfig: { maxOutputTokens: maxTokens },
    };
  } else if (c.protocol === "anthropic") {
    url = MK.anthropicUrl(c.baseUrl, "/v1/messages");
    const content = parts.map((p) => ("text" in p ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: "image/png", data: p.image } }));
    body = { model: model.id, max_tokens: maxTokens, messages: [{ role: "user", content }] };
  } else {
    url = MK.openaiUrl(c.baseUrl, "/chat/completions");
    const onlyText = parts.every((p) => "text" in p);
    const content = onlyText ? parts.map((p) => (p as { text: string }).text).join("") : parts.map((p) => ("text" in p ? { type: "text", text: p.text } : { type: "image_url", image_url: { url: `data:image/png;base64,${p.image}` } }));
    body = { model: model.id, messages: [{ role: "user", content }], stream: false, [c.maxTokensField]: maxTokens };
  }
  if (tierId) body = MK.applyTier(body, model, tierId, { protocol: c.protocol, cap: Math.max(model.maxOutput || 0, maxTokens) });
  if (patch) Object.assign(body, patch);
  const r = await send(url, { method: "POST", headers, body: JSON.stringify(body) }, timeoutMs);
  let json: any = null;
  try {
    json = JSON.parse(r.text);
  } catch {
    /* 非 JSON */
  }
  const ok = !r.error && r.status >= 200 && r.status < 300 && !!json;
  let reply = "";
  let thinking = false;
  let usage: { input: number; output: number } | undefined;
  if (ok) {
    if (c.protocol === "gemini") {
      const ps: any[] = json?.candidates?.[0]?.content?.parts ?? [];
      reply = ps.filter((p) => !p.thought && typeof p.text === "string").map((p) => p.text).join("");
      thinking = ps.some((p) => p.thought) || Number(json?.usageMetadata?.thoughtsTokenCount) > 0;
      if (json?.usageMetadata) usage = { input: json.usageMetadata.promptTokenCount ?? 0, output: (json.usageMetadata.candidatesTokenCount ?? 0) + (json.usageMetadata.thoughtsTokenCount ?? 0) };
    } else if (c.protocol === "anthropic") {
      const blocks: any[] = Array.isArray(json?.content) ? json.content : [];
      reply = blocks.filter((b) => b?.type === "text").map((b) => b.text).join("");
      thinking = blocks.some((b) => b?.type === "thinking" || b?.type === "redacted_thinking");
      if (json?.usage) usage = { input: json.usage.input_tokens ?? 0, output: json.usage.output_tokens ?? 0 };
    } else {
      const msg = json?.choices?.[0]?.message ?? {};
      reply = typeof msg.content === "string" ? msg.content : Array.isArray(msg.content) ? msg.content.map((p: any) => p?.text ?? "").join("") : "";
      thinking = Boolean(msg.reasoning_content || msg.reasoning || (Array.isArray(msg.reasoning_details) && msg.reasoning_details.length)) || Number(json?.usage?.completion_tokens_details?.reasoning_tokens) > 0;
      if (json?.usage) usage = { input: json.usage.prompt_tokens ?? 0, output: json.usage.completion_tokens ?? 0 };
    }
  }
  return { ...r, ok, reply: reply.trim(), thinking, ...(usage ? { usage } : {}) };
}

// ── 检测连接：当前地址与同站兄弟地址 × 协议，各发一条 max_tokens=1 的最小请求，看哪个组合真通 ─────────────
export interface DetectRow {
  protocol: CustomProtocol;
  baseUrl: string;
  authStyle: AuthStyle;
  url: string;
  status: number;
  result: "ok" | "model" | "auth" | "missing" | "error" | "network";
  message: string;
  ms: number;
}
export async function detectConnection(c: Conn, key: string, models: CustomModel[] = []) {
  let modelId = models.find((m) => m.enabled && m.kind === "chat")?.id ?? "";
  if (!modelId) {
    try {
      const { models: list } = await fetchModels(c, key);
      modelId = (list.find((m) => m.kind === "chat") ?? list[0])?.id ?? "";
    } catch {
      /* 拉不到就用占位名：接口在不在照样分得出来 */
    }
  }
  const probe = modelId || "test";
  let host = "";
  try {
    host = new URL(c.baseUrl).hostname;
  } catch {
    /* 已规范化过 */
  }
  const protocols: CustomProtocol[] = /generativelanguage\.googleapis\.com$/.test(host) || /\/v1beta(\/|$)/.test(c.baseUrl) || c.protocol === "gemini" ? ["openai", "anthropic", "gemini"] : ["openai", "anthropic"];
  const tries: { protocol: CustomProtocol; baseUrl: string }[] = [];
  for (const b of MK.siblingBaseUrls(c.baseUrl).slice(0, 5)) for (const protocol of protocols) tries.push({ protocol, baseUrl: b });
  if (!tries.some((t) => t.protocol === c.protocol && t.baseUrl === c.baseUrl)) tries.unshift({ protocol: c.protocol, baseUrl: c.baseUrl });
  const results: DetectRow[] = await Promise.all(
    tries.map(async (t) => {
      const authStyle: AuthStyle = c.authStyle === "none" ? "none" : t.protocol === c.protocol ? c.authStyle : defaultAuth(t.protocol);
      const cc: Conn = { ...c, ...t, authStyle };
      const r = await callOnce(cc, { id: probe, thinking: "none", efforts: [], effortField: "", maxOutput: 1 }, key, { parts: [{ text: "hi" }], maxTokens: 1, timeoutMs: 15_000 });
      const result = r.error ? "network" : MK.classifyProbe(r.status, r.text);
      return { ...t, authStyle, url: r.url, status: r.status, result, message: (r.error ?? MK.vendorText(r.text).msg).slice(0, 200), ms: r.ms } as DetectRow;
    }),
  );
  return { model: modelId, results, ...MK.pickDetect(results, c) };
}

// ── 探测一个型号的能力（真打几次，花费很小：都是一两句话的请求） ─────────────────
export async function probeCustomModel(c: Conn, raw: unknown, key: string) {
  const m = normalizeModel(raw, 0, c.protocol, false);
  if (!m) throw bad("模型 ID 不合法");
  const plain = { ...m, thinking: "none" as const, efforts: [] };
  const out: Record<string, any> = { model: m.id, notes: [] as string[] };
  const say = (s: string) => out.notes.push(s);
  const ask = [{ text: "1+1 等于几？只回答数字。" }];
  const [text, limit, vision] = await Promise.all([
    callOnce(c, plain, key, { parts: ask, maxTokens: 2048 }),
    callOnce(c, plain, key, { parts: [{ text: "hi" }], maxTokens: 10_000_000 }),
    callOnce(c, plain, key, { parts: [{ image: MK.RED_PNG }, { text: "这张图是什么颜色？只回答颜色。" }], maxTokens: 2048 }),
  ]);
  // 对话：普通问题就 400 的（语音识别 / 合成要专门的输入）判成非对话模型
  if (text.ok) {
    out.kind = "chat";
    out.thinksByDefault = text.thinking;
    say(text.thinking ? "不发思考参数也会思考" : "不发思考参数时不思考");
  } else if (MK.looksNotChat(text.status, text.text)) {
    out.kind = "other";
    say("普通对话被拒：" + MK.vendorText(text.text).msg.slice(0, 120));
  } else {
    out.error = humanError(c, text, m.id);
    return out;
  }
  // 输出上限：报错里读出范围（不扣费）；没报错说明上限 ≥ 请求值，读不出
  if (!limit.ok) {
    const n = MK.parseLimit(limit.text);
    if (n) {
      out.maxOutput = n;
      say(`输出上限 ${n}`);
    }
  } else say("输出上限没读出来（端点没校验）");
  if (vision.ok) {
    out.vision = /红|red/i.test(vision.reply);
    say(out.vision ? "能看图" : `看图答错了（${vision.reply.slice(0, 20)}）`);
  } else if (vision.status === 400) {
    out.vision = false;
    say("不收图片");
  }
  if (out.kind === "other") return out;
  // 档位：逐个试（会真改请求的那些），400 = 端点不认这一档的值
  const tiers = m.efforts.filter((t) => JSON.stringify(MK.applyTier({}, m, t.id, { protocol: c.protocol, cap: 4096 })) !== "{}").slice(0, MK.MAX_TIERS);
  out.tiers = await Promise.all(
    tiers.map(async (t) => {
      const r = await callOnce(c, m, key, { parts: ask, maxTokens: 2048, tierId: t.id });
      return { id: t.id, ok: r.ok, status: r.status, thinking: r.ok ? r.thinking : null, error: r.ok ? "" : (r.error ?? MK.vendorText(r.text).msg).slice(0, 160) };
    }),
  );
  // OpenAI 端点：乱填 reasoning_effort，从报错里读出它认的档位
  if (c.protocol === "openai") {
    const r = await callOnce(c, plain, key, { parts: [{ text: "hi" }], maxTokens: 16, patch: { reasoning_effort: "zzz-dimensio-probe" } });
    const ids = !r.ok ? MK.parseEffortList(r.text) : null;
    if (ids) {
      out.effortIds = ids;
      say("reasoning_effort 可选：" + ids.join(" / "));
    }
  }
  return out;
}

/** 这个型号首次选中时的档（同 catalog.defaultEffort 的规则）。 */
function defaultLevel(m: CustomModel): ThinkingLevel {
  const v = slotView(m);
  if (v.defaultEffort) return v.defaultEffort;
  if (v.efforts.includes("high")) return "high";
  if (v.efforts.includes("low")) return "low";
  return v.efforts[0] ?? "off";
}

/** 测试：用这份配置真发一句（思考按这个型号首次选中时的档，和真对话一样），回延迟、回复、是否思考、人话错误。 */
export async function testCustomProvider(c: Conn, models: CustomModel[], key: string, modelId?: unknown) {
  const model = models.find((m) => m.id === modelId) ?? models.find((m) => m.id === pickDefault(models, "")) ?? models[0];
  if (!model) throw bad("先添加至少一个模型");
  const tierId = tierForLevel(model, defaultLevel(model));
  const r = await callOnce(c, model, key, { parts: [{ text: "只回复两个字母：OK" }], maxTokens: model.alwaysThinks || tierId ? 1024 : 64, tierId, timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, status: r.status, ms: r.ms, model: model.id, error: humanError(c, r, model.id) };
  return { ok: true, status: r.status, ms: r.ms, model: model.id, reply: r.reply.slice(0, 200), thinking: r.thinking, ...(r.usage ? { usage: r.usage } : {}) };
}

// ── 增删改（路由层调用；失败抛 Error，消息是给人看的中文） ───────────────────
export interface CustomProviderInput {
  name?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown; // 老表单：探不到模型清单时手填的模型 ID
  protocol?: unknown;
  authStyle?: unknown;
  headers?: unknown;
  maxTokensField?: unknown;
  promptCaching?: unknown;
  replayReasoning?: unknown;
  models?: unknown; // 新编辑器：完整的型号清单（带能力）
  defaultModel?: unknown;
  shared?: unknown; // 管理员实例：共享给成员（成员实例上忽略）
}

// 「共享给成员」只有管理员实例认；成员实例上一律没有（他自己的服务不存在共享这回事）
function sharedField(input: CustomProviderInput, prev: CustomProvider | null): { shared?: true } {
  if (tenantMode()) return {};
  const want = typeof input.shared === "boolean" ? input.shared : prev?.shared === true;
  return want ? { shared: true } : {};
}

// 老表单（只有地址 + key，旧版 apk 也走这里）：拉型号、猜能力；手填的型号补进去。
async function resolveModels(c: Conn, key: string, manual: string, keep: CustomModel[] = []): Promise<{ models: CustomModel[]; warning?: string }> {
  let listed: CustomModel[] | null = null;
  let total = 0;
  let err: (Error & { auth?: boolean }) | null = null;
  try {
    ({ models: listed, total } = await fetchModels(c, key));
  } catch (e) {
    err = e as Error & { auth?: boolean };
  }
  if (listed) {
    const old = new Map(keep.map((m) => [m.id, m]));
    let models = listed.map((m) => old.get(m.id) ?? m); // 留着的型号保留用户改过的能力
    if (manual && !models.some((m) => m.id === manual)) models = [guessCustomModel(manual, c.protocol), ...models];
    let warning: string | undefined;
    if (models.length > MAX_MODELS) {
      // 对话模型优先留下；不再静默截断——告诉用户去编辑里挑
      models = [...models.filter((m) => m.kind === "chat"), ...models.filter((m) => m.kind !== "chat")].slice(0, MAX_MODELS);
      warning = `接口列出了 ${total} 个模型，只收了 ${MAX_MODELS} 个（对话模型优先）；在「编辑」里可以重新挑`;
    }
    return { models, warning };
  }
  if (manual && !err?.auth) return { models: [guessCustomModel(manual, c.protocol)], warning: err?.message };
  let msg = err?.message ?? "连不上这个接口";
  // 型号列表取不到（多半是地址少了 /v1、或贴成了别的协议的地址）：顺手检测一次连接，同协议换个地址能通就直说（老表单只能改地址）
  if (!err?.auth && /HTTP 40[45]|JSON/.test(msg)) {
    try {
      const d = await detectConnection(c, key);
      if (d.suggest && d.suggest.protocol === c.protocol) msg = `${msg}；检测到 ${d.suggest.baseUrl} 能通，改用这个地址再试`;
    } catch {
      /* 检测不了就照原话 */
    }
  }
  const e = new Error(msg) as Error & { needsModel?: boolean; status?: number };
  e.status = 400;
  // key 被拒就不提示手填模型——填了也用不了
  e.needsModel = !err?.auth;
  throw e;
}

// key 有没有真被接受：/models 公开的端点（OpenRouter 一类）不带 key 也能列，光靠它验不出 key 填错。
// 换了 key 或地址时，用默认型号真发一条 max_tokens=1：401 / 403 就不保存；别的结果（含网络错）不拦。
async function verifyKey(c: Conn, key: string, model: CustomModel | undefined): Promise<void> {
  if (!key || c.authStyle === "none" || !model) return;
  const r = await callOnce(c, { ...model, thinking: "none", efforts: [] }, key, { parts: [{ text: "hi" }], maxTokens: 1, timeoutMs: 15_000 });
  if (r.status === 401 || r.status === 403) throw bad(`API key 被拒绝（HTTP ${r.status}）`);
}

function strictModels(list: unknown, protocol: CustomProtocol): CustomModel[] {
  if (!Array.isArray(list)) return [];
  // 不再静默截断：多了就照实拒，让用户自己挑（编辑器那边勾多了也不让加）
  if (list.length > MAX_MODELS) throw bad(`型号最多 ${MAX_MODELS} 个（这次提交了 ${list.length} 个），先删掉一些再保存`);
  const out: CustomModel[] = [];
  const seen = new Set<string>();
  for (const [i, m] of list.entries()) {
    const one = normalizeModel(m, i, protocol, true);
    if (!one) continue;
    if (seen.has(one.id)) throw bad(`模型「${one.id}」重复了`);
    seen.add(one.id);
    out.push(one);
  }
  return out;
}

export async function addCustomProvider(input: CustomProviderInput): Promise<{ provider: CustomProvider; warning?: string }> {
  const list = ownProviders();
  if (list.length >= MAX_PROVIDERS) throw bad(`最多添加 ${MAX_PROVIDERS} 个自定义服务`);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  await assertPublicEndpoint(baseUrl); // 成员实例：不填型号清单、鉴权选「不需要」时一次请求都不发，这里先拦
  const fields = connFields(input as Record<string, unknown>, null, true, baseUrl);
  const apiKey = str(input.apiKey, 4000);
  if (!apiKey && fields.authStyle !== "none") throw bad("请填写 API key");
  const name = str(input.name, 40) || hostOf(baseUrl);
  const conn: Conn = { name, baseUrl, ...fields };
  let models: CustomModel[];
  let warning: string | undefined;
  if (Array.isArray(input.models)) {
    models = strictModels(input.models, fields.protocol);
    if (!chatIds(models).length) throw bad("至少启用一个对话模型");
  } else ({ models, warning } = await resolveModels(conn, apiKey, str(input.model, 200)));
  const defaultModel = str(input.model, 200) && chatIds(models).includes(str(input.model, 200)) ? str(input.model, 200) : pickDefault(models, input.defaultModel);
  await verifyKey(conn, apiKey, models.find((m) => m.id === defaultModel));
  let id: `custom-${string}`;
  const taken = new Set(listCustomProviders().map((p) => p.id)); // 连管理员共享过来的一起避开
  do id = `custom-${randomBytes(4).toString("hex")}`;
  while (taken.has(id));
  const provider: CustomProvider = { ...conn, id, models, defaultModel, createdAt: Date.now(), updatedAt: Date.now(), ...sharedField(input, null) };
  if (apiKey) {
    keys.set(id, apiKey);
    try {
      await writeKeys();
    } catch (e) {
      keys.delete(id);
      throw bad(`API key 没能加密保存：${(e as Error).message}`);
    }
  }
  writeMeta([...ownProviders(), provider]);
  return { provider, warning };
}

export async function updateCustomProvider(id: string, input: CustomProviderInput): Promise<{ provider: CustomProvider; warning?: string }> {
  if (isSharedProvider(id)) throw managedByAdmin();
  const cur = ownProvider(id);
  if (!cur) throw bad("这个自定义服务不存在（可能已被删除）");
  const baseUrl = input.baseUrl === undefined ? cur.baseUrl : normalizeBaseUrl(input.baseUrl);
  await assertPublicEndpoint(baseUrl);
  const fields = connFields(input as Record<string, unknown>, cur, true, baseUrl);
  const newKey = str(input.apiKey, 4000);
  const apiKey = newKey || keys.get(id) || "";
  if (!apiKey && fields.authStyle !== "none") throw bad("请填写 API key");
  const name = input.name === undefined ? cur.name : str(input.name, 40) || hostOf(baseUrl);
  const conn: Conn = { id, name, baseUrl, ...fields };
  const manual = str(input.model, 200);
  const connChanged = baseUrl !== cur.baseUrl || fields.protocol !== cur.protocol || fields.authStyle !== cur.authStyle;
  let models = cur.models;
  let warning: string | undefined;
  if (Array.isArray(input.models)) {
    models = strictModels(input.models, fields.protocol);
    if (!chatIds(models).length) throw bad("至少启用一个对话模型");
  } else if (connChanged) ({ models, warning } = await resolveModels(conn, apiKey, manual, cur.models));
  else if (manual && !models.some((m) => m.id === manual)) {
    // 老表单只补一个手填的型号：加在最前面，挑好的型号表原样留着
    if (models.length >= MAX_MODELS) throw bad(`型号最多 ${MAX_MODELS} 个，先在「编辑」里删掉一些`);
    models = [guessCustomModel(manual, fields.protocol), ...models];
  }
  // 只换 Key（旧版 apk 的编辑表单只传名字、地址、Key）：型号表不动——v2 编辑器里挑好的、手动加的型号不能被 /models 整表冲掉；
  // Key 对不对由下面的 verifyKey 真发一条来验
  const want = manual && chatIds(models).includes(manual) ? manual : input.defaultModel ?? cur.defaultModel;
  const { shared: _was, ...rest } = cur;
  const next: CustomProvider = { ...rest, ...conn, id: cur.id, models, defaultModel: pickDefault(models, want), updatedAt: Date.now(), ...sharedField(input, cur) };
  if (connChanged || (newKey && newKey !== keys.get(id))) await verifyKey(conn, apiKey, models.find((m) => m.id === next.defaultModel));
  if (newKey && newKey !== keys.get(id)) {
    const prev = keys.get(id);
    keys.set(id, newKey);
    try {
      await writeKeys();
    } catch (e) {
      if (prev) keys.set(id, prev);
      else keys.delete(id);
      throw bad(`API key 没能加密保存：${(e as Error).message}`);
    }
  }
  writeMeta(ownProviders().map((p) => (p.id === id ? next : p)));
  return { provider: next, warning };
}

export async function removeCustomProvider(id: string): Promise<void> {
  if (isSharedProvider(id)) throw managedByAdmin();
  if (!ownProvider(id)) throw bad("这个自定义服务不存在（可能已被删除）");
  writeMeta(ownProviders().filter((p) => p.id !== id));
  if (keys.delete(id)) await writeKeys().catch((e) => console.warn(`[custom-providers] 删除后重写 key 失败：${(e as Error).message}`));
}

/** 给编辑器的视图：完整记录 + 有没有 key（只给尾 4 位供辨认，完整 key 绝不回传）。 */
export function customProviderView(p: CustomProvider) {
  const key = keys.get(p.id) ?? "";
  return { ...p, hasKey: Boolean(key), keyTail: key ? key.slice(-4) : "" };
}

// 设置页「API Key」一栏对自定义服务也有效：换 key 落进加密存储（同步路径上只改内存，写盘排队）。
// 管理员共享的服务不收（成员换不了它的 Key，也不能给它存一把自己的）。
export function setCustomProviderKey(id: string, apiKey: string): void {
  if (!ownProvider(id)) return;
  keys.set(id, apiKey);
  void writeKeys().catch((e) => console.warn(`[custom-providers] key 写盘失败：${(e as Error).message}`));
}

// 内置厂商在设置页填的 key：以前只放内存，harness 一重启（部署、bridge 重启、看门狗重拉、崩溃）就没了，
// 表现为「页面上配的 key 莫名其妙丢了」。现在同样落加密存储，启动时随 customKeysReady 解回来。
export function setBuiltinProviderKey(id: string, apiKey: string): void {
  if (!BUILTIN_ID_RE.test(id)) return;
  keys.set(id, apiKey);
  void writeKeys().catch((e) => console.warn(`[custom-providers] ${id} 的 key 写盘失败：${(e as Error).message}`));
}

export function savedBuiltinProviderKey(id: string): string | undefined {
  return BUILTIN_ID_RE.test(id) ? keys.get(id) : undefined;
}

export function customKeysError(): string {
  return keysError;
}
