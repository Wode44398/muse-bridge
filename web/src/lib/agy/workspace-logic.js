// Antigravity 侧边工作区纯逻辑层：工作空间文件路径定位换算、非 git 目录本会话变更汇总、
// 以及工具调用与权限审批的本会话活动时间线聚合。

import { t } from '../i18n.js';
import { classifyToolKind, computeDiffLines, resolveAgyLocalLink, stripWorkspaceCdPrefix } from './logic.js';

function normSlashes(p = '') {
  return String(p || '').trim().replace(/\\/g, '/').replace(/\/+$/, '');
}

function foldForCompare(normPath = '') {
  return /^[A-Za-z]:(\/|$)/.test(normPath) ? normPath.toLowerCase() : normPath;
}

export function relativeToWorkspace(filePath = '', sessionCwd = '') {
  const nf = normSlashes(filePath);
  const nw = normSlashes(sessionCwd);
  if (!nf || !nw) return null;
  const ff = foldForCompare(nf);
  const fw = foldForCompare(nw);
  if (ff === fw) return '';
  if (ff.startsWith(fw + '/')) return nf.slice(nw.length + 1);
  return null;
}

// 把工具卡或 diff 卡里的文件路径换算为侧边「文件」面板所需的 { ws, rel, fileRel, fileName, open }
export function computeWorkspaceFileTarget(filePath = '', sessionCwd = '', { openFile = false } = {}) {
  const abs = resolveAgyLocalLink(filePath, sessionCwd) || String(filePath || '').trim();
  const nf = normSlashes(abs);
  if (!nf) return null;

  const lastSlash = nf.lastIndexOf('/');
  const dirNorm = lastSlash >= 0 ? nf.slice(0, lastSlash) : '';
  const fileName = lastSlash >= 0 ? nf.slice(lastSlash + 1) : nf;
  const sep = abs.includes('\\') ? '\\' : '/';

  const inWsRel = relativeToWorkspace(nf, sessionCwd);
  if (inWsRel !== null && sessionCwd) {
    const dirRelIdx = inWsRel.lastIndexOf('/');
    const dirRel = dirRelIdx >= 0 ? inWsRel.slice(0, dirRelIdx) : '';
    return {
      ws: sessionCwd,
      rel: dirRel,
      fileRel: inWsRel,
      fileName,
      open: openFile ? fileName : '',
      absPath: abs,
    };
  }

  const fallbackWs = dirNorm ? dirNorm.replace(/\//g, sep) : (sessionCwd || '');
  return {
    ws: fallbackWs,
    rel: '',
    fileRel: fileName,
    fileName,
    open: openFile ? fileName : '',
    absPath: abs,
  };
}

// agy 的 ui_open 打开文件 / 文件夹（服务端 modules/agy/server/routes/agy-ui-open.mjs 在 ui.cmd 里带 from）：人在 agy 页上时
// lib/agentUi.js 用它换算成 agy 右侧工作区文件卡的定位目标（openAgyDockFiles 的参数）。rel 已由服务端按那个会话的目录
// 解析好、相对 ws；'.' 表示 ws 本身。→ { ws, rel, open }（文件夹 = 定位到那个目录；文件 = 定位到所在目录并卡内预览），无从定位返回 null。
export function agyUiTargetOf({ kind, rel, ws } = {}) {
  const root = String(ws || '').trim();
  if (!root) return null;
  let r = String(rel ?? '').replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+|\/+$/g, '');
  if (r === '.') r = '';
  if (kind === 'folder') return { ws: root, rel: r, open: '' };
  if (!r) return null;
  const hit = computeWorkspaceFileTarget(r, root, { openFile: true });
  return hit ? { ws: hit.ws, rel: hit.rel, open: hit.open } : null;
}

export function formatActivityDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

// 聚合本会话所有轮次的工具调用与权限审批，供侧边工作区「活动」面板展示与点击跳转
export function buildActivityTimeline(messages = [], sessionCwd = '') {
  const items = [];
  const counts = { total: 0, running: 0, edit: 0, execute: 0, read: 0, permission: 0 };
  const list = Array.isArray(messages) ? messages : [];

  for (let mi = 0; mi < list.length; mi++) {
    const msg = list[mi];
    if (!msg || msg.role !== 'assistant') continue;

    for (let bi = 0; bi < (msg.blocks || []).length; bi++) {
      const blk = msg.blocks[bi];
      if (!blk || blk.type !== 'tool') continue;
      const tool = msg.toolsById?.[blk.toolCallId] || blk.tool;
      if (!tool) continue;

      const meta = classifyToolKind(tool, { sessionCwd });
      const rawSt = String(tool.status || 'completed');
      const isFailedExit = tool.exitCode !== null && tool.exitCode !== undefined && Number(tool.exitCode) !== 0;
      let status = 'completed';
      if (rawSt === 'in_progress' || rawSt === 'pending') status = 'running';
      else if (rawSt === 'cancelled') status = 'cancelled';
      else if (rawSt === 'failed' || rawSt === 'error' || isFailedExit) status = 'failed';

      let added = 0;
      let removed = 0;
      if (Array.isArray(tool.diffs) && tool.diffs.length > 0) {
        for (const d of tool.diffs) {
          const stat = computeDiffLines(d.oldText ?? '', d.newText ?? '', 1);
          added += stat.added;
          removed += stat.removed;
        }
      }

      const targetId = String(tool.toolCallId || blk.toolCallId || `tool-${mi}-${bi}`);
      items.push({
        id: `act-tool-${mi}-${bi}-${targetId}`,
        entryType: 'tool',
        targetId,
        turnIndex: mi,
        category: meta.category,
        icon: meta.icon,
        verb: meta.verb,
        summary: meta.summary,
        status,
        exitCode: tool.exitCode ?? null,
        durationMs: typeof tool.durationMs === 'number' ? tool.durationMs : null,
        added,
        removed,
      });

      counts.total++;
      if (status === 'running') counts.running++;
      if (meta.category === 'edit') counts.edit++;
      else if (meta.category === 'execute') counts.execute++;
      else if (meta.category === 'read' || meta.category === 'search') counts.read++;
    }

    for (let pi = 0; pi < (msg.permissions || []).length; pi++) {
      const perm = msg.permissions[pi];
      if (!perm) continue;
      const meta = classifyToolKind({
        name: perm.toolName,
        kind: perm.kind,
        title: perm.title,
        command: perm.command,
        locations: perm.locations,
        args: perm.args,
      }, { sessionCwd });
      const status = perm.status === 'pending'
        ? 'pending'
        : (perm.status === 'cancelled' ? 'cancelled' : 'resolved');
      const reqId = String(perm.requestId || `perm-${mi}-${pi}`);
      const cleanPermCmd = stripWorkspaceCdPrefix(perm.command || '', sessionCwd);
      // 审批卡处理后已合并进对应工具卡收起，点击时间线直接跳到该工具卡
      const jumpToTool = status !== 'pending' && Boolean(perm.toolCallId);

      items.push({
        id: `act-perm-${mi}-${pi}-${reqId}`,
        entryType: jumpToTool ? 'tool' : 'permission',
        targetId: jumpToTool ? String(perm.toolCallId) : reqId,
        turnIndex: mi,
        category: 'permission',
        icon: 'shield',
        verb: t('权限审批'),
        summary: cleanPermCmd || (meta.bridge ? [meta.verb, meta.detail || meta.summary].filter(Boolean).join(' · ') : '') || perm.title || meta.summary,
        status,
        bypassSandbox: Boolean(perm.bypassSandbox),
        durationMs: null,
        added: 0,
        removed: 0,
      });

      counts.total++;
      counts.permission++;
      if (status === 'pending') counts.running++;
    }
  }

  return { items, counts };
}

// 非 git 目录无法走 git diff 时，将本会话收到的编辑 diff 按文件合并首版旧文与末版新文，生成可展开审阅列表
export function extractSessionModifiedFiles(messages = [], sessionCwd = '') {
  const byKey = new Map();
  const list = Array.isArray(messages) ? messages : [];

  for (const msg of list) {
    if (!msg || msg.role !== 'assistant') continue;
    for (const blk of (msg.blocks || [])) {
      if (!blk || blk.type !== 'tool') continue;
      const tool = msg.toolsById?.[blk.toolCallId] || blk.tool;
      if (!tool || tool.status === 'cancelled' || tool.status === 'failed' || tool.status === 'error') continue;

      const fallbackLoc = Array.isArray(tool.locations) && tool.locations[0]
        ? (typeof tool.locations[0] === 'string' ? tool.locations[0] : tool.locations[0].path || '')
        : '';

      for (const d of (tool.diffs || [])) {
        const rawPath = String(d?.path || fallbackLoc || '').trim();
        if (!rawPath) continue;
        const absPath = resolveAgyLocalLink(rawPath, sessionCwd) || rawPath;
        const key = foldForCompare(normSlashes(absPath));
        if (!key) continue;

        const oldText = String(d.oldText ?? '');
        const newText = String(d.newText ?? '');
        if (!byKey.has(key)) {
          const rel = relativeToWorkspace(absPath, sessionCwd);
          byKey.set(key, {
            key,
            absPath,
            displayPath: rel || normSlashes(absPath).split('/').slice(-2).join('/') || absPath,
            firstOldText: oldText,
            lastNewText: newText,
            editCount: 1,
            lastToolCallId: tool.toolCallId || '',
          });
        } else {
          const entry = byKey.get(key);
          entry.lastNewText = newText;
          entry.editCount++;
          if (tool.toolCallId) entry.lastToolCallId = tool.toolCallId;
        }
      }
    }
  }

  const files = [];
  let totalAdd = 0;
  let totalDel = 0;

  for (const entry of byKey.values()) {
    const diff = computeDiffLines(entry.firstOldText, entry.lastNewText);
    totalAdd += diff.added;
    totalDel += diff.removed;
    files.push({
      path: entry.displayPath,
      absPath: entry.absPath,
      editCount: entry.editCount,
      lastToolCallId: entry.lastToolCallId,
      added: diff.added,
      removed: diff.removed,
      lines: diff.lines,
      truncated: diff.truncated,
      totalLines: diff.totalLines,
      isNewFile: entry.firstOldText === '' && entry.lastNewText !== '',
      isDeletedFile: entry.firstOldText !== '' && entry.lastNewText === '',
    });
  }

  return {
    files,
    total: { add: totalAdd, del: totalDel },
  };
}
