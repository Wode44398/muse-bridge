// 把一条用户消息与附件整理成要发给模型的内容块。
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import type { AttachmentRef, Block } from "../agent/turn.ts";
import type { RefDigest } from "../session-refs.ts";
import { looksLikeImagePath, MAX_ATTACHMENT_REFS, MAX_IMAGE_ATTACHMENTS, MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL_BYTES, sniffImageMime, storeSessionAudio, storeSessionImage, storeSessionVideo } from "../image-assets.ts";
import { DEFAULT_FRAMES, extractFrames, ffmpegAvailable, formatTimestamp, looksLikeVideoPath, MAX_VIDEO_BYTES, sniffVideoMime, type SupportedVideoMime } from "../video.ts";
import { audioDurationSeconds, looksLikeAudioPath, MAX_AUDIO_BYTES, MAX_AUDIO_TOTAL_BYTES, sniffAudioMime, type SupportedAudioMime } from "../audio.ts";
import type { Session } from "./types.ts";

interface PreparedUserInput {
  content: Block[];
  attachments: AttachmentRef[];
  displayText: string;
  retrievalText: string;
  title: string;
}

export function prepareUserInput(
  session: Session,
  message: string,
  attachmentPaths: string[],
  refs: RefDigest[] = [],
): PreparedUserInput {
  const state = session.state!;
  const unique = [...new Set(attachmentPaths.map((value) => String(value).trim()).filter(Boolean))];
  // 上限管的是「一条消息挂多少个路径」；原生入模的图另有 MAX_IMAGE_ATTACHMENTS，超出的图照样按路径交给模型。
  if (unique.length > MAX_ATTACHMENT_REFS) {
    throw new Error(`too many attachments (maximum ${MAX_ATTACHMENT_REFS} per message)`);
  }

  const attachments: AttachmentRef[] = [];
  const imageCandidates: Array<{
    label: string;
    bytes: Buffer;
    mime: NonNullable<ReturnType<typeof sniffImageMime>>;
  }> = [];
  const readable: AttachmentRef[] = [];
  // 型号收不了原生媒体（不支持音频 / 格式不认 / 超过内联上限）时不拒发：文件照样作为工作区路径交给模型，
  // 附一句为什么没原样发、可以怎么处理（ffmpeg 转码、ffprobe 看元数据……）。11-14 维护者：「至少也能把文件本身给模型发过去」。
  const notes = new Map<string, string>();
  const fallback = (ref: AttachmentRef, note: string) => {
    readable.push(ref);
    notes.set(ref.path, note);
  };
  const videoCandidates: Array<{ label: string; abs: string; mime: SupportedVideoMime; size: number }> = [];
  const audioCandidates: Array<{ label: string; abs: string; mime: SupportedAudioMime }> = [];
  let totalAudioBytes = 0;
  let totalImageBytes = 0;

  for (const requested of unique) {
    const abs = state.ctx.sandbox.resolve(requested);
    let stat;
    try {
      stat = statSync(abs);
    } catch (error) {
      throw new Error(`attachment ${requested} is not readable: ${(error as Error).message}`);
    }
    const label = state.ctx.sandbox.rel(abs);
    if (stat.isDirectory()) {
      const ref: AttachmentRef = { path: label.endsWith("/") ? label : `${label}/`, kind: "folder" };
      attachments.push(ref);
      readable.push(ref);
      continue;
    }
    if (!stat.isFile()) throw new Error(`attachment ${requested} is not a regular file`);

    const header = Buffer.alloc(16);
    const fd = openSync(abs, "r");
    try {
      readSync(fd, header, 0, header.length, 0);
    } finally {
      closeSync(fd);
    }
    const mb = (n: number) => `${Math.floor(n / 1024 / 1024)} MB`;
    const audioMime = sniffAudioMime(header, abs);
    if (audioMime) {
      const ref: AttachmentRef = { path: label, kind: "audio" };
      attachments.push(ref);
      const why = !state.ctx.agentHearsAudio
        ? "the current model takes no audio input"
        : stat.size > MAX_AUDIO_BYTES
          ? `it is larger than the ${mb(MAX_AUDIO_BYTES)} inline audio limit`
          : totalAudioBytes + stat.size > MAX_AUDIO_TOTAL_BYTES
            ? `the audio in this message exceeds the ${mb(MAX_AUDIO_TOTAL_BYTES)} inline total`
            : "";
      if (why) {
        fallback(ref, `audio, not sent as sound because ${why} — inspect it with ffprobe/ffmpeg via Bash (metadata, transcoding, splitting, transcription tools if installed)`);
        continue;
      }
      totalAudioBytes += stat.size;
      audioCandidates.push({ label, abs, mime: audioMime });
      continue;
    }
    if (looksLikeAudioPath(label)) {
      const ref: AttachmentRef = { path: label, kind: "audio" };
      attachments.push(ref);
      fallback(ref, "audio in a format that cannot be sent natively (only MP3/WAV/FLAC/M4A/OGG) — use ffprobe/ffmpeg via Bash, e.g. convert to MP3 and Read that");
      continue;
    }
    const mime = sniffImageMime(header);
    if (!mime) {
      const videoMime = sniffVideoMime(header);
      if (videoMime) {
        videoCandidates.push({ label, abs, mime: videoMime, size: stat.size });
        const ref: AttachmentRef = { path: label, kind: "video" };
        attachments.push(ref);
        continue;
      }
      if (looksLikeImagePath(label)) {
        const ref: AttachmentRef = { path: label, kind: "file" };
        attachments.push(ref);
        fallback(ref, "image in a format Read cannot show (only PNG/JPEG/WebP) — convert it via Bash first (e.g. ffmpeg -i in out.png, or magick) and Read the PNG");
        continue;
      }
      if (looksLikeVideoPath(label)) {
        const ref: AttachmentRef = { path: label, kind: "video" };
        attachments.push(ref);
        fallback(ref, "video in a container that cannot be sent natively (only MP4/WebM/MOV) — remux/convert with ffmpeg via Bash, then Read the MP4 to sample frames");
        continue;
      }
      const ref: AttachmentRef = { path: label, kind: "file" };
      attachments.push(ref);
      readable.push(ref);
      continue;
    }

    const ref: AttachmentRef = { path: label, kind: "image" };
    attachments.push(ref);
    if (!state.ctx.agentSeesImages) {
      readable.push(ref);
      continue;
    }
    const imageWhy = imageCandidates.length >= MAX_IMAGE_ATTACHMENTS
      ? `only the first ${MAX_IMAGE_ATTACHMENTS} images of a message are attached inline`
      : stat.size > MAX_IMAGE_BYTES
        ? `it is larger than the ${mb(MAX_IMAGE_BYTES)} inline image limit`
        : totalImageBytes + stat.size > MAX_IMAGE_TOTAL_BYTES
          ? `the images in this message exceed the ${mb(MAX_IMAGE_TOTAL_BYTES)} inline total`
          : "";
    if (imageWhy) {
      fallback(ref, `image, not attached inline because ${imageWhy} — Read it if you need to see it (downscale it via Bash first if Read reports it too large)`);
      continue;
    }
    totalImageBytes += stat.size;
    const bytes = readFileSync(abs);
    imageCandidates.push({ label, bytes, mime });
  }

  // Persist only after every attachment has passed validation, so a bad item at
  // the end of a batch cannot leave a partially-created session asset set.
  const audioBlocks: Block[] = audioCandidates.flatMap(({ label, abs, mime }) => [
    { t: "text", text: `Audio: ${label}` },
    storeSessionAudio(session.id, readFileSync(abs), mime, label, audioDurationSeconds(abs)),
  ]);
  const nativeImages = imageCandidates.map(({ label, bytes, mime }) => ({
    label,
    block: storeSessionImage(session.id, bytes, mime, label),
  }));

  // Video: hand the file over whole when the model reads video, otherwise sample
  // it into frames — which is what a model previously had to do by hand with
  // ffmpeg, and only if it thought to.
  const videoBlocks: Block[] = [];
  for (const item of videoCandidates) {
    if (state.ctx.agentSeesVideo && item.size <= MAX_VIDEO_BYTES) {
      videoBlocks.push({ t: "text", text: `Video: ${item.label}` });
      videoBlocks.push(storeSessionVideo(session.id, readFileSync(item.abs), item.mime, item.label));
      continue;
    }
    const why = state.ctx.agentSeesVideo
      ? `it is larger than the ${Math.floor(MAX_VIDEO_BYTES / 1024 / 1024)} MB inline limit`
      : "this model does not read video";
    const frames = state.ctx.agentSeesImages && ffmpegAvailable() ? extractFrames(item.abs, DEFAULT_FRAMES) : [];
    if (!frames.length) {
      const ref: AttachmentRef = { path: item.label, kind: "video" };
      readable.push(ref);
      continue;
    }
    videoBlocks.push({
      t: "text",
      text: `Video: ${item.label} — sampled into ${frames.length} frames because ${why}. Frame timestamps follow each image.`,
    });
    for (const frame of frames) {
      videoBlocks.push({ t: "text", text: `Frame at ${formatTimestamp(frame.atSeconds)}` });
      videoBlocks.push(storeSessionImage(session.id, frame.jpeg, "image/jpeg", `${item.label}@${formatTimestamp(frame.atSeconds)}`));
    }
  }

  const displayText = message.trim();
  const content: Block[] = [];
  if (displayText) {
    content.push({ t: "text", text: displayText });
  } else if (nativeImages.length || videoBlocks.length || audioBlocks.length) {
    content.push({ t: "text", text: "Analyze the attached media and respond with the most useful findings." });
  } else if (readable.length) {
    content.push({ t: "text", text: "Inspect the attached workspace resources and respond with the most useful findings." });
  }

  for (let i = 0; i < nativeImages.length; i++) {
    const image = nativeImages[i];
    content.push({ t: "text", text: `Image ${i + 1}: ${image.label}` });
    content.push(image.block);
  }
  content.push(...videoBlocks, ...audioBlocks);
  if (readable.length) {
    const lines = readable.map((ref) => {
      const note = notes.get(ref.path);
      if (note) return `- ${ref.path} (${note})`;
      return `- ${ref.path}${ref.kind === "image" ? " (image)" : ref.kind === "video" ? " (video — Read it to sample frames)" : ""}`;
    });
    const imageInstruction = readable.some((ref) => ref.kind === "image" && !notes.has(ref.path))
      ? " The current main model is text-only; call Read on image paths to use the configured auxiliary vision channel."
      : "";
    content.push({
      t: "text",
      text: `[Attached workspace resources — call Read/Glob as needed]\n${lines.join("\n")}${imageInstruction}`,
    });
  }
  // 引用会话：每个被引用的对话一份摘要，跟在这条消息后面（给模型看；界面上是气泡里的芯片）
  for (const ref of refs) content.push({ t: "text", text: ref.text });
  if (!content.length) throw new Error("message or attachments are required");

  const paths = attachments.map((ref) => ref.path).join(" ");
  const retrievalText = [displayText, paths].filter(Boolean).join("\n");
  const fallbackTitle = attachments.length
    ? `附件：${path.basename(attachments[0].path.replace(/\/$/, ""))}`
    : refs.length
      ? `引用：${refs[0].title}`.slice(0, 60)
      : "New task";
  return {
    content,
    attachments,
    displayText,
    retrievalText,
    title: displayText.replace(/\s+/g, " ").slice(0, 60) || fallbackTitle,
  };
}
