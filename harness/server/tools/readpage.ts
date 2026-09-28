import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { ok, fail } from "./types.ts";
import { existingSharedBrowser, claimBrowser } from "../cdp.ts";
import { browserAvailable } from "../headless.ts";
import { fileUrlBlock } from "../sandbox.ts";
import { redactOutput } from "../redact.ts";
import { WEB_CONTENT_NOTE } from "./untrusted.ts";

// ReadPage: the browser page as an accessibility tree — semantic structure
// (roles, names, states) instead of pixels. Interactive nodes carry [refN]
// handles that Browser(click/type/hover, ref:N) targets precisely. This is the
// PRIMARY way a text model "sees" a page; screenshots are for visual judgment.

export const readPageTool: Tool = {
  effect: "read",
  concurrencySafe: false, // reassigns the shared browser's ref table
  enabled: browserAvailable, // 与 Browser 同进同退
  def: {
    name: "ReadPage",
    description:
      "Read the Browser's CURRENT page as an accessibility tree: every element as `- role \"name\" [refN] " +
      "(states)`, indented by structure. Interactive elements (links, buttons, inputs…) get [refN] handles — " +
      "pass that number as `ref` to Browser(click/type/hover). Refs are re-assigned on EVERY ReadPage call and " +
      "go stale when the page navigates or re-renders — read again after you move.\n" +
      "• filter:\"interactive\" — only the clickable/typeable elements (flat list). Good default for acting.\n" +
      "• query:\"…\" — only lines containing the text (case-insensitive). Good for finding one control on a big page.\n" +
      "Reading the tree is exact and cheap — prefer it (and Eval) over screenshots for checking text/structure.",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "string",
          enum: ["all", "interactive"],
          description: "\"all\" (default) = full tree; \"interactive\" = only elements with [refN] handles.",
        },
        query: {
          type: "string",
          description: "Return only lines containing this text (case-insensitive substring).",
        },
        maxChars: {
          type: "integer",
          description: "Truncate the output beyond this many characters (default 20000).",
        },
      },
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const denied = claimBrowser(ctx.ownerId ?? "");
    if (denied) return fail("readpage", denied);
    const page = existingSharedBrowser();
    if (!page) return fail("readpage", "No browser is running — Browser(navigate, url:…) first.");
    // S4（#37②）：当前页是 file:// 且过不了与 Read 同一道闸（点链接、脚本跳转绕过了导航检查）→ 不读。
    const fileBlock = fileUrlBlock(page.url, ctx.sandbox);
    if (fileBlock) return fail("readpage", `The current page is a blocked local file — ${fileBlock}. Navigate away first.`);
    try {
      const snap = await page.axSnapshot({
        filter: args.filter === "interactive" ? "interactive" : "all",
        query: typeof args.query === "string" && args.query.trim() ? args.query.trim() : undefined,
        maxChars: Number.isFinite(Number(args.maxChars)) ? Number(args.maxChars) : undefined,
      });
      const head = `Page: ${page.url} — ${snap.refCount} interactive element(s) tagged [refN].`;
      return ok(
        `read ${snap.lineCount} nodes, ${snap.refCount} refs`,
        `${head}\n${WEB_CONTENT_NOTE}\n\n${redactOutput(snap.text)}\n\nUse Browser(action:"click"|"type"|"hover", ref:<N>) to act on a [refN] element.`,
      );
    } catch (e) {
      return fail("readpage", `Could not read the page: ${(e as Error).message}`);
    }
  },
};
