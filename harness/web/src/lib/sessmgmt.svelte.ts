// 会话管理（服务端 server/sessmgmt/）的前端状态与动作：稍后发送的队列、Tab 输入建议、改名、归档、通知偏好与在场心跳。
// 每项都按服务端能力位出现（旧后端整块不出现、不报错）。实时更新走全局事件通道（queue / suggestion / session_title），
// 打开一个会话时取一次它的 extras 兜底（刷新、换设备、重连之后）。
import { sessFetch, sessJson, sessPost } from "./api.ts";
import { app, refreshSessions, send, sessHooks, toast, type Chat, type SessionMeta } from "./state.svelte.ts";
import { haptic } from "./touch.ts";
import { clientId } from "./client-id.ts";
import { t, tr } from "./i18n.ts";

export interface QueueItem {
  id: string;
  text: string;
  at: number;
}

interface SuggestionView {
  text: string;
  at: number;
  dismissed?: boolean;
}

export const sm = $state({
  queues: {} as Record<string, QueueItem[]>,
  suggestions: {} as Record<string, SuggestionView>,
  // 已归档的会话（侧栏底部「已归档」展开时才拉；count = -1 表示还不知道）
  archived: [] as SessionMeta[],
  archivedCount: -1,
  archivedLoading: false,
  notify: { permission: true, question: true, done: true },
  suggestOn: true,
});

const cap = (name: string): boolean => Boolean(app.compat?.caps?.includes(name));
export const canQueue = () => cap("send-queue");
export const canRename = () => cap("session-rename");
export const canArchive = () => cap("session-archive");
export const canSuggest = () => cap("prompt-suggestions");

const enc = encodeURIComponent;

// ── 全局事件 ────────────────────────────────────────────────────────────────────
function setQueueOf(id: string, items: unknown) {
  sm.queues[id] = Array.isArray(items) ? (items as QueueItem[]) : [];
}

function onEvent(ev: any): boolean {
  if (ev?.e === "queue" && typeof ev.id === "string") {
    setQueueOf(ev.id, ev.items);
    return true;
  }
  if (ev?.e === "suggestion" && typeof ev.id === "string") {
    const text = typeof ev.text === "string" ? ev.text : "";
    if (text) sm.suggestions[ev.id] = { text, at: Number(ev.at) || Date.now() };
    else delete sm.suggestions[ev.id];
    return true;
  }
  if (ev?.e === "session_title" && typeof ev.id === "string" && typeof ev.title === "string") {
    const row = app.sessions.find((s) => s.id === ev.id);
    if (row) row.title = ev.title;
    for (const c of app.chats) if (c.id === ev.id) c.title = ev.title;
    return true;
  }
  if (ev?.e === "list_changed" && ev.what !== "projects" && sm.archivedCount >= 0) scheduleArchivedRefresh();
  if (ev?.e === "snapshot") void loadState(); // 重连：偏好可能在断开期间改过
  return false; // list_changed / snapshot 还要交给原来的处理
}
sessHooks.global.push(onEvent);
sessHooks.notifyAllowed = (kind) => (kind === "ask" ? sm.notify.question : kind === "done" ? sm.notify.done : sm.notify.permission);

// ── 偏好（通知三项、输入建议开关）：启动、回到页面、全局通道重连时取 ─────────────────
let stateAt = 0;
export async function loadState(force = false): Promise<void> {
  if (!cap("notify-prefs")) return;
  if (!force && Date.now() - stateAt < 5_000) return;
  stateAt = Date.now();
  try {
    const st = await sessJson<{ notify?: typeof sm.notify; suggestions?: boolean }>("/api/sessmgmt/state", { timeoutMs: 10_000 });
    if (st.notify) sm.notify = { permission: st.notify.permission !== false, question: st.notify.question !== false, done: st.notify.done !== false };
    sm.suggestOn = st.suggestions !== false;
  } catch {
    /* 拿不到就按默认 */
  }
}

// ── 打开的会话：取一次 extras（队列、建议）──────────────────────────────────────
const extrasAt = new Map<string, number>();
export async function loadExtras(id: string | null): Promise<void> {
  if (!id || !(canQueue() || canSuggest())) return;
  const last = extrasAt.get(id) ?? 0;
  if (Date.now() - last < 3_000) return;
  extrasAt.set(id, Date.now());
  try {
    const x = await sessJson<{ queue?: QueueItem[]; suggestion?: { text: string; at: number } | null }>(`/api/sessions/${enc(id)}/extras`, { timeoutMs: 10_000 });
    setQueueOf(id, x.queue);
    const prev = sm.suggestions[id];
    if (x.suggestion?.text) sm.suggestions[id] = { ...x.suggestion, dismissed: prev?.at === x.suggestion.at ? prev.dismissed : undefined };
    else delete sm.suggestions[id];
  } catch {
    /* 旧会话 / 网络抖：不打扰 */
  }
}

// ── 稍后发送 ────────────────────────────────────────────────────────────────────
export function queueOf(chat: Chat): QueueItem[] {
  return chat.id ? (sm.queues[chat.id] ?? []) : [];
}

// 排进队列。false = 没排进去（没在跑：调用方改走普通发送；别的原因已提示）
export async function sendLater(chat: Chat, text: string): Promise<"queued" | "not_running" | "failed"> {
  const msg = text.trim();
  if (!msg || !chat.id) return "failed";
  const id = `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // 乐观：先挂上（服务端的 queue 事件按全量覆盖，对得上）
  const before = queueOf(chat);
  sm.queues[chat.id] = [...before, { id, text: msg, at: Date.now() }];
  try {
    const r = await sessJson<{ items: QueueItem[] }>(`/api/sessions/${enc(chat.id)}/queue`, sessPost({ text: msg, id }));
    setQueueOf(chat.id, r.items);
    return "queued";
  } catch (e: any) {
    sm.queues[chat.id] = before;
    if (e?.status === 409) return "not_running";
    toast(e?.body?.error === "full" ? t("排队的消息太多了，先等这一轮跑完") : t("没排上队：{reason}", { reason: tr(String(e?.message ?? e)) }));
    return "failed";
  }
}

async function queueCall(chat: Chat, path: string, body: Record<string, unknown>): Promise<any> {
  if (!chat.id) return null;
  try {
    return await sessJson(`/api/sessions/${enc(chat.id)}/queue${path}`, sessPost(body));
  } catch (e: any) {
    toast(t("操作没成功：{reason}", { reason: tr(String(e?.message ?? e)) }));
    return null;
  }
}

export async function removeQueued(chat: Chat, item: QueueItem): Promise<void> {
  await queueCall(chat, "/remove", { id: item.id });
}

// 拿回输入框改（撤回，话接进输入框）
export async function editQueued(chat: Chat, item: QueueItem): Promise<void> {
  const r = await queueCall(chat, "/remove", { id: item.id });
  if (r?.ok && chat === app.chat) app.refill = item.text;
}

export async function promoteQueued(chat: Chat, item: QueueItem): Promise<void> {
  const r = await queueCall(chat, "/promote", { id: item.id });
  if (r && !r.ok) toast(r.error === "gone" ? t("这条已经发出去了") : t("现在发不出去，稍后再试"));
}

export async function clearQueued(chat: Chat): Promise<void> {
  await queueCall(chat, "/clear", {});
}

// 输入框里的话改作「稍后发送」：清掉草稿排进队列；刚好这一轮收了（not_running）就照普通发送；排不上把话放回去
export async function laterFromDraft(chat: Chat): Promise<void> {
  const text = chat.draft;
  if (!text.trim()) return;
  chat.draft = "";
  chat.draftTarget = undefined;
  haptic("light");
  const r = await sendLater(chat, text);
  if (r === "queued") return;
  if (r === "not_running" && chat === app.chat) {
    await send(text);
    return;
  }
  chat.draft = chat.draft.trim() ? `${text}
${chat.draft}` : text;
}

// 输入框的快捷键（在斜杠面板之后、回车发送之前调）。true = 已处理
//   Ctrl / ⌘ + 回车：运行中 = 稍后发送；空闲 = 照常发送（与 Claude 同）
//   Tab：输入框空着、有建议 → 填入；Esc：收起建议
export function composerKey(e: KeyboardEvent, chat: Chat, composing: boolean): boolean {
  if (composing) return false;
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
    if (!chat.running || !canQueue() || !chat.draft.trim()) return false; // 交给原来的回车处理
    e.preventDefault();
    void laterFromDraft(chat);
    return true;
  }
  if (chat.draft) return false;
  const sug = suggestionFor(chat);
  if (!sug) return false;
  if (e.key === "Tab" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
    e.preventDefault();
    fillSuggestion(chat);
    return true;
  }
  if (e.key === "Escape") {
    e.preventDefault();
    dismissSuggestion(chat);
    return true;
  }
  return false;
}

export function fillSuggestion(chat: Chat): void {
  const sug = suggestionFor(chat);
  if (!sug || chat.draft.trim()) return; // 有字绝不覆盖
  chat.draft = sug;
  dismissSuggestion(chat);
}

// ── Tab 输入建议 ────────────────────────────────────────────────────────────────
// 输入框空着、没在跑、偏好开着、没被收起时的建议文字
export function suggestionFor(chat: Chat): string {
  if (!chat.id || chat.running || !sm.suggestOn || !canSuggest()) return "";
  const s = sm.suggestions[chat.id];
  return s && !s.dismissed ? s.text : "";
}

export function dismissSuggestion(chat: Chat): void {
  const s = chat.id ? sm.suggestions[chat.id] : undefined;
  if (s) s.dismissed = true;
}

// ── 改名 / 归档 ─────────────────────────────────────────────────────────────────
export async function renameSession(id: string, title: string): Promise<boolean> {
  const clean = title.replace(/\s+/g, " ").trim();
  if (!clean) return false;
  try {
    const r = await sessJson<{ title: string }>(`/api/sessions/${enc(id)}/rename`, sessPost({ title: clean }));
    onEvent({ e: "session_title", id, title: r.title });
    return true;
  } catch (e: any) {
    toast(t("改名没成功：{reason}", { reason: tr(String(e?.message ?? e)) }));
    return false;
  }
}

export async function setArchived(id: string, on: boolean): Promise<boolean> {
  try {
    const r = await sessJson<{ changed: string[]; skipped: string[] }>(`/api/sessions/${enc(id)}/archive`, sessPost({ on }));
    if (r.skipped?.includes(id)) {
      toast(t("这个对话还在运行、在等你处理或有排队的消息，先不归档"));
      return false;
    }
    if (on) {
      app.sessions = app.sessions.filter((s) => s.id !== id);
      toast(t("已归档，可在侧栏底部「已归档」里找回"), { label: t("撤销"), run: () => void setArchived(id, false) });
    } else {
      sm.archived = sm.archived.filter((s) => s.id !== id);
      void refreshSessions();
    }
    if (sm.archivedCount >= 0) void loadArchived();
    return true;
  } catch (e: any) {
    toast(t("归档没成功：{reason}", { reason: tr(String(e?.message ?? e)) }));
    return false;
  }
}

export async function loadArchived(): Promise<void> {
  if (!canArchive() || sm.archivedLoading) return;
  sm.archivedLoading = true;
  try {
    const res = await sessFetch(`/api/sessions?archived=only&limit=100`, { timeoutMs: 15_000 });
    if (res.ok) {
      sm.archived = (await res.json()) as SessionMeta[];
      const raw = res.headers.get("X-Total-Count");
      const total = raw == null ? NaN : Number(raw);
      sm.archivedCount = Number.isFinite(total) ? total : sm.archived.length;
    }
  } catch {
    /* 下次再说 */
  }
  sm.archivedLoading = false;
}

let archivedTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleArchivedRefresh() {
  if (archivedTimer) return;
  archivedTimer = setTimeout(() => {
    archivedTimer = null;
    void loadArchived();
  }, 400);
}

// ── 在场心跳：页面可见时每 30 秒报一次「我在看哪个会话」（服务端据此决定要不要经 bridge 推送）────────
let presenceTimer: ReturnType<typeof setInterval> | null = null;
let lastPresence = "";
function reportPresence(force = false) {
  if (!cap("notify-prefs") || typeof document === "undefined") return;
  const visible = !document.hidden;
  const key = `${visible}|${app.chat.id ?? ""}`;
  if (!force && key === lastPresence && !visible) return;
  lastPresence = key;
  void sessJson("/api/sessmgmt/presence", sessPost({ client: clientId(), visible, session: app.chat.id ?? null })).catch(() => {});
}

export function startSessMgmt(): () => void {
  void loadState(true);
  const onVis = () => {
    reportPresence(true);
    if (!document.hidden) {
      void loadState();
      void loadExtras(app.chat.id);
    }
  };
  document.addEventListener("visibilitychange", onVis);
  presenceTimer = setInterval(() => {
    if (!document.hidden) reportPresence(true);
  }, 30_000);
  // 前台会话换了：取它的 extras、报一次在场
  const stop = $effect.root(() => {
    $effect(() => {
      const id = app.chat.id;
      const ready = Boolean(app.compat);
      if (!ready) return;
      void loadExtras(id);
      reportPresence(true);
    });
  });
  return () => {
    document.removeEventListener("visibilitychange", onVis);
    if (presenceTimer) clearInterval(presenceTimer);
    presenceTimer = null;
    stop();
  };
}
