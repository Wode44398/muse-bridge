// Claude 对话内核的对外入口。实现按职责拆在 ./chat/ 下，同步内核的设计说明见 ./chat/kernel.js 文件头；
// 各处照旧从这里取（名字与路径不变）。
import './chat/load-order.js';
export { chat } from './chat/store.svelte.js';
export { rememberCurrentPrefs } from './chat/prefs.js';
export { attImgFallback } from './chat/attachments.js';
export { pendingNew, dropPendingNew } from './chat/pending.svelte.js';
export { queueState, mcpState, queuedItems, limitResume, fetchLimitResume, setLimitAutoContinue, refreshQueue, removeQueued, moveQueued, clearQueued, promoteQueued, editQueued, editLastQueued, retractableSteers, retractSteer, retractLastSteer } from './chat/queue.svelte.js';
export { prefetchSessions } from './chat/history.js';
export { onSnapClosed, answerQuestion } from './chat/events.js';
export { requestSync, detachLive, openSession, send, prewarmNewChat, rewindToMessage, bgHoldNow, releaseBgHold, stop, newConversation, convertToProject, bumpLoadGen, loadSession, onBusEvent, steer, queueSend, mirrorActiveTurn, reconcileSession, restoreOnBoot } from './chat/kernel.js';
