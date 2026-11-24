// Antigravity 分页 REST 接口薄封装（SSE 对话与断线重连走 lib/sse.js 的 scope:'agy'）。

import { api } from '../api.js';

export const agyApi = {
  status: (ensure = false, probe = false) => {
    const qs = new URLSearchParams();
    if (ensure) qs.set('ensure', '1');
    if (probe) qs.set('probe', '1');
    const tail = qs.toString();
    return api.get('/api/agy/status' + (tail ? '?' + tail : ''));
  },
  quota: (force = false, sessionId = '') => {
    const qs = new URLSearchParams();
    if (force) qs.set('force', '1');
    if (sessionId) qs.set('session', sessionId);
    const tail = qs.toString();
    return api.get('/api/agy/quota' + (tail ? '?' + tail : ''));
  },
  pool: () => api.get('/api/agy/pool'),
  poolUsage: (force = false) => api.get('/api/agy/pool/usage' + (force ? '?force=1' : '')),
  poolSetActive: (id) => api.post('/api/agy/pool/active', { id }),
  poolMove: (id, delta) => api.post('/api/agy/pool/move', { id, delta }),
  poolAdd: (body) => api.post('/api/agy/pool/add', body || {}),
  poolUpdate: (body) => api.post('/api/agy/pool/update', body || {}),
  poolDelete: (id) => api.post('/api/agy/pool/delete', { id }),
  poolSetRouter: (patch) => api.post('/api/agy/pool/router', patch || {}),
  poolOAuthStart: (body) => api.post('/api/agy/pool/oauth/start', body || {}),
  poolOAuthStatus: (flowId) => api.get('/api/agy/pool/oauth/status?id=' + encodeURIComponent(flowId || '')),
  poolOAuthFinish: (body) => api.post('/api/agy/pool/oauth/finish', body || {}),
  poolOAuthCancel: (flowId) => api.post('/api/agy/pool/oauth/cancel', { flowId }),
  restart: () => api.post('/api/agy/restart', {}),
  logout: () => api.post('/api/agy/logout', {}),
  checkUpdate: () => api.post('/api/agy/update', {}),

  getSettings: () => api.get('/api/agy/settings'),
  saveSettings: (patch) => api.post('/api/agy/settings', patch || {}),

  listMcp: () => api.get('/api/agy/mcp'),
  addMcp: (spec) => api.post('/api/agy/mcp/add', spec || {}),
  toggleMcp: (name, enabled) => api.post('/api/agy/mcp/toggle', { name, enabled }),
  removeMcp: (name) => api.post('/api/agy/mcp/remove', { name }),

  listPlugins: () => api.get('/api/agy/plugins'),
  installPlugin: (target) => api.post('/api/agy/plugins/install', { target }),
  togglePlugin: (name, enabled) => api.post('/api/agy/plugins/toggle', { name, enabled }),
  uninstallPlugin: (name) => api.post('/api/agy/plugins/uninstall', { name }),

  listProjects: () => api.get('/api/agy/projects'),
  setProjectOrder: (paths) => api.post('/api/agy/project/order', { paths }),
  createProject: (dirPath, name = '') => api.post('/api/agy/project/create', { path: dirPath, ...(name ? { name } : {}) }),
  pinProject: ({ id = '', path = '', pinned = true } = {}) =>
    api.post('/api/agy/project/pin', { ...(id ? { id } : {}), ...(path ? { path } : {}), pinned: !!pinned }),
  renameProject: ({ id = '', path = '', name = '' } = {}) =>
    api.post('/api/agy/project/rename', { ...(id ? { id } : {}), ...(path ? { path } : {}), name: String(name || '') }),
  deleteProject: ({ id = '', path = '' } = {}) =>
    api.post('/api/agy/project/delete', { ...(id ? { id } : {}), ...(path ? { path } : {}) }),

  listSessions: ({ cwd = '', projectId = '', q = '', includeHidden = false, refresh = false } = {}) => {
    const qs = new URLSearchParams();
    if (cwd) qs.set('cwd', cwd);
    if (projectId) qs.set('projectId', projectId);
    if (q) qs.set('q', q);
    if (includeHidden) qs.set('includeHidden', '1');
    if (refresh) qs.set('refresh', '1');
    const tail = qs.toString();
    return api.get('/api/agy/sessions' + (tail ? '?' + tail : ''));
  },
  getSession: (id, cwd = '') => api.get('/api/agy/session/' + encodeURIComponent(id) + (cwd ? '?cwd=' + encodeURIComponent(cwd) : '')),
  hideSession: (id) => api.post('/api/agy/session/delete', { id }),
  hideSessions: (ids) => api.post('/api/agy/sessions/hide', { ids }),
  restoreSession: (id) => api.post('/api/agy/session/restore', { id }),
  restoreAllSessions: () => api.post('/api/agy/sessions/restore-all', {}),
  renameSession: (id, title) => api.post('/api/agy/session/rename', { id, title }),
  favoriteSession: (id, favorite) => api.post('/api/agy/session/favorite', { id, favorite: !!favorite }),
  // 彻底删除（不可恢复）；hideSession 那条是可恢复的隐藏
  purgeSession: (id) => api.post('/api/agy/session/purge', { id }),
  quoteSession: ({ id, title = '', cwd = '' } = {}) =>
    api.post('/api/agy/session/quote', { id, ...(title ? { title } : {}), ...(cwd ? { cwd } : {}) }),
  searchContent: (q, { limit = 20, includeHidden = false } = {}) => {
    const qs = new URLSearchParams({ q, limit: String(limit) });
    if (includeHidden) qs.set('includeHidden', '1');
    return api.get('/api/agy/search?' + qs.toString());
  },

  setConfig: (sessionId, configId, value, cwd = '') =>
    api.post('/api/agy/config', { sessionId, configId, value, ...(cwd ? { cwd } : {}) }),

  answerPermission: (requestId, optionId, outcome = 'selected') =>
    api.post('/api/agy/permission', { requestId, optionId, outcome }),

  answerQuestion: (requestId, action, content = {}) =>
    api.post('/api/agy/question', { requestId, action, content }),

  active: (sessionId = '') =>
    api.get('/api/agy/active' + (sessionId ? '?session=' + encodeURIComponent(sessionId) : '')),

  stop: (sessionId = '') =>
    api.post('/api/agy/stop', sessionId ? { sessionId } : {}),

  subagents: (sessionId = '') =>
    api.get('/api/agy/subagents?session=' + encodeURIComponent(sessionId || '')),

  swarm: (sessionId = '', etag = '') => {
    const qs = new URLSearchParams({ session: sessionId || '' });
    if (etag) qs.set('etag', etag);
    return api.get('/api/agy/swarm?' + qs.toString());
  },

  subagentTranscript: (sessionId = '', agentId = '', from = 0) => {
    const qs = new URLSearchParams({ session: sessionId || '', agentId: agentId || '' });
    if (from > 0) qs.set('from', String(Math.floor(from)));
    return api.get('/api/agy/subagent-transcript?' + qs.toString());
  },

  syncSubagents: (sessionId = '', wake = false) =>
    api.post('/api/agy/subagents/sync', { sessionId, wake: !!wake }),
};
