// M15（Codex X35）：headless 客户端（exec 形态）——走产品实际的 /api/run，给评测台、Routines、QQ bot 这类没人盯着的调用方共用。
//
// 以前评测台自己写了一份 SSE 解析，别处要用就得各抄一份，卡片（权限 / 提问 / 计划）来了也没人管——一轮会挂到卡片超时。
// 这里：发一条消息、读 SSE 到收场；卡片按无人值守的策略当场落定（权限默认拒、说明没人在场；提问回一句「没人在场，按你的
// 判断」；计划不批、请它把计划当最终答复交回来）；返回会话 id、runId、最后一轮的正文、结局与各事件计数。
// 只用 fetch，不依赖 harness 的任何内部模块（bridge 那边的 Routines / QQ bot 也能照抄这一层）。

export interface HeadlessOptions {
  // harness 的根地址（直连 http://127.0.0.1:8799，或经 bridge 的 http://127.0.0.1:8787/api/harness）
  baseUrl: string;
  // 鉴权头：直连用 x-dimensio-internal-token，经 bridge 用 Authorization
  headers?: Record<string, string>;
  message: string;
  sessionId?: string;
  config?: Record<string, unknown>;
  deadlineMs?: number;
  maxTurns?: number;
  // 权限卡怎么落定：deny（默认，没人在场）/ once（信任这次调用方，逐次放行）
  permissions?: "deny" | "once";
  signal?: AbortSignal;
  onEvent?: (ev: Record<string, unknown>) => void;
}

export interface HeadlessResult {
  sessionId: string | null;
  runId: string | null;
  text: string; // 最后一轮的正文
  outcome: "done" | "disconnected" | `error: ${string}`;
  counts: Record<string, number>;
}

export const HEADLESS_NOTE = "headless run: no human is attached to answer this";
// P10（D9）：落定卡片时自报的「设备」——别的设备上看到的是「在无头调用上拒绝了」
export const HEADLESS_BY = { id: "headless-client", label: "无头调用" };
export const HEADLESS_ANSWER = "No human is attached to this run — decide yourself and say what you assumed.";
export const HEADLESS_PLAN_NOTE =
  "No human is attached to approve a plan here. End this run by presenting the plan as your final answer.";

// SSE 帧 → 事件对象（data: 行拼起来按 JSON 解；解不了的帧跳过）
export async function* sseEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const decoder = new TextDecoder();
  let buf = "";
  const take = function* (): Generator<Record<string, unknown>> {
    let cut: number;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, cut);
      buf = buf.slice(cut + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data) continue;
      try {
        const ev = JSON.parse(data);
        if (ev && typeof ev === "object") yield ev as Record<string, unknown>;
      } catch {
        /* 不是 JSON：跳过 */
      }
    }
  };
  for await (const chunk of body) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    yield* take();
  }
  // 流断在最后一帧中间（没有结尾的空行）：补一个把它冲出来
  buf += decoder.decode() + "\n\n";
  yield* take();
}

export async function runHeadless(opts: HeadlessOptions): Promise<HeadlessResult> {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const headers = { "content-type": "application/json", ...(opts.headers ?? {}) };
  const post = (path: string, body: unknown) =>
    fetch(base + path, { method: "POST", headers, body: JSON.stringify(body), signal: opts.signal }).then(
      (r) => r.arrayBuffer().then(() => r.ok),
      () => false,
    );
  const res = await fetch(`${base}/api/run`, {
    method: "POST",
    headers,
    signal: opts.signal,
    body: JSON.stringify({
      message: opts.message,
      ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
      ...(opts.config && !opts.sessionId ? { config: opts.config } : {}),
      ...(opts.deadlineMs ? { deadlineMs: opts.deadlineMs } : {}),
      ...(opts.maxTurns ? { maxTurns: opts.maxTurns } : {}),
    }),
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    return { sessionId: opts.sessionId ?? null, runId: null, text: "", outcome: `error: HTTP ${res.status} ${detail.slice(0, 200)}`, counts: {} };
  }
  const out: HeadlessResult = { sessionId: opts.sessionId ?? null, runId: null, text: "", outcome: "disconnected", counts: {} };
  const settle: Promise<boolean>[] = [];
  for await (const ev of sseEvents(res.body as unknown as AsyncIterable<Uint8Array>)) {
    const kind = String(ev.e ?? "");
    out.counts[kind] = (out.counts[kind] ?? 0) + 1;
    opts.onEvent?.(ev);
    const sid = out.sessionId;
    switch (kind) {
      case "session":
        out.sessionId = typeof ev.sessionId === "string" ? ev.sessionId : out.sessionId;
        out.runId = typeof ev.runId === "string" ? ev.runId : out.runId;
        break;
      case "turn_start":
        out.text = "";
        break;
      case "text_delta":
        out.text += typeof ev.text === "string" ? ev.text : "";
        break;
      case "permission_ask":
        if (sid) {
          const decision = opts.permissions === "once" ? "once" : "deny";
          settle.push(
            post(`/api/sessions/${encodeURIComponent(sid)}/permission`, {
              id: ev.id,
              decision,
              ...(decision === "deny" ? { note: HEADLESS_NOTE } : {}),
              by: HEADLESS_BY,
            }),
          );
        }
        break;
      case "ask":
        if (sid) {
          const questions = Array.isArray(ev.questions) ? ev.questions : [];
          settle.push(
            post(`/api/sessions/${encodeURIComponent(sid)}/answer`, {
              askId: ev.id,
              answers: questions.map(() => ({ selected: [HEADLESS_ANSWER], custom: true })),
              by: HEADLESS_BY,
            }),
          );
        }
        break;
      case "plan_ask":
        if (sid) settle.push(post(`/api/sessions/${encodeURIComponent(sid)}/plan`, { id: ev.id, approved: false, note: HEADLESS_PLAN_NOTE, by: HEADLESS_BY }));
        break;
      case "done":
        out.outcome = "done";
        break;
      case "error":
        out.outcome = `error: ${String(ev.message ?? "").slice(0, 300)}`;
        break;
    }
  }
  await Promise.all(settle);
  return out;
}
