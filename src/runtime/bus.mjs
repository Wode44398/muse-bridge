// 账号级事件总线（"刚发生了什么"），与 gen.mjs（"这一轮吐了什么"）互补。
//
// gen 缓冲已经解决了【一轮之内】的跨设备实时：任何设备 POST /api/attach?session=<id>
// 都能收到同一份字节流（思考/吐字/工具/提问卡全在里面）。缺的是【轮与轮之间、会话与
// 会话之间】的变化通知——谁开跑了、谁结束了、哪个 transcript 又长了、哪个会话在等人
// 回答。以前没有任何推送通道，客户端只能靠「进 claude 页刷一次列表」+「4s 轮询
// /api/active」凑合，于是手机上新建的会话电脑端根本不冒出来，非要退出去强制刷新。
//
// 这里给每个 caller key 一条常驻 SSE（POST /api/stream），推四类事件：
//   {type:'run.start',   sessionId, userText, startedAt, source}
//   {type:'run.end',     sessionId, pending}   ← pending：同会话还有别的在等你（questions.mjs pendingFor）
//   {type:'session.touch', sessionId, mtime}  ← 含不经 bridge 的写入（CLI / 桌面 Claude Code / routines）
//   {type:'question',    sessionId, pending}
//   {type:'suggestion',  sessionId, text, at}  ← 定局后 CLI 预测的下一句（输入建议，见 runtime/suggestions.mjs）
//   {type:'archive',     archive}             ← 会话归档 / 取消归档（runtime/session-archive*.mjs）
//   {type:'session.gone', sessionId}          ← 会话被删（侧栏翻页拿回来的老行、已归档列表就地摘掉）
// 客户端据此就地增量更新会话列表，并把「正在看的这个会话在别处开跑了」变成 0 延迟挂载。
//
// key 就是 identity 的 ctx.key（'admin' / 'u:<name>' / 'c:<token>'），与 gen 注册表同一把
// 尺子——所以「同账号的所有设备」天然共享一条总线，而不同账号之间互不可见。

import { sseWrite, HEARTBEAT_MS } from './sse.mjs';

const _subs = new Map(); // key -> Set<res>

// 单个 key 的订阅上限。一台设备一条，多开几个标签页也就几条；给到 8 是为了在
// 「客户端异常没断干净」时有个上界，超出踢最老的那条（它多半已经是死连接）。
const MAX_PER_KEY = 8;

export function busPublish(key, obj) {
  const set = _subs.get(key);
  if (!set || !set.size) return;
  for (const res of set) sseWrite(res, obj);
}

// 全服广播（agent 开关这类「所有在线客户端都该知道」的变化）。含快照访客的 key——它们不认识的
// 事件类型前端直接忽略。
export function busPublishAll(obj) {
  for (const set of _subs.values()) for (const res of set) sseWrite(res, obj);
}

export function busSubscribers(key) {
  const set = _subs.get(key);
  return set ? set.size : 0;
}

// 订阅。返回一个 unsubscribe——调用方（路由）在 res close 时调用；重复调用无害。
export function busSubscribe(key, res) {
  let set = _subs.get(key);
  if (!set) { set = new Set(); _subs.set(key, set); }
  while (set.size >= MAX_PER_KEY) {
    const oldest = set.values().next().value;
    set.delete(oldest);
    try { if (!oldest.writableEnded) oldest.end(); } catch {}
  }
  set.add(res);
  let gone = false;
  return () => {
    if (gone) return;
    gone = true;
    const s = _subs.get(key);
    if (!s) return;
    s.delete(res);
    if (!s.size) _subs.delete(key);
  };
}

// 心跳：一个进程级 interval 管所有订阅者（每 key 一个 timer 在多用户下就太碎了）。
// 与 gen 的心跳同频（sse.mjs HEARTBEAT_MS，10s）——Cloudflare 隧道的空闲判据一致，前端看门狗也按
// 「多久没收到任何字节」判死，所以这条 ping 同时兼任存活信号。
// unref：这个 timer 绝不该拖住进程退出。
let _hb = null;
function ensureHeartbeat() {
  if (_hb) return;
  _hb = setInterval(() => {
    if (!_subs.size) { clearInterval(_hb); _hb = null; return; }
    for (const set of _subs.values()) {
      for (const res of set) { if (!res.writableEnded) { try { res.write(': ping\n\n'); } catch {} } }
    }
  }, HEARTBEAT_MS);
  if (_hb.unref) _hb.unref();
}

// 路由用的门面：订阅 + 起心跳，返回 unsubscribe。onDrop = 被 busDropKey 强制断开时要做的收尾
// （路由的 cleanup：退订 + 关 session-watch）；res.end() 之后 'close' 一般也会来，这里不依赖它。
const _onDrop = new WeakMap();   // res -> onDrop
export function busAttach(key, res, onDrop = null) {
  const off = busSubscribe(key, res);
  if (typeof onDrop === 'function') _onDrop.set(res, onDrop);
  ensureHeartbeat();
  return off;
}

// 结束这个 key 的订阅（删号时用：半死的连接——手机切到后台、隧道那头没断干净——等不到它自己断开）。
// 只动经 busAttach 登记了 onDrop 的（/api/stream 路由都是）：逐条摘掉、调 onDrop（退订 + 关 session-watch）、结束响应。
// 没登记收尾的订阅（只有直接 busSubscribe 的调用方）不知道还挂着什么，原样留着。返回断开了几条。
export function busDropKey(key) {
  const set = _subs.get(key);
  if (!set || !set.size) return 0;
  let n = 0;
  for (const res of [...set]) {
    const fn = _onDrop.get(res);
    if (!fn) continue;
    _onDrop.delete(res);
    set.delete(res);
    try { fn(); } catch {}
    try { if (!res.writableEnded) res.end(); } catch {}
    n++;
  }
  if (!set.size && _subs.get(key) === set) _subs.delete(key);
  return n;
}
