// dimensio「认证了没」的判据（agent-status.mjs AUTHED.dimensio）：
//   · key 文件以扩展报的 harnessEnvFile() 为准——数据根 ≠ 程序目录时默认在 <数据根>/dimensio/.env，
//     不再只看 <harness 目录>/.env（看错文件就显示「还没配认证」）；
//   · 设置页填的厂商 key 加密存在自定义服务目录的 connector-secrets.json：它在也算配了。
// 用数据目录里装的假 dimensio 扩展（只导出这几个钩子），每种情形一个子进程。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const url = (p) => JSON.stringify(pathToFileURL(path.join(SRC, p)).href);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-dimauth-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const KEY_VARS = /^(ANTHROPIC|DEEPSEEK|ZHIPU|KIMI|MOONSHOT|QWEN|DASHSCOPE|GEMINI|OPENAI|MIMO)_API_KEY$/;
let n = 0;
// files：{ 相对数据根的路径: 内容 }；hooks：假扩展 harnessEnvFile / harnessDataDir 返回的（相对数据根）位置
function authed({ files = {}, envFile = null, dataDir = null, env = {} } = {}) {
  const root = path.join(tmp, 'd' + (++n));
  const harness = path.join(root, 'modules', 'dimensio', 'harness');
  mkdirSync(path.join(harness, 'server'), { recursive: true });
  writeFileSync(path.join(harness, 'server', 'index.ts'), '');
  const at = (p) => (p == null ? 'null' : JSON.stringify(path.join(root, p)));
  const mod = path.join(root, 'modules', 'dimensio');
  mkdirSync(path.join(mod, 'server'), { recursive: true });
  writeFileSync(path.join(mod, 'bridge-module.json'), JSON.stringify({ id: 'dimensio', version: '9.9', entry: 'server/index.mjs' }));
  writeFileSync(path.join(mod, 'server', 'index.mjs'), [
    `export const runnable = () => true;`,
    `export const harnessDir = () => ${JSON.stringify(harness)};`,
    ...(envFile !== false ? [`export const harnessEnvFile = () => ${at(envFile)};`] : []),
    ...(dataDir !== false ? [`export const harnessDataDir = () => ${at(dataDir)};`] : []),
  ].join('\n'));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  const childEnv = { ...process.env, BRIDGE_DATA_ROOT: root, BRIDGE_MODULES_BUILTIN: '0', BRIDGE_CLAUDE_IN_CHROME: '0', ...env };
  for (const k of Object.keys(childEnv)) if ((KEY_VARS.test(k) || k === 'HARNESS_ENV_FILE' || k === 'DIMENSIO_CUSTOM_PROVIDERS_DIR') && !(k in env)) delete childEnv[k];
  const script = `
    const r = await import(${url('modules/registry.mjs')});
    await r.loadModules();
    const a = await import(${url('runtime/agent-status.mjs')});
    console.log('@@' + JSON.stringify({ runnable: a.agentRunnable('dimensio'), authed: a.agentAuthed('dimensio') }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: childEnv, encoding: 'utf8' }).split('@@').pop());
  assert.equal(out.runnable, true);
  return out.authed;
}

test('key 文件看扩展报的 harnessEnvFile（数据根下的 dimensio/.env），不是 harness 目录里那份', () => {
  assert.equal(authed({ envFile: 'dimensio/.env', files: { 'dimensio/.env': 'DEEPSEEK_API_KEY=sk-1\n' } }), true);
  // harness 目录里那份有 key、但扩展说实际加载的是数据目录那份（空的）：不算
  assert.equal(authed({ envFile: 'dimensio/.env', files: { 'dimensio/.env': '', 'modules/dimensio/harness/.env': 'KIMI_API_KEY=k\n' } }), false);
  // 老扩展没有这个导出：回落到 <harness 目录>/.env
  assert.equal(authed({ envFile: false, dataDir: false, files: { 'modules/dimensio/harness/.env': 'KIMI_API_KEY=k\n' } }), true);
});

test('设置页填的 key（custom-providers/connector-secrets.json）在也算配了', () => {
  assert.equal(authed({ envFile: 'dimensio/.env', dataDir: 'dimensio', files: { 'dimensio/custom-providers/connector-secrets.json': '{}' } }), true);
  // 数据目录为 null（内置 harness 默认位置）：看 harness 目录下的
  assert.equal(authed({ envFile: 'nope/.env', dataDir: null, files: { 'modules/dimensio/harness/custom-providers/connector-secrets.json': '{}' } }), true);
  // 什么都没有
  assert.equal(authed({ envFile: 'dimensio/.env', dataDir: 'dimensio' }), false);
});
