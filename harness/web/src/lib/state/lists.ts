// 侧栏的会话与项目列表：拉取 / 加载更多、快照、项目改名 / 排序 / 置顶 / 隐藏 / 导入、引用会话。
import * as api from "../api.ts";
import { t, tr } from "../i18n.ts";
import { refreshFamily } from "../session-family.svelte.ts"; // 会话协作：台账随会话列表一起重拉
import { MAX_SESSION_REFS, sessionRefsFrom, withSessionRef } from "../session-refs.ts";
import type { SessionRefView } from "../timeline-types.ts";
import type { Chat, ProjectMeta, SessionMeta } from "./chat.svelte.ts";
import { app, toast } from "./core.svelte.ts";
import { patchGlobalConfig } from "./config.ts";
import { newChat } from "./pool.ts";

// 项目格右侧的新对话：先切全局 workspace，再开新会话视图。已有会话仍保留
// 自己快照里的 workspace；这里只决定接下来创建的新会话落在哪个项目。
export async function newChatInProject(project: ProjectMeta) {
  if (!project.exists) {
    toast(t("项目文件夹已不存在"));
    return;
  }
  const before = app.chat;
  const wasBlank = !before.running && !before.id && !before.timeline.length;
  try {
    await patchGlobalConfig({ workspace: project.path });
    // 等配置落地的这段时间里，用户已经在这张空白对话里发了消息 → 它就是那个新对话，别再把它挤到后台
    const startedMeanwhile = wasBlank && app.chat === before && (before.running || before.timeline.length > 0);
    if (!startedMeanwhile) newChat();
    app.drawer = false;
  } catch (e: any) {
    toast(t("切换项目失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}

// 「新建快照」= 服务端换一只全新的一次性桶（新 workspace → 新记忆作用域，
// 前尘不带），随即在里面开空对话。旧桶留盘不删，只是不再被列出。
export async function newQuickChat() {
  try {
    const p = (await api.newQuickChat()) as ProjectMeta;
    if (!p?.path) throw new Error(t("服务器未返回新的快照"));
    app.projects = [...app.projects.filter((x) => !x.quick), p];
    await newChatInProject(p);
  } catch (e: any) {
    // 老后端没有 /api/quick/new → 说人话
    toast(e?.status === 404 ? t("快照对话需要重启 harness 服务后可用") : t("新建快照失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
  }
}

// 「存为工作空间」（能力位 "quick-save"）：服务端把当前快照桶原地登记成普通项目（名字「快照会话 N」），
// 快照位换上新桶。桶路径不变，会话按 workspace 归组——那条对话自然从快照区落进项目列表，正开着的不用重开；
// 此后不再被「新建快照」顶掉。
export function canSaveQuick(): boolean {
  return Boolean(app.compat?.caps?.includes("quick-save"));
}
export async function saveQuickAsProject(): Promise<ProjectMeta | null> {
  const cur = app.projects.find((p) => p.quick);
  if (!cur) return null;
  try {
    const r = await api.saveQuickChat(cur.path, t("快照会话"));
    const p = r?.project as ProjectMeta | undefined;
    if (!p?.path) throw new Error(t("服务器未返回存好的工作空间"));
    const key = pathKey(p.path);
    const rest = app.projects.filter((x) => !x.quick && pathKey(x.path) !== key);
    app.projects = [p, ...rest, ...(r.quick?.path ? [r.quick as ProjectMeta] : [])];
    void refreshSessions();
    if (canReorderProjects()) void refreshProjects();
    toast(t("已存为工作空间「{name}」", { name: p.name }));
    return p;
  } catch (e: any) {
    toast(t("存为工作空间失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
    void refreshProjects();
    return null;
  }
}

// 项目改名（能力位 "project-rename"）：只改显示名，目录与会话都不动；留空 = 恢复成文件夹名。乐观上屏，失败退回。
export function canRenameProject(): boolean {
  return Boolean(app.compat?.caps?.includes("project-rename"));
}
export async function renameProject(project: ProjectMeta, name: string): Promise<boolean> {
  const key = pathKey(project.path);
  const prev = app.projects;
  const clean = name.trim();
  if (clean === project.name) return true;
  if (clean) app.projects = prev.map((p) => (pathKey(p.path) === key ? { ...p, name: clean } : p));
  try {
    const next = (await api.renameProject(project.path, clean)) as ProjectMeta;
    const rows = [...app.projects];
    const i = rows.findIndex((p) => pathKey(p.path) === key);
    if (i >= 0) rows[i] = next;
    else rows.push(next);   // 隐式项目第一次落库
    app.projects = rows;
    return true;
  } catch (e: any) {
    app.projects = prev;
    toast(t("改名失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
    return false;
  }
}

// ── 历史会话 ─────────────────────────────────────────────────────────────────
const SESSION_PAGE = 100;

export async function refreshSessions() {
  if (!app.features.sessions) return;
  app.sessionsLoading = true;
  try {
    const page = await api.listSessionsPage(0, SESSION_PAGE);
    void refreshFamily(); // 会话协作：侧栏挂子会话要的父子台账
    app.sessions = page.items as SessionMeta[];
    app.sessionsTotal = page.total;
    // total 未知（反代吃掉了头）时以「这一页装满了」当作可能还有。
    app.sessionsMore =
      page.total >= 0 ? page.items.length < page.total : page.items.length >= SESSION_PAGE;
  } catch { /* 列表失败不打扰 */ }
  app.sessionsLoading = false;
}

// 追加下一页（抽屉底部「加载更多」）。按 id 去重，避免与期间新建的会话重复。
export async function loadMoreSessions() {
  if (!app.features.sessions || app.sessionsLoading || !app.sessionsMore) return;
  app.sessionsLoading = true;
  try {
    const page = await api.listSessionsPage(app.sessions.length, SESSION_PAGE);
    const seen = new Set(app.sessions.map((s) => s.id));
    const fresh = (page.items as SessionMeta[]).filter((s) => !seen.has(s.id));
    app.sessions = [...app.sessions, ...fresh];
    app.sessionsTotal = page.total;
    app.sessionsMore =
      page.total >= 0 ? app.sessions.length < page.total : page.items.length >= SESSION_PAGE;
  } catch { /* 失败保持现状，用户可再点一次 */ }
  app.sessionsLoading = false;
}

export async function refreshProjects() {
  if (!app.features.projects) return;
  app.projectsLoading = true;
  try {
    app.projects = await api.listProjects();
  } catch { /* 列表失败不打扰 */ }
  app.projectsLoading = false;
}

// ── 引用会话（把会话块拖进输入框；服务端能力位 "session-refs"）──────────────────────────────────
export { MAX_SESSION_REFS, sessionRefsFrom };
export function canRefSessions(): boolean {
  return Boolean(app.compat?.caps?.includes("session-refs"));
}
// 拖进输入框：挂一个「引用」芯片。引用自己、重复的、超过上限的不挂（说一声）
export function addSessionRef(chat: Chat, ref: SessionRefView): boolean {
  const next = withSessionRef(chat.refs, ref, chat.id);
  if (next.note) toast(next.note);
  if (next.list === chat.refs) return false;
  chat.refs = next.list;
  return true;
}

// ── 侧栏项目块拖动排序（服务端能力位 "project-order"）──────────────────────────────────────
export function canReorderProjects(): boolean {
  return Boolean(app.compat?.caps?.includes("project-order"));
}
// zonePaths：拖完之后那一区（置顶区或非置顶区）的完整次序。先在本地按新次序排好（手指一松就到位），再落库；
// 落库失败按服务端的次序拉回来。
export async function reorderProjects(zonePaths: string[]): Promise<void> {
  const rank = new Map(zonePaths.map((p, i) => [pathKey(p), i]));
  const rows = [...app.projects];
  const slots = rows.map((p, i) => (rank.has(pathKey(p.path)) ? i : -1)).filter((i) => i >= 0);
  const moved = slots.map((i) => rows[i]).sort((a, b) => rank.get(pathKey(a.path))! - rank.get(pathKey(b.path))!);
  slots.forEach((slot, k) => (rows[slot] = moved[k]));
  app.projects = rows;
  try {
    await api.setProjectOrder(zonePaths);
    // 本区里有只在侧栏里补出来的隐式项目（列表里还没有它）：服务端这次顺手登记了，拉一次权威次序
    if (moved.length < zonePaths.length) void refreshProjects();
  } catch (e: any) {
    toast(t("排序没存上：{reason}", { reason: tr(String(e?.message ?? e)) }));
    void refreshProjects();
  }
}

// 宿主注入的「选一个文件夹当工作空间」。函数不是响应式数据，挂模块级即可；
// 是否可用由 app.hasHostPicker 供模板判断。
let hostPick: null | (() => Promise<string>) = null;
export function setHostPickWorkspace(fn: null | (() => Promise<string>)) {
  hostPick = fn;
  app.hasHostPicker = !!fn;
}
export function hostPickWorkspace() { return hostPick; }

export async function importProject(path: string) {
  const project = await api.importProject(path) as ProjectMeta;
  app.projects = [project, ...app.projects.filter((p) => p.id !== project.id)];
  app.projectModal = false;
  await newChatInProject(project);
  return project;
}

// 置顶 / 隐藏：服务端只改注册表（不动目录、不动会话），返回更新后的项目。
// 名单里的次序不在这里定 —— 侧栏统一按「置顶优先」排，隐式项目也吃得到。
export async function setProjectFlags(
  project: ProjectMeta,
  patch: { pinned?: boolean; hidden?: boolean },
): Promise<ProjectMeta | null> {
  const key = pathKey(project.path);
  try {
    const next = (await api.setProjectFlags(project.path, patch)) as ProjectMeta;
    // 原地替换：位置不变，重排（置顶优先）交给侧栏；隐式项目第一次落库才追加
    const rows = [...app.projects];
    const i = rows.findIndex((p) => pathKey(p.path) === key);
    if (i >= 0) rows[i] = next;
    else rows.push(next);
    app.projects = rows;
    // 置顶 / 取消置顶换了区：服务端按「拖出来的位次」排，新区里排到哪由它说了算——拉一次权威次序
    if (patch.pinned !== undefined && canReorderProjects()) void refreshProjects();
    return next;
  } catch (e: any) {
    // 老后端没有 /api/projects/flags → 报「重启服务」而不是光秃秃的 HTTP 404
    toast(
      e?.status === 404
        ? t("置顶/隐藏需要重启 harness 服务后可用")
        : t("操作失败：{reason}", { reason: tr(String(e?.message ?? e)) }),
    );
    return null;
  }
}

// 项目身份 = workspace 绝对路径（Windows 不分大小写）
export function pathKey(p: string) {
  return app.info?.platform === "win32" ? (p || "").toLowerCase() : p || "";
}
