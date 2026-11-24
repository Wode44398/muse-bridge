// 常驻 ACP 客户端：单进程承载多会话，负责握手、按行 JSON-RPC 通信、字符串 ID 反向请求应答、
// 按会话互斥串行化（load / mount / prompt）、请求超时、进程树清理、连续崩溃封顶与配置按序补发。

import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';
import { DATA_ROOT } from '@bridge/core/runtime/paths.mjs';
import {
  spawnAgyProcess, killProcessTree, locateAgy, agyInstalled,
  prepareReadOnlyDaemonDir, unlockDaemonDir, repairShadowedConversations,
  defaultDaemonCwd, cleanupWorkerLogFiles,
} from './binary.mjs';
import { normalizeAgyPath } from '../paths.mjs';
import { noteAgyProcessStart } from '../proc-epoch.mjs';
import { purgePendingDeletions } from '../purge-files.mjs';
import { bridgeToolAutoAllow } from '../mcp/approval.mjs';
import {
  convertSessionUpdate,
  extractConfigSummary,
  normalizePermissionRequest,
  normalizeElicitationRequest,
} from '../events.mjs';
import {
  BYPASS_MODE, BYPASS_BASE_MODE, toAcpMode, decorateModeOptions, decorateModes, pickAllowOption,
} from './bypass.mjs';
import {
  resolveEffectiveContextUsage,
  getAgyContextLimits,
  peekAgyContextLimits,
  warmAgyContextLimits,
} from '../context-limits.mjs';

function withLoopbackNoProxy(baseEnv) {
  const env = { ...(baseEnv || process.env) };
  const keys = Object.keys(env).filter((k) => k.toLowerCase() === 'no_proxy');
  const existing = keys.map((k) => String(env[k] || '')).join(',');
  const parts = existing.split(',').map((s) => s.trim()).filter(Boolean);
  for (const host of ['127.0.0.1', 'localhost']) {
    if (!parts.some((p) => p.toLowerCase() === host)) parts.push(host);
  }
  const merged = parts.join(',');
  if (keys.length) {
    for (const k of keys) env[k] = merged;
  } else {
    env.NO_PROXY = merged;
    if (process.platform !== 'win32') env.no_proxy = merged;
  }
  return env;
}

const DEFAULT_DAEMON_DIR = defaultDaemonCwd('main', DATA_ROOT);
const DEFAULT_LOG_FILE = path.join(DATA_ROOT, 'agy', 'acp.log');
const DEFAULT_STABLE_WINDOW_MS = 60_000;
const DEFAULT_MAX_CRASHES = 3;
const HISTORY_KEEP = 24;
// --process-per-session 模式下每个已挂载会话对应一个独立 worker 进程（约 150MB 内存），
// 保留最近活跃的若干空闲会话以保持切回速度，超出上限后自动 session/close 释放多余 worker。
const DEFAULT_MAX_IDLE_MOUNTED_SESSIONS = 6;
// session/load 的回放不全在响应之前：会话在常驻进程里热加载过一次后，再 load 时 agy 先回响应、
// 剩下上百条历史（tool_call / agent_message 等）随后才推过来。session_info_update / available_commands_update
// 只在冷进程首次 load 时落在结尾；热加载时它们夹在回放中间（实测第 377/487 条），不能当结束信号。
// 所以响应到了还要接着收，直到静默 REPLAY_QUIET_MS，最多再等 REPLAY_TAIL_CAP_MS。
const REPLAY_QUIET_MS = 400;
const REPLAY_TAIL_CAP_MS = 10_000;
// 一轮里最多替后台续接几次：防止「续接 → 又派子代理 → 又续接」没完没了
const MAX_WAKES_PER_TURN = 12;

// 一轮里发过好几条 prompt 时，每条的返回各带一份用量：加起来才是这一轮的
function sumUsage(parts) {
  if (!Array.isArray(parts) || !parts.length) return null;
  if (parts.length === 1) return parts[0];
  const out = {};
  for (const u of parts) {
    for (const [k, v] of Object.entries(u || {})) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = (out[k] || 0) + v;
    }
  }
  return out;
}

function flattenConfigValues(configOpt) {
  const out = [];
  for (const item of (configOpt?.options || [])) {
    if (Array.isArray(item?.options)) {
      for (const sub of item.options) {
        if (sub && sub.value !== undefined) out.push(String(sub.value));
      }
    } else if (item && item.value !== undefined) {
      out.push(String(item.value));
    }
  }
  return out;
}

function buildAntigravityMeta({ systemPromptAppend, additionalDirectories, disableBuiltInTools } = {}) {
  const agyMeta = {};
  if (typeof systemPromptAppend === 'string' && systemPromptAppend.trim()) {
    agyMeta.systemPrompt = { append: systemPromptAppend };
  }
  if (Array.isArray(additionalDirectories) && additionalDirectories.length) {
    const cleanDirs = additionalDirectories
      .map((d) => normalizeAgyPath(d) || String(d || '').trim())
      .filter(Boolean);
    if (cleanDirs.length) agyMeta.additionalDirectories = cleanDirs;
  }
  if (disableBuiltInTools === true) {
    agyMeta.disableBuiltInTools = true;
  }
  return Object.keys(agyMeta).length ? { antigravity: agyMeta } : undefined;
}

export class AcpClient {
  constructor(options = {}) {
    this.command = options.command || null;
    this.args = options.args || null;
    // 默认开启 --process-per-session：单进程模式下 language server 维护全局 Active Workspaces，
    // 会把先打开过的项目目录与 AGENTS.md 泄露到后续其它目录的会话；按会话隔离 worker 后彻底隔离。
    this.processPerSession = options.processPerSession ?? (process.env.AGY_PROCESS_PER_SESSION !== '0');
    this.maxIdleMountedSessions = Number.isInteger(options.maxIdleMountedSessions)
      ? Math.max(0, options.maxIdleMountedSessions)
      : (!this.command && this.processPerSession ? DEFAULT_MAX_IDLE_MOUNTED_SESSIONS : 0);
    // 追加在 `acp` 之后的参数（桌面版存储的第二个常驻进程用 --app-data-dir antigravity）
    this.extraArgs = Array.isArray(options.extraArgs) ? options.extraArgs : [];
    this.label = options.label || 'cli';
    // 本进程用的 agy 数据目录（启动前修被空 .db 遮住的旧格式会话）；测试里的假 agent 不设
    this.dataDir = options.dataDir || null;
    // 每次起进程之前先跑的一步（注册用户的进程用它装工具调用守卫）；抛错 = 这次不起进程
    this.beforeSpawn = typeof options.beforeSpawn === 'function' ? options.beforeSpawn : null;
    this.env = options.env || null;
    this.daemonCwd = options.daemonCwd || DEFAULT_DAEMON_DIR;
    this.logFile = options.logFile === undefined ? DEFAULT_LOG_FILE : options.logFile;
    this.autoRecover = options.autoRecover !== false;
    this.defaultTimeoutMs = options.defaultTimeoutMs || 45_000;
    this.stableWindowMs = options.stableWindowMs ?? DEFAULT_STABLE_WINDOW_MS;
    this.maxCrashCount = options.maxCrashCount ?? DEFAULT_MAX_CRASHES;

    this.proc = null;
    this.reader = null;
    this.ready = false;
    this.starting = null;
    this.bootSeq = 0;
    this.startedAt = 0;
    this.shuttingDown = false;
    this.nextId = 1;

    this.initInfo = null;
    this.authState = null;      // null | 'authed' | 'logged_out'
    this.lastTier = null;
    this.lastCatalog = null;    // { models, modes, configOptions }
    this.stderrTail = [];

    this.pending = new Map();            // client request id -> { resolve, reject, timer, method }
    this.mountedSessions = new Map();    // sessionId -> live session snapshot in current process
    this.knownSessions = new Map();      // sessionId -> { cwd, mcpServers, systemPromptAppend, additionalDirectories, desiredConfig }
    this.sessionLocks = new Map();       // sessionId -> Promise chain (per-session mutex)
    this.inflightLoads = new Map();      // sessionId -> Promise (coalesced concurrent session/load)
    this.turns = new Map();              // sessionId -> active turn handler
    this.loadCollectors = new Map();     // sessionId -> array of raw update msgs while session/load runs
    // 正在按 desiredConfig 逐项补发配置的会话：期间 agy 推回的 config_option_update 仍带着旧 mode，不能误判为退出放行
    this.applyingConfig = new Set();
    // sessionId -> 该会话的完整原始历史（session/load 回放 + 之后每轮在本进程里实时收到的更新）。
    // 打开一个正在跑的会话时不能 session/load（会打断在跑轮），靠它把「这一轮之前的历史」交给前端。
    this.historyUpdates = new Map();
    this.sessionListeners = new Set();   // global observers for title/config updates

    this.pendingPermissions = new Map(); // String(rpcId) -> { rpcId, sessionId, rootSessionId, sourceSessionId, payload, timer, onResolved, createdAt }
    this.pendingQuestions = new Map();   // String(rpcId) -> { rpcId, sessionId, rootSessionId, sourceSessionId, payload, timer, onResolved }
    // 子代理 / Swarm 成员到主会话的映射：agy acp 只给显式挂载过的会话开事件流，
    // 子代理卡在权限等待（steps.status=9）时须对其调 session/resume 接通权限通道，再按主会话的放行策略处理或透传给用户。
    this.subagentRoots = new Map();      // subId -> { rootSessionId, role, typeName, depth, kind }
    this.subagentResumed = new Set();    // 当前 agy 进程里已 session/resume 接通过的子代理 id
    this.subagentResuming = new Map();   // subId -> Promise（防并发重复 resume）
    // 多代理后台保护与后台唤醒反向请求桥接（由 subagent-monitor.mjs 挂载）
    this.bgHandlers = null;

    this.crashCount = 0;
    this.stoppedAfterCrashes = false;
    this.lastExitReason = '';
    this.stableTimer = null;
    this.recoverTimer = null;
    this.recovering = null;

    this.preparingTurns = 0;
    this.pendingIdleRestart = false;
    this.pendingIdleRemount = false;
    this._idleRestartPromise = null;

    // 当前这个 agy 进程里，bridge 工具服务是按哪份「工具指纹」列的清单（mcp/config.mjs 的 toolingSig）。
    // null = 这个进程还没挂过带 bridge 工具的会话（工具子进程还没起，下次挂载自然取到最新清单）。
    this.toolingSig = null;
  }

  onSessionEvent(fn) {
    this.sessionListeners.add(fn);
    return () => this.sessionListeners.delete(fn);
  }

  setBackgroundHandlers(handlers) {
    this.bgHandlers = handlers && typeof handlers === 'object' ? handlers : null;
  }

  _emitSessionEvent(evt) {
    for (const fn of this.sessionListeners) {
      try { fn(evt); } catch {}
    }
  }

  // 按 sessionId 排队串行执行：保证同一会话的 load / mount / setConfig / close / prompt 准备互不穿插
  async _withSessionLock(sessionId, fn) {
    const id = String(sessionId || '');
    if (!id) return fn();
    const prev = this.sessionLocks.get(id) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const chained = prev.catch(() => {}).then(() => gate);
    this.sessionLocks.set(id, chained);
    await prev.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.sessionLocks.get(id) === chained) {
        this.sessionLocks.delete(id);
      }
    }
  }

  hasActiveTurn(sessionId) {
    return this.turns.has(String(sessionId || ''));
  }

  // 记住一份会话历史（LRU，最多 HISTORY_KEEP 份；在跑轮的那份不淘汰）
  _setHistory(sessionId, updates) {
    const id = String(sessionId || '');
    if (!id) return;
    this.historyUpdates.delete(id);
    this.historyUpdates.set(id, Array.isArray(updates) ? updates : []);
    for (const key of [...this.historyUpdates.keys()]) {
      if (this.historyUpdates.size <= HISTORY_KEEP) break;
      if (key === id || this.turns.has(key)) continue;
      this.historyUpdates.delete(key);
    }
  }

  // 在跑会话「本轮开始之前」的原始历史；不在跑、或本进程没有它的历史时返回 null
  getLiveHistory(sessionId) {
    const id = String(sessionId || '');
    const turn = this.turns.get(id);
    const hist = this.historyUpdates.get(id);
    if (!turn || turn.done || !hist) return null;
    const base = Number.isInteger(turn.historyBase) ? turn.historyBase : hist.length;
    return hist.slice(0, base);
  }

  getMountedSnapshot(sessionId) {
    return this.mountedSessions.get(String(sessionId || '')) || null;
  }

  // agy initialize 时报的 prompt 能收哪些内容块（{ image, audio, embeddedContext }）；还没起过进程或没报时为 null
  promptCapabilities() {
    const caps = this.initInfo?.agentCapabilities?.promptCapabilities;
    return caps && typeof caps === 'object' ? caps : null;
  }

  status() {
    const bin = this.command ? { file: this.command } : locateAgy();
    const running = !!(this.ready && this.proc && !this.proc.killed);
    const state = this.stoppedAfterCrashes
      ? 'stopped'
      : (running ? 'running' : (this.starting ? 'starting' : 'idle'));
    return {
      running,
      state,
      stoppedAfterCrashes: this.stoppedAfterCrashes,
      crashCount: this.crashCount,
      lastExitReason: this.lastExitReason || null,
      authState: this.authState,
      pid: this.proc?.pid || null,
      startedAt: this.startedAt || null,
      uptimeMs: this.startedAt && running ? Math.max(0, Date.now() - this.startedAt) : 0,
      cliInstalled: this.command ? true : agyInstalled(),
      cliPath: bin.file,
      daemonCwd: this.daemonCwd,
      logFile: this.logFile || null,
      agentInfo: this.initInfo?.agentInfo || null,
      protocolVersion: this.initInfo?.protocolVersion || null,
      capabilities: this.initInfo?.agentCapabilities || null,
      authMethods: this.initInfo?.authMethods || [],
      tier: this.lastTier || null,
      catalog: this.lastCatalog || null,
      mountedSessions: [...this.mountedSessions.keys()],
      activeTurns: [...this.turns.keys()],
      pendingIdleRestart: this.pendingIdleRestart,
      pendingPermissions: [...this.pendingPermissions.values()].map((p) => p.payload),
      pendingQuestions: [...this.pendingQuestions.values()].map((q) => q.payload),
    };
  }

  rememberSession(sessionId, meta = {}) {
    if (!sessionId) return null;
    const id = String(sessionId);
    const prev = this.knownSessions.get(id) || {
      cwd: '',
      mcpServers: [],
      systemPromptAppend: '',
      additionalDirectories: [],
      desiredConfig: {},
    };
    // 已有绑定 cwd 时默认保留原绑定，只有新建或明确授权强制绑定时才写入新 cwd
    const resolvedCwd = meta.forceCwd
      ? (meta.cwd || prev.cwd || '')
      : (prev.cwd || meta.cwd || '');
    const next = {
      cwd: resolvedCwd,
      mcpServers: Array.isArray(meta.mcpServers) ? meta.mcpServers : prev.mcpServers,
      systemPromptAppend: meta.systemPromptAppend !== undefined ? meta.systemPromptAppend : prev.systemPromptAppend,
      additionalDirectories: Array.isArray(meta.additionalDirectories) ? meta.additionalDirectories : prev.additionalDirectories,
      desiredConfig: {
        ...prev.desiredConfig,
        ...(meta.desiredConfig && typeof meta.desiredConfig === 'object' ? meta.desiredConfig : {}),
      },
    };
    this.knownSessions.set(id, next);
    return next;
  }

  // ── 完全放行（bypass）──────────────────────────────────────────────────────
  // 唯一事实来源：knownSessions[id].desiredConfig.mode === 'bypass'（随 rememberSession 合并、重挂载时照常补发）
  isBypass(sessionId) {
    return this.knownSessions.get(String(sessionId || ''))?.desiredConfig?.mode === BYPASS_MODE;
  }

  // 把挂载快照里的模式下拉 / currentModeId 按放行状态改写，再把已经挂着的审批直接放掉
  _syncBypass(sessionId) {
    const id = String(sessionId || '');
    const on = this.isBypass(id);
    const mounted = this.mountedSessions.get(id);
    if (mounted) {
      mounted.configOptions = decorateModeOptions(mounted.configOptions, on);
      if (mounted.modes) mounted.modes = decorateModes(mounted.modes, on);
    }
    if (on) {
      for (const entry of [...this.pendingPermissions.values()]) {
        if (entry.sessionId !== id && entry.rootSessionId !== id) continue;
        const allow = pickAllowOption(entry.payload?.options);
        if (allow) this.answerPermission(entry.requestId, { optionId: allow.optionId, auto: true });
      }
    }
  }

  registerSubagent(subId, rootSessionId, meta = {}) {
    const sid = String(subId || '').trim();
    const root = String(rootSessionId || '').trim();
    if (!sid || !root || sid === root) return;
    const prev = this.subagentRoots.get(sid) || {};
    this.subagentRoots.set(sid, {
      rootSessionId: root,
      role: meta.role || prev.role || '',
      typeName: meta.typeName || prev.typeName || '',
      depth: Number.isFinite(Number(meta.depth)) ? Number(meta.depth) : (prev.depth || 1),
      kind: meta.kind || prev.kind || 'subagent',
    });
  }

  resolveRootSessionId(sessionId) {
    const id = String(sessionId || '').trim();
    if (!id) return '';
    return this.subagentRoots.get(id)?.rootSessionId || id;
  }

  getSubagentInfo(sessionId) {
    const id = String(sessionId || '').trim();
    return id ? (this.subagentRoots.get(id) || null) : null;
  }

  /**
   * 仅向 agy 挂载子代理的对话更新流以接通其 session/request_permission 通道：
   * 不写入 mountedSessions / knownSessions / lastCatalog，也不影响主会话的回放历史与崩溃重挂载。
   */
  async ensureSubagentAttached(subId, rootSessionId, { cwd = '', role = '', typeName = '', depth = 1, kind = 'subagent' } = {}) {
    const sid = String(subId || '').trim();
    const root = String(rootSessionId || '').trim();
    if (!sid || !root || sid === root) return false;
    this.registerSubagent(sid, root, { role, typeName, depth, kind });
    if (!this.ready || !this.proc || this.shuttingDown) return false;
    if (this.mountedSessions.has(sid) || this.subagentResumed.has(sid)) return true;
    const inflight = this.subagentResuming.get(sid);
    if (inflight) return inflight;

    const rawDir = cwd || this.knownSessions.get(root)?.cwd || this.mountedSessions.get(root)?.cwd || os.homedir();
    const workDir = normalizeAgyPath(rawDir) || rawDir;
    const task = this._requestRaw('session/resume', {
      sessionId: sid,
      cwd: workDir,
      mcpServers: [],
    }, 15_000).then(() => {
      this.subagentResumed.add(sid);
      return true;
    }).catch(() => false).finally(() => {
      if (this.subagentResuming.get(sid) === task) this.subagentResuming.delete(sid);
    });
    this.subagentResuming.set(sid, task);
    return task;
  }

  /** 子代理在 agy 侧自身超时（60s）或被外部处理后，收掉本地已过期的挂起审批卡。 */
  retireExternalPermission(requestId) {
    const key = String(requestId || '');
    const entry = this.pendingPermissions.get(key);
    if (!entry) return false;
    this.pendingPermissions.delete(key);
    clearTimeout(entry.timer);
    const turn = this.turns.get(entry.sessionId);
    const resolvedEvt = {
      requestId: key,
      sessionId: entry.sessionId,
      sourceSessionId: entry.sourceSessionId || entry.sessionId,
      toolCallId: entry.payload?.toolCall?.toolCallId || '',
      outcome: 'cancelled',
      optionId: null,
      expired: true,
    };
    try {
      if (entry.onResolved) entry.onResolved(resolvedEvt);
      else turn?.onPermissionResolved?.(resolvedEvt);
    } catch {}
    return true;
  }

  _decorCatalog(configOptions) {
    return decorateModeOptions(configOptions, false);
  }

  forgetSession(sessionId) {
    const id = String(sessionId || '');
    this.knownSessions.delete(id);
    this.mountedSessions.delete(id);
    this.historyUpdates.delete(id);
  }

  /**
   * 挂载会话前报上这次的工具指纹。agy 对同一份 MCP 配置只在工具子进程启动时取一次 tools/list（11-19 探针实测：
   * 三个会话加一次 load 只取 1 次），之后设置开关、扩展中心开关插件、登记了第一台设备……它都不知道。
   * 指纹和当前进程用的那份不一样 → 请求一次空闲重启（有轮在跑就顺延到最后一轮收尾，不打断任何对话），
   * 重启后工具子进程重新起、清单重新取。要在占「准备中」的位之前调：此刻空闲就当场重启，调用方接着等它就绪。
   */
  noteTooling(sig) {
    const s = String(sig || '');
    if (!s || s === 'off') return;                       // 这次不挂 bridge 工具：谈不上清单新旧
    if (this.toolingSig === null || (!this.proc && !this.starting)) { this.toolingSig = s; return; }
    if (this.toolingSig === s) return;
    this.toolingSig = s;
    this.requestIdleRestart({ remountIdle: false }).catch(() => {});
  }

  async ensureStarted() {
    if (this.stoppedAfterCrashes) {
      throw new Error('Antigravity 常驻进程连续异常退出已停止，请手动重启');
    }
    if (this.ready && this.proc) return this.initInfo;
    if (this.starting) return this.starting;
    this.shuttingDown = false;
    const mySeq = ++this.bootSeq;
    const bootPromise = this._spawnAndInitialize(mySeq).finally(() => {
      if (this.starting === bootPromise) {
        this.starting = null;
      }
      this._scheduleIdleRestartCheck();
    });
    this.starting = bootPromise;
    return bootPromise;
  }

  async _spawnAndInitialize(mySeq) {
    // 守护进程放到独立空且只读的目录启动：既避免无工作区记录的历史会话混入真实项目，也确保误写 daemon-cwd 当场失败
    prepareReadOnlyDaemonDir(this.daemonCwd);
    if (this.logFile) {
      try { mkdirSync(path.dirname(this.logFile), { recursive: true }); } catch {}
      if (!this.command) {
        try { cleanupWorkerLogFiles(this.logFile); } catch {}
      }
    }

    if (this.dataDir && !this.command) {
      try {
        const fixed = repairShadowedConversations(this.dataDir);
        if (fixed.length) console.log(`[agy] 恢复 ${fixed.length} 个被空 .db 遮住的会话：${fixed.join(', ')}`);
      } catch {}
      // 彻底删除时被进程占着、没删掉的会话文件：进程起来之前没人占着，这时清
      try { purgePendingDeletions(this.dataDir); } catch {}
    }

    if (this.beforeSpawn) {
      try { this.beforeSpawn(); } catch (err) {
        throw new Error('Antigravity ACP 启动前的准备失败：' + (err?.message || String(err)));
      }
    }

    const acpArgs = ['acp'];
    if (!this.command && this.processPerSession) {
      acpArgs.push('--process-per-session');
    }
    acpArgs.push(...this.extraArgs);
    if (this.logFile && !this.command) {
      acpArgs.push('--log-file', this.logFile);
    }

    let spawnEnv = this.env;
    if (!this.command && process.env.AGY_NO_UPSTREAM !== '1') {
      const { ensureAgyUpstream } = await import('../pool/upstream.mjs');
      const upstreamUrl = await ensureAgyUpstream();
      if (upstreamUrl) {
        acpArgs.push('--cloud_code_endpoint', upstreamUrl);
        // 避免子进程把本机回环上游代理错误转发到系统 HTTP_PROXY / Clash。
        spawnEnv = withLoopbackNoProxy(this.env || process.env);
      }
    }

    let proc;
    try {
      proc = spawnAgyProcess(acpArgs, {
        cwd: this.daemonCwd || os.tmpdir(),
        env: spawnEnv,
        command: this.command,
        args: this.args,
      });
    } catch (err) {
      throw new Error('Antigravity ACP 启动失败：' + (err?.message || String(err)));
    }

    if (mySeq !== this.bootSeq || this.shuttingDown) {
      killProcessTree(proc);
      throw new Error('Antigravity ACP 启动已取消');
    }

    this.proc = proc;
    this.ready = false;
    this.stderrTail = [];
    // 新进程：工具子进程还没起，下一次挂载会取到最新清单——指纹清掉，由那次挂载重新记
    this.toolingSig = null;
    this.mountedSessions.clear();

    this.reader = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    this.reader.on('line', (line) => this._handleLine(line));

    proc.stdin?.on('error', (err) => {
      this._handleProcessExit(proc, 'Antigravity ACP stdin 错误：' + (err?.message || String(err)));
    });
    proc.stderr?.on('data', (chunk) => {
      this.stderrTail.push(String(chunk));
      if (this.stderrTail.length > 40) this.stderrTail.shift();
    });
    proc.once('error', (err) => {
      this._handleProcessExit(proc, 'Antigravity ACP 进程错误：' + (err?.message || String(err)));
    });
    proc.once('close', (code, signal) => {
      const tail = this.stderrTail.join('').trim().slice(-600);
      const detail = tail ? '：' + tail : '';
      const codeStr = code != null ? `（退出码 ${code}）` : (signal ? `（信号 ${signal}）` : '');
      this._handleProcessExit(proc, `Antigravity ACP 已退出${codeStr}${detail}`);
    });

    try {
      const initResult = await this._requestRaw('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'claude-bridge', version: '1.0.0' },
        clientCapabilities: {
          elicitation: { form: {} },
        },
      }, 20_000);

      if (mySeq !== this.bootSeq || this.shuttingDown || this.proc !== proc) {
        killProcessTree(proc);
        throw new Error('Antigravity ACP 启动已取消');
      }

      this.initInfo = initResult;
      this.ready = true;
      this.startedAt = Date.now();
      // 换了进程：之前转入后台的命令都随旧进程没了（见 proc-epoch.mjs）
      noteAgyProcessStart(this.dataDir, this.startedAt);

      // 只有连续稳定运行满窗口期才清零崩溃计数，避免启动即崩时因单条请求成功导致无限拉起
      clearTimeout(this.stableTimer);
      this.stableTimer = setTimeout(() => {
        this.stableTimer = null;
        if (this.ready && this.proc === proc) {
          this.crashCount = 0;
          this.stoppedAfterCrashes = false;
        }
      }, this.stableWindowMs);
      this.stableTimer.unref?.();

      return initResult;
    } catch (err) {
      killProcessTree(proc);
      if (this.proc === proc) {
        this.proc = null;
        this.ready = false;
      }
      throw new Error('Antigravity ACP 初始化失败：' + (err?.message || String(err)));
    }
  }

  _handleProcessExit(proc, reason) {
    // 无论经 close、stdin error、proc error 还是 shutdown 进入，一律先按进程树收尸，防止残留 language_server 孙进程
    killProcessTree(proc);
    if (this.proc !== proc) return;

    const wasReady = this.ready;
    const wasIntentional = this.shuttingDown;
    const ranLongEnough = wasReady && this.startedAt > 0 && (Date.now() - this.startedAt >= this.stableWindowMs);
    const sessionsToRemount = [...this.mountedSessions.keys()];

    clearTimeout(this.stableTimer);
    this.stableTimer = null;

    this.proc = null;
    this.ready = false;
    this.startedAt = 0;
    this.mountedSessions.clear();
    this.subagentResumed.clear();
    this.subagentResuming.clear();
    try { this.reader?.close(); } catch {}
    this.reader = null;

    if (!wasIntentional) {
      this.lastExitReason = reason;
    }
    if (ranLongEnough) {
      this.crashCount = 0;
    }

    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error(reason));
    }
    this.pending.clear();

    for (const entry of this.pendingPermissions.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingPermissions.clear();

    for (const entry of this.pendingQuestions.values()) {
      clearTimeout(entry.timer);
    }
    this.pendingQuestions.clear();

    for (const turn of [...this.turns.values()]) {
      turn.finish('failed', reason);
    }
    this.turns.clear();
    this.loadCollectors.clear();

    if (wasReady && !wasIntentional && this.autoRecover) {
      const attempt = ++this.crashCount;
      if (attempt > this.maxCrashCount) {
        this.stoppedAfterCrashes = true;
        clearTimeout(this.recoverTimer);
        this.recoverTimer = null;
        return;
      }
      this._scheduleRecovery(sessionsToRemount, attempt);
    }
  }

  _scheduleRecovery(sessionsToRemount, attempt) {
    const delayMs = Math.min(2000, 150 * (2 ** Math.max(0, attempt - 1)));
    clearTimeout(this.recoverTimer);
    this.recoverTimer = setTimeout(() => {
      this.recoverTimer = null;
      this._recoverSessions(sessionsToRemount).catch(() => {});
    }, delayMs);
    this.recoverTimer.unref?.();
  }

  async _recoverSessions(sessionIds) {
    if (this.shuttingDown || this.stoppedAfterCrashes) return;
    if (this.recovering) return this.recovering;
    this.recovering = (async () => {
      try {
        await this.ensureStarted();
      } catch (err) {
        if (this.shuttingDown) return;
        this.lastExitReason = err?.message || String(err);
        const attempt = ++this.crashCount;
        if (attempt > this.maxCrashCount) {
          this.stoppedAfterCrashes = true;
        } else {
          this._scheduleRecovery(sessionIds, attempt);
        }
        return;
      }
      for (const sid of sessionIds) {
        if (this.shuttingDown || this.stoppedAfterCrashes) break;
        if (!this.knownSessions.has(sid)) continue;
        try {
          await this.ensureSessionMounted(sid);
        } catch {
          // 单个会话恢复失败不阻塞其它会话
        }
      }
    })().finally(() => {
      this.recovering = null;
    });
    return this.recovering;
  }

  _send(payload) {
    if (!this.proc?.stdin?.writable) {
      throw new Error('Antigravity ACP 未运行');
    }
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n', 'utf8');
  }

  _notify(method, params) {
    this._send({ method, ...(params !== undefined ? { params } : {}) });
  }

  _requestRaw(method, params, timeoutMs = this.defaultTimeoutMs) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this._send({ id, method, ...(params !== undefined ? { params } : {}) });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async request(method, params, timeoutMs = this.defaultTimeoutMs) {
    while (this._idleRestartPromise) {
      try { await this._idleRestartPromise; } catch {}
    }
    await this.ensureStarted();
    return this._requestRaw(method, params, timeoutMs);
  }

  _handleLine(line) {
    const raw = String(line || '').trim();
    if (!raw) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // 1. 服务端对客户端请求的响应
    if (msg.id !== undefined && msg.method === undefined && (Object.hasOwn(msg, 'result') || Object.hasOwn(msg, 'error'))) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        const err = new Error(msg.error.message || JSON.stringify(msg.error));
        err.code = msg.error.code;
        err.data = msg.error.data;
        if (/unauth|not logged in|login required|authentication/i.test(err.message)) {
          this.authState = 'logged_out';
          this.lastTier = null;
        }
        entry.reject(err);
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    // 2. 服务端向客户端发起的反向请求：严格原样保留 msg.id 类型（agy 发送字符串 id 如 "1"）
    if (msg.id !== undefined && msg.id !== null && typeof msg.method === 'string') {
      this._handleServerRequest(msg.id, msg.method, msg.params || {});
      return;
    }

    // 3. 服务端单向通知
    if (typeof msg.method === 'string') {
      this._handleNotification(msg.method, msg.params || {});
    }
  }

  _handleServerRequest(rpcId, method, params) {
    if (method === 'session/request_permission') {
      const payload = normalizePermissionRequest(rpcId, params);
      const rawSid = payload.sessionId;
      const subInfo = rawSid ? this.subagentRoots.get(rawSid) : null;
      const rootSid = subInfo?.rootSessionId || rawSid;
      if (subInfo && rootSid && rootSid !== rawSid) {
        payload.sessionId = rootSid;
        payload.sourceSessionId = rawSid;
        payload.subagent = {
          id: rawSid,
          role: subInfo.role || '',
          typeName: subInfo.typeName || '',
          depth: subInfo.depth || 1,
          kind: subInfo.kind || 'subagent',
        };
      }
      const turn = rootSid ? this.turns.get(rootSid) : null;
      const inTurn = Boolean(turn && !turn.done && !turn.aborted);
      const key = String(rpcId);

      // 完全放行：不弹卡片，直接替用户点允许（挑不出允许项才退回正常审批）。
      // 子代理继承主会话的放行状态；bridge 自家没有对外副作用的工具任何模式下都直接放行。
      const canHandle = inTurn || Boolean(
        rootSid && (
          this.mountedSessions.has(rootSid)
          || this.knownSessions.has(rootSid)
          || this.bgHandlers?.hasSessionOwner?.(rootSid)
        )
      );
      if (!canHandle) {
        try { this._send({ id: rpcId, result: { outcome: { outcome: 'cancelled' } } }); } catch {}
        return;
      }

      // 插件的审批策略（ctx.claude.permission 带 agents:['agy']，八期）：这一轮登记了策略就先问它，再走下面的自动放行 / 审批卡。
      // 只管有人在的这一轮（inTurn）；后台唤醒 / 子代理收尾后的审批照旧。策略自己有时限（agy 单次调用 180 秒上限，见 plugin-permission.mjs）。
      if (inTurn && typeof turn.permissionPolicy === 'function') {
        Promise.resolve().then(() => turn.permissionPolicy(payload)).catch(() => null)
          .then((verdict) => this._routePermission(rpcId, payload, { rawSid, rootSid, key, verdict }));
        return;
      }
      this._routePermission(rpcId, payload, { rawSid, rootSid, key, verdict: null });
      return;
    }

    if (method === 'elicitation/create') {
      this._handleElicitation(rpcId, params);
      return;
    }

    try {
      this._send({
        id: rpcId,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
    } catch {}
  }

  // 审批请求的落点：插件说拒 / 放就照办；说 'ask' 就跳过自动放行（完全放行也不越过）直接弹卡；没表态照原来的口径。
  _routePermission(rpcId, payload, { rawSid, rootSid, key, verdict }) {
    {
      const turn = rootSid ? this.turns.get(rootSid) : null;
      const inTurn = Boolean(turn && !turn.done && !turn.aborted);
      const resolved = (outcome, optionId = null) => {
        try {
          turn?.onPermissionResolved?.({
            requestId: key, sessionId: rootSid, sourceSessionId: rawSid, toolCallId: payload.toolCall?.toolCallId || '',
            outcome, optionId, auto: true,
          });
        } catch {}
      };
      if (verdict && verdict.behavior === 'deny') {
        const opts = payload.options || [];
        const no = opts.find((o) => String(o.kind).startsWith('reject')) || opts.find((o) => /^(deny|reject)/i.test(String(o.optionId)));
        try { this._send({ id: rpcId, result: { outcome: no ? { outcome: 'selected', optionId: String(no.optionId) } : { outcome: 'cancelled' } } }); } catch {}
        resolved(no ? 'selected' : 'cancelled', no ? String(no.optionId) : null);
        return;
      }
      if (verdict && verdict.behavior === 'allow') {
        const allow = pickAllowOption(payload.options);
        if (allow) {
          try { this._send({ id: rpcId, result: { outcome: { outcome: 'selected', optionId: String(allow.optionId) } } }); } catch {}
          resolved('selected', String(allow.optionId));
          return;
        }
      }
      const forceAsk = !!(verdict && verdict.behavior === 'ask');
      if (forceAsk && !inTurn) {
        // 插件要用户批、可这一轮已经收了：没人能批，拒
        try { this._send({ id: rpcId, result: { outcome: { outcome: 'cancelled' } } }); } catch {}
        return;
      }

      const bypassOn = Boolean(rootSid && (this.isBypass(rootSid) || this.bgHandlers?.isBypass?.(rootSid)));
      const autoAllow = !forceAsk && (bypassOn || bridgeToolAutoAllow(payload.toolCall)) ? pickAllowOption(payload.options) : null;
      if (autoAllow) {
        try {
          this._send({ id: rpcId, result: { outcome: { outcome: 'selected', optionId: String(autoAllow.optionId) } } });
        } catch {}
        try {
          turn?.onPermissionResolved?.({
            requestId: key,
            sessionId: rootSid,
            sourceSessionId: rawSid,
            toolCallId: payload.toolCall?.toolCallId || '',
            outcome: 'selected',
            optionId: String(autoAllow.optionId),
            auto: true,
          });
        } catch {}
        return;
      }

      let timeoutMs = inTurn ? turn.permissionTimeoutMs : 0;
      let onResolved = inTurn ? (evt) => turn.onPermissionResolved?.(evt) : null;
      if (!inTurn) {
        // agy 后台自动唤醒或子代理发来的权限审批：不能因无活跃 turn 直接 cancel，交给后台监视器弹出审批卡
        let bg = null;
        try { bg = this.bgHandlers?.onPermission?.(payload) || null; } catch {}
        if (!bg || !bg.handled) {
          try { this._send({ id: rpcId, result: { outcome: { outcome: 'cancelled' } } }); } catch {}
          return;
        }
        timeoutMs = Math.max(0, Number(bg.timeoutMs) || 0);
        onResolved = typeof bg.onResolved === 'function' ? bg.onResolved : null;
      }

      const entry = {
        rpcId,
        requestId: key,
        sessionId: rootSid,
        rootSessionId: rootSid,
        sourceSessionId: rawSid,
        createdAt: Date.now(),
        payload,
        onResolved,
        // 超时 = 替用户取消。timeoutMs 为 0 时不设（一直等，同 Claude 的逐次审批）
        timer: timeoutMs > 0 ? setTimeout(() => {
          this.pendingPermissions.delete(key);
          try { this._send({ id: rpcId, result: { outcome: { outcome: 'cancelled' } } }); } catch {}
          try {
            onResolved?.({
              requestId: key,
              sessionId: rootSid,
              sourceSessionId: rawSid,
              toolCallId: payload.toolCall?.toolCallId || '',
              outcome: 'cancelled',
              optionId: null,
            });
          } catch {}
        }, timeoutMs) : null,
      };
      entry.timer?.unref?.();
      this.pendingPermissions.set(key, entry);
      if (inTurn) {
        try { turn.onPermission?.(payload); } catch {}
      }
      return;
    }
  }

  _handleElicitation(rpcId, params) {
    {
      // elicitation 若未带 sessionId：优先归属唯一活跃轮，其次归属后台唤醒中的活跃会话
      const fallbackSid = this.turns.size === 1
        ? [...this.turns.keys()][0]
        : (this.bgHandlers?.resolveSessionId?.() || null);
      const payload = normalizeElicitationRequest(rpcId, params, fallbackSid);
      const rawSid = payload.sessionId || '';
      const subInfo = rawSid ? this.subagentRoots.get(rawSid) : null;
      const rootSid = subInfo?.rootSessionId || rawSid;
      if (subInfo && rootSid && rootSid !== rawSid) {
        payload.sessionId = rootSid;
        payload.sourceSessionId = rawSid;
        payload.subagent = {
          id: rawSid,
          role: subInfo.role || '',
          typeName: subInfo.typeName || '',
          depth: subInfo.depth || 1,
          kind: subInfo.kind || 'subagent',
        };
      }
      const turn = rootSid ? this.turns.get(rootSid) : null;
      const inTurn = Boolean(turn && !turn.done && !turn.aborted);

      let timeoutMs = inTurn ? turn.questionTimeoutMs : 0;
      let onResolved = inTurn ? (evt) => turn.onQuestionResolved?.(evt) : null;
      if (!inTurn) {
        const knownBg = Boolean(
          rootSid && (
            this.mountedSessions.has(rootSid)
            || this.knownSessions.has(rootSid)
            || this.bgHandlers?.hasSessionOwner?.(rootSid)
          )
        );
        let bg = null;
        if (knownBg) {
          try { bg = this.bgHandlers?.onQuestion?.(payload) || null; } catch {}
        }
        if (!bg || !bg.handled) {
          try { this._send({ id: rpcId, result: { action: 'cancel' } }); } catch {}
          return;
        }
        timeoutMs = Math.max(0, Number(bg.timeoutMs) || 0);
        onResolved = typeof bg.onResolved === 'function' ? bg.onResolved : null;
      }

      const key = String(rpcId);
      const entry = {
        rpcId,
        requestId: key,
        sessionId: rootSid,
        rootSessionId: rootSid,
        sourceSessionId: rawSid,
        payload,
        onResolved,
        timer: timeoutMs > 0 ? setTimeout(() => {
          this.pendingQuestions.delete(key);
          try { this._send({ id: rpcId, result: { action: 'cancel' } }); } catch {}
          try { onResolved?.({ requestId: key, sessionId: rootSid, action: 'cancel', content: null }); } catch {}
        }, timeoutMs) : null,
      };
      entry.timer?.unref?.();
      this.pendingQuestions.set(key, entry);
      if (inTurn) {
        try { turn.onQuestion?.(payload); } catch {}
      }
      return;
    }
  }

  answerPermission(requestId, { optionId, outcome = 'selected', auto = false } = {}) {
    const key = String(requestId || '');
    const entry = this.pendingPermissions.get(key);
    if (!entry) return { ok: false, error: '该权限请求已结束或不存在' };
    this.pendingPermissions.delete(key);
    clearTimeout(entry.timer);

    const isCancelled = outcome === 'cancelled' || !optionId;
    const rpcResult = isCancelled
      ? { outcome: { outcome: 'cancelled' } }
      : { outcome: { outcome: 'selected', optionId: String(optionId) } };

    this._send({ id: entry.rpcId, result: rpcResult });
    const turn = this.turns.get(entry.sessionId);
    const resolvedEvt = {
      requestId: key,
      sessionId: entry.sessionId,
      sourceSessionId: entry.sourceSessionId || entry.sessionId,
      toolCallId: entry.payload?.toolCall?.toolCallId || '',
      outcome: isCancelled ? 'cancelled' : 'selected',
      optionId: isCancelled ? null : String(optionId),
      ...(auto ? { auto: true } : {}),
    };
    try {
      if (entry.onResolved) entry.onResolved(resolvedEvt);
      else turn?.onPermissionResolved?.(resolvedEvt);
    } catch {}
    return { ok: true, ...resolvedEvt };
  }

  answerQuestion(requestId, { action = 'accept', content = {} } = {}) {
    const key = String(requestId || '');
    const entry = this.pendingQuestions.get(key);
    if (!entry) return { ok: false, error: '该提问已结束或不存在' };
    this.pendingQuestions.delete(key);
    clearTimeout(entry.timer);

    const safeAction = ['accept', 'decline', 'cancel'].includes(action) ? action : 'cancel';
    const rpcResult = safeAction === 'accept'
      ? { action: 'accept', content: content && typeof content === 'object' ? content : {} }
      : { action: safeAction };

    this._send({ id: entry.rpcId, result: rpcResult });
    const turn = this.turns.get(entry.sessionId);
    const resolvedEvt = {
      requestId: key,
      sessionId: entry.sessionId,
      action: safeAction,
      content: safeAction === 'accept' ? rpcResult.content : null,
    };
    try {
      if (entry.onResolved) entry.onResolved(resolvedEvt);
      else turn?.onQuestionResolved?.(resolvedEvt);
    } catch {}
    return { ok: true, ...resolvedEvt };
  }

  _sessionModelInfo(sessionId) {
    const id = String(sessionId || '');
    const mounted = id ? this.mountedSessions.get(id) : null;
    const summary = mounted ? extractConfigSummary(mounted.configOptions, mounted.modes, mounted.models) : {};
    const desired = id ? this.knownSessions.get(id)?.desiredConfig : null;
    return {
      model: summary.model || desired?.model || '',
      thoughtLevel: summary.thoughtLevel || desired?.thought_level || '',
    };
  }

  _resolveSessionUsage(sessionId, rawUsage, liveLimits = peekAgyContextLimits(this)) {
    if (!rawUsage) return null;
    const { model, thoughtLevel } = this._sessionModelInfo(sessionId);
    return resolveEffectiveContextUsage(rawUsage, { model, thoughtLevel, liveLimits });
  }

  _recordSessionResult(sessionId, result = {}, params = {}) {
    const id = String(sessionId || result.sessionId || '');
    if (!id) return null;
    this.authState = 'authed';
    const tier = result._meta?.antigravity?.tier || null;
    if (tier) this.lastTier = tier;
    if (result.configOptions || result.models || result.modes) {
      this.lastCatalog = {
        models: result.models || this.lastCatalog?.models || null,
        modes: result.modes || this.lastCatalog?.modes || null,
        configOptions: this._decorCatalog(result.configOptions || this.lastCatalog?.configOptions || []),
      };
    }

    const prevMounted = this.mountedSessions.get(id) || {};
    const bypassOn = this.isBypass(id);
    const snapshot = {
      sessionId: id,
      cwd: params.cwd || prevMounted.cwd || '',
      models: result.models || prevMounted.models || null,
      modes: decorateModes(result.modes || prevMounted.modes || null, bypassOn),
      configOptions: decorateModeOptions(result.configOptions || prevMounted.configOptions || [], bypassOn),
      commands: prevMounted.commands || [],
      title: prevMounted.title || '',
      rawUsage: prevMounted.rawUsage || null,
      usage: prevMounted.usage || null,
      tier: tier || prevMounted.tier || this.lastTier || null,
      lastActiveAt: Date.now(),
    };
    this.mountedSessions.set(id, snapshot);
    warmAgyContextLimits(this);
    if (snapshot.rawUsage) {
      snapshot.usage = this._resolveSessionUsage(id, snapshot.rawUsage) || snapshot.usage;
    }
    return snapshot;
  }

  _handleNotification(method, params) {
    if (method !== 'session/update') return;
    const sessionId = String(params.sessionId || '');
    const update = params.update;
    if (!sessionId || !update) return;
    // 子代理仅为接通权限审批流而临时 resume：忽略其 session/update，免得冲掉主会话的目录/配置缓存或塞进历史
    if (this.subagentRoots.has(sessionId) && !this.mountedSessions.has(sessionId)) return;

    // 放行中的会话被 agy 自己切到了 auto 以外的模式（比如模型调用切模式工具进计划）→ 视为退出放行；
    // 补发配置（model -> thought_level -> mode）途中 agy 推回的旧 mode 是中间态，不在此判定
    if (this.isBypass(sessionId) && !this.applyingConfig.has(sessionId)) {
      const agentMode = update.sessionUpdate === 'current_mode_update'
        ? update.currentModeId
        : (update.sessionUpdate === 'config_option_update' ? extractConfigSummary(update.configOptions).mode : null);
      if (agentMode && agentMode !== BYPASS_BASE_MODE && agentMode !== BYPASS_MODE) {
        this.rememberSession(sessionId, { desiredConfig: { mode: agentMode } });
      }
    }
    const bypassOn = this.isBypass(sessionId);

    const mounted = this.mountedSessions.get(sessionId);
    if (mounted) {
      mounted.lastActiveAt = Date.now();
      if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
        mounted.configOptions = decorateModeOptions(update.configOptions, bypassOn);
        if (this.lastCatalog) this.lastCatalog.configOptions = this._decorCatalog(update.configOptions);
        if (mounted.rawUsage) {
          mounted.usage = this._resolveSessionUsage(sessionId, mounted.rawUsage) || mounted.usage;
        }
      } else if (update.sessionUpdate === 'current_mode_update' && mounted.modes) {
        mounted.modes = decorateModes({ ...mounted.modes, currentModeId: update.currentModeId }, bypassOn);
      } else if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
        mounted.commands = update.availableCommands;
      } else if (update.sessionUpdate === 'session_info_update' && typeof update.title === 'string') {
        mounted.title = update.title;
      } else if (update.sessionUpdate === 'usage_update') {
        warmAgyContextLimits(this);
        const rawUsage = { used: Math.max(0, Number(update.used) || 0), size: Math.max(0, Number(update.size) || 0) };
        mounted.rawUsage = rawUsage;
        mounted.usage = this._resolveSessionUsage(sessionId, rawUsage) || rawUsage;
      }
    }

    const collector = this.loadCollectors.get(sessionId);
    if (collector) {
      collector.push({ params: { sessionId, update } });
      try { collector.onPush?.(update); } catch {}
    }

    const converted = convertSessionUpdate(sessionId, update).map((evt) => {
      if (evt.type === 'config') {
        const configOptions = decorateModeOptions(evt.configOptions, bypassOn);
        return {
          ...evt,
          configOptions,
          mode: extractConfigSummary(configOptions).mode,
          ...(mounted?.usage ? { usage: mounted.usage } : {}),
        };
      }
      if (evt.type === 'mode') return { ...evt, modeId: decorateModes({ currentModeId: evt.modeId }, bypassOn).currentModeId };
      if (evt.type === 'usage') {
        warmAgyContextLimits(this);
        const resolved = this._resolveSessionUsage(sessionId, { used: evt.used, size: evt.size });
        return resolved ? { ...evt, ...resolved } : evt;
      }
      return evt;
    });
    for (const evt of converted) {
      if (evt.type === 'title' || evt.type === 'config' || evt.type === 'mode' || evt.type === 'usage' || evt.type === 'commands') {
        this._emitSessionEvent({ ...evt, sessionId });
      }
    }

    const turn = this.turns.get(sessionId);
    if (turn && !turn.done) {
      const hist = this.historyUpdates.get(sessionId);
      if (hist && !collector) hist.push({ params: { sessionId, update } });
      for (const evt of converted) {
        if (evt.type === 'text') { turn.finalText += evt.text; turn.segText += evt.text; }
        else if (evt.type === 'thinking') turn.thinkingText += evt.text;
        if (evt.type === 'text' || evt.type === 'thinking' || String(evt.type).startsWith('tool')) turn.progress += 1;
        try { turn.onEvent?.(evt); } catch {}
      }
    } else if (!collector && mounted) {
      // 无活跃用户轮但会话仍挂载时收到 agy 主动推送的更新，记进历史以免丢失
      const hist = this.historyUpdates.get(sessionId);
      if (hist) hist.push({ params: { sessionId, update } });
    }
  }

  _isMountedSessionProtected(sessionId) {
    const id = String(sessionId || '');
    if (!id) return true;
    if (this.turns.has(id) || this.inflightLoads.has(id) || this.sessionLocks.has(id)) return true;
    for (const entry of this.pendingPermissions.values()) {
      if (entry.sessionId === id || entry.rootSessionId === id || entry.sourceSessionId === id) return true;
    }
    for (const entry of this.pendingQuestions.values()) {
      if (entry.sessionId === id || entry.rootSessionId === id || entry.sourceSessionId === id) return true;
    }
    try {
      if (this.bgHandlers?.hasAliveBackground?.(id)) return true;
    } catch {}
    return false;
  }

  // --process-per-session 下空闲挂载会话仍各占一个 worker 进程：超过上限后按最久未活跃顺序
  // 关闭空闲会话（仅释放 worker，保留 historyUpdates 与 knownSessions，下次续聊无缝重挂）。
  _evictIdleMountedSessions(keepSessionId = '') {
    const limit = this.maxIdleMountedSessions;
    if (!limit || !this.ready || !this.proc || this.shuttingDown) return;
    const keep = String(keepSessionId || '');
    const evictable = [];
    for (const [sid, snap] of this.mountedSessions.entries()) {
      if (sid === keep) continue;
      if (this._isMountedSessionProtected(sid)) continue;
      evictable.push({ sid, lastActiveAt: Number(snap?.lastActiveAt) || 0 });
    }
    const overflow = evictable.length - limit;
    if (overflow <= 0) return;
    evictable.sort((a, b) => a.lastActiveAt - b.lastActiveAt);
    for (const { sid } of evictable.slice(0, overflow)) {
      this.closeSession(sid).catch(() => {});
    }
  }

  async createSession({ cwd, mcpServers = [], systemPromptAppend = '', additionalDirectories = [], desiredConfig = {} } = {}) {
    const rawDir = cwd || os.homedir();
    const workDir = normalizeAgyPath(rawDir) || rawDir;
    const meta = buildAntigravityMeta({ systemPromptAppend, additionalDirectories });
    const result = await this.request('session/new', {
      cwd: workDir,
      mcpServers,
      ...(meta ? { _meta: meta } : {}),
    }, 45_000);

    const sessionId = String(result.sessionId || '');
    if (!sessionId) throw new Error('Antigravity ACP 未返回 sessionId');

    this.rememberSession(sessionId, {
      cwd: workDir,
      forceCwd: true,
      mcpServers,
      systemPromptAppend,
      additionalDirectories,
      desiredConfig,
    });
    let snapshot = this._recordSessionResult(sessionId, result, { cwd: workDir });
    this._setHistory(sessionId, []);

    if (desiredConfig && Object.keys(desiredConfig).length > 0) {
      snapshot = await this.applyDesiredConfig(sessionId, desiredConfig);
    }
    this._evictIdleMountedSessions(sessionId);
    return snapshot;
  }

  // 按 model -> thought_level -> mode 顺序补发配置：切模型会改变 thought_level 的可选集合，顺序反了可能报档位不存在
  async applyDesiredConfig(sessionId, desired = {}) {
    const id = String(sessionId || '');
    if (!id || !desired || typeof desired !== 'object') return this.mountedSessions.get(id) || null;

    const known = this.knownSessions.get(id);
    if (known) {
      known.desiredConfig = { ...known.desiredConfig, ...desired };
    } else if (desired.mode) {
      this.rememberSession(id, { desiredConfig: { mode: desired.mode } });
    }

    const applyOne = async (configId, targetVal) => {
      if (!targetVal) return;
      const mounted = this.mountedSessions.get(id);
      const opts = mounted?.configOptions || [];
      const opt = opts.find((c) => c && (c.id === configId || c.category === configId));
      if (opt) {
        // 快照里的模式值可能已被改写成 bypass，比较时按 agy 的真实值
        const cur = configId === 'mode' ? toAcpMode(String(opt.currentValue)) : String(opt.currentValue);
        if (cur === String(targetVal)) return;
        const allowed = flattenConfigValues(opt);
        if (allowed.length > 0 && !allowed.includes(String(targetVal))) return;
      }
      const res = await this.request('session/set_config_option', {
        sessionId: id,
        configId: opt?.id || configId,
        value: String(targetVal),
      }, 20_000);
      if (res?.configOptions && mounted) {
        mounted.configOptions = res.configOptions;
        if (this.lastCatalog) this.lastCatalog.configOptions = this._decorCatalog(res.configOptions);
      }
    };

    this.applyingConfig.add(id);
    try {
      if (desired.model) await applyOne('model', desired.model);
      if (desired.thought_level) await applyOne('thought_level', desired.thought_level);
      if (desired.mode) await applyOne('mode', toAcpMode(desired.mode));
      this._syncBypass(id);
    } finally {
      this.applyingConfig.delete(id);
    }

    return this.mountedSessions.get(id) || null;
  }

  async _ensureSessionMountedUnlocked(sessionId, opts = {}) {
    const id = String(sessionId || '');
    if (!id) throw new Error('缺少 sessionId');
    await this.ensureStarted();

    const prevKnown = this.knownSessions.get(id);
    const known = this.rememberSession(id, opts);
    if (this.mountedSessions.has(id)) {
      if (opts.desiredConfig && Object.keys(opts.desiredConfig).length > 0) {
        return this.applyDesiredConfig(id, opts.desiredConfig);
      }
      return this.mountedSessions.get(id);
    }

    const rawDir = known.cwd || opts.cwd || os.homedir();
    const workDir = normalizeAgyPath(rawDir) || rawDir;
    const meta = buildAntigravityMeta({
      systemPromptAppend: known.systemPromptAppend,
      additionalDirectories: known.additionalDirectories,
    });
    let result;
    try {
      result = await this.request('session/resume', {
        sessionId: id,
        cwd: workDir,
        mcpServers: known.mcpServers || [],
        ...(meta ? { _meta: meta } : {}),
      }, 45_000);
    } catch (err) {
      // resume 失败（例如伪造的不存在 sessionId）时回滚本次临时登记的 knownSessions，避免留下脏记录
      if (!prevKnown) this.knownSessions.delete(id);
      throw err;
    }

    this._recordSessionResult(id, result, { cwd: workDir });
    if (known.desiredConfig && Object.keys(known.desiredConfig).length > 0) {
      await this.applyDesiredConfig(id, known.desiredConfig);
    }
    this._evictIdleMountedSessions(id);
    return this.mountedSessions.get(id);
  }

  async ensureSessionMounted(sessionId, opts = {}) {
    const id = String(sessionId || '');
    if (!id) throw new Error('缺少 sessionId');
    return this._withSessionLock(id, () => this._ensureSessionMountedUnlocked(id, opts));
  }

  async loadSessionWithReplay(sessionId, { cwd, fallbackCwd = '', forceCwd = false, mcpServers, systemPromptAppend, additionalDirectories, desiredConfig, toolingSig = '' } = {}) {
    const id = String(sessionId || '');
    if (!id) throw new Error('缺少 sessionId');
    if (this.turns.has(id)) {
      throw Object.assign(new Error('该会话正在生成中，请直接挂载实时流'), { status: 409 });
    }
    // 打开历史也算一次挂载：工具清单变了先在这里换进程（空闲时当场重启，下面的 ensureStarted 接着等它就绪）
    this.noteTooling(toolingSig);
    while (this._idleRestartPromise) {
      try { await this._idleRestartPromise; } catch {}
    }

    // 同一会话的并发 load 合并复用同一个 Promise，防止后一个覆盖收集器导致前一个拿到空历史
    const inflight = this.inflightLoads.get(id);
    if (inflight) return inflight;

    const loadTask = this._withSessionLock(id, () => this._loadWithReplayUnlocked(id, {
      cwd, fallbackCwd, forceCwd, mcpServers, systemPromptAppend, additionalDirectories, desiredConfig,
    })).finally(() => {
      if (this.inflightLoads.get(id) === loadTask) {
        this.inflightLoads.delete(id);
      }
      this._scheduleIdleRestartCheck();
    });

    this.inflightLoads.set(id, loadTask);
    return loadTask;
  }

  // 须在会话锁内调用：close（若已挂载）→ session/load 全量回放，回放结果同时记成该会话的历史
  async _loadWithReplayUnlocked(id, { cwd, fallbackCwd = '', forceCwd = false, mcpServers, systemPromptAppend, additionalDirectories, desiredConfig } = {}) {
    {
      if (this.turns.has(id)) {
        throw Object.assign(new Error('该会话正在生成中，请直接挂载实时流'), { status: 409 });
      }
      await this.ensureStarted();
      if (this.turns.has(id)) {
        throw Object.assign(new Error('该会话正在生成中，请直接挂载实时流'), { status: 409 });
      }

      const prevKnown = this.knownSessions.get(id);
      const known = this.rememberSession(id, {
        cwd: cwd || '',
        forceCwd,
        mcpServers,
        systemPromptAppend,
        additionalDirectories,
        desiredConfig,
      });
      const rawDir = known.cwd || cwd || fallbackCwd || os.homedir();
      const workDir = normalizeAgyPath(rawDir) || rawDir;

      // 已挂载在内存中的空闲会话先 close 再 load，确保 agy 完整重放整条历史轨迹；每个 await 后复查活跃轮。
      // 但若会话有活着的子代理或后台任务，绝不能调用 session/close（agy 内部会调 ForceStopCascadeTree 杀光整棵子代理树）：
      // 改为直接同步磁盘上后台唤醒的新步骤到内存历史并返回，保持子代理链完好无损。
      if (this.mountedSessions.has(id)) {
        if (this.bgHandlers?.hasAliveBackground?.(id)) {
          try { this.bgHandlers.syncDiskTail?.(id); } catch {}
          let updates = this.historyUpdates.get(id);
          if (!updates && typeof this.bgHandlers.rebuildHistory === 'function') {
            try {
              const rebuilt = this.bgHandlers.rebuildHistory(id);
              if (Array.isArray(rebuilt)) {
                this._setHistory(id, rebuilt);
                updates = this.historyUpdates.get(id);
              }
            } catch {}
          }
          if (known.desiredConfig && Object.keys(known.desiredConfig).length > 0) {
            await this.applyDesiredConfig(id, known.desiredConfig);
          }
          return {
            snapshot: this.mountedSessions.get(id),
            updates: [...(updates || [])],
            preservedAlive: true,
          };
        }
        try {
          await this.request('session/close', { sessionId: id }, 10_000);
        } catch {}
        this.mountedSessions.delete(id);
        if (this.turns.has(id)) {
          throw Object.assign(new Error('该会话正在生成中，请直接挂载实时流'), { status: 409 });
        }
      }

      const collected = [];
      this.loadCollectors.set(id, collected);
      let result;
      try {
        const meta = buildAntigravityMeta({
          systemPromptAppend: known.systemPromptAppend,
          additionalDirectories: known.additionalDirectories,
        });
        result = await this.request('session/load', {
          sessionId: id,
          cwd: workDir,
          mcpServers: known.mcpServers || [],
          ...(meta ? { _meta: meta } : {}),
        }, 60_000);
        await this._awaitReplayTail(collected);
      } catch (err) {
        if (!prevKnown) this.knownSessions.delete(id);
        throw err;
      } finally {
        if (this.loadCollectors.get(id) === collected) {
          this.loadCollectors.delete(id);
        }
      }

      this._recordSessionResult(id, result, { cwd: workDir });
      this._setHistory(id, [...collected]);
      if (known.desiredConfig && Object.keys(known.desiredConfig).length > 0) {
        await this.applyDesiredConfig(id, known.desiredConfig);
      }
      const mountedNow = this.mountedSessions.get(id);
      if (mountedNow) {
        for (let i = collected.length - 1; i >= 0; i--) {
          const u = collected[i]?.params?.update;
          if (u?.sessionUpdate === 'usage_update') {
            mountedNow.rawUsage = { used: Math.max(0, Number(u.used) || 0), size: Math.max(0, Number(u.size) || 0) };
            break;
          }
        }
        if (mountedNow.rawUsage) {
          const liveLimits = await getAgyContextLimits(this, { timeoutMs: 400 }).catch(() => null);
          mountedNow.usage = this._resolveSessionUsage(id, mountedNow.rawUsage, liveLimits) || mountedNow.rawUsage;
        }
      }
      this._evictIdleMountedSessions(id);
      return {
        snapshot: mountedNow,
        updates: [...collected],
      };
    }
  }

  // load 响应之后继续收回放尾巴：静默一段时间或到上限才止（session_info_update 可能夹在中间，不能据此收尾）
  _awaitReplayTail(collected, { quietMs = REPLAY_QUIET_MS, capMs = REPLAY_TAIL_CAP_MS } = {}) {
    return new Promise((resolve) => {
      let quietTimer = null;
      let capTimer = null;
      const finish = () => {
        clearTimeout(quietTimer);
        clearTimeout(capTimer);
        collected.onPush = null;
        resolve();
      };
      const arm = () => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, quietMs);
      };
      capTimer = setTimeout(finish, capMs);
      collected.onPush = () => arm();
      arm();
    });
  }

  async setConfigOption(sessionId,configId, value, sessionMeta = {}) {
    const id = String(sessionId || '');
    const key = String(configId || '');
    const val = String(value ?? '');
    if (!id || !key) throw new Error('缺少 sessionId 或 configId');

    return this._withSessionLock(id, async () => {
      const desiredPatch = {};
      if (key === 'model' || key === 'thought_level' || key === 'mode') {
        desiredPatch[key] = val;
      }
      await this._ensureSessionMountedUnlocked(id, { ...sessionMeta, desiredConfig: {} });
      // 模式先记下再发：set 期间 agy 推来的 config 更新要按新的放行状态改写
      const prevMode = this.knownSessions.get(id)?.desiredConfig?.mode;
      if (key === 'mode') this.rememberSession(id, { desiredConfig: { mode: val } });
      let res;
      try {
        res = await this.request('session/set_config_option', {
          sessionId: id,
          configId: key,
          value: key === 'mode' ? toAcpMode(val) : val,
        }, 20_000);
      } catch (err) {
        if (key === 'mode') this.rememberSession(id, { desiredConfig: { mode: prevMode } });
        throw err;
      }

      this.rememberSession(id, { ...sessionMeta, desiredConfig: desiredPatch });
      const mounted = this.mountedSessions.get(id);
      if (res?.configOptions && mounted) {
        mounted.configOptions = res.configOptions;
        if (this.lastCatalog) this.lastCatalog.configOptions = this._decorCatalog(res.configOptions);
      }
      this._syncBypass(id);
      const cfgOut = mounted?.configOptions || decorateModeOptions(res?.configOptions || [], this.isBypass(id));
      if (mounted?.rawUsage) {
        const liveLimits = await getAgyContextLimits(this, { timeoutMs: 400 }).catch(() => null);
        mounted.usage = this._resolveSessionUsage(id, mounted.rawUsage, liveLimits) || mounted.usage;
      }
      return {
        configOptions: cfgOut,
        ...extractConfigSummary(cfgOut, mounted?.modes, mounted?.models),
        ...(mounted?.usage ? { usage: mounted.usage } : {}),
      };
    });
  }

  async setMode(sessionId, modeId, sessionMeta = {}) {
    const id = String(sessionId || '');
    const val = String(modeId || '');
    return this._withSessionLock(id, async () => {
      await this._ensureSessionMountedUnlocked(id, sessionMeta);
      const prevMode = this.knownSessions.get(id)?.desiredConfig?.mode;
      this.rememberSession(id, { desiredConfig: { mode: val } });
      try {
        await this.request('session/set_mode', { sessionId: id, modeId: toAcpMode(val) }, 20_000);
      } catch (err) {
        this.rememberSession(id, { desiredConfig: { mode: prevMode } });
        throw err;
      }
      this.rememberSession(id, { ...sessionMeta, desiredConfig: { mode: val } });
      this._syncBypass(id);
      const mounted = this.mountedSessions.get(id);
      return {
        mode: val,
        configOptions: mounted?.configOptions || [],
      };
    });
  }

  async setModel(sessionId, modelId, sessionMeta = {}) {
    const id = String(sessionId || '');
    const val = String(modelId || '');
    return this._withSessionLock(id, async () => {
      await this._ensureSessionMountedUnlocked(id, sessionMeta);
      await this.request('session/set_model', { sessionId: id, modelId: val }, 20_000);
      const mounted = this.mountedSessions.get(id);
      const summary = extractConfigSummary(mounted?.configOptions || [], mounted?.modes, mounted?.models);
      this.rememberSession(id, {
        ...sessionMeta,
        desiredConfig: {
          ...(summary.model ? { model: summary.model } : { model: val }),
          ...(summary.thoughtLevel ? { thought_level: summary.thoughtLevel } : {}),
        },
      });
      if (mounted?.rawUsage) {
        const liveLimits = await getAgyContextLimits(this, { timeoutMs: 400 }).catch(() => null);
        mounted.usage = this._resolveSessionUsage(id, mounted.rawUsage, liveLimits) || mounted.usage;
      }
      return {
        ...summary,
        configOptions: mounted?.configOptions || [],
        ...(mounted?.usage ? { usage: mounted.usage } : {}),
      };
    });
  }

  async listSessions({ cwd } = {}) {
    const res = await this.request('session/list', {
      cwd: cwd || this.daemonCwd,
    }, 30_000);
    return Array.isArray(res?.sessions) ? res.sessions : [];
  }

  async closeSession(sessionId) {
    const id = String(sessionId || '');
    if (!id) return;
    return this._withSessionLock(id, async () => {
      if (!this.mountedSessions.has(id)) return;
      try {
        await this.request('session/close', { sessionId: id }, 10_000);
      } finally {
        this.mountedSessions.delete(id);
      }
    });
  }

  cancelSession(sessionId) {
    const id = String(sessionId || '');
    if (!id || !this.ready || !this.proc) return false;
    try {
      this._notify('session/cancel', { sessionId: id });
    } catch {
      return false;
    }
    // 清理本地挂起的权限与提问定时器，避免取消后残留悬空等待
    for (const [k, entry] of this.pendingPermissions.entries()) {
      if (entry.sessionId === id) {
        clearTimeout(entry.timer);
        this.pendingPermissions.delete(k);
      }
    }
    for (const [k, entry] of this.pendingQuestions.entries()) {
      if (entry.sessionId === id) {
        clearTimeout(entry.timer);
        this.pendingQuestions.delete(k);
      }
    }
    return true;
  }

  async logout() {
    if (!this.ready || !this.proc) await this.ensureStarted();
    await this.request('logout', {}, 15_000);
    this.authState = 'logged_out';
    this.lastTier = null;
    return { ok: true };
  }

  async runPrompt({
    sessionId,
    cwd,
    promptBlocks,
    mcpServers = [],
    systemPromptAppend = '',
    additionalDirectories = [],
    desiredConfig = {},
    toolingSig = '',
    signal,
    timeoutMs = 0,
    // 审批卡 / 表单提问多久没人理就替用户取消；0 = 一直等（等到有人答，或这一轮被停掉）
    permissionTimeoutMs = 10 * 60_000,
    questionTimeoutMs = 10 * 60_000,
    onSession,
    onEvent,
    onPermission,
    onPermissionResolved,
    // 插件的审批策略（plugin-permission.mjs 造）：async (payload) → null | { behavior: 'allow' | 'deny' | 'ask', message? }
    permissionPolicy = null,
    onQuestion,
    onQuestionResolved,
    // 这一轮正常收尾时问一句「后台还有没有要等的」：返回一组提示块就接着发（同一轮继续），返回空就真的结束。
    // agy 的后台子代理回报要靠下一条 session/prompt 才送达，见 ../background.mjs。
    onIdle,
  } = {}) {
    if (signal?.aborted) {
      return { sessionId: sessionId || null, status: 'interrupted', stopReason: 'cancelled', text: '', thinking: '', isError: false, errorMsg: '', usage: null };
    }

    // 工具清单变了就在这里触发空闲重启（必须在占位之前：占了位就算忙，重启只能顺延到这一轮之后）
    this.noteTooling(toolingSig);

    // 同步占位：从进入 runPrompt 到登记 this.turns 全程阻塞静默空闲重启，消除 session/new 或 resume 在途被误杀的竞态；
    // 若此刻已有空闲重启在途，则先等新进程就绪再落座。
    this.preparingTurns += 1;
    let resolveTurn;
    const resultPromise = new Promise((resolve) => { resolveTurn = resolve; });

    const buildTurn = (activeId) => {
      const turn = {
        sessionId: activeId,
        finalText: '',
        thinkingText: '',
        // 最近一条用户消息（开头那条或之后的插话）之后的正文：被停下时记「这一段说到哪」用
        segText: '',
        done: false,
        aborted: false,
        // 一轮里可以先后发好几条 session/prompt（中途插话、后台回报续接），只有最新那条的返回才算这一轮的结局
        promptSeq: 0,
        // 这一轮收到过多少条模型输出（正文 / 思考 / 工具）：判断被拒的 prompt 是不是还没开始干活、能不能换个写法重发
        progress: 0,
        wakes: 0,
        usageParts: [],
        idleAbort: null,
        sendPrompt: null,
        killTimer: null,
        cancelGraceTimer: null,
        permissionTimeoutMs: Math.max(0, Number(permissionTimeoutMs) || 0),
        questionTimeoutMs: Math.max(0, Number(questionTimeoutMs) || 0),
        onEvent,
        onPermission,
        onPermissionResolved,
        permissionPolicy: typeof permissionPolicy === 'function' ? permissionPolicy : null,
        onQuestion,
        onQuestionResolved,
        finish: (status, errorMsg = '', promptResult = null) => {
          if (turn.done) return;
          turn.done = true;
          clearTimeout(turn.killTimer);
          clearTimeout(turn.cancelGraceTimer);
          if (signal) signal.removeEventListener?.('abort', turn.abort);
          if (this.turns.get(activeId) === turn) this.turns.delete(activeId);
          const mountedDone = this.mountedSessions.get(activeId);
          if (mountedDone) mountedDone.lastActiveAt = Date.now();
          this._evictIdleMountedSessions(activeId);
          this._scheduleIdleRestartCheck();

          for (const [k, entry] of this.pendingPermissions.entries()) {
            if (entry.sessionId !== activeId) continue;
            // 主轮正常收尾时，挂着的子代理审批不能随之丢弃：交由后台监视器接管继续展示给用户
            if (status === 'completed' && entry.sourceSessionId && entry.sourceSessionId !== activeId) {
              entry.onResolved = null;
              continue;
            }
            clearTimeout(entry.timer);
            this.pendingPermissions.delete(k);
          }
          for (const [k, entry] of this.pendingQuestions.entries()) {
            if (entry.sessionId === activeId) {
              clearTimeout(entry.timer);
              this.pendingQuestions.delete(k);
            }
          }

          try { turn.idleAbort?.abort(); } catch {}
          const mountedNow = this.mountedSessions.get(activeId);
          resolveTurn({
            sessionId: activeId,
            status,
            stopReason: promptResult?.stopReason || (status === 'interrupted' ? 'cancelled' : 'end_turn'),
            text: turn.finalText,
            segText: turn.segText,
            thinking: turn.thinkingText,
            isError: status === 'failed' || status === 'timed_out',
            errorMsg,
            usage: sumUsage(turn.usageParts) || promptResult?.usage || null,
            contextUsage: mountedNow?.usage || null,
          });
        },
        abort: () => {
          if (turn.done || turn.aborted) return;
          turn.aborted = true;
          // 正等着后台回报（此刻 agy 那头没有在途的 prompt）：先让等待返回，下面的取消对 agy 是空操作
          try { turn.idleAbort?.abort(); } catch {}
          this.cancelSession(activeId);
          turn.cancelGraceTimer = setTimeout(() => {
            turn.finish('interrupted', '');
          }, 10_000);
          turn.cancelGraceTimer.unref?.();
        },
      };
      return turn;
    };

    let snapshot;
    let activeId;
    let turn;
    let fallbackBlocks = null;

    try {
      while (this._idleRestartPromise) {
        try { await this._idleRestartPromise; } catch {}
      }
      await this.ensureStarted();
      // 内容块要按 agy 刚报的能力组装（附件能不能作为音频 / 文件内容送入），调用方给的是组装函数
      if (typeof promptBlocks === 'function') {
        const plan = promptBlocks(this.promptCapabilities());
        promptBlocks = Array.isArray(plan) ? plan : (plan?.blocks || []);
        fallbackBlocks = Array.isArray(plan?.fallback) ? plan.fallback : null;
      }

      if (sessionId) {
        const targetSid = String(sessionId);
        if (this.turns.has(targetSid)) {
          throw Object.assign(new Error('该 Antigravity 会话已有任务正在执行'), { status: 409 });
        }
        // 挂载与占位登记必须在同一把会话锁内完成，防止与 loadSessionWithReplay 的 close 窗口竞态
        await this._withSessionLock(targetSid, async () => {
          if (this.turns.has(targetSid)) {
            throw Object.assign(new Error('该 Antigravity 会话已有任务正在执行'), { status: 409 });
          }
          const mountOpts = { cwd, mcpServers, systemPromptAppend, additionalDirectories, desiredConfig };
          // 本进程还没有这个会话的历史（服务重启后直接续聊、或从别的端发来）：用 session/load 代替 resume 挂载，
          // 顺手拿到全量历史——之后有人在它跑的时候点开，才能看到这一轮之前的对话
          snapshot = this.historyUpdates.has(targetSid)
            ? await this._ensureSessionMountedUnlocked(targetSid, mountOpts)
            : (await this._loadWithReplayUnlocked(targetSid, mountOpts)).snapshot;
          activeId = snapshot.sessionId;
          if (this.turns.has(activeId)) {
            throw Object.assign(new Error('该 Antigravity 会话已有任务正在执行'), { status: 409 });
          }
          turn = buildTurn(activeId);
          this.turns.set(activeId, turn);
        });
      } else {
        snapshot = await this.createSession({
          cwd,
          mcpServers,
          systemPromptAppend,
          additionalDirectories,
          desiredConfig,
        });
        activeId = snapshot.sessionId;
        if (this.turns.has(activeId)) {
          throw Object.assign(new Error('该 Antigravity 会话已有任务正在执行'), { status: 409 });
        }
        turn = buildTurn(activeId);
        this.turns.set(activeId, turn);
      }
    } finally {
      this.preparingTurns = Math.max(0, this.preparingTurns - 1);
      if (!turn) this._scheduleIdleRestartCheck();
    }

    // 历史里先记下本轮的用户消息；historyBase 之前的部分就是「本轮开始之前」的历史
    const hist = this.historyUpdates.get(activeId);
    if (hist) {
      turn.historyBase = hist.length;
      for (const block of (Array.isArray(promptBlocks) ? promptBlocks : [])) {
        if (block?.type !== 'text' && block?.type !== 'image') continue;
        hist.push({ params: { sessionId: activeId, update: { sessionUpdate: 'user_message_chunk', content: block } } });
      }
    }

    try { onSession?.(snapshot); } catch {}

    if (signal?.aborted) {
      turn.finish('interrupted', '');
      return resultPromise;
    }

    if (signal) signal.addEventListener('abort', turn.abort, { once: true });
    if (signal?.aborted) {
      turn.abort();
      return resultPromise;
    }

    if (timeoutMs > 0) {
      turn.killTimer = setTimeout(() => {
        this.cancelSession(activeId);
        turn.finish('timed_out', `Antigravity 执行超时（${Math.round(timeoutMs / 1000)}s）`);
      }, timeoutMs);
      turn.killTimer.unref?.();
    }

    // 交互式对话本身可能持续数十分钟（含等待用户审批权限或回答提问），不设短 RPC 超时，靠心跳与取消信号控制
    const rpcTimeout = timeoutMs > 0 ? timeoutMs + 5000 : 24 * 3600_000;
    // 同一轮里可以再发：agy 在一条 prompt 还没答完时收到下一条，会让前一条立刻以 end_turn 返回、
    // 把新消息在下一步之前送给模型（实测）。所以前一条的返回不代表这一轮结束，只认序号最新的那条。
    // fallback：这条带了 agy 可能不认的内容块（audio / resource）时的保守写法。agy 直接拒收、且还没产出任何东西时改发它一次，
    // 免得一个附件让整轮失败。
    turn.sendPrompt = (blocks, fallback = null) => {
      const mySeq = ++turn.promptSeq;
      const superseded = () => mySeq !== turn.promptSeq;
      const progressAtSend = turn.progress;
      this._requestRaw('session/prompt', {
        sessionId: activeId,
        prompt: Array.isArray(blocks) ? blocks : [],
      }, rpcTimeout).then(async (promptRes) => {
        if (promptRes?.usage) turn.usageParts.push(promptRes.usage);
        if (turn.done || superseded()) return;
        const stopReason = promptRes?.stopReason || 'end_turn';
        if (stopReason === 'cancelled' || turn.aborted) {
          turn.finish('interrupted', '', promptRes);
          return;
        }
        if (typeof onIdle === 'function' && turn.wakes < MAX_WAKES_PER_TURN) {
          const waiting = new AbortController();
          turn.idleAbort = waiting;
          let next = null;
          try { next = await onIdle({ sessionId: activeId, signal: waiting.signal }); } catch {}
          if (turn.idleAbort === waiting) turn.idleAbort = null;
          // 等的这段时间里：这一轮被停了 / 用户插了话（由那一条接着往下走）
          if (turn.done || superseded()) return;
          if (turn.aborted) { turn.finish('interrupted', '', promptRes); return; }
          if (Array.isArray(next) && next.length) {
            turn.wakes += 1;
            // 续接后的回答和前面那句分开成段
            if (turn.finalText && !/\n\s*$/.test(turn.finalText)) turn.finalText += '\n\n';
            turn.sendPrompt(next);
            return;
          }
        }
        turn.finish('completed', '', promptRes);
      }).catch((err) => {
        if (turn.done || superseded()) return;
        if (turn.aborted) {
          turn.finish('interrupted', '');
        } else if (Array.isArray(fallback) && fallback.length && Number.isInteger(err?.code) && turn.progress === progressAtSend) {
          turn.sendPrompt(fallback);
        } else {
          // 出错的是后来补发的那条（插话 / 续接）时，前一条可能还在 agy 那边跑着：先让它停，
          // 不然这边报了失败、那边还在悄悄动文件，下一条消息又会和它撞在一起
          if (mySeq > 1) { try { this.cancelSession(activeId); } catch {} }
          turn.finish('failed', err?.message || String(err));
        }
      });
    };
    turn.sendPrompt(promptBlocks, fallbackBlocks);

    return resultPromise;
  }

  /**
   * 中途插话：这个会话有一轮正在跑时，把一条用户消息送进去（做完手头这一步就读到，不打断）。
   * 返回 { ok }；没有在跑的轮（或正在被停下）时 ok 为 false，调用方改走别的路（排队 / 新开一轮）。
   */
  steerPrompt(sessionId, promptBlocks = [], fallback = null) {
    const id = String(sessionId || '');
    const turn = id ? this.turns.get(id) : null;
    if (!turn || turn.done || turn.aborted || typeof turn.sendPrompt !== 'function') return { ok: false, reason: 'not_running' };
    const blocks = Array.isArray(promptBlocks) ? promptBlocks : [];
    if (!blocks.length) return { ok: false, reason: 'empty' };
    const hist = this.historyUpdates.get(id);
    if (hist) {
      for (const block of blocks) {
        if (block?.type !== 'text' && block?.type !== 'image') continue;
        hist.push({ params: { sessionId: id, update: { sessionUpdate: 'user_message_chunk', content: block } } });
      }
    }
    turn.segText = '';
    if (turn.finalText && !/\n\s*$/.test(turn.finalText)) turn.finalText += '\n\n';
    // 正等着后台回报：这条消息本身就会把回报带给模型，不用再等
    try { turn.idleAbort?.abort(); } catch {}
    turn.sendPrompt(blocks, fallback);
    return { ok: true };
  }

  _isBusyForIdleRestart() {
    return this.preparingTurns > 0
      || this.turns.size > 0
      || this.inflightLoads.size > 0
      || this.pendingPermissions.size > 0
      || this.pendingQuestions.size > 0
      || Boolean(this.bgHandlers?.hasAnyProtectedBackground?.());
  }

  _scheduleIdleRestartCheck() {
    if (!this.pendingIdleRestart) return;
    queueMicrotask(() => {
      if (this.pendingIdleRestart && !this._isBusyForIdleRestart()) {
        this._drainIdleRestart().catch(() => {});
      }
    });
  }

  // 请求在无任何在跑/准备中轮次时静默重启常驻进程：空闲时当帧原子上锁重启，忙碌时挂起标记待最后一轮收尾后自动执行
  requestIdleRestart({ remountIdle = false } = {}) {
    if (!this.proc && !this.starting && !this._idleRestartPromise) {
      this.pendingIdleRestart = false;
      this.pendingIdleRemount = false;
      return Promise.resolve({ restarted: false, deferred: false });
    }
    this.pendingIdleRestart = true;
    this.pendingIdleRemount = Boolean(this.pendingIdleRemount || remountIdle);
    return this._drainIdleRestart();
  }

  _drainIdleRestart() {
    if (!this.pendingIdleRestart) {
      return Promise.resolve({ restarted: false, deferred: false });
    }
    if (this._idleRestartPromise) {
      return this._idleRestartPromise;
    }
    if (!this.proc && !this.starting) {
      this.pendingIdleRestart = false;
      this.pendingIdleRemount = false;
      return Promise.resolve({ restarted: false, deferred: false });
    }
    if (this.starting || this.recovering || this._isBusyForIdleRestart()) {
      return Promise.resolve({ restarted: false, deferred: true });
    }

    const remountIdle = this.pendingIdleRemount;
    this.pendingIdleRestart = false;
    this.pendingIdleRemount = false;

    const p = (async () => {
      const previouslyMounted = remountIdle
        ? [...this.mountedSessions.keys()].filter((sid) => !this.turns.has(sid))
        : [];
      this.shutdown({ keepPendingIdleRestart: true });
      this.shuttingDown = false;
      this.crashCount = 0;
      this.stoppedAfterCrashes = false;
      this.lastExitReason = '';
      await this.ensureStarted();
      return { previouslyMounted };
    })().then(async ({ previouslyMounted }) => {
      this._idleRestartPromise = null;
      for (const sid of previouslyMounted) {
        if (!this.knownSessions.has(sid)) continue;
        try { await this.ensureSessionMounted(sid); } catch {}
      }
      if (this.pendingIdleRestart && !this._isBusyForIdleRestart()) {
        return this._drainIdleRestart();
      }
      return { restarted: true, deferred: false, status: this.status() };
    }).catch((err) => {
      this._idleRestartPromise = null;
      throw err;
    });

    this._idleRestartPromise = p;
    return p;
  }

  async restart({ remountIdle = true } = {}) {
    const previouslyMounted = remountIdle
      ? [...this.mountedSessions.keys()].filter((sid) => !this.turns.has(sid))
      : [];
    const prevStarting = this.starting;
    const prevRecovering = this.recovering;
    this.shutdown();
    if (prevStarting) {
      try { await prevStarting; } catch {}
    }
    if (prevRecovering) {
      try { await prevRecovering; } catch {}
    }
    this.shuttingDown = false;
    this.crashCount = 0;
    this.stoppedAfterCrashes = false;
    this.lastExitReason = '';
    await this.ensureStarted();
    for (const sid of previouslyMounted) {
      if (!this.knownSessions.has(sid)) continue;
      try { await this.ensureSessionMounted(sid); } catch {}
    }
    return this.status();
  }

  shutdown({ keepPendingIdleRestart = false } = {}) {
    if (!keepPendingIdleRestart) {
      this.pendingIdleRestart = false;
      this.pendingIdleRemount = false;
      unlockDaemonDir(this.daemonCwd);
    }
    this.shuttingDown = true;
    this.bootSeq++;
    this.starting = null;
    clearTimeout(this.stableTimer);
    this.stableTimer = null;
    clearTimeout(this.recoverTimer);
    this.recoverTimer = null;
    const proc = this.proc;
    if (!proc) return;
    this._handleProcessExit(proc, 'Antigravity ACP 已停止');
  }
}
