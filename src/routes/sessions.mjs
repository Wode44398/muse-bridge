// Claude conversation history: the SDK persists every session as a .jsonl log
// under ~/.claude/projects/<cwd-with-non-alnum-replaced-by-dash>/. Because the
// bridge always runs with cwd === VAULT, those logs ARE this app's chat history.
// Any of them can be reopened by passing its id back as `resume`.

import os from 'node:os';
import path from 'node:path';
import { createReadStream, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { readBody } from '../runtime/body.mjs';
import * as claudeProjects from '../claude-projects.mjs';
import * as claudeQuick from '../claude-quick.mjs';
import { collectDeliverables, deliverAnywhere, deliverRoots, isInside, resolveDeliverPath, streamArtifactFile, streamFolderZip, transcriptCwds } from '../runtime/deliverables.mjs';
import { sessionsDir, sanitizeName } from '../runtime/paths.mjs';
import { getLiveGens, findGenBySession, bridgeSessions, routineSessions } from '../runtime/gen.mjs';
import { findRewindAnchors, rewindClaudeFiles, pendingRewindAnchor, setPendingRewind } from '../agents/claude-rewind.mjs';
import { releaseWarmClaude } from '../agents/claude.mjs';
import { chatPrefsFor, lastChatPrefs, dropChatPrefs } from '../runtime/chat-prefs.mjs';
import { sessionQuestions } from '../runtime/questions.mjs';
import { VAULT } from '../config/index.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { classifyError } from '../runtime/status.mjs';
// 工具行/任务卡规则与直播端（agents/claude.mjs）共用一份——直播与重开必须一致。
import { toolShown, toolStandalone, toolSummary, toolInputSubset, workflowNameFromInput, workflowMetaFromScript, parseTaskNotification, readWorkflowOutput, clip, COMPACT_TOOL, compactMeta } from '../runtime/tool-summary.mjs';

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && !isInjectedText(b.text))
      .map((b) => b.text)
      .join('');
  }
  return '';
}

// /api/session 响应的指纹。响应只由三样东西决定：
//   ① transcript 文件本身（size + mtime——内容变了这两者必变，不必读文件）
//   ② 回滚锚点（pending 时视图要按锚点截断）
//   ③ 该会话的 prefs sidecar（model/effort/fast，前端要用它恢复选择器）
// 取不到 stat 就返回 null = 不短路，老老实实重建（宁可多算，绝不给错的 unchanged）。
export function sessionFingerprint(file, sessionId, ctx) {
  let st;
  try { st = statSync(file); } catch { return null; }
  const parts = [
    st.size,
    Math.round(st.mtimeMs),
    pendingRewindAnchor(sessionId) || '',
    JSON.stringify(chatPrefsFor(ctx, sessionId) || null),
  ];
  return createHash('sha1').update(parts.join('\x00')).digest('hex').slice(0, 16);
}

export function trimTitle(s) {
  if (!s) return '';
  // 标题取的是第一条用户消息【原文】，带附件发送时 claude.mjs 会把「[用户上传了以下
  // 附件…绝对路径如下]」整段注进 prompt，也就一并写进 transcript。气泡那条通道由
  // splitAttachments() 剥掉了，标题这条以前没剥——于是会话列表里直接显示内部提示词
  // 加服务器绝对路径（体检时线上实测到）。/api/sessions 对 user 与公开快照访客同样
  // 开放，注释里那条「绝对路径不出服务器」的规矩在这里被绕过去了。
  const { text, attachments } = splitAttachments(String(s));
  let body = text;
  // 只传附件、一个字没写的会话：剥完就空了，而调用方把空标题当成「读不出来的会话」
  // 直接从列表里丢掉（listSessions 里的 `if (!title) continue`）。用附件名兜底——
  // 只出文件名，不出路径。
  if (!body.trim() && attachments.length) {
    body = attachments.map((a) => a.name).filter(Boolean).join('、');
  }
  const line = body.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? line.slice(0, 80) + '…' : line;
}

// Stream a session log only until its first real user message — that's the title.
export function readSessionTitle(file) {
  return new Promise((resolve) => {
    // Keep the stream ref so we can DESTROY it. We close mid-file the instant the title
    // is found, but readline.close() does NOT close the underlying fd — and the stream
    // hasn't hit EOF, so autoClose never fires either. /api/sessions opens ~40 of these
    // per request; leaking each fd piles up until the process throws EMFILE: too many
    // open files (even agy.mjs then fails to load). destroy() on every exit path = fix.
    const stream = createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let title = '';
    const finish = () => { try { rl.close(); } catch {} try { stream.destroy(); } catch {} resolve(title); };
    rl.on('line', (line) => {
      if (title) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      if (o.type === 'user' && o.message && !o.isMeta) {
        const t = extractText(o.message.content);
        if (t && t.trim()) { title = t; finish(); }
      }
    });
    rl.on('close', finish);
    rl.on('error', finish);
  });
}

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
const isInjectedText = (t) => INJECTED_TEXT_RE.test(t);

// 用户带附件发送时，claude.mjs 把「[用户上传了以下附件…绝对路径]」注入进 prompt，会转写进 transcript。
// 重开历史会话时：① 把这段注入文本从气泡里剥掉（否则漏出服务端绝对路径）② 抽出附件——存盘名 file
// （Date.now()-原名）+ 去时间戳前缀的显示名 name + 完整路径 raw（供 toClientAtt 按来源分类，
// 不直接出服务器）；前端据此走 /api/upload/raw 或 /api/file 把图片渲染回缩略图。
const ATT_MARK = '[用户上传了以下附件';
function splitAttachments(text) {
  const mi = text.indexOf(ATT_MARK);
  if (mi < 0) return { text, attachments: [] };
  const clean = text.slice(0, mi).replace(/\n+$/, '');
  const attachments = [];
  const re = /^-\s+(.+)$/gm;
  let m;
  while ((m = re.exec(text.slice(mi)))) {
    // 行尾可能带 claude.mjs 加的标注（「  ← 文件夹」「  ← 引用的对话」），不属于路径
    const raw = m[1].replace(/\s+←.*$/, '').trim();
    const file = raw.split(/[\\/]/).pop() || '';
    if (!file) continue;
    const q = parseQuoteFile(file);
    attachments.push(q ? { file, name: q.title, raw, kind: 'chat', quoteId: q.id } : { file, name: file.replace(/^\d+-/, ''), raw });
  }
  return { text: clean, attachments };
}
// 「引用对话」附件（侧栏把一条会话拖进另一个对话，见 POST /api/session/quote）：存盘名
// <时间戳>-chatref-<会话 id>-<标题>.md。靠名字认出来，重开历史时气泡里画成对话卡而不是一份 .md。
const QUOTE_FILE_RE = /^\d+-chatref-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})-(.*)\.md$/;
export function parseQuoteFile(file) {
  const m = QUOTE_FILE_RE.exec(String(file || ''));
  return m ? { id: m[1], title: m[2] || '' } : null;
}
// 历史附件出口（绝对路径不出服务器）：uploads 里的 → {file}（前端走 /api/upload/raw）；
// 工作空间直发的（「发送给 AI」零拷贝路径）→ {rel}（前端走 /api/file）；都不是 → 只留名字。
function toClientAtt(a, ctx) {
  const raw = a.raw || '';
  const under = (dir) => dir && raw && path.resolve(raw).startsWith(path.resolve(dir) + path.sep);
  if (under(ctx.uploads)) return a.kind === 'chat' ? { file: a.file, name: a.name, kind: 'chat', quoteId: a.quoteId } : { file: a.file, name: a.name };
  if (under(ctx.cwd)) return { rel: path.relative(ctx.cwd, raw).split(path.sep).join('/'), name: a.file };
  return { name: a.name };
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
// 空壳判定：notice（模型切换提示）与带 task 的工具行也算内容——「只剩一张切换卡」的轮不能被丢掉。
const asmHasContent = (m) => m.segments.some((s) => (s.kind === 'text' && s.md.trim()) || (s.kind === 'tools' && s.tools.length) || s.kind === 'ask' || s.kind === 'notice');

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
// 被当孤儿滤掉，重开会话只剩压缩摘要和之后的轮（09-23 的 bug）。显示要的是逻辑链：
// 边界处顺着 logicalParentUuid 接着往回走；它不在本文件（极老的截断记录）才算真根。
function chainIncludeSet(nodes, leafIdx) {
  const byUuid = new Map();
  for (const n of nodes) byUuid.set(n.uuid, n);
  const inc = new Set();
  let cur = nodes[leafIdx];
  let guard = nodes.length + 8;
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
// 第一遍扫描：主链 include set + 安全栅门撤回的帧 uuid（system 记录的 retractedMessageUuids /
// 重试帧的 supersedes；jsonl 键名未见 2.1.257 样本，camelCase 与 snake_case 两种写法都认）。
// resolve {inc, retracted}：inc 为 null = 放弃主链过滤（fail-open），retracted 始终是 Set。
function scanChain(file) {
  return new Promise((resolve) => {
    const stream = createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const nodes = [];               // 所有带 uuid 的主线条目（attachment 等也在链上，必须收）
    let leafIdx = -1;               // 叶子只认 user/assistant（summary 等杂项不配当叶子）
    let failOpen = false;
    const retracted = new Set();
    const finish = () => { try { stream.destroy(); } catch {} resolve({ inc: !failOpen && leafIdx >= 0 ? chainIncludeSet(nodes, leafIdx) : null, retracted }); };
    rl.on('line', (line) => {
      let o; try { o = JSON.parse(line); } catch { return; }
      if (!o || o.isSidechain) return;
      for (const k of ['retractedMessageUuids', 'retracted_message_uuids', 'supersedes', 'supersedesUuids']) {
        const arr = o[k];
        if (Array.isArray(arr)) for (const u of arr) if (typeof u === 'string' && u) retracted.add(u);
      }
      if (failOpen) return;
      if (o.type === 'user' || o.type === 'assistant') {
        if (!o.uuid) { failOpen = true; return; }
        nodes.push({ uuid: o.uuid, parentUuid: o.parentUuid || null });
        leafIdx = nodes.length - 1;
      } else if (o.uuid) {
        nodes.push({ uuid: o.uuid, parentUuid: o.parentUuid || null, logicalParentUuid: o.logicalParentUuid || null });
      }
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
  const incSet = chain ? chain.inc : null;
  const retractedSet = chain ? chain.retracted : new Set();
  const cut = opts.cutAfterUuid || null;
  let stopped = false;
  return new Promise((resolve) => {
    // Normally reads to EOF (stream autoCloses), but destroy() on exit is cheap
    // insurance against a leaked fd on an error/partial path — same EMFILE hazard.
    const stream = createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    const msgs = [];
    let asm = null;                 // 当前正在累积的 assistant 轮
    const askByTool = new Map();    // AskUserQuestion tool_use_id -> ask 段（等它的 tool_result 答案）
    const byToolUse = new Map();    // 工具 tool_use_id -> tools 段条目。任务回填（tool_result / 完成通知）跨轮查，不随 asm 清空
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
      if (l && l.kind === 'tools' && !toolStandalone(entry.name) && !(prev && toolStandalone(prev.name))) { l.tools.push(entry); return; }
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
          if (o.progress) t.progress = o.progress;
          if (o.result != null) t.result = o.result;
          if (!t.usage && (o.tokens || o.toolCalls)) t.usage = { tokens: o.tokens, toolUses: o.toolCalls, ms: 0 };
        }
      }
    };
    const finish = () => {
      try { stream.destroy(); } catch {}
      flushManual(0);
      // 收尾：assistant 轮补上 flattened text（export/admin 沿用）；丢掉空 assistant 壳。
      const out = [];
      for (const m of msgs) {
        if (m.role === 'assistant') {
          if (!asmHasContent(m) && m.status !== 'error') continue;   // 错误卡本身就是内容，别当空壳丢
          m.text = m.segments.filter((s) => s.kind === 'text' && s.md.trim()).map((s) => s.md).join('\n\n');
        }
        out.push(m);
      }
      resolve(out);
    };
    rl.on('line', (line) => {
      let o; try { o = JSON.parse(line); } catch { return; }
      if (stopped) return;
      if (cut && o.uuid === cut) stopped = true;   // 锚点条目本身仍处理，之后的全部截掉
      if (o.isSidechain) return;
      const ts = o.timestamp ? (Date.parse(o.timestamp) || 0) : 0;
      // 后台任务完成通知的三种落盘形态里，queue-operation / attachment(queued_command) 没有 message——先在这里抠。
      if (o.type === 'queue-operation') { if (typeof o.content === 'string') { applyNotification(o.content); textBreak = true; } return; }
      if (o.type === 'attachment') { const a = o.attachment; if (a && a.type === 'queued_command' && typeof a.prompt === 'string') { applyNotification(a.prompt); textBreak = true; } return; }
      // 孤儿分支（被回滚掉的轮）：user/assistant 认自己的 uuid；system 通知这类记录没人以它为 parent，
      // 只能靠「它的 parent 在主链上」判定——挂在被回滚轮下的通知也就跟着不渲染。
      if (incSet && o.uuid) {
        const onChain = incSet.has(o.uuid) || (o.type !== 'user' && o.type !== 'assistant' && !!o.parentUuid && incSet.has(o.parentUuid));
        if (!onChain) return;
      }
      if (o.uuid && retractedSet.has(o.uuid)) return;   // 安全栅门撤回的半截帧 / 墓碑 tool_result：直播已撤，历史也不摆
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
        for (const b of blocks) {
          if (b.type === 'text' && typeof b.text === 'string' && b.text) textSeg().md += b.text;
          else if (b.type === 'tool_use') {
            if (b.name === 'AskUserQuestion' && b.input && Array.isArray(b.input.questions)) {
              const seg = { kind: 'ask', qid: b.id || '', answered: false, cancelled: false, items: askItems(b.input.questions) };
              asm.segments.push(seg);
              if (b.id) askByTool.set(b.id, seg);
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
            applyAnswerText(askByTool.get(b.tool_use_id), resultText(b));
            askByTool.delete(b.tool_use_id);
            continue;
          }
          const entry = byToolUse.get(b.tool_use_id);
          if (!entry) continue;
          entry.status = b.is_error ? 'error' : 'done';
          if (entry.task) applyToolResult(entry.task, b, o.toolUseResult);
        }
        // 完成通知的 user 文本形态（CLI 注入的 <task-notification>，非 isMeta）——在下面的注入过滤之前抠
        for (const b of blocks) if (b.type === 'text' && typeof b.text === 'string' && b.text.includes('-notification>')) { applyNotification(b.text); textBreak = true; }
        // 真·用户消息（有正文文本，且非 SDK 噪声/注入）→ 收束当前 assistant 轮、起新 user 气泡。
        // isMeta 记录整条跳过；注入包裹按【块】过滤——即使注入块与用户正文同条共存也只丢注入块
        // （tool_result 回填已在上面处理完，不受影响）。
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
        const text = blocks.filter((b) => b.type === 'text' && typeof b.text === 'string' && !isInjectedText(b.text)).map((b) => b.text).join('');
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
    });
    rl.on('close', finish);
    rl.on('error', finish);
  });
}

// 搜历史会话:按标题(首条 user 消息)关键词匹配,给助手 search_sessions 工具用。
// 复用 readSessionTitle;只读会话目录,scope 由 ctx(cwd/configDir)界定。query 空=返回最近的。
export async function searchSessions(ctx, query, { max = 20, scan = 60 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  const dir = sessionsDir(ctx.cwd, ctx.configDir);
  let entries = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch {}
  const files = entries
    .filter((d) => d.isFile() && d.name.endsWith('.jsonl'))
    .map((d) => { const file = path.join(dir, d.name); let mtime = 0; try { mtime = statSync(file).mtimeMs; } catch {} return { id: d.name.slice(0, -6), file, mtime }; })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, scan); // 只在最近 scan 个会话里搜(够用且快)
  const out = [];
  for (const f of files) {
    const title = trimTitle(await readSessionTitle(f.file));
    if (!title) continue;
    if (!q || title.toLowerCase().includes(q)) { out.push({ id: f.id, title, mtime: f.mtime }); if (out.length >= max) break; }
  }
  return out;
}

export function registerSessionRoutes(router, { authOk, identify }) {
  router.on('GET', '/api/sessions', async (req, res) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(who);
    // 项目制：会话分散在各项目的 transcript 目录里（cwd slug），逐项目目录聚合。
    // 会话→项目的归属由所在目录推导（见 claude-projects.mjs 头注）。
    // worktree 会话（输入栏 worktree 勾选框开出来的）的 transcript 在 worktree cwd 的目录里，
    // sessionScopes 把它们并进所属项目：projectId 仍是原项目，另带 wt（cwd/分支）给前端工作台定位。
    const scopes = claudeProjects.sessionScopes(ctx.claudeProjects, ctx);
    const files = [];
    const quickFiles = [];   // 快照桶那一条单独收着——不参与 60 条截断（见下）
    for (const { project: p } of scopes) {
      const dir = sessionsDir(p.path, ctx.configDir);
      let entries = [];
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      const found = [];
      for (const d of entries) {
        if (!d.isFile() || !d.name.endsWith('.jsonl')) continue;
        const file = path.join(dir, d.name);
        let mtime = 0, size = 0;
        try { const st = statSync(file); mtime = st.mtimeMs; size = st.size; } catch {}
        found.push({ id: d.name.slice(0, -6), file, mtime, size, projectId: p.id, wt: p.worktree ? { cwd: p.path, branch: p.worktree.branch } : undefined });
      }
      // 快照桶：只列【最新】那一条——「同时只存在一个快照对话」。在快照里点了「新对话」
      // 就等于把这只桶的快照换成新的一条，旧 transcript 留在盘上但不再出现在列表里。
      if (p.quick && found.length > 1) found.sort((a, b) => b.mtime - a.mtime).splice(1);
      (p.quick ? quickFiles : files).push(...found);
    }
    files.sort((a, b) => b.mtime - a.mtime);
    // 快照那条【不占也不吃】60 条上限：它常驻置顶，聊得再久也不该被新会话挤出列表
    //（挤掉了前端就只剩空占位行，等于那条快照对话凭空消失）。
    const capped = [...quickFiles, ...files.slice(0, 60)];   // 多项目目录聚合后放宽一点（原单目录 40）；标题逐文件流读，须有上界
    // Which sessions have a generation in flight on THIS server（多对话并发：可能多个）。
    const liveGens = getLiveGens(ctx.key);
    const liveIds = new Set(liveGens.map((g) => g.sessionId).filter(Boolean));
    // 顺手回收旧快照（只留最近 10 条；节流、后台跑，不拖慢本次列表）。
    if (quickFiles.length) claudeQuick.schedulePruneQuick(ctx, { busy: liveIds, onDrop: (id) => dropChatPrefs(ctx, id) });
    const newest = liveGens[liveGens.length - 1] || null;
    const active = newest ? (newest.sessionId || null) : null;
    const built = await Promise.all(capped.map(async (f) => ({
      id: f.id,
      mtime: f.mtime,
      size: f.size,
      projectId: f.projectId,
      ...(f.wt ? { wt: f.wt } : {}),
      title: trimTitle(await readSessionTitle(f.file)),
    })));
    // Drop sessions whose title we can't read — those are .jsonl files currently
    // locked by other live claude.exe processes (the desktop Claude Code session,
    // sub-agents, etc.) or with no user text. They're unreadable noise here.
    // Always keep the in-flight session, labeled.
    const sessions = built
      .filter((s) => s.title || liveIds.has(s.id) || sessionQuestions.has(s.id))
      .map((s) => ({
        ...s,
        title: s.title || '（进行中…）',
        thinking: liveIds.has(s.id),         // a turn is generating in this conversation
        pending: sessionQuestions.has(s.id), // an AskUserQuestion is waiting here
        origin: routineSessions.has(s.id) ? 'routine' : (bridgeSessions.has(s.id) ? 'phone' : 'desktop'),
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // prefsLast：最近一次发送用的 model/effort/fast——前端「新对话」的选择器默认（跨设备）。
    res.end(JSON.stringify({ sessions, active, actives: [...liveIds], pending: [...sessionQuestions.keys()], prefsLast: lastChatPrefs(ctx) }));
  });

  // —— Claude 项目（路径制，与 codex projects 同构）：列表 / 浏览目录 / 新建 / 重命名 / 删除 ——
  const projCtx = (req, res) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return null; }
    return contextFor(who);
  };
  const projJson = (res, fn) => {
    try {
      const data = fn();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(e?.status || 400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e?.message || '操作失败' }));
    }
  };
  // 「位置」列表 —— agent 中立（Claude / Codex / dimensio 的新建项目选择器共用一份）。
  // 远程端的选择器基底是工作空间文件管理器，它锁在身份工作空间根内；这条给它一层根切换，
  // 把 admin 的可达范围补回到与旧自建选择器等价的「整机」。dimensio 的默认项目库
  // （~/Dimensio Projects）也当成一个位置摆进去，取消「新建空白项目」后不丢那条路。
  router.on('GET', '/api/project/locations', (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    const dimensio = path.join(os.homedir(), 'Dimensio Projects');
    projJson(res, () => ({
      locations: claudeProjects.projectLocations(ctx, [{ id: 'dimensio', name: 'Dimensio Projects', path: dimensio }]),
    }));
  });
  router.on('GET', '/api/claude/projects', (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    projJson(res, () => ({ projects: claudeProjects.listProjects(ctx.claudeProjects, ctx), order: claudeProjects.projectOrder(ctx.claudeProjects) }));
  });
  // 侧栏拖放排序：{ ids: [项目 id…] } 整表覆盖（只存显示顺序，不动项目本身）
  router.on('POST', '/api/claude/project/order', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => ({ ok: true, order: claudeProjects.setProjectOrder(ctx.claudeProjects, ctx, body && body.ids) }));
  });
  router.on('POST', '/api/claude/project/create', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => ({ ok: true, project: claudeProjects.createProject(ctx.claudeProjects, ctx, body) }));
  });
  router.on('POST', '/api/claude/project/rename', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => ({ ok: true, project: claudeProjects.renameProject(ctx.claudeProjects, body.id, body.name) }));
  });
  router.on('POST', '/api/claude/project/delete', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => ({ ok: claudeProjects.deleteProject(ctx.claudeProjects, ctx, body.id) }));
  });
  // 「新建快照」：换一只全新的一次性桶（旧桶先留盘不再列出，只保留最近 10 条快照记录，更老的回收）。前端拿到新
  // project 后直接以它为上下文开一条空对话——新桶=新 cwd=新自动记忆目录，前尘不带。
  router.on('POST', '/api/claude/quick/new', (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    projJson(res, () => {
      const project = claudeQuick.newQuickProject(ctx);
      const busy = new Set(getLiveGens(ctx.key).map((g) => g.sessionId).filter(Boolean));
      claudeQuick.schedulePruneQuick(ctx, { busy, onDrop: (id) => dropChatPrefs(ctx, id) }, { force: true });
      return { ok: true, project };
    });
  });

  router.on('GET', '/api/session', async (req, res, url) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(who);
    const id = url.searchParams.get('id') || '';
    if (!/^[0-9a-fA-F-]{8,}$/.test(id)) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad id');
      return;
    }
    // 项目制：transcript 可能在任一项目目录，跨目录定位（含防穿越）。
    const p = claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, id);
    if (!p) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
      return;
    }
    // 对账短路：这个响应完全由「transcript 文件 + 回滚锚点 + prefs sidecar」决定，
    // 三者都没变，重建出来的消息就必然逐字节一致。客户端把上次拿到的 fp 带回来，
    // 命中就回一个几十字节的 unchanged，连 transcript 都不读。
    //
    // 为什么值得做：Claude 分页每收到一个 session.touch 总线事件就 freshen 一次整份
    // transcript。CLI / 桌面 Claude Code 在跑的时候那个 jsonl 一直在长，实测手机端
    // 大约每 8 秒重拉一次整份记录（长会话几百 KB），纯属白烧流量和电。harness 那边
    // 早就用 recordFp 把这条短路了（319KB→53B），Claude 分页一直没有。
    const fp = sessionFingerprint(p.file, id, ctx);
    if (fp && url.searchParams.get('fp') === fp) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ id, unchanged: true, fp }));
      return;
    }
    const all = await readSessionMessages(p.file, { cutAfterUuid: pendingRewindAnchor(id) });
    // 助手侧产物附件：与 live 轮（agents/claude.mjs done 事件）同一套提取——从该轮最终
    // 文本的 markdown 链接重建，重开会话与直播看到的一致；transcript 即真相，无需 sidecar。
    const roots = deliverRoots(ctx, p.project.path, VAULT);
    // nav：文件夹卡「在工作空间里打开」的定位（ctx.cwd = 身份文件根，项目 path = 会话工作空间）。
    const nav = { fileRoot: ctx.cwd, ws: p.project.path, shell: !!ctx.shell };
    const messages = all.slice(-80).map((m) => {
      if (m.role === 'user') return m.attachments ? { ...m, attachments: m.attachments.map((a) => toClientAtt(a, ctx)) } : m;
      const { cwds, ...rest } = m;
      // 基准：该轮落盘的 cwd（最近的优先）→ 项目根；roots 不变，根守卫不放宽。
      const bases = [...(cwds || []).slice().reverse(), p.project.path];
      let atts = [];
      try { atts = collectDeliverables(m.text, { cwd: bases, roots, nav, anywhere: deliverAnywhere(ctx) }); } catch {}
      return atts.length ? { ...rest, attachments: atts } : rest;
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // prefs：这个会话上次用的 model/effort/fast（sidecar）——前端恢复选择器。
    // wt：worktree 会话的 cwd 与分支（工作台/归属芯片据此指向 worktree 而不是主检出）。
    res.end(JSON.stringify({ id, projectId: p.project.id, ...(p.project.worktree ? { wt: { cwd: p.project.path, branch: p.project.worktree.branch } } : {}), messages, truncated: all.length > messages.length, prefs: chatPrefsFor(ctx, id), fp }));
  });

  // —— 检查点回滚：文件恢复到某条用户消息发出前的状态（可选把对话也截回同一处）——
  // 文件 = 临时 resume query 调 SDK rewindFiles（零 token；机制与坑见 claude-rewind.mjs 头注）；
  // 对话 = 记 pending 锚点，下一轮 query 以 resumeSessionAt 在 transcript 里分叉，
  //        /api/session 在 pending 生效前就按锚点截断视图。
  // mode: 'both'（默认，文件+对话）| 'files'（只回滚文件）| 'chat'（只回滚对话锚点，文件一概不动——
  //       安全栅门横条「Edit prompt and retry」用：把被拒的那条用户消息撤回输入框改了重发，工作区里
  //       已经做好的活不能被顺带回滚掉；也不起 SDK 临时 query，零 token、零文件改动）。
  // 会话正在生成时拒绝——transcript 只能有一个写入者，SDK 子进程也会锁文件。
  router.on('POST', '/api/claude/rewind', async (req, res) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(who);
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const id = String(body.sessionId || '');
    const uuid = String(body.uuid || '');
    const mode = body.mode === 'files' ? 'files' : (body.mode === 'chat' ? 'chat' : 'both');
    if (!/^[0-9a-fA-F-]{8,}$/.test(id) || !/^[0-9a-fA-F-]{8,}$/.test(uuid)) return json(400, { error: '参数不合法' });
    const p = claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, id);
    if (!p) return json(404, { error: '会话不存在' });
    const live = findGenBySession(ctx.key, id);
    if (live && !live.done) return json(409, { error: '这个会话正在生成中，先「停止」再回滚。' });
    const anchors = findRewindAnchors(p.file, uuid);
    if (!anchors) return json(400, { error: '找不到这条消息的回滚锚点（会话记录可能已变化，重新打开会话再试）' });
    // 上一轮停放着的 CLI（agents/claude.mjs 的会话常驻）内存里还是回滚前的历史，文件回滚还要另起一个
    // resume 进程——先关掉它（一份 transcript 一个写入者），下一轮按锚点冷起分叉。
    await releaseWarmClaude(ctx.key, id);
    if (mode === 'chat') {
      // 纯对话回滚：只记 pending 锚点（与 both 分支的对话部分同一条路），跳过 rewindFiles。
      // 目标是会话首条消息时锚点为 null——对话没有更早处可回，直说。
      if (!anchors.convAnchor) return json(409, { error: '这是会话的第一条消息，对话没有更早处可回。' });
      setPendingRewind(id, anchors.convAnchor);
      return json(200, { ok: true, conv: true, files: false, note: '仅回滚了对话，文件未改动。' });
    }
    // 文件回滚。检查点缺失是【软失败】：开检查点之前的旧会话轮 / 该消息之后没改过文件，
    // 都会报 "No file checkpoint found"——mode both 时仍可只回滚对话。
    let files = { ok: false, changed: [], note: '' };
    try {
      const r = await rewindClaudeFiles({ sessionId: id, cwd: p.project.path, ctx, userUuid: uuid });
      if (r && r.canRewind !== false) files = { ok: true, changed: r.filesChanged || [], note: '' };
      else files.note = (r && r.error) || '没有可回滚的文件检查点';
    } catch (e) { files.note = String((e && e.message) || e); }
    const noCheckpoint = /no file checkpoint|not enabled/i.test(files.note);
    if (!files.ok && !noCheckpoint) return json(500, { error: '文件回滚失败：' + files.note });
    const conv = mode === 'both' && !!anchors.convAnchor;
    if (!files.ok && !conv) {
      return json(409, { error: '没有可回滚的内容：这条消息之后没有文件改动的检查点（回滚功能上线前的旧轮，或这轮没改过文件）' + (mode === 'both' ? '，而且它是会话的第一条消息，对话没有更早处可回' : '') + '。' });
    }
    if (conv) setPendingRewind(id, anchors.convAnchor);
    return json(200, {
      ok: true,
      conv,
      files: { ok: files.ok, changed: files.ok ? files.changed.length : 0 },
      note: !files.ok ? '这条消息之后没有文件改动的检查点，仅回滚了对话。' : (mode === 'both' && !conv ? '这是会话的第一条消息，对话没有更早处可回，仅回滚了文件。' : ''),
    });
  });

  // Claude 轮产物下发（与 /api/codex/artifact 同构）：会话必须在本人某个项目目录下
  // （locateSessionPaths 即所有权证明），项目路径现场重授权（沙箱用户篡改自己的
  // claude-projects.json 也翻不出自己的空间），请求路径须落在该会话的交付根内。
  // 文件走 Range 流；文件夹现打 zip 下发。<img>/下载链接带 ?token=（auth.mjs 白名单）。
  router.on('GET', '/api/claude/artifact', async (req, res, url) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(who);
    const id = String(url.searchParams.get('id') || '');
    const requested = String(url.searchParams.get('path') || '');
    if (!requested) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('missing path'); return; }
    try {
      const p = claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, id);
      if (!p) throw Object.assign(new Error('not found'), { status: 404 });
      const projRoot = claudeProjects.authorizeProjectPath(ctx, p.project.path);
      const roots = deliverRoots(ctx, projRoot, VAULT);
      // 正文链接点开时前端把链接原文当 path 传来，可能是相对路径：与 collectDeliverables
      // 同一套解析（cwd → 各交付根回退），别再靠 realpathSync 拿进程 cwd 碰运气。
      let file = resolveDeliverPath(requested, projRoot, roots);
      // 解析不到：模型可能在那一轮 cd 进了子目录、按新目录写的相对链接——拿这个会话 transcript
      // 里出现过的工作目录（最近的优先）再试一遍。只在兜底时扫，卡片点开（绝对路径）不走这里。
      if (!file && !path.isAbsolute(requested)) file = resolveDeliverPath(requested, [...await transcriptCwds(p.file), projRoot], roots);
      if (!file) throw Object.assign(new Error('not found'), { status: 404 });
      if (!deliverAnywhere(ctx) && !roots.some((root) => isInside(file, root))) throw Object.assign(new Error('forbidden'), { status: 403 });
      if (statSync(file).isDirectory()) {
        await streamFolderZip(req, res, file, { name: url.searchParams.get('name') || '' });
        return;
      }
      streamArtifactFile(req, res, file, url.searchParams.get('name') || path.basename(file), url.searchParams.get('dl') === '1');
    } catch (error) {
      if (res.headersSent) { try { res.destroy(error); } catch {} return; }
      res.writeHead(error?.status || 404, { 'Content-Type': 'text/plain' });
      res.end(error?.status === 403 ? 'forbidden' : 'not found');
    }
  });

  router.on('POST', '/api/session/delete', async (req, res) => {
    const who = identify(req);
    if (who.kind === 'none') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    if (who.kind === 'share') { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('share identity is read-only'); return; }
    const ctx = contextFor(who);
    let parsed;
    try { parsed = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    const p = claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, String(parsed.id || ''));
    if (!p) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad id'); return; }
    try {
      await releaseWarmClaude(ctx.key, String(parsed.id));   // 停放着的 CLI 先关（它还开着这份 transcript）
      // Thorough local removal: main transcript + subagent-transcript subdir.
      rmSync(p.file, { force: true });
      rmSync(p.subdir, { recursive: true, force: true });
      dropChatPrefs(ctx, String(parsed.id));   // 选择器记忆 sidecar 同步清
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });

  // 引用对话：侧栏把一条会话拖进另一个对话（输入栏 / 侧栏另一条会话）松手——把被引的那条整理成
  // 一份 Markdown 落进调用者自己的 uploads，当附件挂进输入栏，发送时走既有附件链路（路径进提示词、
  // 模型按需 Read，历史里照样回显成一张卡）。不把全文直接塞进提示词：长对话动辄几十万字，按需读才不烧上下文。
  // 只收自己看得到的会话（locateSessionPaths 按身份的项目目录找）；标题优先用前端给的（侧栏可能改过名）。
  router.on('POST', '/api/session/quote', async (req, res) => {
    const who = identify(req);
    if (who.kind === 'none') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    if (who.kind === 'share') { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('share identity is read-only'); return; }
    const ctx = contextFor(who);
    let parsed;
    try { parsed = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    const id = String(parsed.id || '');
    const p = /^[0-9a-fA-F-]{36}$/.test(id) ? claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, id) : null;
    if (!p) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '找不到这个对话' })); return; }
    try {
      const msgs = await readSessionMessages(p.file, { cutAfterUuid: pendingRewindAnchor(id) });
      if (!msgs.length) { res.writeHead(422, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: '这个对话还没有内容' })); return; }
      const given = trimTitle(String(parsed.title || '').replace(/\s+/g, ' ').trim());
      const title = given || trimTitle(await readSessionTitle(p.file)) || ('会话 ' + id.slice(0, 8));
      const lines = sessionMarkdown(msgs, {
        id, title, at: new Date(), source: 'claude-bridge 引用对话',
        note: '这是用户从另一段对话里拖过来的【引用】，下面是那段对话的完整记录（只含双方正文，工具调用过程已略去）。'
          + '把它当作这次对话的背景材料，结合用户这条消息作答；用户没问到的部分不必复述。',
      });
      mkdirSync(ctx.uploads, { recursive: true });
      // 斜杠先换掉：sanitizeName 按路径取末段，「A/B 方案对比」会只剩「B 方案对比」
      const safeTitle = sanitizeName(title.replace(/[\\/]+/g, ' ')).replace(/[.\s]+$/, '').slice(0, 60) || 'conversation';
      const file = Date.now() + '-chatref-' + id + '-' + safeTitle + '.md';
      const dest = path.join(ctx.uploads, file);
      await writeFile(dest, lines.join('\n'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // name 回存盘名里的那份标题（清洗/截断过）：重开历史时 parseQuoteFile 解出来的就是它，
      // 直播气泡与历史的附件名一致，前端合并时不会把这条用户消息当成变了而整条重建。
      res.end(JSON.stringify({ ok: true, path: dest, name: safeTitle, file, count: msgs.length }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });

  router.on('POST', '/api/session/export', async (req, res) => {
    const who = identify(req);
    if (who.kind === 'none') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    if (who.kind === 'share') { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('share identity is read-only'); return; }
    const ctx = contextFor(who);
    let parsed;
    try { parsed = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    const p = claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, String(parsed.id || ''));
    if (!p) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    const id = String(parsed.id);
    try {
      const msgs = await readSessionMessages(p.file, { cutAfterUuid: pendingRewindAnchor(id) }); // 与会话视图一致（不截尾窗，但尊重回滚）
      const title = trimTitle(await readSessionTitle(p.file)) || ('会话 ' + id.slice(0, 8));
      const now = new Date();
      const stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
      const lines = sessionMarkdown(msgs, { id, title, at: now, source: 'claude-bridge（手机端远程会话）', note: '从手机端 bridge 导出的完整对话。读完即可无缝接续这个话题。' });
      const exportDir = ctx.sandbox ? path.join(ctx.cwd, 'exports') : path.join(VAULT, 'Remote Space', 'conversations');
      mkdirSync(exportDir, { recursive: true });
      const safeTitle = sanitizeName(title).replace(/\.+$/, '').slice(0, 60) || 'conversation';
      const dest = path.join(exportDir, stamp + '_' + safeTitle + '_' + id.slice(0, 8) + '.md');
      await writeFile(dest, lines.join('\n'), 'utf8');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: dest, count: msgs.length }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });
}
