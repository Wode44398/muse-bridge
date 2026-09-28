import fs from "node:fs/promises";
import path from "node:path";

export const IGNORE_DIRS = new Set([
  "node_modules",
  ".git",
  ".svn",
  ".hg",
  "dist",
  "build",
  ".next",
  ".cache",
  "__pycache__",
  ".venv",
  "venv",
  ".tox",
  ".eggs",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".nyc_output",
  "coverage",
  ".idea",
  ".vscode",
  ".gradle",
  ".hypothesis",
]);

function ignoredDirName(name: string): boolean {
  return IGNORE_DIRS.has(name) || name.endsWith(".egg-info");
}

export interface WalkOptions {
  maxFiles?: number;
  includeDirs?: boolean;
  // Honor the walk base's .gitignore (default true). Supported subset: comments,
  // `dir/` dir-only patterns, leading-`/` anchoring, bare names at any depth,
  // glob chars. `!` negations and nested .gitignore files are NOT applied —
  // pruning is best-effort noise reduction, not git fidelity.
  respectGitignore?: boolean;
  // S4：调用方的凭据判定（Grep/Glob 传 readVerdict）。命中的目录整棵不进，文件不交出。
  skip?: (abs: string, isDir: boolean) => boolean;
}

interface IgnoreRule {
  re: RegExp;
  dirOnly: boolean;
}

// Parse the base directory's .gitignore into path-testable rules (paths are
// tested relative to the walk base, forward-slashed, no trailing slash).
async function loadIgnoreRules(root: string): Promise<IgnoreRule[]> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(root, ".gitignore"), "utf8");
  } catch {
    return [];
  }
  const rules: IgnoreRule[] = [];
  for (let line of raw.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#") || line.startsWith("!")) continue;
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    // Git semantics: a leading slash anchors to the root, and so does any
    // pattern containing a slash; a bare name matches at any depth.
    let anchored = line.startsWith("/");
    if (anchored) line = line.slice(1);
    if (line.includes("/")) anchored = true;
    if (!line) continue;
    try {
      const body = globToRegExpSource(line);
      rules.push({ re: new RegExp(anchored ? `^${body}$` : `(^|/)${body}$`), dirOnly });
    } catch {
      // unparseable pattern — skip it
    }
  }
  return rules;
}

function isIgnored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    if (r.re.test(rel)) return true;
  }
  return false;
}

// Depth-first walk yielding absolute paths, skipping common noise dirs and
// (by default) anything the base's .gitignore excludes.
export async function* walk(
  root: string,
  opts: WalkOptions = {},
): AsyncGenerator<{ abs: string; isDir: boolean }> {
  const max = opts.maxFiles ?? 20_000;
  const rules = opts.respectGitignore === false ? [] : await loadIgnoreRules(root);
  let count = 0;
  const stack: string[] = [root];

  while (stack.length) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    // Sort for stable output.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (ent.isDirectory()) {
        if (ignoredDirName(ent.name)) continue;
        if (rules.length && isIgnored(rules, rel, true)) continue;
        if (opts.skip?.(abs, true)) continue;
        if (opts.includeDirs) yield { abs, isDir: true };
        stack.push(abs);
      } else if (ent.isFile()) {
        if (rules.length && isIgnored(rules, rel, false)) continue;
        if (opts.skip?.(abs, false)) continue;
        yield { abs, isDir: false };
        if (++count >= max) return;
      }
    }
  }
}

// Convert a glob (supports **, *, ?, {a,b}) to a RegExp anchored full-match.
// Matches against forward-slash relative paths.
export function globToRegExp(glob: string): RegExp {
  return new RegExp("^" + globToRegExpSource(glob) + "$");
}

// The unanchored regex source for a glob — reused by the .gitignore rules,
// which apply their own anchoring.
function globToRegExpSource(glob: string): string {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** matches across path separators
        i++;
        if (glob[i + 1] === "/") i++;
        re += "(?:.*/)?";
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if (c === "{") {
      const end = glob.indexOf("}", i);
      if (end !== -1) {
        const opts = glob.slice(i + 1, end).split(",").map(escapeRe);
        re += "(?:" + opts.join("|") + ")";
        i = end;
      } else re += "\\{";
    } else if (".+^$()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return re;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
