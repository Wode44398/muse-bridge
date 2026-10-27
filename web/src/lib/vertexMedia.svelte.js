// Vertex 媒体生成控制器（图像 / 视频 / 语音 / 音乐）。
//  · 图像(image) / 语音(tts) 是同步 JSON POST → {ok,id,url}
//  · 视频(Veo) / 音乐(Lyria) 是 SSE 进度流（start/progress/video|music/error）——后端不进
//    currentGen 缓冲，故直接 fetch 读流（无 attach/重连，按秒计费跑完即存）。
//
// vmedia[func] 持有每模块的运行态/结果/历史；func ∈ image|video|voice|music。
// 历史端点用 api kind（voice→audio），媒体文件 URL 附 ?token（<img>/<video> 跨源带不了 header）。

import { api, authHeaders } from './api.js';
import { apiUrl } from './server.js';
import { caps, vertex as vs, hostIsServer } from './state.svelte.js';
import { t, tr } from './i18n.js';

export const vmedia = $state({
  image: { busy: false, elapsed: 0, error: '', turns: [], history: [], sessionId: null },   // 对话式：turns=[{userText,imageId}]，sessionId=当前修改链归并键
  video: { busy: false, elapsed: 0, result: null, error: '', history: [] },
  voice: { busy: false, elapsed: 0, result: null, error: '', history: [] },
  music: { busy: false, elapsed: 0, result: null, error: '', history: [] },
});

// 媒体文件 URL（图片整发；视频/音频后端带 Range）。附 token 供离线/跨源 <img><video> 鉴权。
// v='thumb'（320px 网格）| 'preview'（1280px 对话流大图）：服务端 sharp 衍生图——4K 原图
// 单张 ~20MB，网格/对话流直接加载原图会拉垮手机。不传 v = 原图。
export function mediaUrl(id, v) {
  const tok = (authHeaders().Authorization || '').replace(/^Bearer /, '');
  return apiUrl('/api/vertex/media?id=' + encodeURIComponent(id) + (v ? '&v=' + v : '') + (tok ? '&token=' + encodeURIComponent(tok) : ''));
}

// 生成物拖出（桌面壳 #8）：媒体只有 id/URL 没有本机路径 → 壳按 URL 下到临时目录再拖。
// 文件名取提示词前 40 字（去掉 Windows 非法字符），扩展名由壳按响应 Content-Type 补。
export function mediaDragSrc(id, title = '') {
  if (!id) return null;
  const base = String(title || '').replace(/[\\/:*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
  return { url: mediaUrl(id), name: base || 'vertex-' + id };
}

const API_KIND = { image: 'image', video: 'video', voice: 'audio', music: 'music' };

// —— 本地秒表（同步 image/tts 也显示计时；SSE 的 progress 会覆盖更新）——
const timers = {};
// 删除失败的提示：服务端跑在服务器上时说「服务器」（/api/auth 的 hosting）
const delFail = () => (hostIsServer() ? t('删除失败（连不上服务器或文件被占用）') : t('删除失败（连不上电脑或文件被占用）'));
function tick(k) { stopTick(k); vmedia[k].elapsed = 0; timers[k] = setInterval(() => { vmedia[k].elapsed += 1; }, 1000); }
function stopTick(k) { if (timers[k]) { clearInterval(timers[k]); timers[k] = null; } }

// —— SSE：POST 读流（video / music）——
async function postStream(path, body, onEvent) {
  const res = await fetch(apiUrl(path), {
    method: 'POST',
    headers: authHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!res.ok || !res.body) {
    let message = 'HTTP ' + res.status;
    try { const detail = await res.json(); message = detail.error || message; } catch {}
    throw Object.assign(new Error(message), { status: res.status });
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, i); buf = buf.slice(i + 2);
      for (const raw of frame.split('\n')) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
        if (line.startsWith('data:')) { try { onEvent(JSON.parse(line.slice(5).replace(/^ /, ''))); } catch {} }
      }
    }
  }
}

// —— 图像（同步）——
// 对话式图像（多轮）：把当前 prompt + 历史 turns(已生成图的 imageId) 发后端，
// 后端读 media 图+thoughtSignature 重建 contents 续改（Nano Banana）；Imagen 退化每轮独立。
export async function sendImageChat(message, sourceImagePath, sourceImageUrl, referencePaths = []) {
  const s = vmedia.image; if (s.busy) return;
  const txt = (message || '').trim(); if (!txt) return;
  const d = caps.data?.image?.defaults || {};
  s.busy = true; s.error = ''; tick('image');
  const prior = s.turns.filter((x) => x.imageId).map((x) => ({ userText: x.userText, imageId: x.imageId }));
  const idx = s.turns.length;
  s.turns.push({ userText: txt, imageId: null, srcUrl: sourceImageUrl || null });   // 乐观加当前轮（imageId 回填；srcUrl=源图缩略，仅首轮带）
  try {
    const local = (vs.imageModel || d.model) === 'qwen-image-2.1-local';
    const body = {
      message: txt, turns: prior,
      sessionId: s.sessionId || undefined,   // 续改：带上当前链的 sessionId；首轮没有则后端新发并回传
      model: vs.imageModel || d.model,
      image: sourceImagePath || undefined,   // 源图（编辑起点，Nano Banana）
      aspectRatio: vs.imageAspect, imageSize: vs.imageSize || undefined,
      thinkingLevel: vs.imageThink || undefined,
      useSearch: !!vs.imageSearch, useImageSearch: !!vs.imageImgSearch,
      outputFormat: vs.imageFormat, temperature: vs.imageTemp, topP: vs.imageTopP,
      personGeneration: vs.imagePersonGen || undefined,
      ...(local ? {
        stream: true, steps: vs.imageSteps ?? 40, seed: vs.imageSeed ?? -1,
        images: referencePaths.length ? referencePaths : undefined,
        referenceId: referencePaths.length || sourceImagePath ? undefined : s.referenceId || undefined,
        width: vs.imageWidth, height: vs.imageHeight, cfg: vs.imageCfg, negativePrompt: vs.imageNegative,
        count: vs.imageCount, useKvCache: vs.imageKvCache, referenceResolution: vs.imageReferenceResolution,
        transparent: vs.imageTransparent,
        sigmas: vs.imageSigmas.trim() ? vs.imageSigmas.trim().split(/[\s,，]+/).map(Number) : null,
      } : {}),
    };
    let r;
    if (local) {
      s.progress = '';
      let streamError = '';
      await postStream('/api/vertex/image-chat', body, event => {
        if (event.type === 'start' && event.sessionId) s.sessionId = event.sessionId;
        if (event.type === 'progress') {
          const phase = event.phase === 'encoding' ? t('正在编码提示词与参考图') : event.phase === 'decoding' ? t('正在解码图片') : event.phase === 'saving' ? t('正在保存图片') : t('采样 {step} / {steps}', { step: event.step, steps: event.steps });
          s.progress = t('第 {index} / {count} 张 · {phase}', { index: event.batchIndex || 1, count: event.count || 1, phase });
        }
        if (event.type === 'image') r = event;
        if (event.type === 'error') streamError = event.message;
      });
      if (streamError) throw new Error(streamError);
      if (!r) throw new Error(t('连接已断开，生成结果会保存在历史中，请稍后查看。'));
    } else r = await api.vertexImageChat(body);
    if (r.ok) { s.turns[idx].imageId = r.id; s.turns[idx].outputs = r.images || null; s.referenceId = null; if (r.sessionId) s.sessionId = r.sessionId; loadHistory('image'); }
    else { s.error = tr(r.error) || t('图像生成失败'); s.turns.splice(idx, 1); }
  } catch (e) { s.error = e.status === 401 ? t('需要登录') : tr(String(e.message || e)); s.turns.splice(idx, 1); }
  finally { s.busy = false; s.progress = ''; stopTick('image'); }
}
export function newImageChat() { vmedia.image.turns = []; vmedia.image.error = ''; vmedia.image.sessionId = null; vmedia.image.referenceId = null; }
// 点历史会话：拉回整条修改链还原 turns + sessionId，续改接着之前的视觉上下文走。
// h = 历史项 {id(会话 key), coverId, title, count}。拿不到会话（老数据/网络）退化为单图单轮。
export async function openImageChat(h) {
  const s = vmedia.image;
  const id = h?.id;
  if (!id) return;
  s.referenceId = null;
  try {
    const d = await api.vertexImageChatSession(id);
    if (d && Array.isArray(d.turns) && d.turns.length) {
      s.turns = d.turns.map((x) => ({ userText: x.userText || t('（历史图）'), imageId: x.imageId, outputs: x.outputs || null, srcUrl: null }));
      s.sessionId = d.id || id; s.error = ''; return;
    }
  } catch {}
  s.turns = [{ userText: tr(h.title) || t('（历史图）'), imageId: h.coverId || id, srcUrl: null }];
  s.sessionId = id; s.error = '';
}
// 删整条图像会话（乐观更新；删的是当前打开的链则清空画布回到空白）。
export async function delImageChat(id) {
  const s = vmedia.image;
  const prev = s.history;
  s.history = prev.filter((m) => m.id !== id);
  if (s.sessionId === id) newImageChat();
  try { const r = await api.deleteVertexImageChat(id); if (!r || r.ok === false) throw new Error(t('删除失败')); }
  catch (e) { s.history = prev; s.error = e && e.status === 401 ? t('需要登录') : delFail(); }
}

// —— 语音（同步）——
export async function genTTS(text) {
  const s = vmedia.voice; if (s.busy) return;
  const txt = (text || '').trim(); if (!txt) return;
  const d = caps.data?.tts?.defaults || {};
  s.busy = true; s.error = ''; s.result = null; tick('voice');
  try {
    // 多人对白只有两位说话人都填全了才发（后端不足 2 人会退回单人，这里先自己把关）。
    const sp = (vs.voiceSpeakers || []).filter((x) => x && x.speaker && x.voice).slice(0, 2);
    const r = await api.vertexTTS({
      text: txt, model: vs.voiceModel || d.model, voice: vs.voice || d.voice,
      style: vs.voiceStyle || undefined,
      speakers: vs.voiceMulti && sp.length >= 2 ? sp : undefined,
    });
    if (r.ok) { s.result = { id: r.id, url: r.url, prompt: txt, kind: 'audio' }; loadHistory('voice'); }
    else s.error = tr(r.error) || t('语音生成失败');
  } catch (e) { s.error = e.status === 401 ? t('需要登录') : tr(String(e.message || e)); }
  finally { s.busy = false; stopTick('voice'); }
}

// —— 断流恢复：Veo/Lyria 后端设计为断线不中止（按秒计费、跑完必落盘）——
// 之前前端断流直接报 "Failed to fetch"，用户极易重发造成双倍计费。现在拿着 start
// 事件给的 id 轮询历史，文件落盘即把结果接回来（轮询期间维持"生成中"态）。
async function pollForId(func, id, ms = 8000, tries = 60) {   // 最长 ~8 分钟
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, ms));
    await loadHistory(func);
    const hit = vmedia[func].history.find((x) => x.id === id);
    if (hit) return hit;
  }
  return null;
}

// —— 视频（SSE 进度）——
export async function genVideo(prompt, opts = {}) {
  const s = vmedia.video; if (s.busy) return;
  const txt = (prompt || '').trim();
  // opts: { first, last, refs[] } —— 首帧/尾帧/参考图的 uploads 路径。调用方仍可只传 prompt。
  const first = opts.first || null, last = opts.last || null, refs = (opts.refs || []).filter(Boolean);
  if (!txt && !first && !last && !refs.length) return;
  const d = caps.data?.veo?.defaults || {};
  s.busy = true; s.error = ''; s.result = null; tick('video');
  let startId = null;
  try {
    await postStream('/api/vertex/video', {
      prompt: txt, image: first || undefined, lastFrame: last || undefined,
      referenceImages: refs.length ? refs : undefined,
      model: vs.videoModel || d.model,
      task: vs.videoTask || 't2v',
      aspectRatio: vs.videoAspect,
      resolution: vs.videoResolution,
      durationSeconds: vs.videoDuration,
      generateAudio: !!vs.videoAudio,
      // Veo 专属三件——后端按模型再门控一次（Omni 收到会 400），这里照发不误。
      negativePrompt: vs.videoNeg || undefined,
      enhancePrompt: vs.videoEnhance === false ? false : undefined,
      compressionQuality: vs.videoQuality || undefined,
    }, (ev) => {
      if (ev.type === 'start') startId = ev.id;
      else if (ev.type === 'progress') s.elapsed = ev.elapsed || s.elapsed;
      else if (ev.type === 'video') s.result = { id: ev.id, url: ev.url, prompt: txt, kind: 'video' };
      else if (ev.type === 'error') s.error = tr(ev.message) || t('视频生成失败');
    });
    if (s.result) loadHistory('video');
  } catch (e) {
    if (e.status === 401) s.error = t('需要登录');
    else if (startId && !s.result) {
      const hit = await pollForId('video', startId);
      if (hit) s.result = { id: hit.id, url: '/api/vertex/media?id=' + hit.id, prompt: txt, kind: 'video' };
      else s.error = t('连接中断；生成仍在电脑上继续，稍后到「历史」里查看（不要重发）');
    } else s.error = tr(String(e.message || e));
  }
  finally { s.busy = false; stopTick('video'); }
}

// —— 音乐（SSE 进度）——
export async function genMusic(prompt, negativePrompt) {
  const s = vmedia.music; if (s.busy) return;
  const txt = (prompt || '').trim(); if (!txt) return;
  const d = caps.data?.music?.defaults || {};
  s.busy = true; s.error = ''; s.result = null; tick('music');
  let startId = null;
  try {
    await postStream('/api/vertex/music', {
      prompt: txt, negativePrompt: (negativePrompt || '').trim() || undefined,
      model: vs.musicModel || d.model,
    }, (ev) => {
      if (ev.type === 'start') startId = ev.id;
      else if (ev.type === 'progress') s.elapsed = ev.elapsed || s.elapsed;
      else if (ev.type === 'music') s.result = { id: ev.id, url: ev.url, prompt: txt, kind: 'music' };
      else if (ev.type === 'error') s.error = tr(ev.message) || t('音乐生成失败');
    });
    if (s.result) loadHistory('music');
  } catch (e) {
    if (e.status === 401) s.error = t('需要登录');
    else if (startId && !s.result) {
      const hit = await pollForId('music', startId);
      if (hit) s.result = { id: hit.id, url: '/api/vertex/media?id=' + hit.id, prompt: txt, kind: 'music' };
      else s.error = t('连接中断；生成仍在电脑上继续，稍后到「历史」里查看（不要重发）');
    } else s.error = tr(String(e.message || e));
  }
  finally { s.busy = false; stopTick('music'); }
}

// —— 历史 ——
export async function loadHistory(func) {
  try {
    // 图像历史是"会话"维度（按修改链分组），其余仍是扁平媒体列表。
    if (func === 'image') { const d = await api.vertexImageChats(); vmedia.image.history = d.sessions || []; return; }
    const d = await api.vertexMediaList(API_KIND[func]); vmedia[func].history = d.media || d.videos || [];
  } catch {}
}
export async function delMedia(func, id) {
  // 乐观更新：先从 UI 移除（即时反应，不等删除请求经隧道往返的 ~1.5s），请求后台跑；失败再把
  // 条目/结果放回去并提示（不留"删不掉的幽灵"——之前是等后端确认才移除，删一条要卡 ~1.5s）。
  const prevHist = vmedia[func].history;
  const prevResult = vmedia[func].result;
  vmedia[func].history = prevHist.filter((m) => m.id !== id);
  if (prevResult && prevResult.id === id) vmedia[func].result = null;
  try {
    const r = await api.deleteVertexMedia(API_KIND[func], id);
    if (!r || r.ok === false) throw new Error(t('删除失败'));
  } catch (e) {
    vmedia[func].history = prevHist;
    vmedia[func].result = prevResult;
    vmedia[func].error = e && e.status === 401 ? t('需要登录') : delFail();
  }
}
