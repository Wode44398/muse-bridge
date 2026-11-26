// ID 令牌校验（sign-in 第 4 步）：签名对 OpenAI 公布的 JWKS 验，再查签发方、受众（= 签发给我们的 client_id）、过期与 nonce。
// 只用 node:crypto，不引第三方 JOSE 库。
import { createPublicKey, verify as cryptoVerify, constants } from 'node:crypto';
import { EP } from './const.mjs';

const HOUR = 3600_000;
let oidcCache = null;   // { at, doc }
let jwksCache = null;   // { at, uri, keys }

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
/** 不验签地解出 JWT 的载荷（只用来读访问令牌的 exp 这种不涉及信任的字段）。 */
export function decodeJwt(t) {
  try { return b64json(String(t).split('.')[1] || ''); } catch { return null; }
}

async function getJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'application/json' } });
  if (!r.ok) throw Object.assign(new Error(`${new URL(url).host} 返回 ${r.status}`), { status: 502 });
  return r.json();
}
export async function oidcConfig() {
  if (oidcCache && Date.now() - oidcCache.at < HOUR) return oidcCache.doc;
  const doc = await getJson(EP.oidcConfig);
  oidcCache = { at: Date.now(), doc };
  return doc;
}
async function jwks(force = false) {
  const uri = (await oidcConfig()).jwks_uri || `${EP.issuer}/.well-known/jwks.json`;
  if (!force && jwksCache && jwksCache.uri === uri && Date.now() - jwksCache.at < HOUR) return jwksCache.keys;
  const doc = await getJson(uri);
  jwksCache = { at: Date.now(), uri, keys: Array.isArray(doc?.keys) ? doc.keys : [] };
  return jwksCache.keys;
}

const ALGS = {
  RS256: (data, key, sig) => cryptoVerify('RSA-SHA256', data, key, sig),
  PS256: (data, key, sig) => cryptoVerify('sha256', data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, sig),
  ES256: (data, key, sig) => cryptoVerify('sha256', data, { key, dsaEncoding: 'ieee-p1363' }, sig),
};

const fail = (msg) => Object.assign(new Error(msg), { status: 502, code: 'id_token' });

/**
 * 验 ID 令牌 → 载荷。keysFor 只给测试换掉 JWKS 来源。
 * 换了密钥（kid 不在缓存里）就强制重拉一次 JWKS。
 */
export async function verifyIdToken(idToken, { clientId, nonce, now = Date.now(), keysFor = jwks } = {}) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw fail('ID 令牌格式不对');
  let header, payload;
  try { header = b64json(parts[0]); payload = b64json(parts[1]); } catch { throw fail('ID 令牌解不开'); }
  const check = ALGS[header.alg];
  if (!check) throw fail(`ID 令牌的签名算法不认识：${String(header.alg).slice(0, 20)}`);
  let keys = await keysFor(false);
  let jwk = keys.find((x) => x.kid === header.kid);
  if (!jwk) { keys = await keysFor(true); jwk = keys.find((x) => x.kid === header.kid); }
  if (!jwk) throw fail('找不到 ID 令牌签名用的公钥');
  let ok = false;
  try { ok = check(Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url')); } catch { ok = false; }
  if (!ok) throw fail('ID 令牌的签名对不上');
  if (payload.iss !== EP.issuer) throw fail('ID 令牌的签发方不对');
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!clientId || !aud.includes(clientId)) throw fail('ID 令牌不是签发给这个应用的');
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 < now - 60_000) throw fail('ID 令牌已过期');
  if (nonce && payload.nonce !== nonce) throw fail('ID 令牌的 nonce 对不上');
  if (!payload.sub) throw fail('ID 令牌里没有账号标识');
  return payload;
}

export function _resetJwtCacheForTests() { oidcCache = null; jwksCache = null; }
