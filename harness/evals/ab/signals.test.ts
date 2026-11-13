// 模型档案阶段 1：适配信号、换行检测与转录回放的自检（不测模型、不起服务）。单跑：
//   cd harness && node --import ./server/test-setup.ts --test evals/ab/signals.test.ts
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { snapshotStyles, styleFlips, styleOf } from "./eol.ts";
import { addSignals, badArgKind, contractKind, recordSignals } from "./signals.ts";
import { byFamily, collect, report } from "./transcripts.ts";

type B = Record<string, unknown>;
const call = (id: string, name: string, args: B): B => ({ t: "tool_call", id, name, args });
const result = (id: string, ok: boolean, text: string): B => ({ t: "tool_result", id, ok, content: [{ t: "text", text }] });
const asst = (...content: B[]) => ({ role: "assistant", content });
const user = (...content: B[]) => ({ role: "user", content });
const text = (s: string): B => ({ t: "text", text: s });

const SAMPLE = {
  messages: [
    user(text("改一下 a.js")),
    asst(call("1", "Edit", { path: "a.js", old_string: "x", new_string: "y" })),
    user(result("1", false, "You must Read a.js before editing it.")),
    asst(call("2", "Edit", { path: "a.js", old_string: "x", new_string: "y" })), // 失败后原样重发
    user(result("2", false, "You must Read a.js before editing it.")),
    asst(call("3", "Read", { file_path: "a.js" })), // 别名参数
    user(result("3", false, "Invalid arguments for Read: $.path is required")),
    asst(call("4", "Bash", { command: "npm test || true", verify: true })),
    user(result("4", false, "verify:true needs an exit status that belongs to the check, but `||` turns a failing check into exit 0.")),
    asst(call("5", "Bash", { command: "sleep 30" })),
    user(result("5", true, "")),
    asst({ t: "thinking", text: "想一想" }), // 仅思考
    asst(), // 空回合
    asst(text('<tool_call>{"name":"Read","arguments":{"path":"a.js"}}</tool_call>')), // 正文里写工具调用
    asst(call("6", "Frobnicate", {})),
    user(result("6", false, 'Unknown tool "Frobnicate". Available tools: Read, Edit.')),
    asst(call("7", "Write", { path: "b.json", content: "{" })),
    user(result("7", false, "[old tool output elided to save context — re-run the tool if you need it]")),
    asst(text("好了")),
  ],
};

test("适配信号：一份记录里的各类信号都数对", () => {
  const s = recordSignals(SAMPLE as never);
  assert.equal(s.assistantTurns, 11);
  assert.equal(s.toolCalls, 7);
  assert.equal(s.toolFailed, 6);
  assert.equal(s.editCalls, 3);
  assert.equal(s.editFailed, 3);
  assert.equal(s.errors["read-gate"], 2);
  assert.equal(s.errors["unknown-tool"], 1);
  assert.equal(s.errors.elided, 1);
  assert.deepEqual(s.unknownTools, { Frobnicate: 1 });
  assert.deepEqual(s.badArgs, { "alias-param": 1 }); // 缺 path 而带着 file_path：算别名，不算缺参
  assert.deepEqual(s.aliasParams, { file_path: 1 });
  assert.deepEqual(s.contract, { "verify-status": 1 }); // 契约类不进 badArgs
  assert.equal(s.failThenSame, 1);
  assert.equal(s.identicalRepeats, 1);
  assert.equal(s.maxIdenticalStreak, 2);
  assert.equal(s.waitPolls, 1);
  assert.equal(s.waitSeconds, 30);
  assert.equal(s.thinkingOnlyTurns, 1);
  assert.equal(s.emptyTurns, 1);
  assert.equal(s.textToolCalls, 1);
  assert.ok(s.samples.every((x) => x.cat !== "elided"), "压缩掉的结果不留样例");
});

test("适配信号：细分规则与相加", () => {
  assert.equal(badArgKind("The arguments for Edit were not valid JSON (Unexpected end)"), "json-invalid");
  assert.equal(badArgKind("$.count expected number, got string"), "wrong-type");
  assert.equal(badArgKind("$.foo is not an allowed property"), "extra-prop");
  assert.equal(contractKind("Could not save memory: verified memory needs verifiedAt"), "memory-contract");
  assert.equal(contractKind("config/x.reg is binary (NUL byte at offset 3, 324 bytes) — Read only returns text."), "binary-read");
  assert.equal(contractKind("old_string not found in a.js"), null);
  // 有工具调用的回合里解释 <tool_call> 不算；sleep 后面跟别的命令也算纯等待的开头
  const s = recordSignals({ messages: [asst(text("格式是 <tool_call>…"), call("1", "Bash", { command: "sleep 2m && ls" })), user(result("1", true, "ok"))] } as never);
  assert.equal(s.textToolCalls, 0);
  assert.equal(s.waitSeconds, 120);
  const sum = addSignals(addSignals(null, recordSignals(SAMPLE as never)), s);
  assert.equal(sum.toolCalls, 8);
  assert.equal(sum.waitPolls, 2);
  assert.equal(sum.errors["read-gate"], 2);
  assert.equal(recordSignals(SAMPLE as never).toolCalls, 7, "相加不改入参");
});

test("换行检测：风格与 BOM 变了才记，新建 / 无换行 / 二进制不算", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-eol-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const w = (f: string, data: string | Buffer) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), data);
  };
  w("a.txt", "1\r\n2\r\n");
  w("b.txt", "1\n2\n");
  w("c.ps1", "﻿Write-Host 1\r\n");
  w("one-line.txt", "no newline");
  w("bin.dat", Buffer.from([1, 0, 2, 10]));
  w("node_modules/x/y.js", "1\r\n");
  assert.deepEqual(styleOf(Buffer.from("a\r\nb\n")), { eol: "mixed", bom: false });
  assert.equal(styleOf(Buffer.from([1, 0, 2])), null);
  const before = snapshotStyles(dir);
  assert.deepEqual([...before.keys()].sort(), ["a.txt", "b.txt", "c.ps1", "one-line.txt"]);
  assert.deepEqual(styleFlips(dir, before), []);
  w("a.txt", "1\n2\n3\n"); // crlf → lf
  w("c.ps1", "Write-Host 1\r\n"); // 丢了 BOM
  w("one-line.txt", "now\r\nwith newline\r\n"); // 原来没有换行：不算
  w("new.txt", "x\r\n"); // 新建：不算
  fs.rmSync(path.join(dir, "b.txt")); // 删掉：不算
  assert.deepEqual(styleFlips(dir, before), ["a.txt(crlf→lf)", "c.ps1(bom+crlf→crlf)"]);
});

test("转录回放：按来源 × 家族 × 型号汇总，缓存命中只算记了读数的会话", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mp-replay-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const put = (arm: string, id: string, rec: unknown) => {
    const d = path.join(dir, "arms", arm, "sessions");
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, `${id}.json`), typeof rec === "string" ? rec : JSON.stringify(rec));
  };
  put("a", "s1", { ...SAMPLE, config: { provider: "openai", model: "deepseek-flash" }, totals: { inputTokens: 1000, outputTokens: 10, cacheReadTokens: 900 } });
  put("a", "s2", { ...SAMPLE, config: { provider: "openai", model: "deepseek-flash" }, totals: { inputTokens: 5000, outputTokens: 10 } }); // 老记录：没有缓存读数
  put("b", "s3", { ...SAMPLE, config: { provider: "kimi", model: "k3.1-pro" }, totals: { inputTokens: 100, outputTokens: 1, cacheReadTokens: 50 } });
  put("b", "bad", "{not json");
  put("b", "status", { retiring: false });
  const { groups, skipped } = collect([{ label: "测试", dir: path.join(dir, "arms", "*", "sessions") }]);
  assert.equal(skipped, 2);
  assert.deepEqual(groups.map((g) => [g.family, g.model, g.sessions]), [["deepseek", "deepseek-flash", 2], ["kimi", "k3.1-pro", 1]]);
  assert.deepEqual(groups[0].tokens, { input: 6000, output: 20, cacheRead: 900, cacheBase: 1000 });
  assert.equal(groups[0].s.toolCalls, 14);
  const fam = byFamily(groups);
  assert.equal(fam.length, 2);
  const md = report(groups, skipped);
  assert.match(md, /\| deepseek \| 2 \| 22 \| 14 \|/);
  assert.match(md, /90% \|/); // 900 / 1000，不是 900 / 6000
  assert.ok(!md.includes("改一下 a.js"), "报告里不含会话正文");
});
