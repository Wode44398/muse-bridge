// 扩展市场（设置 → 扩展 →「发现」）：官方 Claude 桌面 App「自定义 → 发现」同款的浏览与一键添加。
//
// 数据源：官方 App 的 Anthropic Directory 走 claude.ai 登录态接口（/api/organizations/{org}/directory/…），
// 服务端拿不到；这里用它背后同源、公开托管在 GitHub 的三个 Anthropic 官方市场当默认源——
//   anthropics/claude-plugins-official  Claude Code 默认插件市场（/plugin 里那个）
//   anthropics/knowledge-work-plugins   Cowork 的官方插件（Productivity / Sales / Finance …，「发现」头图就出自这里）
//   anthropics/skills                   Anthropic Agent Skills（docx / pdf / pptx / xlsx / skill-creator …）
// 另可加任意 GitHub 上的 Claude Code 市场仓库（owner/repo，根下有 .claude-plugin/marketplace.json）。
//
// 索引：每个市场 = marketplace.json + 仓库树（GitHub API 一次 recursive 调用）+ 每个技能 SKILL.md 的 frontmatter
// + 每个 .mcp.json。整份落 extensions/market-cache.json，12 小时过期后台重建（未鉴权 API 60 次/小时，够用）。
// 三类卡片：
//   技能   仓库内（本地源）插件里的每个 SKILL.md；外部 git 源的插件不展开（要整仓下载才知道里面有什么）
//   连接器 仓库内插件的 .mcp.json 与 marketplace 条目内联的 mcpServers，按 url / 命令去重
//   插件   marketplace.json 的全部条目
// 安装：技能按仓库树逐个文件从 raw.githubusercontent 拉；插件本地源同理，外部源走 codeload tarball
// （GitHub）或 git clone --depth 1（其它 git 主机）；连接器直接落连接器表单。
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, statSync } from 'node:fs';
import {
  EXT_ROOT, stagingDir, installSkillFromDir as installSkillFromDirAdmin, installPluginFromDir, saveConnector, parseFrontmatter, listExtensions,
} from './extensions.mjs';
import { writeJson } from './jsonfile.mjs';

const execFileAsync = promisify(execFile);
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });
const CACHE_FILE = path.join(EXT_ROOT, 'market-cache.json');
const TREES_FILE = path.join(EXT_ROOT, 'market-trees.json');
const SOURCES_FILE = path.join(EXT_ROOT, 'market-sources.json');
const TTL = 12 * 3600_000;
const REPO_RE = /^[A-Za-z0-9_.-]{1,80}\/[A-Za-z0-9_.-]{1,100}$/;

export const DEFAULT_MARKETS = [
  { repo: 'anthropics/claude-plugins-official', label: 'Anthropic 官方目录' },
  { repo: 'anthropics/knowledge-work-plugins', label: 'Anthropic 知识工作' },
  { repo: 'anthropics/skills', label: 'Anthropic Agent Skills' },
];

const readJson = (f, dflt) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return dflt; } };

// —— 市场源（内置三家 + 自己加的）——
function customSources() {
  const arr = readJson(SOURCES_FILE, []);
  return (Array.isArray(arr) ? arr : []).filter((x) => x && REPO_RE.test(x.repo));
}
export function marketSources() {
  return [...DEFAULT_MARKETS.map((m) => ({ ...m, builtin: true })), ...customSources().map((m) => ({ repo: m.repo, ref: m.ref, label: m.repo }))];
}
export function editSources({ action, repo, ref } = {}) {
  repo = String(repo || '').trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$/i, '').replace(/\/+$/, '');
  if (!REPO_RE.test(repo)) throw httpErr(400, '请填 GitHub 仓库：owner/repo');
  const list = customSources();
  if (action === 'remove') {
    writeJson(SOURCES_FILE, list.filter((x) => x.repo.toLowerCase() !== repo.toLowerCase()), 2);
  } else {
    if (DEFAULT_MARKETS.some((m) => m.repo.toLowerCase() === repo.toLowerCase()) || list.some((x) => x.repo.toLowerCase() === repo.toLowerCase())) throw httpErr(409, '这个市场已经在列表里了');
    if (list.length >= 12) throw httpErr(400, '自定义市场最多 12 个');
    list.push({ repo, ...(ref ? { ref: String(ref).slice(0, 80) } : {}) });
    writeJson(SOURCES_FILE, list, 2);
  }
  // 源变了：缓存作废，下次打开「发现」重建
  try { rmSync(CACHE_FILE, { force: true }); } catch {}
  return marketSources();
}

// —— 抓取 ——
const UA = { 'User-Agent': 'claude-bridge-market', Accept: 'application/vnd.github+json' };
async function getText(url, { timeout = 30_000 } = {}) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw httpErr(r.status === 404 ? 404 : 502, `${r.status} ${url.replace(/^https:\/\//, '')}`);
  return r.text();
}
const getJson = async (url, opts) => JSON.parse(await getText(url, opts));
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');
const rawUrl = (repo, ref, p) => `https://raw.githubusercontent.com/${repo}/${encodeURIComponent(ref)}/${encPath(p)}`;

// 有限并发跑一批 async 任务
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = { __err: e }; } }
  }));
  return out;
}

const clip = (s, n) => { s = String(s ?? '').replace(/\p{Cc}/gu, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const normRel = (p) => String(p || '').replace(/^\.\//, '').replace(/\/+$/, '');
const authorOf = (e) => (typeof e.author === 'string' ? e.author : e.author?.name) || '';

// marketplace 条目的来源 → 统一形状
function sourceOf(e) {
  const s = e.source;
  if (typeof s === 'string') return { kind: 'local', path: normRel(s) };
  if (!s || typeof s !== 'object') return { kind: 'unknown' };
  if (s.source === 'github' && s.repo) return { kind: 'git', url: `https://github.com/${s.repo}.git`, ref: s.ref, sha: s.sha, path: '' };
  if (s.source === 'url' && s.url) return { kind: 'git', url: s.url, ref: s.ref, sha: s.sha, path: '' };
  if (s.source === 'git-subdir' && s.url) return { kind: 'git', url: s.url, ref: s.ref, sha: s.sha, path: normRel(s.path) };
  return { kind: 'unknown' };
}

// .mcp.json（两种写法：{ mcpServers: {...} } 或直接 { name: {...} }）→ 连接器草稿
function mcpServersOf(obj) {
  const m = obj && typeof obj === 'object' ? (obj.mcpServers && typeof obj.mcpServers === 'object' ? obj.mcpServers : obj) : {};
  const out = [];
  for (const [name, c] of Object.entries(m)) {
    if (!c || typeof c !== 'object') continue;
    const transport = c.command ? 'stdio' : (c.type === 'sse' ? 'sse' : (c.url ? 'http' : null));
    if (!transport) continue;
    out.push({
      server: name, transport,
      ...(transport === 'stdio'
        ? { command: String(c.command), args: Array.isArray(c.args) ? c.args.map(String) : [], env: c.env && typeof c.env === 'object' ? c.env : {} }
        : { url: String(c.url), headers: c.headers && typeof c.headers === 'object' ? c.headers : {} }),
    });
  }
  return out;
}
const hostOf = (u) => { try { return new URL(u).host; } catch { return ''; } };

async function buildMarket(src) {
  const repo = src.repo;
  const t0 = Date.now();
  // 默认分支：自定义源没给 ref 就问一次仓库信息
  let ref = src.ref || (DEFAULT_MARKETS.some((m) => m.repo === repo) ? 'main' : null);
  if (!ref) ref = (await getJson(`https://api.github.com/repos/${repo}`)).default_branch || 'main';
  const mk = await getJson(rawUrl(repo, ref, '.claude-plugin/marketplace.json'));
  if (!Array.isArray(mk.plugins)) throw httpErr(502, 'marketplace.json 里没有 plugins 列表');
  let tree = [];
  try {
    const t = await getJson(`https://api.github.com/repos/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
    tree = (t.tree || []).filter((x) => x.type === 'blob').map((x) => [x.path, x.size || 0]);
  } catch (e) {
    // 树拿不到（多半是 API 限流）：插件照样列，技能 / 连接器这一家先空着
    console.warn('[ext-market] 仓库树拿不到：', repo, String(e?.message || e));
  }
  const paths = tree.map((x) => x[0]);
  const market = { repo, ref, label: src.label || mk.name || repo, owner: mk.owner?.name || '', description: clip(mk.description || mk.metadata?.description, 200) };

  const plugins = [], skillJobs = [], mcpJobs = [], inlineConns = [];
  const seenSkill = new Set();
  for (const e of mk.plugins) {
    if (!e || !e.name) continue;
    const so = sourceOf(e);
    const name = String(e.name);
    const p = {
      key: `${repo}::${name}`, market: repo, name, title: clip(e.displayName || name, 80),
      description: clip(e.description, 420), category: e.category || '', author: clip(authorOf(e), 60),
      homepage: typeof e.homepage === 'string' ? e.homepage : '', srcKind: so.kind, nSkills: 0, nConns: 0,
    };
    plugins.push(p);
    if (so.kind !== 'local') continue;
    const base = so.path;
    const under = (q) => (base ? q.startsWith(base + '/') : true);
    // 技能：条目显式列了 skills（strict:false）就用它；否则扫插件目录下所有 SKILL.md
    let sk = [];
    if (Array.isArray(e.skills) && e.skills.length) sk = e.skills.map((x) => path.posix.join(base, normRel(x), 'SKILL.md'));
    else sk = paths.filter((q) => under(q) && /(^|\/)SKILL\.md$/.test(q));
    for (const q of sk) {
      if (!paths.includes(q) || seenSkill.has(q)) continue;
      seenSkill.add(q);
      skillJobs.push({ plugin: p, skillMd: q });
    }
    const mcp = paths.filter((q) => under(q) && /(^|\/)\.mcp\.json$/.test(q) && q.split('/').length - (base ? base.split('/').length : 0) <= 2);
    for (const q of mcp) mcpJobs.push({ plugin: p, file: q });
    if (e.mcpServers && typeof e.mcpServers === 'object') for (const c of mcpServersOf({ mcpServers: e.mcpServers })) inlineConns.push({ plugin: p, c });
  }

  // SKILL.md frontmatter（并发 16）
  const skills = (await pool(skillJobs, 16, async (j) => {
    const fm = parseFrontmatter(await getText(rawUrl(repo, ref, j.skillMd), { timeout: 20_000 })) || {};
    const dir = path.posix.dirname(j.skillMd);
    const nm = fm.name || path.posix.basename(dir);
    j.plugin.nSkills++;
    return {
      key: `${repo}::${dir}`, market: repo, path: dir, name: clip(nm, 80), description: clip(fm.description, 420),
      plugin: j.plugin.name, pluginTitle: j.plugin.title, category: j.plugin.category,
    };
  })).filter((x) => x && !x.__err && x.description);

  // .mcp.json → 连接器（按 url / 命令去重）
  const connRaw = [...inlineConns];
  const mcpRes = await pool(mcpJobs, 12, async (j) => mcpServersOf(JSON.parse(await getText(rawUrl(repo, ref, j.file), { timeout: 20_000 }))).map((c) => ({ plugin: j.plugin, c })));
  for (const r of mcpRes) if (Array.isArray(r)) connRaw.push(...r);
  const connectors = [];
  const seenConn = new Map();
  for (const { plugin, c } of connRaw) {
    const sig = c.transport === 'stdio' ? `${c.command} ${(c.args || []).join(' ')}` : c.url;
    if (seenConn.has(sig)) { const o = seenConn.get(sig); if (!o.plugins.includes(plugin.title)) o.plugins.push(plugin.title); continue; }
    plugin.nConns++;
    const o = {
      key: `${repo}::${plugin.name}::${c.server}`, market: repo, plugin: plugin.name, pluginTitle: plugin.title, plugins: [plugin.title],
      name: c.server, transport: c.transport, host: c.transport === 'stdio' ? c.command : hostOf(c.url),
      description: '', category: plugin.category, spec: c,
    };
    seenConn.set(sig, o);
    connectors.push(o);
  }
  // 单连接器的插件：连接器描述直接借插件描述（官方 Directory 里连接器卡片的那句话就是这个意思）
  for (const o of connectors) {
    const pl = plugins.find((p) => p.name === o.plugin);
    o.description = pl && pl.nConns === 1 ? pl.description : '';
  }
  return { market, plugins, skills, connectors, tree: { ref, files: tree }, ms: Date.now() - t0 };
}

// —— 索引缓存 ——
let building = null;
let lastError = '';
export function marketIndex({ refresh = false } = {}) {
  const cache = existsSync(CACHE_FILE) ? readJson(CACHE_FILE, null) : null;
  const stale = !cache || refresh || Date.now() - (cache.builtAt || 0) > TTL;
  if (stale && !building) {
    building = rebuild().catch((e) => { lastError = String(e?.message || e); console.error('[ext-market] 索引重建失败：', lastError); })
      .finally(() => { building = null; });
  }
  return { building: !!building, error: lastError, sources: marketSources(), ...(cache || { markets: [], plugins: [], skills: [], connectors: [] }) };
}

async function rebuild() {
  const srcs = marketSources();
  const res = await pool(srcs, 3, (s) => buildMarket(s));
  const out = { builtAt: Date.now(), markets: [], plugins: [], skills: [], connectors: [] };
  const trees = {};
  res.forEach((r, i) => {
    const s = srcs[i];
    if (!r || r.__err) {
      out.markets.push({ repo: s.repo, label: s.label, ok: false, error: String(r?.__err?.message || r?.__err || '失败').slice(0, 200) });
      return;
    }
    out.markets.push({ ...r.market, ok: true, counts: { plugins: r.plugins.length, skills: r.skills.length, connectors: r.connectors.length } });
    out.plugins.push(...r.plugins); out.skills.push(...r.skills); out.connectors.push(...r.connectors);
    trees[s.repo] = r.tree;
  });
  // 一家都没拿到就别覆盖旧缓存（断网时保住上一次的）
  if (!out.markets.some((m) => m.ok)) throw new Error(out.markets.map((m) => `${m.repo}: ${m.error}`).join('；'));
  mkdirSync(EXT_ROOT, { recursive: true });
  // 旧树里有、这次失败的市场保留旧树（安装还能用）
  const oldTrees = readJson(TREES_FILE, {});
  for (const m of out.markets) if (!m.ok && oldTrees[m.repo]) trees[m.repo] = oldTrees[m.repo];
  writeJson(TREES_FILE, trees);
  writeJson(CACHE_FILE, out);
  lastError = '';
  console.log(`[ext-market] 索引已重建：${out.plugins.length} 插件 / ${out.skills.length} 技能 / ${out.connectors.length} 连接器`);
}

// —— 安装 ——
const MAX_FILES = 600, MAX_BYTES = 40 * 1024 * 1024;
function findEntry(kind, key) {
  const cache = readJson(CACHE_FILE, null);
  if (!cache) throw httpErr(409, '市场索引还没建好，稍后再试');
  const list = kind === 'skill' ? cache.skills : kind === 'connector' ? cache.connectors : cache.plugins;
  const hit = (list || []).find((x) => x.key === key);
  if (!hit) throw httpErr(404, '市场里找不到这一项（索引可能已更新，刷新一下）');
  return hit;
}
function treeOf(repo) {
  const t = readJson(TREES_FILE, {})[repo];
  if (!t || !Array.isArray(t.files) || !t.files.length) throw httpErr(502, '这个市场的仓库文件列表没拿到（GitHub 限流？），稍后刷新再试');
  return t;
}
// 仓库里某个目录整个拉到 dest（逐文件 raw 下载）
async function fetchSubtree(repo, dir, dest) {
  const t = treeOf(repo);
  const pre = dir ? dir + '/' : '';
  const files = t.files.filter(([p]) => p.startsWith(pre));
  if (!files.length) throw httpErr(404, `仓库里没有 ${dir || '根目录'}`);
  if (files.length > MAX_FILES) throw httpErr(413, `文件太多（${files.length} 个），不像是一个技能 / 插件`);
  const total = files.reduce((s, [, n]) => s + n, 0);
  if (total > MAX_BYTES) throw httpErr(413, '体积超过 40MB 上限');
  const res = await pool(files, 12, async ([p]) => {
    const r = await fetch(rawUrl(repo, t.ref, p), { headers: UA, signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`${r.status} ${p}`);
    const out = path.join(dest, ...p.slice(pre.length).split('/'));
    if (!path.resolve(out).startsWith(path.resolve(dest) + path.sep)) throw new Error('路径越界：' + p);
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  });
  const bad = res.find((x) => x && x.__err);
  if (bad) throw httpErr(502, '下载失败：' + String(bad.__err?.message || bad.__err).slice(0, 160));
}

const BSDTAR = () => ['C:\\Windows\\System32\\tar.exe', '/usr/bin/bsdtar', '/usr/bin/tar'].find((p) => { try { return statSync(p).isFile(); } catch { return false; } }) || 'tar';
// 外部 git 源：GitHub 走 codeload tarball，其它主机 git clone --depth 1；返回仓库根目录
async function fetchGitSource(so, work) {
  mkdirSync(work, { recursive: true });
  const gh = /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(so.url || '');
  if (gh) {
    const ref = so.sha || so.ref || 'HEAD';
    const r = await fetch(`https://codeload.github.com/${gh[1]}/${gh[2]}/tar.gz/${encodeURIComponent(ref)}`, { headers: UA, signal: AbortSignal.timeout(120_000) });
    if (!r.ok) throw httpErr(502, `下载仓库失败（${r.status}）`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 120 * 1024 * 1024) throw httpErr(413, '仓库太大');
    const tgz = path.join(work, 'src.tgz');
    writeFileSync(tgz, buf);
    const out = path.join(work, 'x');
    mkdirSync(out);
    await execFileAsync(BSDTAR(), ['-xzf', tgz, '-C', out], { windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
    const top = readdirSync(out, { withFileTypes: true }).find((d) => d.isDirectory());
    if (!top) throw httpErr(502, '仓库压缩包是空的');
    return path.join(out, top.name);
  }
  if (!/^https:\/\//i.test(so.url || '')) throw httpErr(400, '不支持的插件来源');
  const out = path.join(work, 'git');
  const args = ['clone', '--depth', '1', ...(so.ref ? ['--branch', so.ref] : []), '--', so.url, out];
  try { await execFileAsync('git', args, { windowsHide: true, timeout: 180_000, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }); }
  catch (e) { throw httpErr(502, 'git clone 失败：' + String(e.stderr || e.message).slice(0, 200)); }
  rmSync(path.join(out, '.git'), { recursive: true, force: true });
  return out;
}

// scope：装进哪个范围（admin 自用 / shared 全服），原样交给 extensions.mjs
// hooks.installSkillFromDir：成员装进他自己的注册表时换掉（member-skills.mjs），scope 那时不起作用
export async function marketInstall({ kind, key, scope } = {}, hooks = {}) {
  key = String(key || '');
  const installSkillFromDir = hooks.installSkillFromDir || installSkillFromDirAdmin;
  if (kind === 'connector') {
    const c = findEntry('connector', key);
    const s = c.spec || {};
    const item = saveConnector({
      name: c.name, description: c.description || `${c.pluginTitle} · ${c.host}`,
      transport: s.transport, command: s.command, args: s.args, env: s.env, url: s.url, headers: s.headers,
      pkg: c.pluginTitle, source: { market: c.market, plugin: c.plugin, server: c.name }, scope,
    });
    return { items: [item] };
  }
  if (kind === 'skill') {
    const sk = findEntry('skill', key);
    const st = stagingDir();
    try {
      await fetchSubtree(sk.market, sk.path, st);
      return { items: [installSkillFromDir(st, { pkg: sk.pluginTitle, source: { market: sk.market, plugin: sk.plugin, path: sk.path }, scope })] };
    } finally { rmSync(st, { recursive: true, force: true }); }
  }
  if (kind === 'skillpack') {
    // 头图「添加」：把一个插件里的全部技能作为一个包装上（技能三家 agent 都能用，插件只有 Claude）
    const p = findEntry('plugin', key);
    const cache = readJson(CACHE_FILE, {});
    const members = (cache.skills || []).filter((s) => s.market === p.market && s.plugin === p.name);
    if (!members.length) throw httpErr(404, '这个插件里没有可单独安装的技能');
    const items = [], skipped = [];
    for (const sk of members) {
      const st = stagingDir();
      try {
        await fetchSubtree(sk.market, sk.path, st);
        items.push(installSkillFromDir(st, { pkg: p.title, source: { market: sk.market, plugin: sk.plugin, path: sk.path }, scope }));
      } catch (e) { skipped.push(`${sk.name}：${String(e?.message || e).slice(0, 80)}`); }
      finally { rmSync(st, { recursive: true, force: true }); }
    }
    if (!items.length) throw httpErr(409, skipped[0] || '一个都没装上');
    return { items, skipped };
  }
  if (kind === 'plugin') {
    const p = findEntry('plugin', key);
    const cache = readJson(CACHE_FILE, {});
    const mkt = (cache.markets || []).find((m) => m.repo === p.market);
    const mk = JSON.parse(await getText(rawUrl(p.market, mkt?.ref || 'main', '.claude-plugin/marketplace.json')));
    const e = (mk.plugins || []).find((x) => x && x.name === p.name);
    if (!e) throw httpErr(404, '市场清单里已经没有这个插件了');
    const so = sourceOf(e);
    const work = stagingDir();
    try {
      let dir;
      if (so.kind === 'local') {
        dir = path.join(work, 'p');
        if (Array.isArray(e.skills) && e.skills.length) {
          // strict:false 的技能合集：只装列出来的那几个技能
          for (const s of e.skills) await fetchSubtree(p.market, path.posix.join(so.path, normRel(s)), path.join(dir, 'skills', path.posix.basename(normRel(s))));
        } else await fetchSubtree(p.market, so.path, dir);
      } else if (so.kind === 'git') {
        const root = await fetchGitSource(so, work);
        dir = so.path ? path.join(root, ...so.path.split('/')) : root;
        if (!path.resolve(dir).startsWith(path.resolve(root)) || !existsSync(dir)) throw httpErr(404, '仓库里没有插件所在的子目录');
      } else throw httpErr(400, '不支持的插件来源');
      // 没有 plugin.json 时按市场条目补一份（strict:false 的写法）
      const manifest = { name: e.name, description: e.description || '', ...(e.version ? { version: e.version } : {}), ...(e.author ? { author: e.author } : {}) };
      for (const k of ['commands', 'agents', 'hooks', 'mcpServers', 'lspServers']) if (e[k]) manifest[k] = e[k];
      return { items: [installPluginFromDir(dir, { pkg: '', source: { market: p.market, plugin: p.name }, manifest, scope })] };
    } finally { rmSync(work, { recursive: true, force: true }); }
  }
  throw httpErr(400, '未知的安装类型');
}

// 已装的扩展里哪些来自市场（前端标「已添加」用；也认同名）——按范围算：自用装过的，全服那边仍可再装
export function installedKeys({ scope } = {}) {
  const out = [];
  for (const x of listExtensions({ scope })) {
    const s = x.source;
    if (!s?.market) continue;
    if (x.type === 'skill' && s.path) out.push(`skill:${s.market}::${s.path}`);
    if (x.type === 'plugin' && s.plugin) out.push(`plugin:${s.market}::${s.plugin}`);
    if (x.type === 'connector' && s.plugin && s.server) out.push(`connector:${s.market}::${s.plugin}::${s.server}`);
  }
  return out;
}
