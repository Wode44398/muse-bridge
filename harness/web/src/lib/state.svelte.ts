// 全局状态（Svelte 5 runes store）+ 所有动作。组件只读状态、调动作，不直接碰 API。
//
// dimensio 版：单一工作页，无 launcher / 厂商整页层。厂商切换 = 页内浮层
// （app.vendorMenu），只换 provider 与身份标识，视觉不换装。
//
// ── 多会话并发架构（2026-07-19）────────────────────────────────────────────
// 服务端的 run 本来就是 per-session 后台 job（sessions Map，各自 running/
// runLog/watchers，互不干扰）；单会话限制纯粹是前端单例造成的。现在把
// 「每会话的直播状态」收进 Chat 实例：时间线、流式游标、SSE 连接、断线
// 对账循环全部 per-chat。app.chat = 前台正在看的那个；app.chats = 活跃池
// （含前台 + 后台运行中 + 终态 LRU 缓存）。切换会话 = 换指针，后台会话的
// 连接与恢复循环继续自转 —— 模型思考时可以自由切走、再开一个并行任务。
//
// 实现按职责分在 ./state/ 下，这个文件只做门面：别处一律从这里 import。
// 下面这串裸 import 让这些依赖先于 ./state/ 下的模块求值；再往下各模块的转出顺序决定它们的求值顺序，
// 也就决定了顶层副作用（建 app、挂监听、起定时器、挂 __hx）的先后——有两条监听挂在同一个事件上，先后决定谁先跑。
import "./breakpoints.ts";
import "./api.ts";
import "./i18n.ts";
import "svelte";
import "./theme.ts";
import "./brand-logos.svelte.ts";
import "./motion.ts";
import "./touch.ts";
import "./stream-turn.ts";
import "./timeline-merge.ts";
import "./card-receipts.ts";
import "./page-streams.ts";
import "./timeline-reducer.ts";
import "./workspace-collab.svelte.ts";
import "./notify-policy.ts";
import "./protocol.ts";
import "./open-artifact.ts";
import "./pr-text.ts";
import "./task-notice.ts";
import "./session-family.svelte.ts";
import "./session-refs.ts";
import "./split.ts";

// ── 时间线条目（类型在 timeline-types.ts，这里照旧导出）──────────────────────────────────────
export type { AgentRun, AgentStep, ArtifactItem, AskItem, AskOption, AskQuestion, AttachmentItem, GoalView, Item, PermissionItem, PlanItem, ToolItem, WorkflowRun } from "./timeline-types.ts";
export { type SessionMeta, type ProjectMeta, Chat } from "./state/chat.svelte.ts";
export { type DockTool, app, vendorId, backgroundRunning, paneVisible, chatRunning, pulseGrid, toast } from "./state/core.svelte.ts";
export { browserToolAvailable, openDock, closeDock, toggleDock, setDockTool, openDockFiles, openTaskDetail, openTaskAgent, backToTaskList, handleDockShortcut, dockShowing, noteDockFocus, closeDockCard, toggleDockCard, toggleDockMax, setDockCols, setDockWeights } from "./state/dock.ts";
export { dockCards, dockMulti } from "./state/dock-cards.svelte.ts";
import "./state/effects.ts";
// prefs 排在 boot 前面：boot 顺着依赖会把 resync 拉起来，prefs 的监听要先挂
export { setFeedDetail, setHostOpenSettings, openSettings, setAppearance, toggleAppearance } from "./state/prefs.ts";
export { boot, reloadMeta } from "./state/boot.ts";
export { sessHooks } from "./state/global-events.ts";
export { type CardReply, decidePermission, decidePlan, answerAsk } from "./state/cards.ts";
export { send, stop, steerTrayActions, withdrawPendingSteer, interruptWithPendingSteer } from "./state/run.ts";
export { newChat, openSession, focusPane, openInSplit, closePane, evictChat, reloadChat, removeSession } from "./state/pool.ts";
export { newChatInProject, newQuickChat, canSaveQuick, saveQuickAsProject, canRenameProject, renameProject, refreshSessions, loadMoreSessions, refreshProjects, canRefSessions, addSessionRef, canReorderProjects, reorderProjects, setHostPickWorkspace, hostPickWorkspace, importProject, setProjectFlags, pathKey, MAX_SESSION_REFS, sessionRefsFrom } from "./state/lists.ts";
export { diagnosticsAvailable, exportDiagnostics, rewindAvailable, usageLedgerAvailable, projectModeAvailable, setChatShape, globalMemoryAvailable, memoryOverviewAvailable, memoryDreamAvailable, openMemory, sessionReviewAvailable, rewindFrom } from "./state/extras.ts";
export { switchVendor, vendorSwitchNote, setModel, setEffort, setFast, modelSupportsFast, type RunPermissionMode, permissionMode, setPermissionMode, type AccessMode, accessMode, readRoots, dropReadRoot, setAccessMode, awayMode, setAwayMode, saveConfig, providerModels, findModel, modelEfforts, modelsOf } from "./state/config.ts";
export { type VendorView, isCustomVendor, vendorInfo, hostBuiltins, customVendors, vendorChoices, type ModelHubTarget, type ModelHubHost, setModelHubHost, hasHostModelHub, openHostModelHub } from "./state/vendors.ts";
import "./state/record.ts";
export { suspendLiveStreams, resumeRunningSessions } from "./state/resync.ts";
export { hygieneAvailable, cacheExpiryMode, cacheColdMinutes, compactNow, handoffWithSummary, handoffPlan } from "./state/hygiene.ts";
export { commandsAvailable, slashCommands, loadCommands, builtinBlocked, runBuiltin, goalAvailable, toggleGoalDraft, goalControl } from "./state/commands.svelte.ts";
import "./state/debug.ts";
