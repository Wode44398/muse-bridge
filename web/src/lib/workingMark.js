// 新版 Claude Code（桌面端 2.26454 /code 页）运行标记「WorkingMark」的活动判定——
// 移植自官方 c77e464d3（工具→活动）+ shared-5 Vh（工具名→类别）。活动决定标记演哪一套：
// default 球 / think 思考 / search 搜索 / read 读 / code 跑命令 / write 写 / compose 羽毛笔（写文档）/ blocked 等人。
// 素材与状态机见 components/ClaudeWorkingMark.svelte。

// 工具名 → 类别（官方 Vh）：CamelCase 拆成 snake_case 再查；mcp__srv__tool 取末段。
const CATEGORY = {
  read: 'read', view: 'view', write: 'write', create_file: 'write', edit: 'edit', multi_edit: 'edit',
  str_replace: 'edit', str_replace_editor: 'edit', update_file: 'edit', open_file: 'read', close_file: 'read',
  delete_file: 'delete_file', file_search: 'glob', present_files: 'share', send_user_file: 'share',
  notebook_edit: 'notebook_edit', repl: 'code', java_script: 'code', glob: 'glob', grep: 'grep',
  recent_chats: 'past_chats', conversation_search: 'past_chats', project_knowledge_search: 'project_knowledge',
  drive_search: 'drive_search', web_fetch: 'web_fetch', web_search: 'web', web_search_fast: 'web',
  bash: 'bash', bash_tool: 'bash', power_shell: 'bash', task: 'task', agent: 'task', skill: 'skill',
  todo_write: 'plan', kill_bash: 'kill_bash', kill_shell: 'kill_bash', bash_output: 'bash', tmux: 'tmux',
  exit_plan_mode: 'exit_plan_mode', tool_search: 'tool_search',
};
// 类别 → 活动（官方 f）
const CAT_ACT = {
  web: 'search', web_fetch: 'search', read: 'read', view: 'read', glob: 'read', grep: 'read', past_chats: 'read',
  project_knowledge: 'read', drive_search: 'read', share: 'read', write: 'write', edit: 'write', notebook_edit: 'write',
  delete_file: 'write', todo: 'write', plan: 'write', bash: 'code', code: 'code', kill_bash: 'code', tmux: 'code',
};
const SEARCH = new Set(['image_search', 'launch_extended_search_task']);
const READ_W = new Set(['read', 'view', 'get', 'list', 'fetch', 'search', 'find', 'query', 'retrieve', 'lookup', 'load', 'open', 'ls']);
const WRITE_W = new Set(['write', 'edit', 'create', 'update', 'delete', 'remove', 'append', 'insert', 'replace', 'patch', 'send', 'post', 'add', 'save', 'upload', 'comment', 'artifacts']);
const CODE_W = new Set(['bash', 'exec', 'execute', 'run', 'shell', 'python', 'repl', 'script', 'eval', 'javascript']);
const DOC_EXT = new Set(['md', 'mdx', 'txt', 'rst', 'docx', 'pdf']);

const bare = (name) => String(name || '').split('__').pop();
const snake = (name) => bare(name).replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase();

// 命令描述首个动词（Bash 的 description「Read config」→ read）：官方 v()/_()
function verbForms(s) {
  const w = /^\s*([A-Za-z]+)/.exec(s)?.[1]?.toLowerCase();
  if (!w) return [];
  if (w.endsWith('ing') && w.length > 5) { const b = w.slice(0, -3); return [w, b, b + 'e', b.replace(/([b-df-hj-np-tv-z])\1$/, '$1')]; }
  if (w.endsWith('ies')) return [w, w.slice(0, -3) + 'y'];
  if (w.endsWith('s') && !w.endsWith('ss') && w.length > 3) return [w, w.slice(0, -1), w.slice(0, -2)];
  return [w];
}
function bashByDesc(input) {
  if (typeof input?.description !== 'string') return;
  for (const f of verbForms(input.description)) { if (WRITE_W.has(f)) return 'write'; if (READ_W.has(f)) return 'read'; }
}

function baseActivity(name, input) {
  const cat = CATEGORY[snake(name)];
  if (cat) return (cat === 'bash' ? bashByDesc(input) : undefined) ?? CAT_ACT[cat] ?? 'default';
  const n = snake(name);
  if (SEARCH.has(n)) return 'search';
  if (n.startsWith('memory_')) return /^memory_(read|list|search|view)$/.test(n) ? 'read' : 'write';
  for (const p of n.split(/[\s:_-]+/)) {
    if (WRITE_W.has(p)) return 'write';
    if (CODE_W.has(p)) return 'code';
    if (READ_W.has(p)) return 'read';
  }
  return 'default';
}

// 正在跑的「写文件」若写的是文档（.md/.txt/.pdf…）→ compose 羽毛笔（官方 C()）
function isDocWrite(input) {
  const p = input && (input.file_path || input.path || input.notebook_path);
  if (typeof p !== 'string') return false;
  const base = p.split(/[\\/]/).pop();
  const i = base.lastIndexOf('.');
  return i > 0 && DOC_EXT.has(base.slice(i + 1).toLowerCase());
}

export function toolActivity(name, input, running = false) {
  const a = baseActivity(name, input);
  return a === 'write' && running && isDocWrite(input) ? 'compose' : a;
}

// 一条流式消息此刻该演哪一套：{ activity, state }，state ∈ working | blocked。
// 相位由 chat 内核维护（见 chat.svelte.js PHASE）；工具期取最后一个还在跑的工具（官方 A()）。
export function markActivity(m) {
  if (m.paused || m.segments.some((s) => s.kind === 'ask' && !s.answered)) return { activity: 'default', state: 'blocked' };
  if (m.bgHold) return { activity: 'default', state: 'working' };
  const p = m.phase;
  if (p === 'thinking' || p === 'shimmer') return { activity: 'think', state: 'working' };
  if (p === 'waiting') return { activity: 'default', state: 'blocked' };
  if (p === 'tool') {
    for (let i = m.segments.length - 1; i >= 0; i--) {
      const s = m.segments[i];
      if (s.kind !== 'tools') continue;
      for (let j = s.tools.length - 1; j >= 0; j--) {
        const tl = s.tools[j];
        if (tl.status === 'done' || tl.status === 'error' || tl.status === 'stopped') continue;
        return { activity: toolActivity(tl.name, tl.input, true), state: 'working' };
      }
    }
    return { activity: 'default', state: 'working' };
  }
  return { activity: 'default', state: 'working' };   // writing（吐正文）：官方无工具无思考 = default
}

// 聊天页同款（sprite）只分三段：还没有可见输出（正文 / 工具）= pending（spark 星形）；
// 开始出东西 = working（nodes）；等人回答 = blocked（方块）。思考期间仍算 pending。
export function spritePhase(m) {
  if (m.paused || m.segments.some((s) => s.kind === 'ask' && !s.answered)) return 'blocked';
  if (m.phase === 'waiting' && !m.bgHold) return 'blocked';
  const out = m.segments.some((s) => (s.kind === 'text' && s.md.trim()) || (s.kind === 'tools' && s.tools.length) || s.kind === 'media');
  return out ? 'working' : 'pending';
}
