// 页面权限的授权：page.chat / page.files 要在清单 permissions 里声明，【且】使用者本人同意过才能用。
// 声明是插件作者说「我要」，授权是使用者说「行」——主机装了插件不等于替每个成员同意了用他的身份聊天、读他的文件。
//
//   GET  /api/plugins/grants?plugin=<id>              （bridge 自己的界面，登录即可）→ { declared, granted }
//   POST /api/plugins/grants { plugin, perm, allow }  → { ok: true, granted }
//   GET  /api/plugin/<id>/_bridge/grants              （页面可调，只读）→ { declared, granted }
// 前两条在 /api/plugins/ 下：插件页面经宿主代发或带票据都只放行 /api/plugin/<本插件>/，够不着——页面不能替使用者点「允许」。
//
// 存 plugin-data/<id>/grants.json：{ "<ownerKey>": { "page.chat": "<ISO 时间>", … } }。文件很小，每次现读（插件卸载清了数据目录，
// 授权跟着没了，不留内存里的陈账）；写入先写临时文件再改名。

import crypto from 'node:crypto';
import path from 'node:path';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { kernel } from './state.mjs';
import { PERMISSIONS } from './discover.mjs';
import { busPublish } from '../runtime/bus.mjs';
import { pluginDataDir } from './page-kv.mjs';
import { canUsePluginPages } from './ui.mjs';

export const PAGE_PERMS = Object.freeze(['page.chat', 'page.files']);

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const grantsFile = (pluginId) => path.join(pluginDataDir(pluginId), 'grants.json');

function readAll(pluginId) {
  try {
    const j = JSON.parse(readFileSync(grantsFile(pluginId), 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {};
  } catch { return {}; }
}

function writeAll(pluginId, data) {
  const file = grantsFile(pluginId);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + crypto.randomBytes(6).toString('hex') + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 1));
  try { renameSync(tmp, file); } catch (e) { try { unlinkSync(tmp); } catch {} throw e; }
}

/** 插件清单里声明了的页面权限：[{ id, label }]（只列 page.*；插件不存在 → []）。 */
export function declaredPagePerms(pluginId) {
  const list = kernel.get(String(pluginId || ''))?.extra?.permissions;
  if (!Array.isArray(list)) return [];
  return list.filter((p) => p && PAGE_PERMS.includes(p.id)).map((p) => ({ id: p.id, label: PERMISSIONS[p.id] || p.label || p.id }));
}

export const isDeclared = (pluginId, perm) => declaredPagePerms(pluginId).some((p) => p.id === perm);

/** 这个使用者对这个插件授过的页面权限：{ [perm]: iso }。只算还声明着的（插件升级去掉了声明，旧授权就不作数）。 */
export function grantedOf(pluginId, ownerKey) {
  const mine = readAll(pluginId)[String(ownerKey || '')];
  if (!mine || typeof mine !== 'object') return {};
  const declared = new Set(declaredPagePerms(pluginId).map((p) => p.id));
  return Object.fromEntries(Object.entries(mine).filter(([k, v]) => declared.has(k) && typeof v === 'string'));
}

export const hasGrant = (pluginId, ownerKey, perm) => !!grantedOf(pluginId, ownerKey)[perm];

export function grantsView(pluginId, ownerKey) {
  return { declared: declaredPagePerms(pluginId), granted: grantedOf(pluginId, ownerKey) };
}

/**
 * 「插件页面权限」总览（GET /api/plugins/grants 不带 plugin）：这个身份能管的每个插件一行
 * { plugin, pluginName, declared, granted }。只列开着的、这个身份能用它页面的、声明了页面权限的——
 * 别的列出来也点不了「允许」（setGrant 会拒），反而让成员看见主机没开放给他的插件。按插件名排。
 */
export function grantsList(c) {
  const out = [];
  for (const p of kernel.list()) {
    if (!p || !p.active) continue;
    const declared = declaredPagePerms(p.id);
    if (!declared.length) continue;
    let usable = false;
    try { usable = canUsePluginPages(c, p.id); } catch {}
    if (!usable) continue;
    out.push({ plugin: p.id, pluginName: kernel.get(p.id)?.name || p.name || p.id, declared, granted: grantedOf(p.id, c.key) });
  }
  out.sort((a, b) => String(a.pluginName).localeCompare(String(b.pluginName), 'zh-Hans-CN') || a.plugin.localeCompare(b.plugin));
  return { plugins: out };
}

// 撤销时的连带（文件句柄作废，见 page-files.mjs）。用订阅而不是直接 import，免得两个模块互相引用。
const revokeHooks = new Set();
export function onGrantRevoked(fn) { revokeHooks.add(fn); return () => revokeHooks.delete(fn); }

/**
 * 同意 / 撤销一项页面权限。c = 使用者的身份上下文（ownerKey 取 c.key）。
 * 同意：插件开着、声明了这项权限、这个身份能用它的页面；撤销随时可以（插件停了、卸了也能撤）。
 * 回这个使用者当前的 granted。
 */
export function setGrant(c, pluginId, perm, allow) {
  const id = String(pluginId || '');
  const p = String(perm || '');
  if (!c || (c.kind !== 'admin' && c.kind !== 'user')) throw err(403, '这个身份不能授权插件');
  if (!PAGE_PERMS.includes(p)) throw err(400, `「${p}」不是页面权限（可用：${PAGE_PERMS.join(' / ')}）`);
  if (!kernel.has(id)) throw err(404, '没有这个插件');
  const owner = c.key;
  const all = readAll(id);
  const mine = all[owner] && typeof all[owner] === 'object' ? { ...all[owner] } : {};
  if (allow) {
    if (!kernel.isActive(id)) throw err(409, '插件没开着');
    if (!isDeclared(id, p)) throw err(400, `插件没有声明「${p}」权限`);
    if (!canUsePluginPages(c, id)) throw err(403, '你用不了这个插件的页面');
    if (!mine[p]) { mine[p] = new Date().toISOString(); all[owner] = mine; writeAll(id, all); }
  } else if (mine[p]) {
    delete mine[p];
    if (Object.keys(mine).length) all[owner] = mine; else delete all[owner];
    writeAll(id, all);
    for (const fn of revokeHooks) { try { fn(id, owner, p); } catch {} }
  } else {
    // 没授过也照样通知连带方：句柄之类按「此刻没有授权」收拾干净（幂等）
    for (const fn of revokeHooks) { try { fn(id, owner, p); } catch {} }
  }
  try { busPublish(owner, { type: 'plugins.grants', plugin: id }); } catch {}
  return grantedOf(id, owner);
}

/**
 * 页面能力的门：声明并授权过 perm。声明了没同意 → 403 { needGrant }（SDK 据此先弹授权框）；
 * 根本没声明 → 403 { undeclared, perm }，故意不带 needGrant：这时弹授权框是白弹，使用者点了「允许」授权接口也会因为没声明拒掉。
 */
export function requireGrant(pluginId, ownerKey, perm) {
  if (!isDeclared(pluginId, perm)) throw err(403, `插件没有声明「${perm}」权限，用不了这个功能`, { undeclared: true, perm });
  if (!hasGrant(pluginId, ownerKey, perm)) throw err(403, `要你先同意「${PERMISSIONS[perm] || perm}」`, { needGrant: perm });
}
