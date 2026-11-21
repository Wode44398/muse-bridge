// agy 消息底部运行状态栏：照 Claude 分页 turn-foot 的语法「时长 · tokens · 状态」，
// 跑的时候第三段是「正在做什么」（流光字），跑完后只留时长与 tokens（仅停止 / 出错保留简短提示）；左侧动效标记的状态也从这里算。
// 全是纯函数，组件每 200ms 取一次；换文案 / 换标记各自有最短停留，免得 20ms 的读文件把状态闪成一帧。
import { classifyToolKind } from './logic.js';
import { toolIsRunning } from './step-summary.js';
import { t } from '../i18n.js';

export const TEXT_HOLD_MS = 650;
// 跨态直接液态融变（~0.2–0.36s），留 850ms 最短停留避免 20ms 读文件把形态闪成一帧
export const MARK_HOLD_MS = 850;

const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';

function toolTarget(tool) {
  const d = Array.isArray(tool?.diffs) && tool.diffs[0]?.path;
  const loc = Array.isArray(tool?.locations) && tool.locations[0];
  const p = d || (typeof loc === 'string' ? loc : loc?.path) || tool?.args?.Path || tool?.args?.path || tool?.args?.file_path || '';
  return baseName(p);
}

// 跑着的工具 → [标记状态, 文案]
function doingForTool(tool, sessionCwd) {
  const meta = classifyToolKind(tool, { sessionCwd });
  const kind = String(tool.kind || '').toLowerCase();
  const name = String(tool.name || '').toLowerCase();
  const target = toolTarget(tool);
  switch (meta.category) {
    case 'execute': return ['executing', t('正在执行命令…')];
    case 'edit':
      if (kind === 'delete' || /delete/.test(name)) return ['editing', target ? t('正在删除 {name}…', { name: target }) : t('正在删除文件…')];
      return ['editing', target ? t('正在修改 {name}…', { name: target }) : t('正在修改文件…')];
    case 'read': return ['searching', target ? t('正在读取 {name}…', { name: target }) : t('正在读取文件…')];
    case 'search': return ['searching', t('正在搜索…')];
    case 'fetch': return ['searching', t('正在检索网页…')];
  }
  return ['orbiting', t('正在{verb}…', { verb: meta.verb })];
}

function lastToolOf(msg) {
  const blocks = Array.isArray(msg?.blocks) ? msg.blocks : [];
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i]?.type === 'tool') return msg.toolsById?.[blocks[i].toolCallId] || blocks[i].tool || null;
  }
  return null;
}

/**
 * 进行中的这一轮现在在干什么：{ mark, text }
 * mark 取 antigravity-logo 的状态名（thinking / writing / searching / editing / executing / orbiting / approval / waiting）
 */
export function computeDoing(msg, { sessionCwd = '', reconnecting = false } = {}) {
  if (reconnecting) return { mark: 'waiting', text: t('重连中…') };
  if (Array.isArray(msg?.permissions) && msg.permissions.some((p) => p.status === 'pending')) {
    return { mark: 'approval', text: t('等待你批准') };
  }
  if (Array.isArray(msg?.questions) && msg.questions.some((q) => q.status === 'pending')) {
    return { mark: 'approval', text: t('需要你的回答') };
  }
  if (msg?.background) {
    const image = (msg.background.agents || []).some((a) => a.kind === 'image');
    return { mark: 'orbiting', text: image ? t('正在生成图片…') : t('等后台子代理回报…') };
  }
  const running = Object.values(msg?.toolsById || {}).filter(toolIsRunning);
  if (running.length > 1) return { mark: 'orbiting', text: t('正在并行处理 {n} 项操作…', { n: running.length }) };
  if (running.length === 1) {
    const [mark, text] = doingForTool(running[0], sessionCwd);
    return { mark, text };
  }
  const blocks = Array.isArray(msg?.blocks) ? msg.blocks : [];
  const last = blocks[blocks.length - 1];
  if (!last) return { mark: 'waiting', text: t('等待 Antigravity…') };
  if (last.type === 'thinking') return { mark: 'thinking', text: t('思考中…') };
  if (last.type === 'text') return { mark: 'writing', text: t('正在回复…') };
  // 上一步工具刚回完、模型在想下一步：标记留在思考形态，比来回归拱安静
  return { mark: 'thinking', text: t('正在规划下一步…') };
}

/** 跑完后的第三段状态提示：正常完成不重复列步骤汇总（正文已有步骤卡与代理卡），仅停止 / 出错时提示 */
export function computeDid(msg) {
  if (msg?.status === 'interrupted') return t('已停止');
  if (msg?.status === 'error') return t('出错了');
  return '';
}

// 流式过程中 agy 不给 token 数（只在一轮结束时随 prompt 响应给 usage），先按已流出的字估：
// 汉字等宽字符约 1 token / 字，其余约 4 字符 / token。结束后换成真值（输出 + 思考）。
function estimateTokens(str) {
  const s = String(str || '');
  if (!s) return 0;
  const wide = (s.match(/[⺀-鿿가-힯豈-﫿＀-￯]/g) || []).length;
  return Math.round(wide + (s.length - wide) / 4);
}

export function turnTokens(msg) {
  const u = msg?.usage || msg?.stats?.usage;
  if (u && (u.outputTokens || u.thoughtTokens)) return (Number(u.outputTokens) || 0) + (Number(u.thoughtTokens) || 0);
  if (Number.isFinite(msg?.stats?.tokens) && msg.stats.tokens > 0) return msg.stats.tokens;
  // 跑完了却没有真值（老历史、别处跑的轮次）：不拿估算冒充，不显示
  if (msg?.status !== 'streaming') return 0;
  let n = 0;
  for (const b of Array.isArray(msg?.blocks) ? msg.blocks : []) {
    if (b?.type === 'text' || b?.type === 'thinking') n += estimateTokens(b.text);
    else if (b?.type === 'tool') {
      const tool = msg.toolsById?.[b.toolCallId] || b.tool;
      if (tool?.args) n += estimateTokens(JSON.stringify(tool.args));
    }
  }
  return n;
}

/** 这一轮用时（毫秒）；跑完且既没有服务端记的时长、也没有本地起止时间（老历史）时返回 null */
export function turnElapsed(msg, now = Date.now()) {
  if (msg?.status === 'streaming') return Math.max(0, now - (msg.startedAt || now));
  if (Number.isFinite(msg?.elapsedMs)) return msg.elapsedMs;
  if (Number.isFinite(msg?.stats?.ms)) return msg.stats.ms;
  if (msg?.endedAt && msg?.startedAt && msg.endedAt >= msg.startedAt) return msg.endedAt - msg.startedAt;
  return null;
}
