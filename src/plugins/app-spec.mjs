// 插件应用（主页图标 + 全屏分页）的声明校验：清单 ui.apps（discover.mjs 的 normUi）和 ctx.ui.app（ui.mjs）共用一套。
// 放在单独的纯模块里：discover.mjs 不该为了校验去引 ui.mjs（那边挂着内核与总线），两边各写一份又迟早对不上。
//
// normApp(raw, { dir? }) → { app, fatal, warn }
//   app    规范化结果 { id, title, titleEn?, page, icon: { light, dark } | { name }, who, order }；fatal 时为 null
//   fatal  丢弃 / 抛错的原因（id、标题、page 不合格）：清单里写成 lint 并丢掉这个应用，ctx.ui.app 直接抛
//   warn   不致命的问题（图标文件缺失或超限、titleEn 撞保留名……）：清单里写成 lint，ctx.ui.app 只 ctx.warn
// 路径一律保持 web/… 相对形式（由 /plugins/<id>/web/ 提供）；dir 给了才查图标文件在不在、多大。
//
// 声明式应用（kind: 'view'）。page 与 view 二选一；view 是函数，只有 ctx.ui.app 能登记（normApp 带 allowView），
// 清单是 JSON、写不出函数，清单里没 page 的照旧丢掉。view 型的结果带 kind: 'view'、不带 page；页面型的结果形状不变（不带 kind）。
// 函数本身（view / actions）与初始 state 不进结果——结果是纯数据，由 ui.mjs 挂回登记项上。
// pin: 'sidebar'（Claude 分页侧栏固定入口），清单与 ctx.ui.app 都认；别的值写 warn 并忽略。

import { statSync } from 'node:fs';
import path from 'node:path';

export const MAX_APPS = 8;
export const APP_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const ICON_NAME_RE = /^[a-z][a-z0-9-]{0,23}$/;
const ICON_PATH_RE = /^web\/[^?#]+\.(svg|png|webp)$/i;
const PAGE_RE = /^web\/[^?#]+$/;
const ICON_MAX = 200 * 1024;
const TITLE_MAX = 20;
const TITLE_EN_MAX = 30;
export const FALLBACK_ICON = Object.freeze({ name: 'plugin' });
// 声明式应用的动作名（积木里的 Act 引用的就是它，ui-blocks.mjs 用同一条）
export const ACTION_NAME_RE = /^[a-zA-Z][\w-]{0,40}$/;
export const STATE_MAX = 256 * 1024;
export const PINS = Object.freeze(['sidebar']);

/** JSON 化后的字节数；不能 JSON 化（循环引用、BigInt、顶层是函数 / undefined）回 -1。 */
export function jsonBytes(v) {
  let s;
  try { s = JSON.stringify(v); } catch { return -1; }
  return typeof s === 'string' ? Buffer.byteLength(s) : -1;
}

// 保留名：主页上 bridge 自带的入口与系统词。插件应用不许叫这些，免得用户分不清哪个是真的（也挡住冒充）。
export const RESERVED_TITLES = Object.freeze(['Claude', 'ChatGPT', 'Codex', 'dimensio', 'Media Studio', 'Studio',
  '工作空间', 'Workspace', '设置', 'Settings', '主页', 'Home', '更多', 'More']);
const foldTitle = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
const RESERVED = new Set(RESERVED_TITLES.map(foldTitle));
export const isReservedTitle = (s) => RESERVED.has(foldTitle(s));

const oneLine = (v) => (typeof v === 'string' ? v.replace(/[\r\n]+/g, ' ').trim() : '');
const chars = (s) => [...s].length;   // 按字数算（中文一个字算一个，不按 UTF-16 码元）
const relPath = (v) => (typeof v === 'string' ? v.trim().replace(/\\/g, '/') : '');

// 图标路径：格式对、不越界；有 dir 时文件要在、≤ 200 KB。不合格回原因，合格回 null。
function iconProblem(p, dir) {
  if (!ICON_PATH_RE.test(p) || p.includes('..')) return `图标「${p}」要是插件 web/ 下的 svg / png / webp`;
  if (!dir) return null;
  let st = null;
  try { st = statSync(path.join(dir, ...p.split('/'))); } catch {}
  if (!st || !st.isFile()) return `图标文件 ${p} 不存在`;
  if (st.size > ICON_MAX) return `图标文件 ${p} 超过 200 KB`;
  return null;
}

function normIcon(raw, dir, warn, label) {
  if (raw == null || raw === '') return FALLBACK_ICON;
  if (typeof raw === 'string' && !raw.includes('/')) {
    if (ICON_NAME_RE.test(raw)) return { name: raw };
    warn.push(`${label}的图标名「${raw}」不对（内置图标名只用小写字母、数字、连字符），用了默认图标`);
    return FALLBACK_ICON;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.light == null && raw.dark == null && typeof raw.name === 'string') {
    return normIcon(raw.name, dir, warn, label);
  }
  // 路径：字符串 = 深浅共用；{ light, dark } 只给一个也两边共用
  const pair = typeof raw === 'string' ? { light: raw, dark: raw } : raw && typeof raw === 'object' && !Array.isArray(raw) ? { light: raw.light, dark: raw.dark } : null;
  if (!pair) { warn.push(`${label}的图标写法不认识，用了默认图标`); return FALLBACK_ICON; }
  let light = relPath(pair.light);
  let dark = relPath(pair.dark);
  if (!light && !dark) { warn.push(`${label}的图标没给路径，用了默认图标`); return FALLBACK_ICON; }
  if (!light) light = dark;
  if (!dark) dark = light;
  const why = iconProblem(light, dir) || (dark !== light ? iconProblem(dark, dir) : null);
  if (why) { warn.push(`${label}的${why}，用了默认图标`); return FALLBACK_ICON; }
  return { light, dark };
}

export function normApp(raw, { dir = null, allowView = false } = {}) {
  const warn = [];
  const bad = (fatal) => ({ app: null, fatal, warn });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return bad('应用声明要是一个对象');
  const id = typeof raw.id === 'string' ? raw.id : '';
  if (!APP_ID_RE.test(id)) return bad(`应用 id「${raw.id ?? ''}」不对（小写字母开头，只用小写字母、数字、连字符，≤32 字）`);
  const label = `应用「${id}」`;
  const title = oneLine(raw.title);
  if (!title || chars(title) > TITLE_MAX) return bad(`${label}的标题要 1～${TITLE_MAX} 字`);
  if (isReservedTitle(title)) return bad(`${label}的标题「${title}」和 bridge 自带的入口重名，换一个`);
  // 声明式（view）：只有 ctx.ui.app 能登记；page 与 view 只给一个
  const isView = raw.view != null;
  if (isView) {
    if (!allowView) return bad(`${label}：清单 ui.apps 只能声明页面型应用（写 page）；声明式应用要在 index.mjs 里用 ctx.ui.app 登记 view 函数`);
    if (typeof raw.view !== 'function') return bad(`${label}的 view 要是函数 (who, { state }) => 积木列表`);
    if (raw.page != null && raw.page !== '') return bad(`${label}：page 和 view 只给一个（page = 插件页面，view = bridge 按积木画）`);
    if (raw.actions != null) {
      if (typeof raw.actions !== 'object' || Array.isArray(raw.actions)) return bad(`${label}的 actions 要是 { 动作名: 函数 }`);
      for (const [k, f] of Object.entries(raw.actions)) {
        if (!ACTION_NAME_RE.test(k)) return bad(`${label}的动作名「${k}」不对（字母开头，只用字母、数字、下划线、连字符，≤41 字）`);
        if (typeof f !== 'function') return bad(`${label}的动作「${k}」要是函数 (who, { args, state }) => …`);
      }
    }
    if (raw.state !== undefined) {
      const n = jsonBytes(raw.state);
      if (n < 0) return bad(`${label}的初始 state 要能 JSON 化`);
      if (n > STATE_MAX) return bad(`${label}的初始 state 超过 256 KB（大数据存 ctx.store 或插件数据目录）`);
    }
  } else if (raw.actions != null || raw.state !== undefined) {
    warn.push(`${label}：actions / state 只给声明式应用（有 view 的），页面型应用用不上，忽略`);
  }
  const page = isView ? '' : relPath(raw.page);
  if (!isView && (!PAGE_RE.test(page) || page.includes('..'))) return bad(`${label}的 page 要是插件 web/ 下的页面（如 web/app.html）${allowView ? '，或者给 view 函数做声明式应用' : ''}`);
  let titleEn = oneLine(raw.titleEn);
  if (titleEn && isReservedTitle(titleEn)) { warn.push(`${label}的英文标题「${titleEn}」和 bridge 自带的入口重名，英文界面改用中文标题`); titleEn = ''; }
  if (chars(titleEn) > TITLE_EN_MAX) titleEn = [...titleEn].slice(0, TITLE_EN_MAX).join('');
  if (raw.who != null && raw.who !== 'host' && raw.who !== 'members') warn.push(`${label}的 who 只能是 host / members，按 host 处理`);
  const order = Number(raw.order);
  if (raw.pin != null && !PINS.includes(raw.pin)) warn.push(`${label}的 pin 只认 'sidebar'（固定到 Claude 分页侧栏），忽略`);
  return {
    app: {
      id, title, ...(titleEn ? { titleEn } : {}), ...(isView ? { kind: 'view' } : { page }),
      icon: normIcon(raw.icon, dir, warn, label),
      who: raw.who === 'members' ? 'members' : 'host',
      order: Number.isFinite(order) ? order : 0,
      ...(PINS.includes(raw.pin) ? { pin: raw.pin } : {}),
    },
    fatal: null,
    warn,
  };
}

// 清单 ui.apps → 规范化后的列表；问题写进 lint（丢弃的、重复的、超过 8 个的都说明）。
export function normApps(list, { dir = null, lint = null } = {}) {
  const note = (s) => { if (lint) lint.push(s); };
  if (list == null) return [];
  if (!Array.isArray(list)) { note('ui.apps 应为应用声明的列表'); return []; }
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const r = normApp(raw, { dir });
    for (const w of r.warn) note(w);
    if (!r.app) { note(r.fatal + '，这个应用没登记'); continue; }
    if (seen.has(r.app.id)) { note(`应用 id「${r.app.id}」重复，后面那个没登记`); continue; }
    if (out.length >= MAX_APPS) { note(`一个插件最多 ${MAX_APPS} 个应用，「${r.app.id}」没登记`); continue; }
    seen.add(r.app.id);
    out.push(r.app);
  }
  return out;
}
