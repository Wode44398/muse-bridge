// 响应压缩（2026-10-21）：源站以前一律不压缩——走 Cloudflare 隧道时边缘可能替你压，LAN 直连（apk 在家自动走直连）
// 拿到的是原始体积：一次冷启动约 8MB（app-main.js / DragLayer.js 各 ~940KB、两份 CSS 共 ~780KB），
// 大会话的 /api/session 也有 ~1MB JSON。
//
// 两条路：
//   · 静态产物（/app/*，static.mjs）：按 Accept-Encoding 优先 br（q9，1MB JS 约 35ms）其次 gzip，压一次按
//     「路径 + 大小 + mtime」记在内存里（产物带 hash 不会变；没 hash 的改了 mtime 就换），总量封顶。
//     旁边要是有构建时预压好的 .br / .gz（比原文件新）就直接发它。
//   · 大 JSON（sendJson）：超过 64KB 才 gzip，压缩在 zlib 线程池里跑，不占主线程。
// 压缩都是异步的；压缩失败一律回落原文，不影响功能。
import zlib from 'node:zlib';
import { promisify } from 'node:util';
import { promises as fsp } from 'node:fs';

const gzipAsync = promisify(zlib.gzip);
const brotliAsync = promisify(zlib.brotliCompress);

// 已经压过的格式（woff2 / 图片 / 音视频 / zip）再压只是白烧 CPU
const COMPRESSIBLE = /\.(?:m?js|css|html?|json|map|svg|txt|webmanifest|wasm|xml|ttf|otf|ico)$/i;
const MIN_BYTES = 1024;
const MEMO_MAX = 64 * 1024 * 1024;

/** 客户端接受哪种编码：'br' | 'gzip' | ''（q=0 视为不接受）。 */
export function pickEncoding(req, { br = true } = {}) {
  const raw = String((req && req.headers && req.headers['accept-encoding']) || '').toLowerCase();
  if (!raw) return '';
  const ok = (name) => raw.split(',').some((part) => {
    const [n, ...params] = part.trim().split(';');
    if (n.trim() !== name) return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  });
  if (br && ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return '';
}

const brOpts = (len) => ({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: len } });

// file -> { sig, enc: { br?: Promise<Buffer>, gzip?: Promise<Buffer> }, bytes }
const memo = new Map();
let memoBytes = 0;
function remember(file, sig) {
  let m = memo.get(file);
  if (m && m.sig !== sig) { memoBytes -= m.bytes; memo.delete(file); m = null; }
  if (!m) { m = { sig, enc: {}, bytes: 0 }; memo.set(file, m); }
  else { memo.delete(file); memo.set(file, m); }   // LRU：挪到最新
  return m;
}
function trimMemo() {
  for (const [k, m] of memo) {
    if (memoBytes <= MEMO_MAX) break;
    memoBytes -= m.bytes;
    memo.delete(k);
  }
}

async function prebuilt(file, ext, st) {
  try {
    const p = await fsp.stat(file + ext);
    if (p.isFile() && p.mtimeMs >= st.mtimeMs) return fsp.readFile(file + ext);
  } catch {}
  return null;
}

/**
 * 静态文件的压缩版。st = 原文件的 stat，buf = 原文件内容（已读进来的）。
 * → { enc:'br'|'gzip', body:Buffer } 或 null（不压：类型不合适 / 太小 / 客户端不收 / 压完没变小）。
 */
export async function compressedStatic(req, file, st, buf) {
  if (!COMPRESSIBLE.test(file) || st.size < MIN_BYTES) return null;
  const enc = pickEncoding(req);
  if (!enc) return null;
  const m = remember(file, st.size + ':' + Math.round(st.mtimeMs));
  if (!m.enc[enc]) {
    m.enc[enc] = (async () => {
      const pre = await prebuilt(file, enc === 'br' ? '.br' : '.gz', st);
      const out = pre || (enc === 'br' ? await brotliAsync(buf, brOpts(buf.length)) : await gzipAsync(buf, { level: 6 }));
      if (memo.get(file) === m) { m.bytes += out.length; memoBytes += out.length; trimMemo(); }   // 压的时候被挤出去了就不记账
      return out;
    })();
    m.enc[enc].catch(() => { if (memo.get(file) === m) delete m.enc[enc]; });
  }
  try {
    const body = await m.enc[enc];
    return body.length < buf.length ? { enc, body } : null;
  } catch { return null; }
}

/**
 * 回 JSON：超过 min 字节、客户端收 gzip 时压缩（线程池里压）。headers 会并进响应头。
 * 只给一次性的大响应用（/api/session 这类）；小响应原样回，省一次线程池往返。
 */
export async function sendJson(req, res, obj, { status = 200, headers = {}, min = 64 * 1024 } = {}) {
  const body = JSON.stringify(obj);
  if (body.length >= min && pickEncoding(req, { br: false }) === 'gzip') {
    try {
      const z = await gzipAsync(body, { level: 6 });
      if (res.headersSent || res.destroyed) return;
      res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', ...headers });
      res.end(z);
      return;
    } catch {}
  }
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(body);
}
