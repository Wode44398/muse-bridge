// 扫码登录（未登录的网页 ↔ 已登录的另一台设备，通常是手机浏览器）。
//
// 流程：未登录的网页 POST /api/pair/new 领一张票（id + 两把钥匙），把 id+key 编进二维码；
// 已登录的设备扫到后 POST /api/pair/scan（票进入 scanned，网页立刻显示「已扫描」），
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

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readBody } from '../runtime/body.mjs';
import * as users from '../users.mjs';

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
  const br = /Edg\//i.test(u) ? 'Edge'
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

// 测试用：清空票仓。
export function _resetPairStore() { tickets.clear(); }

export function registerPairRoutes(router, { identify, adminGen, authCookie, userCookie }) {
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
    json(res, 200, { ok: true, device: describeClient(t.ua), label: t.label, ip: t.ip, created: t.created, expiresAt: t.expiresAt, as: id.kind === 'admin' ? null : id.user });
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
}
