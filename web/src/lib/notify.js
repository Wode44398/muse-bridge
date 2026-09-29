// Agent 通知：一轮结束且用户没在看时，用浏览器通知（Notification API，需用户授权）提醒；
// 另外置 ui.taskDone（主页 Claude 入口小人「举旗」），回到对应页即清。
// 均受设置页「通知」开关（bridge-notify）控制。
import { ui } from './state.svelte.js';
import { t } from './i18n.js';

let active = 0;       // 在跑的轮数

function notifOn() { try { return localStorage.getItem('bridge-notify') !== '0'; } catch { return true; } }
const clip = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// 一轮开始。
export function agentStart() {
  active++;
}

// 回复中（保留调用点；网页端没有常驻进度通知可更新）。
export function agentStream() {}

// 一轮结束。每轮只应调用一次（调用方用 m.__notified 去重）。opts: { error, watching }。
export function agentEnd(label, body, opts = {}) {
  const watching = !!opts.watching;
  if (!watching) ui.taskDone = true;                         // 主页小人举旗：有完成未查看
  if (active > 0) active--;
  if (active > 0) return;                                     // 还有别的轮在跑：先不弹完成
  if (watching) return;                                       // 正在看：举旗足够
  if (!document.hidden) return;                               // 前台但在别的页：举旗足够
  if (!notifOn()) return;
  const title = opts.error ? t('{label} · 出错', { label: label || 'Claude' }) : t('{label} · 完成', { label: label || 'Claude' });
  const text = clip(body) || (opts.error ? t('出错了') : t('回复已生成'));
  try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body: text }); } catch {}
}

// 兼容旧调用（等价 Claude 一轮结束）。
export function notifyTaskDone(body) {
  agentEnd('Claude', body, { watching: ui.screen === 'claude' && !document.hidden });
}
