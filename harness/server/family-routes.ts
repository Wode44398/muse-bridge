// 会话协作的 HTTP 接口（运行时在 session-family.ts）。
//   前端：GET  /api/family                侧栏挂子会话、未读数、在干活的 Claude 子会话
//         GET  /api/family/related/:id    一个会话的相关会话（父 / 子 / 兄弟，含 Claude 那边的）
//   bridge（同机、带令牌直连，modules/dimensio/server/routes/harness.mjs 的 familyCall）：
//         POST /api/family/spawn | deliver | state | info
// bridge 那几条要求请求头 x-dimensio-family-call: 1——bridge 的反代转发浏览器请求时会把这个头剥掉，所以只有 bridge 服务端自己发得出来：
// 浏览器里的页面（同样带着令牌经反代进来）冒充不了「Claude 会话发来的消息」。
import type { Express, Request, Response } from "express";
import { familyView, inboundDeliver, inboundInfo, inboundSpawn, inboundState, relatedSessions } from "./session-family.ts";

export const FAMILY_CALL_HEADER = "x-dimensio-family-call";
const ID_RE = /^[A-Za-z0-9_-]{8,100}$/;
const str = (v: unknown, n: number) => String(v ?? "").slice(0, n);

function fromBridge(req: Request, res: Response): boolean {
  if (req.get(FAMILY_CALL_HEADER) === "1") return true;
  res.status(403).json({ ok: false, error: "only bridge itself may call this" });
  return false;
}

export function registerFamilyRoutes(app: Express): void {
  app.get("/api/family", (_req, res) => {
    res.json(familyView());
  });

  app.get("/api/family/related/:id", async (req, res) => {
    const id = String(req.params.id);
    if (!ID_RE.test(id)) {
      res.status(400).json({ error: "bad session id" });
      return;
    }
    res.json(await relatedSessions(id, { reports: true }));
  });

  app.post("/api/family/spawn", async (req, res) => {
    if (!fromBridge(req, res)) return;
    const b = req.body ?? {};
    const r = await inboundSpawn({
      parent: str(b.parent, 100),
      parentTitle: str(b.parentTitle, 120),
      parentName: str(b.parentName, 40),
      title: str(b.title, 60),
      prompt: str(b.prompt, 32_000),
      background: str(b.background, 32_000),
      ...(b.project ? { project: str(b.project, 300) } : {}),
      ...(b.model ? { model: str(b.model, 120) } : {}),
      ...(b.name ? { name: str(b.name, 24) } : {}),
    });
    if (!r.ok) {
      res.status(r.code === "refused" ? 403 : r.code === "bad" ? 400 : 409).json({ ok: false, code: r.code, error: r.reason });
      return;
    }
    res.json(r);
  });

  app.post("/api/family/deliver", async (req, res) => {
    if (!fromBridge(req, res)) return;
    const b = req.body ?? {};
    const r = await inboundDeliver({
      from: str(b.from, 100),
      fromName: str(b.fromName, 40),
      fromTitle: str(b.fromTitle, 120),
      to: str(b.to, 100),
      kind: b.kind === "note" ? "note" : "message",
      text: str(b.text, 20_000),
      status: str(b.status, 20),
    });
    if (!r.ok) {
      res.status(409).json({ ok: false, error: r.reason });
      return;
    }
    res.json(r);
  });

  app.post("/api/family/state", (req, res) => {
    if (!fromBridge(req, res)) return;
    const b = req.body ?? {};
    res.json({ ok: inboundState({ sid: str(b.sid, 100), working: b.working === true }) });
  });

  app.post("/api/family/info", async (req, res) => {
    if (!fromBridge(req, res)) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map((x: unknown) => str(x, 100)).filter((x: string) => ID_RE.test(x)) : [];
    res.json({ ok: true, sessions: await inboundInfo(ids) });
  });
}
