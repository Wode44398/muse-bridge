// 扫码配对（开源路线 S1-2）的纯函数：配对二维码内容的解析、手填服务器地址的规范化。不引任何模块（单测直接跑）。
// 二维码内容由服务端出（src/runtime/pair-connect.mjs 的 connectUrl）：<origin>/?connect=<id>.<secret>&lan=<ip:端口,…>&sid=<服务器 id>

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;
const SECRET_RE = /^[A-Za-z0-9_-]{16,64}$/;
const SID_RE = /^srv_[0-9a-f]{20}$/;
// 私网 + CGNAT（Tailscale 的 100.64/10）
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

export const cleanOrigin = (o) => { try { const u = new URL(String(o || '')); return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : ''; } catch { return ''; } };
export const hostOf = (o) => { try { return new URL(o).hostname.replace(/^\[|\]$/g, '').toLowerCase(); } catch { return ''; } };

/** 局域网 / 本机地址（这类地址没有证书，要走 http）。与桌面连接页的 isPrivateHost 同一口径。 */
export function isPrivateHost(h) {
  const host = String(h || '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '::1' || /^127\./.test(host) || PRIVATE_V4.test(host) || /\.local$/.test(host);
}

/**
 * 用户手填的服务器地址 → origin：没写协议时局域网 / 本机补 http、其余补 https；裸局域网 IP 没写端口补 :8787（bridge 默认端口）。
 * 不合法回 ''。
 */
export function normalizeServerAddress(input) {
  let a = String(input || '').trim().replace(/\/+$/, '');
  if (!a || /^https?:\/?$/i.test(a)) return '';
  if (!/^https?:\/\//i.test(a)) {
    const hostPort = a.replace(/[/?#].*$/, '');
    const host = hostPort.replace(/:\d+$/, '');
    const bareIp = /^\d+\.\d+\.\d+\.\d+$/.test(host) && hostPort === host;
    a = (isPrivateHost(host) ? 'http://' : 'https://') + a;
    if (bareIp && isPrivateHost(host)) { try { const u = new URL(a); u.port = '8787'; a = u.origin; } catch {} }
  }
  return cleanOrigin(a);
}

/**
 * 二维码文字 → { origin, id, secret, lan:[origin…], sid }；不是配对码回 null。
 * lan 只收私网地址（码是服务器出的，但被人改过的码不该把 App 引到公网上的任意 http 地址）。
 */
export function parseConnectPayload(text) {
  let u;
  try { u = new URL(String(text || '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const c = u.searchParams.get('connect') || '';
  const i = c.indexOf('.');
  if (i <= 0) return null;
  const id = c.slice(0, i), secret = c.slice(i + 1);
  if (!ID_RE.test(id) || !SECRET_RE.test(secret)) return null;
  const lan = String(u.searchParams.get('lan') || '').split(',').map((h) => h.trim())
    .filter((h) => /^[\d.]+:\d{2,5}$/.test(h) && isPrivateHost(h.replace(/:\d+$/, '')))
    .slice(0, 3).map((h) => 'http://' + h);
  const sid = u.searchParams.get('sid') || '';
  return { origin: u.origin, id, secret, lan, sid: SID_RE.test(sid) ? sid : '' };
}

// 全角数字 → 半角（中文输入法下手输配对码常见）；与服务端 runtime/pair-connect.mjs 的 normCode 同一口径
const halfDigits = (s) => String(s || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).trim();

/** 手输的一栏只有数字（容忍空格 / 短横线 / 全角数字）——那就是配对码，不会是访问令牌。 */
export const looksLikeDigits = (s) => { const d = halfDigits(s); return !!d && /^[\d\s-]+$/.test(d); };

/** 手输的一栏是 8 位数字配对码（容忍空格 / 短横线 / 全角数字）还是别的（访问令牌）。 */
export const looksLikeCode = (s) => looksLikeDigits(s) && halfDigits(s).replace(/[\s-]/g, '').length === 8;
