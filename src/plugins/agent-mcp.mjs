// 插件工具给 dimensio（插件接口四期）：一个无状态的 HTTP MCP 端点 /agent/mcp/plugins。
//
// 插件登记的工具 / 提示（ctx.tools.add，或 ctx.claude.tool / prompt 带 agents 含 'dimensio'）在这里以 MCP 工具出现；
// harness 被 bridge 拉起时自带一个「bridge 插件」连接器指向这里（harness/server/extensions.ts），和扩展中心的连接器走同一套
// MCP 客户端：会话建立时拍基线、只读工具（access:'read'）免审批、其余按 dimensio 的权限档。
//
// 鉴权：同机实例凭据（agent-api/instance-auth.mjs instanceCaller：管理员实例 = 主机密钥，成员实例 = 按人铸的令牌），
// 只认本机直连。工具按身份过滤 who（host / members），和 Claude 那边同一套口径；插件沙箱、快照访客不会走到这里。
// 每个请求现建一个 McpServer（无状态），插件开关 / 重载后下一次列工具就是新的。
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { kernel } from './state.mjs';
import { CLAUDE_SLOT, audienceOk, checkTool, shapeOf, withDefaults, toResult } from './claude-tools.mjs';
import { instanceCaller } from '../agent-api/instance-auth.mjs';
import { readBody } from '../runtime/body.mjs';
import { emitBridgeEvent, ownerOf } from './events.mjs';
import { notePush } from '../runtime/push-notices.mjs';

export const AGENT_MCP_PATH = '/agent/mcp/plugins';

const bearer = (req) => { const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '')); return m ? m[1].trim() : ''; };

/** 这个身份在 dimensio 里能用的插件工具与说明：{ tools: [{ owner, spec }], prompt }。 */
export function dimensioContributions(turn) {
  const out = { tools: [], prompts: [] };
  if (!kernel.started) return out;
  for (const { item, owner } of kernel.slot(CLAUDE_SLOT).entries()) {
    try {
      if (item.kind === 'tool' && Array.isArray(item.spec.agents) && item.spec.agents.includes('dimensio')) {
        checkTool(item.spec);
        if (!audienceOk(item.spec.who || 'host', turn)) continue;
        if (typeof item.spec.when === 'function' && !item.spec.when(turn)) continue;
        out.tools.push({ owner, spec: item.spec });
      } else if (item.kind === 'prompt' && Array.isArray(item.agents) && item.agents.includes('dimensio')) {
        if (!audienceOk(item.who, turn)) continue;
        const t = typeof item.text === 'function' ? item.text(turn) : item.text;
        if (t && String(t).trim()) out.prompts.push(String(t).trim());
      }
    } catch (e) { console.error('[plugins] ' + owner + ' 给 dimensio 的贡献出错（跳过）：', e?.message || e); }
  }
  return out;
}

// MCP 工具名：<插件>__<工具>（连字符换下划线），dimensio 那边再加连接器前缀
const toolNameOf = (owner, name) => `${owner.replace(/-/g, '_')}__${name}`.slice(0, 60);

function buildServer(turn) {
  const { tools, prompts } = dimensioContributions(turn);
  const server = new McpServer(
    { name: 'bridge-plugins', version: '1.0.0' },
    { capabilities: { tools: {} }, ...(prompts.length ? { instructions: prompts.join('\n\n').slice(0, 20_000) } : {}) },
  );
  const seen = new Set();
  for (const { owner, spec } of tools) {
    const name = toolNameOf(owner, spec.name);
    if (seen.has(name)) continue;
    seen.add(name);
    server.registerTool(name, {
      title: `${owner} · ${spec.name}`,
      description: spec.description || spec.name,
      inputSchema: shapeOf(spec.params),
      annotations: { readOnlyHint: spec.access === 'read', destructiveHint: spec.access === 'danger' },
    }, async (args) => {
      try { return toResult(await spec.handler(withDefaults(spec.params, args), turn)); }
      catch (e) { return { content: [{ type: 'text', text: '出错：' + String(e?.message || e) }], isError: true }; }
    });
  }
  return server;
}

export function registerAgentMcpRoute(router) {
  const handle = async (req, res) => {
    const who = instanceCaller(req, bearer(req));
    if (!who) {
      res.writeHead(who === null ? 403 : 401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: who === null ? 'forbidden' : 'unauthorized' }));
      return;
    }
    const turn = { kind: 'chat', agent: 'dimensio', ctx: who.ctx, snap: null, sessionId: String(req.headers['x-dimensio-session'] || '') || null, instance: who.instance };
    let body;
    if (req.method === 'POST') {
      try { body = JSON.parse((await readBody(req, 4 * 1024 * 1024)) || 'null'); }
      catch { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'bad json' })); return; }
    }
    const server = buildServer(turn);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: String(e?.message || e) })); }
    }
  };
  // dimensio 回报回合（harness/server/bridge-events.ts）→ 插件订阅的 turn.start / turn.end（agent: 'dimensio'）
  const events = async (req, res) => {
    const who = instanceCaller(req, bearer(req));
    const reply = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (!who) return reply(who === null ? 403 : 401, { error: 'unauthorized' });
    let b;
    try { b = JSON.parse((await readBody(req, 64 * 1024)) || '{}'); } catch { return reply(400, { error: 'bad json' }); }
    if (!DIMENSIO_EVENTS.has(b?.event)) return reply(400, { error: 'unknown event' });
    const p = b.payload && typeof b.payload === 'object' ? b.payload : {};
    // dimensio 要提醒人（在等批准 / 回答 / 审计划、一轮做完，按它自己的通知偏好）：落到这个实例主人名下的推送
    //（手机 App 后台服务轮询的 pushes + 插件登记的通知渠道）。会话 id 是 dimensio 的，不当 Claude 会话 id 传
    if (b.event === 'notify') {
      const message = String(p.message || '').slice(0, 300);
      if (!message.trim() || !who.ctx?.key) return reply(400, { error: 'empty notice' });
      const item = notePush(who.ctx.key, { sessionId: null, message, title: String(p.title || 'dimensio').slice(0, 120), level: p.level === 'warn' ? 'warn' : 'info' });
      return reply(200, { ok: Boolean(item) });
    }
    emitBridgeEvent(b.event, { ...p, agent: 'dimensio', kind: typeof p.kind === 'string' ? p.kind : 'chat', owner: ownerOf(who.ctx) });
    reply(200, { ok: true });
  };
  return [router.on('POST', AGENT_MCP_PATH, handle), router.on('GET', AGENT_MCP_PATH, handle), router.on('DELETE', AGENT_MCP_PATH, handle),
    router.on('POST', '/agent/events', events)];
}
const DIMENSIO_EVENTS = new Set(['turn.start', 'turn.end', 'notify']);
