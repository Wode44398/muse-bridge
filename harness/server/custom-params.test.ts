// bridge 模型中心「高级调用配置」的调用参数（2026-11-15）：plugin-providers.json 里型号带的 params 读进来、按协议写进请求体；
// 兼容项（提示缓存 / 回传推理 / 输出上限字段名）跟着服务走。和 Claude 那边同一套约定（额外请求体按协议取 "openai" / "gemini" 命名空间）。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { applyCustomParams, cleanCustomParams } from "./custom-params.ts";
import { getCustomProvider, setCustomSecretsForTests } from "./custom-providers.ts";

test("cleanCustomParams：只留认得的合法值；额外请求体解析成对象；空的回 undefined", () => {
  assert.equal(cleanCustomParams(undefined), undefined);
  assert.equal(cleanCustomParams({ temperature: 5, topP: -1, extraBody: "[1]" }), undefined);
  assert.deepEqual(cleanCustomParams({ temperature: 0.4, topK: 40.5, stop: ["A", "A", ""], maxTokens: 900, extraBody: '{"seed":3}' }), {
    temperature: 0.4,
    stop: ["A"],
    maxTokens: 900,
    extraBody: { seed: 3 },
  });
});

test("applyCustomParams：三种协议各写各的字段；固定输出长度不超过型号上限；额外请求体最后合并", () => {
  const p = cleanCustomParams({
    temperature: 0.2,
    topP: 0.8,
    topK: 20,
    stop: ["END"],
    maxTokens: 99_999,
    extraBody: JSON.stringify({ seed: 1, openai: { seed: 2, temperature: 0.9 }, gemini: { safetySettings: [] } }),
  });
  const an = applyCustomParams({ max_tokens: 4000, stop_sequences: ["X"] }, p, "anthropic", 8000);
  assert.deepEqual(
    [an.max_tokens, an.temperature, an.top_p, an.top_k, an.stop_sequences, an.seed, "openai" in an, "gemini" in an],
    [8000, 0.2, 0.8, 20, ["X", "END"], 1, false, false],
  );
  const oa = applyCustomParams({ max_tokens: 4000 }, p, "openai", 8000);
  assert.deepEqual([oa.max_tokens, oa.top_p, oa.stop, oa.seed, oa.temperature], [8000, 0.8, ["END"], 2, 0.9], "openai 命名空间压过上面的采样参数");
  const ge = applyCustomParams({ generationConfig: { maxOutputTokens: 4000, thinkingConfig: { thinkingLevel: "LOW" } } }, p, "gemini", 8000);
  assert.deepEqual(ge.generationConfig, { maxOutputTokens: 8000, thinkingConfig: { thinkingLevel: "LOW" }, temperature: 0.2, topP: 0.8, topK: 20, stopSequences: ["END"] });
  assert.deepEqual(ge.safetySettings, []);
  assert.equal(ge.seed, undefined);
  // 没设参数：原样返回
  const raw = { max_tokens: 1 };
  assert.equal(applyCustomParams(raw, undefined, "openai"), raw);
});

test("plugin-providers.json：型号的 params 与服务的兼容项读进来", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-params-"));
  const saved = process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR;
  process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = dir;
  setCustomSecretsForTests({ readSecrets: () => ({}), writeSecrets: () => {} });
  try {
    fs.writeFileSync(
      path.join(dir, "plugin-providers.json"),
      JSON.stringify({
        v: 2,
        providers: [
          {
            id: "custom-abcdef12",
            name: "中转",
            baseUrl: "http://127.0.0.1:9/x/openai",
            protocol: "openai",
            authStyle: "none",
            headers: [],
            models: ["m-1"],
            modelSpecs: [{ id: "m-1", label: "M1", enabled: true, kind: "chat", params: { temperature: 0.5, extraBody: '{"openai":{"seed":9}}' } }],
            defaultModel: "m-1",
            createdAt: 0,
            plugin: { id: "model-hub", name: "模型中心", sid: "h-12345678" },
            replayReasoning: true,
            maxTokensField: "max_completion_tokens",
            promptCaching: false,
          },
        ],
      }),
    );
    const p = getCustomProvider("custom-abcdef12");
    assert.ok(p);
    assert.equal(p.replayReasoning, true);
    assert.equal(p.maxTokensField, "max_completion_tokens");
    assert.deepEqual(p.models[0].params, { temperature: 0.5, extraBody: { openai: { seed: 9 } } });
  } finally {
    process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = saved;
  }
});
