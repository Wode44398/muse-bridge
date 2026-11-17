// runClaudeChat 特征测试的场景（插件系统启动的形态）。布置见 chat-plugins-setup.mjs。

import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { frames, closing, pre, post, CONTROL, chatArgs } from './chat-kit.mjs';
import { pluginEvents } from './chat-plugins-setup.mjs';

export const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

// 探针插件收到的事件晚一个事件循环才到：等齐了再记
const flushEvents = async (h) => { await h.idle(8); h.rec('plugin-events', pluginEvents.splice(0)); };

scenario('插件系统启动：内置工具按开关给；插件的工具 / 提示 / MCP / 钩子 / 每轮参数 / 消息改写 / 审批策略 / 事件', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    const danger = { command: 'echo danger' };
    yield* f.call([{ id: 'toolu_p1', name: 'Bash', input: danger }]);
    await pre(io, f, 'Bash', danger, 'toolu_p1');
    yield f.toolResult('toolu_p1', 'denied by hook', { is_error: true });
    await io.canUseTool('Bash', { command: 'ls' }, { toolUseID: 'toolu_p2' });
    await io.canUseTool('Bash', { command: 'rm -rf /' }, { toolUseID: 'toolu_p3' });
    await io.canUseTool('Bash', { command: 'make' }, { toolUseID: 'toolu_p4' });
    const writeIn = { file_path: path.join(ctx.cwd, 'p.txt'), content: 'x' };
    yield* f.call([{ id: 'toolu_p5', name: 'Write', input: writeIn }]);
    await post(io, f, 'Write', writeIn, 'toolu_p5');
    yield f.toolResult('toolu_p5', 'ok');
    yield* closing(io, f, '插件都生效了。');
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '/probe 换模型 试试', { permissionMode: 'default' }));
  await h.answer({ decision: 'once' });
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  await flushEvents(h);
  h.snapshot();
});

scenario('插件给了不认识的模型和档位：记一行、忽略；出错的轮也发 turn.end', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield f.result({ subtype: 'error_during_execution', is_error: true, api_error_status: 500, result: '' });
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '坏模型'));
  await h.done(call);
  await flushEvents(h);
  h.snapshot();
});

scenario('插件系统启动：成员只拿到点名给成员的贡献；被停止的轮发 turn.end（stopped）', async (h) => {
  const ctx = h.ctx({ kind: 'user', user: 'u-plug', name: 'erin', tier: 'pro' });
  mkdirSync(ctx.cwd, { recursive: true });
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    await io.pause('mid');
    await io.interrupted();
    yield f.result({ subtype: 'error_during_execution', is_error: true, result: '' });
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '成员的一轮'));
  await h.at(cli, 'mid');
  h.stop(ctx.key, sid);
  h.resume(cli, 'mid');
  await h.done(call);
  await flushEvents(h);
  h.snapshot();
});

scenario('插件系统启动：快照访客不过插件的每轮参数 / 消息改写 / 审批策略', async (h) => {
  const dir = path.join(h.dirs.data, 'chat-snapshots', 'snap-plug');
  mkdirSync(dir, { recursive: true });
  const ctx = h.ctx({ kind: 'snap', token: 'snap-plug-1', dir });
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    await io.canUseTool('Bash', { command: 'ls' }, { toolUseID: 'toolu_s1' });
    yield* closing(io, f, '访客你好。');
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '/probe 访客', { origin: null, limitReplay: null, chatPrefs: null, globalMax: 3 }));
  await h.done(call);
  await flushEvents(h);
  h.snapshot();
});
