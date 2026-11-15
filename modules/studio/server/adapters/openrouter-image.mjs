// OpenAI GPT Image（gpt-image-2.5-sunburst 等）经 OpenRouter 出图：POST /api/v1/images（chat/completions 对图像专用模型 404）。
// 2026-11-04 真打定下的方言：
//  - 像素只认 size:'WxH'——resolution 被忽略（默认出 1536×864），size:'2K' 直接 400；
//    宽高须是 16 的倍数、最长边 ≤3840、总像素 ≤3840×2160（3840² 报 pixel budget）。显式 size 时不再带 aspect_ratio（会冲突）。
//  - 改图 / 续改：input_references=[{type:'image_url',image_url:{url:dataURL}}]（≤16 张），实测保构图只改指定处。
//  - 返回 data[].b64_json + media_type（2026-11-15 起每张都收）；没有思考/搜索/采样/人物生成参数。
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

// 2026-11-15 查证的 /api/v1/images 字段（GPT Image）：n 1–10（上限，服务商可少回）、output_format png/jpeg/webp（2.6 另有 gif）、
// background、output_compression（只 jpeg / webp，其它格式 OpenAI 会拒）、frame_count 2–16 / frame_duration_ms 20–2000（gif）；
// moderation / complexity 是 OpenAI 端点的透传参数，写在 provider.options.openai 下（不认的键静默丢弃）。
// gif 时显式 size 可能超雪碧图预算被拒：gif 且尺寸「自动」不传 size，让上游自己定帧尺寸。
const FMT_MIME = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
const QUALITY_OK = (q) => q === 'auto' || IMG_QUALITIES.has(q);
const intIn = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : undefined; };

/**
 * size：显式像素 'WxH'（自由尺寸卡）；null = 自动（不传）；undefined = 旧写法（按 aspectRatio + imageSize 算）。
 * @param {{ model: string, prompt: string, refs?: {data: string, mimeType: string}[], aspectRatio?: string, imageSize?: string, size?: string|null, quality?: string, signal?: AbortSignal,
 *   count?: number, outputFormat?: string, outputCompression?: number, frameCount?: number, frameDurationMs?: number, background?: string,
 *   moderation?: string, complexity?: string,
 *   apiKey: string, baseUrl?: string, headers?: object, extra?: object, timeoutMs?: number, dispatcher?: object }} o
 *   model = OpenRouter 的模型 id（如 openai/gpt-image-2.5-sunburst；旧本地 id 按 IMG_OPENROUTER 换算）
 * @returns {Promise<{ images: { bytes: Buffer, mime: string }[] }>} data[] 里每张都收（n>1 时服务商可能少回）
 */
export function openRouterImageBody({ model, prompt, refs = [], aspectRatio, imageSize, quality, size: sizeIn, count, outputFormat, outputCompression, frameCount, frameDurationMs, background, moderation, complexity, extra }) {
  const fmt = typeof outputFormat === 'string' && FMT_MIME[outputFormat] ? outputFormat : undefined;
  const gif = fmt === 'gif';
  const body = { model: IMG_OPENROUTER[model] || model, prompt: prompt || '生成一张图片', n: intIn(count, 1, 10) || 1, quality: QUALITY_OK(quality) ? quality : 'high' };
  if (fmt) body.output_format = fmt;
  if (fmt === 'jpeg' || fmt === 'webp') { const c = intIn(outputCompression, 0, 100); if (c !== undefined) body.output_compression = c; }
  if (gif) {
    const fc = intIn(frameCount, 2, 16); if (fc !== undefined) body.frame_count = fc;
    const fd = intIn(frameDurationMs, 20, 2000); if (fd !== undefined) body.frame_duration_ms = Math.min(2000, Math.max(20, Math.round(fd / 10) * 10));
  }
  if (typeof background === 'string' && background && background !== 'auto') body.background = background;
  const pass = {};
  if (typeof moderation === 'string' && moderation && moderation !== 'auto') pass.moderation = moderation;
  if (typeof complexity === 'string' && complexity) pass.complexity = complexity;
  Object.assign(body, extra || {});
  // 透传参数并进 provider.options.openai；extra 里同名的键优先（用户手写的原始参数说了算）
  if (Object.keys(pass).length) {
    const pv = body.provider && typeof body.provider === 'object' ? body.provider : {};
    const po = pv.options && typeof pv.options === 'object' ? pv.options : {};
    body.provider = { ...pv, options: { ...po, openai: { ...pass, ...(po.openai && typeof po.openai === 'object' ? po.openai : {}) } } };
  }
  // size 显式给了（自由尺寸卡）：字符串原样发、null = 自动（不传）；没给走旧写法——
  // 比例：显式比例照算；「自动」有参考图就跟参考图（gif 除外：让上游定帧尺寸），没图就不传 size（模型自选，约 1.5K）
  if (sizeIn !== undefined) {
    if (sizeIn) body.size = sizeIn;
  } else {
    let ratio = aspectRatio && aspectRatio !== 'auto' ? aspectRatio : null;
    if (!ratio && refs.length && !gif) ratio = imageDims(Buffer.from(refs[refs.length - 1].data, 'base64'));
    const size = ratio ? sizeFor(imageSize || '2K', ratio) : undefined;
    if (size) body.size = size;
  }
  return body;
}

export async function generateOpenRouterImage(o) {
  const { refs = [], signal, apiKey, baseUrl = 'https://openrouter.ai/api/v1', headers = {}, timeoutMs = 300_000, dispatcher } = o;
  if (!apiKey) throw new Error('这个 OpenRouter 服务还没填 API Key');
  const body = openRouterImageBody(o);
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
    const data = Array.isArray(j?.data) ? j.data.filter((d) => d && typeof d.b64_json === 'string' && d.b64_json) : [];
    if (!res.ok || !data.length) {
      const msg = j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || text.slice(0, 300);
      throw Object.assign(new Error(`OpenRouter ${res.status}：${msg || '没有返回图片'}`), { status: res.status });
    }
    // mime：优先 media_type；没给按请求的格式兜底（gif / svg 不能被当成 png 存）
    const fallback = FMT_MIME[body.output_format] || 'image/png';
    return { images: data.map((d) => ({ bytes: Buffer.from(d.b64_json, 'base64'), mime: typeof d.media_type === 'string' && d.media_type ? d.media_type : fallback })) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', onAbort);
  }
}
