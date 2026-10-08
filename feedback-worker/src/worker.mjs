// Muse Bridge 反馈中继（Cloudflare Worker）。
//
// 各台 Muse 上的服务器把用户同意过的报告 POST 到 /v1/report；这里再过一遍白名单和脱敏（跟服务器上是同一份代码），
// 然后以 GitHub App「muse-bridge-feedback」的身份提交：
//   · 普通问题 → 公开仓库的 Issue；同一个指纹已经有开着的 Issue 就在下面 +1（每台装机只 +1 一次），
//     原 Issue 已关闭则开新的并注明「可能是 #n 的回归」
//   · 安全问题 → 仓库的私密漏洞报告（只有维护者看得到）
// App 的私钥只在这里（Worker secret GITHUB_APP_PRIVATE_KEY），换成 1 小时有效的安装令牌再调 GitHub。
// 防滥用：每台装机每天、全局每天各有上限；PAUSED=1 或 KV 里 cfg:paused=1 一键停收（客户端会存着之后补发）。
import { cleanReport } from '../../src/feedback/schema.mjs';
import { issueTitle, issueBody, plusOneBody, issueLabels } from '../../src/feedback/render.mjs';

const MAX_BODY = 64 * 1024;

const json = (code, o) => new Response(JSON.stringify(o), { status: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

// —— GitHub App 认证：私钥签 JWT（RS256）→ 换安装令牌 ——
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlStr = (s) => b64url(new TextEncoder().encode(s));

function derLen(n) {
  if (n < 0x80) return [n];
  const out = []; while (n > 0) { out.unshift(n & 0xff); n >>= 8; }
  return [0x80 | out.length, ...out];
}
const der = (tag, bytes) => new Uint8Array([tag, ...derLen(bytes.length), ...bytes]);

/** GitHub 给的私钥是 PKCS#1（BEGIN RSA PRIVATE KEY），WebCrypto 只收 PKCS#8：外面包一层 */
export function pemToPkcs8(pem) {
  const isPkcs1 = /BEGIN RSA PRIVATE KEY/.test(pem);
  const raw = Uint8Array.from(atob(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), (c) => c.charCodeAt(0));
  if (!isPkcs1) return raw;
  const algId = new Uint8Array([0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00]);
  const version = new Uint8Array([0x02, 0x01, 0x00]);
  const octet = der(0x04, raw);
  return der(0x30, new Uint8Array([...version, ...algId, ...octet]));
}

export async function appJwt(appId, pem, nowSec) {
  const key = await crypto.subtle.importKey('pkcs8', pemToPkcs8(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const head = b64urlStr(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64urlStr(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: String(appId) }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

export function createHandler({ fetch: doFetch = (...a) => fetch(...a), now = () => Date.now() } = {}) {
  let tokenCache = null;   // { token, exp }（同一个 isolate 里复用）

  async function installationToken(env) {
    if (tokenCache && tokenCache.exp - now() > 5 * 60_000) return tokenCache.token;
    const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY, Math.floor(now() / 1000));
    const r = await doFetch(`${api(env)}/app/installations/${env.GITHUB_INSTALLATION_ID}/access_tokens`, {
      method: 'POST', headers: ghHeaders(jwt),
    });
    if (!r.ok) throw new Error(`installation token ${r.status}`);
    const j = await r.json();
    tokenCache = { token: j.token, exp: Date.parse(j.expires_at) || now() + 50 * 60_000 };
    return tokenCache.token;
  }
  const api = (env) => (env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
  const ghHeaders = (tok) => ({ Authorization: `Bearer ${tok}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'muse-bridge-feedback-worker' });
  async function gh(env, method, path, body) {
    const tok = await installationToken(env);
    const r = await doFetch(api(env) + path, { method, headers: { ...ghHeaders(tok), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, ok: r.ok, body: j };
  }

  // —— 限流（KV 计数，按 UTC 日）——
  async function bump(env, key, limit) {
    const kv = env.FEEDBACK_KV;
    if (!kv) return true;
    const n = Number(await kv.get(key)) || 0;
    if (n >= limit) return false;
    await kv.put(key, String(n + 1), { expirationTtl: 2 * 86400 });
    return true;
  }

  async function findByFingerprint(env, fp) {
    const kv = env.FEEDBACK_KV;
    const known = kv ? Number(await kv.get(`fp:${fp}`)) : 0;
    if (known) {
      const r = await gh(env, 'GET', `/repos/${env.GITHUB_REPO}/issues/${known}`);
      if (r.ok) return r.body;
    }
    const q = encodeURIComponent(`repo:${env.GITHUB_REPO} is:issue in:body "${fp}"`);
    const s = await gh(env, 'GET', `/search/issues?q=${q}&sort=created&order=desc&per_page=5`);
    const hit = s.ok && Array.isArray(s.body?.items) ? s.body.items.find((it) => String(it.body || '').includes(`muse-fp:${fp}`)) : null;
    if (hit && kv) await kv.put(`fp:${fp}`, String(hit.number));
    return hit || null;
  }

  async function report(r, env) {
    const repo = env.GITHUB_REPO;
    if (r.kind === 'security') {
      // 私密漏洞报告（仓库已开 Private vulnerability reporting）；不行再退到维护者私有的草稿公告
      const body = { summary: issueTitle(r).slice(0, 1024), description: issueBody(r) };
      let x = await gh(env, 'POST', `/repos/${repo}/security-advisories/reports`, body);
      if (!x.ok) x = await gh(env, 'POST', `/repos/${repo}/security-advisories`, { ...body, vulnerabilities: [] });
      if (!x.ok) return json(502, { error: `github ${x.status}` });
      return json(200, { ok: true, private: true });
    }
    let regressionOf = 0;
    if (r.fp) {
      const hit = await findByFingerprint(env, r.fp);
      if (hit && hit.state === 'open') {
        const seenKey = `fpi:${r.fp}:${r.install}`;
        const seen = env.FEEDBACK_KV ? await env.FEEDBACK_KV.get(seenKey) : null;
        if (!seen) {
          await gh(env, 'POST', `/repos/${repo}/issues/${hit.number}/comments`, { body: plusOneBody(r) });
          if (env.FEEDBACK_KV) await env.FEEDBACK_KV.put(seenKey, '1', { expirationTtl: 90 * 86400 });
        }
        return json(200, { ok: true, duplicate: true, issue: { number: hit.number, url: hit.html_url } });
      }
      if (hit) regressionOf = hit.number;
    }
    let body = issueBody(r);
    if (regressionOf) body = `_Possibly a regression of #${regressionOf} (closed)._\n\n` + body;
    const x = await gh(env, 'POST', `/repos/${repo}/issues`, { title: issueTitle(r), body, labels: issueLabels(r) });
    if (!x.ok) return json(502, { error: `github ${x.status}` });
    // 没有推送权限的调用方建 Issue 时，GitHub 会悄悄丢掉 labels：缺了就单独补一次（失败不影响结果）
    const got = new Set((x.body.labels || []).map((l) => (typeof l === 'string' ? l : l?.name)));
    const want = issueLabels(r).filter((l) => !got.has(l));
    if (want.length) { try { await gh(env, 'POST', `/repos/${repo}/issues/${x.body.number}/labels`, { labels: want }); } catch {} }
    if (r.fp && env.FEEDBACK_KV) await env.FEEDBACK_KV.put(`fp:${r.fp}`, String(x.body.number));
    return json(200, { ok: true, issue: { number: x.body.number, url: x.body.html_url } });
  }

  return async function handle(req, env) {
    const url = new URL(req.url);
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/v1/health')) {
      return json(200, { ok: true, service: 'muse-bridge-feedback', paused: await paused(env) });
    }
    if (url.pathname !== '/v1/report') return json(404, { error: 'not found' });
    if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
    if (await paused(env)) return json(503, { error: 'paused' });

    const raw = await req.text();
    if (raw.length > MAX_BODY) return json(413, { error: 'too large' });
    let r;
    // cleanReport 就是第二遍脱敏：服务器那边漏了什么，这里按同一套规则再抹一遍
    try { r = cleanReport(JSON.parse(raw)); }
    catch (e) { return json(400, { error: String(e?.message || 'bad report') }); }

    const day = new Date(now()).toISOString().slice(0, 10);
    if (!(await bump(env, `rl:${day}:all`, Number(env.DAILY_CAP) || 300))) return json(429, { error: 'daily limit reached', retryAfter: 'tomorrow' });
    if (!(await bump(env, `rl:${day}:i:${r.install}`, Number(env.PER_INSTALL_DAILY) || 10))) return json(429, { error: 'too many reports from this install today', retryAfter: 'tomorrow' });

    try { return await report(r, env); }
    catch (e) { return json(502, { error: String(e?.message || e).slice(0, 200) }); }
  };
}

async function paused(env) {
  if (String(env.PAUSED || '') === '1') return true;
  try { return env.FEEDBACK_KV ? (await env.FEEDBACK_KV.get('cfg:paused')) === '1' : false; } catch { return false; }
}

const handler = createHandler();
export default { fetch: (req, env) => handler(req, env) };
