import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG, clampEffort, defaultEffort } from "./catalog.ts";
import { getConfig, setConfig } from "./config.ts";
import { createAdapter } from "./providers/registry.ts";
import { storeSessionImage, storeSessionVideo, storeSessionAudio, loadSessionImageBase64, deleteSessionAssets } from "./image-assets.ts";
import type { Turn } from "./agent/turn.ts";

test("MiMo models expose native media and a binary thinking switch; non-off effort stays enabled", () => {
  const spec = CATALOG.find((p) => p.id === "mimo")!;
  assert.equal(spec.defaultModel, "mimo-v2.6-pro");
  assert.deepEqual(spec.models.map((m) => m.id), ["mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed", "mimo-v2.6-flash"]);
  for (const model of spec.models) {
    const adapter = createAdapter({ provider: "mimo", model: model.id, apiKey: "test" });
    assert.equal(adapter.capabilities.image, true);
    assert.equal(adapter.capabilities.video, true);
    assert.equal(adapter.capabilities.audio, true);
    assert.equal(adapter.capabilities.contextWindow, 1_000_000);
    assert.equal(adapter.capabilities.maxOutputTokens, 131_072);
    assert.deepEqual(model.efforts, ["off", "high"]);
    for (const level of ["off", "low", "medium", "high", "max"] as const) {
      assert.equal(clampEffort("mimo", model.id, level), level === "off" ? "off" : "high");
    }
    assert.equal(defaultEffort("mimo", model.id), "high");
  }
});

test("MiMo credentials select the correct endpoint without resetting a selected model", () => {
  const saved = getConfig();
  const savedUrl = process.env.MIMO_BASE_URL;
  delete process.env.MIMO_BASE_URL;
  try {
    const cn = setConfig({ provider: "mimo", apiKey: "tp-test" });
    assert.equal(cn.baseUrl, "https://token-plan-cn.xiaomimimo.com/v1");
    assert.equal(cn.thinking, "high");
    setConfig({ model: "mimo-v2.6-flash", thinking: "low" });
    const paid = setConfig({ apiKey: "sk-test" });
    assert.equal(paid.baseUrl, "https://api.xiaomimimo.com/v1");
    assert.equal(paid.model, "mimo-v2.6-flash");
    assert.equal(paid.thinking, "high");
    const custom = "https://token-plan-sgp.xiaomimimo.com/v1";
    process.env.MIMO_BASE_URL = custom;
    assert.equal(setConfig({ provider: "mimo", apiKey: "tp-test" }).baseUrl, custom);
    assert.equal(setConfig({ provider: "mimo", baseUrl: "https://custom.test/v1" }).baseUrl, "https://custom.test/v1");
  } finally {
    if (savedUrl === undefined) delete process.env.MIMO_BASE_URL;
    else process.env.MIMO_BASE_URL = savedUrl;
    setConfig(saved);
  }
});

test("MiMo streams tool arguments and replays reasoning, results and native media from session assets", async () => {
  const savedFetch = globalThis.fetch;
  const sessionId = "mimo-wire-test";
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const videoBytes = Buffer.from("0000ftypisom-test");
  const image = storeSessionImage(sessionId, imageBytes, "image/png");
  const video = storeSessionVideo(sessionId, videoBytes, "video/mp4");
  const audioBytes = Buffer.from("RIFF0000WAVE-test");
  const audio = storeSessionAudio(sessionId, audioBytes, "audio/wav");
  assert.ok(image.asset && video.asset && audio.asset);
  assert.equal(audio.data, undefined);
  assert.equal(image.data, undefined);
  assert.equal(video.data, undefined);
  const requests: any[] = [];
  globalThis.fetch = (async (url: any, init: any) => {
    requests.push({ url, body: JSON.parse(init.body), headers: init.headers });
    return new Response([
      { choices: [{ delta: { reasoning_content: "inspect media" } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "call-1", function: { name: "Read", arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"probe.txt"}' } }] }, finish_reason: "tool_calls" }] },
      { choices: [], usage: { prompt_tokens: 99, completion_tokens: 21 } },
      "[DONE]",
    ].map((e) => `data: ${typeof e === "string" ? e : JSON.stringify(e)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    for (const model of ["mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed", "mimo-v2.6-flash"]) {
      const adapter = createAdapter({ provider: "mimo", model, apiKey: "tp-test", baseUrl: "https://mimo.test/v1", thinking: true });
      for (const thinking of ["off", "high"] as const) {
        const turn: Turn = {
          system: "inspect media",
          messages: [
            { role: "user", content: [
              { ...image, data: loadSessionImageBase64(sessionId, image.asset!) },
              { ...video, data: loadSessionImageBase64(sessionId, video.asset!) },
              { ...audio, data: loadSessionImageBase64(sessionId, audio.asset!) },
            ] },
            { role: "assistant", content: [{ t: "thinking", text: "full reasoning\nwith spacing" }, { t: "tool_call", id: "prev", name: "Read", args: { path: "probe.txt" } }] },
            { role: "user", content: [{ t: "tool_result", id: "prev", ok: true, content: [{ t: "text", text: "nonce" }] }] },
          ],
          tools: [{ name: "Read", description: "read", parameters: { type: "object", properties: { path: { type: "string" } } } }],
          budget: { maxOutputTokens: 2048, thinking },
        };
        const events = await Array.fromAsync(adapter.stream(turn));
        const { url, body, headers } = requests.at(-1);
        assert.equal(url, "https://mimo.test/v1/chat/completions");
        assert.equal(headers.authorization, "Bearer tp-test");
        assert.deepEqual(body.thinking, { type: thinking === "off" ? "disabled" : "enabled" });
        assert.equal(body.reasoning_effort, undefined);
        assert.equal(body.temperature, undefined);
        assert.equal(body.max_tokens, undefined);
        assert.equal(body.max_completion_tokens, 2048);
        assert.deepEqual(body.messages[1].content, [
          { type: "image_url", image_url: { url: `data:image/png;base64,${imageBytes.toString("base64")}` } },
          { type: "video_url", video_url: { url: `data:video/mp4;base64,${videoBytes.toString("base64")}` } },
          { type: "input_audio", input_audio: { data: `data:audio/wav;base64,${audioBytes.toString("base64")}` } },
        ]);
        assert.equal(body.messages[2].reasoning_content, "full reasoning\nwith spacing");
        assert.deepEqual(body.messages[3], { role: "tool", tool_call_id: "prev", content: "nonce" });
        assert.ok(!JSON.stringify(body).includes(image.asset!));
        assert.deepEqual(events.find((e) => e.e === "tool_call"), { e: "tool_call", id: "call-1", name: "Read", args: { path: "probe.txt" } });
        assert.deepEqual(events.find((e) => e.e === "usage"), { e: "usage", inputTokens: 99, outputTokens: 21 });
        assert.deepEqual(events.at(-1), { e: "turn_done", stopReason: "tool_use" });
      }
    }
  } finally {
    globalThis.fetch = savedFetch;
    await deleteSessionAssets(sessionId);
  }
});

test("UltraSpeed permission errors are actionable and never silently substitute Pro", async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = (async (_url: any, init: any) => {
    assert.equal(JSON.parse(init.body).model, "mimo-v2.6-pro-ultraspeed");
    return new Response(JSON.stringify({ error: { message: "Not supported model mimo-v2.6-pro-ultraspeed" } }), { status: 400 });
  }) as typeof fetch;
  try {
    const adapter = createAdapter({ provider: "mimo", model: "mimo-v2.6-pro-ultraspeed", apiKey: "tp-test" });
    const events = await Array.fromAsync(adapter.stream({ system: "", messages: [], tools: [], budget: { maxOutputTokens: 20 } }));
    const error = events.find(e => e.e === "error");
    assert.equal(error?.retriable, false);
    assert.match(String(error?.raw), /权限/);
  } finally { globalThis.fetch = saved; }
});
