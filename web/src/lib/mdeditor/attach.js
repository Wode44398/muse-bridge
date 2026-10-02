// attach.js —— 插图 / 附件（Obsidian 同款）：粘贴或拖入文件、或右键「插入 ▸ 图片或附件…」选文件 →
// opts.saveAttachment(file, name) 存进笔记旁（DocViewer 决定落在哪、返回 { link }）→ 在落点写入
// ![[link]]（图片/音视频/PDF 嵌入）或 [[link]]（其它附件只链接）。
//
// 上传期间文档里不写任何占位文字（停笔 1.2s 就自动保存，占位串会被存进文件）：落点用一个 widget
// 装饰标记，装饰随编辑自动映射（上传途中继续打字、在前面插字都不会错位）；存好后在标记处写链接、
// 撤掉标记。多个文件逐个串行存，保证插入顺序与选择顺序一致。
// 剪贴板同时带文字时让文字优先（从 Excel 复制单元格会同时带一张截图，用户要的是文字）。
import { StateField, StateEffect, Facet } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { t } from '../i18n.js';

const attachConf = Facet.define({ combine: (v) => v[0] || null });
const addPending = StateEffect.define();    // { id, pos, label }
const dropPending = StateEffect.define();   // id

class PendingWidget extends WidgetType {
  constructor(id, label) { super(); this.id = id; this.label = label; }
  eq(o) { return o.id === this.id && o.label === this.label; }
  toDOM() {
    const s = document.createElement('span');
    s.className = 'mde-upl';
    s.innerHTML = '<span class="mde-upl-spin"></span><span class="mde-upl-lb"></span>';
    s.lastChild.textContent = this.label;
    return s;
  }
  ignoreEvent() { return true; }
}

const pendingField = StateField.define({
  create: () => Decoration.none,
  update(set, tr) {
    set = set.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(addPending)) {
        const { id, pos, label } = e.value;
        set = set.update({ add: [Decoration.widget({ widget: new PendingWidget(id, label), side: 1, pendingId: id }).range(pos)] });
      } else if (e.is(dropPending)) {
        set = set.update({ filter: (_f, _t, d) => d.spec.pendingId !== e.value });
      }
    }
    return set;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function pendingPos(state, id) {
  let pos = null;
  state.field(pendingField).between(0, state.doc.length, (from, _to, d) => {
    if (d.spec.pendingId === id) { pos = from; return false; }
  });
  return pos;
}

const EMBED_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|ico|mp3|wav|m4a|ogg|flac|aac|opus|mp4|webm|mov|mkv|ogv|m4v|pdf)$/i;
const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
const EXT_OF_MIME = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/bmp': 'bmp', 'image/avif': 'avif' };
// 文件名：截图/网页复制的图片没有像样的名字（image.png / blob）→ 「Pasted image 20261001123456.png」（Obsidian 同名）；
// 有真名的（资源管理器里复制/拖进来的文件）保留原名。[[ ]] 里有特殊含义的 [ ] | # ^ 换成 -。
function nameFor(file, pasted, i) {
  let n = String(file.name || '').trim();
  const generic = !n || /^(image|blob|clipboard)(\.\w+)?$/i.test(n);
  if (pasted && generic) {
    const ext = EXT_OF_MIME[file.type] || (/\.(\w+)$/.exec(n)?.[1]) || 'png';
    n = `Pasted image ${stamp()}${i ? '-' + i : ''}.${ext}`;
  } else if (!n) n = `Attachment ${stamp()}${i ? '-' + i : ''}`;
  return n.replace(/[[\]|#^\\/:*?"<>]/g, '-');
}

let seq = 0;
async function insertFiles(view, files, at, pasted) {
  const conf = view.state.facet(attachConf);
  if (!conf?.saveAttachment || !files.length) return;
  const jobs = files.map((file, i) => ({ id: 'up' + (++seq), file, name: nameFor(file, pasted, i) }));
  view.dispatch({
    effects: jobs.map((j) => addPending.of({ id: j.id, pos: at, label: t('正在保存 {name}…', { name: j.name }) })),
  });
  let placed = 0;
  for (const j of jobs) {
    let res = null, err = null;
    // 本来就在这个工作空间里的文件（桌面端从文件面板/资源管理器拖进来）：直接写链接，不再复制一份
    try { res = (conf.linkExisting && await conf.linkExisting(j.file)) || await conf.saveAttachment(j.file, j.name); } catch (e) { err = e; }
    if (view.destroyed) return;   // 查看器已关：文件照样存好了，只是不再往（已销毁的）编辑器里写链接
    const pos = pendingPos(view.state, j.id);
    if (!res?.link && !res?.text) {
      view.dispatch({ effects: dropPending.of(j.id) });
      conf.flash?.(t('插入失败：{reason}', { reason: err?.message || j.name }));
      continue;
    }
    const link = res.text || (EMBED_RE.test(res.link) ? '!' : '') + '[[' + res.link + ']]';
    // 落点所在文字已被删掉（标记随之消失）→ 退到当前光标处
    const where = pos ?? view.state.selection.main.head;
    const insert = (placed ? '\n' : '') + link;
    view.dispatch({
      changes: { from: where, insert },
      effects: dropPending.of(j.id),
      // 光标跟着走：原来就停在落点（没动过）时移到链接后面，否则别打扰用户正在别处的编辑
      selection: view.state.selection.main.empty && view.state.selection.main.head === where
        ? { anchor: where + insert.length } : undefined,
      userEvent: 'input.paste',
      scrollIntoView: view.hasFocus,
    });
    placed++;
  }
}

function dropFiles(dt) {
  if (!dt) return [];
  if (dt.files?.length) return [...dt.files];
  return [...(dt.items || [])].filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
}
const hasFileType = (dt) => [...(dt?.types || [])].includes('Files');

const handlers = EditorView.domEventHandlers({
  paste(e, view) {
    if (view.state.readOnly || !view.state.facet(attachConf)?.saveAttachment) return false;
    const cd = e.clipboardData;
    const files = dropFiles(cd);
    if (!files.length || (cd.getData('text/plain') || '').trim()) return false;
    e.preventDefault();
    const sel = view.state.selection.main;
    // 有选区：选中的文字被替换掉（与粘贴文字一致）
    if (!sel.empty) view.dispatch({ changes: { from: sel.from, to: sel.to }, selection: { anchor: sel.from }, userEvent: 'delete' });
    insertFiles(view, files, view.state.selection.main.head, true);
    return true;
  },
  dragover(e, view) {
    if (view.state.readOnly || !view.state.facet(attachConf)?.saveAttachment || !hasFileType(e.dataTransfer)) return false;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'copy'; } catch {}
    return false;   // CM 自己的 dragover 还要画落点光标
  },
  drop(e, view) {
    if (view.state.readOnly || !view.state.facet(attachConf)?.saveAttachment) return false;
    const files = dropFiles(e.dataTransfer);
    if (!files.length) return false;
    e.preventDefault();
    e.stopPropagation();   // 别再冒泡到外层（工作空间/对话的拖放上传）
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
    view.focus();
    view.dispatch({ selection: { anchor: pos } });
    insertFiles(view, files, pos, false);
    return true;
  },
});

// 右键菜单「插入 ▸ 图片或附件…」：系统文件选择器（手机上即系统的照片/文件选择器）
export function canAttach(state) { return !state.readOnly && !!state.facet(attachConf)?.saveAttachment; }
export function pickAttachments(view) {
  if (!canAttach(view.state)) return;
  const at = view.state.selection.main.head;
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.style.display = 'none';
  // 先拷贝再清（清 value 会把 FileList 一起清空）
  input.addEventListener('change', () => { const files = [...(input.files || [])]; input.remove(); insertFiles(view, files, at, false); }, { once: true });
  input.addEventListener('cancel', () => input.remove(), { once: true });
  document.body.appendChild(input);
  input.click();
}

// 右键菜单「粘贴」读到的是图片（navigator.clipboard.read）：与 Ctrl+V 同一条路
export function pasteFiles(view, files) {
  if (!canAttach(view.state) || !files.length) return false;
  insertFiles(view, files, view.state.selection.main.head, true);
  return true;
}

// opts.saveAttachment(file, name) → Promise<{ link }>；opts.linkExisting(file) → Promise<{ text }|null>
// （已在工作空间里的文件给出现成链接，null＝照常存附件）；opts.flash(msg) 出错提示
export function attachments(opts) {
  return [attachConf.of({ saveAttachment: opts.saveAttachment, linkExisting: opts.linkExisting, flash: opts.flash }), pendingField, handlers];
}
