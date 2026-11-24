// 各 agent 分页共用的工作区工具登记表。
//
// 这里登记一张，四个分页的工作区就都有：外壳（Workbench）按这张表摆开关、卡片、手机上的标签，
// 面板内容在 components/dock/SharedPanel.svelte 里按 key 分发。各分页只在自己的宿主里补【专属卡】
// （Claude 的任务、Antigravity 的代理与活动……），或者给共用卡换个叫法 / 换一份内容。
//
// 字段：
//   label / closeLabel —— 标题与关闭钮的整句（英文 “Close terminal” 是小写名词，不能拿标题拼）
//   kbd / match        —— 桌面快捷键（浏览器保留的组合拦不了，别用）
//   col                —— 两列排布时默认落哪一列（a = 窄内容，b = 要宽的）
//   bar                —— 工具开关组里常驻（否则收进「更多」）
//   ok(env)            —— 这个身份 / 这个宿主给不给。env = { shell, snap, host }
import { t, tc } from '../i18n.js';
import { pluginOn } from '../state.svelte.js';
import { dockIcon } from '../dockIcons.js';
import { workbenchFor, workbenchKey, uiIcon } from '../pluginUi.svelte.js';

export const SHARED_TOOLS = [
  {
    key: 'term', label: t('终端'), closeLabel: t('关闭终端'), col: 'a', bar: true,
    kbd: 'Ctrl+`', match: (e) => e.ctrlKey && !e.shiftKey && e.code === 'Backquote',
    // 快照访客没有终端；终端 / 浏览器是可关的内置功能
    ok: ({ shell, snap }) => shell && !snap && pluginOn('terminal'),
  },
  {
    key: 'review', label: t('审阅'), closeLabel: t('关闭审阅'), col: 'a', bar: true,
    kbd: 'Ctrl+Shift+G', match: (e) => e.ctrlKey && e.shiftKey && e.code === 'KeyG',
  },
  {
    key: 'browser', label: t('浏览器'), closeLabel: t('关闭浏览器'), col: 'b', bar: true,
    kbd: 'Ctrl+Shift+B', match: (e) => e.ctrlKey && e.shiftKey && e.code === 'KeyB',
    // 快照访客给只读直播
    ok: ({ shell, snap }) => (shell || snap) && pluginOn('browser'),
  },
  {
    key: 'files', label: tc('dock', '文件'), closeLabel: tc('dock', '关闭文件'), col: 'b',
    kbd: 'Ctrl+Shift+E', match: (e) => e.ctrlKey && e.shiftKey && e.code === 'KeyE',
  },
  {
    key: 'memory', label: tc('dock', '记忆'), closeLabel: tc('dock', '关闭记忆'), col: 'b', kbd: '',
    // 记忆按 agent 各有各的库：宿主说了读哪家的才给
    ok: ({ snap, host }) => !snap && !!host.memoryAgent,
  },
];

const byKey = new Map(SHARED_TOOLS.map((x) => [x.key, x]));
export const sharedTool = (key) => byKey.get(key) || null;

// 一个宿主的完整工具表：共用的（可按 key 换叫法、换图标、换内容）+ 它的专属卡。
//   own  = [{ key, label, closeLabel, icon?, col?, bar?, kbd?, match?, ok?, fixed?, own:true }]
//   over = { [key]: 要盖掉的字段 }；skip = 不要的共用卡
//   order = 开关 / 标签的摆放顺序（没列到的排在后面）
//   host  = 宿主 id（claude / codex / agy / dimensio）：插件登记给这个分页的工作区卡片（ctx.ui.workbench 的 hosts）跟着摆进来，
//           挂在第二列末尾、收进「更多」；内容由 SharedPanel 统一画（插件页面），快照访客不给
export function buildTools({ own = [], over = {}, skip = [], order = [], host = '' } = {}) {
  const list = [
    ...SHARED_TOOLS.filter((x) => !skip.includes(x.key)).map((x) => ({ ...x, icon: dockIcon(x.key), ...(over[x.key] || {}) })),
    ...own.map((x) => ({ col: 'a', kbd: '', own: true, ...x })),
    ...(host ? pluginCards(host) : []),
  ];
  const rank = (k) => { const i = order.indexOf(k); return i < 0 ? order.length : i; };
  return list.map((x, i) => [x, i]).sort((p, q) => rank(p[0].key) - rank(q[0].key) || p[1] - q[1]).map((p) => p[0]);
}

/** 插件给这个分页的工作区卡片（工具表条目形状）。 */
export function pluginCards(host) {
  return workbenchFor(host).map((w) => ({
    key: workbenchKey(w), label: w.title || '', closeLabel: t('关闭「{name}」', { name: w.title || '' }), icon: uiIcon(w.icon), iconSvg: true,
    col: 'b', kbd: '', fixed: true, plugin: true, ok: ({ snap }) => !snap,
  }));
}

// 门禁：meta 没到之前按「有命令行」乐观摆，别让开关闪一下再消失
export function toolAllowed(tool, host, { snap = false } = {}) {
  const meta = host.state.meta;
  const shell = !meta || meta.shell !== false;
  return tool.ok ? !!tool.ok({ shell, snap, host }) : true;
}

// 桌面快捷键命中了哪张卡（没有回 ''）
export function toolForKey(tools, e) {
  for (const x of tools) if (x.match && x.match(e)) return x.key;
  return '';
}
