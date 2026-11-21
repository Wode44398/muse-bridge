import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  modelDisplayName,
  groupModels,
  extractThoughtOptions,
  extractModeOptions,
  filterSlashCommands,
  computeDiffLines,
  classifyToolKind,
  stripWorkspaceCdPrefix,
  createEmptyAssistantTurn,
  applyAgyStreamEvent,
  normalizeHistoryMessages,
  isDaemonPseudoPath,
  groupSessionsByProjectAndTime,
  resolveAgyLocalLink,
} from './logic.js';
import {
  computeWorkspaceFileTarget,
  buildActivityTimeline,
  extractSessionModifiedFiles,
  formatActivityDuration,
} from './workspace-logic.js';
import {
  convertSessionUpdate,
  normalizePermissionRequest,
  normalizeElicitationRequest,
  reconstructHistoryMessages,
} from '../../../../modules/agy/server/events.mjs';

test('groupModels / extractThoughtOptions / extractModeOptions：按系列分组并随模型反映档位', () => {
  const configOptions = [
    {
      id: 'model',
      category: 'model',
      currentValue: 'gemini-4-hydrogen',
      options: [
        { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
        { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen' },
        { value: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
        { value: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6' },
        { value: 'gpt-oss-120b', name: 'GPT-OSS 120B' },
      ],
    },
    {
      id: 'thought_level',
      category: 'thought_level',
      currentValue: 'xhigh',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'XHigh' },
      ],
    },
    {
      id: 'mode',
      category: 'mode',
      currentValue: 'plan',
      options: [
        { value: 'default', name: 'Default' },
        { value: 'accept-edits', name: 'Accept edits' },
        { value: 'auto', name: 'Auto' },
        { value: 'plan', name: 'Plan' },
      ],
    },
  ];

  const grouped = groupModels(configOptions);
  assert.equal(grouped.current, 'gemini-4-hydrogen');
  assert.deepEqual(grouped.groups.map((g) => g.series), ['Gemini 4', 'Gemini 3.8', 'Claude', 'GPT-OSS']);
  assert.equal(grouped.groups[0].models.length, 2);

  const thoughts = extractThoughtOptions(configOptions);
  assert.equal(thoughts.current, 'xhigh');
  assert.deepEqual(thoughts.options.map((o) => o.id), ['low', 'medium', 'high', 'xhigh']);

  // 在线会话模型不支持思考档位时，configOptions 不含 thought_level，前端不展示伪造档位
  const noThoughtLive = extractThoughtOptions([configOptions[0], configOptions[2]], [{ id: 'low', name: 'Low' }]);
  assert.deepEqual(noThoughtLive.options, []);

  // 新对话尚未握手时，按所选模型的 efforts 动态裁剪
  const fallbackEfforts = [
    { id: 'low', name: 'Low' },
    { id: 'medium', name: 'Medium' },
    { id: 'high', name: 'High' },
    { id: 'xhigh', name: 'XHigh' },
  ];
  const fallbackModels = [
    { id: 'gemini-4-carbon', efforts: ['low', 'medium', 'high'] },
    { id: 'claude-sonnet-4-6', efforts: [] },
  ];
  assert.deepEqual(
    extractThoughtOptions([], fallbackEfforts, 'gemini-4-carbon', fallbackModels).options.map((o) => o.id),
    ['low', 'medium', 'high'],
  );
  assert.deepEqual(
    extractThoughtOptions([], fallbackEfforts, 'claude-sonnet-4-6', fallbackModels).options,
    [],
  );

  const modes = extractModeOptions(configOptions);
  assert.equal(modes.current, 'plan');
  assert.equal(modes.options.length, 5, 'agy 的四种模式 + bridge 补的完全放行');
  assert.equal(modes.options.at(-1).id, 'bypass');
});

test('filterSlashCommands：仅在首行斜杠词前缀激活，支持前缀优先与描述匹配', () => {
  const cmds = [
    { name: 'plan', description: '先做详细规划' },
    { name: 'compact', description: '压缩上下文窗口' },
    { name: 'goal', description: '长任务持续达成目标' },
  ];

  assert.equal(filterSlashCommands(cmds, '普通文本').length, 0);
  assert.equal(filterSlashCommands(cmds, '/plan 后面已经有空格参数').length, 0);
  assert.equal(filterSlashCommands(cmds, '/').length, 3);
  assert.deepEqual(filterSlashCommands(cmds, '/co').map((c) => c.name), ['compact']);
  assert.deepEqual(filterSlashCommands(cmds, '/上下文').map((c) => c.name), ['compact']);
});

test('computeDiffLines：准确计算增删行号与统计', () => {
  const oldText = 'const a = 1;\nconst b = 2;\nreturn a + b;\n';
  const newText = 'const a = 1;\nconst b = 20;\nconst c = 3;\nreturn a + b + c;\n';

  const diff = computeDiffLines(oldText, newText);
  assert.equal(diff.added, 3);
  assert.equal(diff.removed, 2);
  assert.equal(diff.truncated, false);
  assert.equal(diff.lines[0].type, 'ctx');
  assert.equal(diff.lines[0].oldNo, 1);
  assert.equal(diff.lines[0].newNo, 1);
});

test('applyAgyStreamEvent 与 attach 重放：交错合并思考/工具/正文并正确还原审批与提问状态', () => {
  const turn = createEmptyAssistantTurn();
  applyAgyStreamEvent(turn, { type: 'thinking', text: '先读配置' });
  applyAgyStreamEvent(turn, { type: 'tool', toolCallId: 'c1', name: 'read_file', kind: 'read', status: 'in_progress', locations: ['C:\\repo\\a.js'] });
  applyAgyStreamEvent(turn, { type: 'permission', requestId: '1', sessionId: 's1', toolCallId: 'c1', title: 'Read a.js', options: [{ optionId: 'allow', name: 'Allow' }] });

  assert.equal(turn.permissions[0].status, 'pending');

  // 模拟断线后 /api/agy/attach 从头重放整轮缓冲：先清空半截状态，再重放包含已审批完成的事件序列
  applyAgyStreamEvent(turn, { type: 'attach', sessionId: 's1' });
  assert.equal(turn.blocks.length, 0);
  assert.equal(turn.permissions.length, 0);

  applyAgyStreamEvent(turn, { type: 'thinking', text: '先读配置' });
  applyAgyStreamEvent(turn, { type: 'tool', toolCallId: 'c1', name: 'read_file', kind: 'read', status: 'in_progress', locations: ['C:\\repo\\a.js'] });
  applyAgyStreamEvent(turn, { type: 'permission', requestId: '1', sessionId: 's1', toolCallId: 'c1', title: 'Read a.js', options: [{ optionId: 'allow', name: 'Allow' }] });
  applyAgyStreamEvent(turn, { type: 'permission-resolved', requestId: '1', outcome: 'selected', optionId: 'allow' });
  applyAgyStreamEvent(turn, { type: 'tool-update', toolCallId: 'c1', status: 'completed' });
  applyAgyStreamEvent(turn, { type: 'question', requestId: '2', sessionId: 's1', message: '选环境', fields: [{ name: 'env', kind: 'select', options: [] }] });
  applyAgyStreamEvent(turn, { type: 'question-resolved', requestId: '2', action: 'accept', content: { env: 'prod' } });
  applyAgyStreamEvent(turn, { type: 'text', text: '已完成' });
  applyAgyStreamEvent(turn, { type: 'text', text: '检查。' });
  applyAgyStreamEvent(turn, { type: 'done', result: '已完成检查。' });

  assert.equal(turn.status, 'done');
  assert.equal(turn.md, '已完成检查。');
  assert.deepEqual(turn.blocks.map((b) => b.type), ['thinking', 'tool', 'text']);
  assert.equal(turn.toolsById.c1.status, 'completed');
  assert.equal(turn.permissions[0].status, 'resolved');
  assert.equal(turn.permissions[0].selectedOptionId, 'allow');
  assert.equal(turn.questions[0].status, 'answered');
  assert.deepEqual(turn.questions[0].answer, { env: 'prod' });
});

test('normalizeHistoryMessages / groupSessionsByProjectAndTime / resolveAgyLocalLink', () => {
  const msgs = normalizeHistoryMessages([
    { role: 'user', text: '你好', images: [] },
    { role: 'assistant', thinking: '思考中', text: '你好！', tools: [{ toolCallId: 't1', name: 'run_command', kind: 'execute', status: 'completed', command: 'npm test', exitCode: 0 }] },
  ], 'sid-1');
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[1].blocks.map((b) => b.type), ['thinking', 'tool', 'text']);

  const now = new Date('2026-11-17T15:00:00Z').getTime();
  const grouped = groupSessionsByProjectAndTime([
    { sessionId: 's1', projectId: 'p1', cwd: 'C:\\a', title: '今日改造', updatedMs: now - 3600_000 },
    { sessionId: 's2', projectId: 'p1', cwd: 'C:\\a', title: '昨日调研', updatedMs: now - 30 * 3600_000 },
    { sessionId: 's3', projectId: 'p2', cwd: 'C:\\b', title: '上周归档', updatedMs: now - 5 * 86400_000 },
  ], [
    { id: 'p1', name: 'cb-agy', path: 'C:\\a' },
    { id: 'p2', name: 'vault', path: 'C:\\b' },
  ], '', now);

  assert.equal(grouped.total, 3);
  assert.equal(grouped.byProject.length, 2);
  assert.equal(grouped.byProject[0].name, 'cb-agy');
  assert.equal(grouped.byTime.length, 3);

  assert.equal(resolveAgyLocalLink('file:///C:/Users/you/out.md#L10-L20', 'C:\\Users\\you'), 'C:/Users/you/out.md');
  assert.equal(resolveAgyLocalLink('./docs/plan.md', 'C:\\repo'), 'C:\\repo\\docs\\plan.md');
  assert.equal(resolveAgyLocalLink('https://example.com/a.md', 'C:\\repo'), null);
});

test('真实 ACP 帧经服务端 events.mjs 转给前端 logic.js：工具合并、diff、命令输出、权限详情与历史回放严丝合缝', () => {
  const sid = '4205a4ed-e368-4bb8-989c-0752fd89a56a';
  const turn = createEmptyAssistantTurn({ sessionId: sid });

  const rawFrames = [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '先修改配置文件。' } },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_edit_1',
      name: 'edit_file',
      status: 'in_progress',
      kind: 'edit',
      title: 'File C:\\repo\\sample-edit.txt',
      locations: [{ path: 'C:\\repo\\sample-edit.txt' }],
      rawInput: { Path: 'C:\\repo\\sample-edit.txt', Target: 'OLD_VALUE', Replacement: 'NEW_VALUE' },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_edit_1',
      name: 'edit_file',
      status: 'completed',
      kind: 'edit',
      title: 'File /C:/repo/sample-edit.txt',
      locations: [{ path: '/C:/repo/sample-edit.txt' }],
      content: [{
        type: 'diff',
        path: '/C:/repo/sample-edit.txt',
        oldText: 'config_key = OLD_VALUE\nkeep = 1\n',
        newText: 'config_key = NEW_VALUE\nkeep = 1\n',
      }],
    },
    {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_cmd_2',
      name: 'run_command',
      status: 'in_progress',
      kind: 'execute',
      title: 'echo acp-probe-ok',
      rawInput: { CommandLine: 'echo acp-probe-ok', WaitMsBeforeAsync: 5000, toolSummary: 'Run echo command' },
    },
    {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call_cmd_2',
      name: 'run_command',
      status: 'pending',
      kind: 'execute',
      title: 'echo acp-probe-ok',
      rawInput: { CommandLine: 'echo acp-probe-ok', WaitMsBeforeAsync: 5000, toolSummary: 'Run echo command' },
    },
  ];

  for (const u of rawFrames) {
    for (const ev of convertSessionUpdate(sid, u, 'win32')) {
      applyAgyStreamEvent(turn, ev);
    }
  }

  const toolBlocks = turn.blocks.filter((b) => b.type === 'tool');
  assert.equal(toolBlocks.length, 2);
  const editTool = turn.toolsById.call_edit_1;
  assert.equal(editTool.status, 'completed');
  assert.equal(editTool.kind, 'edit');
  assert.equal(editTool.locations[0].path, 'C:\\repo\\sample-edit.txt');
  assert.equal(editTool.diffs.length, 1);
  assert.equal(editTool.diffs[0].path, 'C:\\repo\\sample-edit.txt');
  const editMeta = classifyToolKind(editTool);
  assert.equal(editMeta.category, 'edit');
  assert.equal(editMeta.summary, 'repo/sample-edit.txt');

  const permEvt = normalizePermissionRequest('1', {
    sessionId: sid,
    toolCall: {
      sessionUpdate: 'tool_call',
      toolCallId: 'call_cmd_2',
      name: 'run_command',
      status: 'pending',
      kind: 'execute',
      title: 'echo acp-probe-ok',
      rawInput: { CommandLine: 'echo acp-probe-ok', toolSummary: 'Run echo command', BypassSandbox: true },
    },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  }, 'win32');
  applyAgyStreamEvent(turn, permEvt);

  assert.equal(turn.permissions.length, 1);
  assert.equal(turn.permissions[0].toolName, 'run_command');
  assert.equal(turn.permissions[0].kind, 'execute');
  assert.equal(turn.permissions[0].command, 'echo acp-probe-ok');
  assert.equal(turn.permissions[0].summary, 'Run echo command');
  assert.equal(turn.permissions[0].bypassSandbox, true);

  const qEvt = normalizeElicitationRequest('2', {
    sessionId: sid,
    mode: 'form',
    message: '请选择部署环境',
    requestedSchema: {
      type: 'object',
      required: ['env'],
      properties: {
        env: { type: 'string', title: '环境', enum: ['dev', 'prod'] },
      },
    },
  });
  applyAgyStreamEvent(turn, qEvt);
  assert.equal(turn.questions.length, 1);
  assert.equal(turn.questions[0].fields[0].key, 'env');
  assert.equal(turn.questions[0].fields[0].kind, 'single');

  applyAgyStreamEvent(turn, { type: 'permission-resolved', requestId: '1', outcome: 'selected', optionId: 'allow' });
  for (const ev of convertSessionUpdate(sid, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call_cmd_2',
    name: 'run_command',
    status: 'completed',
    kind: 'execute',
    title: 'echo acp-probe-ok',
    rawInput: { CommandLine: 'echo acp-probe-ok' },
    rawOutput: { output: 'acp-probe-ok\r\n', exit_code: 0 },
  }, 'win32')) {
    applyAgyStreamEvent(turn, ev);
  }

  const cmdTool = turn.toolsById.call_cmd_2;
  assert.equal(cmdTool.status, 'completed');
  assert.equal(cmdTool.command, 'echo acp-probe-ok');
  assert.equal(cmdTool.exitCode, 0);
  assert.match(cmdTool.output, /acp-probe-ok/);
  assert.equal(classifyToolKind(cmdTool).summary, 'echo acp-probe-ok');

  const replay = reconstructHistoryMessages([
    { params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '修改并测试' } } } },
    ...rawFrames.slice(0, 3).map((u) => ({ params: { update: u } })),
    { params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '已完成修改。' } } } },
  ], 'win32');
  const hist = normalizeHistoryMessages(replay.messages, sid);
  assert.equal(hist.length, 2);
  assert.deepEqual(hist[1].blocks.map((b) => b.type), ['thinking', 'tool', 'text']);
  assert.equal(hist[1].toolsById.call_edit_1.status, 'completed');
  assert.equal(hist[1].toolsById.call_edit_1.diffs.length, 1);
});

test('daemon-cwd 伪路径与未归属会话归入底部默认折叠的「其他」分组', () => {
  assert.equal(isDaemonPseudoPath('C:\\Users\\you\\Temp\\x\\agy\\daemon-cwd'), true);
  assert.equal(isDaemonPseudoPath('/tmp/agy/daemon-cwd/'), true);
  assert.equal(isDaemonPseudoPath('C:\\Users\\you\\AppData\\Local\\Temp\\agy-fix1-verify-Hx3\\daemon-cwd'), true);
  assert.equal(isDaemonPseudoPath('C:\\proj\\daemon-cwd-notes'), false);
  assert.equal(isDaemonPseudoPath('C:\\Users\\you\\cb-agy'), false);

  const now = new Date('2026-11-17T18:00:00Z').getTime();
  const grouped = groupSessionsByProjectAndTime([
    { sessionId: 'u1', cwd: 'C:\\Temp\\old\\agy\\daemon-cwd', projectName: 'daemon-cwd', title: '游离对话 1', updatedMs: now },
    { sessionId: 'u2', cwd: '', title: '游离对话 2', updatedMs: now - 1000 },
    { sessionId: 'p1-s1', projectId: 'p1', cwd: 'C:\\cb-agy', title: '项目对话', updatedMs: now - 60_000 },
  ], [
    { id: 'p1', name: 'cb-agy', path: 'C:\\cb-agy' },
  ], '', now);

  assert.equal(grouped.byProject.length, 2);
  assert.equal(grouped.byProject[0].name, 'cb-agy');
  assert.equal(grouped.byProject[0].defaultCollapsed, false);
  assert.equal(grouped.byProject[0].timeGroups.length, 1);

  const otherGrp = grouped.byProject[1];
  assert.equal(otherGrp.key, '__other__');
  assert.equal(otherGrp.name, '其他');
  assert.equal(otherGrp.unassigned, true);
  assert.equal(otherGrp.defaultCollapsed, true);
  assert.equal(otherGrp.count, 2);
});

test('停止轮次与侧边工作区逻辑：取消工具区分于失败、活动时间线聚合、非 git 变更汇总与文件路径定位', () => {
  const turn = createEmptyAssistantTurn({ startedAt: 1000 });
  applyAgyStreamEvent(turn, {
    type: 'tool',
    at: 1100,
    tool: {
      toolCallId: 't-edit',
      name: 'edit_file',
      kind: 'edit',
      status: 'in_progress',
      locations: [{ path: 'C:\\repo\\src\\app.js' }],
    },
  });
  applyAgyStreamEvent(turn, {
    type: 'tool-update',
    at: 1450,
    tool: {
      toolCallId: 't-edit',
      name: 'edit_file',
      kind: 'edit',
      status: 'completed',
      diffs: [{ path: 'C:\\repo\\src\\app.js', oldText: 'let v = 1;\n', newText: 'let v = 2;\n' }],
    },
  });
  applyAgyStreamEvent(turn, {
    type: 'tool',
    at: 1500,
    tool: {
      toolCallId: 't-cmd',
      name: 'run_command',
      kind: 'execute',
      status: 'in_progress',
      command: 'npm run slow-job',
    },
  });
  applyAgyStreamEvent(turn, { type: 'interrupted', at: 2100, result: '半截说明' });

  assert.equal(turn.status, 'interrupted');
  assert.equal(turn.toolsById['t-edit'].status, 'completed');
  assert.equal(turn.toolsById['t-edit'].durationMs, 350);
  assert.equal(turn.toolsById['t-cmd'].status, 'cancelled');
  assert.equal(turn.toolsById['t-cmd'].durationMs, 600);

  const turn2 = createEmptyAssistantTurn({ status: 'done' });
  applyAgyStreamEvent(turn2, {
    type: 'tool',
    at: 3000,
    tool: {
      toolCallId: 't-edit-2',
      name: 'edit_file',
      kind: 'edit',
      status: 'completed',
      diffs: [{ path: 'C:\\repo\\src\\app.js', oldText: 'let v = 2;\n', newText: 'const v = 3;\nexport default v;\n' }],
    },
  });

  const messages = [
    { role: 'user', text: '改一下' },
    turn,
    { role: 'user', text: '再改一下' },
    turn2,
  ];

  const timeline = buildActivityTimeline(messages);
  assert.equal(timeline.counts.total, 3);
  assert.equal(timeline.counts.edit, 2);
  assert.equal(timeline.counts.execute, 1);
  assert.equal(timeline.items[1].status, 'cancelled');
  assert.equal(formatActivityDuration(timeline.items[0].durationMs), '350ms');

  const mod = extractSessionModifiedFiles(messages, 'C:\\repo');
  assert.equal(mod.files.length, 1);
  assert.equal(mod.files[0].path, 'src/app.js');
  assert.equal(mod.files[0].editCount, 2);
  assert.equal(mod.files[0].added, 2);
  assert.equal(mod.files[0].removed, 1);

  const targetInWs = computeWorkspaceFileTarget('C:\\repo\\src\\utils\\helper.js', 'C:\\repo');
  assert.equal(targetInWs.ws, 'C:\\repo');
  assert.equal(targetInWs.rel, 'src/utils');
  assert.equal(targetInWs.fileName, 'helper.js');

  const targetOutWs = computeWorkspaceFileTarget('D:\\external\\notes.md', 'C:\\repo', { openFile: true });
  assert.equal(targetOutWs.ws, 'D:\\external');
  assert.equal(targetOutWs.rel, '');
  assert.equal(targetOutWs.open, 'notes.md');

  const normHist = normalizeHistoryMessages([
    { role: 'user', text: 'test' },
    { role: 'assistant', status: 'interrupted', text: '', tools: [{ toolCallId: 'x1', name: 'run_command', kind: 'execute', status: 'in_progress' }] },
  ], 's-hist');
  assert.equal(normHist[1].status, 'interrupted');
  assert.equal(normHist[1].toolsById.x1.status, 'cancelled');
});

test('modelDisplayName 与 Bridge MCP 工具分类：统一展示友好名且不把 ui_view 误判为本地读文件', () => {
  assert.equal(modelDisplayName('claude-sonnet-4-6', []), 'Claude Sonnet 4.6');
  assert.equal(modelDisplayName('claude-opus-4-6', [], { short: true }), 'Claude Opus 4.6');
  assert.equal(modelDisplayName('gemini-4-carbon', [{ id: 'gemini-4-carbon', name: 'Gemini 4 Carbon' }]), 'Gemini 4 Carbon');
  assert.equal(modelDisplayName('gpt-oss-120b', []), 'GPT-OSS 120B');

  const imgMeta = classifyToolKind({ name: 'mcp__bridge__media_image', args: { prompt: '水墨江南小桥' } });
  assert.equal(imgMeta.icon, 'extension');
  assert.equal(imgMeta.verb, '生成图片');
  assert.equal(imgMeta.summary, '水墨江南小桥');

  // bridge 自己的名字（mcp_bridge_*）走细分文案并带 bridge 标记（审批卡据此不露工具代号）；别的写法仍走通用那一支
  const uiMeta = classifyToolKind({ name: 'mcp_bridge_ui_view', args: {} });
  assert.equal(uiMeta.verb, '查看你的界面');
  assert.equal(uiMeta.bridge, 'ui_view');
  assert.equal(uiMeta.category, 'other');
  assert.equal(classifyToolKind({ name: 'bridge:ui_view', args: {} }).verb, '界面协同');

  const phoneMeta = classifyToolKind({ name: 'bridge:phone_list', args: { path: '@r1/Photos' } });
  assert.equal(phoneMeta.icon, 'extension');
  assert.equal(phoneMeta.verb, '手机文件');
  assert.equal(phoneMeta.summary, '@r1/Photos');
});

test('bridge 工具的审批文案：看得清要动什么、落在哪（终端重启、操作电脑、电脑与手机文件、bridge 操作）', () => {
  const k = (name, args) => classifyToolKind({ name: 'mcp_bridge_' + name, args });
  // 终端：重启不再叫「查看」，只读动作也有一句人话
  const restart = k('terminal', { action: 'restart' });
  assert.equal(restart.verb, '重启共享终端');
  assert.ok(restart.detail && restart.note);
  assert.equal(restart.group, '重启共享终端');
  assert.equal(k('terminal', { action: 'read' }).detail, '读取终端里的内容');
  assert.equal(k('terminal', { action: 'read' }).group, '查看共享终端');
  assert.equal(k('terminal', { action: 'run', command: 'npm test' }).detail, 'npm test');
  // 操作电脑：输入了什么、启动了什么、批量几步
  assert.match(k('device_act', { action: 'type', text: 'hello' }).detail, /hello/);
  assert.match(k('device_act', { action: 'launch', file: 'notepad.exe', args: ['a.txt'] }).detail, /notepad\.exe a\.txt/);
  assert.match(k('device_act', { action: 'key', keys: 'Ctrl+S' }).detail, /Ctrl\+S/);
  const batch = k('device_act', { action: 'batch', actions: [{ action: 'click', ref: 3 }, { action: 'type', text: 'x' }] });
  assert.match(batch.detail, /2/);
  assert.match(batch.detail, /#3/);
  // 电脑文件：读、写、删各是各的；分类仍是 other（不数进「本会话改了几个文件」）
  const del = k('device_files', { action: 'delete', path: 'C:/x', recursive: true });
  assert.equal(del.verb, '删除电脑文件');
  assert.equal(del.category, 'other');
  assert.match(del.detail, /C:\/x/);
  assert.equal(k('device_files', { action: 'read', path: 'C:/x' }).verb, '读取电脑文件');
  assert.equal(k('device_files', { action: 'write', path: 'C:/x' }).verb, '写入电脑文件');
  assert.match(k('device_files', { action: 'push', from: 'out.zip', path: 'D:/in.zip' }).summary, /out\.zip → D:\/in\.zip/);
  // 在电脑上执行：说明句写明是用户的电脑
  const sh = k('device_shell', { command: 'dir' });
  assert.equal(sh.category, 'execute');
  assert.match(sh.note, /你的电脑/);
  // 手机文件：删除看得出是删除
  assert.equal(k('phone_delete', { path: '@r1/a.mp4' }).verb, '删除手机文件');
  assert.equal(k('phone_delete', { path: '@r1/a.mp4' }).bridge, 'phone_delete');
  assert.equal(k('phone_list', {}).summary, '');
  // bridge 操作：审批卡那一行带参数
  assert.match(k('call', { op: 'routines.create', args: { name: '晨报' } }).detail, /routines\.create .*晨报/);
  assert.equal(k('call', { op: 'routines.list' }).summary, 'routines.list');
  // 媒体：没有 prompt 时不拿工具代号凑数
  assert.equal(k('media_image', {}).summary, '');
  assert.equal(k('media_image', { prompt: '水墨' }).verb, '生成图片');
});

test('第 6 期验收修复：审批结论合并进工具卡、命令去 Set-Location 前缀、同名项目消歧与前 5 组折叠', () => {
  const ws = 'C:\\Users\\you\\my-project';
  assert.equal(
    stripWorkspaceCdPrefix('Set-Location "C:\\Users\\you\\my-project"; node app.js --verify', ws),
    'node app.js --verify'
  );
  assert.equal(
    stripWorkspaceCdPrefix('cd /d "c:/users/you/my-project/" && npm test', ws),
    'npm test'
  );
  assert.equal(
    stripWorkspaceCdPrefix('cd packages/client && npm run build', ws),
    'cd packages/client && npm run build',
    '切换到子目录的命令不应被误剥离'
  );

  const turn = createEmptyAssistantTurn();
  applyAgyStreamEvent(turn, {
    type: 'tool',
    tool: {
      toolCallId: 'call_node_1',
      name: 'run_command',
      kind: 'execute',
      status: 'pending',
      command: 'Set-Location "C:\\Users\\you\\my-project"; node app.js',
    },
  });
  applyAgyStreamEvent(turn, {
    type: 'permission',
    requestId: 'perm-1',
    sessionId: 's-1',
    toolCall: {
      toolCallId: 'call_node_1',
      name: 'run_command',
      kind: 'execute',
      command: 'Set-Location "C:\\Users\\you\\my-project"; node app.js',
    },
    options: [
      { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
      { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
    ],
  });
  assert.equal(turn.permissions.filter((p) => p.status === 'pending').length, 1);

  applyAgyStreamEvent(turn, {
    type: 'permission-resolved',
    requestId: 'perm-1',
    toolCallId: 'call_node_1',
    outcome: 'selected',
    optionId: 'allow',
  });
  assert.equal(turn.permissions.filter((p) => p.status === 'pending').length, 0, '批准后待确认审批卡立即收起');
  assert.equal(turn.toolsById.call_node_1.approvalState, 'allowed', '批准结论合并到同一 toolCallId 的工具卡');
  assert.equal(turn.toolsById.call_node_1.command, 'Set-Location "C:\\Users\\you\\my-project"; node app.js', '展开详情保留完整原始命令');
  const execMeta = classifyToolKind(turn.toolsById.call_node_1, { sessionCwd: ws });
  assert.equal(execMeta.summary, 'node app.js', '工具卡标题去掉 Set-Location 前缀');

  const act = buildActivityTimeline([turn], ws);
  assert.equal(act.items[0].summary, 'node app.js');
  assert.equal(act.items[1].entryType, 'tool');
  assert.equal(act.items[1].targetId, 'call_node_1');

  const replayed = normalizeHistoryMessages([
    { role: 'user', text: '验证' },
    { role: 'assistant', status: 'done', text: '完成', tools: [{ toolCallId: 'call_node_1', name: 'run_command', kind: 'execute', status: 'completed', approvalState: 'allowed', command: 'node app.js' }] },
  ], 's-1');
  assert.equal(replayed[1].toolsById.call_node_1.approvalState, 'allowed');

  const manySessions = [
    { sessionId: 'c-vault', cwd: 'D:\\Notes', updatedMs: 9000, title: 'Vault 会话' },
    { sessionId: 'c-icloud', cwd: 'C:\\Users\\you\\iCloudDrive\\iCloud~md~obsidian\\Claude', updatedMs: 8900, title: 'iCloud 笔记会话' },
    { sessionId: 'p-3', cwd: 'E:\\Work\\alpha', updatedMs: 8800, title: 'Alpha' },
    { sessionId: 'p-4', cwd: 'E:\\Work\\beta', updatedMs: 8700, title: 'Beta' },
    { sessionId: 'p-5', cwd: 'E:\\Work\\gamma', updatedMs: 8600, title: 'Gamma' },
    { sessionId: 'p-6', cwd: 'E:\\Scratch\\study-1', updatedMs: 8500, title: '一次性调研 1' },
    { sessionId: 'p-7', cwd: 'E:\\Scratch\\study-2', updatedMs: 8400, title: '深入排查关键字XYZ' },
  ];
  const grouped = groupSessionsByProjectAndTime(manySessions, [], '', 10_000);
  assert.equal(grouped.primaryProjects.length, 5);
  assert.equal(grouped.moreProjects.length, 2);
  assert.equal(grouped.primaryProjects[0].displayName, 'Claude · Vault');
  assert.equal(grouped.primaryProjects[0].parentHint, 'Vault');
  assert.equal(grouped.primaryProjects[1].displayName, 'Claude · iCloudDrive');
  assert.equal(grouped.primaryProjects[1].parentHint, 'iCloudDrive');
  assert.equal(grouped.moreProjects[0].defaultCollapsed, true);

  const searched = groupSessionsByProjectAndTime(manySessions, [], '关键字XYZ', 10_000);
  assert.equal(searched.total, 1);
  assert.equal(searched.byProject[0].name, 'study-2');
});

test('模型描述去冗余：选择器不带副标题注释', () => {
  // 模型、思考档位与运行模式选择器一律不带副标题注释；effort 严格显示小写调用原名
  const grouped = groupModels([
    {
      id: 'model',
      category: 'model',
      currentValue: 'gemini-4-carbon',
      options: [
        { value: 'gemini-4-carbon', name: 'Gemini 4 Carbon' },
        { value: 'gemini-4-hydrogen', name: 'Gemini 4 Hydrogen', description: 'Experimental' },
      ],
    },
  ]);
  assert.equal(grouped.flat[0].description, '');
  assert.equal(grouped.flat[1].description, '');

  const thoughts = extractThoughtOptions([
    {
      id: 'thought_level',
      category: 'thought_level',
      currentValue: 'medium',
      options: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' },
        { value: 'xhigh', name: 'XHigh' },
      ],
    },
  ]);
  assert.deepEqual(thoughts.options.map((o) => o.name), ['low', 'medium', 'high', 'xhigh']);

  const modes = extractModeOptions([
    {
      id: 'mode',
      category: 'mode',
      currentValue: 'default',
      options: [
        { value: 'default', name: 'Default', description: 'Ask first' },
        { value: 'accept-edits', name: 'Accept edits', description: 'Auto edit' },
        { value: 'auto', name: 'Auto', description: 'Auto run' },
        { value: 'plan', name: 'Plan', description: 'Plan first' },
      ],
    },
  ]);
  assert.deepEqual(modes.options.map((m) => m.name), ['默认', '接受编辑', '自动', '计划', '完全放行']);
  assert.ok(modes.options.every((m) => m.description === ''));
});

test('bridge 工具识别只认工具名：命令里带 mcp_bridge_* 字样不会被显示成 bridge 工具（审批卡用的就是这一行）', async () => {
  const { bridgeToolOf } = await import('./logic.js');
  assert.equal(bridgeToolOf({ name: 'mcp_bridge_browser', title: 'Run mcp_bridge_browser' }), 'browser');
  assert.equal(bridgeToolOf({ name: '', title: 'Run mcp_bridge_manual' }), 'manual');   // 没有工具名的旧记录：标题得整个就是这一句
  assert.equal(bridgeToolOf({ name: 'run_command', kind: 'execute', title: 'echo mcp_bridge_browser' }), '');
  assert.equal(bridgeToolOf({ name: '', kind: 'execute', title: 'Run mcp_bridge_browser', command: 'Run mcp_bridge_browser' }), '');
  assert.equal(bridgeToolOf({ name: '', title: 'echo x; Run mcp_bridge_manual' }), '');
  const cmd = classifyToolKind({ name: 'run_command', kind: 'execute', title: 'echo mcp_bridge_browser', args: { CommandLine: 'echo mcp_bridge_browser' } });
  assert.equal(cmd.category, 'execute');
  assert.notEqual(cmd.verb, '操作浏览器');
  assert.equal(classifyToolKind({ name: 'mcp_bridge_media_models', args: { kind: 'image' } }).verb, '查媒体模型');
});

test('步骤汇总里 bridge 工具各归各类：操作浏览器不算网络检索，查手册 / 读绘图规范不算读取文件', async () => {
  const { summarizeSteps } = await import('./step-summary.js');
  const tool = (id, name, args = {}, extra = {}) => ({ blk: { type: 'tool' }, tool: { toolCallId: id, name, args, status: 'completed', ...extra } });
  const s = summarizeSteps([
    tool('1', 'mcp_bridge_browser', { action: 'navigate', url: 'https://example.com' }),
    tool('2', 'mcp_bridge_browser', { action: 'screenshot' }),
    tool('3', 'mcp_bridge_manual', { q: 'routines.create' }),
    tool('4', 'mcp_bridge_visualize_read_me', {}),
    tool('5', 'mcp_bridge_terminal', { action: 'run', command: 'echo hi' }),
    tool('6', 'mcp_bridge_terminal', { action: 'read' }),
    tool('7', 'read_file', { Path: 'C:/x/a.txt' }, { kind: 'read' }),
  ]);
  assert.deepEqual(s.pieces.map((p) => p.text), ['操作浏览器 2 次', '查 bridge 手册', '读取绘图规范', '执行 1 条命令', '查看共享终端', '读取 1 个文件']);
});

test('agy 多代理与后台任务原生工具分类：invoke_subagent / send_message / swarm / run_workflow / schedule', () => {
  const sub = classifyToolKind({
    name: 'invoke_subagent',
    args: { TypeName: 'self', Role: 'Codebase Researcher', Prompt: '检查 modules/agy 路由' },
  });
  assert.equal(sub.icon, 'smart_toy');
  assert.equal(sub.verb, '派出子代理');
  assert.match(sub.summary, /Codebase Researcher/);

  const img = classifyToolKind({
    name: 'invoke_subagent',
    args: { TypeName: 'image-generator', Role: 'Painter', Prompt: '水墨山水' },
  });
  assert.equal(img.icon, 'image');
  assert.equal(img.verb, '生成图片');

  assert.equal(classifyToolKind({ name: 'define_subagent', args: { Name: 'reviewer' } }).verb, '定义子代理');
  assert.equal(classifyToolKind({ name: 'send_message', args: { Recipient: 'c-1', Message: '继续下一步' } }).verb, '给子代理发消息');
  assert.equal(classifyToolKind({ name: 'manage_subagents', args: { Action: 'list' } }).verb, '查看子代理状态');
  assert.equal(classifyToolKind({ name: 'manage_subagents', args: { Action: 'kill', ConversationIds: ['c-1'] } }).verb, '停止子代理');
  assert.equal(classifyToolKind({ name: 'run_workflow', args: { Description: '并行审计' } }).verb, '运行工作流');
  const swAdd = classifyToolKind({ name: 'swarm', args: { action: 'add', name: 'worker-1' } });
  assert.equal(swAdd.verb, '多代理协作');
  assert.match(swAdd.summary, /添加成员.*worker-1/);
  const swTitle = classifyToolKind({ name: 'swarm', args: { action: 'title', title: '重构支付' } });
  assert.equal(swTitle.verb, '多代理协作');
  assert.match(swTitle.summary, /重构支付/);
  const swPost = classifyToolKind({ name: 'post_message', args: { channel: 'ui', text: '@frontend 请核对配色' } });
  assert.equal(swPost.verb, '发布协作消息');
  assert.match(swPost.summary, /#ui/);
  const swRead = classifyToolKind({ name: 'read_board', args: { since: 4 } });
  assert.equal(swRead.verb, '读取协作消息板');
  assert.match(swRead.summary, /#4/);
  assert.equal(classifyToolKind({ name: 'swarm_wait', args: { since: 7 } }).verb, '等待协作动态');
  assert.equal(classifyToolKind({ name: 'schedule', args: { Prompt: '检查进度' } }).verb, '定时任务');
  assert.equal(classifyToolKind({ name: 'manage_task', args: { Action: 'list' } }).verb, '管理后台任务');
});

test('parseAgyModelAndEffort：准确拆出真实 agy 转录中的基础模型名与思考强度', async () => {
  const { parseAgyModelAndEffort } = await import('./catalog.js');
  assert.deepEqual(parseAgyModelAndEffort('gemini-4-hydrogen-tiered-high'), {
    raw: 'gemini-4-hydrogen-tiered-high',
    modelId: 'gemini-4-hydrogen',
    modelName: 'Gemini 4 Hydrogen',
    effort: 'high',
  });
  assert.deepEqual(parseAgyModelAndEffort('gemini-4-neon-xhigh'), {
    raw: 'gemini-4-neon-xhigh',
    modelId: 'gemini-4-neon',
    modelName: 'Gemini 4 Neon',
    effort: 'xhigh',
  });
  assert.deepEqual(parseAgyModelAndEffort('gemini-3.8-flash-medium'), {
    raw: 'gemini-3.8-flash-medium',
    modelId: 'gemini-3.8-flash',
    modelName: 'Gemini 3.8 Flash',
    effort: 'medium',
  });
  assert.deepEqual(parseAgyModelAndEffort('claude-sonnet-4-6'), {
    raw: 'claude-sonnet-4-6',
    modelId: 'claude-sonnet-4-6',
    modelName: 'Claude Sonnet 4.6',
    effort: '',
  });
});
