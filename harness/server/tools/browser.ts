import { statSync } from "node:fs";
import type { Block } from "../agent/turn.ts";
import type { AgentEvent } from "../agent/events.ts";
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
  noBrowserMessage,
  VIEWPORT_PRESETS,
  SETTLE_MAX_MS,
  MAX_SHOT_WAIT_MS,
  type CdpSession,
  type ScreenshotOptions,
  type ScreenshotResult,
} from "../cdp.ts";
import {
  VERIFY_DESC,
  BATCH_MAX,
  afterAction,
  dialogNote,
  focusInfo,
  hasExpect,
  pageState,
  probePoint,
  probeRef,
  waitExpect,
  type ActKind,
  type PageState,
} from "../browser-verify.ts";
import { latestService } from "../services.ts";
import { describeImage, visionConfigured, visionModel } from "../vision.ts";
import { controlPlanePortBlock, controlPlaneUrlBlock } from "../control-plane.ts";
import { fileUrlBlock } from "../sandbox.ts";
import { imageDimensions, screenshotEvent } from "../image-assets.ts";
import { browserKindLabel, edgeHub, edgeLink, EDGE_EXTENSION_DIR } from "../edge-link.ts";
import { tenantMode } from "../tenant.ts";
import { browserAvailable } from "../headless.ts";
import { redactOutput } from "../redact.ts";
import { WEB_CONTENT_NOTE } from "./untrusted.ts";

// The Browser tool: drive the shared headless browser — navigate (any URL,
// including apps started with Preview), click/type/scroll/hover, emulate
// viewports, read the browser-side console, and screenshot the CURRENT state.
// Page reading lives in ReadPage, JS evaluation in Eval, request auditing in
// Network — all four operate on this same browser, so state persists.
//
// 2026-10-28 对齐 bridge 里 Claude 的浏览器工具（src/runtime/browser-actions.mjs）：动作结果确认（落点 / 遮挡 / 前后比对，
// 见 browser-verify.ts）、expect / wait_for / batch / screenshot_after、截图坐标帧换算、find / set_value / page_text /
// upload / reload、长按 / 拖拽 / 双指、修饰键点击、横向与按元素滚动、原生对话框自动应答、页面新开的标签自动跟过去、
// 面板有没有人在看。

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

// 多标签时结果尾巴补 [tab i/N]：模型永远知道自己刚看 / 刚点的是哪一页
function tabTag(page: CdpSession | undefined): string {
  if (!page || page.tabs.length < 2) return "";
  const i = page.tabs.findIndex((t) => t.active);
  return i < 0 ? "" : ` [tab ${i + 1}/${page.tabs.length}]`;
}

// 这些动作可能让页面开新标签（用户手势触发的 window.open / _blank 链接 / 表单 target）
const MAY_POPUP = new Set(["click", "key", "type", "long_press"]);

// 动作前拍一张标签快照，动作后调返回的函数：页面若新开了标签就切过去（像真浏览器一样），返回给模型的说明（没开 = ""）。
function watchPopups(page: CdpSession, action: string): () => Promise<string> {
  if (!MAY_POPUP.has(action)) return async () => "";
  const before = new Set(page.tabs.map((t) => t.id));
  const opener = page.tabs.findIndex((t) => t.active) + 1;
  return async () => {
    let fresh = page.tabs.filter((t) => !before.has(t.id));
    if (!fresh.length) {
      await delayMs(120); // Target.targetCreated 可能比动作返回晚一拍到
      fresh = page.tabs.filter((t) => !before.has(t.id));
      if (!fresh.length) return "";
    }
    const t = fresh[fresh.length - 1];
    await page.activateTab(t.id);
    for (let i = 0; i < 15; i++) {
      // 给新页首屏最多 1.5s，之后的截图不至于是白板
      const st = await page.eval("document.readyState").catch(() => "");
      if (st === "complete" || st === "interactive") break;
      await delayMs(100);
    }
    const idx = page.tabs.findIndex((x) => x.id === t.id) + 1;
    const cur = page.tabs[idx - 1] ?? t;
    const more = fresh.length > 1 ? ` (${fresh.length} opened; see Browser(tabs) for the rest)` : "";
    return (
      `\nThe page OPENED A NEW TAB${more} — switched to it: tab ${idx} ${cur.title || "(untitled)"} — ${cur.url}` +
      (opener > 0 ? `\nThe original page is still tab ${opener}: Browser(tab_switch, tab:${opener}) to go back, or pass tab:${opener} with any action.` : "")
    );
  };
}

// 用户此刻看不看得到这个浏览器（对齐 bridge 的 viewerReport）：要用户在里面动手（登录、过验证、确认）之前先确认他看得见。
async function viewerReport(page: CdpSession): Promise<string> {
  if (page.edge) return `This is the user's own ${browserKindLabel(page.edgeKind)} window — they see it on their screen.`;
  const list = page.viewerList();
  const native = list.filter((v) => v.kind === "native").length;
  const streams = list.filter((v) => v.kind === "stream").length;
  const shell = page.external ? await page.shellViewState().catch(() => null) : null;
  if (shell?.windowShown && (shell.mounted || shell.parent === "device")) {
    return `The user can see this page: the desktop app's Browser panel is showing it${shell.focused ? "" : " (window not in front)"}.`;
  }
  if (streams) {
    return `The dimensio Browser panel is open${streams > 1 ? ` in ${streams} places` : ""} (whether it is on screen is unknown). Before asking the user to act in it, say so in your reply.`;
  }
  const unseen = native
    ? shell
      ? "The desktop app has the browser card open, but this page is not on screen right now. "
      : "The desktop app has the browser panel open (this desktop app version cannot tell whether it is on screen). "
    : "";
  return (
    `${unseen}Nobody is watching the Browser panel: the user cannot see this browser and does not know what you do in it. ` +
    "Before asking them to act in it (sign in, solve a verification, confirm), ask them to open the browser card in dimensio's workspace panel; " +
    "always say in your reply what you found or did there."
  );
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
    what = `region at ${Math.round(c.x)},${Math.round(c.y)} (${Math.round(c.width)}×${Math.round(c.height)} screenshot px)`;
  }
  let text = ` — ${what}${dims ? `, ${dims.width}×${dims.height} px image` : ""}` +
    `${shot.region?.clamped ? " (region clamped to the page, at most 10000 px per side)" : ""}.`;
  if (shot.frame) {
    const scaled = Math.abs(shot.frame.k - 1) > 0.001;
    text += scaled
      ? ` The page is scaled ×${(1 / shot.frame.k).toFixed(3)} in this image — give click/hover x,y in THIS image's pixels; the tool converts them.`
      : " Image pixels = CSS pixels: click/hover x,y can be read straight off it.";
  } else if (shot.region) {
    text += " This is a zoomed crop — coordinates still refer to the last full-viewport screenshot.";
  }
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

// "ctrl+shift" → CDP 修饰位（Alt 1 / Ctrl 2 / Meta 4 / Shift 8）；空 = 0，认不出 = null。
const MOD_BITS: Record<string, number> = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, shift: 8 };
export function modifierBits(spec: unknown): number | null {
  if (spec == null || String(spec).trim() === "") return 0;
  let bits = 0;
  for (const part of String(spec).toLowerCase().split(/[+\s,]+/).filter(Boolean)) {
    if (!(part in MOD_BITS)) return null;
    bits |= MOD_BITS[part];
  }
  return bits;
}

const ACTIONS = [
  "navigate", "attach", "edge", "back", "forward", "reload", "tabs", "tab_new", "tab_switch", "tab_close",
  "click", "type", "key", "scroll", "hover", "long_press", "drag", "pinch", "set_value", "upload",
  "find", "page_text", "resize", "dprprobe", "console", "screenshot", "wait_for", "close", "batch",
];
// 会改变页面、可以挂 expect 的动作
const ACTING = new Set([
  "navigate", "back", "forward", "reload", "click", "type", "key", "scroll", "hover", "long_press", "drag", "pinch",
  "tab_new", "tab_switch", "set_value", "upload", "resize",
]);
// 标签管理类动作自己处理 tab 参数；其余动作带了 tab = 先把那个标签切到前台
const TAB_OPS = new Set(["tabs", "tab_new", "tab_switch", "tab_select", "tab_close", "close", "attach", "edge"]);

const expectSchema = {
  type: "object" as const,
  description:
    "Result expectation: after the action, wait (expect_timeout_ms, default 3000) until ALL given conditions hold, else the action fails (a batch stops).",
  properties: {
    text: { type: "string" as const, description: "This text should appear in the page text." },
    gone: { type: "string" as const, description: "This text should no longer be in the page text." },
    url: { type: "string" as const, description: "The URL should contain this." },
    selector: { type: "string" as const, description: "A CSS selector that should exist and be visible." },
    focus: { type: "string" as const, description: "The focused element's description (role / name / #id) should contain this." },
    value: { type: "string" as const, description: "The focused field's value should contain this." },
    changed: { type: "boolean" as const, description: "true = the page should change; false = it should not." },
  },
};

// 单步参数（batch 的每一步与顶层同一套）
const STEP_PROPS = {
  url: { type: "string" as const, description: "For navigate / tab_new / edge: full http(s)/file URL, or a \"/path\" on the running Preview server." },
  tab: {
    type: "string" as const,
    description:
      "For tab_switch / tab_close: 1-based tab index from Browser(tabs), or a targetId (tab_close defaults to the current tab). With any OTHER action: switch to that tab first, e.g. screenshot + tab:\"2\".",
  },
  port: { type: "integer" as const, description: "For attach: the app's DevTools port (its --remote-debugging-port value)." },
  target: { type: "string" as const, description: "For attach: pick the window whose title/URL contains this substring (when the app has several)." },
  browser: {
    type: "string" as const,
    enum: ["edge", "chrome"],
    description:
      "For edge: WHICH of the user's own browsers to take over — \"edge\" (Microsoft Edge) or \"chrome\" (Google Chrome). " +
      "Required when the extension is connected in both; follow the user's wording (\"my Chrome\" → chrome).",
  },
  ref: {
    type: "integer" as const,
    description:
      "Element ref number from ReadPage / find (12 for [ref12]): the target of click / type / hover / long_press / drag (start) / set_value / upload / screenshot; scroll with only ref = scroll it into view.",
  },
  text: { type: "string" as const, description: "For click: match by visible text. For type: the text to type. For find: words to look for." },
  selector: { type: "string" as const, description: "CSS selector: type / set_value / upload target, or the element to screenshot." },
  value: {
    type: "string" as const,
    description:
      "For set_value: option text or value for a <select> (several separated by \\n for multi-select), true/false for a checkbox/radio, YYYY-MM-DD for a date, HH:MM for a time, a number for a range.",
  },
  files: { type: "array" as const, items: { type: "string" as const }, description: "For upload: absolute paths of local files to put into the <input type=file>." },
  clip: {
    type: "object" as const,
    description: "For screenshot: capture just this rectangle, in pixels of the last full screenshot (the same coordinates as click x/y).",
    properties: {
      x: { type: "number" as const },
      y: { type: "number" as const },
      width: { type: "number" as const },
      height: { type: "number" as const },
    },
    required: ["x", "y", "width", "height"],
  },
  waitMs: {
    type: "integer" as const,
    description: `For screenshot: wait this long (max ${MAX_SHOT_WAIT_MS} ms) before capturing, then still wait for animations; 0 = capture immediately, mid-animation.`,
  },
  x: { type: "number" as const, description: "Pixel x in the most recent screenshot (click / hover / long_press / drag start / scroll pointer / pinch centre)." },
  y: { type: "number" as const, description: "Pixel y in the most recent screenshot." },
  to_x: { type: "number" as const, description: "For drag: end x (screenshot pixels)." },
  to_y: { type: "number" as const, description: "For drag: end y (screenshot pixels)." },
  to_ref: { type: "integer" as const, description: "For drag: the [refN] of the drop target." },
  scale: { type: "number" as const, description: "For pinch: zoom factor (>1 spreads, <1 pinches; default 2)." },
  ms: { type: "integer" as const, description: "For wait_for: just sleep this long (≤15000). For long_press / drag: how long to hold before releasing / moving." },
  button: { type: "string" as const, enum: ["left", "right"], description: "For click: mouse button (default left)." },
  double: { type: "boolean" as const, description: "For click: double-click." },
  modifiers: { type: "string" as const, description: "For click: hold modifier keys while clicking, e.g. \"ctrl\" (open in new tab / multi-select), \"shift\", \"ctrl+shift\"." },
  force: { type: "boolean" as const, description: "For click: click a ref even when an overlay covers it." },
  key: { type: "string" as const, description: "For key: key name or combo, e.g. \"enter\", \"ctrl+a\"." },
  dy: { type: "integer" as const, description: "For scroll: vertical pixels (positive = down). Default 600 when neither dy nor dx is given." },
  dx: { type: "integer" as const, description: "For scroll: horizontal pixels (positive = right) — carousels, wide tables." },
  preset: { type: "string" as const, enum: ["mobile", "tablet", "desktop"], description: "For resize: viewport preset (mobile/tablet also emulate a touch device)." },
  width: { type: "integer" as const, description: "For resize: explicit viewport width." },
  height: { type: "integer" as const, description: "For resize: explicit viewport height." },
  colorScheme: { type: "string" as const, enum: ["dark", "light", "auto"], description: "For resize: emulate prefers-color-scheme." },
  dpr: { type: "number" as const, description: "For dprprobe: devicePixelRatio to emulate (default 2; 1.25 = Windows default scaling, 2–3 = phones)." },
  question: { type: "string" as const, description: "For screenshot (text-only agents): what to visually verify — a vision model answers. Be specific." },
  lines: { type: "integer" as const, description: "For console: how many recent entries (default 100)." },
  query: { type: "string" as const, description: "For console: only entries containing this text." },
  errors_only: { type: "boolean" as const, description: "For console: only errors / exceptions / failed requests." },
  maxChars: { type: "integer" as const, description: "For page_text: return at most this many characters (default 20000)." },
  expect: expectSchema,
  expect_timeout_ms: { type: "integer" as const, description: "How long expect / wait_for may wait (default 3000, max 15000)." },
  verify: { type: "boolean" as const, description: "false = skip the hit checks and result confirmation (faster, but a miss goes unnoticed)." },
  screenshot_after: { type: "boolean" as const, description: "After the action (once the page settled) also take a screenshot and return it." },
};

export const browserTool: Tool = {
  effect: "exec",
  concurrencySafe: false,
  // D5：本机浏览器、桌面壳的浏览器宿主、经扩展连着的用户浏览器一个都没有（例如没装浏览器的 Linux VPS）就不提供，见 headless.ts
  enabled: browserAvailable,
  def: {
    name: "Browser",
    description:
      "Drive a real (headless) browser. ONE shared browser persists across calls — the page you navigated " +
      "to, clicked, and typed into stays put; ReadPage/Eval/Network operate on this same page. The user watches it live in " +
      "dimensio's Browser panel and can take over. Sign-ins made in the built-in browser persist across sessions and belong to " +
      "the user: never sign out or change their credentials. Actions:\n" +
      "• navigate — go to a full http(s)/file URL, or a \"/path\" on the running Preview server; returns once the page has loaded and settled, and says whether the user can see the browser right now. Also: back | forward | reload.\n" +
      "• tabs — list open tabs (1-based index + title + URL; → marks the current one) and whether the user is watching.\n" +
      "• tab_new — open a NEW tab (optional `url`, default about:blank) and switch to it. Every tab keeps its own " +
      "page state; all browser tools always act on the CURRENT tab.\n" +
      "• tab_switch — make another tab current (`tab`: 1-based index or targetId). Use it to work across pages — " +
      "e.g. a reference site in one tab and your own app in another, switching to compare. Any other action also takes `tab` " +
      "(switches first). When a click opens a popup / target=_blank link, the tool switches to the new tab and says so.\n" +
      "• tab_close — close a tab (`tab`, default = current). Closing the LAST tab shuts the whole browser down.\n" +
      "• attach — retarget every browser tool (this one plus ReadPage/Eval/Network) at an ALREADY-RUNNING " +
      "Chromium-based app that exposes a DevTools port: an Electron desktop app or packaged exe launched with " +
      "--remote-debugging-port=<port>, or any headful Chrome. Pass `port`; optional target:\"substring\" picks " +
      "a window by title/URL when several exist. close then DETACHES without quitting the app.\n" +
      "• edge — switch every browser tool to the USER'S OWN browser — Microsoft Edge or Google Chrome, picked with " +
      "`browser` (through the dimensio extension): " +
      "their real logged-in sessions, cookies and extensions. You only ever work in tabs of the \"dimensio\" tab group " +
      "(the user drags tabs in to share them, out to take them back); optional `url` opens there. The user sees a glow " +
      "and your pointer on that page and can stop you. Use it ONLY when the task needs the user's real browser (their " +
      "accounts, a site they are logged into) or they ask for it — previews and verification stay on the built-in " +
      "browser. There, before anything outward-facing or irreversible (send, post, submit, purchase, delete, change " +
      "settings) AskUserQuestion first. close detaches and leaves the tabs open for the user.\n" +
      "• click — click by `ref` (from ReadPage / find — most reliable), by visible `text`, or by `x`/`y` (pixels of the last screenshot). " +
      "Optional: button:\"right\", double:true, modifiers:\"ctrl\"|\"shift\"|…, force:true (click a covered ref anyway).\n" +
      "• type — focus a target (`ref` or CSS `selector`; omit to use current focus) and type `text` into it; the field is read back.\n" +
      "• key — press a key or combo: enter, tab, escape, backspace, delete, space, arrow keys, " +
      "pageup/pagedown/home/end, or combos like \"ctrl+a\".\n" +
      "• scroll — scroll by `dy` (down) and/or `dx` (right) px, over `ref` or x,y (inner scroll areas, carousels); ref alone = scroll that element into view.\n" +
      "• hover — move the mouse over `ref` or `x`/`y` (reveals menus/tooltips).\n" +
      "• long_press (ref | x,y; ms, default 800) — press and hold; in touch mode the browser's own gesture pipeline fires contextmenu like a phone. " +
      "drag (from ref | x,y → to_ref | to_x,to_y; ms = hold before moving) — moves in small steps; HTML5 drag-and-drop (draggable / links / images) " +
      "is delivered as real drag events. pinch (x?,y?, scale) — two-finger zoom, touch mode only.\n" +
      "• set_value (ref | selector, value) — set a form control directly: native <select> (its popup is invisible in screenshots and cannot be clicked), " +
      "checkbox / radio, date / time / range / color / number / text inputs, textarea, contenteditable — fires input + change; the control is read back.\n" +
      "• upload (files[], ref? | selector?) — put local files (absolute paths) into an <input type=file> (hidden inputs too; default = the first file input " +
      "in the visible part of the page), then submit the form normally.\n" +
      "• find (text) — locate elements: every word must appear in the accessibility line; up to 20 lines with fresh [refN] handles — cheaper than paging ReadPage.\n" +
      "• page_text (maxChars?) — the readable text of the page (article / main first, else body) — far cheaper than ReadPage for articles, docs and long lists.\n" +
      "• resize — viewport: preset \"mobile\"|\"tablet\"|\"desktop\" or explicit `width`+`height` (mobile/tablet also emulate touch: touch events, " +
      "mobile UA, pointer:coarse); optional colorScheme:\"dark\"|\"light\" to test themes. The default viewport is desktop (1280×900) — " +
      "when the task is a MOBILE app/page, resize to preset:\"mobile\" FIRST and keep working there, so " +
      "every screenshot and the user's live Browser pane show the phone-shaped layout, not a desktop letterbox. Re-screenshot before using coordinates.\n" +
      "• dprprobe — reload the current page at an emulated devicePixelRatio (default 2), scroll through it " +
      "with real input, and check every <canvas> backing store for DPR-scaling bugs (feedback loops, blowout, " +
      "runaway page height), then restore DPR 1. Headless default is DPR 1 — the one ratio where such bugs are " +
      "symptom-free — while real displays run 1.25–3, so canvas/WebGL pages MUST pass this probe once after " +
      "edits before being declared done. Counts as verification evidence.\n" +
      "• console — browser-side signals of THIS browser (console.*, uncaught errors, failed requests, auto-answered dialogs); query / errors_only filter. " +
      "CDP-native: works regardless of any preview pane.\n" +
      "• screenshot — capture the CURRENT state. It first waits for running CSS/JS animations and web fonts to " +
      `finish (up to ${SETTLE_MAX_MS / 1000} s); waitMs adds a fixed wait before that (e.g. for data to load), waitMs:0 captures ` +
      "immediately. Shoot ONE element with `selector` (CSS) or `ref` (from ReadPage) — scrolled into view if needed — " +
      "or a rectangle with clip:{x,y,width,height}. A full-viewport screenshot becomes the coordinate basis for x,y. If you can see images it is handed back to you to " +
      "judge; otherwise ask a specific `question` and a vision model returns a text verdict.\n" +
      "• wait_for — wait for expect:{…} to hold (or just ms) without acting.\n" +
      "• close — shut the browser down (a later action relaunches it fresh).\n" +
      VERIFY_DESC +
      "\nTypical loop: navigate → ReadPage / find → click/type (by ref) with expect → Eval to assert DOM state → screenshot to " +
      "verify visually. Prefer Eval/ReadPage assertions over screenshots for functional checks — cheaper and exact.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ACTIONS,
          description: ACTIONS.join(" | "),
        },
        ...STEP_PROPS,
        actions: {
          type: "array",
          description: `For batch: up to ${BATCH_MAX} steps run in order, each an object with its own action and fields (same fields as above, no nested batch); stops at the first failure.`,
          items: {
            type: "object",
            properties: { action: { type: "string", enum: ACTIONS.filter((a) => a !== "batch") }, ...STEP_PROPS },
            required: ["action"],
          },
        },
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
    if (action === "batch") return runBatch(args.actions, ctx);
    return runStep(args, ctx);
  },
};

// batch：逐步跑，遇错即停。截图只回最后 3 张，免得一次塞爆上下文。
async function runBatch(steps: unknown, ctx: ToolContext): Promise<ToolRunResult> {
  if (!Array.isArray(steps) || !steps.length) return fail("browser batch", "batch needs `actions` — an array of steps like {action:\"click\", ref:3}.");
  if (steps.length > BATCH_MAX) return fail("browser batch", `batch takes at most ${BATCH_MAX} steps (got ${steps.length}).`);
  const lines: string[] = [];
  const feedback: Block[] = [];
  const events: AgentEvent[] = [];
  let verification: ToolRunResult["verification"];
  for (let i = 0; i < steps.length; i++) {
    const step = (steps[i] && typeof steps[i] === "object" ? steps[i] : {}) as Record<string, unknown>;
    const name = String(step.action ?? "").trim();
    if (name === "batch") return fail("browser batch", [...lines, `${i + 1}. batch ✗: batches cannot be nested`].join("\n"));
    const r = await runStep(step, ctx);
    const txt = r.content.filter((c) => c.t === "text").map((c) => (c as { text: string }).text).join("\n");
    feedback.push(...(r.feedback ?? []));
    events.push(...(r.events ?? []));
    verification ??= r.verification;
    lines.push(`${i + 1}. ${name || "?"}${r.ok ? "" : " ✗"}: ${txt.replace(/\n/g, "\n   ")}`);
    if (!r.ok) {
      const rest = steps.length - i - 1;
      return {
        ok: false,
        summary: `batch stopped at step ${i + 1}/${steps.length} (${name})`,
        content: [{ t: "text", text: lines.join("\n") + (rest ? `\nStep ${i + 1} failed — the remaining ${rest} step(s) did not run.` : "") }],
        feedback: keepLastImages(feedback),
        events: keepLastShots(events),
        ...(verification ? { verification } : {}),
      };
    }
  }
  return {
    ok: true,
    summary: `batch: ${steps.length} step(s)`,
    content: [{ t: "text", text: lines.join("\n") }],
    feedback: keepLastImages(feedback),
    events: keepLastShots(events),
    ...(verification ? { verification } : {}),
  };
}

function keepLastImages(blocks: Block[]): Block[] | undefined {
  const imgs = blocks.filter((b) => b.t === "image");
  const rest = blocks.filter((b) => b.t !== "image");
  const out = [...rest, ...imgs.slice(-3)];
  return out.length ? out : undefined;
}

function keepLastShots(events: AgentEvent[]): AgentEvent[] | undefined {
  const shots = events.filter((e) => e.e === "screenshot");
  const rest = events.filter((e) => e.e !== "screenshot");
  const out = [...rest, ...shots.slice(-3)];
  return out.length ? out : undefined;
}

// 单步：动作本身 → 通用收尾（expect → screenshot_after → 标签角标 → 对话框回报）
async function runStep(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
  const action = String(args.action ?? "").trim();
  let result: ToolRunResult;
  let changedNow: boolean | null = null;
  const setChanged = (v: boolean) => {
    changedNow = v;
  };
  try {
    result = await act(action, args, ctx, setChanged);
  } catch (e) {
    result = fail(`browser ${action}`, `${action} failed: ${(e as Error).message}`);
  }
  const live = existingSharedBrowser();
  try {
    if (result.ok && live && ACTING.has(action) && hasExpect(args.expect)) {
      const miss = await waitExpect(live, args.expect, { timeoutMs: Number(args.expect_timeout_ms) || 3000, changedNow });
      const last = lastText(result);
      if (miss) {
        result.ok = false;
        result.summary += " — expectation not met";
        if (last) last.text += `\n✗ Expectation not met: ${miss.join("; ")}`;
      } else if (last) {
        // 预期满足了，动作后「一时没变化」的警告就是过时结论，别留着误导
        last.text = last.text.replace(/⚠ Nothing on the page changed[^\n]*/, "nothing changed right after the action, but the expectation was then met") + "\n✓ Expectation met";
      }
    }
    if (result.ok && args.screenshot_after === true && action !== "screenshot" && live) {
      const blocked = fileUrlBlock(live.url, ctx.sandbox);
      if (!blocked) {
        const s = await captureAndReport(live, "", ctx, {});
        result.content.push(...s.content);
        if (s.feedback) result.feedback = [...(result.feedback ?? []), ...s.feedback];
        if (s.events) result.events = [...(result.events ?? []), ...s.events];
      }
    }
    const tag = tabTag(live);
    const last = lastText(result);
    if (tag && result.ok && !/^tab/.test(action) && last) last.text += tag;
  } catch (e) {
    const last = lastText(result);
    if (last) last.text += `\n(post-action check failed: ${(e as Error).message})`;
  }
  const note = dialogNote(live ?? null);
  if (note) {
    const last = lastText(result);
    if (last) last.text += note;
    else result.content.push({ t: "text", text: note.trim() });
  }
  return result;
}

function lastText(r: ToolRunResult): { t: "text"; text: string } | undefined {
  return [...r.content].reverse().find((c) => c.t === "text") as { t: "text"; text: string } | undefined;
}

function browserEvent(page: CdpSession): AgentEvent {
  return { e: "browser", url: page.url, ...(page.edge ? { edge: true } : {}) };
}

// 动作后的比对结论拼进结果
async function settleReport(page: CdpSession, before: PageState | null, kind: ActKind, setChanged: (v: boolean) => void, maxMs?: number): Promise<string> {
  if (!before) {
    await delayMs(kind === "scroll" ? 250 : 300);
    return "";
  }
  const r = await afterAction(page, before, kind, maxMs ? { maxMs } : {});
  setChanged(r.changed);
  return r.lines.length ? `\nResult: ${r.lines.join("; ")}` : kind === "hover" ? "\nResult: nothing changed (no hover menu / tooltip appeared)" : "";
}

async function act(action: string, args: Record<string, unknown>, ctx: ToolContext, setChanged: (v: boolean) => void): Promise<ToolRunResult> {
  const owner = ctx.ownerId ?? "";
  const verify = args.verify !== false;

  if (action === "close") {
    releaseBrowser(owner);
    const cur = existingSharedBrowser();
    if (!cur) return ok("browser already closed", "No browser was running.");
    const wasAttached = cur.attached;
    const wasEdge = cur.edge;
    const edgeName = browserKindLabel(cur.edgeKind);
    closeAllBrowserSessions();
    if (wasEdge) {
      return ok(
        `detached from ${edgeName}`,
        `Detached from the user's ${edgeName} — the dimensio tab group stays open for them. The next Browser/ReadPage/Eval/Network call uses the built-in browser again.`,
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
    // Edge 和 Chrome 可以同时连着扩展：`browser` 指定接哪一个；没指定且只连了一个就用它，两个都连着就让模型说清楚
    const want = String(args.browser ?? "").trim().toLowerCase();
    const live = edgeHub().connectedLinks();
    const liveNames = live.map((l) => `${l.kind} (${l.label})`).join(", ");
    const setup = (kind: string) => {
      const scheme = kind === "chrome" ? "chrome://extensions" : "edge://extensions";
      return (
        `Tell the user how to set it up: in ${browserKindLabel(kind)} open ${scheme}, turn on Developer mode, "Load unpacked" and pick the folder ${EDGE_EXTENSION_DIR} ` +
        "(already installed? click the extension's toolbar icon — it shows why it isn't connected). Then try again."
      );
    };
    if (want && want !== "edge" && want !== "chrome") {
      return fail("browser edge", `Unknown browser "${want}". Use browser:"edge" or browser:"chrome".`);
    }
    const link = want ? edgeLink(want) : live.length === 1 ? live[0] : null;
    if (!want && live.length > 1) {
      return fail(
        "browser edge",
        `The dimensio extension is connected in more than one of the user's browsers: ${liveNames}. ` +
          'Pass browser:"edge" or browser:"chrome" — the one the user meant (ask them if it is unclear).',
      );
    }
    if (!link?.connected) {
      const name = browserKindLabel(want || "edge");
      return fail(
        "browser edge",
        (want
          ? `The user's ${name} is not connected: the dimensio extension there is not installed, not enabled, or cannot reach dimensio. `
          : "None of the user's browsers is connected: the dimensio extension is not installed, not enabled, or cannot reach dimensio. ") +
          (live.length ? `Connected right now: ${liveNames}. ` : "") +
          setup(want || "edge"),
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
      const { session, created } = await attachEdgeBrowser(url || undefined, link.kind);
      const name = browserKindLabel(link.kind);
      const where = created
        ? `opened a new tab in a "dimensio" tab group (the group was empty — if the user meant a page they already have open, ask them to drag that tab into the group)`
        : `took over the "dimensio" tab group`;
      const others = live.filter((l) => l !== link).map((l) => l.label);
      return {
        ok: true,
        summary: `connected to ${name}`,
        content: [
          {
            t: "text",
            text:
              `Connected to the user's ${name} (${link.label}) and ${where}. Current tab: ${await pageStamp(session)}\n\n` +
              `${formatTabs(session)}\n\n` +
              `ReadPage / Browser(navigate|click|type|key|scroll|screenshot|tabs|tab_new) / Eval / Network now act on the user's real, logged-in ${name}. ` +
              (others.length ? `(Also connected but NOT in use: ${others.join(", ")}.) ` : "") +
              "Stay inside this tab group, ask before outward-facing or irreversible actions, and Browser(close) when done (the tabs stay for the user). " +
              "Call Browser(edge) once and wait for it — don't batch other browser calls in parallel with it.",
          },
        ],
        events: [{ e: "browser", url: session.url, edge: true }],
      };
    } catch (e) {
      return fail("browser edge", `Could not take over the ${browserKindLabel(link.kind)} tab group: ${(e as Error).message}`);
    }
  }

  if (action === "console") {
    const page = existingSharedBrowser();
    if (!page) return fail("browser console", noBrowserMessage());
    const n = Math.max(1, Math.min(400, Number(args.lines ?? 100)));
    let all = page.consoleEntries();
    if (args.errors_only === true) all = all.filter((e) => /error|exception|assert|network/i.test(String(e.type)));
    const q = typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
    if (q) all = all.filter((e) => String(e.msg).toLowerCase().includes(q));
    const entries = all.slice(-n);
    const filtered = args.errors_only === true || q ? ` (filtered: ${[args.errors_only === true ? "errors only" : "", q ? `"${q}"` : ""].filter(Boolean).join(" + ")})` : "";
    const body = entries.length
      ? entries.map((e) => `[${e.type}] ${e.msg}`).join("\n")
      : "(no console output captured yet)";
    return ok(`console (${entries.length})`, `Browser console/errors/failed requests at ${page.url}${filtered}:\n\n${body}`);
  }

  if (action === "wait_for") {
    const page = existingSharedBrowser();
    if (!page) return fail("browser wait_for", noBrowserMessage());
    if (hasExpect(args.expect)) {
      const t0 = Date.now();
      const miss = await waitExpect(page, args.expect, { timeoutMs: Number(args.expect_timeout_ms) || 3000 });
      if (miss) return fail("browser wait_for — timed out", `Timed out; still not met: ${miss.join("; ")}`);
      return ok("wait_for — met", `Condition met (waited ${((Date.now() - t0) / 1000).toFixed(1)} s).`);
    }
    if (args.ms != null) {
      const ms = Math.max(0, Math.min(15_000, Number(args.ms) || 0));
      await delayMs(ms);
      return ok(`waited ${ms}ms`, `Waited ${ms} ms.`);
    }
    return fail("browser wait_for", 'wait_for needs expect (e.g. {text:"Saved"}) or ms.');
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

  // Everything below needs a live browser (navigate / tab_new create one; resize may start a blank page first).
  let page: CdpSession;
  const wasDead = !existingSharedBrowser();
  let launchedNote = "";
  try {
    if (action === "navigate" || action === "tab_new") {
      page = await getSharedBrowser();
    } else {
      const existing = existingSharedBrowser();
      if (!existing && action === "resize" && !noBrowserMessage().includes("ended")) {
        // 先定尺寸再开页面是最自然的顺序：先起一个空白页，视口随实例保留到之后的 navigate
        page = await getSharedBrowser();
        launchedNote = "\n(The browser was not running — started it on a blank page; the next navigate keeps this viewport.)";
      } else if (!existing) {
        return fail(`browser ${action}`, noBrowserMessage());
      } else {
        page = existing;
      }
    }
  } catch (e) {
    return fail(`browser ${action}`, `Could not launch the browser: ${(e as Error).message}`);
  }

  // 带 tab 的非标签动作：先把那个标签切到前台
  if (args.tab != null && String(args.tab).trim() !== "" && !TAB_OPS.has(action)) {
    const id = resolveTabArg(page, args.tab);
    if (!id) return fail(`browser ${action}`, `No tab ${args.tab}.\n\n${formatTabs(page)}`);
    if (!page.tabs.find((t) => t.id === id)?.active) await page.activateTab(id);
  }

  const popped = watchPopups(page, action);
  switch (action) {
    case "navigate": {
      const raw = String(args.url ?? "").trim();
      if (!raw) return fail("browser navigate", "action=navigate requires `url`.");
      const url = resolveUrl(raw, ctx.ownerId ?? "");
      const t0 = Date.now();
      const nav = await page.navigate(url);
      const doc = [...page.networkEntries()].reverse().find((e) => e.t >= t0 && e.resourceType === "Document");
      const warn = nav.errorText ? `\n⚠ Load failed: ${nav.errorText}` : doc?.status && doc.status >= 400 ? `\n⚠ The server answered ${doc.status}` : "";
      const slow = nav.settled ? "" : " — the page is still changing (animation / polling), returned early";
      return {
        ok: !nav.errorText,
        summary: `→ ${url}`,
        content: [
          {
            t: "text",
            text:
              `Browser is now at ${await pageStamp(page)} (${(nav.ms / 1000).toFixed(1)} s${slow}).${warn}\n${await viewerReport(page)}\n` +
              "Next: ReadPage (or find) to see the page structure and get clickable [refN] handles.",
          },
        ],
        events: [browserEvent(page)],
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
        events: [browserEvent(page)],
      };
    }
    case "reload": {
      const r = await page.reload();
      return {
        ok: true,
        summary: `reloaded ${page.url}`,
        content: [{ t: "text", text: `Reloaded ${await pageStamp(page)} (${(r.ms / 1000).toFixed(1)} s${r.settled ? "" : ", still changing"}).` }],
        events: [browserEvent(page)],
      };
    }
    case "tabs": {
      return ok(`tabs (${page.tabs.length})`, `${formatTabs(page)}\n\n${await viewerReport(page)}`);
    }
    case "tab_new": {
      const raw = String(args.url ?? "").trim();
      const url = raw ? resolveUrl(raw, ctx.ownerId ?? "") : "about:blank";
      if (wasDead) {
        // 刚拉起的浏览器自带首个标签 —— 它就是新标签（导航过去即可，别再生第二个）
        if (url !== "about:blank") await page.navigate(url);
      } else {
        const t0 = Date.now();
        await page.newTab(url);
        if (url !== "about:blank") {
          await delayMs(80);
          await page.settle({ since: t0, quietMs: 300, maxMs: 8000 }); // 等新页首屏
        }
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
        events: [browserEvent(page)],
      };
    }
    case "tab_switch":
    case "tab_select": {
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
        events: [browserEvent(page)],
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
        events: [browserEvent(page)],
      };
    }
    case "click": {
      const mods = modifierBits(args.modifiers);
      if (mods == null) return fail("browser click", `modifiers takes combinations of ctrl / shift / alt / meta (e.g. "ctrl+shift"), not "${args.modifiers}".`);
      const opts = {
        button: (args.button === "right" ? "right" : "left") as "left" | "right",
        clickCount: args.double === true ? 2 : 1,
        modifiers: mods,
      };
      const urlBefore = page.url;
      let pt: { x: number; y: number };
      let where: string;
      let hitBefore: unknown;
      let hitDesc: string | null = null;
      if (args.ref != null && Number.isInteger(Number(args.ref))) {
        const ref = Number(args.ref);
        if (verify) {
          const p = await probeRef(page, ref, { force: args.force === true });
          pt = p;
          hitBefore = p.before;
          hitDesc = p.hit;
          where = `ref${ref} ${p.hit}${p.covered ? ` (covered by ${p.covered} — clicked anyway with force)` : ""}`;
        } else {
          const info = page.refInfo(ref);
          pt = await page.refCenter(ref);
          where = `ref${ref} (${info.role}${info.name ? ` "${info.name}"` : ""})`;
        }
      } else if (typeof args.text === "string" && args.text.trim()) {
        const t = args.text.trim();
        pt = await page.findTextPoint(t);
        where = `"${t}"`;
        if (verify) {
          const p = await probePoint(page, pt.x, pt.y);
          hitBefore = p.before;
          hitDesc = p.hit;
          where = `"${t}" → ${p.hit}`;
        }
      } else if (args.x != null && args.y != null) {
        pt = page.frameToCss(Number(args.x), Number(args.y));
        where = `(${args.x}, ${args.y})`;
        if (verify) {
          const p = await probePoint(page, pt.x, pt.y);
          hitBefore = p.before;
          hitDesc = p.hit;
          where += ` → ${p.hit || "(no element)"}${p.iframe ? " (inside an iframe — cannot see what is in there)" : p.clicky ? "" : " (not a button / link / other clickable control)"}`;
        }
      } else {
        return fail("browser click", "action=click needs one of: `ref`, `text`, or `x`+`y`.");
      }
      const before = verify ? await pageState(page) : null;
      if (before) {
        before.hitBefore = hitBefore;
        before.hitDesc = hitDesc;
      }
      await page.dispatchClick(pt.x, pt.y, opts);
      const res = await settleReport(page, before, "click", setChanged);
      const note = await popped();
      // 原生 <select> 的下拉层由浏览器自己画，截图里看不见、也点不中选项
      const selHint = /^select\b/.test(String(hitDesc || ""))
        ? '\nHint: this is a native <select> — its option list is invisible in screenshots and cannot be clicked; use Browser(set_value, ref|selector, value:"option text").'
        : "";
      const modTag = mods ? ` (holding ${String(args.modifiers).toLowerCase()})` : "";
      const moved = page.url !== urlBefore && !note ? " refs are stale now — ReadPage again." : "";
      return {
        ok: true,
        summary: `clicked ${where.split(" →")[0]}`,
        content: [{ t: "text", text: `Clicked ${where}${modTag}.${res}${note}${selHint}\n(now at ${page.url})${moved}` }],
        ...(note || moved ? { events: [browserEvent(page)] } : {}),
      };
    }
    case "long_press":
    case "drag":
    case "pinch": {
      // 起点：ref 或 x,y（pinch 缺省视口中心）；drag 终点：to_ref 或 to_x,to_y
      const at = async (ref: unknown, x: unknown, y: unknown, center: boolean): Promise<{ pt: { x: number; y: number }; where: string } | null> => {
        if (ref != null && Number.isInteger(Number(ref))) {
          const r = Number(ref);
          if (verify) {
            const p = await probeRef(page, r, { force: true });
            return { pt: p, where: `ref${r} ${p.hit}` };
          }
          return { pt: await page.refCenter(r), where: `ref${r}` };
        }
        if (x != null && y != null) {
          const pt = page.frameToCss(Number(x), Number(y));
          const hit = verify ? (await probePoint(page, pt.x, pt.y)).hit : "";
          return { pt, where: `(${x}, ${y})${hit ? ` → ${hit}` : ""}` };
        }
        if (center) {
          const w = page.measured?.w || page.viewport.width;
          const h = page.measured?.h || page.viewport.height;
          return { pt: { x: Math.floor(w / 2), y: Math.floor(h / 2) }, where: "the viewport centre" };
        }
        return null;
      };
      const from = await at(args.ref, args.x, args.y, action === "pinch");
      if (!from) return fail(`browser ${action}`, `${action} needs ref or x+y.`);
      let to: { pt: { x: number; y: number }; where: string } | null = null;
      if (action === "drag") {
        to = await at(args.to_ref, args.to_x, args.to_y, false);
        if (!to) return fail("browser drag", "drag needs an end point: to_ref or to_x+to_y.");
      }
      const before = verify ? await pageState(page) : null;
      let how: string;
      if (action === "long_press") {
        const ms = Number(args.ms ?? 800);
        await page.longPress(from.pt.x, from.pt.y, ms);
        how = `Long-pressed ${from.where} (${page.emu.mobile ? "touch" : "mouse"} held ${Math.round(ms)} ms)`;
      } else if (action === "drag") {
        const r = await page.drag(from.pt, to!.pt, { holdMs: Number(args.ms ?? 0) });
        how = `Dragged ${from.where} → ${to!.where} (${page.emu.mobile ? "touch swipe" : r.html5 ? "HTML5 drag-and-drop: dragstart → drop" : "mouse held while moving"})`;
      } else {
        const scale = Number(args.scale ?? 2);
        await page.pinch(from.pt.x, from.pt.y, scale);
        how = `Pinched ${scale >= 1 ? "out" : "in"} at ${from.where} (×${scale})`;
      }
      const res = await settleReport(page, before, "click", setChanged);
      const note = await popped();
      return {
        ok: true,
        summary: how.split(" (")[0],
        content: [{ t: "text", text: `${how}.${res}${note}\n(now at ${page.url})` }],
        ...(note ? { events: [browserEvent(page)] } : {}),
      };
    }
    case "type": {
      const text = String(args.text ?? "");
      if (!text) return fail("browser type", "action=type requires `text`.");
      const target: { ref?: number; selector?: string } = {};
      if (args.ref != null && Number.isInteger(Number(args.ref))) target.ref = Number(args.ref);
      else if (args.selector) target.selector = String(args.selector);
      await page.focusTarget(target);
      if (!verify) {
        await page.send("Input.insertText", { text });
        const note = await popped();
        return ok(`typed ${text.length} chars`, `Typed ${text.length} character(s).${note}`);
      }
      const f = await focusInfo(page);
      if (f && !f.editable) {
        return fail("browser type", `Nothing typed: focus is on ${f.desc}, which is not editable — click the input first, or pass ref / selector.`);
      }
      const before = await pageState(page);
      await page.send("Input.insertText", { text });
      const r = await afterAction(page, before, "type", { maxMs: 1200 });
      setChanged(true);
      const f2 = await focusInfo(page);
      let back = "";
      if (f2?.editable) {
        if (f2.password) back = `\nPassword field ${f2.desc} now holds ${f2.value?.length ?? 0} character(s).`;
        else {
          back = `\n${f2.desc} now holds: "${f2.value ?? ""}"`;
          if (!(f2.value || "").includes(text)) back += "\n⚠ The typed text is not in the field — the page may have intercepted, reformatted or truncated it (maxlength).";
        }
      } else if (f2) back = `\n⚠ After typing, focus is on ${f2.desc}.`;
      const extra = r.lines.filter((l) => !/DOM change|⚠ Nothing on the page changed/.test(l));
      const note = await popped();
      return ok(
        `typed ${text.length} chars`,
        `Typed into ${f?.desc ?? "the focused element"}.${back}${extra.length ? `\nAlso: ${extra.join("; ")}` : ""}${note}\nTo submit: Browser(key:"enter") or click the submit button.`,
      );
    }
    case "key": {
      const key = String(args.key ?? "").trim();
      if (!key) return fail("browser key", "action=key requires `key`.");
      const before = verify ? await pageState(page) : null;
      await page.pressKey(key);
      const res = await settleReport(page, before, "key", setChanged);
      const note = await popped();
      return ok(`pressed ${key}`, `Pressed ${key}.${res}${note}\n(now at ${page.url})`);
    }
    case "scroll": {
      const ref = args.ref != null && Number.isInteger(Number(args.ref)) ? Number(args.ref) : null;
      // ref 不带 dy/dx：把元素滚进视口正中
      if (ref != null && args.dy == null && args.dx == null) {
        const c = await page.refCenter(ref);
        return ok(`scrolled ref${ref} into view`, `Scrolled ref${ref} into view (its centre is at CSS ${Math.round(c.x)}, ${Math.round(c.y)}).`);
      }
      const dx = Number.isFinite(Number(args.dx)) ? Number(args.dx) : 0;
      const dy = Number.isFinite(Number(args.dy)) ? Number(args.dy) : args.dx != null ? 0 : 600;
      let pt: { x: number; y: number };
      if (ref != null) pt = await page.refCenter(ref); // 在这个元素上滚（横向轮播、内层滚动区）
      else if (args.x != null && args.y != null) pt = page.frameToCss(Number(args.x), Number(args.y));
      else pt = { x: Math.floor((page.measured?.w || page.viewport.width) / 2), y: Math.floor((page.measured?.h || page.viewport.height) / 2) };
      const what = [dy ? `${dy}px down` : "", dx ? `${dx}px right` : ""].filter(Boolean).join(", ") || "0px";
      const before = verify ? await pageState(page) : null;
      // 真滚轮落在指针下的容器上（window.scrollBy 够不到内层滚动区）
      await page.wheel(pt.x, pt.y, dy, dx);
      const res = await settleReport(page, before, "scroll", setChanged, 1200);
      return ok(`scrolled ${what}`, `Scrolled ${what}.${res}`);
    }
    case "hover": {
      let pt: { x: number; y: number };
      let where: string;
      if (args.ref != null && Number.isInteger(Number(args.ref))) {
        const ref = Number(args.ref);
        if (verify) {
          const p = await probeRef(page, ref, { force: true });
          pt = p;
          where = `ref${ref} ${p.hit}${p.covered ? ` (covered by ${p.covered})` : ""}`;
        } else {
          pt = await page.refCenter(ref);
          where = `ref${ref}`;
        }
      } else if (args.x != null && args.y != null) {
        pt = page.frameToCss(Number(args.x), Number(args.y));
        where = `(${args.x}, ${args.y})`;
        if (verify) where += ` → ${(await probePoint(page, pt.x, pt.y)).hit || "(no element)"}`;
      } else {
        return fail("browser hover", "action=hover needs `ref` or `x`+`y`.");
      }
      const before = verify ? await pageState(page) : null;
      await page.hoverCoord(pt.x, pt.y);
      const res = await settleReport(page, before, "hover", setChanged, 1200);
      return ok(`hovering ${where.split(" →")[0]}`, `Hovering ${where}.${res}`);
    }
    case "set_value": {
      if (args.ref == null && !args.selector) return fail("browser set_value", "set_value needs ref or selector (the target control).");
      if (args.value === undefined) return fail("browser set_value", "set_value needs value.");
      const target = args.ref != null ? { ref: Number(args.ref) } : { selector: String(args.selector) };
      // 多选：value 里用换行分隔；JSON 数组照收
      let value: unknown = args.value;
      if (Array.isArray(value)) value = value.map(String);
      else if (typeof value === "string" && value.includes("\n")) value = value.split("\n").map((s) => s.trim()).filter(Boolean);
      const before = verify ? await pageState(page) : null;
      const r = await page.setValue(target, value);
      if (!r.ok) return fail("browser set_value", `Not set: ${r.why || "unknown reason"}${r.options ? `\nOptions: ${r.options.join(" | ")}` : ""}`);
      if (before) setChanged(true);
      return ok(`set ${r.desc}`, `Set ${r.desc} (${r.kind}) → now "${r.now}". input / change were dispatched.${r.why ? `\n⚠ ${r.why}` : ""}`);
    }
    case "upload": {
      const raw = Array.isArray(args.files) ? args.files : args.files ? [args.files] : [];
      if (!raw.length) return fail("browser upload", "upload needs files (an array of absolute local file paths).");
      const files: string[] = [];
      for (const f of raw) {
        let abs: string;
        try {
          abs = ctx.sandbox.resolve(String(f ?? "").trim()); // 与 Read 同一道闸：越界、凭据一律拒
        } catch (e) {
          return fail("browser upload", `Not allowed: ${(e as Error).message}`);
        }
        let st;
        try {
          st = statSync(abs);
        } catch {
          return fail("browser upload", `No such file: ${abs}`);
        }
        if (!st.isFile()) return fail("browser upload", `Not a file: ${abs}`);
        files.push(abs);
      }
      const target = args.ref != null ? { ref: Number(args.ref) } : args.selector ? { selector: String(args.selector) } : {};
      const r = await page.setInputFiles(files, target);
      if (verify) setChanged(true);
      const note = r.dropped ? " (that input does not take multiple files — only the first one was set)" : "";
      return ok(
        `uploaded ${r.names.length} file(s)`,
        `Put ${r.names.length} file(s) into ${r.target}: ${r.names.join(", ")}${note}\nThe page got input / change events; now submit the form the way the page expects.`,
      );
    }
    case "find": {
      const blocked = fileUrlBlock(page.url, ctx.sandbox);
      if (blocked) return fail("browser find", `The current page is a blocked local file — ${blocked}. Navigate away first.`);
      const q = String(args.text ?? args.query ?? "").trim();
      if (!q) return fail("browser find", "find needs text (the words / role to look for, space-separated).");
      const words = q.toLowerCase().split(/\s+/).filter(Boolean);
      const snap = await page.axSnapshot({ filter: "all", maxChars: 80_000 });
      const scored: { score: number; i: number; line: string }[] = [];
      String(snap.text || "")
        .split("\n")
        .forEach((line, i) => {
          if (!line.trim() || line.startsWith("…")) return;
          const low = line.toLowerCase();
          if (!words.every((w) => low.includes(w))) return;
          let score = 0;
          if (/\[ref\d+\]/.test(line)) score += 2; // 可交互的排前
          if (low.includes(`"${q.toLowerCase()}"`)) score += 3; // 名字整词命中最靠前
          scored.push({ score, i, line: line.trimStart() });
        });
      scored.sort((a, b) => b.score - a.score || a.i - b.i);
      if (!scored.length) return ok(`find "${q}": 0`, `${page.url}: nothing matches "${q}" — try other words, or ReadPage for the whole tree.`);
      const more = scored.length > 20 ? `\n… ${scored.length} matches, showing the first 20 — narrow the words` : "";
      return ok(
        `find "${q}": ${Math.min(20, scored.length)}`,
        `${page.url}\n${WEB_CONTENT_NOTE}\n${redactOutput(scored.slice(0, 20).map((s) => s.line).join("\n"))}${more}\n` +
          "(refs were rebuilt for this snapshot; lines without [refN] are not directly clickable — ReadPage around them for a nearby control)",
      );
    }
    case "page_text": {
      const blocked = fileUrlBlock(page.url, ctx.sandbox);
      if (blocked) return fail("browser page_text", `The current page is a blocked local file — ${blocked}. Navigate away first.`);
      const r = await page.pageText(Number(args.maxChars) || 20_000);
      if (!r.text) return ok("page_text: empty", `${page.url}\n(no readable text — the page may be all images / canvas, or not rendered yet)`);
      const more = r.truncated ? `\n… ${r.total} characters in total, showing the first ${r.text.length} (raise maxChars, or ReadPage(query) to find a specific spot)` : "";
      return ok(
        `page_text ${r.text.length} chars`,
        `${page.url}\ntitle: ${r.title}\nfrom <${r.from}>\n${WEB_CONTENT_NOTE}\n\n${redactOutput(r.text)}${more}`,
      );
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
      const m = await page.measure();
      if (m) page.measured = m;
      const real = m && (m.w !== w || m.h !== h) ? ` — the page measures ${m.w}×${m.h}` : "";
      return ok(
        `viewport ${w}×${h}`,
        `Viewport is now ${w}×${h}${mobile ? " (touch device: touch events, mobile UA, pointer:coarse)" : ""}${schemeNote}${real}. ` +
          `Take a new screenshot before using coordinates; ReadPage or screenshot to check the layout.${launchedNote}`,
      );
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
      return fail("browser", `Unknown action "${action}". Use ${ACTIONS.join(" | ")}.`);
  }
}

function delayMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
