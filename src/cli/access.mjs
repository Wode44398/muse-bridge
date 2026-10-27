// 无界面服务端的「怎么连上它」：访问地址、管理员令牌的取法、终端里的扫码配对（开源路线 S1-7 配合 S1-2）。
//
// 三处用：
//   · src/cli.mjs 的 access / pair 命令（install.sh 装完自动各跑一次；Docker：docker compose exec bridge node src/cli.mjs pair）；
//   · server.mjs 监听成功后：无界面形态（server / docker）在日志里打几行「怎么连」——只有取法，不打印任何凭据；
//     首次启动（刚生成 config.json）且 stdout 是终端时，顺手出一张配对二维码（announceAccess）。
// 二维码编码用 S1-2 的 runtime/qr.mjs；领票 / 等待 / 作废走 routes/pair.mjs 的出示方接口。
//
// ── 与 S1-2 扫码配对的接口约定（服务端实现在 routes/pair.mjs）──────────────────────────────────────────────
//   POST /api/pair/connect         领票（约 3 分钟过期、只能用一次）。请求体 { via: 'cli' | 'terminal' }
//     回应 { id, code, codeText, expiresAt, url（二维码内容，不含主令牌）, origin, reachable, … }
//   POST /api/pair/connect/wait    长轮询 { id, status } → { status: pending | redeemed | expired | cancelled | revoked, device, ip, kind }
//   POST /api/pair/connect/cancel  作废没用过的票 { id }
//   鉴权：管理员（Bearer 访问令牌 / 管理员会话），或本机命令行：回环直连、不带任何代理头 + Bearer 主机密钥
//         （config.json 的 remotePcSecret；config.json 只存令牌哈希时命令行就靠它）。都按管理员出码。
//   404：服务端还没有这个接口（旧版本）。
//
// 只用 node 内置模块 + runtime/qr.mjs，不读 config/index.mjs（那边导入即建目录、缺令牌就退出）。
import os from 'node:os';
import { encodeQr, qrTerminal } from '../runtime/qr.mjs';

const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

/** 这台机器的局域网 IPv4（含 Tailscale 的 100.64/10），私网段排前面；不含回环与 169.254 链路本地。 */
export function lanIPv4s(ifaces = os.networkInterfaces()) {
  const out = [];
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) {
      const fam = typeof a.family === 'string' ? a.family : (a.family === 4 ? 'IPv4' : 'IPv6');
      if (fam !== 'IPv4' || a.internal || /^169\.254\./.test(a.address)) continue;
      if (!out.includes(a.address)) out.push(a.address);
    }
  }
  return out.sort((a, b) => Number(!PRIVATE_V4.test(a)) - Number(!PRIVATE_V4.test(b)));
}

/** 运维命令前缀：install.sh 写进单元的 BRIDGE_CLI（如 sudo bridgectl）、镜像里写的 docker compose exec …，否则源码目录里的 node src/cli.mjs。 */
export function cliPrefix(env = process.env) {
  return String(env.BRIDGE_CLI || '').trim() || 'node src/cli.mjs';
}

/**
 * 能用来打开它的地址：[{ kind: 'local' | 'lan' | 'host' | 'public', url, note }]。
 * deploy：deploy-profile 的结果；bindHost：服务端实际监听的地址（不知道就按 deploy.listenHost）。
 * Docker 里的「本机 / 局域网」都是容器网络，没用——改按 compose 的端口映射（BRIDGE_BIND / BRIDGE_PUBLISH_PORT，compose 透传进来）说宿主机地址。
 */
export function accessUrls({ deploy, port, bindHost, publicOrigin = '', lan = null, env = process.env } = {}) {
  const out = [];
  const host = bindHost || (deploy && deploy.listenHost) || '0.0.0.0';
  if (deploy && deploy.profile === 'docker') {
    const hp = String(env.BRIDGE_PUBLISH_PORT || port || 8787);
    const bind = String(env.BRIDGE_BIND || '127.0.0.1');
    out.push({ kind: 'host', url: 'http://127.0.0.1:' + hp, note: '宿主机本机' });
    if (bind === '0.0.0.0' || bind === '::') out.push({ kind: 'host', url: 'http://<这台服务器的局域网 IP>:' + hp, note: '局域网（BRIDGE_BIND=0.0.0.0）' });
  } else {
    out.push({ kind: 'local', url: 'http://127.0.0.1:' + port, note: '本机' });
    const wild = host === '0.0.0.0' || host === '::';
    if (wild) for (const ip of (lan || lanIPv4s())) out.push({ kind: 'lan', url: 'http://' + ip + ':' + port, note: '局域网' });
    else if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') out.push({ kind: 'lan', url: 'http://' + host + ':' + port, note: '监听地址' });
  }
  if (publicOrigin) out.push({ kind: 'public', url: String(publicOrigin).replace(/\/+$/, ''), note: '公网' });
  return out;
}

async function call(port, method, route, { auth = '', body = null, timeoutMs = 5000, fetchImpl = fetch } = {}) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl('http://127.0.0.1:' + port + route, {
      method,
      headers: { ...(auth ? { Authorization: 'Bearer ' + auth } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, json, text };
  } catch (e) {
    return { status: 0, json: null, text: String((e && e.message) || e) };
  } finally { clearTimeout(t); }
}

/** 服务端在不在：{ up, status }。 */
export async function probe(port) {
  const r = await call(port, 'GET', '/healthz', { timeoutMs: 3000 });
  return { up: r.status === 200, status: r.status };
}

/** 等服务端起来（/healthz 200）。返回 true / false。 */
export async function waitHealthy(port, { timeoutMs = 90_000, onTick = null } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    if ((await probe(port)).up) return true;
    if (Date.now() > until) return false;
    if (onTick) onTick();
    await new Promise((res) => setTimeout(res, 1000));
  }
}

/** 运行中的服务端报的信息（要管理员令牌）：公网地址、多用户开关等；拿不到回 null。 */
export async function serverInfo(port, token) {
  if (!token) return null;
  const r = await call(port, 'GET', '/api/app/server-info', { auth: token });
  return r.status === 200 && r.json ? r.json : null;
}

/**
 * 领一张配对票。auths：按顺序试的凭据（访问令牌、主机密钥）。
 * 返回 { ok: true, ticket, auth } | { ok: false, reason: 'unsupported' | 'unauthorized' | 'down' | 'error', detail }。
 */
export async function mintConnect(port, auths, { via = 'cli', origin = '', fetchImpl = fetch } = {}) {
  let last = { ok: false, reason: 'unauthorized', detail: '没有可用的凭据' };
  // origin：码里放哪个地址（没开公网访问时才用得上，见 routes/pair.mjs 的 pickOrigin）。Docker 里看不到宿主机的
  // 局域网地址，就靠 pair --origin=http://<宿主机局域网 IP>:<端口> 告诉它
  const body = origin ? { via, origin } : { via };
  for (const auth of (auths || []).filter(Boolean)) {
    const r = await call(port, 'POST', '/api/pair/connect', { auth, body, timeoutMs: 10_000, fetchImpl });
    if (r.status === 200 && r.json && r.json.url) return { ok: true, ticket: r.json, auth };
    if (r.status === 0) return { ok: false, reason: 'down', detail: r.text };
    if (r.status === 404) return { ok: false, reason: 'unsupported', detail: '' };
    if (r.status === 401 || r.status === 403) { last = { ok: false, reason: 'unauthorized', detail: (r.json && r.json.error) || '' }; continue; }
    return { ok: false, reason: 'error', detail: (r.json && r.json.error) || ('HTTP ' + r.status) };
  }
  return last;
}

const LOOPBACK_HOST = /^(127\.|localhost$|::1$|\[::1\]$)/i;

/**
 * 码里的局域网地址手机真连得上吗。服务端按 lanCandidates 拼局域网候选时，老版本只看 BRIDGE_HOST、不看实际监听地址，
 * 只听 127.0.0.1 的服务器也会把 http://192.168.x.x 写进码里并标 reachable:true——这里替人把关，免得手机扫了只得到
 * 「连不上二维码里的地址」：
 *   · 知道实际监听地址（server.mjs 里调）：是回环就判连不上；
 *   · 不知道（命令行）：从本机探一下那个地址的 /healthz（服务端只听回环时本机也连不上它）。
 * 只管 via:'lan'（服务端自己挑的局域网地址）；公网地址、人用 --origin 指定的、Docker 里的都不探。
 * 返回（可能改过 reachable / why 的）票。
 */
export async function checkLanReachable(t, { bindHost = '', origin = '', docker = false, timeoutMs = 1500, fetchImpl = fetch } = {}) {
  if (!t || t.reachable === false || t.via !== 'lan' || origin || docker) return t;
  if (bindHost) return LOOPBACK_HOST.test(String(bindHost)) ? { ...t, reachable: false, why: 'loopback' } : t;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetchImpl(String(t.origin || '').replace(/\/+$/, '') + '/healthz', { signal: ctl.signal });
    return r.ok ? t : { ...t, reachable: false, why: 'loopback' };
  } catch { return { ...t, reachable: false, why: 'loopback' }; } finally { clearTimeout(timer); }
}

/** 终端输出要不要带颜色：NO_COLOR / 非 TTY / 显式关掉都不带。 */
export function wantAnsi(stream = process.stdout, env = process.env, plain = false) {
  return !plain && !!(stream && stream.isTTY) && !('NO_COLOR' in env) && env.TERM !== 'dumb';
}

/**
 * 终端二维码。ansi：用颜色钉死「深 = 黑、浅 = 白」，深色、浅色背景的终端都能扫；否则用 runtime/qr.mjs 的字符画
 * （按深色背景画，浅色背景的终端加 invert；不认方块字的加 ascii）。
 */
export function renderQr(text, { ansi = false, invert = false, ascii = false, margin = 2 } = {}) {
  if (!ansi || ascii) return qrTerminal(text, { margin, invert, ascii });
  const q = encodeQr(text);
  const n = q.size + margin * 2;
  const dark = (x, y) => y < n && x < n && q.dark(x - margin, y - margin);
  const lines = [];
  for (let y = 0; y < n; y += 2) {
    let line = '', last = '';
    for (let x = 0; x < n; x++) {
      // ▀：前景画上半格、背景画下半格。30 / 97 = 黑 / 亮白前景，40 / 107 = 黑 / 亮白背景
      const style = '\x1b[' + (dark(x, y) ? '30' : '97') + ';' + (dark(x, y + 1) && y + 1 < n ? '40' : '107') + 'm';
      if (style !== last) { line += style; last = style; }
      line += '▀';
    }
    lines.push(line + '\x1b[0m');
  }
  return lines.join('\n');
}

export function fmtRemain(expiresAt, now = Date.now()) {
  const s = Math.max(0, Math.round((expiresAt - now) / 1000));
  return s >= 60 ? Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒' : s + ' 秒';
}

/** 一张票在终端里的样子（二维码 + 配对码 + 地址 + 怎么用）。 */
export function formatTicket(t, { qr = {}, round = 0, now = Date.now(), docker = false, cli = cliPrefix() } = {}) {
  const out = [];
  out.push('');
  out.push(round ? '  ── 上一张过期了，换一张（3 分钟内有效，只能用一次）──' : '  ── 手机扫码连接这台服务器（3 分钟内有效，只能用一次）──');
  out.push(renderQr(t.url, qr).split('\n').map((l) => '  ' + l).join('\n'));
  out.push('  配对码：' + (t.codeText || t.code || '') + '    地址：' + (t.origin || '') + (t.expiresAt ? '    ' + fmtRemain(t.expiresAt, now) + '后过期' : ''));
  if (t.reachable === false) {
    out.push(docker
      ? '  注意：容器里看不到宿主机的地址，码里只有 ' + (t.origin || '本机地址') + '，手机连不上——先开公网访问；或者家里 Wi-Fi 直连：'
        + '.env 设 BRIDGE_BIND=0.0.0.0、重启后\n        ' + cli + ' pair --origin=http://<这台机器的局域网 IP>:<端口>'
      : t.why === 'loopback'
        ? '  注意：服务端只听本机（127.0.0.1），码里的局域网地址 ' + (t.origin || '') + ' 手机连不上——先开公网访问（控制台「服务控制 → 公网访问」），\n'
          + '        或让它听局域网：install.sh 装的加 --lan 重跑，其余设 BRIDGE_HOST=0.0.0.0（或 config.json 的 "bindHost"）后重启。'
        : '  注意：这台服务器只允许本机访问（没有局域网地址、也没开公网访问），手机连不上——先开公网访问或局域网直连。');
  }
  out.push('  手机 App 首屏点「扫码连接」；没装 App 用系统相机扫，直接在浏览器里打开。没有相机就在 App 里填地址和配对码。');
  return out.join('\n');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 命令行的配对：领票 → 打印二维码与配对码 → 等到手机连上；过期自动换一张（最多 maxRounds 张）；Ctrl+C 作废当前这张。
 * 码里的地址手机连不上（reachable === false）时打印改法就返回 1，不进等待（forceWait 照等）。
 * 返回退出码：0 已连接 / 已打印 JSON；1 失败、连不上或过期没人扫；130 被 Ctrl+C。
 */
export async function runPairing({ port, auths, once = false, json = false, maxRounds = 10, qr = {}, cli = cliPrefix(),
  origin = '', docker = false, forceWait = false,
  out = (s) => console.log(s), err = (s) => console.error(s), fetchImpl = fetch,
  onSigint = (fn) => process.once('SIGINT', fn), exit = (c) => process.exit(c) } = {}) {
  let current = null, auth = '', interrupted = false;
  onSigint(async () => {
    interrupted = true;
    if (current) await call(port, 'POST', '/api/pair/connect/cancel', { auth, body: { id: current.id }, timeoutMs: 3000, fetchImpl });
    out('\n  已作废这张配对码。');
    exit(130);
  });
  for (let round = 0; round < Math.max(1, maxRounds) && !interrupted; round++) {
    const m = await mintConnect(port, auths, { via: 'cli', origin, fetchImpl });
    if (!m.ok) {
      if (m.reason === 'down') err('连不上 http://127.0.0.1:' + port + '——服务端在跑吗？（刚启动的话加 --wait 等它起来）');
      else if (m.reason === 'unsupported') err('这个版本的服务端还不支持扫码配对：先更新服务端，或用访问令牌登录（' + cli + ' show-token）。');
      else if (m.reason === 'unauthorized') err('没有能出配对码的凭据（' + (m.detail || '访问令牌 / 主机密钥都不对') + '）：用 BRIDGE_TOKEN=<令牌> 或 --token-stdin 给访问令牌。');
      else err('出码失败：' + m.detail);
      return 1;
    }
    // 码里的局域网地址替人先探一下（服务端只听本机时手机连不上，见 checkLanReachable）
    current = await checkLanReachable(m.ticket, { origin, docker, fetchImpl });
    auth = m.auth;
    if (json) {
      const { url, code, codeText, origin: o, reachable, expiresAt } = current;
      out(JSON.stringify({ url, code, codeText, origin: o, reachable, expiresAt }));
      return 0;
    }
    out(formatTicket(current, { qr, round, docker, cli }));
    // 码里的地址手机连不上：别占着终端干等（install.sh 装完、Docker 上手命令都会卡上 3 分钟到半小时）。
    // 票不作废——确实有别的路（自己知道的地址 + App 里手填配对码）3 分钟内照样能用；要等它就加 --force-wait
    if (current.reachable === false && !forceWait) {
      out('  先不等了：照上面改好以后再运行 ' + cli + ' pair 出一张新码（确实有别的路能连上，加 --force-wait 等它）。');
      return 1;
    }
    out('  等待手机连接…（Ctrl+C 作废并退出）');
    let status = 'pending';
    while (!interrupted) {
      const w = await call(port, 'POST', '/api/pair/connect/wait', { auth, body: { id: current.id, status }, timeoutMs: 40_000, fetchImpl });
      if (w.status === 0) { await sleep(2000); continue; }
      const v = w.json || {};
      if (w.status === 404 || v.status === 'gone') { status = 'expired'; break; }
      if (v.status === 'pending') continue;
      if (v.status === 'redeemed') {
        out('  ✓ 已连接：' + (v.device || '手机') + (v.ip ? '（' + v.ip + '）' : '') + (v.kind === 'admin' ? '，以管理员身份登录。' : '。'));
        out('    不是你？在控制台「用户 › 管理员登录」里吊销它。');
        return 0;
      }
      status = v.status || 'expired';
      break;
    }
    if (status === 'cancelled' || status === 'revoked') { out('  这张配对码被作废了。'); return 1; }
    if (once) { out('  配对码过期了；需要时运行 ' + cli + ' pair 再出一张。'); return 1; }
  }
  if (!interrupted) out('  一直没有手机来连，先停了；需要时运行 ' + cli + ' pair 再出一张。');
  return 1;
}

/**
 * 无界面形态的启动日志：几行「怎么连上它」。桌面形态不刷屏（托盘 / 窗口里都有），只在首次启动时提一句配对。
 * 不打印任何凭据（S6：stdout 常被重定向落盘）。
 */
export function startupLines({ deploy, port, bindHost, publicOrigin = '', tokenHashOnly = false, fresh = false, env = process.env } = {}) {
  const cli = cliPrefix(env);
  if (!deploy || !deploy.headless) {
    return fresh ? ['  配对  : 手机扫码连接——' + cli + ' pair'] : [];
  }
  const urls = accessUrls({ deploy, port, bindHost, publicOrigin, env });
  const lines = [];
  lines.push('  接入  : ' + urls.map((u) => u.note + ' ' + u.url).join(' · '));
  if (deploy.profile !== 'docker' && (bindHost || deploy.listenHost) === '127.0.0.1') {
    lines.push('          只听本机：对外请开「设置 › 服务端 › 服务控制 › 公网访问」，或反代 / 隧道；局域网直连设 BRIDGE_HOST=0.0.0.0');
  }
  lines.push('  令牌  : ' + (tokenHashOnly
    ? 'config.json 只存哈希，明文只在安装时显示过一次（忘了：' + cli + ' token --hash 重新生成，重启后生效，管理员登录全部下线）'
    : cli + ' show-token'));
  lines.push('  配对  : ' + cli + ' pair —— 终端里出二维码，手机 App 首屏「扫码连接」');
  lines.push('  详情  : ' + cli + ' access');
  return lines;
}

/**
 * server.mjs 监听成功后调一次：打「怎么连」几行；首次启动（刚生成 config.json）且 stdout 是终端（有人在前台看着，
 * 不是被重定向进日志文件 / journald / docker logs）时，再出一张配对二维码——一次性票只进屏幕、不进任何日志。
 * BRIDGE_PAIR_BANNER=0 永不出码，=1 不看是否首次 / 是否终端都出（自己担保 stdout 不落盘）。NO_AUTH 的本机实例什么都不打。
 */
export function announceAccess({ deploy, port, bindHost, tokenHashOnly = false, fresh = false, token = '', noAuth = false,
  log = console.log, stdout = process.stdout, env = process.env, delayMs = 1500 } = {}) {
  if (noAuth || !deploy) return;
  for (const l of startupLines({ deploy, port, bindHost, tokenHashOnly, fresh, env })) log(l);
  const banner = String(env.BRIDGE_PAIR_BANNER || '');
  if (banner === '0' || !token) return;
  if (banner !== '1' && !(fresh && stdout && stdout.isTTY)) return;
  // 公网隧道刚起时地址还没回来：晚一点再领票（码里的地址按领票那一刻的公网 / 局域网地址拼）
  const t = setTimeout(async () => {
    try {
      const m = await mintConnect(port, [token], { via: 'terminal' });
      if (!m.ok) { if (m.reason !== 'unsupported') log('  配对  : 没出成二维码（' + (m.detail || m.reason) + '），稍后运行 ' + cliPrefix(env) + ' pair'); return; }
      const docker = deploy.profile === 'docker';
      const t = await checkLanReachable(m.ticket, { bindHost: bindHost || deploy.listenHost, docker });
      log(formatTicket(t, { qr: { ansi: wantAnsi(stdout, env) }, docker, cli: cliPrefix(env) }));
      log('  过期了运行 ' + cliPrefix(env) + ' pair 再出一张。\n');
    } catch (e) { log('  配对  : 没出成二维码（' + ((e && e.message) || e) + '），稍后运行 ' + cliPrefix(env) + ' pair'); }
  }, delayMs);
  if (t.unref) t.unref();
}
