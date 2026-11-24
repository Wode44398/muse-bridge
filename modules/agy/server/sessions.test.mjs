import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyLastTurnStatsMeta,
  isDaemonPseudoCwd,
  filterAgySessionList,
  fetchRawSessionList,
  invalidateSessionsCache,
  loadAgySessionDetail,
  resolveVerifiedSessionCwd,
  applyInterruptedMeta,
  applyToolApprovalsMeta,
  extractRecentSessionDirs,
  getSessionMeta,
  hideSessions,
  markSessionDeleted,
  noteSessionMeta,
} from './sessions.mjs';
import { buildEffectiveAgySystemPrompt } from './settings.mjs';
import { createProject } from './projects.mjs';
import { reconstructHistoryMessages } from './events.mjs';
import { agyCredentialsPresent, prepareReadOnlyDaemonDir, unlockDaemonDir, defaultDaemonCwd } from './acp/binary.mjs';
import { setAcpClientForTest } from './acp/index.mjs';

const tmp = mkdtempSync(path.join(os.tmpdir(), 'bridge-agy-sessions-'));
after(() => {
  setAcpClientForTest(null);
  delete process.env.AGY_APP_DATA_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

test('filterAgySessionList：剥离守护目录伪路径、解码混杂 cwd、按时间降序并支持搜索与隐藏过滤', () => {
  const rawSessions = [
    // 无工作区旧会话回填了守护目录，时间戳虽新但不属于目标项目
    {
      sessionId: 'phantom-1',
      cwd: 'C:\\data\\agy\\daemon-cwd',
      title: '自选股监控',
      updatedAt: '2026-11-17T20:00:00Z',
    },
    {
      sessionId: 'proj-older',
      cwd: '/d%3A/Projects/demo%20app',
      title: '第一版草案',
      updatedAt: '2026-11-16T10:00:00Z',
    },
    {
      sessionId: 'proj-newer',
      cwd: '/D:/Projects/demo%20app',
      title: 'ACP 协议调研',
      updatedAt: '2026-11-17T18:00:00Z',
    },
    {
      sessionId: 'proj-hidden',
      cwd: '/D:/Projects/demo%20app',
      title: '已删除的测试对话',
      updatedAt: '2026-11-17T19:00:00Z',
    },
    {
      sessionId: 'other-proj',
      cwd: '/C:/Users/dev/other-repo',
      title: '别的仓库',
      updatedAt: '2026-11-17T21:00:00Z',
    },
  ];

  const metaMap = {
    'proj-hidden': { hidden: true },
    'proj-older': { customTitle: '重命名后的草案' },
    'local-fresh': {
      cwd: 'D:\\Projects\\demo app',
      title: '刚新建还未刷盘的对话',
      updatedAt: '2026-11-17T22:00:00Z',
    },
  };

  // 1) 按目标项目目录过滤：剔除 phantom-1、other-proj 与 hidden，补入 local-fresh 并严格按时间降序
  const byProj = filterAgySessionList(rawSessions, {
    metaMap,
    daemonCwd: 'C:\\data\\agy\\daemon-cwd',
    cwd: 'D:\\Projects\\demo app',
    platform: 'win32',
  });

  assert.equal(byProj.hiddenCount, 1);
  assert.deepEqual(byProj.sessions.map((s) => s.sessionId), [
    'local-fresh',
    'proj-newer',
    'proj-older',
  ]);
  assert.equal(byProj.sessions[1].cwd, 'D:\\Projects\\demo app');
  assert.equal(byProj.sessions[2].title, '重命名后的草案');

  // 2) 全量列表（不传 cwd）：phantom-1 的 cwd 被清空为无归属，不冒充真实文件夹
  const all = filterAgySessionList(rawSessions, {
    metaMap,
    daemonCwd: 'C:\\data\\agy\\daemon-cwd',
    platform: 'win32',
  });
  const phantom = all.sessions.find((s) => s.sessionId === 'phantom-1');
  assert.equal(phantom.cwd, '');

  // 3) 关键词搜索与 includeHidden
  const searched = filterAgySessionList(rawSessions, {
    metaMap,
    daemonCwd: 'C:\\data\\agy\\daemon-cwd',
    query: '测试对话',
    includeHidden: true,
    platform: 'win32',
  });
  assert.deepEqual(searched.sessions.map((s) => s.sessionId), ['proj-hidden']);
});

test('invalidateSessionsCache：代数作废在途请求，慢旧响应不会覆盖新缓存', async () => {
  invalidateSessionsCache();
  let calls = 0;
  let resolveFirst;
  const mockClient = {
    daemonCwd: path.join(tmp, 'daemon'),
    listSessions: () => {
      const idx = ++calls;
      if (idx === 1) {
        return new Promise((resolve) => { resolveFirst = resolve; });
      }
      return Promise.resolve([{ sessionId: 'new-session', cwd: 'C:\\proj', title: '新版列表', updatedAt: '2026-11-17T12:00:00Z' }]);
    },
  };

  // 第 1 次拉取挂起在途时使缓存失效
  const firstPromise = fetchRawSessionList(mockClient);
  invalidateSessionsCache();

  // 第 2 次拉取不会复用已作废的 firstPromise，而是立刻发出新请求拿到最新数据
  const secondResult = await fetchRawSessionList(mockClient);
  assert.equal(calls, 2);
  assert.equal(secondResult[0].sessionId, 'new-session');

  // 随后旧的慢请求才返回陈旧空表，不应污染已写入的新缓存
  resolveFirst([]);
  await firstPromise;

  const cachedResult = await fetchRawSessionList(mockClient);
  assert.equal(calls, 2, '命中第 2 次写入的有效缓存');
  assert.equal(cachedResult[0].sessionId, 'new-session');
});

test('fetchRawSessionList：每个 agy 进程各一份缓存，两个身份前后脚、同时取都拿不到对方的会话', async () => {
  invalidateSessionsCache();
  const mk = (name, delayMs) => {
    const c = { daemonCwd: path.join(tmp, 'same-daemon'), calls: 0 };
    c.listSessions = () => {
      c.calls++;
      return new Promise((resolve) => setTimeout(() => resolve([{ sessionId: name + '-session', cwd: 'C:\\' + name, title: name }]), delayMs));
    };
    return c;
  };
  // 占位目录恰好一样（以前靠它区分缓存归谁）、一个慢一个快
  const admin = mk('admin', 40);
  const member = mk('member', 5);

  // 同时取：以前后一个会直接拿到前一个在途的请求
  const [a1, m1] = await Promise.all([fetchRawSessionList(admin), fetchRawSessionList(member)]);
  assert.equal(a1[0].sessionId, 'admin-session');
  assert.equal(m1[0].sessionId, 'member-session');

  // 前后脚取：以前后一个会命中前一个刚写的缓存
  assert.equal((await fetchRawSessionList(member))[0].sessionId, 'member-session');
  assert.equal((await fetchRawSessionList(admin))[0].sessionId, 'admin-session');
  assert.equal(admin.calls, 1, '各自的缓存照常命中');
  assert.equal(member.calls, 1);

  // 刷新时两边都作废，但仍然各取各的
  const [a2, m2] = await Promise.all([fetchRawSessionList(admin, { refresh: true }), fetchRawSessionList(member)]);
  assert.equal(a2[0].sessionId, 'admin-session');
  assert.equal(m2[0].sessionId, 'member-session');
  invalidateSessionsCache();
});

test('loadAgySessionDetail：已存 cwd 优先于查询参数，无归属会话的临时工作目录不写盘', async () => {
  const agyDir = path.join(tmp, 'agy-meta');
  const savedDir = path.join(tmp, 'saved-cwd');
  const queryDir = path.join(tmp, 'query-cwd');
  const fallbackDir = path.join(tmp, 'fallback-cwd');
  mkdirSync(agyDir, { recursive: true });
  mkdirSync(savedDir, { recursive: true });
  mkdirSync(queryDir, { recursive: true });
  mkdirSync(fallbackDir, { recursive: true });

  noteSessionMeta(agyDir, 'bound-s1', { cwd: savedDir });

  const loadCalls = [];
  const fakeClient = {
    daemonCwd: path.join(tmp, 'daemon-cwd'),
    shutdown() {},
    listSessions: async () => [
      { sessionId: 'unscoped-s2', cwd: path.join(tmp, 'daemon-cwd'), title: 'Unscoped', updatedAt: '2026-11-17T10:00:00Z' },
    ],
    loadSessionWithReplay: async (id, opts) => {
      loadCalls.push({ id, opts });
      return {
        snapshot: { sessionId: id, configOptions: [], modes: null, models: null },
        updates: [
          { params: { sessionId: id, update: { sessionUpdate: 'session_info_update', title: `Title-${id}` } } },
        ],
      };
    },
  };
  setAcpClientForTest(fakeClient);

  const ctx = { kind: 'admin', cwd: fallbackDir, agyDir, agyProjects: path.join(tmp, 'projects.json') };

  // 1) 已绑定 cwd 的会话：查询参数传不同 cwd 不会改写绑定
  const d1 = await loadAgySessionDetail(ctx, 'bound-s1', { cwd: queryDir });
  assert.equal(d1.cwd, savedDir);
  assert.equal(loadCalls[0].opts.cwd, savedDir);
  assert.equal(loadCalls[0].opts.forceCwd, true);
  assert.equal(getSessionMeta(agyDir, 'bound-s1').cwd, savedDir);

  // 2) 无真实 cwd 的会话：RPC 使用 fallbackCwd，但写标题元数据绝不把 fallbackDir 落盘成永久 cwd
  const d2 = await loadAgySessionDetail(ctx, 'unscoped-s2');
  assert.equal(d2.title, 'Title-unscoped-s2');
  assert.equal(loadCalls[1].opts.cwd, '');
  assert.equal(loadCalls[1].opts.fallbackCwd, fallbackDir);
  assert.equal(loadCalls[1].opts.forceCwd, false);
  const s2Meta = getSessionMeta(agyDir, 'unscoped-s2');
  assert.equal(s2Meta.title, 'Title-unscoped-s2');
  assert.equal(s2Meta.cwd, undefined);
});

test('loadAgySessionDetail：在跑会话不 load、返回本轮之前的历史并带 live 标记', async () => {
  const agyDir = path.join(tmp, 'agy-live-meta');
  mkdirSync(agyDir, { recursive: true });
  noteSessionMeta(agyDir, 'live-s1', { cwd: tmp, title: '模型选择器优化' });
  let loads = 0;
  const up = (update) => ({ params: { sessionId: 'live-s1', update } });
  setAcpClientForTest({
    daemonCwd: path.join(tmp, 'daemon-cwd'),
    shutdown() {},
    listSessions: async () => [],
    hasActiveTurn: (id) => id === 'live-s1',
    getLiveHistory: () => [
      up({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '第一轮' } }),
      up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '好的' } }),
    ],
    getMountedSnapshot: () => ({ sessionId: 'live-s1', configOptions: [], title: 'agy 标题' }),
    loadSessionWithReplay: async () => { loads++; throw Object.assign(new Error('busy'), { status: 409 }); },
  });
  const ctx = { kind: 'admin', cwd: tmp, agyDir, agyProjects: path.join(tmp, 'projects.json') };
  const d = await loadAgySessionDetail(ctx, 'live-s1');
  assert.equal(loads, 0, '在跑时绝不 session/load');
  assert.equal(d.live, true);
  assert.equal(d.historyComplete, true);
  assert.equal(d.title, '模型选择器优化', '标题用会话标题，不用本轮发的话');
  assert.deepEqual(d.messages.map((m) => [m.role, m.text]), [['user', '第一轮'], ['assistant', '好的']]);
});

test('agyCredentialsPresent：仅有 installation_id 不算已登录，存在真实凭据才为 true', () => {
  const fakeAppDir = path.join(tmp, 'agy-appdata');
  mkdirSync(fakeAppDir, { recursive: true });
  process.env.AGY_APP_DATA_DIR = fakeAppDir;
  const oldKey = process.env.GEMINI_API_KEY;
  const oldAdc = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GEMINI_API_KEY;
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;

  try {
    writeFileSync(path.join(fakeAppDir, 'installation_id'), '00000000-1111-2222-3333-444444444444');
    assert.equal(agyCredentialsPresent(), false, '仅含 installation_id 时不应判为已认证');

    writeFileSync(path.join(fakeAppDir, 'oauth_creds.json'), '{"refresh_token":"x"}');
    assert.equal(agyCredentialsPresent(), true);
  } finally {
    if (oldKey !== undefined) process.env.GEMINI_API_KEY = oldKey;
    if (oldAdc !== undefined) process.env.GOOGLE_APPLICATION_CREDENTIALS = oldAdc;
  }
});

test('isDaemonPseudoCwd 与跨实例 daemon-cwd 剔除：其它临时目录残留的守护伪路径不冒充真实工作目录', async () => {
  assert.equal(isDaemonPseudoCwd('C:\\Users\\dev\\AppData\\Local\\Temp\\test-99\\agy\\daemon-cwd', 'D:\\data\\agy\\daemon-cwd', 'win32'), true);
  assert.equal(isDaemonPseudoCwd('/tmp/bridge-e2e/agy/daemon-cwd/', '/var/data/agy/daemon-cwd', 'linux'), true);
  assert.equal(isDaemonPseudoCwd('C:\\Users\\dev\\cb-agy', 'D:\\data\\agy\\daemon-cwd', 'win32'), false);

  const raw = [
    { sessionId: 'other-inst', cwd: 'C:\\Temp\\old-run\\agy\\daemon-cwd', title: '跨实例无目录会话', updatedAt: '2026-11-17T22:00:00Z' },
  ];
  const filtered = filterAgySessionList(raw, {
    metaMap: { 'other-inst': { cwd: 'E:\\another\\agy\\daemon-cwd' } },
    daemonCwd: 'C:\\current\\agy\\daemon-cwd',
    platform: 'win32',
  });
  assert.equal(filtered.sessions[0].cwd, '');
  assert.equal(filtered.sessions[0].projectName, '');

  const agyDir = path.join(tmp, 'agy-pseudo-meta');
  mkdirSync(agyDir, { recursive: true });
  noteSessionMeta(agyDir, 'other-inst', { cwd: 'C:\\Temp\\old-run\\agy\\daemon-cwd', title: 'KeepTitle' });
  assert.equal(getSessionMeta(agyDir, 'other-inst').cwd, undefined);

  const fakeClient = {
    daemonCwd: 'C:\\current\\agy\\daemon-cwd',
    listSessions: async () => raw,
  };
  const verified = await resolveVerifiedSessionCwd({ agyDir }, 'other-inst', fakeClient);
  assert.equal(verified, '');
});

test('applyInterruptedMeta：session/load 回放后仍保留「已停止」标记，未完结工具归为 cancelled', () => {
  // 1) 回放里有半截回复与 in_progress 工具
  const msgs1 = [
    { role: 'user', text: '跑一下长任务', images: [], blocks: [{ type: 'text', text: '跑一下长任务' }] },
    {
      role: 'assistant',
      text: '正在准备…',
      thinking: '',
      tools: [{ toolCallId: 'c1', name: 'run_command', kind: 'execute', status: 'in_progress' }],
      blocks: [
        { type: 'tool', tool: { toolCallId: 'c1', name: 'run_command', kind: 'execute', status: 'in_progress' } },
        { type: 'text', text: '正在准备…' },
      ],
    },
  ];
  applyInterruptedMeta(msgs1, {
    lastTurnStatus: 'interrupted',
    interruptedTurns: [{ prompt: '跑一下长任务', partialText: '正在准备…' }],
  });
  assert.equal(msgs1[1].status, 'interrupted');
  assert.equal(msgs1[1].tools[0].status, 'cancelled');
  assert.equal(msgs1[1].blocks[0].tool.status, 'cancelled');

  // 2) 首 token 前即取消：回放只有末尾 user 消息，无 assistant 消息时自动补上 interrupted 轮次
  const msgs2 = [
    { role: 'user', text: '立刻取消的问题', images: [], blocks: [{ type: 'text', text: '立刻取消的问题' }] },
  ];
  applyInterruptedMeta(msgs2, {
    lastTurnStatus: 'interrupted',
    interruptedTurns: [{ prompt: '立刻取消的问题', partialText: '' }],
  });
  assert.equal(msgs2.length, 2);
  assert.equal(msgs2[1].role, 'assistant');
  assert.equal(msgs2[1].status, 'interrupted');

  // 3) 正常完成的一轮里含后台化 run_command（status 仍为 in_progress，后面已有模型正文回复）：
  //    无论 lastTurnStatus 是 completed 还是 live 分支传空串，都绝不能误标成 interrupted / cancelled
  const makeBgMsgs = () => ([
    { role: 'user', text: '发版并构建 APK', images: [], blocks: [{ type: 'text', text: '发版并构建 APK' }] },
    {
      role: 'assistant',
      text: '正在后台构建 APK，完成后继续部署。',
      thinking: '',
      tools: [{ toolCallId: 'bg1', name: 'run_command', kind: 'execute', status: 'in_progress' }],
      blocks: [
        { type: 'tool', tool: { toolCallId: 'bg1', name: 'run_command', kind: 'execute', status: 'in_progress' } },
        { type: 'text', text: '正在后台构建 APK，完成后继续部署。' },
      ],
    },
  ]);
  const bgDone = makeBgMsgs();
  applyInterruptedMeta(bgDone, { lastTurnStatus: 'completed' });
  assert.notEqual(bgDone[1].status, 'interrupted');
  assert.equal(bgDone[1].tools[0].status, 'in_progress');
  assert.equal(bgDone[1].blocks[0].tool.status, 'in_progress');

  const bgBeforeLive = makeBgMsgs();
  applyInterruptedMeta(bgBeforeLive, { lastTurnStatus: '' });
  assert.notEqual(bgBeforeLive[1].status, 'interrupted');
  assert.equal(bgBeforeLive[1].tools[0].status, 'in_progress');

  // 4) bridge 外部工具执行中途断掉（in_progress 悬空在末尾、后面无正文也无已完成工具，且非 completed 轮）：仍补标 interrupted
  const extCut = [
    { role: 'user', text: '外部跑命令', images: [], blocks: [{ type: 'text', text: '外部跑命令' }] },
    {
      role: 'assistant',
      text: '',
      thinking: '先跑命令',
      tools: [{ toolCallId: 'cut1', name: 'run_command', kind: 'execute', status: 'in_progress' }],
      blocks: [
        { type: 'thinking', text: '先跑命令' },
        { type: 'tool', tool: { toolCallId: 'cut1', name: 'run_command', kind: 'execute', status: 'in_progress' } },
      ],
    },
  ];
  applyInterruptedMeta(extCut, {});
  assert.equal(extCut[1].status, 'interrupted');
  assert.equal(extCut[1].tools[0].status, 'cancelled');
  assert.equal(extCut[1].blocks[1].tool.status, 'cancelled');
});

test('会话 cwd 强提示与只读空 daemon-cwd 守卫：注入真实项目绝对路径并阻止向守护占位目录写入', () => {
  const prompt = buildEffectiveAgySystemPrompt({}, {
    hasBridgeTools: false,
    cwd: '/D:/Projects/my-app',
    additionalDirectories: ['C:\\shared\\docs', 'C:\\data\\agy\\daemon-cwd'],
  });
  assert.match(prompt, /【当前会话工作目录】：`D:\\Projects\\my-app`/);
  assert.match(prompt, /严禁读写或进入 `daemon-cwd`/);
  assert.match(prompt, /`C:\\shared\\docs`/);
  assert.doesNotMatch(prompt, /已授权附加工作目录：.*daemon-cwd/);

  // 若传入的本身是 daemon-cwd 伪目录（含迁出仓库后的系统临时目录形态），绝不把它写进系统提示冒充项目目录
  const pseudoPrompt = buildEffectiveAgySystemPrompt({}, {
    cwd: 'C:\\data\\agy\\daemon-cwd',
  });
  assert.doesNotMatch(pseudoPrompt, /【当前会话工作目录】/);
  const tmpPseudoPrompt = buildEffectiveAgySystemPrompt({}, {
    cwd: path.join(os.tmpdir(), 'claude-bridge-agy', 'abc123-main', 'daemon-cwd'),
  });
  assert.doesNotMatch(tmpPseudoPrompt, /【当前会话工作目录】/);

  // defaultDaemonCwd 必须落在 os.tmpdir() 下、远离仓库/数据根，且不同 slot / scope 互相隔离
  const repoRoot = 'C:\\Users\\you\\claude-bridge';
  const mainDaemon = defaultDaemonCwd('main', repoRoot);
  const desktopDaemon = defaultDaemonCwd('desktop', repoRoot);
  const otherDaemon = defaultDaemonCwd('main', 'C:\\tmp\\other-data-root');
  assert.equal(path.basename(mainDaemon), 'daemon-cwd');
  assert.equal(mainDaemon.toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()), true);
  assert.equal(mainDaemon.toLowerCase().startsWith(repoRoot.toLowerCase()), false);
  assert.notEqual(mainDaemon, desktopDaemon);
  assert.notEqual(mainDaemon, otherDaemon);
  assert.equal(isDaemonPseudoCwd(mainDaemon), true);

  // prepareReadOnlyDaemonDir 清空残留文件并锁定为只读空目录
  const roDaemon = path.join(tmp, 'ro', 'daemon-cwd');
  mkdirSync(roDaemon, { recursive: true });
  writeFileSync(path.join(roDaemon, 'stale.js'), 'bad');
  prepareReadOnlyDaemonDir(roDaemon);
  try {
    assert.throws(
      () => writeFileSync(path.join(roDaemon, 'app.js'), 'nope'),
      /EPERM|EACCES/,
      '只读 daemon-cwd 必须当场拦截误写入',
    );
  } finally {
    unlockDaemonDir(roDaemon);
  }
});

test('extractRecentSessionDirs 与审批结论回放：最近目录按时间排序限 8 项且剔除不存在/已存目录，同名目录消歧', () => {
  const recRoot = path.join(tmp, 'recent-test');
  const savedProjDir = path.join(recRoot, 'saved-proj');
  const vaultClaude = path.join(recRoot, 'Vault', 'Claude');
  const icloudClaude = path.join(recRoot, 'iCloudDrive', 'iCloud~md~obsidian', 'Claude');
  const goneDir = path.join(recRoot, 'deleted-folder');
  mkdirSync(savedProjDir, { recursive: true });
  mkdirSync(vaultClaude, { recursive: true });
  mkdirSync(icloudClaude, { recursive: true });

  const extraDirs = [];
  for (let i = 1; i <= 8; i++) {
    const d = path.join(recRoot, `extra-${i}`);
    mkdirSync(d, { recursive: true });
    extraDirs.push(d);
  }

  const projectsFile = path.join(recRoot, 'projects.json');
  createProject(projectsFile, { kind: 'admin' }, { path: savedProjDir });

  const sessions = [
    { sessionId: 's-daemon', cwd: path.join(recRoot, 'agy', 'daemon-cwd'), updatedMs: 9000 },
    { sessionId: 's-gone', cwd: goneDir, updatedMs: 8900 },
    { sessionId: 's-saved', cwd: savedProjDir, updatedMs: 8800 },
    { sessionId: 's-c1', cwd: icloudClaude, updatedMs: 8700 },
    { sessionId: 's-c2', cwd: vaultClaude, updatedMs: 8600 },
    ...extraDirs.map((d, idx) => ({ sessionId: `s-ex-${idx}`, cwd: d, updatedMs: 8000 - idx * 10 })),
  ];

  const recent = extractRecentSessionDirs(sessions, {
    ctx: { kind: 'admin' },
    projectsFile,
    isPseudoCwd: (p) => isDaemonPseudoCwd(p),
    limit: 8,
  });

  assert.equal(recent.length, 8, '最多返回 8 个最近目录');
  assert.equal(recent.some((r) => r.path === goneDir), false, '不存在的目录不列');
  assert.equal(recent.some((r) => r.path === savedProjDir), false, '已在项目表中的目录不重复列');
  assert.equal(recent[0].path, icloudClaude);
  assert.equal(recent[0].name, 'Claude');
  assert.equal(recent[0].parentHint, 'iCloudDrive');
  assert.equal(recent[1].path, vaultClaude);
  assert.equal(recent[1].parentHint, 'Vault');

  // 审批历史回放：经历过 pending 后 completed 的工具自动带 allowed，且侧车记录支持还原 denied
  const hist = reconstructHistoryMessages([
    { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'run test' } } },
    { update: { sessionUpdate: 'tool_call', toolCallId: 'tc-allow', name: 'run_command', kind: 'execute', status: 'in_progress', rawInput: { CommandLine: 'node app.js' } } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-allow', name: 'run_command', kind: 'execute', status: 'pending' } },
    { update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-allow', name: 'run_command', kind: 'execute', status: 'completed', rawOutput: { output: 'ok', exit_code: 0 } } },
    { update: { sessionUpdate: 'tool_call', toolCallId: 'tc-deny', name: 'run_command', kind: 'execute', status: 'failed', rawInput: { CommandLine: 'rm -rf /' } } },
  ]);
  applyToolApprovalsMeta(hist.messages, { toolApprovals: { 'tc-deny': 'denied' } });
  assert.equal(hist.messages[1].tools[0].approvalState, 'allowed');
  assert.equal(hist.messages[1].tools[1].approvalState, 'denied');
});

test('applyLastTurnStatsMeta：最后一轮的用时与 token 只挂到提问对得上的那条助手消息', () => {
  const meta = { lastTurnStats: { ms: 4200, tokens: 321, prompt: '现在来做那个 editing' } };
  const msgs = [
    { role: 'user', text: '第一轮' },
    { role: 'assistant', text: 'a' },
    { role: 'user', text: '现在来做那个 editing，重新设计一版' },
    { role: 'assistant', text: 'b' },
  ];
  applyLastTurnStatsMeta(msgs, meta);
  assert.deepEqual(msgs[3].stats, { ms: 4200, tokens: 321 });
  assert.equal(msgs[1].stats, undefined);

  const other = [{ role: 'user', text: '在 agy 自己界面里问的' }, { role: 'assistant', text: 'c' }];
  applyLastTurnStatsMeta(other, meta);
  assert.equal(other[1].stats, undefined);

  // 用户消息带「本轮附加文件路径：」前缀（附带原图或文件）时，裸 prompt 仍能正确命中用时统计与中断标记
  const withAtt = [
    { role: 'user', text: '本轮附加文件路径：\n- C:\\uploads\\1795-a.png\n\n现在来做那个 editing' },
    { role: 'assistant', text: '半截回答' },
  ];
  applyLastTurnStatsMeta(withAtt, meta);
  assert.deepEqual(withAtt[1].stats, { ms: 4200, tokens: 321 });
  applyInterruptedMeta(withAtt, {
    lastTurnStatus: 'interrupted',
    interruptedTurns: [{ prompt: '现在来做那个 editing', partialText: '半截回答' }],
  });
  assert.equal(withAtt[1].status, 'interrupted');
});

test('hideSessions：批量隐藏去重、保留原 updatedAt、跳过已彻底删除的墓碑', () => {
  const dir = path.join(tmp, 'batch-hide');
  mkdirSync(dir, { recursive: true });
  noteSessionMeta(dir, 's-1', { title: '第一条', updatedAt: '2026-11-10T01:00:00.000Z' });
  markSessionDeleted(dir, 's-del');

  const hidden = hideSessions(dir, ['s-1', 's-2', 's-1', 's-del', '']);
  assert.deepEqual(hidden, ['s-1', 's-2']);
  assert.equal(getSessionMeta(dir, 's-1').hidden, true);
  assert.equal(getSessionMeta(dir, 's-1').updatedAt, '2026-11-10T01:00:00.000Z');
  assert.equal(getSessionMeta(dir, 's-2').hidden, true);
  assert.equal(getSessionMeta(dir, 's-del').deleted, true);
  assert.equal(getSessionMeta(dir, 's-del').hidden, undefined);
});
