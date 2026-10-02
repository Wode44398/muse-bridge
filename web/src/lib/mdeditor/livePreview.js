// Live Preview 装饰引擎 —— 文档永远是纯 markdown 源码，一切「渲染」都是视图层装饰：
// 选区触碰某个构件 → 该构件揭示源码；离开 → 恢复渲染。装饰只影响显示，坏了顶多退回
// 源码显示，绝不可能污染文件内容。
//
// 揭示粒度：
//   行内（粗斜/删除/==高亮==/`码`/链接/[[双链]]/$数学$/%%注释%%/转义/脚注）→ 选区触碰该构件区间
//   行级（# 标题、--- 分割线）→ 选区触碰所在行
//   块级（``` 代码围栏、$$ 数学、callout、图片）→ 选区触碰块内任一行；数学/独占一行的图片
//         揭示时「源码 + 预览」同时显示（预览挂在源码下方），不会一点就整块消失
//   永不揭示（源码只在源码模式）：表格 / frontmatter（常驻编辑 widget，table.js / props.js）、
//         列表标记（圆点/序号/任务框）、引用的「>」——这些行首前缀揭示出来只会让整行横跳，
//         光标也被夹在前缀之外（Obsidian 同款：Home 到正文起点、不能把光标放在圆点前）
//
// 揭示时机（Obsidian 同款的三道闸，否则会改坏文档或选错字）：
//   ① 编辑器没聚焦不揭示——切到编辑态时首块不会先露一截源码；
//   ② 输入法组字中只 map 不重建——重建会改写正在组字的 DOM，CM 回读时算错差异，吞字；
//   ③ 鼠标按着/刚抬起 280ms 内不因选区变化重建——双击第二下还落在原坐标，拖选越过链接不卡。
//
// 列表几何（与阅读态逐像素对齐）：层级只看语法树（和源码用 2 空格、4 空格还是 tab 无关），
// 每级 24px（= 阅读态 ul/ol 的 1.5em）；「缩进 + 标记 + 其后空白」换成标记 widget 占一个 24px 槽，
// 行装饰 padding-left = 层级×24、text-indent = −本行标记数×24 → 换行后的文字悬挂对齐正文。
// 续行（列表项里不带标记的行）按所在项的正文列对齐，行首缩进空白隐去。
//
// 为什么是 StateField 而非 ViewPlugin：块级 widget（block replace）按 CM6 规则不允许
// 由 ViewPlugin 提供（会影响纵向布局）。全文构建换正确性；只动光标时先比对「揭示集合」，
// 没变就沿用上一版（日常在正文里移动光标零成本），超大文档有 LP_MAX 保险丝。
import { Decoration, EditorView, keymap } from '@codemirror/view';
import { StateField, StateEffect, EditorState, EditorSelection, Prec } from '@codemirror/state';
import { syntaxTree, ensureSyntaxTree } from '@codemirror/language';
import {
  MathWidget, ImageWidget, ListMarkWidget, HrWidget, FenceHeadWidget,
  CalloutWidget, WikilinkWidget, InlineHtmlWidget,
} from './widgets.js';
import { TableWidget } from './table.js';
import { PropsWidget } from './props.js';
import * as obsmd from '../obsmd.js';
import { lastPointerTouch } from '../touchSelection.js';

const HIDE = Decoration.replace({});
const IMG_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
const LP_MAX = 240_000;     // 超此长度不做 LP 装饰（仍可编辑源码），防卡
const PARSE_BUDGET = 30;    // 每次构建最多替解析器垫多少 ms；没解析完先用部分树，后台推进后再补
const LI_UNIT = 24;         // 列表每级缩进 = 阅读态 ul/ol 的 padding-left 1.5em（16px 字号）
const NO_SEL = { ranges: [] };
const MARK_OF = {
  Emphasis: 'EmphasisMark', StrongEmphasis: 'EmphasisMark',
  Strikethrough: 'StrikethroughMark', OmHighlight: 'OmHighlightMark',
};
// 引用前缀：可带行首缩进（列表项里的引用），嵌套的「> >」之间允许最多 3 个空格
const QUOTE_PREFIX_RE = /^[ \t]*>[ \t]?(?:[ \t]{0,3}>[ \t]?)*/;

// 行内 HTML：只把白名单里、同一行内配成对的标签渲染出来（阅读态 obsmd 同样放行这些）
const INLINE_HTML = new Set(['kbd', 'sup', 'sub', 'u', 'ins', 'del', 's', 'mark', 'small', 'span', 'abbr', 'font', 'b', 'i', 'em', 'strong', 'code']);

const lpRefresh = StateEffect.define();   // 冻结期（组字/按键）结束后补一次重建
const lpFocus = StateEffect.define();     // 编辑器聚焦/失焦

// 装饰对象复用：同 class/style 的 line/mark 装饰全文共用一个实例，省掉每次构建上千次分配
const markCache = new Map(), lineCache = new Map();
function markDeco(cls) {
  let d = markCache.get(cls);
  if (!d) markCache.set(cls, (d = Decoration.mark({ class: cls })));
  return d;
}
function lineDeco(cls, style) {
  const k = cls + '|' + style;
  let d = lineCache.get(k);
  if (!d) {
    if (lineCache.size > 4000) lineCache.clear();
    d = Decoration.line(style ? { class: cls, attributes: { style } } : { class: cls });
    lineCache.set(k, d);
  }
  return d;
}

// 列数（tab 按 4 列对齐，同 CommonMark）
function colAt(text, i) {
  let c = 0;
  for (let k = 0; k < i && k < text.length; k++) c = text[k] === '\t' ? c + 4 - (c % 4) : c + 1;
  return c;
}

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

// 参与揭示判定的选区：没聚焦时什么都不揭示；触屏拖选择柄时（触屏的范围选区）也不揭示——
// 选区每扩进一行，那行的 **/#/[[ ]] 就冒出来、整行重排，文字在柄底下挪位，柄就跟着乱跳
//（手机上「选不顺」的一半原因）。光标（空选区）照旧揭示所在行。
function revealRanges(state, focused) {
  if (!focused) return NO_SEL.ranges;
  const sel = state.selection;
  return !sel.main.empty && lastPointerTouch() ? NO_SEL.ranges : sel.ranges;
}

class Builder {
  constructor(state, opts, tree, focused) {
    this.state = state;
    this.tree = tree;
    this.doc = state.doc;
    this.sel = { ranges: revealRanges(state, focused) };
    this.opts = opts;
    this.ranges = [];
    this.atomic = [];
    this.lineCls = new Map();    // 行首 pos → class 数组（最后每行合成一个 Decoration.line）
    this.lineSty = new Map();    // 行首 pos → style 片段数组（只写 CSS 变量，真正的 padding 交给 class 规则算）
    this.rev = [];               // 揭示索引：[from, to, 模式(0=含端点触碰 1=严格在内)]…，只动光标时据此判断要不要重建
    this.ans = [];               // 与 rev 对应的触碰结果
    this.rawCallouts = [];
    this.pfx = new Map();        // 行首 pos → 隐藏前缀末（光标夹紧用）
    this.blocks = [];            // 被整块替换的可揭示块 [from, to]（上下方向键进块用）
    this.li = new Map();         // 行号 → { d 列表层级, col 正文列, done 已完成任务 }
    this.lm = new Map();         // 行号 → [列表标记…]
    this.code = new Set();       // 代码块里的行号
    this.bq = new Map();         // 行号 → { d 引用层级, li 引用外层的列表层级 }
    this.qEnd = new Map();       // 行号 → 引用前缀末（按语法树里的 QuoteMark 算，不靠正则）
    this.solid = [];             // 常驻渲染、光标进不去的整块（表格/属性面板）[from, to]
    this.html = [];              // 行内 HTML 标签 { from, to, name, close, self, line }
    this.refLabels = null;       // 引用式链接的定义标签（用到时才扫）
  }

  // —— 选区判定（每次调用都记进揭示索引）——
  touches(from, to) {
    let hit = false;
    for (const r of this.sel.ranges) if (r.from <= to && r.to >= from) { hit = true; break; }
    this.rev.push(from, to, 0);
    this.ans.push(hit);
    return hit;
  }
  selInside(from, to) {
    let hit = false;
    for (const r of this.sel.ranges) if (r.from < to && r.to > from) { hit = true; break; }
    this.rev.push(from, to, 1);
    this.ans.push(hit);
    return hit;
  }
  lineTouches(from, to) {
    return this.touches(this.doc.lineAt(from).from, this.doc.lineAt(Math.min(to, this.doc.length)).to);
  }

  // —— 装饰收集 ——
  add(from, to, deco) { if (to > from) this.ranges.push(deco.range(from, to)); }
  hide(from, to) { this.add(from, to, HIDE); }
  mark(from, to, cls, attrs) {
    if (to > from) this.ranges.push((attrs ? Decoration.mark({ class: cls, attributes: attrs }) : markDeco(cls)).range(from, to));
  }
  line(pos, cls) {
    const a = this.lineCls.get(pos);
    if (!a) this.lineCls.set(pos, [cls]);
    else if (!a.includes(cls)) a.push(cls);
  }
  lineStyle(pos, style) {
    const a = this.lineSty.get(pos);
    if (!a) this.lineSty.set(pos, [style]);
    else a.push(style);
  }
  lines(from, to, cls) {
    const lf = this.doc.lineAt(from).number, ll = this.doc.lineAt(Math.min(to, this.doc.length)).number;
    for (let n = lf; n <= ll; n++) this.line(this.doc.line(n).from, cls);
  }
  addBlock(from, to, widget, atomic) {
    const lf = this.doc.lineAt(from), ll = this.doc.lineAt(Math.min(to, this.doc.length));
    const block = lf.from === from && ll.to === to;   // 只有整行块才能用 block widget
    this.add(from, to, Decoration.replace({ widget, block }));
    if (atomic) {
      this.atomic.push(HIDE.range(from, to));
      if (block) this.solid.push([from, to]);
    }
    return block;
  }
  // 行首隐藏前缀（atomic + 光标夹紧）
  prefix(lineFrom, from, to) {
    if (to <= from) return;
    this.atomic.push(HIDE.range(from, to));
    if ((this.pfx.get(lineFrom) ?? -1) < to) this.pfx.set(lineFrom, to);
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
  // 图片：未揭示替换成图；揭示时源码照常显示，图挂在后面（独占一行的挂成块，在源码行下方）
  // alt 可带尺寸（「说明|300」「300x200」，obsmd.splitImgSize）；揭示态的图带缩放把手常显（触屏没有悬停）
  image(from, to, src, alt) {
    const line = this.doc.lineAt(from);
    const alone = line.text.trim() === this.doc.sliceString(from, to);
    const sz = obsmd.splitImgSize(alt);
    if (!this.touches(from, to)) {
      this.add(from, to, Decoration.replace({ widget: new ImageWidget(src, sz.alt, false, sz.w, sz.h) }));
    } else {
      const w = Decoration.widget({ widget: new ImageWidget(src, sz.alt, alone, sz.w, sz.h, true), block: alone, side: 1 });
      this.ranges.push(w.range(alone ? line.to : to));
    }
  }

  run() {
    const fmEnd = frontmatterEnd(this.doc);
    if (fmEnd) {
      // 属性面板常驻（面板自己就能改键名/值/类型）；只有罕见的选区被塞进块内
      //（undo/查找/全选）才退回源码行显示，同表格的口径。
      // 光标严格在块内、或块就是全文末尾而光标贴在末尾边上（那里没有行可放光标，打字会丢）→ 源码行
      if (this.selInside(0, fmEnd) || (fmEnd === this.doc.length && this.touches(fmEnd, fmEnd))) {
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
    this.extendBlankListLines();
    this.emitQuotes();
    this.emitLists();
    this.emitInlineHtml();
    for (const [pos, cls] of this.lineCls) {
      const st = this.lineSty.get(pos);
      this.ranges.push(lineDeco(cls.join(' '), st ? st.join(';') : '').range(pos));
    }
    for (const [pos, st] of this.lineSty) {
      if (!this.lineCls.has(pos)) this.ranges.push(lineDeco('', st.join(';')).range(pos));
    }
    const prefix = [...this.pfx].sort((a, b) => a[0] - b[0]).flat();
    return {
      deco: Decoration.set(this.ranges, true),
      atomic: Decoration.set(this.atomic, true),
      prefix, blocks: this.blocks, solid: this.solid, rev: this.rev, ans: this.ans,
    };
  }

  enter(n) {
    const { doc } = this;
    switch (n.name) {
      // ———— 标题 ————
      case 'ATXHeading1': case 'ATXHeading2': case 'ATXHeading3':
      case 'ATXHeading4': case 'ATXHeading5': case 'ATXHeading6': {
        this.line(doc.lineAt(n.from).from, 'mde-line-h' + n.name.slice(-1));
        const shown = this.lineTouches(n.from, n.to);
        for (const m of n.node.getChildren('HeaderMark')) {
          let f = m.from, t = m.to;
          if (m.from === n.from) { if (doc.sliceString(t, t + 1) === ' ') t++; }
          else if (doc.sliceString(f - 1, f) === ' ') f--;
          if (shown) this.mark(f, t, 'mde-hmark');   // 揭示态的 # 常规字重、淡色，不和标题抢
          else this.hide(f, t);
        }
        return true;
      }
      case 'SetextHeading1': case 'SetextHeading2': {
        const m = n.node.getChild('HeaderMark');
        // 在段落紧下一行敲「-」开列表的过渡态：lezer 会先把它认成 setext 下划线，上一段瞬间变
        // H2。光标就在这根单「-」下划线上时按普通文本显示，等用户敲完空格和内容
        if (m && n.name === 'SetextHeading2' && /^ {0,3}-[ \t]*$/.test(doc.lineAt(m.from).text) &&
            this.touches(doc.lineAt(m.from).from, doc.lineAt(m.from).to)) return true;
        this.line(doc.lineAt(n.from).from, 'mde-line-h' + (n.name.endsWith('1') ? '1' : '2'));
        if (!this.lineTouches(n.from, n.to)) {
          if (m && m.from > n.from) this.hide(m.from - 1, m.to);   // 连换行折掉下划线行
        }
        return true;
      }

      // ———— 行内标记对 ————
      case 'Emphasis': case 'StrongEmphasis': case 'Strikethrough': case 'OmHighlight': {
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

      // ———— 脚注（语法节点在 mdext.js）————
      case 'FootnoteRef': {   // [^id] → 渲染成上标 id
        const raw = doc.sliceString(n.from, n.to);
        if (/^\[\^[^\]]+\]$/.test(raw) && !this.touches(n.from, n.to)) {
          this.hide(n.from, n.from + 2);
          this.mark(n.from + 2, n.to - 1, 'mde-fnref');
          this.hide(n.to - 1, n.to);
        }
        return false;
      }
      case 'FootnoteDef': {   // [^id]: 定义 → 小一号，标签弱化
        const line = doc.lineAt(n.from);
        this.line(line.from, 'mde-line-fn');
        const m = /^\[\^[^\]]+\]:/.exec(doc.sliceString(n.from, line.to));
        if (m) this.mark(n.from, n.from + m[0].length, 'mde-fnlabel');
        return true;
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
        // callout 源码态首行的 [!type]：lezer 当成链接，原样显示并染类型色
        if (this.inRawCallout(n.from) && /^\[![\w-]+\]$/.test(doc.sliceString(n.from, n.to))) {
          this.mark(n.from, n.to, 'mde-co-type');
          return false;
        }
        // 裸的 [文字]、没有定义的引用式链接 [文字][x]，都不是链接：Obsidian 与阅读态都原样显示方括号
        const label = url ? null : n.node.getChild('LinkLabel');
        if (marks.length >= 2 && (url || (label && this.refDefined(doc.sliceString(label.from, label.to))))) {
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
        const url = n.node.getChild('URL');
        const marks = n.node.getChildren('LinkMark');
        const src = url ? doc.sliceString(url.from, url.to) : '';
        const alt = marks.length >= 2 ? doc.sliceString(marks[0].to, marks[1].from) : '';
        this.image(n.from, n.to, this.resolveSrc(src), alt);
        return false;
      }
      case 'Wikilink': case 'WikilinkEmbed': {
        const raw = doc.sliceString(n.from, n.to);
        const m = /^(!?)\[\[([^[\]]+)\]\]$/.exec(raw);
        if (!m) return false;
        let target = m[2], alias = '', head = '';
        const p = target.indexOf('|');
        if (p >= 0) { alias = target.slice(p + 1).trim(); target = target.slice(0, p); }
        const h = target.indexOf('#');
        if (h >= 0) { head = target.slice(h + 1).trim(); target = target.slice(0, h); }
        target = target.trim();
        const embed = !!m[1];
        if (embed && IMG_EXT_RE.test(target)) {
          const sz = obsmd.splitImgSize('x|' + alias);   // 别名＝尺寸 / 说明|尺寸 / 说明
          this.image(n.from, n.to, this.resolveSrc(target), (sz.alt.slice(2) || target) + (sz.w ? '|' + sz.w + (sz.h ? 'x' + sz.h : '') : ''));
        }
        else if (!this.touches(n.from, n.to)) {
          this.add(n.from, n.to, Decoration.replace({ widget: new WikilinkWidget(target, head, alias, embed, this.opts) }));
        }
        return false;
      }
      case 'ObsTag':
        return false;   // 样式走高亮 tag class（mde-t-tag 胶囊），无揭示逻辑
      case 'HTMLTag': {   // 先记下，树走完在 emitInlineHtml 里同一行内配对
        const m = /^<(\/?)([a-zA-Z][\w-]*)[^>]*?(\/?)>$/.exec(doc.sliceString(n.from, n.to));
        if (m && INLINE_HTML.has(m[2].toLowerCase())) {
          this.html.push({ from: n.from, to: n.to, name: m[2].toLowerCase(), close: !!m[1], self: !!m[3], line: doc.lineAt(n.from).number });
        }
        return false;
      }

      // ———— 数学 ————
      case 'InlineMath': {
        if (!this.touches(n.from, n.to)) {
          this.add(n.from, n.to, Decoration.replace({ widget: new MathWidget(doc.sliceString(n.from + 1, n.to - 1), false) }));
        }
        return false;
      }
      case 'BlockMath': {
        const tex = doc.sliceString(n.from, n.to).replace(/^\$\$/, '').replace(/\$\$$/, '');
        if (!this.lineTouches(n.from, n.to)) {
          if (this.addBlock(n.from, n.to, new MathWidget(tex, true, true))) this.blocks.push([n.from, n.to]);
        } else {
          // 源码 + 预览：边改边看渲染结果（MathWidget.eq 只比 tex，没改公式就不重绘）
          this.lines(n.from, n.to, 'mde-line-mathsrc');
          this.line(doc.lineAt(n.from).from, 'mde-line-mathsrc-first');
          this.line(doc.lineAt(Math.min(n.to, doc.length)).from, 'mde-line-mathsrc-last');
          const end = doc.lineAt(Math.min(n.to, doc.length)).to;
          this.ranges.push(Decoration.widget({ widget: new MathWidget(tex, true), block: true, side: 1 }).range(end));
        }
        return false;
      }

      // ———— 引用 / callout ————
      case 'Blockquote': {
        const head = doc.sliceString(n.from, Math.min(n.to, n.from + 120));
        const co = /^>\s*\[!([a-zA-Z-]+)\]/.exec(head);
        if (co) {
          if (!this.lineTouches(n.from, n.to)) {
            if (this.addBlock(n.from, n.to, new CalloutWidget(doc.sliceString(n.from, n.to), this.opts))) this.blocks.push([n.from, n.to]);
            return false;
          }
          // 源码态：外框颜色 = 卡片的类型色，首末行圆角——揭示前后外框重合，只有内容在变
          this.rawCallouts.push([n.from, n.to]);
          const rgb = obsmd.calloutColor?.(co[1]) || '217, 119, 87';
          const lf = doc.lineAt(n.from).number, ll = doc.lineAt(Math.min(n.to, doc.length)).number;
          for (let l = lf; l <= ll; l++) {
            const pos = doc.line(l).from;
            this.line(pos, 'mde-line-callout');
            this.lineStyle(pos, '--co:' + rgb);
          }
          this.line(doc.line(lf).from, 'mde-line-callout-first');
          this.line(doc.line(ll).from, 'mde-line-callout-last');
          return true;
        }
        // 引用层级与「引用外层的列表层级」按行记下，树走完统一出装饰（emitQuotes）
        let d = 1, outerLi = 0;
        for (let p = n.node.parent; p; p = p.parent) {
          if (p.name === 'Blockquote') { d++; outerLi = 0; }
          else if (p.name === 'ListItem') outerLi++;
        }
        const lf = doc.lineAt(n.from).number, ll = doc.lineAt(Math.min(n.to, doc.length)).number;
        for (let l = lf; l <= ll; l++) {
          const cur = this.bq.get(l);
          if (!cur || cur.d < d) this.bq.set(l, { d, li: outerLi });
        }
        return true;
      }
      case 'QuoteMark':
        return false;   // 「>」的隐藏在 emitQuotes 里按行统一做（按语法树取前缀末）；callout 源码态保持可见

      // ———— 列表 / 任务（几何在 emitLists 里按行统一出）————
      case 'ListItem': {
        let d = 0;
        for (let p = n.node; p; p = p.parent) if (p.name === 'ListItem') d++;
        const line = doc.lineAt(n.from);
        const mark = n.node.firstChild;
        let cs = mark && mark.name === 'ListMark' ? mark.to : n.from;
        // 正文列 = 标记后 1–4 列空白之后（≥5 列时只算 1 个空格，其余属于缩进代码）
        let ws = 0;
        while (cs + ws < line.to && /[ \t]/.test(doc.sliceString(cs + ws, cs + ws + 1))) ws++;
        const c0 = colAt(line.text, cs - line.from), c1 = colAt(line.text, cs + ws - line.from);
        const col = ws && c1 - c0 <= 4 ? c1 : c0 + 1;
        const task = mark?.nextSibling?.name === 'Task' ? mark.nextSibling.getChild('TaskMarker') : null;
        const done = !!task && /x/i.test(doc.sliceString(task.from + 1, task.to - 1));
        const ll = doc.lineAt(Math.min(n.to, doc.length)).number;
        for (let l = line.number; l <= ll; l++) {
          const cur = this.li.get(l);
          if (!cur || cur.d < d) this.li.set(l, { d, col, done });
        }
        return true;
      }
      case 'ListMark': {
        const item = n.node.parent, list = item?.parent;
        const ordered = list?.name === 'OrderedList';
        // 圆点形状跟 UA 样式表：ul 外面每多一层列表（ul/ol 都算）换一种——disc / circle / square
        let outer = 0;
        for (let p = list?.parent; p; p = p.parent) if (p.name === 'BulletList' || p.name === 'OrderedList') outer++;
        const tm = n.node.nextSibling?.name === 'Task' ? n.node.nextSibling.getChild('TaskMarker') : null;
        const ln = doc.lineAt(n.from).number;
        const arr = this.lm.get(ln) || [];
        arr.push({
          from: n.from, to: n.to, ordered,
          shape: outer === 0 ? 'disc' : outer === 1 ? 'circle' : 'square',
          task: tm ? { from: tm.from, to: tm.to, checked: /x/i.test(doc.sliceString(tm.from + 1, tm.to - 1)) } : null,
        });
        this.lm.set(ln, arr);
        return false;
      }
      case 'Task':
        return true;
      case 'TaskMarker':
        return false;

      // ———— 代码块 ————
      case 'FencedCode': {
        const lf = doc.lineAt(n.from), ll = doc.lineAt(Math.min(n.to, doc.length));
        const shown = this.lineTouches(n.from, n.to);
        const closed = ll.number > lf.number && /^\s*(`{3,}|~{3,})\s*$/.test(ll.text);
        // 未揭示时收尾围栏连同前面的换行一起折掉（只藏字符会空出一整行，块底比块顶厚一截）
        const fold = !shown && closed;
        const last = fold ? ll.number - 1 : ll.number;
        for (let ln = lf.number; ln <= ll.number; ln++) {
          this.code.add(ln);
          if (ln > last) continue;
          let cls = 'mde-line-code';
          if (ln === lf.number) cls += ' mde-line-code-first';
          if (ln === last) cls += ' mde-line-code-last';
          this.line(doc.line(ln).from, cls);
        }
        if (!shown) {
          const info = n.node.getChild('CodeInfo');
          const lang = info ? doc.sliceString(info.from, info.to).trim() : '';
          const codeFrom = Math.min(lf.to + 1, n.to);
          const codeTo = Math.max(closed ? ll.from - 1 : n.to, codeFrom);   // 未闭合围栏：吃到块尾
          const code = doc.sliceString(codeFrom, codeTo);
          // 围栏行首若还有「- 」「> 」这类前缀（列表项首行就是围栏），留给 emitLists/emitQuotes，别一起吞掉
          const headFrom = /^[ \t]*$/.test(doc.sliceString(lf.from, n.from)) ? lf.from : n.from;
          this.add(headFrom, lf.to, Decoration.replace({ widget: new FenceHeadWidget(lang, () => code) }));
          if (fold) this.hide(ll.from - 1, ll.to);
        }
        return false;
      }
      case 'CodeBlock': {   // 四空格缩进式：也拼成一整块，未揭示时藏起缩进
        const lf = doc.lineAt(n.from), ll = doc.lineAt(Math.min(n.to, doc.length));
        const shown = this.lineTouches(n.from, n.to);
        let inList = false;
        for (let p = n.node.parent; p; p = p.parent) if (p.name === 'ListItem') { inList = true; break; }
        for (let ln = lf.number; ln <= ll.number; ln++) {
          const line = doc.line(ln);
          this.code.add(ln);
          let cls = 'mde-line-code';
          if (ln === lf.number) cls += ' mde-line-code-first';
          if (ln === ll.number) cls += ' mde-line-code-last';
          this.line(line.from, cls);
          if (!shown && !inList) {
            let k = 0;
            while (k < line.length && colAt(line.text, k) < 4 && /[ \t]/.test(line.text[k])) k++;
            this.hide(line.from, line.from + k);
          }
        }
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
        // 罕见（undo/搜索把光标送进来）→ 揭示源码；表格压到文末/就是全文时，光标贴在它的外边上没有行可放，
        // 浏览器会把插入点挪到别处、打的字丢失 → 这时也退回源码
        if (this.selInside(n.from, n.to) ||
            (n.to === doc.length && this.touches(n.to, n.to)) ||
            (n.from === 0 && n.to === doc.length && this.touches(0, 0))) return true;
        this.addBlock(n.from, n.to, new TableWidget(doc.sliceString(n.from, n.to), this.opts), true);
        return false;
      }
    }
    return true;
  }

  // 引用：「>」前缀恒隐藏（atomic + 光标夹紧），竖线按层级画；引用在列表项里时整块右移到正文列
  emitQuotes() {
    const { doc } = this;
    for (const [ln, q] of this.bq) {
      const line = doc.line(ln);
      if (this.inRawCallout(line.from)) continue;
      this.line(line.from, 'mde-line-bq');
      if (q.d > 1) this.line(line.from, 'mde-bq-d' + Math.min(q.d, 4));
      if (q.li) { this.line(line.from, 'mde-in-li'); this.lineStyle(line.from, '--mde-li-out:' + q.li * LI_UNIT + 'px'); }
      // 前缀末按语法树里本行最后一个 QuoteMark 算：引用里代码块的内容行「> > echo」，第二个 > 是代码，
      // 正则分不出来会一起藏掉。正则只当上限（防止吞掉「- > x」这类行首的列表标记）。
      let last = -1;
      this.tree.iterate({
        from: line.from, to: line.to,
        enter: (n) => { if (n.name === 'QuoteMark' && n.from >= line.from && n.to <= line.to && n.to > last) last = n.to; },
      });
      const m = QUOTE_PREFIX_RE.exec(line.text);
      if (last < 0 || !m) continue;
      const end = Math.min(line.from + m[0].length, last + (/[ \t]/.test(doc.sliceString(last, last + 1)) ? 1 : 0));
      this.qEnd.set(ln, end);
      this.hide(line.from, end);
      this.prefix(line.from, line.from, end);
    }
  }

  // 紧跟在列表项后面、缩进够到正文列的纯空白行（Shift+Enter 软换行刚插出来的那种）：语法树把它算空行、
  // 不归列表项，不收编的话光标先停在空格宽度处、打下第一个字才跳到正文列（横跳十几像素）
  extendBlankListLines() {
    const { doc } = this;
    for (const ln of [...this.li.keys()].sort((a, b) => a - b)) {
      const info = this.li.get(ln);
      for (let l = ln + 1; l <= doc.lines; l++) {
        if (this.li.has(l) || this.code.has(l)) break;
        const line = doc.line(l);
        if (this.inRawCallout(line.from) || !/^[ \t]+$/.test(line.text) || colAt(line.text, line.text.length) < info.col) break;
        this.li.set(l, { d: info.d, col: info.col, done: false });
      }
    }
  }

  // 引用式链接 [文字][x] 的 x 有没有定义（[x]: url）；只在遇到这种链接时扫一次全文
  refDefined(label) {
    if (!this.refLabels) {
      this.refLabels = new Set();
      const re = /^ {0,3}(?:>[ \t]?)*[ \t]*\[([^\]]+)\]:/;
      for (const it = this.doc.iterLines(); !it.next().done;) {
        const m = re.exec(it.value);
        if (m) this.refLabels.add(m[1].trim().replace(/\s+/g, ' ').toLowerCase());
      }
    }
    return this.refLabels.has(label.replace(/^\[|\]$/g, '').trim().replace(/\s+/g, ' ').toLowerCase());
  }

  // 行内 HTML：同一行里开闭配对的白名单标签整段换成渲染结果（与阅读态一致），碰到光标就回源码
  emitInlineHtml() {
    const stack = [];
    let curLine = -1;
    for (const t of this.html) {
      if (t.line !== curLine) { stack.length = 0; curLine = t.line; }
      if (t.self) continue;
      if (!t.close) { stack.push(t); continue; }
      let k = stack.length - 1;
      while (k >= 0 && stack[k].name !== t.name) k--;
      if (k < 0) continue;
      const open = stack[k];
      stack.length = k;
      if (stack.length) continue;   // 只替换最外层那一对（里面的嵌套一起交给渲染）
      if (this.touches(open.from, t.to)) continue;
      this.add(open.from, t.to, Decoration.replace({ widget: new InlineHtmlWidget(this.doc.sliceString(open.from, t.to)) }));
    }
  }

  emitLists() {
    const { doc } = this;
    for (const [ln, info] of this.li) {
      const line = doc.line(ln);
      if (this.inRawCallout(line.from)) continue;   // callout 源码态里的列表保持源码
      const q = this.bq.get(ln);
      const qEnd = this.qEnd.get(ln) ?? line.from;
      const outer = q ? q.li : 0;                   // 引用外面那几层列表由引用行的 margin 负责
      const d = Math.max(0, info.d - outer);
      const marks = this.lm.get(ln) || [];
      // 标记后面紧跟空白才渲染成圆点/序号：刚敲下「-」时还是源码，免得「-」「--」「---」一路闪
      const valid = marks.filter((m) => /[ \t]/.test(doc.sliceString(m.to, m.to + 1)));
      if (valid.length) {
        let start = qEnd, end = qEnd;
        const first = valid[0];
        if (!/^[ \t]*$/.test(doc.sliceString(qEnd, first.from))) start = first.from;   // 前面不全是空白：不吞
        let slots = 0;
        for (const m of valid) {
          const from = Math.max(start, end);
          let to = m.to, kind = m.ordered ? 'ol' : 'ul';
          const ws = /^[ \t]{1,4}/.exec(doc.sliceString(m.to, Math.min(line.to, m.to + 5)));
          to = m.to + (ws && ws[0].length <= 4 ? ws[0].length : 1);
          if (m.task && !m.ordered) {
            kind = 'task';
            to = m.task.to + (doc.sliceString(m.task.to, m.task.to + 1) === ' ' ? 1 : 0);
          }
          const text = m.ordered ? doc.sliceString(m.from, m.to) + ' ' : '';
          this.add(from, to, Decoration.replace({ widget: new ListMarkWidget(kind, text, m.shape, !!m.task?.checked) }));
          slots++;
          end = to;
          if (m.task && m.ordered) {   // 有序任务：序号占槽，勾选框跟在正文前
            const bto = m.task.to + (doc.sliceString(m.task.to, m.task.to + 1) === ' ' ? 1 : 0);
            if (m.task.from >= end) {
              this.add(end, bto, Decoration.replace({ widget: new ListMarkWidget('box', '', '', m.task.checked) }));
              end = bto;
            }
          }
        }
        this.prefix(line.from, start, end);
        if (this.code.has(ln)) {
          // 列表项首行就是围栏（「- ```js」）：这一行按代码框的几何走（整框右移到正文列），标记悬挂到框外的槽里
          // 标记槽悬挂到框外：text-indent 往左退「框的边线+内边距 15px + 槽宽」，标记自带 15px 右边距补回来
          this.line(line.from, 'mde-in-li');
          this.line(line.from, 'mde-li-fence');
          this.lineStyle(line.from, `--mde-li-out:${(outer + d) * LI_UNIT}px;--mde-lm-hang:${slots * (LI_UNIT + 15)}px`);
        } else {
          this.line(line.from, 'mde-li');
          this.lineStyle(line.from, `--mde-li-pad:${d * LI_UNIT}px;--mde-li-ind:${-slots * LI_UNIT}px`);
        }
        const t0 = valid[valid.length - 1].task;
        if (t0?.checked && end < line.to) this.mark(end, line.to, 'mde-done');
        continue;
      }
      // 没有（合法）标记：续行，或刚敲下「-」还没空格的新项——按所在项的正文列对齐
      const dd = Math.max(0, d - marks.length);
      const inCode = this.code.has(ln);
      if (inCode) {   // 列表项里的代码块：整块右移到正文列，代码自己的缩进保留
        this.line(line.from, 'mde-in-li');
        this.lineStyle(line.from, '--mde-li-out:' + (outer + dd) * LI_UNIT + 'px');
      } else {
        this.line(line.from, 'mde-li');
        this.line(line.from, 'mde-li-cont');
        this.lineStyle(line.from, `--mde-li-pad:${dd * LI_UNIT}px`);
      }
      // 行首缩进隐去，最多藏到本项正文列（再往后的空白属于内容，比如缩进代码）
      const limit = marks.length ? Infinity : info.col;
      let k = qEnd - line.from;
      const k0 = k;
      while (k < line.length && /[ \t]/.test(line.text[k]) && colAt(line.text, k) < limit) k++;
      if (marks.length) k = Math.min(k, marks[0].from - line.from);
      // 代码块的围栏行已被围栏头/折叠整行替换，只处理中间行
      if (k > k0 && !(inCode && this.isFenceLine(line))) {
        this.hide(line.from + k0, line.from + k);
        this.prefix(line.from, line.from + k0, line.from + k);
      }
      if (info.done && !inCode && line.from + k < line.to) this.mark(line.from + k, line.to, 'mde-done');
    }
  }
  isFenceLine(line) { return /^[ \t]*(`{3,}|~{3,})/.test(line.text); }
}

function build(state, opts, focused) {
  if (state.doc.length > LP_MAX) return { deco: Decoration.none, atomic: Decoration.none, prefix: [], blocks: [], solid: [], rev: [], ans: [], focused };
  // 主动把全文解析拉满（普通笔记几毫秒；超预算退回部分树，后台推进时 update 再补）——
  // 只靠 requestIdleCallback 后台解析，视口外的块（表格/数学/代码）会长期裸奔。
  const tree = ensureSyntaxTree(state, state.doc.length, PARSE_BUDGET) || syntaxTree(state);
  const b = new Builder(state, opts, tree, focused);
  try { return { ...b.run(), focused }; }
  catch (e) {
    console.warn('[mdeditor] live preview build failed', e);
    return { deco: Decoration.none, atomic: Decoration.none, prefix: [], blocks: [], solid: [], rev: [], ans: [], focused };   // 兜底：纯源码显示
  }
}

// 只动光标时：揭示集合没变就沿用上一版装饰
function sameReveal(v, state) {
  const { rev, ans } = v, rs = revealRanges(state, v.focused);
  for (let i = 0, k = 0; i < rev.length; i += 3, k++) {
    const f = rev[i], t = rev[i + 1], strict = rev[i + 2];
    let hit = false;
    for (const r of rs) if (strict ? r.from < t && r.to > f : r.from <= t && r.to >= f) { hit = true; break; }
    if (hit !== ans[k]) return false;
  }
  return true;
}

// 冻结期（组字）里跟着文档变化挪位置，冻结结束再整篇重建
function mapValue(v, changes, focused) {
  const mp = (p) => changes.mapPos(p);
  return {
    ...v, focused,
    deco: v.deco.map(changes), atomic: v.atomic.map(changes),
    prefix: v.prefix.map(mp), blocks: v.blocks.map(([f, t]) => [mp(f), mp(t)]), solid: v.solid.map(([f, t]) => [mp(f), mp(t)]),
    stale: true,
  };
}

// 光标所在前缀区间：prefix 是按行首排好序的 [行首, 前缀末, …]
function findPrefix(pf, pos) {
  let lo = 0, hi = pf.length / 2 - 1, k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (pf[mid * 2] <= pos) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return k >= 0 && pos < pf[k * 2 + 1] ? k * 2 : -1;
}

// 行内被整段隐藏的标记（HIDE）挤在行首/行尾时，点击坐标会被算进隐藏区间的错误一侧：点行尾右侧空白，
// 光标落在收尾的 ** / ` / ](url) 前面，一揭示就成了在粗体/代码/链接里面打字。snap：从 p 起的隐藏串一路
// 盖到行尾 → 行尾；行首的隐藏串盖住了 p → 串末（正文起点）。其余原样。
function hiddenRuns(deco, line) {
  const runs = [];
  deco.between(line.from, line.to, (f, t, val) => { if (val === HIDE && t > f) runs.push([f, t]); });
  runs.sort((a, b) => a[0] - b[0]);
  return runs;
}
function snapHidden(deco, doc, p) {
  const line = doc.lineAt(p);
  const runs = hiddenRuns(deco, line);
  if (!runs.length) return p;
  let q = p;
  for (const [f, t] of runs) if (f <= q && t > q) q = t;
  if (q !== p && q >= line.to) return line.to;
  let lead = line.from;
  for (const [f, t] of runs) { if (f <= lead && t > lead) lead = t; else if (f > lead) break; }
  if (lead > line.from && p < lead) return lead;
  if (q === line.to && p < q) return line.to;
  return p;
}
function allHidden(deco, doc, from, to) {
  const runs = hiddenRuns(deco, doc.lineAt(from));
  let q = from;
  for (const [f, t] of runs) if (f <= q && t > q) q = t;
  return q >= to;
}

export function livePreview(opts) {
  // 每个编辑器（每次 setMode('live')）一份：组字 / 鼠标按下状态
  const ctl = { composing: false, down: false, t: 0 };

  const field = StateField.define({
    create: (state) => build(state, opts, false),
    update(v, tr) {
      let focused = v.focused, refresh = false;
      for (const e of tr.effects) {
        if (e.is(lpFocus)) focused = e.value;
        else if (e.is(lpRefresh)) refresh = true;
      }
      // 组字中：只 map，不重建（重建会改写正在组字的 DOM，CM 回读时算错差异吞字）。这道闸必须排在
      // refresh 之前：抬手定时器发来的 refresh 若落在组字中途，整篇重建会把「## 」这类揭示改写进
      // 组字节点旁边，拼音字母漏进正文、标题被写坏
      if (ctl.composing || tr.isUserEvent('input.type.compose')) {
        if (tr.docChanged) return mapValue(v, tr.changes, focused);
        return refresh || focused !== v.focused || tr.state.readOnly !== tr.startState.readOnly ? { ...v, focused, stale: true } : v;
      }
      // 只读开关也要重建：属性面板按可写与否给不同控件
      if (refresh || tr.state.readOnly !== tr.startState.readOnly) return build(tr.state, opts, focused);
      if (tr.docChanged || syntaxTree(tr.state) !== syntaxTree(tr.startState)) return build(tr.state, opts, focused);
      // 鼠标按着/刚抬起：选区与聚焦变化都先记下，抬手 280ms 后 refresh 统一重建
      //（点进未聚焦的编辑器时，聚焦那一下也不能立刻揭示，否则双击第二下落点就偏了）
      if (ctl.down || ctl.t) return tr.selection || focused !== v.focused ? { ...v, focused, stale: true } : v;
      if (v.stale || focused !== v.focused) return build(tr.state, opts, focused);
      if (tr.selection) return sameReveal(v, tr.state) ? v : build(tr.state, opts, focused);
      return v;
    },
    provide: (f) => [
      EditorView.decorations.from(f, (v) => v.deco),
      EditorView.atomicRanges.of((view) => view.state.field(f, false)?.atomic || Decoration.none),
    ],
  });

  const refresh = (view) => {
    if (ctl.composing || view.composing || view.compositionStarted) return;   // 组字中不重建；compositionend 那一路会补
    try {
      if (!view.dom.isConnected) return;
      view.dispatch({ effects: lpRefresh.of(null) });
      // Chrome：揭示重建把非空选区锚点那一侧的 DOM（隐藏标记 → 源码文字）换掉后，getSelection() 报的和
      // Chrome 实际持有、打字时替换的选区会分叉（CM 只跟踪焦点那一侧）——双击「**注意**：」的「：」再打字，
      // 「注意」被一起删掉。按状态显式重写一次 DOM 选区。触屏不写：一写安卓就收起选择柄。
      const m = view.state.selection.main;
      if (!m.empty && view.hasFocus && !lastPointerTouch()) {
        const a = view.domAtPos(m.anchor), h = view.domAtPos(m.head);
        document.getSelection()?.setBaseAndExtent(a.node, a.offset, h.node, h.offset);
      }
    } catch {}
  };
  // 结束鼠标冻结并立刻按当前光标揭示（键盘一动就不再是双击/拖选，揭示要先于这次按键落地）
  const unfreeze = (view) => {
    if (!ctl.down && !ctl.t) return;
    clearTimeout(ctl.t); ctl.t = 0; ctl.down = false;
    refresh(view);
  };

  // 光标夹紧：空光标落进隐藏前缀（列表标记 / 引用「>」/ 续行缩进）→ 挪到前缀末；从前缀末往左的
  // 键盘移动则跳到上一行行尾。只管纯选区事务（改文档的事务照旧），非空选区不夹（Shift+Home 能选中前缀）。
  const clamp = EditorState.transactionFilter.of((tr) => {
    if (!tr.selection || tr.docChanged) return tr;
    const val = tr.startState.field(field, false);
    if (!val) return tr;
    const { doc } = tr.startState;
    const pf = val.prefix;
    const pointer = tr.isUserEvent('select.pointer');
    // 「从正文起点往左跳上一行」只给方向键：鼠标点击不算；smart Home（keys.js，userEvent select.home）
    // 第二下会去行首，那也不能被当成左移送到上一行——LP 里 Home 恒停在正文起点
    const keyMove = tr.isUserEvent('select') && !tr.isUserEvent('select.pointer') && !tr.isUserEvent('select.home');
    const old = tr.startState.selection.main.head;
    let changed = false;
    const ranges = tr.selection.ranges.map((r) => {
      if (!r.empty) {
        // 指针产生、且整段落在同一隐藏前缀里（双击圆点/序号）或整段都是隐藏标记的选区：折成正文起点的光标。
        // 否则打字会把看不见的「- 」「2. 」整个换掉。跨出前缀的选区（三击整行、拖选）照旧。
        if (!pointer) {
          // 键盘扩选的活动端严格落在隐藏前缀中间（「-   foo」这类多空白标记里）：挪到前缀末，免得删掉半个标记
          const kh = findPrefix(pf, r.head);
          if (keyMove && kh >= 0 && r.head > pf[kh]) { changed = true; return EditorSelection.range(r.anchor, pf[kh + 1]); }
          return r;
        }
        const k = findPrefix(pf, r.from);
        if (k >= 0 && r.to <= pf[k + 1]) { changed = true; return EditorSelection.cursor(pf[k + 1]); }
        if (allHidden(val.deco, doc, r.from, r.to) && doc.lineAt(r.from).number === doc.lineAt(r.to).number) {
          changed = true; return EditorSelection.cursor(snapHidden(val.deco, doc, r.from));
        }
        return r;
      }
      let p = r.head;
      // 文首是表格/属性面板这种光标进不去的整块：光标贴在块的外边上没有行可放，挪到块后第一行
      const s0 = val.solid.find((b) => b[0] === 0);
      if (p === 0 && s0 && s0[1] < doc.length) p = s0[1] + 1;
      // 点击/键盘落进行首或行尾的隐藏标记串 → 挪到可见一侧（程序设的位置不动）
      if (pointer || keyMove) p = snapHidden(val.deco, doc, p);
      const k = findPrefix(pf, p);
      if (k >= 0) {
        const f = pf[k], e = pf[k + 1];
        p = keyMove && old === e && p < e && f > 0 && !tr.isUserEvent('select.home') && p === r.head ? f - 1 : e;
      }
      if (p === r.head) return r;
      changed = true;
      return EditorSelection.cursor(p, p === doc.lineAt(p).to ? -1 : 1, undefined, r.goalColumn);
    });
    return changed ? [tr, { selection: EditorSelection.create(ranges, tr.selection.mainIndex), sequential: true }] : tr;
  });

  // 上下方向键进块：callout / 块数学是整块替换的 widget，默认会被一步越过、键盘进不去源码
  const vert = (forward) => (view) => {
    const { state } = view, r = state.selection.main;
    const blocks = state.field(field, false)?.blocks;
    if (!r.empty || !blocks?.length) return false;
    const line = state.doc.lineAt(r.head);
    const target = view.moveVertically(r, forward).head;
    if (forward) {
      if (line.to >= state.doc.length) return false;
      const b = blocks.find((x) => x[0] === line.to + 1);
      if (!b || target <= line.to) return false;   // 还在本行（折行的下一视觉行）就交给默认
      view.dispatch({ selection: { anchor: b[0] }, scrollIntoView: true, userEvent: 'select' });
    } else {
      if (line.from === 0) return false;
      const b = blocks.find((x) => x[1] === line.from - 1);
      if (!b || target >= line.from) return false;
      view.dispatch({ selection: { anchor: b[1] }, scrollIntoView: true, userEvent: 'select' });
    }
    return true;
  };

  const handlers = EditorView.domEventHandlers({
    compositionstart(e, view) {
      unfreeze(view);   // 冻结期里直接开始组字（点完马上打拼音）：先揭示，再进组字闸
      ctl.composing = true;
      return false;
    },
    compositionend(e, view) {
      ctl.composing = false;
      // 排在 CM 自己 compositionend 里的 flush（Promise.resolve().then）之后；
      // 不用 setTimeout：后台页的定时器会被冻结
      Promise.resolve().then(() => Promise.resolve()).then(() => { if (!view.composing) refresh(view); });
      return false;
    },
    mousedown(e, view) {
      if (e.button !== 0) return false;
      ctl.down = true;
      clearTimeout(ctl.t); ctl.t = 0;
      // 原生拖放会吞掉 mouseup：dragend/drop 也算抬手，否则冻结一直挂到下一次点击
      const up = () => {
        document.removeEventListener('mouseup', up, true);
        document.removeEventListener('dragend', up, true);
        document.removeEventListener('drop', up, true);
        ctl.down = false;
        clearTimeout(ctl.t);
        ctl.t = setTimeout(() => { ctl.t = 0; refresh(view); }, 280);   // 盖过双击间隔；组字中 refresh 自己会跳过
      };
      document.addEventListener('mouseup', up, true);
      document.addEventListener('dragend', up, true);
      document.addEventListener('drop', up, true);
      return false;
    },
    // 链接点按：触屏直接开，桌面 Ctrl/Cmd+点（普通点=置光标揭示源码）
    click(e, view) {
      const a = e.target && e.target.closest ? e.target.closest('.mde-link') : null;
      if (!a) return false;
      const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
      if (!coarse && !e.ctrlKey && !e.metaKey) return false;
      const href = a.getAttribute('data-href') || a.textContent || '';
      if (!href) return false;
      e.preventDefault();
      if (/^(https?:|mailto:|tel:)/i.test(href)) opts.openLink?.(href);
      else opts.openRel?.(href);
      return true;
    },
  });

  // 键盘一按就结束鼠标冻结（observer 先于所有 keymap 运行；方向键被 keymap 处理后就到不了普通 handler）。
  // 真输入法在 compositionstart 前会先发 keyCode 229 的 keydown，点完马上打拼音也会在组字开始前揭示好。
  const keyObserver = EditorView.domEventObservers({
    keydown(e, view) {
      if (!ctl.down && !ctl.t) return;
      if (ctl.composing || view.compositionStarted || e.isComposing) return;
      if (/^(Shift|Control|Alt|Meta)$/.test(e.key)) return;   // Shift/Ctrl+点击扩选不解冻
      unfreeze(view);
    },
  });

  // 改文档的事务（拆项回车、退格、撤销、命令）把光标送进了隐藏前缀：state 与 DOM 光标就对不上
  //（DOM 只能画在前缀末），接着组字会漏字母。更新后发现就补一笔把光标挪到前缀末（更新中不能 dispatch）。
  const settleCaret = EditorView.updateListener.of((u) => {
    if (!u.docChanged || ctl.composing || u.view.composing) return;
    const pf = u.state.field(field, false)?.prefix;
    const m = u.state.selection.main;
    if (!pf?.length || !m.empty || u.state.selection.ranges.length > 1) return;
    const k = findPrefix(pf, m.head);
    if (k < 0) return;
    const e = pf[k + 1], view = u.view;
    queueMicrotask(() => {
      try {
        const cur = view.state.selection.main;
        if (cur.empty && cur.head === m.head && view.state.doc === u.state.doc) view.dispatch({ selection: { anchor: e } });
      } catch {}
    });
  });

  return [
    field,
    clamp,
    handlers,
    keyObserver,
    settleCaret,
    EditorView.focusChangeEffect.of((state, focusing) => lpFocus.of(focusing)),
    Prec.high(keymap.of([
      { key: 'ArrowDown', run: vert(true) },
      { key: 'ArrowUp', run: vert(false) },
    ])),
  ];
}
