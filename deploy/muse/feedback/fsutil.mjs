// 反馈工具自带的几样底座（搬出 src/ 之后不再引 bridge 的内部模块：bridge 本体每次同步都可能改那些文件）。
//   PROGRAM_ROOT  程序根（本文件在 deploy/muse/feedback/ 下）
//   DATA_ROOT     数据根：服务单元与 bootstrap.sh 都给 BRIDGE_DATA_ROOT；没给就是程序根（本机开发）
//   readJson / writeJson  读坏了回默认值；写走临时文件再改名，同目录原子替换
import path from 'node:path';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PROGRAM_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const DATA_ROOT = path.resolve(process.env.BRIDGE_DATA_ROOT || PROGRAM_ROOT);

export function readJson(file, fallback) {
  try { const o = JSON.parse(readFileSync(file, 'utf8')); return o && typeof o === 'object' ? o : fallback; }
  catch { return fallback; }
}

export function writeJson(file, obj, space = 0) {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    writeFileSync(tmp, JSON.stringify(obj, null, space || undefined));
    renameSync(tmp, file);
  } catch (err) {
    console.error('[feedback] 写不进 ' + file + '：' + ((err && err.message) || err));
  }
}
