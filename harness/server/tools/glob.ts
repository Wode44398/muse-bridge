import fs from "node:fs/promises";
import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail } from "./types.ts";
import { walk, globToRegExp } from "./walk.ts";
import { readVerdict } from "../sandbox.ts";

const MAX_RESULTS = 500;

export const globTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: {
    name: "Glob",
    description:
      "Find files by glob pattern (supports **, *, ?, {a,b}). Returns paths relative to the " +
      "sandbox, most-recently-modified first.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: 'Glob, e.g. "**/*.ts" or "src/*.{js,ts}".' },
        path: { type: "string", description: "Base directory to search from (default: sandbox root)." },
      },
      required: ["pattern"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const base = args.path ? ctx.sandbox.resolve(String(args.path)) : ctx.sandbox.root;
    const re = globToRegExp(String(args.pattern));
    // U5（#57）：path 不存在或不是目录时明说，别静默回「No files matched.」。
    const baseStat = await fs.stat(base).catch(() => null);
    if (!baseStat) return fail("no such path", `Glob path does not exist: ${args.path}`);
    if (!baseStat.isDirectory()) {
      return fail("not a directory", `Glob path is a file, not a directory: ${args.path} — pass its folder as path, or Read the file directly.`);
    }

    const hits: { rel: string; mtimeMs: number }[] = [];
    // S4（#37①）：递归遍历逐个过统一的凭据判定——以前 walk 不经 secret guard，
    // Read 拦得住的 .env、deploy/.ssh/id_rsa，一次 Grep 就原文吐出来。
    const skip = (abs: string) => readVerdict(abs, ctx.sandbox.root) !== null;
    for await (const { abs } of walk(base, { skip })) {
      if (ctx.signal?.aborted) break;
      const rel = ctx.sandbox.rel(abs);
      if (!re.test(rel)) continue;
      let mtimeMs = 0;
      try {
        mtimeMs = (await fs.stat(abs)).mtimeMs;
      } catch {
        /* ignore */
      }
      hits.push({ rel, mtimeMs });
      if (hits.length >= MAX_RESULTS) break;
    }

    hits.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const body = hits.length ? hits.map((h) => h.rel).join("\n") : "No files matched.";
    return {
      ok: true,
      summary: `glob ${args.pattern} → ${hits.length} files`,
      outcome: hits.length ? `找到 ${hits.length} 个文件${hits.length >= MAX_RESULTS ? "（只列了前这些）" : ""}` : "没有匹配的文件", // U8（K36）
      content: [{ t: "text", text: body }],
    };
  },
};
