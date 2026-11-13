// 工作区协同的两条上行口子（下行走会话事件流 { e:"workspace" }，见 ui-state.ts）：
//   POST /api/ui/state  — 前端防抖上报「用户此刻在看什么」
//   POST /api/ui/answer — 前端应答 agent 的请求（未保存草稿全文）
// 全局鉴权中间件已罩住 /api/*；harness 一个进程只有一个用户（租户实例同样），不再分身份。
import type express from "express";
import { answerUiRequest, noteUiState } from "./ui-state.ts";
import { prefValue } from "./prefs.ts";

export function registerWorkspaceRoutes(app: express.Express): void {
  app.post("/api/ui/state", (req, res) => {
    const clientId = String(req.body?.clientId ?? "").slice(0, 64);
    if (!clientId) {
      res.status(400).json({ error: "clientId required" });
      return;
    }
    // 用户在设置里关了「让 agent 看到我在看什么」：上报照收不误（老前端不知道这一项），只是不记
    if (prefValue<boolean>("workspace.view")) noteUiState(clientId, String(req.body?.client ?? "web"), req.body?.state);
    res.json({ ok: true });
  });

  app.post("/api/ui/answer", (req, res) => {
    const id = String(req.body?.id ?? "");
    if (!id) {
      res.status(400).json({ error: "id required" });
      return;
    }
    // ok:false = 过期 / 未知请求（重放的旧事件），前端静默忽略
    res.json({ ok: answerUiRequest(id, req.body?.result) });
  });
}
