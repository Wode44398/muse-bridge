import { spawnSync } from "node:child_process";
import { helperEnv } from "./helper-proc.ts";

// Video input. Two paths, because providers differ:
//   - a model that ingests video gets the file itself (Kimi k3 verified live on
//     2026-08-20 with a red→green→blue probe clip: it answers all three colours
//     in order and its reasoning names the sampled timestamps, so it really does
//     read the timeline rather than one frame);
//   - everything else gets evenly spaced frames as images, which is what a model
//     had to do by hand with ffmpeg before this existed.
export type SupportedVideoMime = "video/mp4" | "video/webm" | "video/quicktime";

export const VIDEO_EXT_BY_MIME: Record<SupportedVideoMime, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
};

// Inline video is base64 in a JSON body, so the wire cost is ~4/3 of this.
export const MAX_VIDEO_BYTES = 24 * 1024 * 1024;
export const DEFAULT_FRAMES = 8;
export const MAX_FRAMES = 24;
const FRAME_MAX_WIDTH = 768;
const FFMPEG_TIMEOUT_MS = 60_000;
const FRAME_MAX_BUFFER = 16 * 1024 * 1024;

export function sniffVideoMime(bytes: Uint8Array): SupportedVideoMime | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  // ISO base media: a size-prefixed "ftyp" box. The brand separates QuickTime
  // from the mp4 family; both decode, they just need the honest mime.
  if (bytes.length >= 12 && ascii(4, 8) === "ftyp") {
    return ascii(8, 12).startsWith("qt") ? "video/quicktime" : "video/mp4";
  }
  // EBML header — webm and matroska share it and share a decoder downstream.
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return "video/webm";
  }
  return undefined;
}

// 不含裸 `.ts`（#66）：那是 TypeScript 源码的扩展名。08-20 起它在这里，Read 任何 .ts 文件都报
// 「unsupported video」（Edit 要求先 Read，于是 .ts 基本改不了），拖进对话的 .ts 附件也被拒。
// 真正的 MPEG-TS 视频是二进制，会落到 Read 的二进制检测，提示改用 ffprobe/ffmpeg。
export function looksLikeVideoPath(value: string): boolean {
  return /\.(?:mp4|m4v|webm|mkv|mov|avi|wmv|flv|mpe?g|mpeg|m2ts)$/i.test(value);
}

let ffmpegChecked = false;
let ffmpegPresent = false;

export function ffmpegAvailable(): boolean {
  if (!ffmpegChecked) {
    ffmpegChecked = true;
    ffmpegPresent = spawnSync("ffmpeg", ["-version"], { windowsHide: true, timeout: 10_000 }).status === 0;
  }
  return ffmpegPresent;
}

export function videoDurationSeconds(abs: string): number | null {
  const probe = spawnSync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", abs],
    { encoding: "utf8", windowsHide: true, timeout: FFMPEG_TIMEOUT_MS, env: helperEnv() },
  );
  if (probe.status !== 0) return null;
  const seconds = Number.parseFloat((probe.stdout ?? "").trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
}

export interface VideoFrame {
  atSeconds: number;
  jpeg: Buffer;
}

// Sample the MIDDLE of each bucket rather than its start: the first frame of a
// screen recording is usually a black or half-drawn window, which is the least
// informative frame in the whole clip.
export function extractFrames(abs: string, count: number): VideoFrame[] {
  const duration = videoDurationSeconds(abs);
  if (duration === null) return [];
  const wanted = Math.max(1, Math.min(MAX_FRAMES, count));
  const frames: VideoFrame[] = [];
  for (let i = 0; i < wanted; i++) {
    const at = (duration * (i + 0.5)) / wanted;
    const shot = spawnSync(
      "ffmpeg",
      [
        "-v", "error",
        "-ss", at.toFixed(3),
        "-i", abs,
        "-frames:v", "1",
        "-vf", `scale='min(${FRAME_MAX_WIDTH},iw)':-2`,
        "-f", "image2pipe",
        "-c:v", "mjpeg",
        "-q:v", "4",
        "-",
      ],
      { windowsHide: true, timeout: FFMPEG_TIMEOUT_MS, maxBuffer: FRAME_MAX_BUFFER, env: helperEnv() },
    );
    const jpeg = shot.stdout;
    // A seek past the last keyframe of a short clip yields nothing; skip it
    // rather than handing a provider an empty image part.
    if (shot.status === 0 && jpeg && jpeg.length > 4 && jpeg[0] === 0xff && jpeg[1] === 0xd8) {
      frames.push({ atSeconds: at, jpeg });
    }
  }
  return frames;
}

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const mm = String(Math.floor(total / 60)).padStart(2, "0");
  const ss = String(total % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}
