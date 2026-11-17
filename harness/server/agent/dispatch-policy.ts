// dimensio 的子 agent 调用策略：从 bridge 取「这个实例此刻生效的那份」（bridge 设置 › dimensio › 子 agent 调用策略：
// 跟随 Claude 那份，或 dimensio 单独一套；存储与解析都在 bridge，见 src/runtime/dispatch-policy.mjs 与 src/runtime/dispatch-dimensio.mjs）。
//
//   POST {BRIDGE_PLUGIN_API}/api/internal/dispatch-policy { chart, legacy }（同机实例凭据，与 bridge-events.ts 同一条通道）
//     → { ok, policy:{ enabled, follow, scope:{ workflow, subagent, session }, allowThirdParty, strategy }, chart:{ key, ratings? } }
//   legacy = 这台 dimensio 旧的两项偏好（按难度选型阶梯开关、子 agent 调度偏好文本）：bridge 那边 dimensio 那份还没落过盘时迁一次。
//   chart  = 手里那份导入的性价比图数据的版本键；对不上 bridge 才把全量带回来（没导入过 = builtin，用经 core-link 读的内置快照）。
//
// 取用：系统提示是同步拼的，只读缓存（currentDispatchPolicy，顺手在过期时后台刷新）；auto:<档> 派发前 await 一次刷新（缓存还新就不发请求）。
// 15 秒内算新；bridge 正在重启这类一时取不到的，沿用上一次取到的（10 分钟内），免得一闪断就换了一套规则、把系统提示前缀冲掉；
// bridge 太旧没有这个接口（404）、不认凭据（401 / 403）、或者这个 dimensio 不是 bridge 拉起的 → null：一切照改造前（偏好 subagentLadder /
// subagentDispatch 说了算，见 dispatch-ladder.ts）。bridge 推「策略变了」时（/api/dispatch/refresh）当场作废缓存。
import { prefValue } from "../prefs.ts";
import { inTestProcess } from "../paths.ts";
import type { RatingsSnapshot } from "../model-knowledge.ts";

export type TierKey = "top" | "hard" | "normal" | "light";
const TIER_KEYS: TierKey[] = ["top", "hard", "normal", "light"];

/** 档位自定义的可携写法：provider 有 = 优先那一家；model 是型号 id（Claude 别名已换成它此刻指向的型号）；effort '' = 型号默认。 */
export interface PortableOverride {
  model: string;
  effort: string;
  provider?: string;
  ref?: string;
}
export interface PolicyStrategy {
  id?: string;
  name?: string;
  from?: "claude" | "dimensio";
  floors: Partial<Record<TierKey, number | null>>;
  overrides: Partial<Record<TierKey, PortableOverride | null>>;
  note: string;
}
export interface DimPolicy {
  enabled: boolean;
  follow: boolean;
  scope: { workflow: boolean; subagent: boolean; session: boolean };
  allowThirdParty: boolean;
  strategy: PolicyStrategy | null;
}

const FRESH_MS = 15_000;
const STALE_MS = 10 * 60_000;
const TIMEOUT_MS = 2_500;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\]):\d+$/;

function channel(): { api: string; secret: string } | null {
  const api = String(process.env.BRIDGE_PLUGIN_API ?? "").trim().replace(/\/+$/, "");
  const secret = String(process.env.BRIDGE_PLUGIN_SECRET ?? "").trim();
  return LOOPBACK.test(api) && secret.length >= 16 ? { api, secret } : null;
}

// ── 规范化（bridge 给的照理是好的，这里防一手：坏字段回默认，不抛）──────────────────────
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
function cleanOverride(v: unknown): PortableOverride | null {
  if (!isObj(v) || typeof v.model !== "string" || !v.model.trim()) return null;
  return {
    model: v.model.trim(),
    effort: typeof v.effort === "string" ? v.effort.trim() : "",
    ...(typeof v.provider === "string" && v.provider ? { provider: v.provider } : {}),
    ...(typeof v.ref === "string" && v.ref ? { ref: v.ref } : {}),
  };
}
/** 一套策略（可携写法）的宽松规范化：坏字段回默认、不抛；不是对象 → null。 */
export function cleanStrategy(v: unknown): PolicyStrategy | null {
  if (!isObj(v)) return null;
  const floors: PolicyStrategy["floors"] = {};
  const overrides: PolicyStrategy["overrides"] = {};
  const f = isObj(v.floors) ? v.floors : {};
  const o = isObj(v.overrides) ? v.overrides : {};
  for (const k of TIER_KEYS) {
    const x = f[k];
    floors[k] = typeof x === "number" && Number.isFinite(x) && x >= 0 && x <= 100 ? x : null;
    overrides[k] = cleanOverride(o[k]);
  }
  return {
    ...(typeof v.id === "string" ? { id: v.id } : {}),
    ...(typeof v.name === "string" ? { name: v.name } : {}),
    ...(v.from === "claude" || v.from === "dimensio" ? { from: v.from } : {}),
    floors, overrides, note: typeof v.note === "string" ? v.note.slice(0, 4000) : "",
  };
}
/** bridge 给的生效策略 → DimPolicy；形状不对 → null。 */
export function cleanDispatchPolicy(v: unknown): DimPolicy | null {
  if (!isObj(v)) return null;
  const sc = isObj(v.scope) ? v.scope : {};
  return {
    enabled: v.enabled !== false,
    follow: v.follow === true,
    scope: { workflow: sc.workflow !== false, subagent: sc.subagent !== false, session: sc.session === true },
    allowThirdParty: v.allowThirdParty !== false,
    strategy: cleanStrategy(v.strategy),
  };
}

// ── 缓存 ────────────────────────────────────────────────────────────────────
let policy: DimPolicy | null = null;
let goodAt = 0; // 上一次真取到的时刻
let triedAt = 0; // 上一次去取（成没成都算）
let chart: { key: string; ratings: RatingsSnapshot | null } = { key: "", ratings: null };
let inflight: Promise<void> | null = null;
let testPolicy: DimPolicy | null | undefined; // 测试指定（undefined = 不覆盖）
let testFetch: typeof fetch | null = null;

/** 测试用：指定生效策略（null = 当作取不到；undefined = 回到正常来源，清缓存）。 */
export function setDispatchPolicyForTests(p: DimPolicy | null | undefined): void {
  testPolicy = p;
  policy = null;
  goodAt = triedAt = 0;
  chart = { key: "", ratings: null };
}
/** 测试用：换掉网络这一层（null = 回到真 fetch）。keep = 留着已经取到的缓存（测「一时取不到沿用上一次」）。 */
export function setDispatchFetchForTests(fn: typeof fetch | null, { keep = false }: { keep?: boolean } = {}): void {
  testFetch = fn;
  if (keep) return;
  policy = null;
  goodAt = triedAt = 0;
  chart = { key: "", ratings: null };
}

/** 作废缓存（bridge 推来「策略变了」时）：下一次取用就重新问。 */
export function invalidateDispatchPolicy(): void {
  triedAt = 0;
}

async function pull(): Promise<void> {
  const ch = channel();
  if (!ch) {
    policy = null;
    triedAt = Date.now();
    return;
  }
  triedAt = Date.now();
  const doFetch = testFetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(ch.api + "/api/internal/dispatch-policy", {
      method: "POST",
      headers: { Authorization: `Bearer ${ch.secret}`, "Content-Type": "application/json", "X-Bridge-Agent": "dimensio" },
      body: JSON.stringify({
        chart: chart.key,
        legacy: { ladder: prefValue<boolean>("subagentLadder"), note: String(prefValue<string>("subagentDispatch") ?? "") },
      }),
      redirect: "error", // 凭据只发给这一个地址
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    if (Date.now() - goodAt > STALE_MS) policy = null; // 一时取不到：上一次的还不太旧就接着用
    return;
  }
  // 太旧的 bridge（没有这个接口）、不认凭据：不是一时的，当没有
  if (res.status === 404 || res.status === 401 || res.status === 403) {
    policy = null;
    goodAt = 0;
    return;
  }
  let j: Record<string, unknown> | null = null;
  try {
    j = (await res.json()) as Record<string, unknown>;
  } catch {
    /* 下面按坏应答处理 */
  }
  const p = res.ok && j && j.ok === true ? cleanDispatchPolicy(j.policy) : null;
  if (!p) {
    if (Date.now() - goodAt > STALE_MS) policy = null;
    return;
  }
  policy = p;
  goodAt = Date.now();
  const c = isObj(j!.chart) ? j!.chart : null;
  if (c && typeof c.key === "string" && c.key !== chart.key) {
    const r = isObj(c.ratings) && Array.isArray((c.ratings as { models?: unknown }).models) ? (c.ratings as unknown as RatingsSnapshot) : null;
    // 版本换了：导入的那份要带着全量来（没带就当内置快照）；回到 builtin = 不用导入的
    chart = { key: c.key, ratings: c.key === "builtin" ? null : r };
  }
}

/** 刷新一次（缓存比 maxAgeMs 还新就不发请求；同一时刻只有一个请求在路上）。永不抛。 */
export async function refreshDispatchPolicy({ maxAgeMs = FRESH_MS }: { maxAgeMs?: number } = {}): Promise<void> {
  if (testPolicy !== undefined) return;
  if (!testFetch && inTestProcess()) return; // 测试进程不去碰真的 bridge（没设覆盖就当取不到）
  if (Date.now() - triedAt < maxAgeMs) return;
  inflight ??= pull().finally(() => {
    inflight = null;
  });
  await inflight;
}

/** 此刻生效的策略（同步，读缓存；过期了顺手后台刷新，这次仍按缓存）。null = 不归 bridge 的策略管，照改造前的偏好。 */
export function currentDispatchPolicy(): DimPolicy | null {
  if (testPolicy !== undefined) return testPolicy;
  if (Date.now() - triedAt >= FRESH_MS) void refreshDispatchPolicy();
  return policy;
}

/** bridge 给的导入性价比图数据（没导入 / 取不到 = null，用内置快照）。 */
export function importedChartRatings(): RatingsSnapshot | null {
  return chart.ratings;
}
