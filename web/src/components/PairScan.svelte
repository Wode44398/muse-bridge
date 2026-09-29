<script>
  // 手机端「扫一扫」：全屏取景 → 解码 → 确认卡 → /api/pair/approve，网页那头即登录。
  // 解码优先原生 BarcodeDetector（Chromium 内建、零依赖；WebView 上不可用时 detect 会抛，
  // 抛一次就换 jsQR），否则懒加载 jsQR 逐帧扫 canvas。相册选图走同一条解码链。
  // ui.pairScan = { mode:'scan' } 打开相机；{ mode:'confirm', id, key } 是系统相机扫到网址
  // 打开网页时的直达（App.svelte 解 ?pair= 后置入），跳过取景直接进确认卡。
  import { onMount } from 'svelte';
  import { fade, fly } from 'svelte/transition';
  import { api } from '../lib/api.js';
  import { ui, me } from '../lib/state.svelte.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { parsePairPayload } from '../lib/pair.js';
  import { t, tr, locale, isEn } from '../lib/i18n.js';

  let phase = $state('camera');   // 'camera' | 'checking' | 'confirm' | 'approving' | 'done' | 'error'
  let err = $state(''), hint = $state('');
  let info = $state(null);        // /api/pair/scan 的返回：device / ip / created
  let ticket = null;              // { id, key }
  let videoEl = $state(), fileEl = $state();
  let stream = null, timer = 0, canvas = null, detector = null, jsqr = null, running = false;
  let lastBadAt = 0;
  const ident = $derived(me.kind === 'admin' ? t('管理员') : (me.user || t('我')));
  const secure = typeof window !== 'undefined' && window.isSecureContext !== false;

  function haptic(kind) { try { navigator.vibrate?.(kind === 'heavy' ? 18 : kind === 'tick' ? 6 : 10); } catch {} }
  function close() { stopCam(); ui.pairScan = null; }
  $effect(() => pushBackLayer(close));

  onMount(() => {
    const p = ui.pairScan;
    if (p?.mode === 'confirm' && p.id && p.key) onPayload({ id: p.id, key: p.key });
    else startCam();
    return stopCam;
  });

  function camErr(e) {
    const n = e?.name || '';
    if (n === 'NotAllowedError' || n === 'SecurityError') return t('相机权限被拒绝。请在浏览器 / 系统设置里允许本站使用相机，或从相册选择二维码截图。');
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return t('没有找到可用的相机。');
    if (n === 'NotReadableError') return t('相机被其它应用占用，请关闭后重试。');
    return t('打不开相机：{reason}', { reason: e?.message || n || t('未知错误') });
  }

  async function startCam() {
    phase = 'camera'; err = ''; hint = '';
    if (!secure) { phase = 'error'; err = t('当前页面不是安全上下文（https），浏览器不允许打开相机。可从相册选择二维码截图。'); return; }
    if (!navigator.mediaDevices?.getUserMedia) { phase = 'error'; err = t('此设备不支持网页相机。可从相册选择二维码截图。'); return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    } catch (e) { phase = 'error'; err = camErr(e); return; }
    if (!videoEl) { stopCam(); return; }
    videoEl.srcObject = stream;
    try { await videoEl.play(); } catch {}
    running = true;
    await ensureDecoder();
    if (phase === 'camera') tick();
  }

  async function ensureDecoder() {
    if (detector || jsqr) return;
    if ('BarcodeDetector' in window) {
      try {
        const fm = await window.BarcodeDetector.getSupportedFormats?.();
        if (!fm || fm.includes('qr_code')) detector = new window.BarcodeDetector({ formats: ['qr_code'] });
      } catch { detector = null; }
    }
    if (!detector) await loadJsqr();
  }
  async function loadJsqr() {
    if (jsqr) return;
    try { jsqr = (await import('jsqr')).default; }
    catch { phase = 'error'; err = t('解码模块加载失败，请检查网络后重试。'); }
  }

  function stopCam() {
    running = false;
    clearTimeout(timer); timer = 0;
    try { stream?.getTracks().forEach((trk) => trk.stop()); } catch {}
    stream = null;
    try { if (videoEl) videoEl.srcObject = null; } catch {}
  }

  // 从任意可绘源（video / img / bitmap）解一帧。返回文本或 ''。
  async function decodeFrom(src, w, h) {
    if (detector) {
      try {
        const codes = await detector.detect(src);
        return codes?.[0]?.rawValue || '';
      } catch {
        detector = null;               // WebView 无 GMS：原生检测器不可用，换 jsQR
        await loadJsqr();
        if (!jsqr) return '';
      }
    }
    if (!jsqr) return '';
    // 长边压到 ~520px：jsQR 纯 JS，帧越小越快；登录码本身只有 ~30×30 模块，够用。
    const scale = Math.min(1, 520 / Math.max(w, h, 1));
    const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
    canvas ||= document.createElement('canvas');
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, cw, ch);
    const img = ctx.getImageData(0, 0, cw, ch);
    const r = jsqr(img.data, cw, ch, { inversionAttempts: 'dontInvert' });
    return r?.data || '';
  }

  async function tick() {
    if (!running || phase !== 'camera') return;
    const v = videoEl;
    if (v && v.readyState >= 2 && v.videoWidth) {
      let text = '';
      try { text = await decodeFrom(v, v.videoWidth, v.videoHeight); } catch {}
      if (!running || phase !== 'camera') return;
      if (text) {
        const p = parsePairPayload(text);
        if (p) { onPayload(p); return; }
        if (Date.now() - lastBadAt > 2500) { lastBadAt = Date.now(); hint = t('这不是 Muse Bridge 的登录二维码'); haptic('error'); setTimeout(() => { if (hint) hint = ''; }, 1800); }
      }
    }
    timer = setTimeout(tick, detector ? 160 : 110);
  }

  // 相册选图：同一条解码链
  async function onFile(e) {
    const f = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!f) return;
    let bmp = null;
    try { bmp = await createImageBitmap(f); } catch { hint = t('读不出这张图片'); return; }
    await ensureDecoder();
    let text = '';
    try { text = await decodeFrom(bmp, bmp.width, bmp.height); } catch {}
    try { bmp.close?.(); } catch {}
    const p = parsePairPayload(text);
    if (p) onPayload(p);
    else { hint = text ? t('这不是 Muse Bridge 的登录二维码') : t('图片里没有识别到二维码'); haptic('error'); setTimeout(() => { hint = ''; }, 2200); }
  }

  async function onPayload(p) {
    stopCam();
    ticket = p; phase = 'checking'; err = ''; hint = '';
    try {
      info = await api.post('/api/pair/scan', { id: p.id, key: p.key });
      phase = 'confirm';
      haptic('tick');
    } catch (e) {
      phase = 'error';
      err = tr(e?.body?.error) || (e?.status === 401 ? t('请先在手机上登录，再扫码') : t('二维码无效或已过期，请在网页上刷新后重扫'));
    }
  }
  async function approve() {
    if (!ticket || phase !== 'confirm') return;
    phase = 'approving';
    try { await api.post('/api/pair/approve', ticket); phase = 'done'; haptic('done'); setTimeout(close, 1500); }
    catch (e) { phase = 'error'; err = tr(e?.body?.error) || t('确认失败，请重扫'); }
  }
  async function reject() {
    const tk = ticket; ticket = null;
    if (tk) { try { await api.post('/api/pair/reject', tk); } catch {} }
    close();
  }
  function rescan() { info = null; ticket = null; startCam(); }
  const fmtTime = (ts) => { try { return new Date(ts).toLocaleTimeString(isEn() ? locale() : [], { hour: isEn() ? 'numeric' : '2-digit', minute: '2-digit' }); } catch { return ''; } };
</script>

<div class="ps" transition:fade={{ duration: 180 }}>
  {#if phase === 'camera' || phase === 'checking'}
    <!-- svelte-ignore a11y_media_has_caption -->
    <video class="cam" bind:this={videoEl} playsinline muted autoplay></video>
    <div class="mask">
      <div class="frame">
        <i class="c tl"></i><i class="c tr"></i><i class="c bl"></i><i class="c br"></i>
        {#if phase === 'camera'}<div class="beam"></div>{/if}
      </div>
    </div>
    <div class="top">
      <button class="x" onclick={close} aria-label={t('关闭')}>
        <svg viewBox="0 0 20 20" width="20" height="20"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <span class="title">{t('扫一扫')}</span>
    </div>
    <div class="bot">
      <p class="hint" class:warn={!!hint}>{phase === 'checking' ? t('正在校验…') : (hint || t('对准网页登录页上的二维码'))}</p>
      <button class="alt" onclick={() => fileEl?.click()}>{t('从相册选择')}</button>
    </div>
  {:else}
    <button class="bd" onclick={phase === 'done' ? close : undefined} aria-hidden="true" tabindex="-1"></button>
    <div class="sheet" in:fly={{ y: 48, duration: 300 }}>
      {#if phase === 'confirm' || phase === 'approving'}
        <div class="glyph">
          <svg viewBox="0 0 48 48" width="44" height="44"><rect x="6" y="9" width="36" height="24" rx="4" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M18 40h12M24 33v7" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>
        </div>
        <h3>{t('登录网页版')}</h3>
        <p class="sub">{t('确认后，那台设备将以「{ident}」的身份登录 Muse Bridge。', { ident })}</p>
        <div class="rows">
          <div class="row"><span>{t('设备')}</span><b>{tr(info?.device) || t('未知设备')}</b></div>
          {#if info?.ip}<div class="row"><span>{t('来源')}</span><b>{info.ip}</b></div>{/if}
          {#if info?.created}<div class="row"><span>{t('时间')}</span><b>{fmtTime(info.created)}</b></div>{/if}
        </div>
        <p class="foot">{t('若这不是你正在操作的设备，请点「取消」。')}</p>
        <div class="acts">
          <button class="act primary" onclick={approve} disabled={phase === 'approving'}>{phase === 'approving' ? t('确认中…') : t('确认登录')}</button>
          <button class="act ghost" onclick={reject} disabled={phase === 'approving'}>{t('取消')}</button>
        </div>
      {:else if phase === 'done'}
        <div class="glyph ok">
          <svg viewBox="0 0 48 48" width="44" height="44"><circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M15 24l6 6 12-12" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </div>
        <h3>{t('已登录')}</h3>
        <p class="sub">{t('网页端已经登录成功，可以去电脑上继续了。')}</p>
        <div class="acts"><button class="act ghost" onclick={close}>{t('完成')}</button></div>
      {:else}
        <div class="glyph bad">
          <svg viewBox="0 0 48 48" width="44" height="44"><circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M24 14v13M24 33v1.5" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"/></svg>
        </div>
        <h3>{t('无法完成')}</h3>
        <p class="sub">{err}</p>
        <div class="acts">
          <button class="act primary" onclick={rescan}>{t('重新扫描')}</button>
          <button class="act ghost" onclick={() => fileEl?.click()}>{t('从相册选择')}</button>
          <button class="act link" onclick={close}>{t('关闭')}</button>
        </div>
      {/if}
    </div>
  {/if}
  <input class="file" type="file" accept="image/*" bind:this={fileEl} onchange={onFile} />
</div>

<style>
  .ps { position: fixed; inset: 0; z-index: 400; background: #0a0a0a; color: #fff; overflow: hidden; }
  .cam { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: #000; }
  /* 取景框外的四周压暗：用一个巨大的 box-shadow 挖出中间的正方形 */
  .mask { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; pointer-events: none; }
  .frame { position: relative; width: min(66vw, 300px); aspect-ratio: 1; border-radius: 22px; box-shadow: 0 0 0 200vmax rgba(0,0,0,.52); }
  .c { position: absolute; width: 26px; height: 26px; border: 3px solid #fff; }
  .c.tl { left: -2px; top: -2px; border-right: 0; border-bottom: 0; border-top-left-radius: 18px; }
  .c.tr { right: -2px; top: -2px; border-left: 0; border-bottom: 0; border-top-right-radius: 18px; }
  .c.bl { left: -2px; bottom: -2px; border-right: 0; border-top: 0; border-bottom-left-radius: 18px; }
  .c.br { right: -2px; bottom: -2px; border-left: 0; border-top: 0; border-bottom-right-radius: 18px; }
  .beam { position: absolute; left: 10px; right: 10px; top: 0; height: 2px; border-radius: 2px;
    background: linear-gradient(90deg, transparent, rgba(120,170,255,.95), transparent);
    box-shadow: 0 0 14px rgba(120,170,255,.8); animation: beam 2.2s ease-in-out infinite; }
  @keyframes beam { 0% { transform: translateY(6px); } 50% { transform: translateY(calc(min(66vw, 300px) - 8px)); } 100% { transform: translateY(6px); } }
  .top { position: absolute; top: 0; left: 0; right: 0; padding: calc(var(--sat, 0px) + 10px) 12px 0; display: flex; align-items: center; gap: 10px; }
  .x { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; color: #fff; background: rgba(0,0,0,.35); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); }
  .title { font-size: 17px; font-weight: 700; text-shadow: 0 1px 3px rgba(0,0,0,.5); }
  .bot { position: absolute; left: 0; right: 0; bottom: 0; padding: 0 24px calc(var(--sab, 0px) + 36px); display: flex; flex-direction: column; align-items: center; gap: 18px; }
  .hint { font-size: 15px; color: rgba(255,255,255,.85); text-align: center; text-shadow: 0 1px 3px rgba(0,0,0,.5); transition: color .2s; }
  .hint.warn { color: #ffb4a6; }
  .alt { height: 40px; padding: 0 20px; border-radius: 20px; color: #fff; font-size: 14px; font-weight: 600; background: rgba(255,255,255,.14); box-shadow: inset 0 0 0 .5px rgba(255,255,255,.3); }
  .file { position: absolute; width: 0; height: 0; opacity: 0; pointer-events: none; }

  .bd { position: absolute; inset: 0; background: rgba(0,0,0,.5); border: 0; padding: 0; }
  .sheet { position: absolute; left: 12px; right: 12px; bottom: calc(var(--sab, 0px) + 12px); max-width: 420px; margin: 0 auto;
    border-radius: 30px; padding: 28px 22px calc(22px); background: rgba(240,243,250,.97); color: #15171c;
    box-shadow: 0 30px 90px rgba(0,0,0,.5), inset 0 1px 1px rgba(255,255,255,.7); display: flex; flex-direction: column; gap: 10px; }
  .glyph { width: 68px; height: 68px; border-radius: 22px; display: flex; align-items: center; justify-content: center; color: #2f6fed; background: rgba(47,111,237,.12); margin-bottom: 4px; }
  .glyph.ok { color: #2f9e5b; background: rgba(47,158,91,.13); }
  .glyph.bad { color: #b13b2a; background: rgba(217,106,90,.14); }
  .sheet h3 { font-size: 23px; font-weight: 800; }
  .sub { font-size: 14.5px; color: #4b4f58; line-height: 1.45; }
  .rows { display: flex; flex-direction: column; border-radius: 14px; background: rgba(255,255,255,.7); box-shadow: inset 0 0 0 .5px rgba(0,0,0,.08); overflow: hidden; margin-top: 4px; }
  .row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 14px; font-size: 15px; }
  .row + .row { border-top: .5px solid rgba(0,0,0,.08); }
  .row span { color: #6b6f78; flex: none; }
  .row b { font-weight: 600; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .foot { font-size: 12.5px; color: #82858d; }
  .acts { display: flex; flex-direction: column; gap: 10px; margin-top: 8px; }
  .act { width: 100%; height: 50px; border-radius: 25px; font-size: 17px; font-weight: 700; display: flex; align-items: center; justify-content: center; transition: transform var(--mo-tap, .12s) var(--ea-out, ease-out); }
  .act:active { transform: scale(.97); }
  .act.primary { background: #2f6fed; color: #fff; box-shadow: 0 6px 16px rgba(47,111,237,.4); }
  .act.primary:disabled { opacity: .6; }
  .act.ghost { background: rgba(0,0,0,.05); color: #2f6fed; font-weight: 600; height: 46px; }
  .act.link { background: none; color: #5a5e68; font-weight: 500; height: 38px; font-size: 14px; }
</style>
