// Claude 工作台四件套的字形（标题栏工具开关、⋮ 菜单、手机 sheet 的 chip 条共用一份）。
// 静态 SVG 串，宿主用 {@html} 挂；尺寸交给宿主 CSS（svg 宽高 100%）。
import { iconSvg } from './claudeIcons.js';

const S = (body, sw = 1.7) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS = {
  // 终端：官方那枚 >_（不带外框）
  term: S('<path d="M5 7.5 9.5 12 5 16.5M12 17h7"/>', 1.8),
  // 审阅：方框里一加一减 = diff
  review: S('<rect x="4" y="4" width="16" height="16" rx="3.6"/><path d="M12 7.9v4.2M9.9 10h4.2M9.9 15.6h4.2"/>'),
  files: S('<path d="M3.5 7.2c0-1.5 1.2-2.7 2.7-2.7h3.4l2 2.3h6.2c1.5 0 2.7 1.2 2.7 2.7v8.3c0 1.5-1.2 2.7-2.7 2.7H6.2c-1.5 0-2.7-1.2-2.7-2.7z"/>'),
  more: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5.6" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="12" cy="18.4" r="1.7"/></svg>',
  close: S('<path d="M7 7l10 10M17 7 7 17"/>', 1.9),
  // 放大铺满 / 还原
  expand: S('<path d="M14 4h6v6M10 20H4v-6M20 4l-6.5 6.5M4 20l6.5-6.5"/>', 1.8),
  shrink: S('<path d="M4 14h6v6M20 10h-6V4M10 14l-6.5 6.5M14 10l6.5-6.5"/>', 1.8),
  sun: S('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>', 1.8),
  moon: S('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>', 1.8),
  check: S('<path d="M5 12.5 10 17.5 19 7"/>', 2),
};

export function dockIcon(key) {
  if (key === 'tasks') return iconSvg('AgentsSimple', 24);
  return ICONS[key] || '';
}
