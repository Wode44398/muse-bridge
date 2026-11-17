// 发送一轮（SSE）、停止、卡片落定、会话级开关与插话。
import express from "express";
import { cleanClientRunId, lookupClientRun, getOrLoadSession, createSession, getSession, sessionRecord, startRun, watchSession, stopSession, answerAsk, decidedBy, resolvePermission, resolvePlan, setSessionMode, setSessionAway, setSessionAccess, setSessionModel, revokeReadRoot, steerSession, withdrawSteer, interruptWithSteer } from "../session.ts";
import { retiring } from "../retire.ts";
import { sendError, ERROR_CODES } from "../errors.ts";
import { newGoal } from "../goal.ts";
import { syncConnectors, mcpReady } from "../mcp.ts";
import { sessionConfigSnapshot } from "../config.ts";
import { moveForegroundToBackground, listJobs, stopJob } from "../tools/bash.ts";
import { backlogGuard } from "../sse-backlog.ts";
import { referenceDigests } from "../session-refs.ts";
import { RETIRING_ERROR, SSE_PING_MS, sessionForRequest } from "./shared.ts";

export function registerRunRoutes(app: express.Express): void {
  // ── Run (SSE stream) ─────────────────────────────────────────────────────────



  app.post("/api/run", async (req, res) => {
    if (retiring()) {
      res.status(503).json(RETIRING_ERROR);
      return;
    }
    const { sessionId, message, deadlineMs, maxTurns } = req.body ?? {};
    // M2（#51）：发送幂等。同一个 clientRunId 已经起过一轮（上一次 POST 其实落地了，只是回包没到）→ 不再起
    // 第二轮，告诉客户端去附着那一轮。
    const clientRunId = cleanClientRunId(req.body?.clientRunId);
    const landed = clientRunId ? lookupClientRun(clientRunId) : null;
    if (landed) {
      res.status(409).json({ error: "duplicate_run", ...landed });
      return;
    }
    const rawAttachments = req.body?.attachments;
    if (rawAttachments !== undefined && !Array.isArray(rawAttachments)) {
      res.status(400).json({ error: "attachments must be an array of workspace paths" });
      return;
    }
    const attachments = (rawAttachments ?? []).map((item: unknown) =>
      typeof item === "string" ? item : String((item as any)?.path ?? ""),
    ).filter(Boolean);
    // 引用会话：只引用、一个字不写也算有内容
    const wantsRefs = Array.isArray(req.body?.refs) && req.body.refs.length > 0;
    if (typeof message !== "string" || (!message.trim() && !attachments.length && !wantsRefs)) {
      res.status(400).json({ error: "message or attachments are required" });
      return;
    }
    // Optional per-run budget: wall-clock and/or model-turn cap (see loop.ts).
    const budget = {
      deadlineMs: Number(deadlineMs) > 0 ? Number(deadlineMs) : undefined,
      maxTurns: Number(maxTurns) > 0 ? Number(maxTurns) : undefined,
    };

    // M11（N33）：新会话由发起端带上界面显示的配置快照（全局配置只作默认——它是「最后一个切前台的设备」写的）。
    // 按设置页同一套规则校验；老客户端不带就照旧读全局。
    let initial;
    if (!sessionId && req.body?.config !== undefined) {
      try {
        initial = sessionConfigSnapshot(req.body.config);
      } catch (e) {
        res.status(400).json({ error: (e as Error).message });
        return;
      }
    }

    // E1：新会话要按此刻连上的 MCP 连接器拍基线——先对一遍注册表，还在连的最多等 3 秒（连不上的只是这个会话没有它）
    if (!sessionId) {
      await syncConnectors();
      await mcpReady(3_000);
    }

    // 项目对话（project-mode.ts）：形态只认新会话第一轮带来的 shape:"project"；续聊时带了也不管（形态定下来就不变）
    const shape = !sessionId && req.body?.shape === "project" ? ("project" as const) : undefined;

    // A sessionId not in memory is resumed from disk (survives server restarts).
    let session;
    try {
      session = sessionId ? await getOrLoadSession(String(sessionId)) : createSession(initial, { shape });
    } catch (e) {
      // e.g. the persisted provider's API key is no longer configured（Q14：带码的按自己的状态码与稳定码回）
      sendError(res, e);
      return;
    }
    if (!session) {
      res.status(404).json({ error: "unknown sessionId", code: ERROR_CODES.sessionNotFound });
      return;
    }

    // 引用会话：被引用对话的摘要先做好（读记录要 await，startRun 必须同步占住会话；也得在下面的查重之前——查 + 起之间
    // 不能有 await）；在跑的会话取内存里的
    const refs = wantsRefs
      ? await referenceDigests(req.body.refs, {
          selfId: session.id,
          live: (id) => {
            const live = getSession(id);
            return live ? sessionRecord(live) : null;
          },
        })
      : [];
    // 上面 await 期间同一个 clientRunId 可能刚被另一路请求起了（查 + 起之间没有 await，这里是原子的）
    const raced = clientRunId ? lookupClientRun(clientRunId) : null;
    if (raced) {
      res.status(409).json({ error: "duplicate_run", code: ERROR_CODES.duplicateRun, ...raced });
      return;
    }
    // O7：这条消息开一个目标（goal: { verify?, maxRounds?, maxMinutes? }）——这一轮没起来就还原
    const prevGoal = session.goal;
    const goalReq = req.body?.goal;
    if (goalReq && typeof goalReq === "object" && message.trim()) session.goal = newGoal(message.trim(), goalReq as Record<string, unknown>);
    let run;
    try {
      run = startRun(session, message.trim(), budget, attachments, clientRunId, { refs });
    } catch (e) {
      session.goal = prevGoal;
      res.status(400).json({ error: (e as Error).message });
      return;
    }
    if (!run.started) session.goal = prevGoal;
    if (!run.started) {
      if (run.retiring) res.status(503).json(RETIRING_ERROR);
      else if (run.rollingBack) res.status(409).json({ error: "a rollback is in progress — try again in a moment", code: ERROR_CODES.rollingBack });
      else res.status(409).json({ error: "session is already running", code: ERROR_CODES.sessionRunning });
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

    // 送达回执：收到这一条 = 这一轮已经在服务端起来了（runId 供停止 / 插话做前置条件）
    send({ e: "session", sessionId: session.id, runId: session.runId });
    let detached = false;
    let heartbeat: NodeJS.Timeout | null = null;
    let unsubscribe = () => {};
    const detach = () => {
      if (detached) return;
      detached = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    };
    const finish = () => {
      if (detached) return;
      send({ e: "closed" });
      detach();
      if (!res.writableEnded) res.end();
    };
    // M9（N34）：直播积压超限就断开这台设备（它照常断线对账、重新附着）；重放写完才开始算
    const backlog = backlogGuard(res);
    unsubscribe = watchSession(session, (ev) => {
      if ((ev as any).e === "mirror_end") finish();
      else if (!send(ev)) detach();
      else if (backlog.over()) {
        detach();
        res.destroy();
      }
    });
    backlog.arm();
    heartbeat = setInterval(() => {
      if (res.destroyed || res.writableEnded) detach();
      else res.write(": ping\n\n");
    }, SSE_PING_MS);

    // The response is only a detachable view of the run. A phone switching
    // networks closes this watcher but the background job continues; the client
    // can reattach through /api/sessions/:id/stream. Only /api/stop aborts it.
    res.on("close", detach);
    res.on("error", detach);
    void run.done.then(() => {
      // Normally mirror_end reaches finish first. This is a defensive close for
      // unusual response-stream behavior that removed the watcher early.
      if (!detached) {
        send({ e: "closed" });
        detach();
        res.end();
      }
    });
  });

  app.post("/api/stop", (req, res) => {
    const id = String(req.body?.sessionId ?? "");
    // stopSession now also reaps the session's background jobs and dev servers, and
    // reports each count — "stopped" used to come back true while a test suite and
    // a dev server kept running in the background.
    // M2（#44）：带 runId 的停止只停那一轮；此刻在跑的是另一轮 → 409，什么都不动。
    const runId = typeof req.body?.runId === "string" && req.body.runId ? req.body.runId : undefined;
    const report = stopSession(id, runId);
    res.status(report.error === "run_mismatch" ? 409 : 200).json(report);
  });

  // R14（K37）：界面上的「转后台」——正在前台跑的那次 Bash 调用不杀，移交给后台 job 表，这次调用立刻交回已有输出；
  // 只认这个会话自己的调用。moved:false = 它已经跑完 / 已经转过 / 后台 job 满了。
  app.post("/api/sessions/:id/tools/:callId/background", (req, res) => {
    const moved = moveForegroundToBackground(String(req.params.id), String(req.params.callId));
    res.status(moved ? 200 : 409).json({ moved });
  });

  // U11：这个会话的后台 job（任务面板「后台命令」）——只认这个会话自己的；输出只给实时尾行那一截、先脱敏。
  app.get("/api/sessions/:id/jobs", (req, res) => {
    res.json({ jobs: listJobs(String(req.params.id)) });
  });
  // 界面「停止」：killed:false = 没有这个 job / 它已经结束了
  app.post("/api/sessions/:id/jobs/:jobId/kill", (req, res) => {
    const killed = stopJob(String(req.params.id), String(req.params.jobId));
    res.status(killed ? 200 : 409).json({ killed });
  });

  // M2（#51）：「我刚才那条到底送到没有」——按客户端发送时带的 clientRunId 查（新会话首轮断流时客户端连
  // sessionId 都没有，所以不挂在会话路径下）。known:false = 没落地（或服务端重启过，查不到）。
  app.get("/api/runs/:clientRunId", (req, res) => {
    const hit = lookupClientRun(String(req.params.clientRunId));
    res.json(hit ? { known: true, ...hit } : { known: false });
  });

  // Answer a pending AskUserQuestion. `answers` is one entry per question (in the
  // order posed): { selected: string[], custom?: boolean }. Unblocks the agent.
  // ok:false = the ask is unknown/already answered (stale or double submit).
  app.post("/api/sessions/:id/answer", (req, res) => {
    const session = getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: "unknown or inactive session" });
      return;
    }
    const askId = String(req.body?.askId ?? "");
    const answered = answerAsk(session, askId, req.body?.answers, decidedBy(req.body?.by));
    res.json({ ok: answered });
  });

  // 细粒度权限：规则判定为 ask 的那次调用等在这里。
  // decision: "once" 允许一次 | "session" 本会话都允许 | "deny" 拒绝。
  app.post("/api/sessions/:id/permission", (req, res) => {
    const session = getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: "unknown or inactive session" });
      return;
    }
    const ok = resolvePermission(
      session,
      String(req.body?.id ?? ""),
      req.body?.decision,
      req.body?.note,
      req.body?.scope,
      decidedBy(req.body?.by),
    );
    res.json({ ok });
  });

  // Plan mode：批准/退回 ExitPlanMode 提交的计划。批准即把本会话切到 auto，
  // 同一轮继续执行。
  app.post("/api/sessions/:id/plan", (req, res) => {
    const session = getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: "unknown or inactive session" });
      return;
    }
    const ok = resolvePlan(session, String(req.body?.id ?? ""), req.body?.approved === true, req.body?.note, false, decidedBy(req.body?.by));
    res.json({ ok });
  });



  // 运行档位：把 auto / read-only / plan 三档从设置页搬到输入框旁之后，切档必须对
  // 【当前这条会话】立刻生效（切「只读」的动机通常就是勒住正在跑的 agent），所以走
  // 会话级端点而不是全局 config。全局值由前端另发一次，只作新对话的默认。
  app.post("/api/sessions/:id/mode", async (req, res) => {
    const session = await sessionForRequest(String(req.params.id), res);
    if (!session) return;
    const result = setSessionMode(session, req.body?.mode);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  });

  // P3（#6）：离开模式开关（会话级，与运行档位正交，默认关）。见 session.ts setSessionAway。
  app.post("/api/sessions/:id/away", async (req, res) => {
    const session = await sessionForRequest(String(req.params.id), res);
    if (!session) return;
    const result = setSessionAway(session, req.body?.away);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true, away: session.cfg?.away === true });
  });

  // 访问范围（仅工作空间 / 整机）同样是会话级、当场生效——见 session.ts setSessionAccess。
  app.post("/api/sessions/:id/access", async (req, res) => {
    const session = await sessionForRequest(String(req.params.id), res);
    if (!session) return;
    const result = setSessionAccess(session, req.body?.access);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ ok: true });
  });

  // 厂商 / 型号 / 思考深度同样是会话级——见 session.ts setSessionModel（空闲当场生效；运行中下一条消息起生效，回 pending）。
  app.post("/api/sessions/:id/model", async (req, res) => {
    const session = await sessionForRequest(String(req.params.id), res);
    if (!session) return;
    const result = setSessionModel(session, { provider: req.body?.provider, model: req.body?.model, thinking: req.body?.thinking });
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  // P13（X18）：撤掉本会话放行的工作区外只读目录（放行在卡片上做；这里只删）
  app.post("/api/sessions/:id/read-roots", async (req, res) => {
    const session = await sessionForRequest(String(req.params.id), res);
    if (!session) return;
    const remove = req.body?.remove;
    if (typeof remove !== "string" || !remove.trim()) {
      res.status(400).json({ error: "remove: the directory to stop reading" });
      return;
    }
    res.json({ ok: true, roots: revokeReadRoot(session, remove) });
  });

  // Steering: talk to a run that is already going (插话/转向). Previously the only
  // answer to "send while running" was 409 — the user had to stop the run and start
  // over, throwing away the turn's work.
  app.post("/api/sessions/:id/steer", (req, res) => {
    const session = getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: "unknown or inactive session" });
      return;
    }
    const runId = typeof req.body?.runId === "string" && req.body.runId ? req.body.runId : undefined;
    const result = steerSession(session, String(req.body?.text ?? ""), runId, req.body?.id);
    if (!result.ok) {
      // "not running" is a race the client can recover from by sending normally.
      // M2：run_mismatch = 在跑的是另一轮，客户端别把这句话当新消息发，放回输入框让人确认。
      const conflict = result.error === "session is not running" || result.error === "run_mismatch";
      res.status(conflict ? 409 : 400).json({ error: result.error, currentRunId: result.currentRunId });
      return;
    }
    res.json({ ok: true, id: result.id });
  });

  // U2（X36 第二步）：撤回一条还没送达的插话（待送达托盘）。已经注入了的撤不回来：{ ok: false, reason: "delivered" }
  app.post("/api/sessions/:id/steer/withdraw", (req, res) => {
    const session = getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: "unknown or inactive session" });
      return;
    }
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    if (!id) {
      res.status(400).json({ error: "id: the steer to withdraw" });
      return;
    }
    const r = withdrawSteer(session, id);
    res.json(r.ok ? { ok: true } : { ok: false, reason: r.reason });
  });

  // U2（hermes N17a）：立即中断并发送——撤回这条待送达的插话、中止这一轮、以这句话开新一轮（客户端经全局事件接上）
  app.post("/api/sessions/:id/steer/interrupt", async (req, res) => {
    const session = getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: "unknown or inactive session" });
      return;
    }
    const id = typeof req.body?.id === "string" ? req.body.id : "";
    if (!id) {
      res.status(400).json({ error: "id: the steer to deliver now" });
      return;
    }
    const r = await interruptWithSteer(session, id);
    res.json(r.ok ? { ok: true } : { ok: false, reason: r.reason });
  });
}
