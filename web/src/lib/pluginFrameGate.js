// 插件页面宿主（components/ext/PluginFrame.svelte）和 iframe 里的页面对话时的门：认谁发来的消息、什么时候往里推。
// 纯逻辑、不碰 DOM，单测见 pluginFrameGate.test.js。
//
// 光核 e.source 不够：e.source 是 iframe 的窗口，页面被链接 / 脚本导航到别的站点之后窗口还是同一个；sandbox 的 iframe 是不透明源，
// e.origin 恒为 "null"，也分不出来。所以再加两样（SDK 那头见 src/plugins/sdk/bridge-plugin.js 的 NONCE / DOC）：
//   · 口令（nonce）：宿主每次挂载随机生成，放在 iframe 地址的 # 里；SDK 发的每条消息都带上，宿主只认带对了的（hello 也一样）。
//     宿主发出去的消息一律不带口令——postMessage 只能用 '*' 发，iframe 里换成了谁都收得到。
//   · 文档号（doc）：SDK 每份文档随机一个，hello 报上来，之后每条都带。宿主只认在场那份文档的（旧文档迟到的请求、迟到的 bye
//     都对不上号）；文档离开时 SDK 报 bye，宿主收掉它的订阅和框、停止往里推，等下一个有效 hello。
//     bye 到宿主时 e.source 多半已经是 null（见 fromFrame），e.source 那一关对它放宽，靠口令和文档号认。
//   · 兜底（bye 没到，比如页面被导航到不用 SDK 的地方）：iframe 第二次及以后每 load 一次，先停推、稍等一下（askMs）再发 probe 问一声，
//     在场文档出声（答 here，或者发来别的任何一条带对口令、文档号对得上的消息）才接着推，停推期间要推的先排着；
//     到时没回音 → 同 bye 一样摘掉。稍等是因为跳页时旧文档的 bye 和 iframe 的 load 几乎同时到、谁先谁后不一定：
//     load 先到就当场问的话，probe 就落进了换上来的页面；等一下，bye 先进门把门摘了，就不用问了。
//     不一 load 就直接摘：正常跳页时新页面的 hello 先于它的 load 到，一 load 就摘会把刚连上的新页面也摘掉、再也等不到 hello。
//   · 摘错了能认回来：到点没回音不一定是走了——新页面 load 之后首屏重渲染、低端机、机器忙，主线程被占满几秒，here 就晚到。
//     SDK 那头不知道自己被摘了（hello 只在加载时发一次、请求没有超时、订阅等着永远不来的 chat.end），不认回来就整页失联到重新挂载。
//     所以记下因核实超时 / 排满摘掉的那份文档号，之后再收到它带对口令的消息就回一条 reset：SDK 拒掉在等的请求、订阅当断线重连、
//     重新 hello，宿主照新文档接上。带得对口令和这份文档号的只有那份 SDK 文档自己，认回来是安全的。
import { clipText } from './selfMount.js';

export const PROBE_MS = 5000;
// load 之后等这么久才发 probe（见上面「兜底」）。Edge 里 bye 与 load 前后只差 1ms 上下，跳到外站时 load 还先到；
// 留几百毫秒给旧文档的 bye（它在 pagehide 里发，旧页面主线程忙时会晚一点）。代价只是在场文档一声不出时，load 之后的推送多排这么一会儿
export const PROBE_ASK_MS = 300;
// 核实期间排着的推送最多这么多条（对话事件来得密）；再多就当这份文档不在了
export const QUEUE_MAX = 2000;
// SDK 的文档号是 24 位十六进制；放宽一点，形状不对的一律不认
const DOC_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * e.source 那一关（在 receive 之前；win = iframe 此刻的 contentWindow）。正常消息必须出自这个 iframe 的窗口。
 * 例外是 bye：SDK 在 pagehide 里发它，那时 iframe 已经在换文档；sandbox 的不透明源 iframe 在 Chromium / Edge 里每次导航都换进程，
 * 旧文档发的这条到宿主时 e.source 已经是 null（跳到同站不带 SDK 的页、跳到外站都一样，和 iframe 的 load 前后只差 1ms 上下、谁先不一定）。
 * 只认 e.source 是这个窗口的话 bye 从来进不了门，门要等 load 之后的 probe 超时才摘——那条 probe 还会落进换上来的外站页。
 * 放进来的 bye 照样要过 receive 的口令与文档号（两样都有的只有那份 SDK 文档自己），冒充了最坏也只是把门摘掉；别的类型不放宽。
 */
export function fromFrame(e, win) {
  if (!e || !win) return false;
  if (e.source === win) return true;
  const m = e.data;
  return e.source == null && !!m && typeof m === 'object' && m.type === 'bye';
}

/** 每次挂载一个：crypto.getRandomValues 取 bytes 个字节（至少 16），转十六进制 */
export function makeNonce(bytes = 24) {
  const b = new Uint8Array(Math.max(16, bytes | 0));
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * send(msg, transfer)：真往 iframe 里发（调用方 postMessage(msg, '*', transfer)），msg 已经是 { bp: 1, … } 且不带口令。
 * onDetach(reason)：在场文档没了（'bye' | 'load' | 'overflow'）——调用方换代、收订阅、按取消收掉挂着的框。
 *   'load' / 'overflow' 摘的之后可能认回来（receive 回 'reset'）；认回来时调用方什么都不用做，那份文档会重新 hello、照新文档接上。
 */
export function createFrameGate({ nonce, send, onDetach = null, probeMs = PROBE_MS, askMs = PROBE_ASK_MS, queueMax = QUEUE_MAX } = {}) {
  if (typeof nonce !== 'string' || nonce.length < 16) throw new Error('pluginFrameGate: nonce too short');
  if (typeof send !== 'function') throw new Error('pluginFrameGate: send is required');
  let doc = '';
  let state = 'idle';   // idle：没有在场文档（还没 hello / 已摘）| live：照常推 | probing：load 之后等在场文档出声
  let loads = 0;
  let queue = [];
  let timer = null;
  let askT = null;   // load 之后到点发 probe 的计时
  // 因 load 之后核实超时 / 排满而摘掉的那份文档号（它可能其实还在）；认回来一次、它报 bye、或者有新 hello 就清掉
  let lost = '';

  const out = (msg, transfer) => {
    const m = { ...msg, bp: 1 };
    delete m.nonce;
    send(m, transfer);
  };
  const stopProbe = () => { clearTimeout(timer); timer = null; clearTimeout(askT); askT = null; queue = []; };
  function detach(reason) {
    const had = state !== 'idle';
    // 只有「没等到回音」摘的才可能摘错；bye 是文档自己说走了
    lost = had && (reason === 'load' || reason === 'overflow') ? doc : '';
    state = 'idle';
    doc = '';
    stopProbe();
    if (had) { try { onDetach?.(reason); } catch {} }
  }
  // 在场文档出声了：核实通过，排着的按原顺序补推
  function resume() {
    const q = queue;
    stopProbe();
    state = 'live';
    for (const [msg, transfer] of q) out(msg, transfer);
  }

  return {
    get state() { return state; },
    get doc() { return doc; },
    get canPush() { return state === 'live'; },
    /**
     * 页面来的一条消息（调用方已核过 e.source 是这个 iframe 的窗口）。回：
     *   'drop'  不认（口令不对 / 没带、不是在场文档的、还没 hello）
     *   'hello' 新文档连上了：调用方换代、收旧订阅和框、回 init
     *   'bye' / 'here' 门自己处理完了，调用方不用再管
     *   'reset' 摘错了的那份文档又出声了：门已经叫它重新 hello，这条不办（SDK 收到 reset 会拒掉它）
     *   'msg'   在场文档的普通消息，照常处理
     */
    receive(m) {
      if (!m || typeof m !== 'object' || m.bp !== 1 || typeof m.nonce !== 'string' || m.nonce !== nonce) return 'drop';
      const d = typeof m.doc === 'string' && DOC_RE.test(m.doc) ? m.doc : '';
      if (m.type === 'hello') {
        if (!d) return 'drop';
        // 核实中排着的是推给旧文档的，新文档不要
        stopProbe();
        lost = '';
        doc = d;
        state = 'live';
        return 'hello';
      }
      if (!d) return 'drop';
      if (state === 'idle') {
        if (!lost || d !== lost) return 'drop';
        // 摘错了：这份文档还在。只叫一次（之后它在收到 reset 之前发来的照样不认），等它重新 hello 再照新文档接上——
        // 不当场恢复：它在收到 reset 之前发来的请求 SDK 都会拒掉，这边办了就成了页面以为失败、其实做了
        lost = '';
        if (m.type === 'bye') return 'drop';
        out({ type: 'reset' });
        return 'reset';
      }
      if (d !== doc) return 'drop';
      if (m.type === 'bye') { detach('bye'); return 'bye'; }
      // 核实中：在场文档发来的任何一条都算出声（不只 here）——它在忙着发请求，here 排在后面而已
      if (state === 'probing') resume();
      return m.type === 'here' ? 'here' : 'msg';
    },
    /** 往页面推（回话、事件、主题、上下文、对话事件、init）：在场就发，load 之后核实中先排着，没有在场文档就丢。回发出 / 排上没有 */
    push(msg, transfer) {
      if (state === 'live') { out(msg, transfer); return true; }
      if (state === 'probing') {
        if (queue.length >= queueMax) { detach('overflow'); return false; }
        queue.push([msg, transfer]);
        return true;
      }
      return false;
    },
    /** iframe 的 load 事件。第一次是挂载时装进去的那份，不管；之后每次都要在场文档答一声 */
    load() {
      loads += 1;
      if (loads < 2 || state === 'idle') return false;
      state = 'probing';
      clearTimeout(timer);
      clearTimeout(askT);
      askT = null;
      timer = setTimeout(() => detach('load'), probeMs);
      timer?.unref?.();
      // 稍等再问：这期间旧文档的 bye 进门（摘掉）、新文档 hello、在场文档出声，都会经 stopProbe 清掉这个计时，probe 就不发了
      const ask = () => { askT = null; if (state === 'probing') out({ type: 'probe' }); };
      if (askMs > 0) { askT = setTimeout(ask, askMs); askT?.unref?.(); } else ask();
      return true;
    },
    /** 宿主卸载：不再推，也不叫 onDetach（调用方自己收） */
    close() { state = 'idle'; doc = ''; lost = ''; stopProbe(); },
  };
}

// —— 对话订阅的「正看着」：断线重连的空档里先留着 ——
// SDK 退避重连的上限（bridge-plugin.js ChatSub.run 的 30 秒）
export const WATCH_HOLD_MS = 30_000;

/**
 * watch(sid, visible) → off：lib/notices.svelte.js 的 watchFromPage（登记期间 visible() 为真，这个会话的「已完成 / 出错」横幅不弹）。
 * 宿主替页面订阅的流断了（网络、服务端收掉），SDK 退避 1 到 30 秒、换一个新订阅号才重新 chat.sub；这一轮正好在空档里结束的话，
 * 完成通知到的时候一条登记都没有，横幅就盖在应用顶栏上（页面按约定收到 done{ missed: true }，横幅却也弹了）。
 * 所以流自己断了（不是页面收掉、不是换代）就按断掉的那个订阅号把登记先留着（hold），直到：
 *   · 同一会话重新订阅上（releaseSession：新登记已经在了才撤，中间不留空）；
 *   · 页面在空档里 off() / SDK 不再重试——SDK 拿断掉的那个订阅号补一条 chat.unsub（release）；
 *   · 页面换代 / 卸载（clear）；
 *   · 兜底计时 holdMs：SDK 每次重试 chat.sub 都续一次（refresh），只要它还在重连就一直留着；消息丢了、老 SDK 不补 unsub 也最多留这么久。
 * 每个 iframe 一份：别的页面登记的同一会话不受影响。
 */
export function createWatchHold({ watch, holdMs = WATCH_HOLD_MS } = {}) {
  if (typeof watch !== 'function') throw new Error('pluginFrameGate: watch is required');
  const held = new Map();   // 断掉的订阅号 → { sid, off, timer }
  function release(sub) {
    const h = held.get(sub);
    if (!h) return false;
    held.delete(sub);
    clearTimeout(h.timer);
    try { h.off?.(); } catch {}
    return true;
  }
  function arm(sub, h) {
    clearTimeout(h.timer);
    h.timer = setTimeout(() => { if (held.get(sub) === h) release(sub); }, holdMs);
    h.timer?.unref?.();
  }
  return {
    /**
     * 订阅号 sub（会话 sid）的流自己断了：按 visible（不再看订阅在不在，只看页面还在不在、在不在眼前）留一条登记。
     * 先登新的、调用方再撤流上那条，中间不留空；同一订阅号已经留着的换成这条
     */
    hold(sub, sid, visible) {
      const k = String(sub || '');
      const s = String(sid || '');
      if (!k || !s) return;
      const off = watch(s, visible);
      release(k);
      const h = { sid: s, off, timer: null };
      held.set(k, h);
      arm(k, h);
    },
    /** 页面拿断掉的订阅号补的 chat.unsub：它不会再重连了 */
    release: (sub) => release(String(sub || '')),
    /** 同一会话又订阅上了（调用方已经登了新的）：这个会话留着的全撤 */
    releaseSession(sid) {
      const s = String(sid || '');
      let n = 0;
      for (const [k, h] of [...held]) if (h.sid === s && release(k)) n += 1;
      return n;
    },
    /** SDK 又来 chat.sub 这个会话了（还在重连）：兜底计时从头算 */
    refresh(sid) {
      const s = String(sid || '');
      for (const [k, h] of held) if (h.sid === s) arm(k, h);
    },
    /** 页面换代 / 卸载：全撤 */
    clear() { for (const k of [...held.keys()]) release(k); },
    has: (sub) => held.has(String(sub || '')),
    get size() { return held.size; },
  };
}

// —— 确认框（bridge.confirm）：插件给的字都要收拾过才进 bridge 画的框 ——
export const CONFIRM_TITLE_MAX = 120;
export const CONFIRM_DESC_LINES = 8;
export const CONFIRM_DESC_MAX = 500;
export const CONFIRM_YES_MAX = 20;
const NEWLINE = /\r\n|[\n\r\u000b\u000c\u0085\u2028\u2029]/;

// 截到 max 个字（含末尾省略号），不劈开代理对
function cut(s, max) {
  if (s.length <= max) return s;
  let n = max - 1;
  const c = s.charCodeAt(n - 1);
  if (c >= 0xd800 && c <= 0xdbff) n -= 1;
  return s.slice(0, n).trimEnd() + '…';
}

/**
 * 说明：逐行过 clipText（去掉双向控制符——一个没收尾的反向覆盖能把后面 bridge 写的字也翻过去；行内控制符换空格），
 * 连续空行并成一行、去首尾空行，最多 CONFIRM_DESC_LINES 行、总共 CONFIRM_DESC_MAX 字，截掉了末尾给省略号
 */
export function confirmDesc(v) {
  let s;
  try { s = v == null ? '' : String(v); } catch { s = ''; }
  // 先粗截一刀：超长串不必整串分行
  const lines = s.slice(0, CONFIRM_DESC_MAX * 4).split(NEWLINE).map((l) => clipText(l, CONFIRM_DESC_MAX));
  const kept = [];
  for (const l of lines) {
    if (!l && (!kept.length || !kept[kept.length - 1])) continue;
    kept.push(l);
  }
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  let more = s.length > CONFIRM_DESC_MAX * 4;
  if (kept.length > CONFIRM_DESC_LINES) {
    kept.length = CONFIRM_DESC_LINES;
    while (kept.length && !kept[kept.length - 1]) kept.pop();
    more = true;
  }
  let text = kept.join('\n');
  if (text.length > CONFIRM_DESC_MAX) return cut(text, CONFIRM_DESC_MAX);
  if (more && text) text = cut(text + '…', CONFIRM_DESC_MAX);
  return text;
}

/** bridge.confirm 的 { title, desc, yes } → 框里的正文（一行）/ 细节 / 确定按钮字样；空的由调用方填默认字样 */
export function confirmParts(m) {
  const o = m && typeof m === 'object' ? m : {};
  return {
    message: clipText(o.title, CONFIRM_TITLE_MAX),
    detail: confirmDesc(o.desc),
    okLabel: clipText(o.yes, CONFIRM_YES_MAX),
  };
}
