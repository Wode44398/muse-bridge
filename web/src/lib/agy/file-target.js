// Antigravity 文件投递懒加载桥：供核心工作空间「发送给 AI」与全域拖拽经 services.svelte.js 动态加载，
// 确保 Antigravity 源码不漏进核心主包。

import { agy, newAgyChat, openAgySession, pushAgyDraftAtt } from './store.svelte.js';
import { agyApi } from './api.js';

function mapSessionItem(s) {
  return {
    id: s.sessionId,
    title: s.customTitle || s.title || '',
    mtime: s.updatedMs || (s.updatedAt ? Date.parse(s.updatedAt) || 0 : 0),
    thinking: Array.isArray(agy.activeSessionIds) && agy.activeSessionIds.includes(s.sessionId),
    pending: false,
  };
}

export const agyFileTarget = {
  current: () => agy.sessionId,
  newChat: () => newAgyChat(),
  load: (sid) => openAgySession(sid),
  attach: (att) => pushAgyDraftAtt(att),
  cachedSessions: () => (Array.isArray(agy.sessions) ? agy.sessions.map(mapSessionItem) : []),
  remoteSessions: async () => {
    const res = await agyApi.listSessions({ refresh: true });
    const list = Array.isArray(res?.sessions) ? res.sessions : [];
    agy.sessions = list;
    return { sessions: list.map(mapSessionItem) };
  },
};
