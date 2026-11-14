// 基线：打开各类型文件，断言渲染成功（云端 = 普通网页；local-* = 手机本地分页，走本地桩）。
// 表驱动：加一种文件就往 CASES 里加一行。level 'goal' 的断言是改版目标，基线上不过属预期（如 HEVC、GBK、加密 PDF 的密码框）。
import * as C from '../lib/checks.mjs';

const CASES = [
  { id: 'img-big', rel: '图片/大图-8000x6000.jpg', kind: 'image', check: (ctx, t0) => C.image(ctx, { t0 }) },
  {
    id: 'img-exif6', rel: '图片/EXIF方向6-竖拍.jpg', kind: 'image',
    async check(ctx, t0) {
      const st = await C.image(ctx, { t0 });
      // 原始像素是横的（4000×3000），正确显示应是竖的：显示矩形高 > 宽
      if (st) ctx.assert('按 EXIF 转正（显示为竖图）', st.rect.h > st.rect.w, `${st.rect.w}×${st.rect.h}`);
    },
  },
  { id: 'img-pano', rel: '图片/全景-12000x800.jpg', kind: 'image', check: (ctx, t0) => C.image(ctx, { t0 }) },
  { id: 'img-png-alpha', rel: '图片/透明.png', kind: 'image', check: (ctx, t0) => C.image(ctx, { t0 }) },
  { id: 'img-gif', rel: '图片/动图.gif', kind: 'image', check: (ctx, t0) => C.image(ctx, { t0 }) },
  { id: 'img-webp', rel: '图片/图.webp', kind: 'image', check: (ctx, t0) => C.image(ctx, { t0 }) },
  { id: 'img-svg', rel: '图片/矢量.svg', kind: 'image', check: (ctx, t0) => C.image(ctx, { t0 }) },
  {
    id: 'img-1x1', rel: '图片/极小-1x1.png', kind: 'image',
    async check(ctx, t0) {
      const st = await C.image(ctx, { t0 });
      if (st) ctx.metric('displayed', `${st.rect.w}×${st.rect.h}`);
    },
  },
  { id: 'video-h264', rel: '视频/1080p-h264-带声.mp4', kind: 'video', check: (ctx, t0) => C.video(ctx, { t0 }) },
  { id: 'video-hevc', rel: '视频/hevc.mp4', kind: 'video', check: (ctx, t0) => C.video(ctx, { t0, level: 'goal', timeout: 15000 }) },
  { id: 'video-portrait', rel: '视频/竖拍-1080x1920.mp4', kind: 'video', check: (ctx, t0) => C.video(ctx, { t0 }) },
  { id: 'video-webm', rel: '视频/vp9.webm', kind: 'video', check: (ctx, t0) => C.video(ctx, { t0 }) },
  { id: 'video-mov', rel: '视频/片段.mov', kind: 'video', check: (ctx, t0) => C.video(ctx, { t0 }) },
  { id: 'audio-mp3', rel: '音频/带封面.mp3', kind: 'audio', check: (ctx, t0) => C.audio(ctx, { t0 }) },
  { id: 'audio-long', rel: '音频/长音频-40分钟.mp3', kind: 'audio', check: (ctx, t0) => C.audio(ctx, { t0, timeout: 30000 }) },
  {
    id: 'pdf-300', rel: '文档/300页-书签-文本层.pdf', kind: 'pdf',
    async check(ctx, t0) {
      await C.canvas(ctx, { t0 });
      // 文本层（改版目标）：能在 DOM 里找到页面上的字
      const tl = await ctx.eval(`(() => { const r = __pvqa.root(); return !!r && (r.innerText || '').includes('可选中的文本层'); })()`).catch(() => false);
      ctx.assert('PDF 文本层可选中', tl, tl, { level: 'goal' });
    },
  },
  { id: 'pdf-cn', rel: '文档/中文字体.pdf', kind: 'pdf', check: (ctx, t0) => C.canvas(ctx, { t0 }) },
  { id: 'pdf-mixed', rel: '文档/横竖混排.pdf', kind: 'pdf', check: (ctx, t0) => C.canvas(ctx, { t0 }) },
  { id: 'pdf-scan', rel: '文档/扫描图.pdf', kind: 'pdf', check: (ctx, t0) => C.canvas(ctx, { t0 }) },
  {
    id: 'pdf-encrypted', rel: '文档/加密-密码1234.pdf', kind: 'pdf',
    async check(ctx) {
      let pw = false;
      try { pw = await ctx.waitFor(`!!__pvqa.root()?.querySelector('input[type=password]')`, 12000, '密码输入框'); } catch {}
      ctx.assert('加密 PDF 给出密码输入框', pw, pw, { level: 'goal' });
    },
  },
  {
    id: 'docx', rel: '文档/报告.docx', kind: 'office', timeout: 120000,
    async check(ctx, t0) {
      // 服务端转 PDF（画布）或客户端回落（HTML 里有正文）都算渲染成功
      const ok = await ctx.waitFor(`(() => { const r = __pvqa.root(); if (!r) return null; const cv = [...r.querySelectorAll('canvas')].find((c) => c.width > 0 && __pvqa.canvasDrawn(c)); if (cv) return 'pdf'; return (r.innerText || '').includes('第 1 章') ? 'html' : null; })()`, 90000, 'docx 渲染').catch(() => null);
      ctx.metric('openMs', ok ? Date.now() - t0 : null);
      ctx.metric('path', ok);
      ctx.assert('docx 渲染成功', !!ok, ok);
    },
  },
  {
    id: 'xlsx', rel: '文档/数据表.xlsx', kind: 'office', timeout: 120000,
    async check(ctx, t0) {
      const ok = await ctx.waitFor(`(() => { const r = __pvqa.root(); if (!r) return null; const cells = r.querySelectorAll('td').length; if (cells > 20) return { cells }; const cv = [...r.querySelectorAll('canvas')].find((c) => c.width > 0 && __pvqa.canvasDrawn(c)); return cv ? { canvas: true } : null; })()`, 90000, 'xlsx 渲染').catch(() => null);
      ctx.metric('openMs', ok ? Date.now() - t0 : null);
      ctx.metric('render', ok);
      ctx.assert('xlsx 渲染成功', !!ok, ok);
    },
  },
  {
    id: 'pptx', rel: '文档/演示.pptx', kind: 'office', timeout: 120000,
    async check(ctx, t0) {
      const ok = await ctx.waitFor(`(() => { const r = __pvqa.root(); if (!r) return null; const cv = [...r.querySelectorAll('canvas')].find((c) => c.width > 0 && __pvqa.canvasDrawn(c)); if (cv) return 'pdf'; return (r.innerText || '').includes('第 2 页') ? 'html' : null; })()`, 90000, 'pptx 渲染').catch(() => null);
      ctx.metric('openMs', ok ? Date.now() - t0 : null);
      ctx.metric('path', ok);
      ctx.assert('pptx 渲染成功', !!ok, ok);
    },
  },
  {
    id: 'md', rel: '笔记/笔记.md', kind: 'markdown',
    async check(ctx, t0) {
      await C.text(ctx, '预览样张笔记', { t0, name: 'md 标题渲染' });
      await C.imagesLoaded(ctx, { min: 2, name: 'md 相对路径图片（≥2 张）' });
      // KaTeX 是懒加载的：等一会儿再数（只数一次会因为加载先后在不同档上忽对忽错）
      const k = await ctx.waitFor(`__pvqa.root()?.querySelectorAll('.katex').length || 0`, 6000, 'KaTeX').catch(() => 0);
      ctx.assert('KaTeX 公式渲染', k > 0, k, { level: 'goal' });
      const code = await ctx.eval(`__pvqa.root()?.querySelectorAll('pre code, pre').length || 0`).catch(() => 0);
      ctx.metric('codeBlocks', code);
    },
  },
  { id: 'code-js', rel: '代码/大文件.js', kind: 'text', check: (ctx, t0) => C.text(ctx, 'export function handler1(', { t0, timeout: 30000 }) },
  { id: 'code-json', rel: '代码/数据.json', kind: 'text', check: (ctx, t0) => C.text(ctx, '"title": "样张 JSON"', { t0, timeout: 30000 }) },
  { id: 'text-log', rel: '代码/运行.log', kind: 'text', check: (ctx, t0) => C.text(ctx, '处理请求', { t0, timeout: 30000 }) },
  { id: 'text-gbk', rel: '代码/GBK编码.txt', kind: 'text', check: (ctx, t0) => C.text(ctx, '床前明月光', { t0, timeout: 10000, level: 'goal', name: 'GBK 文本正确解码' }) },
  {
    id: 'html', rel: '网页/index.html', kind: 'html',
    async check(ctx, t0) {
      const ok = await ctx.waitFor(`(() => { const f = __pvqa.root()?.querySelector('iframe'); return f && f.getBoundingClientRect().height > 50; })()`, 15000, 'iframe').catch(() => false);
      ctx.metric('openMs', ok ? Date.now() - t0 : null);
      ctx.assert('HTML iframe 渲染', !!ok, ok);
    },
  },
];

// 手机本地分页（apk 模式）抽测这几类：本地走 /__localfile（Range）与 thumb=1
const LOCAL = ['img-big', 'img-exif6', 'video-h264', 'audio-mp3', 'pdf-300', 'docx', 'md', 'code-js'];

function scenario(c, local) {
  return {
    id: (local ? 'local-open-' : 'open-') + c.id,
    title: (local ? '本地 · ' : '') + '打开 ' + c.rel,
    tags: ['baseline', 'open', ...(local ? ['local'] : [])],
    mode: local ? 'apk' : 'web',
    only: local ? (cfg) => cfg.touch : undefined,
    timeout: c.timeout || 90000,
    async run(ctx) {
      let item = ctx.item(c.rel, { kind: c.kind });
      // 本地的 md / 文本：同 FilesPanel，先同步读出文本交给查看器
      if (local && (c.kind === 'markdown' || c.kind === 'text' || c.kind === 'html')) {
        const txt = await ctx.eval(`window.AndroidStore.localReadText(${JSON.stringify(item.rel)})`);
        item = { ...item, text: txt };
      }
      const t0 = Date.now();
      await ctx.open([item], 0);
      await c.check(ctx, t0);
      await ctx.shot();
    },
  };
}

export default [...CASES.map((c) => scenario(c, false)), ...CASES.filter((c) => LOCAL.includes(c.id)).map((c) => scenario(c, true))];
