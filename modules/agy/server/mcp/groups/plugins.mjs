// 工具中枢 · 插件工具：插件经 ctx.tools.add / ctx.claude.tool 声明给 agy（spec.agents 含 'agy'）的工具，并进 bridge 工具服务。
//
// 对外名 plugin_<插件>_<工具>（agy 的工具名只认小写字母、数字、下划线，连字符换成下划线），撞名的后来者不列。
// access:'read' 的免审批（登记进 auto-allow.mjs，approval.mjs 按名字查），其余照常问。
// 工具结果的卡片段（CARD_MARK + JSON，Claude 页拿它画卡）agy 前端不认，只给模型文字。
// 插件开关 / 重载 / 改工具会改这一组的指纹（sig），agy 常驻进程空闲时重启、重新取清单。

import { createHash } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { kernel } from '@bridge/core/plugins/state.mjs';
import { agentContributions, shapeOf, withDefaults, toResult, CARD_MARK } from '@bridge/core/plugins/claude-tools.mjs';
import { setReadOnlyTools } from '../auto-allow.mjs';

const PREFIX = 'plugin_';
const nameOf = (owner, name) => (PREFIX + `${owner}_${name}`.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/_+/g, '_')).slice(0, 60).replace(/_+$/, '');

const turnOf = (ctx, gen) => ({ kind: 'chat', agent: 'agy', ctx, snap: null, sessionId: gen?.sessionId || null, cwd: gen?.cwd || '', getGen: () => gen || null });

function entries(ctx, gen) {
  const { tools } = agentContributions('agy', turnOf(ctx, gen));
  const seen = new Set();
  const out = [];
  for (const { owner, spec } of tools) {
    const name = nameOf(owner, spec.name);
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, owner, spec });
  }
  return out;
}

/**
 * 插件写给 agy 的系统提示段（ctx.claude.prompt 带 agents 含 'agy'）。cwd / sessionId = 要挂载的那个会话（提示函数的 turn 里能拿到）。
 * 与「有没有插件工具」无关：只要有插件给 agy 的提示就拼。系统提示只在挂载会话时带给 agy，已挂着的会话拿不到新提示，
 * 要等常驻进程换过一次（见 pluginPromptSig）。
 */
export function pluginPromptsForAgy(ctx, { cwd = '', sessionId = null } = {}) {
  const turn = { kind: 'chat', agent: 'agy', ctx, snap: null, sessionId: sessionId || null, cwd: cwd || '', getGen: () => null };
  try { return agentContributions('agy', turn).prompts.join('\n\n').slice(0, 8000); } catch { return ''; }
}

/**
 * 插件提示的指纹（并进 agy 的工具指纹 toolingSig）：插件提示变了，常驻进程空闲时重启，已挂的会话重新挂载时拿到新提示。
 * 按「不带会话目录」那一份算——带上 cwd 的话，在不同目录的会话之间来回切就会每次都让常驻进程重启。
 * 所以随 cwd 变的那部分只对新挂载的会话生效；没有插件给 agy 提示时回 ''。
 */
export function pluginPromptSig(ctx) {
  const text = pluginPromptsForAgy(ctx);
  return text ? createHash('sha1').update(text).digest('hex').slice(0, 12) : '';
}

export function makeAgyPluginsMcp({ ctx, getGen }) {
  const gen = getGen && getGen();
  const list = entries(ctx, gen);
  setReadOnlyTools('plugins', list.filter((x) => x.spec.access === 'read').map((x) => x.name));
  const server = new McpServer({ name: 'agy-plugins', version: '1.0.0' }, { capabilities: { tools: {} } });
  for (const { name, owner, spec } of list) {
    server.registerTool(name, {
      title: `${owner} · ${spec.name}`,
      description: `[插件 ${owner}] ${spec.description || spec.name}`,
      inputSchema: shapeOf(spec.params),
      annotations: { readOnlyHint: spec.access === 'read', destructiveHint: spec.access === 'danger' },
    }, async (args) => {
      try {
        const r = toResult(await spec.handler(withDefaults(spec.params, args), turnOf(ctx, getGen && getGen())));
        return { ...r, content: r.content.filter((c) => !(c && c.type === 'text' && typeof c.text === 'string' && c.text.startsWith(CARD_MARK))) };
      } catch (e) { return { content: [{ type: 'text', text: '出错：' + String(e?.message || e) }], isError: true }; }
    });
  }
  return { instance: server };
}

export const PLUGINS_GROUP = Object.freeze({
  key: 'plugins',
  setting: 'pluginTools',
  bare: true,
  available: (ctx) => ctx?.kind === 'admin' && kernel.started && entries(ctx, null).length > 0,
  // 哪些插件、第几次重载、给了哪些工具：变了 agy 就得重新取清单
  sig: (ctx) => {
    try {
      return entries(ctx, null).map((x) => `${x.owner}:${kernel.rawRecord(x.owner)?.rev || 0}:${x.spec.name}:${x.spec.access || 'write'}`).sort().join(',');
    } catch { return ''; }
  },
  owns: (name) => name.startsWith(PREFIX),
  build: ({ ctx, getGen }) => makeAgyPluginsMcp({ ctx, getGen }),
});
