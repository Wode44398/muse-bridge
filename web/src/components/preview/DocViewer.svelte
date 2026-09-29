<script>
  // 文档查看/编辑器（亮色文档 surface，自带头部，盖在 MediaViewer 暗壳之上）。
  // Markdown 走 Obsidian 式三态：阅读（obsmd 渲染）｜编辑（Live Preview，CM6 懒加载，
  // 光标进块显源码、表格 Excel 式常驻编辑）｜源码（同一 CM 实例关装饰）。
  // 纯文本/代码仍是 textarea 源码编辑。保存写回服务端(/api/file/save)。
  //   · Obsidian 风笔记补全：frontmatter「笔记属性」面板、[[双链]]/相对 md 链接查看器内跳转
  //     （导航栈，返回逐级回退）、#标签 / ==高亮== / callout、底部「反向链接 / 出链」面板
  //     （/api/file/mdlinks，云端）+ 词数统计
  //   · md 编辑态防抖自动保存（失败退草稿+限次重试）；未保存草稿按文件键存内存，误关再开自动恢复
  //   · 键盘避让（padding-bottom: --kb）；返回自动落盘（不可保存时才弹确认）
  import { untrack } from 'svelte';
  import { api } from '../../lib/api.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { normalizeItem, cloudFileUrl, openPreview, preview } from '../../lib/preview.svelte.js';
  import { parseNote, renderObsMarkdown, renderPropWikilinks, noteStats, escapeHtml, escapeRegex, propKind, PROP_ICONS, MD_EXT_RE } from '../../lib/obsmd.js';
  import { findSafeCut } from '../../lib/md.js';
  import { setPreviewDetail } from '../../lib/preview.svelte.js';
  import { registerDraft } from '../../lib/uiReport.js';
  import { fsChange, fsMatches } from '../../lib/fsSync.svelte.js';
  import { IS_SHARE } from '../../lib/share.js';
  import { t, tr, locale } from '../../lib/i18n.js';

  let { item, onClose } = $props();

  // —— 双链导航栈：栈顶=当前文档；[[链接]]/反链点击 push、返回 pop（系统返回同步接管）——
  let stack = $state([item]);
  const cur = $derived(stack[stack.length - 1]);
  const isMd = $derived(cur.kind === 'markdown');
  const isText = $derived(cur.kind === 'text' || isMd);
  // 公开分享页（/w/）是只读身份：写接口对 share 一律 401，编辑入口直接不给。
  const editable = $derived(!IS_SHARE && !!cur.saveTarget);

  // —— 未保存草稿（按文件键存内存，跨重开恢复）——
  const DRAFTS = (window.__bridgeDocDrafts ||= new Map());
  const draftKeyOf = (c) => (c.saveTarget ? c.saveTarget.origin + ':' + (c.saveTarget.ws || '') + ':' + c.saveTarget.rel : c.key);
  const linksKeyOf = (c) => (c.saveTarget?.ws || '') + ':' + (c.saveTarget?.rel || '');
  const draftKey = $derived(draftKeyOf(cur));

  let content = $state(''), original = $state('');
  // md：'preview'(阅读) | 'live'(编辑=Live Preview) | 'source'(源码)；文本文件：'edit'(textarea)
  let mode = $state('preview');
  let loading = $state(true), loadError = $state(false), saving = $state(false);
  let restored = $state(false);
  let toast = $state('');
  const dirty = $derived(content !== original);

  // —— 工作区协同：编辑态上抛（agent 的 workspace.view 看得到模式与未保存标记）+
  // 草稿提供者（agent draft() 拿编辑器里的当前全文，防止它拿磁盘旧稿盖掉用户没存的字）。
  $effect(() => { setPreviewDetail({ mode, dirty }); });
  $effect(() => registerDraft(() => ({
    rel: cur?.saveTarget?.rel || cur?.name || '',
    ws: cur?.saveTarget?.ws || '',
    mode, dirty, text: content,
  })));

  const MD_MODES = ['preview', 'live', 'source'];
  const lastMdMode = () => (MD_MODES.includes(window.__bridgeMdMode) ? window.__bridgeMdMode : 'preview');
  function setMdMode(m) {
    if (m === mode) return;
    if (m === 'preview' && mode !== 'preview' && dirty && isMd && editable) save(true);   // 切回阅读即落盘
    grabScroll();            // 换模式不回到顶部：先记下进度，新模式渲染完按比例落回原处
    pendingScroll = true;
    mode = m;
    window.__bridgeMdMode = m;
  }

  // —— 模式切换保住阅读进度 ——
  // 换算走「标题锚点 + 段内比例」：标题在源码与渲染结果里一一对应（顺序一致），拿它当刻度，
  // 段内再按比例插值，两态落点就在同一处。不用整篇像素比例——编辑态是 CM 虚拟滚动，
  // 视口外的高度是估算值，纯比例会偏出几屏（实测差两节）。传递的是**源码位置**，
  // 编辑侧交给 CM 自己的 scrollIntoView（它边测边修，估算不影响落点）。
  let docScrollEl = $state(null);
  let anchorPos = 0, pendingScroll = false;

  // 分段刻度：[文首, 各级标题…, 文末] 的源码偏移 ↔ 阅读态页内 y
  function headAnchors() {
    const page = docScrollEl?.firstElementChild;
    if (!mdEl || !page || !note) return null;
    const fmLen = content.length - note.body.length;
    const srcHeads = [];
    let fence = false, off = 0;
    for (const l of note.body.split('\n')) {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      else if (!fence && /^#{1,6}\s/.test(l)) srcHeads.push(fmLen + off);
      off += l.length + 1;
    }
    const els = [...mdEl.querySelectorAll('h1,h2,h3,h4,h5,h6')];
    const n = Math.min(srcHeads.length, els.length);
    const pageTop = page.getBoundingClientRect().top;
    const src = [0], read = [0];
    for (let i = 0; i < n; i++) {
      const y = els[i].getBoundingClientRect().top - pageTop;
      if (y <= read[read.length - 1]) continue;   // 保持单调，插值才成立
      src.push(srcHeads[i]);
      read.push(y);
    }
    src.push(content.length);
    read.push(Math.max(page.offsetHeight, read[read.length - 1] + 1));
    return { src, read };
  }
  function interp(v, from, to) {
    let i = 0;
    while (i < from.length - 2 && from[i + 1] <= v) i++;
    const f = Math.max(0, Math.min(1, (v - from[i]) / Math.max(1, from[i + 1] - from[i])));
    return to[i] + f * (to[i + 1] - to[i]);
  }

  function grabScroll() {
    if (mode !== 'preview') { anchorPos = editor?.topPos?.() ?? anchorPos; return; }
    const a = headAnchors();
    if (a && docScrollEl) anchorPos = interp(docScrollEl.scrollTop, a.read, a.src);
  }
  function applyScroll() {
    if (mode !== 'preview') { editor?.scrollToPos?.(anchorPos); return; }
    // 阅读态高度还会因图片解码变，补两拍；用户一动手立刻收手，不跟人抢滚动
    let last = -1, n = 0;
    const put = () => {
      const sc = docScrollEl;
      if (!sc || !sc.isConnected || mode !== 'preview') return true;
      if (last >= 0 && Math.abs(sc.scrollTop - last) > 2) return true;
      const a = headAnchors();
      if (a) sc.scrollTop = Math.max(0, Math.min(interp(anchorPos, a.src, a.read), sc.scrollHeight - sc.clientHeight));
      last = sc.scrollTop;
      return false;
    };
    put();
    const id = setInterval(() => { if (put() || ++n >= 3) clearInterval(id); }, 60);
  }
  $effect(() => {
    const el = docScrollEl;
    mdBlocks;                                   // 阅读态 DOM 渲染完再落位
    if (mdRendering) return;                    // 分块途中标题还没长全，等全量出齐再插值
    if (!pendingScroll || mode !== 'preview' || !el) return;
    pendingScroll = false;
    applyScroll();
  });

  let toastT = null;
  function showToast(m) { toast = m; clearTimeout(toastT); toastT = setTimeout(() => (toast = ''), 1800); }

  let seq = 0;   // 竞态闸：快速连点双链时只认最后一次加载
  let loadCtrl = null;   // 在途加载的中止柄：换文档/卸载时掐掉，不陪葬
  async function load() {
    const my = ++seq, c = cur;
    loading = true; loadError = false; restored = false;
    mode = c.kind === 'markdown' ? lastMdMode() : 'edit';
    loadLinks(c);
    if (!(c.kind === 'text' || c.kind === 'markdown')) { loading = false; return; }
    try {
      let text;
      if (c.text != null) text = c.text;                       // 本地：调用方已读
      else {
        // 首包 12s 超时——切后台回来的半开 socket 会让 fetch 永挂（转圈永远转的元凶，
        // 同聊天流 07-30 看门狗的病根）；头到了正文另给 120s 兜底，超时/断网走「重试」错误态。
        loadCtrl?.abort();
        const ctrl = (loadCtrl = new AbortController());
        let timer = setTimeout(() => ctrl.abort(), 12000);
        try {
          const r = await fetch(c.url, { credentials: 'same-origin', signal: ctrl.signal });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          clearTimeout(timer);
          timer = setTimeout(() => ctrl.abort(), 120000);
          text = await r.text();
        } finally { clearTimeout(timer); }
      }
      if (my !== seq) return;
      original = text;
      const dk = draftKeyOf(c);
      if (DRAFTS.has(dk)) { content = DRAFTS.get(dk); restored = true; if (c.kind === 'markdown') mode = 'live'; }
      else content = text;
      loading = false;
    } catch { if (my === seq) { loadError = true; loading = false; } }
  }
  $effect(() => { cur; load(); });   // 挂载/换文档（含双链跳转）即加载

  function onEdit() { if (dirty) DRAFTS.set(draftKey, content); else DRAFTS.delete(draftKey); }
  $effect(() => { content; if (!loading) onEdit(); });   // 编辑即存草稿

  // —— agent 跟盘：Claude 的 Edit/Write 落盘成功（SSE fs 事件）→ 当前文档自动重载 ——
  // 只在无风险时刷：① 命中当前文档（rel 后缀 + ws 前缀匹配）；② 用户手上没有未保存
  // 内容（dirty/saving 一律不动，草稿优先）；③ md 限阅读态（CM 编辑器外改 content
  // 不回灌 doc，会出现「看的和存的不一致」）；文本文件 textarea 双向绑定没这个问题。
  // 静默换文：不走 load()（那会闪加载态、重置模式），拉到新文后按标题锚点保住阅读进度。
  let fsT = null;
  async function refreshFromDisk() {
    const my = ++seq, c = cur;
    if (c.text != null || !c.url) return;   // 内联文本不是 agent 改的对象
    try {
      const bust = c.url + (c.url.includes('?') ? '&' : '?') + '_fs=' + Date.now();
      const r = await fetch(bust, { credentials: 'same-origin' });
      if (!r.ok) return;
      const text = await r.text();
      if (my !== seq || dirty || saving) return;   // 拉取期间用户动了手：放弃这次跟盘
      if (text === original) return;
      grabScroll();
      pendingScroll = true;
      original = text;
      content = text;
      showToast(t('已同步 Claude 的修改'));
    } catch { /* 跟盘失败无害，下次事件再试 */ }
  }
  let fsSeen = 0;   // 只认新事件：效应因 mode/dirty 等其它依赖重跑时不重复拉取
  $effect(() => {
    if (fsChange.seq === fsSeen) return;
    const st = cur?.saveTarget;
    if (!fsChange.path || loading || !st || st.origin !== 'cloud') return;
    if (!fsMatches(fsChange.path, { ws: st.ws || '', rel: st.rel || '' })) return;
    if (dirty || saving) return;
    if (isMd && mode !== 'preview') return;
    fsSeen = fsChange.seq;
    clearTimeout(fsT);
    fsT = setTimeout(() => untrack(refreshFromDisk), 400);   // 连续多次 Edit 只刷最后一拍
    return () => clearTimeout(fsT);
  });

  let saveT = null, saveFails = 0, lastLinksRefresh = 0;
  async function save(quiet = false) {
    if (!editable || saving || !dirty) return;
    saving = true;
    try {
      await api.saveFile(cur.saveTarget.rel, content, cur.saveTarget.ws);
      original = content; DRAFTS.delete(draftKey); restored = false; saveFails = 0;
      const now = Date.now();
      if (now - lastLinksRefresh > 10_000) {   // 正文变了 → 出链/反链重算（限频，自动保存别刷爆）
        lastLinksRefresh = now;
        LINKS_CACHE.delete(linksKeyOf(cur));
        loadLinks(cur);
      }
      if (!quiet) showToast(t('已保存'));
    } catch (e) { saveFails++; showToast(t('保存失败：{reason}', { reason: tr(e?.body?.error || e?.message || '') })); }
    finally {
      saving = false;
      // 失败重试（限 3 次）；草稿始终兜底，不丢内容
      if (dirty && saveFails > 0 && saveFails < 3 && editable) { clearTimeout(saveT); saveT = setTimeout(() => save(true), 3000); }
    }
  }

  // md 编辑态：停笔 1.2s 自动落盘（Obsidian 无保存键心智）；文本文件仍手动保存
  $effect(() => {
    content;
    if (loading || !isMd || !editable || mode === 'preview' || !dirty) return;
    clearTimeout(saveT);
    saveT = setTimeout(() => save(true), 1200);
    return () => clearTimeout(saveT);
  });

  // md 可保存 → 离开时静默落盘（失败有草稿兜底）；只有不可自动保存时才弹确认
  function guardDirty() {
    if (!dirty) return true;
    if (isMd && editable) { save(true); return true; }
    return confirm(t('有未保存的修改，确定离开？（草稿会临时保留）'));
  }
  function back() {
    if (!guardDirty()) return;
    if (stack.length > 1) stack = stack.slice(0, -1);
    else onClose?.();
  }
  function popNote() { if (stack.length > 1 && guardDirty()) stack = stack.slice(0, -1); }
  $effect(() => { if (stack.length > 1) return pushBackLayer(popNote); });   // 系统返回：先弹笔记栈，再轮到关查看器

  // —— md 双链数据（/api/file/mdlinks；按 rel 缓存，返回导航秒出，后台刷新）——
  const LINKS_CACHE = (window.__bridgeMdLinks ||= new Map());
  let links = $state(null);
  async function loadLinks(c) {
    links = null;
    // 双链/反链由服务端算（/api/file/mdlinks）。
    if (c.kind !== 'markdown' || c.saveTarget?.origin !== 'cloud') return;
    const rel = c.saveTarget.rel, cacheKey = linksKeyOf(c);
    if (LINKS_CACHE.has(cacheKey)) links = LINKS_CACHE.get(cacheKey);
    try {
      const r = await api.mdLinks(rel, c.saveTarget.ws);
      LINKS_CACHE.set(cacheKey, r);
      if (linksKeyOf(cur) === cacheKey) links = r;
    } catch {}
  }
  const outLinks = $derived(links?.outgoing?.filter((o) => !o.embed) || []);
  const blCount = $derived(links?.backlinks?.reduce((n, b) => n + b.count, 0) || 0);

  // —— 笔记结构：frontmatter 属性 + 正文渲染 + 统计 ——
  const note = $derived(isMd ? parseNote(content) : null);
  const stats = $derived(note ? noteStats(note.body) : null);
  let propsOpen = $state(true);

  const dirOf = (rel) => String(rel || '').split('/').slice(0, -1).join('/');
  function joinRel(dir, p) {
    const segs = (dir ? dir.split('/') : []).concat(String(p).split('/'));
    const out = [];
    for (const s of segs) { if (!s || s === '.') continue; s === '..' ? out.pop() : out.push(s); }
    return out.join('/');
  }
  // ![[嵌入]] / 相对资源 → 可加载 URL：mdlinks 已解析的路径优先，回落同目录拼接
  function embedUrl(name) {
    const st = cur.saveTarget;
    if (!st) return null;
    const hit = links?.outgoing?.find((o) => o.path && o.name.toLowerCase() === String(name).toLowerCase());
    const rel = hit ? hit.path : joinRel(dirOf(st.rel), name);
    return cloudFileUrl(rel, { ws: st.ws });
  }
  // —— 阅读态分块渐进渲染 ——
  // 整篇同步 renderObsMarkdown 在大文档（长研报/大量公式表格）上会把主线程冻住十几秒起：
  // 转圈是合成器线程在动、点返回却毫无反应——「卡加载还退不出去」的真相就是这一口气渲染。
  // 复用聊天流式的 findSafeCut 顶层块切点把正文切成 ~8KB 块：首块当帧就出，其余块按
  // 每帧 ~12ms 预算分帧追加，返回/切模式随时点随时走。块前缀字符串不变，Svelte each
  // 直接跳过已渲染块，追加只长尾巴。
  let mdBlocks = $state([]);        // 已出炉的 HTML 块
  let mdRendering = $state(false);  // 队列里还有块（文末出细转圈）
  let renderJob = 0;
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
    // 显式依赖：正文 + 双链索引（![[嵌入]]/相对资源 URL 靠 links 解析，索引到货要重渲染）
    const body = isMd && mode === 'preview' && !loading && !loadError ? (note?.body ?? '') : null;
    links;
    const job = ++renderJob;
    if (body == null) { mdBlocks = []; mdRendering = false; return; }
    const parts = splitTopBlocks(body);
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
      while (acc.length < parts.length && performance.now() - t0 < 12) acc.push(renderObsMarkdown(parts[acc.length], { embedUrl }));
      mdBlocks = [...acc];
      if (acc.length < parts.length) { mdRendering = true; schedule(); }
      else mdRendering = false;
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
  function openNote(rel) {
    if (!guardDirty()) return;
    // name 必须取 rel 的真实文件名（带扩展名）——normalize 按 name 推 kind，
    // 反链/出链给的是去掉 .md 的展示名，直接用会被当成未知类型走占位页。
    const base = { rel, name: rel.split('/').pop() };
    stack = [...stack, normalizeItem({ origin: 'cloud', ...base, ws: cur.saveTarget?.ws || '' })];
  }
  function scrollToHeading(txt) {
    const want = String(txt).trim().toLowerCase();
    for (const h of mdEl?.querySelectorAll('h1,h2,h3,h4,h5,h6') || []) {
      if (h.textContent.trim().toLowerCase() === want) { h.scrollIntoView({ behavior: 'smooth', block: 'start' }); return; }
    }
    showToast(t('找不到标题「{name}」', { name: txt }));
  }
  function resolveWiki(name) {
    const k = String(name).toLowerCase();
    const hit = links?.outgoing?.find((o) => o.path && o.name.toLowerCase() === k);
    if (hit) {
      if (MD_EXT_RE.test(hit.path)) return openNote(hit.path);
      openAttachment(hit.path);   // 附件类：应用内统一查看器
      return;
    }
    showToast(links ? t('未找到笔记「{name}」', { name }) : t('链接索引加载中…'));
  }
  // 阅读态给代码块补围栏头（语言 + 复制）——编辑态的 fence head 有这一条，两边得长一样
  $effect(() => {
    mdBlocks;
    if (!mdEl) return;
    for (const pre of mdEl.querySelectorAll('pre')) {
      if (pre.firstElementChild?.classList.contains('doc-fence')) continue;
      const lang = (String(pre.querySelector('code')?.className || '').match(/language-([\w+#-]+)/) || [])[1] || '';
      const head = document.createElement('div');
      head.className = 'doc-fence';
      head.innerHTML = '<span class="doc-fence-lang"></span><button type="button" class="doc-fence-copy">' + t('复制') + '</button>';
      head.firstChild.textContent = lang;
      pre.insertBefore(head, pre.firstChild);
    }
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

  function mdClick(e) {
    const cp = e.target.closest('.doc-fence-copy');
    if (cp) {
      e.stopPropagation();
      copyText(cp.closest('pre')?.querySelector('code')?.textContent || '');
      cp.textContent = t('已复制');
      setTimeout(() => (cp.textContent = t('复制')), 1200);
      return;
    }
    const a = e.target.closest('a');
    if (!a) return;
    if (a.classList.contains('wk')) {
      e.preventDefault();
      const name = a.dataset.wk || '', head = a.dataset.head || '';
      if (!name) { if (head) scrollToHeading(head); return; }
      resolveWiki(name);
      return;
    }
    const href = a.getAttribute('href') || '';
    if (!href || /^(https?:|mailto:|data:|blob:|tel:)/i.test(href) || href.startsWith('/')) return;   // 外链/已改写的站内 URL 放行
    if (href.startsWith('#')) { e.preventDefault(); let h = href.slice(1); try { h = decodeURIComponent(h); } catch {} scrollToHeading(h); return; }
    const clean = href.split('#')[0];
    if (MD_EXT_RE.test(clean)) {
      e.preventDefault();
      let p = clean; try { p = decodeURIComponent(clean); } catch {}
      openNote(joinRel(dirOf(cur.saveTarget?.rel || ''), p));
    }
  }

  // —— Live Preview / 源码编辑器（CM6，懒加载 chunk；同一实例双模切换）——
  let edEl = $state(null);
  let editor = null, edFor = null;   // 编辑器句柄非响应式；edFor=绑定的文件键
  const wantEditor = $derived(isMd && !loading && !loadError && (mode === 'live' || mode === 'source'));

  function destroyEditor() { try { editor?.destroy(); } catch {} editor = null; edFor = null; }

  // 外链：新标签打开。
  function openExt(url) {
    window.open(url, '_blank', 'noopener');
  }
  // 笔记里的附件（图/PDF/音视频…）：进应用内统一查看器（沿用当前宿主：全屏或 dock 内嵌）。
  function openAttachment(rel) {
    const st = cur.saveTarget || {};
    openPreview({ origin: 'cloud', rel, name: rel.split('/').pop(), ws: st.ws || '' }, 0, { host: preview.host });
  }

  function openRelHref(href) {
    const clean = String(href).split('#')[0];
    let p = clean; try { p = decodeURIComponent(clean); } catch {}
    if (!p) return;
    if (MD_EXT_RE.test(p)) { openNote(joinRel(dirOf(cur.saveTarget?.rel || ''), p)); return; }
    if (/^(https?:|mailto:|tel:)/i.test(p)) { openExt(p); return; }
    const hit = links?.outgoing?.find((o) => o.path && o.name.toLowerCase() === p.toLowerCase());
    openAttachment(hit ? hit.path : joinRel(dirOf(cur.saveTarget?.rel || ''), p));
  }

  $effect(() => {
    const want = wantEditor, el = edEl, m = mode, key = draftKey, ro = !editable;
    if (!want || !el) { destroyEditor(); return; }
    let gone = false;
    (async () => {
      const mod = await import('../../lib/mdeditor/index.js');
      if (gone || !edEl) return;
      if (editor && edFor === key) {
        editor.setMode(m === 'live' ? 'live' : 'source');
        if (pendingScroll) { pendingScroll = false; applyScroll(); }
        return;
      }
      destroyEditor();
      editor = mod.createMdEditor({
        parent: el,
        doc: untrack(() => content),
        mode: m === 'live' ? 'live' : 'source',
        readOnly: ro,
        onChange: (text) => { content = text; },
        onSave: () => save(),
        onNavigate: (name, head) => {
          if (name) resolveWiki(name);
          else if (head && !editor?.scrollToHeading(head)) showToast(t('找不到标题「{name}」', { name: head }));
        },
        openLink: (url) => openExt(url),
        openRel: openRelHref,
        resolveUrl: embedUrl,
        renderMd: (src) => renderObsMarkdown(src, { embedUrl }),
        tailEl: () => tailEl,
      });
      edFor = key;
      if (pendingScroll) { pendingScroll = false; applyScroll(); }
    })();
    return () => { gone = true; };
  });
  $effect(() => () => { destroyEditor(); loadCtrl?.abort(); });   // 组件卸载兜底：编辑器销毁 + 在途加载掐断

  // —— 属性面板（阅读态只读；编辑态的可写面板在 mdeditor/props.js，类型判定共用 obsmd.propKind）——
  const chipText = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : String(v));

  // 反链摘录：转义 + 命中本笔记名的片段加亮
  function blExcerpt(line) {
    const html = escapeHtml(line);
    try { return html.replace(new RegExp(escapeRegex(escapeHtml(String(cur.name).replace(/\.[^.]+$/, ''))), 'gi'), '<b>$&</b>'); }
    catch { return html; }
  }
</script>

<div class="doc-root">
  <header class="doc-head">
    <button class="doc-btn" aria-label={t('返回')} onclick={back}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>
    </button>
    <div class="doc-title-wrap">
      <span class="doc-title">{cur.name}</span>
      {#if dirty}<span class="doc-dirty" title={t('未保存')}>●</span>{/if}
    </div>
    {#if isMd}
      <div class="doc-seg">
        <span class="doc-seg-cap" style:transform="translateX({mode === 'live' ? '100%' : mode === 'source' ? '200%' : '0'})"></span>
        <button class:on={mode === 'preview'} onclick={() => setMdMode('preview')}>{t('阅读')}</button>
        <button class:on={mode === 'live'} onclick={() => setMdMode('live')}>{t('编辑')}</button>
        <button class:on={mode === 'source'} onclick={() => setMdMode('source')}>{t('源码')}</button>
      </div>
    {/if}
    {#if editable}
      <button class="doc-save" class:saved={!dirty && !saving} disabled={!dirty || saving} onclick={() => save()}>{saving ? t('保存中') : dirty ? t('保存') : t('已保存')}</button>
    {/if}
  </header>

  <div class="doc-body">
    {#if loading}
      <div class="doc-center"><span class="doc-spin"></span></div>
    {:else if loadError}
      <div class="doc-center doc-err"><p>{t('加载失败')}</p><button onclick={load}>{t('重试')}</button></div>
    {:else if !isText}
      <div class="doc-center"><p class="doc-ph-name">{cur.name}</p><p>{t('该类型预览即将到来')}</p>{#if cur.downloadHref}<a class="doc-dl" href={cur.downloadHref} download={cur.name}>{t('下载查看')}</a>{/if}</div>
    {:else if isMd && mode === 'preview'}
      <div class="doc-scroll" bind:this={docScrollEl}>
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
        <div class="doc-page" onclick={mdClick}>
          {#if note?.props?.length}
            <section class="doc-props">
              <button class="doc-props-h" onclick={(e) => { e.stopPropagation(); propsOpen = !propsOpen; }}>
                <svg class="doc-chev" class:closed={!propsOpen} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
                {t('笔记属性')}<span class="doc-props-n">{note.props.length}</span>
              </button>
              {#if propsOpen}
                <div class="doc-props-tbl sel-text">
                  {#each note.props as p (p.key)}
                    <div class="doc-prop">
                      <div class="doc-prop-k">{@html PROP_ICONS[propKind(p)] || PROP_ICONS.text}<span>{p.key}</span></div>
                      <div class="doc-prop-v">
                        {#if propKind(p) === 'tags'}
                          {#each p.value as v}<span class="doc-chip doc-chip-tag">#{chipText(v)}</span>{/each}
                        {:else if propKind(p) === 'list'}
                          {#each p.value as v}<span class="doc-chip">{@html renderPropWikilinks(chipText(v))}</span>{/each}
                        {:else if propKind(p) === 'json'}
                          <code class="doc-prop-json">{JSON.stringify(p.value)}</code>
                        {:else if propKind(p) === 'bool'}
                          <input type="checkbox" checked={p.value} disabled>
                        {:else if String(p.value) === ''}
                          <span class="doc-prop-empty">{t('空')}</span>
                        {:else}
                          <span class="doc-prop-txt">{@html renderPropWikilinks(String(p.value))}</span>
                        {/if}
                      </div>
                    </div>
                  {/each}
                </div>
              {/if}
            </section>
          {/if}

          <div class="doc-md sel-text" bind:this={mdEl}>{#each mdBlocks as b}{@html b}{/each}</div>
          {#if mdRendering}<div class="doc-rendering"><span class="doc-spin"></span></div>{/if}

          <!-- 尾栏落位点：阅读态把共用的 .doc-tail 收编到这儿（编辑态则由 CM 文末 widget 收编） -->
          <div class="doc-tailhost" bind:this={tailHost}></div>
        </div>
      </div>
    {:else if isMd}
      <!-- 编辑（Live Preview）/ 源码：CM6 编辑器，懒加载；容器常驻由 effect 填充。
           格式工具全在编辑器自带的选中浮条 + 右键菜单里（mdeditor/menu.js），无底部工具栏 -->
      <div class="doc-cm" bind:this={edEl}></div>
    {:else}
      <textarea class="doc-edit" bind:value={content} spellcheck="false" autocapitalize="off" autocomplete="off"
        placeholder={editable ? '' : t('（只读）')} readonly={!editable}></textarea>
    {/if}
  </div>

  <!-- 文末尾栏（反向链接 / 出链 / 词数）：阅读态与编辑态**共用这一份 DOM**——阅读态挂进
       .doc-tailhost，编辑态由 CM 文末块 widget（mdeditor/tail.js）收编，两边观感天然一致。
       故意常驻在模式分支之外：分支切换时 Svelte 先换 DOM 后跑 effect，若归分支所有会在
       编辑器销毁前被摘走，留给 CM 一个悬空节点。 -->
  <div class="doc-tail" bind:this={tailEl} hidden>
    {#if isMd && !loading && !loadError}
      {#if blCount || outLinks.length}
        <section class="doc-links">
          {#if links?.backlinks?.length}
            <div class="doc-lk-h">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a4 4 0 0 0 6 0l3-3a4 4 0 0 0-6-6l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-6 0l-3 3a4 4 0 0 0 6 6l1.5-1.5"/></svg>
              {t('反向链接')}<span class="doc-lk-n">{blCount}</span>
            </div>
            <div class="doc-bls">
              {#each links.backlinks as b (b.path)}
                <button class="doc-bl" onclick={(e) => { e.stopPropagation(); openNote(b.path); }}>
                  <div class="doc-bl-name">{b.name}{#if b.count > 1}<span class="doc-bl-n">{b.count}</span>{/if}</div>
                  {#each b.excerpts as x}<div class="doc-bl-x">{@html blExcerpt(x)}</div>{/each}
                </button>
              {/each}
            </div>
          {/if}
          {#if outLinks.length}
            <div class="doc-lk-h">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M7 17 17 7M9 7h8v8"/></svg>
              {t('出链')}<span class="doc-lk-n">{outLinks.length}</span>
            </div>
            <div class="doc-outs">
              {#each outLinks as o (o.name)}
                <button class="doc-out" class:dead={!o.path} onclick={(e) => { e.stopPropagation(); resolveWiki(o.name); }}>{o.name}</button>
              {/each}
            </div>
          {/if}
        </section>
      {/if}
      {#if stats}
        <div class="doc-stats">{t('{n} 个词', { n: stats.words.toLocaleString(locale()) })} · {t('{n} 个字符', { n: stats.chars.toLocaleString(locale()) })}{#if links?.backlinks?.length}{' · '}{t('{n} 条反向链接', { n: links.backlinks.length })}{/if}</div>
      {/if}
    {/if}
  </div>

  {#if restored}<div class="doc-restored">{t('已恢复未保存草稿')}</div>{/if}
  {#if toast}<div class="doc-toast">{toast}</div>{/if}
</div>

<style>
  /* 配色令牌：与 mdeditor/editor.css 的 .mde 同名同值（阅读态/编辑态观感必须一致，改色两边一起改）。
     Anthropic/Claude 象牙白暖调：纸面 #faf9f5、字 #141413、强调 Claude 珊瑚 #d97757。 */
  .doc-root {
    --md-bg: #faf9f5; --md-bg-2: #f3f1eb; --md-bg-3: #eae7df; --md-panel: #fffefb;
    --md-line: #e7e4db; --md-line-2: #d6d2c6;
    --md-fg: #141413; --md-fg-2: #5f5e59; --md-fg-3: #8a8983; --md-fg-4: #b4b2aa;
    --md-accent: #d97757; --md-accent-deep: #b5532f; --md-accent-soft: rgba(217, 119, 87, .16); --md-accent-tint: rgba(217, 119, 87, .085);
    --md-link: #2f6fbf; --md-mark: rgba(235, 196, 98, .42); --md-math: #3f7a5a; --md-danger: #c2472f;
    --md-ok: #4f7d5a; --md-ok-bg: #e8efe6;
    --md-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --md-shadow-sm: 0 8px 24px rgba(70, 56, 34, .14), 0 1px 4px rgba(70, 56, 34, .06), 0 0 0 .5px rgba(20, 20, 19, .07);
    --md-ease: cubic-bezier(.2, .8, .2, 1);
    position: absolute; inset: 0; background: var(--md-bg); color: var(--md-fg); display: flex; flex-direction: column;
    padding-bottom: var(--kb, 0px);
  }

  .doc-head { flex: none; display: flex; align-items: center; gap: 8px; padding: max(8px, var(--sat)) 10px 8px;
    border-bottom: 1px solid var(--md-line); background: var(--md-bg); }
  .doc-btn { width: 36px; height: 36px; border-radius: 10px; display: flex; align-items: center; justify-content: center; color: var(--md-fg); flex: none;
    transition: background var(--mo-tap, 90ms); }
  .doc-btn svg { width: 21px; height: 21px; }
  @media (hover: hover) { .doc-btn:hover { background: var(--md-bg-2); } }
  .doc-btn:active { background: var(--md-bg-3); }
  .doc-title-wrap { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; }
  .doc-title { min-width: 0; font-size: 15px; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; letter-spacing: -.1px; }
  .doc-dirty { color: var(--md-accent); font-size: 10px; flex: none; }

  /* 阅读/编辑/源码 三段切换：暖灰轨道 + 白色滑帽 */
  /* 三段等宽（grid 1fr）：滑帽固定 1/3 宽，英文三段字长不一（Read/Edit/Source）时也对得齐 */
  .doc-seg { position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; background: var(--md-bg-2); border: 1px solid rgba(20, 20, 19, .05); border-radius: 10px; padding: 2px; flex: none; }
  .doc-seg-cap { position: absolute; top: 2px; left: 2px; width: calc(33.333% - 1.4px); height: calc(100% - 4px); background: #fff; border-radius: 8px;
    box-shadow: 0 1px 3px rgba(70, 56, 34, .14), 0 0 0 .5px rgba(20, 20, 19, .06); transition: transform var(--mo-quick, 200ms) var(--md-ease); }
  .doc-seg button { position: relative; z-index: 1; padding: 5px 11px; font-size: 12.5px; color: var(--md-fg-2); font-weight: 500; flex: 1 0 auto;
    border-radius: 8px; transition: color var(--mo-micro, 140ms); }
  .doc-seg button.on { color: var(--md-fg); font-weight: 600; }
  /* 英文（html[lang=en]，lib/i18n.js 设置）：等宽三段按最长的 Source 撑宽，收窄左右内边距给文件名腾位（窄屏/工作台侧栏）；中文不动 */
  :global(html[lang='en']) .doc-seg button { padding-left: 8px; padding-right: 8px; }

  /* CM6 编辑器容器（内部样式在 mdeditor/editor.css，全局注入防 Svelte 剪枝） */
  .doc-cm { position: absolute; inset: 0; }

  .doc-save { flex: none; padding: 7px 15px; border-radius: 999px; background: var(--md-accent); color: #fff; font-size: 13.5px; font-weight: 600;
    transition: background var(--mo-micro, 140ms), color var(--mo-micro, 140ms), opacity var(--mo-micro, 140ms); }
  .doc-save:disabled { opacity: .45; }
  .doc-save.saved { background: var(--md-ok-bg); color: var(--md-ok); opacity: 1; }
  .doc-save:not(:disabled):active { filter: brightness(.94); }

  .doc-body { flex: 1; min-height: 0; position: relative; }
  .doc-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: var(--md-fg-2); }
  .doc-spin { width: 30px; height: 30px; border-radius: 50%; border: 3px solid rgba(20, 20, 19, .1); border-top-color: var(--md-accent); animation: docspin .8s linear infinite; }
  @keyframes docspin { to { transform: rotate(360deg); } }
  /* 分块渲染进行中：文末小转圈（正文已可读可滚，不挡内容） */
  .doc-rendering { display: flex; justify-content: center; padding: 14px 0 6px; }
  .doc-rendering .doc-spin { width: 20px; height: 20px; border-width: 2.5px; }
  .doc-err button { padding: 7px 20px; border-radius: 999px; background: var(--md-accent); color: #fff; font-size: 14px; }
  .doc-ph-name { font-weight: 600; color: var(--md-fg); }
  .doc-dl { padding: 8px 20px; border-radius: 999px; background: var(--md-accent); color: #fff; font-size: 14px; }

  .doc-scroll { position: absolute; inset: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }
  .doc-edit { position: absolute; inset: 0; width: 100%; height: 100%; resize: none; border: 0; outline: none; background: var(--md-bg); color: var(--md-fg);
    padding: 16px; font-family: var(--md-mono); font-size: 14px; line-height: 1.7; -webkit-overflow-scrolling: touch; caret-color: var(--md-accent); }

  .doc-page { max-width: 760px; margin: 0 auto; padding: 14px 20px 60px; }

  /* —— 笔记属性（frontmatter）面板 —— */
  .doc-props { border-bottom: 1px solid var(--md-line); padding: 0 0 10px; }
  .doc-props-h { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--md-fg-3); font-weight: 550; padding: 6px 0; transition: color var(--mo-micro, 140ms); }
  .doc-props-h:active { color: var(--md-fg-2); }
  .doc-chev { width: 14px; height: 14px; transition: transform .18s var(--md-ease); transform: rotate(90deg); }
  .doc-chev.closed { transform: rotate(0deg); }
  .doc-props-n { margin-left: 2px; font-size: 11.5px; background: var(--md-bg-2); color: var(--md-fg-3); padding: 1px 7px; border-radius: 999px; }
  .doc-props-tbl { display: flex; flex-direction: column; }
  .doc-prop { display: flex; gap: 10px; padding: 4px 0; min-height: 30px; align-items: flex-start; font-size: 14px; }
  .doc-prop-k { flex: none; width: 116px; display: flex; align-items: center; gap: 7px; color: var(--md-fg-2); overflow: hidden; padding-top: 2px; }
  .doc-prop-k :global(svg) { width: 15px; height: 15px; flex: none; opacity: .72; }
  .doc-prop-k span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .doc-prop-v { flex: 1; min-width: 0; color: var(--md-fg); display: flex; flex-wrap: wrap; gap: 5px; align-items: center; word-break: break-word; }
  .doc-prop-txt { white-space: pre-wrap; }
  .doc-prop-empty { color: var(--md-fg-4); }
  .doc-prop-json { font-family: var(--md-mono); font-size: 12.5px; color: #bc5215; background: rgba(188, 82, 21, .08); border-radius: 5px; padding: 2px 7px; word-break: break-all; }
  .doc-chip { background: var(--md-bg-2); border-radius: 999px; padding: 2px 10px; font-size: 13px; word-break: break-all; }
  .doc-chip-tag { color: var(--md-accent-deep); background: var(--md-accent-tint); }
  /* 只读勾选框自绘（原生 disabled 态是一坨灰，和编辑态的珊瑚勾对不上） */
  .doc-prop-v input[type="checkbox"] {
    appearance: none; -webkit-appearance: none; width: 16px; height: 16px; margin: 0; border-radius: 5px;
    border: 1.6px solid var(--md-line-2); background: #fff; position: relative; opacity: 1;
  }
  .doc-prop-v input[type="checkbox"]:checked { background: var(--md-accent); border-color: var(--md-accent); }
  .doc-prop-v input[type="checkbox"]:checked::after {
    content: ''; position: absolute; left: 4.2px; top: 1px; width: 3.8px; height: 7.6px;
    border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(43deg);
  }

  /* —— Obsidian 语法（{@html} 注入，须 :global 保住运行时类）—— */
  .doc-page :global(a.wk) { color: var(--md-accent-deep); text-decoration: none; border-bottom: 1px solid rgba(181, 83, 47, .35); cursor: pointer; word-break: break-all; }
  .doc-page :global(a.wk:active) { background: var(--md-accent-tint); }
  .doc-page :global(.ob-tag) { color: var(--md-accent-deep); background: var(--md-accent-tint); border-radius: 999px; padding: 1px 8px; font-size: .88em; }
  .doc-page :global(mark) { background: var(--md-mark); border-radius: 3px; padding: 0 2px; color: inherit; }
  .doc-page :global(img.wk-embed) { max-width: 100%; border-radius: 8px; }
  .doc-page :global(.callout) { margin: .8em 0; border-radius: 10px; background: rgba(var(--co), .07); border-left: 3px solid rgb(var(--co)); padding: 10px 14px; }
  .doc-page :global(.co-title) { display: flex; align-items: center; gap: 7px; font-weight: 650; color: rgb(var(--co)); font-size: .98em; }
  .doc-page :global(.co-title svg) { width: 17px; height: 17px; flex: none; }
  .doc-page :global(.co-body) { margin-top: 4px; }
  .doc-page :global(.co-body > :last-child) { margin-bottom: 0; }

  /* Markdown 预览排版（象牙白文档）——数值与 mdeditor/editor.css 的 Live Preview 保持一致，
     两个模式来回切时不该有观感落差（字号/行高/间距/块样式全对齐；字体统一走全局 --sans）*/
  .doc-md { font-size: 16px; line-height: 1.72; word-wrap: break-word; padding-top: 2px; }
  .doc-md :global(*) { -webkit-touch-callout: default; }   /* 长按可起选择/复制（body 全局是禁的）*/
  .doc-md :global(::selection) { background: var(--md-accent-soft); }
  .doc-md :global(h1) { font-size: 1.7em; font-weight: 700; margin: 1.05em 0 .45em; line-height: 1.35; }
  .doc-md :global(h2) { font-size: 1.4em; font-weight: 700; margin: 1em 0 .4em; padding-bottom: .2em; border-bottom: 1px solid var(--md-line); }
  .doc-md :global(h3) { font-size: 1.2em; font-weight: 700; margin: .9em 0 .35em; }
  .doc-md :global(h4) { font-size: 1.05em; font-weight: 700; margin: .85em 0 .3em; }
  .doc-md :global(h5) { font-size: 1em; font-weight: 700; margin: .85em 0 .3em; }
  .doc-md :global(h6) { font-size: .95em; font-weight: 700; color: var(--md-fg-2); margin: .85em 0 .3em; }
  /* 编辑态两段之间隔着一整行空行（≈60px），阅读态放宽到 ≈50px，比例与 Obsidian 两态一致；
     真要一模一样得把编辑态空行压扁，那样光标在空行上会忽高忽低，不划算 */
  .doc-md :global(p) { margin: 1.4em 0; }
  .doc-md :global(ul), .doc-md :global(ol) { margin: .5em 0; padding-left: 1.5em; }
  .doc-md :global(li) { margin: .3em 0; }
  .doc-md :global(li)::marker { color: var(--md-accent); }
  /* 任务勾选框：跟编辑态自绘的那只对齐（原生 checkbox 太小、形状也不同）*/
  .doc-md :global(li input[type="checkbox"]) {
    appearance: none; -webkit-appearance: none; width: 17px; height: 17px; border-radius: 5px;
    border: 1.6px solid var(--md-line-2); background: #fff; vertical-align: -3px; margin: 0 4px 0 0; position: relative;
  }
  .doc-md :global(li input[type="checkbox"]:checked) { background: var(--md-accent); border-color: var(--md-accent); }
  .doc-md :global(li input[type="checkbox"]:checked)::after {
    content: ''; position: absolute; left: 4.6px; top: 1.4px; width: 4px; height: 8px;
    border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(43deg);
  }
  .doc-md :global(a) { color: var(--md-link); text-decoration: none; }
  .doc-md :global(blockquote) { margin: .7em 0; padding: .2em 16px; border-left: 3px solid var(--md-line-2); color: var(--md-fg-2); }
  .doc-md :global(code) { background: var(--md-bg-2); border-radius: 5px; padding: .1em .28em; font-family: var(--md-mono); font-size: .88em; }
  .doc-md :global(pre) { background: var(--md-bg-2); border: 1px solid var(--md-line); border-radius: 10px; padding: 8px 14px; overflow-x: auto; margin: .7em 0; }
  .doc-md :global(pre code) { background: none; padding: 0; font-size: 13.5px; line-height: 1.6; }
  /* 代码块围栏头（语言 + 复制）：编辑态有，阅读态也补上，两边同一副长相 */
  .doc-md :global(.doc-fence) { display: flex; align-items: center; gap: 10px; white-space: normal; margin-bottom: 4px; font-family: var(--sans); }
  .doc-md :global(.doc-fence-lang) { color: var(--md-fg-3); font-size: 11.5px; text-transform: lowercase; letter-spacing: .3px; }
  .doc-md :global(.doc-fence-copy) { margin-left: auto; border: 1px solid var(--md-line); background: var(--md-panel); color: var(--md-fg-2); font-size: 11.5px; padding: 2px 10px; border-radius: 999px;
    transition: background var(--mo-micro, 140ms), color var(--mo-micro, 140ms); }
  .doc-md :global(.doc-fence-copy:active) { background: var(--md-bg-3); }
  .doc-md :global(img) { max-width: 100%; border-radius: 8px; }
  .doc-md :global(table) { border-collapse: collapse; width: 100%; margin: .7em 0; display: block; overflow-x: auto; }
  .doc-md :global(th), .doc-md :global(td) { border: 1px solid var(--md-line); padding: 7px 11px; text-align: left; font-size: .95em; }
  .doc-md :global(th) { background: var(--md-bg-2); font-weight: 650; }
  .doc-md :global(hr) { border: 0; border-top: 1px solid var(--md-line); margin: 1.2em 0; }

  /* —— 文末尾栏：反向链接 / 出链 / 词数（阅读态挂 .doc-tailhost，编辑态被 CM 收编进正文末尾）—— */
  .doc-tail[hidden] { display: none; }
  .doc-links { margin-top: 34px; border-top: 1px solid var(--md-line); padding-top: 12px; display: flex; flex-direction: column; gap: 6px; }
  .doc-lk-h { display: flex; align-items: center; gap: 6px; font-size: 13px; color: var(--md-fg-3); font-weight: 550; margin: 8px 0 2px; }
  .doc-lk-h svg { width: 14px; height: 14px; }
  .doc-lk-n { font-size: 11.5px; background: var(--md-bg-2); color: var(--md-fg-3); padding: 1px 7px; border-radius: 999px; }
  .doc-bls { display: flex; flex-direction: column; gap: 8px; }
  .doc-bl { text-align: left; background: var(--md-panel); border: 1px solid var(--md-line); border-radius: 12px; padding: 9px 12px;
    transition: background var(--mo-micro, 140ms), border-color var(--mo-micro, 140ms); }
  @media (hover: hover) { .doc-bl:hover { border-color: var(--md-line-2); background: #fff; } }
  .doc-bl:active { background: var(--md-bg-2); }
  .doc-bl-name { font-size: 14px; font-weight: 600; color: var(--md-accent-deep); display: flex; align-items: center; gap: 6px; min-width: 0; }
  .doc-bl-n { flex: none; font-size: 11px; background: var(--md-accent-tint); color: var(--md-accent-deep); border-radius: 999px; padding: 0 6px; }
  .doc-bl-x { margin-top: 4px; font-size: 12.5px; color: var(--md-fg-2); line-height: 1.55; word-break: break-all;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .doc-bl-x :global(b) { color: var(--md-fg); background: var(--md-mark); font-weight: 600; border-radius: 2px; }
  .doc-outs { display: flex; flex-wrap: wrap; gap: 7px; }
  .doc-out { font-size: 13px; color: var(--md-accent-deep); background: var(--md-accent-tint); border: 1px solid rgba(181, 83, 47, .18); border-radius: 999px; padding: 4px 12px;
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: background var(--mo-micro, 140ms); }
  .doc-out:active { background: var(--md-accent-soft); }
  .doc-out.dead { color: var(--md-fg-3); background: var(--md-bg-2); border-color: var(--md-line); border-style: dashed; }
  .doc-stats { margin-top: 26px; padding: 10px 0 4px; text-align: center; font-size: 12px; color: var(--md-fg-4); }

  .doc-restored { position: absolute; left: 50%; bottom: calc(16px + var(--kb, 0px)); transform: translateX(-50%); background: rgba(217, 119, 87, .96); color: #fff; font-size: 12.5px; padding: 6px 14px; border-radius: 999px; pointer-events: none; box-shadow: var(--md-shadow-sm); }
  .doc-toast { position: absolute; left: 50%; bottom: calc(54px + var(--kb, 0px)); transform: translateX(-50%); background: rgba(20, 20, 19, .86); color: #faf9f5; font-size: 13px; padding: 8px 18px; border-radius: 999px; pointer-events: none; box-shadow: var(--md-shadow-sm); }
</style>
