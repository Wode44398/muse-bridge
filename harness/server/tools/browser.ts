import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { ok, fail } from "./types.ts";
import {
  getSharedBrowser,
  existingSharedBrowser,
  closeAllBrowserSessions,
  attachSharedBrowser,
  attachEdgeBrowser,
  claimBrowser,
  releaseBrowser,
  VIEWPORT_PRESETS,
  SETTLE_MAX_MS,
  MAX_SHOT_WAIT_MS,
  type CdpSession,
  type ScreenshotOptions,
  type ScreenshotResult,
} from "../cdp.ts";
import { latestService } from "../services.ts";
import { describeImage, visionConfigured, visionModel } from "../vision.ts";
import { controlPlanePortBlock, controlPlaneUrlBlock } from "../control-plane.ts";
import { fileUrlBlock } from "../sandbox.ts";
import { imageDimensions, screenshotEvent } from "../image-assets.ts";
import { edgeLink } from "../edge-link.ts";
import { browserAvailable } from "../headless.ts";
import { tenantMode } from "../tenant.ts";

// The Browser tool: drive the shared headless browser — navigate (any URL,
// including apps started with Preview), click/type/scroll/hover, emulate
// viewports, read the browser-side console, and screenshot the CURRENT state.
// Page reading lives in ReadPage, JS evaluation in Eval, request auditing in
// Network — all four operate on this same browser, so state persists.

// Resolve a navigate target: full http(s) URL, or a "/path" against THIS
// session's most recently started Preview service (an unscoped pick would send
// one session's Browser at another session's dev server).
function resolveUrl(raw: string, owner: string): string {
  if (/^(https?|file):\/\//i.test(raw)) return raw;
  if (raw.startsWith("/")) {
    const s = latestService(owner);
    if (!s) throw new Error(`"${raw}" is a path but no Preview server is running — start one, or pass a full http(s):// URL.`);
    return `http://localhost:${s.port}${raw}`;
  }
  throw new Error(`"${raw}" is not a URL. Pass a full http(s):// URL, or a "/path" to target the running Preview server.`);
}

// Resolve a `tab` argument to a targetId: "2" = 1-based index from Browser(tabs),
// or a raw CDP targetId. null = no such tab.
function resolveTabArg(page: CdpSession, v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim();
  if (/^\d{1,2}$/.test(s)) return page.tabs[Number(s) - 1]?.id ?? null;
  return page.tabs.find((t) => t.id === s)?.id ?? null;
}

function formatTabs(page: CdpSession): string {
  if (!page.tabs.length) return "No tabs (the browser has no pages).";
  const lines = page.tabs.map(
    (t, i) => `${i + 1}. ${t.active ? "→ " : "  "}${t.title || "(untitled)"} — ${t.url}${t.active ? "  (current)" : ""}`,
  );
  return (
    `Tabs (${page.tabs.length}) — every browser tool acts on the → current one:\n` +
    lines.join("\n") +
    `\nOpen: Browser(tab_new[, url]). Switch: Browser(tab_switch, tab:<1-based index>). Close: Browser(tab_close[, tab]).`
  );
}

async function pageStamp(page: CdpSession): Promise<string> {
  const title = await page.title();
  return `${page.url}${title ? ` — "${title}"` : ""}`;
}

// Capture the browser's CURRENT page and hand the pixels back the right way:
// a multimodal agent gets the image itself as follow-up feedback so it can
// look; a text-only agent (DeepSeek) gets a text verdict from the external
// vision model when it asked a `question`. The user always sees the image.
// U5：结果里说清截的是什么（整个视口 / 哪个元素 / 哪块区域）、图多大、等没等动画——模型据此判断这张图能不能当证据。
function describeShot(shot: ScreenshotResult, opts: ScreenshotOptions, page: CdpSession): { what: string; text: string } {
  const dims = imageDimensions(shot.png);
  let what = "viewport";
  if (opts.ref != null) {
    const info = page.refInfo(opts.ref);
    what = `ref${opts.ref} (${info.role}${info.name ? ` "${info.name}"` : ""})`;
  } else if (opts.selector) {
    what = `element ${JSON.stringify(opts.selector)}`;
  } else if (opts.clip) {
    const c = opts.clip;
    what = `region at ${Math.round(c.x)},${Math.round(c.y)} (${Math.round(c.width)}×${Math.round(c.height)} viewport px)`;
  }
  let text = ` — ${what}${dims ? `, ${dims.width}×${dims.height} px image` : ""}` +
    `${shot.region?.clamped ? " (region clamped to the page, at most 10000 px per side)" : ""}.`;
  if (!shot.settle) text += " Captured immediately (waitMs:0) — animations may be mid-way.";
  else if (shot.settle.stillRunning) {
    text += ` ${shot.settle.stillRunning} animation(s) were still running after ${SETTLE_MAX_MS / 1000} s — this may be a mid-animation frame; pass waitMs to wait longer.`;
  } else if (shot.settle.waitedMs >= 200) text += ` Waited ${shot.settle.waitedMs} ms for animations/fonts to finish first.`;
  return { what, text };
}

async function captureAndReport(page: CdpSession, question: string, ctx: ToolContext, opts: ScreenshotOptions = {}): Promise<ToolRunResult> {
  let captured: ScreenshotResult;
  try {
    captured = await page.screenshot(opts);
  } catch (e) {
    return fail("browser screenshot", `Could not capture the page: ${(e as Error).message}`);
  }
  const png = captured.png;
  const url = page.url;
  const framing = describeShot(captured, opts, page);
  const scope = framing.what === "viewport" ? "" : ` (${framing.what})`;
  // R12（二）：给界面的截图存成会话资产、事件只带 id（不再把 base64 塞进事件流）
  const shot = (verdict?: string) => screenshotEvent(ctx.ownerId, png, "image/png", url, verdict);

  if (ctx.agentSeesImages) {
    const q = question ? `You wanted to verify: "${question}". ` : "";
    return {
      ok: true,
      summary: `screenshot ${url}${scope}`,
      content: [
        {
          t: "text",
          text: `Captured ${url}${framing.text} ${q}The screenshot is attached below — look at it and judge for yourself. The user sees the same image.`,
        },
      ],
      feedback: [{ t: "image", mime: "image/png", data: png.toString("base64") }],
      events: [shot()],
    };
  }

  if (!question || !visionConfigured()) {
    const note = !question
      ? `Captured ${url}${framing.text} No question was asked, so no visual verdict. The user can see the image. For a text verdict, pass question:"…".`
      : `Captured ${url}${framing.text} But no vision model is configured (set VISION_API_KEY), so I cannot give a visual verdict. The user can see the image.`;
    return {
      ok: true,
      summary: `screenshot${scope}${question ? " (no vision model)" : ""}`,
      content: [{ t: "text", text: note }],
      events: [shot()],
    };
  }

  try {
    const verdict = await describeImage(png, question);
    return {
      ok: true,
      summary: `screenshot verdict (${verdict.model})`,
      content: [
        {
          t: "text",
          text: `Visual check of ${url} via ${verdict.model}${framing.text}\n\nQ: ${question}\n\nA: ${verdict.text}\n\n(A multimodal model's reading of the screenshot — the user sees the same image.)`,
        },
      ],
      events: [shot(verdict.text)],
    };
  } catch (e) {
    return {
      ok: false,
      summary: "screenshot (vision failed)",
      content: [
        {
          t: "text",
          text: `Captured ${url}${framing.text} But the vision model (${visionModel()}) failed: ${(e as Error).message}\nThe screenshot is shown to the user, but I could not get an automated visual verdict.`,
        },
      ],
      events: [shot()],
    };
  }
}

export const browserTool: Tool = {
  effect: "exec",
  concurrencySafe: false,
  // 没有 Chromium 系浏览器（也没有桌面壳的浏览器宿主）就不提供：例如没装浏览器的 Linux 服务器
  enabled: browserAvailable,
  def: {
    name: "Browser",
    description:
      "Drive a real (headless) browser. ONE shared browser persists across calls — the page you navigated " +
      "to, clicked, and typed into stays put; ReadPage/Eval/Network operate on this same page. Actions:\n" +
      "• navigate — go to a full http(s)/file URL, or a \"/path\" on the running Preview server. Also: back | forward.\n" +
      "• tabs — list open tabs (1-based index + title + URL; → marks the current one).\n" +
      "• tab_new — open a NEW tab (optional `url`, default about:blank) and switch to it. Every tab keeps its own " +
      "page state; all browser tools always act on the CURRENT tab.\n" +
      "• tab_switch — make another tab current (`tab`: 1-based index or targetId). Use it to work across pages — " +
      "e.g. a reference site in one tab and your own app in another, switching to compare — or to follow a " +
      "popup/window.open link, which appears as a new tab.\n" +
      "• tab_close — close a tab (`tab`, default = current). Closing the LAST tab shuts the whole browser down.\n" +
      "• attach — retarget every browser tool (this one plus ReadPage/Eval/Network) at an ALREADY-RUNNING " +
      "Chromium-based app that exposes a DevTools port: an Electron desktop app or packaged exe launched with " +
      "--remote-debugging-port=<port>, or any headful Chrome. Pass `port`; optional target:\"substring\" picks " +
      "a window by title/URL when several exist. close then DETACHES without quitting the app.\n" +
      "• edge — switch every browser tool to the USER'S OWN Microsoft Edge (through the dimensio Edge extension): " +
      "their real logged-in sessions, cookies and extensions. You only ever work in tabs of the \"dimensio\" tab group " +
      "(the user drags tabs in to share them, out to take them back); optional `url` opens there. The user sees a glow " +
      "and your pointer on that page and can stop you. Use it ONLY when the task needs the user's real browser (their " +
      "accounts, a site they are logged into) or they ask for it — previews and verification stay on the built-in " +
      "browser. There, before anything outward-facing or irreversible (send, post, submit, purchase, delete, change " +
      "settings) AskUserQuestion first. close detaches and leaves the tabs open for the user.\n" +
      "• click — click by `ref` (from ReadPage — most reliable), by visible `text`, or by `x`/`y`. " +
      "Optional: button:\"right\", double:true.\n" +
      "• type — focus a target (`ref` or CSS `selector`; omit to use current focus) and type `text` into it.\n" +
      "• key — press a key or combo: enter, tab, escape, backspace, delete, space, arrow keys, " +
      "pageup/pagedown/home/end, or combos like \"ctrl+a\".\n" +
      "• scroll — scroll by `dy` px (positive = down).\n" +
      "• hover — move the mouse over `ref` or `x`/`y` (reveals menus/tooltips).\n" +
      "• resize — viewport: preset \"mobile\"|\"tablet\"|\"desktop\" or explicit `width`+`height`; " +
      "optional colorScheme:\"dark\"|\"light\" to test themes. The default viewport is desktop (1280×900) — " +
      "when the task is a MOBILE app/page, resize to preset:\"mobile\" FIRST and keep working there, so " +
      "every screenshot and the user's live Browser pane show the phone-shaped layout, not a desktop letterbox.\n" +
      "• dprprobe — reload the current page at an emulated devicePixelRatio (default 2), scroll through it " +
      "with real input, and check every <canvas> backing store for DPR-scaling bugs (feedback loops, blowout, " +
      "runaway page height), then restore DPR 1. Headless default is DPR 1 — the one ratio where such bugs are " +
      "symptom-free — while real displays run 1.25–3, so canvas/WebGL pages MUST pass this probe once after " +
      "edits before being declared done. Counts as verification evidence.\n" +
      "• console — browser-side signals of THIS browser (console.*, uncaught errors, failed requests). " +
      "CDP-native: works regardless of any preview pane.\n" +
      "• screenshot — capture the CURRENT state. It first waits for running CSS/JS animations and web fonts to " +
      `finish (up to ${SETTLE_MAX_MS / 1000} s); waitMs adds a fixed wait before that (e.g. for data to load), waitMs:0 captures ` +
      "immediately. Shoot ONE element with `selector` (CSS) or `ref` (from ReadPage) — scrolled into view if needed — " +
      "or a rectangle with clip:{x,y,width,height} in viewport CSS px. If you can see images it is handed back to you to " +
      "judge; otherwise ask a specific `question` and a vision model returns a text verdict.\n" +
      "• close — shut the browser down (a later action relaunches it fresh).\n" +
      "Typical loop: navigate → ReadPage → click/type (by ref) → Eval to assert DOM state → screenshot to " +
      "verify visually. Prefer Eval/ReadPage assertions over screenshots for functional checks — cheaper and exact.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["navigate", "attach", "edge", "back", "forward", "tabs", "tab_new", "tab_switch", "tab_close", "click", "type", "key", "scroll", "hover", "resize", "dprprobe", "console", "screenshot", "close"],
          description: "navigate | attach | edge | back | forward | tabs | tab_new | tab_switch | tab_close | click | type | key | scroll | hover | resize | dprprobe | console | screenshot | close",
        },
        url: {
          type: "string",
          description: "For navigate / tab_new / edge: full http(s)/file URL, or a \"/path\" on the running Preview server.",
        },
        tab: {
          type: "string",
          description: "For tab_switch / tab_close: 1-based tab index from Browser(tabs), or a targetId. tab_close defaults to the current tab.",
        },
        port: {
          type: "integer",
          description: "For attach: the app's DevTools port (its --remote-debugging-port value).",
        },
        target: {
          type: "string",
          description: "For attach: pick the window whose title/URL contains this substring (when the app has several).",
        },
        ref: {
          type: "integer",
          description: "For click/type/hover/screenshot: element ref number from ReadPage (e.g. 12 for [ref12]).",
        },
        text: {
          type: "string",
          description: "For click: match by visible text. For type: the text to type.",
        },
        selector: {
          type: "string",
          description: "For type: CSS selector to focus instead of a ref. For screenshot: capture just this element.",
        },
        clip: {
          type: "object",
          description: "For screenshot: capture just this rectangle, in viewport CSS px (the same coordinates as click x/y).",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
          required: ["x", "y", "width", "height"],
        },
        waitMs: {
          type: "integer",
          description: `For screenshot: wait this long (max ${MAX_SHOT_WAIT_MS} ms) before capturing, then still wait for animations; 0 = capture immediately, mid-animation.`,
        },
        x: { type: "integer", description: "For click/hover by coordinates: viewport x (CSS px)." },
        y: { type: "integer", description: "For click/hover by coordinates: viewport y (CSS px)." },
        button: { type: "string", enum: ["left", "right"], description: "For click: mouse button (default left)." },
        double: { type: "boolean", description: "For click: double-click." },
        key: { type: "string", description: "For key: key name or combo, e.g. \"enter\", \"ctrl+a\"." },
        dy: { type: "integer", description: "For scroll: vertical pixels (positive = down). Default 600." },
        preset: { type: "string", enum: ["mobile", "tablet", "desktop"], description: "For resize: viewport preset." },
        width: { type: "integer", description: "For resize: explicit viewport width." },
        height: { type: "integer", description: "For resize: explicit viewport height." },
        colorScheme: { type: "string", enum: ["dark", "light", "auto"], description: "For resize: emulate prefers-color-scheme." },
        dpr: { type: "number", description: "For dprprobe: devicePixelRatio to emulate (default 2; 1.25 = Windows default scaling, 2–3 = phones)." },
        question: {
          type: "string",
          description: "For screenshot (text-only agents): what to visually verify — a vision model answers. Be specific.",
        },
        lines: { type: "integer", description: "For console: how many recent entries (default 100)." },
      },
      required: ["action"],
    },
  },
  async run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
    const action = String(args.action ?? "").trim();
    // One session drives the browser at a time (see claimBrowser).
    const owner = ctx.ownerId ?? "";
    const denied = claimBrowser(owner);
    if (denied) return fail(`browser ${action || "?"}`, denied);

    if (action === "close") {
      releaseBrowser(owner);
      const cur = existingSharedBrowser();
      if (!cur) return ok("browser already closed", "No browser was running.");
      const wasAttached = cur.attached;
      const wasEdge = cur.edge;
      closeAllBrowserSessions();
      if (wasEdge) {
        return ok(
          "detached from Edge",
          "Detached from the user's Edge — the dimensio tab group stays open for them. The next Browser/ReadPage/Eval/Network call uses the built-in browser again.",
        );
      }
      return ok(
        wasAttached ? "detached" : "browser closed",
        wasAttached
          ? "Detached from the app — the app itself keeps running. The next Browser/ReadPage/Eval/Network call targets a fresh headless browser."
          : "Browser closed. Any Browser/ReadPage/Eval/Network call will relaunch it fresh.",
      );
    }

    // 租户实例（多用户服务端上每个用户一个 harness，见 tenant.ts）：不许挂到本机任意调试端口（那可能是管理员的
    // 浏览器 / 桌面壳），也不许接用户的 Edge（那是主机主人的真实登录态）。
    if ((action === "attach" || action === "edge") && tenantMode()) {
      return fail(`browser ${action}`, "Not available on this server: Browser(attach) and Browser(edge) are disabled for multi-user accounts. Use Browser(navigate) with the built-in headless browser instead.");
    }

    if (action === "attach") {
      const port = Number(args.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        return fail("browser attach", "action=attach requires `port` — the app's --remote-debugging-port value.");
      }
      // S1（#38②的止血部分）：不许附着到 harness / bridge / 桌面壳自己的调试端口。
      const blocked = controlPlanePortBlock(port);
      if (blocked) return fail("browser attach", blocked);
      try {
        const filter = typeof args.target === "string" && args.target.trim() ? args.target.trim() : undefined;
        const { session, picked, pages } = await attachSharedBrowser(port, filter);
        const multi = pages > 1 ? ` (${pages} page targets — pass target:"<title/url substring>" to pick another)` : "";
        return {
          ok: true,
          summary: `attached :${port}`,
          content: [
            {
              t: "text",
              text:
                `Attached to ${picked} via DevTools port ${port}${multi}.\n` +
                `ReadPage / Browser(click|type|key|scroll|hover|screenshot|console) / Eval / Network now drive this app window. ` +
                `Browser(close) detaches without quitting the app.`,
            },
          ],
          events: [{ e: "browser", url: session.url }],
        };
      } catch (e) {
        return fail(
          "browser attach",
          `Could not attach to 127.0.0.1:${port}: ${(e as Error).message}\n` +
            `Launch the app with a DevTools port first, e.g. Bash(background:true, command:"npx electron . --remote-debugging-port=${port}"), then attach.`,
        );
      }
    }

    if (action === "edge") {
      const link = edgeLink();
      if (!link.connected) {
        return fail(
          "browser edge",
          "The user's Edge is not connected: the dimensio Edge extension is not installed, not enabled, or cannot reach dimensio. " +
            "Tell the user the extension has to be installed and enabled in their Edge " +
            "(already installed? click the extension's toolbar icon — it shows why it isn't connected). Then try again.",
        );
      }
      const raw = String(args.url ?? "").trim();
      let url = "";
      if (raw) {
        try {
          url = resolveUrl(raw, ctx.ownerId ?? "");
        } catch (e) {
          return fail("browser edge", (e as Error).message);
        }
        const blocked = controlPlaneUrlBlock(url) ?? fileUrlBlock(url, ctx.sandbox);
        if (blocked) return fail("browser edge", blocked);
      }
      try {
        const { session, created } = await attachEdgeBrowser(url || undefined);
        const where = created ? "opened a new tab in a \"dimensio\" tab group" : "took over the \"dimensio\" tab group";
        return {
          ok: true,
          summary: "connected to Edge",
          content: [
            {
              t: "text",
              text:
                `Connected to the user's Edge (${link.snapshot().browser || "Edge"}) and ${where}. Current tab: ${await pageStamp(session)}\n\n` +
                `${formatTabs(session)}\n\n` +
                "ReadPage / Browser(navigate|click|type|key|scroll|screenshot|tabs|tab_new) / Eval / Network now act on the user's real, logged-in browser. " +
                "Stay inside this tab group, ask before outward-facing or irreversible actions, and Browser(close) when done (the tabs stay for the user).",
            },
          ],
          events: [{ e: "browser", url: session.url }],
        };
      } catch (e) {
        return fail("browser edge", `Could not take over the Edge tab group: ${(e as Error).message}`);
      }
    }

    if (action === "console") {
      const page = existingSharedBrowser();
      if (!page) return fail("browser console", "No browser is running yet — Browser(navigate) first.");
      const n = Math.max(1, Math.min(400, Number(args.lines ?? 100)));
      const entries = page.consoleEntries().slice(-n);
      const body = entries.length
        ? entries.map((e) => `[${e.type}] ${e.msg}`).join("\n")
        : "(no console output captured yet)";
      return ok(`console (${entries.length})`, `Browser console/errors/failed requests at ${page.url}:\n\n${body}`);
    }

    // S1（#38①）：导航目标是控制面就当场拒绝——先判，免得为一次注定被拒的导航拉起浏览器。
    if (action === "navigate" || action === "tab_new") {
      const raw = String(args.url ?? "").trim();
      let target = "";
      try {
        target = raw ? resolveUrl(raw, ctx.ownerId ?? "") : "";
      } catch {
        /* 目标写法不对：交给下面原有的校验报错 */
      }
      const blocked = target ? controlPlaneUrlBlock(target) ?? fileUrlBlock(target, ctx.sandbox) : null;
      if (blocked) return fail(`browser ${action}`, blocked);
    }

    // Everything below needs a live browser (navigate / tab_new creates one).
    let page: CdpSession;
    const wasDead = !existingSharedBrowser();
    try {
      if (action === "navigate" || action === "tab_new") {
        page = await getSharedBrowser();
      } else {
        const existing = existingSharedBrowser();
        if (!existing) {
          return fail(`browser ${action}`, "No browser is running yet — Browser(navigate, url:…) first.");
        }
        page = existing;
      }
    } catch (e) {
      return fail(`browser ${action}`, `Could not launch the browser: ${(e as Error).message}`);
    }

    try {
      switch (action) {
        case "navigate": {
          const raw = String(args.url ?? "").trim();
          if (!raw) return fail("browser navigate", "action=navigate requires `url`.");
          const url = resolveUrl(raw, ctx.ownerId ?? "");
          await page.navigate(url);
          return {
            ok: true,
            summary: `→ ${url}`,
            content: [
              {
                t: "text",
                text: `Browser is now at ${await pageStamp(page)}.\nNext: ReadPage to see the page structure and get clickable [refN] handles.`,
              },
            ],
            events: [{ e: "browser", url: page.url }],
          };
        }
        case "back":
        case "forward": {
          const moved = await page.history(action === "back" ? -1 : 1);
          if (!moved) return fail(`browser ${action}`, `No ${action} entry in the browser history.`);
          return {
            ok: true,
            summary: `${action} → ${moved}`,
            content: [{ t: "text", text: `Went ${action} to ${await pageStamp(page)}.` }],
            events: [{ e: "browser", url: page.url }],
          };
        }
        case "tabs": {
          return ok(`tabs (${page.tabs.length})`, formatTabs(page));
        }
        case "tab_new": {
          const raw = String(args.url ?? "").trim();
          const url = raw ? resolveUrl(raw, ctx.ownerId ?? "") : "about:blank";
          if (wasDead) {
            // 刚拉起的浏览器自带首个标签 —— 它就是新标签（导航过去即可，别再生第二个）
            if (url !== "about:blank") await page.navigate(url);
          } else {
            await page.newTab(url);
          }
          return {
            ok: true,
            summary: `new tab → ${page.url}`,
            content: [
              {
                t: "text",
                text: `Opened a new tab at ${await pageStamp(page)} — it's now the current one.\n\n${formatTabs(page)}`,
              },
            ],
            events: [{ e: "browser", url: page.url }],
          };
        }
        case "tab_switch": {
          const id = resolveTabArg(page, args.tab);
          if (!id) {
            return fail(
              "browser tab_switch",
              `action=tab_switch needs \`tab\` — a 1-based index or targetId.\n\n${formatTabs(page)}`,
            );
          }
          await page.activateTab(id);
          return {
            ok: true,
            summary: `switched → ${page.url}`,
            content: [
              {
                t: "text",
                text: `Now on ${await pageStamp(page)}. ReadPage/Eval/screenshot/click all act on this tab now.\n\n${formatTabs(page)}`,
              },
            ],
            events: [{ e: "browser", url: page.url }],
          };
        }
        case "tab_close": {
          const id = args.tab == null ? page.tabs.find((t) => t.active)?.id : resolveTabArg(page, args.tab);
          if (!id) {
            return fail(
              "browser tab_close",
              `No such tab.\n\n${formatTabs(page)}`,
            );
          }
          const closing = page.tabs.find((t) => t.id === id);
          await page.closeTab(id);
          if (!existingSharedBrowser()) {
            return ok(
              "tab closed — browser shut down",
              `Closed "${closing?.title || closing?.url || id}" — that was the LAST tab, so the whole browser closed (like closing a browser window). Any Browser action relaunches it fresh.`,
            );
          }
          return {
            ok: true,
            summary: `closed "${closing?.title || closing?.url || id}"`,
            content: [{ t: "text", text: `Closed "${closing?.title || closing?.url || id}".\n\n${formatTabs(page)}` }],
            events: [{ e: "browser", url: page.url }],
          };
        }
        case "click": {
          const before = page.url;
          const tabsBefore = page.tabs.length;
          const dbl = args.double === true;
          const opts = { button: (args.button === "right" ? "right" : "left") as "left" | "right", clickCount: dbl ? 2 : 1 };
          let what: string;
          if (args.ref != null && Number.isInteger(Number(args.ref))) {
            const ref = Number(args.ref);
            const info = page.refInfo(ref);
            await page.clickRef(ref, opts);
            what = `ref${ref} (${info.role}${info.name ? ` "${info.name}"` : ""})`;
          } else if (typeof args.text === "string" && args.text.trim()) {
            await page.clickText(args.text.trim());
            what = `"${args.text.trim()}"`;
          } else if (args.x != null && args.y != null) {
            await page.clickCoord(Number(args.x), Number(args.y), opts);
            what = `(${args.x},${args.y})`;
          } else {
            return fail("browser click", "action=click needs one of: `ref`, `text`, or `x`+`y`.");
          }
          await delayMs(400); // let navigation / re-render settle
          const moved = page.url !== before ? ` The page navigated to ${page.url} — refs are stale, ReadPage again.` : "";
          const spawned =
            page.tabs.length > tabsBefore
              ? ` The click OPENED A NEW TAB (popup/target=_blank) — you're still on the old one; Browser(tabs) to see it, Browser(tab_switch) to follow it.`
              : "";
          return ok(`clicked ${what}`, `Clicked ${what}.${moved}${spawned} Verify with Eval/ReadPage, or Browser(screenshot).`);
        }
        case "type": {
          const text = String(args.text ?? "");
          if (!text) return fail("browser type", "action=type requires `text`.");
          const target: { ref?: number; selector?: string } = {};
          if (args.ref != null && Number.isInteger(Number(args.ref))) target.ref = Number(args.ref);
          else if (args.selector) target.selector = String(args.selector);
          await page.typeText(text, target);
          const where = target.ref != null ? `ref${target.ref}` : target.selector || "the focused element";
          return ok(`typed ${text.length} chars`, `Typed into ${where}. To submit: Browser(key:"enter") or click the submit button.`);
        }
        case "key": {
          const key = String(args.key ?? "").trim();
          if (!key) return fail("browser key", "action=key requires `key`.");
          await page.pressKey(key);
          await delayMs(300);
          return ok(`pressed ${key}`, `Pressed ${key}. Page is at ${page.url}.`);
        }
        case "scroll": {
          const dy = Number.isFinite(Number(args.dy)) ? Number(args.dy) : 600;
          await page.scrollBy(dy);
          return ok(`scrolled ${dy}px`, `Scrolled ${dy}px. ReadPage or screenshot to see what's in view.`);
        }
        case "hover": {
          if (args.ref != null && Number.isInteger(Number(args.ref))) {
            await page.hoverRef(Number(args.ref));
            await delayMs(300);
            return ok(`hovering ref${args.ref}`, `Hovering ref${args.ref}. ReadPage to see anything it revealed.`);
          }
          if (args.x != null && args.y != null) {
            await page.hoverCoord(Number(args.x), Number(args.y));
            await delayMs(300);
            return ok(`hovering (${args.x},${args.y})`, `Hovering (${args.x},${args.y}).`);
          }
          return fail("browser hover", "action=hover needs `ref` or `x`+`y`.");
        }
        case "resize": {
          if (page.edge) {
            return fail(
              "browser resize",
              "This is the user's own Edge window — emulating another viewport would distort what they are looking at. Do viewport/responsive testing in the built-in browser (Browser close, then navigate).",
            );
          }
          let w: number, h: number, mobile: boolean;
          const preset = args.preset ? String(args.preset) : "";
          if (preset && VIEWPORT_PRESETS[preset]) {
            ({ width: w, height: h, mobile } = VIEWPORT_PRESETS[preset]);
          } else if (args.width != null && args.height != null) {
            w = Number(args.width);
            h = Number(args.height);
            mobile = w < 600;
          } else {
            return fail("browser resize", "action=resize needs preset (mobile|tablet|desktop) or width+height.");
          }
          if (!(w > 0 && h > 0)) return fail("browser resize", "width/height must be positive.");
          await page.setViewport(w, h, mobile);
          let schemeNote = "";
          const scheme = args.colorScheme ? String(args.colorScheme) : "";
          if (scheme === "dark" || scheme === "light" || scheme === "auto") {
            await page.setColorScheme(scheme);
            schemeNote = `, color scheme ${scheme}`;
          }
          return ok(`viewport ${w}×${h}`, `Viewport is now ${w}×${h}${mobile ? " (mobile)" : ""}${schemeNote}. Screenshot or ReadPage to check the layout.`);
        }
        case "dprprobe": {
          if (page.edge) {
            return fail("browser dprprobe", "dprprobe reloads the page under emulation — not on the user's own Edge. Run it in the built-in browser.");
          }
          const dpr = args.dpr != null ? Number(args.dpr) : 2;
          if (!(dpr > 1 && dpr <= 4)) {
            return fail("browser dprprobe", "dpr must be > 1 and ≤ 4 — the point is a ratio real displays use (1.25–3). DPR 1 proves nothing.");
          }
          const stamp = await pageStamp(page);
          const rep = await page.canvasDprProbe(dpr);
          if (rep.passed) {
            const body = rep.canvasCount === 0
              ? `DPR ${dpr} probe on ${stamp}: ${rep.note}. (If this page should be drawing charts/graphics, that itself is suspicious.)`
              : `DPR ${dpr} probe on ${stamp}: ${rep.canvasCount} canvas(es) healthy — backing stores match layout × dpr, ` +
                `no growth with input stopped, page height sane. The page survives real-display pixel ratios.`;
            return {
              ...ok(`DPR ${dpr} probe passed (${rep.canvasCount} canvas)`, body),
              verification: { passed: true, detail: `canvas DPR probe @${dpr} on ${stamp} (${rep.canvasCount} canvases)` },
            };
          }
          return {
            ...fail(
              `DPR ${dpr} probe FAILED (${rep.problems.length} problem${rep.problems.length > 1 ? "s" : ""})`,
              `DPR ${dpr} probe on ${stamp} FAILED:\n- ${rep.problems.join("\n- ")}\n` +
                `This page breaks on real displays (Windows scaling 125%+, every phone). Typical root cause: sizing code that ` +
                `re-reads a value it already multiplied by devicePixelRatio (canvas.width/height ASSIGNMENT writes the HTML ` +
                `attribute — never read your config back from it). Fix the sizing math, then re-run dprprobe.`,
            ),
            verification: { passed: false, detail: `canvas DPR probe @${dpr} FAILED: ${rep.problems[0]}` },
          };
        }
        case "screenshot": {
          // S4（#37②）：截图对多模态模型等于读页面——当前页是过不了闸的本地文件就不截。
          const fileBlock = fileUrlBlock(page.url, ctx.sandbox);
          if (fileBlock) return fail("browser screenshot", `The current page is a blocked local file — ${fileBlock}. Navigate away first.`);
          // U5：取景（元素 / 区域）与等待
          const opts: ScreenshotOptions = {};
          if (args.ref != null && Number.isInteger(Number(args.ref))) opts.ref = Number(args.ref);
          else if (typeof args.selector === "string" && args.selector.trim()) opts.selector = args.selector.trim();
          if (args.clip != null) {
            if (opts.ref != null || opts.selector) {
              return fail("browser screenshot", "Pass either an element (selector or ref) or a clip rectangle, not both.");
            }
            let c = args.clip as Record<string, unknown> | string;
            if (typeof c === "string") {
              try {
                c = JSON.parse(c) as Record<string, unknown>;
              } catch {
                return fail("browser screenshot", "clip must be an object like {x:0, y:0, width:400, height:300}.");
              }
            }
            opts.clip = { x: Number(c?.x), y: Number(c?.y), width: Number(c?.width), height: Number(c?.height) };
          }
          if (args.waitMs != null && Number.isFinite(Number(args.waitMs))) opts.waitMs = Number(args.waitMs);
          return await captureAndReport(page, String(args.question ?? "").trim(), ctx, opts);
        }
        default:
          return fail("browser", `Unknown action "${action}". Use navigate | attach | edge | back | forward | tabs | tab_new | tab_switch | tab_close | click | type | key | scroll | hover | resize | dprprobe | console | screenshot | close.`);
      }
    } catch (e) {
      return fail(`browser ${action}`, `${action} failed: ${(e as Error).message}`);
    }
  },
};

function delayMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
