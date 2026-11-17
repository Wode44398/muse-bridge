// 会话所在的工作区与 GUIDE。
import { readFileSync } from "node:fs";
import path from "node:path";
import { getConfig } from "../config.ts";
import { loadSession } from "../store.ts";
import { globalGuideFile } from "../paths.ts";
import { registry } from "./registry.ts";

// The CURRENT global workspace (runtime-configurable via POST /api/config).
// Sessions snapshot it on first run — use sessionWorkspace() for per-session
// paths (checkpoints, rollback), this only for "what would a new session get".
export function workspaceRoot(): string {
  return getConfig().workspace;
}

// The workspace a specific session runs in: in-memory config first, then the
// persisted record, then the current global root (pre-P records carry none).
export async function sessionWorkspace(id: string): Promise<string> {
  const live = registry.sessions.get(id);
  if (live?.cfg?.workspace) return live.cfg.workspace;
  const rec = await loadSession(id);
  return rec?.config?.workspace ?? workspaceRoot();
}

const GUIDE_MAX_CHARS = 24_000;

// Machine-level guide applied to EVERY workspace (user conventions, locally
// installed tools). DIMENSIO_GLOBAL_GUIDE overrides the path (tests, parallel
// rigs); default is ~/.dimensio/GUIDE.md（解析见 paths.ts）。
const globalGuidePath = globalGuideFile;

function readGuideFile(p: string): string | undefined {
  try {
    const raw = readFileSync(p, "utf8").trim();
    return raw || undefined;
  } catch (e) {
    // Q14：没有 GUIDE 是常态；有却读不了（权限、被占用）要留一句——否则用户写的指令被悄悄忽略
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") console.error(`[guide] ${p} exists but cannot be read (${code ?? "?"}): ${(e as Error).message}`);
    return undefined;
  }
}

// Read the session's guides: the machine-level global guide plus the workspace's
// GUIDE.md (project conventions), merged global-first so the project guide sits
// last and has the final word on conflicts. Read fresh per session so edits take
// effect without a server restart. Capped so a huge file can't blow the context
// budget.
export function readGuide(root: string): string | undefined {
  const parts = [readGuideFile(globalGuidePath()), readGuideFile(path.join(root, "GUIDE.md"))].filter(
    (g): g is string => typeof g === "string",
  );
  if (!parts.length) return undefined;
  const joined = parts.join("\n\n");
  return joined.length > GUIDE_MAX_CHARS
    ? joined.slice(0, GUIDE_MAX_CHARS) + "\n\n[…GUIDE.md truncated]"
    : joined;
}
