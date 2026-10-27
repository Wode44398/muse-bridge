// 从 GitHub 装第三方插件 / 检查更新（设置 › 扩展 › 功能扩展 › 添加 › GitHub 地址）。
//
// 地址写法：owner/repo、owner/repo@ref、https://github.com/owner/repo（/tree/<ref>）。
// 取哪个包：写了 ref → 那个 ref 的源码 zip；没写 → 最新 Release（有 .zip 资产用资产，没有用该 tag 的源码 zip）；
// 仓库还没发过 Release → 默认分支的源码 zip。拿到 zip 交给 discover.installFromArchive（清单在包根或唯一一层子目录都认）。
// 来源记进 plugins.json 的 sources[id]，详情页据此「检查更新」（比最新 Release 的 tag 和清单版本号）。
//
// 下载只认 GitHub 的几个域、https 默认端口、不带账号密码，重定向逐跳过白名单（同 modules/remote.mjs 的做法）；包最大 50MB。
// 不做中心化的插件市场：装谁的插件由主机自己决定（插件同进程全权限，只装信任的）。

import { installFromArchive, PluginError } from './discover.mjs';
import { compareVersions } from './engines.mjs';

const TRUSTED = new Set(['github.com', 'api.github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com', 'github-releases.githubusercontent.com']);
const UA = 'claude-bridge-plugins';
const MAX_ZIP = 50 * 1024 * 1024;
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

const test = { origins: new Set(), api: null, codeload: null };
// 测试钩子：本地 http 服务假扮 GitHub
export function _setTestHooks({ origins = [], api = null, codeload = null } = {}) { test.origins = new Set(origins); test.api = api; test.codeload = codeload; }
const API = () => test.api || 'https://api.github.com';
const CODELOAD = () => test.codeload || 'https://codeload.github.com';

export function trusted(u) {
  let x;
  try { x = new URL(String(u)); } catch { return false; }
  if (test.origins.has(x.origin)) return true;
  return x.protocol === 'https:' && !x.username && !x.password && x.port === '' && TRUSTED.has(x.hostname.toLowerCase());
}

export function parseRepo(input) {
  let s = String(input || '').trim().replace(/\.git$/, '');
  let ref = '';
  const url = /^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/tree\/([^#?]+))?/i.exec(s);
  if (url) { s = url[1] + '/' + url[2]; ref = url[3] ? decodeURIComponent(url[3]) : ''; }
  const at = s.indexOf('@');
  if (at > 0) { ref = s.slice(at + 1); s = s.slice(0, at); }
  const [owner, repo, extra] = s.split('/');
  const bad = (x) => !NAME.test(x || '') || /^\.+$/.test(x);
  if (extra !== undefined || bad(owner) || bad(repo)) throw new PluginError(400, 'GitHub 地址看不懂：写 owner/repo、owner/repo@ref，或仓库网址');
  if (ref && !/^[A-Za-z0-9_./-]{1,200}$/.test(ref)) throw new PluginError(400, 'ref 不合法');
  return { owner, repo, ref };
}

async function gfetch(url, { accept = '*/*', signal } = {}) {
  let cur = String(url);
  for (let hop = 0; hop <= 5; hop++) {
    if (!trusted(cur)) throw new PluginError(400, '不是 GitHub 的地址，不下：' + (() => { try { return new URL(cur).host; } catch { return cur.slice(0, 60); } })());
    const res = await fetch(cur, { redirect: 'manual', signal, headers: { 'user-agent': UA, accept } });
    const loc = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!loc) return res;
    try { await res.body?.cancel(); } catch {}
    cur = new URL(loc, cur).href;
  }
  throw new PluginError(502, '重定向太多次');
}

async function apiJson(path) {
  const res = await gfetch(API() + path, { accept: 'application/vnd.github+json', signal: AbortSignal.timeout(20_000) });
  if (res.status === 404) return null;
  if (res.status === 403 || res.status === 429) throw new PluginError(429, 'GitHub 限流了（未登录每小时 60 次），过一会儿再试');
  if (!res.ok) throw new PluginError(502, 'GitHub 回了 HTTP ' + res.status);
  return res.json();
}

const tagVersion = (tag) => String(tag || '').replace(/^v/i, '');

// 找出要下的 zip：{ zipUrl, tag, version, ref }
export async function resolvePackage({ owner, repo, ref }) {
  const zipOf = (r) => `${CODELOAD()}/${owner}/${repo}/zip/${encodeURIComponent(r).replace(/%2F/g, '/')}`;
  if (ref) return { zipUrl: zipOf(ref), tag: '', version: '', ref };
  const rel = await apiJson(`/repos/${owner}/${repo}/releases/latest`);
  if (rel && rel.tag_name) {
    const assets = Array.isArray(rel.assets) ? rel.assets.filter((a) => /\.zip$/i.test(a.name || '') && a.browser_download_url) : [];
    const pick = assets.find((a) => /plugin/i.test(a.name)) || assets.find((a) => a.name.toLowerCase().includes(repo.toLowerCase())) || assets[0];
    return { zipUrl: pick ? pick.browser_download_url : zipOf('refs/tags/' + rel.tag_name), tag: rel.tag_name, version: tagVersion(rel.tag_name), ref: '' };
  }
  const info = await apiJson(`/repos/${owner}/${repo}`);
  if (!info) throw new PluginError(404, `GitHub 上找不到 ${owner}/${repo}（私有仓库也装不了）`);
  return { zipUrl: zipOf('refs/heads/' + (info.default_branch || 'main')), tag: '', version: '', ref: info.default_branch || 'main' };
}

export async function downloadZip(url) {
  const res = await gfetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok) throw new PluginError(502, '下载失败：HTTP ' + res.status);
  const len = Number(res.headers.get('content-length') || 0);
  if (len > MAX_ZIP) throw new PluginError(413, '插件包太大（上限 50MB）');
  const chunks = [];
  let size = 0;
  for await (const c of res.body) {
    size += c.length;
    if (size > MAX_ZIP) throw new PluginError(413, '插件包太大（上限 50MB）');
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

export async function installFromGithub(kernel, input) {
  const r = parseRepo(input);
  const pkg = await resolvePackage(r);
  const buf = await downloadZip(pkg.zipUrl);
  const p = await installFromArchive(kernel, buf);
  kernel.writeState((s) => {
    s.sources = s.sources && typeof s.sources === 'object' ? s.sources : {};
    s.sources[p.id] = { github: r.owner + '/' + r.repo, ref: r.ref || '', tag: pkg.tag || '', at: Date.now() };
  });
  return p;
}

export function sourceOf(kernel, id) {
  const s = kernel.readState().sources;
  return s && typeof s === 'object' && s[id] ? s[id] : null;
}

// 检查更新：只对从 GitHub 装、没钉 ref 的插件有意义。返回 { current, latest, tag, newer }。
export async function checkUpdate(kernel, id) {
  const p = kernel.get(id);
  const src = sourceOf(kernel, id);
  if (!p || !src) throw new PluginError(400, '这个插件不是从 GitHub 装的');
  const [owner, repo] = src.github.split('/');
  if (src.ref) return { current: p.version, latest: null, tag: '', newer: false, pinned: src.ref };
  const pkg = await resolvePackage({ owner, repo, ref: '' });
  const newer = !!pkg.version && (compareVersions(pkg.version, p.version) > 0 || (Number.isNaN(compareVersions(pkg.version, p.version)) && pkg.tag !== src.tag));
  return { current: p.version, latest: pkg.version || null, tag: pkg.tag, newer };
}
