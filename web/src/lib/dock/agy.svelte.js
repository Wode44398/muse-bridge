// Antigravity 分页的工作区宿主：共用工具 + 「代理」「活动」两张专属卡；审阅卡换成它自己那份（带非 git 目录的退化视图）。
import { tc } from '../i18n.js';
import { createDockHost } from './host.svelte.js';
import { buildTools } from './tools.js';
import { workbenchKeys } from '../pluginUi.svelte.js';

const KEYS = ['files', 'review', 'term', 'browser', 'agents', 'activity'];
// agentsFocus = 代理卡定位高亮的目标 { agentId, seq }；agentStack = 压在代理列表之上的嵌套子代理转录栈（多层钻取返回）；
// swarmNav = 打开代理卡时指向 Swarm 子页与消息定位 { tab, seq, token }
export const agyHost = createDockHost({
  id: 'agy',
  initialView: 'files',
  keys: () => [...KEYS, ...workbenchKeys('agy')],
  sortable: () => ['files', 'review', 'term', 'agents', 'browser', 'activity'],
  colOf: (k) => (k === 'browser' || k === 'activity' ? 'b' : 'a'),
  extra: { agentsFocus: null, agentStack: [], swarmNav: null },
  caps: { filesRoot: 'ws', previewHost: 'agy-workspace' },
});
const state = agyHost.state;

// 图标是 Antigravity 自己那套符号字（icon = 连字名，由它的宿主片段画）
export const agyTools = () => buildTools({
  order: KEYS,
  host: 'agy',
  skip: ['memory'],
  over: {
    files: { label: tc('agy', '文件'), closeLabel: tc('agy', '关闭文件'), icon: 'folder_open' },
    review: { label: tc('agy', '审阅'), icon: 'edit_note', own: true },
    term: { label: tc('agy', '终端'), icon: 'terminal' },
    browser: { label: tc('agy', '浏览器'), icon: 'globe' },
  },
  own: [
    { key: 'agents', label: tc('agy', '代理'), closeLabel: tc('agy', '关闭代理'), icon: 'smart_toy', col: 'a' },
    { key: 'activity', label: tc('agy', '活动'), closeLabel: tc('agy', '关闭活动'), icon: 'checklist', col: 'b' },
  ],
});

let focusSeq = 0;
export function openAgyAgentsPanel({ agentId = '', openTranscript = false, swarmTab = '', swarmSeq = 0 } = {}) {
  const id = String(agentId || '').trim();
  if (openTranscript && id) {
    state.agentStack = [id];
    state.agentsFocus = { agentId: id, seq: ++focusSeq };
  } else {
    state.agentStack = [];
    state.agentsFocus = id ? { agentId: id, seq: ++focusSeq } : null;
  }
  if (swarmTab || swarmSeq > 0) {
    state.swarmNav = { tab: swarmTab || (swarmSeq > 0 ? 'board' : 'overview'), seq: Number(swarmSeq) || 0, token: ++focusSeq };
  }
  agyHost.open('agents');
}
export function pushAgyAgentTranscript(agentId) {
  const id = String(agentId || '').trim();
  if (!id) return;
  if (state.agentStack[state.agentStack.length - 1] === id) return;
  state.agentStack = [...state.agentStack, id];
}
export function popAgyAgentTranscript() {
  if (!state.agentStack.length) return;
  state.agentStack = state.agentStack.slice(0, -1);
}
export function clearAgyAgentStack() {
  if (state.agentStack.length) state.agentStack = [];
  state.agentsFocus = null;
  state.swarmNav = null;
}
