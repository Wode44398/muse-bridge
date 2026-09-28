import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { ok, fail } from "./types.ts";
import { commandPolicyViolation } from "./bash.ts";
import { browserAvailable } from "../headless.ts";
import {
  startService,
  stopService,
  getService,
  latestService,
  renderLogs,
  publicPreviewUrl,
  type Service,
} from "../services.ts";

// The Preview tool: pure server lifecycle — run a web server WITHOUT blocking,
// show it in the user's live preview pane, and read its runtime logs.
// Backgrounding a server with Bash (`node server.js &`) keeps the shell's
// output pipe open and hangs the tool until timeout — this tool is the correct
// way to run one. Interacting with the app (navigate/click/screenshot/…) moved
// to the Browser/ReadPage/Eval/Network tools, which drive a real browser.

function urlFor(port: number, path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  return `http://localhost:${port}${p}`;
}

// Without an explicit id, "the" service means THIS session's newest one — never
// another concurrent session's (an unscoped pick made logs/stop/restart act on
// whatever server happened to start last, process-wide). An explicit id from
// another owner is refused for the same reason.
function resolveService(args: Record<string, unknown>, owner: string): Service | undefined {
  if (args.id) {
    const s = getService(String(args.id));
    return s && s.owner === owner ? s : undefined;
  }
  return latestService(owner);
}

export const previewTool: Tool = {
  effect: "exec",
  concurrencySafe: false,
  def: {
    name: "Preview",
    description:
      "Start and manage a long-running web server for the app you are building. This is the ONLY correct " +
      "way to run a server — do NOT background one with Bash (`node server.js &` / `npm run dev &`), which " +
      "hangs. Actions:\n" +
      "• start — launch `command` in the background, wait until `port` is listening, and light up a " +
      "\"预览\" button in the user's browser pane (they share YOUR browser and can pull the app up in it). " +
      "Returns startup logs.\n" +
      "• logs — the SERVER's recent stdout/stderr (crashes, 500s, request logs).\n" +
      "• stop — kill the server.\n" +
      "To interact with the running app — open pages, click, type, screenshot, assert DOM state, audit " +
      "API calls — use Browser / ReadPage / Eval / Network when they are available (Browser(navigate, url:\"/\") " +
      "targets this server directly); otherwise exercise it with Bash + curl.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["start", "logs", "stop"],
          description: "start | logs | stop",
        },
        command: {
          type: "string",
          description: "Shell command that starts the server (for action=start), e.g. \"node server.js\".",
        },
        port: {
          type: "integer",
          description: "Port the server listens on (for action=start). Used for readiness and the preview URL.",
        },
        path: {
          type: "string",
          description: "URL path for the user's preview pane (for action=start). Default \"/\".",
        },
        id: {
          type: "string",
          description: "Service id from a previous start. Defaults to the most recent server.",
        },
        lines: {
          type: "integer",
          description: "How many recent log lines to return (for action=logs). Default 120.",
        },
      },
      required: ["action"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const action = String(args.action ?? "").trim();
    const owner = ctx.ownerId ?? "";

    if (action === "start") {
      const command = String(args.command ?? "").trim();
      const port = Number(args.port);
      if (!command) return fail("preview", "action=start requires a `command`.");
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return fail("preview", "action=start requires a valid `port`.");
      }
      // #67：start 的命令和 Bash 过同一道闸（危险名单、宿主自保、工作区围栏与凭据判定）——
      // 以前这里一道都不过，是绕开全部 Bash 策略的旁路。
      const policy = commandPolicyViolation(command, ctx.sandbox.root, ctx.sandbox.access, ctx.sandbox.grantedReadRoots());
      if (policy) return fail("preview", policy);
      const path = String(args.path ?? "/");

      let s: Service;
      try {
        s = await startService(
          { command, port, cwd: ctx.sandbox.root, name: command, owner },
          ctx.signal,
        );
      } catch (e) {
        // 端口被宿主进程树（bridge / 本 harness）占着：不能为了「重启 app」把宿主连根杀掉。
        // 明确告诉模型换端口，而不是抛成一次莫名的工具异常。
        if ((e as Error)?.name === "PortHeldByHostError") return fail(`port ${port} belongs to the host`, (e as Error).message);
        throw e;
      }
      const url = urlFor(port, path);
      // The iframe points at the proxy (which injects the browser probe); the
      // display URL stays the real app port for the user's "open in new tab".
      const frameUrl = s.proxy ? urlFor(s.proxy.port, path) : url;
      // Tunnel-backed https URL any of the user's devices can open directly
      // (localhost means nothing on their phone). Null without PV_PUBLIC_DOMAIN.
      const publicUrl = publicPreviewUrl(s);
      const logTail = renderLogs(s, 40);

      if (s.status === "exited") {
        return fail(
          `server exited (${command.slice(0, 40)})`,
          `The server process exited before the port came up (exit code ${s.exitCode}).\n` +
            `Startup output:\n${logTail}\n\nFix the error and start it again.`,
        );
      }

      const upNote =
        s.status === "up"
          ? `Server is up and listening on port ${port}.`
          : `Server process is running but port ${port} did not accept a connection within 15s ` +
            `(it may still be starting, or it listens on a different port). Check the logs.`;

      return {
        ok: s.status === "up",
        summary: `preview ${s.status === "up" ? "up" : "starting"} → ${url} (id ${s.id})`,
        content: [
          {
            t: "text",
            text:
              `${upNote}\nService id: ${s.id}\nPreview URL: ${url}\n` +
              (publicUrl
                ? `Public URL (works on the user's phone or any external browser): ${publicUrl}\n`
                : "") +
              `The user's browser pane now shows a "预览" button that opens this app in the shared browser.\n\n` +
              `Startup logs:\n${logTail}\n\n` +
              `Next: test endpoints with Bash (curl), Preview(action:"logs") for the server side` +
              (browserAvailable()
                ? `, and Browser(navigate, url:"${path}") → ReadPage → click/type → Eval/screenshot to exercise the real UI.`
                : ".") +
              ` Stop it with Preview(action:"stop") when finished.`,
          },
        ],
        events: [{ e: "preview", url, frameUrl, port, serviceId: s.id, ...(publicUrl ? { publicUrl } : {}) }],
      };
    }

    if (action === "logs") {
      const s = resolveService(args, owner);
      if (!s) return fail("preview logs", "No running server found. Start one with action=start.");
      const lines = Math.max(1, Math.min(600, Number(args.lines ?? 120)));
      const statusNote =
        s.status === "exited" ? `\n\n[!] This server has exited (code ${s.exitCode}).` : "";
      return ok(
        `logs ${s.id} (${s.status})`,
        `Server ${s.id} (${s.command.slice(0, 50)}) — status: ${s.status}\n\n${renderLogs(s, lines)}${statusNote}`,
      );
    }

    if (action === "stop") {
      const s = resolveService(args, owner);
      if (!s) return fail("preview stop", "No running server to stop.");
      const id = s.id;
      stopService(id);
      return {
        ok: true,
        summary: `stopped ${id}`,
        content: [{ t: "text", text: `Stopped server ${id}.` }],
        events: [{ e: "preview_closed", serviceId: id }],
      };
    }

    return fail(
      "preview",
      `Unknown action "${action}". Use start | logs | stop. (Page interaction moved to the Browser tool.)`,
    );
  },
};
