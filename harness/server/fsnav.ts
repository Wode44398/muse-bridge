import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// Whole-machine DIRECTORY navigation for the workspace picker in Settings.
// Deliberately not sandboxed: picking a workspace is exactly the act of
// pointing the sandbox somewhere new, and the caller sits behind the same
// trust boundary as the agent itself (which can already `ls` anywhere via
// Bash). Directory names only — no file contents pass through here.

export interface DirListing {
  path: string;
  parent: string | null;
  dirs: string[];
  // Windows drive roots ("C:\\", "E:\\", …); empty elsewhere.
  drives: string[];
}

const DIR_CAP = 500;

function listDrives(): string[] {
  if (process.platform !== "win32") return [];
  const out: string[] = [];
  for (let c = 65; c <= 90; c++) {
    const root = `${String.fromCharCode(c)}:\\`;
    if (existsSync(root)) out.push(root);
  }
  return out;
}

export async function listDirs(p: string): Promise<DirListing> {
  const abs = path.resolve(p.trim() || os.homedir());
  const dirents = await fs.readdir(abs, { withFileTypes: true });
  const dirs: string[] = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    dirs.push(d.name);
    if (dirs.length >= DIR_CAP) break;
  }
  dirs.sort((a, b) => a.localeCompare(b));
  const parent = path.dirname(abs);
  return {
    path: abs,
    parent: parent === abs ? null : parent,
    dirs,
    drives: listDrives(),
  };
}

export async function makeDir(p: string): Promise<{ path: string }> {
  const trimmed = p.trim();
  if (!trimmed) throw new Error("path is required");
  const abs = path.resolve(trimmed);
  await fs.mkdir(abs, { recursive: true });
  return { path: abs };
}
