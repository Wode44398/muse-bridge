import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail } from "./types.ts";
import { controlPlaneUrlBlock } from "../control-plane.ts";
import { redactOutput } from "../redact.ts";
import { persistOutput, savedHint } from "./result-store.ts";
import { WEB_CONTENT_NOTE } from "./untrusted.ts";

// Hard caps so a single fetch can't stall the loop or blow the context window.
const TIMEOUT_MS = 30_000;
const MAX_FETCH_BYTES = 5_000_000; // stop downloading past ~5 MB
const MAX_TEXT_CHARS = 60_000; // ~15k tokens of readable text handed to the model

// Looks like a real browser — some doc sites 403 unknown/blank user agents.
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export const webfetchTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  def: {
    name: "WebFetch",
    description:
      "Fetch an http(s) URL and read its content. HTML is converted to readable plain text; " +
      "JSON, plain text, XML and markdown are returned as-is. Use this to consult CURRENT, " +
      "authoritative external information your training data may be stale on — official API/SDK " +
      "docs, package readmes, changelogs, reference pages — and then adapt your code to exactly " +
      "what the page says (current model names, endpoints, parameters). Give the full absolute URL. " +
      "Follows redirects. Binary responses (images, PDFs, archives) are not supported.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "The absolute http:// or https:// URL to fetch." },
      },
      required: ["url"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const raw = String(args.url ?? "").trim();
    if (!raw) return fail("no url", "No URL provided.");

    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      return fail("bad url", `Not a valid URL: ${raw}`);
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return fail("bad scheme", `WebFetch only supports http/https URLs (got ${url.protocol}).`);
    }
    // S1（#12）：WebFetch 不敲 dimensio 自己的控制面端口（API 本身也只认令牌，这里是纵深）。
    const blocked = controlPlaneUrlBlock(url.href);
    if (blocked) return fail("control plane", blocked);

    const signals: AbortSignal[] = [AbortSignal.timeout(TIMEOUT_MS)];
    if (ctx.signal) signals.push(ctx.signal);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

    let res: Response;
    try {
      res = await fetch(url, {
        redirect: "follow",
        signal,
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/json,text/plain,*/*",
          "accept-language": "en,zh-CN;q=0.9,zh;q=0.8",
        },
      });
    } catch (e) {
      const err = e as Error;
      if (err.name === "TimeoutError") return fail("timeout", `Fetch timed out after ${TIMEOUT_MS}ms: ${raw}`);
      if (err.name === "AbortError") return fail("aborted", "Fetch aborted.");
      return fail("fetch failed", `Could not fetch ${raw}: ${err.message}`);
    }
    // 公网地址 302 到控制面也不行：落点再判一次，正文不读。
    const landedBlock = res.url && res.url !== url.href ? controlPlaneUrlBlock(res.url) : null;
    if (landedBlock) {
      void res.body?.cancel().catch(() => {});
      return fail("control plane", `${raw} redirected to a blocked target. ${landedBlock}`);
    }

    const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
    const kind = classify(contentType);
    if (kind === "binary") {
      return fail(
        "binary content",
        `${raw} returned ${contentType || "an unknown binary type"} — WebFetch reads text/HTML, not binary. ` +
          `HTTP ${res.status}.`,
      );
    }

    let bytes: { text: string; truncated: boolean };
    try {
      bytes = await readCapped(res, MAX_FETCH_BYTES);
    } catch (e) {
      return fail("read failed", `Failed while reading ${raw}: ${(e as Error).message}`);
    }

    // S4 出口脱敏：抓来的内容里恰好有令牌（本机 dev server 的调试页、泄露的配置…）不原样交给模型。
    let body = redactOutput(kind === "html" ? htmlToText(bytes.text) : bytes.text.trim());
    let clipped = bytes.truncated;
    let saved: string | null = null;
    if (body.length > MAX_TEXT_CHARS) {
      // R13：截掉之前把全文（已脱敏）存进会话的 outputs 目录，模型要看后面的内容就 Read，不用重抓
      const full = body.length;
      saved = persistOutput(ctx.ownerId, "webfetch", body);
      body = body.slice(0, MAX_TEXT_CHARS);
      clipped = true;
      if (saved) body += `\n\n…[content truncated — ${savedHint(saved, full)}]`;
    }
    if (clipped && !saved) body += "\n\n…[content truncated]";

    const finalUrl = res.url && res.url !== raw ? ` → ${res.url}` : "";
    const meta = `[HTTP ${res.status} · ${contentType || "?"} · ${body.length} chars${clipped ? " · truncated" : ""}]`;
    const header = `Fetched ${raw}${finalUrl}\n${meta}\n${WEB_CONTENT_NOTE}\n\n`;

    return {
      ok: res.ok,
      summary: `WebFetch ${url.host}${url.pathname === "/" ? "" : url.pathname} (HTTP ${res.status}, ${body.length} chars)`,
      // U8（K36）
      outcome: `HTTP ${res.status} · ${body.length >= 10_000 ? `${Math.round(body.length / 1000)}k` : body.length} 字${clipped ? " · 太长截断了" : ""}`,
      content: [{ t: "text", text: header + (body || "(empty response body)") }],
    };
  },
};

function classify(contentType: string): "html" | "text" | "binary" {
  if (!contentType) return "text"; // no header — assume text, decode leniently
  if (contentType.includes("html")) return "html";
  if (
    contentType.startsWith("text/") ||
    contentType.includes("json") ||
    contentType.includes("xml") ||
    contentType.includes("javascript") ||
    contentType.includes("markdown") ||
    contentType.includes("csv") ||
    contentType.includes("yaml")
  ) {
    return "text";
  }
  return "binary";
}

// Stream the body with a hard byte ceiling so a huge/endless response can't
// exhaust memory. Decodes leniently as UTF-8 (the overwhelming default for docs).
async function readCapped(res: Response, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: await res.text(), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      received += value.length;
      if (received >= maxBytes) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  }
  return { text: new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(chunks)), truncated };
}

// Zero-dep HTML → readable text. Not a full parser — good enough to strip a doc
// page down to its prose so the model can read it. Drops scripts/styles/nav
// chrome, turns block boundaries into newlines, decodes entities, collapses ws.
function htmlToText(html: string): string {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Elements whose contents are not human-readable prose.
  s = s.replace(/<(script|style|noscript|template|svg|iframe|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  // Also drop ESCAPED script/style blocks stored as text (e.g. baidu inlines a
  // &lt;style data-for="result"&gt;…&lt;/style&gt; result template). Otherwise
  // decodeEntities below would revive them into visible CSS/JS noise.
  s = s.replace(/&lt;(script|style)\b[\s\S]*?&lt;\/\1&gt;/gi, " ");
  const title = decodeEntities((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim());
  // Block-level starts/ends and <br> become line breaks; table cells → tabs.
  s = s.replace(/<(p|div|section|article|header|footer|main|aside|ul|ol|li|tr|h[1-6]|blockquote|pre|table|thead|tbody|figure|hr)\b[^>]*>/gi, "\n");
  s = s.replace(/<\/(p|div|section|article|header|footer|main|aside|ul|ol|li|tr|h[1-6]|blockquote|pre|table|thead|tbody|figure)\s*>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<\/(td|th)\s*>/gi, "\t");
  // Strip every remaining tag.
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  // Collapse whitespace: inline runs → single space, trim each line, cap blank runs.
  s = s.replace(/[ \t ]+/g, " ");
  s = s.replace(/ *\n */g, "\n");
  s = s.replace(/\n{3,}/g, "\n\n");
  s = s.trim();
  return title && !s.startsWith(title) ? `# ${title}\n\n${s}` : s;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  copy: "©", reg: "®", trade: "™", hellip: "…", mdash: "—", ndash: "–",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  laquo: "«", raquo: "»", middot: "·", bull: "•", deg: "°",
  times: "×", divide: "÷", plusmn: "±", euro: "€", pound: "£", cent: "¢",
  sect: "§", para: "¶", dagger: "†", Dagger: "‡", permil: "‰",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z][a-z0-9]*);/gi, (m, ent: string) => {
    if (ent[0] === "#") {
      const code =
        ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(code)) return m;
      try {
        return String.fromCodePoint(code);
      } catch {
        return m;
      }
    }
    return NAMED_ENTITIES[ent] ?? NAMED_ENTITIES[ent.toLowerCase()] ?? m;
  });
}
