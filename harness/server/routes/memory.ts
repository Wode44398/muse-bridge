// 记忆与项目知识的接口。
import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { workspaceRoot } from "../session.ts";
import { listSessions } from "../store.ts";
import { assertInTenant, insideTenant } from "../tenant.ts";
import { listProjects } from "../projects.ts";
import { isQuickPath, quickProject } from "../quick.ts";
import { globalMemoryScoped, GLOBAL_MEMORY, globalMemoryFor, MemoryTopicConflict, MemoryBudgetError, memoryDir, listMemories, isGlobalMemory, readMemory, type SaveMemoryOptions, saveMemory, deleteMemory, type MemoryEdits, promoteMemory, rejectMemory, restoreMemory } from "../memory.ts";
import { buildMemoryOverview } from "../memory-overview.ts";
import { quickRoot } from "../paths.ts";
import { renderProjectKnowledgeForPrompt, renderProjectKnowledgeVolatile } from "../knowledge.ts";
import { refreshProjectKnowledge } from "../knowledge-service.ts";
import { searchUnifiedKnowledge, type KnowledgeKind, getSearchMetrics } from "../knowledge-search.ts";
import { memoryDreamEnabled, dreamRunning, dreamCandidates, readDreamState, startDream } from "../memory-dream.ts";

export function registerMemoryRoutes(app: express.Express): void {
  // ── Governed memory + generated project knowledge ──────────────────────────

  // K4（G5）：记忆接口按工作区。以前一律绑在全局 workspaceRoot()：多项目时，面板看的、改的是另一个项目的桶。
  // ?workspace= 或 body.workspace 给项目的绝对路径（必须是存在的目录）；不给就是全局工作区（老客户端行为不变）。
  async function memoryWorkspace(req: express.Request): Promise<string> {
    // K7：layer=global → 全局层（关于用户与这台机器、每个工作区都适用的记忆）
    const global = String(req.query.layer ?? req.body?.layer ?? "") === "global";
    // 正式服全局层只有一份，与工作区无关（不看 workspace 参数，行为同以前）
    if (global && !globalMemoryScoped()) return GLOBAL_MEMORY;
    // 评测隔离（DIMENSIO_GLOBAL_MEMORY_SCOPE=workspace）：全局层按工作区各一份——layer=global 再带 workspace 就是那个工作区的；
    // 不带就降级成当前全局工作区（workspaceRoot()）那份，与记忆总览里的「全局」桶同一份
    const raw = String(req.query.workspace ?? req.body?.workspace ?? "").trim();
    if (!raw) return global ? globalMemoryFor(workspaceRoot()) : workspaceRoot();
    if (!path.isAbsolute(raw)) throw new Error("workspace must be an absolute path");
    const st = await stat(raw).catch(() => null);
    if (!st?.isDirectory()) throw new Error(`workspace is not an existing directory: ${raw}`);
    assertInTenant(path.resolve(raw), "工作区");
    return global ? globalMemoryFor(path.resolve(raw)) : path.resolve(raw);
  }

  // 工作区解析失败 / 校验不过 → 400；晋升撞上同 topic 的生效条目 → 409 带冲突列表（界面给「替换它」）。
  function memoryRoute(handler: (req: express.Request, res: express.Response, ws: string) => unknown): express.RequestHandler {
    return (req, res) => {
      memoryWorkspace(req)
        .then((ws) => handler(req, res, ws))
        .catch((error) => {
          if (res.headersSent) return;
          if (error instanceof MemoryTopicConflict) res.status(409).json({ error: error.message, conflicts: error.conflicts });
          else if (error instanceof MemoryBudgetError) res.status(409).json({ error: error.message, code: "global_budget", used: error.used, limit: error.limit });
          else res.status(400).json({ error: (error as Error).message });
        });
    };
  }

  app.get("/api/memory", memoryRoute((_req, res, ws) => {
    // 这个项目还没有记忆：直接回空，不为一次查看建目录（也不触发旧版记忆的一次性迁移）
    res.json(existsSync(memoryDir(ws)) ? listMemories(ws) : []);
  }));

  // K11：记忆总览（设置里的「记忆」面板）——全局层 + 每个有记忆的项目 + 旧快照桶，一次拿齐。只读，不为查看建目录。
  // 必须注册在 /api/memory/:id 之前（否则 "overview" 会被当成记忆 id）。
  app.get("/api/memory/overview", async (_req, res) => {
    try {
      const sessions = await listSessions();
      const projects = await listProjects([
        workspaceRoot(),
        ...sessions.map((s) => s.workspace ?? "").filter(Boolean),
      ].filter((p) => !isQuickPath(p)));
      const quick = quickProject();
      const overview = buildMemoryOverview({
        projects: projects.filter((p) => insideTenant(p.path)).map((p) => ({ path: p.path, name: p.name, hidden: p.hidden })),
        currentWs: workspaceRoot(),
        quickRoot: quickRoot(),
        currentQuick: quick?.path,
      });
      overview.buckets = overview.buckets.filter((b) => b.kind === "global" || insideTenant(b.ws));
      res.json(overview);
    } catch (error) {
      if (!res.headersSent) res.status(500).json({ error: (error as Error).message });
    }
  });

  // 离线记忆整理（memory-dream.ts）：这一处的整理状态（上次什么时候、结果、还有多少没复核）与「现在整理」。
  // 同样要注册在 /api/memory/:id 之前。
  app.get("/api/memory/dream", memoryRoute((_req, res, ws) => {
    if (isGlobalMemory(ws)) {
      res.json({ enabled: false, running: false, backlog: 0, state: {} });
      return;
    }
    res.json({ enabled: memoryDreamEnabled(), running: dreamRunning(ws), backlog: dreamCandidates(ws).backlog, state: readDreamState(ws) });
  }));

  app.post("/api/memory/dream", memoryRoute((_req, res, ws) => {
    if (isGlobalMemory(ws)) {
      res.status(400).json({ error: "the global layer is never tidied automatically: global notes wait for you to confirm them" });
      return;
    }
    const job = startDream(ws, "manual");
    if (!job) {
      res.status(409).json({ error: "a memory tidy-up is already running", code: "dream_busy" });
      return;
    }
    void job.catch(() => {});
    res.status(202).json({ started: true });
  }));

  app.get("/api/memory/:id", memoryRoute((req, res, ws) => {
    // K9：面板是给用户审的——命中注入特征的条目也要看得到全文，才能决定晋升还是驳回
    const record = existsSync(memoryDir(ws)) ? readMemory(ws, String(req.params.id), { reader: "user" }) : undefined;
    if (!record) {
      res.status(404).json({ error: "unknown memory id" });
      return;
    }
    res.json(record);
  }));

  app.post("/api/memory/search", memoryRoute(async (req, res, ws) => {
    const query = String(req.body?.query ?? "").trim();
    if (!query) {
      res.status(400).json({ error: "query is required" });
      return;
    }
    if (isGlobalMemory(ws)) {
      // 检索按工作区走（要带上项目知识），全局层的条目本来就在每个工作区的检索里
      res.status(400).json({ error: "search a workspace: global notes are included in every workspace search" });
      return;
    }
    try {
      res.json(await searchUnifiedKnowledge(ws, query, {
        kinds: Array.isArray(req.body?.kinds) ? req.body.kinds.map(String) as KnowledgeKind[] : ["memory"],
        scope: Array.isArray(req.body?.scope) ? req.body.scope.map(String) : undefined,
        path: req.body?.path ? String(req.body.path) : undefined,
        status: Array.isArray(req.body?.status) ? req.body.status.map(String) : undefined,
        limit: typeof req.body?.limit === "number" ? req.body.limit : undefined,
        semantic: typeof req.body?.semantic === "boolean" ? req.body.semantic : undefined,
        includeQuarantined: req.body?.includeQuarantined === true,
      }));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  }));

  app.post("/api/memory/save", memoryRoute((req, res, ws) => {
    // K2：界面上的保存就是用户自己写的；来源由服务端定，请求体里带什么都不认。
    const { workspace: _ws, ...opts } = (req.body ?? {}) as SaveMemoryOptions & { workspace?: unknown };
    res.json(saveMemory(ws, { ...opts, origin: { writer: "user", attended: true } }));
  }));

  app.post("/api/memory/:id/delete", memoryRoute((req, res, ws) => {
    res.json({ deleted: existsSync(memoryDir(ws)) && deleteMemory(ws, String(req.params.id)) });
  }));

  // K4：晋升（确认它 → active + user_confirmed，可带改动；撞上同 topic 的生效条目回 409，带 supersedes 再来）
  app.post("/api/memory/:id/promote", memoryRoute((req, res, ws) => {
    if (!existsSync(memoryDir(ws))) {
      res.status(404).json({ error: "unknown memory id" });
      return;
    }
    const edits = req.body?.edits && typeof req.body.edits === "object" ? (req.body.edits as MemoryEdits) : undefined;
    const supersedes = typeof req.body?.supersedes === "string" && req.body.supersedes ? req.body.supersedes : undefined;
    res.json(promoteMemory(ws, String(req.params.id), { edits, supersedes }));
  }));

  app.post("/api/memory/:id/reject", memoryRoute((req, res, ws) => {
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    const ok = existsSync(memoryDir(ws)) && rejectMemory(ws, String(req.params.id), reason);
    res.status(ok ? 200 : 404).json(ok ? { rejected: true } : { error: "unknown memory id" });
  }));

  app.post("/api/memory/:id/restore", memoryRoute((req, res, ws) => {
    const ok = existsSync(memoryDir(ws)) && restoreMemory(ws, String(req.params.id));
    res.status(ok ? 200 : 404).json(ok ? { restored: true } : { error: "not a rejected memory" });
  }));

  // M12：知识接口一律等知识 worker 对完（不在主线程上扫描工作区）。Express 4 不接 async 处理器的 reject——出错回 500，
  // 别让请求挂着。
  function knowledgeRoute(handler: (req: express.Request, res: express.Response) => Promise<void>): express.RequestHandler {
    return (req, res) => {
      handler(req, res).catch((error) => {
        if (!res.headersSent) res.status(500).json({ error: (error as Error).message });
      });
    };
  }

  app.get("/api/knowledge/status", knowledgeRoute(async (_req, res) => {
    const knowledge = await refreshProjectKnowledge(workspaceRoot());
    res.json({
      rebuilt: knowledge.rebuilt,
      summary: `${renderProjectKnowledgeForPrompt(workspaceRoot(), knowledge)}\n${renderProjectKnowledgeVolatile(knowledge)}`,
      profile: knowledge.profile,
      boundaries: knowledge.modules.boundaries,
      contractCounts: {
        routes: knowledge.contracts.routes.length,
        configKeys: knowledge.health.uniqueConfigKeys,
        configReferences: knowledge.contracts.config.length,
        data: knowledge.contracts.data.length,
        ci: knowledge.contracts.ci.length,
        deploy: knowledge.contracts.deploy.length,
        guides: knowledge.contracts.guides.length,
      },
      health: knowledge.health,
    });
  }));

  app.get("/api/knowledge/modules", knowledgeRoute(async (req, res) => {
    const knowledge = await refreshProjectKnowledge(workspaceRoot());
    const query = String(req.query.q ?? "").trim().toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
    const modules = knowledge.modules.modules.filter((item) => !query ||
      item.path.toLowerCase().includes(query) || item.boundary.toLowerCase().includes(query) ||
      item.exports.some((name) => name.toLowerCase().includes(query)));
    res.json({ total: modules.length, modules: modules.slice(0, limit) });
  }));

  app.get("/api/knowledge/contracts", knowledgeRoute(async (req, res) => {
    const contracts = (await refreshProjectKnowledge(workspaceRoot())).contracts;
    const query = String(req.query.q ?? "").trim().toLowerCase();
    const includes = (...values: string[]) => !query || values.some((value) => value.toLowerCase().includes(query));
    res.json({
      routes: contracts.routes.filter((item) => includes(item.method, item.route, item.file)),
      config: contracts.config.filter((item) => includes(item.name, item.file)),
      data: contracts.data.filter((item) => includes(item.kind, item.name, item.file)),
      ci: contracts.ci.filter((item) => includes(item.kind, item.path)),
      deploy: contracts.deploy.filter((item) => includes(item.kind, item.path)),
      guides: contracts.guides.filter((item) => includes(item.path, ...item.headings, ...item.constraints.map((c) => c.text))),
    });
  }));

  app.post("/api/knowledge/search", async (req, res) => {
    const query = String(req.body?.query ?? "").trim();
    if (!query) {
      res.status(400).json({ error: "query is required" });
      return;
    }
    try {
      res.json(await searchUnifiedKnowledge(workspaceRoot(), query, {
        generatedOnly: req.body?.generatedOnly === true,
        kinds: Array.isArray(req.body?.kinds) ? req.body.kinds.map(String) as KnowledgeKind[] : undefined,
        scope: Array.isArray(req.body?.scope) ? req.body.scope.map(String) : undefined,
        path: req.body?.path ? String(req.body.path) : undefined,
        status: Array.isArray(req.body?.status) ? req.body.status.map(String) : undefined,
        limit: typeof req.body?.limit === "number" ? req.body.limit : undefined,
        semantic: typeof req.body?.semantic === "boolean" ? req.body.semantic : undefined,
        includeQuarantined: req.body?.includeQuarantined === true,
      }));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });

  app.post("/api/knowledge/refresh", knowledgeRoute(async (_req, res) => {
    const knowledge = await refreshProjectKnowledge(workspaceRoot(), { force: true });
    res.json({ rebuilt: knowledge.rebuilt, generatedAt: knowledge.profile.generatedAt, health: knowledge.health });
  }));

  app.get("/api/knowledge/metrics", (_req, res) => {
    res.json(getSearchMetrics(workspaceRoot()));
  });
}
