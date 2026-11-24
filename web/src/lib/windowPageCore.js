// 独立分页窗口（?page=<key>）的纯逻辑模块：键校验、别名归一化、URL 解析与构造。
// 与桌面壳 client/desktop/page-windows.cjs 保持同一套白名单口径。

export const BUILTIN_PAGE_KEYS = Object.freeze(['claude', 'chatgpt', 'agy', 'harness', 'studio', 'files']);

export const PAGE_ALIASES = Object.freeze({
  vertex: 'studio',
  gemini: 'studio',
  dimensio: 'harness',
  antigravity: 'harness',
  codex: 'chatgpt',
});

const APP_KEY_RE = /^app:[a-z0-9._-]{1,64}:[a-z0-9._-]{1,64}$/i;

export function normalizePageKey(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  const low = s.toLowerCase();
  const mapped = PAGE_ALIASES[low] || low;
  if (BUILTIN_PAGE_KEYS.includes(mapped)) return mapped;
  if (APP_KEY_RE.test(s)) return s;
  return '';
}

export function parseWindowPage({ bridgePageKey = '', search = '' } = {}) {
  const fromShell = normalizePageKey(bridgePageKey);
  if (fromShell) return fromShell;
  try {
    const q = new URLSearchParams(String(search || ''));
    return normalizePageKey(q.get('page') || '');
  } catch {
    return '';
  }
}

export function pageWindowUrl(key, href = '') {
  const k = normalizePageKey(key);
  if (!k || !href) return '';
  try {
    const u = new URL(href);
    u.searchParams.delete('pair');
    u.searchParams.delete('solo');
    u.searchParams.set('page', k);
    u.hash = '';
    return u.toString();
  } catch {
    return '';
  }
}
