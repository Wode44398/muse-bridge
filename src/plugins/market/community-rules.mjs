// 社区插件的自动检查规则。社区市场不做人工审核，这里就是唯一的门：bridge「发布到社区」前的本地预检、
// 市场仓库 CI（scripts/community-rules.mjs 由 scripts/sync-rules.mjs 从这里原样拷过去）用的是同一份，两边结论必须一致。
// 纯函数、零依赖：CI 在 ubuntu 上直接 node 跑，不 npm install。
//
// 拦什么、为什么：
//   · 服务端代码要能读（不许压缩 / 混淆 / 内嵌大段编码数据）——没有人审，至少让装的人和举报的人看得懂；
//   · 不许动态执行（eval、new Function、vm、非字面量 import / require、createRequire、WebAssembly……）——
//     否则过了检查再从网上拉代码执行，钉死的 sha256 就没意义了；
//   · id 先到先得、绑 GitHub 账号，保留名不给占；不许 replaces（不能接管 bridge 自带入口，防冒充）。
// 只标不拦的「能力」（caps）给安装者看：运行外部程序、访问网络、读写文件、读环境变量、引用 bridge 内部模块。

export const RULES_VERSION = 1;
export const LIMITS = Object.freeze({ files: 300, fileBytes: 2 * 1024 * 1024, totalBytes: 8 * 1024 * 1024, pathLen: 200 });
export const ALLOWED_EXT = Object.freeze(['mjs', 'js', 'cjs', 'json', 'md', 'txt', 'html', 'css', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'woff', 'woff2', 'ttf', 'otf']);
export const CAPS = Object.freeze(['process', 'network', 'files', 'env', 'core']);
export const CAP_LABELS = Object.freeze({
  process: '运行外部程序',
  network: '访问网络',
  files: '读写服务器上的文件',
  env: '读环境变量（可能含密钥）',
  core: '调用 bridge 内部模块',
});
export const RESERVED_PREFIXES = Object.freeze(['bridge-', 'official-']);
export const MANIFEST = 'bridge-plugin.json';
export const MARKET_FILE = 'market.json';

const ID_RE = /^[a-z][a-z0-9-]{0,47}$/;
const VER_RE = /^\d+\.\d+\.\d+$/;
const CODE_EXT = new Set(['mjs', 'js', 'cjs']);
const ALLOWED = new Set(ALLOWED_EXT);

// 发布时从作者本机目录里略过的东西（不进提交、不进包）。CI 那边 PR 目录里出现这些会被下面的路径规则拦下。
export function skipForPublish(rel) {
  const segs = String(rel).split('/');
  if (segs.some((s) => s.startsWith('.') || s === 'node_modules')) return true;
  if (segs.length > 1 && (segs[0] === 'test' || segs[0] === 'tests')) return true;
  const base = segs[segs.length - 1];
  return base === MARKET_FILE || /\.test\.(mjs|js|cjs)$/.test(base) || /\.log$/i.test(base);
}

// ── 版本 ────────────────────────────────────────────────────────────────
const parseVer = (v) => {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?\s*$/.exec(String(v));
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
};
export function compareVersions(a, b) {
  const x = parseVer(a), y = parseVer(b);
  if (!x || !y) return NaN;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}
// engines.bridge 的写法：「>=6.74 <7」「^8.1」「>=8 || ~7.9」「*」
export function validRange(r) {
  const s = String(r || '').trim();
  if (!s) return false;
  return s.split('||').every((alt) => {
    const conds = alt.trim().split(/\s+/).filter(Boolean);
    return conds.length > 0 && conds.every((c) => c === '*' || c === 'x' || /^(>=|<=|>|<|=|\^|~)?v?\d+(\.\d+){0,2}$/.test(c));
  });
}

// ── 小工具 ──────────────────────────────────────────────────────────────
const extOf = (p) => { const b = p.split('/').pop(); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };
const lower = (s) => String(s || '').toLowerCase();
const text = (buf) => {
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf ?? '');
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
};
const parseJson = (buf) => { try { return { v: JSON.parse(text(buf)) }; } catch (e) { return { err: String(e?.message || e) }; } };
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const lineAt = (src, idx) => { let n = 1; for (let i = 0; i < idx && i < src.length; i++) if (src.charCodeAt(i) === 10) n++; return n; };

// 动态 import / require 的参数是不是字面量：'x'、"x"、不带 ${} 的 `x`
function literalArg(src, at) {
  let i = at;
  while (i < src.length && /\s/.test(src[i])) i++;
  const q = src[i];
  if (q === "'" || q === '"') return true;
  if (q === '`') {
    const end = src.indexOf('`', i + 1);
    return end > 0 && !src.slice(i + 1, end).includes('${');
  }
  return false;
}

// 按「被引用的模块名」匹配（from 'x'、import('x')、require('x')、import 'x'），别把普通字符串 'vm'、'https' 当成引用
const mod = (names) => new RegExp(String.raw`(?:\bfrom\s*|(?<![\w$.])(?:import|require)\s*\(\s*|^\s*import\s+)(['"])(?:node:)?(?:${names})(?:\/[\w/]*)?\1`, 'gm');

// 服务端代码里一律不许出现的写法（命中即不通过）
// 静态规则拦不全所有花样，这里按「原文里出现这个名字就拦」来写，宁可误伤：
//   · 扫原文、不先剥注释——剥注释要先认出字符串和正则字面量，认错一处（return /'/ 之类）就能把真代码当成注释藏过去；
//   · eval / Function 连属性写法一起拦（globalThis.eval、const e = eval 转手）；注释里的类型写成 {function}；
//   · 取 constructor（(()=>{}).constructor('…') 能造出 Function）、计算属性访问全局对象（globalThis['ev'+'al']）；
//   · node:module（register 钩子能加载任意代码）、从 data: / http(s): / blob: 地址 import。
const FORBIDDEN = [
  { re: /(?<![\w$])eval(?![\w$])/g, msg: '不许出现 eval（注释里也别写这个词）' },
  { re: /(?<![\w$])Function(?![\w$])/g, msg: '不许出现 Function（构造函数能拼代码执行；注释里的类型写成 {function}）' },
  { re: /\.\s*constructor(?![\w$])|\[\s*['"`]constructor['"`]\s*\]/g, msg: '不许取 constructor（可以借它造出 Function）' },
  { re: /(?<![\w$.])(globalThis|global|self|window)\s*\[/g, msg: '不许用计算属性访问全局对象' },
  { re: /(?:\bfrom\s*|(?<![\w$])import\s*\(\s*)['"`](?:data|https?|blob):/g, msg: '不许从 data: / http(s): / blob: 地址加载模块' },
  { re: /\bmainModule\b/g, msg: '不许用 process.mainModule' },
  { re: mod('vm'), msg: '不许用 vm 模块' },
  { re: mod('module'), msg: '不许用 module 模块（register 钩子能加载任意代码）' },
  { re: /\bcreateRequire\b/g, msg: '不许用 createRequire（读 JSON 用 fs，引模块用静态 import）' },
  { re: /\bprocess\s*\.\s*(binding|dlopen|_linkedBinding)\b/g, msg: '不许用 process.binding / dlopen' },
  { re: /\bWebAssembly\b/g, msg: '不许用 WebAssembly' },
  { re: /\beval\s*:\s*true\b/g, msg: '不许让 Worker 执行字符串代码（eval: true）' },
];
const CAP_PATTERNS = {
  process: [mod('child_process|worker_threads|cluster')],
  network: [mod('http|https|http2|net|tls|dgram|dns'), /(?<![\w$.])fetch\s*\(/g, /\bWebSocket\b/g, /\bctx\s*\.\s*net\b/g],
  files: [mod('fs'), /\bctx\s*\.\s*files\b/g],
  env: [/\bprocess\s*\.\s*env\b/g],
  core: [/(['"])@bridge\/core\//g],
};

function scanServerFile(file, src, errors, capHits) {
  const lines = src.split(/\r?\n/);
  let longest = 0;
  lines.forEach((l, i) => {
    if (l.length > 1000 && longest < 3) { longest++; errors.push({ code: 'unreadable', file, line: i + 1, message: `${file} 第 ${i + 1} 行超过 1000 字：服务端代码不许压缩或混淆` }); }
  });
  if (src.length > 5 * 1024 && src.length / Math.max(1, lines.length) > 300) errors.push({ code: 'unreadable', file, message: `${file} 平均每行超过 300 字，像是压缩过的代码：服务端代码要能读` });
  const blob = /[A-Za-z0-9+/=]{2000,}|[0-9a-fA-F]{2000,}/.exec(src);
  if (blob) errors.push({ code: 'blob', file, line: lineAt(src, blob.index), message: `${file} 第 ${lineAt(src, blob.index)} 行内嵌了一大段编码数据：服务端代码里不许藏数据块` });
  for (const f of FORBIDDEN) {
    f.re.lastIndex = 0;
    const m = f.re.exec(src);
    if (m) errors.push({ code: 'dynamic-code', file, line: lineAt(src, m.index), message: `${file} 第 ${lineAt(src, m.index)} 行：${f.msg}` });
  }
  // x.import(…) 是别的对象的方法，不算；module.require(…) 是真的 require，要算
  for (const [kw, label, before] of [['import', 'import()', '[\\w$.]'], ['require', 'require()', '[\\w$]']]) {
    const re = new RegExp(`(?<!${before})${kw}\\s*\\(`, 'g');
    let m;
    while ((m = re.exec(src))) {
      if (!literalArg(src, m.index + m[0].length)) {
        errors.push({ code: 'dynamic-code', file, line: lineAt(src, m.index), message: `${file} 第 ${lineAt(src, m.index)} 行：${label} 的参数必须是写死的字符串` });
        break;
      }
    }
  }
  for (const [cap, list] of Object.entries(CAP_PATTERNS)) {
    for (const re of list) {
      re.lastIndex = 0;
      const m = re.exec(src);
      if (m) { (capHits[cap] ||= []).length < 3 && capHits[cap].push(`${file}:${lineAt(src, m.index)}`); break; }
    }
  }
}

function declaresPage(m) {
  const ui = isObj(m.ui) ? m.ui : {};
  return (Array.isArray(ui.apps) && ui.apps.some((a) => isObj(a) && typeof a.page === 'string' && a.page))
    || (typeof ui.panel === 'string' && !!ui.panel) || (typeof ui.settings === 'string' && !!ui.settings)
    || (isObj(m.web) && typeof m.web.page === 'string' && !!m.web.page);
}

/**
 * 检查一次投稿。
 * @param {object} o
 *   id          目录名（CI：community/<id>/；bridge：要发布的插件 id）
 *   files       [{ path: 插件根下的相对路径（正斜杠）, size, data: Buffer }]，含 market.json（不进包，但要检查）
 *   author      投稿人的 GitHub 登录名
 *   ledger      社区台账 { owners: {id: login}, plugins: {id: {versions: [{version}]}} }
 *   moderation  { revoked: [{id, versions}], blockedAuthors: [login], reservedIds: [id] }
 *   reserved    保留 id（bridge 内置功能 + agent 扩展）
 *   official    官方市场已有的 id
 * @returns {{ ok, errors, warnings, kind, caps, capsAt, permissions, manifest, market, version }}
 */
export function checkSubmission({ id, files = [], author = '', ledger = {}, moderation = {}, reserved = [], official = [] } = {}) {
  const errors = [];
  const warnings = [];
  const err = (code, message, extra = {}) => errors.push({ code, message, ...extra });
  // 早退只发生在已经记了错误的时候
  const out = () => ({ ok: false, errors, warnings, kind: '', caps: [], capsAt: {}, permissions: [], manifest: null, market: null, version: '' });

  if (!ID_RE.test(String(id || ''))) { err('id', `插件 id「${String(id || '').slice(0, 60)}」不合法：小写字母开头，只用小写字母、数字、连字符，最长 48 字`); return out(); }

  // ── 文件 ──
  if (!files.length) { err('empty', '没有任何文件'); return out(); }
  if (files.length > LIMITS.files) err('too-many', `文件太多（${files.length} 个，最多 ${LIMITS.files} 个）`);
  let total = 0;
  const seen = new Map();
  for (const f of files) {
    const p = String(f.path || '');
    const size = Number(f.size ?? (f.data ? f.data.length : 0));
    total += size;
    if (size > LIMITS.fileBytes) err('too-big', `${p} 超过 2 MB`, { file: p });
    if (!p || p.length > LIMITS.pathLen) { err('path', `路径太长或为空：${p.slice(0, 80)}`, { file: p }); continue; }
    if (/[\\\u0000-\u001f\u007f]/.test(p) || p.startsWith('/') || /^[a-zA-Z]:/.test(p)) { err('path', `路径里有不允许的字符：${p}`, { file: p }); continue; }
    const segs = p.split('/');
    if (segs.some((s) => !s || s === '.' || s === '..')) { err('path', `路径不规整：${p}`, { file: p }); continue; }
    if (segs.some((s) => s.startsWith('.'))) { err('path', `不许有点开头的文件或目录：${p}`, { file: p }); continue; }
    if (segs.includes('node_modules')) { err('path', `不许带 node_modules（依赖要写成纯 JS 放进插件目录）：${p}`, { file: p }); continue; }
    if (!ALLOWED.has(extOf(p))) { err('ext', `不允许的文件类型：${p}（只收代码、文本、网页、图片、字体）`, { file: p }); continue; }
    const k = lower(p);
    if (seen.has(k)) err('path', `文件名只差大小写，Windows 上会冲突：${seen.get(k)} 与 ${p}`, { file: p });
    else seen.set(k, p);
  }
  if (total > LIMITS.totalBytes) err('too-big', `合计超过 8 MB（${(total / 1048576).toFixed(1)} MB）`);
  const byPath = new Map(files.map((f) => [String(f.path || ''), f]));

  // ── 清单 ──
  const mf = byPath.get(MANIFEST);
  if (!mf) { err('manifest', `插件根上没有 ${MANIFEST}`); return out(); }
  const pm = parseJson(mf.data);
  if (pm.err || !isObj(pm.v)) { err('manifest', `${MANIFEST} 不是合法的 JSON 对象${pm.err ? '：' + pm.err.slice(0, 120) : ''}`); return out(); }
  const m = pm.v;
  if (m.id !== id) err('manifest', `清单里的 id「${String(m.id ?? '').slice(0, 60)}」和目录名「${id}」不一致`);
  if (typeof m.name !== 'string' || !m.name.trim() || m.name.length > 60) err('manifest', '清单的 name 要写，1–60 字');
  if (!VER_RE.test(String(m.version || ''))) err('manifest', `清单的 version「${String(m.version ?? '').slice(0, 30)}」要写成 x.y.z`);
  if (m.description != null && (typeof m.description !== 'string' || m.description.length > 500)) err('manifest', '清单的 description 最长 500 字');
  if (!m.description) warnings.push({ code: 'no-description', message: '清单没写 description：市场卡片上会是空的' });
  const eng = isObj(m.engines) ? m.engines : null;
  if (!eng || !Number.isInteger(eng.pluginApi) || eng.pluginApi < 1) err('manifest', '清单要写 engines.pluginApi（整数，如 3）');
  if (eng && eng.bridge != null && !validRange(eng.bridge)) err('manifest', `engines.bridge「${String(eng.bridge).slice(0, 40)}」写法不对（如 ">=8.50"）`);
  if (m.replaces != null) err('replaces', '社区插件不能接管 bridge 自带的入口（去掉 replaces）');
  const permissions = Array.isArray(m.permissions) ? m.permissions.filter((x) => typeof x === 'string').slice(0, 40) : [];

  // ── market.json ──
  let market = null;
  const mk = byPath.get(MARKET_FILE);
  if (!mk) err('market', `缺 ${MARKET_FILE}（写这一版的更新说明：{"notes": {"${m.version || '1.0.0'}": "…"}}）`);
  else {
    const pk = parseJson(mk.data);
    if (pk.err || !isObj(pk.v)) err('market', `${MARKET_FILE} 不是合法的 JSON 对象`);
    else {
      market = pk.v;
      if (market.builtin) err('market', '社区插件不能标 builtin（盖内置功能只有官方市场能做）');
      const note = isObj(market.notes) ? market.notes[m.version] : null;
      if (typeof note !== 'string' || !note.trim()) err('market', `${MARKET_FILE} 的 notes 里没有 v${m.version || '?'} 的更新说明`);
      else if (note.length > 2000) err('market', '更新说明最长 2000 字');
      if (market.nameEn != null && (typeof market.nameEn !== 'string' || market.nameEn.length > 60)) err('market', 'nameEn 最长 60 字');
      if (market.descriptionEn != null && (typeof market.descriptionEn !== 'string' || market.descriptionEn.length > 500)) err('market', 'descriptionEn 最长 500 字');
      if (!market.nameEn) warnings.push({ code: 'no-en', message: '没写 nameEn：英文界面会显示中文名' });
    }
  }
  if (!byPath.has('README.md')) warnings.push({ code: 'no-readme', message: '没有 README.md：装之前别人看不到用法' });

  // ── 种类 ──
  let kind = 'page';
  if (m.entry != null && m.entry !== '') {
    const e = String(m.entry).replace(/^\.\//, '');
    if (!byPath.has(e)) err('entry', `清单的 entry「${String(m.entry).slice(0, 80)}」不在插件里`);
    else if (!CODE_EXT.has(extOf(e))) err('entry', 'entry 要是 .mjs / .js / .cjs');
    kind = 'server';
  } else if (byPath.has('index.mjs')) kind = 'server';
  if (kind === 'page' && !declaresPage(m)) err('entry', '没有服务端代码的插件至少要声明一个页面（ui.apps / ui.panel / ui.settings）');

  // ── 服务端代码扫描 ──
  const capHits = {};
  if (kind === 'server') {
    for (const f of files) {
      const p = String(f.path || '');
      if (!CODE_EXT.has(extOf(p)) || p.startsWith('web/')) continue;
      scanServerFile(p, text(f.data), errors, capHits);
    }
  }
  const caps = CAPS.filter((c) => capHits[c]);

  // ── 归属与名字 ──
  const login = lower(author);
  const owners = isObj(ledger.owners) ? ledger.owners : {};
  const owner = owners[id];
  const blocked = (Array.isArray(moderation.blockedAuthors) ? moderation.blockedAuthors : []).map(lower);
  if (!login) err('author', '不知道投稿人是谁（GitHub 账号）');
  else if (blocked.includes(login)) err('author', `账号 ${author} 已被禁止投稿`);
  if (owner) {
    if (login && lower(owner) !== login) err('owner', `「${id}」已经属于 ${owner}，只有本人能发新版本`);
  } else {
    const rsv = new Set([...(reserved || []), ...(Array.isArray(moderation.reservedIds) ? moderation.reservedIds : [])].map(lower));
    if (rsv.has(id)) err('reserved', `「${id}」是保留名，换一个 id`);
    else if ((official || []).map(lower).includes(id)) err('reserved', `「${id}」是官方插件的名字，换一个 id`);
    else if (RESERVED_PREFIXES.some((p) => id.startsWith(p))) err('reserved', `id 不能以 ${RESERVED_PREFIXES.join(' / ')} 开头`);
  }
  const revoked = (Array.isArray(moderation.revoked) ? moderation.revoked : []).find((r) => r && r.id === id && r.versions === '*');
  if (revoked) err('revoked', `「${id}」已被下架${revoked.reason ? '（' + String(revoked.reason).slice(0, 80) + '）' : ''}，不再接受新版本`);
  const prev = (isObj(ledger.plugins) && isObj(ledger.plugins[id]) && Array.isArray(ledger.plugins[id].versions) ? ledger.plugins[id].versions : [])
    .map((v) => v && v.version).filter((v) => VER_RE.test(String(v || '')));
  const latest = prev.sort((a, b) => compareVersions(b, a))[0];
  if (latest && VER_RE.test(String(m.version || '')) && !(compareVersions(m.version, latest) > 0)) err('version', `版本号要比已上架的 v${latest} 大`);

  return { ok: errors.length === 0, errors, warnings, kind, caps, capsAt: capHits, permissions, manifest: m, market, version: String(m.version || '') };
}

// 给人看的报告（CI 评论、bridge 预检面板的纯文本退路）
export function formatReport(r, { id = '', author = '' } = {}) {
  const lines = [];
  lines.push(r.ok ? `✅ 自动检查通过：${id} v${r.version}` : `❌ 自动检查没通过：${id}${r.version ? ' v' + r.version : ''}`);
  if (author) lines.push(`投稿人：@${author}`);
  if (r.kind) lines.push(`种类：${r.kind === 'server' ? '含服务端代码（在安装者的服务器上以 bridge 全部权限运行）' : '纯页面（只在沙箱页面里运行）'}`);
  if (r.caps?.length) lines.push('检测到的能力：' + r.caps.map((c) => `${CAP_LABELS[c]}（${(r.capsAt[c] || []).join('、')}）`).join('；'));
  if (r.permissions?.length) lines.push('清单声明的权限：' + r.permissions.join('、'));
  if (r.errors.length) { lines.push('', '要改的：'); for (const e of r.errors) lines.push('- ' + e.message); }
  if (r.warnings.length) { lines.push('', '建议：'); for (const w of r.warnings) lines.push('- ' + w.message); }
  return lines.join('\n');
}
