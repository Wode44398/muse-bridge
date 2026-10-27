#!/usr/bin/env node
// 在新机器上落地 export.mjs 导出的数据，并把里面的路径改成新机器的（Windows → Linux、换盘符换目录都行）。
//
//   node scripts/server/migrate/import.mjs --from <导出目录> --vault <新工作区根>
//        [--data-root <新数据根>] [--users-root <新多用户根>] [--claude-home <新 ~/.claude>] [--codex-home <新 ~/.codex>]
//        [--map 旧前缀=新前缀 ...] [--dry-run] [--force]
//
// 默认映射（manifest.json 里记着源机器上的位置）：
//   源数据根 → 新数据根（默认就是这份程序目录，或 BRIDGE_DATA_ROOT）
//   源 usersRoot → --users-root（默认 <新数据根>/users）
//   源 vaultPath → --vault（必填：会话里的项目路径都在这下面）
//   源 ~/.claude、~/.codex → 新机器上的同名目录
//   源用户主目录 → 新机器的用户主目录（兜底：其它在家目录下的路径）
// 还有别的位置（比如另一块盘上的项目）用 --map 补，越具体的前缀越优先。
//
// 落地规则：只增不删；目标已有的文件不覆盖（列出来，--force 才覆盖）。先 --dry-run 看一遍。
// 改写：落地的 .json / .jsonl 里【整个字符串就是路径】的值按映射改；Claude 的会话目录按新 cwd 换目录名
// （~/.claude/projects/<cwd 换成 - 的名字>），--resume 才找得到。句子中间夹的路径不改（只影响显示）。

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseArgs, parseMaps, rewritePath, rewriteJsonFile, rewriteJsonlFile, claudeProjectSlug, projectCwd,
  copyTree, moveOrMergeDir, fmtBytes,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROGRAM_ROOT = path.resolve(HERE, '..', '..', '..');
const args = parseArgs(process.argv.slice(2), { flags: ['dry-run', 'force', 'help'] });
if (args.help || !args.from) {
  console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 20).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(args.help ? 0 : 2);
}
const DRY = !!args['dry-run'];
const FORCE = !!args.force;
const FROM = path.resolve(String(args.from));
const manifest = JSON.parse(readFileSync(path.join(FROM, 'manifest.json'), 'utf8'));
const src = manifest.source || {};
const HOME = os.homedir();

const T = {
  dataRoot: path.resolve(String(args['data-root'] || process.env.BRIDGE_DATA_ROOT || PROGRAM_ROOT)),
  claudeHome: path.resolve(String(args['claude-home'] || process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'))),
  codexHome: path.resolve(String(args['codex-home'] || process.env.CODEX_HOME || path.join(HOME, '.codex'))),
};
T.usersRoot = path.resolve(String(args['users-root'] || path.join(T.dataRoot, 'users')));
T.vault = args.vault ? path.resolve(String(args.vault)) : '';
if (src.vaultPath && !T.vault) {
  console.error(`源机器的工作区在 ${src.vaultPath}：用 --vault 告诉我它在新机器上的位置（会话里的项目路径都要按它改）。`);
  process.exit(2);
}

// 映射：用户给的 --map 在前（同样长度时优先），默认映射随后；parseMaps 再按前缀长度排序
const mapList = [...(args.map || [])];
const add = (from, to) => { if (from && to && from !== to) mapList.push(`${from}=${to}`); };
add(src.vaultPath, T.vault);
add(src.dataRoot, T.dataRoot);
if (src.usersRoot) add(src.usersRoot, T.usersRoot);
add(src.claudeHome, T.claudeHome);
add(src.codexHome, T.codexHome);
add(src.home, HOME);
const maps = parseMaps(mapList);
console.log(`${DRY ? '[演练] ' : ''}从 ${FROM} 导入（源：${src.hostname || '?'}，${src.platform || '?'}，${manifest.createdAt || ''}）`);
console.log('路径映射：');
for (const m of maps) console.log(`  ${m.from}  →  ${m.to}`);

const copied = [];        // 本次真正落地的文件（只改写这些，不碰目标机器上原有的）
const origin = new Map(); // 落地文件 → 导出目录里的原件（演练时按原件估算改写）
const conflicts = [];
let totalFiles = 0, totalBytes = 0;
function land(name, from, to, opts = {}) {
  if (!existsSync(from)) return;
  const r = copyTree(from, to, { force: FORCE, dryRun: DRY, onFile: (dst, srcFile) => { copied.push(dst); origin.set(dst, srcFile); }, ...opts });
  totalFiles += r.files; totalBytes += r.bytes; conflicts.push(...r.conflicts);
  console.log(`  ✓ ${name} → ${to}：${r.files} 个文件，${fmtBytes(r.bytes)}${r.conflicts.length ? `，${r.conflicts.length} 个已存在没覆盖` : ''}`);
}

console.log('落地：');
land('数据根', path.join(FROM, 'data'), T.dataRoot);
land('多用户空间', path.join(FROM, 'users'), T.usersRoot);
land('~/.claude', path.join(FROM, 'claude-home'), T.claudeHome);
land('~/.codex', path.join(FROM, 'codex-home'), T.codexHome);

// ── 改写路径 ──────────────────────────────────────────────────────────────
const projectsDir = path.join(T.claudeHome, 'projects');
const inProjects = (f) => f.startsWith(projectsDir + path.sep);
let rewritten = 0, filesTouched = 0;
const big = 200 * 1024 * 1024;
for (const f of copied) {
  if (inProjects(f)) continue;                      // Claude 会话记录下面按项目整体处理
  if (!/\.(json|jsonl)$/i.test(f)) continue;
  const file = DRY ? origin.get(f) : f;              // 演练时文件没真落地：按导出目录里的原件估算，不写
  if (statSync(file).size > big) continue;
  const n = file.toLowerCase().endsWith('.jsonl') ? rewriteJsonlFile(file, maps, { dryRun: DRY }) : rewriteJsonFile(file, maps, { dryRun: DRY });
  if (n > 0) { rewritten += n; filesTouched++; }
}
console.log(`改写：${filesTouched} 个状态文件里 ${rewritten} 处路径${DRY ? '（演练，未写入）' : ''}`);

// Claude 会话目录：按新 cwd 换目录名，并改写记录里的路径
const importedProjects = new Set(copied.filter(inProjects).map((f) => path.relative(projectsDir, f).split(path.sep)[0]));
let movedProjects = 0, projectConflicts = 0;
for (const slug of importedProjects) {
  const dir = path.join(projectsDir, slug);
  const probeDir = DRY ? path.join(FROM, 'claude-home', 'projects', slug) : dir;
  if (!existsSync(probeDir)) continue;
  const oldCwd = projectCwd(probeDir);
  const newCwd = oldCwd ? rewritePath(oldCwd, maps) : '';
  if (!DRY) {
    for (const name of readdirSync(dir)) {
      const f = path.join(dir, name);
      if (name.endsWith('.jsonl')) rewriteJsonlFile(f, maps);
      else if (name.endsWith('.json')) rewriteJsonFile(f, maps);
    }
  }
  if (!newCwd || newCwd === oldCwd) continue;
  const newSlug = claudeProjectSlug(newCwd);
  if (newSlug === slug) continue;
  const r = moveOrMergeDir(dir, path.join(projectsDir, newSlug), { dryRun: DRY });
  movedProjects++;
  if (r.conflicts && r.conflicts.length) projectConflicts += r.conflicts.length;
  console.log(`  会话目录 ${slug} → ${newSlug}${r.moved === false ? `（目标已存在，合并${r.conflicts.length ? `，${r.conflicts.length} 个同名没覆盖，原目录留着待你确认` : ''}）` : ''}`);
}
console.log(`Claude 会话：${importedProjects.size} 个项目目录，${movedProjects} 个按新路径换了目录名`);

// Codex 的 config.toml 里有项目信任表（[projects."D:\\Notes\\..."]）：TOML 不解析，只改引号里整串就是路径的地方
const codexToml = path.join(T.codexHome, 'config.toml');
if (!DRY && copied.includes(codexToml)) {
  const raw = readFileSync(codexToml, 'utf8');
  const out = raw.replace(/"((?:[^"\\]|\\.)*)"/g, (whole, inner) => {
    const unescaped = inner.replace(/\\\\/g, '\\');
    const next = rewritePath(unescaped, maps);
    return next === unescaped ? whole : '"' + next.replace(/\\/g, '\\\\') + '"';
  });
  if (out !== raw) { writeFileSync(codexToml, out); console.log('改写：~/.codex/config.toml 里的项目路径'); }
}

// 老中继的设备表：并进新服务端的设备登记（令牌哈希原样，已配对的被控端不用重配）
const relayFile = path.join(FROM, 'relay-devices.json');
if (existsSync(relayFile)) {
  if (DRY) console.log('老中继设备表：会并进 <新数据根>/devices.json（演练不动）');
  else {
    process.env.BRIDGE_DATA_ROOT = T.dataRoot;   // device-registry 按它定位 devices.json，加载前设好
    const { importRelayDevices } = await import('../../../src/runtime/device-registry.mjs');
    const r = importRelayDevices(relayFile);
    console.log(r.error ? `! 老中继设备表没并进去：${r.error}` : `老中继设备表：并入 ${r.added} 台，跳过 ${r.skipped} 台（已存在或缺令牌哈希）`);
  }
}

// ── 收尾检查 ──────────────────────────────────────────────────────────────
console.log(`\n${DRY ? '[演练] 会落地' : '已落地'} ${totalFiles} 个文件，共 ${fmtBytes(totalBytes)}。`);
if (conflicts.length) {
  console.log(`! ${conflicts.length} 个文件新机器上已有、没覆盖（例：${conflicts.slice(0, 3).join('、')}）。确认要用导出的版本就加 --force 再跑一遍。`);
  if (conflicts.some((f) => path.basename(f) === 'config.json')) {
    console.log('  config.json 新机器上已有：多半是首次启动生成的。要沿用老机器的令牌 / 账号 / 各家密钥，就用 --force，或手动把需要的字段合过去。');
  }
}
const cfgPath = path.join(T.dataRoot, 'config.json');
if (!DRY && existsSync(cfgPath)) {
  try {
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, ''));
    for (const k of ['vaultPath', 'usersRoot', 'codexBin', 'spatialPython', 'clientDist', 'claudeChromeConfigDir']) {
      if (cfg[k] && !existsSync(cfg[k])) console.log(`! config.json 的 ${k} 指向 ${cfg[k]}，这台机器上不存在——改掉或删掉这一项`);
    }
  } catch {}
}
const wsFile = path.join(FROM, 'workspaces.json');
if (existsSync(wsFile)) {
  const ws = JSON.parse(readFileSync(wsFile, 'utf8'));
  const repos = (ws.repos || []).filter((r) => r.remotes && r.remotes.length);
  if (repos.length) {
    console.log(`\n工作区：${repos.length} 个仓库要在新机器上 clone（工作区根 ${T.vault}）：`);
    for (const r of repos) {
      const url = r.remotes[0].split(' ')[1];
      const dest = r.rel === '.' ? T.vault : path.join(T.vault, r.rel);
      console.log(`  git clone ${url} "${dest}"${r.branch && r.branch !== 'HEAD' ? ` && git -C "${dest}" checkout ${r.branch}` : ''}`);
    }
  }
}
console.log('\n导入完成后：启动 bridge，登录看会话列表与续聊；导出目录里有真凭据，确认无误就删掉它。');
