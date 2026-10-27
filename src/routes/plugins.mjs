// 插件管理（设置 › 扩展 › 功能扩展）：服务器主机才能用（can 'server.manage'，远程也行——同扩展中心）。
//
//   GET  /api/plugins                      全部插件：内置功能 + agent 扩展 + 第三方（状态、配置 schema、打码后的配置）
//   POST /api/plugins/toggle   {id, enabled}
//   POST /api/plugins/config   {id, config}  按 schema 校验；热插件当场重启生效
//   POST /api/plugins/reload   {id}          第三方插件重新读清单与代码（本机开发目录改完点一下）
//   POST /api/plugins/install  zip 原始字节（Content-Type: application/zip）| JSON {path}（登记本机目录）| JSON {github}（从 GitHub 装）
//   GET  /api/plugins/update?id=             从 GitHub 装的插件检查更新（比最新 Release 与清单版本）
//   POST /api/plugins/uninstall {id}         装的 → 卸载（旧版进 .trash）；本机目录 → 取消登记
//   POST /api/plugins/action   {id, action, args?}   插件详情页的动作按钮（ctx.action）
//   GET  /api/plugins/options?id=&field=     配置字段的动态选项（内置来源 claude.models / users… 或插件 ctx.configOptions）
//   GET  /api/plugins/log?id=&name=&lines=   托管子进程（ctx.process）的日志尾巴
//   GET  /plugins/<id>/web/<path>           第三方插件自带的页面（web/），插件开着才给；免登录（同 /app 静态资源）
//
// 授权账号（schema 里 type:'user' + grant:'chat' 的字段）：新选上主机本人或 pro 档账号时，config 要带 confirmGrant:true，
// 否则回 409 { needConfirm: { accounts } }，前端弹确认后重发。
//
// 改动后推总线：管理员页面刷新插件列表（plugins.changed），所有在线页面重新问 /api/auth（入口按开关显隐）。

import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kernel } from '../plugins/state.mjs';
import { installFromArchive, uninstallPlugin, linkLocal, reloadPlugin, pluginWebDir, PluginError } from '../plugins/discover.mjs';
import { requireCtx, contextFor } from '../runtime/identity.mjs';
import { mintTicket, resolveTicket, ticketOf } from '../plugins/tickets.mjs';
import { subscribePage } from '../plugins/panel.mjs';
import { identityOfCtx as identityOfContext } from '../agent-api/internal.mjs';
import { can } from '../runtime/principal.mjs';
import { readBody } from '../runtime/body.mjs';
import { busPublishAll } from '../runtime/bus.mjs';
import { ConfigError } from '../kernel/schema.mjs';
import { panelView, refreshStatuses, runAction, optionsFor } from '../plugins/panel.mjs';
import { grantFields, grantedIn, grantNeedsConfirm, accountLabel, HOST_ACCOUNT } from '../plugins/chat.mjs';
import { CAPABILITIES } from '../config/capabilities.mjs';
import { listUsers } from '../users.mjs';
import { installFromGithub, checkUpdate, sourceOf } from '../plugins/github.mjs';
import { FEATURES } from '../config/index.mjs';

const MAX_ZIP = 50 * 1024 * 1024;

const json = (res, status, obj) => {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const fail = (res, e) => {
  const status = e instanceof PluginError ? e.status : e instanceof ConfigError ? 400 : 400;
  json(res, status, { error: String(e?.message || e) });
};

// 前端要的视图：去掉内部字段；本机目录给出路径（主机自己看），其余不暴露服务器路径。
export function pluginView(p) {
  if (!p) return null;
  const { dir, extra, ...rest } = p;
  const ui = extra && extra.ui ? extra.ui : null;
  return {
    ...rest,
    ...(p.source === 'local' || p.source === 'installed' ? { dir } : {}),
    ...(extra && extra.agents ? { agents: extra.agents } : {}),
    ...(ui ? { ui } : {}),
    hasPage: !!(ui && ui.panel) || !!(p.web && p.web.page),
    ...(p.source === 'installed' && sourceOf(kernel, p.id) ? { github: sourceOf(kernel, p.id) } : {}),
    ...(p.active ? panelView(p.id) : {}),
  };
}

export function pluginsOverview() {
  const plugins = kernel.list().map(pluginView);
  return { plugins, restartPending: plugins.some((p) => p.pendingRestart) };
}

// 这次改配置新授权了哪些要确认的账号（主机本人 / pro 档）。设置页与 agent 接口 plugins.config 同一口径。
export function riskyGrants(id, nextConfig) {
  const schema = kernel.schemaOf(id);
  if (!grantFields(schema).length) return [];
  const before = grantedIn(schema, kernel.readState().plugins[id]?.config || {});
  const after = grantedIn(schema, nextConfig || {});
  return [...after].filter((a) => !before.has(a) && grantNeedsConfirm(a)).map((a) => ({ id: a, name: accountLabel(a), host: a === HOST_ACCOUNT }));
}

// 内置的选项来源（schema 里 options: '<来源>'）。grantSpec：授权字段的 spec（allowHost 时多一项「服务器主机」）。
export function builtinOptions(source, spec = {}) {
  if (source === 'claude.models') return CAPABILITIES.claude.models.map((m) => ({ value: m.id, label: m.name }));
  if (source === 'claude.efforts') return CAPABILITIES.claude.efforts.map((e) => ({ value: e.id, label: e.name }));
  if (source === 'users' || source === 'users:user' || source === 'users:service') {
    const tierName = { user: '普通档', pro: 'Pro 档' };
    const list = listUsers()
      .filter((u) => !u.disabled)
      .filter((u) => source !== 'users:user' || u.tier === 'user')
      .filter((u) => source !== 'users:service' || u.service)
      // 多用户关着时，代跑只认服务账号（plugins/chat.mjs identityFor），授权字段就别列别的
      .filter((u) => !(spec.grant === 'chat' && !FEATURES.multiUser && !u.service))
      .map((u) => ({ value: u.name, label: u.name, desc: (tierName[u.tier] || u.tier) + (u.service ? ' · 服务账号' : '') }));
    if (spec.allowHost) list.unshift({ value: HOST_ACCOUNT, label: '服务器主机', desc: '全权限' });
    return list;
  }
  return null;
}

// 找到某个字段的 spec。路径写法：'model'、'allowGroups[]'（列表的每一项）、'groups.$key'（表的键）、'groups.$value'（表的值是单个字段时）、'groups.effort'（表的值 / 子对象 / 列表项里的子字段）
function specAt(schema, field) {
  const parts = String(field || '').split('.');
  let spec = schema?.[parts[0].replace(/\[\]$/, '')];
  if (spec && parts[0].endsWith('[]')) spec = spec.items;
  for (const part of parts.slice(1)) {
    if (!spec) return null;
    const fields = spec.type === 'map' ? spec.value?.fields : spec.type === 'array' ? spec.items?.fields : spec.fields;
    spec = part === '$key' && spec.type === 'map' ? { type: 'string', ...spec.key } : part === '$value' && spec.type === 'map' ? spec.value : fields?.[part];
  }
  return spec || null;
}

const changed = () => busPublishAll({ type: 'plugins.changed' });

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { reject(new PluginError(413, `文件太大（上限 ${Math.round(max / 1024 / 1024)}MB）`)); req.removeAllListeners('data'); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

export function registerPluginRoutes(router, { identify }) {
  const admin = (req, res) => {
    const ctx = requireCtx(identify, req, res);
    if (!ctx) return null;
    if (!can(ctx, 'server.manage')) { json(res, 403, { error: '只有服务器主机能管理插件' }); return null; }
    return ctx;
  };
  const body = async (req) => {
    const raw = await readBody(req, 1_000_000);
    try { return raw ? JSON.parse(raw) : {}; } catch { throw new PluginError(400, '请求体不是合法 JSON'); }
  };

  router.on('GET', '/api/plugins', async (req, res) => {
    if (!admin(req, res)) return;
    await refreshStatuses(kernel.list().filter((p) => p.active).map((p) => p.id));
    json(res, 200, pluginsOverview());
  });

  router.on('POST', '/api/plugins/action', async (req, res) => {
    const who = admin(req, res);
    if (!who) return;
    try {
      const b = await body(req);
      if (!kernel.isActive(String(b.id || ''))) throw new PluginError(404, '插件没开着');
      const r = await runAction(String(b.id), String(b.action || ''), who, b.args);
      json(res, 200, { ...r, plugin: pluginView(kernel.get(String(b.id))) });
    } catch (e) { json(res, e.status || 400, { error: String(e?.message || e) }); }
  });

  router.on('GET', '/api/plugins/options', async (req, res, url) => {
    const who = admin(req, res);
    if (!who) return;
    try {
      const id = url.searchParams.get('id') || '';
      const field = url.searchParams.get('field') || '';
      if (!kernel.has(id)) throw new PluginError(404, '没有插件「' + id + '」');
      const spec = specAt(kernel.schemaOf(id), field);
      if (!spec) throw new PluginError(404, '没有字段「' + field + '」');
      const src = spec.options;
      let options = typeof src === 'string' && src !== 'plugin' ? builtinOptions(src, spec) : null;
      if (src === 'plugin') {
        if (!kernel.isActive(id)) { json(res, 200, { options: [], note: '插件开着才有选项' }); return; }
        options = await optionsFor(id, field, who);
      }
      json(res, 200, { options: options || [] });
    } catch (e) { json(res, e.status || 400, { error: String(e?.message || e) }); }
  });

  router.on('GET', '/api/plugins/log', (req, res, url) => {
    if (!admin(req, res)) return;
    const c = kernel.contextOf(url.searchParams.get('id') || '');
    const h = c && c.process ? c.process.get(url.searchParams.get('name') || '') : null;
    if (!h) { json(res, 404, { error: '没有这个子进程' }); return; }
    json(res, 200, { lines: h.tail(Number(url.searchParams.get('lines')) || 200), ...h.info() });
  });

  router.on('POST', '/api/plugins/toggle', async (req, res) => {
    if (!admin(req, res)) return;
    try {
      const b = await body(req);
      if (!kernel.has(String(b.id || ''))) throw new PluginError(404, '没有插件「' + b.id + '」');
      const p = await kernel.setEnabled(String(b.id), !!b.enabled);
      changed();
      json(res, 200, { plugin: pluginView(p), ...pluginsOverview() });
    } catch (e) { fail(res, e); }
  });

  router.on('POST', '/api/plugins/config', async (req, res) => {
    if (!admin(req, res)) return;
    try {
      const b = await body(req);
      if (!kernel.has(String(b.id || ''))) throw new PluginError(404, '没有插件「' + b.id + '」');
      // 新授权了主机本人 / pro 档账号：要用户在设置页再点一次确认
      const risky = b.confirmGrant ? [] : riskyGrants(String(b.id), b.config || {});
      if (risky.length) { json(res, 409, { error: '要确认授权', needConfirm: { accounts: risky } }); return; }
      const p = await kernel.setConfig(String(b.id), b.config || {});
      changed();
      json(res, 200, { plugin: pluginView(p), ...pluginsOverview() });
    } catch (e) { fail(res, e); }
  });

  router.on('POST', '/api/plugins/reload', async (req, res) => {
    if (!admin(req, res)) return;
    try {
      const b = await body(req);
      const p = await reloadPlugin(kernel, String(b.id || ''));
      changed();
      json(res, 200, { plugin: pluginView(p), ...pluginsOverview() });
    } catch (e) { fail(res, e); }
  });

  router.on('POST', '/api/plugins/install', async (req, res) => {
    if (!admin(req, res)) return;
    try {
      const type = String(req.headers['content-type'] || '');
      let p;
      if (type.includes('application/json')) {
        const b = await body(req);
        if (b.github) p = await installFromGithub(kernel, String(b.github));
        else if (!b.path) throw new PluginError(400, '要 path（本机插件目录）或 github（仓库地址），或直接上传 zip');
        else p = await linkLocal(kernel, String(b.path));
      } else {
        p = await installFromArchive(kernel, await readRaw(req, MAX_ZIP));
      }
      changed();
      json(res, 200, { plugin: pluginView(p), ...pluginsOverview() });
    } catch (e) { fail(res, e); }
  });

  router.on('GET', '/api/plugins/update', async (req, res, url) => {
    if (!admin(req, res)) return;
    try { json(res, 200, await checkUpdate(kernel, url.searchParams.get('id') || '')); }
    catch (e) { fail(res, e); }
  });

  router.on('POST', '/api/plugins/uninstall', async (req, res) => {
    if (!admin(req, res)) return;
    try {
      const b = await body(req);
      await uninstallPlugin(kernel, String(b.id || ''));
      changed();
      json(res, 200, pluginsOverview());
    } catch (e) { fail(res, e); }
  });

  // ── 插件页面（面板槽位）──────────────────────────────────────────────────
  // 这个身份能不能开某插件的页面：插件开着、声明了页面；ui.who 是 host（缺省）时只有主机能开。
  const pageAllowed = (c, p) => {
    if (!p || !p.active) return false;
    const ui = p.extra?.ui;
    if (!ui || (!ui.panel && !ui.settings)) return false;
    if (can(c, 'server.manage')) return true;
    return ui.who === 'members' && c.kind === 'user';
  };

  // 当前用户能看到的插件面板（设置侧栏 / 手机设置据此多出几行）。设置分区（ui.settings）只在主机的插件详情里，不在这里。
  router.on('GET', '/api/plugins/panels', (req, res) => {
    const c = requireCtx(identify, req, res);
    if (!c) return;
    const panels = kernel.list().filter((p) => p.extra?.ui?.panel && pageAllowed(c, p)).map((p) => ({
      id: p.id, name: p.name, title: p.extra.ui.panel.title, titleEn: p.extra.ui.panel.titleEn || '', icon: p.extra.ui.panel.icon, page: p.extra.ui.panel.page,
    }));
    json(res, 200, { panels });
  });

  // 签一张插件票（独立打开页面用：新窗口、手机 App 的干净页面）。返回 { ticket, expiresIn, page }。
  router.on('POST', '/api/plugins/ticket', async (req, res) => {
    const c = requireCtx(identify, req, res);
    if (!c) return;
    try {
      const b = await body(req);
      const p = kernel.get(String(b.id || ''));
      if (!pageAllowed(c, p)) throw new PluginError(403, '打不开这个插件的页面');
      const ui = p.extra.ui;
      const page = b.which === 'settings' && ui.settings ? ui.settings : (ui.panel?.page || ui.settings);
      if (b.which === 'settings' && !can(c, 'server.manage')) throw new PluginError(403, '只有服务器主机能改插件设置');
      json(res, 200, { ...mintTicket(p.id, identityOfContext(c)), page: '/plugins/' + p.id + '/' + page });
    } catch (e) { fail(res, e); }
  });

  // 独立页面的事件流（ctx.bus.toPage 推的）：票据放请求头，SDK 用 fetch 流读（不用 EventSource，票不进地址栏）。
  router.on('GET', '/api/plugins/page-events', (req, res, url) => {
    const id = url.searchParams.get('id') || '';
    const tok = ticketOf(req);
    const ident = tok && kernel.isActive(id) ? resolveTicket(tok, id) : null;
    if (!ident) { json(res, 401, { error: 'plugin ticket expired' }); return; }
    const c = contextFor(ident);
    subscribePage(id, res, { admin: can(c, 'server.manage'), keepAlive: () => !!resolveTicket(tok, id) });
  });

  // 插件页面：/plugins/<id>/web/<相对路径>（空路径给面板页）。SDK：/plugins/_sdk/<文件>（核心自带，所有插件页面共用）。
  router.prefix('GET', '/plugins/', (req, res, url) => {
    const sdk = /^\/plugins\/_sdk\/(bridge-plugin\.(?:js|css))$/.exec(url.pathname);
    if (sdk) { serveFile(res, path.join(SDK_DIR, sdk[1]), { sandbox: false }); return; }
    const m = /^\/plugins\/([a-z][a-z0-9-]{0,47})\/web(?:\/(.*))?$/.exec(url.pathname);
    const p = m && kernel.get(m[1]);
    const root = p && p.active ? pluginWebDir(p) : null;
    if (!root) { json(res, 404, { error: 'not found' }); return; }
    let rel;
    try { rel = decodeURIComponent(m[2] || ''); } catch { json(res, 400, { error: 'bad path' }); return; }
    if (!rel) rel = String(p.extra?.ui?.panel?.page || p.web?.page || 'index.html').replace(/^web\//, '');
    const file = path.resolve(root, rel);
    if (!file.startsWith(path.resolve(root) + path.sep)) { json(res, 403, { error: 'forbidden' }); return; }
    serveFile(res, file, { sandbox: true });
  });
}

// 插件页面一律带 CSP sandbox：不管是嵌在 iframe 里还是独立打开（新窗口 / 手机浏览器），文档都是不透明源——
// 读不到 bridge 的 cookie、localStorage，也不能带着访问者的登录态调 /api/*（成员打开主机装的插件页面时尤其要紧）。
// 调插件自己的接口靠票据（plugins/tickets.mjs）或宿主代发。
const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals';
const SDK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'sdk');

function serveFile(res, file, { sandbox }) {
  let st;
  try { st = statSync(file); } catch { json(res, 404, { error: 'not found' }); return; }
  if (!st.isFile()) { json(res, 404, { error: 'not found' }); return; }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    ...(sandbox && type.startsWith('text/html') ? { 'Content-Security-Policy': SANDBOX_CSP } : {}),
  });
  createReadStream(file).pipe(res);
}
