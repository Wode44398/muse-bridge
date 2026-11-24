// MCP 连接器的 resources（列出 resources/list、读取 resources/read）在会话里的用法。
//   · 走网关的连接器：并进 McpCall——保留工具名 resources/list、resources/read（MCP 的工具名不含「/」，撞不上真工具）。
//   · 直连的连接器（工具少，每个工具单独进清单）：一个小工具 McpResources（lean 下延迟加载）。
// 只有基线里记着「声明了 resources 能力」的连接器才出现这些（旧会话的基线没有这一项，工具清单与说明照旧）。
// 读回的内容按外部数据框定（tools/untrusted.ts），太长就截断、全文落进会话的 outputs 目录（tools/result-store.ts）给路径。
// 只读：列与读都不改连接器那边的东西，权限按只读工具走。
import { listMcpResources, readMcpResource, redact } from "../mcp.ts";
import { redactOutput } from "../redact.ts";
import { persistOutput, savedHint } from "./result-store.ts";
import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail } from "./types.ts";
import { MCP_RESOURCE_NOTE } from "./untrusted.ts";

export const RESOURCE_LIST = "resources/list";
export const RESOURCE_READ = "resources/read";
export const MCP_RESOURCES_TOOL = "McpResources";
export const MAX_RESOURCE_CHARS = 30_000;

export interface ResourceServer {
  id: string;
  key: string;
  name: string;
  resources?: true;
}

export const isResourceCall = (tool: unknown): boolean => tool === RESOURCE_LIST || tool === RESOURCE_READ;

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

function outcomeFail(server: ResourceServer, out: { kind: "removed" } | { kind: "unavailable"; error: string } | { kind: "no-resources" }): ToolRunResult {
  if (out.kind === "removed") {
    return fail(`${server.key} removed`, `The connector "${server.name}" has been removed, disabled, or is no longer enabled for dimensio. Tell the user; a new conversation picks up the current connectors.`);
  }
  if (out.kind === "no-resources") return fail(`${server.key}: no resources`, `The connector "${server.name}" does not offer resources (any more).`);
  return fail(`${server.key} unavailable`, `The connector "${server.name}" is not reachable right now (${out.error}). Try again later or tell the user.`);
}

async function listResources(server: ResourceServer, cursor: string | undefined, ctx: ToolContext): Promise<ToolRunResult> {
  // 连接器回 JSON-RPC 错误 / 超时时 SDK 会抛：错误文本是连接器给的任意文字，照 readResource 脱敏截断再交给模型
  let out;
  try {
    out = await listMcpResources(server.id, cursor, { ...(ctx.signal ? { signal: ctx.signal } : {}) });
  } catch (e) {
    if (ctx.signal?.aborted) return fail(`${server.key} stopped`, "Stopped by the user before the connector answered.");
    return fail(`${server.key}: list failed`, `Listing the resources of "${server.name}" failed: ${redact((e as Error).message)}`);
  }
  if (out.kind !== "result") return outcomeFail(server, out);
  const { resources, nextCursor } = out.result;
  const rows = resources.map((r) => {
    const label = r.title || r.name;
    const meta = [r.mimeType, typeof r.size === "number" ? `${r.size} bytes` : ""].filter(Boolean).join(", ");
    return `- ${r.uri}${label && label !== r.uri ? ` — ${clip(label, 120)}` : ""}${meta ? ` (${meta})` : ""}${r.description ? `: ${clip(r.description.split("\n")[0], 160)}` : ""}`;
  });
  const more = nextCursor ? `\nMore resources: pass cursor "${nextCursor}" to list the next page.` : "";
  const text = resources.length
    ? `Connector "${server.name}" (${server.key}) — ${resources.length} resource${resources.length === 1 ? "" : "s"}:\n${rows.join("\n")}${more}`
    : `Connector "${server.name}" (${server.key}) lists no resources.${more}`;
  return {
    ok: true,
    summary: `${server.key}: ${resources.length} resources`,
    outcome: `列出 ${resources.length} 个资源`,
    content: [{ t: "text", text: redactOutput(text) }],
    externalContent: true,
  };
}

async function readResource(server: ResourceServer, uri: string, ctx: ToolContext): Promise<ToolRunResult> {
  if (!uri) return fail("no uri", `Give the uri of the resource to read (${RESOURCE_LIST} lists them).`);
  let out;
  try {
    out = await readMcpResource(server.id, uri, { ...(ctx.signal ? { signal: ctx.signal } : {}) });
  } catch (e) {
    if (ctx.signal?.aborted) return fail(`${server.key} stopped`, "Stopped by the user before the connector answered.");
    return fail(`${server.key}: read failed`, `Reading ${uri} failed: ${redact((e as Error).message)}`);
  }
  if (out.kind !== "result") return outcomeFail(server, out);
  const parts = out.result.map((c) =>
    c.text !== undefined
      ? `[resource ${c.uri}${c.mimeType ? ` (${c.mimeType})` : ""}]\n${c.text}`
      : `[binary resource ${c.uri} (${c.mimeType ?? "?"}, ${c.blobBytes ?? 0} bytes) not shown]`,
  );
  let body = redactOutput(parts.join("\n\n").trim() || "(the resource has no content)");
  const total = body.length;
  if (total > MAX_RESOURCE_CHARS) {
    const saved = persistOutput(ctx.ownerId, "mcp-resource", body);
    body = `${body.slice(0, MAX_RESOURCE_CHARS)}\n\n…[resource truncated — ${saved ? savedHint(saved, total) : `${total} chars in total; the full text could not be saved`}]`;
  }
  return {
    ok: true,
    summary: `${server.key}: read ${clip(uri, 80)}`,
    outcome: `读了资源 · ${total} 字`,
    content: [{ t: "text", text: `${MCP_RESOURCE_NOTE}\n\n${body}` }],
    externalContent: true,
  };
}

/** 网关 McpCall 的保留工具名 resources/list、resources/read。 */
export function runResourceCall(server: ResourceServer, tool: string, input: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> | ToolRunResult {
  if (!server.resources) return fail(`${server.key}: no resources`, `The connector "${server.name}" does not offer resources.`);
  if (tool === RESOURCE_LIST) return listResources(server, typeof input.cursor === "string" && input.cursor ? input.cursor : undefined, ctx);
  return readResource(server, typeof input.uri === "string" ? input.uri.trim() : "", ctx);
}

/** McpCall 说明里补的一句（只在有连接器声明了 resources 时）。 */
export function gatewayResourceNote(servers: ResourceServer[]): string {
  const keys = servers.filter((s) => s.resources).map((s) => s.key);
  return keys.length
    ? ` Connectors with resources (${keys.join(", ")}) also take tool "${RESOURCE_LIST}" (arguments {cursor?}) and "${RESOURCE_READ}" (arguments {uri}) to list and read the data they expose.`
    : "";
}

/** 直连连接器里声明了 resources 的：一个 McpResources 小工具（没有就是 null）。 */
export function resourcesTool(servers: ResourceServer[]): Tool | null {
  const withResources = servers.filter((s) => s.resources);
  if (!withResources.length) return null;
  const byKey = new Map(withResources.map((s) => [s.key.toLowerCase(), s]));
  const listing = withResources.map((s) => `${s.key} ("${s.name}")`).join(", ");
  return {
    def: {
      name: MCP_RESOURCES_TOOL,
      description: clip(
        `List or read the resources (files, records, documents) that MCP connectors expose. action "list" lists a connector's resources; "read" returns one by uri. Connectors: ${listing}.`,
        1_024,
      ),
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "Connector key as listed." },
          action: { type: "string", enum: ["list", "read"], description: '"list" (default) or "read".' },
          uri: { type: "string", description: "Resource uri to read (from list)." },
          cursor: { type: "string", description: "Next-page cursor from a previous list." },
        },
        required: ["server"],
      },
    },
    effect: "read",
    concurrencySafe: true,
    async run(args, ctx) {
      const s = byKey.get(String(args.server ?? "").trim().toLowerCase());
      if (!s) return fail("unknown connector", `No connector with resources named "${String(args.server ?? "")}". Connectors: ${withResources.map((x) => x.key).join(", ")}.`);
      const read = args.action === "read" || (args.action === undefined && typeof args.uri === "string" && args.uri.trim() !== "");
      return runResourceCall(s, read ? RESOURCE_READ : RESOURCE_LIST, args, ctx);
    },
  };
}
