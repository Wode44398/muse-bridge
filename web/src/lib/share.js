// 公开分享只读模式。URL 形如 /w/<token>：前端据此进「只读工作空间」模式——
// 复用 FilesPanel + 预览查看器，但跳过登录、只读、且所有 /api 请求带上 ?st=<token>
// 让后端解析成 cwd 锁死在分享桶内的只读身份（见 bridge runtime/identity.mjs）。
// 带密码的分享：服务端密码页验对后跳回 /w/<token>?k=<unlock>，这里把 k 併进 st
// 组成 `token.k`——后端 resolveShareToken 验 k 不对就不给身份（密码本身绝不进 URL）。

let token = '';
let key = '';
try {
  const m = /^\/w\/([^/?#]+)/.exec(location.pathname);
  if (m) token = decodeURIComponent(m[1]);
  if (token) key = new URLSearchParams(location.search).get('k') || '';
} catch {}

export const SHARE_TOKEN = token;
export const IS_SHARE = !!token;
const ST = key ? token + '.' + key : token;

// 给 /api/ 请求补 ?st=<token[.k]>。api.js 的 req() 与 FilesPanel 的直连媒体/下载 URL 都经
// apiUrl()，在那一处调用本函数即单点覆盖。非分享模式或非 /api 路径原样返回。
export function withShare(path) {
  if (!token || typeof path !== 'string' || !path.startsWith('/api/')) return path;
  return path + (path.includes('?') ? '&' : '?') + 'st=' + encodeURIComponent(ST);
}
