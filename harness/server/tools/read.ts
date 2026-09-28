import fs from "node:fs/promises";
import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail, ok } from "./types.ts";
import { redactOutput } from "../redact.ts";
import type { Block } from "../agent/turn.ts";
import { imageDimensions, imageShapeNote, looksLikeImagePath, MAX_IMAGE_BYTES, sniffImageMime } from "../image-assets.ts";
import { MAX_EDGE } from "../agent/media-budget.ts";
import { sniffAudioMime, looksLikeAudioPath, MAX_AUDIO_BYTES, audioDurationSeconds } from "../audio.ts";
import { describeImage, visionConfigured, visionModel } from "../vision.ts";
import {
  DEFAULT_FRAMES,
  extractFrames,
  ffmpegAvailable,
  formatTimestamp,
  looksLikeVideoPath,
  MAX_VIDEO_BYTES,
  sniffVideoMime,
  videoDurationSeconds,
  type SupportedVideoMime,
} from "../video.ts";

const MAX_LINES = 2000;
const MAX_LINE_LEN = 2000;
const BINARY_SNIFF_BYTES = 8192;

export const readTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: {
    name: "Read",
    description:
      "Read a text file, inspect a PNG/JPEG/WebP image, watch an MP4/WebM/MOV video, or listen to MP3/WAV/FLAC/M4A/OGG audio from the sandbox. " +
      "Text returns cat -n style numbered lines. A video goes to the model whole when it reads video, otherwise it is " +
      "sampled into evenly spaced frames (use limit to change how many). Audio is sent natively only to an audio-capable model such as MiMo (24 MB/file). " +
      "A multimodal main model receives image pixels natively; a text-only model receives an auxiliary vision description. " +
      "Use offset/limit for large files; ranges accumulate. You must Read a file before you can Edit it, " +
      "and must have read every line before overwriting it with Write.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (relative to the sandbox root or absolute within it)." },
        offset: { type: "integer", description: "1-based line to start from." },
        limit: { type: "integer", description: `Max lines to read (default ${MAX_LINES}); for a video, how many frames to sample (default ${DEFAULT_FRAMES}).` },
        question: { type: "string", description: "For media, the specific question to answer." },
        fullRes: {
          type: "boolean",
          description: "For an image: send the original pixels. By default images are downscaled to at most 2000px on the long edge before you see them; use this only when fine detail (small text) is unreadable.",
        },
      },
      required: ["path"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const abs = ctx.sandbox.resolve(String(args.path));
    let bytes: Buffer;
    let mtimeMs: number;
    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) return fail("not a file", `${args.path} is a directory. Use Glob or Grep to explore it.`);
      mtimeMs = stat.mtimeMs;
      if (stat.size > MAX_IMAGE_BYTES) {
        // We still allow large text files (line paging handles their display),
        // but avoid eagerly loading an oversized probable image into a provider.
        const handle = await fs.open(abs, "r");
        try {
          const header = Buffer.alloc(16);
          await handle.read(header, 0, header.length, 0);
          if (sniffImageMime(header)) {
            return fail("image too large", `${args.path} exceeds the ${MAX_IMAGE_BYTES / 1024 / 1024} MB image limit.`);
          }
        } finally {
          await handle.close();
        }
      }
      // Sniff before slurping: a screen recording can be hundreds of megabytes,
      // and the frame sampler works from the path, not from a buffer.
      const probe = await fs.open(abs, "r");
      let head: Buffer;
      try {
        head = Buffer.alloc(16);
        await probe.read(head, 0, head.length, 0);
      } finally {
        await probe.close();
      }
      const audioMime = sniffAudioMime(head);
      if (audioMime) {
        if (!ctx.agentHearsAudio) return fail("audio needs native support", "This model takes no audio input. Switch to MiMo to hear the original audio.");
        if (stat.size > MAX_AUDIO_BYTES) return fail("audio too large", "Audio exceeds the 24 MB inline limit. Compress to MP3/FLAC or split into shorter clips before Read.");
        const rel = ctx.sandbox.rel(abs);
        return {
          ok: true, summary: `read audio ${rel}`,
          content: [{ t: "text", text: `Loaded ${rel} (${audioMime}). Listen to the attached original audio. ${String(args.question ?? "Describe the speech, speakers and sounds.")}` }],
          feedback: [{ t: "audio", mime: audioMime, data: (await fs.readFile(abs)).toString("base64"), name: rel, durationSeconds: audioDurationSeconds(abs) }],
        };
      }
      if (looksLikeAudioPath(abs)) return fail("unsupported audio", "Use a valid MP3, WAV, FLAC, M4A, or OGG. Convert other formats with ffmpeg first.");
      const videoMime = sniffVideoMime(head);
      if (videoMime) return await readVideo(abs, ctx, videoMime, stat.size, args);
      bytes = await fs.readFile(abs);
    } catch (e) {
      return fail("read failed", `Could not read ${args.path}: ${(e as Error).message}`);
    }

    const imageMime = sniffImageMime(bytes);
    if (imageMime) {
      const rel = ctx.sandbox.rel(abs);
      const question = String(args.question ?? "").trim() ||
        "Describe this image in detail, including visible text, layout, objects, and anything relevant to coding or UI work.";
      // U5：写明像素尺寸（视觉侧会缩放、补边）；入模前会被降采样的也说一声
      const dims = imageDimensions(bytes);
      const px = dims ? `${dims.width}×${dims.height} px` : "";
      if (ctx.agentSeesImages) {
        const scaled = dims && Math.max(dims.width, dims.height) > MAX_EDGE && args.fullRes !== true
          ? ` You receive it downscaled to at most ${MAX_EDGE} px on the long edge — pass fullRes:true for the original pixels.`
          : "";
        return {
          ok: true,
          summary: `read image ${rel}${px ? ` (${px})` : ""}`,
          content: [{ t: "text", text: `Loaded ${rel} (${imageMime}, ${px ? `${px}, ` : ""}${bytes.length} bytes).${imageShapeNote(dims)}${scaled} Inspect the attached image and answer: ${question}` }],
          feedback: [{ t: "image", mime: imageMime, data: bytes.toString("base64"), name: rel, ...(args.fullRes === true ? { fullRes: true } : {}) }],
        };
      }
      if (!visionConfigured()) {
        return fail(
          "image needs vision",
          `Loaded ${rel}, but the current main model is text-only and no auxiliary vision model is configured. ` +
            "Switch to a catalog model marked multimodal or configure VISION_API_KEY.",
        );
      }
      try {
        const verdict = await describeImage(bytes, question, { mime: imageMime });
        return {
          ok: true,
          summary: `read image via ${verdict.model}`,
          content: [{ t: "text", text: `Visual analysis of ${rel}${px ? ` (${px})` : ""} via ${verdict.model}:${imageShapeNote(dims)}\n\n${verdict.text}` }],
        };
      } catch (error) {
        return fail(
          "vision failed",
          `Could not analyze ${rel} with ${visionModel()}: ${(error as Error).message}`,
        );
      }
    }

    if (looksLikeImagePath(String(args.path))) {
      return fail("unsupported image", `${args.path} is not a valid PNG, JPEG, or WebP image.`);
    }

    if (looksLikeVideoPath(String(args.path))) {
      return fail(
        "unsupported video",
        `${args.path} is not an MP4, WebM, or MOV. Convert it first (ffmpeg -i "${args.path}" out.mp4) and Read that.`,
      );
    }

    // A binary file decoded as UTF-8 is a context bomb: an mp4/apk turns into
    // hundreds of KB of mojibake, because long lines are clipped but the line
    // COUNT is not. A NUL byte in the head is the classic text/binary split —
    // no encoding this tool can usefully return contains one.
    const nul = bytes.subarray(0, BINARY_SNIFF_BYTES).indexOf(0);
    if (nul !== -1) {
      return fail(
        "binary file",
        `${args.path} is binary (NUL byte at offset ${nul}, ${bytes.length} bytes) — Read only returns text. ` +
          "Inspect it with the right tool through Bash instead: ffprobe/ffmpeg for video or audio, " +
          "unzip -l for an archive/apk, xxd or strings for anything else. " +
          "UTF-16 text needs `iconv -f UTF-16 -t UTF-8` first.",
      );
    }

    const raw = bytes.toString("utf8");

    const allLines = raw.split("\n");
    const offset = Math.max(1, Number(args.offset ?? 1));
    const limit = Math.max(1, Number(args.limit ?? MAX_LINES));
    const slice = allLines.slice(offset - 1, offset - 1 + limit);

    // Keep full bytes only for concurrent-change detection. Separately track
    // what was actually returned to the model so a one-line Read cannot unlock
    // a destructive whole-file Write.
    const previous = ctx.readFileState.get(abs);
    const ranges = previous?.content === raw ? [...previous.readRanges] : [];
    if (slice.length) ranges.push([offset, offset + slice.length - 1]);
    const readRanges = mergeRanges(ranges);
    const complete = readRanges.length === 1 && readRanges[0][0] <= 1 && readRanges[0][1] >= allLines.length;
    ctx.readFileState.set(abs, { mtimeMs, content: raw, readRanges, complete });

    const numbered = slice
      .map((line, i) => {
        const n = offset + i;
        const clipped = line.length > MAX_LINE_LEN ? line.slice(0, MAX_LINE_LEN) + " …[truncated]" : line;
        return `${String(n).padStart(6)}\t${clipped}`;
      })
      .join("\n");

    const shownEnd = offset - 1 + slice.length;
    const more = shownEnd < allLines.length ? `\n… ${allLines.length - shownEnd} more lines (use offset=${shownEnd + 1}).` : "";
    // S4 出口脱敏：正文里恰好有一把真令牌时不整段交给模型（readFileState 仍存原文，用于并发检查）。
    const body = numbered.length ? redactOutput(numbered) + more : "(empty file)";

    return {
      ok: true,
      summary: `read ${ctx.sandbox.rel(abs)} (${slice.length} lines)`,
      // U8（K36）：只读了一段就写清是哪一段
      outcome: !allLines.length || !slice.length
        ? "空文件"
        : slice.length >= allLines.length
          ? `读了全部 ${allLines.length} 行`
          : `读了第 ${offset}–${shownEnd} 行（共 ${allLines.length} 行）`,
      content: [{ t: "text", text: body }],
    };
  },
};

// A video the model can ingest goes over whole; anything else is sampled into
// evenly spaced frames. Before this existed the model had to know to shell out
// to ffmpeg itself — k3 did exactly that, one frame at a time.
async function readVideo(
  abs: string,
  ctx: ToolContext,
  mime: SupportedVideoMime,
  size: number,
  args: Record<string, unknown>,
): Promise<ToolRunResult> {
  const rel = ctx.sandbox.rel(abs);
  const duration = ffmpegAvailable() ? videoDurationSeconds(abs) : null;
  const length = duration === null ? "unknown length" : `${formatTimestamp(duration)} long`;
  const question = String(args.question ?? "").trim();

  if (ctx.agentSeesVideo && size <= MAX_VIDEO_BYTES) {
    const data = (await fs.readFile(abs)).toString("base64");
    return {
      ok: true,
      summary: `read video ${rel} (${length})`,
      content: [{
        t: "text",
        text: `Loaded ${rel} (${mime}, ${size} bytes, ${length}). Watch the attached video` +
          (question ? ` and answer: ${question}` : " and report what happens in it, with timestamps."),
      }],
      feedback: [{ t: "video", mime, data, name: rel }],
    };
  }

  if (!ffmpegAvailable()) {
    return fail(
      "no video decoder",
      `${rel} is a video, but this model cannot read video and ffmpeg is not on PATH to sample frames from it.`,
    );
  }
  const wanted = Number.isFinite(Number(args.limit)) ? Number(args.limit) : DEFAULT_FRAMES;
  const frames = extractFrames(abs, wanted);
  if (!frames.length) {
    return fail("video unreadable", `ffmpeg could not decode any frame from ${rel}.`);
  }
  const why = ctx.agentSeesVideo
    ? `it exceeds the ${Math.floor(MAX_VIDEO_BYTES / 1024 / 1024)} MB inline limit`
    : "this model does not read video";
  const header =
    `${rel} (${mime}, ${length}) sampled into ${frames.length} frames because ${why}.` +
    (question ? ` Question: ${question}` : "");

  if (ctx.agentSeesImages) {
    const content: Block[] = [{ t: "text", text: header }];
    const feedback: Block[] = [];
    for (const frame of frames) {
      feedback.push({ t: "text", text: `Frame at ${formatTimestamp(frame.atSeconds)}` });
      feedback.push({ t: "image", mime: "image/jpeg", data: frame.jpeg.toString("base64"), name: `${rel}@${formatTimestamp(frame.atSeconds)}` });
    }
    return { ok: true, summary: `read video ${rel} (${frames.length} frames)`, content, feedback };
  }

  // Text-only main model: describe a few frames through the auxiliary vision
  // channel rather than returning nothing useful.
  if (!visionConfigured()) {
    return fail(
      "video needs vision",
      `${rel} sampled into ${frames.length} frames, but the main model is text-only and no auxiliary vision model is configured.`,
    );
  }
  const picked = frames.filter((_, i) => i % Math.ceil(frames.length / 3) === 0).slice(0, 3);
  const described: string[] = [];
  for (const frame of picked) {
    try {
      const verdict = await describeImage(frame.jpeg, question || "Describe this video frame: what is on screen, and any visible text.", { mime: "image/jpeg" });
      described.push(`At ${formatTimestamp(frame.atSeconds)} (${verdict.model}): ${verdict.text}`);
    } catch (error) {
      described.push(`At ${formatTimestamp(frame.atSeconds)}: vision failed — ${(error as Error).message}`);
    }
  }
  const joined = described.join("\n\n");
  return ok(`described ${picked.length} frames of ${rel}`, `${header}\n\n${joined}`);
}

function mergeRanges(input: Array<[number, number]>): Array<[number, number]> {
  const sorted = input
    .filter(([start, end]) => start > 0 && end >= start)
    .sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [];
  for (const [start, end] of sorted) {
    const last = merged[merged.length - 1];
    if (!last || start > last[1] + 1) merged.push([start, end]);
    else last[1] = Math.max(last[1], end);
  }
  return merged;
}
