// 媒体工坊（vmx）共享 UI 资产：自绘扁平图标 / 模块 glyph / 小工具。
// 零复用 Gemini 克隆页资源（不用 Luminous 字体 / GeminiSparkle）——全部内联 SVG。
import { t } from './i18n.js';

export const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/* ——— 图标（stroke 2.6 圆头，极简几何） ——— */
const I = {
  down: '<path d="m6 9 6 6 6-6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  check: '<path d="m4.5 12.5 5 5L19.5 7"/>',
  play: '<path d="M8 5.5v13l11-6.5z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="6" y="5" width="4.6" height="14" rx="2.3" fill="currentColor" stroke="none"/><rect x="13.4" y="5" width="4.6" height="14" rx="2.3" fill="currentColor" stroke="none"/>',
  swap: '<path d="M16 4l4 4-4 4M20 8H8M8 20l-4-4 4-4M4 16h12"/>',
  img: '<rect x="3.5" y="4.5" width="17" height="15" rx="4"/><path d="m3.5 15.5 4.2-3.8a2 2 0 0 1 2.6 0l5.2 4.8"/><circle cx="15.5" cy="9.5" r="1.6" fill="currentColor" stroke="none"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="3"/><path d="M10.5 18.5h3"/>',
  folder: '<path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/>',
  warn: '<path d="M12 8.5v5"/><circle cx="12" cy="17" r="1.3" fill="currentColor" stroke="none"/><path d="M10.2 4 3.4 16a2 2 0 0 0 1.8 3h13.6a2 2 0 0 0 1.8-3L13.8 4a2 2 0 0 0-3.6 0z"/>',
  send: '<path d="M12 19V5m0 0-6 6m6-6 6 6"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5z"/><path d="m4.5 12.8 7.5 4.2 7.5-4.2"/>',
  spark: '<path d="M12 3c.8 4.7 4.3 8.2 9 9-4.7.8-8.2 4.3-9 9-.8-4.7-4.3-8.2-9-9 4.7-.8 8.2-4.3 9-9z" fill="currentColor" stroke="none"/>',
  vol: '<path d="M4 9.5v5h3.5L13 19V5L7.5 9.5z" fill="currentColor" stroke="none"/><path d="M16.5 9a4.6 4.6 0 0 1 0 6M19 6.5a8 8 0 0 1 0 11"/>',
  chevR: '<path d="m9 5 7 7-7 7"/>',
};
export const icon = (n, sz) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"${sz ? ` style="width:${sz}px;height:${sz}px"` : ''}>${I[n] || ''}</svg>`;

/* ——— 模块大 glyph（96 画布，扁平双色：主形 currentColor + 镂空 var(--kn)） ——— */
const GLYPHS = {
  video: `<rect x="6" y="18" width="84" height="60" rx="20" fill="currentColor"/>
          <path d="M41 36 L61 48 L41 60 Z" fill="var(--kn,#fff)" stroke="var(--kn,#fff)" stroke-width="9" stroke-linejoin="round"/>`,
  image: `<rect x="6" y="6" width="84" height="84" rx="24" fill="currentColor"/>
          <circle cx="62" cy="33" r="9.5" fill="var(--kn,#fff)"/>
          <path d="M18 74 L38 48 L52 64 L61 54 L78 74" fill="none" stroke="var(--kn,#fff)" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>`,
  voice: `<rect x="8"  y="36" width="13" height="24" rx="6.5" fill="currentColor"/>
          <rect x="29" y="22" width="13" height="52" rx="6.5" fill="currentColor"/>
          <rect x="50" y="8"  width="13" height="80" rx="6.5" fill="currentColor"/>
          <rect x="71" y="28" width="13" height="40" rx="6.5" fill="currentColor"/>`,
  music: `<circle cx="30" cy="77" r="12.5" fill="currentColor"/>
          <circle cx="70" cy="70" r="12.5" fill="currentColor"/>
          <rect x="34.5" y="22" width="8.5" height="55" fill="currentColor"/>
          <rect x="74.5" y="15" width="8.5" height="55" fill="currentColor"/>
          <path d="M34.5 19 L83 11.5 L83 27.5 L34.5 35 Z" fill="currentColor"/>`,
};
export const glyph = (n) => `<svg viewBox="0 0 96 96">${GLYPHS[n] || ''}</svg>`;

/* ——— 模型说明（caps 只有 id/name，这里补一行给模型卡/选单用） ——— */
export const MODEL_DESC = {
  'qwen-image-2.1-local': t('本机运行 · 多图编辑 · 自定义尺寸与实验 4K'),
  'veo-3.1-fast-generate-001': t('快速 · 支持尾帧与参考图'),
  'veo-3.1-generate-001': t('质量优先 · 支持尾帧与参考图'),
  'veo-3.1-lite-generate-001': t('轻量省额度'),
  'gemini-omni-1.1-flash': t('新一代 · 原生音轨对白 · 360p-4K'),
  'gemini-3-pro-image': t('旗舰 · 多轮续改 · 联网搜索'),
  'gemini-nano-banana-2.1': t('新款 · 超宽比例 · 图片搜索 · 最高 4K'),
  'gemini-3.1-flash-image': t('快 · 思考档 · 图片搜索'),
  'gemini-3.1-flash-lite-image': t('最省 · 仅 1K · 思考档'),
  'gemini-2.5-flash-image': t('轻量基础款'),
  'gemini-2.5-flash-tts': t('快速自然'),
  'gemini-3.1-flash-tts-preview': t('新架构预览'),
  'gemini-2.5-pro-tts': t('表现力最佳'),
  'lyria-002': t('约 30 秒配乐'),
  'lyria-3-clip-preview': t('新版预览'),
  'lyria-3-pro-preview': t('最长 3 分钟'),
};

/* 比例 chip 的小形状（按 id）：CSS 类名（media-neo.css 的 .shp-*） */
export const ASPECT_SHP = {
  '16:9': 'shp-169', '9:16': 'shp-916', '1:1': 'shp-11', '4:3': 'shp-43', '3:4': 'shp-34',
  '3:2': 'shp-32', '2:3': 'shp-23', '5:4': 'shp-54', '4:5': 'shp-45', '21:9': 'shp-219',
  '4:1': 'shp-41', '1:4': 'shp-14', '8:1': 'shp-81', '1:8': 'shp-18',
};

/* 音乐灵感 chips */
// 点一下填进提示词栏（用户看得见）：按界面语言出词。
export const MUSIC_IDEAS = [t('温柔钢琴独奏'), t('史诗管弦配乐'), t('Lo-fi 学习节拍'), t('赛博朋克合成波'), t('国风竹笛山水'), t('慵懒爵士三重奏')];
