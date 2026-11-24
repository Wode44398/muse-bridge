import { createHash } from 'node:crypto';
import path from 'node:path';
import { writeSseHeaders } from '../../runtime/sse.mjs';
import { genWrite } from '../../runtime/gen.mjs';
import { noteNativeWindow, customCompactWindow, compactWindowFor } from '../../runtime/ctx-usage.mjs';
// Claude 设置（设置页 › Claude）→ 每轮启动参数：输出风格 / 回复语言 / 署名 / 动态工作流 / 安全栅门 / 输入建议 / 压缩点
import { turnSettings, dispatchScopes, dispatchNudge, sessionAutoNudge } from '../../runtime/claude-turn-settings.mjs';
import { policyFor, notePolicyOwner } from '../../runtime/dispatch-policy.mjs';   // 子 agent 调用策略（设置 › Claude › 对话）
import { VAULT, PHONE_FS, PHONE_CONTROL, CLAUDE_IN_CHROME } from '../../config/index.mjs';
import { ULTRACODE, splitUltracode, CLAUDE_MODELS, CLAUDE_EFFORTS, to1M, claudeEffortOptions, claudeSupportsFast } from '../../config/capabilities.mjs';
import { claudeEngineEnv, activeAccountId, accountIdForToken } from '../../runtime/claude-account.mjs';
import { memberRules, billingUser } from '../../runtime/quota.mjs';
import { noteTurnStart as noteLimitTurnStart } from '../../runtime/limit-resume.mjs';
import { PHONE_NUDGE } from '../../mcp/phone-tools.mjs';
import { PHONE_CONTROL_NUDGE } from '../../mcp/phone-control-tools.mjs';
import { deviceNudge } from '../../mcp/device-tools.mjs';
import { TERMINAL_NUDGE } from '../../mcp/terminal-tools.mjs';
import { WORKSPACE_NUDGE } from '../../mcp/workspace-tools.mjs';
import { sessionsNudge, childNudge, sessionPolicy } from '../../mcp/session-tools.mjs';
import { isProjectSession, projectSettings, threadNudge, projectContextFor, projectNudge, coordinatorTools } from '../../runtime/project-mode.mjs';
import { debugNudge, BRIDGE_NUDGE } from '../../mcp/bridge-tools.mjs';
import { HARNESS_FEEDBACK_DIR } from '../../agent-api/ops/feedback.mjs';
import { familyLink, rememberReplay, familyTurnStart } from '../../runtime/session-family.mjs';
import { cancelClaudeIdleCompact } from '../../runtime/claude-cache.mjs';
import { peersOn, peerInbound } from '../../runtime/session-peers.mjs';
import { vizOnFor, vizPlatform, VIZ_ALLOWED_TOOLS } from '../../mcp/visualize.mjs';
import { playbookSummary, playbookForMention } from '../../runtime/phone-playbook.mjs';
import { isControlOnline } from '../../runtime/phone-control.mjs';
import { devicesEnabled, ownDevices } from '../../runtime/devices.mjs';
import { isDeviceRef } from '../../runtime/device-refs.mjs';
import { claudeExtensionsFor } from '../../extensions.mjs';
import { memberClaudePlugins } from '../../member-skills.mjs';
import { routeBeforeQuery } from '../../runtime/account-router.mjs';
import { ensureClaudeUpstream, isUpstreamEnv, lastServedAccount } from '../../runtime/claude-upstream.mjs';
import { deviceLinkFor, setDeviceLink } from '../../runtime/chat-prefs.mjs';
// 自定义 API（设置 › Claude › 模型服务）：custom:<服务>:<模型> 的会话经本机代理转到第三方端点
import { isCustomModelId, customOwner, resolveCustomModel, customTopTier, subagentModelCatalog, customSupportsFast, providersRev } from '../../runtime/claude-providers.mjs';
import { providerRouteToken, providerEngineEnv } from '../../runtime/claude-providers-proxy.mjs';
import { levelForTier } from '../../runtime/claude-providers-transform.mjs';
import { unarchiveOnTurn } from '../../runtime/session-archive-auto.mjs';   // 真人在已归档会话里发消息 → 取消归档
import { resolveTurnMode, allowSkipFor } from '../../runtime/permissions.mjs';
import { notePrTurnStart, prCapable } from '../../runtime/pr-monitor.mjs';
import { pluginOn, pluginOr, pluginConfig } from '../../plugins/state.mjs';
import { pluginOptions, pluginInput, pluginClaudeTurn } from '../../plugins/claude-tools.mjs';
import { prNudge } from '../../mcp/pr-tools.mjs';
import { markTurn } from '../../runtime/turn-timing.mjs';
import { customIdentityNudge, identityNudge, USER_NUDGE, REGULAR_NUDGE, hostNudge, SNAP_NUDGE, mediaNudge, HOST_TOOLS_NUDGE, HOST_PHONE_PULL_NUDGE, HOST_PROC_NUDGE, BROWSER_SNAP_NUDGE, BROWSER_NUDGE, chromeNudge, deliverNudge, RESEARCH_NUDGE } from './prompts.mjs';
import { chromeSplitServer, CHROME_MCP_NAME } from './chrome.mjs';
import { composeTurnPrompt, makeTurnInput } from './turn-input.mjs';
import { SPARE_MS } from './warm.mjs';

// 一轮开跑前把「这一轮怎么起」算清楚：入参归一、各项工具开不开、追加的系统提示、CLI 的环境变量与 settings、
// 停放复用的签名。算出来的东西装成一个对象（plan）——之后不再变，开跑、接管、收尾都照它。
// 返回 null = 这一轮不必往下走（预热不适用，或自定义模型已经不在了、错误帧已回）。
export async function planTurn(req, res, { message, sessionId, model, effort, ultracode, fast, chatPrefs, attachments, research, suggest, compactFrac, source, fromPhone, narrow, plain, originDevice, fromComputer, origin, autoRetry, limitReplay, limitResume, restartResume = 0, globalMax, ctx, prewarm, family, permissionMode, permissionPolicy, shape, pluginOrigin, viaAgent }) {
  ctx = ctx || { kind: 'admin', sandbox: false, cwd: VAULT, configDir: null, key: 'admin' };
  const snap = ctx.snap || null;   // 聊天快照轮：专属 MCP/提示词/更紧的工具面
  // 新会话预热（见 SPARE_MS）：没有消息、没有 SSE 接收方，建好 query 停在第一轮之前等人接管。
  const isSpare = !!prewarm;
  // Ultracode 与档位独立（10-30）：旧写法 effort:'ultracode'（老客户端、助手、旧偏好重放）拆成 xhigh + Ultracode
  const legacyUltra = effort === ULTRACODE;
  ({ effort, ultracode } = splitUltracode(effort, ultracode));
  // 插件的每轮参数（ctx.claude.options，plugins/claude-tools.mjs）：模型 / 档位在这里就换（后面按换过的解析自定义模型），
  // env / settings / 子 agent / 附加目录 / 追加提示在组启动参数时合并，并进停放签名。不合法的模型 / 档位记日志、忽略。
  const pOpts = ctx.snap ? null : await pluginOptions({ kind: 'chat', ctx, snap: null, message: message || '', sessionId: sessionId || null, source, model, effort });
  if (pOpts?.model) {
    if (CLAUDE_MODELS.has(pOpts.model) || isCustomModelId(pOpts.model)) model = pOpts.model;
    else console.warn('[plugins] ' + pOpts.by.join(',') + ' 给的模型「' + pOpts.model + '」不认识，忽略');
  }
  if (pOpts?.effort) {
    if (CLAUDE_EFFORTS.has(pOpts.effort) || isCustomModelId(model)) effort = pOpts.effort;
    else console.warn('[plugins] ' + pOpts.by.join(',') + ' 给的档位「' + pOpts.effort + '」不认识，忽略');
  }
  markTurn(req, 'pre');
  if (isSpare && (snap || ctx.sandbox || ctx.kind !== 'admin' || sessionId || !SPARE_MS)) return null;
  // 自定义 API（runtime/claude-providers*.mjs）：主机管理员与成员各用各的注册表（成员自带 Key，2026-10-27）；快照访客不给。
  // 服务 / 模型被删或停用就直说，不悄悄换成别的模型。
  const cpOwner = snap ? null : customOwner(ctx);
  const custom = isCustomModelId(model) && cpOwner ? resolveCustomModel(model, cpOwner) : null;
  // 用的是不是这个人自己的 Key：成员用管理员共享的服务时 custom.provider 是管理员那份（owner = 管理员），花的是管理员的钱，
  // 照常过额度闸门、记轮数（runtime/claude-providers.mjs 文件头）
  const ownKey = !!custom && (custom.provider.owner || cpOwner) === cpOwner;
  if (isCustomModelId(model) && !custom) {
    if (isSpare || !res) return null;
    writeSseHeaders(res);
    genWrite(res, { type: 'error', kind: 'model', title: '模型不可用', message: !cpOwner ? '这里不能用自定义 API' : '这个自定义模型已被删除或停用，换一个模型再发' });
    res.end();
    return null;
  }
  // 自定义模型的推理强度 = 它自己档位表里的一档（设置 › Claude › 模型服务），走代理地址，不传给 CLI；不在表里的
  //（从官方模型带过来的 xhigh 之类）按没选算，代理用模型的默认档。Ultracode（动态工作流编排）第三方模型也有：
  // 和官方模型一样是独立勾选，主循环照所选档位跑，再加常驻工作流（见下面 effortOpts）。
  // 旧写法 effort:'ultracode'（那时它是档位表末尾追加的一档）= 模型自己最高的那档 + 工作流。
  const customEffort = !custom || !effort ? ''
    : legacyUltra ? customTopTier(custom.model)
    : (custom.model.efforts || []).some((t) => t.id === effort) ? effort : '';
  if (custom) noteNativeWindow(custom.model.id, custom.model.contextWindow);   // 用量面板按配置的真实窗口画
  // 5 小时限额「重置后自动继续」：这个会话又开跑了——人自己发的就作废等着的那次续跑（limit-resume.mjs）。
  // Auto-fix 唤醒轮（family origin 'ci'，pr-monitor.mjs）同样不算「人接手」。
  if (!isSpare && sessionId && !snap) noteLimitTurnStart(ctx.key, sessionId, { auto: !!limitResume || !!(family && family.origin && (family.origin.kind === 'ci' || family.origin.kind === 'idle-compact')) });
  // 提示缓存快过期时的自动压缩（runtime/claude-cache.mjs）：这个会话又开跑了，撤掉上一轮收尾时排的定时器
  if (!isSpare && sessionId && !snap) cancelClaudeIdleCompact(ctx.key, sessionId);
  // 会话派生与会话间消息（session-family.mjs）：family = 这一轮是服务端替别的会话发起的（派生 / 投递 / 唤醒）。
  // 真人发起的轮：把「连续自动续」清零、记下身份（以后唤醒这个会话要用），攒着没送出去的会话消息附在这条后面。
  // 新会话（派生的子会话）的 id 是预先定好的（SDK sessionId 选项），父子关系在它开跑前就已登记。
  family = family && family.origin ? family : null;
  // 各项工具的开关先过插件（设置 › 扩展 › 功能扩展；插件系统没启动时恒开 = 老行为，见 plugins/state.mjs）。
  const sessionsOn = pluginOn('session-tools') && !snap && (ctx.kind === 'admin' || !!ctx.shell);
  // 项目对话（运行档位 › 项目，runtime/project-mode.mjs）：协调者只派活。讨论串靠会话工具开，没有会话工具就不成立，按普通会话跑。
  // 新会话由请求带来（chat 路由只收新会话、不收派生的子会话），续聊按 chat-prefs 记的形态。
  const projectShape = sessionsOn && (sessionId ? isProjectSession(ctx, sessionId) : shape === 'project' && !(family && family.origin && family.origin.kind !== 'routine'));
  // 讨论串 = 项目对话的子会话：追加段换成讨论串版（familyLink 在下面 appendText 里也要用）
  const ownLink = sessionsOn ? familyLink(ctx, sessionId || (family && family.newSessionId) || null) : null;
  const inProject = !!ownLink && ownLink.parentAgent !== 'dimensio' && isProjectSession(ctx, ownLink.parent);
  // bridge 本身的项目手册 + 操作（mcp/bridge-tools.mjs，取代旧全局助手）：登录身份都给，快照访客不给。
  const bridgeOn = pluginOn('agent-api') && !snap && (ctx.kind === 'admin' || ctx.kind === 'user');
  // 内嵌图表：没有主机能力，登录身份都给；快照访客 / 悬浮胶囊 / 只认文本的管理台代聊（plain）不挂，
  // 其余看设置「对话内交互图表」。出图平台：手机 App 或窄屏网页（narrow）按 mobile（mcp/visualize.mjs）
  const vizOn = pluginOn('visualize') && vizOnFor(ctx, { source, plain });
  const vizPf = vizPlatform({ phone: fromPhone === true, narrow: narrow === true });
  const ownSid = sessionId || (family && family.newSessionId) || null;
  // 权限模式（runtime/permissions.mjs）：每轮显式传。permissionPolicy 'host' = 无人值守（管理台代聊），固定 default + 宿主放行。
  // 模式本身不进停放复用签名（接管停放 / 预热的 CLI 时 setPermissionMode 对齐）；启动期才定的 allowSkip / 策略进签名。
  const permPolicy = permissionPolicy === 'host' ? 'host' : 'interactive';
  const turnPerm = resolveTurnMode(ctx, {
    sessionId, requested: permissionMode, policy: permPolicy,
    // 派生的子会话（新开 / 分叉）继承父会话的模式；会话自己记过的优先（resolveTurnMode 先看会话记忆）
    inheritFrom: family && family.origin && family.origin.kind === 'spawn' && Array.isArray(family.origin.from) ? family.origin.from[0] : null,
  });
  const allowSkip = permPolicy !== 'host' && allowSkipFor(ctx);
  if (!isSpare && !snap) {
    if (!family) rememberReplay(ctx, limitReplay);
    // 已归档的会话（bridge 归档 / 跟随 Desktop）被真人接着用了：取消归档（自动续跑与派生唤醒不算）
    if (!family && !limitResume && sessionId) unarchiveOnTurn(ctx, sessionId);
    if (sessionId) {
      const held = familyTurnStart(ctx, sessionId, family, limitReplay, { auto: !!limitResume });
      if (held) message = message ? message + '\n\n' + held : held;
    }
    // 拉取请求：真人发话 → Auto-fix 连续唤醒计数清零、刷新唤醒用的身份（新会话也记一份身份：它可能接管预热的 CLI）
    notePrTurnStart(ctx, sessionId, { auto: !!family || !!limitResume, replay: limitReplay });
  }
  // 设置项（runtime/claude-turn-settings.mjs）：输入建议 / 压缩点以服务端设置为准，老客户端请求体兜底
  const ts = turnSettings(ctx, { suggest, compactFrac, sessionId: ownSid, outputStyle: chatPrefs && chatPrefs.outputStyle });
  const wantSuggest = ts.suggest;
  // Ultracode = 常驻动态工作流编排（Workflow 工具会派一群子 agent，成本倍增器）。快照访客 /
  // 无 shell 的沙箱用户不给：只关 Ultracode，档位照旧（chat.mjs 对快照已拦一道，这里是 runClaudeChat 全部入口的兜底）。
  if (ultracode && (snap || (ctx.sandbox && !ctx.shell))) ultracode = false;
  // 成员的高消耗功能（开源路线 S2-6，控制台「额度与注册」）：没给成员开放的 fast 不开、Ultracode 关掉（档位照旧）、
  // 不跑 1M 上下文（见下面 effModel）。管理员、服务账号、管理员代发的轮不受限（runtime/quota.mjs memberRules）。
  const memberCaps = memberRules(ctx);
  if (!memberCaps.fast) fast = false;
  if (ultracode && !memberCaps.ultracode) ultracode = false;
  const modelFor = (m) => (memberCaps.ctx1m ? to1M(m) : String(m || '').replace(/\[1m\]$/i, '') || m);
  // 这一轮记到谁的账上：注册用户本人（含管理员代他发的）/ 快照的铸造者；管理员自己不记（runtime/quota.mjs billingUser）
  const billTo = billingUser(ctx);
  const wantUltracode = !!ultracode;
  // 手机能力按【发起客户端】分流（fromPhone 由 chat 路由判定：apk WebView / 原生胶囊）——
  // 电脑网页端发起的轮以前也全量注入，Claude 会误宣称能操作手机/读手机文件（实测投诉）。
  //  · 手机文件（PHONE_FS）：phone_cmd 走本轮 SSE、由【发起设备】原生执行——发起方不是
  //    手机 App 就物理不可用，只在 fromPhone 时注入。
  //  · 手机操控（PHONE_CONTROL）：走手机前台服务的独立长轮询、与聊天客户端无关。手机 App
  //    发起时维持「开关开就注入」（离线时工具自答「未连接」引导开启，实测比凭空否认友好）；
  //    网页发起时只在操控服务【当前在线】才注入——在线=真能操控（跨设备是真实能力），
  //    离线再注入就变回「误以为能操作手机」。快照访客一律不给。
  // 两个开关原是 config.json 的 phoneFs / phoneControl，现在是插件「手机文件」与「手机操控」（后者的「给 Claude 工具」配置项）。
  const phoneFsAvail = pluginOr('phone-files', PHONE_FS);
  const phoneCtlAvail = pluginOr('phone-control', PHONE_CONTROL) && (pluginConfig('phone-control')?.tools ?? PHONE_CONTROL);
  const phoneFsOn = phoneFsAvail && !snap && fromPhone === true;
  const phoneControlOn = phoneCtlAvail && !snap && (fromPhone === true || isControlOnline(ctx.key));
  // 浏览器手眼：admin/Pro 拿全量（ctx.shell）；普通 user 无（headless 浏览器可达内网，
  // 属主机能力）。聊天快照【有】，但是带缰绳的版本——去处限公网 + 快照桶内文件、eval 关掉
  //（硬拦在 browser-tools 的 snapUrlDenied，提示词只是软层），访客侧面板则是只读直播。
  // 按工作空间共享实例（快照=自己的桶），面板实时同屏。
  const browserOn = pluginOn('browser') && (!!ctx.shell || !!snap);
  // 共享终端手眼：与右侧「终端」面板同一 PTY（人机同座）。shell 身份（admin/Pro）专属，
  // 快照访客绝不给（它就是个 shell）。注意别照抄 browserOn 的 `|| !!snap`。
  const termOn = pluginOn('terminal') && !!ctx.shell && !snap;
  // 工作区协同（视图感知/预览下发/move/截图/草稿）：登录身份都给（无 shell 的普通 user
  // 也有文件面板与预览，move 正好补上他们没有 Bash 的缺口）；快照访客不给——capture
  // 会截到匿名访客的屏幕，隐私上不成立。
  const wsToolsOn = pluginOn('workspace-tools') && !snap;
  // 用户的电脑（mcp__device__*，对标官方「云会话连接本机」）：账号下登记过设备（桌面客户端登录即登记）
  // 且这个会话没设成「不连接」就注入。默认目标 = 会话连接的设备（设备芯片 / devices(use)）；新会话没选过时，
  // 从哪台桌面客户端发起就连哪台。设备离线 / 档位不够，工具自己回可读的错——能不能真操作由设备侧硬拦。
  // 快照访客不给（那是匿名链接）。设备只归主人用，沙箱用户操作的是他自己的电脑，不涉及主机。
  // 管理员代某人发的轮（ctx.actor 是主机身份）不挂那个人的电脑（开源路线 S2-7）。
  const deviceOk = !snap && devicesEnabled() && (ctx.kind === 'admin' || (ctx.kind === 'user' && ctx.actor !== 'admin'));
  const myDevices = deviceOk ? ownDevices(ctx) : [];
  const originPc = fromComputer && myDevices.some((d) => d.id === fromComputer) ? fromComputer : '';
  const storedLink = ownSid ? deviceLinkFor(ctx, ownSid) : null;
  // 新会话：请求带来的选择（芯片）> 发起的这台桌面客户端；随 chatPrefs 在 init 拿到会话 id 时落盘。
  if (deviceOk && !storedLink && !ownSid && chatPrefs && !chatPrefs.computer && originPc) chatPrefs = { ...chatPrefs, computer: originPc };
  // 老会话第一次从桌面客户端发话（以前没连过）：连上这台，之后从手机接着聊也还是它。
  if (deviceOk && ownSid && !storedLink && originPc) { try { setDeviceLink(ctx, ownSid, originPc); } catch {} }
  const turnLink = storedLink || (chatPrefs && chatPrefs.computer) || originPc || '';
  // 这条消息引用了电脑上的文件夹（device://）：会话设成「不连接」也照样给工具——不给就读不到；工具按标注里的 device 指名，不改会话连接。
  const deviceOn = deviceOk && myDevices.length > 0 && (turnLink !== 'none' || (attachments || []).some(isDeviceRef));
  // Claude in Chrome（主机管理员真实的 Edge + 全部登录态）：只给主机 admin
  //（ctx.shell、非沙箱、非快照）。Pro 虽有 shell 但属沙箱身份，不给。
  const chromeOn = CLAUDE_IN_CHROME && pluginOn('edge') && !snap && !ctx.sandbox && !!ctx.shell;
  // 拆分模式：Chrome 工具走专用登录目录的独立子进程，推理照走号池（见 chromeSplitServer）。
  const chromeSplit = chromeOn ? chromeSplitServer() : null;
  // 扩展中心（设置→个性化→扩展）：托管技能聚合成本地 plugin、插件按目录、连接器并入
  // mcpServers。管理员自用的那一套只注入 admin 非沙箱会话（扩展可带任意脚本/凭据）；管理员「全服统一」
  // 加装的那一套也注入注册用户（沙箱）。快照访客两样都没有。每轮现读注册表，改动下一条消息即生效。
  const ext = claudeExtensionsFor(ctx, { snap });
  if (ctx.kind === 'user' && !snap) ext.plugins.push(...memberClaudePlugins(ctx.user));   // 成员自己添加的技能（mine:<名>）
  // 拉取请求（mcp__pr__* + 流里认 PR）：gh 令牌是主机本人的 GitHub 账号——与 remotePc 同一道门（pr-monitor.prCapable）。
  const prOn = pluginOn('pr') && !snap && prCapable(ctx);
  // 反提示：全局开关开着但本轮没注入时，明确告诉 Claude「这轮没有」——旧会话 transcript
  // 里可能有成功的 mcp__phone__* 调用记录，不说清它会照着历史声称/重试这些不存在的工具。
  // 只讲工具有没有、怎样才有，不报「这条消息从哪个客户端发来」——发送端由 devices 工具现查（runtime/client-origins.mjs）。
  const noPhoneNudge = (!snap && ((phoneFsAvail && !phoneFsOn) || (phoneCtlAvail && !phoneControlOn)))
    ? '\n\n[手机工具] '
      + (phoneFsAvail && !phoneFsOn ? '「手机文件」工具（mcp__phone__*）本轮未注入（只有从手机 App 发消息时才有），无法查看/读写/拉取用户手机上的文件；' : '')
      + (phoneCtlAvail && !phoneControlOn ? '「手机操控」工具（mcp__phoneControl__*）本轮未注入（手机端操控服务当前不在线）；' : '')
      + '即使早前的对话历史里用过这些工具，本轮也没有——不要声称能操作用户的手机。用户需要手机侧操作时，请他改在手机 App 里发起对话' + (phoneCtlAvail && !phoneControlOn ? '（手机操控还需手机 App 设置里开启「手机操控」服务）' : '') + '。'
    : '';
  // 插件的消息改写（ctx.claude.input）：只改发给 Claude 的那份，界面与转录前的用户原话不变
  const pIn = isSpare || snap ? null : await pluginInput({ kind: 'chat', ctx, snap: null, sessionId: sessionId || null, source, ...(viaAgent ? { via: viaAgent } : {}) }, { message, attachments });
  const { prompt, imageBlocks } = composeTurnPrompt(pIn ? pIn.message : message, pIn ? pIn.attachments : attachments);
  // 恒流式输入 + gate 挂流（见 makeTurnInput 注释）：release 在读循环收轮/finally 时调。
  const turnInput = makeTurnInput(prompt, imageBlocks, isSpare);

  // 1M 默认开启（2026-07-12）：支持 [1m] 的模型一律直跑 1M 兄弟档——200k 以下按标准价
  // 计费，超了正好要大窗口，没有理由再走「近顶才升档」的旧 latch。picker 只见裸 id。
  const effModel = custom ? custom.model.id : modelFor(model);   // 自定义模型：直接用服务里的真实型号；成员没开放 1M 时用裸 id

  // ---- 启动参数（一律在这里算好：既喂给 query，也拼成 warmSig 判断停放的 CLI 能不能接着用）----
  // 子 agent 调用策略（设置 › Claude › 对话 › 子 agent 调用策略，dispatch-policy.mjs）：总开关关着 = 完全走 Claude Code 原生——
  // 不拼调度提示、不挂上游代理路由、start_session 不解析 auto:<档>。开着时按范围：workflow = 动态工作流开着（设置项或 Ultracode）的轮里
  // Workflow 脚本的 agent()；subagent = Agent 工具（不要求动态工作流）；session = start_session 的 auto:<档>（会话那段补一句）。
  // 第三方模型清单按身份各一份（自己的服务 + 管理员共享的）。官方订阅会话有可派的第三方模型、且 workflow 范围管着这一轮时，CLI 也经本机上游代理
  //（claude-upstream.mjs，地址带这个身份的令牌）：工作流 agent() 写第三方模型名 / auto:<档> 的请求按策略改写，其余照旧去 Anthropic。
  // 不调用非 Claude 模型时也照挂：auto:<档> 的改写要经过它（清单按原样算，不按开关过滤）。
  // 策略文本进 appendText → 进 warmSig：改了策略，下一条消息冷起生效。
  let policy = null;
  if (!snap) {
    try { policy = policyFor(ctx); } catch (e) { console.error('[claude] 读不出子 agent 调用策略，这一轮按原生调用：', e?.message || e); }
  }
  if (cpOwner) notePolicyOwner(cpOwner, ctx);   // 上游代理 / 自定义 API 代理改写 auto:<档> 时按 owner 找回这份策略
  const customSmall = custom && custom.provider.fastModel && custom.provider.models.some((m) => m.id === custom.provider.fastModel && m.enabled && m.kind !== 'other') ? custom.provider.fastModel : custom && custom.model.id;
  const workflowOn = !snap && (!!ts.sdk.enableWorkflows || wantUltracode);
  const dsc = dispatchScopes(policy, workflowOn);
  const catalog = cpOwner ? subagentModelCatalog(cpOwner) : [];
  const subRoute = dsc.workflow && !custom && cpOwner && catalog.length && await ensureClaudeUpstream() ? providerRouteToken(cpOwner) : null;
  const dispatchText = dispatchNudge({
    on: !snap, policy, workflowOn,
    custom: custom ? { main: custom.model.id, small: customSmall } : null,
    catalog, routed: !!subRoute, owner: cpOwner || undefined,
  });
  // 插件给 Claude 的工具与提示段（plugins/claude-tools.mjs）：工具合成各插件自己的 MCP server，提示段排在内置提示之后、
  // 子 agent 调度说明之前；sig 进下面的停放签名。这一轮的 gen 要等开跑才有（runClaudeChat 把取它的函数填进 lateGen）——工具被调用时它早已就绪。
  const lateGen = { get: null };
  const plug = pluginClaudeTurn({ kind: 'chat', ctx, snap, getGen: () => lateGen.get(), fromPhone: fromPhone === true, narrow: narrow === true, source, message, sessionId: ownSid, ...(viaAgent ? { via: viaAgent } : {}) });
  // 项目对话：开讨论串默认不问（项目设置「开讨论串前先问我」才问）；讨论串的追加段接在子会话那段后面
  const projPolicy = projectShape ? (projectSettings(ctx).askFirst ? 'ask' : 'direct') : null;
  // 调用策略的「发起新会话」范围开着：补一句 start_session 可以写 auto:<档>。项目对话的协调者不补——讨论串的模型、档位按项目设置（方案 D5），
  // 「不写就沿用本会话的」对它也不成立；它真写了 auto:<档> 照样解析（session-tools.spawn），优先级与显式给 model 相同
  const sessionsPart = sessionsOn ? sessionsNudge(ctx, { peers: peersOn(ctx, snap), ...(projPolicy ? { policy: projPolicy } : {}) }) + childNudge(familyLink(ctx, ownSid), sessionPolicy(ctx)) + (inProject ? threadNudge(ownLink.parentTitle, projectContextFor(ctx, ownLink.parent)) : '') + sessionAutoNudge(dsc, !projectShape) : '';
  // 调试模式（设置 › Claude › 调试）：排在系统提示最末，压过前面「专心做任务」的倾向
  const debugText = ts.debug ? debugNudge({ bridgeOn, dir: HARNESS_FEEDBACK_DIR }) : '';
  const appendText = projectShape
    // 协调者的工具只剩看、问、派活：浏览器 / 终端 / 手机 / 设备这些工具的说明一概不拼（说了它也调不到），
    // 子 agent 调度说明也不拼——讨论串和 worker 的模型、档位按项目设置（方案 D5）
    ? (custom ? customIdentityNudge(custom) : identityNudge(model)) + (ctx.sandbox ? USER_NUDGE + (ctx.shell ? '' : REGULAR_NUDGE) : hostNudge(ctx)) + sessionsPart + projectNudge({ askFirst: projPolicy === 'ask', context: projectContextFor(ctx, ownSid) }) + (pOpts?.append.length ? '\n\n' + pOpts.append.join('\n\n') : '') + (family && typeof family.nudge === 'string' ? family.nudge : '') + debugText
    : (custom ? customIdentityNudge(custom) : identityNudge(model)) + (snap ? SNAP_NUDGE : ctx.sandbox ? (USER_NUDGE + (ctx.shell ? '' : REGULAR_NUDGE) + mediaNudge(ctx)) : (hostNudge(ctx) + mediaNudge(ctx) + HOST_TOOLS_NUDGE + (phoneFsOn ? HOST_PHONE_PULL_NUDGE : '') + HOST_PROC_NUDGE)) + (browserOn ? (snap ? BROWSER_SNAP_NUDGE : BROWSER_NUDGE) : '') + (chromeOn ? chromeNudge(chromeSplit ? CHROME_MCP_NAME : 'claude-in-chrome') : '') + (termOn ? TERMINAL_NUDGE : '') + (wsToolsOn ? WORKSPACE_NUDGE : '') + (bridgeOn ? BRIDGE_NUDGE : '') + (deviceOn ? deviceNudge() : '') + deliverNudge(!snap && !!mediaNudge(ctx)) + (phoneFsOn ? PHONE_NUDGE : '') + (phoneControlOn ? PHONE_CONTROL_NUDGE + playbookSummary() + playbookForMention(message) : '') + noPhoneNudge + (research ? RESEARCH_NUDGE : '') + sessionsPart + (prOn ? prNudge(ctx, ownSid) : '') + plug.prompt + (pOpts?.append.length ? '\n\n' + pOpts.append.join('\n\n') : '') + dispatchText + (family && typeof family.nudge === 'string' ? family.nudge : '') + debugText;
  // 号池智能路由（可选，默认关）：激活号已知用尽就先换号再开跑——必须在取 token / 算 warmSig 之前，
  // 换了号 token 变了，停放的旧 CLI 自然判 options changed 冷起。
  // 预热不换号：真消息来时若要换号，token 变了 warmSig 自然不一致、关掉冷起。
  const routed = isSpare || custom ? null : await routeBeforeQuery({ model });   // 自定义 API 不走号池
  markTurn(req, 'route');
  // 当前激活的 Claude 账号 token（+ 沙箱 configDir）现取现注——切账号即时生效。
  // 自定义 API：CLI 指向本机代理、去掉订阅 OAuth token（绝不发给第三方），后台小任务 / 子 agent 的模型也映射到这个服务。
  // 自定义服务填的是官方 api.anthropic.com + 自己的 Key：fast 由本机代理加 speed 与 beta 头（CLI 那套 settings.fastMode 点不亮，见 providerEngineEnv）
  const customFast = !!(fast && custom && customSupportsFast(custom.provider, custom.model));
  const engineEnv = custom
    ? await providerEngineEnv(claudeEngineEnv(ctx) || { ...process.env }, { provider: custom.provider, model: custom.model, effort: customEffort, fast: customFast, owner: cpOwner })
    : claudeEngineEnv(ctx, { route: subRoute });
  markTurn(req, 'env');
  // 额度事件记回本轮启动时的那个号（号池下各号额度分槽，轮中切号不串）。
  const engineAcct = activeAccountId();
  // 无缝换号 / 智能分派：CLI 走本机上游代理，一轮可能横跨几个号——额度事件 / 撞墙记到这个会话最近实际服务的号名下
  //（sid = 本轮会话 id，新会话 init 之后才有；智能分派下各会话各用各的号）。
  const seamless = isUpstreamEnv(engineEnv);
  const servedAcct = (sid) => (seamless && lastServedAccount(sid)) || engineAcct;
  // SDK usage 接口不走代理（CLI 拿 env 里那个固定号直连 OAuth 接口），读数归那个号。
  const usageAcct = (seamless && accountIdForToken(engineEnv.CLAUDE_CODE_OAUTH_TOKEN)) || engineAcct;
  // effort 原样传；Ultracode 不是 effort 取值，合成 settings {ultracode:true, enableWorkflows:true}
  //（Pro 计划 enableWorkflows 默认关，必须显式开）——两者独立，任意档位都能开 Ultracode（SDK 0.3.311 实测）。
  // settings 与 fast mode 合成【同一份】JSON 字面量（不是文件路径），不落盘、仅本轮生效。
  // 自定义模型：也给 CLI 一档 = 本轮档位换算成的官方档（levelForTier）。真正发出去的仍是代理按档位表写的值；
  // CLI 每个请求都带 output_config.effort，代理靠「是不是这一档」分辨主循环 / 继承的子 agent 与自己挑了档的子 agent（pickTarget）。
  const effortOpts = custom
    ? { ...claudeEffortOptions(null, wantUltracode), effort: levelForTier(custom.model, customEffort) }
    : claudeEffortOptions(effort, wantUltracode);
  // 安全栅门「会话暂停」（claude.ai 的 Paused 卡 / 官方 /code 的 refusal_fallback_prompt 对话框）：
  // switchModelsOnFlag=false + 声明 supportedDialogKinds 后，消息被拒时 CLI 不再自动切回退模型，而是
  // 发 request_user_dialog 停在原地等宿主回话（没声明 kind 则 fail-closed = 经典拒答直接收尾）。
  // 快照访客没有回滚 UI，维持 CLI 默认的自动切换。设置「消息被拦时自动换模型」开着时也走自动切换（ts.pauseOnFlag=false）。
  const pauseOnFlag = ts.pauseOnFlag;
  // 自动压缩点（用量弹层滑块）→ 官方设置项 autoCompactWindow；默认位置不覆盖。改了下一条消息
  // warmSig 不同 → 冷起生效（窗口只在 spawn 时定）。
  // 自定义模型：把它真实的上下文窗口告诉 CLI（它不认识这个型号、默认按 200k 算），设了压缩点就按比例。
  const compactWindow = snap ? undefined : custom ? customCompactWindow(ts.compactFrac, custom.model.contextWindow) : compactWindowFor(ts.compactFrac, effModel);
  const sdkSettings = {
    ...(compactWindow ? { autoCompactWindow: compactWindow } : {}),
    ...(fast && !custom && claudeSupportsFast(model) ? { fastMode: true } : {}),   // SDK 0.3.220 起 settings.fastMode 可点亮；仅支持的模型注入
    ...(pOpts ? pOpts.settings : {}),            // 插件的每轮 settings（排在设置页偏好之前：用户的设置、Ultracode 强制项照样说了算）
    ...ts.sdk,                                  // 设置页的偏好（含 switchModelsOnFlag:false）；排在 effort 之前——ultracode 仍强制开工作流
    ...(effortOpts.settings || {}),
    // 计划文件默认在 <CLAUDE_CONFIG_DIR>/plans——沙箱身份的 configDir 在工作目录外，会被自己的路径围栏拦死（计划卡是空的）。
    // 改到工作目录里（CLI 要求 plansDirectory 必须在项目根内）。
    ...(ctx.sandbox && !snap ? { plansDirectory: '.claude/plans' } : {}),
    // 跨会话消息入站闸（session-peers.mjs）：管理员按设置 accept / hold / refuse，其余身份一律 refuse。flag 层压过用户 / 项目设置。
    // 「跟随 Claude 默认」不写这个键：CLI 自己按权限模式判（绕过权限 / 对方模式不一致时扣留），显式 accept 会把这层保护压掉。
    ...(peerInbound(ctx, snap) ? { crossSessionInbound: peerInbound(ctx, snap) } : {}),
  };
  // 停放 CLI 的复用判据：凡是只在 spawn 时定下、进程里改不了的东西都进来（快照访客不停放）。
  // ext 里有连接器凭据，只进哈希。
  // 路径按「同一个目录」比：新会话没选项目时 homeRoot 缺省（= cwd），续聊按 transcript 反查到默认项目后
  // homeRoot 显式等于 cwd——同一个地方，别因为写法不同把每段新对话的第二条消息都判成冷起。
  const normDir = (d) => { const r = path.resolve(String(d || '')); return process.platform === 'win32' ? r.toLowerCase() : r; };
  // 协调者补回的工具（完整工具名，CLI 不认服务前缀）：看 / 问 / 查 + 会话工具，挂了图表就带上图表
  const coordTools = projectShape ? coordinatorTools({ viz: vizOn ? VIZ_ALLOWED_TOOLS : [] }) : null;
  // 各段单独留一份摘要：签名对不上时日志能说出是哪一段变了（否则「options changed」无从查起）。
  const warmParts = snap ? null : {
    where: [ctx.key, normDir(ctx.cwd), ctx.configDir || '', ctx.media || '', normDir(ctx.homeRoot || ctx.cwd)],
    model: [effModel || '', effortOpts], settings: sdkSettings, append: appendText, ext,
    account: engineEnv ? [engineEnv.CLAUDE_CODE_OAUTH_TOKEN || '', engineEnv.CLAUDE_CONFIG_DIR || '', engineEnv.ANTHROPIC_BASE_URL || ''] : null,
    switches: [!!ctx.sandbox, !!ctx.shell, !!ctx.allowStudio, phoneFsOn, phoneControlOn, originDevice || '',
      browserOn, termOn, wsToolsOn, deviceOn, chromeOn, !!chromeSplit, wantSuggest, sessionsOn, vizOn && vizPf],
    perm: [permPolicy, allowSkip],
    provider: custom ? providersRev(custom.provider.owner || cpOwner) : 0,   // 自定义 API：服务配置改了（输出上限 / 小任务模型 / 提示缓存这些 spawn 时定的 env）下一条冷起
    // 插件工具集（哪些插件、第几版代码、哪些工具）：CLI 起来时就定了，插件开关 / 重载后停放的 CLI 不能接着用。没有插件贡献时不加这一段，签名与插件化之前一致。
    ...(plug.sig.length ? { plugins: plug.sig } : {}),
    // 插件的每轮参数（env / 子 agent / 附加目录）：spawn 时定的，变了就冷起。没有时不加这一段
    ...(pOpts ? { pluginOpts: [pOpts.env, pOpts.agents, pOpts.additionalDirectories] } : {}),
    // 项目对话：协调者开关与工具白名单是 spawn 时的环境变量，普通会话的停放 CLI 不能接（反过来也不行）。普通会话不加这一段
    ...(coordTools ? { project: coordTools } : {}),
  };
  const warmDigest = warmParts && Object.fromEntries(Object.entries(warmParts).map(([k, v]) => [k, createHash('sha256').update(JSON.stringify(v ?? null)).digest('hex').slice(0, 16)]));
  const warmSig = snap ? '' : createHash('sha256').update(JSON.stringify(warmDigest)).digest('hex');
  const sigDiff = (other) => (other && warmDigest ? Object.keys(warmDigest).filter((k) => other[k] !== warmDigest[k]).join('+') : '') || '?';
  return {
    message, sessionId, model, effort, fast, chatPrefs, attachments, source, origin, autoRetry, limitReplay, limitResume, restartResume, globalMax, ctx,
    family, snap, isSpare, pOpts, cpOwner, custom, ownKey, customEffort, sessionsOn, projectShape, ownLink, inProject, bridgeOn, vizOn, vizPf, ownSid,
    permPolicy, turnPerm, allowSkip, wantSuggest, memberCaps, modelFor, billTo, wantUltracode, phoneFsOn, phoneControlOn, browserOn, termOn, wsToolsOn,
    turnLink, deviceOn, chromeOn, chromeSplit, ext, prOn, pIn, turnInput, effModel, plug, projPolicy, appendText, routed, customFast, engineEnv, seamless,
    servedAcct, usageAcct, effortOpts, pauseOnFlag, sdkSettings, coordTools, warmDigest, warmSig, sigDiff, lateGen,
    pageChat: !!pluginOrigin,
    viaAgent: viaAgent || '',
  };
}
