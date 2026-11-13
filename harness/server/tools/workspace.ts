// Workspace：让 agent 看见用户界面上的工作区并与之协同（对标 bridge 里 Claude 的 mcp__workspace__workspace，
// src/mcp/workspace-tools.mjs）。三个动作：
//   view    用户此刻在看什么——前台会话、工作区开着哪个工具、审阅里展开的文件、浏览器地址；嵌在 bridge 里时还有宿主的
//           文件面板与预览（绝对路径、PDF 页码、编辑器模式、有没有未保存的草稿）。数据来自前端的防抖上报（ui-state.ts）。
//   draft   取编辑器里未保存的草稿全文（经会话事件流请求、前端 POST /api/ui/answer 交回）。
//   preview 把工作空间里的一个文件弹到用户眼前（前端：工作区「文件」视图落到它并打开预览）。
// 偏好：workspace.view / workspace.draft（prefs/workspace.ts）。子 agent 不给（agent/subagent.ts 按名单发工具）。
import path from "node:path";
import { stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import type { Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail, ok } from "./types.ts";
import { getUiState, makeUiRequest, type UiReport } from "../ui-state.ts";
import { prefValue } from "../prefs.ts";

const DRAFT_CAP = 100_000;

const TOOL_LABEL: Record<string, string> = {
  tasks: "tasks",
  review: "review (git changes)",
  term: "terminal",
  browser: "browser",
  files: "files",
  memory: "memory",
};

type Obj = Record<string, any>;
const obj = (v: unknown): Obj => (v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {});
const str = (v: unknown): string => (typeof v === "string" ? v : "");

// 宿主预览里的路径 → 绝对路径。宿主（bridge）报的 rel：带 ws 时相对它；dimensio 的产物（origin harness）相对会话工作空间；
// 都不是时相对 bridge 的身份文件根（这边不知道在哪），原样给出。
function previewAbs(p: Obj, sessionWs: string): string {
  const rel = str(p.rel);
  if (!rel) return "";
  if (path.isAbsolute(rel)) return path.resolve(rel);
  const ws = str(p.ws) || (p.origin === "harness" ? sessionWs : "");
  return ws ? path.resolve(ws, rel) : "";
}

function formatReport(r: UiReport, ctx: ToolContext): string {
  const s = obj(r.state);
  const age = Math.max(0, Math.round((Date.now() - r.at) / 1000));
  const sessionWs = str(s.ws) || ctx.sandbox.root;
  const out = [`[${r.client}${r.fresh ? "" : ", probably gone"}] reported ${age}s ago`];
  if (s.chatId) out.push(s.chatId === ctx.ownerId ? "Viewing: this conversation" : `Viewing: another conversation (${str(s.chatId)})`);
  else if (s.chatId === "") out.push("Viewing: a new, empty conversation");
  if (s.ws) out.push(`Workspace: ${str(s.ws)}`);
  const host = obj(s.host);
  if (host.page && host.page !== "harness") out.push(`App page: ${str(host.page)} (not the dimensio page)`);
  const dock = obj(s.dock);
  if ("open" in dock) out.push(`Side panel: ${dock.open ? `open, tool = ${TOOL_LABEL[str(dock.tool)] ?? str(dock.tool)}` : "closed"}`);
  const review = obj(s.review);
  if (review.file) out.push(`Review: diff of ${str(review.file)} expanded`);
  const browser = obj(s.browser);
  if (browser.url) out.push(`Browser panel: ${str(browser.url)}`);
  const files = obj(host.files);
  if ("path" in files) {
    const base = str(files.ws);
    const abs = base ? path.resolve(base, str(files.path)) : "";
    out.push(`File panel folder: ${str(files.path) || "(root)"}${abs ? ` (${abs})` : ""}${files.query ? ` searching "${str(files.query)}"` : ""}`);
  }
  const pv = obj(host.preview);
  if (pv.open) {
    const abs = previewAbs(pv, sessionWs);
    out.push(`Previewing: ${str(pv.name) || str(pv.rel) || "?"} (${str(pv.kind) || "?"})${abs ? `\n  absolute path: ${abs}` : pv.rel ? `\n  relative to the bridge file root: ${str(pv.rel)}` : ""}`);
    if (Number(pv.count) > 1) out.push(`  gallery item ${Number(pv.index) + 1}/${Number(pv.count)}`);
    const d = obj(pv.detail);
    if (d.page) out.push(`  PDF page ${d.page}${d.pages ? `/${d.pages}` : ""}`);
    if (d.mode) out.push(`  editor mode: ${str(d.mode)}${d.dirty ? " — UNSAVED edits: the file on disk is stale, call draft() before touching it" : ""}`);
  } else if ("open" in pv) out.push("No file preview open");
  return out.join("\n");
}

// draft 点名的那一端：最新鲜的、开着编辑器的那一份（多台设备时别让没开编辑器的先答「没有」）
function editorClient(reports: UiReport[]): string | undefined {
  return reports.find((r) => r.fresh && obj(obj(obj(r.state).host).preview).open && obj(obj(obj(obj(r.state).host).preview).detail).mode)?.clientId;
}

async function view(ctx: ToolContext): Promise<ToolRunResult> {
  if (!prefValue<boolean>("workspace.view")) {
    return ok("view off", "The user turned off sharing what they are looking at (settings › dimensio › workspace). Ask them which file they mean.");
  }
  const reports = getUiState();
  if (!reports.length) {
    return { ...ok("no report", "No view report from the user's app yet (it may be closed, or too old to report)."), outcome: "用户端没有上报" };
  }
  const body = reports.map((r) => formatReport(r, ctx)).join("\n\n");
  const pv = obj(obj(obj(reports[0]!.state).host).preview);
  return {
    ...ok("viewed", `${body}\n\n(Several devices: trust the freshest, listed first.)`),
    outcome: pv.open && pv.name ? `用户正看着 ${str(pv.name)}` : `看了用户的界面（${reports.length} 台设备）`,
  };
}

async function draft(ctx: ToolContext): Promise<ToolRunResult> {
  if (!prefValue<boolean>("workspace.draft")) {
    return fail("draft off", "The user does not allow reading unsaved drafts (settings › dimensio › workspace). Work from the file on disk, or ask them to save first.");
  }
  if (!ctx.emit) return fail("no channel", "No user app is attached to this run, so there is no editor to read from.");
  let r: Obj;
  try {
    r = await makeUiRequest((ev) => ctx.emit!(ev as never), "draft", { client: editorClient(getUiState()), timeoutMs: 15_000 });
  } catch (e) {
    return fail("no answer", (e as Error).message);
  }
  if (r.error != null || typeof r.text !== "string") return fail("no draft", `The user's app has no open editor${r.error ? ` (${str(r.error)})` : ""}.`);
  const abs = previewAbs(r, ctx.sandbox.root);
  const text = r.text as string;
  const cut = text.length > DRAFT_CAP;
  return {
    ...ok("draft", `Editor content of ${abs || str(r.rel) || "?"} (${r.dirty ? "UNSAVED" : "same as on disk"}${r.mode ? `, mode ${str(r.mode)}` : ""}):\n\n${cut ? text.slice(0, DRAFT_CAP) + `\n…(cut at ${DRAFT_CAP} of ${text.length} characters)` : text}`),
    outcome: r.dirty ? `拿到未保存的草稿（${text.length} 字）` : "编辑器内容与磁盘一致",
  };
}

async function preview(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolRunResult> {
  const raw = str(args.path).trim();
  if (!raw) return fail("no path", "preview needs path (relative to the workspace).");
  let abs: string;
  try {
    abs = ctx.sandbox.resolve(raw);
  } catch (e) {
    return fail("blocked", (e as Error).message);
  }
  const rel = path.relative(ctx.sandbox.root, abs);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return fail("outside", "preview only shows files inside the workspace.");
  const info = await stat(abs).catch(() => null);
  if (!info?.isFile()) return fail("not found", `Not a file: ${raw}`);
  const relPosix = rel.split(path.sep).join("/");
  return {
    ...ok("shown", `Opened ${relPosix} in the user's view (if their app is open).`),
    outcome: `已弹到用户眼前：${relPosix}`,
    events: [{ e: "workspace", op: "preview", id: randomUUID(), at: Date.now(), path: relPosix, ws: ctx.sandbox.root }],
  };
}

export const workspaceTool: Tool = {
  effect: "read",
  concurrencySafe: false,
  def: {
    name: "Workspace",
    description:
      "See the user's screen in this app: view() = what they have open right now (side panel tool, file preview with " +
      "absolute path, PDF page, editor mode, unsaved edits). Start here when they say \"this file\" / \"what I'm looking at\". " +
      "draft() = full text of their UNSAVED editor (view shows dirty) — fetch it before editing that file so you don't overwrite it. " +
      "preview(path) = pop a workspace file open in front of them to show finished work. Edit files with your normal tools.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["view", "draft", "preview"] },
        path: { type: "string", description: "preview: file path relative to the workspace." },
      },
      required: ["action"],
    },
  },
  async run(args, ctx) {
    const action = str(args.action);
    if (action === "view") return view(ctx);
    if (action === "draft") return draft(ctx);
    if (action === "preview") return preview(args, ctx);
    return fail("bad action", `Unknown action: ${action}. Use view, draft or preview.`);
  },
};
