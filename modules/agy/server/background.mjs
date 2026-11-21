// agy 的后台子代理（自带生图就是 image-generator 子代理）在 ACP 下的续接。
//
// agy 的设计是「派出子代理 → 主代理结束这一轮 → 子代理回报时系统自动把主代理叫醒」。但经 ACP 接入时没有这次叫醒：
// 子代理照常在后台跑完，回报写进主会话的收件箱，要等下一条 session/prompt 才送达——在 bridge 里看起来就是
// 「说了句请稍候，然后再也没有下文」。所以这一轮收尾时由 bridge 盯着收件箱，回报一到就替系统发一条续接消息。
//
// 依据是 agy 自己落盘的文件（<数据目录>/brain/<会话 id>/.system_generated/），只读不写：
//   subagents/<子会话 id>.json    这个会话派出过的子代理（state 字段跑完也不变，不能拿来判断完成）
//   messages/<消息 id>.json       收到的消息，sender = 子会话 id（用户发的是 "user"），正文里有成品路径
//   logs/transcript_full.jsonl    会话的文字记录，一步一行
// 「回报到了、模型还没看到」怎么认：回报一到，agy 就往文字记录末尾追加一条 SYSTEM_MESSAGE 步骤
//（正文里有 [Message] … sender=<子会话 id>），模型下一次被调用才会在它后面接着写。所以文字记录的最后一步
// 是这样一条系统消息 = 有回报在等。（messages/read.json 不能用：回报到达的那一刻它就被标成已读了，
// 不代表模型看过——实测。）

import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { artifactFor } from './deliverables.mjs';
import { AGY_WAKE_PROMPT, isWakePrompt } from './wake-prompt.mjs';

export { AGY_WAKE_PROMPT, isWakePrompt };

const ID_RE = /^[0-9a-f-]{8,64}$/i;
const MEDIA_RE = /\.(?:png|jpe?g|webp|gif|bmp|avif|mp4|webm|mov|mp3|wav|m4a|ogg)$/i;

/** 这个会话自己的产物目录（agy 把自带生图的成品存在这里，不在工作目录）。id 不像会话 id 时返回 ''。 */
export function sessionBrainDir(dataDir, sessionId) {
  const id = String(sessionId || '').trim();
  if (!dataDir || !ID_RE.test(id)) return '';
  return path.join(dataDir, 'brain', id);
}

function readJsonSafe(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

/** 这个会话派出过的子代理：[{ id, typeName, role, spawnedAt }]（spawnedAt = 登记文件的创建时刻） */
export function listSubagents(dataDir, sessionId) {
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
    try { const st = statSync(file); spawnedAt = Math.min(st.birthtimeMs || st.mtimeMs, st.mtimeMs); } catch {}
    out.push({
      id,
      typeName: String(j.subagentDescriptor?.typeName || ''),
      role: String(j.subagentDescriptor?.role || ''),
      spawnedAt,
    });
  }
  return out;
}

/** 收件箱里其它代理发来的消息：[{ id, sender, content, at }]（用户自己发的不算） */
export function listAgentMessages(dataDir, sessionId) {
  const dir = sessionBrainDir(dataDir, sessionId);
  if (!dir) return [];
  const msgDir = path.join(dir, '.system_generated', 'messages');
  let names = [];
  try { names = readdirSync(msgDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json') || name === 'read.json') continue;
    const j = readJsonSafe(path.join(msgDir, name));
    if (!j || !j.id || !j.sender || j.sender === 'user') continue;
    out.push({
      id: String(j.id),
      sender: String(j.sender),
      content: typeof j.content === 'string' ? j.content : '',
      at: Date.parse(j.timestamp || '') || 0,
    });
  }
  return out.sort((a, b) => a.at - b.at);
}

const TAIL_BYTES = 256 * 1024;
const AGENT_MESSAGE_RE = /\[Message\][^\n]*?\bsender=([0-9a-f-]{8,64})/i;

// 文字记录的最后若干行（整行；开头那行可能是半截，丢掉）
function transcriptTail(dir) {
  for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const file = path.join(dir, '.system_generated', 'logs', name);
    let fd;
    try {
      const size = statSync(file).size;
      if (!size) continue;
      const len = Math.min(size, TAIL_BYTES);
      const buf = Buffer.allocUnsafe(len);
      fd = openSync(file, 'r');
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      if (len < size) lines.shift();
      return lines.filter((l) => l.trim());
    } catch { /* 没有这个文件 / 正被写：试下一个，都不行就当没有 */ } finally {
      if (fd !== undefined) { try { closeSync(fd); } catch {} }
    }
  }
  return [];
}

/**
 * 模型还没回应的回报是谁发的：文字记录从末尾往前数，连续的「其它代理发来消息」的系统步骤，返回发送方 id（去重）。
 * 末尾是别的步骤（模型的回答、工具结果、用户输入）= 没有在等的回报。最后一行没写完（解析不了）时这次按没有算，下一轮再看。
 */
export function unansweredSenders(dataDir, sessionId) {
  const dir = sessionBrainDir(dataDir, sessionId);
  if (!dir) return [];
  const lines = transcriptTail(dir);
  const out = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { return i === lines.length - 1 ? [] : out; }
    if (o?.type !== 'SYSTEM_MESSAGE') break;
    const m = AGENT_MESSAGE_RE.exec(String(o.content || ''));
    // 别的系统消息（提醒之类）夹在中间不算回报，也不打断往前数
    if (m && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** 回报正文里提到的、确实落在这个会话产物目录里的媒体文件（子代理的回报第一行就是成品的绝对路径） */
export function reportedMediaFiles(dataDir, sessionId, content) {
  const dir = sessionBrainDir(dataDir, sessionId);
  if (!dir) return [];
  const out = [];
  for (const raw of String(content || '').split(/\r?\n/)) {
    const line = raw.trim().replace(/^[`"'<\[(]+|[`"'>\])]+$/g, '').replace(/^file:\/\/\/?/i, '');
    if (!line || !MEDIA_RE.test(line) || !path.isAbsolute(line)) continue;
    const full = path.resolve(line);
    const rel = path.relative(dir, full);
    // 只认产物目录里的普通文件；.system_generated 是 agy 的内部记录，不当成品
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep)[0] === '.system_generated') continue;
    if (!existsSync(full)) continue;
    if (!out.includes(full)) out.push(full);
    if (out.length >= 8) break;
  }
  return out;
}

/**
 * 这一轮收尾时要不要等后台：
 *   pending  这一轮（sinceMs 之后）派出、至今没回过话的子代理
 *   unread   其它代理发来、模型还没回应的消息（有就该立刻续接）：每个发送方取它最近的那条
 */
export function backgroundState(dataDir, sessionId, { sinceMs = 0, onlyImage = false } = {}) {
  const subs = listSubagents(dataDir, sessionId);
  const msgs = listAgentMessages(dataDir, sessionId);
  const spoke = new Set(msgs.map((m) => m.sender));
  // 文件系统时间戳和进程时钟可能差几十毫秒，留 2 秒余量；宁可多等一个上一轮的子代理，也别漏掉这一轮的
  let pending = subs.filter((s) => s.spawnedAt >= sinceMs - 2000 && !spoke.has(s.id));
  // 多代理团队与长任务交给会话级后台监视器（subagent-monitor.mjs）持续跟踪，不在单轮 onIdle 里长期卡住用户输入；
  // 只有生图子代理（image-generator）仍在同轮原地等待，以便媒体进度卡无缝切换为成品图。
  if (onlyImage) pending = pending.filter((s) => kindOfSub(s.typeName) === 'image');
  const unread = [];
  for (const sender of unansweredSenders(dataDir, sessionId)) {
    const last = msgs.filter((m) => m.sender === sender).pop();
    // 文字记录里有、收件箱里一时还没读到正文的：照样算有回报（成品路径这次拿不到而已）
    unread.push(last || { id: '', sender, content: '', at: 0 });
  }
  return { pending, unread, subs };
}

const kindOfSub = (typeName) => (/image/i.test(typeName) ? 'image' : 'agent');

/**
 * 一轮正常结束后调用：有后台子代理还没回报就等，回报到了返回 { messages }（调用方据此发续接消息）；
 * 没有要等的、被取消、或等过了头返回 null。
 *   onWaiting({ agents })      开始等（给界面出进度卡）
 *   onReport({ from, files })  回报到了（成品路径先给界面，不用等模型再转述一遍）
 */
export async function awaitBackgroundReport({
  dataDir, sessionId, sinceMs = 0, signal = null,
  pollMs = 1000, timeoutMs = 15 * 60_000, onlyImage = false,
  onWaiting = null, onReport = null,
} = {}) {
  if (!sessionBrainDir(dataDir, sessionId)) return null;
  let st = backgroundState(dataDir, sessionId, { sinceMs, onlyImage });
  if (!st.unread.length && !st.pending.length) return null;

  const typeOf = (id) => st.subs.find((s) => s.id === id)?.typeName || '';
  const viewOf = (s) => ({ id: s.id, typeName: s.typeName, role: s.role, kind: kindOfSub(s.typeName), startedAt: s.spawnedAt });
  if (!st.unread.length) {
    try { onWaiting?.({ agents: st.pending.map(viewOf) }); } catch {}
    const deadline = Date.now() + timeoutMs;
    while (!st.unread.length) {
      if (signal?.aborted || Date.now() > deadline) return null;
      await new Promise((resolve) => {
        const timer = setTimeout(done, pollMs);
        function done() { clearTimeout(timer); signal?.removeEventListener?.('abort', done); resolve(); }
        signal?.addEventListener?.('abort', done, { once: true });
      });
      st = backgroundState(dataDir, sessionId, { sinceMs, onlyImage });
      // 子代理没了也没留话（被杀掉、登记被清）：没有可等的了
      if (!st.unread.length && !st.pending.length) return null;
    }
  }
  if (signal?.aborted) return null;
  for (const m of st.unread) {
    const typeName = typeOf(m.sender);
    try {
      onReport?.({
        from: { id: m.sender, typeName, kind: kindOfSub(typeName) },
        files: reportedMediaFiles(dataDir, sessionId, m.content),
      });
    } catch {}
  }
  return { messages: st.unread };
}

/**
 * 一轮对话用的等待器：把上面的等待接到这一轮的事件流上（进度卡、成品、续接），交给 ACP 客户端的 onIdle。
 *   gen       这一轮（startedAt 之后派出的子代理才算这一轮的；gen.background 给「谁在跑」用）
 *   send      往这一轮的事件流推事件
 *   onChange  在等 / 不等了时通知（跨设备状态）
 */
export function makeBackgroundWaiter({
  dataDir, gen, send, onChange = null, timeoutMs, pollMs, isAutoWaking = null,
} = {}) {
  return {
    onIdle: async ({ sessionId, signal } = {}) => {
      if (!dataDir) return null;
      let waited = false;
      const report = await awaitBackgroundReport({
        dataDir, sessionId, sinceMs: gen?.startedAt || 0, signal,
        onlyImage: true,
        ...(timeoutMs ? { timeoutMs } : {}), ...(pollMs ? { pollMs } : {}),
        onWaiting: ({ agents }) => {
          waited = true;
          if (gen) gen.background = agents;
          send({ type: 'background', state: 'waiting', agents, at: Date.now() });
          try { onChange?.(); } catch {}
        },
        onReport: ({ from, files }) => {
          send({ type: 'background', state: 'reported', from, files: files.map((f) => artifactFor(f, 'background')).filter(Boolean) });
        },
      });
      if (waited) {
        if (gen) gen.background = null;
        try { onChange?.(); } catch {}
      }
      if (!report) {
        if (waited) send({ type: 'background', state: 'idle' });
        return null;
      }
      // agy 自己已经在后台自动唤醒了：不要再补发重复的 AGY_WAKE_PROMPT，把后续步骤交给后台监视器同步
      if (typeof isAutoWaking === 'function') {
        try {
          if (isAutoWaking(sessionId)) {
            if (waited) send({ type: 'background', state: 'idle' });
            return null;
          }
        } catch {}
      }
      send({ type: 'background', state: 'resumed' });
      return [{ type: 'text', text: AGY_WAKE_PROMPT }];
    },
  };
}
