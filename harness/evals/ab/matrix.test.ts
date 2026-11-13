// 模型档案 P0：矩阵评测台的自检（不测模型）。npm test 只收 server/*.test.ts，这一份单跑：
//   cd harness && node --import ./server/test-setup.ts --test evals/ab/matrix.test.ts
// ① 纯函数：型号写法、臂与并发、待跑清单与本机分组、统计、错误分类、报表；② 管线：起一臂真 harness + 假 OpenAI 兼容服务，
// 并发模式跑一道多轮题（第二条消息进同一会话）与一道带权限规则的题，读记录判分、出细项指标。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { StreamEvent } from "../../server/agent/events.ts";
import { say, useTool } from "../../server/test-harness/scripted-adapter.ts";
import { openaiSse } from "../../server/test-harness/wire-fakes.ts";
import { engineOfModel } from "../../server/localai.ts";
import { memoryDirKey } from "../../server/memory.ts";
import { api, type Arm, armEnv, assertArmConfig, catalogDefaultEffort, CHILD_ISOLATION_VARS, clearRunMemory, type RunRow, runMemoryView, runTask, startArm, wantedEffort } from "./lib.ts";
import { matrixReport } from "./matrix-report.ts";
import { endpointLimit, localEngineOf, localGroups, parseModelSpec, planArms, safeName, workItems } from "./matrix.ts";
import { categorize, newTally, observe, runMetrics } from "./metrics.ts";
import { COPY_MARKER, copyProviders, fixVllmThinking } from "./providers-copy.ts";
import { passHatK, wilson } from "./stats.ts";
import { commandWrites, filesUnder, write } from "./task-kit.ts";
import { HARD_TASKS } from "./tasks-hard.ts";
import { type AbTask, taskById, TASKS, tasksOfSuite } from "./tasks.ts";

const tempDir = (t: TestContext, prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
};

test("矩阵：型号写法、臂、并发上限、待跑清单与本机分组", () => {
  assert.deepEqual(parseModelSpec("custom-024744f2/qwen3.8-flash-next-fp8"), { provider: "custom-024744f2", model: "qwen3.8-flash-next-fp8", spec: "custom-024744f2/qwen3.8-flash-next-fp8" });
  assert.deepEqual(parseModelSpec("local/strata-orca@medium"), { provider: "local", model: "strata-orca", effort: "medium", spec: "local/strata-orca@medium" });
  assert.throws(() => parseModelSpec("deepseek"), /provider\/model/);
  const models = ["deepseek/deepseek-v4-flash", "local/qwen3.8-27b", "local/strata-orca", "custom-024744f2/q"].map(parseModelSpec);
  assert.deepEqual(planArms(models, []).map((a) => [a.name, a.endpoint]), [
    ["deepseek/deepseek-v4-flash", "deepseek"],
    ["local/qwen3.8-27b", "local"],
    ["local/strata-orca", "local"],
    ["custom-024744f2/q", "custom-024744f2"],
  ]);
  const arms = planArms(models, [{ name: "base" }, { name: "tuned", profileOverrides: { a: 1 } }]);
  assert.equal(arms.length, 8);
  assert.equal(arms[1].name, "deepseek/deepseek-v4-flash#tuned");
  assert.equal(endpointLimit("local", { local: 9 }), 1, "本机恒为 1，不认覆盖");
  assert.equal(endpointLimit("custom-024744f2", {}), 4);
  assert.equal(endpointLimit("custom-024744f2", { "custom-024744f2": 6 }), 6);
  assert.equal(endpointLimit("deepseek", {}), 3);
  // 本机引擎归属与服务端同一口径（Strata 拆成独立型号时只改 server/localai.ts 那一处）
  for (const m of ["strata-orca", "qwen3.8-27b", "strata-flash-q4"]) assert.equal(localEngineOf(m), engineOfModel(m));
  assert.equal(localEngineOf("strata-orca"), "strata");
  // 给了变体文件，哪怕只有一个变体，臂名也带 #变体名（免得和不带变体的那次撞续跑键）
  assert.equal(planArms(models.slice(0, 1), [{ name: "tuned" }])[0].name, "deepseek/deepseek-v4-flash#tuned");
  assert.equal(safeName("a/b c#d"), "a_b_c_d");
  const tasks = tasksOfSuite("hard").slice(0, 2);
  const items = workItems(arms, tasks, 2, new Set([`${tasks[0].id}|${arms[0].name}|1`]));
  assert.equal(items.length, 8 * 2 * 2 - 1, "已完成的跳过");
  const groups = localGroups(items);
  assert.deepEqual(groups.map((g) => g.model), ["qwen3.8-27b", "strata-orca"], "本机按型号分组，先后按首次出现");
  assert.ok(groups.every((g) => g.items.every((it) => it.arm.model.model === g.model)));
});

test("矩阵：套题与新题的元数据", () => {
  assert.ok(HARD_TASKS.length >= 15 && HARD_TASKS.length <= 20, `新题 ${HARD_TASKS.length} 道`);
  for (const t of HARD_TASKS) {
    assert.ok(t.dimension && t.difficulty && t.scoring, `${t.id} 缺维度 / 难度 / 判分说明`);
    assert.equal(t.suite, "hard");
  }
  const dims = new Set(HARD_TASKS.map((t) => t.dimension));
  for (const d of ["编辑格式", "工具调用健壮性", "指令遵循", "长跨度多轮", "收尾完整性", "日常"]) assert.ok(dims.has(d as never), `没有 ${d} 维度的新题`);
  assert.ok(HARD_TASKS.some((t) => t.followups?.length), "至少一道多轮题");
  assert.equal(tasksOfSuite("all").length, TASKS.length);
  assert.ok(tasksOfSuite("classic").every((t) => t.suite === "classic" && t.dimension));
  assert.equal(taskById("edit-multi-match")?.dimension, "编辑格式");
});

test("统计：Wilson 区间与 pass^k", () => {
  const [lo, hi] = wilson(3, 3);
  assert.ok(lo > 0.4 && lo < 0.5 && hi === 1, `3/3 → [${lo}, ${hi}]`);
  assert.deepEqual(wilson(0, 0), [0, 0]);
  assert.equal(passHatK([[3, 3], [0, 3]], 3), 0.5);
  assert.equal(passHatK([[2, 3]], 2), 1 / 3);
  assert.equal(passHatK([[1, 1]], 2), null, "次数不足 k 的题不计");
});

test("错误分类：按工具 summary 与结果正文", () => {
  assert.equal(categorize("Edit", "no match", "old_string not found in a.js."), "edit-nomatch");
  assert.equal(categorize("Edit", "ambiguous", "old_string matches 2 places in a.js."), "edit-ambiguous");
  assert.equal(categorize("Edit", "not read", "You must Read a.js before editing it."), "read-gate");
  assert.equal(categorize("Write", "not read", "a.js already exists. Read it before overwriting it."), "read-gate");
  assert.equal(categorize("Bash", "bad tool arguments", "The arguments for Bash were not valid JSON"), "bad-args");
  assert.equal(categorize("Foo", "unknown tool", 'Unknown tool "Foo".'), "unknown-tool");
  assert.equal(categorize("Bash", "denied: matched deny rule", "Denied by permission policy: …"), "denied");
  assert.equal(categorize("Bash", "blocked", "Command blocked by workspace policy: …"), "denied");
  assert.equal(categorize("Bash", "bash: npm test (exit 1)", "$ npm test\nargument is required\n[exit 1]"), "nonzero-exit", "命令输出里的字样不影响分类");
  assert.equal(categorize("Bash", "bash: sleep 999 (timeout)", "…"), "timeout");
  assert.equal(categorize("Bash", "not run", "verify:true needs an exit status that belongs to the check"), "bad-args");
});

test("细项指标：事件流 + 会话记录", () => {
  const tally = newTally();
  for (const ev of [
    { e: "tool_start", name: "Edit" },
    { e: "tool_end", name: "Edit", ok: false, summary: "ambiguous", content: [{ t: "text", text: "old_string matches 2 places" }] },
    { e: "tool_start", name: "Edit" },
    { e: "tool_end", name: "Edit", ok: true, summary: "edited", content: [] },
    { e: "tool_start", name: "Bash" },
    { e: "tool_end", name: "Bash", ok: true, summary: "bash: ls (exit 0)", content: [{ t: "text", text: "[Loop guard] same call again" }] },
    { e: "usage", inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 },
    { e: "done", stopReason: "end" },
  ]) observe(tally, ev);
  const rec = {
    messages: [
      { role: "user", content: [{ t: "text", text: "做事" }] },
      { role: "assistant", content: [{ t: "thinking", text: "x".repeat(400) }] },
      { role: "user", origin: "harness", kind: "length-continue", content: [{ t: "text", text: "[Automated check] Your previous reply was cut off" }] },
      { role: "assistant", content: [{ t: "tool_call", id: "a", name: "Edit", args: {} }] },
      { role: "user", content: [{ t: "tool_result", id: "a", ok: false, content: [{ t: "text", text: "ambiguous" }] }] },
      { role: "user", origin: "harness", kind: "budget-exhausted", content: [{ t: "text", text: "[Budget exhausted] stop" }] },
      { role: "assistant", content: [{ t: "text", text: "好了" }] },
    ],
    totals: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 60 },
  } as never;
  const m = runMetrics(rec, tally, 1);
  assert.equal(m.toolCalls, 3);
  assert.equal(m.editCalls, 2);
  assert.equal(m.editFailed, 1);
  assert.deepEqual(m.errors, { "edit-ambiguous": 1 });
  assert.equal(m.thinkingOnlyTurns, 1);
  assert.equal(m.lengthContinues, 1);
  assert.equal(m.budgetExhausted, true);
  assert.equal(m.loopGuard, 1);
  assert.equal(m.tokens.thinkingEst, 100);
  assert.equal(m.tokens.cacheRead, 60);
  assert.equal(m.stopReason, "end");
});

test("报表：汇总、逐题矩阵、分维度、错误类别、逐条没通过", () => {
  const row = (arm: string, task: string, rep: number, pass: boolean, extra: Partial<RunRow> = {}): RunRow => ({
    task, arm, rep, pass, detail: pass ? "ok" : "bad", outcome: "done", turns: 4, toolCalls: 3, failedCalls: pass ? 0 : 1, nudges: 0, lastVerification: "", tokens: 50_000, wallMs: 30_000, tail: "",
    dimension: taskById(task)?.dimension, claimedDone: true,
    m: { messages: 1, steps: 4, tools: {}, toolCalls: 3, toolFailed: pass ? 0 : 1, editCalls: 2, editFailed: pass ? 0 : 1, errors: pass ? {} : { "edit-nomatch": 1 }, tokens: { input: 40_000, output: 10_000, cacheRead: 30_000, thinkingEst: 2000, ledger: 50_000 }, budgetExhausted: false, thinkingOnlyTurns: 0, lengthContinues: 0, nudges: {}, loopGuard: 0, denied: 0, maxIdenticalStreak: 1, stopReason: "end" },
    ...extra,
  });
  const rows = [row("A", "edit-crlf", 1, true), row("A", "edit-crlf", 2, false), row("B", "edit-crlf", 1, true), row("B", "edit-crlf", 2, true), row("B", "if-json-only", 1, true)];
  const md = matrixReport(rows, { title: "自检", arms: ["A", "B"] });
  assert.match(md, /\| A \| 1\/2 \| 50%（\d+%–\d+%） \| 0% \|/, "通过率 + 区间 + pass^2");
  assert.match(md, /\| edit-crlf \| 编辑格式 \| 中 \| 1\/2 \| 2\/2 \|/);
  assert.match(md, /\| 编辑格式 \| 50%（1\/2） \| 100%（2\/2） \|/);
  assert.match(md, /\| 编辑未命中 \| 1 \| 0 \|/);
  assert.match(md, /edit-crlf · A · 第 2 次.*模型自称完成/);
});

test("自定义服务副本：顶层 enable_thinking 挪进 chat_template_kwargs，只改点名的服务", (t) => {
  const dir = tempDir(t, "dimensio-mp-prov-");
  const file = path.join(dir, "providers.json");
  const spec = (v: Record<string, unknown>) => ({ id: "m", efforts: [{ id: "off", value: { enable_thinking: false } }, { id: "low", value: { ...v } }] });
  fs.writeFileSync(file, JSON.stringify({ providers: [{ id: "custom-a", modelSpecs: [spec({ enable_thinking: true, reasoning_effort: "low" })] }, { id: "custom-b", modelSpecs: [spec({ enable_thinking: true })] }] }));
  assert.equal(fixVllmThinking(file, ["custom-a"]), 2);
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(doc.providers[0].modelSpecs[0].efforts[1].value, { reasoning_effort: "low", chat_template_kwargs: { enable_thinking: true } });
  assert.deepEqual(doc.providers[1].modelSpecs[0].efforts[0].value, { enable_thinking: false }, "没点名的不动");
  assert.equal(fixVllmThinking(file, ["custom-a"]), 0, "已经挪过的不再动");
});

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

// 假 OpenAI 兼容服务：带 tools 的请求按「这条请求里最后一条用户原话」挑脚本（并发的几个会话互不干扰），每个脚本按它自己的序号走
async function stubProvider(t: TestContext, scripts: Record<string, StreamEvent[][]>) {
  const used: Record<string, number> = {};
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      let step: readonly StreamEvent[] = say("（旁路请求的回应）");
      if (Array.isArray(body.tools) && body.tools.length) {
        const userTexts = (body.messages as { role: string; content: unknown }[])
          .filter((m) => m.role === "user")
          .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
        const key = Object.keys(scripts).filter((k) => userTexts.some((u) => u.includes(k))).at(-1);
        if (key) step = scripts[key][used[key] = (used[key] ?? -1) + 1] ?? say("完成。");
        else step = say("完成。");
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(openaiSse(step));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${(server.address() as net.AddressInfo).port}/v1`;
}

test("矩阵管线：并发模式下一道多轮题 + 一道带权限规则的题，判分与细项指标", async (t) => {
  const followup = taskById("mt-followup")!;
  const deny = taskById("tool-deny-reroute")!;
  const BY = [{ city: "上海", count: 17 }, { city: "北京", count: 14 }, { city: "深圳", count: 12 }, { city: "杭州", count: 9 }, { city: "成都", count: 8 }];
  const baseUrl = await stubProvider(t, {
    // 第一条：先写成对象格式
    "统计 data/orders.csv": [useTool("w1", "Write", { path: "out/by-city.json", content: JSON.stringify({ 上海: 17 }) }), say("写好了。")],
    // 第二条（同一会话）：先改不存在的串（编辑未命中）、再整份重写成数组、写合计——合计故意写错，判分不过
    订单最多的那个城市: [
      useTool("r1", "Read", { path: "out/by-city.json" }),
      useTool("e1", "Edit", { path: "out/by-city.json", old_string: "不存在", new_string: "x" }),
      useTool("w2", "Write", { path: "out/by-city.json", content: JSON.stringify(BY) }),
      useTool("w3", "Write", { path: "out/top-total.txt", content: "1.00" }),
      say("都改好了。"),
    ],
    // 权限题：先跑脚本（被规则拒）→ 照手工步骤直接写结果
    "生成 out/report.json": [
      useTool("b1", "Bash", { command: "node scripts/gen-report.mjs" }),
      useTool("w4", "Write", { path: "out/report.json", content: "{}" }),
      say("脚本被拦了，按手工步骤写了。"),
    ],
  });
  const work = tempDir(t, "dimensio-matrix-plumbing-");
  let arm: Arm | undefined;
  t.after(async () => {
    await arm?.stop();
  });
  const noKeys = Object.fromEntries(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "QWEN_API_KEY", "DEEPSEEK_API_KEY", "KIMI_API_KEY", "MIMO_API_KEY", "LOCAL_API_KEY"].map((k) => [k, ""]));
  arm = await startArm({ name: "local/ab-stub", harnessDir: path.resolve(import.meta.dirname, "..", ".."), port: await freePort(), root: path.join(work, "arm"), extraEnv: noKeys });
  // 矩阵模式：全局配置起臂后设一次（含两题的权限规则并集）
  const cfg = await (await api(arm, "POST", "/api/config", { provider: "local", model: "ab-stub", baseUrl, access: "workspace", permissionMode: "auto", permissionRules: { allow: [], ask: [], deny: deny.permissionRules!.deny } })).json();
  assert.equal((cfg as { access?: string }).access, "workspace");
  const provider = { provider: "local", model: "ab-stub" };
  const [a, b] = await Promise.all([
    runTask(arm, followup, { runDir: path.join(work, "runs", "mt"), provider, concurrent: true }),
    runTask(arm, deny, { runDir: path.join(work, "runs", "deny"), provider, concurrent: true }),
  ]);
  // 多轮：两条消息进了同一会话；第二条依赖第一条的文件；合计写错 → 不通过，但格式那一半对了
  assert.equal(a.m!.messages, 2);
  assert.equal(a.pass, false);
  assert.match(a.detail, /byCityArray=true topTotal=1/);
  assert.equal(a.claimedDone, true, "模型自称完成、判分没过");
  assert.equal(a.m!.errors["edit-nomatch"], 1);
  assert.ok(a.m!.editCalls >= 4 && a.m!.editFailed === 1, `编辑 ${a.m!.editCalls}/${a.m!.editFailed}`);
  const sessions = fs.readdirSync(arm.sessionsDir).filter((f) => f.endsWith(".json"));
  assert.equal(sessions.length, 2, "两道题两个会话（多轮题的第二条没有另开会话）");
  // 权限题：脚本被拒（不会生成执行标记）；手写的报告内容不对 → 不通过；拒绝计入权限类错误
  assert.equal(b.pass, false);
  assert.match(b.detail, /scriptRanAnyway=false/);
  assert.equal(b.m!.errors.denied, 1, JSON.stringify(b.m!.errors));
  assert.equal(b.m!.denied, 1);
  assert.ok(a.activeMs! > 0 && a.activeMs! <= a.wallMs, `只算流的耗时 ${a.activeMs} ≤ 墙钟 ${a.wallMs}`);
  // 默认档：照这一臂的目录查（目录里的型号按 defaultEffort；不在目录里的按 ["off"]）
  assert.equal(await wantedEffort(arm, "local", "strata-orca"), "medium");
  assert.equal(await wantedEffort(arm, "local", "ab-stub"), "off");
  assert.equal(await wantedEffort(arm, "local", "strata-orca", "xhigh"), "xhigh", "点名的照用");
});

test("思考档位：目录默认档的推法、设完核对不符就中止", () => {
  const catalog = [{ id: "p", models: [{ id: "a", efforts: ["low", "medium", "high"], defaultEffort: "medium" }, { id: "b", efforts: ["off", "low"] }, { id: "c", efforts: ["low", "high"], defaultEffort: "max" }] }];
  assert.equal(catalogDefaultEffort(catalog, "p", "a"), "medium");
  assert.equal(catalogDefaultEffort(catalog, "p", "b"), "low");
  assert.equal(catalogDefaultEffort(catalog, "p", "c"), "high", "目录给的默认档不在档位表里就退回 high");
  assert.equal(catalogDefaultEffort(catalog, "p", "zzz"), "off");
  assert.doesNotThrow(() => assertArmConfig("x", { provider: "p", model: "a", thinking: "medium" }, { provider: "p", model: "a", thinking: "medium" }));
  assert.throws(() => assertArmConfig("x", { provider: "p", model: "a", thinking: "medium" }, { provider: "p", model: "a", thinking: "low" }), /thinking 是 low，期望 medium/);
});

test("臂的环境：子进程家目录 / 草稿目录 / npm、pip 隔离变量都在临时根，并经放行名单交给子进程", (t) => {
  const root = tempDir(t, "dimensio-arm-env-");
  const prev = process.env.DIMENSIO_CHILD_ENV_ALLOW;
  process.env.DIMENSIO_CHILD_ENV_ALLOW = "FOO_INHERITED";
  t.after(() => {
    if (prev === undefined) delete process.env.DIMENSIO_CHILD_ENV_ALLOW;
    else process.env.DIMENSIO_CHILD_ENV_ALLOW = prev;
  });
  const env = armEnv({ port: 1, root, extraEnv: { DIMENSIO_CHILD_ENV_ALLOW: "BAR_EXTRA" } }, "tok");
  const allow = env.DIMENSIO_CHILD_ENV_ALLOW!.split(",");
  for (const name of [...CHILD_ISOLATION_VARS, "FOO_INHERITED", "BAR_EXTRA"]) assert.ok(allow.includes(name), `放行名单缺 ${name}`);
  for (const key of ["DIMENSIO_CHILD_HOME", "DIMENSIO_SCRATCH_DIR", "npm_config_prefix", "npm_config_cache", "PYTHONUSERBASE"]) {
    assert.ok(path.resolve(env[key]!).startsWith(path.resolve(root)), `${key} 不在临时根：${env[key]}`);
  }
  // 全局层记忆按运行（工作区）隔离：默认打开，调用方可以经 extraEnv 关掉
  assert.equal(env.DIMENSIO_GLOBAL_MEMORY_SCOPE, "workspace");
  assert.equal(armEnv({ port: 1, root, extraEnv: { DIMENSIO_GLOBAL_MEMORY_SCOPE: "" } }, "tok").DIMENSIO_GLOBAL_MEMORY_SCOPE, "");
});

test("判分的记忆视图：只含这次运行自己的工作区层与全局层；不认开关的老臂把共用全局层放进 global-shared", (t) => {
  const work = tempDir(t, "dimensio-mp-memview-");
  const mem = path.join(work, "memory");
  const runA = path.join(work, "runs", "pref-1");
  const runB = path.join(work, "runs", "pref-2");
  const put = (rel: string, body: string) => write(mem, rel, body);
  put(`workspaces/${memoryDirKey(runA)}/a.md`, "A 的工作区笔记");
  put(`global-scoped/${memoryDirKey(runA)}/g.md`, "A 的全局笔记");
  put(`workspaces/${memoryDirKey(runB)}/b.md`, "B 的工作区笔记");
  const views = path.join(work, "check-memory");
  const viewA = runMemoryView(mem, runA, views);
  const viewB = runMemoryView(mem, runB, views);
  const files = (dir: string) => filesUnder(dir);
  assert.deepEqual(files(viewA), [`global/g.md`, `workspaces/${memoryDirKey(runA)}/a.md`]);
  assert.deepEqual(files(viewB), [`workspaces/${memoryDirKey(runB)}/b.md`], "看不到 A 写的全局笔记");
  // 视图每次重建（不留上次的）
  fs.rmSync(path.join(mem, "global-scoped"), { recursive: true });
  assert.deepEqual(files(runMemoryView(mem, runA, views)), [`workspaces/${memoryDirKey(runA)}/a.md`]);
  // 老代码的臂：全局层只有共用的一份，分不开，原样放进 global-shared/
  put("global/old.md", "共用的全局笔记");
  assert.deepEqual(files(runMemoryView(mem, runB, views)), ["global-shared/old.md", `workspaces/${memoryDirKey(runB)}/b.md`]);
  // 续跑同一个 runDir 前清掉它上一次的两份，别的运行的不动
  put(`global-scoped/${memoryDirKey(runA)}/g.md`, "A 的全局笔记");
  clearRunMemory(mem, runA);
  assert.equal(fs.existsSync(path.join(mem, "workspaces", memoryDirKey(runA))), false);
  assert.equal(fs.existsSync(path.join(mem, "global-scoped", memoryDirKey(runA))), false);
  assert.ok(fs.existsSync(path.join(mem, "workspaces", memoryDirKey(runB), "b.md")));
  // 参考解的记忆写法（workspaces/ab/...）与视图同一布局：pref-memory 判分认得
  const pref = taskById("pref-memory")!;
  const refView = tempDir(t, "dimensio-mp-memview-ref-");
  pref.reference.memory!(refView);
  assert.equal(pref.check(runA, { messages: [{ role: "assistant", content: [{ t: "text", text: "lumen-notes" }] }] } as never, { memoryDir: refView }).pass, true);
  assert.equal(pref.check(runA, { messages: [{ role: "assistant", content: [{ t: "text", text: "lumen-notes" }] }] } as never, { memoryDir: viewB }).pass, false);
});

// 端到端：同一臂先后跑同一道「记住偏好」题两次。第 1 次把偏好写进全局层（判过），第 2 次没写——以前它看得到第 1 次写的、
// 判分扫整臂记忆根也会判过；现在第 2 次的 Recall(layer:"global") 是空的、判分不过。
test("同一臂的两次运行：全局层记忆互不可见，判分只看这次自己写的", async (t) => {
  const pref = taskById("pref-memory")!;
  const remember = { title: "提交信息用中文", description: "这个项目的 git 提交信息用中文写。", type: "user", topic: "user.commit-language", status: "proposed", confidence: "inferred", content: "用户要求 git 提交信息一律用中文写。", layer: "global" };
  const baseUrl = await stubProvider(t, {
    记住这一点: [
      useTool("m1", "Remember", remember),
      say("name 是 lumen-notes，已记下。"),
      // 第 2 次运行：只看一眼全局层、不写
      useTool("m2", "Recall", { layer: "global" }),
      say("name 是 lumen-notes。"),
    ],
  });
  const work = tempDir(t, "dimensio-matrix-memscope-");
  let arm: Arm | undefined;
  t.after(async () => {
    await arm?.stop();
  });
  const noKeys = Object.fromEntries(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "QWEN_API_KEY", "DEEPSEEK_API_KEY", "KIMI_API_KEY", "MIMO_API_KEY", "LOCAL_API_KEY"].map((k) => [k, ""]));
  const root = path.join(work, "arm");
  arm = await startArm({ name: "local/ab-stub", harnessDir: path.resolve(import.meta.dirname, "..", ".."), port: await freePort(), root, extraEnv: noKeys });
  await api(arm, "POST", "/api/config", { provider: "local", model: "ab-stub", baseUrl, access: "workspace", permissionMode: "auto" });
  const provider = { provider: "local", model: "ab-stub" };
  const run1 = path.join(work, "runs", "pref-1");
  const run2 = path.join(work, "runs", "pref-2");
  const first = await runTask(arm, pref, { runDir: run1, provider, rep: 1, concurrent: true });
  assert.equal(first.pass, true, `第 1 次：${first.detail} ${first.outcome}`);
  const mem = path.join(root, "memory");
  const notes = filesUnder(path.join(mem, "global-scoped", memoryDirKey(run1))).filter((f) => /^[^/]+\.md$/.test(f) && f !== "MEMORY.md");
  assert.equal(notes.length, 1, `写进了第 1 次自己那份全局层：${notes.join(",")}`);
  assert.equal(fs.existsSync(path.join(mem, "global")), false, "共用的那份没人碰");

  const second = await runTask(arm, pref, { runDir: run2, provider, rep: 2, concurrent: true });
  assert.equal(second.pass, false, "第 2 次没写，不该因为第 1 次写过而判过");
  assert.match(second.detail, /named=true remembered=false/);
  const records = fs.readdirSync(arm.sessionsDir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(fs.readFileSync(path.join(arm!.sessionsDir, f), "utf8")) as { config?: { workspace?: string }; messages: unknown[] });
  const rec = records.find((r) => r.config?.workspace && path.resolve(r.config.workspace) === path.resolve(run2));
  assert.ok(rec, `第 2 次的会话记录（工作区：${records.map((r) => r.config?.workspace).join(" | ")}）`);
  const transcript = JSON.stringify(rec.messages);
  assert.match(transcript, /Recall/, "第 2 次调过 Recall");
  assert.match(transcript, /memory is empty/, "第 2 次看不到第 1 次写的全局记忆");
  assert.doesNotMatch(transcript, /\[global:note-/);
});

// 臂里模型跑的命令真拿到了隔离变量（经 Bash 工具的子进程环境白名单）：脚本把看到的环境写进工作区，读回来核对
test("臂里的 Bash 子进程：隔离变量到了、家目录与草稿目录在这一臂的临时根", async (t) => {
  const KEYS = [...CHILD_ISOLATION_VARS, "USERPROFILE", "WORKSPACE_TMP"];
  const baseUrl = await stubProvider(t, { 探测子进程环境: [useTool("b1", "Bash", { command: "node dump-env.mjs" }), say("好了。")] });
  const work = tempDir(t, "dimensio-matrix-env-");
  let arm: Arm | undefined;
  t.after(async () => {
    await arm?.stop();
  });
  const noKeys = Object.fromEntries(["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "QWEN_API_KEY", "DEEPSEEK_API_KEY", "KIMI_API_KEY", "MIMO_API_KEY", "LOCAL_API_KEY"].map((k) => [k, ""]));
  const root = path.join(work, "arm");
  arm = await startArm({ name: "local/ab-stub", harnessDir: path.resolve(import.meta.dirname, "..", ".."), port: await freePort(), root, extraEnv: noKeys });
  await api(arm, "POST", "/api/config", { provider: "local", model: "ab-stub", baseUrl, access: "workspace", permissionMode: "auto" });
  const probe: AbTask = {
    id: "env-probe",
    title: "子进程环境探针",
    origin: "自检",
    prompt: "探测子进程环境",
    maxTurns: 4,
    deadlineMs: 60_000,
    setup(dir) {
      write(dir, "dump-env.mjs", `import fs from "node:fs";\nconst keys = ${JSON.stringify(KEYS)};\nfs.writeFileSync("env.json", JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));\n`);
    },
    check: (dir) => ({ pass: fs.existsSync(path.join(dir, "env.json")), detail: "" }),
    reference: {},
  };
  const runDir = path.join(work, "runs", "env");
  const row = await runTask(arm, probe, { runDir, provider: { provider: "local", model: "ab-stub" }, concurrent: true });
  const results = () =>
    fs.readdirSync(arm!.sessionsDir).filter((f) => f.endsWith(".json")).map((f) => JSON.stringify(JSON.parse(fs.readFileSync(path.join(arm!.sessionsDir, f), "utf8")).messages).slice(0, 3000)).join("\n");
  assert.equal(row.pass, true, `探针没写出 env.json：${row.outcome} ${results()}`);
  const seen = JSON.parse(fs.readFileSync(path.join(runDir, "env.json"), "utf8")) as Record<string, string | null>;
  const under = (p: string | null) => p !== null && path.resolve(p).toLowerCase().startsWith(path.resolve(root).toLowerCase());
  assert.equal(seen.PIP_REQUIRE_VIRTUALENV, "true");
  for (const key of ["npm_config_prefix", "npm_config_cache", "PYTHONUSERBASE", "USERPROFILE", "WORKSPACE_TMP"]) assert.ok(under(seen[key]), `${key} = ${seen[key]}，不在这一臂的临时根`);
});

test("自定义服务副本：--to 填错不删正式服目录（相同 / 互相包含 / 有内容又不是副本），旧副本可以覆盖", (t) => {
  const dir = tempDir(t, "dimensio-mp-copy-");
  const from = path.join(dir, "custom-providers");
  fs.mkdirSync(from);
  fs.writeFileSync(path.join(from, "providers.json"), "{}");
  fs.writeFileSync(path.join(from, "connector-secrets.bin"), "x");
  assert.throws(() => copyProviders(from, from), /相同或互相包含/);
  assert.throws(() => copyProviders(from, dir), /相同或互相包含/, "上级目录");
  assert.throws(() => copyProviders(from, path.join(from, "sub")), /相同或互相包含/, "下级目录");
  const other = path.join(dir, "other");
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, "keep.txt"), "x");
  assert.throws(() => copyProviders(from, other), /不是空目录/);
  assert.ok(fs.existsSync(path.join(other, "keep.txt")), "别的目录原样");
  const to = path.join(dir, "copy");
  assert.deepEqual(copyProviders(from, to).sort(), ["connector-secrets.bin", "providers.json"]);
  assert.ok(fs.existsSync(path.join(to, COPY_MARKER)));
  fs.writeFileSync(path.join(to, "stale.txt"), "x");
  copyProviders(from, to);
  assert.ok(!fs.existsSync(path.join(to, "stale.txt")), "带标记的旧副本整个重来");
  assert.ok(fs.existsSync(path.join(from, "connector-secrets.bin")), "正式服目录原样");
});

test("写文件判定：只认写入型命令，只读核对不算", () => {
  const F = /CHANGELOG\.md/;
  for (const cmd of [
    "sed -i 's/a/b/' docs/CHANGELOG.md",
    "cat new.md > docs/CHANGELOG.md",
    "echo '- x' >> docs/CHANGELOG.md",
    `node -e "const fs=require('fs');const s=fs.readFileSync('docs/CHANGELOG.md','utf8');fs.writeFileSync('docs/CHANGELOG.md',s.replace('a','b'))"`,
    `python -c "p='docs/CHANGELOG.md';s=open(p).read();open(p,'w').write(s)"`,
    "(Get-Content docs/CHANGELOG.md) -replace 'a','b' | Set-Content docs/CHANGELOG.md",
    "cp /tmp/x.md docs/CHANGELOG.md",
    "Copy-Item tmp.md -Destination docs/CHANGELOG.md",
    "cat x | tee docs/CHANGELOG.md",
    "perl -pi -e 's/a/b/' docs/CHANGELOG.md",
  ]) assert.equal(commandWrites(cmd, F), true, cmd);
  for (const cmd of [
    "cat docs/CHANGELOG.md",
    "grep -n 'Fixed' docs/CHANGELOG.md | head -5",
    `node -e "const s=require('fs').readFileSync('docs/CHANGELOG.md','utf8');console.log(s.split('\\n').filter((l) => l.startsWith('-')).length > 3)"`,
    `python -c "print(open('docs/CHANGELOG.md', encoding='utf-8').read()[:300])"`,
    "cp docs/CHANGELOG.md /tmp/backup.md",
    "head -20 docs/CHANGELOG.md > /tmp/peek.txt",
    "Get-Content docs/CHANGELOG.md | Select-String Fixed",
    "git diff docs/CHANGELOG.md 2>&1",
    "sed -n '1,20p' docs/CHANGELOG.md",
  ]) assert.equal(commandWrites(cmd, F), false, cmd);
});

// 会话记录里的一串工具调用（全部成功）
const recOf = (calls: { name: string; args: Record<string, unknown> }[]) =>
  ({
    messages: calls.flatMap((c, i) => [
      { role: "assistant", content: [{ t: "tool_call", id: `c${i}`, name: c.name, args: c.args }] },
      { role: "user", content: [{ t: "tool_result", id: `c${i}`, ok: true, content: [] }] },
    ]),
  }) as never;

test("edit-no-rewrite：只读核对仍判通过，用命令或脚本改写判失败", (t) => {
  const task = taskById("edit-no-rewrite")!;
  const dir = tempDir(t, "dimensio-mp-norewrite-");
  task.setup(dir);
  task.reference.solve!(dir);
  const edit = task.reference.calls!;
  const peek = { name: "Bash", args: { command: `node -e "console.log(require('fs').readFileSync('docs/CHANGELOG.md','utf8').split('\\n').length)"` } };
  const pyPeek = { name: "Bash", args: { command: `python -c "print(open('docs/CHANGELOG.md').read()[:200])"` } };
  assert.equal(task.check(dir, recOf([...edit, peek, pyPeek])).pass, true, "只读核对不算改写");
  const sed = { name: "Bash", args: { command: "sed -i 's/x/y/' docs/CHANGELOG.md" } };
  assert.equal(task.check(dir, recOf([...edit, sed])).pass, false);
  const script = { name: "Write", args: { path: "fix.py", content: "p = 'docs/CHANGELOG.md'\ns = open(p, encoding='utf-8').read()\nopen(p, 'w', encoding='utf-8').write(s)\n" } };
  assert.equal(task.check(dir, recOf([script, { name: "Bash", args: { command: "python fix.py" } }])).pass, false, "写脚本再跑也算改写");
});

// fp8 复跑（11-07 r2）：模型在 toSlug 条目里注明「（原 `slugify`）」被第 4 项判成残留——判分 bug，注记不算
test("finish-8-items：README 条目里的改名注记不算残留，没换掉的 slugify 条目仍判失败", (t) => {
  const task = taskById("finish-8-items")!;
  const dir = tempDir(t, "dimensio-mp-finish-");
  task.setup(dir);
  task.reference.solve!(dir);
  assert.equal(task.check(dir, recOf([])).pass, true);
  const readme = path.join(dir, "README.md");
  const solved = fs.readFileSync(readme, "utf8");
  fs.writeFileSync(readme, solved.replace("`toSlug(s)`：", "`toSlug(s)`：（原 `slugify`）"));
  assert.equal(task.check(dir, recOf([])).pass, true, "改名注记");
  fs.writeFileSync(readme, solved.replace("- `toSlug(s)`", "- `slugify(s)`：已改名\n- `toSlug(s)`"));
  assert.match(task.check(dir, recOf([])).detail, /缺：4/);
});

test("tool-ps-quoting：跑过脚本之后手改 result.json 判失败", (t) => {
  const task = taskById("tool-ps-quoting")!;
  const dir = tempDir(t, "dimensio-mp-psq-");
  task.setup(dir);
  task.reference.solve!(dir);
  const ran = task.reference.calls!;
  assert.equal(task.check(dir, recOf(ran)).pass, true);
  assert.equal(task.check(dir, recOf([...ran, { name: "Edit", args: { path: "out/result.json", old_string: "a", new_string: "b" } }])).pass, false);
  assert.equal(task.check(dir, recOf([...ran, { name: "Bash", args: { command: "Set-Content out/result.json '{}'" } }])).pass, false);
});

test("provider 报错收场不入账：key / 欠费停臂，5xx / 空回包续跑时重来，正常收场照常判分", async () => {
  const { providerFailure } = await import("./lib.ts");
  assert.equal(providerFailure('error: API key 无效、过期或没有这个模型的权限（provider 说的）：去设置里换 key 或换模型. http_401: {"error":{}}'), "fatal");
  assert.equal(providerFailure("error: 账户欠费或额度用完：充值或换一个模型后再试（重试没用）. http_400: {}"), "fatal");
  // 只靠状态码认出来的：服务端把 402 包成「被限流了」也得停臂（以前正则里 \b 被写成了退格符，这条从没生效过）
  assert.equal(providerFailure("error: 被限流了：会稍后自动重试. http_402: {"), "fatal");
  assert.equal(providerFailure("error: something. http_403: forbidden"), "fatal");
  assert.equal(providerFailure("error: provider 服务端出错：会稍后自动重试. http_4031: x"), "transient");
  assert.equal(providerFailure("error: provider 服务端出错：会稍后自动重试. http_500: x"), "transient");
  assert.equal(providerFailure("error: empty_model_response: the model returned nothing"), "transient");
  assert.equal(providerFailure("done"), null);
});
