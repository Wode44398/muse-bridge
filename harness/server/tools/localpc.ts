import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { bridgeRootCandidates } from "../paths.ts";
import type { Tool, ToolRunResult } from "./types.ts";
import { ok, fail } from "./types.ts";
import { screenshotEvent } from "../image-assets.ts";

type Grant = { mode: "off" | "observe" | "control"; url: string; token: string; pid: number };

// null \u53EA\u4F1A\u51FA\u73B0\u5728\u6D4B\u8BD5\u8FDB\u7A0B\u91CC\uFF08\u4E34\u65F6\u76EE\u5F55\u4E4B\u5916\u7684 bridge \u6570\u636E\u6839\u4E00\u6982\u4E0D\u8BA4\uFF0C\u89C1 paths.ts\uFF09\u3002
function descriptorPath(): string | null {
  if (process.env.BRIDGE_LOCAL_PC_DESCRIPTOR) return path.resolve(process.env.BRIDGE_LOCAL_PC_DESCRIPTOR);
  const files = bridgeRootCandidates({ withHarnessDir: true }).map((root) => path.join(root, "local-pc-broker.json"));
  return files.find((file) => existsSync(file)) || files[0] || null;
}

function readDescriptor(): Record<string, unknown> | null {
  const file = descriptorPath();
  if (!file) return null;
  try { return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, "")); }
  catch { return null; }
}

function readGrant(): Grant | null {
  const raw = readDescriptor();
  if (!raw) return null;
  const mode = raw.mode === "control" ? "control" : raw.mode === "observe" ? "observe" : "off";
  const url = String(raw.url || "").replace(/\/+$/, "");
  const token = String(raw.token || "");
  const pid = Number(raw.pid);
  if (mode === "off" || !/^http:\/\/127\.0\.0\.1:\d+$/i.test(url) || token.length < 24 || !Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); } catch { return null; }
  return { mode, url, token, pid };
}

export function localPcToolAvailable(): boolean {
  // Keep the tools visible while the App broker descriptor exists, including
  // mode=off, so a user can enable it without restarting the harness session.
  const file = descriptorPath();
  return Boolean(file && existsSync(file));
}

async function callBroker(action: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const raw = readDescriptor();
  if (!raw) throw new Error("Bridge desktop App is not running or Local-PC capability is unavailable.");
  const url = String(raw.url || "").replace(/\/+$/, "");
  const token = String(raw.token || "");
  if (!/^http:\/\/127\.0\.0\.1:\d+$/i.test(url) || token.length < 24) throw new Error("Local-PC capability descriptor is invalid.");
  const response = await fetch(url + "/op", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ action, args, source: "dimensio" }),
    signal: AbortSignal.timeout(45_000),
  });
  let data: Record<string, unknown>;
  try { data = await response.json() as Record<string, unknown>; } catch { data = {}; }
  if (!response.ok || data.ok === false) throw new Error(String(data.error || `Local-PC broker returned ${response.status}`));
  return (data.result || {}) as Record<string, unknown>;
}

async function brokerState(): Promise<Record<string, unknown>> {
  const grant = readGrant();
  if (!grant) throw new Error("Local-PC is off. Enable observe/control in the Bridge desktop App settings.");
  const response = await fetch(grant.url + "/state", {
    headers: { Authorization: `Bearer ${grant.token}` },
    signal: AbortSignal.timeout(3000),
  });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(String(data.error || `Local-PC broker returned ${response.status}`));
  return data;
}

const inspectActions = ["active_window", "windows", "processes", "displays", "cursor", "screenshot", "uia_tree"];
const actActions = ["launch", "focus_window", "set_window", "close_window", "move", "click", "double_click", "right_click", "scroll", "type", "key", "uia_action"];
const uiaActions = ["focus", "invoke", "set_value", "select", "toggle", "expand", "collapse", "scroll_into_view"];

export const localPcInspectTool: Tool = {
  effect: "read",
  concurrencySafe: false,
  enabled: localPcToolAvailable,
  def: {
    name: "LocalPCInspect",
    description:
      "Observe the current Windows PC through the Bridge desktop App. Call action=status first. Prefer uia_tree " +
      "for semantic controls and stable refs; use screenshot only when UI Automation cannot see a custom/WebView UI. " +
      "Actions: status | active_window | windows | processes | displays | cursor | screenshot | uia_tree. " +
      "This tool never clicks or changes the desktop. The user sees a persistent native banner and can emergency-stop.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", ...inspectActions] },
        window: { type: "number", description: "Target hwnd for uia_tree/screenshot; omit for foreground window/main display." },
        display: { type: "integer", description: "Screenshot display index; -1 captures the virtual desktop." },
        grid: { type: "boolean", description: "Overlay a red coordinate grid on screenshots." },
        depth: { type: "integer", minimum: 0, maximum: 8, description: "UIA tree depth; default 4." },
        max: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum UIA/process/window rows." },
        query: { type: "string", description: "Optional process/window filter." },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  async run(args, ctx): Promise<ToolRunResult> {
    try {
      if (args.action === "status") return ok("local PC status", JSON.stringify(await brokerState(), null, 2));
      const action = String(args.action || "");
      if (!inspectActions.includes(action)) return fail("local PC inspect", `Unknown inspect action: ${action}`);
      const result = await callBroker(action, args);
      if (action === "screenshot") {
        const image = String(result.image || "");
        const mime = String(result.mimeType || "image/jpeg");
        return {
          ok: true,
          summary: `desktop screenshot ${result.w || "?"}×${result.h || "?"}`,
          content: [{ t: "text", text: `Captured the current Windows desktop (${result.w}×${result.h}); inspect the attached image.` }],
          feedback: image ? [{ t: "image", mime, data: image }] : undefined,
          // R12（二）：给界面的截图存成会话资产、事件只带 id
          events: image
            ? [mime === "image/png" || mime === "image/jpeg" || mime === "image/webp"
              ? screenshotEvent(ctx.ownerId, Buffer.from(image, "base64"), mime, "desktop://local")
              : { e: "screenshot", dataUri: `data:${mime};base64,${image}`, url: "desktop://local" }]
            : undefined,
        };
      }
      const q = String(args.query || "").toLowerCase();
      if (q && Array.isArray(result.windows)) result.windows = result.windows.filter((v) => JSON.stringify(v).toLowerCase().includes(q));
      if (q && Array.isArray(result.processes)) result.processes = result.processes.filter((v) => JSON.stringify(v).toLowerCase().includes(q));
      return ok(`local PC ${action}`, JSON.stringify(result, null, 2));
    } catch (e) {
      return fail("local PC inspect", (e as Error).message);
    }
  },
};

export const localPcActTool: Tool = {
  effect: "exec",
  concurrencySafe: false,
  enabled: localPcToolAvailable,
  def: {
    name: "LocalPCAct",
    description:
      "Operate the current Windows PC. The Electron broker only allows this while the user selected CONTROL mode; " +
      "observe/off is hard-denied. Prefer uia_action with a ref from the latest LocalPCInspect(uia_tree); use pixel " +
      "coordinates only as fallback and inspect again after every UI change. Before sending messages, deleting, buying, " +
      "changing security settings, or closing unsaved work, use AskUserQuestion for confirmation. " +
      "Actions: launch | focus_window | set_window | close_window | move | click | double_click | right_click | scroll | type | key | uia_action.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: actActions },
        file: { type: "string" }, args: { type: "array", items: { type: "string" } }, cwd: { type: "string" },
        window: { type: "number" }, x: { type: "number" }, y: { type: "number" },
        w: { type: "number" }, h: { type: "number" },
        button: { type: "string", enum: ["left", "right", "middle"] },
        amount: { type: "number" }, text: { type: "string" }, keys: { type: "string" },
        ref: { type: "integer" }, uiaAction: { type: "string", enum: uiaActions }, value: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
  async run(args) {
    try {
      const action = String(args.action || "");
      if (!actActions.includes(action)) return fail("local PC action", `Unknown action: ${action}`);
      const payload = action === "uia_action"
        ? { ...args, action: args.uiaAction, ref: args.ref, value: args.value }
        : args;
      return ok(`local PC ${action}`, JSON.stringify(await callBroker(action, payload), null, 2));
    } catch (e) {
      return fail("local PC action", (e as Error).message);
    }
  },
};

