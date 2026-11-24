// Read 读 PDF 与 Jupyter notebook；Write 覆盖已有文件的先读门（档案 tools.readBeforeWrite）。
// 修前：PDF 碰到 NUL 就按二进制拒；.ipynb 原样吐 JSON；Write 覆盖必须把每一行都读过，档案关不掉。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import { editTool } from "./tools/edit.ts";
import { loadPdfJs, parsePages, pdfUnavailableText } from "./tools/read/pdf.ts";
import { Sandbox } from "./sandbox.ts";
import { defaultProfile, profileToolPolicy, resolveProfile } from "./agent/profile.ts";
import type { FileState, ToolContext, ToolRunResult } from "./tools/types.ts";

const roots: string[] = [];
after(() => {
  for (const root of roots) {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
function ws(): { root: string; ctx: ToolContext } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-read-docs-"));
  roots.push(root);
  return { root, ctx: { sandbox: new Sandbox(root, "workspace"), readFileState: new Map<string, FileState>(), limits: {} } as unknown as ToolContext };
}
const text = (r: ToolRunResult) => r.content.map((c) => (c.t === "text" ? c.text : "")).join("");

// 手写一个每页一行字的最小 PDF（带正确的 xref 偏移）
function makePdf(pages: string[]): Buffer {
  const objs: string[] = ["<< /Type /Catalog /Pages 2 0 R >>"];
  objs.push(`<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`);
  const font = 3 + pages.length * 2;
  pages.forEach((t, i) => {
    const stream = `BT /F1 24 Tf 72 720 Td (${t}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  let out = "%PDF-1.4\n%\u0000\u00ff\n"; // 注释行里带一个 NUL：修前就是被它判成二进制的
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

test("PDF：按页抽文本，pages 选页，超过一次的页数给下一页的写法", async (t) => {
  if (!(await loadPdfJs())) return t.skip("这台机器上没有 pdfjs-dist");
  const { root, ctx } = ws();
  const pages = Array.from({ length: 23 }, (_, i) => `Page text number ${i + 1}`);
  fs.writeFileSync(path.join(root, "doc.pdf"), makePdf(pages));
  const all = await readTool.run({ path: "doc.pdf" }, ctx);
  assert.equal(all.ok, true, text(all));
  assert.match(text(all), /doc\.pdf: PDF, 23 pages/);
  assert.match(text(all), /--- page 1 ---\nPage text number 1/);
  assert.match(text(all), /--- page 20 ---/);
  assert.doesNotMatch(text(all), /--- page 21 ---/);
  assert.match(text(all), /Read more with pages: "21-23"/);
  const some = await readTool.run({ path: "doc.pdf", pages: "2,22-23" }, ctx);
  assert.match(text(some), /--- page 2 ---\nPage text number 2\n\n--- page 22 ---/);
  assert.doesNotMatch(text(some), /page 3 ---/);
  const bad = await readTool.run({ path: "doc.pdf", pages: "abc" }, ctx);
  assert.equal(bad.ok, false);
  assert.deepEqual(parsePages("1-3,5", 10), [1, 2, 3, 5]);
  assert.deepEqual(parsePages("8-", 10), [8, 9, 10]);
  assert.equal(parsePages("0", 10), null);
});

test("notebook：按单元格渲染代码、markdown 与文本输出；富输出只留占位；offset / limit 按单元格算", async () => {
  const { root, ctx } = ws();
  const nb = {
    metadata: { kernelspec: { language: "python" } },
    cells: [
      { cell_type: "markdown", source: ["# Title\n", "Some notes"] },
      {
        cell_type: "code",
        execution_count: 3,
        source: "print('hi')\n1 + 1",
        outputs: [
          { output_type: "stream", name: "stdout", text: ["hi\n"] },
          { output_type: "execute_result", data: { "text/plain": ["2"] } },
          { output_type: "display_data", data: { "image/png": "iVBOR..." } },
        ],
      },
      { cell_type: "code", execution_count: 4, source: "1/0", outputs: [{ output_type: "error", ename: "ZeroDivisionError", evalue: "division by zero", traceback: ["\u001b[31mTraceback\u001b[0m"] }] },
    ],
  };
  fs.writeFileSync(path.join(root, "a.ipynb"), JSON.stringify(nb));
  const r = await readTool.run({ path: "a.ipynb" }, ctx);
  const out = text(r);
  assert.match(out, /a\.ipynb: Jupyter notebook, 3 cells, python/);
  assert.match(out, /### cell 1 · markdown\n# Title\nSome notes/);
  assert.match(out, /### cell 2 · code · In \[3\]\nprint\('hi'\)\n1 \+ 1\n--- output ---\nhi\n2\n\[image\/png output not shown\]/);
  assert.match(out, /ZeroDivisionError: division by zero\nTraceback/);
  assert.doesNotMatch(out, /\u001b/);
  const one = await readTool.run({ path: "a.ipynb", offset: 2, limit: 1 }, ctx);
  assert.match(text(one), /### cell 2/);
  assert.doesNotMatch(text(one), /### cell 3/);
  assert.match(text(one), /1 more cells \(use offset=3\)/);
  assert.ok(ctx.readFileState.get(path.join(root, "a.ipynb")), "读过就记一笔（Write 的 any 档据此放行覆盖）");
});

test("readBeforeWrite：默认 any——读过任意一段就能覆盖；full 要读全；off 不要求；读过之后磁盘被改了三档都拦", async () => {
  assert.equal(defaultProfile().tools.readBeforeWrite, "any");
  assert.equal(resolveProfile("anthropic", "claude-opus-4-7").tools.readBeforeWrite, "any");
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const policy = (mode: "full" | "any" | "off") => ({ ...profileToolPolicy(defaultProfile()), readBeforeWrite: mode });

  for (const mode of ["any", "full", "off"] as const) {
    const { root, ctx } = ws();
    ctx.toolPolicy = policy(mode);
    const file = path.join(root, "f.txt");
    fs.writeFileSync(file, lines);
    const unread = await writeTool.run({ path: "f.txt", content: "new" }, ctx);
    assert.equal(unread.ok, mode === "off", `${mode}：没读过`);
    fs.writeFileSync(file, lines);
    await readTool.run({ path: "f.txt", limit: 5 }, ctx);
    const partial = await writeTool.run({ path: "f.txt", content: "new" }, ctx);
    assert.equal(partial.ok, mode !== "full", `${mode}：只读了一段`);
    if (mode === "full") assert.match(text(partial), /only partially Read/);
    // 读过之后被别人改了
    fs.writeFileSync(file, lines);
    await readTool.run({ path: "f.txt" }, ctx);
    fs.writeFileSync(file, `${lines}\nsomeone else`);
    const changed = await writeTool.run({ path: "f.txt", content: "new" }, ctx);
    assert.equal(changed.ok, false, `${mode}：磁盘上被改了`);
    assert.match(text(changed), /changed on disk since you Read it/);
  }
  // 没挂策略（直接调 run 的）按最严的 full
  const { root, ctx } = ws();
  fs.writeFileSync(path.join(root, "g.txt"), lines);
  await readTool.run({ path: "g.txt", limit: 5 }, ctx);
  assert.equal((await writeTool.run({ path: "g.txt", content: "x" }, ctx)).ok, false);
  // 档案开关的取值也挡写错的
  process.env.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify({ "*": { tools: { readBeforeWrite: "some" } } });
  try {
    assert.throws(() => resolveProfile("anthropic", "claude-opus-4-7"), /readBeforeWrite/);
  } finally {
    delete process.env.DIMENSIO_PROFILE_OVERRIDES;
  }
});

test("readBeforeWrite=any：被「磁盘被改过」拦下后原样重发仍拦；Edit 叠在外部改动上之后整份 Write 也拦；重读之后放行", async () => {
  const { root, ctx } = ws();
  ctx.toolPolicy = { ...profileToolPolicy(defaultProfile()), readBeforeWrite: "any" };
  const file = path.join(root, "a.txt");
  fs.writeFileSync(file, "one\ntwo\n");
  await readTool.run({ path: "a.txt", limit: 1 }, ctx);
  fs.appendFileSync(file, "IMPORTANT unseen by model\n");
  const first = await writeTool.run({ path: "a.txt", content: "clobber\n" }, ctx);
  assert.equal(first.ok, false);
  const again = await writeTool.run({ path: "a.txt", content: "clobber\n" }, ctx);
  assert.equal(again.ok, false, "原样重发不能盖掉没看过的内容");
  assert.match(text(again), /changed on disk since you Read it/);
  assert.match(fs.readFileSync(file, "utf8"), /IMPORTANT unseen/);
  // 重读之后放行
  await readTool.run({ path: "a.txt", limit: 1 }, ctx);
  assert.equal((await writeTool.run({ path: "a.txt", content: "clobber\n" }, ctx)).ok, true);

  // Edit：读过，外部改了，Edit 仍命中照改——之后整份 Write 要先重读
  fs.writeFileSync(file, "alpha\nbeta\n");
  await readTool.run({ path: "a.txt" }, ctx);
  fs.appendFileSync(file, "external line\n");
  const edited = await editTool.run({ path: "a.txt", old_string: "alpha", new_string: "ALPHA" }, ctx);
  assert.equal(edited.ok, true, text(edited));
  const over = await writeTool.run({ path: "a.txt", content: "whole\n" }, ctx);
  assert.equal(over.ok, false, "Edit 刷新的视图不算模型看过");
  assert.match(fs.readFileSync(file, "utf8"), /external line/);
});

test("notebook：一次渲染全部单元格算读全，full 档能整份覆盖；只读了一部分照旧不行", async () => {
  const { root, ctx } = ws();
  ctx.toolPolicy = { ...profileToolPolicy(defaultProfile()), readBeforeWrite: "full" };
  const nb = { metadata: {}, cells: [{ cell_type: "code", source: "a = 1" }, { cell_type: "code", source: "b = 2" }] };
  fs.writeFileSync(path.join(root, "n.ipynb"), JSON.stringify(nb, null, 1));
  await readTool.run({ path: "n.ipynb", limit: 1 }, ctx);
  assert.equal((await writeTool.run({ path: "n.ipynb", content: "{}" }, ctx)).ok, false, "只读了第 1 个单元格");
  await readTool.run({ path: "n.ipynb" }, ctx);
  const w = await writeTool.run({ path: "n.ipynb", content: JSON.stringify({ ...nb, cells: [] }) }, ctx);
  assert.equal(w.ok, true, text(w));
  // 读全之后再按单元格翻一页，不把「读全」降回去
  fs.writeFileSync(path.join(root, "n.ipynb"), JSON.stringify(nb, null, 1));
  await readTool.run({ path: "n.ipynb" }, ctx);
  await readTool.run({ path: "n.ipynb", offset: 2, limit: 1 }, ctx);
  assert.equal(ctx.readFileState.get(path.join(root, "n.ipynb"))?.complete, true);
});

test("PDF：找不到 pdfjs-dist 时如实说缺的是什么；有命令行才建议走命令行（没有命令行的成员实例不提 Bash）", () => {
  const withShell = pdfUnavailableText("doc.pdf", true);
  assert.match(withShell, /pdfjs-dist package it uses is not installed/);
  assert.match(withShell, /pdftotext doc\.pdf -/);
  const noShell = pdfUnavailableText("doc.pdf", false);
  assert.match(noShell, /pdfjs-dist/);
  assert.doesNotMatch(noShell, /Bash|pdftotext/);
});
