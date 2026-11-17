// 文档查看 / 编辑器（DocViewer）的md 阅读态查找（FindBar + CSS 自定义高亮）与键盘滚动。
// P 是外壳（DocViewer.svelte）交出来的状态与动作视图，见那边的 P。
import { tick, untrack } from 'svelte';
import { isEditable } from '../kit/context.js';

export function createDocFind(P) {
  // —— md 阅读态：查找（Ctrl+F）+ 键盘滚动 ——
  // 查找：共用 FindBar + CSS 自定义高亮（::highlight），不改 DOM、不打断选区，与 Word 快速预览同一做法；
  //   不支持的内核退化成选中当前命中。正文分块渲染 / 双链索引到货重渲时按原查询重扫（保住当前第几个）。
  // 滚动：焦点在 .doc-scroll 里（打开时给它、点正文也会落到它上面）由浏览器原生滚；焦点在顶栏 / 外框上时
  //   这里代滚一下并把焦点交回滚动区，之后的键又回到原生滚动。
  const HL = typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight !== 'undefined';
  let fOpen = $state(false), fQuery = $state(''), fCur = $state(0), fTotal = $state(0), fCase = $state(false);
  let findBar = $state(null);
  let fHits = [];
  const F_MAX = 5000;
  function clearHl() { if (HL) { CSS.highlights.delete('md-hit'); CSS.highlights.delete('md-cur'); } }
  function mdSearch(q, keep = false) {
    const was = fCur;
    clearHl();
    fHits = []; fCur = 0; fTotal = 0;
    if (!q || !P.pageEl || !P.docScrollEl) return;
    const needle = fCase ? q : q.toLowerCase();
    const walker = document.createTreeWalker(P.pageEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const p = n.parentElement;
        if (!p || p.closest('.doc-tailhost, .doc-rendering, style, script')) return NodeFilter.FILTER_REJECT;
        return p.getClientRects().length ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;   // 折叠着的块里的字不算
      },
    });
    for (let n = walker.nextNode(); n && fHits.length < F_MAX; n = walker.nextNode()) {
      const raw = n.data;
      // 不区分大小写：整段转小写再找；大小写折叠改了长度的极少数字符（İ 之类）就按原文、原样的查询词找，免得区间错位
      const low = fCase ? raw : raw.toLowerCase();
      const fold = !fCase && low.length === raw.length;
      const s = fold ? low : raw;
      const nd = fCase || fold ? needle : q;
      for (let i = s.indexOf(nd); i >= 0 && fHits.length < F_MAX; i = s.indexOf(nd, i + nd.length)) {
        const r = document.createRange();
        r.setStart(n, i); r.setEnd(n, i + nd.length);
        fHits.push(r);
      }
    }
    fTotal = fHits.length;
    if (!fHits.length) return;
    if (keep && was) { fCur = Math.min(was, fHits.length); paintHits(); return; }
    // 从当前看到的位置往后找第一个
    const top = P.docScrollEl.getBoundingClientRect().top;
    const k = fHits.findIndex((r) => r.getBoundingClientRect().bottom >= top);
    fCur = (k < 0 ? 0 : k) + 1;
    paintHits(); revealHit();
  }
  function paintHits() {
    const c = fHits[fCur - 1];
    if (HL) {
      CSS.highlights.set('md-hit', new Highlight(...fHits));
      if (c) { const one = new Highlight(c); one.priority = 1; CSS.highlights.set('md-cur', one); }
    } else if (c) {
      try { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(c); } catch {}
    }
  }
  function revealHit() {
    const c = fHits[fCur - 1];
    if (!c || !P.docScrollEl) return;
    const r = c.getBoundingClientRect(), sr = P.docScrollEl.getBoundingClientRect();
    const topGap = P.viewer.touch ? 16 : 64;   // 电脑查找卡浮在右上角，命中别藏在它下面
    if (r.top < sr.top + topGap || r.bottom > sr.bottom - 40) P.docScrollEl.scrollTop += r.top - sr.top - Math.round(sr.height / 3);
  }
  function mdStep(dir) {
    if (!fHits.length) return;
    fCur = ((fCur - 1 + dir + fHits.length) % fHits.length) + 1;
    paintHits(); revealHit();
  }
  function mdCase(on) { fCase = on; mdSearch(fQuery); }
  function openMdFind() {
    if (P.isMd && P.mode !== 'preview') return;
    if (fOpen) { findBar?.focus(); return; }
    fOpen = true;
  }
  function closeMdFind() {
    // 焦点还在查找条里就交回正文滚动区（查找条一卸载焦点会掉到 body，Tab 从头走、键盘滚不动）
    const a = document.activeElement;
    if (fOpen && P.docScrollEl && (!a || a === document.body || a.closest?.('.fb'))) try { P.docScrollEl.focus({ preventScroll: true }); } catch {}
    fOpen = false; fQuery = ''; fHits = []; fCur = 0; fTotal = 0; clearHl();
  }
  // 换篇 / 切到编辑或源码：收起查找
  $effect(() => { P.cur.key; P.mode; untrack(() => { if (fOpen) closeMdFind(); }); });
  // 正文换了（分块续渲、双链索引到货重渲）：按原查询重扫，区间才不会指向已被替换掉的节点
  $effect(() => { P.mdBlocks; if (untrack(() => fOpen && fQuery)) tick().then(() => { if (fOpen && fQuery) mdSearch(fQuery, true); }); });
  $effect(() => () => clearHl());
  // 电脑：md 打开（或从编辑切回阅读）后把焦点给滚动区，方向键 / 空格 / PgDn 直接能滚；焦点已在别的控件上就不抢
  $effect(() => {
    if (!P.isMd || P.mode !== 'preview' || P.loading || P.loadError || !P.docScrollEl || P.viewer.touch || P.viewer.active === false) return;
    const el = P.docScrollEl;
    tick().then(() => {
      const a = document.activeElement, root = P.viewer.root?.();
      if (el.isConnected && (!a || a === document.body || a === root)) try { el.focus({ preventScroll: true }); } catch {}
    });
  });
  function mdKeys(e) {
    if (P.mode !== 'preview' || !P.docScrollEl) return false;
    const k = e.key, mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyF') { openMdFind(); return true; }
    if (fOpen && (k === 'F3' || (mod && !e.altKey && e.code === 'KeyG'))) { if (fQuery) mdStep(e.shiftKey ? -1 : 1); else findBar?.focus(); return true; }
    if (k === 'Escape' && fOpen) { closeMdFind(); return true; }
    if (mod || e.altKey || isEditable(e.target)) return false;
    if (P.docScrollEl.contains(e.target)) return false;   // 焦点在滚动区里：浏览器原生滚（含平滑与连按加速）
    const el = P.docScrollEl, page = Math.max(40, el.clientHeight - 48);
    let dy = null, to = null;
    switch (k) {
      case 'ArrowDown': dy = 48; break;
      case 'ArrowUp': dy = -48; break;
      case 'PageDown': dy = page; break;
      case 'PageUp': dy = -page; break;
      case ' ': if (e.target?.closest?.('button, a, [role="button"]')) return false; dy = e.shiftKey ? -page : page; break;
      case 'Home': to = 0; break;
      case 'End': to = el.scrollHeight; break;
      default: return false;
    }
    if (to != null) el.scrollTo({ top: to }); else el.scrollBy({ top: dy });
    try { el.focus({ preventScroll: true }); } catch {}
    return true;
  }

  // 查看器键盘：Ctrl+S 存；表格态交给 TableView、代码态交给 CodeView（查找 / 跳行 / 换行 / 字号）；编辑中 Esc 先退回查看

  return {
    get closeMdFind() { return closeMdFind; },
    get fCase() { return fCase; }, set fCase(v) { fCase = v; },
    get fCur() { return fCur; }, set fCur(v) { fCur = v; },
    get fOpen() { return fOpen; }, set fOpen(v) { fOpen = v; },
    get fQuery() { return fQuery; }, set fQuery(v) { fQuery = v; },
    get fTotal() { return fTotal; }, set fTotal(v) { fTotal = v; },
    get findBar() { return findBar; }, set findBar(v) { findBar = v; },
    get mdCase() { return mdCase; },
    get mdKeys() { return mdKeys; },
    get mdSearch() { return mdSearch; },
    get mdStep() { return mdStep; },
    get openMdFind() { return openMdFind; },
  };
}
