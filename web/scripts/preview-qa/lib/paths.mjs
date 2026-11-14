// preview-qa 的公共路径与小工具（启动器、运行器、本地桩共用）。
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');   // web/scripts/preview-qa
export const WEB = path.resolve(HERE, '../..');
export const REPO = path.resolve(WEB, '..');
// 所有临时产物的根：%TEMP%\bridge-preview-qa（可用 PREVIEW_QA_ROOT 改）
export const QA_ROOT = path.resolve(process.env.PREVIEW_QA_ROOT || path.join(os.tmpdir(), 'bridge-preview-qa'));
// 共用的只读样张 vault（VAULT_PATH 指这里；样张在 <vault>/预览样张/）
export const VAULT = path.join(QA_ROOT, 'vault');
export const SAMPLES_DIR = path.join(VAULT, '预览样张');
export const SAMPLES_REL = '预览样张';
export const instDir = (name) => path.join(QA_ROOT, 'inst-' + name);
export const pidFile = (name) => path.join(instDir(name), 'pid.json');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简命令行解析：--k v / --flag；第一个非 -- 开头的词是子命令 */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const nx = argv[i + 1];
      if (nx != null && !nx.startsWith('--')) { out[k] = nx; i++; } else out[k] = true;
    } else out._.push(a);
  }
  return out;
}

export function readJson(p, dflt = null) {
  try { const raw = readFileSync(p, 'utf8'); return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); } catch { return dflt; }
}

/** 端口是否空闲：127.0.0.1 与 0.0.0.0 都能绑上才算（Windows 上别人听 0.0.0.0 时绑 127.0.0.1 也可能成功） */
function canBind(port, host) {
  return new Promise((res) => {
    const s = createServer();
    s.unref();
    s.once('error', () => res(false));
    s.listen(port, host, () => s.close(() => res(true)));
  });
}
export async function portFree(port) { return (await canBind(port, '127.0.0.1')) && (await canBind(port, '0.0.0.0')); }

// 本机已知的常驻口与 worktree 自动分配段：一律跳过（生产 8787、桌面壳 8788、trader 8790/8791、harness 8799、测试服与 worktree 8810-8839、客户端 47821、adb 转发 9222/9333）
const RESERVED = new Set([8787, 8788, 8790, 8791, 8799, 47821, 9222, 9333]);
const reserved = (p) => RESERVED.has(p) || (p >= 8810 && p <= 8839);
/** 从 start 起找 n 个连续空闲端口 */
export async function findPorts(n = 2, start = 8840, end = 8999) {
  for (let p = start; p + n - 1 <= end; p += n) {
    let ok = true;
    for (let k = 0; k < n && ok; k++) ok = !reserved(p + k) && (await portFree(p + k));
    if (ok) return Array.from({ length: n }, (_, k) => p + k);
  }
  throw new Error('找不到空闲端口（' + start + '-' + end + '）');
}

/** Windows：按 PID 查进程命令行与启动时间（Win32_Process）。查不到回 null。 */
export function procInfo(pid) {
  if (!pid) return null;
  if (process.platform !== 'win32') { try { process.kill(pid, 0); return { pid, cmd: '' }; } catch { return null; } }
  try {
    const ps = `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}"; if ($p) { [pscustomobject]@{ pid = $p.ProcessId; cmd = $p.CommandLine; created = $p.CreationDate.ToString('o'); parent = $p.ParentProcessId } | ConvertTo-Json -Compress }`;
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
    return out ? JSON.parse(out) : null;
  } catch { return null; }
}

/** 端口的监听进程 PID（Get-NetTCPConnection），没有回 0 */
export function listenerPid(port) {
  if (process.platform !== 'win32') return 0;
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim();
    return Number(out) || 0;
  } catch { return 0; }
}

/** 按 PID 收进程树（taskkill /T /F）。返回是否发出了命令。 */
export function killTree(pid) {
  if (!pid) return false;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true, timeout: 20000 });
    else process.kill(pid, 'SIGKILL');
    return true;
  } catch { return false; }
}

export const exists = existsSync;
