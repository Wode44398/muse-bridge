import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseAgyQuoteFile,
  extractAgyTurns,
  agySessionMarkdown,
  quoteAgySession,
} from './session-quote.mjs';
import { markSessionDeleted } from './sessions.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-quote-'));
const agyDir = path.join(tmp, 'agy');
const uploads = path.join(tmp, 'uploads');
const ctx = { agyDir, uploads };

after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('parseAgyQuoteFile 与 extractAgyTurns', () => {
  const parsed = parseAgyQuoteFile('1795102601189-chatref-550e8400-e29b-41d4-a716-446655440000--方案对比.md');
  assert.deepEqual(parsed, { id: '550e8400-e29b-41d4-a716-446655440000', title: '方案对比' });
  assert.equal(parseAgyQuoteFile('1795102601189-notes.md'), null);

  const turns = extractAgyTurns([
    { role: 'user', text: '本轮附加文件路径：\n- E:\\work\\a.png\n\n看看这张图' },
    { role: 'assistant', text: '好的，已经看过了。' },
    { role: 'assistant', text: '   ' },
  ]);
  assert.deepEqual(turns, [
    { role: 'user', text: '看看这张图' },
    { role: 'assistant', text: '好的，已经看过了。' },
  ]);

  const md = agySessionMarkdown(turns, { id: 'sess-1', title: '看图讨论', at: new Date('2026-11-23T10:00:00Z') }).join('\n');
  assert.ok(md.includes('## 我'));
  assert.ok(md.includes('## Antigravity'));
  assert.ok(md.includes('看看这张图'));
});

test('quoteAgySession 导出 Markdown 并拦截空会话与已删会话', async () => {
  const res = await quoteAgySession(ctx, { id: 'sess-demo-1234', title: 'A/B 方案对比' }, {
    loadDetail: async () => ({
      title: '原标题',
      messages: [
        { role: 'user', text: '帮我对比 A 和 B' },
        { role: 'assistant', text: 'A 更快，B 更省内存。' },
      ],
    }),
  });
  assert.equal(res.ok, true);
  assert.equal(res.count, 2);
  assert.equal(res.name, 'A B 方案对比');
  assert.deepEqual(parseAgyQuoteFile(res.file), { id: 'sess-demo-1234', title: 'A B 方案对比' });
  const body = readFileSync(res.path, 'utf8');
  assert.ok(body.includes('帮我对比 A 和 B'));

  // 空对话 → 422
  await assert.rejects(
    () => quoteAgySession(ctx, { id: 'sess-empty' }, { loadDetail: async () => ({ messages: [] }) }),
    (err) => err?.status === 422,
  );

  // 已删除对话 → 404
  markSessionDeleted(agyDir, 'sess-gone');
  await assert.rejects(
    () => quoteAgySession(ctx, { id: 'sess-gone' }, { loadDetail: async () => ({ messages: [{ role: 'user', text: 'hi' }] }) }),
    (err) => err?.status === 404,
  );
});
