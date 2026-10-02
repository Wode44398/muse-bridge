// 语法高亮 tag → class 映射（配色在 editor.css）。Live Preview 与源码模式共用：
// LP 里被揭示的源码片段、源码模式全文，都靠这套 class 上色/定型。
import { HighlightStyle } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { omTags } from './mdext.js';

export const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, class: 'mde-t-h mde-t-h1' },
  { tag: t.heading2, class: 'mde-t-h mde-t-h2' },
  { tag: t.heading3, class: 'mde-t-h mde-t-h3' },
  { tag: t.heading4, class: 'mde-t-h mde-t-h4' },
  { tag: t.heading5, class: 'mde-t-h mde-t-h5' },
  { tag: t.heading6, class: 'mde-t-h mde-t-h6' },
  { tag: t.strong, class: 'mde-t-strong' },
  { tag: t.emphasis, class: 'mde-t-em' },
  { tag: t.strikethrough, class: 'mde-t-strike' },
  { tag: t.monospace, class: 'mde-t-code' },
  { tag: t.url, class: 'mde-t-url' },
  { tag: t.link, class: 'mde-t-url' },
  { tag: t.quote, class: 'mde-t-quote' },
  { tag: t.contentSeparator, class: 'mde-t-hr' },
  { tag: t.processingInstruction, class: 'mde-t-fmt' },   // 各类定界符 ** == ~~ ` # > -
  { tag: t.meta, class: 'mde-t-fmt' },
  { tag: t.comment, class: 'mde-t-cmt' },
  { tag: omTags.highlight, class: 'mde-t-mark' },
  { tag: omTags.wikilink, class: 'mde-t-wk' },
  { tag: omTags.tag, class: 'mde-t-tag' },
  { tag: omTags.math, class: 'mde-t-math' },
  { tag: omTags.footnote, class: 'mde-t-fn' },
  // 代码块内嵌语言的基础配色
  { tag: t.keyword, class: 'mde-c-kw' },
  { tag: t.string, class: 'mde-c-str' },
  { tag: [t.number, t.bool, t.atom, t.null], class: 'mde-c-num' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'mde-c-fn' },
  { tag: [t.typeName, t.className, t.namespace], class: 'mde-c-type' },
  { tag: [t.propertyName, t.attributeName], class: 'mde-c-prop' },
  { tag: [t.operator, t.punctuation, t.bracket], class: 'mde-c-op' },
  { tag: [t.regexp, t.escape, t.special(t.string)], class: 'mde-c-re' },
  { tag: t.definition(t.variableName), class: 'mde-c-def' },
]);
