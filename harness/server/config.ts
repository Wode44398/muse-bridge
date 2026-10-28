import { readFileSync, statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic-write.ts";
import { configFile, defaultWorkspace } from "./paths.ts";
import { accessLock, assertInTenant, disabledProviders, tenantMode } from "./tenant.ts";
import type { ProviderId } from "./providers/types.ts";
import { PERMISSION_MODES } from "./agent/permissions.ts";
import type { PermissionMode, PermissionRules } from "./agent/permissions.ts";
import type { ThinkingLevel } from "./agent/turn.ts";
import type { SandboxAccess } from "./sandbox.ts";
import {
  allProviders,
  EFFORT_ORDER,
  clampEffort,
  defaultEffort,
  defaultModel as catalogDefaultModel,
  modelSpec,
  providerBaseUrl,
} from "./catalog.ts";
import {
  customProviderKey,
  getCustomProvider,
  isCustomProviderId,
  isSharedProvider,
  savedBuiltinProviderKey,
  setBuiltinProviderKey,
  setCustomProviderKey,
} from "./custom-providers.ts";

export interface RuntimeConfig {
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  permissionMode: PermissionMode;
  // 逐次调用规则（allow/deny/ask）。模式是粗粒度闸，这里是细粒度：
  // 例如 ask: ["Bash(git push:*)"] 让推送每次都问，deny: ["Bash(rm -rf:*)"] 直接禁。
  permissionRules: PermissionRules;
  thinking: ThinkingLevel;
  // The agent's working directory. Settable at runtime from the UI; sessions
  // snapshot it on first run, so changing it affects NEW sessions only.
  workspace: string;
  // "workspace" locks file tools inside the workspace (classic containment);
  // "full" allows absolute paths anywhere on the machine, Claude-Code-style
  // (secret guard + .git write-protection still apply everywhere).
  access: SandboxAccess;
  // Anthropic fast mode（更快输出、按更高单价计费）。全局粘性开关：切到不支持的型号不清除，
  // 只是适配器不发（catalog 的 fast 表门控），切回来照旧开着——与 bridge 本体 Claude 分页同一套行为。
  fast: boolean;
}

// Boot-time default; `workspace: ""` in a config patch resets back to this.
// Q8：数据位置统一在 paths.ts 解析；这里照旧导出。
export { defaultWorkspace };

// Env keys come from harness/.env. Keys set via the UI go to the encrypted store
// (custom-providers.ts, AES-GCM + DPAPI) so they survive harness restarts, and
// win over env. Values are never returned to the client — only a hasKey flag.
const envKeys: Partial<Record<ProviderId, string>> = {
  anthropic: process.env.ANTHROPIC_API_KEY || undefined,
  openai: process.env.OPENAI_API_KEY || undefined,
  // Qwen reuses the DashScope key already set for the vision-verify channel
  // (same account), unless a dedicated QWEN_API_KEY is provided.
  qwen: process.env.QWEN_API_KEY || process.env.VISION_API_KEY || undefined,
  // Zhipu GLM (open.bigmodel.cn) — the `id.secret` key is used directly as the
  // Bearer token by the v4 OpenAI-compatible endpoint (no JWT signing needed).
  zhipu: process.env.ZHIPU_API_KEY || undefined,
  // Kimi for Coding (api.kimi.com/coding/v1) — the sk-kimi-… subscription key.
  // NOT interchangeable with the old open-platform api.moonshot.cn/.ai keys.
  kimi: process.env.KIMI_API_KEY || process.env.MOONSHOT_API_KEY || undefined,
  mimo: process.env.MIMO_API_KEY || undefined,
  // Google Gemini via AI-Studio (generativelanguage) — a plain AIza… API key
  // sent as x-goog-api-key (no ADC/Vertex OAuth).
  gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || undefined,
  // 本机 llama.cpp 默认不鉴权（llama-server 不带 --api-key 时直接忽略
  // Authorization 头），但 session.ts 有「无 key 就 throw」的硬闸，所以这里给个
  // 占位值让本机这家永远算「已配」——它本来就不需要配。真给 llama-server 开了
  // --api-key 时用 LOCAL_API_KEY 覆盖，或在设置面板里填。
  local: process.env.LOCAL_API_KEY || "local",
};
const overrideKeys: Partial<Record<ProviderId, string>> = {};

// Per-provider default model + baseUrl. The catalog (server/catalog.ts) is the
// source of truth; env vars only override it. anthropic has no baseUrl (SDK
// default). Used both at boot and when the user switches provider without
// naming a model.
function providerDefaults(p: ProviderId): { model: string; baseUrl?: string } {
  if (isCustomProviderId(p)) {
    const c = getCustomProvider(p);
    // 管理员共享给成员的服务：地址不进成员的配置（/api/info、/api/config 会下发）；适配器照样现读注册表里的地址
    if (c) return { model: c.defaultModel, ...(isSharedProvider(p) ? {} : { baseUrl: c.baseUrl }) };
  }
  switch (p) {
    case "anthropic":
      return { model: process.env.ANTHROPIC_MODEL || catalogDefaultModel("anthropic") };
    case "qwen":
      return {
        model: process.env.QWEN_MODEL || process.env.VISION_MODEL || catalogDefaultModel("qwen"),
        baseUrl:
          process.env.QWEN_BASE_URL ||
          process.env.VISION_BASE_URL ||
          providerBaseUrl("qwen"),
      };
    case "zhipu":
      return {
        model: process.env.ZHIPU_MODEL || catalogDefaultModel("zhipu"),
        baseUrl: process.env.ZHIPU_BASE_URL || providerBaseUrl("zhipu"),
      };
    case "kimi":
      return {
        model: process.env.KIMI_MODEL || catalogDefaultModel("kimi"),
        baseUrl: process.env.KIMI_BASE_URL || providerBaseUrl("kimi"),
      };
    case "mimo":
      return {
        model: process.env.MIMO_MODEL || catalogDefaultModel("mimo"),
        // Token Plan tp- keys and pay-as-you-go sk- keys are not interchangeable.
        // Explicit configuration also supports the Singapore/Europe clusters.
        baseUrl: process.env.MIMO_BASE_URL ||
          (resolveKey("mimo")?.startsWith("tp-")
            ? "https://token-plan-cn.xiaomimimo.com/v1"
            : providerBaseUrl("mimo")),
      };
    case "gemini":
      return {
        model: process.env.GEMINI_MODEL || catalogDefaultModel("gemini"),
        baseUrl: process.env.GEMINI_BASE_URL || providerBaseUrl("gemini"),
      };
    case "local":
      return {
        model: process.env.LOCAL_MODEL || catalogDefaultModel("local"),
        baseUrl: process.env.LOCAL_BASE_URL || providerBaseUrl("local"),
      };
    case "openai":
    default:
      return {
        model: process.env.OPENAI_MODEL || catalogDefaultModel("openai"),
        baseUrl: process.env.OPENAI_BASE_URL || providerBaseUrl("openai"),
      };
  }
}

// 子 agent 跨厂商时用的地址：与主会话同一套规则（环境变量覆盖、MiMo 按 key 前缀切 Token Plan 地址），
// 不能直接拿目录里的 baseUrl——tp- key 打按量地址一律 401。
export function providerEndpoint(p: ProviderId): string | undefined {
  return providerDefaults(p).baseUrl;
}

function initialProvider(): ProviderId {
  if (envKeys.anthropic) return "anthropic";
  if (envKeys.openai) return "openai";
  if (envKeys.qwen) return "qwen";
  if (envKeys.zhipu) return "zhipu";
  if (envKeys.kimi) return "kimi";
  if (envKeys.mimo) return "mimo";
  if (envKeys.gemini) return "gemini";
  return "anthropic";
}

// ── 选择持久化 ───────────────────────────────────────────────────────────────
// 上次选的厂商/模型/思考档落盘（API key 不进这个明文文件，走加密存储），服务端
// 重启、手机删后台、换设备打开都还是上次的维度。文件缺失/损坏/字段过期一律
// 静默回默认，绝不因此起不来。文件位置见 paths.ts 的 configFile()。
const choiceFile = configFile;

// P1（#5）：权限模式与规则也落盘。以前只存厂商/模型/思考档，服务一重启（部署、自愈）就回到 auto +
// 空规则——用户配的「从不允许 git push」悄悄失效。
interface SavedConfig {
  provider?: ProviderId;
  model?: string;
  thinking?: ThinkingLevel;
  permissionMode?: PermissionMode;
  permissionRules?: PermissionRules;
  access?: SandboxAccess;
  fast?: boolean;
  // 每家上次用的型号 / 深度（切回这家时继承，维护者 10-11：「一切换 claude 就默认 sonnet4.6」）
  models?: ModelPrefs;
}

type ModelPrefs = Record<string, { model: string; thinking: ThinkingLevel }>;

// 新会话默认的访问范围：整机（维护者 09-26：「选择整机可访问设置应该变成默认」）；SANDBOX_ACCESS=workspace 才默认只给工作空间。
// 用户在档位菜单 / 设置页选过的会记进 runtime-config.json，重启后照旧（以前不落盘，harness 一重启就回到仅工作空间）。
export function defaultAccess(): SandboxAccess {
  // 访问范围锁（租户模式恒 workspace，见 tenant.ts）压过一切：环境默认、上次存的选择都不算。
  return accessLock() ?? (process.env.SANDBOX_ACCESS === "workspace" ? "workspace" : "full");
}

function cleanRules(v: unknown): PermissionRules {
  const r = (v ?? {}) as Partial<Record<keyof PermissionRules, unknown>>;
  const list = (x: unknown): string[] =>
    Array.isArray(x)
      ? [...new Set(x.map((s) => String(s).trim()).filter((s) => s.length > 0 && s.length <= 200))].slice(0, 100)
      : [];
  return { allow: list(r.allow), deny: list(r.deny), ask: list(r.ask) };
}

// 读盘结果三态：没有文件 / 读到对象 / 文件坏了（坏文件原样留着，写的时候先隔离再写，见 persistChoice）。
function readConfigFile(): { state: "missing" | "ok" | "corrupt"; raw?: Record<string, unknown> } {
  let text: string;
  try {
    text = readFileSync(choiceFile(), "utf8");
  } catch {
    return { state: "missing" };
  }
  try {
    const raw = JSON.parse(text);
    return raw && typeof raw === "object" && !Array.isArray(raw) ? { state: "ok", raw } : { state: "corrupt" };
  } catch {
    return { state: "corrupt" };
  }
}

function loadSavedChoice(): SavedConfig | null {
  const file = readConfigFile();
  if (file.state !== "ok") return null;
  const raw = file.raw as any;
  const out: SavedConfig = {};
  const provider = allProviders().find((p) => p.id === raw?.provider && !disabledProviders().has(p.id))?.id;
  if (provider) {
    // 模型必须仍在该厂商的目录里（目录会汰换退役型号）；退位则回厂商默认。
    const model = typeof raw.model === "string" && modelSpec(provider, raw.model)
      ? raw.model
      : providerDefaults(provider).model;
    out.provider = provider;
    out.model = model;
    out.thinking = EFFORT_ORDER.includes(raw?.thinking)
      ? clampEffort(provider, model, raw.thinking)
      : defaultEffort(provider, model);
  }
  if (PERMISSION_MODES.includes(raw?.permissionMode)) out.permissionMode = raw.permissionMode;
  if (raw?.permissionRules && typeof raw.permissionRules === "object") out.permissionRules = cleanRules(raw.permissionRules);
  if (raw?.access === "workspace" || raw?.access === "full") out.access = raw.access;
  if (typeof raw?.fast === "boolean") out.fast = raw.fast;
  out.models = cleanPrefs(raw?.models);
  if (out.provider && out.model) out.models[out.provider] = { model: out.model, thinking: out.thinking! };
  return out;
}

// 只留仍在目录里的厂商 + 型号（退役的型号丢掉，回厂商默认），深度按型号收档
function cleanPrefs(v: unknown): ModelPrefs {
  const out: ModelPrefs = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [p, pref] of Object.entries(v as Record<string, any>)) {
    if (!allProviders().some((s) => s.id === p) || typeof pref?.model !== "string" || !modelSpec(p as ProviderId, pref.model)) continue;
    const thinking = EFFORT_ORDER.includes(pref.thinking) ? pref.thinking : defaultEffort(p as ProviderId, pref.model);
    out[p] = { model: pref.model, thinking: clampEffort(p as ProviderId, pref.model, thinking) };
  }
  return out;
}

// 串行原子写：内容同步快照，写盘排队防交叠；失败不阻塞配置生效（下次切换再补）。
let persistQueue: Promise<void> = Promise.resolve();
// 排着的写盘都落地（测试用：先等写完再看盘上的文件）。
export function configWritesSettled(): Promise<void> {
  return persistQueue;
}

// 测试进程绝不许把【生产】的选择盖掉：以前 session.test.ts 里一句 setConfig({provider:"openai"}) 就把真的
// runtime-config.json 写成了 openai/deepseek-v4-pro（表现为「dimensio 记不住上次用的模型」）。这里原先自带
// 一道「测试进程没指定配置文件就不写」的兜底，Q8 起统一由 paths.ts 的解析点守卫负责：测试进程解析到临时目录
// 之外的配置文件直接抛错。
//
// K56：写回防丢失。写之前重读一遍盘上的文件，只改自己管的字段、其余原样保留（别的版本 / 手工加的字段
// 不被抹掉）；盘上的文件坏了，先原样改名留证（.corrupt-<时间>）再写新的，绝不直接盖掉。API key 与
// baseUrl 从不写进这里（key 在加密存储，baseUrl 来自环境变量 / 目录）。
function persistChoice(): void {
  const mine = {
    v: 1,
    provider: config.provider,
    model: config.model,
    thinking: config.thinking,
    permissionMode: config.permissionMode,
    permissionRules: config.permissionRules,
    access: config.access,
    fast: config.fast,
    models: modelPrefs,
  };
  const file = choiceFile();
  persistQueue = persistQueue
    .then(async () => {
      const disk = readConfigFile();
      if (disk.state === "corrupt") {
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        await fs.rename(file, `${file}.corrupt-${stamp}`).catch(() => {});
        console.warn(`[config] ${file} 读不出来，已改名留证为 .corrupt-${stamp}，重新写入当前选择`);
      }
      const merged = { ...(disk.state === "ok" ? disk.raw : {}), ...mine };
      await atomicWriteFile(file, JSON.stringify(merged, null, 2) + "\n"); // M6：唯一临时名 + fsync
    })
    .catch(() => {});
}

const saved = loadSavedChoice();
const initP = saved?.provider ?? initialProvider();
const initDefaults = providerDefaults(initP);
let config: RuntimeConfig = {
  provider: initP,
  model: saved?.model ?? initDefaults.model,
  baseUrl: initDefaults.baseUrl,
  permissionMode: saved?.permissionMode ?? "auto",
  permissionRules: saved?.permissionRules ?? { allow: [], deny: [], ask: [] },
  thinking: saved?.thinking ?? clampEffort(initP, initDefaults.model, "off"),
  workspace: defaultWorkspace(),
  access: accessLock() ?? saved?.access ?? defaultAccess(),
  fast: saved?.fast ?? false,
};
const modelPrefs: ModelPrefs = saved?.models ?? {};

// 切到某家而没点名型号时用的型号：这家上次用的（仍在目录里）优先，没有才是厂商默认
function preferredModel(p: ProviderId): { model: string; thinking: ThinkingLevel } | null {
  const pref = modelPrefs[p];
  return pref && modelSpec(p, pref.model) ? pref : null;
}

export function getConfig(): RuntimeConfig {
  // 成员实例：选着的是管理员共享的服务，管理员取消了共享（或删了）——退回默认厂商，别停在一个成员自己修不了的服务上
  //（setConfig 收尾会再调一次这里，那时已经换掉了，不会再进来）
  if (tenantMode() && isCustomProviderId(config.provider) && !getCustomProvider(config.provider)) forgetProvider(config.provider);
  return { ...config };
}

// 这家 provider 服务端配置的接口地址（环境变量覆盖优先）；联网搜索的原生后端据此找同一个接口域名。
export function defaultBaseUrl(provider: ProviderId): string | undefined {
  return providerDefaults(provider).baseUrl;
}

// ── 共享凭据不外带（租户模式；移植自 Muse Bridge）────────────────────────────────
// 多用户服务端上，租户实例共用管理员那份厂商 key（modules/dimensio 的 tenantEnv）。租户若能随意改 baseUrl，adapter 就会
// 把共享 key 发到他指定的任意地址。所以租户模式下：只有这家 provider 用的是租户自己的 key（这次填的 / 自己存下的 /
// 他自己建的自定义服务），才认他给的 baseUrl；否则地址一律是服务端配置的默认地址。配置接口（resolveConfig）当场拒，
// 建 adapter 时（session.ts，子 agent 跟着会话走）再按 effectiveBaseUrl 兜一遍——落盘的会话配置、之前写进全局配置的地址都绕不过去。
function usesOwnKey(provider: ProviderId): boolean {
  if (isCustomProviderId(provider)) return !isSharedProvider(provider) && Boolean(customProviderKey(provider));
  return Boolean(overrideKeys[provider] || savedBuiltinProviderKey(provider));
}

export function effectiveBaseUrl(provider: ProviderId, requested: string | undefined): string | undefined {
  if (!tenantMode() || usesOwnKey(provider)) return requested;
  return defaultBaseUrl(provider);
}

const trimUrl = (u: unknown): string => String(u ?? "").trim().replace(/\/+$/, "");

export function hasKey(provider: ProviderId): boolean {
  return Boolean(resolveKey(provider));
}

export interface ConfigPatch extends Partial<RuntimeConfig> {
  apiKey?: string;
}

const cleanRuleList = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.map((x) => String(x).trim()).filter((x) => x.length > 0 && x.length <= 200))].slice(0, 100)
    : [];

// M11（N33）：给定底子 + 补丁算出一份配置，不动全局。设置页（setConfig）与新会话的配置快照（发起端显式带上界面
// 显示的那一份）共用这一套校验与联动。不合法就抛——调用方回 400。
// opts.ownKey：同一个补丁里带了这家 provider 的 key（setConfig 用；租户改 baseUrl 要靠它，见 effectiveBaseUrl）。
export function resolveConfig(base: RuntimeConfig, patch: Omit<ConfigPatch, "apiKey">, opts: { ownKey?: boolean } = {}): RuntimeConfig {
  const { workspace, access, permissionMode, permissionRules, ...rest } = patch;
  if (rest.provider !== undefined && !allProviders().some((p) => p.id === rest.provider)) {
    throw new Error(`unknown provider: ${String(rest.provider)}`);
  }
  if (rest.provider !== undefined && disabledProviders().has(String(rest.provider))) {
    throw new Error(`provider ${String(rest.provider)} is not available on this server`);
  }
  // Validate workspace/access BEFORE touching config — a bad patch must not
  // leave a half-applied state. Throws surface to the client as HTTP 400.
  const extra: Partial<RuntimeConfig> = {};
  if (rest.fast !== undefined && typeof rest.fast !== "boolean") throw new Error("fast must be true or false");
  if (workspace !== undefined) {
    const trimmed = String(workspace).trim();
    const abs = trimmed ? path.resolve(trimmed) : defaultWorkspace();
    let st;
    try {
      st = statSync(abs);
    } catch {
      throw new Error(`workspace directory does not exist: ${abs}`);
    }
    if (!st.isDirectory()) throw new Error(`workspace is not a directory: ${abs}`);
    // 租户模式：工作区只能是他自己文件夹里的目录（见 tenant.ts）。
    assertInTenant(abs, "工作区");
    extra.workspace = abs;
  }
  if (access !== undefined) {
    if (access !== "workspace" && access !== "full") {
      throw new Error(`invalid access mode: ${String(access)} (use "workspace" or "full")`);
    }
    const lock = accessLock();
    if (lock && access !== lock) throw new Error(`access is locked to "${lock}" on this server`);
    extra.access = access;
  }
  if (permissionMode !== undefined) {
    if (!PERMISSION_MODES.includes(permissionMode)) {
      throw new Error(`invalid permissionMode: ${String(permissionMode)} (use ${PERMISSION_MODES.join(" | ")})`);
    }
    extra.permissionMode = permissionMode;
  }
  if (permissionRules !== undefined) {
    const r = permissionRules as Partial<PermissionRules> | null;
    extra.permissionRules = {
      allow: cleanRuleList(r?.allow),
      deny: cleanRuleList(r?.deny),
      ask: cleanRuleList(r?.ask),
    };
  }
  const next: RuntimeConfig = { ...base, ...rest, ...extra };
  // When switching provider, snap to that provider's defaults for anything the
  // caller didn't explicitly set. baseUrl MUST reset even when a model is named,
  // otherwise we'd POST the new provider's model to the old provider's endpoint.
  if (rest.provider) {
    const d = providerDefaults(next.provider);
    if (patch.baseUrl === undefined) next.baseUrl = d.baseUrl;
    if (patch.model === undefined) {
      // 这家上次用的型号 / 深度优先（维护者 10-11：常用 Opus 5.5 就该默认 Opus 5.5），没用过才是厂商默认
      const pref = preferredModel(next.provider);
      next.model = pref?.model ?? d.model;
      if (patch.thinking === undefined) {
        next.thinking = pref?.thinking ?? defaultEffort(next.provider, next.model);
      }
    }
  }
  // 租户模式：没有自己的 key 就不许改地址（否则服务端的共享 key 会被发到任意地址，见 effectiveBaseUrl）。
  // 给的就是默认地址（或空串）不算改，照默认地址。
  if (rest.baseUrl !== undefined && tenantMode() && !(opts.ownKey || usesOwnKey(next.provider))) {
    const fallback = defaultBaseUrl(next.provider);
    const want = trimUrl(rest.baseUrl);
    if (want && want !== trimUrl(fallback)) {
      throw new Error(`baseUrl can only be changed together with your own API key for provider ${next.provider}`);
    }
    next.baseUrl = fallback;
  }
  // Every model exposes a different effort ladder — clamp whatever level we end
  // up with to what the current model actually supports, so the UI can never
  // push an unsupported tier (e.g. "max" to Qwen, or "off" to an adaptive model).
  next.thinking = clampEffort(next.provider, next.model, next.thinking);
  return next;
}

// M11（N33）：新会话的配置快照——发起端带来界面上显示的这几项，其余（规则、baseUrl……）照全局。形状不对就抛（400）。
const SNAPSHOT_KEYS = ["provider", "model", "thinking", "workspace", "access", "permissionMode"] as const;
export function sessionConfigSnapshot(raw: unknown): RuntimeConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config must be an object");
  const patch: Record<string, unknown> = {};
  for (const key of SNAPSHOT_KEYS) {
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim() || value.length > 1000) throw new Error(`config.${key} must be a non-empty string`);
    patch[key] = value;
  }
  return resolveConfig(getConfig(), patch as Omit<ConfigPatch, "apiKey">);
}

export function setConfig(patch: ConfigPatch): RuntimeConfig {
  const { apiKey, ...rest } = patch;
  if (typeof apiKey === "string" && apiKey.trim() && isSharedProvider(rest.provider ?? config.provider)) {
    throw new Error("这是管理员共享的服务，只有管理员能修改");
  }
  config = resolveConfig(config, rest, { ownKey: typeof apiKey === "string" && Boolean(apiKey.trim()) });
  if (typeof apiKey === "string" && apiKey.trim()) {
    // 一律落加密存储（重启还在）。内置几家以前只在内存，harness 一重启就丢
    if (isCustomProviderId(config.provider)) setCustomProviderKey(config.provider, apiKey.trim());
    else {
      overrideKeys[config.provider] = apiKey.trim();
      setBuiltinProviderKey(config.provider, apiKey.trim());
    }
  }
  if (config.provider === "mimo" && typeof apiKey === "string" && apiKey.trim() && patch.baseUrl === undefined) {
    config.baseUrl = providerDefaults("mimo").baseUrl;
  }
  modelPrefs[config.provider] = { model: config.model, thinking: config.thinking };
  persistChoice();
  return getConfig();
}

export function resolveKey(provider: ProviderId): string | undefined {
  if (isCustomProviderId(provider)) return customProviderKey(provider);
  return overrideKeys[provider] || savedBuiltinProviderKey(provider) || envKeys[provider];
}

// 自定义服务被删了而全局正选着它：退回启动时的默认厂商（上次的选择文件也跟着改写）。
export function forgetProvider(provider: ProviderId): void {
  if (config.provider !== provider) return;
  setConfig({ provider: initialProvider() });
}
