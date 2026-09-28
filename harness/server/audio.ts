import { spawnSync } from "node:child_process";
import { helperEnv } from "./helper-proc.ts";

// MiMo consumes the original audio via input_audio.data (a URL or data URI).
// Do not replace it with ASR text: tone, speakers, music and ambient sound matter.
// https://mimo.mi.com/static/docs/quick-start/usage-guide/multimodal-understanding/audio-understanding.md
export type SupportedAudioMime = "audio/mpeg" | "audio/wav" | "audio/flac" | "audio/mp4" | "audio/ogg";
export const AUDIO_EXT_BY_MIME: Record<SupportedAudioMime, string> = {
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/flac": "flac", "audio/mp4": "m4a", "audio/ogg": "ogg",
};
// Below MiMo's 50 MB base64/file ceiling and the local 30 MB upload limit.
export const MAX_AUDIO_BYTES = 24 * 1024 * 1024;
export const MAX_AUDIO_TOTAL_BYTES = 32 * 1024 * 1024;

export function sniffAudioMime(bytes: Uint8Array): SupportedAudioMime | undefined {
  const ascii = (a: number, b: number) => String.fromCharCode(...bytes.slice(a, b));
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "audio/wav";
  if (ascii(0, 4) === "fLaC") return "audio/flac";
  if (ascii(0, 4) === "OggS") return "audio/ogg";
  if (ascii(0, 3) === "ID3") return "audio/mpeg";
  // MPEG audio frame header; reserved version/layer/rate values are invalid.
  // In particular ADTS AAC (layer=0) must not masquerade as MP3.
  if (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0 &&
      (bytes[1] & 0x18) !== 0x08 && (bytes[1] & 0x06) !== 0 &&
      (bytes[2] & 0xf0) !== 0xf0 && (bytes[2] & 0x0c) !== 0x0c) return "audio/mpeg";
  // Audio-specific ISO brands must be detected BEFORE the generic video sniffer.
  if (ascii(4, 8) === "ftyp" && /^M4[AB] /.test(ascii(8, 12))) return "audio/mp4";
  return undefined;
}

export function looksLikeAudioPath(value: string): boolean {
  return /\.(?:mp3|wav|flac|m4a|m4b|ogg|oga|opus|aac|aiff?|wma|weba)$/i.test(value);
}

// Optional metadata only: native audio still works when ffprobe is unavailable.
// The estimate follows MiMo's ~6.25 tokens/second instead of counting base64 as text.
export function audioDurationSeconds(abs: string): number | undefined {
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", abs],
    { encoding: "utf8", windowsHide: true, timeout: 5_000, maxBuffer: 64 * 1024, env: helperEnv() });
  if (probe.status !== 0) return undefined;
  const seconds = Number.parseFloat(probe.stdout.trim());
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}
