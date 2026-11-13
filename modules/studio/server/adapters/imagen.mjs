// Image generation through Vertex AI / Gemini Developer API: two families, routed by model id.
//  - Imagen (imagen-*)         -> ai.models.generateImages (text-to-image, fast)
//  - Nano Banana (gemini-*image*) -> ai.models.generateContent with IMAGE
//    modality; also supports image EDITING (pass an input image) and 1K/2K/4K.
// Synchronous (no long-running operation) — returns the image bytes directly.
// 2026-11-04 搬进 Media Studio：vertex / gemini 两个方言的适配器（adapters/google.mjs）调这里；
// 客户端按服务来——项目 / 区域 / 服务账号 / dev key 都由调用方传（不再读全局配置），
// GPT Image（OpenRouter）与本机 Qwen 各自是独立的方言适配器，不再从这里分流。
import { vertexGenAI, geminiGenAI, vertexClientKey } from '@bridge/core/runtime/google-clients.mjs';
import { studioSafetySettings as vertexSafetySettings, safetyBlockNote } from '@bridge/core/runtime/studio-settings.mjs';
import { CAPABILITIES } from '@bridge/core/config/capabilities.mjs';

const clients = new Map();
function client(project, location, credentials) {
  const key = vertexClientKey(project, location, credentials);
  let ai = clients.get(key);
  if (!ai) { ai = vertexGenAI({ project, location, credentials }); clients.set(key, ai); }
  return ai;
}
const devClients = new Map();
function devClient(apiKey) {
  let ai = devClients.get(apiKey);
  if (!ai) { ai = geminiGenAI(apiKey); devClients.set(apiKey, ai); }
  return ai;
}

const isImagen = (model) => /^imagen/.test(model);

// 2K / 4K 改走 Gemini Developer API 的模型（caps.image.devBig）：Nano Banana 2.1 在 Vertex 上 2K/4K 实际只出 1K
// （2026-10-06 真打 1024² / 1376×768），dev API 同模型真出 2048² / 5504×3072（JPEG）。扣的是 dev key 的预付费额度。
// dev API 不认 imageConfig.personGeneration（400 Unknown name），走这条路时丢掉；跨通道续改（Vertex 出图 → dev 续改 → 再回 Vertex）实测都通。
// 2026-11-08 存疑：当时取的是回复里第一张图（2.1 默认 medium 思考，第一张多半是 1K 思考草图，见 pickImagePart），
// 「Vertex 只出 1K」可能是同一个误判；真打复核前先不动这条绕道。
const DEV_BIG = new Set(CAPABILITIES.image.devBig || []);
export const viaDevApi = (model, imageSize, devKey) => !!devKey && DEV_BIG.has(model) && (imageSize === '2K' || imageSize === '4K');
// forceDev：gemini 方言（整个服务就是 dev API）；否则 vertex 方言，只有 devBig 的大尺寸借 dev key
function pickClient({ model, imageSize, project, location, credentials, devKey, forceDev }) {
  if (forceDev) {
    if (!devKey) throw new Error('这个服务还没填 Gemini API Key');
    return { ai: devClient(devKey), dev: true };
  }
  if (!viaDevApi(model, imageSize, devKey)) return { ai: client(project, location, credentials), dev: false };
  return { ai: devClient(devKey), dev: true };
}

// 没出图：被安全过滤拦下的说清原因，否则照旧
function noImageMessage(res) {
  const why = res?.promptFeedback?.blockReason || res?.candidates?.[0]?.finishReason;
  return safetyBlockNote(why) || 'Nano Banana 未返回图片（可能被安全策略拦截或只回了文字）';
}

/**
 * Generate one image (single turn).
 * @returns {Promise<{ bytes: Buffer, mime: string }>}
 */
export async function generate({ model, prompt, image, aspectRatio, imageSize, thinkingLevel, useSearch, useImageSearch, personGeneration, temperature, topP, project, location, credentials, devKey, forceDev, signal }) {
  if (isImagen(model) && !forceDev) {
    // Imagen: separate API (generateImages); ignores imageSize/thinking/tools entirely.
    const ai = client(project, location, credentials);
    const config = { numberOfImages: 1 };
    if (aspectRatio) config.aspectRatio = aspectRatio;
    if (signal) config.abortSignal = signal;
    const res = await ai.models.generateImages({ model, prompt, config });
    const g = (res.generatedImages || [])[0];
    if (!g || !g.image || !g.image.imageBytes) throw new Error('Imagen 未返回图片');
    return { bytes: Buffer.from(g.image.imageBytes, 'base64'), mime: g.image.mimeType || 'image/png' };
  }
  // Nano Banana (Gemini native image). Optional input image = editing.
  const parts = [];
  if (image && image.imageBytes) parts.push({ inlineData: { data: image.imageBytes, mimeType: image.mimeType || 'image/png' } });
  parts.push({ text: prompt || '生成一张图片' });
  const r = await generateChat({ model, contents: [{ role: 'user', parts }], aspectRatio, imageSize, thinkingLevel, useSearch, useImageSearch, personGeneration, temperature, topP, project, location, credentials, devKey, forceDev, signal });
  return { bytes: r.bytes, mime: r.mime };
}

// 从回复里挑成品图。会思考的 Nano Banana（Pro 恒思考，Flash / 2.1 开 high 或默认 medium 时也会）先出最多两张思考草图
// （1K、part.thought、没有 thoughtSignature），成品排在后面且带签名——取第一张图就拿到了草图
// （2026-11-07 Pro 请求 4K 实出 768×1376、续改链存的签名为空）。顺序：非思考且带签名 > 非思考里最后一张 > 全是思考就取最后一张
// （文档：思考里的最后一张就是成品）。不靠 includeThoughts 区分——Pro 收到 thinkingConfig 会 400。
export function pickImagePart(parts) {
  const imgs = (parts || []).filter((p) => p?.inlineData?.data);
  const out = imgs.filter((p) => !p.thought);
  return out.find((p) => p.thoughtSignature) || out[out.length - 1] || imgs[imgs.length - 1] || null;
}

// 多轮对话式图像编辑（Nano Banana）：传入完整 contents 历史（user 文字 + model 图 + thoughtSignature），
// 模型带视觉上下文续改，返回新图 + 它的 thoughtSignature（下一轮需带回）。仅 Nano Banana（generateContent）。
export async function generateChat({ model, contents, aspectRatio, imageSize, thinkingLevel, useSearch, useImageSearch, personGeneration, temperature, topP, outputFormat, project, location, credentials, devKey, forceDev, signal }) {
  const { ai, dev } = pickClient({ model, imageSize, project, location, credentials, devKey, forceDev });
  const imageConfig = {};
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
  if (imageSize) imageConfig.imageSize = imageSize;
  // 人物生成：ALLOW_ALL / ALLOW_ADULT / ALLOW_NONE（Vertex ImageConfig 自己的枚举，
  // 与 Imagen 的 PersonGeneration 不是一套——传 DONT_ALLOW 会 400）。
  if (personGeneration && !dev) imageConfig.personGeneration = personGeneration;
  const config = { responseModalities: outputFormat === 'image' ? ['IMAGE'] : ['TEXT', 'IMAGE'], imageConfig };
  if (typeof temperature === 'number') config.temperature = temperature;
  if (typeof topP === 'number') config.topP = topP;
  if (thinkingLevel) config.thinkingConfig = { thinkingLevel };
  // Image Search implies web search (it's a searchType under googleSearch).
  if (useImageSearch) config.tools = [{ googleSearch: { searchTypes: { webSearch: {}, imageSearch: {} } } }];
  else if (useSearch) config.tools = [{ googleSearch: {} }];
  const safety = vertexSafetySettings();   // 内容安全过滤（设置 › Media Studio）；没改过不带
  if (safety) config.safetySettings = safety;
  if (signal) config.abortSignal = signal;
  const res = await ai.models.generateContent({ model, contents, config });
  const parts = res.candidates?.[0]?.content?.parts || [];
  const imgPart = pickImagePart(parts);
  if (!imgPart) throw new Error(noImageMessage(res));
  return { bytes: Buffer.from(imgPart.inlineData.data, 'base64'), mime: imgPart.inlineData.mimeType || 'image/png', signature: imgPart.thoughtSignature || '', dev };
}
