// Browser / ReadPage / Eval / Network 的共享模式：动作转给 bridge 的浏览器实例池（bridge-runtime.ts → POST /api/internal/agent-browser），
// 与 bridge 工作台的浏览器面板同一个实例——面板按 ws=<会话工作区>&session=d_<会话 id> 打开的就是它。
//
// 本地先做、不交给 bridge 的：各工具的参数说明与权限、控制面与 file:// 拦截（导航前；读页面内容的动作还按上次带回的地址先验一遍、
// 带回来后再验一遍——bridge 那边只按工作空间圈 file://，凭据文件这类 Read 不给读的只有本地认得）、"/path" 解析到本会话的 Preview、
// upload 的沙箱路径解析、截图交回模型的方式（feedback 图片 / 视觉模型）、完成证据（verification 由 bridge 带回的结构化值在本地生成）。
// 浏览器按会话分（ctx.ownerId；子 agent / 工作流沿用父会话的），工作空间取沙箱根。
// 生命周期：第一次用就在资源账本里登记（resources.ts），会话删除 / 巡检回收时让 bridge 关掉这一份并忘掉隔离开关；本地 cdp/* 池不为它启动。
import { statSync } from "node:fs";
import type { AgentEvent } from "../../agent/events.ts";
import type { ToolContext, ToolRunResult } from "../types.ts";
import { fail, lenientVerify, ok, verifyIgnored } from "../types.ts";
import { bridgePost, mcpText } from "../../bridge-runtime.ts";
import { controlPlanePorts, controlPlaneUrlBlock } from "../../control-plane.ts";
import { fileUrlBlock } from "../../sandbox.ts";
import { registerResource } from "../../resources.ts";
import { redactOutput } from "../../redact.ts";
import { WEB_CONTENT_NOTE } from "../untrusted.ts";
import { resolveUrl } from "../browser.ts";
import { shotResult } from "./shot-report.ts";

const PATH = "/api/internal/agent-browser";

// 原样带过去的参数（bridge 动作层同名同义）
const PASS = [
  "url", "tab", "ref", "text", "selector", "value", "x", "y", "to_x", "to_y", "to_ref", "scale", "ms", "button", "double",
  "modifiers", "force", "key", "dy", "dx", "preset", "width", "height", "dpr", "lines", "query", "errors_only", "maxChars",
  "expect", "expect_timeout_ms", "verify", "screenshot_after", "filter", "depth", "id",
] as const;
// 把页面内容交给模型的动作：当前页是 Read 不给读的本地文件就不读
const READS = new Set(["read_page", "screenshot", "find", "page_text", "eval", "network", "console"]);

type BridgeAct = {
  content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
  isError?: boolean;
  url?: string;
  activity?: boolean;
  data?: Record<string, any> | null;
};

// ── 每个会话的一点本地状态：上次带回的地址（读之前先验）、账本登记 ─────────────────────────
const lastUrl = new Map<string, string>();
const booked = new Map<string, () => void>();

function book(owner: string, ws: string): void {
  if (!owner || booked.has(owner)) return;
  booked.set(
    owner,
    registerResource(owner, "browser", "bridge-browser", (reason) => {
      booked.delete(owner);
      lastUrl.delete(owner);
      // 只有删除 / 巡检收浏览器（resources.ts）；会话没了，隔离开关一起忘掉。发出去不等：bridge 正重启也不拖住删除
      void bridgePost(PATH, { ws, session: owner, op: "close", forget: reason === "delete" || reason === "orphan" }, { timeoutMs: 15_000 }).catch(() => {});
      return true;
    }),
  );
}

/** 会话的浏览器在 bridge 那边的一个子操作（state / isolate / close）。路由层用（routes/browser.ts）。 */
export async function sharedBrowserOp(owner: string, ws: string, op: "state" | "isolate" | "close", extra: Record<string, unknown> = {}): Promise<Record<string, any>> {
  return bridgePost(PATH, { ws, session: owner, op, ...extra }, { timeoutMs: 20_000 });
}

async function act(args: Record<string, unknown>, ctx: ToolContext, timeoutMs = 120_000): Promise<BridgeAct> {
  const owner = ctx.ownerId ?? "";
  const ws = ctx.sandbox.root;
  book(owner, ws);
  const j = (await bridgePost(
    PATH,
    { ws, session: owner, op: "act", args, denyPorts: [...controlPlanePorts()] },
    { timeoutMs, ...(ctx.signal ? { signal: ctx.signal } : {}) },
  )) as BridgeAct;
  if (typeof j.url === "string") lastUrl.set(owner, j.url);
  return j;
}

// 读页面内容之前：上次带回的地址是 Read 不给读的本地文件就不读（页面是自己跳过去的，导航检查拦不到）
function readBlocked(ctx: ToolContext): string | null {
  const u = lastUrl.get(ctx.ownerId ?? "");
  return u ? fileUrlBlock(u, ctx.sandbox) : null;
}
// 带回来之后：结果对应的那一页过不了闸，就把内容扣下、把页面退回空白页
async function landedBlocked(j: BridgeAct, ctx: ToolContext): Promise<string | null> {
  const why = j.url ? fileUrlBlock(j.url, ctx.sandbox) : null;
  if (!why) return null;
  await act({ action: "navigate", url: "about:blank" }, ctx, 30_000).catch(() => {});
  return why;
}
const blockedFail = (label: string, why: string) => fail(label, `The current page is a blocked local file — ${why}. Navigate away first.`);

function images(j: BridgeAct): Buffer[] {
  return (j.content ?? []).filter((c) => c.type === "image" && typeof c.data === "string").map((c) => Buffer.from(String(c.data), "base64"));
}

const errText = (e: unknown) => `The shared browser (in bridge) failed: ${(e as Error).message}`;

// ── Browser 的一步 ─────────────────────────────────────────────────────────────
export async function sharedBrowserStep(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
  const action = String(args.action ?? "").trim();
  const label = `browser ${action}`;
  if (action === "attach") {
    return fail(label, "Browser(attach) is not available here: this dimensio runs inside bridge, and Browser drives bridge's shared browser (the one in the workspace Browser panel). Use navigate with the built-in browser instead.");
  }
  if (action === "edge") {
    return fail(label, "Browser(edge) is gone. The user's own logged-in Edge / Chrome is driven with DeviceBrowser — DeviceBrowser(action:\"browsers\") lists the browsers connected through Web Bridge on their computer, then pass browser:<id|name> on every call.");
  }
  const out: Record<string, unknown> = { action };
  for (const k of PASS) if (args[k] !== undefined) out[k] = args[k];

  if (action === "navigate" || action === "tab_new") {
    const raw = String(args.url ?? "").trim();
    if (raw) {
      let target: string;
      try {
        target = resolveUrl(raw, ctx.ownerId ?? "");
      } catch (e) {
        return fail(label, (e as Error).message);
      }
      const blocked = controlPlaneUrlBlock(target) ?? fileUrlBlock(target, ctx.sandbox);
      if (blocked) return fail(label, blocked);
      out.url = target;
    } else if (action === "navigate") return fail(label, "action=navigate requires `url`.");
  }
  if (action === "resize" && args.colorScheme != null) out.scheme = args.colorScheme;
  if (action === "set_value" && typeof args.value === "string" && args.value.includes("\n")) {
    out.value = args.value.split("\n").map((s) => s.trim()).filter(Boolean);
  }
  if (action === "console" && args.lines == null) out.lines = 100;
  if (action === "dprprobe") {
    const dpr = args.dpr != null ? Number(args.dpr) : 2;
    if (!(dpr > 1 && dpr <= 4)) return fail("browser dprprobe", "dpr must be > 1 and ≤ 4 — the point is a ratio real displays use (1.25–3). DPR 1 proves nothing.");
    out.dpr = dpr;
  }
  if (action === "upload") {
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
      try {
        if (!statSync(abs).isFile()) return fail("browser upload", `Not a file: ${abs}`);
      } catch {
        return fail("browser upload", `No such file: ${abs}`);
      }
      files.push(abs);
    }
    out.files = files;
  }
  const question = action === "screenshot" ? String(args.question ?? "").trim() : "";
  if (action === "screenshot") {
    delete out.ref;
    delete out.selector;
    if (args.ref != null && Number.isInteger(Number(args.ref))) out.element_ref = Number(args.ref);
    else if (typeof args.selector === "string" && args.selector.trim()) out.element_selector = args.selector.trim();
    if (args.clip != null) {
      if (out.element_ref != null || out.element_selector) return fail(label, "Pass either an element (selector or ref) or a clip rectangle, not both.");
      let c = args.clip as Record<string, unknown> | string;
      if (typeof c === "string") {
        try {
          c = JSON.parse(c) as Record<string, unknown>;
        } catch {
          return fail(label, "clip must be an object like {x:0, y:0, width:400, height:300}.");
        }
      }
      // 都按最近那张整屏截图的像素：bridge 的 region 同一个坐标系
      out.region = [Number(c?.x), Number(c?.y), Number(c?.width), Number(c?.height)];
    }
    const waitMs = args.waitMs != null && Number.isFinite(Number(args.waitMs)) ? Number(args.waitMs) : null;
    if (waitMs != null) out.wait_ms = waitMs;
    out.settle = waitMs !== 0;
  }
  if (READS.has(action) || args.screenshot_after === true) {
    const why = readBlocked(ctx);
    if (why) return blockedFail(label, why);
  }

  let j: BridgeAct;
  try {
    j = await act(out, ctx, action === "dprprobe" ? 180_000 : 120_000);
  } catch (e) {
    return fail(label, errText(e));
  }
  const url = j.url || "";
  if (READS.has(action) || args.screenshot_after === true) {
    const why = await landedBlocked(j, ctx);
    if (why) return blockedFail(label, why);
  }
  let text = mcpText(j.content);
  if (action === "find" || action === "page_text") text = `${WEB_CONTENT_NOTE}\n${redactOutput(text)}`;
  const events: AgentEvent[] = j.activity ? [{ e: "browser", url }] : [];
  const pngs = images(j);

  let res: ToolRunResult;
  if (action === "screenshot" && pngs.length && !j.isError) {
    const scope = out.element_ref != null ? ` (ref${out.element_ref})` : out.element_selector ? ` (element ${JSON.stringify(out.element_selector)})` : out.region ? " (region)" : "";
    const settle = j.data?.settle as { waitedMs?: number; stillRunning?: number } | null | undefined;
    const waited = !settle ? " Captured immediately (waitMs:0) — animations may be mid-way."
      : settle.stillRunning ? ` ${settle.stillRunning} animation(s) were still running — this may be a mid-animation frame; pass waitMs to wait longer.`
      : (settle.waitedMs ?? 0) >= 200 ? ` Waited ${settle.waitedMs} ms for animations/fonts to finish first.` : "";
    res = await shotResult(pngs[pngs.length - 1]!, url, ` — ${text.replace(/\s+/g, " ").trim()}${waited}`, scope, question, ctx);
  } else {
    res = j.isError ? fail(label, text || `${action} failed`) : ok(label, text || "done");
    // screenshot_after 带回的图：多模态模型自己看，界面那边照样出截图
    if (pngs.length) {
      const shot = await shotResult(pngs[pngs.length - 1]!, url, "", "", "", ctx);
      if (shot.feedback) res.feedback = shot.feedback;
      if (shot.events) events.push(...shot.events);
    }
  }
  if (events.length) res.events = [...(res.events ?? []), ...events];
  const probe = j.data?.dprprobe as { dpr: number; passed: boolean; problems: string[]; canvasCount: number } | undefined;
  if (action === "dprprobe" && probe) {
    res.verification = probe.passed
      ? { passed: true, detail: `canvas DPR probe @${probe.dpr} on ${url} (${probe.canvasCount} canvases)` }
      : { passed: false, detail: `canvas DPR probe @${probe.dpr} FAILED: ${probe.problems[0] ?? "unknown problem"}` };
  }
  return res;
}

// ── ReadPage ───────────────────────────────────────────────────────────────────
export async function sharedReadPage(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
  const why = readBlocked(ctx);
  if (why) return blockedFail("readpage", why);
  const out: Record<string, unknown> = { action: "read_page", filter: args.filter === "interactive" ? "interactive" : "all" };
  if (typeof args.query === "string" && args.query.trim()) out.query = args.query.trim();
  if (Number.isFinite(Number(args.maxChars))) out.maxChars = Number(args.maxChars);
  if (args.ref != null && Number.isInteger(Number(args.ref))) out.ref = Number(args.ref);
  if (Number.isFinite(Number(args.depth))) out.depth = Number(args.depth);
  let j: BridgeAct;
  try {
    j = await act(out, ctx);
  } catch (e) {
    return fail("readpage", errText(e));
  }
  const blocked = await landedBlocked(j, ctx);
  if (blocked) return blockedFail("readpage", blocked);
  const text = mcpText(j.content);
  if (j.isError) return fail("readpage", text);
  const refs = (text.match(/\[ref\d+\]/g) ?? []).length;
  return ok(
    `read page, ${refs} refs`,
    `${WEB_CONTENT_NOTE}\n\n${redactOutput(text)}\n\nUse Browser(action:"click"|"type"|"hover", ref:<N>) to act on a [refN] element.`,
  );
}

// ── Eval ───────────────────────────────────────────────────────────────────────
const MAX_EVAL = 8_000;
export async function sharedEval(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
  const js = String(args.js ?? "").trim();
  if (!js) return fail("eval", "Eval requires `js`.");
  const why = readBlocked(ctx);
  if (why) return blockedFail("eval", why);
  let j: BridgeAct;
  try {
    j = await act({ action: "eval", js }, ctx);
  } catch (e) {
    return fail("eval", errText(e));
  }
  const blocked = await landedBlocked(j, ctx);
  if (blocked) return blockedFail("eval", blocked);
  const url = j.url || "";
  const rendered = redactOutput(mcpText(j.content));
  const ev = (j.data?.eval ?? null) as { threw?: boolean; exception?: string; type?: string; value?: boolean } | null;
  if (j.isError) {
    const res = fail("eval error", `Eval failed: ${rendered}`);
    // verify:true 时脚本自己 throw 的（断言带细节）如实记为一次失败的检查；语法错误属于写法问题、超时与浏览器故障不是页面的结论
    if (args.verify === true && ev?.threw && ev.exception && ev.exception !== "SyntaxError") {
      res.verification = { passed: false, detail: `Eval assertion threw at ${url}: ${rendered.slice(0, 240)}` };
    }
    return res;
  }
  const isBool = ev?.type === "boolean";
  const ignored = args.verify === true && !isBool && lenientVerify(ctx) ? "the expression did not evaluate to a boolean" : "";
  if (args.verify === true && ev?.value !== true && !ignored) {
    const shown = rendered.length > MAX_EVAL ? rendered.slice(0, MAX_EVAL) + "\n… (truncated)" : rendered;
    if (!isBool) {
      return fail(
        "eval assertion malformed",
        `verify:true needs the expression to evaluate to a boolean (true = pass, false = fail), but it returned:\n${shown}\n` +
          "This call is NOT recorded as verification evidence. Return a boolean; to report why a check fails, throw an Error with the details.",
      );
    }
    return {
      ...fail("eval assertion failed", `Verification assertion at ${url} did not return boolean true. Received:\n${shown}`),
      verification: { passed: false, detail: `Eval assertion failed at ${url}: ${shown.slice(0, 240)}` },
    };
  }
  const result = ok("eval ok", `Result (at ${url}):\n${rendered}`);
  if (j.activity) result.events = [{ e: "browser", url }];
  if (ignored) return verifyIgnored(result, ignored);
  if (args.verify === true) result.verification = { passed: true, detail: `Eval assertion passed at ${url}` };
  return result;
}

// ── Network ────────────────────────────────────────────────────────────────────
type NetRow = { id: string; url: string; method: string; status: number | null; state: string; error: string };
export async function sharedNetwork(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
  const action = String(args.action ?? "list").trim() || "list";
  if (action !== "list" && action !== "body") return fail("network", `Unknown action "${action}". Use list | body.`);
  const filter = typeof args.filter === "string" ? args.filter.trim() : "";
  if (action === "list" && args.verify === true && (!filter || !Number.isInteger(Number(args.expectedStatus))) && lenientVerify(ctx)) {
    return verifyIgnored(await sharedNetwork({ ...args, verify: false }, ctx), "verification needs both filter and an integer expectedStatus");
  }
  if (action === "list" && args.verify === true && (!filter || !Number.isInteger(Number(args.expectedStatus)))) {
    return {
      ...fail("network assertion invalid", "Network verification requires both `filter` and integer `expectedStatus`."),
      verification: { passed: false, detail: "Network verification was missing filter or expectedStatus" },
    };
  }
  if (action === "body" && !String(args.id ?? "").trim()) return fail("network body", "action=body requires `id` (from a prior list).");
  const why = readBlocked(ctx);
  if (why) return blockedFail("network", why);
  const out: Record<string, unknown> =
    action === "body" ? { action: "network", id: String(args.id).trim() } : { action: "network", lines: Math.max(1, Math.min(200, Number(args.lines ?? 60))), ...(filter ? { query: filter } : {}) };
  let j: BridgeAct;
  try {
    j = await act(out, ctx);
  } catch (e) {
    return fail("network", errText(e));
  }
  const text = mcpText(j.content);
  if (j.isError) return fail(action === "body" ? "network body" : "network", text);
  if (action === "body") return ok(`body ${String(args.id)}`, text);
  const rows = (j.data?.network ?? []) as NetRow[];
  const result = ok(`network: ${rows.length} requests`, `${text}\n\nNetwork(action:"body", id:"…") reads a response body.`);
  if (args.verify === true) {
    const expected = Number(args.expectedStatus);
    const latest = rows[rows.length - 1];
    const passed = Boolean(latest && latest.state !== "failed" && latest.status === expected);
    result.ok = passed;
    result.verification = {
      passed,
      detail: !latest
        ? `No network request matched ${filter}`
        : passed
          ? `Network ${filter} returned HTTP ${expected}`
          : `Network ${filter} expected HTTP ${expected}, got ${latest.state === "failed" ? `FAIL(${latest.error})` : latest.status ?? "pending"}`,
    };
    if (!passed) result.summary = "network assertion failed";
  }
  return result;
}
