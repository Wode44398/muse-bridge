// 「上次打开的会话」与会话级选择器记忆（model/effort/fast）。

import { session, settings } from '../state.svelte.js';
import { storeSet } from '../store.js';
import { IS_CSNAP } from '../csnap.js';
import { IS_SOLO } from '../solo.js';
import { notePrefs } from '../chatPrefs.js';

// 最近一次打开的会话 id（强持久：apk 杀后台冷启动也能找回）。session.id 的每个赋值点
// 都同步写入；boot 时 restoreOnBoot 用它把上次的对话自动加载回来。
// 快照模式不持久化：访客的快照会话不该污染同浏览器里主 app 的「上次会话」与本地缓存。
// 分屏那一格 / 拖出的独立窗口（?solo=）同理：它们开的会话不是主页面的「上次会话」。
export const LAST_KEY = 'bridge-last-session';
export function rememberSession(id) { if (IS_CSNAP || IS_SOLO) return; try { storeSet(LAST_KEY, id || null); } catch {} }

// —— 会话级选择器记忆（model/effort/fast）————————————————
// 打开会话 → 恢复该会话上次的选择；新对话 → 用最近一次的选择；每次发送/绑定新会话 id
// 时记一笔（本地立即 + 服务端 sidecar 随 /api/chat 落盘）。快照页整套跳过。
export function applyPrefs(p) {
  if (IS_CSNAP) return;
  settings.model = (p && p.model) || null;
  settings.effort = (p && p.effort) || null;
  settings.ultracode = !!(p && p.ultracode);
  settings.fast = !!(p && p.fast);
}
export function notePrefsNow(id) {
  if (IS_CSNAP) return;
  notePrefs(id, { model: settings.model, effort: settings.effort, ultracode: settings.ultracode, fast: settings.fast });
}
// 选择器组件（ModelPicker/EffortPanel）改动时调：当前会话与「新对话默认」都立刻记住，
// 改完没发送就杀后台也不丢。
export function rememberCurrentPrefs() { notePrefsNow(session.id); }
