// 电脑端按钮提示（title 属性的增强版）：悬停 450ms 出一枚深色小胶囊「标签 + 快捷键」，
// 一枚出过之后 800ms 内移到别的按钮直接出（工具条上扫一遍不用每个都等）。触屏不出。
// 用法：<button use:tip={{ label: t('全屏'), kbd: 'F' }}>；只给字符串也行：use:tip={t('关闭')}。
// 同时负责 aria-label（不再另写 title，免得和原生提示叠两层）。
// 提示挂在最近的 .vw-root 里（查看器的层叠上下文内，盖得住画面、盖不住菜单）；不在查看器里就挂 body。
import { pointer } from '../../../lib/layout.svelte.js';

let el = null, host = null, timer = 0, warmUntil = 0, owner = null;

function norm(o) { return typeof o === 'string' ? { label: o, kbd: '' } : (o || { label: '', kbd: '' }); }

function ensure(root) {
  if (el && host === root && el.isConnected) return el;
  el?.remove();
  el = document.createElement('div');
  el.className = 'vw-tip';
  el.setAttribute('role', 'tooltip');
  (host = root).appendChild(el);
  return el;
}

function hide(node) {
  clearTimeout(timer);
  if (node && owner !== node) return;
  if (el) el.classList.remove('on');
  if (owner) warmUntil = performance.now() + 800;
  owner = null;
}

function show(node, o) {
  if (!o.label) return;
  const root = node.closest('.vw-root') || document.body;
  const tipEl = ensure(root);
  tipEl.textContent = o.label;
  if (o.kbd) { const k = document.createElement('kbd'); k.textContent = o.kbd; tipEl.appendChild(k); }
  const r = node.getBoundingClientRect(), rr = root === document.body ? { left: 0, top: 0, width: innerWidth, height: innerHeight } : root.getBoundingClientRect();
  tipEl.style.left = '0px'; tipEl.style.top = '0px';
  tipEl.classList.add('on');
  const w = tipEl.offsetWidth, h = tipEl.offsetHeight;
  // 默认在按钮下方；贴底（底栏、浮条里的按钮）就放上方
  let top = r.bottom - rr.top + 6;
  if (top + h > rr.height - 4) top = r.top - rr.top - h - 6;
  let left = r.left - rr.left + r.width / 2 - w / 2;
  left = Math.max(4, Math.min(left, rr.width - w - 4));
  tipEl.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  owner = node;
}

export function tip(node, opts) {
  let o = norm(opts);
  const setAria = () => { if (o.label) node.setAttribute('aria-label', o.kbd ? `${o.label} (${o.kbd})` : o.label); };
  setAria();
  const enter = (e) => {
    if (e.pointerType !== 'mouse' || !pointer.fine) return;
    clearTimeout(timer);
    const now = performance.now();
    if (now < warmUntil) show(node, o);
    else timer = setTimeout(() => show(node, o), 450);
  };
  const leave = () => hide(node);
  node.addEventListener('pointerenter', enter);
  node.addEventListener('pointerleave', leave);
  node.addEventListener('pointerdown', leave);
  node.addEventListener('blur', leave);
  return {
    update(n) { o = norm(n); setAria(); if (owner === node) { if (o.label) show(node, o); else hide(node); } },
    destroy() {
      node.removeEventListener('pointerenter', enter);
      node.removeEventListener('pointerleave', leave);
      node.removeEventListener('pointerdown', leave);
      node.removeEventListener('blur', leave);
      if (owner === node) hide(node);
    },
  };
}

/** 外框关闭时收掉（提示元素跟着根节点一起卸载，这里只清状态） */
export function resetTips() { clearTimeout(timer); owner = null; warmUntil = 0; if (el && !el.isConnected) el = null; }
