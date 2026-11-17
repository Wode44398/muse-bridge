// 假的 Claude Agent SDK query()：按剧本吐 SDK 消息流，让特征测试跑真的 runClaudeChat 而不起 CLI 进程。
//
// 一个剧本 = 一个异步生成器函数 async function* (io)，对应一个 CLI 进程的一生：
//   · yield 出去的对象就是读循环 q.next() 拿到的 SDK 消息——拉动式，读循环不要下一帧，剧本就不往下走；
//   · await io.user() 读 stdin 上的下一条用户消息（输入流没有消息时挂住，像空闲的 CLI）；
//   · await io.pause(名字) 停在一个具名的点上，等测试驱动方 resume——驱动方只在这种点上动手，
//     时间线上「谁先谁后」因此是因果决定的，不靠微任务碰巧的先后；
//   · io.hook / io.canUseTool / io.dialog 像 CLI 那样回调宿主给的钩子，结果记进时间线。
// 进程被 abort / close / return 收掉时，剧本里挂着的等待一律以 CliGone 落地，生成器随之结束。

export class CliGone extends Error {
  constructor(why) { super('fake cli gone: ' + why); this.why = why; }
}

const abortError = () => Object.assign(new Error('Claude Code process aborted by user'), { name: 'AbortError' });

// 用户消息 → 时间线上的样子：正文全文、图片张数、优先级、带没带 uuid。
function describeUser(m) {
  const content = (m && m.message && Array.isArray(m.message.content)) ? m.message.content : [];
  return {
    text: content.filter((b) => b && b.type === 'text').map((b) => b.text).join(''),
    images: content.filter((b) => b && b.type === 'image').map((b) => b.source && b.source.media_type),
    ...(m.priority ? { priority: m.priority } : {}),
    ...(m.uuid ? { uuid: m.uuid } : {}),
  };
}

/**
 * recorder()：取一个记录函数 rec(kind, ...data)，绑在「此刻的场景」上——一个假 CLI 一生都记进起它的那个场景，
 * 场景结束后它再冒出来的动静（比如停止后 3 秒才到的兜底 abort）不许串进后面的场景。
 * snapshotOptions(options)：把 query 的 options 变成可比对的快照。
 */
export function makeFakeSdk({ recorder, snapshotOptions }) {
  const scripts = [];
  const procs = [];
  let unscripted = 0;

  function query({ prompt, options }) {
    const n = procs.length + 1;
    const tag = 'cli' + n;
    const entry = scripts.shift();
    const rec = recorder();
    rec('sdk.query', tag, snapshotOptions(options));
    if (!entry) { unscripted++; throw new Error('fake sdk: 没有给第 ' + n + ' 次 query() 排剧本'); }
    const proc = makeProc(tag, entry, prompt, options, rec);
    procs.push(proc);
    return proc.handle;
  }

  return {
    query,
    /** 排一个剧本，供下一次 query() 用。返回的 ref 在 CLI 起来后指向那个进程（ref.proc）。 */
    script(fn, control = {}) {
      const ref = { fn, control, proc: null };
      scripts.push(ref);
      return ref;
    },
    procs,
    pendingScripts: () => scripts.length,
    unscripted: () => unscripted,
  };
}

function makeProc(tag, ref, prompt, options, rec) {
  const input = prompt[Symbol.asyncIterator]();
  const signal = options.abortController ? options.abortController.signal : null;
  const control = ref.control || {};

  let dead = '';   // '' | 'abort' | 'close' | 'return'
  let killReject;
  const killed = new Promise((_, rej) => { killReject = rej; });
  killed.catch(() => {});
  const kill = (why) => { if (dead) return; dead = why; killReject(new CliGone(why)); };
  // 进程没了，挂着的等待一律以 CliGone 落地
  const alive = (p) => Promise.race([Promise.resolve(p), killed]);

  const state = { at: '', users: 0, interrupts: 0, finished: false, error: null };
  const pauses = new Map();        // 名字 → resolve
  let interruptWaiters = [];

  if (signal) {
    const onAbort = () => { rec(tag, 'aborted'); kill('abort'); };
    if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
  }

  const io = {
    options,
    signal,
    state,
    /** 读 stdin 上的下一条用户消息；输入流关了返回 null。 */
    async user() {
      state.at = 'user#' + (state.users + 1);
      const r = await alive(input.next());
      state.at = '';
      if (r.done) { rec(tag, 'stdin.end'); return null; }
      state.users++;
      rec(tag, 'stdin', describeUser(r.value));
      return r.value;
    },
    /** 停在具名的点上等驱动方放行。 */
    async pause(name) {
      state.at = name;
      await alive(new Promise((resolve) => pauses.set(name, resolve)));
      state.at = '';
    },
    /** 等一个自己发起的异步动作（比如没 await 的 canUseTool），期间停在具名的点上。 */
    async wait(name, promise) {
      state.at = name;
      try { return await alive(promise); } finally { state.at = ''; }
    },
    /** 等宿主调 q.interrupt()（已经调过就立刻过）。 */
    async interrupted() {
      if (state.interrupts > 0) { state.interrupts--; return; }
      state.at = 'interrupt';
      await alive(new Promise((resolve) => interruptWaiters.push(resolve)));
      state.interrupts--;
      state.at = '';
    },
    /** 像 CLI 那样跑某个事件的钩子（按 matcher 筛），各钩子的返回值记进时间线。 */
    async hook(event, payload = {}) {
      const groups = (options.hooks && options.hooks[event]) || [];
      const outs = [];
      for (const g of groups) {
        if (g.matcher && !new RegExp('^(?:' + g.matcher + ')$').test(String(payload.tool_name || ''))) continue;
        for (const fn of g.hooks) outs.push(await alive(fn({ hook_event_name: event, ...payload }, payload.tool_use_id || null, { signal })));
      }
      rec(tag, 'hook', event, payload.tool_name || '', outs);
      return outs;
    },
    /** 像 CLI 那样问宿主「这个工具能不能用」，结论记进时间线。 */
    async canUseTool(name, toolInput, opts = {}) {
      const r = await alive(options.canUseTool(name, toolInput, { signal, ...opts }));
      rec(tag, 'canUseTool', name, r);
      return r;
    },
    /** request_user_dialog（安全栅门暂停卡）。 */
    async dialog(request) {
      const r = await alive(options.onUserDialog(request, { signal }));
      rec(tag, 'dialog', request.dialogKind, r);
      return r;
    },
    /** 剧本故意让读循环抛错（模拟 SDK / CLI 崩掉）。 */
    crash(message) {
      const e = new Error(message);
      e.intended = true;
      throw e;
    },
  };

  const gen = ref.fn(io);

  const settle = (p) => p.then(
    (r) => { if (r.done) state.finished = true; return r; },
    (e) => {
      if (e instanceof CliGone) {
        state.finished = true;
        if (dead === 'abort') throw abortError();
        return { value: undefined, done: true };
      }
      state.finished = true;
      if (!e || !e.intended) { state.error = e; rec(tag, 'script-error', String((e && e.stack) || e)); }
      throw e;
    });

  // 控制通道：记一笔，回剧本配置的值（没配就回默认）。
  const ctl = (name, dflt) => (...args) => {
    rec(tag, 'q.' + name, ...args);
    if (dead) return Promise.reject(new Error('fake cli is gone (' + dead + ')'));
    const h = control[name];
    try { return Promise.resolve(typeof h === 'function' ? h(...args) : (h !== undefined ? h : dflt)); }
    catch (e) { return Promise.reject(e); }
  };

  const handle = {
    next() {
      if (dead === 'abort') return Promise.reject(abortError());
      if (dead) return Promise.resolve({ value: undefined, done: true });
      return settle(gen.next());
    },
    return(value) {
      rec(tag, 'q.return');
      kill('return');
      return Promise.resolve({ value, done: true });
    },
    throw(e) { kill('return'); return Promise.reject(e); },
    [Symbol.asyncIterator]() { return this; },
    close() { rec(tag, 'q.close'); kill('close'); },
    interrupt() {
      rec(tag, 'q.interrupt');
      if (dead) return Promise.reject(new Error('fake cli is gone (' + dead + ')'));
      state.interrupts++;
      const w = interruptWaiters; interruptWaiters = [];
      for (const fn of w) fn();
      return Promise.resolve();
    },
    setPermissionMode: ctl('setPermissionMode', undefined),
    setModel: ctl('setModel', undefined),
    stopTask: ctl('stopTask', undefined),
    getContextUsage: ctl('getContextUsage', null),
    getSettings: ctl('getSettings', null),
    supportedCommands: ctl('supportedCommands', []),
    applyFlagSettings: ctl('applyFlagSettings', undefined),
    initializationResult: ctl('initializationResult', {}),
    cancelAsyncMessage: ctl('cancelAsyncMessage', false),
    usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: ctl('usage', null),
  };

  const proc = {
    tag, handle, state, io,
    /** 放行一个 pause 点（剧本还没走到就报错——驱动方应先 until 到位）。 */
    resume(name) {
      const r = pauses.get(name);
      if (!r) throw new Error(`fake sdk: ${tag} 不在 pause「${name}」上（当前：${state.at || '运行中'}）`);
      pauses.delete(name);
      r();
    },
    get dead() { return dead; },
  };
  ref.proc = proc;
  return proc;
}
