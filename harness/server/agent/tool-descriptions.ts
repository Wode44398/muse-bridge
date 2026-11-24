// 工具说明按姿态改写（档案 tools.descriptions）：lean 用工具自带的精简说明；hardened 换回姿态改造之前的说明原文（基线
// 8849ce00 里这些工具的 description，带着当初给弱模型写的用法要求），只在改造后新加的能力上补一句。
// 只换 description，参数 schema 不分姿态。记忆的 Remember / Recall 不在这里（各自维护说明）。
// 多数工具整段换；Bash 的说明按 shell 与平台拼出来，按片段换（对不上的片段原样留着，profile-posture.test.ts 钉着对得上）。
import type { ToolDef } from "./turn.ts";
import type { Tool } from "../tools/types.ts";

export type DescriptionMode = "lean" | "hardened";

type Rewrite = string | readonly (readonly [string | RegExp, string])[];

const HARDENED: Readonly<Record<string, Rewrite>> = {
  Read:
    "Read a text file, inspect a PNG/JPEG/WebP image, watch an MP4/WebM/MOV video, or listen to MP3/WAV/FLAC/M4A/OGG audio from the sandbox. " +
    "Text returns cat -n style numbered lines. A video goes to the model whole when it reads video, otherwise it is " +
    "sampled into evenly spaced frames (use limit to change how many). Audio is sent natively only to an audio-capable model such as MiMo (24 MB/file). " +
    "A multimodal main model receives image pixels natively; a text-only model receives an auxiliary vision description. " +
    "Use offset/limit for large files; ranges accumulate. You must Read a file before you can Edit it, " +
    "and must have read every line before overwriting it with Write. " +
    "PDFs return their text page by page (pick pages with pages) and Jupyter notebooks return their cells with outputs.",
  Write:
    "Create a new file, or overwrite an existing file you have already Read in full (overwriting " +
    "an unread file is refused so content you never saw can't be lost). Parent directories " +
    "are created automatically. Prefer Edit for changing existing files. " +
    "The saved file gets a quick syntax check (JS/TS/JSON/Python); any syntax error is " +
    "reported in the result — fix it before moving on.",
  Edit:
    "Replace an exact substring in a file you have already Read. old_string must be " +
    "unique unless replace_all is true. Whitespace/quote mismatches are tolerated. " +
    "If the file changed on disk since that Read (your own sed/script write, say), the edit still goes " +
    "through as long as old_string matches the new content uniquely — no re-Read needed. " +
    "old_string and new_string must differ. The saved file gets a quick syntax check " +
    "(JS/TS/JSON/Python); any syntax error is reported in the result — fix it before moving on.",
  Bash: [
    [/^Run a shell command with (\S+)\. /, "Run a shell command in the sandbox working directory using $1. "],
    [
      "Every call starts in the workspace root: state (working directory, environment variables) does NOT persist between calls. ",
      "State (env, cwd changes) does NOT persist between calls. Quote paths with spaces. ",
    ],
    [
      "environment variables do not. ",
      "environment variables do not. Quote paths with spaces. ",
    ],
    [
      "For commands longer than ~2 minutes pass background:true: you get a job id at once, then poll / wait / kill it. " +
        "Servers belong in the Preview tool, not Bash.",
      "Use for builds, tests, git, package managers. Prefer Read/Edit/Grep/Glob over cat/sed/grep/find. " +
        "For commands longer than ~2 minutes (full test suites, long builds) pass background:true — " +
        "you get a job id immediately and can keep working; read output with poll, wait for it to finish with wait, stop with kill. " +
        "Never run a SERVER this way — use the Preview tool for servers.",
    ],
  ],
  Grep:
    "Search file contents by regular expression across the sandbox (skips binaries, " +
    ".gitignore'd and vendored paths). mode 'content' (default) returns file:line:text, " +
    "optionally with surrounding context lines; 'files' returns just the matching file " +
    "paths (best first step when scoping); 'count' returns per-file match counts. " +
    "type filters by language and multiline matches across lines; results are paged: head_limit caps how many come back, offset skips that many for the next page.",
  Glob:
    "Find files by glob pattern (supports **, *, ?, {a,b}). Returns paths relative to the " +
    "sandbox, most-recently-modified first.",
  Agent:
    "Delegate a self-contained task to a sub-agent with its own fresh context; it works autonomously and " +
    "hands back only its conclusions, so your context gets results instead of file dumps. Two tiers: " +
    "subagent_type:\"research\" (default) can Read/Grep/Glob and fetch the web but cannot edit files (its shell commands are read-only) — " +
    "use it when answering would mean reading MANY files (locating an implementation, surveying usages, " +
    "mapping how modules interact). subagent_type:\"coder\" can also Write/Edit/Bash — use it for a well-specified, " +
    "self-contained implementation slice you want done in parallel with other work (it verifies its own " +
    "change; only available while this session is in auto mode). The prompt MUST be self-contained (the " +
    "sub-agent sees nothing of this conversation unless context is \"fork\") and say exactly what to return. Pass `schema` (a JSON object " +
    "schema) to get a validated JSON object back instead of prose — the sub-agent must submit through a " +
    "SubmitResult tool that enforces it. `model`/`effort` override this session's; omit to inherit. Issue " +
    "several Agent calls in ONE turn to run them in parallel. For a single quick lookup you already know how " +
    "to find, use Grep/Read directly instead. " +
    "subagent_type also accepts the custom agent types listed in " +
    "the system prompt; background, id/action (follow up, list, stop), context:\"fork\" and isolation:\"worktree\" are " +
    "explained on their parameters.",
  TodoWrite:
    "Track a multi-step task as a checklist. Send the FULL list each call. Keep exactly one " +
    "item in_progress at a time; mark items completed as soon as they are done. Use for any " +
    "task with 3+ steps.",
  AskUserQuestion:
    "Ask the user to resolve a decision that is genuinely THEIRS to make, and block until they answer. " +
    "Use this ONLY when you cannot proceed on a reasonable assumption: a real fork the task left open " +
    "(which of several valid approaches / targets / scopes), or confirmation before a hard-to-reverse " +
    "action. Do NOT use it for things you can decide yourself, look up, or verify — the default is to " +
    "make a sensible choice, state it, and keep working. Prefer ONE call posing every open question " +
    "(1-4 questions) over stopping repeatedly. Each question gives 2-5 concrete options with a short " +
    "label and a description; the user can always choose 'Other' and type their own answer. After they " +
    "answer, continue the task with their choices.",
  WebFetch:
    "Fetch an http(s) URL and read its content. HTML is converted to readable plain text; " +
    "JSON, plain text, XML and markdown are returned as-is. Use this to consult CURRENT, " +
    "authoritative external information your training data may be stale on — official API/SDK " +
    "docs, package readmes, changelogs, reference pages — and then adapt your code to exactly " +
    "what the page says (current model names, endpoints, parameters). Give the full absolute URL. " +
    "Follows redirects. Binary responses (images, PDFs, archives) are not supported.",
  WebSearch:
    "Search the live web and get back ranked results (title, URL, snippet), plus a grounded " +
    "answer when the backend provides one. Use for DISCOVERY — current model names, versions, " +
    "docs locations, error messages — when you don't know the exact URL; then use WebFetch to " +
    "read the best source in depth.",
  Skill:
    "Load a skill from the Managed skills section (installed by the user in the Bridge extension center, or found in " +
    "the project's or the user's .claude/skills and .dimensio/skills folders). " +
    "For a skill, its instructions arrive as the next message — follow them before doing the work your own way. " +
    "For a package, you get the list of its skills and what each does; then load the one you need by its name. " +
    "Load skills yourself — never ask a sub-agent to read or follow one.",
  ToolSearch:
    "Loads the full instructions and parameter schema of deferred tools. A deferred tool's own description says so and carries " +
    "only a one-line summary; call this before you first use one. Loading one tool loads its whole family (Browser also loads " +
    "ReadPage, Eval and Network). The instructions stay in the conversation — no need to load a tool twice.",
};

/** hardened 姿态下改写说明的工具名（测试用）。 */
export const HARDENED_DESCRIBED: readonly string[] = Object.keys(HARDENED);

function rewrite(name: string, description: string, mode: DescriptionMode): string {
  if (mode !== "hardened") return description;
  const r = HARDENED[name];
  if (r === undefined) return description;
  if (typeof r === "string") return r;
  let out = description;
  for (const [from, to] of r) out = typeof from === "string" ? out.split(from).join(to) : out.replace(from, to);
  return out;
}

/** 一个工具定义在这个姿态下的说明；不用改的原样返回（同一个对象）。 */
export function describeDef(def: ToolDef, mode: DescriptionMode): ToolDef {
  const description = rewrite(def.name, def.description, mode);
  return description === def.description ? def : { ...def, description };
}

/** 一件工具在这个姿态下的形状：只换定义，执行原样。 */
export function describeTool<T extends Tool>(tool: T, mode: DescriptionMode): T {
  const def = describeDef(tool.def, mode);
  return def === tool.def ? tool : { ...tool, def };
}

/** 一组工具按姿态换说明（顺序不变）。 */
export const describeTools = (tools: readonly Tool[], mode: DescriptionMode): Tool[] => tools.map((t) => describeTool(t, mode));

/** 主会话的两份表（定义数组 + 名字→工具）：tmap 就地改，返回新的定义数组（顺序不变）。 */
export function describeTable(defs: readonly ToolDef[], tmap: Map<string, Tool>, mode: DescriptionMode): ToolDef[] {
  if (mode !== "hardened") return [...defs];
  for (const [name, tool] of tmap) tmap.set(name, describeTool(tool, mode));
  return defs.map((d) => describeDef(d, mode));
}
