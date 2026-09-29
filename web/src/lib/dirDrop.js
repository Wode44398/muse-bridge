// 从桌面拖进来的「文件夹」怎么变成一串文件 —— Composer（挂载文件夹给 Claude 按需读）
// 与 FilesPanel（网盘式整树上传）共用。
//
// 三个绕不开的浏览器坑：
// ① dataTransfer 在事件处理函数【同步段】结束后就失效——必须先同步把 webkitGetAsEntry()
//    抓出来存好，再去 await 遍历，否则拿到一堆 null。
// ② DirectoryReader.readEntries() 每次最多吐 ~100 条，必须反复读到返回空数组为止，
//    不然大文件夹会被静默截断（只上传前 100 个）。
// ③ 手机/触屏没有文件夹拖拽；`<input webkitdirectory>` 走的是 webkitRelativePath 那条路，
//    所以这里两条入口都给。

import { t, isEn } from './i18n.js';

const SKIP_DIRS = new Set(['node_modules', '.git', '.svn', '.hg', '__pycache__', '.DS_Store']);
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini']);

export const DIR_LIMITS = { maxFiles: 500, maxBytes: 300 * 1024 * 1024, maxFileBytes: 100 * 1024 * 1024 };

// 拖进来的东西里有没有文件夹（有就走整树流程，没有就沿用原来的「一把文件」逻辑）。
// 必须在事件同步段调用。
export function dropHasDirs(e) {
  const items = e?.dataTransfer?.items;
  if (!items) return false;
  for (const it of items) {
    if (it.kind !== 'file') continue;
    const en = it.webkitGetAsEntry?.();
    if (en && en.isDirectory) return true;
  }
  return false;
}

// 同步抓 entry 列表（坑①）。返回 [FileSystemEntry]。
export function entriesFromDrop(e) {
  const items = e?.dataTransfer?.items;
  if (!items) return [];
  const out = [];
  for (const it of items) {
    if (it.kind !== 'file') continue;
    const en = it.webkitGetAsEntry?.();
    if (en) out.push(en);
  }
  return out;
}

const readAll = (reader) => new Promise((resolve) => {
  const acc = [];
  const step = () => reader.readEntries((batch) => {
    if (!batch || !batch.length) { resolve(acc); return; }   // 坑②：读到空才算完
    acc.push(...batch);
    step();
  }, () => resolve(acc));
  step();
});

const fileOf = (entry) => new Promise((resolve) => { try { entry.file(resolve, () => resolve(null)); } catch { resolve(null); } });

// 把 entry 列表摊平成 [{file, rel}]（rel 含顶层文件夹名，如 "site/css/a.css"；
// 顶层散文件的 rel 就是文件名）。返回统计信息供 UI 说明「跳过了什么」。
export async function walkEntries(entries, limits = {}) {
  const lim = { ...DIR_LIMITS, ...limits };
  const items = [];
  const stat = { skippedDirs: [], skippedBig: [], truncated: false, bytes: 0 };
  const queue = entries.map((en) => ({ en, prefix: '' }));
  while (queue.length) {
    const { en, prefix } = queue.shift();
    if (!en) continue;
    if (en.isDirectory) {
      if (SKIP_DIRS.has(en.name)) { stat.skippedDirs.push(en.name); continue; }
      const kids = await readAll(en.createReader());
      const p = prefix ? prefix + '/' + en.name : en.name;
      for (const k of kids) queue.push({ en: k, prefix: p });
      continue;
    }
    if (SKIP_FILES.has(en.name)) continue;
    if (items.length >= lim.maxFiles || stat.bytes >= lim.maxBytes) { stat.truncated = true; continue; }
    const f = await fileOf(en);
    if (!f) continue;
    if (f.size > lim.maxFileBytes) { stat.skippedBig.push(en.name); continue; }
    stat.bytes += f.size;
    items.push({ file: f, rel: prefix ? prefix + '/' + en.name : en.name });
  }
  return { items, stat };
}

// `<input type="file" webkitdirectory>` 那条入口：FileList 自带 webkitRelativePath。
export function itemsFromDirInput(fileList, limits = {}) {
  const lim = { ...DIR_LIMITS, ...limits };
  const items = [];
  const stat = { skippedDirs: [], skippedBig: [], truncated: false, bytes: 0 };
  for (const f of [...(fileList || [])]) {
    const rel = f.webkitRelativePath || f.name;
    const segs = rel.split('/');
    if (segs.some((s) => SKIP_DIRS.has(s))) {
      const hit = segs.find((s) => SKIP_DIRS.has(s));
      if (!stat.skippedDirs.includes(hit)) stat.skippedDirs.push(hit);
      continue;
    }
    if (SKIP_FILES.has(segs[segs.length - 1])) continue;
    if (items.length >= lim.maxFiles || stat.bytes >= lim.maxBytes) { stat.truncated = true; continue; }
    if (f.size > lim.maxFileBytes) { stat.skippedBig.push(f.name); continue; }
    stat.bytes += f.size;
    items.push({ file: f, rel });
  }
  return { items, stat };
}

// 按顶层名分组：{ name, isDir, items } —— 一次拖拽可能同时含文件夹与散文件。
export function groupByRoot(items) {
  const map = new Map();
  for (const it of items) {
    const top = it.rel.split('/')[0];
    const isDir = it.rel.includes('/');
    if (!map.has(top)) map.set(top, { name: top, isDir, items: [] });
    const g = map.get(top);
    if (isDir) g.isDir = true;
    g.items.push(it);
  }
  return [...map.values()];
}

// 「跳过了什么」的人话（没跳过就返回空串）。
export function skipNote(stat) {
  const bits = [];
  if (stat.skippedDirs.length) bits.push(t('跳过 {names}', { names: [...new Set(stat.skippedDirs)].join('/') }));
  if (stat.skippedBig.length) bits.push(t('{n} 个超大文件未传', { n: stat.skippedBig.length }));
  if (stat.truncated) bits.push(t('超出 {n} 个文件/{mb}MB 上限，已截断', { n: DIR_LIMITS.maxFiles, mb: Math.round(DIR_LIMITS.maxBytes / 1024 / 1024) }));
  // 英文每段都是首字母大写的独立短语，用逗号连着读像半截句子，改用 · 分隔（Composer 那行本来就是 · 串）
  return bits.join(isEn() ? ' · ' : '，');
}

// 有限并发跑任务（整树上传几百个小文件时，串行慢得离谱、全并发又会打爆连接数）。
export async function pool(list, n, fn) {
  const it = list[Symbol.iterator]();
  let i = 0;
  const workers = Array.from({ length: Math.min(n, list.length) }, async () => {
    for (;;) {
      const nx = it.next();
      if (nx.done) return;
      await fn(nx.value, i++);
    }
  });
  await Promise.all(workers);
}
