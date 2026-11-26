// Codex 分页的状态（Svelte 5 runes）。设置页那份数据面是 lib/codex/settings.svelte.js（导出名 cx），这里叫 codex，别混。
//
// 线程按 id 缓存在 codex.threads 里：一个线程在后台跑着时，它的事件照样归进它自己那份，切回来就是最新的。
// 还没建好的新线程用 NEW 这个键，等 SSE 的 session 事件给了真 id 再挪过去。

export const NEW = 'new';

export const codex = $state({
  booted: false,
  // —— 列表 ——
  projects: [],            // [{ id, name, path }]
  sessions: [],            // [{ id, title, mtime, projectId, projectName, accountId, parentId, archived }]
  listError: '',
  host: '',                // 跑 Codex 的那台机器名（托盘「本地 · <机器名>」）
  // —— 正在看的 ——
  sessionId: '',           // '' = 首页（新线程）
  projectId: '',           // 新线程落在哪个项目（首页那句话里的项目名、托盘第一颗）
  threads: {},             // id -> 线程（见 blankThread）
  unread: {},              // id -> 'done' | 'error'：在后台跑完、还没看
  liveRuns: {},            // id -> { startedAt, userText }：总线报的在跑（别的设备发起的也在这里）
  // —— 输入栏 ——
  model: '',
  effort: '',
  fast: false,
  perm: '',                // 'ask' | 'auto' | 'full'（'' = 跟随设置里这个身份的默认档）
  plan: false,             // 计划模式（Shift+Tab）
  // —— 号池 / 用量 / 模型 / 设置 ——
  pool: null,
  usage: null,             // 当前看的号的额度视图（形状同 GET /api/codex/usage）
  usageAccount: '',        // usage 是哪个号的
  models: null,            // GET /api/codex/models 原样
  settings: null,          // GET /api/codex/settings 的 effective
  // —— 视图 ——
  view: 'threads',         // 窄栏：threads | tasks | plugins | library
  sideOpen: true,          // 桌面侧栏
  drawer: false,           // 手机抽屉
  search: '',              // 侧栏搜索
  searching: false,
  history: [],             // 上一个 / 下一个线程（桌面客户端标题栏的 ‹ ›）
  histAt: -1,
});

export function blankThread(id, patch = {}) {
  return {
    id,
    turns: [],
    loaded: false,
    loading: false,
    error: '',
    cursor: null,            // 更早的轮（thread/turns 的 nextCursor）
    ask: null,               // 待你决定的审批 / 提问（SSE 的 perm_request / question 原样，带 kind）
    queue: [],               // 排队的消息 [{ id, text }]
    ctx: null,               // 上下文用量 { used, total, pct }
    last: null,              // 上一轮实际用的 { model, effort, serviceTier, sandbox, approvalPolicy }
    accountId: '',
    projectId: '',
    title: '',
    running: false,
    ...patch,
  };
}

/** 取（没有就建）一个线程的缓存。 */
export function threadOf(id) {
  const k = id || NEW;
  if (!codex.threads[k]) codex.threads[k] = blankThread(k === NEW ? '' : k);
  return codex.threads[k];
}

codex.threads[NEW] = blankThread('');
const EMPTY = blankThread('');

/** 正在看的那个线程（首页时是 NEW 那份）。组件里：const thread = $derived(current())。
 *  这里不建缓存（$derived 里改状态会报错）：切线程的动作先 threadOf 建好再改 sessionId。 */
export function current() {
  return codex.threads[codex.sessionId || NEW] || EMPTY;
}

/** 最后一轮（没有返回 null）。 */
export const lastTurn = (thread) => (thread?.turns?.length ? thread.turns[thread.turns.length - 1] : null);

/** 线程现在在干什么：侧栏状态列、顶栏、吉祥物都读它。think | exec | ask | write | unread | error | '' */
export function leadOf(id) {
  const th = codex.threads[id];
  const t = lastTurn(th);
  if (th?.ask) return 'ask';
  if (t?.live) return t.status === 'ask' ? 'ask' : t.status === 'write' ? 'write' : t.status === 'exec' ? 'exec' : 'think';
  if (codex.liveRuns[id]) return 'think';
  const u = codex.unread[id];
  if (u === 'error') return 'error';
  if (u) return 'unread';
  return '';
}

export function projectOf(id) {
  return codex.projects.find((p) => p.id === id) || null;
}

export function sessionMeta(id) {
  return codex.sessions.find((s) => s.id === id) || null;
}
