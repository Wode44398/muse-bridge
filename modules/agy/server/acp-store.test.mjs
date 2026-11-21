import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('会话存储判定：只在桌面版目录里的会话走桌面版存储进程，其余（含新会话、非 uuid）走主进程', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'agy-store-'));
  const prevHome = process.env.AGY_HOME_DIR;
  const prevApp = process.env.AGY_APP_DATA_DIR;
  process.env.AGY_HOME_DIR = home;
  delete process.env.AGY_APP_DATA_DIR;
  try {
    const cli = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
    const desk = path.join(home, '.gemini', 'antigravity', 'conversations');
    mkdirSync(cli, { recursive: true });
    mkdirSync(desk, { recursive: true });
    writeFileSync(path.join(cli, '11111111-aaaa.db'), '');
    writeFileSync(path.join(desk, '22222222-bbbb.db'), '');
    writeFileSync(path.join(cli, '33333333-cccc.pb'), '');
    writeFileSync(path.join(desk, '33333333-cccc.db'), '');

    const { agySessionStore } = await import('./acp/binary.mjs');
    assert.equal(agySessionStore('11111111-aaaa'), 'cli');
    assert.equal(agySessionStore('22222222-bbbb'), 'desktop');
    assert.equal(agySessionStore('33333333-cccc'), 'cli', '两边都有时以 CLI 存储为准');
    assert.equal(agySessionStore('44444444-dddd'), 'cli');
    assert.equal(agySessionStore('../antigravity/conversations/22222222-bbbb'), 'cli');

    const idx = await import('./acp/index.mjs');
    const fakeDesktop = { shutdown() {}, turns: new Map() };
    idx.setDesktopClientForTest(fakeDesktop, (id) => (id === 'desk' ? 'desktop' : 'cli'));
    assert.equal(idx.getAcpClientFor('desk'), fakeDesktop);
    assert.equal(idx.getAcpClientFor('other'), idx.getAcpClient());
    assert.equal(idx.getAcpClientFor(''), idx.getAcpClient());
    assert.deepEqual(idx.allAcpClients(), [idx.getAcpClient(), fakeDesktop]);
    idx.setDesktopClientForTest(null, null);
    assert.deepEqual(idx.allAcpClients(), [idx.getAcpClient()]);
  } finally {
    if (prevHome === undefined) delete process.env.AGY_HOME_DIR; else process.env.AGY_HOME_DIR = prevHome;
    if (prevApp !== undefined) process.env.AGY_APP_DATA_DIR = prevApp;
    rmSync(home, { recursive: true, force: true });
  }
});

test('启动前修复：.pb 有内容而 .db 是 0 步的空库时把 .db（连同 -wal）挪进备份；.db 有步骤或没有 .pb 时不动', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { existsSync: ex, readdirSync: ls } = await import('node:fs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'agy-shadow-'));
  try {
    const conv = path.join(dir, 'conversations');
    mkdirSync(conv, { recursive: true });
    const mk = (id, steps) => {
      const db = new DatabaseSync(path.join(conv, id + '.db'));
      db.exec('CREATE TABLE steps (idx INTEGER)');
      for (let i = 0; i < steps; i++) db.exec(`INSERT INTO steps VALUES (${i})`);
      db.close();
    };
    mk('aaaa1111-empty', 0); writeFileSync(path.join(conv, 'aaaa1111-empty.pb'), 'x'.repeat(50));
    writeFileSync(path.join(conv, 'aaaa1111-empty.db-wal'), '');
    mk('bbbb2222-full', 3); writeFileSync(path.join(conv, 'bbbb2222-full.pb'), 'x'.repeat(50));
    mk('cccc3333-nopb', 0);
    mk('dddd4444-emptypb', 0); writeFileSync(path.join(conv, 'dddd4444-emptypb.pb'), '');

    const { repairShadowedConversations } = await import('./acp/binary.mjs');
    assert.deepEqual(repairShadowedConversations(dir), ['aaaa1111-empty']);
    assert.equal(ex(path.join(conv, 'aaaa1111-empty.db')), false);
    assert.equal(ex(path.join(conv, 'aaaa1111-empty.db-wal')), false);
    assert.equal(ex(path.join(conv, 'aaaa1111-empty.pb')), true);
    assert.equal(ls(path.join(dir, 'conversations-empty-db')).length, 2);
    for (const id of ['bbbb2222-full', 'cccc3333-nopb', 'dddd4444-emptypb']) assert.equal(ex(path.join(conv, id + '.db')), true, id);
    assert.deepEqual(repairShadowedConversations(dir), [], '幂等');
    assert.deepEqual(repairShadowedConversations(path.join(dir, 'missing')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
