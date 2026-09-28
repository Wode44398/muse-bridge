// 桌面「拖拽」文件上传辅助（扩展中心上传）。
// 手机端没有文件拖拽，这些监听在触屏上不会触发：纯增量、对移动端零副作用。

// 从拖放事件里取出文件。
export function filesFromDrop(e) {
  const dt = e.dataTransfer; if (!dt) return [];
  if (dt.files && dt.files.length) return [...dt.files];
  const out = [];
  if (dt.items) for (const it of dt.items) if (it.kind === 'file') { const f = it.getAsFile(); if (f) out.push(f); }
  return out;
}

// 拖拽中是否携带文件（区分「拖文件进来」和「拖选中的文字 / 链接」——只有前者亮遮罩）。
export function dragHasFiles(e) {
  const t = e.dataTransfer && e.dataTransfer.types;
  if (!t) return false;
  return Array.prototype.indexOf.call(t, 'Files') !== -1;
}

// Svelte action：文件拖到 node 上时触发 onEnter / onLeave / onDrop。
// dragenter/dragleave 会因子元素反复触发，用进出计数消抖（只在真正进入 / 离开时回调一次）。
// 额外在 window 上兜底：拖出窗口 / 在别处松手时清掉高亮，并拦掉浏览器「打开被拖入文件」的默认跳转。
export function fileDrop(node, opts = {}) {
  let cur = opts, depth = 0;
  const enter = (e) => { if (!dragHasFiles(e)) return; e.preventDefault(); if (++depth === 1) cur.onEnter && cur.onEnter(); };
  const over = (e) => { if (!dragHasFiles(e)) return; e.preventDefault(); try { e.dataTransfer.dropEffect = 'copy'; } catch {} };
  const leave = (e) => { if (!dragHasFiles(e)) return; if (--depth <= 0) { depth = 0; cur.onLeave && cur.onLeave(); } };
  const drop = (e) => {
    if (!dragHasFiles(e)) return;
    e.preventDefault(); depth = 0; cur.onLeave && cur.onLeave();
    const fs = filesFromDrop(e); if (fs.length) cur.onDrop && cur.onDrop(fs);
  };
  // window 兜底：清高亮 + 阻止在拖放区外松手时浏览器打开文件。
  const winReset = () => { if (depth !== 0) { depth = 0; cur.onLeave && cur.onLeave(); } };
  const winOver = (e) => { if (dragHasFiles(e)) e.preventDefault(); };
  const winDrop = (e) => { if (dragHasFiles(e)) e.preventDefault(); winReset(); };

  node.addEventListener('dragenter', enter);
  node.addEventListener('dragover', over);
  node.addEventListener('dragleave', leave);
  node.addEventListener('drop', drop);
  window.addEventListener('dragover', winOver);
  window.addEventListener('drop', winDrop);
  window.addEventListener('dragend', winReset);
  return {
    update(o) { cur = o || {}; },
    destroy() {
      node.removeEventListener('dragenter', enter);
      node.removeEventListener('dragover', over);
      node.removeEventListener('dragleave', leave);
      node.removeEventListener('drop', drop);
      window.removeEventListener('dragover', winOver);
      window.removeEventListener('drop', winDrop);
      window.removeEventListener('dragend', winReset);
    },
  };
}
