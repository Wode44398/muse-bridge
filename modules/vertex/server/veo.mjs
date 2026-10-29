// Drive Google Veo (video generation) through Vertex AI from the bridge.
//
// Unlike chat, Veo is a long-running operation: generateVideos() returns an
// operation we must poll (getVideosOperation) until done — typically 1-3 min.
// IMPORTANT: media models (Veo/Imagen/Lyria) are NOT served on the 'global'
// endpoint; they live on a regional one (us-central1). So this uses its own
// client/location, separate from the chat driver's 'global'.
import { vertexGenAI, vertexClientKey } from './google-clients.mjs';

const clients = new Map();
function client(project, location) {
  const key = vertexClientKey(project, location);
  let ai = clients.get(key);
  if (!ai) { ai = vertexGenAI({ project, location }); clients.set(key, ai); }
  return ai;
}

/**
 * Generate one or more videos and wait for completion.
 * @returns {Promise<Array<{ videoBytes?: string, uri?: string, mimeType?: string }>>}
 *   the `video` objects from each generated result.
 */
export async function generate({
  prompt, image, lastFrame, referenceImages, model,
  aspectRatio, durationSeconds, resolution, generateAudio, negativePrompt, numberOfVideos = 1,
  enhancePrompt, compressionQuality,
  project, location, onProgress, signal, pollMs = 8000, timeoutMs = 600000,
}) {
  const ai = client(project, location);
  const config = {};
  if (numberOfVideos) config.numberOfVideos = numberOfVideos;
  if (aspectRatio) config.aspectRatio = aspectRatio;
  if (durationSeconds) config.durationSeconds = Number(durationSeconds);
  if (resolution) config.resolution = resolution;
  if (typeof generateAudio === 'boolean') config.generateAudio = generateAudio;
  if (negativePrompt) config.negativePrompt = negativePrompt;
  // 提示词增强（Vertex 侧默认开）：只有显式关掉才传 false，别用 truthy 判断吞掉它。
  if (typeof enhancePrompt === 'boolean') config.enhancePrompt = enhancePrompt;
  // 画质：OPTIMIZED（体积小）/ LOSSLESS。传错值 Vertex 会 400「Invalid compression
  // quality type」——枚举由 capabilities 夹紧，这里只透传。
  if (compressionQuality) config.compressionQuality = compressionQuality;
  if (signal) config.abortSignal = signal;
  // 尾帧（首尾插值）+ 参考图（asset 素材，最多 3 张）——{ imageBytes, mimeType } 内联。
  if (lastFrame) config.lastFrame = lastFrame;
  if (referenceImages && referenceImages.length) {
    config.referenceImages = referenceImages.slice(0, 3).map((img) => ({ image: img, referenceType: 'ASSET' }));
  }

  const params = { model, config };
  if (prompt) params.prompt = prompt;
  if (image) params.image = image; // { imageBytes, mimeType } (inline) or { gcsUri, mimeType }

  let op = await ai.models.generateVideos(params);
  const start = Date.now();
  while (!op.done) {
    if (signal && signal.aborted) throw new Error('aborted');
    if (Date.now() - start > timeoutMs) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, pollMs));
    if (onProgress) onProgress(Math.round((Date.now() - start) / 1000));
    op = await ai.operations.getVideosOperation({ operation: op });
  }
  if (op.error) throw new Error('Veo 生成失败：' + JSON.stringify(op.error).slice(0, 300));
  const vids = (op.response && op.response.generatedVideos) || [];
  return vids.map((g) => g && g.video).filter(Boolean);
}

// Download a generated video's bytes. On Vertex the result is usually inline
// base64 (videoBytes); if only a uri is present, fetch it via the SDK's file
// downloader (handles auth). Returns a Buffer.
export async function fetchBytes(video, project, location) {
  if (video && video.videoBytes) return Buffer.from(video.videoBytes, 'base64');
  if (video && video.uri) {
    const ai = client(project, location);
    // ai.files.download writes to a path; capture to a temp then read — but
    // simplest portable path: fetch the uri with the SDK download helper.
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs/promises');
    const dest = path.join(tmpdir(), 'veo-' + Date.now() + '.mp4');
    await ai.files.download({ file: video, downloadPath: dest });
    const buf = await fs.readFile(dest);
    fs.unlink(dest).catch(() => {});
    return buf;
  }
  throw new Error('Veo 返回里既没有 videoBytes 也没有 uri');
}
