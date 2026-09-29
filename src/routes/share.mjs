// 公开凭证式文件分享（capability URL），给「把工作空间文件当公网下载链接发出去」的场景用
// （发一条 https://<你的地址>/s/<token> 给别人点开下载）。
//
//   POST /api/share  （走正常 per-identity 鉴权）  body { path[, ttlHours] }
//        → 为调用者自己沙箱内的一个文件铸一枚不可猜 token，返回
//          { ok, token, name, size, path:'/s/<token>', url?, expiresAt }
//   GET  /s/<token>  （公开·无鉴权）  → 流式发出该文件（Range 断点续传 + 按类型 inline/attachment）
//
// 安全模型 = 能力 URL，同 pv-<token> 预览子域：token 是 128bit 随机串、猜不出；铸链本身
// 受正常鉴权把关（只有文件属主、且只能给自己沙箱内的文件铸链）。这是【唯一】不经鉴权就能
// 拿到工作空间字节的路径，所以：① 只认铸链时存下的 {root, rel}，取件时【绝不】接受客户端
// 传入路径；② 取件时再用 safeJoin 在 root 内复核一遍（纵深防御）；③ token 带 TTL、过期即删。

import path from 'node:path';
import crypto from 'node:crypto';
import { statSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { requireCtx } from '../runtime/identity.mjs';
import { readBody } from '../runtime/body.mjs';
import { mimeType, safeJoin, streamFile } from '../runtime/http-file.mjs';
import { ROOT, PUBLIC_ORIGIN } from '../config/index.mjs';
import { makePwRec, checkPw, allowAttempt, clearAttempts, gateHtml, goneHtml, pageLang } from './share-gate.mjs';
import { hasLockedShareSpace, unlockShareSpace } from './share-space.mjs';
import { authorizeProjectPath } from '../project-paths.mjs';

const STORE_FILE = path.join(ROOT, 'share-links.json');
const DEFAULT_TTL_H = 24 * 7;          // 默认 7 天有效
const MAX_TTL_H = 24 * 30;             // 上限 30 天
const MAX_SHARE = 2_000_000_000;       // 单文件上限 2GB（流式，不占内存）

// token -> { root, rel, name, owner, size, createdAt, expiresAt, hits }
let store = load();
let dirty = false;                     // hits 之类的轻量变更攒着定期落盘，不每次都写

// S7 原型链防护：token 是公网可控输入，普通对象直接下标会命中 constructor/__proto__ 等
// 原型属性（骗过「记录存在」判定或 500）。store 恒为无原型对象，载入时逐键拷入。
// 函数声明（非 const 箭头）——load() 在模块顶部 `let store = load()` 处就被调用，早于本行。
function bare(o) { return Object.assign(Object.create(null), o); }
function load() {
  try { return bare(JSON.parse(readFileSync(STORE_FILE, 'utf8')) || {}); } catch { return bare({}); }
}
function save() {
  try { const t = STORE_FILE + '.tmp'; writeFileSync(t, JSON.stringify(store)); renameSync(t, STORE_FILE); dirty = false; }
  catch { /* 分享链接是可再生的软状态，落盘失败不致命 */ }
}
function prune() {
  const now = Date.now();
  let changed = false;
  for (const [tok, rec] of Object.entries(store)) {
    if (rec.expiresAt && now > rec.expiresAt) { delete store[tok]; changed = true; }
  }
  if (changed) save();
}
// 每小时扫一次过期 + 落盘攒下的 hits。unref 不挡进程退出。
setInterval(() => { prune(); if (dirty) save(); }, 60 * 60 * 1000).unref?.();

// 浏览器能安全内联展示的类型（点开即预览，其它一律强制下载）。
const INLINE = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'mp4', 'webm', 'mov', 'm4v', 'mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac', 'pdf', 'txt', 'md', 'markdown', 'json', 'csv', 'log']);

const bad = (res, code, msg) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(msg); };
const okJson = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

// POST /api/share —— 为调用者沙箱内某文件铸一枚下载 token。
async function handleMint(req, res, identify) {
  let ctx = requireCtx(identify, req, res);
  if (!ctx) return;
  let body; try { body = JSON.parse(await readBody(req)); } catch { return bad(res, 400, 'bad json'); }
  if (body.ws) {
    if (!ctx.shell) return bad(res, 403, 'workspace tools require Pro');
    try { ctx = { ...ctx, cwd: authorizeProjectPath(ctx, body.ws) }; }
    catch (e) { return bad(res, e?.status || 403, e?.message || 'forbidden'); }
  }
  const abs = safeJoin(ctx.cwd, String(body.path || ''));
  if (!abs) return bad(res, 403, 'forbidden');
  let st; try { st = statSync(abs); } catch { return bad(res, 404, 'not found'); }
  if (st.isDirectory()) return bad(res, 400, '只能分享文件，不能分享文件夹');
  if (st.size > MAX_SHARE) return bad(res, 413, '文件太大（分享上限 2GB）');
  const rel = path.relative(path.resolve(ctx.cwd), abs).split(path.sep).join('/');
  const ttlH = Number.isFinite(body.ttlHours) ? Math.max(1, Math.min(MAX_TTL_H, Math.round(body.ttlHours))) : DEFAULT_TTL_H;
  // 可选分享密码：存 scrypt 哈希 + 解锁凭证，取件时凭 ?k=<unlock> 放行（见 share-gate.mjs）。
  const pw = typeof body.password === 'string' ? body.password.trim() : '';
  if (pw.length > 64) return bad(res, 400, '密码过长（上限 64 字符）');
  const now = Date.now();
  const token = crypto.randomBytes(16).toString('base64url');   // ~128bit，不可猜
  store[token] = {
    root: path.resolve(ctx.cwd), rel, name: path.basename(abs), owner: ctx.key,
    size: st.size, createdAt: now, expiresAt: now + ttlH * 3600e3, hits: 0,
    ...(pw ? await makePwRec(pw) : {}),
  };
  prune(); save();
  const relUrl = '/s/' + token;
  okJson(res, { ok: true, token, name: store[token].name, size: st.size, path: relUrl, url: PUBLIC_ORIGIN ? PUBLIC_ORIGIN + relUrl : null, expiresAt: store[token].expiresAt, locked: !!pw });
}

// POST /api/share-unlock —— 公开（它就是密码闸本身）：验对密码换 unlock 凭证 k。
// 同时服务 /s/（本 store）与 /w/（share-space store），token 128bit 随机不会撞。
async function handleUnlock(req, res) {
  let body; try { body = JSON.parse(await readBody(req)); } catch { return bad(res, 400, 'bad json'); }
  const token = String(body.token || '').trim();
  const password = String(body.password || '');
  if (!token || !password) return bad(res, 400, 'missing token/password');
  const rec = store[token];
  const liveFile = !!(rec && rec.pwHash && !(rec.expiresAt && Date.now() > rec.expiresAt));
  const liveSpace = !liveFile && hasLockedShareSpace(token);
  // Only real locked shares get a token bucket. Random public input must not be
  // able to grow the attempts table without bound.
  if (!liveFile && !liveSpace) return bad(res, 403, '密码不正确');
  if (!allowAttempt(token)) return bad(res, 429, '尝试太频繁，请稍后再试');
  let k = null;
  if (liveFile) {
    k = await checkPw(rec, password) ? rec.unlock : null;
  } else {
    k = await unlockShareSpace(token, password);
  }
  if (!k) return bad(res, 403, '密码不正确');
  clearAttempts(token);
  okJson(res, { ok: true, k });
}

const GONE_PAGE = goneHtml('file');
const GONE_PAGE_EN = goneHtml('file', 'en');   // 浏览器语言不是中文的访客（见 pageLang）
const gone = (res) => { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(pageLang(res.req) === 'en' ? GONE_PAGE_EN : GONE_PAGE); };

// GET /s/<token> —— 公开下载。只认存下的 {root, rel}，绝不吃客户端路径。
function handleServe(req, res, url) {
  const token = decodeURIComponent(url.pathname.slice(3));   // 去掉前缀 '/s/'
  const rec = store[token];
  if (!rec) return gone(res);
  if (rec.expiresAt && Date.now() > rec.expiresAt) { delete store[token]; save(); return gone(res); }
  // 带密码的分享：没有正确的 ?k=<unlock> 凭证就先出密码页（验对后由页面带 k 重进）。
  if (rec.pwHash && (url.searchParams.get('k') || '') !== rec.unlock) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(gateHtml('/s/', token, pageLang(req)));
    return;
  }
  const abs = safeJoin(rec.root, rec.rel);   // 纵深复核：即便存储被篡改也走不出 root
  if (!abs) return gone(res);
  let st; try { st = statSync(abs); } catch { return gone(res); }
  if (st.isDirectory()) return gone(res);
  rec.hits = (rec.hits || 0) + 1; dirty = true;   // 攒着，定期落盘

  const ext = path.extname(abs).slice(1).toLowerCase();
  const ct = mimeType(abs, { safe: true });
  const dl = url.searchParams.get('dl') === '1';
  const download = dl || !INLINE.has(ext);
  streamFile(req, res, abs, {
    stat: st,
    contentType: ct,
    cacheControl: 'private, max-age=30',
    highWaterMark: 1 << 20,
    ...(download ? { downloadName: rec.name, download: true } : {}),
  });
}

export function registerShareRoutes(router, { identify }) {
  router.on('POST', '/api/share', (req, res) => handleMint(req, res, identify));
  router.on('POST', '/api/share-unlock', (req, res) => handleUnlock(req, res));   // 公开：密码换 k 凭证（/s/ + /w/ 共用）
  // /s/<token> 的 token 是动态段，mini-router 只做精确匹配 → 用中间件按前缀接管。
  // 放行非 /s/ 请求（返回 undefined 继续分派）；命中则处理并 return false 截停。
  router.use((req, res, url) => {
    if (req.method !== 'GET' || !url.pathname.startsWith('/s/') || url.pathname.length <= 3) return;
    handleServe(req, res, url);
    return false;
  });
}
