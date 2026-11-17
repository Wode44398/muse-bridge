// 附件按路径认类型（输入框里的附件卡、发出去那条消息本机先上屏时用；服务端回放时自己按文件头再认一遍）。
// 纯函数，不引 state：run.ts 与 attach.svelte.ts 都要用，避免循环引用。
export type AttachKind = "image" | "video" | "audio" | "file" | "folder";

const IMG = /\.(?:png|jpe?g|webp|gif|heic|heif|avif|bmp)$/i;
const VID = /\.(?:mp4|mov|webm|mkv|m4v|avi|3gp)$/i;
const AUD = /\.(?:mp3|wav|m4a|aac|flac|ogg|opus)$/i;

export function attachKind(path: string): AttachKind {
  if (path.endsWith("/")) return "folder";
  if (IMG.test(path)) return "image";
  if (VID.test(path)) return "video";
  if (AUD.test(path)) return "audio";
  return "file";
}

// 浏览器 <img> / <video> 直接画得出来的（缩略图用；HEIC 之类画不出，退回文件卡）
export function previewable(path: string): "image" | "video" | null {
  if (/\.(?:png|jpe?g|webp|gif|avif|bmp)$/i.test(path)) return "image";
  if (/\.(?:mp4|mov|webm|m4v)$/i.test(path)) return "video";
  return null;
}

// 文件卡上的类型小标：扩展名大写（最多 4 个字符）
export function extLabel(path: string): string {
  const name = path.replace(/\/$/, "").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 && name.length - dot <= 6 ? name.slice(dot + 1).toUpperCase().slice(0, 4) : "";
}

export function fmtBytes(n: number): string {
  if (!(n >= 0)) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}
