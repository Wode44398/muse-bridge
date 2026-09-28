import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { ok, fail } from "./types.ts";
import { existingSharedBrowser, claimBrowser } from "../cdp.ts";
import { browserAvailable } from "../headless.ts";

// Network: audit the Browser page's actual HTTP traffic — every request the
// page made (XHR/fetch/documents/assets), with status/size/failure, and full
// response bodies on demand. The ground truth for "did the frontend actually
// call the API, and what came back".

const MAX_BODY = 8_000;

function fmtSize(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

export const networkTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  enabled: browserAvailable, // 与 Browser 同进同退
  def: {
    name: "Network",
    description:
      "Inspect the network requests of the Browser's page (captured since the browser launched). Actions:\n" +
      "• list — recent requests as `[id] STATUS METHOD url (type, size)`; failed ones show the error. " +
      "Filter with `filter` (substring of the URL, e.g. \"/api\") and `lines`.\n" +
      "• body — the response body of one request by `id` (from list). Text bodies returned verbatim " +
      "(truncated); binary reported by size only.\n" +
      "Use it to verify frontend↔backend traffic: did the page call the endpoint, with what status, and " +
      "what did the server actually return.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "body"],
          description: "list (default) | body",
        },
        filter: {
          type: "string",
          description: "For list: only requests whose URL contains this substring.",
        },
        id: {
          type: "string",
          description: "For body: the request id from a prior list.",
        },
        lines: {
          type: "integer",
          description: "For list: max entries to show (default 60).",
        },
        expectedStatus: {
          type: "integer",
          description: "For list + verify:true: the latest matching request must have this HTTP status.",
        },
        verify: {
          type: "boolean",
          description:
            "Treat a filtered list as completion evidence. Requires filter + expectedStatus and passes only when the latest matching request completed with that status.",
        },
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const denied = claimBrowser(ctx.ownerId ?? "");
    if (denied) return fail("network", denied);
    const page = existingSharedBrowser();
    if (!page) return fail("network", "No browser is running — Browser(navigate, url:…) first.");
    const action = String(args.action ?? "list").trim() || "list";

    if (action === "list") {
      let entries = page.networkEntries();
      const filter = typeof args.filter === "string" ? args.filter.trim() : "";
      if (filter) entries = entries.filter((e) => e.url.includes(filter));
      const n = Math.max(1, Math.min(400, Number(args.lines ?? 60)));
      const total = entries.length;
      const tail = entries.slice(-n);
      if (!tail.length) {
        const empty = ok("network: 0 requests", filter ? `No requests matching "${filter}".` : "No requests captured yet — navigate somewhere first.");
        if (args.verify === true) {
          empty.ok = false;
          empty.verification = { passed: false, detail: `No network request matched ${filter || "(missing filter)"}` };
        }
        return empty;
      }
      const body = tail
        .map((e) => {
          const status = e.state === "failed" ? `FAIL(${e.error})` : e.status != null ? String(e.status) : "…";
          const extra = [e.resourceType, e.size ? fmtSize(e.size) : ""].filter(Boolean).join(", ");
          return `[${e.id}] ${status} ${e.method} ${e.url}${extra ? ` (${extra})` : ""}`;
        })
        .join("\n");
      const head = `${tail.length}${total > tail.length ? ` of ${total}` : ""} request(s)${filter ? ` matching "${filter}"` : ""} at ${page.url}:`;
      const result = ok(`network: ${tail.length} requests`, `${head}\n\n${body}\n\nNetwork(action:"body", id:"…") reads a response body.`);
      if (args.verify === true) {
        const expected = Number(args.expectedStatus);
        if (!filter || !Number.isInteger(expected)) {
          return {
            ...fail("network assertion invalid", "Network verification requires both `filter` and integer `expectedStatus`."),
            verification: { passed: false, detail: "Network verification was missing filter or expectedStatus" },
          };
        }
        const latest = tail[tail.length - 1];
        const passed = latest.state !== "failed" && latest.status === expected;
        result.ok = passed;
        result.verification = {
          passed,
          detail: passed
            ? `Network ${filter} returned HTTP ${expected}`
            : `Network ${filter} expected HTTP ${expected}, got ${latest.state === "failed" ? `FAIL(${latest.error})` : latest.status ?? "pending"}`,
        };
        if (!passed) result.summary = "network assertion failed";
      }
      return result;
    }

    if (action === "body") {
      const id = String(args.id ?? "").trim();
      if (!id) return fail("network body", "action=body requires `id` (from a prior list).");
      const entry = page.networkEntries().find((e) => e.id === id);
      try {
        const { body, base64 } = await page.responseBody(id);
        const label = entry ? `${entry.status ?? "?"} ${entry.method} ${entry.url}` : id;
        if (base64) {
          const bytes = Buffer.from(body, "base64").length;
          return ok(`body ${id} (binary)`, `${label}\n(binary response, ${fmtSize(bytes)}${entry?.mime ? `, ${entry.mime}` : ""} — not shown)`);
        }
        let text = body;
        let note = "";
        if (text.length > MAX_BODY) {
          text = text.slice(0, MAX_BODY);
          note = `\n… (truncated at ${MAX_BODY} chars of ${body.length})`;
        }
        return ok(`body ${id}`, `${label}\n\n${text || "(empty body)"}${note}`);
      } catch (e) {
        return fail("network body", `Could not read body for ${id}: ${(e as Error).message} (bodies expire when the page navigates away).`);
      }
    }

    return fail("network", `Unknown action "${action}". Use list | body.`);
  },
};
