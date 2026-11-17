// runClaudeChat 特征测试的场景（基本流程）：每个场景 = 驱动方的一串动作 + 假 CLI 的剧本。
// 驱动方只在假 CLI 停在具名的点上（pause / 等 stdin）时动手，时间线因此是确定的。
// 边角场景在 chat-scenarios-edge.mjs；顺序有讲究（进程里有十分钟一次的缓存、额度状态），新场景往后加。

import path from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import { MODEL, MODEL_1M, FAR, frames, closing, pre, post, CONTROL, chatArgs, BG_SHELL, BG_SHELL_INFO, startBackground, PNG_B64 } from './chat-kit.mjs';

export const scenarios = [];
const scenario = (name, fn) => scenarios.push([name, fn]);

// =============================================================================================
// 一、纯文本
// =============================================================================================
scenario('纯文本一轮：admin 新会话，定局后停放再关', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const tr = h.transcript(ctx, sid);
  const cli = h.script(async function* (io) {
    await io.user();
    tr.append({ type: 'user', uuid: 'tr-user-1', message: { role: 'user', content: '你好' } });
    yield f.init(io);
    yield f.sys('status', { status: 'requesting' });
    yield* f.say('你好，我在。', { think: '用户在打招呼。', thinkingTokens: 12 });
    yield { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: FAR, unifiedWindows: { five_hour: { utilization: 0.12, resetsAt: FAR }, seven_day: { utilization: 0.4, resetsAt: FAR } } } };
    await io.hook('Stop', { effort: { level: 'high' }, background_tasks: [] });
    yield f.result({ result: '你好，我在。' });
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '你好'));
  await h.at(cli, 'user#2');
  h.snapshot('定局后、CLI 停放中');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot('CLI 关掉之后');
});

scenario('附件与交付物：图片原生块、文件夹标注、最终回答里的链接变附件卡', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const png = Buffer.from(PNG_B64, 'base64');
  const img = h.mkfile(ctx.uploads, 'shot.png', png);
  const doc = h.mkfile(ctx.uploads, 'spec.md', '# spec');
  const dir = path.join(ctx.cwd, 'assets');
  mkdirSync(dir, { recursive: true });
  h.mkfile(ctx.cwd, 'out/报告.md', '# 报告');
  h.mkfile(ctx.cwd, 'out/site/index.html', '<h1>hi</h1>');
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* closing(io, f, '做好了：[报告](out/报告.md)、[网站](out/site)，另外引用了 [不存在](out/missing.md)。');
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '看看这些', { attachments: [img, doc, dir] }));
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

// =============================================================================================
// 二、工具
// =============================================================================================
scenario('工具轮：读 / 写 / shell / 图表 / 出错的工具 / 子 agent 与任务帧', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  h.mkfile(ctx.cwd, 'notes/a.md', 'hello');
  const outFile = path.join(ctx.cwd, 'out2', '结果.md');
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    // 读文件
    const readIn = { file_path: path.join(ctx.cwd, 'notes', 'a.md') };
    yield* f.call([{ id: 'toolu_read1', name: 'Read', input: readIn }], { text: '先看一下文件。' });
    await pre(io, f, 'Read', readIn, 'toolu_read1');
    await post(io, f, 'Read', readIn, 'toolu_read1');
    yield f.toolResult('toolu_read1', 'hello');
    await io.pause('mid');
    // 并行：写文件 + 跑命令（命令失败）
    const writeIn = { file_path: outFile, content: '# 结果' };
    const bashIn = { command: 'npm test', description: '跑测试' };
    yield* f.call([{ id: 'toolu_write1', name: 'Write', input: writeIn }, { id: 'toolu_bash1', name: 'Bash', input: bashIn }]);
    await pre(io, f, 'Write', writeIn, 'toolu_write1');
    await pre(io, f, 'Bash', bashIn, 'toolu_bash1');
    mkdirSync(path.dirname(outFile), { recursive: true });
    writeFileSync(outFile, '# 结果');
    await post(io, f, 'Write', writeIn, 'toolu_write1');
    yield f.toolResult('toolu_write1', 'File created successfully');
    await post(io, f, 'Bash', bashIn, 'toolu_bash1', { is_error: true });
    yield f.toolResult('toolu_bash1', 'npm ERR! 1 failing', { is_error: true });
    // 工作空间外的写：PostToolUse 不广播
    const outsideIn = { file_path: path.join(h.dirs.tmp, 'elsewhere.txt'), content: 'x' };
    await post(io, f, 'Write', outsideIn, 'toolu_write_outside');
    // 停进程闸：按进程名停进程被拦
    const killIn = { command: 'taskkill /F /IM node.exe' };
    await pre(io, f, 'Bash', killIn, 'toolu_kill1');
    // 内嵌图表（不露成工具行，走 widget 帧）
    const vizIn = { title: '趋势', loading_messages: ['画图中'], widget_code: '<svg viewBox="0 0 10 10"></svg>' };
    yield* f.call([{ id: 'toolu_viz1', name: 'mcp__visualize__show_widget', input: vizIn }]);
    yield f.toolResult('toolu_viz1', 'rendered');
    // 子 agent：任务帧 + 子 agent 自己的 assistant 帧
    yield* f.call([{ id: 'toolu_agent1', name: 'Agent', input: { description: '查资料', prompt: '去查一下 TODO', subagent_type: 'general-purpose' } }]);
    yield f.sys('task_started', { task_id: 'task-a1', tool_use_id: 'toolu_agent1', task_type: 'local_agent', description: '查资料', subagent_type: 'general-purpose', prompt: '去查一下 TODO' });
    yield { type: 'assistant', session_id: sid, parent_tool_use_id: 'toolu_agent1', uuid: 'sub-asst-1', message: { model: 'claude-haiku-4-5', content: [{ type: 'thinking', thinking: '想一想' }, { type: 'text', text: '子 agent：在翻代码。' }, { type: 'tool_use', id: 'toolu_sub1', name: 'Grep', input: { pattern: 'TODO' } }], usage: { input_tokens: 10, output_tokens: 5 } } };
    yield { type: 'stream_event', session_id: sid, parent_tool_use_id: 'toolu_agent1', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '子 agent 的增量不进主正文' } } };
    yield { type: 'user', session_id: sid, parent_tool_use_id: 'toolu_agent1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_sub1', content: 'none' }] } };
    yield f.sys('task_progress', { task_id: 'task-a1', tool_use_id: 'toolu_agent1', description: '查资料', last_tool_name: 'Grep', summary: '在翻代码', usage: { total_tokens: 1200, tool_uses: 1, duration_ms: 900 } });
    // 子 agent 名下的 shell 任务：不进主时间线
    yield f.sys('task_started', { task_id: 'task-foreign', tool_use_id: 'toolu_sub_shell', task_type: 'local_bash', owned_by_subagent: true, description: 'ls' });
    yield f.sys('task_progress', { task_id: 'task-foreign', description: 'ls' });
    yield f.sys('task_started', { task_id: 'task-unknown-tool', tool_use_id: 'toolu_not_main', task_type: 'local_bash', description: 'pwd' });
    yield f.sys('task_started', { task_id: 'task-ambient', tool_use_id: 'toolu_agent1', task_type: 'local_agent', ambient: true });
    yield f.sys('task_updated', { task_id: 'task-a1', patch: { status: 'running', description: '查资料（第二步）' } });
    yield f.sys('task_notification', { task_id: 'task-a1', tool_use_id: 'toolu_agent1', status: 'completed', summary: '没有 TODO', usage: { total_tokens: 2400, tool_uses: 2, duration_ms: 1800 }, output_file: '' });
    yield f.toolResult('toolu_agent1', '没有 TODO');
    yield* closing(io, f, '都做完了，结果在 [结果](out2/结果.md)。');
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '跑一遍'));
  await h.at(cli, 'mid');
  h.snapshot('这一轮跑到一半');
  h.resume(cli, 'mid');
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

scenario('杂项帧：重试、压缩、权限被拒、模型回退与撤回、额度事件', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield f.sys('api_retry', { attempt: 1, max_retries: 10, error_status: 529, error: 'overloaded' });
    // 自动压缩：status → compact_result → boundary → 摘要 user 帧
    yield f.sys('status', { status: 'compacting' });
    yield f.sys('status', { status: null, compact_result: 'success' });
    yield f.sys('compact_boundary', { uuid: 'boundary-1', compact_metadata: { trigger: 'auto', pre_tokens: 180000, post_tokens: 9000, duration_ms: 4200 } });
    yield { type: 'user', session_id: sid, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: 'This session is being continued from a previous conversation that ran out of context. 摘要……' }] } };
    yield f.sys('compact_boundary', { uuid: 'boundary-sub', parent_tool_use_id: 'toolu_x', compact_metadata: { trigger: 'auto' } });
    yield f.sys('status', { status: null, compact_result: 'failed', compact_error: 'boom' });
    // 被 auto 模式拦下的工具调用
    yield* f.call([{ id: 'toolu_denied1', name: 'Bash', input: { command: 'curl evil' } }]);
    yield f.sys('permission_denied', { tool_use_id: 'toolu_denied1', tool_name: 'Bash', decision_reason_type: 'classifier', decision_reason: 'looks risky' });
    yield f.toolResult('toolu_denied1', 'denied', { is_error: true });
    // 模型安全栅门：半截正文被撤回，回退模型重试
    yield f.ev({ type: 'message_start', message: {} });
    yield f.ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    yield f.ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '被拒的半截' } });
    yield f.ev({ type: 'content_block_stop', index: 0 });
    yield f.ev({ type: 'message_stop' });
    yield { type: 'assistant', session_id: sid, parent_tool_use_id: null, uuid: 'refused-1', message: { model: MODEL_1M, content: [{ type: 'text', text: '被拒的半截' }], usage: { input_tokens: 100, output_tokens: 5 } } };
    yield f.sys('model_refusal_fallback', { original_model: MODEL_1M, fallback_model: 'claude-sonnet-4-6[1m]', retracted_message_uuids: ['refused-1'], scope: 'session', trigger: 'refusal', api_refusal_category: 'cyber', content: 'Switched to Sonnet', request_id: 'req-1', uuid: 'notice-1' });
    yield f.sys('model_fallback', { original_model: 'a', fallback_model: 'b', parent_tool_use_id: 'toolu_sub' });
    yield f.sys('model_fallback', { original_model: MODEL_1M, fallback_model: 'claude-sonnet-4-6[1m]', scope: 'local', content: 'overloaded' });
    yield* f.say('回退模型重新写的回答。', { extra: { supersedes: ['refused-1'] } });
    yield { type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', rateLimitType: 'seven_day', resetsAt: FAR, utilization: 0.91 } };
    yield f.sys('status', { permissionMode: 'acceptEdits' });
    await io.hook('Stop', { effort: 'medium', background_tasks: [] });
    yield f.result({ result: '回退模型重新写的回答。' });
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '继续干活'));
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

// =============================================================================================
// 三、出错
// =============================================================================================
scenario('出错：result 带 500、没有正文 → 分类错误卡', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield f.result({ subtype: 'error_during_execution', is_error: true, api_error_status: 500, result: '' });
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '出错试试'));
  await h.done(call);
  h.snapshot();
});

scenario('出错：读循环抛异常（SDK / CLI 崩了）→ 分类错误卡', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* f.say('写到一半');
    io.crash('fetch failed: socket hang up');
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '崩一下'));
  await h.done(call);
  h.snapshot();
});

scenario('出错：query 还没出 init 就抛（CLI 起不来）', async (h) => {
  const ctx = h.ctx();
  h.script(async function* (io) {
    await io.user();
    io.crash('Native CLI binary for win32-x64 not found');
    yield null;
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '起不来'));
  await h.done(call);
  h.snapshot();
});

scenario('出错：思考块 400 → 清理 transcript 并给提示', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const tr = h.transcript(ctx, sid);
  h.script(async function* (io) {
    await io.user();
    tr.append(
      { type: 'user', uuid: 'tr-u1', parentUuid: null, message: { role: 'user', content: '干活' } },
      { type: 'assistant', uuid: 'tr-a1', parentUuid: 'tr-u1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] } },
      { type: 'assistant', uuid: 'tr-a2', parentUuid: 'tr-a1', message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } },
    );
    yield f.init(io);
    yield f.result({ is_error: true, api_error_status: 400, result: 'API Error: 400 messages.1.content.0: thinking blocks in the latest assistant message cannot be modified.' });
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '干活'));
  await h.done(call);
  h.snapshot();
});

scenario('出错：CLI 没登录（合成的 authentication_failed 帧）', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield { type: 'assistant', session_id: sid, parent_tool_use_id: null, uuid: 'synthetic-1', error: 'authentication_failed', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } };
    yield f.result({ result: 'Not logged in · Please run /login', total_cost_usd: 0 });
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '没登录'));
  await h.done(call);
  h.snapshot();
});

scenario('出错：撞 5 小时限额（合成的 rate_limit 帧）→ 限额卡 + 自动续跑挂上', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const resetsAt = Math.round(Date.now() / 1000) + 3 * 3600;
  h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt } };
    yield { type: 'assistant', session_id: sid, parent_tool_use_id: null, uuid: 'synthetic-2', error: 'rate_limit', apiErrorParams: { rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', resetsAt } }, message: { model: '<synthetic>', content: [{ type: 'text', text: "You've hit your session limit · resets 3pm (Asia/Shanghai)" }] } };
    yield f.result({ result: "You've hit your session limit · resets 3pm (Asia/Shanghai)", is_error: true, api_error_status: 429, total_cost_usd: 0 });
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '撞墙'));
  await h.done(call);
  h.snapshot();
});

// =============================================================================================
// 四、停止
// =============================================================================================
scenario('停止：写到一半按停止（硬停）→ 界面当场收尾，CLI 被打断后退出', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield f.ev({ type: 'message_start', message: {} });
    yield f.ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    yield f.ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '写到一半' } });
    await io.pause('mid');
    await io.interrupted();
    yield f.ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '（停止之后的输出不该再出现）' } });
    yield f.result({ subtype: 'error_during_execution', is_error: true, result: '' });
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '写长文'));
  await h.at(cli, 'mid');
  h.stop(ctx.key, sid);
  await h.idle();
  h.snapshot('按下停止之后、CLI 还没退');
  h.resume(cli, 'mid');
  await h.done(call);
  h.snapshot();
});

scenario('停止：后台任务还活着时按停止 → 只打断作答、转入挂起；再「结束等待」定局', async (h) => {
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
    await io.pause('held');
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '构建并讲解'));
  await h.at(cli, 'mid');
  h.stop(ctx.key, sid);
  h.resume(cli, 'mid');
  await h.at(cli, 'held');
  h.snapshot('挂起中');
  h.stop(ctx.key, sid, { release: true });
  await h.done(call);
  h.snapshot();
});

scenario('停止：同会话重发顶掉还在跑的上一轮 → 上一轮 interrupted，新一轮冷起 resume', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli1 = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield f.ev({ type: 'message_start', message: {} });
    yield f.ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    yield f.ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '第一轮写到一半' } });
    await io.pause('mid');
  }, CONTROL);
  const cli2 = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* closing(io, f, '第二轮的回答。');
    await io.user();
  }, CONTROL);
  const call1 = h.chat(chatArgs(ctx, '第一条'));
  await h.at(cli1, 'mid');
  // 服务端自动发起的轮不顶：回 busy
  const auto = h.chat(chatArgs(ctx, '自动续跑', { sessionId: sid, restartResume: 1, limitResume: true }));
  await h.done(auto);
  const call2 = h.chat(chatArgs(ctx, '第二条', { sessionId: sid }));
  await h.done(call1);
  await h.at(cli2, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call2);
  h.snapshot();
});

// =============================================================================================
// 五、续聊
// =============================================================================================
scenario('续聊（冷起 resume）：清死思考块、幻影 result 不定局、回滚锚点', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const tr = h.transcript(ctx, sid);
  tr.append(
    { type: 'user', uuid: 'tr-u1', parentUuid: null, message: { role: 'user', content: '上一轮的问题' } },
    { type: 'assistant', uuid: 'tr-a1', parentUuid: 'tr-u1', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'sig' }] } },
    { type: 'assistant', uuid: 'tr-a2', parentUuid: 'tr-a1', message: { role: 'assistant', content: [{ type: 'text', text: '上一轮的回答' }] } },
  );
  const cli = h.script(async function* (io) {
    await io.user();
    // 上一条命留下的孤儿后台任务：CLI 先吐一个零轮次的空壳 result
    yield { type: 'result', subtype: 'success', session_id: sid, origin: { kind: 'task-notification' }, num_turns: 0, duration_api_ms: 0, is_error: false, result: '' };
    yield f.init(io);
    tr.append(
      { type: 'user', uuid: 'tr-u2', parentUuid: 'tr-a2', message: { role: 'user', content: [{ type: 'text', text: '继续' }] } },
      { type: 'user', uuid: 'tr-u3', parentUuid: 'tr-u2', message: { role: 'user', content: '<task-notification>不是真人说的</task-notification>' } },
      { type: 'user', uuid: 'tr-u4', parentUuid: 'tr-u3', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y' }] } },
    );
    yield* closing(io, f, '接着上次的做完了。');
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '继续', { sessionId: sid }));
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

scenario('续聊（停放复用）：输入建议、同参数接着用、换参数冷起', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli1 = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* closing(io, f, '第一轮的回答。');
    yield { type: 'prompt_suggestion', suggestion: '再跑一遍测试' };
    const u2 = await io.user();
    yield f.init(io);
    yield* closing(io, f, '第二轮的回答。', { result: { user_message_uuids: [u2.uuid], total_cost_usd: 0.03 } });
    await io.user();
  }, CONTROL);
  const cli2 = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* closing(io, f, '第三轮的回答。');
    await io.user();
  }, CONTROL);
  const call1 = h.chat(chatArgs(ctx, '第一条', { suggest: true }));
  await h.at(cli1, 'user#2');
  h.snapshot('第一轮定局、停放中');
  const call2 = h.chat(chatArgs(ctx, '第二条', { sessionId: sid, suggest: true }));
  await h.done(call2);
  await h.at(cli1, 'user#3');
  h.snapshot('第二轮定局、停放中');
  // 换了推理强度：启动参数对不上，关掉停放的再冷起
  const call3 = h.chat(chatArgs(ctx, '第三条', { sessionId: sid, suggest: true, effort: 'max', chatPrefs: { model: MODEL, effort: 'max', ultracode: false, fast: false } }));
  await h.done(call1);
  await h.at(cli2, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call3);
  h.snapshot();
});

// =============================================================================================
// 六、后台任务悬停
// =============================================================================================
scenario('后台任务悬停：result 时任务还活着 → 挂起；任务完成后 CLI 续轮汇报才定局', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* startBackground(io, f);
    await io.pause('held');
    yield f.bgChanged([{ ...BG_SHELL }, { task_id: 'amb1', task_type: 'local_agent', ambient: true }]);
    yield f.bgChanged([]);
    yield f.sys('task_notification', { task_id: 'bg1', tool_use_id: 'toolu_bg1', status: 'completed', summary: 'Background command "构建" completed (exit code 0)', output_file: '' });
    yield f.init(io);
    yield* closing(io, f, '构建完成，没有报错。', { result: { origin: { kind: 'task-notification' } } });
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '后台构建一下'));
  await h.at(cli, 'held');
  h.snapshot('挂起中');
  h.resume(cli, 'held');
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

scenario('后台任务悬停：挂起中来了新消息 → 接力（换 gen、换模型）；停单个任务；结束等待', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* startBackground(io, f);
    const u2 = await io.user();
    yield f.init(io);
    yield* closing(io, f, '第二条的回答（后台还在跑）。', { bg: [BG_SHELL_INFO], result: { user_message_uuids: [u2.uuid] } });
    await io.pause('held2');
  }, CONTROL);
  const call1 = h.chat(chatArgs(ctx, '后台构建一下'));
  await h.at(cli, 'user#2');
  const call2 = h.chat(chatArgs(ctx, '顺便问个别的', { sessionId: sid, model: 'claude-sonnet-4-6', chatPrefs: { model: 'claude-sonnet-4-6', effort: 'high', ultracode: false, fast: false } }));
  await h.done(call2);
  await h.at(cli, 'held2');
  h.snapshot('接力后的第二轮也挂起');
  await h.stopTask(ctx.key, sid, 'bg1');
  h.stop(ctx.key, sid, { release: true });
  await h.done(call1);
  h.snapshot();
});

scenario('后台任务悬停：挂起中 CLI 自己退了 → 以暂存的 result 定局', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* startBackground(io, f);
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '后台构建一下'));
  await h.done(call);
  h.snapshot();
});

scenario('插话：工作中插一句（priority next）、撤回还没送出的、撤不回已读的', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    const readIn = { file_path: 'README.md' };
    yield* f.call([{ id: 'toolu_r1', name: 'Read', input: readIn }]);
    await io.pause('tool');
    const s = await io.user();
    yield { type: 'command_lifecycle', command_uuid: s.uuid, state: 'queued' };
    await io.pause('queued');
    yield { type: 'command_lifecycle', command_uuid: s.uuid, state: 'started' };
    yield f.toolResult('toolu_r1', '# readme');
    yield* f.say('看完了，也回答了插话。');
    yield { type: 'command_lifecycle', command_uuid: s.uuid, state: 'completed' };
    await io.hook('Stop', { effort: { level: 'high' }, background_tasks: [] });
    yield f.result({ result: '看完了，也回答了插话。', user_message_uuids: [s.uuid] });
    await io.user();
  }, { ...CONTROL, cancelAsyncMessage: () => false });
  const call = h.chat(chatArgs(ctx, '读一下 README'));
  await h.at(cli, 'tool');
  const origin = { kind: 'phone', id: 'p1', model: 'Pixel' };
  const u1 = h.steer(ctx.key, sid, { message: '插话一（会被撤回）', attachments: [], origin });
  await h.unsteer(ctx.key, sid, u1);
  await h.unsteer(ctx.key, sid, u1);
  const u2 = h.steer(ctx.key, sid, { message: '插话二', attachments: [], origin });
  h.resume(cli, 'tool');
  await h.at(cli, 'queued');
  await h.unsteer(ctx.key, sid, u2);
  h.resume(cli, 'queued');
  await h.at(cli, 'user#3');
  h.rec('>>', 'steer-after-done', h.steer(ctx.key, sid, { message: '定局之后插不进', attachments: [] }));
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

scenario('插话没赶上这一轮：这一轮的 result 只是中间态，接着读插话自己开的那一轮', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* f.say('第一条答到一半，');
    await io.pause('late');
    // 插话到的时候这一轮已经在收笔：result 里不带它的 uuid，CLI 随后拿它另开一轮
    await io.hook('Stop', { effort: { level: 'high' }, background_tasks: [] });
    yield f.result({ result: '第一条答完了。', user_message_uuids: ['cli-assigned-first-message'] });
    const s = await io.user();
    yield { type: 'command_lifecycle', command_uuid: s.uuid, state: 'started' };
    yield f.init(io);
    yield* closing(io, f, '这是对插话的回答。', { result: { user_message_uuids: [s.uuid] } });
    yield { type: 'command_lifecycle', command_uuid: s.uuid, state: 'completed' };
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '第一条'));
  await h.at(cli, 'late');
  const uuid = h.steer(ctx.key, sid, { message: '晚到的插话', attachments: [], origin: { kind: 'web', browser: 'Chrome', os: 'Windows' } });
  h.resume(cli, 'late');
  await h.at(cli, 'user#3');
  // 它开的那一轮已经在跑 / 跑完了：撤不回
  await h.unsteer(ctx.key, sid, uuid);
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

// =============================================================================================
// 七、询问
// =============================================================================================
scenario('权限询问：逐次审批卡——允许一次；拒绝不带反馈 → 停下这一轮', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    const bashIn = { command: 'rm -rf build', description: '清理' };
    yield* f.call([{ id: 'toolu_b1', name: 'Bash', input: bashIn }]);
    await io.canUseTool('Bash', bashIn, {
      toolUseID: 'toolu_b1', title: 'Claude wants to run rm -rf build', displayName: 'Bash', decisionReason: 'needs approval',
      suggestions: [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }], behavior: 'allow', destination: 'localSettings' }],
    });
    yield f.toolResult('toolu_b1', 'removed');
    const writeIn = { file_path: path.join(ctx.cwd, 'x.txt'), content: 'x' };
    yield* f.call([{ id: 'toolu_w1', name: 'Write', input: writeIn }]);
    await io.canUseTool('Write', writeIn, { toolUseID: 'toolu_w1' });
    // bridge 自带的 MCP 不弹卡
    await io.canUseTool('mcp__workspace__view', {}, { toolUseID: 'toolu_ws1', mcpServer: { name: 'workspace', source: 'sdk' } });
    yield f.result({ subtype: 'error_during_execution', is_error: true, result: '' });
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '清理一下', { permissionMode: 'default' }));
  await h.answer({ decision: 'once' });
  await h.answer({ decision: 'deny' });
  await h.done(call);
  h.snapshot();
});

scenario('提问与计划：AskUserQuestion 作答 / 取消，ExitPlanMode 批准并切模式', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const questions = [{ question: '用哪个方案？', header: '方案', options: [{ label: 'A', description: '快' }, { label: 'B', description: '稳' }], multiSelect: false }];
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    yield* f.call([{ id: 'toolu_ask1', name: 'AskUserQuestion', input: { questions } }]);
    await io.canUseTool('AskUserQuestion', { questions }, { toolUseID: 'toolu_ask1' });
    yield f.toolResult('toolu_ask1', 'answered');
    await io.canUseTool('AskUserQuestion', { questions }, { toolUseID: 'toolu_ask2' });
    const plan = { plan: '# 计划\n1. 改 a\n2. 改 b', planFilePath: path.join(ctx.cwd, '.claude', 'plans', 'p.md') };
    yield* f.call([{ id: 'toolu_plan1', name: 'ExitPlanMode', input: plan }]);
    await io.canUseTool('ExitPlanMode', plan, { toolUseID: 'toolu_plan1' });
    yield f.sys('status', { permissionMode: 'acceptEdits' });
    yield f.toolResult('toolu_plan1', 'approved');
    yield* closing(io, f, '按计划做完了。');
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '先出个计划', { permissionMode: 'plan' }));
  await h.answer({ answers: [{ selected: ['A'] }] });
  await h.answer({ cancelled: true });
  await h.answer({ decision: 'accept', mode: 'acceptEdits' });
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

scenario('安全栅门暂停卡：换回退模型重试', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const tr = h.transcript(ctx, sid);
  const cli = h.script(async function* (io) {
    await io.user();
    tr.append({ type: 'user', uuid: 'tr-refused', message: { role: 'user', content: '被拦的消息' } });
    yield f.init(io);
    yield f.ev({ type: 'message_start', message: {} });
    yield f.ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    yield f.ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '半截' } });
    yield f.ev({ type: 'content_block_stop', index: 0 });
    yield f.ev({ type: 'message_stop' });
    yield { type: 'assistant', session_id: sid, parent_tool_use_id: null, uuid: 'refused-9', message: { model: MODEL_1M, content: [{ type: 'text', text: '半截' }], usage: { input_tokens: 100, output_tokens: 2 } } };
    await io.dialog({ dialogKind: 'refusal_fallback_prompt', payload: { originalModel: MODEL_1M, fallbackModel: 'claude-sonnet-4-6[1m]', apiRefusalCategory: 'cyber', retractedMessageUuids: ['refused-9'] } });
    await io.dialog({ dialogKind: 'something_else', payload: {} });
    yield* closing(io, f, '换了模型之后的回答。');
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '被拦的消息'));
  await h.answer({ answers: [], choice: 'retry_fallback' });
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

// =============================================================================================
// 八、别的身份
// =============================================================================================
scenario('沙箱成员（有命令行）：启动参数、围栏钩子、按人记账', async (h) => {
  const ctx = h.ctx({ kind: 'user', user: 'u-pro', name: 'alice', tier: 'pro' });
  mkdirSync(ctx.cwd, { recursive: true });
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    await pre(io, f, 'Read', { file_path: path.join(ctx.cwd, 'mine.txt') }, 'toolu_in');
    await pre(io, f, 'Read', { file_path: path.join(h.dirs.data, 'config.json') }, 'toolu_out');
    await pre(io, f, 'Bash', { command: 'cat ../other/secret.txt' }, 'toolu_dotdot');
    await io.canUseTool('Write', { file_path: path.join(h.dirs.data, 'x.txt'), content: 'x' }, { toolUseID: 'toolu_w_out' });
    yield* closing(io, f, '在自己的文件夹里做完了。', { result: { total_cost_usd: 0.5 } });
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '干活', { fast: true, ultracode: true }));
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

scenario('沙箱成员（没有命令行）：shell 工具拿掉、钩子拒 shell', async (h) => {
  const ctx = h.ctx({ kind: 'user', user: 'u-reg', name: 'bob', tier: 'user' });
  mkdirSync(ctx.cwd, { recursive: true });
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    await pre(io, f, 'Bash', { command: 'ls' }, 'toolu_sh');
    await pre(io, f, 'Write', { file_path: path.join(ctx.cwd, '.git', 'config'), content: 'x' }, 'toolu_git');
    await io.canUseTool('Bash', { command: 'ls' }, { toolUseID: 'toolu_sh2' });
    yield* closing(io, f, '没有命令行，只改了文件。');
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '跑个命令'));
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

scenario('聊天快照访客：专属提示词与工具面，定局后不停放', async (h) => {
  const dir = path.join(h.dirs.data, 'chat-snapshots', 'snap-1');
  mkdirSync(dir, { recursive: true });
  const ctx = h.ctx({ kind: 'snap', token: 'snap-token-1', dir });
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    await pre(io, f, 'Read', { file_path: path.join(h.dirs.data, 'config.json') }, 'toolu_out');
    await io.canUseTool('Write', { file_path: path.join(dir, 'a.md'), content: 'x' }, { toolUseID: 'toolu_w' });
    yield* closing(io, f, '访客你好。');
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '你好', { origin: null, limitReplay: null, chatPrefs: null, globalMax: 3 }));
  await h.done(call);
  h.snapshot();
});

// =============================================================================================
// 九、启动参数的各种形态
// =============================================================================================
scenario('启动参数：深度研究 + Ultracode + fast + 手机 App 发起 + 项目目录', async (h) => {
  const base = h.ctx();
  const proj = path.join(base.cwd, 'proj-a');
  mkdirSync(proj, { recursive: true });
  const ctx = { ...base, cwd: proj, homeRoot: base.cwd, projectId: 'p-1', worktree: { cwd: proj, branch: 'claude/x', name: 'x', root: base.cwd } };
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io, { fast_mode_state: 'on' });
    yield* f.say('研究完了。');
    await io.hook('Stop', { effort: { level: 'xhigh' }, background_tasks: [] });
    yield f.result({ result: '研究完了。' });
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '研究一下这个', {
    research: true, ultracode: true, fast: true, effort: 'xhigh', fromPhone: true, narrow: true, originDevice: 'dev-1', source: 'capsule',
    compactFrac: 0.5, chatPrefs: { model: MODEL, effort: 'xhigh', ultracode: true, fast: true, outputStyle: 'Explanatory' },
    origin: { kind: 'phone', id: 'dev-1', model: 'Pixel' },
  }));
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

scenario('启动参数：项目对话（协调者）', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const cli = h.script(async function* (io) {
    await io.user();
    yield f.init(io);
    await pre(io, f, 'Bash', { command: 'git status' }, 'toolu_git1');
    await pre(io, f, 'Bash', { command: 'npm install' }, 'toolu_npm1');
    yield* closing(io, f, '我来派活。');
    await io.user();
  }, CONTROL);
  const call = h.chat(chatArgs(ctx, '做个大项目', { shape: 'project', chatPrefs: { model: MODEL, effort: 'high', ultracode: false, fast: false, shape: 'project' } }));
  await h.at(cli, 'user#2');
  await h.releaseWarm(ctx.key, sid);
  await h.done(call);
  h.snapshot();
});

// =============================================================================================
// 十、预热与早退
// =============================================================================================
scenario('新会话预热：预热进程停在第一轮之前，真消息来了接管；同参数再预热只续期', async (h) => {
  const ctx = h.ctx();
  const sid = h.sid();
  const f = frames(sid, { cwd: ctx.cwd });
  const prewarmArgs = () => {
    const a = chatArgs(ctx, '', { prewarm: true });
    delete a.origin; delete a.limitReplay; delete a.limitResume; delete a.restartResume; delete a.globalMax; delete a.family;
    return a;
  };
  const cli = h.script(async function* (io) {
    yield f.init(io);
    await io.user();
    yield* closing(io, f, '新会话的第一条回答。');
    await io.user();
  }, CONTROL);
  const warm = h.chat(prewarmArgs());
  await h.at(cli, 'user#1');
  h.rec('>>', 'spareStatus', h.spareStatus(ctx.key));
  const again = h.chat(prewarmArgs());
  await h.done(again);
  const call = h.chat(chatArgs(ctx, '新会话第一条'));
  await h.done(call);
  await h.at(cli, 'user#2');
  h.rec('>>', 'spareStatus', h.spareStatus(ctx.key));
  await h.releaseWarm(ctx.key, sid);
  await h.done(warm);
  h.snapshot();
});

scenario('新会话预热：换了参数的预热换掉旧进程；没人接的被 releaseWarmOf 关掉', async (h) => {
  const ctx = h.ctx();
  const prewarmArgs = (extra) => {
    const a = chatArgs(ctx, '', { prewarm: true, ...extra });
    delete a.origin; delete a.limitReplay; delete a.limitResume; delete a.restartResume; delete a.globalMax; delete a.family;
    return a;
  };
  const idle = async function* (io) { await io.user(); };
  const cli1 = h.script(idle, CONTROL);
  const cli2 = h.script(idle, CONTROL);
  const w1 = h.chat(prewarmArgs());
  await h.at(cli1, 'user#1');
  const w2 = h.chat(prewarmArgs({ effort: 'low' }));
  await h.done(w1);
  await h.at(cli2, 'user#1');
  await h.releaseWarmOf(ctx.key);
  await h.done(w2);
  // 带会话 id 的预热、沙箱身份的预热：直接返回，不起进程
  const no1 = h.chat({ ...prewarmArgs(), sessionId: h.sid('X') });
  await h.done(no1);
  const member = h.ctx({ kind: 'user', user: 'u-pro', name: 'alice', tier: 'pro' });
  const no2 = h.chat({ ...prewarmArgs(), ctx: member });
  await h.done(no2);
  h.snapshot();
});

scenario('早退：自定义模型不存在 → 错误帧，不起 CLI', async (h) => {
  const ctx = h.ctx();
  const call = h.chat(chatArgs(ctx, '用自定义模型', { model: 'custom:p-0a1b2c:nope-1' }));
  await h.done(call);
  const snapDir = path.join(h.dirs.data, 'chat-snapshots', 'snap-2');
  mkdirSync(snapDir, { recursive: true });
  const snap = h.ctx({ kind: 'snap', token: 'snap-token-2', dir: snapDir });
  const call2 = h.chat(chatArgs(snap, '访客用自定义模型', { model: 'custom:p-0a1b2c:nope-1', origin: null, limitReplay: null, chatPrefs: null }));
  await h.done(call2);
  h.snapshot();
});
