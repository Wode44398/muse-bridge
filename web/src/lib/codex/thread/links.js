// 回答 / 进度说明里的链接：Codex 写的多是本机文件路径（或产物接口的完整 URL），点了在应用内预览，绝不让页面跳走。
import { onMdClick } from '../../linkNav.js';
import { openPreview, kindOf } from '../../preview.svelte.js';

const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || String(p || '');

export function openCodexFile(sid, path, name = '') {
  if (!path) return;
  const n = name || baseName(path);
  openPreview({ origin: 'codex', id: sid || '', path, name: n, kind: kindOf(n) });
}

/** 挂在 {@html renderMarkdown()} 容器的 onclick 上。 */
export function codexMdClick(e, sid) {
  onMdClick(e, (href) => {
    let p = String(href || '');
    try {
      const u = new URL(p, location.href);
      if (u.origin === location.origin && u.searchParams.get('path')) p = u.searchParams.get('path');
    } catch {}
    p = p.replace(/^file:\/\/\/?/i, '').replace(/#L?\d+(?:-L?\d+)?$/, '');
    try { p = decodeURIComponent(p); } catch {}
    openCodexFile(sid, p);
    return true;
  });
}
