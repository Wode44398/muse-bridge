// Media Studio 设置的服务端存储与判定（注册表见 src/config/studio-settings.mjs）。
//
// 主机级：config.json 的 studioHost 键，只存与默认不同的显式值。「让别的 agent 生成」「agent 能生成什么」「内容安全过滤」三组
//   2026-11-04 以前存在 vertexHost（Gemini 设置页）：config 里还没有 studioHost 键时，读的是 vertexHost 里的老值（照抄），
//   第一次写入就落到 studioHost；vertexHost 里的老值不删（回滚旧版时设置还在）。Gemini 对话同日下线，安全设置只剩 Studio 在用。
// 个人级：<数据根>/studio-providers/settings.json（主机管理员）、studio-providers/users/<账号>/settings.json（成员），
//   只存默认模型、自动保存、保存位置；读取时压过主机值。
//
// 判定都在这里，各调用处只问一句：
//   agentMediaDeny(caller, kind)  这个调用方能不能生成这种媒体（Claude 的媒体工具、agent 接口的 media.* 操作）
//   capVideoResolution(res)       agent 要的视频分辨率按上限降档
// 你在 Media Studio 里手动生成不过这里——那条路只受 studio 开关、按人授权和成员额度管。

import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { CONFIG_PATH } from '../config/index.mjs';
import { DATA_ROOT } from './paths.mjs';
import { readJson, writeJson } from '../jsonfile.mjs';
import { HOST_OWNER, parseOwnerKey } from './principal.mjs';
import {
  STUDIO_SETTINGS, STUDIO_SETTING_BY_KEY, STUDIO_PERSONAL_KEYS, STUDIO_MIGRATED_KEYS, STUDIO_KINDS,
  studioSettingDefaults, normalizeStudioSetting, sameStudioValue, STUDIO_KIND_KEY, STUDIO_CALLER_KEY, SAFETY_THRESHOLD, SAFETY_CATEGORY,
} from '../config/studio-settings.mjs';

// —— 存储目录（服务注册表、密钥、个人设置、任务记录都按 owner 一份；同 claude-providers 的布局）——
export const STUDIO_DIR = path.join(DATA_ROOT, 'studio-providers');
/** owner 键 → 目录：主机 = studio-providers/，成员 = studio-providers/users/<账号 id>/（id 不安全时取哈希）。 */
export function studioOwnerDir(owner) {
  owner = owner || HOST_OWNER;
  if (owner === HOST_OWNER) return STUDIO_DIR;
  const p = parseOwnerKey(owner);
  if (!p || p.kind !== 'user' || !p.id) throw new Error('Media Studio 只认主机管理员与成员账号');
  const id = /^[A-Za-z0-9_-]{1,64}$/.test(p.id) ? p.id : 'h-' + createHash('sha256').update(p.id).digest('hex').slice(0, 24);
  return path.join(STUDIO_DIR, 'users', id);
}

const readConfig = () => JSON.parse(readFileSync(CONFIG_PATH, 'utf8').replace(/^﻿/, ''));

// —— 主机级 ——
let host = null;   // studioHost 的显式值（内存为准）
function loadHost() {
  if (host) return host;
  host = {};
  let raw = {};
  try { raw = readConfig(); } catch {}
  // 还没有 studioHost：照抄 vertexHost 里迁来的那两组老值
  const src = raw.studioHost && typeof raw.studioHost === 'object'
    ? raw.studioHost
    : Object.fromEntries(Object.entries(raw.vertexHost && typeof raw.vertexHost === 'object' ? raw.vertexHost : {}).filter(([k]) => STUDIO_MIGRATED_KEYS.includes(k)));
  for (const [k, v] of Object.entries(src)) {
    const n = normalizeStudioSetting(k, v);
    if (n.ok) host[k] = n.value;
  }
  return host;
}
/** 主机级完整取值：默认 ⊕ 显式值。 */
export function getStudioHostSettings() { return { ...studioSettingDefaults(), ...loadHost() }; }
/** 主机级快照：values + 改过的键。 */
export function studioHostSnapshot() {
  return { values: getStudioHostSettings(), changed: Object.keys(loadHost()) };
}

const listeners = new Set();
/** 设置变了：fn({ scope, owner })。路由层据此推总线、Claude 的提示从下一条消息换新。 */
export function onStudioSettingsChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
const changed = (scope, owner) => { for (const fn of listeners) { try { fn({ scope, owner }); } catch {} } };

/** patch = { key: 值 | null }，null = 恢复默认。任一项不合法整批不改：{ ok:false, error }。 */
export function setStudioHostSettings(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: '参数应为 { 设置项: 值 }' };
  const next = { ...loadHost() };
  for (const [k, v] of Object.entries(patch)) {
    const def = STUDIO_SETTING_BY_KEY[k];
    if (!def) return { ok: false, error: '未知设置项：' + k };
    if (v === null) { delete next[k]; continue; }
    const n = normalizeStudioSetting(k, v);
    if (!n.ok) return { ok: false, error: n.error };
    if (sameStudioValue(n.value, def.type === 'defaults' ? {} : def.default)) delete next[k];
    else next[k] = n.value;
  }
  let raw;
  try { raw = readConfig(); } catch (e) { return { ok: false, error: '读不了 config.json：' + ((e && e.message) || e) }; }
  raw.studioHost = next;   // 空对象也写：有这个键就不再从 vertexHost 照抄
  try { writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2), { mode: 0o600 }); } catch (e) { return { ok: false, error: '保存失败：' + ((e && e.message) || e) }; }
  host = next;
  changed('host', HOST_OWNER);
  return { ok: true, ...studioHostSnapshot() };
}

// —— 个人级 ——
const personal = new Map();   // owner → 显式值
function loadMine(owner) {
  owner = owner || HOST_OWNER;
  if (personal.has(owner)) return personal.get(owner);
  const raw = readJson(path.join(studioOwnerDir(owner), 'settings.json'), {});
  const out = {};
  for (const k of STUDIO_PERSONAL_KEYS) {
    if (!(k in raw)) continue;
    const n = normalizeStudioSetting(k, raw[k]);
    if (n.ok) out[k] = n.value;
  }
  personal.set(owner, out);
  return out;
}
export function studioMineSnapshot(owner) {
  const mine = loadMine(owner);
  const base = getStudioHostSettings();
  const values = Object.fromEntries(STUDIO_PERSONAL_KEYS.map((k) => [k, k in mine ? mine[k] : base[k]]));
  return { values, changed: Object.keys(mine) };
}
export function setStudioMineSettings(owner, patch) {
  owner = owner || HOST_OWNER;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return { ok: false, error: '参数应为 { 设置项: 值 }' };
  const next = { ...loadMine(owner) };
  for (const [k, v] of Object.entries(patch)) {
    if (!STUDIO_PERSONAL_KEYS.includes(k)) return { ok: false, error: STUDIO_SETTING_BY_KEY[k] ? STUDIO_SETTING_BY_KEY[k].label + '只有管理员能改' : '未知设置项：' + k };
    if (v === null) { delete next[k]; continue; }
    const n = normalizeStudioSetting(k, v);
    if (!n.ok) return { ok: false, error: n.error };
    next[k] = n.value;
  }
  try { writeJson(path.join(studioOwnerDir(owner), 'settings.json'), next, 2); } catch (e) { return { ok: false, error: '保存失败：' + ((e && e.message) || e) }; }
  personal.set(owner, next);
  changed('mine', owner);
  return { ok: true, ...studioMineSnapshot(owner) };
}

/** 这个人实际生效的设置：主机值 ⊕ 个人值（默认模型按种类合并：个人选了哪种就用他的，没选的跟主机）。 */
export function effectiveStudioSettings(owner) {
  const h = getStudioHostSettings();
  const mine = loadMine(owner);
  const out = { ...h };
  for (const k of STUDIO_PERSONAL_KEYS) {
    if (!(k in mine)) continue;
    out[k] = k === 'defaults' ? { ...(h.defaults || {}), ...mine.defaults } : mine[k];
  }
  return out;
}

// —— 判定 ——
// 拼进「没让…生成媒体」：西文名两边带空格，「外部 agent」只在后面带
const CALLER_NAME = { claude: ' Claude ', dimensio: ' dimensio ', codex: ' Codex ', api: '外部 agent ' };
const KIND_NAME = { image: '图片', speech: '语音', music: '音乐', video: '视频' };

/**
 * 这个调用方能不能生成这种媒体：null = 能；否则一句原因。
 * caller：'claude' | 'dimensio' | 'codex' | 'api'；不认识的同机实例一律不给。
 */
export function agentMediaDeny(caller, kind) {
  const v = getStudioHostSettings();
  const ck = STUDIO_CALLER_KEY[caller];
  if (!ck) return '这个调用方不能生成媒体';
  if (!v[ck]) return `管理员没让${CALLER_NAME[caller]}生成媒体（设置 › Media Studio）`;
  const kk = STUDIO_KIND_KEY[kind];
  if (kk && !v[kk]) return `管理员关掉了 agent 生成${KIND_NAME[kind]}（设置 › Media Studio）`;
  return null;
}

const RES_ORDER = ['360p', '720p', '1080p', '4k'];
/** agent 要的视频分辨率按上限降档（没给 / 不认识的原样返回，交给驱动按模型夹紧）。 */
export function capVideoResolution(res) {
  const cap = getStudioHostSettings().agentVideoMaxRes;
  const r = String(res || '').toLowerCase();
  const i = RES_ORDER.indexOf(r), c = RES_ORDER.indexOf(cap);
  if (i < 0 || c < 0) return res;
  return i > c ? cap : r;
}
/** 上限这一档（给工具说明用）。 */
export const videoResolutionCap = () => getStudioHostSettings().agentVideoMaxRes;

/** Google generateContent 的 safetySettings（Nano Banana）；四类都是「Google 默认」时返回 undefined（不带这个键）。 */
export function studioSafetySettings() {
  const v = getStudioHostSettings();
  const out = [];
  for (const [key, category] of Object.entries(SAFETY_CATEGORY)) {
    const th = SAFETY_THRESHOLD[v[key]];
    if (th) out.push({ category, threshold: th });
  }
  return out.length ? out : undefined;
}

// 被 Google 的安全过滤拦下时给人看的一句话。finishReason / promptFeedback.blockReason 认得的几种。
const BLOCK_REASONS = new Set(['SAFETY', 'PROHIBITED_CONTENT', 'BLOCKLIST', 'SPII', 'IMAGE_SAFETY', 'IMAGE_PROHIBITED_CONTENT', 'OTHER_BLOCKED']);
export function safetyBlockNote(reason) {
  if (!reason || !BLOCK_REASONS.has(String(reason))) return '';
  return `被 Google 的内容安全过滤拦下了（${reason}）。换个说法再试；管理员可以在 设置 › Media Studio › 内容安全过滤 里调整。`;
}

export { STUDIO_KINDS };
export function _resetStudioSettingsForTests() { host = null; personal.clear(); }
