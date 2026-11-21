// 把 Claude 转录（.jsonl）解析成聊天记录：注入轮过滤、问答 / 计划 / 媒体 / 子 agent / 工具结果、回滚链、导出 markdown。
import { cardOf } from '../../plugins/tool-card.mjs';
import path from 'node:path';
import { createReadStream, readFileSync } from 'node:fs';
import readline from 'node:readline';
import { splitAnswerList } from '../../runtime/questions.mjs';
import { peerDisplay, peerFromRecord } from '../../runtime/session-peers.mjs';
import { classifyError, limitNotice } from '../../runtime/status.mjs';
import { countToolImages } from '../../runtime/tool-images.mjs';
import { autoServed } from '../../runtime/model-ratings.mjs';
import { HOST_OWNER } from '../../runtime/principal.mjs';
import { annotateWorkflowEfforts, clip, COMPACT_TOOL, compactMeta, parseTaskNotification, readWorkflowOutput, toolInputSubset, toolJoins, toolShown, toolSummary, workflowMetaFromScript, workflowNameFromInput } from '../../runtime/tool-summary.mjs';
import { applyWidgetResult, isVizTool, widgetSegFromToolUse } from '../../mcp/visualize.mjs';
import { splitAttachments } from '../../runtime/client-atts.mjs';

// SDK/CLI-injected turns that aren't real conversation — hidden from the phone.
const SDK_NOISE = new Set([
  'Your tool call was malformed and could not be parsed. Please retry.',
  'Continue from where you left off.',
  'No response requested.',
  // 停止键打断当前作答（后台任务还在时走 interrupt，见 claude.mjs interruptTurn）后 CLI 写进 transcript 的标记
  '[Request interrupted by user]',
  '[Request interrupted by user for tool use]',
]);

// SDK 注入的「伪 user」记录：不是用户说的话，重开会话时绝不能渲染成用户气泡。
// ① o.isMeta=true —— skill 展开正文（"Base directory for this skill: …"）、图片元信息
//    （"[Image: original …]"）、continue 注入等；直播时它们从不出现在 SSE 流里，
//    历史重建不滤则整段 skill 提示词会漏成一条用户消息（实测投诉）。
// ② 非 meta 但以注入包裹开头的文本：后台任务通知 <task-notification>（tool-summary.mjs 还认
//    <agent-notification>/<bash-notification> 变体，这里同样过滤，别让它们漏成用户气泡）、斜杠命令展开
//    <command-name>/<command-message>/<command-args>、<local-command-*>、<system-reminder>。
const INJECTED_TEXT_RE = /^\s*<(?:(?:task|agent|bash)-notification|command-name|command-message|command-args|local-command-|system-reminder)/;
export const isInjectedText = (t) => INJECTED_TEXT_RE.test(t);
// 例外：用户自己敲的斜杠命令（/插件:命令 参数），CLI 落成 <command-message>/<command-name>/<command-args>
// 一段非 meta 文本（展开后的正文另起一条 isMeta）。它就是用户这轮说的话——还原成「/命令 参数」当用户气泡，
// 不然首条消息是斜杠命令的会话重开后开头一片空白。
function slashCommandText(t) {
  const name = ((String(t).match(/<command-name>([\s\S]*?)<\/command-name>/) || [])[1] || '').trim();
  if (!name) return '';
  const args = ((String(t).match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '').trim();
  return (name.startsWith('/') ? name : '/' + name) + (args ? ' ' + args : '');
}



// —— transcript → 结构化消息重建（让「重开会话」看到的和「实时」一致）——
// 关键：把一整轮（真·用户消息 + 后续所有 assistant/tool_result 条目）归为【一条】assistant 消息，
// 段落 segments 交错 text / 工具链 / ask / notice 块——与前端直播模型同构。思考块 SDK 落盘时正文被
// 清空（只剩签名），无法还原，跳过。媒体卡不重建（仍按普通工具链处理）。
// 2026-09-02 起 Agent/Task/Workflow 的工具行也重建，条目带 task（子 agent 卡 / 工作流卡的数据）：
// tool_use 给描述 / 脚本 meta，tool_result 顶层 toolUseResult 给 taskId / 模型 / 输出文件，完成通知
// <task-notification>（三种落盘形态）给状态 / 摘要 / 结果 / 用量，工作流再读 .output 补逐 agent 进度。
// toolShown / toolSummary 与直播端共用 runtime/tool-summary.mjs（两边规则一致是硬要求）。
function askItems(questions) {
  return (questions || []).map((q) => ({
    header: q.header || '', question: q.question || q.text || '',
    options: (q.options || []).map((o) => (typeof o === 'string' ? { label: o, description: '' } : { label: o.label, description: o.description || '' })),
    multi: !!q.multiSelect, selected: [], custom: '',
  }));
}
function resultText(b) {
  const c = b && b.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.filter((x) => x && x.type === 'text' && typeof x.text === 'string').map((x) => x.text).join('');
  return '';
}
// 把 formatAnswer（questions.mjs）落进 transcript 的答案文本反解回选择，回填 ask 块（重开时高亮同直播）。
function applyAnswerText(seg, text) {
  seg.answered = true;
  if (!text || /用户取消了这次选择/.test(text)) { seg.cancelled = true; return; }
  const lines = []; const re = /^答：(.*)$/gm; let m;
  while ((m = re.exec(text))) lines.push(m[1].trim());
  seg.items.forEach((it, i) => {
    const line = lines[i];
    if (line == null || line === '（未选）') return;
    for (const raw of line.split('、')) {
      const p = raw.trim(); if (!p) continue;
      if (p.startsWith('（自定义）')) it.custom = p.slice('（自定义）'.length);
      else if (it.options.some((o) => o.label === p)) it.selected.push(p);
      else it.custom = p;
    }
  });
}
// 官方作答通道（allow + updatedInput.answers；bridge 2026-11-08 起也走它，官方 Desktop / 终端里答的一直是它）：
// 这条 user 记录顶层的 toolUseResult = { questions, answers:{题面: 串}, annotations? }，按题面回填——单选是一个 label 或
// 自定义文本，多选是 questions.mjs joinAnswerList 拼的串；annotations.notes（单选「选了又写了自定义」）也算自定义。
// 读不到（旧转录、deny 退路、取消）再按 formatAnswer 的「答：」反解。
function applyAnswerResult(seg, text, tur) {
  if (!tur || typeof tur !== 'object' || !Array.isArray(tur.questions) || !tur.answers || typeof tur.answers !== 'object' || Array.isArray(tur.answers)) {
    applyAnswerText(seg, text);
    return;
  }
  seg.answered = true;
  const notes = tur.annotations && typeof tur.annotations === 'object' ? tur.annotations : {};
  for (const it of seg.items) {
    const v = Object.hasOwn(tur.answers, it.question) ? tur.answers[it.question] : undefined;
    const parts = typeof v !== 'string' || !v ? [] : it.multi ? (splitAnswerList(v) || v.split(', ')) : [v];
    const extra = [];
    for (const raw of parts) {
      const p = String(raw).trim(); if (!p) continue;
      if (it.options.some((o) => o.label === p)) { if (!it.selected.includes(p)) it.selected.push(p); }
      else extra.push(p);
    }
    const n = Object.hasOwn(notes, it.question) && notes[it.question] ? notes[it.question].notes : '';
    if (typeof n === 'string' && n.trim()) extra.push(n.trim());
    if (extra.length) it.custom = extra.join('、');
  }
}
// 空壳判定：notice（模型切换提示）与带 task 的工具行也算内容——「只剩一张切换卡」的轮不能被丢掉。
const asmHasContent = (m) => m.segments.some((s) => (s.kind === 'text' && s.md.trim()) || (s.kind === 'tools' && s.tools.length) || s.kind === 'ask' || s.kind === 'plan' || s.kind === 'notice' || s.kind === 'media' || s.kind === 'widget');

// —— 计划审批卡（ExitPlanMode，2026-10-20，见 runtime/permissions.mjs）——
// tool_use 的 input 在落盘前已被 CLI 注入了 plan / planFilePath（normalizeToolInput），计划正文直接取；结论按 tool_result 反解：
// 批准 =「User has approved …」（目标模式取这条 tool_result 所在 user 记录的 permissionMode——setMode 先于工具执行生效）；
// 修改 = 官方拒绝前缀 + 反馈；清空上下文后执行 / 拒绝 / 没批完（停止、断线）各有固定措辞。与直播 plan_request / plan_answer 落成的段同构。
const PLAN_REJECT_RE = /^The user doesn't want to proceed with this tool use\.[\s\S]*?the user said:\n([\s\S]*)$/;
// CLI 自己的中断 / 作废措辞（isUserInterruptionMessage 那一组方括号句）= 没批完。只是没有台账时的兜底：bridge 作答过的卡
// 结论按台账给（见 applyPlanResult）；Desktop / 终端里被中断的卡才走到这里
const CLI_INTERRUPT_RE = /^\[(Request interrupted by user|Tool call (did not complete|interrupted|skipped|not completed|result not in this copy))/;
function planSegFromToolUse(b) {
  const input = b.input && typeof b.input === 'object' ? b.input : {};
  return { kind: 'plan', qid: b.id || '', plan: typeof input.plan === 'string' ? clip(input.plan, 100_000) : '', planFile: typeof input.planFilePath === 'string' ? path.basename(input.planFilePath) : '', answered: false, decision: '', mode: '', feedback: '' };
}
// 返回 false = 这次 ExitPlanMode 根本没走到审批（不在计划模式时调用、入参错误），直播也没有卡——调用方把段撤掉。
// rec = bridge 台账里这张卡的结论（runtime/permissions.mjs notePlan：{ mode, decision, newSessionId }），没有就只看措辞。
// 拒绝、清空上下文后执行（都是 deny+interrupt）和停止，CLI 在 transcript 里写的是同一句「… STOP what you are doing …」
// （2026-10-21 实测），光看措辞全成了「已拒绝」——bridge 自己作答过的卡以台账为准。
function applyPlanResult(seg, b, recordMode, rec) {
  const text = resultText(b).trim();
  if (b.is_error && (/<tool_use_error>/.test(text) || /not in plan mode/i.test(text))) return false;
  seg.answered = true;
  if (!b.is_error && /^User has approved/.test(text)) {
    seg.decision = 'accept';
    if (typeof recordMode === 'string' && recordMode && recordMode !== 'plan') seg.mode = recordMode;
    if (!seg.plan) { const m = /## Approved Plan[^\n]*:\n([\s\S]*)$/.exec(text); if (m) seg.plan = clip(m[1].trim(), 100_000); }
    return true;
  }
  const rej = PLAN_REJECT_RE.exec(text);
  if (rec && rec.decision && rec.decision !== 'accept') {
    seg.decision = rec.decision;
    if (rec.decision === 'revise' && rej) seg.feedback = clip(rej[1].trim(), 4000);
    if (rec.decision === 'clear') { if (rec.mode) seg.mode = rec.mode; if (rec.newSessionId) seg.newSessionId = rec.newSessionId; }
    return true;
  }
  if (rej) { seg.decision = 'revise'; seg.feedback = clip(rej[1].trim(), 4000); return true; }
  if (/started a new session with cleared context/.test(text)) seg.decision = 'clear';
  else if (/^（计划审批没有完成/.test(text) || CLI_INTERRUPT_RE.test(text)) seg.decision = 'cancelled';
  else seg.decision = 'reject';
  return true;
}
// 逐次审批不进历史（transcript 不记审批），只在被拒的工具行上标 denied（直播 perm_answer / perm_denied 同款）：
// 人拒的 = user；自动模式分类器拦下的 = classifier（工具行尾巴「Blocked by auto mode」，前缀与 CLI isAutoModeDenialMessage 同）
const isUserDenial = (text) => /^User rejected /.test(text) || /^The user doesn't want to proceed with this tool use\./.test(text);
const isAutoModeDenial = (text) => /^Permission for this action (was denied by the Claude Code auto mode classifier|has been denied)\. Reason: /.test(text);

// —— 媒体段重建（mcp__media__generate_*）——
// 直播里图/视频/语音靠 gen_media_* 事件落成 media 段；以前 transcript 重建刻意不还原它，于是
// 重开对话、或对账时这条消息有任何一处对不上（被服务端版整条替换）——图就整张没了。
// transcript 里有还原所需的全部信息：tool_use 的 prompt + tool_result 里的绝对文件路径
//（文件名就是媒体 id，见 modules/studio/server/mcp/media-phone.mjs resultText）。
// 段形状与直播 chat.svelte.js gen_media_start/gen_media 落成的完全一致。
const MEDIA_TOOL_KIND = { generate_image: 'image', generate_video: 'video', generate_speech: 'audio', generate_music: 'music' };
const MEDIA_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.([a-z0-9]{2,5})\b/i;
function mediaToolKind(name) {
  const m = /^mcp__media__(generate_[a-z]+)$/.exec(String(name || ''));
  return m ? MEDIA_TOOL_KIND[m[1]] || null : null;
}
// 一次调用可能出多件（params 里给了张数）：回执里每个文件路径各成一段，按出现顺序、去重。
function mediaSegsFromResult(kind, input, b) {
  const text = resultText(b);
  const prompt = String((input && (input.prompt || input.text)) || '');
  const base = { kind: 'media', id: '', mediaKind: kind, status: 'ready', elapsed: 0, error: null, prompt, dataUrl: null };
  if (b.is_error) return [{ ...base, status: 'error', error: text.replace(/^[^：:\n]{0,12}失败[：:]\s*/, '').trim() || '生成失败' }];
  // ext：前端据此给下载名补对扩展名（Nano Banana 2.1 出 jpg、语音出 wav，不能一律猜 png / mp3）
  const seen = new Set(), out = [];
  for (const [, id, ext] of text.matchAll(new RegExp(MEDIA_ID_RE.source, 'gi'))) {
    if (seen.has(id)) continue;
    seen.add(id); out.push({ ...base, id, ext: ext.toLowerCase() });
  }
  return out;
}
// 子 agent 生成的媒体：直播时 gen_media 事件推进的是主对话那一轮（截图里一整排课件配图就是
// 子 agent 出的），但工具调用只落在 <会话>/subagents/agent-<id>.jsonl。按出现顺序收集。
const subagentFile = (file, agentId) => path.join(path.dirname(file), path.basename(file, '.jsonl'), 'subagents', 'agent-' + agentId + '.jsonl');
// → { segs, size }：size = 读到的字节数（文件不在 = -1；增量缓存据此认出后台子 agent 的转录后来又长了）
function subagentMedia(file, agentId) {
  if (!file || !/^[A-Za-z0-9_-]+$/.test(agentId || '')) return { segs: [], size: -1 };
  const sub = subagentFile(file, agentId);
  let raw, size;
  try { const buf = readFileSync(sub); size = buf.length; raw = buf.toString('utf8'); } catch { return { segs: [], size: -1 }; }
  const uses = new Map();
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('mcp__media__') && !(uses.size && line.includes('tool_result'))) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const blocks = Array.isArray(o.message && o.message.content) ? o.message.content : [];
    for (const b of blocks) {
      if (o.type === 'assistant' && b.type === 'tool_use') { const k = mediaToolKind(b.name); if (k && b.id) uses.set(b.id, { kind: k, input: b.input || {} }); }
      else if (o.type === 'user' && b.type === 'tool_result' && uses.has(b.tool_use_id)) {
        const u = uses.get(b.tool_use_id); uses.delete(b.tool_use_id);
        out.push(...mediaSegsFromResult(u.kind, u.input, b));
      }
    }
  }
  return { segs: out, size };
}

// 模型安全栅门 / 模型切换的 jsonl 记录（system，字段 camelCase，与 wire 的 snake_case 不同；两种都认）
// → notice 段，字段与直播 model_notice 事件落成的段同构。
function noticeFromRecord(o, ts) {
  const pick = (a, b) => (o[a] !== undefined ? o[a] : o[b]);
  return {
    kind: 'notice', subtype: o.subtype, direction: o.direction || null,
    scope: o.scope === 'local' ? 'local' : 'session',
    from: String(pick('originalModel', 'original_model') || ''),
    to: String(pick('fallbackModel', 'fallback_model') || ''),
    trigger: o.trigger || null,
    category: pick('apiRefusalCategory', 'api_refusal_category') ?? null,
    explanation: pick('apiRefusalExplanation', 'api_refusal_explanation') ?? null,
    text: String(o.content || ''),
    requestId: pick('requestId', 'request_id') || null,
    refusedUserUuid: pick('refusedUserMessageUuid', 'refused_user_message_uuid') || null,
    at: ts,
  };
}
// Agent/Task/Workflow 的工具行条目带 task（与直播 task_start 建出的结构同构：字段齐全、默认空值）。
// 状态 'unknown' = 只看到发起、还没找到 tool_result / 完成通知（前端显示成「已结束（无记录）」）。
function taskFromToolUse(name, input) {
  const s = (v) => (typeof v === 'string' ? v : (v == null ? '' : String(v)));
  const base = {
    taskId: '', taskType: '', description: '', subagentType: '', workflowName: '', name: '', prompt: '',
    backgrounded: null, depth: 0, status: 'unknown', startedAt: 0, endedAt: 0, usage: null, lastTool: '',
    summary: '', error: '', result: '', outputFile: '', runId: '', progress: [], phasesMeta: [], entries: [],
    toolCount: 0, latestToolName: '', model: '',
  };
  if (name === 'Agent' || name === 'Task') {
    return {
      ...base, taskType: input.isolation === 'remote' ? 'remote_agent' : 'local_agent',
      description: s(input.description), subagentType: s(input.subagent_type), prompt: clip(s(input.prompt), 300),
      model: s(input.model), backgrounded: input.run_in_background === true ? true : null,
    };
  }
  // 后台 shell（run_in_background）也是一等后台任务——09-15 起它会把这一轮悬停住（不再被收轮杀掉），
  // 历史重建同样得给它一条 task 记录，否则刷新之后工作台「任务」面板里这些 shell 全都不见了。
  if ((name === 'Bash' || name === 'PowerShell') && input.run_in_background === true) {
    return { ...base, taskType: 'local_bash', description: s(input.description), command: clip(s(input.command), 1000), backgrounded: true };
  }
  if (name === 'Workflow') {
    const meta = workflowMetaFromScript(input.script);
    const wname = (typeof input.name === 'string' && input.name) || meta.name || workflowNameFromInput(input);
    return { ...base, taskType: 'local_workflow', name: wname, workflowName: wname, description: meta.description, phasesMeta: meta.phases, prompt: clip(s(input.script), 300), backgrounded: true };
  }
  return null;
}
// tool_result 回填任务：顶层 toolUseResult.status==='async_launched' = 后台起飞（taskId / 模型 / 输出文件，完成
// 与否等 <task-notification>）；同步形态的 Agent，tool_result 正文就是子 agent 的最终回复；出错则是错误文案。
function applyToolResult(task, b, tur) {
  const text = resultText(b);
  const r = tur && typeof tur === 'object' ? tur : null;
  // 后台 shell 起飞：tool_result 正文是 "Command running in background with ID: bxxxx…"。
  // 状态记成 running——完成时有 <task-notification> 回填；没有通知就是「那一轮没等到它」，
  // 由前端按「历史里的 running = 已随进程结束」收成 stopped（normSeg）。
  const bgShell = (text.match(/Command running in background with ID:\s*([A-Za-z0-9_-]+)/) || [])[1] || '';
  if (bgShell && !b.is_error) {
    task.backgrounded = true;
    if (!task.taskType) task.taskType = 'local_bash';
    if (!task.taskId) task.taskId = bgShell;
    task.status = 'running';
    return;
  }
  const launched = (r && r.status === 'async_launched') || /^(?:Async agent launched|Workflow launched in background)/.test(text);
  if (launched && !b.is_error) {
    task.backgrounded = true;
    const idFromText = (text.match(/(?:agentId|Task ID):\s*([A-Za-z0-9_-]+)/) || [])[1] || '';
    task.taskId = String((r && (r.agentId || r.taskId)) || task.taskId || idFromText);
    if (r) {
      if (r.resolvedModel) task.model = String(r.resolvedModel);
      if (r.outputFile) task.outputFile = String(r.outputFile);
      if (r.workflowName) { task.workflowName = String(r.workflowName); if (!task.name) task.name = task.workflowName; }
      if (r.runId) task.runId = String(r.runId);
      if (r.summary && !task.description) task.description = String(r.summary);
    }
    return;
  }
  // 同步子 agent 也记下 agentId（toolUseResult.agentId，或正文末尾 CLI 附的「agentId: …」）：
  // 重建时靠它找子转录（子 agent 生成的图只落在那里）
  if (!task.taskId) task.taskId = String((r && r.agentId) || (text.match(/\bagentId:\s*([A-Za-z0-9_-]+)/) || [])[1] || '');
  if (b.is_error) { task.status = 'failed'; task.error = clip(text, 600); return; }
  task.status = 'completed';
  task.backgrounded = false;
  task.result = clip(text, 600);
}

// —— 主链过滤（检查点回滚后的对话分叉）——
// CLI 的对话回滚不删 transcript：新轮以 parentUuid 指回锚点，在同一 jsonl 里分叉，
// 被回滚掉的旧轮成为孤儿条目。重建历史必须沿「最后一个主链叶子 → parentUuid 链」
// 取主链，否则孤儿轮会重新渲染出来（探针 C5：CLI 的 resume 就是这么走链的）。
// 任何异常（缺 uuid 的旧格式、链断、环）→ 返回 null = 放弃过滤，回到线性全量（fail-open）。
// 上下文压缩：compact_boundary 记录的 parentUuid 是 null（模型视角的新起点），压缩前那段对话
// 挂在它的 logicalParentUuid 上——只认 parentUuid 的话链在边界处就「到根」了，压缩前的全部内容
// 被当孤儿滤掉，重开会话只剩压缩摘要和之后的轮（09-23 维护者报的 bug）。显示要的是逻辑链：
// 边界处顺着 logicalParentUuid 接着往回走；它不在本文件（极老的截断记录）才算真根。
function chainIncludeSet(cs) {
  const byUuid = cs.byUuid;
  const inc = new Set();
  let cur = cs.leaf;
  let guard = cs.count + 8;
  while (cur && guard-- > 0) {
    inc.add(cur.uuid);
    if (!cur.parentUuid) {
      const logical = cur.logicalParentUuid ? byUuid.get(cur.logicalParentUuid) : null;
      if (!logical) return inc;               // 走到根：链完整
      cur = logical;                          // 压缩边界：接上压缩前的对话
      continue;
    }
    const parent = byUuid.get(cur.parentUuid);
    if (!parent) return null;                 // 链断（parent 不在本文件）→ fail-open
    cur = parent;
  }
  return null;                                // 环 / 超长 → fail-open
}
// 第一遍扫描的状态（全量与增量续读共用）：所有带 uuid 的主线条目（attachment 等也在链上，必须收；同一 uuid 后写的覆盖先写的）、
// 叶子（只认 user/assistant，summary 等杂项不配当叶子）、安全栅门撤回的帧 uuid（system 记录的 retractedMessageUuids /
// 重试帧的 supersedes；jsonl 键名未见 2.1.257 样本，camelCase 与 snake_case 两种写法都认）。
// 条目带 first = 这个 uuid 第一次出现时的序号：增量续读据此认出「新主链经过了旧内容里的条目」（见 extendHistory）。
const RETRACT_KEYS = ['retractedMessageUuids', 'retracted_message_uuids', 'supersedes', 'supersedesUuids'];
export const newChainState = () => ({ byUuid: new Map(), leaf: null, count: 0, failOpen: false, retracted: new Set() });
// 吃一条记录；返回这一条新撤回了几个 uuid
export function chainTake(cs, o) {
  if (!o || o.isSidechain) return 0;
  let n = 0;
  for (const k of RETRACT_KEYS) {
    const arr = o[k];
    if (Array.isArray(arr)) for (const u of arr) if (typeof u === 'string' && u) { cs.retracted.add(u); n++; }
  }
  if (cs.failOpen) return n;
  const ua = o.type === 'user' || o.type === 'assistant';
  if (ua && !o.uuid) { cs.failOpen = true; return n; }
  if (!o.uuid) return n;
  const prev = cs.byUuid.get(o.uuid);
  const node = ua ? { uuid: o.uuid, parentUuid: o.parentUuid || null } : { uuid: o.uuid, parentUuid: o.parentUuid || null, logicalParentUuid: o.logicalParentUuid || null };
  node.first = prev ? prev.first : cs.count;
  cs.byUuid.set(o.uuid, node);
  cs.count++;
  if (ua) cs.leaf = node;
  return n;
}
// 主链 include set；null = 放弃主链过滤（fail-open）
export const chainInc = (cs) => (!cs.failOpen && cs.leaf ? chainIncludeSet(cs) : null);
// 全量第一遍：resolve {inc, retracted}：inc 为 null = 放弃主链过滤（fail-open），retracted 始终是 Set。
function scanChain(file) {
  return new Promise((resolve) => {
    const stream = createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const cs = newChainState();
    const finish = () => { try { stream.destroy(); } catch {} resolve({ inc: chainInc(cs), retracted: cs.retracted }); };
    rl.on('line', (line) => {
      let o; try { o = JSON.parse(line); } catch { return; }
      chainTake(cs, o);
    });
    rl.on('close', finish);
    rl.on('error', finish);
  });
}

// 会话 → Markdown（导出 / 引用对话共用）：front matter + 标题 + 一句说明 + 逐条「你 / Claude」正文。
// 用户消息带过的附件只列名字（路径不出服务器，读的人也用不上）；引用过的对话标成「引用了对话《…》」。
export function sessionMarkdown(msgs, { id, title, at = new Date(), source = '', note = '' }) {
  const lines = ['---'];
  if (source) lines.push('source: ' + source);
  lines.push('session_id: ' + id);
  lines.push('exported: ' + at.toISOString());
  lines.push('title: ' + String(title).replace(/\n/g, ' '));
  lines.push('---', '', '# ' + title, '');
  if (note) lines.push('> ' + note, '');
  for (const m of msgs) {
    lines.push(m.role === 'user' ? '**你：**' : '**Claude：**', '');
    if (m.text) lines.push(m.text, '');
    const atts = m.role === 'user' && Array.isArray(m.attachments) ? m.attachments : [];
    if (atts.length) lines.push(atts.map((a) => (a.kind === 'chat' ? `（引用了对话《${a.name}》）` : `（附件：${a.name}）`)).join(' '), '');
  }
  return lines;
}

// Rebuild a session log into displayable bubbles. User → {role,text,uuid[,attachments]};
// assistant → {role,segments[],text} (text = flattened, kept for export/admin back-compat).
// opts.cutAfterUuid：处理完该 uuid 的条目后截断——「对话已回滚但还没发下一条消息」期间
//（pending 锚点还没变成 jsonl 分叉），历史视图就按锚点截到回滚处。
export async function readSessionMessages(file, opts = {}) {
  const chain = await scanChain(file).catch(() => null);
  const parser = makeHistoryParser(file, { incSet: chain ? chain.inc : null, retractedSet: chain ? chain.retracted : new Set(), cutAfterUuid: opts.cutAfterUuid, planRecord: opts.planRecord });
  return new Promise((resolve) => {
    // Normally reads to EOF (stream autoCloses), but destroy() on exit is cheap
    // insurance against a leaked fd on an error/partial path — same EMFILE hazard.
    const stream = createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let done = false;
    const finish = () => { if (done) return; done = true; try { stream.destroy(); } catch {} resolve(parser.finish()); };
    rl.on('line', parser.feed);
    rl.on('close', finish);
    rl.on('error', finish);
  });
}

// 历史重建的逐行状态机（全量 readSessionMessages 与增量 readSessionHistory 共用）：feed(line) 一行行喂，finish() 收尾出消息列表。
// ctl 里是主链过滤（incSet / retractedSet）与计划卡台账（planRecord）：增量续读时换成新值再接着喂。
// holding()=true：收尾会把状态改成「续不上」的样子（手动 /compact 还扣着没等到命令记录 / 按回滚锚点截断了），这份状态不能留着续读。
// watched：展开过媒体的后台子 agent 转录（当时它还在跑，之后可能再长出图）——它们变了，留着的状态就不作数了。
export function makeHistoryParser(file, opts = {}) {
  const ctl = { incSet: opts.incSet ?? null, retractedSet: opts.retractedSet || new Set(), planRecord: opts.planRecord || null };
  const cut = opts.cutAfterUuid || null;
  let stopped = false;
  const watched = [];
  {
    const msgs = [];
    let asm = null;                 // 当前正在累积的 assistant 轮
    const askByTool = new Map();    // AskUserQuestion tool_use_id -> ask 段（等它的 tool_result 答案）
    const planByTool = new Map();   // ExitPlanMode tool_use_id -> plan 段（等它的 tool_result 结论）
    const byToolUse = new Map();    // 工具 tool_use_id -> tools 段条目。任务回填（tool_result / 完成通知）跨轮查，不随 asm 清空
    const mediaByTool = new Map();  // mcp__media__generate_* tool_use_id -> { kind, input }（等 tool_result 落 media 段）
    const subMediaDone = new Set(); // 已展开过媒体的子 agent id（同一 agent 只展开一次）
    const widgetByTool = new Map(); // show_widget tool_use_id -> widget 段（tool_result 报错时回填）
    const lastSeg = () => asm.segments[asm.segments.length - 1];
    // textBreak：后台任务完成通知（CLI 注入的 <task-notification>）之后，模型续的那段正文【另起一段】。
    // 不隔开的话「已在后台启动」和几分钟后的「后台命令已跑完…」会粘成一句话（直播端 chat.svelte.js 同治）。
    let textBreak = false;
    const textSeg = () => { const l = lastSeg(); if (l && l.kind === 'text' && !textBreak) return l; textBreak = false; const s = { kind: 'text', md: '' }; asm.segments.push(s); return s; };
    const toolsSeg = () => { const l = lastSeg(); if (l && l.kind === 'tools') return l; const s = { kind: 'tools', tools: [], open: false }; asm.segments.push(s); return s; };
    // 工具条目入段（官方 HD 分桶）：standalone 桶的工具（Workflow 等）自己一段，前后工具各自另起一段；
    // 其余连续 tool_use 并进同一段。与直播 chat.svelte.js pushTool 同构——两边分段不一致，前端对账时会闪。
    const pushToolEntry = (entry) => {
      const l = lastSeg();
      const prev = l && l.kind === 'tools' && l.tools.length ? l.tools[l.tools.length - 1] : null;
      if (l && l.kind === 'tools' && toolJoins(prev ? prev.name : '', entry.name)) { l.tools.push(entry); return; }
      asm.segments.push({ kind: 'tools', tools: [entry], open: false });
    };
    const ensureAsm = (ts) => { if (!asm) { asm = { role: 'assistant', segments: [], ts }; msgs.push(asm); } return asm; };
    // —— 上下文压缩：边界记录 → tools 段里一条合成条目（与直播 compact 事件落成的条目同构，见
    // runtime/tool-summary.mjs COMPACT_TOOL）；紧随的摘要记录（isCompactSummary）不是用户说的话，
    // 收进这条条目当展开详情，绝不渲染成用户气泡。
    // 手动 /compact 的落盘顺序是「边界 → 摘要 → <command-name>/compact 记录」，而直播里用户先看到
    // 自己的「/compact」气泡、再看到压缩行——边界先扣住（pendingManual），等命令记录到了先补气泡
    // 再开新一轮挂上去；没等到命令记录（CLI 形态不同）就在下一条可见内容前原位挂回。
    let lastCompact = null;
    let pendingManual = null;
    const placeCompact = (entry, ts) => { ensureAsm(ts); pushToolEntry(entry); };
    const flushManual = (ts) => { if (pendingManual) { const e = pendingManual; pendingManual = null; placeCompact(e, ts); } };
    // 完成通知回填：按 <tool-use-id> 找条目（没有就按 taskId 反查），幂等——同一通知在 transcript 里会
    // 出现两三次（queue-operation / attachment / user 文本），内容相同，后到的覆盖先到的。
    const applyNotification = (text) => {
      const n = parseTaskNotification(text);
      if (!n) return;
      let entry = n.toolUseId ? byToolUse.get(n.toolUseId) : null;
      if (!entry && n.taskId) for (const e of byToolUse.values()) if (e.task && e.task.taskId === n.taskId) { entry = e; break; }
      if (!entry || !entry.task) return;
      const t = entry.task;
      t.status = n.status;
      if (n.taskId && !t.taskId) t.taskId = n.taskId;
      // 子 agent 的 <summary> 是 CLI 模板句 'Agent "…" finished'，结论在 <result>；直播帧的 summary 就是子 agent 的
      // 最终回复（claude.mjs emitTaskEvent 也把它落到 result）——两边对齐成 summary=result，刷新前后同一张卡不换文案
      const tmpl = !!n.result && /^Agent "[^"]*" (finished|completed)\.?$/i.test(n.summary);
      if (n.summary) t.summary = tmpl ? n.result : n.summary;
      if (n.result) t.result = n.result;
      if (n.outputFile) t.outputFile = n.outputFile;
      if (n.usage) t.usage = n.usage;
      if (n.status === 'failed' && !t.error) t.error = n.summary || '';
      if (t.taskType === 'local_workflow' && n.outputFile) {
        // 工作流的 .output（JSON，保留期不可靠）：逐 agent 进度 + 最终结果；读不到就只有通知里的状态/摘要
        const o = readWorkflowOutput(n.outputFile);
        if (o) {
          // 逐 agent 档位不在快照里，从子 agent 转录补（<会话>.jsonl 旁边的 <会话>/subagents）
          // auto:<档> 的落点按主人身份的阶梯补（历史缓存不分人；成员会话少，按主人算）
          if (o.progress) t.progress = annotateWorkflowEfforts(o.progress, file.replace(/\.jsonl$/i, '') + path.sep + 'subagents', (name) => autoServed(name, HOST_OWNER));
          if (o.result != null) t.result = o.result;
          if (!t.usage && (o.tokens || o.toolCalls)) t.usage = { tokens: o.tokens, toolUses: o.toolCalls, ms: 0 };
        }
      }
    };
    const finish = () => {
      flushManual(0);
      // 收尾：assistant 轮补上 flattened text（export/admin 沿用）；丢掉空 assistant 壳。
      const out = [];
      for (const m of msgs) {
        if (m.role === 'assistant') {
          if (!asmHasContent(m) && m.status !== 'error') continue;   // 错误卡本身就是内容，别当空壳丢
          // 先删再赋：增量续读时这条消息上一次收尾已经有 text，之后又补了 status 等字段——text 恒放最后，
          // 序列化出来的键序才与整份重建逐字节一致（前端拿 JSON 比对新旧）
          delete m.text;
          m.text = m.segments.filter((s) => s.kind === 'text' && s.md.trim()).map((s) => s.md).join('\n\n');
        }
        out.push(m);
      }
      return out;
    };
    const feed = (line) => {
      let o; try { o = JSON.parse(line); } catch { return; }
      if (stopped) return;
      if (cut && o.uuid === cut) stopped = true;   // 锚点条目本身仍处理，之后的全部截掉
      if (o.isSidechain) return;
      const ts = o.timestamp ? (Date.parse(o.timestamp) || 0) : 0;
      // 后台任务完成通知的三种落盘形态里，queue-operation / attachment(queued_command) 没有 message——先在这里抠。
      if (o.type === 'queue-operation') { if (typeof o.content === 'string') { applyNotification(o.content); textBreak = true; } return; }
      if (o.type === 'attachment') {
        const a = o.attachment;
        if (!a || a.type !== 'queued_command') return;
        const ptext = typeof a.prompt === 'string' ? a.prompt
          : (Array.isArray(a.prompt) ? a.prompt.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('') : '');
        if (ptext.includes('-notification>')) { applyNotification(ptext); textBreak = true; return; }
        // 插话（Claude 工作中用户按回车，priority:'next'）：CLI 把它当 queued_command 读进正在跑的这一轮——
        // 落成这一轮回答流里的插话段（与直播 steer 事件同形），其后的正文另起一段。
        // 孤儿分支照主链过滤（它的 parent 在主链上才算）。
        if (ctl.incSet && o.uuid && !ctl.incSet.has(o.uuid) && !(o.parentUuid && ctl.incSet.has(o.parentUuid))) return;
        const sp = splitAttachments(ptext);
        if (!sp.text.trim() && !sp.attachments.length) return;
        flushManual(ts);
        const peerIn = peerFromRecord(o);   // 官方 Desktop / 终端会话插进来的：正文换成与直播同形的显示信封（带来源）
        ensureAsm(ts).segments.push({ kind: 'steer', text: peerIn ? peerDisplay(peerIn) : sp.text, files: sp.attachments.map((x) => x.name).filter(Boolean), ...(sp.attachments.length ? { atts: sp.attachments } : {}), ...(a.source_uuid ? { uuid: a.source_uuid } : {}), read: true });
        textBreak = true;
        return;
      }
      // 孤儿分支（被回滚掉的轮）：user/assistant 认自己的 uuid；system 通知这类记录没人以它为 parent，
      // 只能靠「它的 parent 在主链上」判定——挂在被回滚轮下的通知也就跟着不渲染。
      if (ctl.incSet && o.uuid) {
        const onChain = ctl.incSet.has(o.uuid) || (o.type !== 'user' && o.type !== 'assistant' && !!o.parentUuid && ctl.incSet.has(o.parentUuid));
        if (!onChain) return;
      }
      if (o.uuid && ctl.retractedSet.has(o.uuid)) return;   // 安全栅门撤回的半截帧 / 墓碑 tool_result：直播已撤，历史也不摆
      if (o.type === 'system') {
        // 上下文压缩边界 → 循环组里的「Compacted session」条目（手动 /compact 先扣住，见 pendingManual）
        if (o.subtype === 'compact_boundary') {
          flushManual(ts);
          const cm = compactMeta(o);
          const entry = { id: o.uuid || '', name: COMPACT_TOOL, summary: '', input: {}, status: 'done', ms: cm.ms, task: null,
            compact: { trigger: cm.trigger, preTokens: cm.preTokens, postTokens: cm.postTokens, summary: '' } };
          lastCompact = entry;
          if (cm.trigger === 'manual') pendingManual = entry;
          else placeCompact(entry, ts);
          return;
        }
        // 模型安全栅门 / 模型切换记录 → notice 段，挂在当前 assistant 轮（没有就新建；夹在轮中间是常态）
        if (/^model_/.test(o.subtype || '')) { flushManual(ts); ensureAsm(ts).segments.push(noticeFromRecord(o, ts)); }
        return;
      }
      if ((o.type !== 'user' && o.type !== 'assistant') || !o.message) return;
      const content = o.message.content;
      const blocks = Array.isArray(content) ? content : (typeof content === 'string' ? [{ type: 'text', text: content }] : []);

      // 压缩摘要（CLI 注入的伪 user 记录）：收进刚才那条压缩条目的展开详情
      if (o.type === 'user' && o.isCompactSummary) {
        const text = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n').trim();
        if (lastCompact) lastCompact.compact.summary = text;
        return;
      }

      if (o.type === 'assistant') {
        // 停止 / 回答提问打断一轮后 CLI 补写的合成回答（model '<synthetic>'，正文「No response requested.」这类）：不是模型说的，
        // 直播时也没有。不滤就会接在被打断的那段正文后面（「48No response requested.」），插件页面的对话历史里也多出一条回复
        if (o.message.model === '<synthetic>' && blocks.length && blocks.every((b) => b.type === 'text' && SDK_NOISE.has(String(b.text || '').trim()))) return;
        flushManual(ts);
        ensureAsm(ts);
        // 这一轮落盘时的工作目录（模型 cd 过就会变）：交付链接按它解析，见 resolveDeliverPath。
        // 只在服务端内部用，出接口前剥掉（绝对路径不出服务器）。
        if (typeof o.cwd === 'string' && o.cwd) {
          const cs = asm.cwds || (asm.cwds = []);
          if (cs[cs.length - 1] !== o.cwd) { const k = cs.indexOf(o.cwd); if (k >= 0) cs.splice(k, 1); cs.push(o.cwd); }
        }
        // CLI 认证失败写下的合成回答（「Not logged in · Please run /login」）：跟直播一样落成错误卡，
        // 不把 CLI 的原话当回答——bridge 里没有地方跑 /login，要告诉人服务端怎么配。
        if (o.error === 'authentication_failed' && o.isApiErrorMessage) {
          const c = classifyError('', 'authentication_failed');
          asm.status = 'error';
          asm.error = c.hint ? c.title + ' — ' + c.hint : c.title;
          return;
        }
        // 撞限额写下的合成回答（「You've hit your session limit · resets 3pm (…)」）：同直播落成限额卡
        //（官方 Session limit reached / Weekly limit reached），重置时刻取当时记下的 rate_limit_info。
        if (o.error === 'rate_limit' && o.isApiErrorMessage) {
          const text = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('').trim();
          const lim = limitNotice((o.apiErrorParams && o.apiErrorParams.rate_limit_info) || o.quotaLimits || null, text);
          asm.status = 'error';
          asm.error = lim.title + (lim.resetsAt ? '' : ' — ' + lim.hint);
          asm.limit = { type: lim.type, resetsAt: lim.resetsAt, text };
          return;
        }
        for (const b of blocks) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text) textSeg().md += b.text;
          else if (b.type === 'tool_use') {
            if (b.name === 'AskUserQuestion' && b.input && Array.isArray(b.input.questions)) {
              const seg = { kind: 'ask', qid: b.id || '', answered: false, cancelled: false, items: askItems(b.input.questions) };
              asm.segments.push(seg);
              if (b.id) askByTool.set(b.id, seg);
            } else if (b.name === 'ExitPlanMode') {
              const seg = planSegFromToolUse(b);
              asm.segments.push(seg);
              if (b.id) planByTool.set(b.id, { seg, arr: asm.segments });
            } else if (mediaToolKind(b.name)) {
              if (b.id) mediaByTool.set(b.id, { kind: mediaToolKind(b.name), input: b.input || {} });
            } else if (isVizTool(b.name)) {
              // 内嵌图表：show_widget → widget 段（与直播 widget_* 帧同形，按 tool_use 原位）；read_me 不落段
              const w = widgetSegFromToolUse(b);
              if (w) { asm.segments.push(w); if (b.id) widgetByTool.set(b.id, w); }
            } else if (toolShown(b.name)) {
              // 与直播 tool/tool_args/tool_done 落成的条目同构：id / 摘要 / 安全输入子集 / 状态；
              // Agent/Task/Workflow 再带 task（回填见 applyToolResult / applyNotification）。
              const input = b.input && typeof b.input === 'object' ? b.input : {};
              const entry = { id: b.id || '', name: b.name, summary: toolSummary(b.name, input), input: toolInputSubset(b.name, input), status: 'done', ms: 0, task: taskFromToolUse(b.name, input) };
              pushToolEntry(entry);
              if (b.id) byToolUse.set(b.id, entry);
            }
          }
          // thinking：正文已被 SDK 清空，跳过
        }
      } else {
        // user 条目：tool_result 先回填——AskUserQuestion 的答案回 ask 块；其余工具回状态，Agent/Workflow 再回任务
        for (const b of blocks) {
          if (b.type !== 'tool_result' || !b.tool_use_id) continue;
          if (askByTool.has(b.tool_use_id)) {
            applyAnswerResult(askByTool.get(b.tool_use_id), resultText(b), o.toolUseResult);
            askByTool.delete(b.tool_use_id);
            continue;
          }
          if (planByTool.has(b.tool_use_id)) {
            const { seg, arr } = planByTool.get(b.tool_use_id);
            planByTool.delete(b.tool_use_id);
            // 结论与目标模式：tool_result 记录本身不带 permissionMode（实测），按 tool_use id 查 bridge 的台账（opts.planRecord）
            const rec = ctl.planRecord ? ctl.planRecord(b.tool_use_id) : null;
            if (!applyPlanResult(seg, b, o.permissionMode || (rec && rec.mode) || '', rec)) { const k = arr.indexOf(seg); if (k >= 0) arr.splice(k, 1); }
            continue;
          }
          if (widgetByTool.has(b.tool_use_id)) { applyWidgetResult(widgetByTool.get(b.tool_use_id), b); widgetByTool.delete(b.tool_use_id); continue; }
          // 媒体生成的结果 → media 段（与直播同位：紧跟发起它的那一步，落在当前轮末尾）
          if (mediaByTool.has(b.tool_use_id)) {
            const u = mediaByTool.get(b.tool_use_id);
            mediaByTool.delete(b.tool_use_id);
            ensureAsm(ts).segments.push(...mediaSegsFromResult(u.kind, u.input, b));
            continue;
          }
          const entry = byToolUse.get(b.tool_use_id);
          if (!entry) continue;
          entry.status = b.is_error ? 'error' : 'done';
          { const card = cardOf(b); if (card) entry.card = card; }   // 插件工具的结果卡片（同直播 tool_done 的 card）
          { const n = countToolImages(b); if (n) entry.images = n; }   // 结果里的图片张数（状态行缩略图条；图本身按需从 transcript 现取）
          if (b.is_error) { const rt = resultText(b).trim(); if (isUserDenial(rt)) entry.denied = 'user'; else if (isAutoModeDenial(rt)) entry.denied = 'classifier'; }
          if (entry.task) applyToolResult(entry.task, b, o.toolUseResult);
          // 子 agent 出的图/视频：按 agentId（applyToolResult 刚回填）读它的子转录，就地展开成 media 段。
          // 没有媒体就什么都不加——别插空段，否则把前后正文切成两段、与直播分段对不上，对账会闪。
          if (entry.task && entry.task.taskId && (entry.name === 'Agent' || entry.name === 'Task') && !subMediaDone.has(entry.task.taskId)) {
            subMediaDone.add(entry.task.taskId);
            const { segs, size } = subagentMedia(file, entry.task.taskId);
            if (entry.task.backgrounded) watched.push({ file: subagentFile(file, entry.task.taskId), size });
            if (segs.length) ensureAsm(ts).segments.push(...segs);
          }
        }
        // 完成通知的 user 文本形态（CLI 注入的 <task-notification>，非 isMeta）——在下面的注入过滤之前抠
        for (const b of blocks) if (b.type === 'text' && typeof b.text === 'string' && b.text.includes('-notification>')) { applyNotification(b.text); textBreak = true; }
        // 真·用户消息（有正文文本，且非 SDK 噪声/注入）→ 收束当前 assistant 轮、起新 user 气泡。
        // isMeta 记录整条跳过；注入包裹按【块】过滤——即使注入块与用户正文同条共存也只丢注入块
        // （tool_result 回填已在上面处理完，不受影响）。
        // 例外：官方 Desktop / 终端会话发来的跨会话消息（CLI 落成 isMeta + origin.kind 'peer'，session-peers.mjs）——
        // 它开了一轮就落成用户气泡位置的会话消息卡，插进正在跑的那一轮就落成插话段（与直播 steer 事件同形）。
        const peer = o.isMeta ? peerFromRecord(o) : null;
        if (peer) {
          const text = peerDisplay(peer);
          if (peer.turnStart || !asm) { flushManual(ts); asm = null; msgs.push({ role: 'user', text, ts }); }
          else if (!asm.segments.some((s) => s.kind === 'steer' && s.uuid && s.uuid === peer.uuid)) { asm.segments.push({ kind: 'steer', text, files: [], uuid: peer.uuid, read: true }); textBreak = true; }
          return;
        }
        if (o.isMeta) return;
        // 手动 /compact 的命令记录：补上用户那条「/compact」气泡，压缩行另起一轮挂在它后面（与直播同形）
        if (pendingManual) {
          const raw = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('');
          if (/<command-name>\s*\/?compact\s*<\/command-name>/.test(raw)) {
            const args = ((raw.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '').trim();
            asm = null;
            msgs.push({ role: 'user', text: '/compact' + (args ? ' ' + args : ''), ts });
            flushManual(ts);
            return;
          }
        }
        const text = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => (isInjectedText(b.text) ? slashCommandText(b.text) : b.text)).join('');
        if (text && text.trim() && !SDK_NOISE.has(text.trim())) {
          flushManual(ts);
          asm = null;
          const sp = splitAttachments(text);
          const um = { role: 'user', text: sp.text, ts };
          if (o.uuid) um.uuid = o.uuid;   // 检查点回滚锚点（前端「回滚到此」入口）
          if (sp.attachments.length) um.attachments = sp.attachments;
          msgs.push(um);
        }
      }
    };
    return { ctl, feed, finish, watched, holding: () => !!pendingManual || stopped };
  }
}
