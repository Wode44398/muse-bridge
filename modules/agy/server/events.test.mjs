import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertSessionUpdate,
  normalizePermissionRequest,
  normalizeElicitationRequest,
  reconstructHistoryMessages,
} from './events.mjs';

test('convertSessionUpdate：文件编辑完成时产出规整路径的 tool-update、diff 与 fs 事件', () => {
  const events = convertSessionUpdate('s-1', {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_1',
    name: 'edit_file',
    kind: 'edit',
    status: 'completed',
    title: 'File /C:/ws/demo%20app/src/index.js',
    locations: [{ path: '/C:/ws/demo%20app/src/index.js' }],
    rawInput: { Path: 'C:\\ws\\demo app\\src\\index.js' },
    content: [
      {
        type: 'diff',
        path: '/C:/ws/demo%20app/src/index.js',
        oldText: 'const a = 1;\n',
        newText: 'const a = 2;\n',
      },
    ],
  }, 'win32');

  assert.equal(events.length, 3);
  assert.equal(events[0].type, 'tool-update');
  assert.equal(events[0].tool.title, 'File C:\\ws\\demo app\\src\\index.js');
  assert.equal(events[0].tool.locations[0].path, 'C:\\ws\\demo app\\src\\index.js');
  assert.deepEqual(events[1], {
    type: 'diff',
    toolCallId: 'call_1',
    diffs: [{
      path: 'C:\\ws\\demo app\\src\\index.js',
      oldText: 'const a = 1;\n',
      newText: 'const a = 2;\n',
    }],
  });
  assert.deepEqual(events[2], {
    type: 'fs',
    path: 'C:\\ws\\demo app\\src\\index.js',
  });
});

test('normalizePermissionRequest 与 normalizeElicitationRequest：保留字符串 ID 并解析表单 schema', () => {
  const perm = normalizePermissionRequest('1', {
    sessionId: 's-1',
    toolCall: {
      toolCallId: 'call_cmd',
      name: 'run_command',
      kind: 'execute',
      status: 'pending',
      title: 'echo hi',
      rawInput: { CommandLine: 'echo hi' },
    },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  }, 'win32');
  assert.equal(perm.requestId, '1');
  assert.equal(perm.toolCall.command, 'echo hi');
  assert.equal(perm.options.length, 2);

  const q = normalizeElicitationRequest('ask-9', {
    mode: 'form',
    message: '确认发布参数',
    requestedSchema: {
      type: 'object',
      required: ['target', 'notes'],
      properties: {
        target: {
          type: 'string',
          title: '环境',
          oneOf: [
            { const: 'dev', title: '开发' },
            { const: 'prod', title: '生产' },
          ],
        },
        tags: {
          type: 'array',
          title: '模块',
          items: { enum: ['web', 'server'], enumNames: ['前端', '后端'] },
        },
        dryRun: { type: 'boolean', title: '仅演练', default: true },
        notes: { type: 'string', title: '备注' },
      },
    },
  }, 's-fallback');

  assert.equal(q.requestId, 'ask-9');
  assert.equal(q.sessionId, 's-fallback');
  assert.deepEqual(q.fields.map((f) => [f.key, f.kind, f.required]), [
    ['target', 'single', true],
    ['tags', 'multi', false],
    ['dryRun', 'boolean', false],
    ['notes', 'text', true],
  ]);
  assert.deepEqual(q.fields[0].options, [
    { value: 'dev', label: '开发' },
    { value: 'prod', label: '生产' },
  ]);
  assert.deepEqual(q.fields[1].options, [
    { value: 'web', label: '前端' },
    { value: 'server', label: '后端' },
  ]);
});

test('reconstructHistoryMessages：把 session/load 回放还原为用户与助手轮次结构', () => {
  const replayed = [
    { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '帮我改配置' } } },
    { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先读再改。' } } },
    {
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 't1',
        name: 'edit_file',
        kind: 'edit',
        status: 'completed',
        title: 'File /D:/repo/app.json',
        locations: [{ path: '/D:/repo/app.json' }],
        content: [{ type: 'diff', path: '/D:/repo/app.json', oldText: '{}', newText: '{"ok":true}' }],
      },
    },
    { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已修改完成。' } } },
    { update: { sessionUpdate: 'usage_update', used: 4096, size: 1048576 } },
    { update: { sessionUpdate: 'session_info_update', title: '修改应用配置' } },
  ];

  const res = reconstructHistoryMessages(replayed, 'win32');
  assert.equal(res.title, '修改应用配置');
  assert.deepEqual(res.usage, { used: 4096, size: 1048576 });
  assert.equal(res.messages.length, 2);
  assert.equal(res.messages[0].role, 'user');
  assert.equal(res.messages[0].text, '帮我改配置');
  assert.equal(res.messages[1].role, 'assistant');
  assert.equal(res.messages[1].thinking, '先读再改。');
  assert.equal(res.messages[1].text, '已修改完成。');
  assert.equal(res.messages[1].tools[0].diffs[0].path, 'D:\\repo\\app.json');
  assert.deepEqual(res.messages[1].blocks.map((b) => b.type), ['thinking', 'tool', 'text']);
});
