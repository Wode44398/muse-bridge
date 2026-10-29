// Vertex (Gemini) chat branch. Native @google/genai over ADC. Stateless per
// call, so the bridge replays its own sidecar history as `contents`. Pure JS
// (no node-pty), but lazy-imported to keep the desktop debug server lean.

import path from 'node:path';
import { readFileSync, statSync } from 'node:fs';
import * as vertexHist from '../vertex-history.mjs';
import * as vertexMedia from '@bridge/core/vertex-media.mjs';
import { writeSseHeaders, sseWrite, startHeartbeat } from '@bridge/core/runtime/sse.mjs';
import { VERTEX_PROJECT, VERTEX_LOCATION } from '@bridge/core/config/index.mjs';

// 多模态附件：扩展名 → Gemini inlineData mime。不在表里的类型不送（前端也只放行这些）。
const ATT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic', '.pdf': 'application/pdf' };
const ATT_MAX = 7 * 1024 * 1024; // 单文件 ≤7MB（inline 请求总上限 ~20MB，留余量）
// 识图提速：把大图降采样到 1600px 长边 + 转 webp，砍 base64 上传体积与视觉 token（prefill 更快）。
// gif(动图)/heic(sharp 难解)/pdf 不动。手机拍的 3–5MB 大图通常能压到 ~200–400KB，几乎无识图质量损失。
const SHRINK_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const SHRINK_EDGE = 1600;

async function shrinkImage(p) {
  try {
    const sharp = (await import('sharp')).default;
    const out = await sharp(p).rotate()
      .resize(SHRINK_EDGE, SHRINK_EDGE, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 }).toBuffer();
    return out.length < statSync(p).size ? out : null;   // 没压小（小图/已很小）就用原图
  } catch { return null; }
}

// attachments（已经过 chat.mjs 的 uploads 路径校验）→ [{mime, data, name}]；
// 不支持/超限的静默跳过并在文本里说明。图片先降采样（见 shrinkImage）。
async function loadAttachments(paths, fast) {
  const files = [], skipped = [];
  for (const p of (paths || [])) {
    const ext = path.extname(p).toLowerCase();
    const mime = ATT_MIME[ext];
    const name = path.basename(p);
    if (!mime) { skipped.push(name + '（类型不支持）'); continue; }
    try {
      if (statSync(p).size > ATT_MAX) { skipped.push(name + '（超过 7MB）'); continue; }
      if (fast && SHRINK_EXT.has(ext) && statSync(p).size > 120 * 1024) {
        const shr = await shrinkImage(p);
        if (shr) { files.push({ mime: 'image/webp', data: shr.toString('base64'), name }); continue; }
      }
      files.push({ mime, data: readFileSync(p).toString('base64'), name });
    } catch { skipped.push(name + '（读取失败）'); }
  }
  return { files, skipped };
}

export async function runVertexChat(req, res, { message, sessionId, vertexModel, vertexSearch, vertexThink, vertexFastVision = true, vertexOpts = {}, attachments, ctx }) {
  const histDir = (ctx && ctx.vertexHist) || undefined; // undefined -> default HIST (admin)
  writeSseHeaders(res);
  const sendV = (obj) => sseWrite(res, obj);
  const hb = startHeartbeat(res);
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  const convId = (sessionId && /^[0-9a-fA-F-]{8,}$/.test(sessionId)) ? sessionId : vertexHist.newId();
  const history = vertexHist.turnsFor(convId, histDir);
  sendV({ type: 'session', sessionId: convId, model: vertexModel });
  // 附件：本轮以 inlineData 喂给模型；侧车历史只存「📎文件名」文本标注（重放不回传
  // 二进制——后续轮模型看不到旧图，属 v1 取舍，标注让人能看懂上下文）。
  const { files, skipped } = await loadAttachments(attachments, vertexFastVision);
  const attNote = files.length ? files.map((f) => '📎' + f.name).join(' ') + '\n' : '';
  const skipNote = skipped.length ? `（附件被跳过：${skipped.join('、')}）\n` : '';
  let acc = ''; // 已流出的文本——手机锁屏断连触发 abort 时也要落历史，不能整轮蒸发
  try {
    const vertex = await import('../vertex.mjs');
    const r = await vertex.runTurn({
      history, message: skipNote ? skipNote + message : message, files,
      model: vertexModel, useSearch: vertexSearch, thinkLevel: vertexThink, fastVision: vertexFastVision,
      system: vertexOpts.system, useUrl: vertexOpts.url, useCode: vertexOpts.code, mediaRes: vertexOpts.mediaRes,
      // 代码执行画出来的图表（matplotlib → inlineData PNG）：存进本人媒体目录，正文里换成图片链接。
      // kind 用 chat-image，不混进图片页历史；前端渲染时把 /api/vertex/media 链接换成带 token 的完整地址。
      onImage: (buf, mime) => {
        const ext = /png/.test(mime) ? 'png' : /jpe?g/.test(mime) ? 'jpg' : /webp/.test(mime) ? 'webp' : null;
        if (!ext) return null;
        const id = vertexMedia.newId();
        vertexMedia.save(id, buf, ext, { kind: 'chat-image', prompt: message.slice(0, 200), model: vertexModel, sessionId: convId }, ctx?.media || undefined);
        return `/api/vertex/media?id=${id}`;
      },
      project: VERTEX_PROJECT, location: VERTEX_LOCATION,
      onText: (d) => { acc += d; sendV({ type: 'text', text: d }); }, signal: abort.signal,
    });
    // Append Google Search sources (if any) as a markdown footnote, streamed
    // and stored so reopening the conversation still shows them.
    let full = r.text || '';
    if (r.sources && r.sources.length) {
      const md = '\n\n---\n**来源**\n' + r.sources.map((s, i) => `${i + 1}. [${s.title}](${s.uri})`).join('\n');
      sendV({ type: 'text', text: md });
      full += md;
    }
    vertexHist.appendTurn(convId, attNote + message, full, histDir); // bridge owns the history record（附件以 📎 标注）
    sendV({ type: 'done', result: full, isError: false, cost: 0, sessionId: convId });
  } catch (err) {
    // 中断/出错但已经流出过内容（典型：锁屏断连 → abort）：把半截回答存进历史，
    // 重开会话还能看到；之前这条路径直接跳过 appendTurn，整轮（含用户提问）蒸发。
    if (acc.trim()) { try { vertexHist.appendTurn(convId, attNote + message, acc + '\n\n*（连接中断，回答到此截断）*', histDir); } catch {} }
    sendV({ type: 'error', message: 'Gemini 调用失败：' + String(err?.message ?? err) });
  } finally {
    clearInterval(hb);
    if (!res.writableEnded) res.end();
  }
}
