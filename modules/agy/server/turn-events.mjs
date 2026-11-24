// Antigravity 一轮的插件事件：turn.start / turn.end（plugins/events.mjs），字段对齐 Claude 的 pluginTap（src/agents/claude/emit.mjs）。
// 一次 runAgyChat = 一轮：开跑前发 turn.start，收尾发 turn.end，各只发一次（end 有幂等守卫，收尾各分支和 finally 兜底都调也不会重发）。
// 同一轮里的中途插话、后台子代理回报续接（background.mjs 的 onIdle）都还在这一轮里，不另算；
// 排队消息接着跑、后台唤醒（internalWake）是新的一次 runAgyChat，各算一轮（唤醒的 source = 'wake'）。agy 自己的子代理不经这里，不发。
import { emitBridgeEvent, ownerOf, clip } from '@bridge/core/plugins/events.mjs';

export function agyTurnEvents(ctx, gen, { model = '', message = '', isNew = false, wake = false } = {}) {
  let t0 = 0;
  let started = false;
  let ended = false;
  let curModel = String(model || '');
  const tools = new Set();
  const base = () => ({ agent: 'agy', kind: 'chat', owner: ownerOf(ctx), sessionId: gen?.sessionId || null, cwd: gen?.cwd || '' });
  return {
    start() {
      if (started) return;
      started = true;
      t0 = Date.now();
      emitBridgeEvent('turn.start', {
        ...base(), isNew: !!isNew, model: curModel, effort: '', source: wake ? 'wake' : '',
        message: clip(String(message || ''), 4000),
      });
    },
    // 挂载后才知道实际模型 / 这一轮用到的工具
    note({ model: m, tool } = {}) {
      if (m) curModel = String(m);
      if (tool) tools.add(String(tool));
    },
    end({ ok = false, stopped = false, error = '', result = '' } = {}) {
      if (!started || ended) return;
      ended = true;
      emitBridgeEvent('turn.end', {
        ...base(), model: curModel, ok: !!ok, stopped: !!stopped,
        ...(error ? { error: clip(String(error), 1000) } : {}),
        result: ok ? clip(String(result || ''), 8000) : '',
        costUsd: 0, durationMs: Date.now() - t0, tools: [...tools],
      });
    },
  };
}
