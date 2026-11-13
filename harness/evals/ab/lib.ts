// Q6（N46）：A/B 评测台的零件。两臂 = 两棵工作树（各自的 harness），每臂起一个 harness 进程，所有落盘目录都指到这一臂的
// 临时根（不碰任何真数据），令牌由 runner 自己生成注入；每个 run 把陷阱现场摆进新目录，经公开接口设工作区、POST /api/run，
// 跑完读这一臂的会话记录打分（统计复用 server/session-health.ts）。基础设施失败（起不来、接口报错）抛 InfraError，不入账。
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sseEvents } from "../../server/headless-client.ts";
import { memoryDirKey } from "../../server/memory.ts";
import { killProcessTree } from "../../server/proc-tree.ts";
import { sessionStats } from "../../server/session-health.ts";
import type { PersistedSession } from "../../server/store.ts";
import { newTally, observe, type RunMetrics, runMetrics, type StreamTally } from "./metrics.ts";
import { snapshotStyles, styleFlips } from "./eol.ts";
import { recordSignals, type RecordSignals } from "./signals.ts";
import type { AbTask } from "./tasks.ts";

export class InfraError extends Error {}
// 这一臂整个跑不了（key 无效 / 欠费 / 没 key）：再跑多少次都一样，矩阵收到就停掉这一臂、不入账
export class ArmFatalError extends InfraError {}
// provider 报错收场（key、额度、5xx、空回包、网关超时）不是模型的成绩：不入账，续跑时重来
const FATAL_OUTCOME = /http_40[123]\b|API key 无效|欠费|额度用完|no API key|缺 ?Key|invalid_authentication|insufficient[_ ]?(quota|balance)/i;
export function providerFailure(outcome: string): "fatal" | "transient" | null {
  if (!outcome.startsWith("error:")) return null;
  return FATAL_OUTCOME.test(outcome) ? "fatal" : "transient";
}

const TOKEN_HEADER = "x-dimensio-internal-token";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Arm {
  name: string;
  port: number;
  token: string;
  root: string;
  sessionsDir: string;
  logFile: string;
  child: ChildProcess;
  stop(): Promise<void>;
}

export interface ArmOptions {
  name: string;
  harnessDir: string; // 某棵工作树的 harness 目录
  port: number;
  root: string; // 这一臂的临时根：所有落盘目录都在它下面
  envFile?: string; // 这一臂读 key 的 .env（本机模型不需要）
  extraEnv?: Record<string, string>;
}

// 评测臂里模型的命令（Bash 子进程）要看到的隔离变量：子进程环境是白名单（server/tools/bash.ts 的 CHILD_ENV_BASE），
// 不在名单里的变量设了也到不了子进程，要经 DIMENSIO_CHILD_ENV_ALLOW 点名放行。
export const CHILD_ISOLATION_VARS = ["npm_config_prefix", "npm_config_cache", "PIP_REQUIRE_VIRTUALENV", "PYTHONUSERBASE"] as const;

// 这一臂 harness 进程的环境（纯函数，自检直接核对它）。所有落盘位置都在 root 下。
export function armEnv({ port, root, envFile, extraEnv = {} }: Pick<ArmOptions, "port" | "root" | "envFile" | "extraEnv">, token: string): NodeJS.ProcessEnv {
  const dir = (sub: string) => {
    const p = path.join(root, sub);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORT: String(port),
    DIMENSIO_INTERNAL_TOKEN: token,
    SESSIONS_DIR: dir("sessions"),
    MEMORY_DIR: dir("memory"),
    KNOWLEDGE_DIR: dir("knowledge"),
    DIMENSIO_CONFIG_FILE: path.join(root, "runtime-config.json"),
    DIMENSIO_QUICK_FILE: path.join(root, "quick.json"),
    DIMENSIO_QUICK_ROOT: dir("quick"),
    PROJECTS_FILE: path.join(root, "projects.json"),
    PROJECTS_ROOT: dir("projects"),
    WORKSPACE_DIR: dir("workspace"),
    DIMENSIO_GLOBAL_GUIDE: path.join(root, "GUIDE.md"),
    HARNESS_ENV_FILE: envFile ?? path.join(root, "no.env"),
    // 模型档案 P0：其余默认落在「数据目录」里的（浏览器配置档、自定义服务目录……）也进临时根；自定义服务要用真的，
    // 由调用方把正式服目录的副本经 DIMENSIO_CUSTOM_PROVIDERS_DIR 传进来（extraEnv 优先）。
    DIMENSIO_DATA_DIR: root,
    DIMENSIO_BROWSER_PROFILE: path.join(root, "browser-profile"),
    // （以前的用法是在 shell 里设好这个变量再跑，照样认）
    DIMENSIO_CUSTOM_PROVIDERS_DIR: process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR?.trim() || dir("custom-providers"),
    // 子进程的家目录（HOME / APPDATA，npm -g 与 pip --user 的默认落点）和 $WORKSPACE_TMP 草稿目录：不改道就和 8799 共用
    // %TEMP%/dimensio-child-home、%TEMP%/dimensio-scratch。草稿目录只能按臂分（变量是进程级的），同一臂并发的题仍共用这一个。
    DIMENSIO_CHILD_HOME: dir("child-home"),
    DIMENSIO_SCRATCH_DIR: dir("scratch"),
    // 评测臂一律「仅工作空间」；再兜一层：npm 全局安装落进临时根、pip 不许装进系统 Python（真要装只能在虚拟环境里）
    SANDBOX_ACCESS: "workspace",
    npm_config_prefix: path.join(root, "npm-global"),
    npm_config_cache: path.join(root, "npm-cache"),
    PIP_REQUIRE_VIRTUALENV: "true",
    PYTHONUSERBASE: path.join(root, "python-user"),
    // 全局层记忆按工作区（= 每次运行的 runDir）各一份：同一臂并发 / 重复的题互相看不见对方写的全局记忆（server/memory.ts
    // globalMemoryFor）。不认这个开关的老代码当一臂时全局层仍是共用的，见 runMemoryView。
    DIMENSIO_GLOBAL_MEMORY_SCOPE: "workspace",
    ...extraEnv,
  };
  // 放行名单与继承来的、调用方给的合并，不覆盖
  const allow = new Set([process.env.DIMENSIO_CHILD_ENV_ALLOW, extraEnv.DIMENSIO_CHILD_ENV_ALLOW].flatMap((v) => (v ?? "").split(",")).map((n) => n.trim()).filter(Boolean));
  for (const name of CHILD_ISOLATION_VARS) allow.add(name);
  env.DIMENSIO_CHILD_ENV_ALLOW = [...allow].join(",");
  return env;
}

export async function startArm({ name, harnessDir, port, root, envFile, extraEnv = {} }: ArmOptions): Promise<Arm> {
  // 下面这些环境变量能把全部落盘位置改道进临时根，前提是这棵树有 Q8 的数据路径收口（server/paths.ts）。更早的代码
  // 有的位置不认环境变量（设工作区就会写 runtime-config），拿它当一臂会写进真数据——直接拒绝。
  if (!fs.existsSync(path.join(harnessDir, "server", "paths.ts"))) {
    throw new Error(`${name}: ${harnessDir} 没有 server/paths.ts（Q8 之前的代码），落盘位置改道不全，不能拿来当评测的一臂`);
  }
  const token = randomBytes(24).toString("base64url");
  const env = armEnv({ port, root, envFile, extraEnv }, token);
  const logFile = path.join(root, "server.log");
  const out = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, ["server/index.ts"], { cwd: harnessDir, env, stdio: ["ignore", out, out], windowsHide: true });
  fs.closeSync(out);
  const arm: Arm = {
    name,
    port,
    token,
    root,
    sessionsDir: env.SESSIONS_DIR!,
    logFile,
    child,
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      // 收尸后等 Node 真看到它退出（最多 10s），再让调用方删临时目录。兜底定时器要清掉，否则白白拖住事件循环 10s。
      let timer: NodeJS.Timeout | undefined;
      const exited = new Promise<void>((r) => {
        child.once("exit", () => r());
        timer = setTimeout(r, 10_000);
      });
      await killProcessTree(child.pid!, child).catch(() => child.kill("SIGKILL"));
      await exited;
      clearTimeout(timer);
    },
  };
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new InfraError(`${name}: harness exited during startup (code ${child.exitCode}); see ${logFile}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/busy`, { headers: { [TOKEN_HEADER]: token } });
      if (res.ok) return arm;
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  await arm.stop();
  throw new InfraError(`${name}: harness did not come up on :${port} within 45s; see ${logFile}`);
}

export async function api(arm: Arm, method: string, route: string, body?: unknown): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${arm.port}${route}`, {
      method,
      headers: { [TOKEN_HEADER]: arm.token, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new InfraError(`${arm.name}: ${method} ${route} failed: ${(e as Error).message}`);
  }
  if (!res.ok) throw new InfraError(`${arm.name}: ${method} ${route} → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res;
}

// ── 思考档位：不写 @档位 时显式用这台型号的默认档 ─────────────────────────────
// POST /api/config 点名了 model 时服务端不重算默认档（server/config.ts：只有没点名型号才 snap 到默认），档位会沿用起臂前
// 的全局值、再收敛到这台型号支持的档——冒烟时型号目录写 medium，实际跑成了 low。所以评测侧自己照目录算默认档、显式传，
// 设完再核对。规则与 server/catalog.ts 的 defaultEffort 一致：目录给的默认档 → high → low → 第一档；目录里没有这台型号按 ["off"]。
interface CatalogModel {
  id: string;
  efforts?: string[];
  defaultEffort?: string;
  aliases?: string[]; // 目录别名（旧 id，如 strata-orca）
}
export function catalogDefaultEffort(catalog: { id: string; models?: CatalogModel[] }[], provider: string, model: string): string {
  const models = catalog.find((p) => p.id === provider)?.models;
  const spec = models?.find((m) => m.id === model) ?? models?.find((m) => m.aliases?.includes(model));
  const efforts = spec?.efforts?.length ? spec.efforts : ["off"];
  if (spec?.defaultEffort && efforts.includes(spec.defaultEffort)) return spec.defaultEffort;
  if (efforts.includes("high")) return "high";
  if (efforts.includes("low")) return "low";
  return efforts[0];
}

// 这一臂要跑的档位：点名了就用点名的，没点名就经这一臂的 /api/info 查默认档（自定义服务的目录只有这一臂进程里有）
export async function wantedEffort(arm: Arm, provider: string, model: string, named?: string): Promise<string> {
  if (named) return named;
  const info = (await (await api(arm, "GET", "/api/info")).json()) as { catalog?: { id: string; models?: CatalogModel[] }[] };
  return catalogDefaultEffort(info.catalog ?? [], provider, model);
}

// 设完配置核对：provider / 型号 / 档位任何一项和期望不同就中止（宁可不跑，也不拿错的档位出收据）
export function assertArmConfig(name: string, want: { provider: string; model: string; thinking: string }, got: { provider?: string; model?: string; thinking?: string }): void {
  for (const key of ["provider", "model", "thinking"] as const) {
    if (got[key] !== want[key]) throw new Error(`${name}：设完配置 ${key} 是 ${String(got[key])}，期望 ${want[key]}（档位不被这台型号支持，或型号不在目录里）——中止`);
  }
}

interface RunStream {
  sessionId: string | null;
  tail: string;
  outcome: string;
  counts: Record<string, number>;
}

// 读 /api/run 的 SSE 直到收场；返回 sessionId、事件计数与最后一段正文（报表里给 <100% 的格子附末尾输出）。
// M15（X35）：SSE 解析与 headless 客户端共用一份（server/headless-client.ts）
// 模型档案 P0：tally 给了就顺带记工具成败、错误类别、用量与收场原因（见 metrics.ts）
async function readRun(res: Response, tally?: StreamTally): Promise<RunStream> {
  const run: RunStream = { sessionId: null, tail: "", outcome: "unknown", counts: {} };
  if (!res.body) return run;
  for await (const raw of sseEvents(res.body as unknown as AsyncIterable<Uint8Array>)) {
    const ev = raw as { e?: string; sessionId?: string; text?: string; message?: string };
    const kind = String(ev.e);
    run.counts[kind] = (run.counts[kind] ?? 0) + 1;
    if (tally) observe(tally, raw as Record<string, unknown>);
    if (kind === "session") run.sessionId = ev.sessionId ?? null;
    else if (kind === "turn_start") run.tail = "";
    else if (kind === "text_delta") run.tail += ev.text ?? "";
    else if (kind === "done") run.outcome = "done";
    else if (kind === "error") run.outcome = `error: ${String(ev.message ?? "").slice(0, 200)}`;
  }
  run.tail = run.tail.slice(-600);
  return run;
}

// 一轮结束时服务端先通知观察者、再做最后一次落盘：先等 /status 说不跑了，再等文件的修改时间稳定下来才读。
async function settledRecord(arm: Arm, sessionId: string): Promise<PersistedSession> {
  const file = path.join(arm.sessionsDir, `${sessionId}.json`);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const st = (await (await api(arm, "GET", `/api/sessions/${sessionId}/status`)).json()) as { running?: boolean };
    if (!st.running) break;
    await sleep(200);
  }
  let last = -1;
  let stableSince = 0;
  while (Date.now() < deadline) {
    const m = fs.existsSync(file) ? fs.statSync(file).mtimeMs : -1;
    if (m !== last) {
      last = m;
      stableSince = Date.now();
    } else if (m >= 0 && Date.now() - stableSince >= 500) {
      try {
        return JSON.parse(fs.readFileSync(file, "utf8")) as PersistedSession;
      } catch {
        /* 正好撞上替换，再等一轮 */
      }
    }
    await sleep(100);
  }
  throw new InfraError(`${arm.name}: session record ${sessionId} never settled`);
}

// 记忆沉淀还在后台跑就等它（最多 3 分钟）；返回「等过」——等过就要重读记录（用量账本多了一笔）
async function memorySettled(arm: Arm, sessionId: string): Promise<boolean> {
  const deadline = Date.now() + 180_000;
  let waited = false;
  while (Date.now() < deadline) {
    const st = (await (await api(arm, "GET", `/api/sessions/${sessionId}/status`)).json()) as { memoryPending?: boolean };
    if (!st.memoryPending) return waited;
    waited = true;
    await sleep(500);
  }
  throw new InfraError(`${arm.name}: memory filing for ${sessionId} never settled`);
}

// 成本按会话用量账本的全部任务合计（主循环 + 子 agent + 压缩摘要 + 记忆沉淀）——瘦身前把审计算在主循环里，瘦身后挪到
// 旁路，只算主循环就不公平。老记录没有账本就只算主循环。
function allTokens(rec: PersistedSession, main: number): number {
  const rows = Object.values((rec as { usage?: Record<string, { input?: number; output?: number }> }).usage ?? {});
  return rows.length ? rows.reduce((n, r) => n + (r.input ?? 0) + (r.output ?? 0), 0) : main;
}

export interface RunRow {
  task: string;
  arm: string;
  rep: number;
  pass: boolean;
  detail: string;
  outcome: string;
  turns: number;
  toolCalls: number;
  failedCalls: number;
  nudges: number;
  lastVerification: string;
  tokens: number;
  wallMs: number;
  // 模型档案 P0：只算各条消息的流（发出到收场）的时间；wallMs 还含每条之后等记录落定、等记忆沉淀（多轮题会偏大）
  activeMs?: number;
  tail: string;
  // 档位：这一次实际跑的思考档位（老账本没有）
  effort?: string;
  // 模型档案 P0（矩阵模式）：这一臂的型号、题目维度、细项指标；claimedDone = 模型自己收的工（正常收场、没撞预算），
  // 和 pass 一起看就是「自称完成但判分失败」。老账本没有这几项。
  provider?: string;
  model?: string;
  dimension?: string;
  claimedDone?: boolean;
  m?: RunMetrics;
  // 模型档案阶段 1：适配信号（与转录回放同一口径，signals.ts）；eolFlips = 题目摆好的文件里换行风格 / BOM 被改掉的（eol.ts）
  sig?: RecordSignals;
  eolFlips?: string[];
}

export interface ProviderChoice {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  thinking?: string; // 思考档位；不给就用这家型号的默认档
}

export interface RunOptions {
  runDir: string;
  provider: ProviderChoice;
  rep?: number;
  // 同一臂里并发跑多题：全局配置由调用方在起臂后设一次（provider / 型号 / 档位 / 权限规则），这里不再逐题 POST /api/config——
  // 那是全局的，并发时会互相踩。工作区、访问范围、权限档逐会话经 /api/run 的配置快照（M11）带上。
  concurrent?: boolean;
}

// 发一条消息并读完它的流；流读到一半连接被重置（undici 报 TypeError: terminated）也是基础设施失败：这次不入账、原样重跑会补上。
// 以前它不是 InfraError，被 run.ts 当成未知错误抛出去，整批评测连同两个臂一起停了（09-24 R15 那批跑到 24/36 时）。
async function sendMessage(arm: Arm, body: Record<string, unknown>, tally: StreamTally): Promise<RunStream> {
  const res = await api(arm, "POST", "/api/run", body);
  try {
    return await readRun(res, tally);
  } catch (e) {
    throw new InfraError(`${arm.name}: /api/run stream broke: ${(e as Error).message}`);
  }
}

// 判分用的记忆视图：只含这次运行自己写的记忆，布局同记忆目录——workspaces/<键>/（它工作区的那份）与 global/（它自己那份
// 全局层，armEnv 打开的 DIMENSIO_GLOBAL_MEMORY_SCOPE 下在 global-scoped/<键>/）。以前判分扫整臂的记忆根，同一道「记住偏好」
// 的题第 2 次重复会因为第 1 次写过而判过、别的题写的全局记忆也算数。
// 臂是不认那个开关的老代码时全局层只有共用的 <记忆根>/global 一份，分不开——原样放进视图的 global-shared/（照旧会串）。
// 拷一份而不是给原目录：判分在记录与记忆沉淀都落定之后，拷的就是终态；视图每次重建。
export function runMemoryView(memoryRoot: string, runDir: string, viewsRoot: string): string {
  const key = memoryDirKey(runDir);
  const view = path.join(viewsRoot, key);
  fs.rmSync(view, { recursive: true, force: true });
  fs.mkdirSync(view, { recursive: true });
  const parts: Array<[from: string, to: string]> = [
    [path.join(memoryRoot, "workspaces", key), path.join(view, "workspaces", key)],
    [path.join(memoryRoot, "global-scoped", key), path.join(view, "global")],
    [path.join(memoryRoot, "global"), path.join(view, "global-shared")],
  ];
  for (const [from, to] of parts) if (fs.existsSync(from)) fs.cpSync(from, to, { recursive: true });
  return view;
}

export function clearRunMemory(memoryRoot: string, runDir: string): void {
  const key = memoryDirKey(runDir);
  for (const dir of [path.join(memoryRoot, "workspaces", key), path.join(memoryRoot, "global-scoped", key)]) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// 跑一个任务的一次：现场摆进 runDir → 设工作区与 provider → 发消息（多轮题在同一会话里接着发）→ 读会话记录打分。
export async function runTask(arm: Arm, task: AbTask, { runDir, provider, rep = 1, concurrent = false }: RunOptions): Promise<RunRow> {
  fs.mkdirSync(runDir, { recursive: true });
  // 同一个 runDir 重跑（基础设施失败后续跑）时，上一次留下的记忆不能算进这一次：清掉这个工作区的两份（工作区层与它的全局层）
  clearRunMemory(path.join(arm.root, "memory"), runDir);
  task.setup(runDir);
  const styles = snapshotStyles(runDir);
  if (!concurrent) {
    const cfg = (await (
      await api(arm, "POST", "/api/config", {
        ...provider,
        workspace: runDir,
        access: "workspace",
        permissionMode: "auto",
        permissionRules: { allow: [], ask: [], ...task.permissionRules },
      })
    ).json()) as { provider?: string; model?: string; thinking?: string };
    // 档位给了就核对（两树模式由 run.ts 先查好默认档再传进来）
    if (provider.thinking) assertArmConfig(arm.name, { provider: provider.provider, model: provider.model, thinking: provider.thinking }, cfg);
  }
  // 新会话的配置快照：只带工作区 / 访问范围 / 权限档——带 provider 会把 baseUrl 重置成这家的默认地址（假 provider 就连不上了）
  const snapshot = { workspace: runDir, access: "workspace", permissionMode: "auto" };
  const budget = { deadlineMs: task.deadlineMs, maxTurns: task.maxTurns };
  const tally = newTally();
  const messages = [task.prompt, ...(task.followups ?? [])];
  const started = Date.now();
  let sessionId: string | null = null;
  let run: RunStream | null = null;
  let rec: PersistedSession | null = null;
  let sent = 0;
  let activeMs = 0;
  for (const message of messages) {
    const t0 = Date.now();
    run = await sendMessage(arm, { message, ...budget, ...(sessionId ? { sessionId } : { config: snapshot }) }, tally);
    activeMs += Date.now() - t0;
    sent++;
    if (!run.sessionId) throw new InfraError(`${arm.name}: /api/run never announced a session`);
    sessionId = run.sessionId;
    rec = await settledRecord(arm, sessionId);
    // 瘦身 P0-1：收尾后的记忆沉淀在后台跑（状态接口报 memoryPending）——等它落定再读记录与记忆（老代码不报这个字段，不等）
    if (await memorySettled(arm, sessionId)) rec = await settledRecord(arm, sessionId);
    // 这一条就出错收场了（provider 报错、被中断）：后面依赖它的消息没意义，按这一条的结果判
    if (run.outcome !== "done") break;
  }
  const failure = providerFailure(String(run!.outcome ?? ""));
  if (failure === "fatal") throw new ArmFatalError(`${arm.name}: ${String(run!.outcome).slice(0, 200)}`);
  if (failure === "transient") throw new InfraError(`${arm.name}: provider 报错收场（不算模型成绩）：${String(run!.outcome).slice(0, 160)}`);
  const wallMs = Date.now() - started;
  const verdict = task.check(runDir, rec!, { memoryDir: runMemoryView(path.join(arm.root, "memory"), runDir, path.join(arm.root, "check-memory")) });
  const s = sessionStats(rec!).observed;
  const calls = Object.values(s.toolCalls).reduce((n, t) => n + t.calls, 0);
  const failed = Object.values(s.toolCalls).reduce((n, t) => n + t.failed, 0);
  const nudges = Object.entries(s.injections).filter(([k]) => k.endsWith("nudge")).reduce((n, [, v]) => n + v, 0);
  const m = runMetrics(rec!, tally, sent);
  return {
    task: task.id,
    arm: arm.name,
    rep,
    pass: Boolean(verdict.pass),
    detail: verdict.detail ?? "",
    outcome: run!.outcome,
    turns: s.assistantTurns,
    toolCalls: calls,
    failedCalls: failed,
    nudges,
    lastVerification: rec!.gates?.lastVerification ?? "",
    tokens: allTokens(rec!, s.tokens.input + s.tokens.output),
    wallMs,
    activeMs,
    tail: run!.tail,
    ...(provider.thinking ? { effort: provider.thinking } : {}),
    provider: provider.provider,
    model: provider.model,
    dimension: task.dimension,
    claimedDone: run!.outcome === "done" && sent === messages.length && !m.budgetExhausted && m.stopReason === "end",
    m,
    sig: recordSignals(rec!),
    eolFlips: styleFlips(runDir, styles),
  };
}

// ── 续跑账本（meta.jsonl）与报表 ────────────────────────────────────────────
export const runKey = (row: Pick<RunRow, "task" | "arm" | "rep">) => `${row.task}|${row.arm}|${row.rep}`;

export function readMeta(file: string): RunRow[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as RunRow);
}

export function appendMeta(file: string, row: RunRow): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(row) + "\n");
}

const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "—");
const avg = (xs: number[]) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

// 决策收据：任务 × 臂的通过率与均值；低于 100% 的格子附逐 run 的判分细节与末尾输出（n=3 只看方向，必须逐 run 审）。
export function report(rows: RunRow[], { title, arms, note = "" }: { title: string; arms: string[]; note?: string }): string {
  const tasks = [...new Set(rows.map((r) => r.task))];
  const lines = [
    `# ${title}`,
    "",
    note,
    "",
    `| 任务 | ${arms.map((a) => `${a} 通过`).join(" | ")} | ${arms.map((a) => `${a} 轮数/工具/失败/追问`).join(" | ")} |`,
    `|---|${arms.map(() => "---").join("|")}|${arms.map(() => "---").join("|")}|`,
  ];
  for (const task of tasks) {
    const cells = arms.map((arm) => {
      const rs = rows.filter((r) => r.task === task && r.arm === arm);
      const passed = rs.filter((r) => r.pass).length;
      return `${passed}/${rs.length}（${pct(passed, rs.length)}）`;
    });
    const means = arms.map((arm) => {
      const rs = rows.filter((r) => r.task === task && r.arm === arm);
      return `${avg(rs.map((r) => r.turns))} / ${avg(rs.map((r) => r.toolCalls))} / ${avg(rs.map((r) => r.failedCalls))} / ${avg(rs.map((r) => r.nudges))}`;
    });
    lines.push(`| ${task} | ${cells.join(" | ")} | ${means.join(" | ")} |`);
  }
  // 成本：通过率打平时，花了多少 token、多长时间就是剩下的信号（上下文类改动常常只动这一栏）
  lines.push("", "## 成本（每次的均值）", "", `| 任务 | ${arms.map((a) => `${a} token`).join(" | ")} | ${arms.map((a) => `${a} 耗时`).join(" | ")} |`);
  lines.push(`|---|${arms.map(() => "---").join("|")}|${arms.map(() => "---").join("|")}|`);
  const sumTokens = arms.map(() => 0);
  const sumWall = arms.map(() => 0);
  for (const task of tasks) {
    const cost = arms.map((arm, i) => {
      const rs = rows.filter((r) => r.task === task && r.arm === arm);
      const tokens = avg(rs.map((r) => r.tokens));
      const wall = avg(rs.map((r) => r.wallMs));
      sumTokens[i] += tokens;
      sumWall[i] += wall;
      return { tokens, wall };
    });
    lines.push(`| ${task} | ${cost.map((c) => `${Math.round(c.tokens / 1000)}k`).join(" | ")} | ${cost.map((c) => `${Math.round(c.wall / 1000)}s`).join(" | ")} |`);
  }
  lines.push(`| 合计 | ${sumTokens.map((t) => `${Math.round(t / 1000)}k`).join(" | ")} | ${sumWall.map((w) => `${Math.round(w / 1000)}s`).join(" | ")} |`);

  const misses = rows.filter((r) => !r.pass);
  if (misses.length) {
    lines.push("", "## 没通过的 run（逐条审）", "");
    for (const r of misses) {
      lines.push(`- **${r.task} · ${r.arm} · 第 ${r.rep} 次**：${r.detail}；收场 ${r.outcome}；轮数 ${r.turns}，工具 ${r.toolCalls}（失败 ${r.failedCalls}），追问 ${r.nudges}，${Math.round(r.wallMs / 1000)}s`);
      if (r.tail) lines.push(`  > ${r.tail.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }
  return lines.join("\n") + "\n";
}
