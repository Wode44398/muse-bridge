// 官方插件市场：不发 bridge 大版本也能上新插件、更新插件，包括更新内置功能（方案：bridge build/design/插件市场方案.md）。
//
// 市场 = 一个签过名的 index.json（Wode44398/bridge-plugins 仓库滚动 Release「index」的资产），列出全部插件与各版本的
// 下载地址、sha256、大小、engines、更新说明。bridge 只拉这一个文件就能列全部插件、批量算更新（不再一个插件一次 GitHub API）。
//
// 信任链：index.json.sig = {"keyId","sig"}，ed25519 签的是 index.json 原始字节；公钥写死在 market-keys.mjs。
//   索引带 seq（每次发布 +1），记住见过的最大值，拒收更小的（防回滚到旧索引）；zip 下载后按索引里的 sha256 / size 逐字节核对。
//   有签名兜底，下载地址不死守域名：https 任意域，或与索引同源（自建 / 测试市场走 http 回环时用）。
// 盖内置功能的版本（builtin:true）：id 等于内置插件 id，engines.bridge 必须有上界；装进 plugins/.overrides/<id>/（discover.mjs）。
//
// 更新只提示不自动装：正式实例启动 1 分钟后查一次、之后每 6 小时；有变化推总线 plugins.market 给主机，/api/auth 给主机下发数量。
//
// 配置（config.json）：pluginMarket: false 关掉市场；pluginMarket.index 换索引地址；pluginMarket.publicKeys [{id, spki}] 换公钥（给了就只认它们）。
// 环境变量 BRIDGE_PLUGIN_MARKET_INDEX 临时换索引地址（隔离实例端到端测试用）。
//
// 缓存：数据根 plugins/.market/{index.json, index.json.sig, state.json}。读缓存也验签。

import crypto from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.mjs';
import { INSTALLED_PLUGINS_DIR, PluginError, installFromArchive, isBuiltinId, rollbackPlugin, restoreBuiltin, rollbackTarget } from './discover.mjs';
import { compareVersions, enginesProblem, hasUpperBound } from './engines.mjs';
import { MARKET_KEYS, OFFICIAL_INDEX_URL } from './market-keys.mjs';

const MARKET_DIR = path.join(INSTALLED_PLUGINS_DIR, '.market');
const FILES = { index: path.join(MARKET_DIR, 'index.json'), sig: path.join(MARKET_DIR, 'index.json.sig'), state: path.join(MARKET_DIR, 'state.json') };
const MAX_INDEX = 2 * 1024 * 1024;
const MAX_ZIP = 50 * 1024 * 1024;
const STALE_MS = 6 * 3600_000;
const UA = 'claude-bridge-plugins';
const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
const VER_RE = /^\d+\.\d+\.\d+$/;

const test = { keys: null, indexUrl: null };
// 测试钩子：换公钥 / 索引地址（单测里本地 http 服务假扮市场）
export function _setTestHooks({ keys = null, indexUrl = null } = {}) { test.keys = keys; test.indexUrl = indexUrl; mem = null; }

function settings() {
  const raw = config.pluginMarket;
  if (raw === false || (raw && typeof raw === 'object' && raw.enabled === false)) return { off: true };
  const c = raw && typeof raw === 'object' ? raw : {};
  const index = test.indexUrl || process.env.BRIDGE_PLUGIN_MARKET_INDEX || (typeof c.index === 'string' && c.index.trim()) || OFFICIAL_INDEX_URL;
  const custom = Array.isArray(c.publicKeys) ? c.publicKeys.filter((k) => k && typeof k.spki === 'string').map((k) => ({ id: String(k.id || ''), spki: k.spki })) : [];
  return { off: false, index, keys: test.keys || (custom.length ? custom : MARKET_KEYS), official: index === OFFICIAL_INDEX_URL && !custom.length };
}
const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };

// ── 下载 ────────────────────────────────────────────────────────────────
function allowedUrl(u, sameOrigin) {
  let x;
  try { x = new URL(String(u)); } catch { return false; }
  if (x.username || x.password) return false;
  return x.protocol === 'https:' || (!!sameOrigin && x.origin === sameOrigin);
}

async function fetchBytes(url, { max, timeoutMs, sameOrigin }) {
  let cur = String(url);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop <= 5; hop++) {
    if (!allowedUrl(cur, sameOrigin)) throw new PluginError(400, '下载地址不合规（要 https）：' + cur.slice(0, 120));
    let res;
    try { res = await fetch(cur, { redirect: 'manual', signal, headers: { 'user-agent': UA, accept: '*/*' } }); }
    catch (e) { throw new PluginError(502, '连不上插件市场：' + String(e?.cause?.code || e?.message || e).slice(0, 120)); }
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (loc) { try { await res.body?.cancel(); } catch {} cur = new URL(loc, cur).href; continue; }
    if (res.status === 404) throw new PluginError(404, '插件市场上没有这个文件（404）');
    if (!res.ok) throw new PluginError(502, '插件市场回了 HTTP ' + res.status);
    const len = Number(res.headers.get('content-length') || 0);
    if (len > max) throw new PluginError(413, '文件比预期大，没下');
    const chunks = [];
    let size = 0;
    for await (const c of res.body) {
      size += c.length;
      if (size > max) throw new PluginError(413, '文件比预期大，没下');
      chunks.push(c);
    }
    return Buffer.concat(chunks);
  }
  throw new PluginError(502, '重定向太多次');
}

// ── 验签与校验 ───────────────────────────────────────────────────────────
export function verifyIndexSignature(bytes, sigText, keys) {
  let sig;
  try { sig = JSON.parse(String(sigText)); } catch { throw new PluginError(502, '索引的签名文件坏了'); }
  const key = keys.find((k) => k.id === sig?.keyId);
  if (!key) throw new PluginError(502, `索引用的签名钥匙「${String(sig?.keyId || '').slice(0, 40)}」这台 bridge 不认识（可能要先升级 bridge）`);
  let ok = false;
  try {
    const pub = crypto.createPublicKey({ key: Buffer.from(key.spki, 'base64'), format: 'der', type: 'spki' });
    ok = crypto.verify(null, bytes, pub, Buffer.from(String(sig.sig || ''), 'base64'));
  } catch { ok = false; }
  if (!ok) throw new PluginError(502, '索引签名对不上，没采用');
}

const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : '');
const https = (v) => (typeof v === 'string' && /^https:\/\//i.test(v) ? v.slice(0, 300) : '');

export function normalizeIndex(o) {
  if (!o || typeof o !== 'object' || o.format !== 1 || !Array.isArray(o.plugins) || !Number.isInteger(o.seq)) throw new PluginError(502, '索引格式不认识（format 不是 1）');
  const plugins = [];
  const seen = new Set();
  for (const p of o.plugins) {
    if (!p || !ID_RE.test(p.id || '') || seen.has(p.id)) continue;
    const versions = (Array.isArray(p.versions) ? p.versions : [])
      .filter((v) => v && VER_RE.test(v.version || '') && typeof v.url === 'string' && /^[0-9a-f]{64}$/i.test(v.sha256 || '')
        && Number.isInteger(v.size) && v.size > 0 && v.size <= MAX_ZIP)
      .map((v) => ({
        version: v.version,
        engines: v.engines && typeof v.engines === 'object' ? { ...(typeof v.engines.bridge === 'string' ? { bridge: v.engines.bridge } : {}), ...(v.engines.pluginApi != null ? { pluginApi: Number(v.engines.pluginApi) } : {}) } : {},
        restart: !!v.restart, url: v.url, sha256: v.sha256.toLowerCase(), size: v.size,
        date: str(v.date, 10), notes: str(v.notes, 2000),
      }))
      .sort((a, b) => compareVersions(b.version, a.version));
    if (!versions.length) continue;
    seen.add(p.id);
    plugins.push({
      id: p.id, name: str(p.name, 60) || p.id, nameEn: str(p.nameEn, 60), description: str(p.description, 500), descriptionEn: str(p.descriptionEn, 500),
      category: str(p.category, 30) || 'third-party', author: str(p.author, 60), homepage: https(p.homepage), builtin: p.builtin === true, versions,
    });
  }
  return { format: 1, market: str(o.market, 40) || 'official', seq: o.seq, generatedAt: str(o.generatedAt, 40), plugins };
}

// ── 缓存与状态 ───────────────────────────────────────────────────────────
// mem：{ url, index, checkedAt, error } —— 当前索引地址验过签的最新一份。
let mem = null;
let inflight = null;

function readState() {
  try { const s = JSON.parse(readFileSync(FILES.state, 'utf8')); return s && typeof s === 'object' ? s : {}; } catch { return {}; }
}
function writeState(mutate) {
  const s = readState();
  mutate(s);
  mkdirSync(MARKET_DIR, { recursive: true });
  writeFileSync(FILES.state, JSON.stringify(s, null, 2));
  return s;
}
const urlState = (s, url) => (s.byUrl && s.byUrl[url]) || {};

function loadCache(st) {
  if (mem && mem.url === st.index) return mem;
  const s = readState();
  if (s.cachedUrl !== st.index || !existsSync(FILES.index) || !existsSync(FILES.sig)) return null;
  try {
    const raw = readFileSync(FILES.index);
    verifyIndexSignature(raw, readFileSync(FILES.sig, 'utf8'), st.keys);
    const u = urlState(s, st.index);
    mem = { url: st.index, index: normalizeIndex(JSON.parse(raw.toString('utf8'))), checkedAt: u.checkedAt || 0, error: u.error || null };
    return mem;
  } catch (e) {
    console.error('[plugin-market] 缓存的索引用不了：' + (e?.message || e));
    return null;
  }
}

async function refresh(st) {
  if (inflight) return inflight;
  inflight = (async () => {
    const now = Date.now();
    try {
      const sameOrigin = originOf(st.index);
      const raw = await fetchBytes(st.index, { max: MAX_INDEX, timeoutMs: 20_000, sameOrigin });
      const sigText = (await fetchBytes(st.index + '.sig', { max: 4096, timeoutMs: 20_000, sameOrigin })).toString('utf8');
      verifyIndexSignature(raw, sigText, st.keys);
      let parsed;
      try { parsed = JSON.parse(raw.toString('utf8')); } catch { throw new PluginError(502, '索引不是合法 JSON'); }
      const index = normalizeIndex(parsed);
      const seen = Number(urlState(readState(), st.index).maxSeq || 0);
      if (index.seq < seen) throw new PluginError(502, `拉到的索引比上次见过的旧（第 ${index.seq} 版，见过第 ${seen} 版），没采用`);
      mkdirSync(MARKET_DIR, { recursive: true });
      writeFileSync(FILES.index, raw);
      writeFileSync(FILES.sig, sigText);
      writeState((s) => {
        s.cachedUrl = st.index;
        s.byUrl = s.byUrl && typeof s.byUrl === 'object' ? s.byUrl : {};
        s.byUrl[st.index] = { ...(s.byUrl[st.index] || {}), maxSeq: index.seq, checkedAt: now, error: null };
      });
      mem = { url: st.index, index, checkedAt: now, error: null };
      return mem;
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 300);
      writeState((s) => {
        s.byUrl = s.byUrl && typeof s.byUrl === 'object' ? s.byUrl : {};
        s.byUrl[st.index] = { ...(s.byUrl[st.index] || {}), checkedAt: now, error: msg };
      });
      const cached = loadCache(st);
      if (cached) { cached.error = msg; cached.checkedAt = now; return cached; }
      throw e instanceof PluginError ? e : new PluginError(502, msg);
    } finally { inflight = null; }
  })();
  return inflight;
}

// 拿索引：refresh=true 强制重拉；没有缓存或缓存比 maxAgeMs 旧也会拉（拉失败但有缓存时用缓存，error 里带原因）。
export async function getIndex({ refresh: force = false, maxAgeMs = STALE_MS } = {}) {
  const st = settings();
  if (st.off) throw new PluginError(400, '插件市场已关闭（config.json 的 pluginMarket）');
  const cached = loadCache(st);
  if (!force && cached && Date.now() - (cached.checkedAt || 0) < maxAgeMs) return cached;
  return refresh(st);
}

// ── 视图 ────────────────────────────────────────────────────────────────
function versionProblem(entry, v) {
  const why = enginesProblem({ engines: v.engines });
  if (why) return why;
  if (entry.builtin && !hasUpperBound(v.engines.bridge)) return '盖内置功能的版本没写适用到哪一版 bridge';
  return '';
}
const compatible = (entry, v) => !versionProblem(entry, v);

function skippedOf(id) { return String((readState().skipped || {})[id] || ''); }

// 一个市场条目 + 这台 bridge 上的安装状态。这台没有对应内置功能的 builtin 条目返回 null（不展示）。
function viewEntry(kernel, e) {
  const p = kernel.get(e.id);
  if (e.builtin && (!p || p.source !== 'builtin')) return null;
  const latest = e.versions.find((v) => compatible(e, v)) || null;
  let state;
  let current = null;
  if (e.builtin) {
    const ov = p.extra?.override;
    current = ov ? (ov.pending?.install || ov.version || null) : null;
    state = ov && ov.active ? 'override' : 'builtin';
  } else if (!p) state = 'none';
  else if (p.source === 'installed') { state = 'installed'; current = p.version || '0.0.0'; }
  else state = 'taken';
  // 回退 / 恢复内置版时换下来的版本记在 skipped：同一版（及更旧的）不再提示，更新的版本照常提示
  let update = false;
  if (latest) {
    if (state === 'installed' || (e.builtin && current)) update = !(compareVersions(latest.version, current) <= 0);
    else if (e.builtin) update = true;
    const sk = skippedOf(e.id);
    if (update && sk && !(compareVersions(latest.version, sk) > 0)) update = false;
  }
  return {
    id: e.id, name: e.name, nameEn: e.nameEn, description: e.description, descriptionEn: e.descriptionEn,
    category: e.category, author: e.author, homepage: e.homepage, builtin: e.builtin,
    state, current, update,
    latest: latest ? { version: latest.version, date: latest.date, notes: latest.notes, restart: latest.restart, size: latest.size } : null,
    blocked: latest ? '' : versionProblem(e, e.versions[0]),
    versions: e.versions.map((v) => ({ version: v.version, date: v.date, notes: v.notes, restart: v.restart, size: v.size, problem: versionProblem(e, v) })),
    rollback: rollbackTarget(kernel, e.id)?.version || null,
  };
}

export function marketStatus() {
  const st = settings();
  if (st.off) return { off: true };
  const m = loadCache(st);
  return { off: false, official: st.official, ok: !!m, seq: m?.index.seq ?? null, generatedAt: m?.index.generatedAt || '', checkedAt: m?.checkedAt || urlState(readState(), st.index).checkedAt || 0, error: m ? m.error : urlState(readState(), st.index).error || null };
}

export async function marketOverview(kernel, { refresh: force = false } = {}) {
  const st = settings();
  if (st.off) return { market: { off: true }, plugins: [], updates: [] };
  let err = null;
  // 用户打开功能扩展页时缓存超过 15 分钟就顺手重拉一次（定时检查是 6 小时一次）
  try { await getIndex({ refresh: force, maxAgeMs: 15 * 60_000 }); } catch (e) { err = String(e?.message || e); }
  const plugins = mem && mem.url === st.index ? mem.index.plugins.map((e) => viewEntry(kernel, e)).filter(Boolean) : [];
  const market = marketStatus();
  if (err && !market.error) market.error = err;
  announceUpdates(kernel);
  return { market, plugins, updates: plugins.filter((p) => p.update).map((p) => ({ id: p.id, name: p.name, current: p.current, latest: p.latest.version, builtin: p.builtin })) };
}

// 「有更新」的名单变了就推给主机（总线 plugins.market：设置里的角标、功能扩展页据此刷新）。发布函数由 host.mjs 登记。
let publisher = null;
let lastKey = '';
export function setUpdatesPublisher(fn) { publisher = typeof fn === 'function' ? fn : null; }
export function announceUpdates(kernel) {
  const ids = pendingUpdates(kernel);
  const key = ids.join(',');
  if (key !== lastKey) { lastKey = key; try { publisher?.(ids); } catch {} }
  return ids;
}

// 只用缓存算「有几个更新」（/api/auth 下发、不碰网络）。
export function pendingUpdates(kernel) {
  const st = settings();
  if (st.off) return [];
  const m = loadCache(st);
  if (!m) return [];
  return m.index.plugins.map((e) => viewEntry(kernel, e)).filter((p) => p && p.update).map((p) => p.id);
}

// ── 安装 / 回退 / 恢复内置版 ─────────────────────────────────────────────
export async function installFromMarket(kernel, id, version = '') {
  const m = await getIndex({});
  const e = m.index.plugins.find((x) => x.id === id);
  if (!e) throw new PluginError(404, '插件市场里没有「' + id + '」');
  const v = version ? e.versions.find((x) => x.version === version) : e.versions.find((x) => compatible(e, x));
  if (!v) throw new PluginError(version ? 404 : 409, version ? `「${e.name}」没有 v${version}` : `「${e.name}」没有适合这台 bridge 的版本：${versionProblem(e, e.versions[0])}`);
  const why = versionProblem(e, v);
  if (why) throw new PluginError(409, why);
  if (e.builtin && !isBuiltinId(id)) throw new PluginError(409, `这台 bridge 没有内置功能「${id}」`);
  if (!e.builtin) {
    const p = kernel.get(id);
    if (p && p.source !== 'installed') throw new PluginError(409, `id「${id}」已被${p.source === 'local' ? '本机开发目录' : p.source === 'builtin' ? '内置功能' : 'agent 扩展'}占用`);
  }
  const buf = await fetchBytes(v.url, { max: v.size, timeoutMs: 5 * 60_000, sameOrigin: originOf(m.url) });
  if (buf.length !== v.size) throw new PluginError(502, `下载的包大小不对（${buf.length} ≠ ${v.size}），没装`);
  const sha = crypto.createHash('sha256').update(buf).digest('hex');
  if (sha !== v.sha256) throw new PluginError(502, '下载的包校验不对（sha256 不符），没装');
  const p = await installFromArchive(kernel, buf, { expect: { id, version: v.version }, builtin: e.builtin });
  kernel.writeState((s) => {
    s.sources = s.sources && typeof s.sources === 'object' ? s.sources : {};
    s.sources[id] = { market: m.index.market || 'official', version: v.version, at: Date.now() };
  });
  writeState((s) => { if (s.skipped) delete s.skipped[id]; });
  announceUpdates(kernel);
  return p;
}

export async function rollbackInstalled(kernel, id) {
  const before = kernel.get(id);
  const from = before?.extra?.override?.version || before?.version || '';
  const p = await rollbackPlugin(kernel, id);
  const to = p.extra?.override?.pending?.install || p.extra?.override?.version || p.version || '';
  // 从新版退回旧版：记下退掉的那一版，别再拿它提示「有更新」
  writeState((s) => {
    s.skipped = s.skipped && typeof s.skipped === 'object' ? s.skipped : {};
    if (from && to && compareVersions(from, to) > 0) s.skipped[id] = from; else delete s.skipped[id];
  });
  kernel.writeState((s) => { if (s.sources && s.sources[id]) s.sources[id] = { ...s.sources[id], version: p.extra?.override?.pending?.install || p.extra?.override?.version || p.version || '', at: Date.now() }; });
  announceUpdates(kernel);
  return p;
}

// 恢复内置版：记下换下来的市场版版本，同一版不再提示「有更新」（更新的版本照常提示）。
export async function restoreBuiltinVersion(kernel, id) {
  const ov = kernel.get(id)?.extra?.override;
  const p = await restoreBuiltin(kernel, id);
  const ver = ov?.pending?.install || ov?.version || '';
  if (ver) writeState((s) => { s.skipped = s.skipped && typeof s.skipped === 'object' ? s.skipped : {}; s.skipped[id] = ver; });
  announceUpdates(kernel);
  return p;
}

// ── 定时检查（只提示）────────────────────────────────────────────────────
export function startMarketWatcher(kernel, { firstDelayMs = 60_000, everyMs = STALE_MS } = {}) {
  const tick = async () => {
    try { await getIndex({ refresh: true }); } catch (e) { console.error('[plugin-market] 检查更新失败：' + (e?.message || e)); }
    announceUpdates(kernel);
  };
  const t1 = setTimeout(tick, firstDelayMs);
  const t2 = setInterval(tick, everyMs);
  t1.unref?.(); t2.unref?.();
  return () => { clearTimeout(t1); clearInterval(t2); };
}
