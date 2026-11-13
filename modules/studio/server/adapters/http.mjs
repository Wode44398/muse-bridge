// 各 HTTP 方言适配器共用的小件：鉴权头、带超时 / 取消的 fetch、错误归一、异步轮询、下载结果文件。
//
// 进程内 fetch 走 net-proxy 设的全局 dispatcher（出站代理）；成员自己的服务由调用方传 publicDispatcher（连接时再查一遍
// 不是内网，防 DNS rebinding，见 src/runtime/public-net.mjs）。

export class AdapterError extends Error {
  constructor(message, { status = 0, code = '', detail = '' } = {}) { super(message); this.status = status; this.code = code; this.detail = detail; }
}

/** 按服务的鉴权方式拼请求头（自定义头在前，鉴权头不许被覆盖）。 */
export function authHeaders(provider, key, extra = {}) {
  const h = { ...(provider.headers || {}), ...extra };
  if (!key) return h;
  switch (provider.authStyle) {
    case 'bearer': h.Authorization = `Bearer ${key}`; break;
    case 'x-goog-api-key': h['x-goog-api-key'] = key; break;
    case 'fal-key': h.Authorization = `Key ${key}`; break;
    case 'xi-api-key': h['xi-api-key'] = key; break;
    case 'x-api-key': h['x-api-key'] = key; break;
    default: break;
  }
  return h;
}

export const joinUrl = (base, p) => String(base || '').replace(/\/+$/, '') + '/' + String(p || '').replace(/^\/+/, '');

// 上游报错里常见的几种 → 一句人话；原文留在 detail
export function explainHttp(status, text) {
  const low = String(text || '').toLowerCase();
  if (status === 401 || /invalid api key|incorrect api key|unauthorized|invalid_api_key|authentication/.test(low)) return 'API Key 无效或没权限';
  if (status === 402 || /insufficient|balance|credit|quota exceeded|payment/.test(low)) return '余额不足或额度用完了';
  if (status === 403) return '没有权限（Key 没开通这个模型或接口）';
  if (status === 404) return '接口或模型不存在（检查地址和模型 id）';
  if (status === 413) return '请求太大（参考素材太多或太大）';
  if (status === 422 || status === 400) return '';   // 参数错：原文最有用
  if (status === 429) return '被限流了，稍后再试';
  if (status >= 500) return '服务方出错了，稍后再试';
  return '';
}

function upstreamMessage(j, text) {
  if (j && typeof j === 'object') {
    const e = j.error ?? j.detail ?? j.message ?? j.base_resp?.status_msg;
    if (typeof e === 'string') return e;
    // FastAPI 类的 422：detail 是 [{ loc, msg, type }] 数组
    if (Array.isArray(e)) return e.map((d) => (d && (d.msg || d.message)) || JSON.stringify(d)).join('；').slice(0, 300);
    if (e && typeof e === 'object') return e.message || e.msg || JSON.stringify(e).slice(0, 300);
  }
  return String(text || '').replace(/\s+/g, ' ').slice(0, 300);
}

/**
 * fetch + 超时 + 取消 + 错误归一。json:true 时解析 JSON（非 2xx 一律抛 AdapterError，带上游原话）。
 * opts: { method, headers, body(对象自动 JSON), timeoutMs, signal, dispatcher, raw:true（返回 Response 不解析）, label }
 */
export async function http(url, { method = 'GET', headers = {}, body, timeoutMs = 120_000, signal, dispatcher, raw = false, label = '' } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new AdapterError(`${label || '请求'}超过 ${Math.round(timeoutMs / 1000)} 秒没有回应`, { code: 'timeout' })), timeoutMs);
  const onAbort = () => ac.abort(signal.reason || new AdapterError('已取消', { code: 'aborted' }));
  if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
  const isForm = typeof FormData !== 'undefined' && body instanceof FormData;
  const isBuf = Buffer.isBuffer(body) || body instanceof Uint8Array;
  try {
    let res;
    try {
      res = await fetch(url, {
        method, signal: ac.signal,
        headers: { ...(body !== undefined && !isForm && !isBuf ? { 'Content-Type': 'application/json' } : {}), ...headers },
        ...(body !== undefined ? { body: isForm || isBuf || typeof body === 'string' ? body : JSON.stringify(body) } : {}),
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (e) {
      if (ac.signal.aborted) throw ac.signal.reason instanceof Error ? ac.signal.reason : new AdapterError('已取消', { code: 'aborted' });
      const why = String(e?.cause?.code || e?.cause?.message || e?.message || e);
      throw new AdapterError(`连不上服务（${why}）`, { code: 'network', detail: why });
    }
    if (raw) {
      if (!res.ok) { const t = await res.text().catch(() => ''); throw httpError(res.status, t, label); }
      return res;
    }
    const text = await res.text();
    let j = null; try { j = text ? JSON.parse(text) : null; } catch {}
    if (!res.ok) throw httpError(res.status, text, label, j);
    return j ?? text;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// 回来的是网页（地址填错、落到了网站首页 / 网关错误页）：原文不拼进报错，只给一句人话
const looksHtml = (t) => /^\s*(<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>])/i.test(String(t || ''));

function httpError(status, text, label, j) {
  let parsed = j;
  if (parsed === undefined) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
  if (!parsed && looksHtml(text)) {
    const hint = explainHttp(status, '') || '请求失败';
    return new AdapterError(`${label ? label + ' ' : ''}${status}：${hint}（对方回的是网页，不是接口——检查接口地址）`, { status, detail: '' });
  }
  const up = upstreamMessage(parsed, text);
  const hint = explainHttp(status, up);
  return new AdapterError(`${label ? label + ' ' : ''}${status}：${hint ? hint + (up ? '（' + up.slice(0, 200) + '）' : '') : (up || '请求失败')}`, { status, detail: up });
}

/** 下载结果文件（图片 / 视频 / 音频 URL）→ { bytes, mime }。 */
export async function download(url, { headers = {}, timeoutMs = 300_000, signal, dispatcher, label = '下载结果' } = {}) {
  if (/^data:/.test(url)) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (!m) throw new AdapterError('结果的 data URL 解析不了');
    return { bytes: m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3])), mime: m[1] || 'application/octet-stream' };
  }
  const res = await http(url, { headers, timeoutMs, signal, dispatcher, raw: true, label });
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, mime: (res.headers.get('content-type') || '').split(';')[0].trim() || guessMime(url) };
}

export function guessMime(name) {
  const ext = String(name || '').split('?')[0].split('.').pop().toLowerCase();
  return { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', pcm: 'audio/L16' }[ext] || 'application/octet-stream';
}

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener?.('abort', () => { clearTimeout(t); reject(new AdapterError('已取消', { code: 'aborted' })); }, { once: true });
});

/**
 * 异步任务轮询：check() → { done, failed?, value?, error?, progress? }；按间隔查到完成 / 失败 / 超时。
 * onTick({ elapsed, progress }) 每查一次报一次进度。
 */
export async function poll(check, { intervalMs = 4000, timeoutMs = 900_000, signal, onTick, label = '任务' } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (signal?.aborted) throw new AdapterError('已取消', { code: 'aborted' });
    const r = await check();
    if (r && r.done) return r.value;
    if (r && r.failed) throw new AdapterError(`${label}失败：${r.error || '服务方没给原因'}`, { detail: r.error || '' });
    const elapsed = Math.round((Date.now() - t0) / 1000);
    onTick?.({ elapsed, progress: r?.progress });
    if (Date.now() - t0 > timeoutMs) throw new AdapterError(`${label}超过 ${Math.round(timeoutMs / 60000)} 分钟还没完成`, { code: 'timeout' });
    await sleep(intervalMs, signal);
  }
}

/** 轮询查询时的瞬时错误（网络抖动、5xx、429、单次查询超时）：跳过这一轮，下一轮再查——钱已经花了，别因一次抖动丢结果。 */
export const isTransient = (e) => !!e && e.code !== 'aborted' && (e.code === 'network' || e.code === 'timeout' || e.status === 429 || e.status >= 500);
/** 异步任务（视频 / 音乐）整体等待上限：排队加生成常超过 10 分钟，至少 30 分钟（单个请求的超时另算）。 */
export const longWaitMs = (provider) => Math.max(1800, Number(provider?.timeoutSec) || 600) * 1000;

export const dataUrl = (buf, mime) => `data:${mime || 'application/octet-stream'};base64,${Buffer.from(buf).toString('base64')}`;
export const sleepMs = sleep;
