#!/usr/bin/env node
// 把一台 bridge 服务端的数据导出成一个目录，搬到新机器上用 import.mjs 落地（家里主机 → VPS 就靠它）。
//
//   node scripts/server/migrate/export.mjs --out D:\bridge-export [--media] [--no-users] [--no-claude] [--no-codex]
//        [--relay-devices <老中继的 devices.json>] [--dry-run]
//
// 导出什么（只读源头，什么都不删）：
//   data/            数据根里的状态：config.json、会话索引、偏好、Routines、分享链接、设备登记、扩展中心、
//                    dimensio 的会话 / 记忆 / 知识库……（数据根是 git 工程时 = 被 .gitignore 忽略的那些，减去缓存与构建产物）
//                    上传与生成的媒体（uploads、media、genmedia……）体积大，加 --media 才带
//   users/           多用户的各自空间（config.json 的 usersRoot）
//   claude-home/     ~/.claude 里有用的部分：会话记录 projects/、技能、插件、settings.json、CLAUDE.md、hooks……
//                    （缓存、遥测、调试日志不带）
//   codex-home/      ~/.codex：登录态、配置、会话（Codex 自带的二进制不带，新机器上重新装）
//   workspaces.json  工作区（vaultPath 下各个 git 仓库）只记远端地址与分支——新机器上 git clone，不拷文件
//   manifest.json    源机器上这些东西原来在哪（import.mjs 据此生成路径映射）
//
// config.json 与 ~/.codex/auth.json 是真凭据：导出目录要当密码一样保管，搬完就删。
// 导出前最好先停掉 bridge（或至少别在跑任务），状态文件才是一致的。

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyTree, fmtBytes, parseArgs } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROGRAM_ROOT = path.resolve(HERE, '..', '..', '..');
const args = parseArgs(process.argv.slice(2), { flags: ['media', 'no-users', 'no-claude', 'no-codex', 'dry-run', 'force'] });
const DRY = !!args['dry-run'];

if (!args.out) {
  console.error('用法：node scripts/server/migrate/export.mjs --out <导出目录> [--media] [--no-users] [--no-claude] [--no-codex] [--dry-run]');
  process.exit(2);
}
const OUT = path.resolve(String(args.out));
const DATA_ROOT = path.resolve(String(args['data-root'] || process.env.BRIDGE_DATA_ROOT || PROGRAM_ROOT));
const HOME = os.homedir();
const CLAUDE_HOME = path.resolve(String(args['claude-home'] || process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude')));
const CODEX_HOME = path.resolve(String(args['codex-home'] || process.env.CODEX_HOME || path.join(HOME, '.codex')));

if (existsSync(OUT) && readdirSync(OUT).length && !args.force) {
  console.error(`导出目录 ${OUT} 不是空的——换一个，或加 --force 往里合并（已有文件不覆盖）。`);
  process.exit(2);
}

let config = {};
try { config = JSON.parse(readFileSync(path.join(DATA_ROOT, 'config.json'), 'utf8').replace(/^\uFEFF/, '')); }
catch { console.warn(`! ${DATA_ROOT} 里没有可读的 config.json——数据根对吗？（--data-root 指定）`); }

// ── 数据根里哪些算「数据」 ─────────────────────────────────────────────────
// 缓存、构建产物、日志、二进制：新机器上会重新生成，不搬。
const NEVER = [
  /^node_modules$/, /(^|\/)node_modules$/, /^public\/app$/, /^\.bin$/, /^\.git$/, /^\.claude(\/|$)/, /^crashdumps$/,
  /^android\//, /^harness\/android\//, /^harness\/web\/dist$/, /^harness\/tmp(\/|$)/, /^harness\/workspace\/node_modules$/,
  /^harness\/workspace\/\.sdk(\/|$)/,                    // dimensio 工作区里装的工具链（Android SDK 等），新机器上按需重装
  /^harness\/\.ui-test-/, /\.bak-\d{8}/,                  // 测试残留与手工备份
  /^harness\/tools\/.*\/venv$/, /^web\/dist$/, /^cf-relay\//, /^client-dist$/,
  /^thumb-cache$/, /^office-cache$/, /^zip-cache$/, /^code-stats-cache\.json$/, /^desktop-lineage-cache\.json$/,
  /\.apk$/, /\.heapsnapshot$/, /\.log(\.\d+)?$/, /(^|\/)server\.out\.log/, /\.pid$/, /^bridge-service\.(stop|restart|deps)$/,
  /^status\.json$/, /^inflight-runs\.json$/, /^local-pc-broker\.json$/, /^desktop-host\.json$/, /^remote-control\.state\.json$/,
  // agy 已下线
  /^agy-/, /^agy-session\.json$/, /^agy-response\.md$/,
];
// 体积大的用户内容：--media 才带
const MEDIA = [/^uploads$/, /^media$/, /^genmedia$/, /^vertex-history$/, /^share-spaces$/, /^chat-snapshots$/, /^harness\/workspace(\/|$)/];

const never = (rel) => NEVER.some((re) => re.test(rel));
const isMedia = (rel) => MEDIA.some((re) => re.test(rel));

function ignoredEntries(root) {
  // 数据根是 git 工程：被忽略的条目（目录折叠成一项）就是运行时数据
  try {
    const out = execFileSync('git', ['-C', root, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20, windowsHide: true });
    return out.split('\0').filter(Boolean).map((p) => p.replace(/\/$/, ''));
  } catch { return null; }
}

function dataEntries() {
  const isRepo = existsSync(path.join(DATA_ROOT, '.git'));
  let list = isRepo ? ignoredEntries(DATA_ROOT) : null;
  if (!list) list = readdirSync(DATA_ROOT);   // 不是 git 工程（VPS 上的独立数据根 / 本机服务端的数据目录）：整个目录都是数据
  const picked = [], media = [], dropped = [];
  for (const rel of list) {
    const r = rel.replace(/\\/g, '/');
    if (never(r)) { dropped.push(r); continue; }
    if (isMedia(r)) { media.push(r); continue; }
    picked.push(r);
  }
  return { picked, media, dropped, isRepo };
}

// ── ~/.claude 与 ~/.codex 里有用的部分 ────────────────────────────────────
const CLAUDE_KEEP = new Set(['projects', 'skills', 'plugins', 'hooks', 'agents', 'commands', 'output-styles', 'settings.json', 'CLAUDE.md', 'history.jsonl', 'todos', 'file-history', 'sessions']);
const CLAUDE_SKIP_IN_PLUGINS = [/^plugins\/cache(\/|$)/, /^plugins\/marketplaces\/.*\/\.git(\/|$)/];
// Codex：登录态、配置、会话、线程历史要；二进制、沙箱、缓存、日志库、插件缓存不要（新机器上重装 / 重新生成）。
// visualizations（Codex 生成的图表缓存，动辄几个 GB）算媒体，--media 才带。
const CODEX_SKIP = [/^log(\/|$)/, /^logs_\d+\.sqlite/, /^tmp(\/|$)/, /^\.tmp(\/|$)/, /^plugins(\/|$)/, /^bin(\/|$)/, /^\.sandbox/, /^cache(\/|$)/, /\.bak$/];
const CODEX_MEDIA = [/^visualizations(\/|$)/];

function gitInfo(dir) {
  const run = (a) => { try { return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', windowsHide: true, timeout: 10_000 }).trim(); } catch { return ''; } };
  if (!existsSync(path.join(dir, '.git'))) return null;
  return { path: dir, branch: run(['rev-parse', '--abbrev-ref', 'HEAD']), head: run(['rev-parse', 'HEAD']), remotes: run(['remote', '-v']).split('\n').filter((l) => l.endsWith('(fetch)')).map((l) => l.split(/\s+/).slice(0, 2).join(' ')), dirty: !!run(['status', '--porcelain']) };
}

function workspaces() {
  const vault = config.vaultPath ? path.resolve(config.vaultPath) : '';
  const out = { vaultPath: vault, repos: [] };
  if (!vault || !existsSync(vault)) return out;
  const top = gitInfo(vault);
  if (top) out.repos.push({ ...top, rel: '.' });
  for (const ent of readdirSync(vault, { withFileTypes: true })) {
    if (!ent.isDirectory() || ent.name.startsWith('.')) continue;
    const info = gitInfo(path.join(vault, ent.name));
    if (info) out.repos.push({ ...info, rel: ent.name });
  }
  return out;
}

// ── 开工 ──────────────────────────────────────────────────────────────────
const parts = [];
const total = { files: 0, bytes: 0 };
const conflicts = [];
function part(name, src, dst, opts = {}) {
  if (!existsSync(src)) { console.log(`  · ${name}：源不存在（${src}），跳过`); return; }
  const r = copyTree(src, dst, { dryRun: DRY, ...opts });
  total.files += r.files; total.bytes += r.bytes; conflicts.push(...r.conflicts);
  parts.push({ name, src, files: r.files, bytes: r.bytes });
  console.log(`  ✓ ${name}：${r.files} 个文件，${fmtBytes(r.bytes)}${r.skipped ? `（跳过 ${r.skipped} 项缓存）` : ''}`);
}

console.log(`${DRY ? '[演练] ' : ''}导出到 ${OUT}`);
console.log(`  数据根 ${DATA_ROOT}`);
if (!DRY) mkdirSync(OUT, { recursive: true });

const d = dataEntries();
console.log(`数据根（${d.isRepo ? 'git 工程，只取被忽略的运行时数据' : '整个目录'}）：`);
for (const rel of d.picked) part('data/' + rel, path.join(DATA_ROOT, rel), path.join(OUT, 'data', rel), { skip: (r) => never(rel + '/' + r) });
if (args.media) for (const rel of d.media) part('data/' + rel, path.join(DATA_ROOT, rel), path.join(OUT, 'data', rel));
else if (d.media.length) {
  const groups = [...new Set(d.media.map((r) => (r.startsWith('harness/workspace') ? 'harness/workspace' : r)))];
  console.log(`  · 媒体与上传没带（${groups.join('、')}）——要带加 --media`);
}

const usersRoot = config.usersRoot ? path.resolve(config.usersRoot) : '';
if (!args['no-users'] && usersRoot && path.resolve(usersRoot) !== DATA_ROOT) {
  console.log('多用户空间：');
  part('users', usersRoot, path.join(OUT, 'users'), { skip: (r) => /(^|\/)node_modules$/.test(r) || (!args.media && /(^|\/)(uploads|media|genmedia)$/.test(r)) });
}
// --projects-since N：Claude 的会话记录只带最近 N 天有动静的项目（全部动辄好几 GB）
const since = Number(args['projects-since']) > 0 ? Date.now() - Number(args['projects-since']) * 86400_000 : 0;
function staleProject(name) {
  if (!since) return false;
  const dir = path.join(CLAUDE_HOME, 'projects', name);
  try { return !readdirSync(dir).some((f) => statSync(path.join(dir, f)).mtimeMs >= since); } catch { return false; }
}
if (!args['no-claude']) {
  console.log('Claude（~/.claude）：');
  for (const name of readdirSync(CLAUDE_HOME).filter((n) => CLAUDE_KEEP.has(n))) {
    part('claude-home/' + name, path.join(CLAUDE_HOME, name), path.join(OUT, 'claude-home', name), {
      skip: (r, isDir) => CLAUDE_SKIP_IN_PLUGINS.some((re) => re.test(name + '/' + r)) || (name === 'projects' && isDir && !r.includes('/') && staleProject(r)),
    });
  }
  if (!since) console.log('  · 会话记录全带了；只要最近的加 --projects-since <天数>');
}
if (!args['no-codex'] && existsSync(CODEX_HOME)) {
  console.log('Codex（~/.codex）：');
  part('codex-home', CODEX_HOME, path.join(OUT, 'codex-home'), { skip: (r) => CODEX_SKIP.some((re) => re.test(r)) || (!args.media && CODEX_MEDIA.some((re) => re.test(r))) });
}

// 老中继的设备表（client\host\devices.json，存的是令牌哈希）：带上它，导入时并进新服务端的设备登记，
// 已登记的老客户端不用重新配对。
const relayDevices = args['relay-devices'] ? path.resolve(String(args['relay-devices'])) : '';
if (relayDevices) {
  if (existsSync(relayDevices)) {
    if (!DRY) { mkdirSync(OUT, { recursive: true }); writeFileSync(path.join(OUT, 'relay-devices.json'), readFileSync(relayDevices)); }
    console.log(`老中继设备表：${relayDevices} → relay-devices.json`);
  } else console.log(`! 老中继设备表 ${relayDevices} 不存在，跳过`);
}

const ws = workspaces();
const manifest = {
  version: 1,
  createdAt: new Date().toISOString(),
  source: {
    platform: process.platform, hostname: os.hostname(), home: HOME,
    dataRoot: DATA_ROOT, usersRoot, vaultPath: ws.vaultPath, claudeHome: CLAUDE_HOME, codexHome: CODEX_HOME,
    port: Number(config.port) || 8787,
  },
  media: !!args.media,
  parts,
  dropped: d.dropped,
};
if (!DRY) {
  writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(OUT, 'workspaces.json'), JSON.stringify(ws, null, 2));
}
console.log(`\n${DRY ? '[演练] 会导出' : '已导出'} ${total.files} 个文件，共 ${fmtBytes(total.bytes)}。`);
if (ws.repos.length) {
  const dirty = ws.repos.filter((r) => r.dirty).map((r) => r.rel);
  const noRemote = ws.repos.filter((r) => !r.remotes.length).map((r) => r.rel);
  console.log(`工作区：${ws.repos.length} 个 git 仓库记进了 workspaces.json（新机器上 clone，不拷文件）。`);
  if (dirty.length) console.log(`  ! 有未提交改动：${dirty.join('、')}——先提交推送，否则新机器上 clone 不到`);
  if (noRemote.length) console.log(`  ! 没有远端：${noRemote.join('、')}——这些要手动拷过去（或先建远端推上去）`);
}
if (conflicts.length) console.log(`! ${conflicts.length} 个文件导出目录里已有，没覆盖（例：${conflicts[0]}）`);
console.log('\n导出目录里有 config.json 与 Codex 登录态等真凭据：传输与保管当密码对待，导入完就删。');
console.log('下一步：把整个导出目录拷到新机器，在那边跑 node scripts/server/migrate/import.mjs --from <目录> ...（--help 看参数）');
