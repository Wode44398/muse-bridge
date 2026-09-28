// Claude.ai 官网「吐字渐入」——新到达文本 opacity 0→1、0.4s linear，在写头处形成一道滚动淡入波。
//
// 逆向自 claude.ai（2026-07，用 edge0 连官网抓 CSSOM + 流式 DOM 采样得来）：
//   @keyframes _fadeInText_ { 0% { opacity: 0 } 100% { opacity: 1 } }
//   ._animating_   { animation: 0.4s linear 0s 1 normal both _fadeInText_ }
//   ._chunkWrapper_{ display: contents }          // 逐块包裹、不生成盒子 → 表格/代码块布局不被打断
//   [data-reduce-motion=true] ._animating_ { animation-name: none }   // 无障碍降级
// 官网做法：整段回复按 markdown 块各包一层 chunkWrapper（display:contents），新到达的【叶子文本】
// （<span>，遍及 p / li / th / td / pre / 标题 / 引用…）挂 _animating_ 渐入、淡完即摘；任意时刻约
// 16–22 个叶子 span 同时在渐入 → 肉眼看到写头处一道"波"。实测表格 th/td 单元格、代码 token 都在渐入。
//
// —— 为什么不能照搬 linear ——
// 官网是【增量 DOM】：旧节点不动、只往末尾追加，linear 从 0→1 一路涨，天然不回跳。
// bridge 不同：Thread 里 {@html renderMarkdown(seg.md)} 每个 ~100ms delta 就把整棵子树全量重渲染，
// 上一段尾巴的 DOM 被整棵替换。若给新尾巴挂 linear，它在下一次重渲染时会从半透明"啪"地变成实体（爆闪）。
// （强 ease-out 能把这一跳藏进"几乎已到实体"的尾段——但那不是官网的 linear。）
//
// —— 复刻手法：负 animation-delay 续接 ——
// 把"最近 DUR 毫秒内出生的每一段尾巴"都当作活跃段（记 born 时刻）。每次重渲染后回到纯文本，再把每个
// 活跃段重新包成 .c-in，并令 style.animationDelay = -(now-born)ms —— CSS 负延迟会让动画从"应有进度"起播，
// 于是 linear 跨重渲染连续无回跳，写头波形与官网一致。淡完（age≥DUR）的段落不再包裹，回落纯文本实体。
//
// 覆盖所有格式：文本节点遍历包含 <pre> 内代码、表格单元格、列表、标题、引用；排除 KaTeX 内部
// （其 <annotation> 藏隐藏 LaTeX，计数会漂、包裹会破版）——公式整体即时显示。
// live=false（历史消息一次性渲染）时首帧即把基线顶到全长，永不渐入。
// tick 幂等：每次先把自己上一轮的 .c-in 拆回纯文本再重量，无论 Svelte 是否刷新了 {@html} 都不会叠套。

const DUR = 400;            // 与官网一致：0.4s
const CLS = 'c-in';

// 参与计数/渐入的可见文本节点。排除 KaTeX 内部；排除 <pre> 外的纯空白节点
// （marked 在块标签后留结构性 "\n"，随正文增长会位移，计入索引会让个别新字被误判"已显示"而漏渐入；
//  代码块内空白必须保留，故仅 <pre> 外剔除）。
function textNodes(node) {
  const out = [];
  const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = n.parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      if (p.closest('.katex')) return NodeFilter.FILTER_REJECT;
      if (!/\S/.test(n.nodeValue) && !p.closest('pre')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n; while ((n = w.nextNode())) out.push(n);
  return out;
}
const totalOf = (ns) => ns.reduce((s, n) => s + n.nodeValue.length, 0);

export function claudeFade(node, opts = {}) {
  let shown = 0;             // 已进入渐入流水线的可见字符数（基线）
  let chunks = [];           // 活跃段 [{start,end,born}]，start/end = 可见字符全局索引
  let raf = 0, inited = false;

  // 把上一轮自己包的 .c-in 拆回纯文本，合并相邻文本节点 → tick 从纯文本起算，幂等。
  // 常见路径（md 变化 → Svelte 已整棵重渲染）里根本没有 .c-in，直接跳过、零开销；
  // 仅"重渲染但 md 未变"的少见回合才真的拆包+normalize。
  // ⚠ 只能 normalize 被拆的 span 所在的父元素，【绝不能】对 node 自己调 normalize()：
  // Svelte 5 的 {#each}（controlled 模式）和每个 {@html} 都拿一个【空文本节点】当插入锚点，
  // 挂在 node 这一层；normalize() 按规范会删掉所有空文本节点 → 锚点脱离文档，之后新块 /
  // 新内容全插进「空气」里：长回答第 2 块起不显示（输出到一半被截断），切走再切回来整段
  // 文字消失、只剩工具组。span 只会出现在 {@html} 产出的 p/li/td… 里，锚点不在那一层。
  function unwrap() {
    const spans = node.querySelectorAll('span.' + CLS);
    if (!spans.length) return;
    const parents = new Set();
    for (const s of spans) {
      const p = s.parentNode;
      if (!p) continue;
      p.replaceChild(document.createTextNode(s.textContent), s);
      parents.add(p);
    }
    for (const p of parents) if (p !== node && p.isConnected) p.normalize();
  }

  function tick() {
    raf = 0;
    unwrap();
    const ns = textNodes(node);
    const total = totalOf(ns);
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (total > shown) { chunks.push({ start: shown, end: total, born: now }); shown = total; }
    else if (total < shown) { shown = total; chunks = []; }   // 内容缩短（重连重放/重置）→ 清基线
    chunks = chunks.filter((c) => now - c.born < DUR && c.end > c.start);
    if (!chunks.length) return;
    wrap(ns, now);
  }

  // 遍历文本节点，凡与活跃段相交的子串切出来包 .c-in，并挂负延迟续接进度。
  function wrap(ns, now) {
    let idx = 0;
    for (const tn of ns) {
      const len = tn.nodeValue.length;
      const a0 = idx, b0 = idx + len; idx = b0;
      const hits = [];
      for (const c of chunks) {
        const a = Math.max(c.start, a0), b = Math.min(c.end, b0);
        if (b > a) hits.push({ a: a - a0, b: b - a0, delay: now - c.born });
      }
      if (hits.length) rebuild(tn, hits);
    }
  }

  // 把单个 textNode 依 hits（相对本节点的 [a,b) 区间 + delay）重建为 [纯文本?]<span.c-in>… 交错。
  function rebuild(tn, hits) {
    const t = tn.nodeValue, parent = tn.parentNode;
    if (!parent) return;
    hits.sort((x, y) => x.a - y.a);
    const frag = document.createDocumentFragment();
    let cur = 0;
    for (const h of hits) {
      if (h.a > cur) frag.appendChild(document.createTextNode(t.slice(cur, h.a)));
      const span = document.createElement('span');
      span.className = CLS;
      span.textContent = t.slice(h.a, h.b);
      span.style.animationDelay = '-' + Math.round(h.delay) + 'ms';
      frag.appendChild(span);
      cur = h.b;
    }
    if (cur < t.length) frag.appendChild(document.createTextNode(t.slice(cur)));
    parent.replaceChild(frag, tn);
  }

  const schedule = () => { if (!raf) raf = requestAnimationFrame(tick); };

  function init(live) {
    inited = true;
    if (live) { shown = 0; chunks = []; schedule(); }   // 流式：初始内容起就渐入，后续 delta 续接尾巴
    else shown = totalOf(textNodes(node));              // 历史：全部按实体，不渐入
  }
  init(!!opts.live);

  return {
    update(o) {
      if (!inited) init(!!(o && o.live));
      // 非流式（历史 / 本轮已收尾）：同一个 div 可能被 Svelte 复用来显示别的消息（Thread 按
      // 下标 keyed），新内容不该再渐入一遍——把基线直接顶到全长，tick 只做拆包收尾。
      if (o && !o.live) { unwrap(); shown = totalOf(textNodes(node)); chunks = []; return; }
      schedule();   // 有新内容才产生新活跃段；内容不变时 tick 自然收敛为无包裹
    },
    destroy() { if (raf) cancelAnimationFrame(raf); },
  };
}
