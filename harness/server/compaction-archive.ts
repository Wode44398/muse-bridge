// R10（二）：Context Recovery 的归档落盘。整段压缩在提交之前，把被压掉的那段原文按纯文本写进
// sessionsDir()/archive/<会话 id>/compacted-<n>.txt（太大就分片 compacted-<n>-<k>.txt，分片与折行见
// agent/compaction-shape.ts 的 archiveChunks），摘要末尾列出这些文件，模型需要细节时自己 Grep / Read。
// 沙箱只对本会话自己的这个目录开只读豁免（Sandbox.extraReadDirs）；写仍然被会话存储的写保护挡着。删会话时一并删掉。
import fs from "node:fs";
import path from "node:path";
import { atomicWriteFile } from "./atomic-write.ts";
import { sessionsDir } from "./paths.ts";

const SESSION_ID_RE = /^[a-zA-Z0-9-]{1,64}$/;
const FILE_RE = /^compacted-(\d+)(?:-\d+)?\.txt$/;

export function archiveDir(sessionId: string): string {
  if (!SESSION_ID_RE.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
  return path.join(sessionsDir(), "archive", sessionId);
}

// 这次压缩的归档写到哪些文件（count 个分片）；编号接着目录里已有的最大号往下排。只算名字，不落盘。
export function planArchive(sessionId: string, count: number): string[] {
  const dir = archiveDir(sessionId);
  let last = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      const m = FILE_RE.exec(name);
      if (m) last = Math.max(last, Number(m[1]));
    }
  } catch {
    /* 还没有归档 */
  }
  const n = last + 1;
  if (count <= 1) return [path.join(dir, `compacted-${n}.txt`)];
  return Array.from({ length: count }, (_, k) => path.join(dir, `compacted-${n}-${k + 1}.txt`));
}

export async function writeArchive(files: { path: string; text: string }[]): Promise<void> {
  for (const f of files) {
    await fs.promises.mkdir(path.dirname(f.path), { recursive: true });
    await atomicWriteFile(f.path, f.text);
  }
}

export async function deleteSessionArchive(sessionId: string): Promise<void> {
  if (!SESSION_ID_RE.test(sessionId)) return;
  await fs.promises.rm(archiveDir(sessionId), { recursive: true, force: true });
}
