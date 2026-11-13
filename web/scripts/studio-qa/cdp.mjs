// Media Studio 真机条件检测：零依赖的无头 Edge + CDP 驱动（Node 24 自带 WebSocket）。
// 每一档视口起一个全新的 Edge 进程（同一个标签页接连换档时 captureScreenshot 会卡死，见记忆 project_bridge_media_studio）。
// 收尾：先发 Browser.close，再按自己记下的 user-data-dir 找到 Edge 根进程按 PID 收（启动器 PID 不是浏览器本体）。
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

const EDGE_CANDIDATES = [
  process.env.STUDIO_QA_EDGE,
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].filter(Boolean);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 找一个空闲端口（别用 9222 / 9333：那是手机 WebView 的 adb 转发口常客） */
async function freePort() {
  return new Promise((res, rej) => {
    const s = createServer();
    s.unref();
    s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/** extraArgs：额外的命令行开关（lanshell.mjs 用来模拟 WebView 的混合内容放行、把假域名解析到本机） */
export async function launchEdge({ extraArgs = [] } = {}) {
  const exe = EDGE_CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error('找不到 msedge.exe（可设 STUDIO_QA_EDGE）');
  const port = await freePort();
  const dir = mkdtempSync(path.join(os.tmpdir(), 'edge-cdp-studioqa-'));
  const child = spawn(exe, [
    '--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${dir}`,
    '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
    '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-background-timer-throttling',
    '--disable-features=Translate,msEdgeTranslate', '--mute-audio', ...extraArgs, 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  child.unref();
  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    await sleep(150);
    try { ver = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json(); } catch {}
  }
  if (!ver) { killByDir(dir); throw new Error('Edge 没起来'); }
  const conn = await connect(ver.webSocketDebuggerUrl);
  const edge = { port, dir, conn, async close() {
    try { await Promise.race([conn.send('Browser.close'), sleep(1500)]); } catch {}
    conn.close();
    await sleep(400);
    killByDir(dir);
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch {}
  } };
  return edge;
}

/** 按 user-data-dir 找到这一次起的 Edge 进程树的根，按 PID 收（不按命令行通配杀别的东西） */
function killByDir(dir) {
  if (process.platform !== 'win32') return;
  try {
    const ps = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${dir.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true });
    for (const pid of out.split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid)); } catch {} }
  } catch {}
}

/** 最小 CDP 客户端：send(method, params, sessionId) / on(event, fn) */
export function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let seq = 0;
    const pending = new Map();
    const handlers = new Map();
    ws.onerror = (e) => reject(e);
    ws.onclose = () => { for (const [, p] of pending) p.reject(new Error('CDP 连接断开')); pending.clear(); };
    ws.onmessage = (m) => {
      const msg = JSON.parse(typeof m.data === 'string' ? m.data : Buffer.from(m.data).toString());
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        msg.error ? p.reject(new Error(msg.error.message + (msg.error.data ? ' ' + msg.error.data : ''))) : p.resolve(msg.result);
      } else if (msg.method) {
        for (const fn of handlers.get(msg.method) || []) try { fn(msg.params, msg.sessionId); } catch {}
      }
    };
    ws.onopen = () => resolve({
      send(method, params = {}, sessionId, timeout = 30000) {
        const id = ++seq;
        ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
        return new Promise((res, rej) => {
          const tm = setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error(method + ' 超时')); } }, timeout);
          tm.unref?.();
          pending.set(id, { resolve: (v) => { clearTimeout(tm); res(v); }, reject: (e) => { clearTimeout(tm); rej(e); } });
        });
      },
      on(event, fn) { if (!handlers.has(event)) handlers.set(event, []); handlers.get(event).push(fn); },
      close() { try { ws.close(); } catch {} },
    });
  });
}

/** 开一个页面会话：返回 { send, eval, sessionId } */
export async function openPage(edge) {
  const { conn } = edge;
  const { targetId } = await conn.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await conn.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (m, p, t) => conn.send(m, p, sessionId, t);
  // 关掉启动时自带的 about:blank（它会抢前台）
  try {
    const { targetInfos } = await conn.send('Target.getTargets');
    for (const ti of targetInfos) if (ti.type === 'page' && ti.targetId !== targetId) await conn.send('Target.closeTarget', { targetId: ti.targetId });
  } catch {}
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.bringToFront');
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const logs = [];
  conn.on('Runtime.exceptionThrown', (p, sid) => { if (sid === sessionId) logs.push({ level: 'exception', text: p.exceptionDetails?.exception?.description || p.exceptionDetails?.text || '' }); });
  conn.on('Runtime.consoleAPICalled', (p, sid) => {
    if (sid !== sessionId || (p.type !== 'error' && p.type !== 'warning')) return;
    logs.push({ level: p.type, text: (p.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 400) });
  });
  async function evaluate(expr, { timeout = 30000 } = {}) {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }, timeout);
    if (r.exceptionDetails) throw new Error('页面里出错：' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    return r.result?.value;
  }
  return { sessionId, targetId, send, eval: evaluate, logs, conn };
}
