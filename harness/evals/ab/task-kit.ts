// 评测题的公用零件：摆现场（写文件）、判分（读文件、跑工作区测试、取最终答复、数会话记录里的工具调用）。
// tasks.ts（老题）与 tasks-hard.ts（模型档案 P0 的难题）共用这一份。判分一律看磁盘状态与会话记录（确定性），
// 不按中英措辞猜模型「说了什么」——要看答复的题，答复本身就是格式受约束的产物（例如严格 JSON）。
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PersistedSession } from "../../server/store.ts";

export const write = (dir: string, rel: string, text: string | Buffer, encoding: BufferEncoding = "utf8") => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (typeof text === "string") fs.writeFileSync(abs, text, encoding);
  else fs.writeFileSync(abs, text);
};

export const read = (dir: string, rel: string): string | null => {
  try {
    return fs.readFileSync(path.join(dir, rel), "utf8");
  } catch {
    return null;
  }
};

export const exists = (dir: string, rel: string) => fs.existsSync(path.join(dir, rel));

export const sha = (text: string | Buffer | null) => (text === null ? "-" : createHash("sha256").update(text).digest("hex").slice(0, 16));

// 读 JSON（容忍 PowerShell 5 写的 UTF-8 BOM）；读不出 / 解析不了是 undefined
export function readJson(dir: string, rel: string): unknown {
  const text = read(dir, rel);
  if (text === null) return undefined;
  try {
    return JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    return undefined;
  }
}

// 在工作区里跑全部 node:test，作为「真的好了没有」的独立判据（不信模型自己说的）。
export function nodeTests(dir: string): { ok: boolean; tests: number; failed: number } {
  // 本进程若自己就跑在 node --test 里（自检），子进程会继承 NODE_TEST_CONTEXT、改用二进制协议汇报而不打印摘要行——去掉它。
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ["--test"], { cwd: dir, encoding: "utf8", timeout: 60_000, env });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const fail = /^ℹ fail (\d+)/m.exec(out);
  const tests = /^ℹ tests (\d+)/m.exec(out);
  return { ok: r.status === 0 && Number(tests?.[1] ?? 0) > 0, tests: Number(tests?.[1] ?? 0), failed: Number(fail?.[1] ?? 0) };
}

// 在工作区里跑一段 ES 模块脚本（判分探针），返回 stdout 去首尾空白；env 覆盖子进程环境变量（值为 undefined 即删掉）
export function probe(dir: string, code: string, env: Record<string, string | undefined> = {}): string {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete childEnv[k];
    else childEnv[k] = v;
  }
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: dir, encoding: "utf8", timeout: 20_000, env: childEnv });
  return (r.stdout ?? "").trim();
}

// 最终答复（最后一条有正文的 assistant 消息）
export function finalAnswer(rec: PersistedSession): string {
  for (let i = rec.messages.length - 1; i >= 0; i--) {
    const m = rec.messages[i];
    if (m.role !== "assistant") continue;
    const text = m.content.flatMap((b) => (b.t === "text" ? [b.text] : [])).join("");
    if (text.trim()) return text;
  }
  return "";
}

export function filesUnder(dir: string, skip = /^\.dimensio$/): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (skip.test(e.name)) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else out.push(r);
    }
  };
  if (fs.existsSync(dir)) walk("");
  return out.sort();
}

export interface CallRecord {
  name: string;
  args: Record<string, unknown>;
  ok: boolean | null; // null = 没有结果（被中断）
}

// 会话记录里的全部工具调用（按出现顺序），带上各自的成败
export function toolCalls(rec: PersistedSession): CallRecord[] {
  const okById = new Map<string, boolean>();
  for (const m of rec.messages) for (const b of m.content) if (b.t === "tool_result") okById.set(b.id, Boolean(b.ok));
  const out: CallRecord[] = [];
  for (const m of rec.messages) {
    if (m.role !== "assistant") continue;
    for (const b of m.content) {
      if (b.t !== "tool_call") continue;
      out.push({ name: b.name, args: (b.args ?? {}) as Record<string, unknown>, ok: okById.has(b.id) ? okById.get(b.id)! : null });
    }
  }
  return out;
}

// 调用参数里的路径（Edit / Write / Read 用 path；兼容别家习惯的 file_path）统一成正斜杠
export const callPath = (c: CallRecord): string => String(c.args.path ?? c.args.file_path ?? "").replace(/\\/g, "/");
export const callCommand = (c: CallRecord): string => String(c.args.command ?? "");

// 一条命令（或一段脚本正文）是否写了 target 指的文件——只认写入型的特征，只读核对（cat / grep / node -e 读一下、
// python -c 打印几行、cp 它去别处备份）不算。三类：
//   ① 重定向的目标是它（> / >> / 2> / *>；=> -> 这类箭头不算）；
//   ② 整条命令里有原地改 / 写文件的 API（sed -i、perl -i、writeFile、open(…, "w")、write_text、WriteAllText……），命令里也点了它的名
//     （脚本里常先把路径赋给变量再写，所以不要求两者挨着）；
//   ③ 按 | ; & 换行切开的某一段里，PowerShell 写文件命令（Set-Content / Out-File / Add-Content）、tee 与它同段，
//     或 cp / mv / Copy-Item / Move-Item 的目标（最后一个参数或 -Destination）是它。
const SCRIPT_WRITER =
  /\bsed\b[^|;&\n]*\s(?:-[a-zA-Z]*i\b|--in-place)|\bperl\b[^|;&\n]*\s-[a-zA-Z]*i|\b(?:writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream)\b|\.write_(?:text|bytes)\(|\bopen\([^)]*,\s*(?:mode\s*=\s*)?["'](?:[wax]|r\+)[bt+]*["']|WriteAll(?:Text|Lines|Bytes)|AppendAll(?:Text|Lines)/i;
const SEGMENT_WRITER = /\b(?:Set-Content|Out-File|Add-Content|tee)\b/i;
const MOVER = /^(?:cp|mv|copy|move|xcopy|robocopy|Copy-Item|Move-Item|cpi|mi)$/i;
export function commandWrites(command: string, target: RegExp): boolean {
  const name = new RegExp(target.source, "i");
  if (!name.test(command)) return false;
  if (new RegExp(String.raw`(?<![=\-])>{1,2}\s*["']?[^\s"'|;&<>]*(?:${target.source})(?![\w.])`, "i").test(command)) return true;
  if (SCRIPT_WRITER.test(command)) return true;
  for (const seg of command.split(/[|;&\n]+/)) {
    if (!name.test(seg)) continue;
    if (SEGMENT_WRITER.test(seg)) return true;
    const words = seg.trim().split(/\s+/).map((w) => w.replace(/^["']|["']$/g, ""));
    if (!MOVER.test(words[0] ?? "")) continue;
    const dest = new RegExp(String.raw`-Dest(?:ination)?\s+["']?([^\s"']+)`, "i").exec(seg)?.[1] ?? words.at(-1) ?? "";
    if (new RegExp(`(?:${target.source})$`, "i").test(dest)) return true;
  }
  return false;
}

// 确定性伪随机（mulberry32）：现场数据每次一样，参考解与判分算得出同一个答案
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pkgJson = JSON.stringify({ name: "ab-task", type: "module", scripts: { test: "node --test" } }, null, 2);
