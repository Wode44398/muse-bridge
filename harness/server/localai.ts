// 本机模型进程管理：状态探活 + 启停 + 启动参数。给 composer 的「本机」状态面板用。两台引擎：
//   qwen   —— llama.cpp 跑 Qwen3.8-27B，脚本与权重在 E:\LLM\，端口 8080；
//   strata —— Strata 引擎跑 Qwen3.8-Flash-Next 125B MoE，程序在 E:\Strata\、模型在 E:\Strata-data\（setup.py 搬过去的），端口 8081。
//             同一台引擎有几个变体（不同来源的量化，见 STRATA_VARIANTS），目录里各是一个型号；起哪个按会话的型号定，
//             经 STRATA_VARIANT 交给 E:\Strata\make-strata-config.py 写配置。
// 两台都在 git 仓库外；脚本路径与端口可用环境变量覆盖，别的机器上脚本不存在时如实报 installed:false。
// 同一张 32GB 卡放不下两台：起一台之前先停掉另一台；Strata 同一时间也只跑一个变体，换变体 = 停掉重起。
//
// 状态机：off（没进程）→ starting（进程在、/health 还没 200，模型加载中）→ on（/health 200，可服务）。
// 进程在但健康检查 503 = 加载中；连接被拒 + 进程在 = 端口还没绑上，也算 starting（Strata 要先把模型
// 整个装好才绑端口，1–3 分钟里一直是这样）。
//
// 启动参数存在启动脚本旁的 local-ai.json，面板里改；启动时以环境变量交给脚本（QWEN_* / STRATA_*），
// 脚本里对每个变量都有默认值，手工双击照旧能起。Strata 的几个变体共用一份参数（同一张卡、同一套结构，上下文 / KV / 识图 /
// 流式四个开关对每个变体意思一样；区别只在要哪些文件），不按变体各存。
// Qwen 显存实测（RTX 5090，2026-09-28）：q8_0 超过 128k、「K q8 / V q4」到 256k 都会溢出到系统内存——服务照样
// 起得来，只是生成速度腰斩；256k 只能 q4_0。所以面板要给显存估算，保存不拦（用户自己取舍）。
// Strata 的专家缓存按剩余显存自己定大小（--expert-cache auto），不会溢出，只是缓存的专家少了会慢，没有估算。

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWriteFileSync } from "./atomic-write.ts";
import { helperEnv } from "./helper-proc.ts";
import { inTestProcess } from "./paths.ts";

const execFileP = promisify(execFile);

export type LocalEngine = "qwen" | "strata";
export const LOCAL_ENGINES: readonly LocalEngine[] = ["qwen", "strata"];

// ── Strata 的变体 ──────────────────────────────────────────────────────────────
// 2026-11-07 起每个变体是目录里独立的型号（以前只有一个 strata-orca，实际跑哪个靠 STRATA_VARIANT 环境变量——10-06 起默认官方
// IQ3_S，所以那个 id 一个多月里跑的其实是官方版）。files 与 make-strata-config.py 的检查同一份清单（它缺文件就退出，窗口
// 一闪而过，所以这边先查好），相对启动脚本目录。configs：进程命令行 --config 指向这些文件名 = 在跑这个变体（第一个是
// make-strata-config.py 写的；其余是 setup.py 自己写的启动配置，手工双击 run-*.bat 起的也认得出）。names：/v1/models 报的
// model_name（make-strata-config.py 按变体写成型号 id；旧配置里的名字也收，但 strata-orca 两个变体都用过，不算数）。
// 本机核实过但没登记的：Maximilian228 的 NVFP4-GPTQ（setup.py 在 dense.bin 1.48/1.54 GB 时被停掉，128 GB 的专家权重、MTP
// 草稿层、启动配置都没有，跑不起来）。
export type StrataVariant = "flash-iq3s" | "orca-iq3xxs" | "flash-nvfp4";
export interface StrataVariantDef {
  id: StrataVariant;
  model: string; // 目录里的型号 id
  label: string; // 面板与报错里怎么称呼它
  env: string; // 交给 make-strata-config.py 的 STRATA_VARIANT
  configs: readonly string[];
  names: readonly string[];
  files: readonly string[];
  mmproj: string; // 识图模块（开了识图才要）
}
const DATA = "..\\Strata-data";
const MTP_RT = [`${DATA}\\mtp\\rt\\experts.bin`, `${DATA}\\mtp\\rt\\draft_vocab.bin`];
const MMPROJ = `${DATA}\\models\\mmproj-Qwen3.8-Flash-Next-BF16.gguf`; // 官方识图模块：setup.py --vision yes 放在 models 根目录
const IQ3S = `${DATA}\\models\\IQ3_S\\Qwen3.8-Flash-Next-GSQ-RCO-IQ3_S-0000`;
const ORCA = `${DATA}\\models\\orca\\Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-0000`;
const NVFP4 = `${DATA}\\models\\nvidia--Qwen3.8-Flash-Next-FP4-Local\\prepared`;
export const STRATA_VARIANTS: readonly StrataVariantDef[] = [
  // 官方 GSQ-RCO IQ3_S（ISTA-DASLab）：2026-10-06 同机难题 43/46（= Qwen 27B），xhigh 能自己收尾。默认变体。
  {
    id: "flash-iq3s",
    model: "strata-flash-iq3s",
    label: "官方 IQ3_S",
    env: "official",
    configs: ["strata-flash.json", "strata-iq3_s.json"],
    names: ["strata-flash-iq3s", "qwen3.8-flash-next-iq3_s"],
    files: ["engine\\strata.exe", `${IQ3S}1-of-00002.gguf`, `${IQ3S}2-of-00002.gguf`, `${DATA}\\packs\\iq3_s\\tokenizer\\vocab.json`, ...MTP_RT],
    mmproj: MMPROJ,
  },
  // OrcaRouter 无审查 IQ3_XXS（消融 + 普通 IQ3_XXS + 兼容路径）：同一套题 36/46，xhigh 停不下来。唯一的无审查备选。
  {
    id: "orca-iq3xxs",
    model: "strata-orca-iq3xxs",
    label: "Orca 无审查 IQ3_XXS",
    env: "orca",
    configs: ["strata-orca.json"],
    names: ["strata-orca-iq3xxs", "orcarouter-qwen3.8-flash-next-uncensored-iq3_xxs"],
    files: ["engine\\strata.exe", `${ORCA}1-of-00002.gguf`, `${ORCA}2-of-00002.gguf`, `${DATA}\\packs\\orca-iq3_xxs\\tokenizer\\vocab.json`, ...MTP_RT],
    mmproj: `${DATA}\\models\\orca\\mmproj-Qwen3.8-Flash-Next-Uncensored-F16.gguf`,
  },
  // NVIDIA 的 Qwen3.8-Flash-Next-FP4-Local（为 FP4 训练过的 QAD 版），setup.py --family nvfp4 --model NVFP4-QAD 在本机转成
  // Strata 打包（2026-10-20）。自带 MTP 草稿层；setup.py 写的配置是 128k、int8、KV 流式、识图开。.done 是转换完成的标记。
  {
    id: "flash-nvfp4",
    model: "strata-flash-nvfp4",
    label: "NVIDIA NVFP4（QAD）",
    env: "nvfp4",
    configs: ["strata-nvfp4.json", "strata-nvfp4-nvfp4-qad.json"],
    names: ["strata-flash-nvfp4", "qwen3.8-flash-next-nvfp4-nvfp4-qad"],
    files: [
      "engine\\strata.exe",
      `${NVFP4}\\pack.done`,
      `${NVFP4}\\pack\\tokenizer\\vocab.json`,
      `${NVFP4}\\dense.gguf`, // make-strata-config.py 的 --native / --native-dense-gguf 与 --ple：只有标记、本体被删了也起不来
      `${NVFP4}\\ple-nvfp4.gguf`,
      `${NVFP4}\\dense.gguf.done`,
      `${NVFP4}\\ple-nvfp4.gguf.done`,
      `${NVFP4}\\draft.done`,
      `${NVFP4}\\mtp\\rt\\experts.bin`,
      `${NVFP4}\\mtp\\rt\\draft_vocab.bin`,
    ],
    mmproj: MMPROJ,
  },
];
export const DEFAULT_STRATA_VARIANT: StrataVariant = "flash-iq3s";
// 改名前唯一的 Strata 型号 id：旧会话、runtime-config、子 agent 覆盖里还存着它。等价别名——解析成官方 IQ3_S（它这一个多月
// 实际跑的就是官方版），目录里不再单列。
export const LEGACY_STRATA_MODEL = "strata-orca";
export const LOCAL_MODEL_ALIASES: Readonly<Record<string, string>> = Object.freeze({ [LEGACY_STRATA_MODEL]: "strata-flash-iq3s" });
// 默认变体的型号 id（旧代码 / 测试按「Strata 那个型号」引用的就是它）
export const STRATA_MODEL = "strata-flash-iq3s";

export function canonicalLocalModel(model: string): string {
  return LOCAL_MODEL_ALIASES[model] ?? model;
}
export function strataVariant(id: StrataVariant): StrataVariantDef {
  return STRATA_VARIANTS.find((v) => v.id === id)!;
}
// 型号 → 变体（不是 Strata 的型号回 undefined）
export function strataVariantOf(model: string | undefined): StrataVariantDef | undefined {
  if (!model) return undefined;
  const id = canonicalLocalModel(model);
  return STRATA_VARIANTS.find((v) => v.model === id);
}
export function cleanVariant(raw: unknown): StrataVariant | undefined {
  return STRATA_VARIANTS.find((v) => v.id === raw)?.id;
}
// 进程命令行里的配置文件 / 服务报的 model_name → 变体
function variantOfConfig(file: string): StrataVariant | undefined {
  const base = path.win32.basename(file.replace(/^"|"$/g, "")).toLowerCase();
  return STRATA_VARIANTS.find((v) => v.configs.includes(base))?.id;
}
function variantOfName(name: unknown): StrataVariant | undefined {
  return typeof name === "string" ? STRATA_VARIANTS.find((v) => v.names.includes(name))?.id : undefined;
}

export function cleanEngine(raw: unknown): LocalEngine {
  return raw === "strata" ? "strata" : "qwen";
}
export function engineOfModel(model: string | undefined): LocalEngine {
  return strataVariantOf(model) ? "strata" : "qwen";
}

// ── 启动参数 ────────────────────────────────────────────────────────────────
// Qwen（llama.cpp）kv：两份缓存（K / V）的量化。K 算注意力分数、要过 softmax，比 V 怕压，所以折中档是「K 保 q8、V 降 q4」。
export type LocalKv = "q8_0" | "q8q4" | "q4_0";
export interface LocalAiSettings {
  ctx: number;
  kv: LocalKv;
  vision: boolean;
  mtp: boolean;
}
export const LOCAL_CTX_CHOICES = [32_768, 65_536, 131_072, 196_608, 262_144] as const; // 262144 = 模型训练上限
export const LOCAL_AI_DEFAULTS: LocalAiSettings = { ctx: 131_072, kv: "q8_0", vision: true, mtp: true };
const KV_ARGS: Record<LocalKv, [string, string]> = { q8_0: ["q8_0", "q8_0"], q8q4: ["q8_0", "q4_0"], q4_0: ["q4_0", "q4_0"] };

export function cleanLocalAiSettings(raw: unknown, base: LocalAiSettings = LOCAL_AI_DEFAULTS): LocalAiSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<LocalAiSettings>;
  return {
    ctx: (LOCAL_CTX_CHOICES as readonly number[]).includes(r.ctx as number) ? (r.ctx as number) : base.ctx,
    kv: r.kv && r.kv in KV_ARGS ? r.kv : base.kv,
    vision: typeof r.vision === "boolean" ? r.vision : base.vision,
    mtp: typeof r.mtp === "boolean" ? r.mtp : base.mtp,
  };
}

// Strata：--kv 只有 int8 / k8v4 / q4_0 三档；MTP 投机解码是它常驻服务的硬前提（strata serve 没有 --mtp 直接拒起），
// 所以没有 MTP 开关，换成 KV 流式（--kv-resident，64k 起把整份 KV 放内存、显存里只留注意力要读的 32k，
// 腾出的显存多缓存专家；k8v4 不支持流式）。上下文默认 128k，最低 64k：dimensio 光系统提示 + 工具定义就约 2 万 token，再加 loop.ts
// 给的 max_tokens（约 2.5 万），Strata 对「提示词 + max_tokens > 上下文」直接 400、不截断——32k 第一轮就被拒，所以不给选
// （存着 32k 的旧设置读回来按默认算）。KV 流式开着时 128k 只多占约 1.8 GB 内存，训练上限 256k。
export type StrataKv = "int8" | "k8v4" | "q4_0";
export interface StrataSettings {
  ctx: number;
  kv: StrataKv;
  vision: boolean;
  stream: boolean;
}
export const STRATA_CTX_CHOICES = [65_536, 131_072, 262_144] as const;
export const STRATA_DEFAULTS: StrataSettings = { ctx: 131_072, kv: "int8", vision: false, stream: true };
const STRATA_KVS: readonly StrataKv[] = ["int8", "k8v4", "q4_0"];

export function cleanStrataSettings(raw: unknown, base: StrataSettings = STRATA_DEFAULTS): StrataSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<StrataSettings>;
  return {
    ctx: (STRATA_CTX_CHOICES as readonly number[]).includes(r.ctx as number) ? (r.ctx as number) : base.ctx,
    kv: r.kv && STRATA_KVS.includes(r.kv) ? r.kv : base.kv,
    vision: typeof r.vision === "boolean" ? r.vision : base.vision,
    stream: typeof r.stream === "boolean" ? r.stream : base.stream,
  };
}

type AnySettings = LocalAiSettings | StrataSettings;

interface EngineDef<S extends AnySettings> {
  startScript: string;
  baseUrl: string;
  procName: string;
  settingsFile: string;
  defaults: S;
  clean: (raw: unknown, base?: S) => S;
  // variant 只对 Strata 有意义（交给 make-strata-config.py 选哪套文件）
  env: (s: S, variant: StrataVariantDef) => Record<string, string>;
  // 起之前必须在的文件（相对启动脚本目录）；缺了就不起，面板照实列出来
  required: (s: S, variant: StrataVariantDef) => readonly string[];
}

const qwenScript = process.env.LOCAL_START_SCRIPT?.trim() || "E:\\LLM\\start-qwen.bat";
const strataScript = process.env.STRATA_START_SCRIPT?.trim() || "E:\\Strata\\start-strata.bat";

const ENGINES: { qwen: EngineDef<LocalAiSettings>; strata: EngineDef<StrataSettings> } = {
  qwen: {
    startScript: qwenScript,
    baseUrl: (process.env.LOCAL_BASE_URL?.trim() || "http://127.0.0.1:8080").replace(/\/+$/, "").replace(/\/v1$/, ""),
    procName: "llama-server.exe",
    settingsFile: process.env.LOCAL_AI_SETTINGS?.trim() || path.join(path.dirname(qwenScript), "local-ai.json"),
    defaults: LOCAL_AI_DEFAULTS,
    clean: cleanLocalAiSettings,
    // QWEN_NOPAUSE：脚本末尾的 pause 是给手工双击看报错的；面板起的窗口是最小化的，留着只会每次重启在任务栏多一个空窗口
    env: (s) => {
      const [k, v] = KV_ARGS[s.kv];
      return { QWEN_CTX: String(s.ctx), QWEN_CTK: k, QWEN_CTV: v, QWEN_VISION: s.vision ? "1" : "0", QWEN_MTP: s.mtp ? "1" : "0", QWEN_NOPAUSE: "1" };
    },
    required: () => [],
  },
  strata: {
    startScript: strataScript,
    baseUrl: (process.env.STRATA_BASE_URL?.trim() || "http://127.0.0.1:8081").replace(/\/+$/, "").replace(/\/v1$/, ""),
    procName: "strata.exe",
    settingsFile: process.env.STRATA_AI_SETTINGS?.trim() || path.join(path.dirname(strataScript), "local-ai.json"),
    defaults: STRATA_DEFAULTS,
    clean: cleanStrataSettings,
    env: (s, v) => ({
      STRATA_VARIANT: v.env,
      STRATA_CTX: String(s.ctx),
      STRATA_KV: s.kv,
      STRATA_VISION: s.vision ? "1" : "0",
      STRATA_STREAM: s.stream ? "1" : "0",
      STRATA_NOPAUSE: "1",
    }),
    // 开了识图没有识图模块就列为缺失，不让起（make-strata-config.py 同样会拒）
    required: (s, v) => [...v.files, ...(s.vision ? [v.mmproj] : [])],
  },
};

function def(engine: LocalEngine): EngineDef<AnySettings> {
  return ENGINES[engine] as unknown as EngineDef<AnySettings>;
}

// 本机型号走哪个端点（带 /v1）：Strata 那个型号去 8081，其余沿用会话配置里的地址。适配器每次请求现算，
// 子 agent、压缩摘要这些旁路请求也就跟着型号走，不用各处记。
export function localModelBaseUrl(model: string): string | undefined {
  return engineOfModel(model) === "strata" ? `${ENGINES.strata.baseUrl}/v1` : undefined;
}

// 目录（catalog.ts）每次列本机型号都会来读，按 mtime 缓存；文件缺失 / 损坏一律当默认值
const settingsCache = new Map<LocalEngine, { mtimeMs: number; value: AnySettings }>();
function readSettings(engine: LocalEngine): AnySettings {
  const d = def(engine);
  try {
    const { mtimeMs } = statSync(d.settingsFile);
    const hit = settingsCache.get(engine);
    if (hit && hit.mtimeMs === mtimeMs) return hit.value;
    const value = d.clean(JSON.parse(readFileSync(d.settingsFile, "utf8")));
    settingsCache.set(engine, { mtimeMs, value });
    return value;
  } catch {
    return d.defaults;
  }
}

export function localAiSettings(): LocalAiSettings {
  return readSettings("qwen") as LocalAiSettings;
}
export function strataSettings(): StrataSettings {
  return readSettings("strata") as StrataSettings;
}

export function saveLocalAiSettings(raw: unknown, engine: LocalEngine = "qwen"): AnySettings {
  const d = def(engine);
  const value = d.clean(raw, readSettings(engine));
  atomicWriteFileSync(d.settingsFile, JSON.stringify(value, null, 2) + "\n");
  settingsCache.delete(engine);
  return value;
}

export interface StrataVariantStatus {
  id: StrataVariant;
  model: string;
  label: string;
  missing?: string[]; // 按已保存的启动参数（开了识图要识图模块）还缺的文件；空 = 能起
}

export interface LocalAiStatus {
  engine: LocalEngine;
  installed: boolean; // 启动脚本在不在（不在 = 这台机器没部署这台引擎）
  missing?: string[]; // 脚本在、但模型 / 打包 / 草稿层还缺的文件（绝对路径）；缺了不让起。Strata：问的那个变体缺的
  process: boolean; // 引擎进程在不在
  ready: boolean; // /health 200 = 模型加载完毕可服务
  state: "off" | "starting" | "on";
  pid?: number;
  baseUrl: string;
  settings: AnySettings; // 已保存的启动参数（下次启动用）
  running?: { ctx: number; vision: boolean }; // 就绪时从 /props 读到的实际值；和 settings 对不上 = 要重启才生效
  // 以下只有 Strata：variant = 这次问的（按会话型号；没说 = 在跑的，再没有 = 默认），runningVariant = 进程在跑的那个
  //（从命令行里的配置文件认；认不出 = null，比如手工拿别的配置起的），variants = 每个变体缺不缺文件
  variant?: StrataVariant;
  runningVariant?: StrataVariant | null;
  variants?: StrataVariantStatus[];
}

async function findPid(engine: LocalEngine): Promise<number | undefined> {
  const proc = def(engine).procName;
  try {
    const { stdout } = await execFileP("tasklist", ["/FI", `IMAGENAME eq ${proc}`, "/FO", "CSV", "/NH"], {
      timeout: 5000,
      windowsHide: true,
    });
    // CSV 一行一个进程："llama-server.exe","1234","Console",...
    const m = new RegExp(`"${proc.replace(".", "\\.")}","(\\d+)"`, "i").exec(stdout);
    return m ? Number(m[1]) : undefined;
  } catch {
    return undefined;
  }
}

// Strata 是两层：python 的 serve.server（HTTP 层，加载完才绑端口）+ 它拉起的 strata.exe（引擎）。
// 加载的头几秒只有 python、还没有 strata.exe——也算「在跑」，不然面板会在点完启动后闪回「未运行」。
// 命令行里 --config 指向哪份配置 = 跑的是哪个变体（start-strata.bat 是 `-m serve.server --engine strata --config strata-flash.json`，
// setup.py 写的 run-*.bat 是 `serve\server.py "--engine" "strata" "--config" "E:\…\strata-nvfp4-nvfp4-qad.json"`）。
interface StrataServerProc {
  pid: number;
  variant: StrataVariant | null;
}
// 只认 serve.server + --engine strata，不看端口：手工在别的端口起的 Strata 也算进来——停止时会一并结束（本机同一时间只该跑一台）。
async function strataServers(): Promise<StrataServerProc[]> {
  try {
    const ps =
      "Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*serve*server*' -and $_.CommandLine -like '*--engine*strata*' } | " +
      "ForEach-Object { [string]$_.ProcessId + \"`t\" + $_.CommandLine }";
    const { stdout } = await execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], {
      timeout: 10_000,
      windowsHide: true,
    });
    return parseStrataServers(stdout);
  } catch {
    return [];
  }
}
// 拆出来给测试：每行「pid<TAB>命令行」
export function parseStrataServers(stdout: string): StrataServerProc[] {
  const out: StrataServerProc[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const tab = line.indexOf("\t");
    const pid = Number(line.slice(0, tab));
    if (tab < 0 || !(pid > 0)) continue;
    const cfg = /--config"?\s+("[^"]+"|\S+)/i.exec(line.slice(tab + 1))?.[1];
    out.push({ pid, variant: cfg ? (variantOfConfig(cfg) ?? null) : null });
  }
  return out;
}

async function enginePid(engine: LocalEngine): Promise<number | undefined> {
  const pid = await findPid(engine);
  if (pid !== undefined || engine !== "strata") return pid;
  return (await strataServers())[0]?.pid;
}

function missingFiles(engine: LocalEngine, s: AnySettings, variant: StrataVariantDef = strataVariant(DEFAULT_STRATA_VARIANT)): string[] {
  const d = def(engine);
  const root = path.dirname(d.startScript);
  return d.required(s, variant).map((rel) => path.join(root, rel)).filter((p) => !existsSync(p));
}

async function probeReady(engine: LocalEngine): Promise<boolean> {
  try {
    const res = await fetch(`${def(engine).baseUrl}/health`, { signal: AbortSignal.timeout(900) });
    return res.ok; // 503 = 还在加载；200 = 就绪
  } catch {
    return false;
  }
}

// 只问 /health、不查进程（子 agent 选型阶梯判「本机模型此刻能不能用」：不起 tasklist / PowerShell）
export const localEngineReady = (engine: LocalEngine): Promise<boolean> => probeReady(engine);
// 按型号问：引擎就绪，且（Strata）在跑的正是这个变体——认不出在跑哪个也算（同 strataVariantMismatch 的放行口径）。
// 给选型阶梯用：同一时间 Strata 只有一个变体能接，别把子 agent 派给没在跑的那个（派过去也会被适配器拒）。
export async function localModelReady(model: string): Promise<boolean> {
  if (!(await probeReady(engineOfModel(model)))) return false;
  return !strataVariantOf(model) || (await strataVariantMismatch(model)) === undefined;
}

// 同一个进程的 /props 不会变，按 pid 记一次。Strata 的 /props 学的是 llama-server 的形状（n_ctx / modalities.vision）
const propsCache = new Map<LocalEngine, { pid: number; running: { ctx: number; vision: boolean } }>();
async function probeRunning(engine: LocalEngine, pid: number): Promise<{ ctx: number; vision: boolean } | undefined> {
  const hit = propsCache.get(engine);
  if (hit?.pid === pid) return hit.running;
  try {
    const res = await fetch(`${def(engine).baseUrl}/props`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return undefined;
    const p = (await res.json()) as { default_generation_settings?: { n_ctx?: number }; modalities?: { vision?: boolean } };
    const ctx = p.default_generation_settings?.n_ctx;
    if (typeof ctx !== "number") return undefined;
    const running = { ctx, vision: p.modalities?.vision === true };
    propsCache.set(engine, { pid, running });
    return running;
  } catch {
    return undefined;
  }
}

// Strata 此刻在跑哪个变体：引擎进程在且已就绪时先问服务自己报的 model_name（一个 HTTP 请求）；加载中 / 认不出再看
// python 层的命令行（要起一次 PowerShell，所以按引擎 pid 记住——同一个进程的配置不会变）。面板开着时 2 秒问一次状态。
const variantByPid = new Map<number, StrataVariant | null>();
async function strataRunningVariant(): Promise<{ pid?: number; variant: StrataVariant | null }> {
  const exe = await findPid("strata");
  if (exe !== undefined) {
    for (const k of variantByPid.keys()) if (k !== exe) variantByPid.delete(k); // 只留眼下这个进程的：重起过的旧 pid 没用了
    if (variantByPid.has(exe)) return { pid: exe, variant: variantByPid.get(exe)! };
    const served = await servedVariant();
    if (served) {
      variantByPid.set(exe, served);
      return { pid: exe, variant: served };
    }
  }
  const procs = await strataServers();
  const known = procs.find((p) => p.variant)?.variant ?? null;
  // 引擎进程已经在、命令行也认出来了才记（加载头几秒只有 python 层）
  if (exe !== undefined && known) variantByPid.set(exe, known);
  const pid = exe ?? procs[0]?.pid;
  return pid === undefined ? { variant: null } : { pid, variant: known };
}

// /v1/models 报的名字 → 变体（没就绪 / 连不上 / 认不出 = undefined）
async function servedVariant(): Promise<StrataVariant | undefined> {
  try {
    const res = await fetch(`${ENGINES.strata.baseUrl}/v1/models`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { data?: { id?: unknown }[] };
    for (const m of j.data ?? []) {
      const v = variantOfName(m.id);
      if (v) return v;
    }
  } catch {
    /* 没起 / 在加载 */
  }
  return undefined;
}

// 问的是哪个变体：显式给了按给的；没给按在跑的；都没有按默认
function pickVariant(want: StrataVariant | undefined, running: StrataVariant | null | undefined): StrataVariantDef {
  return strataVariant(want ?? running ?? DEFAULT_STRATA_VARIANT);
}

export async function localAiStatus(engine: LocalEngine = "qwen", want?: StrataVariant): Promise<LocalAiStatus> {
  const d = def(engine);
  const strata = engine === "strata" ? await strataRunningVariant() : undefined;
  const pid = strata ? strata.pid : await enginePid(engine);
  const ready = pid ? await probeReady(engine) : false;
  const settings = readSettings(engine);
  const installed = existsSync(d.startScript);
  const runningVariant = pid !== undefined ? (strata?.variant ?? null) : null;
  const v = engine === "strata" ? pickVariant(want, runningVariant) : undefined;
  const missing = installed ? missingFiles(engine, settings, v) : [];
  return {
    engine,
    installed,
    ...(missing.length ? { missing } : {}),
    process: pid !== undefined,
    ready,
    state: pid === undefined ? "off" : ready ? "on" : "starting",
    pid,
    baseUrl: d.baseUrl,
    settings,
    running: pid && ready ? await probeRunning(engine, pid) : undefined,
    ...(v
      ? {
          variant: v.id,
          runningVariant: pid !== undefined ? runningVariant : null,
          variants: STRATA_VARIANTS.map((x) => {
            const miss = installed ? missingFiles(engine, settings, x) : [];
            return { id: x.id, model: x.model, label: x.label, ...(miss.length ? { missing: miss } : {}) };
          }),
        }
      : {}),
  };
}

// 已在跑/在加载就不重复起；脚本不在、文件不齐就明说。另一台在跑先停掉（一张卡放不下两台）。
// Strata：在跑的变体不是要的那个（认得出才算）= 切换，停掉按要的那个重起；认不出的不动它（面板会提示）。
// 启动走 start /min 开最小化窗口（日志在里面），detached+unref 让它不挂在本进程生死上。
export async function localAiStart(engine: LocalEngine = "qwen", want?: StrataVariant): Promise<LocalAiStatus> {
  const d = def(engine);
  if (!existsSync(d.startScript)) return { ...(await localAiStatus(engine, want)), installed: false };
  const settings = readSettings(engine);
  let running: StrataVariant | null | undefined;
  if (engine === "strata") {
    const r = await strataRunningVariant();
    running = r.pid !== undefined ? r.variant : undefined;
  }
  const v = pickVariant(want, running);
  if (missingFiles(engine, settings, v).length) return localAiStatus(engine, v.id);
  if (engine === "strata" && running && running !== v.id) await localAiStop("strata");
  if ((await enginePid(engine)) === undefined) {
    const other: LocalEngine = engine === "qwen" ? "strata" : "qwen";
    if ((await enginePid(other)) !== undefined) await localAiStop(other);
    servedCache = undefined;
    // start 直接跟 .bat 等于 cmd /K（脚本跑完窗口还留在提示符），显式套一层 cmd /c 才会随服务退出而关
    const child = spawn("cmd.exe", ["/c", "start", "", "/min", "cmd.exe", "/c", d.startScript], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: helperEnv(d.env(settings, v)), // S7：本机模型服务用不着任何 provider key
    });
    child.unref();
    // 等进程表刷出来再回报，免得前端第一拍看到 off 闪一下（Strata 先起 python 再拉引擎，给长一点）
    const tries = engine === "strata" ? 20 : 10;
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, 300));
      if ((await findPid(engine)) !== undefined) break;
    }
  }
  return localAiStatus(engine, engine === "strata" ? v.id : undefined);
}

// qwen：只杀 llama-server.exe 自己（它不起子进程；拉起它的 bat/cmd 等它退出后自己结束）。
// strata：先杀 python 的 serve.server（不然它会把死掉的引擎重新拉起来），再杀引擎与识图进程。
// #77：一律不带 /T——taskkill /T 按 ParentProcessId 找「子进程」，会顺着悬空的父 PID 杀到不相干的进程。
export async function localAiStop(engine: LocalEngine = "qwen", want?: StrataVariant): Promise<LocalAiStatus> {
  if ((await enginePid(engine)) !== undefined) {
    const kill = async (args: string[]) => {
      try {
        await execFileP("taskkill", ["/F", ...args], { timeout: 8000, windowsHide: true });
      } catch {
        /* 进程刚好自己退了也算达成 */
      }
    };
    if (engine === "strata") {
      for (const p of await strataServers()) await kill(["/PID", String(p.pid)]);
      await kill(["/IM", "strata-vision.exe"]);
    }
    await kill(["/IM", def(engine).procName]);
    // taskkill 返回时进程表常常还没刷新：不等就会回报 starting，紧跟着的「保存并重启」还会把它当成在跑再重启一次
    for (let i = 0; i < 25 && (await enginePid(engine)) !== undefined; i++) await new Promise((r) => setTimeout(r, 200));
  }
  if (engine === "strata") servedCache = undefined;
  return localAiStatus(engine, want);
}

// 存参数；在跑（或在加载）就停掉按新参数重起——Strata 重起的是在跑的那个变体（改参数不顺手换变体；认不出的按问的那个）。
export async function localAiApply(raw: unknown, engine: LocalEngine = "qwen", want?: StrataVariant): Promise<LocalAiStatus> {
  saveLocalAiSettings(raw, engine);
  if ((await enginePid(engine)) === undefined) return localAiStatus(engine, want);
  const running = engine === "strata" ? (await strataRunningVariant()).variant : null;
  await localAiStop(engine);
  return localAiStart(engine, running ?? want);
}

// ── 发错模型的护栏 ──────────────────────────────────────────────────────────────
// Strata 的几个变体共用 8081，服务对 model 字段来者不拒：会话选的是 Orca、在跑的是官方版，请求照样有回应，只是换了个模型答。
// 适配器发请求前问一句（/v1/models 报的 model_name，make-strata-config.py 按变体写；5 秒缓存），认得出且对不上就不发，
// 报一句话让用户去面板切换。连不上 / 在加载 / 认不出一律放行（走原来的连接错误与加载等待）。测试进程不碰本机端口。
let servedCache: { at: number; v: StrataVariant | undefined } | undefined;
let servedOverride: (() => StrataVariant | undefined) | null = null;
export function setStrataServedForTests(fn: (() => StrataVariant | undefined) | null): void {
  servedOverride = fn;
  servedCache = undefined;
}
export async function strataVariantMismatch(model: string): Promise<string | undefined> {
  const want = strataVariantOf(model);
  if (!want) return undefined;
  let running: StrataVariant | undefined;
  if (servedOverride) running = servedOverride();
  else {
    if (inTestProcess()) return undefined;
    if (!servedCache || Date.now() - servedCache.at > 5000) servedCache = { at: Date.now(), v: await servedVariant() };
    running = servedCache.v;
  }
  if (!running || running === want.id) return undefined;
  const r = strataVariant(running);
  return `本机 Strata 正在跑「${r.label}」，这个会话选的是「${want.label}」：没有发出这条请求，免得换了模型回答。在「本机」面板里切换到「${want.label}」（重新加载约 1–3 分钟），或把会话型号换成「Strata · ${r.label}」。`;
}

// ── 显存 ────────────────────────────────────────────────────────────────────
// 整卡总量 / 已用走 nvidia-smi（几十毫秒）。引擎自己占多少、有没有溢出到系统内存（WDDM 的 sysmem
// fallback：显存不够时静默借内存，速度腰斩）nvidia-smi 给不出（按进程一律 N/A），只能读性能计数器
// 「GPU Process Memory」——要起一次 PowerShell，所以只在面板打开时查、5 秒缓存。
export interface LocalGpuInfo {
  name?: string;
  totalMiB?: number;
  usedMiB?: number;
  self?: { dedicatedMiB: number; sharedMiB: number }; // 引擎在跑时才有
}
const gpuCache = new Map<LocalEngine, { at: number; key: string; info: LocalGpuInfo }>();

export async function localGpuInfo(engine: LocalEngine = "qwen"): Promise<LocalGpuInfo> {
  const pid = await findPid(engine); // 显存记在引擎进程（llama-server / strata.exe）名下，不是 Strata 的 python 层
  // 键带上「是否就绪」：加载途中读到的是半截占用，面板在变绿那一刻重拉时不能拿到它
  const key = `${pid ?? "-"}:${pid ? await probeReady(engine) : false}`;
  const hit = gpuCache.get(engine);
  if (hit && hit.key === key && Date.now() - hit.at < 5000) return hit.info;
  const info: LocalGpuInfo = {};
  try {
    const { stdout } = await execFileP("nvidia-smi", ["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"], {
      timeout: 5000,
      windowsHide: true,
    });
    const [name, total, used] = stdout.split(/\r?\n/)[0].split(",").map((s) => s.trim());
    Object.assign(info, { name, totalMiB: Number(total), usedMiB: Number(used) });
  } catch {
    /* 没有 N 卡 / 驱动不在：面板不显示显存 */
  }
  if (pid !== undefined) {
    try {
      const ps = `$s=(Get-Counter '\\GPU Process Memory(pid_${pid}_*)\\*' -ErrorAction SilentlyContinue).CounterSamples;` +
        `$d=($s|?{$_.Path -like '*dedicated usage'}|Measure-Object CookedValue -Sum).Sum;` +
        `$h=($s|?{$_.Path -like '*shared usage'}|Measure-Object CookedValue -Sum).Sum;"$d,$h"`;
      const { stdout } = await execFileP("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { timeout: 10_000, windowsHide: true });
      const [d, h] = stdout.trim().split(",").map(Number);
      if (d > 0) info.self = { dedicatedMiB: Math.round(d / 1048576), sharedMiB: Math.round((h || 0) / 1048576) };
    } catch {
      /* 计数器读不到就不报 */
    }
  }
  gpuCache.set(engine, { at: Date.now(), key, info });
  return info;
}
