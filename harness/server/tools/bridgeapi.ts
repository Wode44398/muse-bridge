// bridge 本身：dimensio 的 BridgeManual / BridgeCall，对标 bridge 里 Claude 的 mcp__bridge__manual / mcp__bridge__call
// （src/mcp/bridge-tools.mjs）——查 bridge 的项目手册、替用户操作 bridge（定时任务、会话、界面、文件、插件、bug 上报……）。
// 走 bridge 给 agent 的 HTTP 接口（src/agent-api/http.mjs），与外部 agent 调的是同一张操作表：
//   GET  {BRIDGE_DEVICE_API}/agent/manual[/<章>][?q=]   项目手册（markdown）
//   GET  {BRIDGE_DEVICE_API}/agent/v1                    操作目录（含 access、对这个身份可不可用）
//   POST {BRIDGE_DEVICE_API}/agent/v1/<op>               执行 → { ok, data } | { ok:false, error:{ code, message, hint? } }
// 凭据与设备工具同一把（tools/localpc.ts channel）：管理员实例 = 主机密钥 → 管理员；成员实例 = bridge 按人铸的令牌 → 他本人
// （src/agent-api/instance-auth.mjs）。bridge 只认本机直连，设备组不给（那是 Device* 工具的事）；媒体组（media.*）由 bridge 的
// 设置 › Agent › Gemini 决定给不给 dimensio——没开时目录里标不可用，这里照目录走。
// 独立跑的 dimensio 没有这两个变量，工具不出现。
//
// 审批：read 操作免审；会改东西的（write）跟权限档走（只读 / 计划档拦下）；danger（删除、花钱、不可撤回）每次弹审批卡。
import type { PermissionView, PreparedCall, Tool, ToolContext, ToolRunResult } from "./types.ts";
import { fail, ok } from "./types.ts";
import { channel } from "./localpc.ts";

type OpInfo = { name: string; group?: string; title?: string; access?: string; slow?: boolean; available?: boolean; unavailableReason?: string };

const MAX_TEXT = 60_000;
const CATALOG_TTL_MS = 5 * 60_000;
const EXCLUDED = /^devices\./;

export const bridgeToolAvailable = (): boolean => channel() !== null;

const clip = (s: string, max = MAX_TEXT) => (s.length <= max ? s : `${s.slice(0, max)}\n…(truncated — ${s.length} characters in all; ask for less)`);

class BridgeError extends Error {}

async function request(
  pathname: string,
  opts: { body?: unknown; timeoutMs: number; signal?: AbortSignal; markdown?: boolean },
): Promise<{ status: number; text: string }> {
  const ch = channel();
  if (!ch) throw new BridgeError("Not connected to bridge (BRIDGE_DEVICE_API / BRIDGE_DEVICE_SECRET): this dimensio was not started by bridge.");
  const timeout = AbortSignal.timeout(opts.timeoutMs);
  const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
  let res: Response;
  try {
    res = await fetch(ch.api + pathname, {
      method: opts.body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${ch.secret}`,
        "X-Bridge-Agent": "dimensio", // 只用来标来源（日志、bug 上报），权限只看凭据
        Accept: opts.markdown ? "text/markdown" : "application/json",
        ...(opts.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      redirect: "error", // 凭据只发给这一个地址
      signal,
    });
    return { status: res.status, text: await res.text() };
  } catch (e) {
    if (opts.signal?.aborted) throw new BridgeError("Stopped by the user before bridge answered.");
    const name = (e as { name?: string } | null)?.name;
    if (name === "TimeoutError" || name === "AbortError") throw new BridgeError(`bridge did not answer within ${Math.round(opts.timeoutMs / 1000)}s.`);
    const err = e as { message?: string; cause?: { code?: string } } | null;
    throw new BridgeError(`Cannot reach bridge at ${ch.api} (${err?.cause?.code || err?.message || String(e)}) — it may be restarting; retry shortly.`);
  }
}

const REJECTED = "bridge rejected this instance's credential (the account was disabled or deleted, dimensio was withdrawn from it, or bridge rotated its host secret — a dimensio restarted from bridge picks up a new one).";

function parse(r: { status: number; text: string }): Record<string, unknown> {
  let j: Record<string, unknown> | null = null;
  try {
    j = JSON.parse(r.text) as Record<string, unknown>; // 慢操作先写空白保活，JSON.parse 认前导空白
  } catch {
    /* 下面按状态码说 */
  }
  if (r.status === 401) throw new BridgeError(REJECTED);
  if (!j || typeof j !== "object") throw new BridgeError(`bridge answered HTTP ${r.status} without JSON (too old to have the agent API?)`);
  return j;
}

function errText(j: Record<string, unknown>): string {
  const e = (j.error ?? {}) as { code?: string; message?: string; hint?: string; data?: unknown };
  return `${e.code ?? "failed"}: ${e.message ?? "bridge gave no reason"}${e.hint ? ` (${e.hint})` : ""}${e.data !== undefined ? `\n${clip(JSON.stringify(e.data), 4_000)}` : ""}`;
}

// ── 操作目录缓存：权限判定（同步）要知道这个操作的 access；prepare 在判定之前把它取好 ──────────────
let cache: { at: number; key: string; ops: Map<string, OpInfo> } | null = null;

export function resetBridgeCatalog(): void {
  cache = null;
}

const cacheKey = () => {
  const ch = channel();
  return ch ? `${ch.api}\n${ch.secret}` : "";
};

async function catalog(signal?: AbortSignal, fresh = false): Promise<Map<string, OpInfo>> {
  const key = cacheKey();
  if (!fresh && cache && cache.key === key && Date.now() - cache.at < CATALOG_TTL_MS) return cache.ops;
  const j = parse(await request("/agent/v1", { timeoutMs: 15_000, ...(signal ? { signal } : {}) }));
  if (j.ok !== true || !Array.isArray(j.ops)) throw new BridgeError(errText(j));
  const ops = new Map<string, OpInfo>((j.ops as OpInfo[]).map((o) => [o.name, o]));
  cache = { at: Date.now(), key, ops };
  return ops;
}

const cachedOp = (name: string): OpInfo | undefined => (cache && cache.key === cacheKey() ? cache.ops.get(name) : undefined);

async function lookup(name: string, signal?: AbortSignal): Promise<OpInfo | undefined> {
  return (await catalog(signal)).get(name) ?? (await catalog(signal, true)).get(name);
}

const opName = (args: Record<string, unknown>) => String(args.op ?? "").trim();
const opArgs = (args: Record<string, unknown>): Record<string, unknown> =>
  args.args && typeof args.args === "object" && !Array.isArray(args.args) ? (args.args as Record<string, unknown>) : {};

const EXCLUDED_TEXT = (op: string) =>
  `${op} is not available here: operate the user's computer with the Device* tools.`;
const UNKNOWN_TEXT = (op: string) => `bridge has no operation "${op}". Call BridgeCall without op to list the operations, or BridgeManual(q:"${op}").`;
const accessTag = (a?: string) => (a === "danger" ? "danger, needs approval" : a === "write" ? "changes things" : "read");

// ── BridgeManual ─────────────────────────────────────────────────────────────
export const bridgeManualTool: Tool = {
  effect: "read",
  concurrencySafe: true,
  enabled: bridgeToolAvailable,
  def: {
    name: "BridgeManual",
    description:
      "The manual of bridge — the app the user is using, which hosts you: where things are in its UI, how features work, whether a feature exists, and the parameters of every BridgeCall operation. " +
      "No arguments = table of contents; topic = a whole chapter (e.g. claude, dimensio, workspace, settings, routines, api); q = keyword search returning the most relevant sections. " +
      "When the user asks how / where / whether bridge does something, look here first; a feature the manual does not describe does not exist — never invent one.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", description: "Chapter id." },
        q: { type: "string", description: "Keywords, space separated." },
      },
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const topic = String(args.topic ?? "").trim();
    const q = String(args.q ?? "").trim();
    const pathname = topic ? `/agent/manual/${encodeURIComponent(topic)}` : `/agent/manual${q ? `?q=${encodeURIComponent(q)}` : ""}`;
    const label = topic ? `bridge manual: ${topic}` : q ? `bridge manual: ${q}` : "bridge manual";
    try {
      const r = await request(pathname, { timeoutMs: 20_000, markdown: true, ...(ctx.signal ? { signal: ctx.signal } : {}) });
      if (r.status === 401) return fail(label, REJECTED);
      if (r.status === 404) return fail(label, `${r.text.trim().slice(0, 2_000)}\n(Call BridgeManual with no arguments for the chapter list.)`);
      if (r.status !== 200) return fail(label, `bridge answered HTTP ${r.status}: ${r.text.slice(0, 300)}`);
      return { ok: true, summary: label, outcome: `${r.text.length} 字`, content: [{ t: "text", text: clip(r.text) }] };
    } catch (e) {
      return fail(label, (e as Error).message);
    }
  },
};

// ── BridgeCall ───────────────────────────────────────────────────────────────
async function listOps(ctx: ToolContext): Promise<ToolRunResult> {
  const ops = [...(await catalog(ctx.signal, true)).values()];
  const usable = ops.filter((o) => o.available !== false && !EXCLUDED.test(o.name));
  const rows = usable.map((o) => `- ${o.name} — ${o.title ?? ""} [${accessTag(o.access)}]`);
  const off = ops.length - usable.length;
  return ok(
    `bridge: ${usable.length} operations`,
    `Operations you can call (${usable.length}${off ? `; ${off} more are not available to this user or not offered here` : ""}). Parameters: BridgeManual(topic:"api") or BridgeManual(q:"<op name>").\n${rows.join("\n")}`,
  );
}

function argsPreview(op: string, info: OpInfo | undefined, args: Record<string, unknown>) {
  const json = JSON.stringify(args, null, 2) ?? "{}";
  return { kind: "text" as const, text: `bridge · ${op}${info?.title ? `（${info.title}）` : ""}\n${json.slice(0, 4_000)}`, ...(json.length > 4_000 ? { truncated: true } : {}) };
}

export const bridgeCallTool: Tool = {
  effect: "write",
  concurrencySafe: false,
  enabled: bridgeToolAvailable,
  // 按这次调的操作定：read 免审；write 跟权限档；danger 由 prepare 要求确认。目录没取到时按 write 算（保守）。
  permissionView: (args): PermissionView | null => {
    const op = opName(args);
    if (!op) return { effect: "read" };
    return cachedOp(op)?.access === "read" ? { effect: "read" } : null;
  },
  prepare: async (args, ctx): Promise<PreparedCall | null> => {
    const op = opName(args);
    if (!op) return null;
    if (EXCLUDED.test(op)) return { veto: { summary: `bridge ${op} not offered`, content: EXCLUDED_TEXT(op) } };
    let info: OpInfo | undefined;
    try {
      info = await lookup(op, ctx.signal);
    } catch {
      return null; // 连不上：run 照实回错
    }
    if (!info) return { veto: { summary: `bridge: no ${op}`, content: UNKNOWN_TEXT(op) } };
    if (info.available === false) {
      return { veto: { summary: `bridge ${op} unavailable`, content: `${op} is not available to this user: ${info.unavailableReason ?? "no reason given"}` } };
    }
    if (info.access !== "danger") return null;
    return {
      confirm: {
        reason: `bridge operation ${op} deletes, spends or cannot be undone`,
        why: `要替你执行 bridge 操作「${info.title ?? op}」（${op}）：删除、花钱或不可撤回`,
      },
      preview: argsPreview(op, info, opArgs(args)),
    };
  },
  def: {
    name: "BridgeCall",
    description:
      "Operate bridge itself for the user — the same operations an external agent calls over bridge's HTTP API: scheduled tasks (routines.*), Claude sessions (sessions.* / chat.*: list, search, read, send, wait, stop, answer), " +
      "the user's UI (ui.view / ui.open / ui.notify), files in their bridge workspace, plugins, agent keys, usage, and bug feedback (feedback.status / diagnose / report). " +
      "Omit op to list the operations available to this user; parameters: BridgeManual(topic:\"api\") or BridgeManual(q:\"<op name>\"). " +
      "Read operations run freely; ones that change things follow the permission mode; danger ones (delete, spend, irreversible) wait for the user's approval card. The user's computer is the Device* tools, not this.",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", description: "Operation name, e.g. routines.list. Omit to list operations." },
        args: { type: "object", description: "The operation's parameters." },
      },
      additionalProperties: false,
    },
  },
  async run(args, ctx) {
    const op = opName(args);
    try {
      if (!op) return await listOps(ctx);
      if (EXCLUDED.test(op)) return fail(`bridge ${op} not offered`, EXCLUDED_TEXT(op));
      const slow = cachedOp(op)?.slow === true;
      const r = await request(`/agent/v1/${encodeURIComponent(op)}`, {
        body: opArgs(args),
        timeoutMs: slow ? 15 * 60_000 : 2 * 60_000,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
      const j = parse(r);
      if (j.ok !== true) return fail(`bridge ${op} failed`, errText(j));
      const text = JSON.stringify(j.data ?? {}, null, 1);
      // 会话原文、文件内容、日志都可能夹着别人写的东西：按外部内容算（Remember 先存成待确认）
      return { ok: true, summary: `bridge ${op}`, outcome: `返回 ${text.length} 字`, content: [{ t: "text", text: clip(text) }], externalContent: true };
    } catch (e) {
      return fail(op ? `bridge ${op} failed` : "bridge operations", (e as Error).message);
    }
  },
};

