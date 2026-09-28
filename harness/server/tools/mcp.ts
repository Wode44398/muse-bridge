// E1（G6）+ E2（K59）：会话里的 MCP 工具。
//
// 建会话时按连接池此刻的状态拍一张基线（随会话落盘，重启读回照旧）——会话里的工具清单从此不变：
//   · 直连：工具不多、schema 不大的连接器，每个工具一个 mcp__<连接器>__<工具>（定义冻结在基线里）。
//   · 网关（E2，kimi 数据插件的办法）：工具多或 schema 大的，不逐个进工具清单，走 McpDescribe + McpCall 两个固定工具——
//     对 8 家 provider 都通用、不靠中途改工具表，也不打断缓存；网关背后的清单现取（连接器新出的工具也用得上）。
// 权限：声明了 readOnlyHint 的按只读工具走（可并行、只读档与计划档也能用）；其余一律先问（auto 档也问，「本会话都允许」
// 放开的是这一个工具——网关按「连接器/工具」记）。结果按「读过外部内容」记（K9：之后的记忆写入只存待确认）。
import type { Block, JsonObjectSchema } from "../agent/turn.ts";
import { sniffImageMime } from "../image-assets.ts";
import { callMcpTool, liveTools, readyConnectors, redact, toolCost, type McpToolInfo } from "../mcp.ts";
import type { ApprovalPreview, PreparedCall, Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail } from "./types.ts";

export const DIRECT_MAX_TOOLS = 12; // 一个连接器超过这么多工具就走网关
export const DIRECT_MAX_TOKENS = 4_000; // 一个连接器全部工具定义的估算 token 超过这么多就走网关
export const DIRECT_TOTAL_TOKENS = 10_000; // 直连工具定义合计的上限，超出的连接器改走网关
const MAX_RESULT_CHARS = 30_000;
const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_NAME = 64; // 各家 provider 工具名的公共上限

export interface McpBaselineServer {
  id: string; // 扩展 id
  key: string; // 工具名前缀（同名的连接器已去重）
  name: string;
  description?: string;
  mode: "direct" | "gateway";
  toolCount: number;
  tools?: McpToolInfo[]; // 直连：冻结的工具定义
}
export interface McpBaseline {
  v: 1;
  at: number;
  servers: McpBaselineServer[];
}

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

// 新会话的基线：此刻连上、有工具的连接器（没有就是 null——会话里不出现任何 MCP 工具）
export function planMcpBaseline(now = Date.now()): McpBaseline | null {
  const ready = readyConnectors();
  if (!ready.length) return null;
  const servers: McpBaselineServer[] = [];
  const keys = new Set<string>();
  let used = 0;
  for (const c of ready) {
    let key = c.cfg.key;
    for (let n = 2; keys.has(key); n++) key = `${c.cfg.key}${n}`;
    keys.add(key);
    const cost = toolCost(c.tools);
    const direct = c.tools.length <= DIRECT_MAX_TOOLS && cost <= DIRECT_MAX_TOKENS && used + cost <= DIRECT_TOTAL_TOKENS;
    if (direct) used += cost;
    const description = clip(c.cfg.description || c.instructions || "", 300);
    servers.push({
      id: c.cfg.id,
      key,
      name: c.cfg.name,
      ...(description ? { description } : {}),
      mode: direct ? "direct" : "gateway",
      toolCount: c.tools.length,
      ...(direct ? { tools: c.tools.map((t) => ({ ...t })) } : {}),
    });
  }
  return { v: 1, at: now, servers };
}

// 读回：形状不对的丢掉（旧记录没有这一项 = null）
export function sanitizeBaseline(raw: unknown): McpBaseline | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<McpBaseline>;
  if (r.v !== 1 || !Array.isArray(r.servers)) return null;
  const servers = r.servers.filter(
    (s): s is McpBaselineServer =>
      !!s && typeof s.id === "string" && typeof s.key === "string" && typeof s.name === "string" && (s.mode === "direct" || s.mode === "gateway"),
  );
  return servers.length ? { v: 1, at: Number(r.at) || 0, servers } : null;
}

// ── 工具名与 schema ──────────────────────────────────────────────────────────
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

// mcp__<连接器>__<工具>：只留字母数字 _ -；超过 64 截断并补 8 位哈希（不同的长名不会撞成一个）
export function mcpToolName(key: string, tool: string): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");
  const full = `mcp__${safe(key)}__${safe(tool)}`;
  return full.length <= MAX_NAME ? full : `${full.slice(0, MAX_NAME - 9)}_${fnv1a(full)}`;
}

// 各家 provider 能吃的 schema：顶层是 object；$ref 指向 $defs / definitions 的就地展开（最多 8 层，循环引用截成「任意」）；
// 去掉 $schema、$id、$comment 与定义表。其余关键字留给各 adapter 自己按 provider 裁（gemini.ts 已在做）。
export function sanitizeInputSchema(raw: unknown): JsonObjectSchema {
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const defs: Record<string, unknown> = {
    ...((root.definitions as Record<string, unknown>) ?? {}),
    ...((root.$defs as Record<string, unknown>) ?? {}),
  };
  const DROP = new Set(["$schema", "$id", "$comment", "$defs", "definitions"]);
  const walk = (node: unknown, depth: number): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, depth));
    if (!node || typeof node !== "object") return node;
    const obj = node as Record<string, unknown>;
    if (typeof obj.$ref === "string") {
      const m = /^#\/(?:\$defs|definitions)\/(.+)$/.exec(obj.$ref);
      const target = m ? defs[decodeURIComponent(m[1])] : undefined;
      if (!target || depth >= 8) return {};
      const { $ref: _ref, ...rest } = obj;
      return walk({ ...(target as Record<string, unknown>), ...rest }, depth + 1);
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) if (!DROP.has(k)) out[k] = walk(v, depth);
    return out;
  };
  const out = walk(root, 0) as Record<string, unknown>;
  out.type = "object";
  if (!out.properties || typeof out.properties !== "object" || Array.isArray(out.properties)) out.properties = {};
  if (out.required !== undefined && !Array.isArray(out.required)) delete out.required;
  return out as unknown as JsonObjectSchema;
}

// ── 结果转换 ─────────────────────────────────────────────────────────────────
interface CallResultLike {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

function sameJson(text: string, value: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(value);
  } catch {
    return false;
  }
}

export function mcpResult(server: { key: string; name: string }, tool: string, r: CallResultLike, ctx: Pick<ToolContext, "agentSeesImages">): ToolRunResult {
  const texts: string[] = [];
  const notes: string[] = [];
  const images: Block[] = [];
  for (const c of Array.isArray(r.content) ? r.content : []) {
    const type = String(c.type ?? "");
    if (type === "text") texts.push(String(c.text ?? ""));
    else if (type === "image") {
      const data = String(c.data ?? "");
      const bytes = Buffer.from(data, "base64");
      const mime = sniffImageMime(bytes.subarray(0, 16));
      if (ctx.agentSeesImages && mime && bytes.length <= MAX_IMAGE_BYTES && images.length < MAX_IMAGES) {
        images.push({ t: "image", mime, data });
        notes.push(`[image ${images.length} attached below]`);
      } else {
        const why = !ctx.agentSeesImages ? "this model cannot view images" : !mime ? "unsupported image format" : "too large or too many to attach";
        notes.push(`[image (${String(c.mimeType ?? "?")}, ${Math.round(bytes.length / 1024)} KB) not shown — ${why}]`);
      }
    } else if (type === "audio") notes.push(`[audio (${String(c.mimeType ?? "?")}) not shown]`);
    else if (type === "resource") {
      const res = (c.resource ?? {}) as Record<string, unknown>;
      if (typeof res.text === "string") texts.push(`[resource ${String(res.uri ?? "")}]\n${res.text}`);
      else notes.push(`[binary resource ${String(res.uri ?? "")} (${String(res.mimeType ?? "?")}) not shown]`);
    } else if (type === "resource_link") notes.push(`[resource link ${String(c.uri ?? "")}${c.name ? ` — ${String(c.name)}` : ""}]`);
  }
  // structuredContent 与文本里那段 JSON 一样就不重复带（很多服务两份都给）
  if (r.structuredContent !== undefined && !texts.some((t) => sameJson(t, r.structuredContent))) texts.push(JSON.stringify(r.structuredContent));
  let body = [...texts, ...notes].join("\n\n").trim() || "(the tool returned no content)";
  const total = body.length;
  if (total > MAX_RESULT_CHARS) body = `${body.slice(0, MAX_RESULT_CHARS)}\n\n[truncated — the tool returned ${total} characters; ask for less (a narrower query, a page, a limit) if you need the rest]`;
  const isError = r.isError === true;
  return {
    ok: !isError,
    summary: `${server.key}.${tool}${isError ? " (error)" : ""}`,
    outcome: isError ? "返回错误" : `返回 ${total} 字${images.length ? ` · ${images.length} 张图` : ""}`,
    content: [{ t: "text", text: body }],
    ...(images.length ? { feedback: images } : {}),
    externalContent: true,
  };
}

async function runCall(server: McpBaselineServer, tool: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
  let out;
  try {
    out = await callMcpTool(server.id, tool, args, { ...(ctx.signal ? { signal: ctx.signal } : {}) });
  } catch (e) {
    if (ctx.signal?.aborted) return fail(`${server.key}.${tool} stopped`, "Stopped by the user before the connector answered.");
    return fail(`${server.key}.${tool} failed`, `The MCP call failed: ${redact((e as Error).message)}`);
  }
  if (out.kind === "removed") {
    return fail(
      `${server.key} removed`,
      `The connector "${server.name}" has been removed from the Bridge extension center, disabled, or is no longer enabled for dimensio. Its tools stay listed in this conversation but no longer work — tell the user; a new conversation picks up the current connectors.`,
    );
  }
  if (out.kind === "unavailable") {
    return fail(`${server.key} unavailable`, `The connector "${server.name}" is not reachable right now (${out.error}). Try again later or tell the user.`);
  }
  return mcpResult(server, tool, out.result as CallResultLike, ctx);
}

const argsPreview = (server: { name: string }, tool: string, args: unknown): ApprovalPreview => {
  const json = JSON.stringify(args ?? {}, null, 2) ?? "{}";
  return { kind: "text", text: `${server.name} · ${tool}\n${clip(json, 4_000)}`, ...(json.length > 4_000 ? { truncated: true } : {}) };
};

function confirmCall(server: { name: string }, tool: string, args: unknown): PreparedCall {
  return {
    confirm: {
      reason: `MCP tool ${tool} of connector "${server.name}" is not marked read-only`,
      why: `连接器「${server.name}」的工具「${tool}」没有声明只读，可能会改动外部的数据或替你发出东西`,
    },
    preview: argsPreview(server, tool, args),
  };
}

function directTool(server: McpBaselineServer, t: McpToolInfo, name: string): Tool {
  const label = t.title && t.title !== t.name ? `${t.title}: ` : "";
  return {
    def: {
      name,
      description: clip(`[MCP connector "${server.name}"] ${label}${t.description || t.name}`, 1_024),
      parameters: sanitizeInputSchema(t.inputSchema),
    },
    effect: t.readOnly ? "read" : "write",
    concurrencySafe: t.readOnly,
    ...(t.readOnly ? {} : { prepare: (args: Record<string, unknown>) => confirmCall(server, t.name, args) }),
    run: (args, ctx) => runCall(server, t.name, args, ctx),
  };
}

// ── E2 网关 ──────────────────────────────────────────────────────────────────
function gatewayTools(servers: McpBaselineServer[]): Tool[] {
  const byKey = new Map(servers.map((s) => [s.key.toLowerCase(), s]));
  const find = (key: unknown) => byKey.get(String(key ?? "").trim().toLowerCase());
  const liveTool = (s: McpBaselineServer | undefined, tool: unknown) => (s ? liveTools(s.id)?.find((t) => t.name === String(tool ?? "")) : undefined);
  const listing = servers.map((s) => `${s.key} ("${s.name}", ${s.toolCount} tools)${s.description ? ` — ${clip(s.description, 160)}` : ""}`).join("; ");
  const unknown = (key: unknown) =>
    fail("unknown connector", `No gateway connector "${String(key ?? "")}". Connectors: ${servers.map((s) => s.key).join(", ")}.`);

  const describe: Tool = {
    def: {
      name: "McpDescribe",
      description: clip(
        `List the tools of an MCP connector reached through the gateway (connectors with many tools are not listed one by one), or show one tool's description and full input schema — then run it with McpCall. Connectors: ${listing}.`,
        1_024,
      ),
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "Connector key as listed." },
          tool: { type: "string", description: "A tool name to see its input schema; omit to list the connector's tools." },
        },
        required: ["server"],
      },
    },
    effect: "read",
    concurrencySafe: true,
    async run(args) {
      const s = find(args.server);
      if (!s) return unknown(args.server);
      const tools = liveTools(s.id);
      if (!tools) return fail(`${s.key} unavailable`, `The connector "${s.name}" is not connected right now (removed, disabled, or unreachable). Tell the user if it matters.`);
      if (args.tool !== undefined && String(args.tool).trim()) {
        const t = tools.find((x) => x.name === String(args.tool));
        if (!t) return fail(`${s.key}: no tool ${String(args.tool)}`, `The connector "${s.name}" has no tool "${String(args.tool)}". Tools: ${tools.map((x) => x.name).join(", ")}.`);
        const schema = JSON.stringify(sanitizeInputSchema(t.inputSchema), null, 2);
        return {
          ok: true,
          summary: `${s.key}.${t.name} schema`,
          content: [{ t: "text", text: `${t.name}${t.title ? ` (${t.title})` : ""}${t.readOnly ? " — read-only" : " — may change things; the user approves each call"}\n${t.description}\n\nInput schema:\n${clip(schema, 12_000)}` }],
        };
      }
      const rows = tools.slice(0, 200).map((t) => `- ${t.name}${t.readOnly ? " (read-only)" : ""} — ${clip((t.description || t.title || "").split("\n")[0], 160)}`);
      return {
        ok: true,
        summary: `${s.key}: ${tools.length} tools`,
        content: [{ t: "text", text: `Connector "${s.name}" (${s.key}) — ${tools.length} tools. McpDescribe({server, tool}) shows a tool's input schema; McpCall({server, tool, arguments}) runs it.\n${rows.join("\n")}${tools.length > 200 ? `\n…and ${tools.length - 200} more` : ""}` }],
      };
    },
  };

  const call: Tool = {
    def: {
      name: "McpCall",
      description: "Run a tool of an MCP connector reached through the gateway. Look the tool up with McpDescribe first and pass arguments matching its input schema.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "Connector key (see McpDescribe)." },
          tool: { type: "string", description: "Tool name exactly as McpDescribe lists it." },
          arguments: { type: "object", description: "The tool's input, matching its schema." },
        },
        required: ["server", "tool"],
      },
    },
    effect: "write",
    concurrencySafe: false,
    // 按这次要调的那个工具定：声明了只读的按只读走，其余先问
    permissionView: (args) => (liveTool(find(args.server), args.tool)?.readOnly ? { effect: "read" } : null),
    prepare: (args) => {
      const s = find(args.server);
      if (!s) return null;
      return liveTool(s, args.tool)?.readOnly ? null : confirmCall(s, String(args.tool ?? ""), args.arguments);
    },
    async run(args, ctx) {
      const s = find(args.server);
      if (!s) return unknown(args.server);
      const tool = String(args.tool ?? "").trim();
      if (!tool) return fail("no tool", "Give the tool name (see McpDescribe).");
      const input = args.arguments && typeof args.arguments === "object" && !Array.isArray(args.arguments) ? (args.arguments as Record<string, unknown>) : {};
      return runCall(s, tool, input, ctx);
    },
  };
  return [describe, call];
}

// 会话的 MCP 工具（基线里没有就是空的）
export function mcpTools(baseline: McpBaseline | null | undefined): Tool[] {
  if (!baseline?.servers.length) return [];
  const out: Tool[] = [];
  const names = new Set<string>();
  for (const s of baseline.servers) {
    if (s.mode !== "direct") continue;
    for (const t of s.tools ?? []) {
      const name = mcpToolName(s.key, t.name);
      if (names.has(name)) continue; // 同名（截断后撞上的极端情况）：后来的丢掉
      names.add(name);
      out.push(directTool(s, t, name));
    }
  }
  const gateway = baseline.servers.filter((s) => s.mode === "gateway");
  if (gateway.length) out.push(...gatewayTools(gateway));
  return out;
}
