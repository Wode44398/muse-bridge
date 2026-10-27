// 桌面工具提示 action：use:tooltip={'文本'}。悬停 380ms 后在元素上方浮出
// （顶部放不下自动翻到下方），移出/按下/滚动即收。单例 DOM，样式在 tokens.css 的 .dsk-tip。
//
// 提示挂在 body 上，宿主却可能在悬停期间被整页换走（点 Dock 进 Claude：主页 display:none、
// 转场层盖上来）——这时宿主收不到 pointerleave，提示会孤零零钉在新页面上（10-13 Claude 输入框上
// 那个「Claude」）。所以除了宿主自己的事件，显示期间再听全局：指针移出宿主 / 任意按下 / 按键 /
// 窗口失焦一律收；到点要弹时宿主已不在指针下（被藏、被盖、被卸载）就不弹。
let tipEl = null;

function ensureEl() {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'dsk-tip';
    document.body.appendChild(tipEl);
  }
  return tipEl;
}

export function tooltip(node, text) {
  let cur = text;
  let timer = 0;
  let shown = false;

  function show() {
    if (!cur || !node.isConnected || !node.matches(':hover')) { hide(); return; }
    const el = ensureEl();
    el.textContent = cur;
    el.classList.remove('show');
    el.style.left = '0px'; el.style.top = '-9999px';
    const r = node.getBoundingClientRect();
    const tr = el.getBoundingClientRect();
    let left = Math.round(r.left + r.width / 2 - tr.width / 2);
    left = Math.max(6, Math.min(left, window.innerWidth - tr.width - 6));
    let top = Math.round(r.top - tr.height - 7);
    if (top < 6) top = Math.round(r.bottom + 7);
    el.style.left = left + 'px'; el.style.top = top + 'px';
    requestAnimationFrame(() => el.classList.add('show'));
    if (!shown) watch(true);
    shown = true;
  }
  function hide() {
    clearTimeout(timer);
    if (shown && tipEl) tipEl.classList.remove('show');
    if (shown) watch(false);
    shown = false;
  }
  function enter() { clearTimeout(timer); timer = setTimeout(show, 380); }
  function outside(e) { if (!(e.target instanceof Node) || !node.contains(e.target)) hide(); }
  function watch(on) {
    const f = on ? 'addEventListener' : 'removeEventListener';
    document[f]('pointermove', outside, true);
    document[f]('pointerdown', hide, true);
    document[f]('keydown', hide, true);
    window[f]('blur', hide);
  }

  node.addEventListener('pointerenter', enter);
  node.addEventListener('pointerleave', hide);
  node.addEventListener('pointerdown', hide);
  window.addEventListener('scroll', hide, true);

  return {
    update(t) { cur = t; if (shown) show(); },
    destroy() {
      hide();
      node.removeEventListener('pointerenter', enter);
      node.removeEventListener('pointerleave', hide);
      node.removeEventListener('pointerdown', hide);
      window.removeEventListener('scroll', hide, true);
    },
  };
}
