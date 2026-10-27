// 桌面「粘贴 / 拖拽」文件上传辅助 —— Vertex 各面板（对话 / 图像 / 视频）共用。
// 手机端没有剪贴板文件与文件拖拽，这些监听在触屏上不会触发：纯增量、对移动端零副作用。

// 从粘贴事件里取出文件（截图 / 复制的图片 / 复制的文件）。纯文本粘贴返回空数组。
export function filesFromPaste(e) {
  const dt = e.clipboardData; if (!dt) return [];
  const out = [];
  // 优先 items：截图往往只在 items 里以 image 暴露，files 可能为空。
  if (dt.items && dt.items.length) {
    for (const it of dt.items) if (it.kind === 'file') { const f = it.getAsFile(); if (f) out.push(f); }
  }
  if (!out.length && dt.files && dt.files.length) out.push(...dt.files);
  return out;
}

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

// 纯文本粘贴（去富文本格式）—— 供各 contenteditable 输入框复用。
export function pastePlainText(e) {
  const t = e.clipboardData && e.clipboardData.getData('text/plain');
  if (t == null) return;
  e.preventDefault();
  try { document.execCommand('insertText', false, t); } catch {}
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

// Svelte action：在文档级（捕获阶段）监听粘贴，剪贴板里有文件就回调 onFiles 并吞掉事件，
// 避免同时被输入框自身的 onpaste 当文本处理。挂在面板根节点即可（随面板挂载 / 卸载自动增删监听），
// 因此天然按当前模块作用域——不会跨面板串扰。纯文本粘贴放行给输入框自身处理。
//   opts.filter?(file)  仅接受满足条件的文件（如仅图片）
//   opts.when?()        额外开关（返回 false 时整段跳过）
export function pasteFiles(node, opts = {}) {
  let cur = opts;
  const onPaste = (e) => {
    if (cur.when && !cur.when()) return;
    // 焦点若落在本面板之外的可编辑元素里（如别的输入框），不劫持它的粘贴。
    const ae = document.activeElement;
    if (ae && ae !== document.body && !node.contains(ae)) return;
    let fs = filesFromPaste(e);
    if (cur.filter) fs = fs.filter(cur.filter);
    if (!fs.length) return;
    e.preventDefault(); e.stopPropagation();
    cur.onFiles && cur.onFiles(fs);
  };
  document.addEventListener('paste', onPaste, true);
  return {
    update(o) { cur = o || {}; },
    destroy() { document.removeEventListener('paste', onPaste, true); },
  };
}

// 图片文件判定（图像 / 视频面板只吃图）。
export const isImageFile = (f) => !!f && (f.type || '').startsWith('image/');
