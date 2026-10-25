// dimensio「认证了没」的判据（agent-status.mjs AUTHED.dimensio）：
//   · key 文件：HARNESS_ENV_FILE（部署脚本指到 <数据根>/dimensio/.env）> <harness 目录>/.env；
//   · 设置页填的厂商 key 加密存在自定义服务目录的 connector-secrets.json（DIMENSIO_CUSTOM_PROVIDERS_DIR >
//     <harness 目录>/custom-providers）：它在也算配了——以前只看 .env，设置页填了 key 仍显示「还没配认证」。
// 每种情形一个子进程（探测结果有缓存，环境变量要在导入前定好）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const statusUrl = JSON.stringify(pathToFileURL(path.join(SRC, 'runtime', 'agent-status.mjs')).href);
const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-dimauth-'));
test.after(() => rmSync(tmp, { recursive: true, force: true }));

const KEY_VARS = /^(ANTHROPIC|DEEPSEEK|ZHIPU|KIMI|MOONSHOT|QWEN|DASHSCOPE|GEMINI|OPENAI|MIMO)_API_KEY$/;
let n = 0;
// files：{ 相对临时根的路径: 内容 }；envFile / cpDir：相对临时根的 HARNESS_ENV_FILE / DIMENSIO_CUSTOM_PROVIDERS_DIR
function authed({ files = {}, envFile, cpDir } = {}) {
  const root = path.join(tmp, 'd' + (++n));
  mkdirSync(root, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), body);
  }
  const childEnv = { ...process.env, BRIDGE_DATA_ROOT: root };
  for (const k of Object.keys(childEnv)) if (KEY_VARS.test(k) || k === 'HARNESS_ENV_FILE' || k === 'DIMENSIO_CUSTOM_PROVIDERS_DIR') delete childEnv[k];
  // 没点名的也指进临时根（指向不存在的文件），免得读到仓库 harness/ 里开发者自己的 .env / custom-providers
  childEnv.HARNESS_ENV_FILE = path.join(root, envFile ?? 'none/.env');
  childEnv.DIMENSIO_CUSTOM_PROVIDERS_DIR = path.join(root, cpDir ?? 'none/custom-providers');
  const script = `
    const a = await import(${statusUrl});
    console.log('@@' + JSON.stringify({ runnable: a.agentRunnable('dimensio'), authed: a.agentAuthed('dimensio') }));`;
  const out = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script], { env: childEnv, encoding: 'utf8' }).split('@@').pop());
  return out;
}

test('key 文件看 HARNESS_ENV_FILE 指的那份', (t) => {
  const has = authed({ envFile: 'dimensio/.env', files: { 'dimensio/.env': 'DEEPSEEK_API_KEY=sk-FAKE-1\n' } });
  if (!has.runnable) return t.skip('本机 harness 没装依赖（dimensio 不可运行），认证探测不跑');
  assert.equal(has.authed, true);
  assert.equal(authed({ envFile: 'dimensio/.env', files: { 'dimensio/.env': '' } }).authed, false, '空的 .env 不算');
});

test('设置页填的 key（custom-providers/connector-secrets.json）在也算配了', (t) => {
  const has = authed({ cpDir: 'dimensio/custom-providers', files: { 'dimensio/custom-providers/connector-secrets.json': '{}' } });
  if (!has.runnable) return t.skip('本机 harness 没装依赖（dimensio 不可运行），认证探测不跑');
  assert.equal(has.authed, true);
  // 什么都没有
  assert.equal(authed({ envFile: 'dimensio/.env', cpDir: 'dimensio/custom-providers' }).authed, false);
});
