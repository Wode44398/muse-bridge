// 会话管理（与 bridge 里 Claude 分页对齐的几件事）的接口与接线：稍后发送、改名与 AI 标题、归档、Tab 输入建议、通知。
// 入口 mountSessionMgmt(app)：挂接口、订阅回合事件与全局状态、起自动归档与启动时的队列重放。
//
// 接口（能力位见 protocol.ts）：
//   GET  /api/sessions/:id/extras            → { queue, suggestion, archived, titleBy }（打开会话时取一次，之后靠全局事件）
//   POST /api/sessions/:id/queue {text, id?} → 运行中排进队列；没在跑 409 not_running（界面改走普通发送）
//   POST /api/sessions/:id/queue/remove {id} → { ok, item }（撤回 / 拿回输入框改）
//   POST /api/sessions/:id/queue/clear       → { ok, cleared }
//   POST /api/sessions/:id/queue/promote {id}→ { ok, how: steer | run }（立即发送：改成插话）
//   POST /api/sessions/:id/rename {title}    → { ok, title }（之后 AI 不再改它的标题）
//   POST /api/sessions/:id/archive {on}      → { ok, changed, skipped }（在跑 / 在等人 / 有排队的跳过）
//   GET  /api/sessmgmt/state                 → { notify: {permission, question, done}, suggestions }（界面按偏好决定提醒与灰字）
//   POST /api/sessmgmt/presence {client, visible, session} → 界面在场心跳（有界面可见时不经 bridge 推送）
// 全局事件：queue {id, items} · suggestion {id, text} · session_title {id, title}；会话列表变化照旧 list_changed。
import type { Express, Request, Response } from "express";
import { onTurnEvent } from "../bridge-events.ts";
import { getOrLoadSession, getSession, noteListChanged, watchGlobal, emitGlobal, type WaitingInfo } from "../session.ts";
import { isQuickPath } from "../quick.ts";
import { prefValue } from "../prefs.ts";
import { archiveFilter, archiveViewOf, isArchived, setArchived, startAutoArchive, unarchiveOnTurn, type ArchiveView } from "./archive.ts";
import { notePresence, maybePush, notifyPrefs } from "./notify.ts";
import { clearQueue, dequeue, drainLeftoversLater, enqueue, listQueue, promote, scheduleDrain } from "./queue.ts";
import { clearSuggestion, maybeSuggest, suggestionOf } from "./suggest.ts";
import { maybeAiTitle, renameSession } from "./titles.ts";
import { forgetSession, getFlags, getQueue } from "./store.ts";

export { archiveFilter, archiveViewOf, isArchived, notifyPrefs, type ArchiveView };

const ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const sid = (req: Request): string | null => {
  const id = String(req.params.id ?? "");
  return ID_RE.test(id) ? id : null;
};

// 回合事件：开跑清建议、真人发消息取消归档；收尾重放队列、起标题、给建议、提醒做完了
function onTurn(event: "turn.start" | "turn.end", p: Record<string, unknown>): void {
  const id = typeof p.sessionId === "string" ? p.sessionId : "";
  if (!id) return;
  if (event === "turn.start") {
    clearSuggestion(id);
    if (p.kind === "chat") unarchiveOnTurn(id);
    return;
  }
  const queued = getQueue(id).length > 0;
  scheduleDrain(id);
  const s = getSession(id);
  if (!s) return;
  const ok = p.ok === true;
  if (ok) {
    void maybeAiTitle(s, (sessionId, title) => {
      emitGlobal({ e: "session_title", id: sessionId, title, at: Date.now() });
      noteListChanged("sessions");
    });
    if (!queued) void maybeSuggest(s).catch((e) => console.warn(`[sessmgmt] 输入建议失败：${(e as Error).message}`));
  }
  // 人停的不提醒；后面马上接着发排队的话，也不提醒「做完了」
  if (!queued && p.stopped !== true) maybePush(ok ? "done" : "error", `end:${id}:${s.runId ?? Date.now()}`, id, s.title);
}

// 全局状态：新挂上的卡（按卡片 id 去重）
function onGlobal(ev: Record<string, unknown>): void {
  if (ev.e !== "session_status") return;
  const w = ev.waiting as WaitingInfo | null | undefined;
  if (!w || typeof ev.id !== "string") return;
  maybePush(w.kind, `wait:${w.id}`, ev.id, String(ev.title ?? ""), w.tool);
}

let installed = false;

export function mountSessionMgmt(app: Express): void {
  if (!installed) {
    installed = true;
    onTurnEvent(onTurn);
    watchGlobal(onGlobal);
    startAutoArchive();
    drainLeftoversLater();
  }

  // 会话删掉了：旁路记录（归档、标题出处、队列）一起清
  app.use((req, res, next) => {
    const m = /^\/api\/sessions\/([a-zA-Z0-9-]{1,64})(\/delete)?$/.exec(req.path);
    if (m && ((req.method === "DELETE" && !m[2]) || (req.method === "POST" && m[2]))) {
      res.on("finish", () => {
        if (res.statusCode >= 200 && res.statusCode < 300) forgetSession(m[1]);
      });
    }
    next();
  });

  app.get("/api/sessions/:id/extras", (req, res) => {
    const id = sid(req);
    if (!id) return void res.status(400).json({ error: "bad session id" });
    const f = getFlags(id);
    res.json({
      queue: listQueue(id),
      suggestion: suggestionOf(id),
      archived: Boolean(f.archivedAt),
      ...(f.archivedAt ? { archivedAt: f.archivedAt, archivedBy: f.archivedBy } : {}),
      titleBy: f.titleBy ?? null,
    });
  });

  app.post("/api/sessions/:id/queue", (req, res) => {
    const id = sid(req);
    const s = id ? getSession(id) : undefined;
    if (!s) return void res.status(409).json({ error: "not_running" });
    const r = enqueue(s, req.body?.text, req.body?.id);
    if (!r.ok) return void res.status(r.error === "not_running" ? 409 : 400).json({ error: r.error });
    res.json(r);
  });

  app.post("/api/sessions/:id/queue/remove", (req, res) => {
    const id = sid(req);
    const qid = typeof req.body?.id === "string" ? req.body.id : "";
    if (!id || !qid) return void res.status(400).json({ error: "id required" });
    const item = dequeue(id, qid);
    res.json(item ? { ok: true, item } : { ok: false, reason: "gone" });
  });

  app.post("/api/sessions/:id/queue/clear", (req, res) => {
    const id = sid(req);
    if (!id) return void res.status(400).json({ error: "bad session id" });
    res.json({ ok: true, cleared: clearQueue(id) });
  });

  app.post("/api/sessions/:id/queue/promote", async (req, res) => {
    const id = sid(req);
    const qid = typeof req.body?.id === "string" ? req.body.id : "";
    if (!id || !qid) return void res.status(400).json({ error: "id required" });
    try {
      const s = await getOrLoadSession(id);
      if (!s) return void res.status(404).json({ error: "unknown session" });
      res.json(promote(s, qid));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post("/api/sessions/:id/rename", async (req, res) => {
    const id = sid(req);
    if (!id) return void res.status(400).json({ error: "bad session id" });
    const r = await renameSession(id, req.body?.title);
    if (!r.ok) return void res.status(r.error === "没有这个会话" ? 404 : 400).json({ error: r.error });
    emitGlobal({ e: "session_title", id, title: r.title, at: Date.now() });
    noteListChanged("sessions");
    res.json(r);
  });

  app.post("/api/sessions/:id/archive", async (req, res) => {
    const id = sid(req);
    if (!id) return void res.status(400).json({ error: "bad session id" });
    const on = req.body?.on !== false;
    // 快照对话不归档（它常驻侧栏顶部，只留最新一条）
    let quick = false;
    if (on) {
      const live = getSession(id);
      quick = isQuickPath(live?.cfg?.workspace);
    }
    res.json(setArchived([id], on, "user", { quick: () => quick }));
  });

  app.get("/api/sessmgmt/state", (_req, res) => {
    res.json({ notify: notifyPrefs(), suggestions: prefValue<boolean>("promptSuggestions") });
  });

  app.post("/api/sessmgmt/presence", (req: Request, res: Response) => {
    res.json({ ok: notePresence(req.body?.client, req.body?.visible, req.body?.session) });
  });
}
