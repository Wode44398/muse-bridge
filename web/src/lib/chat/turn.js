// 一轮回答的段模型：新气泡、文本 / 工具 / 媒体段、工具行与后台任务索引、收轮兜底、安全栅门撤回、流式文本节流。

import { forgetTaskTool } from '../dock.svelte.js';
import { toolJoins, COMPACT_TOOL, isCompactTool } from '../toolVerbs.js';
import { retractSegments } from '../retract.js';
import { settleProgress, usageOf, taskRunning } from '../taskModel.js';
import { t as tt } from '../i18n.js';   // 本文件的 t 是工具行/任务局部变量，翻译函数取别名 tt
import { cardOf } from '../toolCard.js';   // 插件工具的结果卡片（[[bridge-card]] 段）
import { chat } from './store.svelte.js';
import { pendingTools } from './runHint.js';

// NB: after push, return the PROXIED element (chat.messages[i] / m.segments[i]),
// not the plain literal — Svelte 5 deep-proxies on push, and mutating the original
// reference bypasses the proxy so the UI never updates.
export function newAssistant() {
  // 新一轮：上一轮的工具/任务索引作废（别让旧 proxy 挂在 Map 里）——还在跑的后台任务除外：
  // 挂起接力后它们的进度/完成帧从下一轮的流里来，得还能找到上一轮那条工具行。
  resetToolIndex(true);
  chat.messages.push({
    role: 'assistant',
    // 段模型（与服务端 /api/session 历史重建同构，见 impl-contract §4.1）：
    //   {kind:'text',md} | {kind:'tools',open,tools:[{id,name,index,summary,input,status,ms,task}]} |
    //   {kind:'notice',subtype,from,to,…}（模型切换/安全栅门卡）| {kind:'ask',…} | {kind:'media',…}
    segments: [],
    thinking: '',
    thinkingOpen: false,
    status: 'streaming',
    error: null,
    tokens: 0,
    thinkingTokens: 0,
    startedAt: Date.now(),
    elapsed: 0,
    question: null,
    phase: 'shimmer',     // 星标运行相位（见 PHASE）：起步=shimmer 过渡态，首个事件落定
    idle: false,          // 长静默（排队/限流等）→ Thread 星标降成 waiting 慢呼吸
    bgHold: null,         // 悬停收轮（服务端 bg_hold）：{count,tasks,deadline}——本轮挂起等后台任务
    textBreak: false,     // 下一段正文另起一段（悬停续轮时置位，见 textSeg）
    // 状态行运行态（见 trackRun / computeHint）：wait=在等什么，think*=思考起止，hint=当前显示的那条。
    wait: 'sending', thinkStart: 0, thinkEnd: null, retry: null, compacting: false,
    hint: null, hintAt: 0, replayAt: 0,
  });
  pendingTools.clear();
  return chat.messages[chat.messages.length - 1];
}
export const cur = () => chat.messages[chat.messages.length - 1];

// textBreak：悬停续轮（后台任务跑完、CLI 唤醒模型接着说）的正文【另起一段】——不隔开的话
// 「已在后台启动」会和几分钟后的「后台命令已跑完…」粘成一句话（历史重建 sessions.mjs 同治）。
export function textSeg(m) {
  const last = m.segments[m.segments.length - 1];
  if (last && last.kind === 'text' && !m.textBreak) return last;
  m.textBreak = false;
  m.segments.push({ kind: 'text', md: '' });
  return m.segments[m.segments.length - 1];
}
function toolsSeg(m) {
  const last = m.segments[m.segments.length - 1];
  if (last && last.kind === 'tools') return last;
  m.segments.push({ kind: 'tools', tools: [], open: false });
  return m.segments[m.segments.length - 1];
}
// 最后一个 tools 段（不管后面有没有正文）——task_start 找不到对应工具行时合成条目的落点。
function lastToolsSeg(m) {
  for (let i = m.segments.length - 1; i >= 0; i--) if (m.segments[i].kind === 'tools') return m.segments[i];
  return null;
}
// 旧服务端兼容：tool_args 只带 content-block index 时按 index 从后往前找。
export function findToolByIndex(m, index) {
  if (typeof index !== 'number' || index < 0) return null;
  for (let i = m.segments.length - 1; i >= 0; i--) {
    const s = m.segments[i];
    if (s.kind === 'tools') { const t = s.tools.find((x) => x.index === index); if (t) return t; }
  }
  return null;
}
export function findMedia(m, id) {
  for (let i = m.segments.length - 1; i >= 0; i--) { const s = m.segments[i]; if (s.kind === 'media' && s.id === id) return s; }
  return null;
}

// —— 工具行 / 后台任务索引（模块级，存的是【proxy】）——
// toolById：tool_use id → tools 段条目；taskById：taskId 与 toolUseId 都指向同一条目（task_*
// 事件两个 id 都可能带）。newAssistant 与 attach 重放开头清空——重放会清掉 segments 再按
// 事件顺序重建，索引若不跟着清就会指向已不在视图里的旧对象。
export const toolById = new Map();
export const taskById = new Map();
// 进行中的压缩条目（status:compacting 起的行，还没等到带 uuid 的 boundary）——边界到了就把 id 补上。
let compactPending = null;
// 只留【仍在视图里】且任务在跑的条目（前几轮挂起的后台任务）。replaying = attach 重放的那条消息，
// 它自己的工具行随后整段清掉重建，也不能留。留下不在视图里的旧 proxy 会让重放的 tool 事件当成
//「已有行」跳过入段（卡片从对话里消失），之后的 task_* 帧全写进孤儿对象（任务面板只剩挂起清单
// 兜底出的空卡）。两条路径都踩过：本条仍在流式时 attach 就地重放；本条已被判成超时/切走收成
// 非流式时，attach 剪掉历史尾部再新建一条——旧那条已不在 chat.messages 里。
function toolsInView(except) {
  const set = new Set();
  for (const msg of chat.messages) {
    if (!msg || msg === except || msg.role !== 'assistant') continue;
    for (const s of (msg.segments || [])) if (s && s.kind === 'tools') for (const t of (s.tools || [])) set.add(t);
  }
  return set;
}
export function resetToolIndex(keepRunningTasks = false, replaying = null) {
  compactPending = null;
  if (!keepRunningTasks) { toolById.clear(); taskById.clear(); return; }
  const inView = toolsInView(replaying);
  const alive = (v) => !!(v && inView.has(v) && v.task && taskRunning(v.task.status));
  for (const [k, v] of toolById) if (!alive(v)) toolById.delete(k);
  for (const [k, v] of taskById) if (!alive(v)) taskById.delete(k);
}
function forgetEntry(entry) {
  for (const [k, v] of toolById) if (v === entry) toolById.delete(k);
  for (const [k, v] of taskById) if (v === entry) taskById.delete(k);
  forgetTaskTool(entry);   // 工作台任务视图里挂着的就是这条被撤回的行 → 收掉
}

// 插件工具的结果卡片：条目 / tool_done 帧带 card（对象）、content（MCP content）或 result（文字）任一种都认
export const cardOfTool = (x) => cardOf(x.card) || cardOf(x.content) || cardOf(x.result);
// 工具行条目的统一形状——直播 push 与历史归一共用一份，组件与指纹都靠它稳定。
export function makeTool(x) {
  const card = cardOfTool(x);
  return {
    id: x.id || '', name: x.name || '', index: typeof x.index === 'number' ? x.index : -1,
    summary: x.summary || '', input: x.input && typeof x.input === 'object' ? x.input : {},
    status: x.status || 'running',   // running | done | error（tool_done 落定；收轮时兜底）
    ms: x.ms || 0,
    ...(x.synthetic ? { synthetic: true } : {}),     // task_start 抢在工具事件前合成的行
    ...(x.interrupted ? { interrupted: true } : {}), // 轮出错/中断时还没回结果的工具
    ...(x.denied ? { denied: x.denied } : {}),       // 审批被拒 / 自动模式拦下（ToolRow 尾巴 Denied）
    ...(x.compact ? { compact: makeCompact(x.compact) } : {}),   // 上下文压缩条目（name=COMPACT_TOOL）
    task: x.task ? makeTask(x.task) : null,
    ...(card ? { card } : {}),   // 插件工具的结果卡片（render:'card'，lib/toolCard）
    ...(x.images > 0 ? { images: Math.min(24, x.images | 0) } : {}),   // 结果里的图片张数（状态行缩略图条，图按 /api/tool-image 取）
    ...(x.t0 ? { t0: x.t0 } : {}),   // 直播开始时刻（状态行行内计时；历史行没有）
  };
}
// 压缩条目的载荷：token 数给官方文案「Compacted session · saved N tokens」，summary = 压缩后注入的
// 摘要正文（行展开的详情），error = 失败原因。直播 compact 事件与历史重建（sessions.mjs）同形。
function makeCompact(c) {
  return {
    trigger: c.trigger === 'manual' ? 'manual' : 'auto',
    preTokens: Number(c.preTokens) || 0, postTokens: Number(c.postTokens) || 0,
    summary: typeof c.summary === 'string' ? c.summary : '', error: c.error || '',
  };
}
// 直播 compact 事件（服务端 claude.mjs 转 SDK 的 status / compact_boundary / 摘要帧）。帧序不固定
//（手动 /compact 时 end 先于 boundary 到），各阶段都按「找到就补、找不到就建」写，重放幂等。
export function applyCompact(m, ev) {
  const byId = ev.id ? toolById.get(ev.id) : null;
  const open = () => pushTool(m, { name: COMPACT_TOOL, status: 'running', compact: {} });
  switch (ev.phase) {
    case 'start':
      if (!compactPending) compactPending = open();
      break;
    case 'end': {
      const t = compactPending;
      if (!t) break;
      if (ev.ok === false) { t.status = 'error'; t.compact.error = ev.error || ''; compactPending = null; }
      else t.status = 'done';   // 仍挂着 pending：随后的 boundary 补 id 与 token 数
      break;
    }
    case 'boundary': {
      const t = byId || compactPending || open();
      compactPending = null;
      t.status = 'done';
      if (ev.id && t.id !== ev.id) { t.id = ev.id; toolById.set(ev.id, t); }
      if (typeof ev.ms === 'number' && ev.ms > 0) t.ms = ev.ms;
      t.compact.trigger = ev.trigger === 'manual' ? 'manual' : 'auto';
      t.compact.preTokens = Number(ev.preTokens) || 0;
      t.compact.postTokens = Number(ev.postTokens) || 0;
      break;
    }
    case 'summary':
      if (byId && byId.compact && typeof ev.summary === 'string') byId.compact.summary = ev.summary;
      break;
  }
}
// 后台任务记录：Agent/Task/Workflow/后台 Bash 的 task_* 生命周期挂在它的工具行上。
function makeTask(x) {
  return {
    taskId: x.taskId || '', taskType: x.taskType || '',
    description: x.description || '', subagentType: x.subagentType || '',
    workflowName: x.workflowName || x.name || '', name: x.name || x.workflowName || '',
    prompt: x.prompt || '', backgrounded: typeof x.backgrounded === 'boolean' ? x.backgrounded : null,
    command: x.command || '',                                   // 后台 shell 的命令行（历史 tool_use.input / 直播 Stop hook）
    depth: typeof x.depth === 'number' ? x.depth : 0,
    // running | completed | failed | stopped | unknown（历史无记录）| pending/paused（task_update 原样，UI 当 running）
    status: x.status || 'unknown',
    startedAt: x.startedAt || 0, endedAt: x.endedAt || 0,
    usage: usageOf(x.usage), lastTool: x.lastTool || '', summary: x.summary || '', error: x.error || '',
    result: x.result || '', outputFile: x.outputFile || '',
    step: x.step || '',                                         // Workflow：task_progress 报的当前步骤（"Ping: ping:a"）
    progress: Array.isArray(x.progress) ? x.progress : [],       // Workflow：合并后的 workflow_progress 快照
    phasesMeta: Array.isArray(x.phasesMeta) ? x.phasesMeta : [], // Workflow：脚本 meta.phases（历史回落占位）
    entries: Array.isArray(x.entries) ? x.entries : [],          // Agent：子转录 {kind:'text',text}|{kind:'tools',tools:[{name,summary}]}|{kind:'thinking'}
    toolCount: x.toolCount || 0, latestToolName: x.latestToolName || '', model: x.model || '',
  };
}
// 工具行入段（官方 HD 分桶）：standalone 桶的工具（Workflow 等，toolVerbs.STANDALONE_TOOLS）自己一段，
// 它后面的工具也另起一段；其余连续 tool_use 并进同一段。服务端历史重建 sessions.mjs 同构。
export function pushTool(m, x) {
  const last = m.segments[m.segments.length - 1];
  const prev = last && last.kind === 'tools' && last.tools.length ? last.tools[last.tools.length - 1] : null;
  const join = last && last.kind === 'tools' && toolJoins(prev ? prev.name : '', x.name);
  if (!join) m.segments.push({ kind: 'tools', tools: [], open: false });
  const seg = m.segments[m.segments.length - 1];
  seg.tools.push(makeTool({ t0: Date.now(), ...x }));
  const entry = seg.tools[seg.tools.length - 1];   // 取回 proxy（push 进 $state 后原字面量不再响应）
  if (entry.id) toolById.set(entry.id, entry);
  return entry;
}
// 给工具行挂 / 补任务记录：已有则只补空字段——entries/progress 不动（agent_msg 可能比
// task_start 先到），status 只允许 unknown/running 被推进。
export function ensureTask(entry, seed) {
  if (!entry.task) { entry.task = makeTask(seed); return entry.task; }
  const t = entry.task;
  for (const k of Object.keys(seed)) {
    const v = seed[k];
    if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue;
    if (k === 'status') { if (t.status === 'unknown' || t.status === 'running') t.status = v; continue; }
    if (t[k] == null || t[k] === '' || t[k] === 0 || t[k] === false) t[k] = v;
  }
  return t;
}
export function findTaskEntry(ev) {
  return (ev.taskId && taskById.get(ev.taskId)) || (ev.toolUseId && (taskById.get(ev.toolUseId) || toolById.get(ev.toolUseId)))
    || adoptHistoryTask(ev.taskId, ev.toolUseId);
}
// 挂起接力后刷新 / 换设备：发起后台任务的工具行在前几轮，来自历史重建（toUiMessages），从没进过索引——
// 当前这一轮的 task_* 帧会全部找不到主而丢掉（卡片停在 unknown → 显示 Completed、Phases 只剩 meta 占位）。
// 索引里没有就按 taskId / tool_use id 从视图里反查一次，找到就补进索引。
function adoptHistoryTask(taskId, toolUseId) {
  if (!taskId && !toolUseId) return null;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const msg = chat.messages[i];
    if (!msg || msg.role !== 'assistant') continue;
    for (const s of (msg.segments || [])) {
      if (!s || s.kind !== 'tools') continue;
      for (const tl of (s.tools || [])) {
        if (!tl || !tl.task) continue;
        if (!((taskId && tl.task.taskId === taskId) || (toolUseId && tl.id === toolUseId))) continue;
        if (tl.task.taskId) taskById.set(tl.task.taskId, tl);
        if (tl.id) taskById.set(tl.id, tl);   // 不进 toolById：那张表管「入段去重」，历史行塞进去会让重放的同 id 工具帧被当成已有行跳过
        return tl;
      }
    }
  }
  return null;
}
// 服务端电平说它还活着（bg_hold 清单 / 新到的进度帧）：历史里的 unknown、或 normSeg 兜底收成的 stopped 拉回 running
export function reviveTask(t) {
  if (!t) return;
  if (t.status === 'unknown' || t.autoStopped) {
    t.status = 'running';
    t.endedAt = 0;
    if (t.autoStopped) { t.autoStopped = false; if (t.summary === tt('进程结束时中止')) t.summary = ''; }
  }
}
// 子 agent 转录条目（agent_msg）：连续文本并成一条、连续工具并成一组、思考只留占位。
export function appendAgentEntry(t, ev) {
  const list = t.entries;
  const last = list[list.length - 1];
  if (ev.kind === 'text') {
    const text = ev.text || '';
    if (!text) return;
    if (last && last.kind === 'text') last.text += (last.text ? '\n\n' : '') + text;
    else list.push({ kind: 'text', text });
  } else if (ev.kind === 'tool') {
    const tool = { name: ev.name || '', summary: ev.summary || '' };
    if (last && last.kind === 'tools') last.tools.push(tool);
    else list.push({ kind: 'tools', tools: [tool] });
    t.toolCount += 1;
    if (tool.name) t.latestToolName = tool.name;
  } else if (ev.kind === 'thinking') {
    if (!last || last.kind !== 'thinking') list.push({ kind: 'thinking' });
  }
  if (ev.model) t.model = ev.model;
}
// 模型切换 / 安全栅门通知段（直播 model_notice 事件与历史 notice 段共用一个形状）。
export function noticeFromEvent(ev) {
  return {
    kind: 'notice', subtype: ev.subtype || '', direction: ev.direction || '', scope: ev.scope || '',
    from: ev.from || '', to: ev.to || '', trigger: ev.trigger || '', category: ev.category || null,
    explanation: ev.explanation || '', text: ev.text || '', requestId: ev.requestId || '',
    refusedUserUuid: ev.refusedUserUuid || '', retracted: Array.isArray(ev.retracted) ? ev.retracted.slice() : [],
    parentToolUseId: ev.parentToolUseId || '', at: ev.at || Date.now(),
  };
}
// 收轮兜底：还挂着 running 的工具行 / 后台任务给个终态（tool_done 只在 tool_result 回来时
// 发，出错/中断的轮永远等不到它）。done：工具行=done；Agent/Workflow 任务若还 running，说明
// 悬停看门狗放弃了它（bridge 只为这两类悬停）→ stopped；后台 shell 可以常驻，不动。
// error/stopped：工具行=error+interrupted，所有 running 任务=stopped。

export function settleTurn(m, how) {
  for (const s of m.segments) {
    if (s.kind !== 'tools') continue;
    for (const t of s.tools) {
      // 压缩行没等到边界就收轮 = 这次压缩没成（成功必有 boundary 补上 id）
      if (isCompactTool(t) && t.status === 'running') { t.status = t.id ? 'done' : 'error'; continue; }
      if (t.status === 'running') { t.status = how === 'done' ? 'done' : 'error'; if (how !== 'done') t.interrupted = true; }
      const k = t.task;
      // 收轮 = SDK 收尾 = CLI 进程结束，【任何】还在跑的后台任务都跟着死（09-15 起后台 shell
      // 也一样：以前放它过去，是按「dev server 可能常驻」的老假设，结果面板里永远挂着一条假的
      // Running。现在只要走到收轮，后台任务要么早已完成、要么刚被一起收掉）。
      if (k && taskRunning(k.status)) {
        k.status = 'stopped';
        if (!k.summary) k.summary = how === 'done' ? 'Ended when the turn finished' : 'Stopped before completion';
        k.endedAt = Date.now();
        if (k.progress.length) k.progress = settleProgress(k.progress, 'stopped');
      }
    }
  }
}
// —— 安全栅门撤回（retract）：把本轮已渲染的内容按服务端算出的【区间】删掉——
// 被拒模型在 client lane 下可能已经流出半截正文/工具行，回退模型会重来一遍；服务端按 uuid 对账
//（runtime/retract-ledger.mjs）给出 {textFrom,textTo,thinkFrom,thinkTo,toolsFrom,toolsTo}，区间之后已流出的
// 回退模型开头原样保留。删法在 lib/retract.js（纯函数，node 单测覆盖），这里只挂索引清理。
export function retractTurn(m, ev) { retractSegments(m, ev, forgetEntry); }
// 有「正文类」内容（文本/工具行/媒体）——done.result 兜底只看它；hasContent 另认 notice 段
//（只剩一张切换卡的轮也不是空幽灵轮，settleView 不许 pop）。
export function hasBody(m) {
  return m.segments.some((s) => (s.kind === 'text' && s.md.trim()) || (s.kind === 'tools' && s.tools.length) || s.kind === 'media' || s.kind === 'widget');
}
export function hasContent(m) {
  return hasBody(m) || m.segments.some((s) => s.kind === 'notice');
}
// 通知快照用：当前回复的最后一段可见文本。
export function lastText(m) {
  for (let i = m.segments.length - 1; i >= 0; i--) { const s = m.segments[i]; if (s.kind === 'text' && s.md) return s.md; }
  return '';
}

// —— 流式文本节流：text 增量先入缓冲，100ms 批量刷进响应式状态 ——
// 每个 token 都触发 Thread 里整段 markdown 重 parse + DOM 替换，是长回答打字机卡顿
// 的根源（O(n²)）。批量后肉眼仍是连续打字机，重渲染次数降一个数量级。
let txtBuf = '', txtSeg = null, txtTimer = null;
export function flushText() {
  if (txtTimer) { clearTimeout(txtTimer); txtTimer = null; }
  if (txtSeg && txtBuf) txtSeg.md += txtBuf;
  txtBuf = ''; txtSeg = null;
}
export function dropText() { txtBuf = ''; txtSeg = null; if (txtTimer) { clearTimeout(txtTimer); txtTimer = null; } }
export function queueText(m, t) {
  const seg = textSeg(m);
  if (txtSeg && txtSeg !== seg) flushText();
  txtSeg = seg; txtBuf += t;
  if (!txtTimer) txtTimer = setTimeout(flushText, 100);
}
