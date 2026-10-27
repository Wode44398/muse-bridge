// S2（10-21）：dimensio 扩展一更新或卸载，设置页存的 key、自定义服务、运行配置、项目表全被删。
//
// 修前：harness 的可写状态默认都在自己的工作目录里，离线包形态下就是 <数据根>/modules/dimensio/harness——扩展中心换版 /
// 卸载时整个目录进 .trash 后删掉。修后：harness 是扩展自带的时候，bridge 给 harness DIMENSIO_DATA_DIR=<数据根>/dimensio，
// 并把旧位置的数据一次性复制过去；程序目录内置的 harness（维护者正式服、install-windows、install.sh、Docker、测试服）默认位置不动，
// 只把搬家工具落在 <数据根>/harness 的旧数据补进部署脚本显式指到 <数据根>/dimensio 的项；数据根 == 程序目录时一个文件都不碰。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HARNESS_DATA_ITEMS, MIGRATED_MARKER, harnessDataEnv, harnessEnvFile, planHarnessData, prepareHarnessData, samePath, trashedHarnessDirs,
} from './harness-data.mjs';

const quiet = () => {};

function sandbox() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dimensio-s2-'));
  return { root, at: (...p) => path.join(root, ...p), done: () => rmSync(root, { recursive: true, force: true }) };
}

// 安装包形态：数据根 <沙盒>/data（离线扩展装在 data/modules 下），程序目录 <沙盒>/app。
const roots = (s) => ({ dataRoot: s.at('data'), programRoot: s.at('app') });
// 扩展自带的 harness 与它对应的计划
const pkgHarness = (s) => s.at('data', 'modules', 'dimensio', 'harness');
const pkgPlan = (s, env = {}) => planHarnessData({ ...roots(s), harnessDir: pkgHarness(s), modulesDir: s.at('data', 'modules'), env });

function put(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

// 一个用过一阵的旧 harness 目录：设置页填过 key、加过自定义服务、建过项目、聊过几轮。
function seedHarness(dir) {
  put(path.join(dir, 'server', 'index.ts'), '// program\n');
  put(path.join(dir, 'runtime-config.json'), '{"provider":"custom-0a1b2c3d"}\n');
  put(path.join(dir, 'projects.json'), '{"v":1,"projects":[]}\n');
  put(path.join(dir, 'custom-providers', 'providers.json'), '{"v":1,"providers":[]}\n');
  put(path.join(dir, 'custom-providers', 'connector-secrets.json'), '{"v":1,"blob":"FAKE-ciphertext"}\n');
  put(path.join(dir, 'custom-providers', 'connector-secrets.key'), '{"v":1,"scheme":"file","key":"FAKE"}\n');
  put(path.join(dir, 'quick.json'), '{"current":"q1"}\n');
  put(path.join(dir, 'sessions', 's1.jsonl'), '{"t":"hello"}\n');
  put(path.join(dir, 'memory', 'workspaces', 'w1', 'MEMORY.md'), '# m\n');
  put(path.join(dir, 'knowledge', 'workspaces', 'w1', 'index.json'), '{}\n');
  put(path.join(dir, 'workspace', 'notes.md'), 'hi\n');
  put(path.join(dir, '.env'), 'OPENAI_API_KEY=FAKE-key\n');
}

test('S2 数据根 == 程序目录（维护者正式服）：不设数据目录、不迁移；大小写 / 尾斜杠不同也算同一个', () => {
  const s = sandbox();
  try {
    const h = s.at('harness');
    const noop = { dataDir: null, targetDir: null, migrate: false, packaged: false };
    assert.deepEqual(planHarnessData({ dataRoot: s.root, programRoot: s.root, harnessDir: h, env: {} }), noop);
    assert.deepEqual(planHarnessData({ dataRoot: s.root + path.sep, programRoot: s.root, harnessDir: h, env: {} }), noop);
    if (process.platform === 'win32') {
      assert.deepEqual(planHarnessData({ dataRoot: s.root.toUpperCase(), programRoot: s.root, harnessDir: h, env: {} }), noop);
    }
    // 离线包装在同一个根里也一样：数据根 == 程序目录一律不动文件
    assert.deepEqual(planHarnessData({ dataRoot: s.root, programRoot: s.root, harnessDir: s.at('modules', 'dimensio', 'harness'), env: {} }), noop);
    // 显式给了 DIMENSIO_DATA_DIR 也只是照传，不迁移
    const explicit = s.at('elsewhere');
    assert.deepEqual(
      planHarnessData({ dataRoot: s.root, programRoot: s.root, harnessDir: h, env: { DIMENSIO_DATA_DIR: explicit } }),
      { ...noop, dataDir: explicit },
    );
  } finally { s.done(); }
});

test('S2 harness 是扩展自带的（数据根里的离线包）：数据目录是 <数据根>/dimensio；显式 DIMENSIO_DATA_DIR 优先；扩展目录放在数据根外也算', () => {
  const s = sandbox();
  try {
    const d = path.join(s.at('data'), 'dimensio');
    assert.deepEqual(pkgPlan(s), { dataDir: d, targetDir: d, migrate: true, packaged: true });
    assert.deepEqual(pkgPlan(s, { DIMENSIO_DATA_DIR: s.at('x') }), { dataDir: s.at('x'), targetDir: s.at('x'), migrate: true, packaged: true });
    const mods = s.at('mods');
    assert.deepEqual(
      planHarnessData({ ...roots(s), harnessDir: path.join(mods, 'dimensio', 'harness'), modulesDir: mods, env: {} }),
      { dataDir: d, targetDir: d, migrate: true, packaged: true },
    );
  } finally { s.done(); }
});

test('S2 程序目录内置的 harness（install-windows -DataRoot、install.sh、Docker、测试服、开发实例）：默认位置不动，只补搬家工具的旧数据', () => {
  const s = sandbox();
  try {
    const d = path.join(s.at('data'), 'dimensio');
    const builtin = s.at('app', 'harness');
    assert.deepEqual(planHarnessData({ ...roots(s), harnessDir: builtin, env: {} }), { dataDir: null, targetDir: d, migrate: true, packaged: false });
    // 部署脚本显式给了 DIMENSIO_DATA_DIR：照传给 harness，仍不当扩展自带
    assert.deepEqual(
      planHarnessData({ ...roots(s), harnessDir: builtin, env: { DIMENSIO_DATA_DIR: s.at('x') } }),
      { dataDir: s.at('x'), targetDir: s.at('x'), migrate: true, packaged: false },
    );
    // BRIDGE_HARNESS_DIR 借用数据根之外的一份（worktree 借主仓库的）：也不当扩展自带
    assert.equal(planHarnessData({ ...roots(s), harnessDir: s.at('elsewhere', 'harness'), env: {} }).packaged, false);
  } finally { s.done(); }
});

test('S2 审查复现：源码形态 + 数据根在程序目录外（install-windows -DataRoot）升级后，key、自定义服务、会话照旧在原处可读，一个文件都不动', async () => {
  const s = sandbox();
  try {
    const builtin = s.at('app', 'harness');
    seedHarness(builtin);
    mkdirSync(s.at('data'), { recursive: true });
    const before = readdirSync(builtin).sort();
    const plan = planHarnessData({ ...roots(s), harnessDir: builtin, env: {} });
    const r = await prepareHarnessData({ ...plan, ...roots(s), harnessDir: builtin, legacyDirs: [s.at('data', 'harness')], defaults: { WORKSPACE_DIR: s.at('vault') }, env: {}, log: quiet });
    assert.deepEqual(r, { migrated: [], failed: [], fallbacks: {}, defaults: {} });
    assert.equal(harnessEnvFile({ dataDir: plan.dataDir, harnessDir: builtin, env: {} }), path.join(builtin, '.env'), '.env 还是原来那份');
    assert.deepEqual(harnessDataEnv({ dataDir: plan.dataDir, prepared: r, envFile: path.join(builtin, '.env') }), {}, '不给 harness 加任何变量');
    assert.deepEqual(readdirSync(s.at('data')), [], '数据根里没建任何东西');
    assert.deepEqual(readdirSync(builtin).sort(), before, '内置 harness 里一个文件都没多（没有 .migrated）');
  } finally { s.done(); }
});

test('S2 .env 位置：显式 HARNESS_ENV_FILE（相对 harness 目录解析）> 数据目录 > harness 目录', () => {
  const s = sandbox();
  try {
    const h = s.at('harness');
    assert.equal(harnessEnvFile({ dataDir: null, harnessDir: h, env: {} }), path.join(h, '.env'));
    assert.equal(harnessEnvFile({ dataDir: s.at('d'), harnessDir: h, env: {} }), path.join(s.at('d'), '.env'));
    assert.equal(harnessEnvFile({ dataDir: s.at('d'), harnessDir: h, env: { HARNESS_ENV_FILE: s.at('k.env') } }), s.at('k.env'));
    assert.equal(harnessEnvFile({ dataDir: null, harnessDir: h, env: { HARNESS_ENV_FILE: 'rel.env' } }), path.join(h, 'rel.env'));
  } finally { s.done(); }
});

test('S2 migrate=false 时一个文件都不碰：不建数据目录、不写 .migrated', async () => {
  const s = sandbox();
  try {
    const h = pkgHarness(s);
    seedHarness(h);
    const before = readdirSync(h).sort();
    const r = await prepareHarnessData({ dataDir: s.at('data', 'dimensio'), migrate: false, packaged: true, ...roots(s), harnessDir: h, env: {}, log: quiet });
    assert.deepEqual(r, { migrated: [], failed: [], fallbacks: {}, defaults: {} });
    assert.equal(existsSync(s.at('data', 'dimensio')), false);
    assert.deepEqual(readdirSync(h).sort(), before);
  } finally { s.done(); }
});

test('S2 首次启动：扩展目录里的全部状态（含会被删掉的工作区）复制进数据目录，原件原样留着并记下 .migrated；第二次不再搬', async () => {
  const s = sandbox();
  try {
    const h = pkgHarness(s);
    const d = s.at('data', 'dimensio');
    seedHarness(h);
    const r = await prepareHarnessData({ ...pkgPlan(s), ...roots(s), harnessDir: h, defaults: { WORKSPACE_DIR: s.at('vault') }, env: {}, log: quiet });
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.migrated.map((m) => m.name).sort(), HARNESS_DATA_ITEMS.map((i) => i.name).sort());
    assert.deepEqual(r.defaults, {}, '工作区抢救到了数据目录，就接着用它，不改指 bridge 工作空间');
    assert.equal(readFileSync(path.join(d, 'runtime-config.json'), 'utf8'), '{"provider":"custom-0a1b2c3d"}\n');
    assert.equal(readFileSync(path.join(d, 'custom-providers', 'connector-secrets.json'), 'utf8'), '{"v":1,"blob":"FAKE-ciphertext"}\n');
    assert.equal(readFileSync(path.join(d, 'custom-providers', 'connector-secrets.key'), 'utf8'), '{"v":1,"scheme":"file","key":"FAKE"}\n');
    assert.equal(readFileSync(path.join(d, 'sessions', 's1.jsonl'), 'utf8'), '{"t":"hello"}\n');
    assert.equal(readFileSync(path.join(d, 'memory', 'workspaces', 'w1', 'MEMORY.md'), 'utf8'), '# m\n');
    assert.equal(readFileSync(path.join(d, 'workspace', 'notes.md'), 'utf8'), 'hi\n');
    assert.equal(readFileSync(path.join(d, '.env'), 'utf8'), 'OPENAI_API_KEY=FAKE-key\n');
    // 原件不删不挪
    assert.equal(readFileSync(path.join(h, 'runtime-config.json'), 'utf8'), '{"provider":"custom-0a1b2c3d"}\n');
    assert.ok(existsSync(path.join(h, 'custom-providers', 'connector-secrets.json')));
    // 没有残留的临时名
    assert.deepEqual(readdirSync(d).filter((n) => n.includes('.migrating-')), []);
    const marker = JSON.parse(readFileSync(path.join(h, MIGRATED_MARKER), 'utf8'));
    assert.equal(marker.to, d);
    assert.deepEqual(Object.keys(marker.items).sort(), HARNESS_DATA_ITEMS.map((i) => i.name).sort());
    assert.equal(harnessDataEnv({ dataDir: d, prepared: r, envFile: path.join(d, '.env') }).WORKSPACE_DIR, undefined);

    // 第二次：目标已有数据 → 不搬；使用者删了新位置的某项，也不会从留底的原件里再搬回来（.migrated 记着）
    rmSync(path.join(d, 'quick.json'));
    const again = await prepareHarnessData({ ...pkgPlan(s), ...roots(s), harnessDir: h, defaults: { WORKSPACE_DIR: s.at('vault') }, env: {}, log: quiet });
    assert.deepEqual(again, { migrated: [], failed: [], fallbacks: {}, defaults: {} });
    assert.equal(existsSync(path.join(d, 'quick.json')), false);
  } finally { s.done(); }
});

test('S2 绝不覆盖已有的新数据；空目录 / 空文件（Docker 入口、install.sh 先建的占位）照常填', async () => {
  const s = sandbox();
  try {
    const h = pkgHarness(s);
    const d = s.at('data', 'dimensio');
    seedHarness(h);
    put(path.join(d, 'runtime-config.json'), '{"provider":"NEWER"}\n');
    put(path.join(d, 'custom-providers', 'providers.json'), '{"v":1,"providers":["NEWER"]}\n');
    mkdirSync(path.join(d, 'sessions'), { recursive: true });   // 空目录
    put(path.join(d, '.env'), '');                               // 空文件
    const r = await prepareHarnessData({ ...pkgPlan(s), ...roots(s), harnessDir: h, env: {}, log: quiet });
    const names = r.migrated.map((m) => m.name);
    assert.ok(!names.includes('runtime-config.json'));
    assert.ok(!names.includes('custom-providers'));
    assert.ok(names.includes('sessions') && names.includes('.env'));
    assert.equal(readFileSync(path.join(d, 'runtime-config.json'), 'utf8'), '{"provider":"NEWER"}\n');
    assert.equal(readFileSync(path.join(d, 'custom-providers', 'providers.json'), 'utf8'), '{"v":1,"providers":["NEWER"]}\n');
    assert.equal(existsSync(path.join(d, 'custom-providers', 'connector-secrets.json')), false, '已有的目录不往里合并');
    assert.equal(readFileSync(path.join(d, 'sessions', 's1.jsonl'), 'utf8'), '{"t":"hello"}\n');
    assert.equal(readFileSync(path.join(d, '.env'), 'utf8'), 'OPENAI_API_KEY=FAKE-key\n');
  } finally { s.done(); }
});

test('S2 单独改道到数据目录之外的项不归迁移管（进程环境 / .env 里写的都算）；指回数据目录的照搬', async () => {
  const s = sandbox();
  try {
    const h = pkgHarness(s);
    const d = s.at('data', 'dimensio');
    seedHarness(h);
    // 向导写的 .env：会话指在数据目录里（同默认位置），工作区指到使用者的工作空间
    const envFile = path.join(d, '.env');
    put(envFile, `SESSIONS_DIR=${path.join(d, 'sessions')}\nWORKSPACE_DIR=${s.at('vault')}\nMEMORY_DIR=${s.at('elsewhere', 'memory')}\n`);
    const env = { HARNESS_ENV_FILE: envFile, DIMENSIO_CUSTOM_PROVIDERS_DIR: s.at('elsewhere', 'cp') };
    const r = await prepareHarnessData({ ...pkgPlan(s), ...roots(s), harnessDir: h, defaults: { WORKSPACE_DIR: s.at('other-vault') }, env, log: quiet });
    const names = r.migrated.map((m) => m.name).sort();
    assert.deepEqual(names, ['knowledge', 'projects.json', 'quick.json', 'runtime-config.json', 'sessions']);
    assert.deepEqual(r.defaults, {}, '.env 指定了工作区，不另定默认');
    assert.equal(existsSync(s.at('vault')), false, '工作空间不该被建 / 被写');
    assert.equal(existsSync(s.at('elsewhere')), false, '显式改道的位置不碰');
    assert.equal(existsSync(path.join(d, 'workspace')), false, '工作区改道了，数据目录里不建空的');
    assert.equal(readFileSync(envFile, 'utf8').includes('WORKSPACE_DIR'), true, '.env 已有数据，不被旧的覆盖');
  } finally { s.done(); }
});

test('S2 审查复现（S1 停写 .env 之后）：扩展自带 harness、没人指定工作区、旧工作区是空的 → 默认工作区是 bridge 工作空间，数据目录里不建空的', async () => {
  const s = sandbox();
  try {
    const h = pkgHarness(s);
    const d = s.at('data', 'dimensio');
    put(path.join(h, 'server', 'index.ts'), '// fresh package\n');
    put(path.join(h, 'runtime-config.json'), '{"provider":"deepseek"}\n');
    mkdirSync(path.join(h, 'workspace'), { recursive: true });   // 空的
    const vault = s.at('bridge-vault');
    const r = await prepareHarnessData({ ...pkgPlan(s), ...roots(s), harnessDir: h, defaults: { WORKSPACE_DIR: vault }, env: {}, log: quiet });
    assert.deepEqual(r.defaults, { WORKSPACE_DIR: vault });
    assert.equal(existsSync(path.join(d, 'workspace')), false);
    for (const n of ['sessions', 'memory', 'knowledge']) assert.ok(existsSync(path.join(d, n)), n);
    const envFile = path.join(d, '.env');
    assert.deepEqual(harnessDataEnv({ dataDir: d, prepared: r, envFile }), { DIMENSIO_DATA_DIR: d, WORKSPACE_DIR: vault });
    // 之后使用者在 .env 里写了工作区：让 .env 说了算（进程环境会盖过 .env，所以这边不再加）
    put(envFile, `WORKSPACE_DIR=${s.at('mine')}\n`);
    assert.deepEqual(harnessDataEnv({ dataDir: d, prepared: r, envFile }), { DIMENSIO_DATA_DIR: d });
    // 进程环境里给了工作区（Docker / install.sh）：不另定默认
    const r2 = await prepareHarnessData({ ...pkgPlan(s), ...roots(s), harnessDir: h, defaults: { WORKSPACE_DIR: vault }, env: { WORKSPACE_DIR: s.at('ws') }, log: quiet });
    assert.deepEqual(r2.defaults, {});
  } finally { s.done(); }
});

test('S2 审查复现（VPS 搬家）：<数据根>/harness 的工作区不复制，会话里记着的路径继续可用；install.sh 显式指到 <数据根>/dimensio 的项照补', async () => {
  const s = sandbox();
  try {
    const builtin = s.at('app', 'harness');
    put(path.join(builtin, 'server', 'index.ts'), '// program\n');
    put(path.join(builtin, 'custom-providers', 'providers.json'), '{"live":true}\n');
    const imported = s.at('data', 'harness');
    seedHarness(imported);
    rmSync(path.join(imported, 'server'), { recursive: true });
    put(path.join(imported, 'sessions', 's1.jsonl'), JSON.stringify({ workspace: path.join(imported, 'workspace') }) + '\n');
    const d = s.at('data', 'dimensio');
    // install.sh：逐项指到 <数据根>/dimensio，并预先建好空目录 / 空 .env
    const env = {};
    for (const [k, n] of [['SESSIONS_DIR', 'sessions'], ['MEMORY_DIR', 'memory'], ['KNOWLEDGE_DIR', 'knowledge'], ['DIMENSIO_CONFIG_FILE', 'runtime-config.json'],
      ['DIMENSIO_QUICK_FILE', 'quick.json'], ['PROJECTS_FILE', 'projects.json'], ['WORKSPACE_DIR', 'workspace'], ['HARNESS_ENV_FILE', '.env']]) env[k] = path.join(d, n);
    for (const n of ['sessions', 'memory', 'knowledge', 'workspace']) mkdirSync(path.join(d, n), { recursive: true });
    put(path.join(d, '.env'), '');
    const plan = planHarnessData({ ...roots(s), harnessDir: builtin, env });
    const r = await prepareHarnessData({ ...plan, ...roots(s), harnessDir: builtin, legacyDirs: [imported], defaults: { WORKSPACE_DIR: s.at('vault') }, env, log: quiet });
    assert.deepEqual(r.failed, []);
    assert.deepEqual(r.migrated.map((m) => m.name).sort(), ['.env', 'knowledge', 'memory', 'projects.json', 'quick.json', 'runtime-config.json', 'sessions']);
    assert.deepEqual(r.defaults, {});
    assert.deepEqual(readdirSync(path.join(d, 'workspace')), [], '工作区不复制（不分叉成两份）');
    assert.ok(existsSync(path.join(imported, 'workspace', 'notes.md')), '旧工作区原样留着，会话里的路径照旧能用');
    assert.equal(existsSync(path.join(d, 'custom-providers')), false, 'install.sh 没指的项不归这里管');
    assert.equal(readFileSync(path.join(builtin, 'custom-providers', 'providers.json'), 'utf8'), '{"live":true}\n');
    const marker = JSON.parse(readFileSync(path.join(imported, MIGRATED_MARKER), 'utf8'));
    assert.equal(marker.items.workspace, undefined, '.migrated 里不列工作区：那份不能删');
    assert.ok(/workspace/.test(marker.note));
    assert.equal(existsSync(path.join(builtin, MIGRATED_MARKER)), false);
  } finally { s.done(); }
});

test('S2 扩展自带 harness、没人指定工作区、只有 <数据根>/harness 里有旧工作区 → 直接指过去，不复制', async () => {
  const s = sandbox();
  try {
    const h = pkgHarness(s);
    put(path.join(h, 'server', 'index.ts'), '// fresh package\n');
    const imported = s.at('data', 'harness');
    put(path.join(imported, 'workspace', 'a.md'), 'a\n');
    const d = s.at('data', 'dimensio');
    const r = await prepareHarnessData({ ...pkgPlan(s), ...roots(s), harnessDir: h, legacyDirs: [imported], defaults: { WORKSPACE_DIR: s.at('vault') }, env: {}, log: quiet });
    assert.deepEqual(r.migrated, []);
    assert.deepEqual(r.defaults, { WORKSPACE_DIR: path.join(imported, 'workspace') });
    assert.equal(existsSync(path.join(d, 'workspace')), false);
    assert.equal(harnessDataEnv({ dataDir: d, prepared: r, envFile: path.join(d, '.env') }).WORKSPACE_DIR, path.join(imported, 'workspace'));
  } finally { s.done(); }
});

test('S2 旧位置按优先级找：扩展自带 harness > <数据根>/harness（搬家工具落地处）> .trash 里最新换下来的旧版', async () => {
  const s = sandbox();
  try {
    const h = pkgHarness(s);
    put(path.join(h, 'server', 'index.ts'), '// fresh package, no data\n');
    const imported = s.at('data', 'harness');
    put(path.join(imported, 'sessions', 'old.jsonl'), '{"from":"import"}\n');
    const trash = s.at('data', 'modules', '.trash');
    put(path.join(trash, 'dimensio-100', 'harness', 'runtime-config.json'), '{"from":"older"}\n');
    put(path.join(trash, 'dimensio-200', 'harness', 'runtime-config.json'), '{"from":"newer"}\n');
    put(path.join(trash, 'dimensio-200', 'harness', 'sessions', 'x.jsonl'), '{"from":"trash"}\n');
    put(path.join(trash, 'codex-300', 'harness', 'projects.json'), '{"not":"ours"}\n');
    const trashed = trashedHarnessDirs(trash);
    assert.deepEqual(trashed, [path.join(trash, 'dimensio-200', 'harness'), path.join(trash, 'dimensio-100', 'harness')]);
    const d = s.at('data', 'dimensio');
    const r = await prepareHarnessData({ ...pkgPlan(s), ...roots(s), harnessDir: h, legacyDirs: [imported], trashDirs: trashed, env: {}, log: quiet });
    assert.deepEqual(r.failed, []);
    assert.equal(readFileSync(path.join(d, 'runtime-config.json'), 'utf8'), '{"from":"newer"}\n');
    assert.equal(readFileSync(path.join(d, 'sessions', 'old.jsonl'), 'utf8'), '{"from":"import"}\n');
    assert.equal(existsSync(path.join(d, 'sessions', 'x.jsonl')), false, '一项只从一个来源搬');
    assert.equal(existsSync(path.join(d, 'projects.json')), false);
    // 默认会用到的目录建好了（没给默认工作区时工作区也在数据目录里）
    for (const n of ['sessions', 'memory', 'knowledge', 'workspace']) assert.ok(existsSync(path.join(d, n)), n);
  } finally { s.done(); }
});

test('S2 审查复现：某项复制失败 → 本次先指回原件、不建空占位、不记 .migrated；下次启动真的重试', async () => {
  const s = sandbox();
  try {
    const h = pkgHarness(s);
    const d = s.at('data', 'dimensio');
    seedHarness(h);
    put(path.join(h, '.env'), `OPENAI_API_KEY=FAKE-key\nWORKSPACE_DIR=${s.at('vault')}\n`);
    const logs = [];
    // 模拟 Windows 上改名被杀毒占着 / 磁盘满：会话和 .env 这两项复制失败
    const flaky = async (from, to, opts) => {
      const name = path.basename(to);
      if (name === 'sessions' || name === '.env') throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      const { cp } = await import('node:fs/promises');
      await cp(from, to, { recursive: true });
    };
    const r = await prepareHarnessData({ ...pkgPlan(s), ...roots(s), harnessDir: h, defaults: { WORKSPACE_DIR: s.at('other') }, env: {}, log: (m) => logs.push(m), copy: flaky });
    assert.deepEqual(r.failed.map((f) => f.name).sort(), ['.env', 'sessions']);
    assert.deepEqual(r.fallbacks, { HARNESS_ENV_FILE: path.join(h, '.env'), SESSIONS_DIR: path.join(h, 'sessions') });
    assert.deepEqual(r.defaults, {}, '原件 .env 里写了工作区：按它来，不另定默认');
    assert.equal(existsSync(path.join(d, 'sessions')), false, '失败的项不建空占位（否则下次当「已有」再也搬不过来）');
    assert.ok(existsSync(path.join(d, 'memory')));
    assert.ok(logs.some((m) => m.includes('本次先直接用原位置')));
    const env = harnessDataEnv({ dataDir: d, prepared: r, envFile: path.join(d, '.env') });
    assert.equal(env.SESSIONS_DIR, path.join(h, 'sessions'));
    assert.equal(env.HARNESS_ENV_FILE, path.join(h, '.env'));
    const marker = JSON.parse(readFileSync(path.join(h, MIGRATED_MARKER), 'utf8'));
    assert.equal(marker.items.sessions, undefined);
    assert.equal(marker.items['.env'], undefined);
    // 下次启动（这次复制正常）：两项都补上
    const again = await prepareHarnessData({ ...pkgPlan(s), ...roots(s), harnessDir: h, env: {}, log: quiet });
    assert.deepEqual(again.migrated.map((m) => m.name).sort(), ['.env', 'sessions']);
    assert.deepEqual(again.fallbacks, {});
    assert.equal(readFileSync(path.join(d, 'sessions', 's1.jsonl'), 'utf8'), '{"t":"hello"}\n');
  } finally { s.done(); }
});

test('S2 审查复现：上次复制到一半被结束留下的 <名>.migrating-<pid>-<hex> 起头就清掉；别的名字、还活着的进程的不动', async () => {
  const s = sandbox();
  try {
    const h = pkgHarness(s);
    seedHarness(h);
    const d = s.at('data', 'dimensio');
    const dead = spawnSync(process.execPath, ['-e', '0']).pid;    // 已经退出的进程
    const orphan = path.join(d, `sessions.migrating-${dead}-a1b2c3`);
    const orphanSelf = path.join(d, `workspace.migrating-${process.pid}-0f0f0f`);   // 同 pid 的上一个进程留下的
    const live = path.join(d, `memory.migrating-${process.ppid}-abcdef`);         // 父进程还活着：可能正在搬，不动
    const foreign = path.join(d, `notes.migrating-${dead}-a1b2c3`);                // 不是数据项
    put(path.join(orphan, 'half.jsonl'), 'x');
    put(path.join(orphanSelf, 'half.md'), 'x');
    put(path.join(live, 'm.md'), 'x');
    put(path.join(foreign, 'n.md'), 'x');
    const r = await prepareHarnessData({ ...pkgPlan(s), ...roots(s), harnessDir: h, env: {}, log: quiet });
    assert.deepEqual(r.failed, []);
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(orphanSelf), false);
    assert.ok(existsSync(live));
    assert.ok(existsSync(foreign));
    assert.equal(readFileSync(path.join(d, 'sessions', 's1.jsonl'), 'utf8'), '{"t":"hello"}\n');
  } finally { s.done(); }
});

test('S2 来源与数据目录相同或互相包含时跳过（不把自己拷进自己）', async () => {
  const s = sandbox();
  try {
    const d = s.at('data', 'dimensio');
    seedHarness(d);
    const r = await prepareHarnessData({ dataDir: d, migrate: true, packaged: true, ...roots(s), harnessDir: d, legacyDirs: [s.at('data')], env: {}, log: quiet });
    assert.deepEqual(r.migrated, []);
    assert.deepEqual(r.failed, []);
    assert.equal(existsSync(path.join(d, MIGRATED_MARKER)), false);
    assert.ok(samePath(d, d + path.sep));
  } finally { s.done(); }
});

test('S2 程序目录内置的 harness/、数据根之外的位置一律不当来源：测试 / 开发实例把数据根指到临时目录时，正式数据不会被拷过去', async () => {
  const s = sandbox();
  try {
    // 仓库满配 = 维护者正式服那份 harness（真会话、.env 明文 key）
    const repo = s.at('repo');
    const builtin = path.join(repo, 'harness');
    seedHarness(builtin);
    const before = readdirSync(builtin).sort();
    // 走真实的计划：测试 / 开发实例（数据根是临时目录，harness 仍是仓库里那份）→ 内置模式，什么都不碰
    for (const dataRoot of [s.at('tmp-data'), s.root]) {
      const plan = planHarnessData({ dataRoot, programRoot: repo, harnessDir: builtin, env: {} });
      assert.equal(plan.packaged, false);
      const r = await prepareHarnessData({ ...plan, dataRoot, programRoot: repo, harnessDir: builtin, legacyDirs: [path.join(dataRoot, 'harness')], env: {}, log: quiet });
      assert.deepEqual(r, { migrated: [], failed: [], fallbacks: {}, defaults: {} });
      assert.equal(existsSync(path.join(dataRoot, 'dimensio')), false);
    }
    // 就算被当成扩展自带（显式 packaged）：内置那份、数据根之外的那份照样不认
    const check = async ({ dataRoot, harnessDir, legacyDirs = [] }) => {
      const d = path.join(dataRoot, 'dimensio');
      const r = await prepareHarnessData({ dataDir: d, migrate: true, packaged: true, dataRoot, programRoot: repo, harnessDir, legacyDirs, env: {}, log: quiet });
      assert.deepEqual(r.migrated, []);
      assert.deepEqual(r.failed, []);
      assert.equal(existsSync(path.join(d, '.env')), false, '.env 不能被拷进去');
      assert.equal(existsSync(path.join(d, 'runtime-config.json')), false);
      assert.deepEqual(readdirSync(path.join(d, 'sessions')), [], '只建了空目录');
    };
    await check({ dataRoot: s.at('tmp-data'), harnessDir: builtin });
    await check({ dataRoot: s.root, harnessDir: builtin, legacyDirs: [path.join(s.root, 'harness')] });
    const other = s.at('elsewhere', 'harness');
    seedHarness(other);
    await check({ dataRoot: s.at('tmp-data-2'), harnessDir: other });
    assert.deepEqual(readdirSync(builtin).sort(), before, '内置 harness 里一个文件都没多（没有 .migrated）');
    assert.equal(existsSync(path.join(other, MIGRATED_MARKER)), false);
  } finally { s.done(); }
});
