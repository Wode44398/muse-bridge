// 服务端形态的契约：agent 开关、按人授权、快照权限、登录令牌落盘存哈希、Linux 路径守卫。
// 数据根改道到临时目录：别让测试碰到仓库里的 config.json / 账号库。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-editions-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');

const { contextFor, agentsFor } = await import('./runtime/identity.mjs');
const { enabledAgents, setAgentSwitch, agentSwitches, agentStatusList } = await import('./runtime/agent-status.mjs');
const users = await import('./users.mjs');
const { SYSTEM_DIR } = await import('./config/index.mjs');
const { withinDir, absPathViolation, sandboxViolation } = await import('./agents/claude.mjs');

test('注册用户：没设过名单 = 默认只有 Claude；显式名单照名单；空名单什么都没有', () => {
  const on = enabledAgents();
  const legacy = contextFor({ kind: 'user', user: 'a', tier: 'pro' });
  assert.deepEqual(legacy.agents, on.filter((id) => id === 'claude'));
  assert.equal(legacy.allowDimensio, false);
  const both = contextFor({ kind: 'user', user: 'b', tier: 'pro', agents: ['claude', 'dimensio'] });
  assert.deepEqual(both.agents, on.filter((id) => id === 'claude' || id === 'dimensio'));
  const none = contextFor({ kind: 'user', user: 'c', tier: 'pro', agents: [] });
  assert.deepEqual(none.agents, []);
  assert.equal(none.allowClaude, false);
});

test('全局开关关掉一个 agent：管理员和用户都立刻拿不到', () => {
  const before = agentSwitches();
  try {
    setAgentSwitch('claude', false);
    assert.equal(enabledAgents().includes('claude'), false);
    assert.equal(contextFor({ kind: 'admin' }).allowClaude, false);
    assert.equal(contextFor({ kind: 'user', user: 'a', tier: 'pro' }).allowClaude, false);
    // 落盘只改 agents 这一个键
    const cfg = JSON.parse(readFileSync(path.join(tmp, 'config.json'), 'utf8'));
    assert.equal(cfg.agents.claude, false);
    assert.ok(cfg.token, '其它键原样保留');
    assert.equal(agentStatusList().find((a) => a.id === 'claude').enabled, false);
  } finally {
    setAgentSwitch('claude', before.claude !== false);
  }
  assert.equal(enabledAgents().includes('claude'), true);
});

test('快照身份只有 Claude，只读分享什么都没有', () => {
  assert.deepEqual(agentsFor({ kind: 'share' }), []);
  assert.deepEqual(agentsFor({ kind: 'snap' }), enabledAgents().filter((id) => id === 'claude'));
});

test('铸快照权限：管理员有；老账号（没写）保留；显式关掉就没有', () => {
  assert.equal(contextFor({ kind: 'admin' }).canSnapshot, true);
  assert.equal(contextFor({ kind: 'user', user: 'a', tier: 'pro' }).canSnapshot, true);
  assert.equal(contextFor({ kind: 'user', user: 'a', tier: 'pro', snapshot: false }).canSnapshot, false);
});

test('新账号写显式默认：名单 = 只有 Claude、不能铸快照；管理员可改', async () => {
  const r = await users.createUser('newbie', 'password123', 'user');
  assert.ok(r.ok);
  const g = users.userGrants(users.getUser('newbie'));
  assert.deepEqual(g.agents, ['claude']);
  assert.equal(g.snapshot, false);
  assert.equal(g.service, false);
  users.setAgents('newbie', ['claude', 'bogus', 'claude']);
  assert.deepEqual(users.userGrants(users.getUser('newbie')).agents, ['claude']);
  users.setService('newbie', true);
  assert.equal(users.userGrants(users.getUser('newbie')).service, true);
});

test('登录令牌落盘只存哈希；旧明文键第一次读就迁移、照常能用', async () => {
  await users.createUser('alice', 'password123', 'pro');
  const tok = users.createSession('alice');
  const file = path.join(SYSTEM_DIR, 'sessions.json');
  const raw = readFileSync(file, 'utf8');
  assert.equal(raw.includes(tok), false, '明文令牌不该出现在 sessions.json 里');
  assert.equal(users.getSession(tok).user, 'alice');
  // 旧格式：键就是明文令牌。经 users 自己的写入口让热缓存失效（直接改文件要等 5 秒缓存过期）。
  const legacyTok = 'legacyTokenAbcdefghijklmnopqrstuv';
  const s = JSON.parse(readFileSync(file, 'utf8'));
  s[legacyTok] = { user: 'alice', created: Date.now() };
  writeFileSync(file, JSON.stringify(s));
  const other = users.createSession('alice');
  assert.equal(users.getSession(legacyTok)?.user, 'alice', '迁移前的明文键照常能认');
  users.migrateSessionKeys();
  assert.equal(readFileSync(file, 'utf8').includes(legacyTok), false, '迁移后文件里没有明文键');
  assert.equal(users.getSession(legacyTok)?.user, 'alice', '迁移后照常能认');
  users.deleteSession(legacyTok);
  assert.equal(users.getSession(legacyTok), null);
  users.deleteSession(tok);
  users.deleteSession(other);
  assert.equal(users.getSession(tok), null);
});

test('Linux 上文件工具的绝对路径是真绝对路径（以前被当成 cwd 相对路径放行）', () => {
  const cwd = '/data/users/bob';
  assert.equal(withinDir(cwd, '/data/config.json', 'linux'), false);
  assert.equal(withinDir(cwd, '/etc/passwd', 'linux'), false);
  assert.equal(withinDir(cwd, '/data/users/bob/notes.md', 'linux'), true);
  assert.equal(withinDir(cwd, 'notes.md', 'linux'), true);
  assert.equal(withinDir(cwd, '/data/users/bobby/x', 'linux'), false, '同前缀的邻居目录不算');
  assert.match(sandboxViolation('Read', { file_path: '/data/users/_system/sessions.json' }, cwd, 'linux') || '', /私有空间之外/);
  // Windows 维持「SDK 虚拟根」语义：/mine.txt 就是工作区里的 mine.txt
  assert.equal(withinDir('C:\\ws\\bob', '/mine.txt', 'win32'), true);
});

test('Linux 命令守卫：敏感目录的绝对路径拒，自己目录与系统工具放行，正则不误伤', () => {
  const cwd = '/data/users/bob';
  const roots = ['/data', '/app', '/home', '/root', '/proc'];
  const v = (cmd) => absPathViolation(cmd, cwd, { platform: 'linux', roots });
  assert.ok(v('cat /data/config.json'));
  assert.ok(v('cat /data/users/_system/sessions.json'));
  assert.ok(v('ls /data/users/alice'));
  assert.ok(v('cat /proc/1/environ'));
  assert.ok(v('grep -r token /home'));
  assert.equal(v('cat /data/users/bob/a.txt'), null);
  assert.equal(v('python3 /usr/bin/x.py > /dev/null'), null);
  assert.equal(v("awk '/^foo/ {print}' a.txt"), null);
  assert.equal(v("sed -n '/a/,/b/p' f"), null);
  assert.equal(v('ls /'), null);
});

test('Windows 命令守卫：Git Bash 的 /x/… 写法按盘符规则判', () => {
  const cwd = 'E:\\Users\\bob';
  const v = (cmd) => absPathViolation(cmd, cwd, { platform: 'win32', roots: [] });
  assert.ok(v('cat /e/Users/_system/sessions.json'));
  assert.ok(v('ls /c/Users'));
  assert.equal(v('cat /e/Users/bob/a.txt'), null);
  assert.equal(v("grep '/api/chat' x.js"), null);
});
