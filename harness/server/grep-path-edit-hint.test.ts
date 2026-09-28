// U5（#57、#58）。#57 改写自探针 反馈甄别/笔记/probe-grep-file-path.ts。
//
// 修前：① Grep 的 path 指向单个文件时静默回「No matches.」（对文件调 readdir 拿不到条目，跟文件名是不是
// 中文无关——MiMo 却据此存了一条「Grep 不支持中文文件名」的 verified 记忆）；path 不存在时同样回空；
// ② Edit 失败时缩进差 2 个空格也显示「similarity 100%」，再配「请逐字比较」，自相矛盾。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { grepTool } from "./tools/grep.ts";
import { globTool } from "./tools/glob.ts";
import { editTool } from "./tools/edit.ts";
import { readTool } from "./tools/read.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext } from "./tools/types.ts";

const ws = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-u5-"));
after(() => fs.rmSync(ws, { recursive: true, force: true }));
fs.writeFileSync(path.join(ws, "ascii.html"), "const BUILDERS = 1;\n");
fs.writeFileSync(path.join(ws, "AMD投研演示.html"), "const BUILDERS = 2;\n");

const ctx: ToolContext = {
  sandbox: new Sandbox(ws, "workspace"),
  readFileState: new Map(),
  setTodos: () => {},
  limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
  agentSeesImages: false,
};
const text = (r: { content: { t: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

test("#57 Grep 的 path 指向单个文件就搜这个文件；不存在的 path 明说，不回空", async () => {
  for (const p of ["ascii.html", "AMD投研演示.html", path.join(ws, "AMD投研演示.html")]) {
    const r = await grepTool.run({ pattern: "BUILDERS", path: p }, ctx);
    assert.equal(r.ok, true, p);
    assert.match(text(r), /BUILDERS = [12]/, `${p}: 必须命中`);
  }
  const root = await grepTool.run({ pattern: "BUILDERS" }, ctx);
  assert.match(text(root), /ascii\.html:1/);
  const missing = await grepTool.run({ pattern: "BUILDERS", path: "no-such.html" }, ctx);
  assert.equal(missing.ok, false);
  assert.match(text(missing), /does not exist/);
});

test("#57 Glob 的 path 不存在或是个文件：明说", async () => {
  const missing = await globTool.run({ pattern: "*.html", path: "nope" }, ctx);
  assert.equal(missing.ok, false);
  assert.match(text(missing), /does not exist/);
  const file = await globTool.run({ pattern: "*.html", path: "ascii.html" }, ctx);
  assert.equal(file.ok, false);
  assert.match(text(file), /is a file, not a directory/);
});

test("#58 Edit 只有缩进不同时：明说是哪一行、差几个字符，不说 similarity 100%", async () => {
  fs.writeFileSync(path.join(ws, "nest.ts"), "function f() {\n  if (x) {\n          return 1;\n  }\n}\n");
  assert.equal((await readTool.run({ path: "nest.ts" }, ctx)).ok, true);
  // 跨行的 old_string（MiMo 当时就是这样）：第二行少缩进了 2 个空格，整段对不上。
  const r = await editTool.run(
    { path: "nest.ts", old_string: "  if (x) {\n        return 1;\n  }", new_string: "  if (x) {\n        return 2;\n  }" },
    ctx,
  );
  assert.equal(r.ok, false);
  const msg = text(r);
  assert.match(msg, /Only whitespace differs/);
  assert.match(msg, /file line 3 is indented with .*\(10 chars\), your old_string line 2 with .*\(8 chars\)/);
  assert.doesNotMatch(msg, /similarity 100%/);
});
