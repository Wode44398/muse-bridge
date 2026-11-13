// OpenAI GPT Image（gpt-image-2.5-sunburst 等）经 OpenRouter 出图：POST /api/v1/images（chat/completions 对图像专用模型 404）。
// 2026-11-04 真打定下的方言：
//  - 像素只认 size:'WxH'——resolution 被忽略（默认出 1536×864），size:'2K' 直接 400；
//    宽高须是 16 的倍数、最长边 ≤3840、总像素 ≤3840×2160（3840² 报 pixel budget）。显式 size 时不再带 aspect_ratio（会冲突）。
//  - 改图 / 续改：input_references=[{type:'image_url',image_url:{url:dataURL}}]（≤16 张），实测保构图只改指定处。
//  - 返回 data[0].b64_json + media_type；output_format 可 png/jpeg/webp。没有思考/搜索/采样/人物生成参数。
// 进程内 fetch 走 net-proxy 设的全局 dispatcher，出站代理不用另管（成员自己的服务由调用方传 publicDispatcher）。
// 2026-11-04 起是 Media Studio openrouter 方言的驱动：Key、地址、模型 id 都由服务传进来，不再读全局配置。
import { IMG_OPENROUTER, IMG_QUALITIES } from '@bridge/core/config/capabilities.mjs';

export const isOpenRouterImage = (model) => Object.prototype.hasOwnProperty.call(IMG_OPENROUTER, model);

const EDGE = { '1K': 1024, '2K': 2048, '4K': 3840 };
const MAX_PIXELS = 3840 * 2160;
const MAX_EDGE = 3840;
// 2026-11-05 真打：2.5 / 2.6 Sunburst 都有最低像素预算 655360（1024×640 过、1024×624 400「below the current minimum pixel budget」）
// ——1K 档非方图（16:9 = 1024×576）原先直接 400，低于预算时整体等比放大。
const MIN_PIXELS = 1024 * 640;
const down16 = (n) => Math.max(16, Math.floor(n / 16) * 16);
const up16 = (n) => Math.ceil(n / 16) * 16;

// 档位 + 比例（'16:9' 或 [w,h]）→ 合法的 'WxH'：长边取档位、按比例算短边，超像素预算整体等比缩，最后落 16 的倍数。
export function sizeFor(imageSize, ratio) {
  const r = Array.isArray(ratio) ? ratio : String(ratio || '').split(':').map(Number);
  const [rw, rh] = r;
  if (!(rw > 0 && rh > 0)) return undefined;
  let long = Math.min(EDGE[imageSize] || EDGE['2K'], MAX_EDGE);
  let w = rw >= rh ? long : long * rw / rh;
  let h = rw >= rh ? long * rh / rw : long;
  const k = Math.min(1, Math.sqrt(MAX_PIXELS / (w * h)));
  w = down16(w * k); h = down16(h * k);
  if (w * h < MIN_PIXELS) { const u = Math.sqrt(MIN_PIXELS / (w * h)); w = Math.min(MAX_EDGE, up16(w * u)); h = Math.min(MAX_EDGE, up16(h * u)); }
  return `${w}x${h}`;
}

// 读 PNG / JPEG / WebP 的宽高（「自动」比例 + 有参考图时，照参考图的比例出图）
export function imageDims(buf) {
  try {
    if (buf[0] === 0x89 && buf[1] === 0x50) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = buf.toString('ascii', 12, 16);
      if (fmt === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
      if (fmt === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
      if (fmt === 'VP8L') { const b = buf.readUInt32LE(21); return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)]; }
    }
  } catch {}
  return null;
}

/**
 * @param {{ model: string, prompt: string, refs?: {data: string, mimeType: string}[], aspectRatio?: string, imageSize?: string, quality?: string, signal?: AbortSignal,
 *   apiKey: string, baseUrl?: string, headers?: object, extra?: object, timeoutMs?: number, dispatcher?: object }} o
 *   model = OpenRouter 的模型 id（如 openai/gpt-image-2.5-sunburst；旧本地 id 按 IMG_OPENROUTER 换算）
 * @returns {Promise<{ bytes: Buffer, mime: string }>}
 */
export async function generateOpenRouterImage({ model, prompt, refs = [], aspectRatio, imageSize, quality, signal, apiKey, baseUrl = 'https://openrouter.ai/api/v1', headers = {}, extra, timeoutMs = 300_000, dispatcher }) {
  if (!apiKey) throw new Error('这个 OpenRouter 服务还没填 API Key');
  const body = { model: IMG_OPENROUTER[model] || model, prompt: prompt || '生成一张图片', n: 1, quality: IMG_QUALITIES.has(quality) ? quality : 'high', ...(extra || {}) };
  // 比例：显式比例照算；「自动」有参考图就跟参考图，没图就不传 size（模型自选，约 1.5K）
  let ratio = aspectRatio && aspectRatio !== 'auto' ? aspectRatio : null;
  if (!ratio && refs.length) ratio = imageDims(Buffer.from(refs[refs.length - 1].data, 'base64'));
  const size = ratio ? sizeFor(imageSize || '2K', ratio) : undefined;
  if (size) body.size = size;
  if (refs.length) body.input_references = refs.slice(-16).map((r) => ({ type: 'image_url', image_url: { url: `data:${r.mimeType || 'image/png'};base64,${r.data}` } }));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('OpenRouter 出图超过 ' + Math.round(timeoutMs / 60000) + ' 分钟没有返回')), timeoutMs);
  const onAbort = () => ac.abort(signal.reason);
  signal?.addEventListener?.('abort', onAbort, { once: true });
  try {
    const res = await fetch(String(baseUrl).replace(/\/+$/, '') + '/images', {
      method: 'POST',
      headers: { 'X-Title': 'bridge', ...headers, Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ac.signal,
      ...(dispatcher ? { dispatcher } : {}),
    });
    const text = await res.text();
    let j; try { j = JSON.parse(text); } catch { j = null; }
    if (!res.ok || !j?.data?.[0]?.b64_json) {
      const msg = j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || text.slice(0, 300);
      throw Object.assign(new Error(`OpenRouter ${res.status}：${msg || '没有返回图片'}`), { status: res.status });
    }
    const d = j.data[0];
    return { bytes: Buffer.from(d.b64_json, 'base64'), mime: d.media_type || 'image/png' };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
