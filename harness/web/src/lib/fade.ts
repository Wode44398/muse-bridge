// 流式吐字渐入（Svelte action）。新到达的文字 opacity 0→1（0.42s 线性，动画在 app.css 的 span.f-in 上），在写头处
// 形成一道滚动的淡入波。
//
// 难点：{@html} 每批吐字都会把子树整个换掉（受控 {@html} 直接写 innerHTML），naive 的线性淡入会在重渲染那一刻从半透明
// 跳成实体。解法 = 负 animation-delay 续接：按「全文里的第几个字」记下每段新文字的出生时刻；每次 DOM 变了，重新把还在
// 淡入期的那几段包起来，animationDelay = -(now - born)，动画从「应有进度」接着播，跨重渲染连续、不回跳（沿自 bridge
// claudeFade 的实测结论）。
//
// 旧版的两处缺陷（spec-A §4 / §5 / §13 的 1、2），这一版的做法：
//   1. 只在挂载后约 400ms 内淡入：旧版靠 update() 触发，而参数 { live: true } 是常量，update 永远不来。现在由
//      MutationObserver 盯着内容（childList / characterData / subtree）：内容一变就重新测量、给新长出来的字起一段淡入。
//   2. 思考行展开后冻住：旧版把 Svelte 持有引用的那个文本节点整个换成了 span 片段，之后 Svelte 的 set_text 写进一个
//      已经脱离文档的节点。现在绝不替换、不删除、不 normalize 框架的节点——「原地切开」：原文本节点留在原位，只把它的
//      data 暂时截成前半段，后半段放进我们自己插进去的 span / 文本节点里；下一次测量之前先把自己插的节点摘掉、把 data
//      还原（框架在此期间改过它就以框架的为准）。Svelte 的 set_text 比较的是它自己缓存的值，不读 nodeValue，所以暂时截断
//      不会让它漏写；受控 {@html} 整块重写时我们插的节点随旧子树一起没了，同样没有残留。
//   自己改 DOM 前后都 takeRecords()，丢掉自己产生的变更记录，不会自己触发自己。
//
// 语义：挂载时 live = false（历史消息）→ 永远不淡入。live = true → 从此以后长出来的字都淡入；挂载时已有的内容只在很短
// （刚开始流）时整体淡入，切会话进来时已经很长的正文不整段闪一遍。live 变 false 之后（流结束、换成最终版渲染）还在淡入期
// 的那几段照样续完，然后停止观察。减少动态效果时不做任何事。

import { reducedMotion } from "./motion.ts";

const DUR = 420; // 与 app.css 里 span.f-in 的 0.42s 同步
const CLS = "f-in";
const INITIAL_FADE_MAX = 240; // 挂载时已有内容不超过这么多字才整体淡入（刚开始流）

interface Chunk {
  start: number;
  end: number;
  born: number;
}
interface Split {
  orig: Text; // 框架（或 innerHTML）创建的原文本节点：留在原位，只暂时截短
  full: string; // 截短之前的全文
  set: string; // 我们截成的前半段（还原时核对：框架没动过才还原）
  added: Node[]; // 我们自己插进去的节点（span.f-in 与切剩的文本节点）
}

// 参与计数的文本节点：跳过按钮里的字（代码块的「复制 / 已复制」会自己变）与纯空白（<pre> 里的除外）。
// 每批吐字都要把整条消息走一遍，这里只做便宜的判断（按钮只认直接父级——markdown 产出的按钮里就是一段字）。
function textNodes(root: HTMLElement): Text[] {
  const out: Text[] = [];
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const p = (n as Text).parentElement;
      if (!p || p.nodeName === "BUTTON") return NodeFilter.FILTER_REJECT;
      if (!/\S/.test(n.nodeValue ?? "") && !p.closest("pre")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let n: Node | null;
  while ((n = w.nextNode())) out.push(n as Text);
  return out;
}

export function streamFade(node: HTMLElement, opts?: { live?: boolean }) {
  let inited = false;
  let active = false; // 在观察（live 挂载，或 live 刚结束、还有字在淡入）
  let ending = false; // live 已经变 false：淡入期的字续完就停
  let shown = 0; // 已经算过账的字数
  let chunks: Chunk[] = [];
  let splits: Split[] = [];
  let mo: MutationObserver | null = null;
  let timer = 0;

  // 摘掉自己插的节点、还原被截短的原文本节点（框架改过就不动它）
  function restore() {
    for (const s of splits) {
      for (const n of s.added) n.parentNode?.removeChild(n);
      if (s.orig.nodeValue === s.set) s.orig.nodeValue = s.full;
    }
    splits = [];
  }

  // 原地切开：orig 留在原位保留 [0, 第一段起点)，其后依次插入 [普通文字][span.f-in]…[剩余文字]
  function splitInPlace(orig: Text, hits: { a: number; b: number; delay: number }[]) {
    const parent = orig.parentNode;
    if (!parent) return;
    const full = orig.nodeValue ?? "";
    hits.sort((x, y) => x.a - y.a);
    const added: Node[] = [];
    let ref: Node = orig;
    const after = (n: Node) => {
      parent.insertBefore(n, ref.nextSibling);
      ref = n;
      added.push(n);
    };
    let cur = hits[0].a;
    const head = full.slice(0, cur);
    for (const h of hits) {
      if (h.a > cur) after(document.createTextNode(full.slice(cur, h.a)));
      const span = document.createElement("span");
      span.className = CLS;
      span.style.animationDelay = `-${Math.round(h.delay)}ms`;
      span.textContent = full.slice(h.a, h.b);
      after(span);
      cur = h.b;
    }
    if (cur < full.length) after(document.createTextNode(full.slice(cur)));
    orig.nodeValue = head;
    splits.push({ orig, full, set: head, added });
  }

  // 只看尾部：还在淡入期的字都在全文末端附近，从后往前走到最早那段的起点就停
  function wrap(ns: Text[], total: number, now: number) {
    let from = Infinity;
    for (const c of chunks) from = Math.min(from, c.start);
    let b0 = total;
    for (let k = ns.length - 1; k >= 0 && b0 > from; k--) {
      const tn = ns[k];
      const len = tn.nodeValue?.length ?? 0;
      const a0 = b0 - len;
      let hits: { a: number; b: number; delay: number }[] | null = null;
      for (const c of chunks) {
        const a = Math.max(c.start, a0);
        const b = Math.min(c.end, b0);
        if (b > a) (hits ??= []).push({ a: a - a0, b: b - a0, delay: now - c.born });
      }
      if (hits) splitInPlace(tn, hits);
      b0 = a0;
    }
  }

  function stop() {
    active = false;
    clearTimeout(timer);
    mo?.disconnect();
    mo = null;
    restore();
    chunks = [];
  }

  function tick() {
    if (!active) return;
    clearTimeout(timer);
    mo?.takeRecords(); // 下面从 DOM 现状重新推导，排队中的记录不用再看
    restore();
    const now = performance.now();
    const ns = textNodes(node);
    let total = 0;
    for (const n of ns) total += n.nodeValue?.length ?? 0;
    if (total > shown) {
      chunks.push({ start: shown, end: total, born: now });
      shown = total;
    } else if (total < shown) {
      // 改写（撤回 / 重流 / 尾块结构翻版）：从现状重新记账，这一下不淡入
      shown = total;
      chunks = [];
    }
    chunks = chunks.filter((c) => now - c.born < DUR && c.end > c.start);
    if (chunks.length) wrap(ns, total, now);
    mo?.takeRecords(); // 丢掉自己刚才改 DOM 产生的记录
    if (chunks.length) {
      // 最后一段淡完之后收一次尾：把自己插的节点摘干净（DOM 回到框架写的原样）
      let last = 0;
      for (const c of chunks) last = Math.max(last, c.born);
      timer = window.setTimeout(tick, Math.max(16, last + DUR - now + 24));
    } else if (ending) {
      stop();
    }
  }

  function init(live: boolean) {
    inited = true;
    if (!live || reducedMotion() || typeof MutationObserver === "undefined") return;
    active = true;
    let total = 0;
    for (const n of textNodes(node)) total += n.nodeValue?.length ?? 0;
    // 刚开始流（手里只有一小段）：这一小段也淡入；已经很长（切会话进来）就只淡以后新长的
    shown = total <= INITIAL_FADE_MAX ? 0 : total;
    mo = new MutationObserver(() => tick());
    mo.observe(node, { childList: true, characterData: true, subtree: true });
    tick();
  }
  init(Boolean(opts?.live));

  return {
    update(o?: { live?: boolean }) {
      if (!inited) {
        init(Boolean(o?.live));
        return;
      }
      if (active && !o?.live && !ending) {
        // 流结束：换成最终版渲染的那次变更也要接住（还在淡入的字续完），淡完再停
        ending = true;
        if (mo && mo.takeRecords().length) tick();
        else if (!chunks.length) stop();
      }
    },
    destroy() {
      stop();
    },
  };
}
