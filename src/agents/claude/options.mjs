import { randomBytes } from 'node:crypto';
import { busPublish } from '../../runtime/bus.mjs';
import { normalizeEffortLevel, applyEffort } from '../../runtime/ctx-usage.mjs';
import { pendingFor, sessionQuestions, waitForAnswer, questionTimeoutMs, sdkAnswerInput, formatAnswer } from '../../runtime/questions.mjs';
import { UPLOADS, MEDIA } from '../../config/index.mjs';
import { sessionPaths } from '../../runtime/paths.mjs';
import { TOOL_DEFAULT_ENV } from '../../runtime/claude-account.mjs';
// Claude Code 可执行文件在哪（源码直跑 = SDK 自带、不传；安装包首启下到数据根 / 本机已装的 → 传路径），见 runtime/claude-cli.mjs
import { claudeCliOptions } from '../../runtime/claude-cli.mjs';
import { moduleClaudeMcp } from '../../modules/registry.mjs';
import { makeSnapshotMcp } from '../../mcp/snapshot.mjs';
import { makePhoneMcp } from '../../mcp/phone-tools.mjs';
import { makePhoneControlMcp, phoneOperatorAgent } from '../../mcp/phone-control-tools.mjs';
import { makeBrowserMcp } from '../../mcp/browser-tools.mjs';
import { makeDeviceMcp } from '../../mcp/device-tools.mjs';
import { makeTerminalMcp } from '../../mcp/terminal-tools.mjs';
import { scopeOf, poolRef } from '../../runtime/principal.mjs';
import { makeWorkspaceMcp } from '../../mcp/workspace-tools.mjs';
import { makeSessionsMcp } from '../../mcp/session-tools.mjs';
import { stripCoordinatorEnv, coordinatorEnv } from '../../runtime/project-mode.mjs';
import { makeProjectMcp } from '../../mcp/project-tools.mjs';
import { makeCoordinatorShellHook } from '../../runtime/readonly-shell.mjs';
import { makeKillGuardHook } from '../../runtime/kill-guard.mjs';
import { makeBridgeMcp } from '../../mcp/bridge-tools.mjs';
import { peerEngineEnv } from '../../runtime/session-peers.mjs';
// 对话内嵌交互图表（官方 visualize：read_me + show_widget）：MCP、提示、直播增量帧都在这个模块里
import { makeVisualizeMcp, VIZ_ALLOWED_TOOLS } from '../../mcp/visualize.mjs';
import { sharedExtensionDirs } from '../../extensions.mjs';
import { memberSkillRootIfAny } from '../../member-skills.mjs';
import { pendingRewindAnchor } from '../claude-rewind.mjs';
import { deviceLinkFor, setDeviceLink } from '../../runtime/chat-prefs.mjs';
import { mergeHooks } from '../../plugins/claude-tools.mjs';
import { makePrMcp } from '../../mcp/pr-tools.mjs';
import { CHROME_MCP_NAME, chromeEngineEnv } from './chrome.mjs';
import { makeSandboxPreToolUse, SHELL_DENY } from './sandbox.mjs';
import { lastRealUserUuid } from './transcript.mjs';
import { makeFsEchoHook, makePushHook } from './hooks.mjs';
import { makeRefusalDialog } from './permission.mjs';

// 交给 SDK query 的启动参数。engineEnv / effortOpts / pauseOnFlag / sdkSettings 在启动方案里就算好了（同时进 warmSig）。
export function buildQueryOptions(run) {
  const { sessionId, ctx, family, snap, pOpts, custom, sessionsOn, projectShape, ownLink, inProject, bridgeOn, vizOn, vizPf, ownSid, turnPerm, allowSkip, wantSuggest, wantUltracode, phoneFsOn, phoneControlOn, browserOn, termOn, wsToolsOn, turnLink, deviceOn, chromeOn, chromeSplit, ext, prOn, effModel, plug, projPolicy, appendText, engineEnv, effortOpts, pauseOnFlag, sdkSettings, coordTools } = run.plan;
  return {
    // Claude Code 可执行文件：SDK 自带的不传；还没就绪（首启下载中 / 失败）抛人话错误，下面 catch 成错误卡片
    ...claudeCliOptions(),
    cwd: ctx.cwd,
    // Sandboxed users: no dirs beyond their own cwd, and no agy/media MCP yet
    // (per-user media routing lands in the storage pass). admin: host as before.
    // 例外：注册用户可以只读管理员「全服统一」加装的扩展目录（技能正文与脚本）。
    additionalDirectories: ctx.sandbox ? (ctx.kind === 'user' && !snap ? [...sharedExtensionDirs(), ...[memberSkillRootIfAny(ctx.user)].filter(Boolean)] : []) : [UPLOADS, MEDIA, ...(pOpts ? pOpts.additionalDirectories : [])],
    // Sandboxed users get their OWN media MCP (artifacts -> their .bridge/media,
    // gen_media streamed to their gen); no agy. admin keeps antigravity + media.
    // 档 2 手机文件桥（PHONE_FS 开关，默认关）：命令下发到本 caller 的活跃 gen，
    // 即「谁在对话、就操作谁的手机」，admin 与 user 都按各自 key 隔离。
    mcpServers: {
      // 快照：只有 close_snapshot 一个工具——不给媒体生成（Vertex 花钱，不对匿名访客开放）、
      // 不给 agy、不给手机。沙箱用户/admin 维持原样。
      // 功能扩展的工具（Vertex 的 media、agy 的 antigravity）按身份与开关由扩展自己决定给不给。
      ...(snap ? { snapshot: makeSnapshotMcp({ getGen: run.getGen, token: snap.token }) } : moduleClaudeMcp(ctx, { getGen: run.getGen })),
      ...(phoneFsOn ? { phone: makePhoneMcp({ genKey: ctx.key, getGen: run.getGen }) } : {}),
      // 手机操控（PHONE_CONTROL 开关，默认关）：命令经独立长轮询下发到本 caller 的手机
      // 前台服务（不搭 SSE 流）。注入条件见上 phoneControlOn；手机离线时工具自身回「未连接」。
      // 默认操作「这条消息发自」的那台手机（同账号多台开着操控时）：每次调用现取，接力 / 插话换了手机也跟着换。
      ...(phoneControlOn ? { phoneControl: makePhoneControlMcp({ genKey: ctx.key, getGen: run.getGen, originDevice: () => (run.turnOrigin && run.turnOrigin.kind === 'phone' && run.turnOrigin.id) || undefined, owner: () => run.getGen()?.sessionId || ownSid || undefined }) } : {}),
      // 浏览器手眼（右侧工作台同款实例）：按对话隔离的 headless CDP 浏览器（getSession 兜底：gen 还没拿到会话 id 时用续聊的 id）。
      // upload 的取文件范围：沙箱身份只准其私有目录/媒体目录/文件根；admin 不限（本就有全盘 shell）。
      // 终端池按（属主, 工作空间）键控、浏览器池再细到会话（principal.poolRef，开源路线 C6），与右侧面板同一把键。
      ...(browserOn ? { browser: makeBrowserMcp({ getGen: run.getGen, getSession: () => ownSid || '', ws: ctx.cwd, owner: scopeOf(ctx), snap: !!snap, roots: ctx.sandbox ? [ctx.cwd, ctx.media, ctx.homeRoot].filter(Boolean) : null }) } : {}),
      // 共享终端（右侧「终端」面板同一 PTY）+ 工作区协同（视图感知/预览下发/截图/草稿）。
      ...(termOn ? { terminal: makeTerminalMcp({ getGen: run.getGen, ws: poolRef(ctx, ctx.cwd) }) } : {}),
      ...(wsToolsOn ? { workspace: makeWorkspaceMcp({ getGen: run.getGen, ws: ctx.cwd, ctxKey: ctx.key }) } : {}),
      // bridge 本身：项目手册 + 操作（与外部 agent 的 /agent/v1 同一张操作表；身份就是这一轮的身份）。
      ...(bridgeOn ? { bridge: makeBridgeMcp({ ctx, getGen: run.getGen }) } : {}),
      // 会话协作：派生子会话 / 会话间互发消息（session-family.mjs）。快照访客不给。
      // 项目对话里档位按项目设置（默认直接开），讨论串默认各开 worktree、汇报唤醒的轮也能接着派（见 makeSessionsMcp 的 project）
      ...(sessionsOn ? { sessions: makeSessionsMcp({ getGen: run.getGen, ctx, lastUserUuidFor: (sid) => { const sp = sessionPaths(sid, ctx.cwd, ctx.configDir); return sp ? lastRealUserUuid(sp.file) : null; }, ...(projPolicy ? { project: { policy: projPolicy } } : {}) }) } : {}),
      // 项目记忆（mcp/project-tools.mjs）：协调者记在自己名下，讨论串读写它父会话（项目对话）那一份
      ...(projectShape || inProject ? { project: makeProjectMcp({ ctx, projectId: () => (inProject ? ownLink.parent : (run.getGen()?.sessionId || ownSid)) }) } : {}),
      // 拉取请求：状态 / 绑定 / 自动修复与自动合并开关 / 同步基线分支（pr-tools.mjs，主机本人才有）。
      ...(prOn ? { pr: makePrMcp({ getGen: run.getGen, ctx }) } : {}),
      // 内嵌交互图表（read_me + show_widget）：platform 按发起端（手机 App / 窄屏网页 → mobile，约 380px 宽）
      ...(vizOn ? { visualize: makeVisualizeMcp({ platform: vizPf }) } : {}),
      // 用户的电脑：目标设备每次调用现读会话连接（芯片改了不用冷起），设备侧按档位硬拦。
      ...(deviceOn ? { device: makeDeviceMcp({
        ctx,
        getLink: () => { const sid = run.getGen()?.sessionId || ownSid; return (sid && deviceLinkFor(ctx, sid)) || turnLink; },
        setLink: (v) => { const sid = run.getGen()?.sessionId || ownSid; if (sid) setDeviceLink(ctx, sid, v); },
        getSession: () => run.getGen()?.sessionId || ownSid || '',
        getOrigin: () => run.turnOrigin,
      }) } : {}),
      // 主机管理员的 Edge（拆分模式，见 chromeSplitServer）。
      ...(chromeSplit ? { [CHROME_MCP_NAME]: chromeSplit } : {}),
      // 插件给的工具（每个插件一个进程内 MCP server，键名 = 插件 id，见 plugins/claude-tools.mjs）。
      ...plug.mcpServers,
      // 扩展中心连接器（外部 MCP server，stdio/http/sse）。键名已在注册侧避让内置保留名。
      ...ext.mcpServers,
    },
    // 扩展中心：聚合技能 plugin + 用户装的 Claude Code 插件。
    ...(ext.plugins.length ? { plugins: ext.plugins } : {}),
    // 内嵌图表两件工具免过 auto 模式分类器（纯展示，见 VIZ_ALLOWED_TOOLS 注释）
    // 插件声明 access:'read' 的工具同理（只读，不弹审批卡）
    ...(vizOn || plug.allowedTools.length ? { allowedTools: [...(vizOn ? VIZ_ALLOWED_TOOLS : []), ...plug.allowedTools] } : {}),
    // 手机操作员子 agent：多步手机任务在它自己的上下文里跑，满屏截图不堆进主对话（与主线程共用同一个
    // phoneControl MCP 实例，所以本轮锁定的设备也共享）。只在注入了手机操控时挂。
    ...(phoneControlOn ? { agents: { 'phone-operator': phoneOperatorAgent() } } : {}),
    // append 的拼法见开头 appendText。
    // snapshot:false —— SDK 0.3.267 起 system prompt 默认「首轮录制、之后原样复用」，同一会话里后续
    // 轮次换 append 一律无视（09-22 探针：第二轮仍答第一轮的口令）。bridge 的 append 是逐轮拼的
    //（切模型后的身份、手机/浏览器能力按发起端注入、playbook 按本条消息匹配），必须每轮现渲染。
    systemPrompt: { type: 'preset', preset: 'claude_code', snapshot: false, append: appendText },
    // MCP 长调用（媒体生成/agy 委托/手机操控/共享终端）必须同步等结果——SDK 2.1.212 起
    // 默认超 2 分钟自动转后台，会破坏「模型等产物再回看质检」的语义，显式关掉（设 24h）。
    // 项目对话：协调者开关 + 补回工具的白名单（runtime/project-mode.mjs）；普通会话剥掉，别从服务进程的环境里漏进去
    env: { ...TOOL_DEFAULT_ENV, ...stripCoordinatorEnv(chromeOn && !chromeSplit ? chromeEngineEnv(engineEnv || process.env) : (engineEnv || process.env)), CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS: '86400000', ...peerEngineEnv(ctx, snap), ...(pOpts ? pOpts.env : {}), ...(coordTools ? coordinatorEnv(coordTools) : {}) },
    // 插件给的子 agent 定义（ctx.claude.options 的 agents）
    // 和内置的子 agent（手机操作员）合并，别整个盖掉；同名时内置的优先
    ...(pOpts && Object.keys(pOpts.agents).length ? { agents: { ...pOpts.agents, ...(phoneControlOn ? { 'phone-operator': phoneOperatorAgent() } : {}) } } : {}),
    // Claude in Chrome 两个方向都显式给：admin 带 --chrome 点亮；其余身份带 --no-chrome——
    // ~/.claude.json 里桌面 app 存着 claudeInChromeDefaultEnabled:true，不能指望默认值替我们关门。
    extraArgs: chromeOn && !chromeSplit ? { chrome: null } : { 'no-chrome': null },
    ...(effModel ? { model: effModel } : {}),
    ...(effortOpts.effort ? { effort: effortOpts.effort } : {}),
    ...(Object.keys(sdkSettings).length ? { settings: JSON.stringify(sdkSettings) } : {}),
    ...(sessionId ? { resume: sessionId } : {}),
    // 派生的子会话：id 事先定好（父子关系开跑前已登记、工具当场就能把 id 告诉父会话）
    ...(!sessionId && family && family.newSessionId ? { sessionId: family.newSessionId } : {}),
    // 检查点回滚：① 每次文件编辑前快照（SDK 默认关，必须显式开，否则 rewindFiles
    // 报 not enabled）；② 有待生效的对话回滚锚点时本轮从锚点续起——CLI 在同一
    // jsonl 里按 parentUuid 分叉，之后普通 resume 自动走新分支（claude-rewind.mjs）。
    enableFileCheckpointing: true,
    // 输入建议：每轮 result 之后 CLI 预测一条「下一句」（蹭主对话的 prompt cache，几乎不花钱）。
    // 收法见 parkWarm（停放期顺带收）；前端开关关着 / 老客户端 / 快照访客不开。
    ...(wantSuggest ? { promptSuggestions: true } : {}),
    ...(sessionId && pendingRewindAnchor(sessionId) ? { resumeSessionAt: pendingRewindAnchor(sessionId) } : {}),
    // 沙箱用户硬边界：PreToolUse hook 对【每次】工具调用（含只读）做路径围栏 + shell 拦截；
    // disallowedTools 在 SDK 层拿掉危险工具（无 shell 用户连 Bash 都摸不到）；settingSources:[]
    // 隔离文件系统设置（不加载用户可写目录里的 .claude/settings，防止借此放宽权限）。
    // PostToolUse 观察钩全员挂（文件面板自动刷新）；沙箱身份再叠 PreToolUse 硬闸。
    // 插件钩子（ctx.claude.hook）排在 bridge 自己的后面：沙箱围栏先说了算
    // 项目对话的协调者：Bash 只放行只读的 git / gh 查询（runtime/readonly-shell.mjs；钩子在权限模式之前，绕过权限档也拦；worker 不经它）
    // 停进程闸全员挂、排最后（runtime/kill-guard.mjs）：拦按端口 / 共用进程名停进程，子 agent 的调用同样经过；只回 deny 或放行，不回 allow
    hooks: mergeHooks({
      PreToolUse: [
        ...(ctx.sandbox ? [{ hooks: [makeSandboxPreToolUse(ctx)] }] : []),
        ...(projectShape ? [{ matcher: 'Bash', hooks: [makeCoordinatorShellHook()] }] : []),
        { matcher: 'Bash|PowerShell', hooks: [makeKillGuardHook()] },
      ],
      PostToolUse: [{ hooks: [makeFsEchoHook(run)] }, ...(snap ? [] : [{ matcher: 'PushNotification', hooks: [makePushHook(run)] }])],
      // 实际生效 effort（SDK 0.3.257）：Stop hook 的 input.effort 是这轮真正发给 API 的档位
      // （经 env 覆盖 / 组织上限 / 模型不支持降档之后）。init 帧在 SDK 宿主上不带 effort
      // （只有 Remote Control 帧带，probe 验证过是 undefined），只能从这里拿。前端芯片据此
      // 显示实况（选了 Max 被限到 High 就显示 High 并提示）。
      Stop: [{ hooks: [async (input) => {
        try {
          // 后台任务富信息（SDK 0.3.257 Stop hook 的 background_tasks）：type/status/description
          // /command——电平信号只有 id/type/description，后台 shell 的【命令行】只有这里给得出，
          // 任务面板与悬停提示按 taskId 合并进来。Stop 在 result 之前触发，所以悬停判据看得到它。
          const bt = Array.isArray(input && input.background_tasks) ? input.background_tasks : [];
          for (const t of bt) if (t && t.id) run.bgInfo.set(t.id, t);
        } catch {}
        try {
          const level = normalizeEffortLevel(input && input.effort);
          const sid = run.gen.sessionId;
          // ultracode 轮：hook 回的档位是真的，但没有 ultracode 标记——Ultracode 真开没开留到 result 后
          // getSettings() 定局（settleEffort），档位与它一起发——这里只暂存，不发。
          if (wantUltracode) { run.hookLevel = level; return {}; }
          // 自定义模型：CLI 回报的是它眼里的官方档位，真正发出去的是代理按档位表写的值——不回报，芯片显示所选
          if (custom) return {};
          if (sid && !snap) { applyEffort(ctx.key, sid, level, false); run.send({ type: 'effort', sessionId: sid, level, ultracode: false }); }
        } catch {}
        return {};
      }] }],
    }, plug.hooks),
    ...(ctx.sandbox ? {
      settingSources: [],
      // 快照访客再收紧：不许 Task/Agent 派子 agent、不许 Workflow 跑动态工作流（都是成本倍增器，匿名访客不配）；
      // 也没有计划模式（没人能批计划，访客界面也没有审批卡）。
      ...(!ctx.shell ? { disallowedTools: snap ? [...SHELL_DENY, 'Task', 'Agent', 'Workflow', 'EnterPlanMode', 'ExitPlanMode'] : SHELL_DENY } : {}),
    } : {}),
    // 权限模式显式传（不传 = CLI 按服务端闸自己挑 default / auto）；bypass 要能中途切进去，启动时就得带 allowDangerouslySkipPermissions。
    permissionMode: turnPerm.mode,
    ...(allowSkip ? { allowDangerouslySkipPermissions: true } : {}),
    includePartialMessages: true,
    agentProgressSummaries: true, // periodic AI summaries on task_progress for long-running subagents
    // 工作台「任务」面板每条运行中的任务都有停止钮（走控制请求 stop_task，见 gen.stopTask）——
    // 如实声明。声明后 CLI 的 interrupt 只中断当前轮、放过后台 agent/工作流（未声明则 fail-closed
    // 一并杀掉）；我们本来就要能单条停，声明与实现一致。
    perTaskStopAffordance: true,
    ...(pauseOnFlag ? { supportedDialogKinds: ['refusal_fallback_prompt'], onUserDialog: makeRefusalDialog(run) } : {}),
    abortController: run.abort,
    canUseTool: async (name, input, opts) => {
      // Intercept the interactive question tool: ask the user's screens, wait, hand
      // the choice back as allow + updatedInput.answers (official channel, normal tool_result).
      if (name === 'AskUserQuestion' && input && Array.isArray(input.questions)) {
        const qid = (opts && opts.toolUseID) || ('q-' + randomBytes(6).toString('hex'));
        run.send({ type: 'question', qid, questions: input.questions });
        const sidQ = run.gen.sessionId;
        // 「待回答」点要在别的设备的会话列表上也亮起来——同账号任何设备都能替它作答
        //（handleAnswer 只认账号身份），所以这个状态必须是账号级广播的。
        // pending 按「这个会话还有没有别的在等」算（同一会话可能同时挂着审批卡，见 questions.mjs）
        const announceQ = () => { if (sidQ) busPublish(ctx.key, { type: 'question', sessionId: sidQ, pending: pendingFor(sidQ, ctx.key) }); };
        if (sidQ) sessionQuestions.set(sidQ, { qid, kind: 'question', ownerKey: ctx.key, questions: input.questions, ts: Date.now() });
        announceQ(true);
        try {
          const ans = await waitForAnswer(qid, opts && opts.signal, questionTimeoutMs(ctx), ctx.key);   // 设置「Claude 提问无人回答时」
          if (sidQ) sessionQuestions.delete(sidQ, qid);
          announceQ(false);
          // 广播「已回答」——直播/重连/别设备镜像据此把 ask 块标成已回答（带结构化选择），
          // 不再是「问句后 Claude 连贯输出、看不到用户答了什么」。事件进缓冲，/api/attach 重放也重建已答块。
          run.send({ type: 'answer', qid, answers: (ans && Array.isArray(ans.answers)) ? ans.answers : null, cancelled: !!(ans && ans.cancelled) });
          // 作答走官方通道：allow + answers，CLI 自己跑工具、给模型正常结果（不再是 is_error 的拒绝）。
          // 取消、或这份入参 CLI 的作答校验不收（见 questions.mjs sdkAnswerInput）才退回 deny + 文字答案。
          const upd = ans && ans.cancelled ? null : sdkAnswerInput(input, ans);
          if (upd) return { behavior: 'allow', updatedInput: upd };
          return { behavior: 'deny', message: formatAnswer(input.questions, ans) };
        } catch (e) {
          if (sidQ) sessionQuestions.delete(sidQ, qid);
          announceQ(false);
          // 超时/取消也标记为已处理（跳过），避免重连再弹一个已经过期的交互卡（原 phantom-question bug）。
          run.send({ type: 'answer', qid, answers: null, cancelled: true });
          const why = e && e.message === 'timeout' ? '超时未作答' : '已取消或连接中断';
          return { behavior: 'deny', message: '（用户' + why + '。可以改用普通文字向用户提问，或根据已有信息继续。）' };
        }
        // 刻意不再从缓冲里删掉 question 事件：保留它 + 上面的 answer 事件，
        // 重连/镜像重放时先建 ask 卡再标记已答（而非重弹交互卡），比删事件更一致。
      }
      // 其余工具：沙箱复检 → 无人值守放行 → bridge 自带 MCP 白名单 → 逐次审批卡；ExitPlanMode → 计划审批卡
      return run.permGate.canUseTool(name, input, opts);
    },
  };
}
