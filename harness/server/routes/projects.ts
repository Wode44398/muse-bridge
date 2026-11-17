// 项目与快照。
import express from "express";
import path from "node:path";
import { workspaceRoot } from "../session.ts";
import { listSessions } from "../store.ts";
import { assertInTenant } from "../tenant.ts";
import { listProjects, createBlankProject, importProject, registerSavedQuick, renameProject, setProjectFlags, setProjectOrder } from "../projects.ts";
import { isQuickPath, quickProject, newQuickProject, currentQuickForSave, adoptCurrentQuick } from "../quick.ts";

export function registerProjectListRoutes(app: express.Express): void {
  // ── Projects (friendly name ↔ workspace directory) ─────────────────────────

  app.get("/api/projects", async (_req, res) => {
    const sessions = await listSessions();
    // 快照桶不进项目发现（否则老桶会以 UUID 目录名冒充隐式项目）；当前那只桶
    // 以 quick 标记单独追加，前端据此把它摘出「项目」区、单独置顶成一行。
    const rows = await listProjects([
      workspaceRoot(),
      ...sessions.map((s) => s.workspace ?? "").filter(Boolean),
    ].filter((p) => !isQuickPath(p)));
    const quick = quickProject();
    res.json(quick ? [...rows, quick] : rows);
  });

  app.post("/api/projects", async (req, res) => {
    try {
      const mode = String(req.body?.mode ?? "");
      if (mode === "blank") {
        res.json(await createBlankProject(String(req.body?.name ?? "")));
        return;
      }
      if (mode === "existing") {
        const p = String(req.body?.path ?? "");
        if (isQuickPath(p)) throw new Error("快照桶不能作为项目导入");
        assertInTenant(path.resolve(p.trim() || "."), "项目文件夹");
        res.json(await importProject(p));
        return;
      }
      res.status(400).json({ error: "mode must be blank or existing" });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // 「新建快照」：换一只全新的一次性桶（新 workspace → 新记忆作用域），旧桶
  // 留盘不删、不再列出——同「删项目不删会话」的规矩。
  app.post("/api/quick/new", (_req, res) => {
    try {
      res.json(newQuickProject());
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // 「存为工作空间」：当前快照桶原地登记成普通项目（名字「<base> <编号>」，base 由前端按界面语言给），
  // 快照位同时换新桶——此后它不再被「新建快照」顶掉，会话照常列在项目下。{path?: 前端以为的当前快照, base?}
  // → {project, quick}。先登记再摘出快照：中途失败桶还是快照，不会两头落空。
  app.post("/api/quick/save", async (req, res) => {
    try {
      const cur = currentQuickForSave(String(req.body?.path ?? ""));
      const base = String(req.body?.base ?? "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 40) || "快照会话";
      const project = await registerSavedQuick(cur.path, `${base} ${cur.seq}`);
      const quick = adoptCurrentQuick(cur);
      res.json({ project, quick });
    } catch (e) {
      res.status((e as { status?: number }).status ?? 400).json({ error: (e as Error).message });
    }
  });

  // 项目改名：只改显示名（注册表），目录与会话不动；name 留空 = 恢复成文件夹名。快照对话不能改。
  app.post("/api/projects/rename", async (req, res) => {
    try {
      const p = String(req.body?.path ?? "");
      if (isQuickPath(p)) {
        res.status(400).json({ error: "快照对话不能改名" });
        return;
      }
      res.json(await renameProject(p, String(req.body?.name ?? "")));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // 置顶 / 隐藏（侧栏排序与可见性）。走 POST 而不是 PATCH：bridge 反代的 CORS
  // 只放 GET/POST。身份是 workspace 绝对路径，历史里发现的隐式项目也能设。
  app.post("/api/projects/flags", async (req, res) => {
    try {
      // 快照对话常驻置顶、不可隐藏，也绝不能被登记进项目注册表。
      if (isQuickPath(String(req.body?.path ?? ""))) {
        res.status(400).json({ error: "快照对话不参与置顶/隐藏" });
        return;
      }
      const patch: { pinned?: boolean; hidden?: boolean } = {};
      if (typeof req.body?.pinned === "boolean") patch.pinned = req.body.pinned;
      if (typeof req.body?.hidden === "boolean") patch.hidden = req.body.hidden;
      res.json(await setProjectFlags(String(req.body?.path ?? ""), patch));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // 侧栏拖动排序：一个区（置顶区或非置顶区）拖完之后的完整次序。快照对话不进注册表，混进来的直接丢掉。
  app.post("/api/projects/order", async (req, res) => {
    try {
      const raw = Array.isArray(req.body?.paths) ? (req.body.paths as unknown[]) : [];
      const paths = raw.filter((p): p is string => typeof p === "string" && !isQuickPath(p)).slice(0, 500);
      await setProjectOrder(paths);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
}
