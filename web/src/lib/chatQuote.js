// 「引用对话」：侧栏里的一条会话拖进另一个对话（输入栏 / 侧栏另一条会话）松手＝把那段对话当
// 背景材料引用进来。和工作空间文件拖进对话同一套语义——不是跳转、不是分屏，而是这次发送多一份附件。
//
// 服务端 POST /api/session/quote 把被引会话整理成一份 Markdown 落进本人 uploads，回 { path, name, count }；
// 这里把它当一张 kind:'chat' 的附件挂进 compose.attachments，发送走既有附件链路（路径进提示词、
// claude.mjs 标注「引用的对话」、模型按需 Read；历史重开时 sessions.mjs 按存盘名认回对话卡）。
//
// 拖拽载荷（手指那套 lib/dragdrop）：{ type: CHAT_REF, id, name }。鼠标那套走 ClaudePage 侧栏的 HTML5
// 拖拽（dragRec.kind === 'session'），落点直接调 quoteSession。
import { compose } from './state.svelte.js';
import { api } from './api.js';
import { dropToast } from './dragdrop.svelte.js';
import { t, tr } from './i18n.js';

export const CHAT_REF = 'claude-session';

export const isChatRef = (p) => p?.type === CHAT_REF && !!p.id;

// 能不能把会话 id 引进「当前开着 curId 的这个对话」：不引自己，不重复引。
export function canQuote(id, curId) {
  if (!id || id === curId) return false;
  return !compose.attachments.some((a) => a.kind === 'chat' && a.quoteId === id);
}

export async function quoteSession({ id, title = '' }) {
  if (!id) return false;
  if (compose.attachments.some((a) => a.kind === 'chat' && a.quoteId === id)) { dropToast(t('这个对话已经引用过了')); return false; }
  compose.attachments.push({ path: null, name: title || t('（无标题）'), kind: 'chat', quoteId: id, url: null, count: null, pending: true });
  const live = compose.attachments[compose.attachments.length - 1];   // 代理引用，直改才驱动 UI
  try {
    const r = await api.post('/api/session/quote', { id, title });
    if (compose.attachments.indexOf(live) < 0) return false;          // 整理期间被用户移除了
    live.path = r.path;
    live.name = r.name || live.name;
    live.count = r.count || 0;
    live.pending = false;
    dropToast(t('已引用对话「{title}」', { title: live.name }));
    return true;
  } catch (e) {
    const i = compose.attachments.indexOf(live);
    if (i >= 0) compose.attachments.splice(i, 1);
    const why = e?.body?.error || e?.message || '';
    dropToast(why ? t('引用失败：{reason}', { reason: tr(why) }) : t('引用失败'));
    return false;
  }
}
