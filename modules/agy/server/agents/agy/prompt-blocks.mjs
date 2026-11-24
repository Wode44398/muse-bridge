// 一轮用户消息 → ACP session/prompt 的内容块：正文前拼「本轮附加文件路径」清单，附件按 agy 上报的
// promptCapabilities 分流成 image / audio / resource 块；送不进去的只给路径，并在清单里叫模型自己 read_file。
//
// 清单格式（首行固定、每个附件一行「- 路径  ← 标注」、空行后接用户原文）被三处按行解析还原成附件卡：
// sessions.mjs / session-quote.mjs 的 stripAttachedPathsPrefix、前端 web/src/lib/agy/attach-look.js。
// 所以给模型的说明只能写进每行的标注里，不能另起段落（会被当成用户原文显示在气泡里）；文件夹的标注必须以「文件夹」开头。

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mimeType } from '@bridge/core/runtime/http-file.mjs';
import { foldAgyPath } from '../../paths.mjs';
import { parseAgyQuoteFile } from '../../session-quote.mjs';
import { ACP_IMAGE_EXT } from '../../user-media.mjs';

export const ATTACHED_HEAD = '本轮附加文件路径：';

// 单轮内联（audio / resource）的总字节上限。Gemini 单次请求的内联数据上限约 20MB，超了 agy 那头要么丢弃要么整轮报错；
// 而且 base64 后整条 JSON-RPC 只走一行 stdin，几十 MB 会把管道和 agy 的解析一起拖慢。超出的退回路径 + read_file。
// 图片不计入：图片一直无上限地走 image 块，agy 收到后自己压到长边 2000px。
export const INLINE_BUDGET_BYTES = 20 * 1024 * 1024;
// 文本文件按 text resource 整段塞进上下文：太大的（日志、导出数据）直接占满窗口，留给模型用 read_file 分段读
export const TEXT_INLINE_MAX_BYTES = 512 * 1024;

const AUDIO_EXTRA_MIME = { weba: 'audio/webm', oga: 'audio/ogg', amr: 'audio/amr' };
const AUDIO_EXT = /\.(?:wav|mp3|m4a|ogg|oga|opus|flac|aac|weba|amr)$/i;

const NOTE = {
  folder: '文件夹',
  quote: '引用的对话（未直接送入，请用 read_file 打开该路径查看内容）',
  audio: '已作为音频附上',
  resource: '已作为文件内容附上（看不到内容时用 read_file 打开该路径）',
  notSent: '未直接送入，请用 read_file 打开该路径查看内容',
};

const bareMime = (mt) => String(mt || '').split(';')[0].trim().toLowerCase();

function mimeOf(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  return bareMime(AUDIO_EXTRA_MIME[ext] || mimeType(file, { fallback: '' }));
}

const isTextMime = (mt) => mt.startsWith('text/') || /^application\/(?:json|xml|yaml|javascript)$/.test(mt);
// Gemini 原生能读的二进制。Office 文档、压缩包之类即便塞进 resource 也读不了（agy 会以 unsupported blob type 跳过，
// 或在送模型时报 unsupported inline data MIME type 让整轮失败），不如直接让模型用 read_file / 命令行处理。
const isModelMedia = (mt) => mt.startsWith('audio/') || mt.startsWith('video/') || mt === 'application/pdf';

// 不认识扩展名的文件：小且是合法 UTF-8、没有 NUL 的当文本
function sniffText(buf) {
  if (buf.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
}

/** 规整附件：去重、取 realpath（给模型稳定可用的无损原件绝对路径，也与侧车记录 / 历史去重一致）、标出文件夹与引用的对话。 */
function collectEntries(attachments) {
  const out = [];
  const seen = new Set();
  for (const file of (Array.isArray(attachments) ? attachments : [])) {
    if (typeof file !== 'string' || !existsSync(file)) continue;
    let resolved = file;
    try { resolved = realpathSync(file); } catch {}
    const key = foldAgyPath(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    let st = null;
    try { st = statSync(resolved); } catch {}
    if (st?.isDirectory()) { out.push({ path: resolved, kind: 'folder' }); continue; }
    if (parseAgyQuoteFile(path.basename(resolved))) { out.push({ path: resolved, kind: 'quote' }); continue; }
    out.push({ path: resolved, kind: 'file', size: st ? st.size : 0 });
  }
  return out;
}

/**
 * 决定每个附件怎么送：image / audio / resource 块，或只给路径。caps 是 agy initialize 回的 promptCapabilities；
 * 不知道（老版本没报、进程还没起）时只发图片，别的一律走 read_file——发了 agy 不认的块类型会让整轮被拒。
 */
function planEntries(entries, caps) {
  const known = caps && typeof caps === 'object';
  const canImage = !known || caps.image !== false;
  const canAudio = known && caps.audio === true;
  const canEmbed = known && caps.embeddedContext === true;
  let budget = INLINE_BUDGET_BYTES;
  const take = (bytes) => {
    if (bytes > budget) return false;
    budget -= bytes;
    return true;
  };

  for (const e of entries) {
    if (e.kind !== 'file') continue;
    if (ACP_IMAGE_EXT.test(e.path)) {
      // 图片的原路径照样列进清单：agy 收到 image 块会按长边 2000px + JPEG Q85 压缩并剥离透明通道与 EXIF，
      // 模型遇到长图小字或要处理 / 搬运 / 改图时得能读到无损原件
      if (!canImage) continue;
      try {
        e.block = { type: 'image', mimeType: mimeType(e.path, { fallback: 'image/png' }), data: readFileSync(e.path).toString('base64') };
        e.how = 'image';
      } catch {
        // 读不了就只留路径，由内置文件工具自行读取
      }
      continue;
    }
    const mt = mimeOf(e.path);
    const uri = pathToFileURL(e.path).href;
    try {
      if (AUDIO_EXT.test(e.path) && canAudio) {
        if (!take(e.size)) continue;
        e.block = { type: 'audio', mimeType: mt || 'audio/mpeg', data: readFileSync(e.path).toString('base64') };
        e.how = 'audio';
      } else if (canEmbed && (isModelMedia(mt) || AUDIO_EXT.test(e.path))) {
        if (!take(e.size)) continue;
        e.block = { type: 'resource', resource: { uri, mimeType: mt || 'application/octet-stream', blob: readFileSync(e.path).toString('base64') } };
        e.how = 'resource';
      } else if (canEmbed && (!mt || isTextMime(mt)) && e.size <= TEXT_INLINE_MAX_BYTES) {
        const text = sniffText(readFileSync(e.path));
        if (text == null) continue;
        if (!take(Buffer.byteLength(text))) continue;
        e.block = { type: 'resource', resource: { uri, mimeType: mt || 'text/plain', text } };
        e.how = 'resource';
      }
    } catch {
      delete e.block;
      delete e.how;
    }
  }
}

function noteOf(e, { inline }) {
  if (e.kind === 'folder') return NOTE.folder;
  if (e.kind === 'quote') return NOTE.quote;
  if (e.how === 'image') return '';
  if (inline && e.how === 'audio') return NOTE.audio;
  if (inline && e.how === 'resource') return NOTE.resource;
  return NOTE.notSent;
}

function render(message, entries, { inline }) {
  const blocks = [];
  for (const e of entries) {
    if (!e.block) continue;
    if (e.how === 'image' || inline) blocks.push(e.block);
  }
  const prefix = entries.length
    ? ATTACHED_HEAD + '\n' + entries.map((e) => {
      const note = noteOf(e, { inline });
      return '- ' + e.path + (note ? '  ← ' + note : '');
    }).join('\n') + '\n\n'
    : '';
  const fullText = (prefix + String(message ?? '')).trim();
  if (fullText || !blocks.length) blocks.unshift({ type: 'text', text: fullText });
  return blocks;
}

/**
 * 返回 { blocks, fallback }。fallback 只在这一轮带了 audio / resource 块时给：agy 拒收这条 prompt 时
 * ACP 客户端改发它（只剩图片，其余附件标成 read_file），见 acp/client.mjs 的 sendPrompt。
 */
export function buildPromptPlan(message, attachments = [], { caps = null } = {}) {
  const entries = collectEntries(attachments);
  planEntries(entries, caps);
  const blocks = render(message, entries, { inline: true });
  const hasInline = entries.some((e) => e.how === 'audio' || e.how === 'resource');
  return { blocks, fallback: hasInline ? render(message, entries, { inline: false }) : null };
}

export function buildPromptBlocks(message, attachments = [], opts = {}) {
  return buildPromptPlan(message, attachments, opts).blocks;
}
