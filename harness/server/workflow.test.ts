import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractWorkflowMeta, loadWorkflowDetail, makeWorkflowRunner, workflowSandboxArgs, workflowSandboxEnv } from "./agent/workflow.ts";
import { workflowTool } from "./tools/workflow.ts";
import { validateSchema } from "./agent/schema.ts";
import type { AgentEvent } from "./agent/events.ts";
import type { SubAgentRequest, SubAgentResult, ToolContext } from "./tools/types.ts";
import { Sandbox } from "./sandbox.ts";

const META = `export const meta = {
  name: 'review-changes',
  description: 'Review changed files, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify', detail: 'one skeptic per finding' }],
}`;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-workflow-"));
}

// Fake sub-agent runner: answers from a table keyed by prompt prefix, and
// honours schema (returns `result`) vs text. Records every request.
function fakeRunner(
  answer: (req: SubAgentRequest, n: number) => Partial<SubAgentResult> | Promise<Partial<SubAgentResult>>,
) {
  const requests: SubAgentRequest[] = [];
  let active = 0;
  let peak = 0;
  const run = async (req: SubAgentRequest): Promise<SubAgentResult> => {
    requests.push(req);
    active++;
    peak = Math.max(peak, active);
    try {
      req.onEvent?.({
        e: "subagent_start", id: req.id ?? "x", label: req.label ?? "", tier: req.tier ?? "research",
        model: "fake", provider: "openai", prompt: req.prompt, phase: req.phase, workflowId: req.workflowId,
      });
      const part = await answer(req, requests.length - 1);
      const r: SubAgentResult = {
        ok: true, id: req.id ?? "x", label: req.label ?? "", tier: req.tier ?? "research", model: "fake", provider: "openai",
        text: "", turns: 1, toolCalls: 0, inputTokens: 100, outputTokens: 50, editedFiles: [], trail: [], ...part,
      };
      req.onEvent?.({
        e: "subagent_end", id: r.id, ok: r.ok, error: r.error, turns: r.turns, toolCalls: r.toolCalls,
        inputTokens: r.inputTokens, outputTokens: r.outputTokens, text: r.text, result: r.result,
      });
      return r;
    } finally {
      active--;
    }
  };
  return { run, requests, peak: () => peak };
}

test("extractWorkflowMeta: pure literal in, name/phases out, export stripped from the body", () => {
  const script = `${META}\n// body\nlog("hi")\nreturn 1`;
  const r = extractWorkflowMeta(script);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.meta.name, "review-changes");
  assert.equal(r.meta.phases.length, 2);
  assert.equal(r.meta.phases[1].detail, "one skeptic per finding");
  assert.ok(r.body.startsWith("const meta = {"));
  assert.ok(r.body.includes('log("hi")'));

  const bad = extractWorkflowMeta(`const x = 1\nexport const meta = { name: x, description: 'd' }`);
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.match(bad.error, /pure literal/);
  const missing = extractWorkflowMeta(`export const meta = { description: 'd' }`);
  assert.equal(missing.ok, false);
  const none = extractWorkflowMeta(`log('no meta')`);
  assert.equal(none.ok, false);
  // Braces inside strings/comments don't confuse the scanner.
  const tricky = extractWorkflowMeta(`export const meta = { name: "a}b", /* } */ description: 'x{y' } // }\nreturn 2`);
  assert.ok(tricky.ok);
  if (tricky.ok) assert.equal(tricky.meta.name, "a}b");
});

test("runs a script: phases, agent() text vs schema, pipeline/parallel null semantics, concurrency cap, events", async () => {
  const runner = fakeRunner(async (req) => {
    await new Promise((r) => setTimeout(r, 20));
    if (req.prompt.startsWith("review:")) {
      return { result: { findings: [{ file: req.prompt.slice(7), title: "bug" }] } };
    }
    if (req.prompt.startsWith("verify:")) {
      return req.prompt.includes("b.ts") ? { ok: false, error: "provider died" } : { result: { real: true } };
    }
    if (req.prompt.startsWith("boom")) throw new Error("runner threw");
    return { text: `text for ${req.prompt}` };
  });
  const run = makeWorkflowRunner({ runSubAgent: runner.run, journalDir: tmpDir(), defaults: { maxConcurrency: 2 } });
  const events: AgentEvent[] = [];
  const script = `${META}
const FIND = { type: 'object', properties: { findings: { type: 'array' } }, required: ['findings'] }
const VERDICT = { type: 'object', properties: { real: { type: 'boolean' } }, required: ['real'] }
phase('Review')
const results = await pipeline(
  args.files,
  (f) => agent('review:' + f, { label: 'review ' + f, schema: FIND }),
  (review, f) => parallel(review.findings.map((x) => () =>
    agent('verify:' + x.file, { label: 'verify ' + x.file, phase: 'Verify', schema: VERDICT })
      .then((v) => ({ ...x, verdict: v })))),
)
log('verified ' + results.flat().length)
const plain = await agent('plain prompt')
const crashed = await parallel([() => agent('boom'), () => agent('fine')])
return { results, plain, crashed, spent: budget.spent() }
`;
  const r = await run({ script, args: { files: ["a.ts", "b.ts", "c.ts"] }, onEvent: (ev) => events.push(ev) });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.name, "review-changes");
  const value = r.result as any;
  // pipeline: a.ts and c.ts verified; b.ts's verify agent failed → null verdict
  assert.equal(value.results.length, 3);
  assert.deepEqual(value.results[0], [{ file: "a.ts", title: "bug", verdict: { real: true } }]);
  assert.deepEqual(value.results[1], [{ file: "b.ts", title: "bug", verdict: null }]);
  assert.equal(value.plain, "text for plain prompt");
  // parallel: a throwing thunk becomes null, the other survives
  assert.deepEqual(value.crashed, [null, "text for fine"]);
  assert.equal(typeof value.spent, "number");
  assert.ok(value.spent > 0);
  // concurrency gate honoured
  assert.ok(runner.peak() <= 2, `peak concurrency ${runner.peak()}`);
  // phases: explicit opts.phase wins over the global phase()
  const verify = runner.requests.find((q) => q.prompt.startsWith("verify:a"));
  assert.equal(verify?.phase, "Verify");
  const review = runner.requests.find((q) => q.prompt.startsWith("review:a"));
  assert.equal(review?.phase, "Review");
  assert.equal(review?.label, "review a.ts");
  assert.ok(review?.system?.includes("automated workflow"));
  // events
  const kinds = events.map((e) => e.e);
  assert.equal(kinds[0], "workflow_start");
  assert.ok(kinds.includes("workflow_phase") && kinds.includes("workflow_log") && kinds.includes("subagent_start"));
  assert.equal(kinds.at(-1), "workflow_end");
  const end = events.at(-1) as Extract<AgentEvent, { e: "workflow_end" }>;
  assert.equal(end.ok, true);
  assert.equal(end.agents, r.agents.length);
  assert.equal(r.agents.filter((a) => !a.ok).length, 2); // b.ts verify + boom
  assert.ok(r.logs.some((l) => l.startsWith("verified 3")));
  assert.ok(r.logs.some((l) => /runner threw/.test(l)));
  assert.ok(fs.existsSync(r.journalPath));
  // Timers for the task panel ride on the events and the summaries.
  const start = events[0] as Extract<AgentEvent, { e: "workflow_start" }>;
  assert.equal(typeof start.startedAt, "number");
  assert.equal(typeof end.durationMs, "number");
  assert.ok(r.agents.every((a) => typeof a.startedAt === "number" && typeof a.durationMs === "number"));
  // Per-agent detail lands in the journal (the transcript view reads it), failures included.
  const detail = loadWorkflowDetail(path.dirname(r.journalPath), r.id);
  assert.ok(detail);
  assert.equal(Object.keys(detail!.agents).length, r.agents.length);
  const plain = Object.values(detail!.agents).find((a) => a.prompt === "plain prompt");
  assert.equal(plain?.text, "text for plain prompt");
  assert.equal(plain?.ok, true);
  const boom = Object.values(detail!.agents).find((a) => a.prompt === "boom");
  assert.equal(boom?.ok, false);
  assert.match(boom?.error ?? "", /runner threw/);
  const verdict = Object.values(detail!.agents).find((a) => a.prompt === "verify:a.ts");
  assert.deepEqual(verdict?.result, { real: true });
  assert.equal(loadWorkflowDetail(path.dirname(r.journalPath), "wf_nope000"), null);
});

test("resume: unchanged agent() calls are served from the journal; new/edited calls run live", async () => {
  const dir = tmpDir();
  let n = 0;
  const runner = fakeRunner((req) => ({ text: `${req.prompt}#${n++}` }));
  const run = makeWorkflowRunner({ runSubAgent: runner.run, journalDir: dir });
  const script = (extra: string) => `${META}
const a = await agent('one')
const b = await agent('one')
const c = await agent('two', { schema: { type: 'object', properties: { x: { type: 'integer' } } } })
${extra}
return [a, b, c]
`;
  const runner2 = fakeRunner((req) => (req.schema ? { result: { x: 1 } } : { text: `${req.prompt}#${n++}` }));
  const first = await makeWorkflowRunner({ runSubAgent: runner2.run, journalDir: dir })({ script: script("") });
  assert.equal(first.ok, true, first.error);
  assert.deepEqual(first.result, ["one#0", "one#1", { x: 1 }]);
  assert.equal(runner2.requests.length, 3);

  // Same prompt twice = two distinct journal keys (occurrence index), so both
  // replay; a NEW call runs live; nothing else is re-run.
  const events: AgentEvent[] = [];
  const second = await makeWorkflowRunner({ runSubAgent: runner2.run, journalDir: dir })({
    script: script("const d = await agent('three')"),
    resumeFromRunId: first.id,
    onEvent: (ev) => events.push(ev),
  });
  assert.equal(second.ok, true, second.error);
  assert.deepEqual(second.result, ["one#0", "one#1", { x: 1 }]);
  assert.equal(runner2.requests.length, 4);
  assert.equal(runner2.requests[3].prompt, "three");
  assert.equal(second.cached, 3);
  const cachedStarts = events.filter((e) => e.e === "subagent_start" && (e as any).cached);
  assert.equal(cachedStarts.length, 3);

  const unknown = await run({ script: script(""), resumeFromRunId: "wf_doesnotexist" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error ?? "", /unknown or unreadable/);
});

test("script errors, hung loops and aborts are contained", async () => {
  const runner = fakeRunner(async (req) => {
    await new Promise((r) => setTimeout(r, 30));
    return { text: req.prompt };
  });
  const dir = tmpDir();

  // Syntax error → clean failure
  const syntax = await makeWorkflowRunner({ runSubAgent: runner.run, journalDir: dir })({ script: `${META}\nconst = 1` });
  assert.equal(syntax.ok, false);
  assert.match(syntax.error ?? "", /script error/);

  // Thrown error → clean failure carrying the message
  const thrown = await makeWorkflowRunner({ runSubAgent: runner.run, journalDir: dir })({ script: `${META}\nthrow new Error('nope')` });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error ?? "", /nope/);

  // No filesystem / process access inside the script
  const escape = await makeWorkflowRunner({ runSubAgent: runner.run, journalDir: dir })({
    script: `${META}\nreturn [typeof process, typeof require, typeof globalThis.fetch]`,
  });
  assert.equal(escape.ok, true, escape.error);
  assert.deepEqual(escape.result, ["undefined", "undefined", "undefined"]);

  // A synchronous infinite loop AFTER the first await is killed by the deadline
  // (this is exactly what an in-thread vm timeout cannot catch).
  const t0 = Date.now();
  const hung = await makeWorkflowRunner({ runSubAgent: runner.run, journalDir: dir, defaults: { deadlineMs: 400 } })({
    script: `${META}\nawait agent('first')\nwhile (true) {}`,
  });
  assert.equal(hung.ok, false);
  assert.match(hung.error ?? "", /deadline/);
  assert.ok(Date.now() - t0 < 5000);

  // Parent abort mid-run → aborted, in-flight agents got the signal
  const ctrl = new AbortController();
  const slow = fakeRunner(async (req) => {
    await new Promise((r) => setTimeout(r, 40));
    ctrl.abort();
    await new Promise((r) => setTimeout(r, 40));
    return { text: req.prompt, ok: !req.signal?.aborted };
  });
  const aborted = await makeWorkflowRunner({ runSubAgent: slow.run, journalDir: dir })({
    script: `${META}\nconst a = await agent('a')\nconst b = await agent('b')\nreturn [a, b]`,
    signal: ctrl.signal,
  });
  assert.equal(aborted.ok, false);
  assert.match(aborted.error ?? "", /aborted/);
  assert.equal(slow.requests.length, 1);
  assert.ok(slow.requests[0].signal?.aborted);

  // Agent cap throws inside the script
  const capped = await makeWorkflowRunner({ runSubAgent: runner.run, journalDir: dir, defaults: { maxAgents: 2 } })({
    script: `${META}\nfor (let i = 0; i < 5; i++) await agent('x' + i)\nreturn 'unreachable'`,
  });
  assert.equal(capped.ok, false);
  assert.match(capped.error ?? "", /agent cap reached/);
});

// P11（ZCode C2）：确认从 run() 里挪到了统一权限闸——prepare() 要求确认并把 meta 与脚本正文摆上卡片，卡由 loop 按统一规则弹
// （没人在场就不批，见 approval-card.test.ts）；run() 只管跑。以前这里断言「没人在场 → 不问就跑」，那正是 C2 要改掉的行为。
test("Workflow tool: meta confirmation via the permission card, result + journal id back to the model", async () => {
  const runWorkflow = makeWorkflowRunner({
    runSubAgent: fakeRunner((req) => ({ text: `re:${req.prompt}` })).run,
    journalDir: tmpDir(),
  });
  const base: ToolContext = {
    sandbox: new Sandbox(tmpDir()),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
    agentSeesImages: false,
    callId: "call-7",
    runWorkflow,
  };
  const script = `${META}\nconst a = await agent('hello', { label: 'greet' })\nreturn { a }`;

  // 规划阶段：要求确认，卡片上是名字、说明、阶段和脚本正文
  const prepared = await workflowTool.prepare!({ script }, base);
  assert.ok(prepared?.confirm, "要人确认");
  assert.equal(prepared?.veto, undefined);
  const preview = prepared?.preview;
  assert.equal(preview?.kind, "script");
  if (preview?.kind === "script") {
    assert.equal(preview.name, "review-changes");
    assert.match(preview.description, /Review changed files/);
    assert.deepEqual(preview.phases, ["Review", "Verify"]);
    assert.equal(preview.script, script, "卡上摆的就是要跑的脚本");
  }

  // 批过之后 run() 直接跑：结果 JSON + runId 在正文里，工作流摘要在 meta 里
  const approved = await workflowTool.run({ script }, base);
  assert.equal(approved.ok, true);
  const text = approved.content.map((b) => (b.t === "text" ? b.text : "")).join("");
  assert.match(text, /runId: wf_[a-z0-9]+/);
  assert.match(text, /"a": "re:hello"/);
  assert.equal((approved.meta as any).workflow.agents[0].label, "greet");

  // 写坏的 meta：规划阶段就否决（不弹卡），直接调 run 也照样拒
  const badPrep = await workflowTool.prepare!({ script: "return 1" }, base);
  assert.match(badPrep?.veto?.summary ?? "", /bad workflow meta/);
  const badMeta = await workflowTool.run({ script: "return 1" }, base);
  assert.equal(badMeta.ok, false);
  assert.match(badMeta.summary, /bad workflow meta/);
});

test("validateSchema covers the subset the tools rely on", () => {
  const schema = {
    type: "object" as const,
    properties: {
      kind: { type: "string" as const, enum: ["a", "b"] },
      n: { type: "number" as const, minimum: 0, maximum: 10 },
      tags: { type: "array" as const, items: { type: "string" as const } },
      nested: { type: "object" as const, properties: { ok: { type: "boolean" as const } }, required: ["ok"] },
    },
    required: ["kind"],
    additionalProperties: false,
  };
  assert.deepEqual(validateSchema(schema, { kind: "a", n: 3, tags: ["x"], nested: { ok: true } }), []);
  const errs = validateSchema(schema, { kind: "c", n: 11, tags: ["x", 2], nested: {}, extra: 1 });
  const paths = errs.map((e) => e.path).sort();
  assert.deepEqual(paths, ["$.extra", "$.kind", "$.n", "$.nested.ok", "$.tags[1]"]);
  assert.deepEqual(validateSchema(schema, "nope").map((e) => e.path), ["$"]);
});

// S2（#35）：vm 不是边界，边界在脚本进程上——它的环境里不能有 provider key 或 bridge 注入的内部令牌，只剩几个
// 系统路径变量；启动参数开着权限模型、只许读入口文件、禁止字符串生成代码。本文件其余用例都在这个进程里跑，
// 说明它本身不依赖别的变量、别的文件。
test("S2: the workflow sandbox process gets only non-secret system variables and a locked-down command line", () => {
  const saved = { a: process.env.OPENAI_API_KEY, t: process.env.DIMENSIO_INTERNAL_TOKEN };
  process.env.OPENAI_API_KEY = "sk-should-not-leak";
  process.env.DIMENSIO_INTERNAL_TOKEN = "should-not-leak";
  try {
    const env = workflowSandboxEnv();
    for (const key of Object.keys(env)) {
      assert.ok(["SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR"].includes(key.toUpperCase()), `unexpected ${key}`);
    }
    assert.ok(!JSON.stringify(env).includes("should-not-leak"));
  } finally {
    if (saved.a === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = saved.a;
    if (saved.t === undefined) delete process.env.DIMENSIO_INTERNAL_TOKEN;
    else process.env.DIMENSIO_INTERNAL_TOKEN = saved.t;
  }
  const args = workflowSandboxArgs("C:\\x\\entry.ts");
  assert.ok(args.includes("--permission"));
  assert.ok(args.includes("--disallow-code-generation-from-strings"));
  assert.deepEqual(args.filter((a) => a.startsWith("--allow-")), ["--allow-fs-read=C:\\x\\entry.ts"], "只许读入口文件，别的一概不放行");
  assert.equal(args.at(-1), "C:\\x\\entry.ts");
});

// S2 根治：以前经注入的宿主函数 `.constructor` 就能逃出 vm、拿到整个进程（worker 线程与 harness 同进程，读写任意
// 文件、起子进程都行）。现在这条路在源头失败。
test("S2: escaping the vm through a host function's constructor fails at the source", async () => {
  const runner = fakeRunner(async (req) => ({ text: req.prompt }));
  const r = await makeWorkflowRunner({ runSubAgent: runner.run, journalDir: tmpDir() })({
    script: `${META}\nconst p = agent.constructor("return process")()\nreturn typeof p.pid`,
  });
  assert.equal(r.ok, false, `逃出去了：${JSON.stringify(r.result)}`);
  assert.match(r.error ?? "", /Code generation from strings disallowed/);
});

// 纵深防御：就算将来有别的办法逃出 vm，落进的也是这个进程——读不了别的文件、起不了子进程和线程。用同一套启动
// 参数起一个探针入口（它直接拿到 process，相当于「已经逃出去了」），逐项报回结果。
test("S2: even an escaped script cannot read files, spawn processes or start threads in the sandbox process", async () => {
  const dir = tmpDir();
  const secret = path.join(dir, "secret.txt");
  fs.writeFileSync(secret, "should-not-be-readable");
  const probe = path.join(dir, "probe.mjs");
  fs.writeFileSync(
    probe,
    `const out = {};
const tryIt = async (k, fn) => { try { await fn(); out[k] = "ALLOWED"; } catch (e) { out[k] = e.code || e.message; } };
await tryIt("read", () => process.getBuiltinModule("node:fs").readFileSync(${JSON.stringify(secret)}, "utf8"));
await tryIt("write", () => process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(path.join(dir, "w.txt"))}, "x"));
await tryIt("spawn", () => process.getBuiltinModule("node:child_process").spawnSync(process.execPath, ["-v"]));
await tryIt("worker", () => new (process.getBuiltinModule("node:worker_threads").Worker)("0", { eval: true }));
await tryIt("binding", () => process.binding("fs"));
process.send(out, () => process.exit(0));
`,
  );
  const { spawn } = await import("node:child_process");
  const child = spawn(process.execPath, workflowSandboxArgs(probe), { env: workflowSandboxEnv(), stdio: ["ignore", "ignore", "pipe", "ipc"], windowsHide: true });
  let stderr = "";
  child.stderr!.on("data", (d) => (stderr += d));
  const out = await new Promise<Record<string, string>>((resolve, reject) => {
    child.on("message", (m) => resolve(m as Record<string, string>));
    child.on("exit", (code) => reject(new Error(`probe exited ${code}: ${stderr}`)));
  });
  assert.deepEqual(out, { read: "ERR_ACCESS_DENIED", write: "ERR_ACCESS_DENIED", spawn: "ERR_ACCESS_DENIED", worker: "ERR_ACCESS_DENIED", binding: "ERR_ACCESS_DENIED" });
  assert.equal(fs.existsSync(path.join(dir, "w.txt")), false);
});
