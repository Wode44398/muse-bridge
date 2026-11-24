// 工具入参别名表（纯数据，不 import 任何工具）：各家 harness 给同一个参数起的名字不一样（Read 的 file_path / absolute_path、
// Grep 的 output_mode、Bash 的 run_in_background……）。schema 里的规范名不改（前端工具卡与历史转录都按它读），执行前由
// agent/tool-input.ts 把这里登记的别名归一成规范名；转录里留的仍是模型的原话，所以读转录的地方用 tool-input.ts 的 toolArg 取参。
// 工具定义经 Tool.aliases 引用自己那一张；按名字查（读转录时手里只有名字）走 ARG_ALIASES。

/** 一个别名：to 是规范名；values 把别家的取值换成本工具的取值（键按小写比）。 */
export interface ArgAlias {
  to: string;
  values?: Record<string, string>;
}
export type ArgAliasTable = Readonly<Record<string, string | ArgAlias>>;

const FILE_PATH: ArgAliasTable = {
  file_path: "path",
  filePath: "path",
  absolute_path: "path",
  absolutePath: "path",
  filename: "path",
  file: "path",
  target_file: "path",
};

const DIR_PATH: ArgAliasTable = {
  dir_path: "path",
  directory: "path",
  dir: "path",
};

const GREP_MODE = { content: "content", files_with_matches: "files", files: "files", count: "count" };

export const ARG_ALIASES: Readonly<Record<string, ArgAliasTable>> = {
  Read: { ...FILE_PATH, page: "pages" },
  Write: { ...FILE_PATH, contents: "content", file_text: "content" },
  Edit: {
    ...FILE_PATH,
    old_str: "old_string",
    new_str: "new_string",
    oldString: "old_string",
    newString: "new_string",
    replaceAll: "replace_all",
  },
  Grep: {
    ...FILE_PATH,
    ...DIR_PATH,
    output_mode: { to: "mode", values: GREP_MODE },
    outputMode: { to: "mode", values: GREP_MODE },
    mode: { to: "mode", values: GREP_MODE },
    "-i": "ignoreCase",
    case_insensitive: "ignoreCase",
    "-C": "context",
    "-A": "after",
    "-B": "before",
    include: "glob",
    headLimit: "head_limit",
  },
  Glob: { ...DIR_PATH },
  Bash: { run_in_background: "background", runInBackground: "background", cmd: "command", timeout_ms: "timeout" },
  Skill: { skill: "name", skill_name: "name", arguments: "args" },
  // 子 agent 的类型名（research / coder / Explore / 自定义类型）由工具自己解析；tools 是改名前的参数名
  Agent: {
    description: "label",
    tools: "subagent_type",
    subagentType: "subagent_type",
    agent_type: "subagent_type",
    task: "prompt",
    message: "prompt",
    run_in_background: "background",
    runInBackground: "background",
    resume: "id",
    to: "id",
    agent_id: "id",
    agentId: "id",
  },
};

const NONE: ArgAliasTable = {};

/** 按工具名取别名表（没有登记的工具 = 空表）。 */
export const aliasesFor = (tool: string): ArgAliasTable => ARG_ALIASES[tool] ?? NONE;
