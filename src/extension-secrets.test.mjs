// S3（#36、X02）+ G10 回归：连接器凭据不进注册表、不出服务端；注册表坏了看得见、不被覆盖。
//
// 修前：saveConnector 把 env / headers 明文写进 extensions/registry.json，GET /api/extensions 把它们原样发给前端
// （编辑表单还整段回填）；注册表坏了 readJson 静默给空表——列表一片空白，下一次保存把整张表覆盖成只剩那一项。
// 全部是临时数据根 + 带 FAKE 字样的假令牌，不碰真实扩展中心。
import test, { after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = mkdtempSync(path.join(os.tmpdir(), 'ext-secrets-'));
process.env.BRIDGE_DATA_ROOT = root;
const ext = await import('./extensions.mjs');
const extRoot = path.join(root, 'extensions');
const registry = path.join(extRoot, 'registry.json');
const TOKEN = 'ghp_FAKE_TOKEN_0000000000000000000000';
const BEARER = 'Bearer FAKE_GATEWAY_KEY_1111111111111111';

beforeEach(() => rmSync(extRoot, { recursive: true, force: true }));
after(() => rmSync(root, { recursive: true, force: true }));

const onDisk = () => (existsSync(extRoot) ? ['registry.json', 'connector-secrets.json', 'connector-secrets.key']
  .filter((f) => existsSync(path.join(extRoot, f)))
  .map((f) => readFileSync(path.join(extRoot, f), 'utf8')).join('\n') : '');

test('S3: a connector token never lands in registry.json or the API response; the agents still get it', () => {
  const saved = ext.saveConnector({ name: 'github', transport: 'stdio', command: 'npx', args: ['-y', 'server-github'], env: { GITHUB_TOKEN: TOKEN, LOG_LEVEL: 'debug' } });
  const http = ext.saveConnector({ name: 'gw', transport: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: BEARER } });

  assert.ok(!onDisk().includes('FAKE'), '盘上三个文件里都没有明文');
  const reg = JSON.parse(readFileSync(registry, 'utf8'));
  assert.deepEqual(reg.items.find((x) => x.id === saved.id).connector.envKeys, ['GITHUB_TOKEN', 'LOG_LEVEL'], '注册表只记键名');

  const api = JSON.stringify({ list: ext.listExtensions(), one: ext.getExtension(saved.id), saved, http });
  assert.ok(!api.includes('FAKE'), '对外的样子里没有明文');
  assert.deepEqual(ext.listExtensions().find((x) => x.id === saved.id).connector.env, { GITHUB_TOKEN: ext.SECRET_MASK, LOG_LEVEL: ext.SECRET_MASK });

  const claude = ext.claudeExtensionOptions().mcpServers;
  assert.equal(claude.github.env.GITHUB_TOKEN, TOKEN, 'Claude 拿到的是真值');
  assert.equal(claude.gw.headers.Authorization, BEARER);
});

test('S3: editing — the mask keeps a value, a new value replaces it, a dropped line deletes it; uninstall drops the secrets', () => {
  const c = ext.saveConnector({ name: 'github', transport: 'stdio', command: 'npx', env: { GITHUB_TOKEN: TOKEN, OLD: 'FAKE_OLD' } });
  ext.saveConnector({ id: c.id, name: 'github', transport: 'stdio', command: 'npx', env: { GITHUB_TOKEN: ext.SECRET_MASK, NEW: 'FAKE_NEW' } });
  assert.deepEqual(ext.claudeExtensionOptions().mcpServers.github.env, { GITHUB_TOKEN: TOKEN, NEW: 'FAKE_NEW' });
  ext.saveConnector({ id: c.id, name: 'github', transport: 'stdio', command: 'npx', env: { GITHUB_TOKEN: 'ghp_FAKE_ROTATED' } });
  assert.deepEqual(ext.claudeExtensionOptions().mcpServers.github.env, { GITHUB_TOKEN: 'ghp_FAKE_ROTATED' });
  // 打码占位符只能沿用旧值，造不出新键
  ext.saveConnector({ id: c.id, name: 'github', transport: 'stdio', command: 'npx', env: { GITHUB_TOKEN: ext.SECRET_MASK, GHOST: ext.SECRET_MASK } });
  assert.deepEqual(ext.claudeExtensionOptions().mcpServers.github.env, { GITHUB_TOKEN: 'ghp_FAKE_ROTATED' });

  assert.equal(ext.deleteExtension(c.id), true);
  assert.ok(!onDisk().includes('FAKE'));
  const again = ext.saveConnector({ name: 'other', transport: 'stdio', command: 'x' });
  assert.equal(ext.claudeExtensionOptions().mcpServers.other.env, undefined, '没有凭据的连接器照常');
  assert.deepEqual(ext.extensionDiagnostics(), [], again.id);
});

test('S3: an old registry with plaintext credentials is migrated the first time it is read; injection keeps working', () => {
  mkdirSync(extRoot, { recursive: true });
  writeFileSync(registry, JSON.stringify({ items: [
    { id: 'legacy1', type: 'connector', name: 'gw', enabled: true, agents: { claude: true },
      connector: { transport: 'http', url: 'https://example.invalid/mcp', headers: { Authorization: BEARER }, key: 'gw' } },
  ] }));
  assert.ok(onDisk().includes('FAKE'), '修前的样子：明文在注册表里');
  assert.equal(ext.claudeExtensionOptions().mcpServers.gw.headers.Authorization, BEARER);
  assert.ok(!onDisk().includes('FAKE'), '读一次就挪进了加密存储');
  assert.deepEqual(JSON.parse(readFileSync(registry, 'utf8')).items[0].connector.headerKeys, ['Authorization']);
  assert.equal(ext.claudeExtensionOptions().mcpServers.gw.headers.Authorization, BEARER, '挪完照样能用');
});

test('G10: a corrupt registry is reported and never overwritten; writes are refused until it is fixed', () => {
  mkdirSync(extRoot, { recursive: true });
  const broken = '{"items": [ {"id": "a", "type": "skill", "name": "x" ';
  writeFileSync(registry, broken);
  assert.deepEqual(ext.listExtensions(), []);
  const diag = ext.extensionDiagnostics();
  assert.equal(diag[0]?.level, 'error');
  assert.match(diag[0].msg, /registry\.json 解析失败/);
  assert.throws(() => ext.saveConnector({ name: 'n', transport: 'stdio', command: 'x' }), (e) => e.status === 409);
  assert.throws(() => ext.updateExtension('a', { enabled: false }), (e) => e.status === 409);
  assert.equal(readFileSync(registry, 'utf8'), broken, '坏文件一个字节没动');
});

test('G10: a skill whose SKILL.md is gone and credentials that cannot be decrypted show up in the diagnostics', () => {
  mkdirSync(path.join(extRoot, 'skills', 'gone'), { recursive: true });
  writeFileSync(registry, JSON.stringify({ items: [
    { id: 's1', type: 'skill', name: 'gone', enabled: true, agents: { claude: true }, dir: 'skills/gone', entry: 'SKILL.md' },
  ] }));
  ext.saveConnector({ name: 'github', transport: 'stdio', command: 'npx', env: { GITHUB_TOKEN: TOKEN } });
  // 换了一把对不上的密钥（相当于换了 Windows 账户 / 机器）
  writeFileSync(path.join(extRoot, 'connector-secrets.key'), JSON.stringify({ v: 1, scheme: 'file', key: Buffer.alloc(32, 7).toString('base64') }));
  const msgs = ext.extensionDiagnostics().map((d) => `${d.level}:${d.msg}`).join('\n');
  assert.match(msgs, /warn:技能「gone」的 SKILL\.md 不在了/);
  assert.match(msgs, /error:连接器凭据解不开/);
  assert.match(msgs, /github/);
  assert.equal(ext.claudeExtensionOptions().mcpServers.github.env, undefined, '解不开就不带凭据注入，不拖垮整轮');
});
