// 在跑轮台账 + 「被中断」留痕（runtime/inflight.mjs）：
// ① 开跑写台账、收尾销账——正常收尾的轮不该被下次启动误判成孤儿；
// ② 进程死在中途（台账里还留着记录）→ 下次 initInflight 在 transcript 尾部追加一条
//    与 CLI 自己写的 API Error 记录同构的合成消息，并留下 attach 用的中断标记；
// ③ 幂等：同一份 transcript 反复收尸只留一条标记；
// ④ 会话重新开跑 → 中断标记作废（否则 attach 会拿旧标记去掐新一轮）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initInflight, beginInflight, endInflight, interruptedRun, clearInterrupted } from './runtime/inflight.mjs';

const SESSION = '11111111-2222-3333-4444-555555555555';

// 造一份最小可用的 transcript：一条 user + 一条 assistant，位置与 SDK 的 PROJECTS_DIR 布局一致。
function makeWorld() {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'inflight-'));
  const dataRoot = path.join(tmp, 'data');
  const configDir = path.join(tmp, 'claudecfg');
  const cwd = path.join(tmp, 'ws');
  mkdirSync(dataRoot, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const projDir = path.join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(projDir, { recursive: true });
  const file = path.join(projDir, SESSION + '.jsonl');
  writeFileSync(file, [
    JSON.stringify({ type: 'user', uuid: 'u-1', sessionId: SESSION, cwd, version: '2.1.220', gitBranch: 'main', message: { role: 'user', content: [{ type: 'text', text: '干活' }] } }),
    JSON.stringify({ type: 'assistant', uuid: 'a-1', sessionId: SESSION, cwd, version: '2.1.220', gitBranch: 'main', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } }),
  ].join('\n') + '\n');
  return { dataRoot, configDir, cwd, file };
}

const rec = (w) => ({ key: 'admin', sessionId: SESSION, userText: '干活', startedAt: Date.now(), cwd: w.cwd, configDir: w.configDir });
const lines = (f) => readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const marks = (f) => lines(f).filter((o) => o.error === 'bridge_interrupted');

test('正常收尾的轮不留孤儿', () => {
  const w = makeWorld();
  initInflight(w.dataRoot);
  beginInflight(rec(w));
  assert.equal(JSON.parse(readFileSync(path.join(w.dataRoot, 'inflight-runs.json'), 'utf8')).length, 1);
  endInflight('admin', SESSION);
  assert.equal(JSON.parse(readFileSync(path.join(w.dataRoot, 'inflight-runs.json'), 'utf8')).length, 0);

  // 下一条命启动：台账空 → 不该动 transcript，也不该留中断标记
  const orphans = initInflight(w.dataRoot);
  assert.equal(orphans.length, 0);
  assert.equal(marks(w.file).length, 0);
  assert.equal(interruptedRun('admin', SESSION), null);
});

test('死在中途 → transcript 留痕 + attach 标记，且幂等', () => {
  const w = makeWorld();
  initInflight(w.dataRoot);
  beginInflight(rec(w));           // 开跑…然后进程「死了」：不调 endInflight

  const orphans = initInflight(w.dataRoot);   // 下一条命启动收尸
  assert.equal(orphans.length, 1);

  const all = lines(w.file);
  const mark = all[all.length - 1];
  assert.equal(mark.type, 'assistant');
  assert.equal(mark.message.model, '<synthetic>');    // 与 CLI 的错误气泡同构
  assert.equal(mark.isApiErrorMessage, true);
  assert.equal(mark.parentUuid, 'a-1');               // 挂在原来的最后一条记录上，链不断
  assert.equal(mark.sessionId, SESSION);
  assert.match(mark.message.content[0].text, /没跑完/);
  assert.ok(interruptedRun('admin', SESSION), '应留下 attach 用的中断标记');

  // 台账已清空：同一条孤儿不会在下一次启动被重复收尸
  assert.equal(JSON.parse(readFileSync(path.join(w.dataRoot, 'inflight-runs.json'), 'utf8')).length, 0);

  // 再收一次尸（模拟连续两次重启）：transcript 尾部已有标记 → 不重复追加
  beginInflight(rec(w));
  initInflight(w.dataRoot);
  assert.equal(marks(w.file).length, 1);
});

test('会话重新开跑 → 中断标记作废；attach 播过一次即清', () => {
  const w = makeWorld();
  initInflight(w.dataRoot);
  beginInflight(rec(w));
  initInflight(w.dataRoot);
  assert.ok(interruptedRun('admin', SESSION));

  beginInflight(rec(w));                       // 新一轮开跑
  assert.equal(interruptedRun('admin', SESSION), null, '旧标记必须让位给新一轮，否则 attach 会掐掉正在跑的轮');

  endInflight('admin', SESSION);
  initInflight(w.dataRoot);
  assert.equal(interruptedRun('admin', SESSION), null, '已销账的轮不该再被当成中断');
});

test('transcript 不存在时不抛，只是没有留痕', () => {
  const w = makeWorld();
  initInflight(w.dataRoot);
  beginInflight({ ...rec(w), sessionId: '99999999-8888-7777-6666-555555555555' });
  assert.doesNotThrow(() => initInflight(w.dataRoot));
  assert.ok(existsSync(w.file));
  assert.equal(marks(w.file).length, 0);
});

test('中断标记按 caller 分区：别的身份拿同一个会话 id 探不到', () => {
  const w = makeWorld();
  initInflight(w.dataRoot);
  beginInflight(rec(w));                       // key='admin'
  initInflight(w.dataRoot);
  assert.ok(interruptedRun('admin', SESSION));
  assert.equal(interruptedRun('u:someone', SESSION), null, '换个身份不该看见别人那一轮');
  clearInterrupted('admin', SESSION);
});

test('attach 播过之后标记清掉，不会每次重连都再播一遍', () => {
  const w = makeWorld();
  initInflight(w.dataRoot);
  beginInflight(rec(w));
  initInflight(w.dataRoot);
  assert.ok(interruptedRun('admin', SESSION));
  clearInterrupted('admin', SESSION);
  assert.equal(interruptedRun('admin', SESSION), null);
});
