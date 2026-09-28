// E1 测试用的 MCP 服务（stdio，真协议，用 SDK 的底层 Server）。环境变量：
//   FIXTURE_TOOLS=many   给 20 个工具（走网关）；默认给 5 个（直连）
//   FIXTURE_SECRET       凭据经连接器的 env 传进来——whoami 报告拿没拿到（只报布尔，不回显值）
// 工具：echo（只读）、write_note（没声明只读）、image（回一张 1×1 PNG）、fail（isError）、whoami（只读）；many 模式另加 t01…t15。
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const PNG_1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const notes = [];

const base = [
  {
    name: "echo",
    description: "Echo the text back.",
    inputSchema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", properties: { text: { $ref: "#/$defs/Text" } }, required: ["text"], $defs: { Text: { type: "string", description: "What to echo" } } },
    annotations: { readOnlyHint: true },
  },
  { name: "write_note", description: "Store a note on the server.", inputSchema: { type: "object", properties: { note: { type: "string" } }, required: ["note"] } },
  { name: "image", description: "Return a tiny image.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
  { name: "whoami", description: "Report whether the connector credential reached the server.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } },
];
const extra = process.env.FIXTURE_TOOLS === "many"
  ? Array.from({ length: 15 }, (_, i) => ({ name: `t${String(i + 1).padStart(2, "0")}`, description: `Extra tool number ${i + 1}.`, inputSchema: { type: "object", properties: { n: { type: "number" } } }, annotations: { readOnlyHint: true } }))
  : [];
const tools = [...base, ...extra];

const server = new Server({ name: "fixture", version: "1.0.0" }, { capabilities: { tools: {} }, instructions: "Fixture server for dimensio tests." });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  switch (name) {
    case "echo":
      return { content: [{ type: "text", text: JSON.stringify({ echo: args.text }) }], structuredContent: { echo: args.text } };
    case "write_note":
      notes.push(String(args.note ?? ""));
      return { content: [{ type: "text", text: `stored ${notes.length} note(s)` }] };
    case "image":
      return { content: [{ type: "text", text: "here is the image" }, { type: "image", data: PNG_1x1, mimeType: "image/png" }] };
    case "fail":
      return { content: [{ type: "text", text: "something went wrong on the server" }], isError: true };
    case "whoami":
      return { content: [{ type: "text", text: JSON.stringify({ secret: process.env.FIXTURE_SECRET === "DUMMY-e1-secret", harnessKeyLeaked: Boolean(process.env.OPENAI_API_KEY) }) }] };
    default:
      if (/^t\d\d$/.test(name)) return { content: [{ type: "text", text: `${name} ok (${args.n ?? "-"})` }] };
      return { content: [{ type: "text", text: `unknown tool ${name}` }], isError: true };
  }
});
await server.connect(new StdioServerTransport());
