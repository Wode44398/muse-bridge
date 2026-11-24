// Grep 补能力（head_limit / offset 翻页、multiline、type、-A / -B）与 Glob 的截断提示。
// 修前：Grep 只有 200 条硬上限、截断了只说「narrow the pattern」，拿不到第 201 条；glob "*.ts" 只认工作区根上的文件；
// Glob 截在 500 条时只有界面第二行说了，模型看到的正文里没有。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { grepTool } from "./tools/grep.ts";
import { globTool } from "./tools/glob.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext, ToolRunResult } from "./tools/types.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
function workspace(files: Record<string, string>): { root: string; ctx: ToolContext } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-grep-page-"));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), body);
  }
  return { root, ctx: { sandbox: new Sandbox(root, "workspace"), readFileState: new Map(), signal: new AbortController().signal, limits: {} } as unknown as ToolContext };
}
const text = (r: ToolRunResult) => r.content.map((c) => (c.t === "text" ? c.text : "")).join("");

test("head_limit + offset 翻页：截断提示写明下一页的 offset，两页拼起来不重不漏", async () => {
  const lines = Array.from({ length: 25 }, (_, i) => `needle ${i}`).join("\n");
  const { ctx } = workspace({ "a.txt": lines });
  const p1 = await grepTool.run({ pattern: "needle", head_limit: 10 }, ctx);
  assert.match(text(p1), /stopped at 10 matches — more exist: pass offset: 10 for the next page/);
  assert.match(p1.summary, /\(truncated\)/);
  const p2 = await grepTool.run({ pattern: "needle", head_limit: 10, offset: 10 }, ctx);
  assert.match(text(p2), /offset: 20/);
  const p3 = await grepTool.run({ pattern: "needle", head_limit: 10, offset: 20 }, ctx);
  assert.doesNotMatch(text(p3), /stopped at/, "最后一页不再提示");
  const got = [p1, p2, p3].flatMap((r) => text(r).split("\n").filter((l) => /^a\.txt:\d+:/.test(l)));
  assert.equal(got.length, 25);
  assert.equal(new Set(got).size, 25);
  const files = await grepTool.run({ pattern: "x", mode: "files", head_limit: 1 }, workspace({ "a.txt": "x", "b.txt": "x" }).ctx);
  assert.match(text(files), /stopped at 1 files — more exist: pass offset: 1/);
  // 刚好满额、后面没有了：不说截断
  const exact = await grepTool.run({ pattern: "needle", head_limit: 25 }, ctx);
  assert.doesNotMatch(text(exact), /stopped at/);
});

test("multiline：模式能跨行，命中按起止行报；type 按语言过滤；before / after 非对称上下文", async () => {
  const { ctx } = workspace({
    "src/a.ts": "function foo(\n  x: number,\n) {\n  return x;\n}\n",
    "src/b.py": "def foo(x):\n    return x\n",
    "notes.md": "foo bar\n",
  });
  const ml = await grepTool.run({ pattern: "foo\\(.*?\\)", multiline: true, type: "ts" }, ctx);
  const t = text(ml);
  assert.match(t, /src\/a\.ts:1: function foo\(/);
  assert.match(t, /src\/a\.ts:3- \) \{/);
  assert.doesNotMatch(t, /b\.py/);
  const py = await grepTool.run({ pattern: "foo", type: "python", mode: "files" }, ctx);
  assert.equal(text(py).trim(), "src/b.py");
  const bad = await grepTool.run({ pattern: "foo", type: "klingon" }, ctx);
  assert.equal(bad.ok, false);
  assert.match(text(bad), /Known types: .*ts/);
  const ab = await grepTool.run({ pattern: "return", path: "src/a.ts", before: 0, after: 1 }, ctx);
  assert.deepEqual(text(ab).split("\n"), ["src/a.ts:4:   return x;", "src/a.ts:5- }"]);
});

test("glob 不带 / 按文件名比、任意深度都算（ripgrep 的写法）；带 / 的仍按路径比", async () => {
  const { ctx } = workspace({ "top.ts": "hit", "deep/x/y.ts": "hit", "deep/x/z.js": "hit" });
  const r = await grepTool.run({ pattern: "hit", glob: "*.ts", mode: "files" }, ctx);
  assert.deepEqual(text(r).split("\n").sort(), ["deep/x/y.ts", "top.ts"]);
  const scoped = await grepTool.run({ pattern: "hit", glob: "deep/**/*.js", mode: "files" }, ctx);
  assert.equal(text(scoped).trim(), "deep/x/z.js");
});

test("Glob：模式也按相对 path 比；截断时正文里说清只列了一部分", async () => {
  const files: Record<string, string> = { "src/a.ts": "", "src/sub/b.ts": "", "c.ts": "" };
  for (let i = 0; i < 505; i++) files[`many/f${i}.txt`] = "";
  const { ctx } = workspace(files);
  const scoped = await globTool.run({ pattern: "*.ts", path: "src" }, ctx);
  assert.equal(text(scoped).trim(), "src/a.ts");
  const deep = await globTool.run({ pattern: "**/*.ts", path: "src" }, ctx);
  assert.deepEqual(text(deep).split("\n").sort(), ["src/a.ts", "src/sub/b.ts"]);
  const many = await globTool.run({ pattern: "many/*.txt" }, ctx);
  assert.match(text(many), /stopped at 500 files — the list is incomplete/);
});

test("head_limit: 0 是「不限」（按上限给），不是只给 1 条", async () => {
  const lines = Array.from({ length: 25 }, (_, i) => `needle ${i}`).join("\n");
  const { ctx } = workspace({ "a.txt": lines });
  const r = await grepTool.run({ pattern: "needle", head_limit: 0 }, ctx);
  assert.equal(text(r).split("\n").filter((l) => /^a\.txt:\d+:/.test(l)).length, 25);
  assert.doesNotMatch(text(r), /stopped at/);
});
