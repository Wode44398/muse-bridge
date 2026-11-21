// Antigravity 分页里「只动状态、不碰直播流」的那几件事：哪些会话在等你、排队消息的撤回与立即发送、这个会话连哪台电脑。
// 和 workspace-actions.js 一样从 store 取 agy，store 再把这里的函数转出去（流的收发、视图代号留在 store）。

import { api } from '../api.js';
import { showToast } from '../toast.svelte.js';
import { t, tr } from '../i18n.js';
import { agyArtifactUrl } from '../preview.svelte.js';
import { mergeReturned } from './persist.js';
import { agy } from './store.svelte.js';

// —— 在跑 / 在等你 ——
// 在跑的会话与各自在等什么（快照：/api/agy/active 的 activeSessions、总线 hello 的 ext）
export function applyLiveSnapshot(runs) {
  const ids = [];
  const pend = {};
  for (const r of Array.isArray(runs) ? runs : []) {
    if (!r || !r.sessionId) continue;
    ids.push(r.sessionId);
    if (r.pending) pend[r.sessionId] = r.pending;
  }
  // 自己刚发出去、服务端还没来得及登记的那一轮别被快照抹掉
  if (agy.busy && agy.sessionId && !ids.includes(agy.sessionId)) ids.push(agy.sessionId);
  agy.activeSessionIds = ids;
  agy.pendingSessions = pend;
}
export function setSessionPending(sid, kind) {
  if (!sid) return;
  const cur = agy.pendingSessions[sid] || '';
  if (cur === (kind || '')) return;
  const next = { ...agy.pendingSessions };
  if (kind) next[sid] = kind; else delete next[sid];
  agy.pendingSessions = next;
}

// —— 排队消息 ——
// 被退回的几条（人按了停止、这一轮出错、或自己撤回）并回输入框，改改再发
export function returnQueuedToDraft(items) {
  const merged = mergeReturned(agy.draftText, agy.draftAtts, items);
  agy.draftText = merged.text;
  agy.draftAtts = merged.atts.map((a) => (a.url !== undefined ? a : {
    ...a, pending: false, url: a.kind === 'image' ? agyArtifactUrl('', a.path, { name: a.name }) : '',
  }));
}

// 撤回一条排队消息：放回输入框
export async function removeAgyQueued(id) {
  const sid = agy.sessionId;
  if (!sid || !id) return;
  try {
    const res = await api.post('/api/agy/queue/remove', { sessionId: sid, id });
    if (agy.sessionId !== sid) return;
    agy.queue = Array.isArray(res?.queue) ? res.queue : agy.queue.filter((x) => x.id !== id);
    if (res?.item) returnQueuedToDraft([res.item]);
  } catch (err) {
    if (Array.isArray(err?.body?.queue) && agy.sessionId === sid) agy.queue = err.body.queue;
    showToast(tr(err?.body?.error || err?.message) || t('撤回失败'), 'err');
  }
}

// 立即发送一条排队消息：停下手头这一步，马上把它作为下一轮发出去（其余的继续排着）
export async function sendAgyQueuedNow(id) {
  const sid = agy.sessionId;
  if (!sid || !id) return;
  try {
    await api.post('/api/agy/queue/send-now', { sessionId: sid, id });
  } catch (err) {
    showToast(tr(err?.body?.error || err?.message) || t('没能立即发送'), 'err');
  }
}

// —— 这个会话连哪台电脑（输入框底栏的电脑芯片）——
let linkReq = '';
export async function loadAgyDeviceLink(sid) {
  if (!sid) { linkReq = ''; return; }
  linkReq = sid;
  try {
    const r = await api.get('/api/devices/link?agent=agy&sessionId=' + encodeURIComponent(sid));
    if (linkReq === sid && agy.sessionId === sid) agy.deviceLink = r?.link || '';
  } catch { /* 老服务端 / 没开设备通道：保持「自动」 */ }
}
// v = 设备 id / 'none' / 'auto'
export async function setAgyDevice(v) {
  const want = v === 'auto' ? '' : String(v || '');
  if (!agy.sessionId) { agy.deviceDraft = want || 'auto'; return; }
  const sid = agy.sessionId, prev = agy.deviceLink;
  agy.deviceLink = want;
  try {
    const r = await api.post('/api/devices/link', { sessionId: sid, agent: 'agy', link: want });
    if (agy.sessionId === sid) agy.deviceLink = r?.link || '';
  } catch (err) {
    if (agy.sessionId === sid) agy.deviceLink = prev;
    showToast(tr(err?.body?.error || err?.message) || t('没能切换电脑'), 'err');
  }
}
