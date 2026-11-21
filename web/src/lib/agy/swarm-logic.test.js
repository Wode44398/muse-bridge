import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSwarmViewModel,
  filterSwarmMessages,
  collapseRecipientGroups,
  stripLeadingMentions,
  shortWorkspacePath,
  renderSwarmPostHtml,
  computeSwarmGraph,
} from './swarm-logic.js';

function makeSnap(overrides = {}) {
  return {
    hasSwarm: true,
    id: 's-1',
    title: '重构支付网关',
    head: 5,
    finished: false,
    hasActive: true,
    needsUser: false,
    coordAsk: '',
    stall: null,
    systemAttention: [],
    members: [
      { name: 'coordinator', role: 'coordinator', conversationId: 's-1', status: 'waiting', killed: false, posts: 2, lastReadSeq: 5 },
      { name: 'backend', role: 'worker', conversationId: 'w-1', status: 'waiting', killed: false, posts: 1, lastReadSeq: 5 },
      { name: 'frontend', role: 'worker', conversationId: 'w-2', status: 'working', killed: false, posts: 1, activity: '正在调整移动端折行', lastReadSeq: 4 },
      { name: 'qa', role: 'worker', conversationId: 'w-3', status: 'waiting', killed: false, posts: 1, lastReadSeq: 5 },
      { name: 'monitor', role: 'monitor', roleWorker: true, conversationId: 'w-4', status: 'waiting', killed: false, posts: 0, lastReadSeq: 5 },
    ],
    channels: [
      { name: 'api', topic: '接口设计', archived: false, posts: 2 },
      { name: 'ui', topic: '前端界面', archived: false, posts: 2 },
    ],
    messages: [
      { seq: 1, agent: 'coordinator', channel: 'api', text: '@backend 拆出鉴权中间件', mentions: ['backend'], viaChannel: [], channelMentions: [], all: false, ts: 1000 },
      { seq: 2, agent: 'coordinator', channel: 'ui', text: '@frontend 实现新面板', mentions: ['frontend'], viaChannel: [], channelMentions: [], all: false, ts: 2000 },
      { seq: 3, agent: 'backend', channel: 'api', text: '@coordinator [done] 中间件已完成并过测', mentions: ['coordinator'], viaChannel: [], channelMentions: [], all: false, ts: 3000 },
      { seq: 4, agent: 'frontend', channel: 'ui', text: '@qa 能否帮我核对一下暗色模式对比度？\nScreenshot: C:\\tmp\\shot1.png | 首帧', mentions: ['qa'], viaChannel: [], channelMentions: [], all: false, ts: 4000 },
      { seq: 5, agent: 'qa', channel: 'main', text: '@frontend @#ui 请确认 #4 的边框色值是否对齐？', mentions: ['frontend'], viaChannel: ['frontend'], channelMentions: ['ui'], all: false, ts: 5000 },
    ],
    plan: {
      goal: { title: '上线新版 Swarm 面板', line: '只读展示全部协作视图。' },
      tasks: { backend: '后端只读接口', frontend: '前端四视图', qa: '双主题核验' },
      threads: [
        { id: 't1', title: '服务端', goal: '安全只读', tasks: ['backend'] },
        { id: 't2', title: '前端与验收', goal: '视图与测试', tasks: ['frontend', 'qa'] },
      ],
    },
    frames: [
      { seq: 4, agent: 'frontend', caption: '首帧', url: '/api/agy/artifact?id=s-1&path=shot1.png' },
    ],
    summary: { totalTokens: 12000, durationMs: 45_000, startedAt: 1000 },
    ...overrides,
  };
}

test('buildSwarmViewModel：正确推导任务进度、waiting_on、分组统计与截图时间线完成度', () => {
  const vm = buildSwarmViewModel(makeSnap());
  assert.ok(vm);
  assert.equal(vm.title, '重构支付网关');
  assert.equal(vm.totals.total, 3);
  assert.equal(vm.totals.done, 1, 'backend 发了 [done]');
  assert.equal(vm.totals.running, 1, 'frontend 正在工作');
  assert.equal(vm.totals.blocked, 1, 'qa 在 #5 追问 @frontend 且尚未收到回复');
  assert.equal(vm.memberByName.get('qa')?.waitingOn, 'frontend');
  assert.equal(vm.memberGroups.coordinator?.name, 'coordinator');
  assert.equal(vm.memberGroups.observers.length, 1);
  assert.equal(vm.memberGroups.observers[0].name, 'monitor');
  assert.equal(vm.threads.length, 2);
  assert.equal(vm.threads[0].state, 'done');
  assert.equal(vm.frames[0].doneAt, 1, '#4 时 backend 已在 #3 完成');

  // 已结束的 Swarm 不应再将等待状态标为 blocked
  const doneVm = buildSwarmViewModel(makeSnap({
    finished: true,
    hasActive: false,
    members: makeSnap().members.map((m) => ({ ...m, status: 'waiting' })),
  }));
  assert.equal(doneVm.totals.done, 3);
  assert.equal(doneVm.totals.blocked, 0);
});

test('filterSwarmMessages / collapseRecipientGroups / stripLeadingMentions / shortWorkspacePath', () => {
  const snap = makeSnap();
  assert.equal(filterSwarmMessages(snap.messages, { channel: 'api' }).length, 2);
  assert.equal(filterSwarmMessages(snap.messages, { to: 'frontend' }).length, 2, '含直接 @frontend 与经 @#ui 投递的 #5');
  assert.equal(filterSwarmMessages(snap.messages, { q: '#4' }).length, 2, '#4 本身与引用了 #4 的 #5');
  assert.equal(filterSwarmMessages(snap.messages, { hiddenAgents: new Set(['coordinator']) }).length, 3);

  const roster = [{ name: 'worker-1' }, { name: 'worker-2' }, { name: 'reviewer' }];
  assert.deepEqual(collapseRecipientGroups(['worker-1', 'worker-2', 'reviewer'], roster), ['worker', 'reviewer']);
  assert.deepEqual(collapseRecipientGroups(['worker-1', 'reviewer'], roster), ['worker-1', 'reviewer']);

  assert.equal(stripLeadingMentions('@backend, @qa: 请查看报告'), '请查看报告');
  assert.equal(shortWorkspacePath('C:\\Users\\you\\claude-bridge\\modules\\agy'), '…/modules/agy');
});

test('renderSwarmPostHtml：防 XSS、高亮 @member/@#channel/#seq 并可隐藏 Screenshot 原文行', () => {
  const snap = makeSnap();
  const html = renderSwarmPostHtml(
    '@frontend @#ui 查看 #3 和 <script>alert(1)</script> [done]\nScreenshot: C:\\tmp\\shot1.png | 首帧',
    { members: snap.members, channels: snap.channels, messages: snap.messages, hideShotLines: true },
  );
  assert.doesNotMatch(html, /<script>/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(html, /data-sw-member="frontend"/);
  assert.match(html, /data-sw-channel="ui"/);
  assert.match(html, /data-sw-seq="3"/);
  assert.match(html, /class="sw-tag done"/);
  assert.doesNotMatch(html, /shot1\.png/, 'hideShotLines=true 时应隐藏原始 Screenshot 路径行');
});

test('computeSwarmGraph：节点排布、去角色节点、时间线回放与 @all 展开', () => {
  const snap = makeSnap();
  const full = computeSwarmGraph(snap, { width: 420 });
  assert.equal(full.nodes.length, 4, '排除 monitor 观察者节点');
  assert.ok(full.edges.some((e) => e.from === 'qa' && e.to === 'frontend'));
  assert.equal(full.replaying, false);

  const step2 = computeSwarmGraph(snap, { upto: 2, width: 420 });
  assert.equal(step2.replaying, true);
  assert.equal(step2.current?.seq, 2);
  assert.equal(step2.edges.length, 2);
  assert.equal(step2.nodes.find((n) => n.id === 'qa')?.inactive, true);
  assert.equal(step2.nodes.find((n) => n.id === 'frontend')?.hot, true);

  // 超过 12 个节点切分层布局
  const bigMembers = [
    { name: 'coordinator', role: 'coordinator', status: 'waiting' },
    ...Array.from({ length: 14 }, (_, i) => ({ name: `w-${i + 1}`, role: 'worker', status: 'working' })),
  ];
  const big = computeSwarmGraph({ members: bigMembers, messages: [] }, { width: 420 });
  assert.equal(big.nodes.length, 15);
  assert.ok(big.height >= 160);
});
