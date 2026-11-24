import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attLook, attMeta, clampRatio, fmtBytes, splitAttachedPaths, parseAgyQuoteFile,
  draftAttDescriptor, buildDraftMediaGallery,
} from './attach-look.js';

test('图片 / 视频画预览图，其余画类型卡', () => {
  assert.equal(attLook({ name: 'a.PNG', path: 'C:\\x\\a.PNG' }).media, 'image');
  assert.equal(attLook({ name: 'clip.mp4' }).media, 'video');
  assert.equal(attLook({ name: 'r.pdf' }).media, '');
  assert.equal(attLook({ name: 'song.mp3' }).media, '');
  // 粘贴的截图可能没有扩展名：按上传时标的 kind 认
  assert.equal(attLook({ name: 'pasted', kind: 'image' }).media, 'image');
  // 文件夹永远是卡，即使名字像图片
  assert.equal(attLook({ name: 'shots.png', kind: 'folder' }).media, '');
});

test('类型卡的字形与色系', () => {
  assert.deepEqual([attLook({ name: 'a.docx' }).glyph, attLook({ name: 'a.docx' }).tone], ['doc', 'blue']);
  assert.deepEqual([attLook({ name: 'a.xlsx' }).glyph, attLook({ name: 'a.xlsx' }).tone], ['sheet', 'green']);
  assert.deepEqual([attLook({ name: 'a.pptx' }).glyph, attLook({ name: 'a.pptx' }).tone], ['slide', 'yellow']);
  assert.equal(attLook({ name: 'a.pdf' }).tone, 'red');
  assert.deepEqual([attLook({ name: 'a.json' }).glyph, attLook({ name: 'a.json' }).tone], ['code', 'neutral']);
  assert.equal(attLook({ name: 'a.zip' }).glyph, 'zip');
  assert.equal(attLook({ name: 'x', kind: 'folder' }).glyph, 'folder');
  assert.equal(attLook({ name: 'a.unknownext' }).glyph, 'file');
});

test('标题去扩展名、副行是「扩展名 · 大小」', () => {
  const look = attLook({ name: '季度 报告 (终).pdf', size: 1258291 });
  assert.equal(look.stem, '季度 报告 (终)');
  assert.equal(look.ext, 'pdf');
  assert.equal(attMeta(look), 'PDF · 1.2 MB');
  assert.equal(attMeta(attLook({ name: 'src', kind: 'folder' }), { folderWord: '文件夹' }), '文件夹');
  assert.equal(attMeta(attLook({ name: 'LICENSE' }), { fileWord: '文件' }), '文件');
  // 只有路径没有名字：取路径最后一段
  assert.equal(attLook({ path: 'C:/work/out/图.png' }).name, '图.png');
  // 点开头的文件名不当成「全是扩展名」
  assert.equal(attLook({ name: '.env' }).stem, '.env');
});

test('fmtBytes', () => {
  assert.equal(fmtBytes(0), '0 B');
  assert.equal(fmtBytes(1023), '1023 B');
  assert.equal(fmtBytes(1024), '1 KB');
  assert.equal(fmtBytes(1536), '1.5 KB');
  assert.equal(fmtBytes(250 * 1024 * 1024), '250 MB');
  assert.equal(fmtBytes(undefined), '');
  assert.equal(fmtBytes(-1), '');
});

test('clampRatio 把过瘦过扁的图收进范围', () => {
  assert.equal(clampRatio(1600, 900), 1.778);
  assert.equal(clampRatio(300, 3000), 0.62);
  assert.equal(clampRatio(5000, 500), 2.1);
  assert.equal(clampRatio(0, 0), 1.5);
});

test('splitAttachedPaths 还原服务端拼的附件前缀', () => {
  const raw = '本轮附加文件路径：\n- C:\\up\\17000-demo.mp4\n- C:\\work\\资料\n- C:\\up\\a.png\n\n帮我看看这些';
  const r = splitAttachedPaths(raw);
  assert.equal(r.text, '帮我看看这些');
  assert.deepEqual(r.atts, [
    { path: 'C:\\up\\17000-demo.mp4', name: '17000-demo.mp4', kind: 'file' },
    { path: 'C:\\work\\资料', name: '资料', kind: 'folder' },
    { path: 'C:\\up\\a.png', name: 'a.png', kind: 'image' },
  ]);
  // 只有附件、没写话
  assert.deepEqual(splitAttachedPaths('本轮附加文件路径：\n- /srv/x/report.pdf'), {
    text: '',
    atts: [{ path: '/srv/x/report.pdf', name: 'report.pdf', kind: 'file' }],
  });
  // 上传存盘名的时间戳前缀不给人看（路径原样留着）
  assert.deepEqual(splitAttachedPaths('本轮附加文件路径：\n- C:/up/1795102601189-季度报告.pdf').atts, [
    { path: 'C:/up/1795102601189-季度报告.pdf', name: '季度报告.pdf', kind: 'file' },
  ]);
  // 认得的无扩展名文件不当文件夹
  assert.equal(splitAttachedPaths('本轮附加文件路径：\n- /srv/x/Dockerfile\n\n看下').atts[0].kind, 'file');
});

test('splitAttachedPaths 不碰普通文字', () => {
  assert.deepEqual(splitAttachedPaths('你好'), { text: '你好', atts: [] });
  assert.deepEqual(splitAttachedPaths('本轮附加文件路径：就这一行'), { text: '本轮附加文件路径：就这一行', atts: [] });
  assert.deepEqual(splitAttachedPaths('本轮附加文件路径：\n没有列表'), { text: '本轮附加文件路径：\n没有列表', atts: [] });
  assert.deepEqual(splitAttachedPaths(null), { text: '', atts: [] });
});

test('draftAttDescriptor 与 buildDraftMediaGallery 覆盖图片/视频/恢复草稿与非媒体文件', () => {
  const imgUploading = { path: '', name: 'shot.png', kind: 'image', url: 'blob:img1', pending: true };
  const imgDone = { path: 'C:\\data\\uploads\\1795-cat.jpg', name: 'cat.jpg', kind: 'image', url: 'blob:img2', pending: false };
  const imgRestored = { path: 'C:\\data\\uploads\\1795-restored.png', name: 'restored.png', kind: 'image', url: '/api/agy/artifact?path=x', pending: false };
  const vidUploading = { path: '', name: 'clip.mp4', kind: 'file', url: 'blob:vid1', pending: true };
  const vidDone = { path: 'C:\\data\\uploads\\1795-demo.mp4', name: 'demo.mp4', kind: 'file', url: 'blob:vid2', pending: false };
  const vidRestored = { path: 'C:\\data\\uploads\\1795-saved.webm', name: 'saved.webm', kind: 'file', url: '', pending: false };
  const pdfUploading = { path: '', name: 'doc.pdf', kind: 'file', url: '', pending: true };
  const pdfDone = { path: 'C:\\data\\uploads\\1795-doc.pdf', name: 'doc.pdf', kind: 'file', url: '', pending: false };
  const folderAtt = { path: 'C:\\work\\src', name: 'src', kind: 'folder', url: '', pending: false };

  // 图片有本地 blob 时直接零网络预览（含上传中）
  assert.deepEqual(draftAttDescriptor(imgUploading), {
    origin: 'url', key: 'agy-draft:blob:img1', url: 'blob:img1', name: 'shot.png', kind: 'image',
  });
  assert.deepEqual(draftAttDescriptor(imgDone), {
    origin: 'url', key: 'agy-draft:C:\\data\\uploads\\1795-cat.jpg', url: 'blob:img2', name: 'cat.jpg', kind: 'image',
  });
  // 刷新后恢复的图片草稿（无 blob）走 upload
  assert.deepEqual(draftAttDescriptor(imgRestored), {
    origin: 'upload', key: 'att:1795-restored.png', file: '1795-restored.png', name: 'restored.png', kind: 'image',
  });

  // 视频上传中播本地 blob，传完走 upload Range 流，刷新恢复也走 upload
  assert.deepEqual(draftAttDescriptor(vidUploading), {
    origin: 'url', key: 'agy-draft:blob:vid1', url: 'blob:vid1', name: 'clip.mp4', kind: 'video',
  });
  assert.deepEqual(draftAttDescriptor(vidDone), {
    origin: 'upload', key: 'att:1795-demo.mp4', file: '1795-demo.mp4', name: 'demo.mp4', kind: 'video',
  });
  assert.deepEqual(draftAttDescriptor(vidRestored), {
    origin: 'upload', key: 'att:1795-saved.webm', file: '1795-saved.webm', name: 'saved.webm', kind: 'video',
  });

  // 普通文件上传中不可点，传完走 upload；文件夹永不预览
  assert.equal(draftAttDescriptor(pdfUploading), null);
  assert.deepEqual(draftAttDescriptor(pdfDone), {
    origin: 'upload', key: 'att:1795-doc.pdf', file: '1795-doc.pdf', name: 'doc.pdf',
  });
  assert.equal(draftAttDescriptor(folderAtt), null);

  // 工作空间内的视频/图片在无 sessionId 时走 cloud 预览
  const wsVid = { path: 'E:\\proj\\assets\\intro.mp4', name: 'intro.mp4', kind: 'file', url: '', pending: false };
  assert.deepEqual(draftAttDescriptor(wsVid, { sessionCwd: 'E:\\proj' }), {
    origin: 'cloud', key: 'agy-ws:E:\\proj:assets/intro.mp4', rel: 'assets/intro.mp4', ws: 'E:\\proj', name: 'intro.mp4', kind: 'video',
  });

  // 画廊仅收入图片与视频，并把 originRect 挂在被点击那一项
  const rect = { x: 10, y: 20, w: 56, h: 56 };
  const g = buildDraftMediaGallery([imgUploading, pdfDone, vidDone, folderAtt, imgRestored], vidDone, { originRect: rect });
  assert.equal(g.index, 1);
  assert.equal(g.items.length, 3);
  assert.deepEqual(g.items[1].originRect, rect);
  assert.equal(g.items[0].originRect, undefined);
  assert.equal(buildDraftMediaGallery([pdfDone], pdfDone), null);
});

test('引用对话卡与服务端标注（← 文件夹 / ← 引用的对话）还原', () => {
  const look = attLook({ name: '老对话', kind: 'chat', quoteId: 's-1' });
  assert.equal(look.isChat, true);
  assert.equal(look.glyph, 'chat');
  assert.equal(look.tone, 'blue');
  assert.equal(attMeta(look, { chatWord: '引用对话' }), '引用对话');

  assert.deepEqual(parseAgyQuoteFile('1795102601189-chatref-abc-123--讨论记录.md'), { id: 'abc-123', title: '讨论记录' });

  const raw = '本轮附加文件路径：\n- D:\\Notes\\2026-project  ← 文件夹\n- C:\\up\\1795102601189-chatref-abc-123--讨论记录.md  ← 引用的对话\n\n继续聊';
  const r = splitAttachedPaths(raw);
  assert.equal(r.text, '继续聊');
  assert.deepEqual(r.atts, [
    { path: 'D:\\Notes\\2026-project', name: '2026-project', kind: 'folder' },
    { path: 'C:\\up\\1795102601189-chatref-abc-123--讨论记录.md', name: '讨论记录', kind: 'chat', quoteId: 'abc-123' },
  ]);
});
