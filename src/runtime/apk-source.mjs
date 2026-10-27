// 手机 App 从哪来（开源路线 S1-4「手机 App 跟着服务端走」）：服务端发它自己这一版对应的 apk。
//
// 版本对齐策略（App 内更新只认所连的这台服务端）：
//   1. App 只问自己连着的服务端（/api/app/version），从不去问项目方或别的源——第三方服务器、fork 出来的服务端都能发自己的包。
//   2. 服务端只发「版本号 ≤ 自己」的包，优先正好等于自己的那一版（同一次构建）：apk 里打着前端，比服务端新的前端可能要用
//      服务端还没有的接口；比服务端旧的前端服务端保证兼容（接口只增不改，老 App 照常能用，只是看不到新功能）。
//   3. 手机上装的比服务端新（连去了一台旧服务器）：不降级、不提示更新，设置里写明「App 比服务器新」。
//   4. 签名不同的包（别的发行渠道 / fork 自编译）壳侧拒装，并提示需要卸载重装（见安卓壳 MainActivity.install）。
//
// 包从哪来（按顺序，第一个可用的为准）：
//   a. 程序目录里本地出的包：ClaudeBridge-offline-<versionCode>.apk（build-apk.ps1 写的；安装包 -WithApk 时也带这一份）。
//      没有正好这一版时取 ≤ 服务端的最高一版；一个版本化文件都没有时才认旧的单一文件名 ClaudeBridge-offline.apk（手工构建）。
//   b. 数据根 app/ 里的缓存：从公开 Release 按 sha256 下载下来的（见 d）。
//   c. OSS 镜像清单（config.apkMirror，VPS 用；见 apk-mirror.mjs）：下载 302 过去。
//   d. 公开 Release 的 apk 资产：发布清单 latest.json 里的 android 条目（config.apkFeed；默认与桌面客户端的上游更新清单同一份，
//      见 client-release.mjs clientFeedUrl()）。下载先 302 过去，同时后台按 sha256 拉一份到数据根缓存（config.apkPrefetch=false 关），
//      之后就从本机发（局域网里快、国内访问 GitHub 慢也只慢服务端那一次）。缓存失败按条目退避（30 分钟起翻倍，封顶 12 小时），
//      不会每次有人查版本就再拉一遍整包。
//      latest 清单里没有 ≤ 服务端的条目（服务端没跟上最新版：装的是旧安装包、Docker 固定了旧镜像）时，打包形态的服务端
//      （程序根 bridge-build.json 记着自己是哪次发布）再取自己那次发布的清单 releases/download/v<版本>/latest.json。
//   都没有：/api/app/version 回 available:false + 发布页链接（有的话），界面写「这台服务器没有可发的 App 版本」。
//
// 清单 android 条目：{ code, name, notes?, sha256, size, url | mirrors[] }，也可以是数组（多版本，取 ≤ 服务端的最高一版；
// 发版脚本应把历史版本留在数组里、写带版本标签的绝对地址，旧服务端才找得到自己那一版）。相对 url 按清单自己的 version 标签补全
// （releases/latest/download/ 会随新发布漂走，按它补全的地址在缓存期内发了新版就 404）。
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DATA_ROOT, PROGRAM_ROOT } from './paths.mjs';
import { config } from '../config/index.mjs';
import { APP_VERSION_CODE, APP_VERSION_NAME, APP_RELEASE_NOTES } from '../config/versions.mjs';
import { mirrorApk, mirrorStatus, normManifest } from './apk-mirror.mjs';
import { clientFeedUrl } from './client-release.mjs';

const FEED_OK_MS = 6 * 3600_000;
const FEED_FAIL_MS = 30 * 60_000;
const MAX_APK_BYTES = 200 * 1024 * 1024;

// —— 纯函数（单测覆盖）———————————————————————————————————————————————————————

/** 文件名里的版本号：ClaudeBridge-offline-465.apk / ClaudeBridge-465.apk → 465；认不出回 0。 */
export function apkCodeOf(name) {
  const m = /^ClaudeBridge(?:-offline)?-(\d+)\.apk$/i.exec(path.basename(String(name || '')));
  return m ? Number(m[1]) : 0;
}

/** 一组 {code} 里挑「≤ max 的最高一版」，优先正好等于 max 的。没有回 null。 */
export function pickBest(list, max) {
  let best = null;
  for (const x of list || []) {
    if (!x || !(x.code > 0) || x.code > max) continue;
    if (!best || x.code > best.code) best = x;
  }
  return best;
}

/** 发布清单里的 android 条目 → 规整后的列表（缺 sha256 / 大小 / https 地址的不认）。 */
export function androidEntries(manifest, base = '') {
  const raw = manifest && typeof manifest === 'object' ? manifest.android : null;
  const arr = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const out = [];
  for (const e of arr.slice(0, 20)) {
    if (!e || typeof e !== 'object') continue;
    const url = typeof e.url === 'string' && e.url ? e.url
      : (Array.isArray(e.mirrors) ? e.mirrors.map((m) => (typeof m === 'string' ? m : m && m.url)).find((u) => typeof u === 'string' && /^https:\/\//i.test(u)) : '');
    const n = normManifest({ ...e, url }, base);
    if (n && /^https:\/\//i.test(n.url)) out.push(n);
  }
  return out;
}

/**
 * GitHub 的 releases/latest/download/<文件> → 某次发布标签下的同一个文件（releases/download/v<版本>/<文件>，
 * 与发版脚本 publish-github.mjs 的 assetUrl 同一算法）。认不出 / 版本号不像样回 ''。
 */
export function taggedFeedUrl(feedUrl, version) {
  const v = String(version || '');
  if (!/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(v)) return '';
  const m = /^(https:\/\/github\.com\/[^/]+\/[^/]+\/releases)\/latest\/download\/([^/?#]+)$/i.exec(String(feedUrl || ''));
  return m ? `${m[1]}/download/v${v}/${m[2]}` : '';
}

/** 打包形态（桌面安装包里的本机服务端）知道自己是哪次发布：程序根 bridge-build.json 的 version（stage.ps1 写的）。git 部署 / Docker 回 ''。 */
export function ownReleaseVersion(programRoot = PROGRAM_ROOT) {
  try {
    const j = JSON.parse(readFileSync(path.join(programRoot, 'bridge-build.json'), 'utf8').replace(/^﻿/, ''));
    const v = String(j.version || String(j.buildId || '').split('+')[0] || '');
    return /^\d+(\.\d+){1,4}$/.test(v) ? v : '';
  } catch { return ''; }
}

/** 发布页链接：配置优先；否则从 GitHub 的 releases/…/latest.json 推出 releases/latest。 */
export function releasePageFrom(feedUrl, explicit = '') {
  const e = String(explicit || '').trim();
  if (/^https:\/\//i.test(e)) return e;
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/releases\b/i.exec(String(feedUrl || ''));
  return m ? `https://github.com/${m[1]}/${m[2]}/releases/latest` : '';
}

// —— 本地文件 ————————————————————————————————————————————————————————————————

const CACHE_DIR = () => path.join(DATA_ROOT, 'app');
const hashCache = new Map();   // file → { mtime, size, sha256 }

function fileMeta(file) {
  let st;
  try { st = statSync(file); } catch { return null; }
  if (!st.isFile() || !st.size) return null;
  const c = hashCache.get(file);
  if (c && c.mtime === st.mtimeMs && c.size === st.size) return { file, size: st.size, sha256: c.sha256, stat: st };
  try {
    const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
    hashCache.set(file, { mtime: st.mtimeMs, size: st.size, sha256 });
    return { file, size: st.size, sha256, stat: st };
  } catch { return null; }
}

function listVersioned(dir) {
  try {
    return readdirSync(dir).map((n) => ({ code: apkCodeOf(n), file: path.join(dir, n) })).filter((x) => x.code > 0);
  } catch { return []; }
}

/**
 * 本机有的那一份（程序目录 → 数据根缓存）：{ file, code, size, sha256, stat, source:'local'|'cache' }，没有回 null。
 * programRoot / dataRoot / serverCode 给测试注入。
 */
export function localApk({ programRoot = PROGRAM_ROOT, dataRoot = DATA_ROOT, serverCode = APP_VERSION_CODE } = {}) {
  const prog = listVersioned(programRoot);
  const cache = listVersioned(path.join(dataRoot, 'app'));
  const cands = [...prog.map((x) => ({ ...x, source: 'local' })), ...cache.map((x) => ({ ...x, source: 'cache' }))];
  // 同一版本程序目录优先（排序：版本号高的在前，同版本 local 在前）
  cands.sort((a, b) => (b.code - a.code) || (a.source === 'local' ? -1 : 1));
  const best = pickBest(cands, serverCode);
  if (best) {
    const same = cands.filter((x) => x.code === best.code);
    for (const c of same) { const m = fileMeta(c.file); if (m) return { ...m, code: c.code, source: c.source }; }
  }
  // 一个版本化文件都没有：认旧的单一文件名（手工构建），按服务端版本号报（老行为）
  if (!prog.length) {
    const m = fileMeta(path.join(programRoot, 'ClaudeBridge-offline.apk'));
    if (m) return { ...m, code: serverCode, source: 'local' };
  }
  return null;
}

// —— 公开 Release（发布清单 android 条目）——————————————————————————————————————

export function apkFeedUrl() {
  const pick = (v) => { if (v === false) return ''; const s = String(v).trim(); return /^https:\/\//i.test(s) ? s : ''; };
  if (process.env.BRIDGE_APK_FEED != null) return pick(process.env.BRIDGE_APK_FEED);
  if (config.apkFeed != null) return pick(config.apkFeed);
  return clientFeedUrl();
}
const feed = { url: '', at: 0, ok: false, entries: [], error: '', inflight: null };

/**
 * url / fetchImpl / serverCode / ownVersion 给测试注入（默认：配置的清单地址、全局 fetch、服务端版本号、bridge-build.json 的发布版本）。
 */
export function refreshApkFeed({ force = false, fetchImpl = null, url: feedUrl = null, serverCode = APP_VERSION_CODE, ownVersion = null } = {}) {
  const url = feedUrl != null ? feedUrl : apkFeedUrl();
  if (!url) { Object.assign(feed, { url: '', entries: [], ok: false, error: '' }); return Promise.resolve([]); }
  if (feed.url !== url) Object.assign(feed, { url, at: 0, ok: false, entries: [], error: '' });
  if (feed.inflight) return feed.inflight;
  if (!force && feed.at && Date.now() - feed.at < (feed.ok ? FEED_OK_MS : FEED_FAIL_MS)) return Promise.resolve(feed.entries);
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const getManifest = async (u) => {
    const res = await doFetch(u, { signal: AbortSignal.timeout(20_000), redirect: 'follow', cache: 'no-store', headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    if (text.length > 512 * 1024) throw new Error('清单太大');
    return JSON.parse(text.replace(/^﻿/, ''));
  };
  // 相对地址按清单自己的版本标签补全（见文件头）；清单没写 version / 不是 GitHub 的 latest 地址就按清单地址补全
  const entriesOf = (m, u) => androidEntries(m, taggedFeedUrl(u, m && m.version) || u);
  feed.inflight = (async () => {
    try {
      let entries = entriesOf(await getManifest(url), url);
      // latest 里没有 ≤ 服务端的：再取自己那次发布的清单（只有打包形态知道自己是哪次发布）
      if (!pickBest(entries, serverCode)) {
        const own = taggedFeedUrl(url, ownVersion != null ? ownVersion : ownReleaseVersion());
        if (own && own !== url) {
          try { entries = entries.concat(entriesOf(await getManifest(own), own)); }
          catch { /* 那次发布没挂清单 / 拉不到：照旧按 latest 的结果（没有可发的） */ }
        }
      }
      feed.entries = entries;
      feed.ok = true; feed.error = '';
    } catch (e) { feed.ok = false; feed.error = String(e?.message || e).slice(0, 200); }
    finally { feed.at = Date.now(); feed.inflight = null; }
    return feed.entries;
  })();
  return feed.inflight;
}

/** Release 里能发给客户端的那一版（≤ 服务端）；过期了顺手后台刷新。 */
export function releaseApk(serverCode = APP_VERSION_CODE) {
  if (!apkFeedUrl()) return null;
  refreshApkFeed().catch(() => {});
  const best = pickBest(feed.entries, serverCode);
  return best ? { ...best, source: 'release' } : null;
}

// —— 后台缓存（从 Release 按 sha256 拉到数据根）——————————————————————————————————
let prefetchP = null;
let prefetchErr = '';
const prefetchOn = () => process.env.BRIDGE_APK_PREFETCH !== '0' && config.apkPrefetch !== false && process.env.BRIDGE_NO_AUTH !== '1';

// 失败退避：按条目（版本号 + 哈希 + 大小 + 地址）记失败次数与时间。currentApk() 每次查版本、每次下载都会走到预取，
// 没有退避的话访问 GitHub 慢 / 被墙、或清单里哈希 / 大小写错时，每次有手机查版本就再拉一遍整包。
// 退避期内照样 302 到发布页（手机自己去下），只是服务端不再重试缓存。清单改对了（哈希 / 大小 / 地址变了）就是新条目，马上能试。
const PREFETCH_BACKOFF_MS = 30 * 60_000;
const PREFETCH_BACKOFF_MAX_MS = 12 * 3600_000;
const prefetchFails = new Map();
const prefetchKey = (e) => `${e.code}:${e.sha256}:${e.size}:${e.url}`;
/** 这个条目还要等多久才能再试缓存（毫秒，0 = 现在就能试）。 */
export function prefetchBackoffLeft(entry, now = Date.now()) {
  const f = entry && prefetchFails.get(prefetchKey(entry));
  if (!f) return 0;
  const wait = Math.min(PREFETCH_BACKOFF_MS * 2 ** Math.max(0, f.n - 1), PREFETCH_BACKOFF_MAX_MS);
  return Math.max(0, f.at + wait - now);
}

export function prefetchApk(entry, { dataRoot = DATA_ROOT, fetchImpl = null } = {}) {
  if (!entry || prefetchP) return prefetchP;
  const dir = path.join(dataRoot, 'app');
  const final = path.join(dir, `ClaudeBridge-${entry.code}.apk`);
  if (existsSync(final)) return Promise.resolve(final);
  if (!(entry.size > 0) || entry.size > MAX_APK_BYTES) return Promise.resolve(null);
  if (prefetchBackoffLeft(entry) > 0) return Promise.resolve(null);
  const key = prefetchKey(entry);
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  prefetchP = (async () => {
    mkdirSync(dir, { recursive: true });
    const part = final + '.partial';
    const ac = new AbortController();
    const overall = setTimeout(() => ac.abort(new Error('下载超过 20 分钟')), 20 * 60_000);
    overall.unref?.();
    try {
      const res = await doFetch(entry.url, { signal: ac.signal, redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      const hash = createHash('sha256');
      let got = 0;
      const meter = new Transform({
        transform(chunk, _e, cb) {
          got += chunk.length; hash.update(chunk);
          if (got > entry.size) { cb(new Error('比清单写的大')); return; }
          cb(null, chunk);
        },
      });
      await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(part), { signal: ac.signal });
      if (got !== entry.size) throw new Error(`大小不对（应为 ${entry.size}，下到 ${got}）`);
      if (hash.digest('hex') !== entry.sha256) throw new Error('SHA-256 对不上，已丢弃');
      renameSync(part, final);
      // 旧缓存只留两版
      for (const x of listVersioned(dir).sort((a, b) => b.code - a.code).slice(2)) { try { rmSync(x.file, { force: true }); } catch {} }
      prefetchErr = '';
      prefetchFails.delete(key);
      console.log(`[apk] 已从发布页缓存 App ${entry.name}（${entry.code}）到 ${final}`);
      return final;
    } catch (e) {
      try { rmSync(part, { force: true }); } catch {}
      prefetchErr = String(e?.message || e).slice(0, 200);
      const n = (prefetchFails.get(key)?.n || 0) + 1;
      prefetchFails.set(key, { at: Date.now(), n });
      if (prefetchFails.size > 20) prefetchFails.delete(prefetchFails.keys().next().value);
      console.warn(`[apk] 缓存 App 失败（第 ${n} 次，${Math.round(prefetchBackoffLeft(entry) / 60_000)} 分钟后再试）：` + prefetchErr);
      return null;
    } finally { clearTimeout(overall); prefetchP = null; }
  })();
  return prefetchP;
}

// —— 对外 ————————————————————————————————————————————————————————————————————

/**
 * 这台服务端此刻能发的那一份：
 *   { kind:'file', file, stat, code, name, size, sha256, source }  本机文件（流式发）
 *   { kind:'redirect', url, code, name, size, sha256, notes, source }  镜像 / Release（302 过去）
 *   null  没有
 */
export function currentApk() {
  const loc = localApk();
  if (loc) return { kind: 'file', ...loc, name: loc.code === APP_VERSION_CODE ? APP_VERSION_NAME : String(loc.code), notes: loc.code === APP_VERSION_CODE ? APP_RELEASE_NOTES : '' };
  const m = mirrorApk();
  if (m) return { kind: 'redirect', ...m, source: 'mirror' };
  const r = releaseApk();
  if (r) {
    if (prefetchOn()) prefetchApk(r).catch(() => {});
    return { kind: 'redirect', ...r };
  }
  return null;
}

/** 发布页链接（「这台服务器没有可发的 App 版本」时给人去下载）。 */
export function releasePage() {
  return releasePageFrom(apkFeedUrl(), config.appReleasePage || process.env.BRIDGE_APP_RELEASE_PAGE || '');
}

/** /api/app/version 的回包。 */
export function appVersionInfo() {
  const a = currentApk();
  const server = { code: APP_VERSION_CODE, name: APP_VERSION_NAME };
  const common = { downloadUrl: '/api/app/download', pageUrl: '/download/android', server, policy: 'same-or-older', releasePage: releasePage() };
  if (!a) {
    // 服务器已升版但本机没有包、也没有可用的镜像 / 发布页：客户端据此不提示下载
    return { code: APP_VERSION_CODE, name: APP_VERSION_NAME, notes: APP_RELEASE_NOTES, sha256: '', size: 0, available: false, source: 'none', ...common };
  }
  return { code: a.code, name: a.name || String(a.code), notes: a.notes || '', sha256: a.sha256 || '', size: a.size || 0, available: true, source: a.source, ...common };
}

/** 控制台「服务控制」看安装包从哪来。 */
export function apkStatus() {
  const loc = localApk();
  const usable = pickBest(feed.entries, APP_VERSION_CODE);
  return {
    local: loc ? { code: loc.code, size: loc.size, source: loc.source } : null,
    mirror: mirrorStatus(),
    release: { feed: apkFeedUrl(), ok: feed.ok, error: feed.error, checkedAt: feed.at, latest: pickBest(feed.entries, Infinity), usable: !!usable, code: usable ? usable.code : 0, prefetch: prefetchOn(), prefetchError: prefetchErr },
    serverCode: APP_VERSION_CODE,
  };
}

/** 启动后稍等预热一次发布清单（本机没包时才需要）。 */
export function warmApkFeed(delayMs = 20_000) {
  if (!apkFeedUrl() || process.env.BRIDGE_NO_AUTH === '1') return;
  const t = setTimeout(() => { if (!localApk() && !mirrorApk()) refreshApkFeed().then(() => currentApk()).catch(() => {}); }, delayMs);
  t.unref?.();
}
