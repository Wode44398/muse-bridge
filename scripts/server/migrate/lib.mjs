// 迁移工具共用的部分：路径改写（Windows ⇄ Linux、换盘符换目录）、Claude Code 项目目录名换算、
// JSON / JSONL 逐字符串改写、安全拷贝（只增不删、默认不覆盖）。export.mjs / import.mjs 都用它。
//
// 路径改写的规则：一条映射 from=to，字符串【整体】以 from 开头（后面紧跟分隔符或就此结束）才改——
// 例如 D:\Notes=/srv/vault 把 "D:\\Notes\\bridge build\\x.md" 改成 "/srv/vault/bridge build/x.md"。
// from 是 Windows 风格时大小写不敏感、正反斜杠都认；剩余部分的分隔符跟着 to 的风格走。
// 句子中间夹带的路径（工具输出、命令行）不动——那些只用于显示，改了反而可能误伤。

import { existsSync, statSync, readdirSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

const isWinStyle = (p) => /^[a-zA-Z]:[\\/]/.test(p) || p.startsWith('\\\\');
const styleOf = (p) => (isWinStyle(p) || (p.includes('\\') && !p.includes('/')) ? 'win' : 'posix');

/** 把 "旧前缀=新前缀" 解析成映射；按旧前缀长度从长到短排，长的先匹配（子目录映射优先于父目录）。 */
export function parseMaps(list = []) {
  const maps = [];
  for (const raw of list) {
    const i = String(raw).indexOf('=');
    if (i <= 0) throw new Error('映射要写成 旧前缀=新前缀：' + raw);
    const from = String(raw).slice(0, i).trim().replace(/[\\/]+$/, '');
    const to = String(raw).slice(i + 1).trim().replace(/[\\/]+$/, '') || '/';
    if (!from) throw new Error('映射缺旧前缀：' + raw);
    maps.push({ from, to, win: styleOf(from) === 'win', toStyle: styleOf(to) });
  }
  return maps.sort((a, b) => b.from.length - a.from.length);
}

const norm = (p, win) => (win ? p.replace(/\//g, '\\').toLowerCase() : p);

/** 按映射改一个路径字符串；不匹配原样返回。 */
export function rewritePath(s, maps) {
  if (typeof s !== 'string' || s.length < 2 || s.length > 4096) return s;
  for (const m of maps) {
    const head = s.slice(0, m.from.length);
    if (norm(head, m.win) !== norm(m.from, m.win)) continue;
    const rest = s.slice(m.from.length);
    if (rest && !/^[\\/]/.test(rest)) continue;          // D:\NotesX 不算 D:\Notes 的子路径
    const sep = m.toStyle === 'win' ? '\\' : '/';
    const tail = rest.replace(/[\\/]+/g, sep);
    if (m.to === '/' && tail) return tail;
    return m.to + tail;
  }
  return s;
}

/** 深度遍历 JSON 值，改写所有路径字符串（对象键不改）。返回 { value, changed }。 */
export function rewriteJsonValue(v, maps) {
  let changed = 0;
  const walk = (x) => {
    if (typeof x === 'string') { const y = rewritePath(x, maps); if (y !== x) changed++; return y; }
    if (Array.isArray(x)) return x.map(walk);
    if (x && typeof x === 'object') { const o = {}; for (const [k, val] of Object.entries(x)) o[k] = walk(val); return o; }
    return x;
  };
  const value = walk(v);
  return { value, changed };
}

/** 改写一个 .json 文件（保持原缩进风格：有换行就按 2 空格）。返回改了几处；解析失败返回 -1 不动文件。 */
export function rewriteJsonFile(file, maps, { dryRun = false } = {}) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return -1; }
  const bom = raw.charCodeAt(0) === 0xfeff;
  let data;
  try { data = JSON.parse(bom ? raw.slice(1) : raw); } catch { return -1; }
  const { value, changed } = rewriteJsonValue(data, maps);
  if (changed && !dryRun) {
    const pretty = /\n/.test(raw.slice(0, 2000));
    writeFileSync(file, (bom ? '\uFEFF' : '') + JSON.stringify(value, null, pretty ? 2 : 0) + (raw.endsWith('\n') ? '\n' : ''));
  }
  return changed;
}

/** 改写一个 .jsonl 文件（逐行；解析不了的行原样保留）。返回改了几处。 */
export function rewriteJsonlFile(file, maps, { dryRun = false } = {}) {
  let raw;
  try { raw = readFileSync(file, 'utf8'); } catch { return -1; }
  let changed = 0;
  const lines = raw.split('\n').map((line) => {
    if (!line.trim()) return line;
    const cr = line.endsWith('\r');
    const body = cr ? line.slice(0, -1) : line;
    let obj;
    try { obj = JSON.parse(body); } catch { return line; }
    const r = rewriteJsonValue(obj, maps);
    if (!r.changed) return line;
    changed += r.changed;
    return JSON.stringify(r.value) + (cr ? '\r' : '');
  });
  if (changed && !dryRun) writeFileSync(file, lines.join('\n'));
  return changed;
}

// Claude Code 把会话记录放在 ~/.claude/projects/<目录名>/，目录名 = 会话 cwd 里非字母数字的字符全换成 '-'。
// 换机器后 cwd 变了，目录名也得跟着换，--resume 才找得到。
export const claudeProjectSlug = (cwd) => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');

/** 从一个项目目录里的会话记录读出原来的 cwd（第一条带 cwd 的记录）。 */
export function projectCwd(dir) {
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    let raw;
    try { raw = readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n').slice(0, 200)) {
      if (!line.includes('"cwd"')) continue;
      try { const o = JSON.parse(line); if (typeof o.cwd === 'string' && o.cwd) return o.cwd; } catch {}
    }
  }
  return '';
}

/**
 * 只增不删的递归拷贝。目标已有同名文件：默认跳过并计入 conflicts（--force 才覆盖）。
 * skip(相对路径, 是否目录) 返回 true 的条目不拷；onFile(目标文件) 每拷（或演练里「会拷」）一个文件回调一次。
 * 返回 { files, bytes, skipped, conflicts:[] }。
 */
export function copyTree(src, dst, { skip = () => false, force = false, dryRun = false, rel = '', onFile = null } = {}) {
  const out = { files: 0, bytes: 0, skipped: 0, conflicts: [] };
  const st = statSync(src);
  if (st.isFile()) {
    if (existsSync(dst) && !force) { out.conflicts.push(dst); return out; }
    if (!dryRun) { mkdirSync(path.dirname(dst), { recursive: true }); copyFileSync(src, dst); }
    out.files++; out.bytes += st.size;
    if (onFile) onFile(dst, src);
    return out;
  }
  if (!st.isDirectory()) return out;
  if (!dryRun) mkdirSync(dst, { recursive: true });
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    const r = rel ? rel + '/' + ent.name : ent.name;
    if (ent.isSymbolicLink()) { out.skipped++; continue; }
    if (skip(r, ent.isDirectory())) { out.skipped++; continue; }
    const sub = copyTree(path.join(src, ent.name), path.join(dst, ent.name), { skip, force, dryRun, rel: r, onFile });
    out.files += sub.files; out.bytes += sub.bytes; out.skipped += sub.skipped; out.conflicts.push(...sub.conflicts);
  }
  return out;
}

/** 把源目录搬到目标目录：目标不存在就整体改名；存在就逐文件合并（不覆盖），合并完源目录留着由人确认后再删。 */
export function moveOrMergeDir(src, dst, { dryRun = false } = {}) {
  if (!existsSync(dst)) {
    if (!dryRun) { mkdirSync(path.dirname(dst), { recursive: true }); renameSync(src, dst); }
    return { moved: true, conflicts: [] };
  }
  const r = copyTree(src, dst, { dryRun });
  return { moved: false, merged: r.files, conflicts: r.conflicts };
}

export const fmtBytes = (n) => (n >= 1 << 30 ? (n / (1 << 30)).toFixed(1) + ' GB' : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB');

/** 简易参数解析：--k v / --flag / 可重复的 --map。 */
export function parseArgs(argv, { repeat = ['map'], flags = [] } = {}) {
  const out = {};
  for (const k of repeat) out[k] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const k = a.slice(2);
    if (flags.includes(k)) { out[k] = true; continue; }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { out[k] = true; continue; }
    i++;
    if (repeat.includes(k)) out[k].push(v); else out[k] = v;
  }
  return out;
}
