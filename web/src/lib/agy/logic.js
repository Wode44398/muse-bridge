// Antigravity 分页纯逻辑层：重导出模型目录与会话分组工具，提供行级 diff 计算、工具分类摘要、
// 权限结论合并、SSE 流式事件与 attach 重放合并及历史消息转换。

import { t, tc } from '../i18n.js';
import { stripWorkspaceCdPrefix } from './session-groups.js';
import { splitAttachedPaths } from './attach-look.js';

export {
  modelDisplayName,
  modelSeriesOf,
  modelDescriptionOf,
  groupModels,
  thoughtLabelOf,
  extractThoughtOptions,
  modeMetaOf,
  extractModeOptions,
  filterSlashCommands,
} from './catalog.js';

export {
  timeBucketOf,
  timeBucketLabel,
  isDaemonPseudoPath,
  stripWorkspaceCdPrefix,
  disambiguateProjectGroups,
  groupSessionsByProjectAndTime,
  resolveAgyLocalLink,
} from './session-groups.js';

export { computeDiffLines } from './diff.js';

export function normalizeLocations(rawLocs) {
  if (!Array.isArray(rawLocs)) return [];
  const out = [];
  for (const item of rawLocs) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ path: item.trim() });
    } else if (item && typeof item === 'object' && typeof item.path === 'string' && item.path.trim()) {
      out.push({
        path: item.path.trim(),
        ...(typeof item.line === 'number' ? { line: item.line } : {}),
      });
    }
  }
  return out;
}

function shortPath(p = '') {
  const norm = String(p || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = norm.split('/').filter(Boolean);
  if (parts.length <= 2) return norm;
  return parts.slice(-2).join('/');
}

export function resolveApprovalDecision(outcome, optionId) {
  const isDenied = outcome === 'cancelled' || /^(?:deny|reject)/i.test(String(optionId || ''));
  return isDenied ? 'denied' : 'allowed';
}

// bridge 自家工具（服务名 bridge，agy 给模型的名字是 mcp_bridge_<工具>）。
// 整串匹配、以工具名为准：跑命令时标题就是命令原文，命令里带 mcp_bridge_browser 字样不能被显示成「打开网页」
//（审批卡用的就是这一行）。只有工具名为空的旧记录才看标题，而且标题得整个就是「Run mcp_bridge_x」。
const BRIDGE_NAME_RE = /^mcp_bridge_(?:[0-9a-f]{8}_)?([a-z0-9_]+)$/i;
const BRIDGE_TITLE_RE = /^Run mcp_bridge_(?:[0-9a-f]{8}_)?([a-z0-9_]+)$/i;
export function bridgeToolOf(tool = {}) {
  const name = String(tool.name || '').trim();
  if (name) {
    const m = BRIDGE_NAME_RE.exec(name);
    return m ? m[1].toLowerCase() : '';
  }
  if (String(tool.kind || '').toLowerCase() === 'execute' || tool.command) return '';
  const m = BRIDGE_TITLE_RE.exec(String(tool.title || '').trim());
  return m ? m[1].toLowerCase() : '';
}

const clip = (v, n = 120) => { const s = String(v ?? '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
export const clipLine = clip;

// bridge 工具 → 一行人话：图标 + 动词 + 对象。detail 给审批卡那一行（替掉「Run mcp_bridge_x」）。
// group：折叠汇总里归到哪一句（step-summary.js）。不给的话浏览器会被数成「网络检索」、查手册被数成「读取文件」。
function bridgeToolMeta(id, a = {}) {
  const meta = bridgeToolMetaOf(id, a);
  if (!meta) return null;
  const act = String(a.action || '').toLowerCase();
  if (id === 'browser') meta.group = t('操作浏览器');
  else if (id === 'terminal' && (act === 'restart' || act === 'resize')) meta.group = meta.verb;
  else if (id === 'terminal' && !['run', 'write', 'keys'].includes(act)) meta.group = t('查看共享终端');
  else if (meta.category === 'read' || meta.category === 'fetch') meta.group = meta.verb;
  return meta;
}
// 设备操作（device_act）一步的人话：输入了什么、按了什么键、启动了什么——审批卡靠它让用户看清要动什么
function deviceActLine(a = {}) {
  const act = String(a.action || '').toLowerCase();
  const at = a.ref != null ? ` #${a.ref}` : (Number.isFinite(a.x) && Number.isFinite(a.y) ? ` (${Math.round(a.x)}, ${Math.round(a.y)})` : '');
  if (act === 'type') return t('输入「{text}」', { text: clip(a.text, 80) });
  if (act === 'key') return t('按 {keys}', { keys: clip(a.keys, 40) });
  if (act === 'launch') return t('启动 {file}', { file: clip([a.file, ...(Array.isArray(a.args) ? a.args : [])].filter(Boolean).join(' '), 100) });
  if (act === 'click' || act === 'double_click' || act === 'triple_click' || act === 'right_click') {
    return (act === 'right_click' ? t('右键点按') : act === 'click' ? t('点按') : t('连点')) + at;
  }
  if (act === 'move') return t('移动鼠标') + at;
  if (act === 'scroll') return t('滚动') + at;
  if (act === 'uia_action') return clip(`${a.uiaAction || 'uia'}${at}${a.value != null && a.value !== '' ? ` = ${a.value}` : ''}`, 100);
  if (act === 'close_window') return t('关闭窗口');
  if (act === 'focus_window') return t('切到窗口');
  if (act === 'set_window') return t('移动 / 调整窗口');
  if (act === 'wait') return t('等待');
  return act;
}

function bridgeToolMetaOf(id, a = {}) {
  const act = String(a.action || '').toLowerCase();
  // summary：步骤行上的对象（短）。extra.detail：审批卡那一行，没给就同 summary。extra.note：审批卡的说明句（落在哪、会动什么）。
  const mk = (category, icon, verb, summary, extra = {}) => ({
    category, icon, verb, summary: summary || '', detail: extra.detail || summary || '', bridge: id,
    ...(extra.note ? { note: extra.note } : {}),
  });
  if (id === 'browser') {
    if (act === 'navigate' || act === 'tab_new') return mk('fetch', 'globe', t('打开网页'), clip(a.url));
    if (act === 'screenshot') return mk('fetch', 'image', t('浏览器截图'), '');
    if (act === 'click' || act === 'hover' || act === 'long_press' || act === 'drag') return mk('fetch', 'globe', t('在浏览器里点按'), clip(a.text || (a.ref != null ? '#' + a.ref : '')));
    if (act === 'type' || act === 'key' || act === 'set_value') return mk('fetch', 'globe', t('在浏览器里输入'), clip(a.text || a.key || a.value));
    if (act === 'read_page' || act === 'find' || act === 'page_text') return mk('fetch', 'description', t('读取网页'), clip(a.query || a.text));
    if (act === 'resize') return mk('fetch', 'globe', t('调整浏览器尺寸'), clip(a.preset || (a.width ? `${a.width}×${a.height || ''}` : '')));
    if (act === 'console' || act === 'network') return mk('fetch', 'bug_report', t('查看网页日志'), clip(a.query));
    if (act === 'batch') return mk('fetch', 'globe', t('连续操作浏览器'), Array.isArray(a.actions) ? t('{n} 步', { n: a.actions.length }) : '');
    return mk('fetch', 'globe', t('操作浏览器'), clip(act));
  }
  if (id === 'tool_docs') return mk('read', 'description', t('查看工具说明'), clip(a.name));
  if (id === 'terminal') {
    const shared = { note: t('会在右侧共享终端里操作，你能实时看到') };
    if (act === 'run') return mk('execute', 'terminal', t('在共享终端执行'), clip(a.command), shared);
    if (act === 'write') return mk('execute', 'terminal', t('在共享终端输入'), clip(a.text), shared);
    if (act === 'keys') return mk('execute', 'terminal', t('在共享终端按键'), clip(a.keys), shared);
    if (act === 'wait') return mk('execute', 'schedule', t('等待终端'), clip(a.until), { detail: clip(a.until) || t('等终端里的程序跑完'), note: t('只是等待，不会往终端里输入') });
    if (act === 'restart') return mk('execute', 'refresh', t('重启共享终端'), '', { detail: t('结束当前 shell 并清空滚回内容'), note: t('终端里正在跑的程序会被结束') });
    if (act === 'resize') {
      const size = a.cols || a.rows ? `${a.cols || '?'}×${a.rows || '?'}` : '';
      return mk('execute', 'terminal', t('调整终端尺寸'), size, { detail: size || t('调整终端的列数与行数'), note: t('只改终端的显示尺寸') });
    }
    return mk('execute', 'terminal', t('查看共享终端'), '', { detail: act === 'status' ? t('查看终端状态') : t('读取终端里的内容'), note: t('只读，不会往终端里输入') });
  }
  if (id === 'workspace') {
    if (act === 'preview') return mk('other', 'open_in_new', t('给你打开预览'), clip(a.path));
    if (act === 'goto') return mk('other', 'folder_open', t('定位文件夹'), clip(a.path));
    if (act === 'move') return mk('edit', 'edit_note', t('移动文件'), clip(`${a.from || ''} → ${a.to || ''}`));
    if (act === 'screenshot') return mk('other', 'image', t('查看你的画面'), '');
    if (act === 'draft') return mk('read', 'description', t('读取未保存的草稿'), '');
    if (act === 'refresh') return mk('other', 'refresh', t('刷新文件面板'), '');
    return mk('other', 'info', t('查看你正在看的'), '');
  }
  if (id === 'manual') return mk('read', 'help', t('查 bridge 手册'), clip(a.q || a.topic));
  if (id === 'media_models') return mk('read', 'search', t('查媒体模型'), clip(a.key || a.q || a.kind));
  if (id === 'media_result') return mk('other', 'schedule', t('取生成结果'), '');
  if (id === 'call') {
    // 审批卡上要看得到这次操作带了什么参数（建什么、删哪个），不只是操作名
    let argText = '';
    try { argText = a.args && typeof a.args === 'object' && Object.keys(a.args).length ? JSON.stringify(a.args) : ''; } catch {}
    return mk('other', 'tune', t('操作 bridge'), clip(a.op), { detail: clip(`${a.op || ''}${argText ? ' ' + argText : ''}`, 400), note: t('这个操作会改动 bridge 里的东西') });
  }
  if (id === 'visualize_read_me') return mk('read', 'description', t('读取绘图规范'), '');
  if (id === 'visualize_show_widget') return mk('other', 'image', t('画图表'), clip(String(a.title || '').replace(/_/g, ' ')));
  if (id.startsWith('device_')) {
    const sub = id.slice(7);
    const dev = a.device ? ` @${clip(a.device, 30)}` : '';
    if (sub === 'act') {
      const steps = act === 'batch' && Array.isArray(a.actions) ? a.actions : null;
      const line = steps
        ? t('连续 {n} 步', { n: steps.length }) + '：' + clip(steps.slice(0, 6).map((s) => deviceActLine(s)).join(' → ') + (steps.length > 6 ? ' …' : ''), 300)
        : deviceActLine(a);
      return mk('other', 'smart_toy', t('操作电脑'), clip(line) + dev, { detail: line + dev, note: t('会在你的电脑上动鼠标和键盘') });
    }
    if (sub === 'shell') return mk('execute', 'terminal', t('在电脑上执行'), clip(a.command) + dev, { note: t('请求在你的电脑上执行命令（不是 bridge 服务器）') });
    if (sub === 'files') {
      const p = clip(a.path || a.pattern || a.cwd || '', 160);
      if (act === 'write') return mk('other', 'edit_note', t('写入电脑文件'), p + dev, { note: t('会改动你电脑上的文件') });
      if (act === 'delete') return mk('other', 'delete', t('删除电脑文件'), p + dev, { detail: p + (a.recursive ? t('（连同里面的全部内容）') : '') + dev, note: t('会删掉你电脑上的文件，不能撤回') });
      if (act === 'move') return mk('other', 'edit_note', t('移动电脑文件'), clip(`${a.path || ''} → ${a.to || ''}`, 200) + dev, { note: t('会改动你电脑上的文件') });
      if (act === 'mkdir') return mk('other', 'folder', t('在电脑上新建文件夹'), p + dev, { note: t('会改动你电脑上的文件') });
      if (act === 'pull') return mk('other', 'download', t('从电脑拷到服务器'), clip(`${a.path || ''} → ${a.to || t('会话工作目录')}`, 200) + dev, { note: t('把你电脑上的文件拷一份到 bridge 服务器') });
      if (act === 'push') return mk('other', 'north_east', t('从服务器推到电脑'), clip(`${a.from || ''} → ${a.path || ''}`, 200) + dev, { note: t('会往你的电脑上写入文件') });
      return mk('other', 'description', t('读取电脑文件'), p + dev, { note: t('只读取你电脑上的文件，不会改动') });
    }
    if (sub === 'ports') {
      if (act === 'open') return mk('other', 'globe', t('接通电脑端口'), (a.port ? ':' + a.port : '') + (a.label ? ' ' + clip(a.label, 30) : '') + dev, { note: t('把你电脑上的本机端口接到 bridge 服务器') });
      if (act === 'close') return mk('other', 'globe', t('断开电脑端口'), (a.port ? ':' + a.port : '') + dev, { note: t('关掉一条端口转发') });
      return mk('other', 'globe', t('查看电脑端口转发'), dev.trim(), { note: t('只读') });
    }
    const verb = sub === 'devices' ? t('查看我的电脑') : sub === 'inspect' ? t('看电脑屏幕') : t('操作电脑浏览器');
    return mk('other', 'smart_toy', verb, clip(a.url || a.query || act) + dev);
  }
  // 会话协作：开的是 Claude 子会话，汇报会转回这里
  if (id === 'start_session') return mk('other', 'smart_toy', t('另开 Claude 会话'), clip(a.title), { detail: clip(`${a.title || ''}${a.prompt ? ' — ' + a.prompt : ''}`, 300), note: t('会在 Claude 分页另开一个会话在后台干活，做完把汇报转回这里') });
  if (id === 'send_message') return mk('other', 'north_east', t('给会话发消息'), clip(a.to), { detail: clip(`${a.to || ''}：${a.message || ''}`, 300), note: t('会把这段话发给另一个会话，它没在跑时会被唤醒') });
  if (id === 'list_sessions') return mk('other', 'checklist', t('查看相关会话'), '');
  if (id === 'read_session') return mk('read', 'description', t('读取会话汇报'), clip(a.to));
  if (id === 'dismiss_task') return mk('other', 'close', t('撤回会话卡片'), clip(a.task_id));
  // 手机操控：一个工具，按 action 说人话
  if (id === 'phone_control') {
    const dev = a.device ? ` @${clip(a.device, 30)}` : '';
    const onPhone = { note: t('会在你的手机上操作') };
    if (act === 'devices') return mk('other', 'info', t('查看我的手机'), dev.trim());
    if (act === 'screen') return mk('other', 'image', t('看手机屏幕'), dev.trim());
    if (act === 'recall' || act === 'learn') return mk('other', 'lightbulb', act === 'learn' ? t('记下手机操作经验') : t('查手机操作经验'), clip(a.app));
    if (act === 'wait') return mk('other', 'schedule', t('等手机界面'), '');
    if (act === 'clipboard_get') return mk('other', 'content_copy', t('读手机剪贴板'), dev.trim());
    if (act === 'confirm') return mk('other', 'help', t('在手机上问你'), clip(a.question), { detail: clip(a.question, 300) });
    if (act === 'send_sms') return mk('other', 'north_east', t('用手机发短信'), clip(a.to) + dev, { detail: clip(`${a.to || ''}：${a.body || ''}`, 300) + dev, note: t('允许 = 同意用你的手机直接发出这条短信') });
    if (act === 'call') return mk('other', 'north_east', t('用手机打电话'), clip(a.number) + dev, { note: t('允许 = 同意用你的手机立即拨出') });
    if (act === 'input' || act === 'clipboard_set' || act === 'share' || act === 'speak') return mk('other', 'smart_toy', t('在手机上输入'), clip(a.text) + dev, onPhone);
    if (act === 'open_app' || act === 'open_url' || act === 'open_settings') return mk('other', 'open_in_new', t('在手机上打开'), clip(a.app || a.url || a.page) + dev, onPhone);
    if (act === 'compose_sms' || act === 'dial') return mk('other', 'smart_toy', act === 'dial' ? t('打开拨号盘') : t('写短信（不发送）'), clip(a.to || a.number) + dev, { note: t('只预填，不会发出或拨出') });
    return mk('other', 'smart_toy', t('操作手机'), clip(act + (a.text ? ' ' + a.text : a.index != null ? ' #' + a.index : '')) + dev, onPhone);
  }
  // 拉取请求
  if (id === 'pr_status') return mk('other', 'code', t('查看拉取请求'), '');
  if (id === 'pr_bind') return mk('other', 'code', t('跟踪拉取请求'), clip(a.url), { note: t('会把这个拉取请求绑到这个会话') });
  if (id === 'pr_unbind') return mk('other', 'close', t('不再跟踪拉取请求'), clip(a.url), { note: t('会停止跟踪这个拉取请求') });
  if (id === 'pr_sync_base') return mk('execute', 'refresh', a.abort ? t('放弃合并') : t('同步基线分支'), clip(a.base), { note: t('会在本机把基线分支合并进当前分支，不推送') });
  if (id === 'pr_set_monitor') return mk('other', 'tune', a.auto_fix ? t('打开自动修复') : t('关闭自动修复'), '', a.auto_fix ? { note: t('允许 = 同意 CI 失败、有冲突或新评审时让 bridge 叫醒这个会话去修') } : {});
  if (id === 'pr_set_auto_merge') return mk('other', 'tune', a.enabled ? t('开启自动合并') : t('关闭自动合并'), clip(a.url), a.enabled ? { note: t('允许 = 同意检查与评审通过后直接合进基线分支') } : {});
  // 项目记忆
  if (id === 'project_memory_read') return mk('read', 'description', t('读取项目记忆'), clip(a.name));
  if (id === 'project_memory_write') return mk('other', 'edit_note', t('写入项目记忆'), clip(a.name));
  if (id === 'project_memory_delete') return mk('other', 'delete', t('删除项目记忆'), clip(a.name));
  // 插件工具 / 远程连接器（名字随插件和连接器变）
  if (id.startsWith('plugin_')) return mk('other', 'extension', t('调用插件工具'), clip(id.slice(7)), { note: t('会调用你装的插件提供的工具') });
  if (id.startsWith('ext_')) return mk('other', 'extension', t('调用远程连接器'), clip(id.slice(4)), { detail: clip(`${id.slice(4)} ${JSON.stringify(a)}`, 300), note: t('会经 bridge 调用第三方的远程服务') });
  // 子进程本地工具（媒体 / 界面 / 手机文件）
  const mMedia = /^media_(image|video|speech|music)$/.exec(id);
  if (mMedia) {
    const verb = { image: t('生成图片'), video: t('生成视频'), speech: t('合成语音'), music: t('生成音乐') }[mMedia[1]];
    return mk('other', 'extension', verb, clip(a.prompt || a.text));
  }
  if (id === 'ui_view') return mk('other', 'info', t('查看你的界面'), '');
  if (id === 'ui_open') return mk('other', 'open_in_new', t('带你去'), clip(a.file || a.folder || a.session || [a.page, a.module || a.section].filter(Boolean).join(' › ')));
  if (id === 'ui_toast') return mk('other', 'info', t('给你弹一条提示'), clip(a.text));
  if (id === 'phone_list') return mk('other', 'folder_open', t('查看手机文件夹'), clip(a.path));
  if (id === 'phone_read') return mk('other', 'description', t('读取手机文件'), clip(a.path));
  if (id === 'phone_scan') return mk('other', 'search', t('扫描手机大文件'), clip(a.path));
  if (id === 'phone_write') return mk('other', 'edit_note', t('写入手机文件'), clip(a.path), { note: t('会改动你手机上的文件') });
  if (id === 'phone_delete') return mk('other', 'delete', t('删除手机文件'), clip(a.path), { note: t('会删掉你手机上的文件，不能撤回') });
  return null;
}

export function classifyToolKind(tool = {}, { sessionCwd = '' } = {}) {
  const bridgeId = bridgeToolOf(tool);
  if (bridgeId) {
    const meta = bridgeToolMeta(bridgeId, tool.args && typeof tool.args === 'object' ? tool.args : {});
    if (meta) return meta;
  }
  const kind = String(tool.kind || '').toLowerCase();
  const name = String(tool.name || bridgeId && ('mcp_bridge_' + bridgeId) || '').toLowerCase();
  const locs = normalizeLocations(tool.locations);
  const loc = locs[0]?.path || String(tool.args?.Path || tool.args?.path || '').trim();
  const cmd = String(tool.command || tool.args?.CommandLine || tool.args?.command || '').trim();

  const mMedia = /(?:^|[_:/])media_(image|video|speech|music)$/.exec(name);
  if (mMedia) {
    const sub = mMedia[1];
    const verbMap = {
      image: t('生成图片'),
      video: t('生成视频'),
      speech: t('合成语音'),
      music: t('生成音乐'),
    };
    const promptSummary = String(tool.args?.prompt || tool.args?.text || tool.title || '').trim();
    return {
      category: 'other',
      icon: 'extension',
      verb: verbMap[sub] || t('媒体生成'),
      summary: promptSummary || verbMap[sub] || name,
    };
  }
  if (/(?:^|[_:/])ui_(view|open|toast)$/.test(name)) {
    const target = tool.args?.text || tool.args?.page || tool.args?.file || tool.args?.folder || '';
    return {
      category: 'other',
      icon: 'extension',
      verb: t('界面协同'),
      // 没有可说的对象时不拿「Run mcp_bridge_ui_view」这种工具代号凑数
      summary: target ? String(target) : (/^Run mcp_/i.test(String(tool.title || '')) ? '' : String(tool.title || name)),
    };
  }
  if (/(?:^|[_:/])phone_(list|read|write|scan|delete)$/.test(name)) {
    return {
      category: 'other',
      icon: 'extension',
      verb: t('手机文件'),
      summary: loc || String(tool.title || name),
    };
  }

  // agy 多代理与后台任务原生工具：给出清晰动词与对象，不再落进泛泛的「调用工具」
  if (name === 'invoke_subagent') {
    const type = String(tool.args?.TypeName || '').trim();
    const role = String(tool.args?.Role || '').trim();
    const brief = String(tool.args?.Prompt || '').replace(/\s+/g, ' ').trim();
    if (/image/i.test(type)) return { category: 'other', icon: 'image', verb: t('生成图片'), summary: clip(brief) };
    return { category: 'other', icon: 'smart_toy', verb: t('派出子代理'), summary: clip([role || type, brief].filter(Boolean).join(' · ')) };
  }
  if (name === 'define_subagent') {
    return { category: 'other', icon: 'smart_toy', verb: t('定义子代理'), summary: clip(tool.args?.Name || tool.args?.Description || '') };
  }
  if (name === 'send_message') {
    return { category: 'other', icon: 'north_east', verb: t('给子代理发消息'), summary: clip(tool.args?.Message || tool.args?.Recipient || '') };
  }
  if (name === 'manage_subagents') {
    const act = String(tool.args?.Action || '').toLowerCase();
    return {
      category: 'other',
      icon: 'smart_toy',
      verb: act === 'list' ? t('查看子代理状态') : t('停止子代理'),
      summary: clip(Array.isArray(tool.args?.ConversationIds) ? tool.args.ConversationIds.join(', ') : act),
    };
  }
  if (name === 'run_workflow') {
    return { category: 'other', icon: 'account_tree', verb: t('运行工作流'), summary: clip(tool.args?.Description || tool.args?.ScriptPath || '') };
  }
  if (name === 'swarm') {
    const act = String(tool.args?.action || '').toLowerCase();
    const actText = {
      title: t('命名协作群'),
      add: t('添加成员'),
      status: t('查看成员状态'),
      models: t('查询可用模型'),
      model: t('切换成员模型'),
      kill: t('移除成员'),
      channel: t('管理频道'),
    }[act] || act;
    const shardCount = Array.isArray(tool.args?.tasks) ? tool.args.tasks.length : (Number(tool.args?.n) > 1 ? Number(tool.args.n) : 0);
    const target = tool.args?.name
      ? (shardCount > 1 ? `${tool.args.name} ×${shardCount}` : String(tool.args.name))
      : (tool.args?.title || tool.args?.channel || '');
    return { category: 'other', icon: 'smart_toy', verb: t('多代理协作'), summary: clip([actText, target].filter(Boolean).join(' · ')) };
  }
  if (name === 'post_message') {
    const ch = tool.args?.channel && tool.args.channel !== 'main' ? `#${tool.args.channel}` : '';
    return {
      category: 'other',
      icon: 'north_east',
      verb: t('发布协作消息'),
      summary: clip([ch, tool.args?.text].filter(Boolean).join(' · ')),
    };
  }
  if (name === 'read_board') {
    const ch = tool.args?.channel ? `#${tool.args.channel}` : '';
    const since = Number(tool.args?.since) > 0 ? `#${tool.args.since}+` : '';
    return {
      category: 'other',
      icon: 'checklist',
      verb: t('读取协作消息板'),
      summary: clip([ch, since].filter(Boolean).join(' · ')),
    };
  }
  if (name === 'swarm_wait') {
    const since = Number(tool.args?.since) > 0 ? `#${tool.args.since}+` : '';
    return {
      category: 'other',
      icon: 'schedule',
      verb: t('等待协作动态'),
      summary: clip(since),
    };
  }
  if (name === 'schedule') {
    return { category: 'other', icon: 'schedule', verb: tc('agy', '定时任务'), summary: clip(tool.args?.Prompt || tool.args?.CronExpression || '') };
  }
  if (name === 'manage_task') {
    return { category: 'other', icon: 'checklist', verb: t('管理后台任务'), summary: clip([tool.args?.Action, tool.args?.TaskId].filter(Boolean).join(' · ')) };
  }

  if (kind === 'execute' || /run_command|bash|shell|terminal/.test(name)) {
    const cleanCmd = stripWorkspaceCdPrefix(cmd, sessionCwd);
    const cleanTitle = stripWorkspaceCdPrefix(String(tool.title || ''), sessionCwd);
    return {
      category: 'execute',
      icon: 'terminal',
      verb: t('执行命令'),
      summary: cleanCmd || cleanTitle || String(tool.title || name || t('终端命令')),
    };
  }
  if (kind === 'edit' || kind === 'write' || kind === 'delete' || /edit|write|patch|create_file|delete/.test(name)) {
    return {
      category: 'edit',
      icon: 'edit_note',
      verb: kind === 'delete' || /delete/.test(name) ? t('删除文件') : t('修改文件'),
      summary: loc ? shortPath(loc) : String(tool.title || name || t('文件变更')),
    };
  }
  if (kind === 'read' || /read|view/.test(name)) {
    return {
      category: 'read',
      icon: 'description',
      verb: t('读取文件'),
      summary: loc ? shortPath(loc) : String(tool.title || name || t('文件读取')),
    };
  }
  if (kind === 'search' || /search|grep|find|glob/.test(name)) {
    const q = tool.args?.query || tool.args?.Query || tool.args?.Pattern || tool.args?.pattern || '';
    return {
      category: 'search',
      icon: 'search',
      verb: t('搜索内容'),
      summary: q ? String(q) : (loc ? shortPath(loc) : String(tool.title || name || t('搜索'))),
    };
  }
  if (kind === 'fetch' || kind === 'browser' || /web|fetch|url|browser/.test(name)) {
    const u = tool.args?.url || tool.args?.Url || tool.args?.query || '';
    return {
      category: 'fetch',
      icon: 'globe',
      verb: t('网络检索'),
      summary: u ? String(u) : String(tool.title || name || t('网页抓取')),
    };
  }
  return {
    category: 'other',
    icon: name.startsWith('mcp') ? 'extension' : 'code_blocks',
    verb: t('调用工具'),
    summary: String(tool.title || tool.name || t('工具调用')),
  };
}

export function createEmptyAssistantTurn(extra = {}) {
  return {
    id: extra.id || ('ai-' + Math.random().toString(36).slice(2, 10)),
    role: 'assistant',
    status: 'streaming',
    blocks: [],
    md: '',
    thinking: '',
    toolsById: {},
    permissions: [],
    questions: [],
    attachments: [],
    error: '',
    usage: null,
    // 正等着回报的后台子代理：{ agents:[{ id, typeName, kind, startedAt }], at } 或 null
    background: null,
    startedAt: extra.startedAt || Date.now(),
    ...extra,
  };
}

function resetAssistantContentForAttach(turn) {
  turn.background = null;
  turn.blocks = [];
  turn.md = '';
  turn.thinking = '';
  turn.toolsById = {};
  turn.permissions = [];
  turn.questions = [];
  turn.attachments = [];
  turn.error = '';
  turn.status = 'streaming';
}

function normalizeToolRecord(src, tid, nowMs = null) {
  const st = src.status || 'in_progress';
  const done = st !== 'in_progress' && st !== 'pending';
  const startedAt = typeof src.startedAt === 'number' ? src.startedAt : nowMs;
  const completedAt = typeof src.completedAt === 'number'
    ? src.completedAt
    : (done && typeof nowMs === 'number' ? nowMs : null);
  const durationMs = typeof src.durationMs === 'number'
    ? src.durationMs
    : (startedAt !== null && completedAt !== null ? Math.max(0, completedAt - startedAt) : null);
  return {
    toolCallId: tid,
    name: src.name || '',
    kind: src.kind || 'other',
    status: st,
    approvalState: src.approvalState || null,
    title: src.title || '',
    args: src.args && typeof src.args === 'object' ? src.args : null,
    locations: normalizeLocations(src.locations),
    command: src.command || src.args?.CommandLine || src.args?.command || '',
    output: src.output || '',
    exitCode: src.exitCode ?? null,
    diffs: Array.isArray(src.diffs) ? [...src.diffs] : [],
    // 自带生图的成品（子代理回报时由 background 事件带来）：{ state, files }
    media: src.media || null,
    startedAt,
    completedAt,
    durationMs,
  };
}

// 将单条 SSE 事件合并进当前助手消息（兼顾服务端嵌套载荷 { type:'tool', tool:{...} } 与 attach 重放）
export function applyAgyStreamEvent(turn, ev) {
  if (!turn || !ev || typeof ev !== 'object') return turn;

  if (ev.type === 'attach') {
    resetAssistantContentForAttach(turn);
    // 中途接上在跑的一轮：计时从服务端这一轮的真实起点算，不从打开页面那刻算
    if (Number.isFinite(ev.elapsedMs) && ev.elapsedMs >= 0) turn.startedAt = Date.now() - ev.elapsedMs;
    return turn;
  }

  if (ev.type === 'thinking') {
    const delta = String(ev.text || '');
    if (!delta) return turn;
    turn.thinking += delta;
    const last = turn.blocks[turn.blocks.length - 1];
    if (last && last.type === 'thinking') last.text += delta;
    else turn.blocks.push({ type: 'thinking', text: delta });
    return turn;
  }

  if (ev.type === 'text') {
    const delta = String(ev.text || '');
    if (!delta) return turn;
    turn.md += delta;
    const last = turn.blocks[turn.blocks.length - 1];
    if (last && last.type === 'text') last.text += delta;
    else turn.blocks.push({ type: 'text', text: delta });
    return turn;
  }

  if (ev.type === 'tool' || ev.type === 'tool-update') {
    const nowMs = typeof ev.at === 'number' ? ev.at : Date.now();
    const src = (ev.tool && typeof ev.tool === 'object') ? ev.tool : ev;
    const tid = String(src.toolCallId || ev.toolCallId || ('tool-' + turn.blocks.length));
    let tool = turn.toolsById[tid];
    if (!tool) {
      turn.toolsById[tid] = normalizeToolRecord(src, tid, nowMs);
      // 必须从已挂载到 $state 树上的属性读回同一个 Proxy 再塞进 blocks：
      // Svelte 5 对同一裸对象赋到两处会各自生成独立信号表，改一处不会通知另一处。
      tool = turn.toolsById[tid];
      turn.blocks.push({ type: 'tool', toolCallId: tid, tool });
    } else {
      if (src.name) tool.name = src.name;
      if (src.kind && src.kind !== 'other') tool.kind = src.kind;
      if (src.status) {
        tool.status = src.status;
        if (src.status !== 'in_progress' && src.status !== 'pending' && tool.completedAt === null) {
          tool.completedAt = nowMs;
          if (typeof tool.startedAt === 'number') {
            tool.durationMs = Math.max(0, nowMs - tool.startedAt);
          }
        }
      }
      if (src.approvalState) tool.approvalState = src.approvalState;
      if (src.title) tool.title = src.title;
      if (src.args && typeof src.args === 'object' && Object.keys(src.args).length > 0) tool.args = src.args;
      const nextLocs = normalizeLocations(src.locations);
      if (nextLocs.length) tool.locations = nextLocs;
      const nextCmd = src.command || src.args?.CommandLine || src.args?.command || '';
      if (nextCmd) tool.command = nextCmd;
      if (src.output) tool.output = src.output;
      if (src.exitCode !== null && src.exitCode !== undefined) tool.exitCode = src.exitCode;
      if (Array.isArray(src.diffs) && src.diffs.length) tool.diffs = [...src.diffs];
    }
    return turn;
  }

  // 中途插话：用户在这一轮还在跑时又发的一条，摆在回答中间（重开历史时 agy 的回放里它本来就是夹在两段回答之间的用户消息）
  if (ev.type === 'steer') {
    const id = String(ev.id || '');
    if (id && turn.blocks.some((b) => b.type === 'steer' && b.id === id)) return turn;
    turn.blocks.push({
      type: 'steer',
      id: id || ('steer-' + turn.blocks.length),
      text: String(ev.text || ''),
      atts: Array.isArray(ev.atts) ? ev.atts : [],
    });
    return turn;
  }

  // 后台子代理（agy 自带的生图等）：这一轮说完话还不收尾，等它回报
  if (ev.type === 'background') {
    if (ev.state === 'waiting') {
      turn.background = { agents: Array.isArray(ev.agents) ? ev.agents : [], at: typeof ev.at === 'number' ? ev.at : Date.now() };
    } else if (ev.state === 'reported') {
      // 生图子代理的成品：记到派它出去的那次工具调用上（按先后顺序对），进度卡据此原地换成图
      const files = (Array.isArray(ev.files) ? ev.files : []).filter((f) => f && f.path);
      if (ev.from?.kind === 'image' && files.length) {
        const slot = turn.blocks.find((b) => b.type === 'tool' && b.tool?.name === 'invoke_subagent'
          && /image/i.test(String(b.tool.args?.TypeName || '')) && !b.tool.media);
        if (slot) slot.tool.media = { state: 'ready', files };
      }
    } else {
      turn.background = null;
      // 回报到了、接着往下说：和「请稍候」那一句分开成段，别粘成一句
      if (ev.state === 'resumed') {
        const last = turn.blocks[turn.blocks.length - 1];
        if (last && last.type === 'text' && last.text && !/\n\s*$/.test(last.text)) {
          last.text += '\n\n';
          turn.md += '\n\n';
        }
      }
    }
    return turn;
  }

  if (ev.type === 'diff') {
    const tid = String(ev.toolCallId || '');
    if (tid && turn.toolsById[tid] && Array.isArray(ev.diffs) && Array.isArray(turn.toolsById[tid].diffs) && ev.diffs.length) {
      turn.toolsById[tid].diffs = [...ev.diffs];
    }
    return turn;
  }

  if (ev.type === 'permission') {
    const reqId = String(ev.requestId || '');
    if (!reqId) return turn;
    const toolCall = (ev.toolCall && typeof ev.toolCall === 'object') ? ev.toolCall : ev;
    const tid = String(toolCall.toolCallId || ev.toolCallId || '');
    // 确保待审批的工具调用在 blocks 中已有对应工具卡，以便审批完成后结论就地合并到该工具卡上
    if (tid && !turn.toolsById[tid]) {
      turn.toolsById[tid] = normalizeToolRecord({
        toolCallId: tid,
        name: toolCall.name || ev.toolName || '',
        kind: toolCall.kind || ev.kind || 'execute',
        status: 'pending',
        title: toolCall.title || ev.title || '',
        command: toolCall.command || toolCall.args?.CommandLine || toolCall.args?.command || ev.command || '',
        locations: toolCall.locations || ev.locations,
        args: toolCall.args || null,
      }, tid, Date.now());
      turn.blocks.push({ type: 'tool', toolCallId: tid, tool: turn.toolsById[tid] });
    }
    const existing = turn.permissions.find((p) => p.requestId === reqId && p.status === 'pending');
    if (!existing) {
      turn.permissions.push({
        requestId: reqId,
        sessionId: ev.sessionId || '',
        toolCallId: tid,
        toolName: toolCall.name || ev.toolName || '',
        kind: toolCall.kind || ev.kind || 'execute',
        title: toolCall.title || ev.title || '',
        command: toolCall.command || toolCall.args?.CommandLine || toolCall.args?.command || ev.command || '',
        summary: String(toolCall.args?.toolSummary || toolCall.args?.description || '').trim(),
        bypassSandbox: Boolean(toolCall.args?.BypassSandbox),
        locations: normalizeLocations(toolCall.locations || ev.locations),
        args: toolCall.args || null,
        options: Array.isArray(ev.options) ? ev.options : [],
        status: 'pending',
        selectedOptionId: null,
      });
    }
    return turn;
  }

  if (ev.type === 'permission-resolved') {
    const hit = [...turn.permissions].reverse()
      .find((p) => p.requestId === String(ev.requestId || '') && p.status === 'pending')
      || turn.permissions.find((p) => p.requestId === String(ev.requestId || ''));
    const decision = resolveApprovalDecision(ev.outcome, ev.optionId);
    if (hit) {
      hit.status = ev.outcome === 'cancelled' ? 'cancelled' : 'resolved';
      hit.selectedOptionId = ev.optionId || null;
    }
    const tid = String(ev.toolCallId || hit?.toolCallId || '');
    // 自动放行（bridge 自家低风险工具 / 完全放行模式）不挂「已允许」——用户没做过选择，每步都标一下只是噪音
    if (tid && turn.toolsById[tid] && !ev.auto) {
      turn.toolsById[tid].approvalState = decision;
    }
    return turn;
  }

  if (ev.type === 'question') {
    const reqId = String(ev.requestId || '');
    if (!reqId) return turn;
    if (!turn.questions.some((q) => q.requestId === reqId && q.status === 'pending')) {
      turn.questions.push({
        requestId: reqId,
        sessionId: ev.sessionId || '',
        mode: ev.mode || 'form',
        message: ev.message || '',
        fields: Array.isArray(ev.fields) ? ev.fields : [],
        status: 'pending',
        action: null,
        answer: null,
      });
    }
    return turn;
  }

  if (ev.type === 'question-resolved') {
    const hit = [...turn.questions].reverse()
      .find((q) => q.requestId === String(ev.requestId || '') && q.status === 'pending')
      || turn.questions.find((q) => q.requestId === String(ev.requestId || ''));
    if (hit) {
      hit.status = ev.action === 'accept' ? 'answered' : 'cancelled';
      hit.action = ev.action || 'cancel';
      hit.answer = ev.content || null;
    }
    return turn;
  }

  if (ev.type === 'done' || ev.type === 'interrupted' || ev.type === 'error') {
    if (!turn.md && typeof ev.result === 'string' && ev.result) {
      turn.md = ev.result;
      turn.blocks.push({ type: 'text', text: ev.result });
    }
    if (Array.isArray(ev.attachments) && ev.attachments.length) {
      turn.attachments = ev.attachments;
    }
    if (ev.usage) turn.usage = ev.usage;
    turn.endedAt = Date.now();
    turn.background = null;
    if (Number.isFinite(ev.elapsedMs) && ev.elapsedMs >= 0) turn.elapsedMs = ev.elapsedMs;
    for (const p of turn.permissions) { if (p.status === 'pending') p.status = 'cancelled'; }
    for (const q of turn.questions) { if (q.status === 'pending') q.status = 'cancelled'; }

    if (ev.type === 'error') {
      turn.status = 'error';
      turn.error = String(ev.message || t('请求执行失败'));
    } else if (ev.type === 'interrupted') {
      const nowMs = typeof ev.at === 'number' ? ev.at : Date.now();
      const toolList = Object.values(turn.toolsById || {});
      const lastTool = toolList[toolList.length - 1];
      for (const tool of toolList) {
        const abortedTail = tool === lastTool && tool.status === 'failed' && !tool.output && tool.exitCode === null;
        if (tool && (tool.status === 'in_progress' || tool.status === 'pending' || abortedTail)) {
          tool.status = 'cancelled';
          tool.completedAt = nowMs;
          if (typeof tool.startedAt === 'number') {
            tool.durationMs = Math.max(0, nowMs - tool.startedAt);
          }
        }
      }
      turn.status = 'interrupted';
    } else {
      turn.status = 'done';
    }
  }

  return turn;
}

export function normalizeHistoryMessages(rawMessages = [], sessionId = '') {
  const out = [];
  for (let i = 0; i < rawMessages.length; i++) {
    const m = rawMessages[i];
    if (!m || typeof m !== 'object') continue;
    if (m.role === 'user') {
      // 非图片附件在服务端是拼进原文的一段路径前缀：拆出来还原成附件，气泡里只留用户写的话
      const split = splitAttachedPaths(String(m.text || ''));
      out.push({
        id: `hist-u-${i}`,
        role: 'user',
        text: split.text,
        images: Array.isArray(m.images) ? m.images : [],
        atts: [
          ...(Array.isArray(m.images) ? m.images : []).map((img, idx) => ({
            name: `image-${idx + 1}.png`,
            kind: 'image',
            url: img.data ? `data:${img.mimeType || 'image/png'};base64,${img.data}` : '',
          })),
          ...split.atts,
        ],
      });
    } else {
      const turnStatus = m.status === 'interrupted'
        ? 'interrupted'
        : (m.status === 'error' ? 'error' : 'done');
      const ai = createEmptyAssistantTurn({ id: `hist-a-${i}`, status: turnStatus, sessionId });
      ai.thinking = String(m.thinking || '');
      ai.md = String(m.text || '');
      if (Array.isArray(m.attachments) && m.attachments.length) {
        ai.attachments = m.attachments;
      }
      if (m.stats && typeof m.stats === 'object') ai.stats = m.stats;

      const histToolStatus = (rawSt) => {
        if (!rawSt || rawSt === 'in_progress' || rawSt === 'pending') {
          return turnStatus === 'interrupted' ? 'cancelled' : 'completed';
        }
        return rawSt;
      };

      if (Array.isArray(m.blocks) && m.blocks.length > 0) {
        for (const blk of m.blocks) {
          if (!blk || typeof blk !== 'object') continue;
          if (blk.type === 'thinking' && blk.text) {
            ai.blocks.push({ type: 'thinking', text: String(blk.text) });
          } else if (blk.type === 'text' && blk.text) {
            ai.blocks.push({ type: 'text', text: String(blk.text) });
          } else if (blk.type === 'tool' && blk.tool) {
            const tid = String(blk.tool.toolCallId || `hist-tool-${i}-${ai.blocks.length}`);
            ai.toolsById[tid] = normalizeToolRecord({ ...blk.tool, status: histToolStatus(blk.tool.status) }, tid);
            ai.blocks.push({ type: 'tool', toolCallId: tid, tool: ai.toolsById[tid] });
          }
        }
      } else {
        if (ai.thinking) ai.blocks.push({ type: 'thinking', text: ai.thinking });
        if (Array.isArray(m.tools)) {
          for (const rawTool of m.tools) {
            const tid = String(rawTool.toolCallId || `hist-tool-${i}-${ai.blocks.length}`);
            ai.toolsById[tid] = normalizeToolRecord({ ...rawTool, status: histToolStatus(rawTool.status) }, tid);
            ai.blocks.push({ type: 'tool', toolCallId: tid, tool: ai.toolsById[tid] });
          }
        }
        if (ai.md) ai.blocks.push({ type: 'text', text: ai.md });
      }
      out.push(ai);
    }
  }
  return out;
}
