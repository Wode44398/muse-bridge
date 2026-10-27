// 流式「吐字渐入」——复刻 gemini-clone 的尾部逐字淡入（.fade-chunk）。
//
// 难点：真实 SSE 流式下，每个 delta 都会全量重渲染 markdown（{@html renderMarkdown(m.md)}），
// 整棵子树被替换。若给每个字都挂 opacity 动画，会每帧重放、整段闪烁。
//
// 做法：本 action 挂在流式消息的 .g-md 上。每次内容变化后用 rAF（赶在 paint 前执行，避免新尾巴
// 以实体先亮一帧再变透明）把「相较上一帧新增的可见尾部文本」包进 .g-in span 做 opacity 0→1；
// 已渲染过的正文保持纯文本（重渲染出来长得一模一样、无动画→无闪烁）。于是只有写头处的新字在渐入。
//   · shown = 已按「实体」处理过的可见字符数；每帧只渐入 [shown, total) 这段尾巴。
//   · 不做 per-char 级联延迟：延迟会让还没到点的字停在 opacity 0，若下一 delta 抢先重渲染，它会从
//     0 直接跳成实体（pop）。整段尾巴同时起淡则最差也只是从「部分透明」跳到实体（ease-out 下几乎无感）。
//   · 跳过 KaTeX 内部文本（其 <annotation> 含隐藏 LaTeX，计数会漂、包裹会破版）——公式整体即时显示。
//   · live=false（历史消息一次性渲染）时首帧即把 shown 顶到全长，永不渐入。
export function streamFade(node, opts = {}) {
  let shown = 0, raf = 0, inited = false;

  // 参与计数/渐入的可见文本节点。排除：
  //  · KaTeX 内部（<annotation> 含隐藏 LaTeX，计数会漂、包裹会破版）；
  //  · <pre> 外的纯空白节点——marked 在每个块标签后会留结构性 "\n"，随正文增长这些换行会位移，
  //    若计入字符索引，个别新字会被误判成「已显示」而漏掉渐入。只按真实字形计数即稳定（代码块内空白保留）。
  function textNodes() {
    const out = [];
    const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (p && p.closest('.katex')) return NodeFilter.FILTER_REJECT;
        if (!/\S/.test(n.nodeValue) && !(p && p.closest('pre'))) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n; while ((n = w.nextNode())) out.push(n);
    return out;
  }
  const totalOf = (ns) => ns.reduce((s, n) => s + n.nodeValue.length, 0);

  function wrapTail() {
    raf = 0;
    const ns = textNodes();
    const total = totalOf(ns);
    if (total <= shown) { shown = total; return; }   // 无新增（含 total 变小的极端情形，重置基线）
    const from = shown;
    let idx = 0;
    for (const n of ns) {
      const end = idx + n.nodeValue.length;
      if (end > from) wrapNode(n, Math.max(0, from - idx));
      idx = end;
    }
    shown = total;
  }
  // 把 textNode 从 start 起的尾部整段包进一个 .g-in（保留前面已显示的部分为纯文本）。
  function wrapNode(tn, start) {
    const t = tn.nodeValue;
    const span = document.createElement('span');
    span.className = 'g-in';
    span.textContent = t.slice(start);
    const parent = tn.parentNode;
    if (start > 0) { tn.nodeValue = t.slice(0, start); parent.insertBefore(span, tn.nextSibling); }
    else parent.replaceChild(span, tn);
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(wrapTail); };

  function init(live) {
    inited = true;
    if (live) { shown = 0; schedule(); }            // 流式：初始内容起就渐入，后续 delta 续接尾巴
    else shown = totalOf(textNodes());              // 历史：全部按实体，不渐入
  }
  init(!!opts.live);

  return {
    update(o) {
      if (!inited) init(!!(o && o.live));
      schedule();   // 有新内容才渐入；历史 md 不变时 wrapTail 自然 no-op
    },
    destroy() { if (raf) cancelAnimationFrame(raf); },
  };
}
