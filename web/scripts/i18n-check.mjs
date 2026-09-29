#!/usr/bin/env node
// 界面多语言体检（见 web/src/lib/i18n.js 的约定）。用真解析器（svelte/compiler、acorn）走 AST，不靠正则猜：
//
//   node web/scripts/i18n-check.mjs                    全量：web/src + harness/web/src
//   node web/scripts/i18n-check.mjs <文件或目录…>       只查这些（路径相对仓库根或绝对路径均可）
//   选项：--summary   只出每个文件的未包裹条数（排序）      --json   机器可读
//         --compile   顺带用 svelte 编译器编译 .svelte / .svelte.js（抓语法与 rune 错误）
//         --dict      只查字典（冲突 / 占位符 / 风格）
//
// 报告五类：
//   LEFTOVER  界面可见位置的中文没包 t()：模板文本、静态属性值、JS 字符串 / 模板字符串
//   MISSING   t('…') / tc('…','…') 的字面键在对应英文字典里没有（web → web/src/i18n/en，harness → harness/web/src/i18n/en）
//   DYNAMIC   t() 的键不是纯字面量（含 ${} 或变量）——静态检查不到，改成 t('… {x} …', { x })；运行时文案用 tr()
//   DICT      同键跨文件译法冲突、占位符集合不一致、英文值里夹中文、直引号撇号 / 三个点等风格问题
//   PARSE     文件解析失败
//
// 豁免：行内出现 i18n-ignore（任何注释形式）即跳过该行；文件里出现 i18n-ignore-file 跳过整个文件（只给开发专用页用）。
// 自动跳过：注释、<style>、console.*() 的参数、import 路径、正则字面量、TS 类型里的字面量。
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, resolve, relative, extname, dirname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const req = createRequire(join(ROOT, 'web', 'package.json'));
// createRequire 解析到的是 CJS 入口，动态 import 后要从 default 上取
const unwrap = (m) => (m.parse ? m : m.default);
const { parse: svelteParse, compile: svelteCompile, compileModule } = unwrap(await import(pathToFileURL(req.resolve('svelte/compiler')).href));
const acorn = unwrap(await import(pathToFileURL(req.resolve('acorn')).href));

const WEB_SRC = join(ROOT, 'web', 'src');
const HX_SRC = join(ROOT, 'harness', 'web', 'src');
const WEB_DICT = join(WEB_SRC, 'i18n', 'en');
const HX_DICT = join(HX_SRC, 'i18n', 'en');

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const targets = args.filter((a) => !a.startsWith('--'));
const CJK = /[㐀-鿿豈-﫿]/;
// tt = 文件里已有局部变量叫 t 时的导入别名：import { t as tt } from '…/i18n.js'
const T_FUNCS = new Set(['t', 'tt', 'tr', 'T', 'TR']);

// ——— 文件枚举 ———
const EXT = new Set(['.svelte', '.js', '.ts', '.mjs']);
function walkDir(d, out) {
  for (const name of readdirSync(d)) {
    if (name === 'node_modules' || name.startsWith('_legacy') || name === 'dist') continue;
    const p = join(d, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (p === WEB_DICT || p === HX_DICT) continue;
      walkDir(p, out);
    } else if (EXT.has(extname(name)) && !/\.d\.ts$/.test(name) && !/\.test\.(js|ts|mjs)$/.test(name)) out.push(p);
  }
  return out;
}
function listTargets() {
  if (!targets.length) return [...walkDir(WEB_SRC, []), ...walkDir(HX_SRC, [])];
  const out = [];
  for (const tg of targets) {
    const p = resolve(existsSync(resolve(tg)) ? resolve(tg) : join(ROOT, tg));
    if (!existsSync(p)) { console.error('不存在：' + tg); continue; }
    if (statSync(p).isDirectory()) walkDir(p, out); else out.push(p);
  }
  return out;
}
const isHx = (f) => f.startsWith(HX_SRC + sep) || f === HX_SRC;

// ——— 行号 ———
function lineIndex(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) starts.push(i + 1);
  return (off) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= off) lo = mid; else hi = mid - 1; }
    return { line: lo + 1, col: off - starts[lo] + 1, text: src.slice(starts[lo], (starts[lo + 1] ?? src.length + 1) - 1) };
  };
}

// ——— AST 通用遍历（estree + svelte AST 都是 {type} 对象树）———
const SKIP_KEYS = new Set(['parent', 'loc', 'range', 'metadata', 'leadingComments', 'trailingComments', 'comments']);
function walk(node, parents, visit) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, parents, visit); return; }
  if (typeof node.type !== 'string') return;
  if (visit(node, parents) === false) return;
  parents.push(node);
  for (const k of Object.keys(node)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = node[k];
    if (v && typeof v === 'object') walk(v, parents, visit);
  }
  parents.pop();
}

const calleeName = (c) => c?.type === 'Identifier' ? c.name
  : (c?.type === 'MemberExpression' && !c.computed && c.property?.type === 'Identifier' ? c.property.name : null);
const isConsole = (c) => c?.type === 'MemberExpression' && c.object?.type === 'Identifier' && c.object.name === 'console';

// 字面量 node 的「包裹状态」：wrapped / ignored / leftover，以及是否是 t() 的键
function classify(node, parents) {
  let child = node;
  for (let i = parents.length - 1; i >= 0; i--) {
    const p = parents[i];
    if (p.type && p.type.startsWith('TS') && p.type !== 'TSAsExpression' && p.type !== 'TSNonNullExpression' && p.type !== 'TSSatisfiesExpression') return { st: 'ignored' };
    if (p.type === 'ImportDeclaration' || p.type === 'ExportNamedDeclaration' && p.source === child || p.type === 'ExportAllDeclaration' || p.type === 'ImportExpression') return { st: 'ignored' };
    if (p.type === 'CallExpression' || p.type === 'NewExpression') {
      if (isConsole(p.callee)) return { st: 'ignored' };
      const name = calleeName(p.callee);
      const idx = p.arguments.indexOf(child);
      if (idx >= 0) {
        if (T_FUNCS.has(name) && idx === 0) return { st: 'wrapped', fn: name, call: p, direct: child === node };
        if (name === 'tc' && (idx === 0 || idx === 1)) return { st: 'wrapped', fn: 'tc', call: p, direct: child === node, ctxArg: idx === 0 };
        if (T_FUNCS.has(name) || name === 'tc') return { st: 'wrapped', fn: name, call: p, param: true };
      }
      return { st: 'leftover' };
    }
    if (p.type === 'Property' && p.key === child && !p.computed) return { st: 'key' };
    // 走到语句 / 函数边界就停：字面量不在任何 t() 里
    if (/Statement$|Declaration$|^Program$|Function|^ArrowFunctionExpression$|^ExpressionTag$|^Attribute$/.test(p.type)) return { st: 'leftover' };
    child = p;
  }
  return { st: 'leftover' };
}

// ——— 单文件扫描 ———
const results = [];   // { file, kind, line, col, text, msg }
const tKeys = [];     // { file, key, ctx, line, hx }
function add(file, kind, off, lineOf, text, msg) {
  const { line, col, text: lineText } = lineOf(off);
  if (kind !== 'MISSING' && kind !== 'DICT' && /i18n-ignore/.test(lineText)) return;
  results.push({ file, kind, line, col, text: (text || '').replace(/\s+/g, ' ').slice(0, 90), msg });
}

// 遮蔽检查：文件导入了 i18n 的 t/tc/tr，又在某个作用域里声明了同名局部变量 / 参数 / each 别名——
// 该作用域里的 t('…') 会调到局部变量上（运行时报 t is not a function 或静默出错）
let SHADOWED = new Set();   // 本文件从 i18n 导入的本地名（t / tc / tr，或别名 tt）
let curImportsI18n = false;
function patternNames(p, out = []) {
  if (!p || typeof p !== 'object') return out;
  if (p.type === 'Identifier') out.push(p);
  else if (p.type === 'ObjectPattern') for (const q of p.properties) patternNames(q.type === 'RestElement' ? q.argument : q.value, out);
  else if (p.type === 'ArrayPattern') for (const q of p.elements) patternNames(q, out);
  else if (p.type === 'RestElement') patternNames(p.argument, out);
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
  else if (p.type === 'TSParameterProperty') patternNames(p.parameter, out);
  return out;
}
function checkShadow(file, n, lineOf, base) {
  if (!curImportsI18n) return;
  let pats = [];
  if (n.type === 'VariableDeclarator') pats = [n.id];
  else if (/Function/.test(n.type) && Array.isArray(n.params)) pats = n.params;
  else if (n.type === 'CatchClause') pats = [n.param];
  else if (n.type === 'EachBlock') pats = [n.context];
  else if (n.type === 'SnippetBlock') pats = n.parameters || [];
  else if (n.type === 'AwaitBlock') pats = [n.value, n.error];
  for (const p of pats) for (const id of patternNames(p)) if (SHADOWED.has(id.name))
    add(file, 'SHADOW', base + id.start, lineOf, id.name, `局部变量/参数 ${id.name} 遮住了 i18n 的 ${id.name}()，改个名字（该作用域里的 ${id.name}('…') 会调错）`);
  if (n.type === 'EachBlock' && SHADOWED.has(n.index)) add(file, 'SHADOW', n.start, lineOf, n.index, `each 下标 ${n.index} 遮住了 i18n 的 ${n.index}()`);
}

function scanJsAst(file, program, lineOf, base = 0, onlyInside = null) {
  walk(program, [], (n, parents) => {
    checkShadow(file, n, lineOf, base);
    if (n.type === 'Literal' && typeof n.value === 'string') {
      if (n.regex) return;
      if (!CJK.test(n.value)) return;
      const c = classify(n, parents);
      const off = base + n.start;
      if (c.st === 'ignored' || c.st === 'key' && /[㐀-鿿]/.test(n.value) && false) return;
      if (c.st === 'key') { add(file, 'LEFTOVER', off, lineOf, n.value, '中文对象键'); return; }
      if (c.st === 'leftover') { add(file, 'LEFTOVER', off, lineOf, n.value, '字符串'); return; }
      if (c.st === 'wrapped' && c.direct && !c.param && !c.ctxArg) {
        let ctx = null;
        if (c.fn === 'tc') { const a0 = c.call.arguments[0]; ctx = a0?.type === 'Literal' ? a0.value : '?'; }
        if (c.fn === 't' || c.fn === 'tt' || c.fn === 'tc' || c.fn === 'T') tKeys.push({ file, key: n.value, ctx, line: lineOf(off).line, hx: isHx(file) });
      }
      return;
    }
    if (n.type === 'Literal' && n.regex) return false;
    if (n.type === 'TemplateLiteral') {
      const has = n.quasis.some((q) => CJK.test(q.value.cooked ?? q.value.raw));
      if (!has) return;
      const c = classify(n, parents);
      const off = base + n.start;
      const text = n.quasis.map((q) => q.value.cooked ?? q.value.raw).join('${…}');
      if (c.st === 'ignored') return false;
      if (c.st === 'wrapped' && c.direct && !c.param && !c.ctxArg) {
        if (n.expressions.length) add(file, 'DYNAMIC', off, lineOf, text, 't() 的键含 ${}，改用 {占位} + 参数');
        else if (c.fn !== 'tr') tKeys.push({ file, key: n.quasis[0].value.cooked, ctx: null, line: lineOf(off).line, hx: isHx(file) });
        return;
      }
      if (c.st === 'wrapped') return;
      add(file, 'LEFTOVER', off, lineOf, text, '模板字符串');
      return;   // 继续走进 expressions
    }
    if (n.type === 'CallExpression' && T_FUNCS.has(calleeName(n.callee)) && calleeName(n.callee) !== 'tr' && calleeName(n.callee) !== 'TR') {
      const a0 = n.arguments[0];
      if (a0 && a0.type !== 'Literal' && a0.type !== 'TemplateLiteral') add(file, 'DYNAMIC', base + n.start, lineOf, '', `${calleeName(n.callee)}() 的键不是字面量（静态查不到；运行时文案请用 tr()）`);
    }
  });
}

function scanSvelte(file, src, lineOf) {
  let ast;
  try { ast = svelteParse(src, { modern: true, filename: file }); }
  catch (e) { add(file, 'PARSE', e.position?.[0] ?? e.start?.character ?? 0, lineOf, '', e.message); return; }
  for (const s of [ast.module, ast.instance]) if (s?.content) scanJsAst(file, s.content, lineOf);
  walk(ast.fragment, [], (n, parents) => {
    if (n.type === 'Comment') return false;
    if (n.type === 'EachBlock' || n.type === 'SnippetBlock' || n.type === 'AwaitBlock') checkShadow(file, n, lineOf, 0);
    if (n.type === 'Text') {
      if (process.env.I18N_DEBUG) console.log('TEXT', n.start, JSON.stringify(n.data.slice(0, 20)));
      if (!CJK.test(n.data)) return;
      const parent = parents[parents.length - 1];
      const inAttr = parents.some((p) => p.type === 'Attribute' || p.type === 'StyleDirective');
      add(file, 'LEFTOVER', n.start, lineOf, n.data, inAttr ? '静态属性值' : '模板文本');
      return;
    }
    // 表达式：交给 JS 规则（svelte AST 里 expression 已是 estree，偏移是全文件偏移）
    const exprs = [];
    for (const k of ['expression', 'test', 'declaration', 'context', 'key', 'parameters']) if (n[k] && typeof n[k] === 'object') exprs.push(n[k]);
    if (exprs.length) {
      for (const e of exprs) scanJsAst(file, Array.isArray(e) ? { type: 'Program', body: e } : { type: 'Program', body: [{ type: 'ExpressionStatement', expression: e }] }, lineOf, 0);
    }
    if (n.type === 'ExpressionTag' || n.type === 'HtmlTag' || n.type === 'RenderTag' || n.type === 'ConstTag') return false;
  });
  if (flag('--compile')) {
    try { svelteCompile(src, { filename: file, generate: 'client' }); }
    catch (e) { add(file, 'PARSE', e.position?.[0] ?? 0, lineOf, '', 'svelte 编译失败：' + e.message); }
  }
}

function scanScript(file, src, lineOf) {
  const ts = file.endsWith('.ts');
  let program;
  if (ts) {
    // TS：借 svelte 解析器里的 acorn-typescript（包成 module 脚本），偏移减掉前缀
    const pre = '<script module lang="ts">\n';
    const safe = src.replace(/<\/script/gi, '<\\/script');
    try {
      const ast = svelteParse(pre + safe + '\n</script>', { modern: true, filename: file + '.svelte' });
      const shifted = (o) => o - pre.length;
      scanJsAst(file, ast.module.content, (o) => lineOf(Math.max(0, shifted(o))), 0);
    } catch (e) { add(file, 'PARSE', Math.max(0, (e.position?.[0] ?? pre.length) - pre.length), lineOf, '', e.message); }
    // .svelte.ts 的 rune 检查要先剥类型（vite 插件做的事），这里不编译；类型与 rune 交给 harness/web 的 svelte-check
    return;
  }
  try { program = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'module', allowHashBang: true, allowAwaitOutsideFunction: true }); }
  catch (e) { add(file, 'PARSE', e.pos ?? 0, lineOf, '', e.message); return; }
  scanJsAst(file, program, lineOf);
  if (flag('--compile') && /\.svelte\.js$/.test(file)) {
    try { compileModule(src, { filename: file }); } catch (e) { add(file, 'PARSE', e.position?.[0] ?? 0, lineOf, '', 'svelte 模块编译失败：' + e.message); }
  }
}

function scanFile(file) {
  const src = readFileSync(file, 'utf8');
  if (/i18n-ignore-file/.test(src)) return;
  SHADOWED = new Set();
  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*\/i18n(?:\.js|\.ts)?['"]/g))
    for (const part of m[1].split(',')) { const nm = part.trim().split(/\s+as\s+/).pop()?.trim(); if (nm && /^(t|tt|tc|tr)$/.test(nm) || /\bas\s+\w+$/.test(part.trim()) && /^\s*(t|tc|tr)\s+as/.test(part)) SHADOWED.add(nm); }
  curImportsI18n = SHADOWED.size > 0;
  const lineOf = lineIndex(src);
  if (file.endsWith('.svelte')) scanSvelte(file, src, lineOf); else scanScript(file, src, lineOf);
}

// ——— 字典 ———
async function loadDict(dir) {
  const map = new Map();   // key → [{ file, val }]
  if (!existsSync(dir)) return map;
  for (const name of readdirSync(dir).sort()) {
    if (!/\.(js|ts)$/.test(name) || /^index\.(js|ts)$/.test(name)) continue;
    const p = join(dir, name);
    let mod;
    try { mod = await import(pathToFileURL(p).href + '?t=' + Date.now()); }
    catch (e) { results.push({ file: p, kind: 'PARSE', line: 0, col: 0, text: '', msg: '字典加载失败：' + e.message }); continue; }
    const d = mod.default || {};
    for (const [k, v] of Object.entries(d)) {
      if (!map.has(k)) map.set(k, []);
      map.get(k).push({ file: p, val: v });
    }
  }
  return map;
}
const ph = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');
function dictLines(file) {
  try { return readFileSync(file, 'utf8').split('\n'); } catch { return []; }
}
function checkDict(map) {
  const cache = new Map();
  const where = (file, key) => {
    if (!cache.has(file)) cache.set(file, dictLines(file));
    const i = cache.get(file).findIndex((l) => l.includes(JSON.stringify(key).slice(1, -1)) || l.includes(key));
    return i + 1;
  };
  for (const [k, arr] of map) {
    const vals = arr.map((a) => JSON.stringify(a.val));
    if (new Set(vals).size > 1) {
      results.push({ file: arr[0].file, kind: 'DICT', line: where(arr[0].file, k), col: 1, text: k,
        msg: '译法冲突：' + arr.map((a) => `${relative(ROOT, a.file)} → ${JSON.stringify(a.val)}`).join(' ｜ ') });
    }
    const { file, val } = arr[0];
    const forms = typeof val === 'string' ? [val] : (val && typeof val === 'object' ? Object.values(val) : [val]);
    const keyPh = ph(k.includes('::') ? k.slice(k.indexOf('::') + 2) : k);
    for (const f of forms) {
      if (typeof f !== 'string' || !f.trim()) { results.push({ file, kind: 'DICT', line: where(file, k), col: 1, text: k, msg: '英文为空或不是字符串' }); continue; }
      const fPh = ph(f);
      // 复数形式允许省略 {n}（如 one: 'One file'）
      if (fPh !== keyPh && !(typeof val === 'object' && fPh.split(',').filter(Boolean).every((x) => keyPh.split(',').includes(x))))
        results.push({ file, kind: 'DICT', line: where(file, k), col: 1, text: k, msg: `占位符不一致：键 {${keyPh}} ≠ 英文 {${fPh}}：${f}` });
      if (CJK.test(f) && !/i18n-cjk-ok/.test(f)) results.push({ file, kind: 'DICT', line: where(file, k), col: 1, text: k, msg: '英文值里夹中文：' + f });
      if (/[A-Za-z]'[A-Za-z]/.test(f)) results.push({ file, kind: 'STYLE', line: where(file, k), col: 1, text: k, msg: '撇号请用 ’：' + f });
      if (/\.\.\./.test(f)) results.push({ file, kind: 'STYLE', line: where(file, k), col: 1, text: k, msg: '省略号请用 …：' + f });
      if (/[「」『』：；，。！？（）]/.test(f)) results.push({ file, kind: 'STYLE', line: where(file, k), col: 1, text: k, msg: '英文里有中文标点：' + f });
    }
  }
}

// ——— 主流程 ———
const files = flag('--dict') ? [] : listTargets();
for (const f of files) scanFile(f);

const webDict = await loadDict(WEB_DICT);
const hxDict = await loadDict(HX_DICT);
if (!targets.length || flag('--dict')) { checkDict(webDict); checkDict(hxDict); }
else {
  // 只查部分文件时，字典只查这些文件用到的键 + 全部冲突（冲突便宜，且跨批次最容易出）
  checkDict(new Map([...webDict].filter(([, a]) => new Set(a.map((x) => JSON.stringify(x.val))).size > 1)));
  checkDict(new Map([...hxDict].filter(([, a]) => new Set(a.map((x) => JSON.stringify(x.val))).size > 1)));
}
for (const k of tKeys) {
  const map = k.hx ? hxDict : webDict;
  const full = k.ctx ? k.ctx + '::' + k.key : k.key;
  if (!map.has(full) && !map.has(k.key)) results.push({ file: k.file, kind: 'MISSING', line: k.line, col: 1, text: full, msg: `英文字典（${k.hx ? 'harness/web/src/i18n/en' : 'web/src/i18n/en'}）里没有这个键` });
  else if (targets.length) {
    const arr = map.get(full) || map.get(k.key);
    const f = arr[0].val;
    const forms = typeof f === 'string' ? [f] : Object.values(f || {});
    for (const x of forms) if (typeof x === 'string' && ph(x) !== ph(k.key) && typeof f === 'string')
      results.push({ file: k.file, kind: 'DICT', line: k.line, col: 1, text: k.key, msg: `占位符不一致：${x}` });
  }
}

const rel = (f) => relative(ROOT, f).split(sep).join('/');
if (flag('--json')) {
  console.log(JSON.stringify({ files: files.length, keys: tKeys.length, results: results.map((r) => ({ ...r, file: rel(r.file) })) }, null, 1));
} else if (flag('--summary')) {
  const by = new Map();
  for (const r of results) if (r.kind === 'LEFTOVER') by.set(r.file, (by.get(r.file) || 0) + 1);
  const rows = [...by].sort((a, b) => b[1] - a[1]);
  for (const [f, n] of rows) console.log(String(n).padStart(5) + '  ' + rel(f));
  for (const r of results) if (r.kind === 'PARSE' || r.kind === 'SHADOW') console.log(`${r.kind.padEnd(8)} ${rel(r.file)}:${r.line}  ${r.msg}`);
  const cnt = (k) => results.filter((r) => r.kind === k).length;
  console.log(`\n共 ${rows.reduce((s, r) => s + r[1], 0)} 处未包裹，${rows.length} 个文件；已包裹键 ${tKeys.length} 个｜MISSING ${cnt('MISSING')}｜DYNAMIC ${cnt('DYNAMIC')}｜SHADOW ${cnt('SHADOW')}｜DICT ${cnt('DICT')}｜PARSE ${cnt('PARSE')}`);
} else {
  const order = ['PARSE', 'SHADOW', 'DICT', 'MISSING', 'DYNAMIC', 'LEFTOVER', 'STYLE'];
  results.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.file.localeCompare(b.file) || a.line - b.line);
  for (const r of results) console.log(`${r.kind.padEnd(8)} ${rel(r.file)}:${r.line}:${r.col}  ${r.msg ? r.msg + '  ' : ''}${r.text ? JSON.stringify(r.text) : ''}`);
  const cnt = (k) => results.filter((r) => r.kind === k).length;
  console.log(`\n文件 ${files.length}｜已包裹键 ${tKeys.length}｜LEFTOVER ${cnt('LEFTOVER')}｜MISSING ${cnt('MISSING')}｜DYNAMIC ${cnt('DYNAMIC')}｜SHADOW ${cnt('SHADOW')}｜DICT ${cnt('DICT')}｜STYLE ${cnt('STYLE')}｜PARSE ${cnt('PARSE')}`);
}
process.exitCode = results.some((r) => ['PARSE', 'SHADOW', 'DICT', 'MISSING'].includes(r.kind)) ? 1 : 0;
