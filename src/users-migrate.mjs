// 注册账号迁移：把一台 bridge 上的注册账号连同聊天记录搬到另一台（比如从 Muse VM 搬到正式的 VPS），旧对话在新机器上能接着聊。
//
//   旧机器：  npm run -s users:export -- --out <目录> [--users a,b]
//   新机器：  npm run -s users:import -- --from <目录> [--users a,b] [--overwrite]
//   （两边都要带上各自的数据根：BRIDGE_DATA_ROOT=… 或在程序目录里跑）
//
// 搬什么：账号记录（密码哈希原样，朋友不用改密码；档位、能用的 agent、快照权限、服务账号、额度）、
// 用量、每个人的整个目录（工作空间文件 + .bridge 里的 Claude 会话、项目表、快照桶、上传、媒体、dimensio 数据）。不搬登录会话（换了服务器大家重新登录一次）。
//
// 为什么要改写：Claude 的会话按「工作目录路径」归档（.bridge/claude/projects/<把 cwd 里的非字母数字换成 -
// 得到的目录名>/），会话里每一行也记着 cwd 和一堆绝对路径；项目表、快照桶的 json 里也是绝对路径。路径从
// E:\Old Bridge Users\<人> 变成 /var/lib/bridge/users/<人> 之后，不改的话旧对话找不到、也续不上。
// 所以导入时：① 按新的起始 cwd 重命名会话目录；② .bridge 里 json / jsonl 的字符串（值和键）凡是旧用户根下的
// 绝对路径，换成新根并把分隔符改成新系统的；嵌在正文里的旧路径也换。用户自己的文件（工作空间、快照桶里
// Claude 写的文件、上传、媒体）一个字节都不动。
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const MANIFEST = 'bridge-users-export.json';
const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const encodeCwd = (p) => String(p).replace(/[^a-zA-Z0-9]/g, '-');

// ── 路径改写 ────────────────────────────────────────────────────────────────
// oldBase / newBase：新旧「用户根」。分隔符两边都认（\ 与 /），Windows 盘符不分大小写。
export function makeRewriter(oldBase, newBase) {
  const segs = String(oldBase).replace(/[\\/]+$/, '').split(/[\\/]+/).filter(Boolean);
  const drive = /^([A-Za-z]):$/.exec(segs[0] || '');
  const tail = segs.slice(drive ? 1 : 0).map(escRe).join('[\\\\/]+');
  // 旧根的几种写法：E:\… / E:/…，以及 Git Bash 里的 /e/…（Windows 上 Bash 命令里常见）
  const head = drive
    ? '(?:' + drive[1] + ':|(?<![\\w.])[\\\\/]' + drive[1] + ')[\\\\/]+'
    : (/^[\\/]/.test(oldBase) ? '[\\\\/]+' : '');
  const prefix = head + tail;
  const nb = String(newBase).replace(/[\\/]+$/, '');
  const sep = nb.includes('/') && !nb.includes('\\') ? '/' : (nb.includes('\\') ? '\\' : '/');
  const whole = new RegExp('^' + prefix + '(?=$|[\\\\/])', 'i');
  // 正文里的：前缀后面跟着的路径段一起换分隔符（段里不含空白与引号之类，遇到就当路径结束）
  // (?![^…])：前缀后面得是分隔符或路径结束，不然「Old Bridge UsersX」这种同前缀的别的目录也会被换掉
  const inText = new RegExp(prefix + '(?![^\\\\/\\s"\'<>|*?`])((?:[\\\\/][^\\\\/\\s"\'<>|*?`]+)*)', 'gi');
  const fixRest = (rest) => rest.replace(/[\\/]+/g, sep);
  const probe = (segs[segs.length - 1] || '').toLowerCase();   // 先粗筛：不含旧根最后一段的字符串直接放过
  const count = (s) => (s.match(new RegExp(prefix, 'gi')) || []).length;
  const str = (s) => {
    if (typeof s !== 'string' || !s || !s.toLowerCase().includes(probe)) return s;
    // 整串就是一条路径（单行、只出现一次旧根）：后面的段可能带空格，整段换分隔符。
    // 多行的工具输出（ls 之类）哪怕以路径开头也走逐个替换，不然只换了第一个、还把后文的反斜杠全翻了。
    if (!/[\r\n\t]/.test(s) && count(s) === 1) {
      const m = whole.exec(s);
      if (m) return nb + fixRest(s.slice(m[0].length));
    }
    return s.replace(inText, (_, rest) => nb + fixRest(rest));
  };
  const value = (v) => {
    if (typeof v === 'string') return str(v);
    if (Array.isArray(v)) return v.map(value);
    if (v && typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) out[str(k)] = value(x);
      return out;
    }
    return v;
  };
  return { str, value };
}

// ── 小工具 ──────────────────────────────────────────────────────────────────
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
function* walkFiles(dir) {
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) yield* walkFiles(p);
    else if (e.isFile()) yield p;
  }
}
// 符号链接 / junction 一律不跟：用户目录里要是有指向外面的链接，别把外面的东西一起搬走
const copyTree = (src, dst, force = false) => cpSync(src, dst, { recursive: true, force, errorOnExist: false, filter: (s) => { try { return !lstatSync(s).isSymbolicLink(); } catch { return false; } } });

// 一份 jsonl：逐行解析改写；没变的行、解析不了的行原样留着（一个字节都不动）
export function rewriteJsonlText(text, rw) {
  return text.split('\n').map((line) => {
    if (!line.trim()) return line;
    try {
      const orig = JSON.parse(line);
      const next = JSON.stringify(rw.value(orig));
      return next === JSON.stringify(orig) ? line : next;
    } catch { return line; }
  }).join('\n');
}

// 会话目录的起始 cwd：目录里任一 jsonl 第一行带 cwd 的那条（会话开头就是在项目目录里）
function firstCwd(dir) {
  let ents; try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return ''; }
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    let text; try { text = readFileSync(path.join(dir, e.name), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes('"cwd"')) continue;
      try { const j = JSON.parse(line); if (typeof j.cwd === 'string' && j.cwd) return j.cwd; } catch {}
    }
  }
  return '';
}

// 一个用户的 .bridge 改写：先按新起始 cwd 重命名会话目录，再改 json / jsonl 里的路径。
// 只动 .bridge 里除 quickchat / uploads / media 以外的 json 与 jsonl——那三处是用户的内容。
export function rewriteUserData(userDir, rw, { candidates = [] } = {}) {
  const sys = path.join(userDir, '.bridge');
  const stats = { renamed: 0, files: 0 };
  const projects = path.join(sys, 'claude', 'projects');
  if (existsSync(projects)) {
    const known = candidates.filter(Boolean);
    for (const d of readdirSync(projects, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const from = path.join(projects, d.name);
      const oldCwd = firstCwd(from) || known.find((c) => encodeCwd(c) === d.name) || '';
      if (!oldCwd) continue;
      const nextName = encodeCwd(rw.str(oldCwd));
      if (nextName === d.name) continue;
      const to = path.join(projects, nextName);
      if (existsSync(to)) {
        for (const e of readdirSync(from)) { const t = path.join(to, e); if (!existsSync(t)) renameSync(path.join(from, e), t); }
      } else renameSync(from, to);
      stats.renamed++;
    }
  }
  const skip = ['quickchat', 'uploads', 'media'].map((n) => path.join(sys, n) + path.sep);
  for (const f of walkFiles(sys)) {
    if (skip.some((s) => f.startsWith(s))) continue;
    const isJsonl = f.endsWith('.jsonl');
    if (!isJsonl && !f.endsWith('.json')) continue;
    let text; try { text = readFileSync(f, 'utf8'); } catch { continue; }
    let next;
    if (isJsonl) next = rewriteJsonlText(text, rw);
    else {
      try {
        const orig = JSON.parse(text.replace(/^\uFEFF/, ''));
        const val = rw.value(orig);
        next = JSON.stringify(val) === JSON.stringify(orig) ? text : JSON.stringify(val, null, 2);
      } catch { continue; }
    }
    if (next !== text) { writeFileSync(f, next); stats.files++; }
  }
  return stats;
}

// ── 导出（旧机器）─────────────────────────────────────────────────────────────
export function exportUsers({ usersRoot, systemDir, out, only = null, log = console.log }) {
  const users = readJson(path.join(systemDir, 'users.json'), {});
  const usage = readJson(path.join(systemDir, 'usage.json'), {});
  const names = Object.keys(users).filter((n) => !only || only.includes(n));
  if (!names.length) throw new Error('没有要导出的账号');
  mkdirSync(path.join(out, 'files'), { recursive: true });
  const list = [];
  for (const n of names) {
    const src = path.join(usersRoot, n);
    if (existsSync(src)) { log(`导出 ${n} …`); copyTree(src, path.join(out, 'files', n)); }
    else log(`导出 ${n}（没有目录，只带账号记录）`);
    list.push({ name: n, record: users[n], usage: usage[n] || null, hasFiles: existsSync(src) });
  }
  const manifest = { version: 1, exportedAt: Date.now(), from: { platform: process.platform, usersRoot }, users: list };
  writeFileSync(path.join(out, MANIFEST), JSON.stringify(manifest, null, 2));
  return manifest;
}

// ── 导入（服务端）───────────────────────────────────────────────────────────
export function importUsers({ usersRoot, systemDir, from, only = null, overwrite = false, log = console.log }) {
  const manifest = readJson(path.join(from, MANIFEST), null);
  if (!manifest || manifest.version !== 1 || !Array.isArray(manifest.users)) throw new Error('不是导出目录（找不到 ' + MANIFEST + '）');
  const rw = makeRewriter(manifest.from.usersRoot, usersRoot);
  const usersFile = path.join(systemDir, 'users.json');
  const usageFile = path.join(systemDir, 'usage.json');
  const users = readJson(usersFile, {});
  const usage = readJson(usageFile, {});
  const done = [];
  mkdirSync(systemDir, { recursive: true });
  for (const u of manifest.users) {
    if (only && !only.includes(u.name)) continue;
    if (users[u.name] && !overwrite) { log(`跳过 ${u.name}：服务端已有同名账号（要覆盖加 --overwrite）`); continue; }
    const dst = path.join(usersRoot, u.name);
    if (u.hasFiles) {
      if (existsSync(dst) && !overwrite) { log(`跳过 ${u.name}：目录 ${dst} 已存在`); continue; }
      log(`导入 ${u.name} …`);
      copyTree(path.join(from, 'files', u.name), dst, overwrite);
      const oldRoot = String(manifest.from.usersRoot).replace(/[\\/]+$/, '') + (manifest.from.platform === 'win32' ? '\\' : '/') + u.name;
      const quick = readJson(path.join(dst, '.bridge', 'claude-quick.json'), {});
      const projs = readJson(path.join(dst, '.bridge', 'claude-projects.json'), {}).projects || [];
      const st = rewriteUserData(dst, rw, { candidates: [oldRoot, quick.path, ...projs.map((p) => p.path)] });
      log(`  会话目录改名 ${st.renamed} 个，改写路径的文件 ${st.files} 个`);
    }
    users[u.name] = { ...u.record, name: u.name };
    if (u.usage) usage[u.name] = u.usage;
    done.push(u.name);
  }
  writeFileSync(usersFile, JSON.stringify(users, null, 2));
  writeFileSync(usageFile, JSON.stringify(usage, null, 2));
  return done;
}

// ── CLI ─────────────────────────────────────────────────────────────────────
async function main(argv) {
  const [cmd, ...rest] = argv;
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : ''; };
  const only = opt('--users') ? opt('--users').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean) : null;
  const { NATIVE_ROOT, SYSTEM_DIR } = await import('./config/index.mjs');
  if (cmd === 'export') {
    const out = opt('--out');
    if (!out) { console.error('用法：users:export -- --out <目录> [--users a,b]'); return 2; }
    if (existsSync(out) && readdirSync(out).length) { console.error(out + ' 不是空目录'); return 2; }
    const m = exportUsers({ usersRoot: NATIVE_ROOT, systemDir: SYSTEM_DIR, out, only });
    console.log(`\n导出了 ${m.users.length} 个账号到 ${out}（${m.users.map((u) => u.name).join('、')}）。整个目录传到服务器上，再在那边跑 users:import。`);
    return 0;
  }
  if (cmd === 'import') {
    const from = opt('--from');
    if (!from) { console.error('用法：users:import -- --from <目录> [--users a,b] [--overwrite]'); return 2; }
    if (!statSync(from).isDirectory()) { console.error(from + ' 不是目录'); return 2; }
    const done = importUsers({ usersRoot: NATIVE_ROOT, systemDir: SYSTEM_DIR, from, only, overwrite: rest.includes('--overwrite') });
    console.log(`\n导入了 ${done.length} 个账号：${done.join('、') || '（无）'}。他们用原来的密码登录即可。`);
    return 0;
  }
  console.error('用法：users:export -- --out <目录> | users:import -- --from <目录>');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(String(e?.message || e)); process.exitCode = 1; });
}
