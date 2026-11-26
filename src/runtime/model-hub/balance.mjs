// 模型服务的余额 / 限额：只接用对话那把 Key 就能查、且有官方文档的接口。别家不发请求（serviceView.balance = false，界面不显示这一栏）。
// 返回的是代号与数字，不带文案：「余额」「充值」这些字由前端出（要翻译）。
// 一条线路 = 一把 Key = 一个账户（或账户下的一把 Key），按线路分别查；60 秒内重复查走缓存，免得来回切页面一直打上游。
import { providerOf } from '../../model-knowledge/index.mjs';
import { directFetch, scrubKey, netText, isBadHeader, BAD_HEADER_MSG } from './pool.mjs';

const TTL_MS = 60_000;
const REQ_MS = 15_000;
const cache = new Map();   // '<服务>/<线路>' -> { at, view, fp }

const num = (v) => { const n = typeof v === 'number' ? v : parseFloat(v); return Number.isFinite(n) ? n : null; };
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const endsWith = (host, d) => host === d || host.endsWith('.' + d);

// 上游的业务错误（HTTP 200 但 code 不对）也当失败：消息原样带回去，先抹 Key
const upstreamErr = (msg) => Object.assign(new Error(String(msg || '上游没给出余额')), { upstream: true });

/**
 * 每家一个：read(get, host) → items。get(url) 返回解析好的 JSON（非 2xx 直接抛）。
 * item = { kind: 'balance' | 'keyLimit' | 'points', amount, currency: 'CNY' | 'USD' | '', total?, reset?, parts?: [{ kind, amount }] }
 *   balance：账户余额；keyLimit：这把 Key 自己的花费上限还剩多少（total = 上限）；points：积分（Poe）
 *   parts 的 kind：topup 充值 / granted 赠送 / cash 现金 / voucher 代金券 / credits 累计充值 / used 已用
 */
const ADAPTERS = {
  deepseek: {
    async read(get) {
      const j = await get('https://api.deepseek.com/user/balance');
      const list = Array.isArray(j?.balance_infos) ? j.balance_infos : [];
      if (!list.length) throw upstreamErr(j?.is_available === false ? '账户不可用' : '');
      return list.map((b) => ({
        kind: 'balance', amount: num(b.total_balance), currency: String(b.currency || '').toUpperCase(),
        parts: [{ kind: 'topup', amount: num(b.topped_up_balance) }, { kind: 'granted', amount: num(b.granted_balance) }],
      }));
    },
  },
  openrouter: {
    // 账户余额（/credits）和这把 Key 的限额（/key）各查一次；/credits 对某些 Key 会 403，那就只报限额
    async read(get) {
      const [credits, key] = await Promise.allSettled([get('https://openrouter.ai/api/v1/credits'), get('https://openrouter.ai/api/v1/key')]);
      const items = [];
      const c = credits.status === 'fulfilled' ? credits.value?.data : null;
      if (c && num(c.total_credits) != null) {
        const total = num(c.total_credits), used = num(c.total_usage) ?? 0;
        items.push({ kind: 'balance', amount: Math.round((total - used) * 100) / 100, currency: 'USD', parts: [{ kind: 'credits', amount: total }, { kind: 'used', amount: used }] });
      }
      const k = key.status === 'fulfilled' ? key.value?.data : null;
      if (k && num(k.limit) != null) {
        items.push({ kind: 'keyLimit', amount: num(k.limit_remaining), total: num(k.limit), currency: 'USD', ...(k.limit_reset ? { reset: String(k.limit_reset) } : {}) });
      }
      if (!items.length) throw (credits.status === 'rejected' ? credits.reason : key.status === 'rejected' ? key.reason : upstreamErr(''));
      return items;
    },
  },
  siliconflow: {
    // 国际站（siliconflow.com）按美元计，国内站按人民币
    async read(get, host) {
      const intl = endsWith(host, 'siliconflow.com');
      const j = await get(intl ? 'https://api.siliconflow.com/v1/user/info' : 'https://api.siliconflow.cn/v1/user/info');
      const d = j?.data;
      if (!d || num(d.totalBalance) == null) throw upstreamErr(j?.message);
      return [{
        kind: 'balance', amount: num(d.totalBalance), currency: intl ? 'USD' : 'CNY',
        parts: [{ kind: 'topup', amount: num(d.chargeBalance) }, { kind: 'granted', amount: num(d.balance) }],
      }];
    },
  },
  moonshot: {
    // 只认开放平台（moonshot.cn / moonshot.ai）；Kimi Code 会员走的是 api.kimi.com，被别的预设认走，不到这里
    match: (host) => endsWith(host, 'moonshot.cn') || endsWith(host, 'moonshot.ai'),
    async read(get, host) {
      const intl = endsWith(host, 'moonshot.ai');
      const j = await get(intl ? 'https://api.moonshot.ai/v1/users/me/balance' : 'https://api.moonshot.cn/v1/users/me/balance');
      const d = j?.data;
      if (!d || num(d.available_balance) == null) throw upstreamErr(j?.error?.message || j?.message);
      return [{
        kind: 'balance', amount: num(d.available_balance), currency: intl ? 'USD' : 'CNY',
        parts: [{ kind: 'cash', amount: num(d.cash_balance) }, { kind: 'voucher', amount: num(d.voucher_balance) }],
      }];
    },
  },
  vercel: {
    async read(get) {
      const j = await get('https://ai-gateway.vercel.sh/v1/credits');
      if (num(j?.balance) == null) throw upstreamErr('');
      return [{ kind: 'balance', amount: num(j.balance), currency: 'USD', parts: [{ kind: 'used', amount: num(j.total_used) }] }];
    },
  },
  poe: {
    async read(get) {
      const j = await get('https://api.poe.com/usage/current_balance');
      if (num(j?.current_point_balance) == null) throw upstreamErr('');
      return [{ kind: 'points', amount: num(j.current_point_balance), currency: '' }];
    },
  },
};

// 线路自己填了地址的按线路的认（同一个服务的线路可能接在不同的站上）
function adapterFor(service, line) {
  if (!service || service.kind === 'chatgpt') return null;
  const base = line?.baseUrl || service.baseUrl;
  const key = providerOf(base)?.key;
  const a = key ? ADAPTERS[key] : null;
  if (!a) return null;
  const host = hostOf(base);
  return a.match && !a.match(host) ? null : { a, host };
}

/** 这个服务查不查得了余额（看服务的地址；线路另填了地址的到查的时候再按线路认）。 */
export function balanceSupported(service) { return !!adapterFor(service, null); }

async function readLine(service, line, key) {
  const hit = adapterFor(service, line);
  if (!hit) return { ok: false, error: '这家服务商没有能用 API Key 查余额的接口' };
  if (!key) return { ok: false, error: '这把 Key 是空的' };
  const get = async (url) => {
    let r;
    try { r = await directFetch(url, { headers: { authorization: 'Bearer ' + key, accept: 'application/json' }, useProxy: service.useProxy !== false, timeoutMs: REQ_MS }); }
    catch (e) { throw upstreamErr(e?.name === 'TimeoutError' ? '超时' : isBadHeader(e) ? BAD_HEADER_MSG : '连不上：' + netText(e, key, 120)); }
    const text = await r.text().catch(() => '');
    if (!r.ok) {
      let msg = '';
      try { const j = JSON.parse(text); msg = j?.error?.message ?? j?.error ?? j?.message ?? ''; } catch {}
      if (typeof msg !== 'string') msg = JSON.stringify(msg);
      const why = r.status === 401 || r.status === 403 ? 'Key 无效或没有查余额的权限' : '查询失败';
      throw upstreamErr(`${why}（HTTP ${r.status}）${msg ? '：' + scrubKey(msg, key).slice(0, 160) : ''}`);
    }
    try { return JSON.parse(text); } catch { throw upstreamErr('返回的不是 JSON'); }
  };
  try { return { ok: true, items: await hit.a.read(get, hit.host) }; }
  catch (e) { return { ok: false, error: scrubKey(String(e?.message || e), key).slice(0, 240) }; }
}

/**
 * 查一个服务各条线路的余额。entries = [{ service, line, key }]（lineContext 的结果，带明文 Key，只在这里用）。
 * → { balance: [{ lineId, label, enabled, ok, items?, error?, at }] }。force = 不走缓存。
 */
export async function readServiceBalance(entries, { force = false, now = Date.now } = {}) {
  const out = await Promise.all(entries.map(async ({ service, line, key }) => {
    const ck = service.id + '/' + line.id;
    // 换了 Key / 地址缓存就作废：拿 Key 尾巴和地址当指纹（不存整把 Key）
    const fp = (line.baseUrl || service.baseUrl) + '|' + String(key).slice(-6);
    const c = cache.get(ck);
    let view, at;
    if (!force && c && c.fp === fp && now() - c.at < TTL_MS) ({ view, at } = c);
    else { view = await readLine(service, line, key); at = now(); cache.set(ck, { at, view, fp }); }
    return { lineId: line.id, label: line.label || '', enabled: line.enabled !== false, ...view, at };
  }));
  return { balance: out };
}

export function _resetBalanceForTests() { cache.clear(); }
