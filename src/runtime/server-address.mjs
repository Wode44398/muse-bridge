// 服务器身份与地址簿（开源路线 S1-1「地址变了，自己找回来」）。
//
// 为什么要有：快速隧道（*.trycloudflare.com）每起一次就换一个地址——电脑重启、服务端重启 / 更新、看门狗换隧道都会换。
// 以前新地址只推给在线的管理员控制台，App 只存一个 base、从不回写，于是「在家重启电脑 → 出门」手机就失联了。
// 现在：
//   · 服务器有一个稳定的身份（id + ECDSA P-256 密钥对，存数据根 server-identity.json，0600）。
//     已登录的设备经 /api/app/server-info 拿到 id、公钥、当前公网地址、地址类型（临时 / 固定）、局域网候选（只给管理员）。
//   · 地址一变（含「先接后拆」时新隧道已连上、旧的还没拆的那一刻），经总线推 {type:'server.address'} 给所有在线设备
//     （不只管理员）：在线的设备在旧地址断开之前就知道新地址。
//   · 设备离线后换候选地址（局域网 / 上一个公网地址 / 刚推来的新地址）时，先调 /api/app/hello?n=<随机数>，
//     用存下的公钥验签，签名原文绑上服务器看到的 Host——确认对面就是同一台服务器、且是经这个地址到的它，再把凭据发过去。
//     它防的是「误连」：局域网同一个 IP:端口上换成了别人的 bridge、临时域名被回收给了别人、经别人的隧道把 hello 转发过来
//     （Cloudflare 转发时 Host 是隧道自己的域名，签名对不上）。它挡不住能直连这台服务器、自己改写 Host 的转发者，
//     也挡不住明文 http 上的窃听——那得靠 https / 固定域名，不是这一层的事。
// 不依赖任何项目方服务：会合点（S1-10）是第二批的事。
//
// 不含任何凭据：公钥本来就是公开的，私钥只在服务端数据根里；id 只是随机串。
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DATA_ROOT } from './paths.mjs';

export const HELLO_PREFIX = 'bridge-hello:v2:';
const RECENT_MAX = 6;

// —— 纯函数（单测覆盖）———————————————————————————————————————————————————————

/** 地址的种类：临时（快速隧道 / trycloudflare）、固定（自己的域名、命名隧道、手填）、没有公网地址。 */
export function classifyOrigin(origin, mode = '') {
  const o = String(origin || '');
  if (!o) return 'none';
  if (mode === 'quick') return 'temporary';
  try { if (/\.trycloudflare\.com$/i.test(new URL(o).hostname)) return 'temporary'; } catch { return 'none'; }
  return 'fixed';
}

/** hello 的随机数：16–128 位 base64url / 十六进制。不合规回 ''。 */
export function cleanNonce(n) {
  const s = String(n || '');
  return /^[A-Za-z0-9_-]{16,128}$/.test(s) ? s : '';
}

/**
 * Host 的规范写法（服务端看到的 Host 头 / 客户端自己访问的 URL 的 host 都过一遍，两边才比得上）：
 * 小写、去掉末尾的点和默认端口（:80 / :443——隧道 / 反代后面服务端不知道外面是 http 还是 https，两个都去）。
 */
export function normalizeHelloHost(h) {
  return String(h || '').trim().toLowerCase().replace(/\.(?=:\d+$|$)/, '').replace(/:(80|443)$/, '').slice(0, 255);
}

/** 签名的原文：前缀 + 随机数 + 服务器 id + 服务端看到的 Host（绑上 id 不能冒充另一台；绑上 Host 经别的地址转发过来的对不上）。 */
export const helloMessage = (nonce, id, host = '') => HELLO_PREFIX + nonce + ':' + id + ':' + normalizeHelloHost(host);

/** 最近用过的公网地址（新的在前、去重、限长）。 */
export function pushRecent(list, origin, max = RECENT_MAX) {
  const o = String(origin || '');
  const out = (Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && x && x !== o);
  if (o) out.unshift(o);
  return out.slice(0, max);
}

// —— 身份 ————————————————————————————————————————————————————————————————————

/**
 * @param {object} [o]
 * @param {string} [o.dataRoot]  身份文件所在目录（默认数据根）
 */
export function createServerAddress(o = {}) {
  const FILE = path.join(o.dataRoot || DATA_ROOT, 'server-identity.json');
  let ident = null;            // { id, priv(KeyObject), pubJwk, recent[] }
  let lastPublished = '';      // 上一次推出去的公网地址（同一个地址不重复推）

  function persist(rec) {
    mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = FILE + '.tmp';
    writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 });
    renameSync(tmp, FILE);
    try { chmodSync(FILE, 0o600); } catch {}
  }

  function load() {
    if (ident) return ident;
    let rec = null;
    try { rec = JSON.parse(readFileSync(FILE, 'utf8').replace(/^﻿/, '')); } catch {}
    try {
      if (rec && /^srv_[0-9a-f]{20}$/.test(String(rec.id || '')) && rec.privateKey) {
        const priv = createPrivateKey({ key: String(rec.privateKey), format: 'pem' });
        const pubJwk = createPublicKey(priv).export({ format: 'jwk' });
        ident = { id: rec.id, priv, pubJwk: { kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x, y: pubJwk.y }, recent: pushRecent(rec.recent, '') };
        return ident;
      }
    } catch { /* 文件坏了：重新生成（已配对设备会把它当成另一台服务器，重新登录即可） */ }
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const id = 'srv_' + randomBytes(10).toString('hex');
    const pubJwk = publicKey.export({ format: 'jwk' });
    ident = { id, priv: privateKey, pubJwk: { kty: pubJwk.kty, crv: pubJwk.crv, x: pubJwk.x, y: pubJwk.y }, recent: [] };
    try { persist({ id, privateKey: privateKey.export({ format: 'pem', type: 'pkcs8' }), recent: [], createdAt: new Date().toISOString() }); }
    catch (e) { console.warn('[address] 写不进 server-identity.json：' + (e?.message || e)); }
    return ident;
  }

  function saveRecent() {
    const me = load();
    try {
      let rec = {};
      try { rec = JSON.parse(readFileSync(FILE, 'utf8').replace(/^﻿/, '')); } catch {}
      if (!rec.privateKey) return;
      persist({ ...rec, recent: me.recent });
    } catch {}
  }

  /** 公钥指纹（给人核对用，短）：SHA-256(x||y) 前 8 字节。 */
  function fingerprint() {
    const me = load();
    return createHash('sha256').update(me.pubJwk.x + '.' + me.pubJwk.y).digest('hex').slice(0, 16);
  }

  /**
   * /api/app/hello：对「随机数 + id + 这次请求的 Host」签名。签名是 IEEE-P1363（r||s，WebCrypto 认的格式），base64url。
   * host 只认请求自己的 Host 头，不认 X-Forwarded-Host（经 Cloudflare 转发时谁都能塞一个进来，认了等于不绑）。
   * 回包里的 host 只给排查看：客户端拿自己访问的地址验签，不信它。
   */
  function hello(nonce, host = '') {
    const me = load();
    const n = cleanNonce(nonce);
    if (!n) return { ok: true, id: me.id, alg: 'ES256', v: 2 };   // 没给随机数：只报 id（探活用）
    const h = normalizeHelloHost(host);
    const sig = cryptoSign('sha256', Buffer.from(helloMessage(n, me.id, h)), { key: me.priv, dsaEncoding: 'ieee-p1363' });
    return { ok: true, id: me.id, alg: 'ES256', v: 2, host: h, sig: sig.toString('base64url') };
  }

  /**
   * 给已登录设备的地址快照。
   * @param {object} p
   * @param {string} p.publicOrigin  当前公网地址（运行态 PUBLIC_ORIGIN）
   * @param {string} [p.mode]        公网访问方式（off / quick / token / manual；外部托管时按 off）
   * @param {string[]} [p.lan]       局域网候选（http://ip:port）；只给管理员（暴露内网拓扑）
   */
  function snapshot({ publicOrigin = '', mode = '', lan = null } = {}) {
    const me = load();
    const out = {
      id: me.id,
      pub: { ...me.pubJwk },
      fp: fingerprint(),
      publicOrigin: publicOrigin || '',
      kind: classifyOrigin(publicOrigin, mode),
      recent: me.recent.filter((x) => x !== publicOrigin),
    };
    if (Array.isArray(lan)) out.lan = lan.slice(0, 6);
    return out;
  }

  /**
   * 公网地址变了 / 马上要变：记进最近地址，返回要推给所有设备的事件（没变返回 null）。
   * next=true：「先接后拆」时新隧道已连上、旧的还在——推的是即将生效的地址（设备先验证、能通就换过去）。
   */
  function noteOrigin(origin, { mode = '', next = false } = {}) {
    const me = load();
    const o = String(origin || '');
    if (!o) return null;
    if (!next && o === lastPublished) return null;
    const before = me.recent.join('|');
    me.recent = pushRecent(me.recent, o);
    if (me.recent.join('|') !== before) saveRecent();
    if (!next) lastPublished = o;
    return { type: 'server.address', id: me.id, publicOrigin: next ? '' : o, ...(next ? { next: o } : {}), kind: classifyOrigin(o, mode), at: Date.now() };
  }

  return { load, hello, snapshot, noteOrigin, fingerprint, file: FILE, _reset: () => { ident = null; lastPublished = ''; } };
}

// —— 单例 ————————————————————————————————————————————————————————————————————
let singleton = null;
export function serverAddress() {
  if (!singleton) singleton = createServerAddress();
  return singleton;
}
