// Claude conversation history: the SDK persists every session as a .jsonl log
// under ~/.claude/projects/<cwd-with-non-alnum-replaced-by-dash>/. Because the
// bridge always runs with cwd === VAULT, those logs ARE this app's chat history.
// Any of them can be reopened by passing its id back as `resume`.

import os from 'node:os';
import path from 'node:path';
import { createReadStream, readFileSync, readdirSync, statSync, rmSync, mkdirSync } from 'node:fs';
import fsp, { writeFile } from 'node:fs/promises';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { readBody } from '../runtime/body.mjs';
import * as claudeProjects from '../claude-projects.mjs';
import * as claudeQuick from '../claude-quick.mjs';
import { collectDeliverables, deliverAnywhere, deliverRoots, isInside, resolveDeliverPath, streamArtifactFile, streamFolderZip, transcriptCwds } from '../runtime/deliverables.mjs';
import { isHtmlFile, respondHtmlSite } from '../runtime/html-site.mjs';
import { sessionsDir, sanitizeName } from '../runtime/paths.mjs';
import { getLiveGens, findGenBySession, bridgeSessions, routineSessions, pluginSessions } from '../runtime/gen.mjs';
import { findRewindAnchors, rewindClaudeFiles, pendingRewindAnchor, setPendingRewind } from '../agents/claude-rewind.mjs';
import { releaseWarmClaude } from '../agents/claude.mjs';
import { chatPrefsFor, lastChatPrefs, dropChatPrefs, setChatPrefsOutputStyle } from '../runtime/chat-prefs.mjs';
import { validSessionOutputStyle } from '../runtime/claude-turn-settings.mjs';
import { sessionQuestions } from '../runtime/questions.mjs';
import { getLibrary, applyLibraryOp, dropFromLibrary } from '../runtime/session-library.mjs';
import { claudeSettingsSnapshot, setClaudeSettings, claudeSetting } from '../runtime/claude-settings.mjs';
import { busPublish } from '../runtime/bus.mjs';
import { lineageFor } from '../runtime/desktop-lineage.mjs';
import { sessionOutputs } from '../runtime/session-outputs.mjs';
import { sessionMcp } from '../runtime/session-mcp.mjs';
import { familyMaps, forgetSession, linkedSessions } from '../runtime/session-family.mjs';
// 会话列表的扫盘 / 标题链 / 归档态 / 全文搜索（2026-10-20，对齐官方 Desktop 的归档与搜索）
import { listSessionFilesAsync, invalidateSessionFiles, peekSessionFile } from '../runtime/session-list.mjs';
import { readJsonlLines, lineStr, lineObj, readTail } from '../runtime/session-jsonl.mjs';
import { sendJson } from './static-compress.mjs';
import { resolveTitles, resolveTitle, knownUntitled, scheduleTitleWarm } from '../runtime/session-titles.mjs';
import { archiveView, dropStaleInactive, sessionArchiveFlag } from '../runtime/session-archive-auto.mjs';
import { forgetArchived, getArchiveState } from '../runtime/session-archive.mjs';
import { sessionLineage, forgetDetached } from '../runtime/session-lineage.mjs';
import { forgetActivity } from '../runtime/session-activity.mjs';
import { searchSessions as searchSessionsCore, scheduleSearchWarm } from '../runtime/session-search.mjs';
import { peerFromRecord, peerDisplay, hasPeerHold } from '../runtime/session-peers.mjs';
import { forgetPrSession } from '../runtime/pr-monitor.mjs';
import { VAULT } from '../config/index.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { classifyError, limitNotice } from '../runtime/status.mjs';
import { planRecordFor } from '../runtime/permissions.mjs';   // 计划卡的结论 / 批准时选的目标模式（历史里的计划卡）
// 工具行/任务卡规则与直播端（agents/claude.mjs）共用一份——直播与重开必须一致。
import { toolShown, toolJoins, toolSummary, toolInputSubset, workflowNameFromInput, workflowMetaFromScript, parseTaskNotification, readWorkflowOutput, annotateWorkflowEfforts, clip, COMPACT_TOOL, compactMeta } from '../runtime/tool-summary.mjs';
import { isVizTool, widgetSegFromToolUse, applyWidgetResult } from '../mcp/visualize.mjs';
import { parseDeviceRefNote, basenameOf } from '../runtime/device-refs.mjs';

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
  // 会话间消息的信封（session-family.mjs）：派生的子会话第一条就是父会话发来的任务说明——
  // 标题取信封里的正文（去掉「【任务】」这类小标题），不出标签。
  let body = text.replace(/<session-hint>[\s\S]*?<\/session-hint>/g, '')
    .replace(/<side-sessions-event>[\s\S]*?<\/side-sessions-event>/g, '')
    .replace(/<session-message\b[^>]*>([\s\S]*?)<\/session-message>/g, (_, b) => b.replace(/【(背景|任务)】/g, ' '))
    .replace(/<cross-session-message\b[^>]*>([\s\S]*?)<\/cross-session-message>/g, '$1')   // Desktop / 终端会话发来的（session-peers.mjs）
    // 拉取请求（pr-monitor.mjs）：Auto-fix 事件不当标题；「创建拉取请求」那条长提示词显示成 /create-pr
    .replace(/<ci-monitor-event>[\s\S]*?<\/ci-monitor-event>/g, '')
    .replace(/<create-pr-command>[\s\S]*?<\/create-pr-command>/g, (m) => (/gh pr create --draft/.test(m) ? '/create-pr --draft' : '/create-pr'))
    .replace(/<sync-conflict\b[^>]*>([\s\S]*?)<\/sync-conflict>/g, (_, b) => b);   // PR 卡「同步基线」冲突交接：只留正文
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
    // open files (even lazy imports then fail to load). destroy() on every exit path = fix.
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
export function splitAttachments(text) {
  const mi = text.indexOf(ATT_MARK);
  if (mi < 0) return { text, attachments: [] };
  const clean = text.slice(0, mi).replace(/\n+$/, '');
  const attachments = [];
  const re = /^-\s+(.+)$/gm;
  let m;
  while ((m = re.exec(text.slice(mi)))) {
    // 行尾可能带 claude.mjs 加的标注（「  ← 文件夹」「  ← 引用的对话」），不属于路径
    const raw = m[1].replace(/\s+←.*$/, '').trim();
    // 用户电脑上的文件夹（只引用、没上传，runtime/device-refs.mjs）：路径是他电脑上的，名字不剥时间戳前缀
    const dev = parseDeviceRefNote((/\s+←\s*(.*)$/.exec(m[1]) || [])[1]);
    if (dev) {
      const p = raw.replace(/^`(.*)`$/, '$1');   // 提示词里这条路径包着反引号
      attachments.push({ file: basenameOf(p), name: basenameOf(p), raw: p, kind: 'folder', device: { id: dev.deviceId, name: dev.deviceName } });
      continue;
    }
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
  if (a.device) return { name: a.name, kind: 'folder', device: a.device };   // 电脑上的路径不必回传，卡上只写名字与哪台电脑
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
//（文件名就是媒体 id，见 modules/vertex/server/mcp/media-phone.mjs resultText）。
// 段形状与直播 chat.svelte.js gen_media_start/gen_media 落成的完全一致。
const MEDIA_TOOL_KIND = { generate_image: 'image', generate_video: 'video', generate_speech: 'audio', generate_music: 'music' };
const MEDIA_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[a-z0-9]{2,5}\b/i;
function mediaToolKind(name) {
  const m = /^mcp__media__(generate_[a-z]+)$/.exec(String(name || ''));
  return m ? MEDIA_TOOL_KIND[m[1]] || null : null;
}
function mediaSegFromResult(kind, input, b) {
  const text = resultText(b);
  const prompt = String((input && (input.prompt || input.text)) || '');
  const base = { kind: 'media', id: '', mediaKind: kind, status: 'ready', elapsed: 0, error: null, prompt, dataUrl: null };
  if (b.is_error) return { ...base, status: 'error', error: text.replace(/^[^：:\n]{0,12}失败[：:]\s*/, '').trim() || '生成失败' };
  const id = (MEDIA_ID_RE.exec(text) || [])[1];
  return id ? { ...base, id } : null;
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
        const seg = mediaSegFromResult(u.kind, u.input, b);
        if (seg) out.push(seg);
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
const newChainState = () => ({ byUuid: new Map(), leaf: null, count: 0, failOpen: false, retracted: new Set() });
// 吃一条记录；返回这一条新撤回了几个 uuid
function chainTake(cs, o) {
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
const chainInc = (cs) => (!cs.failOpen && cs.leaf ? chainIncludeSet(cs) : null);
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
function makeHistoryParser(file, opts = {}) {
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
          if (o.progress) t.progress = annotateWorkflowEfforts(o.progress, file.replace(/\.jsonl$/i, '') + path.sep + 'subagents');
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
        ensureAsm(ts).segments.push({ kind: 'steer', text: peerIn ? peerDisplay(peerIn) : sp.text, files: sp.attachments.map((x) => x.name).filter(Boolean), ...(a.source_uuid ? { uuid: a.source_uuid } : {}), read: true });
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
            applyAnswerText(askByTool.get(b.tool_use_id), resultText(b));
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
            const seg = mediaSegFromResult(u.kind, u.input, b);
            if (seg) ensureAsm(ts).segments.push(seg);
            continue;
          }
          const entry = byToolUse.get(b.tool_use_id);
          if (!entry) continue;
          entry.status = b.is_error ? 'error' : 'done';
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
    };
    return { ctl, feed, finish, watched, holding: () => !!pendingManual || stopped };
  }
}

// —— /api/session 的增量解析缓存（2026-10-21）——
// 以前每次请求都把整份 transcript 从头解析两遍（主链扫描 + 重建），80–155MB 的会话一次 1.6–1.8 秒；Desktop / CLI 在跑的
// 会话每个 session.touch 都要来一遍（前端对账、多端各拉一次、列表刷新顺手预取）。jsonl 只追加，所以按（文件, 身份）记住
// 消化到的字节位置、主链状态和重建状态机：文件变长、新内容只是沿主链接着长（最常见），就只读新增的完整行喂给同一个状态机。
// 结果必须与全量 readSessionMessages 一致（session-history-cache.test.mjs 对拍），下面这些一律整份重建：
//   · 变短 / 同长但 mtime 变了 / 已消化部分末尾 64 字节变了（被改写）；
//   · 新内容里有安全栅门撤回（可能撤的是旧帧）；
//   · 主链分叉（回滚后新叶子沿链走不到旧叶子），或新主链经过了旧内容里的条目（旧行的去留会跟着变）；
//   · 收尾时扣着手动 /compact（收尾会把它原位挂上，之后续不上）；
//   · 展开过媒体的后台子 agent 转录后来又长了（全量重建会读到它新出的图）。
// 回滚锚点待生效（视图按锚点截断）的请求不走缓存；小于 1MB 的会话整份解析也就几毫秒，不占缓存。
const HIST_MIN = 1 << 20;
const HIST_MAX = 3;              // 最多记几份（一份状态大约是 transcript 的一成）
const HIST_IDLE = 10 * 60_000;   // 这么久没人看的丢掉
const histCache = new Map();     // file\0身份 → entry；Map 的插入序当 LRU
const histLocks = new Map();
const histStats = { hits: 0, extends: 0, builds: 0 };
export const _historyStats = () => ({ ...histStats });   // 单测 / 基准用

// 同一份缓存的读写串行（状态机不能被两个请求同时喂）；后到的排队，轮到时多半直接命中。
function withHistLock(k, fn) {
  const prev = histLocks.get(k) || Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => {});
  histLocks.set(k, tail);
  tail.then(() => { if (histLocks.get(k) === tail) histLocks.delete(k); });
  return run;
}

// 整份建：主链扫描 + 状态机，都只读到最后一个完整行。mark = 已消化部分的条目数（之后进来的条目序号都 ≥ 它）。
async function buildHistory(file, size, planRecord) {
  const cs = newChainState();
  const off = await readJsonlLines(file, 0, size, (b) => { const o = lineObj(b); if (o) chainTake(cs, o); });
  const inc = chainInc(cs);
  const parser = makeHistoryParser(file, { incSet: inc, retractedSet: cs.retracted, planRecord });
  await readJsonlLines(file, 0, off, (b) => parser.feed(lineStr(b)));
  return { cs, inc, parser, off, mark: cs.count, leaf: cs.leaf ? cs.leaf.uuid : null };
}

// 接着长：只读新增的完整行。返回 false = 不是「沿主链接着长」，调用方整份重建（e 的主链状态已经被喂过新行，丢掉）。
async function extendHistory(file, e, size) {
  const cs = e.cs;
  let retracted = 0;
  const end = await readJsonlLines(file, e.off, size, (b) => { const o = lineObj(b); if (o) retracted += chainTake(cs, o); });
  if (end === e.off) return true;   // 只多了半行
  if (retracted) return false;
  const inc = chainInc(cs);
  if ((inc === null) !== (e.inc === null)) return false;
  if (inc) {
    if (!e.leaf || !inc.has(e.leaf)) return false;
    for (const u of inc) {
      if (e.inc.has(u)) continue;
      const n = cs.byUuid.get(u);
      if (!n || n.first < e.mark) return false;
    }
  }
  e.parser.ctl.incSet = inc;
  e.parser.ctl.retractedSet = cs.retracted;
  await readJsonlLines(file, e.off, end, (b) => e.parser.feed(lineStr(b)));
  e.off = end; e.inc = inc; e.mark = cs.count; e.leaf = cs.leaf ? cs.leaf.uuid : null;
  return true;
}

async function watchedChanged(parser) {
  if (!parser.watched.length) return false;
  const sizes = await Promise.all(parser.watched.map((w) => fsp.stat(w.file).then((s) => s.size, () => -1)));
  return sizes.some((sz, i) => sz !== parser.watched[i].size);
}

/**
 * 与 readSessionMessages 同结果的历史读取，大会话走增量缓存（/api/session 用）。key = 身份（计划卡台账按身份查）。
 * 返回的消息对象与缓存共用：调用方只读、当场序列化，别改。
 */
export async function readSessionHistory(file, { key = '', cutAfterUuid = null, planRecord = null } = {}) {
  if (cutAfterUuid) return readSessionMessages(file, { cutAfterUuid, planRecord });
  const k = file + '\0' + key;
  return withHistLock(k, async () => {
    const now = Date.now();
    for (const [x, c] of histCache) if (now - c.used > HIST_IDLE) histCache.delete(x);
    let e = histCache.get(k) || null;
    histCache.delete(k);
    try {
      const st = await fsp.stat(file);
      if (st.size < HIST_MIN) return readSessionMessages(file, { planRecord });
      if (e && await watchedChanged(e.parser)) e = null;
      if (e && e.size === st.size && e.mtime === st.mtimeMs) { histStats.hits++; e.used = now; histCache.set(k, e); return e.out; }
      if (e && (st.size <= e.size || !(await readTail(file, e.off)).equals(e.tail))) e = null;
      if (e) {
        e.parser.ctl.planRecord = planRecord;
        if (await extendHistory(file, e, st.size)) histStats.extends++;
        else e = null;
      }
      if (!e) { histStats.builds++; e = await buildHistory(file, st.size, planRecord); }
      const holding = e.parser.holding();
      const out = e.parser.finish();
      if (holding) return out;   // 收尾改过状态、续不上：这份不留
      e.size = st.size; e.mtime = st.mtimeMs; e.used = now; e.out = out;
      e.tail = await readTail(file, e.off);
      histCache.set(k, e);
      while (histCache.size > HIST_MAX) histCache.delete(histCache.keys().next().value);
      return out;
    } catch {
      return readSessionMessages(file, { planRecord });
    }
  });
}

/** 会话被删：它的增量缓存一起丢。 */
function forgetHistory(file) {
  for (const k of [...histCache.keys()]) if (k.startsWith(file + '\0')) histCache.delete(k);
}

// 定位 transcript（/api/session、会话信息面板这类热路径）：先查会话列表的扫盘缓存（session-list.mjs，命中再异步确认文件
// 还在），查不到才走 locateSessionPaths——它对每个项目目录同步 existsSync 一遍（几十个目录 ~20ms，会话信息面板还要再来一遍）。
async function locateSession(ctx, id) {
  id = String(id || '');
  if (!/^[0-9a-fA-F-]{8,}$/.test(id)) return null;
  const hit = peekSessionFile(ctx, id);
  if (hit) {
    try {
      await fsp.access(hit.file);
      const dir = path.dirname(hit.file);
      return { dir, file: hit.file, subdir: path.join(dir, id), project: hit.project };
    } catch {}
  }
  return claudeProjects.locateSessionPaths(ctx.claudeProjects, ctx, id);
}

// 搜历史会话（供需要「按关键词找会话」的服务端调用方用）。2026-10-20 起走全文索引（runtime/session-search.mjs）：
// 覆盖该身份所有项目 + worktree，按标题 / 曾用名 / 正文匹配（以前只扫默认工作空间最近 60 个的首条消息）。
// query 空 = 返回最近的（不含已归档）。返回 [{ id, title, mtime, project, snippet?, archived? }]。
// 结果按层排（标题 → 宽松 → 正文），每层各有上限；这里收成 max 条时标题层最多占一半，正文命中不被挤掉。
export async function searchSessions(ctx, query, { max = 20 } = {}) {
  const r = await searchSessionsCore(ctx, query, { limit: max, archived: 'include', budgetMs: 4000, readFirst: readSessionTitle, trim: trimTitle });
  const hits = r.hits.filter((h) => h.title || h.snippet);
  const quota = { title: Math.ceil(max / 2), loose: 5 };
  const used = { title: 0, loose: 0 };
  const first = [], rest = [];
  for (const h of hits) {
    const k = h.match === 'former' ? 'title' : h.match;
    if (k in used && used[k] >= quota[k]) { rest.push(h); continue; }
    if (k in used) used[k]++;
    first.push(h);
  }
  return [...first, ...rest].slice(0, max).map((h) => ({
    id: h.sessionId, title: h.title, mtime: h.mtime, project: h.project,
    ...(h.snippet ? { snippet: h.snippet } : {}), ...(h.archived ? { archived: true } : {}),
  }));
}

// 一条会话现在该显示的标题（library 自定义名 > 标题链），导出 / 引用等单条场景用。
async function displayTitle(ctx, id, file) {
  const lib = getLibrary(ctx).titles || {};
  if (lib[id]) return trimTitle(lib[id]);
  let st = { size: 0, mtime: 0 };
  try { const s = statSync(file); st = { size: s.size, mtime: s.mtimeMs }; } catch {}
  const r = await resolveTitle({ id, file, ...st }, {
    fam: familyMaps(ctx).titles.get(id), desktop: lineageFor(ctx).titles.get(id), readFirst: readSessionTitle, trim: trimTitle,
  });
  return r.title;
}

// 首页带上「整组都比截断点老」的项目的最新几条：GROUP_HEAD 条；整组剩下不超过 GROUP_HEAD_ALL 条就全给
const GROUP_HEAD = 3, GROUP_HEAD_ALL = 4;
// 临时对话：首页最多带最近这么多条；侧栏「显示更多」用 ?project=@quick 翻页（@ 开头不会撞上项目 id）
const QUICK_HEAD = 20, QUICK_PAGE_ID = '@quick';
// rows 里出现的那些桶的到期时刻：按这些桶【全部】对话记录算（某只桶的较新一条可能在别的页里）
function quickExpiresFor(ctx, quickFiles, rows) {
  const ids = new Set(rows.map((r) => r.projectId));
  return ids.size ? claudeQuick.quickExpiries(ctx, quickFiles.filter((r) => ids.has(r.projectId))) : {};
}

export function registerSessionRoutes(router, { authOk, identify }) {
  router.on('GET', '/api/sessions', async (req, res, url) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(who);
    // 扫盘（所有项目目录 + worktree + 全部临时对话桶）见 runtime/session-list.mjs。
    // 归档与分页（2026-10-20，对齐官方 Desktop 的 Archive）：
    //   默认（活跃视图）：已归档的不进列表、不占 60 条名额；另回 archivedCount（已归档总数，侧栏「已归档」入口用）、
    //     projectCounts（各项目活跃会话总数——前端组内「显示更多」据此知道服务端还有多少）、more（活跃会话超出这一页）、
    //     cutoff（这 60 条里最旧那条的 mtime：组内翻页从这里往下要。收藏 / 一家子补进来的老行不算，它们不连续）。
    //   ?project=<id>&before=<mtime>&limit=N：某项目里比 before 更早的活跃会话（组内「显示更多」翻页，老会话找得回来）；
    //     另回 cursor（这一页最旧那条的 mtime，含被滤掉的无标题文件——下一页从这里接着要，整页都是噪声也不会停）。
    //   ?view=archived&offset=&limit=：已归档会话，按归档时间倒序（跟随 Desktop 来的没有归档时间，按活动时间）。
    //   默认视图另回 archiveRev（bridge 归档记录的版本，前端对不上就拉 GET /api/claude/archive）；
    //   带 ?keep=id,id（前端组内翻页拿回来的老行）时回 gone：其中已经不在活跃列表里的（别处删了、归档了、
    //   跟随 Desktop 归档了）——整表刷新只覆盖最新 60 条，这些老行靠它对账，不然会一直挂着幽灵行。
    // 计数（projectCounts / archivedCount / total）不算确定没标题的文件（列表会滤掉它们，见 session-titles.mjs
    // 的 knownUntitled；没解析过的先算上，后台 scheduleTitleWarm 把全集过一遍之后就准了）。
    //   临时对话（S1-6）：带 quick=2 的是认得「多条临时对话」的新前端——默认视图回最近 QUICK_HEAD 条 + quickCount /
    //     quickMore / quickCursor（侧栏「显示更多」用 ?project=@quick&before= 翻页）+ quickOrphans（只有文件、
    //     没有对话的桶）；不带的是还没更新的老前端（手机安装包里打包的界面），照旧只给一只桶的最新一条
    //    （claude-quick.mjs 的 legacyQuickSlot）。
    const sp = url ? url.searchParams : new URLSearchParams();
    const view = sp.get('view') === 'archived' ? 'archived' : 'active';
    const pageProject = view === 'active' ? sp.get('project') || '' : '';
    const quickV2 = sp.get('quick') === '2';
    const before = Number(sp.get('before')) || 0;
    const offset = Math.max(0, Number(sp.get('offset')) || 0);
    const limit = Math.max(1, Math.min(200, Number(sp.get('limit')) || (view === 'archived' ? 30 : 60)));
    // 异步扫盘 + 2s 短缓存 + 单飞（10-21：以前每个请求同步扫一遍，开一次 Claude 页首页 + 各项目翻页同时到，整台服务冻 0.7–2.4s）
    const { files: allFiles, quickFiles } = await listSessionFilesAsync(ctx);
    // Which sessions have a generation in flight on THIS server（多对话并发：可能多个）。
    const liveGens = getLiveGens(ctx.key);
    const liveIds = new Set(liveGens.map((g) => g.sessionId).filter(Boolean));
    // 官方 Desktop 子会话树（desktop-lineage.mjs）与 bridge 自己派生的子会话（session-family.mjs）并成一张表，
    // 再扣掉「移到顶层」过的（session-lineage.mjs）：parentId = 顶层祖先，前端据此把子行缩进挂在根下。
    const desktop = lineageFor(ctx);
    const fam = familyMaps(ctx);
    const lineage = sessionLineage(ctx, { desktop, fam }).rootOf;
    const listable = (f) => liveIds.has(f.id) || sessionQuestions.hasFor(f.id, ctx.key) || !knownUntitled(f, { fam: fam.titles.get(f.id), desktop: desktop.titles.get(f.id) });
    // 自动归档之后又在别处（Desktop / CLI）聊过的：记录清掉、回到活跃列表（runtime/session-archive-auto.mjs）
    if (view === 'active' && !pageProject) dropStaleInactive(ctx, allFiles);
    // 归档态（bridge 记录优先，其次跟随 Desktop）。在跑 / 在问的会话一律算活跃：在 Desktop 里归档过、
    // 又在 bridge 里接着聊的那条不能从侧栏消失（真人发消息时 claude.mjs 也会顺手取消归档）。
    const arch = archiveView(ctx);
    const files = [], archived = [];
    for (const f of allFiles) {
      const busy = liveIds.has(f.id) || sessionQuestions.hasFor(f.id, ctx.key);
      // Desktop 的侧边对话（/btw）：官方侧栏不列，这里也不列——活跃、归档、计数都不算（在跑 / 在问的照旧显示）
      if (!busy && desktop.btw && desktop.btw.has(f.id)) continue;
      const a = busy ? null : arch(f.id, f.mtime, f.size);
      if (a) archived.push({ ...f, arch: a }); else files.push(f);
    }
    let capped, more = false;
    const extra = {};
    if (view === 'archived') {
      const list = archived.filter(listable).sort((a, b) => (b.arch.at || b.mtime) - (a.arch.at || a.mtime));
      capped = list.slice(offset, offset + limit);
      more = list.length > offset + limit;
      extra.total = list.length;
    } else if (pageProject === QUICK_PAGE_ID) {
      // 临时对话区「显示更多」翻页：比 before 更早的临时对话，带上这些桶的到期时刻
      const list = quickFiles.filter((f) => !before || f.mtime < before);
      capped = list.slice(0, limit);
      more = list.length > limit;
      extra.cursor = capped.length ? capped[capped.length - 1].mtime : 0;
      extra.quickExpires = await quickExpiresFor(ctx, quickFiles, capped);
    } else if (pageProject) {
      const list = files.filter((f) => f.projectId === pageProject && (!before || f.mtime < before));
      capped = list.slice(0, limit);
      more = list.length > limit;
      extra.cursor = capped.length ? capped[capped.length - 1].mtime : 0;
    } else {
      // 临时对话【不占也不吃】60 条上限：侧栏单独一区，聊得再久也不该被新会话挤出列表（挤掉了就等于凭空消失）。
      // 但一条一只桶、30 天才回收，数量能攒到几百：首页只带最近 QUICK_HEAD 条，其余侧栏「显示更多」翻页要。
      // 与普通会话按 mtime 合并成一列（列表恒按 mtime 倒序，lib/sessionsOrder.js 的不变量；前端预取最新几条也靠它）。
      let quickHead;
      if (quickV2) {
        const qList = quickFiles.filter(listable);
        quickHead = qList.slice(0, QUICK_HEAD);
        extra.quickCount = qList.length;
        extra.quickMore = qList.length > QUICK_HEAD;
        extra.quickCursor = extra.quickMore ? quickHead[quickHead.length - 1].mtime : 0;
        // 只有文件、没有对话的桶（最近一轮回收扫出来的）：侧栏单独列，不让它们无声地走完两轮 30 天
        extra.quickOrphans = claudeQuick.quickOrphans(ctx).filter((o) => !quickFiles.some((f) => f.projectId === o.id));
      } else {
        const slot = claudeQuick.legacyQuickSlot(ctx, quickFiles);
        const head = slot ? quickFiles.find((f) => f.projectId === slot) : null;
        quickHead = head ? [head] : [];
      }
      capped = [...quickHead, ...files.slice(0, limit)].sort((a, b) => b.mtime - a.mtime);   // 标题有缓存（session-titles.mjs），但响应体积仍要有上界
      more = files.length > limit;
      extra.cutoff = more ? files[limit - 1].mtime : 0;
      // 临时对话的回收时间表（S1-6）：首页这些桶的到期时刻 + 策略天数 + 回收站里有几只。界面上的「n 天后清理」与
      // 回收站入口都按它显示——到期时刻与 pruneQuick 同一算法，写的天数就是真实回收的时候。
      extra.quickExpires = await quickExpiresFor(ctx, quickFiles, quickHead);
      extra.quickPolicy = { ttlDays: claudeQuick.QUICK_TTL_DAYS, warnDays: claudeQuick.QUICK_WARN_DAYS, trashDays: claudeQuick.QUICK_TRASH_DAYS };
      extra.quickRecycled = claudeQuick.recycledQuickCount(ctx);
      const projectCounts = {};
      for (const f of files) if (listable(f)) projectCounts[f.projectId] = (projectCounts[f.projectId] || 0) + 1;
      extra.archivedCount = archived.filter(listable).length;
      extra.projectCounts = projectCounts;
      extra.archiveRev = getArchiveState(ctx).rev;
      const keep = String(sp.get('keep') || '').split(',').filter((x) => /^[0-9a-fA-F-]{8,64}$/.test(x)).slice(0, 300);
      if (keep.length) {
        // 翻页拿回来的老行也可能是临时对话（侧栏「显示更多」），它们还在就不算 gone
        const alive = new Set([...files, ...quickFiles].filter(listable).map((f) => f.id));
        extra.gone = keep.filter((id) => !alive.has(id));
      }
      // 全文搜索索引与标题缓存：有人打开 Claude 页就在后台把它们建起来（节流、延后，首个搜索就快、计数就准）
      scheduleSearchWarm(ctx, () => listSessionFilesAsync(ctx).then((r) => [...r.quickFiles, ...r.files]));
      scheduleTitleWarm(ctx, () => listSessionFilesAsync(ctx).then((r) => r.files), () => {
        const fm = familyMaps(ctx);
        return { famTitles: fm.titles, desktopTitles: lineageFor(ctx).titles, readFirst: readSessionTitle, trim: trimTitle };
      });
    }
    // 一家子不被 60 条截断拆散：列进来的根带上它所有子会话，列进来的子会话也把根补上（只在活跃会话里补）。
    if (view === 'active' && !pageProject && lineage.size && files.length > limit) {
      const inIds = new Set(capped.map((f) => f.id));
      const roots = new Set();
      for (const f of capped) roots.add(lineage.get(f.id) || f.id);
      for (const f of files.slice(limit)) {
        if (inIds.has(f.id) || !roots.has(lineage.get(f.id) || f.id)) continue;
        capped.push(f); inIds.add(f.id);
      }
    }
    // 收藏的会话同理不被 60 条挤掉：侧栏「收藏」区是常驻的，老会话收藏了也要一直在（官方 Pinned 同款）
    if (view === 'active' && !pageProject && files.length > limit) {
      const stars = new Set(getLibrary(ctx).stars || []);
      if (stars.size) {
        const inIds = new Set(capped.map((f) => f.id));
        for (const f of files.slice(limit)) if (stars.has(f.id) && !inIds.has(f.id)) { capped.push(f); inIds.add(f.id); }
      }
    }
    // 首页 60 条里一条都没有的项目（整组都比截断点老）：每组顺带最新几条（10-21）。以前前端进页就替这些组各发一个
    // ?project= 翻页（本机 5 个并发、各扫一遍盘），现在首页一次给齐；剩得不多就整组给完，免得组下孤零零挂一行「显示更多」。
    // 组内翻页的游标照旧从 cutoff 往下要，这几条前端按 id 去重。
    if (view === 'active' && !pageProject && files.length > limit) {
      const stars = new Set(getLibrary(ctx).stars || []);
      const shownIn = new Set(capped.filter((f) => !stars.has(f.id)).map((f) => f.projectId));
      const inIds = new Set(capped.map((f) => f.id));
      const rest = new Map();   // projectId → 该组截断点之后的活跃会话（mtime 倒序）
      for (const f of files.slice(limit)) {
        if (shownIn.has(f.projectId) || inIds.has(f.id) || stars.has(f.id) || !listable(f)) continue;
        let l = rest.get(f.projectId);
        if (!l) rest.set(f.projectId, (l = []));
        l.push(f);
      }
      for (const l of rest.values()) capped.push(...(l.length <= GROUP_HEAD_ALL ? l : l.slice(0, GROUP_HEAD)));
    }
    // 已归档视图带上 bridge 的归档记录（前端据此判断「当前打开的会话已归档」，显示横条）
    if (view === 'archived') extra.archive = getArchiveState(ctx);
    // 顺手按时间回收临时对话（30 天没动进回收站、回收站再放 30 天才删；节流、后台跑，不拖慢本次列表）。
    if (view === 'active' && !pageProject) claudeQuick.schedulePruneQuick(ctx, { busy: liveIds, onDrop: (id) => dropChatPrefs(ctx, id) });
    // 还躺在临时对话目录里的「存好的工作空间」（10-21 前存的 / 存时有会话在跑）补挪到固定位置（节流、后台）。
    claudeProjects.scheduleRelocateSavedQuicks(ctx.claudeProjects, ctx, { busy: liveIds, release: (sid) => releaseWarmClaude(ctx.key, sid) });
    const newest = liveGens[liveGens.length - 1] || null;
    const active = newest ? (newest.sessionId || null) : null;
    // 侧栏工作点只认真正在生成的轮：done 已发、只剩收尾（effort 定局、上下文用量，1–13s）的 gen 带
    // finalizing，还算 live 但界面上这轮已经结束。不排除它会撞时序：前端在 done 那一刻（busy→false）
    // 拉列表，服务端此刻还在收尾 → 回 thinking:true；而 run.end 推送比这次全量扫盘的响应先到，
    // 被迟到的响应盖回去，点就一直亮到下一次整表刷新（10-21 实测，常常是下一轮）。
    const workingIds = new Set(liveGens.filter((g) => !g.finalizing).map((g) => g.sessionId).filter(Boolean));
    // 标题链（runtime/session-titles.mjs）：jsonl 尾部 custom-title > bridge 派生名 / Desktop 标题 > ai-title > 首条消息；
    // 用户在 bridge 里改过名的由前端 titleFor() 用 library 覆盖（清掉自定义名就回到这条链）。按 size+mtime 缓存。
    const titles = await resolveTitles(capped, { famTitles: fam.titles, desktopTitles: desktop.titles, readFirst: readSessionTitle, trim: trimTitle });
    const built = capped.map((f) => ({
      id: f.id,
      mtime: f.mtime,
      size: f.size,
      projectId: f.projectId,
      ...(f.wt ? { wt: f.wt } : {}),
      ...(lineage.has(f.id) ? { parentId: lineage.get(f.id) } : {}),
      // 直接父（bridge 派生的才有）：会话信息面板的「相关会话」卡、工具行的跳转用；parentId 是顶层祖先（侧栏只缩进一级）
      ...(fam.parentOf.has(f.id) ? { spawnedBy: fam.parentOf.get(f.id) } : {}),
      title: titles.get(f.id)?.title || '',
      ...(f.arch ? { archived: true, archivedReason: f.arch.reason, ...(f.arch.at ? { archivedAt: f.arch.at } : {}) } : {}),
    }));
    // Drop sessions whose title we can't read — those are .jsonl files currently
    // locked by other live claude.exe processes (the desktop Claude Code session,
    // sub-agents, etc.) or with no user text. They're unreadable noise here.
    // Always keep the in-flight session, labeled.
    const sessions = built
      .filter((s) => s.title || liveIds.has(s.id) || sessionQuestions.hasFor(s.id, ctx.key))
      .map((s) => ({
        ...s,
        title: s.title || '（进行中…）',
        thinking: workingIds.has(s.id),      // a turn is generating in this conversation
        pending: sessionQuestions.hasFor(s.id, ctx.key) || hasPeerHold(ctx.key, s.id), // an AskUserQuestion is waiting here（或跨会话消息等你确认）
        origin: routineSessions.has(s.id) ? 'routine' : pluginSessions.has(s.id) ? 'plugin' : (bridgeSessions.has(s.id) ? 'phone' : 'desktop'),
        ...(pluginSessions.has(s.id) ? { originLabel: pluginSessions.get(s.id).label || pluginSessions.get(s.id).plugin } : {}),
      }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // prefsLast：最近一次发送用的 model/effort/fast——前端「新对话」的选择器默认（跨设备）。
    res.end(JSON.stringify({ sessions, active, actives: [...liveIds], pending: [...sessionQuestions.keysFor(ctx.key)], prefsLast: lastChatPrefs(ctx), library: getLibrary(ctx), ...extra, more }));   // library：收藏 + 自定义标题（按身份落服务端，换设备照样在）
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
  // 临时对话桶一只一枚 quick 项目，全部列出（带 quick=2 的新前端）；还没更新的老前端（不带）只认一只「快照」，
  // 照旧只给一只——与 /api/sessions 同一个挑法（claude-quick.mjs 的 legacyQuickSlot），两边对得上。
  router.on('GET', '/api/claude/projects', async (req, res, url) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    const quickV2 = !!url && url.searchParams.get('quick') === '2';
    let slot = null;
    if (!quickV2) {
      try { slot = claudeQuick.legacyQuickSlot(ctx, (await listSessionFilesAsync(ctx)).quickFiles); } catch {}
    }
    projJson(res, () => {
      let projects = claudeProjects.listProjects(ctx.claudeProjects, ctx);
      if (!quickV2) {
        const keep = projects.find((p) => p.quick && p.id === slot) || projects.find((p) => p.quick && p.current) || null;
        projects = projects.filter((p) => !p.quick || p === keep);
      }
      return { projects, order: claudeProjects.projectOrder(ctx.claudeProjects) };
    });
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
    projJson(res, () => ({ ok: true, project: claudeProjects.renameProject(ctx.claudeProjects, ctx, body.id, body.name) }));
  });
  router.on('POST', '/api/claude/project/delete', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => ({ ok: claudeProjects.deleteProject(ctx.claudeProjects, ctx, body.id) }));
  });
  // 「新建临时对话」：给一只没用过的空桶（当前桶没用过就是它，用过了就现铸一只；用过的旧桶照常列出、按时间回收）。
  // 前端拿到 project 后直接以它为上下文开一条空对话——新桶=新 cwd=新自动记忆目录，前尘不带。
  router.on('POST', '/api/claude/quick/new', (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    projJson(res, () => ({ ok: true, project: claudeQuick.newQuickProject(ctx) }));
  });
  // 「存为工作空间」：某只临时对话桶登记成普通项目（不再按时间回收），随后挪到固定位置。
  // { id: 那条临时对话所在的桶（会话行的 projectId；老前端传的是当前桶 id）, label: 显示名（那条对话的标题，可空）,
  //   base: 没有 label 时的显示名前缀（按界面语言，后面接编号）}
  // → { project: 存好的工作空间（id 沿用桶 id）, quick: 当前的空桶 }
  router.on('POST', '/api/claude/quick/save', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    let saved;
    try { saved = claudeProjects.saveQuickProject(ctx.claudeProjects, ctx, { id: body && body.id, base: body && body.base, label: body && body.label }); }
    catch (e) { projJson(res, () => { throw e; }); return; }
    // 老前端（body 不带 quick:2）存完，它的「快照」位换上的是当前空桶：记一笔，老前端的列表照旧语义（legacyQuickSlot）
    if (!body || body.quick !== 2) claudeQuick.markQuickHanded(ctx);
    // 当场挪出快照目录（固定位置，任何回收都不扫那里）；有会话在跑就先原地，会话列表接口稍后补挪。
    try {
      const busy = new Set(getLiveGens(ctx.key).map((g) => g.sessionId).filter(Boolean));
      const moved = await claudeProjects.relocateSavedQuicks(ctx.claudeProjects, ctx, { busy, release: (sid) => releaseWarmClaude(ctx.key, sid) });
      const hit = moved.find((m) => m.id === saved.project.id);
      if (hit) saved.project = { ...saved.project, path: hit.path };
    } catch (e) { console.warn('[quick] relocate on save failed:', e?.message || e); }
    projJson(res, () => ({ ok: true, ...saved }));
  });
  // 「继续保留」：给这只临时对话桶记一次活动，回收时钟从头算。{ id } → { id, expiresAt }
  router.on('POST', '/api/claude/quick/keep', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => ({ ok: true, ...claudeQuick.keepQuick(ctx, body && body.id) }));
  });
  // 临时对话回收站：到期的桶整只挪在这里（对话记录留在原处），再放 30 天才永久删除。
  // → { items: [{ id, sessionId（最新那条对话，前端据此套用户改过的标题）, title, sessions, items, recycledAt, purgeAt, lastActive }] }（新回收的在前）
  router.on('GET', '/api/claude/quick/recycled', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    try {
      const list = await claudeQuick.listRecycledQuick(ctx);
      const heads = list.map((x) => x.files[0]).filter(Boolean);
      const titles = await resolveTitles(heads, { famTitles: new Map(), desktopTitles: new Map(), readFirst: readSessionTitle, trim: trimTitle });
      const items = list.map((x) => ({
        id: x.id, sessionId: x.files[0]?.id || null, title: (x.files[0] && titles.get(x.files[0].id)?.title) || '', sessions: x.files.length, items: x.items,
        recycledAt: x.recycledAt, purgeAt: x.purgeAt, lastActive: x.lastActive,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ items }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e?.message || '读取回收站失败' }));
    }
  });
  // 从回收站恢复：整只桶挪回列表，对话与产物原样接上。{ id } → { project }
  router.on('POST', '/api/claude/quick/restore', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    let body; try { body = JSON.parse(await readBody(req)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => {
      const project = claudeQuick.restoreQuick(ctx, body && body.id);
      invalidateSessionFiles();   // 会话列表的 2s 缓存里还没有它
      // 没有对话记录、只有文件的那种：马上重扫一遍，侧栏「只有文件」那一行不用等 5 分钟才出来
      const busy = new Set(getLiveGens(ctx.key).map((g) => g.sessionId).filter(Boolean));
      claudeQuick.schedulePruneQuick(ctx, { busy, onDrop: (id) => dropChatPrefs(ctx, id) }, { force: true });
      return { ok: true, project };
    });
  });

  // 会话收藏 / 自定义标题（跨设备）：{op:'star'|'title'|'merge', …} → { library }。
  // 有变化就推总线 {type:'library'}，同账号其它在线设备即刻跟上。快照访客（ctx.snap）不开放。
  router.on('POST', '/api/claude/library', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    if (ctx.snap) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return; }
    let body; try { body = JSON.parse(await readBody(req, 256 * 1024)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => {
      const { library, changed } = applyLibraryOp(ctx, body);
      if (changed) busPublish(ctx.key, { type: 'library', library });
      return { ok: true, library };
    });
  });

  // Claude 分页设置（注册表 src/config/claude-settings.mjs；按身份存服务端，主机级仅管理员）。
  // GET → { settings }；POST { patch:{key:value|null} } → 校验后落盘、推总线 {type:'claude.settings'}。
  router.on('GET', '/api/claude/settings', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    projJson(res, () => ({ ok: true, settings: claudeSettingsSnapshot(ctx) }));
  });
  router.on('POST', '/api/claude/settings', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    if (ctx.snap) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return; }
    let body; try { body = JSON.parse(await readBody(req, 64 * 1024)); } catch { res.writeHead(400); res.end('bad json'); return; }
    projJson(res, () => {
      const followBefore = claudeSetting(ctx, 'followDesktopArchive');
      const { settings, changed, hostChanged } = setClaudeSettings(ctx, body && body.patch);
      if (changed) busPublish(ctx.key, { type: 'claude.settings', settings });
      // 「跟随 Claude Desktop 的归档」一切换，哪些会话算已归档就整批变了（bridge 的归档记录本身没变、不会有 archive 事件）：
      // 推一帧 archive（basis），侧栏活跃列表 / 已归档计数 / 开着的已归档视图当场重拉
      if (changed && claudeSetting(ctx, 'followDesktopArchive') !== followBefore) busPublish(ctx.key, { type: 'archive', archive: getArchiveState(ctx), basis: true });
      // 主机级改动影响所有身份的快照（如 allowBypass 裁剪权限模式）；管理员自己的设备立即跟上，其余身份下次拉取时拿到。
      else if (hostChanged) busPublish(ctx.key, { type: 'claude.settings', settings });
      return { ok: true, settings };
    });
  });

  // 会话级输出风格（官方会话菜单「Output style」同款，输入栏加号菜单里选）：只影响这一个会话，下一轮起生效。
  // GET ?session=<id> → { style（这个会话的覆盖，null = 跟随默认）, def（设置里的默认）, styles }；
  // POST { session, style|null } → 记进 chat-prefs，推总线 {type:'output_style'} 让同账号别的设备的菜单跟上。
  router.on('GET', '/api/claude/output-style', async (req, res, url) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    const sid = String(url.searchParams.get('session') || '');
    projJson(res, () => {
      const s = claudeSettingsSnapshot(ctx);
      return { ok: true, style: sid ? (chatPrefsFor(ctx, sid)?.outputStyle || null) : null, def: s.values.outputStyle, styles: s.outputStyles };
    });
  });
  router.on('POST', '/api/claude/output-style', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    if (ctx.snap) { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('forbidden'); return; }
    let body; try { body = JSON.parse(await readBody(req, 8 * 1024)); } catch { res.writeHead(400); res.end('bad json'); return; }
    const sid = String((body && body.session) || '');
    projJson(res, () => {
      if (!/^[0-9a-fA-F-]{8,80}$/.test(sid)) throw Object.assign(new Error('bad session'), { status: 400 });   // 同其它会话接口（不放过 __proto__ 之类）
      const v = validSessionOutputStyle(ctx, body.style);
      if (!v.ok) throw Object.assign(new Error('没有这个输出风格'), { status: 400 });
      setChatPrefsOutputStyle(ctx, sid, v.value);
      busPublish(ctx.key, { type: 'output_style', sessionId: sid, style: v.value });
      return { ok: true, style: v.value };
    });
  });

  // 会话信息面板（官方 Session rail）要的两样服务端数据：「输出内容」（transcript 推算，session-outputs.mjs）
  // 与「连接器」（最近一轮 init 帧的 MCP 状态，session-mcp.mjs）。环境 / 上下文 / 更改前端已有现成来源。
  router.on('GET', '/api/claude/session-rail', async (req, res, url) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { res.writeHead(401, { 'Content-Type': 'text/plain' }); res.end('unauthorized'); return; }
    const ctx = contextFor(who);
    const id = url.searchParams.get('id') || '';
    if (!/^[0-9a-fA-F-]{8,}$/.test(id)) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('bad id'); return; }
    const p = await locateSession(ctx, id);
    if (!p) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
    // 所属项目就是 transcript 所在的那个 scope（locateSessionProject 再逐目录同步找一遍也是它）
    const cwd = (p.project && p.project.path) || ctx.cwd;
    let outputs = [];
    try { outputs = await sessionOutputs(p.file, { cwd, linkRoots: deliverRoots(ctx, cwd, VAULT), anywhere: deliverAnywhere(ctx) }); } catch {}
    // 相关会话（session-family.mjs）：父 / 子 / 兄弟，带状态与各自最新汇报的开头
    let family = null;
    try { const f = await linkedSessions(ctx, id, { reports: true }); if (f.parent || f.children.length || f.siblings.length) family = f; } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ outputs, mcp: sessionMcp(ctx.key, id), family }));
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
    // 项目制：transcript 可能在任一项目目录，跨目录定位（含防穿越；先查会话列表的扫盘缓存）。
    const p = await locateSession(ctx, id);
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
    // 大会话走增量解析缓存（readSessionHistory：只读新增的行，结果与整份重建一致）
    const all = await readSessionHistory(p.file, { key: ctx.key, cutAfterUuid: pendingRewindAnchor(id), planRecord: (tid) => planRecordFor(ctx, tid) });
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
    // prefs：这个会话上次用的 model/effort/fast（sidecar）——前端恢复选择器。
    // wt：worktree 会话的 cwd 与分支（工作台/归属芯片据此指向 worktree 而不是主检出）。
    // archived / archivedReason：与侧栏列表同一口径（含跟随 Desktop）——冷启动恢复、直接打开
    // 一条已归档的会话时，前端靠它亮「此会话已归档」横条（lib/sessionArchive.svelte.js）
    let arc = {}; try { const st = statSync(p.file); arc = sessionArchiveFlag(ctx, id, st.mtimeMs, st.size); } catch {}
    // 长会话的响应能有 ~1MB：超过 64KB 且客户端收 gzip 就压（LAN 直连收益最大）。消息对象与解析缓存共用，sendJson 当场序列化。
    await sendJson(req, res, { id, projectId: p.project.id, ...(p.project.worktree ? { wt: { cwd: p.project.path, branch: p.project.worktree.branch } } : {}), messages, truncated: all.length > messages.length, prefs: chatPrefsFor(ctx, id), fp, ...arc, ...(sessionMcp(ctx.key, id) ? { mcp: sessionMcp(ctx.key, id).servers } : {}) });
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
      if (url.searchParams.get('site') === '1' && isHtmlFile(file)) return respondHtmlSite(res, file, roots.filter((root) => isInside(file, root)));
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
      invalidateSessionFiles();   // 会话列表的扫盘缓存（session-list.mjs）与这条的增量解析缓存一起作废
      forgetHistory(p.file);
      dropChatPrefs(ctx, String(parsed.id));   // 选择器记忆 sidecar 同步清
      { const lib = dropFromLibrary(ctx, String(parsed.id)); if (lib) busPublish(ctx.key, { type: 'library', library: lib }); }   // 收藏 / 自定义标题同步清
      { const a = forgetArchived(ctx, String(parsed.id)); if (a) busPublish(ctx.key, { type: 'archive', archive: a }); }   // 归档记录同步清
      forgetDetached(ctx, String(parsed.id));   // 「移到顶层」记录同步清
      forgetActivity(ctx, String(parsed.id));   // bridge 轮次时刻 / 自动归档时的大小同步清
      forgetSession(ctx, String(parsed.id));   // 父子关系同步清：它派生的子会话升为顶层
      // 别的设备：侧栏翻页拿回来的老会话、已归档列表里的这一行就地摘掉（整表刷新只管最新那 60 条）
      busPublish(ctx.key, { type: 'session.gone', sessionId: String(parsed.id) });
      forgetPrSession(ctx, String(parsed.id));   // 拉取请求台账同步清：后台别再为它读 GitHub、唤醒不存在的会话
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
      const title = (await displayTitle(ctx, id, p.file)) || ('会话 ' + id.slice(0, 8));   // 与侧栏同一条标题链（含改过的名）
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
