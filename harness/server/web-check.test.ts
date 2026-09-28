// Q14 / F7：前端 svelte-check 基线（只拦新增）+ 体积报表（只出报表）。
//
// 修前：harness/web 从来没有类型检查——43 个 .svelte、20 个 .ts 的类型错误只能等运行时撞上；npm test 只查服务端。
// 修后：npm test 在 tsc 之后跑 web/scripts/svelte-baseline.ts（svelte-check 按文件计数，比 web/svelte-check-baseline.json
// 多了就失败，少了提示收紧）；scripts/size-report.ts 出行数报表，不设门禁。这里测两者的纯逻辑，真跑在 npm test 的链上。
import assert from "node:assert/strict";
import test from "node:test";
import { countLines, summarize, type SizeEntry } from "../scripts/size-report.ts";
import { compareBaseline, errorsByFile, parseMachineVerbose } from "../web/scripts/svelte-baseline.ts";

const MACHINE = [
  "1790315654967 START \"C:\\\\x\\\\web\"",
  '1790315654967 {"type":"ERROR","filename":"src\\\\components\\\\A.svelte","start":{"line":7,"character":2},"end":{"line":7,"character":5},"message":"Parameter \'a\'\\n  implicitly has an \'any\' type.","code":7006,"source":"ts"}',
  '1790315654967 {"type":"ERROR","filename":"src\\\\components\\\\A.svelte","start":{"line":9,"character":2},"end":{"line":9,"character":5},"message":"x","code":1,"source":"ts"}',
  '1790315654967 {"type":"WARNING","filename":"src\\\\B.svelte","start":{"line":1,"character":0},"end":{"line":1,"character":1},"message":"a11y","code":"a11y","source":"svelte"}',
  '1790315654967 {"type":"ERROR","filename":"src\\\\lib\\\\c.ts","start":{"line":0,"character":0},"end":{"line":0,"character":1},"message":"y","code":2,"source":"ts"}',
  "not json {",
  "1790315654967 COMPLETED 3 FILES 3 ERRORS 1 WARNINGS 3 FILES_WITH_PROBLEMS",
].join("\r\n");

test("F7 svelte-check 基线：按文件计错误（警告不计），多了算新增（新文件带错也算），少了提示收紧", () => {
  const problems = parseMachineVerbose(MACHINE);
  assert.equal(problems.length, 4);
  assert.deepEqual(problems[0], { type: "ERROR", file: "src/components/A.svelte", line: 8, message: "Parameter 'a' implicitly has an 'any' type." });
  const current = errorsByFile(problems);
  assert.deepEqual(current, { "src/components/A.svelte": 2, "src/lib/c.ts": 1 });

  assert.deepEqual(compareBaseline({ "src/components/A.svelte": 2, "src/lib/c.ts": 1 }, current), { worse: [], better: [] }, "与基线相同：放行");
  const { worse, better } = compareBaseline({ "src/components/A.svelte": 1, "src/old.ts": 3 }, current);
  assert.deepEqual(worse, [
    { file: "src/components/A.svelte", was: 1, now: 2 },
    { file: "src/lib/c.ts", was: 0, now: 1 },
  ], "错误变多、新文件带错都拦");
  assert.deepEqual(better, [{ file: "src/old.ts", was: 3, now: 0 }], "修好了的提示收紧");
});

test("F7 体积报表：各区合计、测试单列，超过阈值的只数非测试文件，最大的几个按行数排", () => {
  assert.equal(countLines(""), 0);
  assert.equal(countLines("a\nb\n"), 2);
  assert.equal(countLines("a\nb"), 2);
  const entries: SizeEntry[] = [
    { area: "server", file: "server/session.ts", lines: 2010, test: false },
    { area: "server", file: "server/small.ts", lines: 90, test: false },
    { area: "server", file: "server/huge.test.ts", lines: 5000, test: true },
    { area: "web/src", file: "web/src/lib/state.svelte.ts", lines: 1845, test: false },
  ];
  const text = summarize(entries, { top: 2, over: 400 });
  assert.match(text, /server：3 个文件、7,100 行（其中测试 1 个、5,000 行）/);
  assert.match(text, /web\/src：1 个文件、1,845 行/);
  assert.match(text, /超过 400 行的：2 个/);
  const top = text.split("最大的")[1];
  assert.ok(top.indexOf("server/session.ts") < top.indexOf("web/src/lib/state.svelte.ts"), "按行数从大到小");
  assert.ok(!top.includes("huge.test.ts") && !top.includes("small.ts"), "测试文件不进排行；只列前 top 个");
});
