import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = path.join(HERE, 'testing', 'fake-acp-agent.mjs');

const tmp = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-prompt-blocks-')));
process.env.BRIDGE_DATA_ROOT = path.join(tmp, 'data');
process.env.AGY_BIN = FAKE_AGENT;

const { buildPromptPlan, buildPromptBlocks, TEXT_INLINE_MAX_BYTES, INLINE_BUDGET_BYTES } = await import('./agents/agy/prompt-blocks.mjs');
const { uploadDirsForAttachments } = await import('./agents/agy/attachment-dirs.mjs');
const { extractAgyTurns } = await import('./session-quote.mjs');
const { AcpClient } = await import('./acp/client.mjs');

const clients = [];
after(() => {
  for (const c of clients) { try { c.shutdown(); } catch {} }
  // 数据根下的目录被核心挂了 fs.watch：Windows 上删掉被监视的目录本身，句柄不释放、进程退不出（同 routes.test.mjs），只清别的
  for (const name of readdirSync(tmp)) {
    if (name !== 'data') rmSync(path.join(tmp, name), { recursive: true, force: true });
  }
});

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const dir = path.join(tmp, 'atts');
mkdirSync(dir, { recursive: true });
const f = (name, data) => { const p = path.join(dir, name); writeFileSync(p, data); return p; };
const img = f('1795000000001-shot.png', PNG_1X1);
const mp3 = f('1795000000002-voice.mp3', Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00]));
const pdf = f('1795000000003-paper.pdf', Buffer.from('%PDF-1.4\n%\xff\xfe\n', 'latin1'));
const mp4 = f('1795000000004-clip.mp4', Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
const md = f('1795000000005-notes.md', '# 标题\n正文\n');
const ts = f('1795000000006-main.ts', 'export const a = 1;\n');
const docx = f('1795000000007-report.docx', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]));
const bin = f('1795000000008-blob.dat', Buffer.from([1, 2, 0, 3]));
const quote = f('1795000000009-chatref-abcd1234--旧对话.md', '# 引用\n');
const folder = path.join(dir, 'sub-folder');
mkdirSync(folder, { recursive: true });

const ALL = [img, mp3, pdf, mp4, md, ts, docx, bin, quote, folder];
const lineOf = (text, p) => text.split('\n').find((l) => l.startsWith('- ' + p));
const byUri = (blocks, p) => blocks.find((b) => b.type === 'resource' && b.resource.uri === pathToFileURL(p).href);

test('能力齐全：图片走 image、音频走 audio、视频 / PDF 走 resource blob、文本走 resource text，其余标 read_file', () => {
  const { blocks, fallback } = buildPromptPlan('看看这些', ALL, { caps: { image: true, audio: true, embeddedContext: true } });
  const text = blocks[0].text;
  assert.equal(blocks[0].type, 'text');
  assert.ok(text.startsWith('本轮附加文件路径：\n- '));
  assert.ok(text.endsWith('\n\n看看这些'));

  assert.equal(blocks.filter((b) => b.type === 'image').length, 1);
  assert.equal(lineOf(text, img), '- ' + img, '图片行不加标注（与改动前一致）');

  const audio = blocks.find((b) => b.type === 'audio');
  assert.equal(audio.mimeType, 'audio/mpeg');
  assert.equal(audio.data, readFileSync(mp3).toString('base64'));
  assert.match(lineOf(text, mp3), /← 已作为音频附上$/);

  assert.equal(byUri(blocks, pdf).resource.mimeType, 'application/pdf');
  assert.equal(byUri(blocks, pdf).resource.blob, readFileSync(pdf).toString('base64'));
  assert.equal(byUri(blocks, mp4).resource.mimeType, 'video/mp4');
  assert.ok(byUri(blocks, mp4).resource.blob);
  assert.equal(byUri(blocks, md).resource.mimeType, 'text/markdown');
  assert.equal(byUri(blocks, md).resource.text, '# 标题\n正文\n');
  assert.equal(byUri(blocks, ts).resource.mimeType, 'text/plain', '不认识的扩展名嗅探成文本');
  assert.match(lineOf(text, pdf), /← 已作为文件内容附上/);

  // Office 文档、二进制、引用的对话：不内联，明确叫模型 read_file
  assert.equal(byUri(blocks, docx), undefined);
  assert.equal(byUri(blocks, bin), undefined);
  assert.equal(byUri(blocks, quote), undefined);
  assert.match(lineOf(text, docx), /← 未直接送入，请用 read_file 打开该路径查看内容$/);
  assert.match(lineOf(text, bin), /read_file/);
  assert.match(lineOf(text, quote), /← 引用的对话（未直接送入.*read_file/);
  assert.match(lineOf(text, folder), /← 文件夹$/);

  // 被拒时的退路：只剩文字和图片，内联过的也改标 read_file
  assert.ok(fallback);
  assert.deepEqual(fallback.map((b) => b.type), ['text', 'image']);
  assert.match(lineOf(fallback[0].text, mp3), /未直接送入.*read_file/);
  assert.match(lineOf(fallback[0].text, pdf), /未直接送入.*read_file/);
  assert.equal(lineOf(fallback[0].text, img), '- ' + img);
});

test('真 agy 的能力（audio:false、embeddedContext:true）：音频改作 resource blob 送入', () => {
  const { blocks } = buildPromptPlan('', [mp3], { caps: { image: true, audio: false, embeddedContext: true } });
  assert.equal(blocks.some((b) => b.type === 'audio'), false);
  const r = byUri(blocks, mp3);
  assert.equal(r.resource.mimeType, 'audio/mpeg');
  assert.equal(r.resource.blob, readFileSync(mp3).toString('base64'));
});

test('能力未知（没报 / 进程没起）或不支持：只发图片，其余全标 read_file，也就没有退路', () => {
  for (const caps of [null, undefined, { image: true, audio: false, embeddedContext: false }]) {
    const { blocks, fallback } = buildPromptPlan('hi', ALL, { caps });
    assert.deepEqual(blocks.map((b) => b.type), ['text', 'image']);
    assert.equal(fallback, null);
    for (const p of [mp3, pdf, mp4, md, ts, docx]) assert.match(lineOf(blocks[0].text, p), /未直接送入.*read_file/);
  }
  // 兼容旧调用：不带能力的 buildPromptBlocks 与改动前一样只出文字 + 图片
  assert.deepEqual(buildPromptBlocks('', [img]).map((b) => b.type), ['text', 'image']);
  assert.equal(buildPromptBlocks('', [img])[0].text, `本轮附加文件路径：\n- ${img}`);
});

test('大小上限：超长文本与超出单轮内联预算的媒体退回路径 + read_file', () => {
  const caps = { image: true, audio: true, embeddedContext: true };
  const bigText = f('1795000000010-big.log', 'x'.repeat(TEXT_INLINE_MAX_BYTES + 1));
  const half = Math.floor(INLINE_BUDGET_BYTES / 2) + 1024;
  const wavA = f('1795000000011-a.wav', Buffer.alloc(half));
  const wavB = f('1795000000012-b.wav', Buffer.alloc(half));
  const { blocks } = buildPromptPlan('', [bigText, wavA, wavB], { caps });
  const text = blocks[0].text;
  assert.equal(byUri(blocks, bigText), undefined);
  assert.match(lineOf(text, bigText), /未直接送入.*read_file/);
  assert.equal(blocks.filter((b) => b.type === 'audio').length, 1, '第二段音频超出单轮预算');
  assert.match(lineOf(text, wavA), /已作为音频附上/);
  assert.match(lineOf(text, wavB), /未直接送入.*read_file/);
  assert.equal(blocks.find((b) => b.type === 'audio').mimeType, 'audio/wav');
});

test('清单格式不变：历史回放仍能把带标注的清单整段剥掉、只剩用户原文', () => {
  const { blocks } = buildPromptPlan('原文在这里', ALL, { caps: { image: true, audio: false, embeddedContext: true } });
  const turns = extractAgyTurns([{ role: 'user', text: blocks[0].text }]);
  assert.deepEqual(turns, [{ role: 'user', text: '原文在这里' }]);
});

test('附件所在的上传目录：只加 ctx.uploads 里的、已被覆盖的不重复加、越过成员围栏的不加', () => {
  const uploads = path.join(tmp, 'host-uploads');
  const work = path.join(tmp, 'host-work');
  mkdirSync(uploads, { recursive: true });
  mkdirSync(work, { recursive: true });
  const up = path.join(uploads, '1795-a.mp3');
  const inWork = path.join(work, 'b.pdf');
  writeFileSync(up, 'a');
  writeFileSync(inWork, 'b');
  const admin = { kind: 'admin', cwd: work, uploads };

  assert.deepEqual(uploadDirsForAttachments(admin, [up, up, inWork], [work]), [uploads]);
  assert.deepEqual(uploadDirsForAttachments(admin, [inWork], [work]), [], '工作区里的附件不用加');
  assert.deepEqual(uploadDirsForAttachments(admin, [up], [work, uploads]), [], '已在附加目录里');
  assert.deepEqual(uploadDirsForAttachments(admin, [path.join(dir, 'x.mp3'), mp3], [work]), [], '管理员附的任意路径文件不把它的目录挂进来');
  assert.deepEqual(uploadDirsForAttachments({ ...admin, uploads: '' }, [up], [work]), []);

  // 成员：上传目录在他自己的文件夹里才加；指到围栏外的（配置异常）一律不加
  const memberRoot = path.join(tmp, 'member');
  const memberUploads = path.join(memberRoot, '.bridge', 'uploads');
  mkdirSync(memberUploads, { recursive: true });
  const memberFile = path.join(memberUploads, '1795-c.wav');
  writeFileSync(memberFile, 'c');
  const member = { kind: 'user', cwd: memberRoot, uploads: memberUploads };
  assert.deepEqual(uploadDirsForAttachments(member, [memberFile], [path.join(memberRoot, 'proj')]), [memberUploads]);
  assert.deepEqual(uploadDirsForAttachments({ ...member, uploads }, [up], []), [], '上传目录不在他的文件夹里');
});

function fakeClient(name, disk = {}) {
  const stateFile = path.join(tmp, `${name}-state.json`);
  writeFileSync(stateFile, JSON.stringify({ sessions: {}, bootCount: 0, rpcLog: [], ...disk }), 'utf8');
  const client = new AcpClient({
    daemonCwd: path.join(tmp, `${name}-daemon`),
    logFile: null,
    env: { ...process.env, FAKE_ACP_STATE_FILE: stateFile },
  });
  clients.push(client);
  const prompts = () => JSON.parse(readFileSync(stateFile, 'utf8')).rpcLog
    .filter((r) => r.method === 'session/prompt').map((r) => r.params.prompt);
  return { client, prompts };
}

const projectDir = path.join(tmp, 'proj');
mkdirSync(projectDir, { recursive: true });

test('ACP：runPrompt 在 initialize 之后按 agy 报的能力组装内容块', async () => {
  const { client, prompts } = fakeClient('caps');
  const seen = [];
  const res = await client.runPrompt({
    cwd: projectDir,
    promptBlocks: (caps) => { seen.push(caps); return buildPromptPlan('听一下', [mp3, pdf], { caps }); },
  });
  assert.equal(res.status, 'completed');
  assert.deepEqual(seen, [{ image: true, audio: false, embeddedContext: true }]);
  assert.deepEqual(client.promptCapabilities(), { image: true, audio: false, embeddedContext: true });
  const sent = prompts();
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].map((b) => b.type), ['text', 'resource', 'resource']);
  assert.equal(sent[0][1].resource.mimeType, 'audio/mpeg');
});

test('ACP：老版本 agy 不报 promptCapabilities 时按保守处理，只发文字（+图片）', async () => {
  const { client, prompts } = fakeClient('nocaps', { promptCapabilities: null });
  const seen = [];
  const res = await client.runPrompt({
    cwd: projectDir,
    promptBlocks: (caps) => { seen.push(caps); return buildPromptPlan('听一下', [img, mp3], { caps }); },
  });
  assert.equal(res.status, 'completed');
  assert.deepEqual(seen, [null]);
  const sent = prompts();
  assert.deepEqual(sent[0].map((b) => b.type), ['text', 'image']);
  assert.match(sent[0][0].text, /未直接送入.*read_file/);
});

test('ACP：agy 拒收带 resource 的 prompt 时改发退路一次，这一轮照常完成', async () => {
  const { client, prompts } = fakeClient('reject', { rejectPromptBlockTypes: ['resource'] });
  const res = await client.runPrompt({
    cwd: projectDir,
    promptBlocks: (caps) => buildPromptPlan('看 PDF', [img, pdf], { caps }),
  });
  assert.equal(res.status, 'completed');
  assert.match(res.text, /imgs=1/);
  const sent = prompts();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].map((b) => b.type), ['text', 'image', 'resource']);
  assert.deepEqual(sent[1].map((b) => b.type), ['text', 'image']);
  assert.match(sent[1][0].text, /未直接送入.*read_file/);

  // 没有退路（纯文字）被拒仍按失败收尾，不会无限重发
  const { client: c2 } = fakeClient('reject-plain', { rejectPromptBlockTypes: ['text'] });
  const failed = await c2.runPrompt({ cwd: projectDir, promptBlocks: [{ type: 'text', text: 'x' }] });
  assert.equal(failed.status, 'failed');
});
