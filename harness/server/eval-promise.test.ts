// V4（#56）：Eval 真正 await Promise。改写自探针 反馈甄别/笔记/probe-cdp-replmode.mjs。
//
// 修前：cdp.eval 用 {returnByValue, awaitPromise, replMode:true}，replMode 只 await 顶层的 `await x`；
// 表达式本身求值为 Promise（`(async()=>…)()`、`(()=>Promise.resolve(true))()`）时拿回的是 `{}`，
// 而工具描述写着「promises are awaited」——两次 MiMo 会话都踩到，`FAIL Eval …: {}` 还进了验证证据。
// 另：verify:true 却返回非布尔（写法问题）也被记成一次失败的检查。
//
// 真起本机 Chrome/Edge（Windows 以外或没装浏览器就跳过）。

import assert from "node:assert/strict";
import os from "node:os";
import test from "node:test";
import { getSharedBrowser } from "./cdp.ts";
import { findBrowser } from "./headless.ts";
import { evalTool } from "./tools/evaljs.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext } from "./tools/types.ts";

const skip = process.platform !== "win32" || !findBrowser() ? "需要 Windows + 本机 Chrome/Edge" : false;

const ctx: ToolContext = {
  sandbox: new Sandbox(os.tmpdir(), "workspace"),
  readFileState: new Map(),
  setTodos: () => {},
  limits: { bashTimeoutMs: 5_000, bashMaxTimeoutMs: 5_000 },
  agentSeesImages: false,
};

test("Eval 真的 await：返回 Promise 的表达式、顶层 await、对象、异常；verify 的三种结局", { skip, timeout: 120_000 }, async () => {
  const s = await getSharedBrowser();
  try {
    await s.navigate("data:text/html,<title>v4</title><p id=x>hi</p>", 200);
    // 修前这两条拿回的是 {}
    assert.equal(await s.eval("(() => Promise.resolve(true))()"), true);
    assert.equal(await s.eval("(async () => { await new Promise((r) => setTimeout(r, 50)); return 42; })()"), 42);
    // 原本就对的写法不能退化
    assert.equal(await s.eval("await Promise.resolve('top')"), "top");
    assert.deepEqual(await s.eval("({ a: 1, b: [2, 'x'] })"), { a: 1, b: [2, "x"] });
    assert.equal(await s.eval("document.querySelector('#x').textContent"), "hi");
    assert.equal(await s.eval("undefined"), undefined);
    await s.eval("let v4n = 1");
    await s.eval("let v4n = 2"); // replMode：跨调用重复声明 let 仍然可以
    assert.equal(await s.eval("v4n"), 2);
    await assert.rejects(s.eval("(() => { throw new Error('sync detail'); })()"), /sync detail/);
    await assert.rejects(s.eval("(async () => { throw new Error('async detail'); })()"), /async detail/);

    const pass = await evalTool.run({ js: "(async () => document.title === 'v4')()", verify: true }, ctx);
    assert.equal(pass.ok, true);
    assert.equal(pass.verification?.passed, true, "返回 Promise<true> 的断言算通过");

    const failed = await evalTool.run({ js: "document.title === 'nope'", verify: true }, ctx);
    assert.equal(failed.ok, false);
    assert.equal(failed.verification?.passed, false, "false 是一次真实的失败检查");

    const threw = await evalTool.run({ js: "(() => { throw new Error('title was ' + document.title); })()", verify: true }, ctx);
    assert.equal(threw.verification?.passed, false, "带细节 throw 也是一次失败检查");
    assert.match(threw.verification?.detail ?? "", /title was v4/);

    const malformed = await evalTool.run({ js: "({ ok: true })", verify: true }, ctx);
    assert.equal(malformed.ok, false);
    assert.equal(malformed.verification, undefined, "非布尔是写法问题，不记成证据");

    const syntax = await evalTool.run({ js: "(() => {", verify: true }, ctx);
    assert.equal(syntax.ok, false);
    assert.equal(syntax.verification, undefined, "语法错误也不记成证据");
  } finally {
    await s.close();
  }
});
