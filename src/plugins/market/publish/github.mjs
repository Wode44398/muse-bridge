// 「发布到社区」用的 GitHub 调用：带作者自己的令牌直接打 REST（不经 gh 子进程，令牌来源见 account.mjs）。
// 地址可换（BRIDGE_GITHUB_API / BRIDGE_GITHUB_WEB）：单测与隔离实例端到端用本地假 GitHub，不碰真的公开仓库。
const UA = 'claude-bridge-community-publish';
const TIMEOUT_MS = 20_000;

const hooks = { api: null, web: null };
export function _setGithubHooks({ api = null, web = null } = {}) { hooks.api = api; hooks.web = web; }
export const apiBase = () => (hooks.api || process.env.BRIDGE_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
export const webBase = () => (hooks.web || process.env.BRIDGE_GITHUB_WEB || 'https://github.com').replace(/\/+$/, '');

export class GithubError extends Error {
  constructor(status, message, data = null) { super(message); this.status = status; this.data = data; }
}

const human = (status, msg) => {
  if (status === 401) return 'GitHub 令牌无效或已过期，重新登录一下';
  if (status === 403 && /rate limit/i.test(msg)) return 'GitHub 限流了，过一会儿再试';
  if (status === 403) return 'GitHub 拒绝了这次操作（令牌权限不够？要 public_repo）：' + msg;
  return msg || 'GitHub ' + status;
};

export async function api(token, method, path, body) {
  let res;
  try {
    res = await fetch(apiBase() + path, {
      method,
      headers: {
        // 没令牌也能读公开仓库（查投稿状态时作者可能已经登出），只是限流更紧
        ...(token ? { Authorization: 'Bearer ' + token } : {}), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': UA,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new GithubError(0, '连不上 GitHub：' + String(e?.cause?.code || e?.message || e).slice(0, 120));
  }
  const text = await res.text().catch(() => '');
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (res.status >= 400) throw new GithubError(res.status, human(res.status, (data && data.message) || ''), data);
  return data;
}

// 设备码登录两步（OAuth App 的 client id 是公开的，不需要机密）
export async function oauthPost(path, form) {
  let res;
  try {
    res = await fetch(webBase() + path, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    throw new GithubError(0, '连不上 GitHub：' + String(e?.cause?.code || e?.message || e).slice(0, 120));
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || !data) throw new GithubError(res.status, 'GitHub 登录接口回了 ' + res.status);
  return data;
}
