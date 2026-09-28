// 持久化键值（localStorage）。登录态相关的键（token、登录态快照）走这里，读写失败静默。

export function storeGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}

export function storeSet(k, v) {
  try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {}
}
