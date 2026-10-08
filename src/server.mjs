// Muse Bridge HTTP entry: loads config + capabilities, initializes the small
// shared runtime state stores, registers all routes on the mini-router, starts
// the routine scheduler (production only) and binds the server.
//
// Module-level wiring lives here. Endpoint handlers, agent logic, MCP servers
// and persistence are split across:
//   src/config/         — env + capability tables
//   src/runtime/        — router, sse, gen, status, questions, paths, body, routines-runner
//   src/mcp/            — in-process MCPs (terminal, workspace, snapshot)
//   src/agents/         — runClaudeChat
//   src/routes/         — one file per logical endpoint group
//   harness/            — dimensio, spawned per user and reverse-proxied by routes/harness.mjs

import http from 'node:http';
import path from 'node:path';
import { PORT, TOKEN, TOKEN_HASH, VAULT, MODEL, OAUTH, NO_AUTH, ROOT, EDITION, FEATURES } from './config/index.mjs';
import { createAuth } from './auth.mjs';
import { isAdminSession } from './users.mjs';
import { makeIdentify } from './runtime/identity.mjs';
import { createRouter } from './runtime/router.mjs';
import { installFatalGuard, onFault } from './runtime/fatal-guard.mjs';
import { installLifeLog } from './runtime/lifelog.mjs';
import { installLogRing } from './runtime/log-ring.mjs';
import { initInflight } from './runtime/inflight.mjs';
import { initSessionStores } from './runtime/gen.mjs';
import { initStatus } from './runtime/status.mjs';
import { initCtxUsage } from './runtime/ctx-usage.mjs';
import { startRoutineScheduler } from './runtime/routines-runner.mjs';
import { initOutboundProxy } from './runtime/net-proxy.mjs';
import { registerAdminRoutes } from './routes/admin.mjs';
import { registerAuthRoutes } from './routes/auth.mjs';
import { registerPairRoutes } from './routes/pair.mjs';
import { registerChatRoutes } from './routes/chat.mjs';
import { registerUploadRoutes } from './routes/upload.mjs';
import { registerSessionRoutes } from './routes/sessions.mjs';
import { registerOverviewRoutes } from './routes/overview.mjs';
import { registerRoutineRoutes } from './routes/routines.mjs';
import { registerStaticRoutes } from './routes/static.mjs';
import { registerAndroidAppRoutes } from './routes/android-app.mjs';
import { registerFileRoutes } from './routes/files.mjs';
import { registerShareRoutes } from './routes/share.mjs';
import { registerShareSpaceRoutes, resolveShareToken } from './routes/share-space.mjs';
import { registerChatSnapshotRoutes, resolveSnapToken } from './routes/chat-snapshot.mjs';
import { registerExtensionRoutes } from './routes/extensions.mjs';
import { registerAgentRoutes } from './routes/agents.mjs';
import { registerMeRoutes } from './routes/me.mjs';
import { enabledAgents } from './runtime/agent-status.mjs';
import { registerHarnessRoutes } from './routes/harness.mjs';
import { registerClaudeDockRoutes } from './routes/claude-dock.mjs';
import { registerClaudeTaskRoutes } from './routes/claude-tasks.mjs';
import { registerUiStateRoutes } from './routes/ui-state.mjs';
import { registerFeedbackRoutes, envInfo as feedbackEnv } from './routes/feedback.mjs';
import { recordError, flushErrors } from './feedback/errors.mjs';
import { startFeedback } from './feedback/auto.mjs';
import { programVersion } from './feedback/report.mjs';

// 最先装：在此之后发生的任何未捕获异常/未处理拒绝都不再直接掐死这台常驻服务
// （PTY、正在跑的轮全都挂在这个进程上）。见 fatal-guard.mjs。
installFatalGuard('bridge', path.join(ROOT, 'crashdumps'));
// 最近日志留一份在内存里：远程管理的控制台「服务控制」页看（journald / docker logs 手机上够不着）。
installLogRing();
// 紧随其后：进程的生（pid/时间）、活（5min 心跳带 rss）、死（退出原因）各留一行。
// 上次静默停机之所以查不出死因，缺的就是这三行。见 runtime/lifelog.mjs。
installLifeLog('bridge');

// Persistent state (status snapshot, bridge/routine session id Sets) lives on
// disk under ROOT. Hydrate it before any handler runs.
initStatus(ROOT);
initCtxUsage(ROOT);   // 会话级上下文分布 / 实际 effort / 斜杠命令表（ctx-usage.json）
initSessionStores(ROOT);
// 上一条命死在半途的轮：在它们的 transcript 上补一条「本轮被中断」，
// 并记下标记供 /api/attach 当场把前端收敛掉。见 runtime/inflight.mjs。
initInflight(ROOT);

// 出站代理必须在任何出站调用与子进程 spawn 之前定好：子进程只在 spawn 那一刻继承
// process.env，晚一步就不生效。见 runtime/net-proxy.mjs。
await initOutboundProxy();

const { gen: adminGen, adminCredential, authOk, getCookie, bearerToken, queryToken, authCookie, clearAuthCookie, userCookie, clearUserCookie } = createAuth(TOKEN, NO_AUTH, { tokenHash: TOKEN_HASH, isAdminSession });
const identify = makeIdentify({ authOk, getCookie, bearerToken, queryToken, resolveShare: resolveShareToken });
// 快照聊天身份（?ct=）只发给聊天相关的路由模块（chat/answer、attach/active/stop、会话历史/
// 产物、上传）——其余模块拿普通 identify，快照 token 在那儿解析不出身份 → 401。
const identifySnap = makeIdentify({ authOk, getCookie, bearerToken, queryToken, resolveShare: resolveShareToken, resolveSnap: resolveSnapToken });

const router = createRouter();

// 问题反馈：没接住的异常、路由 500 记进 feedback/errors.json（归一、脱敏，只留我们自己代码的帧）。
// 用户报告问题时附上最近的几条；开了自动上报的，新错误会自动发一份。见 src/feedback/。
const FEEDBACK_VERSION = programVersion();
onFault((kind, err) => {
  // 进程可能马上就要被判坏状态退出了：记完立刻落盘，不等防抖
  recordError('server', err instanceof Error ? err : { name: kind, message: String(err) }, { version: FEEDBACK_VERSION }).then(flushErrors);
});
router.onError((err) => { recordError('server', err, { version: FEEDBACK_VERSION }); });
startFeedback({ envInfo: feedbackEnv });

// 所有 /api/* 响应：不外泄 Referer；非 GET 写操作带了外站 Origin 一律拒（CSRF 纵深防御——
// cookie 会话仅靠 SameSite=Lax 在部分 WebView 下不稳）。不带 Origin（顶级导航）放行，交给
// SameSite + Bearer/token；NO_AUTH 调试实例有更严的本地守卫，不在此重复。
router.use((req, res, url) => {
  if (url.pathname.startsWith('/api/')) {
    // 防 admin 令牌经 ?token= 资源链接外泄到第三方 Referer / 隧道访问日志。
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!NO_AUTH && req.method !== 'GET' && req.method !== 'OPTIONS') {
      const origin = req.headers.origin;
      if (origin) {
        let oh = null; try { oh = new URL(origin).host.toLowerCase(); } catch {}
        const host = String(req.headers.host || '').toLowerCase();
        if (!(oh && oh === host)) {
          res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('cross-origin forbidden'); return false;
        }
      }
    }
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return false; }
});

// S1 hardening: a loopback debug instance runs WITHOUT auth (BRIDGE_NO_AUTH), so
// nothing else stops a malicious local web page from POSTing to it (CSRF — e.g.
// /api/chat → run commands as admin) or a DNS-rebind from reaching it. Lock it to
// loopback via the Host header and reject any cross-origin request. The token
// server needs none of this: its Bearer token + SameSite=Lax cookie already defeat
// CSRF, and its Host is the (varying) tunnel / LAN name.
if (NO_AUTH) {
  const isLocalHost = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  router.use((req, res) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    let ok = isLocalHost(host);
    // A cross-site page's fetch carries its own Origin; a same-origin request or a
    // top-level navigation omits it or sends ours. Any foreign Origin -> reject.
    if (ok && req.headers.origin) {
      try { ok = isLocalHost(new URL(req.headers.origin).hostname.toLowerCase()); } catch { ok = false; }
    }
    if (!ok) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return false; }
  });
}

// Route registration order doesn't affect dispatch (paths are exact, not
// prefix), but logical grouping helps grep.
registerStaticRoutes(router);                                 // /, /index.html, /app/*, /healthz
registerAndroidAppRoutes(router);                             // /api/app/android, /download/MuseBridge.apk（安卓 app 下载，不用登录）
registerAuthRoutes(router, { adminCredential, adminGen, identify, getCookie, bearerToken, authCookie, clearAuthCookie, userCookie, clearUserCookie }); // /api/auth, /api/login, /api/register, /api/logout
registerPairRoutes(router, { identify, adminGen, authCookie, userCookie }); // /api/pair/{new,wait,scan,approve,reject,claim} 扫码登录（扫码的一侧只认 admin/user 登录态）
registerChatRoutes(router, { authOk, identify: identifySnap }); // /api/chat, /api/answer（快照身份可用）
registerExtensionRoutes(router, { identify });                // /api/extensions* — 扩展中心（技能/连接器/插件，admin）
registerAgentRoutes(router, { identify });                    // /api/agents — 设置「Agent」页：各 agent 的勾选 / 能跑 / 认证（admin，可远程）
registerMeRoutes(router, { identify, getCookie, bearerToken }); // /api/me/{usage,password} — 用户自助：看自己的额度、改自己的密码
registerUploadRoutes(router, { authOk, identify: identifySnap });   // /api/upload, /api/upload-chunk（快照身份可用）
registerOverviewRoutes(router, { authOk, identify: identifySnap }); // /api/overview, /api/active, /api/attach (GET+POST), /api/stop, /api/status（快照身份可用）
registerFileRoutes(router, { identify: identifySnap });       // /api/files (list), /api/file (stream)（快照身份可用：ctx.cwd 已锁死在自己的桶，ws= 参数要 shell 权限故进不来）
registerShareRoutes(router, { identify });                    // POST /api/share (mint) + GET /s/<token> (public capability-URL download)
registerShareSpaceRoutes(router, { identify });               // POST /api/share-space (mint bucket) + GET /w/<token> (public read-only workspace)
registerChatSnapshotRoutes(router, { identify });             // POST /api/chat-snapshot (mint) + GET /api/csnap/meta + GET /c/<token> (public snapshot chat)
registerSessionRoutes(router, { authOk, identify: identifySnap }); // /api/sessions, /api/session, /api/session/delete, /api/session/export（快照身份可用）
registerHarnessRoutes(router, { identify });                  // /api/harness/* → 反代到每人一个的 dimensio 进程，allowDimensio 门禁
registerClaudeDockRoutes(router, { identify: identifySnap }); // /api/claude/{review,term,dock}/* — Claude 分页右侧工作台（快照身份=审阅/文件，终端仍要 shell）
registerClaudeTaskRoutes(router, { identify: identifySnap }); // GET /api/claude/agent-transcript（子 agent 转录）+ POST /api/claude/task/stop（任务面板单条停止，鉴权同 /api/session）
registerUiStateRoutes(router, { identify: identifySnap });    // /api/ui/{state,answer} — 工作区人机协同上行（视图上报 + 截图/草稿应答）
registerFeedbackRoutes(router, { identify });                 // /api/feedback* — 报告问题（草稿 → 用户同意 → 经 Worker 提到 GitHub）、自动上报开关

registerRoutineRoutes(router, { authOk, identify });          // /api/routines*
registerAdminRoutes(router, { authOk, adminCredential, adminGen }); // /api/admin/*, /api/capabilities


// Only the always-on production server schedules routines. The desktop debug
// instance (BRIDGE_NO_AUTH, loopback-only) must not double-fire them.
// BRIDGE_NO_ROUTINES=1：带 token 鉴权的【测试】实例（如验证 share/snap 身份，NO_AUTH 测不了）
// 也不能双开调度器——与生产实例共用同一份 routines.json，双跑会重复触发真路由。
if (!process.env.BRIDGE_NO_AUTH && !process.env.BRIDGE_NO_ROUTINES) {
  startRoutineScheduler();
}

const server = http.createServer((req, res) => router.dispatch(req, res));
// Bound how long a client may take to send headers / the whole request, so a slow
// or half-open connection can't tie up a socket indefinitely (slowloris). These
// govern the REQUEST only — SSE responses stream as long as needed and the 15s
// heartbeats keep those sockets active.
server.headersTimeout = 60_000;   // 60s to send complete headers
server.requestTimeout = 300_000;  // 5min to send the full request (covers large uploads)

// 部署脚本把它钉在 127.0.0.1（对外只经隧道）；BRIDGE_HOST 没设时监听全部网卡。
// 无鉴权的调试实例永远只听回环。
const BIND_HOST = NO_AUTH ? '127.0.0.1' : (process.env.BRIDGE_HOST || '0.0.0.0');
server.listen(PORT, BIND_HOST, () => {
  console.log('muse-bridge listening on http://' + BIND_HOST + ':' + PORT);
  console.log('  vault : ' + VAULT);
  console.log('  edition: ' + (EDITION === 'host' ? '主机端' : '服务端') + '（多用户 ' + (FEATURES.multiUser ? '开' : '关') + '，远程管理 ' + (FEATURES.remoteAdmin ? '开' : '关') + '）');
  console.log('  agents: ' + (enabledAgents().join(', ') || '(none)'));
  console.log('  model : ' + (MODEL || '(default)'));
  // S6：stdout 被重定向落盘（server.out.log 等），完整 token 打出来=admin 全权凭据进日志。
  // 只留前 4 位方便对号，完整值以 config.json 为准。
  console.log('  token : ' + (TOKEN ? TOKEN.slice(0, 4) + '…（完整值见 config.json，不进日志）' : TOKEN_HASH ? '（config.json 只存哈希；明文只在生成时显示过）' : '(none)'));
  console.log('  auth  : ' + (OAUTH ? 'CLAUDE_CODE_OAUTH_TOKEN set' : process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY set'
    : 'NONE — 设置 CLAUDE_CODE_OAUTH_TOKEN（`claude setup-token` 生成）或 ANTHROPIC_API_KEY，或登录后在控制台「Claude 账号」里添加'));
});

// SIGUSR2 = 「空闲时重启」：跟控制台那颗按钮同一条路（等在跑的轮都结束、排空后退出，交给守护进程拉起）。
// 给拿不到管理员令牌的宿主机脚本用——比如部署脚本把新版本就位后，`systemctl kill -s SIGUSR2 --kill-whom=main bridge`。
process.on('SIGUSR2', async () => {
  console.log('[service] 收到 SIGUSR2：等在跑的对话结束后重启');
  const { requestRestart } = await import('./runtime/service-control.mjs');
  const r = requestRestart('idle', { drain: async () => { try { await (await import('./routes/harness.mjs')).drainHarnesses(); } catch {} } });
  if (r.error) console.warn('[service] ' + r.error);
});
