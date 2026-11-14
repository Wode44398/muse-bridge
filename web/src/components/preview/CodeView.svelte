<script>
  // 代码 / 文本查看器（DocViewer 的文本分支、HtmlView 的「源码」共用）：CM6 只读视图为主，editing=true 时可编辑。
  // 内核在 lib/codeview/cm.js（懒加载 chunk）；这里是外壳：查找条 / 跳到行条、字号（Ctrl+滚轮、双指捏合、Ctrl+= / - / 0）、
  // 自动换行、键盘分发（宿主把查看器的 keydown 交给 handleKey）。
  //
  // 宿主用法：<CodeView bind:this={cv} text name lang editing bind:wrap log eol onchange={(s) => …} />
  //   cv.handleKey(e) → true＝吃掉了；cv.openFind() / openGoto() / toggleWrap() / zoom(±1) / flush()（编辑中防抖未发出的改动立即回调）
  import { t } from '../../lib/i18n.js';
  import { pointer } from '../../lib/layout.svelte.js';
  import { useViewer } from './kit/context.js';
  import { tip } from './kit/tooltip.js';
  import VIcon from './kit/VIcon.svelte';
  import { holdFocus } from './paged/FindBar.svelte';
  import { pushBackLayer } from '../../lib/nav.js';

  let { text = '', name = '', lang = '', editing = false, wrap = $bindable(false), log = false, eol = '\n', onchange = null, onready = null } = $props();
  const viewer = useViewer();
  const touch = $derived(!pointer.fine);

  // —— 字号：全站一份，记在本机（代码与纯文本共用） ——
  const FS_KEY = 'pv.codeFs', FS_MIN = 9, FS_MAX = 30;
  const fsDefault = () => (pointer.fine ? 13 : 13.5);
  function loadFs() { const v = +localStorage.getItem(FS_KEY); return v >= FS_MIN && v <= FS_MAX ? v : fsDefault(); }
  let fs = $state(loadFs());

  let host = $state(null);
  let cv = null, ready = $state(false), lastText = null, applying = false;
  let chT = 0, srT = 0;

  $effect(() => {
    const el = host;
    if (!el) return;
    let dead = false;
    import('../../lib/codeview/cm.js').then((m) => {
      if (dead) return;
      const doc = lastText = text;
      cv = m.createCodeView({
        parent: el, doc, name, lang, editable: editing, wrap, log, touch,
        onChange: onCmChange,
      });
      ready = true;
      // 电脑端：打开即可用键盘翻页 / 方向键（只读态光标藏起来，当前行跟着走）
      if (pointer.fine) cv.view.contentDOM.focus({ preventScroll: true });
      onready?.();
    });
    return () => { dead = true; clearTimeout(chT); clearTimeout(srT); cv?.destroy(); cv = null; ready = false; };
  });

  $effect(() => { const e = editing; if (ready) { cv.setEditable(e); if (e) cv.focus(); } });
  $effect(() => { const w = wrap; if (ready) cv.keepTopWhile(() => cv.setWrap(w)); });
  $effect(() => { const l = log; if (ready) cv.setLog(l); });
  $effect(() => {
    const x = text;
    if (!ready || x === lastText) return;
    lastText = x;
    applying = true;
    try { cv.setDoc(x); } finally { applying = false; }
    if (bar === 'find' && q) runSearch(true);
  });

  // 编辑：改动回调宿主（大文档防抖 200ms——每键整篇拼一次 5MB 字符串太贵；宿主保存 / 离开前调 flush）
  function onCmChange() {
    if (applying || !onchange) return;
    clearTimeout(chT);
    if (cv && cv.view.state.doc.length > 1_000_000) chT = setTimeout(emit, 200);
    else emit();
    if (bar === 'find' && q) { clearTimeout(srT); srT = setTimeout(() => runSearch(true), 250); }
  }
  function emit() {
    clearTimeout(chT); chT = 0;
    if (!cv) return;
    const s = cv.getText(eol);
    lastText = s;
    onchange?.(s);
  }
  export function flush() { if (chT) emit(); }
  export function getText() { return cv ? cv.getText(eol) : text; }
  export function focus() { cv?.focus(); }
  export function gotoLine(n, col) { return cv?.gotoLine(n, col); }

  // —— 查找 / 跳到行 ——
  let bar = $state(null);   // null | 'find' | 'goto'
  let q = $state(''), cs = $state(false), re = $state(false), word = $state(false);
  let res = $state({ n: 0, cur: -1, capped: false, error: false });
  let gl = $state('');
  let qEl = $state(null), glEl = $state(null);
  const countText = $derived(
    !q ? '' : res.error ? t('正则有误') : !res.n ? t('无结果')
      : (res.cur + 1).toLocaleString() + '/' + res.n.toLocaleString() + (res.capped ? '+' : ''));   // 与 paged/FindBar 同一写法

  function runSearch(keep = false) {
    clearTimeout(srT);
    if (!cv) return;
    const r = cv.search(q ? { q, cs, re, word } : null);
    res = { n: r.n, cur: r.cur, capped: !!r.capped, error: !!r.error };
    if (!keep && r.n) cv.reveal();
  }
  function queueSearch() {
    clearTimeout(srT);
    // 小文档跟手；大文档停顿 160ms 再搜（每次全篇扫一遍）
    const big = (cv?.view.state.doc.length || 0) > 2_000_000;
    srT = setTimeout(() => runSearch(), big ? 160 : 40);
  }
  function step(d) {
    if (!cv) return;
    if (!res.n && q) runSearch(true);
    const r = cv.step(d);
    res = { ...res, n: r.n, cur: r.cur };
  }
  export function openFind() {
    const sel = cv?.selectionText() || '';
    if (sel && !sel.includes('\n')) q = sel;
    bar = 'find';
    requestAnimationFrame(() => { holdFocus(qEl); qEl?.select(); if (q) runSearch(); });
  }
  export function openGoto() {
    gl = '';
    bar = 'goto';
    requestAnimationFrame(() => holdFocus(glEl));
  }
  export function closeBar() {
    if (!bar) return;
    bar = null;
    cv?.search(null);
    res = { n: 0, cur: -1, capped: false, error: false };
    if (pointer.fine) cv?.focus();
  }
  function onFindKey(e) {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); step(e.shiftKey ? -1 : 1); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBar(); return; }
    if (e.altKey && !e.ctrlKey && !e.metaKey) {
      const k = e.code;
      if (k === 'KeyC') { e.preventDefault(); cs = !cs; runSearch(); }
      else if (k === 'KeyW') { e.preventDefault(); word = !word; runSearch(); }
      else if (k === 'KeyR') { e.preventDefault(); re = !re; runSearch(); }
    }
  }
  function goLine() {
    const m = /^\s*(\d+)(?:\s*[:：,，]\s*(\d+))?\s*$/.exec(gl);
    if (!m) { viewer.toast(t('请输入行号')); return; }
    cv?.gotoLine(+m[1], m[2] ? +m[2] : 1);
    bar = null;
    if (pointer.fine) cv?.focus();
  }
  function onGotoKey(e) {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); goLine(); return; }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeBar(); }
  }
  const lineCount = $derived(ready ? (text, cv?.lines || 0) : 0);
  // 查找 / 跳到行条开着时挂一层系统返回：安卓侧滑 / 返回键先收条，不直接关掉查看器
  $effect(() => { if (bar) return pushBackLayer(closeBar); });

  // —— 换行 / 字号 ——
  export function toggleWrap() { wrap = !wrap; }
  function setFs(v, quiet = false) {
    const n = Math.round(Math.max(FS_MIN, Math.min(FS_MAX, v)) * 2) / 2;
    if (n === fs) return;
    if (cv) cv.keepTopWhile(() => { fs = n; });
    else fs = n;
    try { localStorage.setItem(FS_KEY, String(n)); } catch {}
    if (!quiet) viewer.toast(t('字号 {n}%', { n: Math.round((n / fsDefault()) * 100) }), { ms: 900 });
  }
  export function zoom(d) { setFs(fs + d); }
  export function zoomReset() { setFs(fsDefault()); }

  // Ctrl+滚轮：鼠标滚轮一格（deltaY ≈ ±100，或按行 / 页计的 deltaMode）＝ 字号 ±1px，和 Ctrl+= / - 同步长；
  // 触控板双指捏合（也是 ctrl+wheel，但一次只有几个像素）按 deltaY 指数换算、连续缩放。
  // 连续缩放先在浮点 wf 上累加，再交给 setFs 取半像素——每次只差零点几 px 时直接对 fs 取整会一直卡在原值
  let wf = 0, wfT = 0;
  function onWheel(e) {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    if (!e.deltaY) return;
    if (e.deltaMode !== 0 || Math.abs(e.deltaY) >= 50) { wf = 0; setFs(fs + (e.deltaY < 0 ? 1 : -1)); return; }
    clearTimeout(wfT);
    wfT = setTimeout(() => { wf = 0; }, 400);
    wf = Math.max(FS_MIN, Math.min(FS_MAX, (wf || fs) * Math.exp(-e.deltaY / 200)));
    setFs(wf, true);
  }
  // 触屏双指捏合：按两指间距比例缩放字号（捏的过程中不弹字号提示；同 Ctrl+滚轮，字号随手记在本机）
  let pinch = null;
  function dist(ts) { const a = ts[0], b = ts[1]; return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); }
  function onTouchStart(e) { if (e.touches.length === 2) pinch = { d: dist(e.touches), fs }; }
  function onTouchMove(e) {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const v = pinch.fs * (dist(e.touches) / pinch.d);
    setFs(v, true);
  }
  function onTouchEnd(e) { if (pinch && e.touches.length < 2) { pinch = null; } }
  $effect(() => {
    const el = host;
    if (!el) return;
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
    };
  });

  /** 宿主把查看器的 keydown 交过来：true＝处理了（宿主 preventDefault） */
  export function handleKey(e) {
    if (e.isComposing) return false;
    const mod = e.ctrlKey || e.metaKey, k = e.code;
    if (mod && !e.altKey && !e.shiftKey && k === 'KeyF') { openFind(); return true; }
    if (mod && !e.altKey && !e.shiftKey && k === 'KeyG') { openGoto(); return true; }
    if (e.key === 'F3') { if (bar !== 'find') openFind(); else step(e.shiftKey ? -1 : 1); return true; }
    if (e.altKey && !mod && k === 'KeyZ') { toggleWrap(); return true; }
    if (mod && !e.altKey && (e.key === '=' || e.key === '+' || k === 'NumpadAdd')) { zoom(1); return true; }
    if (mod && !e.altKey && (e.key === '-' || k === 'NumpadSubtract')) { zoom(-1); return true; }
    if (mod && !e.altKey && (e.key === '0' || k === 'Numpad0')) { zoomReset(); return true; }
    if (e.key === 'Escape' && bar) { closeBar(); return true; }
    return false;
  }
</script>

<div class="cv" class:cv-touch={touch}>
  {#if bar}
    <div class="cv-bar" role="search">
      {#if bar === 'find'}
        <label class="cv-field">
          <VIcon name="search" size={16} />
          <input bind:this={qEl} class="cv-q" type="text" placeholder={t('查找')} aria-label={t('查找')} enterkeyhint="search" spellcheck="false" autocapitalize="off" autocomplete="off"
            bind:value={q} oninput={queueSearch} onkeydown={onFindKey} />
          <span class="cv-count" class:err={res.error} aria-live="polite">{countText}</span>
        </label>
        {#if !touch}
          <button class="cv-btn" class:on={cs} aria-pressed={cs} use:tip={{ label: t('区分大小写'), kbd: 'Alt+C' }} onclick={() => { cs = !cs; runSearch(); }}><VIcon name="matchCase" /></button>
          <button class="cv-btn" class:on={word} aria-pressed={word} use:tip={{ label: t('全字匹配'), kbd: 'Alt+W' }} onclick={() => { word = !word; runSearch(); }}><VIcon name="wholeWord" /></button>
          <button class="cv-btn" class:on={re} aria-pressed={re} use:tip={{ label: t('正则表达式'), kbd: 'Alt+R' }} onclick={() => { re = !re; runSearch(); }}><VIcon name="regex" /></button>
          <span class="cv-sep"></span>
        {/if}
        <button class="cv-btn" disabled={!res.n} use:tip={{ label: t('上一个'), kbd: 'Shift+Enter' }} onclick={() => step(-1)}><VIcon name="up" /></button>
        <button class="cv-btn" disabled={!res.n} use:tip={{ label: t('下一个'), kbd: 'Enter' }} onclick={() => step(1)}><VIcon name="down" /></button>
      {:else}
        <label class="cv-field">
          <VIcon name="gotoLine" size={16} />
          <input bind:this={glEl} class="cv-q" type="text" inputmode="numeric" enterkeyhint="go" autocomplete="off" aria-label={t('跳转')}
            placeholder={t('跳到行（1–{n}）', { n: lineCount.toLocaleString() })} bind:value={gl} onkeydown={onGotoKey} />
        </label>
        <button class="cv-btn cv-go" use:tip={{ label: t('跳转'), kbd: 'Enter' }} onclick={goLine}>{t('跳转')}</button>
      {/if}
      <button class="cv-btn" use:tip={{ label: t('关闭'), kbd: 'Esc' }} onclick={closeBar}><VIcon name="close" /></button>
    </div>
  {/if}
  <div class="cv-cm" class:cv-ro={!editing} bind:this={host} style:--cv-fs={fs + 'px'} data-pv-code></div>
</div>

<style>
  .cv { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--md-bg); }
  .cv-cm { flex: 1; min-height: 0; position: relative; }
  .cv-cm :global(.cm-editor) { position: absolute; inset: 0; }
  /* 只读：不画光标（键盘移动照常，当前行底色指示位置） */
  .cv-ro :global(.cm-cursorLayer) { display: none; }

  /* —— 查找 / 跳到行条：内嵌在正文上沿，不浮在字上 —— */
  .cv-bar { flex: none; display: flex; align-items: center; gap: 2px; padding: 6px 8px 6px 10px; background: var(--md-bg);
    box-shadow: inset 0 -.5px 0 rgba(var(--md-ink), .14); animation: cvbar var(--mo-quick, 200ms) var(--ea-decel, ease-out) both; }
  @keyframes cvbar { from { opacity: 0; transform: translateY(-4px); } }
  @media (prefers-reduced-motion: reduce) { .cv-bar { animation: none; } }
  .cv-field { flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; height: 32px; padding: 0 10px; margin-right: 4px;
    border-radius: 8px; background: rgba(var(--md-ink), .055); color: var(--md-fg-3); }
  .cv-field:focus-within { background: var(--md-field); box-shadow: 0 0 0 1px rgba(var(--md-ink), .22); }   /* 与 paged/FindBar 同一聚焦样式 */
  .cv-q { flex: 1; min-width: 0; height: 100%; border: 0; outline: none; background: none; color: var(--md-fg); font: inherit; font-size: 13px; }
  .cv-q::placeholder { color: var(--md-fg-4); }
  .cv-count { flex: none; font-size: 12px; color: var(--md-fg-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .cv-count.err { color: var(--md-danger); }
  .cv-btn { flex: none; display: grid; place-items: center; width: 32px; height: 32px; border-radius: 8px; color: var(--md-fg-2); --vw-ic: 18px;
    transition: background var(--mo-tap, 90ms), color var(--mo-micro, 140ms); }
  .cv-btn:hover:not(:disabled) { background: rgba(var(--md-ink), .06); color: var(--md-fg); }
  .cv-btn:active:not(:disabled) { background: rgba(var(--md-ink), .1); }
  .cv-btn:disabled { opacity: .35; }
  .cv-btn.on { color: var(--md-accent-deep); background: var(--md-accent-tint); }
  .cv-go { width: auto; padding: 0 12px; font-size: 13px; font-weight: 600; color: var(--md-fg); }
  .cv-sep { width: .5px; height: 18px; margin: 0 4px; background: rgba(var(--md-ink), .16); }
  /* 触屏：按钮与输入框都是 44 命中（16px 字防 iOS 聚焦缩放） */
  .cv-touch .cv-bar { padding: 4px 4px 4px 10px; gap: 0; }
  .cv-touch .cv-field { height: 44px; border-radius: 10px; }
  .cv-touch .cv-q { font-size: 16px; }
  .cv-touch .cv-btn { width: 44px; height: 44px; border-radius: 12px; --vw-ic: 20px; }
  .cv-touch .cv-go { width: auto; padding: 0 14px; font-size: 15px; }

  /* —— 语法配色（lib/codeview/cm.js 的 cvh-* 类，令牌同阅读态代码块 --md-c-*）—— */
  .cv-cm :global(.cvh-kw) { color: var(--md-c-kw); }
  .cv-cm :global(.cvh-str) { color: var(--md-c-str); }
  .cv-cm :global(.cvh-num) { color: var(--md-c-num); }
  .cv-cm :global(.cvh-fn) { color: var(--md-c-fn); }
  .cv-cm :global(.cvh-type) { color: var(--md-c-type); }
  .cv-cm :global(.cvh-prop) { color: var(--md-c-prop); }
  .cv-cm :global(.cvh-op) { color: var(--md-c-op); }
  .cv-cm :global(.cvh-re) { color: var(--md-c-re); }
  .cv-cm :global(.cvh-cmt) { color: var(--md-c-cmt); font-style: italic; }
  .cv-cm :global(.cvh-h) { font-weight: 700; color: var(--md-fg); }
  .cv-cm :global(.cvh-b) { font-weight: 700; }
  .cv-cm :global(.cvh-i) { font-style: italic; }
  .cv-cm :global(.cvh-link) { color: var(--md-link, var(--md-accent-deep)); text-decoration: underline; text-underline-offset: 2px; }

  /* 查找命中：暖黄高亮；当前项再叠一圈强调色描边 */
  .cv-cm :global(.cv-hit) { background: var(--md-mark); border-radius: 2px; }
  .cv-cm :global(.cv-hit-cur) { box-shadow: 0 0 0 1.5px var(--md-accent); }

  /* 日志：克制——只有错误整行铺极浅底，级别词染色加粗，时间戳压灰，DEBUG/TRACE 整行弱化 */
  .cv-cm :global(.cv-log-err) { background: color-mix(in srgb, var(--md-danger) 7%, transparent); }
  .cv-cm :global(.cv-lv-err) { color: var(--md-danger); font-weight: 600; }
  .cv-cm :global(.cv-lv-warn) { color: var(--md-c-prop); font-weight: 600; }
  .cv-cm :global(.cv-log-ts) { color: var(--md-fg-3); }
  .cv-cm :global(.cv-log-dim) { color: var(--md-fg-3); }
</style>
