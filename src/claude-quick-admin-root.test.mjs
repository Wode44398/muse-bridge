// admin 临时对话桶的共用根按实例隔离（10-21 事故：隔离夹具的 pruneQuick 删掉了生产「存为工作空间」的桶）。
// 主目录换成临时目录再 import——共用根在模块加载时按 os.homedir() 定下，绝不碰真实 ~。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, utimesSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(tmpdir(), 'quick-home-'));
process.env.USERPROFILE = home;
process.env.HOME = home;
const { quickProject, pruneQuick } = await import('./claude-quick.mjs');
const SHARED = path.join(home, '.bridge-quickchat');
const fold = (p) => process.platform === 'win32' ? p.toLowerCase() : p;

const admin = (name) => {
  const d = path.join(home, name);
  mkdirSync(d, { recursive: true });
  return { kind: 'admin', key: 'admin', cwd: d, dataDir: d, configDir: path.join(d, 'claude'), claudeProjects: path.join(d, 'claude-projects.json') };
};

test.after(() => rmSync(home, { recursive: true, force: true }));

test('历来用共用根的实例认领它；新夹具落 i-<哈希> 子目录，回收碰不到生产的桶', async () => {
  const prod = admin('prod');
  // 生产老数据：当前快照桶早就在共用根里、.owner 还没有
  const legacy = path.join(SHARED, '8bb1ba0d-2c0a-412a-b19b-d76cb81bd120');
  mkdirSync(legacy, { recursive: true });
  writeFileSync(path.join(prod.dataDir, 'claude-quick.json'), JSON.stringify({ id: path.basename(legacy), path: legacy, created: 1 }));
  assert.equal(quickProject(prod).path, legacy, '生产沿用原桶');
  assert.equal(readFileSync(path.join(SHARED, '.owner'), 'utf8'), fold(path.resolve(prod.dataDir)));

  const old = new Date(Date.now() - 48 * 3600e3);
  utimesSync(legacy, old, old);
  const fx = admin('fixture');
  const q = quickProject(fx);
  assert.ok(path.dirname(q.path).startsWith(path.join(SHARED, 'i-')), '夹具的桶落在自己的子目录');
  await pruneQuick(fx, { ttlMs: 0, now: Date.now() + 3600e3 });
  assert.ok(existsSync(legacy), '夹具回收不碰共用根里的生产桶');

  await pruneQuick(prod, { ttlMs: 0, now: Date.now() + 3600e3 });
  assert.ok(existsSync(q.path), '生产回收也不碰夹具子目录');
});
