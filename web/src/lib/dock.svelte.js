// 侧边工作区的状态入口：各 agent 分页的宿主实例与对外动作都从这里导出，实现在 ./dock/ 下——
//   host.svelte.js  状态工厂（开关卡片、排布、meta、agent 动静提示）
//   tools.js        共用工具登记表（新增一张，四个分页都有）
//   claude / codex / agy.svelte.js  各分页的宿主与专属卡
// 外壳是 components/dock/Workbench.svelte，共用面板在 components/dock/SharedPanel.svelte。
import { hostOf } from './dock/host.svelte.js';
import { claudeHost, claudeTools, claudeToolOk, snapMode } from './dock/claude.svelte.js';
import { codexHost } from './dock/codex.svelte.js';
import { agyHost } from './dock/agy.svelte.js';

export { hostOf, registerDockHost, createDockHost } from './dock/host.svelte.js';
export { readDockSse } from './dock/sse.js';
export { claudeHost, claudeTools, dockContext, openTaskDetail, backToTaskList, closeTaskDetail, forgetTaskTool, useSnapDock,
  browserMountedNow, noteBrowserMount, refreshBrowserMount } from './dock/claude.svelte.js';
export { codexHost, codexTools } from './dock/codex.svelte.js';
export { agyHost, agyTools, openAgyAgentsPanel, pushAgyAgentTranscript, popAgyAgentTranscript, clearAgyAgentStack } from './dock/agy.svelte.js';

// —— Claude ——
export const dock = claudeHost.state;
export const openDock = (view) => claudeHost.open(view);
export const closeDock = () => claudeHost.close();
export const closeDockView = (view) => claudeHost.closeView(view);
export const toggleDockView = (view) => claudeHost.toggleView(view);
export const setDockWs = (ws) => claudeHost.setWs(ws);
export const ensureDockMeta = () => claudeHost.ensureMeta();
export const openDockFiles = (target) => claudeHost.openFiles(target);
export const noteAgentBrowser = (url) => claudeHost.noteBrowser(url);
export const noteAgentTerm = () => claudeHost.noteTerm();
export const dockSnapMode = snapMode;
export const dockToolOk = claudeToolOk;
const claudeTool = (key) => claudeTools().find((x) => x.key === key);
export const dockToolLabel = (key) => claudeTool(key)?.label || '';
export const dockToolIcon = (key) => claudeTool(key)?.icon || '';

// —— Codex ——
export const codexDock = codexHost.state;
export const openCodexDock = (view) => codexHost.open(view);
export const closeCodexDock = () => codexHost.close();
export const setCodexDockWs = (ws) => codexHost.setWs(ws);
// 浏览器按会话各开一份：会话 id = Codex 的线程 id（还没有 id 的新对话 = ''，用工作空间共用那份）
export const setCodexDockSession = (sid) => { codexHost.state.sessionId = /^[A-Za-z0-9_-]{1,80}$/.test(sid || '') ? sid : ''; };
export const noteCodexAgentBrowser = (url) => codexHost.noteBrowser(url);

// —— Antigravity ——
export const agyDock = agyHost.state;
export const openAgyDock = (view) => agyHost.open(view);
export const closeAgyDock = () => agyHost.close();
export const setAgyDockWs = (ws) => agyHost.setWs(ws);
export const setAgyDockSession = (sid) => { agyHost.state.sessionId = sid || ''; };
export const openAgyDockFiles = (target) => agyHost.openFiles(target);
export const noteAgyAgentBrowser = (url) => agyHost.noteBrowser(url);
export const noteAgyAgentTerm = () => agyHost.noteTerm();

// 浏览器按会话各开一份：面板只拿到自己的 state，回头问宿主这一份该带哪个会话 id（'' = 工作空间共用那份）
export const browserSessionOf = (state) => hostOf(state)?.browserSession() || '';
