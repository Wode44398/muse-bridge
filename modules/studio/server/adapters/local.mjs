// local 方言（图像）：本机 Qwen Image 2.1 worker（local-image.mjs；部署 / 启停在 /api/vertex/local-image/*，只有管理员）。
// 参数原样交给 generationSettings 校验（坏值整单 400）。续改：当前给的素材，没给就拿续改链上一张出图（同旧 handleLocalImage）。

import { LOCAL_IMAGE_MODEL, localImageStatus, generateLocalImage, generationSettings } from './local-image.mjs';
import { AdapterError } from './http.mjs';

export const localAdapter = {
  dialect: 'local',
  kinds: ['image'],

  async test() {
    const s = await localImageStatus();
    if (!s.installed) throw new AdapterError('本机还没装模型（设置里的「本机部署」先安装）');
    if (s.state !== 'ready') return { detail: s.state === 'off' ? '已安装，还没启动' : `状态：${s.state}` };
    return { detail: '模型就绪' };
  },

  async listModels() { return [{ id: LOCAL_IMAGE_MODEL, label: 'Qwen Image 2.1 · 本机', kind: 'image' }]; },

  async run(req, provider, ctx) {
    const p = req.params || {};
    const opts = generationSettings({ ...p, negativePrompt: req.negative || '' });
    let images = req.inputs.filter((x) => x.role === 'edit' || x.role === 'ref').map((x) => x.data);
    if (!images.length && req.thread?.turns?.length) images = [req.thread.turns[req.thread.turns.length - 1].data];
    if (images.reduce((n, b) => n + b.length, 0) > 100_000_000) throw new AdapterError('参考图超过内部大小预算');
    const results = await generateLocalImage({
      prompt: req.prompt, images, aspectRatio: p.aspectRatio || 'auto', imageSize: p.imageSize || '2K', width: p.width, height: p.height, ...opts,
      onProgress: (s) => ctx.progress({
        progress: s.steps ? Math.min(0.99, ((s.batchIndex || 1) - 1 + (s.step || 0) / s.steps) / (s.count || 1)) : undefined,
        detail: { step: s.step || 0, steps: s.steps || 0, batchIndex: s.batchIndex || 1, count: s.count || 1, phase: s.phase || '' },
      }),
    });
    return { assets: results.map(({ bytes, mime, ...details }) => ({ bytes, mime, meta: details })) };
  },
};
