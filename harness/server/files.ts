import fs from "node:fs/promises";
import path from "node:path";
import type { Sandbox } from "./sandbox.ts";

// Workspace file access for the UI's attach feature: list directories for the
// workspace picker, and accept raw-body uploads from the device. Everything
// goes through the Sandbox (escape + secret guard), same as the agent's tools.

export interface FileEntry {
  name: string;
  dir: boolean;
  size: number;
  mtimeMs: number;
}

const LIST_CAP = 500;

export async function listDir(
  sandbox: Sandbox,
  rel: string,
): Promise<{ path: string; entries: FileEntry[]; truncated: boolean }> {
  const abs = sandbox.resolve(rel.trim() || ".");
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const entries: FileEntry[] = [];
  let truncated = false;
  for (const d of dirents) {
    if (entries.length >= LIST_CAP) {
      truncated = true;
      break;
    }
    let size = 0;
    let mtimeMs = 0;
    try {
      const st = await fs.stat(path.join(abs, d.name));
      size = st.size;
      mtimeMs = st.mtimeMs;
    } catch {
      // racing delete / permission — list the name anyway
    }
    entries.push({ name: d.name, dir: d.isDirectory(), size, mtimeMs });
  }
  entries.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { path: sandbox.rel(abs), entries, truncated };
}

// U4（K08、#16）：附件归会话。以前粘贴 / 拖拽 / 上传一律落进用户项目的 uploads/——成了项目里的未跟踪文件，出现在
// 审阅面板、被影子检查点快照、可能被 agent 的 git add -A 一并提交，同名还互相覆盖，也从不回收。现在落在会话工作区的
// .dimensio/uploads/<会话 id 或草稿 id>/ 下：目录里放一个只有「*」的 .gitignore（git 把整个目录连同它自己当作忽略，
// 不管仓库根在哪、不碰用户自己的 .gitignore）；同名不覆盖，自动加序号；删会话时连同它引用的附件目录一起删。
// 老会话里的 uploads/… 照旧可读（老客户端照旧往那儿传，原来的覆盖语义不变）。
export const SESSION_UPLOADS_DIR = ".dimensio/uploads";
export const UPLOAD_KEY_RE = /^[A-Za-z0-9_-]{6,80}$/;

// 工作区相对路径落在会话附件目录里的话，返回它属于哪个会话 / 草稿（目录名）；否则 null
export function uploadKeyOf(rel: string): string | null {
  const m = /^\.dimensio\/uploads\/([^/]+)\//.exec(rel.replace(/\\/g, "/"));
  return m && UPLOAD_KEY_RE.test(m[1]) ? m[1] : null;
}

async function ensureUploadsIgnored(root: string): Promise<void> {
  const sentinel = path.join(root, ".dimensio", "uploads", ".gitignore");
  if (await fs.stat(sentinel).catch(() => null)) return;
  await fs.mkdir(path.dirname(sentinel), { recursive: true });
  await fs.writeFile(sentinel, "# dimensio 的会话附件：不进版本库（随会话删除回收）\n*\n");
}

async function freeName(abs: string): Promise<string> {
  if (!(await fs.stat(abs).catch(() => null))) return abs;
  const dir = path.dirname(abs);
  const ext = path.extname(abs);
  const stem = path.basename(abs, ext);
  for (let n = 1; n < 1000; n++) {
    const candidate = path.join(dir, `${stem}-${n}${ext}`);
    if (!(await fs.stat(candidate).catch(() => null))) return candidate;
  }
  throw new Error(`too many files named ${stem}${ext}`);
}

export async function saveUpload(
  sandbox: Sandbox,
  rel: string,
  body: Buffer,
): Promise<{ path: string; size: number }> {
  let abs = sandbox.resolve(rel, { forWrite: true });
  const existing = await fs.stat(abs).catch(() => null);
  if (existing?.isDirectory()) {
    throw new Error(`${sandbox.rel(abs)} is a directory`);
  }
  const sessionScoped = uploadKeyOf(sandbox.rel(abs)) !== null;
  if (sessionScoped) {
    await ensureUploadsIgnored(sandbox.root);
    abs = await freeName(abs); // 同名不覆盖：report.pdf → report-1.pdf
  }
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, body);
  return { path: sandbox.rel(abs), size: body.length };
}

// 删会话时回收它的附件目录：会话自己的那个，加上转录里引用到的（新会话第一条消息的附件在草稿 id 目录里）。
// 只删 <ws>/.dimensio/uploads/<key>/ 这一层里的东西，key 必须是合法的目录名。
export async function deleteUploadDirs(root: string, keys: Iterable<string>): Promise<number> {
  const base = path.resolve(root, SESSION_UPLOADS_DIR);
  let removed = 0;
  for (const key of new Set(keys)) {
    if (!UPLOAD_KEY_RE.test(key)) continue;
    const dir = path.resolve(base, key);
    if (path.relative(base, dir) !== key) continue;
    if (!(await fs.stat(dir).catch(() => null))) continue;
    await fs.rm(dir, { recursive: true, force: true });
    removed++;
  }
  return removed;
}
