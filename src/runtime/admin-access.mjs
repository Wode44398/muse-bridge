// 管理员能看到成员的什么（开源路线 S2-7；维护者 2026-10-22 定的 N13「管理员默认只看元数据」）。
//
// 默认：管理员在控制台只看得到成员的元数据——会话标题与时间、定时任务的名字与时间、用量、在线状态。
// 下面三件事要成员自己在设置里允许，每次发生都记一笔、成员在自己的设置里看得到：
//   view    查看对话内容（Claude 会话正文、Gemini 对话、生成的媒体、定时任务的提示词与结果预览、在跑那一轮的提问原文）
//   assist  代他发消息、代他回答提问与审批卡（控制台「会话」页的代聊；代发的消息在他那边标「管理员代发」）。
//           接着代聊他已有的会话还要 view（回复带着那段对话的上下文，等于读了它）；从头到尾都是管理员代发的会话除外。
//   device  查看他的电脑：控制台对他的设备截屏 / 读系统信息 / 派操作（桌面客户端登录即登记的那台）
// 服务账号（QQ 机器人这类管理员自己的程序）没有真人替它表态，默认三项全开；管理员登进它的账号也能关。
// 管理员自己（主机身份）的会话、媒体不经过这里，照旧。
//
// 这层管的是「控制台默认怎么做、做了留不留痕」，不是系统级隔离：服主管理着这台服务器，技术上仍能读到磁盘上的任何文件
// （设置页的说明如实写了这一点）。审计另有一份管理员侧的（runtime/audit-log.mjs），这里是成员侧看得见的那份。
//
// 存 _system/admin-access.json（服务进程独占，不在任何人的工作空间里）：
//   { consents: { <账号 id>: { view, assist, device, at } }, log: { <账号 id>: [{ at, action, what?, detail?, count? }] } }
//   count：连续操作合并后的次数（没有 = 1 次），at 是最后一次的时间。

import path from 'node:path';
import { SYSTEM_DIR } from '../config/index.mjs';
import { readJson, writeJson } from '../jsonfile.mjs';
import { getUser, getUserById, accountId } from '../users.mjs';
import { ownerKey, parseOwnerKey } from './principal.mjs';
import { busPublish } from './bus.mjs';

const FILE = path.join(SYSTEM_DIR, 'admin-access.json');
export const ACCESS_KINDS = Object.freeze(['view', 'assist', 'device']);
const LOG_MAX = 200;
// 连续操作合并成一条（设备上连着截屏、点击几十步；排障时反复刷同一段对话）：同一个动作、同一个对象，
// 离上一次不到这么久就只给上一条加次数、更新时间，不另记、也不再推提示——访问记录不被刷满，成员那边也不连弹。
const MERGE_MS = 60 * 1000;

/** 代聊时写在消息开头的标记：成员在自己的会话里看得见这条是管理员代发的。 */
export const PROXY_PREFIX = '【管理员代发】';
/**
 * 一段对话（[{ role, text }]，Claude 的历史与 Gemini 的对话都是这个形状）是不是从头到尾都是管理员代发的：
 * 成员自己没在里面说过话，接着代聊不会读到他的内容。空的、认不出的一律按「不是」。
 */
export function proxyOnlyConversation(messages) {
  const said = (Array.isArray(messages) ? messages : []).filter((m) => m && m.role === 'user');
  return said.length > 0 && said.every((m) => String(m.text || '').trimStart().startsWith(PROXY_PREFIX));
}

// 给人看的动作名（成员设置里的访问记录、拒绝时的报错都用它）
export const ACTION_LABEL = Object.freeze({
  view_session: '查看了你的一段 Claude 对话',
  view_media: '查看了你生成的媒体',
  view_gemini: '查看了你的一段 Gemini 对话',
  view_routines: '查看了你的定时任务内容',
  chat: '以管理员身份在你的空间里代发了一条消息',
  answer: '替你回答了一个提问或审批',
  device: '查看或操作了你的电脑',
});
const KIND_DENIED = Object.freeze({
  view: '这个成员没有允许管理员查看对话内容（成员在自己的「设置 › 账户 › 管理员可见性」里打开后才能看）。',
  assist: '这个成员没有允许管理员代聊或代答（成员在自己的「设置 › 账户 › 管理员可见性」里打开后才能用）。',
  device: '这个成员没有允许管理员查看他的电脑（成员在自己的「设置 › 账户 › 管理员可见性」里打开后才能截屏或派操作）。',
  // 只开了「协助」、要接着聊他自己说过话的会话（routes/admin.mjs 代聊）
  continue: '这个成员没有允许管理员查看对话内容，接着聊他的会话会读到里面的内容。可以接着聊你代发开的会话，或开新会话。',
});
export const deniedMessage = (kind) => KIND_DENIED[kind] || '这个成员没有允许这项操作。';

function load() {
  const d = readJson(FILE, {});
  return {
    consents: d && typeof d.consents === 'object' && d.consents ? d.consents : {},
    log: d && typeof d.log === 'object' && d.log ? d.log : {},
  };
}
function save(d) { writeJson(FILE, d, 2); }

// 登录名 / 账号 id / owner 键（'u:<id>'）→ 账号记录
function recordOf(ref) {
  const s = String(ref || '');
  if (!s) return null;
  const p = s.includes(':') ? parseOwnerKey(s) : null;
  if (p) return p.kind === 'user' ? (getUserById(p.id) || getUser(p.id)) : null;
  return getUser(s) || getUserById(s);
}

/** 这个成员现在允许了什么：{ view, assist, device, at, service }。不存在的账号三项都是 false。 */
export function consentsOf(ref) {
  const rec = recordOf(ref);
  if (!rec) return { view: false, assist: false, device: false, at: 0, service: false };
  const service = rec.service === true;
  const c = load().consents[accountId(rec)] || {};
  const out = Object.fromEntries(ACCESS_KINDS.map((k) => [k, typeof c[k] === 'boolean' ? c[k] : service]));
  return { ...out, at: Number(c.at) || 0, service };
}

/** 管理员对这个成员做 kind 这件事是否已获允许。 */
export function accessAllowed(ref, kind) {
  if (!ACCESS_KINDS.includes(kind)) return false;
  return consentsOf(ref)[kind] === true;
}

/** 成员自己改（只收三项布尔值）。返回新状态。 */
export function setConsents(ref, patch = {}) {
  const rec = recordOf(ref);
  if (!rec) return { error: '账号不存在' };
  const id = accountId(rec);
  const d = load();
  const cur = { ...(d.consents[id] || {}) };
  let changed = false;
  for (const k of ACCESS_KINDS) if (typeof patch[k] === 'boolean' && cur[k] !== patch[k]) { cur[k] = patch[k]; changed = true; }
  if (changed) {
    cur.at = Date.now();
    d.consents[id] = cur;
    save(d);
  }
  return { ok: true, consents: consentsOf(id) };
}

/**
 * 记一笔管理员对这个成员做的事，并推给他在线的客户端（当场弹提示、设置页的访问记录刷新）。
 * action ∈ ACTION_LABEL 的键；what / detail 只放元数据（会话 id、设备名、动作名），不放内容。
 * 一分钟内同一个动作、同一个对象的连续操作合并进上一条（count 加一、at 更新成这一次），不推送（见 MERGE_MS）。
 */
export function logAccess(ref, { action, what = '', detail = '' } = {}, now = Date.now()) {
  const rec = recordOf(ref);
  if (!rec || !action) return;
  const id = accountId(rec);
  try {
    const d = load();
    const list = Array.isArray(d.log[id]) ? d.log[id] : [];
    const e = { at: now, action: String(action).slice(0, 40), ...(what ? { what: String(what).slice(0, 120) } : {}), ...(detail ? { detail: String(detail).slice(0, 160) } : {}) };
    const last = list[list.length - 1];
    if (last && last.action === e.action && (last.what || '') === (e.what || '') && now - (Number(last.at) || 0) >= 0 && now - (Number(last.at) || 0) < MERGE_MS) {
      last.count = (Number(last.count) || 1) + 1;
      last.at = now;
      if (e.detail) last.detail = e.detail; else delete last.detail;
      d.log[id] = list;
      save(d);
      return;
    }
    list.push(e);
    d.log[id] = list.slice(-LOG_MAX);
    save(d);
    busPublish(ownerKey('user', id), { type: 'admin.access', entry: { ...e, label: ACTION_LABEL[e.action] || e.action } });
  } catch (err) { console.error('[admin-access] 记录失败：', (err && err.message) || err); }
}

/** 这个成员的访问记录（新的在前）。 */
export function accessLog(ref, limit = 50) {
  const rec = recordOf(ref);
  if (!rec) return [];
  const list = load().log[accountId(rec)];
  if (!Array.isArray(list)) return [];
  return list.slice(-Math.max(1, Math.min(LOG_MAX, limit))).reverse().map((e) => ({ ...e, label: ACTION_LABEL[e.action] || e.action }));
}

/**
 * 删号时摘掉这个账号 id 的允许与访问记录（runtime/account-lifecycle.mjs 调）。id 永不复用，留着无害，只是残留。
 * 账号行此时已经删了，所以这里直接按 id 认，不经 recordOf。返回有没有摘到东西。
 */
export function dropAccessOf(id) {
  const k = String(id || '');
  if (!k) return false;
  const d = load();
  let hit = false;
  for (const part of ['consents', 'log']) {
    if (Object.hasOwn(d[part], k)) { delete d[part][k]; hit = true; }
  }
  if (hit) save(d);
  return hit;
}

/** 管理员要对 owner 键（'u:<id>' / 'admin' / 快照……）做 kind：主机自己的、快照桶等非成员一律放行；成员看他的允许。 */
export function ownerAllows(ownerKeyStr, kind) {
  const p = parseOwnerKey(ownerKeyStr);
  if (!p || p.kind !== 'user') return true;
  return accessAllowed(p.id, kind);
}
