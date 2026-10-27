// 「临时对话存为工作空间」与「工作空间改名」（2026-10-10 维护者要求；10-22 S1-6：任意一条临时对话都能存）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listProjects, saveQuickProject, renameProject, sessionScopes } from './claude-projects.mjs';
import { quickProject, pruneQuick } from './claude-quick.mjs';
import { sessionsDir } from './runtime/paths.mjs';

// 沙箱用户身份：桶落 <dataDir>/quickchat（admin 会落真实主目录，测试别碰）。
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'quick-save-'));
  const ctx = { kind: 'user', key: 'u:s', cwd: root, dataDir: root, configDir: path.join(root, 'claude'), claudeProjects: path.join(root, 'claude-projects.json') };
  return { root, ctx, file: ctx.claudeProjects };
}
const talk = (ctx, dir, id) => {
  const t = sessionsDir(dir, ctx.configDir);
  mkdirSync(t, { recursive: true });
  writeFileSync(path.join(t, id + '.jsonl'), '{}\n');
};

test('saveQuickProject: 桶原地变项目（id/路径沿用）、当前桶位换新桶、编号只增、撤掉记忆闸', () => {
  const { root, ctx, file } = fixture();
  try {
    const q = quickProject(ctx);
    const settings = path.join(q.path, '.claude', 'settings.local.json');
    assert.ok(existsSync(settings), '铸桶时写了 autoMemoryEnabled:false');

    assert.throws(() => saveQuickProject(file, ctx, { expectId: 'stale-id' }), /不在了/);

    const r = saveQuickProject(file, ctx, { expectId: q.id, base: '快照会话' });
    assert.equal(r.project.id, q.id, 'id 沿用：前端会话的 projectId 原样有效');
    assert.equal(r.project.path, q.path, '先原地登记（挪位置是下一步）');
    assert.equal(r.project.name, '快照会话 1');
    assert.notEqual(r.quick.id, q.id);
    assert.equal(quickProject(ctx).id, r.quick.id);
    assert.ok(!existsSync(settings), '存成工作空间后自动记忆照普通工作空间放开');

    const list = listProjects(file, ctx);
    const saved = list.find((p) => p.id === q.id);
    assert.ok(saved && !saved.quick && saved.name === '快照会话 1');
    assert.equal(list.filter((p) => p.quick).length, 1);
    assert.ok(list[0].def, '[0] 恒为默认工作空间');
    assert.ok(sessionScopes(file, ctx, list).some((s) => s.project.id === q.id && !s.project.quick));

    const r2 = saveQuickProject(file, ctx, { base: 'Saved chat' });
    assert.equal(r2.project.name, 'Saved chat 2');
    assert.throws(() => saveQuickProject(file, ctx, { expectId: q.id }), /已经存为工作空间/, '同一只桶不能存两次');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('saveQuickProject 按 id 存任意一条临时对话；给了标题就用标题当名字、不占编号', () => {
  const { root, ctx, file } = fixture();
  try {
    const a = quickProject(ctx);
    talk(ctx, a.path, '11111111-aaaa-bbbb-cccc-000000000000');
    const b = quickProject(ctx);   // a 用过了：当前桶换成 b
    talk(ctx, b.path, '22222222-aaaa-bbbb-cccc-000000000000');
    const cur = quickProject(ctx);
    assert.ok(cur.id !== a.id && cur.id !== b.id);
    const r = saveQuickProject(file, ctx, { id: a.id, label: '  周报\n草稿  ' });
    assert.equal(r.project.id, a.id);
    assert.equal(r.project.name, '周报 草稿');
    assert.equal(r.quick.id, cur.id, '存的不是当前桶：当前桶位不变');
    const list = listProjects(file, ctx);
    assert.ok(list.some((p) => p.id === b.id && p.quick), '别的临时对话不受影响');
    assert.ok(list.some((p) => p.id === a.id && !p.quick));
    assert.equal(saveQuickProject(file, ctx, { id: b.id, base: '存下的对话' }).project.name, '存下的对话 1', '没给标题才用编号');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('pruneQuick 跳过已存为工作空间的桶', async () => {
  const { root, ctx, file } = fixture();
  try {
    const now = Date.now();
    const q = quickProject(ctx);
    const dir = sessionsDir(q.path, ctx.configDir);
    mkdirSync(dir, { recursive: true });
    const saved = path.join(dir, '33333333-aaaa-bbbb-cccc-000000000000.jsonl');
    writeFileSync(saved, '{}\n');
    const old = new Date(now - 90 * 24 * 3600e3);
    utimesSync(saved, old, old); utimesSync(q.path, old, old);
    saveQuickProject(file, ctx, {});
    const r = await pruneQuick(ctx, { now });
    assert.ok(existsSync(saved) && existsSync(q.path), '存走的桶与记录都在');
    assert.equal(r.recycled, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('renameProject: 只改显示名、默认工作空间也能改、留空恢复文件夹名、临时对话不能改', () => {
  const { root, ctx, file } = fixture();
  try {
    const [def] = listProjects(file, ctx);
    const r = renameProject(file, ctx, def.id, '  我的空间  ');
    assert.equal(r.name, '我的空间');
    assert.equal(listProjects(file, ctx)[0].name, '我的空间');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).projects[0].path, def.path, '路径不动');
    assert.equal(renameProject(file, ctx, def.id, '').name, path.basename(root));
    const q = quickProject(ctx);
    assert.throws(() => renameProject(file, ctx, q.id, 'x'), /不存在/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
