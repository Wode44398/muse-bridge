// 账号迁移（三端拆分 P6）的契约：路径改写（值与键、整串与正文里的、分隔符换成新系统的）、会话目录按新 cwd
// 改名、用户自己的文件一个字节不动、账号记录（密码哈希）原样搬、已有同名账号默认跳过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-migrate-'));
process.env.BRIDGE_DATA_ROOT = path.join(tmp, 'data');
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'data', 'users');

const m = await import('./users-migrate.mjs');

test('路径改写：整串 / 正文里的 / 键，盘符不分大小写，分隔符换成新系统的，别的路径不碰', () => {
  const rw = m.makeRewriter('E:\\Old Bridge Users', '/var/lib/bridge/users');
  assert.equal(rw.str('E:\\Old Bridge Users\\alice\\.bridge\\quickchat\\q1'), '/var/lib/bridge/users/alice/.bridge/quickchat/q1');
  assert.equal(rw.str('e:\\old bridge users\\alice'), '/var/lib/bridge/users/alice');
  assert.equal(rw.str('E:/Old Bridge Users/alice/a.txt'), '/var/lib/bridge/users/alice/a.txt');
  assert.equal(rw.str('已写入 E:\\Old Bridge Users\\alice\\notes\\a.md 完成'), '已写入 /var/lib/bridge/users/alice/notes/a.md 完成');
  assert.equal(rw.str('E:\\Vault\\Claude\\x'), 'E:\\Vault\\Claude\\x');
  assert.equal(rw.str('E:\\Old Bridge UsersX\\bob'), 'E:\\Old Bridge UsersX\\bob', '同前缀的别的目录不算');
  // 多行工具输出以路径开头：每个都换，别的反斜杠不动
  assert.equal(rw.str('E:\\Old Bridge Users\\alice\\a.txt\r\nE:/Old Bridge Users/alice/b.txt\r\nC:\\tmp\\x'),
    '/var/lib/bridge/users/alice/a.txt\r\n/var/lib/bridge/users/alice/b.txt\r\nC:\\tmp\\x');
  // Git Bash 写法
  assert.equal(rw.str('cd "/e/Old Bridge Users/bob/tmp" && ls'), 'cd "/var/lib/bridge/users/bob/tmp" && ls');
  assert.equal(rw.str('/home/e/Old Bridge Users/x'), '/home/e/Old Bridge Users/x', '别的目录里恰好有 /e/ 不算');
  // 单条路径的深层段带空格：整段换
  assert.equal(rw.str('E:\\Old Bridge Users\\alice\\My Docs\\x.txt'), '/var/lib/bridge/users/alice/My Docs/x.txt');
  assert.deepEqual(rw.value({ 'E:\\Old Bridge Users\\alice': { p: ['E:\\Old Bridge Users\\alice\\x'] } }),
    { '/var/lib/bridge/users/alice': { p: ['/var/lib/bridge/users/alice/x'] } });
  assert.equal(m.encodeCwd('/var/lib/bridge/users/alice'), '-var-lib-bridge-users-alice');
  assert.equal(m.encodeCwd('E:\\Old Bridge Users\\alice'), 'E--Old-Bridge-Users-alice');
});

test('jsonl：只改有路径的行，没变的行一个字节不动', () => {
  const rw = m.makeRewriter('E:\\Old Bridge Users', '/srv/users');
  const keep = '{"type":"x","a" : 1}';   // 故意不规范的空格：没路径就不该被重新序列化
  const text = keep + '\n{"cwd":"E:\\\\Old Bridge Users\\\\alice"}\nnot json\n';
  const out = m.rewriteJsonlText(text, rw).split('\n');
  assert.equal(out[0], keep);
  assert.equal(JSON.parse(out[1]).cwd, '/srv/users/alice');
  assert.equal(out[2], 'not json');
});

test('导出 → 导入：会话目录按新 cwd 改名、路径改写、用户文件原封不动、账号原样、同名默认跳过', () => {
  const host = path.join(tmp, 'host', 'users');
  const hostSys = path.join(host, '_system');
  const A = path.join(host, 'alice');
  const q = path.join(A, '.bridge', 'quickchat', 'q1');
  const proj = path.join(A, '.bridge', 'claude', 'projects');
  mkdirSync(path.join(proj, m.encodeCwd(A)), { recursive: true });
  mkdirSync(path.join(proj, m.encodeCwd(q)), { recursive: true });
  mkdirSync(q, { recursive: true });
  mkdirSync(path.join(A, '.bridge', 'uploads'), { recursive: true });
  mkdirSync(hostSys, { recursive: true });
  const line = (o) => JSON.stringify(o);
  writeFileSync(path.join(proj, m.encodeCwd(A), 's1.jsonl'), [
    line({ type: 'user', cwd: A, message: { content: '看看 ' + path.join(A, 'notes.md') } }),
    line({ type: 'assistant', cwd: path.join(A, 'sub'), toolUse: { file_path: path.join(A, 'notes.md') } }),
  ].join('\n') + '\n');
  writeFileSync(path.join(proj, m.encodeCwd(q), 's2.jsonl'), line({ type: 'user', cwd: q }) + '\n');
  writeFileSync(path.join(A, '.bridge', 'claude-projects.json'), JSON.stringify({ projects: [{ id: 'p1', name: '工作空间', path: A }] }));
  writeFileSync(path.join(A, '.bridge', 'claude-quick.json'), JSON.stringify({ id: 'q1', path: q }));
  const userFile = '用户自己的笔记，里面恰好提到 ' + A + '\n';
  writeFileSync(path.join(A, 'notes.md'), userFile);
  writeFileSync(path.join(A, '.bridge', 'uploads', 'x.json'), JSON.stringify({ p: A }));
  writeFileSync(path.join(q, 'result.json'), JSON.stringify({ p: A }));
  const rec = { name: 'alice', salt: 's', hash: 'h', created: 1, disabled: false, tier: 'pro', agents: ['claude'], snapshot: true };
  writeFileSync(path.join(hostSys, 'users.json'), JSON.stringify({ alice: rec }));
  writeFileSync(path.join(hostSys, 'usage.json'), JSON.stringify({ alice: { tokens: 5, calls: 1, costUsd: 0.1 } }));

  const out = path.join(tmp, 'export');
  const man = m.exportUsers({ usersRoot: host, systemDir: hostSys, out, log: () => {} });
  assert.equal(man.users.length, 1);
  assert.ok(existsSync(path.join(out, m.MANIFEST)));

  const srv = path.join(tmp, 'server', 'users');
  const srvSys = path.join(srv, '_system');
  const done = m.importUsers({ usersRoot: srv, systemDir: srvSys, from: out, log: () => {} });
  assert.deepEqual(done, ['alice']);
  const B = path.join(srv, 'alice');
  const bProj = path.join(B, '.bridge', 'claude', 'projects');
  const names = readdirSync(bProj).sort();
  assert.deepEqual(names, [m.encodeCwd(B), m.encodeCwd(path.join(B, '.bridge', 'quickchat', 'q1'))].sort(), '会话目录按新 cwd 改了名');
  const s1 = readFileSync(path.join(bProj, m.encodeCwd(B), 's1.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(s1[0].cwd, B);
  assert.equal(s1[1].cwd, path.join(B, 'sub'));
  assert.equal(s1[1].toolUse.file_path, path.join(B, 'notes.md'));
  assert.equal(s1[0].message.content, '看看 ' + path.join(B, 'notes.md'), '正文里的路径也换了');
  assert.equal(JSON.parse(readFileSync(path.join(B, '.bridge', 'claude-projects.json'), 'utf8')).projects[0].path, B);
  assert.equal(JSON.parse(readFileSync(path.join(B, '.bridge', 'claude-quick.json'), 'utf8')).path, path.join(B, '.bridge', 'quickchat', 'q1'));
  assert.equal(readFileSync(path.join(B, 'notes.md'), 'utf8'), userFile, '用户文件一个字节不动');
  assert.equal(JSON.parse(readFileSync(path.join(B, '.bridge', 'uploads', 'x.json'), 'utf8')).p, A, '上传里的不动');
  assert.equal(JSON.parse(readFileSync(path.join(B, '.bridge', 'quickchat', 'q1', 'result.json'), 'utf8')).p, A, '快照桶里 Claude 写的文件不动');
  const users = JSON.parse(readFileSync(path.join(srvSys, 'users.json'), 'utf8'));
  assert.equal(users.alice.hash, 'h');
  assert.deepEqual(users.alice.agents, ['claude']);
  assert.equal(JSON.parse(readFileSync(path.join(srvSys, 'usage.json'), 'utf8')).alice.tokens, 5);

  assert.deepEqual(m.importUsers({ usersRoot: srv, systemDir: srvSys, from: out, log: () => {} }), [], '已有同名账号默认跳过');
});
