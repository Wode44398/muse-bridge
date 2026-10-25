// Agent 通知：一轮结束且用户没在看时，用浏览器通知（Notification API，需用户授权）提醒；
// 另外置 ui.taskDone（主页 Claude 入口小人「举旗」），回到对应页即清。
// 均受设置页「通知」开关（bridge-notify）控制。网页通知只在页面不在前台时弹（Notification API，需用户授权）。
//
// 分类型开关（2026-10-20，官方 Desktop「Notifications」：Permission requests / Questions / Task complete）：
// 设置 › Claude › 通知 的三个本机开关（cs.device.notifyPermission / notifyQuestion / notifyTaskComplete），
// 都依赖上面的总开关。统一入口 notifyKind(kind, {…})：
//   notifyKind('permission', { title, body, watching, tag })   ← 权限请求（工具审批卡那一路在收到 permission 事件时调）
//   notifyKind('question',   { title, body, watching, tag })   ← Claude 提问（chat 内核收到 question 事件时调）
//   notifyKind('done', …)                                       ← 任务完成（agentEnd 内部已按这个类型门控，一般不用直接调）
// watching = 用户正看着这个会话（在 Claude 页、页面可见）→ 不弹；页面在前台也不弹（同 agentEnd：卡片 / 举旗足够）。
// tag = 去重键（qid / 权限请求 id）：断线重连重放同一个事件不重复弹。返回是否真的弹了。
import { ui } from './state.svelte.js';
import { t } from './i18n.js';
import { cs } from './claudeSettings.svelte.js';

let active = 0;       // 在跑的轮数

function notifOn() { try { return localStorage.getItem('bridge-notify') !== '0'; } catch { return true; } }
const KIND_KEY = { permission: 'notifyPermission', question: 'notifyQuestion', done: 'notifyTaskComplete' };
// 总开关开着、且这一类没被单独关掉
function kindOn(kind) { const k = KIND_KEY[kind]; return notifOn() && (!k || cs.device?.[k] !== false); }
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
  if (!kindOn('done')) return;
  const title = opts.error ? t('{label} · 出错', { label: label || 'Claude' }) : t('{label} · 完成', { label: label || 'Claude' });
  const text = clip(body) || (opts.error ? t('出错了') : t('回复已生成'));
  try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body: text }); } catch {}
}

// 分类型通知的统一入口（用法见文件头）。
const shownTags = new Set();
export function notifyKind(kind, { title = '', body = '', watching = false, tag = '' } = {}) {
  if (!kindOn(kind)) return false;
  if (watching) return false;
  if (typeof document !== 'undefined' && !document.hidden) return false;
  if (tag) {
    const k = kind + ':' + tag;
    if (shownTags.has(k)) return false;
    shownTags.add(k);
    if (shownTags.size > 200) shownTags.delete(shownTags.values().next().value);
  }
  const head = title || (kind === 'permission' ? t('Claude 需要你批准') : kind === 'question' ? t('Claude 在等你回答') : t('{label} · 完成', { label: 'Claude' }));
  const text = clip(body) || (kind === 'permission' ? t('有一个操作在等你批准') : kind === 'question' ? t('有一个问题在等你选择') : t('回复已生成'));
  try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') { new Notification(head, { body: text, tag: tag || undefined }); return true; } } catch {}
  return false;
}

// 兼容旧调用（等价 Claude 一轮结束）。
export function notifyTaskDone(body) {
  agentEnd('Claude', body, { watching: ui.screen === 'claude' && !document.hidden });
}
