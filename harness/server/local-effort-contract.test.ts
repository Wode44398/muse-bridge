// R4（#40）：本机 effort 与本机实际加载的 chat template 对照——契约对的是「模型真相」，不是自己。
// 改写自探针 04-codex/笔记/probe-local-effort.ts。
//
// 修前：「off」发 none，模板 raise_exception、llama-server 拒掉整个请求（子 agent 按调用降档正好走这条路）；
// 「high」与「max」渲染结果逐字节相同，菜单在谎报；原单测把错误映射钉死了。
// 这里只读解析本机 GGUF 文件头里的 tokenizer.chat_template（llama-server 以 --jinja 启动、没有指定
// --chat-template-file，用的就是它），本机没有这个 GGUF 就跳过；有 python + jinja2 时再真实渲染一遍。
// 换模型 / 换 GGUF 时模板可能变，这条测试就是用来发现这件事的。

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Turn } from "./agent/turn.ts";
import { modelSpec } from "./catalog.ts";
import { createOpenAIAdapter } from "./providers/openai.ts";

const GGUF = process.env.LOCAL_GGUF?.trim() || "E:/LLM/models/Qwen3.8-27B/Qwen3.8-27B-UD-Q4_K_XL.gguf";

// GGUF v3 文件头：magic、version、tensor 数、kv 数，然后是 kv 表。模板在 tokens 大数组之后，64MB 足够。
function readTemplate(file: string): string {
  const fd = fs.openSync(file, "r");
  const buf = Buffer.alloc(64 * 1024 * 1024);
  try {
    fs.readSync(fd, buf, 0, buf.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  let o = 8;
  const u32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
  const u64 = () => { const v = Number(buf.readBigUInt64LE(o)); o += 8; return v; };
  const str = () => { const n = u64(); const s = buf.toString("utf8", o, o + n); o += n; return s; };
  const size: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
  u64();
  const nkv = u64();
  for (let i = 0; i < nkv; i++) {
    const key = str();
    const type = u32();
    if (type === 8) {
      const v = str();
      if (key === "tokenizer.chat_template") return v;
    } else if (type === 9) {
      const at = u32();
      const n = u64();
      if (at === 8) for (let j = 0; j < n; j++) str();
      else o += size[at] * n;
    } else o += size[type];
  }
  return "";
}

// dimensio 真实适配器对某一档实际下发的 chat_template_kwargs（fetch 桩掉，不发任何请求）。
async function kwargsFor(level: Turn["budget"]["thinking"]): Promise<Record<string, unknown>> {
  const original = globalThis.fetch;
  let kwargs: Record<string, unknown> = {};
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    kwargs = JSON.parse(String(init?.body ?? "{}")).chat_template_kwargs ?? {};
    return new Response("stub", { status: 599 });
  }) as typeof fetch;
  try {
    const adapter = createOpenAIAdapter({ provider: "local", apiKey: "FAKE-LOCAL-KEY", model: "qwen3.8-27b", baseUrl: "http://127.0.0.1:1/v1" });
    const turn: Turn = { system: "SYS", messages: [{ role: "user", content: [{ t: "text", text: "hi" }] }], tools: [], budget: { maxOutputTokens: 100, thinking: level } };
    for await (const _ of adapter.stream(turn)) { /* drain */ }
  } finally {
    globalThis.fetch = original;
  }
  return kwargs;
}

const haveGguf = fs.existsSync(GGUF);

test("本机每一档都被模板接受，落到模板里两两不同", { skip: haveGguf ? false : "本机没有该 GGUF" }, async () => {
  const tpl = readTemplate(GGUF);
  assert.ok(tpl.length > 1000, "读到了 chat template");
  const efforts = modelSpec("local", "qwen3.8-27b")!.efforts;
  const sent = await Promise.all(efforts.map(async (lv) => [lv, await kwargsFor(lv)] as const));

  // 静态核对：档位白名单、'high' 的改写、enable_thinking:false 分支
  const allowed = [...(/resolved_reasoning_effort not in \(([^)]*)\)/.exec(tpl)?.[1] ?? "").matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(allowed.length > 0, "模板里有档位白名单");
  const highToXhigh = /resolved_reasoning_effort == 'high'[\s\S]{0,80}set resolved_reasoning_effort = 'xhigh'/.test(tpl);
  const resolved = sent.map(([lv, kw]) => {
    if (kw.enable_thinking === false) {
      assert.ok(!("reasoning_effort" in kw), `${lv}：关思考就别再带档位`);
      assert.match(tpl, /enable_thinking is defined and enable_thinking is false/, "模板认 enable_thinking:false");
      return "<no-think>";
    }
    const r = kw.reasoning_effort === "high" && highToXhigh ? "xhigh" : String(kw.reasoning_effort);
    assert.ok(allowed.includes(r), `dimensio「${lv}」→ ${String(kw.reasoning_effort)}：模板会 raise_exception（白名单 ${allowed}）`);
    return r;
  });
  assert.equal(new Set(resolved).size, resolved.length, `两档落到模板里同一档 = 菜单谎报：${JSON.stringify(Object.fromEntries(sent.map(([lv], i) => [lv, resolved[i]])))}`);

  // 真实渲染（本机有 python + jinja2 时）：每档都渲染得出来，结果两两不同
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-r4-"));
  try {
    const tplFile = path.join(dir, "t.jinja");
    fs.writeFileSync(tplFile, tpl);
    const py = [
      "import jinja2, sys, json",
      "src = open(sys.argv[1], encoding='utf-8').read()",
      "def rex(m): raise RuntimeError(m)",
      "env = jinja2.Environment(extensions=['jinja2.ext.loopcontrols']); env.globals['raise_exception'] = rex",
      "t = env.from_string(src)",
      "msgs = [{'role': 'system', 'content': 'DIMENSIO SYSTEM PROMPT'}, {'role': 'user', 'content': 'hi'}]",
      "tools = [{'type': 'function', 'function': {'name': 'Read', 'description': 'r', 'parameters': {'type': 'object', 'properties': {}}}}]",
      "out = []",
      "for kw in json.loads(sys.argv[2]):",
      "  try: out.append(t.render(messages=msgs, tools=tools, add_generation_prompt=True, bos_token='', **kw))",
      "  except Exception as ex: out.append('EXCEPTION: ' + str(ex))",
      "print(json.dumps(out, ensure_ascii=False))",
    ].join("\n");
    const r = spawnSync("python", ["-c", py, tplFile, JSON.stringify(sent.map(([, kw]) => kw))], { encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0) return; // 没有 python / jinja2：静态核对已经做完
    const rendered: string[] = JSON.parse(r.stdout);
    rendered.forEach((text, i) => assert.doesNotMatch(text, /^EXCEPTION/, `「${sent[i][0]}」渲染失败：${text.slice(0, 200)}`));
    assert.equal(new Set(rendered).size, rendered.length, "每一档渲染出来的提示词都不一样");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("旧会话 / 保存的选择里的 high、max 照旧是 xhigh，不悄悄降成 medium", async () => {
  const { clampEffort, defaultEffort } = await import("./catalog.ts");
  assert.equal(clampEffort("local", "qwen3.8-27b", "high"), "xhigh");
  assert.equal(clampEffort("local", "qwen3.8-27b", "max"), "xhigh");
  assert.equal(clampEffort("local", "qwen3.8-27b", "off"), "off");
  assert.equal(defaultEffort("local", "qwen3.8-27b"), "xhigh", "首次选中的默认档沿用改前的实际档位 xhigh");
  for (const lv of ["high", "max"] as const) assert.equal((await kwargsFor(lv)).reasoning_effort, "xhigh", `旧值 ${lv} 发出去仍是 xhigh`);
});
