// Vertex 功能扩展入口：Gemini 分页（对话）+ 媒体生成（图像 / 视频 / 语音 / 音乐）+ 给 Claude 的媒体工具。
// 钩子约定见核心 src/modules/registry.mjs 顶部。

import { registerVertexHistoryRoutes } from './routes/vertex.mjs';
import { registerMediaRoutes } from './routes/media.mjs';
import { registerCredentialRoutes } from './routes/credentials.mjs';
import { registerSettingsRoutes } from './routes/settings.mjs';
import { getVertexSettings, agentMediaDeny } from '@bridge/core/runtime/vertex-settings.mjs';
import { runVertexChat } from './agents/vertex.mjs';
import { makeMediaMcp } from './mcp/media-phone.mjs';
import { mediaNudgeFor } from './claude-nudge.mjs';
import * as vertexHist from './vertex-history.mjs';
import { agentEnabled } from '@bridge/core/runtime/agent-status.mjs';
import { memberRules } from '@bridge/core/runtime/quota.mjs';
import { VERTEX_PROJECT, VERTEX_LOCATION } from '@bridge/core/config/index.mjs';
import {
  VERTEX_MODELS, VERTEX_MODEL_DEFAULT, VERTEX_THINK_LEVELS, VERTEX_THINK_DEFAULT, VERTEX_MEDIA_RES, VERTEX_SYSTEM_MAX,
} from '@bridge/core/config/capabilities.mjs';

export { runVertexChat };
export const listConversations = vertexHist.listConversations;
export const loadConversation = vertexHist.loadConversation;

// 纯 HTTP API，没有本地二进制要找；凭据配没配由 agent-status 的认证探测提示。
export function runnable() { return true; }

export function register(router, { authOk, identify }) {
  registerVertexHistoryRoutes(router, { authOk, identify });   // /api/vertex/sessions, /api/vertex/session, /api/vertex/session/delete
  registerMediaRoutes(router, { authOk, identify });           // /api/vertex/{video,image,tts,music,videos,images,audios,musics, *_delete}、本机生图
  registerCredentialRoutes(router, { identify });             // /api/vertex/credentials（管理员）：上传凭据、项目与区域、API Key、测试连接
  registerSettingsRoutes(router, { identify });               // /api/vertex/settings（管理员）：别的 agent 能不能生成、能生成什么、内容安全过滤
}

// 预热 Gemini（仅生产常驻服务）：开机就加载 @google/genai + 建 client + 取 ADC token，
// 消除首条消息的冷启动延迟；每 30 分钟保活一次让 token 不过期（单用户 bridge，开销可忽略）。
// Gemini 关着、或根本没配 Vertex 项目时不预热（每次保活时现查开关，设置里关掉后即停）。
export function startup({ production }) {
  if (!production || !VERTEX_PROJECT) return;
  (async () => {
    try {
      const vertex = await import('./vertex.mjs');
      const warm = () => { if (agentEnabled('gemini')) vertex.warmup({ project: VERTEX_PROJECT, location: VERTEX_LOCATION, model: VERTEX_MODEL_DEFAULT }).catch(() => {}); };
      warm();
      setInterval(warm, 30 * 60 * 1000).unref?.();
    } catch {}
  })();
}

// POST /api/chat agent:'vertex'。入参夹紧在这里做（原在 routes/chat.mjs），驱动只见已校验的值。
export const chat = {
  vertex: (req, res, { parsed, message, sessionId, ctx, attachments }) => {
    const files = attachments();
    if (!message && !files.length) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('empty message'); return; }
    const vertexModel = VERTEX_MODELS.has(parsed.vertexModel) ? parsed.vertexModel : VERTEX_MODEL_DEFAULT;
    const vertexSearch = parsed.vertexSearch === true;
    const vertexFastVision = parsed.vertexFastVision !== false; // 快速识图：图片降采样提速，默认开
    const vertexThink = VERTEX_THINK_LEVELS.has(parsed.vertexThink) ? parsed.vertexThink : VERTEX_THINK_DEFAULT;
    // 对话的系统提示词 / URL 上下文 / 代码执行 / 识图清晰度（老 apk 不带 → 全部维持旧行为）
    const vertexOpts = {
      system: typeof parsed.vertexSystem === 'string' ? parsed.vertexSystem.trim().slice(0, VERTEX_SYSTEM_MAX) : '',
      url: parsed.vertexUrl === true,
      code: parsed.vertexCode === true,
      mediaRes: VERTEX_MEDIA_RES.has(parsed.vertexMediaRes) ? parsed.vertexMediaRes : 'auto',
    };
    return runVertexChat(req, res, { message, sessionId, vertexModel, vertexSearch, vertexThink, vertexFastVision, vertexOpts, attachments: files, ctx });
  },
};

// 给 Claude（主聊天与定时任务同口径）：Gemini 开着才给媒体工具与对应提示。
// 沙箱用户的产物落自己的 .bridge/media、gen_media 推到自己的轮；admin 落主机 media。
// 成员的媒体生成没开放（控制台「额度与注册」，核心 runtime/quota.mjs memberRules）就整个不给；开着的每次调用再过额度闸。
// 管理员在 设置 › Agent › Gemini 关掉「Claude」或某种媒体，对应工具与提示就不给（runtime/vertex-settings.mjs）。
const mediaOn = (ctx) => { const r = memberRules(ctx); return r.media || r.video; };
const CLAUDE_KINDS = ['image', 'video', 'speech', 'music'];
const claudeKinds = () => CLAUDE_KINDS.filter((k) => !agentMediaDeny('claude', k));
export const claude = {
  nudge: (ctx) => {
    if (!ctx || !ctx.allowGemini || !mediaOn(ctx)) return '';
    const v = getVertexSettings();
    return mediaNudgeFor({ proactive: v.claudeProactive, kinds: claudeKinds(), videoCap: v.agentVideoMaxRes });
  },
  mcp: (ctx, { getGen } = {}) => {
    if (!ctx || !ctx.allowGemini || !mediaOn(ctx) || !claudeKinds().length) return {};
    return { media: ctx.sandbox ? makeMediaMcp({ mediaDir: ctx.media, genKey: ctx.key, getGen, ctx }) : makeMediaMcp({ getGen }) };
  },
};

// 定时任务的 Gemini 引擎：无状态 runTurn，结果落进主人的 vertex-history，在 Gemini 会话列表里能回看。
export const routines = {
  vertex: async (ctx, r) => {
    const vertex = await import('./vertex.mjs');
    const convId = vertexHist.newId();
    const out = await vertex.runTurn({
      history: [],
      message: r.prompt || '（这条路由没有写 prompt）',
      model: r.model || VERTEX_MODEL_DEFAULT,
      useSearch: !!r.search,
      thinkLevel: r.effort || VERTEX_THINK_DEFAULT,
      project: VERTEX_PROJECT, location: VERTEX_LOCATION,
      onText: () => {}, signal: new AbortController().signal,
    });
    let full = out.text || '';
    if (out.sources && out.sources.length) {
      full += '\n\n---\n**来源**\n' + out.sources.map((s, i) => `${i + 1}. [${s.title}](${s.uri})`).join('\n');
    }
    vertexHist.appendTurn(convId, r.prompt || '', full, ctx.vertexHist);
    return { sessionId: convId, text: full, isError: false };
  },
};
