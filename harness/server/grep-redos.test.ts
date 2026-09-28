// S9（#24）：一次 Grep 冻住整个 harness。改写自探针 03-hermes-agent/笔记/probe-grep-redos.ts。
// 修前：`(a+)+$` 对一行 26 个 a 冻住事件循环约 3.6 秒（每多一个字符翻倍），期间所有会话、SSE、
// 探活停摆。修后：V8 线性回退接手，毫秒级返回，事件循环不停顿。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { grepTool } from "./tools/grep.ts";
import { Sandbox } from "./sandbox.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-s9-redos-"));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

async function timedGrep(pattern: string, line: string): Promise<{ elapsed: number; maxGap: number; ok: boolean; text: string }> {
  fs.writeFileSync(path.join(dir, "victim.txt"), line + "\n");
  const ctx = { sandbox: new Sandbox(dir, "workspace"), readFileState: new Map(), signal: new AbortController().signal, limits: {} };
  let last = Date.now();
  let maxGap = 0;
  const hb = setInterval(() => {
    const now = Date.now();
    maxGap = Math.max(maxGap, now - last);
    last = now;
  }, 20);
  await new Promise((r) => setTimeout(r, 30)); // 心跳先跑起来
  const t0 = Date.now();
  const res = await grepTool.run({ pattern, path: "." }, ctx as never);
  const elapsed = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 60));
  clearInterval(hb);
  return { elapsed, maxGap, ok: res.ok, text: res.content.map((c) => ("text" in c ? c.text : "")).join("") };
}

test("嵌套量词的灾难性正则不再冻住事件循环（线性回退）", async () => {
  for (const pattern of ["(a+)+$", "(a|aa)+$", "(\\w+\\s?)+$"]) {
    const r = await timedGrep(pattern, "a".repeat(26) + "!");
    assert.ok(r.ok, pattern);
    assert.ok(r.elapsed < 1_000, `${pattern}: Grep 花了 ${r.elapsed}ms`);
    assert.ok(r.maxGap < 500, `${pattern}: 事件循环被冻住 ${r.maxGap}ms`);
  }
});

// #70：线性引擎不接反向引用与前瞻，这两种写法仍是指数级（28 个 a 约 13 秒，每多一个字符翻倍）。以前它们在主线程
// 上同步跑，整个 harness 冻住；现在匹配在 worker 线程里，一批超时就把线程整个结束掉，明说原因。
test("#70 反向引用 / 前瞻这类线性引擎接不住的写法：限时掐断并明说原因，主线程全程不卡", { timeout: 60_000 }, async () => {
  const saved = process.env.DIMENSIO_GREP_TIMEOUT_MS;
  process.env.DIMENSIO_GREP_TIMEOUT_MS = "1000";
  try {
    for (const pattern of ["(a+)+\\1$", "(?=(a+)+$)"]) {
      const r = await timedGrep(pattern, "a".repeat(28) + "!");
      assert.equal(r.ok, false, pattern);
      assert.match(r.text, /longer than 1s/, pattern);
      assert.ok(r.elapsed < 5_000, `${pattern}: 花了 ${r.elapsed}ms 才收手`);
      assert.ok(r.maxGap < 500, `${pattern}: 事件循环被冻住 ${r.maxGap}ms`);
    }
  } finally {
    if (saved === undefined) delete process.env.DIMENSIO_GREP_TIMEOUT_MS;
    else process.env.DIMENSIO_GREP_TIMEOUT_MS = saved;
  }
});

test("#70 分批交给 worker 后输出格式不变：跨批的上下文分隔、files / count 模式、截断上限", async () => {
  const many = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-70-many-"));
  try {
    for (let i = 0; i < 40; i++) {
      fs.writeFileSync(path.join(many, `f${String(i).padStart(2, "0")}.txt`), `head\nneedle ${i}\ntail\n`);
    }
    const ctx = { sandbox: new Sandbox(many, "workspace"), readFileState: new Map(), signal: new AbortController().signal, limits: {} };
    const text = (r: { content: { t: string }[] }) => r.content.map((c) => ("text" in c ? (c as { text: string }).text : "")).join("");

    const withContext = await grepTool.run({ pattern: "needle", path: ".", context: 1 }, ctx as never);
    const lines = text(withContext).split("\n");
    assert.notEqual(lines[0], "--", "第一段前面不加分隔");
    assert.equal(lines.filter((l) => l === "--").length, 39, "40 个文件、40 段，段与段之间 39 个分隔（跨批也不多不少）");
    assert.ok(lines.some((l) => /^f00\.txt:1- head$/.test(l)) && lines.some((l) => /^f39\.txt:2: needle 39$/.test(l)));
    assert.match(withContext.summary, /40 matches in 40 files/);

    const files = await grepTool.run({ pattern: "needle", path: ".", mode: "files" }, ctx as never);
    assert.equal(text(files).split("\n").length, 40);
    const count = await grepTool.run({ pattern: "needle", path: ".", mode: "count" }, ctx as never);
    assert.ok(text(count).split("\n").every((l) => /: 1$/.test(l)));

    for (let i = 0; i < 250; i++) fs.appendFileSync(path.join(many, "f00.txt"), "needle again\n");
    const capped = await grepTool.run({ pattern: "needle", path: "." }, ctx as never);
    assert.match(capped.summary, /\(truncated\)/);
    assert.match(text(capped), /stopped at 200 matches/);
  } finally {
    fs.rmSync(many, { recursive: true, force: true });
  }
});

test("普通正则的结果不受影响", async () => {
  fs.writeFileSync(path.join(dir, "code.ts"), "const alpha = 1;\nconst beta = 2;\n// alpha again\n");
  const ctx = { sandbox: new Sandbox(dir, "workspace"), readFileState: new Map(), signal: new AbortController().signal, limits: {} };
  const res = await grepTool.run({ pattern: "alpha\\b", path: ".", glob: "*.ts" }, ctx as never);
  assert.ok(res.ok);
  const text = res.content.map((c) => ("text" in c ? c.text : "")).join("");
  assert.match(text, /code\.ts:1: const alpha = 1;/);
  assert.match(text, /code\.ts:3: \/\/ alpha again/);
  assert.doesNotMatch(text, /beta/);
});
