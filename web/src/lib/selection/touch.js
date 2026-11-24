// 触屏长按选中：在正文区（.sel-text；Codex 的 iframe 里是消息节点）整套接管系统的长按选字，换成和电脑端同一种墨，
// 外加一对自绘选择柄、拖动时的放大镜、松手后的横排工具条。系统的选择柄和浮条网页改不了样子，所以选区不进浏览器，
// 用一对文本位置自己记（words.js）。输入框、代码编辑器、终端、文档阅读器（有自己调过的长段护栏）照旧用系统的。
//
// 不接管的情况：iOS（没有真机验过，系统选择照旧）；设置里打开了「使用系统的文字选择」；安卓读屏（TalkBack）开着。
//
// 手势：长按 130ms 起淡墨从指下按词渗开（蓄力），420ms 落定、轻震；落定后不松手接着拖按词扩；松手出柄和工具条。
// 拖柄按字走，拖过另一头换手，贴近滚动区上下边自动滚。点选区本身收起 / 叫回工具条，点别处取消。
//
// 滚动：落定后再动的手指不许变成页面滚动，要在 touchmove 上拦。Chrome 在 touchstart 那一刻就按「这片区域有没有
// 阻塞型 touchmove 监听」决定滚动交不交给合成器，现挂来不及——所以对话的滚动容器常驻挂一个守卫（touchGuard），
// 平时直接放行；别的正文区第一次被摸到时补挂，从下一次手势起生效。
import { Ink } from './engine.js';
import { measure } from './measure.js';
import { findHost, skinOf, backdropOf, themeOf, bgOf, layerFor, RADIUS } from './host.js';
import { caretAt, wordAt, elRange, cmp, mkRange, alive } from './words.js';
import { createHandles, mountHandles, handleOf, grab, showHandles, hideHandles, stepHandles } from './handles.js';
import { createLoupe, showLoupe, hideLoupe, stepLoupe } from './loupe.js';
import { showBar, hideBar, confirmBar, barContains, barOn } from './touchbar.js';
import { rangeToMd } from './markdown.js';
import * as A from './actions.js';
import { t } from '../i18n.js';

const NO_TOUCH = 'input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"], .cm-editor, .xterm, .textLayer, [data-sel-ink-off], [data-ts-root]';
// 这几个数要上真机（含折叠屏内外屏）再调一轮
const CHARGE_MS = 130, LONG_MS = 420, SLOP = 8, EDGE = 64, AUTO_MAX = 900;
const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const URL_RE = /https?:\/\/[^\s<>"'）)】]+/;
const REDUCE = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const elOf = (n) => (n && n.nodeType === 3 ? n.parentElement : n);
let active = null;   // 有触屏选区的那个文档（全局只有一处选区）

let a11yAt = -1e9, a11yVal = false;
function a11yOn() {
  const now = performance.now();
  if (now - a11yAt > 3000) { a11yAt = now; try { a11yVal = !!window.AndroidStore?.touchExploration?.(); } catch { a11yVal = false; } }
  return a11yVal;
}
// 设置 › 通用「使用系统的文字选择」存在本机偏好 bridge-prefs（lib/state.svelte.js），这里直接读，不拉整个状态模块
export function takeoverOn() {
  if (IOS) return false;
  try { if (JSON.parse(localStorage.getItem('bridge-prefs') || 'null')?.sysSelect) return false; } catch {}
  return !a11yOn();
}

function haptic(kind) {
  try { if (window.AndroidStore?.haptic) { window.AndroidStore.haptic(kind); return; } } catch {}
  try { navigator.vibrate?.(kind === 'tick' ? 6 : 10); } catch {}
}

// ── 滚动守卫 ──
const guarded = new WeakSet();
const busy = () => !!(active && (active.phase === 'extend' || active.drag));
function guard(e) { if (busy() && e.cancelable) e.preventDefault(); }
export function ensureGuard(node) {
  if (!node || guarded.has(node)) return;
  guarded.add(node);
  node.addEventListener('touchmove', guard, { passive: false });
}
// Svelte action：<div class="scroll" use:touchGuard>
export function touchGuard(node) {
  ensureGuard(node);
  return { destroy() { node.removeEventListener('touchmove', guard); guarded.delete(node); } };
}

// ── 状态 ──
function stateFor(doc, opts) {
  const T = {
    doc, win: doc.defaultView, skin: opts.skin || '', frame: opts.frame || null,
    inks: new Set(), ink: null, s: null, e: null, w0: null, side: 'e',
    host: null, layer: null, zskin: 'bridge', theme: 'dark', bg: '#000',
    phase: 'idle', press: null, drag: null, finger: null, auto: 0, autoAcc: 0,
    H: createHandles(doc), L: createLoupe(doc), raf: 0, last: 0, watch: null, remeasureRaf: 0, check: 0, scrollT: 0, gen: 0,
    touchAt: -1e9, zoneTouch: false, anchorKey: '',
  };
  // actions.js 的 quote() 要的接口
  T.api = { frameOffset: () => frameOffset(T), clear: () => clear(T) };
  return T;
}
function frameOffset(T) {
  if (!T.frame) return { x: 0, y: 0 };
  const r = T.frame.getBoundingClientRect();
  return { x: r.left + T.frame.clientLeft, y: r.top + T.frame.clientTop };
}
function zoneOf(T, el) {
  if (!el || !el.closest || el.closest(NO_TOUCH)) return null;
  return T.skin === 'codex' ? el.closest('[data-message-author-role]') : el.closest('.sel-text');
}
const inHost = (T, pt) => !!(pt && zoneOf(T, pt.n.parentElement) && findHost(pt.n.parentElement) === T.host);

function hostRect(T) {
  const h = T.host, d = T.doc;
  if (!h || h === d.scrollingElement || h === d.documentElement || h === d.body) return { left: 0, top: 0, right: T.win.innerWidth, bottom: T.win.innerHeight };
  const r = h.getBoundingClientRect();
  // 浮在滚动区下沿的输入栏：滚动容器把它算进了下内边距（Claude 页 .scroll），可见区扣掉
  const pb = Math.min(parseFloat(T.win.getComputedStyle(h).paddingBottom) || 0, 200);
  return { left: r.left, top: Math.max(0, r.top), right: r.right, bottom: Math.min(r.bottom, T.win.innerHeight) - pb };
}
function visOf(T) {
  const lr = T.layer.getBoundingClientRect(), hr = hostRect(T);
  return { l: hr.left - lr.left, r: hr.right - lr.left, t: hr.top - lr.top, b: hr.bottom - lr.top };
}

// 墨画在哪、什么颜色：背后有实底 → 混合（暗滤色、亮正片叠底）；隔着透明隔离层 → 叠好的颜色；磨砂玻璃 / 背景图 → 半透明强调色
function zoneCtx(T, el) {
  const host = findHost(el);
  const back = backdropOf(host);
  const layer = layerFor(host);
  const skin = skinOf(el, T.skin);
  const rgb = back.ok ? back.rgb : bgOf(el);
  layer.dataset.skin = skin;
  layer.dataset.theme = themeOf(rgb);
  layer.dataset.flat = !back.ok ? 'glass' : back.flat ? '1' : '';
  ensureGuard(host);
  return { host, layer, skin, theme: themeOf(rgb), bg: `rgb(${Math.round(rgb[0])},${Math.round(rgb[1])},${Math.round(rgb[2])})` };
}
function newInk(T, layer, skin, mode, o = {}) {
  const ink = new Ink(layer, { mode, reduce: REDUCE(), r: RADIUS[skin], ...o });
  T.inks.add(ink);
  return ink;
}

// ── 动画循环 ──
function kick(T) {
  if (T.raf) return;
  T.last = performance.now();
  T.raf = T.win.requestAnimationFrame((n) => loop(T, n));
}
function loop(T, now) {
  // 输入事件与 rAF 同帧时帧时间戳早于 kick：时间差夹到 ≥0（电脑端踩过的坑）
  const dt = Math.max(0, Math.min(48, now - T.last));
  T.last = now;
  const reduce = REDUCE();
  let act = false;
  for (const ink of T.inks) { if (ink.step(dt)) act = true; ink.render(); if (ink.dead) T.inks.delete(ink); }
  if (stepHandles(T.H, T.ink, dt, reduce)) act = true;
  if (T.L.on && T.ink && T.layer) {
    const ed = T.ink.edges(), which = T.drag ? T.drag.which : T.side;
    if (ed) {
      const pos = which === 's' ? T.s : T.e;
      const root = pos && alive(pos) ? zoneOf(T, pos.n.parentElement) || pos.n.parentElement : null;
      stepLoupe(T.L, { edge: ed[which], finger: T.finger, root, layer: T.layer, inks: T.inks, dt, reduce, vis: visOf(T) });
    }
    act = true;
  }
  if (stepAuto(T, dt)) act = true;
  T.raf = act ? T.win.requestAnimationFrame((n) => loop(T, n)) : 0;
}

// ── 版面变了（流式输出撑开、窗口转屏、内容被换掉）：重新量，直接落位 ──
function remeasure(T) {
  if (T.remeasureRaf) return;
  T.remeasureRaf = T.win.requestAnimationFrame(() => {
    T.remeasureRaf = 0;
    if (!T.s || !T.ink) return;
    if (!alive(T.s) || !alive(T.e) || !T.host.isConnected) { clear(T); return; }
    const layer = layerFor(T.host);
    if (layer !== T.layer) { T.layer = layer; for (const i of T.inks) i.svg = layer; }
    mountHandles(T.H, layer.parentNode, T.zskin, T.theme);
    const ms = measure(mkRange(T.s, T.e), layer.getBoundingClientRect());
    if (!ms.length) { clear(T); return; }
    T.ink.set(ms);
    T.ink.snap();
    kick(T);
    if (T.phase === 'sel' && barOn()) placeBar(T, false);
  });
}
function watch(T) {
  unwatch(T);
  const target = T.host === T.doc.scrollingElement ? T.doc.body : T.host;
  const ro = new T.win.ResizeObserver(() => remeasure(T));
  ro.observe(target);
  const mo = new T.win.MutationObserver(() => remeasure(T));
  mo.observe(target, { childList: true, subtree: true, characterData: true });
  T.watch = { ro, mo };
  // 换分页、关掉面板时容器只是被藏起来：隔一会儿看一眼，看不见了就收掉（不然工具条还浮在别的页面上）
  clearInterval(T.check);
  T.check = setInterval(() => {
    if (!T.s) return;
    if (!T.host.isConnected || !T.host.getClientRects().length || !alive(T.s) || !alive(T.e) || T.doc.visibilityState === 'hidden') clear(T);
  }, 600);
}
function unwatch(T) {
  if (T.watch) { T.watch.ro.disconnect(); T.watch.mo.disconnect(); T.watch = null; }
  clearInterval(T.check);
  T.check = 0;
}

// ── 选区的几个动作 ──
function updateInk(T) {
  const ms = measure(mkRange(T.s, T.e), T.layer.getBoundingClientRect());
  if (!T.ink || T.ink.exiting) T.ink = newInk(T, T.layer, T.zskin, 'drag', { ox: null, oy: null });
  T.ink.set(ms);
  kick(T);
}

function clear(T) {
  T.gen++;
  if (T.press) cancelPress(T);
  if (T.ink) { T.ink.exit(); T.ink = null; }
  const reduce = REDUCE();
  hideHandles(T.H, reduce);
  hideLoupe(T.L, reduce);
  grab(T.H, '', false);
  if (active === T) { hideBar(); active = null; }
  T.s = T.e = T.w0 = null;
  T.phase = 'idle';
  T.drag = null;
  T.auto = 0;
  clearTimeout(T.scrollT);
  unwatch(T);
  kick(T);
}

function startCharge(T) {
  const p = T.press;
  if (!p || !p.word || REDUCE()) return;
  const el = p.word.s.n.parentElement;
  const z = zoneCtx(T, el);
  const lr = z.layer.getBoundingClientRect();
  p.charge = newInk(T, z.layer, z.skin, 'charge', { ox: p.x - lr.left, oy: p.y - lr.top, alphaT: 0.32 });
  p.charge.set(measure(mkRange(p.word.s, p.word.e), lr));
  kick(T);
}

function cancelPress(T) {
  const p = T.press;
  if (!p) return;
  clearTimeout(p.t1);
  clearTimeout(p.t2);
  if (p.charge) { p.charge.exit(); kick(T); }
  T.press = null;
}

// 落定：墨沉到足色并带一点回弹（换成双击那支欠阻尼弹簧），轻震一下，柄长出来
function commit(T) {
  const p = T.press;
  if (!p || !p.word || !alive(p.word.s) || !alive(p.word.e)) return;
  clearTimeout(p.t1);
  if (active && active !== T) clear(active);
  if (T.s) hideHandles(T.H, true);
  if (T.ink && T.ink !== p.charge) T.ink.exit();
  T.anchorKey = '';
  hideBar();
  hideLoupe(T.L, true);
  T.s = p.word.s; T.e = p.word.e; T.w0 = p.word; T.side = 'e';
  const z = zoneCtx(T, T.s.n.parentElement);
  Object.assign(T, { host: z.host, layer: z.layer, zskin: z.skin, theme: z.theme, bg: z.bg });
  mountHandles(T.H, z.layer.parentNode, z.skin, z.theme);
  const lr = z.layer.getBoundingClientRect();
  if (p.charge && p.charge.svg === z.layer && !p.charge.exiting) { T.ink = p.charge; T.ink.mode = 'word'; T.ink.alphaT = null; }
  else {
    if (p.charge) p.charge.exit();
    T.ink = newInk(T, z.layer, z.skin, 'word', { ox: p.x - lr.left, oy: p.y - lr.top });
    T.ink.set(measure(mkRange(T.s, T.e), lr));
  }
  p.charge = null;
  T.phase = 'extend';
  active = T;
  haptic('click');
  const g = T.gen;
  setTimeout(() => { if (T.gen === g && T.s) { showHandles(T.H, REDUCE()); kick(T); } }, 40);
  watch(T);
  kick(T);
}

// 落定后不松手接着拖：按词往外扩（落点就是指头，粒度粗，盖住也无妨）；跨过一个词轻点一下
function extendTo(T, x, y) {
  const pt = caretAt(T.doc, x, y);
  if (!inHost(T, pt)) return;
  const w = wordAt(T.doc, pt, x) || { s: pt, e: pt }, w0 = T.w0;
  let s, e, side;
  if (cmp(w.s, w0.s) >= 0) { s = w0.s; e = cmp(w.e, w0.e) > 0 ? w.e : w0.e; side = 'e'; }
  else { s = w.s; e = w0.e; side = 's'; }
  if (cmp(s, T.s) === 0 && cmp(e, T.e) === 0) return;
  T.s = s; T.e = e; T.side = side;
  haptic('tick');
  if (cmp(s, w0.s) !== 0 || cmp(e, w0.e) !== 0) showLoupe(T.L, T.layer.parentNode, T.layer, T.bg, REDUCE());
  else hideLoupe(T.L, REDUCE());
  updateInk(T);
}

function startDrag(T, which, x, y, id) {
  const h = T.H[which], lr = T.layer.getBoundingClientRect();
  // 按下那一刻记住手指和杆的相对位置，之后按这个偏差算落点，不会一按就跳
  T.drag = { which, id, dx: lr.left + h.x - x, dy: lr.top + h.y + h.h / 2 - y };
  T.phase = 'drag';
  T.autoAcc = 0;
  grab(T.H, which, true);
  hideBar(true);
  showLoupe(T.L, T.layer.parentNode, T.layer, T.bg, REDUCE());
  kick(T);
}

// 拖柄：按字走；拖过另一头就换手；贴近滚动区上下边自动滚，越靠边越快
function dragTo(T, x, y) {
  const d = T.drag;
  if (!d) return;
  const hr = hostRect(T), top = hr.top + EDGE, bot = hr.bottom - EDGE;
  T.auto = y < top ? -AUTO_MAX * Math.min(1, (top - y) / EDGE) : y > bot ? AUTO_MAX * Math.min(1, (y - bot) / EDGE) : 0;
  const pt = caretAt(T.doc, x + d.dx, y + d.dy);
  if (!inHost(T, pt)) return;
  const fixed = d.which === 'e' ? T.s : T.e, c = cmp(pt, fixed);
  if (c === 0) return;
  let s = T.s, e = T.e;
  if (d.which === 'e') { if (c > 0) e = pt; else { s = pt; e = fixed; swapHand(T, 's'); } }
  else { if (c < 0) s = pt; else { s = fixed; e = pt; swapHand(T, 'e'); } }
  if (cmp(s, T.s) === 0 && cmp(e, T.e) === 0) return;
  T.s = s; T.e = e;
  updateInk(T);
}
function swapHand(T, to) {
  if (T.drag.which === to) return;
  T.drag.which = to;
  T.side = to;
  grab(T.H, to, true);
}
function stepAuto(T, dt) {
  if (!T.drag || !T.auto) return false;
  const sc = T.host === T.doc.body || T.host === T.doc.documentElement ? T.doc.scrollingElement : T.host;
  T.autoAcc += (T.auto * dt) / 1000;
  const step = Math.trunc(T.autoAcc);
  if (step) {
    const before = sc.scrollTop;
    sc.scrollTop += step;
    T.autoAcc -= step;
    if (sc.scrollTop !== before && T.finger) dragTo(T, T.finger.x, T.finger.y);
  }
  return true;
}
function endDrag(T) {
  grab(T.H, '', false);
  T.drag = null;
  T.auto = 0;
  T.phase = 'sel';
  hideLoupe(T.L, REDUCE());
  placeBar(T, true);
}

// ── 工具条 ──
function placeBar(T, force) {
  if (!T.ink || !T.s) return;
  const bb = T.ink.bbox();
  if (!bb) return;
  const lr = T.layer.getBoundingClientRect(), off = frameOffset(T), hr = hostRect(T);
  const anchor = {
    l: lr.left + bb.l + off.x, r: lr.left + bb.r + off.x, t: lr.top + bb.t + off.y, b: lr.top + bb.b + off.y,
    vis: { l: hr.left + off.x, r: hr.right + off.x, t: hr.top + off.y, b: hr.bottom + off.y },
  };
  if (anchor.b < anchor.vis.t || anchor.t > anchor.vis.b) { hideBar(true); return; }   // 选区滚出可见区：先让开
  const key = [anchor.l, anchor.r, anchor.t, anchor.b].map(Math.round).join(',');
  if (!force && key === T.anchorKey && barOn()) return;
  T.anchorKey = key;
  showBar({ items: itemsFor(T), anchor, skin: T.zskin, theme: T.theme, font: A.fontOf(T.s.n.parentElement, T.zskin) });
}

// 选区里的字：跳过按钮之类不可选的；跨块时补换行
function textOf(r) {
  const anc = r.commonAncestorContainer;
  if (anc.nodeType === 3) return r.toString();
  const doc = anc.ownerDocument, view = doc.defaultView;
  const tw = doc.createTreeWalker(anc, NodeFilter.SHOW_TEXT);
  let n, out = '', lastBlock = null;
  while ((n = tw.nextNode())) {
    if (!n.parentElement || !r.intersectsNode(n)) continue;
    const cs = view.getComputedStyle(n.parentElement);
    if ((cs.userSelect || cs.webkitUserSelect) === 'none') continue;
    const s = n === r.startContainer ? r.startOffset : 0, e = n === r.endContainer ? r.endOffset : n.data.length;
    let blk = n.parentElement;
    while (blk && view.getComputedStyle(blk).display.startsWith('inline')) blk = blk.parentElement;
    if (lastBlock && blk !== lastBlock && out && !out.endsWith('\n')) out += '\n';
    out += n.data.slice(s, e);
    lastBlock = blk;
  }
  return out;
}

const canShare = () => !!(window.AndroidStore?.shareText || navigator.share);
function share(text) {
  try { if (window.AndroidStore?.shareText) { window.AndroidStore.shareText(text); return; } } catch {}
  navigator.share?.({ text }).catch(() => {});
}

// 复制之后：拓印浮起，胶囊收成一句确认，一秒后选区退场
function confirmed(T, label) {
  if (!REDUCE() && T.ink) T.ink.lift();
  confirmBar(label);
  const g = T.gen;
  setTimeout(() => { if (T.gen === g) clear(T); }, 1000);
}

function selectAll(T) {
  const z = zoneOf(T, T.s.n.parentElement), r = z && elRange(z);
  if (!r) return;
  const old = T.ink, obb = old && old.bbox();
  T.s = r.s; T.e = r.e; T.w0 = { s: r.s, e: r.e };
  // 在已有的那块墨上逐行漫开：同一行沿用它此刻的样子
  const ink = newInk(T, T.layer, T.zskin, 'all', { ox: null, oy: obb ? (obb.t + obb.b) / 2 : null, inherit: old ? old.lines : null });
  if (old) { old.g.remove(); T.inks.delete(old); }
  T.ink = ink;
  ink.set(measure(mkRange(T.s, T.e), T.layer.getBoundingClientRect()));
  kick(T);
  placeBar(T, true);
}

function itemsFor(T) {
  const r = mkRange(T.s, T.e), text = textOf(r), el = T.s.n.parentElement, skin = T.zskin;
  const ctx = { el, skin, range: r, text };
  const out = [];
  const frag = r.cloneContents();
  const a = (frag.querySelector && frag.querySelector('a[href]')) || el.closest('a[href]');
  const href = a && /^https?:/i.test(a.getAttribute('href') || '') ? new URL(a.getAttribute('href'), el.baseURI).href : (text.match(URL_RE) || [])[0];
  const path = text.trim().replace(/^`|`$/g, '');
  const pre = el.closest('pre');
  if (href) out.push({ label: t('打开链接'), act: () => { A.openLink(href); clear(T); } });
  else if (A.canOpenPath(skin) && A.PATH_RE.test(path)) out.push({ label: t('在工作区打开'), act: () => { A.openPath(skin, path); clear(T); } });
  else if (pre && pre.contains(T.e.n)) out.push({ label: t('复制代码'), act: () => { A.writeText(A.codeText(pre)); confirmed(T, t('已复制代码')); } });
  out.push({ label: t('复制'), act: () => { A.writeText(text); confirmed(T, t('已复制 · {n} 字', { n: A.charCount(text) })); } });
  if (A.composerFor(T, el, skin)) out.push({ label: t('引用'), act: () => A.quote(T, ctx, text) });
  const z = zoneOf(T, el), whole = z && elRange(z);
  if (whole && !(cmp(T.s, whole.s) <= 0 && cmp(T.e, whole.e) >= 0)) out.push({ label: t('全选'), act: () => selectAll(T) });
  out.push({ label: t('搜索'), act: () => { A.search(T, text); clear(T); } });
  out.push({ label: t('复制为 Markdown'), act: () => { A.writeText(rangeToMd(r)); confirmed(T, t('已复制 Markdown')); } });
  if (canShare()) out.push({ label: t('分享'), act: () => { share(text); clear(T); } });
  return out;
}

// ── 事件 ──
const touchOf = (list, id) => { for (const tc of list || []) if (tc.identifier === id) return tc; return null; };
function onSelection(T, x, y) {
  if (!T.ink || !T.layer) return false;
  const lr = T.layer.getBoundingClientRect();
  return T.ink.contains(x - lr.left, y - lr.top);
}

function onStart(T, e) {
  if (barContains(e.target)) return;
  if (e.touches.length > 1) { cancelPress(T); if (T.drag) endDrag(T); return; }
  const tc = e.changedTouches[0], x = tc.clientX, y = tc.clientY;
  T.finger = { x, y };
  T.touchAt = performance.now();
  T.zoneTouch = false;
  if (T.s && (!alive(T.s) || !alive(T.e))) clear(T);
  const hw = handleOf(e.target);
  if (hw && T.s) { cancelPress(T); startDrag(T, hw, x, y, tc.identifier); return; }
  const target = elOf(e.target);
  const z = takeoverOn() ? zoneOf(T, target) : null;
  if (z) ensureGuard(findHost(z));
  const pt = z ? caretAt(T.doc, x, y) : null;
  const word = pt && zoneOf(T, pt.n.parentElement) ? wordAt(T.doc, pt, x) : null;
  cancelPress(T);
  T.press = { x, y, id: tc.identifier, t0: performance.now(), word, onSel: !!(T.s && onSelection(T, x, y)), charge: null, t1: 0, t2: 0 };
  T.zoneTouch = !!word;
  if (word) {
    T.press.t1 = setTimeout(() => startCharge(T), CHARGE_MS);
    T.press.t2 = setTimeout(() => commit(T), LONG_MS);
  }
}

function onMove(T, e) {
  if (T.drag) {
    const tc = touchOf(e.changedTouches, T.drag.id);
    if (!tc) return;
    T.finger = { x: tc.clientX, y: tc.clientY };
    dragTo(T, tc.clientX, tc.clientY);
    kick(T);
    return;
  }
  const p = T.press;
  const tc = p && touchOf(e.changedTouches, p.id);
  if (!tc) return;
  T.finger = { x: tc.clientX, y: tc.clientY };
  if (T.phase === 'extend') { extendTo(T, tc.clientX, tc.clientY); kick(T); return; }
  if (Math.hypot(tc.clientX - p.x, tc.clientY - p.y) > SLOP) cancelPress(T);   // 是在滑动：墨收回去，页面照常滚
}

function onEnd(T, e) {
  if (T.drag) {
    if (touchOf(e.changedTouches, T.drag.id)) { endDrag(T); if (e.cancelable) e.preventDefault(); }
    return;
  }
  const p = T.press;
  if (!p || !touchOf(e.changedTouches, p.id)) return;
  if (T.phase === 'extend') {
    T.press = null;
    T.phase = 'sel';
    hideLoupe(T.L, REDUCE());
    placeBar(T, true);
    if (e.cancelable) e.preventDefault();   // 长按松手不再派发点击（落在链接上也不跳转）
    return;
  }
  const tap = e.type === 'touchend' && performance.now() - p.t0 < LONG_MS;
  cancelPress(T);
  if (!tap || !T.s) return;
  if (p.onSel) {
    // 点选区本身：收起 / 叫回工具条
    if (barOn()) hideBar(); else placeBar(T, true);
    if (e.cancelable) e.preventDefault();
    return;
  }
  clear(T);   // 点别处：取消（这一下点击照常生效）
}

export function attachTouch(doc, opts = {}) {
  const T = stateFor(doc, opts);
  const win = T.win;
  doc.addEventListener('touchstart', (e) => onStart(T, e), { passive: true, capture: true });
  doc.addEventListener('touchmove', (e) => onMove(T, e), { passive: true, capture: true });
  doc.addEventListener('touchend', (e) => onEnd(T, e), { passive: false, capture: true });
  doc.addEventListener('touchcancel', (e) => onEnd(T, e), { passive: false, capture: true });
  // 系统那一套让位：长按选词靠 contextmenu 没被拦才发生，接管的地方一律拦下（电脑端菜单、桌面壳菜单也就不出了）
  doc.addEventListener('contextmenu', (e) => {
    if (T.press?.word || T.phase === 'extend' || T.drag || handleOf(e.target)) { e.preventDefault(); e.stopImmediatePropagation(); }
  }, true);
  doc.addEventListener('selectstart', (e) => {
    if (T.zoneTouch && performance.now() - T.touchAt < 1500 && takeoverOn()) e.preventDefault();
  }, true);
  // 滑动时工具条先让开，停下 220ms 后回来
  doc.addEventListener('scroll', () => {
    if (!T.s || T.phase !== 'sel') return;
    hideBar(true);
    clearTimeout(T.scrollT);
    T.scrollT = setTimeout(() => { if (T.s && T.phase === 'sel') placeBar(T, true); }, 220);
  }, true);
  win.addEventListener('resize', () => { if (T.s) { remeasure(T); clearTimeout(T.scrollT); T.scrollT = setTimeout(() => { if (T.s && T.phase === 'sel') placeBar(T, true); }, 220); } });
  return T;
}
