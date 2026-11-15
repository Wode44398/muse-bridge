// 定时任务（bridge 的 Routines，2026-11-14）：到点用 dimensio 跑一段指令。
//
// bridge 的 routines-runner.mjs 经 dimensio 扩展的 familyCall 调过来（同机令牌 + x-dimensio-family-call 头，路由在
// family-routes.ts；浏览器经反代进来带不出这个头）：
//   startRoutine  —— 开一个新会话（按任务定的厂商 / 型号 / 思考深度 / 运行档位 / 工作区），或续上次那个会话，起一轮：
//                    任务指令照用户自己写的话落成用户消息，后面跟一条 harness 片段（kind routine）写明「定时触发、无人值守」；
//                    这一轮的 family 来源记 auto——不算真人发话：不替用户开新会话、不清零会话间自动续的计数、不附收件箱
//                    （与 bridge 里 Claude 的定时任务同一语义：那边是 family origin 'routine'）。
//   routineStatus —— bridge 等结局：长轮询，在跑就最多等 waitMs，等到它收尾 / 「在不在等人」变了再答。
// 要人批的卡（权限 / 提问 / 计划）照常停下来等，会话亮「待处理」——与 Claude 的定时任务一致（不替用户开离开模式）。
// 结局按 runId 记在内存里（最近 MAX_KEPT 条）；harness 中途重启过就查不到了 → outcome unknown，bridge 照「中断」记。
import { lastAnswer } from "./bridge-events.ts";
import { sessionConfigSnapshot, type RuntimeConfig } from "./config.ts";
import { mcpReady, syncConnectors } from "./mcp.ts";
import { retiring } from "./retire.ts";
import {
  createSession,
  dropSession,
  getOrLoadSession,
  getSession,
  setSessionMode,
  setSessionModel,
  startRun,
  waitingOf,
  watchGlobal,
  type Session,
} from "./session.ts";
import { lastReport } from "./session-family.ts";

const ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
const MAX_KEPT = 200;
const MAX_WAIT_MS = 25_000;
const TEXT_MAX = 6000;

export type RoutineOutcome = "done" | "error" | "aborted" | "unknown";
export interface RoutineResult {
  outcome: RoutineOutcome;
  text: string;
  // aborted 时谁停的：user = 在会话里按了停止；restart = dimensio 重启切断（它重启后会自动续跑）
  by?: "user" | "restart";
  endedAt: number;
}
interface Tracked {
  sid: string;
  done: Promise<RoutineResult>;
  result?: RoutineResult;
}
const tracked = new Map<string, Tracked>(); // runId -> 这一轮

// 测试可换掉「怎么建新会话」（脚本化 provider 的会话由夹具建）
export const routineHooks: { createSession?: (cfg: RuntimeConfig | undefined) => Session } = {};

// 跟在指令后面的那条说明（给模型看；界面上只显示一行，见 web 的 harnessNotice）。标题里的引号 / 换行收掉，免得冒充别的片段。
export function routineNote(name: string): string {
  const n = String(name ?? "").replace(/[\r\n"]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
  return `[Scheduled task] "${n || "untitled"}" started this turn on its own schedule. Nobody is watching it live and nobody will answer questions while it runs. Do the whole task yourself; when a decision is needed, take the most reasonable default and say what you assumed instead of stopping to ask. Finish with a short summary of the result in bullet points so the user can review it later.`;
}

type StartArgs = {
  sessionId?: string;
  title?: string;
  prompt: string;
  config?: { provider?: string; model?: string; thinking?: string; workspace?: string; permissionMode?: string };
};
export type StartResult = { ok: true; id: string; runId: string } | { ok: false; code: string; error: string };

/** 起一轮定时任务。 */
export async function startRoutine(b: StartArgs): Promise<StartResult> {
  if (retiring()) return { ok: false, code: "retiring", error: "dimensio 正在重启，这次没有运行" };
  const prompt = String(b.prompt ?? "").trim();
  if (!prompt) return { ok: false, code: "bad", error: "指令不能为空" };
  const cfg = b.config ?? {};
  const pick = (k: keyof NonNullable<StartArgs["config"]>) => (typeof cfg[k] === "string" && cfg[k]!.trim() ? cfg[k]!.trim() : undefined);
  let session: Session | undefined;
  let fresh = false;
  if (b.sessionId) {
    // 接着上次那个会话：型号 / 档位按任务里现在定的换（与输入框换型号、切档同一条路），工作区由会话自己定
    if (!ID_RE.test(b.sessionId)) return { ok: false, code: "bad", error: "会话 id 不对" };
    try {
      session = await getOrLoadSession(b.sessionId);
    } catch (e) {
      return { ok: false, code: "load", error: (e as Error).message };
    }
    if (!session) return { ok: false, code: "gone", error: "接着用的那个会话已经不在了" };
    if (session.running) return { ok: false, code: "busy", error: "接着用的那个会话正在进行中" };
    const provider = pick("provider"), model = pick("model"), thinking = pick("thinking");
    if (provider || model || thinking) {
      const r = setSessionModel(session, { ...(provider ? { provider } : {}), ...(model ? { model } : {}), ...(thinking ? { thinking } : {}) });
      if (!r.ok) return { ok: false, code: "config", error: r.error ?? "换不了型号" };
    }
    const mode = pick("permissionMode");
    if (mode && session.cfg?.permissionMode !== mode) {
      const r = setSessionMode(session, mode);
      if (!r.ok) return { ok: false, code: "config", error: r.error ?? "换不了运行档位" };
    }
  } else {
    // 新会话：配置快照与 /api/run 的新会话同一套校验（厂商在不在、工作区存不存在 / 在不在租户自己的目录里、全权档许不许）
    let initial: RuntimeConfig;
    try {
      initial = sessionConfigSnapshot({
        ...(pick("provider") ? { provider: pick("provider") } : {}),
        ...(pick("model") ? { model: pick("model") } : {}),
        ...(pick("thinking") ? { thinking: pick("thinking") } : {}),
        ...(pick("workspace") ? { workspace: pick("workspace") } : {}),
        ...(pick("permissionMode") ? { permissionMode: pick("permissionMode") } : {}),
      });
    } catch (e) {
      return { ok: false, code: "config", error: (e as Error).message };
    }
    // E1：新会话按此刻连上的 MCP 连接器拍基线（同 /api/run）
    if (!routineHooks.createSession) {
      await syncConnectors();
      await mcpReady(3_000);
    }
    session = routineHooks.createSession ? routineHooks.createSession(initial) : createSession(initial);
    fresh = true;
    const title = String(b.title ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
    if (title && !session.title) session.title = title;
  }
  let run;
  try {
    run = startRun(session, prompt, undefined, [], undefined, { family: { kind: "auto" }, routine: { text: routineNote(String(b.title ?? "")) } });
  } catch (e) {
    if (fresh) dropSession(session.id);
    return { ok: false, code: "start", error: (e as Error).message };
  }
  if (!run.started) {
    if (fresh) dropSession(session.id);
    return run.retiring
      ? { ok: false, code: "retiring", error: "dimensio 正在重启，这次没有运行" }
      : run.rollingBack
        ? { ok: false, code: "rollback", error: "这个会话正在回滚，这次没有运行" }
        : { ok: false, code: "busy", error: "接着用的那个会话正在进行中" };
  }
  const runId = session.runId!;
  track(session, runId, run.done);
  return { ok: true, id: session.id, runId };
}

function track(session: Session, runId: string, done: Promise<void>): void {
  const from = session.state?.messages.length ?? 0; // 这一轮的回答从这里往后找
  let t: Tracked | null = null;
  const settled = done
    .catch(() => {})
    .then(() => settle(session, from))
    .then((result) => {
      if (t) t.result = result;
      return result;
    });
  t = { sid: session.id, done: settled };
  tracked.set(runId, t);
  while (tracked.size > MAX_KEPT) tracked.delete(tracked.keys().next().value!);
}

// 这一轮怎么结束的：看收尾后留着的 runLog 尾巴里最后一个 done / error（中断也是 error，带 stopped）
async function settle(session: Session, from: number): Promise<RoutineResult> {
  let outcome: RoutineOutcome = "error";
  let by: RoutineResult["by"];
  let message = "";
  for (let i = session.runLog.length - 1; i >= 0; i--) {
    const ev = session.runLog[i] as Record<string, unknown>;
    if (ev.e === "done") {
      outcome = "done";
      break;
    }
    if (ev.e === "error") {
      if (ev.stopped === "user" || ev.stopped === "restart") {
        outcome = "aborted";
        by = ev.stopped;
      }
      message = String(ev.summary || ev.message || "");
      break;
    }
  }
  const answer = (session.state ? lastAnswer(session.state.messages, from) : "") || (outcome === "done" ? await lastReport(session.id, TEXT_MAX) : "");
  const text = (outcome === "error" && message ? message : answer || message).slice(0, TEXT_MAX);
  return { outcome, text, ...(by ? { by } : {}), endedAt: Date.now() };
}

// 这个会话的「在跑 / 在等人」变了，或者到点了
function changeOrTimeout(sid: string, ms: number, done?: Promise<unknown>): Promise<void> {
  return new Promise((resolve) => {
    let off = () => {};
    const finish = () => {
      clearTimeout(timer);
      off();
      resolve();
    };
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    off = watchGlobal((ev) => {
      if (ev.e === "session_status" && ev.id === sid) finish();
    });
    done?.then(finish, finish);
  });
}

export type StatusResult =
  | { ok: true; running: true; waiting: boolean }
  | ({ ok: true; running: false } & RoutineResult)
  | { ok: false; code: string; error: string };

/** bridge 来问一轮定时任务跑完没有（waitMs > 0：在跑就最多等这么久再答）。 */
export async function routineStatus(sid: string, runId: string, waitMs = 0): Promise<StatusResult> {
  if (!ID_RE.test(sid) || !runId) return { ok: false, code: "bad", error: "会话 id 不对" };
  const wait = Math.max(0, Math.min(MAX_WAIT_MS, Number(waitMs) || 0));
  const t = tracked.get(runId);
  if (t && t.sid === sid) {
    // 结局是 settle 在别处异步填上的：每次现读（直接写 t.result 会被类型收窄成「await 之后也没有」）
    const result = () => t.result;
    const done = result();
    if (done) return { ok: true, running: false, ...done };
    const s = getSession(sid);
    if (wait) await changeOrTimeout(sid, wait, t.done);
    const later = result();
    if (later) return { ok: true, running: false, ...later };
    // 收尾那几步（落盘、拍结束快照）还在走：等它算完结局再答，别让 bridge 以为没记下
    if (!s?.running) return { ok: true, running: false, ...(await t.done) };
    return { ok: true, running: true, waiting: Boolean(waitingOf(s)) };
  }
  // 这个进程没记过这一轮（dimensio 中途重启过）：在跑就接着等（多半是重启后的自动续跑），不在跑就说不清结局
  let s: Session | undefined;
  try {
    s = await getOrLoadSession(sid);
  } catch (e) {
    return { ok: false, code: "load", error: (e as Error).message };
  }
  if (!s) return { ok: false, code: "gone", error: "这个会话已经不在了" };
  if (s.running && wait) await changeOrTimeout(sid, wait, s.runPromise ?? undefined);
  if (s.running) return { ok: true, running: true, waiting: Boolean(waitingOf(s)) };
  return { ok: true, running: false, outcome: "unknown", text: (await lastReport(sid, TEXT_MAX)).slice(0, TEXT_MAX), endedAt: Date.now() };
}

// ── 测试用 ───────────────────────────────────────────────────────────────────
export function _resetRoutines(): void {
  tracked.clear();
  routineHooks.createSession = undefined;
}
