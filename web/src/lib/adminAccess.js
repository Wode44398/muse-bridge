// 成员的「管理员可见性」：服主默认只看得到会话标题、时间和用量；看对话内容、代聊代答要成员自己在设置里允许，每次都留记录。
// 界面在设置 › 账户（components/settings/SecAdminAccess.svelte）。后端 src/routes/admin-access.mjs、src/runtime/admin-access.mjs。
import { api } from './api.js';
import { t } from './i18n.js';
import { busOn } from './bus.js';

/** { consents:{view,assist}, at, service, log:[{at,action,label,what,detail}] }；管理员回 { admin:true } */
export const fetchAdminAccess = () => api.get('/api/me/admin-access');

/** patch = { view?, assist? }（布尔）。成功回 { ok, consents, at }。 */
export const saveAdminAccess = (patch) => api.post('/api/me/admin-access', patch);

/** 两项开关：键、标题、说明。 */
export function accessItems() {
  return [
    { key: 'view', title: t('允许查看对话内容'), sub: t('Claude 的对话正文、定时任务的提示词和结果') },
    { key: 'assist', title: t('允许代聊与代答'), sub: t('管理员可以在你的空间里代你发消息、替你回答提问和审批；代发的消息开头标着「【管理员代发】」。接着聊你自己的会话，还要你允许查看对话内容') },
  ];
}

/** 设置页顶部的公示文字。 */
export const accessDisclosure = () => t('服主（管理员）默认只能看到你的会话标题、时间和用量。下面两项由你决定；管理员每次查看或代你操作，都会记在最下面。服主管理着这台服务器，技术上仍能读到服务器上的文件——这里约束的是控制台的默认行为。');

// 访问记录的动作名（服务端也带了中文 label；这里按 action 再翻一次，界面切英文时用）
const ACTION = () => ({
  view_session: t('查看了你的一段 Claude 对话'),
  view_routines: t('查看了你的定时任务内容'),
  chat: t('以管理员身份在你的空间里代发了一条消息'),
  answer: t('替你回答了一个提问或审批'),
});
export function logLine(e) {
  const label = ACTION()[e.action] || e.label || e.action;
  const line = e.what ? `${label} · ${e.what}` : label;
  // 一分钟内连续的同一操作服务端合成一条（count；时间是最后一次）
  return Number(e.count) > 1 ? `${line} · ${t('连续 {n} 次', { n: Number(e.count) })}` : line;
}

/** 管理员刚做了什么（总线 admin.access 的 entry）→ 一句给成员看的提示。 */
export function adminAccessNotice(entry) {
  if (!entry || !entry.action) return '';
  return t('管理员刚刚{what}。可在设置 › 账户 › 管理员的访问记录里查看。', { what: ACTION()[entry.action] || entry.label || entry.action });
}

// 管理员每次查看 / 代操作，服务端经总线推 admin.access（只推给被看的那个成员）：当场弹一句提示——成员界面上的可见提示，
// 不用等他自己去翻设置。两套设置外壳的访问记录用 onAdminAccess 跟着刷新。本模块由设置页静态 import，App 启动即挂上。
const accessListeners = new Set();
/** 订阅「管理员刚做了什么」；返回取消订阅（可直接当 $effect 的清理函数）。 */
export function onAdminAccess(fn) { accessListeners.add(fn); return () => { accessListeners.delete(fn); }; }
busOn((ev) => {
  if (!ev || ev.type !== 'admin.access') return;
  const text = adminAccessNotice(ev.entry);
  if (text) import('./toast.svelte.js').then((m) => m.showToast(text)).catch(() => {});
  for (const fn of accessListeners) { try { fn(ev.entry); } catch { /* 订阅方自己的错不影响提示 */ } }
});
