// 官方 /code 页「工具行文案引擎」的移植（Claude 桌面客户端 ion-dist：cf6337626 的
// cl(=xh) 动词表 / ll(=Yh) 描述句变位 / Al(=lh) mcp 显示名，shared-1 的 tr/cr/ur 标签表，
// c360a9e1c 的 tj/ZD 分组汇总）。规格：scratchpad/specs/agent-tool-card.md §4–§5。
//
// 数据来源是 bridge 的 tools 段条目（impl-contract §4.1）：{ id, name, index, summary,
// input:{file_path,notebook_path,path,pattern,glob,command,description,url,query,skill,
// subject,prompt,subagent_type,run_in_background,name,offset,limit,todosCount}, status, task }。
// 没有工具输出正文（官方 gitOperation / Write 的 update 判定等靠结果内容的分支这里做不到，
// 均按无结果的默认分支走）。
//
// 另附几个各组件共用的小格式化：模型短名（shared-0 Ui）、紧凑数字（xi）、时长（dD/Nw）、
// Learn more 链接选择、以及 morph 文本切换 action（官方 Lg 的简化版）。

const str = (v) => (typeof v === 'string' ? v : '');
const norm = (v) => str(v).replace(/\s+/g, ' ').trim();
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

export function basename(p) {
  const s = str(p).trim();
  if (!s) return '';
  return s.split(/[\\/]/).filter(Boolean).pop() || s;
}

// PascalCase / camelCase → snake_case（官方 Ir）："WebFetch"→"web_fetch"、"LS"→"ls"
function snake(name) {
  return str(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

// —— mcp 显示名（官方 Al/lh）——
// `mcp__server__tool` → "Server Name: tool name"（下划线→空格）；非 mcp 原名返回。
// bridge 没有 registry，一律走「无匹配」分支。
export function mcpDisplayName(name) {
  const n = str(name);
  const m = n.match(/^mcp__([^_].*?)__(.+)$/);
  if (!m) return n;
  const server = m[1].replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  const tool = m[2].replace(/_+/g, ' ').trim();
  return `${server}: ${tool}`;
}
function mcpParts(name) {
  const m = str(name).match(/^mcp__([^_].*?)__(.+)$/);
  return m ? { server: m[1], tool: m[2] } : null;
}

// —— shared-1 标签表（默认分支用）：key 为蛇形小写 → [running, done, failed?] ——
const LABELS = {
  task: ['Running agent', 'Ran agent', 'Failed to run agent'],
  agent: ['Running agent', 'Ran agent', 'Failed to run agent'],
  read: ['Reading file', 'Read file', 'Failed to read file'],
  write: ['Writing file', 'Wrote file', 'Failed to write file'],
  edit: ['Editing file', 'Edited file', 'Failed to edit file'],
  multi_edit: ['Editing files', 'Edited files', 'Failed to edit files'],
  notebook_edit: ['Editing notebook', 'Edited notebook', 'Failed to edit notebook'],
  glob: ['Finding files', 'Found files', 'Failed to find files'],
  grep: ['Searching code', 'Searched code', 'Failed to search code'],
  web_fetch: ['Fetching URL', 'Fetched URL', 'Failed to fetch URL'],
  web_search: ['Searching web', 'Searched web', 'Failed to search web'],
  kill_bash: ['Stopping command', 'Stopped command', 'Failed to stop command'],
  kill_shell: ['Stopping command', 'Stopped command', 'Failed to stop command'],
  tmux: ['Running terminal', 'Ran terminal'],
  ask_user_question: ['Asking a question', 'Asked a question', 'Failed to ask a question'],
  bash_output: ['Checking command output', 'Checked command output'],
  enter_plan_mode: ['Making a plan', 'Started planning'],
  exit_plan_mode: ['Proposing plan', 'Proposed plan'],
  skill: ['Running skill', 'Ran skill', 'Failed to run skill'],
  tool_search: ['Finding tools', 'Found tools', 'Failed to find tools'],
  ls: ['Listing files', 'Listed files', 'Failed to list files'],
  repl: ['Running code', 'Ran code', 'Failed to run code'],
  java_script: ['Running code', 'Ran code', 'Failed to run code'],
  push_notification: ['Sending notification', 'Sent notification', 'Failed to send notification'],
  send_user_message: ['Sending message', 'Sent message'],
  send_user_file: ['Presenting files', 'Presented files'],
  present_files: ['Presenting files', 'Presented files'],
  todo_write: ['Update todo list', 'Updated todo list'],
  list_mcp_resources: ['Listing resources', 'Listed resources'],
  read_mcp_resource_tool: ['Reading resource', 'Read resource'],
  preview_start: ['Starting preview', 'Started preview'],
  preview_stop: ['Stopping preview', 'Stopped preview'],
  preview_screenshot: ['Taking preview screenshot', 'Took preview screenshot'],
  preview_logs: ['Reading preview logs', 'Read preview logs'],
  preview_list: ['Listing previews', 'Listed previews'],
  monitor: ['Monitoring', 'Monitored'],
};
// Claude Browser mcp 表（官方 pr）：只认工具段名，服务器名随 bridge 的挂法变化不影响
const BROWSER = {
  navigate: ['Navigating', 'Navigated'],
  read_page: ['Reading page', 'Read page'],
  find: ['Finding elements', 'Found elements'],
  get_page_text: ['Reading page text', 'Read page text'],
  form_input: ['Filling form', 'Filled form'],
  javascript_tool: ['Running script', 'Ran script'],
  read_console_messages: ['Reading console', 'Read console'],
  read_network_requests: ['Reading network requests', 'Read network requests'],
  tabs_create: ['Opening tab', 'Opened tab'],
  tabs_close: ['Closing tab', 'Closed tab'],
  tabs_select: ['Switching tab', 'Switched tab'],
  tabs_context: ['Listing tabs', 'Listed tabs'],
  resize_window: ['Resizing window', 'Resized window'],
  upload_image: ['Uploading file', 'Uploaded file'],
  file_upload: ['Uploading file', 'Uploaded file'],
  gif_creator: ['Recording', 'Recorded'],
  computer: ['Using computer', 'Used computer'],   // 官方按 input.action 细分；bridge 的 input 子集不含 action
  browser_batch: ['Performing browser actions', 'Performed browser actions'],
};

// —— 描述句变位（官方 ll/Yh）——
// "Fix login bug" → running "Fixing login bug" / done "Fixed login bug" / infinitive "fix login bug"
const PREFIX_RE = /^(re|un|de|pre|co|sub|over|out|mis|auto|post)-(.+)$/i;
// 不规则过去式（官方 Ko）
const IRREG_PAST = {
  run: 'ran', rerun: 'reran', write: 'wrote', rewrite: 'rewrote', read: 'read', reread: 'reread', find: 'found',
  build: 'built', rebuild: 'rebuilt', set: 'set', reset: 'reset', unset: 'unset', do: 'did', redo: 'redid', undo: 'undid',
  make: 'made', remake: 'remade', get: 'got', put: 'put', see: 'saw', take: 'took', retake: 'retook', give: 'gave',
  go: 'went', come: 'came', begin: 'began', bring: 'brought', buy: 'bought', catch: 'caught', choose: 'chose',
  cut: 'cut', deal: 'dealt', draw: 'drew', redraw: 'redrew', drive: 'drove', eat: 'ate', fall: 'fell', feed: 'fed',
  feel: 'felt', fight: 'fought', fly: 'flew', forget: 'forgot', hide: 'hid', hit: 'hit', hold: 'held', keep: 'kept',
  know: 'knew', lay: 'laid', lead: 'led', leave: 'left', lend: 'lent', let: 'let', light: 'lit', lose: 'lost',
  mean: 'meant', meet: 'met', pay: 'paid', quit: 'quit', ring: 'rang', rise: 'rose', say: 'said', seek: 'sought',
  sell: 'sold', send: 'sent', resend: 'resent', shake: 'shook', show: 'showed', shut: 'shut', sing: 'sang', sit: 'sat',
  sleep: 'slept', speak: 'spoke', spend: 'spent', split: 'split', spread: 'spread', stand: 'stood', steal: 'stole',
  stick: 'stuck', strike: 'struck', sweep: 'swept', swim: 'swam', teach: 'taught', tell: 'told', think: 'thought',
  rethink: 'rethought', throw: 'threw', understand: 'understood', upset: 'upset', wake: 'woke', wear: 'wore', win: 'won',
  withdraw: 'withdrew', offset: 'offset', input: 'input', output: 'output', cast: 'cast', broadcast: 'broadcast',
};
// 多音节但末音节重读、需要双写的（官方 Ho 表的等价物；单音节 CVC 由规则处理）
const DOUBLE_LONG = new Set(['commit', 'recommit', 'format', 'reformat', 'debug', 'submit', 'resubmit', 'admit', 'omit', 'emit',
  'permit', 'transmit', 'control', 'patrol', 'refer', 'prefer', 'occur', 'regret', 'equip', 'program', 'reprogram',
  'begin', 'forget', 'unwrap', 'remap', 'unzip', 'rezip']);
// 特例（不按规则）：c 结尾的 sync 不加 k
const ING_SPECIAL = { sync: 'syncing', resync: 'resyncing', panic: 'panicking' };
const PAST_SPECIAL = { sync: 'synced', resync: 'resynced', panic: 'panicked' };
// 看起来像动词其实是过去分词的（官方 Go）：首词命中就不变位
const PARTICIPLES = new Set(['been', 'begun', 'bound', 'broken', 'brought', 'built', 'chosen', 'done', 'drawn', 'driven',
  'eaten', 'fallen', 'flown', 'forgotten', 'found', 'frozen', 'given', 'gone', 'grown', 'had', 'held', 'hidden', 'kept',
  'known', 'left', 'lost', 'made', 'met', 'paid', 'said', 'seen', 'sent', 'shown', 'spoken', 'stood', 'taken', 'thought',
  'told', 'understood', 'won', 'worn', 'written', 'gotten', 'led', 'fed', 'sold', 'sought', 'spent', 'struck', 'swept',
  'taught', 'thrown', 'undone', 'woken', 'withdrawn', 'bought', 'caught', 'dealt', 'felt', 'fought', 'lit', 'meant',
  'slept', 'ran', 'went', 'came', 'began', 'drew', 'flew', 'forgot', 'hid', 'knew', 'rose', 'shook', 'sang', 'sat',
  'spoke', 'stole', 'stuck', 'swam', 'threw', 'woke', 'wore']);
// 允许变位的动词白名单（官方 el ≈230 个，这里取开发场景常用的 ~190 个 + 上表的不规则动词）
const VERBS = new Set(('add adjust analyze append apply archive assert assess audit benchmark boot build bump bundle cache ' +
  'calculate capture change check clean clear click clone close collect compare compile compress compute configure confirm ' +
  'connect consolidate convert copy count crawl create debug decode define delete deploy describe design detect determine ' +
  'diagnose diff disable discover document download draft drop dump edit enable encode enumerate evaluate examine execute ' +
  'expand explain explore export extract fetch figure fill filter find finish fix flag flatten follow format gather ' +
  'generate get grab grep handle identify implement import improve index initialize insert inspect install integrate ' +
  'investigate isolate kick launch learn link lint list load locate log look make map match measure merge migrate minify ' +
  'mock modify monitor move navigate normalize open optimize organize outline package parse patch perform ping plan plot ' +
  'polish populate prepare print probe process produce profile prune publish pull push query read rebase rebuild record ' +
  'refactor refresh register remove rename render repair replace report research reset resolve restart restore retrieve ' +
  'retry review rewrite run sample save scaffold scan schedule scrape search select send set ship show simplify simulate ' +
  'sort spawn split start stop stub submit summarize survey sync synthesize tag tail test trace track transform translate ' +
  'trim troubleshoot try tune type uninstall unpack update upgrade upload use validate verify view visit wait walk warn ' +
  'watch wipe wire wrap write zip rerun reread redo undo remap resend rethink retake redraw unset offset unwrap unzip ' +
  'recommit reformat resubmit resync reprogram commit emit omit admit permit transmit control refer prefer occur equip program')
  .split(/\s+/));

function isVerbWord(w) {
  if (!/^[A-Za-z]{2,16}$/.test(w)) return false;
  if (w === w.toUpperCase()) return false;                 // 全大写（API、SQL）
  const lw = w.toLowerCase();
  if (PARTICIPLES.has(lw)) return false;
  if (!(VERBS.has(lw) || IRREG_PAST[lw])) return false;
  if (!IRREG_PAST[lw]) {
    if (/ing$/.test(lw) && lw.length > 4) return false;    // 已是进行时
    if (/[^e]ed$/.test(lw) && lw.length > 3) return false; // 已是过去式（eed 除外）
    if (/s$/.test(lw) && !/(ss|us)$/.test(lw) && lw.length > 3) return false;   // 复数/三单
    if (!/[aeiouy]/.test(lw)) return false;
  }
  return true;
}
// CVC 结尾且单音节 → 双写末辅音（run→running、plan→planning；edit/open 不双写）
function shouldDouble(v) {
  if (DOUBLE_LONG.has(v)) return true;
  if (!/[^aeiouy][aeiou][^aeiouwxy]$/.test(v)) return false;
  if (v.length === 3) return true;
  if (v.length === 4) return /^[^aeiou]{2}/.test(v);
  return false;
}
function toIng(v) {
  if (ING_SPECIAL[v]) return ING_SPECIAL[v];
  if (/ie$/.test(v)) return v.slice(0, -2) + 'ying';
  if (/[^eoy]e$/.test(v)) return v.slice(0, -1) + 'ing';
  if (shouldDouble(v)) return v + v[v.length - 1] + 'ing';
  if (/c$/.test(v)) return v + 'king';
  return v + 'ing';
}
function toPast(v) {
  if (IRREG_PAST[v]) return IRREG_PAST[v];
  if (PAST_SPECIAL[v]) return PAST_SPECIAL[v];
  if (/e$/.test(v)) return v + 'd';
  if (/[^aeiou]y$/.test(v)) return v.slice(0, -1) + 'ied';
  if (shouldDouble(v)) return v + v[v.length - 1] + 'ed';
  if (/c$/.test(v)) return v + 'ked';
  return v + 'ed';
}
// 保持首字母大小写（官方 Zo）
function keepCase(src, out) {
  const c = src[0];
  return c === c.toUpperCase() && c !== c.toLowerCase() ? out[0].toUpperCase() + out.slice(1) : out;
}
// 句中 "and/then <verb>" 也一并变位（官方 rl）
function inflectRest(rest, fn) {
  return str(rest).replace(/(\s(?:and|then)\s+)([A-Za-z]+)/g, (all, sep, w) => (isVerbWord(w) ? sep + keepCase(w, fn(w.toLowerCase())) : all));
}

// 返回 {running, done, infinitive}；首词不是动词 → undefined（行内退回 "Running agent"+描述）
export function inflectDescription(desc) {
  const m = str(desc).match(/^(\s*)(\S+)([\s\S]*)$/);
  if (!m) return undefined;
  const [, lead, first, rest] = m;
  let prefix = '', head = first;
  const pm = first.match(PREFIX_RE);
  if (pm) { prefix = pm[1] + '-'; head = pm[2]; }
  if (!isVerbWord(head)) return undefined;
  const lw = head.toLowerCase();
  const ing = keepCase(head, toIng(lw));
  const past = keepCase(head, toPast(lw));
  return {
    running: lead + prefix + ing + inflectRest(rest, toIng),
    done: lead + prefix + past + inflectRest(rest, toPast),
    infinitive: lead + first[0].toLowerCase() + first.slice(1) + rest,
  };
}

// —— 主表（官方 cl/xh）——
// 返回 { verb, runningVerb, failedVerb, meta, metaIsCode, metaIsPath, metaHref, kind,
//        runningLabel, doneLabel, failedLabel, doneLabelNeedsBackgroundConfirmation }
export function toolVerb(tool) {
  const name = str(tool && tool.name);
  const input = (tool && tool.input) || {};
  const task = (tool && tool.task) || null;
  const fallback = norm(tool && tool.summary);
  const R = (verb, runningVerb, failedVerb, meta, extra) => ({
    verb, runningVerb, failedVerb, meta: meta || undefined, metaIsCode: false, metaIsPath: false, kind: 'text', ...(extra || {}),
  });
  const withDesc = (verb, runningVerb, failedVerb, desc, extra) => {
    const inf = desc ? inflectDescription(desc) : undefined;
    return R(verb, runningVerb, failedVerb, desc, {
      runningLabel: inf ? inf.running : undefined,
      doneLabel: inf ? inf.done : undefined,
      failedLabel: inf ? 'Failed to ' + inf.infinitive : undefined,
      ...(extra || {}),
    });
  };
  switch (name) {
    case COMPACT_TOOL:
      // 分组头运行态显示「Compacting…」流光（整句标签）；完成/失败的整句由 CompactRow 自己出
      return R('Compacted', 'Compacting', 'Compaction failed', 'the session', { kind: 'compact', runningLabel: 'Compacting…' });
    case 'Bash': case 'BashTool': case 'PowerShell':
      // 官方 meta = description ?? "a command"（命令本身只进展开体）
      return withDesc('Ran', 'Running', 'Failed to run', norm(input.description) || 'a command',
        { kind: 'bash', doneLabelNeedsBackgroundConfirmation: input.run_in_background === true });
    case 'Read':
      return R('Read', 'Reading', 'Failed to read', basename(input.file_path) || basename(fallback), { kind: 'file', metaIsPath: true });
    case 'Write':
      // 官方按结果 type==="update" 显示 Updated——bridge 拿不到结果正文，一律 Created
      return R('Created', 'Creating', 'Failed to write', basename(input.file_path) || basename(fallback), { kind: 'diff', metaIsPath: true });
    case 'Edit': case 'MultiEdit': case 'NotebookEdit':
      return R('Edited', 'Editing', 'Failed to edit', basename(input.file_path || input.notebook_path) || basename(fallback), { kind: 'diff', metaIsPath: true });
    case 'Grep': case 'Glob':
      return R('Searched', 'Searching', 'Failed to search', norm(input.pattern) || fallback);
    case 'LS':
      return R('Listed', 'Listing', 'Failed to list', norm(input.path) || fallback);
    case 'WebFetch': {
      const url = norm(input.url) || fallback;
      return R('Fetched', 'Fetching', 'Failed to fetch', url, { metaHref: /^https:\/\//i.test(url) ? url : undefined });
    }
    case 'WebSearch':
      return R('Searched web', 'Searching web', 'Failed to search web', norm(input.query) || fallback);
    case 'Task': case 'Agent': {
      const desc = norm(input.description) || norm(task && task.description) || fallback;
      const bg = input.run_in_background === true || !!(task && task.backgrounded);
      return withDesc('Ran agent', 'Running agent', 'Failed to run agent', desc, { doneLabelNeedsBackgroundConfirmation: bg });
    }
    case 'Workflow': {
      const wname = norm(input.name) || norm(task && (task.name || task.workflowName));
      return R('Ran workflow', 'Running workflow', 'Failed to run workflow', wname, { kind: 'workflow' });
    }
    case 'Skill':
      return R('Ran skill', 'Running skill', 'Failed to run skill', input.skill ? '/' + norm(input.skill) : fallback, { metaIsCode: true });
    case 'TaskGet': return R('Read task', 'Reading task', 'Failed to read task', undefined, { kind: 'todos' });
    case 'TaskList': return R('Listed tasks', 'Listing tasks', 'Failed to list tasks', undefined, { kind: 'todos' });
    case 'TaskCreate': return R('Added task', 'Adding task', 'Failed to add task', norm(input.subject) || fallback, { kind: 'todos' });
    case 'TaskUpdate': {
      const st = str(input.status);
      const verb = st === 'completed' ? 'Completed task' : st === 'in_progress' ? 'Started task' : st === 'pending' ? 'Reset task to pending'
        : st === 'deleted' ? 'Removed task' : st ? 'Updated task status' : input.subject ? 'Renamed task' : 'Updated task';
      return R(verb, 'Updating task', 'Failed to update task', norm(input.subject) || fallback, { kind: 'todos' });
    }
    case 'TaskStop': return R('Stopped task', 'Stopping task', 'Failed to stop task', undefined, { kind: 'todos' });
    case 'TodoWrite':
      return R(input.todosCount === 0 ? 'Cleared todos' : 'Updated todos', 'Updating todos', undefined, undefined, { kind: 'todos' });
    case 'EnterPlanMode': return R('Started planning', 'Making a plan', 'Failed to start planning');
    case 'ExitPlanMode': return R('Proposed plan', 'Proposing plan', 'Failed to propose plan', undefined, { kind: 'plan' });
    case 'AskUserQuestion': return R('Asked', 'Asking', undefined, fallback, { kind: 'question' });
    case 'Artifact': {
      const action = str(input.action);
      if (action === 'list') return R('Listed artifacts', 'Listing artifacts', 'Failed to list artifacts');
      if (!action || action === 'publish') return R('Published artifact', 'Publishing artifact', 'Failed to publish artifact', basename(input.file_path) || fallback, { metaIsCode: true });
      return R('Used artifact tool', 'Using artifact tool', 'Failed to run artifact action', action, { metaIsCode: true });
    }
    case 'SendUserMessage': case 'SendUserFile': return R('Sent', 'Sending', undefined);
    case 'PushNotification': return R('Sent notification', 'Sending notification', 'Failed to send notification');
    case 'SendMessage': {
      const to = norm(input.to);
      if (to) return R(`Messaged @${to}`, `Messaging @${to}`, `Failed to message @${to}`, fallback, { kind: 'peerMessage' });
      return R('Messaged teammate', 'Messaging teammate', 'Failed to message teammate', fallback, { kind: 'peerMessage' });
    }
    default: {
      // mcp / 未列出：先查标签表（running≠done 才成对使用），否则 "Used {label}"
      const mp = mcpParts(name);
      const key = mp ? snake(mp.tool) : snake(name);
      const pair = (mp && BROWSER[key]) || LABELS[key];
      if (pair && pair[0] !== pair[1]) return R(pair[1], pair[0], pair[2], fallback || undefined);
      const label = mp ? mcpDisplayName(name) : name;
      return R(`Used ${label}`, `Using ${label}`, undefined, fallback || undefined);
    }
  }
}

// —— 官方 HD 分桶的 standalone 集合（桌面端 c06cf64bb `xr`）——
// 这些工具永远自己一段（Workflow 的 318px 卡只在不分组时渲染，被夹进 Grep/Bash 的分组里就只剩一行字），
// 前后连续的 tool_use 各自另起一段。服务端历史重建 runtime/tool-summary.mjs 抄了同一份——改一处记得改另一处。
export const STANDALONE_TOOLS = new Set(['Workflow', 'ExitPlanMode', 'SendUserMessage', 'SendUserFile', 'PushNotification', 'Artifact', 'ReportFindings', 'ClaudeDesign']);
export function toolStandalone(name) { return typeof name === 'string' && STANDALONE_TOOLS.has(name); }

// —— 上下文压缩条目（官方 `compacted` 条目；服务端 runtime/tool-summary.mjs 抄了同一个名字）——
// 它不是 tool_use：tools 段里一条合成条目（带 compact 字段），Claude 干活途中压缩就并进循环分组
//（官方 rolls-up），否则单独一行。文案取桌面端 ion bundle 原文（c2fb08a02 的 M/N）。
export const COMPACT_TOOL = '__compact';
export const isCompactTool = (t) => !!t && t.name === COMPACT_TOOL;
export function compactLabel(t) {
  if (t.status === 'running') return 'Compacting…';
  if (t.status === 'error') return 'Compaction failed';
  const c = t.compact || {};
  const pre = Number(c.preTokens) || 0, post = Number(c.postTokens) || 0;
  if (pre > 0 && post > 0 && pre > post) return `Compacted session · saved ${fmtCompact(pre - post)} tokens`;
  if (pre > 0) return `Compacted session · from ${fmtCompact(pre)} tokens`;
  return 'Compacted session';
}

// —— 分组汇总（官方 tj → ZD）——
// 返回 [{verb, meta, isError}]，顺序=类目首次出现顺序；第一项动词由调用方大写。
const CATEGORY = {
  Read: 'read', Write: 'write', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'notebook_edit',
  Bash: 'bash', BashTool: 'bash', PowerShell: 'bash', Grep: 'grep', Glob: 'glob', WebFetch: 'web', WebSearch: 'web',
  Task: 'task', Agent: 'task', TodoWrite: 'todo', ExitPlanMode: 'exit_plan_mode',
};
const FILE_CATS = new Set(['read', 'view', 'write', 'edit', 'notebook_edit', 'delete_file']);
const plural = (n, one, many) => (n === 1 ? one : many.replace('#', String(n)));
const CAT_TEXT = {
  read: (n) => ['read', plural(n, 'a file', '# files')],
  view: (n) => ['viewed', plural(n, 'a file', '# files')],
  write: (n) => ['created', plural(n, 'a file', '# files')],
  edit: (n) => ['edited', plural(n, 'a file', '# files')],
  notebook_edit: (n) => ['edited', plural(n, 'a notebook', '# notebooks')],
  delete_file: (n) => ['deleted', plural(n, 'a file', '# files')],
  bash: (n) => ['ran', plural(n, 'a command', '# commands')],
  grep: () => ['searched', 'code'],
  glob: () => ['found', 'files'],
  web: () => ['browsed', 'the web'],
  task: (n) => ['ran', plural(n, 'an agent', '# agents')],
  todo: () => ['updated', 'todos'],
  exit_plan_mode: () => ['proposed', 'a plan'],
  artifact_read: (n) => ['read', plural(n, 'an artifact', '# artifacts')],
  artifact_write: (n) => ['updated', plural(n, 'an artifact', '# artifacts')],
  other: (n) => ['used', plural(n, 'a tool', '# tools')],
};
function categoryOf(t) {
  if (t.name === 'Artifact') {
    const a = str(t.input && t.input.action);
    return a === 'list' || a === 'read' ? 'artifact_read' : 'artifact_write';
  }
  return CATEGORY[t.name] || 'other';
}
const toolFailed = (t) => t.status === 'error' || !!(t.task && t.task.status === 'failed');
function formatList(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}
// 压缩条目不进类目：官方把它当事件，汇总句里插一段「compacted the session」（c24951e9f 的 $i），
// 位置 = 第一个【首次出现在压缩之后】的类目之前（官方 Zs 数压缩前有几个工具、C(t) 按类目首现序号比）；
// 压缩后再没有新类目就垫在句尾。失败的压缩不算（官方只有真边界才有 compacted 条目）。
export function groupSummary(tools) {
  const order = [];
  const cats = new Map();   // cat → { keys:Set, err:boolean, at:首现序号 }
  const filePaths = new Set();
  let n = 0;                // 真实工具序号（压缩条目不计）
  let compactAt = -1;       // 第一次压缩之前有几个真实工具
  for (const t of tools || []) {
    if (isCompactTool(t)) { if (compactAt < 0 && t.status !== 'error') compactAt = n; continue; }
    const cat = categoryOf(t);
    const path = t.input && (t.input.file_path || t.input.notebook_path);
    const key = FILE_CATS.has(cat) && path ? path : (t.id || `${t.name}:${t.index}`);
    if (FILE_CATS.has(cat) && path) filePaths.add(path);
    let c = cats.get(cat);
    if (!c) { c = { keys: new Set(), err: false, at: n }; cats.set(cat, c); order.push(cat); }
    c.keys.add(key);
    if (toolFailed(t)) c.err = true;
    n++;
  }
  const out = [];
  let piece = compactAt >= 0 ? { verb: 'compacted', meta: 'the session', isError: false, isEvent: true } : null;
  const slot = (at) => { if (piece && at >= compactAt) { out.push(piece); piece = null; } };
  // 同一个文件被多类文件操作命中、且组里只涉及这一个文件 → "Read and edited config.ts"
  const fileCats = order.filter((c) => FILE_CATS.has(c));
  let mergedFile = false;
  if (fileCats.length > 1 && filePaths.size === 1 && fileCats.every((c) => cats.get(c).keys.size === 1)) {
    mergedFile = true;
    const verbs = fileCats.map((c) => CAT_TEXT[c](1)[0]);
    const uniq = verbs.filter((v, i) => verbs.indexOf(v) === i);
    slot(Math.min(...fileCats.map((c) => cats.get(c).at)));
    out.push({ verb: formatList(uniq), meta: basename([...filePaths][0]), isError: fileCats.some((c) => cats.get(c).err) });
  }
  for (const cat of order) {
    if (mergedFile && FILE_CATS.has(cat)) continue;
    const c = cats.get(cat);
    slot(c.at);
    const [verb, meta] = (CAT_TEXT[cat] || CAT_TEXT.other)(c.keys.size);
    out.push({ verb, meta, isError: c.err });
  }
  if (piece) out.push(piece);
  return out;
}

// —— 模型短名（shared-0 Ui/O）——
// claude-opus-4-5-20250101 → {base:"Opus 4.5"}；-fast → suffix "Fast"；[1m]/-1m → ctx "1M"；claude-3-7-sonnet → "3.7 Sonnet"
export function parseModel(id) {
  let s = str(id).trim();
  if (!s) return null;
  let ctx = '';
  const br = s.match(/\[([^\]]+)\]$/);
  if (br) { if (/1m/i.test(br[1])) ctx = '1M'; s = s.slice(0, br.index); }
  s = s.toLowerCase().replace(/^claude-/, '');
  let parts = s.split('-').filter(Boolean);
  if (parts.length > 1 && /^\d{8}$/.test(parts[parts.length - 1])) parts.pop();   // 日期后缀
  let suffix = '';
  parts = parts.filter((p) => {
    if (p === 'fast') { suffix = 'Fast'; return false; }
    if (p === '1m') { ctx = '1M'; return false; }
    return true;
  });
  if (!parts.length) return { base: cap(s), suffix, ctx };
  const nums = parts.filter((p) => /^\d+$/.test(p));
  const words = parts.filter((p) => !/^\d+$/.test(p)).map(cap);
  const ver = nums.join('.');
  let base;
  if (!words.length) base = ver;
  else if (!ver) base = words.join(' ');
  else base = /^\d/.test(parts[0]) ? `${ver} ${words.join(' ')}` : `${words.join(' ')} ${ver}`;
  return { base, suffix, ctx };
}
export function modelLabel(id) {
  const p = parseModel(id);
  return p ? [p.base, p.suffix, p.ctx].filter(Boolean).join(' ') : '';
}
// shared-0 Vi：去 [..] 后缀、去 claude- 前缀后等于 fable 或以 fable- 开头
export function isFableModel(id) {
  const s = str(id).trim().toLowerCase().replace(/\[[^\]]+\]$/, '').replace(/^claude-/, '');
  return s === 'fable' || s.startsWith('fable-');
}
// Learn more 链接（CLI uet + 官方 jL）：cyber → 实时网络安全栅门文章；fable → 15363606；opus-5 → 16049681；其它 8106465
export function learnMoreUrl(model, category) {
  if (str(category).toLowerCase() === 'cyber') return 'https://support.claude.com/en/articles/14604842-real-time-cyber-safeguards-on-claude';
  if (isFableModel(model)) return 'https://support.claude.com/en/articles/15363606';
  const s = str(model).trim().toLowerCase().replace(/\[[^\]]+\]$/, '').replace(/^claude-/, '');
  if (/^opus-5(-\d{8})?$/.test(s)) return 'https://support.claude.com/en/articles/16049681';
  return 'https://support.claude.com/en/articles/8106465';
}

// —— 数字 / 时长 ——
// xi：≥1e9 "1.2B"、≥1e6 "1.2M"、≥1e3 "12.3k"，去掉 ".0"
export function fmtCompact(n) {
  const v = Number(n) || 0;
  const f = (x, u) => (Math.round(x * 10) / 10).toFixed(1).replace(/\.0$/, '') + u;
  if (v >= 1e9) return f(v / 1e9, 'B');
  if (v >= 1e6) return f(v / 1e6, 'M');
  if (v >= 1e3) return f(v / 1e3, 'k');
  return String(Math.round(v));
}
// dD（面板用）：秒取整，尾单位补两位："05s" / "1m 05s" / "1h 02m 05s"
export function fmtDurPanel(ms) {
  const t = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const p = (v) => String(v).padStart(2, '0');
  if (h) return `${h}h ${p(m)}m ${p(s)}s`;
  if (m) return `${m}m ${p(s)}s`;
  return `${p(s)}s`;
}
// Nw（对话芯片用）："3s" / "2m 3s" / "1h 2m 3s"
export function fmtDurChip(ms) {
  const t = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  if (h) return `${h}h ${m}m ${s}s`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

// —— morph 文本切换（官方 Lg 的简化版）——
// 官方：宽度过渡 180ms + 旧文本 y-3 淡出 / 新文本 y+3 淡入。这里旧文本直接换掉，新文本
// 180ms 淡入上滑；首次挂载不动（= 官方 live 首帧不做进场）。reduced-motion 全静。
//   <span use:morphText={label}>{label}</span>
export function morphText(node, text) {
  let last = text;
  const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const play = () => {
    if (reduce || typeof node.animate !== 'function') return;
    node.animate([{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }],
      { duration: 180, easing: 'cubic-bezier(.2,0,0,1)' });
  };
  return {
    update(next) { if (next === last) return; last = next; play(); },
  };
}
