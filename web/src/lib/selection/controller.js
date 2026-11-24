// 文本选中的总控：每个接入的文档（主文档、Codex 的 iframe）一份状态，监听选区与鼠标，
// 管墨的生老病死（出现 / 跟手 / 退场）、版面变了重新量、右键开菜单、复制的反馈。
//
// 这里管鼠标；触屏长按是另一套（touch.js：自己的墨、选择柄、放大镜、工具条），两套挂在同一个文档上。
import { Ink } from './engine.js';
import { measure } from './measure.js';
import { findHost, skinOf, backdropOf, themeOf, layerFor, RADIUS } from './host.js';
import { openMenu, closeMenu, menuOpen, menuEl, menuKey } from './menu.js';
import { contextOf, rowsFor } from './items.js';
import { fontOf, menuTheme } from './actions.js';
import { attachTouch } from './touch.js';
import { t } from '../i18n.js';
import inkCss from './ink.css?raw';
import touchCss from './touch.css?raw';
import './ink.css';
import './touch.css';
import './selection.css';

// 不画墨的地方：可编辑区（有自己的光标与选区）、代码编辑器、终端、PDF 文字层、显式关掉的区域
const NO_INK = 'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], .cm-editor, .xterm, .textLayer, [data-sel-ink-off]';
const FINE = () => matchMedia('(any-pointer: fine)').matches;
const REDUCE = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const elOf = (n) => (n && n.nodeType === 3 ? n.parentElement : n);
const docs = new WeakMap();

function stateFor(doc, opts) {
  const D = {
    doc, win: doc.defaultView, skin: opts.skin || '', frame: opts.frame || null,
    inks: new Set(), cur: null, press: 0, lastGone: null, nextMode: null, nextOrigin: null,
    ptr: { down: false, press: 0, x: 0, y: 0, mode: 'drag', type: 'mouse' },
    raf: 0, last: 0, watch: null, remeasureRaf: 0,
  };
  D.api = {
    frameOffset: () => frameOffset(D),
    feedback: (ink, label) => feedback(D, ink, label),
    tempInk: (range) => tempInk(D, range),
    selectAll: (el, origin) => selectAll(D, el, origin),
    curInk: () => (D.cur && !D.cur.exiting ? D.cur : null),
    clear: () => { try { D.win.getSelection().removeAllRanges(); } catch {} },
  };
  return D;
}

function frameOffset(D) {
  if (!D.frame) return { x: 0, y: 0 };
  const r = D.frame.getBoundingClientRect();
  return { x: r.left + D.frame.clientLeft, y: r.top + D.frame.clientTop };
}

// ── 动画循环 ──
function kick(D) {
  if (D.raf) return;
  D.last = performance.now();
  D.raf = D.win.requestAnimationFrame((n) => loop(D, n));
}
function loop(D, now) {
  // 输入事件和 rAF 同帧派发时，帧时间戳会早于 kick 那一刻：时间差夹到 ≥0，否则退场计时会被倒扣、墨永远留在那
  const dt = Math.max(0, Math.min(48, now - D.last));
  D.last = now;
  let act = false;
  for (const ink of D.inks) {
    if (ink.step(dt)) act = true;
    ink.render();
    if (ink.dead) { D.inks.delete(ink); hostMark(D, ink.host); }
  }
  D.raf = act ? D.win.requestAnimationFrame((n) => loop(D, n)) : 0;
}

// 容器里有活着的墨就藏原生选区色，墨都走了就还回去
function hostMark(D, host) {
  if (!host) return;
  let on = false;
  for (const i of D.inks) if (i.host === host && !i.dead) { on = true; break; }
  const el = host === D.doc.scrollingElement || host === D.doc.documentElement ? D.doc.body : host;
  el.classList.toggle('sel-ink-on', on);
}

function dropInk(D) {
  if (!D.cur) return;
  D.cur.exit();
  D.lastGone = { ink: D.cur, t: performance.now() };
  D.cur = null;
  unwatch(D);
  kick(D);
}

function eligible(D, el) {
  if (!el || !FINE() || D.ptr.type === 'touch' || D.ptr.type === 'pen') return false;
  if (el.closest(NO_INK)) return false;
  return D.skin ? true : !!el.closest('.sel-text');
}

function isFwd(sel) {
  if (sel.anchorNode === sel.focusNode) return sel.focusOffset >= sel.anchorOffset;
  return !(sel.anchorNode.compareDocumentPosition(sel.focusNode) & Node.DOCUMENT_POSITION_PRECEDING);
}

function caretPoint(doc, node, off) {
  const r = doc.createRange();
  try { r.setStart(node, off); r.collapse(true); } catch { return null; }
  let rc = r.getClientRects()[0];
  if (!rc && node.nodeType === 3 && off < node.data.length) { r.setEnd(node, off + 1); rc = r.getClientRects()[0]; }
  return rc ? { x: rc.left, y: rc.top + rc.height / 2 } : null;
}

// ── 选区 → 墨 ──
function syncSel(D) {
  const sel = D.win.getSelection();
  if (!sel || !sel.rangeCount || sel.isCollapsed) { dropInk(D); return; }
  const a = elOf(sel.anchorNode), fo = elOf(sel.focusNode);
  if (!eligible(D, a) || !eligible(D, fo)) { dropInk(D); return; }
  const range = sel.getRangeAt(0);
  const host = findHost(elOf(range.commonAncestorContainer));
  const back = backdropOf(host);
  if (!back.ok) { dropInk(D); return; }
  const layer = layerFor(host);
  const skin = skinOf(a, D.skin);
  const theme = themeOf(back.rgb);
  for (const i of D.inks) if (i.host === host && i.svg !== layer) i.svg = layer;
  const ms = measure(range, layer.getBoundingClientRect());
  if (!ms.length) { dropInk(D); return; }
  const fwd = isFwd(sel);
  const c = D.cur;
  const same = c && !c.exiting && c.host === host
    && ((D.ptr.down && c.press === D.ptr.press) || (c.an === sel.anchorNode && c.ao === sel.anchorOffset && !D.nextMode));
  if (same) { c.fwd = fwd; c.set(ms); kick(D); return; }

  const lr = layer.getBoundingClientRect();
  const toC = (p) => (p ? { x: p.x - lr.left, y: p.y - lr.top } : { x: null, y: null });
  let mode, pt;
  if (D.ptr.down) { mode = D.ptr.mode; pt = toC({ x: D.ptr.x, y: D.ptr.y }); }
  else if (D.nextMode) { mode = D.nextMode; pt = toC(D.nextOrigin); }
  else { mode = 'drag'; pt = toC(caretPoint(D.doc, sel.anchorNode, sel.anchorOffset)); }
  D.nextMode = null;
  D.nextOrigin = null;

  // 三击 / 全选在已有的墨上接着漫开：同一行沿用它此刻的样子，不重新长
  let inherit = null;
  if (c && !c.exiting && c.host === host && (mode === 'para' || mode === 'all')) { inherit = c.lines; c.g.remove(); D.inks.delete(c); D.cur = null; }
  else if (!c && (mode === 'para' || mode === 'all') && D.lastGone && !D.lastGone.ink.dead && D.lastGone.ink.host === host && performance.now() - D.lastGone.t < 220) {
    inherit = D.lastGone.ink.lines; D.lastGone.ink.g.remove(); D.inks.delete(D.lastGone.ink);
  } else if (c) c.exit();

  layer.dataset.skin = skin;
  layer.dataset.theme = theme;
  layer.dataset.flat = back.flat ? '1' : '';
  const ink = new Ink(layer, { mode, ox: pt.x, oy: pt.y, fwd, wet: D.ptr.down && mode === 'drag', reduce: REDUCE(), inherit, r: RADIUS[skin] });
  Object.assign(ink, { host, skin, theme, press: D.ptr.down ? D.ptr.press : -1, an: sel.anchorNode, ao: sel.anchorOffset });
  ink.set(ms);
  D.cur = ink;
  D.inks.add(ink);
  // 同一时刻只认一块选区墨：别处没在退场的一律收掉（复制整条时的临时墨除外）
  for (const i of D.inks) if (i !== ink && !i.exiting && !i.temp) i.exit();
  hostMark(D, host);
  watch(D, host);
  kick(D);
}

// ── 版面变了（窗口缩放、流式输出撑开、滚到 content-visibility 跳过的段落）：重新量，直接落位 ──
function remeasure(D) {
  if (D.remeasureRaf) return;
  D.remeasureRaf = D.win.requestAnimationFrame(() => {
    D.remeasureRaf = 0;
    const c = D.cur;
    if (!c || c.exiting) return;
    const sel = D.win.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const layer = layerFor(c.host);
    c.svg = layer;
    if (c.g.parentNode !== layer) layer.append(c.g);
    const ms = measure(sel.getRangeAt(0), layer.getBoundingClientRect());
    if (!ms.length) return;
    c.set(ms);
    c.snap();
    kick(D);
  });
}
function watch(D, host) {
  unwatch(D);
  const ro = new D.win.ResizeObserver(() => remeasure(D));
  ro.observe(host === D.doc.scrollingElement ? D.doc.body : host);
  const mo = new D.win.MutationObserver(() => remeasure(D));
  mo.observe(host === D.doc.scrollingElement ? D.doc.body : host, { childList: true, subtree: true, characterData: true });
  D.watch = { ro, mo };
}
function unwatch(D) {
  if (!D.watch) return;
  D.watch.ro.disconnect();
  D.watch.mo.disconnect();
  D.watch = null;
}

// ── 反馈 ──
function feedback(D, ink, label) {
  if (!ink || ink.dead) return;
  if (!REDUCE()) ink.lift();
  tipAt(D, ink, label);
}

let tipEl = null;
function tipAt(D, ink, text) {
  const h = ink.head();
  if (!h || !ink.svg.parentNode) return;
  if (tipEl) tipEl.remove();
  const el = tipEl = D.doc.createElement('div');
  el.className = 'sel-tip';
  el.dataset.theme = ink.theme;
  el.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 8.5 6.5 11.5 12.5 4.5"/></svg><span></span>';
  el.lastChild.textContent = text;
  ink.svg.parentNode.append(el);
  const w = el.offsetWidth, hh = el.offsetHeight;
  const host = ink.host;
  const maxW = (host === D.doc.scrollingElement ? D.doc.documentElement.clientWidth : host.clientWidth) - 6;
  // 跟在选区末端右边、和这一行居中；行尾放不下才挪到末端上方
  let x = h.x + 8, y = (h.y1 + h.y2) / 2 - hh / 2;
  if (x + w > maxW) { x = Math.max(6, Math.min(maxW - w, h.x - w)); y = h.y1 - hh - 2; }
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  if (REDUCE()) el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 80, fill: 'both' });
  else el.animate([{ opacity: 0, transform: 'translateY(4px) scale(.96)' }, { opacity: 1, transform: 'none' }], { duration: 180, delay: 60, easing: 'cubic-bezier(.165,.84,.44,1)', fill: 'both' });
  setTimeout(() => {
    el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 160, easing: 'cubic-bezier(.5,0,.85,.45)', fill: 'both' }).finished.then(() => el.remove(), () => el.remove());
    if (tipEl === el) tipEl = null;
  }, 1300);
}

// 复制整条回复：先把整条漫一遍墨（让人看见复制了哪些），浮起拓印后退场
function tempInk(D, range) {
  const host = findHost(elOf(range.commonAncestorContainer));
  const back = backdropOf(host);
  if (!back.ok || !FINE()) return null;
  const layer = layerFor(host);
  const skin = skinOf(elOf(range.commonAncestorContainer), D.skin);
  layer.dataset.skin = skin;
  layer.dataset.theme = themeOf(back.rgb);
  layer.dataset.flat = back.flat ? '1' : '';
  const ink = new Ink(layer, { mode: 'all', ox: null, oy: null, reduce: REDUCE(), r: RADIUS[skin] });
  Object.assign(ink, { host, skin, theme: layer.dataset.theme, temp: true });
  ink.set(measure(range, layer.getBoundingClientRect()));
  D.inks.add(ink);
  hostMark(D, host);
  kick(D);
  setTimeout(() => { ink.exit(); kick(D); }, 900);
  return ink;
}

function selectAll(D, el, origin) {
  D.nextMode = 'all';
  D.nextOrigin = origin || null;
  const r = D.doc.createRange();
  r.selectNodeContents(el);
  const s = D.win.getSelection();
  s.removeAllRanges();
  s.addRange(r);
}

// ── 右键 ──
function onContextMenu(D, e) {
  if (e.defaultPrevented) return;
  // 触屏长按留给系统（选择柄 + 系统菜单）
  if (D.ptr.type === 'touch' || D.ptr.type === 'pen' || e.sourceCapabilities?.firesTouchEvents) return;
  const target = e.target instanceof D.win.Element ? e.target : null;
  if (!target) return;
  const ctx = contextOf(D, target, e.clientX, e.clientY);
  if (!ctx) return;
  e.preventDefault();
  const off = frameOffset(D);
  show(D, ctx, e.clientX + off.x, e.clientY + off.y, false);
}

function show(D, ctx, x, y, kb) {
  const rows = rowsFor(D, ctx);
  const ink = ctx.kind === 'sel' ? D.api.curInk() : null;
  openMenu({
    x, y, rows, kb,
    skin: ctx.skin,
    theme: ink ? ink.theme : menuTheme(ctx.el),
    font: fontOf(ctx.el, ctx.skin),
    onClose: () => { if (ink) { ink.edgeT = 0; kick(D); } },
  });
  // 菜单开着时选区描一圈细边：这份菜单作用在这几行字上
  if (ink && menuOpen()) { ink.edgeT = 1; kick(D); }
}

function onKey(D, e) {
  if (menuOpen()) {
    if (menuKey(e)) { e.preventDefault(); e.stopPropagation(); }
    return;
  }
  // 键盘唤出菜单：Shift+F10 / 菜单键，落在选区末端
  if ((e.key === 'F10' && e.shiftKey) || e.key === 'ContextMenu') {
    const ink = D.api.curInk();
    if (!ink) return;
    const ctx = contextOf(D, elOf(D.win.getSelection().anchorNode), null, null, true);
    if (!ctx) return;
    e.preventDefault();
    const h = ink.head(), lr = ink.svg.getBoundingClientRect(), off = frameOffset(D);
    show(D, ctx, lr.left + h.x + off.x, lr.top + h.y2 + off.y, true);
    D.kbMenuAt = performance.now();
    return;
  }
  // Ctrl+C 照常走浏览器的复制，只在屏幕上补一个反馈
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'c') {
    const ink = D.api.curInk();
    const sel = D.win.getSelection();
    if (!ink || !sel || sel.isCollapsed) return;
    const n = sel.toString().replace(/\s+/g, '').length;
    setTimeout(() => feedback(D, ink, t('已复制 · {n} 字', { n })));
  }
}

function attach(doc, opts) {
  if (docs.has(doc)) return docs.get(doc);
  const D = stateFor(doc, opts);
  docs.set(doc, D);
  const win = D.win;
  // 触屏那套先挂：它要在右键（长按）事件上抢在这边和桌面壳菜单之前
  attachTouch(doc, opts);
  doc.addEventListener('selectionchange', () => syncSel(D));
  doc.addEventListener('pointerdown', (e) => {
    D.ptr.type = e.pointerType || 'mouse';
    const m = menuEl();
    if (m && !(doc === document && m.contains(e.target))) closeMenu();
  }, true);
  doc.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    D.ptr = { down: true, press: ++D.press, x: e.clientX, y: e.clientY, mode: e.detail >= 3 ? 'para' : e.detail === 2 ? 'word' : 'drag', type: D.ptr.type };
  }, true);
  win.addEventListener('mouseup', (e) => {
    if (e.button !== 0 || !D.ptr.down) return;
    D.ptr.down = false;
    if (D.cur && !D.cur.exiting) { D.cur.wet = false; kick(D); }
  }, true);
  // 拖动已选中的文字会进入拖放、不会再有 mouseup
  doc.addEventListener('dragend', () => { D.ptr.down = false; }, true);
  doc.addEventListener('contextmenu', (e) => {
    if (D.kbMenuAt && performance.now() - D.kbMenuAt < 400) { e.preventDefault(); return; }
    onContextMenu(D, e);
  });
  doc.addEventListener('keydown', (e) => onKey(D, e), true);
  doc.addEventListener('scroll', () => { if (menuOpen()) closeMenu(true); if (D.cur) remeasure(D); }, true);
  win.addEventListener('resize', () => { closeMenu(true); if (D.cur) remeasure(D); });
  win.addEventListener('blur', () => { if (doc === document) closeMenu(true); });
  return D;
}

export function initSelection() {
  attach(document, {});
}

// 菜单开在主文档上、字体却是 iframe 里那页的（Codex = OpenAI Sans）：把那几条 @font-face 抄过来，地址换成绝对的
function adoptFonts(doc) {
  const fams = (doc.defaultView.getComputedStyle(doc.body).fontFamily || '').split(',').map((s) => s.trim().replace(/^["']|["']$/g, ''));
  const out = [];
  for (const sheet of doc.styleSheets) {
    let rules;
    try { rules = sheet.cssRules; } catch { continue; }
    for (const r of rules) {
      if (r.type !== CSSRule.FONT_FACE_RULE) continue;
      const fam = (r.style.getPropertyValue('font-family') || '').trim().replace(/^["']|["']$/g, '');
      if (!fams.includes(fam)) continue;
      const base = sheet.href || doc.baseURI;
      out.push(r.cssText.replace(/url\((["']?)([^"')]+)\1\)/g, (m, q, u) => { try { return `url("${new URL(u, base).href}")`; } catch { return m; } }));
    }
  }
  if (!out.length) return;
  const st = document.createElement('style');
  st.dataset.bridgeSelectionFonts = '1';
  st.textContent = out.join('\n');
  document.head.append(st);
}

// 另一个同源文档（Codex 的 iframe）：注入墨的样式、同一套监听；菜单仍开在主文档上
export function attachSelectionDoc(doc, { skin, frame } = {}) {
  if (!doc || docs.has(doc)) return;
  const st = doc.createElement('style');
  st.dataset.bridgeSelection = '1';
  st.textContent = inkCss + touchCss;
  (doc.head || doc.documentElement).append(st);
  attach(doc, { skin, frame });
  if (!document.querySelector('style[data-bridge-selection-fonts]')) try { adoptFonts(doc); } catch {}
}
