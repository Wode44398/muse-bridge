// touchGuard.js —— 编辑器（CM6）的触屏选区护栏。原理与阅读态同一套（见 lib/touchSelection.js 开头）：
// 安卓每次起拖选择柄都按另一个柄的屏幕坐标重新命中固定端，固定端滚出可视区后会被命中到
// 离谱的位置。编辑器里 Chrome 会把命中点改投进可编辑根内部，所以不会跨进聊天，但 CM 虚拟
// 视口外的行只是占位块，命中照样跑偏——实测起点滚出 ~380px 后再拖，anchor 从 1089 被甩到
// 2178（跑到结束端后面），选区瞬间缩成一小段，就是「选着选着突然没了」。
// CM 的 DOM 会随视口重建，DOM 层按节点记账靠不住，这里在状态层按文档位置拦。
import { EditorState, EditorSelection } from '@codemirror/state';
import { ViewPlugin } from '@codemirror/view';
import { browserDrivenSelection, recentSelectAll, lastPointerTouch, onNativeDragEnd, afterFrame } from '../touchSelection.js';

const FAR = 40;    // head 也挪了时，anchor 至少跳这么远才认作误命中
const EDGE = 48;   // 活动端离可视范围多远算「出界」

function offscreen(view, pos) {
  let c = null;
  try { c = view.coordsAtPos(pos); } catch {}
  if (!c) return true;   // 不在渲染视口内＝离屏很远
  const r = view.scrollDOM.getBoundingClientRect();
  const vv = window.visualViewport;
  const bottom = Math.min(r.bottom, vv ? vv.offsetTop + vv.height : innerHeight);
  return c.bottom < r.top - EDGE || c.top > bottom + EDGE;
}

// 规则同阅读态：①固定端跳变 → 改回；③活动端落到可视范围外 → 这一步不认。
// 只管「浏览器自己在动」的 select 事务（拖柄 / 系统浮条），塌缩（复制后系统会塌成光标）一律放行。
// 纠正同样要晚一拍（见 touchSelection.js 的 schedule）：发现后先放行，等浏览器再推进两步且这一帧
// 画完、或拖柄松手时再改——状态一改 CM 就会去写 DOM 选区，太早写会掐断正在进行的拖动。
const FIX_AFTER_MOVES = 2;

function judge(o, n, view) {
  let anchor = n.anchor, head = n.head;
  if (anchor !== o.anchor && anchor !== o.head) {
    if (head === o.head) anchor = o.anchor;
    else if (head === o.anchor) anchor = o.head;
    else if (Math.min(Math.abs(anchor - o.anchor), Math.abs(anchor - o.head)) > FAR) {
      anchor = Math.abs(head - o.anchor) > Math.abs(head - o.head) ? o.anchor : o.head;   // 离活动端远的那头是固定端
    } else return null;
  }
  const moving = anchor === o.anchor ? o.head : o.anchor;
  if (view && head !== moving && head !== anchor && offscreen(view, head)) head = moving;
  if ((anchor === n.anchor && head === n.head) || anchor === head) return null;
  return { anchor, head, headFixed: head !== n.head };
}

export function touchSelectGuard() {
  let view = null;
  let pend = null;   // { anchor, fallbackHead|null, moves, queued }：已认出的纠正，等时机落地
  let self = false;
  // 落地时再看一眼活动端：③（活动端出界）只在它此刻仍在界外时才拉回
  const target = (pd, head) => ({ anchor: pd.anchor, head: pd.fallbackHead != null && view && offscreen(view, head) ? pd.fallbackHead : head });
  const settle = () => {
    const pd = pend;
    pend = null;
    if (!view || !pd) return;
    const m = view.state.selection.main;
    if (m.empty) return;
    const t = target(pd, m.head);
    if (t.anchor === t.head || (t.anchor === m.anchor && t.head === m.head)) return;
    self = true;   // 自己发的纠正别再过一遍过滤器（在它看来这正是一次「起点跳变」）
    try { view.dispatch({ selection: EditorSelection.single(t.anchor, t.head), userEvent: 'select' }); } finally { self = false; }
  };
  const filter = EditorState.transactionFilter.of((tr) => {
    if (!tr.selection || self) return tr;
    if (tr.docChanged || !tr.isUserEvent('select') || !browserDrivenSelection() || recentSelectAll()) { pend = null; return tr; }
    const o = tr.startState.selection.main, n = tr.newSelection.main;
    if (n.empty || tr.newSelection.ranges.length > 1) { pend = null; return tr; }
    if (pend) {
      if (++pend.moves >= FIX_AFTER_MOVES && !pend.queued) { pend.queued = true; afterFrame(settle); }
      return tr;
    }
    if (o.empty) return tr;
    const fix = judge(o, n, view);
    if (fix) pend = { anchor: fix.anchor, fallbackHead: fix.headFixed ? fix.head : null, moves: 0, queued: false };
    return tr;
  });
  // 拖柄松手时收尾（没等到两步推进就松手的那种）；编辑器销毁时注销
  const plugin = ViewPlugin.fromClass(class {
    constructor(v) { view = v; this.off = onNativeDragEnd(settle); }
    destroy() { this.off(); if (view) view = null; pend = null; }
  });
  return [filter, plugin];
}

// 触屏：别让 CM 去重写系统正在维护的选区。安卓 Chrome 一见脚本写选区就收起选择柄和系统浮条，
// 手上的选区就再也拖不动了。CM 有两种时候会写：
//   ① 重排选区附近（或视口外补画）DOM 后置 forceSelection，下一次 updateSelection 不管对不对都
//      collapse+extend 重写（防 Chrome 显示与上报不一致，CM #54/#218）——实测进编辑态后第一次
//      长按必中：字选中了，柄却没了。DOM 选区与状态逐位一致时撤掉这次强制。
//   ② 长选区滚着滚着，固定端所在行掉出 CM 的渲染视口（虚拟滚动只画可视区上下一段），DOM 里
//      那一端只能落在视口边上近似表示，CM 每次更新都想「纠正」它——一纠正柄就没了。此时活动端
//      与状态一致就不写：DOM 的近似端点由 touchSelectGuard 在状态层兜住；复制/剪切走 CM 自己的
//      copy 处理，按状态取全文，不受 DOM 近似影响。
// 只对触屏非空选区；docView 是 CM 内部件，拿不到就原样不动。
export function keepNativeTouchSelection(view) {
  const dv = view.docView;
  if (!dv || typeof dv.updateSelection !== 'function' || !('forceSelection' in dv)) return;
  const orig = dv.updateSelection;
  dv.updateSelection = function (...args) {
    if (lastPointerTouch()) {
      try {
        const m = view.state.selection.main;
        const s = document.getSelection();
        const c = view.contentDOM;
        const fpos = !m.empty && s && s.rangeCount && c.contains(s.anchorNode) && c.contains(s.focusNode) ? view.posAtDOM(s.focusNode, s.focusOffset) : -1;
        if (fpos >= 0 && Math.abs(fpos - m.head) <= 1) {
          const vp = view.viewport;
          // 视口重画时 DOM 活动端可能被挪到相邻位置（行尾↔下一行首，差一个换行），这点误差不值得收起选择柄
          if (m.anchor < vp.from || m.anchor > vp.to) {
            this.forceSelection = false;
            // 不写，但要把现在的 DOM 选区登记成 CM「已知」的——它记的旧端点所在行已被虚拟滚动删掉，
            // 不登记的话 CM 的 copy 处理器判「选区不在编辑器里」直接放手，系统就只复制 DOM 里近似的那一截。
            view.observer?.setSelectionRange?.({ node: s.anchorNode, offset: s.anchorOffset }, { node: s.focusNode, offset: s.focusOffset });
            return;
          }
          if (this.forceSelection && fpos === m.head && view.posAtDOM(s.anchorNode, s.anchorOffset) === m.anchor) this.forceSelection = false;
        }
      } catch {}
    }
    return orig.apply(this, args);
  };
}
