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
// 快照——Clash 抖动/开机晚启动会把 WebSearch/WebFetch 整批打成 fetch failed
//（2026-08-05、08-09 两次实锤）。NO_PROXY 里的 localhost/LAN 照常直连，CDP 不受影响。
import { initOutboundProxy } from "./net-proxy.ts";
import { primeLanAddress } from "./lan.ts";
await initOutboundProxy();
import express from "express";
import path from "node:path";
import { existsSync } from "node:fs";
import "node:fs/promises";
import { fileURLToPath } from "node:url";
import { sweepOrphanResources, resumeInterruptedRuns, anySessionRunning, drainSessions, runningRuns, workspaceRoot } from "./session.ts";
import { cancelRetire, currentFence, prepareRetire, readRetireRequest, retiring, writeRetireStatus } from "./retire.ts";
import "./agent/state.ts";
import "./agent/workflow.ts";
import { listSessions, sessionsDir } from "./store.ts";
import "./image-assets.ts";
import "./session-health.ts";
import "./diagnostics.ts";
import "./errors.ts";
import "./checkpoints.ts";
import "./goal.ts";
import "./usage-ledger.ts";
import "./commands.ts";
import { killAllMcpSync, syncConnectors } from "./mcp.ts";
import "./files.ts";
import "./fsnav.ts";
import { insideTenant } from "./tenant.ts";
import "./prefs.ts";
import { registerPrRoutes } from "./pr.ts"; // 拉取请求（PR 卡、bridge 推来的自动修复事件）
import { registerWorkspaceRoutes } from "./workspace-routes.ts"; // 工作区协同：视图上报 / 应答
// 会话管理（稍后发送 / 改名与 AI 标题 / 归档 / 输入建议 / 通知）：接口与接线都在 sessmgmt/，这里只挂载与给列表加过滤
import { mountSessionMgmt } from "./sessmgmt/index.ts";
// 会话协作（子会话、会话间消息、与 bridge 里 Claude 会话互通）：接口在 family-routes.ts，运行时在 session-family.ts
import { registerFamilyRoutes } from "./family-routes.ts";
import { registerProjectRoutes } from "./project-routes.ts";
import { registerDispatchRoutes } from "./dispatch-routes.ts";
import { refreshDispatchPolicy } from "./agent/dispatch-policy.ts";
import { startFamily } from "./session-family.ts";
import "./projects.ts";
import "./quick.ts";
import "./sandbox.ts";
import { getConfig, hasKey } from "./config.ts";
import "./catalog.ts";
import { customKeysReady } from "./custom-providers.ts";
import { shell, killAllJobs } from "./tools/bash.ts";
import { ALL_TOOLS } from "./tools/registry.ts";
import "./tools/localpc.ts";
import "./agent/permissions.ts";

// 权限规则自查用的工具名（含眼下没启用的工具——规则可以先写好）
const KNOWN_TOOLS: ReadonlySet<string> = new Set(ALL_TOOLS.map((t) => t.def.name.toLowerCase()));
import "./tools/websearch.ts";
import "./memory.ts";
import "./memory-overview.ts";
import "./paths.ts";
import "./knowledge.ts";
import { stopKnowledgeWorker } from "./knowledge-service.ts";
import "./knowledge-search.ts";
import { stopAllServices } from "./services.ts";
import { closeAllBrowserSessions } from "./cdp.ts";
import "./review.ts";
import { killAllTerminals } from "./terminal.ts";
import { INTERNAL_TOKEN_HEADER, QUERY_TOKEN_PARAM } from "./api-auth.ts";
import "./inert-file.ts";
import { randomBytes } from "node:crypto";
import "./localai.ts";
import "./build-info.ts";
import "./protocol.ts";
import "./sse-backlog.ts";
import { startLoopDelayMonitor } from "./loop-delay.ts";
import { startJobNotify } from "./job-notify.ts";
import { startWakeups } from "./wakeup.ts";
import { sweepLeftoverWorktrees } from "./session/subagents.ts";
import { startIdleCompact } from "./idle-compact.ts";
import { startMemoryDream } from "./memory-dream.ts";
import "./session-search.ts";
import "./session-refs.ts";
import { registerApiGuards } from "./routes/api-guards.ts";
import { registerAdminRoutes } from "./routes/admin.ts";
import { registerInfoRoutes, registerSettingsRoutes, registerConfigWriteRoute } from "./routes/settings.ts";
import { registerMemoryRoutes } from "./routes/memory.ts";
import { registerRunRoutes } from "./routes/run.ts";
import { registerSessionListRoutes, registerSessionRecordRoutes } from "./routes/sessions.ts";
import { registerProjectListRoutes } from "./routes/projects.ts";
import { registerFileRoutes } from "./routes/files.ts";
import { registerBrowserRoutes } from "./routes/browser.ts";

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

registerApiGuards(app, API_TOKEN, EXTRA_ORIGINS, PORT);

registerAdminRoutes(app, retireNow);

registerInfoRoutes(app);

// ── 拉取请求（会话面板的 PR 卡 + bridge 推来的自动修复事件，见 pr.ts）──
registerPrRoutes(app);

registerSettingsRoutes(app);
// 工作区协同（Workspace 工具）：前端上报「用户在看什么」、应答草稿请求——路由与说明在 workspace-routes.ts
registerWorkspaceRoutes(app);
// ── 会话管理（sessmgmt/）：要挂在 /api/sessions/:id 之前 ──
mountSessionMgmt(app);
// 会话协作（family-routes.ts）
registerFamilyRoutes(app);
// 项目对话的概览（project-routes.ts）
registerProjectRoutes(app);
// 子 agent 调用策略（dispatch-routes.ts）：bridge 设置页的四档落点、旧偏好迁移、策略变更通知
registerDispatchRoutes(app);

registerConfigWriteRoute(app, KNOWN_TOOLS);

registerMemoryRoutes(app);

registerRunRoutes(app);

registerSessionListRoutes(app);

registerProjectListRoutes(app);

registerSessionRecordRoutes(app);

registerFileRoutes(app);

registerBrowserRoutes(app);

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

// 后台任务通知：后台命令跑完 / watch 命中而会话已收工时，开一轮把结果交给它（job-notify.ts）
startJobNotify();
// 会话内定时唤醒（ScheduleWakeup）：读回盘上待触发的、到点开轮或在两步之间注入（wakeup/scheduler.ts）
startWakeups();
// 空闲压缩：长对话空闲到 1 小时提示缓存快过期时先压一次（idle-compact.ts）
startIdleCompact();
// 离线记忆整理：所有会话都空闲一阵之后，按工作区把还没复核的记忆拿回写它时的原始对话核对（memory-dream.ts）。
// 照看最近 30 天用过的工作区，新的在前。
startMemoryDream({
  busy: anySessionRunning,
  workspaces: async () => {
    const since = Date.now() - 30 * 86_400_000;
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of (await listSessions()).sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (m.updatedAt < since) break;
      const ws = path.resolve(m.workspace || workspaceRoot());
      const key = process.platform === "win32" ? ws.toLowerCase() : ws;
      if (seen.has(key) || !insideTenant(ws)) continue;
      seen.add(key);
      out.push(ws);
    }
    return out;
  },
});

// M5（K03）：owner 会话已不在的后台 job / dev server，5 分钟巡检一次收掉
setInterval(() => void sweepOrphanResources(), 5 * 60_000).unref();

// 加密存储里的 key 解开再开门：否则刚拉起那一下的 /api/info、首轮请求会看到「缺 Key」
await customKeysReady;

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
  // 子 agent 调用策略：起来就向 bridge 取一次（新会话的系统提示是同步拼的，只读缓存；不是 bridge 拉起的什么都不做）
  void refreshDispatchPolicy();
  // M13：上一个进程被重启切断 / 直接死掉时在跑的轮，起来之后自动接着做（稍等一下，让 bridge 先连上来）。
  // 测试里拉起的 harness 不做（各测试文件共用一个会话目录，别的进程被切断的轮不该在这儿续；要测就显式开 DIMENSIO_AUTO_RESUME）
  if (process.env.DIMENSIO_TEST_ISOLATION !== "1" || process.env.DIMENSIO_AUTO_RESUME === "1") {
    setTimeout(() => {
      // 子 agent 的 worktree：上一个进程没来得及收尾的先收掉（有改动的保留、写进所属会话），再续跑
      void sweepLeftoverWorktrees()
        .catch((e) => console.error(`[subagent] leftover worktrees: ${(e as Error).message}`))
        .finally(() => {
          resumeInterruptedRuns().catch((e) => console.error(`[resume] ${(e as Error).message}`));
          // 会话协作：重启前没送达的会话消息该唤醒的唤醒、发往 bridge 的接着发（续跑先起来，被续的会话照常排队）
          startFamily();
        });
    }, 1500).unref();
  }
  // E1：MCP 连接器起来就开始连（新会话建基线时多半已经连好）
  if (process.env.DIMENSIO_TEST_ISOLATION !== "1") void syncConnectors();
});

// harness 没有 WebSocket 端点（旧的 Edge 扩展链路 /edge-link 已下线，用户的浏览器走 Web Bridge）
httpServer.on("upgrade", (_req, socket) => {
  socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
});
