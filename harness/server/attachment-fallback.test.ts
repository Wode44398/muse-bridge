// 11-14 维护者：拖进对话的文件，型号收不了原生媒体时「至少也能把文件本身给模型发过去，而不是拒绝引用」；
// 一些特殊类型（GIF/HEIC/BMP、AVI/MKV/WMV、WMA/AAC……）也一样拖不进去。
// 修前：prepareUserInput 对这些一律 throw，整条消息发不出去；上传端 express.raw 30 MB 封顶，大文件直接「上传失败」。
// 修后：原生发不了的照样作为工作区路径交给模型，附一句原因和处理办法；超过 10 张的图只把前 10 张内联；上传流式落盘。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test, { after } from "node:test";
import { AgentState } from "./agent/state.ts";
import type { Turn } from "./agent/turn.ts";
import { saveUpload } from "./files.ts";
import { deleteSessionAssets, loadSessionImageBase64 } from "./image-assets.ts";
import { createAdapter } from "./providers/registry.ts";
import { Sandbox } from "./sandbox.ts";
import { createSession, dropSession, startRun } from "./session.ts";
import { deleteSessionFile } from "./store.ts";
import type { ToolContext } from "./tools/types.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-attach-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);

async function runWith(files: string[], opts: { images?: boolean } = {}): Promise<Turn> {
  const session = createSession();
  const ctx: ToolContext = {
    sandbox: new Sandbox(root, "workspace"), readFileState: new Map(), setTodos() {},
    limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: opts.images ?? true, agentHearsAudio: false,
  };
  let received: Turn | undefined;
  const adapter = createAdapter({ provider: "mimo", model: "mimo-v2.6-flash", apiKey: "test" });
  adapter.stream = async function* (turn) { received = turn; yield { e: "text_delta", text: "ok" }; yield { e: "turn_done", stopReason: "end" }; };
  session.state = new AgentState({ adapter, system: "", tools: [], budget: { maxOutputTokens: 100 }, ctx,
    toolMap: new Map(), permissionMode: "auto", memoryAuditRequired: false,
    resolveImageAsset: (asset) => loadSessionImageBase64(session.id, asset),
  });
  session.cfg = { provider: "mimo", model: adapter.model, thinking: "off", permissionMode: "auto", workspace: root, access: "workspace" };
  const checkpoint = process.env.CHECKPOINTS;
  process.env.CHECKPOINTS = "off";
  try {
    await startRun(session, "看看这些", { maxTurns: 1 }, files).done;
  } finally {
    process.env.CHECKPOINTS = checkpoint as string;
    if (checkpoint === undefined) delete process.env.CHECKPOINTS;
    dropSession(session.id);
    await deleteSessionFile(session.id);
    await deleteSessionAssets(session.id);
  }
  assert.ok(received, "the message must reach the model instead of being refused");
  return received!;
}
// 附件说明在用户那条消息里（harness 之后可能按文件名再追加一条 playbook，所以别只看最后一条）
const userBlocks = (turn: Turn) => turn.messages.filter((m) => m.role === "user").flatMap((m) => m.content);
const textOf = (turn: Turn) => userBlocks(turn).map((b) => (b.t === "text" ? b.text : `[${b.t}]`)).join("\n");
const countOf = (turn: Turn, t: string) => userBlocks(turn).filter((b) => b.t === t).length;

test("formats that cannot go in natively (GIF, AVI, WMA) are handed over as file paths with a reason", async () => {
  fs.writeFileSync(path.join(root, "anim.gif"), Buffer.from("GIF89a....."));
  fs.writeFileSync(path.join(root, "clip.avi"), Buffer.from("RIFF0000AVI LIST"));
  fs.writeFileSync(path.join(root, "memo.wma"), Buffer.from("not really an asf container"));
  fs.writeFileSync(path.join(root, "setup.exe"), Buffer.from([0x4d, 0x5a, 0, 0, 0]));
  const turn = await runWith(["anim.gif", "clip.avi", "memo.wma", "setup.exe"]);
  const text = textOf(turn);
  assert.match(text, /\[Attached workspace resources/);
  assert.match(text, /- anim\.gif \(image in a format Read cannot show/);
  assert.match(text, /- clip\.avi \(video in a container that cannot be sent natively/);
  assert.match(text, /- memo\.wma \(audio in a format that cannot be sent natively/);
  assert.match(text, /- setup\.exe$/m);
});

test("more than 10 images: the first 10 go inline, the rest still reach the model as paths", async () => {
  const names = Array.from({ length: 12 }, (_, i) => `shot-${i}.png`);
  for (const n of names) fs.writeFileSync(path.join(root, n), png);
  const turn = await runWith(names);
  assert.equal(countOf(turn, "image"), 10);
  assert.match(textOf(turn), /- shot-10\.png \(image, not attached inline because only the first 10 images/);
  assert.match(textOf(turn), /- shot-11\.png \(image, not attached inline/);
});

test("an image over the inline limit is listed for Read instead of refusing the message", async () => {
  const big = path.join(root, "huge.png");
  fs.writeFileSync(big, png);
  fs.truncateSync(big, 9 * 1024 * 1024);
  const turn = await runWith(["huge.png"]);
  assert.equal(countOf(turn, "image"), 0);
  assert.match(textOf(turn), /- huge\.png \(image, not attached inline because it is larger than the 8 MB/);
});

test("uploads stream to disk: no 30 MB ceiling, and no half-written file is left behind on failure", async () => {
  const sandbox = new Sandbox(root, "workspace");
  const size = 40 * 1024 * 1024;
  const chunk = Buffer.alloc(1024 * 1024, 7);
  const body = Readable.from((function* () { for (let i = 0; i < size / chunk.length; i++) yield chunk; })());
  const saved = await saveUpload(sandbox, ".dimensio/uploads/sess-big1/recording.m4a", body);
  assert.equal(saved.size, size);
  assert.equal(fs.statSync(path.join(root, saved.path)).size, size);

  const broken = new Readable({ read() { this.destroy(new Error("client went away")); } });
  await assert.rejects(saveUpload(sandbox, ".dimensio/uploads/sess-big1/cut.mp4", broken), /client went away/);
  const left = fs.readdirSync(path.join(root, ".dimensio/uploads/sess-big1"));
  assert.deepEqual(left.filter((n) => n !== ".gitignore").sort(), ["recording.m4a"]);
});
