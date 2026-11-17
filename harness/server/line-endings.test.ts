// Write 覆盖已有文件、Edit 改混合换行的文件时保住原文件的换行与 BOM（tools/line-endings.ts）。
// 修前：Write 照模型给的 LF 原样写回，CRLF 的脚本、带 BOM 的文件被悄悄改了格式；Edit 遇到混合换行的文件整份改成 CRLF。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { Sandbox } from "./sandbox.ts";
import { eolOf, matchFileStyle, rawIndex, spliceMixed } from "./tools/line-endings.ts";
import { editTool } from "./tools/edit.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import type { ToolContext } from "./tools/types.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
function workspace(): { root: string; ctx: ToolContext } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-eol-"));
  roots.push(root);
  const ctx: ToolContext = {
    sandbox: new Sandbox(root, "workspace"),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 5_000, bashMaxTimeoutMs: 5_000 },
    agentSeesImages: true,
  };
  return { root, ctx };
}
const text = (r: { content: Array<{ t: string; text?: string }> }) => r.content.map((b) => b.text ?? "").join("\n");

test("纯函数：风格判断、覆盖时换回原风格、混合文件只拼命中段", () => {
  assert.equal(eolOf("a\r\nb\r\n"), "crlf");
  assert.equal(eolOf("a\nb"), "lf");
  assert.equal(eolOf("a\r\nb\n"), "mixed");
  assert.equal(eolOf("ab"), "none");
  assert.deepEqual(matchFileStyle("a\r\nb\r\n", "x\ny\n"), { text: "x\r\ny\r\n", notes: ["kept CRLF line endings"] });
  assert.deepEqual(matchFileStyle("a\nb\n", "x\r\ny\r\n"), { text: "x\ny\n", notes: ["kept LF line endings"] });
  assert.deepEqual(matchFileStyle("﻿a\r\n", "x\n"), { text: "﻿x\r\n", notes: ["kept CRLF line endings", "kept the UTF-8 BOM"] });
  assert.deepEqual(matchFileStyle("a\r\nb\n", "x\ny\n"), { text: "x\ny\n", notes: [] }, "混合的原文件不猜");
  assert.deepEqual(matchFileStyle("a\r\nb\r\n", "x\r\ny\n"), { text: "x\r\ny\n", notes: [] }, "新内容自己是混合的不动");
  assert.deepEqual(matchFileStyle("one line", "x\ny\n"), { text: "x\ny\n", notes: [] }, "原文件没有换行，没有风格可跟");
  const raw = "a\r\nb\nc\r\nd";
  assert.equal(rawIndex(raw, 2), 3); // LF 视图 "a\nb\nc\nd" 的 b
  assert.equal(spliceMixed(raw, 2, 3, "B\nC"), "a\r\nB\nC\r\nd", "被替换段 b\\nc 里是 LF，新文字跟它走");
  assert.equal(spliceMixed(raw, 4, 3, "C\nD"), "a\r\nb\nC\r\nD", "被替换段 c\\r\\nd 是 CRLF");
});

test("Write 覆盖：CRLF 文件保持 CRLF、带 BOM 的保留 BOM，并在结果里说明；新建文件照模型给的写", async () => {
  const { root, ctx } = workspace();
  const bat = path.join(root, "启动.bat");
  fs.writeFileSync(bat, "@echo off\r\necho 1\r\n");
  assert.equal((await readTool.run({ path: "启动.bat" }, ctx)).ok, true);
  const r = await writeTool.run({ path: "启动.bat", content: "@echo off\necho 2\n" }, ctx);
  assert.equal(r.ok, true, text(r));
  assert.equal(fs.readFileSync(bat, "utf8"), "@echo off\r\necho 2\r\n");
  assert.match(text(r), /kept CRLF line endings of the existing file/);

  const ps1 = path.join(root, "a.ps1");
  fs.writeFileSync(ps1, "﻿Write-Host 1\r\n");
  assert.equal((await readTool.run({ path: "a.ps1" }, ctx)).ok, true);
  const r2 = await writeTool.run({ path: "a.ps1", content: "Write-Host 2\n" }, ctx);
  assert.equal(r2.ok, true, text(r2));
  assert.equal(fs.readFileSync(ps1, "utf8"), "﻿Write-Host 2\r\n");

  // 写完之后紧跟一次 Edit：先读后改的记录要是磁盘上的真实内容，否则会被当成「文件被别人改了」
  const e = await editTool.run({ path: "a.ps1", old_string: "Write-Host 2", new_string: "Write-Host 3" }, ctx);
  assert.equal(e.ok, true, text(e));
  assert.equal(fs.readFileSync(ps1, "utf8"), "﻿Write-Host 3\r\n");
  assert.doesNotMatch(text(e), /changed on disk/);

  const r3 = await writeTool.run({ path: "new.txt", content: "x\ny\n" }, ctx);
  assert.equal(r3.ok, true, text(r3));
  assert.equal(fs.readFileSync(path.join(root, "new.txt"), "utf8"), "x\ny\n");
  assert.doesNotMatch(text(r3), /kept/);
});

test("Edit：混合换行的文件只改命中的那一段，其余行的换行不动；统一 CRLF 的文件照旧", async () => {
  const { root, ctx } = workspace();
  const f = path.join(root, "app.ini");
  fs.writeFileSync(f, "[a]\r\nx=1\r\n[b]\ny=2\n");
  assert.equal((await readTool.run({ path: "app.ini" }, ctx)).ok, true);
  const r = await editTool.run({ path: "app.ini", old_string: "y=2", new_string: "y=3\nz=4" }, ctx);
  assert.equal(r.ok, true, text(r));
  assert.equal(fs.readFileSync(f, "utf8"), "[a]\r\nx=1\r\n[b]\ny=3\nz=4\n");
  const r2 = await editTool.run({ path: "app.ini", old_string: "[a]\nx=1", new_string: "[a]\nx=9" }, ctx);
  assert.equal(r2.ok, true, text(r2));
  assert.equal(fs.readFileSync(f, "utf8"), "[a]\r\nx=9\r\n[b]\ny=3\nz=4\n");

  const g = path.join(root, "crlf.txt");
  fs.writeFileSync(g, "a\r\nb\r\n");
  assert.equal((await readTool.run({ path: "crlf.txt" }, ctx)).ok, true);
  const r3 = await editTool.run({ path: "crlf.txt", old_string: "b", new_string: "b\nc" }, ctx);
  assert.equal(r3.ok, true, text(r3));
  assert.equal(fs.readFileSync(g, "utf8"), "a\r\nb\r\nc\r\n");
});
