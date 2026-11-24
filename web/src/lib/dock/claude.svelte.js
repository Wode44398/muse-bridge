// Claude 分页的工作区宿主：共用工具 + 「任务」+ 插件的工作台标签；聊天快照页（/c/<token>）也用这一份。
import { session } from '../state.svelte.js';
import { api } from '../api.js';
import { t, tc } from '../i18n.js';
import { dockIcon } from '../dockIcons.js';
import { workbenchKeys } from '../pluginUi.svelte.js';
import { createDockHost } from './host.svelte.js';
import { buildTools, toolAllowed } from './tools.js';

// 两列的默认排布：终端 / 审阅 / 任务一列，浏览器 / 文件 / 记忆（要宽）另一列
const COL_A = ['term', 'review', 'tasks'];
const BUILTIN = [...COL_A, 'browser', 'files', 'memory'];

// snap = 聊天快照页：工作区只摆 审阅 / 文件 / 只读浏览器。快照的 ws 是服务端锁死的桶目录，前端并不知道
//   （也不该知道）真实路径——放一个占位串让 ws 相关的守卫照常工作，后端对快照身份一律忽略客户端传来的 ws。
// tasksFocus = 「任务」卡要定位的工具行 { tool, seq }；tasksAgent = 压在任务列表之上的子 agent 转录 { tool, wf }
export const claudeHost = createDockHost({
  id: 'claude',
  initialView: 'review',
  keys: () => [...BUILTIN, ...workbenchKeys('claude')],
  sortable: () => BUILTIN,
  colOf: (k) => (COL_A.includes(k) ? 'a' : 'b'),
  // 浏览器一个对话一份；快照页和还没发出第一条消息的新对话不带，退回整个工作空间共用那份
  session: () => (state.snap ? '' : session.id || ''),
  extra: { snap: false, tasksFocus: null, tasksAgent: null },
  caps: { filesRoot: 'identity', previewHost: 'dock', memoryAgent: 'claude' },
});
const state = claudeHost.state;

export const snapMode = () => state.snap || state.meta?.snap === true;
// 插件工作台页面拿到的当前上下文（SDK 的 bridge.context()）
export function dockContext() {
  return { sessionId: session.id || null, cwd: state.ws || null, agent: 'claude' };
}

// 完整工具表（不含门禁）：开关 / 手机标签按 任务、审阅、终端、浏览器、文件、记忆、插件 的顺序摆
const ORDER = ['tasks', 'review', 'term', 'browser', 'files', 'memory'];
export function claudeTools() {
  return buildTools({
    order: ORDER,
    over: {
      files: { label: tc('claude', '文件'), closeLabel: tc('claude', '关闭文件') },
      memory: { label: tc('claude', '记忆'), closeLabel: tc('claude', '关闭记忆') },
    },
    own: [
      // 任务 = 官方 Tasks 侧栏（只读数据，快照访客也给）
      { key: 'tasks', label: tc('claude', '任务'), closeLabel: tc('claude', '关闭任务'), icon: dockIcon('tasks'), col: 'a' },
    ],
    // 插件的工作台标签（ctx.ui.workbench）：buildTools 按宿主摆进来，内容由 SharedPanel 画；快照访客不给
    host: 'claude',
  });
}
export const claudeToolOk = (key) => {
  const x = claudeTools().find((y) => y.key === key);
  return !!x && toolAllowed(x, claudeHost, { snap: snapMode() });
};

// —— 「任务」卡（官方 Tasks 侧栏）——
// openTaskDetail(tool)：打开任务卡并定位到这条工具行（Workflow 卡 → 详细卡滚到可见；Agent 行 → 直接压上它的
// 子转录，官方点 Agent 行就是开转录）。opts.agent 传工作流里的一条 workflow_agent 记录时，压上的是那个 agent 的转录。
let taskSeq = 0;
export function openTaskDetail(tool, opts = {}) {
  if (!tool) return;
  state.tasksFocus = { tool, seq: ++taskSeq };
  const wantAgent = opts.agent !== undefined ? opts.agent : (tool.name === 'Agent' || tool.name === 'Task' ? null : undefined);
  state.tasksAgent = wantAgent === undefined ? null : { tool, wf: wantAgent };
  claudeHost.open('tasks');
}
export function backToTaskList() { state.tasksAgent = null; }
export function closeTaskDetail() { state.tasksFocus = null; state.tasksAgent = null; }
// 某条工具行从视图里被撤掉（对账整段替换 / 撤回）：别让面板盯着一个已不在列表里的旧对象
export function forgetTaskTool(tool) {
  if (state.tasksFocus && state.tasksFocus.tool === tool) state.tasksFocus = null;
  if (state.tasksAgent && state.tasksAgent.tool === tool) state.tasksAgent = null;
}

// 快照页挂载时调一次：标记快照模式 + 给 ws 一个占位（真实桶路径在服务端）
export function useSnapDock() {
  state.snap = true;
  claudeHost.setWs('snap');
}

// —— 浏览器挂载状态灯：这个对话的浏览器里有没有标签（工具开关上的绿灯只看它）——
// 来源三个：切会话 / 总线重连时拉一次 /browser/state；总线 browser.mount 事件；面板直播流的 tabs 事件。
const mountBySession = $state({});
export function browserMountedNow() {
  const id = claudeHost.browserSession();
  return !!(id && mountBySession[id]);
}
export function noteBrowserMount(sessionId, mounted) {
  if (!sessionId) return;
  if (mounted) mountBySession[sessionId] = true;
  else delete mountBySession[sessionId];
}
export async function refreshBrowserMount() {
  const id = claudeHost.browserSession();
  const ws = state.ws;
  if (!id || !ws) return;
  try {
    const r = await api.get(`/api/claude/browser/state?ws=${encodeURIComponent(ws)}&session=${encodeURIComponent(id)}`);
    noteBrowserMount(id, !!(r?.alive && Array.isArray(r.tabs) && r.tabs.length));
  } catch { /* 没有浏览器权限 / 离线：灯保持原样 */ }
}
// 切会话、切工作空间时拉一次（模块级 effect：顶栏 / 工具开关 / 工作区哪个先挂都行）
$effect.root(() => {
  $effect(() => {
    void session.id; void state.ws;
    if (state.snap) return;
    refreshBrowserMount();   // 没有浏览器权限的身份服务端回 403，静默忽略
  });
});
