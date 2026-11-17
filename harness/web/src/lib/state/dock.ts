// 工作区 Dock 的开关、工具切换、定位与快捷键。
import { app, DOCK_TOOL_KEY, flags, type DockTool } from "./core.svelte.ts";
import { dockCards, dockMulti, saveDockCards } from "./dock-cards.svelte.ts";
import { normCols, type Cols, type Weights } from "../dock-cards.ts";

// ── Dock 动作 ────────────────────────────────────────────────────────────────

// D5：服务端注册了浏览器工具吗（/api/info 的 tools 里有 Browser）。这台机器上本机浏览器、桌面壳的浏览器宿主、经扩展连着的
// 用户浏览器一个都没有时没有——工作区不摆「浏览器」、快捷键与预览胶囊也不开它。info 还没到时按有算（不闪）。
export function browserToolAvailable(): boolean {
  const tools = app.info?.tools;
  return !Array.isArray(tools) || tools.includes("Browser");
}
// 宽屏是一叠卡片：open / set 某工具 = 没开就加一张、开着就聚焦它；
// app.dockTool 一直是「最近聚焦的那张」——手机一次一张只认它，视图上报也报它。
export function openDock(tool?: DockTool) {
  if (tool === "browser" && !browserToolAvailable()) return;
  if (tool) setDockTool(tool);
  else if (dockMulti() && !dockCards.open.length) {
    dockCards.open = [app.dockTool];
    saveDockCards();
  }
  app.dockOpen = true;
  flags.browserAutoMuted = false;
}
export function closeDock() {
  if (app.chats.some((c) => c.running)) flags.browserAutoMuted = true;
  app.dockOpen = false;
  app.tasksFocus = null;
  app.tasksAgent = null;
  // 关掉就清定位：下次打开是干净的工作空间视图，不会莫名跳回上次那个产物目录
  //（同一次打开内切工具再切回来则保留，算连续浏览）。
  app.filesTarget = null;
  dockCards.max = "";
}
export function toggleDock() {
  // 关的那一支走 closeDock：清掉任务定位 / 文件定位，免得下次打开落回上次那个产物目录
  if (app.dockOpen) closeDock();
  else openDock();
}
function remember(tool: DockTool) {
  app.dockTool = tool;
  try {
    localStorage.setItem(DOCK_TOOL_KEY, tool);
  } catch { /* ignore */ }
}
let focusSeq = 0;
export function setDockTool(tool: DockTool) {
  const was = app.dockTool;
  remember(tool);
  if (!dockMulti()) return;
  if (dockCards.max && dockCards.max !== tool) dockCards.max = "";
  if (!dockCards.open.includes(tool)) {
    dockCards.open = [...dockCards.open, tool];
    saveDockCards();
  } else if (app.dockOpen && was !== tool) {
    // 已经开着、但不是刚才看的那张：闪一下告诉你在哪（同一张反复点名——预览每动一次——不闪）
    dockCards.focus = { tool, seq: ++focusSeq };
  }
}
// 用户在某张卡里点了一下：它就是「最近聚焦的那张」（不闪）
export function noteDockFocus(tool: DockTool) {
  if (app.dockTool !== tool && dockCards.open.includes(tool)) remember(tool);
}
// 这张卡此刻摆在眼前吗（在跑小点只在没看着它时挂、视图上报）
export function dockShowing(tool: DockTool): boolean {
  if (!app.dockOpen) return false;
  return dockMulti() ? dockCards.open.includes(tool) && (!dockCards.max || dockCards.max === tool) : app.dockTool === tool;
}
// 关一张卡；关到最后一张 = 收起工作区（卡片表留着最后那张，下次展开还是它）
export function closeDockCard(tool: DockTool) {
  if (!dockMulti()) {
    if (app.dockTool === tool) closeDock();
    return;
  }
  const rest = dockCards.open.filter((x) => x !== tool);
  if (rest.length === dockCards.open.length) return;
  if (dockCards.max === tool) dockCards.max = "";
  if (tool === "tasks") {
    app.tasksFocus = null;
    app.tasksAgent = null;
  }
  if (tool === "files") app.filesTarget = null;
  if (!rest.length) {
    closeDock();
    return;
  }
  dockCards.open = rest;
  saveDockCards();
  if (app.dockTool === tool) remember(rest[rest.length - 1]);
}
// 工具开关与快捷键：开着就关那张，没开就开
export function toggleDockCard(tool: DockTool) {
  if (dockShowing(tool)) closeDockCard(tool);
  else openDock(tool);
}
export function toggleDockMax(tool: DockTool) {
  dockCards.max = dockCards.max === tool ? "" : tool;
  if (dockCards.max) remember(tool);
}
export function setDockCols(cols: Cols) {
  dockCards.cols = normCols(cols);
  saveDockCards();
}
export function setDockWeights(w: Weights) {
  dockCards.weights = w;
  saveDockCards();
}

// 在工作台「文件」视图里打开工作空间的某个位置：产物卡点开走这里（对齐 bridge
// Claude 分页的 openDockFiles）。rel = 工作空间内的相对目录，open = 落地后自动
// 弹出面板内预览的文件名。
let filesSeq = 0;
export function openDockFiles(target: { rel?: string; open?: string } = {}) {
  app.filesTarget = { seq: ++filesSeq, rel: target.rel ?? "", open: target.open ?? "" };
  openDock("files");
}

// 在工作台「任务」视图里定位一条 Agent / Workflow 工具行；给 agentId 就直接压上那个子 agent 的
// 转录视图（Agent 行 / 工作流详情里的 agent 表行）。
let taskSeq = 0;
export function openTaskDetail(toolId: string, agentId?: string) {
  app.tasksFocus = { toolId, seq: ++taskSeq };
  app.tasksAgent = agentId ? { toolId, agentId } : null;
  openDock("tasks");
}
export function openTaskAgent(toolId: string, agentId: string) {
  app.tasksAgent = { toolId, agentId };
}
export function backToTaskList() {
  app.tasksAgent = null;
}

// Dock 快捷键：Ctrl+Shift+G 审阅 / Ctrl+` 终端 / Ctrl+Shift+B 浏览器 / Ctrl+Shift+E 文件；同键再按 = 关那张卡（手机上 = 关 Dock）。
// 避开浏览器保留键（Ctrl+T/W/N 之类拦不了，不用）。只在 dimensio 挂着时由 App 的 window keydown 调用——
// 以前是模块顶层监听，bridge 静态 import 本模块，结果 bridge 的每个分页都吞掉了这四个组合键。
const DOCK_KEYS: { tool: DockTool; match: (e: KeyboardEvent) => boolean }[] = [
  { tool: "review", match: (e) => e.ctrlKey && e.shiftKey && e.code === "KeyG" },
  { tool: "term", match: (e) => e.ctrlKey && !e.shiftKey && e.code === "Backquote" },
  { tool: "browser", match: (e) => e.ctrlKey && e.shiftKey && e.code === "KeyB" },
  { tool: "files", match: (e) => e.ctrlKey && e.shiftKey && e.code === "KeyE" },
];
export function handleDockShortcut(e: KeyboardEvent): boolean {
  for (const k of DOCK_KEYS) {
    if (!k.match(e)) continue;
    if (k.tool === "browser" && !browserToolAvailable()) return false;
    e.preventDefault();
    toggleDockCard(k.tool);
    return true;
  }
  return false;
}
