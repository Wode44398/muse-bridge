// 插件在设置页 / 面板 / agent 接口上的「显示位」：状态块、动作按钮、动态选项、给插件页面推事件、键值存储。
//
//   ctx.status(fn)               fn() → { tone?: 'ok'|'warn'|'error'|'idle', text, items?: [{ label, value, tone? }] }（可 async）
//   ctx.status.refresh()         立刻重算并推给在线的设置页 / 面板
//   ctx.action({ id, label, desc?, danger?, confirm?, handler(who, args) })   详情页按钮；handler 返回字符串 / 对象当结果提示
//   ctx.configOptions(field, fn) 配置字段 options:'plugin' 时的选项来源：fn(who) → [{ value, label }]（可 async）
//   ctx.bus.toPage(type, payload) 推给插件自己的页面（经宿主转进 iframe，SDK 里 bridge.on(type, fn) 收）
//   ctx.store                    plugin-data/<id>/store.json 的键值存储：get / set / delete / all（防抖落盘，停用时写完）
//
// 托管子进程（ctx.process）与入站回调（ctx.webhook）的状态自动并进状态块，插件不用自己报。

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { kernel } from './state.mjs';
import { readJson, writeJson } from '../jsonfile.mjs';
import { busPublish, busPublishAll } from '../runtime/bus.mjs';
import { HOST_OWNER } from '../runtime/principal.mjs';

const statusFns = new Map();     // 插件 id → fn
const statusCache = new Map();   // 插件 id → 最近一次结果
const actions = new Map();       // 插件 id → Map(action id → spec)
const optionFns = new Map();     // 插件 id → Map(字段 → fn)
const extras = new Map();        // 插件 id → { processes: () => [], hooks: () => [] }

const TONES = new Set(['ok', 'warn', 'error', 'idle']);
const clip = (s, n) => String(s ?? '').slice(0, n);

function normStatus(v) {
  if (v == null) return null;
  if (typeof v === 'string') return { tone: 'idle', text: clip(v, 200), items: [] };
  if (typeof v !== 'object') return null;
  return {
    tone: TONES.has(v.tone) ? v.tone : 'idle',
    text: clip(v.text, 200),
    items: (Array.isArray(v.items) ? v.items : []).slice(0, 20).map((it) => ({
      label: clip(it && it.label, 40), value: clip(it && it.value, 120), ...(it && TONES.has(it.tone) ? { tone: it.tone } : {}),
    })),
  };
}

// 独立打开的插件页面（新窗口 / 手机的干净 WebView）不在主前端里、收不到总线，各自开一条事件流：插件 id → Set<{ res, admin }>
const pageStreams = new Map();

// 插件页面的可见范围：ui.who === 'members' 时所有在线页面都推（成员也能开面板），否则只推主机。
function pagePublish(pluginId, event) {
  const rec = kernel.rawRecord(pluginId);
  const members = rec?.extra?.ui?.who === 'members';
  if (members) busPublishAll(event);
  else busPublish(HOST_OWNER, event);
  const line = 'data: ' + JSON.stringify(event) + '\n\n';
  for (const s of pageStreams.get(pluginId) || []) if (members || s.admin) { try { s.res.write(line); } catch {} }
}

// 给独立页面开事件流（routes/plugins.mjs GET /api/plugin/<id>/_events 调）。keepAlive() 返回 false 时（票过期）断开。
export function subscribePage(pluginId, res, { admin, keepAlive }) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
  res.write(': ok\n\n');
  const sub = { res, admin: !!admin };
  if (!pageStreams.has(pluginId)) pageStreams.set(pluginId, new Set());
  pageStreams.get(pluginId).add(sub);
  const hb = setInterval(() => {
    if (!kernel.isActive(pluginId) || !keepAlive()) { try { res.end(); } catch {} return; }
    try { res.write(': hb\n\n'); } catch {}
  }, 20_000);
  hb.unref?.();
  const drop = () => { clearInterval(hb); pageStreams.get(pluginId)?.delete(sub); };
  res.on('close', drop);
  res.on('finish', drop);
}

export async function computeStatus(pluginId, { timeoutMs = 1500 } = {}) {
  const fn = statusFns.get(pluginId);
  if (!fn) { statusCache.delete(pluginId); return null; }
  try {
    const v = await Promise.race([Promise.resolve().then(fn), new Promise((r) => setTimeout(() => r(statusCache.get(pluginId) || { tone: 'idle', text: '状态还在算…' }), timeoutMs).unref?.())]);
    const s = normStatus(v);
    statusCache.set(pluginId, s);
    return s;
  } catch (e) {
    const s = { tone: 'error', text: '状态出错：' + clip(e?.message || e, 160), items: [] };
    statusCache.set(pluginId, s);
    return s;
  }
}

// 给前端 / agent 的「显示位」视图（同步：状态取缓存；路由层先 await refreshStatuses）。
export function panelView(pluginId) {
  const ex = extras.get(pluginId);
  const procs = ex?.processes?.() || [];
  const hooks = ex?.hooks?.() || [];
  const acts = [...(actions.get(pluginId)?.values() || [])].map((a) => ({ id: a.id, label: a.label, desc: a.desc || '', danger: !!a.danger, confirm: a.confirm || '' }));
  const status = statusCache.get(pluginId) || null;
  if (!status && !procs.length && !hooks.length && !acts.length) return {};
  // 字段名 panelStatus：插件摘要里的 status 是运行状态（active / disabled / error），别撞
  return { panelStatus: status, processes: procs, hooks, actions: acts, optionFields: [...(optionFns.get(pluginId)?.keys() || [])] };
}

export async function refreshStatuses(ids) {
  await Promise.all(ids.filter((id) => statusFns.has(id)).map((id) => computeStatus(id)));
}

export async function runAction(pluginId, actionId, who, args = {}) {
  const a = actions.get(pluginId)?.get(actionId);
  if (!a) { const e = new Error('没有这个动作'); e.status = 404; throw e; }
  const r = await a.handler(who, args || {});
  computeStatus(pluginId).then((s) => pushStatus(pluginId, s)).catch(() => {});
  if (r == null) return { ok: true };
  return typeof r === 'string' ? { ok: true, message: clip(r, 500) } : { ok: true, ...r };
}

export async function optionsFor(pluginId, field, who) {
  // 精确路径优先；没有就退到所属的顶层字段（登记 'allowGroups' 也管 'allowGroups[]'，'groups' 也管 'groups.$key'）
  const m = optionFns.get(pluginId);
  const fn = m?.get(field) || m?.get(String(field).replace(/\[\]$/, '').replace(/\.\$(key|value)$/, ''));
  if (!fn) return null;
  const list = await fn(who);
  return (Array.isArray(list) ? list : []).slice(0, 500).map((o) => (o && typeof o === 'object' ? { value: o.value, label: clip(o.label ?? o.value, 80), ...(o.desc ? { desc: clip(o.desc, 120) } : {}) } : { value: o, label: clip(o, 80) }));
}

function pushStatus(pluginId, status) {
  // 设置页（只有主机能开）+ 面板页
  busPublish(HOST_OWNER, { type: 'plugins.status', id: pluginId, ...panelView(pluginId) });
  pagePublish(pluginId, { type: 'plugin.event', plugin: pluginId, event: '_status', payload: status });
}

// 每个插件上下文安装一份（host.mjs 的混入调用）。
export function makePanelMixins(ctx, { processes, hooks }) {
  extras.set(ctx.id, { processes, hooks });
  ctx.onDispose(() => {
    extras.delete(ctx.id); statusFns.delete(ctx.id); statusCache.delete(ctx.id); actions.delete(ctx.id); optionFns.delete(ctx.id);
  });

  let pushT = null;
  const status = (fn) => {
    if (typeof fn !== 'function') throw new Error('ctx.status 要一个函数：() => ({ tone, text, items })');
    statusFns.set(ctx.id, fn);
    ctx.onDispose(() => { if (statusFns.get(ctx.id) === fn) statusFns.delete(ctx.id); });
    status.refresh();
  };
  // 合并 300ms 内的多次刷新，免得插件每条消息都刷一次就把总线刷爆
  status.refresh = () => {
    if (pushT) return;
    pushT = setTimeout(() => {
      pushT = null;
      if (!ctx.alive) return;
      computeStatus(ctx.id).then((s) => pushStatus(ctx.id, s)).catch(() => {});
    }, 300);
    pushT.unref?.();
  };
  ctx.onDispose(() => clearTimeout(pushT));

  const action = (spec) => {
    const id = String(spec?.id || '');
    if (!/^[a-z0-9][a-z0-9_-]{0,47}$/i.test(id)) throw new Error('ctx.action 的 id 只能用字母、数字、- 和 _');
    if (typeof spec.handler !== 'function') throw new Error('ctx.action 要 handler(who, args)');
    if (!actions.has(ctx.id)) actions.set(ctx.id, new Map());
    const m = actions.get(ctx.id);
    if (m.has(id)) throw new Error(`动作「${id}」重复`);
    m.set(id, { id, label: clip(spec.label || id, 30), desc: clip(spec.desc, 200), danger: !!spec.danger, confirm: spec.confirm ? clip(spec.confirm, 200) : '', handler: spec.handler });
    ctx.onDispose(() => actions.get(ctx.id)?.delete(id));
  };

  const configOptions = (field, fn) => {
    if (typeof fn !== 'function') throw new Error('ctx.configOptions 要 (field, fn)');
    if (!optionFns.has(ctx.id)) optionFns.set(ctx.id, new Map());
    optionFns.get(ctx.id).set(String(field), fn);
    ctx.onDispose(() => optionFns.get(ctx.id)?.delete(String(field)));
  };

  const toPage = (type, payload) => {
    const t = String(type || '');
    if (!/^[A-Za-z0-9][\w.:-]{0,47}$/.test(t)) throw new Error('事件名只能用字母、数字和 . : - _');
    pagePublish(ctx.id, { type: 'plugin.event', plugin: ctx.id, event: t, payload: payload ?? null });
  };

  return { status, action, configOptions, toPage };
}

export function makeStore(ctx) {
  const file = path.join(ctx.dataDir, 'store.json');
  let data = null;
  let dirty = false, timer = null;
  const load = () => { if (!data) { const j = readJson(file, {}); data = j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } return data; };
  const flush = () => {
    clearTimeout(timer); timer = null;
    if (!dirty) return;
    dirty = false;
    try { mkdirSync(ctx.dataDir, { recursive: true }); writeJson(file, data, 1); } catch (e) { ctx.warn('store.json 写不进去：', e?.message || e); }
  };
  const touch = () => { dirty = true; if (!timer) { timer = setTimeout(flush, 300); timer.unref?.(); } };
  ctx.onDispose(flush);
  const clone = (v) => (v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v);
  return {
    get: (k, dflt) => { const d = load(); return Object.hasOwn(d, k) ? clone(d[k]) : dflt; },
    set: (k, v) => { load()[String(k)] = clone(v); touch(); return v; },
    delete: (k) => { const d = load(); const had = Object.hasOwn(d, k); delete d[k]; if (had) touch(); return had; },
    all: () => clone(load()),
    flush,
  };
}
