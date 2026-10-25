// 临时对话（S1-6）：会话列表与搜索覆盖【全部】还留着的临时对话，不再只认最新那一条。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-quicklist-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
process.env.BRIDGE_DESKTOP_SESSIONS_DIR = path.join(tmp, 'desktop', 'claude-code-sessions');
delete process.env.CLAUDE_CONFIG_DIR;

const { listSessionFiles, listSessionFilesAsync } = await import('./session-list.mjs');
const { searchSessions } = await import('./session-search.mjs');
const { quickProject } = await import('../claude-quick.mjs');
const { sessionsDir } = await import('./paths.mjs');

test.after(() => rmSync(tmp, { recursive: true, force: true }));

const sid = (n) => `${String(n).repeat(8)}-aaaa-bbbb-cccc-000000000000`;
function talk(ctx, cwd, id, text, ageMs) {
  const dir = sessionsDir(cwd, ctx.configDir);
  mkdirSync(dir, { recursive: true });
  const f = path.join(dir, id + '.jsonl');
  writeFileSync(f, JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, timestamp: '2026-10-01T00:00:00.000Z' }) + '\n');
  const t = new Date(Date.now() - ageMs);
  utimesSync(f, t, t);
}

test('quickFiles 列出每一只临时对话桶里的对话（按最近活动倒序），普通会话照旧在 files', async () => {
  const root = path.join(tmp, 'u1');
  const data = path.join(root, '.bridge');
  mkdirSync(data, { recursive: true });
  const ctx = { kind: 'user', key: 'u:list', cwd: root, dataDir: data, configDir: path.join(data, 'claude'), claudeProjects: path.join(data, 'claude-projects.json') };
  const a = quickProject(ctx);
  talk(ctx, a.path, sid(1), '旧的临时对话：写周报', 5 * 864e5);
  const b = quickProject(ctx);   // a 用过了，换了一只
  talk(ctx, b.path, sid(2), '新的临时对话：查天气', 3600e3);
  talk(ctx, root, sid(3), '工作空间里的正经对话', 7200e3);

  const r = listSessionFiles(ctx);
  assert.deepEqual(r.quickFiles.map((f) => f.id), [sid(2), sid(1)], '两只桶的对话都在，新的在前');
  assert.deepEqual(r.quickFiles.map((f) => f.projectId), [b.id, a.id]);
  assert.deepEqual(r.files.map((f) => f.id), [sid(3)]);
  const ra = await listSessionFilesAsync(ctx, { maxAge: 0 });
  assert.deepEqual(ra.quickFiles.map((f) => f.id), [sid(2), sid(1)]);

  const hit = await searchSessions(ctx, '周报', { readFirst: () => '', trim: (s) => s });
  assert.ok(hit.hits.some((h) => h.sessionId === sid(1) && h.project === '临时对话'), '旧的临时对话也搜得到');
});

test('locateSessionPaths / locateSessionProject 记住上次找到的目录：命中直接用；挪走了退回逐个找，删了回 null', async () => {
  const { locateSessionPaths, locateSessionProject } = await import('../claude-projects.mjs');
  const { renameSync, rmSync: rm } = await import('node:fs');
  const root = path.join(tmp, 'u2');
  const data = path.join(root, '.bridge');
  mkdirSync(data, { recursive: true });
  const ctx = { kind: 'user', key: 'u:loc', cwd: root, dataDir: data, configDir: path.join(data, 'claude'), claudeProjects: path.join(data, 'claude-projects.json') };
  const a = quickProject(ctx);
  talk(ctx, a.path, sid(4), '临时对话里的一条', 3600e3);
  quickProject(ctx);   // a 用过了，换一只
  const p1 = locateSessionPaths(ctx.claudeProjects, ctx, sid(4));
  assert.equal(p1.project.id, a.id);
  assert.equal(locateSessionProject(ctx.claudeProjects, ctx, sid(4)).id, a.id, '第二次走记住的目录，结果一样');
  const wsDir = sessionsDir(root, ctx.configDir);
  mkdirSync(wsDir, { recursive: true });
  renameSync(p1.file, path.join(wsDir, sid(4) + '.jsonl'));
  const p2 = locateSessionPaths(ctx.claudeProjects, ctx, sid(4));
  assert.ok(p2 && p2.project.def, '记住的目录里没有了：退回逐个找，找到工作空间里那份');
  rm(p2.file);
  assert.equal(locateSessionPaths(ctx.claudeProjects, ctx, sid(4)), null);
});
