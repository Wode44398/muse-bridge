import { session } from '../state.svelte.js';
import { IS_CSNAP } from '../csnap.js';

// ---- 新会话首轮的占位（id 还没回来）----------------------------------------------
// 新会话的 id 要等 CLI 起好（init 帧）才有，冷启动要几秒；这段时间侧栏里本来没有它——刚发出去就切走的话，
// 眼里就是「发出去的对话不见了」。发送那一刻先记一条占位（侧栏按它画一行），id 一到就换成真行：
//   · 还看着它：本端 session 帧到 → 摘掉占位（ClaudePage 随即按 session.id 插真行）；
//   · 已经切走：占位留着（mine 清空），等总线 run.start 的 fresh 帧按正文对上再摘（ClaudePage.onSync）；
//   · 一直没等到（发送失败 / 断网）：60 秒自己消失。
export const pendingNew = $state({ list: [], mine: null });   // list: [{ key, text, at, projectId }]
let pendSeq = 0;
export function notePendingNew(text) {
  if (session.id || IS_CSNAP) return;
  const key = 'new:' + (++pendSeq);
  pendingNew.list.push({ key, text, at: Date.now(), projectId: session.projectId || null });
  pendingNew.mine = key;
  setTimeout(() => dropPendingNew(key), 60_000);
}
export function dropPendingNew(key) {
  if (!key) return;
  const i = pendingNew.list.findIndex((p) => p.key === key);
  if (i >= 0) pendingNew.list.splice(i, 1);
  if (pendingNew.mine === key) pendingNew.mine = null;
}
