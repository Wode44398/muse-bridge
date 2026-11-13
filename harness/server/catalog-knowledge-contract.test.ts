// D3：dimensio 的内置目录（catalog.ts 的 CATALOG，逐型号实测 + 官方口径）和共用型号表（src/model-knowledge/knowledge.mjs，
// bridge 的 Claude 外接与 dimensio 的自定义服务都按它识别）必须一致。以前两边各存一份：30 个内置型号里 10 个对不上，
// Claude 外接给 Sonnet 4.6 开了 xhigh（选了必 400）。以后官方改档位 / 上下文，两处要一起改，漏一处这里就红。
//
// 比的是「同一个型号经自定义服务接进来，dimensio 会把它当成什么」：上下文、输出上限、看图 / 视频 / 音频、思考档（共用模板经
// custom-tiers.ts 映射成七级档后的 id）、首次选中的默认档、开关式档名、图片额度。协议按这家内置厂商实际走的那条（anthropic /
// gemini / 其余 OpenAI 兼容）。本机两台引擎的上下文与识图跟着面板设置走，不比。

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CATALOG, defaultEffort, providerSpec } from "./catalog.ts";
import { getCustomProvider } from "./custom-providers.ts";
import { slotView } from "./custom-tiers.ts";
import { MK } from "./model-knowledge.ts";
import { createAdapter } from "./providers/registry.ts";
import type { ThinkingLevel, Turn } from "./agent/turn.ts";

const SKIP_PROVIDERS = new Set(["local"]);
const protocolOf = (p: string) => (p === "anthropic" ? "anthropic" : p === "gemini" ? "gemini" : "openai");
// 同 catalog.defaultEffort 的规则：型号自己的默认档 > high > low > 第一档
const firstPick = (efforts: ThinkingLevel[], dflt?: ThinkingLevel): ThinkingLevel =>
  dflt && efforts.includes(dflt) ? dflt : efforts.includes("high") ? "high" : efforts.includes("low") ? "low" : efforts[0];

test("内置目录与共用型号表逐型号一致（上下文 / 输出 / 看图 / 视频 / 音频 / 思考档 / 默认档 / 开关档名）", () => {
  const diffs: string[] = [];
  let n = 0;
  for (const spec of CATALOG) {
    if (SKIP_PROVIDERS.has(spec.id)) continue;
    for (const m of spec.models) {
      n++;
      const where = `${spec.id}/${m.id}`;
      const e = MK.tableEntry(m.id);
      if (!e) {
        diffs.push(`${where}：共用型号表里没有`);
        continue;
      }
      const g = MK.guessModel(m.id, { protocol: protocolOf(spec.id) });
      if (g.contextWindow !== m.ctx) diffs.push(`${where} 上下文 目录=${m.ctx} 共用表=${g.contextWindow}`);
      if (g.maxOutput !== m.maxOut) diffs.push(`${where} 输出 目录=${m.maxOut} 共用表=${g.maxOutput}`);
      if (g.vision !== m.image) diffs.push(`${where} 看图 目录=${m.image} 共用表=${g.vision}`);
      if (g.video !== (m.video === true)) diffs.push(`${where} 视频 目录=${m.video === true} 共用表=${g.video}`);
      if (g.audio !== (m.audio === true)) diffs.push(`${where} 音频 目录=${m.audio === true} 共用表=${g.audio}`);
      const v = slotView(g);
      if (v.efforts.join(",") !== m.efforts.join(",")) diffs.push(`${where} 思考档 目录=[${m.efforts}] 共用表=[${v.efforts}]`);
      const want = defaultEffort(spec.id, m.id);
      const got = firstPick(v.efforts, v.defaultEffort);
      if (want !== got) diffs.push(`${where} 默认档 目录=${want} 共用表=${got}`);
      for (const [lv, label] of Object.entries(m.effortLabels ?? {})) {
        if (v.labels[lv as ThinkingLevel] !== label) diffs.push(`${where} 档名 ${lv} 目录=${label} 共用表=${v.labels[lv as ThinkingLevel]}`);
      }
      // 图片额度：目录按厂商配，共用表按型号家族配（经第三方接的小米同样只留最近 2 张）
      const fam = e.media ?? {};
      for (const k of ["maxImages", "maxBytes", "keepRecent"] as const) {
        if (spec.media?.[k] !== fam[k]) diffs.push(`${where} 图片额度 ${k} 目录=${spec.media?.[k]} 共用表=${fam[k]}`);
      }
    }
  }
  assert.ok(n >= 28, `比了 ${n} 个型号`);
  assert.deepEqual(diffs, []);
});

// 2026-11-07 上架的 K3.1 Pro：两个 id 都有 low / high / max 三档（highspeed 不是 K2.7 highspeed 那种「没有档位」）、1M、图 + 视频
test("Kimi K3.1 Pro 两个 id：共用型号表与目录都给三档、1M、图 + 视频", () => {
  const kimi = CATALOG.find((s) => s.id === "kimi")!;
  for (const id of ["k3.1-pro", "k3.1-pro-highspeed"]) {
    const m = kimi.models.find((x) => x.id === id);
    assert.ok(m, `目录里没有 ${id}`);
    assert.deepEqual([m!.efforts, m!.ctx, m!.image, m!.video], [["low", "high", "max"], 1_048_576, true, true], id);
    const g = MK.guessModel(id, { protocol: "openai" });
    assert.deepEqual(g.efforts.map((t) => t.id), ["low", "high", "max"], id);
    assert.equal(g.alwaysThinks, true, id);
  }
});

test("Sonnet / Opus 4.6 没有 xhigh（Claude 外接以前开了，选了必 400）", () => {
  for (const id of ["claude-sonnet-4-6", "claude-opus-4-6"]) {
    assert.deepEqual(MK.guessModel(id, { protocol: "anthropic" }).efforts.map((t) => t.id), ["low", "medium", "high", "max"], id);
  }
});

// 本机 Strata 的几个变体与「开源权重的 Qwen3.8-Flash-Next 经自定义服务接进来」是同一个模型、同一份 chat template：思考档与默认档
// 要一致（上下文 / 识图由面板参数或服务设置定，不比）。
test("本机 Strata 各变体的思考档与共用型号表里开源权重 Flash-Next 的一致", () => {
  const g = MK.guessModel("qwen3.8-flash-next-fp8", { protocol: "openai" });
  const v = slotView(g);
  const local = CATALOG.find((s) => s.id === "local")!;
  const strata = local.models.filter((m) => m.id.startsWith("strata-"));
  assert.deepEqual(strata.map((m) => m.id), ["strata-flash-iq3s", "strata-orca-iq3xxs", "strata-flash-nvfp4"]);
  for (const m of strata) {
    assert.equal(v.efforts.join(","), m.efforts.join(","), `${m.id} 思考档`);
    assert.equal(firstPick(v.efforts, v.defaultEffort), defaultEffort("local", m.id), `${m.id} 默认档`);
  }
});

// fp8 那台 vLLM（正式服 custom-024744f2）以前被 /^qwen3\.8/ 认成官方 DashScope 的 Qwen3.8：1M 上下文、图 + 视频、顶层
// enable_thinking + reasoning_effort（vLLM 不认顶层的开关，「关」照样想）。v1 老配置（型号只有字符串）在内存里升 v2 时要拿到新识别。
test("v1 老配置里的 qwen3.8-flash-next-fp8：升 v2 拿到开源权重的识别，请求只发 chat_template_kwargs、回传思考、不带 DashScope 参数", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-ckc-providers-"));
  const prev = process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR;
  process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = dir;
  const original = globalThis.fetch;
  try {
    const id = "custom-0000f8f8";
    const v1 = { v: 1, providers: [{ id, name: "vLLM", baseUrl: "http://127.0.0.1:1/v1", models: ["qwen3.8-flash-next-fp8"], defaultModel: "qwen3.8-flash-next-fp8", createdAt: 1 }] };
    fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify(v1));
    const m = getCustomProvider(id)!.models[0];
    assert.deepEqual([m.contextWindow, m.vision, m.video, m.thinking, m.effortField], [262_144, false, false, "effort", ""]);
    assert.deepEqual(m.efforts.map((t) => t.id), ["off", "low", "medium", "xhigh"]);
    const spec = providerSpec(id as never).models[0];
    assert.deepEqual([spec.ctx, spec.image, spec.video === true], [262_144, false, false]);
    assert.equal(defaultEffort(id as never, m.id), "medium");

    const bodies: any[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("stub", { status: 599 });
    }) as typeof fetch;
    const turn = (thinking: ThinkingLevel): Turn => ({
      system: "s",
      messages: [
        { role: "user", content: [{ t: "text", text: "hi" }] },
        { role: "assistant", content: [{ t: "thinking", text: "PRIOR-REASONING" }, { t: "tool_call", id: "c1", name: "Read", args: { path: "a" } }] },
        { role: "user", content: [{ t: "tool_result", id: "c1", content: [{ t: "text", text: "ok" }] } as never] },
      ],
      tools: [],
      budget: { maxOutputTokens: 1000, thinking },
    });
    for (const lv of ["off", "low", "medium", "xhigh"] as ThinkingLevel[]) {
      const adapter = createAdapter({ provider: id as never, model: m.id, apiKey: "FAKE-DUMMY-KEY" });
      for await (const _ of adapter.stream(turn(lv))) { /* drain */ }
    }
    const [off, low, medium, xhigh] = bodies;
    assert.deepEqual(off.chat_template_kwargs, { enable_thinking: false });
    assert.deepEqual([low, medium, xhigh].map((b) => b.chat_template_kwargs), ["low", "medium", "xhigh"].map((e) => ({ enable_thinking: true, reasoning_effort: e })));
    for (const b of bodies) {
      for (const k of ["enable_thinking", "reasoning_effort", "enable_search", "thinking_budget", "thinking"]) assert.ok(!(k in b), `顶层不该有 ${k}`);
      const asst = b.messages.find((x: any) => x.role === "assistant");
      assert.equal(asst.reasoning_content, "PRIOR-REASONING", "历史思考回传（模板缺省 preserve_thinking）");
    }
  } finally {
    globalThis.fetch = original;
    process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("v2 里存着旧识别（DashScope 写法的档位表、能看图 / 视频）的 flash-next-fp8：请求照样只发 chat_template_kwargs、不带 DashScope 参数", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-ckc-providers-"));
  const prev = process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR;
  process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = dir;
  const original = globalThis.fetch;
  try {
    const id = "custom-0000f8f9";
    // 知识层改对之前自动识别、存进 providers.json 的样子：官方 qwen3.8 的模板（顶层 enable_thinking + reasoning_effort）
    const stale = MK.thinkingTemplate("qwen38", "openai")!;
    const model = { id: "qwen3.8-flash-next-fp8", label: "qwen3.8-flash-next-fp8", kind: "chat", contextWindow: 1_000_000, maxOutput: 131_072, vision: true, video: true, ...stale, source: { thinking: "table", vision: "table" } };
    fs.writeFileSync(path.join(dir, "providers.json"), JSON.stringify({ v: 2, providers: [{ id, name: "vLLM", protocol: "openai", baseUrl: "http://127.0.0.1:1/v1", models: [model], defaultModel: model.id, createdAt: 1 }] }));
    const m = getCustomProvider(id)!.models[0];
    assert.deepEqual(m.efforts.find((t) => t.id === "off")?.value, { enable_thinking: false }, "存的档位表原样读出（迁移不在这里做）");

    const bodies: any[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")));
      return new Response("stub", { status: 599 });
    }) as typeof fetch;
    const turn = (thinking: ThinkingLevel): Turn => ({ system: "s", messages: [{ role: "user", content: [{ t: "text", text: "hi" }] }], tools: [], budget: { maxOutputTokens: 1000, thinking } });
    for (const lv of ["off", "low", "medium", "xhigh"] as ThinkingLevel[]) {
      const adapter = createAdapter({ provider: id as never, model: m.id, apiKey: "FAKE-DUMMY-KEY" });
      for await (const _ of adapter.stream(turn(lv))) { /* drain */ }
    }
    const [off, low, medium, xhigh] = bodies;
    assert.deepEqual(off.chat_template_kwargs, { enable_thinking: false });
    assert.deepEqual([low, medium, xhigh].map((b) => b.chat_template_kwargs), ["low", "medium", "xhigh"].map((e) => ({ enable_thinking: true, reasoning_effort: e })));
    for (const b of bodies) for (const k of ["enable_thinking", "reasoning_effort", "enable_search", "search_options"]) assert.ok(!(k in b), `顶层不该有 ${k}`);
  } finally {
    globalThis.fetch = original;
    process.env.DIMENSIO_CUSTOM_PROVIDERS_DIR = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("官方 qwen3.8 经自定义服务接进来不受开源权重的搬移影响（顶层参数照发）", () => {
  assert.equal(MK.tableEntry("qwen3.8-flash")?.think, "qwen38");
  assert.equal(MK.tableEntry("qwen3.8-max")?.think, "qwen38");
  assert.equal(MK.tableEntry("Qwen/Qwen3.8-Flash-Next-FP8")?.think, "qwen38-open");
});
