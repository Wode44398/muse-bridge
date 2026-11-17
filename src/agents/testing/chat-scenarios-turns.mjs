// runClaudeChat 特征测试的场景（一个 CLI 进程先后承载好几轮）：停放复用、挂起接力时，上一轮留下的逐轮状态
// ——被拒的额度事件、等摘要的压缩边界、没收尾的工具块、撤回记账、Stop 钩子回报的档位、是不是 /compact、
// 暂存的 result、后台 shell 的封顶计时——都不许带进下一轮。
//
// 写法：上一轮末尾故意留一身「脏」状态（dirty），下一轮开头做一组只有脏状态还在才会有反应的动作（probe）。
// 基准里这些动作都没有反应；哪一项归零漏了，对应的反应就会冒出来。

import { MODEL_1M, FAR, frames, closing, CONTROL, chatArgs, BG_SHELL, BG_SHELL_INFO, startBackground } from './chat-kit.mjs';

export const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

// 留在一轮末尾的脏状态：被拒的额度事件、后面没跟摘要帧的压缩边界、只开了头的工具块。
// 工具块放在 index 7：这一轮后面的正文块都在 index 0，不会顺手把它收掉。
const dirty = function* (f, n) {
  yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: FAR } };
  yield f.sys('compact_boundary', { uuid: 'boundary-dirty-' + n, compact_metadata: { trigger: 'auto', pre_tokens: 5000, post_tokens: 500 } });
  yield f.ev({ type: 'message_start', message: {} });
  yield f.ev({ type: 'content_block_start', index: 7, content_block: { type: 'tool_use', id: 'toolu_stale_' + n, name: 'Read', input: {} } });
  yield f.ev({ type: 'content_block_delta', index: 7, delta: { type: 'input_json_delta', partial_json: '{"file_path":"sta' } });
  yield f.ev({ type: 'message_stop' });
};
// 探针：像摘要的 user 帧（上一轮的边界若还在等，会被当成它的摘要）；接着上一轮那个工具块往下写并收尾
//（工具块若还在，会冒出它的 tool_args）；一截被拒的正文 + 撤回（撤回区间要从这一轮的 0 算起）。
const probe = function* (f, n) {
  yield { type: 'user', session_id: f.sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation. 这句不是哪个边界的摘要。' }] } };
  yield f.ev({ type: 'content_block_delta', index: 7, delta: { type: 'input_json_delta', partial_json: 'le.md"}' } });
  yield f.ev({ type: 'content_block_stop', index: 7 });
  yield f.ev({ type: 'message_start', message: {} });
  yield f.ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  yield f.ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截' } });
  yield f.ev({ type: 'content_block_stop', index: 0 });
  yield f.ev({ type: 'message_stop' });
  yield { type: 'assistant', session_id: f.sid, parent_tool_use_id: null, uuid: 'refused-probe-' + n, message: { model: MODEL_1M, content: [{ type: 'text', text: '半截' }], usage: { input_tokens: 50, output_tokens: 2 } } };
  yield f.sys('model_refusal_fallback', { original_model: MODEL_1M, fallback_model: 'claude-sonnet-4-6[1m]', retracted_message_uuids: ['refused-probe-' + n], scope: 'session', content: 'switched' });
};
// 零轮次的空壳 result：这一轮是 /compact 且真压缩过才算结局，否则是幻影、要扣住
const hollow = (f, extra = {}) => f.result({ result: '', num_turns: 0, duration_api_ms: 0, total_cost_usd: 0, ...extra });
const orphan = { origin: { kind: 'task-notification' } };
const ultra = (ctx, text, extra = {}) => chatArgs(ctx, text, { ultracode: true, chatPrefs: { model: 'claude-opus-4-8', effort: 'high', ultracode: true, fast: false }, ...extra });

scenario('逐轮状态不串轮（停放复用）：四轮同一个进程，/compact 与普通轮交替', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    // 第一轮：/compact，末尾留一身脏状态；Stop 钩子回报档位 max
    await io.user();
    yield f.init(io);
    yield* f.say('压缩前说了一句。');
    yield f.sys('status', { status: 'compacting' });
    yield* dirty(f, 1);
    await io.hook('Stop', { effort: { level: 'max' }, background_tasks: [] });
    yield hollow(f);
    // 第二轮：又是 /compact。先来一个孤儿通知的空壳 result——这一轮还没压缩过，要扣住。
    // 这一轮不跑 Stop 钩子：上一轮回报的档位要是还留着，定局时会照它报出来。
    const u2 = await io.user();
    yield hollow(f, orphan);
    yield f.init(io);
    yield* probe(f, 2);
    yield f.sys('status', { status: 'compacting' });
    yield* dirty(f, 2);
    yield hollow(f, { user_message_uuids: [u2.uuid] });
    // 第三轮：普通消息。这一轮自己压缩过一次，随后的空壳 result 仍是幻影（这条不是 /compact）。
    const u3 = await io.user();
    yield f.init(io);
    yield* probe(f, 3);
    yield f.sys('compact_boundary', { uuid: 'boundary-auto-3', compact_metadata: { trigger: 'auto', pre_tokens: 9000, post_tokens: 900 } });
    yield { type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: '<local-command-stdout>ok</local-command-stdout>' } };
    yield hollow(f, orphan);
    yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: FAR } };
    yield* f.say('第三轮的回答。');
    yield f.result({ result: '第三轮的回答。', user_message_uuids: [u3.uuid] });
    // 第四轮：一个与额度无关的错——上一轮被拒的额度事件要是还留着，会被错报成限额卡
    const u4 = await io.user();
    yield f.init(io);
    yield f.result({ subtype: 'error_during_execution', is_error: true, api_error_status: 500, result: '', user_message_uuids: [u4.uuid] });
  }, CONTROL);
  const call1 = h.chat(ultra(ctx, '/compact', { sessionId: sid }));
  await h.at(cli, 'user#2');
  const call2 = h.chat(ultra(ctx, '/compact 再压一次', { sessionId: sid }));
  await h.done(call2);
  await h.at(cli, 'user#3');
  const call3 = h.chat(ultra(ctx, '普通的一条', { sessionId: sid }));
  await h.done(call3);
  await h.at(cli, 'user#4');
  const call4 = h.chat(ultra(ctx, '再来一条', { sessionId: sid }));
  await h.done(call4);
  await h.done(call1);
  h.snapshot();
});

scenario('逐轮状态不串轮（挂起接力）：接力来的 /compact、再接力一条普通消息到定局', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    // 第一轮：起后台 shell，停笔前留一身脏状态（排在最后一个 tool_result 之后）；Stop 钩子回报档位 max
    await io.user();
    yield f.init(io);
    const input = { command: 'npm run build', run_in_background: true, description: '构建' };
    yield* f.call([{ id: 'toolu_bg1', name: 'Bash', input }]);
    yield f.sys('task_started', { task_id: 'bg1', tool_use_id: 'toolu_bg1', task_type: 'local_bash', description: '构建', is_backgrounded: true });
    yield f.bgChanged([BG_SHELL]);
    yield f.toolResult('toolu_bg1', 'Command running in background with ID: bg1');
    yield* f.say('已在后台开始构建。');
    yield* dirty(f, 1);
    await io.hook('Stop', { effort: { level: 'max' }, background_tasks: [BG_SHELL_INFO] });
    yield f.result({ result: '已在后台开始构建。' });
    // 第二轮（接力）：/compact。先来的空壳 result 要扣住（这一轮还没压缩过）；之后真压缩、空壳 result 定这一轮，
    // 后台任务还在 → 又挂起。
    const u2 = await io.user();
    yield hollow(f, orphan);
    yield f.init(io);
    yield* probe(f, 2);
    yield f.sys('status', { status: 'compacting' });
    yield f.sys('compact_boundary', { uuid: 'boundary-manual-2', compact_metadata: { trigger: 'manual', pre_tokens: 7000, post_tokens: 700 } });
    yield hollow(f, { user_message_uuids: [u2.uuid] });
    // 第三轮（再接力）：普通消息，后台任务已经做完 → 正常定局。全程没再跑 Stop 钩子：第一轮回报的档位不该还在。
    const u3 = await io.user();
    yield f.bgChanged([]);
    yield f.init(io);
    yield* probe(f, 3);
    yield* f.say('第三轮的回答。');
    yield f.result({ result: '第三轮的回答。', user_message_uuids: [u3.uuid] });
    await io.user();
  }, CONTROL);
  const call1 = h.chat(ultra(ctx, '后台构建一下'));
  await h.at(cli, 'user#2');
  const call2 = h.chat(ultra(ctx, '/compact', { sessionId: sid }));
  await h.done(call2);
  await h.at(cli, 'user#3');
  const call3 = h.chat(ultra(ctx, '接力来的第三条', { sessionId: sid }));
  await h.done(call3);
  await h.at(cli, 'user#4');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call1);
  h.snapshot();
});

scenario('逐轮状态不串轮（挂起接力）：被拒的额度事件、暂存的中间 result', async (h) => {
  const ctx = h.ctx();
  // A：上一轮收到过被拒的额度事件，接力来的这一轮出了个与额度无关的错
  const a = h.sid('A');
  const fa = frames(a, { cwd: ctx.cwd });
  const cliA = h.script(async function* (io) {
    await io.user();
    yield fa.init(io);
    yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus', resetsAt: FAR } };
    yield* startBackground(io, fa);
    const u2 = await io.user();
    yield fa.init(io);
    yield fa.result({ subtype: 'error_during_execution', is_error: true, api_error_status: 500, result: '', user_message_uuids: [u2.uuid] });
  }, CONTROL);
  const callA = h.chat(chatArgs(ctx, '后台构建一下'));
  await h.at(cliA, 'user#2');
  const callA2 = h.chat(chatArgs(ctx, '接力来的一条', { sessionId: a }));
  await h.done(callA2);
  await h.done(callA);
  // B：上一轮暂存过一个中间 result（CLI 队列里还有用户消息时的那种）；接力来的这一轮 CLI 中途自己退了——
  // 不许拿那个旧的中间 result 当这一轮的结局
  const b = h.sid('B');
  const fb = frames(b, { cwd: ctx.cwd });
  const cliB = h.script(async function* (io) {
    await io.user();
    yield fb.init(io);
    yield* fb.say('先答一半。');
    yield fb.result({ result: '先答一半。', queued_turn_count: 1 });
    yield* startBackground(io, fb);
    await io.user();
    yield fb.init(io);
    yield fb.ev({ type: 'message_start', message: {} });
    yield fb.ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    yield fb.ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '写到一半 CLI 退了' } });
  }, CONTROL);
  const callB = h.chat(chatArgs(ctx, '后台构建一下'));
  await h.at(cliB, 'user#2');
  const callB2 = h.chat(chatArgs(ctx, '接力来的一条', { sessionId: b }));
  await h.done(callB2);
  await h.done(callB);
  h.snapshot();
});

scenario('逐轮状态不串轮（停放复用）：上一轮挂起过、暂存过中间 result，下一轮不认旧的', async (h) => {
  const ctx = h.ctx();
  // A：下一轮跑到一半点「结束等待」——这一轮并没在挂起，不许拿上一轮暂存的 result 定局
  const a = h.sid('A');
  const fa = frames(a, { cwd: ctx.cwd });
  const cliA = h.script(async function* (io) {
    await io.user();
    yield fa.init(io);
    yield* startBackground(io, fa);
    yield fa.bgChanged([]);
    yield fa.init(io);
    yield* closing(io, fa, '构建完成。', { result: orphan });
    const u2 = await io.user();
    // CLI 先消化了一条别的通知才轮到这条消息：这个 result 只是中间轮，不是这一轮的结局
    yield fa.result({ ...orphan, result: '（通知轮）' });
    yield fa.init(io);
    yield* fa.call([{ id: 'toolu_r2', name: 'Read', input: { file_path: 'a.md' } }]);
    await io.pause('mid');
    await io.interrupted();
    yield fa.result({ subtype: 'error_during_execution', is_error: true, result: '', user_message_uuids: [u2.uuid] });
  }, CONTROL);
  const callA = h.chat(chatArgs(ctx, '后台构建一下'));
  await h.at(cliA, 'user#2');
  const callA2 = h.chat(chatArgs(ctx, '接着干别的', { sessionId: a }));
  await h.done(callA2);
  await h.at(cliA, 'mid');
  h.stop(ctx.key, a, { release: true });
  h.resume(cliA, 'mid');
  await h.done(callA);
  // B：上一轮暂存过中间 result；下一轮 CLI 中途自己退了，不许拿它当结局
  const b = h.sid('B');
  const fb = frames(b, { cwd: ctx.cwd });
  const cliB = h.script(async function* (io) {
    await io.user();
    yield fb.init(io);
    yield* fb.say('先答一半。');
    yield fb.result({ result: '先答一半。', queued_turn_count: 1 });
    yield* closing(io, fb, '答完了。');
    await io.user();
    yield fb.init(io);
    yield fb.ev({ type: 'message_start', message: {} });
    yield fb.ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    yield fb.ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '写到一半 CLI 退了' } });
  }, CONTROL);
  const callB = h.chat(chatArgs(ctx, '第一条'));
  await h.at(cliB, 'user#2');
  const callB2 = h.chat(chatArgs(ctx, '第二条', { sessionId: b }));
  await h.done(callB2);
  await h.done(callB);
  h.snapshot();
});

scenario('逐轮状态不串轮（停放复用）：后台 shell 的封顶计时与被掐名单', async (h) => {
  const ctx = h.ctx();
  const clock = h.clock();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const AGENT = { task_id: 'ag1', task_type: 'local_agent', description: '调研' };
  const cli = h.script(async function* (io) {
    // 第一轮：shell 和子 agent 都在后台，挂起一小时多——shell 到点被掐（进了被掐名单），子 agent 做完后续轮定局
    await io.user();
    yield f.init(io);
    yield f.bgChanged([BG_SHELL, AGENT]);
    yield* closing(io, f, '后台在跑，我先停笔。', { bg: [BG_SHELL_INFO] });
    await io.pause('held');
    yield f.sys('status', { status: 'requesting' });   // 子 agent 还有动静：别让静默判死先到
    await io.pause('alive');
    yield f.bgChanged([]);
    yield f.init(io);
    yield* closing(io, f, '后台的都做完了。', { result: orphan });
    // 第二轮：同一个 id 的后台 shell 又起了一个——它没被掐过，封顶也从这一轮看见它时算起
    const u2 = await io.user();
    yield f.init(io);
    yield f.bgChanged([BG_SHELL]);
    yield* closing(io, f, '又起了一个后台构建。', { bg: [BG_SHELL_INFO], result: { user_message_uuids: [u2.uuid] } });
    await io.pause('held2');
  }, CONTROL);
  const call1 = h.chat(chatArgs(ctx, '后台构建并调研'));
  await h.at(cli, 'held');
  await clock.advance(59 * 60_000);
  h.resume(cli, 'held');
  await h.at(cli, 'alive');
  await clock.advance(2 * 60_000);
  h.resume(cli, 'alive');
  await h.at(cli, 'user#2');
  const call2 = h.chat(chatArgs(ctx, '再构建一次', { sessionId: sid }));
  await h.done(call2);
  await h.at(cli, 'held2');
  await clock.advance(45 * 60_000);
  h.snapshot('第二轮挂起 45 分钟：还没到封顶');
  // 再过一刻钟多：从这一轮看见它算起满一小时，看门狗把这一轮收掉（接管时看门狗要重新挂上）
  await clock.advance(16 * 60_000);
  await h.done(call1);
  h.snapshot();
});
