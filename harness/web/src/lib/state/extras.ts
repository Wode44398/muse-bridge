// 按能力位出现的会话功能：诊断包、从这里改写、用量账本、项目对话、记忆面板、审阅面板。
import * as api from "../api.ts";
import { t, tr } from "../i18n.ts";
import { haptic } from "../touch.ts";
import { artifactHost } from "../open-artifact.ts";
import type { Item } from "../timeline-types.ts";
import type { Chat } from "./chat.svelte.ts";
import { app, toast } from "./core.svelte.ts";
import { canRefSessions } from "./lists.ts";
import { evictChat, openSession } from "./pool.ts";

// Q13：导出当前对话的诊断包——服务端写进会话工作区，这里按「产物」打开：有宿主（bridge）交给它的查看器（手机上能分享 /
// 另存），独立运行时直接下载。
export function diagnosticsAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("diagnostics"));
}
export async function exportDiagnostics(): Promise<void> {
  const id = app.chat.id;
  if (!id) {
    toast(t("先打开一个对话，再导出它的诊断包"));
    return;
  }
  try {
    const made = await api.createDiagnostics(id);
    const host = artifactHost();
    if (host) host({ path: made.path, name: made.name, kind: made.kind, size: made.size }, id);
    else window.open(api.artifactUrl(id, made.path, true), "_blank", "noopener,noreferrer");
    toast(t("诊断包已生成：{name}", { name: made.name }));
  } catch (e: any) {
    toast(t("导出诊断包失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}

// ── U9：从这里改写（只退对话、文件不动、原话回填、可撤销）──────────────────────────────
export function rewindAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("rewind"));
}

// ── O8（N39）：用量账本（上下文弹层里的「用量」）───────────────────────────────────────────────
export function usageLedgerAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("usage-ledger"));
}

// 项目对话（server/project-mode.ts）：服务端有这一位，新对话才能选「项目」形态、项目对话里才有项目概览
export function projectModeAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("project-mode"));
}
// 新对话（还没发出第一条）选形态；已经建起来的会话形态不变
export function setChatShape(chat: Chat, shape: "" | "project"): void {
  if (chat.id || chat.running) return;
  chat.shape = shape;
}

// ── K7（N54）：全局层记忆（记忆面板里「这个项目 | 全局」）────────────────────────────────────────
export function globalMemoryAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("memory-global"));
}
// K11：记忆总览（全局层 + 各项目 + 旧快照桶一次拿齐）；旧服务端没有这一位，面板退回「一个项目」的视图
export function memoryOverviewAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("memory-overview"));
}
// 离线记忆整理（复核意见、「现在整理」）；旧服务端没有这一位，面板不露这一块
export function memoryDreamAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("memory-dream"));
}
// 打开记忆面板：for = 直接看某个项目（侧栏项目菜单、召回芯片）；不给 = 从设置进总览
export function openMemory(opts: { for?: { path: string; name: string }; fromSettings?: boolean } = {}): void {
  app.memoryFor = opts.for ?? null;
  app.memoryFromSettings = Boolean(opts.fromSettings);
  app.sheet = "memory";
}

// ── U10（K38）：审阅面板的「本会话」视图 + 逐文件撤销 ────────────────────────────────────────
export function sessionReviewAvailable(): boolean {
  return Boolean(app.compat?.caps?.includes("session-review"));
}

type UserBubble = Extract<Item, { kind: "user" }>;

// 点的是时间线上的哪个用户气泡 → 「第几个用户气泡」（和服务端同一个口径：插话也算气泡，只是不许退到插话之前）
export async function rewindFrom(item: UserBubble): Promise<void> {
  const chat = app.chat;
  const sid = chat.id;
  if (!sid) return;
  if (chat.running) {
    toast(t("这一轮还在跑，先停下再改写"));
    return;
  }
  const ordinal = chat.timeline.filter((it) => it.kind === "user").indexOf(item);
  if (ordinal < 0) return;
  haptic("medium");
  const r = await api.rewindSession(sid, ordinal, item.text);
  if (!r.ok) {
    toast(
      r.code === "running"
        ? t("这一轮还在跑，先停下再改写")
        : r.code === "not_found"
          ? t("这条消息已经压缩进摘要了，改写不了（可以用检查点回滚）")
          : t("改写失败：{reason}", { reason: tr(r.error ?? "") }),
    );
    return;
  }
  evictChat(sid);
  await openSession(sid);
  if (app.chat.id === sid) {
    if (item.attachments?.length) app.chat.attachments = item.attachments.map((a) => a.path);
    if (item.refs?.length && canRefSessions()) app.chat.refs = item.refs.map((r) => ({ ...r })); // 引用的对话也放回输入框
    app.refill = item.text;
  }
  const changed = r.changedFiles?.length ?? 0;
  const undo = r.undo;
  toast(
    changed ? t("已退回到这条消息之前（{n} 个文件没有回退）", { n: changed }) : t("已退回到这条消息之前，原话放回输入框了"),
    undo ? { label: t("撤销"), run: () => void undoRewindFor(sid, undo, item.text) } : undefined,
  );
}

async function undoRewindFor(sid: string, undo: { n: number; length: number }, text: string): Promise<void> {
  const r = await api.undoRewind(sid, undo.n, undo.length);
  if (!r.ok) {
    toast(r.code === "moved_on" ? t("改写之后又发过消息了，撤销不了（可以用检查点回滚）") : t("撤销失败：{reason}", { reason: tr(r.error ?? "") }));
    return;
  }
  evictChat(sid);
  await openSession(sid);
  // 放回输入框的原话还没动过就一起收回（那条消息又回到对话里了）
  if (app.chat.id === sid && app.chat.draft.trim() === text.trim()) {
    app.chat.draft = "";
    app.chat.attachments = [];
    app.chat.refs = [];
  }
  toast(t("已撤销改写"));
}
