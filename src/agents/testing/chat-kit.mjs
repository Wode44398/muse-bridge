// runClaudeChat 特征测试剧本的零件：SDK 消息的小工厂、一轮的常见收尾、控制通道的回话、请求参数。
// 剧本里的 SDK 消息形状照 claude.mjs 读循环认的字段写（不求与真 SDK 一字不差，只求每个分支都走到）。

export const MODEL = 'claude-opus-4-8';
export const MODEL_1M = MODEL + '[1m]';
export const FAR = 4102444800;   // 2100-01-01（秒）：额度重置时刻用固定的远期值，不随运行时刻变

// ---- SDK 消息的小工厂 ------------------------------------------------------------------------
export function frames(sid, { cwd, model = MODEL_1M } = {}) {
  let seq = 0;
  const base = { session_id: sid, parent_tool_use_id: null };
  const uuid = (p) => `${p}-${String(++seq).padStart(3, '0')}`;
  const ev = (event) => ({ type: 'stream_event', ...base, event });
  const sys = (subtype, extra = {}) => ({ type: 'system', subtype, session_id: sid, ...extra });
  const USAGE = { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 30000, cache_creation_input_tokens: 500 };
  const f = {
    sid, sys, ev,
    /** init 帧：模型与权限模式照 CLI 的做法回显启动参数。 */
    init: (io, extra = {}) => sys('init', {
      ...base, model: io.options.model || model, cwd, permissionMode: io.options.permissionMode || 'default', fast_mode_state: 'off',
      mcp_servers: [{ name: 'bridge', status: 'connected' }, { name: 'sessions', status: 'connected' }, { name: 'browser', status: 'failed' }],
      terminal_slash_commands: ['doctor', 'color'],
      ...extra,
    }),
    /** 一条只有正文（可带思考）的 API 消息：流式增量 + 完整 assistant 帧。 */
    *say(text, { think = '', usage = USAGE, thinkingTokens = 0, extra = {} } = {}) {
      yield ev({ type: 'message_start', message: { model } });
      let index = 0;
      const content = [];
      if (think) {
        yield ev({ type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
        yield ev({ type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: think } });
        yield ev({ type: 'content_block_stop', index });
        content.push({ type: 'thinking', thinking: think, signature: 'sig' });
        index++;
      }
      yield ev({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
      const half = Math.ceil(text.length / 2);
      yield ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: text.slice(0, half) } });
      if (text.length > half) yield ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: text.slice(half) } });
      yield ev({ type: 'content_block_stop', index });
      content.push({ type: 'text', text });
      yield ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: usage.output_tokens, output_tokens_details: { thinking_tokens: thinkingTokens } } });
      yield ev({ type: 'message_stop' });
      yield { type: 'assistant', ...base, uuid: uuid('asst'), message: { model, content, usage }, ...extra };
    },
    /** 一条发起工具调用的 API 消息。tools：[{ id, name, input }]，可带一段前置正文。 */
    *call(tools, { text = '', usage = { input_tokens: 1500, output_tokens: 60, cache_read_input_tokens: 31000, cache_creation_input_tokens: 0 } } = {}) {
      yield ev({ type: 'message_start', message: { model } });
      let index = 0;
      const content = [];
      if (text) {
        yield ev({ type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        yield ev({ type: 'content_block_delta', index, delta: { type: 'text_delta', text } });
        yield ev({ type: 'content_block_stop', index });
        content.push({ type: 'text', text });
        index++;
      }
      for (const t of tools) {
        const json = JSON.stringify(t.input || {});
        const cut = Math.ceil(json.length / 2);
        yield ev({ type: 'content_block_start', index, content_block: { type: 'tool_use', id: t.id, name: t.name, input: {} } });
        yield ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(0, cut) } });
        yield ev({ type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: json.slice(cut) } });
        yield ev({ type: 'content_block_stop', index });
        content.push({ type: 'tool_use', id: t.id, name: t.name, input: t.input || {} });
        index++;
      }
      yield ev({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: usage.output_tokens } });
      yield ev({ type: 'message_stop' });
      yield { type: 'assistant', ...base, uuid: uuid('asst'), message: { model, content, usage } };
    },
    /** 主线程的 tool_result（user 帧）。 */
    toolResult: (id, content = 'ok', extra = {}) => ({
      type: 'user', ...base, uuid: uuid('user'),
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] },
    }),
    result: (extra = {}) => ({
      type: 'result', subtype: 'success', session_id: sid, is_error: false, result: '', num_turns: 1, duration_ms: 1500, duration_api_ms: 1200,
      total_cost_usd: 0.0125, usage: USAGE,
      modelUsage: { [model]: { inputTokens: 1200, outputTokens: 40, contextWindow: 1_000_000 } },
      ...extra,
    }),
    bgChanged: (tasks) => sys('background_tasks_changed', { tasks }),
  };
  return f;
}

// 正文 + Stop 钩子 + result：一轮最常见的收尾
export async function* closing(io, f, text, { bg = [], result = {}, say = {} } = {}) {
  yield* f.say(text, say);
  await io.hook('Stop', { effort: { level: 'high' }, background_tasks: bg });
  yield f.result({ result: text, ...result });
}
// 一次工具调用前后 CLI 会跑的钩子
export const pre = (io, f, name, input, id) => io.hook('PreToolUse', { tool_name: name, tool_input: input, tool_use_id: id, session_id: f.sid });
export const post = (io, f, name, input, id, response = {}) => io.hook('PostToolUse', { tool_name: name, tool_input: input, tool_response: response, tool_use_id: id, session_id: f.sid });

// 控制通道的回话
const CONTEXT_USAGE = {
  model: MODEL_1M, maxTokens: 1_000_000, totalTokens: 31_740, isAutoCompactEnabled: true, autoCompactThreshold: 900_000,
  categories: [
    { name: 'System prompt', tokens: 9000, color: 'promptBorder' },
    { name: 'Messages', tokens: 22_740, color: 'purple' },
    { name: 'Free space', tokens: 968_260, color: 'promptBorder' },
  ],
  mcpTools: [{ name: 'mcp__bridge__manual', serverName: 'bridge', tokens: 300 }],
  memoryFiles: [], agents: [],
};
export const CONTROL = {
  getContextUsage: () => CONTEXT_USAGE,
  supportedCommands: () => [{ name: 'compact', description: 'Compact the conversation', argumentHint: '' }, { name: 'doctor', description: 'Diagnose', argumentHint: '' }],
  initializationResult: () => ({ available_output_styles: ['default', 'Explanatory'] }),
  getSettings: () => ({ applied: { ultracode: true } }),
};

// 请求体里随每条消息带来的东西（routes/chat.mjs 组出来的那些）
export const chatArgs = (ctx, message, extra = {}) => ({
  message, sessionId: undefined, model: MODEL, effort: 'high', ultracode: false, fast: false,
  chatPrefs: { model: MODEL, effort: 'high', ultracode: false, fast: false },
  attachments: [], research: false, suggest: false, compactFrac: undefined, source: undefined,
  fromPhone: false, narrow: false, originDevice: undefined, fromComputer: undefined, autoRetry: true,
  origin: { kind: 'web', browser: 'Chrome', os: 'Windows' },
  // note：在跑台账只留请求体里正文以外的部分，靠它认出台账里记的是哪一条请求
  limitReplay: { headers: { 'user-agent': 'char-test' }, url: '/api/chat', body: { message, model: MODEL, effort: 'high', note: message } },
  limitResume: false, restartResume: 0, globalMax: undefined, ctx, family: null, permissionMode: undefined, shape: undefined,
  ...extra,
});

export const BG_SHELL = { task_id: 'bg1', task_type: 'local_bash', description: '构建' };
export const BG_SHELL_INFO = { id: 'bg1', type: 'shell', status: 'running', description: '构建', command: 'npm run build' };
// 起一个后台 shell 并停笔：result 出来时后台任务还活着 → 这一轮挂起
export async function* startBackground(io, f, text = '已在后台开始构建。') {
  const input = { command: 'npm run build', run_in_background: true, description: '构建' };
  yield* f.call([{ id: 'toolu_bg1', name: 'Bash', input }]);
  await pre(io, f, 'Bash', input, 'toolu_bg1');
  yield f.sys('task_started', { task_id: 'bg1', tool_use_id: 'toolu_bg1', task_type: 'local_bash', description: '构建', is_backgrounded: true });
  yield f.bgChanged([BG_SHELL]);
  yield f.toolResult('toolu_bg1', 'Command running in background with ID: bg1');
  yield* closing(io, f, text, { bg: [BG_SHELL_INFO] });
}

// 1x1 的 PNG（附件、工具结果里的图片）
export const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
