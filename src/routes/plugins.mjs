// 插件管理（设置 › 扩展 › 功能扩展）：服务器主机才能用（can 'server.manage'，远程也行——同扩展中心）。
//
//   GET  /api/plugins                      全部插件：内置功能 + agent 扩展 + 第三方（状态、配置 schema、打码后的配置）
//   POST /api/plugins/toggle   {id, enabled}
//   POST /api/plugins/config   {id, config}  按 schema 校验；热插件当场重启生效
//   POST /api/plugins/reload   {id}          第三方插件重新读清单与代码（本机开发目录改完点一下）
//   POST /api/plugins/install  zip 原始字节（Content-Type: application/zip）| JSON {path}（登记本机目录）| JSON {github}（从 GitHub 装）
//   GET  /api/plugins/update?id=             从 GitHub 装的插件检查更新（比最新 Release 与清单版本）
//   GET  /api/plugins/market[?refresh=1]     官方插件市场（plugins/market.mjs）：条目 + 本机安装状态 + 有更新的
//   POST /api/plugins/market/install {id, version?}   从市场装 / 更新（没给版本 = 最新兼容版）；内置功能 = 装市场版盖住它
//   POST /api/plugins/rollback {id}          回退到回收区里的上一版（装的插件 / 市场版内置功能）
//   POST /api/plugins/restore-builtin {id}   内置功能换回内置版（市场版进回收区）
//   POST /api/plugins/uninstall {id}         装的 → 卸载（旧版进 .trash）；本机目录 → 取消登记
//   POST /api/plugins/action   {id, action, args?}   插件详情页的动作按钮（ctx.action）
//   GET  /api/plugins/options?id=&field=     配置字段的动态选项（内置来源 claude.models / users… 或插件 ctx.configOptions）
//   GET  /api/plugins/log?id=&name=&lines=   托管子进程（ctx.process）的日志尾巴；name=plugin = 插件自己的日志（ctx.log，&level=warn|error 过滤）
//   GET  /plugins/<id>/web/<path>           第三方插件自带的页面（web/），插件开着才给；免登录（同 /app 静态资源）；html 与 svg / xml 带 CSP sandbox
//   GET  /api/plugins/ui                    界面扩展（主页卡片、应用图标……）；POST /api/plugins/ticket 签插件票（面板 / 设置 / 工作台 / 应用）
//   GET|POST /api/plugin/<id>/_bridge/<op>[/<子操作>]   插件页面的设置（只给主机）与页面宿主能力（kv / grants / chat / files / host）
//   GET  /api/plugins/grants?plugin=  POST /api/plugins/grants {plugin, perm, allow}   页面权限的授权（只有 bridge 自己的界面能调）
//   POST /api/plugins/handles {plugin, items, mode?}   给选择器里选中的文件签句柄；GET|POST /api/plugins/host-requests/<req>[/complete] 手机 App 的宿主请求中转
//
// 授权账号（schema 里 type:'user' + grant:'chat' 的字段）：新选上主机本人或 pro 档账号时，config 要带 confirmGrant:true，
// 否则回 409 { needConfirm: { accounts } }，前端弹确认后重发。
//
// 改动后推总线：管理员页面刷新插件列表（plugins.changed），所有在线页面重新问 /api/auth（入口按开关显隐）。

import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { kernel, setPluginUpdatesProvider } from '../plugins/state.mjs';
import { installFromArchive, uninstallPlugin, linkLocal, reloadPlugin, pluginWebDir, PluginError } from '../plugins/discover.mjs';
import { requireCtx, contextFor } from '../runtime/identity.mjs';
import { mintTicket, resolveTicket, resolveTicketInfo, revokeTicket, ticketOf, claimsTicket, watchKernelTickets } from '../plugins/tickets.mjs';
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
import { marketOverview, installFromMarket, rollbackInstalled, restoreBuiltinVersion, pendingUpdates } from '../plugins/market.mjs';
import { rollbackTarget } from '../plugins/discover.mjs';
import { FEATURES } from '../config/index.mjs';
import { pluginLogs } from '../plugins/logs.mjs';
import { uiView, runUi, findApp, canUsePluginPages } from '../plugins/ui.mjs';
// viewApp / findFileHandler 按命名空间取、用时判在不在：ui.mjs 少了哪个导出也只是那条路由用不了，不至于整个模块加载失败
import * as uiMod from '../plugins/ui.mjs';
import { kvGet, kvList, kvSet } from '../plugins/page-kv.mjs';
import { grantsView, grantsList, setGrant } from '../plugins/page-grants.mjs';
import { signHandles, useHandle, statHandle, streamHandle, writeHandle, WRITE_MAX } from '../plugins/page-files.mjs';
import { createHostRequest, waitHostRequest, hostRequestView, completeHostRequest } from '../plugins/page-host.mjs';
import { chatStart, chatSend, chatStop, chatSessions, chatHistory, chatEvents, chatWatch } from '../plugins/page-chat.mjs';

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
    ...(p.source === 'installed' && sourceOf(kernel, p.id)?.github ? { github: sourceOf(kernel, p.id) } : {}),
    ...(p.source === 'installed' && sourceOf(kernel, p.id)?.market ? { market: sourceOf(kernel, p.id) } : {}),
    // 市场版内置功能：{ version, active, error, pending? }（pending.install = 重启后换上的版本，pending.restore = 重启后恢复内置版）
    ...(extra && extra.override ? { override: extra.override } : {}),
    ...(p.source === 'installed' || (p.source === 'builtin' && extra && extra.override) ? { rollbackTo: rollbackTarget(kernel, p.id)?.version || null } : {}),
    // 清单体检（不认识的字段、用了内部接口……）、能力声明、英文界面词条（locales/en.json）
    ...(extra && extra.lint && extra.lint.length ? { lint: extra.lint } : {}),
    ...(extra && extra.permissions ? { permissions: extra.permissions } : {}),
    ...(extra && extra.i18n && extra.i18n.en ? { i18n: { en: extra.i18n.en } } : {}),
    hasLogs: pluginLogs(p.id, { lines: 1 }).length > 0,
    ...(p.active ? panelView(p.id) : {}),
  };
}

export function pluginsOverview() {
  const plugins = kernel.list().map(pluginView);
  return { plugins, restartPending: plugins.some((p) => p.pendingRestart || !!p.override?.pending), updates: pendingUpdates(kernel) };
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
  setPluginUpdatesProvider(() => pendingUpdates(kernel));
  // 插件从开变关（或卸掉）就作废它的页面票：重新启用后旧页面拿旧票也进不来（bootPlugins 也挂，同一个内核只挂一次）
  watchKernelTickets(kernel);
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
    const id = url.searchParams.get('id') || '';
    // name=plugin：插件自己的日志（ctx.log / warn / error；插件关着也能看最近的）
    if ((url.searchParams.get('name') || '') === 'plugin') {
      if (!kernel.has(id)) { json(res, 404, { error: '没有这个插件' }); return; }
      const lines = pluginLogs(id, { lines: Number(url.searchParams.get('lines')) || 200, level: url.searchParams.get('level') || '' });
      json(res, 200, { name: 'plugin', entries: lines, lines: lines.map((l) => `${new Date(l.t).toLocaleString('zh-CN', { hour12: false })} ${l.level === 'info' ? '' : l.level.toUpperCase() + ' '}${l.text}`) });
      return;
    }
    const c = kernel.contextOf(id);
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

  // ── 插件市场 ──────────────────────────────────────────────────────────
  router.on('GET', '/api/plugins/market', async (req, res, url) => {
    if (!admin(req, res)) return;
    try { json(res, 200, await marketOverview(kernel, { refresh: url.searchParams.get('refresh') === '1' })); }
    catch (e) { fail(res, e); }
  });

  // 装 / 更新 / 回退 / 恢复内置版：回 { plugin, ...插件总览, marketPlugins? }，前端两块一起刷新
  const marketOp = (fn) => async (req, res) => {
    if (!admin(req, res)) return;
    try {
      const b = await body(req);
      const id = String(b.id || '');
      if (!id) throw new PluginError(400, '要 id');
      const p = await fn(id, b);
      changed();
      json(res, 200, { plugin: pluginView(kernel.get(id) ? { ...kernel.get(id), pendingRestart: !!p?.pendingRestart || kernel.get(id).pendingRestart } : p), ...pluginsOverview() });
    } catch (e) { fail(res, e); }
  };
  router.on('POST', '/api/plugins/market/install', marketOp((id, b) => installFromMarket(kernel, id, typeof b.version === 'string' ? b.version : '')));
  router.on('POST', '/api/plugins/rollback', marketOp((id) => rollbackInstalled(kernel, id)));
  router.on('POST', '/api/plugins/restore-builtin', marketOp((id) => restoreBuiltinVersion(kernel, id)));

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
      id: p.id, name: p.name, title: p.extra.ui.panel.title, icon: p.extra.ui.panel.icon, page: p.extra.ui.panel.page,
      // 英文标题：插件 locales/en.json 的 ui.panel.title 优先，其次清单里的 ui.panel.titleEn
      titleEn: (typeof p.extra.i18n?.en?.ui?.panel?.title === 'string' && p.extra.i18n.en.ui.panel.title.trim().slice(0, 30)) || p.extra.ui.panel.titleEn || '',
    }));
    json(res, 200, { panels });
  });

  // 界面扩展（plugins/ui.mjs，四期）：这个身份能看到的主页卡片、工作台标签、「/」命令、各处菜单、主题变量。?lang=en 取英文词条。
  router.on('GET', '/api/plugins/ui', async (req, res, url) => {
    const c = requireCtx(identify, req, res);
    if (!c) return;
    try { json(res, 200, await uiView(c, url.searchParams.get('lang') || 'zh')); } catch (e) { fail(res, e); }
  });
  // 按下一个界面动作（「/」命令、＋菜单、消息 / 会话菜单）：{ plugin, kind, id, args } → { toast?, insert?, send?, open? }
  router.on('POST', '/api/plugins/ui/run', async (req, res) => {
    const c = requireCtx(identify, req, res);
    if (!c) return;
    try {
      const b = await body(req);
      json(res, 200, await runUi(c, { plugin: String(b.plugin || ''), kind: String(b.kind || ''), id: String(b.id || ''), args: b.args }));
    } catch (e) { json(res, e.status || 400, { error: String(e?.message || e) }); }
  });
  // 声明式应用（kind:'view'）的首屏：{ plugin, id, state } → { tree, state }（plugins/ui.mjs 的 viewApp）。
  // 找不到应用 / 插件没开 / 这个身份看不到 → 404；state 太大 → 413；别的参数问题 400——状态码由 viewApp 抛的 status 定。
  router.on('POST', '/api/plugins/ui/view', async (req, res) => {
    const c = requireCtx(identify, req, res);
    if (!c) return;
    try {
      if (typeof uiMod.viewApp !== 'function') throw new PluginError(501, '这个版本还不支持声明式应用');
      const b = await body(req);
      json(res, 200, await uiMod.viewApp(c, { plugin: String(b.plugin || ''), id: String(b.id || ''), state: b.state }));
    } catch (e) {
      const status = e?.status || (e?.message === 'body too large' ? 413 : 400);
      json(res, status, { error: status === 413 && e?.message === 'body too large' ? '请求体太大了' : String(e?.message || e) });
    }
  });

  // 签一张插件票（独立打开页面用：新窗口、手机 App 的干净页面）。返回 { ticket, expiresIn, page }。
  // which: 'panel'（缺省）| 'settings' | 'workbench'（带 page：Claude 工作台标签）| 'app'（带 app：插件应用的全屏分页）
  router.on('POST', '/api/plugins/ticket', async (req, res) => {
    const c = requireCtx(identify, req, res);
    if (!c) return;
    try {
      const b = await body(req);
      // 解不出身份（账号库里已经没有这个成员、或不是主机 / 成员的调用方）就不签：签出来也是张废票，页面调接口全是 401
      const ident = identityOfContext(c);
      if (b.which === 'app') {
        const id = String(b.id || '');
        const hit = ident && kernel.isActive(id) ? findApp(c, id, String(b.app || '')) : null;
        if (!hit || hit.kind !== 'page') throw new PluginError(403, '打不开这个应用');
        json(res, 200, { ...mintTicket(id, ident, { app: hit.id }), page: '/plugins/' + id + '/' + hit.page });
        return;
      }
      if (!ident) throw new PluginError(403, '打不开这个插件的页面');
      if (b.which === 'workbench') {
        const id = String(b.id || '');
        const want = String(b.page || '').replace(/^\/+/, '');
        const hit = (await uiView(c)).workbench.find((w) => w.plugin === id && w.page === want);
        if (!hit || !kernel.isActive(id)) throw new PluginError(403, '打不开这个插件的页面');
        json(res, 200, { ...mintTicket(id, ident), page: '/plugins/' + id + '/' + hit.page });
        return;
      }
      const p = kernel.get(String(b.id || ''));
      if (!pageAllowed(c, p)) throw new PluginError(403, '打不开这个插件的页面');
      const ui = p.extra.ui;
      const page = b.which === 'settings' && ui.settings ? ui.settings : (ui.panel?.page || ui.settings);
      if (b.which === 'settings' && !can(c, 'server.manage')) throw new PluginError(403, '只有服务器主机能改插件设置');
      json(res, 200, { ...mintTicket(p.id, ident), page: '/plugins/' + p.id + '/' + page });
    } catch (e) { fail(res, e); }
  });

  // 独立页面的事件流（ctx.bus.toPage 推的）：票据放请求头，SDK 用 fetch 流读（不用 EventSource，票不进地址栏）。
  router.on('GET', '/api/plugins/page-events', (req, res, url) => {
    const id = url.searchParams.get('id') || '';
    const tok = ticketOf(req);
    const snap = tok && kernel.isActive(id) ? resolveTicket(tok, id) : null;
    if (!snap) { json(res, 401, { error: 'plugin ticket expired' }); return; }
    // 票上是签票那一刻的身份：按账号库现状重解析（同 _bridge）。账号停用 / 删了 → 401 并当场作废票，账号恢复了旧票也不复活
    const ident = snap.kind === 'admin' || snap.kind === 'user' ? identityOfContext(contextFor(snap)) : null;
    if (!ident) { revokeTicket(tok); json(res, 401, { error: 'plugin ticket expired' }); return; }
    const c = contextFor(ident);
    // 连着期间也复核：账号被停用后，下一次保活检查就断开（不能凭一张已签出的票一直收推给页面的消息）
    const keepAlive = () => {
      const now = resolveTicket(tok, id);
      if (!now) return false;
      if (identityOfContext(contextFor(now))) return true;
      revokeTicket(tok);
      return false;
    };
    subscribePage(id, res, { admin: can(c, 'server.manage'), keepAlive });
  });

  // 插件页面经 bridge 用的接口（SDK 的 bridge.*）：/api/plugin/<id>/_bridge/<op>[/<子操作>]
  // 挂在插件自己的路径下（宿主代发与插件票据都只放行 /api/plugin/<本插件>/），前缀路由——插件自己挂的精确路径优先。
  // 两类 op，分开判权：
  //   · 设置与动作（config / options / actions / action / status）：只给服务器主机——成员能开的面板（ui.who=members）
  //     也改不了插件设置、按不了动作按钮；
  //   · 页面宿主能力（kv / grants / chat/* / files/* / host/*）：给能用这个插件页面的人（canUsePluginPages：
  //     主机；成员要这个插件有对成员开放的页面）。主机专用的插件，成员拿票或经宿主代发都够不着。
  // 每个能力自己还要再判：声明并授过权（page.chat / page.files）、会话 / 句柄 / 中转请求属于这个插件和这个人。
  const HOST_OPS = new Set(['config', 'options', 'actions', 'action', 'status']);
  const PAGE_OPS = new Set(['kv', 'grants', 'chat', 'files', 'host']);
  router.prefix(['GET', 'POST'], '/api/plugin/', async (req, res, url) => {
    const m = /^\/api\/plugin\/([a-z][a-z0-9-]{0,47})\/_bridge\/([a-z][a-z0-9-]{0,31})(?:\/([a-z][a-z0-9-]{0,31}))?$/.exec(url.pathname);
    if (!m) { json(res, 404, { error: 'not found' }); return; }
    const [, id, op, sub = ''] = m;
    if (!kernel.isActive(id)) { json(res, 404, { error: '插件没开着' }); return; }
    const tok = ticketOf(req);
    let who;
    let ident = null;   // 内部请求（/api/chat 等）用的身份；票据路径在这里现解析，cookie 路径到 pageOp 里再按需拼
    let ticketApp = null;
    // 自称带票却解析不出（格式不对）也走票据分支、回 401：退回 cookie 那头的话，NO_AUTH 实例上就成了主机身份
    if (tok || claimsTicket(req)) {
      const info = resolveTicketInfo(tok, id);
      if (!info) { json(res, 401, { error: 'plugin ticket expired' }); return; }
      // contextFor 把认不出的身份兜底成主机——票上只该是主机或成员，别的一律不认
      const k = info.identity && info.identity.kind;
      if (k !== 'admin' && k !== 'user') { json(res, 403, { error: '这个身份用不了插件页面' }); return; }
      // 票上是签票那一刻的身份快照，最长能续 12 小时：每次都按账号库现状重解析一遍。账号停用 / 删了就拿不到，
      // 当场作废这张票（cookie 那头此刻已经失效，这里不能还认）；档位、agent 勾选改过的也以现在的为准。
      ident = identityOfContext(contextFor(info.identity));
      if (!ident) { revokeTicket(tok); json(res, 401, { error: 'plugin ticket expired' }); return; }
      who = contextFor(ident);
      ticketApp = info.app || null;
    } else {
      who = requireCtx(identify, req, res);
      if (!who) return;
    }
    if (who.kind !== 'admin' && who.kind !== 'user') { json(res, 403, { error: '这个身份用不了插件页面' }); return; }
    if (PAGE_OPS.has(op)) { await pageOp(req, res, url, who, ident, id, op, sub, ticketApp); return; }
    if (!HOST_OPS.has(op) || sub) { json(res, 404, { error: 'not found' }); return; }
    if (!can(who, 'server.manage')) { json(res, 403, { error: '只有服务器主机能改插件设置' }); return; }
    try {
      if (op === 'config' && req.method === 'GET') {
        const p = kernel.get(id);
        json(res, 200, { schema: p.schema, config: p.config, problems: p.problems, i18n: p.extra?.i18n?.en ? { en: p.extra.i18n.en } : null });
      } else if (op === 'config' && req.method === 'POST') {
        // patch 合并进当前配置（没给的字段不动）；secret 字段回传打码串 = 沿用旧值
        const b = await body(req);
        const patch = b.patch && typeof b.patch === 'object' && !Array.isArray(b.patch) ? b.patch : null;
        if (!patch) throw new PluginError(400, '要 patch：{ 字段: 新值 }');
        const next = { ...(kernel.readState().plugins[id]?.config || {}), ...patch };
        const risky = b.confirmGrant ? [] : riskyGrants(id, next);
        if (risky.length) { json(res, 409, { error: '要确认授权', needConfirm: { accounts: risky } }); return; }
        const p = await kernel.setConfig(id, next);
        changed();
        json(res, 200, { config: p.config, problems: p.problems });
      } else if (op === 'options' && req.method === 'GET') {
        const field = url.searchParams.get('field') || '';
        const spec = specAt(kernel.schemaOf(id), field);
        if (!spec) throw new PluginError(404, '没有字段「' + field + '」');
        const src = spec.options;
        const options = src === 'plugin' ? await optionsFor(id, field, who) : typeof src === 'string' ? builtinOptions(src, spec) : null;
        json(res, 200, { options: options || [] });
      } else if (op === 'actions' && req.method === 'GET') {
        json(res, 200, { actions: panelView(id).actions || [] });
      } else if (op === 'action' && req.method === 'POST') {
        const b = await body(req);
        json(res, 200, await runAction(id, String(b.action || ''), who, b.args));
      } else if (op === 'status' && req.method === 'GET') {
        await refreshStatuses([id]);
        const { panelStatus, optionFields, ...rest } = panelView(id);
        json(res, 200, { status: panelStatus || null, ...rest });
      } else json(res, 404, { error: 'not found' });
    } catch (e) { json(res, e.status || 400, { error: String(e?.message || e) }); }
  });

  // 页面能力的错误：没同意带 needGrant（SDK 据此先弹授权框再重试），没声明带 undeclared + perm（不带 needGrant，弹框也是白弹）；
  // 读请求体超限 413。已经开始回字节（SSE、文件流）就只能断开。
  const pageFail = (res, e) => {
    if (res.headersSent) { try { res.end(); } catch {} return; }
    const status = e?.status || (e?.message === 'body too large' ? 413 : 400);
    json(res, status, {
      error: status === 413 && e?.message === 'body too large' ? '请求体太大了' : String(e?.message || e),
      ...(e?.needGrant ? { needGrant: e.needGrant } : {}), ...(e?.undeclared ? { undeclared: true, ...(e.perm ? { perm: e.perm } : {}) } : {}),
    });
  };

  // 页面宿主能力。who = 已判过「能用这个插件页面」的身份；ident = 票据路径已按账号库现解析的身份
  //（cookie 路径为 null）；ticketApp = 票据上的应用 id（嵌入模式为 null）。
  async function pageOp(req, res, url, who, ident, id, op, sub, ticketApp) {
    if (!canUsePluginPages(who, id)) { json(res, 403, { error: '你用不了这个插件的页面' }); return; }
    const M = req.method;
    const q = (k) => url.searchParams.get(k) || '';
    // 内部请求（/api/chat 等）要的身份：票据路径用上面现解析的；cookie 路径（登录态刚验过）从账号库现拼
    const identity = () => {
      const i = ident || identityOfContext(who);
      if (!i) throw new PluginError(403, '认不出你的身份（账号可能已停用），重新登录再试');
      return i;
    };
    const nope = () => json(res, 404, { error: 'not found' });
    try {
      if (op === 'kv' && !sub) {
        if (M === 'GET') {
          const key = url.searchParams.get('key');
          json(res, 200, key == null ? { keys: await kvList(id, who.key) } : { value: await kvGet(id, who.key, key) });
        } else {
          const b = await body(req);
          await kvSet(id, who.key, b.key, b.value);
          json(res, 200, { ok: true });
        }
      } else if (op === 'grants' && !sub && M === 'GET') {
        json(res, 200, grantsView(id, who.key));
      } else if (op === 'files') {
        if (!['stat', 'read', 'write'].includes(sub) || (sub === 'write') !== (M === 'POST')) { nope(); return; }
        const rec = useHandle(q('h'), id, who.key);
        if (sub === 'stat') json(res, 200, statHandle(rec));
        else if (sub === 'read') streamHandle(rec, res);
        else {
          // 先判能不能写再收字节（别白收 50MB）；只读的身份（档位降了）签过的 rw 句柄也不让写
          if (rec.mode !== 'rw' || who.readOnly) throw new PluginError(403, '这个文件是只读打开的，不能存回');
          json(res, 200, await writeHandle(rec, await readRaw(req, WRITE_MAX)));
        }
      } else if (op === 'chat') {
        if (sub === 'start' && M === 'POST') json(res, 200, await chatStart(who, identity(), id, await body(req), ticketApp));
        else if (sub === 'send' && M === 'POST') json(res, 200, await chatSend(who, identity(), id, await body(req)));
        else if (sub === 'stop' && M === 'POST') json(res, 200, await chatStop(who, identity(), id, await body(req)));
        else if (sub === 'events' && M === 'GET') chatEvents(who, id, q('session'), res);
        else if (sub === 'sessions' && M === 'GET') json(res, 200, await chatSessions(who, id, q('app')));
        else if (sub === 'watch' && M === 'POST') json(res, 200, chatWatch(who, id, await body(req)));
        else if (sub === 'history' && M === 'GET') json(res, 200, await chatHistory(who, identity(), id, q('session')));
        else nope();
      } else if (op === 'host') {
        if (sub === 'request' && M === 'POST') {
          const b = await body(req);
          // 应用 id：票据上的为准；嵌入模式用请求体里的（只认本插件确有、这个身份看得到的应用）
          const app = ticketApp || (typeof b.app === 'string' && findApp(who, id, b.app) ? b.app : null);
          json(res, 200, createHostRequest(who, id, app, b.type, b.payload));
        } else if (sub === 'wait' && M === 'GET') {
          // 页面断开就提前收掉这次长轮询
          const ac = new AbortController();
          res.on('close', () => ac.abort());
          const r = await waitHostRequest(q('req'), id, who.key, { signal: ac.signal });
          if (!res.writableEnded && !res.destroyed) json(res, 200, r);
        } else nope();
      } else nope();
    } catch (e) { pageFail(res, e); }
  }

  // ---- 页面宿主能力：只给 bridge 自己的界面（登录态）----
  // 这几条在 /api/plugins/ 下：插件页面经宿主代发或带票据都只放行 /api/plugin/<本插件>/，够不着——
  // 页面只能「提出」要授权 / 要选文件，点「允许」、选哪几个文件，一律是使用者在 bridge 自己画的界面里做的。
  const member = (req, res) => {
    const c = requireCtx(identify, req, res);
    if (!c) return null;
    if (c.kind !== 'admin' && c.kind !== 'user') { json(res, 403, { error: '这个身份用不了插件页面' }); return null; }
    return c;
  };
  // 纵深防御：「允许」「签文件句柄」「中转请求」只认 bridge 自己界面发的请求——web/src/lib/api.js 的 req()
  // 会带 X-Bridge-UI: 1，而 PluginFrame 替插件页面代发时用的 authHeaders() 不带。万一哪天代发的路径白名单写宽了、
  // 或有别的同源页面拿着登录态来调，也点不了这几个按钮。先验登录再验这个头：没登录的（含只带插件票的）照旧 401。
  const memberUi = (req, res) => {
    const c = member(req, res);
    if (!c) return null;
    if (String(req.headers['x-bridge-ui'] || '') !== '1') { json(res, 403, { error: '只能从 bridge 自己的界面调用' }); return null; }
    return c;
  };

  // 页面权限的授权：GET → { declared, granted }；POST { plugin, perm, allow } → { ok: true, granted }
  router.on('GET', '/api/plugins/grants', (req, res, url) => {
    const c = member(req, res);
    if (!c) return;
    // 不带 plugin：设置 › 页面权限 的总览（这个身份能管的每个插件一行）
    if (!url.searchParams.has('plugin')) { json(res, 200, grantsList(c)); return; }
    const id = url.searchParams.get('plugin') || '';
    if (!kernel.has(id)) { json(res, 404, { error: '没有这个插件' }); return; }
    json(res, 200, grantsView(id, c.key));
  });
  router.on('POST', '/api/plugins/grants', async (req, res) => {
    const c = memberUi(req, res);
    if (!c) return;
    try {
      const b = await body(req);
      json(res, 200, { ok: true, granted: setGrant(c, String(b.plugin || ''), String(b.perm || ''), b.allow === true) });
    } catch (e) { pageFail(res, e); }
  });

  // 给选择器里选中的文件签句柄：{ plugin, items: [{ rel, ws? }], mode?, via? } → { files: [{ handle, name, size, mime, mode }] }
  // via: { fileHandler: '<处理器 id>' }（文件列表里「用 X 打开」）：扩展名对得上这个处理器就免授权框，仍要声明 page.files
  router.on('POST', '/api/plugins/handles', async (req, res) => {
    const c = memberUi(req, res);
    if (!c) return;
    try {
      const b = await body(req);
      const plugin = String(b.plugin || '');
      let via = null;
      if (b.via != null) {
        const hid = b.via && typeof b.via === 'object' ? String(b.via.fileHandler || '') : '';
        if (!hid) throw new PluginError(400, 'via 要写成 { fileHandler: "<处理器 id>" }');
        if (typeof uiMod.findFileHandler !== 'function') throw new PluginError(501, '这个版本还不支持「用插件打开」');
        via = uiMod.findFileHandler(c, plugin, hid);
        if (!via) throw new PluginError(404, '这个插件没有这个文件处理器（或你用不了它）');
      }
      json(res, 200, { files: signHandles(c, plugin, b.items, b.mode === 'r' ? 'r' : 'rw', { via }) });
    } catch (e) { pageFail(res, e); }
  });

  // 手机 App 的宿主请求中转（主界面那一头）：GET <req> 看要做什么；POST <req>/complete { result } 交回结果
  router.prefix(['GET', 'POST'], '/api/plugins/host-requests/', async (req, res, url) => {
    const m = /^\/api\/plugins\/host-requests\/([A-Za-z0-9_-]{16,64})(\/complete)?$/.exec(url.pathname);
    if (!m || (req.method === 'POST') !== !!m[2]) { json(res, 404, { error: 'not found' }); return; }
    const c = memberUi(req, res);
    if (!c) return;
    try {
      if (!m[2]) { json(res, 200, hostRequestView(m[1], c)); return; }
      const b = await body(req);
      json(res, 200, completeHostRequest(m[1], c, b.result));
    } catch (e) { pageFail(res, e); }
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
// svg / xml 直接打开也是文档、里面能写脚本：插件应用的图标就在 web/ 下，有人把图标地址发给你点开，不能让它跑脚本。
// 这类只给光秃秃的 sandbox（不带 allow-scripts）；当 <img> 用时 CSP 不管事，图标照常显示。
const XML_DOC = /^(image\/svg\+xml|application\/xml|text\/xml|application\/xhtml\+xml)\b/;
const SDK_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugins', 'sdk');

function serveFile(res, file, { sandbox }) {
  let st;
  try { st = statSync(file); } catch { json(res, 404, { error: 'not found' }); return; }
  if (!st.isFile()) { json(res, 404, { error: 'not found' }); return; }
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const csp = !sandbox ? null : type.startsWith('text/html') ? SANDBOX_CSP : XML_DOC.test(type) ? 'sandbox' : null;
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    ...(csp ? { 'Content-Security-Policy': csp } : {}),
  });
  createReadStream(file).pipe(res);
}
