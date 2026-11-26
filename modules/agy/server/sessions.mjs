// Antigravity 会话列表、过滤排序、历史恢复、隐藏与收藏。
// agy acp 没有物理删除会话接口：「隐藏」在本地侧车表标 hidden；「彻底删除」（session-purge.mjs）删掉 agy 的文件后
// 在侧车表留一条 deleted 墓碑——agy 进程没退出前 session/list 可能还列着它，所有列表 / 详情 / 搜索都靠墓碑挡掉。
// session/list 返回全量会话且 cwd 混有 URL 编码与守护进程默认目录，在此统一解码、去伪、按项目过滤并按时间降序排列。

import path from 'node:path';
import { readJson, writeJson } from '@bridge/core/jsonfile.mjs';
import { normalizeAgyPath, foldAgyPath } from './paths.mjs';
import { reconstructHistoryMessages, extractConfigSummary } from './events.mjs';
import { loadAgySettings } from './settings.mjs';
import { findProjectByPath, getProject, authorizeProjectPath } from './projects.mjs';
import { acpPrimary, acpFor } from './acp/index.mjs';
import { buildAgySessionTooling } from './mcp/config.mjs';
import { readToolOutputs, applyToolOutputs } from './tool-outputs.mjs';
import { collectDeliverableAttachments } from './deliverables.mjs';
import { sessionBrainDir } from './background.mjs';
import { hasProtectedSubagents } from './subagents.mjs';
import {
  armSubagentMonitor,
  getPassiveBackgroundGen,
  markSessionTranscriptSynced,
  noteSessionOwner,
  syncDiskTailIntoHistory,
} from './subagent-monitor.mjs';
import { extractRecentSessionDirs } from './recent-dirs.mjs';
import {
  resolveEffectiveContextUsage,
  getAgyContextLimits,
  peekAgyContextLimits,
  warmAgyContextLimits,
} from './context-limits.mjs';
import { applyUserMedia } from './user-media.mjs';
import {
  getDiskHistoryStamp,
  readDiskSessionHistory,
  computeAgyDetailFingerprint,
} from './disk-history.mjs';

export { extractRecentSessionDirs };

const LIST_CACHE_TTL_MS = 5_000;
// 每个 agy 进程各一份列表缓存：主机一个进程、每个成员各一个，会话库互不相通。
// 共用一份的话，两个人前后脚取列表时，后一个会拿到前一个的会话（标题、目录、id）。
let listGen = 0;
const listCaches = new WeakMap();   // AcpClient -> { gen, at, raw, inflight }
function listCacheOf(client) {
  let c = listCaches.get(client);
  if (!c) { c = { gen: -1, at: 0, raw: null, inflight: null }; listCaches.set(client, c); }
  if (c.gen !== listGen) { c.gen = listGen; c.at = 0; c.raw = null; c.inflight = null; }
  return c;
}

function metaFile(agyDir) {
  return path.join(agyDir, 'sessions-meta.json');
}

function readMetaStore(agyDir) {
  if (!agyDir) return { sessions: {} };
  const data = readJson(metaFile(agyDir), { sessions: {} });
  return {
    sessions: data && typeof data.sessions === 'object' && !Array.isArray(data.sessions)
      ? data.sessions
      : {},
  };
}

function writeMetaStore(agyDir, store) {
  if (!agyDir) return;
  writeJson(metaFile(agyDir), store, 2);
}

// 用代数作废在途的 session/list 请求，避免失效前发出的慢请求回包后把陈旧快照写回缓存
export function invalidateSessionsCache() {
  listGen++;
}

// 零 RPC 查当前进程最近一次 session/list 内存缓存里的单条摘要（供详情快读兜底标题与 cwd）
function peekCachedSessionEntry(client, sessionId) {
  const c = client ? listCaches.get(client) : null;
  if (!c || !Array.isArray(c.raw)) return null;
  return c.raw.find((x) => x && x.sessionId === sessionId) || null;
}

// 回复正文里的交付物链接 → 这条消息的成品附件卡
function attachDeliverables(messages, { workDir = '', additionalDirectories = [], uploads, artifactDir = '' } = {}) {
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (m?.role !== 'assistant' || !m.text) continue;
    const atts = collectDeliverableAttachments(m.text, { workDir, additionalDirectories, uploads, artifactDir });
    if (atts.length) m.attachments = atts;
  }
}

export function getSessionMeta(agyDir, sessionId) {
  if (!agyDir || !sessionId) return null;
  const store = readMetaStore(agyDir);
  return store.sessions[String(sessionId)] || null;
}

export function isSessionDeleted(agyDir, sessionId) {
  return !!getSessionMeta(agyDir, sessionId)?.deleted;
}

// 彻底删除后只留墓碑：别的字段（标题、cwd、审批记录……）一并丢掉，不可恢复
export function markSessionDeleted(agyDir, sessionId) {
  if (!agyDir || !sessionId) return false;
  const store = readMetaStore(agyDir);
  store.sessions[String(sessionId)] = { deleted: true, deletedAt: new Date().toISOString() };
  writeMetaStore(agyDir, store);
  invalidateSessionsCache();
  return true;
}

// 收藏不动 updatedAt：收藏一下不该把会话顶到列表最前面
export function setSessionFavorite(agyDir, sessionId, favorite) {
  if (!agyDir || !sessionId) return null;
  const id = String(sessionId);
  const store = readMetaStore(agyDir);
  const prev = store.sessions[id] || {};
  if (prev.deleted) return null;
  const next = { ...prev };
  if (favorite) next.favorite = true;
  else delete next.favorite;
  store.sessions[id] = next;
  writeMetaStore(agyDir, store);
  invalidateSessionsCache();
  return next;
}

function mergeExtraDirs(prevDirs = [], nextDirs) {
  if (!Array.isArray(nextDirs)) return Array.isArray(prevDirs) ? prevDirs : [];
  const seen = new Set();
  const out = [];
  for (const raw of [...(Array.isArray(prevDirs) ? prevDirs : []), ...nextDirs]) {
    const norm = normalizeAgyPath(raw);
    if (!norm) continue;
    const key = foldAgyPath(norm);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(norm);
  }
  return out;
}

// 判断路径是否为桥接层为常驻守护进程创建的占位目录（含跨实例/临时目录残留），避免把 daemon-cwd 误当真实项目
export function isDaemonPseudoCwd(rawPath, daemonCwd = '', platform = process.platform) {
  const norm = rawPath ? normalizeAgyPath(rawPath, platform) : '';
  if (!norm) return false;
  if (daemonCwd && foldAgyPath(norm, platform) === foldAgyPath(daemonCwd, platform)) return true;
  // 测试实例的数据根不一定叫 agy（如 agy-fix1-verify-xxx\daemon-cwd），按目录名 daemon-cwd 一律认作占位目录
  return /(?:^|[\\/])daemon-cwd(?:[\\/]|$)/i.test(norm);
}

export function noteSessionMeta(agyDir, sessionId, patch = {}) {
  if (!agyDir || !sessionId) return null;
  const id = String(sessionId);
  const store = readMetaStore(agyDir);
  const prev = store.sessions[id] || {};
  // 删掉的会话不许被迟到的标题 / 收尾记录写活
  if (prev.deleted) return null;
  const mergedDirs = mergeExtraDirs(prev.additionalDirectories, patch.additionalDirectories);
  const cleanCwd = patch.cwd && !isDaemonPseudoCwd(patch.cwd)
    ? normalizeAgyPath(patch.cwd)
    : '';
  const prevInterrupted = Array.isArray(prev.interruptedTurns) ? prev.interruptedTurns : [];
  const nextInterrupted = patch.appendInterruptedTurn
    ? [...prevInterrupted, {
      prompt: String(patch.appendInterruptedTurn.prompt || '').trim().slice(0, 2000),
      partialText: String(patch.appendInterruptedTurn.partialText || '').trim().slice(0, 4000),
      at: patch.appendInterruptedTurn.at || new Date().toISOString(),
    }].slice(-40)
    : prevInterrupted;
  const prevUserMedia = Array.isArray(prev.userMedia) ? prev.userMedia : [];
  const nextUserMedia = patch.appendUserMedia && Array.isArray(patch.appendUserMedia.images) && patch.appendUserMedia.images.length
    ? [...prevUserMedia, {
      prompt: String(patch.appendUserMedia.prompt || '').trim().slice(0, 400),
      images: patch.appendUserMedia.images.slice(0, 20).map((img) => ({
        path: String(img.path || '').slice(0, 1000),
        name: String(img.name || '').slice(0, 200),
        ...(img.mimeType ? { mimeType: String(img.mimeType).slice(0, 80) } : {}),
        ...(Number.isFinite(Number(img.size)) ? { size: Number(img.size) } : {}),
      })).filter((img) => img.path),
      at: patch.appendUserMedia.at || new Date().toISOString(),
    }].filter((item) => item.images.length > 0).slice(-40)
    : prevUserMedia;
  const next = {
    ...prev,
    ...(cleanCwd ? { cwd: cleanCwd } : {}),
    ...(patch.projectId !== undefined ? { projectId: patch.projectId || null } : {}),
    ...(mergedDirs.length ? { additionalDirectories: mergedDirs } : {}),
    ...(patch.title ? { title: String(patch.title).slice(0, 240) } : {}),
    ...(patch.customTitle !== undefined ? { customTitle: String(patch.customTitle || '').trim().slice(0, 240) } : {}),
    ...(typeof patch.hidden === 'boolean' ? { hidden: patch.hidden } : {}),
    ...(patch.config && typeof patch.config === 'object'
      ? { config: { ...(prev.config || {}), ...patch.config } }
      : {}),
    ...(patch.toolApprovals && typeof patch.toolApprovals === 'object'
      ? { toolApprovals: { ...(prev.toolApprovals || {}), ...patch.toolApprovals } }
      : {}),
    ...(nextInterrupted.length ? { interruptedTurns: nextInterrupted } : {}),
    ...(nextUserMedia.length ? { userMedia: nextUserMedia } : {}),
    ...(patch.lastTurnStatus ? { lastTurnStatus: patch.lastTurnStatus } : {}),
    ...(patch.lastTurnStats && typeof patch.lastTurnStats === 'object' ? { lastTurnStats: patch.lastTurnStats } : {}),
    updatedAt: patch.updatedAt || new Date().toISOString(),
  };
  if (next.cwd && isDaemonPseudoCwd(next.cwd)) delete next.cwd;
  store.sessions[id] = next;
  writeMetaStore(agyDir, store);
  invalidateSessionsCache();
  return next;
}

export function rememberSessionConfig(agyDir, sessionId, configPatch = {}, extra = {}) {
  const clean = {};
  for (const k of ['model', 'thought_level', 'mode']) {
    if (typeof configPatch[k] === 'string' && configPatch[k]) clean[k] = configPatch[k];
  }
  return noteSessionMeta(agyDir, sessionId, { ...extra, config: clean });
}

export function hideSession(agyDir, sessionId) {
  if (!sessionId) return false;
  noteSessionMeta(agyDir, sessionId, { hidden: true });
  return true;
}

// 批量隐藏一批会话：一次落盘、跳过已彻底删除的墓碑，保留原 updatedAt 以便恢复后顺序不乱。
export function hideSessions(agyDir, sessionIds) {
  if (!agyDir || !Array.isArray(sessionIds)) return [];
  const seen = new Set();
  const ids = [];
  for (const raw of sessionIds) {
    const id = String(raw || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  if (!ids.length) return [];
  const store = readMetaStore(agyDir);
  const now = new Date().toISOString();
  const hidden = [];
  for (const id of ids) {
    const prev = store.sessions[id] || {};
    if (prev.deleted) continue;
    store.sessions[id] = { ...prev, hidden: true, updatedAt: prev.updatedAt || now };
    hidden.push(id);
  }
  if (hidden.length > 0) {
    writeMetaStore(agyDir, store);
    invalidateSessionsCache();
  }
  return hidden;
}

export function restoreSession(agyDir, sessionId) {
  if (!sessionId) return false;
  noteSessionMeta(agyDir, sessionId, { hidden: false });
  return true;
}

export function countHiddenSessions(agyDir) {
  if (!agyDir) return 0;
  const store = readMetaStore(agyDir);
  let count = 0;
  for (const meta of Object.values(store.sessions)) {
    if (meta && meta.hidden && !meta.deleted) count++;
  }
  return count;
}

export function restoreAllHiddenSessions(agyDir) {
  if (!agyDir) return 0;
  const store = readMetaStore(agyDir);
  let restored = 0;
  for (const meta of Object.values(store.sessions)) {
    if (meta && meta.hidden && !meta.deleted) {
      meta.hidden = false;
      restored++;
    }
  }
  if (restored > 0) {
    writeMetaStore(agyDir, store);
    invalidateSessionsCache();
  }
  return restored;
}

export function renameSession(agyDir, sessionId, customTitle) {
  if (!sessionId) return null;
  return noteSessionMeta(agyDir, sessionId, { customTitle: String(customTitle ?? '') });
}

function toTimestampMs(val) {
  if (typeof val === 'number' && Number.isFinite(val)) return val;
  const t = Date.parse(String(val || ''));
  return Number.isFinite(t) ? t : 0;
}

// 纯函数：对 session/list 原始结果做路径解码、剔除回填的守护目录伪路径、合并本地元数据并按项目/搜索词过滤排序
export function filterAgySessionList(rawSessions = [], {
  metaMap = {},
  daemonCwd = '',
  cwd = '',
  projectId = '',
  projectsFile = '',
  query = '',
  includeHidden = false,
  platform = process.platform,
} = {}) {
  let targetFoldedCwd = cwd ? foldAgyPath(cwd, platform) : '';
  if (!targetFoldedCwd && projectId && projectsFile) {
    const proj = getProject(projectsFile, projectId);
    if (proj?.path) targetFoldedCwd = foldAgyPath(proj.path, platform);
  }
  const q = String(query || '').trim().toLowerCase();

  const seen = new Set();
  const merged = [];
  let hiddenCount = 0;

  const pushItem = (rawId, rawCwd, rawTitle, rawUpdatedAt) => {
    const id = String(rawId || '').trim();
    if (!id || seen.has(id)) return;
    seen.add(id);

    const meta = metaMap[id] || {};
    if (meta.deleted) return;
    if (meta.hidden) hiddenCount++;
    if (meta.hidden && !includeHidden) return;

    const normFromMeta = meta.cwd && !isDaemonPseudoCwd(meta.cwd, daemonCwd, platform)
      ? normalizeAgyPath(meta.cwd, platform)
      : '';
    const normFromAgy = rawCwd && !isDaemonPseudoCwd(rawCwd, daemonCwd, platform)
      ? normalizeAgyPath(rawCwd, platform)
      : '';
    const resolvedCwd = normFromMeta || normFromAgy;

    const title = String(meta.customTitle || rawTitle || meta.title || '新对话').trim();
    const updatedAt = rawUpdatedAt || meta.updatedAt || '';
    const updatedMs = Math.max(toTimestampMs(rawUpdatedAt), toTimestampMs(meta.updatedAt));

    if (targetFoldedCwd) {
      if (!resolvedCwd || foldAgyPath(resolvedCwd, platform) !== targetFoldedCwd) return;
    }

    if (q) {
      const hay = `${title}\n${resolvedCwd}`.toLowerCase();
      if (!hay.includes(q)) return;
    }

    const matchedProj = (!meta.projectId && resolvedCwd && projectsFile)
      ? findProjectByPath(projectsFile, resolvedCwd)
      : null;

    merged.push({
      sessionId: id,
      cwd: resolvedCwd,
      projectId: meta.projectId || matchedProj?.id || null,
      projectName: matchedProj?.name || (resolvedCwd ? path.basename(resolvedCwd) || resolvedCwd : ''),
      title,
      customTitle: meta.customTitle || '',
      updatedAt: updatedMs ? new Date(updatedMs).toISOString() : String(updatedAt || ''),
      updatedMs,
      hidden: !!meta.hidden,
      ...(meta.favorite ? { favorite: true } : {}),
      config: meta.config || null,
    });
  };

  for (const item of (Array.isArray(rawSessions) ? rawSessions : [])) {
    if (!item || typeof item !== 'object') continue;
    pushItem(item.sessionId, item.cwd, item.title, item.updatedAt);
  }

  // 本地已由 ACP 确认创建或恢复、尚未刷入 agy 摘要库的会话一并补入列表，防止新建对话瞬间在侧栏消失
  for (const [id, meta] of Object.entries(metaMap)) {
    if (!seen.has(id) && meta && !meta.deleted && (meta.cwd || meta.title || meta.customTitle)) {
      pushItem(id, meta.cwd || '', meta.title || '新对话', meta.updatedAt || '');
    }
  }

  merged.sort((a, b) => b.updatedMs - a.updatedMs || a.sessionId.localeCompare(b.sessionId));
  return { sessions: merged, hiddenCount };
}

export async function fetchRawSessionList(client, { refresh = false } = {}) {
  if (refresh) listGen++;
  const cache = listCacheOf(client);

  if (cache.raw && Date.now() - cache.at < LIST_CACHE_TTL_MS) return cache.raw;
  if (cache.inflight) return cache.inflight;

  const reqGen = listGen;
  const inflight = client.listSessions({ cwd: client.daemonCwd })
    .then((sessions) => {
      // 取的途中被作废过（代数变了）就不写回，免得慢请求把陈旧快照塞进缓存
      if (reqGen === listGen && listCaches.get(client) === cache && cache.gen === reqGen) {
        cache.at = Date.now();
        cache.raw = sessions;
      }
      return sessions;
    })
    .finally(() => {
      if (cache.inflight === inflight) cache.inflight = null;
    });

  cache.inflight = inflight;
  return inflight;
}

export async function listAgySessions(ctx, { cwd = '', projectId = '', query = '', includeHidden = false, refresh = false } = {}) {
  const client = acpPrimary(ctx);
  const store = readMetaStore(ctx?.agyDir);
  let rawSessions = [];
  let warning = '';
  try {
    rawSessions = await fetchRawSessionList(client, { refresh });
  } catch (err) {
    warning = err?.message || String(err);
  }

  const filtered = filterAgySessionList(rawSessions, {
    metaMap: store.sessions,
    daemonCwd: client.daemonCwd,
    cwd,
    projectId,
    projectsFile: ctx?.agyProjects || '',
    query,
    includeHidden,
  });

  // 未带项目或搜索词过滤时，从全量可见会话提取最多 8 个真实存在的最近工作目录供工作空间弹窗一键选用
  const recentDirs = (!cwd && !projectId && !query)
    ? extractRecentSessionDirs(filtered.sessions, {
      ctx,
      projectsFile: ctx?.agyProjects || '',
      isPseudoCwd: (p) => isDaemonPseudoCwd(p, client.daemonCwd),
      limit: 8,
    })
    : [];

  return {
    ...filtered,
    recentDirs,
    ...(warning ? { warning } : {}),
  };
}

// 查询会话已确认的真实工作目录（本地元数据优先，其次为 session/list 中非守护目录的真实记录）
export async function resolveVerifiedSessionCwd(ctx, sessionId, client = acpPrimary(ctx)) {
  const meta = getSessionMeta(ctx?.agyDir, sessionId);
  if (meta?.cwd && !isDaemonPseudoCwd(meta.cwd, client.daemonCwd)) {
    return normalizeAgyPath(meta.cwd);
  }
  try {
    const rawList = await fetchRawSessionList(client);
    const found = rawList.find((x) => x && x.sessionId === sessionId);
    if (found?.cwd && !isDaemonPseudoCwd(found.cwd, client.daemonCwd)) {
      const norm = normalizeAgyPath(found.cwd);
      if (norm) return norm;
    }
  } catch {}
  return '';
}

function cancelUnfinishedToolsInMsg(msg, includeTrailingAborted = false) {
  let touched = false;
  const shouldCancel = (tool, isLast) => Boolean(
    tool && (
      tool.status === 'in_progress'
      || tool.status === 'pending'
      || (includeTrailingAborted && isLast && tool.status === 'failed' && !tool.output && tool.exitCode === undefined)
    )
  );
  if (Array.isArray(msg.tools)) {
    for (let i = 0; i < msg.tools.length; i++) {
      if (shouldCancel(msg.tools[i], i === msg.tools.length - 1)) {
        msg.tools[i].status = 'cancelled';
        touched = true;
      }
    }
  }
  if (Array.isArray(msg.blocks)) {
    const toolBlocks = msg.blocks.filter((b) => b?.type === 'tool' && b.tool);
    for (let i = 0; i < toolBlocks.length; i++) {
      if (shouldCancel(toolBlocks[i].tool, i === toolBlocks.length - 1)) {
        toolBlocks[i].tool.status = 'cancelled';
        touched = true;
      }
    }
  }
  return touched;
}

function isUnfinishedTool(tool) {
  return Boolean(tool && (tool.status === 'in_progress' || tool.status === 'pending'));
}

// 仅当未完结工具位于助手消息末尾（后面没有正文输出也没有其它已结束工具）时，才像中途被打断。
// 后台化命令（run_command / schedule 转入后台）在 ACP 回放中会保留 in_progress，但模型随后已接着输出正文或执行了后续步骤，
// 不能据此把正常结束的一轮误判成「已停止」。
function hasTrailingUnfinishedTool(msg) {
  if (!msg || msg.role !== 'assistant') return false;
  if (Array.isArray(msg.blocks) && msg.blocks.length > 0) {
    let lastUnfinishedIdx = -1;
    for (let i = 0; i < msg.blocks.length; i++) {
      const b = msg.blocks[i];
      if (b?.type === 'tool' && isUnfinishedTool(b.tool)) lastUnfinishedIdx = i;
    }
    if (lastUnfinishedIdx < 0) return false;
    for (let i = lastUnfinishedIdx + 1; i < msg.blocks.length; i++) {
      const b = msg.blocks[i];
      if (b?.type === 'text' && String(b.text || '').trim()) return false;
      if (b?.type === 'tool' && b.tool && !isUnfinishedTool(b.tool)) return false;
    }
    return true;
  }
  if (Array.isArray(msg.tools) && msg.tools.length > 0) {
    if (String(msg.text || '').trim()) return false;
    return isUnfinishedTool(msg.tools[msg.tools.length - 1]);
  }
  return false;
}

const ATTACHED_HEAD = '本轮附加文件路径：';

// 剥掉服务端在用户消息前拼的「本轮附加文件路径」清单，避免带图 / 带文件发送时
// 裸 prompt（lastTurnStats / interruptedTurns）与回放里的 user.text 对不上。
function stripAttachedPathsPrefix(raw) {
  const s = String(raw ?? '');
  if (!s.startsWith(ATTACHED_HEAD)) return s;
  const lines = s.slice(ATTACHED_HEAD.length).split('\n');
  if (lines[0].trim() !== '') return s;
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.startsWith('- ') || !line.slice(2).trim()) break;
  }
  if (i === 1) return s;
  return lines.slice(i).join('\n').replace(/^\n+/, '');
}

function userTextMatchesPrompt(rawMsgText, wantPrompt) {
  const full = String(rawMsgText || '').trim();
  if (full === wantPrompt) return true;
  return stripAttachedPathsPrefix(rawMsgText).trim() === wantPrompt;
}

// ACP 的 session/load 只回放消息与工具块，不下发 stopReason=cancelled；结合本地记录补齐中断标记与未完结工具的取消态
export function applyInterruptedMeta(messages = [], meta = {}) {
  const out = Array.isArray(messages) ? messages : [];
  const turns = Array.isArray(meta?.interruptedTurns) ? meta.interruptedTurns : [];
  const matchedAssistants = new Set();

  for (const it of turns) {
    const prompt = String(it?.prompt || '').trim();
    const partial = String(it?.partialText || '').trim();
    let hit = false;

    // 优先精确匹配（用户提问 + 已落盘的部分回复文本一致）
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i]?.role !== 'user' || !userTextMatchesPrompt(out[i].text, prompt)) continue;
      const next = out[i + 1];
      if (next?.role === 'assistant' && !matchedAssistants.has(next)) {
        if (!partial || String(next.text || '').trim() === partial) {
          next.status = 'interrupted';
          cancelUnfinishedToolsInMsg(next, true);
          matchedAssistants.add(next);
          hit = true;
          break;
        }
      } else if (i === out.length - 1) {
        const synth = {
          role: 'assistant',
          status: 'interrupted',
          text: partial,
          thinking: '',
          tools: [],
          blocks: partial ? [{ type: 'text', text: partial }] : [],
        };
        out.push(synth);
        matchedAssistants.add(synth);
        hit = true;
        break;
      }
    }

    // 部分回复在停止瞬间尚未刷盘导致文本略短于侧车记录时，匹配最近一轮同提问消息
    if (!hit && prompt) {
      for (let i = out.length - 1; i >= 0; i--) {
        if (out[i]?.role !== 'user' || !userTextMatchesPrompt(out[i].text, prompt)) continue;
        const next = out[i + 1];
        if (next?.role === 'assistant' && !matchedAssistants.has(next) && partial.startsWith(String(next.text || '').trim())) {
          next.status = 'interrupted';
          cancelUnfinishedToolsInMsg(next, true);
          matchedAssistants.add(next);
          break;
        }
      }
    }
  }

  // 兜底识别在 bridge 外部被打断 / 崩溃的轮次：只处理末尾悬空未完结的工具，跳过已确认 completed 的最新轮
  for (let i = 0; i < out.length; i++) {
    const m = out[i];
    if (m?.role !== 'assistant' || matchedAssistants.has(m)) continue;
    if (i === out.length - 1 && meta?.lastTurnStatus === 'completed') continue;
    if (hasTrailingUnfinishedTool(m) && cancelUnfinishedToolsInMsg(m)) {
      m.status = 'interrupted';
    }
  }

  if (meta?.lastTurnStatus === 'interrupted' && turns.length > 0) {
    const lastMsg = out[out.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.status !== 'interrupted') {
      const lastIt = turns[turns.length - 1];
      const p = String(lastIt?.prompt || '').trim();
      const partial = String(lastIt?.partialText || '').trim();
      if (lastMsg?.role !== 'user' || !userTextMatchesPrompt(lastMsg.text, p)) {
        if (p) out.push({ role: 'user', text: p, images: [], blocks: [{ type: 'text', text: p }] });
      }
      out.push({
        role: 'assistant',
        status: 'interrupted',
        text: partial,
        thinking: '',
        tools: [],
        blocks: partial ? [{ type: 'text', text: partial }] : [],
      });
    }
  }

  return out;
}

// 最后一轮的用时 / token 挂到最后一条助手消息上（消息底部状态栏用）。只在它前面那条用户消息
// 与记录时的提问对得上时才挂——这一轮要是在 agy 自己的界面里跑的，记录就是上一轮的，不能张冠李戴。
export function applyLastTurnStatsMeta(messages = [], meta = {}) {
  const st = meta?.lastTurnStats;
  if (!st || typeof st !== 'object' || !Array.isArray(messages) || messages.length < 2) return messages;
  const last = messages[messages.length - 1];
  const prev = messages[messages.length - 2];
  if (last?.role !== 'assistant' || prev?.role !== 'user') return messages;
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const want = norm(st.prompt);
  const gotFull = norm(prev.text);
  const gotStripped = norm(stripAttachedPathsPrefix(prev.text));
  const matches = (got) => Boolean(want && got && (got.startsWith(want) || want.startsWith(got.slice(0, 200))));
  if (!matches(gotFull) && !matches(gotStripped)) return messages;
  last.stats = {
    ms: Number.isFinite(st.ms) ? st.ms : null,
    tokens: Number.isFinite(st.tokens) ? st.tokens : 0,
  };
  return messages;
}

export function applyToolApprovalsMeta(messages = [], meta = {}) {
  const approvals = meta?.toolApprovals;
  if (!approvals || typeof approvals !== 'object') return messages;
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (m?.role !== 'assistant') continue;
    for (const t of (m.tools || [])) {
      if (t?.toolCallId && approvals[t.toolCallId]) {
        t.approvalState = approvals[t.toolCallId];
      }
    }
    for (const b of (m.blocks || [])) {
      if (b?.type === 'tool' && b.tool?.toolCallId && approvals[b.tool.toolCallId]) {
        b.tool.approvalState = approvals[b.tool.toolCallId];
      }
    }
  }
  return messages;
}

export async function loadAgySessionDetail(ctx, sessionId, { cwd = '', fp = '' } = {}) {
  const id = String(sessionId || '').trim();
  if (!id) throw Object.assign(new Error('缺少会话 id'), { status: 400 });
  const reqFp = String(fp || '').trim();

  // 桌面版建的会话交给桌面版存储进程载入（主进程载它只回放 0 条）；注册用户的会话在他自己的进程里
  const client = acpFor(ctx, id);
  noteSessionOwner(ctx, client, id);
  const meta = getSessionMeta(ctx?.agyDir, id) || {};
  if (meta.deleted) throw Object.assign(new Error('这个对话已经删除'), { status: 404 });
  const settings = loadAgySettings(ctx?.agyDir);

  // 正在跑的会话（含后台自动唤醒的被动 gen）不能 session/load（会打断这一轮或杀子代理）：
  // 返回本进程记下的「这一轮之前」的历史，前端再挂实时流接上当前轮。
  const passiveGen = !client.hasActiveTurn?.(id) ? getPassiveBackgroundGen(ctx?.key, id) : null;
  if (client.hasActiveTurn?.(id) || passiveGen) {
    let before = client.getLiveHistory?.(id) || null;
    if (!before && passiveGen) {
      const fullHist = client.historyUpdates?.get(id) || null;
      if (fullHist) {
        const base = Number.isInteger(passiveGen.historyBase) ? passiveGen.historyBase : fullHist.length;
        before = fullHist.slice(0, base);
      }
    }
    const history = reconstructHistoryMessages(before || []);
    applyInterruptedMeta(history.messages, { ...meta, lastTurnStatus: '' });
    applyUserMedia(history.messages, {
      dataDir: client.dataDir,
      sessionId: id,
      meta,
      allowedRoots: [ctx?.uploads, meta.cwd || '', ...(Array.isArray(meta.additionalDirectories) ? meta.additionalDirectories : [])].filter(Boolean),
      live: true,
    });
    applyToolApprovalsMeta(history.messages, meta);
    applyToolOutputs(history.messages, readToolOutputs(ctx?.agyDir, id));
    // 前几轮交付的成品附件卡照样要有（以前只有下面「不在跑」那条路挂，正在跑的会话重开后前几轮的附件卡全没了）
    attachDeliverables(history.messages, {
      workDir: meta.cwd || '',
      additionalDirectories: Array.isArray(meta.additionalDirectories) ? meta.additionalDirectories : [],
      uploads: ctx?.uploads,
      artifactDir: sessionBrainDir(client.dataDir, id),
    });
    const snap = client.getMountedSnapshot?.(id) || null;
    const liveCfg = extractConfigSummary(snap?.configOptions || [], snap?.modes, snap?.models);
    const liveLimits = peekAgyContextLimits(client) || await getAgyContextLimits(client, { timeoutMs: 250 }).catch(() => null);
    const resolvedUsage = resolveEffectiveContextUsage(snap?.rawUsage || snap?.usage || history.usage, {
      model: liveCfg.model || meta.config?.model || '',
      thoughtLevel: liveCfg.thoughtLevel || meta.config?.thought_level || '',
      liveLimits,
    }) || snap?.usage || history.usage || null;
    return {
      sessionId: id,
      live: true,
      ...(passiveGen ? { backgroundWake: true } : {}),
      historyComplete: !!before,
      cwd: meta.cwd || '',
      projectId: meta.projectId || null,
      title: meta.customTitle || meta.title || history.title || snap?.title || '新对话',
      customTitle: meta.customTitle || '',
      messages: history.messages,
      usage: resolvedUsage,
      commands: snap?.commands?.length ? snap.commands : history.commands,
      configOptions: snap?.configOptions || [],
      modes: snap?.modes || null,
      models: snap?.models || null,
      tier: snap?.tier || null,
      ...liveCfg,
    };
  }

  const cachedListRow = peekCachedSessionEntry(client, id);
  const cachedRowCwd = cachedListRow?.cwd && !isDaemonPseudoCwd(cachedListRow.cwd, client.daemonCwd)
    ? normalizeAgyPath(cachedListRow.cwd)
    : '';
  const metaCleanCwd = meta.cwd && !isDaemonPseudoCwd(meta.cwd, client.daemonCwd)
    ? normalizeAgyPath(meta.cwd)
    : '';

  // 已存 cwd 或列表缓存里的真实 cwd 优先（零 RPC）；两处都没有时再走 resolveVerifiedSessionCwd
  let verifiedCwd = metaCleanCwd || cachedRowCwd;
  if (!verifiedCwd) {
    verifiedCwd = await resolveVerifiedSessionCwd(ctx, id);
  }
  let rpcCwd = verifiedCwd;
  if (!rpcCwd && cwd) {
    try { rpcCwd = authorizeProjectPath(ctx, cwd); } catch {}
  }
  if (!rpcCwd) {
    rpcCwd = settings.defaultCwd || ctx?.cwd || process.cwd();
  }

  const desiredConfig = meta.config || {
    model: settings.defaultModel,
    thought_level: settings.defaultThoughtLevel,
    mode: settings.defaultMode,
  };

  const extraDirs = Array.isArray(meta.additionalDirectories) ? meta.additionalDirectories : [];
  const effectiveWorkDir = verifiedCwd || rpcCwd || '';

  // ── 快速路径 1 & 2：已挂载内存复读（不杀 worker） / 未挂载磁盘快读（不冷起 worker）──
  // 真实 agy 在 --process-per-session 下每次 session/load 都要现起 worker + 联网 Google 控制面 + 预热 MCP（4–8 秒）；
  // 这里优先复读内存或直接只读解析磁盘 transcript(_full).jsonl，将打开历史降到毫秒级，
  // 缺少磁盘记录或记录被截断时无缝回落到下面的 session/load。
  let snapshot = null;
  let updates = null;
  let preservedAlive = false;
  let fastSource = '';
  let fastStamp = '';
  let diskMetaModel = '';
  let diskMetaThought = '';
  let diskRawUsage = null;

  const diskInfo = client.dataDir ? getDiskHistoryStamp(client.dataDir, id) : null;
  const cachedMem = client.getCachedHistory?.(id) || null;
  const cachedTitleHint = meta.customTitle || meta.title || cachedListRow?.title || cachedMem?.snapshot?.title || '新对话';

  if (cachedMem && cachedMem.mounted && cachedMem.updates.length > 0) {
    // 已挂载空闲会话：先把可能由后台唤醒落盘的新步骤同步进内存，绝不 session/close 杀掉活跃 worker
    try { syncDiskTailIntoHistory(ctx?.key, client, id); } catch {}
    const freshMem = client.getCachedHistory?.(id) || cachedMem;
    const diskChangedExternally = Boolean(diskInfo && freshMem.diskStamp && freshMem.diskStamp !== diskInfo.stamp);

    if (diskChangedExternally) {
      const disk = readDiskSessionHistory(client.dataDir, id);
      // 仅当磁盘确实比内存包含更多更新（例如外部官方客户端新写了对话）时才用磁盘刷新，
      // 避免把本进程刚收到但尚未完全刷盘（或测试假 agent 仅写内存）的回复覆盖掉。
      if (disk.ok && disk.updates.length > freshMem.updates.length) {
        updates = disk.updates;
        diskMetaModel = disk.model;
        diskMetaThought = disk.thoughtLevel;
        diskRawUsage = disk.rawUsage;
        fastSource = 'mem+disk';
        fastStamp = disk.stamp;
        client.seedHistory?.(id, disk.updates, { diskStamp: disk.stamp, force: true });
      }
    }

    if (!updates) {
      if (diskInfo) {
        client.noteHistoryDiskStamp?.(id, diskInfo.stamp);
      }
      updates = freshMem.updates;
      fastSource = 'mem';
      fastStamp = `${freshMem.updates.length}:${diskInfo?.stamp || ''}`;
    }

    snapshot = freshMem.snapshot || client.buildSyntheticSnapshot?.(id, desiredConfig) || null;
    if (snapshot) snapshot.lastActiveAt = Date.now();
    preservedAlive = true;

    const memFp = computeAgyDetailFingerprint({
      source: fastSource,
      sourceStamp: fastStamp,
      meta,
      cwd: effectiveWorkDir,
      title: cachedTitleHint,
      desiredConfig,
    });
    if (reqFp && reqFp === memFp) {
      return { sessionId: id, unchanged: true, fp: memFp };
    }
  } else if (diskInfo) {
    // 未挂载会话：先看 ?fp= 指纹短路（full transcript 无需读文件即可直接确认未变）
    const quickFp = diskInfo.isFull
      ? computeAgyDetailFingerprint({
        source: 'disk',
        sourceStamp: diskInfo.stamp,
        meta,
        cwd: effectiveWorkDir,
        title: cachedTitleHint,
        desiredConfig,
      })
      : '';
    if (reqFp && quickFp && reqFp === quickFp) {
      return { sessionId: id, unchanged: true, fp: quickFp };
    }

    const disk = readDiskSessionHistory(client.dataDir, id);
    if (disk.ok) {
      updates = disk.updates;
      diskMetaModel = disk.model;
      diskMetaThought = disk.thoughtLevel;
      diskRawUsage = disk.rawUsage;
      fastSource = 'disk';
      fastStamp = disk.stamp;

      const effectiveDesired = {
        ...desiredConfig,
        ...(meta.config?.model ? {} : (disk.model ? { model: disk.model } : {})),
        ...(meta.config?.thought_level ? {} : (disk.thoughtLevel ? { thought_level: disk.thoughtLevel } : {})),
      };
      snapshot = client.buildSyntheticSnapshot?.(id, effectiveDesired) || null;
      // 预热内存历史与会话记录：用户随后若发消息续聊，runPrompt 直接走 session/resume 而不用重跑 session/load
      client.seedHistory?.(id, disk.updates, { diskStamp: disk.stamp });
      client.rememberSession?.(id, {
        cwd: verifiedCwd || '',
        forceCwd: !!verifiedCwd,
        additionalDirectories: extraDirs,
        desiredConfig: effectiveDesired,
      });
      preservedAlive = true;

      const diskFp = computeAgyDetailFingerprint({
        source: fastSource,
        sourceStamp: fastStamp,
        meta,
        cwd: effectiveWorkDir,
        title: cachedTitleHint,
        desiredConfig,
      });
      if (reqFp && reqFp === diskFp) {
        return { sessionId: id, unchanged: true, fp: diskFp };
      }
    }
  }

  // ── 回落路径：缺少可用磁盘记录（极老 .pb / 空会话 / 测试假 agent）→ 原生 session/load 全量回放 ──
  if (!updates) {
    const { mcpServers, systemPromptAppend: effectiveSystemPrompt, toolingSig } = buildAgySessionTooling({
      ctx, settings, cwd: effectiveWorkDir, additionalDirectories: extraDirs,
    });
    const loaded = await client.loadSessionWithReplay(id, {
      cwd: verifiedCwd,
      fallbackCwd: rpcCwd,
      forceCwd: !!verifiedCwd,
      mcpServers,
      additionalDirectories: extraDirs,
      systemPromptAppend: effectiveSystemPrompt,
      desiredConfig,
      toolingSig,
    });
    snapshot = loaded.snapshot;
    updates = loaded.updates;
    preservedAlive = Boolean(loaded.preservedAlive);
    fastSource = 'acp';
    fastStamp = `${updates.length}:${diskInfo?.stamp || ''}`;
    if (diskInfo) client.noteHistoryDiskStamp?.(id, diskInfo.stamp);
  }

  const history = reconstructHistoryMessages(updates);
  applyInterruptedMeta(history.messages, meta);
  applyUserMedia(history.messages, {
    dataDir: client.dataDir,
    sessionId: id,
    meta,
    allowedRoots: [ctx?.uploads, effectiveWorkDir, ...extraDirs].filter(Boolean),
    live: false,
  });
  applyToolApprovalsMeta(history.messages, meta);
  applyToolOutputs(history.messages, readToolOutputs(ctx?.agyDir, id));
  applyLastTurnStatsMeta(history.messages, meta);
  attachDeliverables(history.messages, {
    workDir: effectiveWorkDir, additionalDirectories: extraDirs, uploads: ctx?.uploads,
    artifactDir: sessionBrainDir(client.dataDir, id),
  });
  const title = meta.customTitle || history.title || snapshot?.title || cachedListRow?.title || meta.title || '新对话';
  if (history.title && !meta.title) {
    noteSessionMeta(ctx?.agyDir, id, {
      ...(verifiedCwd ? { cwd: verifiedCwd } : {}),
      title: history.title,
    });
  }

  const cfgSummary = extractConfigSummary(snapshot?.configOptions || [], snapshot?.modes, snapshot?.models);
  const resolvedModel = cfgSummary.model || meta.config?.model || diskMetaModel || desiredConfig.model || null;
  const resolvedThought = cfgSummary.thoughtLevel || meta.config?.thought_level || diskMetaThought || desiredConfig.thought_level || null;
  const resolvedMode = cfgSummary.mode || meta.config?.mode || desiredConfig.mode || null;

  // 快读路径绝不阻塞等 400ms 探端口：已缓存则零等待读取，未缓存则用兜底上限表并后台异步预热
  const liveLimits = fastSource === 'acp'
    ? (peekAgyContextLimits(client) || await getAgyContextLimits(client, { timeoutMs: 400 }).catch(() => null))
    : (peekAgyContextLimits(client) || (warmAgyContextLimits(client), null));
  const rawUsage = history.usage || snapshot?.rawUsage || snapshot?.usage || diskRawUsage;
  const resolvedUsage = resolveEffectiveContextUsage(rawUsage, {
    model: resolvedModel || '',
    thoughtLevel: resolvedThought || '',
    liveLimits,
  }) || snapshot?.usage || history.usage || null;

  // 仅当真正走了 session/load 全量回放时才对齐监视器基线；走内存 / 磁盘快读或 hasAliveBackground 短路时
  // 不覆盖已有监视器进度，免得吞掉后台唤醒新步。
  if (!preservedAlive) {
    markSessionTranscriptSynced(ctx?.key, client, id);
  }
  if (hasProtectedSubagents(client.dataDir, id)) {
    armSubagentMonitor(ctx, client, id, { pollNow: true });
  }

  const detailFp = computeAgyDetailFingerprint({
    source: fastSource,
    sourceStamp: fastStamp,
    meta,
    cwd: effectiveWorkDir,
    title: cachedTitleHint,
    desiredConfig,
  });

  return {
    sessionId: id,
    fp: detailFp,
    cwd: verifiedCwd || rpcCwd || '',
    projectId: meta.projectId || null,
    title,
    customTitle: meta.customTitle || '',
    messages: history.messages,
    usage: resolvedUsage,
    commands: history.commands.length ? history.commands : (snapshot?.commands || []),
    configOptions: snapshot?.configOptions || [],
    modes: snapshot?.modes || null,
    models: snapshot?.models || null,
    tier: snapshot?.tier || null,
    model: resolvedModel,
    thoughtLevel: resolvedThought,
    mode: resolvedMode,
  };
}
