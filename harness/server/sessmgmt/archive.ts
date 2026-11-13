// 会话归档（对齐 Claude 分页 / 官方 Desktop 的 Archive）：
//   · 归档 / 取消归档只是标记（会话、记录、检查点一个不删）；会话列表与搜索默认不列已归档的，侧栏底部「已归档」里能看、能取消；
//   · 在跑 / 在等人 / 有稍后发送排着的不归档（官方同款）；快照对话不归档（它常驻侧栏顶部、只留最新一条）；
//   · 真人在已归档的会话里接着发消息 → 自动取消归档（发了就是要接着用）；
//   · 偏好「归档不活跃的会话」N 天（0 = 关）：每小时扫一遍，N 天没动过、不忙、没人取消过归档的会话自动归档（原因 inactive）。
//     最近 15 分钟内有设备开着它的不归（官方 on_screen）——这里以会话在内存里被读过的时刻近似。
import { getSession, noteListChanged, waitingOf } from "../session.ts";
import { listSessionsPage, type SessionMeta } from "../store.ts";
import { prefValue } from "../prefs.ts";
import { isQuickPath } from "../quick.ts";
import { getFlags, getQueue, patchFlags, allFlags } from "./store.ts";

const DAY = 86_400_000;
const ON_SCREEN_MS = 15 * 60_000;

export function isArchived(id: string): boolean {
  return Boolean(getFlags(id).archivedAt);
}

// 列表 / 搜索的过滤：exclude（默认）= 不列已归档，only = 只列已归档，include = 都列
export type ArchiveView = "exclude" | "only" | "include";
export function archiveViewOf(raw: unknown): ArchiveView {
  return raw === "only" || raw === "include" ? raw : raw === "1" || raw === "true" ? "only" : "exclude";
}
export function archiveFilter(view: ArchiveView, inner?: (m: SessionMeta) => boolean): (m: SessionMeta) => boolean {
  return (m) => {
    if (inner && !inner(m)) return false;
    if (view === "include") return true;
    const a = isArchived(m.id);
    return view === "only" ? a : !a;
  };
}

function busy(id: string): boolean {
  const s = getSession(id);
  return Boolean(s && (s.running || waitingOf(s))) || getQueue(id).length > 0;
}

export type ArchiveResult = { ok: true; changed: string[]; skipped: string[] };

export function setArchived(ids: string[], on: boolean, by: "user" | "inactive" = "user", opts: { quick?: (id: string) => boolean } = {}): ArchiveResult {
  const changed: string[] = [];
  const skipped: string[] = [];
  const now = Date.now();
  for (const id of ids) {
    const was = isArchived(id);
    if (on) {
      if (was) continue;
      if (busy(id) || opts.quick?.(id)) {
        skipped.push(id);
        continue;
      }
      patchFlags(id, { archivedAt: now, archivedBy: by });
      changed.push(id);
    } else {
      if (!was) continue;
      // 手动取消过的以后不再被自动归档；接着发消息带来的取消（by inactive 之外）也算
      patchFlags(id, { archivedAt: undefined, archivedBy: undefined, unarchivedAt: now });
      changed.push(id);
    }
  }
  if (changed.length) noteListChanged("sessions");
  return { ok: true, changed, skipped };
}

// 真人发了消息：已归档就取消
export function unarchiveOnTurn(id: string): void {
  if (isArchived(id)) setArchived([id], false);
}

// 一次自动归档扫描（导出给测试）。返回这次归档了哪些
export async function sweepInactive(now = Date.now()): Promise<string[]> {
  const days = Number(prefValue<string>("autoArchiveDays"));
  if (!Number.isFinite(days) || days <= 0) return [];
  const cutoff = now - days * DAY;
  // 列表接口一页最多 100 条：全部会话经过滤器一条条递过来时收下（一次扫盘），页本身不要
  const all: SessionMeta[] = [];
  await listSessionsPage({ limit: 1, filter: (m) => (all.push(m), false) });
  const flags = allFlags();
  const due: string[] = [];
  for (const m of all) {
    if (m.corrupt || m.readOnly) continue;
    const f = flags[m.id];
    if (f?.archivedAt || f?.unarchivedAt) continue;
    if (m.updatedAt > cutoff || isQuickPath(m.workspace)) continue;
    const live = getSession(m.id);
    if (live && now - live.touchedAt < ON_SCREEN_MS) continue;
    due.push(m.id);
  }
  return due.length ? setArchived(due, true, "inactive").changed : [];
}

let timer: NodeJS.Timeout | null = null;
export function startAutoArchive(everyMs = 60 * 60_000): void {
  if (timer) return;
  const tick = () => void sweepInactive().then(
    (ids) => ids.length && console.log(`[sessmgmt] 自动归档了 ${ids.length} 个不活跃的会话`),
    (e) => console.warn(`[sessmgmt] 自动归档扫描失败：${(e as Error).message}`),
  );
  // 启动后先等一会儿（别和启动时的续跑、知识对账抢），之后每小时一次
  const first = setTimeout(tick, 2 * 60_000);
  first.unref?.();
  timer = setInterval(tick, everyMs);
  timer.unref?.();
}
