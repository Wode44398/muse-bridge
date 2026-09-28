// 后台任务 / 动态工作流的【纯函数】模型层——chat 内核（chat.svelte.js）写，claude/ 下的
// 组件（ToolGroup / WorkflowCard / AgentDots / TaskSheet）读。没有 rune、不碰 DOM，
// 可以在 Node 里直接单测（scratchpad/verify-kernel）。
//
// 算法全部照官方 /code 页（Claude 桌面客户端 ion bundle）原样移植，锚点见
// specs/workflow-panel.md §2.4：nt=mergeProgress、_t=settleProgress、pD=agentState、
// hD=deriveWorkflow、mD=agentDotStates、y()=workflowNameFromInput、wD=reasonFromSummary、
// JL=taskNoun。改动之处都在注释里标了「偏离」。
//
// 术语：progress = SDK task_progress 帧透传的 workflow_progress 快照（完整快照、已滤 log），
// 条目形状（实测）：
//   {type:'workflow_phase', index, title}
//   {type:'workflow_agent', index, label, phaseIndex, phaseTitle, agentId, model,
//    state:'start'|'progress'|'done'|'error', startedAt, queuedAt, attempt, promptPreview,
//    lastProgressAt, tokens, toolCalls, durationMs, resultPreview, error?, skipped?, blocked?, cached?}

export const STALL_MS = 90_000;   // 官方：progress 态 90s 没心跳 → stalled

// —— usage 归一：SDK / 服务端 / 历史三种键名都收成 {tokens, toolUses, ms} ——
// task_progress.usage 原生是 {total_tokens,tool_uses,duration_ms}；服务端契约发
// {tokens,toolUses,ms}；<task-notification> 里是 subagent_tokens。全部认。
export function usageOf(u) {
  if (!u || typeof u !== 'object') return null;
  const num = (...keys) => {
    for (const k of keys) { const v = u[k]; if (typeof v === 'number' && Number.isFinite(v)) return v; }
    return 0;
  };
  return {
    tokens: num('tokens', 'total_tokens', 'totalTokens', 'subagent_tokens'),
    toolUses: num('toolUses', 'tool_uses'),
    ms: num('ms', 'duration_ms', 'durationMs'),
  };
}

// —— 任务状态归一（官方 V()）：running/completed/failed/stopped 原样，killed→stopped，其余→completed ——
export function normTaskStatus(s) {
  if (s === 'running' || s === 'completed' || s === 'failed' || s === 'stopped') return s;
  if (s === 'killed') return 'stopped';
  return 'completed';
}
// 任务在 UI 上算「还在跑」：task_updated 的 pending/paused 保留原样，但按 running 显示。
export function taskRunning(status) {
  return status === 'running' || status === 'pending' || status === 'paused';
}

// —— 2.4.1 workflow_progress 合并（官方 nt）——
// 快照按 `${type}:${index}` 覆盖；agent 的 startedAt 继承上一版同 index 的值，都没有且
// 已不是 start 态 → 用这一帧的时刻（now）——点阵计时/卡死判定都靠它。
export function mergeProgress(prev, incoming, now = Date.now()) {
  const stamp = (e, old) => {
    if (!e || e.type !== 'workflow_agent' || e.startedAt !== undefined) return e;
    const inherited = old && old.type === 'workflow_agent' ? old.startedAt : undefined;
    if (inherited !== undefined) return { ...e, startedAt: inherited };
    return e.state === 'start' ? e : { ...e, startedAt: now };
  };
  const list = Array.isArray(incoming) ? incoming.filter(Boolean) : [];
  if (!prev || !prev.length) return list.map((e) => stamp(e, undefined));
  const map = new Map();
  for (const e of prev) if (e) map.set(`${e.type}:${e.index}`, e);
  for (const e of list) { const k = `${e.type}:${e.index}`; map.set(k, stamp(e, map.get(k))); }
  return Array.from(map.values());
}

// —— 2.4.2 收尾（官方 _t）——
// 工作流已结束（任务非 running）但快照里仍是 progress 态的 agent → 改成 error，文案
// 按任务终态区分 stopped / 其它；只有真改过才返回新数组（引用稳定=不白触发重渲染）。
export function settleProgress(list, taskStatus) {
  if (!Array.isArray(list) || !list.length) return list || [];
  let changed = false;
  const out = list.map((e) => {
    if (!e || e.type !== 'workflow_agent' || e.state !== 'progress') return e;
    changed = true;
    return { ...e, state: 'error', error: e.error ?? (taskStatus === 'stopped' ? 'Stopped before completion' : 'Workflow ended before completion') };
  });
  return changed ? out : list;
}

// —— 2.4.3 单 agent 显示态（官方 pD）：done / error / running / stalled / pending ——
export function agentState(entry, opts) {
  if (!entry) return 'pending';
  if (entry.state === 'done') return 'done';
  if (entry.state === 'error') return 'error';
  if (entry.state === 'progress') {
    const now = opts && opts.now;
    const stallMs = (opts && opts.stallMs) ?? STALL_MS;
    return now !== undefined && entry.lastProgressAt !== undefined && now - entry.lastProgressAt > stallMs ? 'stalled' : 'running';
  }
  return 'pending';   // state === 'start'（排队中）
}

// 点阵用（官方 mD）：每格 {label, state}。
export function agentDotStates(list, opts) {
  return (Array.isArray(list) ? list : []).filter((e) => e && e.type === 'workflow_agent').map((e) => ({ label: e.label, state: agentState(e, opts) }));
}

export const EMPTY_COUNTS = Object.freeze({ done: 0, running: 0, stalled: 0, error: 0, pending: 0, total: 0 });

function bump(counts, entry, now, stallMs) {
  counts.total += 1;
  const s = agentState(entry, { now, stallMs });
  if (s === 'stalled') { counts.running += 1; counts.stalled += 1; }   // 卡死同时计入 running
  else counts[s] += 1;
}
// phase 状态（官方 gD）：有 error → error；有 running → settled 时算 done 否则 running；
// 空 phase 或全排队 → pending；全 done 或已 settled → done；其余 running。
function phaseStatus(c, settled) {
  if (c.error > 0) return 'error';
  if (c.running > 0) return settled ? 'done' : 'running';
  if (c.total === 0 || c.pending === c.total) return 'pending';
  return (c.done === c.total || settled) ? 'done' : 'running';
}

// —— 2.4.3 进度树派生（官方 hD）——
// 层级 workflow → phase → agent：phase 来自 workflow_phase 记录或 agent 自带的
// phaseIndex/phaseTitle；没有 phase 信息的 agent 归入「当前 phase」，再没有就归入
// index 0 的 Phase 1。返回 {counts, phases:[{index,title,agents,counts,status,totalTokens,maxDurationMs}], totalTokens}；
// 空快照返回 undefined（与官方一致，调用方按假值处理）。
// 偏离：非 workflow_agent / workflow_phase 的记录（如漏网的 workflow_log）直接跳过——官方
// 会把它当 agent 计入 pending，那是它上游已滤 log 的前提下才安全的写法。
export function deriveWorkflow(list, opts) {
  if (!Array.isArray(list) || !list.length) return undefined;
  const now = opts && opts.now;
  const stallMs = (opts && opts.stallMs) ?? STALL_MS;
  const settled = (opts && opts.settled) ?? false;
  const phases = [];
  const byIndex = new Map();
  let current;
  const phase = (index, title) => {
    let p = byIndex.get(index);
    if (p) {
      if (title && p.title.startsWith('Phase ')) p.title = title;   // 占位标题被真标题替换
    } else {
      p = { index, title: title ?? `Phase ${index + 1}`, agents: [], counts: { ...EMPTY_COUNTS }, status: 'pending', totalTokens: 0, maxDurationMs: undefined };
      byIndex.set(index, p);
      phases.push(p);
    }
    return p;
  };
  const counts = { ...EMPTY_COUNTS };
  let totalTokens = 0;
  for (const e of list) {
    if (!e) continue;
    if (e.type === 'workflow_phase') { current = phase(e.index, e.title); continue; }
    if (e.type !== 'workflow_agent') continue;
    const p = e.phaseIndex !== undefined ? phase(e.phaseIndex, e.phaseTitle) : (current ?? phase(0, undefined));
    p.agents.push(e);
    bump(p.counts, e, now, stallMs);
    bump(counts, e, now, stallMs);
    if (e.tokens) { p.totalTokens += e.tokens; totalTokens += e.tokens; }
    if (e.durationMs !== undefined) p.maxDurationMs = Math.max(p.maxDurationMs ?? 0, e.durationMs);
  }
  for (const p of phases) p.status = phaseStatus(p.counts, settled);
  phases.sort((a, b) => a.index - b.index);
  return { counts, phases, totalTokens };
}

// —— 工作流名（官方 y()）：input.name → 脚本里 `meta = { name: '…' }` → scriptPath 文件名 ——
// bridge 的 tool_args.input 只带安全子集（Workflow 只有 name），所以 chat 内核还会拿
// task_start.prompt（脚本前 300 字）当 script 再试一次——meta 声明照例在脚本开头。
const META_NAME_RE = /\bmeta\s*=\s*\{[^}]*?\bname\s*:\s*['"]([^'"]+)['"]/;
export function workflowNameFromInput(input) {
  if (!input || typeof input !== 'object') return undefined;
  if (typeof input.name === 'string' && input.name) return input.name;
  if (typeof input.script === 'string') {
    const m = input.script.slice(0, 4096).match(META_NAME_RE);
    if (m) return m[1];
  }
  if (typeof input.scriptPath === 'string' && input.scriptPath) {
    const base = input.scriptPath.split(/[\\/]/).pop();
    return base ? base.replace(/\.[^.]+$/, '') : undefined;
  }
  return undefined;
}

// —— 失败 / 停止原因（官方 wD）——
// summary 缺失或等于 description → 无原因；`Workflow "x" failed: 原因` 抠冒号后那段并首字母
// 大写；不匹配模板的 summary 整句当原因。
const WF_SUMMARY_RE = /^(?:Dynamic w|W)orkflow ".*" (?:completed|failed|stopped|was killed)(?::\s*(.+))?\.?\s*$/s;
const capitalize = (s) => (s.length > 0 ? s[0].toUpperCase() + s.slice(1) : s);
export function reasonFromSummary(summary, description) {
  if (!summary || summary === description) return undefined;
  const m = summary.match(WF_SUMMARY_RE);
  if (m) { const r = m[1] && m[1].trim(); return r ? capitalize(r) : undefined; }
  return capitalize(summary);
}

// —— 工具行 → 任务种类 / 终态（TasksPanel / WorkflowDetail / TaskRow / AgentTranscript 共用）——
// 种类（官方 jD / OF）：工具名优先，历史合成行靠 taskType；不是任务型工具返回 ''。
const AGENT_TASK_TYPES = /^(local_agent|remote_agent|in_process_teammate)$/;
export function toolTaskKind(tool) {
  if (!tool) return '';
  const tt = tool.task ? tool.task.taskType : '';
  if (tool.name === 'Workflow' || tt === 'local_workflow') return 'workflow';
  if (tool.name === 'Agent' || tool.name === 'Task' || AGENT_TASK_TYPES.test(tt)) return 'agent';
  return tool.task ? 'task' : '';
}
// 终态：task 记录优先（pending/paused 按 running）；历史没记录（unknown）时按工具行结果推——
// error 且被中断=stopped、error=failed、还在跑=running、其余 completed（官方 zD 的 f/m 分支）。
export function toolTaskStatus(tool) {
  if (!tool) return '';
  const st = tool.task ? tool.task.status : '';
  if (taskRunning(st)) return 'running';
  if (st === 'completed' || st === 'failed' || st === 'stopped') return st;
  if (tool.status === 'running') return 'running';
  if (tool.status === 'error') return tool.interrupted ? 'stopped' : 'failed';
  return 'completed';
}
// 面板标题（官方 RD：title ?? task.name ?? description；Agent 面板标题 = description）。
export function toolTaskTitle(tool) {
  if (!tool) return '';
  const task = tool.task;
  const kind = toolTaskKind(tool);
  if (task && (task.name || task.workflowName)) return task.name || task.workflowName;
  if (kind === 'workflow') return workflowNameFromInput(tool.input) || (task && task.description) || tool.summary || 'Workflow';
  return (task && task.description) || tool.summary || (kind === 'agent' ? 'Agent' : 'Task');
}

// —— 任务类型 → 名词（官方 JL）：shell / agent / workflow / monitor / task（plural 加 s）——
export function taskNoun(taskType, plural = false) {
  const t = String(taskType || '');
  let n = 'task';
  if (t === 'local_bash') n = 'shell';
  else if (t === 'local_agent' || t === 'remote_agent' || t === 'in_process_teammate') n = 'agent';
  else if (t === 'local_workflow') n = 'workflow';
  else if (t.startsWith('monitor')) n = 'monitor';
  return plural ? n + 's' : n;
}
