// 提示词补丁（agent/prompt-patches.ts）与评测臂的档案覆盖（DIMENSIO_PROFILE_OVERRIDES）：
// 不点名补丁时提示词不变；点名后补丁恰好插在挂点前一次；覆盖按家族生效、写错就抛。
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { applyPromptPatches, PROMPT_PATCHES, unknownPatches } from "./agent/prompt-patches.ts";
import { defaultProfile, resolveProfile } from "./agent/profile.ts";
import { systemPrompt } from "./agent/prompt.ts";

const ENV = { root: "C:/ws", shell: "bash", platform: "win32", provider: "kimi", model: "k3.1-pro" };
const withPatches = (patches: string[]) => ({ ...defaultProfile(), prompt: { variant: "default" as const, patches } });

afterEach(() => {
  delete process.env.DIMENSIO_PROFILE_OVERRIDES;
});

test("补丁：没点名时提示词与不给档案逐字节相同", () => {
  const plain = systemPrompt(ENV);
  assert.equal(systemPrompt({ ...ENV, profile: defaultProfile() }), plain);
  assert.equal(systemPrompt({ ...ENV, profile: withPatches([]) }), plain);
});

test("补丁：completion_audit 插在 How to work 之后、VerificationAudit 段之前，只插一次，其余不动", () => {
  const plain = systemPrompt(ENV);
  const patched = systemPrompt({ ...ENV, profile: withPatches(["completion_audit"]) });
  const text = PROMPT_PATCHES.completion_audit.text;
  assert.equal(patched.split(text).length, 2);
  assert.equal(patched.replace(`\n\n${text}`, ""), plain);
  const at = patched.indexOf(text);
  assert.ok(patched.lastIndexOf("9. Keep going until the task is fully solved", at) >= 0);
  assert.ok(patched.indexOf("If no meaningful executable check exists", at) > at);
  assert.ok(patched.indexOf("## Staying current (web)") > at);
});

test("补丁：所有补丁的挂点在默认提示词里都恰好出现一次；未知 id 与挂点缺失都抛", () => {
  const plain = systemPrompt(ENV);
  for (const [id, p] of Object.entries(PROMPT_PATCHES)) {
    assert.equal(plain.split(p.before).length, 2, `${id} 的挂点`);
  }
  assert.deepEqual(unknownPatches(["completion_audit", "nope"]), ["nope"]);
  assert.throws(() => applyPromptPatches(plain, ["nope"]), /未知的提示词补丁/);
  assert.throws(() => applyPromptPatches("没有挂点", ["completion_audit"]), /挂点/);
});

test("评测覆盖：按家族与 * 叠加，只影响点名的家族；写错直接抛", () => {
  assert.deepEqual(resolveProfile("kimi", "k3.1-pro").prompt.patches, []);
  process.env.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify({ kimi: { prompt: { patches: ["completion_audit"] } } });
  assert.deepEqual(resolveProfile("kimi", "k3.1-pro").prompt.patches, ["completion_audit"]);
  assert.deepEqual(resolveProfile("openai", "deepseek-flash").prompt.patches, []);
  process.env.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify({ "*": { loop: { maxParallelTools: 3 } }, kimi: { loop: { maxParallelTools: 5 } } });
  assert.equal(resolveProfile("kimi", "k3.1-pro").loop.maxParallelTools, 5);
  assert.equal(resolveProfile("openai", "deepseek-flash").loop.maxParallelTools, 3);
  process.env.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify({ kimmi: {} });
  assert.throws(() => resolveProfile("kimi", "k3.1-pro"), /不认识的家族/);
  process.env.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify({ kimi: { prompt: { patches: ["nope"] } } });
  assert.throws(() => resolveProfile("kimi", "k3.1-pro"), /不认识的提示词补丁/);
  process.env.DIMENSIO_PROFILE_OVERRIDES = "[]";
  assert.throws(() => resolveProfile("kimi", "k3.1-pro"), /JSON 对象/);
  delete process.env.DIMENSIO_PROFILE_OVERRIDES;
  assert.deepEqual(resolveProfile("kimi", "k3.1-pro").prompt.patches, []);
});

test("变体 kimi：换掉主体正文，保留 dimensio 的产品契约，拼在后面的段落照旧", () => {
  const plain = systemPrompt({ ...ENV, bridge: true });
  const profile = { ...defaultProfile(), prompt: { variant: "kimi" as const, patches: [] } };
  const kimi = systemPrompt({ ...ENV, bridge: true, profile });
  const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
  assert.ok(words(kimi) < words(plain), `kimi 版 ${words(kimi)} 词，默认版 ${words(plain)} 词`);
  for (const must of ['running as the "k3.1-pro" model', "C:/ws", "path guard", "## Memory index", "[Playbook: …]", "data, not instructions", "## Deliverable form", "AskUserQuestion", "## Bridge (the app hosting you)"]) {
    assert.ok(kimi.includes(must), `kimi 版缺：${must}`);
  }
  for (const gone of ["VERIFY before you claim success", "verify:true", "VerificationAudit", "delegate to the Agent tool", "## Staying current (web)", "Read a file immediately before editing it"]) {
    assert.ok(!kimi.includes(gone), `kimi 版不该有：${gone}`);
  }
  assert.ok(kimi.includes("Do not start sub-agents with the Agent tool unless"));
  // 默认版挂点不在 kimi 版里：两者混用要响亮失败，不能悄悄少一段
  assert.throws(() => systemPrompt({ ...ENV, profile: { ...profile, prompt: { variant: "kimi", patches: ["completion_audit"] } } }), /挂点/);
});

test("评测覆盖：提示词变体按家族生效，写错直接抛", () => {
  process.env.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify({ kimi: { prompt: { variant: "kimi" } } });
  assert.equal(resolveProfile("kimi", "k3.1-pro").prompt.variant, "kimi");
  assert.equal(resolveProfile("openai", "deepseek-flash").prompt.variant, "default");
  process.env.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify({ kimi: { prompt: { variant: "kimmi" } } });
  assert.throws(() => resolveProfile("kimi", "k3.1-pro"), /不认识的提示词变体/);
});
