// 文档查看 / 编辑器（DocViewer）的md 阅读态：分块渐进渲染、文末尾栏、点击接管（双链 / 相对链接 / 锚点 / 脚注）、勾任务、相对文件的打开。
// P 是外壳（DocViewer.svelte）交出来的状态与动作视图，见那边的 P。
import { tick, untrack } from 'svelte';
import { localList, localReadText } from '../../../lib/localfs.js';
import { normalizeItem } from '../../../lib/preview.svelte.js';
import { MD_EXT_RE, renderFootnoteSection, renderObsMarkdown, scanFootnotes } from '../../../lib/obsmd.js';
import { findSafeCut } from '../../../lib/md.js';
import { t } from '../../../lib/i18n.js';
import { guardSelection } from '../../../lib/touchSelection.js';
import { edgeAutoScroll } from '../../../lib/touchAutoScroll.js';
import { artifactRef, siblingDesc } from '../../../lib/docres.js';
import { kindOf } from '../../../lib/fileKinds.js';

export function createDocRead(P) {
  // —— 阅读态分块渐进渲染 ——
  // 整篇同步 renderObsMarkdown 在大文档（长研报/大量公式表格）上会把主线程冻住十几秒起：
  // 转圈是合成器线程在动、点返回却毫无反应——「卡加载还退不出去」的真相就是这一口气渲染。
  // 复用聊天流式的 findSafeCut 顶层块切点把正文切成 ~8KB 块：首块当帧就出，其余块按
  // 每帧 ~12ms 预算分帧追加，返回/切模式随时点随时走。块前缀字符串不变，Svelte each
  // 直接跳过已渲染块，追加只长尾巴。
  let mdBlocks = $state([]);        // 已出炉的 HTML 块
  let mdRendering = $state(false);  // 队列里还有块（文末出细转圈）
  let renderJob = 0;
  // 同一篇重渲（双链索引晚到 / 后台刷新）：旧 DOM 留到新块全部渲完再一次换上，不先截短成半篇；
  // 换的那一刻手指 / 鼠标正按在正文上（或刚抬起 350ms 内）就再等等——点下去的链接被换掉，这一下 click 会落空
  let mdBody = null;
  let mdPress = 0;
  const mdPressing = () => performance.now() < mdPress;
  function splitTopBlocks(text) {
    const parts = [];
    let rest = text;
    for (;;) {
      const cut = findSafeCut(rest, 8000, 400);
      if (cut < 0) break;
      parts.push(rest.slice(0, cut));
      rest = rest.slice(cut);
    }
    if (rest) parts.push(rest);
    return parts;
  }
  $effect(() => {
    // 显式依赖：正文 + 双链索引（![[嵌入]]/相对资源 URL 靠 links 解析，索引到货要重渲染；在路上时嵌入先占位）
    const body = P.isMd && P.mode === 'preview' && !P.loading && !P.loadError ? (P.note?.body ?? '') : null;
    P.links; P.linksPending;
    const job = ++renderJob;
    const same = body != null && body === mdBody && untrack(() => mdBlocks.length > 0);
    mdBody = body;
    if (body == null) { mdBlocks = []; mdRendering = false; return; }
    const parts = splitTopBlocks(body);
    // 脚注定义预扫全文：引用和定义常不在同一块，各块共用这一个上下文 → 编号全篇一致，
    // 脚注区等最后一块渲完再补在文末（只出一次）
    const footnotes = scanFootnotes(body);
    const acc = [];
    // 分帧调度：前台跟 rAF 走 60fps；后台页 rAF 被浏览器挂起（本项目老坑），
    // setTimeout 兜底保证切后台也能把剩余块渲完，回前台不是半篇。
    const schedule = () => {
      let ran = false;
      const run = () => { if (ran) return; ran = true; step(); };
      requestAnimationFrame(run);
      setTimeout(run, 250);
    };
    const step = () => {
      if (job !== renderJob) return;
      const t0 = performance.now();
      while (acc.length < parts.length && performance.now() - t0 < 12) acc.push(renderObsMarkdown(parts[acc.length], { embedUrl: P.embedUrl, embedAlts: P.embedAlts, footnotes }));
      if (acc.length < parts.length) { if (!same) { mdBlocks = [...acc]; mdRendering = true; } schedule(); return; }
      const notes = renderFootnoteSection(footnotes, { embedUrl: P.embedUrl, embedAlts: P.embedAlts });
      const blocks = notes ? [...acc, notes] : [...acc];
      const commit = () => {
        if (job !== renderJob) return;
        if (same && mdPressing()) { setTimeout(commit, 120); return; }
        mdBlocks = blocks;
        mdRendering = false;
      };
      commit();
    };
    step();
    return () => { renderJob++; };   // 卸载/换文档：掐断分帧链
  });

  // —— 文末尾栏：两模式共用一份 DOM，谁在前台谁收编（阅读态挂进 .doc-tailhost；
  //    编辑态由 CM 文末块 widget 收编，见 mdeditor/tail.js）——
  let tailEl = $state(null), tailHost = $state(null);
  $effect(() => { if (tailHost && tailEl) { tailEl.hidden = false; tailHost.appendChild(tailEl); } });

  // —— 点击接管：[[双链]] / 相对 md 链接 → 查看器内跳转；#锚 → 滚到标题 ——
  let mdEl = $state(null);
  // ![[图]] 备选地址的换图（embedFallback）：阅读态正文 + 编辑器容器（callout 卡里的 HTML）各挂一个捕获监听
  $effect(() => {
    const els = [mdEl, P.edEl].filter(Boolean);
    for (const el of els) el.addEventListener('error', P.embedFallback, true);
    return () => { for (const el of els) el.removeEventListener('error', P.embedFallback, true); };
  });
  // 触屏长选区护栏：拖选择柄时固定端滚出屏幕会被浏览器误命中到文首/左侧聊天（选区溢出全文），
  // 活动端拖出正文会跨进别的面板——见 lib/touchSelection.js；拖到上下边缘自动滚动见 touchAutoScroll.js
  let pageEl = $state(null);
  $effect(() => {
    const el = pageEl;
    if (!el) return;
    const down = () => { mdPress = Infinity; };
    const up = () => { if (mdPress === Infinity) mdPress = performance.now() + 350; };
    el.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', up, true);
    return () => {
      mdPress = 0;
      el.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', up, true);
    };
  });
  $effect(() => {
    if (!pageEl) return;
    const offGuard = guardSelection(pageEl, { scroller: () => P.docScrollEl, allEl: () => mdEl });
    const offScroll = edgeAutoScroll(pageEl, { scroller: () => P.docScrollEl });
    return () => { offGuard(); offScroll(); };
  });
  // head：[[笔记#标题]] / 相对链接的 #片段——新笔记加载、渲染完后定位到该标题（验收 e2e-8）
  function openNote(rel, head = '') {
    P.guardDirty(() => {
      // name 必须取 rel 的真实文件名（带扩展名）——normalize 按 name 推 kind，
      // 反链/出链给的是去掉 .md 的展示名，直接用会被当成未知类型走占位页。
      const base = { rel, name: rel.split('/').pop() };
      const it = P.cur.saveTarget?.origin === 'local'
        ? normalizeItem({ origin: 'local', ...base, text: localReadText(rel) })
        : normalizeItem({ origin: 'cloud', ...base, ws: P.cur.saveTarget?.ws || '', nativeLocation: P.cur.saveTarget?.nativeLocation || '' });
      P.stack = [...P.stack, it];
      jumpHead = head ? { key: P.draftKeyOf(it), depth: P.stack.length, head } : null;
    });
  }
  // 跨笔记跳标题只消费一次（返回/重载这篇不再跳）；两态各自定位：阅读态滚 DOM 标题，编辑态交给 CM
  let jumpHead = null;
  function takeJumpHead() {
    const j = jumpHead;
    if (!j || P.loading || P.stack.length !== j.depth || P.draftKeyOf(P.cur) !== j.key) return false;
    jumpHead = null;
    P.pendingScroll = false;
    if (P.mode === 'preview') {
      // 等 tick：本 effect 与 {@html} 块的更新同一轮 flush、effect 先跑，这时标题还没进 DOM（同代码块头那条）
      tick().then(() => {
        const sc = P.docScrollEl;
        if (!scrollToHeading(j.head, { instant: true }) || !sc) return;
        const st0 = sc.scrollTop;   // 图片/公式晚到撑高了上文：过一会儿再对一次（用户已经动手就不管）
        setTimeout(() => { if (sc.isConnected && Math.abs(sc.scrollTop - st0) <= 2) findHeadEl(j.head)?.scrollIntoView({ block: 'start' }); }, 250);
      });
    } else if (P.editor && !P.editor.scrollToHeading(j.head, { select: false })) P.showToast(t('找不到标题「{name}」', { name: j.head }));
    return true;
  }
  // 标题匹配：先比原文（忽略大小写、首尾空白），再比 slug 口径（空白/下划线/连字符算同一个 -、去标点）——
  // 相对链接的 #片段常写成 GitHub 式 slug；Obsidian 的 [[笔记#父标题#子标题]] 认最后一段
  const headSlug = (s) => String(s).trim().toLowerCase().replace(/[\s_-]+/g, '-').replace(/[^\p{L}\p{N}-]/gu, '');
  function findHeadEl(txt) {
    const hs = [...(mdEl?.querySelectorAll('h1,h2,h3,h4,h5,h6') || [])];
    const raw = String(txt).trim(), last = raw.split('#').filter((s) => s.trim()).pop()?.trim() || raw;
    for (const w of raw === last ? [raw] : [raw, last]) {
      const lw = w.toLowerCase(), sw = headSlug(w);
      const h = hs.find((x) => x.textContent.trim().toLowerCase() === lw) || (sw && hs.find((x) => headSlug(x.textContent) === sw));
      if (h) return h;
    }
    return null;
  }
  function scrollToHeading(txt, { instant = false } = {}) {
    const h = findHeadEl(txt);
    if (h) { h.scrollIntoView({ behavior: instant ? 'auto' : 'smooth', block: 'start' }); return true; }
    P.showToast(t('找不到标题「{name}」', { name: txt }));
    return false;
  }
  async function resolveWiki(name, head = '') {
    const c = P.cur, k = String(name).toLowerCase();
    const hit = P.links?.outgoing?.find((o) => o.path && o.name.toLowerCase() === k)
      || P.findInNames(await P.linkNames(c), name);   // 出链只在保存后重算：编辑时新写的 [[X]] 先查补全名单
    if (c !== P.cur) return;                         // 等名单期间已经跳走了
    if (hit) {
      if (MD_EXT_RE.test(hit.path)) {
        // [[本篇#标题]]：就地跳，不再把同一篇压一层栈重载
        if (head && hit.path === P.cur.saveTarget?.rel) {
          if (P.mode === 'preview') scrollToHeading(head);
          else if (!P.editor?.scrollToHeading(head)) P.showToast(t('找不到标题「{name}」', { name: head }));
          return;
        }
        return openNote(hit.path, head);
      }
      P.openAttachment(hit.path);   // 附件类：应用内统一查看器（曾经 window.open 在桌面壳会被丢去系统浏览器）
      return;
    }
    if (P.cur.saveTarget?.origin === 'local') return resolveLocalWiki(name, head);
    // 产物 md 没有全库索引：[[名字]] 按同目录的「名字.md」开
    if (!P.cur.saveTarget && artifactRef(P.cur)) return openRelNote(MD_EXT_RE.test(name) ? name : name + '.md', head);
    P.showToast(P.links ? t('未找到笔记「{name}」', { name }) : t('链接索引加载中…'));
  }
  function resolveLocalWiki(name, head = '') {
    const dir = P.dirOf(P.cur.saveTarget.rel);
    let l; try { l = localList(dir); } catch {}
    const arr = Array.isArray(l?.items) ? l.items : Array.isArray(l) ? l : [];
    const k = String(name).toLowerCase();
    const hit = arr.find((f) => f && !f.isDir && MD_EXT_RE.test(f.name || '') && String(f.name).replace(/\.[^.]+$/, '').toLowerCase() === k);
    if (hit) openNote(P.joinRel(dir, hit.name), head);
    else P.showToast(t('未找到笔记「{name}」', { name }));
  }
  // 相对链接拆成 路径 + #片段（片段交给 openNote 定位标题，不再直接扔掉）
  function splitHref(href) {
    const s = String(href), i = s.indexOf('#');
    let p = i < 0 ? s : s.slice(0, i), h = i < 0 ? '' : s.slice(i + 1);
    try { p = decodeURIComponent(p); } catch {}
    try { h = decodeURIComponent(h); } catch {}
    return [p, h];
  }
  // 阅读态给代码块补围栏头（语言 + 复制）——编辑态的 fence head 有这一条，两边得长一样。
  // 四空格缩进式代码块（pre.indented）编辑态没有围栏行、也就没有头，这里也不补。
  // 等 tick：本 effect 和 {@html} 块的更新在同一轮 flush 里，effect 先跑——直接插会插进马上被
  // 换掉的旧 DOM（katex 到货/正文变了、块字符串变化时整块重建，头就丢了；实测首次打开带公式的
  // 笔记一个头都没有）。tick 之后 DOM 已是新的。
  $effect(() => {
    mdBlocks;
    const el = mdEl;
    if (!el) return;
    tick().then(() => {
      for (const pre of el.querySelectorAll('pre:not(.indented)')) {
        if (pre.firstElementChild?.classList.contains('doc-fence')) continue;
        const lang = (String(pre.querySelector('code')?.className || '').match(/language-([\w+#-]+)/) || [])[1] || '';
        const head = document.createElement('div');
        head.className = 'doc-fence';
        head.innerHTML = '<span class="doc-fence-lang"></span><button type="button" class="doc-fence-copy">' + t('复制') + '</button>';
        head.firstChild.textContent = lang;
        pre.insertBefore(head, pre.firstChild);
      }
      // 带语言的代码块上色（与编辑态同一套解析器与配色）：有这种块才懒加载高亮模块
      const codes = [...el.querySelectorAll('pre:not(.indented) > code[class*="language-"]:not([data-hl])')];
      if (codes.length) import('../../../lib/mdeditor/hl.js').then((m) => { for (const c of codes) m.highlightPre(c); }).catch(() => {});
    });
  });

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch {}
    ta.remove();
    return ok;
  }

  // 脚注跳转：点上标 → 滚到文末对应条目；条目里的 ↩ → 回到刚才点的那个引用处
  //（同一脚注被引用多次时回到点过的那一处，没点过就回第一处）。落点闪一下，找得到自己跳到了哪儿。
  let lastFnRef = null;
  function jumpFootnote(a) {
    const id = a.dataset.fn || '';
    const esc = window.CSS?.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
    const q = (sel) => mdEl?.querySelector(sel.replace('$', () => esc));
    let dest;
    if (a.classList.contains('fn-back')) {
      dest = lastFnRef?.isConnected && lastFnRef.dataset.fn === id ? lastFnRef : q('sup.fn-ref a[data-fn="$"]');
    } else {
      lastFnRef = a;
      dest = q('section.footnotes li[data-fn="$"]');
    }
    if (!dest) return;
    dest.scrollIntoView({ behavior: 'smooth', block: 'center' });
    dest.classList.remove('fn-flash');
    void dest.offsetWidth;                    // 重触发动画（连点同一处）
    dest.classList.add('fn-flash');
    setTimeout(() => dest.classList.remove('fn-flash'), 1300);
  }

  // —— 阅读态勾任务（Obsidian 阅读视图同款）：可自动保存的笔记才放开勾选框，点了改源码里那一处 [ ] / [x] 并落盘 ——
  // 勾选框与源码按出现顺序一一对应（跳过 frontmatter 与代码围栏）；数目对不上（嵌入、HTML 里手写的框）就不动，提示去编辑态
  $effect(() => {
    mdBlocks;
    const el = mdEl, on = P.mdAuto;
    if (!el) return;
    tick().then(() => { for (const cb of el.querySelectorAll('input.task-cb')) cb.disabled = !on; });
  });
  const TASK_RE = /^((?:[ \t]*>)*[ \t]*(?:[-*+]|\d+[.)])[ \t]+)\[([ xX])\](?=[ \t])/;
  function taskMarks(text) {
    const out = [];
    const fm = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
    let i = fm ? fm[0].length : 0, fence = '';
    while (i < text.length) {
      let j = text.indexOf('\n', i);
      if (j < 0) j = text.length;
      const line = text.slice(i, j);
      const f = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})/.exec(line);
      if (fence) { if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = ''; }
      else if (f) fence = f[1];
      else { const m = TASK_RE.exec(line); if (m) out.push({ pos: i + m[1].length + 1, on: m[2] !== ' ' }); }
      i = j + 1;
    }
    return out;
  }
  // 点中的勾选框：直接点在框上；触屏再放宽到框四周 14px（框 17px，命中 ≥44px）
  function taskCbAt(e) {
    if (!P.mdAuto || !mdEl) return null;
    const tg = e.target;
    if (tg?.matches?.('input.task-cb')) return tg;
    if (!P.viewer.touch) return null;
    const cb = tg?.closest?.('li.task-list-item')?.querySelector(':scope > .task-body input.task-cb');
    if (!cb) return null;
    const r = cb.getBoundingClientRect();
    return e.clientX >= r.left - 14 && e.clientX <= r.right + 14 && e.clientY >= r.top - 14 && e.clientY <= r.bottom + 14 ? cb : null;
  }
  function toggleTask(cb, was) {
    const all = [...mdEl.querySelectorAll('input.task-cb')], idx = all.indexOf(cb);
    const marks = taskMarks(P.content), m = marks[idx];
    if (idx < 0 || marks.length !== all.length || !m || m.on !== was) { P.showToast(t('这一项没法在阅读态勾选，请到编辑态修改')); return; }
    P.content = P.content.slice(0, m.pos) + (m.on ? ' ' : 'x') + P.content.slice(m.pos + 1);
    P.save(true);
  }

  function mdClick(e) {
    const tcb = taskCbAt(e);
    if (tcb) { e.preventDefault(); e.stopPropagation(); toggleTask(tcb, tcb === e.target ? !tcb.checked : tcb.checked); return; }
    const cp = e.target.closest('.doc-fence-copy');
    if (cp) {
      e.stopPropagation();
      copyText(cp.closest('pre')?.querySelector('code')?.textContent || '');
      cp.textContent = t('已复制');
      setTimeout(() => (cp.textContent = t('复制')), 1200);
      return;
    }
    const fn = e.target.closest('sup.fn-ref a, a.fn-back');
    if (fn) { e.preventDefault(); jumpFootnote(fn); return; }
    const a = e.target.closest('a');
    if (!a) return;
    if (a.classList.contains('wk')) {
      e.preventDefault();
      const name = a.dataset.wk || '', head = a.dataset.head || '';
      if (!name) { if (head) scrollToHeading(head); return; }
      resolveWiki(name, head);
      return;
    }
    // 相对附件链接：obsmd 已把 href 改写成可加载地址、原文记在 data-rel——点开走应用内查看器，不让浏览器整页跳到裸文件
    const dataRel = a.getAttribute('data-rel');
    if (dataRel) { e.preventDefault(); openRelFile(dataRel); return; }
    const href = a.getAttribute('href') || '';
    const att = href && P.embedBack.get(href);   // 改写过的相对附件链接：认回原文件，压一层打开
    if (att && !MD_EXT_RE.test(att)) { e.preventDefault(); P.openAttachment(att); return; }
    if (!href || /^([a-z][a-z0-9+.-]*:|\/)/i.test(href)) return;   // 外链 / 站内 URL / 其他协议放行
    if (href.startsWith('#')) { e.preventDefault(); let h = href.slice(1); try { h = decodeURIComponent(h); } catch {} scrollToHeading(h); return; }
    e.preventDefault();   // 余下都是相对路径：一律查看器内接管
    const [p, h] = splitHref(href);
    if (!p) return;
    if (MD_EXT_RE.test(p)) openRelNote(p, h);
    else openRelFile(p);
  }

  // —— 相对链接（[另一篇](b.md)、[日志](logs/a.log)、[附件](../x.pdf)）：按这篇所在目录解析 ——
  // 工作空间 / 手机本地按 saveTarget；Claude / Codex / dimensio 产物（没有 saveTarget）按产物接口（lib/docres.js）
  function relDescOf(p) {
    const st = P.cur.saveTarget;
    if (!st) return siblingDesc(P.cur, p);
    const hit = P.links?.outgoing?.find((o) => o.path && o.name.toLowerCase() === String(p).toLowerCase());
    const rel = hit ? hit.path : P.joinRel(P.dirOf(st.rel), p);
    if (!rel) return null;
    const name = rel.split('/').pop();
    return st.origin === 'local' ? { origin: 'local', rel, name } : { origin: 'cloud', rel, name, ws: st.ws || '', nativeLocation: st.nativeLocation || '' };
  }
  function pushDoc(d, head = '') {
    P.guardDirty(() => {
      const it = normalizeItem(d.origin === 'local' ? { ...d, text: localReadText(d.rel) } : d);
      P.stack = [...P.stack, it];
      jumpHead = head ? { key: P.draftKeyOf(it), depth: P.stack.length, head } : null;
    });
  }
  function openRelNote(p, head = '') {
    if (P.cur.saveTarget) { openNote(P.joinRel(P.dirOf(P.cur.saveTarget.rel), p), head); return; }
    const d = siblingDesc(P.cur, p);
    if (d) pushDoc(d, head);
    else P.showToast(t('无法打开这个链接'));
  }
  // 文本类（代码 / 日志 / CSV…）压进本查看器的栈（返回回到这篇）；其余（图 / PDF / 音视频 / 网页…）
  // 在统一查看器里压一层打开（openAttachDesc），返回落回这篇笔记的原位置
  function openRelFile(p) {
    const d = relDescOf(p);
    if (!d) { P.showToast(t('无法打开这个链接')); return; }
    const k = kindOf(d.name);
    if (k === 'text' || k === 'markdown' || /\.(csv|tsv)$/i.test(d.name)) pushDoc(d);
    else P.openAttachDesc(d);
  }


  return {
    get copyText() { return copyText; },
    get mdBlocks() { return mdBlocks; }, set mdBlocks(v) { mdBlocks = v; },
    get mdClick() { return mdClick; },
    get mdEl() { return mdEl; }, set mdEl(v) { mdEl = v; },
    get mdRendering() { return mdRendering; }, set mdRendering(v) { mdRendering = v; },
    get openNote() { return openNote; },
    get openRelFile() { return openRelFile; },
    get openRelNote() { return openRelNote; },
    get pageEl() { return pageEl; }, set pageEl(v) { pageEl = v; },
    get resolveWiki() { return resolveWiki; },
    get splitHref() { return splitHref; },
    get splitTopBlocks() { return splitTopBlocks; },
    get tailEl() { return tailEl; }, set tailEl(v) { tailEl = v; },
    get tailHost() { return tailHost; }, set tailHost(v) { tailHost = v; },
    get takeJumpHead() { return takeJumpHead; },
  };
}
