// 会话列表、全局事件通道，以及单个会话的读取、检查点、改写与卫生入口。
import express from "express";
import path from "node:path";
import { stat } from "node:fs/promises";
import { getSession, waitingOf, liveSessionMetas, workspaceRoot, pendingSummary, watchGlobal, sessionRecord, mirrorBaseCount, recordFp, pendingInteractions, watchSession, deleteSession, sessionWorkspace, rollbackSession, sessionUsage, goalAction, restoreSessionFiles, rewindSession, undoRewind, compactSession, handoffPlan, decidedBy, handoffWithSummary } from "../session.ts";
import { visibleMessages } from "../agent/state.ts";
import { loadWorkflowDetail } from "../agent/workflow.ts";
import { listSessionsPage, loadSessionResult, unsupportedVersionMessage, sessionFilePath, loadSession, sessionsDir } from "../store.ts";
import { sessionAssetExists, sessionAssetForServing } from "../image-assets.ts";
import { inspectRecord, inspectSessionFile } from "../session-health.ts";
import { writeDiagnostics } from "../diagnostics.ts";
import { ERROR_CODES, sendError } from "../errors.ts";
import { listCheckpoints, checkpointDiff, reviewablePath } from "../checkpoints.ts";
import { ledgerRows, sanitizeLedger } from "../usage-ledger.ts";
import { archiveViewOf, archiveFilter, isArchived, notifyPrefs } from "../sessmgmt/index.ts";
import { quickSessionFilter, isQuickPath } from "../quick.ts";
import { Sandbox } from "../sandbox.ts";
import { inertFileHeaders } from "../inert-file.ts";
import { backlogGuard } from "../sse-backlog.ts";
import { MAX_QUERY_CHARS, searchSessions } from "../session-search.ts";
import { SSE_PING_MS, sendUnreadable } from "./shared.ts";

export function registerSessionListRoutes(app: express.Express): void {
  // ── Persisted sessions (list / read / delete) ────────────────────────────────

  // 在跑或在等人的会话：快照过滤器据此留住旧桶里还没收尾的那条
  const sessionBusy = (id: string): boolean => {
    const live = getSession(id);
    return Boolean(live && (live.running || waitingOf(live)));
  };

  // Newest-first sessions. Response stays a bare array (the frontend and the bridge
  // page both consume it that way); paging is opt-in via ?offset=/?limit=, with the
  // full count in X-Total-Count so a client can tell there are older ones. Without
  // this, everything past the 100th newest session was unreachable, period.
  app.get("/api/sessions", async (req, res) => {
    const archiveView = archiveViewOf(req.query.archived);
    const page = await listSessionsPage({
      offset: Number(req.query.offset) || 0,
      limit: Number(req.query.limit) || undefined,
      // 快照对话：只留当前那条 + 还在跑 / 刚动过的（见 quickSessionFilter），且置顶保住第一页
      // （否则聊久了会被新会话挤出列表，侧栏那条快照就凭空消失了）。
      // 会话管理：默认不列已归档的；?archived=only 只列已归档、include 都列
      filter: archiveFilter(archiveView, quickSessionFilter({ busy: sessionBusy })),
      pin: (m) => isQuickPath(m.workspace),
      live: liveSessionMetas(),
    });
    res.setHeader("X-Total-Count", String(page.total));
    res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
    res.json(
      page.items.map((m) => {
        const live = getSession(m.id);
        return {
          ...m,
          // 快照会话（哪只桶都算）：侧栏把它们全放进快照区，不按「当前桶路径」认——别处换了快照桶也不丢
          ...(isQuickPath(m.workspace) ? { quick: true } : {}),
          workspace: m.workspace || workspaceRoot(),
          running: live?.running ?? false,
          // P8（X34）：在等你回答 / 批准 / 审计划——侧栏据此标「等你」
          waiting: live ? (waitingOf(live)?.kind ?? null) : null,
          ...(archiveView !== "exclude" && isArchived(m.id) ? { archived: true } : {}),
        };
      }),
    );
  });

  // K10（D5）：侧栏搜索的正文命中（可见正文：用户的话 + 助手正文）。要注册在 /api/sessions/:id 之前，否则 search 被当成会话 id。
  // 范围与列表一致（快照桶只露最新一条）；q 走查询串、截到 100 字。
  app.get("/api/sessions/search", async (req, res) => {
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, MAX_QUERY_CHARS) : "";
    // 会话管理：默认不搜已归档的；?archived=only / include 同列表
    const archiveView = archiveViewOf(req.query.archived);
    const found = await searchSessions(q, { limit: Number(req.query.limit) || undefined, filter: archiveFilter(archiveView, quickSessionFilter({ busy: sessionBusy })) });
    res.json({
      items: found.items.map((h) => ({ ...h, workspace: h.workspace || workspaceRoot(), ...(archiveView !== "exclude" && isArchived(h.id) ? { archived: true } : {}) })),
    });
  });

  // P8（K35）：轻量「谁在跑、谁在等你」摘要。bridge apk 的原生通知服务轮询它——WebView 被冻结（锁屏、久在后台）
  // 时 JS 发不了通知，原生服务照样能发。只有终态事实：在等哪一类、哪个工具，不带命令 / 路径 / 模型原文。
  app.get("/api/pending", (_req, res) => {
    // notify：通知三项偏好（会话管理），原生通知服务据此不弹关掉的那类
    res.json({ ...pendingSummary(), notify: notifyPrefs() });
  });

  // P8（K30）：全局事件通道。先发一份快照（快照里已经在等的不算「新出现」，前端不为它们弹通知），之后每次会话状态
  // 变化（开跑 / 收尾 / 挂起一张卡 / 卡落定）发一条 session_status；15 秒一个 ping。慢消费者积压过多就断开，
  // 客户端重连时重新拿快照。
  app.get("/api/events", (req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const send = (ev: Record<string, unknown>) => {
      if (res.destroyed || res.writableEnded) return;
      if (res.writableLength > 1 << 20) {
        res.end();
        return;
      }
      res.write(`data: ${JSON.stringify(ev)}\n\n`);
    };
    send({ e: "snapshot", ...pendingSummary() });
    const off = watchGlobal(send);
    const ping = setInterval(() => {
      if (!res.destroyed && !res.writableEnded) res.write(": ping\n\n");
    }, SSE_PING_MS);
    ping.unref?.();
    const close = () => {
      off();
      clearInterval(ping);
    };
    req.on("close", close);
    res.on("close", close);
  });
}

export function registerSessionRecordRoutes(app: express.Express): void {
  // Lightweight liveness probe for the reconnect path: a phone waking from
  // background asks this before deciding how to re-attach, so the answer must
  // not require pulling the full transcript over a mobile link.
  app.get("/api/sessions/:id/status", async (req, res) => {
    const id = String(req.params.id);
    const live = getSession(id);
    if (live) {
      // fp comes from the same in-memory record the transcript endpoint serves, so
      // "fingerprint unchanged" can never mean "the record moved but the file
      // hasn't been written yet" (persistNow lands after running flips false).
      const rec = live.state ? sessionRecord(live) : null;
      res.json({
        exists: true,
        running: live.running,
        runStartMsgCount: live.running ? mirrorBaseCount(live) : undefined,
        runId: live.running ? live.runId ?? undefined : undefined,
        fp: rec ? recordFp(rec) : undefined,
        // 瘦身 P0-1：上一轮收尾后的记忆沉淀还在后台跑（评测台等它落定再读记忆）
        ...(live.memoryJob ? { memoryPending: true } : {}),
      });
      return;
    }
    // Not in memory ⇒ definitely not running; disk decides whether it exists at all.
    // M7：更新版本写的会话也「存在」（只读），只是没有可比的指纹。
    const r = await loadSessionResult(id);
    if (r.kind === "unreadable") {
      sendUnreadable(res, r); // Q14：不冒充「不存在」——客户端据此稍后重试，而不是把会话当成没了
      return;
    }
    res.json({
      exists: r.kind === "ok" || r.kind === "unsupported-version",
      running: false,
      fp: r.kind === "ok" ? recordFp(r.rec) : undefined,
    });
  });

  app.get("/api/sessions/:id", async (req, res) => {
    const id = String(req.params.id);
    // Prefer the live in-memory state (fresher than the last disk snapshot).
    const live = getSession(id);
    const loaded = live?.state ? null : await loadSessionResult(id);
    if (loaded?.kind === "unsupported-version") {
      // M7：更新版本写的会话——只读展示（不给 config，前端沿用当前档位；要发消息会被拒并说明原因）。
      const v = loaded.view;
      let messages: unknown[] = [];
      try {
        messages = visibleMessages(v.messages);
      } catch {
        /* 新版本的消息形状不认识就只给标题 */
      }
      res.json({
        id: v.id,
        title: v.title,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
        messages,
        running: false,
        readOnly: { version: v.version, reason: unsupportedVersionMessage(v.version) },
      });
      return;
    }
    if (loaded?.kind === "unreadable") {
      sendUnreadable(res, loaded);
      return;
    }
    const rec = live?.state ? sessionRecord(live) : loaded?.kind === "ok" ? loaded.rec : null;
    if (!rec) {
      res.status(404).json({ error: "unknown session", code: ERROR_CODES.sessionNotFound });
      return;
    }
    // The system prompt is bulky and not needed to render a transcript.
    // runStartMsgCount (only meaningful while running) lets a mirroring client
    // rebuild the pre-run transcript and replay the live event stream on top.
    res.json({
      ...rec,
      messages: visibleMessages(rec.messages),
      system: undefined,
      prefixBaseline: undefined, // Q4：上一次请求的前缀指纹是给服务端接着比的，几十 KB 的哈希不往手机上送
      running: live?.running ?? false,
      runStartMsgCount: live?.running ? mirrorBaseCount(live) : undefined,
      runId: live?.running ? live.runId ?? undefined : undefined, // M2：附着到的是哪一轮
      // M1：挂着等人处理的问答 / 权限 / 计划卡（整份重建时客户端据此把卡片找回来）
      pending: live?.running ? pendingInteractions(live) : undefined,
      // 客户端记下这份记录的指纹，下次回到这个会话先问 /status，一样就不必再拉一遍
      fp: recordFp(rec),
    });
  });

  // Q4（K46）：这个会话最近的请求记录——每次请求是不是上一次的纯追加、断在哪、为什么、重发多少、带了哪些注入片段、
  // 用了多少缓存。只有哈希与计数，不含正文。只在会话还在内存里时有逐条记录；累计数随会话落盘，不在内存也给。
  app.get("/api/sessions/:id/requests", async (req, res) => {
    const id = String(req.params.id);
    const live = getSession(id);
    if (live?.state) {
      const st = live.state;
      res.json({
        live: true,
        totals: st.prefix.totals,
        usage: { input: st.totalInputTokens, output: st.totalOutputTokens, cacheRead: st.totalCacheReadTokens, cacheWrite: st.totalCacheWriteTokens },
        requests: st.prefix.recent,
      });
      return;
    }
    const loaded = await loadSessionResult(id);
    if (loaded.kind === "unreadable") {
      sendUnreadable(res, loaded);
      return;
    }
    if (loaded.kind !== "ok") {
      res.status(404).json({ error: "unknown session", code: ERROR_CODES.sessionNotFound });
      return;
    }
    const t = loaded.rec.totals;
    res.json({
      live: false,
      totals: t?.prefix ?? null,
      usage: { input: t?.inputTokens ?? 0, output: t?.outputTokens ?? 0, cacheRead: t?.cacheReadTokens ?? 0, cacheWrite: t?.cacheWriteTokens ?? 0 },
      requests: [],
    });
  });

  // Q5（K49）：会话体检——守恒问题清单（配对、可见性、媒体引用、续写链……）与复盘统计（只有聚合数字，不含正文）。
  // 只读：在内存里就查内存里的记录，否则只读地解析盘上文件（不走会隔离坏文件的那条加载路）。
  app.get("/api/sessions/:id/health", (req, res) => {
    const id = String(req.params.id);
    const opts = { assetExists: (asset: string) => sessionAssetExists(id, asset) };
    const live = getSession(id);
    const rec = live?.state ? sessionRecord(live) : null;
    if (rec) {
      res.json(inspectRecord(rec, opts));
      return;
    }
    const file = sessionFilePath(id);
    if (!file) {
      res.status(400).json({ error: "invalid session id" });
      return;
    }
    const report = inspectSessionFile(file, id, opts);
    res.status(report.load === "not-found" ? 404 : 200).json(report);
  });

  // Session-scoped assistant output. The card carries only a workspace-relative
  // path; every open/download resolves it again through that session's original
  // sandbox boundary and secret guard. Express sendFile provides Range support
  // for the shared image/video/document viewer.
  app.get("/api/sessions/:id/artifact", async (req, res) => {
    const id = String(req.params.id);
    const rel = String(req.query.path ?? "").trim();
    if (!rel) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    const live = getSession(id);
    const persisted = live?.state ? sessionRecord(live) : await loadSession(id);
    const cfg = live?.cfg ?? persisted?.config;
    if (!cfg) {
      res.status(404).json({ error: "unknown session" });
      return;
    }
    try {
      const key = rel.replace(/\\/g, "/").toLocaleLowerCase();
      const allowed = persisted?.messages.some((message) =>
        message.role === "assistant" && !message.internal && message.artifacts?.some(
          (artifact) => artifact.path.replace(/\\/g, "/").toLocaleLowerCase() === key,
        ),
      );
      if (!allowed) throw new Error("artifact was not attached to this session");
      const sandbox = new Sandbox(cfg.workspace ?? workspaceRoot(), cfg.access ?? "workspace");
      const abs = sandbox.resolve(rel);
      const info = await stat(abs);
      if (!info.isFile()) throw new Error("not a file");
      const name = path.basename(abs).replace(/[\r\n"]/g, "_");
      const disposition = req.query.dl === "1" ? "attachment" : "inline";
      res.setHeader("Cache-Control", "private, no-cache");
      res.setHeader("Content-Disposition", `${disposition}; filename*=UTF-8''${encodeURIComponent(name)}`);
      // #65：同 /api/dock/file——活动类型一律纯文本 + 禁执行。
      inertFileHeaders(res, abs);
      // Sandbox.resolve already applies containment + secret guards. Allowing a
      // dotted workspace segment here is necessary for valid projects such as
      // `.workspace`; Express would otherwise turn an authorized file into 403.
      res.sendFile(abs, { dotfiles: "allow" }, (error) => {
        if (error && !res.headersSent) res.status((error as any).statusCode || 404).end();
      });
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  // R12（二，K31）：会话资产（截图、上传的图 / 音视频）给界面按 URL 取——截图事件不再带 base64，只带资产 id。
  // 文件名是内容哈希，可以长缓存；只认这个会话自己的资产目录（id 与文件名都过白名单正则）。
  app.get("/api/sessions/:id/assets/:asset", async (req, res) => {
    const id = String(req.params.id);
    const live = getSession(id);
    const known = live?.state ? true : Boolean(await loadSession(id));
    const asset = known ? sessionAssetForServing(id, String(req.params.asset)) : null;
    if (!asset) {
      res.status(404).json({ error: known ? "unknown asset" : "unknown session" });
      return;
    }
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("Content-Type", asset.mime);
    res.setHeader("X-Content-Type-Options", "nosniff");
    // 会话存储可能落在带点的目录下（数据根自定义时），这里的路径已经过白名单，不按 dotfile 拒
    res.sendFile(asset.file, { dotfiles: "allow" }, (error) => {
      if (error && !res.headersSent) res.status(404).end();
    });
  });

  // Per-agent detail of a finished workflow run (prompt / tool trail / answer) for
  // the dock's task panel. It lives in the run's journal rather than the
  // transcript (see WorkflowAgentDetail); the panel asks only when someone opens
  // one agent. Scoped: the run must be recorded in this session's transcript.
  app.get("/api/sessions/:id/workflows/:wfId", async (req, res) => {
    const id = String(req.params.id);
    const wfId = String(req.params.wfId);
    const live = getSession(id);
    const rec = live?.state ? sessionRecord(live) : await loadSession(id);
    if (!rec) {
      res.status(404).json({ error: "unknown session" });
      return;
    }
    const owned = rec.messages.some((m) =>
      m.role === "user" && m.content.some((b) =>
        b.t === "tool_result" && (b as { meta?: { workflow?: { id?: string } } }).meta?.workflow?.id === wfId,
      ),
    );
    const detail = owned ? loadWorkflowDetail(path.join(sessionsDir(), "workflows"), wfId) : null;
    if (!detail) {
      res.status(404).json({ error: "no detail for this workflow run" });
      return;
    }
    res.setHeader("Cache-Control", "private, no-cache");
    res.json(detail);
  });

  // Live mirror: attach to a RUNNING session's event stream from another device —
  // replays the current run's events so far, then streams live until the run ends.
  app.get("/api/sessions/:id/stream", (req, res) => {
    const session = getSession(String(req.params.id));
    if (!session?.running) {
      res.status(409).json({ error: "session is not running" });
      return;
    }
    // 客户端的底座是按 runId 那一轮切的（先拉记录、再来附着）。两步之间那一轮收尾、下一轮开跑了（停掉马上又发一条，
    // 大会话的记录经隧道要拉好几秒）——这里重放的是新一轮的事件，拼在旧底座上新一轮的用户消息就没了（11-07 维护者实测）。
    // 对不上就 409，客户端照常对账、按新一轮重拉底座。不带 runId 的旧客户端照旧。
    const want = typeof req.query.runId === "string" && req.query.runId ? req.query.runId : undefined;
    if (want && session.runId !== want) {
      res.status(409).json({ error: "run_mismatch", currentRunId: session.runId ?? null });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    const open = () => !res.destroyed && !res.writableEnded;
    const send = (obj: unknown) => {
      if (open()) res.write(`data: ${JSON.stringify(obj)}\n\n`);
    };
    // M9（N34）：直播积压超限就断开（客户端断线对账、重新附着拿压实过的重放）；附着时的重放不算积压
    const backlog = backlogGuard(res);
    const unsub = watchSession(session, (ev) => {
      send(ev);
      if ((ev as any).e === "mirror_end") res.end();
      else if (backlog.over()) res.destroy();
    });
    backlog.arm();
    const heartbeat = setInterval(() => {
      if (open()) res.write(": ping\n\n");
    }, SSE_PING_MS);
    res.on("close", () => {
      clearInterval(heartbeat);
      unsub();
    });
  });

  // Q13：一键诊断包——写进会话工作区的 .dimensio/diagnostics/<id>/，回一个「产物」给前端打开（手机上走 bridge 查看器分享 / 另存）。
  // 会话摘要只放结构（条数、角色 / 注入类别、工具名计数、配置、用量）——不放对话正文、不放 key。
  app.post("/api/sessions/:id/diagnostics", async (req, res) => {
    const id = String(req.params.id);
    try {
      const live = getSession(id);
      const rec = live ? sessionRecord(live) : await loadSession(id);
      if (!rec) {
        res.status(404).json({ error: "unknown session" });
        return;
      }
      const roles: Record<string, number> = {};
      const tools: Record<string, number> = {};
      for (const m of rec.messages) {
        const key = `${m.role}${m.internal ? ":internal" : ""}${m.kind ? `:${m.kind}` : ""}`;
        roles[key] = (roles[key] ?? 0) + 1;
        for (const b of m.content) if (b.t === "tool_call") tools[b.name] = (tools[b.name] ?? 0) + 1;
      }
      const lastError = live ? [...live.runLog].reverse().find((e) => e.e === "error") : undefined;
      res.json(await writeDiagnostics({
        sessionId: id,
        workspace: rec.config?.workspace ?? workspaceRoot(),
        session: {
          id,
          title: rec.title,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
          running: live?.running ?? false,
          runId: live?.runId ?? null,
          config: rec.config,
          totals: rec.totals,
          messages: rec.messages.length,
          roles,
          tools,
          ...(lastError ? { lastError: String(lastError.message ?? "") } : {}),
          pending: live ? pendingInteractions(live).map((p) => p.e) : [],
        },
        health: ((file) => (file ? inspectSessionFile(file, id) : null))(sessionFilePath(id)),
      }));
    } catch (error) {
      res.status(500).json({ error: (error as Error).message });
    }
  });

  // 删除会话 = 先回收它名下的轮次、后台 job、Preview 服务与浏览器，再删记录（M5，见 deleteSession）。
  app.delete("/api/sessions/:id", async (req, res) => {
    const { deleted } = await deleteSession(String(req.params.id));
    res.json({ deleted });
  });

  // POST 别名：bridge 反代的全局 CORS 只允许 GET/POST，跨源 DELETE 过不了预检；
  // 安卓壳走 bridge 通道删会话用这个（语义同 DELETE，幂等）。
  app.post("/api/sessions/:id/delete", async (req, res) => {
    const { deleted } = await deleteSession(String(req.params.id));
    res.json({ deleted });
  });

  // ── Checkpoints (per-message snapshots of files + conversation) ─────────────

  app.get("/api/sessions/:id/checkpoints", async (req, res) => {
    res.json(await listCheckpoints(String(req.params.id)));
  });

  // Preview what a rollback would undo: diff from the snapshot to the current tree.
  app.get("/api/sessions/:id/checkpoints/:n/diff", async (req, res) => {
    try {
      const id = String(req.params.id);
      const diff = await checkpointDiff(id, Number(req.params.n), await sessionWorkspace(id));
      res.type("text/plain").send(diff || "(no changes since this checkpoint)");
    } catch (e) {
      res.status(404).json({ error: (e as Error).message });
    }
  });

  app.post("/api/sessions/:id/rollback", async (req, res) => {
    const n = Number(req.body?.n);
    if (!Number.isInteger(n) || n < 1) {
      res.status(400).json({ error: "n (checkpoint number) is required" });
      return;
    }
    // P9（K22）：force = 人看过「对话之外改过的文件」清单、确认照样回滚
    const result = await rollbackSession(String(req.params.id), n, { force: req.body?.force === true });
    if (!result.ok) {
      res.status(409).json({ error: result.error, code: result.code, external: result.external });
      return;
    }
    res.json({ ok: true });
  });

  // O8（N39）：这个会话的用量账本（厂商 × 型号 × 任务）；内存里没有就读记录里的
  app.get("/api/sessions/:id/usage", async (req, res) => {
    const id = String(req.params.id);
    let rows = sessionUsage(id);
    if (!rows.length) {
      const loaded = await loadSessionResult(id);
      if (loaded.kind === "ok") rows = ledgerRows(sanitizeLedger(loaded.rec.usage));
    }
    res.json({ rows });
  });

  // O7（K64）：目标续跑的暂停 / 继续 / 结束。暂停不打断正在跑的这一轮（跑完不再续）；继续再给一份同样的预算，没在跑就立刻起下一轮
  app.post("/api/sessions/:id/goal", async (req, res) => {
    const action = String(req.body?.action ?? "");
    if (action !== "pause" && action !== "resume" && action !== "clear") {
      res.status(400).json({ error: 'action must be "pause", "resume" or "clear"' });
      return;
    }
    const r = await goalAction(String(req.params.id), action);
    if (!r.ok) {
      res.status(r.code === "not_found" ? 404 : 409).json({ error: r.error, code: r.code });
      return;
    }
    res.json({ ok: true, goal: r.goal ?? null });
  });

  // U10（K38）：审阅面板里逐文件撤销这个对话的改动（退回会话开始之前；新建的删掉）。409 的 code：running（有会话在跑）/
  // external（现在的内容不是这个对话留下的，人确认后带 force 再发）/ stale（列表过期）/ unavailable（没有检查点）
  app.post("/api/sessions/:id/files/restore", async (req, res) => {
    const raw: unknown[] = Array.isArray(req.body?.paths) ? req.body.paths : [];
    const paths = raw.filter((p): p is string => typeof p === "string");
    if (!paths.length || paths.length !== raw.length || paths.length > 500 || !paths.every(reviewablePath)) {
      res.status(400).json({ error: "paths (1–500 workspace-relative files) is required" });
      return;
    }
    const result = await restoreSessionFiles(String(req.params.id), paths, { force: req.body?.force === true });
    if (!result.ok) {
      res.status(result.code === "not_found" ? 404 : 409).json({ error: result.error, code: result.code, external: result.external });
      return;
    }
    res.json({ ok: true, restored: result.restored, removed: result.removed, undo: result.undo });
  });

  // U9：「从这里改写」——对话退回到第 ordinal 个用户气泡（字是 text）之前，文件不动；回执带撤销用的检查点号与条数
  app.post("/api/sessions/:id/rewind", async (req, res) => {
    const ordinal = Number(req.body?.ordinal);
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!Number.isInteger(ordinal) || ordinal < 0) {
      res.status(400).json({ error: "ordinal (which user message, 0-based) is required" });
      return;
    }
    const result = await rewindSession(String(req.params.id), { ordinal, text });
    if (!result.ok) {
      res.status(result.code === "not_found" ? 404 : 409).json({ error: result.error, code: result.code });
      return;
    }
    res.json(result);
  });
  app.post("/api/sessions/:id/rewind/undo", async (req, res) => {
    const n = Number(req.body?.n);
    const length = Number(req.body?.length);
    if (!Number.isInteger(n) || n < 1 || !Number.isInteger(length) || length < 0) {
      res.status(400).json({ error: "n (checkpoint) and length (message count after the rewrite) are required" });
      return;
    }
    const result = await undoRewind(String(req.params.id), n, length);
    if (!result.ok) {
      res.status(result.code === "not_found" ? 404 : 409).json({ error: result.error, code: result.code });
      return;
    }
    res.json({ ok: true });
  });

  // C8：上下文卫生入口——立即压缩、带摘要开新会话、计划卡「在新会话中实施」。回执里 sessionId = 新会话
  const hygieneStatus = (r: { ok: boolean; code?: string }) =>
    r.ok ? 200 : r.code === "not_found" ? 404 : r.code === "failed" ? 500 : 409;
  app.post("/api/sessions/:id/compact", async (req, res) => {
    try {
      const r = await compactSession(String(req.params.id));
      res.status(hygieneStatus(r)).json(r);
    } catch (e) {
      sendError(res, e); // 恢复会话时抛的（缺 key、更新版本写的只读会话……）
    }
  });
  app.post("/api/sessions/:id/handoff", async (req, res) => {
    const id = String(req.params.id);
    try {
      const kind = req.body?.kind;
      const r = kind === "plan"
        ? handoffPlan(id, String(req.body?.planId ?? ""), decidedBy(req.body?.by))
        : kind === "summary"
          ? await handoffWithSummary(id)
          : null;
      if (!r) {
        res.status(400).json({ error: 'kind must be "summary" or "plan"' });
        return;
      }
      res.status(hygieneStatus(r)).json(r);
    } catch (e) {
      sendError(res, e);
    }
  });
}
