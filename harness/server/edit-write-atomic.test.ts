// U5（ZCode C7、MiMo 反馈）：Edit / Write 原子写 + 剥离 Read 的行号前缀；Read 图片回报像素尺寸。
//
// 修前：
// - Edit / Write 用 fs.writeFile 原地写：先截断再写，写到一半断电、磁盘满、进程被杀，文件只剩半截。
// - 模型从 Read 的输出里抄 old_string 时常连行号前缀（"     12\t"）一起抄，永远对不上，要多花一轮重抄。
// - Read 一张图只回 mime 和字节数；视觉侧会缩放、补边，一张 900×110 的拼条曾被「看成」一张不相干的方图。
// 修后：临时文件 + rename（硬链接、符号链接、Windows 文件名大小写照旧）；整段带前缀且编号连续才剥；结果里写明宽×高。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { imageDimensions } from "./image-assets.ts";
import { Sandbox } from "./sandbox.ts";
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-u5-"));
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
const ino = (p: string) => fs.statSync(p, { bigint: true }).ino;

test("U5 Edit / Write 原子写：换的是整个文件（临时文件 + rename）、不留临时文件；硬链接、符号链接、文件名大小写照旧", async () => {
  const { root, ctx } = workspace();
  const a = path.join(root, "a.ts");
  fs.writeFileSync(a, "export const a = 1;\n");
  assert.equal((await readTool.run({ path: "a.ts" }, ctx)).ok, true);
  const before = ino(a);
  const edited = await editTool.run({ path: "a.ts", old_string: "a = 1", new_string: "a = 2" }, ctx);
  assert.equal(edited.ok, true, text(edited));
  assert.equal(fs.readFileSync(a, "utf8"), "export const a = 2;\n");
  assert.notEqual(ino(a), before, "Edit 写的是一个新文件再换上去，不是在原文件上截断重写");
  const mid = ino(a);
  const written = await writeTool.run({ path: "a.ts", content: "export const a = 3;\n" }, ctx);
  assert.equal(written.ok, true, text(written));
  assert.equal(fs.readFileSync(a, "utf8"), "export const a = 3;\n");
  assert.notEqual(ino(a), mid, "Write 同样是临时文件 + rename");
  assert.deepEqual(fs.readdirSync(root), ["a.ts"], "目录里不留临时文件");

  // 硬链接：rename 会把这个名字从链接组里拆出去——这种文件原地写，另一个名字照样看得到改动
  const twin = path.join(root, "twin.ts");
  fs.linkSync(a, twin);
  assert.equal((await readTool.run({ path: "a.ts" }, ctx)).ok, true);
  assert.equal((await editTool.run({ path: "a.ts", old_string: "a = 3", new_string: "a = 4" }, ctx)).ok, true);
  assert.equal(fs.readFileSync(twin, "utf8"), "export const a = 4;\n", "硬链接的另一个名字也看到改动");

  // 符号链接：写到它指向的真文件，链接本身还是链接（Windows 没开开发者模式建不了链接就跳过这一段）
  const real = path.join(root, "real.ts");
  const link = path.join(root, "link.ts");
  fs.writeFileSync(real, "export const r = 1;\n");
  let linked = true;
  try {
    fs.symlinkSync(real, link, "file");
  } catch {
    linked = false;
  }
  if (linked) {
    assert.equal((await readTool.run({ path: "link.ts" }, ctx)).ok, true);
    assert.equal((await editTool.run({ path: "link.ts", old_string: "r = 1", new_string: "r = 2" }, ctx)).ok, true);
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true, "链接还是链接");
    assert.equal(fs.readFileSync(real, "utf8"), "export const r = 2;\n");
  }

  // Windows：模型用小写名写一个大写名的文件，磁盘上的名字不能被悄悄改成小写
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(root, "README.md"), "# hi\n");
    assert.equal((await readTool.run({ path: "readme.md" }, ctx)).ok, true);
    assert.equal((await writeTool.run({ path: "readme.md", content: "# hello\n" }, ctx)).ok, true);
    assert.ok(fs.readdirSync(root).includes("README.md"), `文件名大小写不变：${fs.readdirSync(root).join(", ")}`);
    assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), "# hello\n");
  }
});

test("U5 Edit 剥离 Read 的行号前缀：整段带前缀且编号连续才剥，new_string 一并剥；只带一部分的报错不猜；真数据不误剥", async () => {
  const { root, ctx } = workspace();
  const file = path.join(root, "c.ts");
  fs.writeFileSync(file, "function f() {\n  const x = 1;\n  return x;\n}\n");
  const read = await readTool.run({ path: "c.ts" }, ctx);
  const shown = text(read).split("\n");
  const copied = `${shown[1]}\n${shown[2]}`; // Read 原样打印的第 2、3 行：「     2\t  const x = 1;」
  assert.equal(copied, "     2\t  const x = 1;\n     3\t  return x;");

  const r1 = await editTool.run({ path: "c.ts", old_string: copied, new_string: "     2\t  const x = 2;\n     3\t  return x;" }, ctx);
  assert.equal(r1.ok, true, text(r1));
  assert.equal(fs.readFileSync(file, "utf8"), "function f() {\n  const x = 2;\n  return x;\n}\n", "前缀一个都不能进文件");
  assert.match(text(r1), /line-number prefixes/);

  // 前缀的空格被抄丢了、new_string 是干净的
  const r2 = await editTool.run({ path: "c.ts", old_string: "2\t  const x = 2;\n3\t  return x;", new_string: "  const x = 3;\n  return x;" }, ctx);
  assert.equal(r2.ok, true, text(r2));
  assert.match(fs.readFileSync(file, "utf8"), /const x = 3;/);

  // 另一家常见的「→」写法；只有一行时必须是 Read 的排版
  const r3 = await editTool.run({ path: "c.ts", old_string: "     2→  const x = 3;", new_string: "  const x = 4;" }, ctx);
  assert.equal(r3.ok, true, text(r3));
  assert.match(fs.readFileSync(file, "utf8"), /const x = 4;/);

  // new_string 只有部分行带前缀：不猜，报错，文件不动
  const before = fs.readFileSync(file, "utf8");
  const r4 = await editTool.run({ path: "c.ts", old_string: "     2\t  const x = 4;\n     3\t  return x;", new_string: "     2\t  const x = 5;\n  const y = 6;\n     3\t  return x;" }, ctx);
  assert.equal(r4.ok, false);
  assert.match(text(r4), /only some lines/);
  assert.equal(fs.readFileSync(file, "utf8"), before);

  // 编号不连续、单行又不是 Read 的排版：都不剥，照常报找不到
  assert.equal((await editTool.run({ path: "c.ts", old_string: "     2\t  const x = 4;\n     4\t  return x;", new_string: "x" }, ctx)).ok, false);
  assert.equal((await editTool.run({ path: "c.ts", old_string: "2\t  const x = 4;", new_string: "  const x = 9;" }, ctx)).ok, false);
  assert.equal(fs.readFileSync(file, "utf8"), before);

  // 文件里本来就是「数字<tab>内容」的数据：原样对得上就原样换，不剥
  const tsv = path.join(root, "rows.tsv");
  fs.writeFileSync(tsv, "1\tfoo\n2\tbar\n");
  assert.equal((await readTool.run({ path: "rows.tsv" }, ctx)).ok, true);
  const r5 = await editTool.run({ path: "rows.tsv", old_string: "1\tfoo", new_string: "1\tbaz" }, ctx);
  assert.equal(r5.ok, true, text(r5));
  assert.equal(fs.readFileSync(tsv, "utf8"), "1\tbaz\n2\tbar\n");
  assert.doesNotMatch(text(r5), /line-number prefixes/);
});

// 只有文件头的图：够 sniff 与读尺寸
function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "latin1");
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
function webp(chunk: string, body: number[]): Buffer {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "latin1");
  b.write("WEBP", 8, "latin1");
  b.write(chunk, 12, "latin1");
  Buffer.from(body).copy(b, 20);
  return b;
}

test("U5 Read 图片回报像素尺寸：PNG / JPEG / WebP 的文件头；极端比例点明；超过 2000px 说明会被缩小", async () => {
  assert.deepEqual(imageDimensions(pngHeader(900, 110)), { width: 900, height: 110 });
  // JPEG：SOI、APP0（长度 16）、SOF0：高 480、宽 640
  const jpeg = Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 0x01, 0x22, 0x00,
  ]);
  assert.deepEqual(imageDimensions(jpeg), { width: 640, height: 480 });
  // 有损 VP8：320×200；无损 VP8L：400×300；扩展 VP8X：1000×2000
  assert.deepEqual(imageDimensions(webp("VP8 ", [0, 0, 0, 0x9d, 0x01, 0x2a, 0x40, 0x01, 0xc8, 0x00])), { width: 320, height: 200 });
  assert.deepEqual(imageDimensions(webp("VP8L", [0x2f, 0x8f, 0xc1, 0x4a, 0x00])), { width: 400, height: 300 });
  assert.deepEqual(imageDimensions(webp("VP8X", [0, 0, 0, 0, 0xe7, 0x03, 0x00, 0xcf, 0x07, 0x00])), { width: 1000, height: 2000 });
  assert.equal(imageDimensions(Buffer.from("not an image")), null);

  const { root, ctx } = workspace();
  fs.writeFileSync(path.join(root, "strip.png"), pngHeader(900, 110));
  const strip = await readTool.run({ path: "strip.png" }, ctx);
  assert.equal(strip.ok, true);
  assert.match(text(strip), /900×110 px/);
  assert.match(text(strip), /Extreme aspect ratio \(8\.2:1\)/);

  fs.writeFileSync(path.join(root, "wide.png"), pngHeader(3000, 1000));
  const wide = await readTool.run({ path: "wide.png" }, ctx);
  assert.match(text(wide), /3000×1000 px/);
  assert.match(text(wide), /downscaled to at most 2000 px/);
  assert.doesNotMatch(text(wide), /Extreme aspect ratio/);
  const full = await readTool.run({ path: "wide.png", fullRes: true }, ctx);
  assert.doesNotMatch(text(full), /downscaled/, "要了原图就不说会缩小");
});
