// 本机 AI 状态：顶栏运行设置按钮（shell/RunButton：状态点与轮询）、上下文面板的「本机模型」行、控制面板（LocalAiMenu）共用。
// 两台引擎（qwen = llama.cpp 跑 Qwen3.8-27B，strata = Strata 跑 125B MoE）：lai.engine 是眼下看的那台——按当前型号定，
// 控制面板顶上可以临时切去看另一台。
// Strata 有几个变体（目录里各是一个 strata-* 型号）：lai.model 是这个会话选的那个——状态按它问、启动按它起；
// 在跑的不是它时（runningVariant ≠ variant）运行设置按钮与面板都要明说，适配器那边也会拒发（server/localai.ts）。
import {
  isStrataModel,
  localAiStatus,
  localGpuInfo,
  type LocalAiSettings,
  type LocalAiStatus,
  type LocalEngine,
  type LocalGpuInfo,
  type LocalKv,
  type StrataVariantStatus,
} from "./api.ts";
import { haptic } from "./touch.ts";
import { t } from "./i18n.ts";

export const lai = $state({
  engine: "qwen" as LocalEngine,
  model: undefined as string | undefined, // 会话选的 Strata 型号（不是 Strata 型号 = undefined：服务端按在跑的 / 默认变体答）
  st: null as LocalAiStatus | null,
  gpu: null as LocalGpuInfo | null,
  err: "",
  busy: false, // 启停请求在飞
  open: false, // 面板是否展开（决定轮询节奏）
});

export async function refreshLocalGpu() {
  try {
    lai.gpu = await localGpuInfo(lai.engine);
  } catch {
    lai.gpu = null; // 旧后端 / 没有 N 卡：面板不显示显存
  }
}

// ── 显存估算 ────────────────────────────────────────────────────────────────
// llama-server 进程独占显存的实测拟合（RTX 5090 + Qwen3.8-27B UD-Q4_K_XL，2026-09-28）：
// 视觉 + MTP 全开时基础 19220 MiB，每 1k 上下文 q8_0 +44、q4_0 +28（q4 从 64k 到 256k 四点严格线性），
// 「K q8 / V q4」取中间 36；关视觉 −1136（mmproj），关 MTP −2272（草稿头 + 它自己的缓存，但生成速度 179→68 tok/s）。
const BASE_MIB = 19220;
const KV_MIB_PER_1K: Record<LocalKv, number> = { q8_0: 44, q8q4: 36, q4_0: 28 };
export function estimateLocalMiB(s: LocalAiSettings): number {
  return Math.round(BASE_MIB - (s.vision ? 0 : 1136) - (s.mtp ? 0 : 2272) + (s.ctx / 1024) * KV_MIB_PER_1K[s.kv]);
}
// Windows 的显存不能用满：实测「整卡已用」到约 31.2GB（总 32.6GB）就开始借系统内存，所以扣 1200 MiB 余量。
const WDDM_RESERVE_MIB = 1200;

export type VramVerdict = { needMiB: number; availMiB: number; level: "ok" | "tight" | "over" } | null;
// 可用 = 整卡 − 别的进程占的（在跑时把 llama-server 自己那份从「已用」里扣掉）。只有 Qwen 有拟合系数；
// Strata 的专家缓存按剩余显存自己定大小，不会溢出，不估。
export function vramVerdict(s: LocalAiSettings): VramVerdict {
  const g = lai.gpu;
  if (lai.engine !== "qwen" || !g?.totalMiB || g.usedMiB === undefined) return null;
  const selfMiB = lai.st?.process ? (g.self?.dedicatedMiB ?? (lai.st.settings ? estimateLocalMiB(lai.st.settings as LocalAiSettings) : 0)) : 0;
  const availMiB = g.totalMiB - WDDM_RESERVE_MIB - Math.max(0, g.usedMiB - selfMiB);
  const needMiB = estimateLocalMiB(s);
  return { needMiB, availMiB, level: needMiB > availMiB ? "over" : needMiB > availMiB - 800 ? "tight" : "ok" };
}

export async function refreshLocalAi() {
  const engine = lai.engine;
  const model = lai.model;
  try {
    const st = await localAiStatus(engine, model);
    if (engine !== lai.engine || model !== lai.model) return; // 请求在飞时切了引擎 / 型号：这份是别的，丢掉
    lai.st = st;
    lai.err = "";
  } catch (e) {
    if (engine !== lai.engine) return;
    lai.err = (e as Error).message; // 状态接口本身挂（老后端无此路由 → 404）
    lai.st = null;
  }
}

export async function actLocalAi(fn: () => Promise<LocalAiStatus>) {
  if (lai.busy) return;
  lai.busy = true;
  haptic("light");
  try {
    const st = await fn();
    if ((st.engine ?? "qwen") === lai.engine) lai.st = st; // 等启停时切去看了另一台：别把这台的结果写过去
    lai.err = "";
  } catch (e) {
    lai.err = (e as Error).message;
  } finally {
    lai.busy = false;
  }
}

// st===null 且报错（旧后端没这条路由）时面板照常能开，显示「状态不可用」
export function localAiState(): "on" | "starting" | "off" {
  return (lai.st?.state as "on" | "starting" | "off" | undefined) ?? "off";
}

// Strata 在跑的变体不是这个会话选的（认得出才算）：回在跑的那个，否则 null
export function localAiMismatch(): StrataVariantStatus | null {
  const st = lai.st;
  if (!st?.process || !st.variant || !st.runningVariant || st.runningVariant === st.variant) return null;
  return st.variants?.find((v) => v.id === st.runningVariant) ?? null;
}
export function variantInfo(id: string | null | undefined): StrataVariantStatus | undefined {
  return id ? lai.st?.variants?.find((v) => v.id === id) : undefined;
}

export function localAiStateText(): string {
  const s = localAiState();
  return lai.err && !lai.st
    ? t("状态不可用")
    : localAiMismatch()
      ? t("变体不符")
      : s === "on"
        ? t("运行中")
        : s === "starting"
          ? t("加载中")
          : t("未运行");
}

// 换一台看：清掉上一台的状态与显存，免得面板先闪一下另一台的数字。model：会话的型号（Strata 那台按它问变体）。
// 不带 model（面板顶上切引擎、宿主点名看某一台）= 会话没变，lai.model 原样留着：切去看 Qwen 再切回来，启动的仍是会话选的变体
// （看 Qwen 时它不起作用，api.ts 的 eq() 只在 strata 那台带型号）。带了不是 Strata 的型号 = 会话用的就是 Qwen，才清掉。
export function setLocalEngine(engine: LocalEngine, model?: string) {
  const m = isStrataModel(model) ? model : model === undefined ? lai.model : undefined;
  if (lai.engine === engine && lai.model === m) return;
  const sameEngine = lai.engine === engine;
  lai.engine = engine;
  lai.model = m;
  if (!sameEngine) {
    lai.st = null;
    lai.gpu = null;
  }
  lai.err = "";
  void refreshLocalAi();
}
