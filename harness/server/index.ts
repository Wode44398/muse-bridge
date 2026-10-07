import "./env.ts";
// 最先装：此后任何未捕获异常/未处理拒绝都不再直接掐死这个常驻进程（直播会话、
// PTY、CDP target、正在跑的 agent loop 都挂在它上面）。见 fatal-guard.ts。
import { installFatalGuard } from "./fatal-guard.ts";
installFatalGuard("harness");
// Q13：console 输出照常打印，同时进诊断内存环（带当时的会话 / traceId）；非零退出前整环落一次盘。见 diag-ring.ts。
import { installConsoleRing } from "./diag-ring.ts";
installConsoleRing();
// 出站代理：自适应探测 + 每分钟自愈（net-proxy.ts）。Node 的全局 fetch 不读环境变量
// 代理，必须显式装 dispatcher；且 harness 常驻，不能只吃 bridge spawn 那一刻的 env
// 快照——本机代理抖动/开机晚启动会把 WebSearch/WebFetch 整批打成 fetch failed
//（2026-08-05、08-09 两次实锤）。NO_PROXY 里的 localhost/LAN 照常直连，CDP 不受影响。
import { initOutboundProxy, outboundProxyStatus } from "./net-proxy.ts";
import { primeLanAddress } from "./lan.ts";
await initOutboundProxy();
import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  answerAsk,
  decidedBy,
  cleanClientRunId,
  createSession,
  deleteSession,
  lookupClientRun,
  getOrLoadSession,
  getSession,
  mirrorBaseCount,
  sweepOrphanResources,
  pendingInteractions,
  rollbackSession,
  rewindSession,
  undoRewind,
  sessionReview,
  sessionReviewDiff,
  restoreSessionFiles,
  goalAction,
  sessionUsage,
  revokeReadRoot,
  withdrawSteer,
  interruptWithSteer,
  resumeInterruptedRuns,
  compactSession,
  handoffWithSummary,
  handoffPlan,
  recordFp,
  sessionRecord,
  sessionWorkspace,
  resolvePermission,
  resolvePlan,
  startRun,
  setSessionAccess,
  setSessionAway,
  setSessionMode,
  steerSession,
  stopSession,
  watchSession,
  anySessionRunning,
  drainSessions,
  runningRuns,
  pendingSummary,
  waitingOf,
  watchGlobal,
  workspaceRoot,
  type Session,
} from "./session.ts";
import { cancelRetire, currentFence, prepareRetire, readRetireRequest, retiring, writeRetireStatus } from "./retire.ts";
import { visibleMessages } from "./agent/state.ts";
import { loadWorkflowDetail } from "./agent/workflow.ts";
import { listSessions, listSessionsPage, loadSession, loadSessionResult, sessionFilePath, sessionsDir, unsupportedVersionMessage } from "./store.ts";
import { sessionAssetExists, sessionAssetForServing } from "./image-assets.ts";
import { inspectRecord, inspectSessionFile } from "./session-health.ts";
import { writeDiagnostics } from "./diagnostics.ts";
import { ERROR_CODES, sendError } from "./errors.ts";
import { checkpointDiff, listCheckpoints, reviewablePath } from "./checkpoints.ts";
import { newGoal } from "./goal.ts";
import { ledgerRows, sanitizeLedger } from "./usage-ledger.ts";
import { commandList } from "./commands.ts";
import { killAllMcpSync, mcpReady, mcpStatus, syncConnectors } from "./mcp.ts";
import { listDir, saveUpload } from "./files.ts";
import { listDirs, makeDir } from "./fsnav.ts";
import { accessLock, assertInTenant, disabledProviders, insideTenant, tenantInfo, tenantMode, tenantRoot, tenantShell } from "./tenant.ts";
import {
  createBlankProject,
  importProject,
  listProjects,
  projectsRoot,
  setProjectFlags,
  setProjectOrder,
} from "./projects.ts";
import {
  isCurrentQuickPath,
  isQuickPath,
  newQuickProject,
  quickProject,
  quickSessionFilter,
} from "./quick.ts";
import { Sandbox } from "./sandbox.ts";
import { getConfig, setConfig, hasKey, sessionConfigSnapshot, forgetProvider, type ConfigPatch } from "./config.ts";
import { allProviders } from "./catalog.ts";
import { addCustomProvider, isCustomProviderId, removeCustomProvider, updateCustomProvider } from "./custom-providers.ts";
import { shell, killAllJobs, listJobs, moveForegroundToBackground, stopJob } from "./tools/bash.ts";
import { ALL_TOOLS, toolDefs } from "./tools/registry.ts";
import { ruleProblems } from "./agent/permissions.ts";

// 权限规则自查用的工具名（含眼下没启用的工具——规则可以先写好）
const KNOWN_TOOLS: ReadonlySet<string> = new Set(ALL_TOOLS.map((t) => t.def.name.toLowerCase()));
import { webSearchStats } from "./tools/websearch.ts";
import {
  deleteMemory,
  listMemories,
  memoryDir,
  MemoryTopicConflict,
  MemoryBudgetError,
  GLOBAL_MEMORY,
  isGlobalMemory,
  promoteMemory,
  readMemory,
  rejectMemory,
  restoreMemory,
  saveMemory,
  type MemoryEdits,
  type SaveMemoryOptions,
} from "./memory.ts";
import { buildMemoryOverview } from "./memory-overview.ts";
import { quickRoot } from "./paths.ts";
import { renderProjectKnowledgeForPrompt, renderProjectKnowledgeVolatile } from "./knowledge.ts";
import { refreshProjectKnowledge, stopKnowledgeWorker } from "./knowledge-service.ts";
import { getSearchMetrics, searchUnifiedKnowledge, type KnowledgeKind } from "./knowledge-search.ts";
import { stopService, stopAllServices, stopServicesFor, latestService, listServices } from "./services.ts";
import {
  attachEdgeBrowser,
  browserClaimOwner,
  closeAllBrowserSessions,
  existingSharedBrowser,
  getSharedBrowser,
  sharedBrowserMode,
  VIEWPORT_PRESETS,
} from "./cdp.ts";
import { edgeLink } from "./edge-link.ts";
import { reviewOverview, reviewDiff } from "./review.ts";
import {
  ensureTerm,
  writeTerm,
  resizeTerm,
  killTerm,
  snapshotTerm,
  subscribeTerm,
  killAllTerminals,
} from "./terminal.ts";
import {
  INTERNAL_TOKEN_HEADER,
  QUERY_TOKEN_PARAM,
  allowedBrowserOrigin,
  apiRequestAuthorized,
} from "./api-auth.ts";
import { inertFileHeaders } from "./inert-file.ts";
import { randomBytes } from "node:crypto";
import { BUILD_INFO } from "./build-info.ts";
import { protocolInfo } from "./protocol.ts";
import { backlogGuard } from "./sse-backlog.ts";
import { startLoopDelayMonitor } from "./loop-delay.ts";
import { MAX_QUERY_CHARS, searchSessions } from "./session-search.ts";
import { referenceDigests } from "./session-refs.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8799);
const HOST = process.env.DIMENSIO_HOST?.trim() || "127.0.0.1";
// S1：API 一律要令牌。bridge 托管时用它注入的进程内令牌；独立开发运行（没有
// DIMENSIO_INTERNAL_TOKEN）时用 DIMENSIO_DEV_TOKEN，没配就现生成一把，启动时把带令牌
// 的开发页地址打到本进程控制台。两把都不进 agent 子进程（childEnv 白名单里没有它们）。
const BRIDGE_TOKEN = process.env.DIMENSIO_INTERNAL_TOKEN?.trim() || undefined;
const DEV_TOKEN = BRIDGE_TOKEN
  ? undefined
  : process.env.DIMENSIO_DEV_TOKEN?.trim() || randomBytes(24).toString("base64url");
const API_TOKEN = (BRIDGE_TOKEN ?? DEV_TOKEN) as string;
const EXTRA_ORIGINS = new Set(
  (process.env.DIMENSIO_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean),
);

const app = express();

// Harness can execute commands with provider credentials in memory, and its own
// agent runs shells and a browser on this very loopback interface. So "loopback"
// and "an allowed browser Origin" prove nothing: every API request must carry the
// token (bridge: process-only token; standalone dev: the printed dev token).
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/")) return next();

  const browserOrigin = allowedBrowserOrigin(req.get("origin"), PORT, EXTRA_ORIGINS);
  if (browserOrigin) {
    res.setHeader("Access-Control-Allow-Origin", browserOrigin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", `Content-Type, Authorization, ${INTERNAL_TOKEN_HEADER}`);
  }
  // 资源链接里的 ?dimensio_token= 不能经 Referer 漏给第三方。
  res.setHeader("Referrer-Policy", "no-referrer");
  // Lets the bridge distinguish this guarded API from an older, insecure
  // harness process that happens to be occupying the same port.
  res.setHeader("X-Dimensio-API-Guard", "1");
  // CORS 预检不带自定义头（浏览器只报 Access-Control-Request-Headers），也不会进任何
  // 处理器：直接 204，放不放行由上面的 CORS 头决定；真请求照样要过令牌。
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  if (!apiRequestAuthorized(req, API_TOKEN)) {
    res.status(401).json({ error: "unauthorized harness API request" });
    return;
  }
  next();
});

app.use(express.json({ limit: "10mb" }));

// 租户实例的接口闸（多用户服务端上每个用户一个 harness，见 tenant.ts）：连用户的 Edge（主机主人的真实登录态）
// 整组关掉；没有命令行的租户连终端也关。工作区类路径的限制在各处理器里。
app.use((req, res, next) => {
  if (!tenantMode()) return next();
  const p = req.path;
  if (p.startsWith("/api/edge/") || p === "/api/browser/edge") {
    res.status(403).json({ error: "not available for multi-user accounts on this server" });
    return;
  }
  if (p.startsWith("/api/dock/term/") && !tenantShell()) {
    res.status(403).json({ error: "this account has no command line" });
    return;
  }
  next();
});

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

// ── Info + config ────────────────────────────────────────────────────────────

app.get("/api/info", (_req, res) => {
  // 租户实例（多用户服务端上每个用户一个 harness，见 tenant.ts）关掉的 provider 不出现在目录里——选择器照目录渲染，
  // 不用另改前端；tenant 字段告诉前端藏掉访问范围开关、终端、连 Edge 这些入口。
  const offProviders = disabledProviders();
  const catalog = allProviders().filter((p) => !offProviders.has(p.id));
  res.json({
    workspace: workspaceRoot(),
    projectsRoot: projectsRoot(),
    shell: shell.kind,
    platform: process.platform,
    tools: toolDefs().map((t) => t.name),
    // Derived from the catalog so a newly added provider can never be missing
    // from the hasKey map (kimi was, once).
    providers: Object.fromEntries(catalog.map((p) => [p.id, hasKey(p.id)])),
    // Which models each provider can call + the effort tiers each model exposes.
    // The chat-bar model/effort menus render straight from this.
    catalog,
    tenant: tenantInfo(),
    // S9：这个进程跑的是哪版代码（启动时的 HEAD / 是否有未提交改动 / 启动时间）。
    build: BUILD_INFO,
    // M10：协议版本号、还服务的最老前端、能力位（见 protocol.ts 的纪律）
    protocol: protocolInfo(),
  });
});

app.get("/api/config", (_req, res) => {
  const cfg = getConfig();
  // accessLocked：访问范围被锁定（租户恒 workspace）——前端据此不摆「仅工作空间 / 整机」开关。
  res.json({ ...cfg, hasKey: hasKey(cfg.provider), accessLocked: accessLock() });
});

// ── 自定义模型服务（「模型服务」面板里的「＋」卡；OpenAI 兼容端点，key 加密存） ─────────────
// 新目录随 /api/info 的 catalog 下发（custom 字段）；这里只管增删改。保存前先打一次 GET {base}/models：
// 既拿到型号清单，也当场验地址与 key。租户实例不开放（服务端替用户去连任意地址 = SSRF）。
function customProvidersAllowed(res: express.Response): boolean {
  if (!tenantInfo().tenant) return true;
  res.status(403).json({ error: "这台服务器不允许添加自定义模型服务" });
  return false;
}
const customErr = (res: express.Response, e: unknown) => {
  const err = e as Error & { needsModel?: boolean };
  res.status(400).json({ error: err.message, needsModel: err.needsModel || undefined });
};

app.post("/api/custom-providers", async (req, res) => {
  if (!customProvidersAllowed(res)) return;
  try {
    const { provider, warning } = await addCustomProvider(req.body ?? {});
    res.json({ ok: true, id: provider.id, models: provider.models.length, warning });
  } catch (e) {
    customErr(res, e);
  }
});

// 改 / 删都走 POST：离线 apk 跨源访问 bridge，反代的 CORS 只放行 GET / POST
app.post("/api/custom-providers/:id", async (req, res) => {
  if (!customProvidersAllowed(res)) return;
  if (!isCustomProviderId(req.params.id)) return void res.status(404).json({ error: "not found" });
  try {
    const { provider, warning } = await updateCustomProvider(req.params.id, req.body ?? {});
    res.json({ ok: true, id: provider.id, models: provider.models.length, warning });
  } catch (e) {
    customErr(res, e);
  }
});

app.post("/api/custom-providers/:id/delete", async (req, res) => {
  if (!customProvidersAllowed(res)) return;
  const id = req.params.id;
  if (!isCustomProviderId(id)) return void res.status(404).json({ error: "not found" });
  try {
    await removeCustomProvider(id);
    forgetProvider(id); // 正选着它就退回默认厂商；历史会话照旧留着（接着聊会提示这家已删掉、换一家开新对话）
    res.json({ ok: true, config: { ...getConfig(), hasKey: hasKey(getConfig().provider) } });
  } catch (e) {
    customErr(res, e);
  }
});

// E3（G7）：输入框 / 面板的技能清单（扩展中心勾给 dimensio 的；按名现读，新装的马上出现）。内置命令在前端
app.get("/api/commands", (_req, res) => {
  res.json(commandList());
});

// E1（G6）：MCP 连接器的连接状态（勾给 dimensio 的；不含凭据、命令行与地址）。先对一遍注册表
app.get("/api/mcp", async (_req, res) => {
  await syncConnectors();
  res.json({ connectors: mcpStatus() });
});

// 出站与联网工具自检。旧的 WebSearch 只有 console.warn，出事没有任何可查的证据；
// 这里把「出口现在走哪」和「每个搜索后端成/败多少次」摆出来，一次 GET 就能分清
// 是代理翻了还是上游挂了。
app.get("/api/net", (_req, res) => {
  res.json({ outbound: outboundProxyStatus(), websearch: webSearchStats() });
});

app.post("/api/config", (req, res) => {
  try {
    // P5（X24）：新写进来的权限规则先自查——写法不对、工具名不存在、模式为空的规则永远不会生效
    const problems = ruleProblems(req.body?.permissionRules, KNOWN_TOOLS, getConfig().permissionRules);
    if (problems.length) {
      res.status(400).json({ error: `权限规则有误：${problems.join("；")}` });
      return;
    }
    const cfg = setConfig(req.body as ConfigPatch);
    res.json({ ...cfg, hasKey: hasKey(cfg.provider) });
  } catch (e) {
    // workspace/access validation failures (bad path, not a directory, …)
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── Governed memory + generated project knowledge ──────────────────────────

// K4（G5）：记忆接口按工作区。以前一律绑在全局 workspaceRoot()：多项目时，面板看的、改的是另一个项目的桶。
// ?workspace= 或 body.workspace 给项目的绝对路径（必须是存在的目录）；不给就是全局工作区（老客户端行为不变）。
async function memoryWorkspace(req: express.Request): Promise<string> {
  // K7：layer=global → 全局层（关于用户与这台机器、每个工作区都适用的记忆）
  if (String(req.query.layer ?? req.body?.layer ?? "") === "global") return GLOBAL_MEMORY;
  const raw = String(req.query.workspace ?? req.body?.workspace ?? "").trim();
  if (!raw) return workspaceRoot();
  if (!path.isAbsolute(raw)) throw new Error("workspace must be an absolute path");
  const st = await stat(raw).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`workspace is not an existing directory: ${raw}`);
  assertInTenant(path.resolve(raw), "工作区");
  return path.resolve(raw);
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

// ── Run (SSE stream) ─────────────────────────────────────────────────────────

// M8：退役冻结期间不接新 run——客户端按「没送达」把这一条放回输入框（M2），稍后再发。
const RETIRING_ERROR = { error: "服务正在重启（部署中），这一条没有发出；稍后再发", code: "retiring" };

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

  // A sessionId not in memory is resumed from disk (survives server restarts).
  let session;
  try {
    session = sessionId ? await getOrLoadSession(String(sessionId)) : createSession(initial);
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
  }, 15_000);

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

// 会话级开关要先把会话从盘上恢复出来，而恢复可能抛错（持久化的厂商没配 key；M7：更新版本写的会话只读）——
// 统一回带原因的错误。以前这三个接口直接 await，抛错时请求一直挂着不回。
// Q14：带码的错误按自己的状态码与稳定码回（读不了 503、只读 409、缺 key 400），其余照旧 400。
async function sessionForRequest(id: string, res: express.Response): Promise<Session | undefined> {
  try {
    const session = await getOrLoadSession(id);
    if (!session) res.status(404).json({ error: "unknown session", code: ERROR_CODES.sessionNotFound });
    return session;
  } catch (e) {
    sendError(res, e);
    return undefined;
  }
}

// Q14：读不了的会话如实回 503 + 稳定码（客户端稍后重试），不冒充「没有这个会话」
function sendUnreadable(res: express.Response, loaded: { code: string }): void {
  res.status(503).json({ error: `会话文件这会儿读不了（${loaded.code}），稍后再试`, code: ERROR_CODES.sessionUnreadable });
}

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

// ── Persisted sessions (list / read / delete) ────────────────────────────────

// Newest-first sessions. Response stays a bare array (the frontend and the bridge
// page both consume it that way); paging is opt-in via ?offset=/?limit=, with the
// full count in X-Total-Count so a client can tell there are older ones. Without
// this, everything past the 100th newest session was unreachable, period.
app.get("/api/sessions", async (req, res) => {
  const page = await listSessionsPage({
    offset: Number(req.query.offset) || 0,
    limit: Number(req.query.limit) || undefined,
    // 快照对话：旧桶的会话全部隐藏，当前桶只露最新一条，且置顶保住第一页
    // （否则聊久了会被新会话挤出列表，侧栏那条快照就凭空消失了）。
    filter: quickSessionFilter(),
    pin: (m) => isCurrentQuickPath(m.workspace),
  });
  res.setHeader("X-Total-Count", String(page.total));
  res.setHeader("Access-Control-Expose-Headers", "X-Total-Count");
  res.json(
    page.items.map((m) => {
      const live = getSession(m.id);
      return {
        ...m,
        workspace: m.workspace || workspaceRoot(),
        running: live?.running ?? false,
        // P8（X34）：在等你回答 / 批准 / 审计划——侧栏据此标「等你」
        waiting: live ? (waitingOf(live)?.kind ?? null) : null,
      };
    }),
  );
});

// K10（D5）：侧栏搜索的正文命中（可见正文：用户的话 + 助手正文）。要注册在 /api/sessions/:id 之前，否则 search 被当成会话 id。
// 范围与列表一致（快照桶只露最新一条）；q 走查询串、截到 100 字。
app.get("/api/sessions/search", async (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.slice(0, MAX_QUERY_CHARS) : "";
  const found = await searchSessions(q, { limit: Number(req.query.limit) || undefined, filter: quickSessionFilter() });
  res.json({ items: found.items.map((h) => ({ ...h, workspace: h.workspace || workspaceRoot() })) });
});

// P8（K35）：轻量「谁在跑、谁在等你」摘要。bridge apk 的原生通知服务轮询它——WebView 被冻结（锁屏、久在后台）
// 时 JS 发不了通知，原生服务照样能发。只有终态事实：在等哪一类、哪个工具，不带命令 / 路径 / 模型原文。
app.get("/api/pending", (_req, res) => {
  res.json(pendingSummary());
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
  }, 15_000);
  ping.unref?.();
  const close = () => {
    off();
    clearInterval(ping);
  };
  req.on("close", close);
  res.on("close", close);
});

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
  }, 15_000);
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
  express.raw({ type: () => true, limit: "30mb" }),
  async (req, res) => {
    const rel = String(req.query.path ?? "").trim();
    if (!rel) {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }
    try {
      const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
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
  }, 15_000);
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

// ── Live Browser pane (screencast of the agent's shared browser) ────────────
// The user's window into — and hands on — the SAME browser the agent drives.
// All routes GET/POST only (bridge proxy CORS). SSE frames flow only while at
// least one viewer is subscribed; the browser itself is unaffected by viewers
// coming and going (phone can disconnect mid-task, agent keeps working).

app.get("/api/browser/state", (_req, res) => {
  const page = existingSharedBrowser();
  const edge = edgeLink().snapshot();
  res.json(
    page
      ? { alive: true, url: page.url, viewport: page.viewport, tabs: page.tabs, mode: sharedBrowserMode(), edge }
      : { alive: false, tabs: [], mode: null, edge },
  );
});

// ── 用户的 Edge（经 dimensio Edge 扩展；本仓库不附带扩展）───────────────────────
// 扩展是否连着、共享浏览器现在是哪一种。
app.get("/api/edge/status", (_req, res) => {
  res.json({ ...edgeLink().snapshot(), mode: sharedBrowserMode() });
});

// 面板上的「接到我的 Edge」：把共享浏览器换成 Edge 里 dimensio 标签组的标签页。
app.post("/api/browser/edge", async (req, res) => {
  const owner = browserClaimOwner();
  if (owner) {
    res.status(409).json({ error: "a session is driving the browser right now — switch after its run ends" });
    return;
  }
  try {
    const url = String(req.body?.url ?? "").trim();
    const { session, tabs, created } = await attachEdgeBrowser(url || undefined);
    res.json({ ok: true, url: session.url, tabs: session.tabs, count: tabs, created });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// 用户在 Edge 页面上点了「停止」、或在「正在调试此浏览器」提示条上点了「取消」：
// 停掉正占着浏览器的那一轮（与会话里的停止按钮同一个出口），再断开 Edge。
edgeLink().onStop = (why) => {
  const owner = browserClaimOwner();
  if (owner) {
    const report = stopSession(owner);
    console.log(`[edge] stopped session ${owner} from the browser (${why}): aborted=${report.turnAborted}`);
  }
  if (sharedBrowserMode() === "edge") closeAllBrowserSessions();
};

app.get("/api/browser/stream", async (req, res) => {
  const page = existingSharedBrowser();
  if (!page) {
    res.status(409).json({ error: "browser not running" });
    return;
  }
  // native=1：桌面壳里的观众看的是真 WebContentsView，不需要 JPEG 帧——
  // 只保留 state/tabs/pointer 事件驱动工具条与挂载。其余观众（手机/网页）照旧帧流。
  const native = String((req.query as Record<string, unknown>)?.native ?? "") === "1";
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const send = (obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
  send({ e: "state", url: page.url, viewport: page.viewport });

  let unsub: (() => void) | null = null;
  // Pointer echo: viewers see where the agent (or another device) points/clicks.
  const unsubPtr = page.subscribePointer((p) => send({ e: "pointer", ...p }));
  // Tab strip: every viewer mirrors the shared browser's tabs live; an empty
  // list means the last tab was closed and the browser is gone entirely.
  const unsubTabs = page.subscribeTabs((tabs) => {
    send({ e: "tabs", tabs });
    if (!tabs.length) send({ e: "state", alive: false });
  });
  // 视口变化（面板设备钮 或 agent 的 Browser(resize)）：所有观众同步点亮档位；
  // 桌面壳观众还要靠它按新视口重新缩放摆放原生视图。
  const unsubViewport = page.subscribeViewport((viewport) => send({ e: "viewport", viewport }));
  if (!native) {
    try {
      unsub = await page.subscribeCast((f) => {
        send({ e: "frame", data: f.data, w: f.deviceWidth, h: f.deviceHeight, url: page.url });
      });
    } catch (e) {
      unsubPtr();
      unsubTabs();
      unsubViewport();
      send({ e: "error", message: (e as Error).message });
      res.end();
      return;
    }
  }
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  res.on("close", () => {
    clearInterval(heartbeat);
    unsub?.();
    unsubPtr();
    unsubTabs();
    unsubViewport();
  });
});

// Forward the user's pointer/keyboard into the shared browser (they share the
// page with the agent — same state, two pairs of hands).
app.post("/api/browser/input", async (req, res) => {
  const page = existingSharedBrowser();
  if (!page) {
    res.status(409).json({ error: "browser not running" });
    return;
  }
  const b = req.body ?? {};
  const x = Number(b.x ?? 0);
  const y = Number(b.y ?? 0);
  try {
    switch (String(b.type ?? "")) {
      case "click":
        await page.clickCoord(x, y, {
          button: b.button === "right" ? "right" : "left",
          clickCount: b.double ? 2 : 1,
          source: "user",
        });
        break;
      case "move":
        await page.hoverCoord(x, y, "user");
        break;
      case "wheel":
        await page.wheel(x, y, Number(b.deltaY ?? 0), Number(b.deltaX ?? 0));
        break;
      case "key":
        await page.pressKey(String(b.key ?? ""));
        break;
      case "text":
        await page.typeText(String(b.text ?? ""));
        break;
      default:
        res.status(400).json({ error: `unknown input type "${b.type}"` });
        return;
    }
    res.json({ ok: true, url: page.url });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Viewport switch from the pane's device buttons — the SAME setViewport the
// agent's Browser(resize) uses, so user and agent stay on one shared page and
// the pane's highlight follows whoever resized last (via frame dimensions).
app.post("/api/browser/resize", async (req, res) => {
  const page = existingSharedBrowser();
  if (!page) {
    res.status(409).json({ error: "browser not running" });
    return;
  }
  const b = req.body ?? {};
  const preset = VIEWPORT_PRESETS[String(b.preset ?? "")];
  const w = preset ? preset.width : Number(b.width);
  const h = preset ? preset.height : Number(b.height);
  if (!(w > 0 && h > 0)) {
    res.status(400).json({ error: "pass preset (mobile|tablet|desktop) or positive width+height" });
    return;
  }
  try {
    await page.setViewport(w, h, preset ? preset.mobile : w < 600);
    res.json({ ok: true, viewport: page.viewport });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// ── 标签页（面板 tabstrip 的 × / ＋ / 切换）──────────────────────────────────
// 与 agent 共享同一个浏览器：新建/关闭/切换立刻广播给所有观看者（stream 的
// tabs 事件），agent 的后续操作始终落在前台标签上。

app.post("/api/browser/tabs/new", async (req, res) => {
  try {
    const existed = Boolean(existingSharedBrowser());
    const page = await getSharedBrowser(); // 未运行则拉起 —— ＋也是启动入口
    let url = String(req.body?.url ?? "").trim();
    if (url && !/^(https?:\/\/|about:)/i.test(url)) {
      url = (/^(localhost|127\.|192\.168\.|10\.)/.test(url) ? "http://" : "https://") + url;
    }
    if (existed) {
      await page.newTab(url || "about:blank");
    } else if (url) {
      // 刚拉起的浏览器自带首个标签 —— 它就是「新标签」，别再生第二个
      await page.navigate(url);
    }
    res.json({ ok: true, tabs: page.tabs, url: page.url });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/browser/tabs/activate", async (req, res) => {
  const page = existingSharedBrowser();
  if (!page) {
    res.status(409).json({ error: "browser not running" });
    return;
  }
  const id = String(req.body?.id ?? "");
  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }
  try {
    await page.activateTab(id);
    res.json({ ok: true, tabs: page.tabs, url: page.url });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

app.post("/api/browser/tabs/close", async (req, res) => {
  const page = existingSharedBrowser();
  if (!page) {
    res.status(409).json({ error: "browser not running" });
    return;
  }
  const id = String(req.body?.id ?? "");
  if (!id) {
    res.status(400).json({ error: "id is required" });
    return;
  }
  try {
    await page.closeTab(id);
    // 关的是最后一个标签时整个浏览器随之退出（= 真实浏览器关窗口）。
    const alive = Boolean(existingSharedBrowser());
    res.json({ ok: true, tabs: alive ? page.tabs : [], alive });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// User-driven navigation from the pane's address bar (launches the browser if
// needed — the pane is usable before the agent ever touches it).
app.post("/api/browser/navigate", async (req, res) => {
  const dir = String(req.body?.dir ?? "");
  try {
    if (dir === "back" || dir === "forward") {
      const page = existingSharedBrowser();
      if (!page) {
        res.status(409).json({ error: "browser not running" });
        return;
      }
      const moved = await page.history(dir === "back" ? -1 : 1);
      res.json({ ok: Boolean(moved), url: page.url });
      return;
    }
    let url = String(req.body?.url ?? "").trim();
    if (!url) {
      res.status(400).json({ error: "url is required" });
      return;
    }
    if (url.startsWith("/")) {
      const s = latestService();
      if (!s) {
        res.status(400).json({ error: "path given but no preview server is running" });
        return;
      }
      url = `http://localhost:${s.port}${url}`;
    } else if (!/^https?:\/\//i.test(url)) {
      url = (/^(localhost|127\.|192\.168\.|10\.)/.test(url) ? "http://" : "https://") + url;
    }
    const page = await getSharedBrowser();
    await page.navigate(url);
    res.json({ ok: true, url: page.url });
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

// Live service registry snapshot. The bridge's pv-* Host router polls this to
// resolve public-preview tokens → local ports; entries vanish with the service,
// so a stopped server's public URL 404s naturally.
app.get("/api/preview/services", (_req, res) => {
  res.json(listServices());
});

// Stop a preview server: an explicit serviceId, or all of ONE session's servers
// (sessionId — what "new chat" cleanup means), or the whole process's servers.
app.post("/api/preview/stop", (req, res) => {
  const serviceId = req.body?.serviceId ? String(req.body.serviceId) : "";
  if (serviceId) {
    res.json({ stopped: stopService(serviceId) });
    return;
  }
  // Per-session cleanup is the right granularity and needs no global guard: it
  // only ever touches servers this session started. The old global stop-all had
  // the wrong grain in both directions — opening a session on the PC killed the
  // dev server a phone-started run was testing, while an orphaned server from a
  // finished session could never be cleaned up as long as any session ran.
  const sessionId = req.body?.sessionId ? String(req.body.sessionId) : "";
  if (sessionId) {
    res.json({ stopped: stopServicesFor(sessionId) > 0, scope: "session" });
    return;
  }
  // No scope given = the blunt process-wide janitor. Still refuse while a run is
  // in flight; without a session id we cannot tell whose server is whose.
  if (anySessionRunning()) {
    res.json({
      stopped: false,
      reason: "a session is running — pass sessionId to stop only that session's servers",
    });
    return;
  }
  stopAllServices();
  res.json({ stopped: true, scope: "all" });
});

// ── Static frontend (built) ──────────────────────────────────────────────────

// An unknown /api/* path must be a JSON 404, not the SPA shell: the catch-all
// answered 200 text/html for typos and removed endpoints, so the frontend had to
// sniff content-type to tell "no such endpoint" from real data.
app.all(/^\/api\//, (req, res) => {
  res.status(404).json({ error: `no such endpoint: ${req.method} ${req.path}` });
});

const distDir = path.resolve(__dirname, "..", "web", "dist");
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (_req, res) => res.sendFile(path.join(distDir, "index.html")));
}

function releaseProcessResources(): void {
  closeAllBrowserSessions({ exiting: true });
  stopAllServices();
  killAllJobs();
  killAllTerminals();
  killAllMcpSync(); // E1：stdio 连接器的子进程
}

// M8：计划内的退出（退役闸 commit、部署脚本的请求文件、SIGINT/SIGTERM）一律先排空：在跑的轮按
// 「服务重启」中止并落盘，再收资源、退出。整个过程有硬上限，排空卡住也不会让进程赖着不走。
let retiringNow: Promise<void> | null = null;
function retireNow(why: string): Promise<void> {
  retiringNow ??= (async () => {
    prepareRetire();
    const hard = setTimeout(() => process.exit(0), 20_000);
    hard.unref();
    try {
      const drained = await drainSessions(10_000);
      console.log(`[retire] ${why}: drained ${drained} running session(s), exiting`);
    } catch (e) {
      console.error("[retire] drain failed:", (e as Error).message);
    }
    releaseProcessResources();
    await stopKnowledgeWorker(); // M8 补：先收 worker 线程再退（见 stopKnowledgeWorker）
    process.exit(0);
  })();
  return retiringNow;
}

for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void retireNow(sig));
process.on("exit", releaseProcessResources);

// 部署脚本没有令牌：写 sessions 目录下的 retire.request.json（agent 写不进 sessions 目录）。每秒看一眼，
// 冻结期间把在跑的轮写进 retire.status.json 给脚本等空闲。
setInterval(() => {
  const dir = sessionsDir();
  const req = readRetireRequest(dir);
  if (req?.action === "prepare") prepareRetire(req.ttlMs);
  else if (req?.action === "cancel") cancelRetire();
  if (req || retiring()) {
    const f = currentFence();
    writeRetireStatus(dir, { retiring: Boolean(f), expiresAt: f?.expiresAt ?? null, runs: runningRuns() });
  }
  if (req?.action === "commit") {
    if (req.force || !anySessionRunning()) void retireNow("request file");
    else prepareRetire(req.ttlMs); // 还有在跑的：保持冻结，脚本继续等
  }
}, 1_000).unref();

// Resolve this machine's own LAN address once at startup, so the prompt can name
// the subnet instead of leaving the agent to discover reachable devices by luck.
void primeLanAddress();

// M12（N37）：事件循环延迟看门狗——主线程上有同步重活时留一行证据（以前全部会话一起卡住，哪里都看不出来）
startLoopDelayMonitor();

// M5（K03）：owner 会话已不在的后台 job / dev server，5 分钟巡检一次收掉
setInterval(() => void sweepOrphanResources(), 5 * 60_000).unref();

const httpServer = app.listen(PORT, HOST, () => {
  console.log(`\n  harness server → http://${HOST}:${PORT}`);
  console.log(`  workspace       ${workspaceRoot()}`);
  console.log(`  shell           ${shell.kind} (${shell.path})`);
  const cfg = getConfig();
  console.log(`  provider        ${cfg.provider} / ${cfg.model}  key:${hasKey(cfg.provider) ? "yes" : "MISSING"}`);
  if (!existsSync(distDir)) {
    console.log(`\n  (frontend not built — run "npm run web" for the dev UI, or "npm run build")\n`);
  }
  if (DEV_TOKEN) {
    // 独立开发运行：API 只认令牌（S1），开发页首次打开时从地址栏的 # 里收下它。
    const hash = `#dimensio-token=${encodeURIComponent(DEV_TOKEN)}`;
    console.log(`\n  standalone UI   http://127.0.0.1:${PORT}/${hash}`);
    console.log(`  vite dev UI     http://localhost:5178/${hash}`);
    console.log(`  API clients     header ${INTERNAL_TOKEN_HEADER}: <token>  (GET resources: ?${QUERY_TOKEN_PARAM}=<token>)\n`);
  }
  // M13：上一个进程被重启切断 / 直接死掉时在跑的轮，起来之后自动接着做（稍等一下，让 bridge 先连上来）。
  // 测试里拉起的 harness 不做（各测试文件共用一个会话目录，别的进程被切断的轮不该在这儿续；要测就显式开 DIMENSIO_AUTO_RESUME）
  if (process.env.DIMENSIO_TEST_ISOLATION !== "1" || process.env.DIMENSIO_AUTO_RESUME === "1") {
    setTimeout(() => {
      resumeInterruptedRuns().catch((e) => console.error(`[resume] ${(e as Error).message}`));
    }, 1500).unref();
  }
  // E1：MCP 连接器起来就开始连（新会话建基线时多半已经连好）
  if (process.env.DIMENSIO_TEST_ISOLATION !== "1") void syncConnectors();
});

// Edge 扩展的回环 WebSocket（/edge-link，只认固定扩展 ID 的 Origin，见 edge-link.ts）。harness 没有别的 WebSocket 端点。
httpServer.on("upgrade", (req, socket) => {
  if (!edgeLink().handleUpgrade(req, socket)) socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
});
