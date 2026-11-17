// 插话：送进正在跑的一轮、撤回、立即中断并发送。
import { skillLoadedIn } from "../agent/injections.ts";
import { resolveSlash, SLASH_SKILL_KIND, slashInjection } from "../commands.ts";
import { fanout } from "./events.ts";
import { runMismatch, touchSession } from "./lifecycle.ts";
import { startRun } from "./run.ts";
import { isAway, setSessionAway } from "./switches.ts";
import type { Session } from "./types.ts";

// Steering (from POST /:id/steer): deliver a message into a RUN that is already
// in flight, instead of the old hard 409. The loop injects it at its next turn
// boundary (see state.takeSteer); the event fans out immediately so every
// attached device shows the insertion right away — and so a reconnect replays it
// in the right place from runLog.
const STEER_ID_RE = /^[A-Za-z0-9_-]{8,100}$/;

export function steerSession(
  session: Session,
  text: string,
  runId?: string,
  steerId?: unknown,
): { ok: boolean; error?: string; currentRunId?: string | null; id?: string } {
  const clean = String(text ?? "").trim();
  if (!clean) return { ok: false, error: "empty message" };
  if (!session.running || !session.state) return { ok: false, error: "session is not running" };
  // M2（#44）：插话是说给「那一轮」听的；此刻在跑的是另一台设备新起的一轮，就别带着「优先于此前的指示」注进去。
  if (runMismatch(session, runId)) return { ok: false, error: "run_mismatch", currentRunId: session.runId ?? null };
  if (isAway(session)) setSessionAway(session, false); // P3：插话 = 人回来了
  // E3：插话是 /技能名——技能正文跟着插话一起进（loop 注入插话时紧跟着追加）
  const slash = resolveSlash(clean);
  const inj = slash ? slashInjection(slash, (name) => skillLoadedIn(session.state!.messages, name)) : null;
  // U2（#46）：插话的身份——客户端给了就用它（本机的乐观气泡与回来的 steer_queued 按它对上号）。
  const id = session.state.queueSteer(
    clean,
    typeof steerId === "string" && STEER_ID_RE.test(steerId) ? steerId : undefined,
    inj ? { name: inj.name, kind: SLASH_SKILL_KIND, text: inj.text, ...(inj.pkg ? { pkg: true } : {}) } : undefined,
  );
  touchSession(session);
  fanout(session, { e: "steer_queued", text: clean, id });
  return { ok: true, id };
}

// U2（X36 第二步）：撤回一条还没送达的插话（待送达托盘上的「撤回」「立即中断并发送」都先走这里）。已经注入进模型
// 上下文的撤不回来（delivered）；撤回成功就广播，各设备把它从托盘里拿掉。
export function withdrawSteer(session: Session, id: string): { ok: boolean; reason?: "delivered" | "not_running"; text?: string } {
  if (!session.running || !session.state) return { ok: false, reason: "not_running" };
  const text = session.state.withdrawSteer(id);
  if (text === null) return { ok: false, reason: "delivered" };
  touchSession(session);
  fanout(session, { e: "steer_withdrawn", id });
  return { ok: true, text };
}

// U2（hermes N17a）：「立即中断并发送」——撤回这条还没送达的插话，中止这一轮（只停这一轮：不像「停止」那样把后台 job、
// dev server 一起收掉，用户是要改方向），等它收尾，再以这句话开新一轮。前端经全局事件发现服务端起的这一轮、自动接上（与 O7
// 续跑同一条路）。新一轮起不来（还在收尾、退役闸关着）就把话退回输入框。
export async function interruptWithSteer(
  session: Session,
  id: string,
  waitMs = 30_000,
): Promise<{ ok: boolean; reason?: "delivered" | "not_running" | "busy" }> {
  const w = withdrawSteer(session, id);
  if (!w.ok) return { ok: false, reason: w.reason };
  const text = w.text!;
  session.abort?.abort();
  const done = session.runPromise;
  if (done) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([done.catch(() => {}), new Promise<void>((r) => (timer = setTimeout(r, waitMs)))]);
    clearTimeout(timer);
  }
  const run = startRun(session, text);
  if (!run.started) {
    fanout(session, { e: "steer_returned", texts: [text], ids: [id] });
    return { ok: false, reason: "busy" };
  }
  return { ok: true };
}
