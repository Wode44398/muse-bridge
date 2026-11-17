// 忙闲探针与两段式退役闸。
import express from "express";
import { anySessionRunning, runningRuns } from "../session.ts";
import { retiring, prepareRetire, cancelRetire } from "../retire.ts";

export function registerAdminRoutes(app: express.Express, retireNow: (why: string) => Promise<void>): void {
  // ── M8：忙闲探针 + 两段式退役闸 ─────────────────────────────────────────────────
  // GET /api/busy 与 bridge 自更新分支同形（{ running }），多给在跑的轮与是否在退役。
  app.get("/api/busy", (_req, res) => {
    res.json({ running: anySessionRunning(), runs: runningRuns(), retiring: retiring() });
  });

  app.post("/api/admin/retire/prepare", (req, res) => {
    const f = prepareRetire(req.body?.ttlMs);
    res.json({ token: f.token, since: f.since, expiresAt: f.expiresAt, runs: runningRuns() });
  });

  app.post("/api/admin/retire/cancel", (req, res) => {
    res.json({ ok: cancelRetire(req.body?.token) });
  });

  // 没有在跑的轮就排空退出；有的话要么等（409 告诉调用方还剩谁），要么 force：按「服务重启」中止它们。
  app.post("/api/admin/retire/commit", (req, res) => {
    const runs = runningRuns();
    if (runs.length && req.body?.force !== true) {
      res.status(409).json({ error: "busy", runs });
      return;
    }
    prepareRetire(); // 排空期间不再接新 run
    res.json({ ok: true, draining: runs.length });
    setImmediate(() => void retireNow("commit"));
  });
}
