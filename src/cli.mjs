// 服务器上的运维小命令（在程序目录里跑）。
//   源码目录：node src/cli.mjs <命令>（show-token / invite / users 也有 npm run -s 别名）
//   install.sh 装的：sudo bridgectl <命令>（用户级服务：bridgectl <命令>）
//   Docker：docker compose exec bridge node src/cli.mjs <命令>
//
//   access                    这台服务端怎么连：部署形态、给谁用、本机 / 局域网 / 公网地址、令牌与配对的取法
//   pair [--wait] [--once]    手机扫码配对：终端里出一次性二维码 + 8 位配对码（3 分钟、单次，不含主令牌），等到手机连上；
//                             --json 只打印 { url, code, … }；--plain 不带颜色（--invert 浅色背景的终端，--ascii 不认方块字）；
//                             --origin=http://<局域网 IP>:<端口> 没开公网访问时码里放这个地址（Docker 里看不到宿主机的地址）；
//                             码里的地址手机连不上时只打印改法、不干等（确实有别的路能连上就加 --force-wait）
//   show-token                打印管理员访问令牌（网页 / App「用访问令牌登录」填它）
//   token [--hash|--plain]    换一个新的访问令牌（旧的作废、管理员登录全部下线；重启服务端后生效）。
//                             默认沿用现在的存法：只存哈希的仍只存哈希；--hash / --plain 显式改
//   invite [user] [--days=N]  生成一次性普通档邀请码给朋友注册（要先打开「也给别人用」；默认 7 天有效）
//   invite full --ack         完全信任档（旧名 pro）：有命令行，等同管理员——要加 --ack 表示看过这句说明
//   users                     列出已注册账号与未用的邀请码
//
// 凭据：环境变量 BRIDGE_TOKEN，或 --token-stdin 从标准输入读（install.sh 第一次安装时这样把刚生成的令牌交过来，
// 不出现在进程参数里），否则读 config.json 的明文 token；pair 另认 config.json 的主机密钥（只在本机回环有效）。
// 邀请与账号管理走服务端的 /api/admin/*——那组接口只认「本机回环 + admin 令牌 + 没有代理头」，
// 所以这些命令必须在服务器本机上跑，隧道 / 局域网上的请求一律 404（设计如此）。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './runtime/paths.mjs';
import { resolveDeployProfile, describeDeploy } from './config/deploy-profile.mjs';
import { accessUrls, cliPrefix, probe, runPairing, serverInfo, waitHealthy, wantAnsi } from './cli/access.mjs';

const CONFIG_PATH = path.join(DATA_ROOT, 'config.json');
const CLI = cliPrefix();
const readJson = (f) => JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, ''));

function loadConfig() {
  if (!existsSync(CONFIG_PATH)) {
    console.error('找不到 ' + CONFIG_PATH + '——先启动一次服务端，它会自动生成。'
      + (process.env.BRIDGE_DATA_ROOT ? '' : '\n（数据不在程序目录的话，先设 BRIDGE_DATA_ROOT=<数据目录>；install.sh 装的请用 sudo bridgectl。）'));
    process.exit(1);
  }
  try { return readJson(CONFIG_PATH); }
  catch { console.error(CONFIG_PATH + ' 不是合法 JSON。'); process.exit(1); }
}
// 不退出的版本：没有 / 读不了 / 坏 JSON 都回 null（pair --wait 等服务端生成它、token 看现在的存法）
function readConfigSoft() {
  try { return existsSync(CONFIG_PATH) ? readJson(CONFIG_PATH) : null; } catch { return null; }
}

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const [cmd, arg] = argv.filter((a) => !a.startsWith('--'));
const flagValue = (name) => { const a = argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : ''; };

// 档位的显示名（S2-2）：存储值 user / pro；pro 现在叫「完全信任」，管理员还没确认过的标「待确认」
const tierLabel = (r) => (r && r.tier === 'user' ? '普通' : '完全信任' + (r && r.trustPending ? '（待确认）' : ''));
const fmtTime = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false });

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8').trim();
}

// config.json 只存了令牌哈希（tokenHash）时，明文只在生成那一刻显示过——这些命令要从环境变量 / 标准输入拿。
const HASH_ONLY_HINT = 'config.json 只存了访问令牌的哈希（tokenHash），明文只在生成时显示过一次：'
  + '用 BRIDGE_TOKEN=<令牌> 调用，或 --token-stdin 从标准输入给；忘了就 ' + CLI + ' token --hash 重新生成（所有管理员登录会下线，重启服务端后生效）。';

// 只有要读配置的命令才去读（help、token、认不出的命令不该先报「找不到 config.json」）。
// pair --wait 例外：服务端刚起时 config.json 可能还没生成（Docker 新数据卷 `up -d` 后紧跟着 exec），cmdPair 里等它出现再读。
const NEEDS_CONFIG = new Set(['show-token', 'invite', 'users', 'access', 'info', 'pair']);
const PAIR_WAIT = cmd === 'pair' && (flags.has('--wait') || !!flagValue('wait'));
let cfg = NEEDS_CONFIG.has(cmd) && !PAIR_WAIT ? loadConfig() : null;
const portOf = (c) => Number(process.env.PORT || (c && c.port) || 8787);
let PORT = portOf(cfg);
const STDIN_TOKEN = flags.has('--token-stdin') ? await readStdin() : '';
const adminToken = () => process.env.BRIDGE_TOKEN || STDIN_TOKEN || (cfg && cfg.token) || '';

async function admin(method, route, body) {
  const token = adminToken();
  if (!token) { console.error(HASH_ONLY_HINT); process.exit(1); }
  let r;
  try {
    r = await fetch('http://127.0.0.1:' + PORT + route, {
      method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    console.error('连不上 http://127.0.0.1:' + PORT + '——服务端在跑吗？');
    process.exit(1);
  }
  if (!r.ok) {
    const text = (await r.text()).slice(0, 300);
    let msg = text;
    try { msg = JSON.parse(text).error || text; } catch {}
    console.error(route + ' → HTTP ' + r.status + '：' + msg);
    process.exit(1);
  }
  return r.json();
}

// 部署形态按「本命令的环境 + config.json」现算：bridgectl 与 Docker 镜像会把服务的 BRIDGE_DEPLOY / BRIDGE_HOST 一并带进来。
const deploy = () => resolveDeployProfile({ env: process.env, platform: process.platform, config: cfg || {}, exists: existsSync });

// 公网地址：运行中的服务端说了算（快速隧道的地址只有它知道）；拿不到就看配置与 public-access.json 里写死的。
function staticPublicOrigin() {
  const fromCfg = String(process.env.BRIDGE_PUBLIC_ORIGIN || (cfg && cfg.publicOrigin) || '').trim();
  if (fromCfg) return fromCfg;
  try {
    const pa = readJson(path.join(DATA_ROOT, 'public-access.json'));
    if ((pa.mode === 'manual' || pa.mode === 'token') && /^https?:\/\//.test(String(pa.url || ''))) return String(pa.url);
  } catch {}
  return '';
}

// 本机探一下局域网地址：服务端只听 127.0.0.1 时这些地址连不上，别把连不上的写给人看。
async function reachable(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try { const r = await fetch(url + '/healthz', { signal: ctl.signal }); return r.ok; } catch { return false; } finally { clearTimeout(t); }
}

async function collectUrls(d) {
  const info = await serverInfo(PORT, adminToken());
  const publicOrigin = (info && info.publicOrigin) || staticPublicOrigin();
  const urls = accessUrls({ deploy: d, port: PORT, bindHost: '0.0.0.0', publicOrigin });
  const checked = [];
  for (const u of urls) {
    if (u.kind === 'lan' && !(await reachable(u.url))) continue;
    checked.push(u);
  }
  return { urls: checked, info };
}

async function cmdAccess() {
  const d = deploy();
  const st = await probe(PORT);
  const { urls, info } = st.up ? await collectUrls(d) : { urls: accessUrls({ deploy: d, port: PORT, bindHost: d.listenHost, publicOrigin: staticPublicOrigin() }), info: null };
  const multi = info && typeof info.multiUser === 'boolean' ? info.multiUser : d.audience === 'shared';
  const L = [];
  L.push('The Bridge · 访问信息');
  L.push('  部署形态  ' + describeDeploy({ ...d, audience: multi ? 'shared' : 'self' }));
  L.push('  服务端    ' + (st.up ? '在跑（端口 ' + PORT + '）' : '没在跑（http://127.0.0.1:' + PORT + ' 连不上）'));
  urls.forEach((u, i) => L.push('  ' + (i === 0 ? '地址' : '    ') + '      ' + u.url + '（' + u.note + '）'));
  if (st.up && d.profile !== 'docker' && !urls.some((u) => u.kind === 'lan')) {
    L.push('            只听本机：手机在同一个 Wi-Fi 也连不上。对外开「设置 › 服务端 › 服务控制 › 公网访问」，或让它听局域网（BRIDGE_HOST=0.0.0.0）');
  }
  if (!urls.some((u) => u.kind === 'public')) L.push('  公网      没开：登录后在「设置 › 服务端 › 服务控制 › 公网访问」里选临时地址 / Cloudflare 隧道 / 自己的域名');
  L.push('  管理员    ' + (cfg.token ? CLI + ' show-token 查看访问令牌' : 'config.json 只存令牌哈希：明文只在安装时显示过一次（忘了：' + CLI + ' token --hash）'));
  L.push('  手机      ' + CLI + ' pair 出配对二维码；App 下载：<地址>/download/android');
  L.push('  给谁用    ' + (multi ? '也给别人用：' + CLI + ' invite 发邀请码，或在控制台「用户」页建号'
    : '只给我自己。要给家人朋友开账号：在控制台打开「开放给其他人使用」，或 config.json 写 "features": { "multiUser": true } 后重启'));
  console.log(L.join('\n'));
}

// 扫码配对：领票 → 终端里出二维码与 8 位配对码 → 等到手机连上（过期自动换一张，Ctrl+C 作废）。见 cli/access.mjs 的 runPairing。
// 凭据按顺序试：访问令牌（BRIDGE_TOKEN / --token-stdin / config.json 的明文 token），再试主机密钥（config.json 的
// remotePcSecret，只在本机回环有效）——config.json 只存令牌哈希的部署（install.sh 装的）就靠后者。
async function cmdPair() {
  if (PAIR_WAIT) {
    const secs = Number(flagValue('wait')) || 120;
    const until = Date.now() + secs * 1000;
    const tick = () => process.stderr.write('.');
    process.stderr.write('等服务端起来');
    // 先等 config.json 出现（端口在里面）；写到一半读到坏 JSON 也接着等
    while (!readConfigSoft() && Date.now() < until) { tick(); await new Promise((r) => setTimeout(r, 1000)); }
    if (!readConfigSoft()) {
      process.stderr.write('\n');
      if (!existsSync(CONFIG_PATH)) console.error(secs + ' 秒内没等到服务端生成 config.json（服务端起了吗？数据目录对吗？）');
      loadConfig();   // 报清楚是哪种（找不到 / 不是合法 JSON）并退出
      process.exit(1);
    }
    PORT = portOf(readConfigSoft());
    const ok = await waitHealthy(PORT, { timeoutMs: Math.max(1000, until - Date.now()), onTick: tick });
    process.stderr.write(ok ? ' ✓\n' : '\n');
    if (!ok) { console.error(secs + ' 秒内 http://127.0.0.1:' + PORT + ' 没起来。'); process.exit(1); }
    // 起来以后再读一遍：主机密钥（remotePcSecret）是服务端启动过程中才补进 config.json 的
    cfg = loadConfig();
    PORT = portOf(cfg);
  }
  const auths = [adminToken(), cfg.remotePcSecret].filter(Boolean);
  if (!auths.length) { console.error(HASH_ONLY_HINT + '\n也可以用访问令牌登录网页 / App 后在设置里出配对码。'); process.exit(1); }
  const origin = flagValue('origin').trim().replace(/\/+$/, '');
  if (origin && !/^https?:\/\/[^/\s]+$/i.test(origin)) { console.error('--origin 要写成 http://<地址>:<端口>（不带路径），例如 --origin=http://192.168.1.10:8787'); process.exit(1); }
  process.exitCode = await runPairing({
    port: PORT, auths, cli: CLI, origin, docker: deploy().profile === 'docker',
    once: flags.has('--once'), json: flags.has('--json'), forceWait: flags.has('--force-wait'),
    qr: { ansi: wantAnsi(process.stdout, process.env, flags.has('--plain')), invert: flags.has('--invert'), ascii: flags.has('--ascii') },
  });
}

if (cmd === 'show-token') {
  const t = adminToken();
  if (!t) { console.error(HASH_ONLY_HINT); process.exit(1); }
  console.log(t);
} else if (cmd === 'token') {
  // 同 npm run token（src/gen-token.mjs：--hash 只存哈希）；它在导入时就干活。
  // 默认沿用现在的存法：config.json 只存哈希的（install.sh 装的）换完仍只存哈希——忘了加 --hash 不能悄悄把明文写回去；
  // 要改存明文（桌面壳附着的主机要读明文）显式加 --plain。
  const now = readConfigSoft() || {};
  const hashOnly = !!now.tokenHash && !now.token;
  if (flags.has('--hash') && flags.has('--plain')) { console.error('--hash 和 --plain 只能选一个。'); process.exit(1); }
  const hash = flags.has('--hash') || (hashOnly && !flags.has('--plain'));
  if (hash && !process.argv.includes('--hash')) process.argv.push('--hash');
  await import('./gen-token.mjs');
  console.error(hash
    ? '（config.json 只存这个令牌的哈希' + (flags.has('--hash') ? '' : '，沿用原来的存法') + '：上面的明文只显示这一次，请当场存好。）'
    : '（明文令牌写在 config.json 的 "token"；以后 ' + CLI + ' show-token 能再查到。）');
  const how = deploy().profile === 'docker' ? 'docker compose restart bridge'
    : /bridgectl/.test(CLI) ? CLI + ' restart' : '重启服务端';
  console.error('新令牌在服务端重启后生效：' + how + '。');
} else if (cmd === 'invite') {
  // 档位（S2-2）：普通 = 没有命令行；完全信任（存储值仍是 pro）= 有命令行、终端和浏览器，等同管理员——
  // 服务端要 ack:true 才发，这里要人显式加 --ack。
  const want = String(arg || 'user').toLowerCase();
  const full = want === 'full' || want === 'pro';
  if (!full && want !== 'user') { console.error('档位只有 user（普通，默认）和 full（完全信任，旧名 pro）。'); process.exit(1); }
  if (full && !flags.has('--ack')) {
    console.error('完全信任等同管理员：有命令行，能读到服务器上所有人的对话、文件和全部凭据。\n确认要发就加 --ack：' + CLI + ' invite full --ack');
    process.exit(1);
  }
  const days = Number(flagValue('days')) || 0;
  if (flagValue('days') && !(days > 0 && days <= 90)) { console.error('--days 要是 1 到 90 之间的天数。'); process.exit(1); }
  const r = await admin('POST', '/api/admin/invite', { tier: full ? 'pro' : 'user', ...(full ? { ack: true } : {}), ...(days ? { days } : {}) });
  console.log(r.code);
  console.error('（一次性邀请码，' + (full ? '完全信任档（等同管理员）' : '普通档（没有命令行）')
    + (r.expiresAt ? '，' + fmtTime(r.expiresAt) + ' 前有效' : '') + '。对方在登录页选「注册」填它。）');
} else if (cmd === 'users') {
  const { users = [], invites = [], multiUser } = await admin('GET', '/api/admin/users');
  if (multiUser === false) console.error('（多用户关着：只有管理员与服务账号能登录。要给别人用，在控制台打开「开放给其他人使用」。）');
  if (!users.length) console.log('还没有注册账号。');
  for (const u of users) console.log(`${u.name}\t${tierLabel(u)}${u.disabled ? '\t(已停用)' : ''}`);
  const open = invites.filter((i) => !i.usedBy && !i.used && !i.expired);
  if (open.length) {
    console.log('\n未使用的邀请码：\n' + open.map((i) => `${i.code}\t${tierLabel(i)}${i.expiresAt ? '\t' + fmtTime(i.expiresAt) + ' 前有效' : ''}`).join('\n'));
  }
} else if (cmd === 'access' || cmd === 'info') {
  await cmdAccess();
} else if (cmd === 'pair') {
  await cmdPair();
} else {
  console.error([
    '用法：' + CLI + ' <命令>',
    '  access                     怎么连这台服务端（地址、令牌、配对、给谁用）',
    '  pair [--wait] [--once]     手机扫码配对：一次性二维码 + 配对码，等到手机连上（--json / --plain / --invert / --ascii /',
    '                             --origin=http://<局域网 IP>:<端口> 没开公网访问时码里放的地址；',
    '                             --force-wait 码里的地址看着连不上也照样等）',
    '  show-token                 打印管理员访问令牌',
    '  token [--hash|--plain]     换一个新的访问令牌（重启服务端后生效；默认沿用现在的存法，只存哈希的仍只存哈希）',
    '  invite [user] [--days=N]   一次性普通档邀请码（要先打开「也给别人用」；默认 7 天有效）',
    '  invite full --ack          完全信任档（旧名 pro）：有命令行，等同管理员',
    '  users                      已注册账号与未用的邀请码',
  ].join('\n'));
  process.exit(cmd && cmd !== 'help' ? 1 : 0);
}
