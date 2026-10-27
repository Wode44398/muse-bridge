// Q6（N46）：A/B 评测台的零件。两臂 = 两棵工作树（各自的 harness），每臂起一个 harness 进程，所有落盘目录都指到这一臂的
// 临时根（不碰任何真数据），令牌由 runner 自己生成注入；每个 run 把陷阱现场摆进新目录，经公开接口设工作区、POST /api/run，
// 跑完读这一臂的会话记录打分（统计复用 server/session-health.ts）。基础设施失败（起不来、接口报错）抛 InfraError，不入账。
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sseEvents } from "../../server/headless-client.ts";
import { killProcessTree } from "../../server/proc-tree.ts";
import { sessionStats } from "../../server/session-health.ts";
import type { PersistedSession } from "../../server/store.ts";
import type { AbTask } from "./tasks.ts";

export class InfraError extends Error {}

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

export async function startArm({ name, harnessDir, port, root, envFile, extraEnv = {} }: ArmOptions): Promise<Arm> {
  // 下面这些环境变量能把全部落盘位置改道进临时根，前提是这棵树有 Q8 的数据路径收口（server/paths.ts）。更早的代码
  // 有的位置不认环境变量（设工作区就会写 runtime-config），拿它当一臂会写进真数据——直接拒绝。
  if (!fs.existsSync(path.join(harnessDir, "server", "paths.ts"))) {
    throw new Error(`${name}: ${harnessDir} 没有 server/paths.ts（Q8 之前的代码），落盘位置改道不全，不能拿来当评测的一臂`);
  }
  const dir = (sub: string) => {
    const p = path.join(root, sub);
    fs.mkdirSync(p, { recursive: true });
    return p;
  };
  const token = randomBytes(24).toString("base64url");
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
    ...extraEnv,
  };
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

interface RunStream {
  sessionId: string | null;
  tail: string;
  outcome: string;
  counts: Record<string, number>;
}

// 读 /api/run 的 SSE 直到收场；返回 sessionId、事件计数与最后一段正文（报表里给 <100% 的格子附末尾输出）。
// M15（X35）：SSE 解析与 headless 客户端共用一份（server/headless-client.ts）
async function readRun(res: Response): Promise<RunStream> {
  const run: RunStream = { sessionId: null, tail: "", outcome: "unknown", counts: {} };
  if (!res.body) return run;
  for await (const raw of sseEvents(res.body as unknown as AsyncIterable<Uint8Array>)) {
    const ev = raw as { e?: string; sessionId?: string; text?: string; message?: string };
    const kind = String(ev.e);
    run.counts[kind] = (run.counts[kind] ?? 0) + 1;
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
  tail: string;
}

export interface ProviderChoice {
  provider: string;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  thinking?: string; // 思考档位；不给就用这家型号的默认档
}

// 跑一个任务的一次：现场摆进 runDir → 设工作区与 provider → 发消息 → 读会话记录打分。
export async function runTask(arm: Arm, task: AbTask, { runDir, provider, rep = 1 }: { runDir: string; provider: ProviderChoice; rep?: number }): Promise<RunRow> {
  fs.mkdirSync(runDir, { recursive: true });
  task.setup(runDir);
  await api(arm, "POST", "/api/config", { ...provider, workspace: runDir, permissionMode: "auto" });
  const started = Date.now();
  const res = await api(arm, "POST", "/api/run", { message: task.prompt, deadlineMs: task.deadlineMs, maxTurns: task.maxTurns });
  // 流读到一半连接被重置（undici 报 TypeError: terminated）也是基础设施失败：这次不入账、原样重跑会补上。
  // 以前它不是 InfraError，被 run.ts 当成未知错误抛出去，整批评测连同两个臂一起停了（09-24 R15 那批跑到 24/36 时）。
  let run: RunStream;
  try {
    run = await readRun(res);
  } catch (e) {
    throw new InfraError(`${arm.name}: /api/run stream broke: ${(e as Error).message}`);
  }
  const wallMs = Date.now() - started;
  if (!run.sessionId) throw new InfraError(`${arm.name}: /api/run never announced a session`);
  let rec = await settledRecord(arm, run.sessionId);
  // 瘦身 P0-1：收尾后的记忆沉淀在后台跑（状态接口报 memoryPending）——等它落定再读记录与记忆（老代码不报这个字段，不等）
  if (await memorySettled(arm, run.sessionId)) rec = await settledRecord(arm, run.sessionId);
  const verdict = task.check(runDir, rec, { memoryDir: path.join(arm.root, "memory") });
  const s = sessionStats(rec).observed;
  const calls = Object.values(s.toolCalls).reduce((n, t) => n + t.calls, 0);
  const failed = Object.values(s.toolCalls).reduce((n, t) => n + t.failed, 0);
  const nudges = Object.entries(s.injections).filter(([k]) => k.endsWith("nudge")).reduce((n, [, v]) => n + v, 0);
  return {
    task: task.id,
    arm: arm.name,
    rep,
    pass: Boolean(verdict.pass),
    detail: verdict.detail ?? "",
    outcome: run.outcome,
    turns: s.assistantTurns,
    toolCalls: calls,
    failedCalls: failed,
    nudges,
    lastVerification: rec.gates?.lastVerification ?? "",
    tokens: allTokens(rec, s.tokens.input + s.tokens.output),
    wallMs,
    tail: run.tail,
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
