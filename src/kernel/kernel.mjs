// 插件内核：bridge 的功能都按「插件」组织——内置功能（定时任务、分享、设备、手机操控……）、
// 三个 agent 扩展（Vertex / Codex / dimensio）和别人写的第三方插件走同一套机制。
//
// 概念（参照 cordis / DeepSeek Harness 的插件树，按 bridge 的规模裁小）：
//   插件     清单（id、名称、说明、依赖、配置 schema）+ 入口模块（apply(ctx, config)）。
//            清单先登记，入口按需加载：关着的插件连代码都不 import。
//   上下文   每个启用中的插件一份 ctx。插件经它挂路由、贡献 Claude 工具、开定时器、提供服务……
//            登记的东西都记成「撤销函数」，停用 / 改配置 / 重载时按相反顺序全部撤掉——插件自己不用写清理代码。
//   服务     ctx.provide(名字, 对象) / ctx.service(名字)：插件之间不互相 import，按名字取能力。核心先提供
//            router、auth、bus 等；插件提供的服务随插件停用一起撤掉。
//   扩展槽   kernel.slot(名字)：核心在固定位置读的「贡献列表」（Claude 工具、聊天 agent、定时任务引擎……）。
//   混入     kernel.mixin(名字, 工厂)：给 ctx 加便捷方法（ctx.route、ctx.agentOp…），由 bridge 的接线层定义，
//            内核本身不认识任何 bridge 业务，单测不用起服务。
//   阶段     ctx.when('ready' | 'listening', fn)：开始监听之类的时刻；插件在那之后才启用就当场调用。
//
// 启停：默认按目录里的 defaultEnabled，用户的选择存在 store（数据根的 plugins.json）。依赖没起来的插件
// 记成「blocked」，等依赖起来自动跟上；停用一个插件会先停掉依赖它的。
// restart:true 的插件（包了老代码、import 时就有副作用的）运行中不热插拔：改开关 / 配置只落盘，标 pending，下次启动生效。

import { normalizeSchema, resolveConfig, validateConfig, maskConfig, ConfigError } from './schema.mjs';

export { ConfigError };

const PHASES = ['ready', 'listening'];
const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;

export function memoryStore(init = {}) {
  let state = { version: 1, plugins: {}, local: [], ...init };
  return { load: () => state, save: (s) => { state = s; } };
}

function createSlot(name, onChange) {
  const entries = [];   // { item, owner, seq }
  let seq = 0;
  const listeners = new Set();
  const notify = () => { for (const fn of listeners) { try { fn(); } catch {} } onChange?.(name); };
  return {
    name,
    add(item, owner = 'core') {
      const e = { item, owner, seq: seq++ };
      entries.push(e);
      notify();
      let done = false;
      return () => {
        if (done) return;
        done = true;
        const i = entries.indexOf(e);
        if (i >= 0) entries.splice(i, 1);
        notify();
      };
    },
    // 按 item.order（小的在前，缺省 0）排，同序按登记先后。
    entries() { return entries.slice().sort((a, b) => ((a.item?.order ?? 0) - (b.item?.order ?? 0)) || a.seq - b.seq); },
    list() { return this.entries().map((e) => e.item); },
    get size() { return entries.length; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  };
}

// 插件模块的两种写法都认：export default { apply, … } 或具名导出 export function apply / export const config。
export function normalizeDef(mod) {
  const m = mod && typeof mod === 'object' ? mod : {};
  const d = m.default && typeof m.default === 'object' && typeof m.default.apply === 'function' ? m.default : m;
  if (typeof d.apply !== 'function') throw new Error('插件入口没有导出 apply(ctx, config) 函数');
  return { apply: d.apply, config: d.config || null };
}

export function createKernel({ store = memoryStore(), logger = console } = {}) {
  const records = new Map();       // id → 记录
  const services = new Map();      // 名字 → { value, owner }
  const slots = new Map();
  const mixins = new Map();        // 名字 → (ctx) => 值
  const listeners = new Map();     // 事件 → Set<fn>
  const reached = new Set();       // 已到达的阶段
  let regSeq = 0;
  let started = false;
  let queue = Promise.resolve();

  // 所有改动排成一列，免得开关、改配置、重载交错着跑。
  const serial = (fn) => {
    const p = queue.then(fn, fn);
    queue = p.then(() => {}, () => {});
    return p;
  };

  const emit = (event, payload) => {
    for (const fn of listeners.get(event) || []) { try { fn(payload); } catch (e) { logger.error?.('[plugins] 事件 ' + event + ' 的监听出错：', e?.message || e); } }
  };
  const changed = (id) => emit('change', { id });

  // ── 状态存储 ────────────────────────────────────────────────────────────
  const readState = () => {
    let s;
    try { s = store.load(); } catch (e) { logger.error?.('[plugins] 读插件状态失败：', e?.message || e); }
    if (!s || typeof s !== 'object') s = {};
    if (!s.plugins || typeof s.plugins !== 'object') s.plugins = {};
    if (!Array.isArray(s.local)) s.local = [];
    s.version = 1;
    return s;
  };
  const writeState = (mutate) => { const s = readState(); mutate(s); store.save(s); return s; };
  const storedOf = (id) => readState().plugins[id] || {};
  const wantEnabled = (rec) => {
    if (rec.locked) return true;
    const e = storedOf(rec.id).enabled;
    return typeof e === 'boolean' ? e : rec.defaultEnabled !== false;
  };
  const storedConfig = (id) => { const c = storedOf(id).config; return c && typeof c === 'object' ? c : {}; };

  // ── 依赖排序：按 requires 拓扑排序，同层保持登记顺序。环里的插件记错误、不启用。 ──────────
  function ordered() {
    const out = [];
    const mark = new Map();   // id → 1 进行中 / 2 完成
    const cyclic = new Set();
    const visit = (rec, stack) => {
      const m = mark.get(rec.id);
      if (m === 2) return;
      if (m === 1) { for (const id of stack.slice(stack.indexOf(rec.id))) cyclic.add(id); return; }
      mark.set(rec.id, 1);
      for (const dep of rec.requires) { const d = records.get(dep); if (d) visit(d, [...stack, rec.id]); }
      mark.set(rec.id, 2);
      out.push(rec);
    };
    for (const rec of [...records.values()].sort((a, b) => a.seq - b.seq)) visit(rec, []);
    return { list: out, cyclic };
  }

  // ── 插件上下文 ──────────────────────────────────────────────────────────
  class PluginContext {
    constructor(rec, config) {
      this.id = rec.id;
      this.config = Object.freeze({ ...config });
      this.meta = Object.freeze({ id: rec.id, name: rec.name, version: rec.version, source: rec.source, dir: rec.dir });
      this._disposers = [];
      this._alive = true;
      const tag = '[plugin:' + rec.id + ']';
      this.log = (...a) => logger.log?.(tag, ...a);
      this.warn = (...a) => (logger.warn || logger.log)?.(tag, ...a);
      this.error = (...a) => (logger.error || logger.log)?.(tag, ...a);
      for (const [name, factory] of mixins) {
        if (name in this) continue;
        try { this[name] = factory(this); } catch (e) { this.error('混入 ' + name + ' 出错：', e?.message || e); }
      }
    }
    get alive() { return this._alive; }
    _track(d) {
      if (typeof d === 'function') this._disposers.push(d);
      else if (d && typeof d.dispose === 'function') this._disposers.push(() => d.dispose());
      else if (d && typeof d.close === 'function') this._disposers.push(() => d.close());
      return d;
    }
    // 跑一个「装上」动作，返回值若是撤销函数（或带 dispose/close 的对象）就记下，停用时调用。
    effect(fn) {
      if (!this._alive) throw new Error('插件已停用');
      const r = fn();
      if (r && typeof r.then === 'function') {
        return r.then((d) => { if (this._alive) this._track(d); else runQuiet(d); return d; });
      }
      return this._track(r);
    }
    onDispose(fn) { if (typeof fn === 'function') this._disposers.push(fn); return fn; }
    setTimeout(fn, ms) {
      const h = setTimeout(() => { if (this._alive) fn(); }, ms);
      this.onDispose(() => clearTimeout(h));
      return h;
    }
    setInterval(fn, ms) {
      const h = setInterval(() => { if (this._alive) fn(); }, ms);
      h.unref?.();
      this.onDispose(() => clearInterval(h));
      return h;
    }
    service(name) { return getService(name); }
    hasService(name) { return services.has(name); }
    provide(name, value) { return this.onDispose(provide(name, value, this.id)); }
    contribute(slotName, item) { return this.onDispose(slot(slotName).add(item, this.id)); }
    when(phase, fn) {
      if (!PHASES.includes(phase)) throw new Error('未知阶段 ' + phase + '（可用：' + PHASES.join(' / ') + '）');
      if (reached.has(phase)) { this.effect(fn); return; }
      const rec = records.get(this.id);
      rec.waiting.push({ phase, fn, ctx: this });
    }
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return this.onDispose(() => listeners.get(event)?.delete(fn));
    }
    emit(event, payload) { emit(event, payload); }
    async _dispose() {
      if (!this._alive) return;
      this._alive = false;
      const list = this._disposers.splice(0).reverse();
      for (const d of list) {
        try { await d(); } catch (e) { this.error('撤销时出错：', e?.message || e); }
      }
    }
  }
  const runQuiet = (d) => { try { if (typeof d === 'function') d(); else d?.dispose?.(); } catch {} };

  // ── 服务与扩展槽 ────────────────────────────────────────────────────────
  function provide(name, value, owner = 'core') {
    if (services.has(name)) throw new Error('服务「' + name + '」已由 ' + services.get(name).owner + ' 提供');
    const entry = { value, owner };
    services.set(name, entry);
    return () => { if (services.get(name) === entry) services.delete(name); };
  }
  function getService(name) {
    const s = services.get(name);
    if (!s) throw new Error('没有服务「' + name + '」（提供它的插件没启用？）');
    return s.value;
  }
  function slot(name) {
    if (!slots.has(name)) slots.set(name, createSlot(name, (n) => emit('slot', n)));
    return slots.get(name);
  }

  // ── 启用 / 停用单个插件 ─────────────────────────────────────────────────
  async function activate(rec) {
    rec.error = null;
    rec.problems = [];
    try {
      if (!rec.def) {
        rec.def = normalizeDef(await rec.load(rec.rev));
        if (!rec.schemaFromManifest && rec.def.config) rec.schema = normalizeSchema(rec.def.config);
      }
    } catch (e) {
      rec.status = 'error';
      rec.error = '加载失败：' + String(e?.message || e).slice(0, 400);
      logger.error?.('[plugins] ' + rec.id + ' ' + rec.error);
      return false;
    }
    const raw = storedConfig(rec.id);
    const { config, problems } = resolveConfig(rec.schema, raw);
    rec.problems = problems;
    const ctx = new PluginContext(rec, config);
    rec.ctx = ctx;
    rec.appliedRaw = JSON.stringify(raw);
    try {
      const r = await rec.def.apply(ctx, ctx.config);
      if (typeof r === 'function') ctx.onDispose(r);
      rec.status = 'active';
      rec.active = true;
      return true;
    } catch (e) {
      rec.waiting = [];
      await ctx._dispose();
      rec.ctx = null;
      rec.active = false;
      rec.status = 'error';
      rec.error = String(e?.message || e).slice(0, 400);
      logger.error?.('[plugins] ' + rec.id + ' 启用失败：' + rec.error);
      return false;
    }
  }

  async function deactivate(rec, status = 'disabled') {
    rec.waiting = [];
    if (rec.ctx) { const c = rec.ctx; rec.ctx = null; await c._dispose(); }
    rec.active = false;
    rec.status = status;
  }

  // ── 对账：算出「该开着的」集合，停掉多余的（依赖方先停），补上缺的（依赖先起） ──
  async function reconcile() {
    const { list, cyclic } = ordered();
    const want = new Set();
    for (const rec of list) {
      rec.blockedBy = [];
      rec.pendingRestart = false;
      if (cyclic.has(rec.id)) { rec.blockedBy = ['（依赖成环）']; continue; }
      const on = wantEnabled(rec);
      // 需要重启的插件：运行中保持启动时的样子，只标 pending
      if (rec.restart && started) {
        rec.pendingRestart = on !== rec.bootWanted || (rec.active && JSON.stringify(storedConfig(rec.id)) !== rec.appliedRaw);
        if (rec.active) want.add(rec.id);
        continue;
      }
      if (!on) continue;
      const missing = rec.requires.filter((d) => !want.has(d));
      if (missing.length) { rec.blockedBy = missing; continue; }
      want.add(rec.id);
    }
    // 还开着的 restart 插件依赖的插件不能热停（会把它拖坏）：留着，标 pending。
    const pinned = new Set();
    const pin = (id) => {
      if (pinned.has(id)) return;
      pinned.add(id);
      for (const d of records.get(id)?.requires || []) pin(d);
    };
    for (const rec of list) if (rec.restart && rec.active) pin(rec.id);
    for (const rec of list) {
      if (rec.active && !want.has(rec.id) && pinned.has(rec.id)) { want.add(rec.id); rec.pendingRestart = true; }
    }
    for (const rec of [...list].reverse()) {
      if (rec.active && !want.has(rec.id)) await deactivate(rec, rec.blockedBy.length ? 'blocked' : 'disabled');
    }
    for (const rec of list) {
      if (want.has(rec.id)) {
        if (!rec.active) {
          // 依赖启用失败的，跟着标 blocked
          const dead = rec.requires.filter((d) => !records.get(d)?.active);
          if (dead.length) { rec.blockedBy = dead; rec.status = 'blocked'; continue; }
          const ok = await activate(rec);
          if (ok) runWaiting(rec);
        }
      } else if (!rec.active && rec.status !== 'error') {
        rec.status = rec.blockedBy.length ? 'blocked' : (rec.restart && started && rec.pendingRestart ? 'disabled' : 'disabled');
      } else if (!rec.active && rec.status === 'error' && !wantEnabled(rec)) {
        rec.status = 'disabled';
        rec.error = null;
      }
    }
    changed(null);
  }

  function runWaiting(rec) {
    const pending = rec.waiting.splice(0);
    for (const w of pending) {
      if (!reached.has(w.phase)) { rec.waiting.push(w); continue; }
      if (!w.ctx.alive) continue;
      try { w.ctx.effect(w.fn); } catch (e) { w.ctx.error('阶段 ' + w.phase + ' 回调出错：', e?.message || e); }
    }
  }

  // ── 对外 ───────────────────────────────────────────────────────────────
  const kernel = {
    // 登记一个插件（不加载）。entry：{ id, name, description, category, source, dir, version, locked, restart,
    // defaultEnabled, requires, config（schema）, load: async (rev) => 模块, web, homepage, author }
    register(entry) {
      if (!entry || !ID_RE.test(entry.id || '')) throw new Error('插件 id 不合法：' + (entry && entry.id) + '（小写字母开头，只用小写字母、数字、连字符）');
      if (records.has(entry.id)) throw new Error('插件 id 重复：' + entry.id);
      if (typeof entry.load !== 'function') throw new Error('插件 ' + entry.id + ' 缺 load');
      const schema = normalizeSchema(entry.config);
      const rec = {
        id: entry.id,
        name: entry.name || entry.id,
        description: entry.description || '',
        category: entry.category || 'feature',
        source: entry.source || 'builtin',
        dir: entry.dir || null,
        version: entry.version || '',
        author: entry.author || '',
        homepage: entry.homepage || '',
        locked: !!entry.locked,
        restart: !!entry.restart,
        defaultEnabled: entry.defaultEnabled !== false,
        requires: Array.isArray(entry.requires) ? entry.requires.filter((d) => typeof d === 'string') : [],
        schema,
        schemaFromManifest: entry.config != null,
        web: entry.web || null,
        extra: entry.extra || null,
        load: entry.load,
        seq: regSeq++,
        rev: 0,
        def: null, ctx: null, active: false, status: 'disabled', error: null, problems: [],
        blockedBy: [], pendingRestart: false, bootWanted: false, appliedRaw: '{}', waiting: [],
      };
      records.set(rec.id, rec);
      if (started) return serial(reconcile).then(() => summary(rec));
      return summary(rec);
    },

    // 去掉一个插件（卸载）：先停用。
    unregister(id) {
      return serial(async () => {
        const rec = records.get(id);
        if (!rec) return false;
        if (rec.active) {
          // 依赖它的先停
          records.delete(id);
          await reconcile();
          records.set(id, rec);
          await deactivate(rec);
        }
        records.delete(id);
        await reconcile();
        return true;
      });
    },

    // 启动：按存着的开关启用全部。restart 插件的「启动时状态」在这里定格。
    start() {
      return serial(async () => {
        for (const rec of records.values()) rec.bootWanted = wantEnabled(rec);
        await reconcile();
        started = true;
        // 启动时就该开却没开起来的 restart 插件，运行中也不再重试（同 bootWanted 定格）
        return kernel.list();
      });
    },

    async enterPhase(phase) {
      if (!PHASES.includes(phase)) throw new Error('未知阶段 ' + phase);
      reached.add(phase);
      for (const rec of [...records.values()].sort((a, b) => a.seq - b.seq)) if (rec.active) runWaiting(rec);
    },

    setEnabled(id, on) {
      return serial(async () => {
        const rec = records.get(id);
        if (!rec) throw new Error('没有插件「' + id + '」');
        if (rec.locked && !on) throw new Error('「' + rec.name + '」是核心功能，不能关');
        writeState((s) => { s.plugins[id] = { ...(s.plugins[id] || {}), enabled: !!on }; });
        await reconcile();
        return summary(rec);
      });
    },

    // 改配置：校验 → 落盘 → 热插件当场重启（连带依赖它的）；restart 插件只标 pending。
    setConfig(id, next) {
      return serial(async () => {
        const rec = records.get(id);
        if (!rec) throw new Error('没有插件「' + id + '」');
        if (!rec.def && !rec.schemaFromManifest) {
          try { rec.def = normalizeDef(await rec.load(rec.rev)); if (rec.def.config) rec.schema = normalizeSchema(rec.def.config); }
          catch (e) { throw new Error('插件加载失败，改不了配置：' + (e?.message || e)); }
        }
        const prev = storedConfig(id);
        const clean = validateConfig(rec.schema, next, prev);
        writeState((s) => { s.plugins[id] = { ...(s.plugins[id] || {}), config: clean }; });
        if (rec.active && !rec.restart) await restartLive([rec]);
        else await reconcile();
        return summary(rec);
      });
    },

    // 重新加载代码（本地开发的插件改了文件）：停用 → 丢掉模块 → 下次启用时按新 rev 重新 import。
    reload(id, newLoad) {
      return serial(async () => {
        const rec = records.get(id);
        if (!rec) throw new Error('没有插件「' + id + '」');
        if (rec.restart) throw new Error('「' + rec.name + '」要重启服务才能重新加载');
        if (typeof newLoad === 'function') rec.load = newLoad;
        rec.rev += 1;
        const wasActive = rec.active;
        rec.def = null;
        if (rec.error) { rec.error = null; rec.status = 'disabled'; }
        if (wasActive) await restartLive([rec]);
        else await reconcile();
        return summary(rec);
      });
    },

    // 换掉登记信息（重新安装 / 清单改了）：只改元数据与 load，代码在下一次启用时换上。
    update(id, patch) {
      const rec = records.get(id);
      if (!rec) return null;
      for (const k of ['name', 'description', 'category', 'version', 'author', 'homepage', 'web', 'dir', 'extra']) if (k in patch) rec[k] = patch[k];
      if ('requires' in patch && Array.isArray(patch.requires)) rec.requires = patch.requires;
      if ('config' in patch) { rec.schema = normalizeSchema(patch.config); rec.schemaFromManifest = patch.config != null; }
      if (typeof patch.load === 'function') rec.load = patch.load;
      changed(id);
      return summary(rec);
    },

    stop() {
      return serial(async () => {
        for (const rec of [...ordered().list].reverse()) if (rec.active) await deactivate(rec);
        started = false;
      });
    },

    has: (id) => records.has(id),
    isActive: (id) => !!records.get(id)?.active,
    get: (id) => (records.has(id) ? summary(records.get(id)) : null),
    list: () => ordered().list.map(summary),
    configOf: (id) => records.get(id)?.ctx?.config || null,
    schemaOf: (id) => records.get(id)?.schema || null,
    contextOf: (id) => records.get(id)?.ctx || null,
    rawRecord: (id) => records.get(id) || null,

    provide: (name, value) => provide(name, value, 'core'),
    service: getService,
    hasService: (name) => services.has(name),
    slot,
    mixin(name, factory) {
      if (mixins.has(name)) throw new Error('混入「' + name + '」重复');
      mixins.set(name, factory);
    },
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    get started() { return started; },
    phaseReached: (p) => reached.has(p),
    readState,
    writeState,
    serial,
  };

  async function restartLive(roots) {
    // 连带依赖它的一起重启：先按逆序停，再走一遍对账（会按顺序重新启用）。
    const ids = new Set(roots.map((r) => r.id));
    let grew = true;
    while (grew) {
      grew = false;
      for (const rec of records.values()) {
        if (!ids.has(rec.id) && rec.active && rec.requires.some((d) => ids.has(d))) { ids.add(rec.id); grew = true; }
      }
    }
    const { list } = ordered();
    for (const rec of [...list].reverse()) if (ids.has(rec.id) && rec.active && !rec.restart) await deactivate(rec);
    await reconcile();
  }

  function summary(rec) {
    const stored = storedOf(rec.id);
    const enabled = wantEnabled(rec);
    return {
      id: rec.id,
      name: rec.name,
      description: rec.description,
      category: rec.category,
      source: rec.source,
      version: rec.version,
      author: rec.author,
      homepage: rec.homepage,
      dir: rec.dir,
      locked: rec.locked,
      restart: rec.restart,
      requires: rec.requires.slice(),
      enabled,
      defaultEnabled: rec.defaultEnabled,
      customized: typeof stored.enabled === 'boolean' || !!(stored.config && Object.keys(stored.config).length),
      active: rec.active,
      status: rec.status,
      error: rec.error,
      problems: rec.problems.slice(),
      blockedBy: rec.blockedBy.slice(),
      pendingRestart: !!rec.pendingRestart,
      schema: rec.schema,
      config: maskConfig(rec.schema, { ...resolveConfig(rec.schema, storedConfig(rec.id)).config }),
      web: rec.web,
      extra: rec.extra,
    };
  }

  return kernel;
}
