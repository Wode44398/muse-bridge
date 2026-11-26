// Antigravity 历史用户图片还原：agy acp 的 session/load 只回放用户文本块、不回放图片块，
// 导致附带图片的消息在切走重开或刷新后图片消失。
// 主源读 agy 落盘的 transcript(_full).jsonl 中 USER_INPUT.media（对应 brain/<id>/.user_uploaded/ 原图，
// 覆盖历史会话、桌面版会话与中途插话）；侧车表 meta.userMedia 作兜底并保留用户原始文件名。

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isPathInside, mimeType } from '@bridge/core/runtime/http-file.mjs';
import { sessionBrainDir } from './background.mjs';
import { isSessionArtifact } from './deliverables.mjs';
import { foldAgyPath, normalizeAgyPath } from './paths.mjs';
import { isWakePrompt } from './wake-prompt.mjs';

export const ACP_IMAGE_EXT = /\.(?:png|jpe?g|webp|gif)$/i;

const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const META_PROMPT_LIMIT = 400;

// 剥离 agy 写入 transcript 时的 <USER_REQUEST> 与系统元数据包装，还原为与 session/load 一致的用户原文
export function extractUserRequestText(raw) {
  const s = String(raw || '');
  const m = /<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/.exec(s);
  if (m) return m[1];
  return s.replace(/<([A-Z][A-Z0-9_]*)>[\s\S]*?<\/\1>/g, '');
}

function normText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function textsMatch(msgText, entryText, { allowPrefix = false } = {}) {
  const a = normText(msgText);
  const b = normText(entryText);
  if (a === b) return true;
  if (!allowPrefix || !a || !b) return false;
  return a.startsWith(b) || b.startsWith(a.slice(0, META_PROMPT_LIMIT));
}

function stripUploadStamp(name = '') {
  return String(name || '').replace(/^\d{10,}-(?=.)/, '');
}

function resolveSafeArtifactFile(rawPath, { realBrainDir = '', allowedRoots = [] } = {}) {
  const norm = normalizeAgyPath(rawPath);
  if (!norm) return null;
  try {
    const real = realpathSync(norm);
    const st = statSync(real);
    if (!st.isFile()) return null;
    const inBrain = realBrainDir ? isSessionArtifact(real, realBrainDir) : false;
    const inRoots = allowedRoots.some((root) => root && isPathInside(real, root));
    if (!inBrain && !inRoots) return null;
    return { real, size: st.size };
  } catch {
    return null;
  }
}

/** 从本次发送的附件中提取作为 ACP image 块发出的图片元数据（写入侧车表兜底并保留原文件名）。 */
export function extractUserImageAtts(attachments = [], userAtts = []) {
  const nameByPath = new Map();
  for (const a of (Array.isArray(userAtts) ? userAtts : [])) {
    if (!a || typeof a.path !== 'string' || !a.path) continue;
    const key = foldAgyPath(a.path);
    const nm = String(a.name || '').trim();
    if (key && nm) nameByPath.set(key, nm);
  }
  const out = [];
  const seen = new Set();
  for (const file of (Array.isArray(attachments) ? attachments : [])) {
    if (typeof file !== 'string' || !ACP_IMAGE_EXT.test(file) || !existsSync(file)) continue;
    let real = file;
    let size;
    try {
      real = realpathSync(file);
      const st = statSync(real);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    const key = foldAgyPath(real);
    if (seen.has(key)) continue;
    seen.add(key);
    const rawName = nameByPath.get(key) || nameByPath.get(foldAgyPath(file)) || stripUploadStamp(path.basename(real));
    out.push({
      path: real,
      name: String(rawName || path.basename(real)).slice(0, 200),
      mimeType: mimeType(real, { fallback: 'image/png' }),
      ...(Number.isFinite(size) ? { size } : {}),
    });
    if (out.length >= 20) break;
  }
  return out;
}

/** 读取 agy 磁盘文字记录中所有用户显式输入（含顺序、正文与落盘的 .user_uploaded 媒体）。 */
export function readTranscriptUserInputs(dataDir, sessionId) {
  const brainDir = sessionBrainDir(dataDir, sessionId);
  if (!brainDir) return [];
  let realBrainDir = '';
  try { realBrainDir = realpathSync(brainDir); } catch { return []; }

  let file = '';
  for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const candidate = path.join(realBrainDir, '.system_generated', 'logs', name);
    if (existsSync(candidate)) { file = candidate; break; }
  }
  if (!file) return [];

  try {
    const st = statSync(file);
    if (!st.isFile() || !st.size || st.size > MAX_TRANSCRIPT_BYTES) return [];
  } catch {
    return [];
  }

  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return []; }

  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim() || !line.includes('"USER_INPUT"')) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || o.type !== 'USER_INPUT') continue;
    if (o.source && o.source !== 'USER_EXPLICIT') continue;
    const text = extractUserRequestText(o.content).trim();
    if (text && isWakePrompt(text)) continue;

    const images = [];
    const seen = new Set();
    if (Array.isArray(o.media)) {
      for (const m of o.media) {
        if (!m || typeof m !== 'object') continue;
        const resolved = resolveSafeArtifactFile(m.uri || m.path || '', { realBrainDir });
        if (!resolved) continue;
        const key = foldAgyPath(resolved.real);
        if (seen.has(key)) continue;
        seen.add(key);
        images.push({
          path: resolved.real,
          name: path.basename(resolved.real),
          mimeType: String(m.mime_type || m.mimeType || mimeType(resolved.real, { fallback: 'image/png' })),
          size: resolved.size,
        });
      }
    }
    if (!text && !images.length) continue;
    entries.push({
      stepIndex: Number.isFinite(Number(o.step_index)) ? Number(o.step_index) : entries.length,
      text,
      images,
    });
  }
  return entries;
}

function setMessageImages(msg, images) {
  msg.images = images.map((img) => ({ ...img }));
  const nonImageBlocks = (Array.isArray(msg.blocks) ? msg.blocks : []).filter((b) => b?.type !== 'image');
  msg.blocks = [...nonImageBlocks, ...msg.images.map((img) => ({ type: 'image', ...img }))];
}

function hasUsablePathImages(msg) {
  return Array.isArray(msg?.images) && msg.images.some((img) => img && typeof img.path === 'string' && img.path);
}

function hasAnyUsableImages(msg) {
  return Array.isArray(msg?.images) && msg.images.some((img) => img && (img.path || img.data));
}

function normalizeMetaEntries(meta, { realBrainDir = '', allowedRoots = [] } = {}) {
  const raw = Array.isArray(meta?.userMedia) ? meta.userMedia : [];
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const imgs = [];
    const seen = new Set();
    for (const img of (Array.isArray(item.images) ? item.images : [])) {
      if (!img || typeof img.path !== 'string' || !img.path) continue;
      const rawNorm = normalizeAgyPath(img.path) || img.path;
      const resolved = resolveSafeArtifactFile(img.path, { realBrainDir, allowedRoots });
      const key = foldAgyPath(resolved ? resolved.real : rawNorm);
      if (seen.has(key)) continue;
      seen.add(key);
      if (resolved) {
        imgs.push({
          path: resolved.real,
          name: String(img.name || '').trim() || stripUploadStamp(path.basename(resolved.real)),
          mimeType: String(img.mimeType || mimeType(resolved.real, { fallback: 'image/png' })),
          size: resolved.size,
          missing: false,
        });
      } else {
        // 原图不在盘上（如 uploads 被清理）或不在允许目录：不可直接对外输出，
        // 仅在 transcript 已有对应 .user_uploaded 副本时用于还原原文件名与前端去重（不泄露给未命中的条目）
        imgs.push({
          path: '',
          origPath: rawNorm,
          name: String(img.name || '').trim() || stripUploadStamp(path.basename(rawNorm)),
          missing: true,
        });
      }
    }
    if (!imgs.length) continue;
    out.push({ prompt: String(item.prompt || ''), images: imgs });
  }
  return out;
}

/**
 * 将 agy 磁盘 transcript 的 USER_INPUT.media（主源）与侧车 meta.userMedia（兜底 + 原文件名）
 * 按轮次顺序与文本对齐补回历史消息数组。
 */
export function applyUserMedia(messages = [], {
  dataDir = '',
  sessionId = '',
  meta = null,
  allowedRoots = [],
  live = false,
} = {}) {
  if (!Array.isArray(messages)) return messages;

  const brainDir = sessionBrainDir(dataDir, sessionId);
  let realBrainDir = '';
  if (brainDir) {
    try { realBrainDir = realpathSync(brainDir); } catch {}
  }

  const realRoots = [];
  for (const root of (Array.isArray(allowedRoots) ? allowedRoots : [])) {
    if (!root) continue;
    try { realRoots.push(realpathSync(root)); } catch {}
  }

  const transcriptEntries = readTranscriptUserInputs(dataDir, sessionId);
  const metaEntries = normalizeMetaEntries(meta, { realBrainDir, allowedRoots: realRoots });

  const usableMetaImages = (entry) => (entry?.images || [])
    .filter((img) => !img.missing && img.path)
    .map(({ path: p, name, mimeType: mt, size }) => ({ path: p, name, mimeType: mt, size }));

  // 纯发图不打字时，agy 的 session/load 可能连空的 user_message_chunk 都不回放：
  // 若非 live 且首条回放已是 assistant、而记录里第一条用户消息就是纯图无文字，补回该用户消息。
  if (!live && messages.length > 0 && messages[0]?.role === 'assistant') {
    const firstMetaUsable = metaEntries[0] && !normText(metaEntries[0].prompt) ? usableMetaImages(metaEntries[0]) : [];
    const firstImgOnly = firstMetaUsable.length > 0
      ? firstMetaUsable
      : (transcriptEntries[0] && !transcriptEntries[0].text && transcriptEntries[0].images.length > 0
        ? transcriptEntries[0].images
        : null);
    if (firstImgOnly) {
      const u = { role: 'user', text: '', images: [], blocks: [] };
      setMessageImages(u, firstImgOnly);
      messages.unshift(u);
    }
  }

  const userMsgs = messages.filter((m) => m?.role === 'user');
  if (!userMsgs.length) return messages;

  // 1) 主源：按单调顺序指针把 transcript 里的 USER_INPUT.media 对齐到对应的用户消息
  const transcriptMatched = new Set();
  if (transcriptEntries.length > 0) {
    let ei = 0;
    for (const msg of userMsgs) {
      if (ei >= transcriptEntries.length) break;
      let hitIdx = -1;
      for (let k = ei; k < transcriptEntries.length; k++) {
        if (textsMatch(msg.text, transcriptEntries[k].text)) {
          hitIdx = k;
          break;
        }
      }
      if (hitIdx < 0) continue;
      const entry = transcriptEntries[hitIdx];
      ei = hitIdx + 1;
      transcriptMatched.add(msg);
      if (entry.images.length > 0 && !hasUsablePathImages(msg)) {
        setMessageImages(msg, entry.images);
      }
    }
  }

  // 2) 侧车表 meta.userMedia：
  //    · 已被 transcript 命中的消息以 transcript 是否带图为准（避免把后面同名消息的图误塞给前面无图的同名消息）；
  //      有图且张数一致时：若 uploads / 工作区原图仍在盘上且通过边界校验，优先升级为无损原图
  //      （避免历史点开看到 agy 压缩后的 2000px JPEG 副本，同时与文本前缀路径对齐去重）；
  //      原图已不在盘上则保留 .user_uploaded 副本并还原原文件名（附 origPath 供前端对文本前缀去重）。
  //    · 未被 transcript 命中的消息（假 agy / 无 transcript / 尚未刷盘），直接用盘上存在的原图兜底补图。
  if (metaEntries.length > 0) {
    let mi = 0;
    for (const msg of userMsgs) {
      if (mi >= metaEntries.length) break;
      const matchedInTranscript = transcriptMatched.has(msg);
      if (matchedInTranscript && !hasUsablePathImages(msg)) continue;
      let hitIdx = -1;
      for (let k = mi; k < metaEntries.length; k++) {
        if (textsMatch(msg.text, metaEntries[k].prompt, { allowPrefix: true })) {
          hitIdx = k;
          break;
        }
      }
      if (hitIdx < 0) continue;
      const mEntry = metaEntries[hitIdx];
      mi = hitIdx + 1;
      if (hasUsablePathImages(msg)) {
        if (msg.images.length === mEntry.images.length) {
          const msgTextNorm = String(msg.text || '');
          const upgraded = msg.images.map((img, idx) => {
            const orig = mEntry.images[idx];
            if (!orig) return img;
            if (!orig.missing && orig.path) {
              return { path: orig.path, name: orig.name, mimeType: orig.mimeType, size: orig.size };
            }
            const carryOrig = orig.origPath && msgTextNorm.includes(orig.origPath) ? orig.origPath : '';
            return {
              ...img,
              name: orig.name || img.name,
              ...(carryOrig ? { origPath: carryOrig } : {}),
            };
          });
          setMessageImages(msg, upgraded);
        }
      } else {
        // 内存历史里由 runPrompt 存入的图片块只有 base64 data、不含 path 与原文件名；
        // 只要盘上原图仍存在，优先升级为无损原图路径与原文件名（否则保住原有 base64 兜底）。
        const usable = usableMetaImages(mEntry);
        if (usable.length) setMessageImages(msg, usable);
      }
    }
  }

  return messages;
}
