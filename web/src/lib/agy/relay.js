// bridge 自动转进 Antigravity 会话的消息（子会话的汇报、别的会话发来的话、CI 事件）：
// 在 agy 的历史里它是一条「用户消息」，但不是用户本人打的——界面上收成一行说明，点开才看全文，不画成用户气泡。
// 开头那句由服务端加（modules/agy/server/mcp/deliver.mjs 的 RELAY_NOTE），两边必须逐字一致（服务端有单测对着这里）。

export const RELAY_NOTE = '（这条由 bridge 自动转来，不是用户本人发的。）'; // i18n-ignore：协议里的原文，不是给人看的界面字

/** 是不是转来的消息；是的话返回 { body, kind, peek }，不是返回 null。 */
export function relayedMessage(text) {
  const s = String(text || '');
  if (!s.startsWith(RELAY_NOTE)) return null;
  const body = s.slice(RELAY_NOTE.length).replace(/^\s+/, '');
  const kind = /<ci-monitor-event/i.test(body) ? 'ci' : (/<side-sessions-event/i.test(body) ? 'report' : 'message');
  // 一行预览：去掉标签，取第一段有字的
  const plain = body.replace(/<[^>\n]{1,400}>/g, ' ').replace(/\s+/g, ' ').trim();
  return { body, kind, peek: plain.length > 90 ? plain.slice(0, 90) + '…' : plain };
}
