// 工具卡读参数用的同义名（纯函数；server/feed-compact.test.ts 直接测）。模型按别家 harness 的习惯写参数（Read 的 file_path /
// filePath / absolute_path、Grep 的 output_mode……）时，服务端执行前归一成规范名，转录里留的却是模型原话——卡片按规范名读就
// 读不到路径、模式。这里只放卡片摘要要用的那几个，规范名已经在的不动；与服务端的别名表（server/tools/arg-aliases.ts）同一套写法。

const FILE_PATH = ["file_path", "filePath", "absolute_path", "absolutePath", "filename", "file", "target_file"];
const DIR_PATH = ["dir_path", "directory", "dir"];
const GREP_MODE: Record<string, string> = { content: "content", files_with_matches: "files", files: "files", count: "count" };

type Alias = { from: string[]; to: string; values?: Record<string, string> };

const ALIASES: Record<string, Alias[]> = {
  Read: [{ from: FILE_PATH, to: "path" }],
  Write: [{ from: FILE_PATH, to: "path" }, { from: ["contents", "file_text"], to: "content" }],
  Edit: [{ from: FILE_PATH, to: "path" }],
  Grep: [
    { from: [...FILE_PATH, ...DIR_PATH], to: "path" },
    { from: ["output_mode", "outputMode"], to: "mode", values: GREP_MODE },
    { from: ["include"], to: "glob" },
  ],
  Glob: [{ from: DIR_PATH, to: "path" }],
  Bash: [{ from: ["cmd"], to: "command" }, { from: ["run_in_background", "runInBackground"], to: "background" }],
  Agent: [{ from: ["task"], to: "prompt" }, { from: ["description"], to: "label" }],
};

/** 按规范名补齐的参数（浅拷贝；原来的键都留着）。没有要补的就原样返回。 */
export function canonicalArgs(name: string, args: any): any {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const table = ALIASES[name];
  if (!table) return args;
  let out: Record<string, unknown> | null = null;
  for (const a of table) {
    if (args[a.to] !== undefined && args[a.to] !== null && args[a.to] !== "") continue;
    const key = a.from.find((k) => args[k] !== undefined && args[k] !== null && args[k] !== "");
    if (!key) continue;
    const raw = args[key];
    const next: Record<string, unknown> = out ?? { ...args };
    next[a.to] = a.values && typeof raw === "string" ? (a.values[raw.toLowerCase()] ?? raw) : raw;
    out = next;
  }
  return out ?? args;
}

/** 不知道是哪个工具时取路径：规范名优先，再认文件路径的几种写法。 */
export function anyPath(a: any): string {
  if (!a || typeof a !== "object") return "";
  for (const k of ["path", ...FILE_PATH]) if (typeof a[k] === "string" && a[k]) return a[k];
  return "";
}
