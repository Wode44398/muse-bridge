// 「聊天快照」模式（QQ 群 /chat）。URL 形如 /c/<token>：前端据此挂 SnapPage——阉割版
// Claude 分页（无侧栏、只有对话），跳过登录/boot；所有 /api 请求带上 ?ct=<token>，
// 后端解析成 kind:'snap' 身份（可写、cwd 锁死快照桶、无 shell，见 bridge
// runtime/identity.mjs）。与 share.js（/w/ 只读分享）同构，两模式互斥。

let token = '';
try {
  const m = /^\/c\/([^/?#]+)/.exec(location.pathname);
  if (m) token = decodeURIComponent(m[1]);
} catch {}

export const CSNAP_TOKEN = token;
export const IS_CSNAP = !!token;

// 给 /api/ 请求补 ?ct=<token>。挂在 server.js 的 apiUrl() 单点——fetch/SSE/<img> 全覆盖。
export function withCsnap(path) {
  if (!token || typeof path !== 'string' || !path.startsWith('/api/')) return path;
  return path + (path.includes('?') ? '&' : '?') + 'ct=' + encodeURIComponent(token);
}
