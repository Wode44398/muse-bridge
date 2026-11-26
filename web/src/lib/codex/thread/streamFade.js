// 回答吐字的新字渐显（照 demo 的 wrapFresh）：宿主按帧放字（store/run 的 turn.shown），这里只管
// 「刚长出来的那一截」用 260ms 从淡到实，旧字不动。
//
// 位置记在「可见字序号」上，不挂在 DOM 节点上：流式时末块的 {@html} 每批整块重建，重建后按序号
// 重新切出还在渐显的那几截，套 .bstream 并用负的 animation-delay 接上已经走过的时间——于是 markdown
// 重新渲染不会让旧字再闪一次。
//
// DOM 手术的边界（Svelte 5 的 {#each} / {@html} 拿根节点这一层的节点当锚点）：根这一层的文本节点
// 一律不动，只切元素里面的；已经在 .bstream 里的不再套。计数口径：<pre> 外的纯空白文本节点不算
//（marked 在块标签之间留的换行，会随正文增长挪位置），按钮、公式内部不算。

import { reduced } from '../motion.js';

export const FADE = 260;

/**
 * 可见字数从 st.len 变到 len：长了记一截新的 { start, end, born }；短了（重放、修补写头）收回；
 * 过了渐显时长的丢掉。返回 st（就地改）。
 */
export function track(st, len, now, fade = FADE) {
  if (len > st.len) st.chunks.push({ start: st.len, end: len, born: now });
  else if (len < st.len) st.chunks = st.chunks.filter((c) => c.start < len).map((c) => (c.end > len ? { ...c, end: len } : c));
  st.len = len;
  st.chunks = st.chunks.filter((c) => now - c.born < fade);
  return st;
}

/** 文本节点 [start, end) 里还在渐显的几段（节点内偏移 + 已走过的毫秒），按位置排好。 */
export function hitsIn(chunks, start, end, now) {
  const out = [];
  for (const c of chunks) {
    const a = Math.max(c.start, start), b = Math.min(c.end, end);
    if (b > a) out.push({ a: a - start, b: b - start, age: Math.max(0, now - c.born) });
  }
  return out.sort((x, y) => x.a - y.a);
}

const SKIP = (el) => el.tagName === 'BUTTON' || el.classList?.contains('katex') || el.classList?.contains('md-codecopy');

/** 按文档序走一遍可见文本节点：fn(node, start, end)。返回总字数。 */
function walk(root, fn) {
  let idx = 0;
  const visit = (el, inPre) => {
    for (let c = el.firstChild; c;) {
      const next = c.nextSibling;
      if (c.nodeType === 3) {
        const v = c.nodeValue;
        if (inPre || /\S/.test(v)) {
          const s = idx;
          idx += v.length;
          fn?.(c, s, idx);
        }
      } else if (c.nodeType === 1 && !SKIP(c)) {
        visit(c, inPre || c.tagName === 'PRE');
      }
      c = next;
    }
  };
  visit(root, false);
  return idx;
}

export const countText = (root) => walk(root, null);

function wrap(root, chunks, now) {
  if (!chunks.length) return;
  const todo = [];
  walk(root, (node, s, e) => {
    if (node.parentNode === root || node.parentElement?.classList.contains('bstream')) return;
    const hits = hitsIn(chunks, s, e, now);
    if (hits.length) todo.push([node, hits]);
  });
  for (const [node, hits] of todo) {
    const v = node.nodeValue, frag = document.createDocumentFragment();
    let cur = 0;
    for (const h of hits) {
      if (h.a > cur) frag.appendChild(document.createTextNode(v.slice(cur, h.a)));
      const sp = document.createElement('span');
      sp.className = 'bstream';
      sp.style.animationDelay = `-${Math.round(h.age)}ms`;
      sp.textContent = v.slice(Math.max(cur, h.a), h.b);
      frag.appendChild(sp);
      cur = Math.max(cur, h.b);
    }
    if (cur < v.length) frag.appendChild(document.createTextNode(v.slice(cur)));
    node.parentNode.replaceChild(frag, node);
  }
}

/**
 * Svelte action：<div class="md" use:streamFade={{ live }}>。live 时盯着子树的变化（微任务里、绘制之前）
 * 切出新字；live 关掉后再盯一个渐显时长，好让收尾那次整段重渲染把最后几个字接着淡完。
 * 挂上时已有的字直接实体（切回一条正在跑的线程时不该整段重放）。
 */
export function streamFade(node, opts = {}) {
  let live = !!opts.live;
  const st = { len: countText(node), chunks: [] };
  let mo = null, offT = 0;
  const apply = () => {
    const now = performance.now();
    track(st, countText(node), now);
    if (st.chunks.length && !reduced()) wrap(node, st.chunks, now);
    mo?.takeRecords();
  };
  const start = () => {
    if (mo || typeof MutationObserver === 'undefined') return;
    st.len = countText(node);
    mo = new MutationObserver(apply);
    mo.observe(node, { childList: true, subtree: true, characterData: true });
  };
  const stop = () => { mo?.disconnect(); mo = null; st.chunks = []; };
  if (live) start();
  return {
    update(next = {}) {
      const was = live;
      live = !!next.live;
      clearTimeout(offT);
      if (live) start();
      else if (was) offT = setTimeout(stop, FADE + 80);
    },
    destroy() { clearTimeout(offT); stop(); },
  };
}
