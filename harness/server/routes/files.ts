// 工作区文件、右侧 dock（审阅 / 文件 / 终端）、目录选择。
import express from "express";
import path from "node:path";
import { stat } from "node:fs/promises";
import { workspaceRoot, sessionWorkspace, sessionReview, sessionReviewDiff } from "../session.ts";
import { reviewablePath } from "../checkpoints.ts";
import { listDir, MAX_UPLOAD_BYTES, saveUpload } from "../files.ts";
import { listDirs, makeDir } from "../fsnav.ts";
import { insideTenant, tenantRoot, assertInTenant } from "../tenant.ts";
import { Sandbox } from "../sandbox.ts";
import { reviewOverview, reviewDiff } from "../review.ts";
import { ensureTerm, snapshotTerm, subscribeTerm, writeTerm, resizeTerm, killTerm } from "../terminal.ts";
import { inertFileHeaders } from "../inert-file.ts";
import { SSE_PING_MS } from "./shared.ts";

export function registerFileRoutes(app: express.Express): void {
  // ── Workspace files (attach feature: browse + upload) ───────────────────────

  app.get("/api/files", async (req, res) => {
    try {
      res.json(await listDir(new Sandbox(workspaceRoot()), String(req.query.path ?? "")));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // Raw-body upload, one file per request (zero-dep: no multipart parsing). The
  // UI iterates a picker's files and posts each with its relative path; folder
  // uploads preserve structure via webkitRelativePath.
  app.post(
    "/api/files/upload",
    async (req, res) => {
      const rel = String(req.query.path ?? "").trim();
      if (!rel) {
        res.status(400).json({ error: "path query parameter is required" });
        return;
      }
      if (Number(req.headers["content-length"] ?? 0) > MAX_UPLOAD_BYTES) {
        res.status(413).json({ error: `file exceeds the ${MAX_UPLOAD_BYTES / 1024 / 1024 / 1024} GB upload limit` });
        return;
      }
      try {
        // 请求体直接流进落点（不再 express.raw 整块进内存、30 MB 封顶）
        const body = req;
        // U4（K08）：落在这个会话的工作区（以前一律是全局工作区——和会话的工作区未必是同一个，附件会找不到）；
        // 新对话还没有会话 id 时照旧用全局（发送时的配置快照也是它）
        const sessionId = String(req.query.sessionId ?? "").trim();
        const root = sessionId ? await sessionWorkspace(sessionId) : workspaceRoot();
        res.json(await saveUpload(new Sandbox(root), rel, body));
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
      }
    },
  );

  // ── Dock 工作区（右侧栏：审阅 / 文件树 / 终端）───────────────────────────────
  // 桌面端右侧 dock 面板的后端：git 审阅（变更概览 + 单文件 diff）、工作空间文件
  // 浏览（复用 attach 特性的 listDir + Sandbox 护栏）、per-workspace PTY 终端
  // （SSE 流 + 输入/缩放/杀死）。全部 GET/POST（bridge 反代只放行这两个方法），
  // 全局鉴权中间件已罩住所有 /api/*。harness 内无身份概念，per-user 门禁在
  // bridge 层完成；这里只做 ws 解析与存在性校验（dockWs）。

  // ws 解析：query/body 的 ws（可选绝对路径）→ path.resolve；缺省时带 chatId 用
  // 该会话的工作空间，再缺省当前全局工作空间。必须存在且是目录，否则 400/404。
  async function dockWs(req: express.Request, res: express.Response): Promise<string | null> {
    const raw = String(req.query.ws ?? req.body?.ws ?? "").trim();
    const chatId = String(req.query.chatId ?? req.body?.chatId ?? "").trim();
    const ws = raw
      ? path.resolve(raw)
      : chatId
        ? await sessionWorkspace(chatId)
        : workspaceRoot();
    let info;
    try {
      info = await stat(ws);
    } catch {
      res.status(404).json({ error: `workspace not found: ${ws}` });
      return null;
    }
    if (!info.isDirectory()) {
      res.status(400).json({ error: `not a directory: ${ws}` });
      return null;
    }
    // 租户实例：dock（审阅 / 文件 / 终端）只能开在他自己的文件夹里，别的目录一律不给看。
    if (!insideTenant(ws)) {
      res.status(403).json({ error: "that folder is outside your workspace" });
      return null;
    }
    return ws;
  }

  // U10（K38）：scope=session → 这个会话的「本会话」视图（基线 = 会话第一张检查点；工作区按会话自己的，不看 ws）
  const sessionScope = (req: express.Request): string | null =>
    String(req.query.scope ?? "") === "session" ? String(req.query.chatId ?? "").trim() : null;

  app.get("/api/dock/review", async (req, res) => {
    const chatId = sessionScope(req);
    if (chatId !== null) {
      if (!chatId) {
        res.status(400).json({ error: "chatId is required for scope=session" });
        return;
      }
      try {
        res.json(await sessionReview(chatId));
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
      return;
    }
    const ws = await dockWs(req, res);
    if (!ws) return;
    res.json(await reviewOverview(ws));
  });

  // 单文件 diff（懒加载展开）。未跟踪标记用 u=1——绝不用 st= 作参数名（st 在
  // bridge 身份层是分享 token 保留查询参数，会被误解析成过期 token → 401）。
  app.get("/api/dock/review/diff", async (req, res) => {
    const chatId = sessionScope(req);
    if (chatId !== null) {
      const file = String(req.query.file ?? "");
      if (!chatId || !reviewablePath(file)) {
        res.status(400).json({ error: "chatId and a workspace-relative file are required" });
        return;
      }
      try {
        const r = await sessionReviewDiff(chatId, file);
        if (!r) {
          res.status(404).json({ error: "this conversation has no checkpoints" });
          return;
        }
        res.json(r);
      } catch (e) {
        res.status(500).json({ error: (e as Error).message });
      }
      return;
    }
    const ws = await dockWs(req, res);
    if (!ws) return;
    const r = await reviewDiff(
      ws,
      String(req.query.file ?? ""),
      String(req.query.from ?? ""),
      String(req.query.u ?? "") === "1",
    );
    if (!r.ok) {
      res.status(r.status).json({ error: r.error });
      return;
    }
    res.json({ diff: r.diff, truncated: r.truncated, bin: r.bin });
  });

  app.get("/api/dock/files", async (req, res) => {
    const ws = await dockWs(req, res);
    if (!ws) return;
    try {
      // listDir 原生 shape：{ path: 当前 rel, entries, truncated }（500 条 cap）。
      res.json(await listDir(new Sandbox(ws, "workspace"), String(req.query.path ?? "")));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  // 读工作空间内单个文件（dock 文件预览）。Sandbox.resolve 自带逃逸 + 敏感文件
  // （.env/.ssh/…）护栏：敏感路径 403，非法/逃逸 400，不存在 404。
  app.get("/api/dock/file", async (req, res) => {
    const ws = await dockWs(req, res);
    if (!ws) return;
    const rel = String(req.query.path ?? "").trim();
    if (!rel) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    let abs: string;
    try {
      abs = new Sandbox(ws, "workspace").resolve(rel);
    } catch (e) {
      const msg = (e as Error).message;
      res.status(/secret guard/i.test(msg) ? 403 : 400).json({ error: msg });
      return;
    }
    try {
      const info = await stat(abs);
      if (!info.isFile()) throw new Error("not a file");
    } catch {
      res.status(404).json({ error: `not found: ${rel}` });
      return;
    }
    res.setHeader("Cache-Control", "private, no-cache");
    // #65：agent 写的 html/svg/js 不能以活动内容落在 bridge 源上（链接里带着令牌）。
    inertFileHeaders(res, abs);
    // Sandbox.resolve 已圈定边界与敏感文件；允许带点路径段（.workspace 这类合法
    // 项目目录），否则 Express 会把已授权文件拦成 403。
    res.sendFile(abs, { dotfiles: "allow" }, (error) => {
      if (error && !res.headersSent) res.status((error as any).statusCode || 404).end();
    });
  });

  // 终端 SSE 流：连接即 hello（实际 cols/rows + 是否已退出），有滚回缓冲先发
  // snapshot 重放，之后 pty onData → data、onExit → exit。15s 心跳；客户端断开
  // 只退订，壳本身存活（重连拿快照继续）。
  app.get("/api/dock/term/stream", async (req, res) => {
    const ws = await dockWs(req, res);
    if (!ws) return;
    let t;
    try {
      t = ensureTerm(ws, req.query.cols, req.query.rows);
    } catch (e) {
      res.status((e as any).status || 500).json({ error: (e as Error).message });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (obj: unknown): boolean => {
      if (res.destroyed || res.writableEnded) return false;
      try {
        res.write(`data: ${JSON.stringify(obj)}\n\n`);
        return true;
      } catch {
        return false;
      }
    };
    send({ e: "hello", cols: t.cols, rows: t.rows, exited: t.exited });
    const snap = snapshotTerm(t);
    if (snap) send({ e: "snapshot", d: snap });
    const unsub = subscribeTerm(t, (ev) => {
      if (ev.kind === "data") send({ e: "data", d: ev.d });
      else send({ e: "exit", code: ev.code });
    });
    const heartbeat = setInterval(() => {
      if (res.destroyed || res.writableEnded) {
        clearInterval(heartbeat);
        unsub();
      } else {
        res.write(": ping\n\n");
      }
    }, SSE_PING_MS);
    res.on("close", () => {
      clearInterval(heartbeat);
      unsub();
    });
  });

  app.post("/api/dock/term/input", async (req, res) => {
    const ws = await dockWs(req, res);
    if (!ws) return;
    res.json({ ok: writeTerm(ws, String(req.body?.data ?? "")) });
  });

  app.post("/api/dock/term/resize", async (req, res) => {
    const ws = await dockWs(req, res);
    if (!ws) return;
    const r = resizeTerm(ws, req.body?.cols, req.body?.rows);
    if (!r) {
      res.status(409).json({ error: "terminal not running" });
      return;
    }
    res.json({ ok: true, cols: r.cols, rows: r.rows });
  });

  app.post("/api/dock/term/kill", async (req, res) => {
    const ws = await dockWs(req, res);
    if (!ws) return;
    res.json({ ok: killTerm(ws) });
  });

  // ── Workspace picker (Settings): whole-machine DIRECTORY navigation ─────────
  // Directory names only; both routes are GET/POST so they pass the bridge
  // proxy's CORS preflight (which only allows those methods).

  app.get("/api/fs/dirs", async (req, res) => {
    try {
      // 租户实例：只在他自己的文件夹里翻（没给路径就从他的根开始），往上翻到根为止。
      const root = tenantRoot();
      const raw = String(req.query.path ?? "");
      const target = root && !raw.trim() ? root : raw;
      if (root) assertInTenant(path.resolve(target.trim() || root), "目录");
      const listing = await listDirs(target);
      if (root) {
        if (listing.parent && !insideTenant(listing.parent)) listing.parent = null;
        listing.drives = [];
      }
      res.json(listing);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });

  app.post("/api/fs/mkdir", async (req, res) => {
    try {
      const p = String(req.body?.path ?? "");
      if (p.trim()) assertInTenant(path.resolve(p.trim()), "目录");
      res.json(await makeDir(p));
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
    }
  });
}
