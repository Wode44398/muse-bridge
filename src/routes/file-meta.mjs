// 文件列表的二次补充元数据：GET /api/files/meta?path=<目录>&ws=<工作区>
//   图片 → 宽高（sharp 只读文件头；EXIF 方向 5~8 交换宽高，与显示一致）
//   视频 → 宽高与时长（ffprobe；旋转 ±90° 交换宽高）
//   音频 → 时长
//   文件夹 → 项目数（与列表同一套隐藏规则）
// 列表接口（/api/files）保持原样、首屏不等这些；前端拿到列表先渲染，再调这里补角标与描述符。
// 已缓存的立刻回；没算过的放进后台任务（并发有上限），本次请求最多等 BUDGET_MS，没算完的数在 pending 里，
// 前端隔一会儿再要一次。结果按（路径|mtime|大小）缓存在内存，并定期落盘到 thumb-cache/meta-v1.json，重启不用重算。
// 软链（含 Windows junction）先 realpath 再判作用域：指到作用域外的不算、不探测（safeJoin 只做词法检查，
// 别让这个端点成为读越界文件尺寸 / 时长 / 子项数的通道）；目录本身经软链落到作用域外时整页不补。
import path from 'node:path';
import { execFile } from 'node:child_process';
import { mkdir, readdir, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { requireReadCtx } from '../runtime/identity.mjs';
import { DATA_ROOT } from '../runtime/paths.mjs';
import { safeJoin, withinRoot } from '../runtime/http-file.mjs';
import { bad, hiddenInList, okJson, scopeCtx } from './file-core.mjs';

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'tif', 'tiff', 'avif', 'heic', 'heif']);
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi', '3gp', 'ts', 'flv', 'wmv', 'mpg', 'mpeg']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'flac', 'wma', 'amr']);
const MAX_ENTRIES = 1500;
const BUDGET_MS = 350;
const PROBE_TIMEOUT = 15_000;
const CACHE_FILE = path.join(DATA_ROOT, 'thumb-cache', 'meta-v1.json');
const CACHE_CAP = 30_000;

function gate(limit) {
  let active = 0;
  const queue = [];
  return async (fn) => {
    if (active >= limit) await new Promise((resolve) => queue.push(resolve));
    active++;
    try { return await fn(); }
    finally {
      active--;
      queue.shift()?.();
    }
  };
}
const probeGate = gate(2);   // ffprobe：每个几十毫秒，但一个视频文件夹能有上百个
const headGate = gate(6);    // sharp 读图片头 / readdir 数子项

// —— 缓存：Map 保持插入顺序，超上限从最旧的删；落盘防抖 + 异步写（满 3 万条时 JSON 有好几 MB，
//     同步写会把事件循环卡几十毫秒）；上一次还没写完就不叠第二次，写完再补一次 ——
let cache = null;
let saveTimer = null;
let saving = false;
let dirty = false;
function loadCache() {
  if (cache) return cache;
  cache = new Map();
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
    for (const [key, value] of Object.entries(raw || {})) cache.set(key, value);
  } catch {}
  return cache;
}
function scheduleSave() {
  dirty = true;
  if (saveTimer || saving) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 3000);
  saveTimer.unref?.();
}
async function saveNow() {
  if (saving) return;
  saving = true;
  dirty = false;
  try {
    const body = JSON.stringify(Object.fromEntries(cache));
    await mkdir(path.dirname(CACHE_FILE), { recursive: true });
    await writeFile(CACHE_FILE + '.tmp', body);
    await rename(CACHE_FILE + '.tmp', CACHE_FILE);
  } catch {}
  finally {
    saving = false;
    if (dirty) scheduleSave();
  }
}
function remember(key, value, persist = true) {
  const c = loadCache();
  c.delete(key);
  c.set(key, value);
  while (c.size > CACHE_CAP) c.delete(c.keys().next().value);
  if (persist) scheduleSave();
}

function probe(file) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height:stream_side_data=rotation:stream_tags=rotate:format=duration',
      '-of', 'json', file,
    ], { timeout: PROBE_TIMEOUT, windowsHide: true, maxBuffer: 1 << 20 }, (error, stdout) => {
      if (error) { resolve(null); return; }
      try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
    });
  });
}

const round1 = (n) => Math.round(n * 10) / 10;

async function imageMeta(file) {
  try {
    const sharp = (await import('sharp')).default;
    const m = await sharp(file).metadata();
    if (!m.width || !m.height) return {};
    const swap = m.orientation >= 5 && m.orientation <= 8;
    return swap ? { w: m.height, h: m.width } : { w: m.width, h: m.height };
  } catch {
    return {};
  }
}

async function mediaMeta(file, video) {
  const out = await probe(file);
  if (!out) return {};
  const meta = {};
  const dur = Number(out.format?.duration);
  if (Number.isFinite(dur) && dur > 0) meta.dur = round1(dur);
  const s = video ? out.streams?.[0] : null;
  if (s?.width && s?.height) {
    const rot = Number(s.side_data_list?.find((d) => d && 'rotation' in d)?.rotation ?? s.tags?.rotate ?? 0);
    const swap = Math.abs(rot) % 180 === 90;
    meta.w = swap ? s.height : s.width;
    meta.h = swap ? s.width : s.height;
  }
  return meta;
}

async function dirCount(ctx, abs, rel) {
  try {
    const names = await readdir(abs);
    return { n: names.filter((name) => !hiddenInList(ctx, name, rel)).length };
  } catch {
    return {};
  }
}

const jobs = new Map();
function compute(key, fn, gateFn, persist) {
  const hit = loadCache().get(key);
  if (hit) return null;
  let job = jobs.get(key);
  if (!job) {
    job = gateFn(fn)
      .then((value) => { remember(key, value || {}, persist); })
      .catch(() => { remember(key, {}, persist); })
      .finally(() => jobs.delete(key));
    jobs.set(key, job);
  }
  return job;
}

export async function handleFilesMeta(req, res, url, identify) {
  let ctx = requireReadCtx(identify, req, res);
  if (!ctx) return;
  ctx = scopeCtx(ctx, url.searchParams.get('ws'), res);
  if (!ctx) return;
  const rel = url.searchParams.get('path') || '';
  const dir = safeJoin(ctx.cwd, rel);
  if (!dir) return bad(res, 403, 'forbidden');
  try {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return bad(res, 404, 'not found'); }
    const here = path.relative(path.resolve(ctx.cwd), dir).split(path.sep).join('/');
    // 作用域按真实路径判：根自己是软链也认（同一套 realpath 比较）
    const realRoot = await realpath(ctx.cwd).catch(() => path.resolve(ctx.cwd));
    const inScope = async (abs) => {
      const real = await realpath(abs).catch(() => null);
      return !!real && withinRoot(realRoot, real);
    };
    if (!(await inScope(dir))) return okJson(res, { path: here, items: {}, pending: 0 });
    const picked = [];
    for (const entry of entries) {
      if (hiddenInList(ctx, entry.name, here)) continue;
      const ext = path.extname(entry.name).slice(1).toLowerCase();
      // 软链先于扩展名判：叫 *.jpg / *.mp4 的软链也要过作用域检查，按指向的东西归类
      const link = entry.isSymbolicLink();
      const media = IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : AUDIO_EXT.has(ext) ? 'audio' : null;
      const kind = entry.isDirectory() ? 'dir' : media;
      if (kind || link) picked.push({ name: entry.name, kind, link });
      if (picked.length >= MAX_ENTRIES) break;
    }
    const stats = await Promise.all(picked.map(async (p) => {
      const abs = path.join(dir, p.name);
      if (p.link && !(await inScope(abs))) return null;
      return stat(abs).catch(() => null);
    }));
    const keys = [];
    const waits = [];
    picked.forEach((p, index) => {
      const st = stats[index];
      if (!st) return;
      const abs = path.join(dir, p.name);
      let kind = p.kind;
      if (p.link) {
        // 指向文件夹的软链按文件夹数子项；指向文件的按自己的扩展名归类（不是媒体就不补）
        if (st.isDirectory()) kind = 'dir';
        else if (!st.isFile() || kind === 'dir') return;
      }
      if (!kind) return;
      const childRel = here ? here + '/' + p.name : p.name;
      // 文件夹的项目数只存内存（readdir 很便宜，目录 mtime 一变键就变）；媒体元数据落盘
      const key = kind === 'dir' ? `${abs}|d|${st.mtimeMs}` : `${abs}|${st.mtimeMs}|${st.size}`;
      keys.push([p.name, key]);
      const job = kind === 'dir'
        ? compute(key, () => dirCount(ctx, abs, childRel), headGate, false)
        : kind === 'image'
          ? compute(key, () => imageMeta(abs), headGate, true)
          : compute(key, () => mediaMeta(abs, kind === 'video'), probeGate, true);
      if (job) waits.push(job);
    });
    if (waits.length) {
      let timer;
      await Promise.race([
        Promise.all(waits),
        new Promise((resolve) => { timer = setTimeout(resolve, BUDGET_MS); }),
      ]);
      clearTimeout(timer);
    }
    const c = loadCache();
    const items = {};
    let pending = 0;
    for (const [name, key] of keys) {
      const value = c.get(key);
      if (!value) { pending++; continue; }
      if (Object.keys(value).length) items[name] = value;
    }
    okJson(res, { path: here, items, pending });
  } catch {
    if (!res.headersSent) bad(res, 500, 'read error');
  }
}
