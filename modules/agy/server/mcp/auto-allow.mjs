// 动态工具里哪些免审批：插件工具声明了 access:'read' 的那几个（工具名随插件变，不能写死在 approval.mjs 里）。
// 由插件组列工具时登记（groups/plugins.mjs），approval.mjs 只读这里——这个文件不引任何东西，ACP 客户端的单测也能直接用。

const readOnly = new Map();   // 组 → Set(对外名)

export function setReadOnlyTools(group, names) {
  readOnly.set(String(group), new Set((names || []).map(String)));
}

export function isDynamicReadOnly(name) {
  const n = String(name || '');
  for (const set of readOnly.values()) if (set.has(n)) return true;
  return false;
}

export function _resetAutoAllowForTest() { readOnly.clear(); }
