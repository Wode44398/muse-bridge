// 流事件归并：直播流 / attach 重放的每一帧落到当前这条助手气泡上（applyEvent），以及只改 status 的事件、提问卡。
// 「这条流还活着」的记账在内核的 onEvent 里做，这里只管事件对消息模型的作用。

import { api } from '../api.js';
import { session, settings, ui, status, refusalBand, caps, sessionWt } from '../state.svelte.js';
import { claudeDefaultModel } from '../caps.js';
import { agentStream, notifyKind } from '../notify.js';
import { adoptOutputStyleSent } from '../outputStyle.svelte.js';
import { noteAgentBrowser, noteAgentTerm } from '../dock.svelte.js';
import { handleWsx } from '../uiReport.js';
import { noteFsChange } from '../fsSync.svelte.js';
import { runPhoneCmd } from '../phonecmd.js';
import { promoteComposerDraft } from '../composerDrafts.svelte.js';
import { mergeProgress, settleProgress, workflowNameFromInput, usageOf, normTaskStatus } from '../taskModel.js';
// 权限模式 / 逐次审批卡 / 计划审批卡（2026-10-20）：帧处理与状态都在 permissions.svelte.js，这里只转发
import { onPermEvent, permOnAttach, adoptDraftShape } from '../permissions.svelte.js';
import { t as tt, tr } from '../i18n.js';   // 本文件的 t 是工具行/任务局部变量，翻译函数取别名 tt
import { noteFamilyLink, noteCollabEvent } from '../sessionFamily.svelte.js';
import { applyWidgetEvent } from '../widgetSeg.js';   // 对话内嵌交互图表（widget_* 帧 → widget 段；窄屏按手机宽度出图）
import { showToast } from '../toast.svelte.js';
import { chat } from './store.svelte.js';
import { rememberSession, notePrefsNow, rememberCurrentPrefs } from './prefs.js';
import { toUiAttachments, toDeliverAtts } from './attachments.js';
import { trackRun } from './runHint.js';
import { textSeg, findToolByIndex, findMedia, toolById, taskById, resetToolIndex, cardOfTool, applyCompact, pushTool, ensureTask, findTaskEntry, reviveTask, appendAgentEntry, noticeFromEvent, settleTurn, retractTurn, hasBody, lastText, flushText, dropText, queueText } from './turn.js';
import { pendingNew, dropPendingNew } from './pending.svelte.js';
import { mcpState, noteLimitResume } from './queue.svelte.js';
import { scheduleAutoRetry } from './kernel.js';

// 快照模式：Claude 调 close_snapshot 关停时后端广播 snap_closed——SnapPage 挂监听切「已关停」态。
let _onSnapClosed = null;
export function onSnapClosed(fn) { _onSnapClosed = fn; return () => { if (_onSnapClosed === fn) _onSnapClosed = null; }; }

// 已落过 settings.model 的会话模型切换（session{swapped}）：attach 整轮重放会把同一条再送一遍，同一次切换只落
// 一次，否则用户在本轮里已手动切回的选择会被重放冲掉。键 = 会话 + from>to + 服务端时间戳。
const appliedSwaps = new Set();

// —— 星标运行相位：Thread 底部菊花按 claude.ai 同款映射选动画——只认「最近一种活动」。
// thinking→思考脉动 / text→书写 / 工具·子任务·媒体生成→tool(环绕) / 提问→waiting(等回答) /
// 答完先回 thinking。attach 整轮重放按事件顺序自然重建到最新相位，无需特判。
const PHASE = {
  thinking: 'thinking', text: 'writing',
  tool: 'tool', tool_args: 'tool',   // tool_done 不改相位：结果回来不等于活干完
  task_start: 'tool', task_progress: 'tool', task_update: 'tool', task_done: 'tool',
  agent_msg: 'tool',                 // 子 agent 在干活 → 环绕
  gen_media_start: 'tool', gen_media_progress: 'tool',
  widget_start: 'writing', widget_delta: 'writing',   // 内嵌图表：模型正在写图表代码
  question: 'waiting', answer: 'thinking',
  refusal_prompt: 'waiting', refusal_answer: 'thinking',   // 安全栅门暂停：等人二选一
  perm_request: 'waiting', perm_answer: 'thinking', plan_request: 'waiting', plan_answer: 'thinking',   // 审批卡：等人批
  model_notice: 'thinking', retract: 'thinking',   // 安全栅门切模型重试：换个模型重新想
  bg_hold: 'waiting',   // 悬停等后台子任务：主模型已停笔，星标降成慢呼吸
  compact: 'tool',      // 上下文压缩（动辄一两分钟不出字）：算在干活，别被判成长静默
};

// —— 只改 status、不碰消息列表的事件 ——
// context（每次 API 调用后的上下文填充）/ ctx_usage（done 之后 ~1.5s 才到的 getContextUsage 精确分布）/
// effort（Stop hook 回报的实际档位）/ limits（额度窗口）。它们【可能在本轮定局之后才到】：done 一发，
// 服务端还要 await getContextUsage 再发 ctx_usage；attach 重放同样先 done 后 ctx_usage。applyLiveEvent
// 若像对待正文一样为它们「补开一条 assistant 气泡」，就会造出一个空的、永远转圈的幽灵轮，还把
// session.busy 立起来堵住下一次发送——下一次 sync 的 attach 重放又会把整轮内容灌进这只幽灵，看起来
// 像回答重复了一遍（2026-09-02 集成验收工作流轮实证：done → ctx_usage → 空气泡 → 重放复制）。
export const STATUS_ONLY = new Set(['context', 'ctx_usage', 'effort', 'limits', 'perm_mode']);   // perm_mode：权限模式实况，可能在轮外到达
export function applyStatusEvent(ev) {
  switch (ev.type) {
    case 'context': {
      const c = { used: ev.used, total: ev.total, pct: ev.pct, sessionId: ev.sessionId, at: ev.at || Date.now() };   // 轮中每次 API 调用后都会来（11-13 起）
      status.context = c;
      if (ev.sessionId) status.contexts[ev.sessionId] = c;   // 多对话并发：按会话各记各的填充
      return;
    }
    case 'ctx_usage': if (ev.sessionId && ev.usage && ev.usage.max) status.usages[ev.sessionId] = ev.usage; return;
    // ultracode：这一轮 Ultracode 真开没开（undefined = 服务端没取到，按所选显示）；旧服务端的 level:'ultracode' 拆开
    case 'effort': if (ev.sessionId) status.efforts[ev.sessionId] = ev.level === 'ultracode' ? { level: 'xhigh', ultracode: true, at: Date.now() } : { level: ev.level || null, ...(typeof ev.ultracode === 'boolean' ? { ultracode: ev.ultracode } : {}), at: Date.now() }; return;
    case 'limits': if (ev.limits) { status.limits = ev.limits; status.updatedAt = ev.updatedAt || Date.now(); if ('noFiveHour' in ev) status.noFiveHour = !!ev.noFiveHour; } return;
    case 'perm_mode': onPermEvent(null, ev); return;
  }
}

export function applyEvent(m, ev) {
  const ph = PHASE[ev.type];
  if (ph && m.phase !== ph) m.phase = ph;
  trackRun(m, ev);
  // 悬停态解除：主模型恢复动笔（续轮 init 的 session / 正文 / 主链工具）即回到普通
  // 运行显示。task_* 进度事件【不】解除——后台子任务推进正是挂起期的常态。
  if (m.bgHold && (ev.type === 'session' || ev.type === 'text' || ev.type === 'thinking' || ev.type === 'tool')) {
    m.bgHold = null;
    m.textBreak = true;   // 续轮正文另起一段（见 textSeg）
  }
  // 非 text 事件先把缓冲刷进去，保证段落顺序正确（attach 例外：重放重建，缓冲直接丢弃）。
  if (ev.type === 'attach') dropText();
  else if (ev.type !== 'text') flushText();
  switch (ev.type) {
    // 断线重连成功：/api/attach 会从头重放整个缓冲，先清掉本条已渲染内容，
    // 否则 text/tools 会追加第二遍（内容翻倍）。重放随后完整重建。
    case 'attach':
      resetToolIndex(true, m);  // 重放会按事件顺序重建工具行/任务，索引跟着重建（【前几轮】仍在跑的后台任务留着，同上；本条自己的不留）
      m.segments = [];
      m.thinking = '';
      m.question = null;
      m.phase = 'shimmer';   // 相位归零，重放事件流会按顺序重建到最新相位
      m.idle = false;
      m.bgHold = null;       // 重放会按事件顺序重建悬停态（bg_hold → session/text 解除）
      m.paused = false;      // 同理：安全栅门暂停由重放里的 refusal_prompt / refusal_answer 重建
      permOnAttach(ev.sessionId || session.id);   // 审批卡同理：重放按顺序重建，仍在等的恢复可点
      m.offerQid = null;     // 同理：offer 卡由重放里的 offer / offer_answer 重建
      // elapsedMs：把"思考 Ns"计时器重锚到服务端真实起点——杀后台/刷新回来不再从 0 数。
      if (typeof ev.elapsedMs === 'number' && ev.elapsedMs >= 0) {
        m.startedAt = Date.now() - ev.elapsedMs;
        m.elapsed = ev.elapsedMs;
      }
      break;
    case 'session':
      if (ev.sessionId) {
        // 新会话首轮：id 此刻才定下来——把发送时的选择器记忆补绑到这个会话上。
        if (!session.id) { notePrefsNow(ev.sessionId); promoteComposerDraft(ev.sessionId); adoptOutputStyleSent(ev.sessionId); adoptDraftShape(ev.sessionId); }   // 输入栏草稿跟着改名，不当成切会话；随第一条带的输出风格转记成会话覆盖；项目草稿转记成项目对话
        session.id = ev.sessionId; rememberSession(ev.sessionId);
        dropPendingNew(pendingNew.mine);   // id 到了：侧栏的占位换成真行
        if (ev.wt && ev.wt.cwd) sessionWt[ev.sessionId] = ev.wt;   // worktree 会话：工作台当场切过去
      }
      // fast 实况回执：开了开关也可能因冷却/额度没点亮（status.fast: null=未知/未开）。
      if ('fast' in ev) status.fast = !!ev.fast;
      if (ev.swapped && ev.model) {
        // 安全栅门把会话模型换掉（scope=session 的回退，服务端 sidecar 已改）：选择器跟着切
        // 过去并记忆——官方语义「会话模型已切换，用户可手动切回」；下一轮 bridge 显式传的
        // 就是回退模型。session.id 上面刚对齐过，这里不必再比。重放幂等（appliedSwaps）。
        const sid = ev.sessionId || session.id || '';
        const key = sid + '|' + (ev.from || '') + '>' + ev.model + '@' + (ev.at || '');
        if (!appliedSwaps.has(key)) {
          appliedSwaps.add(key);
          settings.model = ev.model;
          rememberCurrentPrefs();
        }
        if (sid) status.models[sid] = { id: ev.model, from: ev.from || '', at: ev.at || Date.now() };
      } else if (ev.model) {
        // 普通 init 回执 = 本轮实际跑的模型（带 [1m] 后缀，剥掉再比）。会话上次被安全栅门换过模型
        //（status.models 有记录）时对账：与当前所选一致 → 记号清掉（用户手动切回原模型并跑完一轮后，
        // 芯片不该还点线下划说「已切换到 X」）；不一致（服务端夹紧了）→ 记实况、from 留空（芯片给通用提示）。
        const sid = ev.sessionId || session.id || '';
        if (sid && status.models[sid]) {
          const bare = String(ev.model).replace(/\[1m\]$/, '');
          if (bare === (settings.model || claudeDefaultModel(caps.data))) delete status.models[sid];
          else status.models[sid] = { id: bare, from: '', at: Date.now() };
        }
      }
      break;
    case 'text': queueText(m, ev.text || ''); agentStream('Claude', lastText(m)); break;
    // 插话（Claude 工作中按回车）：这一轮回答流里的一个插话气泡；CLI 读到它之前标「等待读取」。
    // 只认流里的事件落段（单写者）——发起插话的 POST 只回 JSON，不碰消息列表。
    case 'steer':
      if (!m.segments.some((s) => s.kind === 'steer' && s.uuid && s.uuid === ev.uuid)) {
        m.segments.push({ kind: 'steer', text: ev.text || '', files: Array.isArray(ev.files) ? ev.files : [], atts: toUiAttachments(ev.atts), uuid: ev.uuid || '', read: false, retractable: !!ev.retractable });
      }
      break;
    case 'steer_state': {
      // withdrawn = 用户在 Claude 读到之前撤回了（/api/claude/unsteer）：它本来就是虚的，整段拿掉——
      // 各设备都收得到这一帧（进重放缓冲），气泡一起消失；原文只回到撤回的那台输入栏。
      if (ev.state === 'withdrawn') { const i = m.segments.findIndex((s) => s.kind === 'steer' && s.uuid === ev.uuid); if (i >= 0) m.segments.splice(i, 1); break; }
      const sg = m.segments.find((s) => s.kind === 'steer' && s.uuid === ev.uuid);
      if (sg) { if (ev.state === 'cancelled') sg.cancelled = true; else sg.read = true; }
      break;
    }
    case 'mcp':
      if (ev.sessionId) mcpState.bySession[ev.sessionId] = { servers: Array.isArray(ev.servers) ? ev.servers : [], at: Date.now() };
      break;
    case 'family_link':
      // 这一轮里 Claude 派生了一个子会话：工具行据此直接链过去（侧栏列表要等它的记录落盘才有）
      noteFamilyLink(ev);
      break;
    // 「Claude 发起新会话」的卡（session-tools.mjs）：offer = 「新会话 / 在这里做」在等用户，offer_answer = 答了；
    // proposal = 提议卡落下。卡片状态住在 sessionFamily.svelte.js（总线 {type:'proposal'} 同步多设备），这里只记「在等」。
    case 'offer':
      m.offerQid = ev.qid || null; noteCollabEvent(ev);
      // 设置 › Claude › 通知 › 提问：「新会话 / 在这里做」也是在等你选——没在看时弹系统通知，按 qid 去重（重连重放不重复弹）
      notifyKind('question', { body: tt('为“{title}”新建会话，还是就在这里处理？', { title: ev.title || tt('这项任务') }), watching: ui.screen === 'claude' && !document.hidden, tag: ev.qid });
      break;
    case 'offer_answer': if (m.offerQid === ev.qid) m.offerQid = null; noteCollabEvent(ev); break;
    case 'proposal': noteCollabEvent(ev); break;
    case 'thinking': m.thinking += ev.text || ''; break;
    case 'tool': {
      // 索引命中但那一行不在本条消息里（上面 resetToolIndex 注释里的孤儿）= 不算已有，照常入段——
      // 宁可重建一行，也不能让卡片凭空消失。pushTool 随即把索引改指向新行。
      let known = ev.id ? toolById.get(ev.id) : null;
      if (known && !(m.segments || []).some((s) => s && s.kind === 'tools' && (s.tools || []).includes(known))) known = null;
      if (known) { if (ev.name) known.name = ev.name; if (typeof ev.index === 'number') known.index = ev.index; }
      else pushTool(m, { id: ev.id, name: ev.name, index: ev.index, ...(ev.at > 0 ? { t0: ev.at } : {}) });   // 切回会话重放时 t0 取服务端开始时刻，别从 0 秒重算
      break;
    }
    case 'tool_args': {
      const t = (ev.id && toolById.get(ev.id)) || findToolByIndex(m, ev.index);
      if (!t) break;
      if (ev.summary) t.summary = ev.summary;
      if (ev.input && typeof ev.input === 'object') t.input = ev.input;
      if (t.name === 'Workflow' && t.task && !t.task.name) {   // 工作流名：input.name（task_start 若先到已试过脚本头）
        const n = workflowNameFromInput(t.input);
        if (n) { t.task.name = n; if (!t.task.workflowName) t.task.workflowName = n; }
      }
      break;
    }
    case 'tool_done': {
      const t = ev.id ? toolById.get(ev.id) : null;
      if (t) {
        t.status = ev.isError ? 'error' : 'done'; if (typeof ev.ms === 'number') t.ms = ev.ms;
        const card = cardOfTool(ev);   // 插件工具的结果卡片：服务端在 tool_done 带 card / content 时画出来
        if (card) t.card = card;
        if (ev.images > 0) t.images = Math.min(24, ev.images | 0);
      }
      break;
    }
    case 'usage':
      if (typeof ev.output === 'number') m.tokens = ev.output;
      if (typeof ev.thinking === 'number') m.thinkingTokens = ev.thinking;
      break;
    // 只改 status 的事件（上下文填充 / 分布 / 实际 effort / 额度）——统一走 applyStatusEvent，
    // 收轮之后还会到的那几条（ctx_usage 在 done 之后 ~1.5s）在 applyLiveEvent 里也走它，不再开气泡。
    case 'context': case 'ctx_usage': case 'effort': case 'limits': case 'perm_mode': applyStatusEvent(ev); break;
    // 检查点回滚锚点：本轮用户消息在 transcript 里的 uuid → 挂到最近的用户气泡上
    //（「回滚到此」入口据此可用；历史重开的气泡由 /api/session 直接带 uuid）。
    case 'anchor': {
      for (let i = chat.messages.length - 1; i >= 0; i--) {
        const u = chat.messages[i];
        if (u.role === 'user') { if (ev.uuid) u.uuid = ev.uuid; break; }
      }
      break;
    }
    // 档2：Claude 下发的手机文件命令——调原生 SAF 执行并回传（不渲染 UI，fire-and-forget）。
    case 'phone_cmd': runPhoneCmd(ev); break;
    // agent 用了浏览器工具：宽屏自动拉开右侧浏览器面板同屏直播，窄屏亮提示点。
    case 'browser': noteAgentBrowser(ev.url); break;
    // agent 用了共享终端：宽屏自动拉开终端面板同屏，窄屏亮提示点。
    case 'term': noteAgentTerm(); break;
    // 工作区协同指令（文件面板刷新/导航、推预览、截图/草稿请求）——uiReport 统一处理。
    case 'wsx': handleWsx(ev); break;
    // agent 的 Edit/Write 落盘成功：打开中的文档查看器自动跟盘刷新（fsSync）。
    case 'fs': noteFsChange(ev.path); break;
    case 'question':
      showQuestion(m, ev);
      // 设置 › Claude › 通知 › 提问（本机开关）：没在看这个会话时弹系统通知，按 qid 去重（重连重放不重复弹）
      notifyKind('question', { body: (Array.isArray(ev.questions) && ev.questions[0] && ev.questions[0].question) || '', watching: ui.screen === 'claude' && !document.hidden, tag: ev.qid });
      break;
    case 'answer': markAnswered(m, ev); break;
    // 逐次审批卡（输入框上方停靠）/ 计划审批卡（流里的 plan 段）/ 权限模式实况——lib/permissions.svelte.js
    case 'perm_request': case 'perm_answer': case 'plan_request': case 'plan_answer':
      onPermEvent(m, ev);
      // 人拒掉的那条工具行标 Denied（ToolRow 的 rejected/denied 尾巴；历史重建按 tool_result 措辞标同一个字段）
      if (ev.type === 'perm_answer' && ev.decision === 'deny' && ev.toolUseId) { const t = toolById.get(ev.toolUseId); if (t) t.denied = 'user'; }
      break;
    // 不经审批卡就被拒（auto 模式分类器 / 规则）：同样标在工具行上
    case 'perm_denied': { const t = ev.toolUseId ? toolById.get(ev.toolUseId) : null; if (t) t.denied = ev.kind || 'auto'; break; }
    // 安全栅门暂停（服务端 onRefusalDialog）：输入框上方摆 Paused 卡，等人选「编辑重试 / 换模型」。
    // attach 重放按顺序先 prompt 后 answer，已答的自然不再弹。
    case 'refusal_prompt':
      m.paused = true;
      refusalBand.prompt = { qid: ev.qid, sessionId: ev.sessionId || session.id || '', from: ev.from || '', to: ev.to || '', category: ev.category || null, busy: false };
      break;
    case 'refusal_answer':
      m.paused = false;
      if (refusalBand.prompt && refusalBand.prompt.qid === ev.qid) refusalBand.prompt = null;
      break;
    case 'snap_closed': if (_onSnapClosed) { try { _onSnapClosed(ev.reason || ''); } catch {} } break;
    case 'error':
      m.status = 'error';
      m.error = ev.message || ev.title || tt('出错了');
      // 撞限额：官方同款限额卡（LimitCard）按 limit 排版；5 小时限额另带自动续跑状态
      if (ev.limit) m.limit = ev.limit;
      if ('resume' in ev) noteLimitResume(ev.sessionId || session.id, ev.resume || null);
      settleTurn(m, 'error');
      if (ev.autoRetry && m.__sentHere) scheduleAutoRetry(m, ev.autoRetry);
      break;
    // 号池智能路由开跑前换了号（只发给主机 admin）：轻提示一下，只在发起这轮的那台设备上弹。
    case 'account_switch':
      if (m.__sentHere && ev.to) showToast(tt('已自动切到「{to}」（{reason}）', { to: ev.to, reason: tr(ev.reason || '') }));
      break;
    case 'interrupted': settleTurn(m, 'stopped'); break;
    // —— 后台任务生命周期：挂在对应工具行（toolUseId）的 task 上；Agent/Task/Workflow/Bash 的
    //    tool 事件先到（content_block_start），task_start 随后。找不到行【不再合成】：主线程的任务
    //    永远先有工具行；对不上的只可能是子 agent 名下的任务（服务端已按 owned_by_subagent 过滤，
    //    这里是第二道闸）——以前合成的 Bash 幽灵行没有 tool_done、永远 running，把分组头钉死在
    //    「Running a command」，正是 09-05 工作流卡「不出面板」那单的元凶之一。 ——
    case 'task_start': {
      const tuid = ev.toolUseId || '';
      const entry = tuid ? toolById.get(tuid) : null;
      if (!entry) break;
      // 工作流名：task_started.workflow_name → tool_args 的 input.name → 脚本头 meta={name}（prompt 是脚本前 300 字）
      const wfName = ev.workflowName || (ev.taskType === 'local_workflow'
        ? (workflowNameFromInput(entry.input) || workflowNameFromInput({ script: ev.prompt || '' }) || '') : '');
      ensureTask(entry, {
        taskId: ev.taskId, taskType: ev.taskType, description: ev.description, subagentType: ev.subagentType,
        workflowName: wfName, name: wfName, prompt: ev.prompt,
        backgrounded: typeof ev.backgrounded === 'boolean' ? ev.backgrounded : null, depth: ev.depth,
        status: 'running', startedAt: ev.at || Date.now(),
      });
      if (ev.taskId) taskById.set(ev.taskId, entry);
      if (tuid) taskById.set(tuid, entry);
      break;
    }
    case 'task_progress': {
      const entry = findTaskEntry(ev);
      if (!entry) break;
      const t = ensureTask(entry, { taskId: ev.taskId, status: 'running' });
      reviveTask(t);
      if (ev.usage) t.usage = usageOf(ev.usage);
      if (ev.lastTool) t.lastTool = ev.lastTool;
      if (ev.summary) t.summary = ev.summary;
      // 官方：description 只在还是占位（空/=taskId）时采纳；工作流 progress 的 description 是当前步骤
      if (ev.description) { if (!t.description || t.description === t.taskId) t.description = ev.description; else t.step = ev.description; }
      // workflow_progress 整快照透传：按 `${type}:${index}` 合并、补 startedAt（taskModel.mergeProgress）
      if (Array.isArray(ev.progress)) t.progress = mergeProgress(t.progress, ev.progress, ev.at || Date.now());
      if (!t.startedAt) t.startedAt = ev.at || Date.now();
      break;
    }
    case 'task_update': {
      const entry = findTaskEntry(ev);
      const t = entry && entry.task;
      if (!t) break;
      if (ev.status) t.status = ev.status === 'killed' ? 'stopped' : ev.status;   // pending/paused 原样，UI 当 running
      if (ev.description) t.description = ev.description;
      if (ev.error) t.error = ev.error;
      break;
    }
    case 'task_done': {
      const entry = findTaskEntry(ev);
      if (!entry) break;
      const t = ensureTask(entry, { taskId: ev.taskId });
      const at = ev.at || Date.now();
      t.status = normTaskStatus(ev.status);
      if (ev.summary) t.summary = ev.summary;
      if (ev.usage) t.usage = usageOf(ev.usage);
      if (ev.result) t.result = ev.result;
      if (ev.outputFile) t.outputFile = ev.outputFile;
      if (Array.isArray(ev.progress) && ev.progress.length) t.progress = mergeProgress(t.progress, ev.progress, at);
      if (t.progress.length) t.progress = settleProgress(t.progress, t.status);   // 官方 _t：残留 progress 态的 agent → error
      t.endedAt = at;
      break;
    }
    // 子 agent 转录（parent_tool_use_id 帧）：挂到父 Agent 工具行的 task.entries；task_start
    // 还没到就先立个 running 的 local_agent 记录（父行没找到=深层嵌套，丢弃）。
    case 'agent_msg': {
      const entry = ev.toolUseId ? toolById.get(ev.toolUseId) : null;
      if (!entry) break;
      // 工作流里的 agent 帧分不出是哪个 agent 的（SDK 帧只有 parent_tool_use_id、没有 agent_id），
      // 混着塞进 Workflow 行的 entries 既没人渲染又能堆出几千条——工作流的逐 agent 转录走磁盘 jsonl
      // 轮询（AgentTranscript），这里直接不收。
      if (entry.task && entry.task.taskType === 'local_workflow') break;
      appendAgentEntry(ensureTask(entry, { taskType: 'local_agent', status: 'running', startedAt: ev.at || Date.now() }), ev);
      break;
    }
    // 模型切换 / 安全栅门通知（system/model_*）：时间线卡 + 会话实际模型 + 输入栏横条数据源。
    // model_refusal_no_fallback 不动 m.status——由随后的 error/done 决定结局。
    case 'model_notice': {
      m.segments.push(noticeFromEvent(ev));
      // 「本会话实际模型」的记号只由 session{swapped} 落（服务端只在真换了会话模型时才发它）。这里不能按
      // scope 写：过载回退 model_fallback 帧没有 scope 字段却被填成 session、子 agent 内的 refusal 也是 session，
      // 照写会在会话模型根本没换时标「已切换到 X」，而普通 session 事件又不会把它清掉。
      if (ev.subtype === 'model_refusal_fallback' && ev.scope === 'session' && ev.to && !ev.parentToolUseId) {
        const sid = ev.sessionId || session.id || '';
        // attach 重放同一条通知：保留用户已点 X 的 dismissed，别把横条再弹回来
        const prev = refusalBand.notice;
        const key = ev.requestId || String(ev.at || '');
        const same = !!(prev && (prev.sessionId || '') === sid && (prev.requestId || String(prev.at || '')) === key);
        refusalBand.notice = { ...noticeFromEvent(ev), sessionId: sid, dismissed: same ? !!prev.dismissed : false };
      }
      break;
    }
    case 'retract': retractTurn(m, ev); break;   // 缓冲已在上面 flushText 过，截的是真实全文
    // 上下文压缩：循环组里一条「Compacting… → Compacted session · saved N tokens」，展开看压缩摘要
    case 'compact': applyCompact(m, ev); break;
    // 悬停收轮：主模型停笔但后台任务（子 agent / 工作流 / 后台 shell）还在跑，本轮挂起等它们
    //（服务端不发 done；CLI 会在任务完成时注入 task-notification 自动续轮）。运行状态行据此显示
    // 「等待后台任务…」——与真结束（status done、无状态行）可分；右侧工作台「任务」面板据此
    // 摆挂起横幅 + 逐条详情。count=0 = 任务刚清零、正在等模型续轮（收尾中）。
    case 'bg_hold': {
      const tasks = Array.isArray(ev.tasks) ? ev.tasks : [];
      m.bgHold = { count: typeof ev.count === 'number' ? ev.count : (tasks.length || 1), tasks, deadline: ev.deadline || 0 };
      // 后台 shell 的命令行只有服务端 Stop hook 拿得到——合并进对应工具行的 task 记录，
      // 任务面板展开即可见（工具行自带的 description 常常只是一句话概括）。
      // 清单里的任务就是还活着：工具行在前几轮（刷新后来自历史）时顺手找回并拉回 running，
      // 卡片状态才与任务面板的 Running 分组一致，之后的进度帧也有主可落。
      for (const t of tasks) {
        const entry = t && t.taskId ? findTaskEntry({ taskId: t.taskId }) : null;
        if (!entry || !entry.task) continue;
        reviveTask(entry.task);
        if (t.command && !entry.task.command) entry.task.command = t.command;
        if (t.kind && !entry.task.kind) entry.task.kind = t.kind;
      }
      break;
    }
    // 悬停被兜底收尾（封顶/静默/用户点「结束等待」）：挂起提示退场，紧随其后的 done 定局。
    case 'bg_release': m.bgHold = null; break;
    case 'gen_media_start':
      m.segments.push({ kind: 'media', id: ev.id, mediaKind: ev.kind, status: 'generating', elapsed: 0, error: null, prompt: '', dataUrl: null });
      break;
    case 'gen_media_progress': { const s = findMedia(m, ev.id); if (s) s.elapsed = ev.elapsed || 0; break; }
    // dataUrl：图片用内嵌 data: URI 直送（Claude 发截图走这条，绕开离线壳跨源 <img> 取图坏掉的问题）。
    case 'gen_media': { const s = findMedia(m, ev.id); if (s) { s.status = 'ready'; s.prompt = ev.prompt || ''; if (ev.dataUrl) s.dataUrl = ev.dataUrl; if (ev.ext) s.ext = ev.ext; } break; }
    case 'gen_media_error': { const s = findMedia(m, ev.id); if (s) { s.status = 'error'; s.error = ev.message || tt('生成失败'); } break; }
    case 'widget_start': case 'widget_delta': case 'widget': case 'widget_done': applyWidgetEvent(m, ev); break;
    case 'done': {
      if (!hasBody(m) && ev.result) textSeg(m).md += ev.result;
      if (Array.isArray(ev.attachments) && ev.attachments.length) m.attachments = toDeliverAtts(ev.attachments, ev.sessionId || session.id || '');
      settleTurn(m, 'done');
      m.status = 'done';
      break;
    }
  }
  if (ev.type === 'text' || ev.type === 'session' || ev.type === 'done') chat.reconnecting = false;
}

// ---- AskUserQuestion (multi-question, multi-select, custom, skip) -------------
function normOptions(options) {
  return (options || []).map((o) => (typeof o === 'string' ? { label: o, description: '' } : { label: o.label, description: o.description || '' }));
}
// AskUserQuestion → 作为一个 ask 段插进 m.segments（落在「提问前文字」和「回答后文字」之间），
// 答完转成只读「已回答」块常驻历史——不再是问句后 Claude 连贯输出、看不到用户答了什么。
function showQuestion(m, ev) {
  const list = Array.isArray(ev.questions) ? ev.questions : [ev];
  m.segments.push({
    kind: 'ask',
    qid: ev.qid,
    answered: false,
    cancelled: false,
    submitting: false,
    submitError: '',
    items: list.map((q) => ({
      header: q.header || '',
      question: q.question || q.text || '',
      options: normOptions(q.options),
      multi: !!q.multiSelect,
      selected: [],   // option labels
      custom: '',
    })),
  });
  session.pendingQid = ev.qid;
}
function findAsk(m, qid) {
  for (let i = m.segments.length - 1; i >= 0; i--) { const s = m.segments[i]; if (s.kind === 'ask' && s.qid === qid) return s; }
  return null;
}
// 后端「已回答」广播（本机答的 / 别设备答的 / 重连重放都走它）——标记 ask 段已回答 + 回填结构化选择。
function markAnswered(m, ev) {
  const seg = findAsk(m, ev.qid);
  if (!seg || seg.answered) return;
  if (Array.isArray(ev.answers)) {
    ev.answers.forEach((a, i) => {
      if (!seg.items[i] || !a) return;
      if (Array.isArray(a.selected)) seg.items[i].selected = a.selected.slice();
      if (a.custom) seg.items[i].custom = String(a.custom);
    });
  }
  seg.answered = true;
  seg.cancelled = !!ev.cancelled;
  seg.submitting = false;
  seg.submitError = '';
  if (session.pendingQid === ev.qid) session.pendingQid = null;
}
// 用户在本机点提交/跳过：先锁 submitting，POST 后由后端 answer 广播落定（markAnswered）；这里也兜底立即标记。
export async function answerQuestion(seg, { cancelled } = {}) {
  if (!seg || seg.answered || seg.submitting) return;
  seg.submitting = true;
  seg.submitError = '';
  const payload = cancelled
    ? { cancelled: true }
    : { answers: seg.items.map((it) => ({ selected: it.selected, custom: it.custom.trim() || undefined })) };
  try { await api.answer(seg.qid, payload); }
  catch (e) {
    seg.submitting = false;
    const detail = (e?.body && typeof e.body === 'object' ? (e.body.error || e.body.message) : e?.body) || e?.message || '';
    seg.submitError = detail && !/^HTTP \d+$/.test(detail) ? tt('提交失败：{detail}', { detail: tr(detail) }) : tt('提交失败，请重试');
    return;
  }   // POST 失败：保留选择、解锁并就地提示（后端仍在等这个答案）
  seg.answered = true;
  seg.cancelled = !!cancelled;
  seg.submitting = false;
  if (session.pendingQid === seg.qid) session.pendingQid = null;
}
