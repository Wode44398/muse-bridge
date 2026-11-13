// 手册检索（manual.mjs 的 manualSearch / manualChapter）：按操作名查参数一定查得到——
// 查询里带操作名时该操作的参数表置顶（不靠打分），topic 填操作名也回它；超长小节按 ### 切开、不再截断。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-manual-search-'));
process.env.BRIDGE_DATA_ROOT = tmp;
process.env.BRIDGE_USERS_ROOT = path.join(tmp, 'users');
process.env.VAULT_PATH = path.join(tmp, 'vault');
process.env.BRIDGE_CLAUDE_IN_CHROME = '0';
mkdirSync(process.env.VAULT_PATH, { recursive: true });
writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ port: 8787, token: 'x'.repeat(32) }, null, 2));

await import('./ops/index.mjs');
const { allOps, allGroups } = await import('./registry.mjs');
const { manualSearch, manualChapter, manualOp } = await import('./manual.mjs');

const ORIGIN = 'https://x';
const ADMIN = { kind: 'admin', agents: ['claude'], shell: true };

test('每个操作按名字检索，第一条就是它的完整参数表', () => {
  for (const op of allOps()) {
    const r = manualSearch(op.name, ADMIN, ORIGIN, { limit: 4 });
    assert.equal(r[0]?.section, '操作 ' + op.name, op.name);
    assert.equal(r[0].chapter, 'api');
    for (const k of Object.keys(op.params || {})) assert.ok(r[0].markdown.includes('`' + k + '`'), `${op.name} 的参数 ${k} 没出现`);
    assert.ok(r.length <= 4);
  }
});

test('操作名夹在句子里也置顶；没有这个操作的不置顶', () => {
  const r = manualSearch('ui.open 参数 打开文件', ADMIN, ORIGIN, { limit: 4 });
  assert.equal(r[0].section, '操作 ui.open');
  assert.ok(r.length > 1, '剩下的名额照常由关键词检索补上');
  assert.equal(manualSearch('用 routines.create 建一个每天的任务', ADMIN, ORIGIN)[0].section, '操作 routines.create');
  assert.ok(!manualSearch('files.md', ADMIN, ORIGIN).some((x) => x.score === 999));
  // 单字操作名只在整句就是它时置顶，免得「schedule manual」被 manual 操作占掉一格
  assert.ok(!manualSearch('schedule manual', ADMIN, ORIGIN).some((x) => x.section === '操作 manual'));
  const two = manualSearch('routines.create routines.update', ADMIN, ORIGIN, { limit: 1 });
  assert.equal(two.length, 1, 'limit 照样封顶');
});

test('topic 填操作名回该操作的参数表；章 id 优先；都不是回 null', () => {
  const c = manualChapter('routines.create', ADMIN, ORIGIN);
  assert.equal(c.id, 'routines.create');
  assert.match(c.markdown, /`schedule`/);
  assert.equal(manualChapter('overview', ADMIN, ORIGIN).title.startsWith('操作'), false, 'overview 是章也是操作，章优先');
  assert.equal(manualChapter('no.such_op', ADMIN, ORIGIN), null);
  assert.match(manualOp('whoami', null), /参数：无/);
});

test('「全部操作」按组切成小段、不再截断；中文检索不受影响', () => {
  const parts = manualSearch('全部操作', ADMIN, ORIGIN, { limit: 100 }).filter((x) => x.chapter === 'api');
  for (const g of allGroups()) {
    if (allOps().some((op) => op.group === g.id)) assert.ok(parts.some((x) => x.section === `全部操作 › ${g.title}（${g.id}）`), g.id + ' 组没切出来');
  }
  for (const x of parts) assert.doesNotMatch(x.markdown, /本节太长/, x.section);
  assert.equal(manualSearch('怎么改壁纸', ADMIN, ORIGIN)[0].chapter, 'settings');
});
