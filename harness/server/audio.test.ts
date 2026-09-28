import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { sniffAudioMime, MAX_AUDIO_BYTES } from "./audio.ts";
import { readTool } from "./tools/read.ts";
import { Sandbox } from "./sandbox.ts";
import type { ToolContext } from "./tools/types.ts";
import { AgentState } from "./agent/state.ts";
import { estimateTokens } from "./agent/context.ts";
import { createAdapter } from "./providers/registry.ts";
import { storeSessionAudio, loadSessionImageBase64, deleteSessionAssets } from "./image-assets.ts";
import { createSession, startRun, dropSession } from "./session.ts";
import { loadSession, deleteSessionFile } from "./store.ts";
import type { Turn, Msg } from "./agent/turn.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-audio-"));
after(() => fs.rmSync(root, { recursive: true, force: true }));
// One second of PCM silence, valid RIFF/WAVE independent of ffmpeg installation.
const wav = Buffer.alloc(44 + 16000 * 2);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(32000, 40);
fs.writeFileSync(path.join(root, "voice.wav"), wav);
const context = (audio = true): ToolContext => ({
  sandbox: new Sandbox(root, "workspace"), readFileState: new Map(), setTodos() {},
  limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, agentSeesImages: true, agentHearsAudio: audio,
});

test("audio magic distinguishes WAV/WebP, M4A/MP4 and MP3/AAC", () => {
  assert.equal(sniffAudioMime(wav), "audio/wav");
  assert.equal(sniffAudioMime(Buffer.from("RIFF0000WEBP")), undefined);
  assert.equal(sniffAudioMime(Buffer.from("0000ftypM4A ")), "audio/mp4");
  assert.equal(sniffAudioMime(Buffer.from("0000ftypisom")), undefined);
  assert.equal(sniffAudioMime(Buffer.from("fLaC1234")), "audio/flac");
  assert.equal(sniffAudioMime(Buffer.from("OggS1234")), "audio/ogg");
  assert.equal(sniffAudioMime(Buffer.from("ID3xxx")), "audio/mpeg");
  assert.equal(sniffAudioMime(Buffer.from([0xff, 0xfb, 0x90, 0x64])), "audio/mpeg");
  assert.equal(sniffAudioMime(Buffer.from([0xff, 0xf1, 0x50, 0x80])), undefined);
});

test("Read sends exact audio bytes as native feedback without unlocking text edits", async () => {
  const ctx = context();
  const result = await readTool.run({ path: "voice.wav", question: "What sounds?" }, ctx);
  assert.equal(result.ok, true);
  const block = result.feedback?.[0];
  assert.equal(block?.t, "audio");
  if (block?.t !== "audio") throw new Error("missing native audio");
  assert.equal(block.mime, "audio/wav");
  assert.equal(block.data, wav.toString("base64"));
  assert.equal(ctx.readFileState.size, 0);
  assert.equal((await readTool.run({ path: "voice.wav" }, context(false))).ok, false);
  fs.writeFileSync(path.join(root, "bad.mp3"), "not an audio recording");
  assert.equal((await readTool.run({ path: "bad.mp3" }, ctx)).summary, "unsupported audio");
  const large = path.join(root, "large.wav");
  fs.writeFileSync(large, wav); fs.truncateSync(large, MAX_AUDIO_BYTES + 1);
  assert.equal((await readTool.run({ path: "large.wav" }, ctx)).summary, "audio too large");
});

test("audio persists once, rehydrates recursively, and survives switching to a model without audio", async () => {
  const id = "audio-asset-regression";
  const adapter = createAdapter({ provider: "mimo", model: "mimo-v2.6-pro", apiKey: "test" });
  const state = new AgentState({ adapter, system: "", tools: [], budget: { maxOutputTokens: 100 }, ctx: context(),
    toolMap: new Map(), permissionMode: "auto",
    resolveImageAsset: asset => loadSessionImageBase64(id, asset),
    storeImageAsset: b => { assert.equal(b.t, "audio"); return storeSessionAudio(id, Buffer.from(b.data!, "base64"), "audio/wav", b.name, 1); },
  });
  try {
    state.appendUserBlocks([{ t: "tool_result", id: "read", ok: true, content: [{ t: "audio", mime: "audio/wav", data: wav.toString("base64"), name: "voice.wav", durationSeconds: 1 }] }]);
    assert.ok(!JSON.stringify(state.messages).includes(wav.toString("base64")));
    assert.match(JSON.stringify(state.messages), /[a-f0-9]{64}\.wav/);
    assert.ok(JSON.stringify(state.materializeMessages(state.messages)).includes(wav.toString("base64")));
    adapter.capabilities.audio = false;
    const textOnly = JSON.stringify(state.materializeMessages(state.messages));
    assert.match(textOnly, /takes no audio input/);
    assert.ok(!textOnly.includes(wav.toString("base64")));
    adapter.capabilities.audio = true;
    assert.ok(JSON.stringify(state.materializeMessages(state.messages)).includes(wav.toString("base64")));
  } finally { await deleteSessionAssets(id); }
});

test("audio token estimate follows duration and never counts base64 characters", () => {
  const messages: Msg[] = [{ role: "user", content: [{ t: "audio", mime: "audio/wav", durationSeconds: 100, data: "A".repeat(100_000) }] }];
  assert.equal(estimateTokens("", messages), 625 + 64);
});

test("attachment runs persist audio and reject unsupported models or excessive batches before sending", async () => {
  const session = createSession();
  const ctx = context();
  let received: Turn | undefined;
  const adapter = createAdapter({ provider: "mimo", model: "mimo-v2.6-flash", apiKey: "test" });
  adapter.stream = async function* (turn) { received = turn; yield { e: "text_delta", text: "heard" }; yield { e: "turn_done", stopReason: "end" }; };
  session.state = new AgentState({ adapter, system: "", tools: [], budget: { maxOutputTokens: 100 }, ctx,
    toolMap: new Map(), permissionMode: "auto", memoryAuditRequired: false,
    resolveImageAsset: asset => loadSessionImageBase64(session.id, asset),
  });
  session.cfg = { provider: "mimo", model: adapter.model, thinking: "off", permissionMode: "auto", workspace: root, access: "workspace" };
  const checkpoint = process.env.CHECKPOINTS; process.env.CHECKPOINTS = "off";
  try {
    ctx.agentHearsAudio = false;
    assert.throws(() => startRun(session, "", undefined, ["voice.wav"]), /不支持原生音频/);
    ctx.agentHearsAudio = true;
    assert.throws(() => startRun(session, "", undefined, ["large.wav"]), /24 MB/);
    for (const name of ["batch1.wav", "batch2.wav"]) {
      const file = path.join(root, name); fs.writeFileSync(file, wav); fs.truncateSync(file, 17 * 1024 * 1024);
    }
    assert.throws(() => startRun(session, "", undefined, ["batch1.wav", "batch2.wav"]), /32 MB/);
    assert.equal(session.state.messages.length, 0);
    await startRun(session, "Listen", { maxTurns: 1 }, ["voice.wav"]).done;
    assert.ok(received?.messages[0].content.some(b => b.t === "audio" && b.data === wav.toString("base64")));
    const saved = await loadSession(session.id);
    assert.deepEqual(saved?.messages[0].attachments, [{ path: "voice.wav", kind: "audio" }]);
    assert.ok(saved?.messages[0].content.some(b => b.t === "audio" && b.asset && !b.data));
  } finally {
    if (checkpoint === undefined) delete process.env.CHECKPOINTS; else process.env.CHECKPOINTS = checkpoint;
    dropSession(session.id); await deleteSessionFile(session.id); await deleteSessionAssets(session.id);
  }
});
