// 工具说明按姿态（agent/tool-descriptions.ts，档案 tools.descriptions）：lean 用工具自带的精简说明；hardened 换回姿态改造前的
// 说明原文（第一波把核心工具说明里的用法要求删了，两个姿态共用一份，hardened 就不再「等于改造前」）。参数 schema 不分姿态。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, afterEach } from "node:test";
import { hardenedProfile, defaultProfile } from "./agent/profile.ts";
import { describeDef, describeTools, HARDENED_DESCRIBED } from "./agent/tool-descriptions.ts";
import { toolSearchTool } from "./agent/deferred-tools.ts";
import { makeSubAgentRunner } from "./agent/subagent.ts";
import { defaultEffort } from "./catalog.ts";
import { setConfig } from "./config.ts";
import { Sandbox } from "./sandbox.ts";
import { buildState } from "./session/build-state.ts";
import type { PersistedConfig } from "./store.ts";
import { say, ScriptedAdapter } from "./test-harness/scripted-adapter.ts";
import { shell } from "./tools/bash.ts";
import { ALL_TOOLS } from "./tools/registry.ts";

const roots: string[] = [];
after(() => {
  for (const r of roots) {
    try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  }
});
afterEach(() => {
  delete process.env.DIMENSIO_PROFILE_OVERRIDES;
});
const tmp = (prefix: string) => {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(r);
  return r;
};
const def = (name: string) => (name === "ToolSearch" ? toolSearchTool.def : ALL_TOOLS.find((t) => t.def.name === name)!.def);

test("档案：lean 的说明是 lean，hardened 的是 hardened（hardenedPatch 里，不散写 if）", () => {
  assert.equal(defaultProfile().tools.descriptions, "lean");
  assert.equal(hardenedProfile().tools.descriptions, "hardened");
});

test("hardened：核心工具换回改造前的说明（用法要求都在），参数 schema 不变；lean 原样（同一个对象）", () => {
  const expected = ["Read", "Write", "Edit", "Bash", "Grep", "Glob", "Agent", "TodoWrite", "AskUserQuestion", "WebFetch", "WebSearch", "Skill", "ToolSearch"];
  assert.deepEqual([...HARDENED_DESCRIBED].sort(), [...expected].sort());
  assert.ok(!HARDENED_DESCRIBED.includes("Remember") && !HARDENED_DESCRIBED.includes("Recall"), "记忆工具的说明不归这里");
  for (const name of expected) {
    const d = def(name);
    if (name === "WebSearch" && !d) continue;
    const hard = describeDef(d, "hardened");
    assert.notEqual(hard.description, d.description, `${name} 在 hardened 下换了说明`);
    assert.equal(hard.parameters, d.parameters, `${name} 的参数 schema 不分姿态`);
    assert.equal(describeDef(d, "lean"), d, `${name} 在 lean 下原样`);
  }
  // 改造前原文里的用法要求
  assert.match(describeDef(def("TodoWrite"), "hardened").description, /Send the FULL list each call/);
  assert.match(describeDef(def("AskUserQuestion"), "hardened").description, /Use this ONLY when you cannot proceed/);
  assert.match(describeDef(def("Read"), "hardened").description, /You must Read a file before you can Edit it/);
  assert.match(describeDef(def("Agent"), "hardened").description, /The prompt MUST be self-contained/);
  assert.match(describeDef(def("ToolSearch"), "hardened").description, /no need to load a tool twice/);
  // 改造后新加的能力补了一句
  assert.match(describeDef(def("Read"), "hardened").description, /PDFs return their text page by page/);
  assert.match(describeDef(def("Grep"), "hardened").description, /head_limit caps how many come back, offset skips/);
  assert.match(describeDef(def("Agent"), "hardened").description, /shell commands are read-only[\s\S]*custom agent types[\s\S]*context:"fork"[\s\S]*isolation:"worktree"/);
  // 收口：同一段里不再自相矛盾、不再用 schema 里没有的参数名指档位
  const agentHard = describeDef(def("Agent"), "hardened").description;
  assert.doesNotMatch(agentHard, /cannot edit or run anything/);
  assert.doesNotMatch(agentHard, /tools:"/);
  assert.match(agentHard, /sees nothing of this conversation unless context is "fork"/);
  assert.match(describeDef(def("Skill"), "hardened").description, /\.claude\/skills and \.dimensio\/skills/);
});

test("hardened：Bash 的说明按片段换——每一段都对得上（换不上就会留着 lean 的原句），目录保留的说法仍照实（两个姿态都保留目录）", () => {
  const lean = def("Bash").description;
  const hard = describeDef(def("Bash"), "hardened").description;
  assert.match(hard, new RegExp(`^Run a shell command in the sandbox working directory using ${shell.kind}\\. `));
  assert.match(hard, /Quote paths with spaces\. /);
  assert.match(hard, /Never run a SERVER this way — use the Preview tool for servers\.$/);
  assert.match(hard, /Prefer Read\/Edit\/Grep\/Glob over cat\/sed\/grep\/find/);
  assert.doesNotMatch(hard, /Servers belong in the Preview tool, not Bash/);
  if (shell.kind === "powershell") assert.match(hard, /State \(env, cwd changes\) does NOT persist between calls/);
  else assert.match(hard, /the working directory persists between calls/, "lean 与 hardened 都跨调用保留目录：不回到「不保留」的旧说法");
  // 中间按平台拼的段落原样
  assert.ok(hard.includes(lean.slice(lean.indexOf(". ") + 2, lean.indexOf(" Every call starts") >= 0 ? lean.indexOf("Every call starts") : lean.indexOf("The first call starts"))), "语法那段原样");
  for (const head of ["Scratch files:", "HOME/USERPROFILE"]) {
    if (!lean.includes(head)) continue;
    const at = lean.indexOf(head);
    assert.ok(hard.includes(lean.slice(at, lean.indexOf("For commands longer"))), `「${head}」起的那几段原样`);
  }
});

test("建会话：hardened 的工具表与 ToolSearch 用改造前的说明，执行用的工具与下发的定义是同一份；lean 不变", (t) => {
  t.mock.method(console, "log", () => {});
  const root = tmp("dimensio-desc-ws-");
  const cfg = (): PersistedConfig => {
    const thinking = defaultEffort("openai", "deepseek-flash");
    setConfig({ provider: "openai", model: "deepseek-flash", thinking, apiKey: "DUMMY-desc-key", workspace: root, permissionMode: "auto", access: "workspace" });
    return { provider: "openai", model: "deepseek-flash", thinking, permissionMode: "auto", permissionRules: { allow: [], deny: [], ask: [] }, workspace: root, access: "workspace" } as PersistedConfig;
  };
  const lean = buildState(cfg());
  assert.equal(lean.profile.posture, "lean");
  assert.equal(lean.tools.find((d) => d.name === "Read")!.description, def("Read").description);
  process.env.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify({ "*": { posture: "hardened" } });
  const hard = buildState(cfg());
  assert.equal(hard.profile.posture, "hardened");
  for (const name of ["Read", "Edit", "TodoWrite", "Bash"]) {
    const shown = hard.tools.find((d) => d.name === name)!;
    assert.equal(shown.description, describeDef(def(name), "hardened").description, `${name} 下发的是改造前的说明`);
    assert.equal(hard.toolMap.get(name)!.def.description, shown.description, `${name}：执行用的工具与下发的定义一致`);
  }
  const search = hard.tools.find((d) => d.name === "ToolSearch");
  assert.ok(search && /no need to load a tool twice/.test(search.description));
  assert.equal(hard.toolMap.get("Bash")!.shellCwd, true, "换了说明的 Bash 仍带当前目录标记");
});

test("子 agent（hardened）：研究档的 Read / Grep / Glob 用改造前的说明", async () => {
  process.env.DIMENSIO_PROFILE_OVERRIDES = JSON.stringify({ "*": { posture: "hardened" } });
  const root = tmp("dimensio-desc-sub-");
  let fake: ScriptedAdapter | null = null;
  const run = makeSubAgentRunner(
    { provider: "openai", apiKey: "FAKE-DUMMY-KEY", model: "fake", thinking: "off", sandbox: new Sandbox(root), limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 }, parentMode: () => "auto" },
    (c) => (fake = new ScriptedAdapter({ id: c.provider, model: c.model, validate: false }).next(say("done"))),
  );
  const r = await run({ prompt: "look around", tier: "research" });
  assert.equal(r.ok, true, r.error);
  const tools = (fake as ScriptedAdapter | null)!.inputs[0].tools;
  for (const name of ["Read", "Grep", "Glob"]) {
    assert.equal(tools.find((d) => d.name === name)!.description, describeDef(def(name), "hardened").description);
  }
  assert.deepEqual(describeTools(ALL_TOOLS, "lean"), ALL_TOOLS);
});
