// 「自定义」页（Claude Desktop Customize 同款）的「发现」数据源：Anthropic 官方插件目录
// <CLAUDE_CONFIG_DIR 或 ~/.claude>/plugins/marketplaces/claude-plugins-official/.claude-plugin/marketplace.json。
// 新装的服务器上可能还没有这份副本：fetchOfficialCatalog() 从 GitHub 浅克隆补上（管理员点按钮才拉）。
//
// 与官方 Desktop 一样，目录里的插件全部列出：
//   本地源（./plugins/…、./external_plugins/…）  直接从副本装；还额外拆出插件自带的技能、MCP（可单独装）
//   远程源（url / git-subdir）                  点「添加」时才 git 拉取，钉住目录里写的 sha
// 每一项三类之一：
//   plugin    插件本身（装进扩展中心 plugins/；userConfig 与 MCP 里的 ${VAR} 装好后在「配置」里填）
//   skill     插件自带的每个 skills/<dir>/SKILL.md（可单独装成技能）
//   connector 插件 .mcp.json 里的 MCP server（${VAR} 占位 = 添加时要填的字段；用到 ${CLAUDE_PLUGIN_ROOT} 的要随插件装，不单列）
// 安装一律复用 extensions.mjs 的 installPlugin / installSkill / saveConnector（同一套校验与凭据文件清扫）。
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, rmSync, renameSync } from 'node:fs';
import { execFile } from 'node:child_process';
import {
  EXT_ROOT, listExtensions, parseFrontmatter, installPlugin, installSkill, saveConnector, pluginConfigFields,
} from './extensions.mjs';

// 管理员的 Claude 会话用进程环境里的 CLAUDE_CONFIG_DIR（没设就是 ~/.claude），目录副本也在那下面。
export const MARKETPLACES_DIR = process.env.CLAUDE_MARKETPLACES_DIR
  || path.join(String(process.env.CLAUDE_CONFIG_DIR || '').trim() || path.join(os.homedir(), '.claude'), 'plugins', 'marketplaces');
// 只列 Anthropic 官方目录（Claude Desktop 的 Anthropic Directory）。同级的其它目录（如桌面版上传的
// local-desktop-app-uploads）是账号级共享库，不掺进来。
export const OFFICIAL_MARKETS = ['claude-plugins-official'];
const OFFICIAL_REPO = 'https://github.com/anthropics/claude-plugins-official.git';

const httpErr = (status, msg) => Object.assign(new Error(msg), { status });
const clip = (s, n) => String(s ?? '').replace(/\p{Cc}/gu, ' ').trim().slice(0, n);
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const within = (root, p) => p === root || p.startsWith(root + path.sep);
const readJsonSafe = (f) => { try { return JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; } };
const subdirs = (d) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort(); } catch { return []; } };

const MARKET_LABELS = { 'claude-plugins-official': 'Anthropic' };
const marketLabel = (name, meta) => MARKET_LABELS[name] || clip(meta?.owner?.name, 60) || name;

// —— 连接器模板：${VAR} 是添加时要填的字段；${VAR:-默认} 可不填 ——
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(:-([^}]*))?\}/g;
const SENSITIVE_RE = /token|secret|key|password|passwd|auth|credential|cookie|pat$/i;

function templateVars(cfg) {
  const out = new Map();
  const walk = (v) => {
    if (typeof v === 'string') for (const m of v.matchAll(VAR_RE)) { if (!out.has(m[1]) || m[2] === undefined) out.set(m[1], m[2] !== undefined ? m[3] : undefined); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(cfg);
  return out;   // 名字 → 默认值（undefined = 必填）
}

function fillTemplate(x, values) {
  if (typeof x === 'string') {
    return x.replace(VAR_RE, (m, name, d, def) => {
      const v = values[name];
      if (v != null && String(v) !== '') return String(v);
      if (d !== undefined) return def;
      throw httpErr(400, `请填写 ${name}`);
    });
  }
  if (Array.isArray(x)) return x.map((v) => fillTemplate(v, values));
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fillTemplate(v, values)]));
  return x;
}

function mcpServersOf(pluginDir) {
  const j = readJsonSafe(path.join(pluginDir, '.mcp.json'));
  if (!j || typeof j !== 'object') return [];
  const map = j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : j;   // 两种写法都有
  return Object.entries(map).filter(([, c]) => c && typeof c === 'object' && !Array.isArray(c));
}

// .mcp.json 的一条 → 连接器模板（transport + 要填的字段）；不能单独装的返回 null。
function connectorTemplate(cfg) {
  const vars = templateVars(cfg);
  if (vars.has('CLAUDE_PLUGIN_ROOT') || vars.has('CLAUDE_PLUGIN_DATA')) return null;   // 要随插件一起装
  const t = cfg.type === 'http' || cfg.type === 'sse' ? cfg.type : (cfg.url && !cfg.command ? 'http' : 'stdio');
  if (t === 'stdio' && (typeof cfg.command !== 'string' || !cfg.command.trim())) return null;
  if (t !== 'stdio' && (typeof cfg.url !== 'string' || !/^(https?:\/\/|\$\{)/i.test(cfg.url))) return null;
  const fields = [...vars].map(([key, def]) => ({
    key, title: key, description: '', type: 'string', sensitive: SENSITIVE_RE.test(key),
    required: def === undefined, ...(def !== undefined ? { default: def } : {}),
  }));
  return { transport: t, fields, cfg };
}

function connectorInput(tpl, values = {}) {
  const c = fillTemplate(tpl.cfg, values);
  if (tpl.transport === 'stdio') {
    const env = {};
    for (const [k, v] of Object.entries(c.env || {})) env[k] = String(v);
    return { transport: 'stdio', command: c.command, args: Array.isArray(c.args) ? c.args.map(String) : [], env };
  }
  if (!/^https?:\/\//i.test(String(c.url))) throw httpErr(400, '连接地址无效');
  const headers = {};
  for (const [k, v] of Object.entries(c.headers || {})) if (String(v).trim()) headers[k] = String(v);   // ${X:-} 解成空串的头不带
  return { transport: tpl.transport, url: c.url, headers };
}

// 插件自带技能的目录：skills/<dir> 约定 + 目录条目里显式列的 skills 路径（相对插件根），去重。
function skillDirsOf(pluginDir, entry) {
  const out = new Set(subdirs(path.join(pluginDir, 'skills')).map((d) => path.join(pluginDir, 'skills', d)));
  for (const rel of Array.isArray(entry.skills) ? entry.skills : []) {
    if (typeof rel !== 'string') continue;
    const abs = path.resolve(pluginDir, rel);
    if (within(pluginDir, abs)) out.add(abs);
  }
  return [...out].filter((d) => existsSync(path.join(d, 'SKILL.md')));
}

// 远程源 → { url, ref, sha, path }；认不出的返回 null（不列）
function remoteOf(src) {
  if (!src || typeof src !== 'object') return null;
  let url = '';
  if ((src.source === 'url' || src.source === 'git-subdir') && typeof src.url === 'string') url = src.url;
  else if (src.source === 'github' && /^[\w.-]+\/[\w.-]+$/.test(src.repo || '')) url = `https://github.com/${src.repo}.git`;
  if (!/^https:\/\//i.test(url)) return null;
  const s = (v) => (typeof v === 'string' ? v : '');
  return { url, ref: s(src.ref), sha: /^[0-9a-f]{7,40}$/i.test(s(src.sha)) ? src.sha : '', path: s(src.path) };
}
const repoLabel = (url) => url.replace(/^https:\/\/(www\.)?/i, '').replace(/\.git$/i, '');

// strict:false 的条目没有自己的 plugin.json，定义写在目录条目里：装的时候按条目补一份
function manifestFromEntry(entry) {
  const { source, category, tags, strict, ...manifest } = entry;
  return manifest;
}

// 扫目录。条目带内部字段（_dir / _tpl / _entry / _remote）供安装用，对外经 listCatalog 剥掉。
function scan(root, only) {
  const installed = listExtensions();
  // 已添加：记过目录 id 的按 id 认（插件自己的 name 可能和目录条目不一样），老的按同类同名认
  const has = (type, name, id) => installed.some((x) => x.catalogId === id || (!x.catalogId && x.type === type && x.name === name));
  const items = [];
  const markets = [];
  const rootAbs = path.resolve(root);
  for (const m of subdirs(rootAbs)) {
    if (only && !only.includes(m)) continue;
    const mdir = path.join(rootAbs, m);
    const meta = readJsonSafe(path.join(mdir, '.claude-plugin', 'marketplace.json'));
    if (!meta || !Array.isArray(meta.plugins)) continue;
    const label = marketLabel(m, meta);
    let count = 0;
    for (const p of meta.plugins) {
      if (!p || typeof p.name !== 'string') continue;
      const pname = clip(p.name, 80);
      if (!pname) continue;
      const base = {
        market: m, source: label, plugin: pname,
        category: clip(p.category, 40), author: clip(p.author?.name, 60),
        homepage: /^https?:\/\//i.test(p.homepage || '') ? clip(p.homepage, 300) : '',
      };
      const plugin = {
        ...base, id: `${m}/${pname}`, type: 'plugin', name: pname,
        title: clip(p.displayName, 80) || pname, description: clip(p.description, 600),
        installed: has('plugin', pname, `${m}/${pname}`), _entry: p,
      };
      if (typeof p.source !== 'string') {
        const remote = remoteOf(p.source);
        if (!remote) continue;
        items.push({ ...plugin, remote: true, repo: repoLabel(remote.url), _remote: remote });
        count++;
        continue;
      }
      const dir = path.resolve(mdir, p.source);
      if (!within(mdir, dir) || !isDir(dir)) continue;
      const hasManifest = existsSync(path.join(dir, '.claude-plugin', 'plugin.json'));
      let fields = [];
      try { fields = pluginConfigFields(dir, hasManifest ? undefined : manifestFromEntry(p)); } catch {}
      items.push({ ...plugin, configurable: fields.length > 0, _dir: dir });
      count++;
      for (const sdir of skillDirsOf(dir, p)) {
        let fm = null;
        try { fm = parseFrontmatter(readFileSync(path.join(sdir, 'SKILL.md'), 'utf8')); } catch {}
        if (!fm || !fm.name || !fm.description) continue;
        const sname = clip(fm.name, 80);
        const sid = `${m}/${pname}/skill/${path.relative(dir, sdir).split(path.sep).join('/')}`;
        items.push({
          ...base, id: sid, type: 'skill',
          name: sname, title: sname, description: clip(fm.description, 600),
          installed: has('skill', sname, sid), _dir: sdir,
        });
        count++;
      }
      for (const [key, cfg] of mcpServersOf(dir)) {
        const tpl = connectorTemplate(cfg);
        if (!tpl) continue;
        const cname = clip(key, 60);
        items.push({
          ...base, id: `${m}/${pname}/mcp/${cname}`, type: 'connector', name: cname, title: cname,
          description: clip(p.description, 600), transport: tpl.transport, fields: tpl.fields,
          installed: has('connector', cname, `${m}/${pname}/mcp/${cname}`), _tpl: tpl,
        });
        count++;
      }
    }
    markets.push({ name: m, label, count });
  }
  return { items, markets };
}

const strip = ({ _dir, _tpl, _entry, _remote, ...pub }) => pub;

export function listCatalog({ root = MARKETPLACES_DIR, only = OFFICIAL_MARKETS } = {}) {
  const { items, markets } = scan(root, only);
  return { items: items.map(strip), markets };
}

// —— git ——
function git(args, { cwd, timeout = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-c', 'advice.detachedHead=false', ...args], {
      cwd, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024,
    }, (err, _out, stderr) => {
      if (!err) return resolve();
      if (err.code === 'ENOENT') return reject(httpErr(500, '服务器上没有 git，无法下载'));
      reject(httpErr(502, '下载失败：' + String(stderr || err.message).trim().slice(0, 300)));
    });
  });
}

// 拉远程插件到 stage：有 sha 先按 sha 浅取（GitHub 支持），不行再按 ref / 默认分支浅克隆。
async function fetchRemote(remote, stage) {
  if (remote.sha) {
    try {
      mkdirSync(stage, { recursive: true });
      await git(['init', '-q'], { cwd: stage });
      await git(['remote', 'add', 'origin', remote.url], { cwd: stage });
      await git(['fetch', '-q', '--depth', '1', 'origin', remote.sha], { cwd: stage });
      await git(['checkout', '-q', 'FETCH_HEAD'], { cwd: stage });
      return;
    } catch { rmSync(stage, { recursive: true, force: true }); }
  }
  await git(['clone', '-q', '--depth', '1', ...(remote.ref ? ['--branch', remote.ref] : []), remote.url, stage]);
}

// 从目录装一项。id 必须能在【现扫的】目录里找到——路径全由目录解析，前端传不进任意路径。
// values：连接器模板要填的字段（插件的配置装好后另走 /api/extensions/configure）。
export async function installFromCatalog(id, { root = MARKETPLACES_DIR, only = OFFICIAL_MARKETS, values = {} } = {}) {
  const hit = scan(root, only).items.find((x) => x.id === String(id || ''));
  if (!hit) throw httpErr(404, '目录里没有这一项（目录可能刚更新过，刷新再试）');
  if (hit.installed) throw httpErr(409, `「${hit.name}」已经装过了`);
  const source = `${hit.source} · ${hit.plugin}`;
  if (hit.type === 'connector') {
    return saveConnector({ name: hit.name, description: hit.description, pkg: hit.plugin, catalogId: hit.id, ...connectorInput(hit._tpl, values || {}) });
  }
  if (hit.type === 'skill') {
    return installSkill(`${hit.name}.zip`, null, { fromDir: hit._dir, catalogId: hit.id });
  }
  const manifest = manifestFromEntry(hit._entry);
  if (!hit.remote) return installPlugin(`${hit.name}.zip`, null, { fromDir: hit._dir, manifest, source, catalogId: hit.id });
  const stage = path.join(EXT_ROOT, 'runtime', `.git-${crypto.randomBytes(4).toString('hex')}`);
  try {
    mkdirSync(path.dirname(stage), { recursive: true });
    await fetchRemote(hit._remote, stage);
    const dir = hit._remote.path ? path.resolve(stage, hit._remote.path) : stage;
    if (!within(stage, dir) || !isDir(dir)) throw httpErr(502, `仓库里没有 ${hit._remote.path}`);
    return await installPlugin(`${hit.name}.zip`, null, { fromDir: dir, manifest, source: `${hit.source} · ${hit.repo}`, catalogId: hit.id });
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

// 下载 / 更新 Anthropic 官方目录副本：浅克隆进同级暂存目录，成功了再换掉旧副本（失败不碰旧的）。
// 出站走进程环境里的 HTTPS_PROXY（git 认）；同一时刻只跑一份。
let fetching = null;
export function fetchOfficialCatalog({ root = MARKETPLACES_DIR, repo = OFFICIAL_REPO } = {}) {
  if (fetching) return fetching;
  fetching = (async () => {
    const dest = path.join(root, OFFICIAL_MARKETS[0]);
    const stage = path.join(root, `.fetch-${crypto.randomBytes(4).toString('hex')}`);
    mkdirSync(root, { recursive: true });
    try {
      await git(['clone', '-q', '--depth', '1', repo, stage]);
      if (!readJsonSafe(path.join(stage, '.claude-plugin', 'marketplace.json'))) throw httpErr(502, '下载到的官方目录缺少 marketplace.json');
      rmSync(path.join(stage, '.git'), { recursive: true, force: true });
      const old = existsSync(dest) ? `${stage}-old` : null;
      if (old) renameSync(dest, old);
      renameSync(stage, dest);
      if (old) rmSync(old, { recursive: true, force: true });
      return listCatalog({ root });
    } finally {
      rmSync(stage, { recursive: true, force: true });
      fetching = null;
    }
  })();
  return fetching;
}
