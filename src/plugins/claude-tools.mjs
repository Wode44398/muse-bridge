// 插件给 Claude 的贡献：工具、系统提示段、现成 MCP server。
//
// 插件经 ctx.claude.tool / prompt / mcp 登记到扩展槽 CLAUDE_SLOT；Claude 每轮开跑（claude.mjs 主聊天、定时任务）时调
// pluginClaudeTurn(turn) 现算这一轮该挂什么：
//   · 同一个插件的工具合成一个进程内 MCP server，键名 = 插件 id（撞了内置保留名就改成 plugin-<id>），
//     模型看到的工具名是 mcp__<键名>__<工具名>；
//   · 参数写法与 agent 接口操作同一套简写，这里转成 SDK 要的 zod schema——插件作者不用碰 zod / MCP SDK；
//   · access:'read' 的工具进 allowedTools（同内嵌图表：纯读不弹审批卡）；其余照会话的权限模式审批；
//   · sig 进常驻 CLI 的签名（工具集在 CLI 起来时就定了）：插件开关 / 重载 / 改了工具后，停放的 CLI 不会被错用。
//
// turn：{ kind: 'chat' | 'routine', ctx（身份上下文）, snap, getGen?, fromPhone?, source?, message?, sessionId? }

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { kernel } from './state.mjs';

export const CLAUDE_SLOT = 'claude.tools';

// 内置 MCP 的键名（claude.mjs 与扩展中心连接器在用），插件 id 撞上就加前缀。
const RESERVED = new Set(['snapshot', 'media', 'phone', 'phoneControl', 'browser', 'terminal', 'workspace', 'bridge', 'sessions',
  'pr', 'visualize', 'device', 'edge', 'claude-in-chrome', 'antigravity']);
export const serverKeyOf = (id) => (RESERVED.has(id) ? 'plugin-' + id : id);

const TOOL_NAME = /^[A-Za-z0-9_-]{1,48}$/;

function zodOf(spec) {
  let t;
  switch (spec.type) {
    case 'string':
      if (Array.isArray(spec.enum) && spec.enum.length && spec.enum.every((e) => typeof e === 'string')) t = z.enum(spec.enum);
      else { t = z.string(); if (spec.max != null) t = t.max(spec.max); }
      break;
    case 'integer': t = z.number().int(); if (spec.min != null) t = t.min(spec.min); if (spec.max != null) t = t.max(spec.max); break;
    case 'number': t = z.number(); if (spec.min != null) t = t.min(spec.min); if (spec.max != null) t = t.max(spec.max); break;
    case 'boolean': t = z.boolean(); break;
    case 'array': t = z.array(z.any()); break;
    case 'object': t = z.record(z.string(), z.any()); break;
    default: t = z.any();
  }
  const desc = [spec.desc || '', spec.default !== undefined ? `（默认 ${JSON.stringify(spec.default)}）` : ''].join('');
  if (desc) t = t.describe(desc);
  return spec.required ? t : t.optional();
}

function shapeOf(params) {
  const shape = {};
  for (const [k, s] of Object.entries(params || {})) shape[k] = zodOf(s || {});
  return shape;
}

function withDefaults(params, args) {
  const out = { ...(args || {}) };
  for (const [k, s] of Object.entries(params || {})) if (out[k] === undefined && s && s.default !== undefined) out[k] = s.default;
  return out;
}

function toResult(v) {
  if (v && typeof v === 'object' && Array.isArray(v.content)) return v;
  const text = typeof v === 'string' ? v : v === undefined ? '完成' : JSON.stringify(v, null, 2);
  return { content: [{ type: 'text', text }] };
}

// 这一轮给不给：who 'host' = 服务器主机本人非沙箱会话；'members' = 再加登录成员；快照访客一律不给。
function audienceOk(who, turn) {
  const c = turn.ctx || {};
  if (turn.snap || c.kind === 'snap' || c.kind === 'share') return false;
  if (who === 'members') return c.kind === 'admin' || c.kind === 'user';
  return c.kind === 'admin' && !c.sandbox;
}

function check(spec) {
  if (!spec || !TOOL_NAME.test(spec.name || '')) throw new Error('工具名只能用字母、数字、下划线、连字符（≤48 字）：' + (spec && spec.name));
  if (typeof spec.handler !== 'function') throw new Error('工具 ' + spec.name + ' 缺 handler(args, turn)');
}

export function pluginClaudeTurn(turn) {
  const empty = { mcpServers: {}, prompt: '', allowedTools: [], sig: [] };
  if (!kernel.started) return empty;
  const entries = kernel.slot(CLAUDE_SLOT).entries();
  if (!entries.length) return empty;
  const byOwner = new Map();   // 插件 id → { tools: [], mcp: {} }
  const prompts = [];
  const allowed = [];
  for (const { item, owner } of entries) {
    try {
      if (item.kind === 'tool') {
        const spec = item.spec;
        check(spec);
        if (!audienceOk(spec.who || 'host', turn)) continue;
        if (typeof spec.when === 'function' && !spec.when(turn)) continue;
        if (!byOwner.has(owner)) byOwner.set(owner, { tools: [], mcp: {} });
        byOwner.get(owner).tools.push(spec);
      } else if (item.kind === 'prompt') {
        if (!audienceOk(item.who, turn)) continue;
        const t = typeof item.text === 'function' ? item.text(turn) : item.text;
        if (t && String(t).trim()) prompts.push(String(t).trim());
      } else if (item.kind === 'mcp') {
        if (!audienceOk(item.who, turn)) continue;
        const cfg = item.make(turn);
        if (cfg) {
          if (!byOwner.has(owner)) byOwner.set(owner, { tools: [], mcp: {} });
          byOwner.get(owner).mcp[item.name] = cfg;
        }
      }
    } catch (e) {
      console.error('[plugins] ' + owner + ' 给 Claude 的贡献出错（本轮跳过）：', e?.message || e);
    }
  }
  const mcpServers = {};
  const sig = [];
  for (const [owner, { tools, mcp }] of byOwner) {
    const key = serverKeyOf(owner);
    if (tools.length) {
      mcpServers[key] = createSdkMcpServer({
        name: key,
        version: '1.0.0',
        tools: tools.map((spec) => tool(spec.name, spec.description || spec.name, shapeOf(spec.params), async (args) => {
          try { return toResult(await spec.handler(withDefaults(spec.params, args), turn)); }
          catch (e) { return { content: [{ type: 'text', text: '出错：' + String(e?.message || e) }], isError: true }; }
        })),
      });
      for (const spec of tools) if (spec.access === 'read') allowed.push(`mcp__${key}__${spec.name}`);
    }
    for (const [name, cfg] of Object.entries(mcp)) mcpServers[name] = cfg;
    const rev = kernel.rawRecord(owner)?.rev || 0;
    sig.push([owner, rev, tools.map((t) => t.name + ':' + (t.access || 'write')).sort(), Object.keys(mcp).sort()]);
  }
  return {
    mcpServers,
    prompt: prompts.length ? '\n\n' + prompts.join('\n\n') : '',
    allowedTools: allowed,
    sig,
  };
}
