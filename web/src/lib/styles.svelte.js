// 自定义回复风格（AddMenu 的 Create & edit styles）。本设备存 localStorage
// （与收藏/重命名 bridge-stars/bridge-titles 同模式，后端无端点）；发送时把选中
// 自定义风格的指令文本放进请求（params.styleText），后端在预设未命中时注入。
const KEY = 'bridge-styles';

function load() {
  try { const v = JSON.parse(localStorage.getItem(KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

export const customStyles = $state({ list: load() });   // [{id, name, text}]

function persist() { try { localStorage.setItem(KEY, JSON.stringify(customStyles.list)); } catch {} }

export function addStyle(name, text) {
  const id = 'custom-' + Math.random().toString(36).slice(2, 9);
  customStyles.list.push({ id, name, text });
  persist();
  return id;
}

export function updateStyle(id, name, text) {
  const s = customStyles.list.find((x) => x.id === id);
  if (!s) return;
  s.name = name; s.text = text;
  persist();
}

export function removeStyle(id) {
  customStyles.list = customStyles.list.filter((x) => x.id !== id);
  persist();
}

export const getStyle = (id) => customStyles.list.find((x) => x.id === id) || null;
