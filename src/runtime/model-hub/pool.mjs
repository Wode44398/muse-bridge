// 模型网关的 API 池上游：一个服务挂多条线路（line），每条线路一个 Key、可以有自己的接口地址（不同中转站 / 不同账号）。
//
// 取线路：failover = 按列表顺序取第一条没在冷却的；round-robin = 没在冷却的轮流。全在冷却就取最快恢复的那条硬试（别直接判死）。
// 换线路：上游回 401 / 403（Key 无效）、402（余额不足）、429（限额）或连不上 → 这条线路冷却、换下一条把同一个请求重发，
// 都不行就把最后一个应答原样交回去。应答一旦开始往回流就不再换（流到一半断了由 agent 自己重试）。
// 线路状态只在内存里（重启清零），Claude 与 dimensio 共用。
import { Agent } from 'undici';
import { KEEPALIVE, withWarm, fetchReconnect, textWithin } from '../upstream-conn.mjs';
import { anthropicUrl } from '../../model-knowledge/knowledge.mjs';
import { looksBilling } from '../../model-knowledge/diagnose.mjs';

const DIRECT = withWarm(new Agent({ ...KEEPALIVE, connect: { timeout: 30_000 } }));
const COOL = { 401: 30 * 60_000, 403: 30 * 60_000, 402: 6 * 3600_000, 429: 60_000 };
const WHY = { 401: 'Key 无效', 403: '被拒绝', 402: '余额不足', 429: '限额' };
const FORWARD = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta'];

const states = new Map();    // `${服务}/${线路}` → 状态
const cursors = new Map();   // 服务 → 轮流的起点
const st = (sid, lid) => {
  const k = sid + '/' + lid;
  let s = states.get(k);
  if (!s) { s = { requests: 0, ok: 0, fail: 0, lastStatus: 0, lastError: '', lastAt: 0, coolUntil: 0, coolWhy: '' }; states.set(k, s); }
  return s;
};
/** 给界面看的线路状态（没请求过的回零值）。 */
export const lineState = (sid, lid) => ({ ...st(sid, lid) });
export function clearCooldown(sid, lid) { const s = st(sid, lid); s.coolUntil = 0; s.coolWhy = ''; }
export function forgetService(sid) { for (const k of [...states.keys()]) if (k.startsWith(sid + '/')) states.delete(k); cursors.delete(sid); }
export function _resetPoolForTests() { states.clear(); cursors.clear(); }

/** 这一次请求要依次试的线路。 */
export function lineOrder(service, now = Date.now()) {
  const on = (service.lines || []).filter((l) => l.enabled !== false);
  if (!on.length) return [];
  const free = on.filter((l) => st(service.id, l.id).coolUntil <= now);
  if (!free.length) return [on.slice().sort((a, b) => st(service.id, a.id).coolUntil - st(service.id, b.id).coolUntil)[0]];
  if (service.strategy !== 'round-robin' || free.length === 1) return free;
  const c = (cursors.get(service.id) || 0) % free.length;
  cursors.set(service.id, c + 1);
  return [...free.slice(c), ...free.slice(0, c)];
}

// ── 报错里绝不带 Key ─────────────────────────────────────────────
// 先抹后截：截断后的半截 Key 整串匹配不上，抹不掉（undici 拒收请求头时的 TypeError 原文里就是整段请求头值）。
/** 报错文本里把 Key 换成「…」（Key 太短不抹，免得把正常字误伤）。 */
export const scrubKey = (s, key) => { const t = String(s ?? ''); return key && key.length >= 4 ? t.split(key).join('…') : t; };
/** Key 只能是一行可见的 Latin-1 字符：换行 / 空白 / 控制字符进了请求头 undici 直接拒，非 Latin-1 的 fetch 也发不出去。 */
export const BAD_KEY_RE = /[\s\u0000-\u001f\u007f]|[^\u0000-ÿ]/;
export const BAD_KEY_MSG = 'Key 里有换行、空白或非法字符，请重新粘贴';
export const BAD_HEADER_MSG = 'Key 或请求头里有换行等非法字符，请重新填写';
/**
 * fetch 因请求头不合法抛的 TypeError：换行 / 控制字符是「Headers.append: "<整段值>" is an invalid header value.」（原文含整段请求头值，不能回显）；
 * 非 Latin-1（比如自定义请求头的值里有中文）是「Cannot convert argument to a ByteString …」。
 */
export const isBadHeader = (e) => [e, e?.cause].some((x) => x?.name === 'TypeError' && /header|ByteString/i.test(String(x?.message || '')));
/** 连不上时给人看的一句（抹 Key、再截断；请求头不合法给固定提示）。 */
export function netText(e, key, max = 160) {
  if (isBadHeader(e)) return BAD_HEADER_MSG;
  return scrubKey(String(e?.cause?.code || e?.cause?.message || e?.message || e), key).slice(0, max);
}

export const defaultAuthStyle = (kind) => (kind === 'anthropic' ? 'x-api-key' : kind === 'gemini' ? 'goog' : 'bearer');
export function authHeaders(service, key) {
  const style = service.authStyle || defaultAuthStyle(service.kind);
  if (!key || style === 'none') return {};
  return style === 'bearer' ? { authorization: 'Bearer ' + key } : style === 'goog' ? { 'x-goog-api-key': key } : { 'x-api-key': key };
}
export function lineUrl(service, line, rest, search = '') {
  const base = String(line.baseUrl || service.baseUrl || '').replace(/\/+$/, '');
  return (service.kind === 'anthropic' ? anthropicUrl(base, rest) : base + rest) + (search || '');
}

async function retryAfterMs(res) {
  const ra = parseFloat(res.headers.get('retry-after') || '');
  return Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 3600_000) : 0;
}

/** keyOf(服务 id, 线路 id) → Key（registry 注入，Key 不放在服务记录里）。 */
export function makePoolHandler(keyOf) {
  return async function handlePool({ service, proto, rest, search, method, headers, body, signal }) {
    if (proto !== service.kind) throw Object.assign(new Error(`这个服务是 ${service.kind} 协议的`), { status: 404 });
    const order = lineOrder(service);
    if (!order.length) throw Object.assign(new Error(`「${service.name}」没有启用的线路：到「模型中心」里加一条 Key`), { status: 503 });
    const fwd = {};
    for (const k of FORWARD) if (headers[k]) fwd[k] = headers[k];
    for (const h of service.headers || []) fwd[h.name.toLowerCase()] = h.value;
    const dispatcher = service.useProxy === false ? DIRECT : undefined;
    let last = null, lastErr = null, lastKey = '';
    for (const line of order) {
      const s = st(service.id, line.id);
      const key = keyOf(service.id, line.id);
      s.requests += 1; s.lastAt = Date.now();
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      // 只管到应答头回来为止（流式正文可以跑很久）
      const timer = setTimeout(() => ac.abort(new Error('timeout')), (service.timeoutSec || 600) * 1000);
      let res;
      try {
        // 撞上死连接先在同一条线路上立刻重发一次，还不行才记「连不上」换线路
        res = await fetchReconnect(lineUrl(service, line, rest, search), {
          method, headers: { ...fwd, ...authHeaders(service, key) }, body: body ?? undefined,
          signal: ac.signal, redirect: 'manual', ...(dispatcher ? { dispatcher } : {}),
        });
      } catch (e) {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (signal?.aborted) throw e;
        s.fail += 1; s.lastStatus = 0; s.lastError = netText(e, key, 160);
        s.coolUntil = Date.now() + 20_000; s.coolWhy = isBadHeader(e) ? 'Key 不合法' : '连不上';
        lastErr = e; lastKey = key;
        continue;
      }
      // 429 的正文要读出来判是不是余额不足：读完（有上限）再撤超时与断开监听
      let text429 = null;
      if (res.status === 429) text429 = await textWithin(res);
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      s.lastStatus = res.status;
      if (res.ok) { s.ok += 1; s.lastError = ''; s.coolUntil = 0; s.coolWhy = ''; return res; }
      s.fail += 1;
      // 429 先看是不是「余额不足」披着限流的皮（智谱 1113、OpenAI insufficient_quota）：是就按余额不足的时长冷却
      let billing = false;
      if (text429 !== null) {
        billing = looksBilling(429, text429);
        res = new Response(text429, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
      const cool = billing ? COOL[402] : COOL[res.status];
      if (!cool && res.status < 500) { s.lastError = `HTTP ${res.status}`; return res; }   // 400 / 404 / 422：请求本身的问题，换线路没用
      const why = billing ? WHY[402] : WHY[res.status];
      if (cool) { s.coolUntil = Date.now() + (res.status === 429 && !billing ? (await retryAfterMs(res)) || cool : cool); s.coolWhy = why; }
      s.lastError = `HTTP ${res.status}` + (cool ? ` · ${why}` : '');
      if (last) await last.body?.cancel?.().catch(() => {});
      last = res; lastErr = null;
    }
    if (last) return last;
    throw Object.assign(new Error(`「${service.name}」的线路都连不上：${netText(lastErr, lastKey, 160)}`), { status: 502 });
  };
}

/** 钉在一条线路上直接发一个请求（测试连接、拉模型列表用；不计入线路状态、不换线路）。 */
export async function lineFetch(service, line, key, rest, { method = 'GET', body, search = '', timeoutMs = 30_000 } = {}) {
  const headers = { ...(body ? { 'content-type': 'application/json' } : {}), ...(service.kind === 'anthropic' ? { 'anthropic-version': '2023-06-01' } : {}) };
  for (const h of service.headers || []) headers[h.name.toLowerCase()] = h.value;
  return fetch(lineUrl(service, line, rest, search), {
    method, headers: { ...headers, ...authHeaders(service, key) }, body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs), redirect: 'manual', ...(service.useProxy === false ? { dispatcher: DIRECT } : {}),
  });
}

/**
 * 识别模型用的裸请求（detect.mjs）：地址与请求头调用方给全，不套线路、不计状态。
 * useProxy=false 走直连（本机 / 内网端点），否则走全局出站代理——和这个服务以后真发请求时同一条路，识别通过就说明真能用。
 * timeoutMs 是这一个请求的上限；signal 是调用方的总截止（两个谁先到算谁）。不跟随跳转：跳到别处的不当成功。
 */
export function directFetch(url, { method = 'GET', headers = {}, useProxy = true, timeoutMs = 20_000, signal } = {}) {
  const t = AbortSignal.timeout(Math.max(1, timeoutMs));
  return fetch(url, {
    method, headers, signal: signal ? AbortSignal.any([signal, t]) : t, redirect: 'manual',
    ...(useProxy === false ? { dispatcher: DIRECT } : {}),
  });
}
