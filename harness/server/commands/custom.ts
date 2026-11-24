// 自定义斜杠命令（Claude Code 同格式）：<目录>/commands/**/*.md，目录见 agent-dirs.ts（项目级 .dimensio、.claude，用户级
// ~/.dimensio、~/.claude；成员实例没有用户级）。文件名（去掉 .md）就是命令名；子目录只用来归类，也可以写成 /子目录:名字。
// 同名时 项目级 > 用户级，同一级里 .dimensio 先于 .claude。
//
// 展开规则：frontmatter 的 description / argument-hint 进 / 面板；allowed-tools 与 model 解析出来随命令带着（dimensio 不按它们
// 放权、也不为一条命令换型号——见展开文字里的说明）；正文里的 $ARGUMENTS 换成全部参数、$1 $2… 换成按空白切开的各段
// （引号括起来的算一段）；`@路径` 引用的文件读出来附在后面——固定按 workspace 档判（只认工作区里的、过凭据判定），不跟会话的
// 整机 / bypass 档走：命令文件可能来自克隆下来的陌生仓库，不能借它把工作区外的文件带进上下文。`!命令` 不执行：那等于让文件
// 内容直接在本机跑命令。命令文件本身按真实落点判（extensions/confine.ts），链出工作区的当不存在。
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { configDirs, type ConfigScope } from "../agent-dirs.ts";
import { confinedConfigFile } from "../extensions/confine.ts";
import { Sandbox } from "../sandbox.ts";
import { frontmatterList, frontmatterText, frontmatterValue, oneLine, splitFrontmatter } from "../extensions/frontmatter.ts";

export interface CustomCommand {
  name: string; // 调用名
  namespace?: string; // 子目录（frontend/review.md → "frontend"；多层用 : 连）
  scope: ConfigScope;
  file: string;
  confineBase: string; // 读命令文件时真实落点要落在的根（项目级 = 工作区，用户级 = 那个用户目录）
  description: string;
  argumentHint?: string;
  allowedTools?: string[];
  model?: string;
}

const MAX_DEPTH = 4;
const MAX_PER_DIR = 300;
export const COMMAND_BODY_MAX = 40_000;
const ARGS_MAX = 4_000;
const FILE_REF_MAX = 10; // 一条命令最多附几个 @文件
const FILE_REF_CHARS = 20_000; // 每个附的文件最多多少字
const FILE_REF_BYTES = 512 * 1024; // 比这大的文件不附（多半不是文本）

function walk(root: string, rel: string[], depth: number, out: { file: string; ns: string[] }[]): void {
  if (depth > MAX_DEPTH || out.length >= MAX_PER_DIR) return;
  let entries;
  try {
    entries = readdirSync(path.join(root, ...rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_PER_DIR) return;
    if (e.name.startsWith(".")) continue;
    if (e.isDirectory()) walk(root, [...rel, e.name], depth + 1, out);
    else if (e.isFile() && /\.md$/i.test(e.name)) out.push({ file: path.join(root, ...rel, e.name), ns: rel });
  }
}

function parseCommand(file: string, ns: string[], scope: ConfigScope, confineBase: string): CustomCommand | null {
  if (!confinedConfigFile(file, scope, confineBase)) return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const { head, body } = splitFrontmatter(text);
  const name = path.basename(file).replace(/\.md$/i, "");
  if (!/^[^\s/]+$/.test(name)) return null;
  const description = oneLine(frontmatterText(head, "description") || body.split(/\r?\n/).find((l) => l.trim()) || "", 200).replace(/^#+\s*/, "");
  const hint = oneLine(frontmatterValue(head, "argument-hint"), 80);
  const tools = frontmatterList(head, "allowed-tools");
  const model = oneLine(frontmatterValue(head, "model"), 80);
  return {
    name,
    ...(ns.length ? { namespace: ns.join(":") } : {}),
    scope,
    file,
    confineBase,
    description,
    ...(hint ? { argumentHint: hint } : {}),
    ...(tools.length ? { allowedTools: tools } : {}),
    ...(model ? { model } : {}),
  };
}

// 这个工作区此刻的全部命令（优先级排好、按调用名去重；有子目录的另可按 子目录:名字 找到）
export function customCommands(workspace?: string): CustomCommand[] {
  const out: CustomCommand[] = [];
  const seen = new Set<string>();
  for (const { scope, dir } of configDirs(workspace)) {
    const files: { file: string; ns: string[] }[] = [];
    walk(path.join(dir, "commands"), [], 0, files);
    const base = scope === "project" ? path.dirname(dir) : dir;
    for (const { file, ns } of files) {
      const cmd = parseCommand(file, ns, scope, base);
      if (!cmd) continue;
      const key = (cmd.namespace ? `${cmd.namespace}:${cmd.name}` : cmd.name).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(cmd);
    }
  }
  return out;
}

export function findCommand(name: string, workspace?: string): CustomCommand | null {
  const want = name.trim().replace(/^\//, "").toLowerCase();
  if (!want) return null;
  const all = customCommands(workspace);
  return (
    all.find((c) => c.name.toLowerCase() === want) ??
    all.find((c) => c.namespace && `${c.namespace}:${c.name}`.toLowerCase() === want) ??
    null
  );
}

// 参数按空白切段，引号（单 / 双）括起来的算一段
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of args.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

const clipTo = (s: string, max: number, what: string) => (s.length <= max ? s : `${s.slice(0, max)}\n[…${what} truncated at ${max} characters]`);

// @路径：行首或空白 / 括号后面的 @，路径里不含空白与引号；结尾的标点不算路径
const FILE_REF_RE = /(^|[\s(])@([^\s"'`()<>]+)/g;

function attachFiles(body: string, workspace: string | undefined): string {
  if (!workspace) return "";
  const reader = new Sandbox(workspace, "workspace");
  const parts: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(FILE_REF_RE)) {
    if (parts.length >= FILE_REF_MAX) break;
    const ref = m[2].replace(/[.,;:!?]+$/, "");
    if (!ref || seen.has(ref)) continue;
    seen.add(ref);
    try {
      const abs = reader.resolve(ref);
      const st = statSync(abs);
      if (!st.isFile() || st.size > FILE_REF_BYTES) continue;
      const text = readFileSync(abs, "utf8");
      if (text.includes("\u0000")) continue;
      parts.push(`<file path="${reader.rel(abs)}">\n${clipTo(text, FILE_REF_CHARS, "file")}\n</file>`);
    } catch {
      /* 不存在、不许读：原样留着 @路径 */
    }
  }
  return parts.length ? `\n\n[Files referenced with @ in the command]\n${parts.join("\n\n")}` : "";
}

export const commandHeader = (name: string) => `[Command: /${name}]`;

// 展开成跟在用户消息后面的那条 harness 消息的全文；读不到命令文件返回 null。workspace = 会话的工作区（@路径 相对它、只认它里面的）
export function expandCommand(cmd: CustomCommand, rawArgs: string, invoked: string, workspace?: string): string | null {
  // 列清单之后链接可能被换过：读之前按真实落点再判一次
  if (!confinedConfigFile(cmd.file, cmd.scope, cmd.confineBase)) return null;
  let text: string;
  try {
    text = readFileSync(cmd.file, "utf8");
  } catch {
    return null;
  }
  let body = splitFrontmatter(text).body;
  const truncated = body.length > COMMAND_BODY_MAX;
  if (truncated) body = body.slice(0, COMMAND_BODY_MAX);
  const args = rawArgs.trim().slice(0, ARGS_MAX);
  const positional = splitArgs(args);
  // 一次替换完（参数里的 $1、$ARGUMENTS 原样保留，不被再替换）
  const expanded = body.replace(/\$ARGUMENTS\b|\$(\d+)/g, (m, n: string | undefined) => (n === undefined ? args : (positional[Number(n) - 1] ?? "")));
  const notes: string[] = [];
  if (cmd.allowedTools?.length) notes.push(`The command lists these tools for its work: ${cmd.allowedTools.join(", ")}. Normal permissions still apply.`);
  if (/!`[^`]+`/.test(expanded)) notes.push("Lines written as !`command` are not run automatically here; if their output matters, run them yourself with Bash.");
  const where = cmd.scope === "project" ? "this project" : "the user's own commands";
  return (
    `${commandHeader(cmd.name)}\n` +
    `The user ran the custom command /${invoked} (from ${where}: ${cmd.file}). Its instructions follow — carry them out for the request in their message above.` +
    (notes.length ? `\n${notes.join("\n")}` : "") +
    `\n\n${expanded}` +
    (truncated ? `\n\n[The command file is longer than this — the rest is in ${cmd.file}]` : "") +
    attachFiles(expanded, workspace)
  );
}
