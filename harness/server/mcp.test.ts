// E1（G6、K58、X57）+ E2（K59）：MCP 客户端 MVP 与大连接器网关。
//
// 修前：dimensio 是三个 agent 里唯一没有 MCP 的——扩展中心里连接器那一格对它是灰的，勾不上、也用不了。
// 修后：勾给 dimensio 的连接器（stdio / http / sse）进一个进程级共享池；新会话拍基线（连上的连接器 + 直连工具定义）随会话
// 落盘，工具清单从此不变；声明了只读的直接用，其余要人批准；工具多的连接器走 McpDescribe + McpCall 网关；连接器被删了，
// 老会话里的工具回「已移除」、子进程收掉。凭据只经连接器的 env / 请求头进去，harness 自己的密钥变量不传下去。
// 全部是假注册表、假凭据（DUMMY）、本机夹具服务（test-harness/mcp-fixture-server.mjs 与进程内的 HTTP 服务），不连真实连接器。
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { afterEach, beforeEach } from "node:test";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callSubject, sessionAllowRule } from "./agent/permissions.ts";
import type { Block, Msg } from "./agent/turn.ts";
import { setConfig } from "./config.ts";
import { mcpPidForTests, mcpReady, mcpStatus, redact, resetMcpPoolForTests, setMcpSecretsReaderForTests, syncConnectors } from "./mcp.ts";
import { getOrLoadSession, resolvePermission, sessionRecord, startRun, watchSession } from "./session.ts";
import { saveSession, type PersistedSession } from "./store.ts";
import { call, calls, say, scripted } from "./test-harness/scripted-adapter.ts";
import { attachSession } from "./test-harness/session-fixture.ts";
import { mcpResult, mcpToolName, mcpTools, planMcpBaseline, sanitizeInputSchema } from "./tools/mcp.ts";
import type { ToolContext } from "./tools/types.ts";

const FIXTURE = fileURLToPath(new URL("./test-harness/mcp-fixture-server.mjs", import.meta.url));

let tmp = "";
let extRoot = "";
const savedFile = process.env.BRIDGE_EXTENSIONS_FILE;

interface FakeConnector {
  id: string;
  name: string;
  key: string;
  transport: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  envKeys?: string[];
  headerKeys?: string[];
  dimensio?: boolean;
}

function install(conns: FakeConnector[]): void {
  const items = conns.map((c) => ({
    id: c.id, type: "connector", name: c.name, description: `${c.name} (test)`, enabled: true,
    agents: { claude: true, dimensio: c.dimensio ?? true, codex: false },
    connector: {
      key: c.key, transport: c.transport,
      ...(c.transport === "stdio" ? { command: c.command, args: c.args ?? [] } : { url: c.url }),
      ...(c.envKeys ? { envKeys: c.envKeys } : {}),
      ...(c.headerKeys ? { headerKeys: c.headerKeys } : {}),
    },
  }));
  fs.writeFileSync(path.join(extRoot, "registry.json"), JSON.stringify({ items }));
}
const stdio = (id: string, key: string, envKeys?: string[]): FakeConnector => ({
  id, name: `Fixture ${key}`, key, transport: "stdio", command: process.execPath, args: [FIXTURE], ...(envKeys ? { envKeys } : {}),
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dimensio-e1-"));
  extRoot = path.join(tmp, "extensions");
  fs.mkdirSync(extRoot, { recursive: true });
  process.env.BRIDGE_EXTENSIONS_FILE = path.join(extRoot, "registry.json");
});

afterEach(async () => {
  await resetMcpPoolForTests();
  setMcpSecretsReaderForTests(null);
  if (savedFile === undefined) delete process.env.BRIDGE_EXTENSIONS_FILE;
  else process.env.BRIDGE_EXTENSIONS_FILE = savedFile;
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
});

const textOf = (blocks: Block[]): string => blocks.map((b) => (b.t === "text" ? b.text : b.t === "tool_result" ? textOf(b.content) : "")).join("");
const ctxFor = (seesImages = false) => ({ agentSeesImages: seesImages }) as unknown as ToolContext;
function resultOf(msgs: Msg[], id: string): { ok: boolean; text: string } {
  for (const m of msgs) for (const b of m.content) if (b.t === "tool_result" && b.id === id) return { ok: b.ok !== false, text: textOf(b.content) };
  assert.fail(`没有 ${id} 的结果`);
}

test("E1 stdio：勾给 dimensio 的连上、没勾的不连；只读的直接跑、没声明只读的要人批准；凭据只进这个子进程，harness 的密钥不漏；结果按外部内容记", async (t) => {
  const prevKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "DUMMY-harness-key-must-not-leak";
  t.after(() => {
    if (prevKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevKey;
  });
  install([stdio("c1", "fixture", ["FIXTURE_SECRET"]), { ...stdio("c2", "claude-only"), dimensio: false }]);
  setMcpSecretsReaderForTests(() => ({ c1: { env: { FIXTURE_SECRET: "DUMMY-e1-secret" } } }));
  await syncConnectors();
  await mcpReady(20_000);
  assert.deepEqual(mcpStatus().map((s) => `${s.key}:${s.status}:${s.tools}`), ["fixture:ready:5"], "没勾给 dimensio 的不连");

  const baseline = planMcpBaseline()!;
  assert.equal(baseline.servers.length, 1);
  assert.equal(baseline.servers[0].mode, "direct");
  const tools = mcpTools(baseline);
  assert.deepEqual(tools.map((x) => x.def.name), ["mcp__fixture__echo", "mcp__fixture__write_note", "mcp__fixture__image", "mcp__fixture__fail", "mcp__fixture__whoami"]);
  const echo = tools[0];
  assert.equal(echo.effect, "read");
  assert.equal(echo.concurrencySafe, true);
  assert.equal(echo.prepare, undefined);
  assert.equal((echo.def.parameters.properties.text as { type?: string }).type, "string", "$ref 就地展开");
  assert.ok(!JSON.stringify(echo.def.parameters).includes("$defs") && !JSON.stringify(echo.def.parameters).includes("$schema"));
  assert.match(echo.def.description, /^\[MCP connector "Fixture fixture"\] Echo the text back\./);
  assert.equal(tools[1].effect, "write");

  const adapter = scripted(t).next(
    calls(call("e1", "mcp__fixture__echo", { text: "你好" }), call("w1", "mcp__fixture__write_note", { note: "x" }), call("m1", "mcp__fixture__whoami", {})),
    say("好"),
  );
  const session = attachSession(adapter, tmp, { tools });
  const asks: Record<string, unknown>[] = [];
  const run = startRun(session, "试一下连接器");
  watchSession(session, (ev) => {
    if (ev.e !== "permission_ask") return;
    asks.push(ev);
    resolvePermission(session, String(ev.id), "once");
  });
  await run.done;
  const msgs = session.state!.messages;
  const e = resultOf(msgs, "e1");
  assert.ok(e.ok);
  assert.equal(e.text.split('"echo":"你好"').length - 1, 1, "structuredContent 与文本里的 JSON 一样，不重复带");
  assert.equal(asks.length, 1, "只有没声明只读的那一个要人批");
  assert.match(JSON.stringify(asks[0]), /write_note.*没有声明只读/);
  assert.match(JSON.stringify(asks[0]), /Fixture fixture · write_note/, "卡片上摆着这次的参数");
  const w = resultOf(msgs, "w1");
  assert.ok(w.ok, "批了才跑");
  assert.equal(w.text, "stored 1 note(s)");
  assert.equal(resultOf(msgs, "m1").text, JSON.stringify({ secret: true, harnessKeyLeaked: false }), "凭据经 env 进了子进程，harness 的密钥变量没传下去");
  assert.equal(session.state!.externalContentSeen, true, "MCP 回来的按外部内容记");
});

test("E1 基线随会话落盘、读回照旧；连接器后来被删了：工具还在清单里，调用回「已移除」，子进程收掉；E1 之前的会话读回不加 MCP 工具", async () => {
  install([stdio("c1", "fixture")]);
  await syncConnectors();
  await mcpReady(20_000);
  const baseline = planMcpBaseline()!;
  const pid = mcpPidForTests("c1");
  assert.ok(pid && pid > 0);

  setConfig({ provider: "openai", apiKey: "DUMMY-e1-key" }); // 读回要按记录里的 provider 建 adapter
  const ws = path.join(tmp, "ws");
  fs.mkdirSync(ws, { recursive: true });
  const rec = (id: string, withMcp: boolean): PersistedSession => ({
    v: 1, id, createdAt: 1, updatedAt: Date.now(), title: "t",
    config: { provider: "openai", model: "m", thinking: "off", permissionMode: "auto", workspace: ws, access: "workspace" },
    system: "s", messages: [], todos: [],
    totals: { inputTokens: 0, outputTokens: 0, lastContextTokens: 0 },
    gates: { dirtySinceVerify: false, editedFiles: [], ranCommands: [] },
    counters: { compactionFailures: 0, turnsSinceTodoSeen: 0 },
    ...(withMcp ? { mcp: baseline } : {}),
  });
  const id = `e1-${Date.now().toString(36)}`;
  await saveSession(rec(id, true));
  const session = (await getOrLoadSession(id))!;
  assert.ok(session.state!.toolMap.has("mcp__fixture__echo"), "读回照基线还原 MCP 工具");
  assert.deepEqual(sessionRecord(session)!.mcp, baseline, "再落盘时基线原样带着");
  const legacy = (await getOrLoadSession(await (async () => { const lid = `e1-old-${Date.now().toString(36)}`; await saveSession(rec(lid, false)); return lid; })()))!;
  assert.ok(![...legacy.state!.toolMap.keys()].some((n) => n.startsWith("mcp__")), "E1 之前的会话：工具清单与当初一致");

  install([]); // 连接器从扩展中心删掉
  await syncConnectors();
  assert.deepEqual(mcpStatus(), []);
  const r = await session.state!.toolMap.get("mcp__fixture__echo")!.run({ text: "x" }, session.state!.ctx);
  assert.equal(r.ok, false);
  assert.match(textOf(r.content), /removed from the Bridge extension center.*new conversation picks up the current connectors/s);
  // 收尸是 syncConnectors 里不等的后台动作，Windows 上要先起 PowerShell 取一次进程表（8 并发下常常不止一两秒）：轮询到它没了为止
  const alive = () => { try { process.kill(pid!, 0); return true; } catch { return false; } };
  for (const deadline = Date.now() + 30_000; alive() && Date.now() < deadline; ) await new Promise((res) => setTimeout(res, 100));
  assert.ok(!alive(), "stdio 子进程收掉了");
});

test("E2 网关：工具多的连接器不逐个进清单，走 McpDescribe + McpCall；按被调工具定只读与否，「本会话都允许」记到连接器/工具", async () => {
  install([stdio("c1", "fixture", ["FIXTURE_TOOLS"])]);
  setMcpSecretsReaderForTests(() => ({ c1: { env: { FIXTURE_TOOLS: "many" } } }));
  await syncConnectors();
  await mcpReady(20_000);
  const baseline = planMcpBaseline()!;
  assert.equal(baseline.servers[0].mode, "gateway");
  assert.equal(baseline.servers[0].toolCount, 20);
  assert.equal(baseline.servers[0].tools, undefined, "网关背后的清单现取，不冻进基线");
  const tools = mcpTools(baseline);
  assert.deepEqual(tools.map((x) => x.def.name), ["McpDescribe", "McpCall"]);
  const [describe, mcall] = tools;
  assert.match(describe.def.description, /Connectors: fixture \("Fixture fixture", 20 tools\)/);

  const list = await describe.run({ server: "fixture" }, ctxFor());
  assert.ok(list.ok);
  assert.match(textOf(list.content), /20 tools/);
  assert.match(textOf(list.content), /- write_note — Store a note/);
  assert.match(textOf(list.content), /- echo \(read-only\)/);
  const schema = await describe.run({ server: "FIXTURE", tool: "echo" }, ctxFor());
  assert.match(textOf(schema.content), /"type": "string"/);
  assert.ok(!textOf(schema.content).includes("$defs"));

  assert.deepEqual(mcall.permissionView!({ server: "fixture", tool: "echo" }), { effect: "read" }, "只读工具按只读走");
  assert.equal(mcall.prepare!({ server: "fixture", tool: "echo" }, ctxFor()), null);
  assert.equal(mcall.permissionView!({ server: "fixture", tool: "write_note" }), null);
  const prep = (await mcall.prepare!({ server: "fixture", tool: "write_note", arguments: { note: "n" } }, ctxFor()))!;
  assert.match(prep.confirm!.why, /write_note.*没有声明只读/);
  assert.equal(sessionAllowRule("McpCall", callSubject("McpCall", { server: "fixture", tool: "write_note" })), "McpCall(=fixture/write_note)");

  const ran = await mcall.run({ server: "fixture", tool: "t03", arguments: { n: 3 } }, ctxFor());
  assert.ok(ran.ok);
  assert.equal(textOf(ran.content), "t03 ok (3)");
  const bad = await mcall.run({ server: "nope", tool: "t03" }, ctxFor());
  assert.equal(bad.ok, false);
  assert.match(textOf(bad.content), /No gateway connector "nope"\. Connectors: fixture/);
});

test("E1 HTTP（Streamable HTTP）：请求头凭据带上才连得上；换了凭据就换新连接；连不上的报错里没有令牌", async () => {
  let authorized = 0;
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer DUMMY-e1-token") {
      res.writeHead(401, { "content-type": "text/plain" }).end("unauthorized");
      return;
    }
    authorized++;
    if (req.method !== "POST") {
      res.writeHead(405).end();
      return;
    }
    const mcp = new Server({ name: "http-fixture", version: "1.0.0" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: "ping", description: "Ping the server.", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true } }],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: "text", text: "pong" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    install([{ id: "h1", name: "Web fixture", key: "web", transport: "http", url: `http://127.0.0.1:${port}/mcp`, headerKeys: ["Authorization"] }]);
    let token = "Bearer DUMMY-e1-token";
    setMcpSecretsReaderForTests(() => ({ h1: { headers: { Authorization: token } } }));
    await syncConnectors();
    await mcpReady(20_000);
    assert.deepEqual(mcpStatus().map((s) => `${s.key}:${s.transport}:${s.status}:${s.tools}`), ["web:http:ready:1"]);
    const ping = mcpTools(planMcpBaseline())[0];
    assert.equal(ping.def.name, "mcp__web__ping");
    const r = await ping.run({}, ctxFor());
    assert.equal(textOf(r.content), "pong");
    assert.ok(authorized > 0);

    token = "Bearer DUMMY-e1-wrong";
    await syncConnectors();
    await mcpReady(20_000);
    const [st] = mcpStatus();
    assert.equal(st.status, "failed", "凭据变了就换新连接——错的连不上");
    assert.ok(!JSON.stringify(mcpStatus()).includes("DUMMY-e1"), "状态与报错里没有令牌");
  } finally {
    await resetMcpPoolForTests();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("E1 结果与命名：图片只给看得见图的模型、isError 记失败、过长截断；长工具名截断补哈希不撞；循环 $ref 截成任意；报错去掉令牌", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const server = { key: "fx", name: "Fixture" };
  const withImage = { content: [{ type: "text", text: "看图" }, { type: "image", data: png, mimeType: "image/png" }] };
  const seen = mcpResult(server, "image", withImage, { agentSeesImages: true });
  assert.equal(seen.feedback?.length, 1);
  assert.equal(seen.outcome, `返回 ${textOf(seen.content).length} 字 · 1 张图`);
  const blind = mcpResult(server, "image", withImage, { agentSeesImages: false });
  assert.equal(blind.feedback, undefined);
  assert.match(textOf(blind.content), /image \(image\/png, 0 KB\) not shown — this model cannot view images/);
  const err = mcpResult(server, "fail", { content: [{ type: "text", text: "boom" }], isError: true }, { agentSeesImages: false });
  assert.equal(err.ok, false);
  assert.equal(err.externalContent, true);
  const big = mcpResult(server, "dump", { content: [{ type: "text", text: "x".repeat(40_000) }] }, { agentSeesImages: false });
  assert.match(textOf(big.content), /\[truncated — the tool returned 40000 characters/);
  assert.equal(mcpResult(server, "none", { content: [] }, { agentSeesImages: false }).content[0].t, "text");

  const a = mcpToolName("a-very-long-connector-name", "and_an_even_longer_tool_name_that_goes_on_and_on_1");
  const b = mcpToolName("a-very-long-connector-name", "and_an_even_longer_tool_name_that_goes_on_and_on_2");
  assert.ok(a.length <= 64 && b.length <= 64 && a !== b, `${a} / ${b}`);
  assert.equal(mcpToolName("gh", "issues.list"), "mcp__gh__issues_list");

  const cyclic = sanitizeInputSchema({ type: "object", properties: { node: { $ref: "#/$defs/Node" } }, $defs: { Node: { type: "object", properties: { next: { $ref: "#/$defs/Node" } } } } });
  assert.ok(JSON.stringify(cyclic).length < 2_000, "循环引用有深度上限");
  assert.deepEqual(sanitizeInputSchema(undefined), { type: "object", properties: {} });

  assert.equal(redact("fetch https://mcp.example.com/sse?token=abc123 failed: Bearer abcdefghijkl"), "fetch https://mcp.example.com/sse?… failed: Bearer …");
});
