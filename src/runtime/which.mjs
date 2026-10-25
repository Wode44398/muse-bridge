// 在 PATH 里找可执行文件（不 spawn）。Windows 按 PATHEXT 补扩展名。找不到返回 null。
import { statSync } from 'node:fs';
import path from 'node:path';

export function whichSync(cmd) {
  const name = String(cmd || '').trim();
  if (!name) return null;
  const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) return isFile(name) ? path.resolve(name) : null;
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32'
    ? ['', ...String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean).map((e) => e.toLowerCase())]
    : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d.replace(/^"(.*)"$/, '$1'), name + e);
      if (isFile(p)) return p;
    }
  }
  return null;
}
