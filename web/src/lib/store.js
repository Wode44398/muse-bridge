// 持久化键值。离线 apk 里 WebView 的 localStorage 在进程被杀（划掉后台）后不可靠，
// 尤其国产 ROM。故优先用 Android 原生 SharedPreferences（MainActivity 通过
// addJavascriptInterface 暴露的 window.AndroidStore），并双写 localStorage 兜底，
// 让在线壳 / 网页 / dev（没有 AndroidStore）照常工作。
//
// 只有登录态相关的键（token、服务器地址）需要这种强持久；主题/玻璃方案等丢了也只是回默认。

export function storeGet(k) {
  try { const v = window.AndroidStore && window.AndroidStore.get(k); if (v != null) return v; } catch {}
  try { return localStorage.getItem(k); } catch { return null; }
}

export function storeSet(k, v) {
  try {
    if (window.AndroidStore) { if (v == null) window.AndroidStore.remove(k); else window.AndroidStore.set(k, v); }
  } catch {}
  try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch {}
}
