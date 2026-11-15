// 项目对话的概览接口（运行时在 project-mode.ts；前端 web/src/components/sheets/ProjectOverview.svelte）：
//   GET  /api/project/:id                      → { instructions, instructionsMax, threads:[…], memory:[{name,size,at}], limits }
//        threads 每条：{ id, name, title, agent, state: working | idle, waiting（挂着等用户点的卡）, resolved, report（最新回复开头）, at }
//   POST /api/project/:id          { instructions }              → 同上（项目说明 ≤16000 字；下一轮开跑时以 World State 片段送到协调者与讨论串）
//   POST /api/project/:id/resolve  { thread, resolved }          → { ok, resolved }（讨论串标为已解决 / 重新打开）
//   GET  /api/project/:id/memory?name=                           → { name, content }
//   POST /api/project/:id/memory   { name, content | null }      → { ok, memory }（null = 删掉）
// 变化经全局通道的 list_changed(sessions) 推出去，别的设备上的概览跟着重拉。:id 不是项目对话一律 404。
import type { Express, Request, Response } from "express";
import { childrenOf, relatedSessions } from "./session-family.ts";
import { getSession, noteListChanged } from "./session.ts";
import {
  INSTRUCTIONS_MAX,
  isProjectSession,
  memoryList,
  memoryNameOk,
  memoryRead,
  memoryWrite,
  PROJECT_MAX_LIVE,
  PROJECT_MAX_THREADS,
  projectState,
  updateProject,
} from "./project-mode.ts";

const ID_RE = /^[A-Za-z0-9_-]{8,100}$/;

function projectOf(req: Request, res: Response): string | null {
  const id = String(req.params.id ?? "");
  if (!ID_RE.test(id)) {
    res.status(400).json({ error: "bad session id" });
    return null;
  }
  if (!isProjectSession(id)) {
    res.status(404).json({ error: "这不是项目对话" });
    return null;
  }
  return id;
}

// 这条讨论串此刻有没有挂着等用户点的卡（提问 / 权限 / 计划）
function waitingOf(id: string): boolean {
  const s = getSession(id);
  return Boolean(s && (s.pendingAsks.size || s.pendingPermissions.size || s.pendingPlans.size));
}

export async function projectView(id: string) {
  const st = projectState(id);
  const at = new Map(childrenOf(id).map((c) => [c.id, c.at]));
  const { rows } = await relatedSessions(id, { reports: true });
  const threads = rows
    .filter((r) => r.relation === "child")
    .map((r) => ({
      id: r.id,
      name: r.name,
      title: r.title,
      agent: r.agent,
      state: r.state,
      waiting: waitingOf(r.id),
      resolved: st.resolved[r.id] === true,
      report: (r.report ?? "").replace(/\s+/g, " ").slice(0, 200),
      at: at.get(r.id) ?? 0,
    }));
  return {
    instructions: st.instructions,
    instructionsMax: INSTRUCTIONS_MAX,
    threads,
    memory: memoryList(id),
    limits: { maxThreads: PROJECT_MAX_THREADS, maxLive: PROJECT_MAX_LIVE },
  };
}

export function registerProjectRoutes(app: Express): void {
  app.get("/api/project/:id", async (req, res) => {
    const id = projectOf(req, res);
    if (!id) return;
    res.json(await projectView(id));
  });

  app.post("/api/project/:id", async (req, res) => {
    const id = projectOf(req, res);
    if (!id) return;
    const b = req.body ?? {};
    if (b.instructions !== undefined) {
      if (typeof b.instructions !== "string") {
        res.status(400).json({ error: "instructions must be a string" });
        return;
      }
      if (b.instructions.length > INSTRUCTIONS_MAX) {
        res.status(400).json({ error: `项目说明最多 ${INSTRUCTIONS_MAX} 字` });
        return;
      }
      updateProject(id, { instructions: b.instructions });
      noteListChanged("sessions");
    }
    res.json(await projectView(id));
  });

  app.post("/api/project/:id/resolve", (req, res) => {
    const id = projectOf(req, res);
    if (!id) return;
    const tid = String(req.body?.thread ?? "");
    if (!ID_RE.test(tid) || !childrenOf(id).some((c) => c.id === tid)) {
      res.status(404).json({ error: "这条讨论串不在这个项目里" });
      return;
    }
    const st = updateProject(id, { resolve: { id: tid, value: req.body?.resolved === true } });
    noteListChanged("sessions");
    res.json({ ok: true, resolved: st.resolved[tid] === true });
  });

  app.get("/api/project/:id/memory", (req, res) => {
    const id = projectOf(req, res);
    if (!id) return;
    const name = String(req.query.name ?? "");
    if (!memoryNameOk(name)) {
      res.status(400).json({ error: "bad name" });
      return;
    }
    const content = memoryRead(id, name);
    if (content === null) {
      res.status(404).json({ error: "没有这一篇" });
      return;
    }
    res.json({ name, content });
  });

  app.post("/api/project/:id/memory", async (req, res) => {
    const id = projectOf(req, res);
    if (!id) return;
    const b = req.body ?? {};
    if (b.content !== null && typeof b.content !== "string") {
      res.status(400).json({ error: "content must be a string or null" });
      return;
    }
    const r = await memoryWrite(id, String(b.name ?? ""), b.content);
    if (!r.ok) {
      res.status(400).json({ error: r.error });
      return;
    }
    noteListChanged("sessions");
    res.json({ ok: true, memory: memoryList(id) });
  });
}
