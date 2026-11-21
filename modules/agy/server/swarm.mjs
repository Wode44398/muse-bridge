// Antigravity Native Swarm 状态只读解析器：
//
// agy 的原生 Swarm 落盘在 <dataDir>/brain/<coordinatorConv>/.system_generated/swarm/：
//   members.json   成员名册（title、各成员 conversation_id / model / role / wake_mode / last_read_seq / killed / workspace_mode / workspace / channels）
//   board.jsonl    共享消息板（seq / agent / text / time / channel? / control?）
//   plan.json      协调者按 swarm_pane 写入的目标、任务简称与线程分组（goal / tasks / threads）
//   view.json      叙事者（narrator，可选）写入的概览数据（兼容 <narratorConv>/swarm_view/view.json）
//
// 所有读取均为只读且走 mtime+size 轻量缓存，不修改 agy 的任何文件，不长占 SQLite 锁。

import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { sessionBrainDir } from './background.mjs';
import {
  activeAt,
  ALL,
  channelMentions,
  channelOf,
  channelRegistry,
  channelsAt,
  controlOf,
  currentChannels,
  effectiveChannels,
  MAIN,
  mentionsOf,
  visibleUnread,
} from './swarm-channels.mjs';
import {
  parseModelAndEffort,
  readDbActivity,
  summarizeTranscript,
} from './subagents.mjs';

const ID_RE = /^[0-9a-f-]{8,64}$/i;
const NARRATOR_RE = /^narrator(?:-(\d+))?$/;
const ROLE_WORKER_RE = /^(?:narrator|monitor)(?:-\d+)?$/;
const VIEW_MAX_BYTES = 64 * 1024;
const BOARD_MAX_BYTES = 16 * 1024 * 1024;
const MAX_FRAME_BYTES = 8 * 1024 * 1024;
const MAX_POSTED_FRAMES = 32;
const STUCK_MS = 10 * 60_000;
const STEP_ERROR_SETTLE_MS = 60_000;
const QUOTA_RE = /RESOURCE_EXHAUSTED|quota|\b429\b|exhausted your capacity|rate.?limit/i;

// 兼容 POSIX (/abs/path.png) 与 Windows (C:\path.png / C:/path.png) 绝对路径
const SHOT_RE = /^\s*(?:[-*]\s*)?screenshot:\s*`?((?:\/|[a-zA-Z]:[\\/])[^\r\n`|]+\.(?:png|jpe?g|webp))`?\s*(?:\|\s*(.+?))?\s*$/gim;
const FRAME_EXT_RE = /\.(?:png|jpe?g|webp)$/i;

const BOARD_ACTIVITY = {
  swarm_wait: 'Waiting for posts',
  read_board: 'Reading the board',
  post_message: 'Posting to the board',
};

const fileCache = new Map();
const trBriefCache = new Map();

function statOf(file) {
  try {
    const st = statSync(file);
    return st.isFile() ? { mtime: st.mtimeMs, size: st.size } : { mtime: 0, size: -1 };
  } catch {
    return { mtime: 0, size: -1 };
  }
}

function readCachedText(file, maxBytes = Infinity) {
  const st = statOf(file);
  if (st.size < 0) return { text: null, ...st };
  if (st.size > maxBytes) return { text: null, tooLarge: true, ...st };
  const key = `${st.mtime}:${st.size}`;
  const hit = fileCache.get(file);
  if (hit && hit.key === key) return { text: hit.text, ...st };
  try {
    const text = readFileSync(file, 'utf8');
    if (fileCache.size > 400) fileCache.clear();
    fileCache.set(file, { key, text });
    return { text, ...st };
  } catch {
    return { text: null, ...st };
  }
}

function roleOf(name, m) {
  const r = typeof m?.role === 'string' ? m.role : '';
  if (r && r !== 'worker') return r;
  const hit = /^(narrator|monitor)(?:-\d+)?$/.exec(String(name ?? ''));
  return hit ? hit[1] : (r || 'worker');
}

function isRoleWorker(name, m) {
  const r = roleOf(name, m);
  return Boolean((r && r !== 'worker' && r !== 'coordinator') || ROLE_WORKER_RE.test(String(name ?? '')));
}

function narratorRank(name, m) {
  if (roleOf(name, m) !== 'narrator') return -1;
  const hit = NARRATOR_RE.exec(name) || /-(\d+)$/.exec(name);
  return hit?.[1] ? Number(hit[1]) : 1;
}

function pickNarrator(roster) {
  let live = null;
  let dead = null;
  for (const [name, m] of Object.entries(roster?.members || {})) {
    if (!m || typeof m !== 'object') continue;
    const rank = narratorRank(name, m);
    if (rank < 0) continue;
    if (m.killed) {
      if (!dead || rank > dead.rank) dead = { name, rank };
    } else if (!live || rank > live.rank) {
      live = { name, rank };
    }
  }
  return (live || dead)?.name || null;
}

function swarmDirOf(dataDir, sessionId) {
  const dir = sessionBrainDir(dataDir, sessionId);
  return dir ? path.join(dir, '.system_generated', 'swarm') : '';
}

function parseRoster(text) {
  try {
    const r = JSON.parse(text);
    if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
    return {
      title: typeof r.title === 'string' ? r.title.trim() : '',
      members: r.members && typeof r.members === 'object' && !Array.isArray(r.members) ? r.members : {},
    };
  } catch {
    return null;
  }
}

function parseBoard(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const o = JSON.parse(line);
      if (o && typeof o === 'object' && !Array.isArray(o)) out.push(o);
    } catch {
      // 末尾半截行留待下一次轮询补全
    }
  }
  return out;
}

function parseJsonObjectSafe(text) {
  if (!text) return null;
  try {
    const o = JSON.parse(text);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : null;
  } catch {
    return null;
  }
}

function unquote(v) {
  if (typeof v !== 'string') return v == null ? '' : String(v);
  const s = v.trim();
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    try { return String(JSON.parse(s)); } catch { return s.slice(1, -1); }
  }
  return s;
}

function oneLine(s, maxLen = 110) {
  const out = String(s || '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return out.length > maxLen ? `${out.slice(0, maxLen - 1).trimEnd()}…` : out;
}

function describeToolCall(tc) {
  const name = tc?.name || '';
  if (!name) return '';
  if (BOARD_ACTIVITY[name]) return BOARD_ACTIVITY[name];
  const args = tc.args && typeof tc.args === 'object' ? tc.args : {};
  const summary = unquote(args.toolSummary) || unquote(args.toolAction);
  if (summary) return oneLine(summary);
  const filePath = unquote(args.Path || args.AbsolutePath || args.TargetFile || args.path);
  if (filePath) {
    const verb = { read_file: 'Read', view_file: 'Read', write_file: 'Write', edit_file: 'Edit', replace_file_content: 'Edit' }[name];
    if (verb) return `${verb} ${path.basename(filePath)}`;
  }
  if ((name === 'code_search' || name === 'grep_search') && (args.Query || args.query)) {
    return oneLine(`Search ${unquote(args.Query || args.query)}`);
  }
  if (name === 'run_command' && (args.CommandLine || args.command)) {
    return oneLine(unquote(args.CommandLine || args.command), 80);
  }
  if (name === 'swarm' && args.action) {
    return oneLine(`swarm ${unquote(args.action)} ${unquote(args.name || args.title)}`.trim());
  }
  return name;
}

function thinkingHeading(thinking) {
  if (typeof thinking !== 'string') return '';
  const hs = [...thinking.matchAll(/(?:^|\n)\s*\*\*([^*\n]{3,96})\*\*\s*(?=\n|$)/g)];
  return hs.length ? oneLine(hs[hs.length - 1][1]) : '';
}

function turnEnded(lines) {
  const results = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    let step;
    try { step = JSON.parse(lines[i]); } catch { return false; }
    if (!step || typeof step !== 'object') return false;
    if (step.type === 'GENERIC') {
      results.unshift(step);
      continue;
    }
    if (step.type !== 'PLANNER_RESPONSE') return false;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (calls.length === 0) return results.length === 0;
    const waitIdx = calls.findIndex((c) => c?.name === 'swarm_wait');
    return waitIdx >= 0 && results.length >= calls.length && results[waitIdx]?.status === 'DONE';
  }
  return false;
}

function finalReply(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let step;
    try { step = JSON.parse(lines[i]); } catch { return null; }
    if (!step || typeof step !== 'object') return null;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    return step.type === 'PLANNER_RESPONSE' && calls.length === 0 ? String(step.content || '') : null;
  }
  return null;
}

function replyQuestion(text) {
  const plain = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`\n]*)`/g, (_, s) => s.replace(/[?？]/g, ''))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/"[^"\n]*"|“[^”\n]*”/g, ' ')
    .replace(/\*\*|__/g, '');
  const qs = plain
    .split(/\n+|(?<=[.!?。！？])\s+/)
    .map((x) => x.replace(/^[\s>*-]+/, '').trim())
    .filter((x) => /[?？]$/.test(x) && x.length > 3);
  return qs.length ? oneLine(qs[qs.length - 1], 200) : '';
}

function transcriptFileOf(dataDir, convId) {
  const dir = sessionBrainDir(dataDir, convId);
  if (!dir) return '';
  for (const name of ['transcript_full.jsonl', 'transcript.jsonl']) {
    const file = path.join(dir, '.system_generated', 'logs', name);
    if (existsSync(file)) return file;
  }
  return '';
}

function readSwarmTranscriptState(dataDir, convId) {
  if (!dataDir || !convId || !ID_RE.test(convId)) return { key: '-', state: null };
  const file = transcriptFileOf(dataDir, convId);
  if (!file) return { key: '-', state: null };
  const st = statOf(file);
  if (st.size < 0) return { key: '-', state: null };
  const key = `${st.mtime}:${st.size}`;
  const hit = trBriefCache.get(file);
  if (hit && hit.key === key) return hit;

  let text = '';
  try { text = readFileSync(file, 'utf8'); } catch { return { key: '-', state: null }; }
  const lines = text.split('\n').filter((l) => l.trim());
  let steps = lines.length;
  let activity = '';
  let activityKind = '';
  let last = null;

  for (let i = lines.length - 1; i >= 0; i--) {
    let step;
    try { step = JSON.parse(lines[i]); } catch { continue; }
    if (!step || typeof step !== 'object') continue;
    if (i === lines.length - 1 && Number.isFinite(step.step_index)) {
      steps = Math.max(steps, step.step_index + 1);
    }
    if (!last) {
      last = {
        type: String(step.type || ''),
        status: String(step.status || ''),
        error: typeof step.error === 'string' ? oneLine(step.error, 240) : '',
      };
    }
    if (step.type === 'USER_INPUT') break;
    if (step.type !== 'PLANNER_RESPONSE') continue;
    const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
    if (calls.some((tc) => tc?.name === 'swarm_wait')) break;
    const labeled = calls.filter((tc) => describeToolCall(tc)).pop();
    const label = labeled ? describeToolCall(labeled) : '';
    const heading = thinkingHeading(step.thinking);
    if (label) {
      activity = label;
      activityKind = 'tool';
    } else if (heading) {
      activity = heading;
      activityKind = 'thinking';
    } else {
      continue;
    }
    break;
  }

  const idle = turnEnded(lines);
  const reply = finalReply(lines);
  const replied = reply !== null;
  const replyAsk = replied ? replyQuestion(reply) : '';
  const sum = summarizeTranscript(dataDir, convId);
  const entry = {
    key,
    state: {
      steps,
      activity,
      activityKind,
      last,
      idle,
      replied,
      replyAsk,
      mtime: st.mtime,
      model: sum.model || '',
      tokens: sum.tokens || { input: 0, cacheRead: 0, output: 0, total: 0 },
      toolCallsCount: sum.toolCallsCount || 0,
      firstStepAt: sum.firstStepAt || 0,
      lastStepAt: sum.lastStepAt || 0,
      lastTool: sum.lastTool || null,
      lastError: sum.lastError || '',
      promptPreview: sum.promptPreview || '',
    },
  };
  if (trBriefCache.size > 400) trBriefCache.clear();
  trBriefCache.set(file, entry);
  return entry;
}

function statusOfMember(m, tr, db) {
  if (m.killed) return 'killed';
  // 有 SQLite 时，前台运行步直接说明成员在工作中；若 DB 已静默且 transcript 明确收尾，则进入 waiting
  if (db?.exists) {
    if (db.hasRunning) return 'working';
    if (tr?.idle === true) return 'waiting';
  }
  if (typeof tr?.idle === 'boolean') return tr.idle ? 'waiting' : 'working';
  if (m.wake_mode === 'mentions' || m.wake_mode === 'anything') return 'waiting';
  return 'working';
}

function stepFailure(tr, now) {
  const last = tr?.last;
  if (!last) return null;
  const modelError = last.type === 'ERROR_MESSAGE';
  const settledToolError = last.status === 'ERROR' && now - (tr.mtime || 0) >= STEP_ERROR_SETTLE_MS;
  if (!modelError && !settledToolError) return null;
  const text = last.error || (modelError ? 'model error' : 'step failed');
  return { kind: QUOTA_RE.test(text) ? 'quota' : 'error', text };
}

function boardTimeMs(t) {
  if (!t) return null;
  const ms = Date.parse(String(t).replace(' ', 'T'));
  return Number.isFinite(ms) ? ms : null;
}

function normalizeCandidatePath(rawPath) {
  let p = String(rawPath || '').trim();
  if (!p || p.length > 4096 || /[\0%]/.test(p)) return '';
  // Windows 下 agy 有时会写成 /C:/Users/...，规范成 C:/Users/...
  if (process.platform === 'win32' && /^\/[a-zA-Z]:[\\/]/.test(p)) {
    p = p.slice(1);
  }
  if (!path.isAbsolute(p)) return '';
  return p;
}

function isSafeBrainImageFile(dataDir, memberConvIds, candidatePath) {
  const p = normalizeCandidatePath(candidatePath);
  if (!p || !FRAME_EXT_RE.test(p)) return '';
  let brainReal;
  let fileReal;
  try {
    brainReal = realpathSync(path.join(dataDir, 'brain'));
    fileReal = realpathSync(p);
    const st = statSync(fileReal);
    if (!st.isFile() || st.size > MAX_FRAME_BYTES) return '';
  } catch {
    return '';
  }
  const rel = path.relative(brainReal, fileReal);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return '';
  const segs = rel.split(path.sep);
  // 第一层必须是属于当前 Swarm 某个成员（或协调者）的会话目录，且严禁暴露 .system_generated
  if (segs.length < 2 || segs[1] === '.system_generated') return '';
  if (memberConvIds && memberConvIds.size > 0 && !memberConvIds.has(segs[0])) return '';
  return fileReal;
}

function extractPostedFrames(roster, msgs, dataDir, memberConvIds) {
  const out = new Map();
  for (const m of msgs) {
    const who = roster.members?.[m.agent];
    if (!who || who.role === 'coordinator' || isRoleWorker(m.agent, who)) continue;
    for (const g of String(m.text ?? '').matchAll(SHOT_RE)) {
      const rawPath = String(g[1] || '').trim();
      const real = isSafeBrainImageFile(dataDir, memberConvIds, rawPath);
      if (!real) continue;
      out.delete(real);
      out.set(real, {
        path: real,
        seq: Number(m.seq) || 0,
        agent: String(m.agent || ''),
        caption: oneLine(g[2] || '', 90),
      });
    }
  }
  return [...out.values()].slice(-MAX_POSTED_FRAMES);
}

function readViewJson(dataDir, dir, narrator) {
  let jf = readCachedText(path.join(dir, 'view.json'), VIEW_MAX_BYTES);
  const conv = narrator?.conversation_id;
  if (jf.size < 0 && typeof conv === 'string' && ID_RE.test(conv)) {
    const alt = readCachedText(path.join(dataDir, 'brain', conv, 'swarm_view', 'view.json'), VIEW_MAX_BYTES);
    if (alt.size >= 0) jf = alt;
  }
  return {
    json: jf.size >= 0 && !jf.tooLarge ? parseJsonObjectSafe(jf.text) : null,
    mtime: jf.mtime || 0,
    key: `${jf.mtime}:${jf.size}`,
  };
}

function sanitizePlan(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const goal = raw.goal && typeof raw.goal === 'object' && typeof raw.goal.title === 'string' && raw.goal.title.trim()
    ? {
      title: String(raw.goal.title).trim().slice(0, 120),
      line: typeof raw.goal.line === 'string' ? raw.goal.line.trim().slice(0, 200) : '',
    }
    : null;
  const tasks = {};
  if (raw.tasks && typeof raw.tasks === 'object' && !Array.isArray(raw.tasks)) {
    for (const [k, v] of Object.entries(raw.tasks)) {
      if (typeof v === 'string' && v.trim()) tasks[String(k)] = v.trim().slice(0, 120);
    }
  }
  const threads = Array.isArray(raw.threads)
    ? raw.threads
      .filter((t) => t && typeof t === 'object' && typeof t.title === 'string' && t.title.trim() && Array.isArray(t.tasks))
      .slice(0, 24)
      .map((t, i) => ({
        id: String(t.id || `t-${i}`).slice(0, 48),
        title: String(t.title).trim().slice(0, 80),
        goal: typeof t.goal === 'string' ? t.goal.trim().slice(0, 160) : '',
        tasks: t.tasks.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()),
      }))
    : [];
  if (!goal && !Object.keys(tasks).length && !threads.length) return null;
  return { goal, tasks, threads };
}

function channelAddressees(roster, names, msgs, channels) {
  if (!channels.length || !msgs.some((m) => String(m.text ?? '').includes('@#'))) return null;
  const active = activeAt(channels, msgs);
  const sets = new Map(names.map((n) => {
    const m = roster.members[n];
    const role = typeof m.role === 'string' ? m.role : '';
    const current = currentChannels(n, Array.isArray(m.channels) ? m.channels : null, msgs);
    return [n, channelsAt(n, current, msgs).map((set) => effectiveChannels(role, set, n))];
  }));
  return (i, text) => {
    const chans = channelMentions(text).filter((c) => c !== MAIN && active[i]?.(c));
    if (!chans.length) return null;
    const members = names.filter((n) => {
      const set = sets.get(n)[i];
      return set.includes(ALL) || chans.some((c) => set.includes(c));
    });
    return { channels: chans, members };
  };
}

function formatStallText(raw) {
  let s = String(raw || '')
    .replace(/^\s*(?:[-*]|#+)\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/[*`_]*\[stall\][*`_]*[\s:,–—-]*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  s = s.replace(
    /^((?:@[#A-Za-z0-9_-]+(?![#A-Za-z0-9_-])[\s,:–—-]*)+)(?=\S)(?!@[#A-Za-z0-9_-])/,
    (_, m) => `${m.match(/@[#A-Za-z0-9_-]+/g).join(' ')}: `,
  );
  return s.slice(0, 220);
}

/** 读取指定会话的完整 Native Swarm 快照（只读，不存在时返回 { sessionId, hasSwarm: false }）。 */
export function readSwarmSnapshot(dataDir, sessionId) {
  const sid = String(sessionId || '').trim();
  const empty = { sessionId: sid, hasSwarm: false, etag: '', signature: '' };
  if (!dataDir || !ID_RE.test(sid)) return empty;

  const dir = swarmDirOf(dataDir, sid);
  if (!dir) return empty;
  const membersPath = path.join(dir, 'members.json');
  const membersFile = readCachedText(membersPath);
  if (membersFile.size < 0 || membersFile.text == null) return empty;
  const roster = parseRoster(membersFile.text);
  if (!roster) return empty;

  const boardFile = readCachedText(path.join(dir, 'board.jsonl'), BOARD_MAX_BYTES);
  const msgs = parseBoard(boardFile.text);
  const planFile = readCachedText(path.join(dir, 'plan.json'), VIEW_MAX_BYTES);
  const plan = planFile.size >= 0 && !planFile.tooLarge ? sanitizePlan(parseJsonObjectSafe(planFile.text)) : null;

  const narratorName = pickNarrator(roster);
  const viewData = readViewJson(dataDir, dir, narratorName ? roster.members[narratorName] : null);
  const now = Date.now();
  const head = msgs.length ? Number(msgs[msgs.length - 1].seq) || msgs.length : 0;
  const names = Object.keys(roster.members).filter((n) => roster.members[n] && typeof roster.members[n] === 'object');

  const memberConvIds = new Set([sid]);
  for (const n of names) {
    const cid = String(roster.members[n]?.conversation_id || '').trim();
    if (ID_RE.test(cid)) memberConvIds.add(cid);
  }

  const transcripts = new Map();
  const dbs = new Map();
  const failures = new Map();
  for (const n of names) {
    const cid = String(roster.members[n]?.conversation_id || '').trim();
    const tr = readSwarmTranscriptState(dataDir, cid);
    const db = cid && ID_RE.test(cid) ? readDbActivity(dataDir, cid) : { exists: false, hasRunning: false, hasActiveSteps: false };
    transcripts.set(n, tr);
    dbs.set(n, db);
    failures.set(n, stepFailure(tr.state, now));
  }

  const channels = channelRegistry(msgs);
  const byChannel = channelAddressees(roster, names, msgs, channels);
  const posts = new Map();
  const edges = new Map();

  const messages = msgs.map((m, i) => {
    const seq = Number(m.seq) || (i + 1);
    const agent = String(m.agent ?? '');
    const text = String(m.text ?? '');
    const time = String(m.time || '');
    const ts = boardTimeMs(time);
    const channel = channelOf(m);
    const control = controlOf(m);
    if (control) {
      return {
        seq,
        agent,
        text,
        time,
        ts,
        channel,
        control,
        mentions: [],
        all: false,
        channelMentions: [],
        viaChannel: [],
        screenshots: [],
      };
    }

    const { mentions, all } = mentionsOf(text, names);
    const ch = byChannel ? byChannel(i, text) : null;
    const viaChannel = ch ? ch.members.filter((n) => n !== agent && !mentions.includes(n)) : [];
    const chanMentions = ch?.channels || [];

    // 帖子附带截图（仅校验存在且位于当前 Swarm 成员 brain 目录内的合法图片）
    const screenshots = [];
    const who = roster.members?.[agent];
    if (who && who.role !== 'coordinator' && !isRoleWorker(agent, who)) {
      for (const g of text.matchAll(SHOT_RE)) {
        const real = isSafeBrainImageFile(dataDir, memberConvIds, g[1]);
        if (real) {
          screenshots.push({ path: real, caption: oneLine(g[2] || '', 90) });
        }
      }
    }

    const p = posts.get(agent) || { posts: 0, lastPostSeq: 0, lastPostTime: '', lastPostTs: null };
    posts.set(agent, { posts: p.posts + 1, lastPostSeq: seq, lastPostTime: time, lastPostTs: ts });

    if (!isRoleWorker(agent, roster.members[agent])) {
      const direct = new Set([...mentions, ...viaChannel]);
      const targets = new Set(all ? names : mentions);
      for (const n of direct) targets.add(n);
      targets.delete(agent);
      for (const to of targets) {
        if (isRoleWorker(to, roster.members[to])) continue;
        const key = `${agent}\0${to}`;
        const e = edges.get(key) || { from: agent, to, count: 0, direct: 0, viaAll: 0 };
        e.count++;
        if (direct.has(to)) e.direct++;
        else e.viaAll++;
        edges.set(key, e);
      }
    }

    return {
      seq,
      agent,
      text,
      time,
      ts,
      channel,
      control: null,
      mentions,
      all,
      channelMentions: chanMentions,
      viaChannel,
      screenshots,
    };
  });

  // 合并 view.json 的 reel.frames 与消息板贴出的 Screenshot: 行
  let frames = [];
  const viewFrames = Array.isArray(viewData.json?.reel?.frames) ? viewData.json.reel.frames : [];
  if (viewFrames.length) {
    for (const f of viewFrames.slice(0, MAX_POSTED_FRAMES)) {
      if (!f || typeof f.path !== 'string') continue;
      const real = isSafeBrainImageFile(dataDir, memberConvIds, f.path);
      if (real) {
        frames.push({
          path: real,
          seq: Number(f.seq) || 0,
          agent: '',
          caption: oneLine(f.caption || '', 90),
        });
      }
    }
  }
  if (!frames.length) {
    frames = extractPostedFrames(roster, msgs, dataDir, memberConvIds);
  }

  let totalTokens = 0;
  let earliestAt = 0;
  let latestAt = 0;
  const modelMap = new Map();

  const members = names.map((name) => {
    const m = roster.members[name];
    const convId = String(m.conversation_id || '').trim();
    const tr = transcripts.get(name)?.state || null;
    const db = dbs.get(name);
    const role = roleOf(name, m);
    const roleWorker = isRoleWorker(name, m);
    const lastReadSeq = Number(m.last_read_seq) || 0;
    const status = statusOfMember(m, tr, db);
    const failure = failures.get(name) || null;
    const stuck = !m.killed && !roleWorker && !failure && status === 'working' && Boolean(tr?.mtime && now - tr.mtime > STUCK_MS);

    let unread = Math.max(0, head - lastReadSeq);
    let effChannels = [];
    if (channels.length) {
      const storedRole = typeof m.role === 'string' ? m.role : '';
      const cur = currentChannels(name, Array.isArray(m.channels) ? m.channels : null, msgs);
      unread = visibleUnread(name, storedRole, cur, msgs, lastReadSeq, channels);
      effChannels = effectiveChannels(storedRole, cur, name).filter((c) => typeof c === 'string');
    }

    const rawModel = String(tr?.model || m.model || '').trim();
    const parsedModel = parseModelAndEffort(rawModel);
    const tokens = tr?.tokens || { input: 0, cacheRead: 0, output: 0, total: 0 };
    if (!roleWorker && role !== 'coordinator') {
      totalTokens += tokens.total || 0;
    }
    if (rawModel && !roleWorker && role !== 'coordinator') {
      modelMap.set(rawModel, (modelMap.get(rawModel) || 0) + 1);
    }

    const postStats = posts.get(name) || { posts: 0, lastPostSeq: 0, lastPostTime: '', lastPostTs: null };
    const startedAt = tr?.firstStepAt || postStats.lastPostTs || 0;
    const updatedAt = Math.max(tr?.lastStepAt || 0, tr?.mtime || 0, postStats.lastPostTs || 0);
    if (startedAt && (!earliestAt || startedAt < earliestAt)) earliestAt = startedAt;
    if (updatedAt > latestAt) latestAt = updatedAt;

    return {
      name,
      conversationId: convId,
      role,
      roleWorker,
      narrator: narratorRank(name, m) >= 0,
      status,
      killed: Boolean(m.killed),
      wakeMode: String(m.wake_mode || ''),
      waitSince: Number(m.wait_since) || 0,
      lastReadSeq,
      unread,
      model: parsedModel.raw,
      modelBase: parsedModel.modelBase,
      effort: parsedModel.effort,
      tokens,
      steps: tr?.steps || 0,
      toolCallsCount: tr?.toolCallsCount || 0,
      activity: tr?.activity || '',
      activityKind: tr?.activityKind || '',
      replied: Boolean(tr?.replied),
      replyAsk: tr?.replyAsk || '',
      failure,
      stuck,
      transcriptMtime: tr?.mtime || 0,
      startedAt,
      updatedAt,
      workspaceMode: typeof m.workspace_mode === 'string' ? m.workspace_mode.trim() : '',
      workspace: typeof m.workspace === 'string' ? m.workspace.trim() : '',
      channels: effChannels,
      posts: postStats.posts,
      lastPostSeq: postStats.lastPostSeq,
      lastPostTime: postStats.lastPostTime,
      lastPostTs: postStats.lastPostTs,
    };
  });

  members.sort((a, b) => (a.role === 'coordinator' ? 0 : 1) - (b.role === 'coordinator' ? 0 : 1) || a.name.localeCompare(b.name));

  // 系统级告警（配额耗尽、报错、长时间无进展）
  const systemAttention = [];
  for (const m of members) {
    if (m.killed || m.roleWorker) continue;
    if (m.failure) {
      systemAttention.push({
        id: `sys-${m.name}-${m.failure.kind}`,
        kind: m.failure.kind,
        member: m.name,
        conversationId: m.conversationId,
        detail: m.failure.text,
      });
    } else if (m.stuck) {
      systemAttention.push({
        id: `sys-${m.name}-stuck`,
        kind: 'stuck',
        member: m.name,
        conversationId: m.conversationId,
        detail: '',
        since: m.transcriptMtime,
      });
    }
  }

  const team = members.filter((m) => !m.roleWorker);
  const workers = team.filter((m) => m.role !== 'coordinator');
  const coord = members.find((m) => m.role === 'coordinator') || null;
  const teamMsgs = messages.filter((m) => !m.control && !isRoleWorker(m.agent, roster.members[m.agent]));
  const lastTeamMsg = teamMsgs.length ? teamMsgs[teamMsgs.length - 1] : null;
  const hasWorking = team.some((m) => !m.killed && m.status === 'working');
  const finished = !hasWorking
    && systemAttention.length === 0
    && Boolean(coord && lastTeamMsg && lastTeamMsg.agent === coord.name
      && /^(@[A-Za-z0-9_-]+[\s,:–—-]*)*(?:\*\*|\*|`|_)?\[done\]/i.test(String(lastTeamMsg.text || '').trim()));

  const coordAsk = (!finished && coord && !coord.killed && coord.status === 'waiting' && coord.replied && coord.replyAsk)
    ? coord.replyAsk
    : '';
  const coordSysCount = coord ? systemAttention.filter((a) => a.member === coord.name).length : 0;
  const needsUser = !finished && (Boolean(coordAsk) || coordSysCount > 0);

  // 来自 @monitor 的最新 [stall] 告警（仅在全员静默、未收尾、未被后续帖子覆盖时呈现）
  const monPosts = messages.filter((m) => !m.control && (roster.members?.[m.agent]?.role === 'monitor' || /^monitor(?:-\d+)?$/.test(m.agent)) && /\[stall\]/i.test(m.text));
  const lastMonPost = monPosts.length ? monPosts[monPosts.length - 1] : null;
  const coordHandledStall = Boolean(coord && !coord.killed && coord.status === 'waiting' && coord.replied && lastMonPost && coord.lastReadSeq >= lastMonPost.seq);
  const hasLiveWorkers = workers.some((m) => !m.killed);
  const activeStallPost = (!finished && !hasWorking && !needsUser && !coordHandledStall && hasLiveWorkers
    && lastMonPost && (!lastTeamMsg || lastMonPost.seq >= lastTeamMsg.seq))
    ? lastMonPost
    : null;
  const stall = activeStallPost
    ? { seq: activeStallPost.seq, agent: activeStallPost.agent, text: formatStallText(activeStallPost.text) }
    : null;

  const workingCount = workers.filter((m) => !m.killed && m.status === 'working').length;
  const waitingCount = workers.filter((m) => !m.killed && m.status === 'waiting').length;
  const killedCount = workers.filter((m) => m.killed).length;
  const errorCount = workers.filter((m) => !m.killed && Boolean(m.failure)).length;
  const modelMix = [...modelMap.entries()]
    .map(([model, count]) => {
      const p = parseModelAndEffort(model);
      return { model, modelBase: p.modelBase, effort: p.effort, count };
    })
    .sort((a, b) => b.count - a.count || a.model.localeCompare(b.model));

  const title = roster.title || plan?.goal?.title || String(viewData.json?.goal?.title || '').trim() || '';
  const firstMsgTs = messages.find((m) => m.ts)?.ts || earliestAt || 0;
  const lastMsgTs = [...messages].reverse().find((m) => m.ts)?.ts || latestAt || 0;
  const hasActive = !finished && (workingCount > 0 || Boolean(coord && !coord.killed && coord.status === 'working'));
  const durationMs = firstMsgTs > 0
    ? Math.max(0, (hasActive ? now : Math.max(firstMsgTs, lastMsgTs)) - firstMsgTs)
    : 0;

  const trKeys = names.map((n) => `${n}:${transcripts.get(n).key}:${dbs.get(n)?.hasRunning ? 1 : 0}`).join(',');
  const stuckKey = members.map((m) => `${m.failure?.kind || ''}${m.stuck ? 's' : ''}`).join(',');
  const etag = `${membersFile.mtime}:${membersFile.size}|${boardFile.mtime}:${boardFile.size}|${planFile.mtime}:${planFile.size}|${viewData.key}|${trKeys}|${stuckKey}`;
  const signature = `sw:${head}:${members.map((m) => `${m.name}:${m.status}:${m.steps}:${m.posts}:${m.failure?.kind || ''}`).join(',')}`;

  const summary = {
    hasSwarm: true,
    id: sid,
    title,
    finished,
    hasActive,
    hasLiveWorkers,
    needsUser,
    coordAsk,
    stall,
    workingCount,
    waitingCount,
    killedCount,
    errorCount,
    totalWorkers: workers.length,
    totalMembers: team.length,
    postsCount: teamMsgs.length,
    head,
    channelsCount: channels.length,
    framesCount: frames.length,
    totalTokens,
    startedAt: firstMsgTs,
    updatedAt: Math.max(lastMsgTs, latestAt),
    durationMs,
    goal: plan?.goal || (viewData.json?.goal?.title ? {
      title: String(viewData.json.goal.title).slice(0, 120),
      line: String(viewData.json.goal.line || '').slice(0, 200),
    } : null),
    latestMessage: lastTeamMsg ? {
      seq: lastTeamMsg.seq,
      agent: lastTeamMsg.agent,
      mentions: lastTeamMsg.mentions,
      all: lastTeamMsg.all,
      channel: lastTeamMsg.channel,
      text: oneLine(lastTeamMsg.text, 140),
      ts: lastTeamMsg.ts,
    } : null,
    modelMix,
    signature,
  };

  return {
    sessionId: sid,
    hasSwarm: true,
    id: sid,
    title,
    etag,
    signature,
    head,
    finished,
    hasActive,
    hasLiveWorkers,
    needsUser,
    coordAsk,
    stall,
    members,
    messages,
    channels,
    edges: [...edges.values()],
    plan,
    view: viewData.json || null,
    frames,
    systemAttention,
    summary,
  };
}

/** 轻量摘要：给 readSubagentTree 附带，用于侧栏角标与总线变化检测。 */
export function readSwarmSummary(dataDir, sessionId) {
  const snap = readSwarmSnapshot(dataDir, sessionId);
  return snap.hasSwarm ? snap.summary : null;
}

/** 当前会话是否存在未结束/仍有存活成员的 Swarm（用于防 session/close 与空闲重启误杀）。 */
export function hasActiveSwarm(dataDir, sessionId) {
  const snap = readSwarmSnapshot(dataDir, sessionId);
  if (!snap.hasSwarm) return false;
  return Boolean(snap.hasActive || (snap.hasLiveWorkers && !snap.finished));
}

/**
 * 列出当前 Swarm 中所有具备独立会话 id 的成员（排除协调者自身），
 * 以便 findSubagentInTree / readSubagentTranscript 直接支持点击 Swarm 成员查看其完整对话与工具转录。
 */
export function listSwarmMemberNodes(dataDir, sessionId) {
  const snap = readSwarmSnapshot(dataDir, sessionId);
  if (!snap.hasSwarm) return [];
  const out = [];
  for (const m of snap.members) {
    if (!m.conversationId || m.conversationId === sessionId || !ID_RE.test(m.conversationId)) continue;
    const status = m.killed
      ? 'killed'
      : (m.failure ? 'error' : (m.status === 'working' ? 'running' : (snap.finished ? 'done' : 'waiting')));
    const sum = summarizeTranscript(dataDir, m.conversationId);
    const durationMs = m.startedAt > 0
      ? Math.max(0, (status === 'running' ? Date.now() : (m.updatedAt || m.startedAt)) - m.startedAt)
      : 0;
    out.push({
      id: m.conversationId,
      parentId: sessionId,
      depth: 1,
      typeName: 'swarm',
      role: m.name,
      kind: 'swarm',
      state: m.killed ? 'SUBAGENT_STATE_KILLED' : 'SUBAGENT_STATE_ALIVE',
      status,
      spawnStepIndex: null,
      spawnedAt: m.startedAt || 0,
      updatedAt: m.updatedAt || 0,
      durationMs,
      model: m.model,
      modelBase: m.modelBase,
      effort: m.effort,
      tokens: m.tokens,
      subtreeTokens: m.tokens?.total || 0,
      toolCallsCount: m.toolCallsCount || sum.toolCallsCount || 0,
      stepsCount: m.steps || sum.stepsCount || 0,
      lastTool: sum.lastTool || null,
      lastMessage: m.activity || '',
      lastError: m.failure?.text || sum.lastError || '',
      promptPreview: sum.promptPreview || '',
      reportsCount: m.posts || 0,
      lastReportAt: m.lastPostTs || 0,
      lastDispatchedAt: 0,
      backgroundTasks: sum.backgroundTasks || [],
      children: [],
      subtreeCounts: {
        total: 1,
        running: status === 'running' ? 1 : 0,
        waiting: status === 'waiting' ? 1 : 0,
        done: status === 'done' ? 1 : 0,
        error: status === 'error' ? 1 : 0,
        killed: status === 'killed' ? 1 : 0,
        active: status === 'running' || status === 'waiting' ? 1 : 0,
      },
    });
  }
  return out;
}

/** 校验某真实文件路径是否属于该会话 Swarm 允许公开预览的截图帧（供 /api/agy/artifact 放行）。 */
export function isSwarmFrameFile(dataDir, sessionId, realFilePath) {
  if (!dataDir || !ID_RE.test(String(sessionId || '')) || !realFilePath) return false;
  const snap = readSwarmSnapshot(dataDir, sessionId);
  if (!snap.hasSwarm) return false;
  const target = path.resolve(realFilePath);
  const same = (p) => process.platform === 'win32'
    ? path.resolve(p).toLowerCase() === target.toLowerCase()
    : path.resolve(p) === target;
  if (snap.frames.some((f) => f?.path && same(f.path))) return true;
  for (const m of snap.messages) {
    if (Array.isArray(m.screenshots) && m.screenshots.some((s) => s?.path && same(s.path))) {
      return true;
    }
  }
  return false;
}
