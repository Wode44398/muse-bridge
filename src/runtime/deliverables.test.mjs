// 交付物根守卫：沙箱身份锁在交付根内；admin 不受限（它本来就有整机 shell）。
// 场景：admin 会话正文链接指向 vault 之外的文件（如 dimensio 快照对话目录里的 .md），
// 附件卡不出、点开 403「加载失败」。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { collectDeliverables, deliverAnywhere } from './deliverables.mjs';

test('vault 之外的绝对路径：admin 出附件卡，沙箱身份照旧不出', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-deliver-'));
  try {
    const cwd = path.join(tmp, 'project');
    const outside = path.join(tmp, 'elsewhere');
    fs.mkdirSync(cwd);
    fs.mkdirSync(outside);
    const file = path.join(outside, '实现分析.md');
    fs.writeFileSync(file, '# x');
    const text = `原文在这里：[分析](<${file.split(path.sep).join('/')}>)`;
    const roots = [cwd];

    const admin = collectDeliverables(text, { cwd, roots, anywhere: deliverAnywhere({ kind: 'admin' }) });
    assert.equal(admin.length, 1);
    assert.equal(fs.realpathSync(admin[0].path), fs.realpathSync(file));

    assert.equal(collectDeliverables(text, { cwd, roots, anywhere: deliverAnywhere({ kind: 'user', sandbox: true }) }).length, 0);
    assert.equal(collectDeliverables(text, { cwd, roots, anywhere: deliverAnywhere({ kind: 'snap', sandbox: true }) }).length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deliverAnywhere 只认 admin', () => {
  assert.equal(deliverAnywhere({ kind: 'admin' }), true);
  for (const kind of ['user', 'share', 'snap']) assert.equal(deliverAnywhere({ kind, sandbox: true }), false);
  assert.equal(deliverAnywhere(null), false);
});
