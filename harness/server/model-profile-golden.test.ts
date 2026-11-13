// 模型档案 P0「零行为变化」的锁：目录里每个型号（含本机型号与几条自定义服务样例）在各条路径上发给模型的东西——
// 主会话 system 全文、工具 schema（全量 / 延迟加载后）、子 agent 的 system + 工具 + 预算、一次真实请求体、压缩摘要旁路的请求——
// 算成 sha256 与金样（agent/profile-golden.json）逐条比对。金样由接入档案【之前】的 main 代码生成：
//   DIMENSIO_PROFILE_GOLDEN_WRITE=1 node --import ./server/test-setup.ts --test server/model-profile-golden.test.ts
// 以后按家族改提示词 / 工具 / 请求是有意的行为变化：先确认改动只落在想改的家族上，再重写金样。
// 接入档案后，各条路径都按这个型号解析出的档案走（system 的 env.profile、AgentState 的 profile、延迟加载的族表、摘要旁路预算；
// 子 agent 在 subagent.ts 里自己解析），比对的仍是接入前的同一份金样。
// 本机网卡地址那一行随机器变，比对前抹成占位；临时目录路径同理。
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOG, defaultEffort } from "./catalog.ts";
import { createAdapter } from "./providers/registry.ts";
import { ALL_TOOLS } from "./tools/registry.ts";
import { deferToolDefs, toolSearchTool } from "./agent/deferred-tools.ts";
import { systemPrompt, type PromptEnv } from "./agent/prompt.ts";
import { makeSubAgentRunner } from "./agent/subagent.ts";
import { AgentState } from "./agent/state.ts";
import { summarize } from "./agent/context.ts";
import { resolveProfile } from "./agent/profile.ts";
import { Sandbox } from "./sandbox.ts";
import type { ProviderAdapter } from "./providers/types.ts";
import type { Msg, ToolDef } from "./agent/turn.ts";
import { call, calls, say, ScriptedAdapter } from "./test-harness/scripted-adapter.ts";

const GOLDEN = fileURLToPath(new URL("./agent/profile-golden.json", import.meta.url));
const WRITE = process.env.DIMENSIO_PROFILE_GOLDEN_WRITE === "1";

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const LAN_RE = /\n- This machine on the local network: [^\n]*/;
const scrub = (s: string, root?: string): string => {
  let out = s.replace(LAN_RE, "\n- This machine on the local network: <LAN>");
  // 根路径既可能原样出现，也可能出现在 JSON 里（反斜杠转义过）
  if (root) out = out.split(root).join("<ROOT>").split(JSON.stringify(root).slice(1, -1)).join("<ROOT>");
  return out;
};

interface GoldenModel {
  provider: string;
  model: string;
  custom?: boolean;
}

// 目录里的全部内置型号 + 几条自定义服务样例（custom-<hex> 的型号名是用户那边的原名）
function goldenModels(): GoldenModel[] {
  const out: GoldenModel[] = [];
  for (const p of CATALOG) for (const m of p.models) out.push({ provider: p.id, model: m.id });
  for (const model of ["qwen3.8-flash-next-fp8", "deepseek/deepseek-v4-flash", "glm-5.3", "some-unknown-model-x1"]) {
    out.push({ provider: "custom-0a1b2c3d", model, custom: true });
  }
  return out;
}

const profileOf = (g: GoldenModel) => resolveProfile(g.provider, g.model, { effort: g.custom ? undefined : defaultEffort(g.provider as never, g.model) });

function minEnv(g: GoldenModel): PromptEnv {
  return { root: "C:/ws", shell: "bash", platform: "win32", provider: g.provider, model: g.model, profile: profileOf(g) };
}

// 能开的段都开：plan、整机、bridge / PR / 浏览器 / 搜索、GUIDE、项目指令、记忆、项目知识、技能、日期、调度、协作
function maxEnv(g: GoldenModel): PromptEnv {
  return {
    ...minEnv(g),
    permissionMode: "plan",
    access: "full",
    guide: "Always run npm test.",
    projectDocs: "## AGENTS.md\nUse tabs.",
    memory: "- note-1: build quirks",
    projectKnowledge: "profile: node",
    webSearch: true,
    browser: true,
    managedSkills: "## Skills\n- demo: does demo things",
    date: "2026-11-07",
    bridge: true,
    pr: true,
    dispatch: "## Sub-agent models\nfixed dispatch text",
    collab: "## Sessions\nfixed collab text",
  };
}

const mainToolDefs = (): ToolDef[] => ALL_TOOLS.map((t) => t.def);

// 子 agent：真适配器给能力（输出上限进预算），stream 换成一次就答完的假流，抓第一轮请求
async function subAgentTurn(g: GoldenModel, tier: "research" | "coder", schema: boolean): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-golden-sub-"));
  let fake: ScriptedAdapter | null = null;
  const factory = (cfg: Parameters<typeof createAdapter>[0]): ProviderAdapter => {
    const real = createAdapter({ ...cfg, apiKey: "FAKE-DUMMY-KEY", baseUrl: "http://127.0.0.1:1/v1" });
    fake = new ScriptedAdapter({ id: real.id, model: real.model, capabilities: real.capabilities, validate: false })
      .always(schema ? calls(call("c1", "SubmitResult", { answer: "x" })) : say("done"));
    return fake;
  };
  const run = makeSubAgentRunner(
    {
      provider: g.provider as never,
      apiKey: "FAKE-DUMMY-KEY",
      model: g.model,
      thinking: defaultEffort(g.provider as never, g.model),
      sandbox: new Sandbox(root),
      limits: { bashTimeoutMs: 1000, bashMaxTimeoutMs: 1000 },
      parentMode: () => "auto",
    },
    factory,
  );
  await run({
    prompt: "Find the entry point.",
    tier,
    ...(schema ? { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } } : {}),
  });
  fs.rmSync(root, { recursive: true, force: true });
  const t = (fake as ScriptedAdapter | null)?.inputs[0];
  assert.ok(t, `${g.provider}/${g.model} ${tier}：子 agent 没发请求`);
  return scrub(JSON.stringify({ system: t.system, tools: t.tools, budget: t.budget }), root);
}

// 主循环一次请求：AgentState.toTurn() 交给真适配器编码，fetch 截下请求体
async function requestBody(g: GoldenModel, build?: (init: ConstructorParameters<typeof AgentState>[0]) => AgentState): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-golden-body-"));
  const original = globalThis.fetch;
  let body = "";
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = String(init?.body ?? "");
    return new Response("stub", { status: 599 });
  }) as typeof fetch;
  try {
    const adapter = createAdapter({ provider: g.provider as never, model: g.model, apiKey: "FAKE-DUMMY-KEY", baseUrl: "http://127.0.0.1:1/v1" });
    const tools = mainToolDefs().filter((d) => ["Read", "Edit", "Bash"].includes(d.name));
    const init: ConstructorParameters<typeof AgentState>[0] = {
      adapter,
      system: systemPrompt(minEnv(g)),
      tools,
      budget: { maxOutputTokens: Math.min(adapter.capabilities.maxOutputTokens, 65_536), thinking: defaultEffort(g.provider as never, g.model) },
      ctx: { sandbox: new Sandbox(root), readFileState: new Map(), setTodos: () => {}, limits: { bashTimeoutMs: 1, bashMaxTimeoutMs: 1 }, agentSeesImages: false },
      toolMap: new Map(),
      permissionMode: "auto",
      memoryAuditRequired: false,
      profile: profileOf(g),
    };
    const state = build ? build(init) : new AgentState(init);
    state.addUserMessage("List the files.");
    state.appendAssistant({ text: "", thinkingText: "", calls: [{ id: "call_1", name: "Bash", args: { command: "ls" } }] });
    state.appendToolResults([{ t: "tool_result", id: "call_1", ok: true, content: [{ t: "text", text: "a.txt" }] }]);
    const turn = state.toTurn();
    for await (const _ of adapter.stream(turn)) { /* drain */ }
  } finally {
    globalThis.fetch = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
  assert.ok(body, `${g.provider}/${g.model}：适配器没发请求`);
  return scrub(body);
}

// 压缩摘要旁路：抓 summarize 发出的那一轮（system / 消息 / 工具 / 预算）
async function summaryTurn(run: (adapter: ProviderAdapter, middle: Msg[]) => Promise<string>): Promise<string> {
  const adapter = new ScriptedAdapter({ validate: false }).next(say("S".repeat(400)));
  await run(adapter, [{ role: "user", content: [{ t: "text", text: "hello" }] }, { role: "assistant", content: [{ t: "text", text: "hi" }] }]);
  adapter.assertDone();
  return JSON.stringify(adapter.inputs[0]);
}

const keyOf = (g: GoldenModel) => `${g.provider}/${g.model}`;

async function snapshot(): Promise<Record<string, Record<string, string>>> {
  const out: Record<string, Record<string, string>> = {};
  const defs = mainToolDefs();
  const deferred = deferToolDefs(defs);
  out["*"] = {
    "tools.main": sha(JSON.stringify(defs)),
    "tools.deferred": sha(JSON.stringify([...deferred.defs, toolSearchTool.def])),
    "tools.deferredNames": [...deferred.deferred.keys()].join(","),
    summary: sha(await summaryTurn((a, m) => summarize(a, m))),
  };
  for (const g of goldenModels()) {
    const row: Record<string, string> = {
      "prompt.min": sha(scrub(systemPrompt(minEnv(g)))),
      "prompt.max": sha(scrub(systemPrompt(maxEnv(g)))),
    };
    if (!g.custom) {
      row["sub.research"] = sha(await subAgentTurn(g, "research", false));
      row["sub.coder"] = sha(await subAgentTurn(g, "coder", false));
      row["sub.schema"] = sha(await subAgentTurn(g, "research", true));
      row.body = sha(await requestBody(g));
    }
    out[keyOf(g)] = row;
  }
  return out;
}

function readGolden(): Record<string, Record<string, string>> {
  return JSON.parse(fs.readFileSync(GOLDEN, "utf8")).items;
}

test("金样：目录里每个型号的 system / 工具 / 子 agent / 请求体 / 摘要请求与接入档案前逐字节相同", async (t) => {
  const now = await snapshot();
  if (WRITE) {
    fs.writeFileSync(GOLDEN, JSON.stringify({ note: "model-profile-golden.test.ts 生成；sha256（网卡地址与临时目录已抹成占位）", items: now }, null, 1) + "\n");
    return;
  }
  const want = readGolden();
  // 目录后来新上架 / 下架的型号不在金样里：只比两边都有的（新型号记一笔诊断，重写金样时补上）
  const fresh = Object.keys(now).filter((k) => !want[k]);
  if (fresh.length) t.diagnostic(`金样里没有的型号（未比对）：${fresh.join(", ")}`);
  const shared = Object.keys(want).filter((k) => now[k]);
  assert.ok(shared.length >= Object.keys(want).length / 2, "金样里的型号大半不在目录里了，金样该重写了");
  for (const k of shared) assert.deepEqual(now[k], want[k], `${k} 与金样不同`);
});

// 每个型号按自己档案的族表推迟工具、按自己档案的旁路预算写摘要：结果都等于接入前的那一份
test("金样：每个型号的档案下，延迟加载后的工具表与摘要旁路请求不变", async () => {
  const want = readGolden()["*"];
  const defs = mainToolDefs();
  for (const g of goldenModels()) {
    const p = profileOf(g);
    const r = deferToolDefs(defs, p.tools.deferredFamilies);
    assert.equal(sha(JSON.stringify([...r.defs, toolSearchTool.def])), want["tools.deferred"], `${keyOf(g)} 的延迟工具表变了`);
    assert.equal([...r.deferred.keys()].join(","), want["tools.deferredNames"]);
    assert.equal(sha(await summaryTurn((a, m) => summarize(a, m, undefined, undefined, p.side.summary))), want.summary, `${keyOf(g)} 的摘要请求变了`);
  }
});

// 同一份代码连跑两遍必须一样（金样本身要确定）
test("金样快照是确定的", async () => {
  const g = goldenModels()[0];
  assert.equal(await requestBody(g), await requestBody(g));
  assert.equal(await subAgentTurn(g, "coder", false), await subAgentTurn(g, "coder", false));
});

