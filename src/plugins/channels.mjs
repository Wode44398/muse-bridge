// 通知渠道（插件接口四期，第二批）：ctx.notify.channel({ id, label, send, who? })。
//
// bridge 要提醒人的时候（插件的 ctx.notify、Claude 的 PushNotification 推送……，都走 runtime/push-notices.mjs notePush），
// 除了在线界面与手机通知栏，再投给插件登记的渠道（飞书、Telegram、邮件、企业微信……）。
//   send({ owner, title, body, level, sessionId, url }) → 可 async；抛错 / 超时（20 秒）只记插件日志
//   who：'host'（缺省，只投主机的通知）| 'members'（成员的也投——渠道自己按 owner 找人）
import { kernel } from './state.mjs';
import { HOST_OWNER } from '../runtime/principal.mjs';

export const CHANNELS_SLOT = 'notify.channels';
const ID_RE = /^[a-z][a-z0-9-]{0,31}$/;

export function addChannel(ctx, spec) {
  if (!spec || !ID_RE.test(String(spec.id || ''))) throw new Error('通知渠道要有 id（小写字母开头，只用小写字母、数字、连字符）');
  if (typeof spec.send !== 'function') throw new Error('通知渠道要有 send(message) 函数');
  if (spec.who && !['host', 'members'].includes(spec.who)) throw new Error("who 只能是 'host' / 'members'");
  return ctx.contribute(CHANNELS_SLOT, { id: spec.id, label: String(spec.label || spec.id).slice(0, 40), send: spec.send, who: spec.who || 'host' });
}

/** 已登记的渠道（详情页 / 手册列给人看）：[{ plugin, id, label, who }]。 */
export function listChannels() {
  if (!kernel.started) return [];
  return kernel.slot(CHANNELS_SLOT).entries().map(({ item, owner }) => ({ plugin: owner, id: item.id, label: item.label, who: item.who }));
}

/** notePush 调：投给所有对得上的渠道。立刻返回。 */
export function deliverToChannels(key, { title = '', body = '', level = 'info', sessionId = null, url = '' } = {}) {
  if (!kernel.started) return;
  let list;
  try { list = kernel.slot(CHANNELS_SLOT).entries(); } catch { return; }
  const isHost = key === HOST_OWNER;
  const hits = list.filter(({ item }) => isHost || item.who === 'members');
  if (!hits.length) return;
  const msg = { owner: isHost ? { kind: 'admin', login: 'host' } : { kind: 'user', key: String(key) }, title: String(title).slice(0, 120), body: String(body).slice(0, 2000), level, sessionId, url };
  setImmediate(() => {
    for (const { item, owner } of hits) {
      let timer;
      Promise.race([
        Promise.resolve().then(() => item.send({ ...msg })),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('超过 20 秒')), 20_000); timer.unref?.(); }),
      ]).catch((e) => {
        const c = kernel.contextOf(owner);
        const t = `通知渠道「${item.label}」没投出去：${String(e?.message || e).slice(0, 200)}`;
        if (c) c.warn(t); else console.error('[plugins] ' + owner + ' ' + t);
      }).finally(() => clearTimeout(timer));
    }
  });
}
