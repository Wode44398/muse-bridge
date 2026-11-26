// Antigravity 本机 CLI 托管多号槽位：
// 公开版不内置 Google OAuth 客户端密钥时，由本机已安装的官方 agy CLI 在独立隔离目录中自行完成
// Google OAuth 登录（`agy acp --login`）与令牌续期（短命 `agy acp --cloud_code_endpoint` 截获 Bearer Token）。
// 注入 SSH_CONNECTION 触发 agy 内置的 file-based token storage，彻底避开系统钥匙串，不干扰本机默认登录态。

import http from 'node:http';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DATA_ROOT } from '@bridge/core/runtime/paths.mjs';
import { plainDispatcher } from '@bridge/core/runtime/net-proxy.mjs';
import { spawnAgyProcess, killProcessTree, agyInstalled } from '../acp/binary.mjs';

const TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
const FLOW_TTL_MS = 5 * 60_000;
const LOGIN_URL_TIMEOUT_MS = 15_000;
const LOGIN_SUBMIT_TIMEOUT_MS = 30_000;
const CAPTURE_TIMEOUT_MS = 25_000;
const DEFAULT_TOKEN_TTL_SEC = 3000;
const SAFE_SLOT_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const AUTH_URL_RE = /https:\/\/accounts\.google\.com\/[^\s"'<>]+/i;

// 隔离槽位子进程可能从宿主继承的干扰变量，防止误读默认账号目录或走 API Key 模式。
const STRIP_ENV_KEYS = new Set([
  'AGY_HOME_DIR',
  'AGY_APP_DATA_DIR',
  'AGY_NO_UPSTREAM',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'CLAUDECODE',
]);

let slotsRoot = path.join(DATA_ROOT, 'agy', 'pool-slots');
const activeFlows = new Map();       // flowId -> flow
const activeRefreshProcs = new Set(); // 短命刷新子进程，退出时统一收尸
let spawnOverride = null;
let fetchOverride = null;

function doFetch(url, init = {}) {
  if (fetchOverride) return fetchOverride(url, init);
  const plain = plainDispatcher();
  return fetch(url, { ...init, ...(plain ? { dispatcher: plain } : {}) });
}

function spawnSlotAgy(args, opts) {
  if (spawnOverride) return spawnOverride(args, opts);
  return spawnAgyProcess(args, opts);
}

function withLoopbackNoProxy(env) {
  const out = { ...env };
  const keys = Object.keys(out).filter((k) => k.toLowerCase() === 'no_proxy');
  const existing = keys.map((k) => String(out[k] || '')).join(',');
  const parts = existing.split(',').map((s) => s.trim()).filter(Boolean);
  for (const host of ['127.0.0.1', 'localhost']) {
    if (!parts.some((p) => p.toLowerCase() === host)) parts.push(host);
  }
  const merged = parts.join(',');
  if (keys.length) {
    for (const k of keys) out[k] = merged;
  } else {
    out.NO_PROXY = merged;
    if (process.platform !== 'win32') out.no_proxy = merged;
  }
  return out;
}

export function slotDirFor(accountId) {
  const id = String(accountId || '').trim();
  if (!SAFE_SLOT_ID_RE.test(id)) return '';
  const dir = path.join(slotsRoot, id);
  return path.dirname(dir) === slotsRoot ? dir : '';
}

export function hasSlotDir(accountId) {
  const dir = slotDirFor(accountId);
  return Boolean(dir && existsSync(dir));
}

export function deleteSlotDir(accountId) {
  const dir = slotDirFor(accountId);
  if (!dir || !existsSync(dir)) return false;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
    return true;
  } catch {
    return false;
  }
}

export function promoteSlotDir(tmpDir, accountId) {
  const dest = slotDirFor(accountId);
  if (!dest) throw new Error('非法的槽位账号 ID');
  mkdirSync(slotsRoot, { recursive: true });
  if (existsSync(dest)) {
    rmSync(dest, { recursive: true, force: true, maxRetries: 5, retryDelay: 120 });
  }
  // Windows 下子进程刚退出时句柄释放偶有数十毫秒延迟，短重试后再回退拷贝。
  let moved = false;
  for (let i = 0; i < 4; i++) {
    try {
      renameSync(tmpDir, dest);
      moved = true;
      break;
    } catch {}
  }
  if (!moved) {
    cpSync(tmpDir, dest, { recursive: true, force: true });
    try { rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  }
  return dest;
}

export function buildSlotEnv(slotDir, { loopbackNoProxy = false } = {}) {
  const root = path.resolve(slotDir);
  const roaming = path.join(root, 'AppData', 'Roaming');
  const localApp = path.join(root, 'AppData', 'Local');
  const xdgConfig = path.join(root, '.config');
  const xdgData = path.join(root, '.local', 'share');
  const xdgCache = path.join(root, '.cache');
  for (const d of [root, roaming, localApp, xdgConfig, xdgData, xdgCache]) {
    try { mkdirSync(d, { recursive: true }); } catch {}
  }

  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (STRIP_ENV_KEYS.has(k.toUpperCase()) || v == null) continue;
    env[k] = v;
  }
  env.USERPROFILE = root;
  env.HOME = root;
  env.APPDATA = roaming;
  env.LOCALAPPDATA = localApp;
  env.XDG_CONFIG_HOME = xdgConfig;
  env.XDG_DATA_HOME = xdgData;
  env.XDG_CACHE_HOME = xdgCache;
  // 触发 agy 内置 SSH 检测走文件凭据存储，绝不读写系统钥匙串。
  env.SSH_CONNECTION = '127.0.0.1 1 127.0.0.1 22';
  return loopbackNoProxy ? withLoopbackNoProxy(env) : env;
}

function cleanupFlowResources(flow, { removeTmpDir = true } = {}) {
  if (!flow) return;
  clearTimeout(flow.timer);
  flow.timer = null;
  if (flow.proc) {
    killProcessTree(flow.proc);
    flow.proc = null;
  }
  if (removeTmpDir && flow.tmpDir && existsSync(flow.tmpDir)) {
    try { rmSync(flow.tmpDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 }); } catch {}
  }
}

export async function startSlotLoginFlow({ label = '', accountId = '', plan = '' } = {}) {
  if (!spawnOverride && !agyInstalled()) {
    throw new Error('未检测到本机 Antigravity CLI（agy），请先安装 agy 后再添加账号。');
  }

  for (const [fid, f] of activeFlows.entries()) {
    if (f.status !== 'pending' || Date.now() > f.expiresAt) {
      cleanupFlowResources(f);
      activeFlows.delete(fid);
    }
  }
  while (activeFlows.size >= 4) {
    const oldest = activeFlows.keys().next().value;
    cleanupFlowResources(activeFlows.get(oldest));
    activeFlows.delete(oldest);
  }

  const flowId = 'as-' + randomBytes(6).toString('hex');
  const tmpDir = path.join(slotsRoot, `_tmp-${flowId}`);
  mkdirSync(tmpDir, { recursive: true });

  let proc;
  try {
    proc = spawnSlotAgy(['acp', '--login', '--log-file', path.join(tmpDir, 'login.log')], {
      cwd: os.tmpdir(),
      env: buildSlotEnv(tmpDir),
    });
  } catch (err) {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    throw new Error('无法启动本机 agy 登录流程：' + (err?.message || String(err)));
  }

  const flow = {
    flowId,
    mode: 'cli',
    tmpDir,
    proc,
    url: '',
    label: String(label || '').trim(),
    accountId: String(accountId || '').trim(),
    plan: String(plan || '').trim(),
    status: 'pending',
    account: null,
    error: '',
    expiresAt: Date.now() + FLOW_TTL_MS,
    timer: null,
    submitting: false,
    completing: null,
    outputTail: '',
  };

  let urlResolved = false;
  const authUrl = await new Promise((resolve, reject) => {
    const urlTimer = setTimeout(() => {
      if (urlResolved) return;
      urlResolved = true;
      cleanupFlowResources(flow);
      reject(new Error('等待本机 agy 输出 Google 授权链接超时'));
    }, LOGIN_URL_TIMEOUT_MS);
    urlTimer.unref?.();

    const onChunk = (chunk) => {
      const s = String(chunk || '');
      flow.outputTail = (flow.outputTail + s).slice(-4000);
      if (urlResolved) return;
      const m = AUTH_URL_RE.exec(flow.outputTail);
      if (m && m[0]) {
        urlResolved = true;
        clearTimeout(urlTimer);
        resolve(m[0].trim());
      }
    };

    proc.stdout?.on('data', onChunk);
    proc.stderr?.on('data', onChunk);
    proc.once('error', (err) => {
      if (urlResolved) return;
      urlResolved = true;
      clearTimeout(urlTimer);
      cleanupFlowResources(flow);
      reject(new Error('启动本机 agy 登录进程失败：' + (err?.message || String(err))));
    });
    proc.once('close', (code) => {
      if (urlResolved) return;
      urlResolved = true;
      clearTimeout(urlTimer);
      const detail = flow.outputTail.trim().slice(-240);
      cleanupFlowResources(flow);
      reject(new Error(`本机 agy 登录进程异常退出（退出码 ${code ?? '?'}）${detail ? '：' + detail : ''}`));
    });
  });

  flow.url = authUrl;
  flow.timer = setTimeout(() => {
    if (flow.status === 'pending') {
      flow.status = 'expired';
      flow.error = '授权已超时，请重新开始';
    }
    cleanupFlowResources(flow);
  }, FLOW_TTL_MS);
  flow.timer.unref?.();

  proc.once('close', (code) => {
    if (flow.proc === proc) flow.proc = null;
    if (flow.status === 'pending' && !flow.submitting && !flow.completing) {
      flow.status = 'error';
      flow.error = `本机 agy 登录进程提前结束（退出码 ${code ?? '?'}），请重新发起授权`;
      cleanupFlowResources(flow);
    }
  });

  activeFlows.set(flowId, flow);
  return {
    ok: true,
    flowId,
    mode: 'cli',
    url: authUrl,
    expiresAt: flow.expiresAt,
  };
}

export function getSlotLoginFlow(flowId) {
  const flow = activeFlows.get(String(flowId || ''));
  if (!flow) return null;
  if (flow.status === 'pending' && Date.now() > flow.expiresAt) {
    flow.status = 'expired';
    flow.error = '授权已超时，请重新开始';
    cleanupFlowResources(flow);
  }
  return flow;
}

export function getSlotLoginStatus(flowId) {
  const flow = getSlotLoginFlow(flowId);
  if (!flow) return { ok: false, status: 'expired', error: '授权会话不存在或已过期' };
  return {
    ok: flow.status === 'done',
    mode: 'cli',
    status: flow.status,
    ...(flow.account ? { account: flow.account } : {}),
    ...(flow.error ? { error: flow.error } : {}),
  };
}

export async function submitSlotLoginCode(flowId, rawInput) {
  const flow = getSlotLoginFlow(flowId);
  if (!flow) return { error: '授权会话不存在或已过期，请重新生成授权链接' };
  if (flow.status === 'done') return { ok: true, alreadyDone: true, account: flow.account };
  if (flow.status !== 'pending' || !flow.proc?.stdin?.writable) {
    return { error: flow.error || '授权会话已失效，请重新发起授权' };
  }

  const clean = String(rawInput || '').trim().split(/\r?\n/)[0]?.trim() || '';
  if (!clean) return { error: '请粘贴回调链接或授权码' };

  const proc = flow.proc;
  flow.submitting = true;
  flow.outputTail = '';

  const exitRes = await new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(submitTimer);
      resolve(r);
    };
    const submitTimer = setTimeout(() => {
      killProcessTree(proc);
      done({ ok: false, error: '等待本机 agy 验证授权码超时，请重试' });
    }, LOGIN_SUBMIT_TIMEOUT_MS);
    submitTimer.unref?.();

    proc.once('close', (code) => {
      if (code === 0) {
        done({ ok: true });
      } else {
        const tail = flow.outputTail.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ');
        done({ ok: false, error: tail ? `授权验证失败：${tail.slice(0, 220)}` : `授权验证失败（退出码 ${code ?? '?'}），请重新获取授权码` });
      }
    });
    proc.once('error', (err) => {
      done({ ok: false, error: '本机 agy 验证授权码出错：' + (err?.message || String(err)) });
    });

    try {
      proc.stdin.write(clean + '\n', 'utf8');
      proc.stdin.end();
    } catch (err) {
      done({ ok: false, error: '写入授权码失败：' + (err?.message || String(err)) });
    }
  });

  flow.proc = null;
  if (!exitRes.ok) {
    flow.status = 'error';
    flow.error = exitRes.error;
    cleanupFlowResources(flow);
    return { error: exitRes.error };
  }

  return { ok: true, flow };
}

export function markSlotFlowResult(flowId, { ok, account = null, error = '', keepTmpDir = false } = {}) {
  const flow = activeFlows.get(String(flowId || ''));
  if (!flow) return;
  flow.status = ok ? 'done' : 'error';
  flow.account = account || null;
  flow.error = ok ? '' : String(error || '授权失败');
  cleanupFlowResources(flow, { removeTmpDir: !keepTmpDir });
}

export function cancelSlotLoginFlow(flowId) {
  const id = String(flowId || '');
  const flow = activeFlows.get(id);
  if (!flow) return { ok: true };
  cleanupFlowResources(flow);
  activeFlows.delete(id);
  return { ok: true };
}

async function probeTokenExpirySec(accessToken) {
  try {
    const res = await doFetch(`${TOKENINFO_URL}?access_token=${encodeURIComponent(accessToken)}`, {
      method: 'GET',
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    if (!data || typeof data !== 'object') return null;
    const expIn = Number(data.expires_in);
    if (Number.isFinite(expIn) && expIn > 0) return Math.floor(expIn);
    const exp = Number(data.exp);
    if (Number.isFinite(exp) && exp > 0) return Math.max(0, Math.floor(exp - Date.now() / 1000));
  } catch {}
  return null;
}

async function captureOnce(slotDir, { timeoutMs = CAPTURE_TIMEOUT_MS } = {}) {
  const nonce = randomBytes(10).toString('hex');
  const prefix = '/' + nonce + '/';
  const daemonDir = path.join(slotDir, 'daemon-cwd');
  mkdirSync(daemonDir, { recursive: true });

  let proc = null;
  let rl = null;
  let srv = null;
  let timer = null;

  try {
    let resolveCapture;
    let rejectCapture;
    const captured = new Promise((resolve, reject) => {
      resolveCapture = resolve;
      rejectCapture = reject;
    });
    let done = false;
    const finishOk = (val) => { if (!done) { done = true; resolveCapture(val); } };
    const finishErr = (err) => { if (!done) { done = true; rejectCapture(err); } };

    srv = http.createServer((req, res) => {
      if (!String(req.url || '').startsWith(prefix)) {
        res.writeHead(404);
        res.end();
        return;
      }
      const auth = String(req.headers.authorization || '').trim();
      const ua = String(req.headers['user-agent'] || '').trim();
      const m = /^Bearer\s+(.+)$/i.exec(auth);
      res.writeHead(200, { 'content-type': 'application/json', connection: 'close' });
      res.end('{}');
      if (m && m[1]) {
        finishOk({ accessToken: m[1].trim(), userAgent: ua });
      }
    });
    await new Promise((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(0, '127.0.0.1', resolve);
    });
    srv.unref?.();

    const endpoint = `http://127.0.0.1:${srv.address().port}/${nonce}`;
    const args = ['acp', '--disable-telemetry', '--cloud_code_endpoint', endpoint, '--log-file', path.join(slotDir, 'refresh.log')];
    proc = spawnSlotAgy(args, {
      cwd: daemonDir,
      env: buildSlotEnv(slotDir, { loopbackNoProxy: true }),
    });
    activeRefreshProcs.add(proc);

    let stderrTail = '';
    proc.stderr?.on('data', (d) => { stderrTail = (stderrTail + String(d)).slice(-1000); });
    proc.once('error', (err) => finishErr(new Error('无法启动本机 agy 刷新令牌：' + (err?.message || String(err)))));
    proc.once('close', (code) => {
      if (!done) {
        const msg = stderrTail.trim().slice(-200);
        finishErr(new Error(`本机 agy 刷新令牌进程提前退出（退出码 ${code ?? '?'}）${msg ? '：' + msg : ''}`));
      }
    });

    const sendRpc = (obj) => {
      if (proc?.stdin?.writable) {
        proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...obj }) + '\n', 'utf8');
      }
    };

    rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(String(line || '').trim()); } catch { return; }
      if (msg.id === 1 && msg.result) {
        sendRpc({ id: 2, method: 'session/list', params: { cwd: daemonDir } });
      } else if (msg.id === 2 && msg.error) {
        const em = String(msg.error.message || '');
        if (msg.error.code === -32000 || /auth|login|unauth/i.test(em)) {
          const err = new Error('授权已失效或被撤销，请重新登录该账号');
          err.code = 'invalid_grant';
          finishErr(err);
        } else {
          finishErr(new Error(em || '读取槽位凭据失败'));
        }
      }
    });

    timer = setTimeout(() => {
      finishErr(new Error('刷新槽位令牌超时，请检查本机网络或重新授权该账号'));
    }, timeoutMs);
    timer.unref?.();

    sendRpc({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: 1, clientInfo: { name: 'claude-bridge-pool', version: '1.0.0' } },
    });

    return await captured;
  } finally {
    clearTimeout(timer);
    try { rl?.close(); } catch {}
    if (proc) {
      activeRefreshProcs.delete(proc);
      killProcessTree(proc);
    }
    if (srv) {
      try { srv.closeAllConnections?.(); } catch {}
      try { srv.close(); } catch {}
    }
  }
}

export async function captureSlotAccessToken(slotDir, { timeoutMs = CAPTURE_TIMEOUT_MS, retryOnNearExpiry = true } = {}) {
  if (!slotDir || !existsSync(slotDir)) {
    const err = new Error('槽位凭据目录不存在，请重新登录该账号');
    err.code = 'invalid_grant';
    throw err;
  }
  if (!spawnOverride && !agyInstalled()) {
    throw new Error('未检测到本机 Antigravity CLI（agy）');
  }

  const first = await captureOnce(slotDir, { timeoutMs });
  const probedSec = await probeTokenExpirySec(first.accessToken);

  // Go oauth2 库的默认 expiryDelta 只有 10 秒：若抓到的旧缓存令牌距过期只剩几秒，稍等其跨过过期点后再抓一次即可拿到全新 1h 令牌。
  if (retryOnNearExpiry && probedSec != null && probedSec <= 15) {
    const waitMs = Math.min(16_000, Math.max(1_000, (probedSec + 2) * 1000));
    await new Promise((r) => setTimeout(r, waitMs));
    const second = await captureOnce(slotDir, { timeoutMs });
    const secondSec = await probeTokenExpirySec(second.accessToken);
    return {
      accessToken: second.accessToken,
      userAgent: second.userAgent || first.userAgent,
      expiresIn: secondSec != null && secondSec > 0 ? secondSec : DEFAULT_TOKEN_TTL_SEC,
      exactExpiry: secondSec != null && secondSec > 0,
    };
  }

  return {
    accessToken: first.accessToken,
    userAgent: first.userAgent,
    expiresIn: probedSec != null && probedSec > 0 ? probedSec : DEFAULT_TOKEN_TTL_SEC,
    exactExpiry: probedSec != null && probedSec > 0,
  };
}

export function shutdownSlotFlows() {
  for (const flow of activeFlows.values()) cleanupFlowResources(flow);
  activeFlows.clear();
  for (const proc of [...activeRefreshProcs]) {
    activeRefreshProcs.delete(proc);
    killProcessTree(proc);
  }
}

export function _setSlotsRootForTest(dir) {
  slotsRoot = dir || path.join(DATA_ROOT, 'agy', 'pool-slots');
}

export function _setSlotSpawnForTest(fn) {
  spawnOverride = fn || null;
}

export function _setSlotFetchForTest(fn) {
  fetchOverride = fn || null;
}

export function _resetSlotsForTest() {
  shutdownSlotFlows();
  slotsRoot = path.join(DATA_ROOT, 'agy', 'pool-slots');
  spawnOverride = null;
  fetchOverride = null;
}

process.once('exit', () => {
  try { shutdownSlotFlows(); } catch {}
});
