// Antigravity 会话级 Bridge MCP 注入配置：仅向 Bridge 拉起的 ACP 会话按需注入，不改写用户全局 mcp_config.json。

import { fileURLToPath } from 'node:url';
import { CORE_REGISTER_URL } from '@bridge/core/modules/core-resolve.mjs';
import { PORT } from '@bridge/core/config/index.mjs';
import { ensureHostSecret } from '@bridge/core/runtime/host-secret.mjs';
import { mintAgentDeviceToken } from '@bridge/core/runtime/agent-device-token.mjs';
import { pluginOn } from '@bridge/core/plugins/state.mjs';
import { DEFAULT_BRIDGE_TOOLS, buildEffectiveAgySystemPrompt } from '../settings.mjs';
import { agyExtensionParams } from '@bridge/core/extensions.mjs';
import { enabledHubGroups, hubToolingSig } from './hub.mjs';
import { pluginPromptsForAgy } from './groups/plugins.mjs';
import { agyDebugOn } from '../debug-mode.mjs';

export const AGY_BRIDGE_MCP_SERVER_PATH = fileURLToPath(new URL('./agy-bridge-server.mjs', import.meta.url));

export function effectiveBridgeToolCategories(settings = {}, { phonePluginOn = pluginOn('phone-files'), ctx = null } = {}) {
  const raw = settings?.bridgeTools && typeof settings.bridgeTools === 'object'
    ? settings.bridgeTools
    : DEFAULT_BRIDGE_TOOLS;
  if (raw.enabled === false) return [];

  const categories = [];
  if (raw.media !== false) categories.push('media');
  if (raw.ui !== false) categories.push('ui');
  if (raw.phoneFiles !== false && phonePluginOn) categories.push('phone');
  // hub = 服务端工具中枢（浏览器 / 终端 / 工作区 / bridge 操作 / 设备 / 图表，见 hub.mjs）；具体给哪几组由服务端按设置现算
  if (ctx && enabledHubGroups(ctx, settings).length) categories.push('hub');
  return categories;
}

export function buildAgyBridgeMcpServers({
  ctx,
  settings = {},
  phonePluginOn = pluginOn('phone-files'),
} = {}) {
  // 工具服务回调 bridge 时出示的凭据决定它是谁：管理员的会话给主机密钥；注册成员的会话给他自己的按人令牌
  //（绑死账号，只能当他本人——工具落盘、媒体、额度都记在他名下；主机密钥绝不进成员的进程）。
  if (!ctx) return [];
  const member = ctx.kind === 'user';
  if (ctx.kind !== 'admin' && !(member && ctx.allowAgy && ctx.user)) return [];
  const categories = effectiveBridgeToolCategories(settings, { phonePluginOn, ctx });
  if (!categories.length) return [];

  let secret = '';
  try { secret = member ? mintAgentDeviceToken(ctx.user, 'agy') : ensureHostSecret(); } catch {}
  if (!secret) return [];

  // agy 按「服务名 + 配置」池化复用 stdio MCP 子进程：配置（含环境变量）一变就另起一个，并把后来那份的工具改名成
  // mcp_bridge_<8 位哈希>_<工具>（11-19 探针实测）。所以环境变量里只放不随会话、不随设置变的两样；
  // 开了哪几类工具不再写进来，由子进程在 tools/list 时向服务端现取（/api/agy/internal/hub/tools）。
  // 会话归属同理不靠环境变量：agy 每次工具调用自带会话 id，服务端内部回调据此认领。
  const env = [
    { name: 'BRIDGE_API_URL', value: `http://127.0.0.1:${PORT}` },
    { name: 'BRIDGE_HOST_SECRET', value: secret },
  ];

  return [
    {
      name: 'bridge',
      command: process.execPath,
      args: ['--import', CORE_REGISTER_URL, AGY_BRIDGE_MCP_SERVER_PATH],
      env,
    },
  ];
}

// 一个 agy 会话挂载时要带的工具与系统提示：Bridge 工具服务 + 扩展中心（stdio 连接器、技能渐进披露）。
// 新会话（agents/agy.mjs）、续接挂载（routes/agy.mjs）、载入回放（sessions.mjs）三处共用，口径不许漂。
export function buildAgySessionTooling({ ctx, settings = {}, cwd = '', additionalDirectories = [] } = {}) {
  const bridge = buildAgyBridgeMcpServers({ ctx, settings });
  const hubGroups = bridge.length && ctx ? enabledHubGroups(ctx, settings).map((g) => g.key) : [];
  // 工具指纹：这份设置 / 插件 / 设备状态下 bridge 服务会列出哪些工具。agy 只在子进程启动时取一次 tools/list，
  // 指纹变了（设置页开关、扩展中心开关插件、登记了第一台设备……）就得让常驻进程重启一次才看得到新清单——
  // ACP 客户端在挂载会话时比对它（client.mjs noteTooling）。插件工具、远程连接器这类清单会随插件 / 扩展中心变的组另带自己的指纹。
  const baseSig = bridge.length
    ? `${effectiveBridgeToolCategories(settings, { ctx }).filter((c) => c !== 'hub').join(',')}|${hubGroups.join(',')}|${hubToolingSig(ctx, settings)}`
    : 'off';
  // 调试模式也并进指纹：系统提示只在挂载会话时带给 agy，已挂着的会话要等常驻进程换过一次才重新挂载、拿到新提示。
  // 没挂 bridge 工具时也得带上（'off' 会被 noteTooling 当成「谈不上新旧」直接跳过）
  const debug = agyDebugOn(ctx, settings);
  const toolingSig = debug ? `${baseSig}|debug` : baseSig;
  let ext = { instructions: '', mcpServers: [] };
  // 扩展中心只给主机管理员（agy 本身也只开给管理员）
  if (ctx && ctx.kind === 'admin' && !ctx.sandbox) {
    try { ext = agyExtensionParams(); } catch (e) { console.error('[agy] 读取扩展中心失败：', e?.message || e); }
  }
  const mcpServers = [...bridge, ...ext.mcpServers.filter((s) => s.name !== 'bridge')];
  const systemPromptAppend = buildEffectiveAgySystemPrompt(settings, {
    hasBridgeTools: bridge.length > 0,
    localCategories: bridge.length ? effectiveBridgeToolCategories(settings, { ctx }).filter((c) => c !== 'hub') : [],
    hubGroups,
    extensionInstructions: [ext.instructions, hubGroups.includes('plugins') ? pluginPromptsForAgy(ctx) : ''].filter(Boolean).join('\n'),
    cwd,
    additionalDirectories,
    debug,
  });
  return { mcpServers, systemPromptAppend, hubGroups, toolingSig };
}
