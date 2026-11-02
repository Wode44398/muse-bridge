// 插件工具的结果卡片（插件接口四期，工具 spec 写 render:'card'；服务端 src/plugins/claude-tools.mjs 的 toResult）：
// 工具结果的 content 里有一段文字以 [[bridge-card]] 开头、后面是 JSON：
//   { title, subtitle, fields: [{ label, value }], image（http(s) 或站内 / 开头）, markdown, link: { url, label } | null, tone }
// 前端认出这段就画成一张卡（components/claude/ToolCard），不显示这段原文；模型看到的是另一段文字摘要。
//
// 来源（谁带来都认）：工具条目的 card（已解析的对象）、content（MCP content 数组 / 字符串）、result（字符串）。
// 服务端在直播 tool_done 帧 / 历史条目里带上其中之一即可。
export const CARD_MARK = '[[bridge-card]]';

const str = (v, n) => (v == null ? '' : String(v).slice(0, n));
// 只收 http(s) 与站内 / 开头的地址（// 开头的协议相对地址当外站，同样只能是 http(s)）
const url = (v) => (typeof v === 'string' && /^(https?:\/\/|\/)/i.test(v.trim()) ? v.trim().slice(0, 2000) : '');

/** 客户端再收一遍（服务端 cleanCard 同款规则）：字段截断、地址只认 http(s) / 站内。没有可画的内容回 null。 */
export function cleanCard(c) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const link = c.link ? { url: url(typeof c.link === 'string' ? c.link : c.link.url), label: str(typeof c.link === 'string' ? '' : c.link.label, 60) } : null;
  const card = {
    title: str(c.title, 200), subtitle: str(c.subtitle, 300),
    fields: (Array.isArray(c.fields) ? c.fields : []).slice(0, 20).map((f) => ({ label: str(f?.label, 60), value: str(f?.value, 400) })).filter((f) => f.label || f.value),
    image: url(c.image), markdown: str(c.markdown, 4000),
    link: link && link.url ? link : null,
    tone: ['ok', 'warn', 'error', 'info'].includes(c.tone) ? c.tone : '',
  };
  return card.title || card.subtitle || card.fields.length || card.image || card.markdown || card.link ? card : null;
}

function fromText(s) {
  if (typeof s !== 'string') return null;
  const i = s.indexOf(CARD_MARK);
  if (i < 0) return null;
  try { return cleanCard(JSON.parse(s.slice(i + CARD_MARK.length).trim())); } catch { return null; }
}

/** 从工具结果里找卡片：src = 卡片对象 | MCP content 数组 | 字符串。找不到回 null。 */
export function cardOf(src) {
  if (!src) return null;
  if (typeof src === 'string') return fromText(src);
  if (Array.isArray(src)) {
    for (const b of src) {
      const c = fromText(typeof b === 'string' ? b : b && b.type === 'text' ? b.text : null);
      if (c) return c;
    }
    return null;
  }
  if (typeof src === 'object') {
    if (Array.isArray(src.content)) return cardOf(src.content);
    return cleanCard(src);
  }
  return null;
}
