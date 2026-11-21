// ACP 路径规整：agy 在完成态工具位置、diff 路径与会话列表中混用 file:// URI、
// 前导斜杠盘符（/C:/...、/e%3A/...）及百分号编码，统一转为宿主原生路径以便过滤与预览跟盘。

import path from 'node:path';

function safeDecode(text) {
  if (!text.includes('%')) return text;
  try {
    return decodeURIComponent(text);
  } catch {
    // 文件名本身可能含字面量 %（如 100%.txt），整串解码失败时只解合法的 %XX 序列
    return text.replace(/%[0-9a-fA-F]{2}/g, (m) => {
      try { return decodeURIComponent(m); } catch { return m; }
    });
  }
}

export function normalizeAgyPath(raw, platform = process.platform) {
  let s = String(raw ?? '').trim();
  if (!s) return '';

  if (/^file:\/\//i.test(s)) {
    s = s.replace(/^file:\/\/\/?/i, '/');
  }
  s = safeDecode(s);

  const isWinDriveWithSlash = /^\/[a-zA-Z]:([/\\]|$)/.test(s);
  const isWinDriveBare = /^[a-zA-Z]:([/\\]|$)/.test(s);

  if (platform === 'win32' || isWinDriveWithSlash || isWinDriveBare) {
    if (isWinDriveWithSlash) s = s.slice(1);
    if (/^[a-zA-Z]:$/.test(s)) return s[0].toUpperCase() + ':\\';
    if (/^[a-zA-Z]:[/\\]/.test(s)) {
      const drive = s[0].toUpperCase();
      const rest = s.slice(2).replace(/[/\\]+/g, '\\').replace(/\\+$/, '');
      return rest ? `${drive}:${rest}` : `${drive}:\\`;
    }
    if (s.startsWith('\\\\')) {
      const unc = '\\\\' + s.slice(2).replace(/[/\\]+/g, '\\').replace(/\\+$/, '');
      return unc;
    }
    if (platform === 'win32') {
      return path.win32.normalize(s).replace(/\\+$/, (m, offset, full) => (full.length <= 3 ? m : ''));
    }
  }

  const norm = path.posix.normalize(s.replace(/\\/g, '/'));
  return norm.length > 1 ? norm.replace(/\/+$/, '') : norm;
}

export function foldAgyPath(raw, platform = process.platform) {
  const norm = normalizeAgyPath(raw, platform);
  if (!norm) return '';
  if (platform === 'win32' || /^[A-Z]:\\/.test(norm)) {
    const trimmed = /^[A-Z]:\\$/i.test(norm) ? norm : norm.replace(/\\+$/, '');
    return trimmed.toLowerCase();
  }
  return norm;
}

export function isSameOrSubPath(childRaw, rootRaw, platform = process.platform) {
  const child = foldAgyPath(childRaw, platform);
  const root = foldAgyPath(rootRaw, platform);
  if (!child || !root) return false;
  if (child === root) return true;
  const sep = platform === 'win32' || /^[a-z]:\\/i.test(root) ? '\\' : '/';
  const prefix = root.endsWith(sep) ? root : root + sep;
  return child.startsWith(prefix);
}

// 工具标题里常见 "File /C:/Users/..." 形式，规整掉前导斜杠盘符以贴合原生界面展示
export function cleanTitlePaths(title, platform = process.platform) {
  const s = String(title ?? '');
  if (!s) return '';
  return s.replace(/(^|\s)(\/[a-zA-Z]:[^\s"'`<>|]*)/g, (full, lead, rawPath) => {
    return lead + normalizeAgyPath(rawPath, platform);
  });
}
