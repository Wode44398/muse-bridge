// 自定义模型服务：用户在「模型服务」面板里自己加的 OpenAI 兼容端点（地址 + 备注 + API key）。
//
//   custom-providers/providers.json            地址、备注、模型清单（不含 key）
//   custom-providers/connector-secrets.*       API key，沿用 bridge 的加密存储（AES-256-GCM + DPAPI 包住的数据密钥，
//                                              src/extension-secrets.mjs）；密钥守卫按文件名挡住（sandbox.ts readVerdict）
//
// 元数据同步读（config.ts 在模块初始化时就要认出上次选的自定义服务），key 在启动时异步解开后常驻内存——DPAPI 要起一次
// PowerShell，不能放在每轮 resolveKey 的同步路径上。协议一律按 Chat Completions 走 openai 适配器，不发任何厂商专属
// 的思考参数（目录里 efforts 只有 off）。
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { customProvidersDir } from "./paths.ts";

export interface CustomProvider {
  id: `custom-${string}`;
  name: string; // 备注（卡片标题）
  baseUrl: string; // 规范化过：无尾斜杠、不带 /chat/completions
  models: string[];
  defaultModel: string;
  createdAt: number;
}

const ID_RE = /^custom-[a-f0-9]{8}$/;
export const isCustomProviderId = (id: unknown): id is `custom-${string}` => typeof id === "string" && ID_RE.test(id);

const META_FILE = "providers.json";
const MAX_PROVIDERS = 24;
const MAX_MODELS = 200;

// ── 元数据 ───────────────────────────────────────────────────────────────────
let metaCache: { file: string; mtimeMs: number; size: number; list: CustomProvider[] } | null = null;

function clean(raw: unknown): CustomProvider | null {
  const r = raw as Partial<CustomProvider> | null;
  if (!r || !isCustomProviderId(r.id) || typeof r.baseUrl !== "string" || !r.baseUrl) return null;
  const models = Array.isArray(r.models) ? [...new Set(r.models.filter((m) => typeof m === "string" && m.trim()).map((m) => m.trim()))] : [];
  const defaultModel = typeof r.defaultModel === "string" && models.includes(r.defaultModel) ? r.defaultModel : (models[0] ?? "");
  if (!defaultModel) return null;
  return {
    id: r.id,
    name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 40) : hostOf(r.baseUrl),
    baseUrl: r.baseUrl,
    models: models.slice(0, MAX_MODELS),
    defaultModel,
    createdAt: typeof r.createdAt === "number" ? r.createdAt : 0,
  };
}

// 全部自定义服务（按添加顺序）。文件缺失 / 损坏一律当空表——绝不因此起不来。
export function listCustomProviders(): CustomProvider[] {
  const file = path.join(customProvidersDir(), META_FILE);
  let st;
  try {
    st = statSync(file);
  } catch {
    metaCache = null;
    return [];
  }
  if (metaCache && metaCache.file === file && metaCache.mtimeMs === st.mtimeMs && metaCache.size === st.size) return metaCache.list;
  let list: CustomProvider[] = [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    list = (Array.isArray(raw?.providers) ? raw.providers : []).map(clean).filter(Boolean) as CustomProvider[];
  } catch {
    list = [];
  }
  metaCache = { file, mtimeMs: st.mtimeMs, size: st.size, list };
  return list;
}

export function getCustomProvider(id: string): CustomProvider | undefined {
  return isCustomProviderId(id) ? listCustomProviders().find((p) => p.id === id) : undefined;
}

function writeMeta(list: CustomProvider[]): void {
  atomicWriteFileSync(path.join(customProvidersDir(), META_FILE), JSON.stringify({ v: 1, providers: list }, null, 2) + "\n");
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
  if (!secretsMod) secretsMod = (await import(new URL("../../src/extension-secrets.mjs", import.meta.url).href)) as SecretsMod;
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
    if (!existsSync(path.join(dir, "connector-secrets.json"))) return;
    const all = (await loadSecretsMod()).readSecrets(dir);
    for (const [id, rec] of Object.entries(all)) {
      const k = rec?.headers?.apiKey;
      if (isCustomProviderId(id) && typeof k === "string" && k) keys.set(id, k);
    }
  } catch (e) {
    keysError = String((e as Error)?.message ?? e).slice(0, 160);
    console.warn(`[custom-providers] API key 解不开：${keysError}`);
  }
})();

export function customProviderKey(id: string): string | undefined {
  return keys.get(id);
}

async function writeKeys(): Promise<void> {
  const mod = await loadSecretsMod();
  const map: Record<string, { headers: Record<string, string> }> = {};
  for (const [id, k] of keys) map[id] = { headers: { apiKey: k } };
  mod.writeSecrets(customProvidersDir(), map); // 失败就抛——绝不退回明文存
}

// ── 规范化 / 探活 ─────────────────────────────────────────────────────────────
export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

// 用户常贴三种形状：…/v1、…/v1/、…/v1/chat/completions——统一收成不带尾斜杠的根。
export function normalizeBaseUrl(raw: unknown): string {
  let s = String(raw ?? "").trim();
  if (!s) throw new Error("请填写接口地址");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`; // 没写协议才补 https；写了别的协议下面拒
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new Error("接口地址格式不对");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("接口地址只支持 http / https");
  if (u.username || u.password) throw new Error("接口地址里别带账号密码，API key 单独填");
  u.hash = "";
  let out = u.toString().replace(/\/+$/, "");
  out = out.replace(/\/chat\/completions$/i, "").replace(/\/models$/i, "");
  if (out.length > 300) throw new Error("接口地址太长");
  return out;
}

export interface ProbeResult {
  ok: boolean;
  models: string[];
  error?: string;
}

// GET {base}/models：OpenAI 兼容端点的模型清单。顺带验 key——401/403 当场告诉用户。
export async function probeModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<ProbeResult> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  const onAbort = () => ctl.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      signal: ctl.signal,
    });
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) return { ok: false, models: [], error: `API key 被拒绝（HTTP ${res.status}）` };
    if (!res.ok) return { ok: false, models: [], error: `模型列表取不到（HTTP ${res.status}）` };
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      return { ok: false, models: [], error: "接口没有返回 JSON——地址是不是少了 /v1？" };
    }
    const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
    const models = [
      ...new Set(
        arr
          .map((m: any) => (typeof m === "string" ? m : typeof m?.id === "string" ? m.id : typeof m?.name === "string" ? m.name : ""))
          .map((s: string) => s.replace(/^models\//, "").trim())
          .filter((s: string) => s && s.length <= 200),
      ),
    ] as string[];
    if (!models.length) return { ok: false, models: [], error: "接口没列出任何模型" };
    return { ok: true, models: models.slice(0, MAX_MODELS) };
  } catch (e) {
    const err = e as Error & { cause?: { code?: string } };
    if (ctl.signal.aborted) return { ok: false, models: [], error: "连接超时（12 秒没有响应）" };
    return { ok: false, models: [], error: `连不上：${err.cause?.code ?? err.message}` };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ── 增删改（路由层调用；失败抛 Error，消息是给人看的中文） ───────────────────
export interface CustomProviderInput {
  name?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  model?: unknown; // 探不到模型清单时手填的模型 ID
}

const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

async function resolveModels(baseUrl: string, apiKey: string, manual: string): Promise<{ models: string[]; warning?: string }> {
  const probe = await probeModels(baseUrl, apiKey);
  if (probe.ok) {
    const models = manual && !probe.models.includes(manual) ? [manual, ...probe.models] : probe.models;
    return { models };
  }
  if (manual) return { models: [manual], warning: probe.error };
  const e = new Error(probe.error ?? "连不上这个接口") as Error & { needsModel?: boolean };
  // key 被拒就不提示手填模型——填了也用不了
  e.needsModel = !/API key 被拒绝/.test(probe.error ?? "");
  throw e;
}

export async function addCustomProvider(input: CustomProviderInput): Promise<{ provider: CustomProvider; warning?: string }> {
  const list = listCustomProviders();
  if (list.length >= MAX_PROVIDERS) throw new Error(`最多添加 ${MAX_PROVIDERS} 个自定义服务`);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKey = str(input.apiKey, 4000);
  if (!apiKey) throw new Error("请填写 API key");
  const manual = str(input.model, 200);
  const { models, warning } = await resolveModels(baseUrl, apiKey, manual);
  let id: `custom-${string}`;
  do id = `custom-${randomBytes(4).toString("hex")}`;
  while (list.some((p) => p.id === id));
  const provider: CustomProvider = {
    id,
    name: str(input.name, 40) || hostOf(baseUrl),
    baseUrl,
    models,
    defaultModel: manual || pickDefault(models),
    createdAt: Date.now(),
  };
  keys.set(id, apiKey);
  try {
    await writeKeys();
  } catch (e) {
    keys.delete(id);
    throw new Error(`API key 没能加密保存：${(e as Error).message}`);
  }
  writeMeta([...listCustomProviders(), provider]);
  return { provider, warning };
}

export async function updateCustomProvider(id: string, input: CustomProviderInput): Promise<{ provider: CustomProvider; warning?: string }> {
  const cur = getCustomProvider(id);
  if (!cur) throw new Error("这个自定义服务不存在（可能已被删除）");
  const baseUrl = input.baseUrl === undefined ? cur.baseUrl : normalizeBaseUrl(input.baseUrl);
  const newKey = str(input.apiKey, 4000);
  const apiKey = newKey || keys.get(id) || "";
  if (!apiKey) throw new Error("请填写 API key");
  const manual = str(input.model, 200);
  const reprobe = baseUrl !== cur.baseUrl || Boolean(newKey) || Boolean(manual);
  let models = cur.models;
  let warning: string | undefined;
  if (reprobe) ({ models, warning } = await resolveModels(baseUrl, apiKey, manual));
  const next: CustomProvider = {
    ...cur,
    name: input.name === undefined ? cur.name : str(input.name, 40) || hostOf(baseUrl),
    baseUrl,
    models,
    defaultModel: manual || (models.includes(cur.defaultModel) ? cur.defaultModel : pickDefault(models)),
  };
  if (newKey && newKey !== keys.get(id)) {
    const prev = keys.get(id);
    keys.set(id, newKey);
    try {
      await writeKeys();
    } catch (e) {
      if (prev) keys.set(id, prev);
      else keys.delete(id);
      throw new Error(`API key 没能加密保存：${(e as Error).message}`);
    }
  }
  writeMeta(listCustomProviders().map((p) => (p.id === id ? next : p)));
  return { provider: next, warning };
}

export async function removeCustomProvider(id: string): Promise<void> {
  if (!getCustomProvider(id)) throw new Error("这个自定义服务不存在（可能已被删除）");
  writeMeta(listCustomProviders().filter((p) => p.id !== id));
  if (keys.delete(id)) await writeKeys().catch((e) => console.warn(`[custom-providers] 删除后重写 key 失败：${(e as Error).message}`));
}

// 设置页「API Key」一栏对自定义服务也有效：换 key 落进加密存储（同步路径上只改内存，写盘排队）。
export function setCustomProviderKey(id: string, apiKey: string): void {
  if (!getCustomProvider(id)) return;
  keys.set(id, apiKey);
  void writeKeys().catch((e) => console.warn(`[custom-providers] key 写盘失败：${(e as Error).message}`));
}

// 聊天用的模型往前放：embedding / tts / whisper / 生图这类名字排到后面，默认取第一个像聊天的。
const NON_CHAT = /embed|whisper|tts|audio|dall-?e|image|moderation|rerank|transcri|speech/i;
function pickDefault(models: string[]): string {
  return models.find((m) => !NON_CHAT.test(m)) ?? models[0];
}

export function customKeysError(): string {
  return keysError;
}
