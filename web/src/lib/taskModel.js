// 后台任务 / 工作流的模型层：把上游推来的进度快照、工具行、用量对象
// 归一成界面直接能用的形状（任务种类、状态、标题、阶段树、代理点阵）。
//
// 设计要点：
//   · 全部是常量或纯函数——不持有模块级可变状态、不缓存、不碰 DOM、不做 I/O，
//     唯一读时钟的地方是 mergeProgress 的 now 缺省值，便于在服务端测试里直接跑。
//   · 绝不改入参：需要“改”一条记录时产出浅拷贝；没动过的记录原引用透传，
//     settleProgress 在一条都没改时直接交回入参数组，调用方据此跳过重渲染。
//   · “缺失”默认只指 undefined；null / '' / 0 都当作有值，各函数另有说明的除外。
//   · 快照里一条记录的身份是 (type, index)；代理记录额外由本模块补 startedAt。

/** 正在跑的代理超过这么久没有心跳，就显示为“卡住”。 */
export const STALL_MS = 90_000;

/** 只读的全零计数模板；需要计数对象时一律展开成新对象再改。 */
export const EMPTY_COUNTS = Object.freeze({ done: 0, running: 0, stalled: 0, error: 0, pending: 0, total: 0 });

const AGENT = 'workflow_agent';
const PHASE = 'workflow_phase';

// 任务类型里代表“子代理”的那几种，toolTaskKind 与 taskNoun 共用。
// 用正则而不是 Set：test() 会先把参数转成字符串，非字符串的 taskType 也按字符串口径判断
const AGENT_TASK_TYPE_RE = /^(?:local_agent|remote_agent|in_process_teammate)$/;

// ───────────────────────── 用量 ─────────────────────────

// 不同来源的用量对象键名各异，按优先级逐个试，取第一个有限数
const USAGE_KEYS = {
  tokens: ['tokens', 'total_tokens', 'totalTokens', 'subagent_tokens'],
  toolUses: ['toolUses', 'tool_uses'],
  ms: ['ms', 'duration_ms', 'durationMs'],
};

function pickFinite(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
}

/** 用量对象 → { tokens, toolUses, ms }；不是非空对象时返回 null。 */
export function usageOf(u) {
  if (!u || typeof u !== 'object') return null;
  return {
    tokens: pickFinite(u, USAGE_KEYS.tokens),
    toolUses: pickFinite(u, USAGE_KEYS.toolUses),
    ms: pickFinite(u, USAGE_KEYS.ms),
  };
}

// ───────────────────────── 任务状态 ─────────────────────────

const FINAL_STATUSES = new Set(['running', 'completed', 'failed', 'stopped']);
const LIVE_STATUSES = new Set(['running', 'pending', 'paused']);

/** 任务结束事件的状态 → running / completed / failed / stopped 四者之一。 */
export function normTaskStatus(s) {
  if (FINAL_STATUSES.has(s)) return s;
  if (s === 'killed') return 'stopped';
  return 'completed';
}

/** 界面口径的“还在跑”：running / pending / paused（大小写敏感）。 */
export function taskRunning(status) {
  return LIVE_STATUSES.has(status);
}

// ───────────────────────── 进度快照合并 ─────────────────────────

// 模板字符串做 ToString：type / index 是 Symbol 时抛 TypeError，不做特殊处理
const entryKey = (e) => `${e.type}:${e.index}`;

// 给一条新到的记录补开工时间；old 是表里同键的现有记录（可能没有）
function stampStart(e, old, now) {
  if (e.type !== AGENT || e.startedAt !== undefined) return e;
  if (old && old.type === AGENT && old.startedAt !== undefined) return { ...e, startedAt: old.startedAt };
  if (e.state === 'start') return e; // 还在排队，不算开工
  return { ...e, startedAt: now };
}

/**
 * 把新快照 incoming 增量合并进 prev，并给代理记录补 startedAt。
 * prev 为空时逐条处理后直接返回（不去重）；否则按 (type,index) 合并：
 * 已有键原位覆盖、新键追加到末尾、incoming 里没有的旧记录保留。
 */
export function mergeProgress(prev, incoming, now = Date.now()) {
  const fresh = Array.isArray(incoming) ? incoming.filter(Boolean) : [];
  if (!prev || !prev.length) return fresh.map((e) => stampStart(e, undefined, now));

  const table = new Map(); // Map 的覆盖写不改变键的插入位置，正好满足“原位覆盖”
  for (const e of prev) {  // 按迭代协议遍历：非数组的类数组 prev 会抛 TypeError
    if (e) table.set(entryKey(e), e);
  }
  for (const e of fresh) {
    const k = entryKey(e);
    table.set(k, stampStart(e, table.get(k), now));
  }
  return [...table.values()];
}

const STOPPED_REASON = 'Stopped before completion';
const ENDED_REASON = 'Workflow ended before completion';

/**
 * 工作流已结束：把仍标着 progress 的代理改记为 error。
 * 一条都没改时返回原数组本身；不判断 taskStatus 是否终态。
 */
export function settleProgress(list, taskStatus) {
  if (!Array.isArray(list) || list.length === 0) return list || [];
  let touched = false;
  const out = list.map((e) => {
    if (!e || e.type !== AGENT || e.state !== 'progress') return e;
    touched = true;
    const error = e.error != null ? e.error : (taskStatus === 'stopped' ? STOPPED_REASON : ENDED_REASON);
    return { ...e, state: 'error', error };
  });
  return touched ? out : list;
}

// ───────────────────────── 代理显示态 ─────────────────────────

// opts 为真值时取它的字段，否则取 opts 本身（缺省即 undefined，null 即 null）
const optField = (opts, key) => (opts ? opts[key] : opts);

// 从 opts 里取当前时刻与卡死阈值。
// 注意 opts 为 null 时当前时刻是 null（不是 undefined），会按 0 参与减法
function clockOf(opts) {
  return { now: optField(opts, 'now'), stallMs: optField(opts, 'stallMs') ?? STALL_MS };
}

function stateWith(entry, now, stallMs) {
  if (!entry) return 'pending';
  const s = entry.state;
  if (s === 'done' || s === 'error') return s;
  if (s !== 'progress') return 'pending';
  const last = entry.lastProgressAt;
  // last 为 null 时按数值参与减法（等于 0）；只有 undefined 才算没有心跳
  if (now !== undefined && last !== undefined && now - last > stallMs) return 'stalled';
  return 'running';
}

/** 单个代理 → done / error / running / stalled / pending；只看 state，不看 type。 */
export function agentState(entry, opts) {
  const { now, stallMs } = clockOf(opts);
  return stateWith(entry, now, stallMs);
}

/** 点阵用的扁平列表：只取代理记录，映射为 { label, state }。 */
export function agentDotStates(list, opts) {
  if (!Array.isArray(list)) return [];
  const { now, stallMs } = clockOf(opts);
  return list
    .filter((e) => e && e.type === AGENT)
    .map((e) => ({ label: e.label, state: stateWith(e, now, stallMs) }));
}

// ───────────────────────── 阶段树 ─────────────────────────

function countInto(c, state) {
  c.total += 1;
  if (state === 'stalled') {
    // 卡住的代理仍算在跑，另外单独记一笔
    c.running += 1;
    c.stalled += 1;
  } else {
    c[state] += 1;
  }
}

function phaseStatus(c, settled) {
  if (c.error > 0) return 'error';
  if (c.running > 0) return settled ? 'done' : 'running';
  if (c.pending === c.total) return 'pending'; // 含一个代理都没有
  if (c.done === c.total || settled) return 'done';
  return 'running';
}

/**
 * 快照 → { counts, phases, totalTokens }；空或非数组返回 undefined。
 * 阶段按 index 升序；没有阶段信息的代理归入“当前阶段”（最近一条阶段记录），
 * 连当前阶段都没有时归入 0 号阶段。opts: { now?, stallMs?, settled? }。
 */
export function deriveWorkflow(list, opts) {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const { now, stallMs } = clockOf(opts);
  const settled = optField(opts, 'settled') ?? false;

  const byIndex = new Map();
  const phases = [];
  const counts = { ...EMPTY_COUNTS };
  let totalTokens = 0;

  // 取得或新建阶段。占位标题（"Phase " 开头）遇到真实候选标题时让位。
  // 现有标题直接调 startsWith：标题不是字符串（如数字）时会抛 TypeError
  const phaseFor = (index, title) => {
    const found = byIndex.get(index);
    if (found) {
      if (title && found.title.startsWith('Phase ')) found.title = title;
      return found;
    }
    const ph = {
      index,
      title: title ?? `Phase ${index + 1}`,
      agents: [],
      counts: { ...EMPTY_COUNTS },
      status: 'pending',
      totalTokens: 0,
      maxDurationMs: undefined,
    };
    byIndex.set(index, ph);
    phases.push(ph);
    return ph;
  };

  let current;
  for (const e of list) {
    if (!e) continue;
    if (e.type === PHASE) {
      current = phaseFor(e.index, e.title);
      continue;
    }
    if (e.type !== AGENT) continue;

    let ph;
    if (e.phaseIndex !== undefined) ph = phaseFor(e.phaseIndex, e.phaseTitle);
    else if (current) ph = current;
    else ph = phaseFor(0, undefined);

    ph.agents.push(e);
    const state = stateWith(e, now, stallMs);
    countInto(ph.counts, state);
    countInto(counts, state);
    if (e.tokens) {
      ph.totalTokens += e.tokens;
      totalTokens += e.tokens;
    }
    if (e.durationMs !== undefined) ph.maxDurationMs = Math.max(ph.maxDurationMs ?? 0, e.durationMs);
  }

  for (const ph of phases) ph.status = phaseStatus(ph.counts, settled);
  phases.sort((a, b) => a.index - b.index);
  return { counts, phases, totalTokens };
}

// ───────────────────────── 工作流名 ─────────────────────────

// 只在脚本开头这么长的范围里找元信息声明
const META_SCAN_LIMIT = 4096;
// meta = { … name: '名字' … }：name 必须出现在第一个 } 之前；两个关键字前面都不能紧贴标识符字符
const META_NAME_RE = /(?<![A-Za-z0-9_])meta\s*=\s*\{[^}]*?(?<![A-Za-z0-9_])name\s*:\s*['"]([^'"]+)['"]/;

/** 工作流工具入参 → 工作流名：name → 脚本元信息 → 脚本文件名（去扩展名）。 */
export function workflowNameFromInput(input) {
  if (!input || typeof input !== 'object') return undefined;
  if (typeof input.name === 'string' && input.name) return input.name;
  if (typeof input.script === 'string') {
    const m = META_NAME_RE.exec(input.script.slice(0, META_SCAN_LIMIT));
    if (m) return m[1];
  }
  const p = input.scriptPath;
  if (typeof p === 'string' && p) {
    const base = p.split(/[\\/]/).pop();
    if (!base) return undefined;
    return base.replace(/\.[^.]+$/, ''); // 点后至少一个非点字符才算扩展名
  }
  return undefined;
}

// ───────────────────────── 失败原因 ─────────────────────────

// Workflow "名字" 动词[: 原因 | .]；名字贪婪匹配到最后一个能让整句成立的引号
const SUMMARY_TEMPLATE_RE = /^(?:Workflow|Dynamic workflow) "[\s\S]*" (?:completed|failed|stopped|was killed)(?::([\s\S]+)|\.?\s*)$/;

const capFirst = (s) => (s.length ? s[0].toUpperCase() + s.slice(1) : s);

/** 任务结束摘要 → 失败 / 停止原因；与描述相同或模板句不带原因时返回 undefined。 */
export function reasonFromSummary(summary, description) {
  if (!summary || summary === description) return undefined;
  // 调 summary 自己的 match：不是字符串（也没有 match 方法）时抛 TypeError，不做转换
  const m = summary.match(SUMMARY_TEMPLATE_RE);
  if (!m) return capFirst(summary);
  const reason = m[1] === undefined ? '' : m[1].trim();
  return reason ? capFirst(reason) : undefined;
}

// ───────────────────────── 工具行 ─────────────────────────

/** 工具行 → 'workflow' / 'agent' / 'task' / ''。 */
export function toolTaskKind(tool) {
  if (!tool) return '';
  const tt = tool.task ? tool.task.taskType : '';
  if (tool.name === 'Workflow' || tt === 'local_workflow') return 'workflow';
  if (tool.name === 'Agent' || tool.name === 'Task' || AGENT_TASK_TYPE_RE.test(tt)) return 'agent';
  return tool.task ? 'task' : '';
}

/** 工具行 → running / completed / failed / stopped / ''；任务记录说不清时按工具行推断。 */
export function toolTaskStatus(tool) {
  if (!tool) return '';
  const st = tool.task ? tool.task.status : '';
  if (taskRunning(st)) return 'running';
  if (st === 'completed' || st === 'failed' || st === 'stopped') return st;
  if (tool.status === 'running') return 'running';
  if (tool.status === 'error') return tool.interrupted ? 'stopped' : 'failed';
  return 'completed';
}

/** 工具行 → 显示标题，按种类走不同的回落链。 */
export function toolTaskTitle(tool) {
  if (!tool) return '';
  const task = tool.task || {};
  if (task.name || task.workflowName) return task.name || task.workflowName;
  const kind = toolTaskKind(tool);
  if (kind === 'workflow') {
    return workflowNameFromInput(tool.input) || task.description || tool.summary || 'Workflow';
  }
  return task.description || tool.summary || (kind === 'agent' ? 'Agent' : 'Task');
}

// ───────────────────────── 名词 ─────────────────────────

/** 任务类型 → 英文名词（shell / agent / workflow / monitor / task），plural 为真加 s。 */
export function taskNoun(taskType, plural = false) {
  const t = taskType ? String(taskType) : '';
  let noun = 'task';
  if (t === 'local_bash') noun = 'shell';
  else if (AGENT_TASK_TYPE_RE.test(t)) noun = 'agent';
  else if (t === 'local_workflow') noun = 'workflow';
  else if (t.startsWith('monitor')) noun = 'monitor';
  return plural ? `${noun}s` : noun;
}
