// config.json 的 anthropicApiKey（安装向导 / 手改）注入成 ANTHROPIC_API_KEY 的边界。
// Claude Code 非交互模式下有 ANTHROPIC_API_KEY 就整个关掉 OAuth：注入了就等于号池里的订阅号全不生效、改走按量。
// 所以只在号池没有令牌、也没有 CLAUDE_CODE_OAUTH_TOKEN / 环境变量 key 时注入；运行中加了号，CLI 的 env 里不再带它。
// 没注入 / 不再用时 apiKeyMode 报 config-unused（不静默）；桌面安装包经环境变量交来向导里选的 key 报 desktop，照样盖过号池。
// 每种情形起一个子进程（配置在导入时读），数据根在临时目录。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const url = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-apikey-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

let n = 0;
function run(cfg, { env = {}, body = '' } = {}) {
  const root = path.join(tmp, 'd' + (++n));
  mkdirSync(path.join(root, 'ws'), { recursive: true });
  writeFileSync(path.join(root, 'config.json'), JSON.stringify({ token: 't'.repeat(24), vaultPath: path.join(root, 'ws'), ...cfg }));
  const script = `
    const c = await import(${url('config/index.mjs')});
    const a = await import(${url('runtime/claude-account.mjs')});
    const out = { fromConfig: c.API_KEY_FROM_CONFIG, key: process.env.ANTHROPIC_API_KEY || '', mode: a.apiKeyMode() };
    ${body}
    console.log('@@' + JSON.stringify(out));`;
  // CLAUDE_CONFIG_DIR 指到空目录：本机 claude login 的凭据会影响「加号自动激活」（claude-account.addAccount），结果不随机器变
  const childEnv = { ...process.env, BRIDGE_DATA_ROOT: root, BRIDGE_CLAUDE_IN_CHROME: '0', CLAUDE_CONFIG_DIR: path.join(root, 'claude-cfg'), ...env };
  for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'BRIDGE_SUPERVISED']) if (!(k in env)) delete childEnv[k];
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: childEnv, encoding: 'utf8' });
  return JSON.parse(stdout.split('@@').pop());
}

test('号池没有令牌：config 里的 key 注入成 ANTHROPIC_API_KEY；之后加了号，CLI 的 env 里不再带它', () => {
  const r = run({ anthropicApiKey: ' sk-ant-api03-CFG ' }, {
    body: `
      out.envBefore = (a.claudeEngineEnv(null) || process.env).ANTHROPIC_API_KEY || '';
      a.addAccount({ label: 'X', token: 'sk-ant-oat01-NEW' });
      const e = a.claudeEngineEnv(null);
      out.after = { key: e.ANTHROPIC_API_KEY || '', oauth: e.CLAUDE_CODE_OAUTH_TOKEN, mode: a.apiKeyMode() };`,
  });
  assert.equal(r.fromConfig, true);
  assert.equal(r.key, 'sk-ant-api03-CFG');
  assert.equal(r.mode, 'config');
  assert.equal(r.envBefore, 'sk-ant-api03-CFG');
  // 加了号以后 config 里的 key 不再用：如实报「没在用」，设置页据此提示
  assert.deepEqual(r.after, { key: '', oauth: 'sk-ant-oat01-NEW', mode: 'config-unused' });
});

test('号池里有令牌 / 有 oauthToken：不注入（不能让 key 顶掉订阅号），但报「config 里的 key 没在用」，不静默', () => {
  const pool = run({ anthropicApiKey: 'sk-ant-api03-CFG', claudeAccounts: [{ id: 'a', label: 'A', token: 'sk-ant-oat01-A' }], claudeActiveAccount: 'a' });
  assert.deepEqual(pool, { fromConfig: false, key: '', mode: 'config-unused' });
  const legacy = run({ anthropicApiKey: 'sk-ant-api03-CFG', oauthToken: 'sk-ant-oat01-OLD' });
  assert.equal(legacy.fromConfig, false);
  assert.equal(legacy.key, '');
  assert.equal(legacy.mode, 'config-unused');
  // 播种出来的空「默认账号」（令牌留空 = 本机登录态）不算有令牌：照样注入
  const seeded = run({ anthropicApiKey: 'sk-ant-api03-CFG', claudeAccounts: [{ id: 'd', label: '默认账号', token: '' }], claudeActiveAccount: 'd' });
  assert.equal(seeded.key, 'sk-ant-api03-CFG');
});

test('环境变量给的 key 照旧优先、不被 config 覆盖，并如实报「号池令牌不生效」', () => {
  const r = run({ anthropicApiKey: 'sk-ant-api03-CFG', claudeAccounts: [{ id: 'a', label: 'A', token: 'sk-ant-oat01-A' }], claudeActiveAccount: 'a' },
    { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-ENV' }, body: `out.cli = a.claudeEngineEnv(null).ANTHROPIC_API_KEY;` });
  assert.equal(r.fromConfig, false);
  assert.equal(r.key, 'sk-ant-api03-ENV');
  assert.equal(r.mode, 'env');
  assert.equal(r.cli, 'sk-ant-api03-ENV');
  // 没有 key 时什么都不注入
  assert.deepEqual(run({}), { fromConfig: false, key: '', mode: '' });
});

test('桌面安装包：server-run 经环境变量交来向导里选的 key（与 config 同值）——号池里留着旧令牌也照样生效，报 desktop', () => {
  const cfg = { anthropicApiKey: 'sk-ant-api03-WIZ', claudeAccounts: [{ id: 'a', label: 'A', token: 'sk-ant-oat01-OLD' }], claudeActiveAccount: 'a' };
  const r = run(cfg, { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-WIZ', BRIDGE_SUPERVISED: 'desktop' }, body: `out.cli = a.claudeEngineEnv(null).ANTHROPIC_API_KEY;` });
  assert.equal(r.fromConfig, false);
  assert.equal(r.mode, 'desktop');
  assert.equal(r.cli, 'sk-ant-api03-WIZ');
  // 同值但不是桌面托管（Docker / Linux 两处都写了）：按部署者的环境变量算
  assert.equal(run(cfg, { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-WIZ' } }).mode, 'env');
});

test('认证失败的提示跟着 key 的状态走：在用 key 时不再让人去更新号池令牌', () => {
  const auth = `const s = await import(${url('runtime/status.mjs')}); const c2 = s.classifyError('Invalid API key', 'authentication_failed'); out.title = c2.title; out.hint = c2.hint;`;
  const pool = { claudeAccounts: [{ id: 'a', label: 'A', token: 'sk-ant-oat01-A' }], claudeActiveAccount: 'a' };
  const desk = run({ anthropicApiKey: 'sk-ant-api03-WIZ', ...pool }, { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-WIZ', BRIDGE_SUPERVISED: 'desktop' }, body: auth });
  assert.equal(desk.title, 'API Key 无效');
  assert.match(desk.hint, /托盘「本机服务端 › 重新配置…」/);
  const env = run(pool, { env: { ANTHROPIC_API_KEY: 'sk-ant-api03-ENV' }, body: auth });
  assert.equal(env.title, 'API Key 无效');
  assert.match(env.hint, /ANTHROPIC_API_KEY/);
  const cfg = run({ anthropicApiKey: 'sk-ant-api03-CFG' }, { body: auth });
  assert.equal(cfg.title, 'API Key 无效');
  assert.match(cfg.hint, /anthropicApiKey/);
  const unused = run({ anthropicApiKey: 'sk-ant-api03-CFG', ...pool }, { body: auth });
  assert.equal(unused.title, '登录已失效');
  assert.match(unused.hint, /anthropicApiKey 没在用/);
  // 只有号池令牌：原来的说法一字不动
  const tok = run(pool, { body: auth });
  assert.equal(tok.title, '登录已失效');
  assert.match(tok.hint, /^令牌过期或被撤销：.*npm run set-auth/);
  const deskTok = run(pool, { env: { BRIDGE_SUPERVISED: 'desktop' }, body: auth });
  assert.match(deskTok.hint, /^令牌过期或被撤销：.*托盘「本机服务端 › 重新配置…」里重填。$/);
});
