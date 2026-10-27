// 用户界面：看用户此刻在 bridge 里看什么、把他的界面带到某处（取代旧全局助手的「带你去」）。
// 下行经账号事件总线发 ui.cmd（前端 web/src/lib/agentUi.js 执行），所以不需要有对话正在跑。

import { randomUUID } from 'node:crypto';
import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { getUiState } from '../../runtime/ui-state.mjs';
import { busPublish } from '../../runtime/bus.mjs';

defineGroup('ui', '用户界面', '看用户此刻开着的 bridge 界面，把它带到某个页面 / 会话 / 文件。');

const PAGES = ['home', 'claude', 'files', 'routines', 'settings', 'chatgpt', 'dimensio', 'vertex'];
const PAGE_AGENT = { claude: 'claude', chatgpt: 'codex', dimensio: 'dimensio', vertex: 'gemini' };
const VERTEX_MODULES = ['chat', 'image', 'video', 'voice', 'music'];

defineOp({
  name: 'ui.view', title: '用户此刻在看什么',
  desc: '列出这个账号开着的 bridge 界面（手机 app / 网页 / 桌面客户端），每个给出所在页面、工作台状态、文件面板路径、正在预览的文件。fresh=false 表示一分多钟没上报、多半已经切走了。',
  handler: async (ctx) => ({
    clients: getUiState(ctx.key).map((c) => ({ client: c.clientId, kind: c.client, fresh: c.fresh, at: c.at, ...c.state })),
  }),
});

function pickClient(ctx, want) {
  const all = getUiState(ctx.key);
  if (want === 'all') return { target: null, count: all.filter((c) => c.fresh).length };
  if (want) {
    const c = all.find((x) => x.clientId === want);
    if (!c) throw new OpError('not_found', '没有这个界面', { hint: '界面 id 见 ui.view 的 client' });
    return { target: c.clientId, kind: c.client, count: 1 };
  }
  const fresh = all.filter((c) => c.fresh);
  if (!fresh.length) return { target: null, count: 0 };
  return { target: fresh[0].clientId, kind: fresh[0].client, count: 1 };
}

defineOp({
  name: 'ui.open', title: '把用户的界面带到某处',
  desc: [
    '四选一：page（页面，可带 module / section）、session（打开一个 Claude 会话）、file（把文件推进预览）、folder（文件面板定位到文件夹）。',
    '默认发给最近活跃的那个界面；client 指定某一个（ui.view 里的 client），all 发给全部。用户没开着任何 bridge 界面时 delivered=false。',
    'page 取值：', PAGES.join(' / '), '；vertex 的 module：', VERTEX_MODULES.join(' / '), '；settings 的 section 是设置分区（如 account、devices、agentapi（Agent 接入））。',
    '只在用户要你「带我去 / 打开给我看」时用，别擅自把用户从正在看的地方拽走。',
  ].join(''),
  access: 'write',
  params: {
    page: { type: 'string', enum: PAGES },
    module: { type: 'string', enum: VERTEX_MODULES },
    section: { type: 'string', max: 40 },
    session: { type: 'string', desc: 'Claude 会话 id' },
    file: { type: 'string', desc: '相对工作空间根的文件路径' },
    folder: { type: 'string', desc: '相对工作空间根的文件夹路径' },
    client: { type: 'string', desc: '发给哪个界面（ui.view 的 client）；all = 全部' },
  },
  handler: async (ctx, args) => {
    const kinds = ['page', 'session', 'file', 'folder'].filter((k) => args[k] !== undefined && args[k] !== '');
    if (kinds.length !== 1) throw new OpError('bad_args', 'page / session / file / folder 要且只要给一个');
    if (args.page && PAGE_AGENT[args.page] && !(ctx.agents || []).includes(PAGE_AGENT[args.page])) {
      throw new OpError('forbidden', `「${args.page}」页对你没开`);
    }
    const target = args.page ? { page: args.page, ...(args.module ? { module: args.module } : {}), ...(args.section ? { section: args.section } : {}) }
      : args.session ? { session: String(args.session) }
        : args.file ? { file: String(args.file).replace(/\\/g, '/') }
          : { folder: String(args.folder).replace(/\\/g, '/') };
    const pick = pickClient(ctx, args.client);
    if (!pick.count) return { delivered: false, note: '用户现在没有开着的 bridge 界面（手机 app / 网页 / 桌面客户端都没在前台）' };
    busPublish(ctx.key, { type: 'ui.cmd', id: randomUUID(), at: Date.now(), op: 'open', target, ...(pick.target ? { client: pick.target } : {}) });
    return { delivered: true, ...(pick.target ? { client: pick.target, kind: pick.kind } : { clients: pick.count }), target };
  },
});

defineOp({
  name: 'ui.notify', title: '在用户界面上弹一条提示',
  desc: '在用户开着的 bridge 界面底部弹一条几秒自隐的提示（toast）。适合「做完了」这类轻提醒。',
  access: 'write',
  params: { text: { type: 'string', required: true, max: 200 }, client: { type: 'string', desc: '同 ui.open' } },
  handler: async (ctx, args) => {
    const pick = pickClient(ctx, args.client);
    if (!pick.count) return { delivered: false, note: '用户现在没有开着的 bridge 界面' };
    busPublish(ctx.key, { type: 'ui.cmd', id: randomUUID(), at: Date.now(), op: 'toast', text: args.text, ...(pick.target ? { client: pick.target } : {}) });
    return { delivered: true };
  },
});
