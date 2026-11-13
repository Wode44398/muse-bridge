// 每个服务最近 50 次调用的环形日志（只在内存，GET /api/studio/providers/log?id=）。按「服务主人|服务 id」分槽：
// 成员用管理员共享的服务，记在管理员那份里（成员看不到别人的日志，他自己的服务只记他的）。
const MAX = 50;
const rings = new Map();   // 'owner|id' → [{ at, kind, model, status, ms, error?, test? }]（新的在前）

export function logCall(provider, entry) {
  const slot = (provider.owner || 'admin') + '|' + provider.id;
  const list = rings.get(slot) || [];
  list.unshift({ at: Date.now(), ...entry, ...(entry.error ? { error: String(entry.error).slice(0, 400) } : {}) });
  if (list.length > MAX) list.length = MAX;
  rings.set(slot, list);
}

export function providerLog(owner, id) { return rings.get((owner || 'admin') + '|' + id) || []; }
export function dropLog(owner, id) { rings.delete((owner || 'admin') + '|' + id); }
