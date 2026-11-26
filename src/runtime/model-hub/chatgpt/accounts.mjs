// 注册表要的几件事：拉这个账号能用的模型、删账号时吊销并清凭据、账号状态视图。不 import 注册表（注册表 import 这里）。
import { EP } from './const.mjs';
import { accessTokenFor } from './tokens.mjs';
import { credsOf, dropCreds, accountView } from './store.mjs';
import { revokeCred } from './oauth.mjs';
import { classify } from './upstream.mjs';

const num = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : undefined);

/** GET /v1/models 的应答 → 模型目录条目（只留 visibility 为 list 的，保持服务端的顺序）。 */
export function catalogFromModels(json) {
  const list = Array.isArray(json?.models) ? json.models : Array.isArray(json?.data) ? json.data : [];
  const hasVis = list.some((m) => m && typeof m.visibility === 'string');
  const out = [];
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    if (hasVis && m.visibility !== 'list') continue;
    const id = String(m.slug || m.id || '').trim();
    if (!id) continue;
    const mods = Array.isArray(m.input_modalities) ? m.input_modalities : null;
    out.push({
      id, label: String(m.display_name || m.name || id).slice(0, 80), kind: 'text', source: 'api',
      ...(num(m.context_window ?? m.max_context_window ?? m.context_length) ? { contextWindow: num(m.context_window ?? m.max_context_window ?? m.context_length) } : {}),
      ...(num(m.max_output_tokens) ? { maxOutput: num(m.max_output_tokens) } : {}),
      ...(mods ? { vision: mods.includes('image') } : {}),
    });
  }
  return out;
}

/** 用这个访问令牌拉模型目录。失败抛带人话的错（不能用套餐额度的账号在这一步就会被拒）。 */
export async function listPlanModels(token) {
  let r;
  try { r = await fetch(`${EP.plan}/models`, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(30_000) }); }
  catch (e) { throw Object.assign(new Error(`连不上 ChatGPT 的接口：${String(e?.cause?.code || e?.message || e).slice(0, 120)}（检查出站代理）`), { status: 502, code: 'network' }); }
  let j = null;
  try { j = await r.json(); } catch {}
  if (!r.ok) {
    const code = String(j?.error?.code || '');
    const c = classify(r.status, code, j?.error?.message || j?.detail || '');
    throw Object.assign(new Error(`拉模型列表失败：${c.message}`), { status: r.status >= 500 ? 502 : r.status, code: code === 'subscription_sharing_user_not_eligible' ? 'not_eligible' : 'exchange' });
  }
  const models = catalogFromModels(j);
  if (!models.length) throw Object.assign(new Error('这个账号没有能用的模型'), { status: 502, code: 'not_eligible' });
  return models;
}

/** 服务的模型目录：依次用启用的账号拉，第一个拉成的为准。 */
export async function serviceCatalog(service) {
  let lastErr = null;
  for (const line of (service.lines || []).filter((l) => l.enabled !== false)) {
    try {
      const token = await accessTokenFor(service.id, line.id);
      return await listPlanModels(token);
    } catch (e) { lastErr = e; }
  }
  throw lastErr || Object.assign(new Error('没有启用的 ChatGPT 账号'), { status: 400 });
}

/** 删账号（或整个服务）：本地先清，再在后台吊销刷新令牌。 */
export function forgetAccounts(sid, lids = null) {
  const gone = dropCreds(sid, lids);
  for (const c of gone) revokeCred(c).catch(() => {});
  return gone.length;
}

/** 服务视图里的 chatgpt 一节。 */
export function accountsOf(service) {
  const creds = credsOf(service.id);
  return service.lines.map((l) => accountView(l, creds[l.id] || null));
}
