// Antigravity 侧栏的会话管理动作：收藏 / 取消收藏、彻底删除（不可恢复，区别于可恢复的「隐藏」）。
// 都是先改本地列表再请求，失败了退回；别的设备上的变化经账号总线 agy.sessions 触发列表同步（store 里已接），
// 这里另外处理「正看着的会话在别处被删了」——列表同步会保留当前会话的行，得主动离开。

import { agy, newAgyChat, refreshAgySessions, refreshHiddenSessions } from './store.svelte.js';
import { agyApi } from './api.js';
import { removeCachedAgySession } from '../cache.js';
import { showToast } from '../toast.svelte.js';
import { t, tr } from '../i18n.js';
import { busOn } from '../bus.js';

function patchFavorite(sessionId, on) {
  agy.sessions = agy.sessions.map((s) => {
    if (s.sessionId !== sessionId) return s;
    const next = { ...s };
    if (on) next.favorite = true;
    else delete next.favorite;
    return next;
  });
}

export async function setAgyFavorite(sessionId, favorite) {
  if (!sessionId) return;
  patchFavorite(sessionId, favorite);
  try {
    await agyApi.favoriteSession(sessionId, favorite);
  } catch (err) {
    patchFavorite(sessionId, !favorite);
    showToast(tr(err?.body?.error || err?.message) || t('收藏失败'), 'err');
  }
}

function dropLocal(sessionId) {
  agy.sessions = agy.sessions.filter((s) => s.sessionId !== sessionId);
  agy.hiddenSessions = agy.hiddenSessions.filter((s) => s.sessionId !== sessionId);
  removeCachedAgySession(sessionId);
}

export async function purgeAgySession(sessionId) {
  if (!sessionId) return false;
  const prevSessions = agy.sessions;
  const prevHidden = agy.hiddenSessions;
  dropLocal(sessionId);
  try {
    await agyApi.purgeSession(sessionId);
  } catch (err) {
    agy.sessions = prevSessions;
    agy.hiddenSessions = prevHidden;
    showToast(tr(err?.body?.error || err?.message) || t('删除对话失败'), 'err');
    return false;
  }
  if (agy.sessionId === sessionId) newAgyChat();
  await Promise.all([refreshAgySessions(), agy.hiddenOpen ? refreshHiddenSessions() : null]);
  return true;
}

// 别的设备删了我正看着的会话：离开它（列表同步不会替当前会话做这件事）
let bound = false;
export function bindAgySessionManageBus() {
  if (bound) return;
  bound = true;
  busOn((ev) => {
    if (!ev || ev.type !== 'agy.sessions' || ev.why !== 'delete' || !ev.sessionId) return;
    dropLocal(ev.sessionId);
    if (agy.sessionId === ev.sessionId) newAgyChat();
  });
}
