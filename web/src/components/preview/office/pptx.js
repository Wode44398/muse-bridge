// pptx 客户端解析（没有 LibreOffice / 转换失败 / 离线时的回落）：把幻灯片读成「绝对定位的形状列表」，PptSlide 照着画。
// 目标是「版式看得出原样」而不是像素级：
//   · 位置与大小：形状自己的 xfrm；占位符没写就按 版式 → 母版 里同类占位符继承；组合形状按 chOff / chExt 换算；
//   · 文字：段落对齐 / 级别缩进 / 项目符号 / 行距 / 段前，字号 粗斜下划线 颜色 字体，自动缩小（normAutofit fontScale）；
//     样式按 运行 → 段落 → 形状 lstStyle → 版式占位符 → 母版占位符 → 母版 txStyles（标题 / 正文 / 其它）→ 演示文稿缺省 逐级找；
//   · 填充与线条：纯色、渐变（取首尾色画线性渐变）、图片填充、主题色（含 lumMod / lumOff / tint / shade / alpha）；
//     矩形 / 圆角矩形 / 椭圆照形画，其它预设几何按矩形；
//   · 图片（EMF / WMF 浏览器画不了，留个占位框）、表格（合并单元格、单元格底色；套了表格样式的按 Office 缺省「中度样式 2」上色）、
//     图表（柱 / 条 / 折线 / 面积 / 饼 / 圆环：读缓存的数据画成 SVG）、背景（幻灯片 → 版式 → 母版）、演讲者备注。
// 坐标统一换成「磅」（EMU / 12700）：幻灯片按磅宽画、整体 CSS 缩放，字号直接用磅数，缩略图与放映同一套排版。
// 只在主线程用（要 DOMParser）。

const EMU_PT = 12700;
const pt = (v) => (v == null || v === '' ? 0 : +v / EMU_PT);
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

// —— XML 小工具（按 localName 找，不管前缀）——
const kid = (el, name) => { if (!el) return null; for (const c of el.children) if (c.localName === name) return c; return null; };
const kids = (el, name) => { const o = []; if (!el) return o; for (const c of el.children) if (c.localName === name) o.push(c); return o; };
const path = (el, ...names) => { for (const n of names) { el = kid(el, n); if (!el) return null; } return el; };
const deep = (el, name) => (el ? el.getElementsByTagNameNS('*', name)[0] || null : null);
const deepAll = (el, name) => (el ? [...el.getElementsByTagNameNS('*', name)] : []);
const att = (el, name) => (el ? el.getAttribute(name) : null);
const rid = (el, name) => (el ? el.getAttributeNS(NS_R, name) || el.getAttribute('r:' + name) : null);

function parseXml(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  return doc.documentElement;
}

/** 相对路径解析：base 是 ppt/slides/slide1.xml，target 是 ../media/image1.png */
function resolvePath(base, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = base.split('/');
  parts.pop();
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

// —— 颜色 ——
function hexToRgb(h) { const n = parseInt(h, 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]) {
  if (!s) return [l * 255, l * 255, l * 255];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = (t) => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p; };
  return [f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255];
}
const cssRgb = (c, a = 1) => (a >= 1 ? `rgb(${c.map((v) => Math.round(Math.max(0, Math.min(255, v)))).join(',')})` : `rgba(${c.map((v) => Math.round(Math.max(0, Math.min(255, v)))).join(',')},${+a.toFixed(3)})`);

const SYS = { window: 'FFFFFF', windowText: '000000', btnFace: 'F0F0F0', btnText: '000000', highlight: '0078D7', highlightText: 'FFFFFF', grayText: '6D6D6D' };

/** 颜色元素（srgbClr / schemeClr / sysClr / prstClr / scrgbClr / hslClr 的父节点或本身）→ css 颜色；ctx.scheme 主题色、ctx.map 色彩映射、ctx.ph 样式里的 phClr */
function colorOf(el, ctx) {
  if (!el) return '';
  const c = ['srgbClr', 'schemeClr', 'sysClr', 'prstClr', 'scrgbClr', 'hslClr'].includes(el.localName) ? el : [...el.children].find((x) => /Clr$/.test(x.localName));
  if (!c) return '';
  let rgb = null;
  switch (c.localName) {
    case 'srgbClr': rgb = hexToRgb(att(c, 'val') || '000000'); break;
    case 'sysClr': rgb = hexToRgb(att(c, 'lastClr') || SYS[att(c, 'val')] || '000000'); break;
    case 'prstClr': rgb = hexToRgb(PRST[att(c, 'val')] || '000000'); break;
    case 'scrgbClr': rgb = ['r', 'g', 'b'].map((k) => Math.round(255 * Math.min(1, (+att(c, k) || 0) / 100000))); break;
    case 'hslClr': rgb = hslToRgb([(+att(c, 'hue') || 0) / 21600000, (+att(c, 'sat') || 0) / 100000, (+att(c, 'lum') || 0) / 100000]); break;
    case 'schemeClr': {
      let v = att(c, 'val');
      if (v === 'phClr') { if (!ctx.ph) return ''; rgb = ctx.ph.rgb; break; }
      v = ctx.map?.[v] || v;
      const h = ctx.scheme?.[v];
      rgb = h ? hexToRgb(h) : [0, 0, 0];
      break;
    }
  }
  let a = 1;
  for (const m of c.children) {
    const v = (+att(m, 'val') || 0) / 100000;
    switch (m.localName) {
      case 'lumMod': { const h = rgbToHsl(rgb); h[2] *= v; rgb = hslToRgb(h); break; }
      case 'lumOff': { const h = rgbToHsl(rgb); h[2] = Math.min(1, h[2] + v); rgb = hslToRgb(h); break; }
      case 'satMod': { const h = rgbToHsl(rgb); h[1] = Math.min(1, h[1] * v); rgb = hslToRgb(h); break; }
      case 'tint': rgb = rgb.map((x) => x + (255 - x) * (1 - v)); break;
      case 'shade': rgb = rgb.map((x) => x * v); break;
      case 'alpha': a = v; break;
    }
  }
  const out = cssRgb(rgb, a);
  return Object.assign(new String(out), { rgb, a });
}
const PRST = { black: '000000', white: 'FFFFFF', red: 'FF0000', green: '008000', blue: '0000FF', yellow: 'FFFF00', gray: '808080', grey: '808080', orange: 'FFA500', purple: '800080' };

/** 填充：solidFill / gradFill / blipFill / noFill / grpFill → { css, none } */
function fillOf(spPr, ctx, files) {
  if (!spPr) return null;
  for (const f of spPr.children) {
    switch (f.localName) {
      case 'noFill': return { css: 'transparent', none: true };
      case 'solidFill': { const c = colorOf(f, ctx); return c ? { css: String(c) } : null; }
      case 'gradFill': {
        const stops = deepAll(f, 'gs').map((g) => ({ pos: (+att(g, 'pos') || 0) / 1000, c: String(colorOf(g, ctx)) })).sort((a, b) => a.pos - b.pos);
        if (!stops.length) return null;
        const lin = kid(f, 'lin');
        const ang = lin ? (+att(lin, 'ang') || 0) / 60000 : 90;
        if (kid(f, 'path')) return { css: `radial-gradient(circle, ${stops.map((s) => `${s.c} ${s.pos}%`).join(',')})` };
        return { css: `linear-gradient(${(ang + 90) % 360}deg, ${stops.map((s) => `${s.c} ${s.pos}%`).join(',')})` };
      }
      case 'blipFill': {
        const u = files.media(rid(kid(f, 'blip'), 'embed'));
        return u ? { css: `center / cover no-repeat url("${u}")`, img: true } : null;
      }
      case 'grpFill': return ctx.grpFill || null;
    }
  }
  return null;
}
function lineOf(spPr, ctx) {
  const ln = kid(spPr, 'ln');
  if (!ln) return null;
  if (kid(ln, 'noFill')) return { none: true };
  const sf = kid(ln, 'solidFill');
  const c = sf ? String(colorOf(sf, ctx)) : '';
  const w = att(ln, 'w') != null ? Math.max(0.5, pt(att(ln, 'w'))) : 0.75;
  const dash = att(kid(ln, 'prstDash'), 'val');
  return c ? { c, w, dash: dash && dash !== 'solid' ? 'dashed' : 'solid' } : null;
}

// —— 主题 ——
function readTheme(root) {
  const scheme = {}, fonts = { major: {}, minor: {} };
  const cs = deep(root, 'clrScheme');
  if (cs) for (const c of cs.children) {
    const v = c.firstElementChild;
    if (!v) continue;
    scheme[c.localName] = v.localName === 'sysClr' ? (att(v, 'lastClr') || SYS[att(v, 'val')] || '000000') : (att(v, 'val') || '000000');
  }
  const fs = deep(root, 'fontScheme');
  for (const k of ['major', 'minor']) {
    const f = kid(fs, k + 'Font');
    if (!f) continue;
    fonts[k] = { latin: att(kid(f, 'latin'), 'typeface') || '', ea: att(kid(f, 'ea'), 'typeface') || '' };
    for (const x of kids(f, 'font')) if (/^Hans$/.test(att(x, 'script'))) fonts[k].hans = att(x, 'typeface');
  }
  // 填充样式表（形状 p:style 的 fillRef idx 引用）
  const fmt = deep(root, 'fmtScheme');
  const fills = fmt ? [...(kid(fmt, 'fillStyleLst')?.children || [])] : [];
  const lines = fmt ? [...(kid(fmt, 'lnStyleLst')?.children || [])] : [];
  return { scheme, fonts, fills, lines };
}

function fontStack(face, theme) {
  const pick = (f) => {
    if (!f) return '';
    if (f === '+mj-lt') return theme.fonts.major.latin;
    if (f === '+mn-lt') return theme.fonts.minor.latin;
    if (f === '+mj-ea') return theme.fonts.major.hans || theme.fonts.major.ea;
    if (f === '+mn-ea') return theme.fonts.minor.hans || theme.fonts.minor.ea;
    return f;
  };
  const list = [pick(face.latin), pick(face.ea)].filter((x) => x && !/^\+/.test(x));
  return [...new Set(list)].map((f) => `"${f.replace(/"/g, '')}"`).join(',');
}

// —— 包 ——
function makeFiles(zip, strFromU8, urls) {
  const textCache = new Map(), xmlCache = new Map(), relCache = new Map(), mediaCache = new Map();
  const text = (p) => {
    if (textCache.has(p)) return textCache.get(p);
    const v = zip[p] ? strFromU8(zip[p]) : null;
    textCache.set(p, v);
    return v;
  };
  const xml = (p) => {
    if (xmlCache.has(p)) return xmlCache.get(p);
    const t = text(p);
    const v = t ? parseXml(t) : null;
    xmlCache.set(p, v);
    return v;
  };
  const rels = (p) => {
    if (relCache.has(p)) return relCache.get(p);
    const i = p.lastIndexOf('/');
    const root = xml(p.slice(0, i) + '/_rels/' + p.slice(i + 1) + '.rels');
    const map = new Map();
    if (root) for (const r of kids(root, 'Relationship')) {
      const external = att(r, 'TargetMode') === 'External';
      map.set(att(r, 'Id'), { type: (att(r, 'Type') || '').split('/').pop(), target: external ? att(r, 'Target') : resolvePath(p, att(r, 'Target') || ''), external });
    }
    relCache.set(p, map);
    return map;
  };
  const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff' };
  const mediaAt = (p) => {
    if (mediaCache.has(p)) return mediaCache.get(p);
    const ext = (p.split('.').pop() || '').toLowerCase();
    let u = '';
    if (zip[p] && MIME[ext]) { u = URL.createObjectURL(new Blob([zip[p]], { type: MIME[ext] })); urls.push(u); }
    else if (zip[p]) u = 'unsupported:' + ext;   // EMF / WMF 等：画占位框
    mediaCache.set(p, u);
    return u;
  };
  return { text, xml, rels, mediaAt };
}

// —— 文字样式链 ——
/** 一个 lstStyle / txStyles 子节点 → 级别 1..9 的 pPr 数组 */
function levels(lst) {
  if (!lst) return null;
  const out = [];
  for (let i = 1; i <= 9; i++) out[i] = kid(lst, `lvl${i}pPr`);
  const def = kid(lst, 'defPPr');
  if (def) out[0] = def;
  return out;
}

function paraStyle(chain, lvl, name) {
  for (const L of chain) {
    const p = L?.[lvl];
    if (!p) continue;
    const v = att(p, name);
    if (v != null) return v;
  }
  return null;
}
function paraKid(chain, lvl, names) {
  for (const L of chain) {
    const p = L?.[lvl];
    if (!p) continue;
    for (const c of p.children) if (names.includes(c.localName)) return c;
  }
  return null;
}
function runAttr(rPrs, name) { for (const r of rPrs) { const v = att(r, name); if (v != null) return v; } return null; }
function runKid(rPrs, name) { for (const r of rPrs) { const k = kid(r, name); if (k) return k; } return null; }

// —— 形状 ——
function xfrmOf(spPr) {
  const x = kid(spPr, 'xfrm');
  if (!x) return null;
  const off = kid(x, 'off'), ext = kid(x, 'ext');
  if (!off || !ext) return null;
  return {
    x: +att(off, 'x') || 0, y: +att(off, 'y') || 0, w: +att(ext, 'cx') || 0, h: +att(ext, 'cy') || 0,
    rot: (+att(x, 'rot') || 0) / 60000, flipH: att(x, 'flipH') === '1', flipV: att(x, 'flipV') === '1',
    chOff: kid(x, 'chOff'), chExt: kid(x, 'chExt'),
  };
}

function phOf(nvPr) {
  const ph = kid(nvPr, 'ph');
  if (!ph) return null;
  return { type: att(ph, 'type') || 'obj', idx: att(ph, 'idx') };
}
const PH_KIND = (type) => (type === 'title' || type === 'ctrTitle' ? 'title' : type === 'body' || type === 'subTitle' || type === 'obj' ? 'body' : type);

/** 在版式 / 母版的形状树里找同一个占位符 */
function findPh(tree, ph, byIdx) {
  if (!tree || !ph) return null;
  let typeHit = null;
  for (const sp of deepAll(tree, 'sp')) {
    const p = phOf(path(sp, 'nvSpPr', 'nvPr'));
    if (!p) continue;
    if (byIdx && ph.idx != null && p.idx === ph.idx) return sp;
    if (!typeHit && (p.type === ph.type || PH_KIND(p.type) === PH_KIND(ph.type))) typeHit = sp;
  }
  return typeHit;
}

function txStyleKind(ph) {
  if (!ph) return 'otherStyle';
  const k = PH_KIND(ph.type);
  return k === 'title' ? 'titleStyle' : k === 'body' ? 'bodyStyle' : 'otherStyle';
}

/**
 * 读一页（或版式 / 母版）的形状树。
 * level：{ name: 'slide'|'layout'|'master', layoutTree, masterTree } 继承来源；skipPh：版式 / 母版里的占位符不画
 */
function readTree(tree, env, level, out, grp = null) {
  for (const el of tree.children) {
    const n = el.localName;
    if (n === 'sp' || n === 'cxnSp') readShape(el, env, level, out, grp);
    else if (n === 'pic') readPic(el, env, level, out, grp);
    else if (n === 'graphicFrame') readFrame(el, env, level, out, grp);
    else if (n === 'grpSp') {
      const gx = xfrmOf(kid(el, 'grpSpPr'));
      if (!gx) { readTree(el, env, level, out, grp); continue; }
      const outer = place(gx, grp);
      const cx0 = +att(gx.chOff, 'x') || 0, cy0 = +att(gx.chOff, 'y') || 0;
      const cw = +att(gx.chExt, 'cx') || gx.w || 1, chh = +att(gx.chExt, 'cy') || gx.h || 1;
      const sub = { ox: outer.x, oy: outer.y, sx: outer.w / cw, sy: outer.h / chh, cx0, cy0, fill: fillOf(kid(el, 'grpSpPr'), env.ctx, env.files) };
      readTree(el, env, level, out, sub);
    } else if (n === 'AlternateContent') {
      const ch = kid(el, 'Choice') && [...kid(el, 'Choice').children].some((c) => c.localName === 'sp' || c.localName === 'pic' || c.localName === 'grpSp') ? kid(el, 'Choice') : kid(el, 'Fallback');
      if (ch) readTree(ch, env, level, out, grp);
    }
  }
}
/** 组合里的子形状坐标 → 幻灯片坐标（EMU） */
function place(x, grp) {
  if (!grp) return { x: x.x, y: x.y, w: x.w, h: x.h };
  return { x: grp.ox + (x.x - grp.cx0) * grp.sx, y: grp.oy + (x.y - grp.cy0) * grp.sy, w: x.w * grp.sx, h: x.h * grp.sy };
}
function box(x, grp) {
  const p = place(x, grp);
  return { x: pt(p.x), y: pt(p.y), w: pt(p.w), h: pt(p.h), rot: x.rot || 0, flipH: x.flipH, flipV: x.flipV };
}

function inherited(el, env, level) {
  const nv = kid(el, 'nvSpPr') || kid(el, 'nvPicPr') || kid(el, 'nvGraphicFramePr') || kid(el, 'nvCxnSpPr');
  const ph = phOf(kid(nv, 'nvPr'));
  let lay = null, mas = null;
  if (ph) {
    if (level.name === 'slide') { lay = findPh(level.layoutTree, ph, true); mas = findPh(level.masterTree, ph, false); }
    else if (level.name === 'layout') mas = findPh(level.masterTree, ph, false);
  }
  return { ph, lay, mas, name: att(kid(nv, 'cNvPr'), 'name') || '', descr: att(kid(nv, 'cNvPr'), 'descr') || '', hidden: att(kid(nv, 'cNvPr'), 'hidden') === '1' };
}

function readShape(el, env, level, out, grp) {
  const inh = inherited(el, env, level);
  if (inh.hidden) return;
  // 版式 / 母版里的占位符是「提示框」，不画；日期 / 页脚 / 页码只有幻灯片自己放了才画
  if (inh.ph && level.name !== 'slide') return;
  const spPr = kid(el, 'spPr');
  const x = xfrmOf(spPr) || xfrmOf(kid(inh.lay, 'spPr')) || xfrmOf(kid(inh.mas, 'spPr'));
  if (!x) return;
  const b = box(x, grp);
  const ctx = env.ctx;
  const style = kid(el, 'style');
  // 形状样式引用（插入的形状缺省是 accent1 填充、深一号的边框、白字）
  let refFill = null, refLine = null, refFont = '';
  if (style) {
    const fr = kid(style, 'fillRef'), lr = kid(style, 'lnRef'), fo = kid(style, 'fontRef');
    const idx = +att(fr, 'idx') || 0;
    if (fr && idx > 0) {
      const phc = colorOf(fr, ctx);
      const tpl = env.theme.fills[idx - 1];
      refFill = tpl ? fillOf({ children: [tpl] }, { ...ctx, ph: phc }, env.files) : phc ? { css: String(phc) } : null;
    }
    if (lr && +att(lr, 'idx') > 0) {
      const phc = colorOf(lr, ctx);
      const tpl = env.theme.lines[+att(lr, 'idx') - 1];
      const w = tpl && att(tpl, 'w') != null ? Math.max(0.5, pt(att(tpl, 'w'))) : 0.75;
      if (phc) refLine = { c: String(phc), w, dash: 'solid' };
    }
    if (fo) refFont = String(colorOf(fo, ctx) || '');
  }
  const fill = fillOf(spPr, ctx, env.files) || (grp?.fill && kid(spPr, 'grpFill') ? grp.fill : null) || refFill;
  const line = lineOf(spPr, ctx) || refLine;
  const geom = att(kid(spPr, 'prstGeom'), 'prst') || att(kid(kid(inh.lay, 'spPr'), 'prstGeom'), 'prst') || (el.localName === 'cxnSp' ? 'line' : 'rect');
  const shape = { kind: 'shape', ...b, geom, fill: fill?.none ? null : fill, line: line?.none ? null : line };
  if (geom === 'roundRect') {
    const gd = deepAll(kid(spPr, 'prstGeom'), 'gd').find((g) => att(g, 'name') === 'adj');
    const adj = gd ? +(/val\s+(\d+)/.exec(att(gd, 'fmla') || '')?.[1] || 16667) : 16667;
    shape.radius = Math.min(b.w, b.h) * adj / 100000;
  }
  const tx = kid(el, 'txBody');
  if (tx) {
    const body = readText(tx, inh, env, level, refFont);
    if (body) { shape.text = body; shape.kind = 'text'; }
  }
  if (!shape.text && !shape.fill && !shape.line) return;
  out.push(shape);
}

function readPic(el, env, level, out, grp, frame = null) {
  const inh = inherited(el, env, level);
  if (inh.hidden || (inh.ph && level.name !== 'slide')) return;
  const spPr = kid(el, 'spPr');
  const x = frame || xfrmOf(spPr) || xfrmOf(kid(inh.lay, 'spPr')) || xfrmOf(kid(inh.mas, 'spPr'));
  if (!x) return;
  const blip = deep(kid(el, 'blipFill'), 'blip');
  const src = env.files.media(rid(blip, 'embed'));
  const crop = deep(kid(el, 'blipFill'), 'srcRect');
  const c = crop ? ['l', 't', 'r', 'b'].map((k) => (+att(crop, k) || 0) / 100000) : null;
  const geom = att(kid(spPr, 'prstGeom'), 'prst') || 'rect';
  const line = lineOf(spPr, env.ctx);
  out.push({ kind: 'pic', ...box(x, grp), src, crop: c && c.some(Boolean) ? c : null, geom, line: line?.none ? null : line, alt: inh.descr });
}

function readFrame(el, env, level, out, grp) {
  const inh = inherited(el, env, level);
  if (inh.hidden || (inh.ph && level.name !== 'slide')) return;
  const xf = kid(el, 'xfrm');
  const off = kid(xf, 'off'), ext = kid(xf, 'ext');
  if (!off || !ext) return;
  const fx = { x: +att(off, 'x') || 0, y: +att(off, 'y') || 0, w: +att(ext, 'cx') || 0, h: +att(ext, 'cy') || 0 };
  const b = box(fx, grp);
  const gd = path(el, 'graphic', 'graphicData');
  const uri = att(gd, 'uri') || '';
  if (/table$/.test(uri)) {
    const tbl = kid(gd, 'tbl');
    if (tbl) out.push({ kind: 'table', ...b, table: readTable(tbl, env, level) });
  } else if (/chart$/.test(uri)) {
    const c = deep(gd, 'chart');
    const r = env.rels.get(rid(c, 'id'));
    const chart = r ? readChart(env.files.xml(r.target), env) : null;
    out.push({ kind: 'chart', ...b, chart });
  } else if (/diagram$/.test(uri) && smartArt(gd, fx, env, level, out, grp)) {
    // SmartArt：PowerPoint 存了一份排好版的绘图（diagrams/drawingN.xml），照普通形状画
  } else {
    // OLE / 媒体：有回落图就用回落图（铺满对象框），否则占位框
    const pic = deep(el, 'pic');
    if (pic) { readPic(pic, env, level, out, grp, fx); return; }
    out.push({ kind: 'pic', ...b, src: 'unsupported:' + (uri.split('/').pop() || 'object'), alt: inh.name });
  }
}

/** SmartArt 的预排版绘图：数据模型 → dataModelExt relId → 幻灯片 rels 里的 drawing 部件；坐标相对对象框 */
function smartArt(gd, fx, env, level, out, grp) {
  const ids = kid(gd, 'relIds');
  const dm = env.rels.get(rid(ids, 'dm'));
  const data = dm ? env.files.xml(dm.target) : null;
  const relId = att(deep(data, 'dataModelExt'), 'relId');
  const dr = relId ? env.rels.get(relId) : null;
  const root = dr ? env.files.xml(dr.target) : null;
  const tree = deep(root, 'spTree');
  if (!tree) return false;
  const rels = env.files.rels(dr.target);
  const sub = { ...env, rels, files: { ...env.files, media: (id) => { const r = rels.get(id); return r && !r.external ? env.files.mediaAt(r.target) : ''; } } };
  const at = place(fx, grp);
  const s = grp ? grp.sx : 1, t = grp ? grp.sy : 1;
  readTree(tree, sub, { ...level, name: 'art' }, out, { ox: at.x, oy: at.y, sx: s, sy: t, cx0: 0, cy0: 0, fill: null });
  return true;
}

function readText(tx, inh, env, level, refFont) {
  const bodyPr = kid(tx, 'bodyPr');
  const layBody = kid(kid(inh.lay, 'txBody'), 'bodyPr'), masBody = kid(kid(inh.mas, 'txBody'), 'bodyPr');
  const bp = (name) => att(bodyPr, name) ?? att(layBody, name) ?? att(masBody, name);
  const fit = kid(bodyPr, 'normAutofit');
  const fontScale = fit ? (+att(fit, 'fontScale') || 100000) / 100000 : 1;
  const lnRed = fit ? (+att(fit, 'lnSpcReduction') || 0) / 100000 : 0;
  const chain = [
    levels(kid(tx, 'lstStyle')),
    levels(kid(kid(inh.lay, 'txBody'), 'lstStyle')),
    levels(kid(kid(inh.mas, 'txBody'), 'lstStyle')),
    // 非占位符（文本框、表格）先走演示文稿的缺省文字样式，再落到母版的 otherStyle
    ...(inh.ph ? [] : [env.defStyle]),
    env.txStyles[txStyleKind(inh.ph)],
  ];
  const paras = [];
  let any = false, autoNum = new Map();
  for (const p of kids(tx, 'p')) {
    const pPr = kid(p, 'pPr');
    const lvl = (+att(pPr, 'lvl') || 0) + 1;
    // 段落自己的 pPr 排在样式链最前（只在本级生效）
    const pchain = pPr ? [Array.from({ length: 10 }, (_, i) => (i === lvl ? pPr : null)), ...chain] : chain;
    const algn = paraStyle(pchain, lvl, 'algn') || 'l';
    const marL = pt(paraStyle(pchain, lvl, 'marL'));
    const indent = pt(paraStyle(pchain, lvl, 'indent'));
    const defRPrs = [kid(pPr, 'defRPr'), ...pchain.map((L) => kid(L?.[lvl], 'defRPr'))].filter(Boolean);
    const lnSpc = paraKid(pchain, lvl, ['lnSpc']);
    const spcBef = paraKid(pchain, lvl, ['spcBef']), spcAft = paraKid(pchain, lvl, ['spcAft']);
    const spc = (el) => {
      if (!el) return null;
      const pc = kid(el, 'spcPct'), ps = kid(el, 'spcPts');
      return pc ? { pct: (+att(pc, 'val') || 100000) / 100000 } : ps ? { pts: (+att(ps, 'val') || 0) / 100 } : null;
    };
    const runs = [];
    for (const r of p.children) {
      if (r.localName === 'r' || r.localName === 'fld') {
        const t = kid(r, 't')?.textContent ?? '';
        if (!t) continue;
        runs.push(runStyle(t, [kid(r, 'rPr'), ...defRPrs], env, refFont, fontScale));
      } else if (r.localName === 'br') runs.push({ br: true, ...runStyle('', [kid(r, 'rPr'), ...defRPrs], env, refFont, fontScale) });
    }
    // 项目符号：空段落不显示、也不占编号；编号遇到更浅一级或同级非编号段落就重新数
    const bu = paraKid(pchain, lvl, ['buNone', 'buChar', 'buAutoNum', 'buBlip']);
    let bullet = null;
    if (runs.length && bu?.localName === 'buChar') bullet = { char: symbolChar(att(bu, 'char') || '•', att(paraKid(pchain, lvl, ['buFont']), 'typeface')) };
    else if (runs.length && bu?.localName === 'buAutoNum') {
      const k = lvl + ':' + (att(bu, 'type') || 'arabicPeriod');
      const n = (autoNum.get(k) || (+att(bu, 'startAt') || 1) - 1) + 1;
      autoNum = new Map([...autoNum].filter(([key]) => +key.split(':')[0] <= lvl));
      autoNum.set(k, n);
      bullet = { char: autoLabel(att(bu, 'type') || 'arabicPeriod', n) };
    }
    if (runs.length && bu?.localName !== 'buAutoNum') autoNum = new Map([...autoNum].filter(([key]) => +key.split(':')[0] < lvl));
    const buClr = paraKid(pchain, lvl, ['buClr']);
    const buSz = paraKid(pchain, lvl, ['buSzPct']);
    const end = runStyle('', [kid(p, 'endParaRPr'), ...defRPrs], env, refFont, fontScale);
    if (runs.some((x) => x.t && x.t.trim())) any = true;
    paras.push({
      algn, marL, indent, bullet: bullet ? { ...bullet, color: buClr ? String(colorOf(buClr, env.ctx)) : '', scale: buSz ? (+att(buSz, 'val') || 100000) / 100000 : 1 } : null,
      lnSpc: spc(lnSpc), spcBef: spc(spcBef), spcAft: spc(spcAft), lnRed, runs, size: end.size,
    });
  }
  if (!any) return null;
  const ins = (k, d) => { const v = bp(k); return v != null ? pt(v) : d; };
  return {
    paras,
    anchor: bp('anchor') || 't',
    wrap: bp('wrap') !== 'none',
    vert: /vert/.test(bp('vert') || '') && bp('vert') !== 'horz',
    pad: [ins('tIns', 3.6), ins('rIns', 7.2), ins('bIns', 3.6), ins('lIns', 7.2)],
  };
}

// Wingdings / Symbol 字体里的项目符号字符：浏览器多半没有这两款字体，换成 Unicode 里长得一样的
const WINGDINGS = { 'Ø': '➢', '§': '▪', 'ü': '✓', 'q': '❑', 'v': '❖', 'Ÿ': '•', 'l': '●', 'n': '■', 'è': '➔', 'à': '➔', 'Ü': '✓', 'o': '○', 'w': '◆', 'u': '◆', 'ð': '➔', '': '▪', '': '➢', '': '✓', '': '•' };
function symbolChar(ch, font) {
  if (/wingdings/i.test(font || '')) return WINGDINGS[ch] || '•';
  if (/^symbol$/i.test(font || '')) return ch === '·' || ch === '\uF0B7' ? '•' : ch;
  return ch;
}

function autoLabel(type, n) {
  const roman = (x) => { const m = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]; let s = ''; for (const [v, r] of m) while (x >= v) { s += r; x -= v; } return s; };
  const alpha = (x) => { let s = ''; while (x > 0) { s = String.fromCharCode(97 + ((x - 1) % 26)) + s; x = Math.floor((x - 1) / 26); } return s; };
  let core = String(n);
  if (/^alphaLc/.test(type)) core = alpha(n);
  else if (/^alphaUc/.test(type)) core = alpha(n).toUpperCase();
  else if (/^romanLc/.test(type)) core = roman(n);
  else if (/^romanUc/.test(type)) core = roman(n).toUpperCase();
  else if (/^circleNum/.test(type)) core = n <= 20 ? String.fromCodePoint(0x2460 + n - 1) : String(n);
  if (/ParenBoth$/.test(type)) return `(${core})`;
  if (/ParenR$/.test(type)) return `${core})`;
  if (/Period$/.test(type)) return `${core}.`;
  return core;
}

function runStyle(t, rPrs, env, refFont, fontScale) {
  rPrs = rPrs.filter(Boolean);
  const sz = runAttr(rPrs, 'sz');
  const size = (sz ? +sz / 100 : 18) * fontScale;
  const fillEl = runKid(rPrs, 'solidFill');
  let color = fillEl ? String(colorOf(fillEl, env.ctx)) : '';
  if (!color && refFont) color = refFont;
  if (!color) color = env.textColor;
  const latin = att(runKid(rPrs, 'latin'), 'typeface'), ea = att(runKid(rPrs, 'ea'), 'typeface');
  const font = fontStack({ latin: latin || '+mn-lt', ea: ea || '+mn-ea' }, env.theme);
  const u = runAttr(rPrs, 'u');
  const strike = runAttr(rPrs, 'strike');
  const base = runAttr(rPrs, 'baseline');
  const link = runKid(rPrs, 'hlinkClick');
  const href = link ? env.rels.get(rid(link, 'id')) : null;
  return {
    t, size, color, font,
    b: runAttr(rPrs, 'b') === '1', i: runAttr(rPrs, 'i') === '1',
    u: !!u && u !== 'none', strike: !!strike && strike !== 'noStrike',
    base: base ? +base / 1000 : 0, cap: runAttr(rPrs, 'cap') === 'all',
    href: href?.external && /^(https?:|mailto:)/i.test(href.target) ? href.target : '',
  };
}

function edgeOf(ln, ctx) {
  if (!ln) return '';
  if (kid(ln, 'noFill')) return 'none';
  const c = colorOf(kid(ln, 'solidFill'), ctx);
  if (!c) return '';
  const w = att(ln, 'w') != null ? Math.max(0.5, pt(att(ln, 'w'))) : 0.75;
  return `${+w.toFixed(2)}px solid ${c}`;
}

function readTable(tbl, env, level) {
  const cols = kids(kid(tbl, 'tblGrid'), 'gridCol').map((g) => pt(att(g, 'w')));
  const tp = kid(tbl, 'tblPr');
  const styled = !!kid(tp, 'tableStyleId') || !!att(tp, 'firstRow');
  const firstRow = att(tp, 'firstRow') === '1', bandRow = att(tp, 'bandRow') === '1';
  const acc = env.theme.scheme.accent1 ? hexToRgb(env.theme.scheme.accent1) : [68, 114, 196];
  const rows = [];
  kids(tbl, 'tr').forEach((tr, ri) => {
    const cells = [];
    for (const tc of kids(tr, 'tc')) {
      const tcPr = kid(tc, 'tcPr');
      const head = styled && firstRow && ri === 0;
      const fill = fillOf(tcPr, env.ctx, env.files);
      let bg = fill?.none ? 'transparent' : fill?.css || '';
      if (!bg && styled) bg = head ? cssRgb(acc) : bandRow && ri % 2 === (firstRow ? 1 : 0) ? cssRgb(acc.map((x) => x + (255 - x) * 0.6)) : cssRgb(acc.map((x) => x + (255 - x) * 0.8));
      const text = readText(kid(tc, 'txBody'), { ph: null, lay: null, mas: null }, { ...env, textColor: head ? '#fff' : env.textColor }, level, head ? '#fff' : '');
      if (text && head) for (const p of text.paras) for (const r of p.runs) if (!r.b) r.b = true;
      cells.push({
        text, bg,
        span: +att(tc, 'gridSpan') || 1, rspan: +att(tc, 'rowSpan') || 1,
        skip: att(tc, 'hMerge') === '1' || att(tc, 'vMerge') === '1',
        anchor: att(tcPr, 'anchor') || 't',
        // 单元格自己的边框（上 右 下 左）：'' 没写（按表格样式）/ 'none' 明确无线 / css 边框
        bd: ['lnT', 'lnR', 'lnB', 'lnL'].map((k) => edgeOf(kid(tcPr, k), env.ctx)),
        pad: [pt(att(tcPr, 'marT') ?? 45720), pt(att(tcPr, 'marR') ?? 91440), pt(att(tcPr, 'marB') ?? 45720), pt(att(tcPr, 'marL') ?? 91440)],
      });
    }
    rows.push({ h: pt(att(tr, 'h')), cells });
  });
  return { cols, rows, styled };
}

// —— 图表（读缓存数据）——
function readChart(root, env) {
  if (!root) return null;
  const plot = deep(root, 'plotArea');
  if (!plot) return null;
  const types = ['barChart', 'bar3DChart', 'lineChart', 'line3DChart', 'areaChart', 'area3DChart', 'pieChart', 'pie3DChart', 'doughnutChart', 'scatterChart', 'radarChart'];
  const ct = [...plot.children].find((c) => types.includes(c.localName));
  if (!ct) return { type: 'unknown' };
  const kind = ct.localName.replace(/3D/, '').replace(/Chart$/, '');
  const dir = att(kid(ct, 'barDir'), 'val') || 'col';
  const grouping = att(kid(ct, 'grouping'), 'val') || 'clustered';
  const ctx = env.ctx;
  const accents = ['accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6'].map((k) => '#' + (env.theme.scheme[k] || '4472C4'));
  const pts = (el) => {
    const cache = deep(el, 'strCache') || deep(el, 'numCache') || deep(el, 'strLit') || deep(el, 'numLit');
    if (!cache) return [];
    const n = +att(kid(cache, 'ptCount'), 'val') || 0;
    const out = new Array(n).fill(null);
    for (const p of kids(cache, 'pt')) out[+att(p, 'idx') || 0] = kid(p, 'v')?.textContent ?? null;
    return out;
  };
  const series = kids(ct, 'ser').map((s, i) => {
    const sp = kid(s, 'spPr');
    const c = fillOf(sp, ctx, env.files)?.css || lineOf(sp, ctx)?.c || accents[i % 6];
    const dpts = kids(s, 'dPt').map((d) => ({ i: +att(kid(d, 'idx'), 'val') || 0, c: fillOf(kid(d, 'spPr'), ctx, env.files)?.css || '' }));
    return {
      name: (deep(kid(s, 'tx'), 'v')?.textContent) || '',
      cats: pts(kid(s, 'cat') || kid(s, 'xVal')),
      vals: pts(kid(s, 'val') || kid(s, 'yVal')).map((v) => (v == null || v === '' ? null : +v)),
      color: c, points: dpts,
    };
  });
  const titleEl = kid(deep(root, 'chart'), 'title');
  const deleted = att(kid(deep(root, 'chart'), 'autoTitleDeleted'), 'val') === '1';
  let title = titleEl ? deepAll(titleEl, 't').map((x) => x.textContent).join('') : '';
  if (!title && titleEl && !deleted && series.length === 1) title = series[0].name;
  const legend = !!kid(deep(root, 'chart'), 'legend');
  return { type: kind, dir, grouping, series, title, legend, accents, hole: kind === 'doughnut' ? (+att(kid(ct, 'holeSize'), 'val') || 50) / 100 : 0 };
}

// —— 背景 ——
function bgOf(cSld, ctx, files, theme) {
  const bg = kid(cSld, 'bg');
  if (!bg) return null;
  const pr = kid(bg, 'bgPr');
  if (pr) { const f = fillOf(pr, ctx, files); return f ? f.css : null; }
  const ref = kid(bg, 'bgRef');
  if (ref) {
    const idx = +att(ref, 'idx') || 0;
    const phc = colorOf(ref, ctx);
    if (idx >= 1001) {
      const list = theme.bgFills || [];
      const tpl = list[idx - 1001];
      if (tpl) { const f = fillOf({ children: [tpl] }, { ...ctx, ph: phc }, files); if (f) return f.css; }
    }
    return phc ? String(phc) : null;
  }
  return null;
}

/**
 * @param {Uint8Array|ArrayBuffer} buf
 * @param {{ unzipSync, strFromU8 }} fflate
 * @returns {{ w, h, slides: Array<{ bg, shapes, notes }>, urls: string[], dispose() }}  w / h 单位磅
 */
export function parsePptx(buf, fflate) {
  const zip = fflate.unzipSync(buf instanceof Uint8Array ? buf : new Uint8Array(buf));
  const urls = [];
  const files0 = makeFiles(zip, fflate.strFromU8, urls);
  const pres = files0.xml('ppt/presentation.xml');
  if (!pres) throw Object.assign(new Error('not a pptx'), { code: 'format' });   // i18n-ignore
  const sz = kid(pres, 'sldSz');
  const W = pt(att(sz, 'cx') || 12192000), H = pt(att(sz, 'cy') || 6858000);
  const presRels = files0.rels('ppt/presentation.xml');
  const order = kids(kid(pres, 'sldIdLst'), 'sldId').map((s) => presRels.get(rid(s, 'id'))?.target).filter(Boolean);
  const defStyle = levels(kid(pres, 'defaultTextStyle'));
  const masters = new Map(), layouts = new Map();

  function master(p) {
    if (masters.has(p)) return masters.get(p);
    const root = files0.xml(p);
    const rels = files0.rels(p);
    const themeRel = [...rels.values()].find((r) => r.type === 'theme');
    const themeRoot = themeRel ? files0.xml(themeRel.target) : null;
    const theme = themeRoot ? readTheme(themeRoot) : { scheme: {}, fonts: { major: {}, minor: {} }, fills: [], lines: [] };
    if (themeRoot) theme.bgFills = [...(deep(themeRoot, 'bgFillStyleLst')?.children || [])];
    const cm = kid(root, 'clrMap');
    const map = {};
    if (cm) for (const a of cm.attributes) map[a.name] = a.value;
    const tx = kid(root, 'txStyles');
    const m = { root, rels, theme, map, tree: path(root, 'cSld', 'spTree'), cSld: kid(root, 'cSld'), txStyles: { titleStyle: levels(kid(tx, 'titleStyle')), bodyStyle: levels(kid(tx, 'bodyStyle')), otherStyle: levels(kid(tx, 'otherStyle')) } };
    masters.set(p, m);
    return m;
  }
  function layout(p) {
    if (layouts.has(p)) return layouts.get(p);
    const root = files0.xml(p);
    const rels = files0.rels(p);
    const mRel = [...rels.values()].find((r) => r.type === 'slideMaster');
    const l = { root, rels, tree: path(root, 'cSld', 'spTree'), cSld: kid(root, 'cSld'), master: mRel ? master(mRel.target) : null, showMasterSp: att(root, 'showMasterSp') !== '0' };
    const cm = path(root, 'clrMapOvr', 'overrideClrMapping');
    if (cm) { l.map = {}; for (const a of cm.attributes) l.map[a.name] = a.value; }
    layouts.set(p, l);
    return l;
  }

  const slides = [];
  for (const sp of order) {
    const root = files0.xml(sp);
    if (!root) continue;
    if (att(root, 'show') === '0') continue;   // 隐藏的幻灯片（放映时跳过）也不出
    const rels = files0.rels(sp);
    const lRel = [...rels.values()].find((r) => r.type === 'slideLayout');
    const lay = lRel ? layout(lRel.target) : null;
    const mas = lay?.master || null;
    const theme = mas?.theme || { scheme: {}, fonts: { major: {}, minor: {} }, fills: [], lines: [] };
    let map = { ...(mas?.map || { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2' }), ...(lay?.map || {}) };
    const ovr = path(root, 'clrMapOvr', 'overrideClrMapping');
    if (ovr) { map = {}; for (const a of ovr.attributes) map[a.name] = a.value; }
    const ctx = { scheme: theme.scheme, map };
    const textColor = '#' + (theme.scheme[map.tx1 || 'dk1'] || '000000');
    const mkEnv = (relsOf, partPath) => ({
      ctx, theme, textColor, defStyle, txStyles: mas?.txStyles || {}, rels: relsOf,
      files: { ...files0, media: (id) => { const r = relsOf.get(id); return r && !r.external ? files0.mediaAt(r.target) : ''; }, part: partPath },
    });
    const shapes = [];
    const showMaster = att(root, 'showMasterSp') !== '0';
    const lv = { layoutTree: lay?.tree || null, masterTree: mas?.tree || null };
    if (mas && showMaster && lay?.showMasterSp !== false) readTree(mas.tree, mkEnv(mas.rels, 'm'), { name: 'master', ...lv }, shapes);
    if (lay && showMaster) readTree(lay.tree, mkEnv(lay.rels, 'l'), { name: 'layout', ...lv }, shapes);
    const env = mkEnv(rels, sp);
    readTree(path(root, 'cSld', 'spTree'), env, { name: 'slide', ...lv }, shapes);
    const bg = bgOf(kid(root, 'cSld'), ctx, env.files, theme)
      || (lay && bgOf(lay.cSld, ctx, mkEnv(lay.rels, 'l').files, theme))
      || (mas && bgOf(mas.cSld, ctx, mkEnv(mas.rels, 'm').files, theme))
      || '#' + (theme.scheme[map.bg1 || 'lt1'] || 'FFFFFF');
    // 演讲者备注
    let notes = '';
    const nRel = [...rels.values()].find((r) => r.type === 'notesSlide');
    const nRoot = nRel ? files0.xml(nRel.target) : null;
    if (nRoot) {
      for (const s of deepAll(nRoot, 'sp')) {
        const ph = phOf(path(s, 'nvSpPr', 'nvPr'));
        if (!ph || ph.type !== 'body') continue;
        notes = kids(kid(s, 'txBody'), 'p').map((p) => deepAll(p, 't').map((x) => x.textContent).join('')).join('\n').trim();
      }
    }
    slides.push({ bg, shapes, notes, text: shapes.filter((s) => s.text).map((s) => s.text.paras.map((p) => p.runs.map((r) => r.t || '').join('')).join('\n')).join('\n') });
  }
  return {
    w: W, h: H, slides, urls,
    dispose() { for (const u of urls) { try { URL.revokeObjectURL(u); } catch {} } urls.length = 0; },
  };
}
