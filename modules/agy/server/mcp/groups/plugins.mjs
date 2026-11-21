// 工具中枢 · 插件工具：插件经 ctx.tools.add / ctx.claude.tool 声明给 agy（spec.agents 含 'agy'）的工具，并进 bridge 工具服务。
//
// 对外名 plugin_<插件>_<工具>（agy 的工具名只认小写字母、数字、下划线，连字符换成下划线），撞名的后来者不列。
// access:'read' 的免审批（登记进 auto-allow.mjs，approval.mjs 按名字查），其余照常问。
// 工具结果的卡片段（CARD_MARK + JSON，Claude 页拿它画卡）agy 前端不认，只给模型文字。
// 插件开关 / 重载 / 改工具会改这一组的指纹（sig），agy 常驻进程空闲时重启、重新取清单。

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

/** 插件写给 agy 的系统提示段（ctx.claude.prompt 带 agents 含 'agy'）。 */
export function pluginPromptsForAgy(ctx) {
  try { return agentContributions('agy', turnOf(ctx, null)).prompts.join('\n\n').slice(0, 8000); } catch { return ''; }
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
