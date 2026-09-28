import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Block } from "./agent/turn.ts";
import { MAX_VIDEO_BYTES, VIDEO_EXT_BY_MIME, type SupportedVideoMime } from "./video.ts";
import { MAX_AUDIO_BYTES, AUDIO_EXT_BY_MIME, type SupportedAudioMime } from "./audio.ts";
import { sessionsDir } from "./store.ts";

// A conservative common subset accepted by every native vision adapter Dimensio
// currently exposes. Rejecting ambiguous formats is safer than silently sending
// a file a selected provider cannot decode.
export type SupportedImageMime = "image/png" | "image/jpeg" | "image/webp";

export const MAX_IMAGE_ATTACHMENTS = 10;
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
export const MAX_IMAGE_TOTAL_BYTES = 16 * 1024 * 1024;

const EXT_BY_MIME: Record<SupportedImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};
const SESSION_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const ASSET_ID_RE = /^[a-f0-9]{64}\.(?:png|jpg|webp|mp4|webm|mov|mp3|wav|flac|m4a|ogg)$/;

export function sniffImageMime(bytes: Uint8Array): SupportedImageMime | undefined {
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.slice(8, 12)) === "WEBP"
  ) return "image/webp";
  return undefined;
}

// U5（MiMo 反馈）：Read / 截图的结果里写明像素尺寸。视觉侧会缩放、补边，一张 900×110 的拼条曾被「看成」一张不相干的
// 方图——有了数字，模型能按数字判断，而不是按它看上去的形状。只读文件头：PNG 的 IHDR、JPEG 的 SOF 段、WebP 的
// VP8 / VP8L / VP8X 块；认不出返回 null。
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const b = bytes;
  const be16 = (i: number) => (b[i] << 8) | b[i + 1];
  const le16 = (i: number) => b[i] | (b[i + 1] << 8);
  const le24 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  const be32 = (i: number) => b[i] * 0x1000000 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
  const tag = (i: number) => String.fromCharCode(...b.subarray(i, i + 4));
  const dims = (width: number, height: number) => (width > 0 && height > 0 ? { width, height } : null);
  switch (sniffImageMime(b)) {
    case "image/png":
      return b.length >= 24 && tag(12) === "IHDR" ? dims(be32(16), be32(20)) : null;
    case "image/jpeg": {
      let i = 2;
      while (i + 3 < b.length) {
        if (b[i] !== 0xff) return null;
        const marker = b[i + 1];
        if (marker === 0xff) {
          i++; // 填充字节
          continue;
        }
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
          i += 2; // 不带长度的独立标记
          continue;
        }
        if (marker === 0xd9 || marker === 0xda) return null; // 没见到 SOF 就到了图像数据
        // SOF0–SOF15，除去 DHT（C4）、JPG（C8）、DAC（CC）：长度、精度、高、宽
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return i + 8 < b.length ? dims(be16(i + 7), be16(i + 5)) : null;
        }
        const len = be16(i + 2);
        if (len < 2) return null;
        i += 2 + len;
      }
      return null;
    }
    case "image/webp": {
      const chunk = b.length >= 16 ? tag(12) : "";
      if (chunk === "VP8 " && b.length >= 30) return dims(le16(26) & 0x3fff, le16(28) & 0x3fff);
      if (chunk === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
        return dims(1 + (b[21] | ((b[22] & 0x3f) << 8)), 1 + (((b[22] & 0xc0) >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)));
      }
      if (chunk === "VP8X" && b.length >= 30) return dims(1 + le24(24), 1 + le24(27));
      return null;
    }
    default:
      return null;
  }
}

// 极端比例的图，看上去的形状最不可信：结果里点明比例，让模型按数字判断。
export function imageShapeNote(d: { width: number; height: number } | null): string {
  if (!d) return "";
  const ratio = Math.max(d.width, d.height) / Math.min(d.width, d.height);
  return ratio >= 4
    ? ` Extreme aspect ratio (${ratio.toFixed(1)}:1): image viewers may pad or rescale it — go by these pixel dimensions, not by the shape it appears to have.`
    : "";
}

export function looksLikeImagePath(value: string): boolean {
  return /\.(?:png|jpe?g|webp|gif|heic|heif|bmp|tiff?)$/i.test(value);
}

function assetDir(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
  return path.join(sessionsDir(), "assets", sessionId);
}

function assetFile(sessionId: string, assetId: string): string {
  if (!ASSET_ID_RE.test(assetId)) throw new Error(`invalid image asset id: ${assetId}`);
  return path.join(assetDir(sessionId), assetId);
}

export function storeSessionImage(
  sessionId: string,
  bytes: Buffer,
  mime: SupportedImageMime,
  name?: string,
): Extract<Block, { t: "image" }> {
  if (bytes.length > MAX_IMAGE_BYTES) {
    throw new Error(`image exceeds the ${Math.floor(MAX_IMAGE_BYTES / 1024 / 1024)} MB per-image limit`);
  }
  const assetId = `${createHash("sha256").update(bytes).digest("hex")}.${EXT_BY_MIME[mime]}`;
  const dir = assetDir(sessionId);
  const file = assetFile(sessionId, assetId);
  fs.mkdirSync(dir, { recursive: true });
  try {
    // Content-addressed name + exclusive create makes retries and duplicate
    // attachments idempotent without a partially-written replace window.
    fs.writeFileSync(file, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return { t: "image", mime, asset: assetId, ...(name ? { name } : {}) };
}

// Same content-addressed store as images: a screen recording must not be
// re-encoded into every provider request, and must not bloat the transcript.
export function storeSessionVideo(
  sessionId: string,
  bytes: Buffer,
  mime: SupportedVideoMime,
  name?: string,
): Extract<Block, { t: "video" }> {
  if (bytes.length > MAX_VIDEO_BYTES) {
    throw new Error(`video exceeds the ${Math.floor(MAX_VIDEO_BYTES / 1024 / 1024)} MB inline limit`);
  }
  const assetId = `${createHash("sha256").update(bytes).digest("hex")}.${VIDEO_EXT_BY_MIME[mime]}`;
  const dir = assetDir(sessionId);
  const file = assetFile(sessionId, assetId);
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.writeFileSync(file, bytes, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return { t: "video", mime, asset: assetId, ...(name ? { name } : {}) };
}

export function storeSessionAudio(
  sessionId: string, bytes: Buffer, mime: SupportedAudioMime, name?: string, durationSeconds?: number,
): Extract<Block, { t: "audio" }> {
  if (bytes.length > MAX_AUDIO_BYTES) throw new Error("audio exceeds the 24 MB inline limit");
  const assetId = `${createHash("sha256").update(bytes).digest("hex")}.${AUDIO_EXT_BY_MIME[mime]}`;
  fs.mkdirSync(assetDir(sessionId), { recursive: true });
  try { fs.writeFileSync(assetFile(sessionId, assetId), bytes, { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  return { t: "audio", mime, asset: assetId, ...(name ? { name } : {}), ...(durationSeconds ? { durationSeconds } : {}) };
}

// R12（二，K31）：界面按 URL 取会话资产（截图、上传的图 / 音视频）。id 不合法或文件不在返回 null；类型按扩展名定。
const MIME_BY_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", webp: "image/webp",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", flac: "audio/flac", m4a: "audio/mp4", ogg: "audio/ogg",
};
export function sessionAssetForServing(sessionId: string, assetId: string): { file: string; mime: string } | null {
  try {
    const file = assetFile(sessionId, assetId);
    if (!fs.existsSync(file)) return null;
    return { file, mime: MIME_BY_EXT[assetId.slice(assetId.lastIndexOf(".") + 1)] ?? "application/octet-stream" };
  } catch {
    return null;
  }
}

// R12（二，K31）：截图事件不再带 base64（以前每张截图都进 runLog、发给每个在看的设备、每次附着再重放一遍，全部穿隧道）：
// 截图存成会话资产，事件只带资产 id，界面按 URL 取。没有会话（测试）或存不下（超过单图上限）时退回 dataUri。
export function screenshotEvent(
  sessionId: string | undefined,
  bytes: Buffer,
  mime: SupportedImageMime,
  url: string,
  verdict?: string,
): { e: "screenshot"; url: string; asset?: string; dataUri?: string; verdict?: string } {
  const extra = verdict === undefined ? {} : { verdict };
  if (sessionId) {
    try {
      const block = storeSessionImage(sessionId, bytes, mime);
      if (block.asset) return { e: "screenshot", asset: block.asset, url, ...extra };
    } catch {
      /* 退回 dataUri */
    }
  }
  return { e: "screenshot", dataUri: `data:${mime};base64,${bytes.toString("base64")}`, url, ...extra };
}

// Serves all native media assets — the id carries the extension.
export function loadSessionImageBase64(sessionId: string, assetId: string): string {
  return fs.readFileSync(assetFile(sessionId, assetId)).toString("base64");
}

// Q5：会话体检用——转录里引用的资产文件还在不在（id 不合法按「不在」算）。
export function sessionAssetExists(sessionId: string, assetId: string): boolean {
  try {
    return fs.existsSync(assetFile(sessionId, assetId));
  } catch {
    return false;
  }
}

export async function deleteSessionAssets(sessionId: string): Promise<void> {
  if (!SESSION_ID_RE.test(sessionId)) return;
  await fs.promises.rm(assetDir(sessionId), { recursive: true, force: true });
}
