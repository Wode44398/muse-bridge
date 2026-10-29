// 会话空闲（没有活着的 CLI）时专为连接器授权起的短命 Query（runtime/mcp-oauth.mjs 的 spawn）。
// 身份、连接器、插件与主聊天 / 无头一轮同源（headless-turn.mjs 同一套取法），所以令牌落进的是这个身份自己的
// CLAUDE_CONFIG_DIR，之后它的会话都能直接用。不发任何消息：输入流挂着不放，只走控制通道。
// 收尸：流程结束时 release；另有硬超时兜底（授权流程本身 10 分钟过期，这里多给 2 分钟）。
import { query } from '@anthropic-ai/claude-agent-sdk';
import { claudeCliOptions } from './claude-cli.mjs';
import { claudeEngineEnv } from './claude-account.mjs';
import { claudeExtensionsFor, sharedExtensionDirs } from '../extensions.mjs';
import { memberClaudePlugins, memberSkillRootIfAny } from '../member-skills.mjs';
import { PEER_OFF_ENV, PEER_OFF_SETTINGS } from './session-peers.mjs';
import { makeSandboxPreToolUse } from '../agents/claude.mjs';
import { UPLOADS, MEDIA } from '../config/index.mjs';
import { FLOW_TTL_MS } from './mcp-oauth.mjs';

const HARD_MS = FLOW_TTL_MS + 2 * 60_000;

export async function spawnAuthQuery(ctx) {
  const abort = new AbortController();
  let open;
  const gate = new Promise((r) => { open = r; });
  async function* input() { await gate; }   // 一条消息都不发，release 时结束
  const ext = claudeExtensionsFor(ctx);
  if (ctx.kind === 'user') ext.plugins.push(...memberClaudePlugins(ctx.user));
  const q = query({
    prompt: input(),
    options: {
      ...claudeCliOptions(),
      cwd: ctx.cwd,
      additionalDirectories: ctx.sandbox ? (ctx.kind === 'user' ? [...sharedExtensionDirs(), ...[memberSkillRootIfAny(ctx.user)].filter(Boolean)] : []) : [UPLOADS, MEDIA],
      mcpServers: { ...ext.mcpServers },
      ...(ext.plugins.length ? { plugins: ext.plugins } : {}),
      env: { ...(claudeEngineEnv(ctx) || process.env), ...PEER_OFF_ENV },
      settings: JSON.stringify({ ...PEER_OFF_SETTINGS }),
      ...(ctx.sandbox ? { hooks: { PreToolUse: [{ hooks: [makeSandboxPreToolUse(ctx)] }] }, settingSources: [] } : {}),
      permissionMode: 'default',
      abortController: abort,
      canUseTool: async () => ({ behavior: 'deny', message: '授权专用进程，不执行工具' }),
    },
  });
  // 读空消息流（控制应答走 SDK 自己的读循环，这里只是别让帧堆着）
  (async () => { try { for await (const _ of q) { /* 丢弃 */ } } catch {} })();
  let done = false;
  const release = () => {
    if (done) return;
    done = true;
    clearTimeout(killer);
    open();
    try { q.close(); } catch {}
    try { abort.abort(); } catch {}
  };
  const killer = setTimeout(() => { console.log('[mcp-oauth] auth CLI hard timeout, closing'); release(); }, HARD_MS);
  if (killer.unref) killer.unref();
  return { q, release };
}
