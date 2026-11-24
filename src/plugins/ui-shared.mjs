// 界面扩展（plugins/ui.mjs）与工作区插槽（plugins/workspace.mjs）共用的小件：插槽名、id / 图标校验、截断、限时、身份过滤、英文词条。
// 单独成文件是为了不让 ui.mjs 与 workspace.mjs 互相 import。
import { kernel } from './state.mjs';

export const UI_SLOT = 'ui';
export const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
export const ICON_RE = /^[a-z][a-z0-9-]{0,23}$/;
export const str = (v, n) => (v == null ? '' : String(v).replace(/[\r\n]+/g, ' ').trim().slice(0, n));

export async function within(ms, fn) {
  let t;
  try { return await Promise.race([Promise.resolve().then(fn), new Promise((r) => { t = setTimeout(() => r(undefined), ms); t.unref?.(); })]); }
  finally { clearTimeout(t); }
}

export const audience = (who, c) => (who === 'members' ? c.kind === 'admin' || c.kind === 'user' : c.kind === 'admin');

// 英文词条：locales/en.json → ui.<种类>.<id>.<字段>
export function tr(owner, kind, id, field, zh, lang) {
  if (!/^en/i.test(lang || '')) return zh;
  const v = kernel.rawRecord(owner)?.extra?.i18n?.en?.ui?.[kind]?.[id]?.[field];
  return typeof v === 'string' && v.trim() ? v.trim() : zh;
}
