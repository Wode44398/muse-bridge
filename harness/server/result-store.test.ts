// R13（B1）：大结果落盘——截断之前把全文（先脱敏）存进会话的 outputs 目录，截断提示里写明在哪、怎么读；微压缩清掉的旧输出
// 也先存一份，占位里给路径。以前 Bash 的中段、WebFetch 6 万字之后的内容、微压缩清掉的输出都永久丢失，只能重跑。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureContextFits } from "./agent/context.ts";
import type { Msg } from "./agent/turn.ts";
import { Sandbox } from "./sandbox.ts";
import { deleteSession } from "./session.ts";
import { scripted } from "./test-harness/scripted-adapter.ts";
import { loopState } from "./test-harness/trajectory.ts";
import { bashTool } from "./tools/bash.ts";
import { deleteSessionOutputs, outputsDir, persistOutput } from "./tools/result-store.ts";
import type { ToolContext } from "./tools/types.ts";
import { webfetchTool as webFetchTool } from "./tools/webfetch.ts";

const FAKE_TOKEN = "sk-ant-FAKEFAKEFAKEFAKEFAKEFAKE0123456789";
const textOf = (r: { content?: { t: string; text?: string }[] }) => (r.content ?? []).map((b) => b.text ?? "").join("");
const savedPath = (text: string) => /saved at (\S+) — Read it/.exec(text)?.[1];

function ctxFor(t: test.TestContext, ownerId?: string): ToolContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-r13-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    sandbox: new Sandbox(root, "workspace"),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 60_000, bashMaxTimeoutMs: 60_000 },
    agentSeesImages: false,
    ownerId,
  };
}

// 约 6 万字的输出，中段（第 1000 行）带一个假令牌
const BIG = `node -e "for(let i=0;i<2000;i++){console.log('line '+i+' '+'x'.repeat(20)+(i===1000?' ${FAKE_TOKEN}':''))}"`;

test("R13 Bash 输出超过截断线：全文先脱敏再落盘，截断提示里写明路径；中段在文件里找得到", { timeout: 60_000 }, async (t) => {
  const id = "r13-bash-sync";
  t.after(() => deleteSessionOutputs(id));
  const r = await bashTool.run({ command: BIG }, ctxFor(t, id));
  assert.ok(r.ok, r.summary);
  const text = textOf(r);
  assert.match(text, /chars omitted — the full output \(\d+ chars\) is saved at /);
  assert.doesNotMatch(text, /line 1000 /, "中段照旧不在上下文里");
  const file = savedPath(text)!;
  assert.ok(file && file.startsWith(outputsDir(id)), `落在会话的 outputs 目录：${file}`);
  const saved = fs.readFileSync(file, "utf8");
  assert.match(saved, /^line 0 x+$/m);
  assert.match(saved, /^line 1000 x+ \[REDACTED:TOKEN\]$/m, "中段在，而且先脱了敏");
  assert.match(saved, /^line 1999 x+$/m);
  assert.equal(saved.includes(FAKE_TOKEN), false, "盘上没有原样的令牌");

  const small = await bashTool.run({ command: "echo hi" }, ctxFor(t, id));
  assert.doesNotMatch(textOf(small), /saved at/, "没超线的不落盘");
  const noSession = await bashTool.run({ command: BIG }, ctxFor(t));
  assert.match(textOf(noSession), /chars omitted\]…/, "没有会话（子进程测试等）照旧只截断");
});

test("R13 后台 Bash job 同样落盘：poll 到完成时文件已经齐了", { timeout: 60_000 }, async (t) => {
  const id = "r13-bash-job";
  t.after(() => deleteSessionOutputs(id));
  const ctx = ctxFor(t, id);
  const started = await bashTool.run({ command: BIG, background: true }, ctx);
  const job = /job\d+/.exec(textOf(started))?.[0];
  assert.ok(job, textOf(started));
  let text = textOf(started);
  const deadline = Date.now() + 45_000;
  while (!/\[exit 0\]|exited|\(exit 0\)/.test(text) || /still running/.test(text)) {
    if (Date.now() > deadline) assert.fail(`job never finished: ${text.slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 300));
    text = textOf(await bashTool.run({ poll: job }, ctx));
  }
  const file = savedPath(text)!;
  assert.ok(file, text.slice(0, 400));
  const saved = fs.readFileSync(file, "utf8");
  assert.match(saved, /^line 1000 x+ \[REDACTED:TOKEN\]$/m);
  assert.match(saved, /^line 1999 x+$/m, "完成时文件是齐的");
});

async function serve(body: string): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/doc.txt`, close: () => new Promise((r) => server.close(() => r())) };
}

test("R13 WebFetch 超过 6 万字：全文（已脱敏）落盘，截断提示里给路径", { timeout: 30_000 }, async (t) => {
  const id = "r13-webfetch";
  t.after(() => deleteSessionOutputs(id));
  const body = Array.from({ length: 4_000 }, (_, i) => `para ${i} ${"y".repeat(20)}${i === 3_500 ? ` ${FAKE_TOKEN}` : ""}`).join("\n");
  const site = await serve(body);
  t.after(() => site.close());
  const r = await webFetchTool.run({ url: site.url }, ctxFor(t, id));
  assert.ok(r.ok, r.summary);
  const text = textOf(r);
  assert.match(text, /content truncated — the full output \(\d+ chars\) is saved at /);
  assert.doesNotMatch(text, /para 3500 /);
  const saved = fs.readFileSync(savedPath(text)!, "utf8");
  assert.match(saved, /^para 3500 y+ \[REDACTED:TOKEN\]$/m);
  assert.match(saved, /^para 3999 y+$/m);
});

test("R13 微压缩清掉的旧输出先存一份，占位里给路径与「### [tool_result id]」头；没接存储照旧老占位", async (t) => {
  const messages = (): Msg[] => {
    const out: Msg[] = [{ role: "user", content: [{ t: "text", text: "task" }] }, { role: "assistant", content: [{ t: "text", text: "ok" }] }];
    for (const id of ["a", "b", "c"]) {
      out.push({ role: "assistant", content: [{ t: "tool_call", id, name: "Bash", args: { command: `run ${id}` } }] });
      out.push({ role: "user", content: [{ t: "tool_result", id, ok: id !== "b", content: [{ t: "text", text: `${id}:` + "o".repeat(8_000) }] }] });
    }
    for (let i = 0; i < 72; i++) out.push({ role: "user", content: [{ t: "text", text: `q${i}` }] }, { role: "assistant", content: [{ t: "text", text: "r".repeat(1_200) }] });
    return out;
  };
  let saved = "";
  const archive = { plan: () => [], write: async () => {}, saveElided: (text: string) => ((saved = text), "/out/elided-1.txt") };
  const { state } = loopState(t, scripted(t, { capabilities: { contextWindow: 40_000 } }), { memoryAudit: false, compactionArchive: archive });
  state.messages = messages();
  assert.equal((await ensureContextFits(state)).compacted, true);
  const placeholder = JSON.stringify(state.messages);
  assert.match(placeholder, /saved under \\"### \[tool_result a\]\\" in \/out\/elided-1\.txt/);
  assert.match(saved, /### \[tool_result a\] Bash ok\na:o{8000}\n/);
  assert.match(saved, /### \[tool_result b\] Bash FAILED\nb:o{8000}/);

  const bare = loopState(t, scripted(t, { capabilities: { contextWindow: 40_000 } }), { memoryAudit: false }).state;
  bare.messages = messages();
  await ensureContextFits(bare);
  assert.match(JSON.stringify(bare.messages), /re-run the tool if you need it again/);
});

test("R13 落盘目录：沙箱只对本会话开只读；persistOutput 没有会话不写；删会话一并删", async (t) => {
  const id = "r13-store";
  const file = persistOutput(id, "bash", "hello")!;
  assert.ok(file.startsWith(outputsDir(id)) && fs.readFileSync(file, "utf8") === "hello");
  assert.equal(persistOutput(undefined, "bash", "x"), null);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-r13-sb-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sandbox = new Sandbox(root, "workspace");
  sandbox.setExtraReadDirs([outputsDir(id)]);
  assert.equal(sandbox.resolve(file), file);
  assert.throws(() => sandbox.resolve(file, { forWrite: true }), /escapes the sandbox/);
  await deleteSession(id);
  assert.equal(fs.existsSync(outputsDir(id)), false);
});
