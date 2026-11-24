import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractUserRequestText,
  extractUserImageAtts,
  readTranscriptUserInputs,
  applyUserMedia,
} from './user-media.mjs';
import { stepsToAcpUpdates } from './subagents.mjs';
import { reconstructHistoryMessages } from './events.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-usermedia-'));
after(() => { rmSync(tmp, { recursive: true, force: true }); });

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('readTranscriptUserInputs 与 applyUserMedia：还原历史用户单图/多图、处理重复文案不误配并恢复原始文件名', () => {
  const dataDir = path.join(tmp, 'agy-data');
  const sid = '30f83b20-95f2-4abf-b61f-a0504d1cd344';
  const brainDir = path.join(dataDir, 'brain', sid);
  const upDir = path.join(brainDir, '.user_uploaded');
  const logDir = path.join(brainDir, '.system_generated', 'logs');
  mkdirSync(upDir, { recursive: true });
  mkdirSync(logDir, { recursive: true });

  const img1 = path.join(upDir, 'uploaded_media_1.png');
  const img2 = path.join(upDir, 'uploaded_media_2.jpg');
  const img3 = path.join(upDir, 'uploaded_media_3.jpg');
  const leaked = path.join(brainDir, '.system_generated', 'secret.png');
  writeFileSync(img1, PNG_1X1);
  writeFileSync(img2, PNG_1X1);
  writeFileSync(img3, PNG_1X1);
  writeFileSync(leaked, PNG_1X1);

  const lines = [
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\n继续\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nnow\n</ADDITIONAL_METADATA>',
      media: [],
    }),
    JSON.stringify({
      step_index: 5,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\n继续\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\nThe user has uploaded 2 images.\n</ADDITIONAL_METADATA>',
      media: [
        { mime_type: 'image/png', uri: img1.replace(/\\/g, '/') },
        { mime_type: 'image/jpeg', uri: img2.replace(/\\/g, '/') },
        // .system_generated 下的文件必须被过滤
        { mime_type: 'image/png', uri: leaked.replace(/\\/g, '/') },
      ],
    }),
    JSON.stringify({
      step_index: 9,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\n第三轮看这张图\n</USER_REQUEST>',
      media: [{ mime_type: 'image/jpeg', uri: img3 }],
    }),
  ];
  writeFileSync(path.join(logDir, 'transcript_full.jsonl'), lines.join('\n') + '\n', 'utf8');

  const inputs = readTranscriptUserInputs(dataDir, sid);
  assert.equal(inputs.length, 3);
  assert.equal(inputs[0].text, '继续');
  assert.equal(inputs[0].images.length, 0);
  assert.equal(inputs[1].images.length, 2, '只放行 .user_uploaded，拦截 .system_generated');

  // 模拟 session/load 回放（agy 不回放用户图片）
  const messages = [
    { role: 'user', text: '继续', images: [], blocks: [{ type: 'text', text: '继续' }] },
    { role: 'assistant', text: '收到1', thinking: '', tools: [], blocks: [{ type: 'text', text: '收到1' }] },
    { role: 'user', text: '继续', images: [], blocks: [{ type: 'text', text: '继续' }] },
    { role: 'assistant', text: '收到2', thinking: '', tools: [], blocks: [{ type: 'text', text: '收到2' }] },
    { role: 'user', text: '第三轮看这张图', images: [], blocks: [{ type: 'text', text: '第三轮看这张图' }] },
    { role: 'assistant', text: '收到3', thinking: '', tools: [], blocks: [{ type: 'text', text: '收到3' }] },
  ];

  // 侧车记录带着第二轮的原始文件名
  const uploadsDir = path.join(tmp, 'uploads');
  mkdirSync(uploadsDir, { recursive: true });
  const origA = path.join(uploadsDir, '1795000000001-架构图.png');
  const origB = path.join(uploadsDir, '1795000000002-细节.jpg');
  writeFileSync(origA, PNG_1X1);
  writeFileSync(origB, PNG_1X1);

  applyUserMedia(messages, {
    dataDir,
    sessionId: sid,
    meta: {
      userMedia: [{
        prompt: '继续',
        images: [
          { path: origA, name: '架构图.png', mimeType: 'image/png' },
          { path: origB, name: '细节.jpg', mimeType: 'image/jpeg' },
        ],
      }],
    },
    allowedRoots: [uploadsDir],
  });

  // 第一条「继续」不能被误挂图片；第二条「继续」的原图仍在 uploads 中，优先升级为无损原图并保留原文件名；
  // 第三条没有侧车原图，自然使用 .user_uploaded 副本。
  assert.equal(messages[0].images.length, 0);
  assert.equal(messages[2].images.length, 2);
  assert.equal(messages[2].images[0].path, origA);
  assert.equal(messages[2].images[0].name, '架构图.png');
  assert.equal(messages[2].images[1].path, origB);
  assert.equal(messages[2].images[1].name, '细节.jpg');
  assert.equal(messages[4].images.length, 1);
  assert.equal(messages[4].images[0].path, img3);

  // 若 uploads 原图已被清理，自动回退到 .user_uploaded 副本，并保留原文件名与 origPath（供前端对文本前缀去重）
  const deletedOrig = path.join(uploadsDir, '1795000000099-gone.png');
  const fbSid = '30f83b20-95f2-4abf-b61f-a0504d1cd355';
  const fbBrain = path.join(dataDir, 'brain', fbSid);
  const fbUp = path.join(fbBrain, '.user_uploaded');
  const fbLog = path.join(fbBrain, '.system_generated', 'logs');
  mkdirSync(fbUp, { recursive: true });
  mkdirSync(fbLog, { recursive: true });
  const fbImg1 = path.join(fbUp, 'uploaded_media_fb1.jpg');
  const fbImg2 = path.join(fbUp, 'uploaded_media_fb2.jpg');
  writeFileSync(fbImg1, PNG_1X1);
  writeFileSync(fbImg2, PNG_1X1);
  const fbPrompt = `本轮附加文件路径：\n- ${deletedOrig}\n- ${origB}\n\n继续`;
  writeFileSync(
    path.join(fbLog, 'transcript_full.jsonl'),
    JSON.stringify({
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: `<USER_REQUEST>\n${fbPrompt}\n</USER_REQUEST>`,
      media: [
        { mime_type: 'image/jpeg', uri: fbImg1.replace(/\\/g, '/') },
        { mime_type: 'image/jpeg', uri: fbImg2.replace(/\\/g, '/') },
      ],
    }) + '\n',
    'utf8',
  );
  const fbOnly = [{ role: 'user', text: fbPrompt, images: [], blocks: [{ type: 'text', text: fbPrompt }] }];
  applyUserMedia(fbOnly, {
    dataDir,
    sessionId: fbSid,
    meta: {
      userMedia: [{
        prompt: fbPrompt,
        images: [
          { path: deletedOrig, name: 'gone.png', mimeType: 'image/png' },
          { path: origB, name: '细节.jpg', mimeType: 'image/jpeg' },
        ],
      }],
    },
    allowedRoots: [uploadsDir],
  });
  assert.equal(fbOnly[0].images.length, 2);
  assert.equal(fbOnly[0].images[0].path, fbImg1, '原图缺失时回退 .user_uploaded 副本');
  assert.equal(fbOnly[0].images[0].name, 'gone.png');
  assert.equal(fbOnly[0].images[0].origPath, deletedOrig);
  assert.equal(fbOnly[0].images[1].path, origB, '仍在盘上的另一张图照常升级为无损原图');

  // live=true（在跑会话「本轮之前」历史）：transcript 已经写进了第 3 轮，但 messages 只有前两轮，不能错位
  const liveMsgs = [
    { role: 'user', text: '继续', images: [], blocks: [{ type: 'text', text: '继续' }] },
    { role: 'assistant', text: '收到1', thinking: '', tools: [], blocks: [] },
    { role: 'user', text: '继续', images: [{ mimeType: 'image/png', data: 'AAAA' }], blocks: [{ type: 'text', text: '继续' }] },
    { role: 'assistant', text: '收到2', thinking: '', tools: [], blocks: [] },
  ];
  applyUserMedia(liveMsgs, { dataDir, sessionId: sid, live: true });
  assert.equal(liveMsgs[0].images.length, 0);
  assert.equal(liveMsgs[2].images.length, 2);
  assert.equal(liveMsgs[2].images[0].path, img1, '有磁盘路径时用轻条目替换内存 base64');
  assert.equal(liveMsgs[2].images[0].data, undefined);
});

test('applyUserMedia：无 transcript 时走 meta.userMedia 兜底并校边界；纯图首轮被 session/load 省略时补回用户消息', () => {
  const uploadsDir = path.join(tmp, 'uploads-fallback');
  const outsideDir = path.join(tmp, 'outside-nope');
  mkdirSync(uploadsDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });

  const allowedImg = path.join(uploadsDir, '1795000000123-截图.png');
  const blockedImg = path.join(outsideDir, 'secret.png');
  writeFileSync(allowedImg, PNG_1X1);
  writeFileSync(blockedImg, PNG_1X1);

  const extracted = extractUserImageAtts([allowedImg], [{ path: allowedImg, name: '我的截图.png' }]);
  assert.equal(extracted.length, 1);
  assert.equal(extracted[0].name, '我的截图.png');
  assert.equal(extracted[0].mimeType, 'image/png');

  // 1) 无 transcript：靠 meta.userMedia 恢复允许目录内的图，拦截目录外的图
  const msgs1 = [
    { role: 'user', text: '看看这张图', images: [], blocks: [{ type: 'text', text: '看看这张图' }] },
    { role: 'assistant', text: '好的', thinking: '', tools: [], blocks: [] },
  ];
  applyUserMedia(msgs1, {
    dataDir: '',
    sessionId: 'fake-sid',
    meta: {
      userMedia: [{
        prompt: '看看这张图',
        images: [
          { path: allowedImg, name: '我的截图.png', mimeType: 'image/png' },
          { path: blockedImg, name: 'secret.png', mimeType: 'image/png' },
        ],
      }],
    },
    allowedRoots: [uploadsDir],
  });
  assert.equal(msgs1[0].images.length, 1);
  assert.equal(msgs1[0].images[0].path, allowedImg);
  assert.equal(msgs1[0].images[0].name, '我的截图.png');

  // 2) 纯发图不打字且 session/load 没吐 user_message_chunk：首条 assistant 前自动补回纯图 user 消息
  const msgs2 = [
    { role: 'assistant', text: '这是一张图。', thinking: '', tools: [], blocks: [{ type: 'text', text: '这是一张图。' }] },
  ];
  applyUserMedia(msgs2, {
    dataDir: '',
    sessionId: 'fake-sid-2',
    meta: {
      userMedia: [{
        prompt: '',
        images: [{ path: allowedImg, name: '纯图.png', mimeType: 'image/png' }],
      }],
    },
    allowedRoots: [uploadsDir],
    live: false,
  });
  assert.equal(msgs2.length, 2);
  assert.equal(msgs2[0].role, 'user');
  assert.equal(msgs2[0].text, '');
  assert.equal(msgs2[0].images.length, 1);
  assert.equal(msgs2[0].images[0].path, allowedImg);
});

test('stepsToAcpUpdates（includeUser:true）：剥离 USER_REQUEST 包装并保留用户图片块', () => {
  assert.equal(extractUserRequestText('<USER_REQUEST>\n你好\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>').trim(), '你好');

  const steps = [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      content: '<USER_REQUEST>\n帮我看图\n</USER_REQUEST>\n<ADDITIONAL_METADATA>ts</ADDITIONAL_METADATA>',
      media: [{ mime_type: 'image/jpeg', uri: 'C:/brain/s1/.user_uploaded/a.jpg' }],
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      content: '看到了。',
    },
  ];
  const converted = stepsToAcpUpdates(steps, 's1', { includeUser: true, platform: 'win32' });
  const hist = reconstructHistoryMessages(converted.updates, 'win32');
  assert.equal(hist.messages.length, 2);
  assert.equal(hist.messages[0].role, 'user');
  assert.equal(hist.messages[0].text, '帮我看图');
  assert.equal(hist.messages[0].images.length, 1);
  assert.equal(hist.messages[0].images[0].path, 'C:\\brain\\s1\\.user_uploaded\\a.jpg');
  assert.equal(hist.messages[0].images[0].mimeType, 'image/jpeg');
});

test('buildPromptBlocks：图片同时输出 ACP image 块与无损原图路径前缀，并与非图片文件去重共存', async () => {
  const { buildPromptBlocks } = await import('./agents/agy.mjs');
  const dir = path.join(tmp, 'prompt-blocks');
  mkdirSync(dir, { recursive: true });
  const img = path.join(dir, '1795000000777-chart.png');
  const doc = path.join(dir, '1795000000778-notes.pdf');
  writeFileSync(img, PNG_1X1);
  writeFileSync(doc, 'pdf', 'utf8');

  const blocks = buildPromptBlocks('看看这张长图', [img, img, doc]);
  assert.equal(blocks.length, 2, '1 个文本块 + 1 个去重后的图片块');
  assert.equal(blocks[0].type, 'text');
  assert.ok(blocks[0].text.startsWith('本轮附加文件路径：\n- '));
  assert.ok(blocks[0].text.includes(img));
  assert.ok(blocks[0].text.includes(doc));
  assert.ok(blocks[0].text.endsWith('\n\n看看这张长图'));
  assert.equal(blocks[1].type, 'image');
  assert.equal(blocks[1].mimeType, 'image/png');
  assert.equal(blocks[1].data, PNG_1X1.toString('base64'));

  // 纯发图不打字时同样保留文本原图路径前缀与 image 块
  const imgOnly = buildPromptBlocks('', [img]);
  assert.equal(imgOnly.length, 2);
  assert.equal(imgOnly[0].type, 'text');
  assert.equal(imgOnly[0].text, `本轮附加文件路径：\n- ${img}`);
  assert.equal(imgOnly[1].type, 'image');
});
