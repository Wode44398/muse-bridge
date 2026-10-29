// Image generation through Vertex AI: two families, routed by model id.
//  - Imagen (imagen-*)         -> ai.models.generateImages (text-to-image, fast)
//  - Nano Banana (gemini-*image*) -> ai.models.generateContent with IMAGE
//    modality; also supports image EDITING (pass an input image) and 1K/2K/4K.
// Like Veo, these live on the regional media endpoint (us-central1), not global.
// Synchronous (no long-running operation) — returns the image bytes directly.
import { vertexGenAI, geminiGenAI, vertexClientKey } from './google-clients.mjs';
import { GEMINI_API_KEY } from '@bridge/core/config/index.mjs';
import { vertexSafetySettings, safetyBlockNote } from '@bridge/core/runtime/vertex-settings.mjs';
import { CAPABILITIES } from '@bridge/core/config/capabilities.mjs';

const clients = new Map();
function client(project, location) {
  const key = vertexClientKey(project, location);
  let ai = clients.get(key);
  if (!ai) { ai = vertexGenAI({ project, location }); clients.set(key, ai); }
  return ai;
}

const isImagen = (model) => /^imagen/.test(model);

// 2K / 4K 改走 Gemini Developer API 的模型（caps.image.devBig）：Nano Banana 2.1 在 Vertex 上 2K/4K 实际只出 1K
// （2026-10-06 真打 1024² / 1376×768），dev API 同模型真出 2048² / 5504×3072（JPEG）。扣的是 dev key 的预付费额度。
// dev API 不认 imageConfig.personGeneration（400 Unknown name），走这条路时丢掉；跨通道续改（Vertex 出图 → dev 续改 → 再回 Vertex）实测都通。
const DEV_BIG = new Set(CAPABILITIES.image.devBig || []);
export const viaDevApi = (model, imageSize) => !!GEMINI_API_KEY && DEV_BIG.has(model) && (imageSize === '2K' || imageSize === '4K');
let devClient = null, devKey = null;
function pickClient(model, imageSize, project, location) {
  if (!viaDevApi(model, imageSize)) return { ai: client(project, location), dev: false };
  if (!devClient || devKey !== GEMINI_API_KEY) { devClient = geminiGenAI(GEMINI_API_KEY); devKey = GEMINI_API_KEY; }
  return { ai: devClient, dev: true };
}

// 没出图：被安全过滤拦下的说清原因，否则照旧
function noImageMessage(res) {
  const why = res?.promptFeedback?.blockReason || res?.candidates?.[0]?.finishReason;
  return safetyBlockNote(why) || 'Nano Banana 未返回图片（可能被安全策略拦截或只回了文字）';
}

/**
 * Generate one image.
 * @returns {Promise<{ bytes: Buffer, mime: string }>}
 */
export async function generate({ model, prompt, image, aspectRatio, imageSize, thinkingLevel, useSearch, useImageSearch, personGeneration, temperature, topP, project, location, signal }) {
  if (model === 'qwen-image-2.1-local') {
    const { generateLocalImage } = await import('./local-image.mjs');
    return generateLocalImage({ prompt, image: image?.imageBytes ? Buffer.from(image.imageBytes, 'base64') : undefined, aspectRatio, imageSize });
  }
  const { ai, dev } = pickClient(model, imageSize, project, location);

  if (isImagen(model)) {
    // Imagen: separate API (generateImages); ignores imageSize/thinking/tools entirely.
    const config = { numberOfImages: 1 };
    if (aspectRatio) config.aspectRatio = aspectRatio;
    if (signal) config.abortSignal = signal;
    const res = await ai.models.generateImages({ model, prompt, config });
    const g = (res.generatedImages || [])[0];
    if (!g || !g.image || !g.image.imageBytes) throw new Error('Imagen 未返回图片');
    return { bytes: Buffer.from(g.image.imageBytes, 'base64'), mime: g.image.mimeType || 'image/png' };
  }

  // Nano Banana (Gemini native image). Optional input image = editing. Also
  // supports (model-dependent, validated by the caller): thinkingConfig and
  // Google Search / Image Search grounding tools.
  const parts = [];
  if (image && image.imageBytes) parts.push({ inlineData: { data: image.imageBytes, mimeType: image.mimeType || 'image/png' } });
  parts.push({ text: prompt || '生成一张图片' });
  const imageConfig = {};
  if (aspectRatio) imageConfig.aspectRatio = aspectRatio;
  if (imageSize) imageConfig.imageSize = imageSize;
  // 人物生成：ALLOW_ALL / ALLOW_ADULT / ALLOW_NONE（Vertex ImageConfig 自己的枚举，
  // 与 Imagen 的 PersonGeneration 不是一套——传 DONT_ALLOW 会 400）。
  if (personGeneration && !dev) imageConfig.personGeneration = personGeneration;
  const config = { responseModalities: ['TEXT', 'IMAGE'], imageConfig };
  if (typeof temperature === 'number') config.temperature = temperature;
  if (typeof topP === 'number') config.topP = topP;
  if (thinkingLevel) config.thinkingConfig = { thinkingLevel };
  // Image Search implies web search (it's a searchType under googleSearch).
  if (useImageSearch) config.tools = [{ googleSearch: { searchTypes: { webSearch: {}, imageSearch: {} } } }];
  else if (useSearch) config.tools = [{ googleSearch: {} }];
  const safety = vertexSafetySettings();   // 内容安全过滤（设置 › Agent › Gemini）；没改过不带
  if (safety) config.safetySettings = safety;
  if (signal) config.abortSignal = signal;
  const res = await ai.models.generateContent({ model, contents: [{ role: 'user', parts }], config });
  for (const part of (res.candidates?.[0]?.content?.parts || [])) {
    if (part.inlineData && part.inlineData.data) {
      return { bytes: Buffer.from(part.inlineData.data, 'base64'), mime: part.inlineData.mimeType || 'image/png' };
    }
  }
  throw new Error(noImageMessage(res));
}

// 多轮对话式图像编辑（Nano Banana）：传入完整 contents 历史（user 文字 + model 图 + thoughtSignature），
// 模型带视觉上下文续改，返回新图 + 它的 thoughtSignature（下一轮需带回）。仅 Nano Banana（generateContent）。
export async function generateChat({ model, contents, aspectRatio, imageSize, thinkingLevel, useSearch, useImageSearch, personGeneration, temperature, topP, outputFormat, project, location, signal }) {
  const { ai, dev } = pickClient(model, imageSize, project, location);
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
  if (useImageSearch) config.tools = [{ googleSearch: { searchTypes: { webSearch: {}, imageSearch: {} } } }];
  else if (useSearch) config.tools = [{ googleSearch: {} }];
  const safety = vertexSafetySettings();   // 内容安全过滤（设置 › Agent › Gemini）；没改过不带
  if (safety) config.safetySettings = safety;
  if (signal) config.abortSignal = signal;
  const res = await ai.models.generateContent({ model, contents, config });
  const parts = res.candidates?.[0]?.content?.parts || [];
  const imgPart = parts.find((p) => p.inlineData?.data);
  if (!imgPart) throw new Error(noImageMessage(res));
  return { bytes: Buffer.from(imgPart.inlineData.data, 'base64'), mime: imgPart.inlineData.mimeType || 'image/png', signature: imgPart.thoughtSignature || '' };
}
