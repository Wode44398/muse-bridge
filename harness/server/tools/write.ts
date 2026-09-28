import fs from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail } from "./types.ts";
import { diagnose } from "./diagnostics.ts";
import { introducesRedactionMark, REDACTED_WRITE_HINT } from "../redact.ts";
import { writeUserFile } from "../atomic-write.ts";

export const writeTool: Tool = {
  effect: "write",
  concurrencySafe: false,
  def: {
    name: "Write",
    description:
      "Create a new file, or overwrite an existing file you have already Read in full (overwriting " +
      "an unread file is refused so content you never saw can't be lost). Parent directories " +
      "are created automatically. Prefer Edit for changing existing files. " +
      "The saved file gets a quick syntax check (JS/TS/JSON/Python); any syntax error is " +
      "reported in the result — fix it before moving on.",
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
    const seen = ctx.readFileState.get(abs);
    if (!seen) {
      return { veto: { summary: "not read", content: `${rel} already exists. Read it before overwriting it (or use Edit for a partial change).` } };
    }
    if (!seen.complete) {
      return {
        veto: {
          summary: "not fully read",
          content: `${rel} was only partially Read. Read the remaining lines (or use Edit for a focused change) before overwriting the whole file.`,
        },
      };
    }
    return null;
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const abs = ctx.sandbox.resolve(String(args.path), { forWrite: true });
    const content = String(args.content ?? "");

    // Overwrite gate — same contract as Edit: creating a new file is free, but
    // replacing an existing one requires having Read it, so the model can never
    // clobber content it has not seen. Also catches concurrent modification.
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
      if (!seen) {
        return fail(
          "not read",
          `${ctx.sandbox.rel(abs)} already exists. Read it before overwriting it (or use Edit for a partial change).`,
        );
      }
      if (!seen.complete) {
        return fail(
          "not fully read",
          `${ctx.sandbox.rel(abs)} was only partially Read. Read the remaining lines (or use Edit for a focused change) before overwriting the whole file.`,
        );
      }
      let current: string | null = null;
      try {
        current = await fs.readFile(abs, "utf8");
      } catch {
        // unreadable now — fall through, the write below will surface the error
      }
      if (current !== null && current !== seen.content) {
        const stat = await fs.stat(abs).catch(() => null);
        if (stat) ctx.readFileState.set(abs, { mtimeMs: stat.mtimeMs, content: current, readRanges: [], complete: false });
        return fail(
          "file changed",
          `${ctx.sandbox.rel(abs)} changed on disk since you Read it. Re-read it and try again.`,
        );
      }
      // S4：Read 给模型的是脱敏文本。整份写回时标记比原文多，就是在用标记覆盖真密钥。
      if (current !== null && introducesRedactionMark(current, content)) {
        return fail("redacted text", REDACTED_WRITE_HINT);
      }
    }

    try {
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await writeUserFile(abs, content); // U5：临时文件 + rename，写到一半出事原文件还在
      const stat = await fs.stat(abs);
      // Keep readFileState fresh so a following Edit passes its gate.
      const totalLines = content.split("\n").length;
      ctx.readFileState.set(abs, { mtimeMs: stat.mtimeMs, content, readRanges: [[1, totalLines]], complete: true });
    } catch (e) {
      return fail("write failed", `Could not write ${args.path}: ${(e as Error).message}`);
    }
    const lines = content.split("\n").length;
    const wrote = `Wrote ${ctx.sandbox.rel(abs)} (${content.length} bytes).`;
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
