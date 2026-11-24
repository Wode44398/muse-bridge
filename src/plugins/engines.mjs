// 插件清单的 engines.bridge：这个插件要哪些版本的 bridge（如 ">=6.70"、"^6.70"、">=6.70 <7"、"6.68 || >=6.80"）。
// bridge 的版本号是 versions.mjs 的 APP_VERSION_NAME（如 6.68）。不满足就拒装、拒加载，并说清楚要什么版本。
// 只实现插件作者实际会写的那几种写法：>= > <= < = 精确、^（同主版本）、~（同主次版本）、*、空格 = 且、|| = 或。

import { APP_VERSION_NAME } from '../config/versions.mjs';

export const BRIDGE_VERSION = APP_VERSION_NAME;
// 插件接口版本：ctx 上的能力有破坏性变化时加一（插件可以在 engines.pluginApi 里写最低要求）。
// 1 = 10-26 插件内核；2 = 10-27 运行环境（ctx.chat / process / webhook / status…）与面板槽位；
// 3 = 10-31 接口定型：沙箱身份、chat 结果码、单轮工具、配置热更新、健康检查、定时、通知、插件日志（只做加法，见手册「接口版本」）。
// 清单没写 engines.pluginApi 的插件按 2 对待（兼容层：ctx.files.put 同步返回）。
export const PLUGIN_API_VERSION = 3;
export const MIN_PLUGIN_API = 2;

// 能力名（ctx.has(名字) 探测）：以后加能力只往这里加名字，不升接口版本。
export const PLUGIN_FEATURES = Object.freeze([
  'chat', 'chat.sandbox', 'chat.tools', 'chat.format', 'chat.history', 'chat.usage', 'chat.budget', 'chat.fast',
  'files', 'files.rw', 'share.space', 'share.chat',
  'process', 'process.health', 'webhook', 'schedule', 'notify', 'log.view',
  'config.hot', 'config.self', 'status', 'action', 'configOptions', 'store', 'panel', 'panel.config', 'process.args', 'sandbox.readDirs', 'claude.tool', 'claude.prompt', 'claude.mcp', 'agentOp', 'manual',
  'models.provide',
  // 四期：改到核心
  'events', 'claude.hook', 'claude.permission', 'claude.input', 'claude.options', 'tools.agents', 'tools.agy', 'tools.codex', 'net', 'oauth', 'models.middleware', 'tool.card',
  'replaces', 'service.priority', 'notify.channel', 'auth.provider',
  'ui.homeCard', 'ui.workbench', 'ui.command', 'ui.composerAction', 'ui.messageAction', 'ui.sessionAction', 'ui.theme',
  // 插件应用：主页图标 + 全屏分页（ctx.ui.app / 清单 ui.apps）；没有 index.mjs 的纯页面插件
  'ui.app', 'plugin.pageOnly',
  // 页面宿主能力（_bridge/kv · grants · chat/* · files/* · host/*，页面 SDK 用；这里列出好让插件作者 ctx.has 探测宿主版本）
  'page.kv', 'page.grants', 'page.chat', 'page.files', 'page.nav', 'page.host',
  // 声明式应用（ctx.ui.app 的 view / actions，bridge 按积木画）与 ctx.ui.refresh
  'ui.app.view', 'ui.refresh', 'ui.blocks',
  // 更多插槽：文件「用 X 打开」、命令面板收录插件命令、应用固定到 Claude 侧栏、市场的应用分类
  'ui.fileHandler', 'ui.command.palette', 'ui.app.pin', 'market.app',
  // 工作区插槽：文件夹外观与菜单项（plugins/workspace.mjs）、Claude 记忆目录、Antigravity 的回合事件、agy 插件提示带会话目录
  'ui.workspaceDecor', 'ui.workspaceAction', 'ui.refreshDecor', 'claude.memory', 'events.agy', 'prompt.agy.cwd',
  // 六期：实时通道（ctx.socket / 页面 bridge.socket）、工作区卡片进各 agent 分页（ctx.ui.workbench 的 hosts）、页面下载（bridge.download）
  'socket', 'page.socket', 'ui.workbench.hosts', 'page.download', 'tools.codex',
  // 八期：插件以某个身份调只读的 agent 操作（ctx.ops.call）、审批策略能要求用户本人批（'ask'）、别的 agent 经 bridge 操作发来的轮带 via
  'ops.call', 'claude.permission.ask', 'events.via',
  // 审批策略也管 Antigravity（agents:['agy']）、确保 Claude 项目、消息改写给模型的旁注（hint，不进标题、界面不显示）
  'claude.permission.agy', 'claude.ensureProject', 'claude.input.hint',
]);

const parse = (v) => {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(String(v));
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
};
export function compareVersions(a, b) {
  const x = parse(a), y = parse(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

function one(ver, cond) {
  const m = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(cond.trim());
  if (!m) return false;
  const op = m[1] || '=';
  if (m[2] === '*' || m[2] === 'x') return true;
  const c = compareVersions(ver, m[2]);
  if (Number.isNaN(c)) return false;
  const want = parse(m[2]);
  const have = parse(ver);
  switch (op) {
    case '>=': return c >= 0;
    case '<=': return c <= 0;
    case '>': return c > 0;
    case '<': return c < 0;
    case '=': return c === 0;
    case '^': return c >= 0 && have[0] === want[0];
    case '~': return c >= 0 && have[0] === want[0] && have[1] === want[1];
    default: return false;
  }
}

export function satisfies(ver, range) {
  const r = String(range || '').trim();
  if (!r || r === '*') return true;
  return r.split('||').some((alt) => alt.trim().split(/\s+/).filter(Boolean).every((c) => one(ver, c)));
}

// 清单的兼容检查：不满足返回人话原因，满足返回 ''。
export function enginesProblem(manifest) {
  const e = manifest && typeof manifest.engines === 'object' ? manifest.engines : null;
  if (!e) return '';
  if (e.bridge && !satisfies(BRIDGE_VERSION, e.bridge)) return `这个插件要 bridge ${e.bridge}，这台是 ${BRIDGE_VERSION}`;
  if (e.pluginApi != null && Number(e.pluginApi) > PLUGIN_API_VERSION) return `这个插件要插件接口 v${e.pluginApi}，这台 bridge 只有 v${PLUGIN_API_VERSION}（先升级 bridge）`;
  return '';
}

// 版本范围有没有上界（盖内置功能的市场版必须写明适用到哪一版 bridge：下一版会把修复并进内核，旧的盖不住新的）。
export function hasUpperBound(range) {
  const r = String(range || '').trim();
  return !!r && r !== '*' && !satisfies('999.0', r);
}
