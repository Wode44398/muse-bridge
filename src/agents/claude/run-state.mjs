// 一次 runClaudeChat（= 一个 CLI 进程的一生）里各段代码共用的状态。
//
// 一个进程通常只承载界面上的一轮；挂起接力、停放复用时会先后承载好几轮——gen 随之换新，
// 逐轮的记账在换轮的地方归零（handoff / warmTake），其余的跟着进程走。
// plan 是开跑前定下的启动方案，之后不再变；这里列的都是跑起来以后会变的。
// 初值要现算的字段（要用到 gen、send 这些）先空着，由 seatTurn / stageRun（lifecycle.mjs）按原来的先后填上。
export function createRun(plan) {
  const run = {
    plan,
    // 开跑时用启动方案里的；挂起接力 / 停放接管换成新请求带来的
    chatPrefs: plan.chatPrefs,
    limitReplay: plan.limitReplay,
    // 插件应用页面开的会话的归属：只在 init 帧打标时用（plugin-origin.mjs），由 runClaudeChat 从入参带进来
    pluginOrigin: undefined,
    abort: new AbortController(),
    // CLI 进程真正退干净（主循环 finally 走完）。硬停止先让界面收尾，进程在后台退，同会话重发据此等它。
    markExited: undefined,
    procExited: undefined,
    userStopped: false,   // 用户按了停止（硬停）：这一轮已发 interrupted 收尾，之后的一切输出都不再进缓冲
    settleGen: undefined,
    gen: undefined,
    announced: new WeakMap(),   // gen → 已播过的 sessionId
    prefsRecorded: false,
    turnOrigin: undefined,
    turnText: undefined,
    originRecorded: false,
    evTurns: new WeakMap(),   // gen → { t0, sid, tools: Set }
    send: undefined,
    showAccounts: undefined,
    onUpstreamSwitch: undefined,
    getGen: undefined,
    BG_SHELL_HOLD_MS: undefined,
    bgTasks: [],   // 最近一次电平信号的全量任务表
    bgInfo: new Map(),   // taskId → Stop hook 的富信息（type/status/description/command）
    holdStartedAt: 0,   // 悬停起点（封顶计时）
    heldResult: null,   // 悬停中暂存的 result（若 CLI 意外停机，以它定局兜底）
    doneEmitted: false,   // done 只发一次（正常定局 / 看门狗 / 兜底三路互斥）
    bgFinalized: false,   // 看门狗主动定局后，abort 引发的异常不再当错误上报
    phantomTimer: null,   // 幻影 result 之后的兜底定局计时器（见 result 分支）
    lastMsgAt: undefined,
    // 后台 shell 逐条封顶（09-23）：悬停中首次看见的时刻 + 到点已 stopTask 的名单。
    // 被掐的 shell 不再算存活——停不掉的僵尸（比如卡死的 chrome 探测）不许反过来钉住本轮。
    shellSeenAt: new Map(),
    cutShells: new Set(),
    streamBlocks: {},   // content-block index -> { type, name, json, shown, id }
    widgets: undefined,
    // 文件编辑工具的 tool_use id → 目标路径：tool_result 成功后才推 {type:'fs'} 事件
    //（写盘完成的时点），前端打开中的文档/预览据此自动跟盘刷新。
    fsPending: new Map(),
    prSniff: undefined,
    // 露出的工具行 tool_use id → content_block_start 时刻：tool_result 到达时算耗时，发 tool_done。
    toolStarts: new Map(),
    // 本轮任务 taskId → task_type（task_notification 帧不带类型；读 .output 前要知道是不是工作流）。
    taskTypes: new Map(),
    // 任务帧门禁（见 emitTaskEvent 头注）：mainTools = 本轮主线程露出过的 tool_use id（不随 tool_done 删）；
    // foreignTasks = 判定为子 agent 名下的 taskId，后续帧一律不转。
    taskGuard: { mainTools: new Set(), foreignTasks: new Set() },
    wfLive: undefined,
    ledger: undefined,   // 只记主线程；计数随 send 递增，帧到达时记区间
    hookLevel: null,   // ultracode 轮 Stop hook 回报的档位，等 settleEffort 定局
    turnOut: 0,
    turnThink: 0,   // running output / thinking token totals for the live thinking-status bar
    lastMainUsage: null,   // usage of the MAIN conversation's last API call (for real context fill)
    liveCtxUsed: 0,   // 上次发出的轮中实时填充（去重）
    costMeter: undefined,
    // CLI 认证失败时不走 API：发一条合成的 assistant（model:"<synthetic>"、error:'authentication_failed'，
    // 文字是「Not logged in · Please run /login」），result 却不标 is_error——记下来，定局时改发错误卡。
    authFailed: false,
    // 本轮被额度拒绝的那一帧 rate_limit_info（status:'rejected'）——号池智能路由据此给该号记冷却并换号。
    turnRejection: null,
    // 撞限额时 CLI 不走流式、直接写一条合成回答（model:"<synthetic>"、error:'rate_limit'，文字「You've hit your
    // session limit · resets 3pm (…)」，jsonl 里另带 apiErrorParams.rate_limit_info）。记下来，定局时改发限额卡。
    limitFrame: null,   // { text, info }
    // 上下文压缩：compactAwait = 刚过去的边界 uuid，等紧随其后那条带摘要的 user 帧；
    // compactSeen = 本轮压缩过——手动 /compact 的 result 是零轮次空壳，不能当幻影 result 扣住。
    compactAwait: '',
    compactSeen: false,
    compactCmd: undefined,
    heartbeat: undefined,
    bgWatch: undefined,
    // 挂起接力（见 gen.handoff）：接力来的用户消息 uuid → 等它的 result（user_message_uuids 带回）。
    // 在它答完之前出的 result（CLI 先跑了一轮后台任务完成通知之类）只是中间态，暂存不定局。
    awaitingUser: new Set(),
    // 插话进来的消息 uuid（见 gen.steer）——command_lifecycle 帧据此转成前端的 steer_state。
    steerUuids: new Set(),
    // 用户本人插的话：uuid → { message, attachments, files, read }。撤回时把原文与附件路径交还给输入栏；
    // CLI 报 started（已读进这一轮）后 read=true，从此不可撤回。跨会话 / PR 自动修复的插话不登记。
    steerItems: new Map(),
    interimResult: null,
    runModel: undefined,   // 这个 CLI 进程眼下的模型（接力时用户换了模型 → setModel）
    runPermMode: undefined,   // 这个 CLI 进程眼下的权限模式（init / status 帧实况、会话中切换）
    planFrom: null,             // Claude 自己进计划模式之前的权限模式（用户选的计划模式 = null），见 notePermMode
    askedPermMode: undefined,   // 眼下这一轮要的模式（停放复用 / 接力换成新请求的）——init 帧据此认 CLI 降级
    permGate: null,   // 逐次审批 / 计划审批闸门（runtime/permissions.mjs），query 前建
    unbindMode: null,   // 会话中切模式的控制口登记（拿到会话 id 时登记，进程退出注销）
    interruptTimer: null,   // 软停止（interruptTurn）的兜底：CLI 迟迟不回 result 就整个停
    softStopping: false,   // 软停止已发出、等被打断那一轮的 result
    turnClosed: false,
    warmEntry: null,   // 本进程眼下的停放登记（finally 里等 SDK 收完子进程再放行等它的人）
    finHurry: null,
    qHandle: null,   // finally 里收尾用：query() 没建出来就出错时它还是 null（建好后与 q 是同一个对象）
    offLive: null,
    liveSid: '',   // 连接器授权借用的活 CLI 登记（进程收掉时撤）
    iterDone: false,   // 读循环读到流尾（CLI 自己退了）；见 readNext
    peerAware: undefined,
    peerGate: null,
    peerSeen: new Set(),   // 正在跑的轮里认过的 command_uuid
    offFastFallback: undefined,
    q: undefined,
    handoffSwitching: false,
    withdrawing: null,
    pendingNext: null,
    earlyMsgs: [],   // 预热停放期 CLI 先吐出来的帧（第一条消息之前），接管后按序先读
  };
  run.procExited = new Promise((r) => { run.markExited = r; });
  return run;
}
