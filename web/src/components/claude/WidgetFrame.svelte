<script module>
  // 每张图表最后的高度（按 tool_use id）：重开会话 / 对账重建时先按它占位，iframe 起来后不跳。
  const HKEY = 'bridge-widget-h';
  const heights = new Map();
  try { for (const [k, v] of JSON.parse(localStorage.getItem(HKEY) || '[]')) heights.set(k, v); } catch {}
  let saveT = 0;
  function rememberH(id, h) {
    if (!id || !(h > 0) || heights.get(id) === h) return;
    heights.delete(id); heights.set(id, h);
    while (heights.size > 200) heights.delete(heights.keys().next().value);
    clearTimeout(saveT);
    saveT = setTimeout(() => { try { localStorage.setItem(HKEY, JSON.stringify([...heights])); } catch {} }, 800);
  }
</script>

<script>
  // 对话内嵌交互图表（官方 visualize 的 show_widget）。段模型见 lib/widgetSeg.js，服务端见 src/mcp/visualize.mjs。
  //
  // 两种渲染：
  //  · 网页 / 桌面壳：srcdoc iframe，sandbox 只给 allow-scripts——不透明源，碰不到 bridge 的 cookie / localStorage / 同源 /api；
  //    壳里 CSP 只放官方同款 CDN 白名单（lib/widgetShell.js）。流式期间壳剥掉脚本做增量渲染，定稿（ready）才执行脚本。
  //    桌面壳（Electron）主窗 contextIsolation + sandbox、没开 nodeIntegrationInSubFrames，preload 的 BridgeDesktop
  //    只进主帧，子帧拿不到——按网页处理。
  //  · 手机 apk：MainActivity 用 addJavascriptInterface 注入的 AndroidStore（存 token）/ BridgeDownload / BridgeUpload /
  //    BridgeShot 进【所有帧】、不分源，图表脚本能直接调到——所以一律不跑脚本：DOMPurify 剥成静态 SVG/HTML 渲染进
  //    shadow root（高度自然撑开、变量从宿主继承，主题切换自动跟），卡角标「手机上为静态预览」。shadow 里模型写的样式
  //    （含 :host、!important）改得到宿主自己，所以宿主外面再包一层 .wf-clip 做隔离边界（contain + 裁剪，见样式）。
  //  · 分享页 / 聊天快照（IS_SHARE / IS_CSNAP）：对齐官方「分享时不显示交互图表」，只给占位 + 查看代码，不跑任何东西。
  //
  // sendPrompt：壳把 {type:'prompt'} 发上来，父页再核一遍——必须是 iframe 里真实的用户点击（用户激活会传到祖先帧，
  // 且焦点在这个 iframe 上），1.5s 内只认一次；然后当作用户消息发出（Claude 在跑时进「稍后发送」队列）。
  // 没有用户点击的（定时器里调、或激活判定在个别内核上不灵）不直接发，卡下出一条「图表想替你发送」由用户点了再发。
  // 发不出去（离线、排队失败）卡下出「未发送：…」（官方 notSent）。
  import { onMount } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import { session, ui } from '../../lib/state.svelte.js';
  import { send, queueSend } from '../../lib/chat.svelte.js';
  import { IS_SHARE } from '../../lib/share.js';
  import { IS_CSNAP } from '../../lib/csnap.js';
  import { buildSrcdoc, themeVars, currentMode, bridgeVarRefs, styleText, widgetCss, ARROW_DEFS, sanitizeStatic, stripScripts, visibleMarkup, isSvgCode, standaloneFile, fileStem } from '../../lib/widgetShell.js';
  import ClaudeLogo from '../ClaudeLogo.svelte';

  const { seg, live = false } = $props();

  // Android 壳：注入了原生桥（AndroidStore 在就是 apk）——图表按静态预览出
  const STATIC = typeof window !== 'undefined' && !!window.AndroidStore;
  const HIDDEN = IS_SHARE || IS_CSNAP;
  const MAX_H = 1800;          // 再高就在框里滚（官方同样有上限）
  const PARTIAL_MS = 120;      // 流式代码推给 iframe 的节流
  const BLANK_MS = 20_000;     // 定稿后这么久还什么都没画出来（脚本卡在 CDN 上）→ 按没画出来收尾
  const UNLOAD_MS = 30_000;    // iframe 离视口很远待满这么久就卸掉

  let root = $state(null);
  let frameEl = $state(null);
  let hostEl = $state(null);
  let moreEl = $state(null);
  let mounted = $state(false);    // 懒挂：进视口附近才起 iframe（长对话别一次起几十个）；离屏久了再卸掉
  let ready = $state(false);      // 壳脚本已就绪
  // svelte-ignore state_referenced_locally
  let h = $state(heights.get(seg.id) || 0);   // 初值取一次就够：同一张卡的 id 不会变
  let shown = $state(false);      // 已经有看得见的内容
  let blank = $state(false);      // 定稿了却什么也没画出来（内容全靠脚本、脚本没跑起来 / 报错；手机上要脚本才有内容）
  let scriptErr = $state('');
  let animH = $state(false);      // 第一次量到高度之后才开高度过渡（回放占位别从 0 长出来）
  let codeOpen = $state(false);
  let menuOpen = $state(false);
  let copied = $state(false);
  let note = $state('');          // 卡下操作的一过性结果（已复制 / 已下载 / 失败）
  let ldIdx = $state(0);

  const final = $derived(seg.status === 'ready');
  const failed = $derived(seg.status === 'error');
  // 本轮已经结束，代码却没等到定稿（停止 / 断流）：按半成品静态显示
  const cut = $derived(!live && !final && !failed);
  const title = $derived(String(seg.title || '').replace(/_/g, ' ').trim());
  const loadingMsgs = $derived(Array.isArray(seg.loading) && seg.loading.length ? seg.loading : [t('正在画图表…')]);
  const ldText = $derived(loadingMsgs[ldIdx % loadingMsgs.length]);
  const busyDrawing = $derived(!final && !failed && !cut);
  // 回放（已定稿、记得上次高度）：iframe 先按旧高度占位，不显示加载行，画出来时不跳
  const reserved = $derived(final && !shown && h > 0);
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  let srcdoc = '';

  // 懒挂：进视口附近（上下 800px）才挂。离屏卸载（只 iframe 模式）：离视口上下 2400px 之外待满 30s 就卸掉，留旧高度
  // 占位（标题行照旧），回到附近再挂（脚本重跑、控件状态不保留）——每个 iframe 一个渲染上下文，长对话里几十个吃不消。
  onMount(() => {
    if (HIDDEN) return;
    if (live || !('IntersectionObserver' in window)) mounted = true;
    if (!('IntersectionObserver' in window) || !root) return;
    const near = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting) || hijacked) return;
      mounted = true;
      if (STATIC) near.disconnect();   // 静态预览不卸载，挂上就不用再看
    }, { rootMargin: '800px 0px' });
    near.observe(root);
    let far = null, ut = 0;
    if (!STATIC) {
      far = new IntersectionObserver((es) => {
        clearTimeout(ut);
        if (!es.some((e) => e.isIntersecting)) ut = setTimeout(unload, UNLOAD_MS);
      }, { rootMargin: '2400px 0px' });
      far.observe(root);
    }
    return () => { near.disconnect(); if (far) far.disconnect(); clearTimeout(ut); };
  });
  function unload() {
    // 还在画、用户在看代码 / 等确认 / 开着菜单时不卸；没量到高度（占位会塌）也不卸
    if (!mounted || live || busyDrawing || codeOpen || askText || menuOpen || !shown || !(h > 0)) return;
    mounted = false; ready = false; sentCode = null; sentFinal = false; loads = 0;
    for (const w of snapWait.values()) w.rej(new Error('unloaded'));
    snapWait.clear();
  }

  // 加载语轮播（官方 claude.ai：参数里已写完的 loading_messages 轮流显示）
  $effect(() => {
    if (!busyDrawing || loadingMsgs.length < 2) return;
    const id = setInterval(() => { ldIdx += 1; }, 2600);
    return () => clearInterval(id);
  });

  // —— 跟随底部 ——
  // 卡片变高前对话正停在底部（与 ClaudePage onScroll 同一判据：差 120px 以内）→ 变高后补滚到底，高度过渡期间逐帧跟。
  // 页面自己的跟随 effect 只追正文长度，看不到图表在长（ClaudePage / SnapPage / SoloPage 的滚动容器都是 .scroll）。
  let followUntil = 0, followRaf = 0, followAt = -1;
  function scrollBox() {
    const box = root && root.closest('.scroll');
    if (box) return box;
    for (let el = root && root.parentElement; el && el !== document.body; el = el.parentElement) {
      const o = getComputedStyle(el).overflowY;
      if ((o === 'auto' || o === 'scroll') && el.scrollHeight > el.clientHeight) return el;
    }
    return null;
  }
  function followIfAtBottom() {
    const el = scrollBox();
    if (!el || el.scrollTop + el.clientHeight < el.scrollHeight - 120) return;
    followUntil = performance.now() + 450;
    if (followRaf) return;
    followAt = -1;
    const step = () => {
      if (followAt >= 0 && el.scrollTop < followAt - 2) { followRaf = 0; return; }   // 用户往上滚了：不再跟
      el.scrollTop = el.scrollHeight;
      followAt = el.scrollTop;
      followRaf = performance.now() < followUntil ? requestAnimationFrame(step) : 0;
    };
    followRaf = requestAnimationFrame(step);
  }
  onMount(() => () => cancelAnimationFrame(followRaf));

  // —— iframe 模式 ——
  function post(msg) {
    if (hijacked) return;
    try { frameEl?.contentWindow?.postMessage({ bw: 'w1', ...msg }, '*'); } catch {}
  }
  let sentCode = null, sentFinal = false, pushT = 0;
  function pushCode() {
    pushT = 0;
    if (!ready) return;
    const code = seg.code || '';
    const fin = final || cut;   // 断流的半成品也定稿（脚本剥掉，见下）
    if (fin && sentFinal && sentCode === code) return;
    if (!fin && sentCode === code) return;
    sentCode = code; sentFinal = fin;
    post({ type: 'code', code: cut ? stripScripts(code) : code, final: fin });
  }
  $effect(() => {
    if (STATIC || !ready) return;
    void seg.code; void final; void cut;
    if (final || cut) { clearTimeout(pushT); pushCode(); return; }
    if (!pushT) pushT = setTimeout(pushCode, PARTIAL_MS);
  });
  $effect(() => () => clearTimeout(pushT));

  // 定稿后迟迟没有看得见的内容：壳跑完脚本会报 done（那时 h 仍为 0 就是没画出来）；脚本卡在加载上连 done 都没有时，
  // 到点兜底。之后真画出来了（CDN 终于通了）size 会把它拉回来。
  $effect(() => {
    if (STATIC || HIDDEN || !final || !mounted || shown || blank) return;
    const id = setTimeout(() => { if (!shown) blank = true; }, BLANK_MS);
    return () => clearTimeout(id);
  });

  // 主题：父页 html[data-theme] 一变就把新变量推进去（iframe 读不到父页的 CSS 变量）
  let mode = $state(currentMode());
  onMount(() => {
    const mo = new MutationObserver(() => { mode = currentMode(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => mo.disconnect();
  });
  // 定稿时记一笔高度：壳只在高度变了才上报，定稿那一刻和流式最后一帧同高时收不到新的 size
  $effect(() => { if (!STATIC && final && shown && h > 0) rememberH(seg.id, h); });

  // 变量值按卡片自己所在处取（局部覆盖过 --bg/--card 的容器里也对得上）
  $effect(() => { if (!STATIC && ready) post({ type: 'theme', mode, vars: themeVars(mode, root) }); });

  // 握手兜底：壳加载完（load 事件）还没收到它的 ready，就 ping 一下让它再报一次（ready 丢了不至于一直空着）
  // 壳页每次挂上只会 load 一次（srcdoc 不变，主题 / 代码都走 postMessage）。同一个 iframe 再 load = 图表脚本把这一帧导航走了
  //（location.href = 外部地址；sandbox 只给 allow-scripts，CSP 管不到 navigate）——里面已是别人的页面：立刻卸掉、标成已拦截，
  // 之后不再往里投任何消息（主题、截图请求），也不再挂回来。
  let loads = 0;
  let hijacked = $state(false);
  function onFrameLoad() {
    loads += 1;
    if (loads > 1) {
      hijacked = true; ready = false; mounted = false;
      for (const w of snapWait.values()) w.rej(new Error('hijacked'));
      snapWait.clear();
      return;
    }
    if (!ready) post({ type: 'ping' });
  }

  function frameDoc() {
    if (!srcdoc) srcdoc = buildSrcdoc({ nonce, mode: currentMode(), vars: themeVars(currentMode(), root), maxH: MAX_H });
    return srcdoc;
  }

  let lastPromptAt = 0;
  let askText = $state('');      // 没有用户点击的 sendPrompt：等用户在卡下确认
  let notSent = $state('');      // 发不出去的 sendPrompt（官方「未发送：」）
  function userClickedFrame() {
    // 用户激活会从被点的 iframe 传到祖先帧；焦点也落在这个 iframe 上——两样都要（防定时器里偷发）
    const act = navigator.userActivation ? navigator.userActivation.isActive : true;
    return act && document.activeElement === frameEl;
  }
  async function deliver(s) {
    notSent = '';
    if (HIDDEN) return;
    if (ui.offline) { notSent = s; return; }   // 离线只读：不发
    // Claude 在跑：进「稍后发送」队列，排不上就提示；没在跑：当作用户消息直接发
    if (session.busy) { if (!(await queueSend(s, []))) notSent = s; }
    else send(s, []);
  }
  function onPrompt(text) {
    if (HIDDEN) return;
    const s = String(text || '').trim().slice(0, 4000);
    if (!s) return;
    if (!userClickedFrame()) { askText = s; return; }
    const now = Date.now();
    if (now - lastPromptAt < 1500) return;
    lastPromptAt = now;
    askText = '';
    deliver(s);
  }
  function confirmAsk() { const s = askText; askText = ''; if (s) deliver(s); }
  function openExternal(url) {
    if (!/^https?:\/\//i.test(url) || !userClickedFrame()) return;
    window.open(url, '_blank', 'noopener,noreferrer');
  }
  async function saveDataUrl(url, name) {
    if (!/^data:/i.test(url) || !userClickedFrame()) return;
    try {
      const blob = await (await fetch(url)).blob();
      saveBlob(blob, String(name || 'download').replace(/[\\/:*?"<>|]+/g, '_'));
    } catch {}
  }

  // —— 截图（复制为图片 / 下载为 PNG）：壳把 #vis 画成 PNG data URL 回给父页 ——
  let snapSeq = 0;
  const snapWait = new Map();
  function dataUrlBlob(u) {
    const m = /^data:(image\/png);base64,([A-Za-z0-9+/=]+)$/.exec(String(u || ''));
    if (!m) return null;
    const bin = atob(m[2]);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return new Blob([a], { type: m[1] });
  }
  function requestPng() {
    return new Promise((res, rej) => {
      if (!ready || !frameEl) { rej(new Error('not ready')); return; }
      const req = ++snapSeq;
      const timer = setTimeout(() => { snapWait.delete(req); rej(new Error('timeout')); }, 15_000);
      snapWait.set(req, { res: (b) => { clearTimeout(timer); res(b); }, rej: (e) => { clearTimeout(timer); rej(e); } });
      post({ type: 'snap', req });
    });
  }
  let noteT = 0;
  function flash(s) { note = s; clearTimeout(noteT); noteT = setTimeout(() => (note = ''), 1800); }
  onMount(() => () => clearTimeout(noteT));
  function copyImage() {
    menuOpen = false;
    try {
      // ClipboardItem 收 Promise：点击的用户激活当场用掉，PNG 晚点到也能写进剪贴板
      const p = requestPng();
      p.catch(() => {});
      navigator.clipboard.write([new ClipboardItem({ 'image/png': p })]).then(() => flash(t('已复制')), () => flash(t('无法复制图片，请重试。')));
    } catch { flash(t('无法复制图片，请重试。')); }
  }
  function downloadPng() {
    menuOpen = false;
    requestPng().then((b) => { saveBlob(b, fileStem(seg.title) + '.png'); flash(t('已下载')); }, () => flash(t('无法下载图片，请重试。')));
  }

  function onMessage(e) {
    if (!frameEl || e.source !== frameEl.contentWindow) return;
    const d = e.data;
    if (!d || d.bw !== 'w1' || d.n !== nonce) return;
    switch (d.type) {
      case 'ready': ready = true; sentCode = null; sentFinal = false; post({ type: 'theme', mode, vars: themeVars(mode, root) }); pushCode(); break;
      case 'size': {
        const nh = Math.max(0, Math.min(MAX_H, Math.ceil(Number(d.h) || 0)));
        // 流式期间只长不缩（逐段渲染时高度来回抖）；定稿后按实际
        const next = busyDrawing ? Math.max(h, nh) : nh;
        if (next > h || (nh > 0 && !shown)) followIfAtBottom();   // 先量「是不是停在底部」，再变高
        if (nh > 0) { shown = true; blank = false; }
        if (next !== h) { if (h > 0 || shown) animH = true; h = next; }
        if (final && nh > 0) rememberH(seg.id, nh);
        break;
      }
      case 'done': if (final && !(h > 0)) blank = true; break;   // 脚本都跑完了还是 0 高：没画出来
      case 'prompt': onPrompt(d.text); break;
      case 'link': openExternal(String(d.url || '')); break;
      case 'download': saveDataUrl(String(d.url || ''), d.name); break;
      case 'snap': {
        const w = snapWait.get(d.req);
        if (!w) break;
        snapWait.delete(d.req);
        const b = dataUrlBlob(d.url);
        if (b) w.res(b); else w.rej(new Error(String(d.err || 'snap failed')));
        break;
      }
      case 'error': scriptErr = String(d.msg || '').slice(0, 300); console.warn('[widget]', seg.title || seg.id, scriptErr); break;
    }
  }
  onMount(() => {
    if (STATIC || HIDDEN) return;
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  });

  // 更多操作菜单：点外面 / Esc / 窗口失焦（点进了某个 iframe）就收
  $effect(() => {
    if (!menuOpen) return;
    const close = (e) => { if (!moreEl || !moreEl.contains(e.target)) menuOpen = false; };
    const esc = (e) => { if (e.key === 'Escape') menuOpen = false; };
    const blur = () => { menuOpen = false; };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', esc);
    window.addEventListener('blur', blur);
    return () => { document.removeEventListener('pointerdown', close, true); document.removeEventListener('keydown', esc); window.removeEventListener('blur', blur); };
  });

  // —— 手机静态模式：shadow root ——
  let shadowVis = null, shadowRoot = null, staticT = 0, staticLast = null;
  function renderStatic() {
    staticT = 0;
    if (!shadowVis) return;
    const code = seg.code || '';
    const key = (final ? 'F' : 'P') + code;   // 定稿那次哪怕代码没变也要再判一次（没东西可画 → blank）
    if (key === staticLast) return;
    staticLast = key;
    const clean = sanitizeStatic(code);
    if (!visibleMarkup(clean)) { if (final) blank = true; return; }   // 全靠脚本出内容的图：手机上看不了
    followIfAtBottom();
    shadowVis.innerHTML = clean;
    shown = true; blank = false;
  }
  $effect(() => {
    if (!STATIC || !mounted || !hostEl) return;
    if (!shadowRoot) {
      shadowRoot = hostEl.attachShadow({ mode: 'open' });
      shadowRoot.innerHTML = '<style>:host{display:block}' + widgetCss({ root: '.wroot', dark: '.wroot[data-mode="dark"]', body: '.wroot' })
        + '.wroot{position:relative;contain:layout paint;overflow:hidden}'
        // 静态预览里控件点了没反应：别让它们看着能点
        + '.wroot button,.wroot input,.wroot select,.wroot textarea,.wroot .node{pointer-events:none}.wroot button{opacity:.6}'
        + '</style><div class="wroot">' + ARROW_DEFS + '<div class="vis streaming"></div></div>';
      const w = shadowRoot.querySelector('.wroot');
      w.setAttribute('style', styleText(bridgeVarRefs()));
      shadowVis = shadowRoot.querySelector('.vis');
    }
    shadowRoot.querySelector('.wroot').setAttribute('data-mode', mode);
    void seg.code;
    if (final || cut) { clearTimeout(staticT); shadowVis.classList.remove('streaming'); renderStatic(); return; }
    if (!staticT) staticT = setTimeout(renderStatic, 200);
  });
  $effect(() => () => clearTimeout(staticT));

  // —— 卡下的操作：下载 / 看代码 ——
  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  }
  function download() {
    menuOpen = false;
    const f = standaloneFile(seg.code || '', seg.title);
    saveBlob(new Blob([f.text], { type: f.mime + ';charset=utf-8' }), f.name);
  }
  async function copyCode() {
    try { await navigator.clipboard.writeText(seg.code || ''); copied = true; setTimeout(() => (copied = false), 1500); } catch {}
  }
  const kindLabel = $derived(isSvgCode(seg.code) ? 'SVG' : 'HTML');
</script>

<figure class="wf" bind:this={root} class:shown aria-busy={busyDrawing}>
  {#if HIDDEN}
    <div class="wf-hid sel-text">
      <span>{t('分享时不显示交互图表')}</span>
      {#if seg.code}<button class="wf-link" onclick={() => (codeOpen = !codeOpen)}>{codeOpen ? t('收起代码') : t('查看代码')}</button>{/if}
    </div>
  {:else if failed}
    <div class="wf-err sel-text">
      <span>{t('图表没有画出来')}</span>
      {#if seg.code}<button class="wf-link" onclick={() => (codeOpen = !codeOpen)}>{codeOpen ? t('收起代码') : t('查看代码')}</button>{/if}
    </div>
  {:else}
    {#if !shown && !reserved}
      {#if blank}
        <div class="wf-err sel-text" class:quiet={STATIC} title={scriptErr || null}>
          <span>{STATIC ? t('这张图表要在电脑上查看') : t('图表没有画出来')}</span>
          {#if seg.code}<button class="wf-link" onclick={() => (codeOpen = !codeOpen)}>{codeOpen ? t('收起代码') : t('查看代码')}</button>{/if}
        </div>
      {:else}
        <div class="wf-load" role="status">
          {#if busyDrawing}<ClaudeLogo anim="shimmer" size={18} /><span class="cl-shine">{ldText}</span>
          {:else if cut}<span>{t('图表没有画完')}</span>
          {:else}<ClaudeLogo anim="shimmer" size={18} /><span class="cl-shine">{t('正在画图表…')}</span>{/if}
        </div>
      {/if}
    {/if}
    {#if hijacked}
      <div class="wf-blocked" role="status">{t('图表试图跳转到别的网页，已拦截')}</div>
    {:else if mounted}
      {#if STATIC}
        <!-- .wf-clip 是样式隔离边界：shadow 里的 :host / !important 够得着宿主（.wf-static），够不着这一层 -->
        <div class="wf-clip" class:hidden={!shown && !reserved} style:min-height={reserved ? h + 'px' : null}>
          <div class="wf-static" bind:this={hostEl}></div>
        </div>
      {:else}
        <iframe
          bind:this={frameEl}
          class="wf-frame"
          class:anim={animH}
          title={title || t('图表')}
          sandbox="allow-scripts"
          allow="clipboard-write"
          referrerpolicy="no-referrer"
          srcdoc={frameDoc()}
          onload={onFrameLoad}
          style:height={(shown || reserved ? h : 0) + 'px'}
          style:color-scheme={mode}
        ></iframe>
      {/if}
    {:else if h > 0}
      <div class="wf-ph" style:height={h + 'px'}></div>
    {/if}
    {#if shown}
      <figcaption class="wf-cap">
        {#if busyDrawing}<span class="wf-ttl cl-shine">{ldText}</span>
        {:else}<span class="wf-ttl" title={seg.title}>{title || t('图表')}</span>{#if cut}<span class="wf-note">{t('图表没有画完')}</span>{/if}{/if}
        {#if STATIC}<span class="wf-note">{t('手机上为静态预览')}</span>{/if}
        {#if !busyDrawing && seg.code}
          <span class="wf-acts">
            {#if note}<span class="wf-flash" role="status">{note}</span>{/if}
            {#if !STATIC}
              <span class="wf-more" bind:this={moreEl}>
                <button class="wf-act" class:on={menuOpen} aria-label={t('更多操作')} title={t('更多操作')} aria-haspopup="menu" aria-expanded={menuOpen} onclick={() => (menuOpen = !menuOpen)}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="1.1" /><circle cx="12" cy="12" r="1.1" /><circle cx="18" cy="12" r="1.1" /></svg>
                </button>
                {#if menuOpen}
                  <span class="wf-menu" role="menu">
                    <button role="menuitem" disabled={!ready} onclick={copyImage}>{t('复制为图片')}</button>
                    <button role="menuitem" disabled={!ready} onclick={downloadPng}>{t('下载为 PNG')}</button>
                    <button role="menuitem" onclick={download}>{t('下载为 {kind}', { kind: kindLabel })}</button>
                  </span>
                {/if}
              </span>
            {/if}
            <button class="wf-act" class:on={codeOpen} aria-label={codeOpen ? t('收起代码') : t('查看代码')} title={codeOpen ? t('收起代码') : t('查看代码')} onclick={() => (codeOpen = !codeOpen)}>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8.5 7.5-4.5 4.5 4.5 4.5M15.5 7.5l4.5 4.5-4.5 4.5" /></svg>
            </button>
          </span>
        {/if}
      </figcaption>
    {/if}
  {/if}
  {#if askText}
    <div class="wf-ask" role="group" aria-label={t('图表想替你发送')}>
      <span class="wf-ask-t sel-text">{t('图表想替你发送：')}<q>{askText}</q></span>
      <button class="wf-ask-b primary" onclick={confirmAsk}>{t('发送')}</button>
      <button class="wf-ask-b" onclick={() => (askText = '')}>{t('忽略')}</button>
    </div>
  {/if}
  {#if notSent}
    <div class="wf-ask" role="status">
      <span class="wf-ask-t sel-text">{t('未发送：')}<q>{notSent}</q></span>
      <button class="wf-ask-b" onclick={() => (notSent = '')}>{t('关闭')}</button>
    </div>
  {/if}
  {#if codeOpen && seg.code}
    <div class="wf-code">
      <button class="wf-copy" onclick={copyCode}>{copied ? t('已复制') : t('复制')}</button>
      <pre class="sel-text">{seg.code}</pre>
    </div>
  {/if}
</figure>

<style>
  .wf { margin: 10px 0 14px; padding: 0; min-width: 0; }
  /* color-scheme 与帧内一致（style:color-scheme={mode}）：两边不一致时浏览器给 iframe 垫一层不透明底色（暗色下一块黑板） */
  .wf-frame { display: block; width: 100%; border: 0; background: transparent; }
  .wf-frame.anim { transition: height var(--mo-base, .28s) var(--ea-std, ease); }
  /* 静态预览的隔离边界：contain:layout paint 让它成为 fixed 元素的包含块、按自身裁剪绘制与命中，isolation 不让
     z-index 越出卡片——模型样式把宿主改成 position:fixed / 去掉裁剪，也只能在这一格里折腾 */
  .wf-clip { position: relative; contain: layout paint; isolation: isolate; overflow: auto; max-height: 1800px; }
  .wf-clip.hidden { display: none; }
  .wf-static { display: block; }
  .wf-load { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 14px; padding: 6px 0; }
  .wf-err { display: flex; align-items: center; gap: 10px; color: var(--err, #d98a6a); font-size: 14px; padding: 6px 0; }
  .wf-err.quiet, .wf-hid { color: var(--muted); }
  .wf-hid { display: flex; align-items: center; gap: 10px; font-size: 14px; padding: 6px 0; }
  .wf-cap { display: flex; align-items: center; gap: 6px; min-height: 26px; margin-top: 4px; font-size: 12px; color: var(--muted); }
  .wf-ttl { flex: 0 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wf-note { flex: none; color: var(--muted); }
  .wf-blocked { padding: 10px 12px; border-radius: 8px; background: var(--hover); color: var(--muted); font-size: 13px; line-height: 18px; }
  .wf-note::before { content: '·'; margin: 0 6px 0 2px; }
  .wf-acts { flex: none; display: inline-flex; align-items: center; margin-left: auto; }
  .wf-flash { margin-right: 6px; color: var(--muted); }
  .wf-act { flex: none; display: inline-grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: 7px; background: none; color: var(--muted); cursor: pointer; }
  .wf-act:hover, .wf-act.on { background: var(--hover); color: var(--text); }
  .wf-act svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .wf-act svg circle { fill: currentColor; stroke: none; }
  .wf-more { position: relative; display: inline-flex; }
  /* 往上开：卡片常在视口底部（流式时贴着输入框） */
  .wf-menu { position: absolute; right: 0; bottom: calc(100% + 4px); z-index: 20; min-width: 168px; padding: 4px; border-radius: 10px; background: var(--card); box-shadow: var(--card-shadow); display: flex; flex-direction: column; font-size: 13.5px; }
  .wf-menu button { text-align: left; padding: 7px 10px; border: 0; border-radius: 7px; background: none; color: var(--text); font: inherit; white-space: nowrap; cursor: pointer; }
  .wf-menu button:hover:not(:disabled) { background: var(--hover); }
  .wf-menu button:disabled { opacity: .45; cursor: default; }
  .wf-link { border: 0; background: none; padding: 0; color: var(--muted); font: inherit; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; }
  .wf-code { position: relative; margin-top: 6px; border: .5px solid var(--divider); border-radius: 10px; background: var(--card); }
  .wf-code pre { margin: 0; padding: 12px 14px; max-height: 360px; overflow: auto; font: 12px/1.55 ui-monospace, 'SF Mono', 'Cascadia Code', Menlo, Consolas, monospace; color: var(--serif); white-space: pre-wrap; word-break: break-all; }
  .wf-copy { position: absolute; top: 6px; right: 8px; border: .5px solid var(--divider); border-radius: 6px; background: var(--bg); color: var(--muted); font-size: 12px; padding: 2px 8px; cursor: pointer; }
  .wf-copy:hover { color: var(--text); }
  .wf-ph { width: 100%; }
  .wf-ask { display: flex; align-items: center; gap: 8px; margin-top: 6px; padding: 8px 10px; border: .5px solid var(--divider); border-radius: 10px; font-size: 13px; color: var(--serif); }
  .wf-ask-t { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wf-ask-t q { color: var(--text); }
  .wf-ask-b { flex: none; border: .5px solid var(--divider); border-radius: 7px; background: none; color: var(--text); font-size: 13px; padding: 3px 10px; cursor: pointer; }
  .wf-ask-b.primary { background: var(--text); color: var(--bg); border-color: transparent; }
  .wf-ask-b:hover { background: var(--hover); }
  .wf-ask-b.primary:hover { background: var(--text); opacity: .88; }
</style>
