#!/usr/bin/env node
// 从 bridge 公开版导出树同步 Muse Bridge。
//
// Muse Bridge = bridge 公开版 + Muse 专属的部分。专属部分只在下面 KEEP 列出的位置，同步时原样保留；
// 其余一律以公开版为准（整体覆盖，公开版删掉的文件这里也删），再剔除 Muse 不带的部分（DROP）。
// Muse 与本体的差别不靠改公开版的代码，而是经服务端声明：部署脚本写进 config.json 的 edition、环境变量、
// plugins.json，以及 Muse 插件 deploy/muse/plugin/（见 deploy/muse/sync/README.md）。
//
//   node deploy/muse/sync/sync-from-bridge.mjs --from <公开版导出树> [--stamp <bridge 提交>] [--check]
//
// --check：只打印会增删改哪些文件，不动工作区。
// 只动工作区，不提交；同步完先跑测试和隐私自检，再自己看 git diff 提交。

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..', '..');
const arg = (k) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : ''; };
const FROM = arg('from') ? path.resolve(arg('from')) : '';
const CHECK = process.argv.includes('--check');
if (!FROM || !existsSync(path.join(FROM, 'src', 'server.mjs'))) {
  console.error('用法：node deploy/muse/sync/sync-from-bridge.mjs --from <公开版导出树>（里面要有 src/server.mjs）');
  process.exit(2);
}

// Muse 专属：同步时原样保留（相对仓库根；目录以 / 结尾）
export const KEEP = [
  '.git/', '.github/', '.claude/',
  'deploy/muse/', 'feedback-worker/', 'docs/images/',
  'README.md', 'README.zh-CN.md', 'LICENSE', 'AGENTS.md', 'CLAUDE.md', 'CLAUDE.local.md',
  '.gitignore', '.gitattributes',
];

// 公开版里有、Muse 不带的（相对导出树根）
export const DROP = [
  'client/',                      // bridge 的 Windows 客户端源码：客户端由 bridge 发布，Muse 只做服务端
  'android/',                     // bridge 的离线 apk 工程：Muse 直接用 bridge 发的 apk（发版时从 bridge 公开 Release 取），不自己编
  'docker/', 'Dockerfile', 'docker-compose.yml', 'build-apk.ps1',
  'scripts/public/',              // bridge 公开仓自己的素材闸门与 CI 用件（扫描规则里有邮箱域名等字样，Muse 的隐私自检会误报）
  'README.md', 'README.zh-CN.md', 'CONTRIBUTING.md', 'CONTRIBUTING.zh-CN.md', 'AGENTS.md', 'CLAUDE.md', 'LICENSE',
];

const matches = (rel, list) => list.some((x) => (x.endsWith('/') ? rel === x.slice(0, -1) || rel.startsWith(x) : rel === x));

function walk(root, rel = '', out = []) {
  for (const e of readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const r = rel ? rel + '/' + e.name : e.name;
    if (e.name === 'node_modules' || e.name === '.git') continue;
    if (e.isDirectory()) walk(root, r, out);
    else if (e.isFile()) out.push(r);
  }
  return out;
}

const src = walk(FROM).filter((r) => !matches(r, DROP) && !matches(r, KEEP));
const cur = walk(REPO).filter((r) => !matches(r, KEEP));
// 本机运行产生的、被 .gitignore 挡掉的东西不碰：只删受版本管理、公开版里又没有的文件
const tracked = new Set();
try {
  const { execFileSync } = await import('node:child_process');
  for (const f of execFileSync('git', ['-c', 'core.quotepath=false', 'ls-files', '-z'], { cwd: REPO, encoding: 'utf8' }).split('\0')) if (f) tracked.add(f);
} catch { console.error('读不到 git ls-files，只做新增与覆盖'); }

const srcSet = new Set(src);
const toDelete = cur.filter((r) => tracked.has(r) && !srcSet.has(r));
const same = (a, b) => { try { const x = statSync(a), y = statSync(b); return x.size === y.size && readFileSync(a).equals(readFileSync(b)); } catch { return false; } };
const toAdd = [], toChange = [];
for (const r of src) {
  const dst = path.join(REPO, r);
  if (!existsSync(dst)) toAdd.push(r);
  else if (!same(path.join(FROM, r), dst)) toChange.push(r);
}

console.log(`[sync] 公开版 ${src.length} 个文件 → 新增 ${toAdd.length}、改动 ${toChange.length}、删除 ${toDelete.length}（保留 Muse 专属：${KEEP.join(' ')}）`);
if (CHECK) {
  const show = (t, l) => { if (l.length) console.log(`\n${t}（${l.length}）：\n  ` + l.slice(0, 200).join('\n  ') + (l.length > 200 ? '\n  …' : '')); };
  show('新增', toAdd); show('改动', toChange); show('删除', toDelete);
  process.exit(0);
}
for (const r of toDelete) rmSync(path.join(REPO, r), { force: true });
for (const r of [...toAdd, ...toChange]) {
  const dst = path.join(REPO, r);
  mkdirSync(path.dirname(dst), { recursive: true });
  cpSync(path.join(FROM, r), dst);
}
// 删空的目录
function prune(rel) {
  const abs = path.join(REPO, rel);
  let entries; try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (e.isDirectory() && e.name !== 'node_modules' && e.name !== '.git') prune(rel ? rel + '/' + e.name : e.name);
  if (rel && !matches(rel + '/', KEEP) && readdirSync(abs).length === 0) rmSync(abs, { recursive: true, force: true });
}
prune('');
writeFileSync(path.join(HERE, 'LAST_SYNC'), `${new Date().toISOString()} bridge ${arg('stamp') || '(未注明)'}\n`);
console.log('[sync] 完成。下一步：npm ci 各处、跑测试、隐私自检（CLAUDE.local.md），看 git diff 再提交');

