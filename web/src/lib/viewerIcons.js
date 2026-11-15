// 查看器线稿图标（统一查看器外框与七个子查看器共用的唯一一套）。
// 与 lib/settingsIcons.js、modules/studio/icons.js 同一家族：24 网格、1.6 描边、圆头圆角，只用 currentColor。
// 查看器里不再手写内联 SVG、不依赖 Sym（私有 overlay 的异步字形，首帧可能为空、公开版可能没有）。
//
// 用法：
//   组件里   <VIcon name="download" />（components/preview/kit/VIcon.svelte）
//   字符串   viewerSvg('download')  → 完整 <svg> 字符串（ios27 MorphMenu 的 items[].icon 用 {@html} 渲染）
// 实心字形（播放 / 暂停 / 快进）放在 FILL 集合里，按 fill 画、不描边。
// 播放器那一族（喇叭、上一个 / 下一个、齿轮、快退快进的箭头）是「实心块 + 线」混画：实心块自带 fill="currentColor" 与 1.2 的细描边
//（只为把尖角磨圆），线条部分跟着外层描边粗细走——播放器底栏把描边提到 2，和实心的播放 / 暂停一样重。

export const VI = {
  // —— 外框 ——
  back: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  more: '<circle cx="6" cy="12" r="1.45" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.45" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.45" fill="currentColor" stroke="none"/>',
  prev: '<path d="M15 5.5 8.5 12l6.5 6.5"/>',
  next: '<path d="M9 5.5 15.5 12 9 18.5"/>',
  chev: '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
  up: '<path d="M6.5 14.5 12 9l5.5 5.5"/>',
  down: '<path d="M6.5 9.5 12 15l5.5-5.5"/>',
  check: '<path d="m5.5 12.5 4.25 4.25L18.5 8"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  minus: '<path d="M5.5 12h13"/>',

  // —— 文件操作 ——
  download: '<path d="M12 4.5v10M7.75 10.5 12 14.75l4.25-4.25"/><path d="M5 19.5h14"/>',
  share: '<path d="M12 3.75v11M8 7.5l4-3.75 4 3.75"/><path d="M8.5 10.5H7a2.5 2.5 0 0 0-2.5 2.5v5A2.5 2.5 0 0 0 7 20.5h10a2.5 2.5 0 0 0 2.5-2.5v-5a2.5 2.5 0 0 0-2.5-2.5h-1.5"/>',
  info: '<circle cx="12" cy="12" r="8.25"/><path d="M12 11v5"/><path d="M12 7.9h.01" stroke-width="2.3"/>',
  external: '<path d="M13.75 4.75h5.5v5.5M19 5l-8 8"/><path d="M17.25 13.75v4a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5v-9.5a1.5 1.5 0 0 1 1.5-1.5h4"/>',
  openWith: '<rect x="4" y="4" width="6.75" height="6.75" rx="1.8"/><rect x="4" y="13.25" width="6.75" height="6.75" rx="1.8"/><rect x="13.25" y="13.25" width="6.75" height="6.75" rx="1.8"/><path d="M14.25 4.5h5.25v5.25M19.25 4.75l-4.75 4.75"/>',
  folder: '<path d="M3.5 7.6A2.6 2.6 0 0 1 6.1 5h3.1c.5 0 1 .2 1.3.6l1.3 1.5h6.1a2.6 2.6 0 0 1 2.6 2.6v7.7a2.6 2.6 0 0 1-2.6 2.6H6.1a2.6 2.6 0 0 1-2.6-2.6z"/><path d="M3.5 10.5h17"/>',
  // 存到相册（相框 + 右上角下箭头）/ 设为壁纸（手机轮廓里一幅图）
  saveGallery: '<path d="M13.5 6.5H6.1a2.6 2.6 0 0 0-2.6 2.6v8.3A2.6 2.6 0 0 0 6.1 20h9.3a2.6 2.6 0 0 0 2.6-2.6V13"/><path d="M3.8 17.4l3.9-3.7a1.5 1.5 0 0 1 2.05 0L14.5 18.5"/><path d="M19 3.75v6.5M16.75 8l2.25 2.25L21.25 8"/>',
  wallpaper: '<rect x="6.25" y="3" width="11.5" height="18" rx="2.6"/><path d="M6.5 16.25l3.15-3a1.4 1.4 0 0 1 1.95 0l5.9 5.7"/><circle cx="13.9" cy="8.6" r="1.4"/>',
  edit: '<path d="M14.5 5.5l4 4L9 19H5v-4z"/><path d="M12.5 7.5l4 4"/>',
  rename: '<path d="M4.75 19.25h14.5"/><path d="M14.25 5.25l3 3-7.5 7.5H6.75v-3z"/>',
  copy: '<rect x="8.5" y="8.5" width="11.25" height="11.25" rx="2.4"/><path d="M15.5 8.5V6.6a2.35 2.35 0 0 0-2.35-2.35H6.6A2.35 2.35 0 0 0 4.25 6.6v6.55a2.35 2.35 0 0 0 2.35 2.35h1.9"/>',
  link: '<path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1.5-1.5"/>',
  trash: '<path d="M5 7h14M10 4h4"/><path d="M7 7l.8 11.2a2 2 0 0 0 2 1.8h4.4a2 2 0 0 0 2-1.8L17 7"/>',
  sendAi: '<path d="M11 4c.55 3.95 2.55 5.95 6.5 6.5-3.95.55-5.95 2.55-6.5 6.5-.55-3.95-2.55-5.95-6.5-6.5C8.45 9.95 10.45 7.95 11 4Z"/><path d="M18 14.75c.22 1.5.98 2.27 2.5 2.5-1.52.23-2.28.99-2.5 2.5-.22-1.51-.98-2.27-2.5-2.5 1.52-.23 2.28-1 2.5-2.5Z"/>',
  print: '<path d="M7 9V4.75h10V9"/><rect x="3.75" y="9" width="16.5" height="7.5" rx="2.2"/><path d="M7 14h10v5.25H7z"/>',
  refresh: '<path d="M19.25 12a7.25 7.25 0 1 1-2.12-5.13"/><path d="M19.5 4.75v3.75h-3.75"/>',
  retry: '<path d="M4.75 12a7.25 7.25 0 1 0 2.12-5.13"/><path d="M4.5 4.75v3.75h3.75"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.75" rx="2.4"/><path d="M8.25 10.5V8a3.75 3.75 0 0 1 7.5 0v2.5"/>',

  // —— 看图 / 文档视图 ——
  zoomIn: '<circle cx="10.75" cy="10.75" r="6.25"/><path d="m15.4 15.4 4.35 4.35"/><path d="M10.75 8.25v5M8.25 10.75h5"/>',
  zoomOut: '<circle cx="10.75" cy="10.75" r="6.25"/><path d="m15.4 15.4 4.35 4.35"/><path d="M8.25 10.75h5"/>',
  search: '<circle cx="10.75" cy="10.75" r="6.25"/><path d="m15.4 15.4 4.35 4.35"/>',
  fit: '<path d="M4 9V6.6A2.6 2.6 0 0 1 6.6 4H9M15 4h2.4A2.6 2.6 0 0 1 20 6.6V9M20 15v2.4a2.6 2.6 0 0 1-2.6 2.6H15M9 20H6.6A2.6 2.6 0 0 1 4 17.4V15"/>',
  fitWidth: '<path d="M4 5v14M20 5v14"/><path d="M7.5 12h9M10 9.5 7.5 12l2.5 2.5M14 9.5l2.5 2.5-2.5 2.5"/>',
  actual: '<rect x="3.75" y="5.25" width="16.5" height="13.5" rx="2.6"/><path d="M8.25 10.25 9.5 9.5v5M14.5 10.25l1.25-.75v5"/><path d="M12 10.6h.01M12 13.9h.01" stroke-width="2.1"/>',
  rotate: '<rect x="4.5" y="9.5" width="10" height="10" rx="2.2"/><path d="M10 4.5h3.5a6 6 0 0 1 6 6V12"/><path d="M17.25 9.75 19.5 12l2.25-2.25"/>',
  rotateLeft: '<rect x="9.5" y="9.5" width="10" height="10" rx="2.2"/><path d="M14 4.5h-3.5a6 6 0 0 0-6 6V12"/><path d="M6.75 9.75 4.5 12 2.25 9.75"/>',
  fullscreen: '<path d="M4.5 9.25v-2.5A2.25 2.25 0 0 1 6.75 4.5h2.5M14.75 4.5h2.5a2.25 2.25 0 0 1 2.25 2.25v2.5M19.5 14.75v2.5a2.25 2.25 0 0 1-2.25 2.25h-2.5M9.25 19.5h-2.5a2.25 2.25 0 0 1-2.25-2.25v-2.5"/>',
  exitFullscreen: '<path d="M9.25 4.5V7a2.25 2.25 0 0 1-2.25 2.25H4.5M19.5 9.25H17A2.25 2.25 0 0 1 14.75 7V4.5M14.75 19.5V17A2.25 2.25 0 0 1 17 14.75h2.5M4.5 14.75H7A2.25 2.25 0 0 1 9.25 17v2.5"/>',
  page: '<path d="M7 3.75h6.6l4.65 4.65V18a2.25 2.25 0 0 1-2.25 2.25H7A2.25 2.25 0 0 1 4.75 18V6A2.25 2.25 0 0 1 7 3.75Z"/><path d="M13.5 3.9V8.5h4.6"/>',
  twoPage: '<rect x="3.5" y="5" width="7.75" height="14" rx="1.8"/><rect x="12.75" y="5" width="7.75" height="14" rx="1.8"/>',
  thumbs: '<rect x="4" y="4" width="6.75" height="6.75" rx="1.8"/><rect x="13.25" y="4" width="6.75" height="6.75" rx="1.8"/><rect x="4" y="13.25" width="6.75" height="6.75" rx="1.8"/><rect x="13.25" y="13.25" width="6.75" height="6.75" rx="1.8"/>',
  outline: '<path d="M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01" stroke-width="2.2"/><path d="M8.5 6.5h11M11 12h8.5M11 17.5h8.5"/>',
  sidebar: '<rect x="3.5" y="4.5" width="17" height="15" rx="2.6"/><path d="M9.5 4.5v15"/>',
  night: '<rect x="5" y="3.75" width="14" height="16.5" rx="2.25"/><path d="M12 3.75v16.5"/><path d="M12 3.75h4.75A2.25 2.25 0 0 1 19 6v12a2.25 2.25 0 0 1-2.25 2.25H12z" fill="currentColor" stroke="none"/>',
  code: '<path d="m8.5 7.5-4.5 4.5 4.5 4.5M15.5 7.5l4.5 4.5-4.5 4.5"/>',
  wrap: '<path d="M4.5 6.5h15M4.5 12h12a3 3 0 0 1 0 6h-3"/><path d="M15 16l-2 2 2 2"/><path d="M4.5 17.5h5"/>',
  globe: '<circle cx="12" cy="12" r="8.25"/><path d="M3.75 12h16.5M12 3.75c2.3 2.4 3.4 5.15 3.4 8.25S14.3 17.85 12 20.25C9.7 17.85 8.6 15.1 8.6 12S9.7 6.15 12 3.75Z"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2.6"/><path d="M7 10h.01M10.3 10h.01M13.7 10h.01M17 10h.01" stroke-width="2.1"/><path d="M8 14h8"/>',
  // —— 代码 / 文本查看（CodeView 查找条、DocViewer 菜单）——
  matchCase: '<path d="m3.75 17.5 4-11 4 11M5.2 13.5h5.1"/><circle cx="16.75" cy="14.6" r="2.6"/><path d="M19.35 11.75v5.75"/>',
  regex: '<path d="M16 4.75v8M12.55 6.75l6.9 4M19.45 6.75l-6.9 4"/><path d="M6.5 17.5h.01" stroke-width="3"/>',
  wholeWord: '<path d="M3.75 15.5v3h16.5v-3"/><circle cx="8" cy="11.25" r="2.5"/><path d="M10.5 8.75v5"/><path d="M13.75 5.5v8.25"/><circle cx="16.25" cy="11.25" r="2.5"/>',
  gotoLine: '<path d="M4.5 6.5h15M4.5 17.5h15M4.5 12h7.5"/><path d="M15.25 9.5 17.75 12l-2.5 2.5"/>',
  textSize: '<path d="M3.75 6.5h9M8.25 6.5v11.25"/><path d="M14 11.5h6.25M17.1 11.5v6.25"/>',
  encoding: '<path d="M5 8.5h12.5M14.5 5.25l3.25 3.25-3.25 3.25"/><path d="M19 15.5H6.5M9.5 12.25 6.25 15.5l3.25 3.25"/>',
  lines: '<path d="M5 7h14M5 12h14M5 17h9"/>',

  // —— 音视频 ——
  volumeOff: '<path fill="currentColor" stroke-width="1.2" d="M11.2 6 7.3 9.4H5.1v5.2h2.2l3.9 3.4z"/>',
  volumeLow: '<path fill="currentColor" stroke-width="1.2" d="M11.2 6 7.3 9.4H5.1v5.2h2.2l3.9 3.4z"/><path d="M15 9.2a4 4 0 0 1 0 5.6"/>',
  volumeHigh: '<path fill="currentColor" stroke-width="1.2" d="M11.2 6 7.3 9.4H5.1v5.2h2.2l3.9 3.4z"/><path d="M15 9.2a4 4 0 0 1 0 5.6M17.6 6.6a7.6 7.6 0 0 1 0 10.8"/>',
  mute: '<path fill="currentColor" stroke-width="1.2" d="M11.2 6 7.3 9.4H5.1v5.2h2.2l3.9 3.4z"/><path d="m15.5 9.5 5 5M20.5 9.5l-5 5"/>',
  settings: '<path fill="currentColor" stroke-width="1.2" fill-rule="evenodd" d="M10.31 5.21 10.69 2.79h2.62l.38 2.42 1.92.79 1.97-1.44 1.86 1.86L18 8.39l.79 1.92 2.42.38v2.62l-2.42.38-.79 1.92 1.44 1.97-1.86 1.86L15.61 18l-1.92.79-.38 2.42h-2.62l-.38-2.42L8.39 18l-1.97 1.44-1.86-1.86L6 15.61l-.79-1.92-2.42-.38v-2.62l2.42-.38L6 8.39 4.56 6.42l1.86-1.86L8.39 6zM12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z"/>',
  speed: '<path d="M4.6 16.5a8 8 0 1 1 14.8 0"/><path d="m12 13.5 3.8-3.8"/><circle cx="12" cy="13.5" r="1.3" fill="currentColor" stroke="none"/>',
  quality: '<path d="M4 8h8.5M17.5 8H20M4 16h2.5M11.5 16H20"/><circle cx="15" cy="8" r="2.5"/><circle cx="9" cy="16" r="2.5"/>',
  loop: '<path d="M17 3.75 19.75 6.5 17 9.25"/><path d="M4.25 11.5V10a3.5 3.5 0 0 1 3.5-3.5h12"/><path d="M7 20.25 4.25 17.5 7 14.75"/><path d="M19.75 12.5V14a3.5 3.5 0 0 1-3.5 3.5h-12"/>',
  subtitles: '<rect x="3.5" y="5.25" width="17" height="13.5" rx="2.8"/><path d="M7.25 12.25h3M12.75 12.25h4M7.25 15.25h5.5M15.25 15.25h1.5"/>',
  pip: '<rect x="3.5" y="5.25" width="17" height="13.5" rx="2.8"/><rect fill="currentColor" stroke-width="1" x="11.6" y="11.4" width="6.2" height="4.6" rx="1"/>',
  skipBack10: '<path d="M12 5.5a7.4 7.4 0 1 1-6.06 3.16"/><path fill="currentColor" stroke-width="1.2" d="M12.3 2.9v5.2L8.7 5.5z"/><path stroke-width="1.5" d="M9.2 11.3l1.45-.95v5.3"/><rect stroke-width="1.5" x="12.25" y="10.35" width="3.3" height="5.3" rx="1.65"/>',
  skipFwd10: '<path d="M12 5.5a7.4 7.4 0 1 0 6.06 3.16"/><path fill="currentColor" stroke-width="1.2" d="M11.7 2.9v5.2l3.6-2.6z"/><path stroke-width="1.5" d="M9.2 11.3l1.45-.95v5.3"/><rect stroke-width="1.5" x="12.25" y="10.35" width="3.3" height="5.3" rx="1.65"/>',
  skipBack15: '<path d="M12 5.5a7.4 7.4 0 1 1-6.06 3.16"/><path fill="currentColor" stroke-width="1.2" d="M12.3 2.9v5.2L8.7 5.5z"/><path stroke-width="1.5" d="M8.9 11.3l1.45-.95v5.3"/><path stroke-width="1.5" d="M15.6 10.35h-2.75l-.3 2.2a1.9 1.9 0 0 1 1.1-.3 1.7 1.7 0 0 1 0 3.4c-.6 0-1.1-.25-1.4-.65"/>',
  skipFwd15: '<path d="M12 5.5a7.4 7.4 0 1 0 6.06 3.16"/><path fill="currentColor" stroke-width="1.2" d="M11.7 2.9v5.2l3.6-2.6z"/><path stroke-width="1.5" d="M8.9 11.3l1.45-.95v5.3"/><path stroke-width="1.5" d="M15.6 10.35h-2.75l-.3 2.2a1.9 1.9 0 0 1 1.1-.3 1.7 1.7 0 0 1 0 3.4c-.6 0-1.1-.25-1.4-.65"/>',
  brightness: '<circle cx="12" cy="12" r="3.6"/><path d="M12 3.5v1.8M12 18.7v1.8M3.5 12h1.8M18.7 12h1.8M5.99 5.99l1.27 1.27M16.74 16.74l1.27 1.27M5.99 18.01l1.27-1.27M16.74 7.26l1.27-1.27"/>',
  unlock: '<rect x="5" y="10.5" width="14" height="9.75" rx="2.4"/><path d="M8.25 10.5V8a3.75 3.75 0 0 1 7.3-1.2"/>',
  prevTrack: '<path stroke-width="2.2" d="M6.4 6.2v11.6"/><path fill="currentColor" stroke-width="1.2" d="M17.8 6.6v10.8L9.9 12z"/>',
  nextTrack: '<path stroke-width="2.2" d="M17.6 6.2v11.6"/><path fill="currentColor" stroke-width="1.2" d="M6.2 6.6v10.8l7.9-5.4z"/>',
  fastForward: '<path d="M4.5 6.6v10.8a.6.6 0 0 0 .95.5l6.3-5.4a.6.6 0 0 0 0-1l-6.3-5.4a.6.6 0 0 0-.95.5Z"/><path d="M12.5 6.6v10.8a.6.6 0 0 0 .95.5l6.3-5.4a.6.6 0 0 0 0-1l-6.3-5.4a.6.6 0 0 0-.95.5Z"/>',
  play: '<path d="M8 5.6v12.8a1 1 0 0 0 1.52.85l10.2-6.4a1 1 0 0 0 0-1.7L9.52 4.75A1 1 0 0 0 8 5.6Z"/>',
  pause: '<rect x="6.5" y="5" width="3.8" height="14" rx="1.3"/><rect x="13.7" y="5" width="3.8" height="14" rx="1.3"/>',
  replay: '<path d="M12 5.5a7.4 7.4 0 1 1-6.06 3.16"/><path fill="currentColor" stroke-width="1.2" d="M12.3 2.9v5.2L8.7 5.5z"/>',

  // —— 状态 / 类型 ——
  error: '<circle cx="12" cy="12" r="8.25"/><path d="M12 7.75v5"/><path d="M12 16.1h.01" stroke-width="2.3"/>',
  image: '<rect x="3.5" y="5" width="17" height="14" rx="2.6"/><path d="M3.8 15.6l4.4-4.2a1.5 1.5 0 0 1 2.1 0l6.1 6.1"/><circle cx="15.6" cy="9.4" r="1.5"/>',
  video: '<rect x="3.5" y="5" width="17" height="14" rx="2.6"/><path d="M10.2 9.3v5.4l4.6-2.7z"/>',
  audio: '<path d="M9 17.5V6.6l10-2.1v10.9"/><circle cx="6.8" cy="17.5" r="2.2"/><circle cx="16.8" cy="15.4" r="2.2"/><path d="M9 9.6l10-2.1"/>',
  file: '<path d="M7 3.75h6.6l4.65 4.65V18a2.25 2.25 0 0 1-2.25 2.25H7A2.25 2.25 0 0 1 4.75 18V6A2.25 2.25 0 0 1 7 3.75Z"/><path d="M13.5 3.9V8.5h4.6"/>',
  table: '<rect x="3.75" y="4.75" width="16.5" height="14.5" rx="2.4"/><path d="M3.75 9.5h16.5M3.75 14.25h16.5M9.25 4.75v14.5"/>',
  slides: '<rect x="3.75" y="4.75" width="16.5" height="11.5" rx="2.4"/><path d="M12 16.25v3M8.5 19.25h7"/>',
  unsupported: '<path d="M7 3.75h6.6l4.65 4.65V18a2.25 2.25 0 0 1-2.25 2.25H7A2.25 2.25 0 0 1 4.75 18V6A2.25 2.25 0 0 1 7 3.75Z"/><path d="M13.5 3.9V8.5h4.6"/><path d="M10 12.25a2 2 0 1 1 2.6 1.9c-.4.15-.6.45-.6.85v.25"/><path d="M12 17.4h.01" stroke-width="2.1"/>',
};

// 整体按实心画（fill=currentColor、不描边）
export const VI_FILL = new Set(['play', 'pause', 'fastForward']);

/** 完整 SVG 字符串（MorphMenu items[].icon、{@html} 场景） */
export function viewerSvg(name, { size = 0, stroke = 1.6 } = {}) {
  const inner = VI[name];
  if (!inner) return '';
  const wh = size ? ` width="${size}" height="${size}"` : '';
  return VI_FILL.has(name)
    ? `<svg viewBox="0 0 24 24"${wh} fill="currentColor" stroke="none" aria-hidden="true">${inner}</svg>`
    : `<svg viewBox="0 0 24 24"${wh} fill="none" stroke="currentColor" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}
