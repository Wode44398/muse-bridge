import { applySdkUsage, statusState, applyContext, limitNotice, classifyError } from '../../runtime/status.mjs';
import { normalizeContextUsage, applyContextUsage, applyEffort } from '../../runtime/ctx-usage.mjs';
import { claudeCacheTtl } from '../../runtime/claude-cache.mjs';
import { autoContinueDefault } from '../../runtime/claude-turn-settings.mjs';
import { sessionPaths } from '../../runtime/paths.mjs';
import { addUsage } from '../../users.mjs';
import { noteTurnUsage } from '../../runtime/audit-log.mjs';
import { noteTurnSettled as noteLimitTurnSettled, noteLimitTurn } from '../../runtime/limit-resume.mjs';
import { findRetryAnchor, setPendingRewind } from '../claude-rewind.mjs';
import { reasonText } from '../../runtime/account-router.mjs';
import { isThinkingBlockError, emitThinkingError, customErrorCard } from './errors.mjs';
import { emitDone } from './turn-ledger.mjs';
import { lastRealUserUuid } from './transcript.mjs';
import { liveBgTasks, bgPayload, bgDeadline } from './bg-hold.mjs';

// result 帧：这一轮怎么定局。

// 幻影 result：CLI 在 resume 时替上一条命的孤儿后台任务「补一轮」时吐出的 result（SDK 0.3.257 实测
// 形状：origin:{kind:'task-notification'}、num_turns:0、duration_api_ms:0、is_error:false、result:''），
// 它出现在用户这轮的 init 之前，不是本轮的定局。判据=【零轮次空壳】：没走过 API（num_turns 0 且
// duration_api_ms 0）、没正文、没报错。
// ⚠ origin.kind 不能单独作准（2026-09-15 探针实测纠正）：悬停续轮——后台任务跑完、CLI 注入
// task-notification 把模型唤醒说完话——的那个【真】result 同样带 origin:{kind:'task-notification'}，
// 但 num_turns=1、正文齐全。按 origin 判会把「后台任务完成后的汇报」整轮当幻影丢掉。
export function isPhantomResult(msg) {
  if (!msg || msg.type !== 'result') return false;
  const hasText = msg.result != null && String(msg.result).trim() !== '';
  if (hasText || msg.is_error) return false;
  return msg.num_turns === 0 && !(msg.duration_api_ms > 0);
}

// SDK usage 控制接口（额度窗口/套餐）的节流时钟：进程级，10 分钟一次——那接口背后是
// api/oauth/usage，直连实测很容易 429。
let lastSdkUsageAt = 0;

// 见 result 分支：定局后、break 前经控制通道取本轮的上下文分布。8s 兜底——控制请求在
// 子进程异常退出时可能永不回，绝不能把收尾卡死。快照访客没有环形面板，跳过。
export async function captureContextUsage(run, rmsg) {
  const { model, ctx, snap, cpOwner, effModel, usageAcct } = run.plan;
  const sid = rmsg.session_id || run.gen.sessionId;
  if (!sid || snap) return;
  // 'full' 首次要逐类真打 count_tokens（10-25 实测 5.8s，之后有缓存 4ms）；这期间同会话的下一条在 fin-wait 里干等。
  // 它一喊（gen.hurry）就不等了：控制请求在 CLI 里与新一轮并发无碍（实测），结果晚到照样记账、推给界面。
  const HURRIED = Symbol('hurried');
  const apply = (raw) => {
    const usage = normalizeContextUsage(raw, effModel || model || '');
    if (!usage) return;
    // 提示缓存多久变冷（分钟；null = 没有会过期的缓存）：用量环的「缓存冷了」小点与空闲压缩都按它算（runtime/claude-cache.mjs）
    try { usage.cacheTtlMin = claudeCacheTtl(run.runModel || model, cpOwner).minutes; } catch {}
    applyContextUsage(ctx.key, sid, usage);
    run.send({ type: 'ctx_usage', sessionId: sid, usage });
  };
  try {
    const p = run.q.getContextUsage({ detail: 'full' });
    const raw = await Promise.race([
      p,
      new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
      ...(run.finHurry ? [run.finHurry.then(() => HURRIED)] : []),
    ]);
    if (raw === HURRIED) {
      console.log('[claude] next message waiting — context usage finishes in background');
      p.then(apply, () => {});
      return;   // 额度窗口也留给下一轮收尾
    }
    apply(raw);
  } catch (e) {
    console.log('[claude] getContextUsage failed:', e && e.message);
  }
  // 额度窗口（= Claude Code /usage 的数据源）：五小时/每周之外还有按模型的每周桶
  //（Fable/Opus/Sonnet 单桶，服务端给了才有）与套餐类型。接口是实验性的，10 分钟一次、
  // 5s 兜底，失败只记日志——响应头那条路（无缝换号上游代理逐请求记；配了 overlay 用量来源时还有它）照常兜着。
  if (Date.now() - lastSdkUsageAt > 600_000) {
    lastSdkUsageAt = Date.now();
    try {
      const u = await Promise.race([
        run.q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
        new Promise((resolve) => setTimeout(() => resolve(null), 5000)),
      ]);
      if (u && u.rate_limits_available && applySdkUsage(u, usageAcct)) run.send({ type: 'limits', limits: statusState.limits, updatedAt: statusState.updatedAt, noFiveHour: statusState.noFiveHour });
    } catch (e) {
      console.log('[claude] sdk usage failed:', e && e.message);
    }
  }
}

// effort 实况定局（仅 ultracode 轮）：Stop hook 回报档位（没有 ultracode 标记）；Ultracode 的真值是控制通道
// getSettings() 的 applied.ultracode——工作流没真开（Pro 计划默认关 / org policy 关 / CLAUDE_CODE_WORKFLOWS=false /
// 模型不支持）时它是 false，芯片就该老实褪掉紫色而不是说谎。
// 只能在 result 后、break 前调（同 getContextUsage）；3s 兜底，取不到就不回报 Ultracode（芯片按所选显示）。
export async function settleEffort(run) {
  const { ctx, snap, custom, customEffort, wantUltracode } = run.plan;
  if (!wantUltracode) return;
  const sid = run.gen.sessionId;
  if (!sid || snap) return;
  let level = run.hookLevel, uc;
  try {
    const st = await Promise.race([run.q.getSettings(), new Promise((resolve) => setTimeout(() => resolve(null), 3000))]);
    if (st && st.applied && typeof st.applied.ultracode === 'boolean') uc = st.applied.ultracode;
  } catch (e) {
    console.log('[claude] getSettings failed:', e && e.message);
  }
  // 自定义模型：hook 回的是 CLI 眼里的官方档位，换成代理实际发的那档（前端对自定义模型只看 ultracode）
  if (custom) level = customEffort || null;
  applyEffort(ctx.key, sid, level, uc);
  run.send({ type: 'effort', sessionId: sid, level, ...(uc !== undefined ? { ultracode: uc } : {}) });
}

// 幻影 result（09-13 复现定案）：resume 的 transcript 里若有【上一条命遗留的后台 shell 任务】
//（只有 "Command running in background with ID" 的 tool_result、没有完成记录——进程中途退出
// 的会话几乎必有），CLI 会先把那条孤儿 <task-notification> 当成一轮自己消化掉，并在【还没
// 开始处理我们这条提示词之前】就吐一个 result：origin.kind='task-notification'、num_turns=0、
// duration_api_ms=0、result=''，随后才发第二个 init 开始用户这轮。以前这里把它当本轮定局：
// done 发出、break → SDK 收尾杀掉 CLI，用户的「继续」刚写进 transcript 就被腰斩，永远等不到
// 回答（08-27 / 09-11 / 09-13 三次「说继续也不继续」同此病根）。这种 result 只记一笔、不定局。
// 例外：用户发的就是 /compact（本地命令，不调模型）——压缩完那个零轮次空壳就是本轮真正的结局，
// 不认的话要白等 30s 兜底才收轮。只在「本轮确实压缩过」时放行，别的形态照旧扣住。
// 返回 true = 是幻影 result，已扣住，循环接着读。
export function holdPhantomResult(run, msg) {
  if (isPhantomResult(msg) && !(run.compactCmd && run.compactSeen)) {
    console.log(`[claude] phantom result before the user turn (origin=${msg.origin && msg.origin.kind}) — ignored, waiting for the real turn`);
    // 兜底：万一判错（真轮就是空的），别让这轮无限挂着——30s 内没有任何后续消息就以它定局。
    clearTimeout(run.phantomTimer);
    run.phantomTimer = setTimeout(() => {
      if (run.doneEmitted) return;
      console.log('[claude] nothing followed the phantom result for 30s — finalizing with it');
      run.bgFinalized = true;
      emitDone(run, msg);
      try { run.abort.abort(); } catch {}
    }, 30_000);
    if (run.phantomTimer.unref) run.phantomTimer.unref();
    return true;
  }
  return false;
}

// result 一到先记的账：会话 id、接力消息对账、回滚锚点、按人的用量、上下文与额度条。
export function noteResult(run, msg) {
  const { ctx, snap, custom, ownKey, modelFor, billTo, servedAcct } = run.plan;
  run.gen.sessionId = msg.session_id;
  clearTimeout(run.interruptTimer);   // 软停止等的就是这个 result
  // 接力消息对账：result 的 user_message_uuids 就是这一轮消化掉的用户消息（SDK 0.3.280 实测带回我们给的 uuid）。
  // 不回 uuid 的老 CLI：非通知来源的 result 当作答了最早那条。
  {
    const answered = Array.isArray(msg.user_message_uuids) ? msg.user_message_uuids : (msg.user_message_uuid ? [msg.user_message_uuid] : []);
    for (const u of answered) run.awaitingUser.delete(u);
    if (!answered.length && run.awaitingUser.size && !(msg.origin && msg.origin.kind === 'task-notification')) {
      run.awaitingUser.delete(run.awaitingUser.values().next().value);
    }
  }
  // 回滚锚点：把本轮用户消息的 transcript uuid 发给前端（用户气泡「回滚到此」入口用）。
  // 快照访客没有回滚 UI，跳过这次文件读。事件进缓冲，attach 重放同样能重建。
  if (!snap) {
    const sp = sessionPaths(msg.session_id, ctx.cwd, ctx.configDir);
    const anchor = sp ? lastRealUserUuid(sp.file) : null;
    if (anchor) run.send({ type: 'anchor', uuid: anchor, sessionId: msg.session_id });
  }
  // Per-user usage accounting（admin 不记账）。花费按这个 CLI 进程上一次报的累计值取差（costMeter），
  // 不再把整段会话的累计花费每轮加一遍；tokens 本来就是这一轮的。
  if (billTo) {
    const u = msg.usage || {};
    const toks = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    const turnCost = run.costMeter.turnCost(msg.total_cost_usd);
    // 自定义 API：自己的 Key，不进额度账本。管理员共享的服务进账本，但第三方型号的价钱 CLI 算不准，花费记 0、只记轮数与 token
    if (!ownKey) try { addUsage(billTo, { tokens: toks, costUsd: custom ? 0 : turnCost }); } catch {}
    // 用量事件流（开源路线 C12，runtime/audit-log.mjs）：同一口径再落一条带维度的元数据——谁发的、归谁、记谁的账、
    // 哪个号、哪个模型。只追加写 _system/usage-events，不读、不影响额度与界面；是将来按组 / 按号分摊的底账。
    try { noteTurnUsage(ctx, { billTo, accountId: custom ? '' : servedAcct(run.gen.sessionId), model: custom ? custom.model.id : modelFor(run.runModel), tokens: toks, cost: custom ? 0 : turnCost, source: snap ? 'snap' : ctx.actor && ctx.actor !== ctx.key ? 'proxy' : 'chat' }); } catch {}
  }
  const ctxInfo = applyContext(msg.modelUsage, msg.session_id, run.lastMainUsage || msg.usage, ctx.key);
  if (ctxInfo) {
    run.send({ type: 'context', used: ctxInfo.used, total: ctxInfo.total, pct: ctxInfo.pct, sessionId: ctxInfo.sessionId, at: ctxInfo.at });
  }
  run.send({ type: 'limits', limits: statusState.limits, updatedAt: statusState.updatedAt, noFiveHour: statusState.noFiveHour });
}

// 软停止等的那个 result 到了。返回 true = 还不收轮（接力消息没答完 / 转入挂起），false = 已发 done。
export function settleSoftStop(run, msg) {
  run.softStopping = false;
  // 软停止打断的这一轮：CLI 回 error_during_execution（is_error、无正文，e2e 实测）——这是用户要的
  //「停下」，不是故障，不发错误卡。后台任务还在就转入挂起（与正常收笔同一套），没有了就干净收尾。
  const clean = { ...msg, is_error: false, api_error_status: null, result: msg.is_error ? '' : (msg.result || '') };
  const live = liveBgTasks(run);
  console.log(`[claude] interrupted reply settled (${msg.subtype}) — ${live.length} background task(s) still running`);
  if (run.awaitingUser.size) { run.interimResult = clean; return true; }
  if (live.length) {
    run.heldResult = clean;
    if (!run.holdStartedAt) run.holdStartedAt = Date.now();
    run.send({ type: 'bg_hold', count: live.length, tasks: bgPayload(run, live), deadline: bgDeadline(run, live) });
    return true;
  }
  emitDone(run, clean);
  return false;
}

// 这个 result 算不算出错、撞的是哪种限额。
export function judgeResult(run, msg) {
  const { custom } = run.plan;
  const apiStatus = typeof msg.api_error_status === 'number' ? msg.api_error_status : null;
  const errored = Boolean(msg.is_error) || (apiStatus != null && apiStatus >= 400) || run.authFailed || !!run.limitFrame;
  const hasText = msg.result && String(msg.result).trim();
  // 号池智能路由（可选，默认关——关着时 noteLimitHit 直接回 null，下面照旧）：撞额度墙（429 /
  // 本轮收到 rejected）或 token 失效 → 给发起这轮的号记冷却、换到可用号。换成了就由前端无缝接上：
  //   · 本轮什么都没产出（第一个请求就被拒）→ 'resend'：把失败那条从上下文分叉掉（下一轮
  //     resumeSessionAt 锚到它之前），前端撤掉这对气泡、用新号原样重发；
  //   · 已经干了一半 → 'continue'：上下文不动，前端用新号发一句「接着做」。
  // 只对声明了 autoRetry 的前端这么做；老 apk 收到的是普通错误卡（文案里写明已换号，手动重试即可）。
  // 自定义 API 不进这套：第三方的 401 / 429 跟官方号的额度、登录态无关（不冷却官方号、不弹官方限额卡、不挂自动续跑）
  const limitKind = !errored || custom || isThinkingBlockError(msg.result) ? ''
    : (apiStatus === 429 || run.turnRejection || run.limitFrame) ? 'rate_limit'
      : (run.authFailed || apiStatus === 401) ? 'auth' : '';
  // 撞的是哪个限额、几点重置：合成回答带的 info 最准，其次本轮的 rejected 事件，再其次最近一次硬拒绝。
  const lim = limitKind === 'rate_limit' ? limitNotice((run.limitFrame && run.limitFrame.info) || run.turnRejection, run.limitFrame && run.limitFrame.text, { live: true }) : null;
  return { apiStatus, errored, hasText, limitKind, lim };
}

// 出错的轮发哪张错误卡。返回 false = 没出错，按正常收轮走。
export function reportTurnError(run, msg, { apiStatus, errored, hasText, limitKind, lim, failover }) {
  const { model, autoRetry, ctx, snap, custom, ownKey } = run.plan;
  const settledSid = msg.session_id || run.gen.sessionId;
  if (errored && !snap && settledSid && !(lim && !failover)) noteLimitTurnSettled(ctx.key, settledSid);
  if (failover) {
    const quiet = run.turnOut === 0 && !run.taskGuard.mainTools.size;
    let retry = '';
    if (autoRetry && quiet) {
      retry = 'resend';
      const sid = msg.session_id || run.gen.sessionId;
      const sp = sid && !snap ? sessionPaths(sid, ctx.cwd, ctx.configDir) : null;
      const failedUuid = sp ? lastRealUserUuid(sp.file) : null;
      const anc = failedUuid ? findRetryAnchor(sp.file, failedUuid) : null;
      // 会话首条消息前面没有可锚的回答：不分叉，原样重发（transcript 里会留一条重复的提问，无害）。
      if (anc) setPendingRewind(sid, anc);
    } else if (autoRetry) retry = 'continue';
    const why = reasonText(failover.reason);
    const title = run.showAccounts ? `账号「${failover.fromLabel}」${why}，已自动切到「${failover.toLabel}」` : '额度已满，已自动切换到号池里的另一个账号';
    const hint = retry === 'resend' ? '正在用新账号重发这条消息…' : retry === 'continue' ? '正在用新账号接着做…' : '重试这条消息，或发「继续」接着做。';
    console.log(`[claude] ${limitKind} on ${failover.fromLabel} → ${failover.toLabel}${retry ? ' (client ' + retry + ')' : ''}`);
    // 前端收到错误卡会立刻重发同一会话：让它等这个 CLI 退干净再冷起（同硬停止的 stopping 闸），
    // 一份 transcript 不许两个写入者。
    run.gen.stopping = run.procExited;
    run.send({ type: 'error', kind: 'rate_limit', title, hint, resetsAt: 0, autoRetry: retry || undefined, message: title + ' — ' + hint });
  } else if (lim) {
    // 撞限额且没有别的号可换（号池路由关着 / 全员用尽）：官方 /code 页同款限额卡（Session limit reached /
    // Weekly limit reached）。CLI 那句英文原话不再当回答渲染——以前它要么顶替正文（零产出时），要么
    // 干了一半时直接被吞，这一轮看着像无声结束。limit 字段给新前端排版；title/hint/message 给老 apk 的错误框。
    // 5 小时限额另带自动续跑的状态（limit-resume.mjs：默认勾上，到点服务端自己发「接着做」）。
    const resume = !snap && settledSid && run.limitReplay
      ? noteLimitTurn(ctx.key, settledSid, { type: lim.type, resetsAt: lim.resetsAt, replay: run.limitReplay, defaultOn: autoContinueDefault(ctx), model })   // 撞墙时现读设置（停放复用的闭包里 ts 是首轮的值）
      : null;
    console.log(`[claude] usage limit reached (${lim.type || '?'}, resets ${lim.resetsAt ? new Date(lim.resetsAt).toISOString() : '?'})${resume && resume.armed ? ' — auto-continue armed' : ''}`);
    run.send({
      type: 'error', kind: 'rate_limit', title: lim.title, hint: lim.hint, resetsAt: lim.resetsAt,
      limit: { type: lim.type, resetsAt: lim.resetsAt, text: (run.limitFrame && run.limitFrame.text) || String(msg.result || '').trim() },
      resume, sessionId: settledSid || undefined,
      message: lim.title + ' — ' + lim.hint,
    });
  } else if (errored && isThinkingBlockError(msg.result)) {
    // SDK wrote dead thinking blocks mid tool-loop → the 400 came back AS the
    // result text. Don't render that raw error as the answer; clean + hint.
    emitThinkingError(run);
  } else if (errored && custom && (apiStatus != null || run.authFailed || run.limitFrame || !hasText)) {
    // 自定义 API 的错：代理已把上游的 404 / 401 / 403 / 非 JSON 改写成人话（claude-providers-proxy.mjs upstreamError），
    // CLI 把它包成「API Error: 400 {…}」——抠出那句人话，别按「Claude 登录失效」「额度已满」分类。
    const c = customErrorCard({ ...custom, lent: !ownKey }, msg.result, apiStatus);
    run.send({ type: 'error', kind: 'model', title: c.title, hint: c.hint, resetsAt: 0, message: c.title + ' — ' + c.hint });
  } else if (errored && (!hasText || run.authFailed || /^\s*(not logged in|invalid api key)/i.test(String(msg.result)))) {
    // 认证类错误哪怕带了文字（「Not logged in · Please run /login」）也不当回答渲染：
    // bridge 用户没有地方跑 /login，要给的是服务端该怎么配。
    // No usable text came back — surface a classified notice instead of an
    // empty bubble. 429 → rate limit, otherwise infer from the result text.
    const c = classifyError(msg.result || ('HTTP ' + (apiStatus || '')), apiStatus === 429 ? 'rate_limit' : run.authFailed ? 'authentication_failed' : '');
    run.send({ type: 'error', kind: c.kind, title: c.title, hint: c.hint, resetsAt: c.resetsAt || 0, message: c.hint ? (c.title + ' — ' + c.hint) : c.title });
  } else return false;
  return true;
}
