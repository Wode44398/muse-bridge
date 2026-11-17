// 活跃池：前台切换、终态缓存修剪、装载 / 打开会话、分屏、静默对账、丢弃与删除。
import * as api from "../api.ts";
import { t, tr } from "../i18n.ts";
import { paneLeft, placeInSplit, withFocusedReplaced, type Side } from "../split.ts";
import { Chat } from "./chat.svelte.ts";
import { app, LAST_SESSION_KEY, MAX_IDLE_CACHE, paneVisible, pulseGrid, rememberSession, RESYNC_TIMEOUT_MS, toast } from "./core.svelte.ts";
import { patchGlobalConfig } from "./config.ts";
import { applyRecord } from "./record.ts";
import { attachStream, forceResync } from "./resync.ts";
import { killLive } from "./run.ts";

// 把一个 chat 抬到前台（放进活跃池 + LRU 记时 + 缓存修剪）。
// 分屏时换的是有焦点的那一格；要换上的会话已经在另一格里 = 只是把焦点挪过去（同一个会话不会同时占两格）。
export function foreground(chat: Chat) {
  if (!app.chats.includes(chat)) app.chats.push(chat);
  chat.lastSeenAt = Date.now();
  if (app.panes.length === 2 && !app.panes.includes(chat)) app.panes = withFocusedReplaced(app.panes, app.chat, chat);
  app.chat = chat;
  // M2：在后台时没送达的那一条，切过来时放回输入框
  if (chat.pendingRefill != null) {
    app.refill = chat.pendingRefill;
    chat.pendingRefill = null;
  }
  // 产物定位只对产它的那个会话/工作空间有意义——换会话就清掉，免得文件视图
  // 拿着上一个会话的相对路径去新工作空间里找。
  app.filesTarget = null;
  trimChats();
}

// 终态缓存修剪：非前台、不在跑的按最近浏览保留 MAX_IDLE_CACHE 个。
// running/reconnecting 的永不淘汰（连接与恢复循环还活着）。
function trimChats() {
  const idle = app.chats.filter((c) => !paneVisible(c) && !c.running && !c.reconnecting);
  if (idle.length <= MAX_IDLE_CACHE) return;
  idle.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
  for (const c of idle.slice(0, idle.length - MAX_IDLE_CACHE)) {
    killLive(c);
    const i = app.chats.indexOf(c);
    if (i >= 0) app.chats.splice(i, 1);
  }
}

export function newChat() {
  const cur = app.chat;
  if (!cur.running && !cur.id && !cur.timeline.length) return; // 已是空白新对话
  // 空白但发送失败留下残迹（无 id）→ 直接丢弃；有 id / 在跑 → 留在活跃池
  if (!cur.running && !cur.id) {
    const i = app.chats.indexOf(cur);
    if (i >= 0) app.chats.splice(i, 1);
  }
  foreground(new Chat());
  // 清理孤儿 dev server —— 后端有护栏：任何会话在跑就拒绝 stop-all
  api.stopPreviews();
}

// 拉取 / 复用一个会话的 Chat。已在活跃池 → 原样返回（连接还活着，秒切）；
// 不在 → 拉记录建实例，running 则立刻附着直播。in-flight 去重防双击并发。
const loadingChats = new Map<string, Promise<Chat>>();
export function loadChat(id: string): Promise<Chat> {
  const cached = app.chats.find((c) => c.id === id);
  if (cached) return Promise.resolve(cached);
  const inflight = loadingChats.get(id);
  if (inflight) return inflight;
  const p = (async () => {
    const rec = await api.getSession(id);
    // await 期间可能已被别的路径装载（resume 与手点竞态）
    const again = app.chats.find((c) => c.id === id);
    if (again) return again;
    const chat = new Chat();
    chat.id = rec.id;
    // 正在运行的会话（本机断线前发起 / 别的设备发起）：时间线只重建到本轮
    // 开始前，剩下的交给直播镜像逐事件重放 —— 和发起端看到的是同一条流。
    const mirroring = rec.running && Number.isInteger(rec.runStartMsgCount);
    applyRecord(chat, rec, mirroring ? rec.runStartMsgCount : undefined);
    app.chats.push(chat);
    if (mirroring) {
      const gen = ++chat.liveGen;
      void attachStream(chat, gen);
    }
    return chat;
  })().finally(() => loadingChats.delete(id));
  loadingChats.set(id, p);
  return p;
}

// 把前台会话的快照配置同步到全局（provider/model/workspace/access/运行档位）：
// 已有会话本身不受全局值影响（服务端跑它自己的快照 cfg），但随后点
// “新对话”应自然留在这个项目/厂商。后台静默做，失败不打扰。
export async function syncConfigTo(chat: Chat) {
  if (!chat.cfg) return;
  const providerChanged = chat.cfg.provider !== app.config?.provider;
  try {
    await patchGlobalConfig({
      provider: chat.cfg.provider,
      model: chat.cfg.model,
      // 思考深度也是会话级的（会话内能换）：菜单里的选中块要显示这条会话的
      ...(chat.cfg.thinking ? { thinking: chat.cfg.thinking } : {}),
      workspace: chat.cfg.workspace,
      access: chat.cfg.access,
      permissionMode: chat.cfg.permissionMode,
    });
    if (providerChanged) pulseGrid();
  } catch { /* 静默：不影响切换本身 */ }
}

// 打开会话 —— 多会话核心入口。运行中也随便切：当前会话（连同它的连接）
// 留在活跃池继续自转，切回来直播还在。
export async function openSession(id: string) {
  // 前台实例刚被 evictChat 丢出活跃池（回滚）：它只是孤儿指针，照常重拉，不能当「重开当前会话」直接返回——
  // 以前回滚完 toast「已回滚」，页面却一直停在回滚前的对话上。
  if (id === app.chat.id && app.chats.includes(app.chat)) {
    // 重开当前会话 = 手动触发一次对账恢复（连接可疑时的自救入口）
    if (app.chat.running || app.chat.reconnecting) forceResync(app.chat);
    app.drawer = false;
    return;
  }
  const hadLocal = app.chats.some((c) => c.id === id);
  try {
    const chat = await loadChat(id);
    foreground(chat);
    rememberSession(id);
    app.drawer = false;
    void syncConfigTo(chat);
    // 缓存命中的终态会话：后台静默对账一次 —— 离开期间别的设备可能又跑了
    if (hadLocal && !chat.running && !chat.reconnecting) void reconcileIdle(chat);
  } catch (e: any) {
    toast(t("打开失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}

// ── 分屏（宽屏多会话）──────────────────────────────────────────────────────────────
// 焦点挪到分屏里的另一格：它成为 app.chat（发送、档位、工作区跟着它走），全局配置对齐到它的快照
export function focusPane(chat: Chat): void {
  if (chat === app.chat || !app.panes.includes(chat)) return;
  foreground(chat);
  if (chat.id) rememberSession(chat.id);
  void syncConfigTo(chat);
}
// 把一个会话放进分屏：side 0 = 左格、1 = 右格。没分屏时与当前对话左右并排；已分屏时换掉那一格。
// 已经在某一格里的：只把焦点挪过去。放进来的那一格拿到焦点。
export async function openInSplit(id: string, side: Side): Promise<void> {
  const hadLocal = app.chats.some((c) => c.id === id);
  let chat: Chat;
  try {
    chat = await loadChat(id);
  } catch (e: any) {
    toast(t("打开失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
    return;
  }
  if (app.panes.includes(chat)) {
    focusPane(chat);
    return;
  }
  const next = placeInSplit(app.panes, app.chat, chat, side);
  if (!next) return;
  app.panes = next;
  foreground(chat);
  rememberSession(id);
  app.drawer = false;
  void syncConfigTo(chat);
  if (hadLocal && !chat.running && !chat.reconnecting) void reconcileIdle(chat);
}
// 关掉分屏里的一格：留下另一格（关的是有焦点的那格，焦点挪到另一格）。关掉的会话留在活跃池里，在跑的照跑。
export function closePane(chat: Chat): void {
  const rest = paneLeft(app.panes, chat);
  if (!rest) return;
  app.panes = [];
  if (chat === app.chat) {
    foreground(rest);
    if (rest.id) rememberSession(rest.id);
    void syncConfigTo(rest);
  }
  trimChats();
}

// 缓存终态会话的静默对账：服务端在跑 → 接直播；有新内容 → 重建。
// liveGen 快照护栏：期间用户若在这个会话上发了新消息，一律丢弃对账结果。
async function reconcileIdle(chat: Chat) {
  if (!chat.id || chat.running || chat.resyncing) return;
  const gen = chat.liveGen;
  const id = chat.id;
  try {
    const st = await api.sessionStatus(id, RESYNC_TIMEOUT_MS);
    if (gen !== chat.liveGen || chat.running) return;
    if (!st.exists) return; // 已被删除：removeSession 路径负责清理，这里不动
    if (st.running) {
      forceResync(chat); // 别的设备把它跑起来了 → 接上直播
      return;
    }
    if (st.fp && st.fp === chat.recFp) return; // 一个字没变 → 别拉那 300KB
    const rec = await api.getSession(id, RESYNC_TIMEOUT_MS);
    if (gen !== chat.liveGen || chat.running) return;
    applyRecord(chat, rec);
  } catch { /* 静默 */ }
}

// 丢弃某会话的本地缓存实例（回滚等场景：服务端状态已重置，本地必须重拉）。
// 前台被丢时 app.chat 暂成孤儿指针 —— 调用方紧接着 openSession 换上新实例。
export function evictChat(id: string) {
  const chat = app.chats.find((c) => c.id === id);
  if (!chat) return;
  killLive(chat);
  chat.running = false;
  const i = app.chats.indexOf(chat);
  if (i >= 0) app.chats.splice(i, 1);
}

// 撤销 / 找回之后服务端改了这个会话（转录末尾附了说明、内存态丢掉了）：丢本地缓存，正开着就重拉
export async function reloadChat(id: string): Promise<void> {
  const current = app.chat.id === id;
  evictChat(id);
  if (current) await openSession(id);
}

export async function removeSession(id: string) {
  try {
    await api.deleteSession(id);
    app.sessions = app.sessions.filter((s) => s.id !== id);
    const chat = app.chats.find((c) => c.id === id);
    if (chat) {
      killLive(chat);
      chat.running = false;
      const i = app.chats.indexOf(chat);
      if (i >= 0) app.chats.splice(i, 1);
      if (app.panes.includes(chat)) {
        // 分屏里的一格被删了：收起分屏，留下另一格（删的是有焦点的那格，焦点挪到另一格）
        const rest = paneLeft(app.panes, chat) ?? new Chat();
        app.panes = [];
        if (chat === app.chat) {
          foreground(rest);
          if (rest.id) rememberSession(rest.id);
          void syncConfigTo(rest);
        }
      } else if (chat === app.chat) foreground(new Chat());
    }
    try {
      if (localStorage.getItem(LAST_SESSION_KEY) === id) rememberSession(null);
    } catch { /* ignore */ }
  } catch (e: any) {
    toast(t("删除失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}
