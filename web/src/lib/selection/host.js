// 墨画在哪、什么皮肤、能不能画。
//
// 墨层是选区所在的竖向滚动容器里的一层 SVG：随内容一起滚、被容器裁掉、被浮在上面的输入栏自然盖住。
// 墨用混合模式叠在字上（暗色滤色、亮色正片叠底，字色不变）。混合只跟同一层叠上下文里已经画出来的东西混：
//   · 从容器往上、到最近的层叠上下文为止有一层实底 → 画「叠之前」的墨，叠出来正好是设计色；
//   · 中间隔着一层底色透明的层叠上下文 → 空白处等于跟透明混、出来就是墨本身，改画「叠好的」颜色（flat）；
//   · 祖先里有磨砂玻璃（backdrop-filter）或背景图 → 不画：混合层会让玻璃采不到底而发黑，退回各页的静态选区色。
const NS = 'http://www.w3.org/2000/svg';

const SKIN_ROOTS = [['.cc-tone', 'claude'], ['.agy-root', 'agy'], ['.hxroot', 'dimensio']];
// 各分页「一整条回复」的容器：右键空白回复时整条复制 / 引用 / 全选
export const ANSWER = { claude: '.answer', agy: '.agy-md', dimensio: '.md', codex: '.markdown', bridge: '' };
// 墨的圆角跟各页的圆角刻度走：ChatGPT 更圆、dimensio 纸上的笔画更利落
export const RADIUS = { claude: 6, codex: 8, agy: 6, dimensio: 5, bridge: 7 };

export function skinOf(el, docSkin) {
  if (docSkin) return docSkin;
  for (const [sel, s] of SKIN_ROOTS) if (el.closest(sel)) return s;
  return 'bridge';
}

export function pageRootOf(el, skin) {
  const sel = SKIN_ROOTS.find(([, s]) => s === skin)?.[0];
  return (sel && el.closest(sel)) || el.ownerDocument.body;
}

export function findHost(el) {
  const doc = el.ownerDocument, view = doc.defaultView;
  for (let e = el; e && e !== doc.body && e !== doc.documentElement; e = e.parentElement) {
    if (/(auto|scroll|overlay)/.test(view.getComputedStyle(e).overflowY)) return e;
  }
  return doc.scrollingElement || doc.documentElement;
}

export function parseColor(s) {
  if (!s) return null;
  let m = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/);
  if (!m) m = s.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+%?))?\s*\)$/);
  if (!m) return null;
  const srgb = s.startsWith('color(');
  const ch = (v) => (srgb ? parseFloat(v) * 255 : parseFloat(v));
  const a = m[4] == null ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return [ch(m[1]), ch(m[2]), ch(m[3]), a];
}

function stacking(e, cs) {
  if (cs.position === 'fixed' || cs.position === 'sticky') return true;
  if (cs.zIndex !== 'auto') {
    if (cs.position !== 'static') return true;
    const pd = e.parentElement && e.ownerDocument.defaultView.getComputedStyle(e.parentElement).display;
    if (pd && /flex|grid/.test(pd)) return true;
  }
  if (parseFloat(cs.opacity) < 1) return true;
  const none = (v) => !v || v === 'none';
  if (!none(cs.transform) || !none(cs.translate) || !none(cs.rotate) || !none(cs.scale)) return true;
  if (!none(cs.filter) || !none(cs.backdropFilter) || !none(cs.webkitBackdropFilter) || !none(cs.perspective)) return true;
  if (!none(cs.clipPath) || !none(cs.maskImage) || !none(cs.webkitMaskImage)) return true;
  if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') return true;
  if (cs.isolation === 'isolate') return true;
  if (/paint|layout|strict|content/.test(cs.contain || '')) return true;
  if (cs.containerType && cs.containerType !== 'normal') return true;
  if (cs.contentVisibility === 'auto') return true;
  if (/transform|opacity|filter|perspective|clip-path|mask|isolation|mix-blend-mode|contents/.test(cs.willChange || '')) return true;
  return false;
}

// 从容器往上找实底：返回 { ok, rgb, flat }。ok=false 不画墨；flat=true 画叠好的颜色（见文件头）。
export function backdropOf(host) {
  const doc = host.ownerDocument, view = doc.defaultView;
  const start = host === doc.scrollingElement || host === doc.documentElement ? doc.body : host;
  let flat = false;
  for (let e = start; e; e = e.parentElement) {
    const cs = view.getComputedStyle(e);
    const c = parseColor(cs.backgroundColor);
    if (c && c[3] >= 0.99) return { ok: true, rgb: c, flat };
    if (e === doc.documentElement) break;
    if (cs.backgroundImage && cs.backgroundImage !== 'none') return { ok: false };
    const bf = cs.backdropFilter || cs.webkitBackdropFilter;
    if (bf && bf !== 'none') return { ok: false };
    if (stacking(e, cs)) flat = true;
  }
  return { ok: true, rgb: [255, 255, 255, 1], flat };   // 画布默认白
}

// 不需要画墨时（菜单）只要知道底是深是浅：往上找第一层不透明底
export function bgOf(el) {
  const view = el.ownerDocument.defaultView;
  for (let e = el; e; e = e.parentElement) {
    const c = parseColor(view.getComputedStyle(e).backgroundColor);
    if (c && c[3] >= 0.6) return c;
  }
  return [255, 255, 255, 1];
}

export const themeOf = (rgb) => ((0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255 < 0.5 ? 'dark' : 'light');

// 每个容器一层，挂在末尾（不设 z-index：在容器自己的层叠顺序里排在正文之后，粘性表头之类照样压在墨上）。
// 容器是 static 的话改成 relative，墨层才以它为坐标原点、跟着它滚动和裁切。
// Svelte 清空列表时可能把整个容器的子节点一并清掉：用前看 isConnected，断了就新建一层，把还活着的墨搬过去。
const layers = new WeakMap();
export function layerFor(host) {
  const doc = host.ownerDocument;
  const parent = host === doc.scrollingElement || host === doc.documentElement ? doc.body : host;
  const old = layers.get(host);
  if (old && old.isConnected && old.parentNode === parent) return old;
  if (parent !== doc.body && doc.defaultView.getComputedStyle(parent).position === 'static') parent.style.position = 'relative';
  const svg = doc.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'sel-ink-layer');
  svg.setAttribute('aria-hidden', 'true');
  if (old) while (old.firstChild) svg.append(old.firstChild);
  parent.append(svg);
  layers.set(host, svg);
  return svg;
}
