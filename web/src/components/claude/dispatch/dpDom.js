// 子 agent 调用策略子页用到的几个 DOM 小工具（浮层挪到 body、浮层开着时的 Esc 与键盘走位、点到的视口坐标）。
import { tick } from 'svelte';
import { menuStep, tabStep } from './dpUtil.js';

/** use:portal —— 把节点挪到 body 上。两套设置外壳的正文都在会圈住 fixed 的祖先里
 *  （手机设置页的面板带 transform、桌面内容列是会裁切的滚动容器），浮层不挪出去就盖不出来。 */
export function portal(node) {
  document.body.appendChild(node);
  return { destroy() { node.remove(); } };
}

/** 浮层开着时接 Esc：在 window 捕获阶段拦下，只关浮层。外壳自己的 Esc（退出子页 / 关设置）在冒泡阶段，轮不到它。
 *  返回撤销函数，配合 $effect 用：$effect(() => (open ? escLayer(close) : undefined)) */
export function escLayer(close) {
  const h = (e) => {
    if (e.key !== 'Escape' || e.isComposing) return;
    e.preventDefault();
    e.stopPropagation();
    close();
  };
  window.addEventListener('keydown', h, true);
  return () => window.removeEventListener('keydown', h, true);
}

/** use:layerFocus —— 挪到 body 上的整屏浮层（里面是输入栏那两个弹层：模型菜单 / 推理强度面板）的键盘操作。
 *  那两个弹层在输入栏里紧跟在触发按钮后面，Tab 顺着就进去了；挪到 body 末尾之后焦点还留在被遮住的片上，
 *  要把背后整页 Tab 完才轮到它，所以这一层自己管：
 *   · 打开时把焦点送进去：层里标了 autofocus 的（搜索框）→ 当前选中的那一项 → 第一个菜单项 → 拉条 → 第一个能聚焦的；
 *   · Tab / Shift+Tab 圈在层里；
 *   · 层里有菜单（role="menu"）时 ↑ ↓ Home End 在各行之间走（搜索框也算一行；在搜索框里 Home / End 还是挪光标）；
 *   · 层里的内容换了（模型菜单进出 More models，刚才聚焦的那一行没了）而焦点落了空，再送进去一次。
 *  键盘事件在 window 捕获阶段接（同 escLayer）：焦点万一不在层里（落空的那一瞬间）也接得到。
 *  关闭后把焦点还给触发的那枚片由调用方做。 */
export function layerFocus(node) {
  const shown = (el) => el.tabIndex >= 0 && el.getClientRects().length > 0;
  const tabbables = () => [...node.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]')].filter(shown);
  const inside = () => { const a = document.activeElement; return a && a !== document.body && node.contains(a) ? a : null; };
  function into() {
    const all = tabbables();
    const pick = (sel) => all.find((el) => el.matches(sel));
    const el = pick('[autofocus]') || pick('[aria-checked="true"]') || pick('[role^="menuitem"]') || pick('input[type="range"]') || all[0];
    if (el) try { el.focus(); } catch {}
  }
  function onKey(e) {
    if (e.isComposing || e.ctrlKey || e.altKey || e.metaKey) return;
    const act = inside();
    if (e.key === 'Tab') {
      const all = tabbables();
      if (!all.length) { e.preventDefault(); return; }   // 层里没有能聚焦的：也别漏到背后的页面上
      const j = tabStep(act ? all.indexOf(act) : -1, all.length, e.shiftKey);
      if (j < 0) return;
      e.preventDefault();
      all[j].focus();
      return;
    }
    if (e.shiftKey) return;
    const menu = node.querySelector('[role="menu"]');
    if (!menu) return;   // 推理强度面板：方向键归拉条自己
    const typing = !!act && act.matches('input, textarea');
    if (typing && (e.key === 'Home' || e.key === 'End')) return;
    const rows = [...menu.querySelectorAll('button:not(:disabled), input:not(:disabled)')].filter(shown);
    const j = menuStep(e.key, act ? rows.indexOf(act) : -1, rows.length);
    if (j < 0) return;
    e.preventDefault();
    rows[j].focus();
  }
  window.addEventListener('keydown', onKey, true);
  const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => { if (!inside()) into(); });
  mo?.observe(node, { childList: true, subtree: true });
  // 等这一轮渲染落定再送焦点：这时节点已经挪到 body，里面的弹层也收好了边
  //（模型菜单在它自己的 tick 之后才把探出视口的部分拉回来，那个 tick 排在这个前面），聚焦的那一行已经在它该在的位置上
  let live = true;
  tick().then(() => { if (live && !inside()) into(); });
  return { destroy() { live = false; mo?.disconnect(); window.removeEventListener('keydown', onKey, true); } };
}

/** use:fitPopover={{ x, y }} 或 {{ rect }} —— fixed 浮层贴着一个点 / 一个矩形展开，量过自己的尺寸后收进视口：
 *  下方放不下就翻到上方，右边探出去就往左收。位置写在行内的 left / top 上。 */
export function fitPopover(node, at) {
  const PAD = 8, GAP = 6;
  function place(p) {
    const vw = window.innerWidth, vh = window.innerHeight;
    const w = node.offsetWidth, h = node.offsetHeight;
    const r = p && p.rect;
    let left = r ? r.left : (p ? p.x : 0);
    let top = r ? r.bottom + GAP : (p ? p.y + GAP : 0);
    if (top + h > vh - PAD) {
      const above = (r ? r.top : (p ? p.y : 0)) - GAP - h;
      top = above >= PAD ? above : Math.max(PAD, vh - PAD - h);
    }
    left = Math.min(Math.max(PAD, left), Math.max(PAD, vw - PAD - w));
    node.style.left = Math.round(left) + 'px';
    node.style.top = Math.round(top) + 'px';
  }
  place(at);
  return { update: place };
}
