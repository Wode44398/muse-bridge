// 定位会话的 transcript、会话搜索、列表里显示的标题。
import path from 'node:path';
import { statSync } from 'node:fs';
import fsp from 'node:fs/promises';
import * as claudeProjects from '../../claude-projects.mjs';
import { getLibrary } from '../../runtime/session-library.mjs';
import { lineageFor } from '../../runtime/desktop-lineage.mjs';
import { familyMaps } from '../../runtime/session-family.mjs';
import { peekSessionFile } from '../../runtime/session-list.mjs';
import { resolveTitle } from '../../runtime/session-titles.mjs';
import { searchSessions as searchSessionsCore } from '../../runtime/session-search.mjs';
import { readSessionTitle, trimTitle } from './transcript-text.mjs';

// 定位 transcript（/api/session、会话信息面板这类热路径）：先查会话列表的扫盘缓存（session-list.mjs，命中再异步确认文件
// 还在），查不到才走 locateSessionPaths——它对每个项目目录同步 existsSync 一遍（几十个目录 ~20ms，会话信息面板还要再来一遍）。
export async function locateSession(ctx, id) {
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
export async function displayTitle(ctx, id, file) {
  const lib = getLibrary(ctx).titles || {};
  if (lib[id]) return trimTitle(lib[id]);
  let st = { size: 0, mtime: 0 };
  try { const s = statSync(file); st = { size: s.size, mtime: s.mtimeMs }; } catch {}
  const r = await resolveTitle({ id, file, ...st }, {
    fam: familyMaps(ctx).titles.get(id), desktop: lineageFor(ctx).titles.get(id), readFirst: readSessionTitle, trim: trimTitle,
  });
  return r.title;
}
