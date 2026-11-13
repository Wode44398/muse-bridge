// 拉取请求（PR）的 HTTP 面（能力位 pr）：会话面板的 PR 卡，与 bridge 推来的自动修复事件。数据与规矩都在 bridge（见 pr-bridge.ts 头注）。
//   GET  /api/pr?session=<id>[&refresh=1]             → bridge 的 PR 视图（{ available:false } = 没接上 bridge / 成员实例）
//   POST /api/pr { session, op, url?, autoFix? }        → op：bind / unbind / monitor（开关自动修复）/ refresh；回 { ok, result, view }
//   POST /api/pr/event { sessionId, text }              → 只收 bridge 发来的（带同机凭据）：以 harness 片段在那个会话开一轮
// 会话的工作区（git 操作、核对仓库都在这里）由这边按会话记录取，不信前端给的。
import type { Express, Request, Response } from "express";
import { getOrLoadSession, getSession, sessionWorkspace, startRun } from "./session.ts";
import { loadSession } from "./store.ts";
import { retiring } from "./retire.ts";
import { bridgeEventAuthorized, prAvailable, prCall, PrError } from "./pr-bridge.ts";

const SESSION_RE = /^[0-9a-f-]{8,64}$/i;
// 事件正文：bridge 的 pr-messages.mjs composeCiEvent 拼的，整段包在这个标签里
const EVENT_RE = /^<ci-monitor-event>[\s\S]*<\/ci-monitor-event>$/;
const EVENT_MAX = 200_000;
export const CI_EVENT_KIND = "ci-event";

async function sessionKnown(id: string): Promise<boolean> {
  return Boolean(getSession(id) || (await loadSession(id).catch(() => null)));
}

function sendPrError(res: Response, e: unknown): void {
  const err = e as PrError;
  const status = err instanceof PrError && err.status >= 400 && err.status < 600 ? err.status : 502;
  res.status(status).json({ error: err?.message ?? String(e), ...(err?.code ? { code: err.code } : {}) });
}

export function registerPrRoutes(app: Express): void {
  app.get("/api/pr", async (req: Request, res: Response) => {
    if (!prAvailable()) {
      res.json({ available: false, reason: "no_bridge" });
      return;
    }
    const id = String(req.query.session ?? "");
    if (!SESSION_RE.test(id) || !(await sessionKnown(id))) {
      res.status(404).json({ error: "unknown session" });
      return;
    }
    try {
      const j = await prCall("view", id, await sessionWorkspace(id), { refresh: req.query.refresh === "1" });
      res.json(j.view ?? { available: false });
    } catch (e) {
      sendPrError(res, e);
    }
  });

  app.post("/api/pr", async (req: Request, res: Response) => {
    const id = String(req.body?.session ?? "");
    const op = String(req.body?.op ?? "");
    if (!prAvailable()) {
      res.status(404).json({ error: "pull requests need bridge", code: "unavailable" });
      return;
    }
    if (!["bind", "unbind", "monitor", "refresh"].includes(op)) {
      res.status(400).json({ error: "unknown op" });
      return;
    }
    if (!SESSION_RE.test(id) || !(await sessionKnown(id))) {
      res.status(404).json({ error: "unknown session" });
      return;
    }
    const args: Record<string, unknown> = {};
    if (typeof req.body?.url === "string") args.url = req.body.url.slice(0, 500);
    if (op === "monitor") args.autoFix = req.body?.autoFix === true ? true : req.body?.autoFix === false ? false : null;
    try {
      const j = await prCall(op, id, await sessionWorkspace(id), args);
      res.json({ ok: true, result: j.result ?? null, view: j.view ?? null });
    } catch (e) {
      sendPrError(res, e);
    }
  });

  // bridge 的 PR 后台扫描叫醒这个会话（modules/dimensio 的 deliverPrEvent）。浏览器经 bridge 反代也打得到这个路径，
  // 但带不出 bridge 给本实例的同机凭据——没有它的一律 403，伪造不出事件。
  app.post("/api/pr/event", async (req: Request, res: Response) => {
    if (!bridgeEventAuthorized(req.get("x-bridge-event-secret"))) {
      res.status(403).json({ error: "only bridge sends pull-request events" });
      return;
    }
    const id = String(req.body?.sessionId ?? "");
    const text = String(req.body?.text ?? "");
    if (!SESSION_RE.test(id) || !EVENT_RE.test(text) || text.length > EVENT_MAX) {
      res.status(400).json({ error: "bad event" });
      return;
    }
    if (retiring()) {
      res.status(503).json({ error: "retiring", code: "retiring" });
      return;
    }
    let session;
    try {
      session = await getOrLoadSession(id);
    } catch (e) {
      res.status(409).json({ error: (e as Error).message, code: "unloadable" });
      return;
    }
    if (!session) {
      res.status(404).json({ error: "unknown sessionId", code: "session_not_found" });
      return;
    }
    const run = startRun(session, "", undefined, [], undefined, { event: { text, kind: CI_EVENT_KIND, label: "（拉取请求自动修复）" } });
    if (!run.started) {
      res.status(run.retiring ? 503 : 409).json({ error: "session is busy", code: run.retiring ? "retiring" : "session_running" });
      return;
    }
    console.log(`[pr] ${id.slice(0, 8)} woken by a pull-request event`);
    res.json({ ok: true, runId: session.runId });
  });
}
