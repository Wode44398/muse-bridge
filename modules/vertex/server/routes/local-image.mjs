import { readFileSync } from 'node:fs';
import { requireCtx } from '@bridge/core/runtime/identity.mjs';
import { readBody } from '@bridge/core/runtime/body.mjs';
import { writeSseHeaders, sseWrite, startHeartbeat } from '@bridge/core/runtime/sse.mjs';
import { ID_RE } from '@bridge/core/jsonfile.mjs';
import * as media from '@bridge/core/vertex-media.mjs';
import { LOCAL_IMAGE_MODEL, localImageStatus, controlLocalImage, generateLocalImage, generationSettings } from '../local-image.mjs';

const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };

export function registerLocalImageRoutes(router, { identify }) {
  for (const action of ['status', 'start', 'stop', 'settings']) {
    router.on(action === 'status' ? 'GET' : 'POST', `/api/vertex/local-image/${action}`, async (req, res) => {
      const ctx = requireCtx(identify, req, res); if (!ctx) return;
      if (identify(req).kind !== 'admin') return json(res, 403, { error: 'Only the administrator can manage the local image deployment' });
      try {
        const value = action === 'settings' ? JSON.parse(await readBody(req, 4096)) : undefined;
        const result = action === 'status' ? await localImageStatus() : await controlLocalImage(action, value);
        json(res, 200, { ok: true, ...result });
      } catch (error) { json(res, 400, { ok: false, error: error.message }); }
    });
  }
}

// Shared by the existing one-shot endpoint and the streaming image-chat route.
export async function handleLocalImage(req, res, { ctx, parsed, ownUpload, stream = false }) {
  const prompt = String(parsed.message ?? parsed.prompt ?? '').trim();
  const sessionId = typeof parsed.sessionId === 'string' && ID_RE.test(parsed.sessionId) ? parsed.sessionId : media.newId();
  let hb, images = [], opts;
  try {
    if (!prompt || prompt.length > 12000) throw new Error('A prompt of 1–12000 characters is required');
    opts = generationSettings(parsed);
    const paths = parsed.images ?? (parsed.image ? [parsed.image] : []);
    if (!Array.isArray(paths) || paths.length > 10) throw new Error('Reference images must be an array of at most 10 uploads');
    if (paths.length) {
      for (const file of paths) {
        if (typeof file !== 'string' || !ownUpload(file, ctx)) throw new Error('Reference image is not in your uploads');
        images.push(readFileSync(file));
      }
      if (images.reduce((sum, image) => sum + image.length, 0) > 20_000_000) throw new Error('Reference uploads exceed 20 MB');
    } else if (parsed.referenceId) {
      const record = media.get(String(parsed.referenceId), ctx.media);
      const file = media.fileFor(String(parsed.referenceId), ctx.media);
      if (!file || record?.kind !== 'image') throw new Error('Selected reference image is unavailable');
      images.push(readFileSync(file));
    } else {
      // Latest successful image is the visual state of this editing conversation.
      const last = (Array.isArray(parsed.turns) ? parsed.turns : []).filter(row => row?.imageId).at(-1);
      if (last) {
        const record = media.get(String(last.imageId), ctx.media);
        const file = media.fileFor(String(last.imageId), ctx.media);
        if (!file || record?.kind !== 'image') throw new Error('Previous image is unavailable');
        images.push(readFileSync(file));
      }
    }
    if (images.reduce((sum, image) => sum + image.length, 0) > 100_000_000) throw new Error('Previous generated image exceeds the internal reference size budget');
    if (stream) {
      writeSseHeaders(res); hb = startHeartbeat(res);
      sseWrite(res, { type: 'start', sessionId, model: LOCAL_IMAGE_MODEL });
    }
    const results = await generateLocalImage({ prompt, images, aspectRatio: parsed.aspectRatio || 'auto', imageSize: parsed.imageSize || '2K', width: parsed.width, height: parsed.height, ...opts,
      onProgress: progress => { if (stream && !res.destroyed) sseWrite(res, { type: 'progress', ...progress }); } });
    const batchId = media.newId();
    const outputs = results.map((result, batchIndex) => {
      const id = media.newId();
      const { bytes, mime, ...details } = result;
      media.save(id, bytes, 'png', { kind: 'image', prompt, model: LOCAL_IMAGE_MODEL, sessionId, batchId, batchIndex, ...details }, ctx.media);
      return { id, url: '/api/vertex/media?id=' + id, ...details };
    });
    const response = { ok: true, ...outputs[0], images: outputs, sessionId };
    if (stream) sseWrite(res, { type: 'image', ...response });
    else json(res, 200, response);
  } catch (error) {
    if (stream && res.headersSent) sseWrite(res, { type: 'error', message: error.message });
    else json(res, 400, { ok: false, error: error.message });
  } finally {
    clearInterval(hb);
    if (stream && !res.writableEnded) res.end();
  }
}
