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
  // 外观：一条贴着应用主题的细工具栏（暗/亮两套），不再是压在深色界面上的大白条；
  // 加载用工具栏底边的细进度线，页面就绪前舞台留主题底色，不闪白。
  import { onMount, tick } from 'svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { interceptSave, saveLabel } from '../../lib/save.js';
  import { nativeWorkspaceSaveAs } from '../../lib/nativeDesktop.js';
  const { item, onClose } = $props();

  const SANDBOX = 'allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-forms allow-pointer-lock allow-downloads allow-presentation';
  // 与服务端 STORAGE_SHIM 同一段（srcdoc 回落路径用）
  const SHIM = '<script>(function(){function m(){var d=Object.create(null);return{getItem:function(k){k=String(k);return k in d?d[k]:null},setItem:function(k,v){d[String(k)]=String(v)},removeItem:function(k){delete d[String(k)]},clear:function(){for(var k in d)delete d[k]},key:function(i){var a=Object.keys(d);return i<a.length?a[i]:null},get length(){return Object.keys(d).length}}}["localStorage","sessionStorage"].forEach(function(n){try{window[n].length}catch(e){try{Object.defineProperty(window,n,{value:m(),configurable:true})}catch(_){}}});try{document.cookie}catch(e){var c="";try{Object.defineProperty(document,"cookie",{get:function(){return c},set:function(){},configurable:true})}catch(_){}}})();<\/script>';
  // 与服务端 SCROLLBAR_SHIM 同一段：沙箱页里换上 Edge 同款滚动条（平时隐身、滚动才浮出细线）
  const SB_SHIM = "<style>@media (pointer:fine){::-webkit-scrollbar{width:12px;height:12px;background:transparent}::-webkit-scrollbar-track,::-webkit-scrollbar-corner{background:transparent}::-webkit-scrollbar-button{display:none}body::-webkit-scrollbar-track,body::-webkit-scrollbar-corner{background:var(--bsb-bg,transparent)}::-webkit-scrollbar-thumb{background-color:transparent;background-clip:padding-box;border:solid transparent;border-width:0 3px 0 5px;border-radius:999px;min-height:40px}::-webkit-scrollbar-thumb:horizontal{border-width:5px 0 3px 0;min-width:40px}[data-bsb]::-webkit-scrollbar-thumb{background-color:rgba(140,140,140,.72)}::-webkit-scrollbar-thumb:hover{border-width:0 2px;background-color:rgba(140,140,140,.9)}::-webkit-scrollbar-thumb:horizontal:hover{border-width:2px 0}}</style><script>(function(){if(!window.matchMedia||!matchMedia('(pointer: fine)').matches)return;var D=document,R=D.documentElement,T=new WeakMap(),H=null;function s(e){if(!e.hasAttribute('data-bsb'))e.setAttribute('data-bsb','');clearTimeout(T.get(e))}function l(e){clearTimeout(T.get(e));T.set(e,setTimeout(function(){if(e!==H)e.removeAttribute('data-bsb')},1000))}function o(c){return c&&c!=='transparent'&&!/^rgba\\(.*,\\s*0\\)$/.test(c)}function g(){var c=getComputedStyle(R).backgroundColor;if(!o(c)&&D.body)c=getComputedStyle(D.body).backgroundColor;if(!o(c)&&D.elementsFromPoint){var a=D.elementsFromPoint(R.clientWidth-2,innerHeight/2);for(var i=0;i<a.length&&!o(c);i++)c=getComputedStyle(a[i]).backgroundColor}if(!o(c))c='#fff';if(R.style.getPropertyValue('--bsb-bg')!==c)R.style.setProperty('--bsb-bg',c)}function q(){g();setTimeout(g,450)}D.addEventListener('DOMContentLoaded',function(){q();try{var m=new MutationObserver(q),f={attributes:true,attributeFilter:['class','style','data-theme']};m.observe(R,f);m.observe(D.body,f)}catch(_){}});addEventListener('load',q);D.addEventListener('scroll',function(v){var e=v.target===D?(D.body||R):v.target;if(!(e instanceof Element))return;s(e);if(e!==H)l(e)},{capture:true,passive:true});D.addEventListener('mousemove',function(v){var e=v.target,n=null;if(e instanceof Element){if((e===R||e===D.body)&&((v.clientX>=R.clientWidth&&innerWidth>R.clientWidth+1)||(v.clientY>=R.clientHeight&&innerHeight>R.clientHeight+1)))n=D.body||R;else if(e!==R&&((v.offsetX>=e.clientWidth&&e.offsetWidth>e.clientWidth+1&&e.scrollHeight>e.clientHeight)||(v.offsetY>=e.clientHeight&&e.offsetHeight>e.clientHeight+1&&e.scrollWidth>e.clientWidth)))n=e}if(n===H)return;if(H)l(H);H=n;if(H)s(H)},{passive:true})})();<\/script>";
  function withShim(html) {
    const m = /<meta\b[^>]*charset[^>]*>/i.exec(html.slice(0, 1024)) || /<head\b[^>]*>/i.exec(html) || /<html\b[^>]*>/i.exec(html) || /<!doctype[^>]*>/i.exec(html);
    const at = m ? m.index + m[0].length : 0;
    return html.slice(0, at) + SHIM + SB_SHIM + html.slice(at);
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
  function onFrameLoad() {
    clearTimeout(revealTimer);
    ready = true; loaded = true;
    // 键盘翻页类页面（课件 / PPT）开箱即用：焦点交给页面，方向键/空格直接到它手里
    try { frame?.focus(); } catch {}
  }

  async function reload() {
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

  async function saveNative() { await nativeWorkspaceSaveAs(item.saveTarget.rel, item.nativeLocation); }

  onMount(() => {
    resolve();
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('securitypolicyviolation', onCspViolation);
    return () => {
      clearTimeout(revealTimer);
      document.removeEventListener('fullscreenchange', onFsChange);
      document.removeEventListener('securitypolicyviolation', onCspViolation);
    };
  });
</script>

<div class="hv">
  <header class="hv-bar">
    <button class="hv-btn" aria-label={t('返回')} title={t('返回')} onclick={onClose}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 5.5 8 12l6.5 6.5" /></svg>
    </button>
    <div class="hv-title" title={item.name}>
      <svg class="hv-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.25" /><path d="M3.75 12h16.5M12 3.75c2.3 2.4 3.4 5.15 3.4 8.25S14.3 17.85 12 20.25C9.7 17.85 8.6 15.1 8.6 12S9.7 6.15 12 3.75Z" /></svg>
      <span class="hv-name">{item.name}</span>
    </div>
    <div class="hv-tools">
      <button class="hv-btn" aria-label={t('刷新')} title={t('刷新')} onclick={reload} disabled={!!err}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M19.25 12a7.25 7.25 0 1 1-2.12-5.13" /><path d="M19.5 4.75v3.75h-3.75" /></svg>
      </button>
      {#if canFull}
        <button class="hv-btn" aria-label={full ? t('退出全屏') : t('全屏')} title={full ? t('退出全屏') : t('全屏')} onclick={toggleFull} disabled={!!err}>
          {#if full}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 4.75V9.5H4.75M14.5 4.75V9.5h4.75M9.5 19.25V14.5H4.75M14.5 19.25V14.5h4.75" /></svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.75 9.25v-4.5h4.5M19.25 9.25v-4.5h-4.5M4.75 14.75v4.5h4.5M19.25 14.75v4.5h-4.5" /></svg>
          {/if}
        </button>
      {/if}
      {#if src}
        <a class="hv-btn" href={src} target="_blank" rel="noopener noreferrer" aria-label={t('在浏览器中打开')} title={t('在浏览器中打开')}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M13.75 4.75h5.5v5.5M19 5l-8 8" /><path d="M17.25 13.75v4a1.5 1.5 0 0 1-1.5 1.5h-9.5a1.5 1.5 0 0 1-1.5-1.5v-9.5a1.5 1.5 0 0 1 1.5-1.5h4" /></svg>
        </a>
      {/if}
      {#if item.nativeLocation && item.saveTarget?.rel}
        <button class="hv-btn" aria-label={t('另存为…')} title={t('另存为…')} onclick={saveNative}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.75v10.5M7.75 11 12 15.25 16.25 11" /><path d="M5 19.25h14" /></svg>
        </button>
      {:else if item.downloadHref}
        <a class="hv-btn" href={item.downloadHref} download={item.name} aria-label={saveLabel(t('下载'))} title={saveLabel(t('下载'))} onclick={(e) => interceptSave(e, { url: item.downloadHref, name: item.name, path: item.absPath || '' })}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.75v10.5M7.75 11 12 15.25 16.25 11" /><path d="M5 19.25h14" /></svg>
        </a>
      {/if}
    </div>
    <div class="hv-progress" class:on={!loaded && !err}></div>
  </header>

  <div class="hv-stage" bind:this={stage}>
    {#if err}
      <div class="hv-msg">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.25" /><path d="M12 8v4.75M12 15.9v.1" /></svg>
        <div class="hv-msg-t">{t('打开失败：{reason}', { reason: tr(err) })}</div>
        <button class="hv-retry" onclick={resolve}>{t('重试')}</button>
      </div>
    {:else if src || srcdoc != null}
      {#key gen}
        {#if src}
          <iframe bind:this={frame} class="hv-frame" class:ready title={item.name} {src} sandbox={SANDBOX} allow="fullscreen; autoplay; clipboard-write" allowfullscreen onload={onFrameLoad}></iframe>
        {:else}
          <iframe bind:this={frame} class="hv-frame" class:ready title={item.name} {srcdoc} sandbox={SANDBOX} allow="fullscreen; autoplay; clipboard-write" allowfullscreen onload={onFrameLoad}></iframe>
        {/if}
      {/key}
    {/if}
  </div>
</div>

<style>
  /* 主题令牌：bridge 暗色为默认，亮色挂 html[data-theme="light"]。与应用外框同一块色，
     查看器像应用里的一页，而不是一张压上来的白纸。 */
  .hv {
    --hv-bar: #1c1c1b; --hv-line: rgba(255, 255, 255, .07); --hv-fg: rgba(250, 249, 245, .93);
    --hv-dim: rgba(250, 249, 245, .5); --hv-hover: rgba(255, 255, 255, .075); --hv-press: rgba(255, 255, 255, .12);
    --hv-stage: #151514; --hv-run: rgba(250, 249, 245, .55);
    position: fixed; inset: 0; z-index: 1; display: flex; flex-direction: column;
    background: var(--hv-stage); color: var(--hv-fg);
  }
  :global(html[data-theme="light"]) .hv {
    --hv-bar: #faf9f5; --hv-line: rgba(31, 30, 29, .09); --hv-fg: #1f1e1d;
    --hv-dim: rgba(31, 30, 29, .5); --hv-hover: rgba(31, 30, 29, .055); --hv-press: rgba(31, 30, 29, .1);
    --hv-stage: #f0eee8; --hv-run: rgba(31, 30, 29, .45);
  }

  /* 顶栏让开系统状态栏（--sat，apk 原生注入），与 DocViewer/PdfView/OfficeView 同一规矩。
     --pv-bar-h：宿主可调（手机工作台 sheet 里收得更矮）。 */
  .hv-bar {
    position: relative; flex: none; box-sizing: border-box;
    height: calc(var(--pv-bar-h, 44px) + var(--sat, 0px)); padding: var(--sat, 0px) 6px 0;
    display: flex; align-items: center; gap: 2px;
    background: var(--hv-bar); box-shadow: inset 0 -1px 0 var(--hv-line);
  }
  .hv-title { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; padding: 0 6px 0 2px; }
  .hv-glyph { width: 15px; height: 15px; flex: none; color: var(--hv-dim); }
  .hv-name { min-width: 0; font-size: 13.5px; font-weight: 550; letter-spacing: .005em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .hv-tools { flex: none; display: flex; align-items: center; gap: 1px; }
  .hv-btn {
    width: 32px; height: 32px; flex: none; display: grid; place-items: center; padding: 0;
    border: 0; border-radius: 8px; background: none; color: var(--hv-dim);
    cursor: pointer; text-decoration: none; transition: background-color .12s, color .12s;
  }
  .hv-btn:first-child { color: var(--hv-fg); }
  .hv-btn:hover { background: var(--hv-hover); color: var(--hv-fg); }
  .hv-btn:active { background: var(--hv-press); }
  .hv-btn:disabled { opacity: .35; pointer-events: none; }
  .hv-btn:focus-visible { outline: 1.5px solid var(--hv-run); outline-offset: -1.5px; }
  .hv-btn svg { width: 18px; height: 18px; }

  /* 加载进度：工具栏底边一根细线来回走，载完淡出 */
  .hv-progress { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; overflow: hidden; opacity: 0; transition: opacity .3s; pointer-events: none; }
  .hv-progress.on { opacity: 1; }
  .hv-progress::before { content: ''; position: absolute; top: 0; bottom: 0; width: 32%; border-radius: 2px; background: var(--hv-run); animation: hv-run 1.15s cubic-bezier(.45, 0, .25, 1) infinite; }
  @keyframes hv-run { from { transform: translateX(-100%); } to { transform: translateX(320%); } }
  @media (prefers-reduced-motion: reduce) { .hv-progress::before { animation-duration: 2.4s; } }

  .hv-stage { flex: 1; position: relative; min-height: 0; background: var(--hv-stage); }
  /* 网页默认画布是白的：iframe 自己铺白，但就绪前隐身，避免深色界面上先闪一下白 */
  .hv-frame { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; opacity: 0; transition: opacity .16s ease-out; }
  .hv-frame.ready { opacity: 1; }
  .hv-stage:fullscreen { background: #000; }

  .hv-msg { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 24px; text-align: center; color: var(--hv-dim); }
  .hv-msg svg { width: 28px; height: 28px; }
  .hv-msg-t { max-width: 420px; font-size: 13.5px; line-height: 1.5; }
  .hv-retry { margin-top: 4px; height: 30px; padding: 0 14px; border: 0; border-radius: 8px; background: var(--hv-hover); color: var(--hv-fg); font: inherit; font-size: 13px; cursor: pointer; }
  .hv-retry:hover { background: var(--hv-press); }
</style>
