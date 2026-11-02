// 工作台「记忆」卡的后端（图谱的解析与找目录在 runtime/memory-graph.mjs）：
//   GET /api/claude/memory?ws=<会话工作目录>   — 这个工作目录的 Claude 记忆目录（与 Claude Code 同一套找法）+ 图
//   GET /api/claude/memory?dir=<记忆目录>      — 直接看某个记忆目录（切换列表里点进来的）
//   GET /api/claude/memory/roots               — 这个身份能看的全部记忆目录（切换列表）
// 读写单篇不在这里：前端把记忆目录当 ws 根，走现成的 /api/file、/api/file/save（同一套授权与冲突校验）。
// 目录一律经 authorizeProjectPath 圈定（admin 任意本地目录、Pro 限自己空间）；快照访客不开放。

import { requireCtx } from '../runtime/identity.mjs';
import { authorizeProjectPath, listProjects } from '../claude-projects.mjs';
import { buildMemoryGraph, listMemoryRoots, resolveMemoryDir } from '../runtime/memory-graph.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const fail = (res, e) => json(res, e?.status || 500, { error: e?.message || String(e) });

function memCtx(identify, req, res) {
  const ctx = requireCtx(identify, req, res);
  if (!ctx) return null;
  if (ctx.kind === 'snap') { json(res, 403, { error: '快照访客看不到记忆' }); return null; }
  return ctx;
}

export function registerClaudeMemoryRoutes(router, { identify }) {
  router.on('GET', '/api/claude/memory', async (req, res, url) => {
    const ctx = memCtx(identify, req, res);
    if (!ctx) return;
    try {
      let found;
      const dirRaw = String(url.searchParams.get('dir') || '').trim();
      if (dirRaw) found = { dir: dirRaw, source: 'pick', base: '' };
      else found = await resolveMemoryDir(ctx, authorizeProjectPath(ctx, url.searchParams.get('ws')));
      let dir;
      try { dir = authorizeProjectPath(ctx, found.dir); }
      catch (e) {
        // 还没写过记忆的项目：目录不存在不算错，前端说「还没有记忆」
        if (e?.status === 404) return json(res, 200, { ...found, exists: false, graph: null });
        throw e;
      }
      json(res, 200, { ...found, dir, exists: true, graph: await buildMemoryGraph(dir) });
    } catch (e) { fail(res, e); }
  });

  router.on('GET', '/api/claude/memory/roots', async (req, res) => {
    const ctx = memCtx(identify, req, res);
    if (!ctx) return;
    try {
      let projects = [];
      try { projects = listProjects(ctx.claudeProjects, ctx); } catch {}
      const roots = [];
      for (const r of await listMemoryRoots(ctx, projects)) {
        try { roots.push({ ...r, dir: authorizeProjectPath(ctx, r.dir) }); } catch {}
      }
      // 软链 / junction 指向同一处的只留一条（bridge build 的 projects 目录就是 junction → 真身）
      // （两条里谁带着项目名就留谁的名字）
      const seen = new Map();
      for (const r of roots) {
        const k = process.platform === 'win32' ? r.dir.toLowerCase() : r.dir;
        const had = seen.get(k);
        if (!had) seen.set(k, r);
        else if (!had.name && r.name) Object.assign(had, { name: r.name, project: r.project, source: r.source || had.source });
      }
      json(res, 200, { roots: [...seen.values()] });
    } catch (e) { fail(res, e); }
  });
}
