// Claude 侧栏画插件工作区外观时用的小件：对方是谁、悬停说明压成几行字。数据形状见 lib/pluginUi/workspace.svelte.js。
import { t, tr } from '../../../lib/i18n.js';

export const AGENT_NAMES = Object.freeze({ agy: 'Antigravity', claude: 'Claude' });
export const agentName = (a) => AGENT_NAMES[a] || '';

/** 方块里画谁：peers 里第一个不是 Claude 自己的（只有 Claude 一个时不画方块）。 */
export function peerOf(item) {
  return (item?.peers || []).find((a) => a !== 'claude') || '';
}

/** 项目名下那一行：只写插件给的 note（写不写、写什么都由插件定；对方在不在跑由方块里的标志动不动表示）。 */
export function noteLine(item) {
  return tr(item?.note || '');
}

/** 方块的引擎状态：对方在这里干活时动起来。 */
export function tileMark(item) {
  const p = peerOf(item);
  return p && (item?.busy || []).includes(p) ? 'writing' : 'static';
}

/** 秒数 → 「m:ss」/「h:mm:ss」。 */
export function clock(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  const p2 = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${p2(m)}:${p2(r)}` : `${m}:${p2(r)}`;
}

const MAX_LINES = 5;
/**
 * 悬停说明：card 的内容压成几行字（标题一行加至多 5 行正文）。since 要走秒的行交给调用方按 elapsed(row) 现算。
 * → { title, lines: [{ text, since }] }
 */
export function tipOf(item) {
  const card = item?.card || null;
  const peer = peerOf(item);
  const title = tr(card?.title || '') || (peer ? t('和 {agent} 共用这个文件夹', { agent: agentName(peer) }) : tr(item?.note || ''));
  const lines = [];
  for (const sec of card?.sections || []) {
    for (const r of (sec.rows || []).slice(0, 2)) {
      const meta = tr(r.meta || '');
      // 路径一类（mono）只留尾巴：说明里要的是「哪个目录」，开头的盘符和用户目录都一样
      const text = r.mono && r.text.length > 38 ? '…' + r.text.slice(-36) : tr(r.text);
      lines.push({ text: text + (meta ? ' · ' + meta : ''), since: r.live && r.since ? r.since : 0, mono: !!r.mono });
    }
  }
  // 对方在这个项目里的会话：数一下，侧栏里那一组的概要
  for (const g of item?.peerSessions || []) {
    const n = (g.items || []).length;
    if (!n) continue;
    const live = g.items.filter((x) => x.live).length;
    lines.push({ text: live ? t('{agent} 在这里有 {n} 个对话，{m} 个在跑', { agent: agentName(g.agent), n, m: live }) : t('{agent} 在这里有 {n} 个对话', { agent: agentName(g.agent), n }), since: 0 });
  }
  if (card?.foot?.text) lines.push({ text: tr(card.foot.text), since: 0 });
  return { title, lines: lines.slice(0, MAX_LINES) };
}
