// Live Preview 装饰引擎 —— 文档永远是纯 markdown 源码，一切「渲染」都是视图层装饰：
// 选区触碰某个构件 → 该构件揭示源码；离开 → 恢复渲染。装饰只影响显示，坏了顶多退回
// 源码显示，绝不可能污染文件内容。
//
// 揭示粒度：
//   行内（粗斜/删除/==高亮==/`码`/链接/[[双链]]/$数学$/%%注释%%/转义）→ 选区触碰该构件区间
//   行级（# 标题、> 引用、--- 分割线）→ 选区触碰所在行
//   块级（``` 代码围栏、$$ 数学、callout、图片）→ 选区触碰块内任一行
//   表格 / frontmatter → 永不揭示（源码只在源码模式），常驻编辑 widget（table.js / props.js）
//
// 为什么是 StateField 而非 ViewPlugin：块级 widget（block replace）按 CM6 规则不允许
// 由 ViewPlugin 提供（会影响纵向布局）。全文构建换正确性，超大文档有 LP_MAX 保险丝。
import { Decoration, EditorView } from '@codemirror/view';
import { StateField } from '@codemirror/state';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import {
  MathWidget, ImageWidget, CheckboxWidget, HrWidget, FenceHeadWidget,
  CalloutWidget, WikilinkWidget,
} from './widgets.js';
import { TableWidget } from './table.js';
import { PropsWidget } from './props.js';

const HIDE = Decoration.replace({});
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
const LP_MAX = 400_000;   // 超此长度不做 LP 装饰（仍可编辑源码），防卡
const MARK_OF = {
  Emphasis: 'EmphasisMark', StrongEmphasis: 'EmphasisMark',
  Strikethrough: 'StrikethroughMark', OmHighlight: 'OmHighlightMark',
  Superscript: 'SuperscriptMark', Subscript: 'SubscriptMark',
};

// frontmatter 无法在 lezer 块解析器里安全回溯（未闭合场景），用正则圈定区间，
// 区间内的树节点一律跳过、由本引擎自管（widget / 行级源码态）。
function frontmatterEnd(doc) {
  if (doc.lines < 2 || doc.line(1).text !== '---') return 0;
  const cap = Math.min(doc.lines, 300);
  for (let i = 2; i <= cap; i++) {
    if (/^---\s*$/.test(doc.line(i).text)) return doc.line(i).to;
  }
  return 0;
}

class Builder {
  constructor(state, opts, tree) {
    this.state = state;
    this.tree = tree;
    this.doc = state.doc;
    this.sel = state.selection;
    this.opts = opts;
    this.ranges = [];
    this.atomic = [];
    this.lineSeen = new Set();
    this.rawCallouts = [];
  }

  // —— 选区判定 ——
  touches(from, to) {
    for (const r of this.sel.ranges) if (r.from <= to && r.to >= from) return true;
    return false;
  }
  selInside(from, to) {
    for (const r of this.sel.ranges) if (r.from < to && r.to > from) return true;
    return false;
  }
  lineTouches(from, to) {
    return this.touches(this.doc.lineAt(from).from, this.doc.lineAt(Math.min(to, this.doc.length)).to);
  }

  // —— 装饰收集 ——
  add(from, to, deco) { if (to > from) this.ranges.push(deco.range(from, to)); }
  hide(from, to) { this.add(from, to, HIDE); }
  mark(from, to, cls, attrs) {
    if (to > from) this.ranges.push(Decoration.mark(attrs ? { class: cls, attributes: attrs } : { class: cls }).range(from, to));
  }
  line(pos, cls) {
    const key = pos + ':' + cls;
    if (this.lineSeen.has(key)) return;
    this.lineSeen.add(key);
    this.ranges.push(Decoration.line({ class: cls }).range(pos));
  }
  lines(from, to, cls) {
    const lf = this.doc.lineAt(from).number, ll = this.doc.lineAt(Math.min(to, this.doc.length)).number;
    for (let n = lf; n <= ll; n++) this.line(this.doc.line(n).from, cls);
  }
  addBlock(from, to, widget, atomic) {
    const lf = this.doc.lineAt(from), ll = this.doc.lineAt(Math.min(to, this.doc.length));
    const block = lf.from === from && ll.to === to;   // 只有整行块才能用 block widget
    this.add(from, to, Decoration.replace({ widget, block }));
    if (atomic) this.atomic.push(HIDE.range(from, to));
  }
  inRawCallout(pos) {
    for (const [f, t] of this.rawCallouts) if (pos >= f && pos <= t) return true;
    return false;
  }
  resolveSrc(src) {
    let s = String(src || '');
    try { s = decodeURIComponent(s); } catch {}
    if (/^(https?:|data:|blob:|\/)/i.test(s)) return src;
    return (this.opts.resolveUrl && this.opts.resolveUrl(s)) || null;
  }

  run() {
    const fmEnd = frontmatterEnd(this.doc);
    if (fmEnd) {
      // 属性面板常驻（面板自己就能改键名/值/类型）；只有罕见的选区被塞进块内
      //（undo/查找/全选）才退回源码行显示，同表格的口径。
      if (this.selInside(0, fmEnd)) {
        this.lines(0, fmEnd, 'mde-line-fm');
        this.line(0, 'mde-line-fm-first');
        this.line(this.doc.lineAt(fmEnd).from, 'mde-line-fm-last');
      } else {
        this.addBlock(0, fmEnd, new PropsWidget(this.doc.sliceString(0, fmEnd), this.opts, this.state.readOnly), true);
      }
    }
    this.tree.iterate({
      enter: (n) => {
        if (fmEnd && n.from < fmEnd && n.name !== 'Document') return false;   // frontmatter 区自管
        return this.enter(n);
      },
    });
    return {
      deco: Decoration.set(this.ranges, true),
      atomic: Decoration.set(this.atomic, true),
    };
  }

  enter(n) {
    const { doc } = this;
    switch (n.name) {
      // ———— 标题 ————
      case 'ATXHeading1': case 'ATXHeading2': case 'ATXHeading3':
      case 'ATXHeading4': case 'ATXHeading5': case 'ATXHeading6': {
        this.line(doc.lineAt(n.from).from, 'mde-line-h' + n.name.slice(-1));
        if (!this.lineTouches(n.from, n.to)) {
          for (const m of n.node.getChildren('HeaderMark')) {
            let f = m.from, t = m.to;
            if (m.from === n.from) { if (doc.sliceString(t, t + 1) === ' ') t++; }
            else if (doc.sliceString(f - 1, f) === ' ') f--;
            this.hide(f, t);
          }
        }
        return true;
      }
      case 'SetextHeading1': case 'SetextHeading2': {
        this.line(doc.lineAt(n.from).from, 'mde-line-h' + (n.name.endsWith('1') ? '1' : '2'));
        if (!this.lineTouches(n.from, n.to)) {
          const m = n.node.getChild('HeaderMark');
          if (m && m.from > n.from) this.hide(m.from - 1, m.to);   // 连换行折掉下划线行
        }
        return true;
      }

      // ———— 行内标记对 ————
      case 'Emphasis': case 'StrongEmphasis': case 'Strikethrough':
      case 'OmHighlight': case 'Superscript': case 'Subscript': {
        if (n.name === 'Superscript') this.mark(n.from, n.to, 'mde-sup');
        if (n.name === 'Subscript') this.mark(n.from, n.to, 'mde-sub');
        if (!this.touches(n.from, n.to)) {
          for (const m of n.node.getChildren(MARK_OF[n.name])) this.hide(m.from, m.to);
        }
        return true;
      }
      case 'InlineCode': {
        this.mark(n.from, n.to, 'mde-icode');
        if (!this.touches(n.from, n.to)) {
          for (const m of n.node.getChildren('CodeMark')) this.hide(m.from, m.to);
        }
        return false;
      }
      case 'Escape': {
        if (!this.touches(n.from, n.to)) this.hide(n.from, n.from + 1);
        return false;
      }
      case 'ObsComment': {
        if (!this.touches(n.from, n.to)) this.hide(n.from, n.to);
        return false;
      }

      // ———— 链接 / 图片 / 双链 ————
      case 'Link': case 'Autolink': {
        const marks = n.node.getChildren('LinkMark');
        const url = n.node.getChild('URL');
        const href = url ? doc.sliceString(url.from, url.to) : '';
        if (n.name === 'Autolink') {
          if (url) this.mark(url.from, url.to, 'mde-link', { 'data-href': href });
          if (!this.touches(n.from, n.to)) for (const m of marks) this.hide(m.from, m.to);
          return false;
        }
        if (marks.length >= 2) {
          this.mark(marks[0].to, marks[1].from, 'mde-link', { 'data-href': href });
          if (!this.touches(n.from, n.to)) {
            this.hide(n.from, marks[0].to);
            this.hide(marks[1].from, n.to);
          }
        }
        return true;
      }
      case 'URL': {
        const p = n.node.parent?.name;
        if (p !== 'Link' && p !== 'Image' && p !== 'Autolink') {
          this.mark(n.from, n.to, 'mde-link', { 'data-href': doc.sliceString(n.from, n.to) });
        }
        return false;
      }
      case 'Image': {
        if (!this.touches(n.from, n.to)) {
          const url = n.node.getChild('URL');
          const marks = n.node.getChildren('LinkMark');
          const src = url ? doc.sliceString(url.from, url.to) : '';
          const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : '';
          this.add(n.from, n.to, Decoration.replace({ widget: new ImageWidget(this.resolveSrc(src), alt) }));
        }
        return false;
      }
      case 'Wikilink': case 'WikilinkEmbed': {
        if (!this.touches(n.from, n.to)) {
          const raw = doc.sliceString(n.from, n.to);
          const m = /^(!?)\[\[([^[\]]+)\]\]$/.exec(raw);
          if (m) {
            let target = m[2], alias = '', head = '';
            const p = target.indexOf('|');
            if (p >= 0) { alias = target.slice(p + 1).trim(); target = target.slice(0, p); }
            const h = target.indexOf('#');
            if (h >= 0) { head = target.slice(h + 1).trim(); target = target.slice(0, h); }
            target = target.trim();
            const embed = !!m[1];
            if (embed && IMG_EXT_RE.test(target)) {
              const u = this.resolveSrc(target);
              this.add(n.from, n.to, Decoration.replace({ widget: new ImageWidget(u, target) }));
            } else {
              this.add(n.from, n.to, Decoration.replace({ widget: new WikilinkWidget(target, head, alias, embed, this.opts) }));
            }
          }
        }
        return false;
      }
      case 'ObsTag':
        return false;   // 样式走高亮 tag class（mde-t-tag 胶囊），无揭示逻辑

      // ———— 数学 ————
      case 'InlineMath': {
        if (!this.touches(n.from, n.to)) {
          this.add(n.from, n.to, Decoration.replace({ widget: new MathWidget(doc.sliceString(n.from + 1, n.to - 1), false) }));
        }
        return false;
      }
      case 'BlockMath': {
        if (!this.lineTouches(n.from, n.to)) {
          const tex = doc.sliceString(n.from, n.to).replace(/^\$\$/, '').replace(/\$\$$/, '');
          this.addBlock(n.from, n.to, new MathWidget(tex, true));
        } else {
          this.lines(n.from, n.to, 'mde-line-mathsrc');
        }
        return false;
      }

      // ———— 引用 / callout ————
      case 'Blockquote': {
        const head = doc.sliceString(n.from, Math.min(n.to, n.from + 120));
        const co = /^>\s*\[![a-zA-Z-]+\]/.exec(head);
        if (co) {
          if (!this.lineTouches(n.from, n.to)) {
            this.addBlock(n.from, n.to, new CalloutWidget(doc.sliceString(n.from, n.to), this.opts));
            return false;
          }
          this.rawCallouts.push([n.from, n.to]);
          this.lines(n.from, n.to, 'mde-line-callout');
          return true;
        }
        this.lines(n.from, n.to, 'mde-line-bq');
        return true;
      }
      case 'QuoteMark': {
        if (this.inRawCallout(n.from)) return false;
        if (!this.lineTouches(n.from, n.to)) {
          this.hide(n.from, n.to + (doc.sliceString(n.to, n.to + 1) === ' ' ? 1 : 0));
        }
        return false;
      }

      // ———— 列表 / 任务 ————
      case 'ListMark': {
        this.line(doc.lineAt(n.from).from, 'mde-line-li');   // 列表行整体右移，对齐阅读模式的 ul 缩进
        if (n.node.nextSibling?.name !== 'Task') {
          // 无序标记 -/*/+ 画成圆点（对齐阅读模式的 li::marker），有序 1. 原样；
          // 原字符只是被 visibility 藏起来占位，光标/选区/编辑一律照旧
          const bullet = /^[-*+]$/.test(doc.sliceString(n.from, n.to));
          this.mark(n.from, n.to, bullet ? 'mde-listmark mde-listbullet' : 'mde-listmark');
        }
        return false;
      }
      case 'TaskMarker': {
        const line = doc.lineAt(n.from);
        const checked = /x/i.test(doc.sliceString(n.from + 1, n.to - 1));
        if (!this.selInside(n.from, n.to)) {
          this.add(n.from, n.to, Decoration.replace({ widget: new CheckboxWidget(checked) }));
          this.atomic.push(HIDE.range(n.from, n.to));
          let li = n.node.parent;
          while (li && li.name !== 'ListItem') li = li.parent;
          const lm = li && li.getChild('ListMark');
          if (lm && lm.to <= n.from) this.hide(lm.from, Math.min(lm.to + 1, n.from));
        }
        if (checked) this.mark(Math.min(n.to + 1, line.to), line.to, 'mde-done');
        return false;
      }

      // ———— 代码块 ————
      case 'FencedCode': {
        const lf = doc.lineAt(n.from), ll = doc.lineAt(Math.min(n.to, doc.length));
        for (let ln = lf.number; ln <= ll.number; ln++) {
          let cls = 'mde-line-code';
          if (ln === lf.number) cls += ' mde-line-code-first';
          if (ln === ll.number) cls += ' mde-line-code-last';
          this.line(doc.line(ln).from, cls);
        }
        if (!this.lineTouches(n.from, n.to)) {
          const info = n.node.getChild('CodeInfo');
          const lang = info ? doc.sliceString(info.from, info.to).trim() : '';
          const closed = ll.number > lf.number && /^\s*(`{3,}|~{3,})\s*$/.test(ll.text);
          const codeFrom = Math.min(lf.to + 1, n.to);
          const codeTo = Math.max(closed ? ll.from - 1 : n.to, codeFrom);   // 未闭合围栏：吃到块尾
          const code = doc.sliceString(codeFrom, codeTo);
          this.add(lf.from, lf.to, Decoration.replace({ widget: new FenceHeadWidget(lang, () => code) }));
          if (closed) this.hide(ll.from, ll.to);
        }
        return false;
      }
      case 'CodeBlock': {   // 四空格缩进式
        this.lines(n.from, n.to, 'mde-line-code');
        return false;
      }

      // ———— 分割线 / 表格 ————
      case 'HorizontalRule': {
        if (!this.lineTouches(n.from, n.to)) {
          this.add(n.from, n.to, Decoration.replace({ widget: new HrWidget() }));
        }
        return false;
      }
      case 'Table': {
        if (this.selInside(n.from, n.to)) return true;   // 罕见（undo/搜索把光标送进来）→ 揭示源码
        this.addBlock(n.from, n.to, new TableWidget(doc.sliceString(n.from, n.to), this.opts), true);
        return false;
      }
    }
    return true;
  }
}

function build(state, opts) {
  if (state.doc.length > LP_MAX) return { deco: Decoration.none, atomic: Decoration.none };
  // 主动把全文解析拉满（普通笔记几毫秒；超预算退回部分树，后台推进时 update 再补）——
  // 只靠 requestIdleCallback 后台解析，视口外的块（表格/数学/代码）会长期裸奔。
  const tree = ensureSyntaxTree(state, state.doc.length, 100) || syntaxTree(state);
  const b = new Builder(state, opts, tree);
  try { return b.run(); }
  catch (e) {
    console.warn('[mdeditor] live preview build failed', e);
    return { deco: Decoration.none, atomic: Decoration.none };   // 兜底：纯源码显示
  }
}

export function livePreview(opts) {
  const field = StateField.define({
    create: (state) => build(state, opts),
    update(v, tr) {
      // 只读开关也要重建：属性面板按可写与否给不同控件
      if (tr.docChanged || tr.selection || tr.state.readOnly !== tr.startState.readOnly ||
          syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state, opts);
      return v;
    },
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.deco),
      EditorView.atomicRanges.of((view) => view.state.field(f, false)?.atomic || Decoration.none),
    ],
  });

  // 链接点按：触屏直接开，桌面 Ctrl/Cmd+点（普通点=置光标揭示源码）
  const linkClick = EditorView.domEventHandlers({
    click(e, view) {
      const a = e.target && e.target.closest ? e.target.closest('.mde-link') : null;
      if (!a) return false;
      const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      if (!coarse && !e.ctrlKey && !e.metaKey) return false;
      const href = a.getAttribute('data-href') || a.textContent || '';
      e.preventDefault();
      if (/^(https?:|mailto:|tel:)/i.test(href)) opts.openLink?.(href);
      else if (href) opts.openRel?.(href);
      return true;
    },
  });

  return [field, linkClick];
}
