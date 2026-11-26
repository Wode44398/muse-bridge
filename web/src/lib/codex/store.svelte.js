// Codex 分页的数据入口（只做导出与编排）：实现分在 store/ 下——
//   state      状态与线程缓存（codex、current、leadOf …）
//   sessions   列表、打开旧线程、新线程、项目、线程操作
//   run        发送、按帧放字、停止、插话、稍后发送、审批作答、重连
//   catalog    模型目录、选择、权限档、号池、额度、设置
// 一轮的视图模型与事件归约在 turns.js（纯函数，有单测）。

export { codex, NEW, current, threadOf, lastTurn, leadOf, projectOf, sessionMeta } from './store/state.svelte.js';
export {
  refreshSessions, selectProject, createProjectAt, newThread, openThread, loadThread, loadOlder, goHistory,
  renameThread, archiveThread, deleteThread, forkThread, compactThread, ctxOf, errText,
} from './store/sessions.svelte.js';
export {
  send, stop, steer, isRunning, enqueue, loadQueue, updateQueued, removeQueued, reorderQueue, answerAsk,
  resumeAll, watchBus, stopAll,
} from './store/run.svelte.js';
export {
  EFFORT_LABEL, EFFORT_ORDER, effortLabel, modelGroups, findModel, clampEffort, selectModel, loadModels,
  PERMS, allowedPerms, defaultPerm, permOf, loadSettings, loadPool, activeAccount, loadUsage, switchAccount, isAdmin,
} from './store/catalog.svelte.js';

import { codex } from './store/state.svelte.js';
import { refreshSessions } from './store/sessions.svelte.js';
import { resumeAll, watchBus } from './store/run.svelte.js';
import { loadModels, loadSettings, loadPool, loadUsage } from './store/catalog.svelte.js';
import { loadCodexFonts } from './assets.js';
import { registerNoticeAgent } from '../notices.svelte.js';
import { ui } from '../state.svelte.js';

let bootP = null;
/** 进页（或预挂载）时调一次：列表、目录、号池、额度、设置并行拉，接上在跑的轮，听总线。 */
export function bootCodex() {
  bootP ||= (async () => {
    loadCodexFonts();
    watchBus();
    // 通知：人是不是正看着某条 Codex 线程，由这一页自己答（lib/notices.svelte.js）
    registerNoticeAgent('codex', { watching: (sid) => ui.screen === 'chatgpt' && codex.sessionId === sid });
    await Promise.all([refreshSessions(), loadModels(), loadSettings(), loadPool().then(() => loadUsage())]);
    codex.booted = true;
    resumeAll();
  })();
  return bootP;
}

/** 从设置回来（那边可能切了号、恢复了归档、改了默认档）：重拉一遍。 */
export function refreshAll() {
  return Promise.all([refreshSessions(), loadModels(), loadSettings(), loadPool().then(() => loadUsage())]);
}
