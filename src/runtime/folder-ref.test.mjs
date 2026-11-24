import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { filterAttachmentPaths } from './attachment-guard.mjs';
import { splitAttachments, liveUserAtts, toClientAtt } from './client-atts.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-folder-ref-'));
const ws = path.join(tmp, 'my-workspace');
const uploads = path.join(tmp, 'uploads');
const outside = path.join(tmp, 'outside');
mkdirSync(ws, { recursive: true });
mkdirSync(uploads, { recursive: true });
mkdirSync(outside, { recursive: true });
const fileInWs = path.join(ws, 'readme.md');
writeFileSync(fileInWs, '# hi');

after(() => {
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

test('filterAttachmentPaths：exactRoots 放行已授权工作空间根目录本身，不放行 uploads 根或越界目录', () => {
  const kept = filterAttachmentPaths([ws, fileInWs, uploads, outside], {
    allowAnywhere: false,
    roots: [uploads, ws],
    exactRoots: [ws],
  });
  assert.deepEqual(kept, [ws, fileInWs]);
});

test('client-atts：还原并保留本地文件夹引用 kind:folder（不剥离数字前缀）', () => {
  const prompt = '看看这个目录\n\n[用户上传了以下附件，请按需读取]\n- D:\\Notes\\2026-notes  ← 文件夹';
  const sp = splitAttachments(prompt);
  assert.equal(sp.text, '看看这个目录');
  assert.deepEqual(sp.attachments, [
    { file: '2026-notes', name: '2026-notes', raw: 'D:\\Notes\\2026-notes', kind: 'folder' },
  ]);

  const clientAtt = toClientAtt(sp.attachments[0], { uploads, cwd: ws });
  assert.deepEqual(clientAtt, { name: '2026-notes', kind: 'folder' });

  const live = liveUserAtts([ws], { uploads, cwd: ws });
  assert.deepEqual(live, [{ name: 'my-workspace', kind: 'folder' }]);
});
