// 「存为工作空间」后把桶挪出快照目录（10-21 维护者要求：存好的工作空间落固定位置，任何回收都碰不到）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listProjects, saveQuickProject, relocateSavedQuicks, savedDirName } from './claude-projects.mjs';
import { quickProject } from './claude-quick.mjs';
import { sessionsDir } from './runtime/paths.mjs';

// 沙箱用户身份：桶落 <dataDir>/quickchat，存好的落 <dataDir>/workspaces（admin 会落真实主目录，测试别碰）。
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'quick-reloc-'));
  const data = path.join(root, '.bridge');
  const ctx = { kind: 'user', key: 'u:s', cwd: root, dataDir: data, configDir: path.join(data, 'claude'), claudeProjects: path.join(data, 'claude-projects.json') };
  return { root, ctx, file: ctx.claudeProjects };
}
const SID = '11111111-aaaa-bbbb-cccc-000000000000';

test('存为工作空间后挪到固定位置：目录、transcript（含子目录 slug）、记录里的路径、项目表都跟上', async () => {
  const { root, ctx, file } = fixture();
  try {
    const q = quickProject(ctx);
    mkdirSync(path.join(q.path, '课件'), { recursive: true });
    writeFileSync(path.join(q.path, '课件', 'a.html'), 'hi');
    const tdir = sessionsDir(q.path, ctx.configDir);
    mkdirSync(path.join(tdir, SID, 'subagents'), { recursive: true });
    writeFileSync(path.join(tdir, SID + '.jsonl'), JSON.stringify({ cwd: q.path, text: `产物在 ${path.join(q.path, '课件', 'a.html')}`, out: path.join(tdir, 'tool-results', 'r.txt') }) + '\n');
    writeFileSync(path.join(tdir, SID, 'subagents', 'agent-x.jsonl'), JSON.stringify({ cwd: path.join(q.path, '课件') }) + '\n');
    const subT = sessionsDir(path.join(q.path, '课件'), ctx.configDir);
    mkdirSync(subT, { recursive: true });
    writeFileSync(path.join(subT, 'x.txt'), '');

    saveQuickProject(file, ctx, { expectId: q.id, base: '快照会话' });
    const moved = await relocateSavedQuicks(file, ctx);
    const to = path.join(ctx.dataDir, 'workspaces', `chat-${q.id.slice(0, 8)}`);   // 「快照会话 1」没有英文字母：不截尾号，用 id
    assert.deepEqual(moved, [{ id: q.id, path: to }]);

    assert.ok(!existsSync(q.path), '快照目录里不再有它');
    assert.equal(readFileSync(path.join(to, '课件', 'a.html'), 'utf8'), 'hi', '工作文件原样搬过去');
    const nt = sessionsDir(to, ctx.configDir);
    assert.ok(!existsSync(tdir) && existsSync(path.join(nt, SID + '.jsonl')), 'transcript 目录跟着改名');
    assert.ok(existsSync(path.join(sessionsDir(path.join(to, '课件'), ctx.configDir), 'x.txt')), '子目录 cwd 的 slug 也跟着改');
    const line = JSON.parse(readFileSync(path.join(nt, SID + '.jsonl'), 'utf8').trim());
    assert.equal(line.cwd, to);
    assert.ok(line.text.includes(path.join(to, '课件', 'a.html')), '正文里的产物路径改写成新位置');
    assert.equal(line.out, path.join(nt, 'tool-results', 'r.txt'), '指向 transcript 目录的路径跟着目录改名');
    const sub = JSON.parse(readFileSync(path.join(nt, SID, 'subagents', 'agent-x.jsonl'), 'utf8').trim());
    assert.equal(sub.cwd, path.join(to, '课件'));

    const p = listProjects(file, ctx).find((x) => x.id === q.id);
    assert.ok(p && p.path === to && p.name === '快照会话 1', 'id、名字不变，只换 path');
    assert.deepEqual(await relocateSavedQuicks(file, ctx), [], '幂等：挪过的不再动');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('有会话正在跑就原地不动，下次再挪；常驻 CLI 先关', async () => {
  const { root, ctx, file } = fixture();
  try {
    const q = quickProject(ctx);
    const tdir = sessionsDir(q.path, ctx.configDir);
    mkdirSync(tdir, { recursive: true });
    writeFileSync(path.join(tdir, SID + '.jsonl'), '{}\n');
    saveQuickProject(file, ctx, {});
    assert.deepEqual(await relocateSavedQuicks(file, ctx, { busy: new Set([SID]) }), []);
    assert.ok(existsSync(q.path) && existsSync(tdir));
    const released = [];
    const r = await relocateSavedQuicks(file, ctx, { release: async (id) => { released.push(id); } });
    assert.equal(r.length, 1);
    assert.deepEqual(released, [SID]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('savedDirName：标题里的英文 / 数字词连成短名；没有英文字母就 chat-<id 前 8 位>；不从标题末尾截编号', () => {
  const id = 'abcdef12-3456-7890-abcd-ef1234567890';
  assert.equal(savedDirName('介绍 iPhone 17', id), 'iphone-17');
  assert.equal(savedDirName('Top 10 清单', id), 'top-10');
  assert.equal(savedDirName('对比 2025 和 2026 财报', id), 'chat-abcdef12', '只有数字不像名字');
  assert.equal(savedDirName('快照会话 3', id), 'chat-abcdef12');
  assert.equal(savedDirName('', id), 'chat-abcdef12');
  assert.equal(savedDirName('CON', id), 'chat-abcdef12', 'Windows 保留名');
  assert.equal(savedDirName('Café résumé', id), 'cafe-resume');
  assert.ok(savedDirName('a'.repeat(30) + ' ' + 'b'.repeat(30), id).length <= 40);
});

test('标题以数字结尾的存成工作空间：目录名跟标题走，不再是 snapshot-<尾号>', async () => {
  const { root, ctx, file } = fixture();
  try {
    const q = quickProject(ctx);
    const tdir = sessionsDir(q.path, ctx.configDir);
    mkdirSync(tdir, { recursive: true });
    writeFileSync(path.join(tdir, SID + '.jsonl'), '{}\n');
    saveQuickProject(file, ctx, { id: q.id, label: '介绍 iPhone 17' });
    const [moved] = await relocateSavedQuicks(file, ctx);
    assert.equal(moved.path, path.join(ctx.dataDir, 'workspaces', 'iphone-17'));
    assert.equal(listProjects(file, ctx).find((p) => p.id === q.id).name, '介绍 iPhone 17');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
