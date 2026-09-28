// Obsidian 语法的 lezer-markdown 解析扩展 —— Live Preview 编辑器（mdeditor）专用。
// 与 obsmd.js（阅读模式的 Marked 渲染）语义对齐：==高亮== / [[双链]] / ![[嵌入]] /
// #标签 / $行内数学$ / $$块数学$$ / %%注释%%。frontmatter 不在这里解析（无法回溯，
// 见 livePreview.js 的 frontmatterEnd 正则方案）。
import { Tag, tags as t } from '@lezer/highlight';

// 自定义高亮 tag：源码模式配色靠它们（theme.js 里映射成 class）
export const omTags = {
  highlight: Tag.define(),
  wikilink: Tag.define(),
  tag: Tag.define(),
  math: Tag.define(),
};

// 与 @lezer/markdown 内部一致的标点判定（strikethrough flanking 规则同款）
let Punctuation = /[!-/:-@\[-`{-~\xA1‐-‧]/;
try { Punctuation = new RegExp('[\\p{Pc}|\\p{Pd}|\\p{Pe}|\\p{Pf}|\\p{Pi}|\\p{Po}|\\p{Ps}]', 'u'); } catch {}

// —— ==高亮==（delimiter 机制，抄 Strikethrough 的 flanking 语义）——
const HighlightDelim = { resolve: 'OmHighlight', mark: 'OmHighlightMark' };
const OmHighlight = {
  defineNodes: [
    { name: 'OmHighlight', style: { 'OmHighlight/...': omTags.highlight } },
    { name: 'OmHighlightMark', style: t.processingInstruction },
  ],
  parseInline: [{
    name: 'OmHighlight',
    parse(cx, next, pos) {
      if (next != 61 /* '=' */ || cx.char(pos + 1) != 61 || cx.char(pos + 2) == 61) return -1;
      const before = cx.slice(pos - 1, pos), after = cx.slice(pos + 2, pos + 3);
      const sBefore = /\s|^$/.test(before), sAfter = /\s|^$/.test(after);
      const pBefore = Punctuation.test(before), pAfter = Punctuation.test(after);
      return cx.addDelimiter(HighlightDelim, pos, pos + 2,
        !sAfter && (!pAfter || sBefore || pBefore),
        !sBefore && (!pBefore || sAfter || pAfter));
    },
    after: 'Emphasis',
  }],
};

// —— [[双链]] / ![[嵌入]]（单行内闭合，不允许嵌套方括号）——
const Wikilink = {
  defineNodes: [
    { name: 'Wikilink', style: omTags.wikilink },
    { name: 'WikilinkEmbed', style: omTags.wikilink },
  ],
  parseInline: [{
    name: 'Wikilink',
    before: 'Link',
    parse(cx, next, pos) {
      if (next != 33 /* '!' */ && next != 91 /* '[' */) return -1;
      const embed = next == 33;
      const b = embed ? pos + 1 : pos;
      if (cx.char(b) != 91 || cx.char(b + 1) != 91) return -1;
      for (let i = b + 2; i < cx.end - 1; i++) {
        const ch = cx.char(i);
        if (ch == 10 || ch == 91) return -1;
        if (ch == 93 /* ']' */) {
          if (cx.char(i + 1) == 93 && i > b + 2) {
            return cx.addElement(cx.elt(embed ? 'WikilinkEmbed' : 'Wikilink', pos, i + 2));
          }
          return -1;
        }
      }
      return -1;
    },
  }],
};

// —— #标签：前缀须行首/空白/开括号类；字符集与 obsmd.obsTag 一致；纯数字不算 ——
const TAG_CHAR = /[\w/-]|[À-ɏ぀-ヿ㐀-䶿一-鿿가-힯]/;
const ObsTag = {
  defineNodes: [{ name: 'ObsTag', style: omTags.tag }],
  parseInline: [{
    name: 'ObsTag',
    parse(cx, next, pos) {
      if (next != 35 /* '#' */) return -1;
      const prev = pos > cx.offset ? cx.slice(pos - 1, pos) : '';
      if (prev && !/[\s(（【"'>《，。；：、]/.test(prev)) return -1;
      let i = pos + 1;
      while (i < cx.end && TAG_CHAR.test(cx.slice(i, i + 1))) i++;
      const txt = cx.slice(pos + 1, i);
      if (!txt || !/[^\d/_-]/.test(txt)) return -1;
      return cx.addElement(cx.elt('ObsTag', pos, i));
    },
  }],
};

// —— $行内数学$：开 $ 后非空白、闭 $ 前非空白、同行闭合；\$ 转义跳过；
//    闭 $ 后紧跟数字不算（保护 "$5 and $6" 这类货币文本）——
const InlineMath = {
  defineNodes: [{ name: 'InlineMath', style: omTags.math }],
  parseInline: [{
    name: 'InlineMath',
    parse(cx, next, pos) {
      if (next != 36 /* '$' */ || cx.char(pos + 1) == 36) return -1;
      const prev = pos > cx.offset ? cx.char(pos - 1) : -1;
      if (prev == 36 || prev == 92) return -1;
      const first = cx.char(pos + 1);
      if (first == 32 || first == 9) return -1;
      for (let i = pos + 2; i < cx.end; i++) {
        const ch = cx.char(i);
        if (ch == 10) return -1;
        if (ch == 36 && cx.char(i - 1) != 92) {
          const pv = cx.char(i - 1);
          if (pv == 32 || pv == 9) return -1;
          const nx = i + 1 < cx.end ? cx.char(i + 1) : -1;
          if (nx >= 48 && nx <= 57) return -1;
          return cx.addElement(cx.elt('InlineMath', pos, i + 1));
        }
      }
      return -1;
    },
  }],
};

// —— $$块数学$$：行首（含引用/列表内缩进后）$$ 起，行尾 $$ 收；未闭合吃到文末 ——
const BlockMath = {
  defineNodes: [{ name: 'BlockMath', block: true, style: omTags.math }],
  parseBlock: [{
    name: 'BlockMath',
    parse(cx, line) {
      if (line.next != 36 /* '$' */ || line.text.charCodeAt(line.pos + 1) != 36) return false;
      const from = cx.lineStart + line.pos;
      const tail = line.text.slice(line.pos + 2);
      const single = /\$\$\s*$/.exec(tail);
      if (single && tail.trim().length > 2) {   // 单行 $$…$$（tail 至少「x$$」）
        cx.addElement(cx.elt('BlockMath', from, cx.lineStart + line.pos + 2 + single.index + 2));
        cx.nextLine();
        return true;
      }
      let to = cx.lineStart + line.text.length;
      while (cx.nextLine()) {
        to = cx.lineStart + line.text.length;   // 兜底：未闭合吃到当前行尾
        const m = /\$\$\s*$/.exec(line.text);
        if (m && m.index >= line.pos) { to = cx.lineStart + m.index + 2; cx.nextLine(); break; }
      }
      cx.addElement(cx.elt('BlockMath', from, to));
      return true;
    },
    endLeaf(cx, line) { return line.next == 36 && line.text.charCodeAt(line.pos + 1) == 36; },
  }],
};

// —— %%注释%%（行内，段内闭合；Live Preview 里隐藏）——
const ObsComment = {
  defineNodes: [{ name: 'ObsComment', style: t.comment }],
  parseInline: [{
    name: 'ObsComment',
    parse(cx, next, pos) {
      if (next != 37 /* '%' */ || cx.char(pos + 1) != 37) return -1;
      for (let i = pos + 2; i < cx.end - 1; i++) {
        if (cx.char(i) == 37 && cx.char(i + 1) == 37) return cx.addElement(cx.elt('ObsComment', pos, i + 2));
      }
      return -1;
    },
  }],
};

export const omExtensions = [OmHighlight, Wikilink, ObsTag, InlineMath, BlockMath, ObsComment];
