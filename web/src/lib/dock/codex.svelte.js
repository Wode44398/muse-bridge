// Codex 分页的工作区宿主：四件共用工具，按项目（会话的 cwd）作用域。
import { tc } from '../i18n.js';
import { createDockHost } from './host.svelte.js';
import { buildTools } from './tools.js';
import { workbenchKeys } from '../pluginUi.svelte.js';

const KEYS = ['review', 'term', 'files', 'browser'];
export const codexHost = createDockHost({
  id: 'codex',
  initialView: 'review',
  keys: () => [...KEYS, ...workbenchKeys('codex')],
  sortable: () => ['term', 'review', 'browser', 'files'],
  colOf: (k) => (k === 'term' || k === 'review' ? 'a' : 'b'),
  caps: { filesRoot: 'ws', previewHost: 'codex-workspace' },
});

// Codex 把审阅叫「更改」
export const codexTools = () => buildTools({
  order: KEYS,
  host: 'codex',
  skip: ['memory'],
  over: {
    review: { label: tc('codex', '更改'), closeLabel: tc('codex', '关闭更改') },
    files: { label: tc('codex', '文件'), closeLabel: tc('codex', '关闭文件') },
  },
});
