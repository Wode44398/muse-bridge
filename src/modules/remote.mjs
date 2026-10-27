// 功能扩展「从 GitHub 一键安装 / 更新」：扩展中心（routes/modules.mjs）与 agent 接口（agent-api/ops/modules.mjs）共用。
//
// 离线包必须和主程序同一次打包（buildId 一致，见 manage.mjs），所以只认「自己这一版」的发版，按这个顺序找：
//   1. 本地发版目录的清单（client-release.mjs 的 clientDistDir；Windows 安装包装本机服务端时，安装器把带 modules 的清单写进
//      数据根\client-dist\latest.json）——buildId 对得上就用它；modules/ 下正好有那个离线包时直接装，不用下载；
//   2. 否则按主程序版本拉 https://github.com/<发版仓库>/releases/download/v<版本>/latest.json（发版仓库从更新源地址推出来）。
//      绝不能用 releases/latest：装着旧版的人拿到的是新版的包，buildId 对不上，installModuleArchive 会拒成 409。
// 下载只走清单里的 https 镜像、只认 GitHub 的域名（含下载重定向到的 *.githubusercontent.com 资产域）：手动跟重定向，每一跳都过
// 白名单；流式落到 STAGING_DIR，边下边算 sha256，大小与哈希都对上才交给 installModuleArchive（排进 .pending，重启后生效）。
// 出站代理不用另管：net-proxy.mjs 已把进程内 fetch 的全局 dispatcher 换成带代理的。
//
// 不提供的情形一律给一句理由（界面显示理由、不出按钮），不当错误抛：源码部署（扩展随主程序代码，内置）、这一版不提供（公开版的
// Codex）、更新源关了 / 不是 GitHub、这一版没在 GitHub 公开发布（私有版的发版仓库匿名下不了）、连不上 GitHub、发版里没有这个扩展。

import crypto from 'node:crypto';
import path from 'node:path';
import { createReadStream, createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MODULE_CATALOG, STAGING_DIR, baseBuildId, moduleStatus, moduleOffered } from './registry.mjs';
import { modulesOverview, installModuleArchive } from './manage.mjs';
import { clientDistDir, localClientManifest, releaseRepo } from '../runtime/client-release.mjs';
import { busPublish } from '../runtime/bus.mjs';
import { HOST_OWNER } from '../runtime/principal.mjs';

const CATALOG_BY_ID = Object.fromEntries(MODULE_CATALOG.map((m) => [m.id, m]));
const UA = 'claude-bridge-modules';
// GitHub 发版资产的下载链：github.com/<仓库>/releases/download/… 302 到资产域（现在是 release-assets，早先是 objects /
// github-releases）。只认这几个主机、只认 https 默认端口、不许带账号密码。
const TRUSTED_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']);
const MAX_REDIRECTS = 5;
const MANIFEST_TIMEOUT = 20_000;
const MANIFEST_OK_MS = 6 * 3600_000;    // 同一版的发版清单基本不变
const MANIFEST_FAIL_MS = 5 * 60_000;    // 连不上 / 没找到：五分钟后再问（界面上的「重试」不等）
const IDLE_TIMEOUT = 60_000;            // 下载中这么久一个字节都没来就算断了
const TOTAL_TIMEOUT = 30 * 60_000;      // 整个下载的上限（Codex 包一百多 MB，慢线路也够）
const MAX_PACKAGE = 3 * 1024 * 1024 * 1024;

const httpErr = (status, message, code = '') => Object.assign(new Error(message), { status, code });

// 测试钩子：本地 http 服务假扮 GitHub（只在测试里设，生产没有入口改它）。
const test = { origins: new Set(), manifestUrl: null };
export function _setTestHooks({ origins = [], manifestUrl = null } = {}) {
  test.origins = new Set(origins);
  test.manifestUrl = manifestUrl;
  rel.key = ''; rel.at = 0; rel.result = null;
}

/** 这个地址能不能下：https、GitHub 的发版 / 资产域、默认端口、没有账号密码。 */
export function trustedUrl(u) {
  let x;
  try { x = new URL(String(u)); } catch { return false; }
  if (test.origins.has(x.origin)) return true;
  return x.protocol === 'https:' && !x.username && !x.password && x.port === '' && TRUSTED_HOSTS.has(x.hostname.toLowerCase());
}
const hostOf = (u) => { try { return new URL(String(u)).host; } catch { return String(u).slice(0, 80); } };

// 手动跟重定向：每一跳都过白名单（自动跟的话中间跳到哪儿都不知道）。
async function trustedFetch(url, { signal, accept = '*/*' } = {}) {
  let cur = String(url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!trustedUrl(cur)) throw httpErr(400, '不是 GitHub 的下载地址（' + hostOf(cur) + '），不下', 'untrusted');
    const res = await fetch(cur, { redirect: 'manual', signal, cache: 'no-store', headers: { 'user-agent': UA, accept } });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) return res;
    try { await res.body?.cancel(); } catch {}
    cur = new URL(loc, cur).href;
  }
  throw httpErr(502, '重定向太多次', 'redirects');
}

// 清单里的离线包条目：只留认得的扩展、有 sha256 的；镜像当场过白名单，过不了的只记主机名（界面上当理由）。
function pickModules(raw, version) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [id, x] of Object.entries(raw)) {
    if (!CATALOG_BY_ID[id] || !x || typeof x !== 'object') continue;
    const sha256 = String(x.sha256 || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(sha256)) continue;
    const all = (Array.isArray(x.mirrors) ? x.mirrors : []).map((u) => (typeof u === 'string' ? u : u && u.url)).filter((u) => typeof u === 'string').slice(0, 8);
    out[id] = {
      file: path.basename(String(x.file || '')).slice(0, 200), size: Math.max(0, Number(x.size) || 0), sha256,
      version: String(x.version || version).slice(0, 40),
      mirrors: all.filter(trustedUrl), untrusted: all.filter((u) => !trustedUrl(u)).map(hostOf),
    };
  }
  return out;
}
const noMirrorReason = (meta) => '清单里没有 GitHub 的下载地址' + (meta.untrusted.length ? '（只有 ' + meta.untrusted.join('、') + '）' : '') + '，不下';

// 主程序版本：打包号形如 2026.10.24.0150+ec3513c，取 + 前那段。
const versionOf = (build) => {
  const v = String(build || '').split('+')[0];
  return /^\d+(\.\d+){1,4}$/.test(v) ? v : '';
};
const manifestUrl = (repo, version) => (test.manifestUrl ? test.manifestUrl(repo, version)
  : `https://github.com/${repo}/releases/download/v${encodeURIComponent(version)}/latest.json`);

const SOURCE_REASON = '源码部署：功能扩展随主程序代码一起，跟着主程序更新，不用另装';

// —— 发版来源（本地清单 / GitHub 上这一版的清单）——
// 结果：{ ok: true, from: 'local'|'github', buildId, version, repo?, modules } 或 { ok: false, code, reason }。
const rel = { key: '', at: 0, result: null, inflight: null };

function localSource(build, version) {
  const m = localClientManifest();
  if (!m || String(m.buildId || '') !== build) return null;
  return { ok: true, from: 'local', buildId: build, version, modules: pickModules(m.modules, version) };
}

async function fetchGithubSource(repo, build, version) {
  let res;
  try {
    res = await trustedFetch(manifestUrl(repo, version), { signal: AbortSignal.timeout(MANIFEST_TIMEOUT), accept: 'application/json' });
  } catch (e) {
    if (e?.code === 'untrusted' || e?.code === 'redirects') return { ok: false, code: 'untrusted', reason: String(e.message) };
    return { ok: false, code: 'offline', reason: '连不上 GitHub（' + String(e?.cause?.code || e?.message || e).slice(0, 120) + '），稍后重试，或手动上传离线包' };
  }
  if (res.status === 404) {
    return { ok: false, code: 'not-found', reason: 'GitHub 上找不到 v' + version + ' 的公开发版（私有版或没公开发布的版本匿名下不了），请手动上传随安装包发的离线包' };
  }
  if (!res.ok) return { ok: false, code: 'offline', reason: 'GitHub 回 HTTP ' + res.status + '，稍后重试，或手动上传离线包' };
  let m;
  try {
    const text = await res.text();
    if (text.length > 512 * 1024) throw new Error('清单太大');
    m = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, code: 'bad-manifest', reason: 'GitHub 上 v' + version + ' 的发版清单读不懂（' + String(e?.message || e).slice(0, 80) + '）' };
  }
  if (String(m?.buildId || '') !== build) {
    return { ok: false, code: 'mismatch', reason: 'GitHub 上 v' + version + ' 的发版和本机主程序不是同一次打包（发版 ' + (m?.buildId || '未标记') + '，本机 ' + build + '），请手动上传随安装包发的离线包' };
  }
  return { ok: true, from: 'github', buildId: build, version, repo, modules: pickModules(m.modules, version) };
}

// 不用联网就能下结论的（源码部署、本地清单对得上、更新源关了）直接回；要问 GitHub 的看缓存。
function quickSource() {
  const build = baseBuildId();
  if (!build) return { ok: false, code: 'source', reason: SOURCE_REASON };
  const version = versionOf(build);
  const local = localSource(build, version);
  if (local) return local;
  const r = releaseRepo();
  if (r.off) return { ok: false, code: 'feed-off', reason: '更新源已关闭（clientUpdateFeed），不从 GitHub 拉；可以手动上传离线包' };
  if (!r.repo) return { ok: false, code: 'feed-custom', reason: '更新源不是 GitHub 发布仓库，找不到这一版的离线包；可以手动上传' };
  if (!version) return { ok: false, code: 'source', reason: '主程序打包号里没有版本号（' + build + '），没法按版本找发版' };
  return { pending: true, key: r.repo + '@' + build, repo: r.repo, build, version };
}

/** 这一版的发版来源（单飞、带缓存）。refresh = 不看缓存重新问 GitHub。 */
export function releaseSource({ refresh = false } = {}) {
  const q = quickSource();
  if (!q.pending) return Promise.resolve(q);
  if (rel.key !== q.key) Object.assign(rel, { key: q.key, at: 0, result: null });
  if (rel.inflight) return rel.inflight;
  if (!refresh && rel.result && Date.now() - rel.at < (rel.result.ok ? MANIFEST_OK_MS : MANIFEST_FAIL_MS)) return Promise.resolve(rel.result);
  const key = q.key;
  rel.inflight = fetchGithubSource(q.repo, q.build, q.version)
    .catch((e) => ({ ok: false, code: 'offline', reason: '查询 GitHub 出错：' + String(e?.message || e).slice(0, 120) }))
    .then((result) => {
      if (rel.key === key) Object.assign(rel, { result, at: Date.now() });
      rel.inflight = null;
      return result;
    });
  return rel.inflight;
}

// 不等网络：有结论回结论，正在问 GitHub 回 null。
function cachedSource() {
  const q = quickSource();
  if (!q.pending) return q;
  return rel.key === q.key && rel.result ? rel.result : null;
}

// —— 每个扩展能不能从 GitHub 装 ——
// { action: 'install'|'update'|null, version, size, from, reason, code, checking, upToDate }——不能装时 reason 是人话、code 给界面换译文
function remoteInfo(st, pending, src) {
  if (st.source === 'builtin') return { action: null, reason: '主程序内置，随主程序一起更新', code: 'builtin' };
  if (!moduleOffered(st.id)) return { action: null, reason: '这一版不提供「' + st.label + '」', code: 'not-offered' };
  if (!src) return { action: null, checking: true, reason: '' };
  if (!src.ok) return { action: null, reason: src.reason, code: src.code };
  const meta = src.modules[st.id];
  if (!meta) return { action: null, reason: '这一版的发版里没有「' + st.label + '」', code: 'absent' };
  const base = { version: meta.version, size: meta.size, from: src.from };
  if (!meta.mirrors.length && src.from !== 'local') return { ...base, action: null, reason: noMirrorReason(meta), code: 'untrusted' };
  if (pending?.action === 'remove') return { ...base, action: null, reason: '已排队卸载，先撤销再装', code: 'remove' };
  if (pending?.action === 'install' && pending.version === meta.version) return { ...base, action: null, reason: '' };
  if (st.installed && !st.error && st.version === meta.version) return { ...base, action: null, upToDate: true, reason: '' };
  return { ...base, action: st.installed ? 'update' : 'install', reason: '' };
}

/** 扩展中心的整张表 + 每项的 remote（能不能从 GitHub 装）与 job（正在装的进度）。waitMs = 最多等 GitHub 多久（之后先回 checking）。 */
export async function modulesOverviewRemote({ refresh = false, waitMs = 0 } = {}) {
  const p = releaseSource({ refresh });
  let src = cachedSource();
  if ((refresh || !src) && waitMs > 0) {
    let timer;
    src = await Promise.race([p, new Promise((r) => { timer = setTimeout(() => r(null), waitMs); })]);
    clearTimeout(timer);
  }
  return decorate(modulesOverview(), src);
}

/** 同上，不等网络（装完回包时用）。 */
export function modulesOverviewNow() { return decorate(modulesOverview(), cachedSource()); }

function decorate(ov, src) {
  return {
    ...ov,
    modules: ov.modules.map((m) => ({ ...m, remote: remoteInfo(m, m.pending, src), job: jobView(m.id) })),
    release: src ? (src.ok ? { ok: true, from: src.from, version: src.version, ...(src.repo ? { repo: src.repo } : {}) } : { ok: false, code: src.code, reason: src.reason }) : { checking: true },
  };
}

// —— 下载与校验 ——
function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    createReadStream(file).on('error', reject).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex')));
  });
}

// 一个镜像下到 dest：大小超了当场断，边下边算哈希，最后大小、哈希都要对上。
async function downloadOne(url, dest, meta, onBytes) {
  const ac = new AbortController();
  let idle = null;
  const kick = () => { clearTimeout(idle); idle = setTimeout(() => ac.abort(new Error('下载卡住（' + IDLE_TIMEOUT / 1000 + ' 秒没有数据）')), IDLE_TIMEOUT); };
  const total = setTimeout(() => ac.abort(new Error('下载超时')), TOTAL_TIMEOUT);
  try {
    kick();
    const res = await trustedFetch(url, { signal: ac.signal, accept: 'application/octet-stream' });
    if (!res.ok || !res.body) throw httpErr(502, 'HTTP ' + res.status);
    const len = Number(res.headers.get('content-length')) || 0;
    if (meta.size && len && len !== meta.size) throw httpErr(502, '大小不对（清单 ' + meta.size + ' 字节，服务器给 ' + len + '）');
    const cap = meta.size || MAX_PACKAGE;
    const h = crypto.createHash('sha256');
    let got = 0;
    const meter = async function* (source) {
      for await (const chunk of source) {
        got += chunk.length;
        if (got > cap) throw httpErr(502, '下载的内容比清单写的大，丢弃');
        h.update(chunk);
        kick();
        onBytes(got, meta.size || len);
        yield chunk;
      }
    };
    await pipeline(Readable.fromWeb(res.body), meter, createWriteStream(dest));
    if (meta.size && got !== meta.size) throw httpErr(502, '下载不完整（' + got + ' / ' + meta.size + ' 字节）');
    const sum = h.digest('hex');
    if (sum !== meta.sha256) throw httpErr(502, 'sha256 不符（清单 ' + meta.sha256.slice(0, 12) + '…，下到的 ' + sum.slice(0, 12) + '…），丢弃', 'sha256');
  } catch (e) {
    rmSync(dest, { force: true });
    if (ac.signal.aborted && ac.signal.reason instanceof Error) throw httpErr(504, ac.signal.reason.message);
    throw e;
  } finally {
    clearTimeout(idle);
    clearTimeout(total);
  }
}

// 本地发版目录里正好有这个包（Windows 安装包随附的 modules\）：大小、哈希对上就直接用，不下载。
async function localPackage(meta) {
  const file = path.join(clientDistDir(), 'modules', path.basename(meta.file || ''));
  if (!meta.file) return null;
  try {
    const st = statSync(file);
    if (!st.isFile() || (meta.size && st.size !== meta.size)) return null;
  } catch { return null; }
  return (await sha256File(file)) === meta.sha256 ? file : null;
}

// —— 安装任务（每个扩展同时只跑一个）——
const jobs = new Map();   // id → { id, phase, received, total, version, from, error, at, promise }
const JOB_KEEP_MS = 10 * 60_000;

function jobView(id) {
  const j = jobs.get(id);
  if (!j) return null;
  if (j.phase === 'done' || j.phase === 'error') {
    if (Date.now() - j.at > JOB_KEEP_MS) { jobs.delete(id); return null; }
    if (j.phase === 'done') return null;   // 装完了看 pending 就够
  }
  return { phase: j.phase, received: j.received, total: j.total, version: j.version, ...(j.error ? { error: j.error } : {}) };
}

let lastPush = 0;
function publish(j, force = false) {
  const now = Date.now();
  if (!force && now - lastPush < 300) return;
  lastPush = now;
  busPublish(HOST_OWNER, { type: 'modules.job', id: j.id, phase: j.phase, received: j.received, total: j.total, version: j.version, ...(j.error ? { error: j.error } : {}) });
}

/**
 * 从发版装 / 更新一个扩展：找同一次打包的离线包 → 下载校验 → installModuleArchive（排进 .pending）。
 * 同一个扩展正在装时返回同一个 Promise。成功回 { ok, id, version, from, restartNeeded }；不能装时抛带 status / code 的错误。
 */
export function installFromRelease(id) {
  if (!CATALOG_BY_ID[id]) return Promise.reject(httpErr(400, '不认识的功能扩展：' + (id || '（没给 id）'), 'unknown'));
  const cur = jobs.get(id);
  if (cur && cur.promise) return cur.promise;
  const j = { id, phase: 'prepare', received: 0, total: 0, version: '', from: '', error: '', at: Date.now(), promise: null };
  jobs.set(id, j);
  j.promise = runJob(j).then((r) => {
    Object.assign(j, { phase: 'done', at: Date.now(), promise: null });
    publish(j, true);
    return r;
  }, (e) => {
    Object.assign(j, { phase: 'error', error: String(e?.message || e), at: Date.now(), promise: null });
    publish(j, true);
    throw e;
  });
  publish(j, true);
  return j.promise;
}

async function runJob(j) {
  const st = moduleStatus(j.id);
  if (!baseBuildId()) throw httpErr(409, SOURCE_REASON, 'source');
  if (st.source === 'builtin') throw httpErr(409, '「' + st.label + '」是主程序内置的，随主程序一起更新，不用另装', 'builtin');
  if (!moduleOffered(j.id)) throw httpErr(409, '这一版不提供「' + st.label + '」', 'not-offered');
  const src = await releaseSource({ refresh: !!(rel.result && !rel.result.ok) });
  if (!src.ok) throw httpErr(src.code === 'offline' ? 503 : 409, src.reason, src.code);
  const meta = src.modules[j.id];
  if (!meta) throw httpErr(409, '这一版的发版里没有「' + st.label + '」', 'absent');
  Object.assign(j, { version: meta.version, total: meta.size, from: src.from });

  mkdirSync(STAGING_DIR, { recursive: true });
  const local = await localPackage(meta);
  if (local) {
    j.phase = 'install'; publish(j, true);
    return { ...(await installModuleArchive(local)), from: 'local' };
  }
  if (!meta.mirrors.length) throw httpErr(409, noMirrorReason(meta), 'untrusted');
  const tmp = path.join(STAGING_DIR, 'gh-' + crypto.randomBytes(5).toString('hex') + '.zip');
  const errors = [];
  try {
    let done = false;
    for (const url of meta.mirrors) {
      j.phase = 'download'; j.received = 0; publish(j, true);
      try {
        await downloadOne(url, tmp, meta, (got, total) => { j.received = got; if (total) j.total = total; publish(j); });
        done = true;
        break;
      } catch (e) {
        errors.push(hostOf(url) + '：' + String(e?.message || e));
        if (e?.code === 'sha256') continue;   // 换下一个镜像
      }
    }
    if (!done) throw httpErr(502, '下载失败：' + errors.join('；'), 'download');
    j.phase = 'install'; publish(j, true);
    return { ...(await installModuleArchive(tmp)), from: 'github' };
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** 正在装的任务（agent 接口查进度用）。 */
export function moduleJobs() {
  return Object.fromEntries(MODULE_CATALOG.map((m) => [m.id, jobView(m.id)]).filter(([, v]) => v));
}
