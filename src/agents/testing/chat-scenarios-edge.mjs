// runClaudeChat 特征测试的场景（边角）：接力 / 停放复用 / 停止 / 并发上限 / 额度 / 服务端发起的轮 / 自定义 API / 号池换号。
// 写法同 chat-scenarios.mjs；排在它后面跑。最后一个场景会改激活账号，新场景加在它前面。

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { MODEL_1M, FAR, frames, closing, post, CONTROL, chatArgs, BG_SHELL, BG_SHELL_INFO, startBackground, PNG_B64 } from './chat-kit.mjs';
import { setPendingRewind } from '../claude-rewind.mjs';
import { createProvider, deleteProvider } from '../../runtime/claude-providers.mjs';
import { addAccount, deleteAccount, setActive, activeAccountId, listAccounts } from '../../runtime/claude-account.mjs';
import { setRouterSettings } from '../../runtime/account-router.mjs';

export const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

// =============================================================================================
// 十一、工具与帧的补充
// =============================================================================================
scenario('工具补充：结果里带图、PushNotification 转推、动态工作流的进度帧', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* f.call([{ id: 'toolu_shot1', name: 'Read', input: { file_path: 'shot.png' } }]);
    yield f.toolResult('toolu_shot1', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } }, { type: 'text', text: '一张图' }]);
    const pushIn = { message: '构建好了，可以来看' };
    yield* f.call([{ id: 'toolu_push1', name: 'PushNotification', input: pushIn }]);
    await post(io, f, 'PushNotification', pushIn, 'toolu_push1', 'Mobile push not sent');
    yield f.toolResult('toolu_push1', 'Mobile push not sent');
    yield* f.call([{ id: 'toolu_wf1', name: 'Workflow', input: { script: 'export const meta = { name: "audit" };\nexport default async function () {}' } }]);
    yield f.sys('task_started', { task_id: 'task-wf1', tool_use_id: 'toolu_wf1', task_type: 'local_workflow', workflow_name: 'audit', description: 'audit', prompt: 'x'.repeat(400), spawn_depth: 1 });
    yield f.sys('task_progress', { task_id: 'task-wf1', tool_use_id: 'toolu_wf1', description: 'audit', usage: { total_tokens: 10 }, workflow_progress: [{ type: 'workflow_agent', agentId: 'ag1', model: 'auto:hard', status: 'running' }, { type: 'workflow_phase', name: 'scan' }] });
    yield f.sys('task_notification', { task_id: 'task-wf1', tool_use_id: 'toolu_wf1', status: 'failed', summary: 'Dynamic workflow "audit" failed', output_file: path.join(h.dirs.tmp, 'not-a-task-dir', 'x.output') });
    yield f.toolResult('toolu_wf1', 'failed', { is_error: true });
    yield* closing(io, f, '看过了。');
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '看图并通知我'));
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

scenario('手动 /compact：零轮次的空壳 result 就是这一轮的结局', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.sys('status', { status: 'compacting' });
    yield f.init(io);
    yield f.sys('status', { status: null, compact_result: 'success' });
    yield f.sys('compact_boundary', { uuid: 'boundary-manual', compact_metadata: { trigger: 'manual', pre_tokens: 90000, post_tokens: 4000 } });
    yield { type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' } };
    yield f.result({ result: '', num_turns: 0, duration_api_ms: 0, total_cost_usd: 0 });
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '/compact 只留结论', { sessionId: sid }));
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

scenario('出错：读循环抛的就是思考块 400 → 清理并给提示', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    io.crash('API Error: 400 thinking blocks in the latest assistant message cannot be modified');
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '再干活'));
  await h.done(call);
  h.snapshot();
});

// =============================================================================================
// 十二、挂起接力的边角
// =============================================================================================
scenario('挂起接力（续）：先切权限模式、中间轮 result 不定局、不回 uuid 的 result、后台子 agent 的审批卡搬到新一轮', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* startBackground(io, f);
    // 挂起期间后台子 agent 要批一条命令：卡挂着，CLI 照常读 stdin
    const card = io.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'toolu_sub_push', agentID: 'agent-7', title: 'Agent wants to run git push', displayName: 'Bash' });
    card.catch(() => {});
    await io.user();
    // CLI 先消化了一条后台任务通知（中间轮），再答接力来的那条——这条 result 不带 user_message_uuids
    yield f.result({ origin: { kind: 'task-notification' }, result: '（通知轮）' });
    yield f.init(io);
    yield* closing(io, f, '第二条的回答。', { bg: [BG_SHELL_INFO] });
    await io.wait('card', card);
    await io.pause('held2');
  }, CONTROL);
  const call1 = h.chat(chatArgs(ctx, '后台构建一下'));
  await h.at(cli, 'user#2');
  h.setSessionMode(ctx, sid, 'default');
  const call2 = h.chat(chatArgs(ctx, '第二条', { sessionId: sid }));
  await h.done(call2);
  await h.at(cli, 'card');
  h.snapshot('审批卡搬到了新一轮');
  await h.answer({ decision: 'once' });
  await h.at(cli, 'held2');
  h.stop(ctx.key, sid, { release: true });
  await h.done(call1);
  h.snapshot();
});

scenario('挂起接力不接：发起方式不同（管理台代聊 vs 本人）、切不到更严的权限模式', async (h) => {
  const ctx = h.ctx();
  // A：管理台代聊（宿主放行）的轮在挂起，本人发的消息不插进去
  const a = h.sid('A');
  const fa = frames(a, { cwd: ctx.cwd });
  const cliA = h.script(async function* (io) {
    await io.user();
    yield fa.init(io);
    await io.canUseTool('Bash', { command: 'ls' }, { toolUseID: 'toolu_host1' });
    await io.canUseTool('ExitPlanMode', { plan: 'p' }, { toolUseID: 'toolu_host2' });
    await io.canUseTool('Write', { file_path: 'x', content: 'y' }, { toolUseID: 'toolu_host3', decisionReasonType: 'mode' });
    yield* startBackground(io, fa);
    await io.pause('held');
  }, CONTROL);
  const callA = h.chat(chatArgs(ctx, '代聊：后台构建', { permissionPolicy: 'host' }));
  await h.at(cliA, 'held');
  const mine = h.chat(chatArgs(ctx, '本人插一句', { sessionId: a }));
  await h.done(mine);
  h.stop(ctx.key, a, { release: true });
  await h.done(callA);
  // B：会话记的模式比进程眼下的更严，接力时切不过去 → 不接
  const b = h.sid('B');
  const fb = frames(b, { cwd: ctx.cwd });
  const cliB = h.script(async function* (io) {
    await io.user();
    yield fb.init(io);
    yield* startBackground(io, fb);
    await io.pause('held');
  }, { ...CONTROL, setPermissionMode: () => { throw new Error('mode switch refused'); } });
  const callB = h.chat(chatArgs(ctx, '后台构建'));
  await h.at(cliB, 'held');
  h.setSessionMode(ctx, b, 'plan');
  const strict = h.chat(chatArgs(ctx, '先出计划再说', { sessionId: b }));
  await h.done(strict);
  h.stop(ctx.key, b, { release: true });
  await h.done(callB);
  h.snapshot();
});

// =============================================================================================
// 十三、停放复用的边角
// =============================================================================================
scenario('停放复用的边角：定局后补切模式、接管时先切模式、transcript 被别人动过、待生效的回滚锚点、CLI 自己开轮', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const tr = h.transcript(ctx, sid);
  const cli1 = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    await io.pause('mid');
    yield* closing(io, f, '第一轮。');
    const u2 = await io.user();
    yield f.init(io, { permissionMode: 'default' });
    yield* closing(io, f, '第二轮。', { result: { user_message_uuids: [u2.uuid] } });
    await io.user();
  }, CONTROL);
  const cli2 = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* closing(io, f, '第三轮。');
    await io.user();
  }, CONTROL);
  h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* closing(io, f, '第四轮。');
    // 停放期间 CLI 自己开了一轮（没人在看）：不替它挂着
    yield { type: 'assistant', session_id: sid, parent_tool_use_id: null, uuid: 'self-1', message: { model: MODEL_1M, content: [{ type: 'text', text: '定时唤醒' }] } };
    await io.user();
  }, CONTROL);
  const call1 = h.chat(chatArgs(ctx, '第一条'));
  await h.at(cli1, 'mid');
  // 干活时在芯片上改了模式：这一轮定局、停放前补切过去
  h.setSessionMode(ctx, sid, 'acceptEdits');
  h.resume(cli1, 'mid');
  await h.at(cli1, 'user#2');
  // 下一条消息要的模式与停放的进程眼下的不同：先切再推
  h.setSessionMode(ctx, sid, 'default');
  const call2 = h.chat(chatArgs(ctx, '第二条', { sessionId: sid }));
  await h.done(call2);
  await h.at(cli1, 'user#3');
  // 别的写入者动了 transcript：停放的进程不能接着用
  tr.append({ type: 'user', uuid: 'tr-other', message: { role: 'user', content: '桌面端接着聊了一句' } }, { type: 'assistant', uuid: 'tr-other-a', parentUuid: 'tr-other', message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } });
  const call3 = h.chat(chatArgs(ctx, '第三条', { sessionId: sid }));
  await h.done(call1);
  await h.at(cli2, 'user#2');
  // 有待生效的回滚锚点：同样冷起，从锚点续
  setPendingRewind(sid, 'tr-other-a');
  h.rec('>>', 'setPendingRewind', 'tr-other-a');
  const call4 = h.chat(chatArgs(ctx, '第四条', { sessionId: sid }));
  await h.done(call3);
  await h.done(call4);
  h.snapshot();
});

scenario('停放复用：接管时切不到更严的模式 → 这条不发，报错并关掉进程', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* closing(io, f, '第一轮。');
    await io.user();
  }, { ...CONTROL, setPermissionMode: () => { throw new Error('mode switch refused'); } });
  const call1 = h.chat(chatArgs(ctx, '第一条'));
  await h.at(cli, 'user#2');
  h.setSessionMode(ctx, sid, 'plan');
  const call2 = h.chat(chatArgs(ctx, '先出计划', { sessionId: sid }));
  await h.done(call2);
  await h.done(call1);
  h.snapshot();
});

scenario('停放上限：全服停放的 CLI 超过上限，挤掉停得最久的', async (h) => {
  const ctx = h.ctx();
  const labels = ['A', 'B', 'C', 'D', 'E'];
  const calls = [];
  for (const label of labels) {
    const sid = h.sid(label);
    const f = frames(sid, { cwd: ctx.cwd });
    const cli = h.script(async function* (io) {
      await io.user();
      yield f.init(io);
      yield* closing(io, f, '好。');
      await io.user();
    }, CONTROL);
    const call = h.chat(chatArgs(ctx, '会话 ' + label));
    await h.at(cli, 'user#2');
    calls.push(call);
  }
  await h.done(calls[0]);
  await h.releaseWarmOf(ctx.key);
  for (const call of calls.slice(1)) await h.done(call);
  h.snapshot();
});

// =============================================================================================
// 十四、停止的边角
// =============================================================================================
scenario('停止：挂起中按停止（不是结束等待）→ 连后台任务一起停', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* startBackground(io, f);
    await io.pause('held');
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '后台构建一下'));
  await h.at(cli, 'held');
  h.stop(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

scenario('停止：硬停后 CLI 还在退，同会话的新消息等它退干净再冷起', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli1 = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* f.call([{ id: 'toolu_slow1', name: 'Bash', input: { command: 'sleep 60' } }]);
    await io.pause('mid');
    await io.interrupted();
    yield f.result({ subtype: 'error_during_execution', is_error: true, result: '' });
  }, CONTROL);
  const cli2 = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* closing(io, f, '重新来过。');
    await io.user();
  }, CONTROL);
  const call1 = h.chat(chatArgs(ctx, '跑个慢命令'));
  await h.at(cli1, 'mid');
  h.stop(ctx.key, sid);
  const call2 = h.chat(chatArgs(ctx, '算了，换个做法', { sessionId: sid }));
  await h.idle();
  h.snapshot('旧 CLI 还没退，新消息在等');
  h.resume(cli1, 'mid');
  await h.done(call1);
  await h.at(cli2, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call2);
  h.snapshot();
});

scenario('提问挂着时同会话重发：卡作废（cancelled），上一轮被顶掉', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const questions = [{ question: '继续吗？', header: '确认', options: [{ label: '是' }, { label: '否' }], multiSelect: false }];
  const cli1 = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* f.call([{ id: 'toolu_ask9', name: 'AskUserQuestion', input: { questions } }]);
    await io.wait('ask', io.canUseTool('AskUserQuestion', { questions }, { toolUseID: 'toolu_ask9' }));
  }, CONTROL);
  const cli2 = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* f.call([{ id: 'toolu_b9', name: 'Bash', input: { command: 'make' } }]);
    await io.wait('card', io.canUseTool('Bash', { command: 'make' }, { toolUseID: 'toolu_b9' }));
  }, CONTROL);
  const cli3 = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* closing(io, f, '好的。');
    await io.user();
  }, CONTROL);
  const call1 = h.chat(chatArgs(ctx, '问我一下', { permissionMode: 'default' }));
  await h.at(cli1, 'ask');
  h.snapshot('提问卡在等');
  const call2 = h.chat(chatArgs(ctx, '不用问了，直接做', { sessionId: sid }));
  await h.done(call1);
  await h.at(cli2, 'card');
  const call3 = h.chat(chatArgs(ctx, '也不用批了', { sessionId: sid }));
  await h.done(call2);
  await h.at(cli3, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call3);
  h.snapshot();
});

scenario('悬停看门狗：任务表清零却没等来续轮、子 agent 全静音、后台 shell 到点（单掐 / 整轮收）、等审批时不判死', async (h) => {
  const ctx = h.ctx();
  const clock = h.clock();
  const AGENT = { task_id: 'ag1', task_type: 'local_agent', description: '调研' };
  const held = (f, tasks, after) => async function* (io) {
    await io.user();
    yield f.init(io);
    yield f.bgChanged(tasks);
    yield* closing(io, f, '后台在跑，我先停笔。', { bg: [BG_SHELL_INFO] });
    if (after) yield* after(io);
    await io.pause('held');
  };
  const run = async (label, tasks, after) => {
    const sid = h.sid(label);
    const cli = h.script(held(frames(sid, { cwd: ctx.cwd }), tasks, after), CONTROL);
    const call = h.chat(chatArgs(ctx, '悬停 ' + label));
    await h.at(cli, 'held');
    return { sid, cli, call };
  };
  // ① 任务表清零了，CLI 却没续轮：静默 2 分钟后定局
  const f1 = frames(h.sid('drained'), { cwd: ctx.cwd });
  const r1 = await run('drained', [BG_SHELL], function* () { yield f1.bgChanged([]); });
  await clock.advance(60_000);
  await clock.advance(90_000);
  await h.done(r1.call);
  // ② 悬停的全是子 agent，15 分钟一条消息都没有：判死
  const r2 = await run('silence', [AGENT]);
  await clock.advance(14 * 60_000);
  await clock.advance(2 * 60_000);
  await h.done(r2.call);
  // ③ 只有后台 shell：到点整轮收
  const r3 = await run('timeout', [BG_SHELL]);
  await clock.advance(59 * 60_000);
  await clock.advance(2 * 60_000);
  await h.done(r3.call);
  // ④ shell 和子 agent 都在：到点只掐 shell，这一轮接着挂；之后子 agent 静音才收
  const r4 = await run('cap', [BG_SHELL, AGENT]);
  await clock.advance(61 * 60_000);
  await h.done(r4.call);
  // ⑤ 有审批卡在等人（后台子 agent 要批）：不按静默判死；作答之后从作答那一刻重新计时
  const f5 = frames(h.sid('card'), { cwd: ctx.cwd });
  const cli5 = h.script(async function* (io) {
    await io.user();
    yield f5.init(io);
    yield f5.bgChanged([AGENT]);
    yield* closing(io, f5, '后台在跑，我先停笔。');
    await io.wait('card', io.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'toolu_sub_card', agentID: 'agent-9', title: 'Agent wants to run git push' }));
    await io.pause('after');
  }, CONTROL);
  const call5 = h.chat(chatArgs(ctx, '悬停 card'));
  await h.at(cli5, 'card');
  await clock.advance(20 * 60_000);
  await h.answer({ decision: 'once' });
  await h.at(cli5, 'after');
  await clock.advance(14 * 60_000);
  await clock.advance(2 * 60_000);
  await h.done(call5);
  h.snapshot();
});

// =============================================================================================
// 十五、并发上限与额度
// =============================================================================================
scenario('并发上限：成员每人同时在跑的轮数、全服注册用户合计、快照通道、同一会话抢着开', async (h) => {
  const hold = (f) => async function* (io) {
    await io.user();
    yield f.init(io);
    await io.pause('mid');
    await io.interrupted();
    yield f.result({ subtype: 'error_during_execution', is_error: true, result: '' });
  };
  const start = async (ctx, label, extra = {}) => {
    const sid = h.sid(label);
    const cli = h.script(hold(frames(sid, { cwd: ctx.cwd })), CONTROL);
    const call = h.chat(chatArgs(ctx, '占位 ' + label, extra));
    await h.at(cli, 'mid');
    return { ctx, sid, cli, call };
  };
  const end = async (r) => { h.stop(r.ctx.key, r.sid); h.resume(r.cli, 'mid'); await h.done(r.call); };
  // 成员每人最多 2 轮
  const alice = h.ctx({ kind: 'user', user: 'u-pro', name: 'alice', tier: 'pro' });
  const a1 = await start(alice, 'a1');
  const a2 = await start(alice, 'a2');
  const a3 = h.chat(chatArgs(alice, '第三个并行对话'));
  await h.done(a3);
  // 全服注册用户合计 3 轮
  const bob = h.ctx({ kind: 'user', user: 'u-reg', name: 'bob', tier: 'user' });
  mkdirSync(bob.cwd, { recursive: true });
  const b1 = await start(bob, 'b1');
  const carol = h.ctx({ kind: 'user', user: 'u-carol', name: 'carol', tier: 'pro' });
  mkdirSync(carol.cwd, { recursive: true });
  const c1 = h.chat(chatArgs(carol, '全服已满'));
  await h.done(c1);
  await end(a1); await end(a2); await end(b1);
  // 快照通道
  const dir1 = path.join(h.dirs.data, 'chat-snapshots', 'snap-busy-1');
  const dir2 = path.join(h.dirs.data, 'chat-snapshots', 'snap-busy-2');
  mkdirSync(dir1, { recursive: true }); mkdirSync(dir2, { recursive: true });
  const s1ctx = h.ctx({ kind: 'snap', token: 'snap-busy-1', dir: dir1 });
  const s2ctx = h.ctx({ kind: 'snap', token: 'snap-busy-2', dir: dir2 });
  const snapArgs = { origin: null, limitReplay: null, chatPrefs: null, globalMax: 1 };
  const s1 = await start(s1ctx, 's1', snapArgs);
  const s2 = h.chat(chatArgs(s2ctx, '通道已满', snapArgs));
  await h.done(s2);
  await end(s1);
  // 派生的子会话 id 事先定好：两条都要开同一个 id，后到的回「会话正在启动」
  const admin = h.ctx();
  const child = h.sid('child');
  const family = () => ({ origin: { kind: 'spawn', from: [h.sid('parent')] }, newSessionId: child, nudge: '\n\n[子会话] 你是被派出来干活的。' });
  const k1cli = h.script(hold(frames(child, { cwd: admin.cwd })), CONTROL);
  const k1 = h.chat(chatArgs(admin, '子会话的任务', { family: family() }));
  await h.at(k1cli, 'mid');
  const k2 = h.chat(chatArgs(admin, '重复派发', { family: family() }));
  await h.done(k2);
  h.stop(admin.key, child); h.resume(k1cli, 'mid'); await h.done(k1);
  h.snapshot();
});

scenario('额度：成员今天的轮数用完 → 不开跑', async (h) => {
  const ctx = h.ctx({ kind: 'user', user: 'u-quota', name: 'dave', tier: 'pro' });
  mkdirSync(ctx.cwd, { recursive: true });
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  h.policy({ quota: { dayTurns: 1 } });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* closing(io, f, '第一轮照常。', { result: { total_cost_usd: 0.2 } });
    await io.user();
  }, CONTROL);
  const call1 = h.chat(chatArgs(ctx, '第一条'));
  await h.at(cli, 'user#2');
  const call2 = h.chat(chatArgs(ctx, '第二条', { sessionId: sid }));
  await h.done(call2);
  await h.releaseWarm(ctx.key, sid);
  await h.done(call1);
  h.policy({ preset: 'recommended', maxUserTurns: 3 });
  h.snapshot();
});

// =============================================================================================
// 十六、服务端替别人发起的轮
// =============================================================================================
scenario('服务端发起的轮：定时任务（无人在场）、限额重置后的自动续跑', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const family = {
    origin: { kind: 'routine', from: [] }, nudge: '\n\n[定时任务] 这一轮没有人在场。',
    onStart: (gen) => h.rec('>>', 'family.onStart', { sessionId: gen.sessionId, autoTurn: gen.autoTurn }),
    onEnd: (gen) => h.rec('>>', 'family.onEnd', { sessionId: gen.sessionId, last: gen.events.length ? gen.events[gen.events.length - 1].type : null }),
  };
  const resetsAt = Math.round(Date.now() / 1000) + 2 * 3600;
  h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    await io.canUseTool('Bash', { command: 'ls' }, { toolUseID: 'toolu_routine1' });
    // 撞墙：这一轮以限额卡收尾
    yield { type: 'assistant', session_id: sid, parent_tool_use_id: null, uuid: 'synthetic-9', error: 'rate_limit', apiErrorParams: { rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt } }, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit" }] } };
    yield f.result({ result: "You've hit your session limit", is_error: true, api_error_status: 429 });
  }, CONTROL);
  const cli2 = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* closing(io, f, '接着做完了。');
    await io.user();
  }, CONTROL);
  const call1 = h.chat(chatArgs(ctx, '每日巡检', { family, origin: { kind: 'routine' }, permissionMode: 'default' }));
  await h.answer({ decision: 'once' });
  await h.done(call1);
  h.snapshot('撞墙之后');
  // 到点服务端自己发「接着做」
  const call2 = h.chat(chatArgs(ctx, '刚才撞到了用量限额，现在已经重置。请从中断的地方继续。', { sessionId: sid, limitResume: true }));
  await h.at(cli2, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call2);
  h.snapshot();
});

// =============================================================================================
// 十七、自定义 API 的模型
// =============================================================================================
scenario('自定义 API：启动参数走本机代理、身份提示、出错卡片', async (h) => {
  const ctx = h.ctx();
  const provider = createProvider({
    name: '假服务', baseUrl: 'https://api.example.invalid', apiKey: 'sk-not-a-real-key',
    models: [{ id: 'big-1', label: 'Big One', contextWindow: 262144, maxOutput: 16000 }],
  });
  const model = `custom:${provider.id}:big-1`;
  const ok = h.sid('ok');
  const bad = h.sid('bad');
  const fok = frames(ok, { cwd: ctx.cwd, model: 'big-1' });
  const fbad = frames(bad, { cwd: ctx.cwd, model: 'big-1' });
  const cli1 = h.script(async function* (io) {
    await io.user();
    yield fok.init(io, { model: 'big-1' });
    yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt: FAR } };
    yield* closing(io, fok, '我是第三方模型。', { result: { total_cost_usd: 9.99, modelUsage: { 'big-1': { contextWindow: 262144 } } } });
    await io.user();
  }, CONTROL);
  h.script(async function* (io) {
    await io.user();
    yield fbad.init(io, { model: 'big-1' });
    yield fbad.result({ is_error: true, api_error_status: 401, result: 'API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"模型服务「假服务」的 API Key 不对"}}' });
  }, CONTROL);
  const args = (text) => chatArgs(ctx, text, { model, effort: 'high', fast: true, ultracode: true, chatPrefs: { model, effort: 'high', ultracode: true, fast: true } });
  const call1 = h.chat(args('你是谁'));
  await h.at(cli1, 'user#2');
  await h.releaseWarm(ctx.key, ok);
  await h.done(call1);
  const call2 = h.chat(args('再来'));
  await h.done(call2);
  deleteProvider(provider.id);
  h.snapshot();
});

// =============================================================================================
// 十八、号池智能路由（放最后：会改激活账号）
// =============================================================================================
scenario('号池换号：开跑前激活号已用尽 → 先换号；撞墙 → 换号并让前端原样重发', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const tr = h.transcript(ctx, sid);
  const first = activeAccountId();
  const b = addAccount({ label: '备用号 B', token: 'tok-b-not-real' });
  const c = addAccount({ label: '备用号 C', token: 'tok-c-not-real' });
  // 默认账号没有令牌时，加号会顺手把新号设成激活号——切回去，让「开跑前换号」有戏可唱
  setActive(first);
  setRouterSettings({ enabled: true, strategy: 'fill' });   // 这一场测的是「用满再换」（新装默认是智能分派）
  tr.append(
    { type: 'user', uuid: 'tr-u1', parentUuid: null, message: { role: 'user', content: '早先的问题' } },
    { type: 'assistant', uuid: 'tr-a1', parentUuid: 'tr-u1', message: { role: 'assistant', content: [{ type: 'text', text: '早先的回答' }] } },
  );
  const resetsAt = Math.round(Date.now() / 1000) + 3600;
  h.script(async function* (io) {
    await io.user();
    tr.append({ type: 'user', uuid: 'tr-u2', parentUuid: 'tr-a1', message: { role: 'user', content: '撞墙的这条' } });
    yield f.init(io);
    yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt } };
    yield f.result({ result: '', is_error: true, api_error_status: 429, total_cost_usd: 0 });
  }, CONTROL);
  const cli2 = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* closing(io, f, '换了号之后答上了。');
    await io.user();
  }, CONTROL);
  // 默认账号在前面的场景里已经被记了 5 小时额度用尽：这一轮开跑前就换号
  const call1 = h.chat(chatArgs(ctx, '撞墙的这条', { sessionId: sid }));
  await h.done(call1);
  h.snapshot('撞墙换号之后');
  // 前端收到 autoRetry:'resend' 原样重发
  const call2 = h.chat(chatArgs(ctx, '撞墙的这条', { sessionId: sid }));
  await h.at(cli2, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call2);
  h.rec('>>', 'accounts', listAccounts().map((a) => ({ label: a.label, active: a.active })));
  setRouterSettings({ enabled: false });
  setActive(first);
  deleteAccount(b.id); deleteAccount(c.id);
  h.snapshot();
});

// 插话「立即打断」= 停止 + 紧跟着发出那条：软停的 result 还没回时新消息就到了——
// 要等这一轮转入挂起再接力进同一个 CLI，不能见上一轮没收尾就 abort（会连后台任务一起杀掉）。
scenario('停止：后台任务在跑时按停止、紧跟着发来下一条 → 等转入挂起再接力，后台任务不被杀', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    const input = { command: 'npm run build', run_in_background: true };
    yield* f.call([{ id: 'toolu_bg1', name: 'Bash', input }]);
    yield f.sys('task_started', { task_id: 'bg1', tool_use_id: 'toolu_bg1', task_type: 'local_bash', description: '构建', is_backgrounded: true });
    yield f.bgChanged([BG_SHELL]);
    yield f.toolResult('toolu_bg1', 'Command running in background with ID: bg1');
    yield f.ev({ type: 'message_start', message: {} });
    yield f.ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    yield f.ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '我接着说' } });
    await io.pause('mid');
    await io.interrupted();
    yield f.result({ subtype: 'error_during_execution', is_error: true, result: '' });
    const u2 = await io.user();
    yield f.init(io);
    yield* closing(io, f, '先回答新的这条（后台还在跑）。', { bg: [BG_SHELL_INFO], result: { user_message_uuids: [u2.uuid] } });
    await io.pause('held2');
  }, CONTROL);
  const call1 = h.chat(chatArgs(ctx, '构建并讲解'));
  await h.at(cli, 'mid');
  h.stop(ctx.key, sid);
  const call2 = h.chat(chatArgs(ctx, '别讲了，先回答这个', { sessionId: sid }));
  await h.idle();
  h.snapshot('软停的 result 还没回、新消息在等');
  h.resume(cli, 'mid');
  await h.done(call2);
  await h.at(cli, 'held2');
  h.snapshot('接力后的这一轮挂起，后台任务还在');
  h.stop(ctx.key, sid, { release: true });
  await h.done(call1);
  h.snapshot();
});
