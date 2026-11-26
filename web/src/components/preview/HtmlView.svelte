<script>
  // HTML 直接渲染查看器。
  //
  // 加载：优先走服务端「站点挂载」（item.siteUrl → { url:'/api/hv/<id>/<入口>' }，见
  // src/runtime/html-site.mjs）——路径式 URL，页面里相对引用的 app.js / css / assets 全能解析，
  // 和电脑上双击打开一个样。此前一律 srcdoc：基址是 about:srcdoc，带资源目录的课件/网站
  // 相对引用全落空，黑屏转圈。挂载不可用（手机本地 SAF、dimensio 产物、桌面壳额外位置、
  // 老服务端）时回落 srcdoc，自包含单文件照样能开。
  //
  // 隔离：两条路都是 sandbox 且不给 allow-same-origin ⇒ 脚本跑在不透明源，碰不到 bridge 的
  // cookie / 接口；挂载响应头还带同款 CSP sandbox（顶层直开也一样隔离）。不透明源里
  // localStorage 一碰就抛错，服务端注入了内存垫片；srcdoc 这条在这里补同一段。
  //
  // 外观：顶栏交给外框（主工具 = 刷新 / 全屏 / 在浏览器中打开，下载在 ⋮ 通用项里），错误态用 kit ViewerState；
  // 颜色读 doctheme 的 --md-*（.hv 已在作用域里），和 md / PDF 来回切不跳色。加载用舞台顶边的细进度线，
  // 页面就绪前舞台留主题底色，不闪白。
  //
  // 焦点与 Esc：沙箱页拿到焦点后，键盘事件都落在 iframe 文档里、冒不到外框——Esc 关不掉查看器。
  // 解法：页里注入一段 Esc 中继（KEY_SHIM，postMessage 给父页，不需要 allow-same-origin），中继报到（ready）
  // 之后才把焦点交给页面（课件 / PPT 的方向键开箱即用）；没报到的（老服务端的站点挂载还没注入中继）就不自动抢焦点，
  // 用户点进页面之前 Esc 照常关查看器。服务端 KEY_SHIM（src/runtime/html-site.mjs）注入同一段，两条路一致。
  //
  // 源码：主工具「源码」（Ctrl+U，浏览器「查看网页源代码」同键）切到只读代码视图（CodeView，与文本预览同一套：
  // 高亮、查找、跳到行、换行、字号）。页面 iframe 不卸载、只藏起来——切回去不重载、页面状态还在。
  // 源码按字节读、按「BOM → 页面声明的 charset → 自动识别」解码，GBK 老页面不乱码；超过上限只显示前 N MB 并明说。
  import { onMount, tick } from 'svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { useViewer } from './kit/context.js';
  import ViewerState from './kit/ViewerState.svelte';
  import CodeView from './CodeView.svelte';
  import { fmtBytes } from './kit/actions.js';
  import { readCapped, capFor } from '../../lib/codeview/readtext.js';
  import { detectHtmlEncoding, decodeBytes } from '../../lib/codeview/encoding.js';
  const { item } = $props();
  const viewer = useViewer();

  const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-forms allow-pointer-lock allow-downloads allow-presentation';
  // 与服务端 STORAGE_SHIM 同一段（srcdoc 回落路径用）
  const SHIM = '<script>(function(){function m(){var d=Object.create(null);return{getItem:function(k){k=String(k);return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){for(var k in d)delete d[k]},key:function(i){var a=Object.keys(d);return i<a.length?a[i]:null},get length(){return Object.keys(d).length}}}["localStorage","sessionStorage"].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:m(),configurable:true})}catch(_){}}});try{document.cookie}catch(e){var c="";try{Object.defineProperty(document,"cookie",{get:function(){return c},set:function(){},configurable:true})}catch(_){}}})();<\/script>';
  // 与服务端 SCROLLBAR_SHIM 同一段：沙箱页里换上 bridge 全站同款滚动条（平时隐身、滚动才浮出细线）
  const SB_SHIM = "<style>@media (pointer:fine){::-webkit-scrollbar{width:8px;height:8px;background:transparent}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}::-webkit-scrollbar-button{display:none}body::-webkit-scrollbar-track,body::-webkit-scrollbar-corner{background:var(--bsb-bg,transparent)}::-webkit-scrollbar-thumb{background-color:transparent;background-clip:padding-box;border:solid transparent;border-width:0 2px;border-radius:3.5px/1.5px;min-height:32px}::-webkit-scrollbar-thumb:horizontal{border-width:2px 0;border-radius:1.5px/3.5px;min-width:32px}[data-bsb]::-webkit-scrollbar-thumb{background-color:rgba(140,140,140,.72)}::-webkit-scrollbar-thumb:hover{border-width:0 1px;border-radius:2.5px/1.5px;background-color:rgba(140,140,140,.9)}::-webkit-scrollbar-thumb:horizontal:hover{border-width:1px 0;border-radius:1.5px/2.5px}}</style><script>(function(){if(!window.matchMedia||!matchMedia('(pointer: fine)').matches)return;var D=document,R=D.documentElement,T=new WeakMap(),H=null;function s(e){if(!e.hasAttribute('data-bsb'))e.setAttribute('data-bsb','');clearTimeout(T.get(e))}function l(e){clearTimeout(T.get(e));T.set(e,setTimeout(function(){if(e!==H)e.removeAttribute('data-bsb')},1000))}function o(c){return c&&c!=='transparent'&&!/^rgba\\(.*,\\s*0\\)$/.test(c)}function g(){var c=getComputedStyle(R).backgroundColor;if(!o(c)&&D.body)c=getComputedStyle(D.body).backgroundColor;if(!o(c)&&D.elementsFromPoint){var a=D.elementsFromPoint(R.clientWidth-2,innerHeight/2);for(var i=0;i<a.length&&!o(c);i++)c=getComputedStyle(a[i]).backgroundColor}if(!o(c))c='#fff';if(R.style.getPropertyValue('--bsb-bg')!==c)R.style.setProperty('--bsb-bg',c)}function q(){g();setTimeout(g,450)}D.addEventListener('DOMContentLoaded',function(){q();try{var m=new MutationObserver(q),f={attributes:true,attributeFilter:['class','style','data-theme']};m.observe(R,f);m.observe(D.body,f)}catch(_){}});addEventListener('load',q);D.addEventListener('scroll',function(v){var e=v.target===D?(D.body||R):v.target;if(!(e instanceof Element))return;s(e);if(e!==H)l(e)},{capture:true,passive:true});D.addEventListener('mousemove',function(v){var e=v.target,n=null;if(e instanceof Element){if((e===R||e===D.body)&&((v.clientX>=R.clientWidth&&innerWidth>R.clientWidth+1)||(v.clientY>=R.clientHeight&&innerHeight>R.clientHeight+1)))n=D.body||R;else if(e!==R&&((v.offsetX>=e.clientWidth&&e.offsetWidth>e.clientWidth+1&&e.scrollHeight>e.clientHeight)||(v.offsetY>=e.clientHeight&&e.offsetHeight>e.clientHeight+1&&e.scrollWidth>e.clientWidth)))n=e}if(n===H)return;if(H)l(H);H=n;if(H)s(H)},{passive:true})})();<\/script>";
  // Esc 中继：页面没自己处理掉的 Esc（冒泡到 window 且没 preventDefault）告诉父页；加载即报到一次
  const KEY_SHIM = '<script>(function(){try{parent.postMessage({__bridgeHv:"ready"},"*")}catch(_){}addEventListener("keydown",function(e){if(e.key==="Escape"&&!e.defaultPrevented&&!e.isComposing){try{parent.postMessage({__bridgeHv:"esc"},"*")}catch(_){}}})})();<\/script>';
  function withShim(html) {
    const m = /<meta\b[^>]*charset[^>]*>/i.exec(html.slice(0, 1024)) || /<head\b[^>]*>/i.exec(html) || /<html\b[^>]*>/i.exec(html) || /<!doctype[^>]*>/i.exec(html);
    const at = m ? m.index + m[0].length : 0;
    return html.slice(0, at) + SHIM + SB_SHIM + KEY_SHIM + html.slice(at);
  }

  let src = $state('');        // 挂载模式：iframe src
  let srcdoc = $state(null);   // 回落模式：iframe srcdoc
  let err = $state('');
  let ready = $state(false);   // 舞台显出页面（load 或兜底超时）
  let loaded = $state(false);  // 进度线收起（真正 load）
  let gen = $state(0);         // 重载代数：{#key} 重建 iframe
  let frame = $state(null);
  let stage = $state(null);
  let full = $state(false);
  let revealTimer = 0;
  let noSite = false;          // 挂载 iframe 被宿主 CSP 拦了：本次改走 srcdoc

  async function resolve() {
    err = ''; ready = false; loaded = false;
    clearTimeout(revealTimer);
    if (item.siteUrl && !noSite) {
      try {
        const r = await fetch(item.siteUrl, { credentials: 'same-origin' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const j = await r.json();
        if (!j?.url) throw new Error('no url');
        // 挂载路径相对【请求它的那台服务器】（LAN 直连 / 隧道 / 离线壳的远端），不是当前页面源
        src = new URL(j.url, new URL(item.siteUrl, location.href)).href;
        srcdoc = null;
        armReveal();
        return;
      } catch {}   // 老服务端 / 鉴权边角：回落 srcdoc，至少自包含页能开
    }
    try {
      let text = item.text;
      if (text == null) {
        const r = await fetch(item.url, { credentials: 'same-origin' });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        text = await r.text();
      }
      src = '';
      srcdoc = withShim(text);
      armReveal();
    } catch (e) { err = String(e?.message || e); }
  }
  // 页面 load 要等全部图片/音视频，素材多的课件能拖好几秒——先让首屏露出来，进度线继续走。
  function armReveal() { revealTimer = setTimeout(() => { ready = true; }, 1200); }
  let relayOk = false;         // 页里的 Esc 中继报到了：焦点可以交给页面
  // 键盘翻页类页面（课件 / PPT）开箱即用：焦点交给页面，方向键/空格直接到它手里——前提是 Esc 能中继出来、页面已载完、没在看源码
  function focusPage() { if (relayOk && loaded && !source) { try { frame?.focus(); } catch {} } }
  function onFrameLoad() {
    clearTimeout(revealTimer);
    ready = true; loaded = true;
    focusPage();
  }
  function onMessage(e) {
    if (!frame || e.source !== frame.contentWindow) return;
    const k = e.data?.__bridgeHv;
    if (k === 'ready') { relayOk = true; focusPage(); }   // 中继比 load 晚到（极少）：这时再交焦点
    else if (k === 'esc') { if (document.fullscreenElement) return; viewer.requestClose(); }
  }

  // —— 源码视图 ——
  let source = $state(false);
  let srcText = $state(null), srcErr = $state(''), srcTrunc = $state(null);   // srcTrunc: { shown, total }
  // 自动换行：记在本机（同 DocViewer 的 pv.wrap.<类别>）；没记过时触屏默认开——手机上压成一行的页面不换行就只能横着划
  let wrap = $state((() => { try { const w = localStorage.getItem('pv.wrap.html'); if (w != null) return w === '1'; } catch {} return viewer.touch; })());
  let wrapSeen = false;   // 首轮是读出来的初值，不回写（没动过就别替用户记一个默认）
  $effect(() => { const w = wrap; if (!wrapSeen) { wrapSeen = true; return; } try { localStorage.setItem('pv.wrap.html', w ? '1' : '0'); } catch {} });
  let cv = $state(null);
  let srcCtl = null;
  async function loadSource() {
    srcErr = ''; srcText = null; srcTrunc = null;
    srcCtl?.abort();
    const ctl = srcCtl = new AbortController();
    try {
      if (item.text != null) { srcText = item.text; return; }
      const r = await readCapped(item.url, { cap: capFor(viewer.touch), size: item.size, signal: ctl.signal });
      if (ctl.signal.aborted) return;
      const det = detectHtmlEncoding(r.bytes);
      srcText = decodeBytes(r.bytes, det.encoding, { partial: r.truncated });
      srcTrunc = r.truncated ? { shown: r.bytes.length, total: r.total } : null;
    } catch (e) { if (!ctl.signal.aborted) srcErr = String(e?.message || e); }
  }
  async function toggleSource() {
    source = !source;
    if (source) {
      if (srcText == null && !srcErr) loadSource();
      else { await tick(); cv?.focus(); }
    } else { await tick(); focusPage(); }
  }

  async function reload() {
    if (source) { srcText = null; loadSource(); return; }   // 源码视图里刷新＝重读源码
    relayOk = false;
    if (srcdoc != null && item.text == null) { srcdoc = null; await resolve(); }
    else { ready = false; loaded = false; armReveal(); }
    gen++;
  }

  const canFull = typeof document !== 'undefined' && !!document.fullscreenEnabled;
  async function toggleFull() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else { await stage?.requestFullscreen(); await tick(); frame?.focus(); }
    } catch {}
  }
  // apk 壳给本地页加了 frame-src 白名单（只放行自己电脑的 /api/hv/）：老壳、或服务器地址改了还没重载时
  // 挂载 iframe 会被拦成 ERR_BLOCKED_BY_CSP——iframe 的 load 照样触发、看不出失败，只能听违规事件，回落 srcdoc。
  function onCspViolation(e) {
    if (!src || noSite || !/^(frame|child)-src/.test(e.effectiveDirective || e.violatedDirective || '')) return;
    let origin = '';
    try { origin = new URL(src).origin; } catch {}
    if (!origin || !String(e.blockedURI || '').startsWith(origin)) return;
    noSite = true; src = ''; gen++;
    resolve();
  }
  function onFsChange() { full = !!document.fullscreenElement && document.fullscreenElement === stage; }

  const openExternal = () => { if (src) window.open(src, '_blank', 'noopener,noreferrer'); };
  const srcReady = $derived(source && srcText != null && !!cv);
  // 主工具 ≤3：页面态 = 源码 / 刷新 / 全屏（无全屏能力时换成「在浏览器中打开」）；源码态 = 源码（按下）/ 自动换行 / 查找。
  // 其余进 ⋮：在浏览器中打开、源码态的跳到行。
  $effect(() => viewer.declare({
    tools: () => [
      { id: 'source', icon: 'code', label: source ? t('查看页面') : t('源码'), kbd: 'Ctrl+U', active: source, onClick: toggleSource },
      ...(source ? [
        { id: 'wrap', icon: 'wrap', label: t('自动换行'), kbd: 'Alt+Z', active: wrap, onClick: () => { wrap = !wrap; }, disabled: !srcReady },
        { id: 'find', icon: 'search', label: t('查找'), kbd: 'Ctrl+F', onClick: () => cv?.openFind(), disabled: !srcReady },
      ] : [
        { id: 'refresh', icon: 'refresh', label: t('刷新'), kbd: 'F5', onClick: reload, disabled: !!err },
        canFull ? { id: 'full', icon: full ? 'exitFullscreen' : 'fullscreen', label: full ? t('退出全屏') : t('全屏'), onClick: toggleFull, disabled: !!err }
          : src && { id: 'external', icon: 'external', label: t('在浏览器中打开'), href: src },
      ]),
    ].filter(Boolean),
    menu: () => [
      source && srcReady && { label: t('跳到行…'), icon: 'gotoLine', kbd: 'Ctrl+G', onSelect: () => cv?.openGoto() },
      source && { label: t('刷新'), icon: 'refresh', kbd: 'F5', onSelect: reload },
      src && canFull && { label: t('在浏览器中打开'), icon: 'external', onSelect: openExternal },
    ].filter(Boolean),
    keys: (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && !e.shiftKey && !e.altKey && (e.key === 'u' || e.key === 'U')) { toggleSource(); return true; }
      if (e.key === 'F5' && !mod && !e.shiftKey) { reload(); return true; }
      if (source && cv && cv.handleKey(e)) return true;
      return false;
    },
  }));

  onMount(() => {
    resolve();
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('securitypolicyviolation', onCspViolation);
    window.addEventListener('message', onMessage);
    return () => {
      clearTimeout(revealTimer);
      srcCtl?.abort();
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('securitypolicyviolation', onCspViolation);
      window.removeEventListener('message', onMessage);
    };
  });
</script>
<div class="hv">
  <div class="hv-progress" class:on={!source && !loaded && !err}></div>
  {#if source}
    <div class="hv-src" data-pv-source>
      {#if srcErr}
        <ViewerState kind="error" icon="code" title={t('打开失败：{reason}', { reason: tr(srcErr) })} onRetry={loadSource} />
      {:else if srcText == null}
        <ViewerState kind="loading" />
      {:else}
        {#if srcTrunc}
          <div class="hv-note" role="status">{srcTrunc.total ? t('仅显示前 {n}（共 {total}）', { n: fmtBytes(srcTrunc.shown), total: fmtBytes(srcTrunc.total) }) : t('仅显示前 {n}', { n: fmtBytes(srcTrunc.shown) })}</div>
        {/if}
        <div class="hv-code"><CodeView bind:this={cv} text={srcText} name={item.name} lang="html" bind:wrap /></div>
      {/if}
    </div>
  {/if}
  <div class="hv-stage" class:hv-off={source} bind:this={stage} inert={source || null}>
    {#if err}
      <ViewerState kind="error" icon="globe" title={t('打开失败：{reason}', { reason: tr(err) })} onRetry={resolve} />
    {:else if src || srcdoc != null}
      {#key gen}
        {#if src}
          <iframe bind:this={frame} class="hv-frame" class:ready title={item.name} {src} sandbox={SANDBOX} allow="fullscreen; autoplay; clipboard-write" allowfullscreen onload={onFrameLoad}></iframe>
        {:else}
          <iframe bind:this={frame} class="hv-frame" class:ready title={item.name} {srcdoc} sandbox={SANDBOX} allow="fullscreen; autoplay; clipboard-write" allowfullscreen onload={onFrameLoad}></iframe>
        {/if}
      {/key}
    {/if}
    <!-- 页面露出来之前：统一的加载态（延迟 300ms 才出转圈，快的页面不闪）；露出后只剩顶边细进度线等剩余资源 -->
    {#if !ready && !err}<ViewerState kind="loading" />{/if}
  </div>
</div>

<style>
  /* 配色走 lib/doctheme.css 的 --md-*（.hv 在其作用域里，暗 / 亮两套与 md、PDF 同值）。 */
  .hv { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--md-stage); color: var(--md-fg); }

  /* 加载进度：舞台顶边一根细线来回走（紧贴顶栏下沿），载完淡出 */
  .hv-progress { position: absolute; z-index: 2; left: 0; right: 0; top: 0; height: 2px; overflow: hidden; opacity: 0; pointer-events: none;
    transition: opacity var(--mo-base) var(--ea-fade); }
  .hv-progress.on { opacity: 1; }
  .hv-progress::before { content: ''; position: absolute; top: 0; bottom: 0; width: 32%; border-radius: 2px; background: var(--md-fg-3);
    animation: hv-run 1.15s var(--ea-std) infinite; }
  @keyframes hv-run { from { transform: translateX(-100%); } to { transform: translateX(320%); } }
  @media (prefers-reduced-motion: reduce) { .hv-progress::before { animation-duration: 2.4s; } }

  .hv-stage { flex: 1; position: relative; min-height: 0; background: var(--md-stage); }
  /* 网页默认画布是白的：iframe 自己铺白，但就绪前隐身，避免深色界面上先闪一下白 */
  .hv-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; opacity: 0; transition: opacity var(--mo-quick) var(--ea-fade); }
  .hv-frame.ready { opacity: 1; }
  .hv-stage:fullscreen { background: #000; }
  /* 源码态：页面 iframe 留着（不重载、状态不丢），只是不可见不可交互 */
  .hv-stage.hv-off { visibility: hidden; }
  .hv-src { position: absolute; inset: 0; z-index: 1; display: flex; flex-direction: column; background: var(--md-bg); }
  .hv-code { flex: 1; position: relative; min-height: 0; }
  .hv-note { flex: none; padding: 8px 16px; font-size: 12.5px; line-height: 18px; color: var(--md-fg-2); background: var(--md-bg-2, var(--md-stage)); border-bottom: 1px solid var(--md-line); }
</style>
