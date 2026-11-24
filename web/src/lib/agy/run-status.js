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

// ── 这一轮说完了、后台还在跑 ──
// agy 把命令转入后台（run_command）、排了定时任务（schedule 的 Cron / Timer）或派出子代理 / 团队后，这一轮就 end_turn 了，
// 回报或任务结束时它会自己醒来接着干。以前脚注此时和真正结束一模一样（维护者 11-23：「后台任务挂起怎么还是不显示」）。
// 数据来自子代理树（/api/agy/subagents）：parentTasks = 主会话自己挂着的后台任务，counts / agents = 子代理。

// 15 分钟没有任何新输出 / 新步骤就提示「没有动静」
export const BG_STALL_MS = 15 * 60 * 1000;

/** Cron 计划 → 人话（只认常见的几种，其余原样） */
export function cronLabel(spec) {
  const p = String(spec || '').trim().split(/\s+/);
  if (p.length === 5) {
    const rest = (from) => p.slice(from).every((x) => x === '*');
    if (p[0] === '*' && rest(1)) return t('每分钟');
    let m = /^\*\/(\d+)$/.exec(p[0]);
    if (m && rest(1)) return t('每 {n} 分钟', { n: m[1] });
    m = /^\*\/(\d+)$/.exec(p[1]);
    if (/^\d+$/.test(p[0]) && p[1] === '*' && rest(2)) return t('每小时');
    if (/^\d+$/.test(p[0]) && m && rest(2)) return t('每 {n} 小时', { n: m[1] });
  }
  return String(spec || '').trim();
}

/** Timer 的时长（10m / 600s / 1h30m）→ 毫秒；认不出返回 0 */
export function timerMs(spec) {
  const re = /(\d+(?:\.\d+)?)\s*(h(?:ours?|rs?)?|m(?:in(?:utes?)?)?|s(?:ec(?:onds?)?)?)(?![a-z])/gi;
  let ms = 0;
  let m;
  while ((m = re.exec(String(spec || '')))) {
    const u = m[2][0].toLowerCase();
    ms += Number(m[1]) * (u === 'h' ? 3600000 : u === 'm' ? 60000 : 1000);
  }
  return ms;
}

const isActiveAgent = (a) => a && (a.status === 'running' || a.status === 'waiting' || (a.subtreeCounts?.active || 0) > 0);

/**
 * 后台还在跑什么：null（没有）或
 *   { kind: 'team' | 'task' | 'sched', label, detail, since, stallMs, tail }
 * label 是主语（流光字），detail 是一句说明，since 用来走「已等 / 已跑」的秒表，stallMs>0 表示多久没动静。
 */
export function computeBgWait(tree, now = Date.now()) {
  if (!tree || !tree.hasActive) return null;
  const counts = tree.counts || {};
  const tasks = (Array.isArray(tree.parentTasks) ? tree.parentTasks : []).filter((x) => x && x.status === 'running');
  const swarmActive = Boolean(tree.swarm?.hasActive);

  // 子代理 / 团队 / Swarm：在等它们回报
  if ((Number(counts.active) || 0) > 0 || swarmActive) {
    const working = (Number(counts.running) || 0) + (Number(tree.swarm?.workingCount) || 0);
    const starts = (Array.isArray(tree.agents) ? tree.agents : []).filter(isActiveAgent).map((a) => a.spawnedAt).filter((v) => v > 0);
    const last = Number(tree.updatedAt) || 0;
    return {
      kind: 'team',
      label: t('等子代理回报'),
      detail: working > 0 ? t('{n} 个在干活', { n: working }) : '',
      since: starts.length ? Math.min(...starts) : 0,
      stallMs: last > 0 && now - last > BG_STALL_MS ? now - last : 0,
      tail: '',
    };
  }

  // 主会话转入后台的命令
  const cmds = tasks.filter((x) => x.kind !== 'cron' && x.kind !== 'timer');
  if (cmds.length) {
    const since = Math.min(...cmds.map((x) => Number(x.at) || now));
    const lastOut = Math.max(...cmds.map((x) => Number(x.logAt) || Number(x.at) || 0));
    return {
      kind: 'task',
      label: t('后台任务在跑'),
      detail: cmds.length === 1 ? String(cmds[0].title || '') : t('{n} 个任务', { n: cmds.length }),
      since,
      stallMs: lastOut > 0 && now - lastOut > BG_STALL_MS ? now - lastOut : 0,
      tail: cmds.length === 1 ? String(cmds[0].logTail || '') : '',
    };
  }

  // 只剩定时任务：到点 agy 会被叫醒
  if (tasks.length) {
    const timers = tasks
      .filter((x) => x.kind === 'timer')
      .map((x) => ({ x, due: (Number(x.at) || 0) + timerMs(x.schedule) }))
      .filter((v) => v.due > 0)
      .sort((a, b) => a.due - b.due);
    let detail;
    if (timers.length) {
      const left = timers[0].due - now;
      detail = left > 1000 ? t('约 {d}后', { d: fmtLeft(left) }) : t('马上就到');
    } else {
      detail = cronLabel(tasks[0].schedule);
    }
    return { kind: 'sched', label: t('等定时唤醒'), detail, since: 0, stallMs: 0, tail: '' };
  }

  // 树说在跑、却既没有子代理也没有后台任务：主会话自己有步骤停在 RUNNING（真在后台醒来时消息会直接变成进行中，
  // 不靠这里；剩下的多是随旧进程死掉的残留），不显示，免得已结束的会话永远挂着「在跑」
  return null;
}

export function fmtLeft(ms) {
  const m = Math.ceil(ms / 60000);
  if (m < 60) return t('{n} 分钟', { n: m });
  const h = Math.floor(m / 60);
  return m % 60 ? t('{h} 小时 {m} 分', { h, m: m % 60 }) : t('{h} 小时', { h });
}

/** 时长：一小时以内 12m05s，以上 7h38m（脚注里那串 458m45s 太难读） */
export function fmtSpan(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}
