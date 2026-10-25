// 审阅接口的请求合并（2026-10-21 审查）：以前合并到在途那次 + 算完 2 秒内直接复用，
// 触发晚于改动的请求（一轮收尾、刚改完点刷新）可能拿到改动之前的快照。现在只合并「还没开始读 git 状态」的在途计算，
// 算完不留结果。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-dock-review-'));
process.env.BRIDGE_DATA_ROOT = path.join(tmp, 'data');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
mkdirSync(process.env.BRIDGE_DATA_ROOT, { recursive: true });

const { registerClaudeDockRoutes, _coalesceByWs } = await import('./claude-dock.mjs');

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

test('合并：没封口的在途计算可搭车；封口之后到的另算；算完不留结果', async () => {
  const run = _coalesceByWs();
  let n = 0;
  const gates = [];
  // 每次计算：先等一下（相当于头一次 rev-parse），封口，再等放行
  const compute = (ws, seal) => {
    const id = ++n;
    return (async () => {
      await tick(10);
      seal();
      await new Promise((r) => gates.push(r));
      return id;
    })();
  };
  const a = run('C:/Repo', compute);
  const b = run('c:/repo', compute);   // 同一 tick：搭车（Windows 下大小写折叠；别的平台各算各的也不影响后面断言）
  await tick(30);                      // 第一次已封口
  const c = run('C:/Repo', compute);   // 封口后到：另算
  await tick(30);
  gates.splice(0).forEach((r) => r());
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  assert.equal(ra, 1);
  if (process.platform === 'win32') assert.equal(rb, 1);
  assert.notEqual(rc, ra);
  // 算完再来：重新算
  const before = n;
  const d = run('C:/Repo', compute);
  await tick(30);
  gates.splice(0).forEach((r) => r());
  assert.equal(await d, before + 1);
});

test('合并：不封口的计算（dock/meta）在途期间都可搭车', async () => {
  const run = _coalesceByWs();
  let n = 0;
  let open;
  const compute = () => { n++; return new Promise((r) => { open = r; }); };
  const a = run('/w', compute);
  await tick(20);
  const b = run('/w', compute);
  open('x');
  assert.equal(await a, 'x');
  assert.equal(await b, 'x');
  assert.equal(n, 1);
});

test('审阅：上一次刚算完就新建文件，紧接着的请求要看到它；同时到的几个结果一致', async () => {
  const repo = path.join(tmp, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  writeFileSync(path.join(repo, 'a.txt'), 'x\n');
  execFileSync('git', ['-C', repo, 'add', '.']);
  execFileSync('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=a', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init']);

  const routes = new Map();
  registerClaudeDockRoutes({ on: (m, p, h) => routes.set(m + ' ' + p, h) }, { identify: () => ({ kind: 'admin', shell: true }) });
  const review = routes.get('GET /api/claude/review');
  const call = () => new Promise((resolve) => {
    const res = { writeHead() {}, setHeader() {}, end(b) { resolve(JSON.parse(String(b))); } };
    review({ headers: {} }, res, new URL('http://x/api/claude/review?ws=' + encodeURIComponent(repo)));
  });

  const r1 = await call();
  assert.deepEqual(r1.files.map((f) => f.path), []);
  writeFileSync(path.join(repo, 'new.txt'), '1\n2\n3\n');
  const r2 = await call();
  assert.deepEqual(r2.files.map((f) => f.path), ['new.txt']);
  assert.equal(r2.total.add, 3);
  // 在途那次已经开读之后又改了文件：后到的请求另算，看得到改动
  const p3 = call();
  await tick(400);
  writeFileSync(path.join(repo, 'more.txt'), 'm\n');
  const r4 = await call();
  await p3;
  assert.deepEqual(r4.files.map((f) => f.path).sort(), ['more.txt', 'new.txt']);
  const all = await Promise.all([call(), call(), call()]);
  for (const r of all) assert.deepEqual(r, all[0]);
  rmSync(tmp, { recursive: true, force: true });
});
