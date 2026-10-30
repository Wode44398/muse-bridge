// claude-bridge HTTP entry: loads config + capabilities, initializes the small
// shared runtime state stores, registers all routes on the mini-router, starts
// the routine scheduler (production only) and binds the server.
//
// Module-level wiring lives here. Endpoint handlers, agent logic, MCP servers
// and persistence are split across:
//   src/config/         — env + capability tables
//   src/runtime/        — router, sse, gen, status, questions, paths, body, routines-runner
//   src/mcp/            — in-process MCPs (phone, browser, terminal, workspace…)
//   src/agents/         — runClaudeChat（Claude 是核心；其余 agent 在功能扩展里）
//   src/routes/         — one file per logical endpoint group
//   src/modules/        — 功能扩展注册表；Vertex / Codex / dimensio 的代码在 modules/<id>/
//   src/kernel/         — 插件内核（生命周期、服务、扩展槽、配置 schema），不认识任何 bridge 业务
//   src/plugins/        — 插件接线层：内置插件目录（默认套装）、第三方插件的发现 / 安装、Claude 工具槽
//
// 插件化（2026-10-26）：可关的功能（定时任务、分享、设备、手机操控、公网预览……）不再在这里逐个挂，
// 而是登记成插件（plugins/catalog.mjs），由插件内核按开关挂上 / 摘下；这里只挂核心路由、提供核心服务、驱动阶段。

import http from 'node:http';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { PORT, TOKEN, TOKEN_HASH, VAULT, MODEL, OAUTH, NO_AUTH, ROOT, FEATURES, DEPLOY, CONFIG_CREATED, LISTEN_HOST } from './config/index.mjs';
// 数据布局迁移必须紧跟 config、排在其他所有 import 之前：号池、额度策略、账号库在被 import 时就把数据读进内存，
// 迁移晚于它们，改的东西会被它们下一次写盘冲掉（见 runtime/layout-boot.mjs）。
import { bootLayout } from './runtime/layout-boot.mjs';
import { describeDeploy } from './config/deploy-profile.mjs';
import { announceAccess } from './cli/access.mjs';
import { createAuth } from './auth.mjs';
import { isAdminSession, getSession } from './users.mjs';
import { makeIdentify } from './runtime/identity.mjs';
import { createRouter } from './runtime/router.mjs';
import { installFatalGuard, attachCrashDebugger } from './runtime/fatal-guard.mjs';
import { installLifeLog } from './runtime/lifelog.mjs';
import { installLogRing } from './runtime/log-ring.mjs';
import { initInflight } from './runtime/inflight.mjs';
import { initSessionStores } from './runtime/gen.mjs';
import { initStatus } from './runtime/status.mjs';
import { initCtxUsage } from './runtime/ctx-usage.mjs';
import { initOutboundProxy } from './runtime/net-proxy.mjs';
import { initClaudeUpstream } from './runtime/claude-upstream.mjs';
import { initClaudeCli } from './runtime/claude-cli.mjs';
import { registerClaudeCliRoutes } from './routes/claude-cli.mjs';
import { lanIPs, registerAdminRoutes } from './routes/admin.mjs';
import { accountEvents } from './runtime/account-lifecycle.mjs';   // 放在 admin.mjs 之后：模块求值顺序与以前一致
import { registerAuthRoutes } from './routes/auth.mjs';
import { registerPairRoutes } from './routes/pair.mjs';
import { registerChatRoutes } from './routes/chat.mjs';
import { initLimitResume } from './runtime/limit-resume.mjs';
import { initRestartResume } from './runtime/restart-resume.mjs';
import { registerUploadRoutes } from './routes/upload.mjs';
import { registerSessionRoutes } from './routes/sessions.mjs';
import { registerClaudeArchiveRoutes } from './routes/claude-archive.mjs';
import { registerOverviewRoutes } from './routes/overview.mjs';
import { registerMediaFileRoutes } from './routes/media-file.mjs';
import { registerStaticRoutes } from './routes/static.mjs';
import { registerOverlayWeb, registerOverlayRoutes } from './runtime/overlay-web.mjs';
import { registerFileRoutes } from './routes/files.mjs';
import { resolveShareToken } from './routes/share-space.mjs';
import { resolveSnapToken } from './routes/chat-snapshot.mjs';
import { registerAppUpdateRoutes } from './routes/app-update.mjs';
import { registerExtensionRoutes } from './routes/extensions.mjs';
import { registerMemberSkillRoutes } from './routes/member-skills.mjs';
import { registerModuleAdminRoutes } from './routes/modules.mjs';
import { registerAgentRoutes } from './routes/agents.mjs';
import { registerMeRoutes } from './routes/me.mjs';
import { registerAdminAccessRoutes } from './routes/admin-access.mjs';
import { enabledAgents } from './runtime/agent-status.mjs';
import { registerClaudeDockRoutes } from './routes/claude-dock.mjs';
import { registerClaudeTaskRoutes } from './routes/claude-tasks.mjs';
import { registerMcpOAuthRoutes } from './routes/mcp-oauth.mjs';
import { registerSessionCollabRoutes } from './routes/session-collab.mjs';
import { registerClaudeProviderRoutes } from './routes/claude-providers.mjs';
import { registerUiStateRoutes } from './routes/ui-state.mjs';
import { registerDesktopHostRoutes } from './routes/desktop-host.mjs';
import { registerHtmlSiteRoutes } from './runtime/html-site.mjs';
import { installLoopMonitor, trackRequest } from './runtime/loop-monitor.mjs';
import { loadModules, getModule } from './modules/registry.mjs';
import { requestRestart } from './runtime/service-control.mjs';
import { kernel, bootPlugins } from './plugins/host.mjs';
import { registerAll } from './plugins/discover.mjs';
import { pluginOn } from './plugins/state.mjs';
import { pathFilter, DOCK_PLUGIN_PATH } from './plugins/catalog.mjs';
import { registerPluginRoutes } from './routes/plugins.mjs';
import { warmClientFeed } from './runtime/client-release.mjs';
import { PROGRAM_ROOT } from './runtime/paths.mjs';

// 事故防护（2026-10-22）：免鉴权实例必须用环境变量 PORT 显式给端口，且不能是默认的 8787。PORT 一落空就回落到
// config.port / 8787，而 Windows 允许 127.0.0.1:8787 和正式服的 0.0.0.0:8787 同时监听——测试实例会把本机直连
// 与隧道的流量截走。在任何初始化之前就退出。
if (NO_AUTH && (!process.env.PORT || Number(PORT) === 8787)) {
  console.error('拒绝启动：BRIDGE_NO_AUTH=1 的免鉴权实例要用环境变量 PORT 显式指定端口，且不能是 8787（正式服的默认端口）。'
    + `当前 PORT=${process.env.PORT || '(未设)'}，实际会用 ${PORT}。`);
  process.exit(1);
}

// 最先装：在此之后发生的任何未捕获异常/未处理拒绝都不再直接掐死这台常驻服务
// （直播流、PTY、CDP 会话、正在跑的轮全都挂在这个进程上）。见 fatal-guard.mjs。
// 正式服（8787、有鉴权）另开两样重型取证：堆近上限落快照、procdump 挂调试器抓 fail-fast 的 dump。
// dev / 测试实例不开（快照几个 GB、调试器挂错进程反而添乱）。
const PROD_INSTANCE = Number(PORT) === 8787 && !NO_AUTH;
// 堆近上限落快照（写进 cwd，留 2 份，每份可达 GB 级）：小内存 VPS / 发布目录部署用 BRIDGE_HEAP_SNAPSHOT=0 关掉
installFatalGuard('bridge', path.join(ROOT, 'crashdumps'), { heapSnapshot: PROD_INSTANCE && process.env.BRIDGE_HEAP_SNAPSHOT !== '0' });
// 最近日志留一份在内存里：远程管理的控制台「服务控制」页看（journald / docker logs 手机上够不着）。
installLogRing();
// 紧随其后：进程的生（pid/时间）、活（5min 心跳带 rss）、死（退出原因）各留一行。
// 上次静默停机之所以查不出死因，缺的就是这三行。见 runtime/lifelog.mjs。
installLifeLog('bridge');
// 事件循环卡顿观测：卡超过 300ms 记一行带当时在处理的请求，5 分钟一行延迟分位汇总。见 runtime/loop-monitor.mjs。
installLoopMonitor();
// SDK 每次新起 query 都 emitWarning 一条 CLAUDE_SDK_CAN_USE_TOOL_SHADOWED（图表工具有意放进 allowedTools 绕开 auto 分类器，
// 见 mcp/visualize.mjs）：这个 code 每个进程只放行第一条，别让日志看着像满处报错（10-21）。
{
  const emit = process.emitWarning.bind(process);
  const seen = new Set();
  process.emitWarning = (warning, ...rest) => {
    const o = rest[0];
    const code = (o && typeof o === 'object' ? o.code : rest[1]) || (warning && typeof warning === 'object' ? warning.code : '');
    if (code === 'CLAUDE_SDK_CAN_USE_TOOL_SHADOWED') { if (seen.has(code)) return; seen.add(code); }
    return emit(warning, ...rest);
  };
}

// 数据布局版本（_system/layout.json）：迁移已在 import 阶段由 runtime/layout-boot.mjs 跑完（早于任何数据模块载入），
// 这里只在日志环装好之后报结果。v0 → v1 不改数据、只落版本号；失败不挡启动，下次重试；
// 磁盘版本比代码新（装回了旧版本）只报不动。见 runtime/layout.mjs。
{
  const lay = bootLayout;
  if (lay.error) console.error('[layout] 数据布局迁移失败，停在 v' + lay.version + '：' + lay.error);
  else if (lay.newer) console.warn('[layout] 数据布局是 v' + lay.version + '，比这个版本认识的新——没有改动任何数据');
  else if (lay.ran.length) console.log('[layout] 数据布局 v' + lay.from + ' → v' + lay.version + '（' + lay.ran.join('、') + '）');
}

// 账号停用 / 删除（account-lifecycle 的 'ended'）：收掉他名下的侧栏终端与无头浏览器——池按（属主, 路径）键控，
// 一直有输出的 shell 回收器收不走，他已打开的终端直播流也不会重新鉴权（开源路线 C6）。删号时 deleteAccount
// 已顺手调过一次，这里再调是空操作；停用只靠这里。两个池模块按需加载，没加载过说明他没开过，收不收都一样。
accountEvents.on('ended', ({ key } = {}) => {
  if (!key) return;
  import('./runtime/claude-term.mjs').then((m) => m.killTermsOf(key)).catch(() => {});
  import('./runtime/claude-browser.mjs').then((m) => m.closeBrowsersOf(key)).catch(() => {});
});

// Persistent state (status snapshot, bridge/routine session id Sets) lives on
// disk under ROOT. Hydrate it before any handler runs.
initStatus(ROOT);
initCtxUsage(ROOT);   // 会话级上下文分布 / 实际 effort / 斜杠命令表（ctx-usage.json）
initSessionStores(ROOT);
// 上一条命死在半途的轮：在它们的 transcript 上补一条「本轮被中断」，
// 并记下标记供 /api/attach 当场把前端收敛掉。见 runtime/inflight.mjs。
const inflightOrphans = initInflight(ROOT);

// 出站代理必须在任何出海调用（含 codex app-server 这种常驻子进程 spawn）之前定好：
// 子进程只在 spawn 那一刻继承 process.env，晚一步就不生效。见 runtime/net-proxy.mjs。
await initOutboundProxy();
// 号池「会话中无缝换号」的本机上游代理（开关开着才起）。见 runtime/claude-upstream.mjs。
initClaudeUpstream();
// Claude Code 运行组件：源码直跑用 SDK 自带的（行为同以前）；安装包不再内嵌，没有就在后台从官方源下到数据根
// （出站代理已就绪，不等它下完）。见 runtime/claude-cli.mjs。
initClaudeCli();

// 功能扩展（Vertex / Codex / dimensio）在挂路由、判 agent 开关之前加载完：
// agent 能不能跑先看所属扩展在不在。没装 / 加载失败的扩展只是不可用，不影响核心。见 modules/registry.mjs。
await loadModules();

const { gen: adminGen, adminCredential, authOk, getCookie, bearerToken, queryToken, authCookie, clearAuthCookie, userCookie, clearUserCookie } = createAuth(TOKEN, NO_AUTH, { tokenHash: TOKEN_HASH, isAdminSession,
  // 与 identify 同口径：多用户关着时只认服务账号
  isUserSession: (t) => { const s = getSession(t); return !!(s && (FEATURES.multiUser || s.service)); } });
// 分享 / 快照令牌只在对应插件开着时才认：插件关了，已发出去的链接一并失效（而不是路由没了、令牌还能当身份用）。
const resolveShare = (...a) => (pluginOn('share') ? resolveShareToken(...a) : null);
const resolveSnap = (...a) => (pluginOn('chat-snapshot') ? resolveSnapToken(...a) : null);
const identify = makeIdentify({ authOk, getCookie, bearerToken, queryToken, resolveShare });
// 快照聊天身份（?ct=）只发给聊天相关的路由模块（chat/answer、attach/active/stop、会话历史/
// 产物、上传）——其余模块拿普通 identify，快照 token 在那儿解析不出身份 → 401，
// vertex/媒体等烧钱端点对快照访客天然关闭。
const identifySnap = makeIdentify({ authOk, getCookie, bearerToken, queryToken, resolveShare, resolveSnap });

const router = createRouter();
// 带插件票据、打到插件自己接口上的请求（下面两道 Origin 守卫对它放行）
const pluginTicketReq = (req, url) => /^Plugin\s/i.test(String(req.headers.authorization || ''))
  && (url.pathname.startsWith('/api/plugin/') || url.pathname === '/api/plugins/page-events');

// 公网预览（pv-<token>.<域>）的 Host 接管是插件（preview-host）：中间件带负的 order，插件启用得晚也照样排在下面的 CORS 之前
// （见 plugins/catalog.mjs）。维护者部署的官网（根域 / www）不在核心里，由私有 overlay 的 registerRoutes 钩子挂（同样带负 order）；
// 公开版没有它，根域名就是 bridge 自己。

// CORS：离线 apk 的前端跑在自定义本地源（https://appassets.androidplatform.net），
// 访问 /api/* 是跨源请求——放行它们并处理 OPTIONS 预检。鉴权仍由各 handler 的
// Bearer token / cookie 把关；CORS 只管浏览器跨源策略。Allow-Origin:* 即可：admin
// 走 Authorization 头、媒体走 ?token=，都不依赖跨源 cookie（前端 credentials:same-origin）。
router.use((req, res, url) => {
  if (url.pathname.startsWith('/api/')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
    // 防 admin 令牌经 ?token= 资源链接外泄到第三方 Referer / 隧道访问日志。
    res.setHeader('Referrer-Policy', 'no-referrer');
    // CSRF 纵深防御（生产隧道服务器）：跨站 fetch/form 会带 Origin。非 GET 写操作若带了 Origin
    // 且既非本站、也非离线壳 appassets 源 → 拒（cookie 会话仅靠 SameSite=Lax 在部分 WebView 下不稳）。
    // 不带 Origin（顶级导航 / APK 直连）放行，交给 SameSite + Bearer/token；NO_AUTH 控制台有更严的本地守卫，不在此重复。
    // 插件页面（CSP sandbox，不透明源，Origin: null）带插件票据调插件自己的接口：票据在请求头里、不是浏览器自动带的凭据，
    // 没有 CSRF 面，放行（票据只在 /api/plugin/<id>/ 与页面事件流认，见 plugins/tickets.mjs）。
    if (!NO_AUTH && req.method !== 'GET' && req.method !== 'OPTIONS' && !pluginTicketReq(req, url)) {
      const origin = req.headers.origin;
      if (origin) {
        let oh = null; try { oh = new URL(origin).host.toLowerCase(); } catch {}
        const host = String(req.headers.host || '').toLowerCase();
        if (!(oh && (oh === host || oh === 'appassets.androidplatform.net'))) {
          res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('cross-origin forbidden'); return false;
        }
      }
    }
  } else if (url.pathname === '/agent' || url.pathname.startsWith('/agent/') || url.pathname === '/llms.txt') {
    // 给 agent 用的接口（src/agent-api/）：只认请求头里的凭据、不认 cookie，没有 CSRF 面，跨域整个放开（不做上面的 Origin 检查）。
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Bridge-Key');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Referrer-Policy', 'no-referrer');
  }
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return false; }
});

// S1 hardening: the loopback debug console runs WITHOUT auth (BRIDGE_NO_AUTH), so
// nothing else stops a malicious local web page from POSTing to it (CSRF — e.g.
// /api/chat → run commands as admin) or a DNS-rebind from reaching it. Lock it to
// loopback via the Host header and reject any cross-origin request. The token
// server needs none of this: its Bearer token + SameSite=Lax cookie already defeat
// CSRF, and its Host is the (varying) tunnel / LAN name.
if (NO_AUTH) {
  const isLocalHost = (h) => h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
  router.use((req, res, url) => {
    const host = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
    let ok = isLocalHost(host);
    // A cross-site page's fetch carries its own Origin; a same-origin request or a
    // top-level navigation omits it or sends ours. Any foreign Origin -> reject.
    // 插件页面与 SDK（GET /plugins/*，免登录的静态文件）由不透明源的页面加载，带 Origin: null：不查 Origin（Host 照查）
    const pluginStatic = req.method === 'GET' && url.pathname.startsWith('/plugins/');
    if (ok && req.headers.origin && !pluginTicketReq(req, url) && !pluginStatic) {
      try { ok = isLocalHost(new URL(req.headers.origin).hostname.toLowerCase()); } catch { ok = false; }
    }
    if (!ok) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return false; }
  });
}

// Route registration order doesn't affect dispatch (paths are exact, not
// prefix), but logical grouping helps grep.
registerOverlayWeb(router);                                   // 私有 overlay 网页层：/app/_ov/*、/app/* 补缺、HTML 壳注入（必须在静态路由之前）
registerStaticRoutes(router);                                 // /, /index.html, /debug.html
registerAuthRoutes(router, { adminCredential, adminGen, identify, getCookie, bearerToken, authCookie, clearAuthCookie, userCookie, clearUserCookie }); // /api/auth, /api/login, /api/register, /api/logout
registerPairRoutes(router, { identify, adminGen, authCookie, userCookie, lanIPs, adminCredential, getCookie, bearerToken, clearAuthCookie, clearUserCookie }); // /api/pair/{new,wait,scan,approve,reject,claim} 扫码登录 + /api/pair/connect*、/api/pair/redeem 扫码配对（S1-2；票绑出示方那次登录、确认后替换原登录）
registerChatRoutes(router, { authOk, identify: identifySnap }); // /api/chat, /api/answer, /api/phone-result（快照身份可用）
initLimitResume();   // 5 小时限额重置后自动继续：把落盘的待续会话重新排上（重放口由上一行挂好）
initRestartResume(inflightOrphans);   // 服务意外重启后自动继续：上一条命没跑完的轮过十几秒在服务端替用户说「继续」（设置可关）
registerExtensionRoutes(router, { identify });                // /api/extensions* — 扩展中心（技能/连接器/插件，admin）
registerMemberSkillRoutes(router, { identify });              // /api/my-extensions* — 成员自己添加的技能（只有技能；Claude + dimensio）
registerModuleAdminRoutes(router, { identify });              // /api/modules* — 扩展中心「功能扩展」（离线包装 / 卸，admin，重启生效）
registerAgentRoutes(router, { identify });                    // /api/agents — 设置「Agent」页：各 agent 的勾选 / 能跑 / 认证（admin，可远程）
registerClaudeCliRoutes(router, { identify });                // /api/claude-cli(/retry) — Claude Code 运行组件的下载进度 / 重试（admin）
registerMeRoutes(router, { identify, getCookie, bearerToken }); // /api/me/{usage,password} — 用户自助：看自己的额度、改自己的密码
registerAdminAccessRoutes(router, { identify });              // /api/me/admin-access — 成员自己决定管理员能不能看内容 / 代聊代答 / 看他的电脑，并看访问记录（S2-7）
registerUploadRoutes(router, { authOk, identify: identifySnap });   // /api/upload, /api/upload-chunk（快照身份可用）
registerOverviewRoutes(router, { authOk, identify: identifySnap }); // /api/overview, /api/active, /api/attach (GET+POST), /api/stop, /api/status（快照身份可用）
registerFileRoutes(router, { identify: identifySnap });       // /api/files (list), /api/file (stream)（快照身份可用：ctx.cwd 已锁死在自己的桶，ws= 参数要 shell 权限故进不来）
registerHtmlSiteRoutes(router);                               // GET /api/hv/<id>/… — HtmlView 的路径式站点挂载（能力令牌，CSP sandbox）
  registerSessionRoutes(router, { authOk, identify: identifySnap }); // /api/sessions, /api/session, /api/session/delete, /api/session/export（快照身份可用）
// /api/claude/{review,dock}/* — Claude 分页右侧工作台的核心部分；终端（term）与浏览器（browser）两组归各自的插件挂
registerClaudeDockRoutes(pathFilter(router, (p) => !p.startsWith(DOCK_PLUGIN_PATH.browser) && !p.startsWith(DOCK_PLUGIN_PATH.terminal)), { identify: identifySnap });
registerClaudeTaskRoutes(router, { identify: identifySnap }); // GET /api/claude/agent-transcript（子 agent 转录）+ POST /api/claude/task/stop（任务面板单条停止，鉴权同 /api/session）
registerMcpOAuthRoutes(router, { identify });                 // /api/mcp-oauth/* — 远程连接器 OAuth 授权（回调路由不要求登录，只认进行中流程的 state）
registerClaudeArchiveRoutes(router, { identify });               // POST /api/claude/archive + GET /api/claude/search — 会话归档与全文搜索（登录身份，快照访客不开放）
registerSessionCollabRoutes(router, { identify });            // /api/claude/proposals、/proposal/{start,dismiss}、/peer-hold — 「Claude 发起新会话」卡片与跨会话消息确认
registerClaudeProviderRoutes(router, { identify });          // /api/claude/providers/* — 设置 › Claude › 模型服务（自定义 API，仅主机管理员）
registerUiStateRoutes(router, { identify: identifySnap });    // /api/ui/{state,answer} — 工作区人机协同上行（视图上报 + 截图/草稿应答）
registerDesktopHostRoutes(router, { identify });               // /api/desktop/browser-host — 桌面壳注册原生浏览器宿主（服务端与壳同机时）

registerMediaFileRoutes(router, { identify });                // GET /api/vertex/media — 已生成媒体的只读服务（核心：Vertex 没装时历史图照样显示）
registerAdminRoutes(router, { authOk, adminCredential, adminGen }); // /api/admin/*, /api/lan, /api/capabilities

registerAppUpdateRoutes(router, { authOk, identify, lanIPs }); // /api/app/{version,download,hello,server-info} + /download/android（手机扫码下载 App）

registerPluginRoutes(router, { identify });                   // /api/plugins* — 设置 › 扩展 › 功能扩展（插件管理，admin）+ /plugins/<id>/web/*（插件页面）

// Only the always-on production server schedules routines. The desktop debug
// instance (BRIDGE_NO_AUTH, loopback-only) must not double-fire them.
// BRIDGE_NO_ROUTINES=1：带 token 鉴权的【测试】实例（如验证 share/snap 身份，NO_AUTH 测不了）
// 也不能双开调度器——与生产实例共用同一份 routines.json，双跑会重复触发真路由。
// 定时任务、自动归档、PR 扫描、反馈汇总、agent 扩展的预热都是插件，各自在 'ready' 阶段按它判。
const PRODUCTION = !process.env.BRIDGE_NO_AUTH && !process.env.BRIDGE_NO_ROUTINES;

const server = http.createServer((req, res) => { trackRequest(req, res); router.dispatch(req, res); });

// ── 插件 ──────────────────────────────────────────────────────────────────
// 核心先把插件要用的服务摆出来，再登记（内置目录 + agent 扩展 + 第三方）并按开关启用。
// 插件挂的路由都在核心路由之后（精确路径不分先后；中间件按 order）。
kernel.provide('router', router);
kernel.provide('auth', { authOk, identify, identifySnap, adminGen, adminCredential, getCookie, bearerToken });
kernel.provide('runtime', Object.freeze({ production: PRODUCTION, prodInstance: PROD_INSTANCE, noAuth: NO_AUTH, port: PORT, dataRoot: ROOT, programRoot: PROGRAM_ROOT }));
kernel.provide('httpServer', server);
await bootPlugins({ register: registerAll });

// 私有 overlay 的接口（钩子 registerRoutes，没有 overlay / 没有这个钩子就什么都不挂）。见 runtime/overlay-web.mjs。
await registerOverlayRoutes(router, { authOk, identify });

// 'ready'：路由都挂完、开始监听之前（各插件的后台任务、agent 扩展的预热在这里起）。
await kernel.enterPhase('ready');
// Bound how long a client may take to send headers / the whole request, so a slow
// or half-open connection can't tie up a socket indefinitely (slowloris). These
// govern the REQUEST only — SSE responses stream as long as needed and the 15s
// heartbeats keep those sockets active.
server.headersTimeout = 60_000;   // 60s to send complete headers
server.requestTimeout = 300_000;  // 5min to send the full request (covers large uploads)

// 监听地址按部署形态（config/deploy-profile.mjs）：本机桌面与 Docker 听所有网卡（同一 Wi-Fi 的手机直连
// http://<lan-ip>:PORT；容器对外由端口映射决定），新装的无界面服务器只听 127.0.0.1（对外走隧道 / 反代）；
// BRIDGE_HOST 一律优先，S1-7 之前的老配置照旧 0.0.0.0。NO_AUTH 的桌面本机实例永远只听回环（config/index.mjs 的 LISTEN_HOST）。
const BIND_HOST = LISTEN_HOST;
server.listen(PORT, BIND_HOST, () => {
  console.log('claude-bridge listening on http://' + BIND_HOST + ':' + PORT);
  // 端口到手才挂调试器：抢端口失败的第二个实例马上会退，不该给它挂（见 fatal-guard.mjs）
  if (PROD_INSTANCE) attachCrashDebugger('bridge', path.join(ROOT, 'crashdumps'), path.join(ROOT, '.bin', 'procdump', 'procdump64.exe'));
  // 容器里的「局域网 IP」是 Docker 内网地址，打出来只会误导——端口映射见 docker-compose.yml
  if (BIND_HOST !== '127.0.0.1' && !existsSync('/.dockerenv')) for (const ip of lanIPs()) console.log('  LAN   : http://' + ip + ':' + PORT + '  (same-WiFi direct, no tunnel)');
  console.log('  vault : ' + VAULT);
  console.log('  features: 多用户 ' + (FEATURES.multiUser ? '开' : '关') + '，远程管理 ' + (FEATURES.remoteAdmin ? '开' : '关'));
  console.log('  deploy: ' + describeDeploy({ ...DEPLOY, audience: FEATURES.multiUser ? 'shared' : 'self' }));
  console.log('  agents: ' + (enabledAgents().join(', ') || '(none)'));
  console.log('  model : ' + (MODEL || '(default)'));
  // S6：stdout 被重定向落盘（server.out.log 等），完整 token 打出来=admin 全权凭据进日志。
  // 只留前 4 位方便对号，完整值以 config.json 为准。
  console.log('  token : ' + (TOKEN ? TOKEN.slice(0, 4) + '…（完整值见 config.json，不进日志）' : TOKEN_HASH ? '（config.json 只存哈希；明文只在生成时显示过）' : '(none)'));
  console.log('  auth  : ' + (OAUTH ? 'CLAUDE_CODE_OAUTH_TOKEN set' : process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY set'
    : 'NONE — 设置 CLAUDE_CODE_OAUTH_TOKEN（`claude setup-token` 生成）或 ANTHROPIC_API_KEY：Docker 写进 .env，否则 npm run set-auth -- <令牌>'));
  console.log('  公网  : 控制台「服务控制 → 公网访问」（快速隧道 / Cloudflare 命名隧道 / 自己的域名）');
  // 无界面形态（server / docker）：打「怎么连上它」——地址、令牌与扫码配对的取法，不打印凭据；首次启动且 stdout 是终端时
  // 再出一张配对二维码（S1-7 配合 S1-2；一次性票只进屏幕、不进日志文件。BRIDGE_PAIR_BANNER=0 关、=1 强制）
  announceAccess({ deploy: DEPLOY, port: PORT, bindHost: BIND_HOST, tokenHashOnly: !TOKEN && !!TOKEN_HASH, fresh: CONFIG_CREATED, token: TOKEN, noAuth: NO_AUTH });
  // 公网访问（public-access 插件：内置托管 cloudflared）等在 'listening' 阶段起。
  kernel.enterPhase('listening').catch((e) => console.error('[plugins] listening 阶段出错：', e?.message || e));
  // 桌面客户端的上游更新清单（第三方服务器 / 本机服务端用；显式配了 clientDist 的发版机不问上游）
  warmClientFeed();
});

// SIGUSR2 = 「空闲时重启」：跟控制台那颗按钮同一条路（等在跑的轮都结束、排空后退出，交给守护进程拉起）。给拿不到管理员令牌的
// 宿主机脚本用——比如部署脚本把新版本就位后 `systemctl kill -s SIGUSR2 --kill-whom=main bridge`（Muse Bridge 的看门狗与安装脚本）。
// Node 对 SIGUSR2 的默认动作是直接退出：不挂处理器，这一下就把在跑的对话硬杀了。Windows 没有这个信号。
if (process.platform !== 'win32') {
  process.on('SIGUSR2', () => {
    console.log('[service] 收到 SIGUSR2：等在跑的对话结束后重启');
    const r = requestRestart('idle', { drain: async () => { try { await getModule('dimensio')?.drainHarnesses?.(); } catch {} } });
    if (r.error) console.warn('[service] ' + r.error);
  });
}
