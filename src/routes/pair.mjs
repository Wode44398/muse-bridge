// 扫码配对登录（网页端 ↔ 已登录的手机 apk）。
//
// 流程：未登录的网页 POST /api/pair/new 领一张票（id + 两把钥匙），把 id+key 编进二维码；
// 已登录的手机扫到后 POST /api/pair/scan（票进入 scanned，网页立刻显示「已扫描」），
// 用户在手机上点确认 → POST /api/pair/approve：按手机的身份铸凭据（user → 新 session token；
// admin → 新的管理员会话，控制台里能单独吊销——以前发的是访问令牌本身，漏一次只能换令牌），网页那头一直在 /api/pair/wait
// 长轮询，收到 approved 即 POST /api/pair/claim 用 claim 钥匙换凭据（Set-Cookie + JSON token），
// 票随即销毁。
//
// 两把钥匙分工：key 进二维码、只能【扫/确认】；claim 只在领票的那个网页手里、只能【取凭据】。
// 所以拍下屏幕上的二维码拿不到登录态（最多把这台网页登成拍照者自己的账号）；反过来只拿到
// claim 也没用——没有已登录的手机确认，票永远不会 approved。票全在内存里（3 分钟未确认即
// 过期；确认后 60 秒内不领取也作废，铸出的 user 会话一并删掉），重启即清零。
//
// 手机侧身份必须是真登录态（admin / user）：share / snap 这类能力 token 身份不能替网页登录——
// 本模块只拿不带 resolveSnap 的 identify，snap token 解析成 none 自然 401。
//
// 后半是方向相反的「扫码配对」（开源路线 S1-2）：已登录的一方（桌面客户端完成页、设置「连接与更新」、控制台、终端）
// 出示二维码 + 8 位数字配对码，还没登录的手机扫码 / 手输换到自己的长期会话（票仓与安全规则见 runtime/pair-connect.mjs）：
//   POST /api/pair/connect          出示方领票（admin / user），回二维码 SVG、配对码、码里的地址
//   POST /api/pair/connect/wait     出示方长轮询：等到「已连接：哪台设备」
//   POST /api/pair/connect/cancel   出示方作废没用过的票
//   POST /api/pair/connect/revoke   出示方「不是我？撤销」：收回刚发出去的会话
//   GET  /api/pair/connect/audit    管理员看最近的配对记录
//   POST /api/pair/redeem           兑换（无鉴权）：{ id, secret }（扫码）或 { code }（手输）→ 会话令牌 + 地址簿
//                                   { replace:true }（网页上已登录、用户在确认卡上点了「连接」）：顺手退出这个浏览器原来的登录

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readBody } from '../runtime/body.mjs';
import * as users from '../users.mjs';
import { createConnectStore, connectUrl, pickOrigin, fmtCode, readPairAudit, CONNECT_TTL } from '../runtime/pair-connect.mjs';
import { qrSvg } from '../runtime/qr.mjs';
import { serverAddress } from '../runtime/server-address.mjs';
import { hostSecretOk, isLocalDirect } from '../runtime/host-secret.mjs';
import { PUBLIC_ORIGIN, NO_AUTH, PORT, DEPLOY } from '../config/index.mjs';
import { lanCandidates } from './app-update.mjs';

const PENDING_TTL = 3 * 60 * 1000;   // 二维码有效期
const APPROVED_TTL = 60 * 1000;      // 确认后等网页领取的窗口
const WAIT_HOLD = 20 * 1000;         // 长轮询最长挂多久（Cloudflare 100s 之内留足余量）
const KEEP_DONE = 60 * 1000;         // 终态票再留一会，让迟到的 wait 拿到 expired/rejected 而不是 404
const MAX_TICKETS = 300;
const PER_IP_PENDING = 20;

const tickets = new Map();   // id -> ticket

const rid = (n) => randomBytes(n).toString('base64url');
function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// 真实来源 IP：cloudflared 隧道后 remoteAddress 恒为 127.0.0.1，优先取 CF/代理头。
export function clientIp(req) {
  return String(req.headers['cf-connecting-ip'] || (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '');
}
// 限流用的来源（无鉴权的兑换接口）：只有对端是本机 / 内网（本机 cloudflared、同一 Docker 网络里的隧道侧车或反代）时才认代理头；
// 公网直连（VPS 上直接开着 8787）时代理头随便伪造，每次换一个值就能绕过按 IP 封禁，只认 socket 地址。同 routes/devices.mjs 的 trustedIp。
const TRUST_PROXY_FROM = /^(::ffff:)?(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)|^::1$|^f[cd][0-9a-f]{2}:/i;
export function rateIp(req) {
  const sock = String(req.socket?.remoteAddress || '').trim();
  return TRUST_PROXY_FROM.test(sock) ? (clientIp(req) || sock) : sock;
}

// UA → 「Windows · Edge」这种给人看的一句话（手机确认卡上显示是谁在登录）。
export function describeClient(ua = '') {
  const u = String(ua);
  const os = /Windows/i.test(u) ? 'Windows'
    : /iPhone/i.test(u) ? 'iPhone'
    : /iPad/i.test(u) ? 'iPad'
    : /Android/i.test(u) ? 'Android'
    : /Mac OS X|Macintosh/i.test(u) ? 'Mac'
    : /CrOS/i.test(u) ? 'ChromeOS'
    : /Linux/i.test(u) ? 'Linux' : '';
  const br = /Electron\//i.test(u) ? 'Bridge 桌面版'
    : /Edg\//i.test(u) ? 'Edge'
    : /OPR\/|Opera/i.test(u) ? 'Opera'
    : /Firefox\//i.test(u) ? 'Firefox'
    : /Chrome\//i.test(u) ? 'Chrome'
    : /Safari\//i.test(u) ? 'Safari' : '';
  return [os, br].filter(Boolean).join(' · ') || '未知设备';
}

function notify(t) {
  const ws = t.waiters; t.waiters = new Set();
  for (const w of ws) { try { w(); } catch {} }
}
function finish(t, status) {
  // 铸了凭据却没被领走（过期 / 取消）：把那张会话收回，别在库里留一张没人拿着的有效凭据。
  if (t.cred && status !== 'claimed') {
    try {
      if (t.cred.kind === 'user') users.deleteSession(t.cred.token);
      else if (t.cred.kind === 'admin') users.revokeAdminSessions([users.adminSessionIdOf(t.cred.token)]);
    } catch {}
  }
  t.cred = null; t.status = status; t.finishedAt = Date.now();
  notify(t);
}
function expireCheck(t, now = Date.now()) {
  if ((t.status === 'pending' || t.status === 'scanned') && now > t.expiresAt) finish(t, 'expired');
  else if (t.status === 'approved' && now - t.approvedAt > APPROVED_TTL) finish(t, 'expired');
}
function prune(now = Date.now()) {
  for (const t of tickets.values()) {
    expireCheck(t, now);
    if (t.finishedAt && now - t.finishedAt > KEEP_DONE) tickets.delete(t.id);
  }
}
const pruneTimer = setInterval(prune, 15000);
pruneTimer.unref?.();

// 扫码配对的票仓（与上面扫码登录的票分开：方向、钥匙、寿命都不同）
const connect = createConnectStore();

// 测试用：清空票仓。
export function _resetPairStore() { tickets.clear(); connect._reset(); }

// 兑换方是谁（出示方「已连接：…」、管理员会话列表里显示）：App 自己报 client:'app'，浏览器部分换成 App 名
function redeemerLabel(ua, client) {
  const d = describeClient(ua);
  if (client !== 'app') return d;
  const os = d.split(' · ')[0];
  return (os && os !== '未知设备' ? os + ' · ' : '') + 'The Bridge App';
}

// 扫码配对另要的几样（server.mjs 从 createAuth 传进来；老调用方不传也照常工作，只是少了对应的那层校验）：
//   adminCredential —— 出示方是哪张管理员会话（票绑在那次登录上，那张会话被吊销 / 退出后票作废）；
//   getCookie / bearerToken / clearAuthCookie / clearUserCookie —— 兑换带 replace 时退出这个浏览器原来的登录；
//   bindHost —— 服务端实际监听的地址（局域网候选据此判断手机连不连得上；默认与 server.mjs 同一口径）。
export function registerPairRoutes(router, {
  identify, adminGen, authCookie, userCookie, lanIPs = null,
  adminCredential = null, getCookie = null, bearerToken = null, clearAuthCookie = null, clearUserCookie = null, bindHost = null,
}) {
  const listenHost = bindHost != null ? String(bindHost) : (NO_AUTH ? '127.0.0.1' : String(DEPLOY?.listenHost || '0.0.0.0'));
  const json = (res, code, obj, extra) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(extra || {}) });
    res.end(JSON.stringify(obj));
  };
  const parse = async (req) => { try { return JSON.parse(await readBody(req, 20_000)) || {}; } catch { return {}; } };
  const byKey = (body) => {
    const t = tickets.get(String(body.id || '')); if (!t) return null;
    expireCheck(t);
    return safeEq(t.key, String(body.key || '')) ? t : null;
  };
  const byClaim = (body) => {
    const t = tickets.get(String(body.id || '')); if (!t) return null;
    expireCheck(t);
    return safeEq(t.claim, String(body.claim || '')) ? t : null;
  };
  // 手机侧：必须是登录态（admin / user）。
  const approver = (req, res) => {
    const id = identify(req);
    if (!id || (id.kind !== 'admin' && id.kind !== 'user')) { json(res, 401, { error: '请先在手机上登录' }); return null; }
    return id;
  };
  const view = (t) => ({ status: t.status, expiresAt: t.expiresAt });

  // ① 网页领票（无鉴权）。限流：总量 + 每 IP 未完成票数。
  router.on('POST', '/api/pair/new', async (req, res) => {
    prune();
    const ip = clientIp(req);
    let mine = 0;
    for (const t of tickets.values()) if (t.ip === ip && !t.finishedAt) mine++;
    if (tickets.size >= MAX_TICKETS || mine >= PER_IP_PENDING) return json(res, 429, { error: '配对请求过多，请稍后再试' });
    const body = await parse(req);
    const now = Date.now();
    const t = {
      id: rid(12), key: rid(18), claim: rid(24),
      status: 'pending', created: now, expiresAt: now + PENDING_TTL,
      ip, ua: String(req.headers['user-agent'] || ''), label: String(body.label || '').slice(0, 80),
      waiters: new Set(), cred: null, approvedAt: 0, finishedAt: 0, by: null,
    };
    tickets.set(t.id, t);
    json(res, 200, { id: t.id, key: t.key, claim: t.claim, expiresAt: t.expiresAt });
  });

  // ② 网页长轮询：状态与 body.status 不同就立刻回，否则最多挂 WAIT_HOLD 再回当前状态。
  router.on('POST', '/api/pair/wait', async (req, res) => {
    const body = await parse(req);
    const t = byClaim(body);
    if (!t) return json(res, 404, { status: 'expired' });
    if (t.status !== String(body.status || 'pending')) return json(res, 200, view(t));
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; clearTimeout(timer); t.waiters.delete(fin); resolve(); };
      const timer = setTimeout(fin, WAIT_HOLD);
      t.waiters.add(fin);
      res.on('close', fin);   // 网页走了就别再挂着
    });
    if (res.writableEnded || res.destroyed || res.socket?.destroyed) return;
    expireCheck(t);
    json(res, 200, view(t));
  });

  // ③ 手机扫到：票进入 scanned，回设备信息给确认卡。
  router.on('POST', '/api/pair/scan', async (req, res) => {
    const id = approver(req, res); if (!id) return;
    const t = byKey(await parse(req));
    if (!t) return json(res, 404, { error: '二维码无效或已过期，请在网页上刷新后重扫' });
    if (t.status === 'expired') return json(res, 410, { error: '二维码已过期，请在网页上刷新后重扫' });
    if (t.status !== 'pending' && t.status !== 'scanned') return json(res, 409, { error: '这张二维码已经用过了' });
    t.status = 'scanned'; t.scannedAt = Date.now();
    notify(t);
    json(res, 200, { ok: true, device: describeClient(t.ua), label: t.label, ip: t.ip, created: t.created, expiresAt: t.expiresAt, as: id.kind === 'admin' ? null : (id.name || id.user) });
  });

  // ④ 手机确认：按手机身份铸凭据，网页那头的 wait 立刻醒。
  router.on('POST', '/api/pair/approve', async (req, res) => {
    const id = approver(req, res); if (!id) return;
    const t = byKey(await parse(req));
    if (!t || t.status === 'expired') return json(res, 410, { error: '二维码已过期，请在网页上刷新后重扫' });
    if (t.status !== 'pending' && t.status !== 'scanned') return json(res, 409, { error: '这张二维码已经用过了' });
    let cred;
    if (id.kind === 'admin') {
      if (!adminGen) return json(res, 500, { error: '服务端未配置访问令牌' });
      cred = { kind: 'admin', user: null, token: users.createAdminSession({ gen: adminGen, label: describeClient(t.ua) + '（扫码）', ip: t.ip }) };
    } else {
      cred = { kind: 'user', user: id.user, token: users.createSession(id.user) };
    }
    t.cred = cred; t.status = 'approved'; t.approvedAt = Date.now(); t.by = cred.kind === 'admin' ? 'admin' : id.user;
    notify(t);
    console.log(`[pair] ${t.by} approved web login for ${describeClient(t.ua)} (${t.ip})`);
    json(res, 200, { ok: true });
  });

  // ⑤ 手机取消：网页显示「已在手机上取消」。
  router.on('POST', '/api/pair/reject', async (req, res) => {
    const id = approver(req, res); if (!id) return;
    const t = byKey(await parse(req));
    if (!t) return json(res, 404, { error: '二维码无效或已过期' });
    if (t.status === 'pending' || t.status === 'scanned') finish(t, 'rejected');
    json(res, 200, { ok: true });
  });

  // ⑥ 网页领凭据（一次性）：Set-Cookie 给同源在线壳，JSON token 给要走 Bearer 的壳。
  router.on('POST', '/api/pair/claim', async (req, res) => {
    const t = byClaim(await parse(req));
    if (!t) return json(res, 404, { error: 'expired' });
    if (t.status !== 'approved' || !t.cred) return json(res, 409, { status: t.status });
    const c = t.cred;
    t.cred = null;
    finish(t, 'claimed');
    tickets.delete(t.id);
    const cookie = c.kind === 'admin' ? authCookie(req, c.token) : userCookie(req, c.token);
    json(res, 200, { ok: true, kind: c.kind, user: c.user, token: c.token }, { 'Set-Cookie': cookie });
  });

  // ═══ 扫码配对（电脑出码、手机扫码换自己的会话）═══

  // 出示方：管理员（主令牌 / 管理员会话）或普通账号。分享桶、聊天快照这类能力身份出不了码（identify 不带 resolveSnap；share 不是 admin/user）。
  // 另认本机命令行（`node src/cli.mjs pair`，s1-linux 线 src/cli/access.mjs）：回环直连、不带任何代理头、Bearer 主机密钥
  // （config.json 的 remotePcSecret）——config.json 只存了令牌哈希时命令行拿不到明文主令牌，就靠它；当管理员出码。
  // sid = 出示方这次登录的会话 id：票绑在它上面——这次登录被退出 / 吊销 / 改密码踢掉后，3 分钟内领到的票也跟着作废
  // （手机被偷、本人改了密码，事先开着的出码卡不能再换回一张新会话）。主令牌 / 主机密钥出码没有会话可绑，只认主令牌指纹。
  const presenter = (req, res) => {
    const id = identify(req);
    const admin = id.kind === 'admin' || (isLocalDirect(req) && hostSecretOk(req));
    if (admin) {
      // 本机无鉴权调试实例只听回环：手机本来就连不上，也没有主令牌可以绑
      if (NO_AUTH || !adminGen) { json(res, 400, { error: '这个实例只允许本机访问，用不着配对' }); return null; }
      let sid = '';
      if (id.kind === 'admin' && adminCredential) {
        try { const c = adminCredential(req); if (c && c.via === 'session' && c.token) sid = users.adminSessionIdOf(c.token); } catch {}
      }
      return sid ? { kind: 'admin', gen: adminGen, sid } : { kind: 'admin', gen: adminGen };
    }
    // user = 账号 id（S2-4 起不可变；老账号 = 用户名），票与会话都挂在它上面；name = 登录名，只用来显示
    if (id.kind === 'user' && id.user) return { kind: 'user', user: id.user, name: id.name || id.user, ...(id.sid ? { sid: String(id.sid) } : {}) };
    json(res, 401, { error: '请先登录' });
    return null;
  };
  // 局域网候选只进管理员出的码（与 /api/app/server-info 同一口径：暴露内网拓扑）；按服务端实际监听的地址算——
  // 只听本机（新装的 Linux 无界面形态、config.json 的 bindHost=127.0.0.1）时没有局域网候选，码里就不会放手机连不上的地址
  const lanFor = (owner) => (owner.kind === 'admin' && typeof lanIPs === 'function' ? lanCandidates(lanIPs, { bind: listenHost }) : []);
  const ticketView = (tk, owner, preferred = '') => {
    const lan = lanFor(owner);
    const pick = pickOrigin({ publicOrigin: PUBLIC_ORIGIN, preferred, lan, fallback: 'http://127.0.0.1:' + PORT });
    let sid = '';
    try { sid = serverAddress().load().id; } catch {}
    const url = connectUrl({ origin: pick.origin, id: tk.id, secret: tk.secret, lan, sid });
    let svg = '';
    try { svg = qrSvg(url); } catch {}
    return {
      id: tk.id, code: tk.code, codeText: fmtCode(tk.code), expiresAt: tk.expiresAt, ttl: CONNECT_TTL,
      url, origin: pick.origin, reachable: pick.reachable, via: pick.via, lan, svg,
      as: owner.kind === 'admin' ? { kind: 'admin' } : { kind: 'user', user: owner.name || owner.user },
    };
  };
  const stillValid = (owner) => {
    if (owner.kind === 'admin') {
      if (!adminGen || owner.gen !== adminGen) return false;
      return owner.sid ? users.adminLoginAlive(owner.sid, adminGen) : true;
    }
    if (owner.sid) return users.loginState(owner.sid) === 'ok';
    const u = users.getUser(owner.user);
    return !!u && !u.disabled;
  };
  const issue = (owner, { device, ip }) => {
    if (owner.kind === 'admin') {
      const token = users.createAdminSession({ gen: adminGen, label: device + '（扫码配对）', ip });
      return { kind: 'admin', user: null, token, sessionRef: { kind: 'admin', id: users.adminSessionIdOf(token) } };
    }
    const token = users.createSession(owner.user);
    const rec = users.getUser(owner.user);   // 回包里的 user 给界面显示：登录名（改过名就是新名字）
    return { kind: 'user', user: rec?.name || owner.name || owner.user, token, sessionRef: { kind: 'user', token } };
  };
  const revokeSession = (ref) => {
    if (ref.kind === 'admin') users.revokeAdminSessions([ref.id]);
    else users.deleteSession(ref.token);
  };

  // ① 出示方领票。body.origin = 出示方页面自己的地址（没有公网地址时码里放它）。
  router.on('POST', '/api/pair/connect', async (req, res) => {
    const owner = presenter(req, res); if (!owner) return;
    const body = await parse(req);
    const tk = connect.mint(owner, { ip: clientIp(req), ua: req.headers['user-agent'] || '', via: String(body.via || '').slice(0, 20) });
    if (tk.error) return json(res, tk.status || 400, { error: tk.error });
    json(res, 200, ticketView(tk, owner, String(body.origin || '')));
  });

  // ② 出示方长轮询：pending → redeemed（谁、从哪）/ expired / cancelled / revoked
  router.on('POST', '/api/pair/connect/wait', async (req, res) => {
    const owner = presenter(req, res); if (!owner) return;
    const body = await parse(req);
    const v = await connect.wait(String(body.id || ''), owner, String(body.status || 'pending'), {
      hold: WAIT_HOLD, onClose: (fin) => res.on('close', fin),
    });
    if (res.writableEnded || res.destroyed || res.socket?.destroyed) return;
    if (!v) return json(res, 404, { status: 'gone' });
    json(res, 200, v);
  });

  // ③ 出示方作废没用过的票（关掉出码页面、点「换一个」）
  router.on('POST', '/api/pair/connect/cancel', async (req, res) => {
    const owner = presenter(req, res); if (!owner) return;
    const body = await parse(req);
    json(res, 200, { ok: connect.cancel(String(body.id || ''), owner) });
  });

  // ④ 出示方「不是我？撤销」：兑换后 10 分钟内可以把刚发出去的会话收回
  router.on('POST', '/api/pair/connect/revoke', async (req, res) => {
    const owner = presenter(req, res); if (!owner) return;
    const body = await parse(req);
    const ok = connect.revoke(String(body.id || ''), owner, revokeSession);
    // 过了 10 分钟（票已清掉）：告诉他去哪收回——管理员会话在控制台逐个吊销；账号会话改一次密码，别的设备全部下线
    if (!ok) return json(res, 409, { error: owner.kind === 'admin' ? '这次配对已经撤销不了了：去「管理员登录」或「设备」里单独吊销那台设备' : '这次配对已经撤销不了了：在「设置 › 账户」改一次密码，别的设备上的登录会全部下线' });
    console.log('[pair] connect session revoked by ' + (owner.kind === 'admin' ? 'admin' : owner.user));
    json(res, 200, { ok: true });
  });

  // ⑤ 管理员：最近的配对记录（只有元数据）
  router.on('GET', '/api/pair/connect/audit', async (req, res) => {
    if (identify(req).kind !== 'admin') return json(res, 401, { error: 'unauthorized' });
    json(res, 200, { entries: await readPairAudit({ limit: 100 }) });
  });

  // ⑥ 兑换（无鉴权）：手机 App 扫码 / 手输配对码，或手机浏览器经系统相机打开 ?connect= 网址。
  router.on('POST', '/api/pair/redeem', async (req, res) => {
    const body = await parse(req);
    const ip = rateIp(req);
    const cred = body.code != null && !body.id ? { code: String(body.code) } : { id: String(body.id || ''), secret: String(body.secret || '') };
    const device = redeemerLabel(req.headers['user-agent'] || '', body.client === 'app' ? 'app' : 'web');
    const prev = body.replace === true ? previousLogin(req) : null;   // 兑换前先记下原来的登录（兑换成功才退出它）
    const r = connect.redeem(cred, { ip, device, validate: stillValid, issue });
    if (!r.ok) return json(res, r.status || 400, { error: r.error });
    const c = r.cred;
    console.log(`[pair] connect: ${c.kind === 'admin' ? 'admin' : c.user} session issued to ${device} (${ip})`);
    let address = null;
    try { address = serverAddress().snapshot({ publicOrigin: PUBLIC_ORIGIN || '', lan: c.kind === 'admin' ? lanFor(r.owner) : null }); } catch {}
    const cookies = [c.kind === 'admin' ? authCookie(req, c.token) : userCookie(req, c.token)];
    if (prev) {
      const n = dropPrevious(prev, c.token);
      // 换成账号会话时把管理员 cookie 清掉（否则它优先、身份换不过来）；换成管理员会话时清掉账号 cookie
      if (c.kind === 'user' && clearAuthCookie) cookies.push(clearAuthCookie(req));
      if (c.kind === 'admin' && clearUserCookie) cookies.push(clearUserCookie(req));
      if (n) console.log(`[pair] connect: replaced ${n} previous sign-in(s) on ${device}`);
    }
    json(res, 200, { ok: true, kind: c.kind, user: c.user, token: c.token, publicOrigin: PUBLIC_ORIGIN || '', address }, { 'Set-Cookie': cookies.length > 1 ? cookies : cookies[0] });
  });

  // 这个请求原来带着的登录（网页上已登录时扫 / 点开配对码，用户在确认卡上同意了「现在的登录会被替换」）：
  // 账号会话令牌（cookie / Bearer）、管理员会话。主令牌本身退不出去，只清 cookie。
  function previousLogin(req) {
    const userToks = [getCookie ? getCookie(req, 'bridge_user') : '', bearerToken ? bearerToken(req) : ''].filter(Boolean);
    let adminSession = '';
    if (adminCredential) { try { const a = adminCredential(req); if (a && a.via === 'session') adminSession = a.token; } catch {} }
    return { userToks: [...new Set(userToks)], adminSession };
  }
  function dropPrevious(prev, keep) {
    let n = 0;
    for (const tok of prev.userToks) {
      if (tok === keep || !users.getSession(tok)) continue;
      users.deleteSession(tok); n++;
    }
    if (prev.adminSession && prev.adminSession !== keep) {
      try { n += users.revokeAdminSessions([users.adminSessionIdOf(prev.adminSession)]); } catch {}
    }
    return n;
  }
}
