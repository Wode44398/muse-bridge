// 思考深度契约：目录里每个型号的每一档 → 适配器真实发出去的请求体，逐条对照「厂商官方怎么说」。
//
// 修前（2026-10-09：Claude 只有四档，没有 xhigh）：统一档位只有 off/low/medium/high/max，Anthropic 适配器把
// 界面上的 max 偷偷发成 xhigh——Opus/Sonnet/Haiku 5.x 真正的 max 永远发不出去，Sonnet 4.6 根本没有 xhigh、选 max 必 400；
// Qwen3.8 的 low/medium/high 全靠 thinking_budget 8k/16k/32k 硬截断，没用上它自己的 reasoning_effort 档。
// 以前的单测只钉「适配器发了什么」，钉的是自己——错映射照样全绿。这里改成对照一张独立的官方表：
//
//   OFFICIAL[厂商][型号] = { field: 档位落在请求体的哪个字段, accepts: 官方接受的取值, tiers: 官方的真档位（升序）,
//                           off: 关思考时请求体里该出现什么（null = 这个型号关不掉）, aliases: 官方声明的别名→真档位 }
//
// 断言（任何一条红都说明菜单在骗人或者请求会被拒）：
//   1. 每一档发出去的值都在官方 accepts 里（否则 400）；
//   2. 把别名按官方映射折算后，各档落到的真档位两两不同（否则两个按钮是同一个东西）；
//   3. 顺序与菜单一致：菜单靠后的档，真档位也靠后；
//   4. 官方的每个真档位菜单里都有一档能发出来（否则少档，就是这次的 extra）；
//   5. 档名不撒谎：菜单叫 max/xhigh/high/medium/low 的那档，折算后就是官方同名档（官方有同名档时）；
//   6. off 档只在官方能关的型号上出现，且发的是官方的关法。
// 来源与日期写在每家旁边；官方改了档位，先改这张表，再改目录和适配器。

import assert from "node:assert/strict";
import test from "node:test";
import { CATALOG, EFFORT_ORDER } from "./catalog.ts";
import { createAdapter } from "./providers/registry.ts";
import type { ThinkingLevel, Turn } from "./agent/turn.ts";

type Path = string; // 请求体里的点路径
interface Official {
  field: Path;
  accepts: string[];
  tiers: string[];
  aliases?: Record<string, string>;
  // 关思考的官方写法：路径 → 值（value undefined = 该字段必须不存在）。null = 关不掉，菜单不许有 off。
  off: Record<Path, unknown> | null;
  // 开思考时必须同时带的字段（例如 thinking.type=enabled）
  onExtras?: Record<Path, unknown>;
  // 没有档位、只有开关的型号：菜单只许 off + 一个「开」
  switchOnly?: boolean;
}

// ── Anthropic：platform.claude.com/docs/en/build-with-claude/effort（2026-10-09 读）──────────────
// max：Opus 5.5/5/4.8/4.7/4.6、Sonnet 5.5/5/4.6、Haiku 5.5；xhigh：Opus 5.5/5/4.8/4.7、Sonnet 5.5/5、Haiku 5.5（Sonnet 4.6 没有）。
// Opus 5.5 关不掉思考（thinking.disabled 一律 400）；dimensio 对 adaptive 型号恒发 adaptive，所以都按「关不掉」算。
const claude5 = { field: "output_config.effort", accepts: ["low", "medium", "high", "xhigh", "max"], tiers: ["low", "medium", "high", "xhigh", "max"], off: null };
const OFFICIAL: Record<string, Record<string, Official>> = {
  anthropic: {
    "claude-opus-5-5": claude5,
    "claude-opus-5": claude5,
    "claude-sonnet-5-5": claude5,
    "claude-opus-4-8": claude5,
    "claude-opus-4-7": claude5,
    "claude-haiku-5-5": claude5,
    "claude-sonnet-4-6": { field: "output_config.effort", accepts: ["low", "medium", "high", "max"], tiers: ["low", "medium", "high", "max"], off: null },
    // Haiku 4.5：只有手动 budget_tokens，档位 = 预算大小（dimensio 自定 4k/8k/12k）
    "claude-haiku-4-5": { field: "thinking.budget_tokens", accepts: ["4000", "8000", "12000"], tiers: ["4000", "8000", "12000"], off: { "thinking": undefined } },
  },
  // ── DeepSeek：api-docs.deepseek.com/api/create-chat-completion、/api/list-models（2026-10-09）──────
  // reasoning_effort 接受 none/minimal/low/medium/high/xhigh/max/ultra；真档位只有 low/high/max（/models supported_levels），
  // 其余是服务端别名。关法 thinking.type=disabled。
  openai: Object.fromEntries(["deepseek-flash", "deepseek-v4-pro"].map((id) => [id, {
    field: "reasoning_effort",
    accepts: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
    tiers: id === "deepseek-flash" ? ["low", "high", "max"] : ["high", "max"], // v4-pro 留在单子里只为过渡，菜单只给 high/max
    aliases: { minimal: "low", medium: "high", xhigh: "high", ultra: "max" },
    off: { "thinking.type": "disabled", reasoning_effort: undefined },
    onExtras: { "thinking.type": "enabled" },
  } satisfies Official])),
  // ── Qwen：help.aliyun.com/zh/model-studio/qwen-api-via-openai-chat-completions、deep-thinking（2026-10-09）──
  // 3.8：reasoning_effort 真档位 low/medium/xhigh（默认 xhigh），high/max→xhigh、minimal→low；非法值 400（实测回包列出
  // none/minimal/low/medium/high/xhigh/max）。和 thinking_budget 不能同时给（实测 400）。关法 enable_thinking=false。
  // 3.7：没有 reasoning_effort，只有 enable_thinking + thinking_budget（token 预算，dimensio 自定三档）。
  qwen: {
    ...Object.fromEntries(["qwen3.8-max", "qwen3.8-flash"].map((id) => [id, {
      field: "reasoning_effort",
      accepts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      tiers: ["low", "medium", "xhigh"],
      aliases: { minimal: "low", high: "xhigh", max: "xhigh" },
      off: { enable_thinking: false, reasoning_effort: undefined },
      onExtras: { enable_thinking: true, thinking_budget: undefined },
    } satisfies Official])),
    ...Object.fromEntries(["qwen3.7-max", "qwen3.7-plus", "qwen3.7-flash"].map((id) => [id, {
      field: "thinking_budget",
      accepts: ["8192", "16384", "32768"],
      tiers: ["8192", "16384", "32768"],
      off: { enable_thinking: false, thinking_budget: undefined },
      onExtras: { enable_thinking: true, reasoning_effort: undefined },
    } satisfies Official])),
  },
  // ── 智谱：docs.bigmodel.cn/cn/guide/capabilities/thinking.md（2026-10-09）─────────────────────────
  // 5.3 / 5.3-flash：只收 low/high/max（其余报错），恒思考。5.2：收 none…max，low/medium→high、xhigh→max，真档位 high/max
  // （实测 low 与 high 的思维链长度分布重叠）。glm-5：没有 reasoning_effort，只有 thinking.type 开关。
  zhipu: {
    ...Object.fromEntries(["glm-5.3", "glm-5.3-flash"].map((id) => [id, {
      field: "reasoning_effort", accepts: ["low", "high", "max"], tiers: ["low", "high", "max"], off: null,
      onExtras: { "thinking.type": "enabled" },
    } satisfies Official])),
    "glm-5.2": {
      field: "reasoning_effort",
      accepts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
      tiers: ["high", "max"],
      aliases: { low: "high", medium: "high", xhigh: "max" },
      off: { "thinking.type": "disabled", reasoning_effort: undefined },
      onExtras: { "thinking.type": "enabled" },
    },
    "glm-5": { field: "thinking.type", accepts: ["enabled"], tiers: ["enabled"], off: { "thinking.type": "disabled" }, switchOnly: true },
  },
  // ── Kimi Code：kimi.com/code/docs（2026-10-09）：k3 / k3-256k / kimi-for-coding 三档 low/high/max、关不掉；
  // highspeed 没有档位字段（「无需配置该字段」）。
  kimi: {
    ...Object.fromEntries(["k3", "k3-256k", "kimi-for-coding"].map((id) => [id, {
      field: "reasoning_effort", accepts: ["low", "high", "max"], tiers: ["low", "high", "max"], off: null,
    } satisfies Official])),
    "kimi-for-coding-highspeed": { field: "reasoning_effort", accepts: [], tiers: [], off: null },
  },
  // ── MiMo：mimo.mi.com/static/docs/quick-start/usage-guide/text-generation/deep-thinking.md（2026-10-09）：
  // Chat Completions 只有 thinking.type 开关；带 reasoning_effort=max 实测 400。
  mimo: Object.fromEntries(["mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed", "mimo-v2.6-flash"].map((id) => [id, {
    field: "thinking.type", accepts: ["enabled"], tiers: ["enabled"], off: { "thinking.type": "disabled" }, switchOnly: true,
    onExtras: { reasoning_effort: undefined },
  } satisfies Official])),
  // ── Gemini：ai.google.dev/gemini-api/docs/thinking（2026-09-25 版）+ docs.cloud.google.com …/models/thinking（2026-10-07）──
  // 3.5 Flash：MINIMAL/LOW/MEDIUM/HIGH（默认 MEDIUM），关不掉（minimal 也不保证不想）；3.1 Pro：LOW/MEDIUM/HIGH；
  // 两者都不许发 thinkingBudget。2.5 Flash：thinkingBudget 0=关、1…24576、-1=自动（dimensio 自定 512/自动/24576）。
  // 4 Argon：官方 thinking 页未单列，以真打为准（2026-10-13，dev API + Vertex 双通道）：LOW/MEDIUM/HIGH 收，MINIMAL 400，
  // Vertex 拒 thinkingBudget。
  gemini: {
    "gemini-4-argon": { field: "generationConfig.thinkingConfig.thinkingLevel", accepts: ["LOW", "MEDIUM", "HIGH"], tiers: ["LOW", "MEDIUM", "HIGH"], off: null, onExtras: { "generationConfig.thinkingConfig.thinkingBudget": undefined } },
    "gemini-3.5-flash": { field: "generationConfig.thinkingConfig.thinkingLevel", accepts: ["MINIMAL", "LOW", "MEDIUM", "HIGH"], tiers: ["MINIMAL", "LOW", "MEDIUM", "HIGH"], off: null, onExtras: { "generationConfig.thinkingConfig.thinkingBudget": undefined } },
    "gemini-3.1-pro-preview": { field: "generationConfig.thinkingConfig.thinkingLevel", accepts: ["LOW", "MEDIUM", "HIGH"], tiers: ["LOW", "MEDIUM", "HIGH"], off: null, onExtras: { "generationConfig.thinkingConfig.thinkingBudget": undefined } },
    "gemini-2.5-flash": { field: "generationConfig.thinkingConfig.thinkingBudget", accepts: ["512", "-1", "24576"], tiers: ["512", "-1", "24576"], off: { "generationConfig.thinkingConfig.thinkingBudget": 0 } },
  },
  // ── 本机 llama.cpp：档位以 GGUF 里的 chat template 为准，local-effort-contract.test.ts 读模板本身对照；这里只核名实。
  local: Object.fromEntries(["qwen3.8-27b", "strata-orca"].map((id) => [id, {
    field: "chat_template_kwargs.reasoning_effort", accepts: ["low", "medium", "xhigh"], tiers: ["low", "medium", "xhigh"],
    off: { "chat_template_kwargs.enable_thinking": false, "chat_template_kwargs.reasoning_effort": undefined },
  } satisfies Official])),
};

function get(obj: any, path: Path): unknown {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

async function bodyFor(provider: string, model: string, level: ThinkingLevel): Promise<any> {
  const original = globalThis.fetch;
  let body: any = null;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    body = JSON.parse(String(init?.body ?? "{}"));
    return new Response("stub", { status: 599 });
  }) as typeof fetch;
  try {
    const adapter = createAdapter({ provider: provider as any, model, apiKey: "FAKE-DUMMY-KEY", baseUrl: "http://127.0.0.1:1/v1", thinking: true });
    const turn: Turn = { system: "s", messages: [{ role: "user", content: [{ t: "text", text: "hi" }] }], tools: [], budget: { maxOutputTokens: 32_000, thinking: level } };
    for await (const _ of adapter.stream(turn)) { /* drain */ }
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(body, `${provider}/${model}@${level}：适配器没发请求`);
  return body;
}

test("官方档位表覆盖目录里的每一个型号（新上架的型号必须先查文档登记）", () => {
  const missing: string[] = [];
  for (const spec of CATALOG) for (const m of spec.models) if (!OFFICIAL[spec.id]?.[m.id]) missing.push(`${spec.id}/${m.id}`);
  assert.deepEqual(missing, []);
});

test("目录的档位按统一顺序排列、不重复", () => {
  for (const spec of CATALOG) {
    for (const m of spec.models) {
      const idx = m.efforts.map((e) => EFFORT_ORDER.indexOf(e));
      assert.ok(idx.every((i) => i >= 0), `${spec.id}/${m.id} 有未知档位 ${m.efforts}`);
      assert.deepEqual(idx, [...idx].sort((a, b) => a - b), `${spec.id}/${m.id} 档位乱序 ${m.efforts}`);
      assert.equal(new Set(idx).size, idx.length, `${spec.id}/${m.id} 档位重复`);
    }
  }
});

for (const spec of CATALOG) {
  for (const m of spec.models) {
    test(`${spec.id}/${m.id}：每一档发出去的都是官方认的、且各不相同、名实相符`, async () => {
      const o = OFFICIAL[spec.id]?.[m.id];
      if (!o) return; // 上一条测试报缺
      const problems: string[] = [];
      const on = m.efforts.filter((e) => e !== "off");

      // 6. off
      if (m.efforts.includes("off")) {
        if (!o.off) problems.push("官方关不掉思考，菜单却有 off");
        else {
          const b = await bodyFor(spec.id, m.id, "off");
          for (const [p, v] of Object.entries(o.off)) {
            if (!Object.is(get(b, p), v) && !(v === undefined && get(b, p) === undefined)) problems.push(`off：${p} 应为 ${JSON.stringify(v)}，实发 ${JSON.stringify(get(b, p))}`);
          }
        }
      } else if (o.off && !o.switchOnly && o.tiers.length) {
        // 官方能关但菜单没给 off：不算错（有意不暴露），不报
      }

      if (o.switchOnly) {
        if (on.length !== 1) problems.push(`开关式型号菜单只许一个「开」档，实际 ${on}`);
      }
      if (!o.tiers.length) {
        if (on.length > 1) problems.push(`官方没有档位，菜单却给了 ${on}`);
        for (const lv of on) {
          const b = await bodyFor(spec.id, m.id, lv);
          if (get(b, o.field) !== undefined) problems.push(`${lv}：官方没有档位字段，却发了 ${o.field}=${JSON.stringify(get(b, o.field))}`);
        }
        assert.deepEqual(problems, []);
        return;
      }

      const resolved: string[] = [];
      for (const lv of on) {
        const b = await bodyFor(spec.id, m.id, lv);
        const raw = get(b, o.field);
        const sent = raw === undefined ? "<未发>" : String(raw);
        if (!o.accepts.includes(sent)) problems.push(`${lv}：发了 ${o.field}=${sent}，官方只认 ${o.accepts.join("/")}`);
        for (const [p, v] of Object.entries(o.onExtras ?? {})) {
          if (!(Object.is(get(b, p), v) || (v === undefined && get(b, p) === undefined))) problems.push(`${lv}：${p} 应为 ${JSON.stringify(v)}，实发 ${JSON.stringify(get(b, p))}`);
        }
        const real = o.aliases?.[sent] ?? sent;
        resolved.push(real);
        // 5. 名实相符：官方有同名档时，菜单这一档必须落到它
        const sameName = o.tiers.find((t) => t.toLowerCase() === lv);
        if (sameName && real !== sameName) problems.push(`菜单「${lv}」实际落到官方「${real}」，不是官方同名档`);
      }
      // 2. 两两不同
      const dup = resolved.filter((r, i) => resolved.indexOf(r) !== i);
      if (dup.length) problems.push(`几档落到同一个官方档：${JSON.stringify(Object.fromEntries(on.map((lv, i) => [lv, resolved[i]])))}`);
      // 3. 升序
      const rank = resolved.map((r) => o.tiers.indexOf(r));
      if (rank.some((r, i) => i > 0 && r <= rank[i - 1])) problems.push(`顺序和官方不一致：${on.join("<")} → ${resolved.join(",")}`);
      // 4. 官方每个真档位都能选到
      const unreachable = o.tiers.filter((t) => !resolved.includes(t));
      if (unreachable.length) problems.push(`官方的 ${unreachable.join("/")} 档在菜单里选不到（菜单 ${on.join("/")}）`);

      assert.deepEqual(problems, []);
    });
  }
}

test("升级前存下的档位：落到哪一档是有意的，不报错也不悄悄放大账单", async () => {
  const { clampEffort } = await import("./catalog.ts");
  // Claude 旧的 max 实际发的是 xhigh；现在菜单有真 max 了，旧选择照字面给 max（菜单当时就写着 max）。
  assert.equal(clampEffort("anthropic", "claude-opus-5-5", "max"), "max");
  // Sonnet 4.6 没有 xhigh：外面带进来的 xhigh（子 agent 覆盖、换型号）向下落到 high，不发 400 的值。
  assert.equal(clampEffort("anthropic", "claude-sonnet-4-6", "xhigh"), "high");
  // Qwen3.8 旧 high = 32k 封顶预算 → medium（不升成不封顶的 xhigh）；旧 max 不存在（以前菜单没有）。
  assert.equal(clampEffort("qwen", "qwen3.8-max", "high"), "medium");
  // Gemini 3.1 Pro 没有 minimal：落到它最低的 low。
  assert.equal(clampEffort("gemini", "gemini-3.1-pro-preview", "minimal"), "low");
  // Kimi 没有 xhigh：向下落到 high。
  assert.equal(clampEffort("kimi", "k3", "xhigh"), "high");
});
