// 声明式应用 chat 积木（components/appview/ChatBlock.svelte）的数据层：一块轻量对话区，不嵌 solo 页。
// 走插件页面同一组宿主接口（服务端 src/plugins/page-chat.mjs），只是由 bridge 自己的界面用主机登录态去调：
//   GET  /api/plugin/<插件>/_bridge/grants                         → { declared, granted }（发第一句之前确认 page.chat）
//   POST /api/plugin/<插件>/_bridge/chat/start   { prompt, app }   → { sessionId }
//   POST /api/plugin/<插件>/_bridge/chat/send    { sessionId, text } → { ok, queued }
//   POST /api/plugin/<插件>/_bridge/chat/stop    { sessionId }
//   GET  /api/plugin/<插件>/_bridge/chat/history?session=          → { messages: [{ role, text }] }
//   GET  /api/plugin/<插件>/_bridge/chat/events?session=           → SSE（跨轮推送）
//   POST /api/plugin/<插件>/_bridge/chat/watch   { sessionId, visible }（正看着：这一轮结束不发系统通知）
//
// 订阅照 SDK 的 ChatSub（src/plugins/sdk/bridge-plugin.js）：fetch 读流（EventSource 带不了 Authorization 头）、
// 断了退避重连（1 秒起、翻倍到 30 秒，连上超过 10 秒的断开从 1 秒重来；4xx 里除了 408 / 425 / 429 都不再重试）、
// 按 turn 事件的轮次号去重。服务端连上时会把正在跑的那一轮从头补发一遍（turn + 缓冲里的事件，相邻正文合并成块），
// 所以这里不像 SDK 那样逐段跳过，而是更省事也更稳：认出是同一轮，就把这一轮的回复清空、按补发重画——结果和原来一字不差，
// 中间答完被删掉的提问也自然不会再冒出来。断线期间那一轮结束了（结束的轮不补发）就重拉一次历史。
//
// 正看着：订阅期间这块在前台（isForeground 由组件给，看得见、没被盖住、标签页在前台），就向 lib/notices.svelte.js 登记
// watchFromPage——这个会话完成 / 出错的横幅不弹（这块自己已经画出来了，横幅只会盖住应用顶栏）；同时每 30 秒向服务端报到一次，
// 手机 App 收起时那一轮结束照常发系统通知，看着时不发（同 SDK 独立页的报到）。提问 / 审批的横幅照弹。
import { api, authHeaders } from './api.js';
import { apiUrl } from './server.js';
import { askGrant } from './grantDialog.svelte.js';
import { watchFromPage } from './notices.svelte.js';
import { pageNav } from './pageNav.js';
import { appViews } from './appView.svelte.js';
import { me } from './state.svelte.js';
import { t, tr } from './i18n.js';

const RETRY_MIN = 1000;
const RETRY_MAX = 30_000;
const STABLE_MS = 10_000;        // 连上超过这么久再断，退避从头算
const REPLAY_WAIT_MS = 2000;     // 重连后等补发的时间：等不到 = 那一轮在断线期间结束了
const WATCH_MS = 30_000;         // 服务端报到 75 秒到期，30 秒续一次
const WATCH_PROBE_MS = 5000;     // 多久看一眼在不在前台
const SID_RE = /^[\w.:-]{1,120}$/;
const REPORT_WAIT_MS = 500;      // 上报会话 id 时应用正忙：隔多久再看一眼
const REPORT_TRIES = 120;        // 最多等一分钟（确认框挂着时人可能要想一会儿）

// 本地开起来、插件还没把它写回树里的会话 id（键见 sidKey）。积木被重建（树刷新、离开再回来）时接着用，
// 别因为插件没接 onSession / 还没回来，就把人刚开的对话丢了。只在内存里。
const localSids = new Map();

const fatalStatus = (s) => s >= 400 && s < 500 && s !== 408 && s !== 425 && s !== 429;
const turnIdOf = (ev) => ((typeof ev.turn === 'number' && ev.turn > 0) || (typeof ev.turn === 'string' && ev.turn) ? String(ev.turn) : null);
const errText = (e) => tr((e?.body && typeof e.body === 'object' ? e.body.error : typeof e?.body === 'string' ? e.body : '') || '') || '';
const needsGrant = (e) => e?.status === 403 && e?.body && typeof e.body === 'object' && e.body.needGrant === 'page.chat';
const undeclared = (e) => e?.status === 403 && e?.body && typeof e.body === 'object' && e.body.undeclared === true;

// SSE 按块拆：空行分隔，data: 行拼起来是一条 JSON；注释行（: ok / : ping 心跳）跳过（同 PluginFrame / SDK 的 readSse）
async function readSse(body, onEvent) {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf = (buf + dec.decode(value, { stream: true })).replace(/\r\n/g, '\n');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
        if (!data) continue;
        let ev;
        try { ev = JSON.parse(data); } catch { continue; }
        onEvent(ev);
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

let keySeq = 0;
const nextKey = () => 'm' + (++keySeq);

/**
 * 一块对话区的控制器。getCtx() 取积木的 ctx，isForeground() 判断这块此刻在不在使用者眼前。
 * 组件里 new 一个，挂载时 setSession(block.session)，block.session 变了再调；卸载 destroy()。
 */
export class AppChat {
  // —— 给组件读的状态 ——
  messages = $state([]);   // [{ key, role: 'user'|'assistant', text, turn?, pending?, streaming?, tools?: { n, err, active }, error?, stopped? }]
  sid = $state('');
  running = $state(false);
  approval = $state(null);  // { qid, kind, title }
  error = $state('');       // 整块的错误（拉历史失败、订阅不再重试的原因）
  needGrant = $state(false);// 没授权：显示「允许」按钮（挂载时不自己弹框——没人点就冒出授权框太突兀）
  loading = $state(false);  // 正在拉历史
  starting = $state(false); // 正在开新对话 / 发送
  stopping = $state(false);
  connected = $state(false);

  constructor({ getCtx, getBlock, isForeground }) {
    this.getCtx = getCtx;
    this.getBlock = getBlock;
    this.isForeground = isForeground || (() => false);
    this.gen = 0;            // 每换一次会话 +1：旧会话的异步回来一律作废
    this.ac = null;
    this.cur = null;         // 当前这一轮 { id, msgKey, done }
    this.turnSeq = 0;        // 收到过多少个新轮（重拉历史途中来了新轮，就别拿旧历史盖掉）
    this.expectT = 0;
    this.sleepWake = null;
    this.unwatch = null;
    this.watchT = 0;
    this.watchShown = false;
    this.watchAt = 0;
    this.everOpened = false;
    this.onOnline = () => this.sleepWake?.();
    this.onVis = () => this.watchSync();
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline);
      document.addEventListener('visibilitychange', this.onVis);
    }
  }

  get plugin() { return this.getCtx()?.plugin || ''; }
  get appKey() { return this.getCtx()?.appKey || ''; }
  base() { return '/api/plugin/' + this.plugin + '/_bridge/'; }

  /** 积木给的会话（null / '' = 还没开）。插件没接 onSession 时用本地记着的那个。 */
  setSession(blockSid) {
    const want = typeof blockSid === 'string' && SID_RE.test(blockSid) ? blockSid : localSids.get(this.sidKey()) || '';
    if (typeof blockSid === 'string' && blockSid && want === blockSid) localSids.delete(this.sidKey());   // 插件已经接住了
    if (want === this.sid) return;
    this.open(want);
  }

  /** 换到会话 sid（'' = 清空成只有输入框）。keep = 要留着的「还在路上」的那句话（刚开对话时的第一句）。 */
  open(sid, keep = null) {
    this.teardown();
    const gen = ++this.gen;
    this.sid = sid;
    this.messages = keep ? [keep] : [];
    this.running = !!keep;
    this.approval = null;
    this.error = '';
    this.needGrant = false;
    this.cur = null;
    this.everOpened = false;
    if (!sid) return;
    // 刚开的对话（keep = 第一句）：转录多半还没落盘，没有历史可拉，直接订阅；连上后等不到这一轮（已经答完）
    // 由 opened() 静默重拉历史收尾
    if (keep) { this.subscribe(gen); return; }
    this.loadHistory(gen).then((ok) => { if (ok && gen === this.gen) this.subscribe(gen); });
  }

  async loadHistory(gen, { quiet = false } = {}) {
    const sid = this.sid;
    const seq = this.turnSeq;
    if (!quiet) this.loading = true;
    try {
      const r = await api.get(this.base() + 'chat/history?session=' + encodeURIComponent(sid));
      if (gen !== this.gen) return false;
      // 拉的途中开了新的一轮：订阅流已经在画它了，这份历史比屏幕上的旧，不拿来盖
      if (quiet && seq !== this.turnSeq) return true;
      const list = Array.isArray(r?.messages) ? r.messages : [];
      const hist = list.filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string' && m.text)
        .map((m) => ({ key: nextKey(), role: m.role, text: m.text }));
      // 还在路上（发出去、还没等到它那一轮的）的几句留在最后；历史里已经有了的（最后一句用户消息就是它）不再重复
      const pend = this.messages.filter((m) => m.pending);
      const lastUser = [...hist].reverse().find((m) => m.role === 'user');
      const keep = pend.filter((p, i) => !(i === 0 && lastUser && lastUser.text === p.text && !this.cur));
      this.messages = [...hist, ...keep];
      if (quiet) { this.cur = null; this.running = false; }
      this.error = '';
      return true;
    } catch (e) {
      if (gen !== this.gen) return false;
      if (needsGrant(e)) { this.needGrant = true; return false; }
      if (!quiet) this.error = errText(e) || (e?.status ? t('服务器返回 {code}', { code: e.status }) : t('网络连接失败'));
      return !quiet ? false : true;
    } finally {
      if (gen === this.gen) this.loading = false;
    }
  }

  // —— 订阅 ——
  async subscribe(gen) {
    const sid = this.sid;
    if (!sid) return;
    // 订阅期间（含断线重连的空档）这块就是这个会话的界面
    this.unwatch?.();
    this.unwatch = watchFromPage(sid, () => gen === this.gen && this.isForeground());
    this.watchSync();
    let delay = RETRY_MIN;
    while (gen === this.gen) {
      const ac = new AbortController();
      this.ac = ac;
      let openedAt = 0;
      try {
        const res = await fetch(apiUrl(this.base() + 'chat/events?session=' + encodeURIComponent(sid)), {
          headers: authHeaders({ Accept: 'text/event-stream' }), credentials: 'same-origin', cache: 'no-store', signal: ac.signal,
        });
        if (gen !== this.gen) break;
        if (!res.ok || !res.body) {
          let j = null;
          try { j = await res.json(); } catch {}
          if (gen !== this.gen) break;
          if (fatalStatus(res.status)) {
            // 撤了授权 / 会话不归这个插件了 / 插件停了：不再重试，说清楚为什么
            if (j && j.needGrant === 'page.chat') this.needGrant = true;
            else this.error = tr((j && typeof j.error === 'string' && j.error) || '') || t('服务器返回 {code}', { code: res.status });
            this.running = false;
            break;
          }
          throw new Error('HTTP ' + res.status);
        }
        openedAt = Date.now();
        this.connected = true;
        this.opened(gen);
        await readSse(res.body, (ev) => { if (gen === this.gen) this.handle(ev); });
      } catch {
        // 网络断 / 被 abort：下面按 gen 判断要不要重连
      } finally {
        if (this.ac === ac) this.ac = null;
        if (gen === this.gen) this.connected = false;
      }
      if (gen !== this.gen) break;
      if (openedAt && Date.now() - openedAt > STABLE_MS) delay = RETRY_MIN;
      await this.sleep(delay);
      delay = Math.min(RETRY_MAX, delay * 2);
    }
    if (gen === this.gen) this.stopWatch();
  }

  sleep(ms) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(tm); this.sleepWake = null; resolve(); };
      const tm = setTimeout(done, ms);
      this.sleepWake = done;   // 网络恢复（online）就别等满退避
    });
  }

  // 连上了：重连上时，没收完的那一轮等补发，等不到（或本来就没有在跑的轮）就重拉历史，
  // 断线期间开始又结束了的轮（服务端不补发结束的轮）也就补上了。
  // 第一次连上一般什么都不用补，只有一种例外：刚开的对话（start 之后 running 已经是真）在订阅连上之前就答完了——
  // 回复很短、一开头就出错、网络慢都会这样。服务端只补发没结束的轮，这时既等不来 turn 也等不来 done，
  // 停止钮会一直挂着；所以照样等一会儿，没等到这一轮就静默重拉历史，按历史收尾
  opened(gen) {
    const first = !this.everOpened;
    this.everOpened = true;
    if (first) {
      if (!this.running || this.cur) return;
      clearTimeout(this.expectT);
      const seq = this.turnSeq;
      this.expectT = setTimeout(() => {
        if (gen === this.gen && seq === this.turnSeq && !this.cur) this.loadHistory(gen, { quiet: true });
      }, REPLAY_WAIT_MS);
      return;
    }
    clearTimeout(this.expectT);
    const want = this.cur && !this.cur.done ? this.cur.id : null;
    const seq = this.turnSeq;
    this.expectT = setTimeout(() => {
      if (gen !== this.gen) return;
      if (want && this.cur && this.cur.id === want && !this.cur.replayed) this.finishTurn({ missed: true });
      if (seq === this.turnSeq && !(this.cur && !this.cur.done)) this.loadHistory(gen, { quiet: true });
    }, want ? REPLAY_WAIT_MS : 300);
    if (this.cur) this.cur.replayed = false;
  }

  msgByKey(k) { return this.messages.find((m) => m.key === k) || null; }
  curMsg() { return this.cur ? this.msgByKey(this.cur.msgKey) : null; }

  handle(ev) {
    if (!ev || typeof ev !== 'object' || typeof ev.type !== 'string') return;
    switch (ev.type) {
      case 'turn': return this.onTurn(ev);
      case 'text': {
        const m = this.curMsg();
        if (m && typeof ev.text === 'string') m.text += ev.text;
        return;
      }
      case 'tool': {
        const m = this.curMsg();
        if (!m) return;
        // 先赋值再从 m 上读：赋值表达式的结果是原对象，不是 $state 代理，直接改它界面不会跟着变
        if (!m.tools) m.tools = { n: 0, err: 0, active: '', id: '' };
        const tl = m.tools;
        if (ev.status === 'start') { tl.n += 1; tl.active = String(ev.name || '').slice(0, 60); tl.id = String(ev.id || ''); }
        else if (ev.status === 'done') {
          if (ev.isError) tl.err += 1;
          if (!ev.id || ev.id === tl.id) { tl.active = ''; tl.id = ''; }
        }
        return;
      }
      case 'approval':
        if (ev.qid) this.approval = { qid: String(ev.qid), kind: String(ev.kind || 'permission'), title: String(ev.title || '').slice(0, 300) };
        return;
      case 'approval.done':
        if (this.approval && this.approval.qid === String(ev.qid)) this.approval = null;
        return;
      case 'done': return this.finishTurn({ ok: ev.ok, interrupted: !!ev.interrupted, result: ev.result });
      case 'error': {
        const m = this.curMsg();
        const msg = tr(String(ev.message || '')) || t('这一轮出错了');
        if (m) m.error = msg; else this.error = msg;
        return this.finishTurn({ errored: true });
      }
      default:
    }
  }

  onTurn(ev) {
    const id = turnIdOf(ev);
    const userText = String(ev.userText ?? '');
    clearTimeout(this.expectT);
    // 同一轮的补发（重连上 / 一开始订阅时它就在跑）：这一轮的回复清空，按补发从头画
    if (this.cur && id && this.cur.id === id) {
      const m = this.curMsg();
      if (m) { m.text = ''; m.tools = null; m.error = ''; m.streaming = true; m.stopped = false; }
      this.cur.done = false;
      this.cur.replayed = true;
      this.approval = null;
      this.running = true;
      return;
    }
    if (this.cur && !this.cur.done) this.finishTurn({ missed: true });
    this.turnSeq += 1;
    const list = this.messages;
    // 这一轮的问话：自己发出去还在路上的那句（按文字认，先发的先认）→ 挪到最后、收进这一轮
    let user = null;
    const pi = list.findIndex((m) => m.pending && m.text === userText);
    if (pi >= 0) {
      user = list[pi];
      list.splice(pi, 1);
      user.pending = false;
      user.turn = id;
    } else {
      // 历史里已经有这一轮的问话（拉历史时它正在跑）：从那句起截掉，接下来按流重画，免得一问两答
      let li = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        if (list[i].turn) break;
        if (list[i].role === 'user' && !list[i].pending) { li = i; break; }
      }
      if (li >= 0 && list[li].text === userText) list.splice(li);
      user = { key: nextKey(), role: 'user', text: userText, turn: id };
    }
    const pend = list.filter((m) => m.pending);
    const rest = list.filter((m) => !m.pending);
    const reply = { key: nextKey(), role: 'assistant', text: '', turn: id, streaming: true, tools: null, error: '', stopped: false };
    this.messages = [...rest, ...(userText ? [user] : []), reply, ...pend];
    this.cur = { id, msgKey: reply.key, done: false, replayed: true };
    this.approval = null;
    this.running = true;
  }

  finishTurn({ ok, interrupted = false, result, errored = false, missed = false } = {}) {
    const m = this.curMsg();
    if (m) {
      m.streaming = false;
      if (m.tools) m.tools.active = '';
      if (interrupted) m.stopped = true;
      // 只有结果没有正文（极少：工具跑完直接收尾）时拿结果当回复
      if (!m.text && typeof result === 'string' && result && ok !== false) m.text = result;
      if (ok === false && !interrupted && !errored && !m.error && !m.text) m.error = t('这一轮没有完成');
    }
    if (this.cur) this.cur.done = true;
    this.running = false;
    this.stopping = false;
    this.approval = null;
    void missed;
  }

  // —— 授权 ——
  /** 确认 page.chat：已授权直接过；没授权弹授权框。回 true = 能用。 */
  async ensureGrant() {
    const ctx = this.getCtx();
    let g = null;
    try { g = await api.get(this.base() + 'grants'); } catch (e) {
      this.error = errText(e) || t('网络连接失败');
      return false;
    }
    const declared = Array.isArray(g?.declared) && g.declared.some((p) => p && p.id === 'page.chat');
    if (!declared) { this.error = t('这个插件没有声明对话权限（page.chat），用不了对话'); return false; }
    if (g?.granted && typeof g.granted['page.chat'] === 'string') return true;
    return this.askGrant(ctx);
  }
  async askGrant(ctx = this.getCtx()) {
    const ok = await askGrant({
      plugin: this.plugin, pluginName: ctx?.app?.pluginName || this.plugin, appTitle: ctx?.app?.title || '', perm: 'page.chat',
    });
    if (ok) this.needGrant = false;
    return ok;
  }
  /** 「允许」按钮：授权后接着拉历史、订阅。 */
  async grant() {
    if (!(await this.askGrant())) return;
    const sid = this.sid;
    this.sid = '';
    this.open(sid);
  }

  // —— 发送 / 停止 ——
  /** 发一句。回 true = 发出去了（输入框可以清了）；false = 没发成，字留在输入框里。 */
  async send(text) {
    const s = String(text || '').trim();
    if (!s || this.starting) return false;
    const gen = this.gen;
    this.starting = true;
    this.error = '';
    try {
      if (!this.sid) return await this.start(s, gen);
      const pend = { key: nextKey(), role: 'user', text: s, pending: true };
      this.messages.push(pend);
      try {
        await this.post('chat/send', { sessionId: this.sid, text: s });
        return true;
      } catch (e) {
        if (gen !== this.gen) return false;
        const i = this.messages.findIndex((m) => m.key === pend.key);
        if (i >= 0) this.messages.splice(i, 1);
        this.error = errText(e) || t('没能发出去');
        return false;
      }
    } finally {
      // 开新对话成功时 open() 已换了一代，「正在发」照样要收掉
      this.starting = false;
    }
  }

  async start(s, gen) {
    if (!(await this.ensureGrant()) || gen !== this.gen) return false;
    const ctx = this.getCtx();
    const pend = { key: nextKey(), role: 'user', text: s, pending: true };
    this.messages = [pend];
    this.running = true;
    let r;
    try {
      r = await this.post('chat/start', { prompt: s, ...(ctx?.app?.id ? { app: ctx.app.id } : {}) });
    } catch (e) {
      if (gen !== this.gen) return false;
      this.messages = [];
      this.running = false;
      this.error = errText(e) || t('没能开始对话');
      return false;
    }
    if (gen !== this.gen) return false;
    const sid = typeof r?.sessionId === 'string' && SID_RE.test(r.sessionId) ? r.sessionId : '';
    if (!sid) { this.messages = []; this.running = false; this.error = t('没能开始对话'); return false; }
    const on = this.getBlock()?.onSession;
    localSids.set(this.sidKey(), sid);
    this.open(sid, pend);
    // 告诉插件：它把会话 id 存进 state，下次树里 session 就是它了（没接 onSession 也能用，只是换设备 / 重开后就没了）
    if (on && ctx?.run) this.reportSession(ctx, on, sid);
    return true;
  }

  // runAction 碰上这个应用已有动作在跑（含确认框挂着）会直接回 false、不排队，这次上报就丢了，
  // 插件永远拿不到会话 id。所以等它空下来再报；调用前同步看过空闲，runAction 一进门的防连点就不会挡它。
  // 报出去之后的失败（插件动作出错）runAction 已经弹过 toast，不重试，免得一错连弹好几次
  async reportSession(ctx, on, sid) {
    const key = ctx.appKey;
    for (let i = 0; i < REPORT_TRIES; i++) {
      // 插件已经把它写回树里了、或这块已换成别的会话，就不用再报。积木卸载了照样报完：插件要靠它记住这段对话
      let had = null;
      try { had = this.getBlock()?.session; } catch {}
      if (had === sid || this.sid !== sid) return;
      if (!appViews[key]?.busy) { await ctx.run(on, { sessionId: sid }); return; }
      await new Promise((r) => setTimeout(r, REPORT_WAIT_MS));
    }
  }

  // 本地会话记在哪个键下：应用键 + 积木的 onSession 动作名 + 登录身份。同一页挂两块 chat 时，
  // 各接各的动作名就各记各的；两块用同一个动作名，插件那边本来也是同一份会话，共用正合适
  sidKey() {
    const owner = me.kind && me.kind !== 'none' ? me.kind + ':' + (me.user || '') : '';
    return owner + '\u0001' + this.appKey + '\u0001' + (this.getBlock()?.onSession || '');
  }

  // POST，碰到 403 needGrant 先弹授权框，同意了重试一次
  async post(op, body) {
    try {
      return await api.post(this.base() + op, body);
    } catch (e) {
      if (needsGrant(e) && (await this.askGrant())) return api.post(this.base() + op, body);
      if (undeclared(e)) throw Object.assign(new Error('undeclared'), { body: { error: t('这个插件没有声明对话权限（page.chat），用不了对话') } });
      throw e;
    }
  }

  async stop() {
    if (!this.sid || this.stopping) return;
    this.stopping = true;
    try { await this.post('chat/stop', { sessionId: this.sid }); }
    catch (e) { this.error = errText(e) || t('没能停下'); this.stopping = false; }
    // 成功就等流里的 done（interrupted）把 running 收掉；流断着的话 5 秒后自己复位，别让按钮一直转
    setTimeout(() => { this.stopping = false; }, 5000);
  }

  /** 「在 Claude 里打开」/「去处理」：Claude 页打开这个会话，系统返回回到应用。 */
  openInClaude() {
    if (this.sid) pageNav(this.plugin, { to: 'session', session: this.sid }, { comeBack: true });
  }

  // —— 服务端报到「正看着」——
  reportWatch(sid, visible) {
    if (!sid || !this.plugin) return;
    api.post(this.base() + 'chat/watch', { sessionId: sid, visible }).catch(() => {});
  }
  // 每 5 秒看一眼在不在前台（取几个点，开销很小）：变成「看着」立刻报、看着时每 30 秒续一次，变成「没看着」立刻撤。
  // 只靠 30 秒一拍的话，刚打开应用时还在转场动画里（判成没看着），要等半分钟才第一次报到
  watchSync() {
    clearInterval(this.watchT);
    this.watchT = 0;
    const sid = this.sid;
    if (!sid || !this.unwatch) return;
    const check = () => {
      const fg = document.visibilityState === 'visible' && this.isForeground();
      if (fg) {
        if (!this.watchShown || Date.now() - this.watchAt >= WATCH_MS) { this.watchShown = true; this.watchAt = Date.now(); this.reportWatch(sid, true); }
      } else if (this.watchShown) { this.watchShown = false; this.reportWatch(sid, false); }
    };
    check();
    this.watchT = setInterval(check, WATCH_PROBE_MS);
  }
  stopWatch() {
    clearInterval(this.watchT);
    this.watchT = 0;
    if (this.watchShown) { this.watchShown = false; this.reportWatch(this.sid, false); }
    this.unwatch?.();
    this.unwatch = null;
  }

  teardown() {
    this.gen++;
    clearTimeout(this.expectT);
    try { this.ac?.abort(); } catch {}
    this.ac = null;
    this.sleepWake?.();
    this.stopWatch();
    this.connected = false;
    this.loading = false;
    this.stopping = false;
  }

  destroy() {
    this.teardown();
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline);
      document.removeEventListener('visibilitychange', this.onVis);
    }
  }
}
