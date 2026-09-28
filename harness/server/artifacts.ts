import { statSync } from "node:fs";
import path from "node:path";
import type { ArtifactRef, Msg } from "./agent/turn.ts";
import type { Sandbox } from "./sandbox.ts";

const ARTIFACT_CAP = 12;
const DELIVERABLE_EXTS = new Set([
  "md", "markdown", "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv", "tsv",
  "zip", "tar", "gz", "7z", "rar", "png", "jpg", "jpeg", "gif", "webp", "bmp", "heic",
  "heif", "avif", "svg", "mp4", "mov", "webm", "mkv", "avi", "m4v", "mp3", "wav", "m4a",
  "aac", "flac", "ogg", "opus", "html", "htm",
]);
const KIND_BY_EXT: Record<string, ArtifactRef["kind"]> = Object.fromEntries([
  [["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "heif", "avif", "svg"], "image"],
  [["mp4", "mov", "webm", "mkv", "avi", "m4v", "3gp"], "video"],
  [["mp3", "wav", "m4a", "aac", "flac", "ogg", "opus", "amr"], "audio"],
  [["pdf"], "pdf"],
  [["doc", "docx", "xls", "xlsx", "ppt", "pptx", "csv"], "office"],
  [[
    "md", "markdown", "txt", "json", "js", "mjs", "cjs", "ts", "tsx", "jsx", "css",
    "html", "htm", "xml", "yml", "yaml", "py", "sh", "bat", "ps1", "ini", "toml",
    "sql", "vue", "c", "h", "cpp", "cc", "hpp", "java", "kt", "swift", "php", "lua",
    "rb", "go", "rs", "r", "tex", "rst", "log",
  ], "text"],
].flatMap(([exts, kind]) => (exts as string[]).map((ext) => [ext, kind as ArtifactRef["kind"]])));

function assistantText(message: Msg): string {
  return message.content
    .filter((block) => block.t === "text")
    .map((block) => (block as Extract<(typeof message.content)[number], { t: "text" }>).text)
    .join("\n")
    .trim();
}

function finalAssistant(messages: Msg[]): Msg | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === "assistant" && !message.internal && assistantText(message)) return message;
  }
  return undefined;
}

function stripCandidate(raw: string): string {
  let value = raw.trim();
  if (value.startsWith("<") && value.endsWith(">")) value = value.slice(1, -1).trim();
  value = value.replace(/^file:\/\//i, "");
  try { value = decodeURIComponent(value); } catch { /* leave literal percent escapes alone */ }
  value = value.replace(/[?#](?:L?\d+.*)?$/i, "");
  return value.trim();
}

// Pull deliberate path-shaped references from the final prose. Markdown links
// and inline code cover filenames containing spaces; the last expression also
// handles ordinary bare paths such as reports/summary.pdf.
export function referencedPaths(text: string): string[] {
  const found: string[] = [];
  const add = (raw: string) => {
    const value = stripCandidate(raw);
    if (value && !/^https?:\/\//i.test(value)) found.push(value);
  };
  const masked = text
    .replace(/\[[^\]\r\n]*\]\(([^)\r\n]+)\)/g, (_whole, target) => {
      add(target);
      return " ";
    })
    .replace(/`([^`\r\n]+)`/g, (_whole, target) => {
      add(target);
      return " ";
    });
  for (const match of masked.matchAll(/(?:^|[\s（(\[【"“‘])([^\s<>|?*"“”‘’()（）\[\]【】，。；：！？]+\.[A-Za-z0-9]{1,12})(?=$|[\s）)\]】"”’ ，。；：！？])/gmu)) add(match[1]);
  return [...new Set(found)];
}

function mentioned(text: string, abs: string, sandbox: Sandbox): boolean {
  const rel = sandbox.rel(abs);
  const normalizedText = text.replace(/\\/g, "/").toLocaleLowerCase();
  return [rel, abs, path.basename(abs)]
    .map((value) => value.replace(/\\/g, "/").toLocaleLowerCase())
    .some((value) => value.length > 0 && normalizedText.includes(value));
}

function artifactFor(abs: string, sandbox: Sandbox): ArtifactRef | null {
  try {
    const stat = statSync(abs);
    if (!stat.isFile()) return null;
    const name = path.basename(abs);
    const ext = path.extname(name).slice(1).toLowerCase();
    return {
      path: sandbox.rel(abs),
      name,
      kind: KIND_BY_EXT[ext] ?? "file",
      size: stat.size,
    };
  } catch {
    return null;
  }
}

// Attach only files the final response actually presents to the user. Edited
// source files are candidates, not automatic attachments; this keeps ordinary
// coding turns from producing a wall of cards. Paths produced by shell/export
// commands are still discovered from the prose itself.
export function attachAssistantArtifacts(
  messages: Msg[],
  sandbox: Sandbox,
  createdFiles: Iterable<string>,
): ArtifactRef[] {
  const message = finalAssistant(messages);
  if (!message) return [];
  const text = assistantText(message);
  const candidates = new Set<string>();
  const created = new Set<string>();
  for (const abs of createdFiles) {
    const key = process.platform === "win32" ? path.resolve(abs).toLowerCase() : path.resolve(abs);
    created.add(key);
    if (mentioned(text, abs, sandbox)) candidates.add(abs);
  }
  for (const raw of referencedPaths(text)) {
    try {
      const abs = sandbox.resolve(raw);
      const key = process.platform === "win32" ? path.resolve(abs).toLowerCase() : path.resolve(abs);
      const ext = path.extname(abs).slice(1).toLowerCase();
      if (created.has(key) || DELIVERABLE_EXTS.has(ext)) candidates.add(abs);
    } catch { /* unsafe/non-path prose */ }
  }

  const artifacts: ArtifactRef[] = [];
  const seen = new Set<string>();
  for (const abs of candidates) {
    const key = process.platform === "win32" ? path.resolve(abs).toLowerCase() : path.resolve(abs);
    if (seen.has(key)) continue;
    seen.add(key);
    const artifact = artifactFor(abs, sandbox);
    if (artifact) artifacts.push(artifact);
    if (artifacts.length >= ARTIFACT_CAP) break;
  }
  if (artifacts.length) message.artifacts = artifacts;
  else delete message.artifacts;
  return artifacts;
}
