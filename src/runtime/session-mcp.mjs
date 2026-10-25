// 会话的连接器（MCP 服务器）状态——会话信息面板「连接器」卡的数据源。
// 每轮 init 帧自带 mcp_servers:[{name,status}]（connected / failed / needs-auth / pending / disabled），
// 这里按 caller key + 会话 id 记最近一份（内存即可：重开会话下一轮 init 又会报一遍）。
const MAX = 400;
const store = new Map();   // `${key}|${sessionId}` → { servers, at }

const STATUS = new Set(['connected', 'failed', 'needs-auth', 'pending', 'disabled']);

export function normalizeMcp(list) {
  return (Array.isArray(list) ? list : [])
    .filter((s) => s && typeof s.name === 'string' && s.name)
    .map((s) => ({ name: s.name, status: STATUS.has(s.status) ? s.status : 'failed' }));
}

export function noteSessionMcp(key, sessionId, list) {
  const servers = normalizeMcp(list);
  if (!key || !sessionId) return servers;
  const k = key + '|' + sessionId;
  store.delete(k);
  store.set(k, { servers, at: Date.now() });
  if (store.size > MAX) store.delete(store.keys().next().value);
  return servers;
}

export function sessionMcp(key, sessionId) {
  return (key && sessionId && store.get(key + '|' + sessionId)) || null;
}
