// bridge 接线层：给插件内核接上 bridge 自己的能力——插件上下文的便捷方法（混入）、核心服务、启动流程。
//
// 插件作者拿到的 ctx（apply(ctx, config) 的第一个参数）：
//   内核自带   ctx.id / ctx.config / ctx.log / ctx.warn / ctx.error / ctx.effect / ctx.onDispose /
//              ctx.setTimeout / ctx.setInterval / ctx.provide / ctx.service / ctx.contribute / ctx.when / ctx.on / ctx.emit
//   这里加的   ctx.route(method, path, handler)        挂一个接口（精确路径）
//              ctx.router                             整个路由器的「记账版」：on / use / prefix，停用时自动摘掉
//              ctx.http.{ json, text, body, user, admin }   回 JSON、读请求体、要求登录 / 主机管理员
//              ctx.claude.{ tool, prompt, mcp }        给 Claude 加工具、加一段系统提示、挂一个现成 MCP server
//              ctx.agentOp(spec) / ctx.agentGroup()    加 agent 接口操作（/agent/v1、手册、bridge_call 同一张表）
//              ctx.manual(dir)                        加手册章节（目录里的 .md）
//              ctx.bus.{ publish, publishAll }         往前端实时总线推事件
//              ctx.dataDir                            插件自己的数据目录（<数据根>/plugin-data/<id>/，用到时才建）
//              ctx.runtime                            { production, noAuth, port, dataRoot, programRoot }
//   运行环境   ctx.chat.{ run, history, usage, reset, sessionOf, configure }   以授权账号 / 沙箱跑一轮无人值守的 Claude（plugins/chat.mjs）
//              ctx.sandbox(key, { web })                    插件自管的隔离工作区（不用建账号），句柄能当 as 用
//              ctx.files.{ put, write, append, read, list, remove, root, path } / ctx.share.{ space, chat, chats, chatLog }
//              ctx.process.{ spawn, get, list }              托管子进程：按进程树收尸、退避重启、健康检查、日志（plugins/process.mjs）
//              ctx.webhook(name, handler, { verify })        入站回调 /hook/<id>/<name>，必须声明校验（plugins/webhook.mjs）
//              ctx.schedule(name, when, fn)                  定时任务：落盘、错过补跑、状态并进详情页（plugins/schedule.mjs）
//              ctx.notify({ title, body, level })            提醒服务器主机：界面提示 + 手机通知栏
//   显示位     ctx.status(fn) / ctx.action(spec) / ctx.configOptions(field, fn) / ctx.bus.toPage / ctx.store（plugins/panel.mjs）
//   契约       ctx.api（接口版本）/ ctx.has(能力名)（plugins/engines.mjs PLUGIN_FEATURES）；内核自带 ctx.onConfig / ctx.setConfig / ctx.meta.previousVersion
// 撤销都不用自己写：停用 / 改配置 / 重新加载时内核按相反顺序把这些全部撤掉。

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { kernel } from './state.mjs';
import { DATA_ROOT, PROGRAM_ROOT } from '../runtime/paths.mjs';
import { requireCtx, contextFor } from '../runtime/identity.mjs';
import { ticketOf, resolveTicket } from './tickets.mjs';
import { can, HOST_OWNER } from '../runtime/principal.mjs';
import { readBody } from '../runtime/body.mjs';
import { busPublish, busPublishAll } from '../runtime/bus.mjs';
import { defineOp, defineGroup, removeOp, removeGroup } from '../agent-api/registry.mjs';
import { addManualDir } from '../agent-api/manual.mjs';
import { CLAUDE_SLOT } from './claude-tools.mjs';
import { makeChatService, makeFilesService, makeShareService, makeSandboxFactory } from './chat.mjs';
import { makeProcessService } from './process.mjs';
import { makeWebhookService } from './webhook.mjs';
import { makePanelMixins, makeStore } from './panel.mjs';
import { makeScheduleService } from './schedule.mjs';
import { PLUGIN_API_VERSION, PLUGIN_FEATURES } from './engines.mjs';
import { notePush } from '../runtime/push-notices.mjs';
import { randomUUID } from 'node:crypto';
import { setInternalRouter } from '../agent-api/internal.mjs';
import { startMarketWatcher, setUpdatesPublisher } from './market.mjs';
import { provideModelService, addModelMiddleware, MODEL_AGENTS } from '../runtime/model-services.mjs';
import { checkTool, checkHook, checkWho } from './claude-tools.mjs';
import { subscribe, EVENT_NAMES, emitBridgeEvent } from './events.mjs';
import { makeNet } from './net.mjs';
import { makeOAuth } from './oauth.mjs';
import { registerAgentMcpRoute } from './agent-mcp.mjs';
import { addChannel } from './channels.mjs';
import { addAuthProvider } from './auth-providers.mjs';
import { makeUi, watchUi } from './ui.mjs';

export { kernel };
export const PLUGIN_DATA_ROOT = path.join(DATA_ROOT, 'plugin-data');

const sendJson = (res, status, obj) => {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const sendText = (res, status, s) => {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(String(s));
};

// 随程序发布的代码（内置功能、agent 扩展）不受第三方插件的那几条限制。
const isBuiltin = (ctx) => ctx.meta.source === 'builtin' || ctx.meta.source === 'module';

// 路由器的记账版：经它挂的路由 / 中间件都记在这个插件名下。order = 中间件默认次序（见 runtime/router.mjs）。
// 路由器用到时才取（建上下文时还不一定有，比如单测里没起服务）。
function trackedRouter(ctx, order = 0) {
  const r = () => kernel.service('router');
  return {
    on: (method, p, handler) => {
      // 第三方插件不许顶掉已有的接口（内置功能之间本就各管各的路径）
      if (!isBuiltin(ctx)) for (const m of Array.isArray(method) ? method : [method]) {
        if (r().has(m, p)) throw new Error(`接口 ${m} ${p} 已被占用`);
      }
      return ctx.effect(() => r().on(method, p, handler));
    },
    use: (fn, opts = {}) => ctx.effect(() => r().use(fn, { order: opts.order ?? order })),
    prefix: (method, p, handler) => ctx.effect(() => r().prefix(method, p, handler)),
    has: (m, p) => r().has(m, p),
  };
}

let mixinsInstalled = false;
function installMixins() {
  if (mixinsInstalled) return;
  mixinsInstalled = true;

  kernel.mixin('router', (ctx) => trackedRouter(ctx));
  kernel.mixin('routerAt', (ctx) => (order) => trackedRouter(ctx, order));
  kernel.mixin('route', (ctx) => (method, p, handler) => trackedRouter(ctx).on(method, p, handler));

  kernel.mixin('http', (ctx) => {
    const auth = () => kernel.service('auth');
    // 插件页面的票据（plugins/tickets.mjs）：只在本插件自己的 /api/plugin/<id>/ 下认，插件停用就失效
    const byTicket = (req, res) => {
      const tok = ticketOf(req);
      if (!tok) return undefined;
      let p = '';
      try { p = new URL(req.url, 'http://x').pathname; } catch {}
      const id = p.startsWith('/api/plugin/' + ctx.id + '/') && kernel.isActive(ctx.id) ? resolveTicket(tok, ctx.id) : null;
      if (!id) { sendText(res, 401, 'plugin ticket expired'); return null; }
      return contextFor(id);
    };
    return {
      json: sendJson,
      text: sendText,
      // 读 JSON 请求体；坏了 / 太大抛错（handler 里 try 一下回 400 即可）
      async body(req, maxBytes = 1_000_000) {
        const raw = await readBody(req, maxBytes);
        if (!raw) return {};
        try { return JSON.parse(raw); } catch { throw new Error('请求体不是合法 JSON'); }
      },
      // 要求登录（主机或成员）；失败已回 401，返回 null。插件页面带的票据也认（身份 = 开面板的人）
      user: (req, res) => {
        const t = byTicket(req, res);
        return t !== undefined ? t : requireCtx(auth().identify, req, res);
      },
      // 要求服务器主机（管理员）；失败已回 401 / 403，返回 null。host 是同一个（措辞统一成「服务器主机」，admin 保留）
      admin: (req, res) => hostOnly(req, res),
      host: (req, res) => hostOnly(req, res),
    };
    function hostOnly(req, res) {
      const t = byTicket(req, res);
      const c = t !== undefined ? t : requireCtx(auth().identify, req, res);
      if (!c) return null;
      if (!can(c, 'server.manage')) { sendText(res, 403, 'forbidden'); return null; }
      return c;
    }
  });

  // 契约：接口版本与能力探测（以后加能力只往 PLUGIN_FEATURES 里加名字，不升版本）
  kernel.mixin('api', () => PLUGIN_API_VERSION);
  kernel.mixin('has', () => (name) => PLUGIN_FEATURES.includes(String(name)));

  // 工具 / 提示的 agents：缺省只给 Claude（老写法不变）；ctx.tools.add 缺省两个都给。dimensio 经 /agent/mcp/plugins 拿到（plugins/agent-mcp.mjs）
  const agentsOf = (v, dflt) => {
    if (v == null) return dflt;
    const list = Array.isArray(v) ? v : [v];
    const bad = list.filter((a) => !MODEL_AGENTS.includes(a));
    if (bad.length) throw new Error(`agents 里的「${bad.join('、')}」不认识（可用：${MODEL_AGENTS.join(' / ')}）`);
    return list;
  };
  const addTool = (ctx, spec, dflt) => {
    checkTool(spec);
    checkWho(spec.who);
    return ctx.contribute(CLAUDE_SLOT, { kind: 'tool', spec: { ...spec, agents: agentsOf(spec.agents, dflt) }, order: spec.order ?? 0 });
  };
  kernel.mixin('claude', (ctx) => ({
    // 给 Claude 加一个工具。spec：{ name, description, params, handler(args, turn), access?, who?, when?(turn), agents?, render? }
    //   params 写法同 agent 接口操作：{ 参数名: { type, required?, desc?, enum?, min?, max?, default? } }
    //   access 'read'（只读：免审批）| 'write'（缺省：按会话的权限模式审批）| 'danger'
    //   who    'host'（缺省：只给服务器主机本人的会话）| 'members'（成员的会话也给）| 'all'（再加插件沙箱）
    //   agents ['claude']（缺省）| ['claude', 'dimensio']（dimensio 也给）
    tool: (spec) => addTool(ctx, spec, ['claude']),
    // 加一段系统提示（字符串或 (turn) => 字符串；返回空串就不加）。opts.agents 同上（dimensio 那边是插件工具服务的说明）
    prompt: (text, opts = {}) => { checkWho(opts.who); return ctx.contribute(CLAUDE_SLOT, { kind: 'prompt', text, who: opts.who || 'host', agents: agentsOf(opts.agents, ['claude']), order: opts.order ?? 0 }); },
    // 挂一个现成的 MCP server（stdio / http / SDK 实例都行）：make(turn) 返回 server 配置，返回 null 本轮不挂
    mcp: (name, make, opts = {}) => ctx.contribute(CLAUDE_SLOT, { kind: 'mcp', name, make, who: opts.who || 'host', order: opts.order ?? 0 }),
    // ── 四期：改到 Claude 的主链路（plugins/claude-tools.mjs）──
    // 钩子：event = PreToolUse / PostToolUse / UserPromptSubmit / Stop / SubagentStart …；fn(input, turn) 回 { decision, reason, input, context, block }
    hook: (event, fn, opts = {}) => { checkHook(event, fn, opts); return ctx.contribute(CLAUDE_SLOT, { kind: 'hook', event, fn, matcher: opts.matcher || '', who: opts.who || 'host', timeout: opts.timeout }); },
    // 审批策略：fn({ tool, input, mode, agentID, sessionId }, turn) 回 'allow' / 'deny' / { allow, input } / { deny, message } / 不表态
    permission: (fn, opts = {}) => { if (typeof fn !== 'function') throw new Error('ctx.claude.permission 要一个函数'); checkWho(opts.who); return ctx.contribute(CLAUDE_SLOT, { kind: 'permission', fn, who: opts.who || 'host', timeout: opts.timeout }); },
    // 消息改写：fn({ message, attachments }, turn) 回 { message?, prepend?, append?, attachments? }
    input: (fn, opts = {}) => { if (typeof fn !== 'function') throw new Error('ctx.claude.input 要一个函数'); checkWho(opts.who); return ctx.contribute(CLAUDE_SLOT, { kind: 'input', fn, who: opts.who || 'host', timeout: opts.timeout }); },
    // 每轮参数：fn(turn) 回 { model?, effort?, env?, settings?, agents?, additionalDirectories?, append? }
    options: (fn, opts = {}) => { if (typeof fn !== 'function') throw new Error('ctx.claude.options 要一个函数'); checkWho(opts.who); return ctx.contribute(CLAUDE_SLOT, { kind: 'options', fn, who: opts.who || 'host', timeout: opts.timeout }); },
  }));
  // 两个 agent 都给的工具（写法同 ctx.claude.tool，agents 缺省 ['claude', 'dimensio']）
  kernel.mixin('tools', (ctx) => ({ add: (spec) => addTool(ctx, spec, [...MODEL_AGENTS]) }));

  // 订阅 bridge 事件（plugins/events.mjs）
  kernel.mixin('events', (ctx) => ({ on: (name, fn) => subscribe(ctx, name, fn), names: () => [...EVENT_NAMES] }));
  // 网络：当前出站代理、代理变化、带时限的 fetch（plugins/net.mjs）；OAuth 授权助手（plugins/oauth.mjs）
  kernel.mixin('net', (ctx) => makeNet(ctx));
  kernel.mixin('oauth', (ctx) => makeOAuth(ctx));

  // 给 agent 提供模型服务（runtime/model-services.mjs）：provide(spec) 按 spec.agents 注进 Claude / dimensio 的模型列表，停用时撤掉；
  // agents() 列出这台 bridge 上能接的 agent（dimensio 扩展关着时 available=false），插件拿它做「哪些 agent 能用」的勾选项
  kernel.mixin('models', (ctx) => ({
    provide: (spec) => {
      const h = provideModelService(ctx.id, ctx.meta.name || ctx.id, spec);
      ctx.onDispose(() => h.dispose());
      return h;
    },
    agents: () => MODEL_AGENTS.map((id) => ({
      id, label: id === 'claude' ? 'Claude' : 'dimensio',
      available: id === 'claude' || kernel.isActive(id),
    })),
    // 模型请求中间件：fn({ provider, model, owner, body }) 回新的请求体（或不回 = 不改）。only: 'own'（只管自己提供的服务）| 'all'（缺省）
    middleware: (fn, opts = {}) => {
      if (typeof fn !== 'function') throw new Error('ctx.models.middleware 要一个函数');
      return ctx.onDispose(addModelMiddleware(ctx.id, fn, { only: opts.only === 'own' ? 'own' : 'all', timeout: opts.timeout, warn: (m) => ctx.warn(m) }));
    },
  }));

  kernel.mixin('agentGroup', (ctx) => (id, title, desc = '') => {
    defineGroup(id, title, desc);
    return ctx.onDispose(() => removeGroup(id));
  });
  kernel.mixin('agentOp', (ctx) => (spec) => {
    const gid = ctx.id.replace(/-/g, '_');
    const name = String(spec.name || '').includes('.') ? spec.name : gid + '.' + spec.name;
    // 第三方插件的操作一律落在自己 id 的组里，免得和核心操作抢名字
    if (!isBuiltin(ctx) && !name.startsWith(gid + '.')) throw new Error(`操作名要以「${gid}.」开头：${name}`);
    const op = defineOp({ ...spec, name, need: [...(spec.need || []), 'plugin:' + ctx.id] });
    ctx.onDispose(() => removeOp(op));
    return op;
  });
  kernel.mixin('manual', (ctx) => (dir) => ctx.effect(() => addManualDir(path.resolve(ctx.meta.dir || PROGRAM_ROOT, dir), ctx.id)));


  kernel.mixin('runtime', () => (kernel.hasService('runtime') ? kernel.service('runtime') : {}));

  // 插件自己的数据目录。第三方插件启用时建好；内置功能有各自的老位置，只给路径不建目录。
  kernel.mixin('dataDir', (ctx) => {
    const dir = path.join(PLUGIN_DATA_ROOT, ctx.id);
    if (!isBuiltin(ctx)) { try { mkdirSync(dir, { recursive: true }); } catch {} }
    return dir;
  });

  // ── 运行环境 ──（工厂只建闭包，用到时才干活：每个插件上下文都会跑一遍）
  kernel.mixin('chat', (ctx) => makeChatService(ctx));
  kernel.mixin('files', (ctx) => makeFilesService(ctx));
  kernel.mixin('sandbox', (ctx) => makeSandboxFactory(ctx));
  kernel.mixin('share', (ctx) => makeShareService(ctx));
  kernel.mixin('process', (ctx) => makeProcessService(ctx));
  kernel.mixin('webhook', (ctx) => makeWebhookService(ctx, sendJson));
  kernel.mixin('_schedule', (ctx) => makeScheduleService(ctx));
  kernel.mixin('schedule', (ctx) => ctx._schedule.schedule);
  // ctx.notify(...) 发提醒；ctx.notify.channel({ id, label, send }) 登记通知渠道（plugins/channels.mjs，四期）
  kernel.mixin('notify', (ctx) => Object.assign(makeNotify(ctx), { channel: (spec) => addChannel(ctx, spec) }));
  // 外部登录（plugins/auth-providers.mjs，四期）
  kernel.mixin('auth', (ctx) => ({ provider: (spec) => addAuthProvider(ctx, spec) }));
  // 界面扩展（plugins/ui.mjs，四期）：主页卡片、工作台标签、「/」命令、＋菜单、消息 / 会话菜单、主题变量
  kernel.mixin('ui', (ctx) => makeUi(ctx));

  // ── 显示位 ──（状态块里要并进子进程、回调与定时任务，所以排在它们后面）
  kernel.mixin('_panel', (ctx) => makePanelMixins(ctx, { processes: () => ctx.process.list(), hooks: () => ctx.webhook.list(), schedules: () => ctx._schedule.list() }));
  kernel.mixin('status', (ctx) => ctx._panel.status);
  kernel.mixin('action', (ctx) => ctx._panel.action);
  kernel.mixin('configOptions', (ctx) => ctx._panel.configOptions);
  kernel.mixin('bus', (ctx) => ({ publish: busPublish, publishAll: busPublishAll, toPage: ctx._panel.toPage }));
  kernel.mixin('store', (ctx) => makeStore(ctx));   // 第一次读写才碰磁盘
}

// ctx.notify({ title, body?, level? })：提醒服务器主机——在线界面弹提示 + 手机 App 通知栏（push-notices，App 后台轮询）。
// 同一条（标题 + 正文）10 分钟内只发一次，免得插件出故障时刷屏。也记进插件日志。返回 { sent }。
function makeNotify(ctx) {
  const recent = new Map();   // 内容 → 时间
  return ({ title, body = '', level = 'info' } = {}) => {
    const t = String(title || '').trim().slice(0, 80);
    if (!t) throw new Error('ctx.notify 要 title');
    const b = String(body || '').trim().slice(0, 200);
    const k = t + '\n' + b;
    const now = Date.now();
    if (now - (recent.get(k) || 0) < 10 * 60_000) return { sent: false, deduped: true };
    recent.set(k, now);
    if (recent.size > 200) recent.delete(recent.keys().next().value);
    const text = `${ctx.meta.name || ctx.id}：${t}${b ? ' — ' + b : ''}`;
    (level === 'error' ? ctx.error : level === 'warn' ? ctx.warn : ctx.log)('通知：' + t + (b ? ' — ' + b : ''));
    try { notePush(HOST_OWNER, { sessionId: null, message: text, title: `${ctx.meta.name || ctx.id}：${t}`, level }); } catch {}
    try { busPublish(HOST_OWNER, { type: 'ui.cmd', id: randomUUID(), at: now, op: 'toast', text }); } catch {}
    return { sent: true };
  };
}

/**
 * 启动插件系统（server.mjs 调）：
 *   1. 核心服务：router、auth、runtime、httpServer（server.mjs 先 provide）
 *   2. 登记：内置目录 + agent 扩展 + 装好的 / 登记的第三方插件（discover.mjs）
 *   3. 按存着的开关启用
 */
export async function bootPlugins({ register }) {
  installMixins();
  // ctx.share 等经进程内请求调现有路由；agent 接口插件关着时也得有路由器可用
  if (kernel.hasService('router')) setInternalRouter(kernel.service('router'));
  // 插件工具给 dimensio 的 MCP 端点（plugins/agent-mcp.mjs）：核心路由，插件开关不影响它在不在
  if (kernel.hasService('router')) registerAgentMcpRoute(kernel.service('router'));
  await register(kernel);
  const list = await kernel.start();
  // 插件订阅的 plugin.state（plugins/events.mjs）：每次对账后比一遍谁开了谁关了
  watchUi();   // 界面扩展的登记变了就推 plugins.ui 给在线页面
  const lastActive = new Map(list.map((p) => [p.id, !!p.active]));
  kernel.on('change', () => {
    for (const p of kernel.list()) {
      const was = lastActive.get(p.id) || false;
      if (was !== !!p.active) emitBridgeEvent('plugin.state', { id: p.id, name: p.name || p.id, active: !!p.active, status: p.status, error: p.error || '' });
      lastActive.set(p.id, !!p.active);
    }
  });
  const on = list.filter((p) => p.active).map((p) => p.id);
  const bad = list.filter((p) => p.status === 'error');
  console.log('[plugins] 已启用 ' + on.length + ' 个：' + on.join(', '));
  const off = list.filter((p) => !p.active && p.status !== 'error').map((p) => p.id + (p.status === 'blocked' ? '(缺依赖)' : ''));
  if (off.length) console.log('[plugins] 关着：' + off.join(', '));
  for (const p of bad) console.error('[plugins] ' + p.id + ' 出错：' + p.error);
  // 插件市场：「有更新」名单一变就推给主机（设置里的角标据此刷新）；正式实例定时查更新（只提示，不自动装）
  setUpdatesPublisher((ids) => busPublish(HOST_OWNER, { type: 'plugins.market', updates: ids }));
  if (kernel.hasService('runtime') && kernel.service('runtime').production) startMarketWatcher(kernel);
  return list;
}

export { installMixins };
