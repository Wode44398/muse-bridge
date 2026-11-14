// 列表缩略图的扩展类型（只给文件列表的 thumb=1 / thumb=grid 档用，聊天附件与 preview 档不走这里）：
//   gif / 动 webp → sharp 默认只解第一帧，天然是首帧静态图；
//   heic / heif / avif / tif → 先 sharp，解不了再 ffmpeg 转 png；
//   pdf → 首页：pdftoppm → mutool → LibreOffice；
//   Office → 若 office-cache 里已有转好的 PDF 直接取首页，否则 LibreOffice 转首页 PNG；
//   音频 → ffmpeg 抽内嵌封面（没有封面就失败，前端回落类型图标）。
// 这里只负责把源文件变成一张 sharp 读得了的位图；缩放、编码、缓存、失败记账仍在 file-preview.mjs 的 imageThumb。
// 外部进程一律带超时（超时连子进程树一起收）与并发上限，免得一个满是文档的文件夹同时拉起几十个 soffice。
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { DATA_ROOT } from '../runtime/paths.mjs';

export const HEIF_EXT = new Set(['heic', 'heif', 'avif']);
const SHARP_EXTRA_EXT = new Set(['gif', 'tif', 'tiff', ...HEIF_EXT]);
export const PDF_EXT = new Set(['pdf']);
export const OFFICE_THUMB_EXT = new Set(['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf']);
export const AUDIO_COVER_EXT = new Set(['mp3', 'm4a', 'flac', 'ogg', 'opus', 'aac']);
// 需要先转成位图的类型
const RASTER_EXT = new Set([...PDF_EXT, ...OFFICE_THUMB_EXT, ...AUDIO_COVER_EXT]);
// 列表档额外支持的扩展名（在 THUMB_EXT / THUMB_VIDEO_EXT 之外）
export const LIST_THUMB_EXT = new Set([...SHARP_EXTRA_EXT, ...RASTER_EXT]);

export const needsRaster = (ext) => RASTER_EXT.has(ext);

const OFFICE_CACHE = path.join(DATA_ROOT, 'office-cache');
const WORK_ROOT = path.join(DATA_ROOT, 'thumb-cache', 'work');

const TIMEOUT = { quick: 20_000, office: 60_000 };

// 并发闸：超过上限的排队，先来先跑
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
export const quickGate = gate(3);     // ffmpeg / pdftoppm / mutool：几十到几百毫秒
const officeGate = gate(2);           // LibreOffice：一次 5~10 秒、两三百 MB 内存

const missingTools = new Set();

function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {}
  } else {
    try { child.kill('SIGKILL'); } catch {}
  }
}

// 跑一个外部程序：退出码 0 才算成功；超时连进程树一起收；程序不存在记进 missingTools，下次直接跳过
export function runTool(cmd, args, { timeout = TIMEOUT.quick, tool = cmd } = {}) {
  if (missingTools.has(tool)) return Promise.reject(new Error(tool + ' missing'));
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawn(cmd, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] }); }
    catch (error) { reject(error); return; }
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      killTree(child);
      reject(new Error(tool + ' timeout'));
    }, timeout);
    child.stderr?.on('data', () => {});
    child.on('error', (error) => {
      if (error?.code === 'ENOENT') missingTools.add(tool);
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`${tool} exit ${code}`));
    });
  });
}

let sofficePath;
function soffice() {
  if (sofficePath !== undefined) return sofficePath;
  const candidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/opt/libreoffice/program/soffice',
  ];
  sofficePath = candidates.find((candidate) => existsSync(candidate)) || null;
  return sofficePath;
}

export function makeWorkDir() {
  const dir = path.join(WORK_ROOT, crypto.randomBytes(6).toString('hex'));
  mkdirSync(dir, { recursive: true });
  return dir;
}
export function dropWorkDir(dir) {
  if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch {} }
}

const firstPng = (dir) => {
  const hit = readdirSync(dir).find((name) => /\.png$/i.test(name));
  return hit ? path.join(dir, hit) : null;
};

// LibreOffice 把文档（或 PDF）首页导出成 PNG；每次一个临时用户配置目录，跑完随工作目录一起删
async function sofficePng(file, work) {
  const bin = soffice();
  if (!bin) throw new Error('soffice missing');
  const out = path.join(work, 'lo');
  mkdirSync(out, { recursive: true });
  const profile = 'file:///' + path.join(work, 'profile').replace(/\\/g, '/');
  await officeGate(() => runTool(bin, [
    '--headless', '--norestore', '--nolockcheck', '--convert-to', 'png',
    '--outdir', out, file, '-env:UserInstallation=' + profile,
  ], { timeout: TIMEOUT.office, tool: 'soffice' }));
  const png = firstPng(out);
  if (!png) throw new Error('soffice no output');
  return png;
}

async function pdfFirstPage(pdf, work, size) {
  const prefix = path.join(work, 'page');
  try {
    await quickGate(() => runTool('pdftoppm', [
      '-f', '1', '-l', '1', '-png', '-scale-to', String(Math.max(64, size)), '-singlefile', pdf, prefix,
    ]));
    if (existsSync(prefix + '.png')) return prefix + '.png';
  } catch {}
  try {
    const out = path.join(work, 'mu.png');
    await quickGate(() => runTool('mutool', ['draw', '-o', out, '-w', String(size), '-h', String(size), '-r', '144', pdf, '1']));
    if (existsSync(out)) return out;
  } catch {}
  // 只有两样都没装才请 LibreOffice；装了却失败的（加密、损坏）换 soffice 也是白等好几秒
  if (!missingTools.has('pdftoppm') || !missingTools.has('mutool')) throw new Error('pdf render failed');
  return sofficePng(pdf, work);
}

// office-cache 的 PDF 与 file-preview.mjs 的 handleOfficePdf 同一套键（路径|mtime|大小）；
// 打开过一次的文档就不用再等 LibreOffice
function cachedOfficePdf(file, stat) {
  if (!stat) return null;
  const key = crypto.createHash('sha1').update(`${file}|${stat.mtimeMs}|${stat.size}`).digest('hex');
  const pdf = path.join(OFFICE_CACHE, key + '.pdf');
  return existsSync(pdf) ? pdf : null;
}

async function ffmpegPng(file, work, args) {
  const out = path.join(work, 'ff.png');
  await quickGate(() => runTool('ffmpeg', ['-v', 'error', '-y', '-i', file, ...args, out]));
  if (!existsSync(out)) throw new Error('ffmpeg no output');
  return out;
}

// 返回一张 sharp 读得了的位图路径（放在 work 里）；ext 是小写扩展名
export async function rasterize(file, ext, work, { size = 320, stat = null } = {}) {
  if (PDF_EXT.has(ext)) return pdfFirstPage(file, work, size);
  if (OFFICE_THUMB_EXT.has(ext)) {
    const pdf = cachedOfficePdf(file, stat);
    if (pdf) {
      try { return await pdfFirstPage(pdf, work, size); } catch {}
    }
    return sofficePng(file, work);
  }
  if (AUDIO_COVER_EXT.has(ext)) return ffmpegPng(file, work, ['-map', '0:v:0', '-frames:v', '1']);
  if (HEIF_EXT.has(ext)) return ffmpegPng(file, work, ['-frames:v', '1']);
  throw new Error('no rasterizer for ' + ext);
}
