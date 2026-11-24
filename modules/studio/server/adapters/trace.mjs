// 试跑记录的整理：每一步发了什么、回了什么，给人和 AI 排错看。
// 记录里不许出现 Key：鉴权头只留尾 4 位，sink.secrets 里的串（服务的 Key）在所有文字里替换掉；
// 素材的 base64 / data URL 只留开头和大小（几 MB 的图塞进记录既看不了也传不动）。

const MAX_TEXT = 6000;
const MAX_ENTRIES = 40;
const AUTH_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'xi-api-key', 'api-key', 'x-token', 'token']);

const tail = (s) => { const t = String(s || ''); return t.length > 8 ? '…' + t.slice(-4) : '…'; };
export function scrubSecrets(s, secrets = []) {
  let out = String(s ?? '');
  for (const k of secrets) if (k && k.length >= 6) out = out.split(k).join(tail(k));
  return out;
}

const B64_RE = /^[A-Za-z0-9+/=\s]{400,}$/;
const kb = (n) => (n >= 1024 * 1024 ? (n / 1024 / 1024).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
// 长串里的 data URL / 纯 base64 换成占位说明
function shortStr(s) {
  if (s.startsWith('data:') && s.length > 200) { const i = s.indexOf(','); return `${s.slice(0, Math.min(i + 1, 60))}<base64 约 ${kb(Math.round((s.length - i) * 0.75))}>`; }
  if (B64_RE.test(s)) return `<base64 约 ${kb(Math.round(s.length * 0.75))}>`;
  return s.length > 2000 ? s.slice(0, 2000) + `…<共 ${s.length} 字>` : s;
}
function shorten(v, depth = 0) {
  if (typeof v === 'string') return shortStr(v);
  if (depth > 12) return '…';
  if (Array.isArray(v)) return (v.length > 50 ? v.slice(0, 50) : v).map((x) => shorten(x, depth + 1)).concat(v.length > 50 ? [`…共 ${v.length} 项`] : []);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shorten(x, depth + 1)]));
  return v;
}

/** 请求体 / 响应文字 → 便于看的预览字符串（JSON 照样缩进，二进制只写大小）。 */
export function previewBody(body) {
  if (body === undefined || body === null) return '';
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    const lines = [];
    for (const [k, v] of body.entries()) lines.push(`${k}: ${typeof v === 'string' ? shortStr(v) : `<文件 ${v.name || ''} ${v.type || ''} ${kb(v.size || 0)}>`}`);
    return '[multipart]\n' + lines.join('\n');
  }
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) return `<二进制 ${kb(body.length)}>`;
  if (typeof body === 'string') {
    try { return JSON.stringify(shorten(JSON.parse(body)), null, 2); } catch { return shortStr(body); }
  }
  try { return JSON.stringify(shorten(body), null, 2); } catch { return String(body); }
}

function maskHeaders(h, secrets) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[k] = AUTH_HEADERS.has(k.toLowerCase()) ? tail(String(v).replace(/^(Bearer|Key)\s+/i, '')) : scrubSecrets(v, secrets);
  return out;
}
const cap = (s) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + `\n…<截断，共 ${s.length} 字>` : s);

/** http() 发请求前记一笔；回的记录对象等响应回来再补。超过上限的不再记（返回 null）。 */
export function traceEntry(sink, { label, method, url, headers, body }) {
  if (!Array.isArray(sink.entries) || sink.entries.length >= MAX_ENTRIES) return null;
  const secrets = sink.secrets || [];
  const rec = {
    step: label || '请求', method, url: scrubSecrets(url, secrets), at: Date.now(),
    request: { headers: maskHeaders(headers, secrets), body: cap(scrubSecrets(previewBody(body), secrets)) },
  };
  sink.entries.push(rec);
  return rec;
}

/** 响应回来了：状态码、类型、正文预览（text = null 表示是文件流，不读正文）。 */
export function traceResponse(sink, rec, res, text) {
  const secrets = sink.secrets || [];
  const type = (res.headers?.get?.('content-type') || '').split(';')[0].trim();
  const len = Number(res.headers?.get?.('content-length')) || 0;
  rec.ms = Date.now() - rec.at;
  rec.response = {
    status: res.status, type,
    body: text === null ? `<文件 ${type || ''}${len ? ' ' + kb(len) : ''}>` : cap(scrubSecrets(previewBody(text), secrets)),
  };
}
