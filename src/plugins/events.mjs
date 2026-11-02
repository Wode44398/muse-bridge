// 插件订阅 bridge 自己的事件（插件接口四期，2026-11-01）：ctx.events.on(名字 | '*', fn)。
//
// 核心在固定位置调 emitBridgeEvent(名字, payload)，这里转给订阅了的插件。事件是「事后通知」：
//   · fire-and-forget：不等插件、插件抛错 / 超时只记插件日志，绝不拖慢或打断发事件的那条主链路；
//   · payload 一律能 JSON 化，长文本已截断，插件拿到的是副本（改了不影响核心）；
//   · 插件系统没启动（单测、脚本）时什么都不做。
// 事件表见 EVENT_NAMES（手册 plugins 章「订阅 bridge 事件」同一份）。
import { kernel } from './state.mjs';

export const EVENTS_SLOT = 'bridge.events';
export const EVENT_NAMES = Object.freeze([
  'turn.start', 'turn.end', 'tool.end',
  'routine.run', 'device.online', 'device.offline', 'user.login', 'plugin.state', 'model.request',
]);
const NAME_RE = /^(\*|[a-z]+(\.[a-z]+)+)$/;

export const clip = (s, n) => {
  const t = typeof s === 'string' ? s : s == null ? '' : String(s);
  return t.length > n ? t.slice(0, n) + `…（共 ${t.length} 字）` : t;
};

/** 身份上下文 → 给插件看的 owner：{ kind: 'admin' | 'user' | 'sandbox' | 'snap', login?, sandbox? }。 */
export function ownerOf(ctx) {
  if (!ctx) return null;
  // 插件沙箱（ctx.sandbox）的身份是 kind:'snap'，令牌 plugin-<插件>-<沙箱名>
  const tok = String(ctx.snap?.token || '');
  if (tok.startsWith('plugin-')) return { kind: 'sandbox', token: tok };
  if (ctx.snap || ctx.kind === 'snap' || ctx.kind === 'share') return { kind: 'snap' };
  if (ctx.kind === 'admin') return { kind: 'admin', login: 'host' };
  return { kind: ctx.kind || 'user', login: ctx.name || String(ctx.user || ''), id: String(ctx.user || '') };
}

// 订阅登记（ctx.events.on 调）：返回撤销函数
export function subscribe(ctx, name, fn) {
  if (!NAME_RE.test(String(name || ''))) throw new Error(`事件名「${name}」不对（可用：${EVENT_NAMES.join(' / ')}，或 '*' 全收）`);
  if (typeof fn !== 'function') throw new Error('ctx.events.on 要一个函数 (payload, name) => …');
  if (name !== '*' && !EVENT_NAMES.includes(name)) ctx.warn(`订阅了没有的事件「${name}」（现有：${EVENT_NAMES.join(' / ')}）`);
  return ctx.contribute(EVENTS_SLOT, { name, fn });
}

const snapshot = (v) => { try { return JSON.parse(JSON.stringify(v)); } catch { return {}; } };

/** 核心调：发一个事件。立刻返回，订阅者在下一个 tick 异步收到。 */
export function emitBridgeEvent(name, payload = {}) {
  if (!kernel.started) return;
  let entries;
  try { entries = kernel.slot(EVENTS_SLOT).entries(); } catch { return; }
  if (!entries.length) return;
  const hits = entries.filter(({ item }) => item.name === '*' || item.name === name);
  if (!hits.length) return;
  const body = { ...snapshot(payload), event: name, at: Date.now() };
  setImmediate(() => {
    for (const { item, owner } of hits) {
      let r;
      try { r = item.fn(snapshot(body), name); }
      catch (e) { logFor(owner, `事件 ${name} 的处理出错：`, e); continue; }
      if (r && typeof r.then === 'function') r.catch((e) => logFor(owner, `事件 ${name} 的处理出错：`, e));
    }
  });
}

function logFor(owner, msg, e) {
  const c = kernel.contextOf(owner);
  const text = String(e?.message || e).slice(0, 300);
  if (c) c.warn(msg + text); else console.error('[plugins] ' + owner + ' ' + msg + text);
}
