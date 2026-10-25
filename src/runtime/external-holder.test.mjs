import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExternalHolder } from './external-holder.mjs';

function withReg(entries, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'cc-reg-'));
  try {
    for (const e of entries) writeFileSync(path.join(dir, `${e.pid}.json`), JSON.stringify(e));
    writeFileSync(path.join(dir, 'garbage.json'), '{');
    return fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const SID = '11111111-2222-3333-4444-555555555555';
// 用父进程 pid 当「活着的外部进程」（必定存在、又不是本进程）。
const LIVE = process.ppid;

test('Desktop 活进程持有 → 报出持有者', () => withReg(
  [{ pid: LIVE, sessionId: SID, entrypoint: 'claude-desktop', status: 'busy', name: 'x' }],
  (dir) => {
    const h = findExternalHolder(SID, dir);
    assert.equal(h?.label, 'Claude Desktop');
    assert.equal(h?.status, 'busy');
  }));

test('bridge 自己的 sdk-ts 进程不算外部持有', () => withReg(
  [{ pid: LIVE, sessionId: SID, entrypoint: 'sdk-ts', status: 'busy' }],
  (dir) => assert.equal(findExternalHolder(SID, dir), null)));

test('进程已死的残留登记不算', () => withReg(
  [{ pid: 2147480000, sessionId: SID, entrypoint: 'cli', status: 'idle' }],
  (dir) => assert.equal(findExternalHolder(SID, dir), null)));

test('别的会话 / 注册表目录不存在 → null', () => {
  withReg([{ pid: LIVE, sessionId: 'other', entrypoint: 'cli' }],
    (dir) => assert.equal(findExternalHolder(SID, dir), null));
  assert.equal(findExternalHolder(SID, path.join(os.tmpdir(), 'no-such-reg-dir-xyz')), null);
});
