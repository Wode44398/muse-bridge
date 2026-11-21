// Antigravity 多代理树、状态推断、增量转录与主会话后台自动唤醒同步（只读解析 agy 落盘文件）。
//
// agy 的多代理数据落在 <dataDir>/brain/<id>/.system_generated/ 与 <dataDir>/conversations/<id>.db：
//   subagents/<subId>.json       当前会话直接派出的子代理（递归嵌套，state 仅在被显式杀掉时变 KILLED）
//   messages/<msgId>.json        收件箱消息（含父→子指派、子→父汇报、定时任务通知）
//   logs/transcript_full.jsonl   完整步骤记录（每行一个 JSON 步骤：USER_INPUT / SYSTEM_MESSAGE / PLANNER_RESPONSE / GENERIC）
//   conversations/<id>.db        SQLite 步骤表（status: 1=PENDING, 2=RUNNING, 3=DONE, 7=ERROR, 8=GENERATING）
//
// 注意：严禁修改 agy 的任何文件，所有 SQLite 读取使用只读模式并立即关闭，避免占锁。

import {
  closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { sessionBrainDir } from './background.mjs';
import { normalizeAgyPath } from './paths.mjs';
import { isWakePrompt } from './wake-prompt.mjs';
import { hasActiveSwarm, listSwarmMemberNodes, readSwarmSummary } from './swarm.mjs';

const ID_RE = /^[0-9a-f-]{8,64}$/i;
const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const TAIL_BYTES = 256 * 1024;
const PROMPT_CAP = 120_000;
const OUTPUT_CAP = 8_000;
const TEXT_CAP = 24_000;
const MAX_ENTRIES = 1_500;
const ORPHAN_STALE_MS = 30 * 60_000;
const ACTIVE_STEP_STATUSES = new Set([1, 2, 8]);
const STEP_TYPE_PLANNER = 15;
const SUBAGENT_ID_IN_TEXT_RE = /\bconversationId['":\s=]+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
const BG_TASK_RE = /background task with task id:\s*([^\s.,;]+)/i;
const TASK_DONE_RE = /Task id "([^"]+)"\s+(finished|was canceled|failed)/i;
const SYS_MSG_PREAMBLE_RE = /^The following is a <SYSTEM_MESSAGE>[^\r\n]*(?:\r?\n)+/i;
const SYS_MSG_WRAPPER_RE = /<SYSTEM_MESSAGE>\s*\r?\n\[Message\][^\r\n]*?\bcontent=([\s\S]*?)(?:\r?\n<\/SYSTEM_MESSAGE>|\s*<\/SYSTEM_MESSAGE>|$)/i;
const SYS_MSG_TAG_RE = /<SYSTEM_MESSAGE>\s*([\s\S]*?)\s*<\/SYSTEM_MESSAGE>/i;
const SYS_MSG_SENDER_RE = /\[Message\][^\r\n]*?\bsender=([^\s\r\n]+)/i;
const SYS_MSG_TS_RE = /\[Message\][^\r\n]*?\btimestamp=([^\s\r\n]+)/i;
const MODEL_EFFORT_RE = /^(.*?)(?:-(?:tiered|thinking))?-(xhigh|high|medium|low|max|minimal)$/i;

/** 从 agy 记录的原始 model ID 拆出基础模型 ID 与思考档位（如 gemini-4-hydrogen-tiered-high → gemini-4-hydrogen + high）。 */
export function parseModelAndEffort(rawModel = '') {
  const raw = String(rawModel || '').trim();
  if (!raw) return { raw: '', modelBase: '', effort: '' };
  const m = MODEL_EFFORT_RE.exec(raw);
  if (m && m[1]) {
    const modelBase = m[1].replace(/-tiered$/i, '');
    return { raw, modelBase, effort: m[2].toLowerCase() };
  }
  return { raw, modelBase: raw, effort: '' };
}

let sqliteMod;
function openSqliteReadOnly(file) {
  if (sqliteMod === undefined) {
    try { sqliteMod = createRequire(import.meta.url)('node:sqlite'); } catch { sqliteMod = null; }
  }
  if (!sqliteMod?.DatabaseSync || !existsSync(file)) return null;
  return new sqliteMod.DatabaseSync(file, { readOnly: true });
}

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

function clip(str, n = 200) {
  const s = String(str ?? '').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function clipLine(str, n = 140) {
  const s = String(str ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function parseArgs(raw) {
  if (!raw) return {};
  if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return {};
}

function transcriptFileOf(dataDir, sessionId) {
  const dir = sessionBrainDir(dataDir, sessionId);
  if (!dir) return '';
  for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const file = path.join(dir, '.system_generated', 'logs', name);
    if (existsSync(file)) return file;
  }
  return '';
}

function inferToolKind(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('browser')) return 'browser';
  if (/read|view/.test(n)) return 'read';
  if (/edit|write|patch|replace|create_file/.test(n)) return 'edit';
  if (/delete/.test(n)) return 'delete';
  if (/grep|glob|find|search/.test(n)) return 'search';
  if (/command|bash|shell|exec|terminal/.test(n)) return 'execute';
  return 'other';
}

function inferSubagentKind(typeName = '', role = '') {
  const combined = `${typeName} ${role}`.toLowerCase();
  if (/image/.test(combined)) return 'image';
  if (/teamwork|orchestrat|coordinat|supervisor/.test(combined)) return 'teamwork';
  if (/workflow/.test(combined)) return 'workflow';
  if (/research|explor|survey|audit|review/.test(combined)) return 'research';
  return 'subagent';
}

function toolQuickSummary(name = '', args = {}) {
  const n = String(name || '').toLowerCase();
  if (args.toolSummary) return clipLine(args.toolSummary, 100);
  if (n === 'invoke_subagent') return clipLine([args.Role || args.TypeName, args.Prompt].filter(Boolean).join(' · '), 100);
  if (n === 'send_message') return clipLine(args.Message || args.Recipient || '', 100);
  if (n === 'run_command') return clipLine(args.CommandLine || args.command || '', 100);
  if (n === 'read_file' || n === 'write_file' || n === 'edit_file' || n === 'view_file') {
    const p = String(args.Path || args.path || args.AbsolutePath || args.TargetFile || '');
    return p ? clipLine(p.split(/[\\/]/).slice(-2).join('/'), 100) : '';
  }
  if (n === 'search_web') return clipLine(args.query || '', 100);
  if (n === 'schedule') return clipLine(args.Prompt || args.CronExpression || '', 100);
  const firstVal = Object.values(args).find((v) => typeof v === 'string' && v.trim());
  return firstVal ? clipLine(firstVal, 80) : '';
}

/** 剥掉 agy 内部前导说明与 <SYSTEM_MESSAGE>[Message] … content=...</SYSTEM_MESSAGE> 包装，还原给人看的正文。 */
export function unwrapSystemMessage(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return { sender: '', timestamp: '', text: '' };
  const senderMatch = SYS_MSG_SENDER_RE.exec(s);
  const tsMatch = SYS_MSG_TS_RE.exec(s);
  const bodyMatch = SYS_MSG_WRAPPER_RE.exec(s);
  if (bodyMatch) {
    return {
      sender: senderMatch ? senderMatch[1] : '',
      timestamp: tsMatch ? tsMatch[1] : '',
      text: bodyMatch[1].trim(),
    };
  }
  const tagMatch = SYS_MSG_TAG_RE.exec(s);
  if (tagMatch) {
    return {
      sender: senderMatch ? senderMatch[1] : '',
      timestamp: tsMatch ? tsMatch[1] : '',
      text: tagMatch[1].trim(),
    };
  }
  return {
    sender: senderMatch ? senderMatch[1] : '',
    timestamp: tsMatch ? tsMatch[1] : '',
    text: s.replace(SYS_MSG_PREAMBLE_RE, '').replace(/^<SYSTEM_MESSAGE>\s*/i, '').replace(/\s*<\/SYSTEM_MESSAGE>$/i, '').trim(),
  };
}

/** 读取 conversations/<id>.db 里的步骤活动状态（只读，不占锁；db 缺失时安全退化）。 */
export function readDbActivity(dataDir, sessionId) {
  const empty = {
    exists: false,
    totalSteps: 0,
    activeSteps: 0,
    activeStepIdxs: new Set(),
    activeTurnStepIdxs: new Set(),
    hasActiveSteps: false,
    hasRunning: false,
    lastIdx: -1,
    lastStatus: 0,
    maxPlannerIdx: -1,
  };
  const id = String(sessionId || '').trim();
  if (!dataDir || !ID_RE.test(id)) return empty;
  const dbFile = path.join(dataDir, 'conversations', id + '.db');
  if (!existsSync(dbFile)) return empty;
  let db = null;
  try {
    db = openSqliteReadOnly(dbFile);
    if (!db) return empty;
    const cols = new Set(db.prepare('PRAGMA table_info(steps)').all().map((c) => c?.name));
    const hasStepType = cols.has('step_type');
    const agg = db.prepare(
      'SELECT count(*) AS total, sum(CASE WHEN status IN (1, 2, 8) THEN 1 ELSE 0 END) AS active, max(idx) AS maxIdx FROM steps'
    ).get();
    const totalSteps = Number(agg?.total) || 0;
    const activeSteps = Number(agg?.active) || 0;
    const lastIdx = agg?.maxIdx != null ? Number(agg.maxIdx) : -1;
    let lastStatus = 0;
    if (lastIdx >= 0) {
      const lastRow = db.prepare('SELECT status FROM steps WHERE idx = ?').get(lastIdx);
      lastStatus = Number(lastRow?.status) || 0;
    }
    let maxPlannerIdx = -1;
    if (hasStepType) {
      const pRow = db.prepare('SELECT max(idx) AS maxIdx FROM steps WHERE step_type = ?').get(STEP_TYPE_PLANNER);
      if (pRow?.maxIdx != null) maxPlannerIdx = Number(pRow.maxIdx);
    }
    const activeStepIdxs = new Set();
    const activeTurnStepIdxs = new Set();
    if (activeSteps > 0) {
      const sql = hasStepType
        ? 'SELECT idx, step_type FROM steps WHERE status IN (1, 2, 8)'
        : 'SELECT idx FROM steps WHERE status IN (1, 2, 8)';
      for (const row of db.prepare(sql).all()) {
        if (row?.idx == null) continue;
        const idx = Number(row.idx);
        activeStepIdxs.add(idx);
        // 转入后台运行的工具命令（run_command / schedule）在模型已继续生成后续 PLANNER_RESPONSE 收尾后
        // 仍会在 steps 表里保留 status=2(RUNNING)，其 step_type≠15 且 idx < maxPlannerIdx。
        // 必须把它与前台轮（模型生成中或最新 PLANNER_RESPONSE 之后的同步工具）区分开，
        // 否则后台监视器会把它误判成「模型正在后台自动唤醒」并永久卡在空直播态。
        const isTurnStep = !hasStepType
          || Number(row.step_type) === STEP_TYPE_PLANNER
          || maxPlannerIdx < 0
          || idx >= maxPlannerIdx;
        if (isTurnStep) activeTurnStepIdxs.add(idx);
      }
    }
    const hasActiveSteps = activeSteps > 0 || ACTIVE_STEP_STATUSES.has(lastStatus);
    const hasRunning = activeTurnStepIdxs.size > 0 || ACTIVE_STEP_STATUSES.has(lastStatus);
    return {
      exists: true,
      totalSteps,
      activeSteps,
      activeStepIdxs,
      activeTurnStepIdxs,
      hasActiveSteps,
      hasRunning,
      lastIdx,
      lastStatus,
      maxPlannerIdx,
    };
  } catch {
    return empty;
  } finally {
    try { db?.close(); } catch {}
  }
}

function readMessagesRaw(dataDir, sessionId) {
  const dir = sessionBrainDir(dataDir, sessionId);
  if (!dir) return [];
  const msgDir = path.join(dir, '.system_generated', 'messages');
  let names = [];
  try { names = readdirSync(msgDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'read.json') continue;
    const j = readJsonSafe(path.join(msgDir, name));
    if (!j || !j.id) continue;
    out.push({
      id: String(j.id),
      sender: String(j.sender || ''),
      recipient: String(j.recipient || ''),
      title: String(j.renderDetails?.messageTitle || ''),
      content: typeof j.content === 'string' ? j.content : '',
      at: Date.parse(j.timestamp || '') || 0,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

function readSubagentRefs(dataDir, sessionId) {
  const dir = sessionBrainDir(dataDir, sessionId);
  if (!dir) return [];
  const subDir = path.join(dir, '.system_generated', 'subagents');
  let names = [];
  try { names = readdirSync(subDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    const file = path.join(subDir, name);
    const j = readJsonSafe(file) || {};
    let spawnedAt = 0;
    let mtimeMs = 0;
    try {
      const st = statSync(file);
      mtimeMs = st.mtimeMs || 0;
      spawnedAt = Math.min(st.birthtimeMs || st.mtimeMs, st.mtimeMs);
    } catch {}
    out.push({
      id,
      typeName: String(j.subagentDescriptor?.typeName || ''),
      role: String(j.subagentDescriptor?.role || ''),
      state: String(j.state || 'SUBAGENT_STATE_ALIVE'),
      spawnStepIndex: Number.isFinite(Number(j.spawnStepIndex)) ? Number(j.spawnStepIndex) : null,
      spawnedAt,
      mtimeMs,
    });
  }
  return out.sort((a, b) => a.spawnedAt - b.spawnedAt || a.id.localeCompare(b.id));
}

function readLinesSafe(file, maxBytes = MAX_TRANSCRIPT_BYTES) {
  let st;
  try { st = statSync(file); } catch { return { lines: [], mtimeMs: 0, size: 0 }; }
  if (!st.isFile() || !st.size) return { lines: [], mtimeMs: st.mtimeMs, size: 0 };
  if (st.size > maxBytes) {
    // 极大文件只读尾部摘要，避免阻塞事件循环
    const len = Math.min(st.size, TAIL_BYTES);
    const buf = Buffer.allocUnsafe(len);
    let fd;
    try {
      fd = openSync(file, 'r');
      readSync(fd, buf, 0, len, st.size - len);
      const lines = buf.toString('utf8').split('\n');
      if (len < st.size) lines.shift();
      return { lines: lines.filter((l) => l.trim()), mtimeMs: st.mtimeMs, size: st.size };
    } catch {
      return { lines: [], mtimeMs: st.mtimeMs, size: st.size };
    } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
    }
  }
  try {
    const raw = readFileSync(file, 'utf8');
    return { lines: raw.split('\n').filter((l) => l.trim()), mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return { lines: [], mtimeMs: st.mtimeMs, size: st.size };
  }
}

/** 扫描一个会话/子代理的文字记录摘要（模型、tokens、工具次数、最近步骤、运行态、后台任务）。 */
export function summarizeTranscript(dataDir, sessionId) {
  const file = transcriptFileOf(dataDir, sessionId);
  const res = {
    exists: false,
    mtimeMs: 0,
    stepsCount: 0,
    model: '',
    tokens: { input: 0, cacheRead: 0, output: 0, total: 0 },
    toolCallsCount: 0,
    lastTool: null,
    lastText: '',
    lastError: '',
    lastStepType: '',
    lastStepStatus: '',
    lastStepAt: 0,
    firstStepAt: 0,
    hasRunningStep: false,
    endsOnSystemMessage: false,
    promptPreview: '',
    backgroundTasks: [],
  };
  if (!file) return res;
  const { lines, mtimeMs } = readLinesSafe(file, 8 * 1024 * 1024);
  res.exists = true;
  res.mtimeMs = mtimeMs;
  if (!lines.length) return res;

  let lastToolRef = null;
  const bgMap = new Map();
  let seenPlanner = false;

  for (const line of lines) {
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    res.stepsCount++;
    const at = Date.parse(o.created_at || '') || 0;
    if (at && !res.firstStepAt) res.firstStepAt = at;
    if (at) res.lastStepAt = at;
    res.lastStepType = String(o.type || '');
    res.lastStepStatus = String(o.status || '');
    if (o.status === 'RUNNING') res.hasRunningStep = true;

    if (o.type === 'SYSTEM_MESSAGE' || o.type === 'USER_INPUT') {
      const unwrapped = unwrapSystemMessage(o.content || '');
      if (!seenPlanner && !res.promptPreview && unwrapped.text) {
        res.promptPreview = clip(unwrapped.text, 400);
      }
      // 后台任务结束通知（SYSTEM_MESSAGE）把之前 GENERIC(RUNNING) 记下的后台任务收敛成终态
      const doneHit = TASK_DONE_RE.exec(String(o.content || ''));
      if (doneHit && bgMap.has(doneHit[1])) {
        const prev = bgMap.get(doneHit[1]);
        prev.status = /failed/i.test(doneHit[2]) ? 'error' : 'done';
      }
      continue;
    }

    if (o.type === 'ERROR_MESSAGE') {
      const errMsg = clipLine(o.error || o.content || '', 240);
      if (errMsg) res.lastError = errMsg;
      continue;
    }

    if (o.type === 'PLANNER_RESPONSE') {
      seenPlanner = true;
      if (o.model) res.model = String(o.model);
      const inp = Number(o.input_tokens) || 0;
      const cache = Number(o.cache_read_tokens) || 0;
      const out = Number(o.output_tokens) || 0;
      res.tokens.input += inp;
      res.tokens.cacheRead += cache;
      res.tokens.output += out;
      // 有效总消耗以输入（含缓存）+ 输出计，便于观察真实规模
      res.tokens.total = res.tokens.input + res.tokens.output;

      if (typeof o.content === 'string' && o.content.trim()) {
        res.lastText = clipLine(o.content, 200);
      }
      if (Array.isArray(o.tool_calls)) {
        for (const tc of o.tool_calls) {
          if (!tc || !tc.name) continue;
          res.toolCallsCount++;
          const args = parseArgs(tc.args);
          lastToolRef = {
            name: String(tc.name),
            summary: toolQuickSummary(tc.name, args),
            status: 'running',
            at,
          };
          res.lastTool = lastToolRef;
        }
      }
    } else if (o.type === 'GENERIC') {
      const st = o.status === 'ERROR' ? 'error' : (o.status === 'RUNNING' ? 'running' : 'done');
      if (lastToolRef && lastToolRef.status === 'running') lastToolRef.status = st;
      if (o.status === 'ERROR' && o.error) res.lastError = clipLine(o.error, 200);
      const content = String(o.content || '');
      const bgMatch = BG_TASK_RE.exec(content);
      if (bgMatch) {
        const taskId = bgMatch[1];
        bgMap.set(taskId, {
          id: taskId,
          stepIndex: Number.isFinite(Number(o.step_index)) ? Number(o.step_index) : res.stepsCount - 1,
          status: o.status === 'RUNNING' ? 'running' : (o.status === 'ERROR' ? 'error' : 'done'),
          title: clipLine(content.split('\n')[0] || taskId, 120),
          at,
        });
      }
    } else if (o.status === 'ERROR' && o.error) {
      res.lastError = clipLine(o.error, 200);
    }
  }

  res.endsOnSystemMessage = res.lastStepType === 'SYSTEM_MESSAGE' || res.lastStepType === 'USER_INPUT';
  res.backgroundTasks = [...bgMap.values()];
  return res;
}

/** 读取某个会话文字记录里的最新 step_index（若记录未显式带 step_index，则按行号计数与 readTranscriptStepsAfter 对齐）。 */
export function readLatestTranscriptStepIndex(dataDir, sessionId) {
  const file = transcriptFileOf(dataDir, sessionId);
  if (!file) return { stepIndex: -1, lastStep: null };
  let fd;
  try {
    const size = statSync(file).size;
    if (!size) return { stepIndex: -1, lastStep: null };
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.allocUnsafe(len);
    fd = openSync(file, 'r');
    readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n');
    const partialHead = len < size;
    if (partialHead) lines.shift();
    const nonEmpty = lines.filter((l) => l.trim());
    for (let i = nonEmpty.length - 1; i >= 0; i--) {
      let o;
      try { o = JSON.parse(nonEmpty[i]); } catch { continue; }
      if (Number.isFinite(Number(o?.step_index))) {
        return { stepIndex: Number(o.step_index), lastStep: o };
      }
      // 无 step_index 字段（如精简/测试日志）：若整文件都在缓冲内直接用行号，否则整读计数
      if (!partialHead) {
        return { stepIndex: i, lastStep: o };
      }
      const full = readLinesSafe(file, MAX_TRANSCRIPT_BYTES).lines;
      return { stepIndex: full.length - 1, lastStep: o };
    }
  } catch {} finally {
    if (fd !== undefined) { try { closeSync(fd); } catch {} }
  }
  return { stepIndex: -1, lastStep: null };
}

/** 读取 step_index > afterStep 的所有步骤（用于把 agy 后台自动唤醒的回复同步回历史与前端）。 */
export function readTranscriptStepsAfter(dataDir, sessionId, afterStep = -1) {
  const file = transcriptFileOf(dataDir, sessionId);
  if (!file) return [];
  const { lines } = readLinesSafe(file, MAX_TRANSCRIPT_BYTES);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    const idx = Number.isFinite(Number(o.step_index)) ? Number(o.step_index) : i;
    if (idx > afterStep) out.push({ ...o, step_index: idx });
  }
  return out;
}

/**
 * 把 transcript_full.jsonl 的步骤列表转换成标准 ACP session/update 通知与 bridge 流事件，
 * 以便直接并入 historyUpdates 或经被动 gen 实时推送给前端。
 */
export function stepsToAcpUpdates(steps = [], sessionId = '', {
  includeUser = false,
  isActive = false,
  pendingTools = [],
  platform = process.platform,
} = {}) {
  const updates = [];
  const events = [];
  let text = '';
  let thinking = '';
  let maxStepIndex = -1;
  let hasPlanner = false;
  let hasRunningStep = false;

  const pushUpdate = (update) => {
    updates.push({ params: { sessionId, update } });
  };

  for (const step of (Array.isArray(steps) ? steps : [])) {
    if (!step || typeof step !== 'object') continue;
    const idx = Number.isFinite(Number(step.step_index)) ? Number(step.step_index) : (maxStepIndex + 1);
    if (idx > maxStepIndex) maxStepIndex = idx;
    if (step.status === 'RUNNING') hasRunningStep = true;

    if (step.type === 'USER_INPUT') {
      if (!includeUser) continue;
      const body = String(step.content || '');
      if (!body || isWakePrompt(body)) continue;
      pushUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: body } });
      continue;
    }
    if (step.type === 'SYSTEM_MESSAGE') continue;

    if (step.type === 'PLANNER_RESPONSE') {
      hasPlanner = true;
      if (typeof step.thinking === 'string' && step.thinking) {
        thinking += step.thinking;
        pushUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.thinking } });
        events.push({ type: 'thinking', text: step.thinking });
      }
      if (Array.isArray(step.tool_calls)) {
        step.tool_calls.forEach((tc, ti) => {
          if (!tc || !tc.name) return;
          const toolCallId = `disk_${idx}_${ti}`;
          const name = String(tc.name);
          const args = parseArgs(tc.args);
          const kind = inferToolKind(name);
          const title = String(args.toolSummary || name);
          const locPath = args.Path || args.path || args.AbsolutePath || args.TargetFile || '';
          const locations = locPath ? [{ path: normalizeAgyPath(String(locPath), platform) }] : [];
          const command = kind === 'execute' ? String(args.CommandLine ?? args.command ?? '') : '';
          const toolObj = {
            toolCallId,
            name,
            kind,
            status: 'in_progress',
            title,
            args,
            locations,
            ...(command ? { command } : {}),
          };
          pendingTools.push(toolObj);
          pushUpdate({
            sessionUpdate: 'tool_call',
            toolCallId,
            name,
            kind,
            status: 'in_progress',
            title,
            rawInput: args,
            ...(locations.length ? { locations } : {}),
          });
          events.push({ type: 'tool', tool: toolObj });
        });
      }
      if (typeof step.content === 'string' && step.content) {
        const sep = text && !/\n\s*$/.test(text) ? '\n\n' : '';
        const chunk = sep + step.content;
        text += chunk;
        pushUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: chunk } });
        events.push({ type: 'text', text: chunk });
      }
      continue;
    }

    if (step.type === 'GENERIC') {
      const target = pendingTools.shift();
      if (!target) continue;
      const st = step.status === 'ERROR' ? 'failed' : (step.status === 'RUNNING' ? 'in_progress' : 'completed');
      const output = clip(step.error || step.content || '', OUTPUT_CAP);
      target.status = st;
      if (output) target.output = output;
      pushUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: target.toolCallId,
        name: target.name,
        kind: target.kind,
        status: st,
        title: target.title,
        rawInput: target.args,
        ...(output ? { rawOutput: { output } } : {}),
      });
      events.push({ type: 'tool-update', tool: { ...target } });
    }
  }

  // 若某个工具调用后面没写对应的 GENERIC 步骤且整个唤醒已结束（非活跃态），把悬空 in_progress 标成 completed
  if (!hasRunningStep && !isActive) {
    while (pendingTools.length > 0) {
      const leftover = pendingTools.shift();
      leftover.status = 'completed';
      pushUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: leftover.toolCallId,
        name: leftover.name,
        kind: leftover.kind,
        status: 'completed',
        title: leftover.title,
        rawInput: leftover.args,
      });
      events.push({ type: 'tool-update', tool: { ...leftover } });
    }
  }

  return { updates, events, text, thinking, maxStepIndex, hasPlanner, hasRunningStep };
}

/** 整份读磁盘文字记录还原成 ACP 更新序列（兜底：挂载中但 LRU 淘汰了内存历史、又不能 session/close 杀子代理时用）。 */
export function readFullTranscriptAsUpdates(dataDir, sessionId) {
  const steps = readTranscriptStepsAfter(dataDir, sessionId, -1);
  return stepsToAcpUpdates(steps, sessionId, { includeUser: true });
}

function emptyCounts() {
  return { total: 0, running: 0, waiting: 0, done: 0, error: 0, killed: 0, active: 0 };
}

function addToCounts(acc, status) {
  acc.total++;
  if (status === 'running') { acc.running++; acc.active++; }
  else if (status === 'waiting') { acc.waiting++; acc.active++; }
  else if (status === 'error') acc.error++;
  else if (status === 'killed') acc.killed++;
  else acc.done++;
}

function inferNodeStatus({ ref, summary, db, childNodes, lastDispatchedAt, lastReportAt, now }) {
  if (ref.state === 'SUBAGENT_STATE_KILLED') return 'killed';
  const childActive = childNodes.some((c) => c.status === 'running' || c.status === 'waiting');
  // 真实会话有 .db 时，以 SQLite 实时步骤表为准；transcript_full.jsonl 是只追加日志，
  // 历史中曾后台化的 run_command 行会永久留着 status="RUNNING"，不能把已收工的代理锁死在 running。
  const liveBgActive = db.exists
    ? summary.backgroundTasks.some((t) => t.status === 'running' && db.activeStepIdxs?.has(t.stepIndex))
    : summary.backgroundTasks.some((t) => t.status === 'running');
  const stepRunningNow = db.exists
    ? db.hasRunning
    : (summary.lastStepStatus === 'RUNNING');

  if (stepRunningNow || liveBgActive) return 'running';
  if (childActive) return 'waiting';
  if (summary.lastStepType === 'ERROR_MESSAGE' || summary.lastStepStatus === 'ERROR' || (db.exists && db.lastStatus === 7)) {
    return 'error';
  }

  const latestActivity = Math.max(ref.spawnedAt, lastDispatchedAt, summary.lastStepAt, summary.mtimeMs);
  const awaitingReply = lastDispatchedAt > lastReportAt || (lastReportAt === 0 && summary.stepsCount === 0);

  if (awaitingReply) {
    // 刚派出 / 刚收到父代理的 send_message，文字记录还没写完或停在 SYSTEM_MESSAGE
    if (!summary.exists || summary.stepsCount === 0 || summary.endsOnSystemMessage) {
      if (latestActivity > 0 && now - latestActivity > ORPHAN_STALE_MS && !db.hasRunning) {
        return 'done';
      }
      return 'running';
    }
    // DB 存在且明确已经停下（无运行步骤），文字记录以 PLANNER_RESPONSE(DONE) 或 GENERIC(DONE) 收尾 → 本轮干完了
    if (db.exists && db.totalSteps > 0 && !db.hasRunning) {
      return 'done';
    }
    // 无 DB（测试假数据）且最后一步还没回复父代理、时间很新 → 视为运行中
    if (!db.exists && latestActivity > 0 && now - latestActivity < ORPHAN_STALE_MS) {
      return 'running';
    }
  }

  return 'done';
}

function buildNode(dataDir, parentId, ref, parentMessages, depth, maxDepth, visited, now) {
  visited.add(ref.id);
  const summary = summarizeTranscript(dataDir, ref.id);
  const db = readDbActivity(dataDir, ref.id);
  // 若 DB 存在，修正已完成的后台任务状态，避免界面把旧任务一直标成 running
  const backgroundTasks = db.exists
    ? summary.backgroundTasks.map((t) => (t.status === 'running' && !db.activeStepIdxs?.has(t.stepIndex) ? { ...t, status: 'done' } : t))
    : summary.backgroundTasks;
  const ownMessages = readMessagesRaw(dataDir, ref.id);

  // 父→子的指派消息（用于知道最近一次被唤醒的时刻，以及 transcript 尚未落盘时的提示词预览）
  const dispatches = ownMessages.filter((m) => m.sender === parentId || m.sender === 'system' || m.sender === 'user');
  const lastDispatchedAt = Math.max(ref.spawnedAt, ...dispatches.map((m) => m.at));
  const promptPreview = summary.promptPreview || (dispatches[0] ? clip(unwrapSystemMessage(dispatches[0].content).text || dispatches[0].content, 400) : '');

  // 子→父的汇报消息
  const reports = parentMessages.filter((m) => m.sender === ref.id);
  const lastReport = reports.length ? reports[reports.length - 1] : null;
  const lastReportAt = lastReport?.at || 0;

  // 递归读子代理的子代理（Teamwork 常见 2-3 层：总协调器 → 项目编排器 → 多个调研/执行代理）
  const children = [];
  if (depth < maxDepth) {
    const childRefs = readSubagentRefs(dataDir, ref.id);
    for (const cr of childRefs) {
      if (visited.has(cr.id)) continue;
      children.push(buildNode(dataDir, ref.id, cr, ownMessages, depth + 1, maxDepth, visited, now));
    }
  }

  const status = inferNodeStatus({
    ref,
    summary: { ...summary, backgroundTasks },
    db,
    childNodes: children,
    lastDispatchedAt,
    lastReportAt,
    now,
  });

  // subagent json 的 mtime 在 state 变 KILLED 时会更新，不能晚于真实首步时间；取二者较早值作真实起点
  const startedAt = (ref.spawnedAt && summary.firstStepAt)
    ? Math.min(ref.spawnedAt, summary.firstStepAt)
    : (summary.firstStepAt || ref.spawnedAt || 0);
  const selfLastAt = Math.max(startedAt, summary.lastStepAt || 0, lastReportAt || 0) || summary.mtimeMs || ref.mtimeMs || startedAt;
  const updatedAt = Math.max(selfLastAt, ...children.map((c) => c.updatedAt || 0));
  const isActive = status === 'running' || status === 'waiting';
  const durationMs = startedAt > 0
    ? Math.max(0, (isActive ? now : updatedAt) - startedAt)
    : 0;

  const subtreeCounts = emptyCounts();
  let subtreeTokens = summary.tokens.total || 0;
  const collectSubtree = (node) => {
    addToCounts(subtreeCounts, node.status);
    subtreeTokens += node.tokens?.total || 0;
    for (const ch of node.children) collectSubtree(ch);
  };
  addToCounts(subtreeCounts, status);
  for (const ch of children) collectSubtree(ch);

  const kind = inferSubagentKind(ref.typeName, ref.role);
  const parsedModel = parseModelAndEffort(summary.model);
  const lastMessage = (lastReport && lastReportAt >= summary.lastStepAt)
    ? clipLine(lastReport.content, 200)
    : (summary.lastText || (lastReport ? clipLine(lastReport.content, 200) : ''));

  return {
    id: ref.id,
    parentId,
    depth,
    typeName: ref.typeName,
    role: ref.role || ref.typeName || 'Subagent',
    kind,
    state: ref.state,
    status,
    spawnStepIndex: ref.spawnStepIndex,
    spawnedAt: startedAt,
    updatedAt,
    durationMs,
    model: summary.model,
    modelBase: parsedModel.modelBase,
    effort: parsedModel.effort,
    tokens: summary.tokens,
    subtreeTokens,
    toolCallsCount: summary.toolCallsCount,
    stepsCount: summary.stepsCount,
    lastTool: summary.lastTool,
    lastMessage,
    lastError: summary.lastError,
    promptPreview,
    reportsCount: reports.length,
    lastReportAt,
    lastDispatchedAt,
    backgroundTasks,
    children,
    subtreeCounts,
  };
}

/** 递归读取一个会话的完整多代理树与统计汇总。 */
export function readSubagentTree(dataDir, rootSessionId, { maxDepth = 5 } = {}) {
  const id = String(rootSessionId || '').trim();
  const now = Date.now();
  const empty = {
    sessionId: id,
    parentActive: false,
    parentTasks: [],
    agents: [],
    flat: [],
    counts: emptyCounts(),
    modelMix: [],
    hasActive: false,
    hasAliveNonImage: false,
    signature: 'empty',
    updatedAt: 0,
  };
  if (!dataDir || !ID_RE.test(id)) return empty;

  const rootDb = readDbActivity(dataDir, id);
  const rootSummary = summarizeTranscript(dataDir, id);
  const rootMessages = readMessagesRaw(dataDir, id);
  const topRefs = readSubagentRefs(dataDir, id);

  const visited = new Set([id]);
  const agents = topRefs.map((ref) => buildNode(dataDir, id, ref, rootMessages, 1, maxDepth, visited, now));

  const flat = [];
  const counts = emptyCounts();
  const modelMap = new Map();
  let updatedAt = Math.max(rootSummary.lastStepAt, rootSummary.mtimeMs);
  let hasAliveNonImage = false;

  const walk = (node) => {
    addToCounts(counts, node.status);
    if (node.model) modelMap.set(node.model, (modelMap.get(node.model) || 0) + 1);
    if (node.updatedAt > updatedAt) updatedAt = node.updatedAt;
    if (node.state === 'SUBAGENT_STATE_ALIVE' && node.kind !== 'image') hasAliveNonImage = true;
    const { children, ...brief } = node;
    flat.push({ ...brief, childCount: children.length });
    for (const ch of children) walk(ch);
  };
  for (const a of agents) walk(a);

  const parentTasks = rootDb.exists
    ? rootSummary.backgroundTasks.map((t) => (t.status === 'running' && !rootDb.activeStepIdxs?.has(t.stepIndex) ? { ...t, status: 'done' } : t))
    : rootSummary.backgroundTasks;
  const parentTasksActive = parentTasks.some((t) => t.status === 'running');
  const swarm = readSwarmSummary(dataDir, id);
  const swarmActive = Boolean(swarm?.hasActive);
  if (swarm?.hasLiveWorkers && !swarm?.finished) hasAliveNonImage = true;
  if (swarm?.updatedAt && swarm.updatedAt > updatedAt) updatedAt = swarm.updatedAt;
  const hasActive = counts.active > 0 || rootDb.hasRunning || parentTasksActive || swarmActive;
  const modelMix = [...modelMap.entries()]
    .map(([model, count]) => {
      const p = parseModelAndEffort(model);
      return { model, modelBase: p.modelBase, effort: p.effort, count };
    })
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));

  // 轻量指纹：只在代理数 / 状态 / 工具次数 / 最近活动 / Swarm 变化时变动，避免总线空刷
  const sigParts = [
    rootDb.hasRunning ? '1' : '0',
    parentTasks.map((t) => `${t.id}:${t.status}`).join(','),
    ...(swarm?.signature ? [swarm.signature] : []),
    ...flat.map((a) => `${a.id}:${a.status}:${a.stepsCount}:${a.toolCallsCount}:${a.reportsCount}:${a.lastTool?.name || ''}`),
  ];

  return {
    sessionId: id,
    parentActive: rootDb.hasRunning,
    parentTasks,
    agents,
    flat,
    counts,
    modelMix,
    swarm,
    hasActive,
    hasAliveNonImage,
    signature: sigParts.join('|'),
    updatedAt,
  };
}

/**
 * 判断某个会话此刻是否应禁止 session/close（与静默重启）：
 * agy 的 session/close 会触发 ForceStopCascadeTree 杀光所有 ALIVE 子代理（即便它们只是暂停等用户确认）。
 * 只要会话存在尚未杀掉的非生图子代理、运行中的生图子代理、活跃 Swarm 成员、或主会话本身正在后台跑，就必须保护不关。
 */
export function hasProtectedSubagents(dataDir, sessionId) {
  const id = String(sessionId || '').trim();
  if (!dataDir || !ID_RE.test(id)) return false;
  const dir = sessionBrainDir(dataDir, id);
  const subDir = dir ? path.join(dir, '.system_generated', 'subagents') : '';
  const hasSubDir = Boolean(subDir && existsSync(subDir));
  const db = readDbActivity(dataDir, id);
  if (db.hasActiveSteps) return true;
  if (hasActiveSwarm(dataDir, id)) return true;
  if (!hasSubDir) return false;
  const tree = readSubagentTree(dataDir, id);
  return Boolean(tree.hasActive || tree.hasAliveNonImage);
}

/** 验证 targetAgentId 确实属于 rootSessionId 的子代理树或 Swarm 成员，防越权窥探别的会话。 */
export function findSubagentInTree(dataDir, rootSessionId, targetAgentId, { maxDepth = 5 } = {}) {
  const root = String(rootSessionId || '').trim();
  const target = String(targetAgentId || '').trim();
  if (!dataDir || !ID_RE.test(root) || !ID_RE.test(target)) return null;
  const tree = readSubagentTree(dataDir, root, { maxDepth });
  const hit = tree.flat.find((a) => a.id === target);
  if (hit) {
    const findFull = (list) => {
      for (const n of list) {
        if (n.id === target) return n;
        const deep = findFull(n.children);
        if (deep) return deep;
      }
      return null;
    };
    return { node: findFull(tree.agents), tree };
  }
  // 常规 subagents/ 里没有时，检查是否为该会话 Native Swarm 的成员（共享消息板模式）
  const swarmNodes = listSwarmMemberNodes(dataDir, root);
  const swarmHit = swarmNodes.find((n) => n.id === target);
  if (!swarmHit) return null;
  return {
    node: swarmHit,
    tree: { ...tree, flat: [...tree.flat, ...swarmNodes] },
  };
}

function buildRoleIndex(tree) {
  const map = new Map();
  if (!tree) return map;
  map.set(tree.sessionId, 'Main Agent');
  for (const a of tree.flat || []) {
    map.set(a.id, a.role || a.typeName || a.id.slice(0, 8));
  }
  return map;
}

/**
 * 增量读取指定子代理的完整执行转录（提示词、思考、工具调用含入参+返回+报错、代理间消息、正文、子代理跳链）。
 * 采用与 Claude agent-transcript 相同的字节偏移增量协议：from > 0 时只读新追加的整行。
 */
export function readSubagentTranscript(dataDir, rootSessionId, targetAgentId, { from = 0 } = {}) {
  const found = findSubagentInTree(dataDir, rootSessionId, targetAgentId);
  if (!found || !found.node) return null;
  const { node, tree } = found;
  const roleById = buildRoleIndex(tree);
  const childByStep = new Map();
  for (const ch of node.children || []) {
    if (ch.spawnStepIndex != null) childByStep.set(ch.spawnStepIndex, ch);
  }

  const file = transcriptFileOf(dataDir, targetAgentId);
  const ownMsgs = readMessagesRaw(dataDir, targetAgentId);
  const fallbackPrompt = ownMsgs.length ? clip(ownMsgs[0].content, PROMPT_CAP) : (node.promptPreview || '');

  const makeAgentMeta = () => ({
    id: node.id,
    parentId: node.parentId,
    parentRole: roleById.get(node.parentId) || '',
    depth: node.depth,
    typeName: node.typeName,
    role: node.role,
    kind: node.kind,
    state: node.state,
    status: node.status,
    model: node.model,
    modelBase: node.modelBase,
    effort: node.effort,
    tokens: node.tokens,
    subtreeTokens: node.subtreeTokens,
    toolCallsCount: node.toolCallsCount,
    spawnedAt: node.spawnedAt,
    updatedAt: node.updatedAt,
    durationMs: node.durationMs,
    lastTool: node.lastTool,
    lastError: node.lastError,
    subtreeCounts: node.subtreeCounts,
    children: (node.children || []).map((c) => ({
      id: c.id,
      role: c.role,
      typeName: c.typeName,
      kind: c.kind,
      status: c.status,
      model: c.model,
      modelBase: c.modelBase,
      effort: c.effort,
      tokens: c.tokens,
      toolCallsCount: c.toolCallsCount,
      durationMs: c.durationMs,
      lastTool: c.lastTool,
      lastError: c.lastError,
    })),
  });

  if (!file) {
    return {
      sessionId: rootSessionId,
      agentId: targetAgentId,
      agent: makeAgentMeta(),
      prompt: fallbackPrompt,
      model: node.model || '',
      entries: [],
      offset: 0,
      size: 0,
      mtime: 0,
      delta: false,
    };
  }

  let st;
  try { st = statSync(file); } catch { return null; }
  if (!st.isFile()) return null;
  const size = st.size;
  const mtime = st.mtimeMs;
  const start = Number.isFinite(from) && from > 0 && from <= size ? Math.floor(from) : 0;
  const delta = start > 0;
  if (size - start > MAX_TRANSCRIPT_BYTES) throw Object.assign(new Error('too large'), { status: 413 });
  if (delta && start === size) {
    return {
      sessionId: rootSessionId,
      agentId: targetAgentId,
      agent: makeAgentMeta(),
      prompt: '',
      model: node.model || '',
      entries: [],
      offset: size,
      size,
      mtime,
      delta: true,
    };
  }

  const buf = Buffer.alloc(size - start);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, buf.length, start); } finally { closeSync(fd); }
  const nl = buf.lastIndexOf(0x0a);
  const used = nl < 0 ? 0 : nl + 1;

  const entries = [];
  const pendingTools = [];
  let prompt = '';
  let promptTaken = delta;
  let model = node.model || '';
  let childCursor = 0;

  for (const rawLine of buf.subarray(0, used).toString('utf8').split('\n')) {
    if (!rawLine.trim()) continue;
    let o;
    try { o = JSON.parse(rawLine); } catch { continue; }
    if (!o || typeof o !== 'object') continue;
    const stepIndex = Number.isFinite(Number(o.step_index)) ? Number(o.step_index) : -1;
    const at = Date.parse(o.created_at || '') || 0;

    if (o.type === 'SYSTEM_MESSAGE' || o.type === 'USER_INPUT') {
      const unwrapped = unwrapSystemMessage(o.content || '');
      if (!unwrapped.text) continue;
      if (!promptTaken) {
        prompt = clip(unwrapped.text, PROMPT_CAP);
        promptTaken = true;
        continue;
      }
      const rawSender = unwrapped.sender || (o.type === 'USER_INPUT' ? 'user' : 'system');
      const taskSenderMatch = /^([0-9a-f-]{8,64})\/(task-\d+)$/i.exec(rawSender);
      const senderRole = roleById.get(rawSender)
        || (taskSenderMatch ? `${roleById.get(taskSenderMatch[1]) || taskSenderMatch[1].slice(0, 8)} · ${taskSenderMatch[2]}` : rawSender);
      if (entries.length < MAX_ENTRIES) {
        entries.push({
          kind: 'message',
          stepIndex,
          sender: rawSender,
          senderRole,
          text: clip(unwrapped.text, TEXT_CAP),
          at,
        });
      }
      continue;
    }

    if (o.type === 'ERROR_MESSAGE') {
      const errText = clip(o.error || o.content || '', 2000);
      if (errText && entries.length < MAX_ENTRIES) {
        entries.push({ kind: 'error', stepIndex, text: errText, at });
      }
      continue;
    }

    if (o.type === 'PLANNER_RESPONSE') {
      promptTaken = true;
      if (o.model) model = String(o.model);
      if (typeof o.thinking === 'string' && o.thinking.trim() && entries.length < MAX_ENTRIES) {
        entries.push({
          kind: 'thinking',
          stepIndex,
          text: clip(o.thinking.trim(), TEXT_CAP),
          at,
        });
      }
      if (Array.isArray(o.tool_calls) && o.tool_calls.length > 0 && entries.length < MAX_ENTRIES) {
        const tools = [];
        o.tool_calls.forEach((tc, ti) => {
          if (!tc || !tc.name) return;
          const args = parseArgs(tc.args);
          const item = {
            id: `${stepIndex}:${ti}`,
            name: String(tc.name),
            kind: inferToolKind(tc.name),
            args,
            summary: toolQuickSummary(tc.name, args),
            status: 'in_progress',
            output: '',
            error: '',
            childAgentId: '',
          };
          tools.push(item);
          pendingTools.push(item);
        });
        if (tools.length) entries.push({ kind: 'tools', stepIndex, tools, at });
      }
      if (typeof o.content === 'string' && o.content.trim() && entries.length < MAX_ENTRIES) {
        entries.push({
          kind: 'text',
          stepIndex,
          text: clip(o.content.trim(), TEXT_CAP),
          at,
        });
      }
      if (o.status === 'ERROR' && o.error && entries.length < MAX_ENTRIES) {
        entries.push({ kind: 'error', stepIndex, text: clip(o.error, 2000), at });
      }
      continue;
    }

    if (o.type === 'GENERIC') {
      const stStr = o.status === 'ERROR' ? 'failed' : (o.status === 'RUNNING' ? 'in_progress' : 'completed');
      const outText = clip(o.content || '', OUTPUT_CAP);
      const errText = o.error ? clip(o.error, 2000) : '';
      const target = pendingTools.shift();
      let childId = '';
      const targetName = String(target?.name || '').toLowerCase();
      if (targetName === 'invoke_subagent' || targetName === 'send_message') {
        const argRecip = String(target?.args?.Recipient || target?.args?.recipient || '').trim();
        const idHit = SUBAGENT_ID_IN_TEXT_RE.exec(outText);
        if (targetName === 'send_message' && argRecip && roleById.has(argRecip) && argRecip !== targetAgentId && argRecip !== rootSessionId) {
          childId = argRecip;
        } else if (idHit && roleById.has(idHit[1])) {
          childId = idHit[1];
        } else if (childByStep.has(stepIndex)) {
          childId = childByStep.get(stepIndex).id;
        } else if (targetName === 'invoke_subagent' && Array.isArray(node.children) && node.children[childCursor]) {
          childId = node.children[childCursor++].id;
        }
      }

      if (target) {
        target.status = stStr;
        if (outText) target.output = outText;
        if (errText) target.error = errText;
        if (childId) target.childAgentId = childId;
      } else if (delta && (outText || errText) && entries.length < MAX_ENTRIES) {
        entries.push({
          kind: 'tool_result',
          stepIndex,
          status: stStr,
          output: outText,
          error: errText,
          childAgentId: childId,
          at,
        });
      }
    }
  }

  // 非运行中的子代理，未配到 GENERIC 的尾部工具不再显示旋转态
  if (node.status !== 'running') {
    for (const t of pendingTools) {
      if (t.status === 'in_progress') t.status = node.status === 'killed' ? 'cancelled' : 'completed';
    }
  }

  const parsedOutModel = parseModelAndEffort(model || node.model || '');
  return {
    sessionId: rootSessionId,
    agentId: targetAgentId,
    agent: makeAgentMeta(),
    prompt: delta ? '' : (prompt || fallbackPrompt),
    model: parsedOutModel.raw,
    modelBase: parsedOutModel.modelBase,
    effort: parsedOutModel.effort,
    entries,
    offset: start + used,
    size,
    mtime,
    delta,
  };
}
