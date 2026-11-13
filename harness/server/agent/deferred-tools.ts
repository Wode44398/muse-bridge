// 工具延迟加载（对齐 Claude Code 的 tool search）：不常用、说明又长的工具（浏览器一族、操作用户电脑、bridge、拉取请求、
// 工作区协同）平时只发一句简介 + 去掉说明文字的参数骨架，完整说明经 ToolSearch 取回、作为工具结果留在对话里。
// 和官方不同：工具表本身一项不增不减（推迟的工具也在表里，只是瘦身）——工具表在缓存前缀最前面，中途往里加工具会让整段
// 缓存作废，本机 llama.cpp 还要整段重新 prefill；各家 provider 也都认得这些名字，调用照常过 schema。
// 「加载过没有」不另存状态，从对话里现推：有 ToolSearch / 拦截回过它的说明（tool_result.meta.loadedTools），或者它被调用
// 过。整段压缩把这些压掉了，就算没加载——下一次调用前再取一次（官方压缩后同样重发）。
import type { JsonObjectSchema, JsonSchemaProp, Msg, ToolDef } from "./turn.ts";
import type { Tool, ToolRunResult } from "../tools/types.ts";
import { fail } from "../tools/types.ts";

export const TOOL_SEARCH = "ToolSearch";

// 一族一起加载：用了 Browser 多半接着要 ReadPage / Eval / Network
export const DEFERRED_FAMILIES: readonly string[][] = [
  ["Browser", "ReadPage", "Eval", "Network"],
  ["DeviceInspect", "DeviceAct", "DeviceBrowser", "DeviceShell", "DeviceFiles", "DevicePorts"],
  ["BridgeManual", "BridgeCall"],
  ["PullRequest"],
  ["Workspace", "Terminal"],
];
const familyMap = (families: readonly (readonly string[])[]): Map<string, readonly string[]> =>
  new Map(families.flatMap((f) => f.map((n) => [n, f] as const)));
const FAMILY_OF = familyMap(DEFERRED_FAMILIES);
// 模型档案（tools.deferredFamilies）可以按家族换一套族表：deferToolDefs 按哪套推迟的，ToolSearch / 拦截展开时就按哪套（挂在
// 返回的 deferred 表上，不另存会话状态）。没登记过的表（测试里手搓的）按默认族表。
const FAMILIES_OF_SET = new WeakMap<Map<string, ToolDef>, Map<string, readonly string[]>>();

export const familyOf = (name: string, fam: Map<string, readonly string[]> = FAMILY_OF): string[] => [...(fam.get(name) ?? [name])];

// 参数骨架：顶层参数留名字、类型、枚举、必填；再往里的嵌套结构只留类型（数组留 items 的类型——有的 provider 要求数组必须
// 写 items）。说明文字一律去掉。骨架只要让各家 provider 认得这些参数；真正怎么填，看 ToolSearch 取回的完整说明。
function stripProp(p: JsonSchemaProp, depth: number): JsonSchemaProp {
  const src = p as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (src.type !== undefined) out.type = src.type;
  if (depth <= 1 && Array.isArray(src.enum)) out.enum = src.enum;
  if (depth === 0) {
    if (src.properties && typeof src.properties === "object") {
      out.properties = Object.fromEntries(Object.entries(src.properties as Record<string, JsonSchemaProp>).map(([n, s]) => [n, stripProp(s, 1)]));
    }
    if (Array.isArray(src.required)) out.required = src.required;
  }
  if (src.items && typeof src.items === "object") out.items = stripProp(src.items as JsonSchemaProp, depth + 1);
  if (out.type === undefined && Array.isArray(src.anyOf ?? src.oneOf)) {
    const alts = (src.anyOf ?? src.oneOf) as JsonSchemaProp[];
    out.anyOf = alts.map((s) => stripProp(s, depth + 1));
  }
  return out as unknown as JsonSchemaProp;
}

// 简介：说明的第一句（太长就截），后面跟一句怎么拿完整说明
function firstSentence(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  const m = /^(.{20,}?[.!?])(\s|$)/.exec(flat);
  const one = m ? m[1] : flat;
  return one.length > 220 ? `${one.slice(0, 219)}…` : one;
}

export function stubDef(def: ToolDef): ToolDef {
  return {
    name: def.name,
    description:
      `${firstSentence(def.description)} [Deferred tool: its full instructions are not loaded yet — call ${TOOL_SEARCH} ` +
      `with names ["${def.name}"] before the first use.]`,
    parameters: stripProp(def.parameters as unknown as JsonSchemaProp, 0) as unknown as JsonObjectSchema,
  };
}

/** 发给模型的工具表里，把推迟的工具换成瘦身版；返回换过的表与被推迟的完整定义。没有可推迟的就原样返回、不加 ToolSearch。 */
export function deferToolDefs(
  defs: ToolDef[],
  families: readonly (readonly string[])[] = DEFERRED_FAMILIES,
): { defs: ToolDef[]; deferred: Map<string, ToolDef> } {
  const fam = families === DEFERRED_FAMILIES ? FAMILY_OF : familyMap(families);
  const deferred = new Map<string, ToolDef>();
  if (fam !== FAMILY_OF) FAMILIES_OF_SET.set(deferred, fam);
  const out = defs.map((d) => {
    if (!fam.has(d.name)) return d;
    deferred.set(d.name, d);
    return stubDef(d);
  });
  return { defs: out, deferred };
}

// 这个推迟的工具此刻在对话里有没有说明（见文件头）
// exceptCallId = 正在判定的这一次调用（它已经在转录里了，不能拿它自己当「调用过」）
export function deferredLoaded(messages: readonly Msg[], name: string, exceptCallId?: string): boolean {
  for (const m of messages) {
    for (const b of m.content) {
      if (b.t === "tool_call" && b.name === name && b.id !== exceptCallId) return true;
      if (b.t === "tool_result") {
        const loaded = b.meta?.loadedTools;
        if (Array.isArray(loaded) && loaded.includes(name)) return true;
      }
    }
  }
  return false;
}

export function docsFor(names: string[], deferred: Map<string, ToolDef>): string {
  return names
    .map((n) => deferred.get(n))
    .filter((d): d is ToolDef => Boolean(d))
    .map((d) => `## ${d.name}\n${d.description}\n\nParameters (JSON schema): ${JSON.stringify(d.parameters)}`)
    .join("\n\n");
}

// 要加载的工具（按族展开、去重、只留这个会话真推迟了的）
function expand(names: string[], deferred: Map<string, ToolDef>): string[] {
  const out: string[] = [];
  const fam = FAMILIES_OF_SET.get(deferred) ?? FAMILY_OF;
  for (const n of names) for (const f of familyOf(n, fam)) if (deferred.has(f) && !out.includes(f)) out.push(f);
  return out;
}

function search(query: string, deferred: Map<string, ToolDef>): string[] {
  const words = query.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((w) => w.length > 1);
  if (!words.length) return [];
  const scored = [...deferred.values()]
    .map((d) => {
      const hay = `${d.name} ${d.description}`.toLowerCase();
      const name = d.name.toLowerCase();
      return { name: d.name, score: words.reduce((a, w) => a + (name.includes(w) ? 3 : hay.includes(w) ? 1 : 0), 0) };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, 3).map((s) => s.name);
}

/** 模型没加载说明就直接调了推迟的工具：这次不执行，回它（与同族）的完整说明，并记为已加载。 */
export function notLoadedResult(name: string, deferred: Map<string, ToolDef>): ToolRunResult {
  const names = expand([name], deferred);
  return {
    ...fail(
      "tool instructions not loaded",
      `${name} is a deferred tool and its full instructions had not been loaded, so this call was NOT run. ` +
        `They are below (now loaded for the rest of the conversation) — read them, then re-issue the call.\n\n${docsFor(names, deferred)}`,
    ),
    meta: { loadedTools: names },
  };
}

export const toolSearchTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: {
    name: TOOL_SEARCH,
    description:
      "Loads the full instructions and parameter schema of deferred tools. A deferred tool's own description says so and carries " +
      "only a one-line summary; call this before you first use one. Loading one tool loads its whole family (Browser also loads " +
      "ReadPage, Eval and Network). The instructions stay in the conversation — no need to load a tool twice.",
    parameters: {
      type: "object",
      properties: {
        names: { type: "array", items: { type: "string" }, description: "Exact names of the deferred tools to load." },
        query: { type: "string", description: "Keywords to find a deferred tool by name or purpose when you do not know its name." },
      },
    },
  },
  async run(args, ctx) {
    const deferred = ctx.deferredTools;
    if (!deferred?.size) return fail("no deferred tools", "No tools are deferred in this conversation — every tool's full instructions are already loaded.");
    const asked = Array.isArray(args.names) ? args.names.map(String) : typeof args.names === "string" ? [args.names] : [];
    const query = typeof args.query === "string" ? args.query : "";
    const unknown = asked.filter((n) => !deferred.has(n));
    const names = expand([...asked, ...(query ? search(query, deferred) : [])], deferred);
    if (!names.length) {
      return fail(
        "nothing to load",
        (unknown.length ? `Not deferred tools: ${unknown.join(", ")}. ` : query ? `No deferred tool matches "${query}". ` : "Pass names or query. ") +
          `Deferred tools: ${[...deferred.keys()].join(", ")}.`,
      );
    }
    const note = unknown.length ? `\n\n(Not deferred — their instructions are already in your tool list: ${unknown.join(", ")}.)` : "";
    return {
      ok: true,
      summary: `loaded ${names.join(", ")}`,
      outcome: `载入了 ${names.join("、")} 的说明`,
      content: [{ t: "text", text: docsFor(names, deferred) + note }],
      meta: { loadedTools: names },
    };
  },
};
