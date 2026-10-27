// 无头浏览器的「按人共享宿主」（2026-10-26）：同一个人（主机身份 / 成员账号）的所有工作空间共用一个
// 无头 Edge 进程和一个持久配置档，登录态跨会话、跨工作空间、跨 bridge 重启都在——对齐 Claude 桌面端
// 内置浏览器「一个持久 profile、所有会话共用」的做法。以前每次启动都是 mkdtemp 的临时 profile，闲置
// 15 分钟回收后登录全没了（没有桌面壳的部署：手机远程、Docker、成员账号，全是这条路）。
//
// 为什么共享进程而不是每个工作空间各起一个：Chromium 一个 user-data-dir 同时只能被一个进程打开，第二个
// 进程会把参数转交给第一个然后退出。所以每个配置档一个宿主进程，各工作空间的 CdpSession 以 external 方式
// 附着、只拥有自己 Target.createTarget 出来的标签（与桌面壳 attachDesktop 同一套 ownedTargets 语义）。
//
// 生命周期：引用计数，最后一个会话释放就优雅退出（Browser.close，让 Cookie 落盘——直接杀进程会丢最近
// 几十秒写的登录态）。bridge 崩溃留下的孤儿宿主占着配置档：下次启动前读配置档里的 DevToolsActivePort，
// 还在应答就先让它 Browser.close，再起新的。

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const hosts = new Map();   // 配置档绝对路径 → 宿主

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const portFile = (dir) => path.join(dir, 'DevToolsActivePort');

function readPort(dir) {
  try {
    const p = Number(readFileSync(portFile(dir), 'utf8').split('\n')[0]?.trim());
    return p > 0 ? p : 0;
  } catch { return 0; }
}

async function version(port, ms = 1500) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// 经浏览器级端点发 Browser.close：Chromium 自己把 Cookie / 本地存储落盘后整树退出。
function browserClose(wsUrl, ms = 3000) {
  return new Promise((resolve) => {
    let ws;
    const done = () => { try { ws?.close(); } catch {} resolve(); };
    const t = setTimeout(done, ms);
    try {
      ws = new WebSocket(wsUrl);
      ws.addEventListener('open', () => { try { ws.send(JSON.stringify({ id: 1, method: 'Browser.close' })); } catch {} });
      ws.addEventListener('close', () => { clearTimeout(t); resolve(); });
      ws.addEventListener('error', () => { clearTimeout(t); done(); });
    } catch { clearTimeout(t); resolve(); }
  });
}

// 上一代 bridge 留下、还占着这个配置档的宿主：请它体面退出，等端口不再应答。
async function evictOrphan(dir) {
  const port = readPort(dir);
  if (!port) return;
  const v = await version(port);
  if (v?.webSocketDebuggerUrl) {
    await browserClose(v.webSocketDebuggerUrl);
    for (let i = 0; i < 40 && (await version(port, 500)); i++) await delay(150);
  }
  try { rmSync(portFile(dir), { force: true }); } catch { /* 下面等新文件时会覆盖 */ }
}

async function launchHost(dir, { browserPath, args }) {
  mkdirSync(dir, { recursive: true });
  await evictOrphan(dir);
  const host = { dir, child: null, port: 0, cdpBase: '', refs: 0, dead: false, spawnError: null, closing: null };
  host.child = spawn(browserPath, [...args, `--user-data-dir=${dir}`, 'about:blank'], { stdio: 'ignore', windowsHide: true });
  host.child.on('error', (e) => { host.dead = true; host.spawnError = e; });
  host.child.on('exit', () => { host.dead = true; });
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (host.spawnError) throw new Error('浏览器启动失败：' + (host.spawnError.message || host.spawnError));
    // 配置档被一个不应答的进程占着时，新进程把参数转交过去就退出了
    if (host.child.exitCode != null) throw new Error('浏览器进程在暴露调试端口前退出了（配置档可能被另一个浏览器占用）');
    const p = readPort(dir);
    if (p && (await version(p, 800))) { host.port = p; break; }
    await delay(100);
  }
  if (!host.port) { try { host.child.kill('SIGKILL'); } catch {} throw new Error('等待浏览器调试端口超时'); }
  host.cdpBase = `http://127.0.0.1:${host.port}`;
  return host;
}

async function closeHost(host) {
  if (host.closing) return host.closing;
  host.closing = (async () => {
    if (hosts.get(host.dir) === host) hosts.delete(host.dir);
    if (!host.dead) {
      const v = await version(host.port, 800);
      if (v?.webSocketDebuggerUrl) await browserClose(v.webSocketDebuggerUrl);
      for (let i = 0; i < 30 && !host.dead; i++) await delay(100);
      if (!host.dead) { try { host.child.kill('SIGKILL'); } catch {} }
    }
  })();
  return host.closing;
}

/**
 * 取（必要时启动）某个配置档的共享宿主，引用计数 +1。
 * opts = { browserPath, args }：args 是不含 --user-data-dir 与起始页的无头参数（cdp.mjs headlessArgs）。
 * 返回 { cdpBase, port, dir, alive, release() }；release() 返回宿主真正退出（若因此退出）的 Promise。
 */
export async function acquireHeadlessHost(dir, opts) {
  const key = path.resolve(dir);
  let entry = hosts.get(key);
  if (entry?.closing) { await entry.closing; entry = null; }
  if (!entry || (entry.host && entry.host.dead)) {
    entry = { host: null, launching: launchHost(key, opts) };
    hosts.set(key, entry);
    try {
      entry.host = await entry.launching;
    } catch (e) {
      if (hosts.get(key) === entry) hosts.delete(key);
      throw e;
    } finally { entry.launching = null; }
    entry.host.child.on('exit', () => { if (hosts.get(key) === entry) hosts.delete(key); });
  } else if (entry.launching) {
    await entry.launching;
  }
  const host = entry.host;
  host.refs++;
  let released = false;
  return {
    cdpBase: host.cdpBase,
    port: host.port,
    dir: key,
    get alive() { return !host.dead && !host.closing; },
    release() {
      if (released) return Promise.resolve();
      released = true;
      host.refs = Math.max(0, host.refs - 1);
      if (host.refs > 0) return Promise.resolve();
      if (hosts.get(key) === entry) hosts.delete(key);
      return closeHost(host);
    },
  };
}

/** 某个目录下（例如要删的成员目录）所有宿主都退出后才 resolve；cap 毫秒封顶。 */
export async function hostsUnderClosed(root, cap = 8000) {
  const base = path.resolve(root).toLowerCase();
  const under = [...hosts.entries()].filter(([dir]) => dir.toLowerCase().startsWith(base));
  const waits = under.map(([, e]) => (e.host ? closeHost(e.host) : e.launching?.then((h) => closeHost(h), () => {})));
  await Promise.race([Promise.allSettled(waits), delay(cap)]);
}

/** 进程退出时：同步能做的只有杀进程（exit 事件里不能等），优雅关闭留给下次启动的孤儿驱逐。 */
export function killAllHostsSync() {
  for (const e of hosts.values()) { try { e.host?.child?.kill('SIGKILL'); } catch {} }
  hosts.clear();
}

export const _hosts = hosts;   // 单测用
