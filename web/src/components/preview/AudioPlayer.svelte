<script>
  // 查看器内的音频播放器：音乐 app 单曲页（媒体皮肤，恒暗，白是唯一强调色）。
  //   · 大封面：云端走服务端 media-cover（ID3 APIC / m4a covr / flac picture 抽出来的 jpg）；
  //     其它来源（手机本地 /__localfile、codex / claude 附件…）前端 Range 读文件头解析 ID3v2；都没有 → 默认封面（深色方块 + 波形）。
  //   · 标题 / 艺人 / 专辑（同上两条路，取不到就用文件名）。
  //   · 流式播放：<audio src> 直接走 Range，起播只拉开头一小段，不整段下载（本地缓存里已经有的 blob 才直接用）。
  //   · 波形进度轨（服务端 media-peaks；服务端不认识的来源手里有整段字节就前端解码出同款波形；都拿不到退回普通进度轨）、倍速、循环、±15s、上一首 / 下一首（同文件夹内的音频，
  //     播完自动接下一首）、媒体会话（锁屏 / 通知栏 / 耳机线控）、续播（≥30s 出「从 x:xx 继续」）、与视频同一套快捷键。
  //   · 切到后台不暂停（后台播放）；音量 / 静音 / 倍速与视频共用一份全局偏好。
  // 外框契约：标题栏、⋮ 菜单（下载等）由外框给；这里声明快捷键、文件信息；倍速菜单走 viewer.openMenu。
  import { onDestroy, untrack, tick } from 'svelte';
  import { getBlob } from '../../lib/mediaCache.js';
  import { mediaFallbackUrl } from '../../lib/server.js';
  import { pointer } from '../../lib/layout.svelte.js';
  import { t, tc } from '../../lib/i18n.js';
  import { cloudMediaUrl } from '../../lib/preview.svelte.js';
  import { nativeLocLocalOnly } from '../../lib/nativeDesktop.js';
  import {
    fmtTime, resumeStore, RESUME_MIN, RATES, clampRate, loadAvPrefs, saveAvPrefs, stepRate,
    id3Size, parseId3, fakePeaks, resamplePeaks, peaksFromChannels, wheelStep,
  } from '../../lib/avUtil.js';
  import { claimSession } from '../../lib/avSession.js';
  import { useViewer, isEditable } from './kit/context.js';
  import ViewerSlider from './kit/ViewerSlider.svelte';
  import VIcon from './kit/VIcon.svelte';
  import { tip } from './kit/tooltip.js';

  let { item, active = true } = $props();
  const viewer = useViewer();
  const touch = $derived(viewer.inShell ? viewer.touch : !pointer.fine);

  let audioEl = $state();
  let src = $state(''), revoke = () => {};
  let playing = $state(false), started = $state(false), ended = $state(false);
  let loading = $state(true), errored = $state(false), seeking = $state(false);
  let elDur = $state(0), metaDur = $state(0), cur = $state(0), buffered = $state(0);
  let scrubbing = $state(false), scrubT = $state(0);
  let dead = false, loaded = false, userPaused = false, pendingSeek = -1;
  let srcCached = false, fellBack = false, blobTried = false, blobAc = null;
  const dur = $derived(elDur || metaDur);
  const shownT = $derived(scrubbing ? scrubT : cur);

  // —— 全局偏好（与视频共用）——
  const LS = (() => { try { return window.localStorage; } catch { return null; } })();
  const prefs0 = loadAvPrefs(LS);
  let volume = $state(prefs0.volume), muted = $state(prefs0.muted), baseRate = $state(prefs0.rate);
  let loop = $state(false);
  const persist = () => saveAvPrefs(LS, { volume, muted, rate: baseRate });
  const resume = resumeStore(LS);
  const rkey = () => item.cacheKey || item.key;

  // —— 标签 / 封面 / 波形 ——
  const srv = () => item.saveTarget?.origin === 'cloud' && !!item.saveTarget?.rel && !nativeLocLocalOnly(item.saveTarget.nativeLocation);
  const api = (what, img = false) =>
    cloudMediaUrl(item.saveTarget.rel, what, { ws: item.saveTarget.ws || '', mt: item.mtime || 0, img });
  let tags = $state.raw({ title: '', artist: '', album: '' });
  let cover = $state(''), coverReady = $state(false);
  let coverRevoke = () => {};
  let peaks = $state.raw(null);
  const baseName = $derived(String(item.name || '').replace(/\.[^.]+$/, ''));
  const title = $derived(tags.title || baseName);
  const sub = $derived([tags.artist, tags.album].filter(Boolean).join(' · '));
  // 默认封面上的波形：装饰用，按文件名生成一条稳定的形状（28 根柱子按真波形取峰值几乎全是满格，看着像条码；
  // 真波形晚到时也不会让封面跳一下）。真波形只画在进度轨上
  const coverBars = $derived(fakePeaks(item.name, 28));

  async function loadMeta() {
    let ok = false;
    if (srv()) {
      try {
        const r = await fetch(api('media-meta'));
        if (r.ok) {
          const m = await r.json();
          if (dead) return;
          ok = true;
          tags = { title: m.title || '', artist: m.artist || '', album: m.album || '' };
          if (m.duration > 0) metaDur = m.duration;
          if (m.hasCover) cover = api('media-cover', true);
        }
      } catch {}
      loadPeaks();
    }
    if (!ok && !dead) await readId3();
  }
  // 读 [a,b] 字节：服务端认 Range 回 206；不认（200 整段）就边读边截，够了立刻断开
  async function readRange(u, a, b) {
    const r = await fetch(u, { headers: { Range: `bytes=${a}-${b}` } });
    if (!r.ok) throw new Error(String(r.status));
    const want = b - a + 1;
    if (r.status === 206 || !r.body) return new Uint8Array(await r.arrayBuffer()).subarray(0, want);
    const rd = r.body.getReader(), parts = [];
    let got = 0;
    while (got < want) { const { done, value } = await rd.read(); if (done) break; parts.push(value); got += value.length; }
    rd.cancel().catch(() => {});
    const out = new Uint8Array(Math.min(got, want));
    let o = 0;
    for (const p of parts) { if (o >= out.length) break; out.set(p.subarray(0, out.length - o), o); o += p.length; }
    return out;
  }
  async function readId3() {
    const u = item.url;
    if (!u || !/^(https?:|\/|data:|blob:)/.test(u)) return;   // 原生协议（bridge-workspace://）fetch 读不了
    try {
      const n = id3Size(await readRange(u, 0, 9));
      if (!n || n > 6 * 1024 * 1024) return;
      const b = await readRange(u, 0, n - 1);
      if (dead) return;
      const r = parseId3(b);
      if (!r) return;
      tags = { title: r.title || '', artist: r.artist || '', album: r.album || '' };
      if (r.cover?.data?.length) {
        const o = URL.createObjectURL(new Blob([r.cover.data], { type: r.cover.mime || 'image/jpeg' }));
        coverRevoke(); coverRevoke = () => { try { URL.revokeObjectURL(o); } catch {} };
        cover = o;
      }
    } catch {}
  }
  async function loadPeaks(tries = 0) {
    try {
      const r = await fetch(api('media-peaks'));
      if (r.status === 503 && tries < 3) { setTimeout(() => { if (!dead) loadPeaks(tries + 1); }, 3000); return; }
      if (!r.ok) return;
      const j = await r.json();
      if (!dead && Array.isArray(j.peaks) && j.peaks.length > 8) peaks = j.peaks;
    } catch {}
  }

  // 服务端不出波形的来源（vertex 生成 / 上传 / 手机本地…）：手里有整段字节（本地缓存 blob、blob: / data: URL、
  // 已知不大的本地文件）就前端解码成 PCM、按服务端同一算法出真波形（同云端 mp3 一个样子）；拿不到或太大就保持普通进度轨。
  // 解码在浏览器音频线程上跑，起播之后再做，不和首段取流抢
  const PEAKS_MAX = 12 * 1024 * 1024;
  let peaksTried = false, peaksT = null;
  function decodePcm(buf) {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!OAC) return null;
    for (const sr of [4000, 8000, 22050]) {   // 解到 4kHz 就够画波形（省内存）；不支持这么低采样率的内核往上退
      let ac;
      try { ac = new OAC(1, 1, sr); } catch { continue; }
      return new Promise((res, rej) => { const p = ac.decodeAudioData(buf, res, rej); if (p?.then) p.then(res, rej); });
    }
    return null;
  }
  async function clientPeaks(blob) {
    if (peaksTried || peaks || dead || srv()) return;
    peaksTried = true;
    try {
      let b = blob;
      if (!b) {
        const u = item.url || '';
        const local = item.saveTarget?.origin === 'local' && item.size > 0 && item.size <= PEAKS_MAX;
        if (!/^(blob:|data:)/.test(u) && !local) return;
        const r = await fetch(u);
        if (!r.ok) return;
        b = await r.blob();
      }
      if (!b || b.size > PEAKS_MAX || dead) return;
      const ab = await decodePcm(await b.arrayBuffer());
      if (!ab || dead || peaks) return;
      const chs = [];
      for (let c = 0; c < ab.numberOfChannels; c++) chs.push(ab.getChannelData(c));
      const p = peaksFromChannels(chs, ab.sampleRate, 400);
      if (p.length > 8) peaks = p;
    } catch {}
  }

  // 波形进度轨：按轨道宽度取 N 根（每根占 4px 一格），画成 SVG 当遮罩；底色 / 缓冲 / 已播三层都是 scaleX
  let railW = $state(0);
  const waveMask = $derived.by(() => {
    if (!peaks || !railW) return '';
    const n = Math.max(24, Math.min(220, Math.floor(railW / 4)));
    const p = resamplePeaks(peaks, n);
    const H = 32;
    let d = '';
    for (let i = 0; i < n; i++) {
      const h = Math.max(2.5, p[i] * H);
      d += `<rect x='${i * 4 + 0.75}' y='${((H - h) / 2).toFixed(1)}' width='2.5' height='${h.toFixed(1)}' rx='1.25'/>`;
    }
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 ${n * 4} ${H}' preserveAspectRatio='none'>${d}</svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  });
  const prog = $derived(dur ? Math.max(0, Math.min(1, shownT / dur)) : 0);
  const bufP = $derived(dur ? Math.max(0, Math.min(1, buffered / dur)) : 0);

  // —— 取源：本地缓存里已有的 blob 直接用；否则流式 URL（Range 边下边播）——
  async function load(at = 0) {
    loading = true; errored = false;
    pendingSeek = at > 0.1 ? at : -1;
    let blob = null;
    try { blob = item.cacheKey ? await getBlob(item.cacheKey) : null; } catch {}
    if (dead) return;
    if (blob) { const o = URL.createObjectURL(blob); revoke = () => { try { URL.revokeObjectURL(o); } catch {} }; srcCached = true; src = o; }
    else { srcCached = false; src = item.url; }
    if (!srv() && !peaksTried) { clearTimeout(peaksT); peaksT = setTimeout(() => { if (!dead) clientPeaks(blob); }, 400); }
  }
  // 出错回退：缓存 blob 坏 → 流式；LAN 死链 → 隧道；流式在这台设备上放不了 → 最后整段下成 blob 再试（≤60MB）
  async function onErr() {
    if (!src || dead) return;
    const at = cur > 0.5 ? cur : -1;
    if (srcCached) { srcCached = false; revoke(); revoke = () => {}; pendingSeek = at; src = item.url; return; }
    if (!fellBack) {
      fellBack = true;
      const f = mediaFallbackUrl(item.url);
      if (f && f !== item.url) { pendingSeek = at; src = f; return; }
    }
    if (!blobTried && /^(https?:|\/)/.test(item.url)) {
      blobTried = true;
      const ac = (blobAc = new AbortController());
      try {
        const r = await fetch(item.url, { signal: ac.signal });
        const n = +(r.headers.get('Content-Length') || 0);
        // 太大就别整段下：立刻掐断响应体（只 throw 不 abort 的话，body 还会在后台接着下完）
        if (!r.ok || n > 60 * 1024 * 1024) { ac.abort(); throw new Error('skip'); }
        const b = await r.blob();
        if (dead) return;
        revoke(); const o = URL.createObjectURL(b); revoke = () => { try { URL.revokeObjectURL(o); } catch {} };
        pendingSeek = at; src = o; return;
      } catch {} finally { if (blobAc === ac) blobAc = null; }
      if (dead) return;
    }
    errored = true; loading = false; playing = false;
  }
  function retry() {
    try { blobAc?.abort(); } catch {}
    fellBack = false; blobTried = false; errored = false;
    revoke(); revoke = () => {}; src = '';
    load(cur > 0.5 ? cur : 0);
  }

  let resumeChecked = false;
  function onMeta() {
    const d = audioEl?.duration;
    if (d === Infinity && !metaDur && !started) { try { audioEl.currentTime = 1e7; } catch {} }   // 流式无时长兜底：跳极大处逼出真时长
    else if (isFinite(d) && d > 0) elDur = d;
    if (pendingSeek >= 0) { try { audioEl.currentTime = pendingSeek; } catch {} cur = pendingSeek; pendingSeek = -1; }
    loading = false;
    applyRate();
    if (!resumeChecked) { resumeChecked = true; offerResume(); }
  }
  function onDur() {
    const d = audioEl?.duration;
    if (isFinite(d) && d > 0) { elDur = d; if (audioEl.currentTime > d) { try { audioEl.currentTime = 0; } catch {} } }
  }
  let lastPos = 0, lastSave = 0;
  function onTime() {
    if (!scrubbing) cur = audioEl?.currentTime || 0;
    onProgress();
    const now = performance.now();
    if (now - lastPos > 1000) { lastPos = now; sess?.position(dur, cur, audioEl?.playbackRate || 1); }
    if (playing && now - lastSave > 5000) { lastSave = now; saveResume(); }
  }
  function onProgress() {
    try {
      const b = audioEl.buffered, x = audioEl.currentTime || 0;
      for (let i = 0; i < b.length; i++) if (x >= b.start(i) - 0.3 && x <= b.end(i) + 0.3) { buffered = b.end(i); return; }
      buffered = 0;
    } catch {}
  }
  function onPlaying() { loading = false; playing = true; started = true; ended = false; applyRate(); sess?.playing(true); }
  function onPause() { playing = false; sess?.playing(false); saveResume(); }
  function onEnded() {
    if (loop) { seekTo(0); audioEl?.play().catch(() => {}); return; }
    playing = false; ended = true; sess?.playing(false);
    resume.clear(rkey());
    // 同文件夹连播：有下一首音频就直接接上
    if (active && nextIdx >= 0) viewer.go(nextIdx);
  }

  function play() { const a = audioEl; if (!a) return; if (errored) { retry(); return; } if (ended) { ended = false; seekTo(0); } userPaused = false; a.play().catch(() => {}); }
  function pause() { const a = audioEl; if (!a) return; userPaused = true; a.pause(); }
  function togglePlay() { const a = audioEl; if (!a) return; if (a.paused || ended || errored) play(); else pause(); }
  function seekTo(sec) {
    const a = audioEl; if (!a) return;
    sec = Math.max(0, Math.min(dur || 0, sec));
    if (ended && sec < (dur || 0) - 0.5) ended = false;
    try { a.currentTime = sec; } catch {}
    cur = sec;
  }
  const seekBy = (d) => seekTo((audioEl?.currentTime || cur) + d);

  function scrubStart(v) { scrubbing = true; scrubT = v; }
  function scrubInput(v) { scrubT = v; }
  function scrubEnd(v) { scrubbing = false; seekTo(v); }
  // 指针拖完滑块 / 鼠标点完按钮，把焦点交回查看器根（之后 ←/→ 是 ±5s、空格是播放 / 暂停）：不 blur 到 BODY——
  // 那样出了外框的 Tab 圈。键盘 Tab 上去的不受影响（onend 只在指针松手时回调；按钮只在 e.detail>0 即指针点击时交回）
  function focusRoot(from) {
    const r = viewer.root?.();
    if (r && r !== from) { try { r.focus({ preventScroll: true }); } catch {} }
    if (from && document.activeElement === from) from.blur();
  }
  function blurSlider() { if (touch) return; const a = document.activeElement; if (a?.getAttribute?.('role') === 'slider') focusRoot(a); }
  function dropFocus(e) { if (e.detail) focusRoot(e.currentTarget); }
  // 聚焦在进度轨 / 音量条上时的方向键：与全局同一套（←/→ ±5s、Shift 加倍；↑/↓ 音量 ±5%），滑块自己按 1/20 时长走太碎
  function railKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key;
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && dur) {
      e.preventDefault(); e.stopPropagation();
      seekBy((k === 'ArrowRight' ? 5 : -5) * (e.shiftKey ? 2 : 1));
    } else if (k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault(); e.stopPropagation();
      setVolume((muted ? 0 : volume) + (k === 'ArrowUp' ? 0.05 : -0.05));
      showOsd(volIcon, Math.round((muted ? 0 : volume) * 100) + '%');
    }
  }
  // 聚焦在音量条上：四个方向键都是音量 ±5%（滑块自带一格 1% 太碎；也别让进度的键位抢走）
  function volKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.target?.getAttribute?.('role') !== 'slider') return;
    const k = e.key, up = k === 'ArrowUp' || k === 'ArrowRight', dn = k === 'ArrowDown' || k === 'ArrowLeft';
    if (!up && !dn) return;
    e.preventDefault(); e.stopPropagation();
    setVolume((muted ? 0 : volume) + (up ? 0.05 : -0.05));
  }
  // 滚轮：进度轨每格 ±5s，音量条每格 ±5%（与视频同一套）
  function wheelSeek(n) { if (dur) seekBy(5 * n); }
  function wheelVol(n) { setVolume((muted ? 0 : volume) + 0.05 * n); }

  // —— 倍速 / 音量 ——
  function applyRate() { const a = audioEl; if (!a) return; try { a.defaultPlaybackRate = baseRate; a.playbackRate = baseRate; } catch {} }
  function setRate(r) { baseRate = clampRate(r); applyRate(); persist(); }
  const rateLabel = (r) => (r === 1 ? tc('files', '正常') : r + '×');
  $effect(() => { const a = audioEl, v = volume, m = muted; if (!a) return; try { a.volume = v; a.muted = m; } catch {} });
  function onVolume() { if (!audioEl) return; volume = Math.round(audioEl.volume * 100) / 100; muted = audioEl.muted; }
  function setVolume(x) { volume = Math.max(0, Math.min(1, Math.round(x * 100) / 100)); if (volume > 0 && muted) muted = false; persist(); }
  function toggleMute() { muted = !muted; if (!muted && volume === 0) volume = 0.5; persist(); }
  const volIcon = $derived(muted || volume === 0 ? 'mute' : volume < 0.5 ? 'volumeLow' : 'volumeHigh');

  let rateEl = $state(), rateOpen = $state(false);
  function openRate() {
    if (rateOpen) { viewer.closeMenu(); return; }
    rateOpen = true;
    viewer.openMenu({
      anchor: rateEl, place: 'top', title: t('播放速度'),
      items: () => RATES.map((r) => ({ label: rateLabel(r), checked: r === baseRate, onSelect: () => setRate(r) })),
      onclose: () => { rateOpen = false; },
    });
  }

  // —— 上一首 / 下一首（同文件夹里的音频，跳过夹在中间的图片 / 文档；最多看 200 项）——
  function findAudio(dir) {
    const n = viewer.count;
    for (let i = viewer.index + dir, k = 0; i >= 0 && i < n && k < 200; i += dir, k++) if (viewer.itemAt(i)?.kind === 'audio') return i;
    return -1;
  }
  const nextIdx = $derived(findAudio(1));
  const prevIdx = $derived(findAudio(-1));
  // 音乐 app 惯例：放过 3 秒按「上一首」先回到本曲开头
  function prevTrack() { if ((audioEl?.currentTime || 0) > 3 || prevIdx < 0) { seekTo(0); return; } viewer.go(prevIdx); }
  function nextTrack() { if (nextIdx >= 0) viewer.go(nextIdx); }

  // —— 续播 ——
  let resumeUi = $state(null), resumeT = null;
  function offerResume() {
    const r = resume.get(rkey());
    const d = dur || audioEl?.duration || 0;
    if (!r || !(r.t >= RESUME_MIN) || (d > 0 && r.t >= d - 10)) return;
    resumeUi = { t: r.t };
    clearTimeout(resumeT); resumeT = setTimeout(() => (resumeUi = null), 8000);
  }
  function doResume() { const x = resumeUi?.t; resumeUi = null; clearTimeout(resumeT); if (x > 0) { seekTo(x); play(); } }
  function saveResume() { if (!started || ended) return; const x = audioEl?.currentTime || cur; if (x >= RESUME_MIN) resume.set(rkey(), x, dur); }

  // —— 状态气泡（键盘反馈）——
  let osd = $state(null), osdT = null, osdSeq = 0;
  function showOsd(icon, text) { osd = { icon, text, id: ++osdSeq }; clearTimeout(osdT); osdT = setTimeout(() => (osd = null), 800); }

  // —— 键盘（与视频同一套；J/L 跟按钮一样 ±15s）——
  function onKeys(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return false;
    if (isEditable(e.target)) return false;
    const k = e.key;
    if ((k === ' ' || k === 'Enter') && e.target?.closest?.('button, a, [role="menuitem"]')) return false;
    if (!audioEl) return false;
    switch (k) {
      case ' ': case 'k': case 'K': togglePlay(); return true;
      case 'j': case 'J': seekBy(-15); return true;
      case 'l': case 'L': seekBy(15); return true;
      case 'ArrowLeft': seekBy(-5); return true;
      case 'ArrowRight': seekBy(5); return true;
      case 'ArrowUp': case 'ArrowDown':
        setVolume((muted ? 0 : volume) + (k === 'ArrowUp' ? 0.05 : -0.05));
        showOsd(volIcon, Math.round((muted ? 0 : volume) * 100) + '%');
        return true;
      case 'm': case 'M': toggleMute(); showOsd(volIcon, muted ? t('静音') : Math.round(volume * 100) + '%'); return true;
      case 'Home': seekTo(0); return true;
      case 'End': seekTo(dur); return true;
      case 'PageUp': viewer.prev(); return true;
      case 'PageDown': viewer.next(); return true;
      case 'N': if (e.shiftKey) { nextTrack(); return true; } return false;
      case 'P': if (e.shiftKey) { prevTrack(); return true; } return false;
      case '<': case '>': setRate(stepRate(baseRate, k === '>' ? 1 : -1)); showOsd('speed', baseRate + '×'); return true;
      case ',': case '.': if (e.shiftKey) { setRate(stepRate(baseRate, k === '.' ? 1 : -1)); showOsd('speed', baseRate + '×'); return true; } return false;
    }
    if (!e.shiftKey && k >= '0' && k <= '9' && k.length === 1 && dur) { seekTo(dur * (+k / 10)); return true; }
    return false;
  }

  $effect(() => {
    if (!active) return;
    return viewer.declare({
      keys: onKeys,
      arrowKbd: ['PgUp', 'PgDn'],
      info: () => [
        dur ? { label: t('时长'), value: fmtTime(dur) } : null,
        tags.artist ? { label: t('艺人'), value: tags.artist } : null,
        tags.album ? { label: t('专辑'), value: tags.album } : null,
      ].filter(Boolean),
    }, { key: item.key });
  });

  // 换项（Shift+N / PgUp / 播完接下一首）时旧页连同聚焦着的按钮一起销毁，焦点掉到 BODY 就出了外框的 Tab 圈：交回查看器根
  $effect(() => {
    if (!active || touch) return;
    void item.key;
    tick().then(() => {
      if (dead || viewer.closing) return;
      const a = document.activeElement;
      if (a && a !== document.body && a.isConnected) return;
      try { viewer.root?.()?.focus({ preventScroll: true }); } catch {}
    });
  });

  // —— 媒体会话（锁屏 / 通知栏 / 耳机）——
  let sess = null;
  $effect(() => {
    if (!active) return;
    const hasPrev = prevIdx >= 0, hasNext = nextIdx >= 0;
    const s = untrack(() => claimSession({ title, artist: tags.artist, album: tags.album, artwork: cover }, {
      play: () => play(), pause: () => pause(),
      seekbackward: (d) => seekBy(-(d?.seekOffset || 15)),
      seekforward: (d) => seekBy(d?.seekOffset || 15),
      seekto: (d) => { if (d && Number.isFinite(d.seekTime)) seekTo(d.seekTime); },
      previoustrack: hasPrev ? () => prevTrack() : () => seekTo(0),
      nexttrack: hasNext ? () => nextTrack() : null,
    }));
    sess = s;
    untrack(() => s.playing(playing));
    return () => { s.release(); if (sess === s) sess = null; };
  });
  // 标签 / 封面晚到时补进媒体会话
  $effect(() => { const info = { title, artist: tags.artist, album: tags.album, artwork: cover }; untrack(() => sess?.update(info)); });

  // 只在当前页时加载；离开当前页暂停（切后台 / 锁屏不暂停）
  $effect(() => { if (active && audioEl && !loaded) untrack(() => { loaded = true; load(); loadMeta(); }); });
  $effect(() => { if (!active) untrack(() => { try { if (audioEl && !audioEl.paused) audioEl.pause(); } catch {} }); });
  // 打开即播（被自动播放策略拦了就停在暂停态，点播放即可）
  $effect(() => {
    const s = src, a = audioEl;
    if (!s || !a || !active) return;
    untrack(() => { if (userPaused || ended || errored) return; a.play().catch(() => {}); });
  });
  $effect(() => {
    const onVis = () => { if (document.visibilityState === 'hidden') saveResume(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', saveResume);
    return () => { document.removeEventListener('visibilitychange', onVis); window.removeEventListener('pagehide', saveResume); };
  });

  onDestroy(() => {
    saveResume();
    dead = true;
    try { blobAc?.abort(); } catch {}
    clearTimeout(resumeT); clearTimeout(osdT); clearTimeout(peaksT);
    try { audioEl?.pause(); } catch {}
    revoke(); coverRevoke();
  });

  const showSpin = $derived((loading || seeking) && !errored && !!src);
  let remain = $state(false);
  const ic = $derived(touch ? 26 : 22);
</script>

<div class="ap-stage" class:fine={!touch}>
  <!-- 环境底色：封面放大压暗（普通 filter，不是 backdrop-filter） -->
  {#if cover && coverReady}<img class="ap-amb" src={cover} alt="" aria-hidden="true" />{/if}

  <audio bind:this={audioEl} src={src || undefined} preload="metadata" data-noheal
    onloadedmetadata={onMeta} ondurationchange={onDur} ontimeupdate={onTime} onprogress={onProgress}
    onwaiting={() => (loading = true)} onplaying={onPlaying} onplay={() => { ended = false; }} onpause={onPause} onended={onEnded} onerror={onErr}
    onseeking={() => (seeking = true)} onseeked={() => { seeking = false; onProgress(); }} onvolumechange={onVolume}></audio>

  <div class="ap-body">
    <div class="ap-cover">
      {#if cover}
        <img src={cover} alt="" onload={() => (coverReady = true)} onerror={() => { cover = ''; coverReady = false; }} />
      {/if}
      {#if !cover || !coverReady}
        <div class="ap-defcover" aria-hidden="true">
          <div class="ap-defwave">{#each coverBars as v, i (i)}<i style:transform="scaleY({v})"></i>{/each}</div>
        </div>
      {/if}
    </div>

    <div class="ap-side">
      <div class="ap-meta">
        <h2 class="ap-title sel-text" title={title}>{title}</h2>
        {#if sub}<p class="ap-sub sel-text">{sub}</p>{/if}
      </div>

      <div class="ap-railbox" class:wave={!!waveMask} bind:clientWidth={railW} role="presentation" onkeydowncapture={railKey} use:wheelStep={wheelSeek}>
        {#if waveMask}
          <div class="ap-wave" style:-webkit-mask-image={waveMask} style:mask-image={waveMask} aria-hidden="true">
            <i class="ap-wave-buf" style:transform="scaleX({bufP})"></i>
            <i class="ap-wave-fill" style:transform="scaleX({prog})"></i>
          </div>
        {/if}
        <ViewerSlider class="ap-rail" value={shownT} max={dur || 0} buffered={waveMask ? 0 : buffered} label={t('进度')}
          format={fmtTime} hoverFormat={touch ? null : fmtTime} valueText={(v) => fmtTime(v) + ' / ' + fmtTime(dur)}
          onstart={scrubStart} oninput={scrubInput} onchange={scrubEnd} onend={blurSlider} disabled={!dur} />
      </div>
      <div class="ap-times">
        <span>{fmtTime(shownT)}</span>
        <button type="button" class="ap-tbtn" onclick={() => (remain = !remain)} aria-label={remain ? t('显示总时长') : t('显示剩余时间')}>
          {remain && dur ? '−' + fmtTime(Math.max(0, dur - shownT)) : fmtTime(dur)}
        </button>
      </div>

      <div class="ap-ctl">
        <button type="button" class="vw-btn ap-c" onclick={prevTrack} disabled={!started && prevIdx < 0}
          use:tip={{ label: t('上一首'), kbd: 'Shift+P' }} aria-label={t('上一首')}><VIcon name="prevTrack" size={ic} /></button>
        <button type="button" class="vw-btn ap-c" onclick={() => seekBy(-15)} disabled={!dur}
          use:tip={{ label: t('快退 15 秒'), kbd: 'J' }} aria-label={t('快退 15 秒')}><VIcon name="skipBack15" size={ic} /></button>
        <button type="button" class="ap-play" onclick={(e) => { dropFocus(e); togglePlay(); }}
          aria-label={errored ? t('重试') : playing ? t('暂停') : t('播放')} use:tip={{ label: errored ? t('重试') : playing ? t('暂停') : t('播放'), kbd: 'K' }}>
          {#if showSpin && !playing}
            <span class="vw-spin ap-spin"></span>
          {:else if errored}
            <VIcon name="retry" size={26} />
          {:else}
            <VIcon name={playing ? 'pause' : 'play'} size={28} />
          {/if}
        </button>
        <button type="button" class="vw-btn ap-c" onclick={() => seekBy(15)} disabled={!dur}
          use:tip={{ label: t('快进 15 秒'), kbd: 'L' }} aria-label={t('快进 15 秒')}><VIcon name="skipFwd15" size={ic} /></button>
        <button type="button" class="vw-btn ap-c" onclick={nextTrack} disabled={nextIdx < 0}
          use:tip={{ label: t('下一首'), kbd: 'Shift+N' }} aria-label={t('下一首')}><VIcon name="nextTrack" size={ic} /></button>
      </div>

      <div class="ap-sub2">
        <button type="button" class="vw-btn vw-txt ap-rate" class:open={rateOpen} bind:this={rateEl} onclick={openRate}
          use:tip={{ label: t('播放速度'), kbd: '< >' }} aria-haspopup="menu" aria-expanded={rateOpen}>{baseRate + '×'}</button>
        <button type="button" class="vw-btn ap-tog" class:on={loop} onclick={() => (loop = !loop)} aria-pressed={loop}
          use:tip={t('循环播放')} aria-label={t('循环播放')}><VIcon name="loop" /><i></i></button>
        {#if !touch}
          <span class="ap-vol" role="presentation" onkeydowncapture={volKey} use:wheelStep={wheelVol}>
            <button type="button" class="vw-btn" onclick={(e) => { dropFocus(e); toggleMute(); }}
              use:tip={{ label: muted ? t('取消静音') : t('静音'), kbd: 'M' }}><VIcon name={volIcon} /></button>
            <ViewerSlider class="ap-vol-sl" value={muted ? 0 : volume} max={1} step={0.01} label={t('音量')}
              valueText={(v) => Math.round(v * 100) + '%'} oninput={setVolume} onend={blurSlider} />
          </span>
        {/if}
      </div>

      <div class="ap-note" aria-live="polite">
        {#if errored}
          <span class="ap-err">{t('音频加载失败')}</span>
        {:else if resumeUi}
          <button type="button" class="vw-pill ap-pillbtn" onclick={doResume}><VIcon name="play" size={16} />{t('从 {t} 继续', { t: fmtTime(resumeUi.t) })}</button>
        {/if}
      </div>
    </div>
  </div>

  {#if osd}
    {#key osd.id}
      <div class="ap-osd"><span class="vw-pill"><VIcon name={osd.icon} size={18} /><b>{osd.text}</b></span></div>
    {/key}
  {/if}
</div>

<style>
  .ap-stage { position: absolute; inset: 0; overflow: hidden; background: #0a0a0c; container-type: size;
    padding: calc(var(--vw-bar-h, 56px) + 8px) max(20px, env(safe-area-inset-right, 0px)) max(20px, var(--sab, 0px)) max(20px, env(safe-area-inset-left, 0px));
    display: flex; align-items: center; justify-content: center; }
  .ap-amb { position: absolute; inset: -10%; width: 120%; height: 120%; object-fit: cover; filter: blur(60px) saturate(1.1) brightness(.55); opacity: .5; pointer-events: none;
    animation: apFade var(--mo-hero) var(--ea-fade); }
  .ap-stage::after { content: ''; position: absolute; inset: 0; pointer-events: none; background: linear-gradient(180deg, rgba(10, 10, 12, .2), rgba(10, 10, 12, .75)); }
  @keyframes apFade { from { opacity: 0; } }

  /* 竖排（手机 / 窄窗）：封面在上、信息与控件在下；宽矮的窗口改左右排 */
  .ap-body { position: relative; z-index: 1; width: 100%; max-width: 440px; display: flex; flex-direction: column; align-items: stretch; gap: clamp(16px, 4cqh, 32px); }
  .ap-cover { position: relative; align-self: center; width: min(100%, 360px, 44cqh); aspect-ratio: 1; border-radius: 14px; overflow: hidden;
    background: #18181b; box-shadow: 0 18px 48px rgba(0, 0, 0, .5), 0 0 0 .5px rgba(255, 255, 255, .08); }
  .ap-cover img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; animation: apFade var(--mo-base) var(--ea-fade); }
  .ap-defcover { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    background: linear-gradient(155deg, #26262a 0%, #151517 70%); }
  .ap-defwave { display: flex; align-items: center; gap: 1.5%; height: 34%; width: 62%; }   /* 百分比 gap 按容器宽算：28 根、27 道缝 */
  .ap-defwave i { flex: 1; height: 100%; border-radius: 99px; background: rgba(255, 255, 255, .5); transform-origin: center; }

  .ap-side { display: flex; flex-direction: column; min-width: 0; }
  .ap-meta { display: flex; flex-direction: column; gap: 4px; min-width: 0; margin-bottom: 14px; }
  .ap-title { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 650; letter-spacing: -.005em; color: #fff;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ap-sub { margin: 0; font-size: 14px; line-height: 1.4; color: var(--vw-fg-2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .ap-railbox { position: relative; height: 44px; }
  .ap-railbox :global(.ap-rail) { position: absolute; inset: 0; height: 100%; }
  .ap-railbox.wave :global(.ap-rail .vw-track-rail) { opacity: 0; }
  .ap-railbox.wave :global(.ap-rail .vw-track-knob) { width: 3px; height: 30px; left: -1.5px; top: -15px; border-radius: 2px; box-shadow: none; transform: none; }
  .ap-wave { position: absolute; left: 0; right: 0; top: 6px; bottom: 6px; background: rgba(255, 255, 255, .22); pointer-events: none;
    -webkit-mask-size: 100% 100%; mask-size: 100% 100%; -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat; }
  .ap-wave i { position: absolute; inset: 0; transform-origin: left center; }
  .ap-wave-buf { background: rgba(255, 255, 255, .16); }
  .ap-wave-fill { background: #fff; }
  .ap-times { display: flex; justify-content: space-between; align-items: center; margin-top: -4px; font-size: 12.5px; font-variant-numeric: tabular-nums; color: var(--vw-fg-2); }
  .ap-tbtn { border: 0; background: none; color: inherit; font: inherit; padding: 4px 0 4px 12px; cursor: pointer; font-variant-numeric: tabular-nums; }
  /* 触屏：命中区撑到 44×44（短音频时长只有「0:03」四个字，宽度也要托底），负外边距抵掉、不改排版 */
  .ap-stage:not(.fine) .ap-tbtn { min-height: 44px; min-width: 44px; box-sizing: border-box; margin: -10px 0; padding: 0 0 0 16px; text-align: right; }

  .ap-ctl { display: flex; align-items: center; justify-content: space-between; margin: 14px auto 0; width: 100%; max-width: 340px; }
  .ap-c { width: 48px; height: 48px; border-radius: 50%; }
  .fine .ap-c { width: 40px; height: 40px; }
  .ap-play { width: 68px; height: 68px; border: 0; padding: 0; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center; cursor: pointer;
    background: var(--vw-pri-bg, #fff); color: var(--vw-pri-fg, #111113); transition: transform var(--mo-tap) var(--ea-out), opacity var(--mo-tap) var(--ea-out); }
  .ap-play:active { transform: scale(.94); }
  @media (hover: hover) { .ap-play:hover { opacity: .92; } }
  .ap-play:focus-visible { outline: 2px solid var(--vw-fg-3); outline-offset: 3px; }
  .ap-spin { --s: 24px; --vw-spin-fg: #111113; --vw-spin-bg: rgba(0, 0, 0, .14); }

  .ap-sub2 { display: flex; align-items: center; justify-content: center; gap: 12px; margin-top: 14px; color: var(--vw-fg-2); }
  .ap-rate { min-width: 52px; font-variant-numeric: tabular-nums; }
  .ap-tog { position: relative; }
  .ap-tog.on { color: #fff; }
  .ap-tog i { position: absolute; left: 50%; bottom: 3px; width: 14px; height: 2px; margin-left: -7px; border-radius: 1px; background: #fff; transform: scaleX(0); transition: transform var(--mo-micro) var(--ea-std); }
  .ap-tog.on i { transform: scaleX(1); }
  :global(.vw-touch) .ap-tog i { bottom: 5px; }
  .ap-vol { display: inline-flex; align-items: center; gap: 4px; }
  .ap-vol :global(.ap-vol-sl) { width: 88px; }

  .ap-note { min-height: 40px; margin-top: 10px; display: flex; align-items: center; justify-content: center; }
  .ap-err { font-size: 13px; color: var(--vw-fg-2); }
  .ap-pillbtn { border: 0; font: inherit; font-size: 13px; min-height: 36px; cursor: pointer; animation: apPillIn var(--mo-quick) var(--ea-decel); }
  .ap-pillbtn:active { opacity: .8; }
  .ap-stage:not(.fine) .ap-pillbtn { min-height: 44px; padding-left: 16px; padding-right: 16px; }
  @keyframes apPillIn { from { opacity: 0; scale: .92; } }

  .ap-osd { position: absolute; z-index: 2; top: calc(var(--vw-bar-h, 56px) + 10px); left: 50%; transform: translateX(-50%); pointer-events: none; animation: apPillIn var(--mo-quick) var(--ea-decel); }
  .ap-osd b { font-weight: 600; font-size: 14px; font-variant-numeric: tabular-nums; }

  /* 宽而矮（电脑窗口 / 手机横屏）：封面左、信息右 */
  @container (min-aspect-ratio: 5/4) and (min-width: 640px) {
    .ap-body { flex-direction: row; align-items: center; max-width: 900px; gap: clamp(28px, 5cqw, 64px); }
    .ap-cover { width: min(42cqw, 70cqh, 400px); flex: none; }
    .ap-side { flex: 1; }
    .ap-ctl { margin-left: 0; }
    .ap-sub2 { justify-content: flex-start; }
    .ap-note { justify-content: flex-start; }
  }
  @container (max-height: 420px) and (min-aspect-ratio: 5/4) {
    .ap-body { flex-direction: row; align-items: center; max-width: 820px; gap: 24px; }
    .ap-cover { width: min(40cqw, 62cqh); flex: none; }
    .ap-side { flex: 1; }
    .ap-meta { margin-bottom: 4px; }
    .ap-ctl { margin-top: 4px; }
    .ap-sub2, .ap-note { margin-top: 4px; }
    .ap-note { min-height: 0; }
  }
</style>
