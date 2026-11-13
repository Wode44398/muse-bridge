// 插件提供的模型服务（2026-11-01，维护者：把 Gemini 网页版反代做成插件，勾选哪些 agent 能用）。
//
// 插件用 ctx.models.provide(spec) 登记一个模型服务（兼容 Anthropic Messages 或 OpenAI Chat Completions 的端点 + 一组模型），
// 按 spec.agents 注进各个 agent 的模型列表：
//   claude    → claude-providers.mjs 把它并进主机（和勾了 members 时的成员）能用的服务，会话模型 id 照旧是 custom:<服务>:<模型>，
//               走同一个本机代理；设置里的「模型服务」编辑器看不到也改不了它（由插件管）。
//   dimensio  → dimensio 扩展把它写进管理员实例的 custom-providers/plugin-providers.json（harness/server/custom-providers.ts 读），
//               「模型服务」里出现一张由插件管理的卡（只能用、不能改）；勾了 members 的成员实例也读得到。
// 插件停用 / 改配置 / 重载时自动撤掉。这里只管登记与通知，各 agent 怎么接由它们自己订阅（onModelServicesChange）。
//
// spec（公共接口，见手册 plugins 章「给 agent 提供模型」，只做加法）：
//   id          插件内唯一，缺省 'default'（小写字母数字连字符）
//   name        显示名（≤40）
//   protocol    'anthropic' | 'openai' | 'gemini'（gemini 只给 dimensio）
//   baseUrl     端点根地址（http / https；插件是主机装的，本机地址也行）
//   apiKey      可选；authStyle 'x-api-key' | 'bearer' | 'none'（缺省：有 key 按协议，没有 = none）；headers [{ name, value }]
//   agents      ['claude', 'dimensio'] 的子集（缺省两个都给）
//   members     true = 多用户服务端的成员也能用（缺省只给服务器主机）
//   models      [{ id, label?, agents?, contextWindow?, maxOutput?, vision?, thinking?, efforts?: [{ id, name, value }], effortDefault?, alwaysThinks? }]
//               models[i].agents（2026-11-10 模型中心 v2）：这个模型给哪些 agent，取与服务级 agents 的交集（gemini 照样去掉 claude）；
//               不传 = 跟服务级。某个 agent 下一个模型都没有时，那一侧整条服务不出现（modelServices(agent) 过滤）。
//   native      可选（模型中心用）：{ vendor, key, baseUrl? }——这个服务就是 dimensio 自带专门适配的那家厂商（vendor = 它的厂商 id）。
//               dimensio 扩展不把它登记成一张新卡，而是让那家厂商用这把 Key（和地址）；别的 agent 不看这个字段。
//   logo        可选：品牌标的键（如 openrouter、deepseek-color），dimensio 的「模型服务」卡片据此画标
//   defaultModel、timeoutSec、compat（Claude 代理的兼容开关：promptCaching / stripBetas / slimBody / stripThinkingHistory / replayReasoning）
import { createHash } from 'node:crypto';

export const MODEL_AGENTS = Object.freeze(['claude', 'dimensio']);
const SID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const LOGO_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;   // 品牌标的键（web/src/lib/brandLogos.js 里的文件基名）
const MODEL_ID_RE = /^[^\s\u0000-\u001f]{1,200}$/;

const services = new Map();   // `${插件}/${sid}` → 规范化后的记录
let rev = 0;
const listeners = new Set();

const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const str = (v, max) => (typeof v === 'string' ? v.replace(/[\r\n\t]+/g, ' ').trim().slice(0, max) : '');

/** 服务的稳定短哈希（各 agent 据此造自己的服务 id：同一个插件服务每次启动 id 不变，会话里记着的模型照样认得）。 */
export const serviceHash = (plugin, sid, len) => createHash('sha1').update(`plugin:${plugin}/${sid}`).digest('hex').slice(0, len);

function normalize(plugin, pluginName, spec) {
  const s = spec && typeof spec === 'object' ? spec : {};
  const sid = s.id == null ? 'default' : String(s.id);
  if (!SID_RE.test(sid)) throw bad(`模型服务 id「${sid}」不合法（小写字母、数字、连字符，≤32）`);
  // gemini（Gemini generateContent 接口）只有 dimensio 认得：Claude 的本机代理只会 Anthropic / OpenAI，这种服务不给 Claude
  const protocol = s.protocol === 'openai' ? 'openai' : s.protocol === 'gemini' ? 'gemini' : s.protocol === 'anthropic' || s.protocol == null ? 'anthropic' : null;
  if (!protocol) throw bad('protocol 只能是 anthropic、openai 或 gemini');
  let baseUrl = '';
  try {
    const u = new URL(String(s.baseUrl || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw 0;
    baseUrl = u.toString().replace(/\/+$/, '');
  } catch { throw bad('baseUrl 要是 http(s) 地址'); }
  const apiKey = typeof s.apiKey === 'string' ? s.apiKey.trim().slice(0, 4000) : '';
  const authStyle = ['x-api-key', 'bearer', 'goog', 'none'].includes(s.authStyle) ? s.authStyle : apiKey ? (protocol === 'openai' ? 'bearer' : protocol === 'gemini' ? 'goog' : 'x-api-key') : 'none';
  const headers = (Array.isArray(s.headers) ? s.headers : [])
    .filter((h) => h && typeof h.name === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(h.name) && typeof h.value === 'string')
    .slice(0, 20).map((h) => ({ name: h.name, value: h.value.slice(0, 2000) }));
  const agents = (Array.isArray(s.agents) ? MODEL_AGENTS.filter((a) => s.agents.includes(a)) : [...MODEL_AGENTS]).filter((a) => protocol !== 'gemini' || a !== 'claude');
  const seen = new Set();
  const models = [];
  for (const m of Array.isArray(s.models) ? s.models : []) {
    const id = typeof m === 'string' ? m.trim() : typeof m?.id === 'string' ? m.id.trim() : '';
    if (!MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    // 只有显式给了 agents 的模型才带这个字段：老插件不传时记录逐字段和以前一样（各 agent 读到的形状不变）
    if (typeof m === 'string') models.push({ id });
    else if (Array.isArray(m.agents)) models.push({ ...m, id, agents: agents.filter((a) => m.agents.includes(a)) });
    else { const { agents: _drop, ...rest } = m; models.push({ ...rest, id }); }
    if (models.length >= 100) break;
  }
  if (!models.length) throw bad('models 至少要有一个模型');
  const defaultModel = models.some((m) => m.id === s.defaultModel) ? s.defaultModel : models[0].id;
  const nv = s.native && typeof s.native === 'object' ? s.native : null;
  const native = nv && typeof nv.vendor === 'string' && /^[a-z]{2,16}$/.test(nv.vendor) && typeof nv.key === 'string' && nv.key.trim() && agents.includes('dimensio')
    ? { vendor: nv.vendor, key: nv.key.trim().slice(0, 4000), baseUrl: typeof nv.baseUrl === 'string' && /^https?:\/\//i.test(nv.baseUrl) ? nv.baseUrl.replace(/\/+$/, '').slice(0, 500) : '' }
    : null;
  return {
    key: `${plugin}/${sid}`, plugin, pluginName: str(pluginName, 40) || plugin, sid,
    name: str(s.name, 40) || str(pluginName, 40) || plugin,
    protocol, baseUrl, apiKey, authStyle, headers, agents, members: s.members === true,
    models, defaultModel,
    logo: typeof s.logo === 'string' && LOGO_RE.test(s.logo) ? s.logo : '',
    ...(native ? { native } : {}),
    // 请求实际发到的上游主机（模型中心给的；baseUrl 是本机网关时靠它认官方 Anthropic / OpenRouter）
    ...(typeof s.upstream === 'string' && /^[a-z0-9.-]{1,253}$/.test(s.upstream) ? { upstream: s.upstream } : {}),
    timeoutSec: Number.isFinite(s.timeoutSec) ? Math.min(1800, Math.max(10, Math.round(s.timeoutSec))) : 600,
    compat: s.compat && typeof s.compat === 'object' ? { ...s.compat } : {},
  };
}

function bump() {
  rev += 1;
  for (const fn of listeners) { try { fn(rev); } catch (e) { console.error('[model-services] listener:', e?.message || e); } }
}

/**
 * 登记一个模型服务（插件内核的 ctx.models.provide 调它）。同一插件同 id 再登记 = 整体替换。
 * 返回 { id, update(patch), dispose() }：update 合并进当前 spec 重新登记；dispose 撤掉（重复调没事）。
 */
export function provideModelService(plugin, pluginName, spec) {
  let cur = normalize(plugin, pluginName, spec);
  let raw = { ...spec };
  services.set(cur.key, cur);
  bump();
  let gone = false;
  return {
    id: cur.sid,
    update(patch) {
      if (gone) throw new Error('这个模型服务已经撤掉了');
      const next = normalize(plugin, pluginName, { ...raw, ...(patch || {}), id: cur.sid });
      raw = { ...raw, ...(patch || {}) };
      cur = next;
      services.set(cur.key, cur);
      bump();
    },
    dispose() {
      if (gone) return;
      gone = true;
      if (services.get(cur.key) === cur) { services.delete(cur.key); bump(); }
    },
  };
}

/**
 * 给某个 agent 的服务（agent 缺省 = 全部，原样返回）。记录是只读快照，别改。
 * 带 agent 时按模型级 agents 再筛一遍：筛掉了模型的返回副本（defaultModel 落在被筛掉的模型上就改成剩下的第一个），
 * 一个都不剩的整条不返回；一个都没筛掉的原样返回（老插件拿到的还是原来那条记录）。
 */
export function modelServices(agent) {
  const all = [...services.values()];
  if (!agent) return all;
  const out = [];
  for (const s of all) {
    if (!s.agents.includes(agent)) continue;
    const models = s.models.filter((m) => !Array.isArray(m.agents) || m.agents.includes(agent));
    if (!models.length) continue;
    if (models.length === s.models.length) { out.push(s); continue; }
    out.push({ ...s, models, defaultModel: models.some((m) => m.id === s.defaultModel) ? s.defaultModel : models[0].id });
  }
  return out;
}
export const modelServicesRev = () => rev;
/** 有服务登记 / 更新 / 撤掉时调 fn(rev)。返回取消订阅的函数。 */
export function onModelServicesChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export function _resetModelServicesForTests() { services.clear(); bump(); middlewares.length = 0; }

// —— 模型请求中间件（ctx.models.middleware，插件接口四期）——
// 本机模型代理（claude-providers-proxy.mjs）在按服务参数改写完、发给上游之前，依次交给中间件改请求体。
// only:'own' = 只管这个插件自己提供的服务（服务带 plugin.id）。中间件抛错 / 超时 = 不改（记插件日志），请求照发。
const middlewares = [];   // { plugin, fn, only, timeout, warn }
export function addModelMiddleware(plugin, fn, { only = 'all', timeout, warn } = {}) {
  const m = { plugin, fn, only, timeout: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 30_000) : 5_000, warn: warn || (() => {}) };
  middlewares.push(m);
  return () => { const i = middlewares.indexOf(m); if (i >= 0) middlewares.splice(i, 1); };
}
export const hasModelMiddleware = () => middlewares.length > 0;

/** 代理调：{ provider（插件提供的带 plugin）, model, owner, body } → 改过的 body。 */
export async function applyModelMiddleware({ provider, model, owner, body }) {
  let out = body;
  for (const m of middlewares.slice()) {
    if (m.only === 'own' && provider?.plugin?.id !== m.plugin) continue;
    const view = { provider: { id: provider?.id || '', name: provider?.name || '', protocol: provider?.protocol || '', plugin: provider?.plugin?.id || '' }, model: model?.id || '', owner: owner || '', body: structuredClone(out) };
    let timer;
    try {
      const r = await Promise.race([
        Promise.resolve().then(() => m.fn(view)),
        new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`超过 ${m.timeout / 1000} 秒`)), m.timeout); timer.unref?.(); }),
      ]);
      if (r && typeof r === 'object' && !Array.isArray(r)) out = r;
    } catch (e) { m.warn(`模型请求中间件出错（这次不改）：${String(e?.message || e).slice(0, 200)}`); }
    finally { clearTimeout(timer); }
  }
  return out;
}
