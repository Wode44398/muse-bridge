// vertex / gemini 两个方言的适配器：调搬来的 Google 驱动（imagen / veo / omni / tts / music），把各家返回抹平成 { assets }。
//
// location 分裂（记忆 project_bridge_vertex_media，用钱换来的结论，别「统一化」）：
//   图像（Nano Banana generateContent）走服务的 location（默认 global）；Imagen、Veo、TTS、Lyria 走 mediaLocation（默认 us-central1）。
// gemini 方言 = Gemini Developer API Key：Nano Banana 2.1 的真 2K / 4K、Omni 1.1（只走 Interactions + background 轮询）、lyria-3 系列。
// vertex 方言里 2.1 选 2K / 4K 时借 dev key（ctx.devKey：同一主人的 Gemini API 服务的 Key，主机兜底 config 的 geminiApiKey），
// 没有就照走 Vertex（出 1K）——同旧行为。
// 凭据：credMode 'adc' = 主机的 Google 凭据链（设置页上传的 > GOOGLE_APPLICATION_CREDENTIALS > gcloud ADC）；
//       'json' = 这个服务自己的服务账号（成员只能用这个）。

import { VERTEX_PROJECT, VERTEX_LOCATION, VERTEX_MEDIA_LOCATION } from '@bridge/core/config/index.mjs';
import { CAPABILITIES, veoTaskOk, ttsMetaStyle } from '@bridge/core/config/capabilities.mjs';
import { GOOGLE_MODELS, GOOGLE_VOICES } from '../cards/google.mjs';
import { geminiGenAI, vertexAccessToken, vertexPing } from '@bridge/core/runtime/google-clients.mjs';
import { AdapterError } from './http.mjs';


/** 这个 vertex 服务实际用的项目 / 区域 / 凭据。 */
export function vertexTarget(provider, secret) {
  const g = provider.google || {};
  let credentials;
  if (g.credMode === 'json') {
    if (!secret.sa) throw new AdapterError('这个 Vertex 服务还没上传服务账号 JSON');
    try { credentials = JSON.parse(secret.sa); } catch { throw new AdapterError('服务账号 JSON 坏了，重新上传一份'); }
  }
  const project = g.project || (credentials ? credentials.project_id : VERTEX_PROJECT) || '';
  if (!project) throw new AdapterError('这个 Vertex 服务还没填 Google 项目 ID');
  return { project, location: g.location || VERTEX_LOCATION || 'global', mediaLocation: g.mediaLocation || VERTEX_MEDIA_LOCATION || 'us-central1', credentials };
}

const b64 = (buf) => Buffer.from(buf).toString('base64');
// 图像请求体的大小保护（参考图上限从 3 放宽到 14 张后加的）：内联图 base64 合计超过这个数，先丢续改链里最早的轮次，
// 还超就直接报错（不发出去、不计费）。只在参考图 + 改图超过 3 张时启用——3 张以内的请求行为同以前。
// 取 20MB：Gemini Developer API 的内联请求上限约 20MB，旧注释记的 Vertex 撞限也是这个量级（Vertex 页面现在写单个 part 256MB，未证实）。
const IMG_BODY_LIMIT = 20 * 1024 * 1024;
const OLD_REF_MAX = 3;
const b64Len = (n) => Math.ceil(n / 3) * 4;
/** 按大小保护裁剪续改链：回保留下来的轮次；参考图本身就超了抛 AdapterError。 */
export function fitImageBody(turns, inputs) {
  const refs = inputs.filter((x) => x.role === 'edit' || x.role === 'ref');
  if (refs.length <= OLD_REF_MAX) return turns;
  const refBytes = refs.reduce((n, x) => n + b64Len(x.data.length), 0);
  if (refBytes > IMG_BODY_LIMIT) throw new AdapterError(`参考图加起来太大（约 ${Math.round(refBytes / 1048576)}MB，上限约 20MB）：少给几张或先压小再试`);
  const kept = [...turns];
  let total = refBytes + kept.reduce((n, t) => n + b64Len(t.data.length), 0);
  while (kept.length && total > IMG_BODY_LIMIT) total -= b64Len(kept.shift().data.length);
  return kept;
}
// 卡上某个数字档位参数的最大值（Omni 时长上限按卡走：1.1 是 10 秒，1.2 经参照库精修到 15 秒）
const maxOption = (card, key) => {
  const vals = ((card?.params || []).find((s) => s.key === key)?.options || []).map((o) => Number(o.value)).filter(Number.isFinite);
  return vals.length ? Math.max(...vals) : undefined;
};

// 任务类型（不是 API 字段，按给的素材定）：参考图 → ref；首帧 + 尾帧 → interp；首帧 → i2v；什么都没有 → t2v
function videoTask(model, inputs) {
  const caps = CAPABILITIES.veo.imgCaps[model] || {};
  const has = (r) => inputs.some((x) => x.role === r);
  if (has('ref') && caps.ref && veoTaskOk(model, 'ref')) return 'ref';
  if (has('first') && has('last') && caps.last && veoTaskOk(model, 'interp')) return 'interp';
  if (has('first') && veoTaskOk(model, 'i2v')) return 'i2v';
  return 't2v';
}

export function googleAdapter(dialect) {
  const dev = dialect === 'gemini';
  return {
    dialect,
    kinds: ['image', 'video', 'speech', 'music'],

    // 测试连接：不花钱。vertex = 取令牌 + countTokens（同一条鉴权 + 项目 + 权限链路，不生成）；gemini = 列一页模型。
    async test(provider, { secret }) {
      if (dev) {
        if (!secret.key) throw new AdapterError('还没填 API Key');
        await geminiGenAI(secret.key).models.list({ config: { pageSize: 1 } });
        return { detail: 'Gemini API Key 有效' };
      }
      const t = vertexTarget(provider, secret);
      await vertexAccessToken(t.credentials);
      try { await vertexPing({ project: t.project, location: t.location, credentials: t.credentials }); }
      catch (e) {
        if (e && e.modelMissing) throw new AdapterError('鉴权通过了，但测试用的几个模型在这个项目 / 区域都调不通：可能已被 Google 下线，或项目还没有这些模型的访问权；换个区域试试，或更新 bridge');
        throw e;
      }
      return { detail: `项目 ${t.project} · ${t.location} / ${t.mediaLocation}` };
    },

    // 模型列表：内置清单（Google 目录列出 ≠ 能调用，判可用只有真打；所以不按远端目录加模型）。
    // gemini 方言另列一页远端目录里看着像媒体模型的（kind 拿不准给 null），供手动挑。
    async listModels(provider, { secret }) {
      const builtin = Object.entries(GOOGLE_MODELS[dialect]).flatMap(([kind, ids]) => ids.map((id) => ({ id, label: id, kind, builtin: true })));
      if (!dev || !secret.key) return builtin;
      const seen = new Set(builtin.map((m) => m.id));
      const out = [...builtin];
      try {
        const pager = await geminiGenAI(secret.key).models.list({ config: { pageSize: 200 } });
        for await (const m of pager) {
          const id = String(m.name || '').replace(/^models\//, '');
          if (!id || seen.has(id)) continue;
          const kind = /veo|omni/.test(id) ? 'video' : /imagen|image/.test(id) ? 'image' : /tts/.test(id) ? 'speech' : /lyria/.test(id) ? 'music' : null;
          if (!kind) continue;
          seen.add(id); out.push({ id, label: m.displayName || id, kind });
        }
      } catch (e) { throw new AdapterError('拉模型列表失败：' + ((e && e.message) || e)); }
      return out;
    },

    voices: () => GOOGLE_VOICES.map((v) => ({ id: v.value, label: v.label })),

    async run(req, provider, ctx) {
      const { secret, signal } = ctx;
      const kind = req.kind;
      const model = req.model;   // 手填的未知 Google 模型按种类走同一条路（参数只认通用卡给的）
      const t = dev ? null : vertexTarget(provider, secret);
      const apiKey = dev ? secret.key : '';
      if (dev && !apiKey) throw new AdapterError('这个 Gemini API 服务还没填 API Key');
      const p = req.params || {};

      if (kind === 'image') {
        const imagen = await import('./imagen.mjs');
        // 多轮：续改链（thread）里最近 6 轮的「用户的话 + 模型出的图 + thoughtSignature」；只带 6 张——每张 2K/4K 图 base64 后数 MB，
        // 全量重发几轮就撞 Vertex ~20MB 请求上限，此后该对话永久报错。
        const contents = [];
        for (const turn of fitImageBody((req.thread?.turns || []).slice(-6), req.inputs)) {
          if (turn.userText) contents.push({ role: 'user', parts: [{ text: String(turn.userText) }] });
          const part = { inlineData: { mimeType: turn.mime, data: b64(turn.data) } };
          if (turn.signature) part.thoughtSignature = turn.signature;
          contents.push({ role: 'model', parts: [part] });
        }
        const parts = req.inputs.filter((x) => x.role === 'edit' || x.role === 'ref').map((x) => ({ inlineData: { mimeType: x.mime, data: b64(x.data) } }));
        parts.push({ text: req.prompt || '生成一张图片' });
        contents.push({ role: 'user', parts });
        const r = await imagen.generateChat({
          model, contents,
          aspectRatio: p.aspectRatio === 'auto' ? undefined : p.aspectRatio,
          imageSize: p.imageSize, thinkingLevel: p.thinkingLevel, useSearch: p.useSearch, useImageSearch: p.useImageSearch,
          personGeneration: p.personGeneration, temperature: p.temperature, topP: p.topP, outputFormat: p.outputFormat,
          seed: p.seed, outputMimeType: p.outputMimeType, compressionQuality: p.compressionQuality, prominentPeople: p.prominentPeople,
          project: t?.project, location: t ? (/^imagen/.test(model) ? t.mediaLocation : t.location) : undefined, credentials: t?.credentials,
          devKey: dev ? apiKey : ctx.devKey, forceDev: dev, signal,
        });
        return { assets: [{ bytes: r.bytes, mime: r.mime, meta: { signature: r.signature || '', ...(r.dev && !dev ? { channel: 'gemini-api' } : {}) } }] };
      }

      if (kind === 'video') {
        const first = req.inputs.find((x) => x.role === 'first');
        const img = (x) => (x ? { imageBytes: b64(x.data), mimeType: x.mime } : undefined);
        // 同族继承来的新模型（§9.3）：任务类型等能力按父模型的矩阵查（卡上的参数本来就是父模型的）
        const task = videoTask(req.card?.inheritsFrom || model, req.inputs);
        const onProgress = (s) => ctx.progress({ elapsed: s });
        const last = req.inputs.find((x) => x.role === 'last');
        const capsOf = CAPABILITIES.veo.imgCaps[req.card?.inheritsFrom || model] || {};
        const refs = req.inputs.filter((x) => x.role === 'ref').slice(0, capsOf.ref || 3);
        if (/^gemini-omni/.test(model)) {
          if (!dev) throw new AdapterError('Omni 只走 Gemini API（Interactions），请用 Gemini API 服务');
          const omni = await import('./omni.mjs');
          const r = await omni.generate({
            model, prompt: req.prompt, task,
            image: task === 'i2v' || task === 'interp' ? img(first) : undefined,
            lastFrame: task === 'interp' ? img(last) : undefined,
            referenceImages: task === 'ref' && refs.length ? refs.map(img) : undefined,
            aspectRatio: p.aspectRatio, durationSeconds: p.durationSeconds, resolution: p.resolution, maxDuration: maxOption(req.card, 'durationSeconds'),
            seed: p.seed, apiKey, onProgress, onSubmit: () => ctx.submitted(), signal,
          });
          return { assets: [{ bytes: r.bytes, mime: r.mime, meta: { task } }] };
        }
        if (dev) throw new AdapterError('Veo 走 Vertex，请用 Google Vertex AI 服务');
        const veo = await import('./veo.mjs');
        const vids = await veo.generate({
          prompt: req.prompt, model,
          image: task === 'i2v' || task === 'interp' ? img(first) : undefined,
          lastFrame: task === 'interp' ? img(last) : undefined,
          referenceImages: task === 'ref' && refs.length ? refs.map(img) : undefined,
          aspectRatio: p.aspectRatio === 'auto' ? undefined : p.aspectRatio,
          durationSeconds: p.durationSeconds, generateAudio: p.generateAudio, numberOfVideos: p.count || 1,
          resolution: p.resolution, negativePrompt: req.negative || '', enhancePrompt: p.enhancePrompt, compressionQuality: p.compressionQuality,
          seed: p.seed, personGeneration: p.personGeneration,
          // 首帧适配只对图生视频有意义（卡按素材已经夹过，这里再按实际任务兜一层）
          resizeMode: task === 'i2v' || task === 'interp' ? p.resizeMode : undefined,
          project: t.project, location: t.mediaLocation, credentials: t.credentials,
          onProgress, onSubmit: () => ctx.submitted(), signal,
        });
        if (!vids.length) throw new AdapterError('Veo 没有返回视频');
        // 多条（count > 1）：每条都是一件作品
        const assets = [];
        for (const v of vids) assets.push({ bytes: await veo.fetchBytes(v, t.project, t.mediaLocation, t.credentials), mime: 'video/mp4', meta: { task } });
        return { assets };
      }

      if (kind === 'speech') {
        // gemini 方言（dev API Key）：同一套 generateContent + AUDIO（2026-11-06 起，Gemini API 的 models.list 列着 3.8 Flash TTS 等）
        const tts = await import('./tts.mjs');
        // 3.8 系列（含继承来的 3.8.x）的风格 / 说话人走 speechMetadata；按卡的父模型判断，免得继承卡丢了这条
        const metaStyle = ttsMetaStyle(model) || ttsMetaStyle(req.card?.inheritsFrom);
        const args = { model, text: req.prompt, style: p.style, voiceName: p.voice, speakers: p.speakers || null, languageCode: p.languageCode, metaStyle, signal };
        if (dev) return { assets: [await tts.generate({ ...args, apiKey })].map((r) => ({ bytes: r.bytes, mime: r.mime })) };
        // Vertex：先走媒体区；404（模型不在这个区，不计费）就换主区再来一次——2026-11-06 实测 3.8 Flash TTS 只在 global
        let r;
        try { r = await tts.generate({ ...args, project: t.project, location: t.mediaLocation, credentials: t.credentials }); }
        catch (e) {
          if (Number(e?.status) !== 404 || t.location === t.mediaLocation) throw e;
          r = await tts.generate({ ...args, project: t.project, location: t.location, credentials: t.credentials });
        }
        return { assets: [{ bytes: r.bytes, mime: r.mime }] };
      }

      if (kind === 'music') {
        const music = await import('./music.mjs');
        if (/^lyria-3/.test(model) && !dev) throw new AdapterError('lyria-3 系列只走 Gemini API，请用 Gemini API 服务');
        const images = req.inputs.filter((x) => x.role === 'ref').map((x) => ({ data: b64(x.data), mimeType: x.mime }));
        const r = await music.generate({
          model, prompt: req.prompt, negativePrompt: req.negative || '', seed: p.seed, count: p.count, outputFormat: p.outputFormat, images,
          project: t?.project, location: t?.mediaLocation, apiKey, credentials: t?.credentials, signal,
        });
        // 多条（lyria-002 的 count）每条一件作品；lyria-3 回复里的歌词 / 结构说明进作品侧车（lyrics）
        return { assets: r.clips.map((c) => ({ bytes: c.bytes, mime: c.mime, ...(r.lyrics ? { meta: { lyrics: r.lyrics } } : {}) })) };
      }
      throw new AdapterError('这个方言做不了「' + kind + '」');
    },
  };
}
