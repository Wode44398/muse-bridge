// Antigravity 的排队消息：一轮还在跑时发来的话先存在服务端，这一轮收尾后自动作为下一轮发出去。
//
// 为什么放服务端而不是前端自己攒着：手机切到后台 JS 就冻住了，前端攒的话要等人回到页面才发得出去——
// 「发完就走」不成立。ACP 的 session/prompt 同一会话不能并发，所以只能排队，做不到一轮中途插话。
// 规则（agents/agy.mjs 的收尾处执行）：
//   · 正常完成 → 取队首接着跑（一条一轮，按先后）；
//   · 人按了停止 → 整队退回给客户端放回输入框（同 Claude Code：打断后排着的话回到输入框让你改）；
//     例外是「立即发送」某一条——停下手头这一步、马上把它发出去；
//   · 出错 → 整队退回（agy 自己都没跑通，别接着往里塞）。
// 只存内存：服务重启即清空（那一轮本身也断了）。按「身份 + 会话」分队。

const MAX_PER_SESSION = 10;
const queues = new Map();   // `${genKey}\0${sessionId}` -> [item]
let seq = 0;

const qkey = (genKey, sid) => `${genKey}\0${sid}`;

// 对外的样子（附件只给界面要用的那几项；绝对路径照给——这是管理员自己的会话）
export function queueView(item) {
  if (!item) return null;
  return {
    id: item.id,
    text: item.text,
    atts: Array.isArray(item.atts) ? item.atts : [],
    at: item.at,
  };
}

export function listQueue(genKey, sid) {
  if (!sid) return [];
  return (queues.get(qkey(genKey, sid)) || []).map(queueView);
}

// 入队。满了返回 null。item = { text, attachments:[已过守卫的绝对路径], atts:[界面附件], opts:{ model, thoughtLevel, mode } }
export function enqueue(genKey, sid, { text = '', attachments = [], atts = [], opts = {}, client = null, vizPlatform = '' } = {}) {
  if (!sid) return null;
  const k = qkey(genKey, sid);
  const list = queues.get(k) || [];
  if (list.length >= MAX_PER_SESSION) return null;
  const item = {
    id: `q${Date.now().toString(36)}${(++seq).toString(36)}`,
    text: String(text || ''),
    attachments: Array.isArray(attachments) ? [...attachments] : [],
    atts: Array.isArray(atts) ? atts : [],
    opts: opts && typeof opts === 'object' ? { ...opts } : {},
    client: client || null,   // 这条是从哪台客户端发来的（开跑时设备工具的「发自哪台」按它）
    vizPlatform: vizPlatform === 'mobile' ? 'mobile' : (vizPlatform ? 'desktop' : ''),   // 内嵌图表按哪种屏幕出图
    at: Date.now(),
  };
  list.push(item);
  queues.set(k, list);
  return item;
}

export function removeQueued(genKey, sid, id) {
  const k = qkey(genKey, sid);
  const list = queues.get(k);
  if (!list) return null;
  const i = list.findIndex((x) => x.id === id);
  if (i < 0) return null;
  const [item] = list.splice(i, 1);
  if (!list.length) queues.delete(k);
  return item;
}

// 取下一条：给了 id 就取那一条（「立即发送」），否则队首
export function takeNext(genKey, sid, id = '') {
  const k = qkey(genKey, sid);
  const list = queues.get(k);
  if (!list || !list.length) return null;
  const i = id ? list.findIndex((x) => x.id === id) : 0;
  const [item] = list.splice(i < 0 ? 0 : i, 1);
  if (!list.length) queues.delete(k);
  return item || null;
}

// 整队取走（退回给客户端）
export function drainQueue(genKey, sid) {
  const k = qkey(genKey, sid);
  const list = queues.get(k) || [];
  queues.delete(k);
  return list;
}

export function _resetQueuesForTest() { queues.clear(); seq = 0; }
