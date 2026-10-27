// 公网访问（内置托管 cloudflared）。
//
// 以前「外网能打开」全靠维护者个人的一套脚本：admin.ps1 起停隧道、task-tunnel.vbs 开机拉起、tunnel-watchdog.mjs
// 探活自愈、cloudflared-bridge.yml 写死命名隧道——公开版导出时整套剔除（scripts/public/export.mjs 的 DENY），
// 别人下载的服务端于是没法在产品里配公网。这里把它做进服务端本体：Windows / Linux / Docker / 安装包里的本机服务端
// 都能在控制台「服务控制 → 公网访问」里开，不依赖 admin.ps1。
//
// 四种模式（数据根 public-access.json，权限 0600；令牌只存这里，GET 永不回显）：
//   off     不托管（默认）：只能在本机 / 局域网打开
//   quick   cloudflared 快速隧道（*.trycloudflare.com）：免注册即用，但每起一次隧道地址就换一个
//   token   Cloudflare 命名隧道：贴 Cloudflare 控制台给的隧道令牌，由服务端托管 cloudflared。
//           令牌经环境变量 TUNNEL_TOKEN 交给 cloudflared，不出现在进程参数里，也不进本进程的 process.env
//           （否则 Claude 等子进程都会继承到它）
//   manual  自己有反向代理 / 域名：只填对外地址，这里只定时探活、不起任何进程
//
// cloudflared 从哪来：PATH 里有就用（Linux 的 install.sh 会装 deb）；没有就按平台从官方 GitHub Release 下载
// 【固定版本】到 <数据根>/.bin/cloudflared-<版本>/，核对大小与 SHA-256，对不上就丢弃并给人话。
//
// 托管：cloudflared 是本进程的子进程，随服务端起停（exit 时收尸；上一条命闪退没收掉的，下次启动按 pid 文件
// 核对进程名后再收）；意外退出按退避重拉；最近的输出进环形缓冲给控制台看。切换隧道（换令牌、quick→token、
// 命名隧道重启）先接新的、等它连上 Cloudflare 再拆旧的——新的起不来就保留旧的，远程管理不会把自己切断。
//
// 看门狗（移植 tunnel-watchdog.mjs）：每 45 秒探一次 cloudflared 自己的 /ready（回环 metrics 端口，不受本机
// 代理 / fake-ip 影响）和经公网地址的 /healthz。重启隧道只看 /ready 连续 3 次失败，两次之间至少冷却 3 分钟。
// 公网探针只给界面看（lastProbe / 提示）：本机经公网探自己本来就不可靠（Clash 的 fake-ip / TUN、回环受限、DNS
// 负缓存都会让本机探不通而外面好好的——tunnel-watchdog.mjs 因此只看 /ready），唯一例外是快速隧道连续多次被
// Cloudflare 边缘明确回「找不到这条隧道」（HTTP 530），那才换一个临时地址。刚起的隧道在宽限期内不打公网探针。
// 本机端口（按监听地址探）自己都连不上时不动隧道——问题不在隧道，也不会去「重启自己」。
// quick 模式地址变了：更新运行态的对外地址（config 的 PUBLIC_ORIGIN 活绑定，分享链接、扫码登录都跟着变），
// 并经总线推一条 {type:'public-access'} 给管理员在线的页面；server.mjs 另把它转成给所有在线设备的 {type:'server.address'}
// （runtime/address-events.mjs），设备据此自动改写自己存的服务器地址（S1-1，见 web/src/lib/serverAddress.js）。
//
// 维护者这台：admin.ps1 + task-tunnel.vbs / cloudflared-bridge.yml 在位 = 隧道由本机脚本托管。这里默认 off，
// 并拒绝开 quick / token（免得起第二条隧道、和 tunnel-watchdog 打架），界面说明「由本机脚本托管」。
// Muse 部署（muse-tunnel.service，平台专门的网络命名空间里跑 cloudflared）同样锁住；老的 install.sh 起的
// bridge-tunnel.service 只提示（重跑 install.sh --tunnel-token 就换成这里托管）。
// NO_AUTH 实例（不带访问令牌的本机调试台）绝不允许挂公网。

import { spawn, execFile } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import { createHash } from 'node:crypto';
import {
  existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, rmSync, chmodSync, createWriteStream, statSync,
} from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { whichSync } from './which.mjs';

// ── cloudflared 固定版本（官方 GitHub Release 2026.9.3，2026-09-24 发布）────────────────────────────
// 大小与 SHA-256 取自该 Release 的资产摘要，并与发布说明里的「SHA256 Checksums」逐条核对过。
// 换版本：改 CF_VERSION 与下表，六个资产都要换（release 页面底部有校验和）。
export const CF_VERSION = '2026.9.3';
const CF_WIN_X64 = { name: 'cloudflared-windows-amd64.exe', size: 55366080, sha256: 'f096265ec2fcbe9bb6e2d64268db167ced3fcbb83d894bdb9e2fcdb26f2ea7e2' };
const CF_ASSETS = {
  'win32-x64': CF_WIN_X64,
  'win32-arm64': CF_WIN_X64,   // 官方没有 Windows arm64 版，x64 版在 Windows on ARM 上走仿真照样能跑
  'win32-ia32': { name: 'cloudflared-windows-386.exe', size: 37702280, sha256: '9b95ddc2eba67b86ed3dc4cc2a15881960563031b52ce564376af41fb91ad402' },
  'linux-x64': { name: 'cloudflared-linux-amd64', size: 40122749, sha256: '77e26d8d900e0b8469f416239d14b5f296525fdf79fee6f511ef55609e3fbac2' },
  'linux-arm64': { name: 'cloudflared-linux-arm64', size: 37685657, sha256: 'aaeb2d7d0da3614634c7e03ab13487a1522c2e79165ed2929cfe23d5e95b326d' },
  'linux-arm': { name: 'cloudflared-linux-arm', size: 36573408, sha256: '967dc371a3fedbf09e881c13ee7ba317155ebc336cbd4afb756b46fc6785e5af' },
  'linux-ia32': { name: 'cloudflared-linux-386', size: 37419453, sha256: 'd6b2f917e2e78b3e3afba760af726e51751d10c2fcad4a2fb2a69feb4bd47421' },
};
export function cfAsset(platform = process.platform, arch = process.arch) { return CF_ASSETS[platform + '-' + arch] || null; }
export const cfDownloadUrl = (asset) => `https://github.com/cloudflare/cloudflared/releases/download/${CF_VERSION}/${asset.name}`;

export const MODES = ['off', 'quick', 'token', 'manual'];
const TUNNEL_MODES = new Set(['quick', 'token']);
// 还没探过公网时 lastProbe 的占位（at === 0 = 还没检查；管理接口的 lastProbe 永远是对象）
export const NO_PROBE = Object.freeze({ at: 0, ok: false, ms: 0, error: '' });

// ── 纯函数（单测覆盖）───────────────────────────────────────────────────────────

// 从粘贴内容里取出隧道令牌：Cloudflare 控制台给的往往是整条命令（cloudflared service install eyJ… /
// cloudflared tunnel run --token eyJ…），令牌本体是 base64 的 JSON，以 eyJ 开头。只给了令牌本体也收。
export function extractTunnelToken(input) {
  const s = String(input || '').trim();
  const m = /eyJ[A-Za-z0-9+/=_-]{40,}/.exec(s);
  if (m) return m[0];
  return /^[A-Za-z0-9+/=_-]{40,}$/.test(s) ? s : '';
}

// 对外地址只留 scheme://host[:port]；没写协议补 https://。不是 http(s) 的、解析不了的回 null，空串回 ''。
export function normalizeOrigin(input) {
  let s = String(input || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || !u.hostname) return null;
  return u.origin;
}

// cloudflared 输出里的快速隧道地址（api.trycloudflare.com 是申请接口，不是地址）。
export function parseQuickUrl(line) {
  const m = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i.exec(String(line || ''));
  return m ? m[0].toLowerCase() : '';
}

// 命名隧道（远端托管配置）连上后，cloudflared 会打一行 Updated to new configuration config="{\"ingress\":[{\"hostname\":…
// 取第一个不是通配的主机名当对外地址（用户没手填时用）。
export function parseIngressHost(line) {
  const s = String(line || '');
  if (!/ingress/i.test(s)) return '';
  const re = /\\?"hostname\\?"\s*:\s*\\?"([a-z0-9.-]+)\\?"/gi;
  let m;
  while ((m = re.exec(s))) { if (m[1] && !m[1].startsWith('*')) return m[1].toLowerCase(); }
  return '';
}

// 一行输出像哪种致命 / 常见错误 → 人话提示（没认出来回 ''）。
export function classifyCfLine(line) {
  const s = String(line || '');
  if (/Provided Tunnel token is not valid|invalid tunnel secret|Unauthorized: Invalid tunnel|tunnel credentials.*invalid/i.test(s)) return 'badToken';
  if (/failed to request quick Tunnel|error code: 1015|Too Many Requests/i.test(s)) return 'quickRequest';
  if (/no free edge addresses|failed to dial|Failed to dial a quic|TLS handshake|edge discovery|Unable to establish connection with Cloudflare edge|connection refused.*7844/i.test(s)) return 'edge';
  if (/Use `cloudflared tunnel run` to start tunnel/i.test(s)) return 'configFile';
  return '';
}

// 公网探活失败 → 人话（error 字段）。
export function describeProbeError(e) {
  if (!e) return '';
  if (typeof e === 'number') {
    if (e === 530 || e === 1033) return 'HTTP ' + e + '：Cloudflare 那头找不到在线的隧道';
    if (e === 502 || e === 504) return 'HTTP ' + e + '：入口连不上本机服务';
    return 'HTTP ' + e;
  }
  const code = e?.cause?.code || e?.code || e?.name || '';
  if (code === 'TimeoutError' || code === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT') return '超时';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败';
  if (code === 'ECONNREFUSED') return '连接被拒绝';
  if (code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') return '连接被重置';
  if (/certificate|CERT_|SSL|TLS/i.test(String(code) + ' ' + (e?.cause?.message || e?.message || ''))) return '证书不对';
  return String(e?.cause?.message || e?.message || code || e).slice(0, 160);
}

// 文案模板：hint 里的人话都过它，英文字典（web/src/i18n/en/admin-console.js）按同样的模板键翻译。
const fmt = (s, p = {}) => s.replace(/\{(\w+)\}/g, (_, k) => (p[k] != null ? String(p[k]) : ''));

// ── 进程与网络小工具 ─────────────────────────────────────────────────────────────

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
  });
}

// 回环 HTTP 探针：node:http 直连，不走出站代理（全局 fetch 被 net-proxy 挂了代理）。2xx 才算通。
function loopbackProbe(url, timeoutMs) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => { res.resume(); resolve(res.statusCode >= 200 && res.statusCode < 300); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

// 端口是否「确实没人听」：只有 ECONNREFUSED 才算。host 跟着服务端的监听地址走（见 createPublicAccess 的 localHost）。
function portRefused(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (v) => { sock.destroy(); resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(false));
    sock.on('timeout', () => done(false));
    sock.on('error', (e) => done(e && e.code === 'ECONNREFUSED'));
  });
}

function execText(cmd, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') }));
    } catch { resolve({ ok: false, out: '' }); }
  });
}

// 这个 pid 是不是一个 cloudflared（收上一条命的遗孤前核对，免得 pid 被复用后误杀别的进程）。
async function pidIsCloudflared(pid, platform) {
  try { process.kill(pid, 0); } catch { return false; }
  if (platform === 'linux') {
    try { return /cloudflared/i.test(readFileSync(`/proc/${pid}/cmdline`, 'utf8')); } catch { return false; }
  }
  if (platform === 'win32') {
    const r = await execText('tasklist.exe', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    return r.ok && /cloudflared/i.test(r.out);
  }
  const r = await execText('ps', ['-p', String(pid), '-o', 'comm=']);
  return r.ok && /cloudflared/i.test(r.out);
}

const hhmmss = (t = Date.now()) => new Date(t).toISOString().slice(11, 19);

// ── 管理器 ───────────────────────────────────────────────────────────────────────

const DEFAULT_TIMING = {
  checkMs: 45_000,          // 平时探活间隔
  fastCheckMs: 8_000,       // 刚起 / 有问题时的探活间隔
  probeMs: 8_000,           // 回环探针超时
  publicProbeMs: 15_000,    // 公网探针超时
  failsToAct: 3,            // /ready 连续失败几次才重启
  quickPublicFails: 6,      // 快速隧道：/ready 正常、但 Cloudflare 边缘连续几次明确回「找不到这条隧道」（530），才换一个地址
  cooldownMs: 180_000,      // 两次看门狗重启之间至少隔多久
  graceMs: { quick: 120_000, token: 60_000 },   // 刚起的隧道多久内不算失败（快速隧道的新域名要一会儿才解析得到）
  switchWaitMs: { quick: 90_000, token: 60_000 }, // 先接后拆：等新隧道连上的上限
  announceMs: 15_000,       // 先接后拆且地址要变：新隧道连上后先经旧隧道把新地址推给在线设备，再留这么久才拆旧的（S1-1）
  backoff: [2_000, 5_000, 15_000, 30_000, 60_000, 120_000],
  badTokenBackoffMs: 600_000,
  stableMs: 300_000,        // 跑满这么久才把退避清零
  downloadRetryMs: 3_600_000,
  logLines: 200,
};

/**
 * @param {object} o
 * @param {string} o.dataRoot         数据根（public-access.json、pid 文件、下载的 cloudflared）
 * @param {string} o.programRoot      程序根（检测维护者的个人脚本）
 * @param {number} o.port             本服务端口
 * @param {string} [o.localTarget]    快速隧道转发到哪（默认 http://127.0.0.1:<port>）
 * @param {boolean} [o.noAuth]        NO_AUTH 调试实例：一律不许挂公网
 * @param {(url: string|null) => void} [o.setOrigin]  运行态对外地址（null = 恢复配置里的）
 * @param {(ev: object) => void} [o.publish]          状态变化推给管理员（总线）
 */
export function createPublicAccess(o) {
  const platform = o.platform || process.platform;
  const arch = o.arch || process.arch;
  const T = { ...DEFAULT_TIMING, ...(o.timing || {}) };
  const port = Number(o.port) || 8787;
  const localTarget = o.localTarget || `http://127.0.0.1:${port}`;
  // 看门狗判「本机端口通不通」连哪：跟 localTarget 同一个地址——BRIDGE_HOST 听的是某个具体地址时 127.0.0.1 上没人，
  // 连回环只会恒拒连、让看门狗永远以为「问题不在隧道」；通配地址还是连回环。
  const localHost = (() => {
    let h = '';
    try { h = new URL(localTarget).hostname.replace(/^\[|\]$/g, ''); } catch {}
    return !h || h === '0.0.0.0' || h === '::' ? '127.0.0.1' : h;
  })();
  const FILE = path.join(o.dataRoot, 'public-access.json');
  const PID_FILE = path.join(o.dataRoot, 'public-access.pid');
  const BIN_DIR = path.join(o.dataRoot, '.bin', 'cloudflared-' + CF_VERSION);
  const BIN_NAME = platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  // 自己的空配置：别让 cloudflared 去读用户 ~/.cloudflared/config.yml——里面要是有 tunnel: 字段，快速隧道会直接
  // 拒绝启动（「Use `cloudflared tunnel run` to start tunnel …」），命名隧道也可能吃到不相干的 ingress。
  const CF_CONFIG = path.join(o.dataRoot, '.bin', 'cloudflared-bridge-empty.yml');
  const doFetch = o.fetch || ((...a) => globalThis.fetch(...a));
  const doSpawn = o.spawn || spawn;
  const isOurs = o.isOurProcess || ((pid) => pidIsCloudflared(pid, platform));
  const setOrigin = o.setOrigin || (() => {});
  const publish = o.publish || (() => {});
  const say = o.log || ((m) => console.log('[public] ' + m));

  // 维护者的个人隧道托管（只看程序根，测试实例 / worktree 一样认）：在位就锁住，不另起隧道。
  function detectExternal() {
    if (o.external !== undefined) return o.external;
    const pr = o.programRoot;
    if (pr && platform === 'win32' && existsSync(path.join(pr, 'admin.ps1'))
      && (existsSync(path.join(pr, 'task-tunnel.vbs')) || existsSync(path.join(pr, 'cloudflared-bridge.yml')))) {
      return { kind: 'script', locked: true, label: '本机脚本（admin.ps1 / task-tunnel.vbs）' };
    }
    if (platform === 'linux') {
      if (existsSync('/etc/systemd/system/muse-tunnel.service')) return { kind: 'service', locked: true, label: '系统服务 muse-tunnel' };
      if (existsSync('/etc/systemd/system/bridge-tunnel.service')) return { kind: 'service', locked: false, label: '系统服务 bridge-tunnel' };
    }
    return null;
  }

  let cfg = { mode: 'off', token: '', url: '' };
  const st = {
    status: 'stopped', url: '', lastProbe: null, since: 0, restarts: 0, error: '', errorKind: '',
    cf: { available: false, version: '', path: '', downloading: false, progress: 0, error: '' },
    external: null,
  };
  const ring = [];
  let cur = null;              // 当前隧道（Tunnel）
  let pending = null;          // 先接后拆时正在等它连上的新隧道（还没转正；dispose 与 pid 文件都要算上它）
  let switching = false;       // 先接后拆进行中：旧隧道这时退出不按退避重拉，startCur 一律让路（否则会按刚改好的配置另起一条没人跟踪的）
  let backoffIdx = 0;
  let restartTimer = null;
  let checkTimer = null;
  let readyFails = 0, pubFails = 0, lastWatchdogRestart = 0;
  let downloadP = null, lastDownloadFail = 0;
  let op = Promise.resolve();  // apply / restart 串行
  let disposed = false;
  let lastPublished = '';
  let started = false;

  const note = (line) => {
    for (const ln of String(line).split(/\r?\n/)) {
      if (!ln.trim()) continue;
      let s = ln;
      if (cfg.token && s.includes(cfg.token)) s = s.split(cfg.token).join('***');   // 万一 cloudflared 把令牌打出来
      ring.push(s.slice(0, 600));
    }
    if (ring.length > T.logLines) ring.splice(0, ring.length - T.logLines);
  };
  const event = (msg) => { note(`${hhmmss()} [bridge] ${msg}`); say(msg); };

  // —— 配置读写 ——
  function load() {
    try {
      const raw = JSON.parse(readFileSync(FILE, 'utf8').replace(/^﻿/, ''));
      cfg = {
        mode: MODES.includes(raw.mode) ? raw.mode : 'off',
        token: typeof raw.token === 'string' ? raw.token : '',
        url: typeof raw.url === 'string' ? (normalizeOrigin(raw.url) || '') : '',
      };
    } catch { cfg = { mode: 'off', token: '', url: '' }; }
  }
  function save() {
    mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify({ ...cfg, updatedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    renameSync(tmp, FILE);
    try { chmodSync(FILE, 0o600); } catch {}
  }

  // —— cloudflared 二进制 ——
  function resolveBinary() {
    const explicit = String(process.env.BRIDGE_CLOUDFLARED || o.binOverride || '').trim();
    if (explicit) return existsSync(explicit) ? explicit : null;
    const onPath = (o.which || whichSync)('cloudflared');
    if (onPath) return onPath;
    const mine = path.join(BIN_DIR, BIN_NAME);
    return existsSync(mine) ? mine : null;
  }
  async function detectVersion(bin) {
    if (o.binArgsPrefix) { st.cf.version = 'test'; return; }
    const r = await execText(bin, ['--version'], 10_000);
    const m = /version\s+(\S+)/i.exec(r.out);
    st.cf.version = m ? m[1] : '';
  }
  async function ensureBinary({ download = true } = {}) {
    const found = resolveBinary();
    if (found) {
      const changed = st.cf.path !== found;
      st.cf.available = true; st.cf.path = found; st.cf.error = '';
      if (changed || !st.cf.version) await detectVersion(found);
      return found;
    }
    st.cf.available = false; st.cf.path = ''; st.cf.version = '';
    if (!download) return null;
    return downloadBinary();
  }
  function downloadBinary() {
    if (downloadP) return downloadP;
    downloadP = (async () => {
      const asset = o.asset || cfAsset(platform, arch);   // o.asset：测试注入
      if (!asset) {
        st.cf.error = fmt('这个系统（{platform}/{arch}）没有可自动下载的 cloudflared，请自己安装 cloudflared（放进 PATH）后点「重新启动」', { platform, arch });
        return null;
      }
      const url = o.downloadUrl || cfDownloadUrl(asset);
      st.cf.downloading = true; st.cf.progress = 0; st.cf.error = '';
      refreshStatus();
      event(`下载 cloudflared ${CF_VERSION}：${url}`);
      mkdirSync(BIN_DIR, { recursive: true });
      const part = path.join(BIN_DIR, BIN_NAME + '.partial');
      const ac = new AbortController();
      const overall = setTimeout(() => ac.abort(new Error('下载超过 15 分钟')), 15 * 60_000);
      let stall = null;
      const kick = () => { clearTimeout(stall); stall = setTimeout(() => ac.abort(new Error('60 秒没有收到数据')), 60_000); };
      try {
        const res = await doFetch(url, { signal: ac.signal, redirect: 'follow' });
        if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
        const hash = createHash('sha256');
        let got = 0;
        kick();
        // 边下边算哈希；pipeline 出错时把两头都销毁，Windows 上 .partial 才删得掉
        const meter = new Transform({
          transform(chunk, _enc, cb) {
            got += chunk.length; hash.update(chunk); kick();
            st.cf.progress = Math.min(99, Math.floor((got / asset.size) * 100));
            cb(null, chunk);
          },
        });
        await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(part), { signal: ac.signal });
        if (got !== asset.size) throw new Error(fmt('大小不对（应为 {want} 字节，下到 {got} 字节）', { want: asset.size, got }));
        const sha = hash.digest('hex');
        if (sha !== asset.sha256) throw new Error('SHA-256 校验不对（文件可能被代理改写或下载不完整），已丢弃');
        const final = path.join(BIN_DIR, BIN_NAME);
        for (let i = 0; ; i++) {   // Windows 上杀毒软件刚扫完可能还占着文件，改名稍等重试
          try { rmSync(final, { force: true }); renameSync(part, final); break; }
          catch (e) { if (i >= 5) throw e; await new Promise((r) => setTimeout(r, 500)); }
        }
        if (platform !== 'win32') chmodSync(final, 0o755);
        st.cf.progress = 100;
        event(`cloudflared ${CF_VERSION} 已下载并校验通过：${final}`);
        st.cf.available = true; st.cf.path = final; st.cf.version = CF_VERSION;
        return final;
      } catch (e) {
        rmSync(part, { force: true });
        lastDownloadFail = Date.now();
        const why = describeProbeError(ac.signal.aborted ? ac.signal.reason : e);
        st.cf.error = fmt('下载 cloudflared 失败：{error}。可以自己安装 cloudflared（放进 PATH，或放到 {dir}）后点「重新启动」', { error: why, dir: path.join(BIN_DIR, BIN_NAME) });
        event('下载 cloudflared 失败：' + why);
        return null;
      } finally {
        clearTimeout(overall); clearTimeout(stall);
        st.cf.downloading = false;
        downloadP = null;
        refreshStatus();
      }
    })();
    return downloadP;
  }

  // —— 一条隧道 = 一个 cloudflared 进程 ——
  class Tunnel {
    constructor(mode, token) {
      this.mode = mode; this.token = token;
      this.proc = null; this.metricsPort = 0; this.url = ''; this.host = '';
      this.startedAt = 0; this.exited = false; this.exitCode = null; this.errKind = ''; this.stopping = false;
      this.lastReady = null;   // 最近一次 /ready 探针（null = 还没探过）
      this.onExit = null;
    }
    async start(bin) {
      this.metricsPort = await freePort();
      if (!existsSync(CF_CONFIG)) { mkdirSync(path.dirname(CF_CONFIG), { recursive: true }); writeFileSync(CF_CONFIG, '# bridge 托管的 cloudflared 用的空配置（见 src/runtime/public-access.mjs）\n{}\n'); }
      const args = ['tunnel', '--no-autoupdate', '--config', CF_CONFIG, '--metrics', `127.0.0.1:${this.metricsPort}`, '--protocol', 'http2'];
      if (this.mode === 'quick') args.push('--url', localTarget);
      else args.push('run');
      const env = { ...process.env };
      delete env.TUNNEL_TOKEN;
      if (this.mode === 'token') env.TUNNEL_TOKEN = this.token;
      const argv = [...(o.binArgsPrefix || []), ...args];
      event(`启动 cloudflared（${this.mode === 'quick' ? '快速隧道' : '命名隧道'}）`);
      this.startedAt = Date.now();
      let proc;
      try { proc = doSpawn(bin, argv, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
      catch (e) { this.exited = true; this.errKind = 'spawn'; event('起不来：' + (e?.message || e)); return false; }
      this.proc = proc;
      const onLine = (ln) => {
        note(ln);
        const q = this.mode === 'quick' ? parseQuickUrl(ln) : '';
        if (q && q !== this.url) { this.url = q; onTunnelUrl(this); }
        const h = this.mode === 'token' ? parseIngressHost(ln) : '';
        if (h && h !== this.host) { this.host = h; onTunnelUrl(this); }
        const k = classifyCfLine(ln);
        if (k) this.errKind = k;
      };
      for (const s of [proc.stdout, proc.stderr]) {
        if (!s) continue;
        let buf = '';
        s.setEncoding('utf8');
        s.on('data', (d) => {
          buf += d;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, '')); buf = buf.slice(i + 1); }
          if (buf.length > 8192) { onLine(buf); buf = ''; }
        });
      }
      // 'exit' 与 spawn 失败（ENOENT 之类只有 'error'、不一定有 'exit'）都走这里，只收一次
      const finish = (why) => {
        if (this.exited) return;
        this.exited = true;
        event(`cloudflared 已退出（${why}）`);
        syncPid();
        const cb = this.onExit; this.onExit = null;
        if (cb) cb(this);
      };
      proc.on('error', (e) => {
        event('cloudflared 出错：' + (e?.message || e));
        if (!proc.pid) { this.errKind = 'spawn'; finish('没能启动'); }
      });
      proc.on('exit', (code, sig) => { this.exitCode = code; finish(sig || '退出码 ' + code); });
      return true;
    }
    alive() { return !!this.proc && !this.exited; }
    stop() {
      this.stopping = true;
      this.onExit = null;
      if (this.alive()) { try { this.proc.kill(); } catch {} }
    }
    ready() { return this.alive() && this.metricsPort ? loopbackProbe(`http://127.0.0.1:${this.metricsPort}/ready`, T.probeMs) : Promise.resolve(false); }
    // 等它连上 Cloudflare（/ready 通；快速隧道还要拿到地址）。
    async waitConnected(ms) {
      const until = Date.now() + ms;
      while (Date.now() < until) {
        if (!this.alive()) return false;
        if ((await this.ready()) && (this.mode !== 'quick' || this.url)) return true;
        await new Promise((r) => setTimeout(r, 1000));
      }
      return false;
    }
  }

  // pid 文件记下所有在跑的托管 cloudflared：当前的 + 先接后拆时正在等的那条（闪退时两条都可能留下）。
  function syncPid() {
    const pids = [cur, pending].filter((t) => t && t.alive() && t.proc && t.proc.pid).map((t) => t.proc.pid);
    try {
      if (pids.length) writeFileSync(PID_FILE, JSON.stringify({ pid: pids[0], pids, at: Date.now() }));
      else rmSync(PID_FILE, { force: true });
    } catch {}
  }
  // 上一条命闪退（TerminateProcess / fail-fast 不跑 exit 回调）留下的 cloudflared：核对是 cloudflared 才收。
  async function reapOrphan() {
    let rec = null;
    try { rec = JSON.parse(readFileSync(PID_FILE, 'utf8')); } catch { return; }
    const pids = Array.isArray(rec && rec.pids) ? rec.pids : [rec && rec.pid];
    for (const pid of new Set(pids.map(Number))) {
      if (pid && pid !== process.pid && (await isOurs(pid))) {
        try { process.kill(pid); event(`收掉上一次留下的 cloudflared（pid ${pid}）`); } catch {}
      }
    }
    syncPid();
  }

  // —— 地址 ——
  const tunnelUrl = (t) => (t ? (t.mode === 'quick' ? t.url : (cfg.url || (t.host ? 'https://' + t.host : ''))) : '');
  function effectiveUrl() {
    if (cfg.mode === 'manual') return cfg.url;
    if (TUNNEL_MODES.has(cfg.mode)) return tunnelUrl(cur);
    return '';
  }
  // 隧道归外部托管且锁住（维护者的本机脚本、muse-tunnel）：这里存的任何方式都不生效，连手填的对外地址也不覆盖运行态的 PUBLIC_ORIGIN
  const extLocked = () => !!(st.external && st.external.locked);
  function applyOrigin() {
    const u = cfg.mode === 'off' || extLocked() ? '' : effectiveUrl();
    st.url = u;
    try { setOrigin(u || null); } catch {}
  }
  function onTunnelUrl(t) {
    if (t !== cur) return;   // 先接后拆期间的新隧道：等它转正再生效
    const before = st.url;
    applyOrigin();
    if (st.url && st.url !== before) {
      event(t.mode === 'quick' ? `临时地址：${st.url}` : `对外地址：${st.url}`);
      pubFails = 0;
      refreshStatus(true);
    }
  }

  // —— 状态 ——
  // 对外报告的模式：NO_AUTH 恒 off；隧道归外部托管且锁住时，配置里写着什么都按 off 报（不起隧道、也不用手填的对外地址）。
  function effectiveMode() {
    if (o.noAuth) return 'off';
    if (extLocked()) return 'off';
    return cfg.mode;
  }
  function computeHint() {
    const ext = st.external;
    if (o.noAuth) return '这是不带访问令牌的本机调试实例，不能开公网访问。';
    if (ext && ext.locked) return fmt('这台机器的隧道由{label}托管，这里不再另起隧道。', { label: ext.label });
    if (st.cf.downloading) return fmt('正在下载 cloudflared {version}（{pct}%）…', { version: CF_VERSION, pct: st.cf.progress });
    const m = cfg.mode;
    if (m === 'off') {
      return ext ? fmt('没有在这里开公网访问。这台机器另有{label}在托管隧道。', { label: ext.label })
        : '没有开公网访问：只能在这台机器上或同一局域网里打开。要在外面用手机访问，选一种方式打开。';
    }
    if (TUNNEL_MODES.has(m) && !st.cf.available) return st.cf.error || '缺少 cloudflared。';
    if (m === 'manual') {
      if (!cfg.url) return fmt('填上你的对外地址（反向代理或域名指向本机 {port} 端口）。', { port });
      if (st.lastProbe && !st.lastProbe.ok) return fmt('打不开 {url}：检查反向代理是否把请求转到本机 {port} 端口，域名解析和证书是否正确。', { url: cfg.url, port });
      return '由你自己的反向代理 / 域名对外提供访问，这里只定时检查这个地址能不能打开。';
    }
    const k = st.errorKind;
    if (k === 'badToken') return '隧道令牌无效：到 Cloudflare 控制台重新复制这条隧道的令牌，粘贴后保存。';
    if (k === 'quickRequest' && !st.url) return '向 Cloudflare 申请临时地址失败（限流或连不上 Cloudflare），会自动重试；一直不行就换成自己的域名（命名隧道）。';
    if (k === 'edge' && st.status !== 'running') return '连不上 Cloudflare 的边缘节点：防火墙挡了出站 7844 端口，或代理软件的 fake-ip 劫持了 DNS（把 cloudflared 设成直连）。';
    if (st.status === 'starting') return m === 'quick' ? '正在向 Cloudflare 申请临时地址（通常 10–30 秒）…' : '正在连接 Cloudflare 命名隧道…';
    if (m === 'quick') {
      if (st.status === 'error') return '快速隧道没有连上，正在自动重试。';
      // 本机探不通 ≠ 外面打不开（看门狗也不因此换地址，见文件头）：别让徽标写着「已连通」、用户却不知道探活那行为什么红
      if (st.url && st.lastProbe && !st.lastProbe.ok) return fmt('从这台机器经公网打不开 {url}（{error}）。本机开着代理软件（fake-ip / TUN）或 DNS 还没更新时常见这种情况，外面的设备一般照样能打开，可以用手机流量试一下。地址只在 Cloudflare 明确说找不到这条隧道时才会自动更换。', { url: st.url, error: st.lastProbe.error });
      return '临时地址只适合试用：免注册即可用，但服务端或隧道每次重启都会换一个新地址。连过的手机 App 会自动换到新地址（在线时立即收到推送；离线时回家连上同一个 Wi-Fi 就会更新），网页和分享出去的链接要手动改。长期使用建议绑定自己的域名（命名隧道）。';
    }
    if (!st.url) return fmt('已连上 Cloudflare，但还不知道对外地址：在 Cloudflare 控制台给这条隧道加一个 Public Hostname（服务填 http://localhost:{port}），或在这里填上对外地址。', { port });
    if (st.lastProbe && !st.lastProbe.ok && st.status !== 'starting') return fmt('隧道已连上 Cloudflare，但经公网打不开 {url}：检查 Cloudflare 控制台里这条隧道的 Public Hostname 是否指向 http://localhost:{port}。', { url: st.url, port });
    return fmt('已连上 Cloudflare。对外地址在 Cloudflare 控制台这条隧道的 Public Hostname 里配置，服务地址填 http://localhost:{port}。', { port });
  }
  function refreshStatus(force = false) {
    let s = 'stopped';
    const m = effectiveMode();
    if (m === 'off') s = 'stopped';
    else if (m === 'manual') s = !cfg.url ? 'error' : !st.lastProbe ? 'starting' : st.lastProbe.ok ? 'running' : 'error';
    else if (st.cf.downloading) s = 'starting';
    else if (!st.cf.available && !cur) s = 'error';
    else if (!cur || !cur.alive()) s = st.errorKind === 'badToken' || st.errorKind === 'spawn' ? 'error' : (restartTimer || switching ? 'starting' : 'error');
    else {
      const inGrace = Date.now() - cur.startedAt < (T.graceMs[m] ?? 60_000);
      const readyOk = readyFails === 0 && cur.lastReady === true;
      if (readyOk && (m === 'token' || st.url)) s = 'running';
      else s = inGrace || cur.lastReady == null ? 'starting' : 'error';
    }
    st.status = s;
    const sig = [m, s, st.url, st.cf.downloading, st.errorKind].join('|');
    if (force || sig !== lastPublished) {
      lastPublished = sig;
      try { publish({ type: 'public-access', mode: m, status: s, url: st.url }); } catch {}
    }
  }

  // —— 起停 ——
  function clearRestartTimer() { if (restartTimer) clearTimeout(restartTimer); restartTimer = null; }
  function stopCur() {
    clearRestartTimer();
    if (cur) { cur.stop(); cur = null; }
    syncPid();
    readyFails = 0; pubFails = 0;
  }
  function scheduleRetry(delay) {
    clearRestartTimer();
    restartTimer = setTimeout(() => { restartTimer = null; if (!disposed && TUNNEL_MODES.has(cfg.mode)) startCur().catch(() => {}); }, delay);
    restartTimer.unref?.();
  }
  function onCurExit(t) {
    if (t !== cur || disposed) return;
    const ranMs = Date.now() - t.startedAt;
    if (ranMs > T.stableMs) backoffIdx = 0;
    st.errorKind = t.errKind || st.errorKind;
    cur = null;
    const delay = st.errorKind === 'badToken' ? T.badTokenBackoffMs : T.backoff[Math.min(backoffIdx, T.backoff.length - 1)];
    backoffIdx++;
    st.restarts++;
    event(`${Math.round(delay / 1000)} 秒后重新拉起 cloudflared`);
    scheduleRetry(delay);
    applyOrigin();
    refreshStatus();
  }
  // 起一条新隧道（不动当前的）；起不来回 null。
  async function spawnTunnel(mode, token) {
    const bin = await ensureBinary({ download: Date.now() - lastDownloadFail > T.downloadRetryMs || !lastDownloadFail });
    if (!bin) { refreshStatus(); return null; }
    const t = new Tunnel(mode, token);
    const ok = await t.start(bin);
    if (!ok) { st.errorKind = t.errKind || 'spawn'; return null; }
    return t;
  }
  function adopt(t) {
    cur = t;
    t.onExit = onCurExit;
    syncPid();
    st.since = t.startedAt;
    readyFails = 0; pubFails = 0;
    applyOrigin();
    scheduleCheck(T.fastCheckMs);
  }
  async function startCur() {
    if (disposed || switching || !TUNNEL_MODES.has(cfg.mode) || cur) return;
    if (cfg.mode === 'token' && !cfg.token) return;
    st.errorKind = '';
    const t = await spawnTunnel(cfg.mode, cfg.token);
    if (!t) {
      if (disposed || switching) return;   // 先接后拆接手了，重试归它管
      // 二进制没有（下载失败）/ spawn 失败：按退避再试，下载失败一小时内不重下
      st.restarts++;
      scheduleRetry(T.backoff[Math.min(backoffIdx++, T.backoff.length - 1)] * (st.cf.available ? 1 : 30));
      refreshStatus();
      return;
    }
    // 下载 / 起进程期间模式可能已经改了（关掉了、换了别的隧道 / 令牌、正在先接后拆）：这条就不要了
    if (disposed || switching || cfg.mode !== t.mode || (t.mode === 'token' && t.token !== cfg.token) || cur) { t.stop(); return; }
    if (t.exited) { cur = t; onCurExit(t); return; }
    adopt(t);
    refreshStatus();
  }

  // 先接后拆：新隧道连上 Cloudflare 了才拆旧的；新的起不来就保留旧的。
  // 地址要变（快速隧道重启、快速隧道 → 命名隧道）时，新的连上后先发一条 {type:'public-access.next', url}（server.mjs 转成
  // 给所有在线设备的 server.address 推送），旧隧道再留 announceMs：经旧地址连着的手机 / 客户端在断开之前就拿到了新地址（S1-1）。
  async function switchTo(mode, token) {
    const old = cur;
    if (!old || !old.alive()) {
      stopCur();
      backoffIdx = 0;
      // 本机还没有 cloudflared 要先下载（几十 MB）：不让请求干等，后台下、状态里看进度
      if (resolveBinary()) await startCur();
      else startCur().catch(() => {});
      return { ok: true };
    }
    clearRestartTimer();
    // 等新隧道的这阵子（最多一分半）旧的要是自己退出了：只记一笔、不按退避重拉——重拉会按调用方刚改好的新配置
    // 另起一条，被 adopt 之后又被这里的 next 顶掉，变成没人跟踪的孤儿；startCur 也在 switching 期间一律让路。
    switching = true;
    let oldDied = false;
    old.onExit = (t) => { oldDied = true; if (t === cur) { cur = null; syncPid(); refreshStatus(); } };
    let next = null, ok = false;
    try {
      next = await spawnTunnel(mode, token);
      if (next) {
        pending = next; syncPid();
        if (!disposed) ok = await next.waitConnected(T.switchWaitMs[mode] || 60_000);
        // 新的连上了、地址要变、旧的还活着：先把新地址推出去，留一会儿再拆（等待期间 dispose 照样收掉在等的这条）
        const nextUrl = ok ? tunnelUrl(next) : '';
        if (nextUrl && nextUrl !== st.url && !oldDied && old.alive() && !disposed && T.announceMs > 0) {
          event(`新地址已连上：${nextUrl}，先通知在线设备，${Math.round(T.announceMs / 1000)} 秒后停用旧地址`);
          try { publish({ type: 'public-access.next', mode, url: nextUrl, from: st.url }); } catch {}
          const until = Date.now() + T.announceMs;
          while (!disposed && Date.now() < until && next.alive()) await new Promise((r) => setTimeout(r, Math.min(250, Math.max(10, until - Date.now()))));
          if (!next.alive()) ok = false;   // 等的时候新的自己退了：按没连上处理，保留旧的
        }
      }
    } finally {
      switching = false;
      pending = null;
    }
    if (disposed) { if (next) next.stop(); syncPid(); return { error: '服务端正在退出' }; }
    if (!ok) {
      const kind = next ? next.errKind : '';
      if (next) next.stop();
      // 新的没接上：旧的还活着就交还给看门狗与退避重拉（keepOld = 调用方把配置退回去）；
      // 旧的也在这期间退了，就按退回去的旧配置退避重拉（定时器触发时调用方早已退回配置）
      if (!oldDied && old.alive()) { cur = old; old.onExit = onCurExit; syncPid(); }
      else { if (cur === old) cur = null; st.restarts++; scheduleRetry(T.backoff[0]); }
      event(oldDied ? '新隧道没连上，原来的隧道也意外退出了，按原来的设置重新拉起' : '新隧道没连上，保留原来的隧道');
      if (!next) return { error: st.cf.error || (oldDied ? '起不来新的隧道，原来的隧道也意外退出了，正在按原来的设置重新拉起' : '起不来新的隧道，原来的隧道照常在跑'), keepOld: true };
      if (oldDied) return { error: '新隧道在限定时间内没连上 Cloudflare，原来的隧道也意外退出了，正在按原来的设置重新拉起（看下面的日志）', keepOld: true };
      return { error: kind === 'badToken' ? '隧道令牌无效，原来的隧道照常在跑' : '新隧道在限定时间内没连上 Cloudflare，原来的隧道照常在跑（看下面的日志）', keepOld: true };
    }
    // 转正：只留 next。旧的、以及万一混进来的别的隧道（兜底，按上面的让路规则不该有）一并收掉
    if (cur && cur !== next) cur.stop();
    if (old !== next && old.alive()) old.stop();
    cur = null;
    backoffIdx = 0;
    adopt(next);
    return { ok: true };
  }

  // —— 看门狗 ——
  function scheduleCheck(ms) {
    if (checkTimer) clearTimeout(checkTimer);
    if (disposed) return;
    checkTimer = setTimeout(() => { checkTimer = null; tick().catch(() => {}).finally(() => scheduleCheck(nextCheckMs())); }, ms);
    checkTimer.unref?.();
  }
  const nextCheckMs = () => (st.status === 'running' ? T.checkMs : T.fastCheckMs);
  async function probePublic(url) {
    const t0 = Date.now();
    try {
      const res = await doFetch(url.replace(/\/+$/, '') + '/healthz', {
        signal: AbortSignal.timeout(T.publicProbeMs), redirect: 'manual', cache: 'no-store',
        headers: { 'user-agent': 'bridge-public-access-probe' },
      });
      try { await res.arrayBuffer(); } catch {}
      const ok = res.status === 200;
      return { at: Date.now(), ok, ms: Date.now() - t0, error: ok ? '' : describeProbeError(res.status), code: res.status };
    } catch (e) {
      return { at: Date.now(), ok: false, ms: Date.now() - t0, error: describeProbeError(e), code: 0 };
    }
  }
  // 对外的 lastProbe 只留契约里的 {at,ok,ms,error}
  const keepProbe = ({ at, ok, ms, error }) => ({ at, ok, ms, error });
  async function tick() {
    if (disposed) return;
    const m = cfg.mode;
    if (m === 'off' || o.noAuth || extLocked()) return;
    const now = Date.now();
    if (m === 'manual') {
      if (cfg.url) st.lastProbe = keepProbe(await probePublic(cfg.url));
      refreshStatus();
      return;
    }
    const t = cur;
    if (!t || !t.alive()) { refreshStatus(); return; }
    const inGrace = now - t.startedAt < (T.graceMs[m] ?? 60_000);
    // 宽限期内只看 /ready、不打公网探针：快速隧道的新域名要一会儿才解析得到，这时去探只会让系统 DNS 把「不存在」
    // 缓存下来（Windows 负缓存最长 15 分钟），之后好一阵本机都探不通。宽限期过了两个探针一起打、一起落。
    const url = inGrace ? '' : st.url;
    const [ready, probe] = await Promise.all([t.ready(), url ? probePublic(url) : null]);
    t.lastReady = ready;
    if (probe) st.lastProbe = keepProbe(probe);
    if (t !== cur) return;
    if (!inGrace) {
      readyFails = t.lastReady ? 0 : readyFails + 1;
      // 快速隧道换地址只认 Cloudflare 边缘明确回「找不到这条隧道」（530 / 1033）。超时、解析失败、连接被拒、证书错
      // 这些本机探不通的情况（fake-ip / TUN、回环受限、DNS 负缓存）不计数也不清零，只记进 lastProbe 和提示；
      // 探通了、或回了别的状态码（边缘认得这条隧道）才清零。
      if (!probe || probe.ok || (probe.code && probe.code !== 530 && probe.code !== 1033)) pubFails = 0;
      else if (probe.code === 530 || probe.code === 1033) pubFails++;
      const wantRestart = readyFails >= T.failsToAct || (m === 'quick' && t.lastReady && pubFails >= T.quickPublicFails);
      if (wantRestart && now - lastWatchdogRestart > T.cooldownMs) {
        // 本机端口自己都连不上：问题不在隧道（也绝不去重启自己），只记一笔
        const localDown = await portRefused(localHost, port, T.probeMs);
        if (localDown) {
          event(`本机 ${port} 端口连不上，问题不在隧道，先不动隧道`);
        } else {
          lastWatchdogRestart = now;
          event(readyFails >= T.failsToAct ? `cloudflared /ready 连续 ${readyFails} 次失败，重启隧道` : `Cloudflare 连续 ${pubFails} 次回「找不到这条隧道」，换一个临时地址`);
          st.restarts++;
          // 旧的已经坏了（/ready 不通）：直接拆了重起（同 tunnel-watchdog.mjs 的 restart-tunnel），
          // 不走先接后拆——那要等新的连上，边缘不通时会白占着队列等满一分钟
          await enqueue(async () => { if (cur === t) { stopCur(); backoffIdx = 0; await startCur(); } });
        }
      }
    } else if (t.lastReady) {
      readyFails = 0;
    }
    refreshStatus();
  }

  const enqueue = (fn) => { const p = op.then(fn, fn); op = p.catch(() => {}); return p; };

  // —— 对外 API ——
  async function init() {
    if (started) return;
    started = true;
    st.external = detectExternal();
    load();
    if (o.noAuth) { applyOrigin(); refreshStatus(); return; }
    if (extLocked() && cfg.mode !== 'off') {
      event('隧道由' + st.external.label + '托管，' + (TUNNEL_MODES.has(cfg.mode) ? '不启动内置隧道' : '不用这里存的对外地址'));
      applyOrigin(); refreshStatus();
      return;
    }
    await reapOrphan();
    applyOrigin();
    if (TUNNEL_MODES.has(cfg.mode)) startCur().catch(() => {});   // 可能要先下载，不占 apply 的串行队列
    else if (cfg.mode === 'manual') scheduleCheck(2_000);
    refreshStatus();
    // Windows 上 `cloudflared service install` 装过的服务也算外部托管（只提示，不锁）
    if (!st.external && platform === 'win32' && !o.binArgsPrefix) {
      execText('sc.exe', ['query', 'cloudflared'], 5000).then((r) => {
        if (r.ok && /SERVICE_NAME/i.test(r.out) && !st.external) { st.external = { kind: 'winsvc', locked: false, label: 'cloudflared 的 Windows 服务' }; refreshStatus(true); }
      });
    }
  }

  function status() {
    refreshStatus();
    return {
      mode: effectiveMode(),
      status: st.status,
      url: st.url,
      // 契约是对象：还没探过（关着、刚起、宽限期内、刚切模式）给占位，at === 0 表示「还没检查」
      lastProbe: st.lastProbe || { ...NO_PROBE },
      cloudflared: { available: st.cf.available, version: st.cf.version, path: st.cf.path, downloading: st.cf.downloading, progress: st.cf.progress, pinned: CF_VERSION },
      log: ring.slice(-80),
      hint: computeHint(),
      // 以下是契约之外的补充：界面用
      hasToken: !!cfg.token,
      configuredUrl: cfg.url,
      managedBy: st.external ? { kind: st.external.kind, label: st.external.label, locked: !!st.external.locked } : null,
      available: !o.noAuth,
      since: cur ? cur.startedAt : 0,
      restarts: st.restarts,
      port,
    };
  }

  // 远程管理时会不会把自己切断：请求是经这条托管隧道进来的（Host = 隧道地址），而这次操作会关掉它、
  // 或换成一个对方事先不知道的新地址。是就回人话（路由回 409），不是回 ''。本机直连永远放行。
  //   restart：重启这条隧道；server：重启服务端本身（含「检查并更新」完的自动重启）——退出时 cloudflared 跟着收掉，
  //   新进程起来再申请，快速隧道的地址必变；命名隧道还是同一个域名，会自己回来。
  function selfCutReason(body, { host = '', local = false, restart = false, server = false } = {}) {
    if (local) return '';
    const m = cfg.mode;
    if (!TUNNEL_MODES.has(m) || !st.url) return '';
    let curHost = '';
    try { curHost = new URL(st.url).host.toLowerCase(); } catch {}
    const via = String(host || '').toLowerCase();
    if (!curHost || (via !== curHost && via.replace(/:443$/, '') !== curHost)) return '';
    if (server) return m === 'quick' ? '你现在正是经这个临时地址连进来的：服务端一重启（包括更新完的自动重启），快速隧道就会换一个新地址，当前页面会断开且拿不到新地址。请在这台电脑上操作，或先改用自己的域名（Cloudflare 隧道）。' : '';
    const next = restart ? m : String(body?.mode || '');
    const lock = '你现在正是经这条隧道连进来的，这样改会把自己关在门外。请在这台电脑上操作，或先从别的地址（局域网 / 你自己的域名）连进来再改。';
    if (next === 'off' || next === 'manual') return lock;
    if (next === 'quick') return m === 'quick' ? '你现在正是经这个临时地址连进来的，重启快速隧道会换一个新地址，当前页面会断开且拿不到新地址。请在这台电脑上操作。' : lock;
    if (next === 'token' && m === 'quick') {
      // → token 走先接后拆，但新隧道一连上 Cloudflare 旧的快速隧道就拆了：对方得事先知道新地址才回得来。
      // 这次没填、也没存过对外地址（Cloudflare 那边的 Public Hostname 还不知道配没配），拆完手里就没有能用的公网地址了
      const willUrl = body?.url != null ? (normalizeOrigin(body.url) || '') : cfg.url;
      if (!willUrl) return '你现在正是经这个临时地址连进来的：换成 Cloudflare 隧道后临时地址会停用，而这里还不知道新的对外地址。请先在 Cloudflare 控制台给这条隧道加好 Public Hostname，并把那个地址填进「对外地址」再保存；或者到这台电脑上操作。';
    }
    return '';   // → token：先接后拆，连不上不会拆旧的；对外地址是你自己配的域名，事先就知道
  }

  function apply(body = {}) {
    return enqueue(async () => {
      if (o.noAuth) return { error: '这是不带访问令牌的本机调试实例，不能开公网访问' };
      const mode = String(body.mode || '');
      if (!MODES.includes(mode)) return { error: '模式只能是 off / quick / token / manual' };
      const ext = st.external;
      if (ext && ext.locked && TUNNEL_MODES.has(mode)) return { error: fmt('这台机器的隧道由{label}托管，不能再在这里开隧道', { label: ext.label }) };
      // 手填的对外地址也不行：它会持久覆盖运行态的 PUBLIC_ORIGIN（设备拿到的地址、分享 / 快照链接、扫码登录全跟着变）
      if (ext && ext.locked && mode !== 'off') return { error: fmt('这台机器的对外地址由{label}托管，不能在这里改', { label: ext.label }) };
      let token = cfg.token;
      if (body.token != null && String(body.token).trim()) {
        token = extractTunnelToken(body.token);
        if (!token) return { error: '没认出隧道令牌：在 Cloudflare 控制台 Zero Trust → Networks → Tunnels 里复制这条隧道的令牌（eyJ 开头的一长串，整条安装命令粘进来也行）' };
      }
      let url = cfg.url;
      if (body.url != null) {
        const n = normalizeOrigin(body.url);
        if (n === null) return { error: '对外地址不对：要像 https://bridge.example.com 这样' };
        url = n;
      }
      if (mode === 'token' && !token) return { error: '命名隧道要先粘贴隧道令牌' };
      if (mode === 'manual' && !url) return { error: '填上对外地址，例如 https://bridge.example.com' };
      const prev = { ...cfg };
      const tunnelChanged = mode !== prev.mode || (mode === 'token' && token !== prev.token);
      // 令牌与手填地址跨模式保留：关掉 / 换成快速隧道不丢，下次切回命名隧道不用重贴
      cfg = { mode, token, url };
      try { save(); } catch (e) { cfg = prev; return { error: '写不进 public-access.json：' + (e?.message || e) }; }
      st.errorKind = ''; st.lastProbe = mode === prev.mode && mode !== 'manual' ? st.lastProbe : null;
      event(`公网访问：${prev.mode} → ${mode}`);
      if (!TUNNEL_MODES.has(mode)) {
        stopCur();
        applyOrigin();
        if (mode === 'manual') scheduleCheck(500);
        refreshStatus(true);
        return { ok: true };
      }
      if (tunnelChanged || !cur || !cur.alive()) {
        const r = await switchTo(mode, cfg.token);
        if (r.error) {
          // 新的没起来：配置退回去，免得重启后按没验证过的配置起（旧隧道这期间也退了的，退避重拉按退回的旧配置起）
          if (r.keepOld) { cfg = prev; try { save(); } catch {} }
          applyOrigin(); refreshStatus(true);
          return { error: r.error };
        }
      } else {
        applyOrigin();
      }
      refreshStatus(true);
      return { ok: true };
    });
  }

  function restart() {
    return enqueue(async () => {
      if (o.noAuth) return { error: '这是不带访问令牌的本机调试实例，不能开公网访问' };
      const m = cfg.mode;
      if (m === 'off') return { error: '公网访问没开' };
      if (extLocked()) return { error: fmt('这台机器的隧道由{label}托管，不能再在这里开隧道', { label: st.external.label }) };
      lastDownloadFail = 0;   // 手动重启 = 允许马上重新下载
      if (m === 'manual') { st.lastProbe = null; refreshStatus(true); scheduleCheck(200); return { ok: true }; }
      event('手动重启隧道');
      st.errorKind = '';
      const r = await switchTo(m, cfg.token);
      refreshStatus(true);
      return r.error ? { error: r.error } : r;
    });
  }

  function dispose() {
    disposed = true;
    if (checkTimer) clearTimeout(checkTimer);
    if (pending) pending.stop();   // 先接后拆时还在等的那条也收掉
    stopCur();
  }

  return { init, status, apply, restart, dispose, selfCutReason, tick, _state: () => ({ cfg, st, cur }) };
}

// ── 单例（server.mjs 在 listen 之后 init）──────────────────────────────────────────
let singleton = null;
export function initPublicAccess(opts) {
  if (singleton) return singleton;
  singleton = createPublicAccess(opts);
  // 随服务端起停：退出（含控制台重启的 exit 75、SIGTERM 经 lifelog 转成的 exit）时收掉 cloudflared。
  process.on('exit', () => { try { singleton?.dispose(); } catch {} });
  singleton.init().catch((e) => console.error('[public] 初始化失败：' + (e?.message || e)));
  return singleton;
}
export const publicAccess = () => singleton;
