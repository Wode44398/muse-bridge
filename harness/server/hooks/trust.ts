// 项目级 hooks 的信任记录：工作区里的 settings 可能来自克隆下来的陌生仓库，用户对这个工作区确认过一次才执行。
// 按「工作区路径 + 项目级 hooks 的内容指纹」记，配置一变指纹就对不上，要重新确认。记录放在 harness 自己的数据目录。
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { atomicWriteFileSync } from "../atomic-write.ts";
import { hookTrustFile } from "../paths.ts";

interface TrustFile {
  version: 1;
  workspaces: Record<string, { hash: string; at: number }>;
}

const fold = (p: string) => {
  const abs = path.resolve(p);
  return process.platform === "win32" ? abs.toLowerCase() : abs;
};

function readTrust(): TrustFile {
  try {
    const raw = JSON.parse(readFileSync(hookTrustFile(), "utf8")) as Partial<TrustFile>;
    if (raw && typeof raw.workspaces === "object" && raw.workspaces) return { version: 1, workspaces: raw.workspaces };
  } catch {
    /* 没有或坏了：当作谁都没信任过 */
  }
  return { version: 1, workspaces: {} };
}

export function projectHooksTrusted(workspace: string, hash: string): boolean {
  return readTrust().workspaces[fold(workspace)]?.hash === hash;
}

export function trustProjectHooks(workspace: string, hash: string): void {
  const data = readTrust();
  data.workspaces[fold(workspace)] = { hash, at: Date.now() };
  const file = hookTrustFile();
  mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, JSON.stringify(data, null, 2));
}
