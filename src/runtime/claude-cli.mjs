// Claude Code 运行组件（Agent SDK 驱动的原生 CLI：claude / claude.exe）在哪；没有就去官方源拿。
//
// 开源路线 2.2 / N6：安装包与离线包不再内嵌它——它是 Anthropic 的专有二进制（All rights reserved），预装进产品
// 要另签商业条款。Agent SDK 自己的找法是在它旁边的可选依赖 @anthropic-ai/claude-agent-sdk-<平台> 里找；源码直跑
// （npm ci 装依赖的源码部署、Docker、Linux 一键脚本）照旧这样找到，这里不给 SDK 传任何参数，行为与以前一字不差。
// 找的顺序：
//   1. 显式指定：环境变量 BRIDGE_CLAUDE_CLI，或 config.json 的 claudeCliPath；
//   2. SDK 旁边与 SDK 同版本的平台包（源码直跑）；
//   3. 数据根里下好的：<数据根>/.bin/claude-code/<CLI 版本>-<平台>/claude(.exe)（install.json 记着校验值）；
//   4. 本机已装的同版本 Claude Code：官方安装脚本的 ~/.local/share/claude/versions/<版本>、
//      Claude 桌面版自带的 claude-code/<版本>/；
//   5. 都没有：后台从官方 npm 源下载 SDK 的平台包（registry.npmjs.org，不通再试 registry.npmmirror.com；
//      config.json 的 claudeCliRegistry / 环境变量 BRIDGE_CLAUDE_CLI_REGISTRY 排在最前面），只取包里的可执行文件，
//      按 SDK 自带 manifest.json 里这个平台的 sha256 与大小校验，对得上才落位。按速度换源：后面还有源时，
//      每 15 秒量一次速度，低于约 300 KB/s 且照这速度还要下两分钟以上就换下一个（国内直连 npmjs 常这样）；
//      后面的都不通再回到嫌慢的里面最快的那个下完。进度按网络上实际下载的压缩包算（约为解开后的一半）；
//   6. 下载失败：退而用本机任意版本的 Claude Code（~/.local/bin、桌面版最新一份、PATH 里的 claude），状态里写明
//      版本不一致，过一会儿自动再试下载；还是什么都没有就如实报错——设置 › Claude 页显示原因与「重试」，
//      发消息时错误卡片说明（status.mjs classifyError 认 code === 'CLAUDE_CLI_NOT_READY'）。
// 进度与状态：claudeCliStatus()（GET /api/claude-cli，见 routes/claude-cli.mjs）。
// 自动下载默认关（Muse Bridge）：要开就设 BRIDGE_CLAUDE_CLI_DOWNLOAD=1 或 config.json "claudeCliDownload": true。
// 关着时第 5 步跳过，直接走第 6 步的本机退路。
// 在源码目录里验收首启下载：BRIDGE_CLAUDE_CLI_SKIP_SDK=1（不认 node_modules 里的平台包）+ 临时数据根。
//
// 不读 config/index.mjs（那边导入即建目录、缺令牌直接退出）：config.json 按需现读，测试也能单独导入本模块。

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync, closeSync, createReadStream, createWriteStream, mkdirSync, openSync, readdirSync, readFileSync, readSync,
  renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { DATA_ROOT } from './paths.mjs';
import { whichSync } from './which.mjs';

const SDK_PKG = '@anthropic-ai/claude-agent-sdk';
const DEFAULT_REGISTRIES = ['https://registry.npmjs.org', 'https://registry.npmmirror.com'];
const CONNECT_TIMEOUT = 20_000;     // 等响应头
const STALL_TIMEOUT = 60_000;       // 下载中这么久没有新数据就换源
const SLOW_WINDOW = 15_000;         // 嫌慢换源：每这么久量一次最近这段的速度
const SLOW_RATE = 300 * 1024;       //   低于这个速度（字节 / 秒）……
const SLOW_REMAIN = 120;            //   ……且照这速度还要下这么多秒以上，就换下一个源
const RETRY_GAP = 60_000;           // 失败后，发消息顺带触发的重试至少隔这么久
const AUTO_RETRY = 10 * 60_000;     // 失败后后台自动再试的间隔
const AUTO_RETRY_MAX = 6;

const MB = (n) => Math.round((n || 0) / 1048576);
const readJson = (f) => { const raw = readFileSync(f, 'utf8'); return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw); };
const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const binOf = (key) => (String(key).startsWith('win32') ? 'claude.exe' : 'claude');
const hostOf = (u) => { try { return new URL(u).host; } catch { return String(u || ''); } };

// 真的是原生可执行文件（PE / ELF / Mach-O），不是 npm 的 .cmd 垫片、shell 或 node 脚本——SDK 要能直接 spawn 它。
export function isNativeExe(p) {
  let fd;
  try {
    if (!isFile(p)) return false;
    fd = openSync(p, 'r');
    const b = Buffer.alloc(4);
    if (readSync(fd, b, 0, 4, 0) < 4) return false;
    if (b[0] === 0x4d && b[1] === 0x5a) return true;                                   // MZ
    if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46) return true; // \x7fELF
    const m = b.readUInt32BE(0);
    return m === 0xfeedfacf || m === 0xcffaedfe || m === 0xcafebabe || m === 0xfeedface || m === 0xcefaedfe;
  } catch { return false; } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

let muslCache = null;
function isMusl() {
  if (process.platform !== 'linux') return false;
  if (muslCache === null) {
    try { const r = process.report?.getReport?.(); muslCache = !!r && r.header?.glibcVersionRuntime === undefined; } catch { muslCache = false; }
  }
  return muslCache;
}

// 平台键，顺序同 SDK 自己的找法（linux 按 glibc / musl 排先后）。
export function platformKeys(platform = process.platform, arch = process.arch, musl = isMusl()) {
  if (platform === 'linux') return musl ? [`linux-${arch}-musl`, `linux-${arch}`] : [`linux-${arch}`, `linux-${arch}-musl`];
  return [`${platform}-${arch}`];
}

// SDK 包：版本、它要求的 CLI 版本（package.json 的 claudeCodeVersion）、各平台二进制的校验值（manifest.json）。
export function sdkInfo() {
  try {
    const main = createRequire(import.meta.url).resolve(SDK_PKG);
    const dir = path.dirname(main);
    const pkg = readJson(path.join(dir, 'package.json'));
    let manifest = null;
    try { manifest = readJson(path.join(dir, 'manifest.json')); } catch {}
    return { main, dir, version: String(pkg.version || ''), cliVersion: String(pkg.claudeCodeVersion || manifest?.version || ''), manifest };
  } catch { return null; }
}

// SDK 旁边的平台包（就是 SDK 自己会用的那份）：{ path, key, version } 或 null。
function sdkBundled(sdk, keys) {
  let r;
  try { r = createRequire(sdk.main); } catch { return null; }
  for (const key of keys) {
    let p;
    try { p = r.resolve(`${SDK_PKG}-${key}/${binOf(key)}`); } catch { continue; }
    if (!isFile(p)) continue;
    // 只认 SDK 自己按 Node 常规解析得到的那份：平台包所在的 node_modules 必须是 SDK 目录的祖先。扩展用的核心解析钩子
    // （modules/core-resolve.mjs）会把程序目录之外的代码找不到的包回落到程序目录的 node_modules，那份不是这个 SDK 会用的。
    const nm = path.dirname(path.dirname(path.dirname(p)));
    const fold = (s) => (process.platform === 'win32' ? s.toLowerCase() : s);
    if (!fold(path.resolve(sdk.dir)).startsWith(fold(path.resolve(nm)) + path.sep)) continue;
    let version = '';
    try { version = String(readJson(path.join(path.dirname(p), 'package.json')).version || ''); } catch {}
    return { path: p, key, version };
  }
  return null;
}

const semver = (s) => { const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(s || '')); return m ? [+m[1], +m[2], +m[3]] : null; };
const cmpVer = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function desktopCliBase(home) {
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude-code');
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  return '';
}
const versionsDir = (home) => path.join(home, '.local', 'share', 'claude', 'versions');

// 本机已装、版本正好是 want 的 Claude Code。
function defaultLocalExact(want) {
  if (!semver(want)) return null;
  const home = os.homedir();
  const desk = desktopCliBase(home);
  const list = [
    path.join(versionsDir(home), want), path.join(versionsDir(home), want + '.exe'),
    ...(desk ? [path.join(desk, want, process.platform === 'win32' ? 'claude.exe' : 'claude')] : []),
  ];
  const p = list.find(isNativeExe);
  return p ? { path: p, version: want } : null;
}

// 本机任意版本的 Claude Code（下载不成时的退路）：[{ path, version|null }]，版本已知的新版在前。
function defaultLocalAny() {
  const home = os.homedir();
  const out = [];
  const newest = (dir, file) => {
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    const vers = names.map((n) => ({ n, k: semver(n) })).filter((x) => x.k).sort((a, b) => cmpVer(b.k, a.k));
    for (const v of vers) {
      const p = file ? path.join(dir, v.n, file) : path.join(dir, v.n);
      if (isNativeExe(p)) { out.push({ path: p, version: v.n }); return; }
    }
  };
  newest(versionsDir(home), '');
  const desk = desktopCliBase(home);
  if (desk) newest(desk, process.platform === 'win32' ? 'claude.exe' : 'claude');
  for (const p of [path.join(home, '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude'), whichSync('claude')]) {
    if (p && isNativeExe(p) && !out.some((x) => path.resolve(x.path) === path.resolve(p))) out.push({ path: p, version: null });
  }
  return out;
}

// `claude --version` → '2.1.299'（只在退路上用，起一次进程；异步，不卡事件循环）。
function probeVersion(p) {
  return new Promise((resolve) => {
    try {
      execFile(p, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true, env: { ...process.env, DISABLE_AUTOUPDATER: '1' } }, (err, stdout) => {
        const m = /(\d+\.\d+\.\d+)/.exec(String(stdout || ''));
        resolve(m ? m[1] : null);
      });
    } catch { resolve(null); }
  });
}

// ── tar（npm 包是 gzip 过的 ustar / pax）：流式找出一个条目，数据交给 onData ───────────────────────────
function cstr(b, off, len) {
  const s = b.subarray(off, off + len);
  const z = s.indexOf(0);
  return (z >= 0 ? s.subarray(0, z) : s).toString('utf8');
}
function tarSize(b, off, len) {
  if (b[off] & 0x80) {   // base-256（超过 8GB 的条目才会用到）
    let n = 0;
    for (let i = off + 1; i < off + len; i++) n = n * 256 + b[i];
    return n;
  }
  return parseInt(cstr(b, off, len).trim() || '0', 8) || 0;
}
function paxPath(buf) {
  for (let i = 0; i < buf.length;) {
    const sp = buf.indexOf(0x20, i);
    if (sp < 0) break;
    const len = parseInt(buf.subarray(i, sp).toString('latin1'), 10);
    if (!(len > 0)) break;
    const rec = buf.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    if (eq > 0 && rec.slice(0, eq) === 'path') return rec.slice(eq + 1);
    i += len;
  }
  return null;
}

// 读完（或找到）为止。match(name) 选中第一个普通文件条目，其数据分块交给 onData（可返回 Promise 做背压）。返回是否找到。
export async function extractTarEntry(stream, match, onData) {
  let buf = Buffer.alloc(0);
  let mode = 'head', left = 0, pad = 0, take = false, found = false;
  let meta = null, metaType = '', nextName = null;
  for await (const chunk of stream) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      if (mode === 'head') {
        if (buf.length < 512) break;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        if (h.every((x) => x === 0)) { mode = 'end'; break; }
        const type = h[156] === 0 ? '0' : String.fromCharCode(h[156]);
        let name = cstr(h, 0, 100);
        if (h.subarray(257, 262).toString('latin1') === 'ustar') { const pre = cstr(h, 345, 155); if (pre) name = pre + '/' + name; }
        if (nextName) { name = nextName; nextName = null; }
        left = tarSize(h, 124, 12);
        pad = (512 - (left % 512)) % 512;
        take = false;
        if (type === 'x' || type === 'L') { mode = 'meta'; metaType = type; meta = []; }
        else { mode = 'body'; take = !found && (type === '0' || type === '7') && match(name); }
        if (left === 0) {
          if (mode === 'meta') nextName = null;
          else if (take) found = true;
          mode = 'pad';
        }
        continue;
      }
      if (mode === 'body' || mode === 'meta') {
        if (!buf.length) break;
        const n = Math.min(left, buf.length);
        const part = buf.subarray(0, n);
        buf = buf.subarray(n);
        left -= n;
        if (mode === 'meta') meta.push(Buffer.from(part));
        else if (take) await onData(part);
        if (left === 0) {
          if (mode === 'meta') {
            const m = Buffer.concat(meta);
            nextName = metaType === 'L' ? cstr(m, 0, m.length) : (paxPath(m) || null);
          } else if (take) { found = true; take = false; }
          mode = 'pad';
        }
        continue;
      }
      if (mode === 'pad') {
        if (pad === 0) { mode = 'head'; continue; }
        if (!buf.length) break;
        const n = Math.min(pad, buf.length);
        buf = buf.subarray(n);
        pad -= n;
        if (pad === 0) mode = 'head';
        continue;
      }
      break;   // end
    }
    if (mode === 'end' || (found && mode === 'head')) break;
  }
  return found;
}

function sha256File(p) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(p).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

// 下载出错 → 人话（界面经 tr() 翻译，键在 web/src/i18n/en/claude-cli.js）。
class DlError extends Error {
  constructor(kind, info = {}) { super(kind); this.kind = kind; Object.assign(this, info); }
}
function humanError(e, { host, dir, expect, platform } = {}) {
  const kind = e instanceof DlError ? e.kind : '';
  const code = e && (e.code || e.cause?.code);
  if (kind === 'connect-timeout' || (e && (e.name === 'TimeoutError'))) return `连接下载源超时（${host}）`;
  if (kind === 'stall') return `下载停住了：${Math.round(STALL_TIMEOUT / 1000)} 秒没有收到新数据（${host}）`;
  if (kind === 'slow') return `下载太慢（约 ${Math.round((e.rate || 0) / 1024)} KB/s，${host}），已换下一个下载源`;
  if (kind === 'not-found') return `下载源上没有 Claude Code 运行组件 ${e.name_ || ''}（${host}）`.replace(/  +/g, ' ');
  if (kind === 'http') return `下载源回了 HTTP ${e.status}（${host}）`;
  if (kind === 'checksum') return '下载的文件校验不通过（可能不完整或被改动过），已丢弃';
  if (kind === 'missing-entry') return '下载的包里没有 Claude Code 可执行文件';
  if (kind === 'no-platform') return `这个平台（${platform}）没有官方的 Claude Code 运行组件`;
  if (code === 'ENOSPC') return `磁盘空间不够：Claude Code 运行组件需要约 ${MB(expect?.size) || 270} MB`;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return `没有权限写入 ${dir}`;
  if (code && /^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET|CERT_|UNABLE_TO|SELF_SIGNED)/.test(code)) return `连不上下载源（${host}）`;
  if (e && /fetch failed|network|socket/i.test(String(e.message || ''))) return `连不上下载源（${host}）`;
  return `下载失败：${String((e && e.message) || e || '').slice(0, 200)}`;
}

// ── 主体 ──────────────────────────────────────────────────────────────────────────────────────────
// 参数都可选（测试注入）：dataRoot、sdk（sdkInfo() 的形状，null = 没装 SDK）、keys、env、config()、fetch、
// localExact(want)、localAny()、probeVersion(p)、log。
export function createClaudeCli(opts = {}) {
  const env = opts.env || process.env;
  const readConfig = opts.config || (() => { try { return readJson(path.join(opts.dataRoot || DATA_ROOT, 'config.json')); } catch { return {}; } });
  const dataRoot = opts.dataRoot || DATA_ROOT;
  const fetchImpl = opts.fetch || ((...a) => fetch(...a));
  const log = opts.log || ((m) => console.log('[claude-cli] ' + m));
  const localExact = opts.localExact || defaultLocalExact;
  const localAny = opts.localAny || defaultLocalAny;
  const versionOf = opts.probeVersion || probeVersion;
  let sdkCache;
  const getSdk = () => (sdkCache !== undefined ? sdkCache : (sdkCache = opts.sdk !== undefined ? opts.sdk : sdkInfo()));
  const keys = () => opts.keys || platformKeys();

  let cur = null;            // 在用的：{ source, path, version }
  let phase = 'idle';        // idle | verifying | downloading
  let progress = null;       // { done, total, host }
  let lastErr = null;        // 最近一次失败（人话）
  let attempts = [];         // 最近一次下载各源的结果 [{ host, error }]
  let lastAttemptAt = 0;
  let autoRetries = 0;
  let retryTimer = null;
  let job = null;
  let explicitBad = null;    // 显式指定的路径不存在

  const cfg = () => { try { return readConfig() || {}; } catch { return {}; } };
  // Muse Bridge 默认不联网下载：服务端靠 npm 装的 SDK 平台包自带 CLI，下载只在显式打开时做（出站只走代理、不该偷偷拉二进制）。
  const downloadEnabled = () => env.BRIDGE_CLAUDE_CLI_DOWNLOAD === '1' || cfg().claudeCliDownload === true;
  // 验收 / 调试用：BRIDGE_CLAUDE_CLI_SKIP_SDK=1 不认 node_modules 里的平台包，在源码目录里模拟安装包布局（走首启下载）
  const skipSdk = () => env.BRIDGE_CLAUDE_CLI_SKIP_SDK === '1';
  // 下载源：自定义的（环境变量 / config.json）排最前，再官方、国内镜像。opts.registries（测试）整个替换。
  const registries = () => {
    if (opts.registries) return opts.registries;
    const c = cfg().claudeCliRegistry;
    const custom = [...String(env.BRIDGE_CLAUDE_CLI_REGISTRY || '').split(','), ...(Array.isArray(c) ? c : [c])]
      .map((s) => String(s || '').trim().replace(/\/+$/, '')).filter((s) => /^https?:\/\//.test(s));
    return [...new Set([...custom, ...DEFAULT_REGISTRIES])];
  };
  const downloadKey = (sdk) => keys().find((k) => sdk?.manifest?.platforms?.[k]) || keys()[0];
  const dataDir = (sdk, key) => path.join(dataRoot, '.bin', 'claude-code', `${sdk.cliVersion || sdk.version}-${key}`);

  // 数据根里那份：校验记录对得上（大小、sha256、mtime）才算数；有文件没记录 → { unverified }。
  function dataCopy(sdk) {
    const key = downloadKey(sdk);
    const expect = sdk.manifest?.platforms?.[key];
    const dir = dataDir(sdk, key);
    const bin = path.join(dir, expect?.binary || binOf(key));
    let st;
    try { st = statSync(bin); } catch { return null; }
    let stamp = null;
    try { stamp = readJson(path.join(dir, 'install.json')); } catch {}
    if (expect && stamp && stamp.sha256 === expect.checksum && stamp.size === st.size && st.size === expect.size
      && Math.abs(Number(stamp.mtimeMs) - st.mtimeMs) < 2) return { path: bin };
    return { path: bin, unverified: true };
  }

  // 同步找一遍（不下载、不哈希）：找到就是 { source, path, version }，否则 null。
  function resolveNow() {
    explicitBad = null;
    const explicit = String(env.BRIDGE_CLAUDE_CLI || cfg().claudeCliPath || '').trim();
    if (explicit) {
      if (isFile(explicit)) return { source: 'config', path: path.resolve(explicit), version: null };
      explicitBad = explicit;
    }
    const sdk = getSdk();
    if (!sdk) return null;
    const b = skipSdk() ? null : sdkBundled(sdk, keys());
    if (b && b.version === sdk.version) return { source: 'sdk', path: b.path, version: sdk.cliVersion || null };
    const d = dataCopy(sdk);
    if (d && !d.unverified) return { source: 'download', path: d.path, version: sdk.cliVersion || null };
    const le = localExact(sdk.cliVersion);
    if (le) return { source: 'local', path: le.path, version: le.version };
    return null;
  }

  function current() {
    if (cur && isFile(cur.path) && cur.source !== 'local-mismatch') return cur;
    const r = resolveNow();
    if (r) { cur = r; return cur; }
    if (cur && cur.source === 'local-mismatch' && isFile(cur.path)) return cur;
    cur = null;
    return null;
  }

  function scheduleRetry() {
    if (retryTimer || autoRetries >= AUTO_RETRY_MAX || !downloadEnabled()) return;
    retryTimer = setTimeout(() => { retryTimer = null; autoRetries++; ensure({ force: true }); }, opts.autoRetryMs || AUTO_RETRY);
    retryTimer.unref?.();
  }

  // 下载失败后的退路：本机任意版本。
  async function fallbackAny() {
    const sdk = getSdk();
    const b = sdk && !skipSdk() ? sdkBundled(sdk, keys()) : null;
    const list = [...localAny(), ...(b ? [{ path: b.path, version: null }] : [])];
    for (const c of list) {
      const version = c.version || (await versionOf(c.path));
      if (!version) continue;
      cur = { source: 'local-mismatch', path: c.path, version };
      log(`没拿到与 SDK 配套的 Claude Code ${sdk?.cliVersion || ''}，先用本机的 ${version}：${c.path}`);
      return true;
    }
    return false;
  }

  // skipIfSlow：后面还有别的源可试时才嫌慢（见文件头「按速度换源」）。
  async function downloadFrom(registry, sdk, key, expect, dir, { skipIfSlow = false } = {}) {
    const host = hostOf(registry);
    const pkg = `claude-agent-sdk-${key}`;
    const url = `${registry}/${SDK_PKG.split('/')[0]}/${pkg}/-/${pkg}-${sdk.version}.tgz`;
    const bin = path.join(dir, expect.binary || binOf(key));
    const part = bin + '.part';
    const ac = new AbortController();
    let timer = setTimeout(() => ac.abort(new DlError('connect-timeout')), opts.connectTimeoutMs || CONNECT_TIMEOUT);
    let slowTimer = null;
    let ws = null, body = null;
    try {
      const res = await fetchImpl(url, { signal: ac.signal, redirect: 'follow' });
      if (res.status === 404) throw new DlError('not-found', { name_: `${pkg}@${sdk.version}` });
      if (!res.ok || !res.body) throw new DlError('http', { status: res.status });
      // 进度按网络上实际下载的压缩包算（Content-Length，约为解开后的一半）；响应没给长度、或又套了一层传输压缩
      // （fetch 会自动解开，收到的字节对不上长度）时，退回按解开的字节算（packed:false）。
      const enc = String(res.headers?.get?.('content-encoding') || '').trim().toLowerCase();
      const clen = Number(res.headers?.get?.('content-length'));
      const packed = (!enc || enc === 'identity') && clen > 0 ? clen : 0;
      let got = 0, done = 0, nextLog = 0.1;   // got：收到的压缩字节；done：解出的可执行文件字节
      const report = () => {
        progress = packed ? { done: Math.min(got, packed), total: packed, host, packed: true } : { done, total: expect.size, host, packed: false };
        const f = progress.done / progress.total;
        if (f >= nextLog) {
          log(`下载中 ${Math.floor(f * 100)}%（${MB(progress.done)} / ${MB(progress.total)} MB，${host}）`);
          nextLog = Math.floor(f * 10) / 10 + 0.1;
        }
      };
      report();
      const stall = () => { clearTimeout(timer); timer = setTimeout(() => ac.abort(new DlError('stall')), opts.stallTimeoutMs || STALL_TIMEOUT); };
      stall();
      if (skipIfSlow) {
        // 每个窗口量一次这段的速度；太慢、且照这速度还要下很久才换（快下完了就不折腾）。没给长度时剩余量按解开的
        // 字节估，偏大一倍左右，只会让换源略积极一点。
        const win = opts.slowWindowMs || SLOW_WINDOW;
        const minRate = opts.slowRate || SLOW_RATE;
        let markAt = Date.now(), markGot = 0;
        slowTimer = setInterval(() => {
          const now = Date.now();
          const rate = ((got - markGot) * 1000) / Math.max(1, now - markAt);
          markAt = now;
          markGot = got;
          const left = packed ? packed - got : Math.max(0, expect.size - done);
          if (rate < minRate && left / Math.max(rate, 1) > SLOW_REMAIN) ac.abort(new DlError('slow', { rate }));
        }, win);
        slowTimer.unref?.();
      }
      mkdirSync(dir, { recursive: true });
      body = Readable.fromWeb(res.body);
      const gunzip = createGunzip();
      gunzip.on('error', () => {});   // 错误由下面的 for await 接住；提前收尾后迟到的错误别成了未处理事件
      body.on('data', (c) => { got += c.length; stall(); if (packed) report(); });
      body.on('end', () => clearInterval(slowTimer));   // 收完了，剩下的只是解包，不再嫌慢
      body.on('error', (e) => gunzip.destroy(ac.signal.aborted && ac.signal.reason ? ac.signal.reason : e));
      body.pipe(gunzip);
      ws = createWriteStream(part, { mode: 0o755 });
      const wsErr = new Promise((_, reject) => ws.on('error', reject));
      wsErr.catch(() => {});
      const hash = createHash('sha256');
      const want = 'package/' + (expect.binary || binOf(key));
      const found = await Promise.race([wsErr, extractTarEntry(gunzip, (n) => n === want || n === './' + want, async (b) => {
        hash.update(b);
        done += b.length;
        if (!packed) report();
        if (!ws.write(b)) await Promise.race([once(ws, 'drain'), wsErr]);
      })]);
      clearTimeout(timer);
      clearInterval(slowTimer);
      body.destroy();
      ws.end();
      await Promise.race([once(ws, 'close'), wsErr]);
      ws = null;
      if (!found) throw new DlError('missing-entry');
      const sum = hash.digest('hex');
      if (done !== expect.size || sum !== expect.checksum) throw new DlError('checksum');
      rmSync(bin, { force: true });
      renameSync(part, bin);
      if (process.platform !== 'win32') { try { chmodSync(bin, 0o755); } catch {} }
      const st = statSync(bin);
      writeFileSync(path.join(dir, 'install.json'), JSON.stringify({
        version: sdk.cliVersion, sdkVersion: sdk.version, platform: key, sha256: sum, size: st.size, mtimeMs: st.mtimeMs, from: host, at: Date.now(),
      }, null, 2));
      return bin;
    } catch (e) {
      clearTimeout(timer);
      clearInterval(slowTimer);
      const err = ac.signal.aborted && ac.signal.reason instanceof DlError ? ac.signal.reason : e;
      try { body?.destroy(); } catch {}
      if (ws) { ws.destroy(); await once(ws, 'close').catch(() => {}); }
      rmSync(part, { force: true });
      throw err;
    }
  }

  // 换上新的之后，清掉其余版本（在跑的 CLI 锁着的删不掉就算了，下次再清）。
  function cleanupOld(keepDir) {
    const base = path.dirname(keepDir);
    let names = [];
    try { names = readdirSync(base); } catch { return; }
    for (const n of names) {
      const p = path.join(base, n);
      if (p === keepDir) continue;
      try { rmSync(p, { recursive: true, force: true }); } catch {}
    }
  }

  async function obtain() {
    const sdk = getSdk();
    if (!sdk) { lastErr = '找不到 Agent SDK（@anthropic-ai/claude-agent-sdk）：在程序目录运行 npm ci'; return; }
    const key = downloadKey(sdk);
    const expect = sdk.manifest?.platforms?.[key];
    const dir = dataDir(sdk, key);
    if (!expect || !expect.checksum || !expect.size) {
      lastErr = humanError(new DlError('no-platform'), { platform: key });
      if (!(await fallbackAny())) log(lastErr);
      return;
    }
    // 有文件没校验记录（上次下完没写成 / 手动拷来的）：先哈希，对得上就补记录直接用。
    const d = dataCopy(sdk);
    if (d && d.unverified) {
      phase = 'verifying';
      try {
        const st = statSync(d.path);
        if (st.size === expect.size && (await sha256File(d.path)) === expect.checksum) {
          writeFileSync(path.join(dir, 'install.json'), JSON.stringify({ version: sdk.cliVersion, sdkVersion: sdk.version, platform: key, sha256: expect.checksum, size: st.size, mtimeMs: st.mtimeMs, from: 'local', at: Date.now() }, null, 2));
          cur = { source: 'download', path: d.path, version: sdk.cliVersion };
          lastErr = null;
          return;
        }
      } catch {}
      try { rmSync(d.path, { force: true }); } catch {}
    }
    if (!downloadEnabled()) {   // 离线部署：不下载，只找本机的；都没有时状态是 missing，提示装 Claude Code 或指定路径
      if (!(await fallbackAny())) log(`没找到 Claude Code ${sdk.cliVersion}，自动下载没开（BRIDGE_CLAUDE_CLI_DOWNLOAD=1 / claudeCliDownload:true 才会下载）`);
      return;
    }
    phase = 'downloading';
    attempts = [];
    log(`本机没有 Claude Code ${sdk.cliVersion}，从官方源下载运行组件（解开后约 ${MB(expect.size)} MB，只需一次）`);
    const slow = [];      // 嫌慢放弃的源：[{ reg, rate }]
    let fatal = false;    // 磁盘满 / 没权限：换源也没用
    const attempt = async (reg, skipIfSlow) => {
      const host = hostOf(reg);
      try {
        progress = { done: 0, total: expect.size, host, packed: false };
        const bin = await downloadFrom(reg, sdk, key, expect, dir, { skipIfSlow });
        cur = { source: 'download', path: bin, version: sdk.cliVersion };
        lastErr = null;
        attempts.push({ host, error: null });
        autoRetries = 0;
        log(`已下载并校验 Claude Code ${sdk.cliVersion}（${host}）→ ${bin}`);
        cleanupOld(dir);
        return true;
      } catch (e) {
        const msg = humanError(e, { host, dir, expect, platform: key });
        attempts.push({ host, error: msg });
        lastErr = msg;
        const isSlow = e instanceof DlError && e.kind === 'slow';
        if (isSlow) slow.push({ reg, rate: e.rate || 0 });
        log((isSlow ? '换源：' : '下载失败：') + msg + (e && e.message && !(e instanceof DlError) ? '（' + e.message + '）' : ''));
        if (e && (e.code === 'ENOSPC' || e.code === 'EACCES' || e.code === 'EPERM' || e.code === 'EROFS')) fatal = true;
        return false;
      }
    };
    const regs = registries();
    // 只对「后面还有源」的嫌慢；最后一个源不嫌慢，下完为止
    for (let i = 0; i < regs.length && !fatal; i++) if (await attempt(regs[i], i < regs.length - 1)) return;
    // 后面的源都不通、前面有嫌慢放弃的：回到其中最快的那个，这回不嫌慢
    if (!fatal && slow.length) {
      const best = slow.sort((a, b) => b.rate - a.rate)[0];
      log(`别的下载源都不行，回到最快的 ${hostOf(best.reg)} 下完`);
      if (await attempt(best.reg, false)) return;
    }
    await fallbackAny();
    scheduleRetry();
  }

  // 没就绪就去拿（幂等；进行中复用同一个）。force = 不管上次失败隔了多久（重试按钮、后台定时）。
  function ensure({ force = false } = {}) {
    if (current() && cur.source !== 'local-mismatch') return Promise.resolve(status());
    if (job) return job;
    if (!force && lastAttemptAt && Date.now() - lastAttemptAt < RETRY_GAP) return Promise.resolve(status());
    if (cur && cur.source === 'local-mismatch' && !force) return Promise.resolve(status());
    lastAttemptAt = Date.now();
    job = (async () => {
      try { await obtain(); } catch (e) { lastErr = humanError(e, {}); }
      finally { phase = 'idle'; progress = null; job = null; }
      return status();
    })();
    return job;
  }

  function status() {
    const sdk = getSdk();
    const c = job ? cur : current();
    const state = c ? 'ready' : phase !== 'idle' ? phase : lastErr || explicitBad ? 'failed' : 'missing';
    return {
      state,
      source: c ? c.source : null,
      path: c ? c.path : null,
      version: c ? c.version : null,
      want: sdk ? sdk.cliVersion || null : null,
      platform: sdk ? downloadKey(sdk) : keys()[0],
      progress: phase === 'downloading' && progress ? { ...progress } : null,
      error: explicitBad ? `指定的 Claude Code 不存在：${explicitBad}` : (c && c.source !== 'local-mismatch' ? null : lastErr),
      attempts: attempts.slice(-4),
      download: downloadEnabled(),
      size: sdk?.manifest?.platforms?.[downloadKey(sdk)]?.size || null,
    };
  }

  // 给 query() 的参数：SDK 自带的那份不用传（SDK 自己找得到，行为同以前）。没就绪就抛「人话」错误并顺手触发获取。
  function options() {
    const c = current();
    if (c) return c.source === 'sdk' ? {} : { pathToClaudeCodeExecutable: c.path };
    ensure();
    throw notReadyError(status());
  }

  // 正在用的可执行文件的绝对路径（Chrome 拆分模式要自己挂 `claude --claude-in-chrome-mcp`）；没有就是 null。
  function binPath() { const c = current(); return c ? c.path : null; }

  function init() {
    const c = current();
    if (c) {
      const what = { config: '指定的', sdk: 'SDK 自带的', download: '数据根里下好的', local: '本机已装的' }[c.source] || '本机的';
      log(`用${what} Claude Code${c.version ? ' ' + c.version : ''}：${c.path}`);
      return Promise.resolve(status());
    }
    return ensure({ force: true });
  }

  return { init, ensure, status, options, binPath, retry: () => ensure({ force: true }) };
}

export function notReadyError(st) {
  let title, hint;
  if (st.state === 'downloading' && st.progress) {
    const pct = st.progress.total ? Math.floor((st.progress.done / st.progress.total) * 100) : 0;
    title = 'Claude Code 运行组件还在下载';
    hint = `已下载 ${pct}%（${MB(st.progress.done)} / ${MB(st.progress.total)} MB），完成后再发一次即可。`;
  } else if (st.state === 'verifying' || st.state === 'downloading') {
    title = 'Claude Code 运行组件正在准备';
    hint = '稍等几秒再发一次。';
  } else if (st.error) {
    // 错误卡片发给任何人、任何一端：只有管理员看得到设置里的状态块，装 / 指定也只能在跑服务端的那台电脑上做
    title = 'Claude Code 运行组件还没就绪';
    hint = `${st.error}。管理员可以在「设置 › Claude」里重试，或在运行 bridge 服务端的电脑上安装 Claude Code。`;
  } else {
    title = 'Claude Code 运行组件还没就绪';
    hint = `需要 Claude Code ${st.want || ''}：管理员可以在运行 bridge 服务端的电脑上安装它，或在服务端 config.json 里用 claudeCliPath 指定位置。`.replace('Claude Code ：', 'Claude Code：');
  }
  const e = new Error(title + ' — ' + hint);
  e.code = 'CLAUDE_CLI_NOT_READY';
  e.title = title;
  e.hint = hint;
  return e;
}

// ── 进程级单例 ────────────────────────────────────────────────────────────────────────────────────
let main = null;
const cli = () => main || (main = createClaudeCli());

export function initClaudeCli() { return cli().init(); }
export function claudeCliStatus() { return cli().status(); }
export function retryClaudeCli() { return cli().retry(); }
export function claudeCliOptions() { return cli().options(); }
export function claudeCliPath() { return cli().binPath(); }
