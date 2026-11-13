import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, utimesSync, existsSync } from 'node:fs';
import { parseHead, buildRecord, mirrorOnce, currentAccountUuid, mirrorEnabled } from './desktop-mirror.mjs';

const line = (o) => JSON.stringify(o) + '\n';
function transcript(dir, id, entrypoint, extra = '') {
  const f = path.join(dir, id + '.jsonl');
  writeFileSync(f,
    line({ type: 'queue-operation', timestamp: '2026-11-01T00:00:00.000Z' }) +
    line({ type: 'user', entrypoint, cwd: 'E:\\proj', permissionMode: 'bypassPermissions', message: { role: 'user', content: 'hi' }, timestamp: '2026-11-01T00:00:01.000Z' }) +
    line({ type: 'assistant', entrypoint, cwd: 'E:\\proj', message: { model: 'claude-opus-5-5', content: [] } }) + extra);
  return f;
}
const rowOf = (f) => { const st = require_stat(f); return { id: path.basename(f, '.jsonl'), file: f, mtime: st.mtimeMs, size: st.size }; };
import { statSync } from 'node:fs';
const require_stat = (f) => statSync(f);

test('parseHead：entrypoint / cwd / 权限 / 模型 / 创建时刻', () => {
  const h = parseHead(line({ timestamp: '2026-11-01T00:00:00.000Z' }) + line({ type: 'user', entrypoint: 'sdk-ts', cwd: 'C:\\a', permissionMode: 'auto' }) + line({ type: 'assistant', message: { model: 'claude-sonnet-5-5' } }) + '{半截');
  assert.equal(h.entrypoint, 'sdk-ts');
  assert.equal(h.cwd, 'C:\\a');
  assert.equal(h.permissionMode, 'auto');
  assert.equal(h.model, 'claude-sonnet-5-5');
  assert.equal(h.createdAt, Date.parse('2026-11-01T00:00:00.000Z'));
});

test('buildRecord：Desktop 全量记录里必有的字段都在', () => {
  const r = buildRecord({ local: 'local_x', cli: 'c', cwd: 'E:\\p', title: 't', createdAt: 1, lastActivityAt: 2 });
  for (const k of ['sessionId', 'cliSessionId', 'cwd', 'originCwd', 'createdAt', 'lastActivityAt', 'model', 'isArchived', 'permissionMode', 'remoteMcpServersConfig', 'alwaysAllowedReasons', 'sessionPermissionUpdates', 'title', 'titleSource']) assert.ok(k in r, k);
  assert.equal(r.permissionMode, 'default');
});

test('currentAccountUuid：读 claude-code-sessions 上一级的 config.json', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  try {
    writeFileSync(path.join(root, 'config.json'), JSON.stringify({ lastKnownAccountUuid: '0660040c-e804-4d86-b138-3ea9c7788d8c' }));
    assert.equal(currentAccountUuid(path.join(root, 'claude-code-sessions')), '0660040c-e804-4d86-b138-3ea9c7788d8c');
    assert.equal(currentAccountUuid(path.join(root, 'nope', 'claude-code-sessions')), null);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mirrorOnce：只登记 bridge 会话、Desktop 已有的不写、Desktop 接手 / 删除后不再碰', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  try {
    const proj = path.join(root, 'proj'); mkdirSync(proj);
    const od = path.join(root, 'org'); mkdirSync(od);
    const stateFile = path.join(root, 'state.json');
    const a = transcript(proj, 'aaaaaaaa-0000-0000-0000-000000000001', 'sdk-ts');
    const b = transcript(proj, 'aaaaaaaa-0000-0000-0000-000000000002', 'claude-desktop');
    const c = transcript(proj, 'aaaaaaaa-0000-0000-0000-000000000003', 'sdk-ts');
    const known = new Set(['aaaaaaaa-0000-0000-0000-000000000003']);
    const arch = new Set();
    const run = (files) => mirrorOnce({ files, titleOf: async (f) => '标题 ' + f.id.slice(-1), archivedOf: (f) => arch.has(f.id), stateFile, orgDir: od, knownIds: known });

    let r = await run([a, b, c].map(rowOf));
    assert.equal(r.wrote, 1);
    const files = readdirSync(od).filter((n) => n.startsWith('local_'));
    assert.equal(files.length, 1);
    const rec = JSON.parse(readFileSync(path.join(od, files[0]), 'utf8'));
    assert.equal(rec.cliSessionId, 'aaaaaaaa-0000-0000-0000-000000000001');
    assert.equal(rec.cwd, 'E:\\proj');
    assert.equal(rec.model, 'claude-opus-5-5');
    assert.equal(rec.permissionMode, 'bypassPermissions');
    assert.equal(rec.title, '标题 1');
    assert.equal(rec.isArchived, false);

    // transcript 没变：不重写
    r = await run([a, b, c].map(rowOf));
    assert.equal(r.wrote + r.updated, 0);

    // transcript 变了 + bridge 里归档了：更新同一份文件
    writeFileSync(a, readFileSync(a, 'utf8') + line({ type: 'user', message: { content: 'more' } }));
    arch.add('aaaaaaaa-0000-0000-0000-000000000001');
    r = await run([a, b, c].map(rowOf));
    assert.equal(r.updated, 1);
    assert.equal(JSON.parse(readFileSync(path.join(od, files[0]), 'utf8')).isArchived, true);

    // Desktop 动过这份文件（mtime 变了）：归 Desktop，之后不再改
    const t = new Date(Date.now() + 5000); utimesSync(path.join(od, files[0]), t, t);
    writeFileSync(a, readFileSync(a, 'utf8') + line({ type: 'user', message: { content: 'again' } }));
    arch.delete('aaaaaaaa-0000-0000-0000-000000000001');
    r = await run([a, b, c].map(rowOf));
    assert.equal(r.updated, 0);
    assert.equal(JSON.parse(readFileSync(path.join(od, files[0]), 'utf8')).isArchived, true);

    // 另一条：写出后在 Desktop 里删了 → 不重建
    known.delete('aaaaaaaa-0000-0000-0000-000000000003');
    r = await run([a, b, c].map(rowOf));
    assert.equal(r.wrote, 1);
    const st = JSON.parse(readFileSync(stateFile, 'utf8'));
    const cItem = st.items[od + '|aaaaaaaa-0000-0000-0000-000000000003'];
    rmSync(path.join(od, cItem.local + '.json'));
    writeFileSync(c, readFileSync(c, 'utf8') + line({ type: 'user', message: { content: 'x' } }));
    r = await run([a, b, c].map(rowOf));
    assert.equal(r.wrote + r.updated, 0);
    assert.equal(existsSync(path.join(od, cItem.local + '.json')), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mirrorEnabled：只给主机本人、可用环境变量关掉', () => {
  const ctx = { kind: 'admin', dataDir: 'x' };
  assert.equal(mirrorEnabled(ctx, {}), true);
  assert.equal(mirrorEnabled(ctx, { BRIDGE_DESKTOP_MIRROR: '0' }), false);
  assert.equal(mirrorEnabled({ kind: 'user', dataDir: 'x' }, {}), false);
  assert.equal(mirrorEnabled({ ...ctx, configDir: 'y' }, {}), false);
});

test('mirrorOnce：新会话凭 init 的提示当场登记（transcript 还没落盘、Desktop 那边也不用查）', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  try {
    const od = path.join(root, 'org'); mkdirSync(od);
    const stateFile = path.join(root, 'state.json');
    const id = 'bbbbbbbb-0000-0000-0000-000000000001';
    const r = await mirrorOnce({
      files: [{ id, mtime: 0, size: 0, hint: { fresh: true, cwd: 'E:\new', model: 'claude-opus-5-5', permissionMode: 'auto', title: '帮我看看' } }],
      titleOf: async () => '', archivedOf: () => false, stateFile, orgDir: od, knownIds: new Set([id]),
    });
    assert.equal(r.wrote, 1);
    const f = readdirSync(od).find((n) => n.startsWith('local_'));
    const rec = JSON.parse(readFileSync(path.join(od, f), 'utf8'));
    assert.equal(rec.cliSessionId, id);
    assert.equal(rec.cwd, 'E:\new');
    assert.equal(rec.title, '帮我看看');
    assert.equal(rec.permissionMode, 'auto');
    assert.equal(rec.isArchived, false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('mirrorOnce：临时对话桶里的会话不登记、以前登记过的撤回；挪出桶（存为工作空间）后照常登记', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dm-'));
  try {
    const proj = path.join(root, 'proj'); mkdirSync(proj);
    const od = path.join(root, 'org'); mkdirSync(od);
    const stateFile = path.join(root, 'state.json');
    const id = 'cccccccc-0000-0000-0000-000000000001';
    const a = transcript(proj, id, 'sdk-ts');
    let quick = false;
    const run = (o = {}) => mirrorOnce({ files: [rowOf(a)], titleOf: async () => '临时', archivedOf: () => false, stateFile, orgDir: od, knownIds: new Set(), excludeCwd: () => quick, ...o });
    const locals = () => readdirSync(od).filter((n) => n.startsWith('local_'));

    // 桶里：不登记，也不记 skip
    quick = true;
    let r = await run();
    assert.equal(r.wrote, 0);
    assert.equal(locals().length, 0);
    // 新会话凭 init 提示那一路同样不登记
    r = await run({ files: [{ id, mtime: 0, size: 0, hint: { fresh: true, cwd: 'E:\q', title: '临时' } }] });
    assert.equal(r.wrote, 0);

    // 以前（旧版本）登记过的：撤回
    quick = false;
    r = await run();
    assert.equal(r.wrote, 1);
    quick = true;
    r = await run({ files: [], retract: [rowOf(a)] });
    assert.equal(r.retracted, 1);
    assert.equal(locals().length, 0);

    // Desktop 动过的那份不撤
    quick = false;
    r = await run();
    assert.equal(r.wrote, 1);
    const t = new Date(Date.now() + 5000); utimesSync(path.join(od, locals()[0]), t, t);
    r = await run({ files: [], retract: [rowOf(a)] });
    assert.equal(r.retracted, 0);
    assert.equal(locals().length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
