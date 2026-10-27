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
//   运行环境   ctx.chat.{ run, reset, sessionOf, configure }   以授权账号跑一轮无人值守的 Claude（plugins/chat.mjs）
//              ctx.files.{ put, root } / ctx.share.space     往授权账号的工作区放文件 / 做公开只读链接
//              ctx.process.{ spawn, get, list }              托管子进程：按进程树收尸、退避重启、日志（plugins/process.mjs）
//              ctx.webhook(name, handler, { verify })        入站回调 /hook/<id>/<name>，必须声明校验（plugins/webhook.mjs）
//   显示位     ctx.status(fn) / ctx.action(spec) / ctx.configOptions(field, fn) / ctx.bus.toPage / ctx.store（plugins/panel.mjs）
// 撤销都不用自己写：停用 / 改配置 / 重新加载时内核按相反顺序把这些全部撤掉。

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { kernel } from './state.mjs';
import { DATA_ROOT, PROGRAM_ROOT } from '../runtime/paths.mjs';
import { requireCtx, contextFor } from '../runtime/identity.mjs';
import { ticketOf, resolveTicket } from './tickets.mjs';
import { can } from '../runtime/principal.mjs';
import { readBody } from '../runtime/body.mjs';
import { busPublish, busPublishAll } from '../runtime/bus.mjs';
import { defineOp, defineGroup, removeOp, removeGroup } from '../agent-api/registry.mjs';
import { addManualDir } from '../agent-api/manual.mjs';
import { CLAUDE_SLOT } from './claude-tools.mjs';
import { makeChatService, makeFilesService, makeShareService } from './chat.mjs';
import { makeProcessService } from './process.mjs';
import { makeWebhookService } from './webhook.mjs';
import { makePanelMixins, makeStore } from './panel.mjs';
import { setInternalRouter } from '../agent-api/internal.mjs';

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
      // 要求服务器主机（管理员）；失败已回 401 / 403，返回 null
      admin: (req, res) => {
        const t = byTicket(req, res);
        const c = t !== undefined ? t : requireCtx(auth().identify, req, res);
        if (!c) return null;
        if (!can(c, 'server.manage')) { sendText(res, 403, 'forbidden'); return null; }
        return c;
      },
    };
  });

  kernel.mixin('claude', (ctx) => ({
    // 给 Claude 加一个工具。spec：{ name, description, params, handler(args, turn), access?, who?, when?(turn) }
    //   params 写法同 agent 接口操作：{ 参数名: { type, required?, desc?, enum?, min?, max?, default? } }
    //   access 'read'（只读：免审批）| 'write'（缺省：按会话的权限模式审批）| 'danger'
    //   who    'host'（缺省：只给服务器主机本人的会话）| 'members'（成员的会话也给）
    tool: (spec) => ctx.contribute(CLAUDE_SLOT, { kind: 'tool', spec, order: spec.order ?? 0 }),
    // 加一段系统提示（字符串或 (turn) => 字符串；返回空串就不加）
    prompt: (text, opts = {}) => ctx.contribute(CLAUDE_SLOT, { kind: 'prompt', text, who: opts.who || 'host', order: opts.order ?? 0 }),
    // 挂一个现成的 MCP server（stdio / http / SDK 实例都行）：make(turn) 返回 server 配置，返回 null 本轮不挂
    mcp: (name, make, opts = {}) => ctx.contribute(CLAUDE_SLOT, { kind: 'mcp', name, make, who: opts.who || 'host', order: opts.order ?? 0 }),
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
  kernel.mixin('share', (ctx) => makeShareService(ctx));
  kernel.mixin('process', (ctx) => makeProcessService(ctx));
  kernel.mixin('webhook', (ctx) => makeWebhookService(ctx, sendJson));

  // ── 显示位 ──（状态块里要并进子进程与回调，所以排在它们后面）
  kernel.mixin('_panel', (ctx) => makePanelMixins(ctx, { processes: () => ctx.process.list(), hooks: () => ctx.webhook.list() }));
  kernel.mixin('status', (ctx) => ctx._panel.status);
  kernel.mixin('action', (ctx) => ctx._panel.action);
  kernel.mixin('configOptions', (ctx) => ctx._panel.configOptions);
  kernel.mixin('bus', (ctx) => ({ publish: busPublish, publishAll: busPublishAll, toPage: ctx._panel.toPage }));
  kernel.mixin('store', (ctx) => makeStore(ctx));   // 第一次读写才碰磁盘
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
  await register(kernel);
  const list = await kernel.start();
  const on = list.filter((p) => p.active).map((p) => p.id);
  const bad = list.filter((p) => p.status === 'error');
  console.log('[plugins] 已启用 ' + on.length + ' 个：' + on.join(', '));
  const off = list.filter((p) => !p.active && p.status !== 'error').map((p) => p.id + (p.status === 'blocked' ? '(缺依赖)' : ''));
  if (off.length) console.log('[plugins] 关着：' + off.join(', '));
  for (const p of bad) console.error('[plugins] ' + p.id + ' 出错：' + p.error);
  return list;
}

export { installMixins };
