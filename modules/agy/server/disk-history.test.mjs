import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getDiskHistoryStamp,
  readDiskSessionHistory,
  _clearDiskHistoryCacheForTest,
} from './disk-history.mjs';
import { loadAgySessionDetail, noteSessionMeta } from './sessions.mjs';
import { setAcpClientForTest } from './acp/index.mjs';
import { AcpClient } from './acp/client.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-disk-hist-'));
after(() => {
  setAcpClientForTest(null);
  _clearDiskHistoryCacheForTest();
  rmSync(tmp, { recursive: true, force: true });
});

function writeTranscript(dataDir, sid, steps, fileName = 'transcript_full.jsonl') {
  const logsDir = path.join(dataDir, 'brain', sid, '.system_generated', 'logs');
  mkdirSync(logsDir, { recursive: true });
  const file = path.join(logsDir, fileName);
  writeFileSync(file, steps.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');
  return file;
}

test('readDiskSessionHistory：高保真还原用户文本/思考/edit_file diff/run_command exitCode/模型与上下文用量', () => {
  const dataDir = path.join(tmp, 'data-1');
  const sid = '11111111-2222-3333-4444-555555555555';
  const imgFile = path.join(dataDir, 'brain', sid, '.user_uploaded', 'shot.png');
  mkdirSync(path.dirname(imgFile), { recursive: true });
  writeFileSync(imgFile, 'png-bytes');

  writeTranscript(dataDir, sid, [
    {
      step_index: 0,
      source: 'USER_EXPLICIT',
      type: 'USER_INPUT',
      status: 'DONE',
      content: '<USER_REQUEST>\n帮我把 hello 改成 world 并跑单测\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>',
      media: [{ uri: imgFile, mime_type: 'image/png' }],
    },
    {
      step_index: 1,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'gemini-4-neon-high',
      input_tokens: 12000,
      cache_read_tokens: 38000,
      output_tokens: 180,
      thinking: '先改文件再跑命令',
      tool_calls: [
        {
          name: 'edit_file',
          args: { Path: 'C:\\proj\\app.js', Target: 'const a = "hello";', Replacement: 'const a = "world";' },
        },
        {
          name: 'run_command',
          args: { CommandLine: 'npm test', toolSummary: 'Run unit tests' },
        },
      ],
    },
    {
      step_index: 2,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'DONE',
      content: 'Created At: 2026-11-25T01:00:00Z\nCompleted At: 2026-11-25T01:00:01Z\nMade 1 replacement in C:\\proj\\app.js',
    },
    {
      step_index: 3,
      source: 'MODEL',
      type: 'GENERIC',
      status: 'ERROR',
      content: 'Created At: 2026-11-25T01:00:01Z\nCompleted At: 2026-11-25T01:00:03Z\nCommand exited with code 1.\n\nCommand output:\nAssertionError: boom',
    },
    {
      step_index: 4,
      source: 'MODEL',
      type: 'PLANNER_RESPONSE',
      status: 'DONE',
      model: 'gemini-4-neon-high',
      input_tokens: 2500,
      cache_read_tokens: 50000,
      output_tokens: 90,
      content: '已修改完成，但测试报错了。',
    },
  ]);

  const res = readDiskSessionHistory(dataDir, sid, { platform: 'win32' });
  assert.equal(res.ok, true);
  assert.equal(res.model, 'gemini-4-neon');
  assert.equal(res.thoughtLevel, 'high');
  assert.deepEqual(res.rawUsage, { used: 52500, size: 0 });
  assert.ok(res.updates.length >= 6);

  const editUp = res.updates.find((u) => u.params.update.sessionUpdate === 'tool_call_update' && u.params.update.name === 'edit_file');
  assert.equal(editUp.params.update.content[0].oldText, 'const a = "hello";');
  assert.equal(editUp.params.update.content[0].newText, 'const a = "world";');
  assert.equal(editUp.params.update.rawOutput.output, 'Made 1 replacement in C:\\proj\\app.js');

  const cmdUp = res.updates.find((u) => u.params.update.sessionUpdate === 'tool_call_update' && u.params.update.name === 'run_command');
  assert.equal(cmdUp.params.update.status, 'failed');
  assert.equal(cmdUp.params.update.rawOutput.exit_code, 1);
  assert.equal(cmdUp.params.update.rawOutput.output, 'AssertionError: boom');
});

test('readDiskSessionHistory：非 full 的 transcript.jsonl 含 truncated_fields 时放弃快读回落 ACP', () => {
  const dataDir = path.join(tmp, 'data-trunc');
  const sid = '22222222-2222-3333-4444-555555555555';
  writeTranscript(dataDir, sid, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>hi</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'short...', truncated_fields: ['content'] },
  ], 'transcript.jsonl');

  const res = readDiskSessionHistory(dataDir, sid);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'truncated');
});

test('loadAgySessionDetail：未挂载会话走磁盘快读（0 次 session/load）、预热内存并支持 ?fp= 指纹短路', async () => {
  const dataDir = path.join(tmp, 'data-fast');
  const agyDir = path.join(tmp, 'agy-fast-meta');
  const workDir = path.join(tmp, 'work-fast');
  mkdirSync(agyDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const sid = '33333333-2222-3333-4444-555555555555';
  noteSessionMeta(agyDir, sid, { cwd: workDir, title: '快读测试' });

  writeTranscript(dataDir, sid, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>你好</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', model: 'gemini-4-neon-xhigh', input_tokens: 10000, cache_read_tokens: 41200, content: '你好，我在。' },
  ]);

  let loadCalls = 0;
  const fakeAcp = new AcpClient({ daemonCwd: path.join(tmp, 'daemon-fast'), dataDir, logFile: null });
  fakeAcp.lastCatalog = {
    configOptions: [
      { id: 'model', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
      { id: 'thought_level', currentValue: 'medium', options: [{ value: 'medium' }, { value: 'xhigh' }] },
      { id: 'mode', currentValue: 'default', options: [{ value: 'default' }, { value: 'auto' }] },
    ],
  };
  fakeAcp.loadSessionWithReplay = async () => { loadCalls++; throw new Error('不应触发 session/load'); };
  setAcpClientForTest(fakeAcp);

  const ctx = { kind: 'admin', key: 'admin', cwd: workDir, agyDir, agyProjects: path.join(tmp, 'projects.json') };
  const detail = await loadAgySessionDetail(ctx, sid);
  assert.equal(loadCalls, 0, '磁盘存在完整 transcript 时不启动 worker 也不调 session/load');
  assert.equal(detail.title, '快读测试');
  assert.equal(detail.model, 'gemini-4-neon');
  assert.equal(detail.thoughtLevel, 'xhigh');
  assert.equal(detail.usage.used, 51200);
  assert.equal(detail.usage.size, 512000);
  assert.equal(detail.messages.length, 2);
  assert.equal(detail.messages[1].text, '你好，我在。');
  assert.ok(detail.fp && detail.fp.startsWith('agy1:'));
  assert.ok(fakeAcp.historyUpdates.has(sid), '快读后顺手预热内存历史，续聊可直接 session/resume');

  // 二次带上相同 fp：直接返回 unchanged，不重解
  const hit = await loadAgySessionDetail(ctx, sid, { fp: detail.fp });
  assert.equal(hit.unchanged, true);
  assert.equal(hit.fp, detail.fp);
  assert.equal(loadCalls, 0);
});

test('loadAgySessionDetail：已挂载空闲会话复读内存且不杀 worker，磁盘外部更新时自动刷新内存', async () => {
  const dataDir = path.join(tmp, 'data-mounted');
  const agyDir = path.join(tmp, 'agy-mounted-meta');
  const workDir = path.join(tmp, 'work-mounted');
  mkdirSync(agyDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });
  const sid = '44444444-2222-3333-4444-555555555555';
  noteSessionMeta(agyDir, sid, { cwd: workDir, title: '挂载复读' });

  const file = writeTranscript(dataDir, sid, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>第一句</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '第一轮回复' },
  ]);
  const stamp1 = getDiskHistoryStamp(dataDir, sid).stamp;

  let loadCalls = 0;
  let closeCalls = 0;
  const fakeAcp = new AcpClient({ daemonCwd: path.join(tmp, 'daemon-mounted'), dataDir, logFile: null });
  fakeAcp.mountedSessions.set(sid, {
    sessionId: sid,
    cwd: workDir,
    configOptions: [{ id: 'mode', currentValue: 'auto', options: [{ value: 'auto' }] }],
    modes: null,
    models: null,
    commands: [{ name: 'plan', description: 'plan' }],
    title: '挂载复读',
    rawUsage: { used: 3000, size: 512000 },
    usage: { used: 3000, size: 512000 },
    lastActiveAt: Date.now() - 5000,
  });
  fakeAcp.seedHistory(sid, [
    { params: { sessionId: sid, update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '第一句' } } } },
    { params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '第一轮回复' } } } },
  ], { diskStamp: stamp1 });
  fakeAcp.loadSessionWithReplay = async () => { loadCalls++; throw new Error('不应重 load'); };
  fakeAcp.closeSession = async () => { closeCalls++; };
  setAcpClientForTest(fakeAcp);

  const ctx = { kind: 'admin', key: 'admin', cwd: workDir, agyDir, agyProjects: path.join(tmp, 'projects.json') };
  const d1 = await loadAgySessionDetail(ctx, sid);
  assert.equal(loadCalls, 0);
  assert.equal(closeCalls, 0);
  assert.equal(d1.messages.length, 2);
  assert.equal(d1.commands.length, 1);

  // 模拟外部进程写入新一轮并推进 mtime
  writeTranscript(dataDir, sid, [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>第一句</USER_REQUEST>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '第一轮回复' },
    { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', content: '<USER_REQUEST>外部第二句</USER_REQUEST>' },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: '外部第二轮回复' },
  ]);
  const future = new Date(Date.now() + 5000);
  utimesSync(file, future, future);

  const d2 = await loadAgySessionDetail(ctx, sid, { fp: d1.fp });
  assert.equal(d2.unchanged, undefined);
  assert.equal(d2.messages.length, 4);
  assert.equal(d2.messages[3].text, '外部第二轮回复');
  assert.equal(loadCalls, 0, '磁盘变化后刷新内存，依然不杀 worker 不重 load');
  assert.equal(closeCalls, 0);
});
