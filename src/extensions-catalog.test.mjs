// 「自定义 → 发现」目录源（extensions-catalog.mjs）与插件配置（extensions.mjs）：
// ① 本地源列出插件并拆出技能与连接器，远程源（url / git-subdir）也列（标 remote），越界 / 不存在的目录不列；
// ② 连接器里的 ${VAR} 是添加时要填的字段（${VAR:-默认} 选填），${CLAUDE_PLUGIN_ROOT} 的要随插件装、不单列；
// ③ 从目录装：插件 / 技能 / 连接器都进注册表，strict:false 的插件补出 plugin.json，重复装报 409；
// ④ 插件配置：userConfig + MCP 的 ${VAR} 成表单，敏感值进加密存储，插件 MCP 由宿主解析后注入（缺必填的那条不带）。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ext-catalog-'));
process.env.BRIDGE_DATA_ROOT = path.join(tmp, 'data');
delete process.env.SECRET_TOKEN; delete process.env.OPTIONAL_KEY;
const root = path.join(tmp, 'markets');
const mk = (rel, text) => { const f = path.join(root, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
const skill = (name) => `---\nname: ${name}\ndescription: ${name} 的说明\n---\n正文\n`;

mk('official/.claude-plugin/marketplace.json', JSON.stringify({
  name: 'official', owner: { name: 'Anthropic' },
  plugins: [
    { name: 'alpha', description: 'Alpha 插件', category: 'productivity', author: { name: 'Anthropic' }, source: './plugins/alpha', skills: ['./extra/two', '../../../outside'] },
    { name: 'lsp', description: '语言服务', source: './plugins/lsp', strict: false, lspServers: { x: { command: 'x-lsp' } } },
    { name: 'remote', description: '远程源', source: { source: 'url', url: 'https://example.com/r.git', sha: 'abcdef1' } },
    { name: 'subdir', description: '子目录源', source: { source: 'git-subdir', url: 'https://example.com/m.git', path: 'plugins/s', ref: 'v1' } },
    { name: 'insecure', description: '非 https 远程源', source: { source: 'url', url: 'http://example.com/r.git' } },
    { name: 'escape', description: '越界', source: '../../elsewhere' },
    { name: 'ghost', description: '目录不存在', source: './plugins/ghost' },
  ],
}));
mk('official/plugins/alpha/.claude-plugin/plugin.json', JSON.stringify({
  name: 'alpha', description: 'Alpha 插件',
  userConfig: {
    region: { type: 'string', title: '区域', default: 'us', options: ['us', 'eu'] },
    apiKey: { type: 'string', title: 'API Key', sensitive: true, required: true },
  },
}));
mk('official/plugins/alpha/skills/one/SKILL.md', skill('alpha-one'));
mk('official/plugins/alpha/skills/nomd/readme.txt', 'no skill here');
mk('official/plugins/alpha/extra/two/SKILL.md', skill('alpha-two'));
mk('official/plugins/alpha/commands/go.md', '# go');
mk('official/plugins/alpha/.mcp.json', JSON.stringify({ mcpServers: {
  plain: { command: 'npx', args: ['-y', 'plain-mcp'] },
  remote: { type: 'http', url: 'https://mcp.example.com/mcp', headers: { Authorization: '${OPTIONAL_KEY:-}' } },
  token: { type: 'http', url: 'https://mcp.example.com/x', headers: { Authorization: 'Bearer ${SECRET_TOKEN}' } },
  bundled: { command: 'bun', args: ['run', '--cwd', '${CLAUDE_PLUGIN_ROOT}'], env: { KEY: '${user_config.apiKey}', R: '${user_config.region}' } },
} }));
mk('official/plugins/lsp/README.md', 'lsp');

const { listCatalog, installFromCatalog } = await import('./extensions-catalog.mjs');
const { listExtensions, getExtension, configureExtension, claudeExtensionOptions, EXT_ROOT, SECRET_MASK } = await import('./extensions.mjs');
const O = { root, only: ['official'] };

test.after(() => rmSync(tmp, { recursive: true, force: true }));

test('本地源拆出技能与连接器，远程源也列，越界 / 不存在 / 非 https 不列', () => {
  const { items, markets } = listCatalog(O);
  const ids = items.map((x) => x.id).sort();
  assert.deepEqual(ids, [
    'official/alpha', 'official/alpha/mcp/plain', 'official/alpha/mcp/remote', 'official/alpha/mcp/token',
    'official/alpha/skill/extra/two', 'official/alpha/skill/skills/one', 'official/lsp', 'official/remote', 'official/subdir',
  ]);
  assert.deepEqual(markets, [{ name: 'official', label: 'Anthropic', count: 9 }]);
  const remote = items.find((x) => x.id === 'official/remote');
  assert.equal(remote.remote, true);
  assert.equal(remote.repo, 'example.com/r');
  const tok = items.find((x) => x.id === 'official/alpha/mcp/token');
  assert.deepEqual(tok.fields.map((f) => [f.key, f.required, f.sensitive]), [['SECRET_TOKEN', true, true]]);
  assert.equal(items.find((x) => x.id === 'official/alpha/mcp/remote').fields[0].required, false);
  assert.equal(items.find((x) => x.id === 'official/alpha').configurable, true);
  assert.ok(items.every((x) => !('_dir' in x) && !('_tpl' in x) && !('_entry' in x) && !('_remote' in x)), '内部字段不外泄');
  assert.ok(items.every((x) => x.installed === false));
});

test('从目录装：插件 / 技能 / 连接器进注册表，缺字段 400，重复装 409', async () => {
  const p = await installFromCatalog('official/alpha', O);
  assert.equal(p.type, 'plugin');
  assert.equal(p.source, 'Anthropic · alpha');
  const s = await installFromCatalog('official/alpha/skill/skills/one', O);
  assert.equal(s.type, 'skill');
  assert.ok(existsSync(path.join(EXT_ROOT, s.dir, 'SKILL.md')));
  const c = await installFromCatalog('official/alpha/mcp/remote', O);
  assert.equal(c.connector.transport, 'http');
  assert.deepEqual(c.connector.headers, {}, '解成空串的头不带');
  await assert.rejects(installFromCatalog('official/alpha/mcp/token', O), (e) => e.status === 400 && /SECRET_TOKEN/.test(e.message));
  const t = await installFromCatalog('official/alpha/mcp/token', { ...O, values: { SECRET_TOKEN: 'abc' } });
  assert.deepEqual(t.connector.headers, { Authorization: SECRET_MASK }, '凭据进加密存储、对外打码');
  const lsp = await installFromCatalog('official/lsp', O);
  const manifest = JSON.parse(readFileSync(path.join(EXT_ROOT, lsp.dir, '.claude-plugin', 'plugin.json'), 'utf8'));
  assert.deepEqual(manifest.lspServers, { x: { command: 'x-lsp' } }, 'strict:false 条目补出 plugin.json');
  assert.equal(manifest.strict, undefined);
  assert.equal(listExtensions().length, 5);
  assert.equal(listCatalog(O).items.find((x) => x.id === 'official/alpha').installed, true);
  await assert.rejects(installFromCatalog('official/alpha', O), (e) => e.status === 409);
  await assert.rejects(installFromCatalog('official/escape', O), (e) => e.status === 404);
});

test('插件配置：表单字段、内容清单、敏感值打码、MCP 由宿主解析注入', () => {
  const p = listExtensions().find((x) => x.type === 'plugin' && x.name === 'alpha');
  assert.deepEqual(p.config.fields.map((f) => f.key), ['region', 'apiKey', 'OPTIONAL_KEY', 'SECRET_TOKEN']);
  assert.deepEqual(p.config.missing, ['apiKey', 'SECRET_TOKEN']);
  assert.deepEqual(p.contents.skills, ['one', 'two']);
  assert.deepEqual(p.contents.commands, ['go']);
  assert.deepEqual(p.contents.mcp, ['bundled', 'plain', 'remote', 'token']);

  let ext = claudeExtensionOptions();
  assert.ok(ext.plugins.every((x) => x.skipMcpDiscovery), '插件 MCP 一律由宿主接管');
  assert.ok(ext.mcpServers.plain, '不用配置的那条直接带');
  assert.equal(ext.mcpServers.token.headers.Authorization, 'Bearer abc', '单装的连接器（同名 token）在');
  assert.equal(ext.mcpServers['alpha-token'], undefined, '插件里缺令牌的那条不带');
  assert.equal(ext.mcpServers.bundled, undefined, '缺 apiKey 的那条不带');

  const after = configureExtension(p.id, { apiKey: 'k-1', region: 'eu', SECRET_TOKEN: 's-2' });
  assert.equal(after.config.values.apiKey, SECRET_MASK);
  assert.equal(after.config.values.region, 'eu');
  assert.deepEqual(after.config.missing, []);
  assert.ok(!readFileSync(path.join(EXT_ROOT, 'registry.json'), 'utf8').includes('k-1'), '敏感值不进注册表');

  ext = claudeExtensionOptions();
  const b = ext.mcpServers.bundled;
  assert.ok(b.args.includes(path.join(EXT_ROOT, 'plugins', 'alpha')), '${CLAUDE_PLUGIN_ROOT} 换成插件目录');
  assert.equal(b.env.KEY, 'k-1');
  assert.equal(b.env.R, 'eu');
  assert.equal(b.env.CLAUDE_PLUGIN_OPTION_APIKEY, 'k-1', 'userConfig 以 CLAUDE_PLUGIN_OPTION_* 交给 stdio server');
  assert.equal(ext.mcpServers['alpha-token'].headers.Authorization, 'Bearer s-2', '与单装连接器撞名就加插件前缀');

  configureExtension(p.id, { apiKey: SECRET_MASK, region: '' });
  const kept = getExtension(p.id);
  assert.equal(kept.config.values.apiKey, SECRET_MASK, '打码占位符 = 沿用旧值');
  assert.equal(kept.config.values.region, undefined, '空串 = 清掉，回到默认');
  assert.equal(claudeExtensionOptions().mcpServers.bundled.env.R, 'us');
});

test('默认只列 Anthropic 官方目录：其它目录（账号级共享库）不掺进来', () => {
  assert.equal(listCatalog({ root }).items.length, 0, '测试目录不叫 claude-plugins-official，默认一条都不列');
});

test('下载官方目录：浅克隆进 claude-plugins-official、换掉旧副本、去掉 .git；坏仓库不碰旧副本', async () => {
  const { execFileSync } = await import('node:child_process');
  const { fetchOfficialCatalog } = await import('./extensions-catalog.mjs');
  const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, windowsHide: true });
  const repo = path.join(tmp, 'repo');
  const market = (rel, text) => { const f = path.join(repo, rel); mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, text); };
  market('.claude-plugin/marketplace.json', JSON.stringify({ name: 'claude-plugins-official', owner: { name: 'Anthropic' }, plugins: [{ name: 'beta', description: 'Beta', source: './plugins/beta' }] }));
  market('plugins/beta/.claude-plugin/plugin.json', JSON.stringify({ name: 'beta' }));
  git(repo, 'init', '-q'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'x');

  const froot = path.join(tmp, 'fetched');
  mkdirSync(path.join(froot, 'claude-plugins-official'), { recursive: true });
  writeFileSync(path.join(froot, 'claude-plugins-official', 'stale.txt'), 'old');
  const r = await fetchOfficialCatalog({ root: froot, repo });
  assert.deepEqual(r.items.map((x) => x.id), ['claude-plugins-official/beta']);
  assert.ok(!existsSync(path.join(froot, 'claude-plugins-official', 'stale.txt')), '旧副本被换掉');
  assert.ok(!existsSync(path.join(froot, 'claude-plugins-official', '.git')));

  await assert.rejects(fetchOfficialCatalog({ root: froot, repo: path.join(tmp, 'nope') }), (e) => e.status === 502);
  assert.equal(listCatalog({ root: froot }).items.length, 1, '失败时旧副本还在');
});
