// 会话级输出风格（官方会话菜单「Output style」同款，2026-10-20）：输入栏加号菜单里给【这一个会话】另选风格，
// 不动设置里的默认（设置 › Claude › 新会话默认 › 输出风格）。下一轮起生效。
//   · 已有会话：POST /api/claude/output-style 记进服务端 chat-prefs（同账号各设备一致），总线 {type:'output_style'} 回推
//   · 还没发出第一条的新会话：先记在 pending，发送时随 /api/chat 带 outputStyle（chat 内核 chatParams 读 pendingOutputStyle，
//     真发出去时 markOutputStyleSent 记一笔）；一旦有了会话 id 就清掉 pending，不会沾到下一个新会话上——
//     是发出去换来的 id（adoptOutputStyleSent），就把发出去的那个风格转记成这个会话的覆盖（菜单主行立刻显示对，不必等点进子菜单）
//   · 打开已有会话：/api/session 返回的 prefs.outputStyle 直接吸收（absorbSessionOutputStyle，chat 内核 loadSession 调），
//     加号菜单打开时还没有的再补拉一次
// 风格的显示名：内置五个用注册表的中文名（optionLabels），自定义风格（~/.claude/output-styles/*.md）原样显示文件名。
import { untrack } from 'svelte';
import { api } from './api.js';
import { busOn } from './bus.js';
import { session } from './state.svelte.js';
import { cs } from './claudeSettings.svelte.js';
import { t } from './i18n.js';
import { CLAUDE_SETTING_BY_KEY, BUILTIN_OUTPUT_STYLES } from '../../../src/config/claude-settings.mjs';

export const ostyle = $state({
  pending: null,        // 新会话（还没 id）选好的风格；null = 跟随默认
  bySession: {},        // sid → 覆盖（null = 跟随默认）；undefined = 还没问过服务端
  busy: false,
  err: '',
});

let sent;   // 新会话随第一条发出去的风格（null = 跟随默认；undefined = 没有在等的）；等会话 id 回来转记成覆盖

// 有了会话 id（不管是发出去换来的，还是切去了别的会话）：pending 与「在等的」一律作废。
// 转记只在 adoptOutputStyleSent 里做——id 回来之前就切去别的已有会话时，不能把发出去的风格安到那个会话头上。
$effect.root(() => {
  $effect(() => {
    if (!session.id) return;
    untrack(() => { sent = undefined; ostyle.pending = null; });
  });
});

/** 发送路径（chat 内核 send）在请求真发出去时调：新会话记下随第一条带走的风格（没带 = null，跟随默认）。续聊不记。 */
export function markOutputStyleSent(style) { if (!session.id) sent = style || null; }

/**
 * 新会话首轮的 id 从直播里回来时调（chat 内核 'session' 事件 / 收尾兜底，和 promoteComposerDraft 同一处）：
 * 把随第一条发出去的风格转记成这个会话的覆盖，加号菜单主行立刻显示对。没有在等的就什么都不做。
 */
export function adoptOutputStyleSent(sid) {
  if (!sid || sent === undefined) return;
  if (ostyle.bySession[sid] === undefined) ostyle.bySession = { ...ostyle.bySession, [sid]: sent };
  sent = undefined;
}

/** /api/session 返回的 prefs（服务端 chat-prefs，可能来自别的设备）里的会话覆盖并进来。 */
export function absorbSessionOutputStyle(sid, prefs) {
  if (!sid || !prefs || typeof prefs !== 'object') return;
  const v = typeof prefs.outputStyle === 'string' && prefs.outputStyle ? prefs.outputStyle : null;
  if (ostyle.bySession[sid] !== v) ostyle.bySession = { ...ostyle.bySession, [sid]: v };
}

busOn((ev) => {
  if (ev && ev.type === 'output_style' && ev.sessionId) ostyle.bySession = { ...ostyle.bySession, [ev.sessionId]: ev.style || null };
});

/** 风格的显示名（内置用中文名，「default」= 默认）。 */
export function outputStyleLabel(v) {
  const s = CLAUDE_SETTING_BY_KEY.outputStyle;
  const i = BUILTIN_OUTPUT_STYLES.findIndex((x) => x.toLowerCase() === String(v || 'default').toLowerCase());
  return i >= 0 ? t(s.optionLabels[i]) : String(v);
}
/** 内置风格的一行说明（自定义风格没有）。 */
export function outputStyleDesc(v) {
  const s = CLAUDE_SETTING_BY_KEY.outputStyle;
  const i = BUILTIN_OUTPUT_STYLES.findIndex((x) => x.toLowerCase() === String(v || '').toLowerCase());
  return i > 0 && s.optionDescs[i] ? t(s.optionDescs[i]) : '';
}

/** 新会话要随第一条消息带的风格（chat 内核 chatParams 用）。 */
export const pendingOutputStyle = () => (session.id ? null : ostyle.pending);

/** 当前会话的覆盖：null = 跟随默认；undefined = 还没拉到。 */
export function currentOutputStyle() {
  if (!session.id) return ostyle.pending;
  return ostyle.bySession[session.id];
}

/** 拉一次这个会话的覆盖（加号菜单打开、本地还没有时）；顺带收下服务端此刻的可选清单（含刚学到的自定义风格）。 */
export async function loadSessionOutputStyle(sid = session.id) {
  if (!sid) return;
  try {
    const r = await api.get('/api/claude/output-style?session=' + encodeURIComponent(sid));
    if (r && r.ok) {
      ostyle.bySession = { ...ostyle.bySession, [sid]: r.style || null };
      if (Array.isArray(r.styles) && r.styles.length) cs.outputStyles = r.styles;
    }
  } catch { /* 拉不到就按跟随默认显示 */ }
}

/** 给当前会话选风格（null = 跟随默认）。 */
export async function setSessionOutputStyle(style) {
  const sid = session.id;
  const v = style || null;
  ostyle.err = '';
  if (!sid) { ostyle.pending = v; return true; }
  const prev = ostyle.bySession[sid];
  ostyle.bySession = { ...ostyle.bySession, [sid]: v };
  ostyle.busy = true;
  try {
    await api.post('/api/claude/output-style', { session: sid, style: v });
    return true;
  } catch (e) {
    ostyle.bySession = { ...ostyle.bySession, [sid]: prev };
    ostyle.err = t('输出风格没改成，请重试');
    return false;
  } finally { ostyle.busy = false; }
}

/** 菜单要列的风格：服务端报的可选清单（含自定义），「default」排第一。 */
export const outputStyleOptions = () => {
  const list = Array.isArray(cs.outputStyles) && cs.outputStyles.length ? cs.outputStyles : [...BUILTIN_OUTPUT_STYLES];
  return ['default', ...list.filter((x) => x.toLowerCase() !== 'default')];
};
