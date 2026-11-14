// 手机「本地」分页的无头复现：AndroidStore 桩 + /__localfile 拦截 + isOffline 开关。
//
// 真机链路（摸底「本地文件链路」）：前端把本地文件指向 /__localfile?rel=<根id>/<路径>，只有 apk 壳的
// MainActivity.shouldInterceptRequest → serveLocalFile 会响应（单段 Range 回 206；&thumb=1 回 320px JPEG，失败 404）。
// 列目录、读文本走同步的 window.AndroidStore.*（MainActivity 的 NativeStore）。isOffline() 只认 appassets 主机名。
//
// 这里的做法：
//   1. Page.addScriptToEvaluateOnNewDocument 在页面脚本之前注入：
//      - window.__BRIDGE_DEV_OFFLINE__ = true（web/src/lib/server.js 里仅 dev 生效的开关 → isOffline() 为真）
//      - localStorage['bridge-server'] = 当前源（离线壳没配服务器地址会进「填服务器」首屏）
//      - window.AndroidStore：用 getter 陷阱定义（不可被页面改写），Proxy 记下所有探测过的未实现方法（__pvqaLocal.miss）；
//        方法签名照 MainActivity.java 的 @JavascriptInterface：localRoots/localList/localReadText/localReadB64/hasLocalThumb/...
//        localList 用注入时扫好的样张目录树；localReadText / localReadB64 用同步 XHR 读 /__localfile（同样被拦截，上限 2MB / 8MB 同原生）
//   2. Fetch.enable 拦截 *__localfile* 与 */api/lan*：
//      - /__localfile：continueRequest 把地址改写到本进程起的本地文件服务器（改写对页面不可见，页面看到的仍是同源 /__localfile），
//        文件服务器按 Range 回 206、thumb 参数现用 sharp（图片）/ ffmpeg（视频）生成并缓存，可设人为延迟模拟 SAF 慢路径；
//      - /api/lan：回 {ips:[]}，免得离线壳逻辑去探局域网地址。
//   3. 写操作（localWrite/Delete/Rename/Move/Copy）、分享、打开方式、转屏、震动只记录调用（__pvqaLocal.calls），不改样张。
//   4. 可选 v2（installLocalStub(pg, { v2: true })，run.mjs 的 mode 'apk2' / 'apk2:<延迟>'）= 新 apk（hasLocalPreview 那一代原生）：
//      文件服务器换成新原生的档位（preview 1600 / poster 1080 / max ≤16.7MP 只在显式 &thumb=max 时出、原图够小直出；
//      原图一律回原字节不静默降档，HEIC 全分辨率转 JPEG；&region=x,y,w,h&w= 原图区域块）、缓存头（max-age + size/mtime ETag，
//      If-None-Match 命中回 304——真机 WebResourceResponse 回不了 3xx，照样 200，这里量「理想上限」）、rel 解析缓存
//      （SAF 定位延迟每个 rel 只付一次），页面桩补 localStat / localExif / 存相册 / 壁纸 / 文件管理器 / 画中画。默认关，旧行为一字不变。
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { QA_ROOT, REPO, SAMPLES_DIR } from './lib/paths.mjs';

let sharp = null;
try { sharp = createRequire(path.join(REPO, 'package.json'))('sharp'); } catch {}

const MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', heic: 'image/heic', avif: 'image/avif',
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', ogg: 'audio/ogg', opus: 'audio/ogg',
  pdf: 'application/pdf', json: 'application/json', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv', html: 'text/html', js: 'text/javascript',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', zip: 'application/zip',
};
const mimeOf = (n) => MIME[(n.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';
const IMG = /\.(jpe?g|png|gif|webp|bmp|svg|avif|heic|heif)$/i, VID = /\.(mp4|m4v|mov|webm|mkv|3gp)$/i;

// 缩略档：1 = 现有原生 320 档；grid / preview / poster 是摸底里规划的新原生档位（先在桩里实现，前端改好就能验）
const TIERS = { 1: { size: 320, q: 78 }, grid: { size: 512, q: 80 }, preview: { size: 2048, q: 85 }, poster: { size: 1280, q: 82, video: true } };

// —— v2：照抄新原生（android/…/LocalMedia.java 的 Tier / scaleFor、MainActivity.serveLocalFile 的缓存头与原图分流）——
// size >0 = 长边像素；0 = max（≤16.7MP，只在显式 &thumb=max 时出）；<0 = full（原分辨率，只给 HEIC 转 JPEG 用）
const TIERS_V2 = { 1: { size: 320, q: 78 }, grid: { size: 512, q: 80 }, preview: { size: 1600, q: 85 }, poster: { size: 1080, q: 82 }, max: { size: 0, q: 88 }, full: { size: -1, q: 90 } };
const SAFE_PIXELS = 4096 * 4096;
const IMG_V2 = new Set(['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'heic', 'heif', 'avif']);   // 同原生 IMG_EXT（没有 svg：矢量不出衍生档）
const PASS_V2 = new Set(['png', 'jpg', 'jpeg', 'webp']);   // 原图不大于目标档时直出原字节
const extOf = (p) => (String(p).split('.').pop() || '').toLowerCase();
/** 产物 = 原图 × k（k≤1）：长图 / 全景（长宽比 ≥2.5）的 preview 档放宽到短边 1080、长边至多 4096 */
function scaleForV2(id, t, w, h) {
  if (!(w > 0 && h > 0) || t.size < 0) return 1;
  const lo = Math.max(w, h), sh = Math.min(w, h);
  let k;
  if (t.size === 0) k = Math.sqrt(SAFE_PIXELS / (w * h));
  else if (id === 'preview' && lo >= sh * 2.5) k = Math.max(t.size / lo, Math.min(1080 / sh, 4096 / lo));
  else k = t.size / lo;
  return Math.min(1, k);
}
/** 极简 EXIF（TIFF）解析：IFD0 + ExifIFD + GPS IFD 的标量 / 字符串 / 有理数 */
function parseExif(buf) {
  const out = { t0: {}, ex: {}, gps: {} };
  if (!buf || buf.length < 14) return out;
  const o = buf.toString('latin1', 0, 6) === 'Exif\0\0' ? 6 : 0;
  const le = buf.toString('latin1', o, o + 2) === 'II';
  const u16 = (p) => (le ? buf.readUInt16LE(p) : buf.readUInt16BE(p));
  const u32 = (p) => (le ? buf.readUInt32LE(p) : buf.readUInt32BE(p));
  const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8 };
  const ifd = (off, into) => {
    const p0 = o + off;
    if (!off || p0 + 2 > buf.length) return;
    const n = u16(p0);
    for (let i = 0; i < n; i++) {
      const e = p0 + 2 + i * 12;
      if (e + 12 > buf.length) break;
      const tag = u16(e), type = u16(e + 2), cnt = u32(e + 4), sz = (SZ[type] || 1) * cnt;
      const vp = sz <= 4 ? e + 8 : o + u32(e + 8);
      if (vp + sz > buf.length) continue;
      let v = null;
      if (type === 2) v = buf.toString('latin1', vp, vp + cnt).replace(/\0[\s\S]*$/, '').trim();
      else if (type === 3) v = cnt === 1 ? u16(vp) : Array.from({ length: cnt }, (_, k) => u16(vp + 2 * k));
      else if (type === 4) v = u32(vp);
      else if (type === 5 || type === 10) {
        const a = [];
        for (let k = 0; k < cnt; k++) { const nu = type === 10 ? buf[le ? 'readInt32LE' : 'readInt32BE'](vp + 8 * k) : u32(vp + 8 * k), de = u32(vp + 8 * k + 4); a.push(de ? nu / de : 0); }
        v = cnt === 1 ? a[0] : a;
      } else if (type === 1 || type === 7) v = cnt === 1 ? buf[vp] : buf.slice(vp, vp + cnt);
      into[tag] = v;
    }
  };
  try {
    ifd(u32(o + 4), out.t0);
    if (out.t0[0x8769]) ifd(out.t0[0x8769], out.ex);
    if (out.t0[0x8825]) ifd(out.t0[0x8825], out.gps);
  } catch {}
  return out;
}
const fmt1 = (x) => (Math.abs(x - Math.round(x)) < 0.05 ? String(Math.round(x)) : x.toFixed(1));
/** 同原生 LocalMedia.exifJson：{ok,w,h,taken,camera,exposure,place,duration}；地点给 1 位小数的约略经纬度（原生查不到城市时的兜底） */
async function mediaInfoV2(abs) {
  const o = { ok: true };
  const ext = extOf(abs);
  let ll = null;
  if (VID.test(abs)) {
    const j = await new Promise((res) => execFile('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', abs], { maxBuffer: 8 << 20, timeout: 15000, windowsHide: true }, (err, so) => { try { res(err ? null : JSON.parse(so)); } catch { res(null); } }));
    const v = j?.streams?.find((s) => s.codec_type === 'video');
    if (v) {
      let w = v.width, h = v.height;
      const rot = Math.abs(Number(v.tags?.rotate || v.side_data_list?.find((d) => d.rotation != null)?.rotation || 0)) % 180;
      if (rot === 90) [w, h] = [h, w];
      if (w > 0 && h > 0) { o.w = w; o.h = h; }
    }
    const dur = Math.round(Number(j?.format?.duration || 0) * 1000);
    if (dur > 0) o.duration = dur;
    const ct = j?.format?.tags?.creation_time;
    const d = ct ? new Date(ct) : null;
    if (d && d.getTime() > 31536000000) { const p = (n) => String(n).padStart(2, '0'); o.taken = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; }
  } else if (IMG_V2.has(ext) && sharp) {
    let m = null;
    try { m = await sharp(abs, { failOn: 'none' }).metadata(); } catch {}
    if (m?.width && m?.height) { const sw = (m.orientation || 1) >= 5; o.w = sw ? m.height : m.width; o.h = sw ? m.width : m.height; }
    const x = parseExif(m?.exif);
    const dt = x.ex[0x9003] || x.t0[0x0132];
    if (typeof dt === 'string' && dt.length >= 16 && !dt.startsWith('0000')) o.taken = `${dt.slice(0, 4)}-${dt.slice(5, 7)}-${dt.slice(8, 10)} ${dt.slice(11, 16)}`;
    const make = x.t0[0x010f] || null, model = x.t0[0x0110] || null;
    const cam = !model ? make : !make || model.toLowerCase().startsWith(make.toLowerCase()) ? model : make + ' ' + model;
    if (cam) o.camera = cam;
    const xp = [];
    if (x.ex[0x829d] > 0) xp.push('f/' + fmt1(x.ex[0x829d]));
    const et = x.ex[0x829a];
    if (et > 0) xp.push(et < 1 ? '1/' + Math.round(1 / et) + ' s' : fmt1(et) + ' s');
    const iso = [].concat(x.ex[0x8827] ?? [])[0];
    if (iso) xp.push('ISO ' + iso);
    if (x.ex[0x920a] > 0) xp.push(fmt1(x.ex[0x920a]) + ' mm');
    if (xp.length) o.exposure = xp.join(' · ');
    const g = x.gps, dms = (a) => (Array.isArray(a) ? a[0] + (a[1] || 0) / 60 + (a[2] || 0) / 3600 : null);
    const lat = dms(g[2]), lng = dms(g[4]);
    if (lat != null && lng != null && !(lat === 0 && lng === 0)) ll = [g[1] === 'S' ? -lat : lat, g[3] === 'W' ? -lng : lng];
  }
  if (ll) o.place = `≈ ${Math.abs(ll[0]).toFixed(1)}°${ll[0] >= 0 ? 'N' : 'S'}, ${Math.abs(ll[1]).toFixed(1)}°${ll[1] >= 0 ? 'E' : 'W'}`;
  return o;
}

/** 扫样张目录树 → { '<rel 目录>': [{name,isDir,size,mtime}] }（同原生：隐藏点文件，单目录最多 2000 项） */
function scanTree(rootDir, rootId) {
  const tree = {};
  const walk = (abs, rel) => {
    let ents = [];
    try { ents = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    const items = [];
    for (const e of ents) {
      if (e.name.startsWith('.') || e.name === 'manifest.json') continue;
      const p = path.join(abs, e.name);
      let st; try { st = statSync(p); } catch { continue; }
      items.push({ name: e.name, isDir: e.isDirectory(), size: e.isDirectory() ? 0 : st.size, mtime: Math.round(st.mtimeMs) });
      if (e.isDirectory()) walk(p, rel + '/' + e.name);
      if (items.length >= 2000) break;
    }
    tree[rel] = items;
  };
  walk(rootDir, rootId);
  return tree;
}

/** 本地文件服务器：模拟 MainActivity.serveLocalFile / serveLocalThumb。只听 127.0.0.1、随机端口。
 *  opts.delayMs：每个请求先等这么久（SAF 每次都要枚举父目录定位文件，见摸底「本地文件链路」差距 2）
 *  opts.thumbDelayMs：缩略请求额外延迟；opts.mbps：限速（0 = 不限）
 *  opts.v2：新原生的档位 / 缓存头 / 304 / 解析缓存（见文件头 4；也可装好后改返回对象的 .v2） */
export async function startLocalServer({ roots, delayMs = 0, thumbDelayMs = 0, mbps = 0, cacheDir = path.join(QA_ROOT, 'localthumb-cache'), v2 = false } = {}) {
  mkdirSync(cacheDir, { recursive: true });
  const stats = { requests: 0, bytes: 0, thumbs: 0, thumbMiss: 0, byKind: {}, log: [] };
  const resolve = (rel) => {
    const [id, ...rest] = String(rel || '').split('/');
    const root = roots.find((r) => r.id === id) || roots[0];
    const inner = (roots.some((r) => r.id === id) ? rest : [id, ...rest]).join('/');
    const abs = path.resolve(root.dir, inner);
    if (abs !== root.dir && !abs.startsWith(root.dir + path.sep)) return null;   // 同原生 safeFile：不许跳出根
    return abs;
  };
  async function thumb(abs, tier) {
    const t = TIERS[tier];
    if (!t) return null;
    const st = statSync(abs);
    const key = createHash('sha1').update(abs + '|' + st.size + '|' + Math.round(st.mtimeMs) + '|' + tier).digest('hex');
    const out = path.join(cacheDir, key + '.jpg');
    if (existsSync(out)) return readFileSync(out);
    stats.thumbMiss++;
    let buf = null;
    if (VID.test(abs)) {
      // 视频抽 0.2s 一帧（同原生 MediaMetadataRetriever 取 0.2s）
      buf = await new Promise((res) => execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.2', '-i', abs, '-frames:v', '1', '-vf', `scale='min(${t.size},iw)':-2`, '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { encoding: 'buffer', maxBuffer: 32 << 20, timeout: 20000, windowsHide: true }, (err, so) => res(err || !so?.length ? null : so)));
    } else if (IMG.test(abs) && sharp && !t.video) {
      try { buf = await sharp(abs, { failOn: 'none', animated: false }).rotate().resize(t.size, t.size, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: t.q }).toBuffer(); } catch { buf = null; }
    }
    if (buf) writeFileSync(out, buf);
    return buf;
  }
  const wait = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : null);

  // —— v2 ——
  const seen = new Set();                      // 新原生 rel→docId LRU：同一个 rel 只付一次 SAF 定位延迟
  const breakOrig = new Set();                 // 测试钮：这些 rel 的原图请求回坏字节（模拟原图解不了），衍生档 / 区域块照常
  const dimsMemo = new Map();                  // 原图像素尺寸（未转正）：键含 size/mtime
  async function dimsV2(abs, st) {
    const k = abs + '|' + st.size + '|' + Math.round(st.mtimeMs);
    if (dimsMemo.has(k)) return dimsMemo.get(k);
    let d = null;
    try { const m = await sharp(abs, { failOn: 'none' }).metadata(); if (m.width && m.height) d = [m.width, m.height]; } catch {}
    dimsMemo.set(k, d);
    return d;
  }
  /** 衍生档：{ pass: true }（原图直出）| { buf, mime } | null（出不了 → 404） */
  async function tierV2(abs, st, ext, id, via) {
    const t = TIERS_V2[id];
    if (!t) return null;
    const isImg = IMG_V2.has(ext), isVid = VID.test(abs);
    if (!isImg && !isVid) return null;
    if (isVid && t.size <= 0) return null;
    if (isImg && !sharp) return null;
    if (isImg && PASS_V2.has(ext) && via !== 'orig') {
      const d = await dimsV2(abs, st);
      if (d && scaleForV2(id, t, d[0], d[1]) >= 0.999) return { pass: true };
    }
    const key = createHash('sha1').update(abs + '|' + st.size + '|' + Math.round(st.mtimeMs) + '|' + id + '|v2').digest('hex');
    for (const [e, mime] of [['.jpg', 'image/jpeg'], ['.webp', 'image/webp']]) {
      const f = path.join(cacheDir, key + e);
      if (existsSync(f)) return { buf: readFileSync(f), mime };
    }
    stats.thumbMiss++;
    let buf = null, mime = 'image/jpeg';
    if (isVid) {
      const S = t.size;
      buf = await new Promise((res) => execFile('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '0.2', '-i', abs, '-frames:v', '1', '-vf', `scale=w='min(${S},iw)':h='min(${S},ih)':force_original_aspect_ratio=decrease`, '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { encoding: 'buffer', maxBuffer: 32 << 20, timeout: 20000, windowsHide: true }, (err, so) => res(err || !so?.length ? null : so)));
    } else {
      try {
        const m = await sharp(abs, { failOn: 'none', limitInputPixels: false }).metadata();
        const L = Math.max(1, Math.round(Math.max(m.width, m.height) * scaleForV2(id, t, m.width, m.height)));
        const p = sharp(abs, { failOn: 'none', animated: false, limitInputPixels: false }).rotate().resize(L, L, { fit: 'inside', withoutEnlargement: true });
        if (m.hasAlpha) { mime = 'image/webp'; buf = await p.webp({ quality: t.q }).toBuffer(); }
        else buf = await p.jpeg({ quality: t.q }).toBuffer();
      } catch { buf = null; }
    }
    if (buf) writeFileSync(path.join(cacheDir, key + (mime === 'image/webp' ? '.webp' : '.jpg')), buf);
    return buf ? { buf, mime } : null;
  }
  /** 原图区域块：显示方向矩形 → 未转正的原始矩形（同原生 LocalMedia.rawRect），先裁再转正再缩到目标宽。null = 出不了 */
  async function regionV2(abs, st, q, wq) {
    if (!sharp) return null;
    const p = String(q).split(',').map((v) => Number.parseInt(v, 10));
    if (p.length !== 4 || p.some((v) => !Number.isFinite(v))) return null;
    const [x, y, w, h] = p;
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || h > w * 8 || w > h * 8) return null;
    let tw = Number.parseInt(wq, 10);
    if (!(tw > 0) || tw > w) tw = w;
    if (tw > 2048) return null;   // 块输出宽上限（前端一块 512 设备像素）
    const id = `r${x}_${y}_${w}_${h}_${tw}`;
    const key = createHash('sha1').update(abs + '|' + st.size + '|' + Math.round(st.mtimeMs) + '|' + id + '|v2').digest('hex');
    for (const [e, mime] of [['.jpg', 'image/jpeg'], ['.webp', 'image/webp']]) {
      const f = path.join(cacheDir, key + e);
      if (existsSync(f)) return { id, buf: readFileSync(f), mime };
    }
    stats.thumbMiss++;
    try {
      const m = await sharp(abs, { failOn: 'none', limitInputPixels: false }).metadata();
      const o = m.orientation || 1, W = m.width, H = m.height;
      const dW = o >= 5 ? H : W, dH = o >= 5 ? W : H;
      const x0 = Math.min(x, dW), y0 = Math.min(y, dH), x1 = Math.min(x + w, dW), y1 = Math.min(y + h, dH);
      if (x1 - x0 < 1 || y1 - y0 < 1) return null;
      const outW = Math.max(1, Math.round((tw * (x1 - x0)) / w));
      let a;
      switch (o) {
        case 2: a = [W - x0, y0, W - x1, y1]; break;
        case 3: a = [W - x0, H - y0, W - x1, H - y1]; break;
        case 4: a = [x0, H - y0, x1, H - y1]; break;
        case 5: a = [y0, x0, y1, x1]; break;
        case 6: a = [y0, H - x0, y1, H - x1]; break;
        case 7: a = [W - y0, H - x0, W - y1, H - x1]; break;
        case 8: a = [W - y0, x0, W - y1, x1]; break;
        default: a = [x0, y0, x1, y1];
      }
      const raw = { left: Math.min(a[0], a[2]), top: Math.min(a[1], a[3]), width: Math.abs(a[2] - a[0]), height: Math.abs(a[3] - a[1]) };
      // extract 写在 rotate 前 = 先在原始坐标上裁、再按 EXIF 转正（已用 EXIF 方向 6 样张核对过与「整图转正后裁」逐像素一致）
      let pl = sharp(abs, { failOn: 'none', animated: false, limitInputPixels: false }).extract(raw).rotate();
      if (outW < x1 - x0) pl = pl.resize({ width: outW });
      const mime = m.hasAlpha ? 'image/webp' : 'image/jpeg';
      const buf = m.hasAlpha ? await pl.webp({ quality: 85 }).toBuffer() : await pl.jpeg({ quality: 85 }).toBuffer();
      writeFileSync(path.join(cacheDir, key + (m.hasAlpha ? '.webp' : '.jpg')), buf);
      return { id, buf, mime };
    } catch { return null; }
  }
  async function serveV2(req, res, t0) {
    const u = new URL(req.url, 'http://x');
    const rel = u.searchParams.get('rel') || '';
    const abs = resolve(rel);
    const isExif = u.searchParams.get('exif') === '1';
    let tier = u.searchParams.get('thumb');
    stats.requests++;
    const kind = isExif ? 'exif' : tier ? 'thumb:' + tier : u.searchParams.has('region') ? 'region' : (req.headers.range ? 'range' : 'full');
    const count = (k) => { stats.byKind[k] = (stats.byKind[k] || 0) + 1; };
    count(kind);
    if (!seen.has(rel)) { seen.add(rel); stats.resolveMiss = (stats.resolveMiss || 0) + 1; await wait(delayMs); }
    const done = (code, bytes, extra) => stats.log.push({ rel, kind, code, ms: Date.now() - t0, bytes, ...extra });
    if (!abs || !existsSync(abs) || !statSync(abs).isFile()) { res.writeHead(404); res.end(); done(404, 0); return; }
    const st = statSync(abs), ext = extOf(abs);
    if (isExif) {
      const body = Buffer.from(JSON.stringify(await mediaInfoV2(abs)));
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
      res.end(body); done(200, body.length); return;
    }
    const mt = Math.round(st.mtimeMs);
    // 区域块（&region=x,y,w,h&w=目标宽，显示方向坐标）：同原生 serveLocalRegion——原图开关关着、放大超过 max 档时前端只拉可见区
    const regionQ = u.searchParams.get('region');
    if (regionQ != null) {
      const r = IMG_V2.has(ext) && ext !== 'gif' ? await regionV2(abs, st, regionQ, u.searchParams.get('w')) : null;
      if (!r) { res.writeHead(404); res.end(); done(404, 0, { tier: 'region' }); return; }
      const h = { 'Cache-Control': 'private, max-age=86400', ETag: `"${st.size.toString(16)}-${mt.toString(16)}-${r.id}"`, 'Last-Modified': new Date(mt).toUTCString() };
      const inm = String(req.headers['if-none-match'] || '');
      if (inm && inm.includes(h.ETag)) { count('304'); res.writeHead(304, h); res.end(); done(304, 0, { tier: 'region' }); return; }
      Object.assign(h, { 'Content-Type': r.mime, 'Content-Length': r.buf.length, 'X-Bridge-Tier': 'region' });
      res.writeHead(200, h); res.end(r.buf);
      stats.bytes += r.buf.length; done(200, r.buf.length, { tier: 'region', region: regionQ }); return;
    }
    // 原图一律回原字节（不按 Accept / 像素数静默降档——「原图加载」开着就是真原图）；
    // 唯一例外：HEIC 被 <img> 要（Accept: image/…，或 &as=jpeg / &view=1）→ 全分辨率转 JPEG（full 档，不封顶）
    if (!tier && breakOrig.has(rel)) {
      const junk = Buffer.from('not an image');
      res.writeHead(200, { 'Content-Type': mimeOf(abs), 'Content-Length': junk.length, 'Cache-Control': 'no-store' });
      res.end(junk); stats.bytes += junk.length; done(200, junk.length, { broken: true }); return;
    }
    let via = null;
    const heif = ext === 'heic' || ext === 'heif';
    if (!tier && heif) {
      const imgAccept = String(req.headers.accept || '').startsWith('image/');
      const forImg = req.headers.range ? imgAccept : imgAccept || u.searchParams.get('as') === 'jpeg' || u.searchParams.get('view') === '1';
      if (forImg) { tier = 'full'; via = 'orig'; }
    }
    const headers = { 'Cache-Control': 'private, max-age=86400', ETag: `"${st.size.toString(16)}-${mt.toString(16)}${tier ? '-' + tier : ''}"`, 'Last-Modified': new Date(mt).toUTCString() };
    if (!tier && heif) headers.Vary = 'Accept';
    const inm = String(req.headers['if-none-match'] || '');
    if (inm && inm.includes(headers.ETag)) { count('304'); res.writeHead(304, headers); res.end(); done(304, 0, { tier }); return; }
    if (tier) {
      await wait(thumbDelayMs);
      const r = await tierV2(abs, st, ext, tier, via);
      stats.thumbs++;
      if (r && !r.pass) {
        headers['Content-Type'] = r.mime; headers['Content-Length'] = r.buf.length; headers['X-Bridge-Tier'] = tier;
        if (via === 'orig' && heif) headers['X-Bridge-Converted'] = ext;
        if (TIERS_V2[tier]?.size === 0) {   // max 档：原图比它大时标出原尺寸（只有显式 &thumb=max 才会走到）
          const d = await dimsV2(abs, st);
          if (d && d[0] * d[1] > SAFE_PIXELS) headers['X-Bridge-Downscaled'] = d[0] + 'x' + d[1];
        }
        res.writeHead(200, headers); res.end(r.buf);
        stats.bytes += r.buf.length; done(200, r.buf.length, { tier }); return;
      }
      if (r && r.pass) headers['X-Bridge-Tier'] = tier + '; passthrough';
      else { res.writeHead(404); res.end(); done(404, 0, { tier }); return; }   // 衍生档出不了一律 404（HEIC 原图解不了也是）
    }
    const size = st.size;
    Object.assign(headers, { 'Accept-Ranges': 'bytes', 'Content-Type': mimeOf(abs) });
    let start = 0, end = size - 1, code = 200;
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
    if (m && size > 0) {
      if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); }
      else { start = Number(m[1] || 0); if (m[2] !== '') end = Math.min(size - 1, Number(m[2])); }
      if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); res.end(); done(416, 0); return; }
      code = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(code, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    const rs = createReadStream(abs, { start, end, highWaterMark: 256 << 10 });
    if (mbps > 0) {
      const bps = (mbps * 1e6) / 8;
      rs.on('data', (ch) => { rs.pause(); setTimeout(() => rs.resume(), (ch.length / bps) * 1000); });
    }
    rs.on('data', (ch) => { stats.bytes += ch.length; });
    rs.on('end', () => done(code, end - start + 1, tier ? { tier } : undefined));
    rs.on('error', () => res.destroy());
    rs.pipe(res);
  }

  const server = createServer(async (req, res) => {
    const t0 = Date.now();
    try {
      if (api.v2) return await serveV2(req, res, t0);
      const u = new URL(req.url, 'http://x');
      const rel = u.searchParams.get('rel') || '';
      const tier = u.searchParams.get('thumb');
      const abs = resolve(rel);
      stats.requests++;
      const kind = tier ? 'thumb:' + tier : (req.headers.range ? 'range' : 'full');
      stats.byKind[kind] = (stats.byKind[kind] || 0) + 1;
      await wait(delayMs);
      if (!abs || !existsSync(abs) || !statSync(abs).isFile()) { res.writeHead(404); res.end(); return; }
      if (tier) {
        await wait(thumbDelayMs);
        const buf = await thumb(abs, tier);
        stats.thumbs++;
        if (!buf) { res.writeHead(404); res.end(); return; }   // 缩略失败一律 404，绝不回原字节（同原生）
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length });
        res.end(buf);
        stats.bytes += buf.length;
        stats.log.push({ rel, kind, ms: Date.now() - t0, bytes: buf.length });
        return;
      }
      const size = statSync(abs).size;
      const headers = { 'Accept-Ranges': 'bytes', 'Content-Type': mimeOf(abs) };   // 同原生：没有缓存头、没有校验器
      let start = 0, end = size - 1, code = 200;
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || '').trim());
      if (m && size > 0) {
        if (m[1] === '' && m[2] !== '') { start = Math.max(0, size - Number(m[2])); }
        else { start = Number(m[1] || 0); if (m[2] !== '') end = Math.min(size - 1, Number(m[2])); }
        if (start > end || start >= size) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); res.end(); return; }
        code = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
      }
      headers['Content-Length'] = end - start + 1;
      res.writeHead(code, headers);
      if (req.method === 'HEAD') { res.end(); return; }
      const rs = createReadStream(abs, { start, end, highWaterMark: 256 << 10 });
      if (mbps > 0) {
        const bps = (mbps * 1e6) / 8;
        rs.on('data', (ch) => { rs.pause(); setTimeout(() => rs.resume(), (ch.length / bps) * 1000); });
      }
      rs.on('data', (ch) => { stats.bytes += ch.length; });
      rs.on('end', () => stats.log.push({ rel, kind, ms: Date.now() - t0, bytes: end - start + 1 }));
      rs.on('error', () => res.destroy());
      rs.pipe(res);
    } catch (e) { try { res.writeHead(500); res.end(String(e.message || e)); } catch {} }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const api = { port, stats, v2: !!v2, breakOrig, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
  return api;
}

/** 页面里注入的桩（见文件头）。tree = scanTree 的结果，roots = [{id,name,mode}] */
export function androidStubSource({ tree, roots, flags = {} }) {
  return String.raw`(() => {
  window.__BRIDGE_DEV_OFFLINE__ = true;
  try { if (!localStorage.getItem('bridge-server')) localStorage.setItem('bridge-server', location.origin); } catch {}
  const TREE = ${JSON.stringify(tree)};
  const ROOTS = ${JSON.stringify(roots)};
  const FLAGS = ${JSON.stringify(flags)};
  const rec = window.__pvqaLocal = { calls: [], miss: {}, reads: 0 };
  const log = (fn, args) => { rec.calls.push({ fn, args, at: performance.now() }); if (rec.calls.length > 500) rec.calls.shift(); };
  const ok = (name) => JSON.stringify({ ok: true, name: name || '' });
  const syncRead = (rel, max, binary) => {
    const x = new XMLHttpRequest();
    x.open('GET', '/__localfile?rel=' + encodeURIComponent(rel), false);
    x.setRequestHeader('Range', 'bytes=0-' + (max - 1));
    if (binary) x.overrideMimeType('text/plain; charset=x-user-defined');
    try { x.send(); } catch { return null; }
    rec.reads++;
    if (x.status !== 200 && x.status !== 206) return null;
    return x.responseText;
  };
  const impl = {
    // 存储：返回 null 让 store.js 回落 localStorage（真机是 SharedPreferences，桩里不碰）
    get: () => null, set: (k, v) => log('set', [k]), remove: (k) => log('remove', [k]),
    setLang: (l) => log('setLang', [l]),
    hasLocalRoot: () => ROOTS.length > 0, hasAllFiles: () => false,
    localRoots: () => JSON.stringify(ROOTS),
    localRootName: () => (ROOTS[0] && ROOTS[0].name) || '',
    pickLocalRoot: () => { log('pickLocalRoot', []); setTimeout(() => window.__onLocalRoot && window.__onLocalRoot(), 50); },
    removeLocalRoot: (id) => log('removeLocalRoot', [id]), clearLocalRoot: () => log('clearLocalRoot', []),
    hasLocalThumb: () => FLAGS.thumb !== false,
    // 预览档（&thumb=preview：长边 1600~2048、EXIF 转正、HEIC 转 JPEG）——安卓线新增的原生能力，前端据此给本地图片配 previewUrl
    // 旧 apk 没有这个方法的那一代：默认 false；新 apk 走 mode 'apk2'（v2 桩补上），或场景显式传 local: { preview: true }
    hasLocalPreview: () => FLAGS.thumb !== false && FLAGS.preview === true,
    localList: (rel) => {
      rel = String(rel || '').replace(/\/+$/, '');
      if (!rel) return JSON.stringify({ items: ROOTS.map((r) => ({ name: r.id, label: r.name, isDir: true, root: true, mode: r.mode })) });
      const items = TREE[rel];
      return items ? JSON.stringify({ items }) : JSON.stringify({ error: '读取失败' });
    },
    localReadText: (rel) => { log('localReadText', [rel]); const s = syncRead(rel, 2 * 1024 * 1024, true); if (s == null) return null;
      try { const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return new TextDecoder('utf-8').decode(u); } catch { return s; } },
    localReadB64: (rel) => { log('localReadB64', [rel]); const s = syncRead(rel, 8 * 1024 * 1024, true); if (s == null) return null;
      let bin = ''; for (let i = 0; i < s.length; i += 0x8000) bin += String.fromCharCode.apply(null, Array.from(s.slice(i, i + 0x8000), (c) => c.charCodeAt(0) & 255)); return btoa(bin); },
    localWrite: (rel, content, b64) => { log('localWrite', [rel, String(content || '').length, !!b64]); return ok(String(rel).split('/').pop()); },
    localDelete: (rel) => { log('localDelete', [rel]); return ok(); },
    localRename: (rel, n) => { log('localRename', [rel, n]); return ok(n); },
    localMove: (s, d) => { log('localMove', [s, d]); return ok(); },
    localCopy: (s, d) => { log('localCopy', [s, d]); return ok(); },
    localScan: (rel) => { log('localScan', [rel]); return JSON.stringify({ items: [] }); },
    openWith: (url, rel, name, isLocal) => log('openWith', [url, rel, name, isLocal]),
    shareFile: (url, rel, name, isLocal) => log('shareFile', [url, rel, name, isLocal]),
    setOrientation: (m) => log('setOrientation', [m]),
    haptic: (k) => log('haptic', [k]),
    setLightSystemBars: (l) => log('setLightSystemBars', [l]),
    setStatusBarHidden: (h) => log('setStatusBarHidden', [h]),
  };
  // 可选扩展：后注入的脚本（如 androidStubV2Source）往桩上补方法；f 拿到 { TREE, ROOTS, FLAGS, log, rec } 回一组方法
  rec.extend = (f) => Object.assign(impl, f({ TREE, ROOTS, FLAGS, log, rec }));
  const proxy = new Proxy(impl, {
    get(t, k) { if (typeof k === 'string' && !(k in t)) rec.miss[k] = (rec.miss[k] || 0) + 1; return t[k]; },
    has(t, k) { return k in t; },
    set() { return true; },
  });
  // getter 陷阱：页面拿到的永远是桩，改写不了（真机 dev 联调时也用这招挡住正式 AndroidStore）
  Object.defineProperty(window, 'AndroidStore', { get: () => proxy, set: () => {}, configurable: false, enumerable: false });
})();`;
}

/** v2 页面桩：新 apk 的原生方法（签名照 MainActivity.NativeStore）。只记录调用；异步的照原生经 window.__bridgeLocalDone(token, json) 回。
 *  opts：{ gallery=true, reveal=true, wallpaper=true, pip=true }——false 即模拟「这台机器 / ROM 没有这项能力」 */
export function androidStubV2Source(opts = {}) {
  return String.raw`(() => {
  const L = window.__pvqaLocal;
  if (!L || !L.extend) return;
  const O = ${JSON.stringify(opts)};
  const MIMES = ${JSON.stringify(MIME)};
  L.v2 = true;
  L.extend(({ TREE, log }) => {
    const done = (token, v, ms) => setTimeout(() => { try { window.__bridgeLocalDone && window.__bridgeLocalDone(token, v); } catch {} }, ms || 0);
    const node = (rel) => {
      rel = String(rel || '').replace(/\/+$/, '');
      const i = rel.lastIndexOf('/'), name = rel.slice(i + 1);
      return (TREE[rel.slice(0, i)] || []).find((x) => x.name === name && !x.isDir) || null;
    };
    const m = {
      hasLocalPreview: () => true,
      hasLocalRegion: () => true,
      localStat: (rel) => {
        log('localStat', [rel]);
        const n = node(rel);
        return n ? JSON.stringify({ ok: true, name: n.name, size: n.size, mtime: n.mtime, mime: MIMES[(n.name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream' }) : '{"ok":false}';
      },
      localExif: (rel, token) => {
        log('localExif', [rel]);
        fetch('/__localfile?rel=' + encodeURIComponent(rel) + '&exif=1').then((r) => (r.ok ? r.json() : { ok: false })).catch(() => ({ ok: false })).then((v) => done(token, v));
      },
      hasPip: () => O.pip !== false,
      enterPip: (w, h) => { log('enterPip', [w, h]); setTimeout(() => window.dispatchEvent(new CustomEvent('bridge-pip', { detail: { active: true } })), 60); return true; },
      setPipAuto: (on, w, h) => log('setPipAuto', [on, w, h]),
      keepScreenOn: (on) => log('keepScreenOn', [on]),
    };
    if (O.gallery !== false) Object.assign(m, {
      hasSaveToGallery: () => true,
      localSaveToGallery: (rel, token) => { log('localSaveToGallery', [rel]); done(token, { ok: true, album: /\.(mp4|m4v|mov|webm|mkv|3gp)$/i.test(rel) ? 'Movies/Bridge' : 'Pictures/Bridge' }, 400); },
    });
    if (O.wallpaper !== false) Object.assign(m, { hasSetWallpaper: () => true, localSetWallpaper: (rel) => log('localSetWallpaper', [rel]) });
    if (O.reveal !== false) Object.assign(m, { canReveal: () => true, localReveal: (rel) => { log('localReveal', [rel]); return true; } });
    return m;
  });
})();`;
}

/**
 * 给一个页面装上本地桩。须在 Page.navigate 之前调用（注入脚本只对之后的新文档生效）。
 * opts：{ delayMs, thumbDelayMs, mbps, rootId='qa', rootName='预览样张', dir=SAMPLES_DIR, thumb=true, preview=false（hasLocalPreview；旧 apk 默认没有） }
 * 返回 { server, rootId, rel(p), uninstall() }：rel('图片/透明.png') → 'qa/图片/透明.png'
 */
export async function installLocalStub(pg, opts = {}) {
  const rootId = opts.rootId || 'qa';
  const dir = path.resolve(opts.dir || SAMPLES_DIR);
  const roots = [{ id: rootId, name: opts.rootName || '预览样张', mode: 'saf', dir }];
  const server = await startLocalServer({ roots, delayMs: opts.delayMs || 0, thumbDelayMs: opts.thumbDelayMs || 0, mbps: opts.mbps || 0 });
  const tree = scanTree(dir, rootId);
  const { identifier } = await pg.send('Page.addScriptToEvaluateOnNewDocument', { source: androidStubSource({ tree, roots: roots.map(({ id, name, mode }) => ({ id, name, mode })), flags: { thumb: opts.thumb !== false, preview: opts.preview === true } }) });
  await pg.send('Fetch.enable', { patterns: [{ urlPattern: '*__localfile*', requestStage: 'Request' }, { urlPattern: '*/api/lan*', requestStage: 'Request' }] });
  let alive = true;
  const onPaused = async (p, sid) => {
    if (!alive || sid !== pg.sessionId) return;   // cdp.mjs 的 on() 摘不掉：卸载后靠 alive 让旧处理器让路
    const u = new URL(p.request.url);
    try {
      if (u.pathname === '/__localfile') {
        await pg.send('Fetch.continueRequest', { requestId: p.requestId, url: `http://127.0.0.1:${server.port}/__localfile${u.search}` });
      } else if (u.pathname === '/api/lan') {
        const body = Buffer.from(JSON.stringify({ ips: [], port: 0 })).toString('base64');
        await pg.send('Fetch.fulfillRequest', { requestId: p.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'application/json' }], body });
      } else await pg.send('Fetch.continueRequest', { requestId: p.requestId });
    } catch { try { await pg.send('Fetch.continueRequest', { requestId: p.requestId }); } catch {} }
  };
  pg.conn.on('Fetch.requestPaused', onPaused);
  // opts.v2（true 或 androidStubV2Source 的 opts）：新 apk——文件服务器切新原生行为、页面桩补新方法（排在桩脚本之后注入）
  let v2id = null;
  if (opts.v2) {
    server.v2 = true;
    ({ identifier: v2id } = await pg.send('Page.addScriptToEvaluateOnNewDocument', { source: androidStubV2Source(opts.v2 === true ? {} : opts.v2) }));
  }
  return {
    server, rootId, dir, v2: !!opts.v2,
    rel: (p) => rootId + '/' + String(p).replace(/^\/+/, ''),
    async uninstall() {
      if (!alive) return; alive = false;
      if (v2id) try { await pg.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: v2id }); } catch {}
      try { await pg.send('Page.removeScriptToEvaluateOnNewDocument', { identifier }); } catch {}
      try { await pg.send('Fetch.disable'); } catch {}
      await server.close();
    },
  };
}
