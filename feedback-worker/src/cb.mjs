// claude-bridge（The Bridge）的反馈收件箱：别人服务器上的用户反馈经这里汇到开发者那台 bridge。
//
// 跟 Muse 的 /v1/report 互不相干（Muse 那条路一行没动）：
//   POST /v1/cb/report        各台 bridge 服务器推反馈（字段白名单 + 脱敏见 deploy/muse/feedback/cb-schema.mjs）。
//                             不发 GitHub，存进 KV 私有收件箱（cbi:<id>，默认 30 天过期）。
//                             收件箱没配（没有 INBOX_TOKEN）时回 503：对方留在自己的待发队列里，之后补发。
//   GET  /v1/cb/inbox         开发者那台 bridge 来取：列出还没确认的（含图片 base64），?limit= 一次几条（≤25）。
//   POST /v1/cb/inbox/ack     { ids } 写进库之后确认，确认过的从 KV 删掉。
// 后两个只认 Worker secret INBOX_TOKEN（Authorization: Bearer）；没配这个 secret 时一律 404，像不存在一样。
// 限流跟 Muse 分开计数（rl:<日>:cb:*）；PAUSED / cfg:paused 停收对这里同样生效。
import { cleanCbReport, CB_MAX_BODY } from '../../deploy/muse/feedback/cb-schema.mjs';

const json = (code, o) => new Response(JSON.stringify(o), { status: code, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const ID_RE = /^\d{13}-[0-9a-f]{8}$/;

/** 恒定时间比对：两边先各取 SHA-256，再逐字节异或（长度不同也不提前返回） */
async function sameSecret(a, b) {
  const enc = new TextEncoder();
  const [x, y] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', enc.encode(String(s)))));
  const u = new Uint8Array(x), v = new Uint8Array(y);
  let d = 0;
  for (let i = 0; i < u.length; i++) d |= u[i] ^ v[i];
  return d === 0;
}

async function authed(req, env) {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') || '');
  return !!m && (await sameSecret(m[1].trim(), env.INBOX_TOKEN));
}

const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');

export function createCbHandler({ now = () => Date.now(), paused = async () => false } = {}) {
  async function report(req, env) {
    const kv = env.FEEDBACK_KV;
    if (!env.INBOX_TOKEN || !kv) return json(503, { error: 'inbox not configured' });
    if (await paused(env)) return json(503, { error: 'paused' });
    if (Number(req.headers.get('Content-Length')) > CB_MAX_BODY) return json(413, { error: 'too large' });
    const raw = await req.text();
    if (raw.length > CB_MAX_BODY) return json(413, { error: 'too large' });
    let r;
    try { r = cleanCbReport(JSON.parse(raw)); }
    catch (e) { return json(400, { error: String(e?.message || 'bad report') }); }

    // 限流：先全部查完、都过了才写。KV 免费档整个账号每天只有 1000 次写入（跟 Muse 那条路共用），这条路又不要凭据，
    // 所以全局份数和体积合在一个键里（"份数:字节数"）——收下一份只写 3 次（2 个计数 + 报告本身），被拒的一次都不写，
    // 按默认 CB_DAILY_CAP=50 一天最多占 150 次写入。体积也要封顶：一份最多 6MB 图片，光按份数限，被刷的时候存储会先满。
    const day = new Date(now()).toISOString().slice(0, 10);
    const allKey = `rl:${day}:cb:all`, insKey = `rl:${day}:cb:i:${r.install}`;
    const [allRaw, insRaw] = await Promise.all([kv.get(allKey), kv.get(insKey)]);
    const [count = 0, used = 0] = String(allRaw || '').split(':').map((x) => Number(x) || 0);
    const mine = Number(insRaw) || 0;
    if (count >= (Number(env.CB_DAILY_CAP) || 50)) return json(429, { error: 'daily limit reached', retryAfter: 'tomorrow' });
    if (mine >= (Number(env.CB_PER_INSTALL_DAILY) || 20)) return json(429, { error: 'too many reports from this install today', retryAfter: 'tomorrow' });
    const size = r.attachments.reduce((n, a) => n + a.size, 0) + r.text.length * 3;
    if (used + size > (Number(env.CB_DAILY_MB) || 30) * 1024 * 1024) return json(429, { error: 'daily size limit reached', retryAfter: 'tomorrow' });
    const rl = { expirationTtl: 2 * 86400 };
    await Promise.all([kv.put(allKey, `${count + 1}:${used + size}`, rl), kv.put(insKey, String(mine + 1), rl)]);

    // 键名按时间排：KV list 按字典序回，开发者那边取到的就是先来先取
    const id = `${String(now()).padStart(13, '0')}-${hex(4)}`;
    const ttl = Math.max(1, Number(env.CB_TTL_DAYS) || 30) * 86400;
    await kv.put(`cbi:${id}`, storedJson(id, new Date(now()).toISOString(), r), { expirationTtl: ttl });
    return json(200, { ok: true, id });
  }

  // 等价于 JSON.stringify({ id, at, report })，只是图片的 base64 直接拼进去：JSON.stringify 要逐字符查转义，
  // 3 张 2MB 图约 8ms CPU，拼接只是拷贝。base64 已在 cleanCbReport 里校验过字符集，不含任何要转义的字符。
  function storedJson(id, at, r) {
    const { attachments, ...rest } = r;
    const atts = attachments.map((a) => `{"name":${JSON.stringify(a.name)},"type":${JSON.stringify(a.type)},"size":${a.size},"data":"${a.data}"}`);
    return `{"id":${JSON.stringify(id)},"at":${JSON.stringify(at)},"report":${JSON.stringify(rest).slice(0, -1)},"attachments":[${atts.join(',')}]}}`;
  }

  // 存的值是这里自己 JSON.stringify 出来的（图片 base64 已校验过字符集），直接拼成响应，不再解析一遍：
  // 免费档每次请求只有 10ms CPU、128MB 内存，几 MB 的图解析再序列化一来一回就超了。一次最多回 ~12M 字符，多的下一页。
  async function inbox(url, env) {
    const kv = env.FEEDBACK_KV;
    const limit = Math.min(25, Math.max(1, Number(url.searchParams.get('limit')) || 10));
    const page = await kv.list({ prefix: 'cbi:', limit });
    const keys = page.keys || [];
    const vals = [];
    let total = 0, cut = false;
    for (let i = 0; i < keys.length; i++) {
      if (vals.length && total > 12_000_000) { cut = true; break; }
      // list 是最终一致的：刚确认删掉的键可能还在列表里，get 回 null 就跳过
      const v = await kv.get(keys[i].name);
      if (!v || v[0] !== '{') continue;
      vals.push(v);
      total += v.length;
    }
    const more = cut || page.list_complete === false;
    return new Response(`{"ok":true,"items":[${vals.join(',')}],"more":${more}}`, { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  }

  async function ack(req, env) {
    let body = {};
    try { body = JSON.parse(await req.text()); } catch {}
    const ids = (Array.isArray(body.ids) ? body.ids : []).map(String).filter((s) => ID_RE.test(s)).slice(0, 100);
    for (const id of ids) await env.FEEDBACK_KV.delete(`cbi:${id}`);
    return json(200, { ok: true, acked: ids.length });
  }

  return async function handleCb(req, env, url) {
    if (url.pathname === '/v1/cb/report') {
      if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
      try { return await report(req, env); }
      catch (e) { return json(502, { error: String(e?.message || e).slice(0, 200) }); }
    }
    const isInbox = url.pathname === '/v1/cb/inbox', isAck = url.pathname === '/v1/cb/inbox/ack';
    // 收件箱没配：这两个接口当作不存在
    if (!(isInbox || isAck) || !env.INBOX_TOKEN || !env.FEEDBACK_KV) return json(404, { error: 'not found' });
    if (!(await authed(req, env))) return json(401, { error: 'unauthorized' });
    if (isInbox) return req.method === 'GET' ? inbox(url, env) : json(405, { error: 'method not allowed' });
    return req.method === 'POST' ? ack(req, env) : json(405, { error: 'method not allowed' });
  };
}
