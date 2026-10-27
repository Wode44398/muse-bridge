// Q6（N46）：A/B 评测台的自检。不测模型聪不聪明（那要本机 GPU 跑一两个小时，走 evals/ab/run.ts，不进 npm test），
// 只证明两件事：① 陷阱本身是好的——原样现场判不通过、做完参考解判通过；② 管线是通的——起一臂真 harness（独立进程、
// 全部落盘目录在临时根），provider 指向本进程里的假 OpenAI 兼容服务（按请求序号回脚本化的 SSE，不出网），跑一个陷阱
// 任务，读会话记录判分、记账、出报表。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { type Arm, appendMeta, InfraError, readMeta, report, runKey, runTask, startArm } from "../evals/ab/lib.ts";
import { loadedSkills, SKILL_TASKS, TASKS, taskById } from "../evals/ab/tasks.ts";
import type { StreamEvent } from "./agent/events.ts";
import type { PersistedSession } from "./store.ts";
import { say, useTool } from "./test-harness/scripted-adapter.ts";
import { openaiSse } from "./test-harness/wire-fakes.ts";

const HARNESS = path.resolve(import.meta.dirname, "..");
// 这一臂看不到本机任何真 key（本来也用不上：provider 是假服务）
const NO_KEYS = Object.fromEntries(
  ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "QWEN_API_KEY", "VISION_API_KEY", "ZHIPU_API_KEY", "KIMI_API_KEY", "MOONSHOT_API_KEY", "MIMO_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "LOCAL_API_KEY"].map((k) => [k, ""]),
);

const tempDir = (t: TestContext, prefix: string): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return dir;
};
type RefCall = { name: string; args: Record<string, unknown>; ok?: boolean };
// 参考解的会话记录：做过的工具调用（默认都成功）+ 最终答复
const answerRecord = (text: string, calls: RefCall[] = []): PersistedSession =>
  ({
    messages: [
      ...(calls.length
        ? [
            { role: "assistant", content: calls.map((c, i) => ({ t: "tool_call", id: `ref${i}`, name: c.name, args: c.args })) },
            { role: "user", content: calls.map((c, i) => ({ t: "tool_result", id: `ref${i}`, ok: c.ok ?? true, content: [{ t: "text", text: "ok" }] })) },
          ]
        : []),
      { role: "assistant", content: [{ t: "text", text }] },
    ],
  }) as unknown as PersistedSession;

test("Q6 陷阱自检：每个任务原样现场判不通过、做完参考解判通过", (t) => {
  const ids = new Set<string>();
  for (const task of [...TASKS, ...SKILL_TASKS]) {
    assert.ok(!ids.has(task.id), `任务 id 重复：${task.id}`);
    ids.add(task.id);
    const dir = tempDir(t, `dimensio-ab-${task.id}-`);
    const env = { memoryDir: tempDir(t, `dimensio-ab-mem-${task.id}-`) };
    task.setup(dir);
    const before = task.check(dir, answerRecord("好了。"), env);
    assert.equal(before.pass, false, `${task.id}：什么都没做就判通过了（陷阱预先解开了）——${before.detail}`);
    task.reference.solve?.(dir);
    task.reference.memory?.(env.memoryDir);
    const after = task.check(dir, answerRecord(task.reference.answer ?? "好了。", task.reference.calls), env);
    assert.equal(after.pass, true, `${task.id}：参考解判不通过（判分过严或参考解错了）——${after.detail}`);
  }
  // C5：修前的目录只给 SKILL.md 路径，模型用 Read / Bash 读——同样算加载；失败的调用不算
  const viaRead = answerRecord("好了。", [
    { name: "Read", args: { path: "C:\\x\\extensions\\skills\\stock-analysis\\SKILL.md" } },
    { name: "Bash", args: { command: "cat /x/extensions/skills/caixin-macro/SKILL.md" } },
    { name: "Skill", args: { name: "kimi-excel" }, ok: false },
  ]);
  assert.deepEqual(loadedSkills(viaRead).sort(), ["caixin-macro", "stock-analysis"]);
});

test("Q6 A/B 起臂前先查数据路径收口：没有 server/paths.ts 的树（Q8 之前）直接拒绝，不起进程", async (t) => {
  const tree = tempDir(t, "dimensio-ab-oldtree-");
  fs.mkdirSync(path.join(tree, "server"));
  fs.writeFileSync(path.join(tree, "server", "index.ts"), "throw new Error('must not run');\n");
  await assert.rejects(
    startArm({ name: "base", harnessDir: tree, port: 1, root: path.join(tree, "arm") }),
    (e: Error) => e.message.includes("paths.ts") && !(e instanceof InfraError),
  );
  assert.equal(fs.existsSync(path.join(tree, "arm")), false, "拒绝在先：临时根都没建");
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

// 假的 OpenAI 兼容 provider：带 tools 的请求是主循环的一轮，按序号回脚本的下一步；脚本用完之后一律回一句收尾（门禁
// 追问之类多出来的轮次不让管线卡死，测试另外断言轮数）。不带 tools 的请求（旁路：摘要、标题之类）回一句话、不占步数。
async function stubProvider(t: TestContext) {
  let steps: StreamEvent[][] = [];
  const loop: any[] = [];
  const side: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => (raw += c));
    req.on("end", () => {
      if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw);
      let step: readonly StreamEvent[];
      if (Array.isArray(body.tools) && body.tools.length) {
        loop.push(body);
        step = steps[loop.length - 1] ?? say("完成。");
      } else {
        side.push(body);
        step = say("（旁路请求的回应）");
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
  const { port } = server.address() as net.AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    loop,
    side,
    script(next: StreamEvent[][]) {
      steps = next;
      loop.length = 0;
      side.length = 0;
    },
  };
}

test("Q6 A/B 管线：真 harness 进程 + 假 provider 跑陷阱任务——判分、记账、续跑键、报表", async (t) => {
  const task = taskById("large-output")!;
  const stub = await stubProvider(t);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-ab-plumbing-"));
  let arm: Arm | undefined;
  t.after(async () => {
    await arm?.stop(); // 先收尸（它还开着 server.log），再删临时根
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5 });
  });
  arm = await startArm({ name: "head", harnessDir: HARNESS, port: await freePort(), root: path.join(work, "arm-head"), extraEnv: NO_KEYS });
  const provider = { provider: "local", model: "ab-stub", baseUrl: stub.baseUrl };

  // 做对：Grep 定位 → Write 答案 → 答复收工（瘦身 P0-1：收工不再交记忆审计）
  stub.script([
    useTool("g1", "Grep", { pattern: "ERROR", path: "logs" }),
    useTool("w1", "Write", { path: "answer.txt", content: "req-q6trap\n" }),
    say("ERROR 那一行的 request id 是 req-q6trap，已写进 answer.txt。"),
  ]);
  const good = await runTask(arm, task, { runDir: path.join(work, "runs", "large-output-head-1"), provider, rep: 1 });
  assert.equal(good.pass, true, `${good.detail}\n${fs.readFileSync(arm.logFile, "utf8").slice(-2000)}`);
  assert.equal(good.outcome, "done");
  assert.equal(good.failedCalls, 0);
  assert.equal(good.toolCalls, 2, `工具调用 ${good.toolCalls}（Grep + Write；瘦身 P0-1 起收工不再多一次 MemoryAudit）`);
  assert.equal(stub.loop.length, 3, `主循环轮数 ${stub.loop.length}（多出来的是门禁追问）`);
  const firstPrompt = JSON.stringify(stub.loop[0].messages);
  assert.match(firstPrompt, /logs\/app\.log/, "provider 收到的是任务原话");
  assert.ok(fs.existsSync(path.join(arm.sessionsDir)), "会话记录落在这一臂自己的临时根里");

  // 做错：答案写错 → 判不通过，细节里带着错答案
  stub.script([
    useTool("w1", "Write", { path: "answer.txt", content: "req-wrong\n" }),
    say("写好了。"),
  ]);
  const bad = await runTask(arm, task, { runDir: path.join(work, "runs", "large-output-head-2"), provider, rep: 2 });
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /req-wrong/);

  // 记账与续跑键
  const metaFile = path.join(work, "meta.jsonl");
  appendMeta(metaFile, good);
  appendMeta(metaFile, bad);
  const rows = readMeta(metaFile);
  assert.deepEqual(rows.map(runKey), ["large-output|head|1", "large-output|head|2"]);

  // 报表：通过率 + 没通过的逐条列出
  const md = report(rows, { title: "A/B · 管线自检", arms: ["head"] });
  assert.match(md, /\| large-output \| 1\/2（50%）/);
  assert.match(md, /没通过的 run/);
  assert.match(md, /large-output · head · 第 2 次.*req-wrong/);
  assert.match(md, /## 成本（每次的均值）[\s\S]*\| large-output \| \d+k \| \d+s \|[\s\S]*\| 合计 \| \d+k \| \d+s \|/, "通过率之外还有成本一栏");
});
