// 公开只读「分享工作空间」——把调用者标出的一批文件/文件夹拷进一个独立的桶目录，
// 铸一枚公开 token，任何人凭 https://bridge.<域>/w/<token> 就能像逛工作空间一样浏览、
// 预览这些内容（复用现有前端 FilesPanel + 预览查看器）。用于把一个文件夹只读分享给别人。
//
//   POST /api/share-space  （走正常 per-identity 鉴权）  body { paths:[rel...][, ttlHours] }
//        → 把每个 rel 从调用者沙箱拷进 share-spaces/<token>/，返回
//          { ok, token, count, path:'/w/<token>', url?, expiresAt }
//   GET  /w/<token>        （公开·无鉴权）  → 吐现有 SPA（前端据路径进「分享只读」模式）
//   桶内文件的实际读取走 /api/files、/api/file* —— 那些读接口用 requireReadCtx 认 ?st=<token>，
//   解析成一个 readOnly 且 cwd 锁死在桶内的 share 身份（见 runtime/identity.mjs）。
//
// 安全模型：① 桶是【拷贝】，公开身份的 cwd 就是桶，即便路径穿越也只在桶内、碰不到真实工作空间；
// ② 只放行读接口（写接口用 requireCtx，对 share 一律 401）；③ token 128bit 猜不出、带 TTL 过期删桶。

import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync, statSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { cp } from 'node:fs/promises';
import { requireCtx } from '../runtime/identity.mjs';
import { readBody } from '../runtime/body.mjs';
import { safeJoin } from '../runtime/http-file.mjs';
import { ROOT, PUBLIC_ORIGIN, PUBLIC_DIR } from '../config/index.mjs';
import { CAPABILITIES } from '../config/capabilities.mjs';
import { makePwRec, checkPw, gateHtml, goneHtml, pageLang } from './share-gate.mjs';
import { authorizeProjectPath } from '../project-paths.mjs';

const SPACES_DIR = path.join(ROOT, 'share-spaces');     // 各桶存这里：share-spaces/<token>/
const STORE_FILE = path.join(ROOT, 'share-spaces.json'); // token -> 元数据
const DEFAULT_TTL_H = 24;              // 默认 24 小时
const MAX_TTL_H = 24 * 30;             // 上限 30 天（对齐 /s/ 单文件分享，前端过期选项统一）
const MAX_ITEMS = 200;                 // 单次最多分享的顶层项数
const MAX_TOTAL = 2_000_000_000;       // 单次分享总大小上限 2GB（对齐 /s/ 单文件上限）
const MAX_WALK = 5000;                 // 递归量目录时的文件项上限（剔除 SKIP_DIRS 之后再数）
// 分享文件夹时整棵跳过的依赖/版本库/缓存目录：量体积与拷贝同一份名单（对齐文件卡 zip 的排除）。
// 以前不跳，一个带 node_modules 的项目夹动辄几万项，只能撞 5000 上限报「文件太多」。
// .sdk/.toolchain 是整套安卓 SDK（各一万多项）；build 名字太常见，只在旁边有 build.gradle 时才算编译产物。
const SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.gradle', '.next', '.svelte-kit', '.turbo', '.cache', '.sdk', '.toolchain']);
const skipped = (p) => {
  const b = path.basename(p);
  if (SKIP_DIRS.has(b)) return true;
  if (b !== 'build') return false;
  const up = path.dirname(p);
  return existsSync(path.join(up, 'build.gradle')) || existsSync(path.join(up, 'build.gradle.kts'));
};
// bridge 自己的数据根（config.json 里有登录令牌等机密）：它本身或它的任何上级都不许公开分享。
// 整机访问后主目录、盘根都点得到分享，这道闸不能再指望「够不着」。
const norm = (p) => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
const coversDataRoot = (abs) => { const a = norm(abs), r = norm(ROOT); return r === a || r.startsWith(a.endsWith(path.sep) ? a : a + path.sep); };

let store = load();
// S7 原型链防护：st token 是公网可控输入，普通对象下标会命中 constructor 等原型属性。store 恒无原型。
// 函数声明（非 const 箭头）——load() 在模块顶部 `let store = load()` 处就被调用，早于本行。
function bare(o) { return Object.assign(Object.create(null), o); }
function load() { try { return bare(JSON.parse(readFileSync(STORE_FILE, 'utf8')) || {}); } catch { return bare({}); } }
function save() { try { const t = STORE_FILE + '.tmp'; writeFileSync(t, JSON.stringify(store)); renameSync(t, STORE_FILE); } catch { /* 软状态，失败不致命 */ } }

// 递归量一个文件/目录的总字节与项数（超限即抛，避免拷超大目录）。
// 抛的 Error 带 .code：'items'=项数超限 / 'size'=体积超限，handleMint 据此给出说人话的 413 文本。
function measure(abs, budget) {
  let bytes = 0, items = 0;
  const walk = (p) => {
    const st = statSync(p);
    items++;
    if (items > MAX_WALK) { const e = new Error('too many items'); e.code = 'items'; throw e; }
    if (st.isDirectory()) { for (const de of readdirSync(p)) { const c = path.join(p, de); if (!skipped(c)) walk(c); } }
    else {
      bytes += st.size;
      if (bytes > budget) { const e = new Error('total too big'); e.code = 'size'; throw e; }
    }
  };
  walk(abs);
  return { bytes, items };
}

function prune() {
  const now = Date.now();
  let changed = false;
  for (const [tok, rec] of Object.entries(store)) {
    if (rec.expiresAt && now > rec.expiresAt) {
      try { rmSync(path.join(SPACES_DIR, tok), { recursive: true, force: true }); } catch {}
      delete store[tok]; changed = true;
    }
  }
  if (changed) save();
}
setInterval(prune, 60 * 60 * 1000).unref?.();

// 供 identity 解析：st -> { token, dir }（过期即删返回 null）。绝不接受调用方传入的路径。
// st 可以是裸 token，或带解锁凭证的复合形式 `token.k`（base64url 不含 '.'，可安全切分）——
// 带密码的桶必须凭正确的 k 才解析得出身份，否则拿到 token 也读不了 /api/files。
export function resolveShareToken(st) {
  if (!st) return null;
  const dot = String(st).indexOf('.');
  const token = dot >= 0 ? String(st).slice(0, dot) : String(st);
  const key = dot >= 0 ? String(st).slice(dot + 1) : '';
  const rec = store[token];
  if (!rec) return null;
  if (rec.expiresAt && Date.now() > rec.expiresAt) {
    try { rmSync(path.join(SPACES_DIR, token), { recursive: true, force: true }); } catch {}
    delete store[token]; save(); return null;
  }
  if (rec.pwHash && key !== rec.unlock) return null;
  return { token, dir: path.join(SPACES_DIR, token) };
}

// 供 /api/share-unlock（share.mjs）调：验对密码 → 返回本桶的 unlock 凭证，否则 null。
export function hasLockedShareSpace(token) {
  const rec = store[token];
  return !!(rec && rec.pwHash && !(rec.expiresAt && Date.now() > rec.expiresAt));
}
export async function unlockShareSpace(token, password) {
  const rec = store[token];
  if (!hasLockedShareSpace(token)) return null;
  return await checkPw(rec, password) ? rec.unlock : null;
}

const bad = (res, code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg); };
const okJson = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

// POST /api/share-space —— 拷贝调用者标出的文件/文件夹成一个公开只读桶。
async function handleMint(req, res, identify) {
  let ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  let body; try { body = JSON.parse(await readBody(req)); } catch { return bad(res, 400, 'bad json'); }
  if (body.ws) {
    if (!ctx.shell) return bad(res, 403, 'workspace tools require Pro');
    try { ctx = { ...ctx, cwd: authorizeProjectPath(ctx, body.ws) }; }
    catch (e) { return bad(res, e?.status || 403, e?.message || 'forbidden'); }
  }
  // 可选分享密码（同 share.mjs）：验对密码换 k 凭证前，/w/ 页与 ?st= 数据读取一律不放行。
  const pw = typeof body.password === 'string' ? body.password.trim() : '';
  if (pw.length > 64) return bad(res, 400, '密码过长（上限 64 字符）');
  const raw = Array.isArray(body.paths) ? body.paths : (body.path ? [body.path] : []);
  // 每项可为字符串路径，或 { path, name }（name = 指定桶内展示名，给生成媒体这类 uuid 文件名用）。
  const seen = new Set();
  const list = [];
  for (const x of raw) {
    const p = (x && typeof x === 'object') ? String(x.path || '').trim() : String(x || '').trim();
    const nm = (x && typeof x === 'object' && x.name) ? String(x.name).trim() : '';
    if (!p || seen.has(p)) continue;
    seen.add(p); list.push({ path: p, name: nm });
    if (list.length >= MAX_ITEMS) break;
  }
  if (!list.length) return bad(res, 400, '没有可分享的文件');

  // 逐个校验 + 量大小（越界/不存在跳过）。超限时把实际值说清楚，别让用户对着裸 413 猜。
  const gb = (n) => (n / 1073741824).toFixed(2) + ' GB';
  const srcs = [];
  let total = 0;
  for (const it of list) {
    const abs = safeJoin(ctx.cwd, it.path);
    if (!abs || abs === path.resolve(ctx.cwd)) continue;         // 不允许把整个沙箱根当一项分享
    let st; try { st = statSync(abs); } catch { continue; }
    if (coversDataRoot(abs)) return bad(res, 403, `「${path.basename(abs)}」里有 bridge 自己的数据目录（含登录令牌等机密），不能公开分享，请挑选里面的内容分享`);
    let m;
    try { m = measure(abs, MAX_TOTAL - total); }
    catch (e) {
      if (e.code === 'items') return bad(res, 413, `「${path.basename(abs)}」里的文件太多（超过 ${MAX_WALK} 项），不适合整夹分享，请挑选里面的内容分享`);
      return bad(res, 413, `分享内容过大（超过上限 ${gb(MAX_TOTAL)}），请减少或挑小一点的内容`);
    }
    total += m.bytes;
    const forced = it.name ? it.name.replace(/[\\/]+/g, '_').replace(/^\.+/, '').slice(0, 120) : '';
    srcs.push({ abs, name: forced || path.basename(abs), isDir: st.isDirectory() });
  }
  if (!srcs.length) return bad(res, 404, '标出的文件都找不到');

  const token = crypto.randomBytes(16).toString('base64url');   // ~128bit
  const dir = path.join(SPACES_DIR, token);
  mkdirSync(dir, { recursive: true });
  // 拷进桶（异步 cp——桶上限 2GB，同步拷会卡住 event loop 十几秒拖死全站）；同名项加序号避免覆盖。
  const used = new Set();
  let count = 0;
  for (const s of srcs) {
    let name = s.name || 'file';
    if (used.has(name)) {
      const ext = s.isDir ? '' : path.extname(name);
      const stem = ext ? name.slice(0, -ext.length) : name;
      let i = 2; while (used.has(`${stem} (${i})${ext}`)) i++;
      name = `${stem} (${i})${ext}`;
    }
    used.add(name);
    try { await cp(s.abs, path.join(dir, name), { recursive: true, filter: (src) => src === s.abs || !skipped(src) }); count++; }
    catch { /* 单项拷贝失败跳过，不整体失败 */ }
  }
  if (!count) { try { rmSync(dir, { recursive: true, force: true }); } catch {}; return bad(res, 500, '拷贝失败'); }

  const ttlH = Number.isFinite(body.ttlHours) ? Math.max(1, Math.min(MAX_TTL_H, Math.round(body.ttlHours))) : DEFAULT_TTL_H;
  const now = Date.now();
  store[token] = {
    owner: ctx.key, count, bytes: total, createdAt: now, expiresAt: now + ttlH * 3600e3,
    ...(pw ? await makePwRec(pw) : {}),
  };
  prune(); save();
  const relUrl = '/w/' + token;
  okJson(res, { ok: true, token, count, path: relUrl, url: PUBLIC_ORIGIN ? PUBLIC_ORIGIN + relUrl : null, expiresAt: store[token].expiresAt, locked: !!pw });
}

// GET /w/<token> —— 吐现有 SPA（注入 caps 快照，同 static.mjs）。前端据 /w/ 前缀进只读分享模式。
const EXPIRED_PAGE = goneHtml('space');
const EXPIRED_PAGE_EN = goneHtml('space', 'en');   // 浏览器语言不是中文的访客（见 pageLang）
function serveShareApp(req, res, url) {
  const token = decodeURIComponent(url.pathname.slice(3));
  const rec = store[token];
  if (!rec || (rec.expiresAt && Date.now() > rec.expiresAt)) { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(pageLang(req) === 'en' ? EXPIRED_PAGE_EN : EXPIRED_PAGE); return; }
  // 带密码的桶：没有正确的 ?k=<unlock> 先出密码页（验对后带 k 重进；前端 share.js 会把
  // k 併进 ?st=token.k，数据读取那头 resolveShareToken 同样验 k——两道门同一把钥匙）。
  if (rec.pwHash && (url.searchParams.get('k') || '') !== rec.unlock) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(gateHtml('/w/', token, pageLang(req)));
    return;
  }
  try {
    let html = readFileSync(path.join(PUBLIC_DIR, 'app', 'index.html'), 'utf8');
    const tag = `<script>window.__CAPS__=${JSON.stringify(CAPABILITIES)};</script>`;
    html = html.includes('<!-- CAPS_INJECT -->') ? html.replace('<!-- CAPS_INJECT -->', tag) : html.replace('</head>', tag + '</head>');
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  } catch { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('failed to serve page'); }
}

// GET /api/share-meta?st=<token[.k]> —— 访客页头部的元信息（项数/总大小/创建与到期时间）。
// 与 /api/files 同一道门：st 必须解析得出（带密码的桶要带对 k），否则一律 404，不泄露桶是否存在。
function handleMeta(req, res, url) {
  const sh = resolveShareToken(url.searchParams.get('st') || req.headers['x-share-token'] || '');
  const rec = sh && store[sh.token];
  if (!rec) return bad(res, 404, 'not found');
  if (!Number.isFinite(rec.bytes)) {   // 老桶铸链时没记体积：量一次缓存进记录
    try { rec.bytes = measure(sh.dir, Infinity).bytes; save(); } catch { rec.bytes = null; }
  }
  res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ count: rec.count, bytes: rec.bytes ?? null, createdAt: rec.createdAt, expiresAt: rec.expiresAt, locked: !!rec.pwHash }));
}

export function registerShareSpaceRoutes(router, { identify }) {
  router.on('POST', '/api/share-space', (req, res) => handleMint(req, res, identify));
  router.on('GET', '/api/share-meta', (req, res, url) => handleMeta(req, res, url));   // 公开：凭 st 读桶元信息
  // /w/<token> 动态段：中间件按前缀接管（同 /s/ 的做法）。
  router.use((req, res, url) => {
    if (req.method !== 'GET' || !url.pathname.startsWith('/w/') || url.pathname.length <= 3) return;
    serveShareApp(req, res, url);
    return false;
  });
}
