<script>
  // 公开只读分享页（/w/<token>）——访客看到的就是这一页。
  //
  // 以前直接复用工作空间的 FilesPanel(readonly)：那是给主人用的 iOS 文件 app 形态，访客
  // 模式靠一堆 !readonly 硬抠出来，根标签的链图标折到标题上一行、传输环孤零零悬在右上、
  // 桌面宽屏列表横穿整屏。这里改成专门的访客页：头部写清「分享了什么、多大、何时失效」，
  // 面包屑 + 列表/网格两种视图 + 逐项下载（带进度），预览仍走全局 MediaViewer。
  // 单文件分享也是一个空间（桶里就这一个文件），和文件夹分享同一套：点击打开、右键/长按下载。
  //
  // 数据面：/api/files（列目录）、/api/file（缩略图/下载）、/api/share-meta（头部元信息）
  // 全经 apiUrl() → withShare() 自动带 ?st=<token[.k]>，后端解析成 cwd 锁桶内的只读身份。
  // 目录位置写进 location.hash（#/子目录/...）：刷新不丢、浏览器返回＝回上一级。
  import { onMount } from 'svelte';
  import MediaViewer from './preview/MediaViewer.svelte';
  import { apiUrl } from '../lib/server.js';
  import { openPreview, closePreview, preview, cloudFileUrl } from '../lib/preview.svelte.js';
  import { t, tc, locale, isEn } from '../lib/i18n.js';

  // —— 文件分类（本页自用：决定图标、缩略图、点开方式）——
  const EXT = {
    image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'svg'],
    video: ['mp4', 'mov', 'webm', 'mkv', 'avi', 'm4v', '3gp'],
    audio: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus', 'amr'],
    pdf: ['pdf'],
    doc: ['doc', 'docx', 'odt', 'rtf', 'pages'],
    sheet: ['xls', 'xlsx', 'ods', 'csv', 'numbers'],
    slide: ['ppt', 'pptx', 'odp', 'key'],
    md: ['md', 'markdown', 'mdown', 'mkd'],
    html: ['html', 'htm'],
    zip: ['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz'],
    code: ['js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'json', 'css', 'scss', 'py', 'sh', 'ps1', 'bat', 'yml', 'yaml', 'toml', 'ini', 'xml', 'sql', 'c', 'h', 'cpp', 'java', 'kt', 'go', 'rs', 'rb', 'php', 'lua', 'swift', 'vue', 'svelte'],
    text: ['txt', 'log', 'tex', 'rst', 'conf', 'env'],
  };
  const extOf = (n) => (n.includes('.') ? n.split('.').pop().toLowerCase() : '');
  function kindOf(it) {
    if (it.isDir) return 'dir';
    const e = extOf(it.name);
    for (const k in EXT) if (EXT[k].includes(e)) return k;
    return 'file';
  }
  // 预览查看器认的 kind（preview.svelte.js 词表）；null = 没有内嵌预览，点开直接下载。
  const VIEW = { image: 'image', video: 'video', audio: 'audio', pdf: 'pdf', doc: 'office', sheet: 'office', slide: 'office', md: 'markdown', html: 'html', code: 'text', text: 'text' };
  const KIND_LABEL = { dir: t('文件夹'), image: t('图片'), video: t('视频'), audio: t('音频'), pdf: 'PDF', doc: t('文档'), sheet: tc('files', '表格'), slide: t('演示文稿'), md: 'Markdown', html: t('网页'), zip: tc('files', '压缩包'), code: t('代码'), text: t('文本'), file: t('文件') };

  // 类型图标：浅色底 + 同色描边字形（24 视框）。颜色走 --k 变量，暗色下同样可读。
  const GLYPH = {
    dir: '<path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.4l2 2.2H18a2.5 2.5 0 0 1 2.5 2.5v7.3A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17z"/>',
    image: '<rect x="4" y="4.5" width="16" height="15" rx="2.5"/><circle cx="9.2" cy="9.6" r="1.6"/><path d="m5.5 17.5 4.3-4.4 3 3 2.3-2.3 3.4 3.5"/>',
    video: '<rect x="3.5" y="5.5" width="17" height="13" rx="2.8"/><path d="m10.3 9.4 4.5 2.6-4.5 2.6z"/>',
    audio: '<path d="M9 17.5V7l9.5-2v10.5"/><circle cx="6.8" cy="17.5" r="2.2"/><circle cx="16.3" cy="15.5" r="2.2"/>',
    pdf: '<path d="M6.5 3.5h7.5l4 4v13h-11.5z"/><path d="M14 3.5v4h4"/><path d="M9 13.5h6M9 16.5h4"/>',
    doc: '<path d="M6.5 3.5h7.5l4 4v13h-11.5z"/><path d="M14 3.5v4h4"/><path d="M9 11.5h6M9 14.5h6M9 17.5h3.5"/>',
    sheet: '<rect x="4" y="4.5" width="16" height="15" rx="2.5"/><path d="M4 9.5h16M4 14.5h16M10 4.5v15"/>',
    slide: '<rect x="3.5" y="5" width="17" height="11.5" rx="2"/><path d="M12 16.5v3M8.5 19.5h7"/>',
    md: '<rect x="3.5" y="6" width="17" height="12" rx="2.5"/><path d="M7 15V9l2.5 3L12 9v6M15.5 9v6m-2-2 2 2 2-2"/>',
    html: '<circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.1 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.1-3.6-8.5s1.2-6.2 3.6-8.5z"/>',
    zip: '<rect x="4.5" y="4" width="15" height="16" rx="2.5"/><path d="M12 4v2m0 2v2m0 2v2"/><rect x="10.3" y="14" width="3.4" height="3.2" rx=".8"/>',
    code: '<path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.3 6l-2.6 12"/>',
    text: '<path d="M6.5 3.5h7.5l4 4v13h-11.5z"/><path d="M14 3.5v4h4"/><path d="M9 12.5h6M9 15.5h6"/>',
    file: '<path d="M6.5 3.5h7.5l4 4v13h-11.5z"/><path d="M14 3.5v4h4"/>',
  };
  const TINT = { dir: 'var(--accent)', image: '#2f7fd1', video: '#7a5af5', audio: '#e0457b', pdf: '#d9453b', doc: '#2f6fd6', sheet: '#1f9d63', slide: '#e0662d', md: '#6f6d66', html: '#c2562b', zip: '#c98a12', code: '#2f8f8f', text: '#6f6d66', file: '#8a877f' };
  const glyph = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${GLYPH[k] || GLYPH.file}</svg>`;

  // —— 格式化 ——
  function fmtSize(n) {
    if (n == null || !Number.isFinite(n)) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.max(1, Math.round(n / 1024)) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';
  }
  // 日期交给 Intl：zh-CN 下输出与原先手拼的「9月28日」「2025年9月28日 09:05」逐字一致；英文按 en-US（12 小时制）。
  const HM = isEn() ? { hour: 'numeric', minute: '2-digit' } : { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  const dtf = (d, o) => new Intl.DateTimeFormat(locale(), o).format(d);
  function fmtDate(ms) {
    if (!ms) return '';
    const d = new Date(ms), now = new Date();
    if (d.toDateString() === now.toDateString()) return t('今天 {time}', { time: dtf(d, HM) });
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return t('昨天 {time}', { time: dtf(d, HM) });
    return dtf(d, { ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}), month: 'short', day: 'numeric' });
  }
  const fmtFull = (ms) => dtf(new Date(ms), { year: 'numeric', month: 'short', day: 'numeric', ...HM });
  function fmtLeft(ms) {
    const left = ms - Date.now();
    if (left <= 0) return t('已过期');
    const h = left / 3600e3;
    if (h < 1) return t('1 小时内失效');
    if (h < 24) return t('{n} 小时后失效', { n: Math.floor(h) });
    return t('{n} 天后失效', { n: Math.floor(h / 24) });
  }
  const metaOf = (it, k) => (it.isDir ? t('文件夹') : [KIND_LABEL[k], fmtSize(it.size), fmtDate(it.mtime)].filter(Boolean).join(' · '));
  // 长文件名中段省略：主干可截，扩展名永远露出来（「一个名字特别长…最终版.txt」）。
  function splitName(n) {
    const i = n.lastIndexOf('.');
    return i > 0 && n.length - i <= 8 ? [n.slice(0, i), n.slice(i)] : [n, ''];
  }

  // —— 状态 ——
  let meta = $state(null);          // { count, bytes, createdAt, expiresAt }
  let base = $state('');            // 桶根只有一个文件夹时自动进它，把它当根（标题=它的名字）
  let rootItems = $state([]);       // 桶根列表（算标题用）
  let topItems = $state([]);        // 「根」的列表（有 base 时是 base 里面）——头部摘要用
  let sub = $state('');             // 当前位置（相对 base）
  let items = $state([]);
  let phase = $state('boot');       // boot | ready | gone | error
  let listing = $state(false);
  let viewPref = $state(readPref());
  let tasks = $state([]);           // 下载任务 { id, name, total, sent, status }
  let toastMsg = $state('');
  let scrolled = $state(false);
  let barEl = $state(null);
  let reqSeq = 0;

  function readPref() { try { return localStorage.getItem('bridge-share-view') || ''; } catch { return ''; } }
  function setView(v) { viewPref = v; try { localStorage.setItem('bridge-share-view', v); } catch {} }

  const join = (...p) => p.filter(Boolean).join('/');
  const relOf = (it) => join(base, sub, it.name);
  const segs = $derived(sub ? sub.split('/') : []);
  const files = $derived(items.filter((it) => !it.isDir));
  // 默认视图：当前目录以图片/视频为主（≥60%）用网格看缩略图，否则列表。用户手动切过就记住。
  const mediaShare = $derived(files.length ? files.filter((f) => ['image', 'video'].includes(kindOf(f))).length / files.length : 0);
  const view = $derived(viewPref || (files.length >= 2 && mediaShare >= 0.6 ? 'grid' : 'list'));

  const single = $derived(!base && rootItems.length === 1 && !rootItems[0].isDir ? rootItems[0] : null);
  const title = $derived(base || (single ? single.name : rootItems.length ? t('{name} 等 {n} 项', { name: rootItems[0].name, n: rootItems.length }) : t('分享')));
  const heroKind = $derived(single ? kindOf(single) : 'dir');
  const summary = $derived.by(() => {
    const nd = topItems.filter((x) => x.isDir).length, nf = topItems.length - nd;
    const a = nd ? t('{n} 个文件夹', { n: nd }) : '', b = nf ? t('{n} 个文件', { n: nf }) : '';
    return a && b ? t('{folders}、{files}', { folders: a, files: b }) : a || b;
  });

  $effect(() => { if (phase === 'ready') document.title = t('{title} · 分享', { title }); });

  // —— 数据 ——
  class HttpError extends Error { constructor(status) { super('HTTP ' + status); this.status = status; } }
  async function list(rel) {
    const r = await fetch(apiUrl('/api/files?path=' + encodeURIComponent(rel)), { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw new HttpError(r.status);
    const j = await r.json();
    return Array.isArray(j.items) ? j.items : [];
  }
  const subFromHash = () => { try { return decodeURIComponent(location.hash.replace(/^#\/?/, '')).replace(/^\/+|\/+$/g, ''); } catch { return ''; } };

  async function boot() {
    phase = 'boot';
    fetch(apiUrl('/api/share-meta'), { credentials: 'same-origin', cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) meta = j; }).catch(() => {});
    try {
      const top = await list('');
      rootItems = top;
      base = top.length === 1 && top[0].isDir ? top[0].name : '';
      topItems = base ? await list(base) : top;
      await go(subFromHash(), { initial: true });
      phase = 'ready';
    } catch (e) {
      phase = e?.status === 401 || e?.status === 403 || e?.status === 404 ? 'gone' : 'error';
    }
  }

  async function go(next, { initial = false } = {}) {
    const seq = ++reqSeq;
    listing = true;
    try {
      let got;
      if (!next) got = topItems;
      else {
        try { got = await list(join(base, next)); }
        catch (e) {
          // 子目录没了（深链过期、手改了 hash）：回根；其余错误（断网）原地提示不跳。
          if (e?.status === 401 || (!initial && e?.status !== 404)) throw e;
          if (!initial) toast(t('这个文件夹已不存在'));
          history.replaceState(history.state, '', location.pathname + location.search);
          next = ''; got = topItems;
        }
      }
      if (seq !== reqSeq) return;
      sub = next; items = got;
    } catch (e) {
      if (seq !== reqSeq) return;
      if (initial) throw e;
      if (e?.status === 401) { phase = 'gone'; return; }
      toast(t('加载失败，请重试'));
    } finally { if (seq === reqSeq) listing = false; }
  }
  function setHash(p) {
    const h = p ? '#/' + p.split('/').map(encodeURIComponent).join('/') : '';
    if ((location.hash || '') === h) { if (p !== sub) go(p); return; }
    if (h) location.hash = h;
    else history.pushState(history.state, '', location.pathname + location.search);   // 回根不留孤零零的 '#'
    if (!h) go('');
  }
  const openDir = (it) => setHash(join(sub, it.name));
  const goSeg = (i) => setHash(segs.slice(0, i + 1).join('/'));
  const goUp = () => setHash(segs.slice(0, -1).join('/'));

  // —— 打开 / 预览 ——
  const srcItem = (it, kind) => ({ origin: 'cloud', rel: relOf(it), name: it.name, kind, mt: it.mtime });
  function open(it) {
    if (it.isDir) { openDir(it); return; }
    const k = kindOf(it), v = VIEW[k];
    if (!v) { download(it); return; }
    if (v === 'image') {
      const imgs = files.filter((f) => kindOf(f) === 'image');
      openPreview(imgs.map((f) => srcItem(f, 'image')), Math.max(0, imgs.indexOf(it)), { host: 'app' });
      return;
    }
    openPreview([srcItem(it, v)], 0, { host: 'app' });
  }

  // —— 下载：fetch 流式读进度 → 底部下载条；大文件交给浏览器原生下载（Blob 攒不动）——
  const TRACK_MAX = 300 * 1024 * 1024;
  let uid = 0;
  function nativeDownload(it) {
    const a = document.createElement('a');
    a.href = cloudFileUrl(relOf(it), { dl: true }); a.download = it.name; a.rel = 'noopener';
    document.body.appendChild(a); a.click(); a.remove();
  }
  async function download(it) {
    if (it.size > TRACK_MAX) { nativeDownload(it); toast(t('已交给浏览器下载')); return; }
    const id = 'd' + Date.now() + (uid++);
    tasks = [...tasks, { id, name: it.name, total: it.size || 0, sent: 0, status: 'run', ctrl: new AbortController() }];
    // Svelte5 深代理：必须改数组里的代理元素，改裸字面量 UI 不动（同 FilesPanel.downloadTracked）。
    const tk = tasks[tasks.length - 1];
    try {
      const res = await fetch(cloudFileUrl(relOf(it)), { credentials: 'same-origin', signal: tk.ctrl.signal });
      if (!res.ok || !res.body) throw new Error('HTTP ' + res.status);
      tk.total = Number(res.headers.get('content-length')) || tk.total;
      const reader = res.body.getReader();
      const chunks = [];
      let sent = 0, last = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); sent += value.byteLength;
        const now = performance.now();
        if (now - last > 120) { tk.sent = sent; last = now; }   // 节流：chunk 很密，别逐个驱动渲染
      }
      tk.sent = sent; tk.total = Math.max(tk.total, sent) || 1;
      const u = URL.createObjectURL(new Blob(chunks));
      const a = document.createElement('a');
      a.href = u; a.download = it.name; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(u), 60000);
      tk.status = 'done';
      setTimeout(() => { tasks = tasks.filter((x) => x.id !== id); }, 2600);
    } catch (e) {
      if (tk.status === 'cancel' || e?.name === 'AbortError') { setTimeout(() => { tasks = tasks.filter((x) => x.id !== id); }, 1200); return; }
      tasks = tasks.filter((x) => x.id !== id);
      nativeDownload(it);   // 流式失败退回原生下载，至少能下到
    }
  }
  function cancel(task) { if (task.status !== 'run') return; task.status = 'cancel'; try { task.ctrl.abort(); } catch {} }
  const pct = (task) => (task.total > 0 ? Math.min(100, Math.round((task.sent / task.total) * 100)) : 0);

  let toastTimer = null;
  function toast(m) { toastMsg = m; clearTimeout(toastTimer); toastTimer = setTimeout(() => (toastMsg = ''), 2200); }

  // —— 缩略图：加载成功才淡入，失败保持类型图标 ——
  const thumbable = (it) => ['image', 'video'].includes(kindOf(it));
  const thumbSrc = (it) => cloudFileUrl(relOf(it), { thumb: true, mt: it.mtime });
  const thumbOk = (e) => e.currentTarget.classList.add('ok');
  const thumbErr = (e) => { e.currentTarget.style.display = 'none'; };   // 别 remove()：那是 Svelte 管的节点

  // —— 右键 / 长按菜单：打开·下载 ——
  // 桌面右键直接出；触屏长按自己计时（iOS Safari 不发 contextmenu），安卓长按会再补一个
  // contextmenu，同一项已开着就忽略。长按出菜单后紧跟的那次 click 要吞掉，别又把文件打开。
  let menu = $state(null);          // { it, x, y }
  let lp = null, eatClick = false;
  const MENU_W = 188;
  function showMenu(it, x, y) { menu = { it, x, y }; }
  function closeMenu() { menu = null; }
  function onCtx(e, it) {
    e.preventDefault();
    lpCancel();
    if (menu?.it === it) return;
    showMenu(it, e.clientX, e.clientY);
  }
  function lpStart(e, it) {
    if (e.pointerType !== 'touch') return;
    lpCancel();
    const x = e.clientX, y = e.clientY;
    lp = { x, y, t: setTimeout(() => { lp = null; eatClick = true; showMenu(it, x, y); try { navigator.vibrate?.(8); } catch {} }, 480) };
  }
  function lpMove(e) { if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) lpCancel(); }
  function lpCancel() { if (lp) { clearTimeout(lp.t); lp = null; } }
  function lpEnd() { lpCancel(); if (eatClick) setTimeout(() => (eatClick = false), 350); }
  function tap(it) { if (eatClick) { eatClick = false; return; } open(it); }
  const press = (it) => ({
    oncontextmenu: (e) => onCtx(e, it),
    onpointerdown: (e) => lpStart(e, it),
    onpointermove: lpMove,
    onpointerup: lpEnd,
    onpointercancel: lpEnd,
  });
  const menuPos = $derived.by(() => {
    if (!menu) return '';
    const h = (menu.it.isDir || !VIEW[kindOf(menu.it)] ? 1 : 2) * 40 + 50;
    const left = Math.max(8, Math.min(menu.x, innerWidth - MENU_W - 8));
    const top = menu.y + h > innerHeight - 8 ? Math.max(8, menu.y - h) : menu.y;
    return `left:${left}px;top:${top}px;width:${MENU_W}px`;
  });
  function menuAct(act) {
    const it = menu?.it; closeMenu();
    if (!it) return;
    if (act === 'dl') download(it); else open(it);
  }

  // —— 系统返回：预览开着时先关预览（SharePage 不跑 App 的 nav 哨兵，自己垫一层）——
  let pvEntry = false;
  $effect(() => {
    if (preview.open && !pvEntry) { pvEntry = true; history.pushState({ sharePv: 1 }, ''); }
    else if (!preview.open && pvEntry) { pvEntry = false; if (history.state?.sharePv) history.back(); }
  });

  onMount(() => {
    const html = document.documentElement;
    html.classList.add('share-mode');
    // 浏览器顶栏颜色跟页面底色（index.html 写死的是 App 的暗色）
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const themeMeta = document.querySelector('meta[name="theme-color"]');
    const syncTheme = () => themeMeta?.setAttribute('content', mq.matches ? '#1a1a19' : '#f6f5f1');
    syncTheme(); mq.addEventListener?.('change', syncTheme);
    const onHash = () => { closeMenu(); const p = subFromHash(); if (phase === 'ready' && p !== sub) go(p); };
    const onKey = (e) => { if (e.key === 'Escape' && menu) { e.stopPropagation(); closeMenu(); } };
    const onPop = () => { if (preview.open && !history.state?.sharePv) { pvEntry = false; closePreview(); } };
    addEventListener('hashchange', onHash);
    addEventListener('popstate', onPop);
    addEventListener('keydown', onKey, true);
    addEventListener('resize', closeMenu);
    boot();
    return () => {
      html.classList.remove('share-mode');
      mq.removeEventListener?.('change', syncTheme);
      removeEventListener('hashchange', onHash);
      removeEventListener('popstate', onPop);
      removeEventListener('keydown', onKey, true);
      removeEventListener('resize', closeMenu);
    };
  });
</script>

<div class="sp" onscroll={(e) => { scrolled = !!barEl && e.currentTarget.scrollTop > barEl.offsetTop - 1; if (menu) closeMenu(); }}>
  <div class="col">
    <header class="brand">
      <span class="mark">Muse Bridge</span>
      <span class="ro"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>{t('只读分享')}</span>
    </header>

    {#if phase === 'gone'}
      <section class="state card">
        <div class="badge muted">{@html '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 17H7A5 5 0 0 1 7 7"/><path d="M15 7h2a5 5 0 0 1 4 8"/><path d="M8 12h4"/><path d="m3 3 18 18"/></svg>'}</div>
        <h1>{t('链接已失效')}</h1>
        <p>{t('这个分享不存在或已经过期。')}<br />{t('如需继续访问，请联系分享者重新分享。')}</p>
      </section>
    {:else if phase === 'error'}
      <section class="state card">
        <div class="badge muted">{@html glyph('file')}</div>
        <h1>{t('加载失败')}</h1>
        <p>{t('网络好像不太顺畅，稍后再试一次。')}</p>
        <button class="btn" onclick={boot}>{t('重新加载')}</button>
      </section>
    {:else}
      <!-- 头部：分享了什么 / 多少 / 多大 / 何时失效 -->
      <section class="hero">
        {#if phase === 'boot'}
          <div class="htile sk"></div>
          <div class="htext"><div class="sk sk-t"></div><div class="sk sk-m"></div></div>
        {:else}
          <div class="htile" style="--k:{TINT[heroKind]}">{@html glyph(heroKind)}</div>
          <div class="htext">
            <h1 title={title}>{title}</h1>
            <div class="chips">
              {#if summary && !single}<span class="chip">{summary}</span>{/if}
              {#if single}<span class="chip">{fmtSize(single.size)}</span>
              {:else if meta?.bytes}<span class="chip">{t('共 {size}', { size: fmtSize(meta.bytes) })}</span>{/if}
              {#if meta?.expiresAt}
                <span class="chip exp" class:soon={meta.expiresAt - Date.now() < 86400e3} title={t('有效期至 {time}', { time: fmtFull(meta.expiresAt) })}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>{fmtLeft(meta.expiresAt)}
                </span>
              {/if}
            </div>
          </div>
        {/if}
      </section>

      {#if phase === 'ready'}
      <!-- 路径条（吸顶）+ 视图切换 -->
      <nav class="bar" class:stuck={scrolled} aria-label={t('位置')} bind:this={barEl}>
        {#if segs.length}
          <button class="up" onclick={goUp} aria-label={t('返回上一级')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m14.5 6-6 6 6 6"/></svg></button>
        {/if}
        <div class="crumbs">
          <button class="crumb" class:cur={!segs.length} onclick={() => setHash('')}>{t('全部文件')}</button>
          {#each segs as s, i (i)}
            <span class="sep" aria-hidden="true">/</span>
            <button class="crumb" class:cur={i === segs.length - 1} onclick={() => goSeg(i)}>{s}</button>
          {/each}
        </div>
        {#if items.length}
          <div class="seg" role="group" aria-label={t('视图')}>
            <button class:on={view === 'list'} onclick={() => setView('list')} aria-label={t('列表视图')} aria-pressed={view === 'list'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6.5h11M9 12h11M9 17.5h11M4.5 6.5h.01M4.5 12h.01M4.5 17.5h.01"/></svg></button>
            <button class:on={view === 'grid'} onclick={() => setView('grid')} aria-label={t('网格视图')} aria-pressed={view === 'grid'}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="4" width="6.5" height="6.5" rx="1.6"/><rect x="4" y="13.5" width="6.5" height="6.5" rx="1.6"/><rect x="13.5" y="13.5" width="6.5" height="6.5" rx="1.6"/></svg></button>
          </div>
        {/if}
      </nav>
      {/if}

      {#if phase === 'boot'}
        <div class="list card" aria-busy="true">
          {#each [0, 1, 2, 3] as i (i)}
            <div class="row skrow"><span class="tile sk"></span><span class="main"><span class="sk sk-n"></span><span class="sk sk-s"></span></span></div>
          {/each}
        </div>
      {:else if !items.length}
        <div class="empty card" class:dim={listing}>
          <div class="badge muted">{@html glyph('dir')}</div>
          <p>{t('这个文件夹是空的')}</p>
        </div>
      {:else if view === 'grid'}
        <div class="grid" class:dim={listing}>
          {#each items as it (it.name)}
            {@const k = kindOf(it)}
            <button class="cell" class:ctx-on={menu?.it === it} onclick={() => tap(it)} title={it.name} {...press(it)}>
              <span class="cthumb" style="--k:{TINT[k]}">
                <span class="cglyph">{@html glyph(k)}</span>
                {#if thumbable(it)}<img src={thumbSrc(it)} alt="" loading="lazy" decoding="async" draggable="false" onload={thumbOk} onerror={thumbErr} />{/if}
                {#if k === 'video'}<span class="play"><svg viewBox="0 0 24 24"><path d="M8.5 5.8v12.4L19 12z" /></svg></span>{/if}
              </span>
              <span class="cname">{it.name}</span>
              <span class="cmeta">{it.isDir ? t('文件夹') : fmtSize(it.size)}</span>
            </button>
          {/each}
        </div>
      {:else}
        <div class="list card" class:dim={listing}>
          {#each items as it (it.name)}
            {@const k = kindOf(it)}
            {@const nm = splitName(it.name)}
            <div class="row" class:ctx-on={menu?.it === it} {...press(it)}>
              <button class="hit" onclick={() => tap(it)} title={it.name}>
                <span class="tile" style="--k:{TINT[k]}">
                  {@html glyph(k)}
                  {#if thumbable(it)}<img src={thumbSrc(it)} alt="" loading="lazy" decoding="async" draggable="false" onload={thumbOk} onerror={thumbErr} />{/if}
                  {#if k === 'video'}<span class="play sm"><svg viewBox="0 0 24 24"><path d="M8.5 5.8v12.4L19 12z" /></svg></span>{/if}
                </span>
                <span class="main">
                  <span class="name"><span class="stem">{nm[0]}</span>{#if nm[1]}<span class="ext">{nm[1]}</span>{/if}</span>
                  <span class="meta">{metaOf(it, k)}</span>
                </span>
              </button>
              {#if it.isDir}
                <span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9.5 6 6 6-6 6"/></svg></span>
              {:else}
                <button class="dl" onclick={() => download(it)} aria-label={t('下载 {name}', { name: it.name })} title={t('下载')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19.5h14"/></svg></button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

      <footer class="foot">
        {#if meta?.expiresAt}{t('链接有效期至 {time}，到期后内容自动删除', { time: fmtFull(meta.expiresAt) })}{:else}{t('只读分享，到期后内容自动删除')}{/if}
      </footer>
    {/if}
  </div>
</div>

<!-- 右键 / 长按菜单 -->
{#if menu}
  <div class="ctx-mask" onpointerdown={closeMenu} oncontextmenu={(e) => { e.preventDefault(); closeMenu(); }} role="presentation"></div>
  <div class="ctx" style={menuPos} role="menu">
    <div class="ctx-name" title={menu.it.name}>{menu.it.name}</div>
    {#if menu.it.isDir}
      <button role="menuitem" onclick={() => menuAct('open')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h3.4l2 2.2H18a2.5 2.5 0 0 1 2.5 2.5v7.3A2.5 2.5 0 0 1 18 19.5H6A2.5 2.5 0 0 1 3.5 17z"/></svg>{t('打开')}</button>
    {:else}
      {#if VIEW[kindOf(menu.it)]}
        <button role="menuitem" onclick={() => menuAct('open')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 12s3.5-6.5 9.5-6.5 9.5 6.5 9.5 6.5-3.5 6.5-9.5 6.5S2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>{t('预览')}</button>
      {/if}
      <button role="menuitem" onclick={() => menuAct('dl')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m-4.5-4.5L12 15l4.5-4.5M5 19.5h14"/></svg>{t('下载')}<span class="ctx-sz">{fmtSize(menu.it.size)}</span></button>
    {/if}
  </div>
{/if}

<!-- 下载条 + 提示 -->
<div class="dock" aria-live="polite">
  {#if toastMsg}<div class="toast">{toastMsg}</div>{/if}
  {#each tasks as task (task.id)}
    <div class="task" class:done={task.status === 'done'} class:cancel={task.status === 'cancel'}>
      <span class="tname">{task.name}</span>
      <span class="tstat">{task.status === 'done' ? t('已下载') : task.status === 'cancel' ? t('已取消') : task.total ? pct(task) + '%' : fmtSize(task.sent)}</span>
      {#if task.status === 'run'}
        <button class="tx" onclick={() => cancel(task)} aria-label={t('取消下载')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="m7 7 10 10M17 7 7 17"/></svg></button>
      {:else if task.status === 'done'}
        <span class="tok" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5.5 12.5 4 4 9-9"/></svg></span>
      {/if}
      <span class="tbar" style="width:{task.status === 'done' ? 100 : pct(task)}%"></span>
    </div>
  {/each}
</div>

<MediaViewer />

<style>
  /* 只在分享页生效（main.js 按 /w/ 挂本组件，onMount 给 <html> 加 .share-mode）。
     Svelte 会把所有组件 CSS 打进同一个包，这里的全局规则必须挂在 .share-mode 下，别漏到 App。 */
  :global(html.share-mode) { color-scheme: light dark; }
  :global(html.share-mode body) { background: var(--bg-share, #f6f5f1); user-select: text; -webkit-user-select: text; }

  .sp, .ctx {
    --bg: #f6f5f1; --card: #fff; --ink: #1d1c1a; --ink2: #6f6d66; --ink3: #9a978e;
    --line: rgba(29,28,26,.09); --fill: rgba(29,28,26,.045); --hover: rgba(29,28,26,.035);
    --accent: #c96442; --accent-soft: rgba(201,100,66,.12); --warn: #b7791f;
    --shadow: 0 1px 2px rgba(29,28,26,.04), 0 6px 24px rgba(29,28,26,.05);
  }
  .sp {
    position: fixed; inset: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain;
    background: var(--bg); color: var(--ink);
    font-family: var(--sans, system-ui), "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 14px;
    -webkit-font-smoothing: antialiased;
  }
  @media (prefers-color-scheme: dark) {
    .sp, .ctx {
      --bg: #1a1a19; --card: #242423; --ink: #f3f2ed; --ink2: #a9a79f; --ink3: #7c7a73;
      --line: rgba(255,255,255,.08); --fill: rgba(255,255,255,.05); --hover: rgba(255,255,255,.04);
      --accent: #d97757; --accent-soft: rgba(217,119,87,.16); --warn: #e0a84a;
      --shadow: 0 1px 2px rgba(0,0,0,.3), 0 6px 24px rgba(0,0,0,.2);
    }
    :global(html.share-mode body) { background: #1a1a19; }
  }
  .col {
    max-width: 760px; margin: 0 auto;
    padding: calc(var(--sat, 0px) + 14px) 16px calc(var(--sab, 0px) + 96px);
  }
  button { font: inherit; color: inherit; background: none; border: none; cursor: pointer; }
  svg { display: block; }

  /* —— 品牌行 —— */
  .brand { display: flex; align-items: center; justify-content: space-between; height: 36px; margin-bottom: 18px; }
  .mark { font-family: var(--serif-stack, Georgia, serif); font-size: 12.5px; letter-spacing: .2em; text-transform: uppercase; color: var(--ink2); }
  .ro { display: inline-flex; align-items: center; gap: 5px; height: 26px; padding: 0 10px; border-radius: 13px; background: var(--fill); color: var(--ink2); font-size: 12px; }
  .ro svg { width: 14px; height: 14px; }

  /* —— 头部 —— */
  .hero { display: flex; align-items: center; gap: 14px; min-height: 60px; }
  .htile { flex: none; display: grid; place-items: center; width: 56px; height: 56px; border-radius: 16px; color: var(--k); background: var(--fill); background: color-mix(in srgb, var(--k) 13%, transparent); }
  .htile :global(svg) { width: 28px; height: 28px; }
  .htext { flex: 1; min-width: 0; }
  .hero h1 {
    font-family: var(--serif-stack, Georgia, serif); font-size: 22px; font-weight: 500; line-height: 1.3; letter-spacing: .005em;
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word;
  }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
  .chip { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px; border-radius: 12px; background: var(--fill); color: var(--ink2); font-size: 12px; white-space: nowrap; }
  .chip svg { width: 13px; height: 13px; }
  .chip.exp.soon { color: var(--warn); background: color-mix(in srgb, var(--warn) 12%, transparent); }

  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 44px; padding: 0 22px; border-radius: 12px; background: var(--accent); color: #fff; font-size: 15px; font-weight: 600; transition: filter .15s; }
  .btn svg { width: 18px; height: 18px; }
  .btn:hover { filter: brightness(1.06); }
  .btn:active { filter: brightness(.93); }

  /* —— 路径条 —— */
  .bar {
    position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 6px;
    height: 52px; margin: 18px -16px 0; padding: 0 16px;
    background: var(--bg); transition: box-shadow .2s;
  }
  .bar.stuck { box-shadow: 0 1px 0 var(--line); }
  .up { flex: none; display: grid; place-items: center; width: 32px; height: 32px; margin-left: -6px; border-radius: 10px; color: var(--ink); }
  .up svg { width: 20px; height: 20px; }
  .up:hover { background: var(--fill); }
  .crumbs { flex: 1; min-width: 0; display: flex; align-items: center; gap: 2px; overflow-x: auto; scrollbar-width: none; -webkit-mask-image: linear-gradient(90deg, #000 calc(100% - 20px), transparent); mask-image: linear-gradient(90deg, #000 calc(100% - 20px), transparent); }
  .crumbs::-webkit-scrollbar { display: none; }
  .crumb { flex: none; height: 30px; padding: 0 6px; border-radius: 8px; color: var(--ink2); font-size: 14px; white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
  .crumb:hover { background: var(--fill); color: var(--ink); }
  .crumb.cur { color: var(--ink); font-weight: 600; }
  .crumb.cur:last-child { padding-right: 20px; }
  .sep { flex: none; color: var(--ink3); font-size: 13px; }
  .seg { flex: none; display: flex; padding: 2px; border-radius: 10px; background: var(--fill); }
  .seg button { display: grid; place-items: center; width: 32px; height: 28px; border-radius: 8px; color: var(--ink3); transition: background .15s, color .15s; }
  .seg button svg { width: 17px; height: 17px; }
  .seg button.on { background: var(--card); color: var(--ink); box-shadow: 0 1px 2px rgba(0,0,0,.08); }

  .card { background: var(--card); border-radius: 16px; box-shadow: var(--shadow); }
  .dim { opacity: .55; transition: opacity .15s; }

  /* —— 列表 —— */
  .list { margin-top: 4px; overflow: hidden; }
  .row { position: relative; display: flex; align-items: center; }
  .row + .row::before { content: ''; position: absolute; top: 0; left: 70px; right: 0; height: 1px; background: var(--line); transform: scaleY(.5); transform-origin: top; }
  .row:not(.skrow):hover { background: var(--hover); }
  .hit { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; min-height: 64px; padding: 10px 6px 10px 14px; text-align: left; }
  .tile { position: relative; flex: none; display: grid; place-items: center; width: 44px; height: 44px; border-radius: 11px; overflow: hidden; color: var(--k); background: var(--fill); background: color-mix(in srgb, var(--k) 12%, transparent); }
  .tile :global(svg) { width: 23px; height: 23px; }
  .tile img, .cthumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .2s; }
  .tile img:global(.ok), .cthumb img:global(.ok) { opacity: 1; }
  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .name { display: flex; min-width: 0; font-size: 15px; line-height: 1.35; color: var(--ink); }
  .stem { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ext { flex: none; white-space: nowrap; }
  .meta { font-size: 12.5px; line-height: 1.3; color: var(--ink3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dl, .chev { flex: none; display: grid; place-items: center; width: 40px; height: 40px; margin-right: 8px; border-radius: 50%; color: var(--ink2); }
  .dl svg { width: 19px; height: 19px; }
  .dl:hover { background: var(--fill); color: var(--accent); }
  .chev { color: var(--ink3); pointer-events: none; }
  .chev svg { width: 18px; height: 18px; }
  .play { position: absolute; display: grid; place-items: center; width: 34px; height: 34px; border-radius: 50%; background: rgba(0,0,0,.42); }
  .play svg { width: 16px; height: 16px; fill: #fff; margin-left: 2px; }
  .play.sm { width: 20px; height: 20px; }
  .play.sm svg { width: 10px; height: 10px; margin-left: 1px; }

  /* —— 网格 —— */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: 14px 10px; margin-top: 6px; }
  @media (min-width: 600px) { .grid { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 18px 14px; } }
  .cell { display: flex; flex-direction: column; align-items: stretch; min-width: 0; text-align: center; border-radius: 14px; }
  .cthumb { position: relative; display: grid; place-items: center; aspect-ratio: 1; border-radius: 14px; overflow: hidden; color: var(--k); background: var(--card); background: color-mix(in srgb, var(--k) 11%, var(--card)); box-shadow: var(--shadow); transition: transform .15s; }
  .cell:hover .cthumb { transform: translateY(-1px); }
  .cell:active .cthumb { transform: scale(.98); }
  .cglyph :global(svg) { width: 34px; height: 34px; }
  .cname { margin-top: 8px; padding: 0 2px; font-size: 13px; line-height: 1.35; color: var(--ink); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-all; }
  .cmeta { margin-top: 2px; font-size: 11.5px; color: var(--ink3); }

  /* —— 空态 / 失效 / 错误 —— */
  .empty { display: flex; flex-direction: column; align-items: center; gap: 12px; margin-top: 4px; padding: 48px 20px; color: var(--ink2); font-size: 14px; }
  .state { max-width: 380px; margin: 12vh auto 0; padding: 36px 24px 28px; text-align: center; }
  .state h1 { font-size: 19px; font-weight: 600; }
  .state p { margin-top: 8px; font-size: 14px; line-height: 1.65; color: var(--ink2); }
  .state .btn { margin-top: 20px; }
  .badge { display: grid; place-items: center; width: 56px; height: 56px; margin: 0 auto 18px; border-radius: 16px; background: var(--accent-soft); color: var(--accent); }
  .badge.muted { background: var(--fill); color: var(--ink2); }
  .empty .badge { margin: 0; }
  .badge :global(svg) { width: 26px; height: 26px; }

  .foot { margin-top: 22px; text-align: center; font-size: 12px; line-height: 1.6; color: var(--ink3); }

  /* —— 骨架屏 —— */
  .sk { background: var(--fill); border-radius: 6px; animation: skp 1.2s ease-in-out infinite alternate; }
  .htile.sk { border-radius: 16px; }
  .sk-t { width: 60%; height: 22px; }
  .sk-m { width: 40%; height: 16px; margin-top: 10px; }
  .skrow .main { gap: 8px; padding: 10px 0; }
  .skrow .tile { margin: 10px 12px 10px 14px; }
  .sk-n { display: block; width: 55%; height: 14px; }
  .sk-s { display: block; width: 30%; height: 11px; }
  @keyframes skp { from { opacity: 1; } to { opacity: .45; } }

  /* —— 右键 / 长按菜单 —— */
  .row, .cell { -webkit-touch-callout: none; }
  .row.ctx-on { background: var(--hover); }
  .cell.ctx-on .cthumb { box-shadow: 0 0 0 2px var(--accent); }
  .ctx-mask { position: fixed; inset: 0; z-index: 70; }
  .ctx {
    position: fixed; z-index: 71; padding: 6px; border-radius: 14px;
    background: var(--card); color: var(--ink); box-shadow: 0 0 0 1px var(--line), 0 12px 36px rgba(0,0,0,.18);
    font-family: var(--sans, system-ui), "PingFang SC", "Microsoft YaHei", sans-serif; font-size: 14px;
    animation: ctxin .14s cubic-bezier(.2,0,0,1); transform-origin: top left;
  }
  .ctx-name { padding: 6px 10px 8px; margin-bottom: 4px; border-bottom: 1px solid var(--line); font-size: 12px; color: var(--ink3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ctx button { display: flex; align-items: center; gap: 10px; width: 100%; height: 40px; padding: 0 10px; border: none; border-radius: 9px; background: none; color: inherit; font: inherit; text-align: left; cursor: pointer; }
  .ctx button:hover { background: var(--fill); }
  .ctx button svg { display: block; width: 18px; height: 18px; color: var(--ink2); }
  .ctx-sz { margin-left: auto; font-size: 12px; color: var(--ink3); }
  @keyframes ctxin { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: none; } }

  /* —— 下载条 —— */
  .dock {
    position: fixed; left: 50%; bottom: calc(var(--sab, 0px) + 16px); z-index: 60; transform: translateX(-50%);
    display: flex; flex-direction: column; align-items: center; gap: 8px;
    width: min(420px, calc(100vw - 32px)); pointer-events: none;
    font-family: var(--sans, system-ui), "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  .toast, .task { pointer-events: auto; background: rgba(32,32,30,.94); color: #f3f2ed; box-shadow: 0 8px 28px rgba(0,0,0,.22); animation: rise .22s cubic-bezier(.2,0,0,1); }
  .toast { padding: 9px 16px; border-radius: 18px; font-size: 13px; }
  .task { position: relative; display: flex; align-items: center; gap: 10px; width: 100%; height: 48px; padding: 0 8px 0 16px; border-radius: 14px; overflow: hidden; font-size: 13.5px; }
  .tname { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tstat { flex: none; font-variant-numeric: tabular-nums; color: rgba(243,242,237,.7); }
  .task.done .tstat { color: #8fd19e; }
  .tx, .tok { flex: none; display: grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; }
  .tx { background: rgba(255,255,255,.12); color: #f3f2ed; }
  .tx svg { width: 12px; height: 12px; }
  .tok { color: #8fd19e; }
  .tok svg { width: 17px; height: 17px; }
  .tbar { position: absolute; left: 0; bottom: 0; height: 3px; background: #d97757; transition: width .2s linear; }
  .task.done .tbar { background: #5aa468; }
  .task.cancel { opacity: .7; }
  @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

  /* —— 宽屏：更舒展的头部 —— */
  @media (min-width: 720px) {
    .col { padding-top: calc(var(--sat, 0px) + 28px); }
    .brand { margin-bottom: 30px; }
    .hero { gap: 18px; }
    .htile { width: 64px; height: 64px; border-radius: 18px; }
    .htile :global(svg) { width: 32px; height: 32px; }
    .hero h1 { font-size: 26px; }
    .bar { margin-top: 24px; }
  }
  @media (hover: none) { .row:not(.skrow):hover, .crumb:hover, .up:hover, .dl:hover { background: none; } .dl:hover { color: var(--ink2); } }
  @media (prefers-reduced-motion: reduce) { .sk, .toast, .task, .ctx { animation: none; } .cthumb, .tile img, .cthumb img { transition: none; } }
</style>
