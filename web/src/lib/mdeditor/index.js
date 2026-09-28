// mdeditor —— Obsidian 式 Live Preview / 源码 双模编辑器（CodeMirror 6 内核）。
// DocViewer 懒加载本模块（编辑器 chunk 不进主包，阅读模式零开销）。
// 文档=纯 markdown 源码；Live Preview 全靠视图层装饰（livePreview.js），
// 模式切换只是 Compartment 重配，同一编辑器实例、撤销栈不断。
import { EditorView, keymap, scrollPastEnd } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { history, historyKeymap, defaultKeymap } from '@codemirror/commands';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { syntaxHighlighting } from '@codemirror/language';
import { omExtensions } from './mdext.js';
import { mdHighlight } from './theme.js';
import { livePreview } from './livePreview.js';
import { docTail } from './tail.js';
import { commands } from './commands.js';
import { createMenuCtl } from './menu.js';
import './editor.css';

// opts:
//   parent      挂载点（编辑器自滚动，占满父容器）
//   doc         初始 markdown 源码
//   mode        'live' | 'source'
//   readOnly    只读（本地无写权限等）
//   onChange(text)        文档变更（喂 DocViewer 的 draft/dirty/自动保存）
//   onSave()              Ctrl/Cmd+S
//   onNavigate(name,head) [[双链]] 点按（name 空 = 本文档内锚点）
//   openLink(url)         外链
//   openRel(href)         相对路径链接（./xx.md 等）
//   resolveUrl(name)      相对资源/![[嵌入]] → 可加载 URL（DocViewer.embedUrl）
//   renderMd(src)         callout 等整块渲染（obsmd，与阅读模式同观感）
export function createMdEditor(opts = {}) {
  const { parent, doc = '', mode = 'live', readOnly = false } = opts;
  const lpComp = new Compartment();
  const roComp = new Compartment();
  const menuCtl = createMenuCtl();   // 选中浮条 + 右键菜单（替代旧底部工具栏）
  // widget 侧要用的编辑器能力（属性面板的属性菜单/提示气泡复用同一套）
  const lpOpts = { ...opts, openMenu: (x, y, items) => menuCtl.openMenu(x, y, items), flash: (m) => menuCtl.flash(m) };

  const state = EditorState.create({
    doc,
    extensions: [
      history(),
      EditorView.lineWrapping,
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        extensions: omExtensions,
        completeHTMLTags: false,
      }),
      syntaxHighlighting(mdHighlight, { fallback: false }),
      keymap.of([
        { key: 'Mod-s', preventDefault: true, run: () => { opts.onSave?.(); return true; } },
        { key: 'Mod-b', run: (v) => { commands.bold(v); return true; } },
        { key: 'Mod-i', run: (v) => { commands.italic(v); return true; } },
        { key: 'Tab', run: (v) => { commands.indent(v); return true; } },
        { key: 'Shift-Tab', run: (v) => { commands.outdent(v); return true; } },
        ...historyKeymap,
        ...defaultKeymap,
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged) opts.onChange?.(u.state.doc.toString());
      }),
      EditorView.contentAttributes.of({ autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false' }),
      scrollPastEnd(),
      docTail(lpOpts),   // 文末尾栏（反链/出链/词数）：两种模式都挂，底部与阅读态一致
      menuCtl.extension,
      roComp.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
      lpComp.of(mode === 'live' ? livePreview(lpOpts) : []),
    ],
  });

  const view = new EditorView({ state, parent });
  parent.classList.add('mde');
  menuCtl.attach(view, parent);

  const api = {
    view,
    setMode(m) { view.dispatch({ effects: lpComp.reconfigure(m === 'live' ? livePreview(lpOpts) : []) }); },
    setReadOnly(ro) { view.dispatch({ effects: roComp.reconfigure([EditorState.readOnly.of(ro), EditorView.editable.of(!ro)]) }); },
    getDoc: () => view.state.doc.toString(),
    setDoc(text) {
      if (text === view.state.doc.toString()) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },
    cmd(name) { const fn = commands[name]; if (fn) fn(view); },
    scrollToHeading(text) {
      const t = String(text).trim().toLowerCase();
      for (let n = 1; n <= view.state.doc.lines; n++) {
        const line = view.state.doc.line(n);
        const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line.text);
        if (m && m[1].trim().toLowerCase() === t) {
          view.dispatch({ selection: { anchor: line.to }, scrollIntoView: true });
          view.focus();
          return true;
        }
      }
      return false;
    },
    // 模式切换对齐阅读进度：读出/滚到某个文档位置。
    // 位置换算不能用像素比例——CM 是虚拟滚动，视口外的行高是估算值；scrollIntoView 会
    // 自己边测边修，落点才准。
    topPos() {
      const r = view.scrollDOM.getBoundingClientRect();
      for (let dy = 2; dy < 48; dy += 6) {
        const p = view.posAtCoords({ x: r.left + 24, y: r.top + dy });
        if (p != null) return p;
      }
      return 0;
    },
    scrollToPos(pos) {
      const p = Math.max(0, Math.min(view.state.doc.length, Math.round(pos || 0)));
      view.dispatch({ effects: EditorView.scrollIntoView(p, { y: 'start', yMargin: 0 }) });
    },
    focus: () => view.focus(),
    destroy: () => { menuCtl.destroy(); view.destroy(); },
  };
  if (typeof window !== 'undefined') window.__mde = api;   // 调试句柄（真机排障也用得上）
  return api;
}
