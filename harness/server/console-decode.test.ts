// #97（规划外，U11 预览时照出来）：Windows 原生控制台程序往管道里写的是系统代码页（中文 Windows = GBK），Bash 工具一律按
// UTF-8 解，模型看到的中文全是乱码（ping、ipconfig、tasklist、PowerShell 5.1 的输出……）。
// 修后：Windows 上按行认——每行先严格按 UTF-8 解，不通再严格按 GBK 解；半行里合法 UTF-8 的前缀照旧实时交出去。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { consoleDecoder, decodeConsoleLine } from "./tools/console-decode.ts";
import { bashTool, shell } from "./tools/bash.ts";
import { Sandbox } from "./sandbox.ts";

const GBK_ZHONGWEN = [0xd6, 0xd0, 0xce, 0xc4]; // 「中文」的 GBK 编码
const UTF8_NIHAO = [...Buffer.from("你好", "utf8")];
const b = (...parts: Array<number[] | string>) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...Buffer.from(p, "utf8")] : p)));

test("#97 Windows：GBK 的行按 GBK 解，UTF-8 的行照旧；同一块里混着也各解各的", () => {
  const d = consoleDecoder("win32");
  assert.equal(d.write(b(GBK_ZHONGWEN, "\n")), "中文\n");
  assert.equal(d.write(b(UTF8_NIHAO, "\r\n", GBK_ZHONGWEN, " TTL=128\r\n")), "你好\r\n中文 TTL=128\r\n");
  assert.equal(d.end(), "");
  assert.equal(decodeConsoleLine(b(GBK_ZHONGWEN)), "中文");
  assert.equal(decodeConsoleLine(b("plain ascii")), "plain ascii");
});

test("#97 半行：合法 UTF-8 的前缀当场交出去（提示符照旧实时可见）；GBK 的半行等到换行；字符被切开也拼得回来", () => {
  const d = consoleDecoder("win32");
  assert.equal(d.write(b("Continue? [y/N] ")), "Continue? [y/N] ", "提示符不等换行");
  assert.equal(d.write(b([0xe4, 0xbd])), "", "UTF-8 字符只收到前两个字节：先扣着");
  assert.equal(d.write(b([0xa0], "\n")), "你\n");
  assert.equal(d.write(b("来自 ", [GBK_ZHONGWEN[0]])), "来自 ", "前缀是合法 UTF-8 就先交；GBK 的首字节扣着");
  assert.equal(d.write(b(GBK_ZHONGWEN.slice(1), "\n")), "中文\n");
  assert.equal(d.write(b(GBK_ZHONGWEN)), "", "整行没到换行、又不是 UTF-8：等换行");
  assert.equal(d.end(), "中文", "进程结束时把扣着的半行解掉");
});

test("#97 扣着的 GBK 半行攒过 4 KB 也解掉；二进制垃圾退回有损 UTF-8、不抛错", () => {
  const d = consoleDecoder("win32");
  const big: number[] = [];
  while (big.length < 5000) big.push(...GBK_ZHONGWEN);
  const out = d.write(new Uint8Array(big));
  assert.ok(out.startsWith("中文中文"), "攒过上限就解");
  assert.ok(!out.includes("�"));
  const junk = consoleDecoder("win32");
  assert.doesNotThrow(() => junk.write(new Uint8Array([0xff, 0xfe, 0x80, 0x0a])));
});

test("#97 非 Windows 平台行为不变（StringDecoder）", () => {
  const d = consoleDecoder("linux");
  assert.equal(d.write(b([0xe4, 0xbd])), "");
  assert.equal(d.write(b([0xa0], "\n")), "你\n");
  assert.match(d.write(b(GBK_ZHONGWEN, "\n")), /�/, "Linux 上不猜 GBK");
});

test("#97 端到端：Windows 上 Bash 里的程序吐 GBK，工具结果是正常的中文", { skip: process.platform !== "win32" || shell.kind !== "bash" }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "dimensio-97-"));
  try {
    const r = await bashTool.run(
      { command: "printf 'ok \\326\\320\\316\\304\\n'" },
      { sandbox: new Sandbox(root, "workspace"), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 10_000, bashMaxTimeoutMs: 10_000 }, agentSeesImages: false },
    );
    const text = r.content.map((c) => (c.t === "text" ? c.text : "")).join("");
    assert.equal(r.ok, true, text);
    assert.match(text, /ok 中文/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
