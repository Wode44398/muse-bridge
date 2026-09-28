import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic-write.ts";
import { sessionsDir } from "./paths.ts";
import { readVersioned, type RecordMigration } from "./record-version.ts";
import { tagLegacyOrigins } from "./agent/injections.ts";
import type { WorldTokens } from "./agent/world-state.ts";
import type { GoalState } from "./goal.ts";
import type { UsageLedger } from "./usage-ledger.ts";
import type { McpBaseline } from "./tools/mcp.ts";
import type { Msg, ThinkingLevel } from "./agent/turn.ts";
import type { TodoItem } from "./agent/events.ts";
import type { PermissionMode, PermissionRules, SessionAllow } from "./agent/permissions.ts";
import type { ProviderId } from "./providers/types.ts";
import type { SerializedFingerprint } from "./providers/wire-fingerprint.ts";
import type { PrefixTotals } from "./agent/prefix-audit.ts";
import type { SandboxAccess } from "./sandbox.ts";

// Session persistence: one JSON file per session under SESSIONS_DIR (default
// <cwd>/sessions — OUTSIDE the workspace, like the memory dir, so it never
// pollutes the project being built). Written atomically (tmp + rename) so a
// crash mid-write can't tear a session file. What is deliberately NOT
// persisted: readFileState (files may change while the server is down — the
// Edit gate must force fresh Reads after a restore) and per-run budget fields.

export interface PersistedConfig {
  provider: ProviderId;
  model: string;
  baseUrl?: string;
  thinking: ThinkingLevel;
  permissionMode: PermissionMode;
  // 该会话建立时的全局规则快照。P1 起判定一律现读全局规则，这份只留作记录（旧会话恢复时不再用它）。
  permissionRules?: PermissionRules;
  // P1（#47）：「本会话都允许」，每条带着产生时的 {模式, 访问范围, 规则指纹}，随会话落盘。
  sessionAllow?: SessionAllow[];
  // P3（#6）：离开模式（与权限模式正交，默认关）。开着时没人能答的卡不再挂住这一轮。
  away?: boolean;
  // Where this session works + how far its sandbox reaches. Optional for
  // records written before the P batch — those fall back to the current
  // global workspace and classic containment on resume.
  workspace?: string;
  access?: SandboxAccess;
  // P13（X18）：用户在卡片上「本会话把这个目录设为只读」的工作区外目录（绝对路径）。老版本读到会忽略
  readRoots?: string[];
}

// M7（D1）：会话记录的当前版本与迁移链（规矩见 record-version.ts）。提版本 = 这里 +1、在迁移链末尾追加一步、
// 配一条旧版本夹具测试；而且要等本框架已经上了生产之后再提。
export const SESSION_RECORD_VERSION = 1;
const SESSION_MIGRATIONS: Readonly<Record<number, RecordMigration>> = {};

export interface PersistedSession {
  v: typeof SESSION_RECORD_VERSION;
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string;
  config: PersistedConfig;
  // The system prompt the session ran with. Resume preserves its core/GUIDE
  // contract but replaces the final memory-index section with the current one.
  system: string;
  messages: Msg[];
  // C3（#41）：1 = 消息带结构化来源（Msg.origin / kind），没有来源的就是用户本人说的。没有这个标记的是 C3 之前的记录，
  // 读入时按当年的开头规则补标一次。老版本读到这个字段会忽略。
  origins?: 1;
  // C4：system 建成时 World State 各节的令牌（world-state.ts）。恢复时有它就原样沿用 system、只补差量；没有的是 C4 之前
  // 写的记录，照旧刷新一次 system。老版本读到这个字段会忽略。
  world?: WorldTokens;
  // O7：目标续跑的契约与进度（goal.ts）。老版本读到会忽略
  goal?: GoalState;
  // O8：用量账本（usage-ledger.ts）：会话 × 厂商 × 型号 × 任务。老版本读到会忽略
  usage?: UsageLedger;
  // E1：建会话时拍下的 MCP 基线（tools/mcp.ts）；读回按它还原 MCP 工具，工具清单不变。老版本读到会忽略
  mcp?: McpBaseline;
  todos: TodoItem[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    lastContextTokens: number;
    // Q4：新增的可选项（老记录没有；老版本读到会忽略）
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    prefix?: PrefixTotals;
  };
  // Q4：上一次请求的前缀指纹（只有哈希与字符数），恢复会话后接着比。
  prefixBaseline?: SerializedFingerprint;
  gates: {
    dirtySinceVerify: boolean;
    editedFiles: string[];
    ranCommands: string[];
    mutationEpoch?: number;
    verifiedEpoch?: number;
    lastVerification?: string;
    // K9（X55）：本会话读过外部内容（网页 / 浏览器……）。老记录没有这项，恢复时从转录里推。
    externalContent?: boolean;
  };
  counters: { compactionFailures: number; turnsSinceTodoSeen: number };
}

export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  provider: string;
  model: string;
  workspace?: string;
  // M6：会话文件损坏且没有可恢复的检查点副本——列表里留一条，不再静默消失。
  corrupt?: boolean;
  // M7：更新版本的 dimensio 写的会话——只读（不能继续、不能回滚），标题前也注明了。
  readOnly?: { version: number };
}

// M7：更新版本写的会话的只读视图（只取新版本也会保留的那几样，尽力而为）。
export interface ReadOnlySessionView {
  id: string;
  version: number;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: Msg[];
  provider: string;
  model: string;
  workspace?: string;
}

export type ParsedSession =
  | { kind: "ok"; rec: PersistedSession; migratedFrom?: number }
  | { kind: "corrupt" }
  | { kind: "unsupported-version"; version: number; view: ReadOnlySessionView };

// M7（D1）：读会话的判别联合。ok 可能刚迁移过（migratedFrom）或刚从检查点副本恢复（restoredFrom）；corrupt 已隔离；
// unsupported-version 是更新版本写的，只读。
export type LoadResult =
  | { kind: "ok"; rec: PersistedSession; migratedFrom?: number; restoredFrom?: number }
  | { kind: "not-found" }
  | { kind: "corrupt"; quarantined: string }
  | { kind: "unsupported-version"; version: number; view: ReadOnlySessionView }
  // Q14（F6）：文件在，但这会儿读不了（被别的程序占着、权限、是个目录……）——以前一律当「没有这个会话」，客户端以为真没了
  | { kind: "unreadable"; code: string; message: string };

// 读失败：只有「文件不存在」才是没有这个会话；别的都记一条日志（进诊断环，带会话标签）并如实报「读不了」
function readFailure(id: string, e: unknown): LoadResult {
  const err = e as NodeJS.ErrnoException;
  if (err?.code === "ENOENT") return { kind: "not-found" };
  console.error(`[store] session ${id} exists but cannot be read (${err?.code ?? "?"}): ${err?.message ?? String(e)}`);
  return { kind: "unreadable", code: String(err?.code ?? "EIO"), message: String(err?.message ?? e) };
}

export function unsupportedVersionMessage(version: number): string {
  return `这个会话由更新版本的 dimensio 写入（记录版本 v${version}，本版本只认到 v${SESSION_RECORD_VERSION}），这里只能只读查看；要继续它，请换回新版本。`;
}

function readOnlyView(obj: Record<string, unknown>, id: string, version: number): ReadOnlySessionView {
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  const cfg = obj.config && typeof obj.config === "object" ? (obj.config as Record<string, unknown>) : {};
  return {
    id,
    version,
    title: str(obj.title),
    createdAt: num(obj.createdAt),
    updatedAt: num(obj.updatedAt),
    messages: Array.isArray(obj.messages) ? (obj.messages as Msg[]) : [],
    provider: str(cfg.provider),
    model: str(cfg.model),
    workspace: typeof cfg.workspace === "string" ? cfg.workspace : undefined,
  };
}

// 解析一份会话记录（会话文件，或检查点里的记录副本）：版本与迁移交给 record-version.ts，再校验本记录的形状。
export function parseSessionRecord(text: string, id: string): ParsedSession {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "corrupt" };
  }
  if (!raw || typeof raw !== "object" || (raw as { id?: unknown }).id !== id) return { kind: "corrupt" };
  const r = readVersioned(raw, SESSION_RECORD_VERSION, SESSION_MIGRATIONS);
  if (r.kind === "unsupported-version") return { kind: "unsupported-version", version: r.version, view: readOnlyView(r.raw, id, r.version) };
  if (r.kind === "corrupt") return { kind: "corrupt" };
  const rec = r.rec as unknown as PersistedSession;
  if (!Array.isArray(rec.messages) || !rec.config || typeof rec.config !== "object") return { kind: "corrupt" };
  // C3（#41）：C3 之前写的记录没有消息来源——读入时按当年的开头规则一次性补标（之后写回就带着 origins 标记，
  // 不再猜）。刻意不提记录版本（M7：框架先上线再提版本，否则回滚到旧版本会把新记录当坏文件）；老版本读到新字段直接忽略。
  if (rec.origins !== 1) {
    tagLegacyOrigins(rec.messages);
    rec.origins = 1;
  }
  return r.migratedFrom === undefined ? { kind: "ok", rec } : { kind: "ok", rec, migratedFrom: r.migratedFrom };
}

// 本进程读到过「盘上是更新版本」的会话：拒绝整份覆盖写（会抹掉新版本的字段）。
const newerOnDisk = new Map<string, number>();

// Q8：数据位置统一在 paths.ts 解析；这里照旧导出，调用方不用改。
export { sessionsDir };

// Session ids come from the client on resume — gate them hard so a crafted id
// can never traverse outside the sessions dir.
const ID_RE = /^[a-zA-Z0-9-]{1,64}$/;

function fileFor(id: string): string | null {
  if (!ID_RE.test(id)) return null;
  return path.join(sessionsDir(), `${id}.json`);
}

// Q5：会话体检只读地打开文件（不走 loadSessionResult——那条路遇到坏文件会隔离改名）。
export const sessionFilePath = fileFor;

export async function saveSession(rec: PersistedSession): Promise<void> {
  const file = fileFor(rec.id);
  if (!file) throw new Error(`invalid session id: ${rec.id}`);
  const newer = newerOnDisk.get(rec.id);
  if (newer !== undefined) throw new Error(`refusing to overwrite session ${rec.id}: ${unsupportedVersionMessage(newer)}`);
  // Stringify BEFORE any await: the caller hands us live, mutating state and
  // relies on this synchronous capture for a consistent snapshot.
  const json = JSON.stringify(rec);
  // M6（#25）：唯一临时名 + 同路径串行 + fsync（见 atomic-write.ts）。以前固定 `${file}.tmp`，两次保存
  // 重叠时互相踩，会话文件会凭空消失。
  await atomicWriteFile(file, json);
}

// 只要能用的记录：不存在、已损坏、更新版本写的一律 null。要分清是哪一种的调用方用 loadSessionResult。
export async function loadSession(id: string): Promise<PersistedSession | null> {
  const r = await loadSessionResult(id);
  return r.kind === "ok" ? r.rec : null;
}

export async function loadSessionResult(id: string): Promise<LoadResult> {
  const r = await loadOrRecover(id);
  if (r.kind === "unsupported-version") newerOnDisk.set(id, r.version);
  else newerOnDisk.delete(id);
  return r;
}

// ── M6（#25）：事实文件损坏隔离 ─────────────────────────────────────────────
// 会话文件读得到却解析不出来（JSON 断了、全零、字段不对）：隔离成 <id>.json.corrupt-<时间>，并从检查点的
// 记录副本（checkpoints/<id>.<n>.json，每轮开跑前拍的）里挑最新一份恢复，标题前注明「已从检查点恢复」；
// 没有副本就只隔离，列表里留一条「已损坏」。以前这种文件直接从列表里静默消失——生产上 d2341d9d 从
// 08-16 起就这样不见了，而检查点里有它三份完整副本。
// M7：更新版本写的记录不走这条路——它不是坏文件（见 record-version.ts）。
async function loadOrRecover(id: string): Promise<LoadResult> {
  const file = fileFor(id);
  if (!file) return { kind: "not-found" };
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (e) {
    return readFailure(id, e);
  }
  const first = parseSessionRecord(raw, id);
  if (first.kind !== "corrupt") return first;
  // 隔离是不可逆的动作：隔一小会儿再读一次，确认不是恰好撞上别人在替换。
  await new Promise((r) => setTimeout(r, 50));
  let again: ParsedSession;
  try {
    again = parseSessionRecord(await fs.readFile(file, "utf8"), id);
  } catch (e) {
    return readFailure(id, e);
  }
  if (again.kind !== "corrupt") return again;
  return quarantineAndRecover(id, file);
}

async function quarantineAndRecover(id: string, file: string): Promise<LoadResult> {
  const quarantined = `${file}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    await fs.rename(file, quarantined);
  } catch (e) {
    console.error(`[store] session ${id} is corrupt but could not be quarantined: ${(e as Error).message}`);
    return { kind: "corrupt", quarantined: path.basename(file) };
  }
  const cpDir = path.join(sessionsDir(), "checkpoints");
  const copyRe = new RegExp(`^${id}\\.(\\d+)\\.json$`); // id 已过 ID_RE，只含字母数字与连字符
  let best: { n: number; rec: PersistedSession } | null = null;
  try {
    for (const name of await fs.readdir(cpDir)) {
      const m = copyRe.exec(name);
      if (!m || (best && Number(m[1]) <= best.n)) continue;
      // M7：更新版本写的副本同样不拿来恢复（本版本写回去会抹掉它的字段）。
      const copy = parseSessionRecord(await fs.readFile(path.join(cpDir, name), "utf8").catch(() => ""), id);
      if (copy.kind === "ok") best = { n: Number(m[1]), rec: copy.rec };
    }
  } catch {
    /* 没有检查点目录 */
  }
  if (!best) {
    console.error(`[store] session ${id} is corrupt and has no checkpoint copy; quarantined as ${path.basename(quarantined)}`);
    return { kind: "corrupt", quarantined: path.basename(quarantined) };
  }
  const restored: PersistedSession = { ...best.rec, title: `[已从检查点恢复] ${best.rec.title}`.slice(0, 200), updatedAt: Date.now() };
  await atomicWriteFile(file, JSON.stringify(restored));
  console.error(`[store] session ${id} was corrupt; quarantined as ${path.basename(quarantined)}, restored from checkpoint ${best.n}`);
  return { kind: "ok", rec: restored, restoredFrom: best.n };
}

export async function deleteSessionFile(id: string): Promise<boolean> {
  const file = fileFor(id);
  if (!file) return false;
  try {
    await fs.unlink(file);
    newerOnDisk.delete(id);
    return true;
  } catch (e) {
    // Q14：本来就没有不用说；删不掉（被占用、权限）要留一句——否则会话刷新后又冒出来，谁也不知道为什么
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") console.error(`[store] session ${id} could not be deleted (${code ?? "?"}): ${(e as Error).message}`);
    return false;
  }
}

const LIST_CAP = 100;

// One page of sessions, newest first. The hard 100-item cap used to make every
// older conversation permanently unreachable from the UI — there was no way to
// ask for the next page. `total` lets the caller show "N more" and page through.
//
// filter: drop sessions from the listing entirely (they stay on disk) — the
// quick-chat bucket uses this to expose only its newest conversation.
// pin: stable-sort matches to the FRONT before paging. A pinned session must
// never fall off the first page (the sidebar's quick row would silently show
// "no conversation" once 100 newer sessions exist); sorting instead of
// appending keeps the client's items-held-so-far offset arithmetic exact.
export async function listSessionsPage(
  opts: {
    offset?: number;
    limit?: number;
    filter?: (m: SessionMeta) => boolean;
    pin?: (m: SessionMeta) => boolean;
  } = {},
): Promise<{ items: SessionMeta[]; total: number; offset: number; limit: number }> {
  const metas = await listAllSessionMetas();
  const filtered = opts.filter ? metas.filter(opts.filter) : metas;
  const pin = opts.pin;
  const all = pin ? [...filtered].sort((a, b) => Number(pin(b)) - Number(pin(a))) : filtered;
  const offset = Math.max(0, Math.floor(opts.offset ?? 0));
  const limit = Math.min(LIST_CAP, Math.max(1, Math.floor(opts.limit ?? LIST_CAP)));
  return { items: all.slice(offset, offset + limit), total: all.length, offset, limit };
}

// Back-compat: the first page as a bare array (existing callers/tests).
export async function listSessions(): Promise<SessionMeta[]> {
  return (await listSessionsPage()).items;
}

async function listAllSessionMetas(): Promise<SessionMeta[]> {
  let names: string[];
  try {
    names = await fs.readdir(sessionsDir());
  } catch (e) {
    // Q14：还没有会话目录是正常的；读不了目录（权限、被占用）就得留一句，不然侧栏空了没人知道为什么
    const code = (e as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") console.error(`[store] sessions directory cannot be listed (${code ?? "?"}): ${(e as Error).message}`);
    return [];
  }
  const metas: SessionMeta[] = [];
  const listed = new Set<string>();
  // M6：隔离下来、又没能恢复的会话在列表里留一条「已损坏」（按隔离文件的修改时间排）。
  const corruptStub = (id: string, what: string, at: number): SessionMeta => ({
    id, title: `（会话文件已损坏：${what}，没有可恢复的检查点副本）`, createdAt: at, updatedAt: at,
    messageCount: 0, provider: "", model: "", corrupt: true,
  });
  for (const n of names) {
    if (!n.endsWith(".json")) continue;
    const id = n.slice(0, -".json".length);
    const r = await loadSessionResult(id);
    if (r.kind === "not-found") continue;
    listed.add(id);
    if (r.kind === "corrupt") {
      metas.push(corruptStub(id, r.quarantined, Date.now()));
      continue;
    }
    if (r.kind === "unreadable") {
      // Q14：读不了不等于没有——列表里留一条说清楚，而不是悄悄从侧栏消失
      const at = Date.now();
      metas.push({ id, title: `（会话文件这会儿读不了：${r.code}，稍后再试）`, createdAt: at, updatedAt: at, messageCount: 0, provider: "", model: "" });
      continue;
    }
    if (r.kind === "unsupported-version") {
      const v = r.view;
      metas.push({
        id,
        title: `[只读·新版本 v${v.version}] ${v.title}`,
        createdAt: v.createdAt,
        updatedAt: v.updatedAt,
        messageCount: v.messages.length,
        provider: v.provider,
        model: v.model,
        workspace: v.workspace,
        readOnly: { version: v.version },
      });
      continue;
    }
    const rec = r.rec;
    metas.push({
      id: rec.id,
      title: rec.title,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
      messageCount: rec.messages.length,
      provider: rec.config.provider,
      model: rec.config.model,
      workspace: rec.config.workspace,
    });
  }
  // 之前就隔离了、又一直没恢复的：同一个 id 没有正常文件时，每次列表都照样显示。
  for (const n of names) {
    const m = /^([a-zA-Z0-9-]{1,64})\.json\.corrupt-/.exec(n);
    if (!m || listed.has(m[1])) continue;
    listed.add(m[1]);
    const at = await fs.stat(path.join(sessionsDir(), n)).then((s) => s.mtimeMs, () => 0);
    metas.push(corruptStub(m[1], n, at));
  }
  metas.sort((a, b) => b.updatedAt - a.updatedAt);
  return metas;
}
