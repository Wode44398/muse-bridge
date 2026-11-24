// 一键发布到社区：本地预检（与 CI 同一份规则）→ 用作者自己的 GitHub 账号把插件目录提交成拉取请求。
// 市场仓库的 CI 自动检查、通过即合并上架（没有人工审核）；这里只负责把东西交上去，并能查投稿走到哪一步。
//
// 提交方式（Git Data API，不需要本机有 git）：
//   作者 ≠ 仓库主人：fork（已有就复用）→ 同步 fork 的 main → 在 fork 里建 blob / tree / commit → 强推分支 community/<id> → 没有开着的拉取请求就新开；
//   作者 = 仓库主人：直接在上游建分支。
// 目录里多出来的旧文件（上一版有、这一版没有）在 tree 里删掉，保证仓库里就是这次提交的样子。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { PluginError } from '../../discover.mjs';
import { COMMUNITY_REPO } from '../../market-keys.mjs';
import { checkSubmission, CAP_LABELS } from '../community-rules.mjs';
import { official, community } from '../channels.mjs';
import { reservedIds } from '../reserved.mjs';
import { api, GithubError } from './github.mjs';
import { publisherToken, PUBLISHER_DIR } from './account.mjs';
import { collectFiles, readLocalMarket, composeMarket, marketFile } from './collect.mjs';

const SUBMISSIONS = path.join(PUBLISHER_DIR, 'submissions.json');
const MARKER = '<!-- community-intake -->';
const BINARY = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'woff', 'woff2', 'ttf', 'otf']);
const extOf = (p) => { const i = p.lastIndexOf('.'); return i > 0 ? p.slice(i + 1).toLowerCase() : ''; };
const ghErr = (e) => (e instanceof GithubError ? new PluginError(e.status === 401 ? 401 : e.status === 404 ? 404 : 502, e.message) : e);

function readSubs() { try { const v = JSON.parse(readFileSync(SUBMISSIONS, 'utf8')); return v && typeof v === 'object' ? v : {}; } catch { return {}; } }
function writeSub(id, rec) {
  const all = readSubs();
  if (rec) all[id] = rec; else delete all[id];
  mkdirSync(PUBLISHER_DIR, { recursive: true });
  writeFileSync(SUBMISSIONS, JSON.stringify(all, null, 2));
}
export const submissionOf = (id) => readSubs()[id] || null;

async function upstreamJson(token, file) {
  try {
    const r = await api(token, 'GET', `/repos/${COMMUNITY_REPO}/contents/${file}?ref=main`);
    if (!r || typeof r.content !== 'string') return null;
    return JSON.parse(Buffer.from(r.content, 'base64').toString('utf8'));
  } catch (e) {
    if (e instanceof GithubError && e.status === 404) return null;
    throw e;
  }
}

function pluginDir(kernel, id) {
  const p = kernel.get(id);
  if (!p) throw new PluginError(404, '没有插件「' + id + '」');
  if (p.source !== 'installed' && p.source !== 'local') throw new PluginError(409, '只有自己装的或本机开发目录里的插件能发布到社区');
  const src = kernel.readState().sources?.[id];
  if (src?.market === 'official') throw new PluginError(409, '这是官方市场的插件，不用再发布');
  // 社区里装来的那份归属是原作者的；作者发新版请从自己的开发目录或自己上传的包发
  if (src?.market === 'community') throw new PluginError(409, '这是从社区市场装来的插件：发新版请用你自己的开发目录');
  if (!p.dir || !existsSync(p.dir)) throw new PluginError(404, '找不到插件目录');
  return p;
}

/**
 * 本地预检。返回 { report, files, market, login, upstream }：
 *   report = { ok, errors, warnings, kind, caps, capLabels, permissions, version }
 * 没登录也能跑（归属与版本号等提交后由 CI 判断，报告里有一条提示）。
 */
export async function precheck(kernel, id, { notes = '', nameEn = '', descriptionEn = '' } = {}) {
  const p = pluginDir(kernel, id);
  let acct = null;
  try { acct = await publisherToken(); } catch {}
  const files = collectFiles(p.dir);
  const warnings = [];
  let ledger = {}, moderation = {}, upMarket = null, upstream = false;
  if (acct) {
    try {
      [ledger, moderation, upMarket] = await Promise.all([
        upstreamJson(acct.token, 'community-ledger.json'), upstreamJson(acct.token, 'community-moderation.json'), upstreamJson(acct.token, `community/${id}/market.json`),
      ]);
      ledger = ledger || {}; moderation = moderation || {};
      upstream = true;
    } catch (e) { warnings.push({ code: 'no-ledger', message: '没拿到市场仓库的台账（' + String(e?.message || e).slice(0, 80) + '）：插件名归属与版本号要等提交后由自动检查判断' }); }
  } else warnings.push({ code: 'no-login', message: '还没登录 GitHub：插件名归属与版本号要等提交后由自动检查判断' });
  const manifestVersion = (() => { try { return JSON.parse(readFileSync(path.join(p.dir, 'bridge-plugin.json'), 'utf8').replace(/^﻿/, '')).version || ''; } catch { return ''; } })();
  const market = composeMarket({ upstream: upMarket, local: readLocalMarket(p.dir), version: manifestVersion, notes, nameEn, descriptionEn });
  const officialIds = (official.cached()?.index.plugins || []).map((e) => e.id);
  const r = checkSubmission({
    id, files: [...files, marketFile(market)], author: acct?.login || '-', ledger, moderation, reserved: reservedIds(), official: officialIds,
  });
  const errors = acct ? r.errors : r.errors.filter((e) => e.code !== 'author');
  const report = {
    ok: errors.length === 0, errors, warnings: [...warnings, ...r.warnings], kind: r.kind, caps: r.caps,
    capLabels: r.caps.map((c) => CAP_LABELS[c] || c), capsAt: r.capsAt, permissions: r.permissions, version: r.version,
  };
  return { report, files, market, login: acct?.login || '', upstream, acct, name: typeof r.manifest?.name === 'string' ? r.manifest.name : '' };
}

async function waitForRepo(token, full) {
  for (let i = 0; i < 20; i++) {
    try { await api(token, 'GET', `/repos/${full}/git/ref/heads/main`); return; }
    catch (e) { if (!(e instanceof GithubError) || (e.status !== 404 && e.status !== 409)) throw e; }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new PluginError(504, 'GitHub 上的 fork 一直没准备好，过一会儿再试');
}

// 上游 community/<id>/ 下现有的文件（删掉这一版不再有的）
async function existingPaths(token, treeSha, id) {
  const root = await api(token, 'GET', `/repos/${COMMUNITY_REPO}/git/trees/${treeSha}`);
  const c = (root?.tree || []).find((x) => x.path === 'community' && x.type === 'tree');
  if (!c) return [];
  const sub = await api(token, 'GET', `/repos/${COMMUNITY_REPO}/git/trees/${c.sha}`);
  const d = (sub?.tree || []).find((x) => x.path === id && x.type === 'tree');
  if (!d) return [];
  const all = await api(token, 'GET', `/repos/${COMMUNITY_REPO}/git/trees/${d.sha}?recursive=1`);
  return (all?.tree || []).filter((x) => x.type === 'blob').map((x) => x.path);
}

function prBody({ name, id, version, kind, capLabels, notes, login }) {
  return [
    `社区插件投稿：**${name}**（\`${id}\`）v${version}`,
    '',
    `- 种类：${kind === 'server' ? '含服务端代码' : '纯页面'}`,
    `- 检测到的能力：${capLabels.length ? capLabels.join('、') : '无'}`,
    `- 投稿人：@${login}`,
    '',
    '更新说明：',
    '',
    String(notes || '').trim() || '（见 market.json）',
    '',
    '由 bridge「发布到社区」提交；市场仓库的自动检查通过后自动合并上架（没有人工审核）。',
  ].join('\n');
}

export async function publishToCommunity(kernel, id, { notes = '', nameEn = '', descriptionEn = '' } = {}) {
  const pre = await precheck(kernel, id, { notes, nameEn, descriptionEn });
  if (!pre.acct) throw new PluginError(401, '还没登录 GitHub：发布到社区要用你自己的 GitHub 账号');
  if (!pre.report.ok) { const e = new PluginError(400, '预检没通过：' + pre.report.errors.map((x) => x.message).slice(0, 3).join('；')); e.report = pre.report; throw e; }
  const { token, login } = pre.acct;
  const version = pre.report.version;
  const [upOwner] = COMMUNITY_REPO.split('/');
  try {
    // 1. 往哪个仓库推分支
    let headRepo = COMMUNITY_REPO;
    let headOwner = upOwner;
    if (login.toLowerCase() !== upOwner.toLowerCase()) {
      const f = await api(token, 'POST', `/repos/${COMMUNITY_REPO}/forks`, { default_branch_only: true });
      headRepo = String(f?.full_name || `${login}/${COMMUNITY_REPO.split('/')[1]}`);
      headOwner = String(f?.owner?.login || login);
      await waitForRepo(token, headRepo);
      // fork 的 main 落后时跟上游对齐；失败不要紧（fork 网络共享对象，下面直接以上游提交为父）
      try { await api(token, 'POST', `/repos/${headRepo}/merge-upstream`, { branch: 'main' }); } catch {}
    }
    // 2. 以上游 main 为底建这一版的 tree
    const ref = await api(token, 'GET', `/repos/${COMMUNITY_REPO}/git/ref/heads/main`);
    const parent = ref.object.sha;
    const commit0 = await api(token, 'GET', `/repos/${COMMUNITY_REPO}/git/commits/${parent}`);
    const baseTree = commit0.tree.sha;
    const before = await existingPaths(token, baseTree, id);
    const files = [...pre.files, marketFile(pre.market)];
    const entries = [];
    for (const f of files) {
      const p = `community/${id}/${f.path}`;
      if (BINARY.has(extOf(f.path))) {
        const b = await api(token, 'POST', `/repos/${headRepo}/git/blobs`, { content: f.data.toString('base64'), encoding: 'base64' });
        entries.push({ path: p, mode: '100644', type: 'blob', sha: b.sha });
      } else entries.push({ path: p, mode: '100644', type: 'blob', content: f.data.toString('utf8') });
    }
    const now = new Set(files.map((f) => f.path));
    for (const old of before) if (!now.has(old)) entries.push({ path: `community/${id}/${old}`, mode: '100644', type: 'blob', sha: null });
    const tree = await api(token, 'POST', `/repos/${headRepo}/git/trees`, { base_tree: baseTree, tree: entries });
    const name = pre.name || id;
    const commit = await api(token, 'POST', `/repos/${headRepo}/git/commits`, { message: `社区插件：${id} v${version}`, tree: tree.sha, parents: [parent] });
    // 3. 分支：有就强推，没有就建
    const branch = `community/${id}`;
    try { await api(token, 'PATCH', `/repos/${headRepo}/git/refs/heads/${branch}`, { sha: commit.sha, force: true }); }
    catch (e) {
      if (!(e instanceof GithubError) || (e.status !== 404 && e.status !== 422)) throw e;
      await api(token, 'POST', `/repos/${headRepo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
    }
    // 4. 拉取请求：已有开着的就沿用（分支更新后它自动带上新提交）
    const open = await api(token, 'GET', `/repos/${COMMUNITY_REPO}/pulls?state=open&head=${encodeURIComponent(headOwner + ':' + branch)}`);
    let pr = Array.isArray(open) && open[0];
    const title = `社区插件：${name}（${id}）v${version}`;
    const body = prBody({ name, id, version, kind: pre.report.kind, capLabels: pre.report.capLabels, notes: pre.market.notes?.[version], login });
    if (pr) {
      try { await api(token, 'PATCH', `/repos/${COMMUNITY_REPO}/pulls/${pr.number}`, { title, body }); } catch {}
    } else {
      pr = await api(token, 'POST', `/repos/${COMMUNITY_REPO}/pulls`, { title, head: `${headOwner}:${branch}`, base: 'main', body, maintainer_can_modify: true });
    }
    const rec = { pr: pr.html_url, number: pr.number, version, commit: commit.sha, login, at: Date.now() };
    writeSub(id, rec);
    return { ...rec, report: pre.report };
  } catch (e) { throw ghErr(e); }
}

// 投稿走到哪了：checking 检查中 / failed 没通过（带报告）/ merged 已合并等上架 / live 已上架 / closed 被关掉
// 每次要问 GitHub 两个接口：同一个插件 30 秒内重复问直接用上次的结果（详情页、发布面板都会问；没登录走匿名接口限流很紧）
const statusCache = new Map();   // id → { at, value }
export function _resetStatusCache() { statusCache.clear(); }
export async function submissionStatus(id) {
  const rec = submissionOf(id);
  if (!rec) return { id, status: 'none' };
  const c = statusCache.get(id);
  if (c && c.value.at === rec.at && Date.now() - c.at < 30_000) return c.value;
  const value = await freshStatus(id, rec);
  statusCache.set(id, { at: Date.now(), value });
  return value;
}

async function freshStatus(id, rec) {
  let token = '';
  try { token = (await publisherToken()).token; } catch {}
  try {
    const pr = await api(token, 'GET', `/repos/${COMMUNITY_REPO}/pulls/${rec.number}`);
    const comments = await api(token, 'GET', `/repos/${COMMUNITY_REPO}/issues/${rec.number}/comments?per_page=100`);
    const bot = (Array.isArray(comments) ? comments : []).filter((c) => String(c?.body || '').includes(MARKER)).pop();
    const report = bot ? String(bot.body).replace(MARKER, '').trim().slice(0, 6000) : '';
    let status;
    if (pr.merged || pr.merged_at) {
      const has = () => !!community.cached()?.index.plugins.find((e) => e.id === id)?.versions.some((v) => v.version === rec.version);
      // 合并后几分钟才上架：缓存里还没有就重拉一次索引（最多一分钟一次），不然要等 6 小时的定时检查
      if (!has()) { try { await community.getIndex({ maxAgeMs: 60_000 }); } catch {} }
      status = has() ? 'live' : 'merged';
    } else if (pr.state === 'closed') status = 'closed';
    else if (bot && /❌/.test(report.split('\n')[0] || '') && new Date(bot.updated_at || bot.created_at || 0).getTime() >= rec.at - 60_000) status = 'failed';
    else status = 'checking';
    return { id, status, pr: rec.pr, number: rec.number, version: rec.version, at: rec.at, report };
  } catch (e) {
    return { id, status: 'unknown', pr: rec.pr, number: rec.number, version: rec.version, at: rec.at, error: String(ghErr(e)?.message || e) };
  }
}
