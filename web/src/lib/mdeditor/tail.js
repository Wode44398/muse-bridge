// 文末尾栏 —— 把 DocViewer 那块「反向链接 / 出链 / 词数」收编成文档末尾的块 widget，
// 让编辑态底部和阅读态长得一模一样：**同一份 DOM 节点**在两边轮流被收编，不重复实现第二份
//（数据/样式/点击全是 Svelte 那边的，这里只负责挂到文末 + 高度变了让 CM 重新量）。
// 节点归 DocViewer 所有：它在模式分支之外常驻，故切模式时不会被 Svelte 抢在编辑器销毁前摘走。
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { StateField } from '@codemirror/state';

class TailWidget extends WidgetType {
  constructor(get) { super(); this.get = get; }
  eq(o) { return o.get === this.get; }
  toDOM(view) {
    const el = this.get?.();
    if (!el) return document.createElement('span');
    el.hidden = false;
    if (!el.__mdeRo && typeof ResizeObserver !== 'undefined') {
      el.__mdeRo = new ResizeObserver(() => view.requestMeasure());   // 反链是异步到的，高度会变
      el.__mdeRo.observe(el);
    }
    return el;
  }
  // 只断观察者，不动 hidden——widget 换位重建时 destroy 可能晚于新 toDOM，改 hidden 会把活的尾栏藏掉
  destroy(dom) { if (dom.__mdeRo) { dom.__mdeRo.disconnect(); delete dom.__mdeRo; } }
  get estimatedHeight() { return 140; }
}

export function docTail(opts) {
  if (!opts?.tailEl) return [];
  const widget = new TailWidget(opts.tailEl);
  const make = (state) => Decoration.set([Decoration.widget({ widget, block: true, side: 1 }).range(state.doc.length)]);
  return StateField.define({
    create: make,
    update(v, tr) {
      if (!tr.docChanged) return v;
      const mapped = v.map(tr.changes);          // side:1 → 文末插入后仍贴在末尾，不必重建（免每击键搬 DOM）
      let pos = -1;
      mapped.between(0, tr.state.doc.length, (from) => { pos = from; });
      return pos === tr.state.doc.length ? mapped : make(tr.state);
    },
    provide: (f) => EditorView.decorations.from(f),
  });
}
