// 内置插件目录（默认套装）：随程序发布、默认开着的功能。每一项都能在「设置 › 扩展 › 功能扩展」里单独关掉。
//
// 每项 = 清单（名称、说明、分类、依赖、配置 schema……）+ load()：load 里才 import 功能代码，关着的功能连代码都不加载。
// 功能代码本身留在原处（src/routes、src/runtime），这里只负责「挂上 / 摘下」——挂路由用 ctx.router（记账版，停用即摘）。
//
// 分类：network 网络与访问 · agent-tools Claude 的工具 · automation 自动化 · sharing 分享 · devices 设备与手机 ·
//       integration 对接 · appearance 外观 · system 系统
//
// restart:true 的几项包着 import 即有副作用或起子进程的老代码，运行中改开关只落盘、重启服务后生效。
// 门控型插件（apply 是空的）：功能代码在 Claude 主链路里，开关处查 pluginOn(id)（见 agents/claude.mjs）。

import {
  PHONE_FS, PHONE_CONTROL, CLAUDE_IN_CHROME, DEPLOY, PORT, NO_AUTH, LISTEN_HOST, ROOT, config, setRuntimePublicOrigin,
} from '../config/index.mjs';
import { PROGRAM_ROOT } from '../runtime/paths.mjs';

const auth = (ctx) => ctx.service('auth');
const runtime = (ctx) => ctx.service('runtime');
const gateOnly = async () => ({ apply() {} });

// 只把某些路径交给 register 函数挂（一个老路由文件里混着几项功能时按路径分给各自的插件）。
export function pathFilter(router, keep) {
  return {
    on: (m, p, h) => (keep(p) ? router.on(m, p, h) : null),
    use: (fn, o) => router.use(fn, o),
    prefix: (m, p, h) => (keep(p) ? router.prefix(m, p, h) : null),
    has: router.has,
  };
}
export const DOCK_PLUGIN_PATH = { browser: '/api/claude/browser/', terminal: '/api/claude/term/' };

export const BUILTIN_PLUGINS = [
  // ── 网络与访问（Host 接管类排在 CORS 之前：order 负数） ─────────────────
  {
    id: 'preview-host', name: '公网预览', category: 'network',
    description: '把 pv-<令牌>.<域名> 的请求转给本机开发服务器或设备上的端口：Claude 做网页时能给出一个手机上也能打开的预览地址。',
    load: async () => {
      const { registerPreviewHostRoutes, attachPreviewHostUpgrade } = await import('../routes/preview-host.mjs');
      return {
        apply(ctx) {
          registerPreviewHostRoutes(ctx.routerAt(-200));
          ctx.effect(() => attachPreviewHostUpgrade(ctx.service('httpServer')));
        },
      };
    },
  },
  {
    id: 'public-access', name: '公网访问', category: 'network', restart: true,
    description: '内置托管 cloudflared 隧道，给服务器一个公网地址（控制台「服务控制 → 公网访问」里选模式）。',
    load: async () => {
      const { initPublicAccess } = await import('../runtime/public-access.mjs');
      const { onPublicAccessEvent } = await import('../runtime/address-events.mjs');
      const { busPublish } = await import('../runtime/bus.mjs');
      return {
        apply(ctx) {
          ctx.when('listening', () => {
            // 隧道转发的目标跟着监听地址走：听的是某个具体地址（BRIDGE_HOST）时 127.0.0.1 上没有人。
            const host = LISTEN_HOST;
            const wild = host === '0.0.0.0' || host === '::' || host === '127.0.0.1';
            initPublicAccess({
              dataRoot: ROOT, programRoot: PROGRAM_ROOT, port: PORT, noAuth: NO_AUTH,
              localTarget: wild ? 'http://127.0.0.1:' + PORT : 'http://' + (host.includes(':') ? '[' + host + ']' : host) + ':' + PORT,
              setOrigin: setRuntimePublicOrigin,
              // 管理员控制台收完整状态；地址变了 / 马上要变（先接后拆）再转成给所有在线设备的 server.address（S1-1）
              publish: (ev) => { busPublish('admin', ev); onPublicAccessEvent(ev); },
            });
          });
        },
      };
    },
  },

  // ── 对接 ──────────────────────────────────────────────────────────────
  {
    id: 'agent-api', name: '给 agent 的接口', category: 'integration',
    description: '/agent 接口与项目手册：外部 agent 用密钥调用 bridge；bridge 里的 Claude 也靠它查手册、操作 bridge（bridge 工具）。',
    load: async () => {
      const { registerAgentApiRoutes } = await import('../agent-api/http.mjs');
      return { apply(ctx) { registerAgentApiRoutes(ctx.router, { identify: auth(ctx).identify, adminGen: auth(ctx).adminGen }); } };
    },
  },
  {
    id: 'feedback', name: '反馈', category: 'integration',
    description: '设置里的「反馈」：写进本机反馈库；管理员开了推送、提交人也勾了时转给开发者。',
    load: async () => {
      const { registerFeedbackRoutes } = await import('../routes/feedback.mjs');
      const { feedbackUpstream } = await import('../runtime/feedback-upstream.mjs');
      return {
        apply(ctx) {
          registerFeedbackRoutes(ctx.router, { identify: auth(ctx).identify });
          // 推送端补发、汇总端拉收件箱：只在正式实例跑（模块里自己再判一次 NO_AUTH / NO_ROUTINES）
          ctx.when('ready', () => {
            if (!runtime(ctx).production) return;
            feedbackUpstream().start();
            return () => feedbackUpstream().stop();
          });
        },
      };
    },
  },

  // ── 自动化 ─────────────────────────────────────────────────────────────
  {
    id: 'routines', name: '定时任务', category: 'automation',
    description: '按时间表自动跑 Claude / Gemini 任务（含 agent 接口的 routines.* 操作）。',
    load: async () => {
      const { registerRoutineRoutes } = await import('../routes/routines.mjs');
      const { startRoutineScheduler } = await import('../runtime/routines-runner.mjs');
      return {
        apply(ctx) {
          registerRoutineRoutes(ctx.router, { authOk: auth(ctx).authOk, identify: auth(ctx).identify });
          // 只有常驻的正式实例调度：调试 / 测试实例与正式服共用 routines.json，双开会重复触发。
          ctx.when('ready', () => {
            if (!runtime(ctx).production) return;
            const h = startRoutineScheduler();
            return () => clearInterval(h);
          });
        },
      };
    },
  },
  {
    id: 'auto-archive', name: '自动归档', category: 'automation',
    description: '每小时把不活跃的会话归档（设置「归档不活跃的会话」）。',
    load: async () => {
      const { startClaudeAutoArchive } = await import('../routes/claude-archive.mjs');
      const { stopAutoArchive } = await import('../runtime/session-archive-auto.mjs');
      return {
        apply(ctx) {
          ctx.when('ready', () => {
            if (!runtime(ctx).production && process.env.BRIDGE_AUTO_ARCHIVE !== '1') return;
            startClaudeAutoArchive();
            return () => stopAutoArchive();
          });
        },
      };
    },
  },
  {
    id: 'pr', name: '拉取请求', category: 'automation',
    description: '会话绑定 GitHub PR：PR 卡、CI 状态、自动修复与代合并（需要本机登录了 gh），以及 Claude 的 pr 工具。',
    load: async () => {
      const { registerClaudePrRoutes } = await import('../routes/claude-pr.mjs');
      const { initPrMonitor, stopPrMonitor } = await import('../runtime/pr-monitor.mjs');
      return {
        apply(ctx) {
          registerClaudePrRoutes(ctx.router, { identify: auth(ctx).identify });
          // 后台扫描同理只在正式实例跑：台账与正式服共用，双开会把同一个会话叫醒两次。
          ctx.when('ready', () => {
            if (!runtime(ctx).production && process.env.BRIDGE_PR_MONITOR !== '1') return;
            initPrMonitor();
            return () => stopPrMonitor();
          });
        },
      };
    },
  },
  {
    id: 'keep-awake', name: '保持唤醒', category: 'system', restart: true,
    description: 'Claude 干活时不让这台电脑睡眠（设置 › Claude › 这台电脑）。',
    available: () => DEPLOY.keepAwake !== 'none',
    load: async () => {
      const { initKeepAwake, _setKeepAwakeDriver } = await import('../runtime/keep-awake.mjs');
      const { inhibitDriver, inhibitUsable } = await import('../runtime/keep-awake-inhibit.mjs');
      const { setKeepAwakeCapability } = await import('../runtime/claude-settings.mjs');
      return {
        apply() {
          // Linux（非容器）换成 systemd-inhibit；Windows 用 keep-awake.mjs 自带的驱动（S1-7）
          if (DEPLOY.keepAwake === 'inhibit') _setKeepAwakeDriver(() => inhibitDriver());
          // 设置 › Claude 的「保持唤醒」两项只在真能起作用时出（快照的 unsupported）；插件关着时从不挂 = 不出
          setKeepAwakeCapability(() => DEPLOY.keepAwake === 'windows' || (DEPLOY.keepAwake === 'inhibit' && inhibitUsable()));
          initKeepAwake();
        },
      };
    },
  },

  // ── 分享 ───────────────────────────────────────────────────────────────
  {
    id: 'share', name: '分享链接', category: 'sharing',
    description: '把文件 / 文件夹生成公开的只读链接（/s/、/w/），可设密码与有效期。',
    load: async () => {
      const { registerShareRoutes } = await import('../routes/share.mjs');
      const { registerShareSpaceRoutes } = await import('../routes/share-space.mjs');
      return {
        apply(ctx) {
          registerShareRoutes(ctx.router, { identify: auth(ctx).identify });
          registerShareSpaceRoutes(ctx.router, { identify: auth(ctx).identify });
        },
      };
    },
  },
  {
    id: 'chat-snapshot', name: '快照对话', category: 'sharing',
    description: '把一段会话做成别人能接着聊的快照链接（/c/）；访客只拿到这一段对话和只读工具。',
    load: async () => {
      const { registerChatSnapshotRoutes } = await import('../routes/chat-snapshot.mjs');
      return { apply(ctx) { registerChatSnapshotRoutes(ctx.router, { identify: auth(ctx).identify }); } };
    },
  },

  // ── 外观 ───────────────────────────────────────────────────────────────
  {
    id: 'wallpapers', name: '自定义壁纸', category: 'appearance',
    description: '上传自己的壁纸（可带深度图做空间壁纸），存在工作空间的「壁纸」文件夹。',
    load: async () => {
      const { registerWallpaperRoutes } = await import('../routes/wallpapers.mjs');
      return { apply(ctx) { registerWallpaperRoutes(ctx.router, { identify: auth(ctx).identify }); } };
    },
  },

  // ── 设备与手机 ──────────────────────────────────────────────────────────
  {
    id: 'devices', name: '设备', category: 'devices', restart: true,
    description: '把装了桌面客户端的电脑登记成设备：Claude 能看屏幕、操作桌面、跑命令、传文件、驱动它的浏览器。',
    defaultEnabled: () => config.devices !== false,
    load: async () => {
      const { registerDeviceRoutes } = await import('../routes/devices.mjs');
      const { primeServerMachineId } = await import('../runtime/devices.mjs');
      const { ensureHostSecret } = await import('../runtime/host-secret.mjs');
      return {
        apply(ctx) {
          const a = auth(ctx);
          registerDeviceRoutes(ctx.router, { identify: a.identify, adminCredential: a.adminCredential, adminGen: a.adminGen });
          // 首启就确保 config.json 里有主机密钥——同机子进程（Codex / dimensio）经内部接口操作设备时出示它；
          // 本机指纹（判断「哪台设备就是服务端这台机器」）异步预热。
          if (process.env.BRIDGE_DEVICES !== '0') { ensureHostSecret(); primeServerMachineId(); }
        },
      };
    },
  },
  {
    id: 'phone-control', name: '手机操控', category: 'devices',
    description: 'Claude 经手机上的常驻服务操作安卓手机：开 app、看画面、点按、输入（手机 App 里也要打开「手机操控」）。',
    config: {
      tools: { type: 'boolean', label: '给 Claude 手机操控工具', default: PHONE_CONTROL,
        desc: '关掉时手机仍能连上（命令通道在），只是 Claude 不再拿到 mcp__phoneControl__* 工具。' },
    },
    load: async () => {
      const { registerPhoneControlRoutes } = await import('../routes/phone-control.mjs');
      return { apply(ctx) { registerPhoneControlRoutes(ctx.router, { identify: auth(ctx).identify }); } };
    },
  },
  {
    id: 'phone-files', name: '手机文件', category: 'devices',
    description: '从手机 App 发起的对话里，Claude 可以查看 / 读写 / 拉取这台手机上的文件（mcp__phone__* 工具）。',
    defaultEnabled: () => PHONE_FS,
    load: gateOnly,
  },

  // ── Claude 的工具 ──────────────────────────────────────────────────────
  {
    id: 'browser', name: '内置浏览器', category: 'agent-tools',
    description: 'Claude 页右侧的「浏览器」面板与 Claude 的 browser 工具：按工作空间隔离的无头浏览器，你能看着它操作。',
    load: async () => {
      const { registerClaudeDockRoutes } = await import('../routes/claude-dock.mjs');
      return { apply(ctx) { registerClaudeDockRoutes(pathFilter(ctx.router, (p) => p.startsWith(DOCK_PLUGIN_PATH.browser)), { identify: auth(ctx).identifySnap }); } };
    },
  },
  {
    id: 'terminal', name: '共享终端', category: 'agent-tools',
    description: 'Claude 页右侧的「终端」面板与 Claude 的 terminal 工具：你和 Claude 共用同一个 shell。',
    load: async () => {
      const { registerClaudeDockRoutes } = await import('../routes/claude-dock.mjs');
      return { apply(ctx) { registerClaudeDockRoutes(pathFilter(ctx.router, (p) => p.startsWith(DOCK_PLUGIN_PATH.terminal)), { identify: auth(ctx).identifySnap }); } };
    },
  },
  {
    id: 'workspace-tools', name: '工作区协同', category: 'agent-tools',
    description: 'Claude 的 workspace 工具：知道你此刻打开的是哪个文件（含未保存草稿），做完能把成果直接弹到你眼前。',
    load: gateOnly,
  },
  {
    id: 'session-tools', name: '会话协作', category: 'agent-tools',
    description: 'Claude 的 sessions 工具：另开子会话并行干活、和别的会话互发消息、自动收到子会话的汇报。',
    load: gateOnly,
  },
  {
    id: 'visualize', name: '内嵌图表', category: 'agent-tools',
    description: 'Claude 的 visualize 工具：在对话里直接画图表、流程图、可交互的小部件。',
    load: gateOnly,
  },
  {
    id: 'edge', name: '主机的 Edge', category: 'agent-tools',
    description: '让 Claude 操作这台电脑上管理员已登录的 Edge（Claude in Chrome 扩展）：后台、邮箱这类要登录态的网站。',
    available: () => CLAUDE_IN_CHROME,
    load: gateOnly,
  },
];
