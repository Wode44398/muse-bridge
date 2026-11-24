import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail } from "./types.ts";
import { diagnose } from "./diagnostics.ts";
import { introducesRedactionMark, REDACTED_WRITE_HINT } from "../redact.ts";
import { writeUserFile } from "../atomic-write.ts";
import { afterMemoryWrite, beforeMemoryWrite, memoryWriteGate } from "../memory-files.ts";
import { matchFileStyle } from "./line-endings.ts";
import { ARG_ALIASES } from "./arg-aliases.ts";
import type { FileState } from "./types.ts";

// 覆盖已有文件之前要读到什么程度（档案 tools.readBeforeWrite）；没挂策略（直接调 run 的）按最严的 full
const readMode = (ctx: Pick<ToolContext, "toolPolicy">): "full" | "any" | "off" => ctx.toolPolicy?.readBeforeWrite ?? "full";

// 覆盖闸：不读文件就判得出的那部分（prepare 与 run 共用同一套说法）。「读过之后文件又变了」要读内容才判得出，在 run() 里。
function overwriteVeto(rel: string, seen: FileState | undefined, mode: "full" | "any" | "off"): { summary: string; content: string } | null {
  if (mode === "off") return null;
  if (!seen) return { summary: "not read", content: `${rel} already exists. Read it before overwriting it (or use Edit for a partial change).` };
  if (mode === "full" && !seen.complete) {
    return {
      summary: "not fully read",
      content: `${rel} was only partially Read. Read the remaining lines (or use Edit for a focused change) before overwriting the whole file.`,
    };
  }
  // 外部改过、视图是工具刷新的（上一次 Write 被拦、Edit 叠在外部改动上）：模型没看过那部分，any 档也得先重读
  // （full 档下这种视图一律记成没读全，上面已经拦了）
  if (seen.stale) return { summary: "file changed", content: `${rel} changed on disk since you Read it. Re-read it and try again.` };
  return null;
}

export const writeTool: Tool = {
  effect: "write",
  concurrencySafe: false,
  aliases: ARG_ALIASES.Write,
  def: {
    name: "Write",
    description:
      "Create a file, or overwrite an existing one you have Read (overwriting a file you never read, or one that changed " +
      "on disk since your Read, is refused). Parent directories are created. The saved file gets a quick syntax check " +
      "(JS/TS/JSON/Python) reported in the result.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write." },
        content: { type: "string", description: "Full file content." },
      },
      required: ["path", "content"],
    },
  },
  // P11（kimi K20）：注定会被覆盖闸拦下的（目标是目录、覆盖没 Read 过 / 没读全的已有文件）在弹卡之前回给模型——
  // 以前写控制面文件时先弹一张卡，批了才被拦。说法与 run() 一字不差；「Read 之后文件又变了」要读内容才判得出，仍在 run() 里。
  async prepare(args, ctx) {
    let abs: string;
    try {
      abs = ctx.sandbox.resolve(String(args.path), { forWrite: true });
    } catch {
      return null; // 路径不对由 run() 照常报
    }
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat) return null; // 新建文件：没有前置条件
    const rel = ctx.sandbox.rel(abs);
    if (stat.isDirectory()) return { veto: { summary: "not a file", content: `${rel} is a directory.` } };
    const veto = overwriteVeto(rel, ctx.readFileState.get(abs), readMode(ctx));
    return veto ? { veto } : null;
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const abs = ctx.sandbox.resolve(String(args.path), { forWrite: true });
    let content = String(args.content ?? "");
    let styleNotes: string[] = [];

    // Overwrite gate: creating a new file is free; replacing an existing one requires having Read it (how much is the
    // profile's readBeforeWrite), so the model never clobbers content it has not seen. Concurrent modification since
    // that Read is refused in every mode.
    let exists = false;
    try {
      const stat = await fs.stat(abs);
      if (stat.isDirectory()) {
        return fail("not a file", `${ctx.sandbox.rel(abs)} is a directory.`);
      }
      exists = true;
    } catch {
      // no such file — plain create
    }
    if (exists) {
      const seen = ctx.readFileState.get(abs);
      const veto = overwriteVeto(ctx.sandbox.rel(abs), seen, readMode(ctx));
      if (veto) return fail(veto.summary, veto.content);
      let current: string | null = null;
      try {
        current = await fs.readFile(abs, "utf8");
      } catch {
        // unreadable now — fall through, the write below will surface the error
      }
      if (current !== null && seen && current !== seen.content) {
        const stat = await fs.stat(abs).catch(() => null);
        if (stat) ctx.readFileState.set(abs, { mtimeMs: stat.mtimeMs, content: current, readRanges: [], complete: false, stale: true });
        return fail(
          "file changed",
          `${ctx.sandbox.rel(abs)} changed on disk since you Read it. Re-read it and try again.`,
        );
      }
      // S4：Read 给模型的是脱敏文本。整份写回时标记比原文多，就是在用标记覆盖真密钥。
      if (current !== null && introducesRedactionMark(current, content)) {
        return fail("redacted text", REDACTED_WRITE_HINT);
      }
      if (current !== null) ({ text: content, notes: styleNotes } = matchFileStyle(current, content));
    }
    // 记忆目录里的笔记：子 agent 不写、用户驳回的不改、不许自称被驳回
    const memoryBlock = memoryWriteGate(abs, ctx, content);
    if (memoryBlock) return fail("memory note", memoryBlock);

    try {
      await ctx.beforeFileWrite?.(abs).catch(() => {}); // 大工作区：改之前先备份这个文件（检查点只存改过的文件）
      beforeMemoryWrite(abs, ctx.sandbox.root); // 记忆目录里的笔记：旧版先进 .history
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await writeUserFile(abs, content); // U5：临时文件 + rename，写到一半出事原文件还在
      const stat = await fs.stat(abs);
      // Keep readFileState fresh so a following Edit passes its gate.
      const totalLines = content.split("\n").length;
      ctx.readFileState.set(abs, { mtimeMs: stat.mtimeMs, content, readRanges: [[1, totalLines]], complete: true });
    } catch (e) {
      return fail("write failed", `Could not write ${args.path}: ${(e as Error).message}`);
    }
    // 记忆目录里的笔记：记下来源、重新生成 MEMORY.md，下一轮开跑时索引按新内容更新
    if (afterMemoryWrite(abs, ctx.sandbox.root, { session: ctx.ownerId, external: ctx.externalContent?.() === true })) ctx.noteMemoryChanged?.();
    const lines = content.split("\n").length;
    const wrote = `Wrote ${ctx.sandbox.rel(abs)} (${content.length} bytes${styleNotes.length ? `; ${styleNotes.join(", ")} of the existing file` : ""}).`;
    const diag = await diagnose(abs, content);
    return {
      ok: true,
      summary: `wrote ${ctx.sandbox.rel(abs)} (${lines} lines, ${content.length} bytes)${diag ? " ⚠ syntax" : ""}`,
      outcome: `${exists ? "覆盖" : "新建"} · ${lines} 行${diag ? " · 语法检查没过" : ""}`, // U8（K36）
      ...(!exists ? { createdFiles: [ctx.sandbox.rel(abs)] } : {}),
      content: [
        {
          t: "text",
          text: diag
            ? `${wrote}\n\n⚠ Syntax check fails on the saved file — fix this before moving on:\n${diag}`
            : wrote,
        },
      ],
    };
  },
};
