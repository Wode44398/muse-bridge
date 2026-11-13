// Media Studio 功能扩展入口（2026-11-04）：图像 / 视频 / 配音 / 音乐四个创作页的后端 + 给 Claude 的媒体工具。
// 从 Vertex 扩展拆出来（媒体驱动、Google 客户端、凭据路由、媒体 MCP 都 git mv 自 modules/vertex/server/）；
// Gemini 对话同日下线，modules/vertex 整个退役。方案：D:\Notes\bridge build\design\MediaStudio方案.md。
// 钩子约定见核心 src/modules/registry.mjs 顶部。

import { registerStudioApi } from './routes/api.mjs';
import { registerMediaRoutes } from './routes/legacy.mjs';
import { registerSettingsRoutes } from './routes/vertex-settings.mjs';
import { getStudioHostSettings, agentMediaDeny } from '@bridge/core/runtime/studio-settings.mjs';
import { makeMediaMcp } from './mcp/media-phone.mjs';
import { mediaNudgeFor } from './claude-nudge.mjs';
import { memberRules } from '@bridge/core/runtime/quota.mjs';
import { usableProviders, hostProviders, HOST_OWNER } from './providers.mjs';
import { autoImportIfEmpty, importVertex } from './migrate.mjs';
import { startSchedule } from './discovery/index.mjs';

// 纯 HTTP API；能不能用看有没有可用的服务（agent-status 的认证探测问 studioAuthed）。
export function runnable() { return true; }
/** 主机有至少一个启用的服务（agent-status 的「认证」提示）。 */
export function studioAuthed() { return usableProviders(HOST_OWNER).some((p) => p.enabled); }

export function register(router, { authOk, identify }) {
  registerStudioApi(router, { identify });                     // /api/studio/{providers,catalog,voices,jobs,assets,settings}
  registerMediaRoutes(router, { authOk, identify });           // 旧 /api/vertex/{video,image,image-chat,tts,music,…} 薄转接、本机生图部署
  registerSettingsRoutes(router, { identify });                // 旧 /api/vertex/settings（管理员）：读写同一份 Studio 设置
}

// 首次启动迁移：主机一个 Studio 服务都没有、但 Vertex 已经配好时自动导入一次（升级后零配置就能用）。
// 自动识别新模型（方案 §9.3）：启动后 2 分钟巡检一次主机的服务，之后每 12 小时（discovery/index.mjs）。
export function startup() {
  setTimeout(() => { autoImportIfEmpty().catch((e) => console.error('[studio] 首次启动导入失败：', (e && e.message) || e)); }, 1500).unref?.();
  if (process.env.BRIDGE_STUDIO_AUTOSYNC !== '0') startSchedule();
}

// 设置页的「Google 云凭据」卡存了新凭据 / 项目：已经导入过的就地刷新
export { importVertex };
/** 核心 /api/vertex/credentials（src/routes/vertex-credentials.mjs，2026-11-13 从本扩展搬回核心）保存后调：
 *  一个服务都还没有就导入一次，已从 Vertex 导入过的就地刷新项目 / 区域 / Key（幂等）。 */
export async function onVertexCredentials() {
  if (!hostProviders().length) await autoImportIfEmpty();
  else if (hostProviders().some((p) => p.importedFrom === 'vertex')) await importVertex();
}

// 模型中心 v2 的桥（方案 §3.8）：核心 src/runtime/model-hub/ 经 getModule('studio')?.hub 增删改托管的媒体服务。
// 没装 studio 扩展时 getModule 回空，模型中心的媒体去向整个不可用（契约 §5）。
export { hub } from './hub-bridge.mjs';

// 给 Claude（主聊天与定时任务同口径）：Media Studio 开着才给媒体工具与对应提示。
// 沙箱用户的产物落自己的 .bridge/media、gen_media 推到自己的轮；admin 落主机 media。
// 成员的媒体生成没开放（控制台「额度与注册」，核心 runtime/quota.mjs memberRules）就整个不给；开着的每次调用再过额度闸。
// 管理员在 设置 › Media Studio 关掉「Claude」或某种媒体，对应工具与提示就不给（runtime/studio-settings.mjs）。
const mediaOn = (ctx) => { const r = memberRules(ctx); return r.media || r.video; };
const CLAUDE_KINDS = ['image', 'video', 'speech', 'music'];
const claudeKinds = () => CLAUDE_KINDS.filter((k) => !agentMediaDeny('claude', k));
export const claude = {
  nudge: (ctx) => {
    if (!ctx || !ctx.allowStudio || !mediaOn(ctx)) return '';
    const v = getStudioHostSettings();
    return mediaNudgeFor({ proactive: v.claudeProactive, kinds: claudeKinds(), videoCap: v.agentVideoMaxRes });
  },
  mcp: (ctx, { getGen } = {}) => {
    if (!ctx || !ctx.allowStudio || !mediaOn(ctx) || !claudeKinds().length) return {};
    return { media: makeMediaMcp({ ctx, genKey: ctx.key, getGen }) };
  },
};
