// 工作空间 · 桌面版（FilesDesktop）的地址栏：面包屑头部折叠（按缓存的自然宽度算档位）与地址编辑（点空白处 / Ctrl+L 换成完整路径输入）。
// P 是外壳（FilesDesktop.svelte）交出来的状态与动作视图，见那边的 P。
import { tick, untrack } from 'svelte';
import { t } from '../../../lib/i18n.js';
import { foldAbs, isWinAbs, joinPath, splitAbs } from './fdLook.js';

export function createFdCrumbs(P) {
  // 面包屑头部折叠：放不下就从根开始一段段收进「…」（点开是被收起的层级），尾巴＝当前目录永远露着。
  // 首版靠 overflow:hidden 从右边裁，窄列里每一段都缩成两个字、当前目录反而看不见。
  let crumbsEl = $state();
  let crumbHide = $state(0);
  let crumbPop = $state(false);
  let crumbSqueeze = $state(false);   // 头部已全部折叠仍溢出 → 允许当前段省略号
  let locPop = $state(false);         // 窄列里的「位置」下拉（位置栏收起时的入口）
  let addrEdit = $state(null);        // 地址栏编辑态：输入框里的路径文本（null＝显示面包屑）
  const addrOn = $derived(addrEdit !== null);
  // 地址栏各段：{ label, rel }＝当前位置内（rel 相对位置根，''=根）；{ label, abs }＝位置根之上的
  // 上级目录（E: › Vault 在 Claude 位置之上），点它按绝对路径换到含它的位置（E:\ 那个），
  // 没有位置含它就只显示不可点（ok=false）。
  const crumbList = $derived.by(() => {
    const inner = P.segs.map((s, i) => ({ label: s, rel: P.segs.slice(0, i + 1).join('/') }));
    if (!P.absOk) return [{ label: P.rootLabel, rel: '' }, ...inner];
    const parts = splitAbs(P.curLoc.abs);
    const head = parts.map((p, i) => (i === parts.length - 1 ? { label: p.label, rel: '' } : { label: p.label, abs: p.abs, ok: P.canFloat || Boolean(P.resolveAbs(p.abs)) }));
    return [...head, ...inner];
  });
  const crumbItems = $derived(crumbList.map((c) => c.label));
  const crumbRel = (i) => crumbList[i]?.rel ?? null;   // null＝位置根之上（不收拖放：跨位置移动不在这条路上）
  const crumbOk = (i) => crumbList[i]?.rel != null || Boolean(crumbList[i]?.ok);
  function gotoCrumb(i) {
    crumbPop = false;
    const c = crumbList[i];
    if (!c) return;
    if (c.rel == null) { if (c.ok) P.goAbs(c.abs, { float: P.canFloat }); return; }
    if (c.rel === '') P.goRoot(); else P.navTo({ mode: 'browse', path: c.rel });
  }

  // —— 地址栏编辑（Explorer 式：点空白处 / Ctrl+L / Alt+D 换成完整路径文本，可复制、可输入跳转）——
  const canAddr = $derived(P.absOk && P.inBrowse);
  function startAddr() { if (!canAddr) return; crumbPop = false; locPop = false; addrEdit = P.curAbs; }
  function addrClick(e) { if (addrEdit === null && !e.target.closest?.('button, input')) startAddr(); }
  function addrKey(e) {
    e.stopPropagation();   // Esc/Backspace 这些是全局快捷键（清选择 / 上一级），输入框里的键别漏出去
    if (e.key === 'Escape') { e.preventDefault(); addrEdit = null; P.rowsEl?.focus({ preventScroll: true }); }
    else if (e.key === 'Enter') { e.preventDefault(); commitAddr(); }
  }
  // 输入的路径：绝对路径照用；相对路径按当前目录拼；. 与 .. 就地化简
  function typedAbs(v) {
    const parts = splitAbs(isWinAbs(v) || v.startsWith('/') ? v : joinPath(P.curAbs, v));
    const out = [];
    for (const p of parts.slice(1)) { if (p.label === '..') out.pop(); else if (p.label !== '.') out.push(p.label); }
    return joinPath(parts[0].abs, out.join('/'));
  }
  async function commitAddr() {
    const v = String(addrEdit ?? '').trim().replace(/^"(.*)"$/, '$1');
    addrEdit = null;
    P.rowsEl?.focus({ preventScroll: true });
    if (!v) return;
    const abs = typedAbs(v);
    if (foldAbs(abs) !== foldAbs(P.curAbs)) await P.goAbs(abs);
  }
  function addrMenu(e) {
    if (!P.absOk) return;
    P.popupMenu(e, [
      { label: t('复制地址'), act: () => P.copyText(P.curAbs, t('已复制路径')) },
      { label: t('编辑地址'), hint: 'Ctrl+L', act: startAddr, disabled: !canAddr },
    ]);
  }
  // 折叠档位按【缓存的自然宽度】算，不在 DOM 上反复试：
  //   · 路径 / 搜索 / 模式变了（离散事件）：先全展开一帧，量出每段左缘到末尾的距离存起来；
  //   · 列宽变了（拖侧栏，每帧都来）：只拿缓存和当前可用宽度算出 crumbHide，一步到位。
  // 首版每个像素都「归零→逐段 tick 折回去」，每一步都触发一次工具栏 FLIP、幽灵叠幽灵，拖侧栏时顶栏抽搐。
  const CMORE_W = 30;          // 「…」钮 26px + margin-left 4px（见 .crumb-more / .tb-btn.ell）
  let crumbTail = null;        // tail[i] = 从第 i 段左缘到内容末尾的宽度（第 i 段前的分隔符不计——它随头部一起收走）
  let crumbFit = 0;
  function fitCrumbs() {
    const el = crumbsEl;
    if (!el || !crumbTail) return;
    const cs = getComputedStyle(el);
    // 可用宽＝不带「…」钮时框内的内容宽；当前带着钮就把钮占的宽度加回来，结果与当前档位无关、不会自激振荡
    const avail = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) + (crumbHide > 0 ? CMORE_W : 0);
    let h = 0, sq = false;
    if (crumbTail[0] > avail + 1) {
      h = crumbTail.findIndex((w, i) => i > 0 && w <= avail - CMORE_W + 1);
      if (h < 0) { h = crumbTail.length - 1; sq = true; }
    }
    if (h !== crumbHide) crumbHide = h;
    if (sq !== crumbSqueeze) crumbSqueeze = sq;
  }
  $effect(() => {
    crumbItems; P.searching; P.mode;   // 内容变了才重量
    crumbHide = 0; crumbSqueeze = false; crumbTail = null;
    const my = ++crumbFit;
    tick().then(() => {
      const inner = crumbsEl?.firstElementChild;
      if (my !== crumbFit || !inner) return;
      const kids = [...inner.children];
      const segEls = kids.filter((k) => k.classList.contains('crumb'));
      const end = kids.length ? kids[kids.length - 1].offsetLeft + kids[kids.length - 1].offsetWidth : 0;
      // offsetLeft 不含 transform（FLIP 途中也量得准）；recent 模式只有一段，tail 长度 1 → 永不折叠
      crumbTail = segEls.map((k) => end - k.offsetLeft);
      fitCrumbs();
    });
  });
  // 框宽变化（拖列宽 / 分档 / 搜索框展开 / 「…」钮出没）一律走这里；crumbsEl 在第一行与第二行之间换挂时重新盯
  $effect(() => {
    const el = crumbsEl;
    if (!el) return;
    const ro = new ResizeObserver(() => fitCrumbs());
    ro.observe(el);
    untrack(fitCrumbs);
    return () => ro.disconnect();
  });

  return {
    get addrClick() { return addrClick; },
    get addrEdit() { return addrEdit; }, set addrEdit(v) { addrEdit = v; },
    get addrKey() { return addrKey; },
    get addrMenu() { return addrMenu; },
    get addrOn() { return addrOn; },
    get canAddr() { return canAddr; },
    get crumbHide() { return crumbHide; }, set crumbHide(v) { crumbHide = v; },
    get crumbItems() { return crumbItems; },
    get crumbOk() { return crumbOk; },
    get crumbPop() { return crumbPop; }, set crumbPop(v) { crumbPop = v; },
    get crumbRel() { return crumbRel; },
    get crumbSqueeze() { return crumbSqueeze; }, set crumbSqueeze(v) { crumbSqueeze = v; },
    get crumbsEl() { return crumbsEl; }, set crumbsEl(v) { crumbsEl = v; },
    get gotoCrumb() { return gotoCrumb; },
    get locPop() { return locPop; }, set locPop(v) { locPop = v; },
    get startAddr() { return startAddr; },
  };
}
