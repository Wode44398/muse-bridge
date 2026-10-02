<script>
  // 文档查看/编辑器（亮色文档 surface，自带头部，盖在 MediaViewer 暗壳之上）。
  // Markdown 走 Obsidian 式三态：阅读（obsmd 渲染）｜编辑（Live Preview，CM6 懒加载，
  // 光标进块显源码、表格 Excel 式常驻编辑）｜源码（同一 CM 实例关装饰）。
  // 纯文本/代码仍是 textarea 源码编辑。保存写回服务端(/api/file/save)。
  //   · Obsidian 风笔记补全：frontmatter「笔记属性」面板、[[双链]]/相对 md 链接查看器内跳转
  //     （导航栈，返回逐级回退）、#标签 / ==高亮== / callout、底部「反向链接 / 出链」面板
  //     （/api/file/mdlinks，云端）+ 词数统计
  //   · md 编辑态防抖自动保存（失败退草稿+限次重试）；未保存草稿按文件键存内存，误关再开自动恢复
  //     （磁盘期间被别处改过：先三方合并，合不上以磁盘为准、横幅让用户选）
  //   · 键盘避让（padding-bottom: --kb）；返回自动落盘（不可保存时才弹确认）
  import { untrack, tick } from 'svelte';
  import { api } from '../../lib/api.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { normalizeItem, cloudFileUrl, openPreview, preview } from '../../lib/preview.svelte.js';
  import { parseNote, renderObsMarkdown, renderPropWikilinks, noteStats, escapeHtml, escapeRegex, propKind, PROP_ICONS, MD_EXT_RE, scanFootnotes, renderFootnoteSection, lexObsBlocks } from '../../lib/obsmd.js';
  import { findSafeCut } from '../../lib/md.js';
  import { srcBlocks, readMapper } from '../../lib/mdanchors.js';
  import { merge3, textHash } from '../../lib/textmerge.js';
  import { setPreviewDetail } from '../../lib/preview.svelte.js';
  import { registerDraft } from '../../lib/uiReport.js';
  import { fsChange, fsMatches } from '../../lib/fsSync.svelte.js';
  import { IS_SHARE } from '../../lib/share.js';
  import { t, tr, locale } from '../../lib/i18n.js';
  import { guardSelection } from '../../lib/touchSelection.js';
  import { edgeAutoScroll } from '../../lib/touchAutoScroll.js';

  let { item, onClose } = $props();

  // —— 双链导航栈：栈顶=当前文档；[[链接]]/反链点击 push、返回 pop（系统返回同步接管）——
  let stack = $state([item]);
  const cur = $derived(stack[stack.length - 1]);
  const isMd = $derived(cur.kind === 'markdown');
  const isText = $derived(cur.kind === 'text' || isMd);
  // 公开分享页（/w/）是只读身份：写接口对 share 一律 401，编辑入口直接不给。
  const editable = $derived(!IS_SHARE && !!cur.saveTarget);

  // —— 未保存草稿（按文件键存内存，跨重开恢复）——
  // 值是 { text, base }：base=这份草稿基于的磁盘原文。重开时磁盘若已不是 base（期间 Claude/其他端改过），
  // 不能拿草稿直接盖——先三方合并，合不上就进冲突区让用户选（见 restoreDraft）。
  const DRAFTS = (window.__bridgeDocDrafts ||= new Map());
  const STALE = (window.__bridgeDocStale ||= new Map());      // 与磁盘冲突、没自动恢复的草稿：文件键 → { text }（关掉重开还在，等用户决定）
  const SAVEQ = (window.__bridgeDocSaveQ ||= new Map());      // 每篇最后一个写请求（只 resolve）：写入按篇串行，load() 读盘前先等它
  const draftKeyOf = (c) => (c.saveTarget ? c.saveTarget.origin + ':' + (c.saveTarget.ws || '') + ':' + c.saveTarget.rel : c.key);
  const linksKeyOf = (c) => (c.saveTarget?.ws || '') + ':' + (c.saveTarget?.rel || '');
  const draftKey = $derived(draftKeyOf(cur));

  let content = $state(''), original = $state('');
  // md：'preview'(阅读) | 'live'(编辑=Live Preview) | 'source'(源码)；文本文件：'edit'(textarea)
  let mode = $state('preview');
  let loading = $state(true), loadError = $state(false);
  let restored = $state(false);   // false | 'draft'（原样恢复草稿）| 'merged'（草稿与磁盘新修改已合并）
  let stale = $state(null);       // 当前文档的冲突草稿 { key, text }（横幅：恢复草稿 / 丢弃）
  // 编辑中与磁盘冲突：保存时发现（服务端 409 / 本地现读对不上）或跟盘时发现别处改的正是你改的那几行，
  // 三方合并合不上 → { key, theirs }；横幅让用户选「保留我的 / 用最新版」，期间自动保存暂停
  let conflict = $state(null);
  let justSaved = $state(false), savedT = null;   // 刚保存完：顶栏副标题短暂显示「已保存」
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

  // 顶栏副标题：保存状态优先，平时显示所在文件夹。纸面灰阶，不用彩色块（冲突才用警示色）
  const folder = $derived((cur.saveTarget?.rel || '').split('/').slice(0, -1).join(' / '));
  const status = $derived(
    !isText || loading ? null
      : conflict ? { kind: 'warn', text: t('与别处的修改冲突') }
      : saving ? { kind: 'busy', text: t('正在保存…') }
      : dirty && editable ? { kind: 'dirty', text: t('未保存') }
      : justSaved ? { kind: 'ok', text: t('已保存') }
      : !editable ? { kind: 'ro', text: t('只读') }
      : folder ? { kind: 'path', text: folder } : null);

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
  // 对齐的是「视口顶下 dy 那条线上的字」：切换前后它的屏幕 y 不变。两态之间传**源码位置**（可带小数）——
  // 阅读态 y ↔ 源码走 lib/mdanchors.js 的块级刻度（顶层块逐个配对，列表逐项、代码逐行、段落逐软换行细分），
  // 编辑态 y ↔ 源码走 CM 自己的行高表（mdeditor topPos/scrollToPos，行内按字符插值、落定后再精调）。
  // 两个方向用同一张表，阅读→编辑→阅读往返不漂移。不用整篇像素比例——编辑态是 CM 虚拟滚动，
  // 视口外的高度是估算值，纯比例会偏出几屏。停在文首时只记「顶部」，另一态也回顶（两态首屏各排各的）。
  let docScrollEl = $state(null);
  let anchor = null, pendingScroll = false;
  const anchorDy = (h) => Math.min(120, Math.round((h || 0) * 0.2));
  const nlz = (s) => s.replace(/\r\n?/g, '\n');   // CM 文档的换行一律是 \n：两边偏移都按归一后的文本算

  // 阅读态映射：源码侧的顶层块只在正文变了时重切（与阅读态分块渲染同一组分块、同一份脚注上下文）
  let srcMemo = null;
  function readMap() {
    const page = docScrollEl?.firstElementChild;
    if (!mdEl || !page || !note) return null;
    const text = nlz(content);
    if (srcMemo?.text !== text) {
      const footnotes = scanFootnotes(note.body);
      const base = text.length - nlz(note.body).length;
      srcMemo = { text, base, blocks: srcBlocks(splitTopBlocks(note.body), base, (s) => lexObsBlocks(s, { footnotes })) };
    }
    return readMapper({ root: mdEl, page, blocks: srcMemo.blocks, base: srcMemo.base, total: text.length, text });
  }

  // anchor：{ top:true } 或 { pos, off, snip?, sdy? }——pos 是锚线上（或锚线下方 off 像素处、空隙吸附时）的源码位置；
  // snip/sdy 是锚线那一行的一小段字与它首字顶相对锚线的差，另一态能找到这段字就直接按它对齐（比按字符插值准）。
  // anchorFor：上次按 anchor 落位时的正文与落定的阅读态 scrollTop——落位之后用户没滚过、没改过字，
  // 再切换就沿用同一个锚点，不重新量（两态版面不完全相同，重量一次会差几像素，来回切就会一点点漂）
  let anchorFor = null;
  function grabScroll() {
    if (anchor && anchorFor?.text === content) {
      const sc = mode !== 'preview' ? editor?.view?.scrollDOM : docScrollEl;
      const settled = mode !== 'preview' ? sc?.__mdeSettled : anchorFor.readSt;
      if (sc && settled != null && Math.abs(sc.scrollTop - settled) <= 2) return;
    }
    anchorFor = null;
    if (mode !== 'preview') {
      const sc = editor?.view?.scrollDOM;
      if (sc) anchor = sc.scrollTop <= 1 ? { top: true } : editor.topPos(anchorDy(sc.clientHeight), true);
      return;
    }
    const sc = docScrollEl, m = sc && readMap();
    if (!m) return;
    if (sc.scrollTop <= 1) { anchor = { top: true }; return; }
    const y = sc.scrollTop + anchorDy(sc.clientHeight);
    anchor = m.toSrc(y);
    if (!anchor.off) Object.assign(anchor, m.snipAt(y, anchor.pos));   // 锚线上的一小段字：另一态直接找它对齐（见 mdanchors snipAt）
  }
  function applyScroll() {
    const a = anchor;
    if (!a) return;
    const af = (anchorFor = { text: content, readSt: null });
    if (mode !== 'preview') {
      if (a.top) editor?.scrollToPos?.(0);
      else editor?.scrollToPos?.(a.pos, anchorDy(editor.view.scrollDOM.clientHeight) + (a.off || 0), a.snip ? { snip: a.snip, sdy: a.sdy } : null);
      return;
    }
    // 阅读态高度还会因图片解码变，补两拍；用户一动手立刻收手，不跟人抢滚动
    let last = -1, n = 0;
    const put = () => {
      const sc = docScrollEl;
      if (!sc || !sc.isConnected || mode !== 'preview') return true;
      if (last >= 0 && Math.abs(sc.scrollTop - last) > 2) return true;
      const m = a.top ? null : readMap();
      if (a.top) sc.scrollTop = 0;
      else if (m) {
        let y = m.toY(a.pos);   // 锚线应在的页内 y；带着锚线文字的，在附近找到同一段字就以它为准
        const hit = a.snip ? m.findSnip(a.snip, y + (a.sdy || 0)) : null;
        if (hit != null) y = hit - (a.sdy || 0);
        sc.scrollTop = Math.max(0, Math.min(Math.round(y - anchorDy(sc.clientHeight) - (a.off || 0)), sc.scrollHeight - sc.clientHeight));
      }
      last = af.readSt = sc.scrollTop;
      return false;
    };
    put();
    const id = setInterval(() => { if (put() || ++n >= 3) clearInterval(id); }, 60);
  }
  $effect(() => {
    const el = docScrollEl;
    mdBlocks;                                   // 阅读态 DOM 渲染完再落位
    if (mdRendering) return;                    // 分块途中块还没长全，等全量出齐再插值
    if (mode !== 'preview' || !el) return;
    if (untrack(() => takeJumpHead())) return;  // 双链 [[笔记#标题]] 跳过来：定位到标题，这次不按进度落位
    if (!pendingScroll) return;
    pendingScroll = false;
    applyScroll();
  });

  let toastT = null;
  function showToast(m) { toast = m; clearTimeout(toastT); toastT = setTimeout(() => (toast = ''), 1800); }

  let seq = 0;   // 竞态闸：快速连点双链时只认最后一次加载
  let loadCtrl = null;   // 在途加载的中止柄：换文档/卸载时掐掉，不陪葬
  async function load() {
    const my = ++seq, c = cur, dk = draftKeyOf(c);
    loading = true; loadError = false; restored = false; stale = null; conflict = null;
    mode = c.kind === 'markdown' ? lastMdMode() : 'edit';
    loadLinks(c);
    if (!(c.kind === 'text' || c.kind === 'markdown')) { loading = false; return; }
    try {
      let text;
      if (c.text != null) {                                     // 本地：调用方已读
        text = c.text;
      } else {
        // 这篇还有写请求在途（跳走马上回来 / 关掉马上重开）：先等它落盘再读，否则读到写入之前的旧文（最多等 8s）
        const q = SAVEQ.get(dk);
        if (q) await Promise.race([q, new Promise((r) => setTimeout(r, 8000))]);
        if (my !== seq) return;
        // 首包 12s 超时——切后台回来的半开 socket 会让 fetch 永挂（转圈永远转的元凶，
        // 同聊天流 07-30 看门狗的病根）；头到了正文另给 120s 兜底，超时/断网走「重试」错误态。
        loadCtrl?.abort();
        const ctrl = (loadCtrl = new AbortController());
        let timer = setTimeout(() => ctrl.abort(), 12000);
        try {
          // no-store：/api/file 回的是 Cache-Control: max-age=30，而保存走另一个 URL（POST /api/file/save）不会让它失效——
          // 30s 内跳回/重开会读到浏览器缓存里的旧稿，接着一编辑，自动保存就把刚存好的内容盖回去（验收 e2e-1）
          const r = await fetch(c.url, { cache: 'no-store', credentials: 'same-origin', signal: ctrl.signal });
          if (!r.ok) throw new Error('HTTP ' + r.status);
          clearTimeout(timer);
          timer = setTimeout(() => ctrl.abort(), 120000);
          text = await r.text();
        } finally { clearTimeout(timer); }
      }
      if (my !== seq) return;
      original = text;
      content = restoreDraft(c, dk, text);
      loading = false;
    } catch { if (my === seq) { loadError = true; loading = false; } }
  }
  $effect(() => { cur; load(); });   // 挂载/换文档（含双链跳转）即加载

  // 草稿恢复（验收 e2e-3）：草稿记着它基于的磁盘原文（base），拿它和刚读到的磁盘现状比——
  //   · 草稿 = 磁盘：早已落盘（多半是跳走时的静默保存），丢掉草稿，不报「已恢复」、不强切编辑态；
  //   · 磁盘 = base：期间没人动过这篇，原样恢复（之后照常自动保存）；
  //   · 磁盘变了（Claude 的 Edit / 其他端）：三方合并，两边改的不是同一处就合上、两边的新内容都留；
  //     合不上就以磁盘为准，草稿转进冲突区，横幅让用户选「恢复草稿（覆盖磁盘）」或「丢弃」——
  //     绝不拿旧草稿静默盖掉别处的新修改。
  function restoreDraft(c, dk, text) {
    if (STALE.get(dk)?.text === text) STALE.delete(dk);
    const d = DRAFTS.get(dk);
    let out = text;
    if (d && d.text !== text) {
      if (d.base === text) { out = d.text; restored = 'draft'; }
      else {
        const m = typeof d.base === 'string' ? merge3(d.base, d.text, text) : null;
        if (m == null) STALE.set(dk, { text: d.text });
        else if (m !== text) { out = m; restored = 'merged'; }
      }
    }
    if (out === text) DRAFTS.delete(dk);
    if (restored && c.kind === 'markdown') mode = 'live';
    const s = STALE.get(dk);
    stale = s ? { key: dk, text: s.text } : null;
    return out;
  }
  // 冲突横幅：恢复草稿 = 用草稿换掉正文（编辑器里走事务，可撤销；随后照常自动保存覆盖磁盘）
  function useStale() {
    const s = stale;
    if (!s || draftKeyOf(cur) !== s.key) return;
    STALE.delete(s.key); stale = null;
    if (editor) editor.setDoc(s.text);
    else content = s.text;
    if (isMd && mode === 'preview') setMdMode('live');
    restored = 'draft';
  }
  function dropStale() { if (stale) STALE.delete(stale.key); stale = null; }

  function onEdit() { if (dirty) DRAFTS.set(draftKey, { text: content, base: original }); else DRAFTS.delete(draftKey); }
  $effect(() => { content; if (!loading) onEdit(); });   // 编辑即存草稿

  // —— agent 跟盘：Claude 的 Edit/Write 落盘成功（SSE fs 事件）→ 当前文档跟上磁盘 ——
  // 命中当前文档（rel 后缀 + ws 前缀匹配）就拉磁盘新文：
  //   · 手上没有没存的字：直接换成新文（阅读态按标题锚点保住进度；编辑态走最小差异事务，光标不跳）；
  //   · 手上有没存的字：三方合并（基准=上次读到/写下的磁盘原文），两边改的不是同一处就合上、接着自动保存；
  //     改到了同一处就进冲突横幅，绝不拿编辑器里的旧稿盖掉别处的新修改（以前这里直接跳过，下一次自动
  //     保存就把别处的修改整篇覆盖了）；
  //   · 自己的写正在途：等写完再看，免得拿半截状态去合并。
  // 服务端的写前校验（baseHash → 409）兜住事件没到、或本地文件这类没有事件的情况。
  let fsT = null, pendingFs = false;
  async function refreshFromDisk() {
    const my = ++seq, c = cur, key = draftKeyOf(c);
    if (c.text != null || !c.url) return;   // 内联文本不是 agent 改的对象
    try {
      const r = await fetch(c.url, { cache: 'no-store', credentials: 'same-origin' });
      if (!r.ok) return;
      const text = await r.text();
      if (my !== seq || loading) return;
      if (saving) { pendingFs = true; return; }
      if (conflict?.key === key) { if (text !== conflict.theirs) conflict = { key, theirs: text }; return; }
      if (text === original) return;
      const base = original, mine = content;
      if (mine === base) {
        if (isMd && mode === 'preview') { grabScroll(); pendingScroll = true; }
        original = text;
        applyText(text, true);
        showToast(t('已同步 Claude 的修改'));
        return;
      }
      const m = merge3(base, mine, text);
      if (m == null) { conflict = { key, theirs: text }; clearTimeout(saveT); return; }
      original = text;
      applyText(m);
      showToast(t('已合并别处对这篇的修改'));
      resave(true);
    } catch { /* 跟盘失败无害，下次事件再试 */ }
  }
  // 换正文：编辑器在就走最小差异事务（光标随改动映射、Ctrl+Z 可撤销，content 由 onChange 回写）；
  // raw=true 时再把 content 设成磁盘原样（CRLF 文件：编辑器里是 LF，不设的话会被当成改动、白写一遍）
  function applyText(x, raw = false) {
    if (editor && edFor === draftKey) editor.applyText(x);
    else content = x;
    if (raw) content = x;
  }
  let fsSeen = 0;   // 只认新事件：效应因 mode/dirty 等其它依赖重跑时不重复拉取
  $effect(() => {
    if (fsChange.seq === fsSeen) return;
    const st = cur?.saveTarget;
    if (!fsChange.path || loading || !st || st.origin !== 'cloud') return;
    if (!fsMatches(fsChange.path, { ws: st.ws || '', rel: st.rel || '' })) return;
    fsSeen = fsChange.seq;
    clearTimeout(fsT);
    fsT = setTimeout(() => untrack(refreshFromDisk), 400);   // 连续多次 Edit 只刷最后一拍
    return () => clearTimeout(fsT);
  });

  // —— 保存：以发出那一刻的快照为准（验收 e2e-4 / e2e-3）——
  // 写请求在途时用户还会打字、跳去别的笔记、甚至关掉查看器：await 之后不再读 cur/draftKey/dirty 这些
  // 派生量（那时它们可能已指向另一篇，组件也可能已卸载），只认发出时拍下的那篇、那份文本——
  // 只把真正写出去的那份记为已保存；草稿只在恰好等于那份时才删。同一篇同时只发一个请求：
  // 在途期间又要存的记一笔，回来后按那时的最新内容补发；已经跳走/关掉的，拿草稿（每次改动都记）补发。
  // 写入按篇串行（SAVEQ），旧稿不会后到盖新稿。
  let saveT = null, saveFails = 0, lastLinksRefresh = 0, alive = true;
  const inflight = new Map();          // 本实例在途的写：文件键 → { again }
  let saveTick = $state(0);            // inflight 变了 → saving 重算
  const saving = $derived((saveTick, inflight.has(draftKey)));
  const topItem = () => stack[stack.length - 1];   // 当前文档（直接读状态，卸载后读也不触发派生量告警）

  // 写前校验：base=这次保存基于的那份磁盘原文。磁盘已经不是它（别处改过）→ 抛 conflict（带磁盘现状），
  // 由 saveDoc 走三方合并，不覆盖。交给服务端比指纹（409）
  function conflictErr(current) { const e = new Error('conflict'); e.conflict = true; e.current = current; return e; }
  async function writeDoc(c, text, base) {
    const st = c.saveTarget, guard = typeof base === 'string';
    if (st.origin === 'cloud') {
      try { return await api.saveFileGuarded(st.rel, text, st.ws, guard ? textHash(base) : undefined); }
      catch (e) { if (e?.status === 409 && typeof e.body?.current === 'string') throw conflictErr(e.body.current); throw e; }
    }
  }
  function queueWrite(key, c, text, base) {
    const p = (SAVEQ.get(key) || Promise.resolve()).then(() => writeDoc(c, text, base));
    const tail = p.then(() => {}, () => {});
    SAVEQ.set(key, tail);
    tail.then(() => { if (SAVEQ.get(key) === tail) SAVEQ.delete(key); });
    return p;
  }

  function save(quiet = false) {
    if (!editable || content === original || conflict) return;
    return saveDoc(topItem(), content, quiet, original);
  }
  // base：这次写入基于的磁盘原文（当前文档=original；补存草稿=草稿记的 base）
  async function saveDoc(c, text, quiet, base) {
    const key = draftKeyOf(c);
    const f = inflight.get(key);
    if (f) { f.again = true; return; }
    inflight.set(key, { again: false }); saveTick++;
    let ok = false, clash = null;
    try {
      await queueWrite(key, c, text, base);
      ok = true;
      const d = DRAFTS.get(key);
      if (d?.text === text) DRAFTS.delete(key);
      else if (d) DRAFTS.set(key, { text: d.text, base: text });   // 在途期间又改了：草稿留着兜底，它现在基于刚写下的这份
      if (draftKeyOf(topItem()) === key) {
        original = text; restored = false; saveFails = 0;
        justSaved = true; clearTimeout(savedT); savedT = setTimeout(() => (justSaved = false), 2200);
      }
      const now = Date.now();
      if (now - lastLinksRefresh > 10_000) {   // 正文变了 → 出链/反链重算（限频，自动保存别刷爆）
        lastLinksRefresh = now;
        LINKS_CACHE.delete(linksKeyOf(c));
        if (alive && topItem() === c) loadLinks(c);
      }
      if (!quiet && alive) showToast(t('已保存'));
    } catch (e) {
      if (e?.conflict) clash = e.current;
      else {
        if (draftKeyOf(topItem()) === key) saveFails++;
        if (alive) showToast(t('保存失败：{reason}', { reason: tr(e?.body?.error || e?.message || '') }));
      }
    } finally {
      const again = inflight.get(key)?.again;
      inflight.delete(key); saveTick++;
      const isCur = alive && draftKeyOf(topItem()) === key;
      if (clash != null) onConflict(c, key, text, base, clash);
      else if (isCur) resave(again);
      else if (ok) {
        // 已跳去别的笔记 / 查看器已关：这篇离开时的最新内容在草稿里，比刚写的新就接着补存
        const d = DRAFTS.get(key);
        if (d && d.text !== text) saveDoc(c, d.text, true, d.base);
      }
      if (pendingFs && isCur) { pendingFs = false; refreshFromDisk(); }
    }
  }
  // 保存时发现磁盘已被别处改过：三方合并「基准 → 我这次要写的」「基准 → 磁盘现状」。
  //   · 合得上：磁盘现状成为新原文，正文并入对方的修改（写请求在途期间又打的字也一并保留），接着照常保存；
  //   · 合不上：当前文档停掉自动保存、出冲突横幅；已跳走/已关的那篇把草稿留着原基准，下次打开时
  //     restoreDraft 会发现磁盘≠基准，再合并一次或进冲突区——两种情况都不覆盖别处的修改。
  function onConflict(c, key, text, base, theirs) {
    const m = typeof base === 'string' ? merge3(base, text, theirs) : null;
    if (!(alive && draftKeyOf(topItem()) === key)) {
      if (m != null) { DRAFTS.set(key, { text: m, base: theirs }); saveDoc(c, m, true, theirs); }
      else DRAFTS.set(key, { text, base });
      return;
    }
    if (m != null) {
      const next = content === text ? m : merge3(text, content, m);
      if (next != null) {
        original = theirs;
        applyText(next);
        showToast(t('已合并别处对这篇的修改'));
        resave(true);
        return;
      }
    }
    conflict = { key, theirs };
    clearTimeout(saveT);
  }
  // 冲突横幅：保留我的 = 以磁盘现状为基准写下编辑器里的版本（用户明确选择覆盖别处这次修改）；
  // 用最新版 = 正文换成磁盘版本（编辑器里是一个事务，想要回自己的字可以撤销）
  function keepMine() {
    const cf = conflict;
    if (!cf || cf.key !== draftKeyOf(cur)) return;
    conflict = null;
    saveDoc(topItem(), content, false, cf.theirs);
  }
  function takeTheirs() {
    const cf = conflict;
    if (!cf || cf.key !== draftKeyOf(cur)) return;
    conflict = null;
    original = cf.theirs;
    applyText(cf.theirs, true);
    DRAFTS.delete(cf.key);
  }
  // 写完之后当前文档仍有没存的：失败按 3s 重试（限 3 次，草稿始终兜底）；在途期间有人要过保存就立刻补发；
  // md 编辑态照常 1.2s 自动保存（文本文件仍是手动保存，不替它自动存）
  function resave(again) {
    if (content === original || !editable || conflict) return;
    clearTimeout(saveT);
    if (saveFails > 0) { if (saveFails < 3) saveT = setTimeout(() => save(true), 3000); return; }
    if (again || (isMd && mode !== 'preview')) saveT = setTimeout(() => save(true), again ? 0 : 1200);
  }

  // md 编辑态：停笔 1.2s 自动落盘（Obsidian 无保存键心智）；文本文件仍手动保存
  $effect(() => {
    content;
    if (loading || !isMd || !editable || mode === 'preview' || !dirty || conflict) return;
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

  // —— [[ 补全名单（/api/file/mdnames，与 mdlinks 同一棵目录树）——
  // 编辑器补全用；resolveWiki / embedUrl 也拿它兜底：出链只在保存后重算，编辑时新写的 [[X]]
  // 在那之前点开会报「未找到笔记」。按「位置 + 目录」缓存 30s，过期先给旧名单、后台换新。
  // 分享只读页/接口不可用时给空表（补全不弹）。
  const NAMES_CACHE = (window.__bridgeMdNames ||= new Map());
  const ATTACH_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|ico|pdf|mp3|wav|m4a|ogg|flac|aac|opus|mp4|webm|mov|mkv|ogv|m4v|canvas|base)$/i;
  const namesKeyOf = (c) => (c.saveTarget?.origin || '') + ':' + (c.saveTarget?.ws || '') + ':' + dirOf(c.saveTarget?.rel || '');
  let namesNow = null;   // 当前笔记最近拿到的名单（embedUrl 同步查；换文档即清）
  $effect(() => { cur; namesNow = null; });
  async function fetchNames(c) {
    const st = c.saveTarget;
    if (c.kind !== 'markdown' || !st) return [];
    const dir = dirOf(st.rel);
    try {
      const r = await api.mdNames(st.rel, st.ws);
      const base = dir ? dir + '/' : '';
      const names = (r?.names || []).map((n) => ({ ...n, rel: base && n.path.startsWith(base) ? n.path.slice(base.length) : n.path }));
      names.truncated = !!r?.truncated;
      return names;
    } catch { return []; }
  }
  function linkNames(c = cur) {
    const key = namesKeyOf(c), hit = NAMES_CACHE.get(key);
    let p = hit?.p;
    if (!hit || Date.now() - hit.at >= 30_000) {
      const fresh = fetchNames(c).then((names) => (names.length || !hit ? names : hit.p));   // 刷新失败别拿空表盖掉旧的
      NAMES_CACHE.set(key, { at: Date.now(), p: fresh });
      p = hit ? hit.p : fresh;
    }
    return p.then((names) => { if (namesKeyOf(cur) === key) namesNow = names; return names; });
  }
  // 在名单里认一个 [[名字]]：带路径的按相对路径后缀认（同服务端 mdlinks），裸名先笔记后附件；
  // 名单已按离当前笔记的远近排好，取第一个就是最浅的那个（与 mdlinks「同名取最浅」一致）
  function findInNames(names, target) {
    const k = String(target || '').trim().replace(/\\/g, '/').toLowerCase();
    if (!k || !names?.length) return null;
    const noExt = k.replace(/\.(md|markdown|mdown|mkd)$/, '');
    if (k.includes('/')) {
      return names.find((n) => {
        const s = (n.md ? n.path.replace(/\.[^./]+$/, '') : n.path).toLowerCase();
        const want = n.md ? noExt : k;
        return s === want || s.endsWith('/' + want);
      }) || null;
    }
    return names.find((n) => n.md && n.name.toLowerCase() === noExt) || names.find((n) => !n.md && n.name.toLowerCase() === k) || null;
  }
  // [[笔记#标题 补全：认出那篇笔记、取原文（标题由补全侧抽取并缓存）
  async function readNote(name) {
    const c = cur, st = c.saveTarget;
    if (!st) return null;
    const k = String(name).toLowerCase();
    const o = links?.outgoing?.find((x) => x.path && x.name.toLowerCase() === k);
    const rel = o?.path || findInNames(await linkNames(c), name)?.path;
    if (!rel || !MD_EXT_RE.test(rel)) return null;
    if (rel === st.rel) return content;
    try {
      const r = await fetch(cloudFileUrl(rel, { ws: st.ws }), { cache: 'no-store', credentials: 'same-origin' });   // 同 load()：别拿 30s 缓存里的旧标题
      return r.ok && +(r.headers.get('content-length') || 0) < 2_000_000 ? await r.text() : null;
    } catch { return null; }
  }

  // ![[嵌入]] / 相对资源 → 可加载 URL：mdlinks 已解析的路径优先，回落同目录拼接
  function embedUrl(name) {
    const st = cur.saveTarget;
    if (!st) return null;
    const hit = links?.outgoing?.find((o) => o.path && o.name.toLowerCase() === String(name).toLowerCase());
    const named = hit ? null : findInNames(namesNow, name);   // 编辑时新插的 ![[附件]]：出链还没重算，先认补全名单
    const rel = hit ? hit.path : named ? named.path : joinRel(dirOf(st.rel), name);
    return cloudFileUrl(rel, { ws: st.ws });
  }
  // —— 插图 / 附件（编辑器粘贴、拖入、「插入 ▸ 图片或附件…」→ mdeditor/attach.js 调这里）——
  // 存放位置照 Obsidian「当前文件夹下的子文件夹」：<笔记目录>/attachments/（没有就建）。手机本地（SAF）
  // 不能建目录：已有 attachments/ 就放进去，否则放笔记同目录。链接写法照 Obsidian「尽可能短」：名单里
  // 这个名字只指向刚存的文件就写裸名，否则带上 attachments/ 前缀，免得认到别处的同名图。
  const ATTACH_DIR = 'attachments';
  async function saveAttachment(file, name) {
    const st = cur.saveTarget;
    if (!st || IS_SHARE) throw new Error(t('此文档不可写'));
    const dir = dirOf(st.rel);
    let folder, finalName;
    {
      folder = joinRel(dir, ATTACH_DIR);
      const id = 'up' + Math.random().toString(36).slice(2, 12), CHUNK = 1024 * 1024;
      const ws = st.ws ? '&ws=' + encodeURIComponent(st.ws) : '';
      for (let off = 0; ; off += CHUNK) {
        const last = off + CHUNK >= file.size ? 1 : 0;
        const r = await api.post(`/api/files/upload?path=${encodeURIComponent(folder)}&id=${id}&last=${last}&mk=1&name=${encodeURIComponent(name)}${ws}`, file.slice(off, off + CHUNK));
        if (last) { finalName = r?.name || name; break; }
      }
    }
    const rel = joinRel(folder, finalName);
    // 补全/嵌入名单里补上新文件：embedUrl 立刻认得 ![[它]]（出链要等保存后才重算）
    const entry = { name: finalName, md: false, path: rel, rel: rel.slice(dir ? dir.length + 1 : 0) };
    let names = [];
    try { names = await linkNames(); } catch {}
    const clash = findInNames(names, finalName);
    const link = clash && clash.path !== rel ? entry.rel : finalName;
    for (const list of [names, namesNow]) if (list && !list.some((n) => n.path === rel)) list.push(entry);
    return { link, rel };
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
      while (acc.length < parts.length && performance.now() - t0 < 12) acc.push(renderObsMarkdown(parts[acc.length], { embedUrl, footnotes }));
      if (acc.length < parts.length) { mdBlocks = [...acc]; mdRendering = true; schedule(); return; }
      const notes = renderFootnoteSection(footnotes, { embedUrl });
      mdBlocks = notes ? [...acc, notes] : [...acc];
      mdRendering = false;
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
  // 触屏长选区护栏：拖选择柄时固定端滚出屏幕会被浏览器误命中到文首/左侧聊天（选区溢出全文），
  // 活动端拖出正文会跨进别的面板——见 lib/touchSelection.js；拖到上下边缘自动滚动见 touchAutoScroll.js
  let pageEl = $state(null);
  $effect(() => {
    if (!pageEl) return;
    const offGuard = guardSelection(pageEl, { scroller: () => docScrollEl, allEl: () => mdEl });
    const offScroll = edgeAutoScroll(pageEl, { scroller: () => docScrollEl });
    return () => { offGuard(); offScroll(); };
  });
  // head：[[笔记#标题]] / 相对链接的 #片段——新笔记加载、渲染完后定位到该标题（验收 e2e-8）
  function openNote(rel, head = '') {
    if (!guardDirty()) return;
    // name 必须取 rel 的真实文件名（带扩展名）——normalize 按 name 推 kind，
    // 反链/出链给的是去掉 .md 的展示名，直接用会被当成未知类型走占位页。
    const base = { rel, name: rel.split('/').pop() };
    const it = normalizeItem({ origin: 'cloud', ...base, ws: cur.saveTarget?.ws || '' });
    stack = [...stack, it];
    jumpHead = head ? { key: draftKeyOf(it), depth: stack.length, head } : null;
  }
  // 跨笔记跳标题只消费一次（返回/重载这篇不再跳）；两态各自定位：阅读态滚 DOM 标题，编辑态交给 CM
  let jumpHead = null;
  function takeJumpHead() {
    const j = jumpHead;
    if (!j || loading || stack.length !== j.depth || draftKeyOf(cur) !== j.key) return false;
    jumpHead = null;
    pendingScroll = false;
    if (mode === 'preview') {
      // 等 tick：本 effect 与 {@html} 块的更新同一轮 flush、effect 先跑，这时标题还没进 DOM（同代码块头那条）
      tick().then(() => {
        const sc = docScrollEl;
        if (!scrollToHeading(j.head, { instant: true }) || !sc) return;
        const st0 = sc.scrollTop;   // 图片/公式晚到撑高了上文：过一会儿再对一次（用户已经动手就不管）
        setTimeout(() => { if (sc.isConnected && Math.abs(sc.scrollTop - st0) <= 2) findHeadEl(j.head)?.scrollIntoView({ block: 'start' }); }, 250);
      });
    } else if (editor && !editor.scrollToHeading(j.head, { select: false })) showToast(t('找不到标题「{name}」', { name: j.head }));
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
    showToast(t('找不到标题「{name}」', { name: txt }));
    return false;
  }
  async function resolveWiki(name, head = '') {
    const c = cur, k = String(name).toLowerCase();
    const hit = links?.outgoing?.find((o) => o.path && o.name.toLowerCase() === k)
      || findInNames(await linkNames(c), name);   // 出链只在保存后重算：编辑时新写的 [[X]] 先查补全名单
    if (c !== cur) return;                         // 等名单期间已经跳走了
    if (hit) {
      if (MD_EXT_RE.test(hit.path)) {
        // [[本篇#标题]]：就地跳，不再把同一篇压一层栈重载
        if (head && hit.path === cur.saveTarget?.rel) {
          if (mode === 'preview') scrollToHeading(head);
          else if (!editor?.scrollToHeading(head)) showToast(t('找不到标题「{name}」', { name: head }));
          return;
        }
        return openNote(hit.path, head);
      }
      openAttachment(hit.path);   // 附件类：应用内统一查看器
      return;
    }
    showToast(links ? t('未找到笔记「{name}」', { name }) : t('链接索引加载中…'));
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
      if (codes.length) import('../../lib/mdeditor/hl.js').then((m) => { for (const c of codes) m.highlightPre(c); }).catch(() => {});
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

  function mdClick(e) {
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
    const href = a.getAttribute('href') || '';
    if (!href || /^(https?:|mailto:|data:|blob:|tel:)/i.test(href) || href.startsWith('/')) return;   // 外链/已改写的站内 URL 放行
    if (href.startsWith('#')) { e.preventDefault(); let h = href.slice(1); try { h = decodeURIComponent(h); } catch {} scrollToHeading(h); return; }
    const [p, h] = splitHref(href);
    if (MD_EXT_RE.test(p)) {
      e.preventDefault();
      openNote(joinRel(dirOf(cur.saveTarget?.rel || ''), p), h);
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
    const [p, h] = splitHref(href);
    if (!p) { if (h && !editor?.scrollToHeading(h)) showToast(t('找不到标题「{name}」', { name: h })); return; }   // [x](#标题)：本文内跳
    if (MD_EXT_RE.test(p)) { openNote(joinRel(dirOf(cur.saveTarget?.rel || ''), p), h); return; }
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
          if (name) resolveWiki(name, head);
          else if (head && !editor?.scrollToHeading(head)) showToast(t('找不到标题「{name}」', { name: head }));
        },
        openLink: (url) => openExt(url),
        openRel: openRelHref,
        resolveUrl: embedUrl,
        renderMd: (src) => renderObsMarkdown(src, { embedUrl }),
        tailEl: () => tailEl,
        linkNames: () => linkNames(),   // [[ 补全名单（complete.js）
        readNote,                       // [[笔记#标题 补全取那篇笔记的原文
        saveAttachment,                 // 粘贴/拖入/选择的图片与文件存成附件（mdeditor/attach.js）
      });
      if (!ro) linkNames();             // 进编辑就预取：补全首弹不等网络，新写的链接/嵌入点开也认得
      edFor = key;
      if (!takeJumpHead() && pendingScroll) { pendingScroll = false; applyScroll(); }   // 双链跳标题优先于保进度
    })();
    return () => { gone = true; };
  });
  $effect(() => () => {
    // 关查看器（没有浮层可收时的 Esc、安卓返回都直接卸载组件，绕过 guardDirty）：停笔不到 1.2s、
    // 自动保存还没触发的内容当场补存，不能只留在内存草稿里
    // （卸载后别读派生量 editable：直接按当前文档的保存目标判断）
    const c = topItem(), st = c?.saveTarget;
    if (st && !IS_SHARE && content !== original && !conflict) saveDoc(c, content, true, original);
    alive = false; destroyEditor(); loadCtrl?.abort();
  });   // 组件卸载兜底：编辑器销毁 + 在途加载掐断（在途的写照常发完，见 saveDoc）

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
    <button class="doc-back" aria-label={t('返回')} onclick={back}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 8 12l6.5 6.5"/></svg>
    </button>
    <div class="doc-title-wrap">
      <span class="doc-title">{cur.name}</span>
      {#if status}
        {#key status.kind}
          {#if status.kind === 'dirty'}
            <!-- 未保存：点一下立刻存（md 也会在停笔 1.2s 后自动存） -->
            <button class="doc-sub" data-kind="dirty" onclick={() => save()}><i class="doc-sub-dot"></i><span class="doc-sub-t">{status.text}</span></button>
          {:else}
            <span class="doc-sub" data-kind={status.kind}>
              {#if status.kind === 'busy'}<i class="doc-sub-spin"></i>
              {:else if status.kind === 'ok'}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>
              {:else if status.kind === 'warn'}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8.5v4.5M12 16.5h.01"/><circle cx="12" cy="12" r="9"/></svg>
              {/if}<span class="doc-sub-t">{status.text}</span>
            </span>
          {/if}
        {/key}
      {/if}
    </div>
    {#if isMd}
      <div class="doc-seg">
        <span class="doc-seg-cap" style:transform="translateX({mode === 'live' ? '100%' : mode === 'source' ? '200%' : '0'})"></span>
        <button class:on={mode === 'preview'} onclick={() => setMdMode('preview')}>{t('阅读')}</button>
        <button class:on={mode === 'live'} onclick={() => setMdMode('live')}>{t('编辑')}</button>
        <button class:on={mode === 'source'} onclick={() => setMdMode('source')}>{t('源码')}</button>
      </div>
    {/if}
    {#if editable && isText && !isMd && dirty && !conflict}
      <!-- 纯文本文件不自动保存：有改动时给一个文字按钮（md 自动保存，不需要） -->
      <button class="doc-savebtn" disabled={saving} onclick={() => save()}>{t('保存')}</button>
    {/if}
  </header>
  {#if conflict}
    <div class="doc-notice warn" role="alert">
      <svg class="doc-notice-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 8.5v4.5M12 16.5h.01"/><circle cx="12" cy="12" r="9"/></svg>
      <span class="doc-notice-t">{t('这篇在别处被修改了，和你没保存的改动冲突')}</span>
      <span class="doc-notice-acts">
        <button class="pri" onclick={keepMine}>{t('保留我的')}</button>
        <button onclick={takeTheirs}>{t('用最新版')}</button>
      </span>
    </div>
  {:else if stale}
    <div class="doc-notice" role="alert">
      <svg class="doc-notice-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 11v5M12 7.5h.01"/><circle cx="12" cy="12" r="9"/></svg>
      <span class="doc-notice-t">{t('这篇在别处被修改过，未保存的草稿没有自动恢复')}</span>
      <span class="doc-notice-acts">
        <button class="pri" onclick={useStale}>{t('恢复草稿')}</button>
        <button onclick={dropStale}>{t('丢弃')}</button>
      </span>
    </div>
  {/if}

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
        <div class="doc-page" bind:this={pageEl} onclick={mdClick}>
          {#if note?.props?.length}
            <section class="doc-props" class:gap={/^[ \t]*\r?\n/.test(note.body)}>
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

  {#if restored && !stale && !conflict}<div class="doc-restored">{restored === 'merged' ? t('已把未保存的草稿与别处的新修改合并') : t('已恢复未保存草稿')}</div>{/if}
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
    --md-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --md-shadow-sm: 0 8px 24px rgba(70, 56, 34, .14), 0 1px 4px rgba(70, 56, 34, .06), 0 0 0 .5px rgba(20, 20, 19, .07);
    --md-ease: cubic-bezier(.2, .8, .2, 1);
    position: absolute; inset: 0; background: var(--md-bg); color: var(--md-fg); display: flex; flex-direction: column;
    padding-bottom: var(--kb, 0px);
    color-scheme: light;   /* 纸面恒为象牙白：原生控件/滚动条按浅色画，不继承 app 深色主题的 :root 声明（同 editor.css .mde） */
  }

  /* —— 顶栏：返回圆钮 + 文件名/状态两行 + 模式切换。整条纸面灰阶，只有冲突用警示色 —— */
  .doc-head { flex: none; display: flex; align-items: center; gap: 10px; padding: max(var(--pv-pad-y, 8px), var(--sat)) 12px var(--pv-pad-y, 8px) 8px;
    background: var(--md-bg); box-shadow: inset 0 -.5px 0 rgba(20, 20, 19, .12); }
  .doc-back { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; flex: none;
    color: var(--md-fg); background: rgba(20, 20, 19, .045); transition: background var(--mo-tap, 90ms), transform var(--mo-tap, 90ms); }
  .doc-back svg { width: 19px; height: 19px; margin-left: -1px; }
  @media (hover: hover) { .doc-back:hover { background: rgba(20, 20, 19, .075); } }
  .doc-back:active { background: rgba(20, 20, 19, .1); transform: scale(.94); }
  .doc-title-wrap { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; align-items: flex-start; gap: 1px; }
  .doc-title { max-width: 100%; font-size: 15px; font-weight: 600; line-height: 1.25; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; letter-spacing: -.15px; }
  .doc-sub { display: inline-flex; align-items: center; gap: 5px; max-width: 100%; min-width: 0; padding: 0; border: 0; background: none;
    font: inherit; font-size: 11.5px; line-height: 1.3; color: var(--md-fg-3); letter-spacing: .1px; text-align: left; animation: docsub .18s ease both; }
  .doc-sub svg { width: 12px; height: 12px; flex: none; }
  .doc-sub-t { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .doc-sub[data-kind='dirty'] { color: var(--md-fg-2); cursor: pointer; }
  .doc-sub[data-kind='warn'] { color: var(--md-danger); }
  .doc-sub-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--md-accent); flex: none; }
  .doc-sub-spin { width: 9px; height: 9px; box-sizing: border-box; border-radius: 50%; border: 1.5px solid rgba(20, 20, 19, .16); border-top-color: var(--md-fg-2);
    flex: none; animation: docspin .7s linear infinite; }
  @keyframes docsub { from { opacity: 0; transform: translateY(2px); } }

  /* 阅读/编辑/源码 三段切换：暖灰轨道 + 白色滑帽 */
  /* 三段等宽（grid 1fr）：滑帽固定 1/3 宽，英文三段字长不一（Read/Edit/Source）时也对得齐 */
  .doc-seg { position: relative; display: grid; grid-auto-flow: column; grid-auto-columns: 1fr; background: rgba(20, 20, 19, .055); border-radius: 999px; padding: 2px; flex: none; }
  .doc-seg-cap { position: absolute; top: 2px; left: 2px; width: calc(33.333% - 1.4px); height: calc(100% - 4px); background: #fff; border-radius: 999px;
    box-shadow: 0 1px 2px rgba(70, 56, 34, .12), 0 2px 8px rgba(70, 56, 34, .06), 0 0 0 .5px rgba(20, 20, 19, .07); transition: transform var(--mo-quick, 200ms) var(--md-ease); }
  .doc-seg button { position: relative; z-index: 1; padding: 5px 12px; font-size: 12.5px; color: var(--md-fg-2); font-weight: 500; flex: 1 0 auto;
    border-radius: 999px; transition: color var(--mo-micro, 140ms); }
  .doc-seg button.on { color: var(--md-fg); font-weight: 600; }
  /* 英文（html[lang=en]，lib/i18n.js 设置）：等宽三段按最长的 Source 撑宽，收窄左右内边距给文件名腾位（窄屏/工作台侧栏）；中文不动 */
  :global(html[lang='en']) .doc-seg button { padding-left: 8px; padding-right: 8px; }

  /* CM6 编辑器容器（内部样式在 mdeditor/editor.css，全局注入防 Svelte 剪枝） */
  .doc-cm { position: absolute; inset: 0; }

  /* 纯文本文件的保存：文字按钮（深珊瑚），不用色块 */
  .doc-savebtn { flex: none; padding: 6px 4px 6px 6px; font-size: 15px; font-weight: 600; color: var(--md-accent-deep); background: none;
    transition: opacity var(--mo-micro, 140ms); }
  .doc-savebtn:disabled { opacity: .4; }
  .doc-savebtn:not(:disabled):active { opacity: .55; }

  /* 顶栏下方的提示条（与磁盘冲突 / 草稿没自动恢复）：内嵌在版面里，不浮在正文上 */
  .doc-notice { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; padding: 9px 12px 9px 14px;
    font-size: 13px; line-height: 1.45; color: var(--md-fg); background: var(--md-panel); box-shadow: inset 0 -.5px 0 rgba(20, 20, 19, .12);
    animation: docsub .2s ease both; }
  .doc-notice.warn { background: #fbf1ec; }
  .doc-notice-ic { width: 17px; height: 17px; flex: none; color: var(--md-fg-3); }
  .doc-notice.warn .doc-notice-ic { color: var(--md-danger); }
  .doc-notice-t { flex: 1 1 180px; min-width: 0; }
  .doc-notice-acts { display: inline-flex; gap: 6px; margin-left: auto; }
  .doc-notice-acts button { padding: 5px 12px; border-radius: 999px; font-size: 13px; font-weight: 600; color: var(--md-fg); background: rgba(20, 20, 19, .06);
    transition: background var(--mo-tap, 90ms); }
  .doc-notice-acts button.pri { color: var(--md-bg); background: var(--md-fg); }
  .doc-notice-acts button:active { background: rgba(20, 20, 19, .12); }
  .doc-notice-acts button.pri:active { background: #33332f; }

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

  .doc-page { max-width: 760px; margin: 0 auto; padding: 14px 20px 60px; --ts-sel: var(--md-accent-soft); }   /* 触屏选区锁定时正文仍用这个高亮色（lib/touchSelection.js） */

  /* —— 笔记属性（frontmatter）面板 ——
     几何照编辑态面板（mdeditor/props.js + editor.css .mde-props）排：键列 138px = 26px 图标盒 + 1px +
     键名 6px 内边距，值从同一 x 起，行高按编辑态输入框撑出的 35px——切模式时键名/值不横跳。
     编辑态多出的「添加笔记属性」一行属合理差异；面板到正文的距离另由 margin-bottom 补齐。 */
  /* margin-bottom = 编辑态面板的 6px；frontmatter 后空一行（.gap，绝大多数笔记如此）再加这一行空行
     的 27.52px（行高，编辑态 .cm-line 不留纵向内边距）——编辑态正文前就是「面板 + 一行空行」 */
  .doc-props { border-bottom: 1px solid var(--md-line); padding: 2px 0 8px; margin-bottom: 6px; }
  .doc-props.gap { margin-bottom: 33.52px; }
  .doc-props-h { display: flex; align-items: center; gap: 4px; font-size: 13px; color: var(--md-fg-3); font-weight: 550; padding: 6px 4px 6px 0; transition: color var(--mo-micro, 140ms); }
  .doc-props-h:active { color: var(--md-fg-2); }
  .doc-chev { width: 14px; height: 14px; transition: transform .18s var(--md-ease); transform: rotate(90deg); }
  .doc-chev.closed { transform: rotate(0deg); }
  .doc-props-n { margin-left: 2px; font-size: 11.5px; background: var(--md-bg-2); color: var(--md-fg-3); padding: 1px 7px; border-radius: 999px; }
  .doc-props-tbl { display: flex; flex-direction: column; gap: 1px; }
  /* 键名/值的文字盒照编辑态输入框：同字号、4px 6px 内边距、line-height normal（input 的默认），行高才一致 */
  .doc-prop { display: flex; gap: 6px; padding: 2px 0; min-height: calc(13.5px * 1.72 + 12px); align-items: center; font-size: 14px; }   /* = 编辑态行：输入框 23.22 + 上下 4px + 行 2px */
  .doc-prop-k { flex: none; width: 138px; display: flex; align-items: center; gap: 1px; color: var(--md-fg-2); overflow: hidden; }
  .doc-prop-k :global(svg) { width: 15px; height: 15px; flex: none; margin: 0 5.5px; opacity: .72; }
  .doc-prop-k span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding: 4px 6px; font-size: 13.5px; line-height: normal; }
  .doc-prop-v { flex: 1; min-width: 0; color: var(--md-fg); display: flex; flex-wrap: wrap; gap: 4px; align-items: center; word-break: break-word; }
  .doc-prop-txt { white-space: pre-wrap; padding: 4px 6px; line-height: normal; }
  .doc-prop-empty { color: var(--md-fg-4); padding: 4px 6px; line-height: normal; }
  .doc-prop-json { font-family: var(--md-mono); font-size: 12.5px; color: #bc5215; background: rgba(188, 82, 21, .08); border-radius: 5px; padding: 2px 7px; word-break: break-all; }
  .doc-chip { background: var(--md-bg-2); border-radius: 999px; padding: 2px 10px; font-size: 13px; word-break: break-all; }
  .doc-chip-tag { color: var(--md-accent-deep); background: var(--md-accent-tint); }
  /* 只读勾选框自绘（原生 disabled 态是一坨灰）；编辑态 .mde-pv-bool 是同一副框，改一处两边一起改 */
  .doc-prop-v input[type="checkbox"] {
    appearance: none; -webkit-appearance: none; width: 16px; height: 16px; margin: 4px 6px; border-radius: 5px;   /* margin 同编辑态 .mde-pv-bool */
    border: 1.6px solid var(--md-line-2); background: #fff; position: relative; opacity: 1;
  }
  .doc-prop-v input[type="checkbox"]:checked { background: var(--md-accent); border-color: var(--md-accent); }
  .doc-prop-v input[type="checkbox"]:checked::after {
    content: ''; position: absolute; left: 4.2px; top: 1px; width: 3.8px; height: 7.6px;
    border: solid #fff; border-width: 0 2px 2px 0; transform: rotate(43deg);
  }

  /* 属性面板里 [[双链]] 值的链接样（正文里的 a.wk 在 lib/mdrender.css） */
  .doc-props :global(a.wk) { color: var(--md-accent-deep); text-decoration: none; border-bottom: 1px solid rgba(181, 83, 47, .35); cursor: pointer; word-break: break-all; }
  .doc-props :global(a.wk:active) { background: var(--md-accent-tint); }

  /* Markdown 预览排版（象牙白文档）——正文块/行内元素的规则在 lib/mdrender.css（随 obsmd 注入，
     与编辑态 callout 卡共用一份）；这里只留阅读态特有的：容器、文首对齐、围栏头。
     数值与 mdeditor/editor.css 的 Live Preview 保持一致，两个模式来回切时不该有观感落差
     （字号/行高/间距/块样式全对齐；字体统一走全局 --sans）*/
  /* 上内边距 1px + 上外边距 −1px：净高为 0（编辑态行不留纵向内边距，文首就是第一行），但这 1px 挡住
     首块的上外边距穿过 .doc-md 与属性面板的 margin-bottom 折叠成取大值——编辑态是「面板 + 空行 +
     标题行 padding-top」相加 */
  .doc-md { font-size: 16px; line-height: 1.72; word-wrap: break-word; padding-top: 1px; margin-top: -1px; }
  .doc-md :global(*) { -webkit-touch-callout: default; }   /* 长按可起选择/复制（body 全局是禁的）*/
  .doc-md :global(::selection) { background: var(--md-accent-soft); }
  /* 文首齐平：阅读↔编辑切换时首屏不上下跳。编辑态文首就是第一行（content 14px，行本身不留纵向
     内边距），阅读态首块上外边距清零；首块是标题时换成编辑态该级标题行的 padding-top；代码块/
     callout/引用与编辑态同样从 0 起（自带内边距或是块 widget）；表格 widget 自带 6px 外边距；
     列表行上下各 2.4px。有属性面板时，面板与正文之间的「空行」由 .doc-props 的 margin-bottom 补，
     首块同样按这套规则贴上去。
     前缀 .doc-root 多压一级特异度：共享排版（mdrender.css）里的块外边距规则要稳稳被盖住。 */
  .doc-root .doc-page > .doc-md > :global(:first-child) { margin-top: 0; }
  .doc-root .doc-page > .doc-md > :global(h1:first-child) { margin-top: .35em; }
  .doc-root .doc-page > .doc-md > :global(h2:first-child) { margin-top: .3em; }
  .doc-root .doc-page > .doc-md > :global(h3:first-child) { margin-top: .25em; }
  .doc-root .doc-page > .doc-md > :global(h4:first-child),
  .doc-root .doc-page > .doc-md > :global(h5:first-child),
  .doc-root .doc-page > .doc-md > :global(h6:first-child) { margin-top: .2em; }
  .doc-root .doc-page > .doc-md > :global(table:first-child) { margin-top: 6px; }
  .doc-root .doc-page > .doc-md > :global(hr:first-child) { margin-top: .86em; }   /* 编辑态 --- 行的上半行（线在行正中） */
  .doc-root .doc-page > .doc-md > :global(ul:first-child > li:first-child),
  .doc-root .doc-page > .doc-md > :global(ol:first-child > li:first-child) { margin-top: 2.4px; }
  /* 代码块围栏头（语言 + 复制）：编辑态有，阅读态也补上，两边同一副长相；定高 22px = 编辑态
     .mde-fencehead 撑出的那一行，下面紧接第一行代码（不留缝，块内逐行与编辑态同位） */
  .doc-md :global(.doc-fence) { display: flex; align-items: center; gap: 10px; height: 22px; white-space: normal; font-family: var(--sans); line-height: 1.2; }
  .doc-md :global(.doc-fence-lang) { color: var(--md-fg-3); font-size: 11.5px; text-transform: lowercase; letter-spacing: .3px; }
  .doc-md :global(.doc-fence-copy) { margin-left: auto; border: 1px solid var(--md-line); background: var(--md-panel); color: var(--md-fg-2); font-size: 11.5px; padding: 2px 10px; border-radius: 999px;
    transition: background var(--mo-micro, 140ms), color var(--mo-micro, 140ms); }
  .doc-md :global(.doc-fence-copy:active) { background: var(--md-bg-3); }

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

  .doc-restored { position: absolute; left: 50%; bottom: calc(16px + var(--kb, 0px)); transform: translateX(-50%); background: rgba(20, 20, 19, .86); color: #faf9f5; font-size: 12.5px; padding: 6px 14px; border-radius: 999px; pointer-events: none; box-shadow: var(--md-shadow-sm); white-space: nowrap; }
  .doc-toast { position: absolute; left: 50%; bottom: calc(54px + var(--kb, 0px)); transform: translateX(-50%); background: rgba(20, 20, 19, .86); color: #faf9f5; font-size: 13px; padding: 8px 18px; border-radius: 999px; pointer-events: none; box-shadow: var(--md-shadow-sm); }
</style>
