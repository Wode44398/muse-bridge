// 插件的入站回调：ctx.webhook(name, handler, { verify, methods?, maxBytes?, perMinute? }) → /hook/<插件 id>/<name>
//
// 外部平台（QQ 协议端的 HTTP 上报、GitHub、支付回调……）往 bridge 推消息时用。这些请求没有 bridge 登录态，
// 所以必须声明至少一种校验，不声明就挂不上：
//   verify.loopbackOnly: true      只收本机直连（runtime/host-secret.mjs isLocalDirect：回环 + 不带任何代理 / 隧道头——
//                                  cloudflared 也是从本机连进来的，光看来源地址不够）
//   verify.secret + verify.header  请求头里带共享密钥（header 缺省 authorization，'Bearer <密钥>' 与裸密钥都认），定长比较
//   verify.hmac: { secret, header, algo?, prefix? }   对原始请求体做 HMAC（algo 缺省 sha256；prefix 如 GitHub 的 'sha256='）
// 多种同时写 = 都要满足。handler(req, res, { body: Buffer, text(), json(), url })；没回响应就自动回 200 {}。
// 缺省只收 POST、请求体上限 1MB、每分钟 600 次（超了 429）。

import crypto from 'node:crypto';
import { isLocalDirect } from '../runtime/host-secret.mjs';

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/i;

export const webhookPath = (pluginId, name) => `/hook/${pluginId}/${name}`;

function safeEqual(a, b) {
  const x = Buffer.from(String(a || '')), y = Buffer.from(String(b || ''));
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}

function readRaw(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > max) { const e = new Error('too large'); e.status = 413; reject(e); req.removeAllListeners('data'); req.resume(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function checkVerifySpec(v) {
  if (!v || typeof v !== 'object') throw new Error('ctx.webhook 必须写 verify（loopbackOnly / secret / hmac 至少一种）');
  const any = v.loopbackOnly === true || !!v.secret || !!(v.hmac && v.hmac.secret);
  if (!any) throw new Error('ctx.webhook 的 verify 至少要一种：loopbackOnly: true / secret / hmac: { secret, header }');
  if (v.hmac && !v.hmac.header) throw new Error('verify.hmac 要写 header（签名放在哪个请求头）');
}

// 校验一个请求；不通过返回 [状态码, 原因]，通过返回 null。body 只有 hmac 时才需要。
export function verifyRequest(req, v, body) {
  if (v.loopbackOnly && !isLocalDirect(req)) return [403, '只收本机直连的请求'];
  if (v.secret) {
    const raw = String(req.headers[String(v.header || 'authorization').toLowerCase()] || '');
    const got = raw.replace(/^Bearer\s+/i, '').trim();
    if (!safeEqual(got, String(v.secret))) return [401, '密钥不对'];
  }
  if (v.hmac && v.hmac.secret) {
    const algo = v.hmac.algo || 'sha256';
    const sig = String(req.headers[String(v.hmac.header).toLowerCase()] || '');
    const want = (v.hmac.prefix || '') + crypto.createHmac(algo, String(v.hmac.secret)).update(body || Buffer.alloc(0)).digest('hex');
    if (!safeEqual(sig, want)) return [401, '签名不对'];
  }
  return null;
}

// 每个插件一份。hooks：给状态 / 详情页列出挂了哪些回调。
export function makeWebhookService(ctx, sendJson) {
  const hooks = new Map();   // name → { path, methods, verifyKinds }
  const fn = (name, handler, opts = {}) => {
    if (!NAME_RE.test(String(name || ''))) throw new Error('回调名只能用字母、数字、- 和 _（≤48 字）');
    if (typeof handler !== 'function') throw new Error('ctx.webhook 要 handler');
    checkVerifySpec(opts.verify);
    const v = opts.verify;
    const methods = (Array.isArray(opts.methods) && opts.methods.length ? opts.methods : ['POST']).map((m) => String(m).toUpperCase());
    const max = Math.max(1024, Math.min(20 * 1024 * 1024, Number(opts.maxBytes) || 1_000_000));
    const perMinute = Math.max(1, Number(opts.perMinute) || 600);
    let windowStart = 0, count = 0;
    const p = webhookPath(ctx.id, name);
    const wrapped = async (req, res, url) => {
      const now = Date.now();
      if (now - windowStart > 60_000) { windowStart = now; count = 0; }
      if (++count > perMinute) { sendJson(res, 429, { error: 'too many requests' }); return; }
      // 不需要读体的校验先做（省得给不合格的请求读 20MB）
      const early = verifyRequest(req, { ...v, hmac: null }, null);
      if (early) { sendJson(res, early[0], { error: early[1] }); return; }
      let body;
      try { body = req.method === 'GET' || req.method === 'HEAD' ? Buffer.alloc(0) : await readRaw(req, max); }
      catch (e) { sendJson(res, e.status || 400, { error: e.status === 413 ? '请求体太大' : '读请求体失败' }); return; }
      if (v.hmac && v.hmac.secret) {
        const bad = verifyRequest(req, { hmac: v.hmac }, body);
        if (bad) { sendJson(res, bad[0], { error: bad[1] }); return; }
      }
      const extra = {
        body, url,
        text: () => body.toString('utf8'),
        json: () => { try { return body.length ? JSON.parse(body.toString('utf8')) : {}; } catch { return null; } },
      };
      try {
        await handler(req, res, extra);
        if (!res.writableEnded && !res.headersSent) sendJson(res, 200, {});
      } catch (e) {
        ctx.error(`回调 ${name} 出错：`, e?.message || e);
        if (!res.writableEnded) sendJson(res, 500, { error: 'plugin error' });
      }
    };
    ctx.router.on(methods, p, wrapped);
    hooks.set(name, { name, path: p, methods, verify: [v.loopbackOnly && 'loopback', v.secret && 'secret', v.hmac?.secret && 'hmac'].filter(Boolean) });
    ctx.onDispose(() => hooks.delete(name));
    return p;
  };
  fn.list = () => [...hooks.values()];
  return fn;
}
