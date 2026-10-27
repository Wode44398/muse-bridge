// 功能扩展注册表的契约：基础版只有 Claude；装在数据目录的扩展能用 @bridge/core 引核心、
// 能借用核心的依赖；坏扩展只让自己不可用。每种场景各起一个子进程（发现在导入时就做完，
// 环境变量要在导入前定好）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = pathToFileURL(path.join(SRC, 'modules', 'registry.mjs')).href;
const STATUS = pathToFileURL(path.join(SRC, 'runtime', 'agent-status.mjs')).href;

function probe(env) {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-modules-'));
  const script = `
    const r = await import(${JSON.stringify(REGISTRY)});
    await r.loadModules();
    const a = await import(${JSON.stringify(STATUS)});
    console.log('@@' + JSON.stringify({
      enabled: a.enabledAgents(),
      notes: Object.fromEntries(a.agentStatusList().map((x) => [x.id, x.note])),
      codex: r.moduleStatus('codex'),
      extra: r.getModule('codex')?.extra ?? null,
    }));`;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, BRIDGE_DATA_ROOT: tmp, BRIDGE_CLAUDE_IN_CHROME: '0', ...env },
      encoding: 'utf8',
    });
    return JSON.parse(out.split('@@').pop());
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function fakeModule(root, id, code) {
  const dir = path.join(root, id);
  mkdirSync(path.join(dir, 'server'), { recursive: true });
  writeFileSync(path.join(dir, 'bridge-module.json'), JSON.stringify({ id, version: '9.9', entry: 'server/index.mjs' }));
  writeFileSync(path.join(dir, 'server', 'index.mjs'), code);
}

test('基础版（三个扩展都不在）：只剩 Claude，其余提示未安装', () => {
  const r = probe({ BRIDGE_MODULES_SKIP: 'all' });
  assert.deepEqual(r.enabled, ['claude']);
  const others = Object.keys(r.notes).filter((id) => id !== 'claude');
  // codex 只在私有版 / 打包版提供（公开版的克隆里没有 modules/codex），在不在都对
  assert.deepEqual(others.filter((id) => id !== 'codex'), ['gemini', 'dimensio']);
  assert.ok(others.every((id) => ['gemini', 'codex', 'dimensio'].includes(id)));
  for (const id of others) assert.match(r.notes[id], /^未安装「.+」扩展$/);
});

test('数据目录里残留的 agy 扩展（已下线）：不发现、不加载', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-modroot-'));
  const marker = path.join(root, 'agy-loaded');
  try {
    fakeModule(root, 'agy', `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, '1');\nexport const runnable = () => true;\n`);
    const r = probe({ BRIDGE_MODULES_BUILTIN: '0', BRIDGE_MODULES_DIR: root });
    assert.deepEqual(r.enabled, ['claude']);
    assert.equal('agy' in r.notes, false);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('装在数据目录的扩展：@bridge/core 指向核心同一实例，第三方包回落到核心 node_modules', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-modroot-'));
  try {
    fakeModule(root, 'codex', [
      "import { DATA_ROOT } from '@bridge/core/runtime/paths.mjs';",
      "import { PROGRAM_ROOT } from '@bridge/core/runtime/paths.mjs';",
      "import { request } from 'undici';",
      "import { createRequire } from 'node:module';",
      // require 走另一条解析路（node-pty 这类原生模块常这么载入）：换 parentURL 对它无效，回落要单独处理
      "const viaRequire = typeof createRequire(import.meta.url)('undici').request;",
      'export const extra = { programRoot: PROGRAM_ROOT, hasDataRoot: !!DATA_ROOT, undici: typeof request, viaRequire };',
      'export function runnable() { return true; }',
    ].join('\n'));
    const r = probe({ BRIDGE_MODULES_BUILTIN: '0', BRIDGE_MODULES_DIR: root });
    assert.equal(r.codex.source, 'installed');
    assert.equal(r.codex.version, '9.9');
    assert.equal(r.extra.programRoot.toLowerCase(), path.resolve(SRC, '..').toLowerCase());
    assert.equal(r.extra.undici, 'function');
    assert.equal(r.extra.viaRequire, 'function');
    assert.deepEqual(r.enabled, ['claude', 'codex']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('坏扩展：加载失败只让它自己不可用，原因写进 note', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-modroot-'));
  try {
    fakeModule(root, 'codex', "import '@bridge/core/does-not-exist.mjs';\nexport const runnable = () => true;\n");
    const r = probe({ BRIDGE_MODULES_BUILTIN: '0', BRIDGE_MODULES_DIR: root });
    assert.deepEqual(r.enabled, ['claude']);
    assert.match(r.notes.codex, /扩展加载失败/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('@bridge/core 不许越出 src', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-modroot-'));
  try {
    fakeModule(root, 'codex', "import '@bridge/core/../package.json';\nexport const runnable = () => true;\n");
    const r = probe({ BRIDGE_MODULES_BUILTIN: '0', BRIDGE_MODULES_DIR: root });
    assert.match(r.notes.codex, /非法的核心模块路径/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
