// 手动冒烟（不进 npm test）：真 Edge + 真扩展，走 Browser 工具的 edge 全路径。
// 用法：先起一个加载了 harness/edge-extension 的 Edge，并把扩展地址指到 ws://127.0.0.1:8832/edge-link，然后
//   node --import ./server/test-setup.ts server/edge-tool.smoke.ts
import http from "node:http";
import os from "node:os";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { edgeHub, edgeLink } from "./edge-link.ts";
import { Sandbox } from "./sandbox.ts";
import { browserTool } from "./tools/browser.ts";
import { readPageTool } from "./tools/readpage.ts";
import { evalTool } from "./tools/evaljs.ts";
import { closeAllBrowserSessions } from "./cdp.ts";
import type { ToolContext } from "./tools/types.ts";

const OUT = process.env.EDGE_SMOKE_OUT || os.tmpdir();
const server = http.createServer((_q, s) => s.end());
server.on("upgrade", (req, socket) => {
  if (!edgeHub().handleUpgrade(req, socket)) socket.destroy();
});
await new Promise<void>((r) => server.listen(8832, "127.0.0.1", r));

const ctx: ToolContext = {
  sandbox: new Sandbox(os.tmpdir(), "workspace"),
  readFileState: new Map(),
  setTodos: () => {},
  limits: { bashTimeoutMs: 5_000, bashMaxTimeoutMs: 5_000 },
  agentSeesImages: true,
  ownerId: "smoke-owner",
};
const text = (r: { content: { t: string; text?: string }[] }) => r.content.map((b) => b.text ?? "").join("\n");
const step = async (name: string, tool: typeof browserTool, args: Record<string, unknown>) => {
  const r = await tool.run(args, ctx);
  console.log(`\n── ${name}: ${r.ok ? "ok" : "FAIL"} · ${r.summary}\n${text(r).slice(0, 700)}`);
  return r;
};

for (let i = 0; i < 60 && !edgeLink().connected; i++) await new Promise((r) => setTimeout(r, 500));
console.log("link:", JSON.stringify(edgeLink().snapshot()));

await step("edge", browserTool, { action: "edge", url: "https://example.com" });
await step("readpage", readPageTool, { filter: "interactive" });
await step("tab_new", browserTool, { action: "tab_new", url: "https://example.org" });
await step("tabs", browserTool, { action: "tabs" });
await step("tab_switch 1", browserTool, { action: "tab_switch", tab: "1" });
await step("click text", browserTool, { action: "click", text: "Learn more" });
await step("eval", evalTool, { js: "location.href" });
const shot = await step("screenshot", browserTool, { action: "screenshot" });
const img = shot.feedback?.find((b) => b.t === "image") as { data: string } | undefined;
if (img) writeFileSync(path.join(OUT, "agent-shot.png"), Buffer.from(img.data, "base64"));
await step("resize (refused)", browserTool, { action: "resize", preset: "mobile" });
await step("close", browserTool, { action: "close" });
await step("navigate after close → built-in browser", browserTool, { action: "navigate", url: "about:blank" });
closeAllBrowserSessions();
server.close();
process.exit(0);
