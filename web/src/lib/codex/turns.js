// Codex 分页「一轮」的视图模型与事件归约（纯函数，不碰 DOM / Svelte / 文案）。
// 一轮 = 你的话 + 工作记录（rows）+ 回答。实时的 SSE 事件（契约见《Codex 翻修方案》第十五节）和
// 打开旧线程时 thread/turns 给的 ThreadItem，归到同一种「工作记录行」，界面只认行，不认事件来源。
//
// 行的种类（row.kind）：
//   explore  查看了几个文件：读文件 / 列目录 / 搜代码的命令合并成一行（Codex 自己解析好的 commandActions）
//   cmd      运行了一条命令：{ cmd, cwd, status:'run'|'ok'|'fail'|'deny'|'wait', exit, ms, out }
//   edit     编辑了文件：{ files:[{ path, type, a, d, diff }], status }
//   web      搜索了网页：{ query }
//   tool     bridge 工具 / 动态工具：{ ns, tool, args, status, ok, text, ms, images }
//   mcp      MCP 工具：{ server, tool, status, err }
//   agent    派出子智能体：{ tool, prompt, status, threads }
//   say      进度说明（commentary）：{ text }
//   steer    你插的话：{ text }
//   compact  已压缩上下文
//   image    看了 / 生成了一张图：{ path, gen }
//   review   审查模式进出：{ phase, text }
//   note     提醒：{ tone:'info'|'warn'|'err', code, data }（换模型、警告、换号、额度、自动审查）

let seq = 0;
const key = () => 'k' + (++seq).toString(36) + Math.random().toString(36).slice(2, 6);

export function newTurn({ text = '', attachments = [], live = false, id = null } = {}) {
  return {
    key: key(),
    id,
    user: { text, attachments },
    rows: [],
    thinking: '',
    answer: '',
    shown: live ? 0 : -1,       // 呈现到第几个字（-1 = 全部；实时轮由宿主按帧放字）
    status: live ? 'think' : 'done',   // think | exec | ask | write | done | error | stopped
    startedAt: live ? Date.now() : null,
    endedAt: null,
    plan: null,                 // { explanation, steps:[{ step, status }] }
    planText: '',               // 计划模式出的计划正文
    diff: null,                 // { files:[{ path, a, d }], a, d }
    error: null,                // { message, limit, status }
    attachments: [],            // 这一轮做出来的文件
    live,
    adopted: false,
  };
}

/* ---------------- 命令 ---------------- */

const SHELL_WRAP = [
  // "C:\...\powershell.exe" -NoProfile -Command "npm test"   /  pwsh -c '...'
  /^\s*"?[^"\s]*?(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-(?:NoProfile|NoLogo|NonInteractive|ExecutionPolicy\s+\S+|OutputFormat\s+\S+)\s+)*-(?:Command|c)\s+([\s\S]+)$/i,
  // /bin/bash -lc '...'  /  bash -c "..."  /  sh -c ...  /  zsh -lc
  /^\s*"?(?:\/usr)?(?:\/bin\/)?(?:ba|z)?sh"?\s+-l?c\s+([\s\S]+)$/i,
  // cmd.exe /c ...
  /^\s*"?[^"\s]*?cmd(?:\.exe)?"?\s+\/[cC]\s+([\s\S]+)$/,
];

const unquote = (s) => {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    const inner = t.slice(1, -1);
    return t[0] === "'" ? inner.replace(/'\\''/g, "'").replace(/''/g, "'") : inner.replace(/\\"/g, '"').replace(/`"/g, '"');
  }
  return t;
};

/** 去掉 powershell / bash / cmd 那层包装，只留你真正要跑的那一句（审批卡、记录里都显示这个）。 */
export function displayCommand(cmd) {
  let s = Array.isArray(cmd) ? cmd.join(' ') : String(cmd ?? '');
  for (let i = 0; i < 2; i++) {
    let hit = false;
    for (const re of SHELL_WRAP) {
      const m = re.exec(s);
      if (m) { s = unquote(m[1]); hit = true; break; }
    }
    if (!hit) break;
  }
  return s.trim();
}

const EXPLORE = new Set(['read', 'listFiles', 'search']);
const isExplore = (actions) => Array.isArray(actions) && actions.length > 0 && actions.every((a) => EXPLORE.has(a?.type));

const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

function exploreItems(actions) {
  return actions.map((a) => (
    a.type === 'read' ? { type: 'read', name: a.name || baseName(a.path), path: a.path || '' }
      : a.type === 'listFiles' ? { type: 'list', path: a.path || '' }
        : { type: 'search', query: a.query || '', path: a.path || '' }
  ));
}

const cmdStatus = (s, exit) => {
  if (s === 'inProgress' || s === 'in_progress' || s === 'running' || !s) return 'run';
  if (s === 'declined') return 'deny';
  if (s === 'failed') return 'fail';
  if (s === 'completed') return exit != null && exit !== 0 ? 'fail' : 'ok';
  return 'run';
};

/* ---------------- 改动 ---------------- */

/** 一段 diff 的增删行数。新建 / 删除文件时 Codex 给的可能是整份内容而不是 unified diff。 */
export function diffStat(diff, type = 'update') {
  const s = String(diff || '');
  if (!s) return { a: 0, d: 0 };
  const lines = s.split(/\r?\n/);
  const unified = /^@@/m.test(s) || /^(---|\+\+\+) /m.test(s);
  if (!unified) {
    const n = lines.length - (lines.at(-1) === '' ? 1 : 0);
    return type === 'delete' ? { a: 0, d: n } : { a: n, d: 0 };
  }
  let a = 0, d = 0;
  for (const l of lines) {
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l[0] === '+') a++;
    else if (l[0] === '-') d++;
  }
  return { a, d };
}

const changeType = (k) => (typeof k === 'string' ? k : k?.type) || 'update';

function editFiles(changes) {
  return (Array.isArray(changes) ? changes : []).map((c) => {
    const type = changeType(c.kind);
    const { a, d } = diffStat(c.diff, type);
    return { path: c.path || '', name: baseName(c.path), type, a, d, diff: c.diff || '', move: c.kind?.move_path || c.kind?.movePath || '' };
  });
}

/** 整轮 diff（turn/diff/updated）→ 按文件的增删统计。 */
export function parseTurnDiff(diff) {
  const files = [];
  let cur = null;
  for (const l of String(diff || '').split(/\r?\n/)) {
    const m = /^diff --git a\/(.+?) b\/(.+)$/.exec(l);
    if (m) { cur = { path: m[2], name: baseName(m[2]), a: 0, d: 0 }; files.push(cur); continue; }
    if (!cur) continue;
    if (l.startsWith('+++') || l.startsWith('---')) continue;
    if (l[0] === '+') cur.a++;
    else if (l[0] === '-') cur.d++;
  }
  return { files, a: files.reduce((s, f) => s + f.a, 0), d: files.reduce((s, f) => s + f.d, 0) };
}

/* ---------------- 行 ---------------- */

const lastRow = (turn) => turn.rows[turn.rows.length - 1];

function upsert(turn, row) {
  const i = turn.rows.findIndex((r) => r.id === row.id || r.ids?.includes(row.id));
  if (i < 0) { turn.rows.push(row); return row; }
  Object.assign(turn.rows[i], row, { id: turn.rows[i].id });
  return turn.rows[i];
}

function commandRow(turn, tool) {
  const exit = tool.exitCode ?? null;
  const status = cmdStatus(tool.status, exit);
  if (isExplore(tool.commandActions)) {
    // 同类合并：接着上一条「查看」往下记，不新开一行（数字滚一下）
    const existing = turn.rows.find((r) => r.kind === 'explore' && r.ids.includes(tool.id));
    const settle = (row) => {
      row.states[tool.id] = status;
      row.status = Object.values(row.states).includes('run') ? 'run' : 'ok';
      return row;
    };
    if (existing) return settle(existing);
    const prev = lastRow(turn);
    if (prev?.kind === 'explore' && !prev.closed) {
      prev.ids.push(tool.id);
      prev.items.push(...exploreItems(tool.commandActions));
      return settle(prev);
    }
    const row = { kind: 'explore', id: tool.id, ids: [tool.id], items: exploreItems(tool.commandActions), states: {}, status };
    turn.rows.push(row);
    return settle(row);
  }
  const prev = lastRow(turn);
  if (prev?.kind === 'explore') prev.closed = true;
  const existing = turn.rows.find((r) => r.id === tool.id);
  const row = {
    kind: 'cmd', id: tool.id,
    cmd: displayCommand(tool.command),
    cwd: tool.cwd || existing?.cwd || '',
    status,
    exit,
    ms: Number.isFinite(tool.durationMs) ? tool.durationMs : existing?.ms ?? null,
    out: tool.output != null && String(tool.output).length >= String(existing?.out || '').length ? String(tool.output) : existing?.out || '',
  };
  if (existing?.approval) row.approval = existing.approval;
  return upsert(turn, row);
}

/** 后端已经映射过的 tool 事件（runtime/turn.mjs 的 toolEvent）→ 行。返回动到的那一行。 */
export function applyTool(turn, tool) {
  if (!tool || !tool.id) return null;
  if (turn.status === 'think') turn.status = 'exec';
  switch (tool.kind) {
    case 'command':
      return commandRow(turn, tool);
    case 'file_change': {
      const prev = lastRow(turn);
      if (prev?.kind === 'explore') prev.closed = true;
      return upsert(turn, { kind: 'edit', id: tool.id, files: editFiles(tool.changes), status: cmdStatus(tool.status) });
    }
    case 'web_search':
      return upsert(turn, { kind: 'web', id: tool.id, query: tool.query || turn.rows.find((r) => r.id === tool.id)?.query || '', status: tool.query ? 'ok' : 'run' });
    case 'mcp':
      return upsert(turn, {
        kind: 'mcp', id: tool.id, server: tool.server || '', tool: tool.tool || '',
        status: tool.error ? 'fail' : cmdStatus(tool.status), err: tool.error?.message || (typeof tool.error === 'string' ? tool.error : ''),
      });
    case 'todo':
      turn.planText = String(tool.text || turn.planText || '');
      return null;
    case 'bridge_tool':
    case 'dynamic_tool': {
      const ok = typeof tool.success === 'boolean' ? tool.success : null;
      const st = cmdStatus(tool.status);
      return upsert(turn, {
        kind: 'tool', id: tool.id, ns: tool.namespace || '', tool: tool.tool || '',
        args: tool.args || null, status: ok === false && st !== 'run' ? 'fail' : st, ok,
        text: tool.text || '', ms: Number.isFinite(tool.durationMs) ? tool.durationMs : null, images: tool.images || 0,
      });
    }
    case 'collab_agent':
      return upsert(turn, { kind: 'agent', id: tool.id, tool: tool.tool || '', prompt: tool.prompt || '', status: cmdStatus(tool.status), threads: tool.receiverThreadIds || [] });
    case 'image_view':
      return upsert(turn, { kind: 'image', id: tool.id, path: tool.path || '', gen: false });
    case 'image_generation':
      return upsert(turn, { kind: 'image', id: tool.id, path: tool.path || tool.savedPath || '', gen: true, status: cmdStatus(tool.status) });
    case 'review':
      return upsert(turn, { kind: 'review', id: tool.id, phase: tool.phase || 'enter', text: tool.review || '' });
    case 'compaction':
      return upsert(turn, { kind: 'compact', id: tool.id });
    default:
      return null;
  }
}

/** 进度说明（commentary）：按 itemId 累加成一行「say」。 */
export function applyCommentary(turn, itemId, text) {
  const id = 'say:' + (itemId || 'c');
  let row = turn.rows.find((r) => r.id === id);
  if (!row) {
    const prev = lastRow(turn);
    if (prev?.kind === 'explore') prev.closed = true;
    row = { kind: 'say', id, text: '' };
    turn.rows.push(row);
  }
  row.text += text || '';
  return row;
}

function note(turn, code, data = {}, tone = 'info') {
  const row = { kind: 'note', id: 'n:' + code + ':' + turn.rows.length, code, tone, data };
  turn.rows.push(row);
  return row;
}

/* ---------------- 实时事件 ---------------- */

/**
 * 把一条 SSE 事件归进这一轮。返回给宿主的提示：
 *   { haptic?:'tick'|'text'|'done'|'error', terminal?:true, row?, ask?, askClosed? , session?, rateLimits?, ctx?, queue?, fs? }
 * text 事件只累加 turn.answer，呈现（按帧放字）由宿主做。
 */
export function applyEvent(turn, ev) {
  const out = {};
  switch (ev?.type) {
    case 'attach':
      return out;
    case 'session':
      out.session = ev;
      if (ev.adopted) turn.adopted = true;
      return out;
    case 'turn':
      if (ev.turnId) turn.id = ev.turnId;
      return out;
    case 'text':
      turn.answer += ev.text || '';
      if (turn.status !== 'ask') turn.status = 'write';
      return out;
    case 'commentary':
      out.row = applyCommentary(turn, ev.itemId, ev.text);
      out.haptic = 'tick:commentary:' + (ev.itemId || '');
      return out;
    case 'reasoning':
    case 'thinking':
      turn.thinking += ev.text || '';
      out.haptic = 'tick:reasoning:' + (ev.itemId || '') + ':' + (ev.summaryIndex ?? 0);
      return out;
    case 'tool': {
      out.row = applyTool(turn, ev.tool);
      const t = ev.tool || {};
      out.haptic = `tick:tool:${t.id || ''}:${t.status || ''}`;
      return out;
    }
    case 'command-output': {
      const row = turn.rows.find((r) => r.id === ev.itemId && r.kind === 'cmd');
      if (row) row.out = (row.out || '') + (ev.delta || '');
      out.row = row || null;
      return out;
    }
    case 'plan':
      if (Array.isArray(ev.plan)) turn.plan = { explanation: ev.explanation || '', steps: ev.plan.map((s) => ({ step: String(s.step ?? s.text ?? ''), status: String(s.status || 'pending') })) };
      else if (ev.delta) turn.planText += ev.delta;
      return out;
    case 'diff':
      turn.diff = parseTurnDiff(ev.diff);
      return out;
    case 'compacted':
      out.row = upsert(turn, { kind: 'compact', id: 'compact:' + (ev.turnId || turn.rows.length) });
      return out;
    case 'model-rerouted':
      out.row = note(turn, 'rerouted', { from: ev.from || '', to: ev.to || '', reason: ev.reason || '' });
      return out;
    case 'warning':
      // bridge 自己按设置打开的实验特性（提问工具等）每开一条线程都会报这一句，对用户只是噪音
      if (/^Under-development features enabled/i.test(String(ev.message || ''))) return out;
      out.row = note(turn, 'warning', { message: ev.message || '' }, 'warn');
      return out;
    case 'account-switch':
      out.row = note(turn, 'switch', { from: ev.from || '', to: ev.to || '', reason: ev.reason || '' });
      out.accountSwitch = ev;
      return out;
    case 'approval-review':
      out.row = note(turn, 'review', { phase: ev.phase || '', review: ev.review || null });
      return out;
    case 'relay':
      out.row = upsert(turn, { kind: 'steer', id: 'relay:' + turn.rows.length, text: ev.text || '', relay: true });
      return out;
    case 'perm_request':
    case 'question':
      if (ev.type === 'question') turn.asked = { qid: ev.qid, questions: Array.isArray(ev.questions) ? ev.questions : [] };
      turn.status = 'ask';
      out.ask = ev;
      out.haptic = 'tick:ask:' + (ev.qid || '');
      if (ev.type === 'perm_request') markWaiting(turn, ev);
      return out;
    case 'perm_answer':
    case 'answer':
      out.askClosed = ev;
      if (ev.type === 'perm_answer') settleApproval(turn, ev);
      else out.row = answeredRow(turn, ev);
      if (turn.status === 'ask') turn.status = turn.answer ? 'write' : 'exec';
      return out;
    case 'rate-limits':
      out.rateLimits = ev;
      return out;
    case 'context-usage':
      out.ctx = ev.contextUsage || null;
      return out;
    case 'queue':
      out.queue = true;
      return out;
    case 'fs':
      out.fs = ev.path;
      return out;
    case 'done':
    case 'interrupted':
    case 'error':
      finish(turn, ev);
      out.terminal = true;
      out.haptic = ev.type === 'done' ? 'done' : ev.type === 'error' ? 'error' : 'click';
      return out;
    default:
      return out;
  }
}

/** 等批准的命令：记录里先占一行「等你批准」，批了原地变成正在跑的那条命令（不再另起一行「已允许」）。 */
function markWaiting(turn, ev) {
  const itemId = ev.codex?.itemId || ev.toolUseId || ev.qid;
  const cmd = ev.preview?.kind === 'command' ? (ev.preview.command || ev.description || '') : '';
  if (!cmd || !itemId) return;
  const existing = turn.rows.find((r) => r.id === itemId);
  if (existing) { existing.status = 'wait'; existing.qid = ev.qid; return; }
  turn.rows.push({ kind: 'cmd', id: itemId, cmd: displayCommand(cmd), cwd: ev.preview?.cwd || '', status: 'wait', exit: null, ms: null, out: '', qid: ev.qid });
}

/** 答完的提问在记录里留一行「你答了：…」（处理完的决定都要在记录里看得到）。 */
function answeredRow(turn, ev) {
  const asked = turn.asked?.qid === ev.qid ? turn.asked : null;
  const answers = Array.isArray(ev.answers) ? ev.answers : [];
  const picked = answers.flatMap((a) => [...(Array.isArray(a?.selected) ? a.selected : []), ...(a?.custom ? [a.custom] : [])]).map(String).filter(Boolean);
  const q = asked?.questions?.[0] || {};
  const row = { kind: 'note', id: 'answered:' + (ev.qid || turn.rows.length), code: 'answered', tone: 'info',
    data: { question: String(q.question || q.header || ''), picked, cancelled: !!ev.cancelled || !answers.length, secret: !!q.isSecret } };
  turn.rows.push(row);
  return row;
}

function settleApproval(turn, ev) {
  const row = turn.rows.find((r) => r.qid && r.qid === ev.qid);
  if (!row) return;
  const d = ev.decision;
  if (d === 'deny' || d === 'decline' || d === 'abort') { row.status = 'deny'; row.approval = 'deny'; }
  else if (d === 'once' || d === 'always' || d === 'rule' || d === 'accept') { row.approval = d; if (row.status === 'wait') row.status = 'run'; }
  else if (row.status === 'wait') row.status = 'deny';
}

function finish(turn, ev) {
  turn.live = false;
  turn.endedAt = Date.now();
  if (ev.result && String(ev.result).length > turn.answer.length) turn.answer = String(ev.result);
  if (Array.isArray(ev.attachments) && ev.attachments.length) turn.attachments = ev.attachments;
  if (ev.type === 'done') turn.status = 'done';
  else if (ev.type === 'interrupted') turn.status = 'stopped';
  else {
    turn.status = 'error';
    turn.error = { message: String(ev.message || ''), limit: ev.limit || null, status: ev.status || '' };
  }
  for (const r of turn.rows) {
    if (r.status === 'run' || r.status === 'wait') r.status = ev.type === 'done' ? 'ok' : 'stop';
    if (r.states) for (const k of Object.keys(r.states)) if (r.states[k] === 'run') r.states[k] = r.status;
  }
}

/* ---------------- 统计 ---------------- */

/** 收起来那一行要写的：用了多久、几条命令、改了几个文件、增删行数。 */
export function turnSummary(turn) {
  let commands = 0, explored = 0, tools = 0;
  const files = new Map();
  for (const r of turn.rows) {
    if (r.kind === 'cmd' && r.status !== 'deny') commands++;
    else if (r.kind === 'explore') explored += r.items.length;
    else if (r.kind === 'tool' || r.kind === 'mcp' || r.kind === 'web') tools++;
    else if (r.kind === 'edit') for (const f of r.files) {
      const cur = files.get(f.path) || { path: f.path, name: f.name, a: 0, d: 0 };
      cur.a += f.a; cur.d += f.d;
      files.set(f.path, cur);
    }
  }
  let list = [...files.values()];
  // 整轮 diff 是准的（多次编辑同一文件时逐次相加会重复算）：有就以它为准
  if (turn.diff?.files?.length) list = turn.diff.files;
  const a = list.reduce((s, f) => s + f.a, 0), d = list.reduce((s, f) => s + f.d, 0);
  const ms = turn.startedAt && turn.endedAt ? turn.endedAt - turn.startedAt : turn.durationMs ?? null;
  return { commands, explored, tools, files: list, a, d, ms };
}

/* ---------------- 历史 ---------------- */

const itemStatus = (s) => (s === 'inProgress' ? 'inProgress' : s);

/** 原始 ThreadItem（thread/turns 的 itemsView:full）→ 和实时事件同形的 tool 描述。 */
export function toolFromItem(item) {
  switch (item?.type) {
    case 'commandExecution':
      return { kind: 'command', id: item.id, status: itemStatus(item.status), command: item.command, output: item.aggregatedOutput, exitCode: item.exitCode, commandActions: item.commandActions, durationMs: item.durationMs, cwd: item.cwd };
    case 'fileChange':
      return { kind: 'file_change', id: item.id, status: item.status, changes: item.changes };
    case 'mcpToolCall':
      return { kind: 'mcp', id: item.id, status: item.status, server: item.server, tool: item.tool, error: item.error };
    case 'dynamicToolCall':
      return { kind: /^bridge(?:_|$)/.test(item.namespace || '') ? 'bridge_tool' : 'dynamic_tool', id: item.id, status: item.status, namespace: item.namespace, tool: item.tool, success: item.success, durationMs: item.durationMs, args: item.arguments && typeof item.arguments === 'object' ? item.arguments : null };
    case 'webSearch':
      return { kind: 'web_search', id: item.id, query: item.query || item.action?.query || '' };
    case 'collabAgentToolCall':
      return { kind: 'collab_agent', id: item.id, tool: item.tool, status: item.status, prompt: item.prompt, receiverThreadIds: item.receiverThreadIds };
    case 'imageView':
      return { kind: 'image_view', id: item.id, path: item.path };
    case 'imageGeneration':
      return { kind: 'image_generation', id: item.id, status: item.status, path: item.savedPath || item.path || '' };
    case 'enteredReviewMode':
      return { kind: 'review', id: item.id, phase: 'enter', review: item.review };
    case 'exitedReviewMode':
      return { kind: 'review', id: item.id, phase: 'exit', review: item.review };
    case 'contextCompaction':
      return { kind: 'compaction', id: item.id };
    default:
      return null;
  }
}

const userText = (item) => (Array.isArray(item?.content) ? item.content.filter((c) => c?.type === 'text').map((c) => c.text || '').join('\n') : '');
const userImages = (item) => (Array.isArray(item?.content) ? item.content.filter((c) => c?.type === 'localImage' && c.path).map((c) => ({ path: c.path, name: baseName(c.path), kind: 'image' })) : []);

/** 一条 Codex 真实历史的轮（Turn）→ 视图模型的一轮。 */
export function turnFromHistory(t) {
  const turn = newTurn({ id: t.id || null });
  turn.startedAt = t.startedAt ? (t.startedAt < 1e12 ? t.startedAt * 1000 : t.startedAt) : null;
  turn.endedAt = t.completedAt ? (t.completedAt < 1e12 ? t.completedAt * 1000 : t.completedAt) : null;
  if (Number.isFinite(t.durationMs)) turn.durationMs = t.durationMs;
  let sawUser = false;
  const finals = [];
  for (const item of Array.isArray(t.items) ? t.items : []) {
    if (item.type === 'userMessage') {
      const txt = userText(item);
      if (!sawUser) { turn.user = { text: txt, attachments: userImages(item) }; sawUser = true; }
      else if (txt) turn.rows.push({ kind: 'steer', id: item.id, text: txt });
      continue;
    }
    if (item.type === 'agentMessage') {
      if (item.phase === 'commentary') applyCommentary(turn, item.id, item.text || '');
      else finals.push(item.text || '');
      continue;
    }
    if (item.type === 'reasoning') {
      const s = (item.summary || []).join('\n\n');
      if (s) turn.thinking += (turn.thinking ? '\n\n' : '') + s;
      continue;
    }
    if (item.type === 'plan') { turn.planText = item.text || ''; continue; }
    const tool = toolFromItem(item);
    if (tool) applyTool(turn, tool);
  }
  turn.answer = finals.filter(Boolean).join('\n\n');
  const st = t.status;
  turn.status = st === 'interrupted' ? 'stopped' : st === 'failed' ? 'error' : st === 'inProgress' ? 'exec' : 'done';
  if (st === 'failed' && t.error) turn.error = { message: String(t.error.message || ''), limit: null, status: '' };
  if (!sawUser) turn.adopted = true;
  for (const r of turn.rows) if (r.status === 'run' && st !== 'inProgress') r.status = 'ok';
  return turn;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/**
 * 打开旧线程：以 Codex 的真实历史（带工作记录）为骨架，从 bridge 侧车补上附件和产物。
 * 侧车只记 bridge 发起的轮（认领的压缩 / 审查不在里面），按用户原话顺序对上。
 * 没有真实历史（读不到、hub 线程等）时退回侧车：只有你的话和回答。
 */
export function mergeHistory(rawTurns, messages) {
  const side = [];
  const msgs = Array.isArray(messages) ? messages : [];
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i];
    if (m.role !== 'user') continue;
    const reply = msgs[i + 1]?.role === 'assistant' ? msgs[i + 1] : null;
    side.push({ text: m.text || '', attachments: m.attachments || [], reply: reply?.text || '', produced: reply?.attachments || [] });
  }
  if (!Array.isArray(rawTurns) || !rawTurns.length) {
    return side.map((s) => {
      const turn = newTurn({ text: s.text, attachments: s.attachments });
      turn.answer = s.reply;
      turn.attachments = s.produced;
      return turn;
    });
  }
  const turns = rawTurns.map(turnFromHistory);
  let j = 0;
  for (const turn of turns) {
    if (turn.adopted) continue;
    // 往后找一条原话对得上的侧车记录（侧车里可能有 Codex 历史里已被回退掉的轮）
    let k = j;
    while (k < side.length && norm(side[k].text) !== norm(turn.user.text)) k++;
    if (k >= side.length) continue;
    const s = side[k];
    j = k + 1;
    if (s.attachments.length) turn.user.attachments = s.attachments;
    if (s.produced.length) turn.attachments = s.produced;
    if (!turn.answer && s.reply) turn.answer = s.reply;
  }
  return turns;
}
