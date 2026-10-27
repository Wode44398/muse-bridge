// 桌面客户端的更新分发：bridge 把「最新安装包」发给已登记的设备（原先在独立中继里）。
//
// 发版产物放在一个目录里（config.clientDist，默认 <数据根>/client-dist）：
//   latest.json          make-installer.ps1 写的清单（version、file、sha256、mirrors…）
//   <安装包>.exe          清单 file 指向的文件；有 GitHub / OSS 镜像时客户端优先走镜像，这里是兜底
//   modules/<id>.zip     功能扩展离线包（「同时在本机装服务端」的安装才用得到）
// 清单按请求现读：发新版只要把文件放进去，不用重启 bridge。
//
// 上游更新源（S10）：第三方服务器、桌面安装包里的本机服务端，client-dist 里只有装机时那一版（或者干脆没有），
// 自己永远比不出「有新版」。所以再问一个上游清单——config.clientUpdateFeed，默认公开发布仓库
// Wode44398/claude-bridge-releases 的 releases/latest/download/latest.json——本地清单缺失或比上游旧时，
// 发上游那份（只发清单：安装包由客户端按清单里的镜像地址去下，sha256 校验不过就换源）。
// 上游清单后台拉、6 小时一次（失败半小时后再试），请求路径上只读缓存，不阻塞。
// 自己就是发版机（显式配了 clientDist / BRIDGE_CLIENT_DIST，比如维护者的正式服）默认不问上游——本地就是源头；
// 要问就显式写 clientUpdateFeed。clientUpdateFeed 写 "" 或 false = 关（env BRIDGE_CLIENT_UPDATE_FEED 同义，优先）。
//
// 同一份上游清单顺带回答「服务端本身有没有新版」：桌面安装包里的本机服务端随安装包发版
// （程序根 bridge-build.json 记着打包号），上游版本更高 = 更新桌面客户端就能连同服务端一起更新。

import { existsSync, readFileSync, statSync, createReadStream } from 'node:fs';
import path from 'node:path';
import { config } from '../config/index.mjs';
import { DATA_ROOT, PROGRAM_ROOT } from './paths.mjs';

export const DEFAULT_CLIENT_FEED = 'https://github.com/Wode44398/claude-bridge-releases/releases/latest/download/latest.json';
const FEED_OK_MS = 6 * 3600_000;
const FEED_FAIL_MS = 30 * 60_000;

export function clientDistDir() {
  return path.resolve(String(process.env.BRIDGE_CLIENT_DIST || config.clientDist || path.join(DATA_ROOT, 'client-dist')));
}

function readManifest() {
  try { return JSON.parse(readFileSync(path.join(clientDistDir(), 'latest.json'), 'utf8').replace(/^﻿/, '')); }
  catch { return null; }
}

/** 本地发版目录的清单原文（没有 / 解析不了是 null）。 */
export const localClientManifest = () => readManifest();

// 发版仓库（owner/repo）：从更新源地址 https://github.com/<owner>/<repo>/releases/… 推出来；功能扩展「从 GitHub 安装」按它拼
// 这一版的 Release 地址（modules/remote.mjs）。和 clientFeedUrl 不同，配了 clientDist（自己是发版机）不算关——本地清单对不上
// 时还得靠它；把更新源显式写成 "" / false 才是关。回 { repo } / { off: true }（关了）/ { custom: true }（不是 GitHub 发布仓库）。
export function releaseRepo() {
  const v = process.env.BRIDGE_CLIENT_UPDATE_FEED != null ? process.env.BRIDGE_CLIENT_UPDATE_FEED
    : config.clientUpdateFeed != null ? config.clientUpdateFeed : DEFAULT_CLIENT_FEED;
  if (v === false || !String(v).trim()) return { off: true };
  const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/releases(?:\/|$)/i.exec(String(v).trim());
  return m ? { repo: m[1] + '/' + m[2] } : { custom: true };
}

// 版本比较：2026.09.19.1039 逐段按数字（与客户端 main.cjs 的 compareVersions 同一口径）
export function compareVersions(a, b) {
  const x = String(a || '').split(/[.-]/).map((n) => Number(n) || 0);
  const y = String(b || '').split(/[.-]/).map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}

// —— 上游源 ——
export function clientFeedUrl() {
  const pick = (v) => {
    if (v === false) return '';
    const s = String(v).trim();
    return /^https:\/\//i.test(s) ? s : '';
  };
  if (process.env.BRIDGE_CLIENT_UPDATE_FEED != null) return pick(process.env.BRIDGE_CLIENT_UPDATE_FEED);
  if (config.clientUpdateFeed != null) return pick(config.clientUpdateFeed);
  if (process.env.BRIDGE_CLIENT_DIST || config.clientDist) return '';
  return DEFAULT_CLIENT_FEED;
}

const httpsList = (list) => (Array.isArray(list) ? list : [])
  .map((u) => (typeof u === 'string' ? u : u && u.url))
  .filter((u) => typeof u === 'string' && /^https:\/\//i.test(u))
  .slice(0, 8);

// 上游清单只收认得出的字段：没有 sha256、没有 https 镜像的不发（客户端拿不到能校验的包）。
export function sanitizeManifest(m) {
  if (!m || typeof m !== 'object') return null;
  const version = String(m.version || '').trim();
  if (!/^\d+(\.\d+){1,4}$/.test(version)) return null;
  const sha256 = String(m.sha256 || '').trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(sha256)) return null;
  const mirrors = httpsList(m.mirrors);
  if (!mirrors.length) return null;
  const out = {
    version, sha256, mirrors,
    file: path.basename(String(m.file || '')).slice(0, 200),
    size: Math.max(0, Number(m.size) || 0),
    notes: String(m.notes || '').slice(0, 4000),
  };
  if (m.builtAt) out.builtAt = String(m.builtAt).slice(0, 40);
  if (m.buildId) out.buildId = String(m.buildId).slice(0, 80);
  if (m.modules && typeof m.modules === 'object') {
    const mods = {};
    for (const [id, x] of Object.entries(m.modules)) {
      if (!/^[a-z]+$/.test(id) || !x || typeof x !== 'object') continue;
      const ms = httpsList(x.mirrors);
      const sh = String(x.sha256 || '').trim().toLowerCase();
      if (!ms.length || !/^[0-9a-f]{64}$/.test(sh)) continue;
      mods[id] = { file: path.basename(String(x.file || '')).slice(0, 200), size: Math.max(0, Number(x.size) || 0), sha256: sh, version: String(x.version || version).slice(0, 40), mirrors: ms };
    }
    if (Object.keys(mods).length) out.modules = mods;
  }
  return out;
}

const feed = { url: '', at: 0, ok: false, manifest: null, error: '', inflight: null };

/** 拉一次上游清单（单飞）。fetchImpl 给测试注入。 */
export function refreshClientFeed({ force = false, fetchImpl = null } = {}) {
  const url = clientFeedUrl();
  if (!url) { Object.assign(feed, { url: '', manifest: null, error: '', ok: false }); return Promise.resolve(null); }
  if (feed.url !== url) Object.assign(feed, { url, at: 0, ok: false, manifest: null, error: '' });
  if (feed.inflight) return feed.inflight;
  if (!force && feed.at && Date.now() - feed.at < (feed.ok ? FEED_OK_MS : FEED_FAIL_MS)) return Promise.resolve(feed.manifest);
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  feed.inflight = (async () => {
    try {
      const res = await doFetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'follow', cache: 'no-store', headers: { accept: 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (text.length > 512 * 1024) throw new Error('清单太大');
      const m = sanitizeManifest(JSON.parse(text.replace(/^﻿/, '')));
      if (!m) throw new Error('清单格式不对（缺 version / sha256 / https 镜像）');
      Object.assign(feed, { manifest: m, ok: true, error: '' });
    } catch (e) {
      // 失败不清掉上一次拿到的清单：GitHub 抽风时照旧发已知的最新版
      Object.assign(feed, { ok: false, error: String(e?.message || e).slice(0, 200) });
    } finally {
      feed.at = Date.now();
      feed.inflight = null;
    }
    return feed.manifest;
  })();
  return feed.inflight;
}

/** 启动后稍等再预热一次上游清单（出站代理此时已就位），之后按需后台刷新。 */
export function warmClientFeed(delayMs = 15_000) {
  if (!clientFeedUrl()) return;
  const t = setTimeout(() => { refreshClientFeed().catch(() => {}); }, delayMs);
  t.unref?.();
}

function upstreamRelease() {
  if (!clientFeedUrl()) return null;
  refreshClientFeed().catch(() => {});   // 过期了就后台刷新；这次先用缓存
  const m = feed.manifest;
  return m ? { ...m, file: '', size: m.size, downloadPath: '', source: 'upstream' } : null;
}

function localRelease() {
  const manifest = readManifest();
  if (!manifest) return null;
  const name = path.basename(String(manifest.file || ''));
  const file = name ? path.join(clientDistDir(), name) : '';
  let stat = null;
  try { stat = file && existsSync(file) ? statSync(file) : null; } catch {}
  // 安装包不在本地也没关系：清单里有镜像地址时客户端照样能下（这里只回清单）。
  if (!stat || !stat.isFile()) {
    if (!Array.isArray(manifest.mirrors) || !manifest.mirrors.length) return null;
    return { ...manifest, file: '', size: Number(manifest.size) || 0, downloadPath: '' };
  }
  return { ...manifest, file, size: stat.size, downloadPath: '/api/device/client/download' };
}

/** 当前可发的安装包（含本机文件路径 file，路由回包前要去掉），没有就是 null。本地与上游取新的，一样新用本地。 */
export function clientRelease() {
  const local = localRelease();
  const up = upstreamRelease();
  if (up && (!local || compareVersions(up.version, local.version) > 0)) return up;
  return local;
}

/** 功能扩展离线包（latest.json 的 modules[id] → modules/ 下的 zip）。 */
export function clientModuleFile(id) {
  const manifest = readManifest();
  if (!manifest || !/^[a-z]+$/.test(String(id || ''))) return null;
  const meta = manifest.modules && manifest.modules[id];
  const name = meta ? path.basename(String(meta.file || '')) : '';
  const file = name ? path.join(clientDistDir(), 'modules', name) : '';
  try {
    const st = file ? statSync(file) : null;
    return st && st.isFile() ? { file, size: st.size, downloadName: name } : null;
  } catch { return null; }
}

// —— 服务端本身的版本 ——
// 只有打包形态（桌面安装包里的本机服务端）知道自己是哪一版：程序根 bridge-build.json 的 buildId（版本+提交）。
// git 部署 / Docker 没有这个文件——它们走控制台「检查并更新」（update.sh / update.ps1）或重建镜像。
function serverBuildVersion() {
  try {
    const raw = readFileSync(path.join(PROGRAM_ROOT, 'bridge-build.json'), 'utf8');
    const id = String(JSON.parse(raw.replace(/^﻿/, '')).buildId || '');
    const v = id.split('+')[0];
    return /^\d+(\.\d+){1,4}$/.test(v) ? v : null;
  } catch { return null; }
}

/** 控制台「服务控制」用：服务端自己有没有新版（只对打包形态有意义）。 */
export function serverUpdateInfo() {
  const current = serverBuildVersion();
  if (!current) return { packaged: false };
  const best = clientRelease();
  const newer = !!(best && compareVersions(best.version, current) > 0);
  return {
    packaged: true,
    current,
    latest: best ? best.version : null,
    newer,
    notes: newer ? String(best.notes || '').slice(0, 2000) : '',
    feed: clientFeedUrl() ? { checkedAt: feed.at || 0, ok: feed.ok, error: feed.error } : null,
  };
}

/** 按 Range 流式发一个文件（安装包 / 扩展包）。 */
export function streamClientFile(req, res, { file, size, downloadName, version }) {
  if (!file) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  const total = size;
  const range = /^bytes=(\d*)-(\d*)$/i.exec(String(req.headers.range || ''));
  let start = 0, end = total - 1, status = 200;
  if (range) {
    start = range[1] ? Number(range[1]) : 0;
    end = range[2] ? Math.min(total - 1, Number(range[2])) : total - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      res.end();
      return;
    }
    status = 206;
  }
  const name = downloadName || `bridge-client-setup-${version || 'latest'}.exe`;
  // R10：发版时安装包可能正被替换 / 删除。读流出错（含打不开）就回 503 或掐掉这条响应——别挂着不结束，也别冒成
  // 未捕获异常；下载方断开就收掉读流。客户端按 sha256 校验，掐断的那一块会换源 / 重试。
  const stream = createReadStream(file, { start, end });
  stream.on('error', (e) => {
    console.warn('[client-release] 发送 ' + path.basename(file) + ' 失败：' + (e?.code || e?.message || e));
    if (!res.headersSent) { try { res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '30' }); res.end('release file changed, retry'); } catch {} }
    else res.destroy();
  });
  res.on('close', () => stream.destroy());
  stream.once('open', () => {
    res.writeHead(status, {
      'Content-Type': /\.zip$/i.test(name) ? 'application/zip' : 'application/vnd.microsoft.portable-executable',
      'Content-Length': end - start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, no-store',
      'Content-Disposition': `attachment; filename="${name.replace(/"/g, '')}"`,
      ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${total}` } : {}),
    });
    stream.pipe(res);
  });
}

export const _feedState = () => ({ ...feed, inflight: !!feed.inflight });
