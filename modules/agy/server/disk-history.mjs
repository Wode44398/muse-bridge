// Antigravity 磁盘会话历史快读（只读解析 <dataDir>/brain/<id>/.system_generated/logs/transcript(_full).jsonl）。
//
// 开启 --process-per-session 后，每次调 agy acp 的 session/load 都要冷拉起一个独立 worker 进程、
// 重新联网 Google 控制面并预热全部 MCP 子进程（实测 4–8 秒），而真正回放历史只占 ~0.15 秒。
// 本模块直接读取 agy 落盘的文字记录并还原成与 ACP session/load 同构的 session/update 序列，
// 让查看历史会话降到毫秒级；缺少磁盘记录或记录被截断时返回 ok:false，由调用方无感回落到 session/load。

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { sessionBrainDir } from './background.mjs';
import { normalizeAgyPath } from './paths.mjs';
import { parseModelAndEffort } from './subagents.mjs';
import { extractUserRequestText } from './user-media.mjs';
import { isWakePrompt } from './wake-prompt.mjs';

const MAX_TRANSCRIPT_BYTES = 32 * 1024 * 1024;
const OUTPUT_CAP = 8_000;
const DISK_CACHE_MAX = 32;

// 极速 LRU 缓存：file -> { stamp, parsed }
const diskHistoryCache = new Map();

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

function clip(str, n = OUTPUT_CAP) {
  const s = String(str ?? '').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// 剥掉 agy 写进 GENERIC.content 开头的重复 Created At / Completed At 包装，并提取命令行退出码
function parseGenericContent(rawContent = '', rawError = '', kind = 'other') {
  let body = String(rawError || rawContent || '');
  // 连续多行 Created At: ... / Completed At: ... 头
  body = body.replace(/^(?:(?:Created|Completed)\s+At:\s*[^\r\n]*\r?\n)+/i, '').trimStart();

  let exitCode = null;
  if (kind === 'execute') {
    const m = /^Command exited with code\s+(-?\d+)\.?(?:\r?\n|$)/i.exec(body);
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n)) exitCode = n;
      body = body.slice(m[0].length).replace(/^\s*\r?\n/, '');
    }
    body = body.replace(/^Command output:\s*\r?\n/i, '');
  }

  return {
    output: clip(body, OUTPUT_CAP),
    exitCode,
  };
}

// 从 edit_file / replace_file_content 等编辑工具的参数中还原 diff 块，与 ACP 回放对齐
function extractEditDiffs(name, args = {}, platform = process.platform) {
  const n = String(name || '').toLowerCase();
  if (!args || typeof args !== 'object') return [];
  const rawPath = args.Path || args.path || args.TargetFile || args.AbsolutePath || '';
  const normPath = rawPath ? normalizeAgyPath(String(rawPath), platform) : '';

  if (n === 'edit_file' && typeof args.Target === 'string' && typeof args.Replacement === 'string') {
    return [{ type: 'diff', path: normPath, oldText: args.Target, newText: args.Replacement }];
  }
  if (n === 'replace_file_content' && typeof args.TargetContent === 'string' && typeof args.ReplacementContent === 'string') {
    return [{ type: 'diff', path: normPath, oldText: args.TargetContent, newText: args.ReplacementContent }];
  }
  if (n === 'multi_replace_file_content' && Array.isArray(args.ReplacementChunks)) {
    const out = [];
    for (const ch of args.ReplacementChunks) {
      if (ch && typeof ch.TargetContent === 'string' && typeof ch.ReplacementContent === 'string') {
        out.push({ type: 'diff', path: normPath, oldText: ch.TargetContent, newText: ch.ReplacementContent });
      }
    }
    return out;
  }
  return [];
}

/** 仅用一次 stat 获取会话磁盘转录文件信息与指纹（~0.2ms）。不存在或为空文件时返回 null。 */
export function getDiskHistoryStamp(dataDir, sessionId) {
  const dir = sessionBrainDir(dataDir, sessionId);
  if (!dir) return null;
  const logsDir = path.join(dir, '.system_generated', 'logs');
  for (const [name, isFull] of [['transcript_full.jsonl', true], ['transcript.jsonl', false]]) {
    const file = path.join(logsDir, name);
    try {
      if (!existsSync(file)) continue;
      const st = statSync(file);
      if (!st.isFile() || st.size <= 0 || st.size > MAX_TRANSCRIPT_BYTES) continue;
      return {
        file,
        isFull,
        mtimeMs: Math.floor(st.mtimeMs),
        size: st.size,
        stamp: `${isFull ? 'f' : 'p'}:${Math.floor(st.mtimeMs)}:${st.size}`,
      };
    } catch {}
  }
  return null;
}

function cachePut(file, entry) {
  diskHistoryCache.delete(file);
  diskHistoryCache.set(file, entry);
  while (diskHistoryCache.size > DISK_CACHE_MAX) {
    const first = diskHistoryCache.keys().next().value;
    diskHistoryCache.delete(first);
  }
}

/**
 * 从磁盘 transcript(_full).jsonl 快读并还原为标准 ACP session/update 列表。
 * 若文件缺失、为空、非 full 版存在截断字段（truncated_fields）或无任何有效消息，返回 { ok: false }。
 */
export function readDiskSessionHistory(dataDir, sessionId, { platform = process.platform } = {}) {
  const info = getDiskHistoryStamp(dataDir, sessionId);
  if (!info) return { ok: false, reason: 'missing' };

  const cached = diskHistoryCache.get(info.file);
  if (cached && cached.stamp === info.stamp) {
    return {
      ...cached.parsed,
      // 返回浅拷贝数组，防止调用方就地 push 污染缓存
      updates: [...cached.parsed.updates],
    };
  }

  let raw;
  try {
    raw = readFileSync(info.file, 'utf8');
  } catch {
    return { ok: false, reason: 'read_error' };
  }

  // 非 full 版若带截断标记，放弃快读、回落 ACP 保证全文完整
  if (!info.isFull && raw.includes('"truncated_fields"')) {
    return { ok: false, reason: 'truncated' };
  }

  const lines = raw.split('\n');
  const updates = [];
  const pendingTools = [];
  let maxStepIndex = -1;
  let lastModelRaw = '';
  let lastUsage = null;
  let hasMessageContent = false;
  let assistantTextOpen = false;

  const pushUpdate = (update) => {
    updates.push({ params: { sessionId, update } });
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let step;
    try { step = JSON.parse(line); } catch { continue; }
    if (!step || typeof step !== 'object') continue;
    if (!info.isFull && Array.isArray(step.truncated_fields) && step.truncated_fields.length > 0) {
      return { ok: false, reason: 'truncated' };
    }

    const idx = Number.isFinite(Number(step.step_index)) ? Number(step.step_index) : i;
    if (idx > maxStepIndex) maxStepIndex = idx;

    if (step.type === 'USER_INPUT') {
      if (step.source && step.source !== 'USER_EXPLICIT') continue;
      const body = extractUserRequestText(step.content).trim();
      if (body && isWakePrompt(body)) continue;
      const media = Array.isArray(step.media) ? step.media : [];
      if (!body && !media.length) continue;

      // 新用户轮次开始前把上一轮悬空的工具收口（避免跨轮错配）
      pendingTools.length = 0;
      assistantTextOpen = false;
      hasMessageContent = true;

      if (body) {
        pushUpdate({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: body } });
      }
      for (const m of media) {
        const uri = normalizeAgyPath(m?.uri || m?.path || '', platform);
        if (!uri) continue;
        pushUpdate({
          sessionUpdate: 'user_message_chunk',
          content: {
            type: 'image',
            path: uri,
            name: path.basename(uri),
            mimeType: String(m.mime_type || m.mimeType || 'image/png'),
          },
        });
      }
      continue;
    }

    if (step.type === 'SYSTEM_MESSAGE' || step.type === 'CHECKPOINT' || step.type === 'USER_SETTINGS_CHANGE') {
      continue;
    }

    if (step.type === 'PLANNER_RESPONSE') {
      if (typeof step.model === 'string' && step.model.trim()) {
        lastModelRaw = step.model.trim();
      }
      const inp = Number(step.input_tokens) || 0;
      const cache = Number(step.cache_read_tokens) || 0;
      if (inp + cache > 0) {
        lastUsage = { used: inp + cache, size: 0 };
      }

      if (typeof step.thinking === 'string' && step.thinking) {
        hasMessageContent = true;
        pushUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: step.thinking } });
      }

      if (Array.isArray(step.tool_calls)) {
        step.tool_calls.forEach((tc, ti) => {
          if (!tc || !tc.name) return;
          hasMessageContent = true;
          const toolCallId = String(tc.id || `disk_${idx}_${ti}`);
          const name = String(tc.name);
          const args = parseArgs(tc.args);
          const kind = inferToolKind(name);
          const title = String(args.toolSummary || name);
          const locPath = args.Path || args.path || args.AbsolutePath || args.TargetFile || '';
          const locations = locPath ? [{ path: normalizeAgyPath(String(locPath), platform) }] : [];
          const diffs = extractEditDiffs(name, args, platform);

          const record = { toolCallId, name, kind, title, args, locations, diffs };
          pendingTools.push(record);

          pushUpdate({
            sessionUpdate: 'tool_call',
            toolCallId,
            name,
            kind,
            status: 'in_progress',
            title,
            rawInput: args,
            ...(locations.length ? { locations } : {}),
            ...(diffs.length ? { content: diffs } : {}),
          });
        });
      }

      if (typeof step.content === 'string' && step.content) {
        hasMessageContent = true;
        const sep = assistantTextOpen ? '\n\n' : '';
        assistantTextOpen = true;
        pushUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: sep + step.content } });
      }
      continue;
    }

    if (step.type === 'GENERIC') {
      const target = pendingTools.shift();
      if (!target) continue;
      const st = step.status === 'ERROR'
        ? 'failed'
        : (step.status === 'RUNNING' ? 'in_progress' : 'completed');
      const { output, exitCode } = parseGenericContent(step.content, step.error, target.kind);
      const rawOutput = {};
      if (output) rawOutput.output = output;
      if (exitCode !== null) rawOutput.exit_code = exitCode;

      pushUpdate({
        sessionUpdate: 'tool_call_update',
        toolCallId: target.toolCallId,
        name: target.name,
        kind: target.kind,
        status: st,
        title: target.title,
        rawInput: target.args,
        ...(target.locations.length ? { locations: target.locations } : {}),
        ...(target.diffs.length ? { content: target.diffs } : {}),
        ...(Object.keys(rawOutput).length ? { rawOutput } : {}),
      });
    }
  }

  if (!hasMessageContent || updates.length === 0) {
    return { ok: false, reason: 'empty' };
  }

  const parsedModel = parseModelAndEffort(lastModelRaw);
  const parsed = {
    ok: true,
    updates,
    model: parsedModel.modelBase || '',
    thoughtLevel: parsedModel.effort || '',
    rawUsage: lastUsage,
    maxStepIndex,
    mtimeMs: info.mtimeMs,
    size: info.size,
    stamp: info.stamp,
  };
  cachePut(info.file, { stamp: info.stamp, parsed });

  return {
    ...parsed,
    updates: [...updates],
  };
}

/**
 * 为会话详情响应计算稳定指纹（供前端 IndexedDB 缓存走 ?fp= 短路，内容未变时只回几十字节）。
 */
export function computeAgyDetailFingerprint({
  source = '',
  sourceStamp = '',
  meta = null,
  cwd = '',
  title = '',
  desiredConfig = null,
} = {}) {
  const m = meta && typeof meta === 'object' ? meta : {};
  const payload = JSON.stringify({
    s: source,
    k: sourceStamp,
    cwd: String(cwd || ''),
    title: String(title || ''),
    ct: String(m.customTitle || ''),
    pid: m.projectId || '',
    lts: m.lastTurnStatus || '',
    stat: m.lastTurnStats || null,
    cfg: desiredConfig || m.config || null,
    it: Array.isArray(m.interruptedTurns) ? m.interruptedTurns.length : 0,
    ta: m.toolApprovals ? Object.keys(m.toolApprovals).length : 0,
    um: Array.isArray(m.userMedia) ? m.userMedia.length : 0,
  });
  return 'agy1:' + createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

export function _clearDiskHistoryCacheForTest() {
  diskHistoryCache.clear();
}
