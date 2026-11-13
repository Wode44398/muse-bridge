// 工作区协同 · 前端这一半（服务端 Workspace / Terminal 工具的另一头）：
// ① 视图上报：「用户此刻在看什么」防抖 POST /api/ui/state——前台会话与工作空间、工作区开没开 / 开着哪个工具、
//    审阅里展开的文件、浏览器地址；嵌在 bridge 里时再拼上宿主的视图（bridge 的文件面板与预览：路径、PDF 页码、
//    编辑器模式、有没有未保存的修改）。宿主经 setWorkspaceHost 交进来，复用 bridge 自己那套采集，不另造。
// ② 事件入站（state.svelte.ts 的 handleEvent 转来）：workspace.preview 把文件弹到用户眼前、workspace.draft 交回
//    编辑器里未保存的草稿；terminal = agent 动了共享终端（宽屏工作区关着就展开终端，否则标签上亮小点）。
//    重连会重放这一轮的事件：按 id 去重、超过 60 秒的旧事件不执行。
import type { Snippet } from "svelte";
import { untrack } from "svelte";
import * as api from "./api.ts";
import { clientId } from "./client-id.ts";
import { t } from "./i18n.ts";
import { app, openDock, openDockFiles, toast, type Chat } from "./state.svelte.ts";

// ── 宿主（bridge）注入 ─────────────────────────────────────────────────────────
export interface WorkspaceHost {
  // 宿主此刻的视图（bridge uiReport 的那份：page / files / preview）
  view?: () => Record<string, unknown> | null;
  // 宿主视图变了就回调（返回退订）
  onView?: (cb: () => void) => () => void;
  // 宿主编辑器里的当前全文（没有打开的编辑器 = null）：{ rel, ws, mode, dirty, text }
  draft?: () => Record<string, unknown> | null;
  // 用宿主的查看器打开工作空间里的文件（ws 绝对路径 + 相对路径）
  preview?: (ws: string, rel: string) => void;
  // 工作区「记忆」工具的视图（bridge 的记忆卡，看 dimensio 的记忆）
  memoryView?: Snippet<[{ ws: string }]> | null;
}
export const wsHost = $state<{ h: WorkspaceHost | null }>({ h: null });
export function setWorkspaceHost(h: WorkspaceHost | null): void {
  wsHost.h = h;
}

// agent 动过共享终端、用户还没去看：Dock 的终端标签亮小点
export const collab = $state({ termLive: false });

// 审阅面板里展开着的文件（ReviewPanel 报上来）
const local = $state({ review: [] as string[] });
export function reportReview(files: string[]): void {
  local.review = files.slice(0, 8);
}

const clientKind = (): string => {
  const w = globalThis as any;
  return w.BridgeDesktop ? "desktop" : w.AndroidStore ? "apk" : "web";
};
const supported = () => Boolean(app.compat?.caps?.includes("workspace-collab"));

// ── ① 视图上报 ─────────────────────────────────────────────────────────────────
let mounted = false;
let timer = 0;
let lastSent = "";
function snapshot(): Record<string, unknown> {
  const tool = app.dockTool;
  return {
    chatId: app.chat.id ?? "",
    ws: app.config?.workspace ?? "",
    dock: { open: app.dockOpen, tool },
    ...(app.dockOpen && tool === "review" && local.review.length ? { review: { file: local.review.join(", ") } } : {}),
    ...(app.dockOpen && tool === "browser" && app.browser?.url ? { browser: { url: app.browser.url } } : {}),
  };
}
function send(force = false): void {
  if (!supported()) return;
  let host: Record<string, unknown> | null = null;
  try {
    host = wsHost.h?.view?.() ?? null;
  } catch {
    host = null;
  }
  const state = { ...snapshot(), ...(host ? { host } : {}) };
  const body = JSON.stringify(state);
  if (!force && body === lastSent) return;
  lastSent = body;
  api.uiState({ clientId: clientId(), client: clientKind(), state }).catch(() => {});
}
function schedule(): void {
  clearTimeout(timer);
  timer = window.setTimeout(() => send(), 400);
}

// App 挂载时开、卸载时关（bridge 静态 import 本模块，别的分页上不该上报）
export function startWorkspaceCollab(): () => void {
  mounted = true;
  const stopEffects = $effect.root(() => {
    $effect(() => {
      // 读到的这些都是依赖：变了就重新上报
      void JSON.stringify(snapshot());
      void supported();
      untrack(schedule);
    });
  });
  let offHost: (() => void) | undefined;
  const stopHost = $effect.root(() => {
    $effect(() => {
      const h = wsHost.h;
      untrack(() => {
        offHost?.();
        offHost = h?.onView?.(schedule);
      });
    });
  });
  // 90 秒没上报服务端就当「可能已离开」：看得见的时候隔一会儿补一次
  const beat = window.setInterval(() => {
    if (document.visibilityState === "visible") send(true);
  }, 45_000);
  const onVis = () => {
    if (document.visibilityState === "visible") send(true);
  };
  document.addEventListener("visibilitychange", onVis);
  return () => {
    mounted = false;
    stopEffects();
    stopHost();
    offHost?.();
    clearInterval(beat);
    clearTimeout(timer);
    document.removeEventListener("visibilitychange", onVis);
  };
}

// ── ② 事件入站 ─────────────────────────────────────────────────────────────────
const seen = new Set<string>();
const MAX_AGE = 60_000;
function fresh(ev: any): boolean {
  const key = String(ev.id ?? `${ev.e}:${ev.action ?? ev.op}:${ev.at}`);
  if (seen.has(key)) return false;
  seen.add(key);
  if (seen.size > 300) for (const k of [...seen].slice(0, 100)) seen.delete(k);
  return !(typeof ev.at === "number" && Math.abs(Date.now() - ev.at) > MAX_AGE);
}

const fold = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();

function showFile(chat: Chat, ws: string, rel: string): void {
  const h = wsHost.h;
  const here = app.config?.workspace ?? "";
  // 工作区「文件」视图（嵌入态才有）：落到文件所在目录并打开它——和点产物卡同一套体验
  if (mounted && chat === app.chat && app.hasFilesView && ws && fold(ws) === fold(here)) {
    const cut = rel.lastIndexOf("/");
    openDockFiles({ rel: cut > 0 ? rel.slice(0, cut) : "", open: rel.slice(cut + 1) });
    return;
  }
  if (h?.preview && ws) {
    h.preview(ws, rel);
    return;
  }
  if (!mounted || chat !== app.chat) return;
  // 独立运行没有查看器：给一个点了才开的入口（弹窗必须出自用户的点按）
  const name = rel.split("/").pop() || rel;
  toast(t("agent 想给你看 {name}", { name }), {
    label: t("打开"),
    // guard: window-open ok — 独立 8799 没有宿主查看器时的兜底，出自用户点按
    run: () => void window.open(api.dockFileUrl({ ws }, rel), "_blank", "noopener,noreferrer"),
  });
}

async function answerDraft(ev: any): Promise<void> {
  if (ev.client && ev.client !== clientId()) return;
  let d: Record<string, unknown> | null = null;
  try {
    d = wsHost.h?.draft?.() ?? null;
  } catch {
    d = null;
  }
  // 回给 agent 的工具结果（模型读），不是界面文案
  await api.uiAnswer(String(ev.id), d ?? { error: "no open editor" }).catch(() => {});
}

// 是工作区协同的事件就处理掉并返回 true（不进时间线归约）
export function onCollabEvent(chat: Chat, ev: any): boolean {
  if (ev?.e === "terminal") {
    if (!fresh(ev) || chat !== app.chat) return true;
    const wide = typeof matchMedia === "function" && matchMedia("(min-width: 700px)").matches;
    // 工作区关着、宽屏：直接展开终端；开着别的工具：不抢，只亮小点
    if (wide && !app.dockOpen && mounted) openDock("term");
    else if (!(app.dockOpen && app.dockTool === "term")) collab.termLive = true;
    return true;
  }
  if (ev?.e === "workspace") {
    if (!fresh(ev)) return true;
    if (ev.op === "draft") void answerDraft(ev);
    else if (ev.op === "preview" && typeof ev.path === "string") showFile(chat, String(ev.ws ?? ""), ev.path);
    return true;
  }
  return false;
}
