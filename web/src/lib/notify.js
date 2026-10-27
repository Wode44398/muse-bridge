// Agent 通知（进程快照 + 完成提醒）。两条路径：
//   · Claude：有原生前台服务（apk 新版）时交给它——AndroidStore.startAgentWatch 让原生
//     Service 自连 PC 轮询 /api/active，App 退后台/锁屏/活动被杀也能显示「处理中」并在
//     跑完弹「完成」。前台收尾用 stopAgentWatch（不重复弹）。无原生服务（浏览器/旧壳）
//     时回落到下面的 JS 路径（前台尽力而为）。
//   · 回落：纯 JS——开始/回复中更新静默常驻通知，结束在没看时弹完成。
// 另外：主页 claude 入口小人「举旗」（ui.taskDone），回到对应页即清。
// 均受设置页「通知」开关（bridge-notify）控制。
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

let active = 0;       // JS 路径在跑的轮数（浏览器 Claude；原生 Claude 不计入）
let lastProg = 0;     // JS 进度更新节流时间戳

const A = () => { try { return window.AndroidStore; } catch { return null; } };
const nativeWatch = () => { const a = A(); return a && a.startAgentWatch ? a : null; };
function notifOn() { try { return localStorage.getItem('bridge-notify') !== '0'; } catch { return true; } }
const KIND_KEY = { permission: 'notifyPermission', question: 'notifyQuestion', done: 'notifyTaskComplete' };
// 总开关开着、且这一类没被单独关掉
function kindOn(kind) { const k = KIND_KEY[kind]; return notifOn() && (!k || cs.device?.[k] !== false); }
const clip = (s, n = 80) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, n);

// 一轮开始。
export function agentStart(label) {
  // Claude + 原生前台服务：交给 Service（后台可靠）。通知关了就不启服务。
  if (label === 'Claude') {
    const a = nativeWatch();
    // 原生服务的主要用途是后台弹「完成」：任务完成这一类关了就不起它
    if (a) { if (kindOn('done')) { try { a.startAgentWatch(); } catch {} } return; }
  }
  active++;
  if (!notifOn()) return;
  const a = A();
  if (a && a.agentProgress) { try { a.agentProgress(t('{label} · 处理中', { label: label || 'Claude' }), t('正在处理…')); } catch {} }
}

// 回复中：节流更新快照（仅 JS 路径；原生 Claude 由 Service 自己更新）。
export function agentStream(label, snippet) {
  if (label === 'Claude' && nativeWatch()) return;
  if (!active || !notifOn()) return;
  const now = Date.now();
  if (now - lastProg < 1200) return;
  lastProg = now;
  const a = A();
  if (a && a.agentProgress) { try { a.agentProgress(t('{label} · 回复中', { label: label || 'Claude' }), clip(snippet) || t('正在回复…')); } catch {} }
}

// 一轮结束。每轮只应调用一次（调用方用 m.__notified 去重）。opts: { error, watching }。
export function agentEnd(label, body, opts = {}) {
  const watching = !!opts.watching;
  if (!watching) ui.taskDone = true;                         // 主页小人举旗：有完成未查看
  // Claude + 原生服务：前台收尾就停服（不重复弹完成）；后台时 JS 已冻结、走不到这里，
  // 由 Service 自己的轮询发现完成并弹通知。
  if (label === 'Claude') {
    const a = nativeWatch();
    if (a) { try { a.stopAgentWatch(); } catch {} return; }
  }
  if (active > 0) active--;
  const a = A();
  if (active <= 0 && a && a.agentClear) { try { a.agentClear(); } catch {} }   // 没别的 JS 轮了 → 收掉快照
  if (active > 0) return;                                     // 还有别的轮在跑：先不弹完成
  if (watching) return;                                       // 正在看：举旗足够
  if (!document.hidden) return;                               // 前台但在别的页：举旗足够
  if (!kindOn('done')) return;
  const title = opts.error ? t('{label} · 出错', { label: label || 'Claude' }) : t('{label} · 完成', { label: label || 'Claude' });
  const text = clip(body) || (opts.error ? t('出错了') : t('回复已生成'));
  if (a && a.agentDone) { try { a.agentDone(title, text); return; } catch {} }
  if (a && a.showNotification) { try { a.showNotification(title, text); return; } catch {} }
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
  const a = A();
  if (a && a.showNotification) { try { a.showNotification(head, text); return true; } catch {} }
  try { if (typeof Notification !== 'undefined' && Notification.permission === 'granted') { new Notification(head, { body: text, tag: tag || undefined }); return true; } } catch {}
  return false;
}

// 兼容旧调用（等价 Claude 一轮结束）。
export function notifyTaskDone(body) {
  agentEnd('Claude', body, { watching: ui.screen === 'claude' && !document.hidden });
}
