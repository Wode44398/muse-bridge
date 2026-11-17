// 桌面壳原生右键菜单（去 web 化）。
// Electron 壳 removeMenu 后右键什么都没有——输入框连「粘贴」都点不出来，是最扎眼的
// web 遗留。这里在 document 层委托收集上下文，交主进程弹真系统菜单（Menu.popup）：
//   输入框/可编辑区 → 剪切/复制/粘贴/全选（wc.cut/paste 走 Chromium 原生编辑命令）
//   选中文本 → 复制；外链 → 在浏览器打开/复制链接；图片 → 复制图片
// 页面自绘菜单（FilesDesktop、CM6 编辑器等）自己 preventDefault——检测 defaultPrevented
// 即让位，永不与自绘菜单叠出两个。网页/Android 无此桥，模块为空操作。
const D = typeof window !== 'undefined' ? window.BridgeDesktop : null;
const UI_CHROME = 'button, [role="button"], [role="toolbar"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], nav, label, [data-no-img-menu]';

if (D?.app?.contextMenu) {
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;                     // 页面自绘菜单已接管
    const t = e.target instanceof Element ? e.target : null;
    if (!t) return;
    const editEl = t.closest('input, textarea, [contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]');
    const editable = Boolean(editEl && !(editEl.matches('input') && /^(checkbox|radio|range|button|submit|reset|file|color)$/i.test(editEl.type || '')));
    let selection = '';
    try { selection = String(getSelection() || '').trim(); } catch {}
    let link = '';
    const a = t.closest('a[href]');
    if (a) {
      const raw = a.getAttribute('href') || '';
      if (/^https?:\/\//i.test(raw)) link = raw;        // 只有真外链才有「在浏览器打开」语义
    }
    // 只有内容图才给「复制图片」：嵌在按钮 / 工具栏 / 页签等控件里的 img 是界面图标
    // （主页 Dock、侧栏、设置 hero 标），右键冒出复制图片是 web 味（11-17）。
    const img = t.closest('img');
    const image = Boolean(img && !img.closest(UI_CHROME));
    if (!editable && !selection && !link && !image) return;   // 无可操作对象：保持无菜单
    e.preventDefault();
    D.app.contextMenu({
      editable,
      selection: Boolean(selection),
      link,
      image,
      x: Math.round(e.clientX),
      y: Math.round(e.clientY),
    }).catch(() => {});
  });
}
