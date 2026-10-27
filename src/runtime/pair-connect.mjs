// 扫码配对（开源路线 S1-2）：电脑出码，手机扫一下换到自己的长期会话——不用手抄地址和 32 位令牌。
//
// 和「扫码登录」（routes/pair.mjs 前半：网页出码、已登录的手机替它确认）方向相反：
//   出示方 = 已登录的一方（桌面客户端完成页 / 托盘「访问信息」、网页设置「连接与更新」、控制台、Linux 终端）。
//   兑换方 = 还没登录的手机 App / 手机浏览器。
//
// 一张配对票：
//   · id + secret（进二维码，128 位以上随机，扫码走这条）；
//   · 8 位数字配对码（同一张票的另一把钥匙，给没有相机的情况手输）；
//   · 3 分钟过期、只能兑换一次、出示方随时可以作废；兑换后 10 分钟内出示方还能「不是我？撤销」把刚发出去的会话收回。
//   · 只换「普通会话」：出示方是管理员 → 一张管理员会话（控制台「管理员登录」里能单独吊销，主令牌一换全部作废）；
//     出示方是普通账号 → 他自己的账号会话（档位、额度、工具围栏全照他本人）。永远拿不到主令牌，也不能借票提权。
//   · 兑换时再核一次出示方：管理员的主令牌换过了、账号被停用 / 删除了，票作废。
// 限流：每个出示方最多同时 4 张票（多了作废最旧的）、10 分钟最多领 40 张；兑换按来源 IP 记失败（15 分钟 10 次封 15 分钟），
// 数字码另有全服失败闸（10 分钟 30 次就暂停数字码兑换 10 分钟，扫码那条不受影响）——8 位数字 1 亿种，3 分钟里猜中的概率可以忽略。
// 兑换不用鉴权、来源 IP 又可能是伪造的代理头：按 IP 的失败表有条数上限（超了先清过期的、再丢最旧的），失败 / 封禁的审计
// 全服每分钟最多逐条记 30 行，多出来的只记一行「另有 N 次」——换着 IP 刷错码也撑不爆内存和磁盘。
// 审计：数据根 logs/pair/pair-YYYY-MM-DD.jsonl，只记元数据（谁出的码、谁在什么时候从哪兑换、失败原因），不记 secret、数字码与会话令牌。
// 票全在内存里，服务重启即清零（正在出示的页面会自动领新票）。
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { DATA_ROOT } from './paths.mjs';
import { ownerKey } from './principal.mjs';

export const CONNECT_TTL = 3 * 60 * 1000;
export const KEEP_DONE = 10 * 60 * 1000;
const MAX_LIVE = 300;
const PER_OWNER_LIVE = 4;
const MINT_RULE = { max: 40, window: 10 * 60 * 1000 };
const IP_RULE = { max: 10, window: 15 * 60 * 1000, lock: 15 * 60 * 1000 };
const CODE_RULE = { max: 30, window: 10 * 60 * 1000, lock: 10 * 60 * 1000 };
const IP_TABLE_MAX = 2000;                          // 按 IP 的失败表最多记这么多来源
const FAIL_AUDIT = { max: 30, window: 60 * 1000 };  // 失败 / 封禁审计：全服每分钟最多逐条记这么多行

// —— 纯函数（单测覆盖）———————————————————————————————————————————————————————

const rid = (n) => randomBytes(n).toString('base64url');
export function safeEq(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** 用户输入的数字配对码 → 8 位数字（容忍空格、短横线、全角数字）；不合规回 ''。 */
export function normCode(s) {
  const d = String(s || '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[\s-]/g, '');
  return /^\d{8}$/.test(d) ? d : '';
}
/** 给人看的写法：1234 5678 */
export const fmtCode = (c) => (/^\d{8}$/.test(String(c)) ? String(c).slice(0, 4) + ' ' + String(c).slice(4) : String(c || ''));

const LOOPBACK = /^(127\.|localhost$|::1$|\[::1\]$|0\.0\.0\.0$)/i;
const PRIVATE_V4 = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/** http(s) 网址的 origin；不是 http(s) 回 ''。 */
export function originOf(u) {
  try { const x = new URL(String(u || '')); return x.protocol === 'http:' || x.protocol === 'https:' ? x.origin : ''; } catch { return ''; }
}
const hostOf = (o) => { try { return new URL(o).hostname.replace(/^\[|\]$/g, ''); } catch { return ''; } };
export const isLoopbackOrigin = (o) => LOOPBACK.test(hostOf(o));
export const isPrivateOrigin = (o) => { const h = hostOf(o); return PRIVATE_V4.test(h) || /\.local$/i.test(h); };

/**
 * 二维码里放哪个地址（手机拿它去兑换，App 也把它存成服务器地址）：
 *   ① 服务器当前的公网地址——出了门也连得上（在家时 App 会自动切局域网直连）；
 *   ② 出示方页面自己的地址（不是回环、不是 App 的本地源）——他就是经它连上的，手机多半也行；
 *   ③ 第一个局域网候选；
 *   都没有 → 回环地址（reachable=false：界面提示「手机连不上：服务器只允许本机访问」）。
 */
export function pickOrigin({ publicOrigin = '', preferred = '', lan = [], fallback = '' } = {}) {
  const pub = originOf(publicOrigin);
  if (pub) return { origin: pub, reachable: true, via: 'public' };
  const pre = originOf(preferred);
  if (pre && !isLoopbackOrigin(pre) && !/^appassets\./i.test(hostOf(pre))) return { origin: pre, reachable: true, via: isPrivateOrigin(pre) ? 'lan' : 'page' };
  const l = (lan || []).map(originOf).find(Boolean);
  if (l) return { origin: l, reachable: true, via: 'lan' };
  return { origin: originOf(fallback) || '', reachable: false, via: 'local' };
}

/**
 * 二维码内容：<origin>/?connect=<id>.<secret>&lan=<ip:端口,…>&sid=<服务器 id>
 * 不含任何长期凭据。lan 只放 origin 以外的局域网候选（手机在家、公网暂时不通时换着试）；sid 让 App 兑换之前
 * 先用 /api/app/hello 认一下对面是不是同一台服务器（局域网同一个 IP 上换成了别人的 bridge 时不把票送过去）。
 */
export function connectUrl({ origin, id, secret, lan = [], sid = '' }) {
  const base = originOf(origin) || origin;
  const others = (lan || []).map(originOf).filter((o) => o && o !== base)
    .map((o) => { try { const u = new URL(o); return u.host; } catch { return ''; } }).filter(Boolean).slice(0, 3);
  let q = '?connect=' + id + '.' + secret;
  if (others.length) q += '&lan=' + others.join(',');
  if (/^srv_[0-9a-f]{20}$/.test(String(sid || ''))) q += '&sid=' + sid;
  return base + '/' + q;
}

// —— 审计 ——————————————————————————————————————————————————————————————————————

export const PAIR_LOG_DIR = path.join(DATA_ROOT, 'logs', 'pair');
let dirReady = null;
const stamp = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** 落一条审计。永不抛。 */
export async function pairAudit(entry, dir = PAIR_LOG_DIR) {
  try {
    if (dir === PAIR_LOG_DIR) await (dirReady ||= mkdir(dir, { recursive: true }).catch(() => {}));
    else await mkdir(dir, { recursive: true });
    await appendFile(path.join(dir, `pair-${stamp()}.jsonl`), JSON.stringify({ t: new Date().toISOString(), ...entry }) + '\n', 'utf8');
  } catch { /* 尽力而为 */ }
}

/** 最近的审计（新的在前），控制台看。 */
export async function readPairAudit({ limit = 100, dir = PAIR_LOG_DIR } = {}) {
  const out = [];
  let files = [];
  try { files = (await readdir(dir)).filter((f) => /^pair-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse(); } catch { return out; }
  for (const f of files.slice(0, 14)) {
    let text = '';
    try { text = await readFile(path.join(dir, f), 'utf8'); } catch { continue; }
    for (const line of text.split('\n').filter(Boolean).reverse()) {
      try { out.push(JSON.parse(line)); } catch { continue; }
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// —— 票仓 ————————————————————————————————————————————————————————————————————

/**
 * @param {object} [o]
 * @param {() => number} [o.now]
 * @param {(e: object) => void} [o.audit]  审计落点（测试里换成数组）
 */
export function createConnectStore({ now = () => Date.now(), audit = (e) => { pairAudit(e); } } = {}) {
  const tickets = new Map();   // id -> ticket
  const byCode = new Map();    // 8 位码 -> id
  const mints = new Map();     // ownerKey -> [时刻…]
  const ipFails = new Map();   // ip -> { at: [时刻…], until }
  let codeFails = [], codeLockUntil = 0;
  let failAudits = [], failDropped = 0, failDroppedSince = 0;   // 失败审计的限速（见文件头）

  // 失败 / 封禁审计走这里：每分钟逐条记 FAIL_AUDIT.max 行，多的只计数，下一次能记时补一行 { ev:'fail', why:'suppressed', n }
  function flushDropped(n) {
    if (!failDropped) return;
    failAudits.push(n);
    audit({ ev: 'fail', why: 'suppressed', n: failDropped, since: new Date(failDroppedSince).toISOString() });
    failDropped = 0; failDroppedSince = 0;
  }
  function auditFail(entry) {
    const n = now();
    failAudits = failAudits.filter((x) => n - x < FAIL_AUDIT.window);
    if (failAudits.length >= FAIL_AUDIT.max) { if (!failDropped) failDroppedSince = n; failDropped++; return; }
    flushDropped(n);
    failAudits.push(n);
    audit(entry);
  }

  const ownerKeyOf = (o) => (o.kind === 'admin' ? 'admin' : o.user ? ownerKey('user', o.user) : 'u:');   // owner 键只经 principal 生成（C2）
  const who = (o) => (o.kind === 'admin' ? 'admin' : o.user);

  function notify(t) {
    const ws = t.waiters; t.waiters = new Set();
    for (const w of ws) { try { w(); } catch {} }
  }
  function finish(t, status) {
    if (t.status !== 'pending' && status !== 'revoked' && status !== 'gone') return;
    t.status = status; t.finishedAt = now();
    byCode.delete(t.code);
    notify(t);
  }
  // 过期不记审计：出码页面开着时每 3 分钟自动换一张，记下来全是噪音（领票那条已经记了）
  function expireCheck(t, n = now()) {
    if (t.status === 'pending' && n > t.expiresAt) finish(t, 'expired');
  }
  function prune() {
    const n = now();
    for (const t of tickets.values()) {
      expireCheck(t, n);
      if (t.finishedAt && n - t.finishedAt > KEEP_DONE) { t.sessionRef = null; tickets.delete(t.id); }
    }
    pruneIpFails(n);
    for (const [k, v] of mints) { const left = v.filter((x) => n - x < MINT_RULE.window); if (left.length) mints.set(k, left); else mints.delete(k); }
    failAudits = failAudits.filter((x) => n - x < FAIL_AUDIT.window);
    if (failAudits.length < FAIL_AUDIT.max) flushDropped(n);
  }
  function pruneIpFails(n) {
    for (const [k, v] of ipFails) if (v.until < n && !v.at.some((x) => n - x < IP_RULE.window)) ipFails.delete(k);
    // 还是太多（换着 IP 刷）：丢最早记下的（Map 按插入顺序），没封着的先丢
    if (ipFails.size <= IP_TABLE_MAX) return;
    for (const [k, v] of ipFails) { if (ipFails.size <= IP_TABLE_MAX) return; if (!(v.until > n)) ipFails.delete(k); }
    for (const k of ipFails.keys()) { if (ipFails.size <= IP_TABLE_MAX) return; ipFails.delete(k); }
  }
  const timer = setInterval(prune, 15000);
  timer.unref?.();

  function newCode() {
    for (let i = 0; i < 20; i++) {
      const c = String(randomInt(0, 100_000_000)).padStart(8, '0');
      if (!byCode.has(c)) return c;
    }
    return '';
  }

  /**
   * 出示方领一张票。owner = { kind:'admin', gen } | { kind:'user', user }。
   * 返回 { id, secret, code, expiresAt } 或 { error, status }。
   */
  function mint(owner, { ip = '', ua = '', via = '' } = {}) {
    prune();
    if (!owner || (owner.kind !== 'admin' && !(owner.kind === 'user' && owner.user))) return { error: '只有登录的账号能出配对码', status: 401 };
    const key = ownerKeyOf(owner);
    const n = now();
    const recent = (mints.get(key) || []).filter((x) => n - x < MINT_RULE.window);
    if (recent.length >= MINT_RULE.max) return { error: '配对码领得太频繁，请稍后再试', status: 429 };
    let live = 0;
    for (const t of tickets.values()) if (t.status === 'pending') live++;
    if (live >= MAX_LIVE) return { error: '配对请求过多，请稍后再试', status: 429 };
    // 同一个出示方手里的码多了：作废最旧的（页面反复打开、多个窗口同时开着都不该卡住）
    const mine = [...tickets.values()].filter((t) => t.ownerKey === key && t.status === 'pending').sort((a, b) => a.created - b.created);
    while (mine.length >= PER_OWNER_LIVE) finish(mine.shift(), 'cancelled');
    const code = newCode();
    if (!code) return { error: '配对请求过多，请稍后再试', status: 429 };
    const t = {
      id: rid(9), secret: rid(18), code,
      owner: { ...owner }, ownerKey: key,
      created: n, expiresAt: n + CONNECT_TTL,
      status: 'pending', waiters: new Set(), finishedAt: 0,
      redeemed: null, sessionRef: null,
    };
    tickets.set(t.id, t);
    byCode.set(code, t.id);
    recent.push(n); mints.set(key, recent);
    audit({ ev: 'mint', by: who(owner), ip, via: via || undefined, ua: ua ? String(ua).slice(0, 120) : undefined });
    return { id: t.id, secret: t.secret, code: t.code, expiresAt: t.expiresAt };
  }

  function ipLocked(ip, n) {
    const r = ipFails.get(ip);
    return !!(r && r.until > n);
  }
  function noteFail(ip, { code = false, why = '' } = {}) {
    const n = now();
    const r = ipFails.get(ip) || { at: [], until: 0 };
    r.at = r.at.filter((x) => n - x < IP_RULE.window);
    r.at.push(n);
    if (r.at.length >= IP_RULE.max) { r.until = n + IP_RULE.lock; r.at = []; auditFail({ ev: 'lock', ip, why: 'ip' }); }
    ipFails.set(ip, r);
    if (ipFails.size > IP_TABLE_MAX) pruneIpFails(n);
    if (code) {
      codeFails = codeFails.filter((x) => n - x < CODE_RULE.window);
      codeFails.push(n);
      if (codeFails.length >= CODE_RULE.max) { codeLockUntil = n + CODE_RULE.lock; codeFails = []; audit({ ev: 'lock', why: 'code' }); }
    }
    auditFail({ ev: 'fail', ip, via: code ? 'code' : 'qr', why });
  }

  /**
   * 兑换。cred = { id, secret } 或 { code }。
   * hooks.validate(owner) → 出示方还有效吗（主令牌没换、账号还在）；
   * hooks.issue(owner, { device, ip }) → { kind, user, token, sessionRef } 铸会话。
   * 返回 { ok:true, owner, cred:{kind,user,token} } 或 { error, status }。
   */
  function redeem(cred = {}, { ip = '', device = '', validate = () => true, issue } = {}) {
    prune();
    const n = now();
    if (ipLocked(ip, n)) return { error: '尝试次数过多，请 15 分钟后再试', status: 429 };
    const viaCode = !cred.id && cred.code != null;
    let t = null;
    if (viaCode) {
      if (codeLockUntil > n) return { error: '数字配对码暂时停用（失败太多），请改用扫码，或 10 分钟后再试', status: 429 };
      const c = normCode(cred.code);
      const id = c ? byCode.get(c) : '';
      t = id ? tickets.get(id) : null;
      if (!t) { noteFail(ip, { code: true, why: 'bad-code' }); return { error: '配对码不对或已过期，请看电脑上显示的最新配对码', status: 404 }; }
    } else {
      t = tickets.get(String(cred.id || ''));
      if (!t || !safeEq(t.secret, String(cred.secret || ''))) { noteFail(ip, { why: 'bad-qr' }); return { error: '配对二维码无效，请在电脑上刷新后重扫', status: 404 }; }
    }
    expireCheck(t, n);
    if (t.status === 'expired') return { error: '配对码已过期，请在电脑上刷新后重试', status: 410 };
    if (t.status !== 'pending') return { error: '这个配对码已经用过或被作废了，请在电脑上刷新后重试', status: 410 };
    if (!validate(t.owner)) {
      finish(t, 'cancelled');
      audit({ ev: 'fail', ip, via: viaCode ? 'code' : 'qr', why: 'owner-invalid', by: who(t.owner) });
      return { error: '出示这个配对码的登录已失效，请在电脑上重新登录后再出码', status: 410 };
    }
    let out;
    try { out = issue(t.owner, { device, ip }); } catch (e) { return { error: '发放登录失败：' + (e?.message || e), status: 500 }; }
    if (!out || !out.token) return { error: '发放登录失败', status: 500 };
    t.redeemed = { at: n, ip, device, kind: out.kind, user: out.user || null };
    t.sessionRef = out.sessionRef || null;
    finish(t, 'redeemed');
    audit({ ev: 'redeem', by: who(t.owner), as: out.kind === 'admin' ? 'admin' : out.user, ip, device, via: viaCode ? 'code' : 'qr' });
    return { ok: true, owner: t.owner, cred: { kind: out.kind, user: out.user || null, token: out.token } };
  }

  /** 出示方看的状态（不含 secret / code）。 */
  function view(t) {
    const v = { status: t.status, expiresAt: t.expiresAt };
    if (t.redeemed) Object.assign(v, { device: t.redeemed.device, ip: t.redeemed.ip, at: t.redeemed.at, kind: t.redeemed.kind, revocable: !!t.sessionRef && t.status === 'redeemed' });
    return v;
  }
  const own = (id, owner) => {
    const t = tickets.get(String(id || ''));
    return t && owner && t.ownerKey === ownerKeyOf(owner) ? t : null;
  };

  /** 出示方长轮询：状态与 known 不同就立刻回，否则最多挂 hold 毫秒。票不存在 / 不是他的回 null。 */
  async function wait(id, owner, known = 'pending', { hold = 20000, onClose = null } = {}) {
    const t = own(id, owner);
    if (!t) return null;
    expireCheck(t);
    if (t.status !== known) return view(t);
    // 还在等兑换：最多挂到过期那一刻（多 50ms），醒来就回 expired——出码页倒计时到 0 立刻换新码，不用干等下一轮清理
    const ms = t.status === 'pending' ? Math.min(hold, Math.max(0, t.expiresAt - now()) + 50) : hold;
    await new Promise((resolve) => {
      let done = false;
      const fin = () => { if (done) return; done = true; clearTimeout(tm); t.waiters.delete(fin); resolve(); };
      const tm = setTimeout(fin, ms);
      t.waiters.add(fin);
      if (onClose) onClose(fin);
    });
    expireCheck(t);
    return view(t);
  }

  /** 出示方作废还没用的票（关掉出码页面 / 点「换一个」）。 */
  function cancel(id, owner) {
    const t = own(id, owner);
    if (!t) return false;
    if (t.status === 'pending') finish(t, 'cancelled');
    return true;
  }

  /** 出示方「不是我？撤销」：收回刚发出去的会话。hooks.revoke(sessionRef) 真去删。 */
  function revoke(id, owner, revokeFn) {
    const t = own(id, owner);
    if (!t || t.status !== 'redeemed' || !t.sessionRef) return false;
    try { revokeFn(t.sessionRef); } catch {}
    t.sessionRef = null;
    finish(t, 'revoked');
    audit({ ev: 'revoke', by: who(t.owner), as: t.redeemed?.kind === 'admin' ? 'admin' : t.redeemed?.user, device: t.redeemed?.device });
    return true;
  }

  return {
    mint, redeem, wait, cancel, revoke, view: (id, owner) => { const t = own(id, owner); return t ? view(t) : null; },
    _reset: () => { tickets.clear(); byCode.clear(); mints.clear(); ipFails.clear(); codeFails = []; codeLockUntil = 0; failAudits = []; failDropped = 0; },
    _size: () => tickets.size,
    _ipTableSize: () => ipFails.size,
    stop: () => clearInterval(timer),
  };
}
