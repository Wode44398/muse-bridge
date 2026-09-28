// Tool feedback fidelity. Every case here is a false report the 2026-08-16 k3
// run actually paid for: an Edit refused because the model's own script had
// touched the file (5 times, 3 of which it fixed by re-issuing the same Edit),
// and Chinese output shredded at a pipe chunk boundary. The binary guard is the
// same class of defect found while reading that transcript — Read handed a
// video back as mojibake instead of refusing. Each test fails before its fix.
import assert from "node:assert/strict";
import test, { after } from "node:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bashTool, childEnv } from "./tools/bash.ts";
import { editTool } from "./tools/edit.ts";
import { readTool } from "./tools/read.ts";
import { writeTool } from "./tools/write.ts";
import { Sandbox } from "./sandbox.ts";
import { AgentState } from "./agent/state.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import type { ToolContext, ToolRunResult } from "./tools/types.ts";

const roots: string[] = [];
function temp(prefix: string): string {
  const root = mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

after(() => {
  while (roots.length) {
    try {
      rmSync(roots.pop()!, { recursive: true, force: true });
    } catch {
      /* the OS will reap it */
    }
  }
});

function ctxFor(root: string): ToolContext {
  return {
    sandbox: new Sandbox(root, "workspace"),
    readFileState: new Map(),
    setTodos: () => {},
    limits: { bashTimeoutMs: 30_000, bashMaxTimeoutMs: 60_000 },
    agentSeesImages: false,
  };
}

const body = (result: ToolRunResult): string =>
  result.content.map((block) => (block.t === "text" ? block.text : "")).join("\n");

const SOURCE = 'int version = 1;\nString name = "old";\n';

test("an external write costs no re-Read while old_string still matches uniquely", async () => {
  const root = temp("dimensio-edit-changed-");
  const file = path.join(root, "App.java");
  writeFileSync(file, SOURCE, "utf8");
  const ctx = ctxFor(root);
  assert.equal((await readTool.run({ path: "App.java" }, ctx)).ok, true);

  // What `sed -i`/a python one-liner does behind the Edit tool's back.
  writeFileSync(file, SOURCE.replace("version = 1", "version = 2"), "utf8");

  const applied = await editTool.run(
    { path: "App.java", old_string: 'String name = "old";', new_string: 'String name = "new";' },
    ctx,
  );
  assert.equal(applied.ok, true);
  assert.match(body(applied), /changed on disk/);
  // Both survive: the outside change is not clobbered, the edit lands on top.
  assert.equal(readFileSync(file, "utf8"), 'int version = 2;\nString name = "new";\n');
});

test("an external write that voids old_string still refuses, and says the file moved", async () => {
  const root = temp("dimensio-edit-voided-");
  const file = path.join(root, "App.java");
  writeFileSync(file, SOURCE, "utf8");
  const ctx = ctxFor(root);
  assert.equal((await readTool.run({ path: "App.java" }, ctx)).ok, true);

  writeFileSync(file, 'int version = 2;\nString label = "gone";\n', "utf8");
  const refused = await editTool.run(
    { path: "App.java", old_string: 'String name = "old";', new_string: 'String name = "new";' },
    ctx,
  );
  assert.equal(refused.ok, false);
  assert.match(body(refused), /changed on disk/);
  assert.equal(readFileSync(file, "utf8"), 'int version = 2;\nString label = "gone";\n');
});

test("editing over an external change does not carry the old full-read coverage into Write", async () => {
  const root = temp("dimensio-edit-coverage-");
  const file = path.join(root, "App.java");
  writeFileSync(file, SOURCE, "utf8");
  const ctx = ctxFor(root);
  assert.equal((await readTool.run({ path: "App.java" }, ctx)).ok, true);

  writeFileSync(file, `${SOURCE}// appended by another writer\n`, "utf8");
  assert.equal(
    (await editTool.run(
      { path: "App.java", old_string: 'String name = "old";', new_string: 'String name = "new";' },
      ctx,
    )).ok,
    true,
  );

  // The appended line was never read, so a blind whole-file overwrite stays shut.
  const blocked = await writeTool.run({ path: "App.java", content: "replacement" }, ctx);
  assert.equal(blocked.ok, false);
  assert.match(blocked.summary, /not fully read/);
  assert.match(readFileSync(file, "utf8"), /appended by another writer/);
});

test("Read refuses a binary file instead of returning mojibake", async () => {
  const root = temp("dimensio-read-binary-");
  // A zip/apk header: PK signature then NULs. (An mp4 is binary too, but it now
  // has its own path — see the video tests below.)
  const apk = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]),
    Buffer.alloc(4096, 0x41),
  ]);
  writeFileSync(path.join(root, "app.apk"), apk);

  const result = await readTool.run({ path: "app.apk" }, ctxFor(root));
  assert.equal(result.ok, false);
  assert.match(result.summary, /binary/);
  assert.match(body(result), /unzip|xxd/);
});

test("multi-byte command output survives the pipe chunk boundary", async () => {
  const root = temp("dimensio-bash-utf8-");
  // ~84 KB of 3-byte characters (U+4E2D), built without putting one in the
  // command line itself — whatever size the pipe hands over, some chunk boundary
  // lands mid-character. Decoding each chunk on its own turns that into U+FFFD.
  const count = 28_000;
  const result = await bashTool.run(
    { command: `node -e "process.stdout.write(String.fromCharCode(20013).repeat(${count}))"` },
    ctxFor(root),
  );
  assert.equal(result.ok, true, body(result));
  const text = body(result);
  assert.equal(text.includes("�"), false);
  assert.equal((text.match(/中/g) ?? []).length, count);
});

// A JVM on Windows writes GBK to a pipe and reads source as GBK; forcing UTF-8
// costs a "Picked up JAVA_TOOL_OPTIONS" line on every single java call, so the
// capture drops exactly that line back out.
const javaOnPath = spawnSync("java", ["-version"], { windowsHide: true }).status === 0;

test("child processes get a UTF-8 JVM and a scratch dir both shells resolve alike", () => {
  const env = childEnv();
  assert.match(String(env.JAVA_TOOL_OPTIONS), /stdout\.encoding=UTF-8/);
  const scratch = String(env.WORKSPACE_TMP ?? "");
  assert.ok(scratch.length > 0);
  assert.equal(existsSync(scratch), true);
  // Forward slashes only: git-bash and native Windows programs must read it the same.
  assert.equal(scratch.includes(String.fromCharCode(92)), false);
});

test("our own JAVA_TOOL_OPTIONS announcement never reaches the transcript", async () => {
  const root = temp("dimensio-java-pickup-");
  const result = await bashTool.run(
    { command: 'echo "Picked up JAVA_TOOL_OPTIONS: $JAVA_TOOL_OPTIONS"; echo real-output' },
    ctxFor(root),
  );
  assert.equal(result.ok, true, body(result));
  assert.match(body(result), /real-output/);
  assert.doesNotMatch(body(result), /Picked up JAVA_TOOL_OPTIONS: -Dfile/);
});

test("Java output arrives as UTF-8, not GBK", { skip: javaOnPath ? false : "no JDK on PATH" }, async () => {
  const root = temp("dimensio-java-utf8-");
  writeFileSync(
    path.join(root, "Hi.java"),
    'public class Hi { public static void main(String[] a){ System.out.println("中文测试 ok"); } }\n',
    "utf8",
  );
  const result = await bashTool.run({ command: "java Hi.java" }, ctxFor(root));
  assert.equal(result.ok, true, body(result));
  assert.match(body(result), /中文测试 ok/);
  assert.doesNotMatch(body(result), /Picked up JAVA_TOOL_OPTIONS: -Dfile/);
});

// Video input. The probe clip is three one-second solid colours, so a single
// frame can never account for the whole thing — the same clip shape that proved
// Kimi k3 really ingests the timeline (it answered "red green blue" and named
// the sampled timestamps).
const ffmpegOnPath = spawnSync("ffmpeg", ["-version"], { windowsHide: true }).status === 0;

function probeClip(root: string): string {
  const out = path.join(root, "probe.mp4");
  const made = spawnSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "color=c=red:s=128x128:d=1:r=8",
    "-f", "lavfi", "-i", "color=c=green:s=128x128:d=1:r=8",
    "-f", "lavfi", "-i", "color=c=blue:s=128x128:d=1:r=8",
    "-filter_complex", "[0:v][1:v][2:v]concat=n=3:v=1[out]",
    "-map", "[out]", "-pix_fmt", "yuv420p", "-y", out,
  ], { windowsHide: true, timeout: 60_000 });
  assert.equal(made.status, 0, String(made.stderr));
  return out;
}

test("a video model gets the file itself", { skip: ffmpegOnPath ? false : "no ffmpeg" }, async () => {
  const root = temp("dimensio-video-native-");
  probeClip(root);
  const ctx = { ...ctxFor(root), agentSeesImages: true, agentSeesVideo: true };

  const result = await readTool.run({ path: "probe.mp4", question: "what colours?" }, ctx);
  assert.equal(result.ok, true, body(result));
  const media = (result.feedback ?? []).filter((block) => block.t === "video");
  assert.equal(media.length, 1);
  assert.equal(media[0].t === "video" && media[0].mime, "video/mp4");
  assert.match(body(result), /what colours\?/);
});

test("a model without video gets evenly spaced frames instead", { skip: ffmpegOnPath ? false : "no ffmpeg" }, async () => {
  const root = temp("dimensio-video-frames-");
  probeClip(root);
  const ctx = { ...ctxFor(root), agentSeesImages: true, agentSeesVideo: false };

  const result = await readTool.run({ path: "probe.mp4", limit: 3 }, ctx);
  assert.equal(result.ok, true, body(result));
  const frames = (result.feedback ?? []).filter((block) => block.t === "image");
  assert.equal(frames.length, 3);
  // Timestamps must be carried, or the model cannot say WHEN something happened.
  const labels = (result.feedback ?? []).filter((b) => b.t === "text").map((b) => (b.t === "text" ? b.text : ""));
  assert.deepEqual(labels, ["Frame at 00:01", "Frame at 00:02", "Frame at 00:03"]);
  assert.match(body(result), /sampled into 3 frames/);
});

test("a container we cannot decode is named, not silently treated as text", async () => {
  const root = temp("dimensio-video-bad-");
  writeFileSync(path.join(root, "clip.avi"), Buffer.alloc(2048, 0x41));
  const result = await readTool.run({ path: "clip.avi" }, ctxFor(root));
  assert.equal(result.ok, false);
  assert.match(result.summary, /unsupported video/);
  assert.match(body(result), /ffmpeg -i/);
});

test("a video already in the transcript degrades to a note when the model cannot read it", () => {
  // Switching mid-session from a video model to a text/image one must not make
  // the attachment vanish silently — the turns around it still talk about it.
  const root = temp("dimensio-video-switch-");
  const adapter: ProviderAdapter = {
    id: "anthropic",
    model: "claude-fake",
    capabilities: {
      contextWindow: 100_000,
      maxOutputTokens: 1000,
      thinking: false,
      image: true,
      video: false,
      cache: false,
      parallelToolCalls: false,
    },
    async *stream() { /* not exercised */ },
  };
  const state = new AgentState({
    adapter,
    system: "test",
    tools: [],
    budget: { maxOutputTokens: 1000, thinking: "off" },
    ctx: ctxFor(root),
    toolMap: new Map(),
    permissionMode: "auto",
  });

  const [message] = state.materializeMessages([
    { role: "user", content: [{ t: "video", mime: "video/mp4", data: "AAAA", name: "screen.mp4" }] },
  ]);
  const block = message.content[0];
  assert.equal(block.t, "text");
  assert.match(block.t === "text" ? block.text : "", /screen\.mp4/);
  assert.match(block.t === "text" ? block.text : "", /claude-fake/);
  assert.match(block.t === "text" ? block.text : "", /frames/);
});
