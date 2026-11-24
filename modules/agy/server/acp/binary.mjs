// Antigravity CLI 可执行文件发现与进程树清理。
// Windows 上 agy acp 会拉起内置 language_server 子进程，直接 proc.kill() 会留下占着管道的孙进程，
// 必须按进程树（taskkill /T /F）整棵清理。

import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { whichSync } from '@bridge/core/runtime/which.mjs';

export const BUNDLED_AGY_DIR = fileURLToPath(new URL('../../bin/', import.meta.url));

function bundledAgy() {
  const f = path.join(BUNDLED_AGY_DIR, process.platform === 'win32' ? 'agy.exe' : 'agy');
  return existsSync(f) ? f : null;
}

export function locateAgy() {
  const override = String(process.env.AGY_BIN || '').trim();
  if (override) {
    const isNodeScript = /\.(mjs|cjs|js)$/i.test(override);
    return {
      file: override,
      isNodeScript,
      viaShell: !isNodeScript && process.platform === 'win32' && /\.(cmd|bat)$/i.test(override),
    };
  }

  const bundled = bundledAgy();
  if (bundled) return { file: bundled, isNodeScript: false, viaShell: false };

  if (process.platform === 'win32') {
    const localApp = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const winExe = path.join(localApp, 'agy', 'bin', 'agy.exe');
    if (existsSync(winExe)) return { file: winExe, isNodeScript: false, viaShell: false };
    const found = whichSync('agy');
    if (found) return { file: found, isNodeScript: false, viaShell: /\.(cmd|bat)$/i.test(found) };
    return { file: winExe, isNodeScript: false, viaShell: false };
  }

  const localBin = path.join(os.homedir(), '.local', 'bin', 'agy');
  if (existsSync(localBin)) return { file: localBin, isNodeScript: false, viaShell: false };
  const found = whichSync('agy');
  return { file: found || 'agy', isNodeScript: false, viaShell: false };
}

export function agyInstalled() {
  const { file } = locateAgy();
  return path.isAbsolute(file) ? existsSync(file) : !!whichSync(file);
}

export function agyDataDir() {
  const custom = String(process.env.AGY_APP_DATA_DIR || '').trim();
  if (custom) return path.resolve(custom);
  const home = String(process.env.AGY_HOME_DIR || '').trim();
  if (home) return path.join(path.resolve(home), '.gemini', 'antigravity-cli');
  return path.join(os.homedir(), '.gemini', 'antigravity-cli');
}

// Antigravity 桌面版自己的数据目录（~/.gemini/antigravity）。agy CLI 的 session/list 会把桌面版建的会话
// 一并列出来（fallback import），但常驻 `agy acp` 用的是 antigravity-cli 存储，session/load 这些会话时
// 报 trajectory not found、回放 0 条——必须另起一个 `--app-data-dir antigravity` 的进程才读得到。
export const AGY_DESKTOP_APP_DATA_DIR = 'antigravity';

export function agyDesktopDataDir() {
  const home = String(process.env.AGY_HOME_DIR || '').trim();
  return path.join(home ? path.resolve(home) : os.homedir(), '.gemini', AGY_DESKTOP_APP_DATA_DIR);
}

const CONVERSATION_EXTS = ['.db', '.pb'];
function hasConversation(dir, id) {
  return CONVERSATION_EXTS.some((ext) => existsSync(path.join(dir, 'conversations', id + ext)));
}

// 会话落在哪个存储：'cli'（默认）| 'desktop'（只存在于桌面版目录里）。id 只认 uuid 形状，防路径穿越。
export function agySessionStore(sessionId) {
  const id = String(sessionId || '').trim();
  if (!/^[0-9a-f-]{8,64}$/i.test(id)) return 'cli';
  if (hasConversation(agyDataDir(), id)) return 'cli';
  return hasConversation(agyDesktopDataDir(), id) ? 'desktop' : 'cli';
}

export function agyCredentialsPresent() {
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_APPLICATION_CREDENTIALS) return true;
  const dir = agyDataDir();
  for (const name of ['acp_auth_state.json', 'oauth_creds.json', 'google_accounts.json', 'auth.json']) {
    if (existsSync(path.join(dir, name))) return true;
  }
  try {
    const pbtxt = readFileSync(path.join(dir, 'jetski_state.pbtxt'), 'utf8');
    if (/\b(oauth|refresh_token|access_token|user_email|account|post_onboarding)\b/i.test(pbtxt)) return true;
  } catch {}
  return false;
}

function winQuote(value) {
  const s = String(value);
  if (s === '') return '""';
  if (!/[ \t"&|<>^()%!]/.test(s)) return s;
  let quoted = '"';
  let slashes = 0;
  for (const ch of s) {
    if (ch === '\\') { slashes++; continue; }
    if (ch === '"') {
      quoted += '\\'.repeat(slashes * 2 + 1) + '"';
      slashes = 0;
      continue;
    }
    if (slashes) {
      quoted += '\\'.repeat(slashes);
      slashes = 0;
    }
    quoted += ch;
  }
  return quoted + '\\'.repeat(slashes * 2) + '"';
}

export function spawnAgyProcess(acpArgs = ['acp'], { cwd, env, command, args } = {}) {
  const spawnEnv = env || process.env;
  if (command) {
    return spawn(command, args || acpArgs, {
      cwd,
      env: spawnEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  }

  const target = locateAgy();
  if (target.isNodeScript) {
    return spawn(process.execPath, [target.file, ...acpArgs], {
      cwd,
      env: spawnEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  }
  if (!target.viaShell) {
    return spawn(target.file, acpArgs, {
      cwd,
      env: spawnEnv,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
    });
  }
  const line = [winQuote(target.file), ...acpArgs.map(winQuote)].join(' ');
  return spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', line], {
    cwd,
    env: spawnEnv,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: false,
    windowsVerbatimArguments: true,
  });
}

export function killProcessTree(proc) {
  if (!proc) return;
  try { proc.stdin?.end(); } catch {}
  const pid = proc.pid;
  if (!proc.__treeKilled && pid && proc.exitCode === null) {
    proc.__treeKilled = true;
    if (process.platform === 'win32') {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
          stdio: 'ignore',
          windowsHide: true,
          timeout: 3000,
        });
      } catch {
        // 进程已退出或受限环境拦截 taskkill 时，继续走直接终止信号
      }
    }
    try { proc.kill('SIGKILL'); } catch {}
  }
  try { proc.stdin?.destroy(); } catch {}
  try { proc.stdout?.destroy(); } catch {}
  try { proc.stderr?.destroy(); } catch {}
  try { proc.unref?.(); } catch {}
}

export function unlockDaemonDir(dir) {
  if (!dir) return;
  try {
    if (!existsSync(dir)) return;
    if (process.platform === 'win32') {
      execFileSync('icacls', [dir, '/reset'], { stdio: 'ignore', windowsHide: true, timeout: 3000 });
    } else {
      chmodSync(dir, 0o755);
    }
  } catch {}
}

// 守护进程占位目录必须落在 os.tmpdir() 下、远离仓库与数据根：
// agy 会把进程 cwd 固定为首个 Active Workspace 并沿父目录查找 git 根与 AGENTS.md；
// 若放在 <DATA_ROOT>/agy/daemon-cwd（仓库内），所有会话都会被注入仓库的 AGENTS.md。
// 按 scope（数据根）哈希 + slot 分槽，避免同机正式服、测试服、桌面存储、成员进程互相解锁冲突。
export function defaultDaemonCwd(slot = 'main', scope = '') {
  const scopeKey = scope ? path.resolve(String(scope)) : 'default';
  const rootHash = createHash('sha1').update(scopeKey).digest('hex').slice(0, 10);
  const safeSlot = String(slot || 'main').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40) || 'main';
  return path.join(os.tmpdir(), 'claude-bridge-agy', `${rootHash}-${safeSlot}`, 'daemon-cwd');
}

const WORKER_STARTED_RE = /front:\s*started worker (\d+) \(pid (\d+)\)/g;

// --process-per-session 模式下，front 日志只记录派生的 worker PID，
// language server 端口与账号认证日志落在同目录的 `<logFile>.<workerPid>`。
// worker 1 负责 session/list 且整个 front 生命周期常驻（不随 session/close 退出），优先排在最前。
export function listWorkerLogFiles(frontLogFile) {
  if (!frontLogFile) return [];
  const resolved = path.resolve(frontLogFile);
  const out = [];
  const seen = new Set();
  const pushIfExists = (file) => {
    if (!file || seen.has(file)) return;
    seen.add(file);
    try {
      if (existsSync(file) && statSync(file).isFile()) out.push(file);
    } catch {}
  };

  try {
    if (existsSync(resolved)) {
      const txt = readFileSync(resolved, 'utf8');
      const workers = [];
      for (const m of txt.matchAll(WORKER_STARTED_RE)) {
        workers.push({ num: Number(m[1]), pid: String(m[2]) });
      }
      // worker 1 优先（常驻控制面），其余按启动顺序倒序
      for (const w of workers) {
        if (w.num === 1) pushIfExists(`${resolved}.${w.pid}`);
      }
      for (let i = workers.length - 1; i >= 0; i--) {
        if (workers[i].num !== 1) pushIfExists(`${resolved}.${workers[i].pid}`);
      }
    }
  } catch {}

  return out;
}

// 启动新 front 进程前清理上一轮残留的 `<logBase>.<数字pid>` 碎片日志，防止长期运行后日志堆积。
export function cleanupWorkerLogFiles(frontLogFile) {
  if (!frontLogFile) return 0;
  const resolved = path.resolve(frontLogFile);
  const dir = path.dirname(resolved);
  const base = path.basename(resolved);
  const prefix = `${base}.`;
  let removed = 0;
  let entries;
  try { entries = readdirSync(dir); } catch { return 0; }
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue;
    const suffix = name.slice(prefix.length);
    if (!/^\d+$/.test(suffix)) continue;
    try {
      rmSync(path.join(dir, name), { force: true });
      removed++;
    } catch {}
  }
  return removed;
}

// 将常驻守护进程 cwd 保持为空目录并收紧为只读/仅遍历（禁止在目录内新建文件或子目录），
// 使模型若误向 daemon-cwd 写入立刻报错，且目录内永远不存在同名项目文件可被悄悄误读。
export function prepareReadOnlyDaemonDir(dir) {
  if (!dir) return;
  // 目录总要存在：它是子进程的 cwd，不存在时 Windows 的 spawn 报的是误导性的「node.exe ENOENT」。
  try { mkdirSync(dir, { recursive: true }); } catch {}
  // 下面会递归清空目录：只认专用的 daemon-cwd，传错路径（测试或日后的配置项）也不会清掉真实目录。
  if (path.basename(path.resolve(dir)) !== 'daemon-cwd') return;
  unlockDaemonDir(dir);
  try {
    for (const entry of readdirSync(dir)) {
      rmSync(path.join(dir, entry), { recursive: true, force: true });
    }
  } catch {}
  try {
    if (process.platform === 'win32') {
      execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', '*S-1-1-0:(R,X,D)'], {
        stdio: 'ignore',
        windowsHide: true,
        timeout: 3000,
      });
    } else {
      chmodSync(dir, 0o555);
    }
  } catch {}
}

// —— 被空 .db 遮住的旧格式会话 ——
// agy 早先把会话写成 conversations/<id>.pb，新版改用 <id>.db（SQLite）。新旧两版进程同时在跑的那段时间
// （常驻进程还是旧二进制、list/load 已是新二进制）会出现「.pb 里是完整对话、旁边多了一个 0 步的空 .db」：
// 新版只读 .db → 打开是一片空白，agy 自己载也只回放 0 条。实测把空 .db 挪走，新版就会从 .pb 读出完整历史。
// .db 被 agy 进程占着时挪不动（关掉会话也不放），所以只在启动 agy 常驻进程之前修。
let sqliteMod;
function openSqlite(file) {
  if (sqliteMod === undefined) {
    try { sqliteMod = createRequire(import.meta.url)('node:sqlite'); } catch { sqliteMod = null; }
  }
  if (!sqliteMod?.DatabaseSync) return null;
  return new sqliteMod.DatabaseSync(file, { readOnly: true });
}

function emptyStepsDb(file) {
  let db = null;
  try {
    db = openSqlite(file);
    if (!db) return false;
    const row = db.prepare('SELECT count(*) AS n FROM steps').get();
    return Number(row?.n) === 0;
  } catch {
    return false;
  } finally {
    try { db?.close(); } catch {}
  }
}

/** 把遮住 .pb 的空 .db（连同 -shm / -wal）挪进 conversations-empty-db/；返回修好的会话 id 列表 */
export function repairShadowedConversations(dataDir) {
  const dir = path.join(dataDir, 'conversations');
  const fixed = [];
  let names = [];
  try { names = readdirSync(dir); } catch { return fixed; }
  const backup = path.join(dataDir, 'conversations-empty-db');
  for (const name of names) {
    if (!name.endsWith('.pb')) continue;
    const id = name.slice(0, -3);
    const dbFile = path.join(dir, id + '.db');
    if (!existsSync(dbFile)) continue;
    try { if (!statSync(path.join(dir, name)).size) continue; } catch { continue; }
    if (!emptyStepsDb(dbFile)) continue;
    try {
      mkdirSync(backup, { recursive: true });
      const stamp = Date.now();
      renameSync(dbFile, path.join(backup, `${id}.${stamp}.db`));
      for (const ext of ['.db-shm', '.db-wal']) {
        const f = path.join(dir, id + ext);
        if (existsSync(f)) { try { renameSync(f, path.join(backup, `${id}.${stamp}${ext}`)); } catch {} }
      }
      fixed.push(id);
    } catch {}
  }
  return fixed;
}
