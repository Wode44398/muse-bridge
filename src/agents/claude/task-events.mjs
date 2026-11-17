// SDK 的任务帧 → 前端任务卡的事件。

import { annotateWorkflowEfforts, clip, taskUsage, normTaskStatus, readWorkflowOutput } from '../../runtime/tool-summary.mjs';

// 工具行摘要 toolSummary / 露不露 toolShown：见 runtime/tool-summary.mjs（与历史重建共用，别在这里再抄一份）。

// SDK 任务生命周期帧 → 前端 Agent 卡 / 工作流卡的 SSE 事件（按 tool_use id 挂到对应工具行上，taskId 二级键）。
// 保证到的一对是 task_started + task_notification；task_progress（agentProgressSummaries 开着才有
// summary，~30s 一次）与 task_updated 是中途补充。
// 过滤：ambient / skip_transcript 的杂务任务（dream / 自动扫描之类）与 spawned_session 不进时间线。
// local_bash（后台 shell）/ mcp_task 照发——前端按 taskType 决定形态（shell 走轻量行）。
// task_progress 的 workflow_progress（d.ts 未声明、探针实测存在的完整快照）整数组原样透传：它是工作流卡
// 点阵 / Phases 面板的唯一数据源。task_notification 对 local_workflow 顺手读 .output（JSON，best-effort，
// ≤2MB）补最终 progress / result——完成通知本身没有逐 agent 数据。
// taskTypes：本轮 taskId → task_type（task_notification 帧不带类型，读 .output 前要知道是不是工作流）。
// guard（2026-09-05）：只放行【主线程自己发起】的任务。CLI 2.1.257 给每条前台 shell 都注册 local_bash 任务，
// 子 agent / 工作流里的 agent 跑的 shell 也往主流发 task_started（带 d.ts 没写的 owned_by_subagent:true、
// tool_use_id 是子 agent 自己的 tool_use）；以前照转，前端找不到工具行就合成一条永远 running 的幽灵
// 「Running a command」——一个 16 agent 的工作流能塞进几百条。判据两道：owned_by_subagent 明示的直接丢；
// task_started 的 tool_use_id 不是本轮主线程露出过的工具行也丢（记进 foreignTasks，后续同 taskId 的
// progress / updated / notification 一并丢）。没有 tool_use_id 的（resume 回来的后台 agent）同样不进时间线。
const AGENT_TASK_TYPES = new Set(['local_agent', 'remote_agent', 'in_process_teammate']);
// autoServed(name) → { model, effort }：auto:<档> 的 agent 补上 bridge 改写请求时的真实落点（工作流面板显示真实模型与档位）。
// wf = { dir(): <会话>/subagents | '', cache: Map }：点名模型的 agent（不是 auto:<档>）档位只在它自己的转录里，
// 运行中也读出来（按 agent 缓存，见 annotateWorkflowEfforts），不用等收轮后历史重建才显示。
export function emitTaskEvent(send, msg, taskTypes, guard, autoServed, wf) {
  const wfp = (p) => {
    let dir = '';
    try { dir = wf ? wf.dir() || '' : ''; } catch { /* 拿不到会话目录就只补 auto agent */ }
    return autoServed || dir ? annotateWorkflowEfforts(p, dir, autoServed, wf && wf.cache) : p;
  };
  const taskId = msg.task_id;
  if (!taskId) return;
  if (msg.ambient || msg.skip_transcript) return;
  if (msg.task_type === 'spawned_session') return;
  if (guard) {
    if (msg.owned_by_subagent === true) { guard.foreignTasks.add(taskId); return; }
    if (msg.subtype === 'task_started') {
      const tuid = msg.tool_use_id || '';
      if (!tuid || !guard.mainTools.has(tuid)) { guard.foreignTasks.add(taskId); return; }
    } else if (guard.foreignTasks.has(taskId)) return;
  }
  const at = Date.now();
  if (msg.subtype === 'task_started') {
    if (taskTypes && msg.task_type) taskTypes.set(taskId, msg.task_type);
    send({
      type: 'task_start', taskId, toolUseId: msg.tool_use_id || null,
      taskType: msg.task_type || '', description: msg.description || '', subagentType: msg.subagent_type || '',
      workflowName: msg.workflow_name || '',
      prompt: clip(msg.prompt, 300),   // local_workflow 的 prompt 是整段脚本，只留前 300
      backgrounded: !!msg.is_backgrounded || msg.task_type === 'local_workflow',
      depth: Number(msg.spawn_depth) || 0,
      at,
    });
  } else if (msg.subtype === 'task_progress') {
    send({
      type: 'task_progress', taskId, toolUseId: msg.tool_use_id || null,
      description: msg.description || '', lastTool: msg.last_tool_name || '', summary: msg.summary || '',
      usage: taskUsage(msg.usage),
      ...(Array.isArray(msg.workflow_progress) ? { progress: wfp(msg.workflow_progress) } : {}),
      at,
    });
  } else if (msg.subtype === 'task_updated') {
    const p = msg.patch || {};
    send({
      type: 'task_update', taskId,
      ...(p.status ? { status: String(p.status) } : {}),
      ...(p.description ? { description: String(p.description) } : {}),
      ...(p.error ? { error: String(p.error) } : {}),
      at,
    });
  } else if (msg.subtype === 'task_notification') {
    const ev = {
      type: 'task_done', taskId, toolUseId: msg.tool_use_id || null,
      status: normTaskStatus(msg.status), summary: msg.summary || '',
      usage: taskUsage(msg.usage), outputFile: msg.output_file || '', at,
    };
    const tt = taskTypes ? taskTypes.get(taskId) : '';
    if (tt === 'local_workflow' || (!tt && /^Dynamic workflow\b/.test(ev.summary))) {
      const o = readWorkflowOutput(msg.output_file);
      if (o) {
        if (o.progress) ev.progress = wfp(o.progress);
        if (o.result != null) ev.result = o.result;
      }
    } else if (AGENT_TASK_TYPES.has(tt) && ev.summary) {
      // 子 agent：SDK 帧的 summary 就是它的最终回复（probe 实测 summary:"ok"）；历史重建从 <task-notification>
      // 拿到的是 summary='Agent "…" finished' + result='ok'——两边都把结论落在 result，刷新前后同一张卡不换文案。
      ev.result = clip(ev.summary, 600);
    }
    send(ev);
  }
}
